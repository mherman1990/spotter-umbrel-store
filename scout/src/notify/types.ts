/**
 * Notification contracts. Scout never talks to Telegram itself: P1s and clustered P2s go to Mayer
 * (OpenClaw hook) with an ntfy fallback (decisions D15-D17). Notifiers know nothing about rules, budget or
 * the database; they take an {@link AlertMessage} and report what happened.
 */
import type { Priority } from '../types.js';

/** What kind of message this is (mirrors `pushes.kind`). */
export type AlertKind = 'alert' | 'digest' | 'brief' | 'ops';

/**
 * One outbound message. Built by the pipeline from event(s) + budget decision and stored whole in
 * `pushes.body_json`, so retries and fallbacks re-send exactly this.
 *
 * EVERY message is built from the shared builders in `src/engine/describe.ts` (A7): `describeEvent` for a
 * single event, `buildClusterMessage` / `buildOverflowMessage` for cluster and "multiple P1s" pushes. B1 (push),
 * B3 (digest items) and B4 (scorecard) never assemble headline strings themselves, so four slots cannot invent
 * four formats. The builders are pure functions of the persisted payload, so a message can be rebuilt after a
 * restart even though `RuleHit.reason` is not stored.
 *
 * Content rules (spec section 6): `headline` <= 280 chars, ONE-line `soWhat`, plus a source link. Numbers in
 * `facts` are computed by Scout (never by a model). Text copied from filings/news is untrusted; notifiers
 * must not interpret it.
 */
export interface AlertMessage {
  kind: AlertKind;
  /** Covered symbol, or `*` for system-wide ops messages. */
  ticker: string;
  priority: Priority;
  /** <= {@link MAX_HEADLINE_CHARS} after `formatPush`. */
  headline: string;
  /** One line. In `compose` mode this is Scout's SUGGESTED so-what (Mayer may rewrite it). */
  soWhat?: string;
  /** Structured, Scout-computed facts for the hook payload (and for Mayer to write prose around). */
  facts: Record<string, unknown>;
  sourceUrl?: string;
  /** Events this message covers (cluster/digest messages list several). */
  eventIds: string[];
  /** Stable per message; becomes the `Idempotency-Key` header and the outbox unique key. */
  idempotencyKey: string;
  /** Model that produced `soWhat`/body, for transparency (`claude-haiku-5-5`), when any. */
  model?: string;
  /**
   * Finished plain text for kinds that are not a single alert (digest, brief fallback, ops) and for `relay`
   * mode. When absent, the notifier renders from headline/soWhat/link.
   */
  bodyText?: string;
  /** Set by the budget for 8-K Item 2.02 / halts that bypass quiet hours (informational). */
  quietHoursBypass?: boolean;
  /**
   * Which OpenClaw endpoint carries it: `hook` (default, the mapped `/hooks/<name>` hook) or `agent` (direct
   * `/hooks/agent` call with a per-call model override, used for the earnings-day scorecard, decision D21).
   * The router tries the chosen OpenClaw route first and falls back to ntfy with finished text either way.
   */
  route?: 'hook' | 'agent';
}

/** Result of one delivery attempt on one channel. */
export interface SendResult {
  ok: boolean;
  /**
   * `sent`: accepted by the channel. `failed`: transient (outage/timeout/5xx/429) - retry or fall back.
   * `rejected`: permanent (401/403/400): retrying the same request is pointless, a human must fix config.
   * `skipped`: channel not configured/enabled.
   */
  status: 'sent' | 'failed' | 'rejected' | 'skipped';
  /** Secret-free, short (e.g. `HTTP 202`, `ECONNREFUSED`, `OPENCLAW_HOOK_TOKEN not set`). */
  detail: string;
  /** Channel id that produced this result. */
  channel: string;
  httpStatus?: number;
  /** True when the same message may succeed on retry. */
  retryable: boolean;
}

/**
 * A delivery channel (`openclaw`, `ntfy`). Implementations: POST via the audited `PostClient`, never throw for
 * delivery problems (return a `SendResult`), throw only for programmer errors.
 *
 * ntfy: publish as JSON (`{topic, title, message, priority, click}`) to the BASE URL: the POST path allowlist
 * (`buildPostPathAllowlist`) permits only the configured base path, and on a public server the topic is the
 * credential, so it must travel in the body, never in the URL (logs, errors and `safeUrl` would carry it).
 */
export interface Notifier {
  readonly id: string;
  send(message: AlertMessage): Promise<SendResult>;
}

/** What the router reports after trying its channels in order. */
export interface RouteResult {
  /** True when some channel accepted the message. */
  delivered: boolean;
  /** Channel that delivered it, when delivered. */
  channel: string | null;
  /** Every attempt made, in order (for the outbox `last_error` and outage logging). */
  attempts: SendResult[];
  /** True when the primary channel failed and a fallback delivered (an "outage" signal). */
  usedFallback: boolean;
}

/**
 * Tries the primary notifier, falls back on failure (decision D17: OpenClaw gateway down -> ntfy), and logs
 * the OUTAGE ONCE per outage window (+ a recovery log). Owned by A5.
 *
 * The ntfy fallback runs when the primary result is `failed` (outage) AND when it is `rejected` (a 401 from a
 * bad hook token is permanent for OpenClaw, which is exactly when the owner still needs the alert); a
 * `rejected` result additionally raises ONE config ops alert (`OPS_KEYS.OPENCLAW_REJECTED`). `skipped`
 * (channel not configured) never counts as an outage.
 */
export interface NotifyRouter {
  route(message: AlertMessage): Promise<RouteResult>;
}

