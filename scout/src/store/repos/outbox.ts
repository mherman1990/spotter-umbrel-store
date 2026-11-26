import { StoreError } from '../../core/errors.js';
import { hashJson } from '../../core/ids.js';
import { PRIORITIES, type Priority } from '../../types.js';
import { Repo, iso, parseJson, placeholders } from './common.js';

export type PushKind = 'alert' | 'digest' | 'brief' | 'ops';

export const PUSH_KINDS: readonly PushKind[] = ['alert', 'digest', 'brief', 'ops'];
export type PushStatus = 'pending' | 'sent' | 'failed' | 'folded';

/** What a producer enqueues. `body` is the full serialized message (e.g. an `AlertMessage`). */
export interface NewPush {
  kind: PushKind;
  priority: Priority;
  ticker: string;
  headline: string;
  soWhat: string | null;
  eventIds: readonly string[];
  body: Record<string, unknown>;
  /** Stable key making enqueue idempotent (see `pushIdempotencyKey`). */
  idempotencyKey: string;
  /** Earliest first attempt (default: now). */
  nextAttemptAt?: Date;
}

export interface PushRecord {
  id: string;
  kind: PushKind;
  priority: Priority;
  ticker: string;
  headline: string;
  soWhat: string | null;
  eventIds: string[];
  body: Record<string, unknown>;
  /** Channel that actually delivered it (`openclaw`, `ntfy`), null until sent. */
  channel: string | null;
  status: PushStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  nextAttemptAt: string | null;
  idempotencyKey: string;
}

interface PushRow {
  id: string;
  event_ids_json: string;
  kind: PushKind;
  priority: Priority;
  ticker: string;
  headline: string;
  so_what: string | null;
  body_json: string;
  channel: string | null;
  status: PushStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
  next_attempt_at: string | null;
  idempotency_key: string;
}

const COLS = `id, event_ids_json, kind, priority, ticker, headline, so_what, body_json, channel, status, attempts,
  last_error, created_at, sent_at, next_attempt_at, idempotency_key`;

function toRecord(r: PushRow): PushRecord {
  return {
    id: r.id,
    kind: r.kind,
    priority: r.priority,
    ticker: r.ticker,
    headline: r.headline,
    soWhat: r.so_what,
    eventIds: parseJson<string[]>(r.event_ids_json, []),
    body: parseJson<Record<string, unknown>>(r.body_json, {}),
    channel: r.channel,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: r.created_at,
    sentAt: r.sent_at,
    nextAttemptAt: r.next_attempt_at,
    idempotencyKey: r.idempotency_key,
  };
}

/**
 * Notification outbox. A push stays `pending` (with `next_attempt_at`) across transient failures and is only
 * `failed` when the caller gives up (max attempts), so a notify outage never loses an alert (decision D10).
 *
 * Concurrency: a flush must call {@link claimDue} (not `due`) so the rows it is about to send are LEASED
 * (`next_attempt_at` pushed into the future); an overlapping flush then skips them instead of sending the same
 * push twice (ntfy has no idempotency key).
 */
