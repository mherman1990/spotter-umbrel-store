/**
 * Read-only policy test (decision D6; spec section 11 "grep the repo for order-placement endpoints: zero
 * matches"). Pattern: BlackGold test/policy/live-disabled.test.ts, but with the OPPOSITE allowlist - Schwab
 * hosts ARE allowed here; order-placement identifiers are not. The identifiers are built from fragments by the
 * guard script, so neither this file nor the script matches itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FORBIDDEN, findViolations, isSkippedPath } from '../../scripts/guard-no-orders.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('read-only guarantee: no order-placement code or endpoints', () => {
  it('finds zero order-placement identifiers in the scout tree', () => {
    expect(findViolations(ROOT)).toEqual([]);
  });

  it('the guard actually detects every forbidden fragment (self-test on a temp tree)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-guard-'));
    try {
      FORBIDDEN.forEach((pattern, i) => {
        fs.writeFileSync(path.join(dir, `f${i}.ts`), `const x = 'prefix ${pattern} suffix';\n`);
      });
      fs.writeFileSync(path.join(dir, 'clean.ts'), 'export const ok = 1;\n');
      const hits = findViolations(dir);
      // Some fragments are substrings of others (one identifier contains another), so assert per file.
      FORBIDDEN.forEach((pattern, i) => {
        expect(
          hits.some((h) => h.file === `f${i}.ts` && h.pattern === pattern),
          `missed ${pattern}`,
        ).toBe(true);
      });
      expect(hits.every((h) => h.file !== 'clean.ts')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips runtime-data dirs only at their real locations: a src/**/data folder is still scanned', () => {
    expect(isSkippedPath('data/scout.db')).toBe(true);
    expect(isSkippedPath('umbrel-store/herman-scout/data/.gitkeep')).toBe(true);
    expect(isSkippedPath('node_modules/x/index.js')).toBe(true);
    expect(isSkippedPath('src/fixtures/data/tables.ts')).toBe(false);
    expect(isSkippedPath('test/fixtures/data/x.json')).toBe(false);
    expect(isSkippedPath('src/adapters/data.ts')).toBe(false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-guard-data-'));
    try {
      const pattern = FORBIDDEN[0] ?? '';
      fs.mkdirSync(path.join(dir, 'src', 'data'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'data', 'sneaky.ts'),
        `export const x = '${pattern}';\n`,
      );
      fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'data', 'runtime.txt'), `${pattern}\n`);
      const hits = findViolations(dir);
      expect(hits.map((h) => h.file.split(path.sep).join('/'))).toEqual(['src/data/sneaky.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the guard script and this test do not contain the patterns verbatim', () => {
    for (const file of ['scripts/guard-no-orders.mjs', 'test/policy/no-orders.test.ts']) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const p of FORBIDDEN) expect(text.includes(p), `${file} contains ${p}`).toBe(false);
    }
  });

  it('only the audited modules may issue non-GET requests (POST client file + FetchInit typing)', () => {
    const allowed = new Set(['src/core/http.ts', 'src/core/egress-post.ts']);
    const offenders: string[] = [];
    for (const file of walkSrc()) {
      if (allowed.has(file)) continue;
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      // HTTP method literals in a `method` position (option-contract 'PUT'/'CALL' literals are not HTTP).
      if (/\bmethod\b[^\n]{0,24}['"`](POST|PUT|PATCH|DELETE)['"`]/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

function walkSrc(): string[] {
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
