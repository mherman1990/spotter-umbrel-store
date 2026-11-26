/**
 * Pure config loaders: take paths/text, return validated objects, never read `process.env` or any global.
 * Adapted from BlackGold packages/core/src/config/load.ts (MIT, Copyright (c) 2026 Matt Herman): YAML 1.2
 * `core` schema (dates stay strings) + zod validation + `formatIssues`. Changes: no env handling here (that is
 * `secrets.ts`), placeholder-tolerant plan loading, thesis loader, path resolution.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYamlText } from 'yaml';
import type { z } from 'zod';
import { ConfigError } from '../core/errors.js';
import { sha256Hex } from '../core/ids.js';
import type { EgressPolicyOptions } from '../core/egress.js';
import { PositionPlan, PositionPlanSchema, type TickerPlan } from './plan.js';
import { ANTHROPIC_HOST, CoverageSchema, FINRA_AUTH_HOST, type CoverageConfig } from './schema.js';
import type { SecretsView } from './secrets.js';

/** `a.b: message; c: message` rendering of a zod error. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.map(String).join('.') || '<root>'}: ${i.message}`)
    .join('; ');
}

/** Parse YAML with the 1.2 core schema. @throws ConfigError on syntax errors (label names the source). */
export function parseYaml(text: string, label = '<yaml>'): unknown {
  try {
    return parseYamlText(text, { schema: 'core', version: '1.2' }) as unknown;
  } catch (err) {
    throw new ConfigError(`Invalid YAML in ${label}: ${(err as Error).message}`, { cause: err });
  }
}

/** Parse + validate YAML text against a zod schema. @throws ConfigError. */
export function parseYamlConfig<S extends z.ZodType>(
  text: string,
  schema: S,
  label = '<yaml>',
): z.output<S> {
  const doc = parseYaml(text, label);
  const parsed = schema.safeParse(doc ?? {});
  if (!parsed.success)
    throw new ConfigError(`Invalid config ${label}: ${formatIssues(parsed.error)}`);
  return parsed.data;
}

