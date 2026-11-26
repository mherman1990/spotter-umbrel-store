/**
 * Adapter contracts. Every input to Scout (EDGAR, Schwab quotes/stream, FINRA, FRED, RSS/IR, halts feed,
 * newsletter inbox) is an adapter behind one of the interfaces below, so the rules, briefs and orchestrator
 * depend on INTERFACES and tests inject fakes. Adapters NEVER call an LLM and NEVER decide alert priority
 * beyond what a deterministic rule says.
 *
 * ## The watermark invariant (decision D10) - READ THIS BEFORE WRITING AN ADAPTER
 *
 * An adapter's `poll()` is PURE with respect to Scout's state: it reads upstream and the store (for ADV,
 * prior records), and RETURNS `{events, records, cursor}`. It must not insert events, write watermarks or
 * mark anything "seen". The orchestrator commits events + records + cursor in ONE transaction
 * (`Store.commitPoll`) and only then does anything else. Consequences:
 *
 *  1. The cursor in a `PollResult` means "everything up to here is represented by the returned events".
 *     Never return a cursor that is ahead of what you returned (e.g. do not skip an item you failed to parse:
 *     either throw, or emit a placeholder event, but do not silently drop it and advance).
 *  2. If `poll()` throws, NOTHING is committed and the next poll retries from the previous cursor. Throw
 *     `AuthExpiredError` for human-fix auth problems (the orchestrator raises ONE deduplicated alert and keeps
 *     every other adapter running) and `AdapterError`/`HttpError` for everything else.
 *  3. Events must be idempotent: ids come from `eventId()` with a natural key stable across re-polls (D9).
 *     Re-returning an already-committed event is harmless (INSERT OR IGNORE) - overlap your cursor window
 *     rather than risk a gap.
 *  4. A failure later in the pipeline (triage, LLM, budget, notify) can never un-commit the poll and can never
 *     retire an event unjudged: events stay `new` until triaged.
 *  5. `cursor: undefined` and `cursor: null` MEAN THE SAME: "leave the watermark unchanged". There is no way to
 *     reset a cursor from an adapter (the owner/CLI deletes the watermark, which makes the next poll a baseline).
 *  6. BASELINE. A poll with `ctx.cursor === null` (first run, watermark reset, adapter re-enabled) or
 *     `ctx.mode === 'backfill'` returns HISTORY (EDGAR: the last 40 filings; RSS: ~20 old items; FINRA: every
 *     settlement). Set `PollResult.baseline = true` for it: the orchestrator stores those events as
 *     `dropped`/`baseline` (queryable, never triaged or pushed; invariant I11). Do not try to filter history
 *     yourself by date.
 *  7. SINGLE-FLIGHT. The orchestrator never overlaps two polls of the same (adapter, ticker) (invariant I12):
 *     a tick that finds one in flight is skipped, not queued, so an older cursor can never commit after a newer
 *     one. Honor `ctx.signal` and keep a poll well under its cadence (use `http` options `retries`/`deadlineMs`:
 *     an earnings-mode poll every 30 s must fail fast, not retry for 90 s).
 *
 * ## Untrusted text
 * Anything copied from a filing, press release, feed or email into `payload` is attacker-influenced data.
 * Keep it in clearly named fields (`title`, `summary`, `description`); never build prompts here.
 *
 * ## Dependencies
 * Adapters receive {@link AdapterDeps}; they never construct HTTP clients, clocks or loggers themselves, never
 * read `process.env`, and never import another adapter.
 */
import type { NyseCalendar } from '../core/calendar.js';
import type { Clock, Scheduler } from '../core/clock.js';
import type { PostClient } from '../core/egress-post.js';
import type { HttpClient } from '../core/http.js';
import type { Logger } from '../core/logger.js';
import type { WebSocketFactory } from '../core/ws.js';
import type { CoverageConfig, ResolvedTickerConfig } from '../config/schema.js';
import type { SecretsView } from '../config/secrets.js';
import type { ReadStore } from '../store/index.js';
import type {
  DailyBar,
  DomainRecord,
  Event,
  EventSource,
  IntradayBar,
  MarketPhase,
  OptionChainSnapshot,
  Position,
  QuoteTick,
  Unsubscribe,
} from '../types.js';

export type { QuoteSnapshotSource } from '../types.js';

/**
 * Everything an adapter may use. Built once at the composition root (`src/app.ts`).
 *
 * `post` and `ws` exist for the few AUDITED modules that need them (Schwab OAuth token exchange, FINRA token,
 * Schwab streamer). The policy test (`test/policy/egress.test.ts`) lists exactly which files may call
 * `post.*` / construct sockets; any other adapter using them fails CI.
 */
