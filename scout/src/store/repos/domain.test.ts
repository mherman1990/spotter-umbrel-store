import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeBars } from '../../test-support/factories.js';
import { tempDb, type TempStore } from '../../test-support/temp-db.js';
import type {
  DailyBarRecord,
  FilingRecord,
  Form4RowRecord,
  OptionsSnapshotRecord,
} from '../../types.js';

let t: TempStore;
const T0 = new Date('2026-12-03T14:00:00.000Z');
const at = (min: number): Date => new Date(T0.getTime() + min * 60_000);

beforeEach(() => {
  t = tempDb();
});
afterEach(() => t.close());

const filing = (over: Partial<FilingRecord> = {}): FilingRecord => ({
  accession: '0001113809-26-000123',
  ticker: 'BBW',
  cik: '0001113809',
  form: '8-K',
  items: ['2.02', '9.01'],
  filingDate: '2026-12-03',
  reportDate: '2026-12-03',
  acceptedAt: '2026-12-03T06:58:12.000Z',
  primaryDocument: 'bbw-8k.htm',
  primaryDocDescription: '8-K',
  indexUrl:
    'https://www.sec.gov/Archives/edgar/data/1113809/000111380926000123/0001113809-26-000123-index.htm',
  documentUrl: null,
  isInlineXbrl: true,
  raw: { accessionNumber: '0001113809-26-000123' },
  ...over,
});

const form4 = (over: Partial<Form4RowRecord> = {}): Form4RowRecord => ({
  accession: '0001113809-26-000124',
  rowIndex: 0,
  ticker: 'BBW',
  issuerCik: '0001113809',
  ownerName: 'Doe Jane',
  ownerCik: '0000000001',
  isOfficer: true,
  isDirector: false,
  isTenPercentOwner: false,
  officerTitle: 'CFO',
  tableType: 'non_derivative',
  transactionDate: '2026-12-01',
  transactionCode: 'S',
  shares: 5000,
  pricePerShare: 50,
  usdValue: 250_000,
  acquiredDisposed: 'D',
  sharesOwnedAfter: 20_000,
  ownership: 'D',
  is10b5One: true,
  raw: null,
  ...over,
});

describe('filings', () => {
  it('upserts by accession and round-trips (items array, booleans, raw)', () => {
    t.store.filings.upsert(filing(), T0);
    t.store.filings.upsert(filing({ items: ['2.02', '7.01', '9.01'] }), at(1)); // amendment of metadata: updates in place
    const f = t.store.filings.get('0001113809-26-000123');
    expect(f).toMatchObject({
      form: '8-K',
      items: ['2.02', '7.01', '9.01'],
      isInlineXbrl: true,
      acceptedAt: '2026-12-03T06:58:12.000Z',
    });
    expect(f?.raw).toEqual({ accessionNumber: '0001113809-26-000123' });
    expect(t.store.filings.exists('0001113809-26-000123')).toBe(true);
    expect(t.store.filings.exists('nope')).toBe(false);
  });

  it('a later upsert without raw does not erase the stored raw; empty items round-trip as []', () => {
    t.store.filings.upsert(filing(), T0);
    t.store.filings.upsert(filing({ raw: null, items: [] }), at(1));
    expect(t.store.filings.get('0001113809-26-000123')?.raw).not.toBeNull();
    expect(t.store.filings.get('0001113809-26-000123')?.items).toEqual([]);
  });

  it('recent() filters by form/time and orders newest first; latestByForm picks one', () => {
    t.store.filings.upsert(
      filing({ accession: 'a1', acceptedAt: '2026-11-01T12:00:00.000Z', form: '10-Q' }),
      T0,
    );
    t.store.filings.upsert(
      filing({ accession: 'a2', acceptedAt: '2026-12-01T12:00:00.000Z', form: '8-K' }),
      T0,
    );
    t.store.filings.upsert(
      filing({ accession: 'a3', acceptedAt: '2026-12-02T12:00:00.000Z', form: '8-K' }),
      T0,
    );
    expect(t.store.filings.recent('BBW').map((f) => f.accession)).toEqual(['a3', 'a2', 'a1']);
    expect(t.store.filings.recent('BBW', { forms: ['8-K'] }).map((f) => f.accession)).toEqual([
      'a3',
      'a2',
    ]);
    expect(
      t.store.filings
        .recent('BBW', { sinceIso: '2026-12-02T00:00:00.000Z' })
        .map((f) => f.accession),
    ).toEqual(['a3']);
    expect(t.store.filings.latestByForm('BBW', '10-Q')?.accession).toBe('a1');
    expect(t.store.filings.latestByForm('BBW', '10-K')).toBeUndefined();
  });
});

