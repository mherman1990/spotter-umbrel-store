#!/usr/bin/env node
/**
 * Read-only guard (decision D6, spec section 11: "grep the repo for order-placement endpoints: zero matches").
 *
 * Scans every tracked-or-untracked-but-not-ignored text file under scout/ for order-placement endpoint paths
 * and method names. The patterns are assembled from fragments at runtime so THIS file does not contain (and
 * therefore does not match) any of them; the matching vitest policy test (test/policy/no-orders.test.ts)
 * builds them the same way. Documents must describe the guard rather than quote the patterns.
 *
 * Usage:  node scripts/guard-no-orders.mjs        (exit 1 and list violations on any match)
 * Import: `findViolations(rootDir)` for tests.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const j = (...parts) => parts.join('');

/** Fragments of order-placement identifiers; each is a case-sensitive substring that must never appear. */
export const FORBIDDEN = [
  j('/', 'ord', 'ers'),
  j('pla', 'ce', 'Or', 'der'),
  j('pre', 'view', 'Or', 'der'),
  j('rep', 'lace', 'Or', 'der'),
  j('can', 'cel', 'Or', 'der'),
  j('Or', 'der', 'Re', 'quest'),
  j('or', 'der', 'Str', 'ategy'),
  j('Or', 'der', 'Le', 'g', 'Col', 'lection'),
  j('Or', 'der', 'Str', 'ategy', 'Type'),
];

/** Files that legitimately contain the patterns (the guard and its test, which build them dynamically anyway). */
const SKIP_FILES = new Set(['package-lock.json']);
/** Directories skipped wherever they appear (generated or vendored; never hand-written source). */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git']);

/**
 * Runtime-data directories skipped ONLY at their real locations: the top-level `data/` and Umbrel's
 * `umbrel-store/<app>/data/`. A generic "any directory named data" skip would let a future `src/**\/data/` folder
 * (a very natural name for fixtures or tables) escape the scan.
 * @param {string} rel path relative to the scanned root (any separator)
 */
export function isSkippedPath(rel) {
  const segs = rel.split(/[\\/]+/).filter(Boolean);
  if (segs.some((s) => SKIP_DIRS.has(s))) return true;
  if (segs[0] === 'data') return true;
  if (segs[0] === 'umbrel-store' && segs[2] === 'data') return true;
  return false;
}
const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.pdf',
  '.gz',
  '.zip',
  '.woff',
  '.woff2',
  '.node',
  '.db',
  '.sqlite',
]);
const MAX_BYTES = 2 * 1024 * 1024;

function gitFiles(root) {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const files = out.split('\0').filter(Boolean);
    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

function walk(root, rel = '') {
  const out = [];
  for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = path.join(rel, ent.name);
    if (ent.isDirectory()) {
      if (isSkippedPath(r)) continue;
      out.push(...walk(root, r));
    } else out.push(r);
  }
  return out;
}

/**
 * @param {string} root directory to scan
 * @returns {{ file: string, line: number, pattern: string }[]}
 */
export function findViolations(root) {
  const files = (gitFiles(root) ?? walk(root)).filter((f) => {
    const base = path.basename(f);
    if (SKIP_FILES.has(base)) return false;
    if (isSkippedPath(f)) return false;
    return !BINARY_EXT.has(path.extname(f).toLowerCase());
  });
  const hits = [];
  for (const rel of files) {
    const abs = path.join(root, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue; // deleted but still listed
    }
    if (!stat.isFile() || stat.size > MAX_BYTES) continue;
    const text = fs.readFileSync(abs, 'utf8');
    if (text.includes('\u0000')) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const pattern of FORBIDDEN) {
        if (lines[i].includes(pattern)) hits.push({ file: rel, line: i + 1, pattern });
      }
    }
  }
  return hits;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const hits = findViolations(root);
  if (hits.length > 0) {
    console.error('guard:orders FAILED - order-placement identifiers found (Scout is read-only):');
    for (const h of hits) console.error(`  ${h.file}:${h.line}  matches "${h.pattern}"`);
    process.exit(1);
  }
  console.log('guard:orders OK - no order-placement identifiers found.');
}
