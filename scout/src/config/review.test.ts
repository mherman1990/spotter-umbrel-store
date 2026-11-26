/**
 * Regression tests for the foundation review of the config layer: strictness, per-ticker overrides, egress
 * validation, live reload, thesis path safety, plan sanity, secrets scoping.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, SecretsError } from '../core/errors.js';
import { EgressPolicy } from '../core/egress.js';
import { makeConfig, makeConfigInput } from '../test-support/factories.js';
import { tempDir } from '../test-support/temp-db.js';
import {
  ConfigHolder,
  ANTHROPIC_POST_PATHS,
  buildEgressPolicyOptions,
  buildPostPathAllowlist,
  formatIssues,
  loadCoverage,
  parseCoverage,
  parsePositionPlan,
  resolveConfigLocation,
  resolveNotifyEndpoints,
  resolveThesisPath,
  restartRequiredChanges,
  seedConfigIfMissing,
  validateEgress,
} from './load.js';
import { CoverageSchema, quoteSymbols, resolveTicker } from './schema.js';
import { createSecrets, loadSecrets, SECRET_KEYS } from './secrets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shippedYaml = fs.readFileSync(path.join(ROOT, 'config', 'coverage.yaml'), 'utf8');

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});
const tmp = (): string => {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
};

/** Human-readable issues of a failed parse (the ZodError message itself is JSON). */
function issuesOf(input: unknown): string {
  const r = CoverageSchema.safeParse(input);
  if (r.success) return '';
  return formatIssues(r.error);
}

/** The shipped YAML with one textual change applied (must change something). */
function yamlWith(from: string, to: string): string {
  if (!shippedYaml.includes(from)) throw new Error(`fixture drift: ${from}`);
  return shippedYaml.replace(from, to);
}

describe('per-ticker polling override (zod 4 applied inner defaults and reset every other cadence)', () => {
  it('a single override changes ONLY that key: global edgar 60 + ticker ir 30 -> edgar stays 60', () => {
    const text = yamlWith(
      '  edgar_seconds: 120 # market hours',
      '  edgar_seconds: 60 # market hours',
    ).replace(
      '    aliases: [Build-A-Bear, Build A Bear, BBW]',
      '    aliases: [Build-A-Bear, Build A Bear, BBW]\n    polling: { ir_seconds: 30 }',
    );
    const cfg = parseCoverage(text);
    expect(cfg.tickers[0]?.polling).toEqual({ ir_seconds: 30 }); // no defaults leak into the override
    const r = resolveTicker(cfg, 'BBW');
    expect(r?.polling.edgar_seconds).toBe(60);
    expect(r?.polling.ir_seconds).toBe(30);
    expect(r?.polling.edgar_earnings_seconds).toBe(30);
    expect(r?.polling.halts_seconds).toBe(30);
  });

  it('an unknown polling key in an override is rejected, not ignored', () => {
    const base = makeConfigInput();
    expect(() =>
      CoverageSchema.parse({
        ...base,
        tickers: [{ ...base.tickers[0]!, polling: { edgar_secs: 5 } }],
      }),
    ).toThrow(/edgar_secs/);
  });
});

describe('coverage.yaml is STRICT: a typo fails the load with its path', () => {
  it('rejects unknown keys at the top level and nested (p1_capp, atr_mult, reminder_hours)', () => {
    expect(() => parseCoverage(yamlWith('  p1_cap: 6', '  p1_capp: 2\n  p1_cap: 6'))).toThrow(
      /notify.*p1_capp/,
    );
    expect(() =>
      parseCoverage(yamlWith('atr_multiple: 2,', 'atr_mult: 9, atr_multiple: 2,')),
    ).toThrow(/atr_mult/);
    expect(() => parseCoverage(`${shippedYaml}\nbogus_section: 1\n`)).toThrow(/bogus_section/);
    expect(() =>
      parseCoverage(
        yamlWith(
          '  base_url: https://api.schwabapi.com\n  options_chain',
          '  base_url: https://api.schwabapi.com\n  reminder_hours: [48]\n  options_chain',
        ),
      ),
    ).toThrow(/reminder_hours/);
  });

  it('the shipped file and the test factory still validate', () => {
    expect(() => parseCoverage(shippedYaml)).not.toThrow();
    expect(() => makeConfig()).not.toThrow();
  });
});

