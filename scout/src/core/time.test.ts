import { describe, expect, it } from 'vitest';
import { NyseCalendar } from './calendar.js';
import {
  chicagoDate,
  chicagoTime,
  exchangeDate,
  exchangeTime,
  fractionOfSessionElapsed,
  isQuietHours,
  isValidTimeZone,
  localDate,
  minutesSinceOpen,
  nextQuietEnd,
  parseHm,
  toExchangeIso,
  toZonedIso,
  tzOffsetMinutes,
  zonedParts,
  zonedToUtc,
} from './time.js';

const z = (s: string): Date => new Date(s);

describe('tz offsets across DST (America/New_York, 2026)', () => {
  it('spring forward: Sun 2026-03-08 at 07:00Z (02:00 EST -> 03:00 EDT)', () => {
    expect(tzOffsetMinutes(z('2026-03-07T12:00:00Z'))).toBe(-300);
    expect(tzOffsetMinutes(z('2026-03-08T06:59:59Z'))).toBe(-300);
    expect(tzOffsetMinutes(z('2026-03-08T07:00:00Z'))).toBe(-240);
    expect(tzOffsetMinutes(z('2026-03-09T12:00:00Z'))).toBe(-240);
  });

  it('fall back: Sun 2026-11-01 at 06:00Z (02:00 EDT -> 01:00 EST)', () => {
    expect(tzOffsetMinutes(z('2026-10-31T12:00:00Z'))).toBe(-240);
    expect(tzOffsetMinutes(z('2026-11-01T05:59:59Z'))).toBe(-240);
    expect(tzOffsetMinutes(z('2026-11-01T06:00:00Z'))).toBe(-300);
    expect(tzOffsetMinutes(z('2026-11-02T12:00:00Z'))).toBe(-300);
  });

  it('Chicago changes at different UTC instants than New York (2h gap window on 2026-03-08)', () => {
    const t = z('2026-03-08T07:30:00Z');
    expect(tzOffsetMinutes(t, 'America/New_York')).toBe(-240);
    expect(tzOffsetMinutes(t, 'America/Chicago')).toBe(-360);
    expect(tzOffsetMinutes(z('2026-12-03T12:00:00Z'), 'America/Chicago')).toBe(-360);
    expect(tzOffsetMinutes(z('2026-07-01T12:00:00Z'), 'America/Chicago')).toBe(-300);
  });
});