/** Summary of one outbox drain (owned by A5, called by the scheduler and after each pipeline pass). */
export interface FlushSummary {
  attempted: number;
  sent: number;
  /** Failed but will retry. */
  retrying: number;
  /** Gave up (max attempts). */
  failed: number;
  /** Pending pushes not yet due. */
  deferred: number;
}

/**
 * Drains the `pushes` outbox through the router with retry/backoff. Never loses a push on failure.
 *
 * SINGLE-FLIGHT: `flush` holds an in-process mutex (a scheduled flush overlapping the post-pass flush waits or
 * returns an empty summary) AND selects rows with `OutboxRepo.claimDue(now, notify.outbox.lease_seconds)`, which
 * leases them (`next_attempt_at` pushed forward). Without both, two flushes send the same push twice (ntfy has
 * no idempotency key; OpenClaw does).
 */
export interface OutboxWorker {
  flush(now?: Date): Promise<FlushSummary>;
}

// ---------------------------------------------------------------------------------------------
// formatPush contract (implemented by the budget agent, A7, in src/engine/format-push.ts)
// ---------------------------------------------------------------------------------------------

/** Hard limit on a push headline (spec section 6). */
export const MAX_HEADLINE_CHARS = 280;
/** Marker appended when text is truncated. */
export const TRUNCATION_MARK = '…';

/** A message normalized to the spec's push shape. */
export interface FormattedPush {
  /** `headline` collapsed to one line and truncated to <= {@link MAX_HEADLINE_CHARS} (with the mark). */
  headline: string;
  /** ONE line (newlines collapsed), or null when the message has no so-what. */
  soWhat: string | null;
  /** The source link, or null. Never truncated or altered. */
  link: string | null;
  /** `headline\nsoWhat\nlink` (omitting absent parts): what ntfy sends and `relay` mode relays. */
  text: string;
  /** True when the headline or so-what was truncated. */
  truncated: boolean;
}

/**
 * Normalize a message to <=280-char headline + one-line so-what + source link. MUST: never exceed
 * {@link MAX_HEADLINE_CHARS} for the headline, count characters by code point (do not split a surrogate
 * pair), collapse internal newlines, never drop or modify the link, be pure and deterministic. Truncation
 * is unit-tested (see docs/DECISIONS.md, "Alert budget semantics").
 */
export type FormatPush = (message: AlertMessage) => FormattedPush;

// ---------------------------------------------------------------------------------------------
// Ops alerts (A5, `src/notify/ops.ts`): system messages that are not events (Schwab down, token expiring,
// health, outage/recovery). They bypass the event budget but never spam: each has a dedupe key + cooldown.
// ---------------------------------------------------------------------------------------------

/**
 * Well-known ops dedupe keys. EVERY raiser of a condition uses the SAME key, so however many parties notice
 * "quotes are down" the cooldown yields exactly ONE push. The designated RAISER per condition (the others only
 * read health): B1 for `AuthExpiredError` from any adapter (refresh failure included); B2's `token_check` job
 * for the three token reminders; B3's health monitor for stream-down while the token is fine; A5's router for the
 * gateway outage. The `token_state.quotes_down_alerted_at` column is informational only. Recovery clears the
 * key (`alertState.clear`) BEFORE raising the recovery notice (`${key}:recovered`), so the next outage alerts.
 */
export const OPS_KEYS = {
  SCHWAB_QUOTES_DOWN: 'schwab:quotes_down',
  SCHWAB_STREAM_DOWN: 'schwab:stream_down',
  SCHWAB_TOKEN_24H: 'schwab:token_24h',
  SCHWAB_TOKEN_6H: 'schwab:token_6h',
  SCHWAB_TOKEN_EXPIRED: 'schwab:token_expired',
  OPENCLAW_OUTAGE: 'outage:openclaw',
  OPENCLAW_REJECTED: 'ops:openclaw_rejected',
  NTFY_REJECTED: 'ops:ntfy_rejected',
  HEALTH_PREFIX: 'health:',
} as const;

/** The recovery key for a down key (`schwab:quotes_down` -> `schwab:quotes_down:recovered`). */
export const recoveredKey = (downKey: string): string => `${downKey}:recovered`;

export interface OpsAlert {
  /** Component, e.g. `schwab`, `edgar`, `openclaw`, `db`. */
  component: string;
  /** One-line headline (<= 280 chars after formatPush). */
  headline: string;
  /** Optional one-line detail. NO secrets. */
  detail?: string;
  kind: 'down' | 'recovered' | 'reminder' | 'info';
  /** Default P1 for `down`/`reminder` (spec: "quotes down" is a P1), P3 otherwise. */
  priority?: Priority;
  /**
   * Same key within `cooldownMs` is suppressed (uses `alert_state`). Use the {@link OPS_KEYS} constants for
   * well-known conditions. A `recovered` alert passes the DOWN key: the alerter clears it, then raises under
   * {@link recoveredKey}.
   */
  dedupeKey: string;
  /** Default 6 hours. */
  cooldownMs?: number;
  /**
   * When true the alert may fire during quiet hours (token EXPIRED, DB failure). Default false: a non-urgent
   * ops alert raised during quiet hours is deferred (`next_attempt_at` = `nextQuietEnd(now, ...)` from
   * `core/time`, DST-correct; never hand-rolled), never dropped. Quiet hours are evaluated at raise time.
   */
  urgent?: boolean;
}

/** Enqueues ops alerts into the outbox (kind `ops`), with dedupe/cooldown and quiet-hours handling. */
export interface OpsAlerter {
  /** Returns whether a push was enqueued (false = suppressed by cooldown). */
  raise(alert: OpsAlert, now?: Date): { enqueued: boolean; pushId: string | null };
}