describe('validation gaps closed', () => {
  it('an invalid IANA time zone fails at load (schedules, quiet hours, call timezone)', () => {
    expect(() =>
      parseCoverage(
        yamlWith(
          '  timezone: America/Chicago\n  premarket',
          '  timezone: America/Chicag0\n  premarket',
        ),
      ),
    ).toThrow(/time zone/);
    expect(() =>
      parseCoverage(
        yamlWith(
          '    timezone: America/Chicago\n    exceptions',
          '    timezone: Mars/Olympus\n    exceptions',
        ),
      ),
    ).toThrow(/time zone/);
    expect(() =>
      parseCoverage(yamlWith('call_timezone: America/New_York', 'call_timezone: Nowhere/Land')),
    ).toThrow(/time zone/);
  });

  it('a quiet window with start === end (silently "never quiet") is rejected', () => {
    expect(() =>
      parseCoverage(
        yamlWith("    start: '21:00'\n    end: '06:30'", "    start: '21:00'\n    end: '21:00'"),
      ),
    ).toThrow(/start must differ from end/);
  });

  it('every enabled endpoint host must be in egress.allowed_hosts (ntfy, Schwab, EDGAR, FINRA, Anthropic, agent URL)', () => {
    const noNtfy = makeConfigInput({
      egress: {
        allowed_hosts: ['data.sec.gov', 'www.sec.gov', 'api.schwabapi.com', 'host.docker.internal'],
        http_allowed_hosts: ['host.docker.internal'],
      },
    });
    const err = issuesOf(noNtfy);
    expect(err).toContain('ntfy host "ntfy.sh"');
    expect(err).toContain('FINRA short-interest file host "cdn.finra.org"');
    expect(err).toContain('Reg SHO file host "cdn.finra.org"');
    expect(err).toContain('Anthropic API host "api.anthropic.com"');
    expect(err).not.toContain('Schwab host'); // listed
    // disabling the feature removes the requirement
    expect(() =>
      CoverageSchema.parse({
        ...noNtfy,
        notify: { ntfy: { enabled: false } },
        llm: { enabled: false },
        halts: { nasdaq_trader: { enabled: false } },
        finra: { short_interest: { enabled: false }, reg_sho: { enabled: false } },
      }),
    ).not.toThrow();
    // an OpenClaw agent_url on an unlisted host
    expect(
      issuesOf({
        ...makeConfigInput(),
        notify: { openclaw: { agent_url: 'https://agent.example/hooks/agent' } },
      }),
    ).toContain('OpenClaw agent host "agent.example"');
    // plain http needs http_allowed_hosts
    expect(
      issuesOf({ ...makeConfigInput(), notify: { ntfy: { url: 'http://ntfy.sh' } } }),
    ).toContain('plain http');
  });

  it('http_allowed_hosts must be a subset of allowed_hosts', () => {
    const base = makeConfigInput();
    expect(
      issuesOf({ ...base, egress: { ...base.egress, http_allowed_hosts: ['lan.example'] } }),
    ).toContain('http_allowed_hosts entry "lan.example"');
  });

  it('a partial llm.models override works (only the synth id), keeping every other default', () => {
    const cfg = parseCoverage(
      yamlWith(
        '    synth:\n      id: claude-sonnet-5-5\n      effort: medium\n      max_tokens: 4096\n      server_fallbacks: true\n      price:\n        input_per_mtok: 2\n        output_per_mtok: 10\n        cache_read_per_mtok: 0.10\n        cache_write_multiplier: 1.25\n        cache_write_1h_multiplier: 2\n        batch_discount: 0.5\n        long_context: null\n',
        '    synth:\n      id: claude-sonnet-5-5-custom\n',
      ),
    );
    expect(cfg.llm.models.synth.id).toBe('claude-sonnet-5-5-custom');
    expect(cfg.llm.models.synth.price.input_per_mtok).toBe(2);
    expect(cfg.llm.models.synth.server_fallbacks).toBe(true);
    expect(cfg.llm.models.triage.id).toBe('claude-haiku-5-5');
    expect(cfg.llm.models.deep.price.output_per_mtok).toBe(20);
    // a single price override keeps the rest of that table
    const one = CoverageSchema.parse({
      ...makeConfigInput(),
      llm: { models: { deep: { price: { output_per_mtok: 25 } } } },
    });
    expect(one.llm.models.deep.price).toMatchObject({ input_per_mtok: 4, output_per_mtok: 25 });
  });

  it('quoteSymbols lists tickers, benchmarks, futures and the fallback proxies once each', () => {
    expect(quoteSymbols(makeConfig()).sort()).toEqual(['/ES', 'BBW', 'IWM', 'SPY', 'XRT']);
  });
});

