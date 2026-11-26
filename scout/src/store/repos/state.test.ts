import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDb, type TempStore } from '../../test-support/temp-db.js';
import { COUNTERS } from './state.js';

let t: TempStore;
const T0 = new Date('2026-12-03T14:00:00.000Z');
const at = (min: number): Date => new Date(T0.getTime() + min * 60_000);

beforeEach(() => {
  t = tempDb();
});
afterEach(() => t.close());

describe('token_state (Schwab 7-day refresh clock, decision D12)', () => {
  it('a new login resets the refresh clock and reminder flags; a plain refresh does not', () => {
    t.store.tokenState.saveTokens('schwab', Buffer.from('blob1'), at(30), T0, {
      newRefreshToken: true,
    });
    expect(t.store.tokenState.get('schwab')).toMatchObject({
      refreshTokenIssuedAt: T0.toISOString(),
      sent24h: false,
      sent6h: false,
      sentExpired: false,
    });
    expect(t.store.tokenState.markReminderSent('schwab', 'sent24h', at(60))).toBe(true);
    expect(t.store.tokenState.markReminderSent('schwab', 'sent24h', at(61))).toBe(false); // exactly once
    expect(t.store.tokenState.markReminderSent('schwab', 'sent6h', at(62))).toBe(true);
    // access-token refresh 25 minutes later: issued-at and flags unchanged, blob replaced
    t.store.tokenState.saveTokens('schwab', Buffer.from('blob2'), at(55), at(25), {
      newRefreshToken: false,
    });
    const s = t.store.tokenState.get('schwab');
    expect(s?.refreshTokenIssuedAt).toBe(T0.toISOString());
    expect(s?.sent24h).toBe(true);
    expect(s?.encryptedBlob?.toString()).toBe('blob2');
    expect(s?.accessExpiresAt).toBe(at(55).toISOString());
    expect(s?.lastRefreshOkAt).toBe(at(25).toISOString());
    // re-authorization clears everything
    t.store.tokenState.saveTokens('schwab', Buffer.from('blob3'), at(1000), at(900), {
      newRefreshToken: true,
    });
    expect(t.store.tokenState.get('schwab')).toMatchObject({
      sent24h: false,
      sent6h: false,
      refreshTokenIssuedAt: at(900).toISOString(),
    });
  });

  it('records errors, and marks quotes-down alerted ONCE per outage until cleared', () => {
    t.store.tokenState.recordError('schwab', 'refresh rejected', T0);
    expect(t.store.tokenState.get('schwab')?.lastError).toBe('refresh rejected');
    expect(t.store.tokenState.get('schwab')?.encryptedBlob).toBeNull();
    expect(t.store.tokenState.markQuotesDownAlerted('schwab', at(1))).toBe(true);
    expect(t.store.tokenState.markQuotesDownAlerted('schwab', at(2))).toBe(false);
    t.store.tokenState.clearQuotesDownAlerted('schwab', at(3));
    expect(t.store.tokenState.markQuotesDownAlerted('schwab', at(4))).toBe(true);
    expect(t.store.tokenState.get('schwab')?.sentExpired).toBe(false);
    expect(t.store.tokenState.markReminderSent('schwab', 'sentExpired', at(5))).toBe(true);
    expect(t.store.tokenState.get('missing')).toBeUndefined();
  });
});

describe('health_state', () => {
  it('tracks status transitions: since changes only on change, last_ok on ok, failures count up', () => {
    expect(t.store.health.set('edgar', 'ok', T0, 'fine')).toBeNull();
    expect(t.store.health.set('edgar', 'ok', at(1))).toBe('ok');
    expect(t.store.health.get('edgar')).toMatchObject({
      status: 'ok',
      since: T0.toISOString(),
      lastOk: at(1).toISOString(),
      consecutiveFailures: 0,
    });
    expect(t.store.health.set('edgar', 'down', at(2), 'HTTP 503')).toBe('ok');
    expect(t.store.health.set('edgar', 'down', at(3), 'HTTP 503')).toBe('down');
    expect(t.store.health.get('edgar')).toMatchObject({
      status: 'down',
      since: at(2).toISOString(),
      lastOk: at(1).toISOString(),
      consecutiveFailures: 2,
      detail: 'HTTP 503',
    });
    t.store.health.markAlerted('edgar', at(3));
    expect(t.store.health.set('edgar', 'ok', at(10))).toBe('down');
    t.store.health.markRecoveryAlerted('edgar', at(10));
    expect(t.store.health.get('edgar')).toMatchObject({
      status: 'ok',
      since: at(10).toISOString(),
      consecutiveFailures: 0,
      lastAlertAt: at(3).toISOString(),
      lastRecoveryAlertAt: at(10).toISOString(),
    });
    t.store.health.set('schwab', 'down', T0);
    expect(t.store.health.get('schwab')).toMatchObject({ consecutiveFailures: 1, lastOk: null });
    expect(t.store.health.all().map((h) => h.component)).toEqual(['edgar', 'schwab']);
  });
});

