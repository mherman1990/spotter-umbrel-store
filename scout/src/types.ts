/**
 * Shared domain types for Scout. This file is a CONTRACT: wave-1 modules (adapters, rules, budget, briefs...)
 * are written in parallel against it, so changes need orchestrator approval. It contains types, string
 * constants and tiny pure helpers only; it imports nothing at runtime.
 *
 * Reading order for newcomers: {@link Event} (spec section 2) -> {@link EventPayloadMap} (what each `kind`
 * carries in `payload`) -> market data types ({@link DailyBar}, {@link QuoteTick}, option chain) ->
 * {@link DomainRecord} (rows an adapter hands the orchestrator to persist atomically with its events).
 */

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

/** `YYYY-MM-DD` calendar date (no zone). Trading dates are exchange (America/New_York) dates. */
export type IsoDate = string;

/**
 * Alert priority. P1 = push immediately (always); P2 = digest (push only on 3+ cluster in 30 min);
 * P3 = close recap only. Spec section 6.
 */
export type Priority = 'P1' | 'P2' | 'P3';

export const PRIORITIES: readonly Priority[] = ['P1', 'P2', 'P3'];

/** Numeric rank, lower = more urgent (P1 = 1). */
export function priorityRank(p: Priority): number {
  return p === 'P1' ? 1 : p === 'P2' ? 2 : 3;
}

/** The more urgent of two priorities. */
export function maxPriority(a: Priority, b: Priority): Priority {
  return priorityRank(a) <= priorityRank(b) ? a : b;
}

/** The more urgent of any number of priorities, or `undefined` for an empty list. */
export function mostUrgent(list: readonly (Priority | undefined)[]): Priority | undefined {
  let best: Priority | undefined;
  for (const p of list)
    if (p !== undefined && (best === undefined || priorityRank(p) < priorityRank(best))) best = p;
  return best;
}

/** Where an event came from (spec section 2). */
export type EventSource = 'quote' | 'filing' | 'short' | 'news' | 'macro' | 'inbox' | 'options';

export const EVENT_SOURCES: readonly EventSource[] = [
  'quote',
  'filing',
  'short',
  'news',
  'macro',
  'inbox',
  'options',
];

/** Regular session / extended hours state of the exchange. See `NyseCalendar#marketPhase`. */
export type MarketPhase = 'premarket' | 'regular' | 'afterhours' | 'closed';

/** Ticker value used for events/watermarks that are not about one covered name (FRED macro, global feeds). */
export const GLOBAL_TICKER = '*';

/** Function that removes a previously registered listener. */
export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------------------------
// Event (spec section 2 - EXACT shape, plus optional `finalPriority`)
// ---------------------------------------------------------------------------------------------

/**
 * The normalized unit every input is converted to. Adapters never call an LLM and never decide priority
 * beyond what the deterministic rules say.
 *
 * Invariants:
 *  - `id` = `eventId({ticker, source, kind, naturalKey})` (src/core/ids.ts): stable across re-polls.
 *  - `ts` is ISO-8601 WITH the America/New_York offset (`toExchangeIso`), e.g. `2026-12-03T07:02:11.000-05:00`.
 *    For a filing it is the SEC `acceptanceDateTime` (decision D11), not the time Scout noticed it. An explicit
 *    zone designator (`Z` or `+hh:mm`) is REQUIRED: `commitPoll` rejects a zoneless string, which `Date.parse`
 *    would read in the process time zone (the container runs TZ=America/Chicago).
 *    Every OTHER instant stored in the database (filing `acceptedAt`, 13D `filedAt`, guidance `asOf`, ...) is
 *    normalized to UTC `...Z` with milliseconds at the repo boundary (`normalizeInstant`).
 *  - `payload` is the structured, source-specific fact set (see {@link EventPayloadMap}); text copied from
 *    filings/news/press releases inside it is UNTRUSTED DATA, never instructions (decision D22).
 *  - `rulePriority` is set only by the deterministic rules (rules.ts). `finalPriority` is set by the pipeline
 *    after triage: Haiku may upgrade P3->P2 and may never downgrade a rules-assigned P1.
 */