describe('egress builders (ports derived from the configured endpoint URLs, POST path allowlist)', () => {
  const cfg = makeConfig();
  const secrets = createSecrets({ SCOUT_SEC_CONTACT: 'a@example.invalid' });
  const endpoints = resolveNotifyEndpoints(cfg, secrets);

  it('allows exactly the explicit ports named by endpoints (OpenClaw :18789), nothing else', () => {
    const opts = buildEgressPolicyOptions(cfg, endpoints);
    expect(opts.allowedPorts).toEqual({ 'host.docker.internal': [18789] });
    const policy = new EgressPolicy({ ...opts });
    expect(policy.isAllowed('http://host.docker.internal:18789/hooks/scout', 'post')).toBe(true);
    expect(policy.isAllowed('https://data.sec.gov:8443/x', 'get')).toBe(false);
  });

  it('the POST allowlist permits ONLY the Schwab token endpoint, the hook paths and the ntfy base', () => {
    const allow = buildPostPathAllowlist(cfg, endpoints);
    expect(allow['api.schwabapi.com']).toEqual(['/v1/oauth/token']);
    expect(allow['host.docker.internal']).toEqual(['/hooks/scout', '/hooks/agent']);
    expect(allow['ntfy.sh']).toEqual(['/']);
    const policy = new EgressPolicy({
      ...buildEgressPolicyOptions(cfg, endpoints),
      postPathAllowlist: allow,
    });
    expect(policy.isAllowed('https://api.schwabapi.com/v1/oauth/token', 'post')).toBe(true);
    expect(
      policy.isAllowed('https://api.schwabapi.com/trader/v1/accounts/x/anything', 'post'),
    ).toBe(false);
    expect(policy.isAllowed('http://host.docker.internal:18789/hooks/scout', 'post')).toBe(true);
    expect(policy.isAllowed('http://host.docker.internal:18789/hooks/other', 'post')).toBe(false);
    expect(policy.isAllowed('https://ntfy.sh/', 'post')).toBe(true);
    expect(policy.isAllowed('https://ntfy.sh/secret-topic', 'post')).toBe(false);
    expect(ANTHROPIC_POST_PATHS).toEqual(['/v1/*']);
  });

  it('validateEgress catches secrets-file overrides pointing at unlisted hosts (applied after load)', () => {
    const bad = resolveNotifyEndpoints(
      cfg,
      createSecrets({
        OPENCLAW_HOOK_URL: 'http://gateway.lan:18789/hooks/scout',
        NTFY_URL: 'https://ntfy.example.org',
      }),
    );
    const problems = validateEgress(cfg, bad);
    expect(problems.join('\n')).toContain('gateway.lan');
    expect(problems.join('\n')).toContain('ntfy.example.org');
    expect(validateEgress(cfg, endpoints)).toEqual([]);
  });
});

