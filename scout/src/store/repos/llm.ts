import { Repo, iso, toBool, toInt } from './common.js';

export type LlmTier = 'triage' | 'synth' | 'deep';

/** One logged model call (tokens and dollars per job: spec section 7). */
export interface LlmCallRecord {
  ts: Date;
  /** Owner-local (America/Chicago) calendar date, used for the daily cap. */
  day: string;
  /** Job/purpose label, e.g. `triage`, `brief_close`, `earnings_scorecard`. */
  job: string;
  model: string;
  tier: LlmTier;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  batch: boolean;
  stopReason: string | null;
  eventId: string | null;
  ticker: string | null;
  latencyMs: number | null;
  requestId: string | null;
  ok: boolean;
  error: string | null;
}

export interface LlmUsageSummary {
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** cache_read / (input + cache_read + cache_write), or null with no input tokens. */
  cacheHitRate: number | null;
  byJob: { job: string; calls: number; costUsd: number }[];
  byModel: { model: string; calls: number; costUsd: number }[];
}

/** `llm_calls`: every call logs tokens and dollars. Spend queries drive the daily/monthly caps. */
export class LlmCallsRepo extends Repo {
  insert(c: LlmCallRecord): void {
    this.stmt(
      `INSERT INTO llm_calls (ts_iso, ts_epoch_ms, day, job, model, tier, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd, batch, stop_reason, event_id, ticker, latency_ms,
         request_id, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      iso(c.ts),
      c.ts.getTime(),
      c.day,
      c.job,
      c.model,
      c.tier,
      c.inputTokens,
      c.outputTokens,
      c.cacheReadTokens,
      c.cacheWriteTokens,
      c.costUsd,
      toInt(c.batch),
      c.stopReason,
      c.eventId,
      c.ticker,
      c.latencyMs,
      c.requestId,
      toInt(c.ok),
      c.error,
    );
  }

  /** Total USD spent on owner-local `day` (`YYYY-MM-DD`). */
  spendForDay(day: string): number {
    return (
      this.stmt('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM llm_calls WHERE day = ?').get(day) as {
        s: number;
      }
    ).s;
  }

  /** Total USD spent in owner-local month `YYYY-MM`. */
  spendForMonth(month: string): number {
    return (
      this.stmt(
        'SELECT COALESCE(SUM(cost_usd), 0) AS s FROM llm_calls WHERE substr(day, 1, 7) = ?',
      ).get(month) as { s: number }
    ).s;
  }

  /** Usage summary for a day (`YYYY-MM-DD`) or month (`YYYY-MM`). */
  summary(period: string): LlmUsageSummary {
    const pred = period.length === 7 ? 'substr(day, 1, 7) = ?' : 'day = ?';
    const t = this.db
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(input_tokens),0) AS i,
           COALESCE(SUM(output_tokens),0) AS o, COALESCE(SUM(cache_read_tokens),0) AS cr,
           COALESCE(SUM(cache_write_tokens),0) AS cw FROM llm_calls WHERE ${pred}`,
      )
      .get(period) as { calls: number; cost: number; i: number; o: number; cr: number; cw: number };
    const byJob = this.db
      .prepare(
        `SELECT job, COUNT(*) AS calls, SUM(cost_usd) AS cost FROM llm_calls WHERE ${pred} GROUP BY job ORDER BY cost DESC`,
      )
      .all(period) as { job: string; calls: number; cost: number }[];
    const byModel = this.db
      .prepare(
        `SELECT model, COUNT(*) AS calls, SUM(cost_usd) AS cost FROM llm_calls WHERE ${pred} GROUP BY model ORDER BY cost DESC`,
      )
      .all(period) as { model: string; calls: number; cost: number }[];
    const denom = t.i + t.cr + t.cw;
    return {
      calls: t.calls,
      costUsd: t.cost,
      inputTokens: t.i,
      outputTokens: t.o,
      cacheReadTokens: t.cr,
      cacheWriteTokens: t.cw,
      cacheHitRate: denom > 0 ? t.cr / denom : null,
      byJob: byJob.map((r) => ({ job: r.job, calls: r.calls, costUsd: r.cost })),
      byModel: byModel.map((r) => ({ model: r.model, calls: r.calls, costUsd: r.cost })),
    };
  }

  /** Newest first. */
  recent(limit = 50): (LlmCallRecord & { id: number })[] {
    return (
      this.stmt('SELECT * FROM llm_calls ORDER BY ts_epoch_ms DESC, id DESC LIMIT ?').all(
        limit,
      ) as {
        id: number;
        ts_epoch_ms: number;
        day: string;
        job: string;
        model: string;
        tier: LlmTier;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
        cost_usd: number;
        batch: number;
        stop_reason: string | null;
        event_id: string | null;
        ticker: string | null;
        latency_ms: number | null;
        request_id: string | null;
        ok: number;
        error: string | null;
      }[]
    ).map((r) => ({
      id: r.id,
      ts: new Date(r.ts_epoch_ms),
      day: r.day,
      job: r.job,
      model: r.model,
      tier: r.tier,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      costUsd: r.cost_usd,
      batch: toBool(r.batch),
      stopReason: r.stop_reason,
      eventId: r.event_id,
      ticker: r.ticker,
      latencyMs: r.latency_ms,
      requestId: r.request_id,
      ok: toBool(r.ok),
      error: r.error,
    }));
  }
}

export interface FactSheet {
  ticker: string;
  text: string;
  builtFromAccession: string | null;
  estTokens: number | null;
  builtAt: string;
}

/** Cached per-ticker fact sheet (part of the stable cached prefix; regenerated only after filings). */
export class FactSheetsRepo extends Repo {
  get(ticker: string): FactSheet | undefined {
    const r = this.stmt('SELECT * FROM fact_sheets WHERE ticker = ?').get(ticker) as
      | {
          ticker: string;
          text: string;
          built_from_accession: string | null;
          est_tokens: number | null;
          built_at: string;
        }
      | undefined;
    return r === undefined
      ? undefined
      : {
          ticker: r.ticker,
          text: r.text,
          builtFromAccession: r.built_from_accession,
          estTokens: r.est_tokens,
          builtAt: r.built_at,
        };
  }

  put(
    ticker: string,
    text: string,
    builtFromAccession: string | null,
    estTokens: number | null,
    now: Date,
  ): void {
    this.stmt(
      `INSERT INTO fact_sheets (ticker, text, built_from_accession, est_tokens, built_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (ticker) DO UPDATE SET text = excluded.text, built_from_accession = excluded.built_from_accession,
         est_tokens = excluded.est_tokens, built_at = excluded.built_at`,
    ).run(ticker, text, builtFromAccession, estTokens, iso(now));
  }
}
