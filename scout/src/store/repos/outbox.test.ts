import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pushIdempotencyKey } from '../../core/ids.js';
import { tempDb, type TempStore } from '../../test-support/temp-db.js';
import type { NewPush } from './outbox.js';

let t: TempStore;
const T0 = new Date('2026-12-03T14:00:00.000Z');
const at = (sec: number): Date => new Date(T0.getTime() + sec * 1000);

function push(over: Partial<NewPush> = {}): NewPush {
  const eventIds = over.eventIds ?? ['e1'];
  return {
    kind: 'alert',
    priority: 'P1',
    ticker: 'BBW',
    headline: '8-K Item 2.02',
    soWhat: 'Results out',
    eventIds,
    body: { headline: '8-K Item 2.02' },
    idempotencyKey: pushIdempotencyKey('alert', 'BBW', eventIds),
    ...over,
  };
}

beforeEach(() => {
  t = tempDb();
});
afterEach(() => t.close());

describe('OutboxRepo', () => {
  it('enqueue is idempotent by idempotency key (same id back, inserted=false)', () => {
    const a = t.store.outbox.enqueue(push(), T0);
    const b = t.store.outbox.enqueue(push(), at(5));
    expect(a.inserted).toBe(true);
    expect(b).toEqual({ id: a.id, inserted: false });
    expect(t.store.outbox.countByStatus()).toEqual({ pending: 1, sent: 0, failed: 0, folded: 0 });
    expect(t.store.outbox.getByKey(push().idempotencyKey)?.id).toBe(a.id);
  });

  it('round-trips the record', () => {
    const { id } = t.store.outbox.enqueue(push({ eventIds: ['e1', 'e2'], body: { a: [1] } }), T0);
    expect(t.store.outbox.get(id)).toMatchObject({
      id,
      kind: 'alert',
      priority: 'P1',
      ticker: 'BBW',
      headline: '8-K Item 2.02',
      soWhat: 'Results out',
      eventIds: ['e1', 'e2'],
      body: { a: [1] },
      channel: null,
      status: 'pending',
      attempts: 0,
      sentAt: null,
    });
  });

  it('due() returns pending pushes whose time has come, most urgent then oldest first', () => {
    const p3 = t.store.outbox.enqueue(
      push({ eventIds: ['3'], priority: 'P3', kind: 'digest' }),
      at(0),
    ).id;
    const p1 = t.store.outbox.enqueue(push({ eventIds: ['1'], priority: 'P1' }), at(2)).id;
    const p2 = t.store.outbox.enqueue(push({ eventIds: ['2'], priority: 'P2' }), at(1)).id;
    const later = t.store.outbox.enqueue(
      push({ eventIds: ['4'], priority: 'P1', nextAttemptAt: at(600) }),
      at(3),
    ).id;
    expect(t.store.outbox.due(at(10)).map((p) => p.id)).toEqual([p1, p2, p3]);
    expect(t.store.outbox.due(at(700)).map((p) => p.id)).toEqual([p1, later, p2, p3]);
    expect(t.store.outbox.due(at(10), 1)).toHaveLength(1);
  });

  it('a failed send keeps the push pending with a retry time (never lost); giving up marks it failed', () => {
    const { id } = t.store.outbox.enqueue(push(), T0);
    t.store.outbox.markAttemptFailed(id, 'ECONNREFUSED', at(30));
    expect(t.store.outbox.get(id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'ECONNREFUSED',
    });
    expect(t.store.outbox.due(at(29))).toEqual([]);
    expect(t.store.outbox.due(at(30)).map((p) => p.id)).toEqual([id]);
    t.store.outbox.markAttemptFailed(id, 'still down', null);
    expect(t.store.outbox.get(id)).toMatchObject({
      status: 'failed',
      attempts: 2,
      nextAttemptAt: null,
    });
    expect(t.store.outbox.due(at(9999))).toEqual([]);
  });

  it('markSent records channel and time and clears the error; counts feed the "pushes today" acceptance checks', () => {
    const a = t.store.outbox.enqueue(push({ eventIds: ['a'] }), T0).id;
    const b = t.store.outbox.enqueue(
      push({ eventIds: ['b'], priority: 'P2', kind: 'digest' }),
      T0,
    ).id;
    t.store.outbox.markAttemptFailed(a, 'openclaw down', at(5));
    t.store.outbox.markSent(a, 'ntfy', at(6));
    t.store.outbox.markSent(b, 'openclaw', at(7));
    const rec = t.store.outbox.get(a);
    expect(rec).toMatchObject({
      status: 'sent',
      channel: 'ntfy',
      lastError: null,
      attempts: 2,
      sentAt: at(6).toISOString(),
    });
    expect(t.store.outbox.countSentSince(T0)).toBe(2);
    expect(t.store.outbox.countSentSince(T0, { kind: 'alert' })).toBe(1);
    expect(t.store.outbox.countSentSince(T0, { priority: 'P2' })).toBe(1);
    expect(t.store.outbox.countSentSince(at(7))).toBe(1);
    expect(t.store.outbox.recent(10).map((p) => p.id)).toContain(a);
  });

  it('folded pushes are terminal and excluded from due(); oldestPendingAt tracks stuck pushes', () => {
    const a = t.store.outbox.enqueue(push({ eventIds: ['a'] }), at(0)).id;
    const b = t.store.outbox.enqueue(push({ eventIds: ['b'] }), at(1)).id;
    expect(t.store.outbox.oldestPendingAt()).toBe(at(0).toISOString());
    t.store.outbox.markFolded(a);
    expect(t.store.outbox.due(at(10)).map((p) => p.id)).toEqual([b]);
    expect(t.store.outbox.oldestPendingAt()).toBe(at(1).toISOString());
  });
});