describe('where coverage.yaml lives, seeding and live reload (decision F18)', () => {
  it('resolution order: SCOUT_CONFIG, then <data dir>/coverage.yaml, then the bundled copy', () => {
    const bundled = '/app/config/coverage.yaml';
    expect(resolveConfigLocation({ envPath: '/x/c.yaml', bundledPath: bundled })).toEqual({
      path: '/x/c.yaml',
      source: 'env',
    });
    expect(
      resolveConfigLocation({ bundledPath: bundled, exists: (p) => p === '/data/coverage.yaml' }),
    ).toEqual({ path: '/data/coverage.yaml', source: 'data' });
    expect(resolveConfigLocation({ bundledPath: bundled, exists: () => false })).toEqual({
      path: bundled,
      source: 'bundled',
    });
    expect(
      resolveConfigLocation({
        envPath: '  ',
        dataDir: '/vol',
        bundledPath: bundled,
        exists: (p) => p === '/vol/coverage.yaml',
      }).source,
    ).toBe('data');
  });

  it('seedConfigIfMissing copies ONCE and never overwrites the owner edits', () => {
    const dir = tmp();
    const bundled = path.join(dir, 'bundled.yaml');
    const target = path.join(dir, 'data', 'coverage.yaml');
    fs.writeFileSync(bundled, shippedYaml);
    expect(seedConfigIfMissing(bundled, target)).toBe('seeded');
    expect(fs.readFileSync(target, 'utf8')).toBe(shippedYaml);
    fs.writeFileSync(target, `${shippedYaml}\n# owner edit\n`);
    expect(seedConfigIfMissing(bundled, target)).toBe('exists');
    expect(fs.readFileSync(target, 'utf8')).toContain('# owner edit');
    expect(() =>
      seedConfigIfMissing(path.join(dir, 'missing.yaml'), path.join(dir, 'o.yaml')),
    ).toThrow(ConfigError);
  });

  it('ConfigHolder reloads an edited consensus live, keeps the old config on a bad edit (reported once)', () => {
    const dir = tmp();
    const file = path.join(dir, 'coverage.yaml');
    fs.writeFileSync(file, shippedYaml);
    const holder = ConfigHolder.load(file);
    expect(holder.current().tickers[0]?.earnings?.consensus.revenue).toBeNull();
    expect(holder.checkReload()).toEqual({ status: 'unchanged' });

    // the day-before consensus edit: applied without a restart
    fs.writeFileSync(
      file,
      yamlWith('        revenue: null # USD millions', '        revenue: 462.5 # USD millions'),
    );
    expect(holder.checkReload()).toEqual({ status: 'reloaded', restartRequired: [] });
    expect(holder.current().tickers[0]?.earnings?.consensus.revenue).toBe(462.5);

    // an invalid edit keeps the previous config and reports the error exactly once
    fs.writeFileSync(file, 'tickers: []\n');
    const bad = holder.checkReload();
    expect(bad.status).toBe('error');
    expect(holder.current().tickers[0]?.earnings?.consensus.revenue).toBe(462.5);
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000)); // touched again, same bad content
    expect(holder.checkReload()).toEqual({ status: 'unchanged' });

    // fixing it reloads; an egress change is applied to memory but flagged as needing a restart
    fs.writeFileSync(
      file,
      yamlWith(
        '    - ntfy.sh # fallback notifier (change if self-hosted)',
        '    - ntfy.sh # fallback notifier (change if self-hosted)\n    - ir.example.com',
      ),
    );
    expect(holder.checkReload()).toEqual({ status: 'reloaded', restartRequired: ['egress'] });
    expect(() => ConfigHolder.load(path.join(dir, 'nope.yaml'))).toThrow(ConfigError);
  });

  it('restartRequiredChanges names only restart-sensitive sections', () => {
    const a = makeConfig();
    const shipped = parseCoverage(shippedYaml);
    const live = parseCoverage(yamlWith('  p1_cap: 6', '  p1_cap: 4'));
    expect(restartRequiredChanges(shipped, live)).toEqual([]); // notify policy is live
    const b = CoverageSchema.parse({ ...makeConfigInput(), api: { port: 4000 } });
    expect(restartRequiredChanges(a, b)).toEqual(['api']);
    const c = CoverageSchema.parse({
      ...makeConfigInput(),
      schedules: { midday: { cron: '0 12 * * 1-5' } },
    });
    expect(restartRequiredChanges(a, c)).toEqual(['schedules']);
  });
});

