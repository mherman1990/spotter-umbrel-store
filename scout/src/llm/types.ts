/**
 * LLM layer contracts (spec section 7, decisions D20-D22). Two layers:
 *
 *  - {@link LlmProvider}: RAW, provider-specific transport (Anthropic SDK). Knows model ids and request rules.
 *    Implemented by A8 in `src/llm/anthropic.ts`; the ONLY code that imports `@anthropic-ai/sdk`.
 *  - {@link LlmGateway}: what the rest of Scout calls. Resolves tier -> model from config, assembles the
 *    cache-friendly prompt, enforces the daily/monthly spend caps, logs every call to `llm_calls`, validates
 *    structured output. Implemented by A8 in `src/llm/gateway.ts`.
 *
 * ## Request rules for the 5.5 models (decision D20; encoded by the provider, tested in anthropic.test.ts)
 *  - NO `temperature` / `top_p` / `top_k`. NO forced `tool_choice`. Structured output via
 *    `output_config.format` (JSON schema), never tool-use tricks. NO assistant prefill.
 *  - Set `output_config.effort` explicitly (Haiku triage `low`; others explicit from config).
 *  - Sonnet 5.5 cannot send thinking disabled (use effort low, or `thinking: {type: 'between_tools'}`); Opus
 *    5.5 cannot disable thinking. Haiku 5.5 may disable thinking at effort <= high.
 *  - ALWAYS inspect `stop_reason`: `refusal` and `max_tokens` are failures, not answers.
 *  - Sonnet/Opus: server-side refusal `fallbacks: 'default'` (beta `server-side-fallback-2026-07-01`) when
 *    `llm.fallbacks` is on (default ON, the owner is told). Haiku 5.5 has none (a `fallbacks` list is a 400).
 *  - Prompt caching: the STABLE prefix (system + thesis + fact sheet) comes BEFORE the cache breakpoint; the
 *    volatile per-request content (the event) comes AFTER. Log `cache_read_input_tokens`; warn when the
 *    prefix is below the model's minimum cacheable size (512-4096 tokens, model-dependent).
 *  - Untrusted text (filings/news/press releases/newsletters) is DATA: it goes in a delimited block inside
 *    `volatile`, the system prompt says never to follow instructions inside it, and outputs are validated with
 *    zod (decision D22).
 *
 * ## Pricing
 * Prices live in `config.llm.models.<tier>.price` (per million tokens). Cost =
 *   input*in + output*out + cacheRead*cacheReadPrice + cacheWrite*in*writeMultiplier   (5m TTL: 1.25x; 1h: 2x)
 * with the `long_context` rates replacing in/out/cacheRead when the PROMPT (input + cacheRead + cacheWrite
 * tokens) exceeds `long_context.threshold_tokens`, and the whole total multiplied by `(1 - batch_discount)`
 * for Batch API calls. `usage.input` is the UNCACHED remainder only.
 */
import type { Effort } from '../config/schema.js';

export type { Effort };

/** Model tier. `triage`=Haiku, `synth`=Sonnet, `deep`=Opus by default. */
export type LlmTier = 'triage' | 'synth' | 'deep';

/** Why a call is made (also the `llm_calls.job` label and a cost-report dimension). */
export type LlmPurpose =
  | 'triage'
  | 'brief_premarket'
  | 'brief_midday'
  | 'brief_close'
  | 'brief_weekly'
  | 'earnings_scorecard'
  | 'earnings_postcall'
  | 'transcript_flags'
  | 'fact_sheet'
  | 'backfill';

/** A JSON Schema object for `output_config.format` (the supported subset only; validated again with zod). */
export type JsonSchema = Record<string, unknown>;

/** Tokens as reported by the API, normalized. `input` is the uncached remainder. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Normalized `stop_reason`. Anything but `end_turn`/`stop_sequence` needs handling. */
export type StopReason =
  | 'end_turn'
  | 'stop_sequence'
  | 'max_tokens'
  | 'refusal'
  | 'tool_use'
  | 'pause_turn'
  | (string & {});

/**
 * A request to the gateway. The three text parts are kept separate so the gateway controls the cache
 * breakpoint: `system` and `cachedPrefix` are STABLE (identical across requests for a ticker), `volatile`
 * is the per-request part.
 *
 * @example
 * ```ts
 * await gateway.complete({
 *   purpose: 'triage', tier: 'triage', // effort/maxTokens default to config.llm.models.triage; pass to override
 *   system: TRIAGE_SYSTEM_PROMPT,
 *   cachedPrefix: `${thesisText}\n\n${factSheet}`,
 *   volatile: wrapUntrusted('event', JSON.stringify(event)),
 *   schema: TRIAGE_JSON_SCHEMA, eventId: event.id, ticker: event.ticker,
 * });
 * ```
 */
export interface LlmRequest {
  purpose: LlmPurpose;
  tier: LlmTier;
  /** Stable instructions. Must not contain untrusted text. */
  system: string;
  /** Stable per-ticker context (thesis + fact sheet); cached. May be empty. */
  cachedPrefix: string;
  /** Per-request content; placed after the cache breakpoint. Untrusted text must be delimited inside it. */
  volatile: string;
  /** Structured-output schema; when set `LlmResult.json` is the parsed (not yet zod-validated) object. */
  schema?: JsonSchema;
  /**
   * Optional override of `config.llm.models.<tier>.max_tokens`. Absent = the tier's configured value. The
   * gateway logs the EFFECTIVE value on every call, so config and call sites cannot disagree silently.
   */
  maxTokens?: number;
  /** Optional override of `config.llm.models.<tier>.effort`. Absent = the tier's configured value. */
  effort?: Effort;
  /**
   * Hard deadline for this call in milliseconds (AbortSignal). On expiry the gateway throws a retryable
   * `LlmUnavailableError`: a hang is not a failure unless something makes it one. The earnings path sets it
   * from `earnings.extraction_timeout_seconds` so the 5-minute scorecard SLA holds (on timeout B4 pushes
   * `Guide: unknown - read the 8-K` and may still update the scorecard later). Absent = the gateway default.
   */
  timeoutMs?: number;
  /** For `llm_calls` attribution. */
  eventId?: string;
  ticker?: string;
}

