/**
 * THE ORCHESTRATION CONTRACT (owned by B1, `src/engine/pipeline.ts` + `orchestrator.ts`):
 *
 *     poll -> insert -> rules -> (dedupe) -> triage -> budget -> outbox -> notify
 *
 * This file contains only types and the invariants the implementation and its tests must honor. It is the
 * single place that says what may happen in which order and what a failure at each stage means.
 *
 * ## Stages and the event lifecycle (`events.status`)
 *
 * ```
 *  adapter.poll() ──► [S1 COMMIT] ──► status 'new'               (baseline/stale history: 'dropped', I11)
 *                      Store.commitPoll: events + records + watermark in ONE transaction
 *  'new' ──► [S2 RULES] classify (rule_priority; the WHOLE batch first: cheap and pure)
 *        ──► [S2.5 DEDUPE] SemanticDeduper: a secondary attaches to its primary -> 'folded', NO LLM call
 *        ──► [S3 TRIAGE] drained in PRIORITY order (rules-P1 first, then oldest) ──► 'triaged' (final_priority set)
 *            judged | skipped  -> 'triaged'
 *            failed            -> stays 'new', attempts++ (retry with backoff) -- EXCEPT a rules-P1 / halt / 2.02
 *                                 event, which proceeds as `skipped` (deadline | error) and is never dropped (I2)
 *  'triaged' ──► [S4 BUDGET] decide() ─┬─ push_now       -> 'pushed'  + outbox row (same transaction)
 *                                      ├─ queue_digest   -> 'queued'  (digest_kind = midday|close|premarket)
 *                                      ├─ hold_quiet     -> 'queued'  (digest_kind = premarket)
 *                                      ├─ hold_scorecard -> 'queued'  (reason awaiting_scorecard; B4 pushes it, I13)
 *                                      ├─ fold           -> 'folded'  (+ event_links, EVENT ids only)
 *                                      └─ drop           -> 'dropped'
 *  outbox 'pending' ──► [S5 NOTIFY] router.route() ─┬─ delivered -> push 'sent'
 *                                                   └─ failed    -> push stays 'pending' (retry with backoff,
 *                                                                   ntfy fallback); 'failed' only after max attempts
 *  'queued' ──► digest/brief job sends ──► 'digested'
 * ```
 *
 * ## Invariants (decision D10; each needs a test in B1's pipeline tests)
 *
 *  I1. COMMIT BEFORE CURSOR. A source's watermark advances only inside the same transaction that durably
 *      inserts its events and records. A crash between "fetched" and "committed" re-polls the same window. A
 *      malformed event THROWS in `commitPoll` and rolls the whole commit back (loud, never silently lost).
 *  I2. NO UNJUDGED RETIREMENT, AND NO P1 HELD HOSTAGE BY THE LLM. An event leaves `new` only by being triaged
 *      (judged OR skipped by policy). A triage/LLM exception, refusal, timeout or spend-cap condition-with-retry
 *      never moves an ORDINARY event forward and never drops it; the next due pass retries (`attempts` +
 *      `last_error` recorded; backoff derived from `attempts` + `updated_at`: `EventsRepo.untriagedDue`).
 *      EXCEPTION (decision F17): a rules-P1 event, every halt and every 8-K Item 2.02 never waits on the model
 *      (Haiku only supplies the so-what and P3 -> P2 upgrades): after `pipeline.triage_deadline_seconds`, or
 *      at once on a non-retryable failure, `triageFallback` records triage `skipped` (reason `deadline` /
 *      `error`) and the event proceeds to S4 with `final = rulePriority`; the so-what is optional. Such an
 *      event is never dropped as `unprocessable`. (Spec section 11 needs the P1 within 5 minutes.)
 *  I3. NOTIFY FAILURE KEEPS THE PUSH. The push row is created in the SAME transaction that sets the event
 *      `pushed`; sending happens afterwards from the outbox. A failed send leaves the push `pending` for
 *      retry/fallback; it never reverts the event nor loses the message.
 *  I4. IDEMPOTENT EVERYWHERE. Re-running any stage on the same input is harmless: events insert-or-ignore by
 *      id; pushes insert-or-ignore by `idempotency_key`; status transitions are guarded by the expected prior
 *      status (`setStatus(..., {expect})`, `markTriaged`); the hook carries the same `Idempotency-Key`.
 *  I5. RULES DECIDE, MODELS ADVISE. `final_priority` = `resolveFinalPriority(rulePriority, outcome)`: for a
 *      verdict `applyTriage` (the model may upgrade P3 -> P2 and never downgrade a rules-assigned priority nor
 *      create a P1); for a `skipped` triage `rulePriority ?? 'P3'` (an event no rule fired for queues for the
 *      close recap). The verdict is stored as a `TriageRecord`; `material: false` on a non-P1 makes the BUDGET
 *      drop the event.
 *  I6. ONE TRANSACTION PER DECISION. Applying a `BudgetDecision` (status change, `effects`, outbox enqueue)
 *      is atomic; counters can never diverge from pushes. Link effects relate EVENT ids only.
 *  I7. ISOLATION. One adapter's failure (including `AuthExpiredError`) is recorded in `health_state` (B1 writes
 *      only the raw `adapter:<id>:<ticker>` facts; B3's monitor derives status and alerts), raises at most ONE
 *      deduplicated ops alert per cooldown (`OPS_KEYS`), and does not stop other adapters or stages.
 *  I8. NO DATA-DEPENDENT EXCEPTIONS ESCAPE. A malformed event/record (detected with `parseEventPayload`) fails
 *      that item (logged, counted), not the loop. An unprocessable NON-P1 event gets `last_error` and is retried
 *      up to `pipeline.triage_max_attempts`, then marked `dropped` with reason `unprocessable` (the ONLY
 *      non-judged exit, explicit and logged). A rules-P1 is never dropped this way (see I2).
 *  I9. MACRO NEVER PUSHES. `source = 'macro'` events (ticker `GLOBAL_TICKER`) end `dropped` (context only) with
 *      reason `context_only` BEFORE rules and triage: no rule context exists for a global ticker.
 *  I10. QUIET HOURS RELEASE AS DATA. `hold_quiet` events appear in the pre-market payload; they are never
 *      released as a burst of pushes.
 *  I11. BASELINE IS HISTORY, NOT NEWS. A poll with no cursor (first run, watermark reset, re-enabled adapter) or
 *      `mode: 'backfill'` is a BASELINE (`PollResult.baseline`): its events are stored `dropped`/`baseline`,
 *      run through no rules, triage, budget or earnings hook, and never push; they stay queryable by briefs and
 *      `/events`. Non-baseline events older than `pipeline.max_event_age_hours` (outage catch-up) are stored
 *      `dropped`/`stale` the same way, so recovery from an outage still pushes a RECENT 8-K but a three-day-old
 *      one is history. Without this, deploy day burns the whole P1 cap on old 8-Ks. The REPLAY harness runs
 *      `mode: 'normal'` with a `FakeClock` set just before the release, after a baseline poll of the
 *      pre-release state, so an old filing replays as live.
 *  I12. SINGLE-FLIGHT POLLS. Never two polls of the same (adapter, ticker) at once: a tick that finds one in
 *      flight is SKIPPED, not queued (so an older cursor can never commit after a newer one, and a 30 s
 *      earnings cadence cannot pile up behind a 90 s retry chain). `pollOnce` aborts via `ctx.signal` on stop.
 *  I13. ONE P1 PER PRINT. An 8-K Item 2.02 that `EarningsHook.claims` is parked (`hold_scorecard`) instead of
 *      pushed generically; B4's scorecard push replaces it (lead line `LEAD_LINES.*`) and counts once (cap-exempt,
 *      `earnings_pushed`). If no scorecard is ready at `earnings.push_deadline_seconds`, B4 pushes the generic P1
 *      with `Guide: unknown - read the 8-K`. A press release within `earnings.fold_press_release_hours` folds
 *      into it. The acceptance test asserts the exact P1 count of the replay.
 *  I14. PRIORITY DRAIN ORDER. `processPending` runs S2 over the whole batch first, then drains S2.5-S4 ordered
 *      by effective priority (`byStatus(..., {order: 'priority'})`: P1, P2, P3, unclassified; oldest first within
 *      a priority): a fresh 8-K is never stuck behind a backlog of news.
 */