describe('alert_state cooldowns', () => {
  it('tryAcquire fires once per cooldown window, again after it, and clear() resets', () => {
    const hour = 3_600_000;
    expect(t.store.alertState.tryAcquire('health:edgar', 6 * hour, T0)).toBe(true);
    expect(t.store.alertState.tryAcquire('health:edgar', 6 * hour, at(60))).toBe(false);
    expect(t.store.alertState.tryAcquire('health:other', 6 * hour, at(60))).toBe(true);
    expect(t.store.alertState.tryAcquire('health:edgar', 6 * hour, at(361))).toBe(true);
    expect(t.store.alertState.get('health:edgar')).toMatchObject({
      count: 2,
      lastSentAt: at(361).toISOString(),
    });
    t.store.alertState.clear('health:edgar');
    expect(t.store.alertState.get('health:edgar')).toBeUndefined();
    expect(t.store.alertState.tryAcquire('health:edgar', 6 * hour, at(362))).toBe(true);
  });

  it('setMeta stores JSON without stamping a send time', () => {
    t.store.alertState.setMeta('outage:openclaw', { since: 'x' });
    expect(t.store.alertState.get('outage:openclaw')).toMatchObject({
      lastSentAt: null,
      meta: { since: 'x' },
    });
    expect(t.store.alertState.tryAcquire('outage:openclaw', 1000, T0)).toBe(true);
    expect(t.store.alertState.get('outage:openclaw')?.meta).toEqual({ since: 'x' });
  });
});

describe('daily_counters and kv_state', () => {
  it('increments per (date, name), reads defaults to 0, and lists a date', () => {
    expect(t.store.counters.get('2026-12-03', COUNTERS.P1_PUSHED)).toBe(0);
    expect(t.store.counters.increment('2026-12-03', COUNTERS.P1_PUSHED)).toBe(1);
    expect(t.store.counters.increment('2026-12-03', COUNTERS.P1_PUSHED)).toBe(2);
    expect(t.store.counters.increment('2026-12-03', COUNTERS.P1_FOLDED, 3)).toBe(3);
    expect(t.store.counters.increment('2026-12-04', COUNTERS.P1_PUSHED)).toBe(1);
    expect(t.store.counters.get('2026-12-03', COUNTERS.P1_PUSHED)).toBe(2);
    expect(t.store.counters.forDate('2026-12-03')).toEqual({ p1_pushed: 2, p1_folded: 3 });
  });

  it('kv stores arbitrary JSON, overwrites and deletes', () => {
    expect(t.store.kv.get('x')).toBeUndefined();
    t.store.kv.set('x', { a: [1, 2] }, T0);
    t.store.kv.set('x', { a: [3] }, at(1));
    expect(t.store.kv.get('x')).toEqual({ a: [3] });
    t.store.kv.delete('x');
    expect(t.store.kv.get('x')).toBeUndefined();
  });
});

describe('jobs_runs', () => {
  it('records start/finish, last/lastSuccess, recent history and fails stale running rows at startup', () => {
    const a = t.store.jobRuns.start('premarket', T0);
    expect(t.store.jobRuns.last('premarket')).toMatchObject({
      id: a,
      status: 'running',
      finishedAt: null,
    });
    t.store.jobRuns.finish(a, 'ok', at(1), { detail: { events: 3 } });
    const b = t.store.jobRuns.start('premarket', at(10));
    t.store.jobRuns.finish(b, 'error', at(11), { error: 'boom' });
    const c = t.store.jobRuns.start('premarket', at(20)); // crash: left running
    expect(t.store.jobRuns.last('premarket')).toMatchObject({ id: c });
    expect(t.store.jobRuns.lastSuccess('premarket')).toMatchObject({
      id: a,
      detail: { events: 3 },
    });
    expect(t.store.jobRuns.failStaleRunning(at(30))).toBe(1);
    expect(t.store.jobRuns.recent('premarket', 5).map((r) => r.status)).toEqual([
      'error',
      'error',
      'ok',
    ]);
    expect(t.store.jobRuns.last('nope')).toBeUndefined();
  });
});