export interface Event {
  /** Stable hash for dedupe (see {@link EventIdParts}). */
  id: string;
  /** Upper-case symbol, or {@link GLOBAL_TICKER}. */
  ticker: string;
  source: EventSource;
  /** e.g. 'price_move', '8-K', 'form4', 'short_interest'. See {@link EVENT_KINDS}. */
  kind: string;
  /** ISO-8601 with exchange (America/New_York) offset. */
  ts: string;
  payload: Record<string, unknown>;
  url?: string;
  /** Set by rules.ts before triage. */
  rulePriority?: Priority;
  /** Set by the pipeline after triage/budget. */
  finalPriority?: Priority;
}

/** Event lifecycle in the `events.status` column (see pipeline-contract.ts for the exact transitions). */
export type EventStatus =
  'new' | 'triaged' | 'queued' | 'pushed' | 'digested' | 'dropped' | 'folded';

export const EVENT_STATUSES: readonly EventStatus[] = [
  'new',
  'triaged',
  'queued',
  'pushed',
  'digested',
  'dropped',
  'folded',
];

/**
 * Well-known `Event.kind` values. `kind` is an open string (new kinds need no migration) but producers and
 * consumers MUST use these constants for the kinds listed here.
 */
export const EVENT_KINDS = {
  // source 'quote' (rule-derived from market state)
  PRICE_MOVE: 'price_move',
  VOLUME_PACE: 'volume_pace',
  HALT: 'halt',
  PLAN_LEVEL: 'plan_level',
  // source 'filing'
  EIGHT_K: '8-K',
  TEN_Q: '10-Q',
  TEN_K: '10-K',
  FORM4: 'form4',
  SCHEDULE_13D_G: '13d_g',
  F13: '13f',
  THESIS_BREAKER: 'thesis_breaker',
  // source 'short'
  SHORT_INTEREST: 'short_interest',
  // source 'news'
  PRESS_RELEASE: 'press_release',
  NEWS: 'news',
  // source 'macro' (context only, NEVER pushes: decision D26)
  MACRO_OBSERVATION: 'macro_obs',
  // source 'inbox'
  NEWSLETTER: 'newsletter',
  // source 'options'
  IV30_JUMP: 'iv30_jump',
  STRIKE_VOLUME: 'strike_volume',
} as const;

export type KnownEventKind = (typeof EVENT_KINDS)[keyof typeof EVENT_KINDS];

/**
 * The ONE source every well-known kind belongs to. `commitPoll` asserts it (an event whose `source` disagrees
 * with this map is a programmer error and throws), so halts, plan levels and the Nasdaq halts feed cannot pick
 * "any of seven sources". Derived market events are `quote`/`options`; `thesis_breaker` is a `filing`-source
 * event (derived from a filing's guidance/scorecard facts).
 */
export const KIND_SOURCE: Readonly<Record<KnownEventKind, EventSource>> = {
  price_move: 'quote',
  volume_pace: 'quote',
  halt: 'quote',
  plan_level: 'quote',
  '8-K': 'filing',
  '10-Q': 'filing',
  '10-K': 'filing',
  form4: 'filing',
  '13d_g': 'filing',
  '13f': 'filing',
  thesis_breaker: 'filing',
  short_interest: 'short',
  press_release: 'news',
  news: 'news',
  macro_obs: 'macro',
  newsletter: 'inbox',
  iv30_jump: 'options',
  strike_volume: 'options',
};

// ---------------------------------------------------------------------------------------------
// Event payload shapes. Producers (adapters/rules) and consumers (rules/briefs/triage) agree on these field
// names; extra optional fields are allowed, renaming is not.
// ---------------------------------------------------------------------------------------------

