/**
 * `config/coverage.yaml` schema (zod 4). Everything tunable lives here: tickers, thresholds, polling cadence,
 * schedules, alert budget, notify endpoints, LLM models + prices + spend caps, API bind, the egress
 * allowlist and retention. Load with `loadCoverage()` (src/config/load.ts).
 *
 * Conventions:
 *  - snake_case keys in YAML (spec section 3/6 names), validated and defaulted here; no code reads raw YAML.
 *  - Secrets NEVER live here (tokens, keys, passwords): they come from `src/config/secrets.ts`.
 *  - STRICT: every object is a `z.strictObject`; an unknown key (`notify.p1_capp: 2`) FAILS the load with its
 *    path instead of silently falling back to a default (spec section 3: "all thresholds live in
 *    coverage.yaml" is only true if a typo cannot hide). The POSITION PLAN stays tolerant (`./plan.ts`).
 *  - zod 4 note: nested-object defaults use `.prefault({})` (parse the default through the schema) so inner
 *    field defaults apply. A per-ticker override block must NOT use a schema with defaults (zod 4 applies the
 *    inner defaults under `.partial().optional()`, so a single override would reset every other value):
 *    see `PollingOverrideSchema`.
 *
 * The position plan schema is separate (`./plan.ts`) and deliberately tolerant of unfilled placeholders.
 */
import { z } from 'zod';
import { isValidTimeZone } from '../core/time.js';
export * from './plan.js';

// ---------------------------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------------------------

/** `HH:mm` (24h). */
export const HmSchema = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'expected HH:mm (24h)');

/** `YYYY-MM-DD`, a real calendar date. */
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
  }, 'not a real calendar date');

/** Upper-case ticker symbol (`BBW`, `BRK.B`). */
export const SymbolSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9.-]{0,9}$/, 'expected a ticker symbol');

/** SEC CIK: digits (YAML may parse `0001113809` as a number), normalized to 10 zero-padded digits. */
export const CikSchema = z
  .union([z.string(), z.number().int().nonnegative()])
  .transform((v) => String(v).trim())
  .pipe(z.string().regex(/^\d{1,10}$/, 'CIK must be 1-10 digits'))
  .transform((s) => s.padStart(10, '0'));

/** Bare lower-case hostname (no scheme, port or path). */
export const HostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/,
    'expected a bare hostname',
  );

/** A 5- or 6-field cron expression (full validation happens in the scheduler via node-cron). */
export const CronSchema = z
  .string()
  .trim()
  .refine((s) => {
    const n = s.split(/\s+/).length;
    return n === 5 || n === 6;
  }, 'cron expression must have 5 or 6 fields');

const Pct = z.number().positive();
const PosInt = z.number().int().positive();
const PriorityEnum = z.enum(['P1', 'P2', 'P3']);

/** IANA zone name; an invalid one (`America/Chicag0`) fails at load, not later inside the pipeline. */
export const TimeZoneSchema = z
  .string()
  .refine(isValidTimeZone, 'not a valid IANA time zone (e.g. America/Chicago)');

/** A normalized 8-K item code such as `2.02`. */
const ItemCodeSchema = z.string().regex(/^\d{1,2}\.\d{2}$/, 'expected an 8-K item code like 2.02');

// ---------------------------------------------------------------------------------------------
// Thresholds (spec section 3). All defaults mirror the spec table; every one is per-ticker overridable.
// ---------------------------------------------------------------------------------------------

export const ThresholdsSchema = z.strictObject({
  /** Price move from prior close: P1 when >= atr_multiple x ATR% OR >= abs_pct (decision D24, literal OR). */
  price_move: z
    .strictObject({
      atr_multiple: Pct.default(2),
      abs_pct: Pct.default(6),
      /** 20-day ATR flavor (decision D24: "Wilder/simple"). */
      atr_method: z.enum(['wilder', 'sma']).default('wilder'),
      /** Minimum daily bars for the ATR to be trusted; below it only `abs_pct` can fire. */
      atr_min_bars: PosInt.default(15),
    })
    .prefault({}),
  /** Intraday volume pace vs time-of-day-adjusted ADV: P2 (P1 when paired with a price trigger). */
  volume_pace: z
    .strictObject({
      multiple: Pct.default(2.5),
      /** The pace is meaningless in the first minutes of the session (tiny expected fraction): no rule before this. */
      min_minutes_since_open: z.number().nonnegative().default(10),
      /** Illiquid names (ADV20 below this many shares) never fire the pace rule. */
      min_adv: z.number().nonnegative().default(50_000),
    })
    .prefault({}),
  /** Form 4: open-market sale (non-10b5-1) above `sale_usd_min` is P2 (strictly `>`; unknown 10b5-1 flag counts as non-10b5-1). */
  form4: z.strictObject({ sale_usd_min: z.number().nonnegative().default(250_000) }).prefault({}),
  short_interest: z
    .strictObject({
      /** Percent change vs previous settlement that triggers P2. */
      change_pct: Pct.default(10),
      /** Days-to-cover levels whose crossing triggers P2. */
      dtc_levels: z.array(Pct).default([5, 10]),
    })
    .prefault({}),
  options: z
    .strictObject({
      /** Day-over-day IV30 jump (percent, relative) that triggers P2. */
      iv30_jump_pct: Pct.default(20),
      /** Single-strike volume / open interest that triggers P2. */
      strike_volume_oi_multiple: Pct.default(5),
      /** ...and only when the strike traded at least this many contracts (OI 2 with 12 contracts is noise). */
      strike_min_contracts: PosInt.default(100),
      /** ...and only when the strike's open interest is at least this. */
      strike_min_oi: z.number().int().nonnegative().default(10),
    })
    .prefault({}),
  /**
   * 8-K priority (spec section 3 row "8-K filed | any; Items 2.02, 5.02, 1.01"; decision F14): the listed items
   * are P1, every other 8-K gets `other_priority`. Default P1 = the spec's literal "any 8-K is P1"; lower it to P2 to send other 8-Ks to the digest.
   */
  eight_k: z
    .strictObject({
      p1_items: z.array(ItemCodeSchema).default(['2.02', '5.02', '1.01']),
      other_priority: PriorityEnum.default('P1'),
    })
    .prefault({}),
  /** 10-Q / 10-K periodic reports have no row in spec section 3 (decision F14): P2, in the digest. */
  periodic_report: z.strictObject({ priority: PriorityEnum.default('P2') }).prefault({}),
});

