import type {
  FilingRecord,
  Form4RowRecord,
  Holding13fRecord,
  Schedule13Record,
} from '../../types.js';
import {
  Repo,
  boolOrNullToInt,
  iso,
  normalizeInstant,
  parseJson,
  placeholders,
  toBool,
  toBoolOrNull,
  toInt,
} from './common.js';

interface FilingRow {
  accession: string;
  ticker: string;
  cik: string;
  form: string;
  items: string;
  filing_date: string;
  report_date: string | null;
  accepted_at: string;
  primary_document: string | null;
  primary_doc_description: string | null;
  index_url: string;
  document_url: string | null;
  is_inline_xbrl: number;
  raw_json: string | null;
}

function toFiling(r: FilingRow): FilingRecord {
  return {
    accession: r.accession,
    ticker: r.ticker,
    cik: r.cik,
    form: r.form,
    items: r.items === '' ? [] : r.items.split(','),
    filingDate: r.filing_date,
    reportDate: r.report_date,
    acceptedAt: r.accepted_at,
    primaryDocument: r.primary_document,
    primaryDocDescription: r.primary_doc_description,
    indexUrl: r.index_url,
    documentUrl: r.document_url,
    isInlineXbrl: toBool(r.is_inline_xbrl),
    raw: parseJson<Record<string, unknown> | null>(r.raw_json, null),
  };
}

const FILING_COLS = `accession, ticker, cik, form, items, filing_date, report_date, accepted_at, primary_document,
  primary_doc_description, index_url, document_url, is_inline_xbrl, raw_json`;

/** `filings` table: one row per accession (upsert; an amendment of the metadata updates in place). */
export class FilingsRepo extends Repo {
  upsert(f: FilingRecord, now: Date): void {
    this.stmt(
      `INSERT INTO filings (accession, ticker, cik, form, items, filing_date, report_date, accepted_at,
         primary_document, primary_doc_description, index_url, document_url, is_inline_xbrl, raw_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (accession) DO UPDATE SET form = excluded.form, items = excluded.items,
         report_date = excluded.report_date, primary_document = excluded.primary_document,
         primary_doc_description = excluded.primary_doc_description, document_url = excluded.document_url,
         is_inline_xbrl = excluded.is_inline_xbrl,
         raw_json = COALESCE(excluded.raw_json, filings.raw_json)`,
    ).run(
      f.accession,
      f.ticker,
      f.cik,
      f.form,
      f.items.join(','),
      f.filingDate,
      f.reportDate,
      normalizeInstant(f.acceptedAt, 'filing acceptedAt'),
      f.primaryDocument,
      f.primaryDocDescription,
      f.indexUrl,
      f.documentUrl,
      toInt(f.isInlineXbrl),
      f.raw === null ? null : JSON.stringify(f.raw),
      iso(now),
    );
  }

  get(accession: string): FilingRecord | undefined {
    const r = this.stmt(`SELECT ${FILING_COLS} FROM filings WHERE accession = ?`).get(accession) as
      FilingRow | undefined;
    return r === undefined ? undefined : toFiling(r);
  }

  exists(accession: string): boolean {
    return this.stmt('SELECT 1 FROM filings WHERE accession = ?').get(accession) !== undefined;
  }

  /** Newest first by acceptance time. */
  recent(
    ticker: string,
    opts: { forms?: readonly string[]; sinceIso?: string; limit?: number } = {},
  ): FilingRecord[] {
    const where = ['ticker = ?'];
    const params: unknown[] = [ticker];
    if (opts.forms !== undefined && opts.forms.length > 0) {
      where.push(`form IN (${placeholders(opts.forms.length)})`);
      params.push(...opts.forms);
    }
    if (opts.sinceIso !== undefined) {
      where.push('accepted_at >= ?');
      params.push(normalizeInstant(opts.sinceIso, 'sinceIso'));
    }
    params.push(opts.limit ?? 50);
    return (
      this.db
        .prepare(
          `SELECT ${FILING_COLS} FROM filings WHERE ${where.join(' AND ')} ORDER BY accepted_at DESC LIMIT ?`,
        )
        .all(...params) as FilingRow[]
    ).map(toFiling);
  }

  latestByForm(ticker: string, form: string): FilingRecord | undefined {
    return this.recent(ticker, { forms: [form], limit: 1 })[0];
  }
}

