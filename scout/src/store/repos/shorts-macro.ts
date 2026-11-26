import type { MacroObservationRecord, RegShoRecord, ShortInterestRecord } from '../../types.js';
import { Repo, iso } from './common.js';

interface SiRow {
  symbol: string;
  settlement_date: string;
  published_date: string | null;
  short_interest: number;
  previous_short_interest: number | null;
  avg_daily_volume: number | null;
  days_to_cover: number | null;
  change_pct: number | null;
}

const toSi = (r: SiRow): ShortInterestRecord => ({
  symbol: r.symbol,
  settlementDate: r.settlement_date,
  publishedDate: r.published_date,
  shortInterest: r.short_interest,
  previousShortInterest: r.previous_short_interest,
  avgDailyVolume: r.avg_daily_volume,
  daysToCover: r.days_to_cover,
  changePct: r.change_pct,
});

/** FINRA short interest, one row per (symbol, settlement date). */
export class ShortInterestRepo extends Repo {
  upsert(s: ShortInterestRecord, now: Date): void {
    this.stmt(
      `INSERT INTO short_interest (symbol, settlement_date, published_date, short_interest, previous_short_interest,
         avg_daily_volume, days_to_cover, change_pct, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (symbol, settlement_date) DO UPDATE SET published_date = excluded.published_date,
         short_interest = excluded.short_interest, previous_short_interest = excluded.previous_short_interest,
         avg_daily_volume = excluded.avg_daily_volume, days_to_cover = excluded.days_to_cover,
         change_pct = excluded.change_pct`,
    ).run(
      s.symbol,
      s.settlementDate,
      s.publishedDate,
      s.shortInterest,
      s.previousShortInterest,
      s.avgDailyVolume,
      s.daysToCover,
      s.changePct,
      iso(now),
    );
  }

  /** Newest first. */
  latest(symbol: string, n = 1): ShortInterestRecord[] {
    return (
      this.stmt(
        'SELECT * FROM short_interest WHERE symbol = ? ORDER BY settlement_date DESC LIMIT ?',
      ).all(symbol, n) as SiRow[]
    ).map(toSi);
  }

  /** The latest record strictly before `settlementDate` (the comparison baseline). */
  previous(symbol: string, settlementDate: string): ShortInterestRecord | undefined {
    const r = this.stmt(
      'SELECT * FROM short_interest WHERE symbol = ? AND settlement_date < ? ORDER BY settlement_date DESC LIMIT 1',
    ).get(symbol, settlementDate) as SiRow | undefined;
    return r === undefined ? undefined : toSi(r);
  }
}

interface RegRow {
  symbol: string;
  trade_date: string;
  market: string;
  short_volume: number;
  short_exempt_volume: number;
  total_volume: number;
}

/** FINRA Reg SHO daily short volume (context only: never alerts alone). */
export class RegShoRepo extends Repo {
  upsert(r: RegShoRecord, now: Date): void {
    this.stmt(
      `INSERT INTO reg_sho_daily (symbol, trade_date, market, short_volume, short_exempt_volume, total_volume, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (symbol, trade_date, market) DO UPDATE SET short_volume = excluded.short_volume,
         short_exempt_volume = excluded.short_exempt_volume, total_volume = excluded.total_volume`,
    ).run(
      r.symbol,
      r.tradeDate,
      r.market,
      r.shortVolume,
      r.shortExemptVolume,
      r.totalVolume,
      iso(now),
    );
  }

  /** Newest trade dates first (all markets). */
  latest(symbol: string, n = 20): RegShoRecord[] {
    return (
      this.stmt(
        'SELECT * FROM reg_sho_daily WHERE symbol = ? ORDER BY trade_date DESC, market LIMIT ?',
      ).all(symbol, n) as RegRow[]
    ).map((r) => ({
      symbol: r.symbol,
      tradeDate: r.trade_date,
      market: r.market,
      shortVolume: r.short_volume,
      shortExemptVolume: r.short_exempt_volume,
      totalVolume: r.total_volume,
    }));
  }
}

/** FRED observations (context for briefs; never alerts). */
export class MacroRepo extends Repo {
  upsert(o: MacroObservationRecord, now: Date): void {
    this.stmt(
      `INSERT INTO macro_observations (series_id, observation_date, title, value, units, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (series_id, observation_date) DO UPDATE SET value = excluded.value, title = excluded.title,
         units = excluded.units, fetched_at = excluded.fetched_at`,
    ).run(o.seriesId, o.observationDate, o.title, o.value, o.units, iso(now));
  }

  /** Newest first. */
  latest(seriesId: string, n = 2): MacroObservationRecord[] {
    return (
      this.stmt(
        'SELECT * FROM macro_observations WHERE series_id = ? ORDER BY observation_date DESC LIMIT ?',
      ).all(seriesId, n) as {
        series_id: string;
        observation_date: string;
        title: string | null;
        value: number | null;
        units: string | null;
      }[]
    ).map((r) => ({
      seriesId: r.series_id,
      observationDate: r.observation_date,
      title: r.title,
      value: r.value,
      units: r.units,
    }));
  }

  seriesIds(): string[] {
    return (
      this.stmt('SELECT DISTINCT series_id FROM macro_observations ORDER BY series_id').all() as {
        series_id: string;
      }[]
    ).map((r) => r.series_id);
  }
}

/** Last processed IMAP UID per mailbox (decision D27: fetch UID > last, never "since day"). */
export class NewsletterStateRepo extends Repo {
  get(mailbox: string): { uidValidity: number | null; lastUid: number } | undefined {
    const r = this.stmt(
      'SELECT uid_validity, last_uid FROM newsletter_state WHERE mailbox = ?',
    ).get(mailbox) as { uid_validity: number | null; last_uid: number } | undefined;
    return r === undefined ? undefined : { uidValidity: r.uid_validity, lastUid: r.last_uid };
  }

  /** Persist the cursor. A changed UIDVALIDITY resets the stored UID (caller decides; this just stores). */
  set(mailbox: string, uidValidity: number | null, lastUid: number, now: Date): void {
    this.stmt(
      `INSERT INTO newsletter_state (mailbox, uid_validity, last_uid, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (mailbox) DO UPDATE SET uid_validity = excluded.uid_validity, last_uid = excluded.last_uid,
         updated_at = excluded.updated_at`,
    ).run(mailbox, uidValidity, lastUid, iso(now));
  }
}
