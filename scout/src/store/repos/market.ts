import type {
  DailyBarRecord,
  IntradayBarRecord,
  OptionChainSnapshot,
  OptionsSnapshotRecord,
  QuoteSnapshotSource,
  QuoteTick,
} from '../../types.js';
import { Repo, iso, parseJson } from './common.js';

interface DailyRow {
  ticker: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  atr20: number | null;
  source: string;
}

const toDaily = (r: DailyRow): DailyBarRecord => ({
  ticker: r.ticker,
  date: r.date,
  open: r.open,
  high: r.high,
  low: r.low,
  close: r.close,
  volume: r.volume,
  atr20: r.atr20,
  source: r.source,
});

/** `quotes_daily`: one OHLCV row per ticker per exchange trading date (kept forever). */
export class QuotesDailyRepo extends Repo {
  /**
   * Upsert a bar. `atr20` is a CACHE that the metrics code recomputes from bars: a null `atr20` keeps an
   * existing value only while the bar's OHLCV is unchanged; when a re-fetched bar differs (the partial bar of
   * the day became final) the stale ATR is cleared instead of lingering. The daily-bars job persists TODAY's bar
   * only after the close (phase afterhours or later), so a partial bar is not stored in the first place.
   */
  upsert(b: DailyBarRecord, now: Date): void {
    this.stmt(
      `INSERT INTO quotes_daily (ticker, date, open, high, low, close, volume, atr20, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (ticker, date) DO UPDATE SET
         atr20 = CASE
           WHEN excluded.atr20 IS NOT NULL THEN excluded.atr20
           WHEN quotes_daily.open = excluded.open AND quotes_daily.high = excluded.high
             AND quotes_daily.low = excluded.low AND quotes_daily.close = excluded.close
             AND quotes_daily.volume = excluded.volume THEN quotes_daily.atr20
           ELSE NULL END,
         open = excluded.open, high = excluded.high, low = excluded.low,
         close = excluded.close, volume = excluded.volume,
         source = excluded.source, updated_at = excluded.updated_at`,
    ).run(b.ticker, b.date, b.open, b.high, b.low, b.close, b.volume, b.atr20, b.source, iso(now));
  }

  upsertMany(bars: readonly DailyBarRecord[], now: Date): void {
    this.db.transaction(() => {
      for (const b of bars) this.upsert(b, now);
    })();
  }

  get(ticker: string, date: string): DailyBarRecord | undefined {
    const r = this.stmt('SELECT * FROM quotes_daily WHERE ticker = ? AND date = ?').get(
      ticker,
      date,
    ) as DailyRow | undefined;
    return r === undefined ? undefined : toDaily(r);
  }

  /**
   * The most recent `n` bars with `date <= onOrBefore`, returned OLDEST FIRST (chronological, ready for ATR
   * math). The bound is REQUIRED: an unbounded read would include today's partial bar. For rule contexts
   * ("completed bars, excluding today") use {@link latestCompleted}.
   */
  latest(ticker: string, n: number, onOrBefore: string): DailyBarRecord[] {
    const rows = this.stmt(
      'SELECT * FROM quotes_daily WHERE ticker = ? AND date <= ? ORDER BY date DESC LIMIT ?',
    ).all(ticker, onOrBefore, n) as DailyRow[];
    return rows.reverse().map(toDaily);
  }

  /** The most recent `n` COMPLETED bars: `date < today` (exchange date of "now"), oldest first. */
  latestCompleted(ticker: string, n: number, today: string): DailyBarRecord[] {
    const rows = this.stmt(
      'SELECT * FROM quotes_daily WHERE ticker = ? AND date < ? ORDER BY date DESC LIMIT ?',
    ).all(ticker, today, n) as DailyRow[];
    return rows.reverse().map(toDaily);
  }

  lastDate(ticker: string): string | null {
    return (
      this.stmt('SELECT MAX(date) AS d FROM quotes_daily WHERE ticker = ?').get(ticker) as {
        d: string | null;
      }
    ).d;
  }

  setAtr(ticker: string, date: string, atr20: number, now: Date): void {
    this.stmt(
      'UPDATE quotes_daily SET atr20 = ?, updated_at = ? WHERE ticker = ? AND date = ?',
    ).run(atr20, iso(now), ticker, date);
  }

