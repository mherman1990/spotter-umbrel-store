/**
 * The ONLY POST egress path (decision D7). It lives in its own file so the policy test can allowlist exactly
 * which modules may call it: Schwab OAuth token exchange/refresh, the FINRA client-credentials token, the
 * OpenClaw hook, ntfy, and the earnings `/hooks/agent` call (see test/policy/egress.test.ts). The Anthropic
 * SDK is the only other writer and is confined to `src/llm/` with a guarded fetch from
 * {@link createGuardedStandardFetch}.
 *
 * Enforces the same egress allowlist as the GET client, a hard deadline, response size cap and secrets
 * redaction. It makes exactly ONE attempt: POSTs are not assumed idempotent, so retry/fallback is the
 * outbox's job (the OpenClaw hook additionally sends an Idempotency-Key). It does NOT throw on non-2xx -
 * audited callers interpret statuses (401 vs 429 vs 5xx) themselves.
 */
import { EgressPolicy, type EgressPolicyOptions } from './egress.js';
import { HttpNetworkError, HttpTimeoutError, ScoutError, ValidationError } from './errors.js';
import { defaultFetch, readBodyCapped, type FetchLike } from './http.js';
import type { Logger } from './logger.js';
import { redactUrl } from './redact.js';

export interface PostClientOptions extends EgressPolicyOptions {
  /** Sent as `User-Agent` unless overridden per call. */
  userAgent: string;
  /** Per-call deadline. Default 15_000. */
  timeoutMs?: number;
  /** Response size cap. Default 2 MiB (these endpoints return tiny bodies). */
  maxBytes?: number;
  fetchImpl?: FetchLike;
  log?: Logger;
  /**
   * URL path segments that ARE a credential (the topic of a public ntfy server) and must be masked in logs,
   * errors and `safeUrl`. Prefer publishing ntfy as JSON to the BASE URL so no secret travels in a path.
   */
  redactPathSegments?: readonly string[];
}

export interface PostRequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Sent as the `Idempotency-Key` header (OpenClaw hooks honor it; use the Event/push id). */
  idempotencyKey?: string;
}

export interface PostResponse<T = unknown> {
  status: number;
  /** 2xx. */
  ok: boolean;
  headers: Record<string, string>;
  /** Response body decoded as UTF-8 (may be empty). */
  text: string;
  /** Parsed JSON body when the response was valid JSON, else undefined. Never throws. */
  json: T | undefined;
  /** Redacted URL, safe to log. */
  safeUrl: string;
}

/** What audited POST modules depend on. */
export interface PostClient {
  /** POST `application/json`. */
  postJson<T = unknown>(
    url: string,
    body: unknown,
    options?: PostRequestOptions,
  ): Promise<PostResponse<T>>;
  /** POST `application/x-www-form-urlencoded` (OAuth token endpoints). */
  postForm<T = unknown>(
    url: string,
    form: Readonly<Record<string, string>>,
    options?: PostRequestOptions,
  ): Promise<PostResponse<T>>;
  /** POST a plain-text body (ntfy). `contentType` defaults to `text/plain; charset=utf-8`. */
  postText<T = unknown>(
    url: string,
    text: string,
    options?: PostRequestOptions & { contentType?: string },
  ): Promise<PostResponse<T>>;
  isAllowed(url: string): boolean;
}

/**
 * Production {@link PostClient}.
 *
 * @example
 * ```ts
 * const post = new AllowlistedPostClient({ allowedHosts: ['api.schwabapi.com'], userAgent: 'scout/0.1' });
 * const res = await post.postForm(tokenUrl, { grant_type: 'refresh_token', refresh_token }, {
 *   headers: { authorization: `Basic ${basic}` },
 * });
 * if (!res.ok) throw new AuthExpiredError('schwab', 'refresh rejected');
 * ```
 */
export class AllowlistedPostClient implements PostClient {
  private readonly policy: EgressPolicy;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetchImpl: FetchLike;
  private readonly log: Logger | undefined;
  private readonly secretSegments: readonly string[];

