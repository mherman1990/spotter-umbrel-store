/**
 * NYSE (MIC XNYS) session calendar, computed BY RULE for 2000-2100 (no data file).
 *
 * Adapted from BlackGold packages/core/src/calendar/nyse.ts (MIT, Copyright (c) 2026 Matt Herman).
 * Changes: Date-based API (BlackGold used branded UtcInstant/IsoDate strings and its own tz helpers);
 * removed the shared-package imports; added `marketPhase()`, `sessionFor()`, and extended-hours bounds.
 *
 * Holiday rules: New Year's (Saturday NOT observed), MLK, Washington's Birthday, Good Friday, Memorial,
 * Juneteenth (2022+), Independence Day, Labor, Thanksgiving, Christmas (weekend -> observed weekday).
 * Early closes (13:00 ET): day after Thanksgiving; July 3 and Dec 24 when each is a weekday session.
 * Unscheduled closures cannot be derived by rule; known historical ones are in {@link NYSE_ADHOC_CLOSURES}
 * and owners can add more via the constructor.
 *
 * UNVERIFIED: the early-close extended-hours end (17:00 ET) used by {@link NyseCalendar.marketPhase} and the
 * 04:00 ET pre-market start are conventions, not exchange-published facts; they only affect the
 * `premarket`/`afterhours` vs `closed` label, never session open/close times.
 */
import type { MarketPhase } from '../types.js';
import {
  EXCHANGE_TZ,
  fractionOfSessionElapsed,
  localDate,
  minutesSinceOpen,
  zonedParts,
  zonedToUtc,
} from './time.js';

/** `YYYY-MM-DD` calendar date string (no time zone; the exchange's local date). */
export type IsoDate = string;

const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/** Regular-session open, exchange time. */
export const SESSION_OPEN_HM: readonly [number, number] = [9, 30];
/** Regular-session close on a normal day, exchange time. */
export const SESSION_CLOSE_HM: readonly [number, number] = [16, 0];
/** Regular-session close on an early-close day, exchange time. */
export const EARLY_CLOSE_HM: readonly [number, number] = [13, 0];
/** Pre-market window start, exchange time (convention; UNVERIFIED). */
export const PREMARKET_START_HM: readonly [number, number] = [4, 0];
/** After-hours window end on normal days, exchange time. */
export const AFTERHOURS_END_HM: readonly [number, number] = [20, 0];
/** After-hours window end on early-close days, exchange time (UNVERIFIED). */
export const AFTERHOURS_END_EARLY_HM: readonly [number, number] = [17, 0];

/** Thrown when a session-only operation (open/close) is asked of a non-session date. */
export class NotASessionError extends RangeError {
  constructor(readonly date: IsoDate) {
    super(`${date} is not an NYSE trading session`);
    this.name = 'NotASessionError';
  }
}

/**
 * Full-day NYSE closures that no rule derives (national days of mourning, disasters). Every entry is a
 * weekday. Extend as new closures are announced.
 */
export const NYSE_ADHOC_CLOSURES: readonly IsoDate[] = [
  '2001-09-11',
  '2001-09-12',
  '2001-09-13',
  '2001-09-14',
  '2004-06-11', // National Day of Mourning, Ronald Reagan
  '2007-01-02', // National Day of Mourning, Gerald Ford
  '2012-10-29', // Hurricane Sandy
  '2012-10-30',
  '2018-12-05', // National Day of Mourning, George H. W. Bush
  '2025-01-09', // National Day of Mourning, Jimmy Carter
];

export interface NyseCalendarOptions {
  /** Additional ad-hoc closures, merged on top of {@link NYSE_ADHOC_CLOSURES}. */
  adHocClosures?: readonly IsoDate[];
}

export interface HolidaySchedule {
  holidays: IsoDate[];
  earlyCloses: IsoDate[];
}

interface YearSchedule {
  holidays: Set<string>;
  earlyCloses: Set<string>;
}

/**
 * The exchange calendar. Stateless apart from a per-year cache; construct one at the composition root.
 *
 * @example
 * ```ts
 * const cal = new NyseCalendar();
 * cal.isEarlyClose('2026-11-27');                // true (day after Thanksgiving)
 * cal.sessionClose('2026-11-27').toISOString();  // '2026-11-27T18:00:00.000Z' (13:00 EST)
 * cal.marketPhase(new Date('2026-12-03T14:35:00Z')); // 'regular' (09:35 ET; 09:05 ET would be 'premarket')
 * ```
 */
export class NyseCalendar {
  readonly exchange = 'XNYS';
  readonly timeZone = EXCHANGE_TZ;
  private readonly adHoc: ReadonlySet<string>;
  private readonly cache = new Map<number, YearSchedule>();

  constructor(options: NyseCalendarOptions = {}) {
    this.adHoc = new Set<string>([...NYSE_ADHOC_CLOSURES, ...(options.adHocClosures ?? [])]);
  }

