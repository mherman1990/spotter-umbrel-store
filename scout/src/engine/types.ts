/**
 * Engine contracts: rules -> triage -> budget -> briefs. Pure data types and interfaces (zod schemas for the
 * LLM-facing shapes live in `./schemas.ts`). The orchestration contract is `./pipeline-contract.ts`.
 *
 * Division of labor (decision D21): DETERMINISTIC code decides priority and computes every number; the LLM
 * may only (a) write `so_what`/materiality, (b) upgrade P3 -> P2, and never downgrades a rules-assigned P1 nor
 * invents a number. Briefs are pre-computed here as payloads; Mayer (or `synth.ts` when `briefs.writer =
 * scout`) writes prose around them.
 */
import type { NyseCalendar } from '../core/calendar.js';
import type { SessionBounds } from '../core/time.js';
import type { NearDuplicateScorer } from '../core/text.js';
import type { Thresholds, ResolvedTickerConfig, Schedules } from '../config/schema.js';
import type { BatchHandle } from '../llm/types.js';
import type { AlertMessage } from '../notify/types.js';
import type { TickerPlan } from '../config/plan.js';
import type { StoredEvent } from '../store/repos/events.js';
import type {
  DailyBar,
  Event,
  EventSource,
  EventStatus,
  IntradayBar,
  IsoDate,
  MarketPhase,
  OptionChainSnapshot,
  OptionsSnapshotRecord,
  Priority,
  QuoteTick,
  ShortInterestRecord,
} from '../types.js';
import type { BreakerDetectorId } from './breakers.js';

export type { NearDuplicateScorer };
export { normalizeTitle } from '../core/text.js';

// ---------------------------------------------------------------------------------------------
// Metrics (computed by A6 in src/engine/metrics/*; consumed by rules and briefs)
// ---------------------------------------------------------------------------------------------

/** 20-day ATR (decision D24). `atrPct` = atr / last close * 100. */
export interface AtrResult {
  period: number;
  /** ATR in price units. */
  atr: number;
  /** ATR as a percent of the most recent close. */
  atrPct: number;
  method: 'wilder' | 'sma';
  /** Bars actually used (< period + 1 means the result is low-confidence and rules must not fire on it). */
  barsUsed: number;
}

/**
 * Intraday volume pace vs time-of-day-adjusted ADV (decision D24). On NYSE EARLY-CLOSE days (13:00 ET, a
 * 210-minute session) a learned profile indexed by minute-of-session for a 390-minute day is INVALID: the
 * expected fraction must come from the fraction of the actual session elapsed (`fractionOfSessionElapsed`),
 * with `profile: 'default_curve'`, never from the learned profile.
 */
export interface VolumePace {
  /** Cumulative volume today. */
  volume: number;
  adv20: number;
  /** Expected cumulative fraction of a normal day's volume done by now (0..1). */
  expectedFraction: number;
  /** volume / (adv20 * expectedFraction); null while expectedFraction is too small to be meaningful. */
  pace: number | null;
  /** `learned` = from stored intraday profile; `default_curve` = documented U-shaped default. */
  profile: 'learned' | 'default_curve';
  minutesSinceOpen: number;
}

/**
 * PUBLISHED SIGNATURES of the metric functions (implemented by A6 in `src/engine/metrics/*`). They are fixed
 * here, not left to A6, because other slots call them in parallel: B2's options poll calls `computeIv30` to fill
 * `options_snapshot.iv30Pct`, B2's weekly `profile` job calls `learnIntradayProfile` with bars fetched through
 * `QuoteProvider.getIntradayBars`, and the rule-context builder (B1) calls `computeAtr` / `computeVolumePace`.
 * All are PURE and return `null` rather than guessing when the inputs cannot support a trustworthy number.
 */
export interface MetricFunctions {
  /**
   * 20-day ATR from COMPLETED daily bars, OLDEST FIRST (`quotes.latestCompleted`). `null` below
   * `opts.minBars` (`thresholds.price_move.atr_min_bars`). `method` defaults to `thresholds.price_move.atr_method`.
   */
  computeAtr(
    bars: readonly DailyBar[],
    opts?: { period?: number; method?: 'wilder' | 'sma'; minBars?: number },
  ): AtrResult | null;
  /**
   * `null` before `minMinutesSinceOpen` (default 10), when ADV is below `minAdv`, or off-session. `profile` is
   * the learned cumulative profile (`intraday.getProfile`) or null for the default U-shaped curve; ignored on
   * early-close days.
   */
  computeVolumePace(input: {
    volume: number;
    adv20: number;
    now: Date;
    calendar: SessionBounds;
    profile: readonly number[] | null;
    minMinutesSinceOpen?: number;
    minAdv?: number;
  }): VolumePace | null;
  /**
   * ATM IV interpolated to 30 calendar days between the two expirations bracketing it (decision D24; Schwab's
   * chain-level `volatility` is NOT IV30). `null` when the chain cannot bracket 30 days. `expiries` are the two
   * expirations used.
   */
  computeIv30(
    chain: OptionChainSnapshot,
    asOf: Date,
  ): { iv30Pct: number; expiries: [IsoDate, IsoDate] } | null;
  /**
   * Cumulative volume fraction by minute-of-session (index = minute, last = 1) learned from several sessions
   * of minute bars; `null` when fewer than 5 usable full sessions exist (callers keep the default curve).
   */
  learnIntradayProfile(
    bars: readonly IntradayBar[],
    opts?: { sessionMinutes?: number },
  ): number[] | null;
}

// ---------------------------------------------------------------------------------------------
// Rules (A6)
// ---------------------------------------------------------------------------------------------

/**
 * Names of the deterministic rules (spec section 3 table). `thesis_breaker` is CLASSIFY-ONLY: A6's
 * `classifyEvent` maps a `thesis_breaker` event (emitted by B4) to P1; A6 does NOT evaluate breakers (it has no
 * guidance/scorecard inputs; see `./breakers.ts`). `periodic_report` covers 10-Q/10-K (decision F14).
 */
export type RuleName =
  | 'price_move'
  | 'volume_pace'
  | 'halt'
  | 'eight_k'
  | 'form4_purchase'
  | 'form4_sale'
  | 'schedule13'
  | 'short_interest'
  | 'options_iv30'
  | 'options_strike_volume'
  | 'plan_level'
  | 'thesis_breaker'
  | 'periodic_report'
  | 'press_release'
  | 'third_party_news'
  | 'newsletter'
  | 'macro_context';

/**
 * Everything a rule may look at. Inputs a source could not supply are simply absent: a rule whose inputs are
 * missing yields NO hit (it never guesses). Built by the pipeline's context builder (B1) from the store, the
 * stream and the config; rules never touch the store or the network themselves (pure functions).
 */