describe('form4', () => {
  it('upserts per (accession, row) with tri-state 10b5-1 flag and summarizes open-market activity', () => {
    t.store.form4.upsert(form4(), T0);
    t.store.form4.upsert(
      form4({
        rowIndex: 1,
        transactionCode: 'P',
        acquiredDisposed: 'A',
        shares: 100,
        pricePerShare: 40,
        usdValue: 4000,
        is10b5One: null,
      }),
      T0,
    );
    t.store.form4.upsert(
      form4({
        rowIndex: 2,
        transactionCode: 'M',
        shares: 999,
        usdValue: null,
        tableType: 'derivative',
      }),
      T0,
    );
    t.store.form4.upsert(
      form4({
        accession: 'old',
        transactionDate: '2026-10-01',
        transactionCode: 'S',
        usdValue: 1_000_000,
      }),
      T0,
    );
    const rows = t.store.form4.byAccession('0001113809-26-000124');
    expect(rows.map((r) => [r.rowIndex, r.transactionCode, r.is10b5One])).toEqual([
      [0, 'S', true],
      [1, 'P', null],
      [2, 'M', true],
    ]);
    expect(t.store.form4.recent('BBW', '2026-11-01').length).toBe(3);
    expect(t.store.form4.openMarketSummary('BBW', '2026-11-01')).toEqual({
      buyUsd: 4000,
      sellUsd: 250_000,
      buyShares: 100,
      sellShares: 5000,
      rows: 2,
    });
    expect(t.store.form4.openMarketSummary('AAPL', '2026-11-01').rows).toBe(0);
    // re-upserting the same row updates in place (no duplicate)
    t.store.form4.upsert(form4({ shares: 6000 }), at(1));
    expect(t.store.form4.byAccession('0001113809-26-000124')[0]?.shares).toBe(6000);
    expect(t.store.form4.byAccession('0001113809-26-000124')).toHaveLength(3);
  });
});

describe('schedule 13 and 13F', () => {
  it('stores 13D/G filings and 13F holdings with history ordering', () => {
    t.store.schedule13.upsert(
      {
        accession: 's1',
        ticker: 'BBW',
        form: 'SCHEDULE 13G/A',
        isAmendment: true,
        filerName: 'Fund',
        filerCik: '9',
        percentOfClass: 5.1,
        shares: 800_000,
        filedAt: '2026-11-10T00:00:00.000Z',
        url: null,
        raw: null,
      },
      T0,
    );
    expect(t.store.schedule13.recent('BBW')[0]).toMatchObject({
      form: 'SCHEDULE 13G/A',
      isAmendment: true,
      percentOfClass: 5.1,
    });
    for (const [period, shares] of [
      ['2026-06-30', 100],
      ['2026-09-30', 150],
    ] as const) {
      t.store.holdings13f.upsert(
        {
          filerCik: '9',
          period,
          cusip: 'C1',
          ticker: 'BBW',
          filerName: 'Fund',
          shares,
          valueUsd: shares * 40,
          putCall: null,
          accession: `f-${period}`,
          filedAt: null,
        },
        T0,
      );
    }
    expect(t.store.holdings13f.history('9', 'BBW').map((h) => [h.period, h.shares])).toEqual([
      ['2026-09-30', 150],
      ['2026-06-30', 100],
    ]);
  });
});

