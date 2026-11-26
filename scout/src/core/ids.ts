/**
 * Deterministic identity helpers (decision D9). Adapted from BlackGold packages/shared/src/hash.ts
 * (MIT, Copyright (c) 2026 Matt Herman): `canonicalJson`/`hashJson` are copied with the same semantics.
 * Changes: added `eventId`, natural-key builders, URL normalization; dropped branded types and random ids.
 *
 * THE RULE (avoids BlackGold's "re-poll re-inserts everything as CORRECTED" bug): an Event id is derived ONLY
 * from stable identity (ticker, source, kind, naturalKey) - NEVER from raw response bytes, fetch timestamps
 * or anything that changes between polls of the same fact.
 */
import { createHash } from 'node:crypto';
import type { EventSource } from '../types.js';

/** Lower-case hex SHA-256 of a string or bytes. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Deterministic JSON: object keys sorted recursively, `undefined` dropped, bigint -> string, Date -> ISO,
 * no whitespace. Equal values always serialize (and therefore hash) identically.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const v = record[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/** SHA-256 hex of {@link canonicalJson}(value). */
export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** The four identity parts of an Event (spec section 2 + decision D9). */
export interface EventIdParts {
  ticker: string;
  source: EventSource;
  kind: string;
  /**
   * Stable across re-polls of the same real-world fact. Per source (D9):
   * EDGAR -> `accession` (+ form); Form 4 -> `accession#rowIndex`; short interest -> `symbol|settlementDate`;
   * Reg SHO -> `symbol|tradeDate`; news/IR -> normalized URL or feed guid; price/volume rules ->
   * `ticker|rule|tradingDate|bucket`; options -> `ticker|rule|date|strike|expiry`. Use the helpers below.
   */
  naturalKey: string;
}

/**
 * Stable Event id: `sha256(canonicalJson({ticker, source, kind, naturalKey}))` (full 64 hex chars).
 * The ticker is upper-cased so `bbw` and `BBW` collide.
 *
 * @example
 * ```ts
 * eventId({ ticker: 'BBW', source: 'filing', kind: '8-K', naturalKey: edgarKey('0001113809-26-000123') });
 * ```
 */
export function eventId(parts: EventIdParts): string {
  if (parts.naturalKey.trim() === '')
    throw new RangeError('eventId requires a non-empty naturalKey');
  return hashJson({
    ticker: parts.ticker.toUpperCase(),
    source: parts.source,
    kind: parts.kind,
    naturalKey: parts.naturalKey,
  });
}

// ---------------------------------------------------------------------------------------------
// Natural-key builders: ONE per source/kind so producers, tests and the pipeline agree on the exact string.
//
// AUTHORITATIVE KEY TABLE (decision D9; unit-tested one by one in ids.test.ts). `naturalKey` is the fourth part
// of `eventId`; the table says what makes two events "the same fact". A key that is too coarse silently
// SUPPRESSES a later event (INSERT ... DO NOTHING keeps the first); one that is too fine duplicates pushes.
//
//   kind (source)            key builder                                     identity
//   8-K / 10-Q / 10-K /      edgarKey(accession)                             the BARE accession, always (a form
//   13d_g (filing)                                                           suffix would let two producers mint
//                                                                            two ids for one fact)
//   form4 (filing)           form4Key(accession, rowIndex)                   rowIndex is ONE 0-based counter per
//                                                                            accession: non-derivative rows in
//                                                                            document order, THEN derivative rows
//                                                                            (matches PK (accession,row_index))
//   short_interest (short)   shortInterestKey(symbol, settlementDate)
//   (reg_sho: no event, F2)  regShoKey(symbol, tradeDate)                    record key only
//   press_release / news     newsKey({feedId, guid|url})                     `guid:<feedId>:<guid>` (guids are only
//                                                                            unique per feed) else urlKey(url)
//   newsletter (inbox)       newsletterKey(mailbox, uidValidity, uid)
//   price_move (quote)       priceMoveKey(ticker, date, direction, band=1)   one per (day, direction); a SECOND ATR
//                                                                            band is `${direction}2` (a new event)
//   volume_pace (quote)      volumePaceKey(ticker, date, 'p2'|'p1_paired')   the bucket carries the PRIORITY: an
//                                                                            upgrade to P1 is a different key, so
//                                                                            the earlier P2 cannot suppress it
//   halt (quote)             haltKey(symbol, source, haltedAtMs, state)      a second LULD pause (new haltedAtMs)
//                                                                            and the RESUME (state) are distinct
//                                                                            events; cross-source duplicates are
//                                                                            folded by the budget (10 min window)
//   plan_level (quote)       planLevelKey(ticker, level, date)
//   iv30_jump (options)      optionsKey(ticker, 'iv30_jump', date)
//   strike_volume (options)  optionsKey(ticker, 'strike_volume', date, strike, expiry, right)
//   thesis_breaker (filing)  breakerKey(ticker, period, detectorId)
//
// Outbox pushes are keyed separately by `pushIdempotencyKey`.
// ---------------------------------------------------------------------------------------------

