/**
 * Runtime schemas for the LLM-facing engine shapes. The model's JSON is UNTRUSTED OUTPUT: it is parsed with
 * these zod schemas before anything uses it (decision D22), and it can only set `material`, a priority
 * suggestion and a short so-what - never a number.
 */
import { z } from 'zod';
import type { Priority } from '../types.js';
import type { ApplyTriage, TriageOutcome, TriageRecord, TriageResult } from './types.js';

/** Max words in `so_what` (spec section 7). */
export const SO_WHAT_MAX_WORDS = 25;

/** Number of whitespace-separated words. */
export function wordCount(text: string): number {
  const t = text.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

/** Collapse whitespace and cut to at most `maxWords` words (appending an ellipsis when cut). */
export function clampWords(text: string, maxWords = SO_WHAT_MAX_WORDS): string {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '');
  if (words.length <= maxWords) return words.join(' ');
  return `${words.slice(0, maxWords).join(' ')}…`;
}

/**
 * Triage verdict as the model must return it. `so_what` is validated loosely (<= 400 chars) and then
 * clamped to 25 words by {@link normalizeTriage}; over-long output is repaired, not rejected, because a
 * rejected verdict would leave an event unjudged.
 */
export const TriageResultSchema = z.object({
  material: z.boolean(),
  priority: z.enum(['P1', 'P2', 'P3']),
  so_what: z.string().max(400),
});

/** JSON Schema for `output_config.format` (supported subset: no length constraints). */
export const TRIAGE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    material: { type: 'boolean' },
    priority: { type: 'string', enum: ['P1', 'P2', 'P3'] },
    so_what: { type: 'string' },
  },
  required: ['material', 'priority', 'so_what'],
  additionalProperties: false,
};

/** Validate and normalize (collapse whitespace, clamp to 25 words) a model verdict. @throws ZodError. */
export function normalizeTriage(raw: unknown): TriageResult {
  const parsed = TriageResultSchema.parse(raw);
  return {
    material: parsed.material,
    priority: parsed.priority,
    so_what: clampWords(parsed.so_what),
  };
}

const RANK: Record<Priority, number> = { P1: 1, P2: 2, P3: 3 };

/**
 * Final priority after triage (decision D21/D22):
 *  - with a rules priority: the model may only UPGRADE P3 -> P2 (a model suggestion of P1 or P2 on a
 *    material P3 yields P2; it can never reach P1 and never downgrade);
 *  - with no rules priority: the model's priority, capped at P2 (a model alone can never create a P1).
 */
export const applyTriage: ApplyTriage = (rulePriority, result) => {
  if (rulePriority === undefined) return RANK[result.priority] < RANK.P2 ? 'P2' : result.priority;
  if (rulePriority === 'P3' && result.material && result.priority !== 'P3') return 'P2';
  return rulePriority;
};

/**
 * Final priority of an event once its triage step is DONE (invariant I5):
 *  - `judged`: {@link applyTriage}(rulePriority, verdict);
 *  - `skipped` (policy, spend cap, deadline, error...): `rulePriority ?? 'P3'`. An event no rule fired for (a short
 *    interest update below thresholds, a small Form 4, an award/withholding) queues for the close recap; it is not
 *    dropped and not left without a priority.
 */
export function resolveFinalPriority(
  rulePriority: Priority | undefined,
  outcome: Exclude<TriageOutcome, { status: 'failed' }>,
): Priority {
  if (outcome.status === 'judged') return applyTriage(rulePriority, outcome.result);
  return rulePriority ?? 'P3';
}

/** True when this event must NEVER wait on the LLM: a rules-P1, any halt, any 8-K carrying Item 2.02. */
export function isTriageExempt(event: {
  kind: string;
  rulePriority?: Priority | undefined;
  items?: readonly string[] | undefined;
}): boolean {
  return (
    event.rulePriority === 'P1' ||
    event.kind === 'halt' ||
    (event.kind === '8-K' && (event.items ?? []).includes('2.02'))
  );
}

/**
 * Decide whether the pipeline stops waiting for triage (invariant I2, decision F17). Haiku only supplies the
 * so-what and P3 -> P2 upgrades, so a RULES-P1 event (and every halt and 2.02 event) must not be delayed or
 * lost by an Anthropic outage, a refusal (`retryable: false`) or a slow queue (spec section 11 needs the P1
 * within 5 minutes). For such an event this returns `{ proceed: true, reason }`: record triage `skipped` with
 * that reason and continue to the budget. Every other event returns `{ proceed: false }`: it stays `new` and
 * retries with backoff, and only after `pipeline.triage_max_attempts` is it dropped as `unprocessable`.
 *
 *  - `error`: the last attempt failed NON-retryably (a refusal will not succeed on retry);
 *  - `deadline`: `deadlineSeconds` elapsed since the event was ingested (`createdAt`) without a verdict.
 */
export function triageFallback(args: {
  event: {
    kind: string;
    rulePriority?: Priority | undefined;
    items?: readonly string[] | undefined;
  };
  /** ISO instant the event row was created (ingest time). */
  ingestedAt: string;
  now: Date;
  deadlineSeconds: number;
  /** The most recent triage attempt's outcome, when one was made. */
  lastOutcome?: TriageOutcome | undefined;
}): { proceed: true; reason: 'deadline' | 'error' } | { proceed: false } {
  if (!isTriageExempt(args.event)) return { proceed: false };
  if (args.lastOutcome?.status === 'failed' && !args.lastOutcome.retryable)
    return { proceed: true, reason: 'error' };
  const waitedMs = args.now.getTime() - Date.parse(args.ingestedAt);
  if (waitedMs >= args.deadlineSeconds * 1000) return { proceed: true, reason: 'deadline' };
  return { proceed: false };
}

const TriageRecordSchema = z.object({
  outcome: z.enum(['judged', 'skipped']),
  result: TriageResultSchema.optional(),
  model: z.string().optional(),
  costUsd: z.number().optional(),
  reason: z
    .enum(['llm_disabled', 'budget_cap', 'context_only', 'policy', 'deadline', 'error'])
    .optional(),
});

/** Parse the stored `events.triage_json` (or null when the event was never triaged / the JSON is foreign). */
export function parseTriageRecord(raw: unknown): TriageRecord | null {
  const parsed = TriageRecordSchema.safeParse(raw);
  return parsed.success ? (parsed.data as TriageRecord) : null;
}