export interface AdapterDeps {
  clock: Clock;
  /** Timers (stream reconnect backoff, heartbeat staleness, stale-trade timers). Real or `FakeClock`. */
  scheduler: Scheduler;
  /** NYSE calendar: sessions, early closes, business-day math (FINRA publish-lag), phases. */
  calendar: NyseCalendar;
  /** GET/HEAD only. Allowlisted, rate-limited, retried, redacted. Use `http.withUserAgent(...)` once. */
  http: HttpClient;
  /** POST (audited modules only; see above). */
  post: PostClient;
  /** WebSocket factory (Schwab streamer only). */
  ws: WebSocketFactory;
  log: Logger;
  /**
   * READ-ONLY view (`ReadStore`): adapters read prior records and ADV but cannot write events, watermarks or
   * "seen" markers (decision D10; a policy test also fails if `src/adapters/**` names a write API). Components
   * that own state (A2's `token_state`, the quote tracker's `quote:` keys) are constructed with the specific
   * repo they own, not through this object.
   */
  store: ReadStore;
  config: CoverageConfig;
  /**
   * Credentials THIS adapter owns, nothing more: the composition root passes `secrets.scope([...keys])` per
   * adapter, so reading a key outside the scope throws (the RSS adapter cannot read `ANTHROPIC_API_KEY`).
   */
  secrets: SecretsView;
}

/**
 * `normal`: routine cadence. `earnings`: tightened polling on print day. `backfill`: one-off history pull (its
 * results are baseline: `PollResult.baseline = true`). The replay harness runs `normal` with a `FakeClock` set
 * just before the release (after a baseline poll of the pre-release state), so an old filing replays as LIVE.
 */
export type PollMode = 'normal' | 'earnings' | 'backfill';

/** Input to {@link PollAdapter.poll}. */
export interface PollContext {
  /** The covered symbol, or `GLOBAL_TICKER` for `scope: 'global'` adapters. */
  ticker: string;
  /** Resolved config for `ticker` (benchmarks + polling merged); null for global adapters. */
  tickerConfig: ResolvedTickerConfig | null;
  /** All covered tickers (global adapters fan out over these). */
  tickers: readonly ResolvedTickerConfig[];
  /** Opaque cursor committed by the previous successful poll for (adapter id, ticker), or null on first run. */
  cursor: string | null;
  now: Date;
  phase: MarketPhase;
  mode: PollMode;
  /** Aborted on shutdown; pass to `http.get(..., {signal})`. */
  signal: AbortSignal;
}

/** Output of {@link PollAdapter.poll}. See the watermark invariant at the top of this file. */
export interface PollResult {
  /** New facts. May be empty. Order is irrelevant (ids dedupe). */
  events: Event[];
  /** Rows to persist atomically with the events (filings, form4 rows, bars, observations...). */
  records?: DomainRecord[];
  /**
   * New opaque cursor to commit after the events are durable. `undefined` = leave unchanged (e.g. nothing
   * new, or the upstream said not-modified). Never ahead of what `events` represents.
   */
  cursor?: string | null;
  /**
   * HISTORY, not news: this poll is the first run, a backfill, or a re-enabled adapter (`ctx.cursor === null` or
   * `ctx.mode === 'backfill'`). The events are persisted as `dropped`/`baseline` (still queryable by briefs and
   * `/events`) and run through no rules, triage or push. See the baseline note at the top of this file.
   */
  baseline?: boolean;
  /** The upstream reported "unchanged" (304 / same validator); no work was done. */
  notModified?: boolean;
  /** Small diagnostics for logs and `/health` (counts, ages). No secrets. */
  stats?: Record<string, number | string | boolean>;
}

/** Context for deciding how often to poll right now. */
export interface PollScheduleContext {
  phase: MarketPhase;
  mode: PollMode;
  config: CoverageConfig;
  /** Resolved ticker config for per-ticker adapters; null for global adapters. */
  ticker: ResolvedTickerConfig | null;
  now: Date;
}

export interface AuthCheckResult {
  ok: boolean;
  /** Human-readable, secret-free (e.g. `refresh token valid for 3.2 more days`). */
  detail: string;
  /** When the credential expires, when known. */
  expiresAt?: string | null;
  daysLeft?: number | null;
}