describe('quotes_daily', () => {
  const bars = (): DailyBarRecord[] =>
    makeBars(25, { endDate: '2026-12-02' }).map((b) => ({
      ...b,
      ticker: 'BBW',
      atr20: null,
      source: 'test',
    }));

  it('upserts bars, returns the latest n OLDEST FIRST, and is idempotent', () => {
    t.store.quotes.upsertMany(bars(), T0);
    t.store.quotes.upsertMany(bars(), at(1));
    const last5 = t.store.quotes.latest('BBW', 5, '2026-12-31');
    expect(last5).toHaveLength(5);
    expect(last5.map((b) => b.date)).toEqual([...last5.map((b) => b.date)].sort());
    expect(last5.at(-1)?.date).toBe('2026-12-02');
    expect(t.store.quotes.latest('BBW', 100, '2026-12-31')).toHaveLength(25);
    expect(t.store.quotes.latest('BBW', 3, '2026-11-20').at(-1)?.date).toBe('2026-11-20');
    expect(t.store.quotes.lastDate('BBW')).toBe('2026-12-02');
    expect(t.store.quotes.lastDate('NOPE')).toBeNull();
    expect(t.store.quotes.get('BBW', '2026-12-02')?.source).toBe('test');
  });

  it('a null atr20 never overwrites a computed ATR; setAtr updates it', () => {
    const [b] = bars();
    if (b === undefined) throw new Error('fixture');
    t.store.quotes.upsert({ ...b, atr20: 1.5 }, T0);
    t.store.quotes.upsert({ ...b, atr20: null }, at(1));
    expect(t.store.quotes.get('BBW', b.date)?.atr20).toBe(1.5);
    t.store.quotes.setAtr('BBW', b.date, 2.5, at(2));
    expect(t.store.quotes.get('BBW', b.date)?.atr20).toBe(2.5);
  });

  it('averageVolume uses bars strictly BEFORE the given date and needs enough history', () => {
    const data = bars();
    t.store.quotes.upsertMany(data, T0);
    const before = data.slice(0, 20);
    const expected = before.reduce((s, b) => s + b.volume, 0) / 20;
    const day21 = data[20]?.date ?? '';
    expect(t.store.quotes.averageVolume('BBW', 20, day21)).toBeCloseTo(expected, 6);
    expect(t.store.quotes.averageVolume('BBW', 20, data[5]?.date ?? '')).toBeNull(); // only 5 bars earlier
    expect(t.store.quotes.averageVolume('BBW', 20, data[5]?.date ?? '', 3)).not.toBeNull();
    expect(t.store.quotes.averageVolume('NOPE', 20, '2026-12-03')).toBeNull();
  });
});

describe('intraday profile and bars', () => {
  it('saves and reloads a profile (clamped to 0..1) and replaces on re-save', () => {
    t.store.intraday.saveProfile('BBW', [0.1, 0.25, 1.4], 20, T0);
    expect(t.store.intraday.getProfile('BBW')).toEqual({
      fractions: [0.1, 0.25, 1],
      sampleDays: 20,
      updatedAt: T0.toISOString(),
    });
    t.store.intraday.saveProfile('BBW', [0.5], 5, at(1));
    expect(t.store.intraday.getProfile('BBW')?.fractions).toEqual([0.5]);
    expect(t.store.intraday.getProfile('NOPE')).toBeNull();
  });

  it('inserts bars idempotently and queries by half-open range', () => {
    const bar = {
      ticker: 'BBW',
      startMs: 1000,
      intervalMinutes: 5,
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 10,
    };
    expect(t.store.intraday.upsertBar(bar)).toBe(true);
    expect(t.store.intraday.upsertBar(bar)).toBe(false); // identical re-fetch: unchanged
    t.store.intraday.upsertBar({ ...bar, startMs: 2000 });
    expect(t.store.intraday.bars('BBW', 1000, 2000)).toHaveLength(1);
    expect(t.store.intraday.bars('BBW', 0, 3000).map((b) => b.startMs)).toEqual([1000, 2000]);
  });
});