import type { NyseCalendar } from '../core/calendar.js';
import type { Clock, Scheduler } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { ConfigSource } from '../config/schema.js';
import type { PositionPlan } from '../config/plan.js';
import type { PollAdapter, PollMode, QuoteTrackingSource } from '../adapters/types.js';
import type { FlushSummary, NotifyRouter } from '../notify/types.js';
import type { Store } from '../store/index.js';
import type { DomainRecord, Event, QuoteSnapshotSource } from '../types.js';
import type { StoredEvent } from '../store/repos/events.js';
import type {
  AlertBudget,
  BuildClusterMessage,
  BuildOverflowMessage,
  DescribeEvent,
  EventFromHit,
  MetricFunctions,
  RuleEngine,
  SemanticDeduper,
  Triager,
} from './types.js';

/**
 * What `processPending({evaluateMarket: true})` needs to build a `RuleContext` for market rules (price,
 * volume pace, halts, options, plan levels). Injected, never reached for: B1 must not define its own extension of
 * a locked type.
 */
export interface MarketDeps {
  calendar: NyseCalendar;
  /** The latest merged quote per symbol (A2's QuoteTracker in memory; the persisted copy otherwise). */
  quotes: QuoteSnapshotSource;
  /** Halt-heuristic facts (previous status, last trade-change time). */
  tracker: QuoteTrackingSource;
  /** `computeAtr` / `computeVolumePace` (A6). */
  metrics: Pick<MetricFunctions, 'computeAtr' | 'computeVolumePace'>;
}

