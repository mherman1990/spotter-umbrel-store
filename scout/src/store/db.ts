/**
 * SQLite handle factory (better-sqlite3). No import-time singleton: callers `openDb(path)` and pass the handle
 * around (decision D32). Pragmas follow Spotter's `src/db/connection.ts` (MIT-compatible same-owner code):
 * WAL, synchronous FULL, foreign keys ON, busy timeout 5 s, ~16 MB page cache, temp in memory. FULL (not
 * NORMAL): under WAL, NORMAL can roll back the last committed transactions on power loss, and a Pi on NVMe
 * loses power more often than a server; Scout writes a few hundred rows a day, so the fsync cost is irrelevant
 * and "committed" can honestly mean durable (decision D10). Online backup follows Spotter's backup service pattern (better-sqlite3 `.backup()`).
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { StoreError } from '../core/errors.js';

export type Db = Database.Database;

export interface OpenDbOptions {
  /** Open read-only (the file must exist). Used by backup verification and `scout doctor`. */
  readonly?: boolean;
}

/**
 * Open (creating parent directories) a SQLite database tuned for a Pi 5 on NVMe. Pass `:memory:` for tests.
 * Does NOT run migrations; call `migrate(db)` (src/store/migrate.ts).
 */
export function openDb(file: string, options: OpenDbOptions = {}): Db {
  if (file !== ':memory:' && options.readonly !== true) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new Database(
    file,
    options.readonly === true ? { readonly: true, fileMustExist: true } : {},
  );
  if (options.readonly !== true) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -16000');
  db.pragma('temp_store = MEMORY');
  return db;
}

/**
 * Run `fn` inside a deferred transaction so every read in it sees ONE consistent snapshot even while another
 * connection writes (WAL). Use for API requests that read several tables (pattern: Gleaner `get()`).
 * Do not write inside it.
 */
export function readTransaction<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).deferred();
}

/** Run `fn` in a write transaction that takes the write lock up front (`BEGIN IMMEDIATE`): no upgrade deadlocks. */
export function writeTransaction<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate();
}

export interface IntegrityResult {
  ok: boolean;
  /** `ok`, or the problems SQLite reported. */
  messages: string[];
}

/** `PRAGMA integrity_check` (quick=false) or `quick_check`. */
export function integrityCheck(db: Db, quick = false): IntegrityResult {
  const rows = db.pragma(quick ? 'quick_check' : 'integrity_check') as {
    integrity_check?: string;
    quick_check?: string;
  }[];
  const messages = rows.map((r) => r.integrity_check ?? r.quick_check ?? '');
  return { ok: messages.length === 1 && messages[0] === 'ok', messages };
}

/** Checkpoint the WAL (call before shutdown and before copying the file). */
export function checkpointWal(
  db: Db,
  mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' = 'TRUNCATE',
): void {
  db.pragma(`wal_checkpoint(${mode})`);
}

/** Checkpoint and close. Safe to call once. */
export function closeDb(db: Db): void {
  if (!db.open) return;
  try {
    checkpointWal(db);
  } finally {
    db.close();
  }
}

export interface BackupResult {
  path: string;
  bytes: number;
  durationMs: number;
}

/**
 * Online backup via SQLite's backup API (consistent even while writers are active). Writes to
 * `<dest>.partial`, verifies it with `quick_check`, then atomically renames. Secrets are never in this
 * database's plaintext (the Schwab token blob is encrypted with a key file that is NOT backed up).
 */
export async function backupDb(db: Db, dest: string): Promise<BackupResult> {
  const started = Date.now();
  fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
  const partial = `${dest}.partial`;
  fs.rmSync(partial, { force: true });
  try {
    await db.backup(partial);
    const copy = openDb(partial, { readonly: true });
    try {
      const check = integrityCheck(copy, true);
      if (!check.ok)
        throw new StoreError(`Backup verification failed: ${check.messages.join('; ')}`);
    } finally {
      copy.close();
    }
    fs.renameSync(partial, dest);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  }
  return { path: dest, bytes: fs.statSync(dest).size, durationMs: Date.now() - started };
}

/**
 * Keep only the newest `keep` backup files in `dir` whose names start with `prefix` and end with `.db`
 * (names sort chronologically, e.g. `scout-2026-12-03T0300.db`). Returns the deleted paths.
 */
export function pruneBackups(dir: string, keep: number, prefix = 'scout-'): string[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.db'))
    .sort();
  const doomed = files.slice(0, Math.max(0, files.length - keep));
  for (const f of doomed) fs.rmSync(path.join(dir, f), { force: true });
  return doomed.map((f) => path.join(dir, f));
}