interface Form4Row {
  accession: string;
  row_index: number;
  ticker: string;
  issuer_cik: string;
  owner_name: string;
  owner_cik: string;
  is_officer: number;
  is_director: number;
  is_ten_percent_owner: number;
  officer_title: string | null;
  table_type: 'non_derivative' | 'derivative';
  transaction_date: string;
  transaction_code: string;
  shares: number;
  price_per_share: number | null;
  usd_value: number | null;
  acquired_disposed: 'A' | 'D';
  shares_owned_after: number | null;
  ownership: 'D' | 'I' | null;
  is_10b5_1: number | null;
  raw_json: string | null;
}

function toForm4(r: Form4Row): Form4RowRecord {
  return {
    accession: r.accession,
    rowIndex: r.row_index,
    ticker: r.ticker,
    issuerCik: r.issuer_cik,
    ownerName: r.owner_name,
    ownerCik: r.owner_cik,
    isOfficer: toBool(r.is_officer),
    isDirector: toBool(r.is_director),
    isTenPercentOwner: toBool(r.is_ten_percent_owner),
    officerTitle: r.officer_title,
    tableType: r.table_type,
    transactionDate: r.transaction_date,
    transactionCode: r.transaction_code,
    shares: r.shares,
    pricePerShare: r.price_per_share,
    usdValue: r.usd_value,
    acquiredDisposed: r.acquired_disposed,
    sharesOwnedAfter: r.shares_owned_after,
    ownership: r.ownership,
    is10b5One: toBoolOrNull(r.is_10b5_1),
    raw: parseJson<Record<string, unknown> | null>(r.raw_json, null),
  };
}

/** One row per Form 4 transaction, keyed (accession, row_index). */
export class Form4Repo extends Repo {
  upsert(f: Form4RowRecord, now: Date): void {
    this.stmt(
      `INSERT INTO form4_rows (accession, row_index, ticker, issuer_cik, owner_name, owner_cik, is_officer,
         is_director, is_ten_percent_owner, officer_title, table_type, transaction_date, transaction_code, shares,
         price_per_share, usd_value, acquired_disposed, shares_owned_after, ownership, is_10b5_1, raw_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (accession, row_index) DO UPDATE SET owner_name = excluded.owner_name,
         transaction_code = excluded.transaction_code, shares = excluded.shares,
         price_per_share = excluded.price_per_share, usd_value = excluded.usd_value,
         is_10b5_1 = excluded.is_10b5_1, raw_json = COALESCE(excluded.raw_json, form4_rows.raw_json)`,
    ).run(
      f.accession,
      f.rowIndex,
      f.ticker,
      f.issuerCik,
      f.ownerName,
      f.ownerCik,
      toInt(f.isOfficer),
      toInt(f.isDirector),
      toInt(f.isTenPercentOwner),
      f.officerTitle,
      f.tableType,
      f.transactionDate,
      f.transactionCode,
      f.shares,
      f.pricePerShare,
      f.usdValue,
      f.acquiredDisposed,
      f.sharesOwnedAfter,
      f.ownership,
      boolOrNullToInt(f.is10b5One),
      f.raw === null ? null : JSON.stringify(f.raw),
      iso(now),
    );
  }

  byAccession(accession: string): Form4RowRecord[] {
    return (
      this.stmt('SELECT * FROM form4_rows WHERE accession = ? ORDER BY row_index').all(
        accession,
      ) as Form4Row[]
    ).map(toForm4);
  }

  /** Rows with `transaction_date >= sinceDate`, newest first. */
  recent(ticker: string, sinceDate: string, limit = 200): Form4RowRecord[] {
    return (
      this.stmt(
        'SELECT * FROM form4_rows WHERE ticker = ? AND transaction_date >= ? ORDER BY transaction_date DESC, accession DESC, row_index LIMIT ?',
      ).all(ticker, sinceDate, limit) as Form4Row[]
    ).map(toForm4);
  }

  /**
   * Open-market activity summary since `sinceDate` (weekly brief): purchases (code P) and sales (code S) in
   * USD and share counts, derived only from non-derivative rows.
   */
  openMarketSummary(
    ticker: string,
    sinceDate: string,
  ): { buyUsd: number; sellUsd: number; buyShares: number; sellShares: number; rows: number } {
    const r = this.stmt(
      `SELECT
         COALESCE(SUM(CASE WHEN transaction_code = 'P' THEN usd_value END), 0) AS buy_usd,
         COALESCE(SUM(CASE WHEN transaction_code = 'S' THEN usd_value END), 0) AS sell_usd,
         COALESCE(SUM(CASE WHEN transaction_code = 'P' THEN shares END), 0) AS buy_shares,
         COALESCE(SUM(CASE WHEN transaction_code = 'S' THEN shares END), 0) AS sell_shares,
         COUNT(*) AS rows
       FROM form4_rows WHERE ticker = ? AND transaction_date >= ? AND table_type = 'non_derivative'
         AND transaction_code IN ('P','S')`,
    ).get(ticker, sinceDate) as {
      buy_usd: number;
      sell_usd: number;
      buy_shares: number;
      sell_shares: number;
      rows: number;
    };
    return {
      buyUsd: r.buy_usd,
      sellUsd: r.sell_usd,
      buyShares: r.buy_shares,
      sellShares: r.sell_shares,
      rows: r.rows,
    };
  }
}