export interface RuleContext {
  ticker: string;
  /**
   * Never null: macro events (`GLOBAL_TICKER`, source `macro`) are short-circuited to `dropped`/`context_only`
   * by the pipeline BEFORE rules and triage (invariant I9), so no rule ever sees a context without a ticker.
   */
  tickerConfig: ResolvedTickerConfig;
  /** Shortcut for `tickerConfig.thresholds`. */
  thresholds: Thresholds;
  now: Date;
  phase: MarketPhase;
  /** Exchange trading date of `now` (the last session's date when the market is closed). */
  tradingDate: IsoDate;
  /** The owner's plan for this ticker (levels, tranches, breakers), or null when no plan is loaded. */
  plan: TickerPlan | null;

  /** The event being classified (event rules). Absent for market evaluation. */
  event?: Event;

  // ---- market state (market rules) ----
  /** Latest merged quote (from a `QuoteSnapshotSource`; `quote.tsMs` is the freshness). */
  quote?: QuoteTick;
  /** Completed daily bars, OLDEST FIRST, excluding today (`quotes.latestCompleted(ticker, n, tradingDate)`). */
  dailyBars?: DailyBar[];
  atr?: AtrResult | null;
  volumePace?: VolumePace | null;
  /** Tracking for halt heuristics (decision D14 a/b). */
  quoteTracking?: {
    previousStatus: string | null;
    /** Epoch ms the last trade/volume change was observed, or null. */
    lastTradeChangeMs: number | null;
  };
  options?: {
    latest: OptionsSnapshotRecord | null;
    /** Last snapshot of the previous date (day-over-day baseline). */
    previousDay: OptionsSnapshotRecord | null;
    /** The raw chain behind `latest` (strike-volume rule); may be absent after retention pruning. */
    chain: OptionChainSnapshot | null;
  };
  /** Previous short-interest record (baseline for change% / days-to-cover crossing). */
  previousShortInterest?: ShortInterestRecord | null;
}

/** One fired rule. */
export interface RuleHit {
  rule: RuleName;
  priority: Priority;
  /** One deterministic human-readable sentence ("Price -7.2% from prior close (2.6x 20d ATR 2.8%)"). */
  reason: string;
  /** Scout-computed numbers the message and brief reference (never model-generated). */
  facts: Record<string, unknown>;
  /**
   * For hits that DERIVE an event (market rules): the natural key for `eventId`, built ONLY with the
   * per-kind builders of `core/ids` (`priceMoveKey`, `volumePaceKey`, `haltKey`, `planLevelKey`, `optionsKey`,
   * `breakerKey`; the authoritative table is in that file). Stable across repeated evaluations of the same
   * condition, so a stock that stays +7% all day yields ONE event per bucket. An UPGRADE (volume pace P2 -> P1
   * "paired with price") MUST use a different bucket (`p1_paired`): with the same key `INSERT ... DO NOTHING`
   * would keep the P2 forever and the P1 would never happen. For event-classification hits it is the event's
   * own key.
   */
  naturalKey: string;
}

/**
 * The event a market rule derives. A6 owns `eventFromHit` (type {@link EventFromHit}, file
 * `src/engine/rules/event-from-hit.ts`): it adds `id` (`eventId` over `source`/`kind`/`naturalKey`), `ts`
 * (`toExchangeIso(ctx.now)`), `rulePriority` and `url`. B1 calls it; nobody else builds a derived `Event`.
 */
export interface DerivedEventSpec {
  source: EventSource;
  /** One of `EVENT_KINDS`. */
  kind: string;
  /** Shape per `EventPayloadMap`. */
  payload: Record<string, unknown>;
  url?: string;
}

export interface MarketRuleHit extends RuleHit {
  event: DerivedEventSpec;
}

/** Turn a market-rule hit into the `Event` to ingest (owned by A6; see {@link DerivedEventSpec}). */
export type EventFromHit = (
  hit: MarketRuleHit,
  ctx: Pick<RuleContext, 'ticker' | 'now' | 'tradingDate'>,
) => Event;

/**
 * The deterministic rule set (spec section 3). PURE: same context -> same hits, no I/O, no clock reads (time is
 * `ctx.now`). Thresholds come from `ctx.thresholds` (per ticker). Implemented by A6 in `src/engine/rules.ts`.
 *
 * Priority semantics (spec section 3 table; encoded and tested by A6; every number is a `thresholds` key):
 *  - price move >= atr_multiple x ATR% OR >= abs_pct: P1 (ATR flavor `atr_method`; with fewer than
 *    `atr_min_bars` bars only abs_pct can fire); volume pace >= multiple: P2 (none before
 *    `min_minutes_since_open` or below `min_adv`), P1 when paired with a price trigger the same day (key bucket
 *    `p1_paired`; the budget folds that P1 into the price_move push);
 *  - halts: `halted` P1; `resumed` P3 (context); `possible_pause` (low-confidence stale-trade heuristic)
 *    `schwab.stream.stale_trade_priority` (default P2). Two sources may report one halt: the budget folds
 *    same-ticker halts within `notify.halt_fold_minutes` into the first push;
 *  - 8-K: P1 for Items in `thresholds.eight_k.p1_items` (default 2.02/5.02/1.01), every other 8-K
 *    `eight_k.other_priority` (default P1 = literal spec "any 8-K"; decision F14); 10-Q/10-K: `periodic_report.priority` (default P2);
 *  - Form 4: open-market purchase (code P) by an officer/director: P1; a sale (code S) is P2 when
 *    `max(row usdValue, filingSaleUsd) > sale_usd_min` (strictly greater; `is10b5One === null` counts as
 *    NON-10b5-1, i.e. alerts; `filingSaleUsd`/`filingBuyUsd` sum a filing's rows per owner so a $400k sale split
 *    into five $80k rows still fires); purchases use `max(row, filingBuyUsd)` for the same reason;
 *  - 13D/G (and amendments): P1; short interest change >= change_pct or days-to-cover crossing a level: P2;
 *    options IV30 jump (P2) or single-strike volume/OI >= multiple WITH `strike_min_contracts` traded and OI >=
 *    `strike_min_oi` (P2);
 *  - plan level: P1, ONLY for `price_levels.review_below` / `trim_above` (tranche conditions are free text and
 *    informational); thesis breaker: P1 (classify-only: B4 emits the event); press release/IR: P2 (P1 when it
 *    mentions guidance or dividend); third-party news: P3; newsletters: P3; macro: P3 and context-only.
 */
export interface RuleEngine {
  /** Classify an adapter-emitted event. Empty array = no rule fired (event keeps no rule priority). */
  classifyEvent(event: Event, ctx: RuleContext): RuleHit[];
  /** Derive new events from market state (price, volume pace, halts, options, plan levels). */
  evaluateMarket(ctx: RuleContext): MarketRuleHit[];
}

// ---------------------------------------------------------------------------------------------
// Triage (A8) - Haiku materiality + so-what, in-process
// ---------------------------------------------------------------------------------------------

