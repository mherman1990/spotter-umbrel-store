/**
 * Living examples of the wave-1 contracts: tiny implementations typed against the interfaces, plus the D10
 * flow (adapter -> orchestrator commit -> pipeline stages) so a breaking contract change fails here first.
 * These are NOT the real modules; they show how the pieces plug together.
 */
import { describe, expect, it } from 'vitest';
import type {
  AdapterDeps,
  PollAdapter,
  PollContext,
  QuoteProvider,
  StreamAdapter,
  StreamStatus,
} from './adapters/types.js';
import { edgarKey, eventId } from './core/ids.js';
import { toExchangeIso } from './core/time.js';
import { applyTriage, resolveFinalPriority, triageFallback } from './engine/schemas.js';
import type {
  AlertBudget,
  BudgetDecision,
  RuleEngine,
  RuleHit,
  TriageOutcome,
  Triager,
} from './engine/types.js';
import type { EarningsHook } from './engine/pipeline-contract.js';
import {
  MAX_HEADLINE_CHARS,
  OPS_KEYS,
  recoveredKey,
  type AlertMessage,
  type FormatPush,
  type Notifier,
} from './notify/types.js';
import {
  makeBars,
  makeDeps,
  makeEvent,
  makeQuoteTick,
  RecordingNotifier,
} from './test-support/index.js';
import type { Event, QuoteTick, Unsubscribe } from './types.js';

/** A minimal EDGAR-like adapter: returns events + a record + a cursor, never writes state itself. */
function exampleAdapter(deps: AdapterDeps): PollAdapter {
  return {
    id: 'example.filings',
    scope: 'ticker',
    sources: ['filing'],
    pollEveryMs: ({ mode }) => (mode === 'earnings' ? 30_000 : 120_000),
    poll(ctx: PollContext) {
      const accession = '0001113809-26-000999';
      const event: Event = {
        id: eventId({
          ticker: ctx.ticker,
          source: 'filing',
          kind: '8-K',
          naturalKey: edgarKey(accession),
        }),
        ticker: ctx.ticker,
        source: 'filing',
        kind: '8-K',
        ts: toExchangeIso(deps.clock.now()),
        payload: { accession, items: ['2.02'] },
      };
      return Promise.resolve({ events: [event], cursor: accession });
    },
  };
}

describe('adapter -> commit contract (decision D10)', () => {
  it('the orchestrator commits events + cursor in one step; a re-poll is a harmless no-op', async () => {
    const d = makeDeps();
    try {
      const adapter = exampleAdapter(d.deps);
      const ctx = (cursor: string | null): PollContext => ({
        ticker: 'BBW',
        tickerConfig: null,
        tickers: [],
        cursor,
        now: d.clock.now(),
        phase: 'regular',
        mode: 'normal',
        signal: new AbortController().signal,
      });
      const r1 = await adapter.poll(ctx(null));
      const c1 = d.store.commitPoll({
        source: adapter.id,
        ticker: 'BBW',
        events: r1.events,
        cursor: r1.cursor,
        now: d.clock.now(),
      });
      expect(c1.inserted).toHaveLength(1);
      expect(d.store.watermarks.get(adapter.id, 'BBW')?.cursor).toBe('0001113809-26-000999');
      const r2 = await adapter.poll(ctx(d.store.watermarks.get(adapter.id, 'BBW')?.cursor ?? null));
      const c2 = d.store.commitPoll({
        source: adapter.id,
        ticker: 'BBW',
        events: r2.events,
        cursor: r2.cursor,
        now: d.clock.now(),
      });
      expect(c2.inserted).toHaveLength(0);
      expect(c2.duplicates).toHaveLength(1);
      expect(d.store.events.byStatus(['new'])).toHaveLength(1);
      expect(
        adapter.pollEveryMs({
          phase: 'regular',
          mode: 'earnings',
          config: d.config,
          ticker: null,
          now: d.clock.now(),
        }),
      ).toBe(30_000);
    } finally {
      d.close();
    }
  });
});