/** One check run by `scout verify-live` / `scout doctor` on the Pi (docs/VERIFY_LIVE.md). */
export interface LiveCheckResult {
  /** Stable name, e.g. `edgar.submissions.shape`. */
  name: string;
  ok: boolean;
  detail: string;
  /**
   * The `UNVERIFIED:` assumptions (from code comments) this check confirms or refutes, so VERIFY_LIVE.md can
   * be reconciled with reality.
   */
  unverified?: string[];
}

/** Optional capability: adapters implement it to take part in `scout verify-live`. */
export interface LiveVerifiable {
  verifyLive?(): Promise<LiveCheckResult[]>;
}

/**
 * A polled input. One instance serves every covered ticker (`scope: 'ticker'`: the orchestrator calls
 * `poll` once per ticker with that ticker's cursor) or runs once globally (`scope: 'global'`: ticker =
 * `GLOBAL_TICKER`, cursor keyed on it).
 *
 * @example
 * ```ts
 * export function createEdgarAdapter(deps: AdapterDeps): PollAdapter {
 *   const http = deps.http.withUserAgent(buildUserAgent('scout-edgar', deps.secrets.require('SCOUT_SEC_CONTACT')));
 *   return {
 *     id: 'edgar.submissions',
 *     scope: 'ticker',
 *     sources: ['filing'],
 *     pollEveryMs: ({ phase, mode, ticker, config }) => mode === 'earnings' ? 30_000 : ...,
 *     async poll(ctx) { ...; return { events, records, cursor: newestAccessionTime }; },
 *   };
 * }
 * ```
 */
export interface PollAdapter extends LiveVerifiable {
  /** Stable id; doubles as the watermark `source` key and the `health_state` component name. */
  readonly id: string;
  readonly scope: 'ticker' | 'global';
  /** Event sources this adapter emits (documentation + health grouping). */
  readonly sources: readonly EventSource[];
  /**
   * Milliseconds between polls right now, or `null` to not poll now (e.g. RTH-only adapter outside RTH, or
   * disabled in config). Cadence comes from `config.polling` (spec sections 2 and 8). The scheduler calls this
   * before each tick, so changing mode/phase takes effect without a restart.
   */
  pollEveryMs(ctx: PollScheduleContext): number | null;
  poll(ctx: PollContext): Promise<PollResult>;
  /** Cheap credential check (one call, explicit timeout). Used by health and `scout doctor`. */
  authCheck?(): Promise<AuthCheckResult>;
}

/** Factory convention: `create<Name>Adapter(deps)` returns the adapter; no work at construction. */
export type PollAdapterFactory = (deps: AdapterDeps) => PollAdapter;

// ---------------------------------------------------------------------------------------------
// Streaming (quotes)
// ---------------------------------------------------------------------------------------------

/** Lifecycle of the quote stream. */
export type StreamState = 'stopped' | 'connecting' | 'connected' | 'reconnecting' | 'auth_failed';

export interface StreamStatus {
  state: StreamState;
  /** Epoch ms when `state` last changed. */
  sinceMs: number;
  /** Epoch ms of the last message of any kind (heartbeat included), or null. */
  lastMessageMs: number | null;
  /** Epoch ms of the last QUOTE tick, or null. */
  lastTickMs: number | null;
  reconnects: number;
  /** Secret-free detail (e.g. `LOGIN denied (code 3)`). */
  detail: string | null;
}

/**
 * A push-based quote source. Only ONE streamer connection per user may exist (decision D13): never start two.
 * `onTick` always delivers a FULLY MERGED tick (the streamer sends deltas; the adapter merges per symbol).
 * `stop()` must close the socket and clear timers so graceful shutdown completes.
 */
export interface StreamAdapter extends LiveVerifiable {
  readonly id: string;
  /** Connect (idempotent). Resolves when the first connection attempt has been scheduled/started. */
  start(symbols: readonly string[]): Promise<void>;
  /** Replace the subscription set (additions/removals take effect on the live socket). */
  setSymbols(symbols: readonly string[]): void;
  stop(): Promise<void>;
  onTick(listener: (tick: QuoteTick) => void): Unsubscribe;
  onStatus(listener: (status: StreamStatus) => void): Unsubscribe;
  status(): StreamStatus;
}

/**
 * Mutable tracking facts about a symbol's quote stream, for the halt heuristics (decision D14). Implemented by
 * A2's `QuoteTracker`; the rule context builder (B1) reads it.
 */
export interface QuoteTrackingSource {
  tracking(symbol: string): { previousStatus: string | null; lastTradeChangeMs: number | null };
}

/**
 * REST market-data + account-read surface the rules and briefs depend on (never the Schwab classes directly).
 * READ-ONLY by construction: there is no method that could place, stage or modify an order.
 * Authentication failures surface as `AuthExpiredError`; transient failures as `HttpError`/`AdapterError`.
 */
