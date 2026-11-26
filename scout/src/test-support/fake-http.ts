/**
 * Test doubles for the egress layer. NEVER imported by production code (policy test enforces it).
 *
 *  - {@link FakeFetch}: a scripted `FetchLike`, to test the REAL `AllowlistedHttpClient` / `AllowlistedPostClient`.
 *  - {@link FakeHttp}: a scripted `HttpClient` for adapter unit tests (no retry/limiter logic; records every
 *    request including the User-Agent in effect).
 *  - {@link FakePost}: a scripted `PostClient` for notifier / OAuth tests.
 *
 * Unmatched requests THROW (tests must declare every request they expect): there is no accidental network.
 */
import { HttpError, ValidationError } from '../core/errors.js';
import { EgressPolicy, type EgressKind } from '../core/egress.js';
import type { PostClient, PostRequestOptions, PostResponse } from '../core/egress-post.js';
import {
  EXPOSED_HEADERS,
  type FetchLike,
  type FetchResponseLike,
  type HttpClient,
  type HttpRequestOptions,
  type HttpResponse,
} from '../core/http.js';
import { redactUrl } from '../core/redact.js';

/** How a route answers. */
export interface FakeReplySpec {
  status?: number;
  /** String, JSON-serializable object, or raw bytes. */
  body?: string | object | Uint8Array;
  headers?: Record<string, string>;
  /** Reject with this error instead of answering (simulates network failure). */
  throws?: Error;
  /** Never resolve until the request's AbortSignal fires (simulates a hang; use a tiny timeoutMs). */
  hang?: boolean;
}

export interface FakeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | undefined;
  signal?: AbortSignal | undefined;
}

export type FakeMatch = string | RegExp | ((url: string, req: FakeRequest) => boolean);
type Responder =
  FakeReplySpec | FakeReplySpec[] | ((req: FakeRequest) => FakeReplySpec | Promise<FakeReplySpec>);

interface Route {
  method: string | undefined;
  match: FakeMatch;
  responder: Responder;
  used: number;
}

/** Shared route table: first matching route wins; an array responder is consumed in order (last repeats). */
export class RouteTable {
  private readonly routes: Route[] = [];

  add(match: FakeMatch, responder: Responder, method?: string): void {
    this.routes.push({ method: method?.toUpperCase(), match, responder, used: 0 });
  }

  async resolve(req: FakeRequest): Promise<FakeReplySpec> {
    for (const r of this.routes) {
      if (r.method !== undefined && r.method !== req.method) continue;
      const hit =
        typeof r.match === 'string'
          ? req.url === r.match ||
            (r.match.endsWith('*') && req.url.startsWith(r.match.slice(0, -1)))
          : r.match instanceof RegExp
            ? r.match.test(req.url)
            : r.match(req.url, req);
      if (!hit) continue;
      const n = r.used++;
      const res = r.responder;
      if (typeof res === 'function') return res(req);
      if (Array.isArray(res)) {
        const spec = res[Math.min(n, res.length - 1)];
        if (spec === undefined) throw new Error('FakeFetch: empty reply list');
        return spec;
      }
      return res;
    }
    throw new Error(`FakeFetch: no route for ${req.method} ${redactUrl(req.url)}`);
  }
}

function toBytes(body: FakeReplySpec['body']): Uint8Array {
  if (body === undefined) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  return new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));
}

function defaultContentType(body: FakeReplySpec['body']): string | null {
  if (body === undefined || body instanceof Uint8Array) return null;
  return typeof body === 'string' ? 'text/plain' : 'application/json';
}

/** A scripted `FetchLike` with a request log. Use `.fetch` as `fetchImpl`. */
export class FakeFetch {
  readonly requests: FakeRequest[] = [];
  /** How many responses had their body discarded (cancelled without being read). */
  discarded = 0;
  private readonly table = new RouteTable();

  /** Add a route (optionally restricted to a method). Returns `this` for chaining. */
  on(match: FakeMatch, responder: Responder, method?: string): this {
    this.table.add(match, responder, method);
    return this;
  }