describe('zonedToUtc', () => {
  it('converts ordinary times on both sides of each transition', () => {
    expect(zonedToUtc('2026-03-06', 9, 30).toISOString()).toBe('2026-03-06T14:30:00.000Z');
    expect(zonedToUtc('2026-03-09', 9, 30).toISOString()).toBe('2026-03-09T13:30:00.000Z');
    expect(zonedToUtc('2026-10-30', 9, 30).toISOString()).toBe('2026-10-30T13:30:00.000Z');
    expect(zonedToUtc('2026-11-02', 9, 30).toISOString()).toBe('2026-11-02T14:30:00.000Z');
  });

  it('handles the transition days themselves (open at 09:30 is after the 02:00 change)', () => {
    expect(zonedToUtc('2026-03-08', 9, 30).toISOString()).toBe('2026-03-08T13:30:00.000Z');
    expect(zonedToUtc('2026-11-01', 9, 30).toISOString()).toBe('2026-11-01T14:30:00.000Z');
  });

  it('spring-forward gap resolves forward (02:30 does not exist -> 03:30 EDT)', () => {
    expect(zonedToUtc('2026-03-08', 2, 30).toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('fall-back overlap resolves to the first (daylight) occurrence', () => {
    expect(zonedToUtc('2026-11-01', 1, 30).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('works for Chicago and rejects malformed dates', () => {
    expect(zonedToUtc('2026-12-03', 5, 0, 'America/Chicago').toISOString()).toBe(
      '2026-12-03T11:00:00.000Z',
    );
    expect(() => zonedToUtc('2026-13-99x', 1, 0)).toThrow(RangeError);
  });

  it('round-trips with zonedParts for every hour around both transitions', () => {
    for (const day of [
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]) {
      for (let h = 0; h < 24; h++) {
        if (day === '2026-03-08' && h === 2) continue; // nonexistent wall time
        const utc = zonedToUtc(day, h, 15);
        const p = zonedParts(utc);
        expect([p.hour, p.minute]).toEqual([h, 15]);
        expect(localDate(utc)).toBe(day);
      }
    }
  });
});

describe('toExchangeIso', () => {
  it('formats winter (EST) and summer (EDT) offsets with milliseconds', () => {
    expect(toExchangeIso(z('2026-12-03T13:00:05.123Z'))).toBe('2026-12-03T08:00:05.123-05:00');
    expect(toExchangeIso(z('2026-07-01T13:30:00.000Z'))).toBe('2026-07-01T09:30:00.000-04:00');
  });

  it('round-trips through Date.parse (including across transitions)', () => {
    for (const s of [
      '2026-03-08T06:59:59.999Z',
      '2026-03-08T07:00:00.000Z',
      '2026-11-01T05:59:59.999Z',
      '2026-11-01T06:00:00.000Z',
      '2026-12-03T14:00:00.000Z',
    ]) {
      expect(Date.parse(toExchangeIso(z(s)))).toBe(Date.parse(s));
    }
  });

  it('toZonedIso supports other zones', () => {
    expect(toZonedIso(z('2026-12-03T11:00:00.000Z'), 'America/Chicago')).toBe(
      '2026-12-03T05:00:00.000-06:00',
    );
  });

  it('rejects invalid dates', () => {
    expect(() => toExchangeIso(new Date('x'))).toThrow(RangeError);
  });
});

describe('local dates and times', () => {
  it('date and time differ between exchange and owner zones late in the evening', () => {
    const t = z('2026-12-04T04:30:00Z'); // 23:30 ET and 22:30 CT on Dec 3
    expect(exchangeDate(t)).toBe('2026-12-03');
    expect(exchangeTime(t)).toBe('23:30');
    expect(chicagoDate(t)).toBe('2026-12-03');
    expect(chicagoTime(t)).toBe('22:30');
    const u = z('2026-12-04T05:30:00Z'); // midnight-ish: 00:30 ET Dec 4, 23:30 CT Dec 3
    expect(exchangeDate(u)).toBe('2026-12-04');
    expect(chicagoDate(u)).toBe('2026-12-03');
  });
});

describe('isQuietHours (21:00-06:30 America/Chicago)', () => {
  it('winter (CST): boundaries are start-inclusive, end-exclusive', () => {
    expect(isQuietHours(z('2026-12-04T02:59:00Z'))).toBe(false); // 20:59 CT
    expect(isQuietHours(z('2026-12-04T03:00:00Z'))).toBe(true); // 21:00 CT
    expect(isQuietHours(z('2026-12-04T12:29:00Z'))).toBe(true); // 06:29 CT
    expect(isQuietHours(z('2026-12-04T12:30:00Z'))).toBe(false); // 06:30 CT
    expect(isQuietHours(z('2026-12-03T17:00:00Z'))).toBe(false); // midday
  });

  it('summer (CDT) keeps the same LOCAL boundaries', () => {
    expect(isQuietHours(z('2026-07-02T01:59:00Z'))).toBe(false); // 20:59 CDT
    expect(isQuietHours(z('2026-07-02T02:00:00Z'))).toBe(true); // 21:00 CDT
    expect(isQuietHours(z('2026-07-02T11:30:00Z'))).toBe(false); // 06:30 CDT
  });

  it('local boundaries hold on both DST transition days', () => {
    // Spring forward (Chicago changes 2026-03-08 08:00Z): 21:00 CDT on Mar 8 = 02:00Z Mar 9.
    expect(isQuietHours(z('2026-03-09T01:59:00Z'))).toBe(false);
    expect(isQuietHours(z('2026-03-09T02:00:00Z'))).toBe(true);
    // Fall back (Chicago changes 2026-11-01 07:00Z): 21:00 CST on Nov 1 = 03:00Z Nov 2.
    expect(isQuietHours(z('2026-11-02T02:59:00Z'))).toBe(false);
    expect(isQuietHours(z('2026-11-02T03:00:00Z'))).toBe(true);
  });

  it('supports non-wrapping and empty windows and custom zones', () => {
    expect(isQuietHours(z('2026-12-03T17:00:00Z'), '11:00', '12:00')).toBe(true); // 11:00 CT
    expect(isQuietHours(z('2026-12-03T18:00:00Z'), '11:00', '12:00')).toBe(false);
    expect(isQuietHours(z('2026-12-03T17:00:00Z'), '09:00', '09:00')).toBe(false);
    expect(isQuietHours(z('2026-12-03T04:00:00Z'), '23:00', '07:00', 'America/New_York')).toBe(
      true,
    ); // 23:00 ET
  });

  it('parseHm validates', () => {
    expect(parseHm('6:30')).toBe(390);
    expect(parseHm('21:00')).toBe(1260);
    expect(() => parseHm('25:00')).toThrow(RangeError);
    expect(() => parseHm('noon')).toThrow(RangeError);
  });
});

describe('session fraction and minutes since open', () => {
  const cal = new NyseCalendar();

  it('normal day: 0 at open, 0.5 at 12:45 ET, 1 at close', () => {
    expect(fractionOfSessionElapsed(z('2026-12-03T14:30:00Z'), cal)).toBe(0);
    expect(fractionOfSessionElapsed(z('2026-12-03T17:45:00Z'), cal)).toBeCloseTo(0.5, 10);
    expect(fractionOfSessionElapsed(z('2026-12-03T21:00:00Z'), cal)).toBe(1);
    expect(minutesSinceOpen(z('2026-12-03T15:30:00Z'), cal)).toBe(60);
  });

  it('clamps before open and after close, and is 0/null on non-session days', () => {
    expect(fractionOfSessionElapsed(z('2026-12-03T13:00:00Z'), cal)).toBe(0);
    expect(minutesSinceOpen(z('2026-12-03T13:30:00Z'), cal)).toBe(-60);
    expect(fractionOfSessionElapsed(z('2026-12-03T23:00:00Z'), cal)).toBe(1);
    expect(fractionOfSessionElapsed(z('2026-12-05T16:00:00Z'), cal)).toBe(0); // Saturday
    expect(minutesSinceOpen(z('2026-12-05T16:00:00Z'), cal)).toBeNull();
    expect(cal.fractionOfSessionElapsed(z('2026-12-03T17:45:00Z'))).toBeCloseTo(0.5, 10);
    expect(cal.minutesSinceOpen(z('2026-12-03T15:30:00Z'))).toBe(60);
  });

  it('early-close day (2026-11-27) uses the 13:00 ET close (210-minute session)', () => {
    // 12:00 ET = 17:00Z (EST). open 14:30Z, close 18:00Z.
    expect(fractionOfSessionElapsed(z('2026-11-27T17:00:00Z'), cal)).toBeCloseTo(150 / 210, 10);
    expect(fractionOfSessionElapsed(z('2026-11-27T18:00:00Z'), cal)).toBe(1);
  });

  it('session length is correct across the DST change (open/close both shift together)', () => {
    const open = cal.sessionOpen('2026-03-09').getTime();
    const close = cal.sessionClose('2026-03-09').getTime();
    expect((close - open) / 60_000).toBe(390);
    const open2 = cal.sessionOpen('2026-11-02').getTime();
    const close2 = cal.sessionClose('2026-11-02').getTime();
    expect((close2 - open2) / 60_000).toBe(390);
  });
});

describe('nextQuietEnd', () => {
  it('evening and early-morning instants resolve to the next 06:30 CT (winter)', () => {
    // 22:00 CST Dec 3 = 04:00Z Dec 4 -> 06:30 CST Dec 4 = 12:30Z
    expect(nextQuietEnd(new Date('2026-12-04T04:00:00Z')).toISOString()).toBe(
      '2026-12-04T12:30:00.000Z',
    );
    // 05:00 CST Dec 4 -> the SAME morning's 06:30
    expect(nextQuietEnd(new Date('2026-12-04T11:00:00Z')).toISOString()).toBe(
      '2026-12-04T12:30:00.000Z',
    );
    // exactly 21:00 CST is quiet; exactly 06:30 is NOT (returns now)
    expect(nextQuietEnd(new Date('2026-12-04T03:00:00Z')).toISOString()).toBe(
      '2026-12-04T12:30:00.000Z',
    );
    const open = new Date('2026-12-04T12:30:00Z');
    expect(nextQuietEnd(open).toISOString()).toBe(open.toISOString());
  });

  it('is DST-correct: the same LOCAL end on both transition weekends and in summer', () => {
    // CDT summer: 22:00 CDT Jul 1 = 03:00Z Jul 2 -> 06:30 CDT = 11:30Z
    expect(nextQuietEnd(new Date('2026-07-02T03:00:00Z')).toISOString()).toBe(
      '2026-07-02T11:30:00.000Z',
    );
    // spring-forward night (Mar 8 2026): quiet from 21:00 CST Mar 7 to 06:30 CDT Mar 8 (= 11:30Z)
    expect(nextQuietEnd(new Date('2026-03-08T04:00:00Z')).toISOString()).toBe(
      '2026-03-08T11:30:00.000Z',
    );
    // fall-back night (Nov 1 2026): 06:30 CST Nov 1 = 12:30Z
    expect(nextQuietEnd(new Date('2026-11-01T04:00:00Z')).toISOString()).toBe(
      '2026-11-01T12:30:00.000Z',
    );
  });

  it('works for non-wrapping windows and other zones; never returns an instant before now', () => {
    const now = new Date('2026-12-03T15:00:00Z'); // 10:00 CST, inside 09:00-12:00
    expect(nextQuietEnd(now, '09:00', '12:00').toISOString()).toBe('2026-12-03T18:00:00.000Z');
    for (let h = 0; h < 24; h++) {
      const t = new Date(Date.UTC(2026, 11, 3, h, 17));
      expect(nextQuietEnd(t).getTime()).toBeGreaterThanOrEqual(t.getTime());
    }
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA names and rejects typos', () => {
    expect(isValidTimeZone('America/Chicago')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('America/Chicag0')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});
