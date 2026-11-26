import { describe, expect, it } from 'vitest';
import { matchBreakers, normalizeBreakerText, BREAKER_DETECTORS } from './breakers.js';

describe('matchBreakers: the shipped example breakers map to detectors', () => {
  it('"third FY guidance cut" -> guidance_cut_count with threshold 3', () => {
    expect(matchBreakers('third FY guidance cut')).toEqual([
      { detector: 'guidance_cut_count', threshold: 3 },
    ]);
  });

  it('"dividend cut or buyback suspension" -> BOTH detectors', () => {
    expect(matchBreakers('dividend cut or buyback suspension').map((r) => r.detector)).toEqual([
      'dividend_cut_or_suspension',
      'buyback_suspension',
    ]);
  });

  it('"revolver draw to fund buybacks/dividend" is ONE condition (the use of proceeds is not a second breaker)', () => {
    expect(matchBreakers('revolver draw to fund buybacks/dividend')).toEqual([
      { detector: 'revolver_draw', threshold: null },
    ]);
  });

  it('ordinals and digits set the guidance threshold; a bare "guidance cut" is the first', () => {
    expect(matchBreakers('2nd guidance cut in a row')[0]?.threshold).toBe(2);
    expect(matchBreakers('Guidance cut')[0]?.threshold).toBe(1);
    expect(matchBreakers('FY outlook lowered again')[0]?.detector).toBe('guidance_cut_count');
    expect(matchBreakers('guidance withdrawn')[0]?.detector).toBe('guidance_cut_count');
  });

  it('anything Scout cannot evaluate matches nothing (reported unknown, never auto-hit)', () => {
    expect(matchBreakers('CEO departs')).toEqual([]);
    expect(matchBreakers('<add your own>')).toEqual([]);
    expect(matchBreakers('')).toEqual([]);
    expect(matchBreakers('dividend raised')).toEqual([]);
    expect(matchBreakers('buyback accelerated')).toEqual([]);
  });

  it('is case/punctuation-insensitive and the catalogue is closed', () => {
    expect(normalizeBreakerText('  Dividend--CUT!! ')).toBe('dividend cut');
    expect(matchBreakers('DIVIDEND SUSPENDED')[0]?.detector).toBe('dividend_cut_or_suspension');
    expect(BREAKER_DETECTORS).toHaveLength(4);
  });
});
