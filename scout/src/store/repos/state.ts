import { Repo, iso, parseJson, toBool } from './common.js';

// ---------------------------------------------------------------------------------------------
// token_state
// ---------------------------------------------------------------------------------------------

export interface TokenState {
  id: string;
  /** AES-256-GCM ciphertext (nonce||tag||ct) of the token JSON, or null when not authorized yet. */
  encryptedBlob: Buffer | null;
  /** When the CURRENT refresh token was issued (Schwab: valid 7 days FIXED from this instant). */
  refreshTokenIssuedAt: string | null;
  accessExpiresAt: string | null;
  sent24h: boolean;
  sent6h: boolean;
  sentExpired: boolean;
  lastRefreshOkAt: string | null;
  lastError: string | null;
  quotesDownAlertedAt: string | null;
  updatedAt: string;
}

type ReminderFlag = 'sent_24h' | 'sent_6h' | 'sent_expired';

/** Encrypted OAuth token blob plus the expiry-reminder bookkeeping (decision D12). */
export class TokenStateRepo extends Repo {
  get(id: string): TokenState | undefined {
    const r = this.stmt('SELECT * FROM token_state WHERE id = ?').get(id) as
      | {
          id: string;
          encrypted_blob: Buffer | null;
          refresh_token_issued_at: string | null;
          access_expires_at: string | null;
          sent_24h: number;
          sent_6h: number;
          sent_expired: number;
          last_refresh_ok_at: string | null;
          last_error: string | null;
          quotes_down_alerted_at: string | null;
          updated_at: string;
        }
      | undefined;
    return r === undefined
      ? undefined
      : {
          id: r.id,
          encryptedBlob: r.encrypted_blob,
          refreshTokenIssuedAt: r.refresh_token_issued_at,
          accessExpiresAt: r.access_expires_at,
          sent24h: toBool(r.sent_24h),
          sent6h: toBool(r.sent_6h),
          sentExpired: toBool(r.sent_expired),
          lastRefreshOkAt: r.last_refresh_ok_at,
          lastError: r.last_error,
          quotesDownAlertedAt: r.quotes_down_alerted_at,
          updatedAt: r.updated_at,
        };
  }

  /**
   * Store a freshly obtained token set. `newRefreshToken` = a NEW refresh token was issued (authorization-code
   * login): reset `refresh_token_issued_at` and clear all reminder flags. A plain access-token refresh passes
   * `false` and leaves the 7-day clock and flags alone (Schwab refresh tokens are not extended by use).
   */
  saveTokens(
    id: string,
    blob: Buffer,
    accessExpiresAt: Date,
    now: Date,
    opts: { newRefreshToken: boolean },
  ): void {
    this.db.transaction(() => {
      this.stmt(
        `INSERT INTO token_state (id, encrypted_blob, refresh_token_issued_at, access_expires_at, last_refresh_ok_at,
           last_error, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT (id) DO UPDATE SET encrypted_blob = excluded.encrypted_blob,
           access_expires_at = excluded.access_expires_at, last_refresh_ok_at = excluded.last_refresh_ok_at,
           last_error = NULL, updated_at = excluded.updated_at`,
      ).run(
        id,
        blob,
        opts.newRefreshToken ? iso(now) : null,
        iso(accessExpiresAt),
        iso(now),
        iso(now),
      );
      if (opts.newRefreshToken) {
        this.stmt(
          `UPDATE token_state SET refresh_token_issued_at = ?, sent_24h = 0, sent_6h = 0, sent_expired = 0,
             quotes_down_alerted_at = NULL WHERE id = ?`,
        ).run(iso(now), id);
      }
    })();
  }

  /** Record a refresh failure (message must already be secret-free). */
  recordError(id: string, error: string, now: Date): void {
    this.stmt(
      `INSERT INTO token_state (id, last_error, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET last_error = excluded.last_error, updated_at = excluded.updated_at`,
    ).run(id, error.slice(0, 500), iso(now));
  }

  /** Mark a reminder as sent. Returns true if it was not already marked (caller sends exactly once). */
  markReminderSent(id: string, flag: 'sent24h' | 'sent6h' | 'sentExpired', now: Date): boolean {
    const col: ReminderFlag =
      flag === 'sent24h' ? 'sent_24h' : flag === 'sent6h' ? 'sent_6h' : 'sent_expired';
    return (
      this.db
        .prepare(`UPDATE token_state SET ${col} = 1, updated_at = ? WHERE id = ? AND ${col} = 0`)
        .run(iso(now), id).changes > 0
    );
  }

  /** Mark "quotes down" alerted (ONCE per outage, decision D12). Returns true if this call set it. */
  markQuotesDownAlerted(id: string, now: Date): boolean {
    return (
      this.stmt(
        'UPDATE token_state SET quotes_down_alerted_at = ?, updated_at = ? WHERE id = ? AND quotes_down_alerted_at IS NULL',
      ).run(iso(now), iso(now), id).changes > 0
    );
  }