/** The structured verdict (wire shape; `so_what` is snake_case because it is the model's JSON). */
export interface TriageResult {
  material: boolean;
  priority: Priority;
  /** <= 25 words. Facts only from the event/fact sheet; "unknown" rather than inference. */
  so_what: string;
}

/**
 * Outcome of triaging one event. The pipeline's reaction is fixed by decisions D10 and F17:
 *  - `judged`: record the verdict; final priority = `applyTriage(rulePriority, result)` (may upgrade P3 -> P2,
 *    never downgrade a rules-assigned P1). `material: false` on a NON-P1 makes the BUDGET drop it (the budget
 *    reads it from the stored {@link TriageRecord}; the triager only reports).
 *  - `skipped`: no LLM verdict will ever come for this event under current policy (LLM disabled, spend cap
 *    with action stop, macro context-only, policy) OR the pipeline stopped waiting for one (`deadline`/`error`,
 *    below). Final priority = `rulePriority ?? 'P3'` (see {@link resolveFinalPriority}); the event proceeds to
 *    the budget.
 *  - `failed`: transient failure (network, 5xx, refusal fallback exhausted): the event STAYS `new`, its
 *    `attempts` increments, and it is retried with backoff derived from `attempts` + `updated_at`. It is never
 *    silently retired unjudged... EXCEPT that a RULES-P1 event (and every halt and Item 2.02 event) never waits
 *    on the LLM: Haiku only supplies the so-what and P3 -> P2 upgrades (decisions D21/D22), so a rules-P1 is not
 *    "unjudged". After `pipeline.triage_deadline_seconds`, or immediately on a non-retryable failure (a
 *    refusal), the pipeline records `skipped` with reason `deadline` / `error` and proceeds (see
 *    {@link triageFallback}); the so-what is simply absent. Such an event is NEVER dropped as `unprocessable`.
 */
export type TriageOutcome =
  | { status: 'judged'; result: TriageResult; model: string; costUsd: number }
  | {
      status: 'skipped';
      reason: 'llm_disabled' | 'budget_cap' | 'context_only' | 'policy' | 'deadline' | 'error';
    }
  | { status: 'failed'; error: string; retryable: boolean };

/**
 * The shape stored in `events.triage_json` (the ONLY shape; A8/B1 write it, the budget/briefs read it via
 * `parseTriageRecord`). `result` is present only for `judged`; `reason` only for `skipped`.
 */
export interface TriageRecord {
  outcome: 'judged' | 'skipped';
  result?: TriageResult;
  model?: string;
  costUsd?: number;
  reason?: Extract<TriageOutcome, { status: 'skipped' }>['reason'];
}

/**
 * Triage one event. Implemented by A8 in `src/engine/triage.ts` on top of `LlmGateway`. The Triager loads the
 * ticker's cached prefix ITSELF through its own deps (the thesis via `resolveThesisPath` plus the fact sheet from
 * `store.factSheets`): `triage()` receives no thesis or fact-sheet argument. A8 also owns the deterministic
 * fact-sheet builder (`src/llm/fact-sheet.ts`: thesis "Fact sheet inputs" section, `guidance_history`,
 * `scorecards`, latest filings, `earnings.consensus`), rebuilt on a new 10-Q/10-K/8-K 2.02 accession (B1 calls
 * it from `onNewEvent`). Cold start (no scorecard yet): the cached prefix is the thesis section only.
 */
export interface Triager {
  triage(
    event: StoredEvent,
    ctx: { ticker: ResolvedTickerConfig; hits: readonly RuleHit[] },
  ): Promise<TriageOutcome>;
}

/**
 * Final priority after a triage verdict, per decision D21/D22: the model may UPGRADE P3 -> P2 and may never
 * downgrade a rules-assigned P1 (or any rules priority). With no rules priority the model's priority is used
 * but capped at P2 (a model alone can never create a P1). The full resolution including the `skipped` default
 * (`rulePriority ?? 'P3'`) is {@link resolveFinalPriority} in `./schemas.ts`.
 */
export type ApplyTriage = (rulePriority: Priority | undefined, result: TriageResult) => Priority;

// ---------------------------------------------------------------------------------------------
// Shared message builders and semantic dedupe (owned by A7; consumed by B1, B3, B4)
// ---------------------------------------------------------------------------------------------

/** What every consumer shows for one event. `headline` is <= 280 characters and a pure function of the payload. */
export interface EventDescription {
  headline: string;
  /** Scout-computed facts for the hook payload (numbers, accession, items...). Never model-written. */
  facts: Record<string, unknown>;
  sourceUrl?: string;
}

/**
 * THE human headline/facts/link for an event, covering EVERY `EVENT_KINDS` entry (A7, `src/engine/describe.ts`).
 * Pure, from the persisted payload alone (never from `RuleHit.reason`, which is not stored: S4 may run in a
 * later pass than S2/S3 after a restart), tolerant of a pruned payload (`payloadPruned`: a generic headline from
 * kind/ts/ticker, never a throw). Text copied from filings/news stays data. B1 (push), B3
 * (`EventDigestItem.headline`) and B4 (scorecard) call this and NEVER build ad-hoc headline strings.
 */
export type DescribeEvent = (event: Event | StoredEvent) => EventDescription;

/** ONE push for 3+ clustered P2s (shape `cluster`). Built from `describeEvent` lines; A7. */
export type BuildClusterMessage = (events: readonly StoredEvent[]) => AlertMessage;

/** ONE "multiple P1s - see digest" push (shape `p1_overflow_summary`). A7. */
export type BuildOverflowMessage = (events: readonly StoredEvent[]) => AlertMessage;

/** A near-duplicate match for an event. */
export interface SemanticDuplicate {
  /** The PRIMARY event the secondary attaches to (an EVENT id: `event_links` references `events`). */
  primaryId: string;
  /** `rewrite`: the primary is the company's own release; `duplicate`: peer outlets. */
  relation: 'duplicate' | 'rewrite';
  score: number;
}

/**
 * Stage S2.5 (A7, `src/engine/dedupe.ts`): near-duplicates are attached to their primary BEFORE triage, so five
 * outlets rewriting one release cost one Haiku call, not five (and none of them can each upgrade P3 -> P2). It
 * scores with the shared `scoreNearDuplicate` (core/text: Jaccard over word 3-shingles of `titleNorm`, exact
 * URL match = 1) against `news.dedupe.jaccard_threshold` inside `news.dedupe.window_hours`. The company's own
 * IR release (`isPrimary`) is always the primary.
 */
export interface SemanticDeduper {
  /** A secondary of an already-stored primary, or null (the event is itself a primary / unrelated). */
  check(event: StoredEvent): SemanticDuplicate | null;
  /** Earlier secondaries (still `new`/`queued`) that should now fold into `primary` (it arrived second). */
  adoptable(primary: StoredEvent): StoredEvent[];
}

