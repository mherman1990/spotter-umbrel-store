import { describe, expect, it } from 'vitest';
import { MigrationError } from '../core/errors.js';
import { tempDbFile } from '../test-support/temp-db.js';
import { openDb } from './db.js';
import { migrate, migrationChecksum, type Migration } from './migrate.js';
import { MIGRATIONS } from './migrations/index.js';
import { m0001 } from './migrations/0001_initial.js';

/** Every table wave-1 modules rely on (spec section 9 plus the extras in the task brief). */
const EXPECTED_TABLES = [
  'alert_state',
  'api_tokens',
  'daily_counters',
  'event_links',
  'events',
  'fact_sheets',
  'filings',
  'form4_rows',
  'guidance_history',
  'health_state',
  'holdings_13f',
  'intraday_bars',
  'intraday_profile',
  'jobs_runs',
  'kv_state',
  'llm_calls',
  'macro_observations',
  'newsletter_state',
  'options_snapshots',
  'plan_snapshots',
  'positions_snapshots',
  'push_events',
  'pushes',
  'quotes_daily',
  'reg_sho_daily',
  'schedule13_filings',
  'schema_migrations',
  'scorecards',
  'short_interest',
  'token_state',
  'watermarks',
];

describe('migrations', () => {
  it('upgrade tripwire: the shipped list and the checksum of 0001 are pinned (NEVER edit a shipped migration)', () => {
    expect(MIGRATIONS.map((m) => m.id)).toEqual(['0001_initial']);
    expect(migrationChecksum(m0001)).toBe(
      'af74325a4b470e05373365c87b7d424c4254a4039bb57d57fe23eb0289bf58b2',
    );
  });

  it('creates every table, in a fresh DB, with foreign keys enforced', () => {
    const db = openDb(':memory:');
    const r = migrate(db, undefined, () => new Date('2026-12-03T00:00:00Z'));
    expect(r.applied).toEqual(['0001_initial']);
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((t) => t.name);
    expect(tables).toEqual(EXPECTED_TABLES);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    const rec = db.prepare('SELECT id, checksum, applied_at FROM schema_migrations').get() as {
      id: string;
      checksum: string;
      applied_at: string;
    };
    expect(rec).toMatchObject({ id: '0001_initial', applied_at: '2026-12-03T00:00:00.000Z' });
    db.close();
  });

  it('is idempotent', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(migrate(db)).toEqual({ applied: [], current: ['0001_initial'] });
    db.close();
  });

  it('enforces the events CHECK constraints (source, status, priority)', () => {
    const db = openDb(':memory:');
    migrate(db);
    const ins = db.prepare(
      "INSERT INTO events (id, ticker, source, kind, ts_iso, ts_epoch_ms, payload_json, status, created_at, updated_at) VALUES (?, 'BBW', ?, 'k', 't', 0, '{}', ?, 'c', 'u')",
    );
    expect(() => ins.run('1', 'filing', 'new')).not.toThrow();
    expect(() => ins.run('2', 'bogus', 'new')).toThrow(/CHECK/);
    expect(() => ins.run('3', 'filing', 'bogus')).toThrow(/CHECK/);
    db.close();
  });

  it('detects an EDITED shipped migration (checksum mismatch)', () => {
    const db = openDb(':memory:');
    migrate(db);
    const edited: Migration = { ...m0001, sql: `${m0001.sql}\n-- sneaky edit` };
    expect(() => migrate(db, [edited])).toThrow(MigrationError);
    expect(() => migrate(db, [edited])).toThrow(/edited/);
    db.close();
  });

  it('refuses a database that is NEWER than the code', () => {
    const db = openDb(':memory:');
    migrate(db, [m0001, { id: '0002_future', description: 'x', sql: 'CREATE TABLE future (a)' }]);
    expect(() => migrate(db, [m0001])).toThrow(/newer than the code/);
    db.close();
  });

  it('applies new migrations incrementally and rolls back a failing one completely', () => {
    const db = openDb(':memory:');
    migrate(db);
    const m2: Migration = {
      id: '0002_extra',
      description: 'x',
      sql: 'CREATE TABLE extra (a INTEGER)',
    };
    expect(migrate(db, [m0001, m2]).applied).toEqual(['0002_extra']);
    const bad: Migration = {
      id: '0003_bad',
      description: 'x',
      sql: 'CREATE TABLE half_done (a INTEGER); INSERT INTO nonexistent VALUES (1);',
    };
    expect(() => migrate(db, [m0001, m2, bad])).toThrow(/0003_bad failed/);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").all() as unknown[]
    ).length;
    expect(names).toBe(0);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = '0003_bad'").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    db.close();
  });

  it('validates id format and ordering', () => {
    const db = openDb(':memory:');
    expect(() => migrate(db, [{ id: 'bad id', description: '', sql: '' }])).toThrow(
      /Bad migration id/,
    );
    expect(() =>
      migrate(db, [
        { id: '0002_b', description: '', sql: 'SELECT 1' },
        { id: '0001_a', description: '', sql: 'SELECT 1' },
      ]),
    ).toThrow(/strictly ordered/);
    db.close();
  });

  it('is race-safe: a second process that sees the migration already applied under the lock skips it', () => {
    const t = tempDbFile();
    try {
      // The "other process" already applied 0002 between our check and our lock: simulate with two handles.
      const a = openDb(t.file);
      const b = openDb(t.file);
      const m2: Migration = {
        id: '0002_race',
        description: '',
        sql: 'CREATE TABLE race (a INTEGER)',
      };
      expect(migrate(a, [m0001, m2]).applied).toEqual(['0002_race']);
      // b had not seen it; its re-check under BEGIN IMMEDIATE finds it recorded and must not re-run the CREATE.
      expect(migrate(b, [m0001, m2]).applied).toEqual([]);
      a.close();
      b.close();
    } finally {
      t.close();
    }
  });
});
