/**
 * The ONLY GET/HEAD egress path in Scout (decision D7). Every polling adapter fetches through
 * {@link HttpClient}; `fetch(` may appear only in this file and `egress-post.ts` (policy test enforces it).
 *
 * Adapted from BlackGold packages/core/src/data/http.ts (MIT, Copyright (c) 2026 Matt Herman). Changes:
 * injectable `Clock`; typed error hierarchy; per-adapter User-Agent via `withUserAgent`; rate-limit groups
 * (SEC hosts share one bucket); retry of network errors and timeouts and 5xx (BlackGold retried only
 * 429/503); manual redirect handling that re-checks the allowlist on every hop (BlackGold refused redirects);
 * opt-in in-memory conditional GET (ETag/Last-Modified; never required - SEC support is UNVERIFIED);
 * secrets redaction in every error/log string; `getJson`/`getText` helpers.
 *
 * Guarantees:
 *  - exact-host https-only allowlist, enforced BEFORE any connection (throws EgressDeniedError);
 *  - GET and HEAD only: this client has no way to mutate anything remote;
 *  - per-host-group token-bucket rate limit (default 5 rps; SEC hosts share one 5 rps bucket, < 10 rps limit).
 *    The bucket holds ONE token (no burst): the peak rate in any rolling second is rate + 1, never ~2x rate;
 *  - retry with exponential backoff + jitter on 408/425/429/5xx/network/timeouts, honoring `Retry-After`; every
 *    wait (backoff, rate limit) is abortable, so SIGTERM never stalls behind a `Retry-After: 30`;
 *  - AbortController deadline per attempt (default 20 s) plus an optional total `deadlineMs` and per-call
 *    `retries` so an earnings-mode poll can fail fast (the 5-minute scorecard SLA);
 *  - response size cap (default 32 MiB) enforced WHILE streaming the body (not after buffering it);
 *  - every response body that is not consumed (redirect, retryable status, non-2xx, 304) is cancelled so the
 *    socket returns to the pool.
 */
import type { Clock, Scheduler, Sleep } from './clock.js';
import { SystemClock, abortableSleep } from './clock.js';
import { EgressPolicy, normalizeHost, type EgressPolicyOptions } from './egress.js';
import {
  HttpError,
  HttpNetworkError,
  HttpTimeoutError,
  ResponseTooLargeError,
  ScoutError,
  ValidationError,
} from './errors.js';
import type { Logger } from './logger.js';
import { redactUrl } from './redact.js';

/** Minimal `fetch` shape used by Scout's HTTP layers; the real platform `fetch` satisfies it. */
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>;

export interface FetchInit {
  method: 'GET' | 'HEAD' | 'POST';
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  /** Scout always uses `manual` so redirects are re-validated against the allowlist. */
  redirect: 'manual';
}

/** Structural subset of a WHATWG `ReadableStream<Uint8Array>` (so tests need no streams). */
export interface BodyStreamLike {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
    cancel(reason?: unknown): Promise<void>;
  };
}

export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  /** When present the body is read incrementally so the size cap is enforced while streaming. */
  body?: BodyStreamLike | null;
  /** Release the connection without reading the body (called on every non-consumed path). */
  discard?(): Promise<void>;
}

/** Per-call options for GET/HEAD. */
export interface HttpRequestOptions {
  /** Extra request headers (lower-case keys preferred). Authorization is dropped on cross-host redirects. */
  headers?: Record<string, string>;
  /** Override the client's User-Agent for this call. */
  userAgent?: string;
  /** Override the attempt deadline. */
  timeoutMs?: number;
  /** Override the response size cap. */
  maxBytes?: number;
  /** Override the `Accept` header (default `*\/*`). */
  accept?: string;
  /**
   * Opt in to conditional GET: if this URL returned an ETag/Last-Modified before, send
   * If-None-Match/If-Modified-Since and, on 304, return the cached body with `notModified: true`.
   * A server that never sends validators simply never produces a 304; nothing depends on it.
   */
  conditional?: boolean;
  /** Caller cancellation. Aborting is NOT retried and interrupts backoff/rate-limit waits. */
  signal?: AbortSignal;
  /** Override the client's retry count for this call (0 = single attempt; earnings-mode polls fail fast). */
  retries?: number;
  /**
   * Total budget for the call across all attempts and waits. When it is exhausted the call fails (no more
   * retries) and each attempt's timeout is capped to the remaining budget.
   */
  deadlineMs?: number;
}