function readText(file: string, what: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new ConfigError(
      code === 'ENOENT'
        ? `${what} not found: ${file}`
        : `Could not read ${what} ${file}: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------------------------

/** Validate coverage YAML text. @throws ConfigError. */
export function parseCoverage(text: string, label = 'coverage.yaml'): CoverageConfig {
  return parseYamlConfig(text, CoverageSchema, label);
}

/** Read and validate `coverage.yaml`. @throws ConfigError (missing file, bad YAML, schema violations). */
export function loadCoverage(file: string): CoverageConfig {
  return parseCoverage(readText(file, 'coverage config'), file);
}

// ---------------------------------------------------------------------------------------------
// Position plan (tolerant)
// ---------------------------------------------------------------------------------------------

/**
 * Quote unquoted `<...>` placeholder scalars in value position so the spec's own template
 * (`target_shares: <manual>`, `max_position_pct_of_liquid_net_worth: <blue: manual>`) parses as YAML: a plain
 * scalar containing `: ` is otherwise a syntax error. Already-quoted placeholders and comment lines are left
 * untouched.
 */
export function quotePlaceholders(text: string): string {
  const valuePos = /(^|[:,[{]\s*|-\s+)(<[^<>\n]*>)(?=\s*(?:$|[,}\]]|\s#))/g;
  return text
    .split('\n')
    .map((line) => {
      if (line.trimStart().startsWith('#')) return line;
      return line.replace(
        valuePos,
        (_m, pre: string, ph: string) => `${pre}"${ph.replaceAll('"', "'")}"`,
      );
    })
    .join('\n');
}

/** Parse position-plan YAML text (placeholders tolerated). @throws ConfigError on YAML syntax errors only. */
export function parsePositionPlan(text: string, label = 'position_plan.yaml'): PositionPlan {
  return parseYamlConfig(quotePlaceholders(text), PositionPlanSchema, label);
}

export interface LoadPlanOptions {
  /** What to do when the file does not exist: throw (default) or return an empty plan. */
  missing?: 'throw' | 'empty';
}

/**
 * Read the owner's plan. Unfilled placeholders load as `unset` (see `PositionPlan#completeness`).
 * @throws ConfigError for a missing file (unless `missing: 'empty'`) or YAML syntax errors.
 */
export function loadPositionPlan(file: string, options: LoadPlanOptions = {}): PositionPlan {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && options.missing === 'empty') {
      return new PositionPlan({});
    }
    throw new ConfigError(`position plan not readable: ${file}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  return parsePositionPlan(text, file);
}

// ---------------------------------------------------------------------------------------------
// Thesis
// ---------------------------------------------------------------------------------------------

export interface ThesisDoc {
  path: string;
  text: string;
  /** Markdown headings (text only, without `#`). */
  headings: string[];
  sha256: string;
  bytes: number;
  /** True when the text still contains `<fill in ...>` / `<manual>` / TODO markers. */
  hasPlaceholders: boolean;
}

/** Parse thesis markdown. */
export function parseThesis(text: string, filePath: string): ThesisDoc {
  const headings = text
    .split('\n')
    .map((l) => /^#{1,6}\s+(.*\S)\s*$/.exec(l)?.[1])
    .filter((h): h is string => h !== undefined);
  return {
    path: filePath,
    text,
    headings,
    sha256: sha256Hex(text),
    bytes: Buffer.byteLength(text, 'utf8'),
    hasPlaceholders: /<(fill in|manual|todo)[^>]*>|\bTODO\b/i.test(text),
  };
}

/**
 * Read a thesis file. Returns `null` when it does not exist (the thesis is optional context); when
 * `fallbackPath` is given and exists it is used instead (e.g. the committed `BBW.example.md`).
 */
export function loadThesis(
  file: string,
  options: { fallbackPath?: string } = {},
): ThesisDoc | null {
  for (const candidate of [file, options.fallbackPath]) {
    if (candidate === undefined) continue;
    try {
      return parseThesis(fs.readFileSync(candidate, 'utf8'), candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new ConfigError(`Could not read thesis ${candidate}: ${(err as Error).message}`, {
          cause: err,
        });
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Paths and endpoint resolution
// ---------------------------------------------------------------------------------------------

export interface StoragePaths {
  dataDir: string;
  dbPath: string;
  secretsPath: string;
  planPath: string;
  thesisDir: string;
  backupsDir: string;
}

/** Resolve `storage` entries against the data dir (absolute entries are kept). `dataDir` overrides for dev/CLI. */
export function resolveStoragePaths(
  config: CoverageConfig,
  overrides: { dataDir?: string } = {},
): StoragePaths {
  const dataDir = overrides.dataDir ?? config.storage.data_dir;
  const abs = (p: string): string => (path.isAbsolute(p) ? p : path.join(dataDir, p));
  return {
    dataDir,
    dbPath: abs(config.storage.db_file),
    secretsPath: abs(config.storage.secrets_file),
    planPath: abs(config.storage.plan_file),
    thesisDir: abs(config.storage.thesis_dir),
    backupsDir: abs(config.storage.backups_dir),
  };
}

export interface NotifyEndpoints {
  openclaw: { enabled: boolean; hookUrl: string; agentUrl: string; hasToken: boolean };
  ntfy: { enabled: boolean; baseUrl: string; topic: string | null; hasToken: boolean };
}

/**
 * Effective notify endpoints: secrets-file values (`OPENCLAW_HOOK_URL`, `NTFY_URL`, `NTFY_TOPIC`) override
 * coverage.yaml. Returns URLs and token PRESENCE only; notifiers fetch token values from `SecretsView`.
 * `agentUrl` defaults to `<hook origin>/hooks/agent`.
 */
export function resolveNotifyEndpoints(
  config: CoverageConfig,
  secrets: SecretsView,
): NotifyEndpoints {
  const oc = config.notify.openclaw;
  const hookUrl = secrets.get('OPENCLAW_HOOK_URL') ?? oc.url;
  const agentUrl = oc.agent_url ?? new URL('/hooks/agent', hookUrl).toString();
  return {
    openclaw: {
      enabled: oc.enabled,
      hookUrl,
      agentUrl,
      hasToken: secrets.isSet('OPENCLAW_HOOK_TOKEN'),
    },
    ntfy: {
      enabled: config.notify.ntfy.enabled,
      baseUrl: secrets.get('NTFY_URL') ?? config.notify.ntfy.url,
      topic: secrets.get('NTFY_TOPIC') ?? config.notify.ntfy.topic,
      hasToken: secrets.isSet('NTFY_TOKEN'),
    },
  };
}

/**
 * `NotifyEndpoints` plus everything a caller needs to build the egress policies; see
 * {@link buildEgressPolicyOptions}.
 */
function allEndpointUrls(config: CoverageConfig, endpoints: NotifyEndpoints): string[] {
  const urls: string[] = [];
  for (const t of config.tickers)
    for (const f of [...t.news.ir_feeds, ...t.news.extra_feeds]) if (f.enabled) urls.push(f.url);
  if (endpoints.openclaw.enabled)
    urls.push(endpoints.openclaw.hookUrl, endpoints.openclaw.agentUrl);
  if (endpoints.ntfy.enabled) urls.push(endpoints.ntfy.baseUrl);
  if (config.schwab.enabled) urls.push(config.schwab.base_url);
  urls.push(config.edgar.data_base_url, config.edgar.archive_base_url);
  if (config.finra.short_interest.enabled && config.finra.short_interest.source === 'public_file')
    urls.push(config.finra.short_interest.public_file_url_template);
  if (config.finra.reg_sho.enabled) urls.push(config.finra.reg_sho.url_template);
  if (config.halts.nasdaq_trader.enabled) urls.push(config.halts.nasdaq_trader.url);
  if (config.fred.enabled) urls.push(config.fred.base_url);
  return urls;
}

/**
 * Problems with the RESOLVED endpoints: `coverage.yaml` is validated at load, but `OPENCLAW_HOOK_URL`, `NTFY_URL`
 * (secrets file) override it afterwards, so the composition root runs this once after `resolveNotifyEndpoints`.
 * An override pointing at a host missing from `egress.allowed_hosts` would otherwise surface as an
 * `EgressDeniedError` at 3 am (and ntfy is the FALLBACK channel). Returns human-readable problems; empty = OK.
 */
export function validateEgress(config: CoverageConfig, endpoints: NotifyEndpoints): string[] {
  const allowed = new Set(config.egress.allowed_hosts);
  const plainOk = new Set(config.egress.http_allowed_hosts);
  const problems: string[] = [];
  const check = (url: string, what: string): void => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      problems.push(`${what}: not a valid URL`);
      return;
    }
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (!allowed.has(host)) problems.push(`${what}: host "${host}" is not in egress.allowed_hosts`);
    if (u.protocol === 'http:' && !plainOk.has(host))
      problems.push(`${what}: plain http for "${host}" requires egress.http_allowed_hosts`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
      problems.push(`${what}: scheme ${u.protocol} is not allowed`);
  };
  if (endpoints.openclaw.enabled) {
    check(
      endpoints.openclaw.hookUrl,
      'OpenClaw hook URL (OPENCLAW_HOOK_URL / notify.openclaw.url)',
    );
    check(endpoints.openclaw.agentUrl, 'OpenClaw agent URL');
  }
  if (endpoints.ntfy.enabled)
    check(endpoints.ntfy.baseUrl, 'ntfy URL (NTFY_URL / notify.ntfy.url)');
  return problems;
}

/**
 * The options every egress policy (GET client, POST client, WebSocket factory) is built from: the named hosts,
 * plain-http hosts, ws suffixes, and `allowedPorts` DERIVED from the explicit ports that appear in the
 * configured endpoint URLs (the OpenClaw gateway `:18789` is the usual one; `https://data.sec.gov:8443/x` stays
 * denied because no endpoint names that port).
 */
export function buildEgressPolicyOptions(
  config: CoverageConfig,
  endpoints: NotifyEndpoints,
): Required<
  Pick<
    EgressPolicyOptions,
    'allowedHosts' | 'allowHttpHosts' | 'allowedWsHostSuffixes' | 'allowedPorts'
  >
> {
  const ports: Record<string, Set<number>> = {};
  for (const url of allEndpointUrls(config, endpoints)) {
    try {
      const u = new URL(url);
      if (u.port !== '') {
        const host = u.hostname.toLowerCase().replace(/\.$/, '');
        (ports[host] ??= new Set()).add(Number(u.port));
      }
    } catch {
      /* validated elsewhere */
    }
  }
  return {
    allowedHosts: config.egress.allowed_hosts,
    allowHttpHosts: config.egress.http_allowed_hosts,
    allowedWsHostSuffixes: config.egress.ws_allowed_host_suffixes,
    allowedPorts: Object.fromEntries(Object.entries(ports).map(([h, set]) => [h, [...set]])),
  };
}

/**
 * The POST path allowlist for the shared `AllowlistedPostClient` (decision D6, defense in depth): the ONLY POST
 * that can reach Schwab is the OAuth token endpoint; FINRA only its client-credentials token endpoint
 * (UNVERIFIED path); the OpenClaw gateway only the configured hook and agent paths; ntfy only its base URL path
 * (Scout publishes JSON to the base URL, the topic travels in the body). Anthropic POSTs go through a SEPARATE
 * policy ({@link ANTHROPIC_POST_PATHS}). A POST anywhere else throws `EgressDeniedError` before connecting, even
 * from an audited module and even if the source-code grep were bypassed.
 */
export function buildPostPathAllowlist(
  config: CoverageConfig,
  endpoints: NotifyEndpoints,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (host: string, p: string): void => {
    const h = host.toLowerCase().replace(/\.$/, '');
    const list = (out[h] ??= []);
    if (!list.includes(p)) list.push(p);
  };
  if (config.schwab.enabled) add(new URL(config.schwab.base_url).hostname, '/v1/oauth/token');
  if (config.finra.short_interest.enabled && config.finra.short_interest.source === 'query_api')
    add(FINRA_AUTH_HOST, '/fip/rest/ews/oauth2/access_token');
  if (endpoints.openclaw.enabled) {
    for (const url of [endpoints.openclaw.hookUrl, endpoints.openclaw.agentUrl]) {
      const u = new URL(url);
      add(u.hostname, u.pathname);
    }
  }
  if (endpoints.ntfy.enabled) {
    const u = new URL(endpoints.ntfy.baseUrl);
    add(u.hostname, u.pathname);
  }
  return out;
}

/** POST path patterns of the Anthropic SDK policy: `/v1/*` only (messages, batches). Host: {@link ANTHROPIC_HOST}. */
export const ANTHROPIC_POST_PATHS: readonly string[] = ['/v1/*'];
export { ANTHROPIC_HOST };

// ---------------------------------------------------------------------------------------------
// Where coverage.yaml lives, first-run seeding, and live reload (decision F18)
// ---------------------------------------------------------------------------------------------

export interface ConfigLocation {
  path: string;
  /** `env`: `SCOUT_CONFIG`; `data`: `<data dir>/coverage.yaml`; `bundled`: the copy baked into the image. */
  source: 'env' | 'data' | 'bundled';
}

/**
 * Entry-point rule for which `coverage.yaml` to load (decision F18). The owner must be able to edit consensus
 * the day before a print WITHOUT rebuilding the image, so the writable copy lives in the data volume:
 *
 *  1. `SCOUT_CONFIG` (not a secret; the entry point reads the env var and passes it as `envPath`);
 *  2. else `<dataDir>/coverage.yaml` when it exists (default dataDir `/data`);
 *  3. else the file baked into the image (`bundledPath`, e.g. `/app/config/coverage.yaml`).
 *
 * `storage.data_dir` lives INSIDE the file, so it cannot be used to find the file (chicken and egg): the
 * data dir for this lookup is `SCOUT_DATA_DIR` (entry point) or `/data`.
 */
export function resolveConfigLocation(opts: {
  envPath?: string | undefined;
  dataDir?: string | undefined;
  bundledPath: string;
  exists?: (p: string) => boolean;
}): ConfigLocation {
  const exists = opts.exists ?? ((p: string): boolean => fs.existsSync(p));
  if (opts.envPath !== undefined && opts.envPath.trim() !== '')
    return { path: opts.envPath, source: 'env' };
  const dataCopy = path.join(opts.dataDir ?? '/data', 'coverage.yaml');
  if (exists(dataCopy)) return { path: dataCopy, source: 'data' };
  return { path: opts.bundledPath, source: 'bundled' };
}

/**
 * `scout init-config`: copy the bundled default to `targetPath` ONCE. Never overwrites an existing file (the
 * owner's edits are sacred; `COPYFILE_EXCL` makes the check-and-copy atomic).
 */
export function seedConfigIfMissing(bundledPath: string, targetPath: string): 'seeded' | 'exists' {
  fs.mkdirSync(path.dirname(path.resolve(targetPath)), { recursive: true });
  try {
    fs.copyFileSync(bundledPath, targetPath, fs.constants.COPYFILE_EXCL);
    return 'seeded';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    throw new ConfigError(
      `Could not seed ${targetPath} from ${bundledPath}: ${(err as Error).message}`,
      {
        cause: err,
      },
    );
  }
}

/** Sections whose change needs a RESTART (sockets, adapters, binds, schedules, storage paths, egress). */
function restartSensitive(c: CoverageConfig): unknown {
  return {
    egress: c.egress,
    api: c.api,
    storage: c.storage,
    schedules: c.schedules,
    schwab: c.schwab,
    edgar: c.edgar,
    finra: c.finra,
    fred: c.fred,
    halts: c.halts,
    inbox: c.inbox,
    tickers: c.tickers.map((t) => ({
      symbol: t.symbol,
      cik: t.cik,
      exchange: t.exchange,
      feeds: [...t.news.ir_feeds, ...t.news.extra_feeds],
      google: t.news.google_news_query,
      institutions: t.institutions,
    })),
  };
}

/**
 * Names of the restart-sensitive sections that differ between two configs (empty = everything that changed is
 * applied live: thresholds, earnings blocks, consensus, benchmarks, polling cadence, notify policy, briefs, llm).
 */
export function restartRequiredChanges(prev: CoverageConfig, next: CoverageConfig): string[] {
  const a = restartSensitive(prev) as Record<string, unknown>;
  const b = restartSensitive(next) as Record<string, unknown>;
  return Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

export type ReloadResult =
  | { status: 'unchanged' }
  /** The in-memory config was swapped; `restartRequired` names sections that only apply after a restart (log it). */
  | { status: 'reloaded'; restartRequired: string[] }
  /** The file is invalid: the OLD config stays in force (raise ONE ops alert; do not crash). */
  | { status: 'error'; error: string };

/**
 * Holds the live `CoverageConfig`. The scheduler calls {@link ConfigHolder.checkReload} on every tick: a cheap
 * `stat` (mtime + size), then a content hash only when the file looks changed; a changed file is re-validated
 * and swapped in on success. A bad edit keeps the old config (reported once per distinct bad content). Consumers
 * read `current()` per use instead of caching the object, so `earnings.consensus` edits are picked up without a
 * restart. Changes to egress, adapters, binds, schedules and storage need a restart (reported, not applied).
 */
export class ConfigHolder {
  private cfg: CoverageConfig;
  private statKey: string;
  private hash: string;
  private failedHash: string | null = null;

  private constructor(
    readonly file: string,
    cfg: CoverageConfig,
    statKey: string,
    hash: string,
  ) {
    this.cfg = cfg;
    this.statKey = statKey;
    this.hash = hash;
  }

  /** Load and validate `file`. @throws ConfigError (startup is fatal on an invalid config). */
  static load(file: string): ConfigHolder {
    const text = readText(file, 'coverage config');
    const cfg = parseCoverage(text, file);
    return new ConfigHolder(file, cfg, ConfigHolder.statOf(file), sha256Hex(text));
  }

  private static statOf(file: string): string {
    try {
      const st = fs.statSync(file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return 'missing';
    }
  }

  current(): CoverageConfig {
    return this.cfg;
  }

  checkReload(): ReloadResult {
    const statKey = ConfigHolder.statOf(this.file);
    if (statKey === this.statKey) return { status: 'unchanged' };
    let text: string;
    try {
      text = readText(this.file, 'coverage config');
    } catch (err) {
      return { status: 'error', error: (err as Error).message };
    }
    const hash = sha256Hex(text);
    this.statKey = statKey;
    if (hash === this.hash) return { status: 'unchanged' };
    if (hash === this.failedHash) return { status: 'unchanged' }; // already reported this bad content
    try {
      const next = parseCoverage(text, this.file);
      const restartRequired = restartRequiredChanges(this.cfg, next);
      this.cfg = next;
      this.hash = hash;
      this.failedHash = null;
      return { status: 'reloaded', restartRequired };
    } catch (err) {
      this.failedHash = hash;
      return { status: 'error', error: (err as Error).message };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Thesis path safety
// ---------------------------------------------------------------------------------------------

/**
 * Resolve a plan's `thesis_file` to a path INSIDE `paths.thesisDir`, or `null` when the plan names none.
 * The text of this file is placed in the cached LLM prefix and in the weekly brief, so a hostile or mistaken
 * value (`../../secrets/scout.env`) would ship credentials to a third party. Rejected: absolute paths, any `..`
 * segment, anything that resolves outside the thesis dir (symlink escapes included, via `realpath`), and
 * anything under the secrets directory.
 * @throws ConfigError naming the plan value (never file contents)
 */
export function resolveThesisPath(
  paths: Pick<StoragePaths, 'thesisDir' | 'secretsPath'>,
  plan: Pick<TickerPlan, 'ticker' | 'thesis_file'> | undefined,
): string | null {
  const rel = plan?.thesis_file;
  if (rel === undefined || rel === null) return null;
  const fail = (why: string): never => {
    throw new ConfigError(`thesis_file "${rel}" for ${plan?.ticker ?? '?'} is not allowed: ${why}`);
  };
  if (path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel)) fail('absolute paths are rejected');
  if (rel.split(/[\\/]+/).some((seg) => seg === '..')) fail('".." segments are rejected');
  const base = path.resolve(paths.thesisDir);
  const candidate = path.resolve(base, rel);
  const inside = (child: string, parent: string): boolean =>
    child === parent || child.startsWith(parent + path.sep);
  if (!inside(candidate, base) || candidate === base)
    fail('it resolves outside the thesis directory');
  const secretsDir = path.resolve(path.dirname(paths.secretsPath));
  if (inside(candidate, secretsDir)) fail('it points into the secrets directory');
  try {
    const realBase = fs.realpathSync(base);
    const real = fs.realpathSync(candidate);
    if (!inside(real, realBase)) fail('a symlink makes it escape the thesis directory');
    if (inside(real, fs.realpathSync.native(secretsDir)))
      fail('it points into the secrets directory');
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    // not found yet (or the secrets dir does not exist): the path checks above already passed
  }
  return candidate;
}
