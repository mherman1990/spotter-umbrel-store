/**
 * Egress / secrets / isolation policy (decisions D7, D8, D20, D32). These tests scan `src/` and fail CI when a
 * module reaches around the audited layers. The allowlists below ARE the ownership contract for audited
 * modules (docs/ARCHITECTURE.md): adding a file here is a security-relevant change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SECRET_KEYS } from '../../src/config/secrets.js';
import { stripComments } from './ts-strip.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Production source: src/**\/*.ts minus tests and test-support. */
function prodFiles(): string[] {
  const out: string[] = [];
  const visit = (rel: string): void => {
    for (const ent of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const r = `${rel}/${ent.name}`;
      if (ent.isDirectory()) visit(r);
      else if (r.endsWith('.ts') && !r.endsWith('.test.ts') && !r.startsWith('src/test-support/'))
        out.push(r);
    }
  };
  visit('src');
  return out;
}

/**
 * Strip comments (with the TypeScript parser, not a regex) so doc text mentioning a pattern is not an offense
 * and a `//` inside a string cannot hide the rest of a line from the scan.
 */
function code(file: string): string {
  return stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'), file);
}

/** Files that may use dynamic `import()` / `require()` (the optional IMAP libraries are imported lazily). */
const DYNAMIC_LOAD_OK = [
  'src/adapters/inbox/',
  'src/cli/',
  'src/cli.ts',
  'src/index.ts',
  'src/app.ts',
];

function offenders(pattern: RegExp, allowed: readonly string[]): string[] {
  const ok = new Set(allowed);
  return prodFiles().filter((f) => !ok.has(f) && pattern.test(code(f)));
}