  /**
   * Average daily volume over the last `n` bars strictly BEFORE `beforeDate` (so today's partial bar never
   * pollutes ADV20). Null when fewer than `minBars` (default `n`) bars exist.
   */
  averageVolume(ticker: string, n: number, beforeDate: string, minBars = n): number | null {
    const r = this.stmt(
      `SELECT AVG(volume) AS avg, COUNT(*) AS c FROM
         (SELECT volume FROM quotes_daily WHERE ticker = ? AND date < ? ORDER BY date DESC LIMIT ?)`,
    ).get(ticker, beforeDate, n) as { avg: number | null; c: number };
    return r.c >= minBars && r.avg !== null ? r.avg : null;
  }
}

/** Learned intraday volume profile plus (optional) raw intraday bars. */
export class IntradayRepo extends Repo {
  /** Replace a ticker's profile: `fractions[i]` = cumulative fraction of day volume by minute-of-session `i`. */
  saveProfile(ticker: string, fractions: readonly number[], sampleDays: number, now: Date): void {
    this.db.transaction(() => {
      this.stmt('DELETE FROM intraday_profile WHERE ticker = ?').run(ticker);
      const ins = this.stmt(
        'INSERT INTO intraday_profile (ticker, minute_of_session, cum_fraction, sample_days, updated_at) VALUES (?, ?, ?, ?, ?)',
      );
      fractions.forEach((f, i) =>
        ins.run(ticker, i, Math.min(1, Math.max(0, f)), sampleDays, iso(now)),
      );
    })();
  }

  /** The stored profile (index = minute of session) and its sample size, or null when none is stored. */
  getProfile(
    ticker: string,
  ): { fractions: number[]; sampleDays: number; updatedAt: string } | null {
    const rows = this.stmt(
      'SELECT minute_of_session AS m, cum_fraction AS f, sample_days AS s, updated_at AS u FROM intraday_profile WHERE ticker = ? ORDER BY minute_of_session',
    ).all(ticker) as { m: number; f: number; s: number; u: string }[];
    const first = rows[0];
    if (first === undefined) return null;
    return { fractions: rows.map((r) => r.f), sampleDays: first.s, updatedAt: first.u };
  }

  /**
   * Upsert a bar. The first copy of a bar is NOT final (the still-forming current bar is returned by the
   * vendor), so a later fetch of the same bar REPLACES it: keeping the first copy would store a partial bar
   * permanently and corrupt the profile learner. Returns true when a row was inserted or changed.
   */
  upsertBar(b: IntradayBarRecord): boolean {
    return (
      this.stmt(
        `INSERT INTO intraday_bars (ticker, start_ms, interval_minutes, open, high, low, close, volume)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (ticker, start_ms, interval_minutes) DO UPDATE SET open = excluded.open,
           high = excluded.high, low = excluded.low, close = excluded.close, volume = excluded.volume
         WHERE intraday_bars.high != excluded.high OR intraday_bars.low != excluded.low
           OR intraday_bars.close != excluded.close OR intraday_bars.volume != excluded.volume`,
      ).run(b.ticker, b.startMs, b.intervalMinutes, b.open, b.high, b.low, b.close, b.volume)
        .changes > 0
    );
  }

