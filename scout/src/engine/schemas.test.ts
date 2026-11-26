import { describe, expect, it } from 'vitest';
import {
  SO_WHAT_MAX_WORDS,
  TRIAGE_JSON_SCHEMA,
  TriageResultSchema,
  applyTriage,
  clampWords,
  isTriageExempt,
  normalizeTriage,
  parseTriageRecord,
  resolveFinalPriority,
  triageFallback,
  wordCount,
} from './schemas.js';

describe('word helpers', () => {
  it('wordCount counts whitespace-separated words', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('   ')).toBe(0);
    expect(wordCount('one two  three\nfour')).toBe(4);
  });

  it('clampWords leaves short text alone (whitespace collapsed) and cuts long text with an ellipsis', () => {
    expect(clampWords('  a   b\nc ')).toBe('a b c');
    const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
    const out = clampWords(long);
    expect(wordCount(out)).toBe(SO_WHAT_MAX_WORDS);
    expect(out.endsWith('…')).toBe(true);
    expect(clampWords(long, 3)).toBe('w0 w1 w2…');
    expect(clampWords('')).toBe('');
  });
});

describe('TriageResult schema (untrusted model output, decision D22)', () => {
  it('accepts a valid verdict and rejects malformed ones', () => {
    expect(
      TriageResultSchema.safeParse({ material: true, priority: 'P2', so_what: 'Guide held.' })
        .success,
    ).toBe(true);
    expect(
      TriageResultSchema.safeParse({ material: 'yes', priority: 'P2', so_what: 'x' }).success,
    ).toBe(false);
    expect(
      TriageResultSchema.safeParse({ material: true, priority: 'P0', so_what: 'x' }).success,
    ).toBe(false);
    expect(TriageResultSchema.safeParse({ material: true, priority: 'P1' }).success).toBe(false);
    expect(
      TriageResultSchema.safeParse({ material: true, priority: 'P1', so_what: 'x'.repeat(401) })
        .success,
    ).toBe(false);
  });

  it('normalizeTriage repairs over-long so_what instead of rejecting (an unjudged event is worse)', () => {
    const long = Array.from({ length: 60 }, () => 'word').join(' ');
    const r = normalizeTriage({ material: true, priority: 'P2', so_what: long.slice(0, 399) });
    expect(wordCount(r.so_what)).toBeLessThanOrEqual(SO_WHAT_MAX_WORDS);
    expect(() => normalizeTriage({ nope: 1 })).toThrow();
  });

  it('the JSON schema for structured output lists exactly the required fields and forbids extras', () => {
    expect(TRIAGE_JSON_SCHEMA).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['material', 'priority', 'so_what'],
    });
  });
});

describe('applyTriage: models advise, rules decide (decisions D21/D22)', () => {
  const v = (priority: 'P1' | 'P2' | 'P3', material = true) => ({
    material,
    priority,
    so_what: 'x',
  });

  it('never downgrades a rules-assigned P1, whatever the model says', () => {
    expect(applyTriage('P1', v('P3', false))).toBe('P1');
    expect(applyTriage('P1', v('P2'))).toBe('P1');
  });

  it('never downgrades a rules-assigned P2', () => {
    expect(applyTriage('P2', v('P3', false))).toBe('P2');
  });

  it('may upgrade a material P3 to P2 but never to P1', () => {
    expect(applyTriage('P3', v('P2'))).toBe('P2');
    expect(applyTriage('P3', v('P1'))).toBe('P2');
    expect(applyTriage('P3', v('P2', false))).toBe('P3');
    expect(applyTriage('P3', v('P3'))).toBe('P3');
  });

  it('without a rules priority the model is capped at P2 (a model alone cannot create a P1)', () => {
    expect(applyTriage(undefined, v('P1'))).toBe('P2');
    expect(applyTriage(undefined, v('P2'))).toBe('P2');
    expect(applyTriage(undefined, v('P3'))).toBe('P3');
  });
});