  /** True when the exchange holds a regular session on `date` (weekday, not a holiday/ad-hoc closure). */
  isSession(date: IsoDate): boolean {
    const wd = weekday(date);
    if (wd === 0 || wd === 6) return false;
    if (this.adHoc.has(date)) return false;
    return !this.yearSchedule(yearOf(date)).holidays.has(date);
  }

  /** True for a weekday holiday or ad-hoc closure (weekends are not "holidays", just non-sessions). */
  isHoliday(date: IsoDate): boolean {
    return this.yearSchedule(yearOf(date)).holidays.has(date) || this.adHoc.has(date);
  }

  /** True when `date` is a session that closes early (13:00 ET). */
  isEarlyClose(date: IsoDate): boolean {
    return this.isSession(date) && this.yearSchedule(yearOf(date)).earlyCloses.has(date);
  }

  /** Regular-session open as an instant. @throws NotASessionError */
  sessionOpen(date: IsoDate): Date {
    this.assertSession(date);
    return zonedToUtc(date, SESSION_OPEN_HM[0], SESSION_OPEN_HM[1], EXCHANGE_TZ);
  }

  /** Regular-session close as an instant (13:00 ET on early-close days). @throws NotASessionError */
  sessionClose(date: IsoDate): Date {
    this.assertSession(date);
    const [h, m] = this.isEarlyClose(date) ? EARLY_CLOSE_HM : SESSION_CLOSE_HM;
    return zonedToUtc(date, h, m, EXCHANGE_TZ);
  }

  /** The first session whose OPEN is strictly after `after`. */
  nextSession(after: Date): IsoDate {
    let d = localDate(after, EXCHANGE_TZ);
    for (let i = 0; i < 30; i++) {
      if (this.isSession(d) && this.sessionOpen(d).getTime() > after.getTime()) return d;
      d = addDays(d, 1);
    }
    throw new RangeError(`No session found within 30 days after ${after.toISOString()}`);
  }

  /** The last session whose CLOSE is at or before `before`. */
  previousSession(before: Date): IsoDate {
    let d = localDate(before, EXCHANGE_TZ);
    for (let i = 0; i < 30; i++) {
      if (this.isSession(d) && this.sessionClose(d).getTime() <= before.getTime()) return d;
      d = addDays(d, -1);
    }
    throw new RangeError(`No session found within 30 days before ${before.toISOString()}`);
  }

  /** All sessions in `[from, to]` inclusive, ascending. */
  sessionDates(from: IsoDate, to: IsoDate): IsoDate[] {
    const out: IsoDate[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) if (this.isSession(d)) out.push(d);
    return out;
  }

  /**
   * The exchange date of `now` if it is a session day, else `null`. Use for "trading date" keys
   * (an event at 18:00 ET on a session day still belongs to that session's date).
   */
  sessionFor(now: Date): IsoDate | null {
    const d = localDate(now, EXCHANGE_TZ);
    return this.isSession(d) ? d : null;
  }

  /**
   * Market phase at `now`: `premarket` (04:00 ET -> open), `regular` (open -> close), `afterhours`
   * (close -> 20:00 ET, or 17:00 ET on early-close days), else `closed`. Non-session days are always `closed`.
   * `open` is inclusive, `close` exclusive.
   */
  marketPhase(now: Date): MarketPhase {
    const date = this.sessionFor(now);
    if (date === null) return 'closed';
    const t = now.getTime();
    const open = this.sessionOpen(date).getTime();
    const close = this.sessionClose(date).getTime();
    const early = this.isEarlyClose(date);
    const pre = zonedToUtc(
      date,
      PREMARKET_START_HM[0],
      PREMARKET_START_HM[1],
      EXCHANGE_TZ,
    ).getTime();
    const [eh, em] = early ? AFTERHOURS_END_EARLY_HM : AFTERHOURS_END_HM;
    const post = zonedToUtc(date, eh, em, EXCHANGE_TZ).getTime();
    if (t >= open && t < close) return 'regular';
    if (t >= pre && t < open) return 'premarket';
    if (t >= close && t < post) return 'afterhours';
    return 'closed';
  }

  /** Minutes since this session's open (null on non-session days); see `minutesSinceOpen`. */
  minutesSinceOpen(now: Date): number | null {
    return minutesSinceOpen(now, this);
  }

  /** Fraction (0..1) of the regular session elapsed; see `fractionOfSessionElapsed`. */
  fractionOfSessionElapsed(now: Date): number {
    return fractionOfSessionElapsed(now, this);
  }

  /** Rule-derived schedule for a year (ad-hoc closures excluded). Sorted ascending. */
  schedule(year: number): HolidaySchedule {
    const s = this.yearSchedule(year);
    return { holidays: [...s.holidays].sort(), earlyCloses: [...s.earlyCloses].sort() };
  }

  private assertSession(date: IsoDate): void {
    if (!this.isSession(date)) throw new NotASessionError(date);
  }