export type Thresholds = z.output<typeof ThresholdsSchema>;

// ---------------------------------------------------------------------------------------------
// Polling cadence
// ---------------------------------------------------------------------------------------------

export const PollingSchema = z.strictObject({
  /**
   * EDGAR submissions poll (spec: every 2 min). Used in the premarket, regular AND afterhours phases (filings
   * land 16:00-17:30 ET and 06:00-08:00 ET); only the `closed` phase uses `edgar_offhours_seconds`.
   */
  edgar_seconds: PosInt.default(120),
  /** EDGAR poll in earnings mode (spec: every 30 s). Overrides every phase. */
  edgar_earnings_seconds: PosInt.default(30),
  /** Company IR / press-release feeds (same phase rule as EDGAR). */
  ir_seconds: PosInt.default(120),
  /** IR feed poll in earnings mode (spec section 8: tighten EDGAR + IR to 30 s). */
  ir_earnings_seconds: PosInt.default(30),
  /** Nasdaq Trader trade-halts feed; regular session ONLY (decision D14). */
  halts_seconds: PosInt.default(30),
  /** Option chain snapshot (spec: every 30 min), regular session only. */
  options_minutes: PosInt.default(30),
  /** Account positions (read-only). */
  positions_minutes: PosInt.default(15),
  /** Third-party news RSS (Google News). */
  news_minutes: PosInt.default(10),
  /** FINRA short interest / Reg SHO check cadence. */
  finra_hours: PosInt.default(6),
  /** FRED observations check cadence. */
  fred_hours: PosInt.default(6),
  /** `closed`-phase EDGAR and IR poll (nights/weekends/holidays), seconds. */
  edgar_offhours_seconds: PosInt.default(900),
});

/**
 * A per-ticker override of the polling cadence. NO defaults: only keys the owner wrote are present, so
 * overlaying it on the global block changes exactly those keys (a schema with defaults would reset every other
 * cadence to the hard-coded default; regression-tested).
 */
export const PollingOverrideSchema = z.strictObject({
  edgar_seconds: PosInt.optional(),
  edgar_earnings_seconds: PosInt.optional(),
  ir_seconds: PosInt.optional(),
  ir_earnings_seconds: PosInt.optional(),
  halts_seconds: PosInt.optional(),
  options_minutes: PosInt.optional(),
  positions_minutes: PosInt.optional(),
  news_minutes: PosInt.optional(),
  finra_hours: PosInt.optional(),
  fred_hours: PosInt.optional(),
  edgar_offhours_seconds: PosInt.optional(),
});

export type PollingOverride = z.output<typeof PollingOverrideSchema>;

export type Polling = z.output<typeof PollingSchema>;

// ---------------------------------------------------------------------------------------------
// Per-ticker blocks
// ---------------------------------------------------------------------------------------------

const GuidanceRangeSchema = z.strictObject({
  metric: z.enum(['revenue', 'pretax_income', 'eps', 'operating_income', 'other']),
  period: z.string().min(1),
  low: z.number().nullable().default(null),
  high: z.number().nullable().default(null),
  unit: z.enum(['usd', 'usd_millions', 'usd_per_share', 'pct']).default('usd_millions'),
});

export const EarningsSchema = z.strictObject({
  /** Release date (exchange calendar date). */
  date: IsoDateSchema,
  /** e.g. `Q3 FY26`. Used in labels and scorecard keys. */
  period_label: z.string().min(1).default('unspecified'),
  /** Release timing relative to the cash session. */
  timing: z.enum(['before_open', 'after_close', 'during']).default('before_open'),
  /** Earnings mode starts at this America/Chicago time on `date` (spec section 8: 05:00 CT). */
  mode_start_ct: HmSchema.default('05:00'),
  /**
   * The post-call Sonnet summary + plan-impact line runs at this America/Chicago time (spec section 8: 10:30
   * CT), and earnings mode ENDS then (`PollModeProvider`): polling returns to the normal cadence.
   */
  post_call_summary_ct: HmSchema.default('10:30'),
  /** Conference call start, wall-clock in `call_timezone`. */
  call_time: HmSchema.default('09:00'),
  call_timezone: TimeZoneSchema.default('America/New_York'),
  /**
   * The scorecard P1 is pushed within 5 minutes of the release (spec section 11). If it is not ready after this
   * many seconds the generic 8-K P1 goes out with the lead line `Guide: unknown - read the 8-K`.
   */
  push_deadline_seconds: PosInt.default(240),
  /** Hard bound on the Opus extraction call (a hang is not a failure; this makes it one). */
  extraction_timeout_seconds: PosInt.default(150),
  /**
   * Guidance comparison tolerance, percent of the prior range's midpoint: changes smaller than this are "held"
   * (a restated range that moves 0.1% is not a raise).
   */
  guidance_epsilon_pct: z.number().nonnegative().default(0.5),
  /** A press release published within this many hours of a claimed 2.02 8-K folds into the scorecard push. */
  fold_press_release_hours: z.number().positive().default(6),
  /** Day-before consensus; null until the owner fills it in (never invent numbers). Revenue in USD millions. */
  consensus: z
    .strictObject({
      revenue: z.number().nullable().default(null),
      eps: z.number().nullable().default(null),
    })
    .prefault({}),
  /** Optional seed for the guidance comparator when the DB has no history yet. */
  prior_guidance: z.array(GuidanceRangeSchema).default([]),
});

export type EarningsConfig = z.output<typeof EarningsSchema>;

