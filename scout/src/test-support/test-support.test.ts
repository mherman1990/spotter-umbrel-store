import { describe, expect, it } from 'vitest';
import { FakeClock } from '../core/clock.js';
import { NyseCalendar } from '../core/calendar.js';
import { EgressDeniedError, HttpError } from '../core/errors.js';
import { eventId } from '../core/ids.js';
import { AllowlistedHttpClient } from '../core/http.js';
import {
  FakeFetch,
  FakeHttp,
  FakeLlmProvider,
  FakePost,
  FakeWebSocket,
  FakeWebSocketFactory,
  RecordingNotifier,
  fixturePath,
  hasFixture,
  loadFixture,
  loadFixtureBytes,
  loadJsonFixture,
  makeBars,
  makeConfig,
  makeConfigInput,
  makeDeps,
  makeEvent,
  makeQuoteTick,
  resetFactories,
  tempDb,
  tempDbFile,
  tempDir,
} from './index.js';
import type { ProviderRequest } from '../llm/types.js';
import type { AlertMessage } from '../notify/types.js';

const req = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model: 'claude-haiku-5-5',
  system: 's',
  cachedPrefix: 'p',
  volatile: 'v',
  maxTokens: 100,
  effort: 'low',
  serverFallbacks: false,
  cacheTtl: '5m',
  ...over,
});

describe('factories', () => {
  it('makeEvent yields stable, unique ids from natural keys and valid ET timestamps', () => {
    resetFactories();
    const a = makeEvent();
    const b = makeEvent();
    expect(a.id).not.toBe(b.id);
    expect(makeEvent({ naturalKey: 'k' }).id).toBe(makeEvent({ naturalKey: 'k' }).id);
    expect(makeEvent({ naturalKey: 'k' }).id).toBe(
      eventId({ ticker: 'BBW', source: 'filing', kind: '8-K', naturalKey: 'k' }),
    );
    expect(a.ts).toMatch(/-05:00$/);
    expect(makeEvent({ id: 'fixed' }).id).toBe('fixed');
  });

  it('makeConfig is valid and overridable', () => {
    expect(makeConfig().tickers[0]?.symbol).toBe('BBW');
    expect(makeConfigInput().egress.allowed_hosts).toContain('data.sec.gov');
    expect(makeConfig({ briefs: { writer: 'scout' } }).briefs.writer).toBe('scout');
  });

  it('makeBars: n session days, oldest first, deterministic, valid OHLC', () => {
    const bars = makeBars(25);
    expect(bars).toHaveLength(25);
    expect(bars.at(-1)?.date).toBe('2026-12-02');
    const cal = new NyseCalendar();
    expect(bars.every((b) => cal.isSession(b.date))).toBe(true);
    expect(bars.map((b) => b.date)).toEqual([...bars.map((b) => b.date)].sort());
    expect(
      bars.every(
        (b) =>
          b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close) && b.volume > 0,
      ),
    ).toBe(true);
    expect(makeBars(25)).toEqual(bars);
    expect(makeBars(3, { endDate: '2026-11-27' }).map((b) => b.date)).toEqual([
      '2026-11-24',
      '2026-11-25',
      '2026-11-27',
    ]);
  });

  it('makeQuoteTick is complete', () => {
    expect(makeQuoteTick({ last: 38 })).toMatchObject({
      symbol: 'BBW',
      last: 38,
      closePrior: 40,
      securityStatus: 'Normal',
    });
  });

  it('makeDeps wires a full AdapterDeps to fakes with the config allowlist and a contact secret', async () => {
    const d = makeDeps();
    try {
      expect(d.deps.secrets.require('SCOUT_SEC_CONTACT')).toContain('@');
      expect(d.deps.http.isAllowed('https://data.sec.gov/x')).toBe(true);
      expect(d.deps.http.isAllowed('https://evil.example/x')).toBe(false);
      d.http.on('https://data.sec.gov/x', { body: { a: 1 } });
      expect(await d.deps.http.getJson('https://data.sec.gov/x')).toEqual({ a: 1 });
      expect(d.deps.clock.now().toISOString()).toBe('2026-12-03T14:00:00.000Z');
      expect(d.store.events.countByStatus().new).toBe(0);
    } finally {
      d.close();
    }
  });
});

