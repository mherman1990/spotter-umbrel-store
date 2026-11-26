import { describe, expect, it } from 'vitest';
import { EVENT_PAYLOAD_SCHEMAS, SCHEMA_KINDS, parseEventPayload } from './event-payloads.js';
import { BREAKER_DETECTORS, EVENT_KINDS, EVENT_SOURCES, KIND_SOURCE } from './types.js';
import { LEAD_LINES, briefKey, leadLineFor } from './engine/types.js';

const filingBase = {
  cik: '0001113809',
  accession: '0001113809-26-000123',
  form: '8-K',
  acceptedAt: '2026-12-03T11:58:00.000Z',
  filingDate: '2026-12-03',
  reportDate: '2026-12-03',
  primaryDocument: 'bbw-8k.htm',
  documentUrl: 'https://www.sec.gov/x',
  indexUrl: 'https://www.sec.gov/y',
  description: null,
};

describe('event payload schemas (the invariant I8 detector)', () => {
  it('every well-known kind has a schema, and every kind maps to a known source', () => {
    for (const k of SCHEMA_KINDS) {
      expect(Object.keys(EVENT_PAYLOAD_SCHEMAS)).toContain(k);
      expect(EVENT_SOURCES).toContain(KIND_SOURCE[k as keyof typeof KIND_SOURCE]);
    }
    expect(Object.keys(KIND_SOURCE).sort()).toEqual(Object.values(EVENT_KINDS).sort());
    // halts, plan levels and thesis breakers each have exactly ONE source
    expect(KIND_SOURCE.halt).toBe('quote');
    expect(KIND_SOURCE.plan_level).toBe('quote');
    expect(KIND_SOURCE.thesis_breaker).toBe('filing');
  });

  it('accepts a well-formed 8-K and Form 4 payload (extra optional fields are allowed)', () => {
    expect(
      parseEventPayload('8-K', {
        ...filingBase,
        items: ['2.02'],
        isAmendment: false,
        exhibit99Url: null,
        extra: 1,
      }),
    ).toMatchObject({ ok: true, known: true });
    const form4 = {
      ...filingBase,
      form: '4',
      rowIndex: 0,
      tableType: 'non_derivative',
      ownerName: 'A B',
      ownerCik: '1',
      isOfficer: true,
      isDirector: false,
      isTenPercentOwner: false,
      officerTitle: 'CFO',
      transactionCode: 'P',
      transactionDate: '2026-12-01',
      shares: 1000,
      pricePerShare: 40,
      usdValue: 40000,
      filingSaleUsd: 0,
      filingBuyUsd: 40000,
      acquiredDisposed: 'A',
      sharesOwnedAfter: 5000,
      ownership: 'D',
      is10b5One: null,
    };
    expect(parseEventPayload('form4', form4).ok).toBe(true);
  });

  it('rejects missing/mistyped fields with a path-annotated message that carries no payload VALUES', () => {
    const bad = parseEventPayload('8-K', {
      ...filingBase,
      items: 'not-an-array',
      isAmendment: false,
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error('unreachable');
    expect(bad.error).toContain('invalid 8-K payload');
    expect(bad.error).toContain('items');
    expect(bad.error).not.toContain('not-an-array');
    expect(parseEventPayload('halt', {}).ok).toBe(false);
    expect(parseEventPayload('price_move', null).ok).toBe(false);
  });

  it('an unknown (open) kind passes through unvalidated; derived kinds validate', () => {
    expect(parseEventPayload('custom_kind', { a: 1 })).toEqual({
      ok: true,
      known: false,
      data: { a: 1 },
    });
    expect(
      parseEventPayload('plan_level', {
        tradingDate: '2026-12-03',
        level: 'tranche:starter', // the tranche variant was removed
        levelPrice: 30,
        last: 29,
        direction: 'below',
      }).ok,
    ).toBe(false);
    expect(
      parseEventPayload('thesis_breaker', {
        detector: BREAKER_DETECTORS[0],
        period: 'Q3 FY26',
        breaker: 'third FY guidance cut',
        evidence: 'FY revenue guide cut for the third time',
        evidenceEventIds: ['e1'],
      }).ok,
    ).toBe(true);
  });
});

describe('lead lines and brief keys (one spelling everywhere)', () => {
  it('LEAD_LINES are the exact strings the spec and the acceptance test assert', () => {
    expect(LEAD_LINES.cut).toBe('FY guide cut');
    expect(LEAD_LINES.raised).toBe('FY guide raised');
    expect(LEAD_LINES.held).toBe('FY guide held');
    expect(LEAD_LINES.unknown).toBe('Guide: unknown - read the 8-K');
    expect(leadLineFor('mixed')).toBe('FY guide mixed');
    for (const v of [
      'raised',
      'held',
      'cut',
      'mixed',
      'initiated',
      'withdrawn',
      'unknown',
    ] as const)
      expect(leadLineFor(v).length).toBeGreaterThan(0);
  });

  it('briefKey is brief:<type>:<TICKER>:<tradingDate>', () => {
    expect(briefKey('midday', 'bbw', '2026-12-03')).toBe('brief:midday:BBW:2026-12-03');
  });
});
