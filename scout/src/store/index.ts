/**
 * The Store facade: one object wiring every repository to one SQLite handle. Modules receive a `Store` (via
 * `AdapterDeps.store` / pipeline deps) and never touch SQL outside `src/store/`.
 *
 * Build one with `createStore(openAndMigrate(path))`; tests use `createMemoryStore()` or
 * `test-support/tempDb`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { StoreError } from '../core/errors.js';
import type { DomainRecord, Event } from '../types.js';
import { openDb, readTransaction, writeTransaction, type Db } from './db.js';
import { migrate, pendingMigrations } from './migrate.js';
import { EventLinksRepo, EventsRepo } from './repos/events.js';
import { Form4Repo, FilingsRepo, Holdings13fRepo, Schedule13Repo } from './repos/filings.js';
import { FactSheetsRepo, LlmCallsRepo } from './repos/llm.js';
import { IntradayRepo, LatestQuotesRepo, OptionsRepo, QuotesDailyRepo } from './repos/market.js';
import { OutboxRepo } from './repos/outbox.js';
import { GuidanceRepo, PlanSnapshotsRepo, PositionsRepo, ScorecardsRepo } from './repos/plan.js';
import {
  MacroRepo,
  NewsletterStateRepo,
  RegShoRepo,
  ShortInterestRepo,
} from './repos/shorts-macro.js';
import {
  AlertStateRepo,
  ApiTokensRepo,
  DailyCountersRepo,
  HealthRepo,
  JobRunsRepo,
  KvRepo,
  TokenStateRepo,
} from './repos/state.js';
import { WatermarksRepo } from './repos/watermarks.js';

export * from './db.js';
export * from './migrate.js';
export * from './retention.js';
export * from './repos/events.js';
export * from './repos/filings.js';
export * from './repos/llm.js';
export * from './repos/market.js';
export * from './repos/outbox.js';
export * from './repos/plan.js';
export * from './repos/shorts-macro.js';
export * from './repos/state.js';
export * from './repos/watermarks.js';

/** Arguments to {@link Store.commitPoll}. */
export interface CommitPollArgs {
  /** Watermark source key: the adapter id (e.g. `edgar.submissions`). */
  source: string;
  /** Watermark ticker (or `GLOBAL_TICKER`). */
  ticker: string;
  events: readonly Event[];
  records?: readonly DomainRecord[];
  /** New cursor to commit. `undefined`/`null` leaves the watermark unchanged (they mean the same thing). */
  cursor?: string | null | undefined;
  now: Date;
  /**
   * This poll was a BASELINE: a first run (no cursor), a watermark reset, a re-enabled adapter, or a backfill.
   * The upstream returns history (EDGAR the last 40 filings, RSS ~20 old items, FINRA every settlement): the
   * events are stored `dropped` with reason `baseline` (still queryable by briefs and the API, invariant I11)
   * and never reach rules, triage or a push. Without this, deploy day burns the 6-P1 cap on old 8-Ks.
   */
  baseline?: boolean;
  /**
   * Non-baseline catch-up guard: an event whose `ts` is older than this many ms at `now` (the first poll after
   * an outage) is stored `dropped` with reason `stale` instead of being pushed as if it were live.
   */
  maxEventAgeMs?: number;
}

export interface CommitPollResult {
  /** Events that were NEW (inserted with status `new`, i.e. queued for triage). */
  inserted: Event[];
  /** Events already present (re-poll of the same fact): ignored, lifecycle untouched. */
  duplicates: Event[];
  /** Newly stored as `dropped`/`baseline` (history; no rules, triage or push). */
  baselined: Event[];
  /** Newly stored as `dropped`/`stale` (older than `maxEventAgeMs`; no push). */
  stale: Event[];
  /** Whether the watermark was advanced. */
  watermarkAdvanced: boolean;
}

/** Write verbs: every method whose name starts with one is hidden from a {@link ReadOnlyRepo}. */
type WriteVerb =
  | 'upsert'
  | 'insert'
  | 'set'
  | 'save'
  | 'link'
  | 'mark'
  | 'record'
  | 'enqueue'
  | 'claim'
  | 'delete'
  | 'revoke'
  | 'create'
  | 'increment'
  | 'touch'
  | 'clear'
  | 'start'
  | 'finish'
  | 'snapshot'
  | 'fail'
  | 'prune'
  | 'put'
  | 'update'
  | 'replace'
  | 'persist'
  | 'commit';

/** A repository type with every write method removed (compile-time half of adapter purity). */
export type ReadOnlyRepo<T> = {
  readonly [K in keyof T as K extends `${WriteVerb}${string}` ? never : K]: T[K];
};

/**
 * What a POLL ADAPTER may touch: read-only views of the repos it consults (ADV for days-to-cover, prior records,
 * filings, quotes). Adapters never write events, watermarks or "seen" markers: the orchestrator does, in ONE
 * transaction (`commitPoll`, decision D10). `AdapterDeps.store` is this type, and a policy test fails if
 * `src/adapters/**` mentions a write API. Components that own other state (A2's `token_state`, the quote
 * tracker's `quote:` keys, A8's `llm_calls`) are constructed with the specific repo they own instead.
 */