describe('FakeFetch / FakeHttp / FakePost', () => {
  it('unmatched requests throw (no accidental network); reply lists are consumed in order, last repeats', async () => {
    const fake = new FakeFetch().on('https://a.example/x', [{ body: '1' }, { body: '2' }]);
    const http = new AllowlistedHttpClient({
      allowedHosts: ['a.example', 'b.example'],
      userAgent: 'test-agent/1.0 (x)',
      fetchImpl: fake.fetch,
      maxRetries: 0,
    });
    expect(await http.getText('https://a.example/x')).toBe('1');
    expect(await http.getText('https://a.example/x')).toBe('2');
    expect(await http.getText('https://a.example/x')).toBe('2');
    await expect(http.getText('https://b.example/none')).rejects.toThrow(/no route/);
  });

  it('FakeHttp enforces its optional allowlist, records requests (UA included), supports wildcard prefixes and HttpError', async () => {
    const http = new FakeHttp({ allowedHosts: ['data.sec.gov'] });
    http.on('https://data.sec.gov/a/*', { body: 'wild' });
    http.on('https://data.sec.gov/err', { status: 503 });
    const scoped = http.withUserAgent('scout-x/1 (c)');
    expect(await scoped.getText('https://data.sec.gov/a/b/c')).toBe('wild');
    expect(http.requests[0]?.headers['user-agent']).toBe('scout-x/1 (c)');
    await expect(http.get('https://evil.example/')).rejects.toBeInstanceOf(EgressDeniedError);
    await expect(http.get('https://data.sec.gov/err')).rejects.toBeInstanceOf(HttpError);
    expect((await http.head('https://data.sec.gov/a/z')).status).toBe(200);
    expect(http.requestCount()).toBe(3);
  });

  it('FakePost records bodies/headers, returns ok:false for non-2xx, and enforces plain-http rules', async () => {
    const post = new FakePost({
      allowedHosts: ['host.docker.internal', 'ntfy.sh'],
      allowHttpHosts: ['host.docker.internal'],
      allowedPorts: { 'host.docker.internal': [18789] },
    });
    post.on(/hooks\/scout/, { status: 202, body: { ok: true } });
    post.on(/ntfy/, { status: 500 });
    const ok = await post.postJson(
      'http://host.docker.internal:18789/hooks/scout',
      { a: 1 },
      { idempotencyKey: 'k1' },
    );
    expect(ok).toMatchObject({ ok: true, status: 202, json: { ok: true } });
    expect(post.requests[0]?.headers['idempotency-key']).toBe('k1');
    expect((await post.postText('https://ntfy.sh/t', 'hi')).ok).toBe(false);
    await expect(post.postJson('http://ntfy.sh/t', {})).rejects.toBeInstanceOf(EgressDeniedError);
    expect(post.isAllowed('https://ntfy.sh/t')).toBe(true);
    await post.postForm('https://ntfy.sh/f', { a: 'b' }).catch(() => undefined);
  });
});

describe('FakeWebSocketFactory', () => {
  it('records sockets, drives open/receive/close, and can fail the next connection', () => {
    const f = new FakeWebSocketFactory();
    const ws = f.factory('wss://streamer.example/ws', { headers: { a: 'b' } });
    const events: string[] = [];
    ws.onopen = () => events.push('open');
    ws.onmessage = (m) => events.push(`msg:${m.data}`);
    ws.onclose = (c) => events.push(`close:${c.code}`);
    ws.onerror = (e) => events.push(`err:${e.message}`);
    expect(() => ws.send('x')).toThrow(/not OPEN/);
    f.latest().open();
    ws.send('hello');
    f.latest().receive({ notify: [{ heartbeat: '1' }] });
    f.latest().fail('boom');
    f.latest().serverClose(1006);
    expect(events).toEqual([
      'open',
      'msg:{"notify":[{"heartbeat":"1"}]}',
      'err:boom',
      'close:1006',
    ]);
    expect(f.latest().sent).toEqual(['hello']);
    expect(f.latest().sentJson()).toEqual([]);
    f.latest().close(); // already closed: no-op
    f.failNextWith = new Error('dns');
    expect(() => f.factory('wss://x')).toThrow('dns');
    f.autoOpen = true;
    const auto = f.factory('wss://y');
    expect(auto.readyState).toBe(0);
    expect(() => new FakeWebSocketFactory().latest()).toThrow(/no socket/);
  });

  it('client close fires onclose and records the code', () => {
    const f = new FakeWebSocketFactory();
    const ws = f.factory('wss://z');
    let closed: number | null = null;
    ws.onclose = (c) => {
      closed = c.code;
    };
    f.latest().open();
    ws.send(JSON.stringify({ a: 1 }));
    ws.close(1000, 'bye');
    expect(closed).toBe(1000);
    expect(f.latest().closedWith).toEqual({ code: 1000, reason: 'bye' });
    expect(f.latest().sentJson()).toEqual([{ a: 1 }]);
  });
});

