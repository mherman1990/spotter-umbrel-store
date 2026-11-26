/**
 * Time-zone helpers built on `Intl` only (no tz library). All functions are DST-correct because every
 * conversion goes through `Intl.DateTimeFormat#formatToParts` for the target zone rather than fixed offsets.
 *
 * Two zones matter (decision D23):
 *  - `America/New_York` ("exchange" time): market logic, session open/close, Event.ts offsets.
 *  - `America/Chicago` (owner time): schedules, quiet hours, "day" keys for counters and LLM spend.
 */
import type { IsoDate } from './calendar.js';

export const EXCHANGE_TZ = 'America/New_York';
export const OWNER_TZ = 'America/Chicago';

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  /** 0 = Sunday ... 6 = Saturday, in the target zone. */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock components of an instant in `tz`. */
export function zonedParts(date: Date, tz: string = EXCHANGE_TZ): ZonedParts {
  if (Number.isNaN(date.getTime())) throw new RangeError('Invalid Date');
  const parts = formatter(tz).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(get('hour'));
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: hour === 24 ? 0 : hour,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

/** Offset of `tz` from UTC at `date`, in minutes (EST = -300, EDT = -240). */
export function tzOffsetMinutes(date: Date, tz: string = EXCHANGE_TZ): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // `date` has millisecond precision; zonedParts truncates to seconds.
  const truncated = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - truncated) / 60_000);
}

const pad2 = (n: number): string => n.toString().padStart(2, '0');