describe('api_tokens', () => {
  it('stores only hashes; finds active tokens; revoke hides them; hasActive tracks state', () => {
    expect(t.store.apiTokens.hasActive()).toBe(false);
    const id = t.store.apiTokens.create('mayer', 'a'.repeat(64), ['read'], T0);
    expect(t.store.apiTokens.hasActive()).toBe(true);
    expect(t.store.apiTokens.findActiveByHash('a'.repeat(64))).toMatchObject({
      id,
      client: 'mayer',
      scopes: ['read'],
      revokedAt: null,
    });
    t.store.apiTokens.touch(id, at(1));
    expect(t.store.apiTokens.list()[0]?.lastUsedAt).toBe(at(1).toISOString());
    expect(() => t.store.apiTokens.create('mayer', 'b'.repeat(64), ['read'], T0)).toThrow(/UNIQUE/);
    expect(t.store.apiTokens.revoke('mayer', at(2))).toBe(true);
    expect(t.store.apiTokens.revoke('mayer', at(3))).toBe(false);
    expect(t.store.apiTokens.findActiveByHash('a'.repeat(64))).toBeUndefined();
    expect(t.store.apiTokens.hasActive()).toBe(false);
  });
});

describe('llm_calls', () => {
  const call = (over: Partial<Parameters<TempStore['store']['llmCalls']['insert']>[0]> = {}) => ({
    ts: T0,
    day: '2026-12-03',
    job: 'triage',
    model: 'claude-haiku-5-5',
    tier: 'triage' as const,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 4000,
    cacheWriteTokens: 0,
    costUsd: 0.25,
    batch: false,
    stopReason: 'end_turn',
    eventId: 'e1',
    ticker: 'BBW',
    latencyMs: 200,
    requestId: 'req1',
    ok: true,
    error: null,
    ...over,
  });

  it('sums spend by owner-local day and month; summarizes by job/model with cache hit rate', () => {
    t.store.llmCalls.insert(call());
    t.store.llmCalls.insert(
      call({
        job: 'brief_close',
        model: 'claude-sonnet-5-5',
        tier: 'synth',
        costUsd: 1.5,
        cacheReadTokens: 0,
        inputTokens: 3000,
      }),
    );
    t.store.llmCalls.insert(call({ day: '2026-12-04', costUsd: 2 }));
    t.store.llmCalls.insert(call({ day: '2026-11-30', costUsd: 10 }));
    expect(t.store.llmCalls.spendForDay('2026-12-03')).toBeCloseTo(1.75);
    expect(t.store.llmCalls.spendForDay('2026-12-09')).toBe(0);
    expect(t.store.llmCalls.spendForMonth('2026-12')).toBeCloseTo(3.75);
    expect(t.store.llmCalls.spendForMonth('2026-11')).toBeCloseTo(10);
    const day = t.store.llmCalls.summary('2026-12-03');
    expect(day.calls).toBe(2);
    expect(day.costUsd).toBeCloseTo(1.75);
    expect(day.byJob.map((j) => j.job)).toEqual(['brief_close', 'triage']);
    expect(day.byModel[0]?.model).toBe('claude-sonnet-5-5');
    expect(day.cacheHitRate).toBeCloseTo(4000 / (4000 + 4000));
    expect(t.store.llmCalls.summary('2026-12').calls).toBe(3);
    expect(t.store.llmCalls.summary('1999-01').cacheHitRate).toBeNull();
    expect(t.store.llmCalls.recent(2)).toHaveLength(2);
    expect(t.store.llmCalls.recent(1)[0]).toMatchObject({ batch: false, ok: true, tier: 'triage' });
  });
});