export interface ReadStore {
  readonly events: ReadOnlyRepo<EventsRepo>;
  readonly eventLinks: ReadOnlyRepo<EventLinksRepo>;
  readonly watermarks: ReadOnlyRepo<WatermarksRepo>;
  readonly filings: ReadOnlyRepo<FilingsRepo>;
  readonly form4: ReadOnlyRepo<Form4Repo>;
  readonly schedule13: ReadOnlyRepo<Schedule13Repo>;
  readonly holdings13f: ReadOnlyRepo<Holdings13fRepo>;
  readonly quotes: ReadOnlyRepo<QuotesDailyRepo>;
  readonly intraday: ReadOnlyRepo<IntradayRepo>;
  readonly options: ReadOnlyRepo<OptionsRepo>;
  readonly latestQuotes: ReadOnlyRepo<LatestQuotesRepo>;
  readonly shortInterest: ReadOnlyRepo<ShortInterestRepo>;
  readonly regSho: ReadOnlyRepo<RegShoRepo>;
  readonly macro: ReadOnlyRepo<MacroRepo>;
  readonly guidance: ReadOnlyRepo<GuidanceRepo>;
  readonly scorecards: ReadOnlyRepo<ScorecardsRepo>;
  readonly positions: ReadOnlyRepo<PositionsRepo>;
  readonly planSnapshots: ReadOnlyRepo<PlanSnapshotsRepo>;
}

export class Store {
  readonly events: EventsRepo;
  readonly eventLinks: EventLinksRepo;
  readonly outbox: OutboxRepo;
  readonly watermarks: WatermarksRepo;
  readonly filings: FilingsRepo;
  readonly form4: Form4Repo;
  readonly schedule13: Schedule13Repo;
  readonly holdings13f: Holdings13fRepo;
  readonly quotes: QuotesDailyRepo;
  readonly intraday: IntradayRepo;
  readonly options: OptionsRepo;
  readonly latestQuotes: LatestQuotesRepo;
  readonly shortInterest: ShortInterestRepo;
  readonly regSho: RegShoRepo;
  readonly macro: MacroRepo;
  readonly newsletter: NewsletterStateRepo;
  readonly llmCalls: LlmCallsRepo;
  readonly factSheets: FactSheetsRepo;
  readonly planSnapshots: PlanSnapshotsRepo;
  readonly positions: PositionsRepo;
  readonly scorecards: ScorecardsRepo;
  readonly guidance: GuidanceRepo;
  readonly tokenState: TokenStateRepo;
  readonly health: HealthRepo;
  readonly alertState: AlertStateRepo;
  readonly apiTokens: ApiTokensRepo;
  readonly jobRuns: JobRunsRepo;
  readonly counters: DailyCountersRepo;
  readonly kv: KvRepo;

  constructor(readonly db: Db) {
    this.events = new EventsRepo(db);
    this.eventLinks = new EventLinksRepo(db);
    this.outbox = new OutboxRepo(db);
    this.watermarks = new WatermarksRepo(db);
    this.filings = new FilingsRepo(db);
    this.form4 = new Form4Repo(db);
    this.schedule13 = new Schedule13Repo(db);
    this.holdings13f = new Holdings13fRepo(db);
    this.quotes = new QuotesDailyRepo(db);
    this.intraday = new IntradayRepo(db);
    this.options = new OptionsRepo(db);
    this.latestQuotes = new LatestQuotesRepo(db);
    this.shortInterest = new ShortInterestRepo(db);
    this.regSho = new RegShoRepo(db);
    this.macro = new MacroRepo(db);
    this.newsletter = new NewsletterStateRepo(db);
    this.llmCalls = new LlmCallsRepo(db);
    this.factSheets = new FactSheetsRepo(db);
    this.planSnapshots = new PlanSnapshotsRepo(db);
    this.positions = new PositionsRepo(db);
    this.scorecards = new ScorecardsRepo(db);
    this.guidance = new GuidanceRepo(db);
    this.tokenState = new TokenStateRepo(db);
    this.health = new HealthRepo(db);
    this.alertState = new AlertStateRepo(db);
    this.apiTokens = new ApiTokensRepo(db);
    this.jobRuns = new JobRunsRepo(db);
    this.counters = new DailyCountersRepo(db);
    this.kv = new KvRepo(db);
  }

  /** Run `fn` atomically with the write lock taken up front. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    return this.db.inTransaction ? fn() : writeTransaction(this.db, fn);
  }

  /** This store seen through the read-only adapter contract ({@link ReadStore}). Same object; a typed view. */
  asReadStore(): ReadStore {
    return this;
  }

  /** Run `fn` against ONE consistent read snapshot (API requests). Do not write inside. */
  readTransaction<T>(fn: () => T): T {
    return this.db.inTransaction ? fn() : readTransaction(this.db, fn);
  }

