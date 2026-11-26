import { ValidationError } from '../../core/errors.js';
import {
  EVENT_SOURCES,
  KIND_SOURCE,
  type Event,
  type EventSource,
  type EventStatus,
  type KnownEventKind,
  type Priority,
} from '../../types.js';
import { Repo, hasExplicitOffset, iso, parseJson, placeholders } from './common.js';

/** An event as stored, with lifecycle state. */
export interface StoredEvent extends Event {
  status: EventStatus;
  statusReason: string | null;
  /**
   * Parsed `triage_json`, or null when never triaged. The shape is a `TriageRecord` (engine/types.ts); read it with
   * `parseTriageRecord` (engine/schemas.ts) rather than casting.
   */
  triage: Record<string, unknown> | null;
  /** Which digest this event was queued for (`premarket` | `midday` | `close`); retained after it is digested. */
  digestKind: string | null;
  /** Triage/processing attempts so far. */
  attempts: number;
  lastError: string | null;
  /** True once retention blanked `payload` (aggregates remain). */
  payloadPruned: boolean;
  createdAt: string;
  updatedAt: string;
}

interface EventRow {
  id: string;
  ticker: string;
  source: EventSource;
  kind: string;
  ts_iso: string;
  ts_epoch_ms: number;
  payload_json: string;
  payload_pruned: number;
  url: string | null;
  rule_priority: Priority | null;
  final_priority: Priority | null;
  status: EventStatus;
  status_reason: string | null;
  triage_json: string | null;
  digest_kind: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function toStored(r: EventRow): StoredEvent {
  const e: StoredEvent = {
    id: r.id,
    ticker: r.ticker,
    source: r.source,
    kind: r.kind,
    ts: r.ts_iso,
    payload: parseJson<Record<string, unknown>>(r.payload_json, {}),
    status: r.status,
    statusReason: r.status_reason,
    triage: parseJson<Record<string, unknown> | null>(r.triage_json, null),
    digestKind: r.digest_kind,
    attempts: r.attempts,
    lastError: r.last_error,
    payloadPruned: r.payload_pruned === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.url !== null) e.url = r.url;
  if (r.rule_priority !== null) e.rulePriority = r.rule_priority;
  if (r.final_priority !== null) e.finalPriority = r.final_priority;
  return e;
}

export interface EventQuery {
  sinceMs?: number;
  untilMs?: number;
  kinds?: readonly string[];
  sources?: readonly EventSource[];
  /** Only events whose effective priority (final, else rule) is at least this urgent. */
  minPriority?: Priority;
  statuses?: readonly EventStatus[];
  limit?: number;
  order?: 'asc' | 'desc';
}

const COLS = `id, ticker, source, kind, ts_iso, ts_epoch_ms, payload_json, payload_pruned, url, rule_priority,
  final_priority, status, status_reason, triage_json, digest_kind, attempts, last_error, created_at, updated_at`;

/**
 * Epoch ms at which a failed triage becomes due again: immediately when it never failed, else
 * `updatedAt + min(base * 2^(attempts-1), max)` seconds.
 */
export function retryDueAt(
  attempts: number,
  updatedAtIso: string,
  policy: { baseSeconds: number; maxSeconds: number },
): number {
  if (attempts <= 0) return 0;
  const waitSeconds = Math.min(policy.baseSeconds * 2 ** (attempts - 1), policy.maxSeconds);
  return Date.parse(updatedAtIso) + waitSeconds * 1000;
}

/** Initial lifecycle state for an insert (baseline/stale catch-up events are stored `dropped`, never `new`). */
export interface InsertInit {
  status?: EventStatus;
  reason?: string;
}

/**
 * Events table. All inserts are idempotent (`ON CONFLICT DO NOTHING` by id): re-polling the same fact never
 * creates a second row nor resets its lifecycle (decision D9). It is NOT `INSERT OR IGNORE`: that would also
 * swallow CHECK and NOT NULL violations (a malformed event vanishing while the cursor advances breaks D10);
 * here only the uniqueness conflict is ignored and everything else throws and rolls the commit back. Status
 * transitions are explicit calls; nothing here retires an event as a side effect of a failure (decision D10).
 */
export class EventsRepo extends Repo {
  /**
   * Insert if the id is new. Returns true when a row was inserted, false for a duplicate.
   * @throws ValidationError for a malformed event (bad source, zoneless `ts`, non-object payload, a kind/source
   *   pair that contradicts `KIND_SOURCE`): a bug in the producer, surfaced loudly instead of swallowed.
   */
  insertIgnore(event: Event, createdAt: Date, init: InsertInit = {}): boolean {
    this.validate(event);
    const tsMs = Date.parse(event.ts);
    const now = iso(createdAt);
    const info = this.stmt(
      `INSERT INTO events (id, ticker, source, kind, ts_iso, ts_epoch_ms, payload_json, url,
         rule_priority, final_priority, status, status_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).run(
      event.id,
      event.ticker,
      event.source,
      event.kind,
      event.ts,
      tsMs,
      JSON.stringify(event.payload),
      event.url ?? null,
      event.rulePriority ?? null,
      event.finalPriority ?? null,
      init.status ?? 'new',
      init.reason ?? null,
      now,
      now,
    );
    return info.changes > 0;
  }

  private validate(event: Event): void {
    const bad = (why: string): never => {
      throw new ValidationError(`Event ${event.id || '<no id>'} is malformed: ${why}`);
    };
    if (typeof event.id !== 'string' || event.id === '') bad('missing id');
    if (typeof event.ticker !== 'string' || event.ticker === '') bad('missing ticker');
    if (!(EVENT_SOURCES as readonly string[]).includes(event.source))
      bad(`unknown source "${String(event.source)}"`);
    if (typeof event.kind !== 'string' || event.kind === '') bad('missing kind');
    const expected = KIND_SOURCE[event.kind as KnownEventKind];
    if (expected !== undefined && expected !== event.source)
      bad(`kind "${event.kind}" belongs to source "${expected}", not "${event.source}"`);
    if (typeof event.ts !== 'string' || !Number.isFinite(Date.parse(event.ts)))
      bad(`unparseable ts: ${String(event.ts)}`);
    // `Date.parse('2026-12-03T08:00:00')` (no offset) uses the PROCESS zone: the container runs
    // TZ=America/Chicago, so ts_epoch_ms would be silently shifted by hours.
    if (!hasExplicitOffset(event.ts))
      bad(`ts must carry an explicit offset (Z or +hh:mm), got "${event.ts}"`);
    if (event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload))
      bad('payload must be an object');
  }

  /** Insert many (caller owns the transaction). Splits the input into newly inserted events and duplicates. */
  insertManyIgnore(
    events: readonly Event[],
    createdAt: Date,
    init: InsertInit | ((e: Event) => InsertInit) = {},
  ): { inserted: Event[]; duplicates: Event[] } {
    const inserted: Event[] = [];
    const duplicates: Event[] = [];
    for (const e of events) {
      const i = typeof init === 'function' ? init(e) : init;
      (this.insertIgnore(e, createdAt, i) ? inserted : duplicates).push(e);
    }
    return { inserted, duplicates };
  }

  get(id: string): StoredEvent | undefined {
    const r = this.stmt(`SELECT ${COLS} FROM events WHERE id = ?`).get(id) as EventRow | undefined;
    return r === undefined ? undefined : toStored(r);
  }

  exists(id: string): boolean {
    return this.stmt('SELECT 1 FROM events WHERE id = ?').get(id) !== undefined;
  }

  /**
   * Events in any of `statuses`. Default order is OLDEST first (work-queue order). `order: 'priority'` is the
   * pipeline's drain order: effective priority first (`COALESCE(final_priority, rule_priority)`, P1 before P2
   * before P3 before unclassified), then oldest, so a fresh 8-K is never stuck behind a backlog of news.
   */
  byStatus(
    statuses: readonly EventStatus[],
    opts: {
      ticker?: string;
      limit?: number;
      createdBefore?: Date;
      updatedBefore?: Date;
      order?: 'created' | 'priority';
    } = {},
  ): StoredEvent[] {
    const where = [`status IN (${placeholders(statuses.length)})`];
    const params: unknown[] = [...statuses];
    if (opts.ticker !== undefined) {
      where.push('ticker = ?');
      params.push(opts.ticker);
    }
    if (opts.createdBefore !== undefined) {
      where.push('created_at < ?');
      params.push(iso(opts.createdBefore));
    }
    if (opts.updatedBefore !== undefined) {
      where.push('updated_at < ?');
      params.push(iso(opts.updatedBefore));
    }
    params.push(opts.limit ?? 500);
    const order =
      opts.order === 'priority'
        ? `CASE COALESCE(final_priority, rule_priority) WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END ASC, created_at ASC, id ASC`
        : 'created_at ASC, id ASC';
    const rows = this.db
      .prepare(`SELECT ${COLS} FROM events WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`)
      .all(...params) as EventRow[];
    return rows.map(toStored);
  }

  /**
   * Untriaged (`new`) events whose retry is DUE, plus those that exhausted their attempts. The backoff is
   * DERIVED from `attempts` and `updated_at` (no extra column): `base * 2^(attempts-1)` seconds after the last
   * failure, capped at `maxSeconds`. Without it, an LLM outage re-calls the model for every failing event on
   * every pass (spend and rate-limit storm). Priority order, so a P1 is retried before a news item.
   */
  untriagedDue(
    now: Date,
    policy: { baseSeconds: number; maxSeconds: number; maxAttempts: number },
    limit = 500,
  ): { due: StoredEvent[]; exhausted: StoredEvent[] } {
    const due: StoredEvent[] = [];
    const exhausted: StoredEvent[] = [];
    for (const e of this.byStatus(['new'], {
      order: 'priority',
      limit: Math.max(limit * 4, 2000),
    })) {
      if (e.attempts >= policy.maxAttempts) exhausted.push(e);
      else if (retryDueAt(e.attempts, e.updatedAt, policy) <= now.getTime() && due.length < limit)
        due.push(e);
    }
    return { due, exhausted };
  }

  /** Events with this `status` AND `status_reason` (e.g. `queued` + `awaiting_scorecard`), oldest first. */
  byStatusReason(
    status: EventStatus,
    reason: string,
    opts: { ticker?: string; limit?: number } = {},
  ): StoredEvent[] {
    const where = ['status = ?', 'status_reason = ?'];
    const params: unknown[] = [status, reason];
    if (opts.ticker !== undefined) {
      where.push('ticker = ?');
      params.push(opts.ticker);
    }
    params.push(opts.limit ?? 500);
    return (
      this.db
        .prepare(
          `SELECT ${COLS} FROM events WHERE ${where.join(' AND ')} ORDER BY created_at ASC, id ASC LIMIT ?`,
        )
        .all(...params) as EventRow[]
    ).map(toStored);
  }

  /** Events for a ticker (use `GLOBAL_TICKER` for macro), filtered; default newest first, limit 200. */
  byTicker(ticker: string, q: EventQuery = {}): StoredEvent[] {
    const where = ['ticker = ?'];
    const params: unknown[] = [ticker];
    if (q.sinceMs !== undefined) {
      where.push('ts_epoch_ms >= ?');
      params.push(q.sinceMs);
    }
    if (q.untilMs !== undefined) {
      where.push('ts_epoch_ms < ?');
      params.push(q.untilMs);
    }
    if (q.kinds !== undefined && q.kinds.length > 0) {
      where.push(`kind IN (${placeholders(q.kinds.length)})`);
      params.push(...q.kinds);
    }
    if (q.sources !== undefined && q.sources.length > 0) {
      where.push(`source IN (${placeholders(q.sources.length)})`);
      params.push(...q.sources);
    }
    if (q.statuses !== undefined && q.statuses.length > 0) {
      where.push(`status IN (${placeholders(q.statuses.length)})`);
      params.push(...q.statuses);
    }
    if (q.minPriority !== undefined) {
      const allowed =
        q.minPriority === 'P1'
          ? ['P1']
          : q.minPriority === 'P2'
            ? ['P1', 'P2']
            : ['P1', 'P2', 'P3'];
      where.push(`COALESCE(final_priority, rule_priority) IN (${placeholders(allowed.length)})`);
      params.push(...allowed);
    }
    params.push(q.limit ?? 200);
    const dir = q.order === 'asc' ? 'ASC' : 'DESC';
    const rows = this.db
      .prepare(
        `SELECT ${COLS} FROM events WHERE ${where.join(' AND ')} ORDER BY ts_epoch_ms ${dir}, id ${dir} LIMIT ?`,
      )
      .all(...params) as EventRow[];
    return rows.map(toStored);
  }

  /** Recent events of given sources for one ticker, newest first (semantic-dedupe candidate window). */
  recentBySource(
    ticker: string,
    sources: readonly EventSource[],
    sinceMs: number,
    limit = 200,
  ): StoredEvent[] {
    return this.byTicker(ticker, { sources, sinceMs, limit });
  }

  /** Set the deterministic rule priority (rules.ts). */
  setRulePriority(id: string, priority: Priority, now: Date): void {
    this.stmt('UPDATE events SET rule_priority = ?, updated_at = ? WHERE id = ?').run(
      priority,
      iso(now),
      id,
    );
  }

  /**
   * Record the triage verdict and final priority; status -> `triaged`. `triage` is the stored JSON (verdict,
   * model, whether it was skipped/failed-open). A processing failure must NOT call this (use recordFailure).
   */
  markTriaged(
    id: string,
    result: { triage: Record<string, unknown> | null; finalPriority: Priority; reason?: string },
    now: Date,
    expect: readonly EventStatus[] = ['new', 'triaged'],
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE events SET status = 'triaged', triage_json = ?, final_priority = ?, status_reason = ?,
         last_error = NULL, updated_at = ? WHERE id = ? AND status IN (${placeholders(expect.length)})`,
        )
        .run(
          result.triage === null ? null : JSON.stringify(result.triage),
          result.finalPriority,
          result.reason ?? null,
          iso(now),
          id,
          ...expect,
        ).changes > 0
    );
  }