/** Everything the pipeline needs, injected (no singletons). */
export interface PipelineDeps {
  clock: Clock;
  scheduler: Scheduler;
  log: Logger;
  store: Store;
  /**
   * Read the CURRENT config per use (`ConfigHolder.current()`), never cache the object: `earnings.consensus`
   * and thresholds are editable live (decision F18).
   */
  config: ConfigSource;
  /** Current plan (reloaded by the scheduler when the file changes); `null` when none is loaded. */
  getPlan(): PositionPlan | null;
  rules: RuleEngine;
  /** S2.5; absent = no semantic dedupe (tests). */
  dedupe?: SemanticDeduper;
  triage: Triager;
  budget: AlertBudget;
  router: NotifyRouter;
  /** Market-rule inputs for `evaluateMarket`. */
  market: MarketDeps;
  /** Shared message builders (A7) and derived-event builder (A6): B1 never assembles headline strings. */
  describe: DescribeEvent;
  buildClusterMessage: BuildClusterMessage;
  buildOverflowMessage: BuildOverflowMessage;
  eventFromHit: EventFromHit;
  /** Earnings hook (B4): called after an event is committed so a 2.02 8-K can trigger the scorecard path. */
  earnings?: EarningsHook;
}

/**
 * The seam between the pipeline and B4's earnings path.
 *
 * `onNewEvent` is called for every NEWLY INSERTED (status `new`, never baseline) event after S1; it never blocks
 * or fails the pipeline (errors are caught and logged). B4's implementation reacts to an 8-K with Item 2.02 for a
 * covered ticker in earnings mode: fetch Ex. 99.1, extract (Opus, bounded by `earnings.extraction_timeout_seconds`),
 * compare guidance in code, push the scorecard P1 within 5 minutes.
 *
 * `claims` and `foldTargetFor` are SYNCHRONOUS, PURE reads that S4 asks on every decision (so a restart between
 * S2/S3 and S4 does not change the answer): they implement invariant I13.
 */
export interface EarningsHook {
  onNewEvent(event: StoredEvent): Promise<void>;
  /**
   * True for an 8-K carrying Item 2.02 whose ticker has an `earnings` block and is inside the earnings-mode
   * window (`PollModeProvider.modeFor(...) === 'earnings'`). S4 then asks the budget for `hold_scorecard`.
   */
  claims(event: StoredEvent): boolean;
  /**
   * For a `press_release` event published within `earnings.fold_press_release_hours` of a claimed 2.02 8-K: that
   * 8-K's event id (S4 folds the release into it, relation `rewrite`); otherwise `undefined`.
   */
  foldTargetFor(event: StoredEvent): string | undefined;
}

