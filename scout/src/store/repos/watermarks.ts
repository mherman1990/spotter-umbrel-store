import { Repo, iso } from './common.js';

export interface Watermark {
  source: string;
  ticker: string;
  cursor: string;
  updatedAt: string;
}

/**
 * Per (source, ticker) cursor. The orchestrator advances it ONLY after the source's events are durably
 * inserted and queued for triage (decision D10), preferably inside the same transaction
 * (`Store.commitPoll`). Never call `set` from an adapter.
 */
export class WatermarksRepo extends Repo {
  get(source: string, ticker: string): Watermark | undefined {
    const r = this.stmt(
      'SELECT source, ticker, cursor, updated_at FROM watermarks WHERE source = ? AND ticker = ?',
    ).get(source, ticker) as
      { source: string; ticker: string; cursor: string; updated_at: string } | undefined;
    return r === undefined
      ? undefined
      : { source: r.source, ticker: r.ticker, cursor: r.cursor, updatedAt: r.updated_at };
  }

  set(source: string, ticker: string, cursor: string, now: Date): void {
    this.stmt(
      `INSERT INTO watermarks (source, ticker, cursor, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (source, ticker) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
    ).run(source, ticker, cursor, iso(now));
  }

  all(): Watermark[] {
    return (
      this.stmt(
        'SELECT source, ticker, cursor, updated_at FROM watermarks ORDER BY source, ticker',
      ).all() as {
        source: string;
        ticker: string;
        cursor: string;
        updated_at: string;
      }[]
    ).map((r) => ({
      source: r.source,
      ticker: r.ticker,
      cursor: r.cursor,
      updatedAt: r.updated_at,
    }));
  }

  delete(source: string, ticker: string): void {
    this.stmt('DELETE FROM watermarks WHERE source = ? AND ticker = ?').run(source, ticker);
  }
}