  /**
   * Generic status transition. `digestKind` is set when moving to `queued` and retained afterwards (history).
   * With `expect`, the update applies ONLY when the current status is one of those (invariant I4: guarded
   * transitions, so a stale pass cannot resurrect or overwrite an event another pass already moved). Returns
   * whether a row changed.
   */
  setStatus(
    id: string,
    status: EventStatus,
    now: Date,
    opts: {
      reason?: string;
      digestKind?: string | null;
      finalPriority?: Priority;
      expect?: readonly EventStatus[];
    } = {},
  ): boolean {
    const guard =
      opts.expect === undefined || opts.expect.length === 0
        ? ''
        : ` AND status IN (${placeholders(opts.expect.length)})`;
    return (
      this.db
        .prepare(
          `UPDATE events SET status = ?, status_reason = COALESCE(?, status_reason),
         digest_kind = CASE WHEN ? = 1 THEN ? ELSE digest_kind END,
         final_priority = COALESCE(?, final_priority), updated_at = ? WHERE id = ?${guard}`,
        )
        .run(
          status,
          opts.reason ?? null,
          status === 'queued' ? 1 : 0,
          opts.digestKind ?? null,
          opts.finalPriority ?? null,
          iso(now),
          id,
          ...(opts.expect ?? []),
        ).changes > 0
    );
  }

