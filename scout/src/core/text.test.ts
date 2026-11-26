import { describe, expect, it } from 'vitest';
import { jaccard, normalizeTitle, scoreNearDuplicate, wordShingles } from './text.js';

describe('normalizeTitle', () => {
  it('folds case, diacritics, punctuation and the trailing publisher suffix', () => {
    expect(normalizeTitle('Build-A-Bear Raises FY Outlook - Reuters')).toBe(
      'build a bear raises fy outlook',
    );
    expect(normalizeTitle('Café  Q3: Sales & Earnings | Business Wire')).toBe(
      'cafe q3 sales and earnings',
    );
    expect(normalizeTitle('  ')).toBe('');
  });

  it('drops only ONE trailing suffix and keeps hyphenated content words', () => {
    expect(normalizeTitle('Self-Employed Tax - Report - AP')).toBe('self employed tax report');
  });
});

describe('near-duplicate scoring', () => {
  it('shingles are word 3-grams; short titles yield a single shingle; empty yields none', () => {
    expect([...wordShingles('a b c d')]).toEqual(['a b c', 'b c d']);
    expect([...wordShingles('a b')]).toEqual(['a b']);
    expect(wordShingles('').size).toBe(0);
    expect(jaccard(new Set<string>(), new Set<string>())).toBe(0);
  });

  it('the same release rewritten by an outlet scores above the default 0.6 threshold; unrelated news does not', () => {
    const a = normalizeTitle('Build-A-Bear Workshop Reports Third Quarter Fiscal 2026 Results');
    const b = normalizeTitle(
      'Build-A-Bear Workshop Reports Third Quarter Fiscal 2026 Results - Yahoo Finance',
    );
    const c = normalizeTitle('Build-A-Bear opens new flagship store in London');
    expect(scoreNearDuplicate({ titleNorm: a }, { titleNorm: b })).toBeGreaterThanOrEqual(0.6);
    expect(scoreNearDuplicate({ titleNorm: a }, { titleNorm: c })).toBeLessThan(0.6);
  });

  it('is symmetric and returns 1 for the same folded URL regardless of title', () => {
    const x = { titleNorm: 'alpha beta gamma delta', url: 'http://www.example.com/a?utm_source=t' };
    const y = { titleNorm: 'completely different words here', url: 'https://example.com/a' };
    expect(scoreNearDuplicate(x, y)).toBe(1);
    expect(scoreNearDuplicate(y, x)).toBe(1);
    const p = { titleNorm: 'alpha beta gamma delta epsilon' };
    const q = { titleNorm: 'alpha beta gamma zeta eta' };
    expect(scoreNearDuplicate(p, q)).toBe(scoreNearDuplicate(q, p));
    expect(scoreNearDuplicate(p, q)).toBeGreaterThan(0);
    expect(scoreNearDuplicate({ titleNorm: '' }, { titleNorm: '' })).toBe(0);
  });
});