describe('egress policy', () => {
  it('fetch is referenced only by the two audited HTTP files', () => {
    expect(
      offenders(/\bfetch\s*\(|globalThis\.fetch|\bfetch\s*=/, [
        'src/core/http.ts',
        'src/core/egress-post.ts',
      ]),
    ).toEqual([]);
  });

  it('POST helpers are called only by audited modules (OAuth token endpoints, OpenClaw hook, ntfy)', () => {
    const audited = [
      'src/core/egress-post.ts',
      'src/adapters/quotes/schwab-oauth.ts', // Schwab token exchange/refresh (the ONLY allowlisted Schwab POST)
      'src/adapters/shorts/finra-auth.ts', // FINRA client-credentials token
      'src/notify/openclaw.ts', // OpenClaw mapped hook
      'src/notify/agent-hook.ts', // earnings-day /hooks/agent
      'src/notify/ntfy.ts', // ntfy fallback
    ];
    expect(offenders(/\.(postJson|postForm|postText|postRaw)\s*[<(]/, audited)).toEqual([]);
  });

  it('the ws package is imported only by core/ws.ts', () => {
    expect(offenders(/from\s+['"]ws['"]/, ['src/core/ws.ts'])).toEqual([]);
  });

  it('the Anthropic SDK is imported only under src/llm/', () => {
    const bad = prodFiles().filter(
      (f) => !f.startsWith('src/llm/') && /@anthropic-ai\/sdk/.test(code(f)),
    );
    expect(bad).toEqual([]);
  });

  it('IMAP libraries are imported only by the inbox adapter', () => {
    const bad = prodFiles().filter(
      (f) => !f.startsWith('src/adapters/inbox/') && /['"](imapflow|mailparser)['"]/.test(code(f)),
    );
    expect(bad).toEqual([]);
  });

  it('raw sockets, other HTTP clients and process spawners are not imported, with or without the node: prefix', () => {
    // `child_process` would let a module shell out to curl and bypass every egress policy.
    const forbidden =
      /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](?:node:)?(?:net|tls|dgram|dns|dns\/promises|https|http2|child_process|worker_threads|vm|cluster|inspector|repl)['"]/;
    expect(offenders(forbidden, [])).toEqual([]);
    const httpUsers = prodFiles().filter((f) =>
      /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](?:node:)?http['"]/.test(code(f)),
    );
    expect(httpUsers.every((f) => f.startsWith('src/api/'))).toBe(true);
  });

  it('dynamic import() and require() are confined to the lazy-IMAP adapter and the entry points', () => {
    const bad = prodFiles().filter(
      (f) =>
        !DYNAMIC_LOAD_OK.some((ok) => f.startsWith(ok)) &&
        /(?<![.\w])(?:import\s*\(|require\s*\(\s*['"`])/.test(code(f)),
    );
    expect(bad).toEqual([]);
  });

  it('the comment stripper is parser-based: a // inside a string does not hide the rest of the line', () => {
    const src =
      "const u = 'http://x'; fetch(u); // trailing\n/* block */ const y = `//not a comment`;";
    const out = stripComments(src);
    expect(out).toContain('fetch(u)');
    expect(out).toContain('`//not a comment`');
    expect(out).not.toContain('trailing');
    expect(out).not.toContain('block');
    expect(out.length).toBe(src.length);
  });
});

describe('adapter purity (decision D10)', () => {
  it('src/adapters/** never names a write API of the event/watermark/outbox stores', () => {
    const writeApi =
      /\bcommitPoll\b|\.watermarks\s*\.\s*(?:set|delete)\b|\.events\s*\.\s*(?:insertIgnore|insertManyIgnore|setStatus|markTriaged|markDigested|setRulePriority|recordFailure)\b|\.outbox\s*\.\s*enqueue\b|\.eventLinks\s*\.\s*link\b/;
    const bad = prodFiles().filter((f) => f.startsWith('src/adapters/') && writeApi.test(code(f)));
    expect(bad).toEqual([]);
  });
});

describe('secrets and environment policy', () => {
  it('process.env is read only by secrets.ts and the two entry points (dot, bracket and destructuring forms)', () => {
    const envRead =
      /\bprocess\s*(?:\.|\?\.|\[)\s*['"]?env\b|\{[^}]*\benv\b[^}]*\}\s*=\s*process\b|(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?process['"]/;
    expect(offenders(envRead, ['src/config/secrets.ts', 'src/index.ts', 'src/cli.ts'])).toEqual([]);
  });

  it('the env-read patterns catch every spelling', () => {
    const envRead =
      /\bprocess\s*(?:\.|\?\.|\[)\s*['"]?env\b|\{[^}]*\benv\b[^}]*\}\s*=\s*process\b|(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?process['"]/;
    for (const s of [
      'process.env.X',
      "process['env'].X",
      'process["env"]',
      'process?.env',
      'const { env } = process;',
      "import process from 'node:process';",
      "const p = require('process');",
    ]) {
      expect(envRead.test(s), s).toBe(true);
    }
    expect(envRead.test('processor.environment')).toBe(false);
  });

  it('each secret key is read only by the files that own it (the RSS adapter cannot read ANTHROPIC_API_KEY)', () => {
    const ROOT_FILES = [
      'src/config/secrets.ts',
      'src/app.ts',
      'src/index.ts',
      'src/cli.ts',
      'src/cli/',
    ];
    const OWNERS: Record<string, string[]> = {
      SCOUT_SEC_CONTACT: ['src/adapters/'],
      SCHWAB_CLIENT_ID: ['src/adapters/quotes/'],
      SCHWAB_CLIENT_SECRET: ['src/adapters/quotes/'],
      SCHWAB_REDIRECT_URI: ['src/adapters/quotes/'],
      ANTHROPIC_API_KEY: ['src/llm/'],
      OPENCLAW_HOOK_TOKEN: ['src/notify/', 'src/config/load.ts'],
      OPENCLAW_HOOK_URL: ['src/notify/', 'src/config/load.ts'],
      NTFY_URL: ['src/notify/', 'src/config/load.ts'],
      NTFY_TOPIC: ['src/notify/', 'src/config/load.ts'],
      NTFY_TOKEN: ['src/notify/', 'src/config/load.ts'],
      FRED_API_KEY: ['src/adapters/macro/'],
      FINRA_CLIENT_ID: ['src/adapters/shorts/'],
      FINRA_CLIENT_SECRET: ['src/adapters/shorts/'],
      IMAP_HOST: ['src/adapters/inbox/'],
      IMAP_USER: ['src/adapters/inbox/'],
      IMAP_PASS: ['src/adapters/inbox/'],
      SCOUT_API_TOKEN_PEPPER: ['src/api/'],
    };
    expect(Object.keys(OWNERS).sort()).toEqual([...SECRET_KEYS].sort()); // a new key needs an owner here
    const bad: string[] = [];
    for (const f of prodFiles()) {
      const text = code(f);
      for (const key of SECRET_KEYS) {
        if (!new RegExp(`['"]${key}['"]`).test(text)) continue;
        const ok = [...ROOT_FILES, ...(OWNERS[key] ?? [])].some((o) => f.startsWith(o));
        if (!ok) bad.push(`${f} reads ${key}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('isolation policy', () => {
  it('production code never imports test-support (no production-reachable fakes)', () => {
    const bad = prodFiles().filter((f) => /test-support/.test(code(f)));
    expect(bad).toEqual([]);
  });

  it('no module-level logger/db/config singletons (openDb/loadCoverage are called only from entry points)', () => {
    const entry = ['src/index.ts', 'src/cli.ts', 'src/app.ts'];
    const bad = prodFiles().filter((f) => {
      if (
        entry.includes(f) ||
        f.startsWith('src/cli/') ||
        f.startsWith('src/store/') ||
        f.startsWith('src/config/')
      )
        return false;
      return /^(const|let|var)\s+\w+\s*=\s*(openDb|openStore|loadCoverage|createLogger)\s*\(/m.test(
        code(f),
      );
    });
    expect(bad).toEqual([]);
  });
});
