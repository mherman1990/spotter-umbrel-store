import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEvent, resetFactories } from '../../test-support/factories.js';
import { tempDb, type TempStore } from '../../test-support/temp-db.js';

let t: TempStore;
const T0 = new Date('2026-12-03T14:00:00.000Z');
const at = (min: number): Date => new Date(T0.getTime() + min * 60_000);

beforeEach(() => {
  resetFactories();
  t = tempDb();
});
afterEach(() => t.close());

describe('EventsRepo inserts are idempotent (decision D9)', () => {
  it('INSERT OR IGNORE by id: a re-poll neither duplicates nor resets lifecycle', () => {
    const e = makeEvent({ naturalKey: 'acc-1', rulePriority: 'P1' });
    expect(t.store.events.insertIgnore(e, T0)).toBe(true);
    t.store.events.markTriaged(e.id, { triage: { v: 1 }, finalPriority: 'P1' }, at(1));
    t.store.events.setStatus(e.id, 'pushed', at(2));
    // same fact polled again with a different payload (e.g. a re-fetched page)
    const again = { ...e, payload: { changed: true } };
    expect(t.store.events.insertIgnore(again, at(3))).toBe(false);
    const stored = t.store.events.get(e.id);
    expect(stored?.status).toBe('pushed');
    expect(stored?.payload).toEqual(e.payload);
    expect(t.store.events.countByStatus().pushed).toBe(1);
  });

  it('insertManyIgnore partitions new vs duplicate events', () => {
    const a = makeEvent({ naturalKey: 'a' });
    const b = makeEvent({ naturalKey: 'b' });
    t.store.events.insertIgnore(a, T0);
    const r = t.store.events.insertManyIgnore([a, b], at(1));
    expect(r.inserted.map((e) => e.id)).toEqual([b.id]);
    expect(r.duplicates.map((e) => e.id)).toEqual([a.id]);
  });

  it('round-trips every Event field including ET-offset ts, url and priorities', () => {
    const e = makeEvent({
      naturalKey: 'rt',
      url: 'https://www.sec.gov/x',
      rulePriority: 'P2',
      finalPriority: 'P1',
      payload: { n: 1, nested: { a: [1, 2] } },
    });
    t.store.events.insertIgnore(e, T0);
    const s = t.store.events.get(e.id);
    expect(s).toMatchObject({
      id: e.id,
      ticker: 'BBW',
      source: 'filing',
      kind: '8-K',
      ts: e.ts,
      url: 'https://www.sec.gov/x',
      rulePriority: 'P2',
      finalPriority: 'P1',
      status: 'new',
      attempts: 0,
    });
    expect(s?.payload).toEqual(e.payload);
    expect(s?.createdAt).toBe(T0.toISOString());
  });

  it('rejects an event whose ts cannot be parsed', () => {
    expect(() => t.store.events.insertIgnore(makeEvent({ ts: 'garbage' }), T0)).toThrow(
      /unparseable ts/,
    );
  });
});