/** Fields common to every SEC filing event payload. */
export interface FilingPayloadBase {
  cik: string;
  /** Dashed accession, e.g. `0001113809-26-000123`. */
  accession: string;
  /** SEC form string as filed: `8-K`, `8-K/A`, `10-Q`, `10-K`, `4`, `SCHEDULE 13D/A`, `SC 13G`... */
  form: string;
  /** SEC `acceptanceDateTime` (the alert-time source of truth, decision D11), ISO-8601. */
  acceptedAt: string;
  filingDate: IsoDate;
  reportDate: IsoDate | null;
  /** Primary document file name as listed by EDGAR (may be XSL-prefixed for Form 4). */
  primaryDocument: string | null;
  /** Browsable primary document URL. */
  documentUrl: string | null;
  /** Filing index URL (`.../<accession>-index.htm`). */
  indexUrl: string;
  /** EDGAR `primaryDocDescription`, untrusted text. */
  description: string | null;
}

/** `kind: '8-K'`. `items` are normalized ('2.02', '5.02', '1.01', '9.01'): no leading zeros, no whitespace. */
export interface EightKPayload extends FilingPayloadBase {
  items: string[];
  isAmendment: boolean;
  /** URL of Exhibit 99.1 (press release) when discovered, else null (discovery is lazy; decision D11). */
  exhibit99Url: string | null;
}

/** `kind: '10-Q' | '10-K'`. */
export type PeriodicReportPayload = FilingPayloadBase;

/** SEC Form 4 transaction codes that Scout distinguishes (others pass through as the raw letter). */
export type Form4Code = 'P' | 'S' | 'A' | 'M' | 'F' | 'G' | 'D' | 'X' | 'C' | 'V' | (string & {});

/** `kind: 'form4'` - ONE event per transaction row (`naturalKey = form4Key(accession, rowIndex)`). */
export interface Form4Payload extends FilingPayloadBase {
  /**
   * ONE 0-based counter per accession: non-derivative rows first (document order), THEN derivative rows. It is
   * the second half of `form4_rows`' primary key, so per-table numbering (two "row 0"s) would collide.
   */
  rowIndex: number;
  tableType: 'non_derivative' | 'derivative';
  ownerName: string;
  ownerCik: string;
  isOfficer: boolean;
  isDirector: boolean;
  isTenPercentOwner: boolean;
  officerTitle: string | null;
  transactionCode: Form4Code;
  transactionDate: IsoDate;
  shares: number;
  pricePerShare: number | null;
  /** shares * pricePerShare when both known (always positive), else null. */
  usdValue: number | null;
  /**
   * Sum of `usdValue` over this filing's open-market SALE rows (code S, non-derivative, non-10b5-1 or unknown) FOR
   * THIS OWNER. The sale rule compares `max(usdValue, filingSaleUsd)` to the threshold: one $400k sale split
   * into five $80k rows never fires per row. A1 computes it (same for every row of the owner's filing).
   */
  filingSaleUsd: number;
  /** Sum of `usdValue` over this filing's open-market PURCHASE rows (code P) for this owner. */
  filingBuyUsd: number;
  acquiredDisposed: 'A' | 'D';
  sharesOwnedAfter: number | null;
  ownership: 'D' | 'I' | null;
  /**
   * Rule 10b5-1 trading-plan flag. `null` when the filing does not say (pre-2023 forms); the sale rule treats
   * `null` as NON-10b5-1 (it alerts: an unknown plan is not an exemption). UNVERIFIED: `aff10b5One` is
   * document-level in the XSD (decision D11) - confirm against the ownership schema.
   */
  is10b5One: boolean | null;
}

/** `kind: '13d_g'`. */
export interface Schedule13Payload extends FilingPayloadBase {
  isAmendment: boolean;
  filerName: string | null;
  filerCik: string | null;
  percentOfClass: number | null;
  shares: number | null;
}