// ---------------------------------------------------------------------------------------------
// Alert budget (A7) - spec section 6, decision "Alert budget semantics"
// ---------------------------------------------------------------------------------------------

/**
 * Which digest carries a queued event. `premarket` also carries items held through quiet hours AND everything
 * that arrives after the last digest job of a session (a P2 after the 15:10 close job, but before the 21:00 CT
 * quiet window, is NOT quiet: it goes to the NEXT session's premarket digest, as `overnightEvents`).
 */
export type DigestKind = 'premarket' | 'midday' | 'close';

/**
 * Which digest a P2/P3 queued at `now` belongs to (A7, `src/engine/digest.ts`). It is derived from
 * `config.schedules.*.cron` and the NYSE calendar, NEVER hard-coded clock times:
 *  - P2: the next `midday` or `close` job instant of a SESSION day that is still ahead of `now`;
 *  - P3: the next `close` job (close recap only) of a session day; on an early-close day the `close_early`
 *    schedule applies instead of `close`;
 *  - anything arriving after the last digest job of the session, on a non-session day, or in quiet hours:
 *    `premarket` of the next session.
 */
export type NextDigestKind = (
  priority: 'P2' | 'P3',
  now: Date,
  schedules: Schedules,
  calendar: NyseCalendar,
) => DigestKind;

export type BudgetAction =
  /** Enqueue a push now (outbox). */
  | 'push_now'
  /** Queue for the next digest (`digestKind`). */
  | 'queue_digest'
  /** Merged into another push/event (`foldedInto`): P1 overflow beyond the daily cap, P2 cluster remainder, semantic duplicate. */
  | 'fold'
  /** Not worth delivering (immaterial, duplicate, macro context-only). Kept in the DB for briefs. */
  | 'drop'
  /**
   * Claimed by the earnings hook (`EarningsHook.claims`): an 8-K Item 2.02 of a covered ticker in earnings mode.
   * The event is PARKED (`queued`, status_reason `awaiting_scorecard`, no digest kind) because the scorecard push
   * replaces the generic 8-K push: ONE P1 whose lead line is `FY guide cut`, not two. B4 pushes the scorecard (or,
   * at `earnings.push_deadline_seconds`, the generic P1 with the lead line `Guide: unknown - read the 8-K`) and
   * moves the event to `pushed`. Cap-exempt (`notify.p1_cap_exempt`); bypasses quiet hours.
   */
  | 'hold_scorecard'
  /** Quiet hours: nothing pushes (except 8-K Item 2.02 and halts); released via the pre-market payload, NOT as a burst. */
  | 'hold_quiet';

/**
 * A state change the pipeline applies in the SAME transaction as the status update and outbox enqueue. EVERY id
 * in a `link` effect is an EVENT id (`event_links` references `events`; linking to a push id fails the foreign
 * key and would roll back the whole decision, leaving the event unprocessed forever). Push-to-event coverage
 * is recorded in `push_events` by the outbox.
 */
export type BudgetEffect =
  | { type: 'counter'; date: string; name: string; by: number }
  | {
      type: 'link';
      secondaryId: string;
      primaryId: string;
      relation: 'duplicate' | 'rewrite' | 'cluster' | 'overflow';
    }
  | { type: 'mark_events'; ids: string[]; status: EventStatus; reason: string };

/**
 * The budget's verdict for one event. `decide` has NO side effects: it returns this description and the
 * pipeline applies `effects` atomically with the outbox enqueue (so counters and pushes cannot diverge).
 *
 * WORKED EXAMPLE, the P1 cap (`notify.p1_cap` = 6; spec section 6 "collapses into a 'multiple P1s' summary"):
 *  - P1 #1..#6 of the owner-local day: `push_now`, shape `event`, effect `counter p1_pushed +1`.
 *  - P1 #7: `push_now`, shape `p1_overflow_summary`, `push.eventIds = [e7]`, effects `counter p1_folded +1` and
 *    `counter p1_overflow_summary_sent +1`. E7 is the summary's PRIMARY event; the budget also remembers it under
 *    kv `budget:p1_overflow_primary:<date>` (A7 owns the `budget:` prefix).
 *  - P1 #8+: `fold` with `foldedInto = e7` (an EVENT id), effects `link {secondary: e8, primary: e7, relation:
 *    'overflow'}` and `counter p1_folded +1`. No further push is sent; the folded P1s appear in the close recap
 *    (`CloseBrief.events.p1` includes overflow-folded P1s) and the digest.
 *  - Cap-exempt P1s (`notify.p1_cap_exempt`: the 8-K 2.02 / scorecard push, and halts by default) never count
 *    toward the cap and never fold into the summary; they use their own counters (`earnings_pushed`,
 *    `halt_pushed`). Ops alerts are not events and never count.
 *  - Same-ticker halts within `notify.halt_fold_minutes` fold into the first halt's push (`fold`, relation
 *    `duplicate`, primary = the first halt EVENT); a paired volume-pace P1 folds into the same-day price_move
 *    push (`fold`, relation `cluster`).
 */
export interface BudgetDecision {
  action: BudgetAction;
  /** Stored in `events.status_reason` and logged. Deterministic text. */
  reason: string;
  /** For `queue_digest` / `hold_quiet`. */
  digestKind?: DigestKind;
  /** For `push_now`: what shape of push to build. */
  push?: {
    /** `event`: this event alone; `cluster`: 3+ P2s in the window (ONE push); `p1_overflow_summary`: the single "multiple P1s - see digest" push. */
    shape: 'event' | 'cluster' | 'p1_overflow_summary';
    /** All event ids the push covers (includes the triggering event). */
    eventIds: string[];
    /** True when the push bypasses quiet hours (8-K Item 2.02, halts). */
    quietHoursBypass: boolean;
  };
  /** For `fold`: the primary EVENT id this one is folded into (never a push id). */
  foldedInto?: string;
  effects: BudgetEffect[];
}

export interface BudgetInput {
  event: StoredEvent;
  /**
   * Final priority after triage, from {@link resolveFinalPriority}: the verdict applied to the rules priority,
   * or `rulePriority ?? 'P3'` when triage was skipped (so an event no rule fired for queues for the close recap).
   */
  priority: Priority;
  /**
   * Quiet hours, the daily counters and every window are evaluated at THIS instant (decision time), not at
   * `Event.ts`.
   */
  now: Date;
  /**
   * The earnings hook's verdict for this event (S4 asks `EarningsHook.claims` / `foldTargetFor`). `claimed`:
   * an 8-K 2.02 that the scorecard push will cover -> action `hold_scorecard`. `foldIntoEventId`: a
   * `press_release` published within `earnings.fold_press_release_hours` of a claimed 8-K -> `fold` into it
   * (relation `rewrite`), so the same print never produces a second P1.
   */
  earnings?: { claimed: boolean; foldIntoEventId?: string };
}