describe('FakeLlmProvider (contract)', () => {
  it('replies FIFO, records requests, supports text/json/refusal/maxTokens/error/function and batches', async () => {
    const llm = new FakeLlmProvider();
    llm.push(
      { json: { material: true, priority: 'P2', so_what: 'x' } },
      { text: 'plain', usage: { cacheRead: 500 } },
      { refusal: true },
      { maxTokens: true },
      { error: new Error('503') },
      (r) => ({ text: `echo:${r.volatile}` }),
    );
    expect((await llm.complete(req())).text).toBe(
      '{"material":true,"priority":"P2","so_what":"x"}',
    );
    const second = await llm.complete(req({ model: 'claude-sonnet-5-5' }));
    expect(second).toMatchObject({
      text: 'plain',
      stopReason: 'end_turn',
      model: 'claude-sonnet-5-5',
    });
    expect(second.usage.cacheRead).toBe(500);
    expect((await llm.complete(req())).stopReason).toBe('refusal');
    expect((await llm.complete(req({ maxTokens: 7 }))).stopReason).toBe('max_tokens');
    await expect(llm.complete(req())).rejects.toThrow('503');
    expect((await llm.complete(req({ volatile: 'hi' }))).text).toBe('echo:hi');
    expect(llm.requests).toHaveLength(6);
    expect(llm.remaining()).toBe(0);
    await expect(llm.complete(req())).rejects.toThrow(/no scripted reply/);
  });

  it('batches return ended results (or in_progress when held) and report unknown ids', async () => {
    const llm = new FakeLlmProvider();
    llm.push({ text: 'a' }, { error: new Error('bad item') });
    const { batchId } = await llm.submitBatch([
      { customId: 'one', request: req() },
      { customId: 'two', request: req() },
    ]);
    const done = await llm.getBatch(batchId);
    expect(done.status).toBe('ended');
    expect(done.results?.map((r) => [r.customId, r.result?.text ?? r.error])).toEqual([
      ['one', 'a'],
      ['two', 'bad item'],
    ]);
    llm.holdBatches = true;
    expect((await llm.getBatch(batchId)).status).toBe('in_progress');
    await expect(llm.getBatch('nope')).rejects.toThrow(/unknown batch/);
    llm.reset();
    expect(llm.requests).toHaveLength(0);
  });
});

describe('RecordingNotifier', () => {
  it('records messages, scripts failures FIFO, and finds by idempotency key', async () => {
    const n = new RecordingNotifier('openclaw');
    n.failNext({ detail: 'ECONNREFUSED' });
    const msg: AlertMessage = {
      kind: 'alert',
      ticker: 'BBW',
      priority: 'P1',
      headline: 'h',
      facts: {},
      eventIds: ['e'],
      idempotencyKey: 'k',
    };
    expect(await n.send(msg)).toMatchObject({
      ok: false,
      status: 'failed',
      detail: 'ECONNREFUSED',
      retryable: true,
    });
    expect(await n.send(msg)).toMatchObject({ ok: true, status: 'sent', channel: 'openclaw' });
    expect(n.withKey('k')).toHaveLength(2);
    expect(n.withKey('other')).toHaveLength(0);
  });
});

describe('fixtures and temp helpers', () => {
  it('loads text/json/bytes fixtures and reports existence', () => {
    expect(loadJsonFixture<{ value: number }>('_selftest', 'hello.synthetic.json').value).toBe(42);
    expect(loadFixture('_selftest', 'hello.synthetic.json')).toContain('_synthetic');
    expect(loadFixtureBytes('_selftest', 'hello.synthetic.json').byteLength).toBeGreaterThan(10);
    expect(hasFixture('_selftest', 'hello.synthetic.json')).toBe(true);
    expect(hasFixture('nope.json')).toBe(false);
    expect(fixturePath('a', 'b')).toMatch(/test\/fixtures\/a\/b$/);
    expect(() => loadFixture('missing.json')).toThrow();
  });

  it('tempDb and tempDbFile give migrated stores that close cleanly; tempDir cleans up', () => {
    const m = tempDb();
    expect(m.store.events.countByStatus().new).toBe(0);
    m.close();
    m.close();
    const f = tempDbFile();
    expect(f.store.kv.get('x')).toBeUndefined();
    f.close();
    const d = tempDir();
    d.cleanup();
  });

  it('FakeClock-driven sleeper works with the real HTTP client (no real waiting)', async () => {
    const clock = new FakeClock(0);
    const fake = new FakeFetch().on(/./, { body: 'x' });
    const http = new AllowlistedHttpClient({
      allowedHosts: ['a.example'],
      userAgent: 'test-agent/1.0 (x)',
      fetchImpl: fake.fetch,
      clock,
      sleep: clock.sleeper(),
      defaultPerSecond: 1,
    });
    await http.get('https://a.example/1');
    await http.get('https://a.example/2');
    expect(clock.nowMs()).toBeGreaterThanOrEqual(1000);
  });
});