/**
 * An EDGAR filing's identity: the BARE dashed accession number (`0001113809-26-000123`), for every filing kind
 * (8-K, 10-Q, 10-K, Schedule 13D/G). The accession is globally unique per filing; adding the form would only let
 * two producers disagree on the key of the same fact.
 */
export function edgarKey(accession: string): string {
  return normalizeAccession(accession);
}

/**
 * One Form 4 transaction row: `accession#rowIndex`. `rowIndex` is a SINGLE 0-based counter across the whole
 * filing: non-derivative rows first (document order), then derivative rows. Per-table indexing would give a
 * derivative row 0 and a non-derivative row 0 the same key (and the same `form4_rows` primary key).
 */
export function form4Key(accession: string, rowIndex: number): string {
  if (!Number.isInteger(rowIndex) || rowIndex < 0)
    throw new RangeError('form4Key requires a non-negative integer rowIndex');
  return `${normalizeAccession(accession)}#${rowIndex}`;
}

/** FINRA short interest: one record per (symbol, settlement date). */
export function shortInterestKey(symbol: string, settlementDate: string): string {
  return `${symbol.toUpperCase()}|${settlementDate}`;
}

/** Reg SHO daily short volume: one record per (symbol, trade date). */
export function regShoKey(symbol: string, tradeDate: string): string {
  return `${symbol.toUpperCase()}|${tradeDate}`;
}

/**
 * News / IR item: `guid:<feedId>:<guid>` when the feed supplies a stable guid (guids are unique only WITHIN a
 * feed: small integers and reused ids collide across feeds, so the feed id is part of the key), else the
 * {@link urlKey} of the item URL.
 */
export function newsKey(item: {
  feedId?: string | undefined;
  guid?: string | undefined;
  url?: string | undefined;
}): string {
  if (item.guid !== undefined && item.guid.trim() !== '') {
    if (item.feedId === undefined || item.feedId.trim() === '')
      throw new RangeError('newsKey requires feedId when a guid is used');
    return `guid:${item.feedId.trim()}:${item.guid.trim()}`;
  }
  if (item.url !== undefined && item.url.trim() !== '') return urlKey(item.url);
  throw new RangeError('newsKey requires a guid or url');
}

/** A newsletter message: `mailbox|uidValidity|uid` (a UIDVALIDITY change makes old UIDs a different space). */
export function newsletterKey(mailbox: string, uidValidity: number, uid: number): string {
  return `${mailbox}|${uidValidity}|${uid}`;
}

/**
 * Rule-generated events (price/volume/halt/plan level): one event per (ticker, rule, trading date, bucket).
 * Prefer the specific builders below; `bucket` coarsens repeated triggers so a stock that stays +7% all day
 * yields ONE price_move event.
 */
export function ruleKey(ticker: string, rule: string, tradingDate: string, bucket: string): string {
  return `${ticker.toUpperCase()}|${rule}|${tradingDate}|${bucket}`;
}

/** price_move: one per (day, direction); a second, wider ATR band the same day is `band = 2` (a new event). */
export function priceMoveKey(
  ticker: string,
  tradingDate: string,
  direction: 'up' | 'down',
  band = 1,
): string {
  return ruleKey(ticker, 'price_move', tradingDate, band <= 1 ? direction : `${direction}${band}`);
}

/**
 * volume_pace: the bucket INCLUDES the priority. A P2 pace event inserted at 09:10 and the later "paired with a
 * price trigger" P1 are DIFFERENT facts (`p2` vs `p1_paired`); with one shared key INSERT ... DO NOTHING would
 * keep the P2 forever and the P1 would never happen.
 */
