import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeBars, makeEvent, resetFactories } from '../test-support/factories.js';
import { tempDb, tempDbFile, type TempStore } from '../test-support/temp-db.js';
import type { DomainRecord } from '../types.js';
import { pruneRetention } from './retention.js';

let t: TempStore;
const T0 = new Date('2026-12-03T14:00:00.000Z');
const at = (min: number): Date => new Date(T0.getTime() + min * 60_000);

beforeEach(() => {
  resetFactories();
  t = tempDb();
});
afterEach(() => t.close());

describe('Store.commitPoll: the durable-ingest primitive (decision D10)', () => {
  it('inserts events as `new` (queued for triage), persists records, and advances the cursor together', () => {
    const e = makeEvent({ naturalKey: 'acc-1' });
    const records: DomainRecord[] = [
      {
        type: 'filing',
        record: {
          accession: 'acc-1',
          ticker: 'BBW',
          cik: '0001113809',
          form: '8-K',
          items: ['2.02'],
          filingDate: '2026-12-03',
          reportDate: null,
          acceptedAt: '2026-12-03T06:58:00.000Z',
          primaryDocument: null,
          primaryDocDescription: null,
          indexUrl: 'https://www.sec.gov/x',
          documentUrl: null,
          isInlineXbrl: false,
          raw: null,
        },
      },
    ];
    const r = t.store.commitPoll({
      source: 'edgar.submissions',
      ticker: 'BBW',
      events: [e],
      records,
      cursor: 'cursor-1',
      now: T0,
    });
    expect(r).toMatchObject({ watermarkAdvanced: true });
    expect(r.inserted.map((x) => x.id)).toEqual([e.id]);
    expect(t.store.events.get(e.id)?.status).toBe('new');
    expect(t.store.filings.exists('acc-1')).toBe(true);
    expect(t.store.watermarks.get('edgar.submissions', 'BBW')?.cursor).toBe('cursor-1');
  });

  it('a re-poll of the same facts reports duplicates and does not disturb events already being processed', () => {
    const e = makeEvent({ naturalKey: 'acc-1' });
    t.store.commitPoll({ source: 's', ticker: 'BBW', events: [e], cursor: 'c1', now: T0 });
    t.store.events.markTriaged(e.id, { triage: null, finalPriority: 'P1' }, at(1));
    const again = t.store.commitPoll({
      source: 's',
      ticker: 'BBW',
      events: [e],
      cursor: 'c2',
      now: at(2),
    });
    expect(again.inserted).toHaveLength(0);
    expect(again.duplicates).toHaveLength(1);
    expect(t.store.events.get(e.id)?.status).toBe('triaged');
    expect(t.store.watermarks.get('s', 'BBW')?.cursor).toBe('c2');
  });

  it('leaves the cursor untouched when the poll returns none (undefined/null)', () => {
    t.store.watermarks.set('s', 'BBW', 'keep', T0);
    expect(
      t.store.commitPoll({ source: 's', ticker: 'BBW', events: [], now: at(1) }).watermarkAdvanced,
    ).toBe(false);
    expect(
      t.store.commitPoll({ source: 's', ticker: 'BBW', events: [], cursor: null, now: at(1) })
        .watermarkAdvanced,
    ).toBe(false);
    expect(t.store.watermarks.get('s', 'BBW')?.cursor).toBe('keep');
  });

  it('is ATOMIC: a bad event rolls back its siblings, the records and the cursor (cursor never passes unstored events)', () => {
    const good = makeEvent({ naturalKey: 'good' });
    const bad = makeEvent({ naturalKey: 'bad', ts: 'not-a-time' });
    t.store.watermarks.set('s', 'BBW', 'old', T0);
    expect(() =>
      t.store.commitPoll({
        source: 's',
        ticker: 'BBW',
        events: [good, bad],
        cursor: 'new',
        now: at(1),
      }),
    ).toThrow(/unparseable ts/);
    expect(t.store.events.exists(good.id)).toBe(false);
    expect(t.store.watermarks.get('s', 'BBW')?.cursor).toBe('old');
  });

  it('a failing record write also rolls back events and cursor', () => {
    const e = makeEvent({ naturalKey: 'x' });
    const badRecord = {
      type: 'daily_bar',
      record: {
        ticker: 'BBW',
        date: '2026-12-02',
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: Number.NaN,
        atr20: null,
        source: 't',
      },
    } as DomainRecord;
    // NaN binds as NULL, violating NOT NULL on volume.
    expect(() =>
      t.store.commitPoll({
        source: 's',
        ticker: 'BBW',
        events: [e],
        records: [badRecord],
        cursor: 'new',
        now: T0,
      }),
    ).toThrow();
    expect(t.store.events.exists(e.id)).toBe(false);
    expect(t.store.watermarks.get('s', 'BBW')).toBeUndefined();
  });

  it('downstream failures cannot retire an event: an event stuck `new` after a triage failure is still the oldest unjudged', () => {
    const e = makeEvent({ naturalKey: 'stuck' });
    t.store.commitPoll({ source: 's', ticker: 'BBW', events: [e], cursor: 'c', now: T0 });
    t.store.events.recordFailure(e.id, 'LLM 503', at(1));
    t.store.events.recordFailure(e.id, 'LLM 503', at(2));
    expect(t.store.events.byStatus(['new']).map((x) => x.id)).toEqual([e.id]);
    expect(t.store.events.oldestUnjudgedAt()).toBe(T0.toISOString());
  });

  it('works against a real WAL file too (durability path)', () => {
    const f = tempDbFile();
    try {
      const e = makeEvent({ naturalKey: 'file' });
      f.store.commitPoll({ source: 's', ticker: 'BBW', events: [e], cursor: 'c', now: T0 });
      expect(f.store.events.get(e.id)?.status).toBe('new');
    } finally {
      f.close();
    }
  });
});