describe('lifecycle (decision D10)', () => {
  it('recordFailure keeps the event eligible for retry (status unchanged, attempts counted)', () => {
    const e = makeEvent({ naturalKey: 'f' });
    t.store.events.insertIgnore(e, T0);
    t.store.events.recordFailure(e.id, 'LLM timeout', at(1));
    t.store.events.recordFailure(e.id, 'LLM 503', at(2));
    const s = t.store.events.get(e.id);
    expect(s).toMatchObject({ status: 'new', attempts: 2, lastError: 'LLM 503' });
    expect(t.store.events.byStatus(['new']).map((x) => x.id)).toContain(e.id);
    t.store.events.markTriaged(
      e.id,
      { triage: { material: true }, finalPriority: 'P2', reason: 'judged' },
      at(3),
    );
    expect(t.store.events.get(e.id)).toMatchObject({
      status: 'triaged',
      finalPriority: 'P2',
      lastError: null,
      statusReason: 'judged',
    });
    expect(t.store.events.get(e.id)?.triage).toEqual({ material: true });
  });

  it('byStatus returns the work queue oldest-first with limit/ticker/createdBefore filters', () => {
    const a = makeEvent({ naturalKey: 'a' });
    const b = makeEvent({ naturalKey: 'b', ticker: 'AAPL' });
    const c = makeEvent({ naturalKey: 'c' });
    t.store.events.insertIgnore(a, at(0));
    t.store.events.insertIgnore(b, at(1));
    t.store.events.insertIgnore(c, at(2));
    expect(t.store.events.byStatus(['new']).map((e) => e.id)).toEqual([a.id, b.id, c.id]);
    expect(t.store.events.byStatus(['new'], { limit: 2 }).map((e) => e.id)).toEqual([a.id, b.id]);
    expect(t.store.events.byStatus(['new'], { ticker: 'AAPL' }).map((e) => e.id)).toEqual([b.id]);
    expect(t.store.events.byStatus(['new'], { createdBefore: at(2) }).map((e) => e.id)).toEqual([
      a.id,
      b.id,
    ]);
    expect(t.store.events.oldestUnjudgedAt()).toBe(at(0).toISOString());
  });

  it('queued events are found per digest kind and can be marked digested', () => {
    const a = makeEvent({ naturalKey: 'a' });
    const b = makeEvent({ naturalKey: 'b' });
    t.store.events.insertIgnore(a, T0);
    t.store.events.insertIgnore(b, T0);
    t.store.events.setStatus(a.id, 'queued', T0, { digestKind: 'midday', reason: 'P2 -> midday' });
    t.store.events.setStatus(b.id, 'queued', T0, { digestKind: 'close' });
    expect(t.store.events.queuedForDigest('midday').map((e) => e.id)).toEqual([a.id]);
    expect(t.store.events.queuedForDigest(null)).toHaveLength(2);
    expect(t.store.events.markDigested([a.id], at(5))).toBe(1);
    expect(t.store.events.get(a.id)?.status).toBe('digested');
    expect(t.store.events.get(a.id)?.digestKind).toBe('midday'); // kept as history
    expect(t.store.events.markDigested([], at(5))).toBe(0);
  });

  it('setStatus keeps the previous reason unless a new one is given', () => {
    const e = makeEvent({ naturalKey: 'r' });
    t.store.events.insertIgnore(e, T0);
    t.store.events.setStatus(e.id, 'dropped', T0, { reason: 'immaterial' });
    t.store.events.setStatus(e.id, 'dropped', at(1));
    expect(t.store.events.get(e.id)?.statusReason).toBe('immaterial');
  });
});

