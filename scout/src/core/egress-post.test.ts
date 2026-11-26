import { describe, expect, it } from 'vitest';
import { FakeFetch } from '../test-support/fake-http.js';
import { EgressPolicy } from './egress.js';
import { AllowlistedPostClient, createGuardedStandardFetch } from './egress-post.js';
import {
  EgressDeniedError,
  HttpNetworkError,
  HttpTimeoutError,
  ResponseTooLargeError,
} from './errors.js';

function post(fake: FakeFetch, timeoutMs?: number) {
  return new AllowlistedPostClient({
    allowedHosts: ['api.schwabapi.com', 'host.docker.internal', 'ntfy.sh'],
    allowHttpHosts: ['host.docker.internal'],
    allowedPorts: { 'host.docker.internal': [18789] },
    userAgent: 'scout-test/0.1 (tests)',
    fetchImpl: fake.fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe('AllowlistedPostClient', () => {
  it('postJson sends JSON with headers and Idempotency-Key, parses the JSON reply', async () => {
    const fake = new FakeFetch().on(
      'http://host.docker.internal:18789/hooks/scout',
      { status: 202, body: { ok: true } },
      'POST',
    );
    const res = await post(fake).postJson(
      'http://host.docker.internal:18789/hooks/scout',
      { ticker: 'BBW' },
      {
        headers: { Authorization: 'Bearer abc' },
        idempotencyKey: 'evt-1',
      },
    );
    expect(res.ok).toBe(true);
    expect(res.status).toBe(202);
    expect(res.json).toEqual({ ok: true });
    const req = fake.requests[0];
    expect(req?.method).toBe('POST');
    expect(req?.body).toBe('{"ticker":"BBW"}');
    expect(req?.headers['content-type']).toBe('application/json');
    expect(req?.headers['authorization']).toBe('Bearer abc');
    expect(req?.headers['idempotency-key']).toBe('evt-1');
  });

  it('postForm url-encodes (OAuth token endpoints); postText sends plain text (ntfy)', async () => {
    const fake = new FakeFetch().on(/./, { body: '' }, 'POST');
    const client = post(fake);
    await client.postForm('https://api.schwabapi.com/v1/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: 'a b+c',
    });
    expect(fake.requests[0]?.body).toBe('grant_type=refresh_token&refresh_token=a+b%2Bc');
    expect(fake.requests[0]?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    await client.postText('https://ntfy.sh/topic', 'hello', { headers: { Title: 'BBW' } });
    expect(fake.requests[1]?.body).toBe('hello');
    expect(fake.requests[1]?.headers['title']).toBe('BBW');
  });

  it('non-2xx is returned (ok:false), never thrown; non-JSON bodies yield json undefined', async () => {
    const fake = new FakeFetch().on(/./, { status: 401, body: 'nope' }, 'POST');
    const res = await post(fake).postJson('https://api.schwabapi.com/x', {});
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(res.json).toBeUndefined();
    expect(res.text).toBe('nope');
  });

  it('enforces the allowlist before connecting (host and plain-http rules)', async () => {
    const fake = new FakeFetch().on(/./, { body: '' }, 'POST');
    const client = post(fake);
    await expect(client.postJson('https://evil.example/', {})).rejects.toBeInstanceOf(
      EgressDeniedError,
    );
    await expect(client.postJson('http://api.schwabapi.com/', {})).rejects.toBeInstanceOf(
      EgressDeniedError,
    );
    expect(fake.requests).toHaveLength(0);
    expect(client.isAllowed('http://host.docker.internal:18789/x')).toBe(true);
    expect(client.isAllowed('http://ntfy.sh/x')).toBe(false);
  });

  it('single attempt: timeouts and network errors are thrown (outbox retries), with redacted URLs', async () => {
    const hang = new FakeFetch().on(/./, { hang: true }, 'POST');
    await expect(
      post(hang, 15).postJson('https://ntfy.sh/t?token=SEKRET', {}),
    ).rejects.toBeInstanceOf(HttpTimeoutError);
    expect(hang.requests).toHaveLength(1);
    const down = new FakeFetch().on(
      /./,
      { throws: new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }) },
      'POST',
    );
    const err = await post(down)
      .postJson('https://ntfy.sh/t?token=SEKRET', {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpNetworkError);
    expect((err as Error).message).toContain('ECONNREFUSED');
    expect((err as Error).message).not.toContain('SEKRET');
  });
});

describe('AllowlistedPostClient hardening', () => {
  it('enforces the POST path allowlist: the ONLY Schwab POST is the token endpoint', async () => {
    const fake = new FakeFetch().on(/./, { body: '{}' }, 'POST');
    const client = new AllowlistedPostClient({
      allowedHosts: ['api.schwabapi.com', 'ntfy.sh'],
      userAgent: 'scout-test/0.1 (tests)',
      fetchImpl: fake.fetch,
      postPathAllowlist: { 'api.schwabapi.com': ['/v1/oauth/token'], 'ntfy.sh': ['/'] },
    });
    await client.postForm('https://api.schwabapi.com/v1/oauth/token', { grant_type: 'x' });
    expect(fake.requests).toHaveLength(1);
    await expect(
      client.postJson('https://api.schwabapi.com/trader/v1/accounts/hash/anything', {}),
    ).rejects.toBeInstanceOf(EgressDeniedError);
    await expect(client.postJson('https://ntfy.sh/secret-topic', {})).rejects.toBeInstanceOf(
      EgressDeniedError,
    );
    expect(fake.requests).toHaveLength(1); // denied BEFORE connecting
    expect(client.isAllowed('https://api.schwabapi.com/marketdata/v1/quotes')).toBe(false);
  });

  it('redactPathSegments masks a path-borne credential (ntfy topic) in safeUrl, logs and errors', async () => {
    const down = new FakeFetch().on(
      /./,
      { throws: new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }) },
      'POST',
    );
    const ok = new FakeFetch().on(/./, { body: '' }, 'POST');
    const opts = {
      allowedHosts: ['ntfy.sh'],
      userAgent: 'scout-test/0.1 (tests)',
      redactPathSegments: ['my-secret-topic'],
    };
    const res = await new AllowlistedPostClient({ ...opts, fetchImpl: ok.fetch }).postText(
      'https://ntfy.sh/my-secret-topic',
      'hi',
    );
    expect(res.safeUrl).toBe('https://ntfy.sh/[REDACTED]');
    const err = (await new AllowlistedPostClient({ ...opts, fetchImpl: down.fetch })
      .postText('https://ntfy.sh/my-secret-topic', 'hi')
      .catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain('my-secret-topic');
  });

  it('caps the response while streaming', async () => {
    const stream = {
      getReader: () => ({
        read: () => Promise.resolve({ done: false, value: new Uint8Array(1024) }),
        cancel: () => Promise.resolve(),
      }),
    };
    const client = new AllowlistedPostClient({
      allowedHosts: ['ntfy.sh'],
      userAgent: 'scout-test/0.1 (tests)',
      maxBytes: 2048,
      fetchImpl: () =>
        Promise.resolve({
          status: 200,
          headers: { get: () => null },
          arrayBuffer: () => Promise.reject(new Error('unbuffered')),
          body: stream,
        }),
    });
    await expect(client.postText('https://ntfy.sh/x', 'hi')).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });
});

describe('createGuardedStandardFetch', () => {
  it('forces redirect: manual and re-validates a redirect Location against the allowlist', async () => {
    const seen: (RequestInit | undefined)[] = [];
    const redirectTo = (loc: string) =>
      ((_input: string | URL | Request, init?: RequestInit) => {
        seen.push(init);
        return Promise.resolve(new Response(null, { status: 307, headers: { location: loc } }));
      }) as typeof globalThis.fetch;
    const policy = new EgressPolicy({ allowedHosts: ['api.anthropic.com'] });
    const evil = createGuardedStandardFetch(policy, redirectTo('https://evil.example/steal'));
    await expect(
      evil('https://api.anthropic.com/v1/messages', { method: 'POST', redirect: 'follow' }),
    ).rejects.toBeInstanceOf(EgressDeniedError);
    expect(seen[0]?.redirect).toBe('manual'); // an SDK-supplied 'follow' is overridden
    const fine = createGuardedStandardFetch(
      policy,
      redirectTo('https://api.anthropic.com/v1/other'),
    );
    const res = await fine('https://api.anthropic.com/v1/messages', { method: 'POST' });
    expect(res.status).toBe(307); // returned as-is, never followed
  });

  it('lets allowlisted hosts through and blocks the rest before calling the inner fetch', async () => {
    const calls: string[] = [];
    const inner = ((input: string | URL | Request) => {
      calls.push(String(input instanceof Request ? input.url : input));
      return Promise.resolve(new Response('ok'));
    }) as typeof globalThis.fetch;
    const guarded = createGuardedStandardFetch(
      new EgressPolicy({ allowedHosts: ['api.anthropic.com'] }),
      inner,
    );
    expect(await (await guarded('https://api.anthropic.com/v1/messages')).text()).toBe('ok');
    expect(() => guarded('https://evil.example/')).toThrow(EgressDeniedError);
    expect(() => guarded(new URL('https://evil.example/'))).toThrow(EgressDeniedError);
    expect(calls).toEqual(['https://api.anthropic.com/v1/messages']);
  });
});