export class OutboxRepo extends Repo {
  /**
   * Idempotent enqueue. `inserted` is false when the idempotency key already exists (returns the existing id).
   * @throws StoreError for an invalid `kind`/`priority` (a clear error, not a CHECK failure that vanished).
   */
  enqueue(push: NewPush, now: Date): { id: string; inserted: boolean } {
    if (!PUSH_KINDS.includes(push.kind))
      throw new StoreError(`Invalid push kind "${String(push.kind)}"`);
    if (!PRIORITIES.includes(push.priority))
      throw new StoreError(`Invalid push priority "${String(push.priority)}"`);
    const id = `push_${hashJson(push.idempotencyKey).slice(0, 24)}`;
    const info = this.stmt(
      `INSERT INTO pushes (id, event_ids_json, kind, priority, ticker, headline, so_what, body_json,
         status, attempts, created_at, next_attempt_at, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).run(
      id,
      JSON.stringify([...push.eventIds]),
      push.kind,
      push.priority,
      push.ticker,
      push.headline,
      push.soWhat,
      JSON.stringify(push.body),
      iso(now),
      iso(push.nextAttemptAt ?? now),
      push.idempotencyKey,
    );
    if (info.changes > 0) {
      const link = this.stmt(
        'INSERT INTO push_events (push_id, event_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
      );
      for (const eventId of push.eventIds) link.run(id, eventId);
      return { id, inserted: true };
    }
    const existing = this.stmt('SELECT id FROM pushes WHERE idempotency_key = ?').get(
      push.idempotencyKey,
    ) as { id: string };
    return { id: existing.id, inserted: false };
  }

  get(id: string): PushRecord | undefined {
    const r = this.stmt(`SELECT ${COLS} FROM pushes WHERE id = ?`).get(id) as PushRow | undefined;
    return r === undefined ? undefined : toRecord(r);
  }

  getByKey(idempotencyKey: string): PushRecord | undefined {
    const r = this.stmt(`SELECT ${COLS} FROM pushes WHERE idempotency_key = ?`).get(
      idempotencyKey,
    ) as PushRow | undefined;
    return r === undefined ? undefined : toRecord(r);
  }

  /** Pushes that covered `eventId` (any status), oldest first ("was this 8-K pushed?"). */
  pushesCovering(eventId: string): PushRecord[] {
    const rows = this.stmt(
      `SELECT ${COLS.split(',')
        .map((c) => `p.${c.trim()}`)
        .join(
          ', ',
        )} FROM pushes p JOIN push_events e ON e.push_id = p.id WHERE e.event_id = ? ORDER BY p.created_at`,
    ).all(eventId) as PushRow[];
    return rows.map(toRecord);
  }

  /**
   * Atomically LEASE the due pending pushes: in one write transaction select them (most urgent then oldest) and
   * push their `next_attempt_at` to `now + leaseMs`, so a concurrent or overlapping flush does not see them
   * as due. A successful send marks the row `sent`; a failure sets its own retry time (`markAttemptFailed`); a
   * crash mid-send simply lets the lease expire and the push is retried (at-least-once, never lost).
   */
  claimDue(now: Date, leaseMs: number, limit = 50): PushRecord[] {
    return this.db
      .transaction((): PushRecord[] => {
        const rows = this.due(now, limit);
        if (rows.length === 0) return rows;
        this.db
          .prepare(
            `UPDATE pushes SET next_attempt_at = ? WHERE id IN (${placeholders(rows.length)})`,
          )
          .run(iso(new Date(now.getTime() + leaseMs)), ...rows.map((r) => r.id));
        return rows;
      })
      .immediate();
  }

  /** Pending pushes whose `next_attempt_at` has arrived, most urgent then oldest first. */
  due(now: Date, limit = 50): PushRecord[] {
    const rows = this.stmt(
      `SELECT ${COLS} FROM pushes WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY priority ASC, created_at ASC LIMIT ?`,
    ).all(iso(now), limit) as PushRow[];
    return rows.map(toRecord);
  }

  markSent(id: string, channel: string, now: Date): void {
    this.stmt(
      `UPDATE pushes SET status = 'sent', channel = ?, sent_at = ?, attempts = attempts + 1, last_error = NULL,
         next_attempt_at = NULL WHERE id = ?`,
    ).run(channel, iso(now), id);
  }

  /**
   * Record a failed attempt. `retryAt` = when to try again (push stays `pending`); `null` = give up
   * (`failed`, terminal).
   */
  markAttemptFailed(id: string, error: string, retryAt: Date | null): void {
    this.stmt(
      `UPDATE pushes SET attempts = attempts + 1, last_error = ?, status = ?, next_attempt_at = ? WHERE id = ?`,
    ).run(
      error.slice(0, 1000),
      retryAt === null ? 'failed' : 'pending',
      retryAt === null ? null : iso(retryAt),
      id,
    );
  }

  /** The push was merged into another (P1-cap overflow, cluster): terminal, not an error. */
  markFolded(id: string): void {
    this.stmt("UPDATE pushes SET status = 'folded', next_attempt_at = NULL WHERE id = ?").run(id);
  }

  /** Newest pushes first (for `/health` and debugging). */
  recent(limit = 50): PushRecord[] {
    return (
      this.stmt(`SELECT ${COLS} FROM pushes ORDER BY created_at DESC LIMIT ?`).all(
        limit,
      ) as PushRow[]
    ).map(toRecord);
  }

  countByStatus(): Record<PushStatus, number> {
    const out: Record<PushStatus, number> = { pending: 0, sent: 0, failed: 0, folded: 0 };
    for (const r of this.stmt('SELECT status, COUNT(*) AS n FROM pushes GROUP BY status').all() as {
      status: PushStatus;
      n: number;
    }[]) {
      out[r.status] = r.n;
    }
    return out;
  }

  /** Pushes sent since `since`, optionally by kind/priority (acceptance: "no more than 8 pushes that day"). */
  countSentSince(since: Date, filter: { kind?: PushKind; priority?: Priority } = {}): number {
    const where = ["status = 'sent'", 'sent_at >= ?'];
    const params: unknown[] = [iso(since)];
    if (filter.kind !== undefined) {
      where.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.priority !== undefined) {
      where.push('priority = ?');
      params.push(filter.priority);
    }
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM pushes WHERE ${where.join(' AND ')}`)
        .get(...params) as { n: number }
    ).n;
  }

  /** `created_at` of the oldest pending push, or null (outbox stuck detection). */
  oldestPendingAt(): string | null {
    return (
      this.stmt("SELECT MIN(created_at) AS t FROM pushes WHERE status = 'pending'").get() as {
        t: string | null;
      }
    ).t;
  }
}
