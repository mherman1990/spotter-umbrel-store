/**
 * Factories that every module's tests reuse: events, config, bars, quotes, and a full `AdapterDeps` wired to
 * fakes. All deterministic (counters, fixed dates), no randomness, no network, no singletons.
 */
import { createSilentLogger } from '../core/logger.js';
import { FakeClock } from '../core/clock.js';
import { NyseCalendar } from '../core/calendar.js';
import {
  buildEgressPolicyOptions,
  buildPostPathAllowlist,
  resolveNotifyEndpoints,
} from '../config/load.js';
import { eventId } from '../core/ids.js';
import { toExchangeIso } from '../core/time.js';
import type { AdapterDeps } from '../adapters/types.js';
import { CoverageSchema, type CoverageConfig, type CoverageConfigInput } from '../config/schema.js';
import { createSecrets, type SecretKey } from '../config/secrets.js';
import type { Store } from '../store/index.js';
import type { DailyBar, Event, QuoteTick } from '../types.js';
import { FakeHttp, FakePost } from './fake-http.js';
import { FakeWebSocketFactory } from './fake-ws.js';
import { tempDb, type TempStore } from './temp-db.js';

let seq = 0;

/** Reset the factory counter (call in `beforeEach` for ids that must be stable across tests). */
export function resetFactories(): void {
  seq = 0;
}

/**
 * A valid Event. `naturalKey` (default `test-<n>`) feeds `eventId`, so two events with the same naturalKey
 * collide exactly like re-polled facts do.
 *
 * @example
 * ```ts
 * const e = makeEvent({ kind: 'form4', source: 'filing', rulePriority: 'P1', naturalKey: 'acc#0' });
 * ```
 */
export function makeEvent(overrides: Partial<Event> & { naturalKey?: string } = {}): Event {
  const { naturalKey, ...rest } = overrides;
  const n = ++seq;
  const ticker = rest.ticker ?? 'BBW';
  const source = rest.source ?? 'filing';
  const kind = rest.kind ?? '8-K';
  const base: Event = {
    id: '',
    ticker,
    source,
    kind,
    ts: rest.ts ?? toExchangeIso(new Date('2026-12-03T12:02:11.000Z')),
    payload: rest.payload ?? { note: `synthetic event ${n}` },
  };
  const merged: Event = { ...base, ...rest };
  merged.id = rest.id ?? eventId({ ticker, source, kind, naturalKey: naturalKey ?? `test-${n}` });
  return merged;
}

/** Minimal valid coverage config input for BBW; override any top-level key (shallow merge). */
export function makeConfigInput(overrides: Partial<CoverageConfigInput> = {}): CoverageConfigInput {
  const base: CoverageConfigInput = {
    version: 1,
    tickers: [
      {
        symbol: 'BBW',
        name: 'Build-A-Bear Workshop, Inc.',
        cik: '0001113809',
        exchange: 'NYSE',
        earnings: { date: '2026-12-03', period_label: 'Q3 FY26' },
      },
    ],
    egress: {
      allowed_hosts: [
        'data.sec.gov',
        'www.sec.gov',
        'api.schwabapi.com',
        'api.finra.org',
        'ews.fip.finra.org',
        'cdn.finra.org',
        'api.stlouisfed.org',
        'api.anthropic.com',
        'www.nasdaqtrader.com',
        'news.google.com',
        'ntfy.sh',
        'host.docker.internal',
      ],
      http_allowed_hosts: ['host.docker.internal'],
    },
  };
  return { ...base, ...overrides };
}

/** A validated, defaulted `CoverageConfig` (BBW). */
export function makeConfig(overrides: Partial<CoverageConfigInput> = {}): CoverageConfig {
  return CoverageSchema.parse(makeConfigInput(overrides));
}

/**
 * `n` deterministic daily bars ending at `endDate` (default 2026-12-02), session days only, OLDEST FIRST.
 * Prices random-walk deterministically around `startPrice`; volume cycles around `volume`.
 */
