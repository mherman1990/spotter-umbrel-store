import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../core/errors.js';
import { makeConfig, makeConfigInput } from '../test-support/factories.js';
import { tempDir } from '../test-support/temp-db.js';
import {
  loadCoverage,
  loadPositionPlan,
  loadThesis,
  parseCoverage,
  parsePositionPlan,
  parseThesis,
  parseYaml,
  quotePlaceholders,
  resolveNotifyEndpoints,
  resolveStoragePaths,
} from './load.js';
import { CoverageSchema, resolveTicker, tickerSymbols } from './schema.js';
import { createSecrets } from './secrets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cfgPath = (...p: string[]): string => path.join(ROOT, 'config', ...p);

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});
const tmp = (): string => {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
};

describe('shipped config/coverage.yaml', () => {
  const cfg = loadCoverage(cfgPath('coverage.yaml'));

  it('validates and covers BBW with the right identity', () => {
    expect(tickerSymbols(cfg)).toEqual(['BBW']);
    const bbw = cfg.tickers[0];
    expect(bbw?.cik).toBe('0001113809');
    expect(bbw?.exchange).toBe('NYSE');
  });

  it('carries the spec section 3 default thresholds', () => {
    expect(cfg.tickers[0]?.thresholds).toEqual({
      price_move: { atr_multiple: 2, abs_pct: 6, atr_method: 'wilder', atr_min_bars: 15 },
      volume_pace: { multiple: 2.5, min_minutes_since_open: 10, min_adv: 50_000 },
      form4: { sale_usd_min: 250_000 },
      short_interest: { change_pct: 10, dtc_levels: [5, 10] },
      options: {
        iv30_jump_pct: 20,
        strike_volume_oi_multiple: 5,
        strike_min_contracts: 100,
        strike_min_oi: 10,
      },
      eight_k: { p1_items: ['2.02', '5.02', '1.01'], other_priority: 'P1' },
      periodic_report: { priority: 'P2' },
    });
    expect(cfg.benchmarks).toEqual(['IWM', 'XRT']);
  });

  it('has the Dec 3 2026 earnings date with null consensus (never invented)', () => {
    const e = cfg.tickers[0]?.earnings;
    expect(e?.date).toBe('2026-12-03');
    expect(e?.consensus).toEqual({ revenue: null, eps: null });
    expect(e?.mode_start_ct).toBe('05:00');
    expect(e?.call_time).toBe('09:00');
    expect(e?.call_timezone).toBe('America/New_York');
  });

  it('IR feed is a clearly-marked disabled TODO placeholder', () => {
    const feed = cfg.tickers[0]?.news.ir_feeds[0];
    expect(feed?.enabled).toBe(false);
    expect(feed?.url).toContain('todo-set-ir-rss-url.invalid');
    expect(feed?.note).toMatch(/TODO/);
  });

  it('the egress allowlist names every host from decision D8', () => {
    for (const h of [
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
    ]) {
      expect(cfg.egress.allowed_hosts, h).toContain(h);
    }
    expect(cfg.egress.http_allowed_hosts).toEqual(['host.docker.internal']);
    expect(cfg.egress.ws_allowed_host_suffixes).toEqual(['.schwab.com', '.schwabapi.com']);
  });

  it('matches spec sections 4/6/7/8 defaults (schedules, budget, models, earnings cadence)', () => {
    expect(cfg.schedules.timezone).toBe('America/Chicago');
    // Scout's brief jobs run ~5 minutes BEFORE Mayer's crons (06:45, 11:30, 15:15, Sat 08:00) so Mayer
    // always finds a materialized payload (decision F19).
    expect(cfg.schedules.premarket.cron).toBe('40 6 * * 1-5');
    expect(cfg.schedules.open_snapshot.cron).toBe('35 8 * * 1-5');
    expect(cfg.schedules.midday.cron).toBe('25 11 * * 1-5');
    expect(cfg.schedules.close.cron).toBe('10 15 * * 1-5');
    expect(cfg.schedules.close_early.cron).toBe('10 12 * * 1-5');
    expect(cfg.schedules.weekly.cron).toBe('50 7 * * 6');
    expect(cfg.schedules.earnings_tick.cron).toBe('* * * * *');
    expect(cfg.notify.p1_cap).toBe(6);
    expect(cfg.notify.p2_cluster).toEqual({ count: 3, window_minutes: 30 });
    expect(cfg.notify.quiet_hours).toMatchObject({
      start: '21:00',
      end: '06:30',
      timezone: 'America/Chicago',
    });
    expect(cfg.polling.edgar_seconds).toBe(120);
    expect(cfg.polling.edgar_earnings_seconds).toBe(30);
    expect(cfg.polling.ir_earnings_seconds).toBe(30);
    expect(cfg.briefs.writer).toBe('mayer');
    expect(cfg.briefs.futures_symbols).toEqual(['/ES']);
    expect(cfg.tickers[0]?.earnings?.post_call_summary_ct).toBe('10:30');
    expect(cfg.tickers[0]?.earnings?.push_deadline_seconds).toBe(240);
    expect(cfg.pipeline.triage_deadline_seconds).toBe(20);
    expect(cfg.notify.p1_cap_exempt).toEqual(['8k_item_2_02', 'halt']);
    expect(cfg.llm.models.triage.id).toBe('claude-haiku-5-5');
    expect(cfg.llm.models.synth.id).toBe('claude-sonnet-5-5');
    expect(cfg.llm.models.deep.id).toBe('claude-opus-5-5');
    expect(cfg.llm.models.synth.price).toMatchObject({
      input_per_mtok: 2,
      output_per_mtok: 10,
      cache_read_per_mtok: 0.1,
    });
    expect(cfg.llm.models.deep.price).toMatchObject({
      input_per_mtok: 4,
      output_per_mtok: 20,
      cache_read_per_mtok: 0.2,
    });
    expect(cfg.llm.models.triage.price.long_context).toMatchObject({
      threshold_tokens: 100_000,
      input_per_mtok: 0.5,
      output_per_mtok: 2.5,
    });
    expect(cfg.llm.models.triage.server_fallbacks).toBe(false);
    expect(cfg.llm.fallbacks).toBe(true);
    expect(cfg.retention.raw_payload_days).toBe(90);
    expect(cfg.api.port).toBe(3817);
  });

  it('is identical to what the schema produces from its own defaults for omitted blocks', () => {
    const minimal = CoverageSchema.parse(makeConfigInput());
    expect(minimal.llm.models).toEqual(cfg.llm.models);
    expect(minimal.notify.quiet_hours).toEqual(cfg.notify.quiet_hours);
  });
});