export interface QuoteProvider extends LiveVerifiable {
  readonly id: string;
  getQuote(symbol: string): Promise<QuoteTick>;
  getQuotes(symbols: readonly string[]): Promise<QuoteTick[]>;
  /**
   * Up to `n` most recent daily bars, OLDEST FIRST. The last bar is the still-forming CURRENT bar while the
   * session is open: callers persist today's bar only after the close (market phase `afterhours` or later) and
   * must never store a partial bar as final. `atr20` is a cache the metrics code recomputes from bars.
   */
  getDailyBars(symbol: string, n: number): Promise<DailyBar[]>;
  getIntradayBars(
    symbol: string,
    opts: { intervalMinutes: 1 | 5 | 10 | 15 | 30; days: number; extendedHours?: boolean },
  ): Promise<IntradayBar[]>;
  /** Full chain within the requested strike/DTE window; IVs in percent. */
  getOptionChain(
    symbol: string,
    opts?: { strikeCount?: number; maxDaysToExpiration?: number },
  ): Promise<OptionChainSnapshot>;
  /** Positions aggregated across accounts by symbol (account identifiers are never exposed). */
  getPositions(): Promise<Position[]>;
}

// ---------------------------------------------------------------------------------------------
// Filing documents
// ---------------------------------------------------------------------------------------------

export interface FilingDocument {
  url: string;
  contentType: string | null;
  /** Document text (HTML tags stripped for HTML documents). UNTRUSTED. */
  text: string;
  bytes: number;
  /** True when `maxBytes` cut the document short. */
  truncated: boolean;
}

/**
 * Fetches filing documents for parsing/LLM extraction (separate from polling so the earnings path and tests
 * can inject it). All requests go through the allowlisted HTTP client.
 */
export interface FilingFetcher {
  fetchDocument(url: string, opts?: { maxBytes?: number }): Promise<FilingDocument>;
  /**
   * Find the Exhibit 99.1 (earnings press release) of an 8-K by parsing the filing index (decision D11:
   * `index.json` lists names only, so the `<accession>-index.htm` Type column is parsed), then fetch it.
   * Returns null when the filing has no EX-99.1.
   */
  fetchPressReleaseExhibit(args: {
    cik: string;
    accession: string;
  }): Promise<{ url: string; document: FilingDocument } | null>;
}

// ---------------------------------------------------------------------------------------------
// OAuth session (A2 implements for Schwab; B2's CLI and token_check job consume)
// ---------------------------------------------------------------------------------------------

export type OAuthState = 'unauthorized' | 'ok' | 'expiring' | 'expired' | 'error';

export interface OAuthStatus {
  state: OAuthState;
  /** When the CURRENT refresh token stops working (issued + 7 days for Schwab), or null. */
  refreshExpiresAt: string | null;
  hoursLeft: number | null;
  /** Secret-free last error. */
  lastError: string | null;
}

/**
 * Reminder identifiers; map 1:1 to `token_state.sent_24h|sent_6h|sent_expired`. The three reminders are FIXED
 * (T-24h, T-6h, expired; decision D12): there is no configurable `reminder_hours`.
 */
export type TokenReminder = 'sent24h' | 'sent6h' | 'sentExpired';

/** The `token_state.id` of the Schwab OAuth row (the only one). Callers never guess this literal. */
export const TOKEN_STATE_ID = 'schwab';

/**
 * The owner-initiated OAuth lifecycle (decision D12). `scout schwab-auth` prints `authorizeUrl()`, the owner
 * pastes the redirect URL, `completeLogin` exchanges the single-use code. The agent NEVER enters credentials
 * or completes this flow itself.
 */
export interface OAuthSession {
  authorizeUrl(): string;
  /** Accepts the full pasted redirect URL (or a bare code; `%40` is URL-decoded). Stores tokens encrypted. */
  completeLogin(redirectUrlOrCode: string): Promise<OAuthStatus>;
  status(now?: Date): OAuthStatus;
  /** Reminders whose time has come and that have not been marked sent. The caller sends, then marks. */
  dueReminders(now?: Date): TokenReminder[];
  /**
   * Mark `reminder` sent (`token_state`, id {@link TOKEN_STATE_ID}). Returns true when this call set the flag
   * (the caller sends exactly once); false when it was already marked. B2's `token_check` job calls this AFTER
   * its ops alert was enqueued: without it a reminder either never marks (hourly spam) or marks wrongly.
   */
  markReminderSent(reminder: TokenReminder, now?: Date): boolean;
}
