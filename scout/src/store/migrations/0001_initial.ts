import type { Migration } from '../migrate.js';

/**
 * 0001 - the COMPLETE initial schema. It deliberately creates every table any wave-1 module needs so
 * parallel agents never write conflicting migrations. NEVER EDIT once shipped (checksum tripwire); add
 * 0002_... instead.
 *
 * Conventions:
 *  - Timestamps are ISO-8601 UTC strings with milliseconds (`2026-12-03T14:00:00.000Z`): lexicographic order
 *    equals chronological order. Event `ts_iso` is the exchange-offset ISO string; `ts_epoch_ms` is the same
 *    instant for range queries.
 *  - "day" columns are America/Chicago (owner) calendar dates `YYYY-MM-DD`; trading dates are America/New_York.
 *  - Booleans are INTEGER 0/1. JSON is TEXT. Money in USD REAL; shares INTEGER/REAL.
 *  - Raw payload columns (`payload_json`, `raw_json`, `chain_json`) are pruned after the retention window;
 *    aggregates and decisions are kept forever.
 *  - Every stored timestamp is UTC `...Z` with milliseconds (repos normalize at the boundary), so string order
 *    equals chronological order across DST.
 *  - Inserts that must be idempotent use `ON CONFLICT DO NOTHING` (uniqueness conflicts only), NEVER
 *    `INSERT OR IGNORE`: the latter also swallows CHECK/NOT NULL violations, which would lose an event and
 *    still advance the cursor.
 *
 * This file was amended BEFORE it shipped (foundation review): partial unique index on `api_tokens` (token
 * rotation), no unique plan hash (A -> B -> A), `digest_kind` CHECK, `push_events`. The checksum pin in
 * `migrate.test.ts` was re-pinned in the same change; after the first release it is frozen.
 */