describe('interface shapes compile and compose', () => {
  it('QuoteProvider / StreamAdapter / Notifier / RuleEngine / Triager / AlertBudget / FormatPush can be implemented', async () => {
    const quotes: QuoteProvider = {
      id: 'fake',
      getQuote: () => Promise.resolve(makeQuoteTick()),
      getQuotes: (s) => Promise.resolve(s.map((symbol) => makeQuoteTick({ symbol }))),
      getDailyBars: (_s, n) => Promise.resolve(makeBars(n)),
      getIntradayBars: () => Promise.resolve([]),
      getOptionChain: (u) =>
        Promise.resolve({ underlying: u, asOfMs: 0, underlyingPrice: 41, contracts: [] }),
      getPositions: () => Promise.resolve([]),
    };
    const listeners = new Set<(t: QuoteTick) => void>();
    const status: StreamStatus = {
      state: 'stopped',
      sinceMs: 0,
      lastMessageMs: null,
      lastTickMs: null,
      reconnects: 0,
      detail: null,
    };
    const stream: StreamAdapter = {
      id: 'fake-stream',
      start: () => Promise.resolve(),
      setSymbols: () => undefined,
      stop: () => Promise.resolve(),
      onTick: (l): Unsubscribe => {
        listeners.add(l);
        return () => void listeners.delete(l);
      },
      onStatus: (): Unsubscribe => () => undefined,
      status: () => status,
    };
    const seen: string[] = [];
    const off = stream.onTick((t) => seen.push(t.symbol));
    for (const l of listeners) l(makeQuoteTick());
    off();
    expect(listeners.size).toBe(0);
    expect(seen).toEqual(['BBW']);
    expect((await quotes.getDailyBars('BBW', 3)).length).toBe(3);

    const rules: RuleEngine = {
      classifyEvent: (e): RuleHit[] =>
        e.kind === '8-K'
          ? [{ rule: 'eight_k', priority: 'P1', reason: '8-K filed', facts: {}, naturalKey: e.id }]
          : [],
      evaluateMarket: () => [],
    };
    const triager: Triager = {
      triage: () => Promise.resolve({ status: 'skipped', reason: 'llm_disabled' }),
    };
    const budget: AlertBudget = {
      decide: ({ priority }): BudgetDecision => ({
        action: priority === 'P1' ? 'push_now' : 'queue_digest',
        reason: 'example',
        effects: [],
      }),
    };
    const format: FormatPush = (m) => ({
      headline: m.headline.slice(0, MAX_HEADLINE_CHARS),
      soWhat: m.soWhat ?? null,
      link: m.sourceUrl ?? null,
      text: m.headline,
      truncated: false,
    });
    const notifier: Notifier = new RecordingNotifier('example');

    const event: Event = {
      id: 'e',
      ticker: 'BBW',
      source: 'filing',
      kind: '8-K',
      ts: '2026-12-03T08:00:00.000-05:00',
      payload: {},
    };
    const hits = rules.classifyEvent(event, {} as never);
    const rulePriority = hits[0]?.priority;
    const outcome = await triager.triage({ ...event } as never, { ticker: {} as never, hits });
    expect(outcome.status).toBe('skipped');
    const finalPriority =
      rulePriority === undefined
        ? 'P3'
        : applyTriage(rulePriority, { material: false, priority: 'P3', so_what: '' });
    expect(finalPriority).toBe('P1'); // the model cannot downgrade a rules P1
    const decision = budget.decide({
      event: event as never,
      priority: finalPriority,
      now: new Date(0),
    });
    expect(decision.action).toBe('push_now');
    const msg: AlertMessage = {
      kind: 'alert',
      ticker: 'BBW',
      priority: 'P1',
      headline: 'x'.repeat(400),
      facts: {},
      eventIds: ['e'],
      idempotencyKey: 'k',
    };
    expect(format(msg).headline).toHaveLength(MAX_HEADLINE_CHARS);
    expect((await notifier.send(msg)).ok).toBe(true);
  });
});