  private yearSchedule(year: number): YearSchedule {
    if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
      throw new RangeError(`NyseCalendar supports ${MIN_YEAR}-${MAX_YEAR}; got ${year}`);
    }
    const cached = this.cache.get(year);
    if (cached) return cached;
    const holidays = new Set<string>(nyseHolidays(year));
    const earlyCloses = new Set<string>(nyseEarlyCloses(year, holidays));
    const built = { holidays, earlyCloses };
    this.cache.set(year, built);
    return built;
  }
}

// ---------------------------------------------------------------------------------------------
// Date arithmetic on `YYYY-MM-DD` strings (UTC math; no DST involvement)
// ---------------------------------------------------------------------------------------------

function yearOf(date: IsoDate): number {
  return Number(date.slice(0, 4));
}

/** Parse `YYYY-MM-DD` to UTC midnight ms. Round-trip validated: `2026-02-30` or `2026-13-45` THROW instead of rolling over. */
function parseIso(date: IsoDate): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new RangeError(`Invalid ISO date: ${date}`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (fromUtcMs(ms) !== date) throw new RangeError(`Invalid ISO date: ${date}`);
  return ms;
}

function fromUtcMs(ms: number): IsoDate {
  const d = new Date(ms);
  return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** `date` plus `n` calendar days (negative allowed). */
export function addDays(date: IsoDate, n: number): IsoDate {
  return fromUtcMs(parseIso(date) + n * 86_400_000);
}

/** Day of week of a calendar date: 0 = Sunday ... 6 = Saturday. */
export function weekday(date: IsoDate): number {
  return new Date(parseIso(date)).getUTCDay();
}

/** True for a well-formed `YYYY-MM-DD` that is a real calendar date. */
export function isIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return fromUtcMs(d.getTime()) === value;
}

/** Whole calendar days from `from` to `to` (to - from). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((parseIso(to) - parseIso(from)) / 86_400_000);
}

/** Wall-clock parts of `now` in the exchange zone (re-exported convenience for session math). */
export function exchangeParts(now: Date): ReturnType<typeof zonedParts> {
  return zonedParts(now, EXCHANGE_TZ);
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function ymd(year: number, month: number, day: number): IsoDate {
  return `${year.toString().padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

/** Nth (1-based) given weekday (0=Sun..6=Sat) of a month. */
function nthWeekdayOfMonth(year: number, month: number, wd: number, n: number): IsoDate {
  const first = ymd(year, month, 1);
  const offset = (wd - weekday(first) + 7) % 7;
  return addDays(first, offset + (n - 1) * 7);
}

function lastWeekdayOfMonth(year: number, month: number, wd: number): IsoDate {
  const nextFirst = month === 12 ? ymd(year + 1, 1, 1) : ymd(year, month + 1, 1);
  const last = addDays(nextFirst, -1);
  const back = (weekday(last) - wd + 7) % 7;
  return addDays(last, -back);
}

/** Saturday -> preceding Friday; Sunday -> following Monday; otherwise the date itself. */
function observed(date: IsoDate): IsoDate {
  const wd = weekday(date);
  if (wd === 6) return addDays(date, -1);
  if (wd === 0) return addDays(date, 1);
  return date;
}

/** Gregorian Easter Sunday (Anonymous/Meeus algorithm). */
export function easterSunday(year: number): IsoDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(year, month, day);
}

/** Full-day NYSE holidays for a year (weekdays only; weekend-observed rules applied). Sorted. */
export function nyseHolidays(year: number): IsoDate[] {
  const out: IsoDate[] = [];
  // New Year's Day: Sunday -> Monday Jan 2; Saturday -> NOT observed (NYSE does not close Dec 31).
  const jan1 = ymd(year, 1, 1);
  if (weekday(jan1) === 0) out.push(addDays(jan1, 1));
  else if (weekday(jan1) !== 6) out.push(jan1);
  out.push(nthWeekdayOfMonth(year, 1, 1, 3)); // Martin Luther King Jr. Day
  out.push(nthWeekdayOfMonth(year, 2, 1, 3)); // Washington's Birthday
  out.push(addDays(easterSunday(year), -2)); // Good Friday
  out.push(lastWeekdayOfMonth(year, 5, 1)); // Memorial Day
  if (year >= 2022) out.push(observed(ymd(year, 6, 19))); // Juneteenth
  out.push(observed(ymd(year, 7, 4))); // Independence Day
  out.push(nthWeekdayOfMonth(year, 9, 1, 1)); // Labor Day
  out.push(nthWeekdayOfMonth(year, 11, 4, 4)); // Thanksgiving
  out.push(observed(ymd(year, 12, 25))); // Christmas
  return out.sort();
}

/** 13:00 ET early closes: day after Thanksgiving; July 3 and December 24 when a weekday and not a holiday. */
export function nyseEarlyCloses(year: number, holidays: ReadonlySet<string>): IsoDate[] {
  const out: IsoDate[] = [];
  out.push(addDays(nthWeekdayOfMonth(year, 11, 4, 4), 1));
  for (const candidate of [ymd(year, 7, 3), ymd(year, 12, 24)]) {
    const wd = weekday(candidate);
    if (wd !== 0 && wd !== 6 && !holidays.has(candidate)) out.push(candidate);
  }
  return out.sort();
}