describe('queries', () => {
  it('byTicker filters by time window, kinds, sources, statuses and minimum priority; orders by time', () => {
    const mk = (nk: string, over: Parameters<typeof makeEvent>[0]) => {
      const e = makeEvent({ naturalKey: nk, ...over });
      t.store.events.insertIgnore(e, T0);
      return e;
    };
    const p1 = mk('p1', { ts: '2026-12-03T08:00:00.000-05:00', rulePriority: 'P1', kind: '8-K' });
    const p2 = mk('p2', { ts: '2026-12-03T09:00:00.000-05:00', rulePriority: 'P2', kind: 'form4' });
    const p3 = mk('p3', {
      ts: '2026-12-03T10:00:00.000-05:00',
      rulePriority: 'P3',
      kind: 'news',
      source: 'news',
    });
    mk('other', { ts: '2026-12-03T10:00:00.000-05:00', ticker: 'AAPL' });
    const all = t.store.events.byTicker('BBW');
    expect(all.map((e) => e.id)).toEqual([p3.id, p2.id, p1.id]); // newest first
    expect(t.store.events.byTicker('BBW', { order: 'asc' }).map((e) => e.id)).toEqual([
      p1.id,
      p2.id,
      p3.id,
    ]);
    expect(t.store.events.byTicker('BBW', { minPriority: 'P2' }).map((e) => e.id)).toEqual([
      p2.id,
      p1.id,
    ]);
    expect(t.store.events.byTicker('BBW', { minPriority: 'P1' }).map((e) => e.id)).toEqual([p1.id]);
    expect(t.store.events.byTicker('BBW', { kinds: ['news'] }).map((e) => e.id)).toEqual([p3.id]);
    expect(t.store.events.byTicker('BBW', { sources: ['news'] }).map((e) => e.id)).toEqual([p3.id]);
    expect(
      t.store.events
        .byTicker('BBW', { sinceMs: Date.parse('2026-12-03T09:00:00.000-05:00') })
        .map((e) => e.id),
    ).toEqual([p3.id, p2.id]);
    expect(
      t.store.events
        .byTicker('BBW', { untilMs: Date.parse('2026-12-03T09:00:00.000-05:00') })
        .map((e) => e.id),
    ).toEqual([p1.id]);
    expect(t.store.events.byTicker('BBW', { statuses: ['pushed'] })).toEqual([]);
    expect(t.store.events.byTicker('BBW', { limit: 1 })).toHaveLength(1);
    expect(t.store.events.recentBySource('BBW', ['news'], 0).map((e) => e.id)).toEqual([p3.id]);
  });

  it('final priority wins over rule priority in minPriority/count/list', () => {
    const e = makeEvent({ naturalKey: 'x', rulePriority: 'P3' });
    t.store.events.insertIgnore(e, T0);
    t.store.events.markTriaged(e.id, { triage: null, finalPriority: 'P2' }, T0);
    expect(t.store.events.byTicker('BBW', { minPriority: 'P2' })).toHaveLength(1);
    expect(t.store.events.countRecent({ priority: 'P2', since: at(-1) })).toBe(1);
    expect(t.store.events.countRecent({ priority: 'P3', since: at(-1) })).toBe(0);
  });

  it('countRecent / listRecent drive the P2 cluster window (created_at based, status and ticker filters)', () => {
    const ids: string[] = [];
    for (const [i, min] of [0, 10, 20, 50].entries()) {
      const e = makeEvent({ naturalKey: `c${i}`, rulePriority: 'P2' });
      ids.push(e.id);
      t.store.events.insertIgnore(e, at(min));
      t.store.events.setStatus(e.id, 'queued', at(min), { digestKind: 'midday' });
    }
    const since = at(50 - 30);
    expect(t.store.events.countRecent({ priority: 'P2', since, statuses: ['queued'] })).toBe(2); // minutes 20 and 50
    expect(
      t.store.events
        .listRecent({ priority: 'P2', since: at(-1), statuses: ['queued'] })
        .map((e) => e.id),
    ).toEqual(ids);
    expect(t.store.events.countRecent({ priority: 'P2', since, statuses: ['pushed'] })).toBe(0);
    expect(t.store.events.countRecent({ priority: 'P2', since: at(-1), ticker: 'AAPL' })).toBe(0);
    expect(t.store.events.countRecent({ priority: 'P2', since: at(-1), ticker: 'BBW' })).toBe(4);
  });
});

describe('EventLinksRepo', () => {
  it('links secondaries to a primary idempotently and reads both directions', () => {
    const p = makeEvent({ naturalKey: 'p' });
    const s1 = makeEvent({ naturalKey: 's1' });
    const s2 = makeEvent({ naturalKey: 's2' });
    for (const e of [p, s1, s2]) t.store.events.insertIgnore(e, T0);
    expect(t.store.eventLinks.link(s1.id, p.id, 'rewrite', 0.82, T0)).toBe(true);
    expect(t.store.eventLinks.link(s1.id, p.id, 'rewrite', 0.9, T0)).toBe(false);
    t.store.eventLinks.link(s2.id, p.id, 'duplicate', null, at(1));
    expect(t.store.eventLinks.primaryOf(s1.id)).toEqual({
      primaryId: p.id,
      relation: 'rewrite',
      score: 0.82,
    });
    expect(t.store.eventLinks.secondariesOf(p.id).map((x) => x.secondaryId)).toEqual([
      s1.id,
      s2.id,
    ]);
    expect(t.store.eventLinks.primaryOf(p.id)).toBeUndefined();
  });

  it('enforces foreign keys (cannot link unknown events)', () => {
    expect(() => t.store.eventLinks.link('nope', 'nada', 'duplicate', null, T0)).toThrow(
      /FOREIGN KEY/,
    );
  });
});
