/**
 * Static, ordered, forward-only migrations. Never edit or reorder a shipped migration: its SQL checksum is
 * recorded and a mismatch aborts startup (tripwire; see migrate.test.ts which also pins 0001's checksum).
 * To change the schema, ADD the next numbered migration.
 *
 * Race safety (Gleaner pattern): each migration takes the write lock first (`BEGIN IMMEDIATE`) and re-checks
 * the applied record under it, so the service and a `docker exec ... cli` starting together on a new release
 * cannot both apply the same migration. Migrations are static imports, not discovered files, so the compiled
 * bundle has no filesystem coupling (Spotter pattern).
 */
import { MigrationError } from '../core/errors.js';
import { sha256Hex } from '../core/ids.js';
import type { Db } from './db.js';
import { MIGRATIONS } from './migrations/index.js';

export interface Migration {
  /** Unique, sortable id: `NNNN_snake_case`. */
  id: string;
  description: string;
  /** Plain SQL (multiple statements allowed), executed in one transaction. */
  sql: string;
  /**
   * Run with `PRAGMA foreign_keys = OFF` (set OUTSIDE the transaction, where SQLite honors it) and verify with
   * `PRAGMA foreign_key_check` before committing. Required by SQLite's table-rebuild recipe (create new, copy,
   * drop old, rename): with foreign keys ON the DROP would cascade into child rows. Foreign keys are switched
   * back ON afterwards whatever happens.
   */
  foreignKeysOff?: boolean;
}

export interface MigrationResult {
  /** Ids applied by this call, in order. */
  applied: string[];
  /** All ids now recorded as applied. */
  current: string[];
}

/**
 * Migrations not yet applied to `db` (in order). Call BEFORE `migrate` to decide whether to take a backup.
 * Does not create or modify anything.
 */
export function pendingMigrations(
  db: Db,
  migrations: readonly Migration[] = MIGRATIONS,
): Migration[] {
  const hasTable =
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get() !== undefined;
  if (!hasTable) return [...migrations];
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map((r) => r.id),
  );
  return migrations.filter((m) => !applied.has(m.id));
}

/** SHA-256 of a migration's SQL (what the tripwire compares). */
export function migrationChecksum(m: Migration): string {
  return sha256Hex(m.sql);
}

/**
 * Apply every migration this database has not recorded.
 *
 * @throws MigrationError when (a) a recorded migration's checksum differs from the shipped SQL (it was
 *   edited), (b) the database records a migration this build does not know (database newer than the code),
 *   or (c) a migration's SQL fails (the transaction rolls back; nothing is half-applied).
 */
export function migrate(
  db: Db,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => Date = () => new Date(),
): MigrationResult {
  assertOrderedUnique(migrations);
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const known = new Map(migrations.map((m) => [m.id, m]));
  const recorded = db.prepare('SELECT id, checksum FROM schema_migrations ORDER BY id').all() as {
    id: string;
    checksum: string;
  }[];
  for (const r of recorded) {
    const m = known.get(r.id);
    if (m === undefined) {
      throw new MigrationError(
        `Database has migration ${r.id} that this build does not know: the database is newer than the code`,
      );
    }
    if (r.checksum !== migrationChecksum(m)) {
      throw new MigrationError(
        `Shipped migration ${r.id} was edited (checksum mismatch); add a new migration instead`,
      );
    }
  }

  const isRecorded = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?');
  const record = db.prepare(
    'INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)',
  );
  const applied: string[] = [];
  for (const m of migrations) {
    if (isRecorded.get(m.id) !== undefined) continue;
    if (m.foreignKeysOff === true) db.pragma('foreign_keys = OFF'); // a no-op inside a transaction: set it first
    let ran: boolean;
    try {
      ran = db
        .transaction((): boolean => {
          if (isRecorded.get(m.id) !== undefined) return false; // another process got there first
          try {
            db.exec(m.sql);
          } catch (cause) {
            throw new MigrationError(`Migration ${m.id} failed: ${(cause as Error).message}`, {
              cause,
            });
          }
          if (m.foreignKeysOff === true) {
            const violations = db.pragma('foreign_key_check') as unknown[];
            if (violations.length > 0) {
              throw new MigrationError(
                `Migration ${m.id} left ${violations.length} foreign key violation(s); rolled back`,
              );
            }
          }
          record.run(m.id, migrationChecksum(m), now().toISOString());
          return true;
        })
        .immediate();
    } finally {
      if (m.foreignKeysOff === true) db.pragma('foreign_keys = ON');
    }
    if (ran) applied.push(m.id);
  }
  const current = (
    db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as { id: string }[]
  ).map((r) => r.id);
  return { applied, current };
}

function assertOrderedUnique(migrations: readonly Migration[]): void {
  for (let i = 0; i < migrations.length; i++) {
    const m = migrations[i];
    if (m === undefined) continue;
    if (!/^\d{4}_[a-z0-9_]+$/.test(m.id)) throw new MigrationError(`Bad migration id: ${m.id}`);
    const prev = migrations[i - 1];
    if (prev !== undefined && prev.id >= m.id) {
      throw new MigrationError(`Migrations must be strictly ordered: ${prev.id} before ${m.id}`);
    }
  }
}
