/**
 * Thesis-breaker detector catalogue (spec section 5: "any hit = P1 'review thesis'").
 *
 * The owner writes breakers as FREE TEXT ("third FY guidance cut"). Scout can only ever say "hit" when a
 * DETERMINISTIC detector produced evidence, so the contract is a CLOSED catalogue of detectors plus a
 * documented normalized-keyword matcher from the owner's sentence to detector ids:
 *
 *  - {@link matchBreakers} maps a sentence to zero or more {@link BreakerRule}s. A sentence that matches NOTHING
 *    (`<add your own>` aside, any owner-invented breaker) is reported `unknown` by `/plan` and the briefs and
 *    NEVER auto-hits.
 *  - B4 (`src/engine/earnings/breakers.ts`) EVALUATES the matched detectors after each scorecard, from
 *    `guidance_history` and `ScorecardKpis`, and emits a `thesis_breaker` Event per hit through
 *    `Pipeline.ingest` (natural key `breakerKey(ticker, period, detectorId)`, source `filing`, always P1; A6
 *    only classifies it). B3's plan/position report derives each `BreakerStatus` from those events
 *    (`hit` with `evidenceEventIds`, `clear` when a matched detector has no event, `unknown` when unmatched).
 *
 * Evaluation rules (B4 implements; every input is a stored fact, never model prose):
 *  - `guidance_cut_count`: count of fiscal-year guidance CUTS (deterministic verdict `cut` on revenue or pretax
 *    income, from `guidance_history` across consecutive prints of that fiscal year) >= `threshold`.
 *  - `dividend_cut_or_suspension`: `kpis.dividend.change` is `cut` or `suspended`.
 *  - `buyback_suspension`: `kpis.buybackStatus` is `suspended`.
 *  - `revolver_draw`: revolver drawn amount rose versus the prior quarter while buybacks or dividends were paid
 *    in the same quarter ("revolver draw to fund buybacks/dividend"; a proxy, labelled as such in the evidence).
 */

import { BREAKER_DETECTORS, type BreakerDetectorId } from '../types.js';

export { BREAKER_DETECTORS };
export type { BreakerDetectorId };

export interface BreakerRule {
  detector: BreakerDetectorId;
  /** `guidance_cut_count` only: the cut number at which it hits ("third FY guidance cut" -> 3). Null otherwise. */
  threshold: number | null;
}

const ORDINALS: Readonly<Record<string, number>> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  '1st': 1,
  '2nd': 2,
  '3rd': 3,
  '4th': 4,
  '5th': 5,
};

/** Lower-case, punctuation to spaces, collapsed whitespace. */
export function normalizeBreakerText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const has = (norm: string, re: RegExp): boolean => re.test(norm);

/**
 * Map an owner-written breaker sentence to the detectors that can evaluate it (possibly several: "dividend cut
 * or buyback suspension" is two). Deterministic keyword matching on the normalized text; order follows
 * {@link BREAKER_DETECTORS}. Empty array = Scout cannot evaluate this breaker (reported `unknown`).
 *
 * @example
 * matchBreakers('third FY guidance cut') // [{ detector: 'guidance_cut_count', threshold: 3 }]
 */
export function matchBreakers(text: string): BreakerRule[] {
  const n = normalizeBreakerText(text);
  if (n === '') return [];
  // A sentence about a revolver draw "to fund buybacks/dividend" is ONE condition: the buyback/dividend words
  // describe the use of proceeds, not a second breaker.
  if (has(n, /\b(revolver|revolving|credit facility|line of credit)\b/)) {
    return [{ detector: 'revolver_draw', threshold: null }];
  }
  const out: BreakerRule[] = [];
  if (
    has(n, /\b(guidance|guide|outlook)\b/) &&
    has(
      n,
      /\b(cut|cuts|lower|lowered|lowers|lowering|reduce|reduced|reduction|withdraw|withdrawn|withdrawal)\b/,
    )
  ) {
    let threshold = 1;
    for (const word of n.split(' ')) {
      const o = ORDINALS[word];
      if (o !== undefined) {
        threshold = o;
        break;
      }
    }
    out.push({ detector: 'guidance_cut_count', threshold });
  }
  if (
    has(n, /\bdividends?\b/) &&
    has(
      n,
      /\b(cut|cuts|suspend|suspended|suspension|eliminate|eliminated|elimination|omit|omitted|slash|slashed)\b/,
    )
  ) {
    out.push({ detector: 'dividend_cut_or_suspension', threshold: null });
  }
  if (
    has(n, /\b(buyback|buybacks|repurchase|repurchases)\b/) &&
    has(
      n,
      /\b(suspend|suspended|suspension|halt|halted|pause|paused|cancel|cancelled|canceled|eliminate|eliminated|cut|cuts)\b/,
    )
  ) {
    out.push({ detector: 'buyback_suspension', threshold: null });
  }
  return out;
}