export const FeedSchema = z.strictObject({
  id: z.string().min(1),
  url: z.url(),
  title: z.string().optional(),
  /** Company IR / press-release feed (primary source). */
  primary: z.boolean().default(false),
  /** Disabled feeds are skipped (use for TODO placeholders). */
  enabled: z.boolean().default(true),
  note: z.string().optional(),
});

export type FeedConfig = z.output<typeof FeedSchema>;

export const NewsSchema = z.strictObject({
  /** Company IR / newswire feeds (primary text source, decision D28). */
  ir_feeds: z.array(FeedSchema).default([]),
  /** Other RSS/Atom feeds. */
  extra_feeds: z.array(FeedSchema).default([]),
  /** Google News RSS search query (secondary source). null = disabled. Host `news.google.com` must be allowed. */
  google_news_query: z.string().nullable().default(null),
  google_news: z
    .strictObject({
      hl: z.string().default('en-US'),
      gl: z.string().default('US'),
      ceid: z.string().default('US:en'),
    })
    .prefault({}),
  /** Cheap deterministic flags that upgrade a press release to P1 (guidance/dividend). Case-insensitive. */
  guidance_keywords: z
    .array(z.string())
    .default([
      'guidance',
      'outlook',
      'raises',
      'raised',
      'lowers',
      'lowered',
      'reaffirm',
      'withdraws',
    ]),
  dividend_keywords: z
    .array(z.string())
    .default(['dividend', 'repurchase', 'buyback', 'share repurchase']),
  /** Semantic near-duplicate window (decision D28). */
  dedupe: z
    .strictObject({
      window_hours: z.number().positive().default(48),
      jaccard_threshold: z.number().min(0).max(1).default(0.6),
    })
    .prefault({}),
});

export type NewsConfig = z.output<typeof NewsSchema>;

export const InstitutionSchema = z.strictObject({
  name: z.string().min(1),
  cik: CikSchema,
});

export const TickerSchema = z.strictObject({
  symbol: SymbolSchema,
  name: z.string().min(1),
  cik: CikSchema,
  exchange: z.string().min(1),
  /** Alternative names used to match newsletters / news text (e.g. `Build-A-Bear`). */
  aliases: z.array(z.string().min(1)).default([]),
  thresholds: ThresholdsSchema.prefault({}),
  /** Relative-performance benchmarks; falls back to the top-level `benchmarks`. */
  benchmarks: z.array(SymbolSchema).optional(),
  /** Override of individual polling cadences for this ticker (only the keys written are replaced). */
  polling: PollingOverrideSchema.optional(),
  earnings: EarningsSchema.nullable().default(null),
  news: NewsSchema.prefault({}),
  /** Optional 13F watch-list: institutions whose holdings of this name are diffed (decision D11). */
  institutions: z.array(InstitutionSchema).default([]),
});

export type TickerConfig = z.output<typeof TickerSchema>;

/** A ticker with inherited defaults applied (benchmarks + full polling). */
export interface ResolvedTickerConfig extends Omit<TickerConfig, 'benchmarks' | 'polling'> {
  benchmarks: string[];
  polling: Polling;
}

// ---------------------------------------------------------------------------------------------
// Schedules (America/Chicago, spec section 4)
// ---------------------------------------------------------------------------------------------

const entry = (cron: string, enabled = true) =>
  z
    .strictObject({ cron: CronSchema.default(cron), enabled: z.boolean().default(enabled) })
    .prefault({});

/**
 * Scout's materialization jobs run ~5 minutes BEFORE the matching OpenClaw crons (Mayer fetches at 06:45, 11:30,
 * 15:15 and Sat 08:00, docs/OPENCLAW_SETUP.md): the job builds the payload, stores it under kv `brief:` and
 * marks its events digested; `/brief/<type>` serves the stored snapshot, so Mayer never races an empty,
 * already-drained payload.
 */
export const SchedulesSchema = z.strictObject({
  /** IANA zone the cron expressions are evaluated in. */
  timezone: TimeZoneSchema.default('America/Chicago'),
  /** 06:40 Mon-Fri: materialize the pre-market payload (and push a finished brief if briefs.writer = scout). */
  premarket: entry('40 6 * * 1-5'),
  /** 08:35 Mon-Fri: open snapshot, push only if a rule fires. */
  open_snapshot: entry('35 8 * * 1-5'),
  /** 11:25 Mon-Fri: materialize the midday digest of P2 events (skipped when empty). */
  midday: entry('25 11 * * 1-5'),
  /** 15:10 Mon-Fri: close recap. On early-close days (13:00 ET) the scheduler runs `close_early` instead. */
  close: entry('10 15 * * 1-5'),
  /** Close recap on NYSE early-close days (12:00 CT close): 15 minutes after the early close, replacing `close`. */
  close_early: entry('10 12 * * 1-5'),
  /** Sat 07:50: weekly thesis review (Mayer's Opus cron fetches at 08:00). */
  weekly: entry('50 7 * * 6'),
  /** Health evaluation + alerts with cooldown (decision D31). */
  health: entry('*/15 * * * *'),
  /** Nightly retention prune. */
  retention: entry('30 3 * * *'),
  /** Nightly online SQLite backup. */
  backup: entry('0 3 * * *'),
  /** Hourly Schwab refresh-token expiry check (T-24h / T-6h / expired reminders, decision D12). */
  token_check: entry('7 * * * *'),
  /** Evening refresh of daily bars + ATR (after the close: today's bar is persisted only once complete). */
  daily_bars: entry('30 16 * * 1-5'),
  /** Every minute: earnings preload (05:00 CT) and post-call summary (10:30 CT); idempotent via kv `earnings:`. */
  earnings_tick: entry('* * * * *'),
  /** Every minute: persist latest quotes (benchmarks/futures) to kv `quote:`; 60 s in RTH, every 15 min otherwise. */
  quotes_snapshot: entry('* * * * *'),
  /** Friday evening: re-learn the intraday volume profile from minute bars. */
  profile: entry('0 18 * * 5'),
});