  clearQuotesDownAlerted(id: string, now: Date): void {
    this.stmt(
      'UPDATE token_state SET quotes_down_alerted_at = NULL, updated_at = ? WHERE id = ?',
    ).run(iso(now), id);
  }
}

// ---------------------------------------------------------------------------------------------
// health_state
// ---------------------------------------------------------------------------------------------

export type HealthStatus = 'ok' | 'degraded' | 'down' | 'unknown';

export interface HealthRecord {
  component: string;
  status: HealthStatus;
  since: string;
  lastOk: string | null;
  lastAlertAt: string | null;
  lastRecoveryAlertAt: string | null;
  consecutiveFailures: number;
  detail: string | null;
  updatedAt: string;
}

interface HealthRow {
  component: string;
  status: HealthStatus;
  since: string;
  last_ok: string | null;
  last_alert_at: string | null;
  last_recovery_alert_at: string | null;
  consecutive_failures: number;
  detail: string | null;
  updated_at: string;
}

const toHealth = (r: HealthRow): HealthRecord => ({
  component: r.component,
  status: r.status,
  since: r.since,
  lastOk: r.last_ok,
  lastAlertAt: r.last_alert_at,
  lastRecoveryAlertAt: r.last_recovery_alert_at,
  consecutiveFailures: r.consecutive_failures,
  detail: r.detail,
  updatedAt: r.updated_at,
});

/** Component health, with `since` tracking status transitions (health alerts + recovery notices, D31). */
export class HealthRepo extends Repo {
  get(component: string): HealthRecord | undefined {
    const r = this.stmt('SELECT * FROM health_state WHERE component = ?').get(component) as
      HealthRow | undefined;
    return r === undefined ? undefined : toHealth(r);
  }

  all(): HealthRecord[] {
    return (this.stmt('SELECT * FROM health_state ORDER BY component').all() as HealthRow[]).map(
      toHealth,
    );
  }

