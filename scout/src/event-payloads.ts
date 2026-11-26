/**
 * Runtime (zod) schemas for the structured `payload` of every well-known event kind, mirroring `EventPayloadMap`
 * in `src/types.ts`. `payloadOf` is only a cast; these are the DETECTOR for invariant I8 ("a malformed event
 * fails that item, not the loop"): B1 calls `parseEventPayload` in stage S2 and A1-A4 call it in their tests.
 *
 * `commitPoll` deliberately does NOT validate payload shapes (a poll that fails on one odd payload would block
 * every later event); it validates the envelope (source, ts offset, kind/source pair). Schemas are LOOSE: extra
 * optional fields are allowed (the contract allows additions, never renames), required fields must be present
 * with the right type. A payload pruned by retention is `{}` and is NOT validated (callers check
 * `payloadPruned` first).
 */
import { z } from 'zod';
import { EVENT_KINDS, type EventPayloadMap } from './types.js';

const str = z.string();
const nstr = z.string().nullable();
const num = z.number();
const nnum = z.number().nullable();
const bool = z.boolean();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const filingBase = {
  cik: str,
  accession: str,
  form: str,
  acceptedAt: str,
  filingDate: date,
  reportDate: date.nullable(),
  primaryDocument: nstr,
  documentUrl: nstr,
  indexUrl: str,
  description: nstr,
};

const news = z.looseObject({
  title: str,
  summary: nstr,
  publisher: nstr,
  publishedAt: str,
  feedId: str,
  titleNorm: str,
  isPrimary: bool,
  mentionsGuidance: bool,
  mentionsDividend: bool,
});

const periodic = z.looseObject(filingBase);