export type Schedules = z.output<typeof SchedulesSchema>;

// ---------------------------------------------------------------------------------------------
// Notify / alert budget (spec section 6, decisions D15-D17)
// ---------------------------------------------------------------------------------------------

export const OpenclawSchema = z.strictObject({
  enabled: z.boolean().default(true),
  /**
   * Mapped-hook URL. 127.0.0.1 is WRONG from inside Scout's container (decision D16); the default reaches
   * the host via `host.docker.internal`. `OPENCLAW_HOOK_URL` in the secrets file overrides this value.
   */
  url: z.url().default('http://host.docker.internal:18789/hooks/scout'),
  /** `compose`: Mayer writes the so-what; `relay`: Scout's finished text is relayed verbatim (D17). */
  mode: z.enum(['compose', 'relay']).default('compose'),
  /** Per-hook model override reference (cheap model). null = use the mapping's configured model. */
  model: z.string().nullable().default(null),
  channel: z.string().default('telegram'),
  /** Telegram chat id for direct `/hooks/agent` delivery (needs BOTH channel and `to`). */
  to: z.string().nullable().default(null),
  /** ONLY the `name` field of `/hooks/agent` calls. The mapped-hook PATH always comes from `url`. */
  hook_name: z.string().default('scout'),
  /** Direct agent hook URL for earnings-day scorecards. null = derive `<origin>/hooks/agent` from `url`. */
  agent_url: z.url().nullable().default(null),
  /** Opus-class model override for the earnings `/hooks/agent` call (when the gateway supports it). */
  earnings_model: z.string().nullable().default(null),
  timeout_seconds: z.number().positive().default(15),
});

export const NtfySchema = z.strictObject({
  enabled: z.boolean().default(true),
  /** Server base URL; Scout publishes JSON to it (the topic is in the body, never in the URL). `NTFY_URL` in the secrets file overrides. */
  url: z.url().default('https://ntfy.sh'),
  /** Topic (a credential on a public server). `NTFY_TOPIC` in the secrets file overrides; null = fallback channel unconfigured. */
  topic: z.string().nullable().default(null),
});

export const NotifySchema = z.strictObject({
  openclaw: OpenclawSchema.prefault({}),
  ntfy: NtfySchema.prefault({}),
  quiet_hours: z
    .strictObject({
      start: HmSchema.default('21:00'),
      end: HmSchema.default('06:30'),
      timezone: TimeZoneSchema.default('America/Chicago'),
      /** Alerts that bypass quiet hours (spec section 6). Quiet hours are evaluated at DECISION time (`input.now`), not at `Event.ts`. */
      exceptions: z.array(z.enum(['8k_item_2_02', 'halt'])).default(['8k_item_2_02', 'halt']),
    })
    .refine((q) => q.start !== q.end, {
      message:
        'quiet_hours start must differ from end (equal times would silently mean "never quiet")',
      path: ['end'],
    })
    .prefault({}),
  /** P1 hard cap per owner-local day before further P1s fold into ONE "multiple P1s" summary. */
  p1_cap: PosInt.default(6),
  /**
   * P1 pushes that do NOT count toward `p1_cap` (tracked in their own counters): the earnings scorecard / 8-K
   * Item 2.02 push and halts. Ops alerts are not events and never count. Remove `halt` to cap halts too.
   */
  p1_cap_exempt: z.array(z.enum(['8k_item_2_02', 'halt'])).default(['8k_item_2_02', 'halt']),
  /** A second halt for the same ticker within this many minutes folds into the first halt's push (relation `duplicate`). */
  halt_fold_minutes: z.number().positive().default(10),
  /** 3+ P2s within 30 minutes cluster into one push. */
  p2_cluster: z
    .strictObject({
      count: z.number().int().min(2).default(3),
      window_minutes: z.number().positive().default(30),
    })
    .prefault({}),
  /** Outbox retry policy. */
  outbox: z
    .strictObject({
      max_attempts: PosInt.default(8),
      retry_base_seconds: z.number().positive().default(30),
      retry_max_seconds: z.number().positive().default(900),
      /** A flush leases the rows it sends for this long, so overlapping flushes never double-send. */
      lease_seconds: z.number().positive().default(120),
    })
    .prefault({}),
});

export type NotifyConfig = z.output<typeof NotifySchema>;

export const BriefsSchema = z.strictObject({
  /** Who writes the prose: `mayer` (OpenClaw cron fetches `/brief/<type>`) or `scout` (Sonnet in-process). */
  writer: z.enum(['mayer', 'scout']).default('mayer'),
  /** When the OpenClaw path is down, deliver finished text via ntfy (decision D21). */
  fallback_when_gateway_down: z.boolean().default(true),
  /**
   * Futures shown in the pre-market brief. UNVERIFIED: whether Schwab's market-data API quotes futures
   * symbology such as `/ES` is not confirmed (listed in docs/VERIFY_LIVE.md); a symbol that cannot be quoted is
   * reported as missing in `dataQuality`.
   */
  futures_symbols: z.array(z.string().min(1)).default(['/ES']),
  /** Fallback proxies quoted pre-market when no futures symbol can be quoted (SPY/IWM). */
  futures_fallback_symbols: z.array(SymbolSchema).default(['SPY', 'IWM']),
});

/**
 * Event pipeline policy (B1). Decision F17: a rules-assigned P1 is never held back by the LLM.
 */
