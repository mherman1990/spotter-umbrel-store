import { describe, expect, it, vi } from 'vitest';
import { FakeFetch } from '../test-support/fake-http.js';
import { FakeClock, type Sleep } from './clock.js';
import {
  EgressDeniedError,
  HttpError,
  HttpNetworkError,
  HttpTimeoutError,
  ResponseTooLargeError,
  ScoutError,
  ValidationError,
} from './errors.js';
import {
  AllowlistedHttpClient,
  DEFAULT_RATES,
  EXPOSED_HEADERS,
  buildUserAgent,
  type FetchLike,
  type HttpClientOptions,
} from './http.js';

const UA = 'scout-test/0.1 (tests@example.invalid)';

function client(fake: FakeFetch, extra: Partial<HttpClientOptions> = {}) {
  const clock = new FakeClock(0);
  const sleeps: number[] = [];
  const http = new AllowlistedHttpClient({
    allowedHosts: ['data.sec.gov', 'www.sec.gov', 'api.stlouisfed.org'],
    userAgent: UA,
    fetchImpl: fake.fetch,
    clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    ...extra,
  });
  return { http, clock, sleeps };
}

describe('AllowlistedHttpClient', () => {
  it('denies non-allowlisted hosts BEFORE any network activity', async () => {
    const fake = new FakeFetch();
    const { http } = client(fake);
    await expect(http.get('https://evil.example/x')).rejects.toBeInstanceOf(EgressDeniedError);
    await expect(http.get('http://data.sec.gov/x')).rejects.toBeInstanceOf(EgressDeniedError);
    expect(fake.requests).toHaveLength(0);
  });

  it('sends the User-Agent and parses JSON/text; getJson sets Accept', async () => {
    const fake = new FakeFetch().on('https://data.sec.gov/a.json', { body: { ok: 1 } });
    const { http } = client(fake);
    const res = await http.get('https://data.sec.gov/a.json');
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ ok: 1 });
    expect(res.contentType).toBe('application/json');
    expect(fake.requests[0]?.headers['user-agent']).toBe(UA);
    expect(fake.requests[0]?.method).toBe('GET');
    expect(await http.getJson('https://data.sec.gov/a.json')).toEqual({ ok: 1 });
    expect(fake.requests[1]?.headers['accept']).toBe('application/json');
    expect(await http.getText('https://data.sec.gov/a.json')).toBe('{"ok":1}');
  });

  it('withUserAgent shares limiter/cache but sends its own UA; per-call userAgent overrides', async () => {
    const fake = new FakeFetch().on(/./, { body: 'x' });
    const { http } = client(fake);
    const scoped = http.withUserAgent('scout-edgar/0.1 (c@example.invalid)');
    await scoped.get('https://data.sec.gov/a');
    await http.get('https://data.sec.gov/a', { userAgent: 'custom-agent/1.0 (c)' });
    expect(fake.requests.map((r) => r.headers['user-agent'])).toEqual([
      'scout-edgar/0.1 (c@example.invalid)',
      'custom-agent/1.0 (c)',
    ]);
    expect(http.requestCount()).toBe(2);
    expect(scoped.requestCount()).toBe(2);
  });

  it('retries 429/503 honoring Retry-After and eventually succeeds', async () => {
    const fake = new FakeFetch().on('https://data.sec.gov/r', [
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 503 },
      { status: 200, body: 'done' },
    ]);
    const { http, sleeps } = client(fake);
    const res = await http.get('https://data.sec.gov/r');
    expect(res.text()).toBe('done');
    expect(fake.requests).toHaveLength(3);
    expect(sleeps[0]).toBe(2000); // Retry-After: 2
    expect(sleeps[1]).toBe(1500); // base 500 * 2^1 + jitter 0.5*1000 = 1500
  });

  it('caps Retry-After at maxRetryDelayMs and gives up after maxRetries with an HttpError', async () => {
    const fake = new FakeFetch().on('https://data.sec.gov/r', {
      status: 503,
      headers: { 'retry-after': '3600' },
    });
    const { http, sleeps } = client(fake, { maxRetries: 2, maxRetryDelayMs: 5000 });
    await expect(http.get('https://data.sec.gov/r')).rejects.toMatchObject({
      name: 'HttpError',
      status: 503,
    });
    expect(fake.requests).toHaveLength(3);
    expect(sleeps).toEqual([5000, 5000]);
  });

  it('does not retry non-retryable 4xx', async () => {
    const fake = new FakeFetch().on('https://data.sec.gov/missing', { status: 404 });
    const { http } = client(fake);
    await expect(http.get('https://data.sec.gov/missing')).rejects.toBeInstanceOf(HttpError);
    expect(fake.requests).toHaveLength(1);
  });

  it('retries transport errors then surfaces HttpNetworkError', async () => {
    const boom = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    const fake = new FakeFetch().on('https://data.sec.gov/n', { throws: boom });
    const { http } = client(fake, { maxRetries: 1 });
    const err = await http.get('https://data.sec.gov/n').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpNetworkError);
    expect((err as Error).message).toContain('ECONNRESET');
    expect(fake.requests).toHaveLength(2);
  });

  it('times out hung requests with HttpTimeoutError (retried, then thrown)', async () => {
    const fake = new FakeFetch().on('https://data.sec.gov/h', { hang: true });
    const { http } = client(fake, { timeoutMs: 15, maxRetries: 1 });
    await expect(http.get('https://data.sec.gov/h')).rejects.toBeInstanceOf(HttpTimeoutError);
    expect(fake.requests).toHaveLength(2);
  });

  it('rate-limits per host group: SEC hosts share one bucket and WAIT instead of failing (no burst)', async () => {
    const fake = new FakeFetch().on(/./, { body: 'x' });
    const { http, sleeps, clock } = client(fake, { ratePerSecond: { sec: 2 } });
    const t0 = clock.nowMs();
    await http.get('https://data.sec.gov/1'); // the bucket starts with ONE token
    expect(sleeps).toHaveLength(0);
    await http.get('https://www.sec.gov/2'); // same group: must wait ~500 ms for the next token
    expect(sleeps.length).toBeGreaterThan(0);
    expect(clock.nowMs() - t0).toBeGreaterThanOrEqual(500);
    // A different host has its own bucket (default 5 rps) and does not wait for its first request.
    const before = sleeps.length;
    await http.get('https://api.stlouisfed.org/x');
    expect(sleeps.length).toBe(before);
  });

  it('peak rate in ANY rolling second is at most perSecond + 1 (capacity 1: no 2x burst), under concurrency', async () => {
    const clock = new FakeClock(0);
    const stamps: number[] = [];
    const fake = new FakeFetch().on(/./, () => {
      stamps.push(clock.nowMs());
      return { body: 'x' };
    });
    // A REAL virtual-time sleep: parks on a FakeClock timer until the pump advances time, so concurrent
    // waiters overlap exactly as they do with real timers.
    const sleep: Sleep = (ms) => new Promise<void>((resolve) => void clock.setTimeout(resolve, ms));
    const http = new AllowlistedHttpClient({
      allowedHosts: ['data.sec.gov'],
      userAgent: UA,
      fetchImpl: fake.fetch,
      clock,
      sleep,
      scheduler: clock,
      random: () => 0.5,
    });
    const all = Promise.all(
      Array.from({ length: 20 }, (_, i) => http.get(`https://data.sec.gov/${i}`)),
    );
    let settled = false;
    void all.then(() => (settled = true));
    for (let i = 0; i < 5000 && !settled; i++) {
      clock.advance(10);
      await new Promise<void>((r) => setImmediate(r));
    }
    await all;
    expect(stamps).toHaveLength(20);
    let peak = 0;
    for (const s0 of stamps) {
      peak = Math.max(peak, stamps.filter((x) => x >= s0 && x <= s0 + 1000).length);
    }
    expect(peak).toBeLessThanOrEqual(5 + 1); // default sec rate 5 rps
    expect(peak).toBeGreaterThanOrEqual(5);
  });

  it('Schwab defaults to 2 rps (120/min, decision D13) and the rate key ignores a trailing dot', async () => {
    expect(DEFAULT_RATES['api.schwabapi.com']).toBe(2);
    const fake = new FakeFetch().on(/./, { body: 'x' });
    const { http, sleeps } = client(fake, { allowedHosts: ['data.sec.gov', 'www.sec.gov'] });
    await http.get('https://data.sec.gov/1');
    await http.get('https://data.sec.gov./2'); // trailing dot: SAME bucket, must wait
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it('aborting during a backoff wait stops promptly (not after Retry-After), and during a rate-limit wait', async () => {
    const fake = new FakeFetch().on('https://data.sec.gov/slow', {
      status: 503,
      headers: { 'retry-after': '30' },
    });
    const parked: Sleep = (_ms, signal) =>
      new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new ScoutError('ABORTED', 'aborted')), {
          once: true,
        });
      });
    const { http } = client(fake, { sleep: parked });
    const ac = new AbortController();
    const p = http.get('https://data.sec.gov/slow', { signal: ac.signal });
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(fake.requests).toHaveLength(1); // first attempt done, now parked in the 30 s backoff
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
    // rate-limit wait: the second call parks in takeToken and is also interruptible
    const fake2 = new FakeFetch().on(/./, { body: 'x' });
    const { http: h2 } = client(fake2, { sleep: parked });
    await h2.get('https://data.sec.gov/a');
    const ac2 = new AbortController();
    const p2 = h2.get('https://data.sec.gov/b', { signal: ac2.signal });
    await new Promise<void>((r) => setTimeout(r, 10));
    ac2.abort();
    await expect(p2).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('per-call retries and deadlineMs let a poll fail fast', async () => {
    const fake = new FakeFetch().on('https://data.sec.gov/r', { status: 503 });
    const { http, sleeps } = client(fake);
    await expect(http.get('https://data.sec.gov/r', { retries: 0 })).rejects.toMatchObject({
      status: 503,
    });
    expect(fake.requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
    // deadline: base 500ms backoff (+jitter 250) cannot fit inside a 300 ms budget -> one attempt only
    const fake2 = new FakeFetch().on('https://data.sec.gov/r', { status: 503 });
    const { http: h2 } = client(fake2);
    await expect(h2.get('https://data.sec.gov/r', { deadlineMs: 300 })).rejects.toMatchObject({
      name: 'HttpError',
      status: 503,
    });
    expect(fake2.requests).toHaveLength(1);
    await expect(h2.get('https://data.sec.gov/r', { retries: -1 })).rejects.toBeInstanceOf(
      RangeError,
    );
  });

  it('an exhausted deadline throws HttpTimeoutError before any attempt starts', async () => {
    const fake = new FakeFetch().on('https://data.sec.gov/r', { body: 'x' });
    const { http } = client(fake);
    const spent = await http
      .get('https://data.sec.gov/r', { deadlineMs: 0 })
      .catch((e: unknown) => e);
    expect(spent).toBeInstanceOf(HttpTimeoutError);
    expect(fake.requests).toHaveLength(0);
  });

  it('cancels (discards) every body it does not consume: redirects, retryable and error statuses, 304, HEAD', async () => {
    let discards = 0;
    const respond = (status: number, headers: Record<string, string> = {}) => ({
      status,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      discard: () => {
        discards++;
        return Promise.resolve();
      },
    });
    const script: Record<string, ReturnType<typeof respond>[]> = {
      'https://data.sec.gov/redir': [respond(301, { location: 'https://www.sec.gov/final' })],
      'https://www.sec.gov/final': [respond(200)],
      'https://data.sec.gov/boom': [respond(503), respond(503), respond(503), respond(503)],
      'https://data.sec.gov/nope': [respond(404)],
    };
    const fetchImpl: FetchLike = (url) => {
      const q = script[url];
      const next = q?.shift();
      if (next === undefined) throw new Error(`no scripted response for ${url}`);
      return Promise.resolve(next);
    };
    const { http } = client(new FakeFetch(), { fetchImpl });
    await http.get('https://data.sec.gov/redir');
    expect(discards).toBe(1); // the redirect response (the final 200 body was consumed)
    await expect(http.get('https://data.sec.gov/boom')).rejects.toBeInstanceOf(HttpError);
    expect(discards).toBe(1 + 4); // all four 503 attempts released their sockets
    await expect(http.get('https://data.sec.gov/nope')).rejects.toBeInstanceOf(HttpError);
    expect(discards).toBe(1 + 4 + 1);
  });

  it('enforces the size cap WHILE streaming (the stream is cancelled when the cap is crossed)', async () => {
    let cancelled = false;
    let reads = 0;
    const stream = {
      getReader: () => ({
        read: () => {
          reads++;
          return Promise.resolve({ done: false, value: new Uint8Array(6) });
        },
        cancel: () => {
          cancelled = true;
          return Promise.resolve();
        },
      }),
    };
    const fetchImpl: FetchLike = () =>
      Promise.resolve({
        status: 200,
        headers: { get: () => null },
        arrayBuffer: () => Promise.reject(new Error('must not buffer the whole body')),
        body: stream,
      });
    const { http } = client(new FakeFetch(), { fetchImpl, maxBytes: 10 });
    await expect(http.get('https://data.sec.gov/endless')).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
    expect(cancelled).toBe(true);
    expect(reads).toBe(2); // 6 bytes, then 12 > 10: stopped, not read to the end
    // a stream within the cap is reassembled in order
    let i = 0;
    const parts = [new Uint8Array([104, 105]), new Uint8Array([33])];
    const ok: FetchLike = () =>
      Promise.resolve({
        status: 200,
        headers: { get: () => null },
        arrayBuffer: () => Promise.reject(new Error('unused')),
        body: {
          getReader: () => ({
            read: () => {
              const value = parts[i++];
              return Promise.resolve(value === undefined ? { done: true } : { done: false, value });
            },
            cancel: () => Promise.resolve(),
          }),
        },
      });
    const { http: h2 } = client(new FakeFetch(), { fetchImpl: ok });
    expect((await h2.get('https://data.sec.gov/x')).text()).toBe('hi!');
  });

  it('exposes link and schwab-client-correlid headers (and only the whitelist)', async () => {
    const fake = new FakeFetch().on('https://data.sec.gov/p', {
      body: 'x',
      headers: {
        Link: '<https://data.sec.gov/p2>; rel="next"',
        'Schwab-Client-CorrelId': 'abc-123',
        'X-Secret-Internal': 'nope',
      },
    });
    const { http } = client(fake);
    const res = await http.get('https://data.sec.gov/p');
    expect(res.headers['link']).toContain('rel="next"');
    expect(res.headers['schwab-client-correlid']).toBe('abc-123');
    expect(res.headers['x-secret-internal']).toBeUndefined();
    expect(EXPOSED_HEADERS).toContain('link');
  });

  it('network errors never echo credentials: undici-style invalid-header messages are redacted', async () => {
    const boom = new TypeError(
      'Headers.append: "Bearer sk-ant-api03-abcdefghijklmnop" is an invalid header value',
    );
    const fake = new FakeFetch().on('https://data.sec.gov/n', { throws: boom });
    const { http } = client(fake, { maxRetries: 0 });
    const err = (await http.get('https://data.sec.gov/n').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(HttpNetworkError);
    expect(err.message).not.toContain('sk-ant');
    expect(err.message).toContain('[REDACTED]');
  });

  it('follows redirects, re-validating the allowlist on every hop', async () => {
    const fake = new FakeFetch()
      .on('https://data.sec.gov/old', {
        status: 301,
        headers: { location: 'https://www.sec.gov/new' },
      })
      .on('https://www.sec.gov/new', { body: 'moved' })
      .on('https://data.sec.gov/evil', {
        status: 302,
        headers: { location: 'https://evil.example/steal' },
      })
      .on('https://data.sec.gov/loop', { status: 302, headers: { location: '/loop' } });
    const { http } = client(fake, { maxRedirects: 2 });
    const res = await http.get('https://data.sec.gov/old');
    expect(res.text()).toBe('moved');
    expect(res.url).toBe('https://www.sec.gov/new');
    await expect(http.get('https://data.sec.gov/evil')).rejects.toBeInstanceOf(EgressDeniedError);
    expect(fake.requests.some((r) => r.url.includes('evil.example'))).toBe(false);
    await expect(http.get('https://data.sec.gov/loop')).rejects.toBeInstanceOf(HttpError);
  });

  it('drops Authorization on a cross-host redirect', async () => {
    const fake = new FakeFetch()
      .on('https://data.sec.gov/a', { status: 302, headers: { location: 'https://www.sec.gov/b' } })
      .on('https://www.sec.gov/b', { body: 'ok' });
    const { http } = client(fake);
    await http.get('https://data.sec.gov/a', {
      headers: { Authorization: 'Bearer t', 'X-Keep': 'yes' },
    });
    expect(fake.requests[0]?.headers['authorization']).toBe('Bearer t');
    expect(fake.requests[1]?.headers['authorization']).toBeUndefined();
    expect(fake.requests[1]?.headers['x-keep']).toBe('yes');
  });

  it('conditional GET: sends validators, serves the cache on 304, and works without validators', async () => {
    const fake = new FakeFetch()
      .on('https://data.sec.gov/c', (req) =>
        req.headers['if-none-match'] === '"v1"'
          ? { status: 304 }
          : {
              body: 'payload',
              headers: { etag: '"v1"', 'last-modified': 'Wed, 01 Jan 2026 00:00:00 GMT' },
            },
      )
      .on('https://data.sec.gov/nov', { body: 'plain' });
    const { http } = client(fake);
    const first = await http.get('https://data.sec.gov/c', { conditional: true });
    expect(first.notModified).toBe(false);
    const second = await http.get('https://data.sec.gov/c', { conditional: true });
    expect(second.notModified).toBe(true);
    expect(second.fromCache).toBe(true);
    expect(second.text()).toBe('payload');
    expect(second.status).toBe(200);
    expect(fake.requests[1]?.headers['if-none-match']).toBe('"v1"');
    // no validators from the server => nothing cached, never a 304 dependency
    await http.get('https://data.sec.gov/nov', { conditional: true });
    await http.get('https://data.sec.gov/nov', { conditional: true });
    expect(fake.requests[3]?.headers['if-none-match']).toBeUndefined();
  });

  it('enforces the size cap from content-length and from the body', async () => {
    const fake = new FakeFetch()
      .on('https://data.sec.gov/big1', { body: 'x', headers: { 'content-length': '999999' } })
      .on('https://data.sec.gov/big2', { body: 'x'.repeat(50) });
    const { http } = client(fake, { maxBytes: 10 });
    await expect(http.get('https://data.sec.gov/big1')).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
    await expect(http.get('https://data.sec.gov/big2')).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });

  it('never leaks API keys in errors or safeUrl', async () => {
    const fake = new FakeFetch()
      .on('https://api.stlouisfed.org/fred/ok?api_key=SEKRET', { body: '{}' })
      .on('https://api.stlouisfed.org/fred/bad?api_key=SEKRET', { status: 400 });
    const { http } = client(fake);
    const ok = await http.get('https://api.stlouisfed.org/fred/ok?api_key=SEKRET');
    expect(ok.safeUrl).not.toContain('SEKRET');
    const err = await http
      .get('https://api.stlouisfed.org/fred/bad?api_key=SEKRET')
      .catch((e: unknown) => e);
    expect((err as Error).message).not.toContain('SEKRET');
    expect(JSON.stringify((err as HttpError).details)).not.toContain('SEKRET');
  });

  it('invalid JSON raises ValidationError naming only the safe URL', async () => {
    const fake = new FakeFetch().on('https://api.stlouisfed.org/x?api_key=K', { body: 'not json' });
    const { http } = client(fake);
    const res = await http.get('https://api.stlouisfed.org/x?api_key=K');
    expect(() => res.json()).toThrow(ValidationError);
    try {
      res.json();
    } catch (e) {
      expect((e as Error).message).not.toContain('=K');
    }
  });

  it('HEAD requests return an empty body; caller abort is not retried', async () => {
    const fake = new FakeFetch().on('https://data.sec.gov/h', { body: 'ignored' });
    const { http } = client(fake);
    const head = await http.head('https://data.sec.gov/h');
    expect(head.body.byteLength).toBe(0);
    expect(fake.requests[0]?.method).toBe('HEAD');
    const ac = new AbortController();
    ac.abort();
    await expect(http.get('https://data.sec.gov/h', { signal: ac.signal })).rejects.toMatchObject({
      code: 'ABORTED',
    });
  });

  it('validates construction and builds SEC-style user agents', () => {
    expect(
      () => new AllowlistedHttpClient({ allowedHosts: ['a.example'], userAgent: 'x' }),
    ).toThrow(RangeError);
    expect(
      () =>
        new AllowlistedHttpClient({ allowedHosts: ['a.example'], userAgent: UA, maxRetries: -1 }),
    ).toThrow(RangeError);
    expect(buildUserAgent('scout-edgar', ' me@example.invalid ')).toBe(
      'scout-edgar/0.1 (me@example.invalid)',
    );
    expect(() => buildUserAgent('scout', '  ')).toThrow(RangeError);
  });
});