/**
 * The alert budget (A7, `src/engine/budget.ts`). Semantics, ALL unit-tested with a FakeClock:
 *  - P1: push immediately always; hard cap `notify.p1_cap` (6) per owner-local day; the 7th P1 is the primary of
 *    ONE "multiple P1s - see digest" summary push and the 8th+ FOLD into it (not dropped; they appear in the
 *    digest/close). See the worked example on {@link BudgetDecision}. Cap-exempt: `notify.p1_cap_exempt`.
 *  - P2: queue for the next digest ({@link NextDigestKind}); immediate push only if `p2_cluster.count` (3) P2s
 *    cluster within `window_minutes` (30) -> ONE clustered push, the cluster's other P2s marked delivered/folded.
 *  - P3: close recap only. Macro: always `drop` (context only, never pushes: decision D26). A judged
 *    `material: false` on a non-P1 (read from the stored {@link TriageRecord}) is `drop`.
 *  - Dedupe: by event id (already guaranteed by the insert) and semantic near-duplicates, which the S2.5
 *    {@link SemanticDeduper} attaches BEFORE triage (so the budget rarely sees a secondary). The budget itself
 *    folds: same-ticker halts inside `halt_fold_minutes`, a paired volume-pace P1 into its price_move push, and a
 *    press release into a claimed 2.02 8-K's scorecard push.
 *  - Quiet hours (`notify.quiet_hours`, default 21:00-06:30 America/Chicago, evaluated at `input.now`): nothing
 *    pushes except 8-K Item 2.02 and halts; held items become `hold_quiet` -> `premarket` digest.
 *  - Quiet day: <= 3 pushes total (pre-market, close, <= 1 event) is a deterministic acceptance test; see
 *    `PushCountLine` for what counts (the acceptance test runs with `briefs.writer: scout`).
 */
export interface AlertBudget {
  decide(input: BudgetInput): BudgetDecision;
}

// ---------------------------------------------------------------------------------------------
// Brief payloads (B3 builds them deterministically; every number is computed by Scout)
// ---------------------------------------------------------------------------------------------

export type BriefType =
  'premarket' | 'midday' | 'close' | 'weekly' | 'snapshot' | 'position' | 'plan' | 'scorecard';

export const BRIEF_TYPES: readonly BriefType[] = [
  'premarket',
  'midday',
  'close',
  'weekly',
  'snapshot',
  'position',
  'plan',
  'scorecard',
];

/** The kv prefix (owned by B2's brief jobs; read by B3's API) under which materialized payloads are stored. */
export const BRIEF_KV_PREFIX = 'brief:';

/** kv key of a materialized payload: `brief:<type>:<ticker>:<tradingDate>`. */
export function briefKey(type: BriefType, ticker: string, tradingDate: IsoDate): string {
  return `${BRIEF_KV_PREFIX}${type}:${ticker.toUpperCase()}:${tradingDate}`;
}

/**
 * What the scheduled brief jobs store (kv `brief:`; D21 "pre-compute and store"). The job (06:40 / 11:25 /
 * 15:10 / Sat 07:50, five minutes BEFORE Mayer's crons) builds the payload with `BriefService.build`, stores it
 * here, and calls `events.markDigested` for EXACTLY `eventIds` (idempotent). `/brief/<type>` serves the stored
 * snapshot, so a re-fetch is stable and Mayer's cron can never read a payload the job already drained; with no
 * snapshot it falls back to a live build whose `dataQuality` says `not materialized`. With `briefs.writer =
 * mayer` nothing else ever marks digest events digested (the read-only API cannot), so without this they would
 * reappear in every later digest.
 */
export interface MaterializedBrief<T extends BriefType = BriefType> {
  /** ISO exchange time the payload describes (`payload.asOf`). */
  asOf: string;
  /** ISO UTC when the job built it. */
  builtAt: string;
  /** The queued/held events this brief carries (the ones marked digested). */
  eventIds: string[];
  payload: BriefPayloadMap[T];
}

/** Inputs that were missing/stale when a payload was built, so prose never papers over a gap. */
export interface DataQualityNote {
  /** Component or input name, e.g. `quotes`, `options`, `positions`, `fred`. */
  input: string;
  state: 'missing' | 'stale' | 'degraded';
  detail: string;
}

/** Fields common to every brief payload (and returned by the matching `/brief/<type>` route). */
export interface BriefEnvelope<T extends BriefType> {
  type: T;
  ticker: string;
  /** ISO-8601 with exchange offset. */
  asOf: string;
  /** Exchange trading date this payload is about. */
  tradingDate: IsoDate;
  marketPhase: MarketPhase;
  schemaVersion: 1;
  /** Gaps in the inputs. Empty when everything was fresh. */
  dataQuality: DataQualityNote[];
}

/**
 * A quote as shown in briefs and `/snapshot`. FRESHNESS is explicit: `asOfMs` is the quote's own timestamp
 * (`QuoteTick.tsMs`) and `stale` is true when it is older than `health.quote_stale_seconds` during RTH. Quotes
 * come from a `QuoteSnapshotSource` (the persisted copy kv `quote:<SYMBOL>` for the store-only `BriefService`);
 * a symbol with no quote is `null`, never yesterday's bar passed off as current (`source: 'daily_bar'` says so).
 */
export interface QuoteSummary {
  last: number | null;
  change: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  closePrior: number | null;
  /** (open - closePrior) / closePrior * 100. */
  gapPct: number | null;
  volume: number | null;
  bid: number | null;
  ask: number | null;
  /** Epoch ms of the quote. */
  asOfMs: number | null;
  /** True when older than `health.quote_stale_seconds` during RTH. */
  stale: boolean;
  source: 'stream' | 'rest' | 'daily_bar';
}

export interface VolumeSummary {
  volume: number | null;
  adv20: number | null;
  /** volume / adv20 (end-of-day framing) or the time-adjusted pace during RTH. */
  relativeToAdv: number | null;
  pace: number | null;
  expectedFraction: number | null;
}

export interface RelativePerformance {
  benchmark: string;
  benchmarkChangePct: number | null;
  /** tickerChangePct - benchmarkChangePct, in percentage points. */
  relativePctPoints: number | null;
}

/** One event as shown in a digest/brief. `headline` is Scout-computed from the event; text is untrusted data. */
export interface EventDigestItem {
  eventId: string;
  /** ISO exchange time. */
  ts: string;
  source: EventSource;
  kind: string;
  priority: Priority;
  headline: string;
  soWhat: string | null;
  url: string | null;
  /** Other events folded into this one (e.g. five outlets rewriting one release). */
  foldedCount: number;
}

export interface LevelDistance {
  /** `review_below` or `trim_above` (tranche conditions are free text and are not levels). */
  level: 'review_below' | 'trim_above';
  price: number | null;
  /** (price - last) / last * 100: negative = level is below the current price. */
  distancePct: number | null;
  status: 'unset' | 'not_hit' | 'hit';
}

