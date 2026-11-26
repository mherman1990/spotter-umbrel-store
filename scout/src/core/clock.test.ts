import { describe, expect, it } from 'vitest';
import { FakeClock, SystemClock, abortableSleep } from './clock.js';

describe('clocks', () => {
  it('SystemClock returns the current time', () => {
    const before = Date.now();
    const c = new SystemClock();
    expect(c.nowMs()).toBeGreaterThanOrEqual(before);
    expect(c.now()).toBeInstanceOf(Date);
  });

  it('FakeClock starts where told and only moves when advanced', () => {
    const c = new FakeClock('2026-12-03T14:00:00.000Z');
    expect(c.now().toISOString()).toBe('2026-12-03T14:00:00.000Z');
    c.advance(30_000);
    expect(c.now().toISOString()).toBe('2026-12-03T14:00:30.000Z');
    expect(c.nowMs()).toBe(Date.parse('2026-12-03T14:00:30.000Z'));
  });

  it('FakeClock.now returns a fresh Date each time (callers may mutate it)', () => {
    const c = new FakeClock(0);
    const a = c.now();
    a.setTime(999);
    expect(c.nowMs()).toBe(0);
  });

  it('FakeClock rejects negative advance and invalid starts', () => {
    expect(() => new FakeClock(0).advance(-1)).toThrow(RangeError);
    expect(() => new FakeClock('not a date')).toThrow(RangeError);
  });

  it('set() jumps (including backwards) and accepts Date/number/string', () => {
    const c = new FakeClock(1000);
    c.set(new Date(5)).set(7);
    expect(c.nowMs()).toBe(7);
    c.set('2026-01-01T00:00:00Z');
    expect(c.now().getUTCFullYear()).toBe(2026);
  });

  it('sleeper() advances the clock instead of waiting', async () => {
    const c = new FakeClock(0);
    const sleep = c.sleeper();
    await sleep(250);
    await sleep(-5); // clamped to 0
    expect(c.nowMs()).toBe(250);
  });
});

describe('Scheduler seam', () => {
  it('FakeClock timers fire in order with now() set to each due instant', () => {
    const c = new FakeClock(0);
    const seen: [string, number][] = [];
    c.setTimeout(() => seen.push(['b', c.nowMs()]), 200);
    c.setTimeout(() => seen.push(['a', c.nowMs()]), 100);
    const cancelled = c.setTimeout(() => seen.push(['never', c.nowMs()]), 150);
    cancelled();
    cancelled(); // idempotent
    c.advance(250);
    expect(seen).toEqual([
      ['a', 100],
      ['b', 200],
    ]);
    expect(c.nowMs()).toBe(250);
    expect(c.pendingTimers()).toBe(0);
  });

  it('intervals repeat per period within one advance and can be cancelled from outside', () => {
    const c = new FakeClock(0);
    const ticks: number[] = [];
    const stop = c.setInterval(() => ticks.push(c.nowMs()), 30_000);
    c.advance(95_000);
    expect(ticks).toEqual([30_000, 60_000, 90_000]);
    stop();
    c.advance(60_000);
    expect(ticks).toHaveLength(3);
    expect(() => c.setInterval(() => undefined, 0)).toThrow(RangeError);
  });

  it('a timer scheduled by a timer fires in the same advance when due', () => {
    const c = new FakeClock(0);
    const seen: number[] = [];
    c.setTimeout(() => {
      seen.push(c.nowMs());
      c.setTimeout(() => seen.push(c.nowMs()), 10);
    }, 10);
    c.advance(100);
    expect(seen).toEqual([10, 20]);
  });

  it('set() jumps without firing timers (a replay day-jump must not fire intervals thousands of times)', () => {
    const c = new FakeClock(0);
    let n = 0;
    c.setInterval(() => n++, 1000);
    c.set(86_400_000);
    expect(n).toBe(0);
    expect(c.pendingTimers()).toBe(1);
  });

  it('sleep rejects ABORTED for an already-aborted signal; abortableSleep honors a mid-sleep abort', async () => {
    const c = new FakeClock(0);
    const ac = new AbortController();
    ac.abort();
    await expect(c.sleep(10, ac.signal)).rejects.toMatchObject({ code: 'ABORTED' });
    const live = new AbortController();
    const p = abortableSleep(60_000, live.signal);
    live.abort();
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(abortableSleep(1)).resolves.toBeUndefined();
    await expect(abortableSleep(1, live.signal)).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('SystemClock implements the scheduler with real timers', async () => {
    const c = new SystemClock();
    await new Promise<void>((resolve) => c.setTimeout(resolve, 1));
    let n = 0;
    const stop = c.setInterval(() => n++, 1);
    await c.sleep(15);
    stop();
    expect(n).toBeGreaterThan(0);
  });
});