/** `YYYY-MM-DD` of an instant in `tz`. */
export function localDate(date: Date, tz: string = EXCHANGE_TZ): IsoDate {
  const p = zonedParts(date, tz);
  return `${p.year.toString().padStart(4, '0')}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** `HH:mm` of an instant in `tz`. */
export function localTime(date: Date, tz: string = EXCHANGE_TZ): string {
  const p = zonedParts(date, tz);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** Exchange (America/New_York) calendar date of an instant. Use for trading-date keys. */
export const exchangeDate = (date: Date): IsoDate => localDate(date, EXCHANGE_TZ);
/** Owner (America/Chicago) calendar date of an instant. Use for daily counters, spend "day", quiet-hours days. */
export const chicagoDate = (date: Date): IsoDate => localDate(date, OWNER_TZ);
/** Exchange wall-clock `HH:mm`. */
export const exchangeTime = (date: Date): string => localTime(date, EXCHANGE_TZ);
/** Owner wall-clock `HH:mm`. */
export const chicagoTime = (date: Date): string => localTime(date, OWNER_TZ);

/**
 * Convert a wall-clock time in `tz` to the UTC instant. DST-aware: at a spring-forward gap the wall time
 * (which never occurs) resolves forward by the gap length (02:30 -> 03:30); at a fall-back overlap the FIRST
 * (daylight-time) occurrence is returned.
 */
export function zonedToUtc(
  date: IsoDate,
  hour: number,
  minute: number,
  tz: string = EXCHANGE_TZ,
  second = 0,
): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new RangeError(`Invalid ISO date: ${date}`);
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, minute, second);
  // Try the offsets in effect a day either side; keep the one that round-trips. This handles both DST edges.
  const candidates = new Set<number>();
  for (const probe of [naive - 86_400_000, naive, naive + 86_400_000]) {
    candidates.add(tzOffsetMinutes(new Date(probe), tz));
  }
  const matches: number[] = [];
  for (const off of candidates) {
    const utc = naive - off * 60_000;
    if (tzOffsetMinutes(new Date(utc), tz) === off) matches.push(utc);
  }
  if (matches.length > 0) return new Date(Math.min(...matches));
  // Spring-forward gap: no offset round-trips. Use the pre-gap (smaller UTC offset magnitude) interpretation.
  const before = tzOffsetMinutes(new Date(naive - 86_400_000), tz);
  return new Date(naive - before * 60_000);
}

/** `-05:00` / `-04:00` style offset string for `tz` at `date`. */
export function formatOffset(date: Date, tz: string = EXCHANGE_TZ): string {
  const off = tzOffsetMinutes(date, tz);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/**
 * ISO-8601 with the America/New_York offset, e.g. `2026-12-03T08:00:05.123-05:00` (Event.ts format, D23).
 * Round-trips: `Date.parse(toExchangeIso(d)) === d.getTime()`.
 */
export function toExchangeIso(date: Date): string {
  return toZonedIso(date, EXCHANGE_TZ);
}

/** ISO-8601 with `tz`'s offset and millisecond precision. */
export function toZonedIso(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  const ms = ((date.getTime() % 1000) + 1000) % 1000;
  return (
    `${p.year.toString().padStart(4, '0')}-${pad2(p.month)}-${pad2(p.day)}` +
    `T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}.${ms.toString().padStart(3, '0')}` +
    formatOffset(date, tz)
  );
}

/** Parse `HH:mm` to minutes after midnight. Throws on malformed input. */
export function parseHm(hm: string): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hm.trim());
  if (!m) throw new RangeError(`Invalid HH:mm time: ${hm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * True when `now` falls inside the quiet window in `tz`. The window may wrap midnight
 * (default 21:00 -> 06:30 America/Chicago, spec section 6). Start is inclusive, end exclusive.
 * Exceptions (8-K Item 2.02, halts) are applied by the budget, not here.
 *
 * @example
 * ```ts
 * isQuietHours(new Date('2026-12-03T11:00:00Z')); // 05:00 CT -> true
 * ```
 */
export function isQuietHours(
  now: Date,
  quietStart = '21:00',
  quietEnd = '06:30',
  tz: string = OWNER_TZ,
): boolean {
  const start = parseHm(quietStart);
  const end = parseHm(quietEnd);
  const p = zonedParts(now, tz);
  const minutes = p.hour * 60 + p.minute;
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/**
 * The instant the quiet window containing `now` ENDS (`end` wall-clock in `tz`, DST-correct), or a copy of `now`
 * when it is not inside the window. This is what a non-urgent ops alert raised during quiet hours uses as its
 * `next_attempt_at` ("deferred to quiet end, never dropped"); do not hand-roll it (DST).
 *
 * @example
 * nextQuietEnd(new Date('2026-12-04T04:00:00Z')) // 22:00 CT Dec 3 -> 2026-12-04T12:30:00Z (06:30 CT)
 */
export function nextQuietEnd(
  now: Date,
  quietStart = '21:00',
  quietEnd = '06:30',
  tz: string = OWNER_TZ,
): Date {
  if (!isQuietHours(now, quietStart, quietEnd, tz)) return new Date(now.getTime());
  const endMinutes = parseHm(quietEnd);
  const [h, m] = [Math.floor(endMinutes / 60), endMinutes % 60];
  const today = localDate(now, tz);
  const first = zonedToUtc(today, h, m, tz);
  if (first.getTime() > now.getTime()) return first;
  return zonedToUtc(shiftIsoDate(today, 1), h, m, tz);
}

/** `date` plus `n` calendar days (pure UTC date math; no DST involvement). */
function shiftIsoDate(date: IsoDate, n: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** True when `tz` is a valid IANA time-zone identifier (config validation: a typo must fail at load, not at 3 am). */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The slice of an exchange calendar that session-fraction math needs (`NyseCalendar` satisfies it). */
export interface SessionBounds {
  /** Exchange date of `now` when it is a session day, else null. */
  sessionFor(now: Date): IsoDate | null;
  sessionOpen(date: IsoDate): Date;
  sessionClose(date: IsoDate): Date;
}

/**
 * Minutes elapsed since the regular-session open on `now`'s exchange date; `null` when that date is not a
 * session. Negative before the open, larger than the session length after the close (callers clamp).
 */
export function minutesSinceOpen(now: Date, calendar: SessionBounds): number | null {
  const date = calendar.sessionFor(now);
  if (date === null) return null;
  return (now.getTime() - calendar.sessionOpen(date).getTime()) / 60_000;
}

/**
 * Fraction (0..1) of the regular session elapsed at `now`: 0 before the open or on non-session days, 1 at/after
 * the close. Early-close days (13:00 ET) use their shorter length.
 */
export function fractionOfSessionElapsed(now: Date, calendar: SessionBounds): number {
  const date = calendar.sessionFor(now);
  if (date === null) return 0;
  const open = calendar.sessionOpen(date).getTime();
  const close = calendar.sessionClose(date).getTime();
  const f = (now.getTime() - open) / (close - open);
  return Math.min(1, Math.max(0, f));
}