/** `kind: '13f'` (optional, low priority): a watched institution's change in the covered name. */
export interface F13Payload {
  filerCik: string;
  filerName: string;
  period: IsoDate;
  accession: string;
  shares: number;
  previousShares: number | null;
  changePct: number | null;
  valueUsd: number | null;
}

/** `kind: 'short_interest'`. Computed by the FINRA adapter using stored ADV20 and the previous settlement. */
export interface ShortInterestPayload {
  symbol: string;
  settlementDate: IsoDate;
  shortInterest: number;
  previousShortInterest: number | null;
  /** Percent change vs previous settlement (e.g. 12.5), or null when no previous record. */
  changePct: number | null;
  avgDailyVolume: number | null;
  daysToCover: number | null;
  previousDaysToCover: number | null;
}

/** `kind: 'press_release' | 'news'`. `title`/`summary` are UNTRUSTED text. */
export interface NewsPayload {
  title: string;
  summary: string | null;
  publisher: string | null;
  publishedAt: string;
  feedId: string;
  /** Normalized title used for semantic near-duplicate detection. */
  titleNorm: string;
  /** True when the item came from the company's own IR feed (primary source). */
  isPrimary: boolean;
  /** Item text mentions guidance/outlook/dividend/buyback (cheap deterministic flag for P1 upgrade). */
  mentionsGuidance: boolean;
  mentionsDividend: boolean;
}

/** `kind: 'newsletter'` (inbox adapter, default OFF). Always P3 unless triage upgrades. */
export interface NewsletterPayload {
  subject: string;
  from: string;
  mailbox: string;
  uid: number;
  snippet: string;
  matchedTerms: string[];
}

/** `kind: 'price_move'` (rule-derived). */
export interface PriceMovePayload {
  tradingDate: IsoDate;
  last: number;
  closePrior: number;
  /** Signed percent move from prior close. */
  movePct: number;
  atrPct20: number | null;
  /** |movePct| / atrPct20, or null when ATR is unknown. */
  atrMultiple: number | null;
  trigger: 'atr' | 'abs' | 'both';
  direction: 'up' | 'down';
}

/** `kind: 'volume_pace'` (rule-derived). */
export interface VolumePacePayload {
  tradingDate: IsoDate;
  volume: number;
  adv20: number;
  expectedFraction: number;
  /** volume / (adv20 * expectedFraction). */
  pace: number;
  profile: 'learned' | 'default_curve';
  pairedWithPriceMove: boolean;
}

/** Where a halt signal came from (decision D14). */
export type HaltSource = 'schwab_status' | 'schwab_stale_trade' | 'nasdaq_trader';

/** `kind: 'halt'` - a trading halt / LULD pause / status change / possible pause. */
export interface HaltRecord {
  symbol: string;
  state: 'halted' | 'resumed' | 'possible_pause';
  source: HaltSource;
  /** Raw security status ('Halted', 'Closed'...) or Nasdaq Trader reason code ('LUDP', 'T1'...). */
  reasonCode: string | null;
  reasonText: string | null;
  haltedAtMs: number;
  resumedAtMs: number | null;
  /** `low` for the stale-trade heuristic; `high` for an explicit exchange/vendor status. */
  confidence: 'high' | 'low';
}

/** `kind: 'iv30_jump'`. IV30 is interpolated ATM IV at 30 days (decision D24). Percent units. */
export interface Iv30JumpPayload {
  date: IsoDate;
  iv30Pct: number;
  previousIv30Pct: number;
  previousDate: IsoDate;
  /** Relative day-over-day change in percent (e.g. 22.5 means IV rose 22.5%). */
  changePct: number;
}

/** `kind: 'strike_volume'`. */
export interface StrikeVolumePayload {
  date: IsoDate;
  expiration: IsoDate;
  strike: number;
  type: 'CALL' | 'PUT';
  volume: number;
  openInterest: number;
  /** volume / openInterest. */
  multiple: number;
}