/** Result of a completed call. Refusals/truncation are errors, not results (see gateway contract). */
export interface LlmResult {
  text: string;
  /** Parsed JSON when `schema` was set and the text parsed; else undefined. */
  json?: unknown;
  usage: TokenUsage;
  /** USD for THIS call per the price table (batch discount applied for batch results). */
  costUsd: number;
  stopReason: StopReason;
  /** True when `usage.cacheRead > 0` (the stable prefix was served from cache). */
  cacheHit: boolean;
  /** Model id that actually answered (differs from the configured one after a server-side fallback). */
  model: string;
  tier: LlmTier;
  latencyMs: number;
  requestId: string | null;
  /** True when a server-side refusal fallback produced the answer. */
  fallbackUsed: boolean;
  /** True when the call was downgraded to a cheaper tier because of the spend cap. */
  downgraded: boolean;
}

export interface SpendSnapshot {
  todayUsd: number;
  monthUsd: number;
  capDailyUsd: number;
  capMonthlyUsd: number;
  /** True when a cap is currently blocking (or downgrading) calls. */
  capped: boolean;
}

export interface BatchRequestItem {
  /** Unique within the batch; returned with the result. */
  customId: string;
  request: LlmRequest;
}

export interface BatchHandle {
  batchId: string;
  submittedAt: string;
  itemCount: number;
}

export interface BatchPoll {
  status: 'in_progress' | 'canceling' | 'ended';
  /** Present when `status` is `ended`. A failed item carries `error` instead of `result`. */
  results?: { customId: string; result?: LlmResult; error?: string }[];
}

/**
 * What the rest of Scout depends on. Throws (all `ScoutError`s): `LlmUnavailableError` (no key / disabled /
 * transport down / timeout - callers fall back to rules-only), `LlmBudgetExceededError` (cap reached with action
 * `stop`), `LlmRefusalError`, `LlmOutputError` (max_tokens, schema failure). Every call - including failures -
 * writes an `llm_calls` row.
 */
export interface LlmGateway {
  complete(request: LlmRequest): Promise<LlmResult>;
  submitBatch(items: readonly BatchRequestItem[]): Promise<BatchHandle>;
  pollBatch(handle: BatchHandle | string): Promise<BatchPoll>;
  /** True when a call could be attempted now (enabled, key present, not hard-capped). */
  isAvailable(): boolean;
  spend(): SpendSnapshot;
}

// ---------------------------------------------------------------------------------------------
// Raw provider layer
// ---------------------------------------------------------------------------------------------

/** Request after the gateway resolved tier -> model and applied config. */
export interface ProviderRequest {
  /** Exact model id. */
  model: string;
  system: string;
  cachedPrefix: string;
  volatile: string;
  outputSchema?: JsonSchema;
  maxTokens: number;
  effort: Effort;
  /** Send the server-side refusal `fallbacks` (Sonnet/Opus only; never for Haiku). */
  serverFallbacks: boolean;
  cacheTtl: '5m' | '1h';
  /** Abort the request after this many ms (from `LlmRequest.timeoutMs`). */
  timeoutMs?: number;
}

export interface ProviderResult {
  text: string;
  usage: TokenUsage;
  stopReason: StopReason;
  /** Model that answered. */
  model: string;
  requestId: string | null;
  latencyMs: number;
  fallbackUsed: boolean;
}

export interface ProviderBatchItem {
  customId: string;
  request: ProviderRequest;
}

export interface ProviderBatchStatus {
  batchId: string;
  status: 'in_progress' | 'canceling' | 'ended';
  results?: { customId: string; result?: ProviderResult; error?: string }[];
}

/** Raw transport. Swapping providers means writing another one of these. */
export interface LlmProvider {
  readonly name: string;
  complete(request: ProviderRequest): Promise<ProviderResult>;
  submitBatch(items: readonly ProviderBatchItem[]): Promise<{ batchId: string }>;
  getBatch(batchId: string): Promise<ProviderBatchStatus>;
}

// ---------------------------------------------------------------------------------------------
// Test double contract (implemented in src/test-support/fake-llm.ts; NEVER reachable from production code)
// ---------------------------------------------------------------------------------------------

/**
 * One scripted reply for the fake provider: shorthand text/JSON, a refusal, a truncation, an error, or a
 * function of the request.
 */
export type FakeLlmReply =
  | { text: string; usage?: Partial<TokenUsage>; model?: string }
  | { json: unknown; usage?: Partial<TokenUsage>; model?: string }
  | { refusal: true }
  | { maxTokens: true }
  | { error: Error }
  | ((request: ProviderRequest) => FakeLlmReply);

/**
 * The fake used by every LLM-touching test. Contract: replies are consumed FIFO; an empty queue throws
 * (tests must script what they expect); every request is recorded in `requests` so tests can assert prompt
 * structure (stable prefix identical across calls, volatile part last, no sampling params, effort set).
 * Production code must never import it: there is NO environment flag that swaps it in (decision D20; Spotter's
 * `SPOTTER_FAKE_LLM` is a known hazard) and `test/policy` fails CI if `src/` (outside test-support) imports it.
 */
export interface FakeLlmProviderContract extends LlmProvider {
  readonly requests: ProviderRequest[];
  /** Queue replies (FIFO). */
  push(...replies: FakeLlmReply[]): this;
  reset(): void;
}
