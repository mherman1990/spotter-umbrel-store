/**
 * Time source seam. EVERY module that needs "now" takes a {@link Clock} (never `Date.now()` / `new Date()`
 * directly) so rules, the budget, the scheduler and the replay harness are deterministic under test.
 *
 * Long-running components (stream reconnect backoff, heartbeat staleness, poll timers, the scheduler, the
 * halts stale-trade timer, HTTP deadlines) also need TIMERS; they take a {@link Scheduler} so a test that
 * drives `FakeClock` moves "now" and every timer together (no `vi.useFakeTimers` drift between two clocks).
 *
 * @example
 * ```ts
 * const clock = new FakeClock('2026-12-03T14:00:00.000Z');
 * const cancel = clock.setTimeout(() => console.log('fired'), 30_000);
 * clock.advance(30_000); // fires the timer, now() is 14:00:30
 * ```
 */
import { ScoutError } from './errors.js';

export interface Clock {
  /** Current instant as a fresh `Date` (callers may mutate it). */
  now(): Date;
  /** Current instant as epoch milliseconds. */
  nowMs(): number;
}

/** Removes a previously registered timer. Idempotent. */
export type Cancel = () => void;

/**
 * `sleep(ms, signal)`: resolves after `ms`; REJECTS with `ScoutError('ABORTED')` as soon as `signal` aborts
 * (so a SIGTERM during a retry backoff or rate-limit wait does not stall shutdown).
 */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Timers behind an interface (decision: every long-running component injects this, never global timers). */
export interface Scheduler {
  setTimeout(fn: () => void, ms: number): Cancel;
  setInterval(fn: () => void, ms: number): Cancel;
  sleep: Sleep;
}

function abortedError(): ScoutError {
  return new ScoutError('ABORTED', 'Sleep aborted');
}

/** Real-time abortable sleep (the production {@link Sleep}). */
export const abortableSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortedError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortedError());
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Wall-clock implementation. Constructed once at the composition root and injected everywhere. */
export class SystemClock implements Clock, Scheduler {
  now(): Date {
    return new Date();
  }
  nowMs(): number {
    return Date.now();
  }
  setTimeout(fn: () => void, ms: number): Cancel {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  }
  setInterval(fn: () => void, ms: number): Cancel {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  }
  sleep: Sleep = abortableSleep;
}

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
  /** Repeat period for intervals. */
  every: number | null;
}

/**
 * Controllable clock + scheduler for tests and the replay harness. Time only moves when {@link advance} or
 * {@link set} is called, so a test can step through a trading day deterministically.
 *
 * Timers: {@link advance} fires every due timer IN ORDER, moving `now()` to each timer's instant first (a
 * 30 s interval advanced by 90 s fires three times, each seeing the right "now"). {@link set} jumps WITHOUT
 * firing timers (a replay day-jump must not fire a 30 s interval thousands of times); timers keep their
 * absolute due instants.
 */
export class FakeClock implements Clock, Scheduler {
  private ms: number;
  private timers: FakeTimer[] = [];
  private nextId = 1;

  /** @param start ISO string, `Date`, or epoch ms. Defaults to 2026-12-03T14:00:00Z (BBW Q3 FY26 print day, 09:00 ET). */
  constructor(start: string | Date | number = '2026-12-03T14:00:00.000Z') {
    this.ms = toMs(start);
  }

  now(): Date {
    return new Date(this.ms);
  }

  nowMs(): number {
    return this.ms;
  }

  /**
   * Move time forward by `ms` milliseconds (negative values are rejected: time never runs backwards),
   * firing due timers in order. A timer that throws propagates after time has been moved to its instant.
   */
  advance(ms: number): this {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('FakeClock.advance requires ms >= 0');
    const target = this.ms + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      this.ms = Math.max(this.ms, due.at);
      if (due.every === null) this.timers = this.timers.filter((t) => t.id !== due.id);
      else due.at += due.every;
      due.fn();
    }
    this.ms = target;
    return this;
  }

  /** Jump to an absolute instant (may move backwards; does NOT fire timers; use sparingly, e.g. a new replay day). */
  set(to: string | Date | number): this {
    this.ms = toMs(to);
    return this;
  }

  setTimeout(fn: () => void, ms: number): Cancel {
    const id = this.nextId++;
    this.timers.push({ id, at: this.ms + Math.max(0, ms), fn, every: null });
    return () => {
      this.timers = this.timers.filter((t) => t.id !== id);
    };
  }

  setInterval(fn: () => void, ms: number): Cancel {
    if (!(ms > 0)) throw new RangeError('FakeClock.setInterval requires ms > 0');
    const id = this.nextId++;
    this.timers.push({ id, at: this.ms + ms, fn, every: ms });
    return () => {
      this.timers = this.timers.filter((t) => t.id !== id);
    };
  }

  /** Number of timers currently registered (leak assertions in shutdown tests). */
  pendingTimers(): number {
    return this.timers.length;
  }

  /**
   * Auto-advancing sleep: moves this clock forward by `ms` (firing due timers) instead of waiting, and rejects
   * with `ABORTED` when `signal` is already aborted. Tests that need a sleep that really parks until time is
   * advanced use `setTimeout` directly.
   */
  sleep: Sleep = (ms, signal) => {
    if (signal?.aborted === true) return Promise.reject(abortedError());
    this.advance(Math.max(0, ms));
    return Promise.resolve();
  };

  /**
   * A `sleep(ms)` that advances this clock instead of waiting, for injection into rate limiters,
   * retry loops and anything else that would otherwise block a test.
   */
  sleeper(): Sleep {
    return this.sleep;
  }
}

function toMs(v: string | Date | number): number {
  const ms = typeof v === 'number' ? v : v instanceof Date ? v.getTime() : Date.parse(v);
  if (!Number.isFinite(ms)) throw new RangeError(`Invalid time: ${String(v)}`);
  return ms;
}