export const PipelineSchema = z.strictObject({
  /**
   * A rules-P1 event (and every halt and 2.02 event) whose triage has not produced a verdict this many seconds
   * after it was ingested proceeds to the budget as triage `skipped` (reason `deadline`): Haiku only adds the
   * so-what, so an Anthropic outage must not delay a push the rules already decided.
   */
  triage_deadline_seconds: PosInt.default(20),
  /** Triage attempts before a NON-P1 event is dropped as `unprocessable` (a P1 never is). */
  triage_max_attempts: PosInt.default(5),
  /** Retry backoff for a failed triage: `base * 2^(attempts-1)`, capped (derived from `attempts` + `updated_at`). */
  retry_base_seconds: z.number().positive().default(30),
  retry_max_seconds: z.number().positive().default(900),
  /**
   * An event whose `ts` is older than this at ingest (non-baseline catch-up after an outage) is stored as
   * `dropped`/`stale` and never pushed; it still appears in briefs and `/events`.
   */
  max_event_age_hours: z.number().positive().default(48),
});

export type PipelineConfig = z.output<typeof PipelineSchema>;

// ---------------------------------------------------------------------------------------------
// LLM (spec section 7, decision D20). Prices are per MILLION tokens, USD, and live HERE, not at call sites.
// ---------------------------------------------------------------------------------------------

export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.output<typeof EffortSchema>;

export const PriceTableSchema = z.strictObject({
  input_per_mtok: z.number().nonnegative(),
  output_per_mtok: z.number().nonnegative(),
  cache_read_per_mtok: z.number().nonnegative(),
  /** Cache-write price as a multiple of input price, 5-minute TTL (1.25x). */
  cache_write_multiplier: z.number().positive().default(1.25),
  /** Cache-write multiple for the 1-hour TTL (2x). */
  cache_write_1h_multiplier: z.number().positive().default(2),
  /** Batch API price as a fraction of standard (0.5 = 50% discount). */
  batch_discount: z.number().min(0).max(1).default(0.5),
  /** Higher rates when the prompt exceeds `threshold_tokens` (Haiku 5.5: >100K prompt tokens). */
  long_context: z
    .strictObject({
      threshold_tokens: z.number().int().positive(),
      input_per_mtok: z.number().nonnegative(),
      output_per_mtok: z.number().nonnegative(),
      cache_read_per_mtok: z.number().nonnegative().optional(),
    })
    .nullable()
    .default(null),
});

export type PriceTable = z.output<typeof PriceTableSchema>;

export const ModelSchema = z.strictObject({
  /** Exact model id sent to the API. */
  id: z.string().min(1),
  effort: EffortSchema,
  max_tokens: z.number().int().positive(),
  price: PriceTableSchema,
  /** True when the model supports the server-side refusal `fallbacks` parameter (Sonnet/Opus 5.5; not Haiku). */
  server_fallbacks: z.boolean().default(false),
});

export type ModelConfig = z.output<typeof ModelSchema>;

/**
 * Defaults per decision D20 (claude-api skill facts cached 2026-11-03):
 * Haiku 5.5 $0.10/$0.50 (prompts <= 100K; $0.50/$2.50 beyond); Sonnet 5.5 $2/$10, cache read $0.10;
 * Opus 5.5 $4/$20, cache read $0.20; cache writes 1.25x (5m) / 2x (1h); batch 50%.
 * UNVERIFIED: Haiku 5.5 cache-read price is not stated explicitly; 0.1x input ($0.01) is assumed from
 * "cache reads ~0.1x base input". Verify on the first live call via `llm_calls` rows.
 */
export function defaultLlmModels(): { triage: ModelConfig; synth: ModelConfig; deep: ModelConfig } {
  return {
    triage: {
      id: 'claude-haiku-5-5',
      effort: 'low',
      max_tokens: 1024,
      server_fallbacks: false,
      price: {
        input_per_mtok: 0.1,
        output_per_mtok: 0.5,
        cache_read_per_mtok: 0.01,
        cache_write_multiplier: 1.25,
        cache_write_1h_multiplier: 2,
        batch_discount: 0.5,
        long_context: {
          threshold_tokens: 100_000,
          input_per_mtok: 0.5,
          output_per_mtok: 2.5,
          cache_read_per_mtok: 0.05,
        },
      },
    },
    synth: {
      id: 'claude-sonnet-5-5',
      effort: 'medium',
      max_tokens: 4096,
      server_fallbacks: true,
      price: {
        input_per_mtok: 2,
        output_per_mtok: 10,
        cache_read_per_mtok: 0.1,
        cache_write_multiplier: 1.25,
        cache_write_1h_multiplier: 2,
        batch_discount: 0.5,
        long_context: null,
      },
    },
    deep: {
      id: 'claude-opus-5-5',
      effort: 'high',
      max_tokens: 16_000,
      server_fallbacks: true,
      price: {
        input_per_mtok: 4,
        output_per_mtok: 20,
        cache_read_per_mtok: 0.2,
        cache_write_multiplier: 1.25,
        cache_write_1h_multiplier: 2,
        batch_discount: 0.5,
        long_context: null,
      },
    },
  };
}

const LongContextSchema = z.strictObject({
  threshold_tokens: PosInt,
  input_per_mtok: z.number().nonnegative(),
  output_per_mtok: z.number().nonnegative(),
  cache_read_per_mtok: z.number().nonnegative().optional(),
});

/** A price table whose every field defaults to the tier's default, so a partial override is accepted. */
function priceTableSchemaFor(d: PriceTable) {
  return z
    .strictObject({
      input_per_mtok: z.number().nonnegative().default(d.input_per_mtok),
      output_per_mtok: z.number().nonnegative().default(d.output_per_mtok),
      cache_read_per_mtok: z.number().nonnegative().default(d.cache_read_per_mtok),
      cache_write_multiplier: z.number().positive().default(d.cache_write_multiplier),
      cache_write_1h_multiplier: z.number().positive().default(d.cache_write_1h_multiplier),
      batch_discount: z.number().min(0).max(1).default(d.batch_discount),
      long_context: LongContextSchema.nullable().default(d.long_context),
    })
    .prefault({});
}

/**
 * A model tier whose fields default to that tier's default: changing only the synth model id (or one price)
 * no longer forces copying all three price tables.
 */