export interface BreakerStatus {
  /** The owner's text, verbatim. */
  breaker: string;
  /**
   * `hit` only with evidence: a `thesis_breaker` event emitted by B4 for a detector this text maps to
   * (`matchBreakers`); `clear` when it maps to detectors and none fired; `unknown` when Scout cannot evaluate
   * it (no detector matches). Owner-invented breakers never auto-hit.
   */
  status: 'clear' | 'hit' | 'unknown';
  /** The detectors this text maps to (empty = unknown). */
  detectors: BreakerDetectorId[];
  evidenceEventIds: string[];
}

export interface TrancheStatus {
  label: string;
  pctOfTarget: number | null;
  condition: string | null;
  /** Owner-written text; Scout cannot evaluate free-text conditions, so this is informational. */
  note: string | null;
}

/** Plan status lines (spec section 5: one line each). */
export interface PlanStatus {
  planLoaded: boolean;
  completeness: {
    complete: boolean;
    missingCount: number;
    missing: string[];
    /** Sanity warnings (tranche percentages not summing to ~100, review_below not below trim_above). */
    warnings: string[];
  };
  levels: LevelDistance[];
  tranches: TrancheStatus[];
  breakers: BreakerStatus[];
  earningsRule: string | null;
  /** Percent of target shares currently held, or null when target/position unknown. */
  pctOfTargetFilled: number | null;
}

export interface PositionSummary {
  shares: number;
  /** AVERAGE cost per share, USD. */
  averageCost: number | null;
  /** Total cost, USD (`shares * averageCost`). */
  totalCost: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;
  dayPnl: number | null;
  pctOfTargetFilled: number | null;
  asOfMs: number;
  /** `schwab` read-only positions endpoint. */
  source: 'schwab';
}

export interface CalendarItem {
  /** ISO exchange date. */
  date: IsoDate;
  /** `HH:mm` wall-clock with `timeZone`, when known. */
  time: string | null;
  timeZone: string | null;
  label: string;
  kind: 'earnings' | 'earnings_call' | 'holiday' | 'early_close' | 'macro' | 'other';
}

export interface FuturesContext {
  /**
   * From `briefs.futures_symbols` (e.g. `/ES`; UNVERIFIED availability via the broker API) or, when none can
   * be quoted, from `briefs.futures_fallback_symbols` (SPY/IWM pre-market quotes; `kind: 'etf_proxy'`).
   */
  symbol: string;
  kind: 'futures' | 'etf_proxy';
  last: number | null;
  changePct: number | null;
}

export interface MacroContext {
  seriesId: string;
  title: string;
  observationDate: IsoDate;
  value: number | null;
  previousValue: number | null;
}

export interface LlmCostLine {
  todayUsd: number;
  monthUsd: number;
  capDailyUsd: number;
  capMonthlyUsd: number;
  calls: number;
  cacheHitRate: number | null;
}

/**
 * Pushes SCOUT sent today, counted separately: event pushes (alerts, clusters, overflow summaries and the
 * scorecard), digest/brief pushes (only when `briefs.writer = scout`, or the ntfy fallback), and ops alerts.
 * With `briefs.writer = mayer` the pre-market/close messages are Mayer's cron output and are NOT in Scout's
 * `pushes` table, so the spec section 11 "quiet day <= 3 pushes" test asserts Scout-originated pushes <= 1
 * AND that the premarket/close payloads exist and are non-empty; the literal "<= 3 total" is asserted only
 * with `briefs.writer: scout`.
 */
export interface PushCountLine {
  /** Owner-local date. */
  date: string;
  /** All pushes sent (events + digests + ops). */
  sent: number;
  eventPushes: number;
  digestPushes: number;
  opsPushes: number;
  /** Event P1 pushes that counted toward the cap (cap-exempt earnings/halt pushes are in `exemptP1Sent`). */
  p1Sent: number;
  exemptP1Sent: number;
  p1Folded: number;
}

export interface PremarketBrief extends BriefEnvelope<'premarket'> {
  overnightFilings: EventDigestItem[];
  overnightNews: EventDigestItem[];
  /** Events held through quiet hours, released here instead of as a burst of pushes. */
  heldQuietEvents: EventDigestItem[];
  /**
   * P2/P3 events queued for `premarket` OUTSIDE quiet hours: everything that arrived after the previous
   * session's last digest job (a P2 after the 15:10 close job but before 21:00 CT) and on non-session days.
   */
  overnightEvents: EventDigestItem[];
  futures: FuturesContext[];
  premarketQuote: QuoteSummary | null;
  /** Today's calendar (earnings, call time, holidays, early close). */
  calendar: CalendarItem[];
  plan: PlanStatus;
  macro: MacroContext[];
}

export interface MiddayBrief extends BriefEnvelope<'midday'> {
  /** True when there is nothing to say (the job skips the message). */
  isEmpty: boolean;
  /**
   * P2 items queued for `midday` since the previous digest job (decision F15: P3 is CLOSE-recap-only, spec
   * section 6; the spec's "midday digest of P2/P3" in section 4 is superseded).
   */
  events: EventDigestItem[];
  quote: QuoteSummary | null;
  volume: VolumeSummary | null;
}

export interface CloseBrief extends BriefEnvelope<'close'> {
  quote: QuoteSummary | null;
  volume: VolumeSummary | null;
  relative: RelativePerformance[];
  /** `p1` includes P1s that were folded into the "multiple P1s" summary (the digest/close is where they appear). */
  events: { p1: EventDigestItem[]; p2: EventDigestItem[]; p3: EventDigestItem[] };
  position: PositionSummary | null;
  plan: PlanStatus;
  /**
   * Spec section 5, ONE line each: shares, cost basis, unrealized P&L, % of target filled, distance to each
   * level, breaker status (the same formatter as `PositionPayload.lines`).
   */
  planLines: string[];
  pushes: PushCountLine;
  /** The "daily cost line" (spec section 7). */
  llmCost: LlmCostLine;
}

export interface WeeklyBrief extends BriefEnvelope<'weekly'> {
  /** Monday of the week covered (exchange date). */
  weekOf: IsoDate;
  weekChange: { open: number | null; close: number | null; changePct: number | null };
  relative: RelativePerformance[];
  /** All filings in the week. */
  filings: EventDigestItem[];
  /** P1/P2 events. */
  notableEvents: EventDigestItem[];
  eventCounts: { kind: string; count: number }[];
  insiderActivity: {
    buyUsd: number;
    sellUsd: number;
    buyShares: number;
    sellShares: number;
    rows: number;
  };
  shortInterest: {
    settlementDate: IsoDate;
    shortInterest: number;
    daysToCover: number | null;
    changePct: number | null;
  } | null;
  upcomingCatalysts: CalendarItem[];
  plan: PlanStatus;
  /**
   * The thesis, so Mayer's Opus weekly review (which holds none of Scout's files) can assess which pillars
   * strengthened or weakened. `text` is capped at `THESIS_TEXT_MAX_CHARS` (`truncated` says so); `exists` false
   * when no thesis is loaded (`text` null). The path is resolved by `resolveThesisPath`.
   */
  thesis: {
    exists: boolean;
    path: string | null;
    headings: string[];
    sha256: string | null;
    text: string | null;
    truncated: boolean;
  };
  llmCost: LlmCostLine;
}