describe('living example: a rules-P1 8-K is never held hostage by the LLM (decision F17, spec section 11)', () => {
  it('LLM down + 8-K Item 2.02: the push is enqueued within the triage deadline, as skipped/deadline', async () => {
    const d = makeDeps();
    try {
      const deadlineSeconds = 20;
      const eightK = makeEvent({
        kind: '8-K',
        source: 'filing',
        naturalKey: edgarKey('0001113809-26-000555'),
        payload: { items: ['2.02'] },
        rulePriority: 'P1',
        ts: toExchangeIso(d.clock.now()),
      });
      d.store.commitPoll({
        source: 'edgar.submissions',
        ticker: 'BBW',
        events: [eightK],
        cursor: 'c1',
        now: d.clock.now(),
      });
      const down: Triager = {
        triage: () =>
          Promise.resolve({ status: 'failed', error: 'anthropic 529', retryable: true }),
      };
      const budget: AlertBudget = {
        decide: ({ priority }): BudgetDecision => ({
          action: priority === 'P1' ? 'push_now' : 'queue_digest',
          reason: 'example',
          effects: [],
        }),
      };
      let outcome: TriageOutcome | undefined;
      let pushedAt: number | null = null;
      // the B1 loop in miniature: poll the pending queue every 5 s of fake time
      for (let t = 0; t <= 60 && pushedAt === null; t += 5) {
        d.clock.advance(5000);
        const stored = d.store.events.get(eightK.id);
        if (stored === undefined) throw new Error('event vanished');
        outcome = await down.triage(stored, { ticker: {} as never, hits: [] });
        const fb = triageFallback({
          event: { kind: stored.kind, rulePriority: stored.rulePriority, items: ['2.02'] },
          ingestedAt: stored.createdAt,
          now: d.clock.now(),
          deadlineSeconds,
          lastOutcome: outcome,
        });
        if (!fb.proceed) {
          d.store.events.recordFailure(stored.id, 'anthropic 529', d.clock.now());
          continue;
        }
        const skipped: TriageOutcome = { status: 'skipped', reason: fb.reason };
        const final = resolveFinalPriority(stored.rulePriority, skipped as never);
        d.store.events.markTriaged(
          stored.id,
          { triage: { outcome: 'skipped', reason: fb.reason }, finalPriority: final },
          d.clock.now(),
        );
        const decision = budget.decide({ event: stored, priority: final, now: d.clock.now() });
        expect(decision.action).toBe('push_now');
        d.store.events.setStatus(stored.id, 'pushed', d.clock.now(), { expect: ['triaged'] });
        pushedAt = (d.clock.nowMs() - Date.parse(stored.createdAt)) / 1000;
      }
      expect(pushedAt).toBe(20); // 20 s after ingest = exactly the deadline, far inside the 5-minute SLA
      expect(d.store.events.get(eightK.id)).toMatchObject({
        status: 'pushed',
        finalPriority: 'P1',
        triage: { outcome: 'skipped', reason: 'deadline' },
      });
      expect(d.store.events.get(eightK.id)?.attempts).toBeGreaterThan(0); // retries were recorded, not hidden
    } finally {
      d.close();
    }
  });
});

