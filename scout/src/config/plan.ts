/**
 * Position plan (`position_plan.yaml`, spec section 5). The OWNER fills this in; Scout reports against it and
 * NEVER edits it. The file is owner-private (git-ignored); only `position_plan.example.yaml` is committed.
 *
 * TOLERANCE (hard requirement): an unfilled template must load. Any value written as an angle-bracket
 * placeholder (`<manual>`, `<blue: manual>`, `<price or event>`), a blank, or a null becomes an `unset`
 * {@link Slot} - never an exception - and {@link PositionPlan.completeness} lists exactly what is still
 * missing. Briefs and `/plan` surface that list instead of guessing.
 */
import { z } from 'zod';
import { hashJson } from '../core/ids.js';

export type UnsetReason = 'placeholder' | 'missing' | 'invalid';

/** A plan value that is either set or explicitly unset (with why, and the raw text the owner wrote). */
export type Slot<T> =
  { status: 'set'; value: T } | { status: 'unset'; reason: UnsetReason; raw: string | null };

/** `<...>` placeholder text such as `<manual>` or `<blue: manual>`. */
export function isPlaceholder(value: unknown): boolean {
  return typeof value === 'string' && /^<[^<>]*>$/.test(value.trim());
}

const unset = (reason: UnsetReason, raw: string | null): Slot<never> => ({
  status: 'unset',
  reason,
  raw,
});

/** Sanity bounds for a numeric plan value; a value outside them is `unset` (reason `invalid`), never silently "set". */
export interface NumberRange {
  min?: number;
  /** When true the bound is exclusive (`target_shares` must be > 0, not >= 0). */
  minExclusive?: boolean;
  max?: number;
}

function inRange(n: number, r: NumberRange): boolean {
  if (r.min !== undefined && (r.minExclusive === true ? n <= r.min : n < r.min)) return false;
  if (r.max !== undefined && n > r.max) return false;
  return true;
}

/**
 * Coerce a raw YAML value to a numeric slot. Accepts numbers and strings like `"1,200"`, `"$45.50"`, `"5%"`.
 * With `range`, an out-of-range value (`target_shares: -5`, `review_below: 0`, `pct_of_target: 140`) becomes an
 * `unset` slot with reason `invalid` (and the raw text kept), so completeness reports it.
 */
export function numberSlot(raw: unknown, range: NumberRange = {}): Slot<number> {
  if (raw === undefined || raw === null) return unset('missing', null);
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return unset('invalid', String(raw));
    return inRange(raw, range) ? { status: 'set', value: raw } : unset('invalid', String(raw));
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '') return unset('missing', null);
    if (isPlaceholder(t)) return unset('placeholder', t);
    const n = Number(t.replace(/[$,%\s]/g, ''));
    if (!Number.isFinite(n) || !/\d/.test(t)) return unset('invalid', t);
    return inRange(n, range) ? { status: 'set', value: n } : unset('invalid', t);
  }
  return unset('invalid', String(raw));
}

/** > 0 (shares, prices). */
const POSITIVE: NumberRange = { min: 0, minExclusive: true };
/** (0, 100] (percentages). */
const PERCENT: NumberRange = { min: 0, minExclusive: true, max: 100 };

/** Coerce a raw YAML value to a free-text slot (placeholders and blanks are unset). */
export function textSlot(raw: unknown): Slot<string> {
  if (raw === undefined || raw === null) return unset('missing', null);
  if (typeof raw !== 'string') return { status: 'set', value: String(raw) };
  const t = raw.trim();
  if (t === '') return unset('missing', null);
  if (isPlaceholder(t)) return unset('placeholder', t);
  return { status: 'set', value: t };
}

export interface PlanTranche {
  label: string;
  /** Percent of target shares this tranche represents. */
  pct_of_target: Slot<number>;
  /** Free-text condition (price or event), owner-written. */
  condition: Slot<string>;
}

