import { describe, expect, it } from 'vitest';
import { eventId } from './core/ids.js';
import {
  EVENT_KINDS,
  EVENT_SOURCES,
  EVENT_STATUSES,
  GLOBAL_TICKER,
  PRIORITIES,
  maxPriority,
  mostUrgent,
  payloadOf,
  priorityRank,
  type EightKPayload,
  type Event,
} from './types.js';

describe('priority helpers', () => {
  it('ranks P1 most urgent and picks the more urgent of two', () => {
    expect(PRIORITIES).toEqual(['P1', 'P2', 'P3']);
    expect(priorityRank('P1')).toBeLessThan(priorityRank('P2'));
    expect(priorityRank('P2')).toBeLessThan(priorityRank('P3'));
    expect(maxPriority('P3', 'P1')).toBe('P1');
    expect(maxPriority('P2', 'P3')).toBe('P2');
    expect(maxPriority('P2', 'P2')).toBe('P2');
  });

  it('mostUrgent ignores undefined and handles empty input', () => {
    expect(mostUrgent([undefined, 'P3', 'P2'])).toBe('P2');
    expect(mostUrgent(['P3'])).toBe('P3');
    expect(mostUrgent([])).toBeUndefined();
    expect(mostUrgent([undefined])).toBeUndefined();
  });
});

describe('constants', () => {
  it('sources and statuses match the spec/DB check constraints', () => {
    expect(EVENT_SOURCES).toEqual([
      'quote',
      'filing',
      'short',
      'news',
      'macro',
      'inbox',
      'options',
    ]);
    expect(EVENT_STATUSES).toEqual([
      'new',
      'triaged',
      'queued',
      'pushed',
      'digested',
      'dropped',
      'folded',
    ]);
    expect(GLOBAL_TICKER).toBe('*');
  });

  it('well-known kinds are unique strings', () => {
    const values = Object.values(EVENT_KINDS);
    expect(new Set(values).size).toBe(values.length);
    expect(EVENT_KINDS.EIGHT_K).toBe('8-K');
    expect(EVENT_KINDS.FORM4).toBe('form4');
    expect(EVENT_KINDS.SHORT_INTEREST).toBe('short_interest');
    expect(EVENT_KINDS.PRICE_MOVE).toBe('price_move');
  });
});

describe('payloadOf', () => {
  it('gives a typed view of the payload (compile-time contract between adapters and rules)', () => {
    const payload: EightKPayload = {
      cik: '0001113809',
      accession: '0001113809-26-000123',
      form: '8-K',
      acceptedAt: '2026-12-03T06:58:12.000Z',
      filingDate: '2026-12-03',
      reportDate: '2026-12-03',
      primaryDocument: 'x.htm',
      documentUrl: null,
      indexUrl: 'https://www.sec.gov/x',
      description: null,
      items: ['2.02', '9.01'],
      isAmendment: false,
      exhibit99Url: null,
    };
    const e: Event & { kind: '8-K' } = {
      id: eventId({ ticker: 'BBW', source: 'filing', kind: '8-K', naturalKey: payload.accession }),
      ticker: 'BBW',
      source: 'filing',
      kind: '8-K',
      ts: payload.acceptedAt,
      payload: payload as unknown as Record<string, unknown>,
    };
    expect(payloadOf(e).items).toContain('2.02');
  });
});