  /** Count a failed processing attempt WITHOUT changing status, so the event stays eligible for retry. */
  recordFailure(id: string, error: string, now: Date): void {
    this.stmt(
      'UPDATE events SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?',
    ).run(error.slice(0, 1000), iso(now), id);
  }

  /** Events queued for a digest (`digestKind` null = any), oldest first. */
  queuedForDigest(
    digestKind: string | null,
    opts: { ticker?: string; limit?: number } = {},
  ): StoredEvent[] {
    const where = ["status = 'queued'"];
    const params: unknown[] = [];
    if (digestKind !== null) {
      where.push('digest_kind = ?');
      params.push(digestKind);
    }
    if (opts.ticker !== undefined) {
      where.push('ticker = ?');
      params.push(opts.ticker);
    }
    params.push(opts.limit ?? 500);
    const rows = this.db
      .prepare(
        `SELECT ${COLS} FROM events WHERE ${where.join(' AND ')} ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all(...params) as EventRow[];
    return rows.map(toStored);
  }

  /** Mark events as included in a sent digest/brief. Returns rows changed. */
  markDigested(ids: readonly string[], now: Date): number {
    if (ids.length === 0) return 0;
    return this.db
      .prepare(
        `UPDATE events SET status = 'digested', updated_at = ? WHERE id IN (${placeholders(ids.length)}) AND status IN ('queued','triaged')`,
      )
      .run(iso(now), ...ids).changes;
  }

  /**
   * Count events created since `since` with effective priority `priority` (final, else rule) and status in
   * `statuses` (default: any). Drives the "3+ P2 within 30 minutes" cluster check.
   */
  countRecent(opts: {
    priority: Priority;
    since: Date;
    statuses?: readonly EventStatus[];
    ticker?: string;
  }): number {
    const where = ['COALESCE(final_priority, rule_priority) = ?', 'created_at >= ?'];
    const params: unknown[] = [opts.priority, iso(opts.since)];
    if (opts.statuses !== undefined && opts.statuses.length > 0) {
      where.push(`status IN (${placeholders(opts.statuses.length)})`);
      params.push(...opts.statuses);
    }
    if (opts.ticker !== undefined) {
      where.push('ticker = ?');
      params.push(opts.ticker);
    }
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE ${where.join(' AND ')}`)
      .get(...params) as { n: number };
    return r.n;
  }

