/**
 * Error hierarchy. Every error Scout raises on purpose extends {@link ScoutError} so callers can branch on
 * `instanceof` / `code` instead of parsing messages, and so logging can attach structured fields.
 *
 * Rules for messages: never include secrets (tokens, keys, full authorization headers) and never include
 * unredacted URLs - pass URLs through `redactUrl()` (src/core/redact.ts) first.
 */
import { redactText } from './redact.js';

export interface ScoutErrorOptions {
  cause?: unknown;
  /** Safe to retry the same operation later (transient). Default false. */
  retryable?: boolean;
  /** Extra structured, NON-SECRET context for logs. */
  details?: Record<string, unknown>;
}

export class ScoutError extends Error {
  /** Stable machine-readable code, e.g. `EGRESS_DENIED`. */
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, options: ScoutErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

/** Invalid or missing configuration (coverage.yaml, position plan, thesis). Fatal at startup. */
export class ConfigError extends ScoutError {
  constructor(message: string, options: ScoutErrorOptions = {}) {
    super('CONFIG_INVALID', message, options);
  }
}

/** Secrets file unreadable/insecure or a REQUIRED secret is missing. Never carries a secret value. */
export class SecretsError extends ScoutError {
  /** The secret KEY NAME involved (never the value). */
  readonly key: string | undefined;
  constructor(message: string, options: ScoutErrorOptions & { key?: string } = {}) {
    super('SECRETS', message, options);
    this.key = options.key;
  }
}

/** A request targeted a host/scheme outside the configured egress allowlist. Thrown BEFORE connecting. */
export class EgressDeniedError extends ScoutError {
  constructor(redactedUrl: string, reason = 'host is not on the egress allowlist') {
    super('EGRESS_DENIED', `Egress denied: ${redactedUrl} (${reason})`, {
      details: { url: redactedUrl, reason },
    });
  }
}

/** A code path attempted something the read-only guarantee forbids (non-GET Schwab call, order endpoint...). */
export class ReadOnlyViolationError extends ScoutError {
  constructor(message: string) {
    super('READ_ONLY_VIOLATION', message);
  }
}

/** Non-2xx HTTP response (after retries for retryable statuses). */
export class HttpError extends ScoutError {
  readonly status: number;
  readonly url: string;
  constructor(redactedUrl: string, status: number, options: ScoutErrorOptions = {}) {
    super('HTTP_ERROR', `HTTP ${status} from ${redactedUrl}`, {
      retryable: status === 429 || status >= 500,
      ...options,
      details: { url: redactedUrl, status, ...options.details },
    });
    this.status = status;
    this.url = redactedUrl;
  }
}

/** The request exceeded its deadline (AbortController). Retryable. */
export class HttpTimeoutError extends ScoutError {
  constructor(redactedUrl: string, timeoutMs: number) {
    super('HTTP_TIMEOUT', `Timeout after ${timeoutMs}ms: ${redactedUrl}`, {
      retryable: true,
      details: { url: redactedUrl, timeoutMs },
    });
  }
}

/** Transport-level failure (DNS, connection reset, TLS...). Retryable. */
export class HttpNetworkError extends ScoutError {
  constructor(redactedUrl: string, cause: unknown) {
    super('HTTP_NETWORK', `Network error: ${redactedUrl}: ${describeCause(cause)}`, {
      retryable: true,
      cause,
      details: { url: redactedUrl },
    });
  }
}

export class ResponseTooLargeError extends ScoutError {
  constructor(redactedUrl: string, bytes: number, max: number) {
    super('RESPONSE_TOO_LARGE', `Response from ${redactedUrl} is ${bytes} bytes; limit ${max}`, {
      details: { url: redactedUrl, bytes, max },
    });
  }
}

/**
 * Credentials for an upstream service are expired/revoked and a HUMAN must re-authorize (Schwab refresh token
 * is valid 7 days fixed; FINRA/FRED key rejected...). Adapters throw this; the orchestrator turns it into ONE
 * deduplicated ops alert and keeps every other adapter running (decision D12).
 */
export class AuthExpiredError extends ScoutError {
  readonly service: string;
  /** True when only a human action (e.g. `scout schwab-auth`) can fix it; retrying is pointless. */
  readonly reauthRequired: boolean;
  constructor(
    service: string,
    message: string,
    options: ScoutErrorOptions & { reauthRequired?: boolean } = {},
  ) {
    super('AUTH_EXPIRED', message, options);
    this.service = service;
    this.reauthRequired = options.reauthRequired ?? true;
  }
}

/** A poll/stream adapter failed for a reason of its own (parse failure, unexpected schema, upstream outage). */
export class AdapterError extends ScoutError {
  readonly adapterId: string;
  constructor(adapterId: string, message: string, options: ScoutErrorOptions = {}) {
    super('ADAPTER_ERROR', `[${adapterId}] ${message}`, {
      ...options,
      details: { adapterId, ...options.details },
    });
    this.adapterId = adapterId;
  }
}

/** SQLite / repository failure that is not a constraint no-op. */
export class StoreError extends ScoutError {
  constructor(message: string, options: ScoutErrorOptions = {}) {
    super('STORE', message, options);
  }
}

/** Migration failure, including detection of an edited (checksum-mismatched) shipped migration. */
export class MigrationError extends ScoutError {
  constructor(message: string, options: ScoutErrorOptions = {}) {
    super('MIGRATION', message, options);
  }
}

/** No LLM available (no key, auth failure, disabled in config). Distinct from a model refusal. */
export class LlmUnavailableError extends ScoutError {
  constructor(message: string, options: ScoutErrorOptions = {}) {
    super('LLM_UNAVAILABLE', message, { retryable: true, ...options });
  }
}

/** The daily/monthly spend cap blocked the call. */
export class LlmBudgetExceededError extends ScoutError {
  readonly scope: 'daily' | 'monthly';
  constructor(scope: 'daily' | 'monthly', spentUsd: number, capUsd: number) {
    super(
      'LLM_BUDGET',
      `LLM ${scope} spend cap reached ($${spentUsd.toFixed(4)} >= $${capUsd.toFixed(2)})`,
      {
        details: { scope, spentUsd, capUsd },
      },
    );
    this.scope = scope;
  }
}

/** The model returned `stop_reason: "refusal"` (and no fallback produced an answer). */
export class LlmRefusalError extends ScoutError {
  constructor(model: string) {
    super('LLM_REFUSAL', `Model ${model} refused the request`, { details: { model } });
  }
}

/** LLM output failed validation (schema, max_tokens truncation, empty). */
export class LlmOutputError extends ScoutError {
  constructor(message: string, options: ScoutErrorOptions = {}) {
    super('LLM_OUTPUT', message, options);
  }
}

/** A notifier could not deliver. `retryable` distinguishes outage (retry/fallback) from rejection (4xx). */
export class NotifyError extends ScoutError {
  readonly channel: string;
  constructor(channel: string, message: string, options: ScoutErrorOptions = {}) {
    super('NOTIFY', `[${channel}] ${message}`, options);
    this.channel = channel;
  }
}

/** Input failed validation (zod, malformed payload). */
export class ValidationError extends ScoutError {
  constructor(message: string, options: ScoutErrorOptions = {}) {
    super('VALIDATION', message, options);
  }
}

/** Domain-level "not found" (unknown ticker, no such brief). */
export class NotFoundError extends ScoutError {
  constructor(message: string) {
    super('NOT_FOUND', message);
  }
}

/** True for errors worth retrying later (transient network/upstream), false for everything else. */
export function isRetryable(err: unknown): boolean {
  return err instanceof ScoutError ? err.retryable : false;
}

/**
 * A short, safe description of an unknown thrown value (includes undici's `cause.code` when present). The
 * text is ALWAYS passed through `redactText`: undici echoes an offending header value in its message (a header
 * containing a newline makes it throw `Headers.append: "Bearer sk-ant-..." is an invalid header value`), and
 * that must never reach logs, error messages or `pushes.last_error`.
 */
export function describeCause(err: unknown): string {
  if (err instanceof Error) {
    const code = (err.cause as { code?: unknown } | undefined)?.code;
    return redactText(typeof code === 'string' ? `${err.message} (${code})` : err.message);
  }
  return redactText(String(err));
}
