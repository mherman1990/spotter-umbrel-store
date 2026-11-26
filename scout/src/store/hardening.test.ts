/**
 * Regression tests for the foundation review (silent event loss, first-run flood, retry storms, token rotation,
 * durability, partial bars...). Each test names the failure it pins.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StoreError, ValidationError } from '../core/errors.js';
import { makeEvent, makeQuoteTick, resetFactories } from '../test-support/factories.js';
import { tempDb, tempDbFile, type TempStore } from '../test-support/temp-db.js';
import { openDb } from './db.js';
import { migrate, pendingMigrations, type Migration } from './migrate.js';
import { MIGRATIONS } from './migrations/index.js';
import { openStore } from './index.js';
import { retryDueAt } from './repos/events.js';
import { normalizeInstant } from './repos/common.js';

let t: TempStore;
const T0 = new Date('2026-12-03T14:00:00.000Z');
const at = (min: number): Date => new Date(T0.getTime() + min * 60_000);

beforeEach(() => {
  resetFactories();
  t = tempDb();
});
afterEach(() => t.close());

describe('no silent event loss (INSERT OR IGNORE swallowed CHECK / NOT NULL violations)', () => {
  it('an event with an invalid source THROWS, rolls the commit back, and leaves the watermark unchanged', () => {
    t.store.watermarks.set('edgar.submissions', 'BBW', 'before', T0);
    const bad = { ...makeEvent({ naturalKey: 'x' }), source: 'bogus' } as never;
    const good = makeEvent({ naturalKey: 'y' });
    expect(() =>
      t.store.commitPoll({
        source: 'edgar.submissions',
        ticker: 'BBW',
        events: [good, bad],
        cursor: 'after',
        now: at(1),
      }),
    ).toThrow(ValidationError);
    expect(t.store.watermarks.get('edgar.submissions', 'BBW')?.cursor).toBe('before');
    expect(t.store.events.exists(good.id)).toBe(false); // the whole commit rolled back
  });

  it('a missing payload, a zoneless ts and a kind/source mismatch are loud ValidationErrors', () => {
    const base = makeEvent({ naturalKey: 'a' });
    expect(() => t.store.events.insertIgnore({ ...base, payload: undefined } as never, T0)).toThrow(
      /payload must be an object/,
    );
    expect(() => t.store.events.insertIgnore({ ...base, ts: '2026-12-03T08:00:00' }, T0)).toThrow(
      /explicit offset/,
    );
    expect(() => t.store.events.insertIgnore({ ...base, ts: 'nonsense' }, T0)).toThrow(
      ValidationError,
    );
    expect(() =>
      t.store.events.insertIgnore({ ...base, kind: 'halt', source: 'filing' }, T0),
    ).toThrow(/belongs to source "quote"/);
    expect(t.store.events.insertIgnore({ ...base, ts: '2026-12-03T13:00:00Z' }, T0)).toBe(true);
  });

  it('a duplicate id is still silently ignored (that is the ONLY conflict swallowed)', () => {
    const e = makeEvent({ naturalKey: 'dup' });
    expect(t.store.events.insertIgnore(e, T0)).toBe(true);
    expect(t.store.events.insertIgnore(e, at(1))).toBe(false);
  });

  it('an invalid push kind is a clear StoreError (it used to die with "Cannot read properties of undefined")', () => {
    expect(() =>
      t.store.outbox.enqueue(
        {
          kind: 'bogus' as never,
          priority: 'P1',
          ticker: 'BBW',
          headline: 'h',
          soWhat: null,
          eventIds: [],
          body: {},
          idempotencyKey: 'k',
        },
        T0,
      ),
    ).toThrow(StoreError);
  });

  it('event_links relate EVENT ids: linking a secondary to a PUSH id violates the foreign key', () => {
    const e = makeEvent({ naturalKey: 'p1' });
    t.store.events.insertIgnore(e, T0);
    expect(() => t.store.eventLinks.link(e.id, 'push_abc', 'overflow', null, T0)).toThrow(
      /FOREIGN KEY/,
    );
    const primary = makeEvent({ naturalKey: 'p2' });
    t.store.events.insertIgnore(primary, T0);
    expect(t.store.eventLinks.link(e.id, primary.id, 'overflow', null, T0)).toBe(true);
    expect(t.store.eventLinks.link(e.id, primary.id, 'overflow', null, T0)).toBe(false);
  });
});

describe('first-run / backfill / stale catch-up (invariant I11)', () => {
  it('a baseline poll stores events as dropped/baseline: queryable, but never `new`, never triaged or pushed', () => {
    const events = [makeEvent({ naturalKey: 'old-1' }), makeEvent({ naturalKey: 'old-2' })];
    const r = t.store.commitPoll({
      source: 'edgar.submissions',
      ticker: 'BBW',
      events,
      cursor: 'c1',
      now: T0,
      baseline: true,
    });
    expect(r.inserted).toHaveLength(0);
    expect(r.baselined).toHaveLength(2);
    expect(r.watermarkAdvanced).toBe(true);
    expect(t.store.events.byStatus(['new'])).toHaveLength(0);
    const stored = t.store.events.get(events[0]?.id ?? '');
    expect(stored).toMatchObject({ status: 'dropped', statusReason: 'baseline' });
    // still visible to /events and the briefs
    expect(t.store.events.byTicker('BBW')).toHaveLength(2);
    // the same facts re-polled later (non-baseline) are duplicates: they do NOT come back to life
    const again = t.store.commitPoll({
      source: 'edgar.submissions',
      ticker: 'BBW',
      events,
      now: at(5),
    });
    expect(again.inserted).toHaveLength(0);
    expect(again.duplicates).toHaveLength(2);
  });

  it('non-baseline events older than maxEventAgeMs are stored dropped/stale; fresh ones stay new', () => {
    const old = makeEvent({ naturalKey: 'old', ts: '2026-11-20T09:00:00.000-05:00' });
    const fresh = makeEvent({ naturalKey: 'fresh', ts: '2026-12-03T08:55:00.000-05:00' });
    const r = t.store.commitPoll({
      source: 's',
      ticker: 'BBW',
      events: [old, fresh],
      now: T0,
      maxEventAgeMs: 48 * 3_600_000,
    });
    expect(r.stale.map((e) => e.id)).toEqual([old.id]);
    expect(r.inserted.map((e) => e.id)).toEqual([fresh.id]);
    expect(t.store.events.get(old.id)).toMatchObject({ status: 'dropped', statusReason: 'stale' });
    expect(t.store.events.get(fresh.id)?.status).toBe('new');
  });

  it('baseline wins over the age rule and a cursor of null/undefined leaves the watermark alone', () => {
    t.store.watermarks.set('s', 'BBW', 'keep', T0);
    const r = t.store.commitPoll({
      source: 's',
      ticker: 'BBW',
      events: [makeEvent({ naturalKey: 'z', ts: '2020-01-01T00:00:00Z' })],
      cursor: null,
      now: T0,
      baseline: true,
      maxEventAgeMs: 1,
    });
    expect(r.baselined).toHaveLength(1);
    expect(r.stale).toHaveLength(0);
    expect(r.watermarkAdvanced).toBe(false);
    expect(t.store.watermarks.get('s', 'BBW')?.cursor).toBe('keep');
  });
});

describe('processing order, retry backoff and guarded transitions', () => {
  it("byStatus order 'priority' drains P1 before P2 before P3 before unclassified, then oldest", () => {
    const mk = (key: string, p?: 'P1' | 'P2' | 'P3'): string => {
      const e = makeEvent({ naturalKey: key, ...(p === undefined ? {} : { rulePriority: p }) });
      t.store.events.insertIgnore(e, new Date(T0.getTime() + mk.n++ * 1000));
      return e.id;
    };
    mk.n = 0;
    const news = mk('news-old', 'P3');
    const none = mk('none');
    const eightK = mk('8k', 'P1'); // newest, but P1
    const p2 = mk('p2', 'P2');
    expect(t.store.events.byStatus(['new'], { order: 'priority' }).map((e) => e.id)).toEqual([
      eightK,
      p2,
      news,
      none,
    ]);
    expect(t.store.events.byStatus(['new']).map((e) => e.id)).toEqual([news, none, eightK, p2]);
  });

  it('retryDueAt backs off exponentially from attempts + updated_at and caps', () => {
    const p = { baseSeconds: 30, maxSeconds: 900 };
    const upd = '2026-12-03T14:00:00.000Z';
    expect(retryDueAt(0, upd, p)).toBe(0);
    expect(retryDueAt(1, upd, p)).toBe(Date.parse(upd) + 30_000);
    expect(retryDueAt(3, upd, p)).toBe(Date.parse(upd) + 120_000);
    expect(retryDueAt(20, upd, p)).toBe(Date.parse(upd) + 900_000);
  });

  it('untriagedDue skips events still backing off (no LLM retry storm) and flags exhausted ones', () => {
    const policy = { baseSeconds: 30, maxSeconds: 900, maxAttempts: 3 };
    const fresh = makeEvent({ naturalKey: 'fresh', rulePriority: 'P1' });
    const failing = makeEvent({ naturalKey: 'failing', rulePriority: 'P1' });
    const poison = makeEvent({ naturalKey: 'poison' });
    for (const e of [fresh, failing, poison]) t.store.events.insertIgnore(e, T0);
    t.store.events.recordFailure(failing.id, 'overloaded', T0); // attempts 1, due at +30 s
    for (let i = 0; i < 3; i++) t.store.events.recordFailure(poison.id, 'refusal', T0);
    const early = t.store.events.untriagedDue(new Date(T0.getTime() + 10_000), policy);
    expect(early.due.map((e) => e.id)).toEqual([fresh.id]);
    expect(early.exhausted.map((e) => e.id)).toEqual([poison.id]);
    const later = t.store.events.untriagedDue(new Date(T0.getTime() + 31_000), policy);
    expect(later.due.map((e) => e.id).sort()).toEqual([fresh.id, failing.id].sort());
  });

  it('setStatus / markTriaged honor an expected prior status (invariant I4)', () => {
    const e = makeEvent({ naturalKey: 'g' });
    t.store.events.insertIgnore(e, T0);
    expect(t.store.events.setStatus(e.id, 'pushed', at(1), { expect: ['triaged'] })).toBe(false);
    expect(t.store.events.get(e.id)?.status).toBe('new');
    expect(t.store.events.markTriaged(e.id, { triage: null, finalPriority: 'P1' }, at(2))).toBe(
      true,
    );
    expect(t.store.events.setStatus(e.id, 'pushed', at(3), { expect: ['triaged'] })).toBe(true);
    // a stale second pass cannot resurrect a pushed event
    expect(t.store.events.markTriaged(e.id, { triage: null, finalPriority: 'P3' }, at(4))).toBe(
      false,
    );
    expect(t.store.events.get(e.id)).toMatchObject({ status: 'pushed', finalPriority: 'P1' });
  });

  it('byStatusReason finds parked events (queued + awaiting_scorecard)', () => {
    const e = makeEvent({ naturalKey: 'park' });
    t.store.events.insertIgnore(e, T0);
    t.store.events.setStatus(e.id, 'queued', at(1), { reason: 'awaiting_scorecard' });
    expect(t.store.events.byStatusReason('queued', 'awaiting_scorecard').map((x) => x.id)).toEqual([
      e.id,
    ]);
    expect(t.store.events.byStatusReason('queued', 'other')).toEqual([]);
  });

  it('digest_kind is constrained to premarket | midday | close', () => {
    const e = makeEvent({ naturalKey: 'dk' });
    t.store.events.insertIgnore(e, T0);
    expect(() => t.store.events.setStatus(e.id, 'queued', at(1), { digestKind: 'lunch' })).toThrow(
      /CHECK/,
    );
    t.store.events.setStatus(e.id, 'queued', at(1), { digestKind: 'midday' });
    expect(t.store.events.get(e.id)?.digestKind).toBe('midday');
  });
});

describe('outbox: lease (single-flight), push_events', () => {
  const push = (key: string, eventIds: string[] = []) => ({
    kind: 'alert' as const,
    priority: 'P1' as const,
    ticker: 'BBW',
    headline: key,
    soWhat: null,
    eventIds,
    body: {},
    idempotencyKey: key,
  });

  it('claimDue leases rows so an overlapping flush does not send the same push twice', () => {
    t.store.outbox.enqueue(push('a'), T0);
    t.store.outbox.enqueue(push('b'), T0);
    const first = t.store.outbox.claimDue(at(1), 120_000);
    expect(first).toHaveLength(2);
    expect(t.store.outbox.claimDue(at(1), 120_000)).toHaveLength(0); // a concurrent flush sees nothing
    expect(t.store.outbox.claimDue(at(3.5), 120_000)).toHaveLength(2); // crashed sender: the lease expired
    const row = first[0];
    if (row === undefined) throw new Error('no row');
    t.store.outbox.markSent(row.id, 'openclaw', at(3));
    const rest = t.store.outbox.claimDue(at(10), 120_000);
    expect(rest.map((r) => r.id)).not.toContain(row.id); // the sent push is never claimed again
    expect(rest).toHaveLength(1);
  });

  it('push_events answers "which push covered event X?" and is written with the push', () => {
    const e = makeEvent({ naturalKey: 'covered' });
    t.store.events.insertIgnore(e, T0);
    const { id } = t.store.outbox.enqueue(push('covers', [e.id]), T0);
    expect(t.store.outbox.pushesCovering(e.id).map((p) => p.id)).toEqual([id]);
    expect(t.store.outbox.pushesCovering('nope')).toEqual([]);
    // idempotent re-enqueue does not duplicate the link rows
    t.store.outbox.enqueue(push('covers', [e.id]), at(1));
    expect(t.store.outbox.pushesCovering(e.id)).toHaveLength(1);
  });
});

describe('schema: token rotation, plan history', () => {
  it('revoke then create for the same client works (rotation); two ACTIVE tokens for a client do not', () => {
    t.store.apiTokens.create('mayer', 'h1', ['read'], T0);
    expect(() => t.store.apiTokens.create('mayer', 'h1b', ['read'], T0)).toThrow(/UNIQUE/);
    expect(t.store.apiTokens.revoke('mayer', at(1))).toBe(true);
    t.store.apiTokens.create('mayer', 'h2', ['read'], at(2));
    expect(t.store.apiTokens.findActiveByHash('h1')).toBeUndefined();
    expect(t.store.apiTokens.findActiveByHash('h2')?.client).toBe('mayer');
    expect(t.store.apiTokens.list().map((x) => x.client)).toEqual(['mayer', 'mayer']);
  });
});

describe('timestamps: one canonical stored format', () => {
  it('normalizeInstant requires an offset and emits UTC Z with milliseconds', () => {
    expect(normalizeInstant('2026-08-27T07:02:11-04:00', 'x')).toBe('2026-08-27T11:02:11.000Z');
    expect(normalizeInstant('2026-08-27T11:02:11Z', 'x')).toBe('2026-08-27T11:02:11.000Z');
    expect(() => normalizeInstant('2026-08-27T07:02:11', 'acceptedAt')).toThrow(/acceptedAt/);
    expect(() => normalizeInstant('garbage', 'x')).toThrow(ValidationError);
  });

  it('filing/13D/13F/guidance instants are normalized so mixed -05:00 and Z forms order correctly', () => {
    const rec = (acc: string, acceptedAt: string) => ({
      type: 'filing' as const,
      record: {
        accession: acc,
        ticker: 'BBW',
        cik: '1',
        form: '8-K',
        items: [],
        filingDate: '2026-12-03',
        reportDate: null,
        acceptedAt,
        primaryDocument: null,
        primaryDocDescription: null,
        indexUrl: 'https://www.sec.gov/x',
        documentUrl: null,
        isInlineXbrl: false,
        raw: null,
      },
    });
    // 07:00 EST is 12:00Z; 11:30Z is EARLIER. As text, "07:00:00-05:00" < "11:30:00Z" would mis-order them.
    t.store.persistRecords(
      [rec('a1', '2026-12-03T07:00:00-05:00'), rec('a2', '2026-12-03T11:30:00Z')],
      T0,
    );
    expect(t.store.filings.recent('BBW').map((f) => f.accession)).toEqual(['a1', 'a2']);
    expect(t.store.filings.get('a1')?.acceptedAt).toBe('2026-12-03T12:00:00.000Z');
    expect(
      t.store.filings
        .recent('BBW', { sinceIso: '2026-12-03T06:45:00-05:00' })
        .map((f) => f.accession),
    ).toEqual(['a1']);
    expect(() => t.store.persistRecords([rec('a3', '2026-12-03T07:00:00')], T0)).toThrow(
      ValidationError,
    );
  });
});

describe('market data persistence', () => {
  const bar = (over: Partial<{ close: number; volume: number; atr20: number | null }> = {}) => ({
    ticker: 'BBW',
    date: '2026-12-02',
    open: 40,
    high: 42,
    low: 39,
    close: over.close ?? 41,
    volume: over.volume ?? 300_000,
    atr20: over.atr20 === undefined ? null : over.atr20,
    source: 't',
  });

  it('a re-fetched bar with changed OHLCV clears the stale cached ATR; an unchanged one keeps it', () => {
    t.store.quotes.upsert(bar({ atr20: 1.5 }), T0);
    t.store.quotes.upsert(bar(), at(1)); // same bar, no ATR supplied: keep the cache
    expect(t.store.quotes.get('BBW', '2026-12-02')?.atr20).toBe(1.5);
    t.store.quotes.upsert(bar({ close: 43 }), at(2)); // the partial bar became final: ATR is stale
    expect(t.store.quotes.get('BBW', '2026-12-02')?.atr20).toBeNull();
    t.store.quotes.upsert(bar({ close: 43, atr20: 1.7 }), at(3));
    expect(t.store.quotes.get('BBW', '2026-12-02')?.atr20).toBe(1.7);
  });

  it('latestCompleted excludes today; latest requires a bound', () => {
    t.store.quotes.upsert(bar(), T0);
    t.store.quotes.upsert({ ...bar(), date: '2026-12-03' }, T0); // today's (partial) bar
    expect(t.store.quotes.latestCompleted('BBW', 5, '2026-12-03').map((b) => b.date)).toEqual([
      '2026-12-02',
    ]);
    expect(t.store.quotes.latest('BBW', 5, '2026-12-03').map((b) => b.date)).toEqual([
      '2026-12-02',
      '2026-12-03',
    ]);
  });

  it('a later fetch REPLACES a still-forming intraday bar instead of keeping the first partial copy', () => {
    const b = {
      ticker: 'BBW',
      startMs: 1000,
      intervalMinutes: 5 as const,
      open: 1,
      high: 1.2,
      low: 0.9,
      close: 1.1,
      volume: 100,
    };
    expect(t.store.intraday.upsertBar(b)).toBe(true);
    expect(t.store.intraday.upsertBar({ ...b, high: 1.5, close: 1.4, volume: 900 })).toBe(true);
    expect(t.store.intraday.bars('BBW', 0, 2000)[0]).toMatchObject({ high: 1.5, volume: 900 });
    expect(t.store.intraday.upsertBar({ ...b, high: 1.5, close: 1.4, volume: 900 })).toBe(false);
  });

  it('the latest-quote repo persists a tick under kv quote:<SYMBOL> and exposes a QuoteSnapshotSource', () => {
    const tick = makeQuoteTick({ symbol: 'IWM', last: 210.5 });
    t.store.latestQuotes.set(tick, T0);
    expect(t.store.latestQuotes.get('iwm')?.tick.last).toBe(210.5);
    expect(t.store.latestQuotes.get('iwm')?.savedAtMs).toBe(T0.getTime());
    expect(t.store.kv.get('quote:IWM')).toBeDefined();
    const src = t.store.latestQuotes.asSource();
    expect(src.latest('IWM')?.last).toBe(210.5);
    expect(src.latest('NOPE')).toBeUndefined();
  });

  it('the read-only adapter view hides write methods at the type level and still reads', () => {
    const rs = t.store.asReadStore();
    expect(rs.quotes.latest('BBW', 1, '2026-12-31')).toEqual([]);
    // @ts-expect-error adapters cannot call write methods on their store view
    void rs.events.insertIgnore;
    // @ts-expect-error nor touch the watermarks
    void rs.watermarks.set;
    // @ts-expect-error nor commitPoll
    void rs.commitPoll;
    expect(typeof rs.events.get).toBe('function');
  });
});

describe('migration runner: foreignKeysOff, pending list, pre-migration backup', () => {
  const second: Migration = {
    id: '0002_rebuild_example',
    description: 'SQLite table-rebuild recipe',
    foreignKeysOff: true,
    sql: `
      CREATE TABLE new_kv (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL, extra TEXT);
      INSERT INTO new_kv (key, value_json, updated_at) SELECT key, value_json, updated_at FROM kv_state;
      DROP TABLE kv_state;
      ALTER TABLE new_kv RENAME TO kv_state;
    `,
  };

  it('a table-rebuild migration runs with foreign keys off (parents survive) and re-enables them', () => {
    const db = openDb(':memory:');
    migrate(db);
    db.prepare(
      "INSERT INTO events (id, ticker, source, kind, ts_iso, ts_epoch_ms, payload_json, created_at, updated_at) VALUES ('e1','BBW','filing','8-K','x',0,'{}','x','x')",
    ).run();
    db.prepare(
      "INSERT INTO event_links (secondary_id, primary_id, relation, created_at) VALUES ('e1','e1','duplicate','x')",
    ).run();
    db.prepare("INSERT INTO kv_state VALUES ('k','1','x')").run();
    const r = migrate(db, [...MIGRATIONS, second]);
    expect(r.applied).toEqual(['0002_rebuild_example']);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM event_links').get() as { n: number }).n).toBe(1);
    expect(db.prepare('SELECT key FROM kv_state').all()).toEqual([{ key: 'k' }]);
    db.close();
  });

  it('a foreignKeysOff migration that leaves violations is rolled back and foreign keys come back on', () => {
    const db = openDb(':memory:');
    migrate(db);
    const bad: Migration = {
      id: '0002_bad',
      description: 'breaks a foreign key',
      foreignKeysOff: true,
      sql: "INSERT INTO event_links (secondary_id, primary_id, relation, created_at) VALUES ('ghost','ghost2','duplicate','x');",
    };
    expect(() => migrate(db, [...MIGRATIONS, bad])).toThrow(/foreign key violation/);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM event_links').get()).toEqual({ n: 0 });
    db.close();
  });

  it('pendingMigrations lists what migrate would apply, and nothing on an up-to-date database', () => {
    const db = openDb(':memory:');
    expect(pendingMigrations(db).map((m) => m.id)).toEqual(['0001_initial']);
    migrate(db);
    expect(pendingMigrations(db)).toEqual([]);
    expect(pendingMigrations(db, [...MIGRATIONS, second]).map((m) => m.id)).toEqual([
      '0002_rebuild_example',
    ]);
    db.close();
  });

  it('openStore({backupBeforeMigrate}) snapshots a non-empty database before upgrading, not on a fresh one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-mig-'));
    try {
      const file = path.join(dir, 'scout.db');
      const backups = path.join(dir, 'bk');
      // fresh database: nothing worth backing up
      const s1 = openStore(file, { backupBeforeMigrate: backups });
      expect(fs.existsSync(backups)).toBe(false);
      s1.kv.set('keep', { v: 1 }, T0);
      s1.db.close();
      // up-to-date database reopened: no pending migrations, no backup
      const s2 = openStore(file, { backupBeforeMigrate: backups });
      expect(fs.existsSync(backups)).toBe(false);
      s2.db.close();
      // simulate "an older release": forget the migration record so 0001 is pending on a populated DB
      const raw = openDb(file);
      raw.exec(
        "DELETE FROM schema_migrations; INSERT INTO schema_migrations VALUES ('0000_old','x','x')",
      );
      raw.close();
      expect(() => openStore(file, { backupBeforeMigrate: backups })).toThrow(/does not know/);
      const files = fs.readdirSync(backups);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^pre-migrate-.*-0001_initial\.db$/);
      const copy = openDb(path.join(backups, files[0] ?? ''), { readonly: true });
      expect(copy.prepare("SELECT value_json FROM kv_state WHERE key = 'keep'").get()).toEqual({
        value_json: '{"v":1}',
      });
      copy.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('openStore accepts the legacy `now` function and the file database uses synchronous FULL', () => {
    const f = tempDbFile();
    try {
      const s = openStore(f.file, () => new Date('2026-12-03T00:00:00Z'));
      expect(s.db.pragma('synchronous', { simple: true })).toBe(2);
      s.db.close();
    } finally {
      f.close();
    }
  });
});