describe('foundation review: test doubles match production behavior', () => {
  it('FakeWebSocket asyncClose: close() goes CLOSING then CLOSED on a later tick (real ws is async)', async () => {
    const f = new FakeWebSocketFactory();
    f.behavior = { asyncClose: true };
    const ws = f.factory('wss://streamer.example/ws') as unknown as FakeWebSocket;
    ws.open();
    const closes: number[] = [];
    ws.onclose = (e) => closes.push(e.code);
    ws.close(1000, 'bye');
    expect(ws.readyState).toBe(2);
    expect(closes).toEqual([]); // not yet: reentrancy bugs show up here
    ws.close(); // already closing: ignored
    await Promise.resolve();
    expect(ws.readyState).toBe(3);
    expect(closes).toEqual([1000]);
    expect(ws.closedWith).toEqual({ code: 1000, reason: 'bye' });
  });

  it('FakeWebSocket strictSend:false drops sends after close like ws, but still throws while CONNECTING', () => {
    const f = new FakeWebSocketFactory();
    f.behavior = { strictSend: false };
    const ws = f.factory('wss://streamer.example/ws') as unknown as FakeWebSocket;
    expect(() => ws.send('early')).toThrow(/not OPEN/); // CONNECTING
    ws.open();
    ws.send('ok');
    ws.serverClose();
    expect(() => ws.send('late')).not.toThrow(); // dropped silently
    expect(ws.sent).toEqual(['ok']);
    const strict = new FakeWebSocketFactory().factory(
      'wss://s.example/',
    ) as unknown as FakeWebSocket;
    strict.open();
    strict.serverClose();
    expect(() => strict.send('x')).toThrow(/not OPEN/); // legacy strict default
  });

  it('FakeHttp applies the production header whitelist (a test cannot rely on a header production drops)', async () => {
    const http = new FakeHttp({ allowedHosts: ['data.sec.gov'] });
    http.on('https://data.sec.gov/x', {
      body: 'x',
      headers: { Link: '<n>; rel=next', 'X-Internal': 'nope', ETag: '"1"' },
    });
    const res = await http.get('https://data.sec.gov/x');
    expect(res.headers).toEqual({
      link: '<n>; rel=next',
      etag: '"1"',
      'content-type': 'text/plain',
    });
    expect(res.etag).toBe('"1"');
  });

  it('FakeFetch counts discarded bodies and FakeHttp enforces the port policy', async () => {
    const fake = new FakeFetch().on(/./, { status: 404 });
    const client = new AllowlistedHttpClient({
      allowedHosts: ['data.sec.gov'],
      userAgent: 'scout-test/0.1 (t)',
      fetchImpl: fake.fetch,
      maxRetries: 0,
    });
    await client.get('https://data.sec.gov/missing').catch(() => undefined);
    expect(fake.discarded).toBe(1);
    const http = new FakeHttp({ allowedHosts: ['data.sec.gov'], allowedPorts: {} });
    await expect(http.get('https://data.sec.gov:8443/x')).rejects.toBeInstanceOf(EgressDeniedError);
  });

  it('makeDeps provides scheduler, calendar and a read-only store; its POST client enforces the production path allowlist', async () => {
    const d = makeDeps();
    try {
      expect(d.deps.scheduler).toBe(d.clock);
      expect(d.deps.calendar.isSession('2026-12-03')).toBe(true);
      expect(d.deps.store.events.byStatus(['new'])).toEqual([]);
      expect(d.store.events).toBe(d.deps.store.events); // same repos; the type is the guard
      d.post.on(/./, { body: '{}' });
      await d.post.postForm('https://api.schwabapi.com/v1/oauth/token', { grant_type: 'x' });
      await expect(
        d.post.postJson('https://api.schwabapi.com/trader/v1/accounts/h/anything', {}),
      ).rejects.toBeInstanceOf(EgressDeniedError);
      await d.post.postJson('http://host.docker.internal:18789/hooks/scout', { a: 1 });
      await expect(
        d.post.postJson('http://host.docker.internal:18789/hooks/other', {}),
      ).rejects.toBeInstanceOf(EgressDeniedError);
    } finally {
      d.close();
    }
  });
});