export interface HealthSummary {
  /** `ok` only when every component is ok. */
  status: 'ok' | 'degraded' | 'down';
  components: {
    component: string;
    status: 'ok' | 'degraded' | 'down' | 'unknown';
    since: string;
    detail: string | null;
  }[];
}

export interface SnapshotPayload extends BriefEnvelope<'snapshot'> {
  quote: QuoteSummary | null;
  volume: VolumeSummary | null;
  /** Move from prior close expressed in 20d-ATR multiples, when computable. */
  atr: { atrPct20: number | null; moveInAtr: number | null } | null;
  relative: RelativePerformance[];
  lastEvents: EventDigestItem[];
  position: PositionSummary | null;
  health: HealthSummary;
}

export interface PositionPayload extends BriefEnvelope<'position'> {
  position: PositionSummary | null;
  /** One line each (spec section 5): shares, cost basis, unrealized P&L, % of target, each level distance, breaker status. */
  lines: string[];
  plan: PlanStatus;
}

export interface PlanPayload extends BriefEnvelope<'plan'> {
  planLoaded: boolean;
  /** The plan with `unset` slots preserved (never filled in by Scout). */
  plan: unknown;
  planHash: string | null;
  status: PlanStatus;
}

/** Cap on `WeeklyBrief.thesis.text`. */
export const THESIS_TEXT_MAX_CHARS = 20_000;

/**
 * Guidance verdict vs the stored prior range (deterministic comparison; decision D21), per metric:
 * midpoint change within +/- `earnings.guidance_epsilon_pct` of the prior midpoint = `held`; both ends up (or one
 * up and one unchanged, "raised low, unchanged high") = `raised`; both down (or one down, one unchanged) =
 * `cut`; one up and one down = `mixed`. B4 normalizes the period key (model output `FY2026` / `Fiscal 2026` /
 * `fiscal year 2026` all become the plan's period label) and the unit (to the consensus unit, USD millions)
 * BEFORE comparing or computing `surprisePct`.
 */
export type GuideVerdict =
  'raised' | 'held' | 'cut' | 'mixed' | 'initiated' | 'withdrawn' | 'unknown';

/**
 * THE lead-line strings (spec sections 8/11, decision F16): exported constants, so the push, the scorecard
 * payload, the acceptance test and B3 can never spell them three ways. ASCII hyphen in the unknown line (the
 * em dash in decision D21 is cosmetic and superseded).
 */
export const LEAD_LINES = {
  raised: 'FY guide raised',
  held: 'FY guide held',
  cut: 'FY guide cut',
  mixed: 'FY guide mixed',
  initiated: 'FY guide initiated',
  withdrawn: 'FY guide withdrawn',
  unknown: 'Guide: unknown - read the 8-K',
} as const satisfies Record<GuideVerdict, string>;

/** The lead line for a verdict. */
export function leadLineFor(verdict: GuideVerdict): string {
  return LEAD_LINES[verdict];
}

/** A guidance range for one metric and fiscal period. */
export interface GuidanceRange {
  metric: string;
  period: string;
  low: number | null;
  high: number | null;
  unit: string;
}

export interface GuidanceDelta {
  metric: string;
  period: string;
  current: GuidanceRange | null;
  prior: GuidanceRange | null;
  verdict: GuideVerdict;
  /** Midpoint change in percent, when both ranges are known. */
  midpointChangePct: number | null;
}

/** One scorecard line item (spec section 8). Values come from Ex. 99.1 extraction; comparisons are computed in code. */
export interface KpiValue {
  value: number | null;
  /**
   * B4 normalizes `value`, `priorQuarter`, `priorYear` and `consensus` to ONE unit per KPI before computing
   * `surprisePct` (consensus revenue is USD millions; a release stating "$462.1 million" and one stating
   * "$462,100,000" must compare).
   */
  unit: 'usd' | 'usd_millions' | 'usd_per_share' | 'pct' | 'count' | 'text';
  priorQuarter: number | null;
  priorYear: number | null;
  /** Consensus (from coverage.yaml) when this KPI has one. */
  consensus: number | null;
  /** (value - consensus) / |consensus| * 100, computed in code. */
  surprisePct: number | null;
  /** Short quote from the release backing the value (untrusted text). */
  evidence: string | null;
}

/** The earnings KPI scorecard (spec section 8: every item listed there has a field). */
export interface ScorecardKpis {
  revenue: KpiValue;
  eps: KpiValue;
  /** DTC / net retail sales. */
  netRetailSales: KpiValue;
  ecommerceDemand: KpiValue;
  /** Retail gross margin vs prior quarter and prior year (those fields on the KpiValue). */
  retailGrossMargin: KpiValue;
  commercialSegment: KpiValue;
  internationalFranchising: KpiValue;
  /** Location openings by type. */
  locationOpenings: { corporate: KpiValue; partnerOperated: KpiValue; franchise: KpiValue };
  tariff: { cost: KpiValue; refund: KpiValue };
  inventory: KpiValue;
  cash: KpiValue;
  revolver: { drawn: KpiValue; capacity: KpiValue };
  buybacks: KpiValue;
  /** Buyback program state (drives the `buyback_suspension` breaker detector). */
  buybackStatus: 'active' | 'reduced' | 'suspended' | 'initiated' | 'unknown';
  dividend: {
    perShare: KpiValue;
    change: 'raised' | 'held' | 'cut' | 'suspended' | 'initiated' | 'unknown';
  };
  /** FY revenue and pre-tax income guide vs prior range (plus any other guided metric). */
  guidance: { revenue: GuidanceDelta; pretaxIncome: GuidanceDelta; other: GuidanceDelta[] };
  /** Holiday quarter-to-date commentary, verbatim excerpt, or null. */
  holidayQtd: { text: string | null; evidence: string | null };
}

export interface ScorecardPayload extends BriefEnvelope<'scorecard'> {
  /** e.g. `Q3 FY26`. */
  period: string;
  accession: string | null;
  /** Release acceptance time. */
  filedAt: string | null;
  sourceUrl: string | null;
  /**
   * Lead line (spec section 8): one of {@link LEAD_LINES} - that is what moves this stock. Computed in code from
   * the guidance deltas; `LEAD_LINES.unknown` when extraction failed or timed out (the P1 is still sent).
   */
  leadLine: string;
  guideVerdict: GuideVerdict;
  /** null when extraction failed or has not run yet. */
  kpis: ScorecardKpis | null;
  extraction: { status: 'ok' | 'failed' | 'pending'; model: string | null; error: string | null };
  /** Pre-market gap %, volume, options-implied move vs actual (when known). */
  reaction: {
    gapPct: number | null;
    volume: VolumeSummary | null;
    optionsImpliedMovePct: number | null;
    actualMovePct: number | null;
  } | null;
  /** Post-call plan-impact lines: which tranche conditions / breakers changed (10:30 CT summary). */
  planImpact: string[];
}

