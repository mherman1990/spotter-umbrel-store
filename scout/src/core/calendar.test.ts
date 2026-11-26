import { describe, expect, it } from 'vitest';
import {
  NotASessionError,
  NyseCalendar,
  addDays,
  daysBetween,
  easterSunday,
  isIsoDate,
  nyseEarlyCloses,
  nyseHolidays,
  weekday,
} from './calendar.js';

const cal = new NyseCalendar();
const z = (s: string): Date => new Date(s);

describe('NYSE holidays by rule (2026)', () => {
  it('matches the published 2026 full-day closures', () => {
    expect(nyseHolidays(2026)).toEqual([
      '2026-01-01', // New Year's Day (Thu)
      '2026-01-19', // MLK
      '2026-02-16', // Washington's Birthday
      '2026-04-03', // Good Friday
      '2026-05-25', // Memorial Day
      '2026-06-19', // Juneteenth (Fri)
      '2026-07-03', // Independence Day observed (Jul 4 is Saturday)
      '2026-09-07', // Labor Day
      '2026-11-26', // Thanksgiving
      '2026-12-25', // Christmas (Fri)
    ]);
  });

  it('2026-11-26 (Thanksgiving, today in the build) is closed; 2026-12-03 (BBW print day) is a session', () => {
    expect(cal.isHoliday('2026-11-26')).toBe(true);
    expect(cal.isSession('2026-11-26')).toBe(false);
    expect(cal.isSession('2026-12-03')).toBe(true);
    expect(weekday('2026-12-03')).toBe(4); // Thursday
  });

  it('weekend-observed rules: Saturday New Year is NOT observed; Sunday holidays move to Monday', () => {
    expect(nyseHolidays(2022)).not.toContain('2021-12-31');
    expect(nyseHolidays(2022)).not.toContain('2022-01-01');
    expect(nyseHolidays(2023)).toContain('2023-01-02'); // Jan 1 2023 is Sunday
    expect(nyseHolidays(2027)).toContain('2027-12-24'); // Dec 25 2027 is Saturday -> Friday
    expect(nyseHolidays(2021)).not.toContain('2021-06-18'); // Juneteenth not a holiday before 2022
  });

  it('Easter / Good Friday', () => {
    expect(easterSunday(2026)).toBe('2026-04-05');
    expect(easterSunday(2027)).toBe('2027-03-28');
    expect(nyseHolidays(2027)).toContain('2027-03-26');
  });
});

describe('early closes', () => {
  it('2026-11-27 (day after Thanksgiving) closes 13:00 ET = 18:00Z, and 2026-12-24 too', () => {
    expect(cal.isEarlyClose('2026-11-27')).toBe(true);
    expect(cal.sessionClose('2026-11-27').toISOString()).toBe('2026-11-27T18:00:00.000Z');
    expect(cal.sessionOpen('2026-11-27').toISOString()).toBe('2026-11-27T14:30:00.000Z');
    expect(cal.isEarlyClose('2026-12-24')).toBe(true);
    expect(cal.sessionClose('2026-12-24').toISOString()).toBe('2026-12-24T18:00:00.000Z');
  });

  it('normal days close 16:00 ET; July 3 2026 is a holiday so it is not an early close', () => {
    expect(cal.isEarlyClose('2026-12-03')).toBe(false);
    expect(cal.sessionClose('2026-12-03').toISOString()).toBe('2026-12-03T21:00:00.000Z');
    expect(cal.isEarlyClose('2026-07-03')).toBe(false);
    expect(nyseEarlyCloses(2026, new Set(nyseHolidays(2026)))).toEqual([
      '2026-11-27',
      '2026-12-24',
    ]);
  });

  it('July 3 is an early close when it is a regular weekday (2025, 2029)', () => {
    expect(cal.isEarlyClose('2025-07-03')).toBe(true);
    expect(cal.isEarlyClose('2029-07-03')).toBe(true);
  });
});

describe('sessions across DST', () => {
  it('open/close instants shift with the offset', () => {
    expect(cal.sessionOpen('2026-03-06').toISOString()).toBe('2026-03-06T14:30:00.000Z'); // EST
    expect(cal.sessionOpen('2026-03-09').toISOString()).toBe('2026-03-09T13:30:00.000Z'); // EDT
    expect(cal.sessionClose('2026-03-09').toISOString()).toBe('2026-03-09T20:00:00.000Z');
    expect(cal.sessionOpen('2026-10-30').toISOString()).toBe('2026-10-30T13:30:00.000Z');
    expect(cal.sessionOpen('2026-11-02').toISOString()).toBe('2026-11-02T14:30:00.000Z');
    expect(cal.sessionClose('2026-11-02').toISOString()).toBe('2026-11-02T21:00:00.000Z');
  });

  it('open/close throw NotASessionError on weekends and holidays', () => {
    expect(() => cal.sessionOpen('2026-12-05')).toThrow(NotASessionError);
    expect(() => cal.sessionClose('2026-11-26')).toThrow(NotASessionError);
  });
});