describe('coverage validation', () => {
  it('rejects duplicate tickers, bad cron, bad times and missing CIK with path-bearing messages', () => {
    const dup = makeConfigInput();
    const first = dup.tickers[0];
    if (first === undefined) throw new Error('fixture');
    expect(() => CoverageSchema.parse({ ...dup, tickers: [first, first] })).toThrow(
      /duplicate ticker BBW/,
    );
    expect(() =>
      CoverageSchema.parse({ ...dup, schedules: { premarket: { cron: 'nope' } } }),
    ).toThrow(/cron/);
    expect(() =>
      CoverageSchema.parse({ ...dup, notify: { quiet_hours: { start: '25:00' } } }),
    ).toThrow(/HH:mm/);
    expect(() =>
      CoverageSchema.parse({ ...dup, tickers: [{ symbol: 'BBW', name: 'x', exchange: 'NYSE' }] }),
    ).toThrow();
  });

  it('requires enabled feed hosts to be in egress.allowed_hosts (explicit egress, decision D8)', () => {
    const base = makeConfigInput();
    const t = {
      ...base.tickers[0]!,
      news: { ir_feeds: [{ id: 'ir', url: 'https://ir.example.invalid/rss', enabled: true }] },
    };
    expect(() => CoverageSchema.parse({ ...base, tickers: [t] })).toThrow(
      /ir\.example\.invalid.*egress\.allowed_hosts/,
    );
    const ok = CoverageSchema.parse({
      ...base,
      tickers: [t],
      egress: {
        ...base.egress,
        allowed_hosts: [...base.egress.allowed_hosts, 'ir.example.invalid'],
      },
    });
    expect(ok.tickers[0]?.news.ir_feeds[0]?.enabled).toBe(true);
  });

  it('plain-http OpenClaw host must be listed in http_allowed_hosts', () => {
    const base = makeConfigInput();
    expect(() =>
      CoverageSchema.parse({ ...base, egress: { allowed_hosts: base.egress.allowed_hosts } }),
    ).toThrow(/http_allowed_hosts/);
  });

  it('normalizes CIK, symbol case, and hostnames', () => {
    const cfg = parseCoverage(`
tickers:
  - { symbol: bbw, name: X, cik: 1113809, exchange: NYSE }
llm: { enabled: false }
schwab: { enabled: false }
notify: { ntfy: { enabled: false } }
edgar: { archive_base_url: 'https://data.sec.gov' }
finra: { short_interest: { enabled: false }, reg_sho: { enabled: false } }
egress:
  allowed_hosts: [DATA.SEC.GOV, host.docker.internal, www.nasdaqtrader.com]
  http_allowed_hosts: [host.docker.internal]
`);
    expect(cfg.tickers[0]?.cik).toBe('0001113809');
    expect(cfg.tickers[0]?.symbol).toBe('BBW');
    expect(cfg.egress.allowed_hosts[0]).toBe('data.sec.gov');
  });

  it('loadCoverage reports a missing file and bad YAML as ConfigError', () => {
    expect(() => loadCoverage('/nonexistent/coverage.yaml')).toThrow(ConfigError);
    expect(() => parseYaml('a: [unclosed', 'x.yaml')).toThrow(/Invalid YAML in x\.yaml/);
    expect(() => parseCoverage('tickers: []', 'c.yaml')).toThrow(/Invalid config c\.yaml/);
  });

  it('YAML 1.2 core schema keeps dates and yes/no as strings', () => {
    const doc = parseYaml('d: 2026-12-03\nflag: yes\nn: 0001113809') as Record<string, unknown>;
    expect(doc['d']).toBe('2026-12-03');
    expect(doc['flag']).toBe('yes');
  });
});