function modelSchemaFor(d: ModelConfig) {
  return z
    .strictObject({
      id: z.string().min(1).default(d.id),
      effort: EffortSchema.default(d.effort),
      max_tokens: PosInt.default(d.max_tokens),
      price: priceTableSchemaFor(d.price),
      server_fallbacks: z.boolean().default(d.server_fallbacks),
    })
    .prefault({});
}

const LLM_DEFAULTS = defaultLlmModels();

export const LlmSchema = z.strictObject({
  /** Master switch. Also off at runtime when no ANTHROPIC_API_KEY is set (rules-only mode). */
  enabled: z.boolean().default(true),
  models: z
    .strictObject({
      triage: modelSchemaFor(LLM_DEFAULTS.triage),
      synth: modelSchemaFor(LLM_DEFAULTS.synth),
      deep: modelSchemaFor(LLM_DEFAULTS.deep),
    })
    .prefault({}),
  /** Server-side refusal fallbacks for Sonnet/Opus (beta `server-side-fallback-2026-07-01`). Default ON. */
  fallbacks: z.boolean().default(true),
  /** Prompt-cache TTL for the stable per-ticker prefix. */
  cache_ttl: z.enum(['5m', '1h']).default('5m'),
  spend_cap_usd_daily: z.number().positive().default(5),
  spend_cap_usd_monthly: z.number().positive().default(50),
  /** At the cap: `downgrade` (use the cheaper tier, then stop) or `stop` (rules-only). */
  spend_cap_action: z.enum(['downgrade', 'stop']).default('downgrade'),
  /** Use the Batch API for the weekly review and backfills. */
  use_batch_for_weekly: z.boolean().default(true),
  batch_max_wait_minutes: z.number().positive().default(120),
});

export type LlmConfig = z.output<typeof LlmSchema>;

// ---------------------------------------------------------------------------------------------
// API, egress, retention, storage, health, integrations
// ---------------------------------------------------------------------------------------------

export const ApiSchema = z.strictObject({
  port: z.number().int().min(1).max(65535).default(3817),
  /**
   * Bind address. `127.0.0.1` for local dev; the packaged container sets `0.0.0.0` so Umbrel's app proxy and
   * Mayer (same Docker network) can reach it. Never expose via Tailscale Funnel (decision D19).
   */
  bind: z.string().default('127.0.0.1'),
});

export const EgressSchema = z.strictObject({
  /** EVERY host Scout may contact (decision D8). Anything else throws before connecting. */
  allowed_hosts: z.array(HostnameSchema).min(1),
  /** Hosts additionally reachable over plain http/ws (private-network gateway / LAN ntfy only). */
  http_allowed_hosts: z.array(HostnameSchema).default([]),
  /** Dot-prefixed suffixes allowed for WebSocket hosts only (Schwab streamer URL is learned at runtime). */
  ws_allowed_host_suffixes: z
    .array(z.string().startsWith('.'))
    .default(['.schwab.com', '.schwabapi.com']),
  /**
   * Per-host (or rate-group, e.g. `sec`) request-per-second overrides merged over the built-in defaults
   * (`DEFAULT_RATES` in core/http.ts: sec 5, api.schwabapi.com 2, ...). Tune here, not in code.
   */
  rates: z.record(z.string().min(1), z.number().positive()).default({}),
});

export const RetentionSchema = z.strictObject({
  /** Raw payload JSON (events.payload_json, filings raw, option chains) pruned after this many days. */
  raw_payload_days: z.number().int().positive().default(90),
  /** Job run history. */
  job_runs_days: z.number().int().positive().default(90),
  /** Raw intraday bars. */
  intraday_bars_days: z.number().int().positive().default(90),
});

export const StorageSchema = z.strictObject({
  data_dir: z.string().min(1).default('/data'),
  db_file: z.string().min(1).default('scout.db'),
  /** Closed-allowlist secrets env file (mode 0600), relative to data_dir unless absolute. */
  secrets_file: z.string().min(1).default('secrets/scout.env'),
  /** Owner-private position plan (never committed), relative to data_dir unless absolute. */
  plan_file: z.string().min(1).default('position_plan.yaml'),
  /**
   * Directory holding the thesis markdown files, relative to data_dir unless absolute. The plan's
   * `thesis_file` is resolved relative to THIS directory (never the plan file's), may not be absolute, contain
   * `..`, or escape through a symlink (see `resolveThesisPath`).
   */
  thesis_dir: z.string().min(1).default('thesis'),
  backups_dir: z.string().min(1).default('backups'),
  backup_keep: z.number().int().positive().default(7),
});

export const HealthSchema = z.strictObject({
  /** An adapter is "stale" after `adapter_stale_factor` x its poll interval without success. */
  adapter_stale_factor: z.number().positive().default(5),
  /** Quote stream is "down" when no tick for this long during RTH. */
  quote_stale_seconds: z.number().positive().default(180),
  /** Re-alert a persisting failure at most this often. */
  alert_cooldown_hours: z.number().positive().default(6),
  /** Send a recovery notice when a component returns to ok (decision D31). */
  send_recovery: z.boolean().default(true),
});

/**
 * There is deliberately NO `reminder_hours` key: the token reminders are FIXED at T-24h, T-6h and expiry
 * (decision D12) because `token_state` tracks exactly those three flags.
 */
export const SchwabSchema = z.strictObject({
  /** Off until the owner has registered an app and run `scout schwab-auth`. */
  enabled: z.boolean().default(true),
  base_url: z.url().default('https://api.schwabapi.com'),
  options_chain: z
    .strictObject({
      strike_count: PosInt.default(20),
      max_days_to_expiration: PosInt.default(60),
    })
    .prefault({}),
  stream: z
    .strictObject({
      enabled: z.boolean().default(true),
      /** No new trade for this many minutes in RTH (with bid/ask present) => low-confidence "possible pause". */
      stale_trade_minutes: z.number().positive().default(5),
      /**
       * Priority of a `possible_pause` (stale-trade heuristic, low confidence). An explicit exchange/vendor
       * `halted` is always P1; a heuristic is not.
       */
      stale_trade_priority: PriorityEnum.default('P2'),
    })
    .prefault({}),
});