/** One ticker's plan, normalized. */
export interface TickerPlan {
  ticker: string;
  /**
   * Thesis markdown file NAME, resolved relative to `storage.thesis_dir` (never the plan file's directory) by
   * `resolveThesisPath`: absolute paths, `..` and symlink escapes are rejected. Null when none is named.
   */
  thesis_file: string | null;
  max_position_pct_of_liquid_net_worth: Slot<number>;
  target_shares: Slot<number>;
  tranches: PlanTranche[];
  /**
   * Real breakers only (placeholders such as `<add your own>` are excluded). Any hit = P1 "review thesis". These
   * are the owner's FREE TEXT: Scout evaluates only the ones `matchBreakers` (engine/breakers.ts) maps to a
   * deterministic detector; every other breaker is reported `unknown` and never auto-hits.
   */
  thesis_breakers: string[];
  /** How many `<...>` placeholder breakers were present (reported as incomplete when no real breaker exists). */
  placeholder_breakers: number;
  price_levels: { review_below: Slot<number>; trim_above: Slot<number> };
  earnings_rule: Slot<string>;
}

export interface MissingPlanField {
  ticker: string;
  /** Dotted path, e.g. `target_shares`, `tranches[1].condition`, `price_levels.review_below`. */
  field: string;
  reason: UnsetReason | 'none_defined';
  /** The raw placeholder text the owner left, when any. */
  raw: string | null;
}

export interface PlanCompleteness {
  complete: boolean;
  /** Number of plan fields that are set. */
  setCount: number;
  totalCount: number;
  missing: MissingPlanField[];
  /**
   * Sanity warnings that do NOT make the plan incomplete: tranche percentages that do not sum to ~100,
   * `review_below` not below `trim_above`.
   */
  warnings: string[];
}

/**
 * The parsed plan. Plain data inside, with helpers; JSON-serializable via `toJSON()` (what `/plan` returns).
 *
 * @example
 * ```ts
 * const plan = loadPositionPlan('/data/position_plan.yaml');
 * const bbw = plan.get('BBW');
 * if (bbw?.price_levels.review_below.status === 'set') { ... }
 * plan.completeness().missing.map((m) => `${m.ticker}.${m.field}`);
 * ```
 */
export class PositionPlan {
  constructor(private readonly plans: Readonly<Record<string, TickerPlan>>) {}

  /** Tickers present in the plan, sorted. */
  tickers(): string[] {
    return Object.keys(this.plans).sort();
  }

  get(ticker: string): TickerPlan | undefined {
    return this.plans[ticker.toUpperCase()];
  }

  has(ticker: string): boolean {
    return this.get(ticker) !== undefined;
  }

  /** Completeness across all tickers, or just `ticker`. */
  completeness(ticker?: string): PlanCompleteness {
    const missing: MissingPlanField[] = [];
    const warnings: string[] = [];
    let total = 0;
    let set = 0;
    const check = (t: string, field: string, slot: Slot<unknown>): void => {
      total++;
      if (slot.status === 'set') set++;
      else missing.push({ ticker: t, field, reason: slot.reason, raw: slot.raw });
    };
    const symbols = ticker === undefined ? this.tickers() : [ticker.toUpperCase()];
    for (const sym of symbols) {
      const p = this.plans[sym];
      if (p === undefined) continue;
      check(sym, 'max_position_pct_of_liquid_net_worth', p.max_position_pct_of_liquid_net_worth);
      check(sym, 'target_shares', p.target_shares);
      if (p.tranches.length === 0) {
        total++;
        missing.push({ ticker: sym, field: 'tranches', reason: 'none_defined', raw: null });
      }
      p.tranches.forEach((tr, i) => {
        check(sym, `tranches[${i}].pct_of_target`, tr.pct_of_target);
        check(sym, `tranches[${i}].condition`, tr.condition);
      });
      total++;
      if (p.thesis_breakers.length > 0) set++;
      else
        missing.push({ ticker: sym, field: 'thesis_breakers', reason: 'none_defined', raw: null });
      check(sym, 'price_levels.review_below', p.price_levels.review_below);
      check(sym, 'price_levels.trim_above', p.price_levels.trim_above);
      check(sym, 'earnings_rule', p.earnings_rule);

      const pcts = p.tranches.map((t) => t.pct_of_target);
      if (pcts.length > 0 && pcts.every((x) => x.status === 'set')) {
        const sum = pcts.reduce((a, x) => a + (x.status === 'set' ? x.value : 0), 0);
        if (Math.abs(sum - 100) > 0.5) {
          warnings.push(`${sym}: tranche pct_of_target values sum to ${sum} (expected 100)`);
        }
      }
      const { review_below: lo, trim_above: hi } = p.price_levels;
      if (lo.status === 'set' && hi.status === 'set' && lo.value >= hi.value) {
        warnings.push(
          `${sym}: price_levels.review_below (${lo.value}) is not below trim_above (${hi.value})`,
        );
      }
    }
    return {
      complete: missing.length === 0,
      setCount: set,
      totalCount: total,
      missing,
      warnings,
    };
  }