describe('resolveTicker', () => {
  it('overlays per-ticker polling overrides and inherits benchmarks', () => {
    const base = makeConfigInput();
    const cfg = CoverageSchema.parse({
      ...base,
      tickers: [{ ...base.tickers[0]!, polling: { edgar_seconds: 60 }, benchmarks: ['SPY'] }],
    });
    const r = resolveTicker(cfg, 'bbw');
    expect(r?.polling.edgar_seconds).toBe(60);
    expect(r?.polling.edgar_earnings_seconds).toBe(30);
    expect(r?.benchmarks).toEqual(['SPY']);
    expect(resolveTicker(makeConfig(), 'BBW')?.benchmarks).toEqual(['IWM', 'XRT']);
    expect(resolveTicker(cfg, 'NOPE')).toBeUndefined();
  });
});

describe('position plan (tolerant of placeholders)', () => {
  it('the shipped example template loads without crashing and reports what is unset', () => {
    const plan = loadPositionPlan(cfgPath('position_plan.example.yaml'));
    expect(plan.tickers()).toEqual(['BBW']);
    const bbw = plan.get('BBW');
    expect(bbw?.target_shares).toMatchObject({ status: 'unset', reason: 'placeholder' });
    expect(bbw?.max_position_pct_of_liquid_net_worth).toMatchObject({
      status: 'unset',
      reason: 'placeholder',
    });
    expect(bbw?.price_levels.review_below).toMatchObject({ status: 'unset' });
    expect(bbw?.tranches).toHaveLength(3);
    expect(bbw?.tranches[0]?.pct_of_target).toEqual({ status: 'set', value: 33 });
    expect(bbw?.tranches[0]?.condition).toMatchObject({ status: 'unset', reason: 'placeholder' });
    expect(bbw?.thesis_breakers).toEqual([
      'third FY guidance cut',
      'dividend cut or buyback suspension',
      'revolver draw to fund buybacks/dividend',
    ]);
    expect(bbw?.placeholder_breakers).toBe(1);
    expect(bbw?.thesis_file).toBe('BBW.md');
    const c = plan.completeness();
    expect(c.complete).toBe(false);
    const fields = c.missing.map((m) => m.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        'max_position_pct_of_liquid_net_worth',
        'target_shares',
        'tranches[0].condition',
        'tranches[1].condition',
        'tranches[2].condition',
        'price_levels.review_below',
        'price_levels.trim_above',
        'earnings_rule',
      ]),
    );
    expect(fields).not.toContain('thesis_breakers');
  });

  it("parses the spec's own unquoted placeholders (including `<blue: manual>`) via quotePlaceholders", () => {
    const text = `BBW:
  thesis_file: thesis/BBW.md
  max_position_pct_of_liquid_net_worth: <blue: manual>
  target_shares: <manual>
  tranches:
    - { label: starter, pct_of_target: 33, condition: "<price or event>" }
  thesis_breakers:
    - "third FY guidance cut"
    - "<add your own>"
  price_levels: { review_below: <manual>, trim_above: <manual> }
  earnings_rule: "<e.g. no adds within 3 sessions before a print>"
`;
    const plan = parsePositionPlan(text);
    const bbw = plan.get('bbw');
    expect(bbw?.max_position_pct_of_liquid_net_worth).toEqual({
      status: 'unset',
      reason: 'placeholder',
      raw: '<blue: manual>',
    });
    expect(bbw?.price_levels.trim_above).toEqual({
      status: 'unset',
      reason: 'placeholder',
      raw: '<manual>',
    });
    expect(plan.completeness().missing.length).toBeGreaterThan(5);
  });

  it('quotePlaceholders leaves quoted text, comments and ordinary text alone', () => {
    expect(quotePlaceholders('a: "<x>"\n# <y>\nb: price > 5 and < 6\nc: <z>')).toBe(
      'a: "<x>"\n# <y>\nb: price > 5 and < 6\nc: "<z>"',
    );
  });

  it('a filled plan is complete and numbers parse from strings like "$45.50", "1,200", "5%"', () => {
    const plan = parsePositionPlan(`BBW:
  thesis_file: thesis/BBW.md
  max_position_pct_of_liquid_net_worth: 5%
  target_shares: "1,200"
  tranches:
    - { label: starter, pct_of_target: 33, condition: "below 40" }
    - { label: add_1, pct_of_target: 67, condition: "after the print" }
  thesis_breakers: ["third FY guidance cut"]
  price_levels: { review_below: "$30.00", trim_above: 70 }
  earnings_rule: no adds within 3 sessions before a print
`);
    const bbw = plan.get('BBW');
    expect(bbw?.target_shares).toEqual({ status: 'set', value: 1200 });
    expect(bbw?.max_position_pct_of_liquid_net_worth).toEqual({ status: 'set', value: 5 });
    expect(bbw?.price_levels.review_below).toEqual({ status: 'set', value: 30 });
    expect(plan.completeness()).toMatchObject({
      complete: true,
      missing: [],
      setCount: 10,
      totalCount: 10,
    });
    expect(plan.completeness('BBW').complete).toBe(true);
  });

  it('never crashes on missing/odd values: null ticker, invalid numbers, no tranches, no breakers', () => {
    const plan = parsePositionPlan(`BBW:
AAPL:
  target_shares: lots
  price_levels:
  tranches: []
  thesis_breakers: ["<add your own>"]
`);
    expect(plan.tickers()).toEqual(['AAPL', 'BBW']);
    expect(plan.get('AAPL')?.target_shares).toEqual({
      status: 'unset',
      reason: 'invalid',
      raw: 'lots',
    });
    expect(plan.get('BBW')?.target_shares).toEqual({
      status: 'unset',
      reason: 'missing',
      raw: null,
    });
    expect(plan.completeness('AAPL').warnings).toEqual([]);
    const missing = plan.completeness('AAPL').missing;
    expect(missing).toContainEqual({
      ticker: 'AAPL',
      field: 'tranches',
      reason: 'none_defined',
      raw: null,
    });
    expect(missing).toContainEqual({
      ticker: 'AAPL',
      field: 'thesis_breakers',
      reason: 'none_defined',
      raw: null,
    });
    expect(plan.completeness('NOPE')).toEqual({
      complete: true,
      setCount: 0,
      totalCount: 0,
      missing: [],
      warnings: [],
    });
  });

  it('an empty plan file is an empty plan; only true YAML syntax errors throw', () => {
    expect(parsePositionPlan('').tickers()).toEqual([]);
    expect(() => parsePositionPlan('BBW: [unclosed')).toThrow(ConfigError);
  });

  it('loadPositionPlan: missing file throws by default, returns an empty plan with missing: "empty"', () => {
    expect(() => loadPositionPlan('/nonexistent/plan.yaml')).toThrow(ConfigError);
    expect(loadPositionPlan('/nonexistent/plan.yaml', { missing: 'empty' }).tickers()).toEqual([]);
  });

  it('hash() is stable for equal content and changes with content; toJSON is serializable', () => {
    const a = parsePositionPlan('BBW:\n  target_shares: 100\n');
    const b = parsePositionPlan('BBW:\n  target_shares: 100\n');
    const c = parsePositionPlan('BBW:\n  target_shares: 200\n');
    expect(a.hash()).toBe(b.hash());
    expect(a.hash()).not.toBe(c.hash());
    expect(JSON.parse(JSON.stringify(a)).tickers.BBW.target_shares).toEqual({
      status: 'set',
      value: 100,
    });
    expect(a.has('bbw')).toBe(true);
    expect(a.has('x')).toBe(false);
  });
});