describe('plan_snapshots, positions, scorecards, guidance, fact sheets', () => {
  it('plan snapshots are written only when the hash changes', () => {
    expect(
      t.store.planSnapshots.snapshotIfChanged('BBW', 'h1', { a: 1 }, { complete: false }, T0),
    ).toBe(true);
    expect(
      t.store.planSnapshots.snapshotIfChanged('BBW', 'h1', { a: 1 }, { complete: false }, at(1)),
    ).toBe(false);
    expect(
      t.store.planSnapshots.snapshotIfChanged('BBW', 'h2', { a: 2 }, { complete: true }, at(2)),
    ).toBe(true);
    expect(t.store.planSnapshots.latest('BBW')).toMatchObject({
      planHash: 'h2',
      plan: { a: 2 },
      completeness: { complete: true },
    });
    // A -> B -> A is a REAL history: the second A is a new snapshot and becomes the latest (no unique hash)
    expect(t.store.planSnapshots.snapshotIfChanged('BBW', 'h1', { a: 1 }, {}, at(3))).toBe(true);
    expect(t.store.planSnapshots.latest('BBW')?.planHash).toBe('h1');
    expect(t.store.planSnapshots.snapshotIfChanged('BBW', 'h1', { a: 1 }, {}, at(4))).toBe(false);
    expect(t.store.planSnapshots.latest('NOPE')).toBeUndefined();
  });

  it('positions: latest and history (newest first)', () => {
    for (const [i, q] of [100, 150, 200].entries()) {
      t.store.positions.insert(
        {
          ticker: 'BBW',
          tsMs: T0.getTime() + i * 1000,
          quantity: q,
          averageCost: 40,
          marketValue: q * 50,
          dayPnl: 1,
          unrealizedPnl: q * 10,
          extra: { i },
        },
        T0,
      );
    }
    expect(t.store.positions.latest('BBW')).toMatchObject({ quantity: 200, extra: { i: 2 } });
    expect(t.store.positions.history('BBW', 2).map((p) => p.quantity)).toEqual([200, 150]);
    expect(t.store.positions.latest('NOPE')).toBeUndefined();
  });

  it('scorecards: upsert per (ticker, period), latest, list', () => {
    t.store.scorecards.upsert('BBW', 'Q2 FY26', 'acc-1', { v: 1 }, 'Guide cut', T0);
    t.store.scorecards.upsert('BBW', 'Q3 FY26', 'acc-2', { v: 2 }, 'Guide held', at(5));
    t.store.scorecards.upsert('BBW', 'Q2 FY26', 'acc-1', { v: 1.1 }, 'Guide cut', at(10));
    expect(t.store.scorecards.get('BBW', 'Q2 FY26')).toMatchObject({
      json: { v: 1.1 },
      leadLine: 'Guide cut',
      createdAt: T0.toISOString(),
    });
    expect(t.store.scorecards.latest('BBW')?.period).toBe('Q2 FY26');
    expect(t.store.scorecards.list('BBW')).toHaveLength(2);
    expect(t.store.scorecards.get('BBW', 'x')).toBeUndefined();
  });

  it('guidance history: idempotent insert, latest-before comparisons, ordered history', () => {
    const g = (acc: string, asOf: string, low: number, high: number) => ({
      ticker: 'BBW',
      period: 'FY2026',
      metric: 'revenue',
      low,
      high,
      unit: 'usd_millions',
      sourceAccession: acc,
      asOf,
    });
    expect(t.store.guidance.insertIgnore(g('a1', '2026-03-01T00:00:00Z', 500, 520), T0)).toBe(true);
    expect(t.store.guidance.insertIgnore(g('a1', '2026-03-01T00:00:00Z', 500, 520), T0)).toBe(
      false,
    );
    t.store.guidance.insertIgnore(g('a2', '2026-06-01T00:00:00Z', 510, 530), T0);
    t.store.guidance.insertIgnore(g('a3', '2026-08-27T00:00:00Z', 480, 500), T0);
    expect(t.store.guidance.latest('BBW', 'FY2026', 'revenue')?.sourceAccession).toBe('a3');
    expect(
      t.store.guidance.latest('BBW', 'FY2026', 'revenue', '2026-08-27T00:00:00Z')?.sourceAccession,
    ).toBe('a2');
    expect(t.store.guidance.latest('BBW', 'FY2026', 'pretax_income')).toBeUndefined();
    expect(t.store.guidance.history('BBW', 'revenue').map((r) => r.sourceAccession)).toEqual([
      'a1',
      'a2',
      'a3',
    ]);
    expect(t.store.guidance.history('BBW', 'revenue', 'FY2027')).toEqual([]);
  });

  it('fact sheets: put/get/overwrite', () => {
    expect(t.store.factSheets.get('BBW')).toBeUndefined();
    t.store.factSheets.put('BBW', 'sheet v1', 'acc-1', 900, T0);
    t.store.factSheets.put('BBW', 'sheet v2', 'acc-2', 950, at(1));
    expect(t.store.factSheets.get('BBW')).toEqual({
      ticker: 'BBW',
      text: 'sheet v2',
      builtFromAccession: 'acc-2',
      estTokens: 950,
      builtAt: at(1).toISOString(),
    });
  });
});

describe('watermarks', () => {
  it('get/set/all/delete per (source, ticker)', () => {
    expect(t.store.watermarks.get('edgar.submissions', 'BBW')).toBeUndefined();
    t.store.watermarks.set('edgar.submissions', 'BBW', 'c1', T0);
    t.store.watermarks.set('edgar.submissions', 'BBW', 'c2', at(1));
    t.store.watermarks.set('fred', '*', 'd1', at(2));
    expect(t.store.watermarks.get('edgar.submissions', 'BBW')).toEqual({
      source: 'edgar.submissions',
      ticker: 'BBW',
      cursor: 'c2',
      updatedAt: at(1).toISOString(),
    });
    expect(t.store.watermarks.all().map((w) => w.source)).toEqual(['edgar.submissions', 'fred']);
    t.store.watermarks.delete('fred', '*');
    expect(t.store.watermarks.all()).toHaveLength(1);
  });
});