  constructor(options: PostClientOptions) {
    this.policy = new EgressPolicy(options);
    this.userAgent = options.userAgent;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.log = options.log;
    this.secretSegments = options.redactPathSegments ?? [];
  }

  isAllowed(url: string): boolean {
    return this.policy.isAllowed(url, 'post');
  }

  postJson<T = unknown>(
    url: string,
    body: unknown,
    options: PostRequestOptions = {},
  ): Promise<PostResponse<T>> {
    return this.send<T>(url, JSON.stringify(body), 'application/json', options);
  }

  postForm<T = unknown>(
    url: string,
    form: Readonly<Record<string, string>>,
    options: PostRequestOptions = {},
  ): Promise<PostResponse<T>> {
    const body = new URLSearchParams(form as Record<string, string>).toString();
    return this.send<T>(url, body, 'application/x-www-form-urlencoded', options);
  }

  postText<T = unknown>(
    url: string,
    text: string,
    options: PostRequestOptions & { contentType?: string } = {},
  ): Promise<PostResponse<T>> {
    return this.send<T>(url, text, options.contentType ?? 'text/plain; charset=utf-8', options);
  }

  private async send<T>(
    url: string,
    body: string,
    contentType: string,
    options: PostRequestOptions,
  ): Promise<PostResponse<T>> {
    this.policy.assert(url, 'post'); // throws EgressDeniedError before any connection
    const safeUrl = redactUrl(url, { secretPathSegments: this.secretSegments });
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const headers: Record<string, string> = {
      'user-agent': this.userAgent,
      'content-type': contentType,
      accept: 'application/json, text/plain, */*',
    };
    for (const [k, v] of Object.entries(options.headers ?? {})) headers[k.toLowerCase()] = v;
    if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
        redirect: 'manual',
      });
      const buf = await readBodyCapped(res, this.maxBytes, safeUrl);
      const text = new TextDecoder('utf-8').decode(buf);
      let json: T | undefined;
      try {
        json = text.trim() === '' ? undefined : (JSON.parse(text) as T);
      } catch {
        json = undefined;
      }
      this.log?.debug({ url: safeUrl, status: res.status }, 'post done');
      const respHeaders: Record<string, string> = {};
      for (const name of ['content-type', 'retry-after', 'date', 'location']) {
        const v = res.headers.get(name);
        if (v !== null) respHeaders[name] = v;
      }
      return {
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        headers: respHeaders,
        text,
        json,
        safeUrl,
      };
    } catch (err) {
      if (err instanceof ScoutError || err instanceof ValidationError) throw err;
      if (timedOut) throw new HttpTimeoutError(safeUrl, timeoutMs);
      throw new HttpNetworkError(safeUrl, err);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * A standard-`fetch`-shaped function (Request/Response types) that enforces the egress allowlist, for SDKs that
 * take a custom `fetch` (the Anthropic SDK's `fetch` option). The SDK performs its own POSTs; this guarantees
 * they can only reach allowlisted hosts.
 *
 * Redirects are NEVER followed: the inner fetch is forced to `redirect: 'manual'` (a platform `fetch` follows
 * redirects by default and would walk off the allowlist unchecked), and a 3xx `Location` is re-validated
 * against the policy so a redirect to a non-allowlisted host surfaces as `EgressDeniedError`. An allowed 3xx
 * is returned as-is (the SDK treats it as an error response and does not follow it).
 *
 * @example
 * ```ts
 * new Anthropic({ apiKey, fetch: createGuardedStandardFetch(policy) });
 * ```
 */
export function createGuardedStandardFetch(
  policy: EgressPolicy,
  inner: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    policy.assert(url, 'post');
    return inner(input, { ...init, redirect: 'manual' }).then((res) => {
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (location !== null) policy.assert(new URL(location, url).toString(), 'post');
      }
      return res;
    });
  };
}