describe('thesis path safety (the thesis text is shipped to the LLM and the weekly brief)', () => {
  const setup = (): { thesisDir: string; secretsPath: string; dir: string } => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'thesis'));
    fs.mkdirSync(path.join(dir, 'secrets'));
    fs.writeFileSync(path.join(dir, 'thesis', 'BBW.md'), '# thesis');
    fs.writeFileSync(path.join(dir, 'secrets', 'scout.env'), 'X=1');
    return {
      dir,
      thesisDir: path.join(dir, 'thesis'),
      secretsPath: path.join(dir, 'secrets', 'scout.env'),
    };
  };
  const plan = (thesis_file: string | null) => ({ ticker: 'BBW', thesis_file });

  it('resolves a plain file name inside thesis_dir and returns null when no thesis is named', () => {
    const s = setup();
    expect(resolveThesisPath(s, plan('BBW.md'))).toBe(path.join(s.thesisDir, 'BBW.md'));
    expect(resolveThesisPath(s, plan(null))).toBeNull();
    expect(resolveThesisPath(s, undefined)).toBeNull();
    expect(resolveThesisPath(s, plan('notes/new.md'))).toBe(
      path.join(s.thesisDir, 'notes', 'new.md'),
    ); // not created yet: fine
  });

  it('rejects absolute paths, .. segments, the directory itself, and the secrets directory', () => {
    const s = setup();
    expect(() => resolveThesisPath(s, plan('../../secrets/scout.env'))).toThrow(/\.\./);
    expect(() => resolveThesisPath(s, plan('a/../../x.md'))).toThrow(ConfigError);
    expect(() => resolveThesisPath(s, plan('/etc/passwd'))).toThrow(/absolute/);
    expect(() => resolveThesisPath(s, plan('C:\\Windows\\x'))).toThrow(/absolute/);
    expect(() => resolveThesisPath(s, plan('.'))).toThrow(/outside/);
    // thesis_dir nested INSIDE the secrets dir must still not read secrets
    const inside = {
      thesisDir: path.join(path.dirname(s.secretsPath), 'thesis'),
      secretsPath: s.secretsPath,
    };
    fs.mkdirSync(inside.thesisDir, { recursive: true });
    expect(() => resolveThesisPath(inside, plan('BBW.md'))).toThrow(/secrets/);
  });

  it('rejects a symlink that escapes the thesis directory', () => {
    const s = setup();
    fs.symlinkSync(s.secretsPath, path.join(s.thesisDir, 'link.md'));
    expect(() => resolveThesisPath(s, plan('link.md'))).toThrow(/symlink/);
  });
});

describe('position plan sanity', () => {
  it('out-of-range numbers become unset/invalid instead of "set" (negative shares, zero level, 140%)', () => {
    const plan = parsePositionPlan(`BBW:
  target_shares: -5
  max_position_pct_of_liquid_net_worth: 150
  tranches:
    - { label: a, pct_of_target: 140, condition: x }
    - { label: b, pct_of_target: 0, condition: y }
  thesis_breakers: ['third FY guidance cut']
  price_levels: { review_below: 0, trim_above: -3 }
  earnings_rule: x
`);
    const p = plan.get('BBW');
    expect(p?.target_shares).toMatchObject({ status: 'unset', reason: 'invalid', raw: '-5' });
    expect(p?.max_position_pct_of_liquid_net_worth).toMatchObject({
      status: 'unset',
      reason: 'invalid',
    });
    expect(p?.price_levels.review_below).toMatchObject({ status: 'unset', reason: 'invalid' });
    expect(p?.price_levels.trim_above).toMatchObject({ status: 'unset', reason: 'invalid' });
    expect(p?.tranches.map((t) => t.pct_of_target.status)).toEqual(['unset', 'unset']);
    const fields = plan.completeness().missing.map((m) => m.field);
    expect(fields).toContain('target_shares');
    expect(fields).toContain('tranches[0].pct_of_target');
  });

  it('warns (without marking the plan incomplete) when tranche percentages do not sum to 100 or levels cross', () => {
    const plan = parsePositionPlan(`BBW:
  target_shares: 1000
  max_position_pct_of_liquid_net_worth: 5
  tranches:
    - { label: starter, pct_of_target: 80, condition: a }
    - { label: add_1, pct_of_target: 80, condition: b }
  thesis_breakers: ['x']
  price_levels: { review_below: 50, trim_above: 40 }
  earnings_rule: x
`);
    const c = plan.completeness();
    expect(c.complete).toBe(true);
    expect(c.warnings).toEqual([
      'BBW: tranche pct_of_target values sum to 160 (expected 100)',
      'BBW: price_levels.review_below (50) is not below trim_above (40)',
    ]);
    const ok = parsePositionPlan(`BBW:
  tranches:
    - { label: a, pct_of_target: 33, condition: a }
    - { label: b, pct_of_target: 33, condition: a }
    - { label: c, pct_of_target: 34, condition: a }
  price_levels: { review_below: 30, trim_above: 60 }
`);
    expect(ok.completeness().warnings).toEqual([]);
  });
});