export interface HttpResponse {
  /** The final URL fetched (after redirects). MAY CONTAIN SECRETS (e.g. FRED api_key): log {@link safeUrl}. */
  url: string;
  /** {@link url} with credential-bearing query values removed; safe to log or put in errors. */
  safeUrl: string;
  status: number;
  /** Response headers, lower-case keys (only those the transport exposed via `get` for the common set). */
  headers: Record<string, string>;
  body: Uint8Array;
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
  fetchedAt: Date;
  /** True when the server answered 304 and the cached body was returned. */
  notModified: boolean;
  /** Alias of notModified for readability at call sites. */
  fromCache: boolean;
  /** UTF-8 decode of the body. */
  text(): string;
  /** JSON.parse of the body. @throws ValidationError on malformed JSON (message carries the safe URL only). */
  json<T = unknown>(): T;
}

/** What adapters depend on. Implemented by {@link AllowlistedHttpClient} and test-support `FakeHttp`. */
export interface HttpClient {
  get(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
  head(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
  /** GET and parse JSON. */
  getJson<T = unknown>(url: string, options?: HttpRequestOptions): Promise<T>;
  /** GET and decode as UTF-8 text. */
  getText(url: string, options?: HttpRequestOptions): Promise<string>;
  /** Non-throwing allowlist check for a GET of `url`. */
  isAllowed(url: string): boolean;
  /**
   * A client that shares this client's rate limiter, cache and allowlist but sends `userAgent`. Adapters call
   * this once at construction, e.g. `deps.http.withUserAgent(buildUserAgent('scout-edgar', contact))`.
   */
  withUserAgent(userAgent: string): HttpClient;
  /** Total attempts made by this client family (diagnostics). */
  requestCount(): number;
}

export interface HttpClientOptions extends EgressPolicyOptions {
  /** Default User-Agent. SEC requires one that identifies the app and a contact (decision D2). */
  userAgent: string;
  /** Requests per second per rate key (host, or group name via `rateGroups`). */
  ratePerSecond?: Readonly<Record<string, number>>;
  /** host -> group name, so related hosts share one bucket (SEC's `data.sec.gov` + `www.sec.gov`). */
  rateGroups?: Readonly<Record<string, string>>;
  /** Used for hosts with no entry in `ratePerSecond`. Default 5 (decision D7). */
  defaultPerSecond?: number;
  /** Default per-attempt deadline. Default 20_000. */
  timeoutMs?: number;
  /** Default response size cap. Default 32 MiB. */
  maxBytes?: number;
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number;
  /** Backoff base. Default 500 ms (delay = base * 2^attempt + jitter in [0, base)). */
  retryBaseMs?: number;
  /** Ceiling for any single backoff, also caps an honored Retry-After. Default 30_000. */
  maxRetryDelayMs?: number;
  /** Max redirect hops (each re-checked against the allowlist). Default 3. */
  maxRedirects?: number;
  /** Max conditional-GET cache entries (LRU). Default 64. */
  cacheMaxEntries?: number;
  fetchImpl?: FetchLike;
  clock?: Clock;
  /** Injectable sleeper so rate-limit and backoff waits are testable (`FakeClock#sleeper`); must honor the signal. */
  sleep?: Sleep;
  /** Timers for the per-attempt deadline. Default: real timers. */
  scheduler?: Scheduler;
  /** [0,1) jitter source. Default Math.random. */
  random?: () => number;
  log?: Logger;
}

/** Hosts that share one rate bucket by default: SEC fair access is 10 req/s per IP across both hosts. */
export const DEFAULT_RATE_GROUPS: Readonly<Record<string, string>> = {
  'data.sec.gov': 'sec',
  'www.sec.gov': 'sec',
};
/** Default per-group limits (requests/second). SEC kept at 5 (half the published 10 rps ceiling). */
export const DEFAULT_RATES: Readonly<Record<string, number>> = {
  sec: 5,
  // Schwab allows 120 requests/minute overall (decision D13): 2 rps. Owner-tunable via `egress.rates`.
  'api.schwabapi.com': 2,
  'api.stlouisfed.org': 2,
  'api.finra.org': 2,
  'ews.fip.finra.org': 2,
  'cdn.finra.org': 2,
  'www.nasdaqtrader.com': 2,
  'news.google.com': 1,
};

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const CROSS_HOST_DROP: readonly string[] = [
  'authorization',
  'cookie',
  'x-api-key',
  'proxy-authorization',
];

/** Build the SEC-style User-Agent `Name/version (contact)`. The contact must come from config/secrets (D2). */
export function buildUserAgent(app: string, contact: string, version = '0.1'): string {
  if (contact.trim() === '') throw new RangeError('User-Agent contact must not be empty');
  return `${app}/${version} (${contact.trim()})`;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
  perSecond: number;
}

interface CacheEntry {
  etag: string | null;
  lastModified: string | null;
  body: Uint8Array;
  contentType: string | null;
  headers: Record<string, string>;
}

/** State shared by a client and every `withUserAgent` derivative. */
interface Shared {
  policy: EgressPolicy;
  buckets: Map<string, Bucket>;
  cache: Map<string, CacheEntry>;
  requestCount: number;
}

type Resolved = Required<
  Pick<
    HttpClientOptions,
    | 'ratePerSecond'
    | 'rateGroups'
    | 'defaultPerSecond'
    | 'timeoutMs'
    | 'maxBytes'
    | 'maxRetries'
    | 'retryBaseMs'
    | 'maxRetryDelayMs'
    | 'maxRedirects'
    | 'cacheMaxEntries'
  >
>;

/**
 * The production {@link HttpClient}.
 *
 * @example
 * ```ts
 * const http = new AllowlistedHttpClient({
 *   allowedHosts: ['data.sec.gov'],
 *   userAgent: buildUserAgent('scout-edgar', secrets.require('SCOUT_SEC_CONTACT')),
 * });
 * const subs = await http.getJson<Submissions>('https://data.sec.gov/submissions/CIK0001113809.json', {
 *   conditional: true,
 * });
 * ```
 */
export class AllowlistedHttpClient implements HttpClient {
  private readonly userAgent: string;
  private readonly cfg: Resolved;
  private readonly fetchImpl: FetchLike;
  private readonly clock: Clock;
  private readonly sleep: Sleep;
  private readonly scheduler: Scheduler;
  private readonly random: () => number;
  private readonly log: Logger | undefined;
  private readonly shared: Shared;
  private readonly options: HttpClientOptions;

  constructor(options: HttpClientOptions, shared?: Shared) {
    if (options.userAgent.trim().length < 8) {
      throw new RangeError('userAgent must identify the application and a contact');
    }
    this.userAgent = options.userAgent;
    this.cfg = {
      ratePerSecond: options.ratePerSecond ?? DEFAULT_RATES,
      rateGroups: options.rateGroups ?? DEFAULT_RATE_GROUPS,
      defaultPerSecond: options.defaultPerSecond ?? 5,
      timeoutMs: options.timeoutMs ?? 20_000,
      maxBytes: options.maxBytes ?? 32 * 1024 * 1024,
      maxRetries: options.maxRetries ?? 3,
      retryBaseMs: options.retryBaseMs ?? 500,
      maxRetryDelayMs: options.maxRetryDelayMs ?? 30_000,
      maxRedirects: options.maxRedirects ?? 3,
      cacheMaxEntries: options.cacheMaxEntries ?? 64,
    };
    if (!Number.isInteger(this.cfg.maxRetries) || this.cfg.maxRetries < 0) {
      throw new RangeError('maxRetries must be a non-negative integer');
    }
    if (
      !(this.cfg.retryBaseMs > 0) ||
      !(this.cfg.maxRetryDelayMs > 0) ||
      !(this.cfg.defaultPerSecond > 0)
    ) {
      throw new RangeError('retryBaseMs, maxRetryDelayMs and defaultPerSecond must be positive');
    }
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.clock = options.clock ?? new SystemClock();
    this.sleep = options.sleep ?? abortableSleep;
    this.scheduler = options.scheduler ?? new SystemClock();
    this.random = options.random ?? Math.random;
    this.log = options.log;
    this.shared = shared ?? {
      policy: new EgressPolicy(options),
      buckets: new Map(),
      cache: new Map(),
      requestCount: 0,
    };
    this.options = options;
  }

  isAllowed(url: string): boolean {
    return this.shared.policy.isAllowed(url, 'get');
  }

  requestCount(): number {
    return this.shared.requestCount;
  }

  withUserAgent(userAgent: string): HttpClient {
    return new AllowlistedHttpClient({ ...this.options, userAgent }, this.shared);
  }

  get(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    return this.request('GET', url, options);
  }

  head(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    return this.request('HEAD', url, options);
  }

  async getJson<T = unknown>(url: string, options: HttpRequestOptions = {}): Promise<T> {
    const res = await this.get(url, { accept: 'application/json', ...options });
    return res.json<T>();
  }

  async getText(url: string, options: HttpRequestOptions = {}): Promise<string> {
    return (await this.get(url, options)).text();
  }

  private async request(
    method: 'GET' | 'HEAD',
    url: string,
    options: HttpRequestOptions,
  ): Promise<HttpResponse> {
    const policy = this.shared.policy;
    policy.assert(url, 'get'); // throws EgressDeniedError before any connection
    const timeoutMs = options.timeoutMs ?? this.cfg.timeoutMs;
    const maxBytes = options.maxBytes ?? this.cfg.maxBytes;
    const maxRetries = options.retries ?? this.cfg.maxRetries;
    if (!Number.isInteger(maxRetries) || maxRetries < 0)
      throw new RangeError('retries must be a non-negative integer');
    const deadlineAt =
      options.deadlineMs === undefined ? Infinity : this.clock.nowMs() + options.deadlineMs;
    const baseHeaders: Record<string, string> = {
      'user-agent': options.userAgent ?? this.userAgent,
      accept: options.accept ?? '*/*',
      ...lowerKeys(options.headers ?? {}),
    };
    const cached =
      options.conditional === true && method === 'GET' ? this.shared.cache.get(url) : undefined;
    if (cached?.etag) baseHeaders['if-none-match'] = cached.etag;
    if (cached?.lastModified) baseHeaders['if-modified-since'] = cached.lastModified;

    for (let attempt = 0; ; attempt++) {
      if (options.signal?.aborted)
        throw new ScoutError('ABORTED', `Request aborted: ${redactUrl(url)}`);
      const remaining = deadlineAt - this.clock.nowMs();
      if (remaining <= 0) throw new HttpTimeoutError(redactUrl(url), options.deadlineMs ?? 0);
      try {
        return await this.attempt(
          method,
          url,
          baseHeaders,
          Math.min(timeoutMs, remaining),
          maxBytes,
          cached,
          options,
        );
      } catch (err) {
        const retryAfterMs = err instanceof RetryableStatus ? err.delayMs : undefined;
        const transient =
          err instanceof RetryableStatus ||
          err instanceof HttpTimeoutError ||
          err instanceof HttpNetworkError;
        const delay = retryAfterMs ?? this.backoffMs(attempt);
        // Out of retries, or the wait alone would blow the call's total deadline: give up with the last error.
        if (!transient || attempt >= maxRetries || this.clock.nowMs() + delay >= deadlineAt) {
          if (err instanceof RetryableStatus) throw err.toHttpError();
          throw err;
        }
        this.log?.warn(
          { url: redactUrl(url), attempt: attempt + 1, delayMs: delay },
          'http transient failure, retrying',
        );
        await this.sleep(delay, options.signal);
      }
    }
  }

  private async attempt(
    method: 'GET' | 'HEAD',
    startUrl: string,
    baseHeaders: Record<string, string>,
    timeoutMs: number,
    maxBytes: number,
    cached: CacheEntry | undefined,
    options: HttpRequestOptions,
  ): Promise<HttpResponse> {
    let url = startUrl;
    let headers = { ...baseHeaders };
    const started = this.clock.nowMs();
    for (let hop = 0; ; hop++) {
      const parsed = this.shared.policy.assert(url, 'get'); // every hop re-validated
      await this.takeToken(this.rateKey(parsed.hostname), options.signal);
      const controller = new AbortController();
      let timedOut = false;
      const cancelTimer = this.scheduler.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const onAbort = (): void => controller.abort();
      options.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.shared.requestCount++;
        const res = await this.fetchImpl(url, {
          method,
          headers,
          signal: controller.signal,
          redirect: 'manual',
        });
        const fetchedAt = this.clock.now();

        if (REDIRECT_STATUSES.has(res.status)) {
          const location = res.headers.get('location');
          await discardBody(res);
          if (location === null || hop >= this.cfg.maxRedirects) {
            throw new HttpError(redactUrl(url), res.status, {
              details: {
                reason: location === null ? 'redirect without Location' : 'too many redirects',
              },
            });
          }
          const next = new URL(location, url);
          if (next.hostname.toLowerCase() !== parsed.hostname.toLowerCase()) {
            headers = Object.fromEntries(
              Object.entries(headers).filter(([k]) => !CROSS_HOST_DROP.includes(k)),
            );
          }
          url = next.toString();
          continue;
        }

        if (res.status === 304 && cached !== undefined) {
          await discardBody(res);
          return this.build(url, 200, cached.headers, cached.body, cached, fetchedAt, true);
        }
        if (RETRYABLE_STATUSES.has(res.status)) {
          const delayMs = this.retryDelayMs(res.headers.get('retry-after'));
          await discardBody(res);
          throw new RetryableStatus(url, res.status, delayMs);
        }
        if (res.status < 200 || res.status >= 300) {
          await discardBody(res);
          throw new HttpError(redactUrl(url), res.status);
        }
        const declared = Number(res.headers.get('content-length') ?? '');
        if (Number.isFinite(declared) && declared > maxBytes) {
          await discardBody(res);
          throw new ResponseTooLargeError(redactUrl(url), declared, maxBytes);
        }
        let body: Uint8Array;
        if (method === 'HEAD') {
          await discardBody(res);
          body = new Uint8Array(0);
        } else {
          body = await readBodyCapped(res, maxBytes, redactUrl(url));
        }
        const headerRecord = collectHeaders(res.headers);
        const out = this.build(url, res.status, headerRecord, body, undefined, fetchedAt, false);
        if (
          options.conditional === true &&
          method === 'GET' &&
          (out.etag !== null || out.lastModified !== null)
        ) {
          this.remember(startUrl, {
            etag: out.etag,
            lastModified: out.lastModified,
            body,
            contentType: out.contentType,
            headers: headerRecord,
          });
        }
        this.log?.debug(
          {
            url: out.safeUrl,
            status: out.status,
            bytes: body.byteLength,
            ms: this.clock.nowMs() - started,
          },
          'http ok',
        );
        return out;
      } catch (err) {
        if (err instanceof RetryableStatus || err instanceof ScoutError) throw err;
        if (timedOut) throw new HttpTimeoutError(redactUrl(url), timeoutMs);
        if (options.signal?.aborted)
          throw new ScoutError('ABORTED', `Request aborted: ${redactUrl(url)}`);
        throw new HttpNetworkError(redactUrl(url), err);
      } finally {
        cancelTimer();
        options.signal?.removeEventListener('abort', onAbort);
      }
    }
  }

  private build(
    url: string,
    status: number,
    headers: Record<string, string>,
    body: Uint8Array,
    cachedFrom: CacheEntry | undefined,
    fetchedAt: Date,
    notModified: boolean,
  ): HttpResponse {
    const safeUrl = redactUrl(url);
    return {
      url,
      safeUrl,
      status,
      headers,
      body,
      etag: headers['etag'] ?? cachedFrom?.etag ?? null,
      lastModified: headers['last-modified'] ?? cachedFrom?.lastModified ?? null,
      contentType: headers['content-type'] ?? cachedFrom?.contentType ?? null,
      fetchedAt,
      notModified,
      fromCache: notModified,
      text: () => new TextDecoder('utf-8').decode(body),
      json: <T = unknown>(): T => {
        try {
          return JSON.parse(new TextDecoder('utf-8').decode(body)) as T;
        } catch (cause) {
          throw new ValidationError(`Invalid JSON from ${safeUrl}`, { cause });
        }
      },
    };
  }

  private remember(url: string, entry: CacheEntry): void {
    if (entry.body.byteLength > 4 * 1024 * 1024) return;
    const cache = this.shared.cache;
    cache.delete(url);
    cache.set(url, entry);
    while (cache.size > this.cfg.cacheMaxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  /** Backoff: `base * 2^attempt` plus jitter in `[0, base)`, capped. */
  private backoffMs(attempt: number): number {
    const base = this.cfg.retryBaseMs * 2 ** attempt;
    return Math.min(base + this.random() * base, this.cfg.maxRetryDelayMs);
  }

  /** `Retry-After` (delta-seconds or HTTP date) capped at maxRetryDelayMs; undefined when absent/invalid. */
  private retryDelayMs(retryAfter: string | null): number | undefined {
    if (retryAfter === null || retryAfter.trim() === '') return undefined;
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.min(Math.max(0, secs) * 1000, this.cfg.maxRetryDelayMs);
    const when = Date.parse(retryAfter);
    if (!Number.isNaN(when)) {
      return Math.min(Math.max(0, when - this.clock.nowMs()), this.cfg.maxRetryDelayMs);
    }
    return undefined;
  }

  /** Rate bucket key: the host group, else the host (lower-cased, one trailing dot dropped). */
  private rateKey(host: string): string {
    const h = normalizeHost(host);
    return this.cfg.rateGroups[h] ?? h;
  }

  /**
   * Take one token, waiting (abortably) when the bucket is empty. The bucket HOLDS ONE TOKEN and starts full:
   * requests are spaced `1/perSecond` apart, so any rolling second sees at most `perSecond + 1` requests (a
   * capacity equal to the rate would allow a burst plus refill of ~2x the nominal rate).
   */
  private async takeToken(key: string, signal?: AbortSignal): Promise<void> {
    const perSecond = this.cfg.ratePerSecond[key] ?? this.cfg.defaultPerSecond;
    let b = this.shared.buckets.get(key);
    if (!b) {
      b = { tokens: 1, lastRefillMs: this.clock.nowMs(), perSecond };
      this.shared.buckets.set(key, b);
    }
    for (;;) {
      const t = this.clock.nowMs();
      b.tokens = Math.min(1, b.tokens + ((t - b.lastRefillMs) / 1000) * b.perSecond);
      b.lastRefillMs = t;
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return;
      }
      await this.sleep(Math.max(1, Math.ceil(((1 - b.tokens) / b.perSecond) * 1000)), signal);
    }
  }
}

/** Internal signal that a retryable status was seen (carries any Retry-After delay). */
class RetryableStatus extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly delayMs: number | undefined,
  ) {
    super(`retryable status ${status}`);
  }
  toHttpError(): HttpError {
    return new HttpError(redactUrl(this.url), this.status);
  }
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

/**
 * The ONLY response headers the transport surfaces (lower-case). `link` (pagination) and Schwab's
 * `schwab-client-correlid` (support tickets) are included; test fakes apply the same whitelist so a test cannot
 * depend on a header production never sees.
 */
export const EXPOSED_HEADERS: readonly string[] = [
  'etag',
  'last-modified',
  'content-type',
  'content-length',
  'retry-after',
  'date',
  'location',
  'cache-control',
  'x-ratelimit-remaining',
  'link',
  'schwab-client-correlid',
];

function collectHeaders(h: { get(name: string): string | null }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of EXPOSED_HEADERS) {
    const v = h.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}

/**
 * The platform `fetch` adapted to {@link FetchLike}. `redirect: 'manual'` so Scout validates every hop.
 * Only this file and `egress-post.ts` may reference `fetch` (policy test).
 */
export const defaultFetch: FetchLike = async (url, init) => {
  const res = await globalThis.fetch(url, {
    method: init.method,
    headers: init.headers,
    signal: init.signal,
    redirect: init.redirect,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  return {
    status: res.status,
    headers: res.headers,
    arrayBuffer: () => res.arrayBuffer(),
    body: res.body as BodyStreamLike | null,
    discard: async () => {
      try {
        await res.body?.cancel();
      } catch {
        /* already closed */
      }
    },
  };
};

/** Cancel an unconsumed response body (never throws). */
export async function discardBody(res: FetchResponseLike): Promise<void> {
  try {
    await res.discard?.();
  } catch {
    /* releasing the socket is best-effort */
  }
}

/**
 * Read a response body enforcing `maxBytes` WHILE streaming (the stream is cancelled the moment the cap is
 * crossed, so an oversized response never sits in memory under the 256 MiB heap limit). Falls back to
 * `arrayBuffer()` for transports without a stream (tests).
 * @throws ResponseTooLargeError
 */
export async function readBodyCapped(
  res: FetchResponseLike,
  maxBytes: number,
  safeUrl: string,
): Promise<Uint8Array> {
  if (res.body === undefined || res.body === null) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes)
      throw new ResponseTooLargeError(safeUrl, buf.byteLength, maxBytes);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(safeUrl, total, maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