  /** Bars with `startMs` in `[fromMs, toMs)`, oldest first. */
  bars(ticker: string, fromMs: number, toMs: number): IntradayBarRecord[] {
    return (
      this.stmt(
        'SELECT ticker, start_ms, interval_minutes, open, high, low, close, volume FROM intraday_bars WHERE ticker = ? AND start_ms >= ? AND start_ms < ? ORDER BY start_ms',
      ).all(ticker, fromMs, toMs) as {
        ticker: string;
        start_ms: number;
        interval_minutes: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
      }[]
    ).map((r) => ({
      ticker: r.ticker,
      startMs: r.start_ms,
      intervalMinutes: r.interval_minutes,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));
  }
}

interface OptRow {
  ticker: string;
  ts_epoch_ms: number;
  date: string;
  underlying_price: number | null;
  iv30_pct: number | null;
  summary_json: string;
  chain_json: string | null;
}

const toOpt = (r: OptRow): OptionsSnapshotRecord => ({
  ticker: r.ticker,
  tsMs: r.ts_epoch_ms,
  date: r.date,
  underlyingPrice: r.underlying_price,
  iv30Pct: r.iv30_pct,
  summary: parseJson<Record<string, unknown>>(r.summary_json, {}),
  chain: parseJson<OptionChainSnapshot | null>(r.chain_json, null),
});

/** Option-chain snapshots (chain JSON pruned after retention; IV30 and the summary are kept). */
export class OptionsRepo extends Repo {
  /** Insert unless (ticker, tsMs) exists. Returns true when inserted. */
  insertIgnore(s: OptionsSnapshotRecord, now: Date): boolean {
    return (
      this.stmt(
        `INSERT INTO options_snapshots (ticker, ts_epoch_ms, date, underlying_price, iv30_pct, summary_json,
           chain_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).run(
        s.ticker,
        s.tsMs,
        s.date,
        s.underlyingPrice,
        s.iv30Pct,
        JSON.stringify(s.summary),
        s.chain === null ? null : JSON.stringify(s.chain),
        iso(now),
      ).changes > 0
    );
  }

  latest(ticker: string): OptionsSnapshotRecord | undefined {
    const r = this.stmt(
      'SELECT * FROM options_snapshots WHERE ticker = ? ORDER BY ts_epoch_ms DESC LIMIT 1',
    ).get(ticker) as OptRow | undefined;
    return r === undefined ? undefined : toOpt(r);
  }

  /** The LAST snapshot taken on `date` (exchange date), or undefined. */
  lastOnDate(ticker: string, date: string): OptionsSnapshotRecord | undefined {
    const r = this.stmt(
      'SELECT * FROM options_snapshots WHERE ticker = ? AND date = ? ORDER BY ts_epoch_ms DESC LIMIT 1',
    ).get(ticker, date) as OptRow | undefined;
    return r === undefined ? undefined : toOpt(r);
  }

  /** The last snapshot of the most recent date strictly before `date` (day-over-day IV30 baseline). */
  lastBeforeDate(ticker: string, date: string): OptionsSnapshotRecord | undefined {
    const r = this.stmt(
      `SELECT * FROM options_snapshots WHERE ticker = ? AND date = (SELECT MAX(date) FROM options_snapshots WHERE ticker = ? AND date < ?)
       ORDER BY ts_epoch_ms DESC LIMIT 1`,
    ).get(ticker, ticker, date) as OptRow | undefined;
    return r === undefined ? undefined : toOpt(r);
  }

  /** IV30 history: the last IV30 of each of the most recent `days` dates, oldest first. */
  iv30Series(ticker: string, days: number): { date: string; iv30Pct: number | null }[] {
    const rows = this.stmt(
      `SELECT date, iv30_pct FROM options_snapshots o WHERE ticker = ?
         AND ts_epoch_ms = (SELECT MAX(ts_epoch_ms) FROM options_snapshots WHERE ticker = o.ticker AND date = o.date)
       ORDER BY date DESC LIMIT ?`,
    ).all(ticker, days) as { date: string; iv30_pct: number | null }[];
    return rows.reverse().map((r) => ({ date: r.date, iv30Pct: r.iv30_pct }));
  }
}

/** A persisted quote with the instant it was saved. */
export interface StoredQuote {
  tick: QuoteTick;
  /** Epoch ms when this copy was written (>= `tick.tsMs`). */
  savedAtMs: number;
}

/**
 * The persisted latest quote per symbol, in `kv_state` under `quote:<SYMBOL>` (key prefix owned by A2's
 * `QuoteTracker` and the `quotes_snapshot` job). It exists so a restart, `/snapshot` and the brief builders
 * (store-only, synchronous) see CURRENT prices rather than yesterday's daily bar.
 */
export class LatestQuotesRepo extends Repo {
  static key(symbol: string): string {
    return `quote:${symbol.toUpperCase()}`;
  }

  set(tick: QuoteTick, now: Date): void {
    const stored: StoredQuote = { tick, savedAtMs: now.getTime() };
    this.stmt(
      `INSERT INTO kv_state (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(LatestQuotesRepo.key(tick.symbol), JSON.stringify(stored), iso(now));
  }

  get(symbol: string): StoredQuote | undefined {
    const r = this.stmt('SELECT value_json FROM kv_state WHERE key = ?').get(
      LatestQuotesRepo.key(symbol),
    ) as { value_json: string } | undefined;
    return r === undefined
      ? undefined
      : parseJson<StoredQuote | undefined>(r.value_json, undefined);
  }

  /** A {@link QuoteSnapshotSource} over the persisted copies. */
  asSource(): QuoteSnapshotSource {
    return { latest: (symbol) => this.get(symbol)?.tick };
  }
}
