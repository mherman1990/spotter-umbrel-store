/**
 * Contract for the local read-only HTTP API (B3, `src/api/`), consumed by B2's composition root and CLI.
 * Decision D19: node:http only, GET/HEAD only (405 "read-only" otherwise), Bearer-token auth with a hashed token
 * store (503 until a token exists), one SQLite read transaction per request, strict headers
 * (`Cache-Control: no-store`, CSP, `X-Content-Type-Options: nosniff`). Routes (spec section 12):
 * `GET /snapshot?ticker=` `/events?ticker=&since=` `/position?ticker=` `/plan?ticker=` `/brief/<type>?ticker=`
 * `/scorecard?ticker=&period=` `/health`. No write routes exist.
 *
 * ## `/health` and the container HEALTHCHECK (decisions D19 vs D30)
 * A Docker HEALTHCHECK cannot send a Bearer token, and the API answers 503 until a token exists, so the
 * contract is: UNAUTHENTICATED `GET /health` returns ONLY `{status}` (`ok` | `degraded` | `down`; no component
 * detail, nothing an outsider can use), with HTTP 200 for `ok`/`degraded` and 503 for `down` (computed from real
 * state, never hard-coded). It NEVER answers 503 merely because no API token exists yet. With a valid Bearer
 * token it returns the full `HealthSummary`. Every other route needs the token.
 *
 * ## Conventions
 *  - Errors are `{ error: { code, message } }` ({@link ApiError}): 400 `bad_request` (missing/invalid
 *    parameter, unknown brief type), 401 `unauthorized`, 404 `not_found` (ticker not covered, nothing
 *    materialized), 405 `read_only`, 503 `no_token` (before the first token) -- never HTML, never a stack trace.
 *  - `ticker` is required on every route except `/health`; it must be a covered symbol (else 404).
 *  - `since` (on `/events`) accepts ISO-8601 WITH an offset OR epoch milliseconds (digits only).
 *  - `/brief/<type>` serves ONLY `premarket | midday | close | weekly` ({@link ApiBriefType}); snapshot,
 *    position, plan and scorecard have their own routes. It serves the MATERIALIZED payload (kv `brief:`) and
 *    falls back to a live build whose `dataQuality` says `not materialized`.
 *  - `/scorecard?period=` is optional: absent = the latest scorecard.
 */
import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { ConfigSource } from '../config/schema.js';
import type { PositionPlan } from '../config/plan.js';
import type { BriefService, BriefType, EventDigestItem, HealthMonitor } from '../engine/types.js';
import type { Store } from '../store/index.js';

/** The brief types `/brief/<type>` serves (the others are separate routes). */
export type ApiBriefType = Extract<BriefType, 'premarket' | 'midday' | 'close' | 'weekly'>;
export const API_BRIEF_TYPES: readonly ApiBriefType[] = ['premarket', 'midday', 'close', 'weekly'];

/** Error envelope for every non-2xx answer. */
export interface ApiError {
  error: {
    code: 'bad_request' | 'unauthorized' | 'not_found' | 'read_only' | 'no_token' | 'internal';
    message: string;
  };
}

/** One event as `/events` returns it: the digest item plus the (possibly pruned) payload. */
export interface EventsResponseItem extends EventDigestItem {
  /** The structured payload (untrusted text inside). `{}` when retention pruned it (see `payloadPruned`). */
  payload: Record<string, unknown>;
  payloadPruned: boolean;
  status: string;
}

/** `GET /events?ticker=&since=` */
export interface EventsResponse {
  ticker: string;
  /** The effective lower bound, ISO-8601 UTC. */
  since: string;
  /** Newest first. */
  events: EventsResponseItem[];
}

/** `GET /health` without a token. */
export interface PublicHealthResponse {
  status: 'ok' | 'degraded' | 'down';
}

export interface ApiDeps {
  clock: Clock;
  log: Logger;
  store: Store;
  /** Live config (read per request; `api.bind`/`api.port` only apply at startup). */
  config: ConfigSource;
  /** Current plan (may be null when none is loaded). */
  getPlan(): PositionPlan | null;
  briefs: BriefService;
  health: HealthMonitor;
  /** Optional extra salt for token hashing (`SCOUT_API_TOKEN_PEPPER`). */
  tokenPepper?: string;
}

export interface ApiServer {
  /** Bind to `config.api.bind:config.api.port` (port 0 allowed for tests). Resolves with the bound port. */
  listen(): Promise<{ port: number }>;
  /** Stop accepting and drain (graceful shutdown). */
  close(): Promise<void>;
}

export type CreateApiServer = (deps: ApiDeps) => ApiServer;

/**
 * Create a token for `client` (`scout token add mayer`): returns the PLAINTEXT token exactly once; only its
 * salted SHA-256 is stored (`api_tokens`). Implemented in B3's `src/api/auth.ts`.
 */
export type IssueApiToken = (
  store: Store,
  client: string,
  opts: { now: Date; pepper?: string; scopes?: readonly string[] },
) => string;