describe('options snapshots', () => {
  const snap = (over: Partial<OptionsSnapshotRecord>): OptionsSnapshotRecord => ({
    ticker: 'BBW',
    tsMs: Date.parse('2026-12-02T15:00:00Z'),
    date: '2026-12-02',
    underlyingPrice: 40,
    iv30Pct: 50,
    summary: { calls: 10 },
    chain: { underlying: 'BBW', asOfMs: 0, underlyingPrice: 40, contracts: [] },
    ...over,
  });

  it('inserts once per (ticker, ts); finds latest, last-on-date and previous-day baselines; IV30 series', () => {
    expect(t.store.options.insertIgnore(snap({}), T0)).toBe(true);
    expect(t.store.options.insertIgnore(snap({}), T0)).toBe(false);
    t.store.options.insertIgnore(
      snap({ tsMs: Date.parse('2026-12-02T19:00:00Z'), iv30Pct: 52 }),
      T0,
    );
    t.store.options.insertIgnore(
      snap({
        tsMs: Date.parse('2026-12-03T15:00:00Z'),
        date: '2026-12-03',
        iv30Pct: 65,
        chain: null,
      }),
      T0,
    );
    expect(t.store.options.latest('BBW')).toMatchObject({
      date: '2026-12-03',
      iv30Pct: 65,
      chain: null,
    });
    expect(t.store.options.lastOnDate('BBW', '2026-12-02')?.iv30Pct).toBe(52);
    expect(t.store.options.lastBeforeDate('BBW', '2026-12-03')).toMatchObject({
      date: '2026-12-02',
      iv30Pct: 52,
    });
    expect(t.store.options.lastBeforeDate('BBW', '2026-12-02')).toBeUndefined();
    expect(t.store.options.iv30Series('BBW', 5)).toEqual([
      { date: '2026-12-02', iv30Pct: 52 },
      { date: '2026-12-03', iv30Pct: 65 },
    ]);
    expect(t.store.options.latest('NOPE')).toBeUndefined();
    expect(t.store.options.lastOnDate('BBW', '2026-12-02')?.chain?.underlying).toBe('BBW');
  });
});

describe('short interest, reg sho, macro, newsletter', () => {
  it('short interest: upsert, latest (newest first), previous baseline', () => {
    const si = (settlementDate: string, shortInterest: number) => ({
      symbol: 'BBW',
      settlementDate,
      publishedDate: null,
      shortInterest,
      previousShortInterest: null,
      avgDailyVolume: 300_000,
      daysToCover: shortInterest / 300_000,
      changePct: null,
    });
    t.store.shortInterest.upsert(si('2026-10-31', 1_000_000), T0);
    t.store.shortInterest.upsert(si('2026-11-14', 1_200_000), T0);
    t.store.shortInterest.upsert(si('2026-11-14', 1_250_000), at(1)); // revision of the same settlement
    expect(t.store.shortInterest.latest('BBW', 2).map((r) => r.shortInterest)).toEqual([
      1_250_000, 1_000_000,
    ]);
    expect(t.store.shortInterest.previous('BBW', '2026-11-14')?.settlementDate).toBe('2026-10-31');
    expect(t.store.shortInterest.previous('BBW', '2026-10-31')).toBeUndefined();
  });

  it('reg sho: per (symbol, date, market), newest first', () => {
    for (const [d, m, v] of [
      ['2026-11-24', 'Q', 10],
      ['2026-11-25', 'Q', 20],
      ['2026-11-25', 'N', 5],
    ] as const) {
      t.store.regSho.upsert(
        {
          symbol: 'BBW',
          tradeDate: d,
          market: m,
          shortVolume: v,
          shortExemptVolume: 0,
          totalVolume: 100,
        },
        T0,
      );
    }
    expect(t.store.regSho.latest('BBW', 10).map((r) => [r.tradeDate, r.market])).toEqual([
      ['2026-11-25', 'N'],
      ['2026-11-25', 'Q'],
      ['2026-11-24', 'Q'],
    ]);
  });

  it('macro observations: upsert (null values allowed), latest, series ids', () => {
    t.store.macro.upsert(
      {
        seriesId: 'UMCSENT',
        title: 'Sentiment',
        observationDate: '2026-10-01',
        value: 70,
        units: 'index',
      },
      T0,
    );
    t.store.macro.upsert(
      {
        seriesId: 'UMCSENT',
        title: 'Sentiment',
        observationDate: '2026-11-01',
        value: null,
        units: 'index',
      },
      T0,
    );
    t.store.macro.upsert(
      {
        seriesId: 'UMCSENT',
        title: 'Sentiment',
        observationDate: '2026-11-01',
        value: 71.5,
        units: 'index',
      },
      at(1),
    );
    expect(t.store.macro.latest('UMCSENT', 2).map((o) => o.value)).toEqual([71.5, 70]);
    expect(t.store.macro.seriesIds()).toEqual(['UMCSENT']);
  });

  it('newsletter state keeps the last UID per mailbox (decision D27)', () => {
    expect(t.store.newsletter.get('INBOX')).toBeUndefined();
    t.store.newsletter.set('INBOX', 7, 120, T0);
    t.store.newsletter.set('INBOX', 7, 130, at(1));
    expect(t.store.newsletter.get('INBOX')).toEqual({ uidValidity: 7, lastUid: 130 });
  });
});