  /** Stable content hash; B3 snapshots the plan (`plan_snapshots`) when it changes. */
  hash(): string {
    return hashJson(this.plans);
  }

  toJSON(): { tickers: Record<string, TickerPlan>; completeness: PlanCompleteness } {
    return { tickers: { ...this.plans }, completeness: this.completeness() };
  }
}

// ---------------------------------------------------------------------------------------------
// zod schema (tolerant)
// ---------------------------------------------------------------------------------------------

const RawTranche = z.object({
  label: z.union([z.string(), z.number()]).transform(String).default('unnamed'),
  pct_of_target: z.unknown().optional(),
  condition: z.unknown().optional(),
});

const RawTickerPlan = z.object({
  thesis_file: z.unknown().optional(),
  max_position_pct_of_liquid_net_worth: z.unknown().optional(),
  target_shares: z.unknown().optional(),
  tranches: z.array(RawTranche).nullish(),
  thesis_breakers: z.array(z.unknown()).nullish(),
  price_levels: z
    .object({ review_below: z.unknown().optional(), trim_above: z.unknown().optional() })
    .nullish(),
  earnings_rule: z.unknown().optional(),
});

function normalizeTicker(ticker: string, raw: z.output<typeof RawTickerPlan> | null): TickerPlan {
  const r = raw ?? {};
  const breakers: string[] = [];
  let placeholders = 0;
  for (const b of r.thesis_breakers ?? []) {
    const slot = textSlot(b);
    if (slot.status === 'set') breakers.push(slot.value);
    else placeholders++;
  }
  const thesis = textSlot(r.thesis_file);
  return {
    ticker,
    thesis_file: thesis.status === 'set' ? thesis.value : null,
    max_position_pct_of_liquid_net_worth: numberSlot(
      r.max_position_pct_of_liquid_net_worth,
      PERCENT,
    ),
    target_shares: numberSlot(r.target_shares, POSITIVE),
    tranches: (r.tranches ?? []).map((t) => ({
      label: t.label,
      pct_of_target: numberSlot(t.pct_of_target, PERCENT),
      condition: textSlot(t.condition),
    })),
    thesis_breakers: breakers,
    placeholder_breakers: placeholders,
    price_levels: {
      review_below: numberSlot(r.price_levels?.review_below, POSITIVE),
      trim_above: numberSlot(r.price_levels?.trim_above, POSITIVE),
    },
    earnings_rule: textSlot(r.earnings_rule),
  };
}

/**
 * Tolerant plan schema: top-level map of TICKER -> plan. Unknown keys are ignored; unfilled placeholders become
 * `unset` slots. Output is a {@link PositionPlan}.
 */
export const PositionPlanSchema = z
  .record(z.string(), RawTickerPlan.nullable())
  .transform((rec) => {
    const plans: Record<string, TickerPlan> = {};
    for (const [key, value] of Object.entries(rec)) {
      const ticker = key.trim().toUpperCase();
      plans[ticker] = normalizeTicker(ticker, value);
    }
    return new PositionPlan(plans);
  });

export type PositionPlanInput = z.input<typeof PositionPlanSchema>;