/**
 * `kind: 'plan_level'` - one of the owner's PRICE LEVELS was hit. v0.1 evaluates only `price_levels.review_below`
 * and `trim_above`: tranche conditions are free text ("price or event") that Scout cannot evaluate, so they stay
 * informational (`TrancheStatus.note`) and never become events.
 */
export interface PlanLevelPayload {
  tradingDate: IsoDate;
  level: 'review_below' | 'trim_above';
  levelPrice: number;
  last: number;
  direction: 'below' | 'above';
}

/**
 * Closed catalogue of thesis-breaker detectors (see `engine/breakers.ts` for how an owner's free-text breaker maps
 * to them and who evaluates what). Defined here, at the root, so payloads can name one without importing the engine.
 */
export const BREAKER_DETECTORS = [
  'guidance_cut_count',
  'dividend_cut_or_suspension',
  'buyback_suspension',
  'revolver_draw',
] as const;

export type BreakerDetectorId = (typeof BREAKER_DETECTORS)[number];

/**
 * `kind: 'thesis_breaker'` (source `filing`) - a deterministic detector fired (always P1 "review thesis").
 * Emitted by B4 after a scorecard through `Pipeline.ingest`; key `breakerKey(ticker, period, detector)`.
 */
export interface ThesisBreakerPayload {
  /** The detector that fired. */
  detector: BreakerDetectorId;
  /** Fiscal period of the evidence (e.g. `Q3 FY26`). */
  period: string;
  /** The owner's breaker text that mapped to this detector, verbatim. */
  breaker: string;
  evidence: string;
  evidenceEventIds: string[];
}

/** `kind: 'macro_obs'` - context only. */
export interface MacroObservationPayload {
  seriesId: string;
  title: string;
  observationDate: IsoDate;
  value: number | null;
  previousValue: number | null;
}

/** Map of event kind -> payload shape, for typed access. */
export interface EventPayloadMap {
  '8-K': EightKPayload;
  '10-Q': PeriodicReportPayload;
  '10-K': PeriodicReportPayload;
  form4: Form4Payload;
  '13d_g': Schedule13Payload;
  '13f': F13Payload;
  short_interest: ShortInterestPayload;
  press_release: NewsPayload;
  news: NewsPayload;
  newsletter: NewsletterPayload;
  price_move: PriceMovePayload;
  volume_pace: VolumePacePayload;
  halt: HaltRecord;
  iv30_jump: Iv30JumpPayload;
  strike_volume: StrikeVolumePayload;
  plan_level: PlanLevelPayload;
  thesis_breaker: ThesisBreakerPayload;
  macro_obs: MacroObservationPayload;
}

/**
 * Typed view of an event's payload. NOT validated, only cast: producers in this repo are trusted to follow
 * {@link EventPayloadMap}; adapters parse upstream data with zod BEFORE building events, and the pipeline's
 * malformed-payload detector is `parseEventPayload` (src/event-payloads.ts). After retention a payload is `{}`
 * (`StoredEvent.payloadPruned`): code that renders old events (`/events`, `describeEvent`) must check that flag
 * before trusting these fields.
 */
export function payloadOf<K extends keyof EventPayloadMap>(
  event: Event & { kind: K },
): EventPayloadMap[K] {
  return event.payload as unknown as EventPayloadMap[K];
}

// ---------------------------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------------------------