const sql = `
-- ---------------------------------------------------------------------------------------------
-- Events and delivery
-- ---------------------------------------------------------------------------------------------
CREATE TABLE events (
  id              TEXT PRIMARY KEY,
  ticker          TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('quote','filing','short','news','macro','inbox','options')),
  kind            TEXT NOT NULL,
  ts_iso          TEXT NOT NULL,
  ts_epoch_ms     INTEGER NOT NULL,
  payload_json    TEXT NOT NULL,
  payload_pruned  INTEGER NOT NULL DEFAULT 0 CHECK (payload_pruned IN (0,1)),
  url             TEXT,
  rule_priority   TEXT CHECK (rule_priority IN ('P1','P2','P3')),
  final_priority  TEXT CHECK (final_priority IN ('P1','P2','P3')),
  status          TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','triaged','queued','pushed','digested','dropped','folded')),
  status_reason   TEXT,
  triage_json     TEXT,
  digest_kind     TEXT CHECK (digest_kind IS NULL OR digest_kind IN ('premarket','midday','close')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_events_status        ON events (status, created_at);
CREATE INDEX idx_events_ticker_ts     ON events (ticker, ts_epoch_ms);
CREATE INDEX idx_events_source_ts     ON events (source, ticker, ts_epoch_ms);
CREATE INDEX idx_events_prio_status   ON events (final_priority, status, created_at);
CREATE INDEX idx_events_digest        ON events (digest_kind, status);
CREATE INDEX idx_events_created       ON events (created_at);

-- Secondary -> primary links for semantic near-duplicates, clusters and P1-cap overflow.
CREATE TABLE event_links (
  secondary_id TEXT PRIMARY KEY REFERENCES events (id) ON DELETE CASCADE,
  primary_id   TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  relation     TEXT NOT NULL CHECK (relation IN ('duplicate','rewrite','cluster','overflow')),
  score        REAL,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_event_links_primary ON event_links (primary_id);

-- Notification outbox. A push is retried/fell back from here; an event is never retired by a send failure.
CREATE TABLE pushes (
  id               TEXT PRIMARY KEY,
  event_ids_json   TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('alert','digest','brief','ops')),
  priority         TEXT NOT NULL CHECK (priority IN ('P1','P2','P3')),
  ticker           TEXT NOT NULL,
  headline         TEXT NOT NULL,
  so_what          TEXT,
  body_json        TEXT NOT NULL,
  channel          TEXT,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','folded')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       TEXT NOT NULL,
  sent_at          TEXT,
  next_attempt_at  TEXT,
  idempotency_key  TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_pushes_due     ON pushes (status, next_attempt_at);

-- Which push(es) covered which event ("was this 8-K pushed?"), queryable without parsing event_ids_json.
CREATE TABLE push_events (
  push_id   TEXT NOT NULL REFERENCES pushes (id) ON DELETE CASCADE,
  event_id  TEXT NOT NULL,
  PRIMARY KEY (push_id, event_id)
);
CREATE INDEX idx_push_events_event ON push_events (event_id);
CREATE INDEX idx_pushes_created ON pushes (created_at);
CREATE INDEX idx_pushes_sent    ON pushes (sent_at);

-- Source cursor, advanced ONLY after the source's events are durably inserted (decision D10).
CREATE TABLE watermarks (
  source      TEXT NOT NULL,
  ticker      TEXT NOT NULL,
  cursor      TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (source, ticker)
);

-- ---------------------------------------------------------------------------------------------
-- SEC filings
-- ---------------------------------------------------------------------------------------------
CREATE TABLE filings (
  accession               TEXT PRIMARY KEY,
  ticker                  TEXT NOT NULL,
  cik                     TEXT NOT NULL,
  form                    TEXT NOT NULL,
  items                   TEXT NOT NULL DEFAULT '',
  filing_date             TEXT NOT NULL,
  report_date             TEXT,
  accepted_at             TEXT NOT NULL,
  primary_document        TEXT,
  primary_doc_description TEXT,
  index_url               TEXT NOT NULL,
  document_url            TEXT,
  is_inline_xbrl          INTEGER NOT NULL DEFAULT 0,
  raw_json                TEXT,
  created_at              TEXT NOT NULL
);
CREATE INDEX idx_filings_ticker_form ON filings (ticker, form, accepted_at);
CREATE INDEX idx_filings_ticker_acc  ON filings (ticker, accepted_at);

CREATE TABLE form4_rows (
  accession           TEXT NOT NULL,
  row_index           INTEGER NOT NULL,
  ticker              TEXT NOT NULL,
  issuer_cik          TEXT NOT NULL,
  owner_name          TEXT NOT NULL,
  owner_cik           TEXT NOT NULL,
  is_officer          INTEGER NOT NULL DEFAULT 0,
  is_director         INTEGER NOT NULL DEFAULT 0,
  is_ten_percent_owner INTEGER NOT NULL DEFAULT 0,
  officer_title       TEXT,
  table_type          TEXT NOT NULL CHECK (table_type IN ('non_derivative','derivative')),
  transaction_date    TEXT NOT NULL,
  transaction_code    TEXT NOT NULL,
  shares              REAL NOT NULL,
  price_per_share     REAL,
  usd_value           REAL,
  acquired_disposed   TEXT NOT NULL CHECK (acquired_disposed IN ('A','D')),
  shares_owned_after  REAL,
  ownership           TEXT,
  is_10b5_1           INTEGER,
  raw_json            TEXT,
  created_at          TEXT NOT NULL,
  PRIMARY KEY (accession, row_index)
);
CREATE INDEX idx_form4_ticker_date ON form4_rows (ticker, transaction_date);

CREATE TABLE schedule13_filings (
  accession        TEXT PRIMARY KEY,
  ticker           TEXT NOT NULL,
  form             TEXT NOT NULL,
  is_amendment     INTEGER NOT NULL DEFAULT 0,
  filer_name       TEXT,
  filer_cik        TEXT,
  percent_of_class REAL,
  shares           REAL,
  filed_at         TEXT NOT NULL,
  url              TEXT,
  raw_json         TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_s13_ticker ON schedule13_filings (ticker, filed_at);

CREATE TABLE holdings_13f (
  filer_cik   TEXT NOT NULL,
  period      TEXT NOT NULL,
  cusip       TEXT NOT NULL,
  ticker      TEXT NOT NULL,
  filer_name  TEXT NOT NULL,
  shares      REAL NOT NULL,
  value_usd   REAL,
  put_call    TEXT,
  accession   TEXT NOT NULL,
  filed_at    TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (filer_cik, period, cusip)
);
CREATE INDEX idx_13f_ticker ON holdings_13f (ticker, period);

-- ---------------------------------------------------------------------------------------------
-- Market data
-- ---------------------------------------------------------------------------------------------
CREATE TABLE quotes_daily (
  ticker      TEXT NOT NULL,
  date        TEXT NOT NULL,
  open        REAL NOT NULL,
  high        REAL NOT NULL,
  low         REAL NOT NULL,
  close       REAL NOT NULL,
  volume      REAL NOT NULL,
  atr20       REAL,
  source      TEXT NOT NULL DEFAULT 'unknown',
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (ticker, date)
);

-- Learned time-of-day cumulative volume profile: fraction of the day's volume done by minute-of-session.
CREATE TABLE intraday_profile (
  ticker           TEXT NOT NULL,
  minute_of_session INTEGER NOT NULL CHECK (minute_of_session >= 0),
  cum_fraction     REAL NOT NULL CHECK (cum_fraction >= 0 AND cum_fraction <= 1.0000001),
  sample_days      INTEGER NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (ticker, minute_of_session)
);

CREATE TABLE intraday_bars (
  ticker            TEXT NOT NULL,
  start_ms          INTEGER NOT NULL,
  interval_minutes  INTEGER NOT NULL,
  open              REAL NOT NULL,
  high              REAL NOT NULL,
  low               REAL NOT NULL,
  close             REAL NOT NULL,
  volume            REAL NOT NULL,
  PRIMARY KEY (ticker, start_ms, interval_minutes)
);

CREATE TABLE short_interest (
  symbol                   TEXT NOT NULL,
  settlement_date          TEXT NOT NULL,
  published_date           TEXT,
  short_interest           REAL NOT NULL,
  previous_short_interest  REAL,
  avg_daily_volume         REAL,
  days_to_cover            REAL,
  change_pct               REAL,
  created_at               TEXT NOT NULL,
  PRIMARY KEY (symbol, settlement_date)
);

CREATE TABLE reg_sho_daily (
  symbol               TEXT NOT NULL,
  trade_date           TEXT NOT NULL,
  market               TEXT NOT NULL,
  short_volume         REAL NOT NULL,
  short_exempt_volume  REAL NOT NULL,
  total_volume         REAL NOT NULL,
  created_at           TEXT NOT NULL,
  PRIMARY KEY (symbol, trade_date, market)
);

CREATE TABLE options_snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker            TEXT NOT NULL,
  ts_epoch_ms       INTEGER NOT NULL,
  date              TEXT NOT NULL,
  underlying_price  REAL,
  iv30_pct          REAL,
  summary_json      TEXT NOT NULL DEFAULT '{}',
  chain_json        TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE (ticker, ts_epoch_ms)
);
CREATE INDEX idx_options_ticker_date ON options_snapshots (ticker, date, ts_epoch_ms);

CREATE TABLE macro_observations (
  series_id         TEXT NOT NULL,
  observation_date  TEXT NOT NULL,
  title             TEXT,
  value             REAL,
  units             TEXT,
  fetched_at        TEXT NOT NULL,
  PRIMARY KEY (series_id, observation_date)
);

-- Last processed IMAP UID per mailbox (UID > last, never "since day": decision D27).
CREATE TABLE newsletter_state (
  mailbox       TEXT PRIMARY KEY,
  uid_validity  INTEGER,
  last_uid      INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------------------------------------
-- LLM
-- ---------------------------------------------------------------------------------------------
CREATE TABLE llm_calls (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_iso             TEXT NOT NULL,
  ts_epoch_ms        INTEGER NOT NULL,
  day                TEXT NOT NULL,
  job                TEXT NOT NULL,
  model              TEXT NOT NULL,
  tier               TEXT NOT NULL CHECK (tier IN ('triage','synth','deep')),
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL NOT NULL DEFAULT 0,
  batch              INTEGER NOT NULL DEFAULT 0 CHECK (batch IN (0,1)),
  stop_reason        TEXT,
  event_id           TEXT,
  ticker             TEXT,
  latency_ms         INTEGER,
  request_id         TEXT,
  ok                 INTEGER NOT NULL DEFAULT 1 CHECK (ok IN (0,1)),
  error              TEXT
);
CREATE INDEX idx_llm_day  ON llm_calls (day);
CREATE INDEX idx_llm_job  ON llm_calls (job, day);

-- Cached per-ticker fact sheet (regenerated only after filings).
CREATE TABLE fact_sheets (
  ticker                TEXT PRIMARY KEY,
  text                  TEXT NOT NULL,
  built_from_accession  TEXT,
  est_tokens            INTEGER,
  built_at              TEXT NOT NULL
);

-- ---------------------------------------------------------------------------------------------
-- Position plan, positions, earnings
-- ---------------------------------------------------------------------------------------------
CREATE TABLE plan_snapshots (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker             TEXT NOT NULL,
  plan_hash          TEXT NOT NULL,
  plan_json          TEXT NOT NULL,
  completeness_json  TEXT NOT NULL,
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_plan_snapshots_ticker ON plan_snapshots (ticker, id);

CREATE TABLE positions_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker          TEXT NOT NULL,
  ts_epoch_ms     INTEGER NOT NULL,
  quantity        REAL NOT NULL,
  average_cost    REAL,
  market_value    REAL,
  day_pnl         REAL,
  unrealized_pnl  REAL,
  json            TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_positions_ticker ON positions_snapshots (ticker, ts_epoch_ms);

CREATE TABLE scorecards (
  ticker      TEXT NOT NULL,
  period      TEXT NOT NULL,
  accession   TEXT,
  json        TEXT NOT NULL,
  lead_line   TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (ticker, period)
);

CREATE TABLE guidance_history (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker            TEXT NOT NULL,
  period            TEXT NOT NULL,
  metric            TEXT NOT NULL,
  low               REAL,
  high              REAL,
  unit              TEXT NOT NULL DEFAULT 'usd_millions',
  source_accession  TEXT NOT NULL,
  as_of             TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  UNIQUE (ticker, period, metric, source_accession)
);
CREATE INDEX idx_guidance_lookup ON guidance_history (ticker, period, metric, as_of);

-- ---------------------------------------------------------------------------------------------
-- Operational state
-- ---------------------------------------------------------------------------------------------
-- Schwab OAuth state. encrypted_blob = AES-256-GCM(nonce||tag||ciphertext) of the token JSON; the key file is
-- separate (mode 0600, never backed up). Refresh tokens are valid 7 days FIXED from issue (decision D12).
CREATE TABLE token_state (
  id                       TEXT PRIMARY KEY,
  encrypted_blob           BLOB,
  refresh_token_issued_at  TEXT,
  access_expires_at        TEXT,
  sent_24h                 INTEGER NOT NULL DEFAULT 0,
  sent_6h                  INTEGER NOT NULL DEFAULT 0,
  sent_expired             INTEGER NOT NULL DEFAULT 0,
  last_refresh_ok_at       TEXT,
  last_error               TEXT,
  quotes_down_alerted_at   TEXT,
  updated_at               TEXT NOT NULL
);

CREATE TABLE health_state (
  component             TEXT PRIMARY KEY,
  status                TEXT NOT NULL CHECK (status IN ('ok','degraded','down','unknown')),
  since                 TEXT NOT NULL,
  last_ok               TEXT,
  last_alert_at         TEXT,
  last_recovery_alert_at TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  detail                TEXT,
  updated_at            TEXT NOT NULL
);

-- Cooldown / suppression keys (health alerts, outage-once logging, quotes-down-once...).
CREATE TABLE alert_state (
  key           TEXT PRIMARY KEY,
  last_sent_at  TEXT,
  count         INTEGER NOT NULL DEFAULT 0,
  window_start  TEXT,
  meta_json     TEXT
);

CREATE TABLE api_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client        TEXT NOT NULL,
  token_sha256  TEXT NOT NULL UNIQUE,
  scopes_json   TEXT NOT NULL DEFAULT '["read"]',
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  revoked_at    TEXT
);
-- One ACTIVE token per client; revoked rows keep the name so revoke-then-create (rotation) works.
CREATE UNIQUE INDEX uq_api_tokens_active_client ON api_tokens (client) WHERE revoked_at IS NULL;

CREATE TABLE jobs_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job          TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','error','skipped')),
  error        TEXT,
  detail_json  TEXT
);
CREATE INDEX idx_jobs_job ON jobs_runs (job, started_at);

-- Per-owner-day counters (P1 pushes, folded P1s, ...). (date, name) -> value.
CREATE TABLE daily_counters (
  date   TEXT NOT NULL,
  name   TEXT NOT NULL,
  value  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, name)
);

-- Small JSON key/value store for misc flags (earnings-mode state, outage windows...).
CREATE TABLE kv_state (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`;

export const m0001: Migration = {
  id: '0001_initial',
  description: 'Complete initial schema for all Scout modules',
  sql,
};