describe('Store.persistRecords handles every record type', () => {
  it('routes each DomainRecord to its repository', () => {
    const bar = makeBars(1)[0];
    if (bar === undefined) throw new Error('fixture');
    const records: DomainRecord[] = [
      { type: 'daily_bar', record: { ...bar, ticker: 'BBW', atr20: 1.2, source: 't' } },
      {
        type: 'intraday_bar',
        record: {
          ticker: 'BBW',
          startMs: 1,
          intervalMinutes: 5,
          open: 1,
          high: 1,
          low: 1,
          close: 1,
          volume: 1,
        },
      },
      {
        type: 'short_interest',
        record: {
          symbol: 'BBW',
          settlementDate: '2026-11-14',
          publishedDate: null,
          shortInterest: 1,
          previousShortInterest: null,
          avgDailyVolume: null,
          daysToCover: null,
          changePct: null,
        },
      },
      {
        type: 'reg_sho',
        record: {
          symbol: 'BBW',
          tradeDate: '2026-11-25',
          market: 'Q',
          shortVolume: 1,
          shortExemptVolume: 0,
          totalVolume: 2,
        },
      },
      {
        type: 'options_snapshot',
        record: {
          ticker: 'BBW',
          tsMs: 1,
          date: '2026-12-02',
          underlyingPrice: 1,
          iv30Pct: 40,
          summary: {},
          chain: null,
        },
      },
      {
        type: 'macro_observation',
        record: {
          seriesId: 'UMCSENT',
          title: 't',
          observationDate: '2026-11-01',
          value: 1,
          units: 'idx',
        },
      },
      {
        type: 'schedule13',
        record: {
          accession: 's13',
          ticker: 'BBW',
          form: 'SCHEDULE 13D',
          isAmendment: false,
          filerName: null,
          filerCik: null,
          percentOfClass: 6,
          shares: 1,
          filedAt: '2026-12-01T00:00:00.000Z',
          url: null,
          raw: null,
        },
      },
      {
        type: 'holding_13f',
        record: {
          filerCik: '9',
          period: '2026-09-30',
          cusip: 'C',
          ticker: 'BBW',
          filerName: 'F',
          shares: 1,
          valueUsd: null,
          putCall: null,
          accession: 'f',
          filedAt: null,
        },
      },
      {
        type: 'form4_row',
        record: {
          accession: 'f4',
          rowIndex: 0,
          ticker: 'BBW',
          issuerCik: '1',
          ownerName: 'O',
          ownerCik: '2',
          isOfficer: true,
          isDirector: false,
          isTenPercentOwner: false,
          officerTitle: null,
          tableType: 'non_derivative',
          transactionDate: '2026-12-01',
          transactionCode: 'P',
          shares: 1,
          pricePerShare: 1,
          usdValue: 1,
          acquiredDisposed: 'A',
          sharesOwnedAfter: null,
          ownership: 'D',
          is10b5One: false,
          raw: null,
        },
      },
    ];
    t.store.persistRecords(records, T0);
    expect(t.store.quotes.get('BBW', bar.date)?.atr20).toBe(1.2);
    expect(t.store.intraday.bars('BBW', 0, 10)).toHaveLength(1);
    expect(t.store.shortInterest.latest('BBW')).toHaveLength(1);
    expect(t.store.regSho.latest('BBW')).toHaveLength(1);
    expect(t.store.options.latest('BBW')?.iv30Pct).toBe(40);
    expect(t.store.macro.latest('UMCSENT')).toHaveLength(1);
    expect(t.store.schedule13.recent('BBW')).toHaveLength(1);
    expect(t.store.holdings13f.history('9', 'BBW')).toHaveLength(1);
    expect(t.store.form4.byAccession('f4')[0]?.is10b5One).toBe(false);
    // idempotent
    t.store.persistRecords(records, at(1));
    expect(t.store.quotes.latest('BBW', 10, '2026-12-31')).toHaveLength(1);
  });
});