export const EdgarSchema = z.strictObject({
  data_base_url: z.url().default('https://data.sec.gov'),
  archive_base_url: z.url().default('https://www.sec.gov'),
  /** Recent filings pulled on first run / backfill. */
  backfill_count: z.number().int().positive().default(40),
  form4_enabled: z.boolean().default(true),
  schedule13_enabled: z.boolean().default(true),
  /** 13F tracking is optional and low priority (decision D11). */
  f13_enabled: z.boolean().default(false),
});

export const FinraSchema = z.strictObject({
  short_interest: z
    .strictObject({
      enabled: z.boolean().default(true),
      /** `query_api` needs FINRA_CLIENT_ID/SECRET; `public_file` uses the URL template (UNVERIFIED, D25). */
      source: z.enum(['query_api', 'public_file']).default('public_file'),
      /** `{YYYYMMDD}` is replaced with the settlement date. UNVERIFIED. */
      public_file_url_template: z
        .string()
        .default('https://cdn.finra.org/equity/otcmarket/biweekly/shrt{YYYYMMDD}.csv'),
      /** UNVERIFIED dataset naming (decision D25). */
      dataset_group: z.string().default('otcMarket'),
      dataset_name: z.string().default('consolidatedShortInterest'),
      /** Expected publication lag after settlement, in business days (~7). Cadence is config-driven. */
      publish_lag_business_days: z.number().int().positive().default(7),
      /** Days between settlement dates (bi-monthly ~15; FINRA proposed weekly reporting, status uncertain). */
      cadence_days: z.number().int().positive().default(15),
    })
    .prefault({}),
  reg_sho: z
    .strictObject({
      enabled: z.boolean().default(true),
      /** `{YYYYMMDD}` replaced with the trade date. Off-exchange/TRF volume only (context, never alerts). */
      url_template: z
        .string()
        .default('https://cdn.finra.org/equity/regsho/daily/CNMSshvol{YYYYMMDD}.txt'),
    })
    .prefault({}),
});

export const FredSeriesSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  enabled: z.boolean().default(true),
  note: z.string().optional(),
});

export const FredSchema = z.strictObject({
  enabled: z.boolean().default(true),
  base_url: z.url().default('https://api.stlouisfed.org/fred'),
  series: z.array(FredSeriesSchema).default([]),
});

export const HaltsSchema = z.strictObject({
  nasdaq_trader: z
    .strictObject({
      enabled: z.boolean().default(true),
      /** UNVERIFIED feed URL/format (decision D14). */
      url: z.url().default('https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts'),
    })
    .prefault({}),
});

export const InboxSchema = z.strictObject({
  /** Newsletter intake via IMAP. Default OFF; IMAP creds come from the secrets file (decision D27). */
  enabled: z.boolean().default(false),
  mailbox: z.string().default('INBOX'),
  max_messages_per_run: z.number().int().positive().default(50),
});

// ---------------------------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------------------------

const ROOT_FIELDS = {
  /** Schema version of this file (bump on breaking changes). */
  version: z.literal(1).default(1),
  tickers: z.array(TickerSchema).min(1),
  /** Default relative-performance benchmarks (spec: IWM, XRT). */
  benchmarks: z.array(SymbolSchema).default(['IWM', 'XRT']),
  /** Default polling cadence; tickers may override pieces. */
  polling: PollingSchema.prefault({}),
  schedules: SchedulesSchema.prefault({}),
  notify: NotifySchema.prefault({}),
  pipeline: PipelineSchema.prefault({}),
  briefs: BriefsSchema.prefault({}),
  llm: LlmSchema.prefault({}),
  api: ApiSchema.prefault({}),
  egress: EgressSchema,
  retention: RetentionSchema.prefault({}),
  storage: StorageSchema.prefault({}),
  health: HealthSchema.prefault({}),
  schwab: SchwabSchema.prefault({}),
  edgar: EdgarSchema.prefault({}),
  finra: FinraSchema.prefault({}),
  fred: FredSchema.prefault({}),
  halts: HaltsSchema.prefault({}),
  inbox: InboxSchema.prefault({}),
};

/** Hosts of the FINRA Query API and its OAuth token endpoint (decision D25; UNVERIFIED but fixed in code). */
export const FINRA_QUERY_HOST = 'api.finra.org';
export const FINRA_AUTH_HOST = 'ews.fip.finra.org';
/** Host the Anthropic SDK talks to. */
export const ANTHROPIC_HOST = 'api.anthropic.com';