  /**
   * Set a component's status. `since` changes only when the status changes; `last_ok` advances on `ok`;
   * `consecutive_failures` resets on ok and increments otherwise. Returns the previous status (or null).
   */
  set(
    component: string,
    status: HealthStatus,
    now: Date,
    detail: string | null = null,
  ): HealthStatus | null {
    return this.db.transaction((): HealthStatus | null => {
      const prev = this.get(component);
      const ts = iso(now);
      if (prev === undefined) {
        this.stmt(
          `INSERT INTO health_state (component, status, since, last_ok, consecutive_failures, detail, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          component,
          status,
          ts,
          status === 'ok' ? ts : null,
          status === 'ok' ? 0 : 1,
          detail,
          ts,
        );
        return null;
      }
      const changed = prev.status !== status;
      this.stmt(
        `UPDATE health_state SET status = ?, since = ?, last_ok = ?, consecutive_failures = ?, detail = ?, updated_at = ?
         WHERE component = ?`,
      ).run(
        status,
        changed ? ts : prev.since,
        status === 'ok' ? ts : prev.lastOk,
        status === 'ok' ? 0 : prev.consecutiveFailures + 1,
        detail,
        ts,
        component,
      );
      return prev.status;
    })();
  }

  markAlerted(component: string, now: Date): void {
    this.stmt('UPDATE health_state SET last_alert_at = ? WHERE component = ?').run(
      iso(now),
      component,
    );
  }

  markRecoveryAlerted(component: string, now: Date): void {
    this.stmt('UPDATE health_state SET last_recovery_alert_at = ? WHERE component = ?').run(
      iso(now),
      component,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// alert_state (cooldown keys)
// ---------------------------------------------------------------------------------------------

export interface AlertStateRecord {
  key: string;
  lastSentAt: string | null;
  count: number;
  windowStart: string | null;
  meta: Record<string, unknown> | null;
}

/** Cooldown / once-per-window suppression keys. */
export class AlertStateRepo extends Repo {
  get(key: string): AlertStateRecord | undefined {
    const r = this.stmt('SELECT * FROM alert_state WHERE key = ?').get(key) as
      | {
          key: string;
          last_sent_at: string | null;
          count: number;
          window_start: string | null;
          meta_json: string | null;
        }
      | undefined;
    return r === undefined
      ? undefined
      : {
          key: r.key,
          lastSentAt: r.last_sent_at,
          count: r.count,
          windowStart: r.window_start,
          meta: parseJson<Record<string, unknown> | null>(r.meta_json, null),
        };
  }

  /**
   * Atomically take the right to fire `key`: true (and stamps `last_sent_at`) when the key never fired or its
   * last firing is at least `cooldownMs` old; false otherwise. Use for "alert at most once per cooldown".
   */
  tryAcquire(key: string, cooldownMs: number, now: Date): boolean {
    return this.db
      .transaction((): boolean => {
        const cur = this.get(key);
        if (cur?.lastSentAt != null && now.getTime() - Date.parse(cur.lastSentAt) < cooldownMs)
          return false;
        this.stmt(
          `INSERT INTO alert_state (key, last_sent_at, count) VALUES (?, ?, 1)
         ON CONFLICT (key) DO UPDATE SET last_sent_at = excluded.last_sent_at, count = alert_state.count + 1`,
        ).run(key, iso(now));
        return true;
      })
      .immediate();
  }

  /** Forget a key (e.g. recovery clears the "outage already logged" marker). */
  clear(key: string): void {
    this.stmt('DELETE FROM alert_state WHERE key = ?').run(key);
  }

  /** Store arbitrary JSON metadata on a key (creating it without stamping `last_sent_at`). */
  setMeta(key: string, meta: Record<string, unknown>): void {
    this.stmt(
      `INSERT INTO alert_state (key, meta_json) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET meta_json = excluded.meta_json`,
    ).run(key, JSON.stringify(meta));
  }
}

// ---------------------------------------------------------------------------------------------
// daily_counters, kv_state
// ---------------------------------------------------------------------------------------------

/** Well-known counter names. */
export const COUNTERS = {
  /** P1 pushes sent (counts toward the daily cap). */
  P1_PUSHED: 'p1_pushed',
  /** P1s folded into the overflow summary. */
  P1_FOLDED: 'p1_folded',
  P2_PUSHED: 'p2_pushed',
  PUSHES_TOTAL: 'pushes_total',
  OVERFLOW_SUMMARY_SENT: 'p1_overflow_summary_sent',
  /** Earnings scorecard / 8-K Item 2.02 pushes: cap-exempt (`notify.p1_cap_exempt`), counted separately. */
  EARNINGS_PUSHED: 'earnings_pushed',
  /** Halt pushes: cap-exempt by default, counted separately. */
  HALT_PUSHED: 'halt_pushed',
  /** Digest/brief pushes (only when Scout sends them: `briefs.writer = scout` or the ntfy fallback). */
  DIGEST_PUSHED: 'digest_pushed',
  /** Ops alerts (never count toward the P1 cap). */
  OPS_PUSHED: 'ops_pushed',
} as const;

/** Per owner-local-day counters (date = America/Chicago `YYYY-MM-DD`). */
export class DailyCountersRepo extends Repo {
  /** Add `by` (default 1) and return the new value. */
  increment(date: string, name: string, by = 1): number {
    return (
      this.stmt(
        `INSERT INTO daily_counters (date, name, value) VALUES (?, ?, ?)
         ON CONFLICT (date, name) DO UPDATE SET value = daily_counters.value + excluded.value RETURNING value`,
      ).get(date, name, by) as { value: number }
    ).value;
  }

  get(date: string, name: string): number {
    const r = this.stmt('SELECT value FROM daily_counters WHERE date = ? AND name = ?').get(
      date,
      name,
    ) as { value: number } | undefined;
    return r?.value ?? 0;
  }

  forDate(date: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.stmt('SELECT name, value FROM daily_counters WHERE date = ?').all(
      date,
    ) as { name: string; value: number }[]) {
      out[r.name] = r.value;
    }
    return out;
  }
}

/** Small JSON key/value store for miscellaneous flags (earnings-mode state, outage windows). */
export class KvRepo extends Repo {
  get<T = unknown>(key: string): T | undefined {
    const r = this.stmt('SELECT value_json FROM kv_state WHERE key = ?').get(key) as
      { value_json: string } | undefined;
    return r === undefined ? undefined : (JSON.parse(r.value_json) as T);
  }

  set(key: string, value: unknown, now: Date): void {
    this.stmt(
      `INSERT INTO kv_state (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(key, JSON.stringify(value), iso(now));
  }

  delete(key: string): void {
    this.stmt('DELETE FROM kv_state WHERE key = ?').run(key);
  }
}

// ---------------------------------------------------------------------------------------------
// jobs_runs
// ---------------------------------------------------------------------------------------------

export type JobStatus = 'running' | 'ok' | 'error' | 'skipped';

export interface JobRun {
  id: number;
  job: string;
  startedAt: string;
  finishedAt: string | null;
  status: JobStatus;
  error: string | null;
  detail: Record<string, unknown> | null;
}

/** Cron/job run history (health: last run, last success, age). */
export class JobRunsRepo extends Repo {
  start(job: string, now: Date): number {
    return Number(
      this.stmt("INSERT INTO jobs_runs (job, started_at, status) VALUES (?, ?, 'running')").run(
        job,
        iso(now),
      ).lastInsertRowid,
    );
  }

  finish(
    id: number,
    status: Exclude<JobStatus, 'running'>,
    now: Date,
    opts: { error?: string; detail?: Record<string, unknown> } = {},
  ): void {
    this.stmt(
      'UPDATE jobs_runs SET status = ?, finished_at = ?, error = ?, detail_json = ? WHERE id = ?',
    ).run(
      status,
      iso(now),
      opts.error?.slice(0, 1000) ?? null,
      opts.detail === undefined ? null : JSON.stringify(opts.detail),
      id,
    );
  }

  private map(r: {
    id: number;
    job: string;
    started_at: string;
    finished_at: string | null;
    status: JobStatus;
    error: string | null;
    detail_json: string | null;
  }): JobRun {
    return {
      id: r.id,
      job: r.job,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      status: r.status,
      error: r.error,
      detail: parseJson<Record<string, unknown> | null>(r.detail_json, null),
    };
  }

  last(job: string): JobRun | undefined {
    const r = this.stmt(
      'SELECT * FROM jobs_runs WHERE job = ? ORDER BY started_at DESC, id DESC LIMIT 1',
    ).get(job) as Parameters<JobRunsRepo['map']>[0] | undefined;
    return r === undefined ? undefined : this.map(r);
  }

  lastSuccess(job: string): JobRun | undefined {
    const r = this.stmt(
      "SELECT * FROM jobs_runs WHERE job = ? AND status = 'ok' ORDER BY started_at DESC, id DESC LIMIT 1",
    ).get(job) as Parameters<JobRunsRepo['map']>[0] | undefined;
    return r === undefined ? undefined : this.map(r);
  }

  recent(job: string, limit = 20): JobRun[] {
    return (
      this.stmt(
        'SELECT * FROM jobs_runs WHERE job = ? ORDER BY started_at DESC, id DESC LIMIT ?',
      ).all(job, limit) as Parameters<JobRunsRepo['map']>[0][]
    ).map((r) => this.map(r));
  }

  /** Mark runs left `running` by a crashed process as `error` (call at startup). Returns rows changed. */
  failStaleRunning(now: Date): number {
    return this.stmt(
      "UPDATE jobs_runs SET status = 'error', finished_at = ?, error = 'process exited while running' WHERE status = 'running'",
    ).run(iso(now)).changes;
  }
}

// ---------------------------------------------------------------------------------------------
// api_tokens
// ---------------------------------------------------------------------------------------------

export interface ApiToken {
  id: number;
  client: string;
  tokenSha256: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Hashed local-API tokens (decision D19; the plaintext token is shown once at creation and never stored). */
export class ApiTokensRepo extends Repo {
  create(client: string, tokenSha256: string, scopes: readonly string[], now: Date): number {
    return Number(
      this.stmt(
        'INSERT INTO api_tokens (client, token_sha256, scopes_json, created_at) VALUES (?, ?, ?, ?)',
      ).run(client, tokenSha256, JSON.stringify([...scopes]), iso(now)).lastInsertRowid,
    );
  }

  private map(r: {
    id: number;
    client: string;
    token_sha256: string;
    scopes_json: string;
    created_at: string;
    last_used_at: string | null;
    revoked_at: string | null;
  }): ApiToken {
    return {
      id: r.id,
      client: r.client,
      tokenSha256: r.token_sha256,
      scopes: parseJson<string[]>(r.scopes_json, []),
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
    };
  }

  /** Active (non-revoked) token by hash. */
  findActiveByHash(tokenSha256: string): ApiToken | undefined {
    const r = this.stmt(
      'SELECT * FROM api_tokens WHERE token_sha256 = ? AND revoked_at IS NULL',
    ).get(tokenSha256) as Parameters<ApiTokensRepo['map']>[0] | undefined;
    return r === undefined ? undefined : this.map(r);
  }

  touch(id: number, now: Date): void {
    this.stmt('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(iso(now), id);
  }

  revoke(client: string, now: Date): boolean {
    return (
      this.stmt('UPDATE api_tokens SET revoked_at = ? WHERE client = ? AND revoked_at IS NULL').run(
        iso(now),
        client,
      ).changes > 0
    );
  }

  list(): ApiToken[] {
    return (
      this.stmt('SELECT * FROM api_tokens ORDER BY id').all() as Parameters<
        ApiTokensRepo['map']
      >[0][]
    ).map((r) => this.map(r));
  }

  /** True when at least one active token exists (the API answers 503 until then). */
  hasActive(): boolean {
    return toBool(
      (
        this.stmt('SELECT COUNT(*) > 0 AS has FROM api_tokens WHERE revoked_at IS NULL').get() as {
          has: number;
        }
      ).has,
    );
  }
}
