import { Repo, iso, normalizeInstant, parseJson } from './common.js';

export interface PlanSnapshot {
  id: number;
  ticker: string;
  planHash: string;
  plan: unknown;
  completeness: unknown;
  createdAt: string;
}

/**
 * Snapshots of the owner's plan, written only when its content hash changes FROM THE LATEST SNAPSHOT. There is
 * no unique (ticker, hash): an A -> B -> A history is real and must end with A as the latest snapshot.
 */
export class PlanSnapshotsRepo extends Repo {
  /** Insert a snapshot unless the latest one already has this hash. Returns true when a new snapshot was stored. */
  snapshotIfChanged(
    ticker: string,
    planHash: string,
    plan: unknown,
    completeness: unknown,
    now: Date,
  ): boolean {
    const latest = this.stmt(
      'SELECT plan_hash FROM plan_snapshots WHERE ticker = ? ORDER BY id DESC LIMIT 1',
    ).get(ticker) as { plan_hash: string } | undefined;
    if (latest?.plan_hash === planHash) return false;
    return (
      this.stmt(
        'INSERT INTO plan_snapshots (ticker, plan_hash, plan_json, completeness_json, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(ticker, planHash, JSON.stringify(plan), JSON.stringify(completeness), iso(now))
        .changes > 0
    );
  }

  latest(ticker: string): PlanSnapshot | undefined {
    const r = this.stmt(
      'SELECT * FROM plan_snapshots WHERE ticker = ? ORDER BY id DESC LIMIT 1',
    ).get(ticker) as
      | {
          id: number;
          ticker: string;
          plan_hash: string;
          plan_json: string;
          completeness_json: string;
          created_at: string;
        }
      | undefined;
    return r === undefined
      ? undefined
      : {
          id: r.id,
          ticker: r.ticker,
          planHash: r.plan_hash,
          plan: parseJson<unknown>(r.plan_json, null),
          completeness: parseJson<unknown>(r.completeness_json, null),
          createdAt: r.created_at,
        };
  }
}

export interface PositionSnapshot {
  ticker: string;
  tsMs: number;
  quantity: number;
  averageCost: number | null;
  marketValue: number | null;
  dayPnl: number | null;
  unrealizedPnl: number | null;
  /** Extra vendor-neutral fields. */
  extra: Record<string, unknown>;
}

/** Read-only position snapshots from the broker (never contains account numbers). */
export class PositionsRepo extends Repo {
  insert(p: PositionSnapshot, now: Date): void {
    this.stmt(
      `INSERT INTO positions_snapshots (ticker, ts_epoch_ms, quantity, average_cost, market_value, day_pnl,
         unrealized_pnl, json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.ticker,
      p.tsMs,
      p.quantity,
      p.averageCost,
      p.marketValue,
      p.dayPnl,
      p.unrealizedPnl,
      JSON.stringify(p.extra),
      iso(now),
    );
  }

  private map(r: {
    ticker: string;
    ts_epoch_ms: number;
    quantity: number;
    average_cost: number | null;
    market_value: number | null;
    day_pnl: number | null;
    unrealized_pnl: number | null;
    json: string;
  }): PositionSnapshot {
    return {
      ticker: r.ticker,
      tsMs: r.ts_epoch_ms,
      quantity: r.quantity,
      averageCost: r.average_cost,
      marketValue: r.market_value,
      dayPnl: r.day_pnl,
      unrealizedPnl: r.unrealized_pnl,
      extra: parseJson<Record<string, unknown>>(r.json, {}),
    };
  }

  latest(ticker: string): PositionSnapshot | undefined {
    const r = this.stmt(
      'SELECT * FROM positions_snapshots WHERE ticker = ? ORDER BY ts_epoch_ms DESC, id DESC LIMIT 1',
    ).get(ticker) as Parameters<PositionsRepo['map']>[0] | undefined;
    return r === undefined ? undefined : this.map(r);
  }

  /** Newest first. */
  history(ticker: string, limit = 50): PositionSnapshot[] {
    return (
      this.stmt(
        'SELECT * FROM positions_snapshots WHERE ticker = ? ORDER BY ts_epoch_ms DESC, id DESC LIMIT ?',
      ).all(ticker, limit) as Parameters<PositionsRepo['map']>[0][]
    ).map((r) => this.map(r));
  }
}

export interface ScorecardRow {
  ticker: string;
  period: string;
  accession: string | null;
  json: unknown;
  leadLine: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Earnings scorecards, one per (ticker, fiscal period). */
export class ScorecardsRepo extends Repo {
  upsert(
    ticker: string,
    period: string,
    accession: string | null,
    json: unknown,
    leadLine: string | null,
    now: Date,
  ): void {
    this.stmt(
      `INSERT INTO scorecards (ticker, period, accession, json, lead_line, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (ticker, period) DO UPDATE SET accession = excluded.accession, json = excluded.json,
         lead_line = excluded.lead_line, updated_at = excluded.updated_at`,
    ).run(ticker, period, accession, JSON.stringify(json), leadLine, iso(now), iso(now));
  }

  private map(r: {
    ticker: string;
    period: string;
    accession: string | null;
    json: string;
    lead_line: string | null;
    created_at: string;
    updated_at: string;
  }): ScorecardRow {
    return {
      ticker: r.ticker,
      period: r.period,
      accession: r.accession,
      json: parseJson<unknown>(r.json, null),
      leadLine: r.lead_line,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  get(ticker: string, period: string): ScorecardRow | undefined {
    const r = this.stmt('SELECT * FROM scorecards WHERE ticker = ? AND period = ?').get(
      ticker,
      period,
    ) as Parameters<ScorecardsRepo['map']>[0] | undefined;
    return r === undefined ? undefined : this.map(r);
  }

  /** Most recently updated scorecard for a ticker. */
  latest(ticker: string): ScorecardRow | undefined {
    const r = this.stmt(
      'SELECT * FROM scorecards WHERE ticker = ? ORDER BY updated_at DESC LIMIT 1',
    ).get(ticker) as Parameters<ScorecardsRepo['map']>[0] | undefined;
    return r === undefined ? undefined : this.map(r);
  }

  list(ticker: string): ScorecardRow[] {
    return (
      this.stmt('SELECT * FROM scorecards WHERE ticker = ? ORDER BY updated_at DESC').all(
        ticker,
      ) as Parameters<ScorecardsRepo['map']>[0][]
    ).map((r) => this.map(r));
  }
}

export interface GuidanceRecord {
  ticker: string;
  /** Fiscal period the guidance covers, e.g. `FY2026`. */
  period: string;
  /** `revenue` | `pretax_income` | `eps` | ... */
  metric: string;
  low: number | null;
  high: number | null;
  unit: string;
  sourceAccession: string;
  /** When this guidance was issued (filing acceptance time); an ISO instant WITH an offset, stored as UTC `...Z`. */
  asOf: string;
}

/** Guidance ranges over time: the baseline for the deterministic "Guide raised / held / cut" lead line. */
export class GuidanceRepo extends Repo {
  /** Insert unless (ticker, period, metric, accession) exists. Returns true when inserted. */
  insertIgnore(g: GuidanceRecord, now: Date): boolean {
    return (
      this.stmt(
        `INSERT INTO guidance_history (ticker, period, metric, low, high, unit, source_accession, as_of, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).run(
        g.ticker,
        g.period,
        g.metric,
        g.low,
        g.high,
        g.unit,
        g.sourceAccession,
        normalizeInstant(g.asOf, 'guidance asOf'),
        iso(now),
      ).changes > 0
    );
  }

  private map(r: {
    ticker: string;
    period: string;
    metric: string;
    low: number | null;
    high: number | null;
    unit: string;
    source_accession: string;
    as_of: string;
  }): GuidanceRecord {
    return {
      ticker: r.ticker,
      period: r.period,
      metric: r.metric,
      low: r.low,
      high: r.high,
      unit: r.unit,
      sourceAccession: r.source_accession,
      asOf: r.as_of,
    };
  }

  /** The most recent guidance for (ticker, period, metric) issued strictly before `beforeAsOf` (default: latest). */
  latest(
    ticker: string,
    period: string,
    metric: string,
    beforeAsOf?: string,
  ): GuidanceRecord | undefined {
    const r = (
      beforeAsOf === undefined
        ? this.stmt(
            'SELECT * FROM guidance_history WHERE ticker = ? AND period = ? AND metric = ? ORDER BY as_of DESC, id DESC LIMIT 1',
          ).get(ticker, period, metric)
        : this.stmt(
            'SELECT * FROM guidance_history WHERE ticker = ? AND period = ? AND metric = ? AND as_of < ? ORDER BY as_of DESC, id DESC LIMIT 1',
          ).get(ticker, period, metric, normalizeInstant(beforeAsOf, 'beforeAsOf'))
    ) as Parameters<GuidanceRepo['map']>[0] | undefined;
    return r === undefined ? undefined : this.map(r);
  }

  /** Full history for a metric, oldest first. */
  history(ticker: string, metric: string, period?: string): GuidanceRecord[] {
    const rows = (
      period === undefined
        ? this.stmt(
            'SELECT * FROM guidance_history WHERE ticker = ? AND metric = ? ORDER BY as_of ASC, id ASC',
          ).all(ticker, metric)
        : this.stmt(
            'SELECT * FROM guidance_history WHERE ticker = ? AND metric = ? AND period = ? ORDER BY as_of ASC, id ASC',
          ).all(ticker, metric, period)
    ) as Parameters<GuidanceRepo['map']>[0][];
    return rows.map((r) => this.map(r));
  }
}