export const CoverageSchema = z.strictObject(ROOT_FIELDS).superRefine((cfg, ctx) => {
  const seen = new Set<string>();
  for (const [i, t] of cfg.tickers.entries()) {
    if (seen.has(t.symbol)) {
      ctx.addIssue({
        code: 'custom',
        path: ['tickers', i, 'symbol'],
        message: `duplicate ticker ${t.symbol}`,
      });
    }
    seen.add(t.symbol);
  }
  const allowed = new Set(cfg.egress.allowed_hosts);
  const plainOk = new Set(cfg.egress.http_allowed_hosts);
  for (const [i, h] of cfg.egress.http_allowed_hosts.entries()) {
    if (!allowed.has(h)) {
      ctx.addIssue({
        code: 'custom',
        path: ['egress', 'http_allowed_hosts', i],
        message: `http_allowed_hosts entry "${h}" must also be listed in egress.allowed_hosts`,
      });
    }
  }
  /** Every host Scout will call must be NAMED in `egress.allowed_hosts` (decision D8), and plain http only for http_allowed_hosts. */
  const needUrl = (url: string, path: (string | number)[], what: string): void => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return; // the field's own `z.url()` reports malformed URLs
    }
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (!allowed.has(host)) {
      ctx.addIssue({
        code: 'custom',
        path,
        message: `${what} host "${host}" is not in egress.allowed_hosts (add it explicitly; decision D8)`,
      });
    }
    if (u.protocol === 'http:' && !plainOk.has(host)) {
      ctx.addIssue({
        code: 'custom',
        path,
        message: `${what} uses plain http for host "${host}", which must be listed in egress.http_allowed_hosts`,
      });
    }
  };
  const needHost = (host: string, path: (string | number)[], what: string): void => {
    if (!allowed.has(host)) {
      ctx.addIssue({
        code: 'custom',
        path,
        message: `${what} host "${host}" is not in egress.allowed_hosts (add it explicitly; decision D8)`,
      });
    }
  };
  for (const [i, t] of cfg.tickers.entries()) {
    for (const [j, f] of [...t.news.ir_feeds, ...t.news.extra_feeds].entries()) {
      if (f.enabled) needUrl(f.url, ['tickers', i, 'news', 'feeds', j, 'url'], `feed "${f.id}"`);
    }
    if (t.news.google_news_query !== null) {
      needHost('news.google.com', ['tickers', i, 'news', 'google_news_query'], 'Google News');
    }
  }
  if (cfg.notify.openclaw.enabled) {
    needUrl(cfg.notify.openclaw.url, ['notify', 'openclaw', 'url'], 'OpenClaw hook');
    if (cfg.notify.openclaw.agent_url !== null)
      needUrl(cfg.notify.openclaw.agent_url, ['notify', 'openclaw', 'agent_url'], 'OpenClaw agent');
  }
  // ntfy is the FALLBACK channel: a typo here would only surface during the outage it exists for.
  if (cfg.notify.ntfy.enabled) needUrl(cfg.notify.ntfy.url, ['notify', 'ntfy', 'url'], 'ntfy');
  if (cfg.schwab.enabled) needUrl(cfg.schwab.base_url, ['schwab', 'base_url'], 'Schwab');
  needUrl(cfg.edgar.data_base_url, ['edgar', 'data_base_url'], 'EDGAR data');
  needUrl(cfg.edgar.archive_base_url, ['edgar', 'archive_base_url'], 'EDGAR archive');
  if (cfg.finra.short_interest.enabled) {
    if (cfg.finra.short_interest.source === 'public_file')
      needUrl(
        cfg.finra.short_interest.public_file_url_template,
        ['finra', 'short_interest', 'public_file_url_template'],
        'FINRA short-interest file',
      );
    else {
      needHost(FINRA_QUERY_HOST, ['finra', 'short_interest', 'source'], 'FINRA Query API');
      needHost(FINRA_AUTH_HOST, ['finra', 'short_interest', 'source'], 'FINRA OAuth');
    }
  }
  if (cfg.finra.reg_sho.enabled)
    needUrl(cfg.finra.reg_sho.url_template, ['finra', 'reg_sho', 'url_template'], 'Reg SHO file');
  if (cfg.halts.nasdaq_trader.enabled)
    needUrl(cfg.halts.nasdaq_trader.url, ['halts', 'nasdaq_trader', 'url'], 'Nasdaq Trader');
  if (cfg.fred.enabled && cfg.fred.series.some((s) => s.enabled))
    needUrl(cfg.fred.base_url, ['fred', 'base_url'], 'FRED');
  if (cfg.llm.enabled) needHost(ANTHROPIC_HOST, ['llm', 'enabled'], 'Anthropic API');
});

/** The validated, defaulted coverage config handed to every module. */
export type CoverageConfig = z.output<typeof CoverageSchema>;
/** The shape a YAML author writes (defaults optional). */
export type CoverageConfigInput = z.input<typeof CoverageSchema>;

/** Alias used by `AdapterDeps.config`. */
export type ScoutConfig = CoverageConfig;

/**
 * Where long-lived components read the LIVE config from (`ConfigHolder.current`): `earnings.consensus`,
 * thresholds, notify policy and briefs settings are editable without a restart (decision F18), so components
 * that outlive a poll (the pipeline, the mode provider, the API) call this per use instead of caching the
 * object. `AdapterDeps.config` stays the construction-time object (egress, adapters, binds and storage need a
 * restart anyway); per-poll values reach an adapter fresh through `PollContext.tickerConfig`.
 */
export type ConfigSource = () => CoverageConfig;

/** Symbols in coverage order. */
export function tickerSymbols(config: CoverageConfig): string[] {
  return config.tickers.map((t) => t.symbol);
}

/**
 * Every symbol whose latest quote Scout keeps current: covered tickers, benchmarks and the configured futures
 * (UNVERIFIED availability) plus fallback proxies. The stream subscription set and the `quotes_snapshot` job both
 * use this list, so the pre-market/close/relative-performance numbers always have a persisted quote
 * (kv `quote:<SYMBOL>`).
 */
export function quoteSymbols(config: CoverageConfig): string[] {
  const out = new Set<string>();
  for (const t of config.tickers) {
    out.add(t.symbol);
    for (const b of t.benchmarks ?? config.benchmarks) out.add(b);
  }
  for (const s of config.briefs.futures_symbols) out.add(s.toUpperCase());
  for (const s of config.briefs.futures_fallback_symbols) out.add(s);
  return [...out];
}

/**
 * The ticker's config with inherited benchmarks and a fully-resolved polling block (global values overlaid by
 * ONLY the keys the ticker's override wrote). `undefined` when the symbol is not covered.
 */
export function resolveTicker(
  config: CoverageConfig,
  symbol: string,
): ResolvedTickerConfig | undefined {
  const t = config.tickers.find((x) => x.symbol === symbol.toUpperCase());
  if (t === undefined) return undefined;
  const { benchmarks, polling, ...rest } = t;
  const merged: Polling = { ...config.polling };
  for (const [k, v] of Object.entries(polling ?? {})) {
    if (v !== undefined) (merged as Record<string, number>)[k] = v as number;
  }
  return { ...rest, benchmarks: benchmarks ?? config.benchmarks, polling: merged };
}