  /** Persist domain records (idempotent upserts/ignores). Caller owns the transaction (or use commitPoll). */
  persistRecords(records: readonly DomainRecord[], now: Date): void {
    for (const r of records) {
      switch (r.type) {
        case 'filing':
          this.filings.upsert(r.record, now);
          break;
        case 'form4_row':
          this.form4.upsert(r.record, now);
          break;
        case 'schedule13':
          this.schedule13.upsert(r.record, now);
          break;
        case 'holding_13f':
          this.holdings13f.upsert(r.record, now);
          break;
        case 'daily_bar':
          this.quotes.upsert(r.record, now);
          break;
        case 'intraday_bar':
          this.intraday.upsertBar(r.record);
          break;
        case 'short_interest':
          this.shortInterest.upsert(r.record, now);
          break;
        case 'reg_sho':
          this.regSho.upsert(r.record, now);
          break;
        case 'options_snapshot':
          this.options.insertIgnore(r.record, now);
          break;
        case 'macro_observation':
          this.macro.upsert({ ...r.record }, now);
          break;
        default:
          assertNever(r);
      }
    }
  }

  /**
   * THE durable-ingest primitive (decision D10). In ONE transaction: insert the events (status `new`, i.e.
   * queued for triage; duplicates ignored), persist the domain records, THEN advance the watermark. Either all
   * of it commits or none (a crash can never advance the cursor past events that were not stored). Triage,
   * LLM and notify failures cannot undo this and cannot retire an event: unjudged events stay `new`.
   *
   * A MALFORMED event (bad source, zoneless `ts`, non-object payload, kind/source mismatch, ...) THROWS
   * `ValidationError` and rolls the whole commit back, cursor included: the poll fails loudly (health shows the
   * adapter down) rather than losing the event and advancing the cursor past it.
   *
   * `baseline` and `maxEventAgeMs` store catch-up history as `dropped` (see {@link CommitPollArgs}).
   */
  commitPoll(args: CommitPollArgs): CommitPollResult {
    return this.transaction((): CommitPollResult => {
      const inserted: Event[] = [];
      const duplicates: Event[] = [];
      const baselined: Event[] = [];
      const stale: Event[] = [];
      for (const e of args.events) {
        const isStale =
          args.baseline !== true &&
          args.maxEventAgeMs !== undefined &&
          args.now.getTime() - Date.parse(e.ts) > args.maxEventAgeMs;
        const init =
          args.baseline === true
            ? ({ status: 'dropped', reason: 'baseline' } as const)
            : isStale
              ? ({ status: 'dropped', reason: 'stale' } as const)
              : {};
        if (!this.events.insertIgnore(e, args.now, init)) duplicates.push(e);
        else if (args.baseline === true) baselined.push(e);
        else if (isStale) stale.push(e);
        else inserted.push(e);
      }
      if (args.records !== undefined && args.records.length > 0)
        this.persistRecords(args.records, args.now);
      let advanced = false;
      if (args.cursor !== undefined && args.cursor !== null) {
        this.watermarks.set(args.source, args.ticker, args.cursor, args.now);
        advanced = true;
      }
      return { inserted, duplicates, baselined, stale, watermarkAdvanced: advanced };
    });
  }
}

function assertNever(value: never): never {
  throw new StoreError(`Unhandled domain record: ${JSON.stringify(value)}`);
}

/** Wrap an already-migrated handle. */
export function createStore(db: Db): Store {
  return new Store(db);
}

export interface OpenStoreOptions {
  now?: () => Date;
  /**
   * Directory for a pre-migration safety copy. When pending migrations exist on a NON-EMPTY database, the file
   * is copied here (`VACUUM INTO`, a consistent snapshot) as `pre-migrate-<stamp>-<first migration id>.db`
   * BEFORE anything is changed, so a bad upgrade on the Pi is recoverable.
   */
  backupBeforeMigrate?: string;
}

/**
 * Open `file`, run migrations, and return a Store. The composition root calls this once. The second argument
 * may be a `now` function (legacy) or {@link OpenStoreOptions}.
 */
export function openStore(file: string, options: OpenStoreOptions | (() => Date) = {}): Store {
  const opts: OpenStoreOptions = typeof options === 'function' ? { now: options } : options;
  const now = opts.now ?? (() => new Date());
  const db = openDb(file);
  if (opts.backupBeforeMigrate !== undefined && file !== ':memory:') {
    const pending = pendingMigrations(db);
    const first = pending[0];
    if (first !== undefined && hasAppliedMigrations(db)) {
      fs.mkdirSync(opts.backupBeforeMigrate, { recursive: true });
      const stamp = now().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(opts.backupBeforeMigrate, `pre-migrate-${stamp}-${first.id}.db`);
      db.prepare('VACUUM INTO ?').run(dest);
    }
  }
  migrate(db, undefined, now);
  return new Store(db);
}

function hasAppliedMigrations(db: Db): boolean {
  const has =
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get() !== undefined;
  return has && db.prepare('SELECT 1 FROM schema_migrations LIMIT 1').get() !== undefined;
}

/** An in-memory migrated Store (tests, replay). */
export function createMemoryStore(): Store {
  return openStore(':memory:');
}