/** One schema per kind. Exported for adapters' tests; use {@link parseEventPayload} to validate. */
export const EVENT_PAYLOAD_SCHEMAS: {
  [K in keyof EventPayloadMap]: z.ZodType<EventPayloadMap[K]>;
} = {
  '8-K': z.looseObject({
    ...filingBase,
    items: z.array(str),
    isAmendment: bool,
    exhibit99Url: nstr,
  }) as unknown as z.ZodType<EventPayloadMap['8-K']>,
  '10-Q': periodic as unknown as z.ZodType<EventPayloadMap['10-Q']>,
  '10-K': periodic as unknown as z.ZodType<EventPayloadMap['10-K']>,
  form4: z.looseObject({
    ...filingBase,
    rowIndex: z.number().int().nonnegative(),
    tableType: z.enum(['non_derivative', 'derivative']),
    ownerName: str,
    ownerCik: str,
    isOfficer: bool,
    isDirector: bool,
    isTenPercentOwner: bool,
    officerTitle: nstr,
    transactionCode: str,
    transactionDate: date,
    shares: num,
    pricePerShare: nnum,
    usdValue: nnum,
    filingSaleUsd: num,
    filingBuyUsd: num,
    acquiredDisposed: z.enum(['A', 'D']),
    sharesOwnedAfter: nnum,
    ownership: z.enum(['D', 'I']).nullable(),
    is10b5One: bool.nullable(),
  }) as unknown as z.ZodType<EventPayloadMap['form4']>,
  '13d_g': z.looseObject({
    ...filingBase,
    isAmendment: bool,
    filerName: nstr,
    filerCik: nstr,
    percentOfClass: nnum,
    shares: nnum,
  }) as unknown as z.ZodType<EventPayloadMap['13d_g']>,
  '13f': z.looseObject({
    filerCik: str,
    filerName: str,
    period: date,
    accession: str,
    shares: num,
    previousShares: nnum,
    changePct: nnum,
    valueUsd: nnum,
  }) as unknown as z.ZodType<EventPayloadMap['13f']>,
  short_interest: z.looseObject({
    symbol: str,
    settlementDate: date,
    shortInterest: num,
    previousShortInterest: nnum,
    changePct: nnum,
    avgDailyVolume: nnum,
    daysToCover: nnum,
    previousDaysToCover: nnum,
  }) as unknown as z.ZodType<EventPayloadMap['short_interest']>,
  press_release: news as unknown as z.ZodType<EventPayloadMap['press_release']>,
  news: news as unknown as z.ZodType<EventPayloadMap['news']>,
  newsletter: z.looseObject({
    subject: str,
    from: str,
    mailbox: str,
    uid: z.number().int(),
    snippet: str,
    matchedTerms: z.array(str),
  }) as unknown as z.ZodType<EventPayloadMap['newsletter']>,
  price_move: z.looseObject({
    tradingDate: date,
    last: num,
    closePrior: num,
    movePct: num,
    atrPct20: nnum,
    atrMultiple: nnum,
    trigger: z.enum(['atr', 'abs', 'both']),
    direction: z.enum(['up', 'down']),
  }) as unknown as z.ZodType<EventPayloadMap['price_move']>,
  volume_pace: z.looseObject({
    tradingDate: date,
    volume: num,
    adv20: num,
    expectedFraction: num,
    pace: num,
    profile: z.enum(['learned', 'default_curve']),
    pairedWithPriceMove: bool,
  }) as unknown as z.ZodType<EventPayloadMap['volume_pace']>,
  halt: z.looseObject({
    symbol: str,
    state: z.enum(['halted', 'resumed', 'possible_pause']),
    source: z.enum(['schwab_status', 'schwab_stale_trade', 'nasdaq_trader']),
    reasonCode: nstr,
    reasonText: nstr,
    haltedAtMs: num,
    resumedAtMs: nnum,
    confidence: z.enum(['high', 'low']),
  }) as unknown as z.ZodType<EventPayloadMap['halt']>,
  iv30_jump: z.looseObject({
    date,
    iv30Pct: num,
    previousIv30Pct: num,
    previousDate: date,
    changePct: num,
  }) as unknown as z.ZodType<EventPayloadMap['iv30_jump']>,
  strike_volume: z.looseObject({
    date,
    expiration: date,
    strike: num,
    type: z.enum(['CALL', 'PUT']),
    volume: num,
    openInterest: num,
    multiple: num,
  }) as unknown as z.ZodType<EventPayloadMap['strike_volume']>,
  plan_level: z.looseObject({
    tradingDate: date,
    level: z.enum(['review_below', 'trim_above']),
    levelPrice: num,
    last: num,
    direction: z.enum(['below', 'above']),
  }) as unknown as z.ZodType<EventPayloadMap['plan_level']>,
  thesis_breaker: z.looseObject({
    detector: z.enum([
      'guidance_cut_count',
      'dividend_cut_or_suspension',
      'buyback_suspension',
      'revolver_draw',
    ]),
    period: str,
    breaker: str,
    evidence: str,
    evidenceEventIds: z.array(str),
  }) as unknown as z.ZodType<EventPayloadMap['thesis_breaker']>,
  macro_obs: z.looseObject({
    seriesId: str,
    title: str,
    observationDate: date,
    value: nnum,
    previousValue: nnum,
  }) as unknown as z.ZodType<EventPayloadMap['macro_obs']>,
};

export type ParsedPayload =
  | { ok: true; known: true; data: unknown }
  /** `kind` is not a well-known kind (the kind space is open): nothing to validate. */
  | { ok: true; known: false; data: unknown }
  | { ok: false; error: string };

/**
 * Validate `payload` against the schema for `kind`. `ok: false` carries a path-annotated message (no payload
 * values), safe to put in `events.last_error` and logs.
 */
export function parseEventPayload(kind: string, payload: unknown): ParsedPayload {
  const schema = (EVENT_PAYLOAD_SCHEMAS as Record<string, z.ZodType | undefined>)[kind];
  if (schema === undefined) return { ok: true, known: false, data: payload };
  const r = schema.safeParse(payload);
  if (r.success) return { ok: true, known: true, data: r.data };
  return {
    ok: false,
    error: `invalid ${kind} payload: ${r.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.map(String).join('.') || '<root>'}: ${i.message}`)
      .join('; ')}`,
  };
}

/** Every well-known kind has a schema (compile-time guard that `EVENT_KINDS` and the map stay in step). */
export const SCHEMA_KINDS: readonly string[] = Object.values(EVENT_KINDS);