export function volumePaceKey(
  ticker: string,
  tradingDate: string,
  bucket: 'p2' | 'p1_paired',
): string {
  return ruleKey(ticker, 'volume_pace', tradingDate, bucket);
}

/**
 * A halt signal: `SYMBOL|halt|<source>|<haltedAtMs>|<state>`. The halt time is part of the identity (a second
 * LULD pause the same day is another event) and so is the state (`resumed` is its own event). Two sources
 * reporting the same halt mint different events on purpose; the budget folds same-ticker halts inside its
 * window into the first push.
 */
export function haltKey(
  symbol: string,
  source: string,
  haltedAtMs: number,
  state: 'halted' | 'resumed' | 'possible_pause',
): string {
  return `${symbol.toUpperCase()}|halt|${source}|${haltedAtMs}|${state}`;
}

/** plan_level: one per (day, level). */
export function planLevelKey(
  ticker: string,
  level: 'review_below' | 'trim_above',
  tradingDate: string,
): string {
  return ruleKey(ticker, 'plan_level', tradingDate, level);
}

/** thesis_breaker: one per (fiscal period, detector). */
export function breakerKey(ticker: string, period: string, detectorId: string): string {
  return ruleKey(ticker, 'thesis_breaker', period, detectorId);
}

/**
 * Options-derived events: `ticker|rule|date|strike|expiry[|right]` (strike/expiry/right may be omitted for
 * IV30 events). `right` (`CALL`/`PUT`) is appended only when given, so a CALL and a PUT at the same
 * strike/expiry are different facts.
 */
export function optionsKey(
  ticker: string,
  rule: string,
  date: string,
  strike?: number,
  expiry?: string,
  right?: 'CALL' | 'PUT',
): string {
  const parts = [
    ticker.toUpperCase(),
    rule,
    date,
    strike === undefined ? '-' : String(strike),
    expiry ?? '-',
  ];
  if (right !== undefined) parts.push(right);
  return parts.join('|');
}

/** Normalize an SEC accession: strips whitespace; converts the 18-digit dashless form to `10-2-6` dashed form. */
export function normalizeAccession(accession: string): string {
  const a = accession.trim();
  if (/^\d{18}$/.test(a)) return `${a.slice(0, 10)}-${a.slice(10, 12)}-${a.slice(12)}`;
  return a;
}

const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ocid|cmpid|ref|ref_src|source)$/i;

/** Locale-independent (code point) string comparison: `localeCompare` depends on the ICU build / process locale. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Canonical form of a URL for display/dedupe: lower-case scheme+host, default port dropped, fragment removed,
 * tracking params (utm_*, fbclid, ...) removed, remaining query params sorted BY CODE POINT (never by locale:
 * the same URL must hash identically on the Pi and on a laptop), trailing slash trimmed (except for root).
 * Unparseable input is trimmed and returned as-is. Use {@link urlKey} for event keys.
 */
export function normalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  u.hash = '';
  const keep: [string, string][] = [];
  for (const [k, v] of u.searchParams) if (!TRACKING_PARAM.test(k)) keep.push([k, v]);
  keep.sort((a, b) => (a[0] === b[0] ? cmp(a[1], b[1]) : cmp(a[0], b[0])));
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);
  let path = u.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  u.pathname = path;
  return u.toString();
}

/**
 * The URL identity used in KEYS ({@link newsKey}, near-duplicate scoring): {@link normalizeUrl} plus scheme
 * unified to `https` and a leading `www.` stripped, so `http://www.x.com/a` and `https://x.com/a` are one fact.
 * Display code keeps the original URL; only the key is folded.
 */
export function urlKey(raw: string): string {
  const n = normalizeUrl(raw);
  let u: URL;
  try {
    u = new URL(n);
  } catch {
    return n;
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    u.protocol = 'https:';
    if (u.hostname.startsWith('www.')) u.hostname = u.hostname.slice(4);
    if (u.port === '80' || u.port === '443') u.port = '';
  }
  return u.toString();
}

/** Idempotency key for an outbox push: stable per (kind, ticker, sorted event ids, discriminator). */
export function pushIdempotencyKey(
  kind: string,
  ticker: string,
  eventIds: readonly string[],
  discriminator = '',
): string {
  return hashJson({
    kind,
    ticker: ticker.toUpperCase(),
    eventIds: [...eventIds].sort(),
    discriminator,
  });
}