/** One daily OHLCV bar (split-adjusted as supplied by the vendor). `date` is the exchange trading date. */
export interface DailyBar {
  date: IsoDate;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** One intraday bar. `startMs` is the bar's start instant (epoch ms); `intervalMinutes` its width. */
export interface IntradayBar {
  startMs: number;
  intervalMinutes: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * A merged level-one equity quote state (the streamer sends DELTAS; the stream adapter merges them per
 * symbol, decision D13, so consumers always see a complete tick). Missing numeric fields are `null`.
 */
export interface QuoteTick {
  symbol: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  /** Cumulative volume for the day. */
  totalVolume: number | null;
  high: number | null;
  low: number | null;
  open: number | null;
  /** Prior session close. */
  closePrior: number | null;
  /** Vendor security status ('Normal', 'Halted', 'Closed', 'Unknown'...). UNVERIFIED value set (D14). */
  securityStatus: string | null;
  /** Epoch ms of this state (quote/trade time when known, else receipt time). */
  tsMs: number;
}

/**
 * Read access to the LATEST known quote per symbol. Implemented by A2's `QuoteTracker` (in-memory, freshest) and
 * by the persisted copy (`Store.latestQuotes.asSource()`, kv `quote:<SYMBOL>`, written throttled by the tracker
 * and by the `quotes_snapshot` job for benchmarks/futures). The rule context, `/snapshot` and the briefs read
 * quotes ONLY through this seam, so there is exactly one place a "current price" can come from.
 *
 * Freshness: every `QuoteTick` carries `tsMs`; consumers derive `QuoteSummary.asOfMs` from it and
 * `QuoteSummary.stale` from `health.quote_stale_seconds` during RTH. A source never invents data: an unknown
 * symbol yields `undefined`.
 */
export interface QuoteSnapshotSource {
  latest(symbol: string): QuoteTick | undefined;
}

/** Option type. */
export type OptionRight = 'CALL' | 'PUT';

/** One option contract in a chain snapshot. All IVs are PERCENT (45.2 = 45.2%), matching Schwab's chain. */
export interface OptionContractSnapshot {
  /** OCC-style symbol as supplied by the vendor. */
  symbol: string;
  expiration: IsoDate;
  daysToExpiration: number;
  strike: number;
  right: OptionRight;
  bid: number | null;
  ask: number | null;
  last: number | null;
  mark: number | null;
  volume: number | null;
  openInterest: number | null;
  /** Implied volatility of this contract, percent. */
  ivPct: number | null;
  delta: number | null;
}

/** A full option chain at a point in time. */
export interface OptionChainSnapshot {
  underlying: string;
  asOfMs: number;
  underlyingPrice: number | null;
  contracts: OptionContractSnapshot[];
}

/**
 * An account position aggregated across accounts by symbol (account numbers/hashes are NEVER exposed).
 * Read-only: derived from the broker's positions endpoint.
 */
export interface Position {
  symbol: string;
  /** Net shares (long positive). */
  quantity: number;
  /** Average cost per share. */
  averageCost: number | null;
  marketValue: number | null;
  /** Today's P&L in USD. */
  dayPnl: number | null;
  /** Open (unrealized) P&L in USD, when the vendor reports it. */
  unrealizedPnl: number | null;
  assetType: string | null;
}

/** One FINRA short-interest record (bi-monthly). Cadence is config-driven (decision D25). */
export interface ShortInterestRecord {
  symbol: string;
  settlementDate: IsoDate;
  publishedDate: IsoDate | null;
  shortInterest: number;
  previousShortInterest: number | null;
  avgDailyVolume: number | null;
  daysToCover: number | null;
  /** Percent change vs previous settlement. */
  changePct: number | null;
}

/**
 * One Reg SHO daily short-volume record. Off-exchange/TRF volume only (decision D25): CONTEXT ONLY, never
 * alerts alone.
 */
export interface RegShoRecord {
  symbol: string;
  tradeDate: IsoDate;
  market: string;
  shortVolume: number;
  shortExemptVolume: number;
  totalVolume: number;
}

// ---------------------------------------------------------------------------------------------
// Domain records: rows an adapter returns beside its events. The orchestrator persists records AND events
// in ONE transaction, then advances the watermark (decision D10). All record writes are idempotent upserts.
// ---------------------------------------------------------------------------------------------

export interface FilingRecord {
  accession: string;
  ticker: string;
  cik: string;
  form: string;
  /** Normalized item codes (8-K only). */
  items: string[];
  filingDate: IsoDate;
  reportDate: IsoDate | null;
  /** ISO-8601 instant WITH an offset (EDGAR `acceptanceDateTime`); stored normalized to UTC `...Z`. */
  acceptedAt: string;
  primaryDocument: string | null;
  primaryDocDescription: string | null;
  indexUrl: string;
  documentUrl: string | null;
  isInlineXbrl: boolean;
  /** Raw submissions-row JSON; pruned after the retention window. */
  raw: Record<string, unknown> | null;
}

export interface Form4RowRecord {
  accession: string;
  rowIndex: number;
  ticker: string;
  issuerCik: string;
  ownerName: string;
  ownerCik: string;
  isOfficer: boolean;
  isDirector: boolean;
  isTenPercentOwner: boolean;
  officerTitle: string | null;
  tableType: 'non_derivative' | 'derivative';
  transactionDate: IsoDate;
  transactionCode: Form4Code;
  shares: number;
  pricePerShare: number | null;
  usdValue: number | null;
  acquiredDisposed: 'A' | 'D';
  sharesOwnedAfter: number | null;
  ownership: 'D' | 'I' | null;
  is10b5One: boolean | null;
  raw: Record<string, unknown> | null;
}

export interface Schedule13Record {
  accession: string;
  ticker: string;
  form: string;
  isAmendment: boolean;
  filerName: string | null;
  filerCik: string | null;
  percentOfClass: number | null;
  shares: number | null;
  /** ISO-8601 instant WITH an offset; stored normalized to UTC `...Z`. */
  filedAt: string;
  url: string | null;
  raw: Record<string, unknown> | null;
}

export interface Holding13fRecord {
  filerCik: string;
  filerName: string;
  period: IsoDate;
  cusip: string;
  ticker: string;
  shares: number;
  valueUsd: number | null;
  putCall: string | null;
  accession: string;
  filedAt: string | null;
}

/** A `quotes_daily` row (one per ticker per trading date). `atr20` is the 20-day ATR in PRICE units, or null. */
export interface DailyBarRecord extends DailyBar {
  ticker: string;
  atr20: number | null;
  source: string;
}

export interface IntradayBarRecord extends IntradayBar {
  ticker: string;
}

export interface OptionsSnapshotRecord {
  ticker: string;
  tsMs: number;
  date: IsoDate;
  underlyingPrice: number | null;
  /** Interpolated 30-day ATM implied vol, percent; null when the chain cannot bracket 30 days. */
  iv30Pct: number | null;
  /** Small aggregate summary kept forever (counts, total volume/OI, ATM IVs per expiry). */
  summary: Record<string, unknown>;
  /** Full chain; pruned after the retention window. */
  chain: OptionChainSnapshot | null;
}

export interface MacroObservationRecord {
  seriesId: string;
  title: string | null;
  observationDate: IsoDate;
  value: number | null;
  units: string | null;
}

/** Discriminated union of everything an adapter may ask the orchestrator to persist. */
export type DomainRecord =
  | { type: 'filing'; record: FilingRecord }
  | { type: 'form4_row'; record: Form4RowRecord }
  | { type: 'schedule13'; record: Schedule13Record }
  | { type: 'holding_13f'; record: Holding13fRecord }
  | { type: 'daily_bar'; record: DailyBarRecord }
  | { type: 'intraday_bar'; record: IntradayBarRecord }
  | { type: 'short_interest'; record: ShortInterestRecord }
  | { type: 'reg_sho'; record: RegShoRecord }
  | { type: 'options_snapshot'; record: OptionsSnapshotRecord }
  | { type: 'macro_observation'; record: MacroObservationRecord };

/** Convenience constructor type for the `type` tag. */
export type DomainRecordType = DomainRecord['type'];
