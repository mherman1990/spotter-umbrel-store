import { describe, expect, it } from 'vitest';
import {
  breakerKey,
  canonicalJson,
  edgarKey,
  eventId,
  form4Key,
  haltKey,
  hashJson,
  newsKey,
  newsletterKey,
  normalizeAccession,
  normalizeUrl,
  optionsKey,
  planLevelKey,
  priceMoveKey,
  pushIdempotencyKey,
  regShoKey,
  ruleKey,
  sha256Hex,
  shortInterestKey,
  urlKey,
  volumePaceKey,
} from './ids.js';

describe('canonicalJson / hashJson', () => {
  it('sorts keys recursively, drops undefined, stringifies bigint and dates', () => {
    expect(canonicalJson({ b: 1, a: { z: undefined, y: [3, { d: 1, c: 2 }] } })).toBe(
      '{"a":{"y":[3,{"c":2,"d":1}]},"b":1}',
    );
    expect(canonicalJson({ n: 10n, d: new Date('2026-01-01T00:00:00Z') })).toBe(
      '{"d":"2026-01-01T00:00:00.000Z","n":"10"}',
    );
  });

  it('equal values hash equally regardless of key order', () => {
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }));
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }));
  });

  it('sha256Hex matches the known vector', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('eventId (decision D9)', () => {
  const base = {
    ticker: 'BBW',
    source: 'filing',
    kind: '8-K',
    naturalKey: edgarKey('0001113809-26-000123'),
  } as const;

  it('is stable across calls and ticker case', () => {
    expect(eventId(base)).toBe(eventId({ ...base, ticker: 'bbw' }));
    expect(eventId(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with any identity part', () => {
    const id = eventId(base);
    expect(eventId({ ...base, kind: '10-Q' })).not.toBe(id);
    expect(eventId({ ...base, source: 'news' })).not.toBe(id);
    expect(eventId({ ...base, naturalKey: 'x' })).not.toBe(id);
    expect(eventId({ ...base, ticker: 'AAPL' })).not.toBe(id);
  });

  it('rejects an empty natural key', () => {
    expect(() => eventId({ ...base, naturalKey: '  ' })).toThrow(RangeError);
  });
});

describe('natural keys: the authoritative table (one test per kind)', () => {
  it('normalizes accession numbers (dashless 18-digit form); edgarKey is the BARE accession always', () => {
    expect(normalizeAccession('000111380926000123')).toBe('0001113809-26-000123');
    expect(normalizeAccession(' 0001113809-26-000123 ')).toBe('0001113809-26-000123');
    expect(edgarKey('000111380926000123')).toBe('0001113809-26-000123');
    expect(edgarKey.length).toBe(1); // no `form` parameter: two producers cannot mint two keys for one fact
  });

  it('8-K / 10-Q / 10-K / 13d_g share the bare-accession key; the kind is part of eventId, not the key', () => {
    const acc = '0001113809-26-000123';
    const base = { ticker: 'BBW', source: 'filing', naturalKey: edgarKey(acc) } as const;
    expect(eventId({ ...base, kind: '8-K' })).not.toBe(eventId({ ...base, kind: '10-Q' }));
    expect(edgarKey(acc)).toBe(edgarKey('000111380926000123'));
  });

  it('form4: ONE rowIndex counter across non-derivative then derivative rows (no per-table collision)', () => {
    expect(form4Key('0001113809-26-000124', 2)).toBe('0001113809-26-000124#2');
    // non-derivative rows 0..1 then derivative rows 2..3: all four keys are distinct
    const keys = [0, 1, 2, 3].map((i) => form4Key('0001113809-26-000124', i));
    expect(new Set(keys).size).toBe(4);
    expect(() => form4Key('x', -1)).toThrow(RangeError);
    expect(() => form4Key('x', 1.5)).toThrow(RangeError);
  });

  it('short interest and Reg SHO: (symbol, date)', () => {
    expect(shortInterestKey('bbw', '2026-11-14')).toBe('BBW|2026-11-14');
    expect(regShoKey('bbw', '2026-11-25')).toBe('BBW|2026-11-25');
  });

  it('news: guid keys include the FEED id (guids collide across feeds); else the folded URL', () => {
    expect(newsKey({ feedId: 'ir', guid: ' abc ', url: 'https://x.example/a' })).toBe(
      'guid:ir:abc',
    );
    expect(newsKey({ feedId: 'ir', guid: '1' })).not.toBe(newsKey({ feedId: 'google', guid: '1' }));
    expect(() => newsKey({ guid: '1' })).toThrow(RangeError);
    expect(newsKey({ url: 'HTTPS://X.example/a/?utm_source=t&b=2&a=1#frag' })).toBe(
      'https://x.example/a?a=1&b=2',
    );
    expect(() => newsKey({})).toThrow(RangeError);
  });

  it('newsletter: mailbox|uidValidity|uid', () => {
    expect(newsletterKey('INBOX', 7, 1042)).toBe('INBOX|7|1042');
    expect(newsletterKey('INBOX', 8, 1042)).not.toBe(newsletterKey('INBOX', 7, 1042));
  });

  it('price_move: one per (day, direction); a second ATR band is a NEW event', () => {
    expect(priceMoveKey('bbw', '2026-12-03', 'down')).toBe('BBW|price_move|2026-12-03|down');
    expect(priceMoveKey('bbw', '2026-12-03', 'down', 2)).toBe('BBW|price_move|2026-12-03|down2');
    expect(priceMoveKey('bbw', '2026-12-03', 'up')).not.toBe(
      priceMoveKey('bbw', '2026-12-03', 'down'),
    );
    expect(ruleKey('bbw', 'price_move', '2026-12-03', 'down')).toBe(
      priceMoveKey('bbw', '2026-12-03', 'down'),
    );
  });

  it('volume_pace: the bucket carries the priority, so a paired P1 is not suppressed by an earlier P2', () => {
    const p2 = volumePaceKey('bbw', '2026-12-03', 'p2');
    const p1 = volumePaceKey('bbw', '2026-12-03', 'p1_paired');
    expect(p2).toBe('BBW|volume_pace|2026-12-03|p2');
    expect(p1).not.toBe(p2);
    const mk = (naturalKey: string) =>
      eventId({ ticker: 'BBW', source: 'quote', kind: 'volume_pace', naturalKey });
    expect(mk(p1)).not.toBe(mk(p2));
  });

  it('halt: a second pause and the resume are distinct events; the same signal re-polled is one', () => {
    const a = haltKey('bbw', 'nasdaq_trader', 1_764_770_000_000, 'halted');
    expect(a).toBe('BBW|halt|nasdaq_trader|1764770000000|halted');
    expect(haltKey('BBW', 'nasdaq_trader', 1_764_770_000_000, 'halted')).toBe(a);
    expect(haltKey('BBW', 'nasdaq_trader', 1_764_770_300_000, 'halted')).not.toBe(a); // second LULD pause
    expect(haltKey('BBW', 'nasdaq_trader', 1_764_770_000_000, 'resumed')).not.toBe(a);
    expect(haltKey('BBW', 'schwab_status', 1_764_770_000_000, 'halted')).not.toBe(a);
  });

  it('plan_level, iv30_jump, strike_volume and thesis_breaker keys', () => {
    expect(planLevelKey('bbw', 'review_below', '2026-12-03')).toBe(
      'BBW|plan_level|2026-12-03|review_below',
    );
    expect(planLevelKey('bbw', 'trim_above', '2026-12-03')).not.toBe(
      planLevelKey('bbw', 'review_below', '2026-12-03'),
    );
    expect(optionsKey('bbw', 'iv30_jump', '2026-12-03')).toBe('BBW|iv30_jump|2026-12-03|-|-');
    expect(optionsKey('bbw', 'strike_volume', '2026-12-03', 45, '2026-12-18', 'CALL')).toBe(
      'BBW|strike_volume|2026-12-03|45|2026-12-18|CALL',
    );
    expect(optionsKey('bbw', 'strike_volume', '2026-12-03', 45, '2026-12-18', 'PUT')).not.toBe(
      optionsKey('bbw', 'strike_volume', '2026-12-03', 45, '2026-12-18', 'CALL'),
    );
    expect(breakerKey('bbw', 'Q3 FY26', 'guidance_cut_count')).toBe(
      'BBW|thesis_breaker|Q3 FY26|guidance_cut_count',
    );
  });

  it('normalizeUrl drops tracking params, fragments, default ports and trailing slashes but keeps the root', () => {
    expect(normalizeUrl('https://Example.com:443/path/?fbclid=1')).toBe('https://example.com/path');
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
    expect(normalizeUrl('garbage')).toBe('garbage');
  });

  it('normalizeUrl sorts query params by code point, independent of the process locale', () => {
    // localeCompare would order these by ICU collation; code point order is the same everywhere
    expect(normalizeUrl('https://x.example/a?b=2&B=1&a=3&_z=0')).toBe(
      'https://x.example/a?B=1&_z=0&a=3&b=2',
    );
    expect(normalizeUrl('https://x.example/a?k=b&k=B&k=a')).toBe('https://x.example/a?k=B&k=a&k=b');
  });

  it('urlKey folds http/https and a leading www for KEYS only', () => {
    expect(urlKey('http://www.Example.com/a/?utm_source=x')).toBe('https://example.com/a');
    expect(urlKey('https://example.com/a')).toBe(urlKey('http://www.example.com:80/a'));
    expect(normalizeUrl('http://www.example.com/a')).toBe('http://www.example.com/a'); // display form keeps them
    expect(urlKey('garbage')).toBe('garbage');
    expect(urlKey('ftp://www.example.com/a')).toBe('ftp://www.example.com/a');
  });

  it('pushIdempotencyKey is order-independent over event ids', () => {
    expect(pushIdempotencyKey('alert', 'bbw', ['b', 'a'])).toBe(
      pushIdempotencyKey('alert', 'BBW', ['a', 'b']),
    );
    expect(pushIdempotencyKey('alert', 'BBW', ['a'])).not.toBe(
      pushIdempotencyKey('digest', 'BBW', ['a']),
    );
    expect(pushIdempotencyKey('alert', 'BBW', ['a'], 'x')).not.toBe(
      pushIdempotencyKey('alert', 'BBW', ['a']),
    );
  });
});