  readonly fetch: FetchLike = async (url, init) => {
    const req: FakeRequest = {
      method: init.method,
      url,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    };
    this.requests.push(req);
    const spec = await this.table.resolve(req);
    if (spec.throws !== undefined) throw spec.throws;
    if (spec.hang === true) {
      await new Promise<never>((_resolve, reject) => {
        const abort = (): void => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        };
        if (init.signal.aborted) abort();
        else init.signal.addEventListener('abort', abort, { once: true });
      });
    }
    const headers: Record<string, string> = { ...spec.headers };
    const ct = defaultContentType(spec.body);
    if (ct !== null && headers['content-type'] === undefined) headers['content-type'] = ct;
    const bytes = toBytes(spec.body);
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const res: FetchResponseLike = {
      status: spec.status ?? 200,
      headers: { get: (name) => lower[name.toLowerCase()] ?? null },
      arrayBuffer: () =>
        Promise.resolve(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        ),
      discard: () => {
        this.discarded++;
        return Promise.resolve();
      },
    };
    return res;
  };
}

/** Build a full `HttpResponse` (as the real client returns it) from a spec. */
export function makeHttpResponse(
  url: string,
  spec: FakeReplySpec,
  fetchedAt = new Date(),
): HttpResponse {
  const bytes = toBytes(spec.body);
  // Apply the SAME whitelist as the real client (`EXPOSED_HEADERS`): a test must not depend on a response
  // header production never sees.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.headers ?? {})) {
    const name = k.toLowerCase();
    if (EXPOSED_HEADERS.includes(name)) headers[name] = v;
  }
  const ct = headers['content-type'] ?? defaultContentType(spec.body);
  // The real transport surfaces the response's content-type header; FakeFetch derives one from the body, and so
  // does this (parity with `AllowlistedHttpClient`).
  if (ct !== null && headers['content-type'] === undefined) headers['content-type'] = ct;
  const safeUrl = redactUrl(url);
  return {
    url,
    safeUrl,
    status: spec.status ?? 200,
    headers,
    body: bytes,
    etag: headers['etag'] ?? null,
    lastModified: headers['last-modified'] ?? null,
    contentType: ct,
    fetchedAt,
    notModified: false,
    fromCache: false,
    text: () => new TextDecoder().decode(bytes),
    json: <T = unknown>(): T => {
      try {
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
      } catch (cause) {
        throw new ValidationError(`Invalid JSON from ${safeUrl}`, { cause });
      }
    },
  };
}

export interface FakeHttpOptions {
  /** When given, requests to other hosts throw `EgressDeniedError` like the real client. */
  allowedHosts?: readonly string[];
  /** Non-default ports permitted per host (like `EgressPolicyOptions.allowedPorts`). */
  allowedPorts?: Readonly<Record<string, readonly number[]>>;
  /** Fixed `fetchedAt` for responses. */
  now?: () => Date;
}

/**
 * Scripted `HttpClient` for adapter tests.
 *
 * @example
 * ```ts
 * const http = new FakeHttp({ allowedHosts: ['data.sec.gov'] });
 * http.on('https://data.sec.gov/submissions/CIK0001113809.json', { body: loadJsonFixture('edgar/submissions.json') });
 * const adapter = createEdgarAdapter({ ...deps, http });
 * expect(http.requests[0]?.headers['user-agent']).toContain('scout-edgar');
 * ```
 */
export class FakeHttp implements HttpClient {
  /** Every request seen (shared with `withUserAgent` derivatives). Headers include the effective user-agent. */
  readonly requests: FakeRequest[];
  private readonly table: RouteTable;
  private readonly policy: EgressPolicy | null;
  private readonly now: () => Date;
  private readonly userAgent: string;

  constructor(
    options: FakeHttpOptions = {},
    shared?: { requests: FakeRequest[]; table: RouteTable },
    userAgent = 'fake-http/0.0 (test)',
  ) {
    this.requests = shared?.requests ?? [];
    this.table = shared?.table ?? new RouteTable();
    this.policy =
      options.allowedHosts === undefined
        ? null
        : new EgressPolicy({
            allowedHosts: options.allowedHosts,
            ...(options.allowedPorts === undefined ? {} : { allowedPorts: options.allowedPorts }),
          });
    this.now = options.now ?? (() => new Date());
    this.userAgent = userAgent;
    this.opts = options;
  }

  private readonly opts: FakeHttpOptions;

  /** Add a GET/HEAD route. */
  on(match: FakeMatch, responder: Responder): this {
    this.table.add(match, responder);
    return this;
  }

  private async request(
    method: 'GET' | 'HEAD',
    url: string,
    options: HttpRequestOptions | undefined,
  ): Promise<HttpResponse> {
    this.policy?.assert(url, 'get' satisfies EgressKind);
    const headers: Record<string, string> = { 'user-agent': options?.userAgent ?? this.userAgent };
    for (const [k, v] of Object.entries(options?.headers ?? {})) headers[k.toLowerCase()] = v;
    const req: FakeRequest = { method, url, headers, signal: options?.signal };
    this.requests.push(req);
    const spec = await this.table.resolve(req);
    if (spec.throws !== undefined) throw spec.throws;
    const status = spec.status ?? 200;
    if (status < 200 || status >= 300) {
      throw new HttpError(redactUrl(url), status);
    }
    return makeHttpResponse(url, spec, this.now());
  }