describe('thesis loader', () => {
  it('parses the example thesis (headings, placeholder detection, hash)', () => {
    const t = loadThesis(cfgPath('thesis', 'BBW.example.md'));
    expect(t?.headings).toContain('Pillars');
    expect(t?.hasPlaceholders).toBe(true);
    expect(t?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(t?.bytes).toBeGreaterThan(100);
  });

  it('returns null for a missing file, uses the fallback when given, and detects a filled thesis', () => {
    expect(loadThesis('/nonexistent/BBW.md')).toBeNull();
    const dir = tmp();
    const real = path.join(dir, 'BBW.md');
    expect(loadThesis(real, { fallbackPath: cfgPath('thesis', 'BBW.example.md') })?.path).toContain(
      'BBW.example.md',
    );
    fs.writeFileSync(real, '# BBW\n\n## Thesis\n\nStores and brand.\n');
    const t = loadThesis(real);
    expect(t?.hasPlaceholders).toBe(false);
    expect(t?.headings).toEqual(['BBW', 'Thesis']);
    expect(parseThesis('x', 'p').headings).toEqual([]);
  });
});

describe('path and endpoint resolution', () => {
  it('resolves storage paths against data_dir; absolute entries stay; overrides win', () => {
    const cfg = makeConfig();
    expect(resolveStoragePaths(cfg)).toEqual({
      dataDir: '/data',
      dbPath: '/data/scout.db',
      secretsPath: '/data/secrets/scout.env',
      planPath: '/data/position_plan.yaml',
      thesisDir: '/data/thesis',
      backupsDir: '/data/backups',
    });
    expect(resolveStoragePaths(cfg, { dataDir: '/tmp/x' }).dbPath).toBe('/tmp/x/scout.db');
    const abs = CoverageSchema.parse({
      ...makeConfigInput(),
      storage: { db_file: '/var/db/s.db' },
    });
    expect(resolveStoragePaths(abs).dbPath).toBe('/var/db/s.db');
  });

  it('notify endpoints: secrets override coverage.yaml; token presence only; agentUrl derived from origin', () => {
    const cfg = makeConfig();
    const none = resolveNotifyEndpoints(cfg, createSecrets());
    expect(none.openclaw).toEqual({
      enabled: true,
      hookUrl: 'http://host.docker.internal:18789/hooks/scout',
      agentUrl: 'http://host.docker.internal:18789/hooks/agent',
      hasToken: false,
    });
    expect(none.ntfy).toEqual({
      enabled: true,
      baseUrl: 'https://ntfy.sh',
      topic: null,
      hasToken: false,
    });
    const over = resolveNotifyEndpoints(
      cfg,
      createSecrets({
        OPENCLAW_HOOK_URL: 'http://gw.local:9000/hooks/scout',
        OPENCLAW_HOOK_TOKEN: 't',
        NTFY_TOPIC: 'bbw-alerts',
        NTFY_URL: 'https://ntfy.example',
        NTFY_TOKEN: 'n',
      }),
    );
    expect(over.openclaw.hookUrl).toBe('http://gw.local:9000/hooks/scout');
    expect(over.openclaw.agentUrl).toBe('http://gw.local:9000/hooks/agent');
    expect(over.openclaw.hasToken).toBe(true);
    expect(over.ntfy).toEqual({
      enabled: true,
      baseUrl: 'https://ntfy.example',
      topic: 'bbw-alerts',
      hasToken: true,
    });
    expect(JSON.stringify(over)).not.toMatch(/"t"|"n"/);
  });
});

describe('example env file lists names only', () => {
  it('every allowlisted key appears and no key has a value', () => {
    const text = fs.readFileSync(cfgPath('scout.env.example'), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) expect(m[2], `${m[1]} must have no value`).toBe('');
    }
    for (const key of [
      'SCOUT_SEC_CONTACT',
      'SCHWAB_CLIENT_ID',
      'OPENCLAW_HOOK_TOKEN',
      'ANTHROPIC_API_KEY',
      'FRED_API_KEY',
      'IMAP_PASS',
    ]) {
      expect(text).toContain(`${key}=`);
    }
  });
});