/** Payload type by brief type. */
export interface BriefPayloadMap {
  premarket: PremarketBrief;
  midday: MiddayBrief;
  close: CloseBrief;
  weekly: WeeklyBrief;
  snapshot: SnapshotPayload;
  position: PositionPayload;
  plan: PlanPayload;
  scorecard: ScorecardPayload;
}

export type BriefPayload = BriefPayloadMap[BriefType];

/**
 * Builds brief payloads deterministically from the store/config/clock (B3). Never calls an LLM, never
 * touches the network; reads happen inside one `Store.readTransaction` for a consistent snapshot. It is
 * STORE-ONLY and synchronous: current quotes come from the persisted `quote:<SYMBOL>` copies
 * (`store.latestQuotes`; written by A2's QuoteTracker and the `quotes_snapshot` job, which also keeps
 * benchmarks and futures fresh), exposed through `QuoteSnapshotSource`.
 *
 * `build` NEVER mutates: digest payloads select events with `status = 'queued' AND digest_kind = <type>` (the
 * premarket one also the quiet-hold and after-close queue) and do not mark them digested. Marking is the
 * brief JOB's business, together with storing the result as a {@link MaterializedBrief}.
 */
export interface BriefService {
  build<T extends BriefType>(
    type: T,
    ticker: string,
    opts?: { now?: Date; period?: string },
  ): BriefPayloadMap[T];
}

// ---------------------------------------------------------------------------------------------
// Seams between slots (so parallel agents code against interfaces, never each other's classes)
// ---------------------------------------------------------------------------------------------

/** Prose written around a brief payload. Numbers in `text` must come from the payload (never invented). */
export interface BriefText {
  text: string;
  /** Model that wrote it (`briefs.writer = scout`). */
  model: string;
  costUsd: number;
}

/**
 * Writes finished prose for a brief payload with Sonnet (A8, `src/engine/synth.ts`). Used only when
 * `briefs.writer = scout` or as the fallback when the OpenClaw path is down (decision D21). Instructs the model:
 * cite the source/event for each claim, say "unknown" rather than infer, no buy/sell recommendations - report
 * against the owner's plan.
 */
export interface BriefWriter {
  write<T extends BriefType>(payload: BriefPayloadMap[T]): Promise<BriefText>;
}

/** Weekly thesis review via the Batch API with Opus (A8, `src/engine/deep.ts`); B2's weekly job drives it. */
export interface WeeklyReviewer {
  /** Submit the review for `payload`. Returns a handle to poll. */
  submit(payload: WeeklyBrief): Promise<BatchHandle>;
  /** `null` while the batch is still running; the finished text when done. Throws on item failure. */
  collect(handle: BatchHandle | string): Promise<BriefText | null>;
}

/** One KPI as extracted from Ex. 99.1 by the model (no comparisons: those are computed in code). */
export interface ExtractedKpi {
  value: number | null;
  unit: KpiValue['unit'];
  priorQuarter: number | null;
  priorYear: number | null;
  /** Short verbatim quote backing the value; null when the release does not state it ("unknown", never inferred). */
  evidence: string | null;
}

/** Raw structured extraction of the earnings release. Every field is nullable: "unknown" beats a guess. */
export interface ScorecardExtraction {
  revenue: ExtractedKpi;
  eps: ExtractedKpi;
  netRetailSales: ExtractedKpi;
  ecommerceDemand: ExtractedKpi;
  retailGrossMargin: ExtractedKpi;
  commercialSegment: ExtractedKpi;
  internationalFranchising: ExtractedKpi;
  locationOpenings: {
    corporate: ExtractedKpi;
    partnerOperated: ExtractedKpi;
    franchise: ExtractedKpi;
  };
  tariff: { cost: ExtractedKpi; refund: ExtractedKpi };
  inventory: ExtractedKpi;
  cash: ExtractedKpi;
  revolver: { drawn: ExtractedKpi; capacity: ExtractedKpi };
  buybacks: ExtractedKpi;
  buybackStatus: ScorecardKpis['buybackStatus'];
  dividend: { perShare: ExtractedKpi; change: ScorecardKpis['dividend']['change'] };
  /** Every guided metric the release states (current ranges). Compared to stored history IN CODE. */
  guidance: GuidanceRange[];
  holidayQtd: { text: string | null; evidence: string | null };
}

export type ExtractionOutcome =
  | { status: 'ok'; extraction: ScorecardExtraction; model: string; costUsd: number }
  | { status: 'failed'; error: string };

/**
 * Opus structured extraction of the Ex. 99.1 text (A8, `src/engine/deep.ts`; JSON schema via
 * `output_config.format`, output validated with zod, untrusted text delimited). B4 owns everything after it:
 * guidance comparison, consensus surprise, lead line, push. On `failed` B4 still pushes the P1 with
 * "Guide: unknown - read the 8-K" (decision D21).
 */
export interface ScorecardExtractor {
  extract(input: {
    ticker: string;
    period: string;
    accession: string;
    /** Ex. 99.1 plain text (UNTRUSTED). */
    releaseText: string;
    /** Prior guidance ranges (from `guidance_history`), as context for the model only (comparison is in code). */
    priorGuidance: GuidanceRange[];
    /**
     * Hard bound for the model call (`earnings.extraction_timeout_seconds` x 1000), passed to the gateway as
     * `LlmRequest.timeoutMs`. On expiry the outcome is `failed` and B4 pushes the P1 with
     * `LEAD_LINES.unknown`; the scorecard may still be updated later.
     */
    timeoutMs?: number;
  }): Promise<ExtractionOutcome>;
}

/** Builds the digest push for a brief payload (A7, `src/engine/digest.ts`); `null` when there is nothing to send. */
export interface DigestBuilder {
  buildDigestPush(
    kind: DigestKind,
    payload: PremarketBrief | MiddayBrief | CloseBrief,
  ): AlertMessage | null;
}

/** Component health + alerting (B3, `src/health/`). `/health` and the 15-minute health job both use it. */
export interface HealthMonitor {
  /** Computed from REAL state (adapter last-success ages, token days left, stream state, spend, DB integrity). */
  evaluate(now?: Date): HealthSummary;
  /** `evaluate` + alert on status changes with cooldown, and send a RECOVERY notice (decision D31). */
  checkAndAlert(now?: Date): Promise<HealthSummary>;
}