  /** Same filter as {@link countRecent} but returns the events (oldest first). */
  listRecent(opts: {
    priority: Priority;
    since: Date;
    statuses?: readonly EventStatus[];
    ticker?: string;
  }): StoredEvent[] {
    const where = ['COALESCE(final_priority, rule_priority) = ?', 'created_at >= ?'];
    const params: unknown[] = [opts.priority, iso(opts.since)];
    if (opts.statuses !== undefined && opts.statuses.length > 0) {
      where.push(`status IN (${placeholders(opts.statuses.length)})`);
      params.push(...opts.statuses);
    }
    if (opts.ticker !== undefined) {
      where.push('ticker = ?');
      params.push(opts.ticker);
    }
    const rows = this.db
      .prepare(
        `SELECT ${COLS} FROM events WHERE ${where.join(' AND ')} ORDER BY created_at ASC, id ASC`,
      )
      .all(...params) as EventRow[];
    return rows.map(toStored);
  }

  /** Row counts per status (health / `/health`). Missing statuses are 0. */
  countByStatus(): Record<EventStatus, number> {
    const out: Record<EventStatus, number> = {
      new: 0,
      triaged: 0,
      queued: 0,
      pushed: 0,
      digested: 0,
      dropped: 0,
      folded: 0,
    };
    for (const r of this.stmt('SELECT status, COUNT(*) AS n FROM events GROUP BY status').all() as {
      status: EventStatus;
      n: number;
    }[]) {
      out[r.status] = r.n;
    }
    return out;
  }

