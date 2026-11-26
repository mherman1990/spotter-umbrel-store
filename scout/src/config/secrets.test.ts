import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { SecretsError } from '../core/errors.js';
import { tempDir } from '../test-support/temp-db.js';
import { SECRET_KEYS, createSecrets, loadSecrets, parseEnvFile } from './secrets.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function writeSecrets(text: string, mode = 0o600): string {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const file = path.join(t.dir, 'scout.env');
  fs.writeFileSync(file, text, { mode });
  fs.chmodSync(file, mode);
  return file;
}

describe('closed key allowlist', () => {
  it('contains exactly the documented keys', () => {
    expect([...SECRET_KEYS].sort()).toEqual(
      [
        'ANTHROPIC_API_KEY',
        'FINRA_CLIENT_ID',
        'FINRA_CLIENT_SECRET',
        'FRED_API_KEY',
        'IMAP_HOST',
        'IMAP_PASS',
        'IMAP_USER',
        'NTFY_TOKEN',
        'NTFY_TOPIC',
        'NTFY_URL',
        'OPENCLAW_HOOK_TOKEN',
        'OPENCLAW_HOOK_URL',
        'SCHWAB_CLIENT_ID',
        'SCHWAB_CLIENT_SECRET',
        'SCHWAB_REDIRECT_URI',
        'SCOUT_API_TOKEN_PEPPER',
        'SCOUT_SEC_CONTACT',
      ].sort(),
    );
  });
});

describe('parseEnvFile', () => {
  it('handles comments, export, quotes, inline comments and blank values', () => {
    const m = parseEnvFile(
      '# c\nexport A=1\nB="two words"\nC=\'x\'\nD=val # inline\n\nE=\n=bad\nnoequals\n',
    );
    expect(Object.fromEntries(m)).toEqual({ A: '1', B: 'two words', C: 'x', D: 'val', E: '' });
  });
});

describe('loadSecrets', () => {
  it('reads allowlisted keys from a 0600 file and ignores (but names) unknown keys', () => {
    const file = writeSecrets(
      'SCOUT_SEC_CONTACT=me@example.invalid\nANTHROPIC_API_KEY=sk-ant-xyz\nNOT_ALLOWED=oops\nSCHWAB_CLIENT_SECERT=typo\n',
    );
    const s = loadSecrets({ path: file, env: {} });
    expect(s.get('SCOUT_SEC_CONTACT')).toBe('me@example.invalid');
    expect(s.isSet('ANTHROPIC_API_KEY')).toBe(true);
    expect(s.isSet('FRED_API_KEY')).toBe(false);
    const r = s.report();
    expect(r.ignored.sort()).toEqual(['NOT_ALLOWED', 'SCHWAB_CLIENT_SECERT']);
    expect(r.file.state).toBe('loaded');
    expect(r.set).toEqual(['SCOUT_SEC_CONTACT', 'ANTHROPIC_API_KEY']);
  });

  it('a non-empty environment value wins over the file; an empty one does not', () => {
    const file = writeSecrets('FRED_API_KEY=fromfile\nNTFY_TOPIC=filetopic\n');
    const s = loadSecrets({ path: file, env: { FRED_API_KEY: 'fromenv', NTFY_TOPIC: '' } });
    expect(s.get('FRED_API_KEY')).toBe('fromenv');
    expect(s.get('NTFY_TOPIC')).toBe('filetopic');
  });

  it('works with the environment alone and ignores non-allowlisted env vars', () => {
    const s = loadSecrets({
      env: { SCOUT_SEC_CONTACT: 'a@b.invalid', PATH: '/usr/bin', RANDOM_VAR: 'x' },
    });
    expect(s.report().file).toEqual({ path: null, state: 'none' });
    expect(s.get('SCOUT_SEC_CONTACT')).toBe('a@b.invalid');
    expect(s.report().set).toEqual(['SCOUT_SEC_CONTACT']);
  });

  it('a missing file is fine (state absent); require() names the KEY on failure, never a value', () => {
    const s = loadSecrets({ path: '/nonexistent/dir/scout.env', env: {} });
    expect(s.report().file.state).toBe('absent');
    try {
      s.require('SCOUT_SEC_CONTACT');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SecretsError);
      expect((e as SecretsError).key).toBe('SCOUT_SEC_CONTACT');
      expect((e as Error).message).toContain('SCOUT_SEC_CONTACT');
    }
  });

  it('refuses a group/other-accessible secrets file (strict by default) with a chmod hint', () => {
    const file = writeSecrets('FRED_API_KEY=abc\n', 0o644);
    expect(() => loadSecrets({ path: file, env: {} })).toThrow(/chmod 600/);
    expect(loadSecrets({ path: file, env: {}, strictPermissions: false }).get('FRED_API_KEY')).toBe(
      'abc',
    );
  });

  it('the permission error never contains secret values', () => {
    const file = writeSecrets('FRED_API_KEY=SUPERSECRETVALUE\n', 0o644);
    try {
      loadSecrets({ path: file, env: {} });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('SUPERSECRETVALUE');
    }
  });

  it('wraps unreadable-file errors without leaking content', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    // A directory where a file is expected -> EISDIR (not ENOENT) -> SecretsError.
    expect(() => loadSecrets({ path: t.dir, env: {}, strictPermissions: false })).toThrow(
      SecretsError,
    );
  });
});

describe('Secrets never leak through serialization or inspection', () => {
  const s = createSecrets({ ANTHROPIC_API_KEY: 'sk-ant-VERYSECRET', FRED_API_KEY: 'FREDSECRET' });

  it('JSON.stringify, util.inspect and template strings expose no values', () => {
    const dumped = [
      JSON.stringify(s),
      inspect(s, { depth: 5 }),
      `${JSON.stringify(s.report())}`,
    ].join('|');
    expect(dumped).not.toContain('VERYSECRET');
    expect(dumped).not.toContain('FREDSECRET');
    expect(inspect(s)).toContain('2/17 set');
  });

  it('report() is value-free and complete over the allowlist', () => {
    const r = s.report();
    expect(Object.keys(r.keys).sort()).toEqual([...SECRET_KEYS].sort());
    expect(r.keys.ANTHROPIC_API_KEY).toBe(true);
    expect(r.keys.NTFY_TOKEN).toBe(false);
    expect(typeof r.keys.ANTHROPIC_API_KEY).toBe('boolean');
  });

  it('createSecrets rejects keys outside the allowlist', () => {
    expect(() => createSecrets({ NOT_A_KEY: 'x' } as never)).toThrow(SecretsError);
  });
});