interface S13Row {
  accession: string;
  ticker: string;
  form: string;
  is_amendment: number;
  filer_name: string | null;
  filer_cik: string | null;
  percent_of_class: number | null;
  shares: number | null;
  filed_at: string;
  url: string | null;
  raw_json: string | null;
}

/** Schedule 13D/G filings. */
export class Schedule13Repo extends Repo {
  upsert(s: Schedule13Record, now: Date): void {
    this.stmt(
      `INSERT INTO schedule13_filings (accession, ticker, form, is_amendment, filer_name, filer_cik,
         percent_of_class, shares, filed_at, url, raw_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (accession) DO UPDATE SET percent_of_class = excluded.percent_of_class, shares = excluded.shares,
         filer_name = excluded.filer_name, raw_json = COALESCE(excluded.raw_json, schedule13_filings.raw_json)`,
    ).run(
      s.accession,
      s.ticker,
      s.form,
      toInt(s.isAmendment),
      s.filerName,
      s.filerCik,
      s.percentOfClass,
      s.shares,
      normalizeInstant(s.filedAt, 'schedule13 filedAt'),
      s.url,
      s.raw === null ? null : JSON.stringify(s.raw),
      iso(now),
    );
  }

  recent(ticker: string, limit = 50): Schedule13Record[] {
    return (
      this.stmt(
        'SELECT * FROM schedule13_filings WHERE ticker = ? ORDER BY filed_at DESC LIMIT ?',
      ).all(ticker, limit) as S13Row[]
    ).map((r) => ({
      accession: r.accession,
      ticker: r.ticker,
      form: r.form,
      isAmendment: toBool(r.is_amendment),
      filerName: r.filer_name,
      filerCik: r.filer_cik,
      percentOfClass: r.percent_of_class,
      shares: r.shares,
      filedAt: r.filed_at,
      url: r.url,
      raw: parseJson<Record<string, unknown> | null>(r.raw_json, null),
    }));
  }
}

interface H13Row {
  filer_cik: string;
  period: string;
  cusip: string;
  ticker: string;
  filer_name: string;
  shares: number;
  value_usd: number | null;
  put_call: string | null;
  accession: string;
  filed_at: string | null;
}

/** 13F holdings of the covered names by watched institutions (optional, low priority). */
export class Holdings13fRepo extends Repo {
  upsert(h: Holding13fRecord, now: Date): void {
    this.stmt(
      `INSERT INTO holdings_13f (filer_cik, period, cusip, ticker, filer_name, shares, value_usd, put_call, accession,
         filed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (filer_cik, period, cusip) DO UPDATE SET shares = excluded.shares, value_usd = excluded.value_usd,
         accession = excluded.accession, filed_at = excluded.filed_at`,
    ).run(
      h.filerCik,
      h.period,
      h.cusip,
      h.ticker,
      h.filerName,
      h.shares,
      h.valueUsd,
      h.putCall,
      h.accession,
      h.filedAt === null ? null : normalizeInstant(h.filedAt, '13F filedAt'),
      iso(now),
    );
  }

  /** Holdings for a filer+ticker, newest period first. */
  history(filerCik: string, ticker: string, limit = 8): Holding13fRecord[] {
    return (
      this.stmt(
        'SELECT * FROM holdings_13f WHERE filer_cik = ? AND ticker = ? ORDER BY period DESC LIMIT ?',
      ).all(filerCik, ticker, limit) as H13Row[]
    ).map((r) => ({
      filerCik: r.filer_cik,
      filerName: r.filer_name,
      period: r.period,
      cusip: r.cusip,
      ticker: r.ticker,
      shares: r.shares,
      valueUsd: r.value_usd,
      putCall: r.put_call,
      accession: r.accession,
      filedAt: r.filed_at,
    }));
  }
}