describe('living example: first-run baseline never floods the budget (invariant I11)', () => {
  it('a baseline poll stores 40 old 8-Ks as dropped; only the genuinely new filing is pending', async () => {
    const d = makeDeps();
    try {
      const adapter: PollAdapter = {
        id: 'edgar.submissions',
        scope: 'ticker',
        sources: ['filing'],
        pollEveryMs: () => 120_000,
        poll: (ctx) => {
          const first = ctx.cursor === null;
          const events = Array.from({ length: first ? 40 : 1 }, (_, i) =>
            makeEvent({
              kind: '8-K',
              naturalKey: edgarKey(`0001113809-26-${String(first ? i : 900).padStart(6, '0')}`),
              ts: toExchangeIso(new Date(ctx.now.getTime() - (first ? (i + 3) * 86_400_000 : 0))),
            }),
          );
          // history on the first run: the adapter flags it, it does not filter by date itself
          return Promise.resolve({ events, cursor: 'cur', ...(first ? { baseline: true } : {}) });
        },
      };
      const ctx = (cursor: string | null): PollContext => ({
        ticker: 'BBW',
        tickerConfig: null,
        tickers: [],
        cursor,
        now: d.clock.now(),
        phase: 'regular',
        mode: 'normal',
        signal: new AbortController().signal,
      });
      const first = await adapter.poll(ctx(null));
      const out = d.store.commitPoll({
        source: adapter.id,
        ticker: 'BBW',
        events: first.events,
        cursor: first.cursor,
        now: d.clock.now(),
        baseline: first.baseline === true,
      });
      expect(out.baselined).toHaveLength(40);
      expect(d.store.events.byStatus(['new'])).toHaveLength(0); // deploy day: nothing to triage or push
      const live = await adapter.poll(
        ctx(d.store.watermarks.get(adapter.id, 'BBW')?.cursor ?? null),
      );
      d.store.commitPoll({
        source: adapter.id,
        ticker: 'BBW',
        events: live.events,
        cursor: live.cursor,
        now: d.clock.now(),
      });
      expect(d.store.events.byStatus(['new'])).toHaveLength(1);
      expect(d.store.events.countByStatus().dropped).toBe(40);
    } finally {
      d.close();
    }
  });
});

describe('living example: ONE P1 per print (invariant I13) and the shared seams', () => {
  it('a claimed 2.02 8-K is parked for the scorecard; a press release folds into it; others pass through', () => {
    const claimedId = 'e-8k';
    const hook: EarningsHook = {
      onNewEvent: () => Promise.resolve(),
      claims: (e) =>
        e.kind === '8-K' && (e.payload['items'] as string[] | undefined)?.includes('2.02') === true,
      foldTargetFor: (e) => (e.kind === 'press_release' ? claimedId : undefined),
    };
    const budget: AlertBudget = {
      decide: ({ event, priority, earnings }): BudgetDecision => {
        if (earnings?.claimed === true)
          return { action: 'hold_scorecard', reason: 'awaiting_scorecard', effects: [] };
        if (earnings?.foldIntoEventId !== undefined)
          return {
            action: 'fold',
            reason: 'press release covered by the scorecard push',
            foldedInto: earnings.foldIntoEventId,
            effects: [
              {
                type: 'link',
                secondaryId: event.id,
                primaryId: earnings.foldIntoEventId,
                relation: 'rewrite',
              },
            ],
          };
        return {
          action: priority === 'P1' ? 'push_now' : 'queue_digest',
          reason: 'x',
          effects: [],
        };
      },
    };
    const mk = (kind: string, payload: Record<string, unknown>) =>
      ({ ...makeEvent({ kind, payload }), status: 'triaged' }) as never as Parameters<
        EarningsHook['claims']
      >[0];
    const eightK = mk('8-K', { items: ['2.02', '9.01'] });
    const pr = mk('press_release', {});
    const form4 = mk('form4', {});
    const run = (e: Parameters<EarningsHook['claims']>[0]) =>
      budget.decide({
        event: e,
        priority: 'P1',
        now: new Date(0),
        earnings: {
          claimed: hook.claims(e),
          ...(hook.foldTargetFor(e) === undefined
            ? {}
            : { foldIntoEventId: hook.foldTargetFor(e) as string }),
        },
      });
    expect(run(eightK).action).toBe('hold_scorecard');
    const folded = run(pr);
    expect(folded).toMatchObject({ action: 'fold', foldedInto: claimedId });
    expect(run(form4).action).toBe('push_now');
  });

  it('ops dedupe keys: every raiser of a condition shares ONE key; recovery has its own', () => {
    expect(OPS_KEYS.SCHWAB_QUOTES_DOWN).toBe('schwab:quotes_down');
    expect(recoveredKey(OPS_KEYS.SCHWAB_QUOTES_DOWN)).toBe('schwab:quotes_down:recovered');
    expect(new Set(Object.values(OPS_KEYS)).size).toBe(Object.values(OPS_KEYS).length);
  });
});