export function makeBars(
  n: number,
  opts: { endDate?: string; startPrice?: number; volume?: number; dailyRangePct?: number } = {},
): DailyBar[] {
  const cal = new NyseCalendar();
  const end = opts.endDate ?? '2026-12-02';
  const range = opts.dailyRangePct ?? 3;
  // Walk back to collect n session dates ending on/before `end`.
  const dates: string[] = [];
  let d = end;
  while (dates.length < n) {
    if (cal.isSession(d)) dates.push(d);
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() - 1);
    d = t.toISOString().slice(0, 10);
  }
  dates.reverse();
  let price = opts.startPrice ?? 40;
  const baseVol = opts.volume ?? 300_000;
  return dates.map((date, i) => {
    const drift = Math.sin(i * 1.7) * 0.01 * price;
    const open = price;
    const close = Math.max(1, price + drift);
    const high = Math.max(open, close) * (1 + range / 200);
    const low = Math.min(open, close) * (1 - range / 200);
    price = close;
    return {
      date,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume: Math.round(baseVol * (1 + 0.2 * Math.cos(i * 0.9))),
    };
  });
}

const round = (x: number): number => Math.round(x * 100) / 100;

/** A complete quote tick (BBW, prior close 40, last 41). */
export function makeQuoteTick(overrides: Partial<QuoteTick> = {}): QuoteTick {
  return {
    symbol: 'BBW',
    last: 41,
    bid: 40.95,
    ask: 41.05,
    totalVolume: 120_000,
    high: 41.5,
    low: 40.2,
    open: 40.5,
    closePrior: 40,
    securityStatus: 'Normal',
    tsMs: Date.parse('2026-12-03T15:00:00.000Z'),
    ...overrides,
  };
}

export interface TestDeps {
  deps: AdapterDeps;
  clock: FakeClock;
  http: FakeHttp;
  post: FakePost;
  ws: FakeWebSocketFactory;
  store: Store;
  config: CoverageConfig;
  /** Closes the in-memory DB. */
  close(): void;
}

/**
 * A full `AdapterDeps` wired to fakes: FakeClock (2026-12-03T14:00Z, also the scheduler), NyseCalendar,
 * FakeHttp/FakePost built from the SAME egress policy options production uses (hosts, derived ports, and the POST
 * path allowlist: a test POST outside the Schwab token path or the configured hook paths fails like it would on
 * the Pi), FakeWebSocketFactory, in-memory store (adapters get the read-only `ReadStore` view; the full `Store`
 * is `TestDeps.store`), silent logger, secrets with only `SCOUT_SEC_CONTACT`.
 */
export function makeDeps(
  opts: {
    config?: CoverageConfig;
    secrets?: Partial<Record<SecretKey, string>>;
    clock?: FakeClock;
    temp?: TempStore;
  } = {},
): TestDeps {
  const config = opts.config ?? makeConfig();
  const clock = opts.clock ?? new FakeClock();
  const temp = opts.temp ?? tempDb();
  const secrets = createSecrets({ SCOUT_SEC_CONTACT: 'tests@example.invalid', ...opts.secrets });
  const endpoints = resolveNotifyEndpoints(config, secrets);
  const egress = buildEgressPolicyOptions(config, endpoints);
  const http = new FakeHttp({
    allowedHosts: egress.allowedHosts,
    allowedPorts: egress.allowedPorts,
    now: () => clock.now(),
  });
  const post = new FakePost({
    allowedHosts: egress.allowedHosts,
    allowHttpHosts: egress.allowHttpHosts,
    allowedPorts: egress.allowedPorts,
    postPathAllowlist: buildPostPathAllowlist(config, endpoints),
  });
  const ws = new FakeWebSocketFactory();
  const deps: AdapterDeps = {
    clock,
    scheduler: clock,
    calendar: new NyseCalendar(),
    http,
    post,
    ws: ws.factory,
    log: createSilentLogger(),
    store: temp.store.asReadStore(),
    config,
    secrets,
  };
  return { deps, clock, http, post, ws, store: temp.store, config, close: temp.close };
}