/**
 * Decides the poll mode per ticker (B4, `src/engine/earnings/mode.ts`): `earnings` from `earnings.mode_start_ct`
 * on the print date until `earnings.post_call_summary_ct` (10:30 CT by default, the same key that schedules the
 * post-call summary), else `normal`. The orchestrator passes it to adapters and `pollEveryMs`, so EDGAR/IR
 * tighten to 30 s without a restart. Reads the CURRENT config (a consensus/date edit applies live).
 */
export interface PollModeProvider {
  modeFor(ticker: string, now: Date): PollMode;
}

/** Input to stage S1 for one poll of one adapter/ticker. */
export interface IngestArgs {
  adapterId: string;
  ticker: string;
  events: readonly Event[];
  records?: readonly DomainRecord[];
  /** `null`/`undefined`: leave the watermark unchanged (they mean the same thing). */
  cursor?: string | null | undefined;
  /** `PollResult.baseline`: store the events as `dropped`/`baseline` (invariant I11). */
  baseline?: boolean | undefined;
}

export interface IngestOutcome {
  /** Newly inserted events (status `new`). */
  inserted: number;
  duplicates: number;
  /** Newly stored as `dropped`/`baseline`. */
  baselined: number;
  /** Newly stored as `dropped`/`stale`. */
  stale: number;
  watermarkAdvanced: boolean;
}

/** One pass of stages S2-S4 over pending events. */
export interface ProcessOutcome {
  /** Events that finished the triage step (judged or skipped). */
  triaged: number;
  /** Events left `new` after a failure (will retry). */
  retrying: number;
  pushed: number;
  queued: number;
  held: number;
  folded: number;
  dropped: number;
  /** Per-event errors (message only), for logs/health. */
  errors: { eventId: string; error: string }[];
}

/**
 * The event pipeline. All methods are safe to call concurrently with themselves via an internal mutex (SQLite
 * single-writer); callers may fire-and-forget from timers.
 */
export interface Pipeline {
  /** S1: durable commit of one poll result (I1, I11). Never throws for duplicate events. */
  ingest(args: IngestArgs): IngestOutcome;
  /**
   * S2-S4: drain events in status `new`/`triaged` in PRIORITY order (invariant I14; rules-P1 first, then
   * oldest), up to `limit`. Evaluates market rules too when `evaluateMarket` is true
   * (price/volume/halt/options/plan levels -> derived events -> S1 -> S2-S4).
   */
  processPending(opts?: { limit?: number; evaluateMarket?: boolean }): Promise<ProcessOutcome>;
  /** S5: drain the outbox through the router (I3). Delegates to the A5 `OutboxWorker`. */
  flushOutbox(): Promise<FlushSummary>;
}

/**
 * Runs poll adapters on their cadence (`PollAdapter.pollEveryMs`), isolating failures (I7) and never overlapping
 * two polls of the same (adapter, ticker) (I12).
 */
export interface PollOrchestrator {
  /** Run one adapter for one ticker once (scheduler/tests/CLI `scout poll <adapter>`). */
  pollOnce(adapter: PollAdapter, ticker: string, mode?: PollMode): Promise<PollRunOutcome>;
  /** Start timers for all registered adapters; returns when started. */
  start(): void;
  /** Stop timers and abort in-flight polls (graceful shutdown). */
  stop(): Promise<void>;
}

export interface PollRunOutcome {
  adapterId: string;
  ticker: string;
  ok: boolean;
  /** True when a poll of this (adapter, ticker) was already in flight and this tick was skipped (I12). */
  skipped?: boolean;
  ingest?: IngestOutcome;
  /** Secret-free error message when `ok` is false. */
  error?: string;
  /** True when the failure was `AuthExpiredError` (human action required). */
  authExpired?: boolean;
  durationMs: number;
}
