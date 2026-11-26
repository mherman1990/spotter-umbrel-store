/**
 * Retention (spec section 9, decision D31): raw payloads are pruned after N days (default 90); aggregates and
 * decisions are kept indefinitely. Pruning BLANKS raw columns (events keep id/kind/ts/priority/status/triage;
 * filings, Form 4 and Schedule 13 rows keep their parsed columns; option snapshots keep IV30 and the summary)
 * and deletes only genuinely disposable history (intraday bars, old job runs).
 */
import type { Db } from './db.js';

export interface RetentionPolicy {
  rawPayloadDays: number;
  jobRunsDays: number;
  intradayBarsDays: number;
}

export interface RetentionResult {
  cutoffIso: string;
  eventPayloadsPruned: number;
  filingRawPruned: number;
  form4RawPruned: number;
  schedule13RawPruned: number;
  optionChainsPruned: number;
  intradayBarsDeleted: number;
  jobRunsDeleted: number;
}

const DAY_MS = 86_400_000;

/**
 * Apply the retention policy as of `now`. Idempotent. Runs in one transaction. Never touches events that are
 * still unjudged (`new`) or awaiting digest (`queued`): pruning an unprocessed payload would lose work.
 */
export function pruneRetention(db: Db, policy: RetentionPolicy, now: Date): RetentionResult {
  const rawCutoffMs = now.getTime() - policy.rawPayloadDays * DAY_MS;
  const rawCutoffIso = new Date(rawCutoffMs).toISOString();
  const rawCutoffDate = rawCutoffIso.slice(0, 10);
  const intradayCutoffMs = now.getTime() - policy.intradayBarsDays * DAY_MS;
  const jobsCutoffIso = new Date(now.getTime() - policy.jobRunsDays * DAY_MS).toISOString();

  return db.transaction((): RetentionResult => {
    const events = db
      .prepare(
        `UPDATE events SET payload_json = '{}', payload_pruned = 1, updated_at = ?
         WHERE payload_pruned = 0 AND ts_epoch_ms < ? AND status NOT IN ('new','queued')`,
      )
      .run(now.toISOString(), rawCutoffMs).changes;
    const filings = db
      .prepare('UPDATE filings SET raw_json = NULL WHERE raw_json IS NOT NULL AND filing_date < ?')
      .run(rawCutoffDate).changes;
    const form4 = db
      .prepare(
        'UPDATE form4_rows SET raw_json = NULL WHERE raw_json IS NOT NULL AND transaction_date < ?',
      )
      .run(rawCutoffDate).changes;
    const s13 = db
      .prepare(
        'UPDATE schedule13_filings SET raw_json = NULL WHERE raw_json IS NOT NULL AND filed_at < ?',
      )
      .run(rawCutoffIso).changes;
    const chains = db
      .prepare(
        'UPDATE options_snapshots SET chain_json = NULL WHERE chain_json IS NOT NULL AND ts_epoch_ms < ?',
      )
      .run(rawCutoffMs).changes;
    const bars = db
      .prepare('DELETE FROM intraday_bars WHERE start_ms < ?')
      .run(intradayCutoffMs).changes;
    const jobs = db
      .prepare("DELETE FROM jobs_runs WHERE started_at < ? AND status != 'running'")
      .run(jobsCutoffIso).changes;
    return {
      cutoffIso: rawCutoffIso,
      eventPayloadsPruned: events,
      filingRawPruned: filings,
      form4RawPruned: form4,
      schedule13RawPruned: s13,
      optionChainsPruned: chains,
      intradayBarsDeleted: bars,
      jobRunsDeleted: jobs,
    };
  })();
}