describe('retention (raw payloads 90 days, aggregates kept)', () => {
  const policy = { rawPayloadDays: 90, jobRunsDays: 90, intradayBarsDays: 90 };
  const NOW = new Date('2026-12-03T14:00:00.000Z');

  it('blanks old event payloads but keeps the row, decision and triage; skips unjudged/queued events', () => {
    const old = makeEvent({
      naturalKey: 'old',
      ts: '2026-06-01T10:00:00.000-04:00',
      payload: { big: 'x'.repeat(100) },
    });
    const oldNew = makeEvent({ naturalKey: 'old-new', ts: '2026-06-01T10:00:00.000-04:00' });
    const oldQueued = makeEvent({ naturalKey: 'old-queued', ts: '2026-06-01T10:00:00.000-04:00' });
    const fresh = makeEvent({
      naturalKey: 'fresh',
      ts: '2026-12-01T10:00:00.000-05:00',
      payload: { keep: true },
    });
    for (const e of [old, oldNew, oldQueued, fresh])
      t.store.events.insertIgnore(e, new Date('2026-06-01T15:00:00Z'));
    t.store.events.markTriaged(old.id, { triage: { so_what: 'kept' }, finalPriority: 'P1' }, T0);
    t.store.events.setStatus(old.id, 'pushed', T0);
    t.store.events.setStatus(oldQueued.id, 'queued', T0, { digestKind: 'close' });
    const r = pruneRetention(t.store.db, policy, NOW);
    expect(r.eventPayloadsPruned).toBe(1);
    const s = t.store.events.get(old.id);
    expect(s).toMatchObject({
      payloadPruned: true,
      payload: {},
      status: 'pushed',
      finalPriority: 'P1',
      kind: '8-K',
    });
    expect(s?.triage).toEqual({ so_what: 'kept' });
    expect(t.store.events.get(oldNew.id)?.payloadPruned).toBe(false);
    expect(t.store.events.get(oldQueued.id)?.payloadPruned).toBe(false);
    expect(t.store.events.get(fresh.id)?.payload).toEqual({ keep: true });
    expect(pruneRetention(t.store.db, policy, NOW).eventPayloadsPruned).toBe(0); // idempotent
  });

  it('prunes raw columns on filings/form4/schedule13/option chains, keeps parsed columns and aggregates', () => {
    const filing = (accession: string, filingDate: string) => ({
      accession,
      ticker: 'BBW',
      cik: '1',
      form: '8-K',
      items: ['2.02'],
      filingDate,
      reportDate: null,
      acceptedAt: `${filingDate}T10:00:00.000Z`,
      primaryDocument: null,
      primaryDocDescription: null,
      indexUrl: 'u',
      documentUrl: null,
      isInlineXbrl: false,
      raw: { r: 1 },
    });
    t.store.filings.upsert(filing('old', '2026-05-01'), T0);
    t.store.filings.upsert(filing('new', '2026-12-01'), T0);
    t.store.options.insertIgnore(
      {
        ticker: 'BBW',
        tsMs: Date.parse('2026-05-01T15:00:00Z'),
        date: '2026-05-01',
        underlyingPrice: 1,
        iv30Pct: 44,
        summary: { a: 1 },
        chain: { underlying: 'BBW', asOfMs: 0, underlyingPrice: 1, contracts: [] },
      },
      T0,
    );
    const oldBar = makeBars(1, { endDate: '2026-05-01' })[0];
    if (oldBar === undefined) throw new Error('fixture');
    t.store.quotes.upsert({ ...oldBar, ticker: 'BBW', atr20: 1, source: 't' }, T0);
    const r = pruneRetention(t.store.db, policy, NOW);
    expect(r.filingRawPruned).toBe(1);
    expect(r.optionChainsPruned).toBe(1);
    expect(t.store.filings.get('old')).toMatchObject({ raw: null, form: '8-K', items: ['2.02'] });
    expect(t.store.filings.get('new')?.raw).toEqual({ r: 1 });
    expect(t.store.options.lastOnDate('BBW', '2026-05-01')).toMatchObject({
      chain: null,
      iv30Pct: 44,
      summary: { a: 1 },
    });
    expect(t.store.quotes.latest('BBW', 5, '2026-12-31')).toHaveLength(1); // daily bars are aggregates: never pruned
  });

  it('deletes only disposable history: old intraday bars and finished job runs', () => {
    t.store.intraday.upsertBar({
      ticker: 'BBW',
      startMs: Date.parse('2026-01-01T15:00:00Z'),
      intervalMinutes: 5,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
    });
    t.store.intraday.upsertBar({
      ticker: 'BBW',
      startMs: Date.parse('2026-12-01T15:00:00Z'),
      intervalMinutes: 5,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
    });
    const oldRun = t.store.jobRuns.start('close', new Date('2026-01-01T00:00:00Z'));
    t.store.jobRuns.finish(oldRun, 'ok', new Date('2026-01-01T00:01:00Z'));
    const stuck = t.store.jobRuns.start('close', new Date('2026-01-02T00:00:00Z')); // still running: kept
    const r = pruneRetention(t.store.db, policy, NOW);
    expect(r).toMatchObject({ intradayBarsDeleted: 1, jobRunsDeleted: 1 });
    expect(t.store.jobRuns.last('close')?.id).toBe(stuck);
    expect(t.store.intraday.bars('BBW', 0, Date.parse('2027-01-01T00:00:00Z'))).toHaveLength(1);
  });
});