describe('nextSession / previousSession / sessionDates', () => {
  it('nextSession is the first session whose OPEN is strictly after the instant', () => {
    expect(cal.nextSession(z('2026-12-03T14:29:59Z'))).toBe('2026-12-03');
    expect(cal.nextSession(z('2026-12-03T14:30:00Z'))).toBe('2026-12-04');
    expect(cal.nextSession(z('2026-11-25T22:00:00Z'))).toBe('2026-11-27'); // skips Thanksgiving
    expect(cal.nextSession(z('2026-12-04T22:00:00Z'))).toBe('2026-12-07'); // skips the weekend
  });

  it('previousSession is the last session whose CLOSE is at/before the instant', () => {
    expect(cal.previousSession(z('2026-12-03T21:00:00Z'))).toBe('2026-12-03');
    expect(cal.previousSession(z('2026-12-03T20:59:59Z'))).toBe('2026-12-02');
    expect(cal.previousSession(z('2026-11-27T12:00:00Z'))).toBe('2026-11-25'); // before the 11/27 early close, Thanksgiving closed
    expect(cal.previousSession(z('2026-12-07T13:00:00Z'))).toBe('2026-12-04');
  });

  it('sessionDates excludes weekends and holidays', () => {
    expect(cal.sessionDates('2026-11-23', '2026-11-30')).toEqual([
      '2026-11-23',
      '2026-11-24',
      '2026-11-25',
      '2026-11-27',
      '2026-11-30',
    ]);
  });

  it('sessionFor returns the exchange date only on session days', () => {
    expect(cal.sessionFor(z('2026-12-03T14:00:00Z'))).toBe('2026-12-03');
    expect(cal.sessionFor(z('2026-12-04T03:00:00Z'))).toBe('2026-12-03'); // 22:00 ET Dec 3
    expect(cal.sessionFor(z('2026-11-26T15:00:00Z'))).toBeNull();
  });
});

describe('marketPhase', () => {
  it('premarket / regular / afterhours / closed on a normal day (EST)', () => {
    expect(cal.marketPhase(z('2026-12-03T08:59:00Z'))).toBe('closed'); // 03:59 ET
    expect(cal.marketPhase(z('2026-12-03T09:00:00Z'))).toBe('premarket'); // 04:00 ET
    expect(cal.marketPhase(z('2026-12-03T14:29:00Z'))).toBe('premarket');
    expect(cal.marketPhase(z('2026-12-03T14:30:00Z'))).toBe('regular');
    expect(cal.marketPhase(z('2026-12-03T20:59:00Z'))).toBe('regular');
    expect(cal.marketPhase(z('2026-12-03T21:00:00Z'))).toBe('afterhours');
    expect(cal.marketPhase(z('2026-12-04T00:59:00Z'))).toBe('afterhours'); // 19:59 ET
    expect(cal.marketPhase(z('2026-12-04T01:00:00Z'))).toBe('closed'); // 20:00 ET
  });

  it('early-close day ends the regular session at 13:00 ET and shortens after-hours', () => {
    expect(cal.marketPhase(z('2026-11-27T17:59:00Z'))).toBe('regular');
    expect(cal.marketPhase(z('2026-11-27T18:00:00Z'))).toBe('afterhours');
    expect(cal.marketPhase(z('2026-11-27T21:59:00Z'))).toBe('afterhours'); // 16:59 ET
    expect(cal.marketPhase(z('2026-11-27T22:00:00Z'))).toBe('closed'); // 17:00 ET
  });

  it('weekends and holidays are closed all day; DST days still open at 09:30 ET', () => {
    expect(cal.marketPhase(z('2026-12-05T15:00:00Z'))).toBe('closed');
    expect(cal.marketPhase(z('2026-11-26T15:00:00Z'))).toBe('closed');
    expect(cal.marketPhase(z('2026-03-09T13:29:00Z'))).toBe('premarket'); // 09:29 EDT
    expect(cal.marketPhase(z('2026-03-09T13:30:00Z'))).toBe('regular');
    expect(cal.marketPhase(z('2026-11-02T14:30:00Z'))).toBe('regular'); // 09:30 EST
  });
});

describe('date helpers and ranges', () => {
  it('addDays / weekday / daysBetween / isIsoDate', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-12-03', '2026-12-10')).toBe(7);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-12-03')).toBe(true);
    expect(isIsoDate('12/03/2026')).toBe(false);
    expect(() => addDays('bad', 1)).toThrow(RangeError);
  });

  it('malformed-but-well-shaped dates THROW instead of rolling over (2026-02-30 is not March 2)', () => {
    expect(() => weekday('2026-02-30')).toThrow(RangeError);
    expect(() => cal.isSession('2026-02-30')).toThrow(RangeError);
    expect(() => cal.isSession('2026-13-45')).toThrow(RangeError);
    expect(() => addDays('2026-02-29', 1)).toThrow(RangeError);
    expect(() => daysBetween('2026-04-31', '2026-05-01')).toThrow(RangeError);
    expect(weekday('2026-02-28')).toBe(6);
  });

  it('rejects years outside 2000-2100 and honors extra ad-hoc closures', () => {
    expect(() => cal.isSession('1999-12-31')).toThrow(RangeError);
    expect(() => cal.isSession('2101-01-04')).toThrow(RangeError);
    const closed = new NyseCalendar({ adHocClosures: ['2026-12-03'] });
    expect(closed.isSession('2026-12-03')).toBe(false);
    expect(closed.isHoliday('2026-12-03')).toBe(true);
    expect(cal.isSession('2025-01-09')).toBe(false); // baked-in day of mourning
  });

  it('schedule() lists rule-derived holidays and early closes', () => {
    const s = cal.schedule(2026);
    expect(s.holidays).toContain('2026-11-26');
    expect(s.earlyCloses).toEqual(['2026-11-27', '2026-12-24']);
  });
});