describe('resolveFinalPriority: the skipped default is rulePriority ?? P3 (invariant I5)', () => {
  const judged = (priority: 'P1' | 'P2' | 'P3', material = true) => ({
    status: 'judged' as const,
    result: { material, priority, so_what: 'x' },
    model: 'm',
    costUsd: 0,
  });
  it('skipped triage keeps the rules priority; with none the event queues for the close recap (P3)', () => {
    expect(resolveFinalPriority('P1', { status: 'skipped', reason: 'llm_disabled' })).toBe('P1');
    expect(resolveFinalPriority('P2', { status: 'skipped', reason: 'budget_cap' })).toBe('P2');
    expect(resolveFinalPriority(undefined, { status: 'skipped', reason: 'llm_disabled' })).toBe(
      'P3',
    );
    expect(resolveFinalPriority(undefined, { status: 'skipped', reason: 'deadline' })).toBe('P3');
  });
  it('judged triage applies the verdict (model cannot downgrade P1 nor create one)', () => {
    expect(resolveFinalPriority('P1', judged('P3', false))).toBe('P1');
    expect(resolveFinalPriority('P3', judged('P2'))).toBe('P2');
    expect(resolveFinalPriority(undefined, judged('P1'))).toBe('P2');
  });
});

describe('triageFallback: a rules-P1 never waits on the LLM (decision F17, spec section 11 SLA)', () => {
  const ingested = '2026-12-03T12:00:00.000Z';
  const at = (s: number) => new Date(Date.parse(ingested) + s * 1000);
  const eightK = { kind: '8-K', rulePriority: 'P1' as const, items: ['2.02'] };

  it('exempt kinds: rules-P1, any halt, any 8-K with Item 2.02', () => {
    expect(isTriageExempt({ kind: 'form4', rulePriority: 'P1' })).toBe(true);
    expect(isTriageExempt({ kind: 'halt', rulePriority: 'P3' })).toBe(true);
    expect(isTriageExempt({ kind: '8-K', items: ['2.02'] })).toBe(true);
    expect(isTriageExempt({ kind: '8-K', rulePriority: 'P2', items: ['7.01'] })).toBe(false);
    expect(isTriageExempt({ kind: 'news', rulePriority: 'P3' })).toBe(false);
  });

  it('LLM down: a rules-P1 8-K proceeds as skipped/deadline after the deadline (push within the SLA)', () => {
    const down = { status: 'failed' as const, error: 'overloaded', retryable: true };
    const args = { event: eightK, ingestedAt: ingested, deadlineSeconds: 20, lastOutcome: down };
    expect(triageFallback({ ...args, now: at(5) })).toEqual({ proceed: false });
    expect(triageFallback({ ...args, now: at(20) })).toEqual({ proceed: true, reason: 'deadline' });
    expect(triageFallback({ ...args, now: at(120) })).toEqual({
      proceed: true,
      reason: 'deadline',
    });
  });

  it('a refusal (retryable: false) proceeds IMMEDIATELY for an exempt event; it is never dropped as unprocessable', () => {
    const refusal = { status: 'failed' as const, error: 'refused', retryable: false };
    expect(
      triageFallback({
        event: eightK,
        ingestedAt: ingested,
        now: at(1),
        deadlineSeconds: 20,
        lastOutcome: refusal,
      }),
    ).toEqual({ proceed: true, reason: 'error' });
  });

  it('a non-exempt event keeps retrying however long it waits (the attempts cap applies, not a push)', () => {
    const refusal = { status: 'failed' as const, error: 'refused', retryable: false };
    expect(
      triageFallback({
        event: { kind: 'news', rulePriority: 'P3' },
        ingestedAt: ingested,
        now: at(10_000),
        deadlineSeconds: 20,
        lastOutcome: refusal,
      }),
    ).toEqual({ proceed: false });
  });
});

describe('parseTriageRecord (the stored events.triage_json shape)', () => {
  it('accepts judged and skipped records and rejects foreign JSON', () => {
    expect(
      parseTriageRecord({
        outcome: 'judged',
        result: { material: false, priority: 'P3', so_what: 'x' },
        model: 'claude-haiku-5-5',
        costUsd: 0.0001,
      })?.result?.material,
    ).toBe(false);
    expect(parseTriageRecord({ outcome: 'skipped', reason: 'deadline' })?.reason).toBe('deadline');
    expect(parseTriageRecord({ v: 1 })).toBeNull();
    expect(parseTriageRecord(null)).toBeNull();
  });
});