describe('defaultFetch with the real platform Response (streaming cap and body discard)', () => {
  const makeStream = (
    chunks: number,
    size: number,
    onCancel: () => void,
  ): ReadableStream<Uint8Array> => {
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i++ >= chunks) controller.close();
        else controller.enqueue(new Uint8Array(size).fill(65));
      },
      cancel() {
        onCancel();
      },
    });
  };

  it('stops reading and cancels the stream once the byte cap is crossed', async () => {
    let cancelled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            makeStream(1000, 1024, () => (cancelled = true)),
            { status: 200 },
          ),
        ),
      ),
    );
    try {
      const http = new AllowlistedHttpClient({
        allowedHosts: ['data.sec.gov'],
        userAgent: UA,
        maxBytes: 4096,
        maxRetries: 0,
      });
      await expect(http.get('https://data.sec.gov/endless')).rejects.toBeInstanceOf(
        ResponseTooLargeError,
      );
      expect(cancelled).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads a normal streamed body completely and cancels the body of an error status', async () => {
    let cancelled = false;
    const calls: Response[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const r = url.endsWith('/ok')
          ? new Response(
              makeStream(3, 100, () => undefined),
              { status: 200 },
            )
          : new Response(
              makeStream(1000, 1024, () => (cancelled = true)),
              { status: 404 },
            );
        calls.push(r);
        return Promise.resolve(r);
      }),
    );
    try {
      const http = new AllowlistedHttpClient({
        allowedHosts: ['data.sec.gov'],
        userAgent: UA,
        maxRetries: 0,
      });
      const ok = await http.get('https://data.sec.gov/ok');
      expect(ok.body.byteLength).toBe(300);
      await expect(http.get('https://data.sec.gov/missing')).rejects.toBeInstanceOf(HttpError);
      expect(cancelled).toBe(true); // the unread 404 body was cancelled, not left holding the socket
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
