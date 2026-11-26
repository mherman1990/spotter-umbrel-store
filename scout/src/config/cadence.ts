/**
 * Poll-cadence semantics in ONE place (spec sections 2 and 8). `PollAdapter.pollEveryMs` implementations call
 * these instead of re-deriving the rules:
 *
 *  - EDGAR and IR feeds: `premarket`, `regular` and `afterhours` all use the normal cadence (filings land
 *    16:00-17:30 ET and 06:00-08:00 ET: a 15-minute off-hours cadence there would delay a non-earnings P1 by up
 *    to 15 minutes); ONLY `closed` (nights, weekends, holidays) uses `edgar_offhours_seconds`; `earnings` mode
 *    overrides every phase with the tight cadence.
 *  - Halts feed and option chains: regular session only (`null` otherwise = do not poll now).
 */
import type { MarketPhase } from '../types.js';
import type { Polling } from './schema.js';

export type CadenceMode = 'normal' | 'earnings' | 'backfill';

/** Seconds between EDGAR polls right now. */
export function edgarPollSeconds(polling: Polling, phase: MarketPhase, mode: CadenceMode): number {
  if (mode === 'earnings') return polling.edgar_earnings_seconds;
  return phase === 'closed' ? polling.edgar_offhours_seconds : polling.edgar_seconds;
}

/** Seconds between IR/press-release feed polls right now (same phase rule as EDGAR; off-hours shares its cadence). */
export function irPollSeconds(polling: Polling, phase: MarketPhase, mode: CadenceMode): number {
  if (mode === 'earnings') return polling.ir_earnings_seconds;
  return phase === 'closed'
    ? Math.max(polling.ir_seconds, polling.edgar_offhours_seconds)
    : polling.ir_seconds;
}

/** Halts feed: regular session only. `null` = do not poll. */
export function haltsPollSeconds(polling: Polling, phase: MarketPhase): number | null {
  return phase === 'regular' ? polling.halts_seconds : null;
}

/** Option-chain snapshot: regular session only. `null` = do not poll. */
export function optionsPollSeconds(polling: Polling, phase: MarketPhase): number | null {
  return phase === 'regular' ? polling.options_minutes * 60 : null;
}