  /** `created_at` of the oldest event still unjudged (`new`), or null. Used to detect a stuck triage queue. */
  oldestUnjudgedAt(): string | null {
    const r = this.stmt("SELECT MIN(created_at) AS t FROM events WHERE status = 'new'").get() as {
      t: string | null;
    };
    return r.t;
  }
}

export type LinkRelation = 'duplicate' | 'rewrite' | 'cluster' | 'overflow';

/**
 * Secondary -> primary event links (semantic near-duplicates, clusters, P1-cap overflow). BOTH ids are EVENT
 * ids: `primary_id REFERENCES events(id)`. A push id is not an event id (linking to one fails the foreign key
 * and would roll back the whole budget decision); push-to-event coverage lives in `push_events`.
 */
export class EventLinksRepo extends Repo {
  /** Link `secondaryId` to `primaryId`. Idempotent (a secondary has one primary). Returns true if inserted. */
  link(
    secondaryId: string,
    primaryId: string,
    relation: LinkRelation,
    score: number | null,
    now: Date,
  ): boolean {
    return (
      this.stmt(
        'INSERT INTO event_links (secondary_id, primary_id, relation, score, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      ).run(secondaryId, primaryId, relation, score, iso(now)).changes > 0
    );
  }

  primaryOf(
    secondaryId: string,
  ): { primaryId: string; relation: LinkRelation; score: number | null } | undefined {
    const r = this.stmt(
      'SELECT primary_id, relation, score FROM event_links WHERE secondary_id = ?',
    ).get(secondaryId) as
      { primary_id: string; relation: LinkRelation; score: number | null } | undefined;
    return r === undefined
      ? undefined
      : { primaryId: r.primary_id, relation: r.relation, score: r.score };
  }

  secondariesOf(
    primaryId: string,
  ): { secondaryId: string; relation: LinkRelation; score: number | null }[] {
    const rows = this.stmt(
      'SELECT secondary_id, relation, score FROM event_links WHERE primary_id = ? ORDER BY created_at',
    ).all(primaryId) as { secondary_id: string; relation: LinkRelation; score: number | null }[];
    return rows.map((r) => ({ secondaryId: r.secondary_id, relation: r.relation, score: r.score }));
  }
}