  get(url: string, options?: HttpRequestOptions): Promise<HttpResponse> {
    return this.request('GET', url, options);
  }

  head(url: string, options?: HttpRequestOptions): Promise<HttpResponse> {
    return this.request('HEAD', url, options);
  }

  async getJson<T = unknown>(url: string, options?: HttpRequestOptions): Promise<T> {
    return (await this.get(url, options)).json<T>();
  }

  async getText(url: string, options?: HttpRequestOptions): Promise<string> {
    return (await this.get(url, options)).text();
  }

  isAllowed(url: string): boolean {
    return this.policy === null ? true : this.policy.isAllowed(url, 'get');
  }

  withUserAgent(userAgent: string): HttpClient {
    return new FakeHttp(this.opts, { requests: this.requests, table: this.table }, userAgent);
  }

  requestCount(): number {
    return this.requests.length;
  }
}

export interface FakePostOptions {
  allowedHosts?: readonly string[];
  allowHttpHosts?: readonly string[];
  allowedPorts?: Readonly<Record<string, readonly number[]>>;
  /** Like `EgressPolicyOptions.postPathAllowlist`: a POST outside it throws `EgressDeniedError`. */
  postPathAllowlist?: Readonly<Record<string, readonly string[]>>;
}

/** Scripted `PostClient`; records requests; non-2xx answers return `ok: false` (never throws), like the real one. */
export class FakePost implements PostClient {
  readonly requests: (FakeRequest & { options?: PostRequestOptions | undefined })[] = [];
  private readonly table = new RouteTable();
  private readonly policy: EgressPolicy | null;

  constructor(options: FakePostOptions = {}) {
    this.policy =
      options.allowedHosts === undefined
        ? null
        : new EgressPolicy({
            allowedHosts: options.allowedHosts,
            ...(options.allowHttpHosts === undefined
              ? {}
              : { allowHttpHosts: options.allowHttpHosts }),
            ...(options.allowedPorts === undefined ? {} : { allowedPorts: options.allowedPorts }),
            ...(options.postPathAllowlist === undefined
              ? {}
              : { postPathAllowlist: options.postPathAllowlist }),
          });
  }

  on(match: FakeMatch, responder: Responder): this {
    this.table.add(match, responder, 'POST');
    return this;
  }

  isAllowed(url: string): boolean {
    return this.policy === null ? true : this.policy.isAllowed(url, 'post');
  }

  private async send<T>(
    url: string,
    body: string,
    contentType: string,
    options?: PostRequestOptions,
  ): Promise<PostResponse<T>> {
    this.policy?.assert(url, 'post');
    const headers: Record<string, string> = { 'content-type': contentType };
    for (const [k, v] of Object.entries(options?.headers ?? {})) headers[k.toLowerCase()] = v;
    if (options?.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;
    const req = { method: 'POST', url, headers, body, options };
    this.requests.push(req);
    const spec = await this.table.resolve(req);
    if (spec.throws !== undefined) throw spec.throws;
    const text = new TextDecoder().decode(toBytes(spec.body));
    let json: T | undefined;
    try {
      json = text === '' ? undefined : (JSON.parse(text) as T);
    } catch {
      json = undefined;
    }
    const status = spec.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: spec.headers ?? {},
      text,
      json,
      safeUrl: redactUrl(url),
    };
  }

  postJson<T = unknown>(
    url: string,
    body: unknown,
    options?: PostRequestOptions,
  ): Promise<PostResponse<T>> {
    return this.send<T>(url, JSON.stringify(body), 'application/json', options);
  }

  postForm<T = unknown>(
    url: string,
    form: Readonly<Record<string, string>>,
    options?: PostRequestOptions,
  ): Promise<PostResponse<T>> {
    return this.send<T>(
      url,
      new URLSearchParams(form as Record<string, string>).toString(),
      'application/x-www-form-urlencoded',
      options,
    );
  }

  postText<T = unknown>(
    url: string,
    text: string,
    options?: PostRequestOptions & { contentType?: string },
  ): Promise<PostResponse<T>> {
    return this.send<T>(url, text, options?.contentType ?? 'text/plain; charset=utf-8', options);
  }
}