describe('secrets scoping and leak hygiene', () => {
  it('scope() limits a view to the listed keys: reading any other key THROWS', () => {
    const all = createSecrets({
      SCOUT_SEC_CONTACT: 'me@example.invalid',
      ANTHROPIC_API_KEY: 'sk-ant-x',
    });
    const rss = all.scope(['SCOUT_SEC_CONTACT']);
    expect(rss.require('SCOUT_SEC_CONTACT')).toBe('me@example.invalid');
    expect(() => rss.require('ANTHROPIC_API_KEY')).toThrow(SecretsError);
    expect(() => rss.get('ANTHROPIC_API_KEY')).toThrow(/not granted/);
    expect(() => rss.isSet('FRED_API_KEY')).toThrow(SecretsError);
    // the report of a scoped view mentions only its own keys, and never a value
    const r = rss.report();
    expect(r.set).toEqual(['SCOUT_SEC_CONTACT']);
    expect(r.unset).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('sk-ant');
    // a scoped view can only narrow
    expect(() => rss.scope(['SCOUT_SEC_CONTACT', 'ANTHROPIC_API_KEY'])).toThrow(SecretsError);
    expect(() => all.scope(['NOT_A_KEY' as never])).toThrow(/Unknown secret key/);
    expect(rss.scope(['SCOUT_SEC_CONTACT']).get('SCOUT_SEC_CONTACT')).toBe('me@example.invalid');
    expect(SECRET_KEYS).toContain('ANTHROPIC_API_KEY');
  });

  it('a non-env-shaped "key" in the file (a pasted base64 value ending in "=") is reported as <malformed line N>, never as its text', () => {
    const dir = tmp();
    const file = path.join(dir, 'scout.env');
    fs.writeFileSync(
      file,
      [
        '# comment',
        'SCOUT_SEC_CONTACT=me@example.invalid',
        'TYPO_KEY=1',
        'c2stYW50LXNlY3JldC1rZXktdmFsdWU=',
        'lower_case_key=1',
      ].join('\n'),
      { mode: 0o600 },
    );
    const view = loadSecrets({ path: file, env: {} });
    const report = view.report();
    expect(report.ignored).toEqual(['TYPO_KEY', '<malformed line 4>', '<malformed line 5>']);
    expect(JSON.stringify(report)).not.toContain('c2stYW50');
  });

  it('an unreadable secrets file explains the uid-1000 fix', () => {
    const dir = tmp();
    const file = path.join(dir, 'scout.env');
    fs.writeFileSync(file, 'SCOUT_SEC_CONTACT=x');
    fs.chmodSync(file, 0o600);
    // strictPermissions off + a directory path forces a non-ENOENT read error (EISDIR) without needing root
    expect(() => loadSecrets({ path: dir, env: {}, strictPermissions: false })).toThrow(
      /Could not read secrets file/,
    );
  });
});

describe('the shipped config loads from disk through the holder', () => {
  it('ConfigHolder.load(config/coverage.yaml) agrees with loadCoverage', () => {
    const holder = ConfigHolder.load(path.join(ROOT, 'config', 'coverage.yaml'));
    expect(holder.current()).toEqual(loadCoverage(path.join(ROOT, 'config', 'coverage.yaml')));
  });
});
