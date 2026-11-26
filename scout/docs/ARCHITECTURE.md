# Scout architecture

Scout is a read-only, self-hosted equity watch agent: deterministic rules decide what matters, an alert budget
decides what reaches the owner's phone, and the owner's OpenClaw agent (Mayer) delivers the words. This document
is the map for everyone building against the foundation: module layout, data flow, the contract files, who owns
which file in wave 1, and the ground rules that keep parallel work from colliding.

Decisions are in [`DECISIONS.md`](./DECISIONS.md) (D1-D32 plus foundation clarifications F1-F27); project rules in
[`../CLAUDE.md`](../CLAUDE.md). When this file and a decision disagree, the decision wins.

## 1. Module map

```
scout/
  config/                 coverage.yaml (all tunables) . position_plan.example.yaml . thesis/BBW.example.md . scout.env.example
  src/
    types.ts              Event + payload shapes + KIND_SOURCE + market data types + DomainRecord + QuoteSnapshotSource  [contract]
    event-payloads.ts     zod schemas per event kind + parseEventPayload (the invariant I8 detector)
    core/                 clock (Clock + Scheduler) . errors . redact . logger . ids (key table) . text (title normalize, near-duplicate scorer)
                          . time . calendar . egress . http . egress-post . ws
    config/               schema (zod 4, STRICT) . plan (tolerant position plan) . load (YAML/files, config location + live reload,
                          egress builders, thesis path) . cadence (poll-cadence rules) . secrets (the ONLY process.env reader)
    store/                db . migrate . migrations/0001_initial . retention . repos/* . index (Store facade, commitPoll, ReadStore)
    adapters/             types.ts [contract]; filings/ quotes/ shorts/ macro/ news/ halts/ inbox/   (wave 1: A1-A4; options poll: B2)
    notify/               types.ts [contract]; openclaw ntfy router outbox ops agent-hook             (wave 1: A5)
    llm/                  types.ts [contract]; anthropic gateway models batch fact-sheet prompts/     (wave 1: A8)
    engine/               types.ts schemas.ts breakers.ts pipeline-contract.ts [contracts]; rules metrics/ budget dedupe describe
                          format-push digest triage synth deep (A6-A8); events pipeline orchestrator context (B1); earnings/ (B4)
    briefs/               deterministic brief payload builders + BriefService                         (B3)
    plan/                 position-plan reporting (levels, tranches, breakers -> PlanStatus)          (B3)
    health/               HealthMonitor: evaluate + alert with cooldown and recovery                  (B3)
    api/                  types.ts [contract]; node:http read-only server, auth, routes               (B3)
    jobs/                 scheduler (node-cron + NYSE calendar) and cron jobs                         (B2)
    replay/               replay harness                                                             (B4)
    app.ts index.ts cli.ts cli/    composition root, entry, CLI commands                              (B2; index/cli are stubs now)
    test-support/         fakes + factories for every module's tests (never in the build)
  test/policy/            no-orders . egress/secrets/isolation/purity policy tests (CI tripwires)
  test/acceptance/        spec section 11 acceptance tests                                            (B4)
  test/fixtures/          fixtures; non-recorded ones are labelled SYNTHETIC
  scripts/                guard-no-orders (foundation) . check-store . bump-store . record-fixture    (B5/B4)
  umbrel-store/herman-scout/   Umbrel packaging                                                       (B5)
  openclaw-skill/scout/SKILL.md   the Mayer skill                                                     (A5)
  docs/                   ARCHITECTURE . DECISIONS . OPENCLAW_SETUP . THREAT_MODEL . VERIFY_LIVE . RUNBOOK
```

Deviations from the spec's layout (all intentional): notifiers live in `src/notify/` (not `adapters/notify/`);
the schema is `src/store/migrations/0001_initial.ts` (not `store/schema.sql`) so migrations are static, ordered,
checksummed modules.

## 2. Data flow

```
 EDGAR . Schwab REST/stream . FINRA . FRED . RSS/IR . Nasdaq halts . IMAP inbox          (egress: ONLY via core/http | egress-post | ws)
        |  PollAdapter.poll() -> { events, records, cursor, baseline? }   (pure: no writes, no LLM)  [adapters/types.ts]
        v
 [S1 COMMIT] Store.commitPoll: events(status new) + domain records + watermark   ONE transaction     [decision D10]
             baseline (first run / backfill) and stale catch-up events are stored 'dropped' (I11)
        v
 [S2 RULES]  RuleEngine.classifyEvent / evaluateMarket  (pure, deterministic)  -> rule_priority      [engine/types.ts]
        v
 [S2.5 DEDUPE] SemanticDeduper: a secondary attaches to its primary BEFORE triage (no LLM call)       [A7]
        v
 [S3 TRIAGE] Triager (Haiku, in-process): may set so_what, upgrade P3->P2, never downgrade a rules P1
             judged | skipped -> 'triaged'      failed -> stays 'new' (retry with backoff)
             a rules-P1 / halt / 2.02 event NEVER waits on the LLM: skipped(deadline|error) after 20 s (I2)
        v
 [S4 BUDGET] AlertBudget.decide -> push_now | queue_digest | hold_quiet | hold_scorecard | fold | drop   (no side effects)
             pipeline applies decision + effects + outbox enqueue in ONE transaction
        v
 [S5 NOTIFY] OutboxWorker (single-flight, leased) -> NotifyRouter -> OpenClaw hook (Mayer -> Telegram), fallback ntfy
        v
 brief jobs (06:40 11:25 15:10 Sat 07:50, America/Chicago; 5 min BEFORE Mayer's crons): BriefService payload ->
   materialized in kv `brief:` + events marked digested -> Mayer fetches /brief/<type> (the stored snapshot)
 local read-only API (Bearer token, GET/HEAD only): /snapshot /events /position /plan /brief/<type> /scorecard /health
```

Current quotes: A2's `QuoteTracker` (stream, in memory) and the `quotes_snapshot` job (REST `getQuotes` for
tickers, benchmarks and futures: every 60 s in RTH, every 15 min otherwise) persist `QuoteTick`s to kv
`quote:<SYMBOL>` (`Store.latestQuotes`). Everything that needs a current price reads it through
`QuoteSnapshotSource` (rule context, `/snapshot`, briefs, relative performance): there is one place a price can
come from, and `BriefService` stays store-only and synchronous.

Earnings path (spec section 8, decision D21): 8-K Item 2.02 -> `EarningsHook.claims` (the generic push is PARKED,
`hold_scorecard`) -> fetch Ex. 99.1 -> Opus extraction (`ScorecardExtractor`, bounded by
`earnings.extraction_timeout_seconds`) -> guidance comparison IN CODE -> lead line from `LEAD_LINES` -> ONE P1 via
the OpenClaw `/hooks/agent` call with a model override. A press release near the print folds into it. If the
scorecard is not ready at `earnings.push_deadline_seconds` (240 s), or extraction fails, the generic P1 goes out
with `Guide: unknown - read the 8-K`. The pair counts once and is exempt from the P1 cap (invariant I13).

Event lifecycle (`events.status`): `new -> triaged -> {pushed | queued | folded | dropped}`, `queued -> digested`;
history (`baseline`, `stale`) goes straight to `dropped`. The invariants I1-I14 every implementation must honor are
in `src/engine/pipeline-contract.ts`.

## 3. Contracts index (read these first)

| File                                   | What it fixes                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`                         | `Event` (spec shape + `finalPriority`), `EVENT_KINDS`, `KIND_SOURCE`, per-kind payload interfaces, `BREAKER_DETECTORS`, `DailyBar`, `QuoteTick`, `QuoteSnapshotSource`, option chain, `Position`, short-interest/Reg SHO records, `DomainRecord` union                                                                                                   |
| `src/event-payloads.ts`                | zod schema per well-known kind, `parseEventPayload` (malformed-payload detector for I8)                                                                                                                                                                                                                                                                  |
| `src/core/ids.ts`                      | `eventId` and the AUTHORITATIVE natural-key table: one builder per kind (`edgarKey`, `form4Key`, `priceMoveKey`, `volumePaceKey`, `haltKey`, `planLevelKey`, `breakerKey`, `optionsKey`, `newsKey`, `newsletterKey`...), `urlKey`                                                                                                                        |
| `src/core/text.ts`                     | `normalizeTitle`, `scoreNearDuplicate` (`NearDuplicateScorer`): the ONE near-duplicate scorer (A4 fills `titleNorm`, A7 applies the policy)                                                                                                                                                                                                              |
| `src/core/clock.ts`                    | `Clock`, `Scheduler` (timers + abortable `sleep`), `FakeClock` firing timers on `advance()`                                                                                                                                                                                                                                                              |
| `src/adapters/types.ts`                | `AdapterDeps` (scheduler, calendar, `ReadStore`, scoped secrets), `PollAdapter`/`PollContext`/`PollResult` (+ cursor and BASELINE invariants), `StreamAdapter`, `QuoteProvider`, `QuoteTrackingSource`, `FilingFetcher`, `OAuthSession` (`markReminderSent`, `TOKEN_STATE_ID`), `LiveVerifiable`                                                         |
| `src/notify/types.ts`                  | `AlertMessage`, `SendResult`, `Notifier`, `NotifyRouter`, `OutboxWorker` (single-flight), `OpsAlerter`, `OPS_KEYS`, `FormatPush` + `MAX_HEADLINE_CHARS`                                                                                                                                                                                                  |
| `src/llm/types.ts`                     | `LlmGateway`, `LlmRequest` (optional `effort`/`maxTokens`, `timeoutMs`)/`LlmResult`, raw `LlmProvider`, 5.5 request rules, price formula, `FakeLlmProviderContract`                                                                                                                                                                                      |
| `src/engine/types.ts`                  | `MetricFunctions` signatures, `RuleContext`/`RuleHit`/`RuleEngine`/`EventFromHit`, `Triager`/`TriageOutcome`/`TriageRecord`, `DescribeEvent` + message builders, `SemanticDeduper`, `AlertBudget`/`BudgetDecision` (cap worked example, `hold_scorecard`), `NextDigestKind`, ALL brief payload types, `MaterializedBrief`, `LEAD_LINES`, scorecard types |
| `src/engine/schemas.ts`                | zod `TriageResult`, `applyTriage`, `resolveFinalPriority`, `triageFallback`, `parseTriageRecord`, word clamps (implemented + tested)                                                                                                                                                                                                                     |
| `src/engine/breakers.ts`               | closed thesis-breaker detector catalogue + `matchBreakers` (owner free text -> detector ids)                                                                                                                                                                                                                                                             |
| `src/engine/pipeline-contract.ts`      | Stage diagram, invariants I1-I14, `Pipeline`, `PipelineDeps` + `MarketDeps`, `PollOrchestrator`, `EarningsHook` (`claims`, `foldTargetFor`), `PollModeProvider`                                                                                                                                                                                          |
| `src/api/types.ts`                     | `ApiDeps`, `ApiServer`, `IssueApiToken`, `/health` auth rule, error envelope, `EventsResponse`, `ApiBriefType`                                                                                                                                                                                                                                           |
| `src/store/migrations/0001_initial.ts` | Every table (see section 5)                                                                                                                                                                                                                                                                                                                              |
| `src/store/index.ts`                   | `Store` facade: repos, `transaction`, `readTransaction`, `persistRecords`, `commitPoll` (baseline/stale), `ReadStore`, `openStore` (pre-migration backup)                                                                                                                                                                                                |
| `src/config/schema.ts` / `plan.ts`     | `CoverageConfig` (strict), `ConfigSource`, `ResolvedTickerConfig`, `quoteSymbols`, `PositionPlan` (`Slot`, `completeness()` with warnings)                                                                                                                                                                                                               |
| `src/config/load.ts`                   | `resolveConfigLocation`, `seedConfigIfMissing`, `ConfigHolder` (live reload), `buildEgressPolicyOptions`, `buildPostPathAllowlist`, `validateEgress`, `resolveThesisPath`                                                                                                                                                                                |
| `src/config/secrets.ts`                | `SecretsView` (+ `scope(keys)`), the closed key allowlist                                                                                                                                                                                                                                                                                                |
| `src/test-support/`                    | Fakes and factories (section 7)                                                                                                                                                                                                                                                                                                                          |

Implemented foundation utilities you should USE rather than rewrite: `eventId` and the key builders
(`core/ids`), `normalizeTitle`/`scoreNearDuplicate` (`core/text`), `Scheduler`/`FakeClock` (`core/clock`),
`toExchangeIso`/`chicagoDate`/`isQuietHours`/`nextQuietEnd` (`core/time`), `NyseCalendar` (`core/calendar`),
`AllowlistedHttpClient`/`buildUserAgent` (`core/http`), `AllowlistedPostClient` (`core/egress-post`),
`redactText`/`redactUrl` (`core/redact`), `edgarPollSeconds`/`irPollSeconds`/`haltsPollSeconds` (`config/cadence`),
`matchBreakers`, `parseEventPayload`, `Store.commitPoll`, `applyTriage`/`resolveFinalPriority`/`triageFallback`.

## 4. WAVE-1 FILE OWNERSHIP TABLE

Every file below belongs to exactly ONE slot. A slot edits only its own files (plus new tests next to them). A
need that touches another slot's or the foundation's file goes in your report's `openIssues`; the orchestrator
applies it. Tests live next to the code (`x.ts` + `x.test.ts`); fixtures under `test/fixtures/<area>/`.

| Slot   | Scope                                                         | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Contracts consumed / produced                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A1** | EDGAR adapter + parsers                                       | `src/adapters/filings/{edgar,submissions,eightk,form4,schedule13,f13,fetcher}.ts`, tests, `test/fixtures/edgar/**` (SYNTHETIC, shaped like real data)                                                                                                                                                                                                                                                                                                                                                                              | Produces `PollAdapter` (id `edgar.submissions`), `FilingFetcher`; payloads `EightKPayload`, `Form4Payload` (ONE `rowIndex` counter, non-derivative rows first; computes `filingSaleUsd`/`filingBuyUsd`), `Schedule13Payload`, `F13Payload`; records `filing`/`form4_row`/`schedule13`/`holding_13f`; sets `baseline` on a null-cursor poll; keys via `edgarKey`/`form4Key`                                                                                                           |
| **A2** | Schwab quotes, OAuth, stream, positions, halts                | `src/adapters/quotes/{schwab-http,schwab-oauth,schwab-token-store,schwab-auth-flow,schwab,schwab-mapping,schwab-stream,quote-tracker}.ts`, tests, `test/fixtures/schwab/**`                                                                                                                                                                                                                                                                                                                                                        | Produces `QuoteProvider`, `StreamAdapter`, `OAuthSession` (incl. `markReminderSent`); `QuoteTracker` implements `QuoteSnapshotSource` + `QuoteTrackingSource` and persists throttled (~5 s) to kv `quote:<SYMBOL>` via `LatestQuotesRepo`; the stream subscribes to `quoteSymbols(config)`; owns the ONLY Schwab POST (token endpoint, `schwab-oauth.ts`); persists today's daily bar only after the close; token state is written through `TokenStateRepo`, not `AdapterDeps.store` |
| **A3** | FINRA + FRED                                                  | `src/adapters/shorts/{finra,finra-parse,finra-auth}.ts`, `src/adapters/macro/fred.ts`, tests, `test/fixtures/{finra,fred}/**`                                                                                                                                                                                                                                                                                                                                                                                                      | Produces two/three `PollAdapter`s; `ShortInterestPayload`; records `short_interest`, `reg_sho` (no event), `macro_observation`; `finra-auth.ts` is an audited POST module; publish-lag business-day math uses `deps.calendar`; history on a null cursor is `baseline`                                                                                                                                                                                                                |
| **A4** | RSS/IR, Nasdaq halts feed, inbox                              | `src/adapters/news/{rss,ir,google-news}.ts`, `src/adapters/halts/nasdaq-halts.ts`, `src/adapters/inbox/substack.ts`, tests, `test/fixtures/{news,halts,inbox}/**`                                                                                                                                                                                                                                                                                                                                                                  | Produces `PollAdapter`s; `NewsPayload` (`titleNorm` from `core/text.normalizeTitle`), `HaltRecord` events (kind `halt`, source `quote`, key `haltKey`), `NewsletterPayload`; the near-duplicate scorer lives in `core/text.ts` (no `dedupe.ts` here); the inbox adapter keeps its IMAP position in the watermark cursor (`<uidValidity>:<lastUid>`) and does NOT write `newsletter_state`                                                                                            |
| **A5** | Notify + OpenClaw artifacts                                   | `src/notify/{openclaw,agent-hook,ntfy,router,outbox,ops}.ts`, `openclaw-skill/scout/SKILL.md`, `docs/OPENCLAW_SETUP.md`, tests                                                                                                                                                                                                                                                                                                                                                                                                     | Produces `Notifier`s (hook + agent routes via `AlertMessage.route`; ntfy publishes JSON to the BASE URL), `NotifyRouter` (falls back on `failed` AND `rejected`), `OutboxWorker` (single-flight + `claimDue` lease), `OpsAlerter` (`OPS_KEYS`, `recoveredKey`, `nextQuietEnd`); audited POST modules                                                                                                                                                                                 |
| **A6** | Rules + metrics                                               | `src/engine/rules.ts`, `src/engine/rules/*.ts` (incl. `event-from-hit.ts`), `src/engine/metrics/{atr,volume-pace,iv30,intraday-profile}.ts`, tests (>= 90% coverage)                                                                                                                                                                                                                                                                                                                                                               | Produces `RuleEngine`, `EventFromHit`, the `MetricFunctions` signatures from `engine/types.ts`; classifies (does not evaluate) `thesis_breaker`; uses the per-kind key builders and the new threshold keys                                                                                                                                                                                                                                                                           |
| **A7** | Budget, dedupe, message builders, format-push, digests        | `src/engine/{budget,dedupe,describe,format-push,digest}.ts`, tests (>= 90%)                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Produces `AlertBudget` (cap + exemptions, halt/volume/press-release folds, `hold_scorecard`, overflow primary in kv `budget:`), `SemanticDeduper` (policy over `core/text`), `DescribeEvent`/`BuildClusterMessage`/`BuildOverflowMessage`, `FormatPush`, `DigestBuilder`, `NextDigestKind` (from `config.schedules` + calendar)                                                                                                                                                      |
| **A8** | LLM provider/gateway/models/batch + triage/synth/deep + facts | `src/llm/{anthropic,gateway,models,batch,cost,fact-sheet}.ts`, `src/llm/prompts/*.ts`, `src/engine/{triage,synth,deep}.ts`, tests (>= 90% for `src/engine/*`; prompt-injection test; request-rule tests)                                                                                                                                                                                                                                                                                                                           | Produces `LlmProvider`, `LlmGateway` (effort/maxTokens default to the tier config; `timeoutMs`), `Triager` (loads thesis + fact sheet itself), `BriefWriter`, `WeeklyReviewer`, `ScorecardExtractor`, the deterministic fact-sheet builder; may extend `test-support/fake-llm.ts` ONLY via the orchestrator                                                                                                                                                                          |
| **B1** | Event pipeline + poll orchestrator                            | `src/engine/{events,pipeline,orchestrator,context,market-evaluator}.ts`, tests for invariants I1-I14 (>= 90%)                                                                                                                                                                                                                                                                                                                                                                                                                      | Produces `Pipeline`, `PollOrchestrator`; consumes `RuleEngine`, `Triager`, `AlertBudget`, `NotifyRouter`, `EarningsHook`, `PollModeProvider`, `MarketDeps`, `SemanticDeduper`, the message builders; ingests with `baseline`/`maxEventAgeMs`; writes only raw `adapter:<id>:<ticker>` health facts; single-flight polls                                                                                                                                                              |
| **B2** | Jobs, scheduler, composition root, CLI, options poll          | `src/jobs/scheduler.ts`, `src/jobs/jobs/*.ts` (premarket, open-snapshot, midday, close, weekly, health, retention, backup, token-check, daily-bars, positions, plan-snapshot, earnings-tick, quotes-snapshot, profile), `src/adapters/quotes/options-poll.ts`, `src/app.ts`, `src/index.ts`, `src/cli.ts`, `src/cli/*.ts` (doctor, verify-live, schwab-auth, token, poll, replay, backup, init-config, config), tests                                                                                                              | Wires every contract. Owns: the options `PollAdapter` (id `schwab.options`, RTH only, `polling.options_minutes`, QuoteProvider + A6 `computeIv30`); brief materialization (kv `brief:` + `markDigested` for exactly the stored `eventIds`); `quotes_snapshot`; the weekly `profile` job; `earnings_tick` (calls B4 `runPreload`/`runPostCall`); entry-point config rule (F18); early-close handling (`close_early`)                                                                  |
| **B3** | API, brief builders, plan reporting, health                   | `src/api/{server,auth,routes/*}.ts`, `src/briefs/*.ts` (shared, premarket, midday, close, weekly, snapshot, position, plan, scorecard, service), `src/plan/report.ts`, `src/health/{evaluate,alerts,monitor}.ts`, tests                                                                                                                                                                                                                                                                                                            | Produces `ApiServer` (unauthenticated minimal `/health`, error envelope, materialized-brief serving), `IssueApiToken`, `BriefService` (store-only, non-mutating), `HealthMonitor` (derives status from `adapter:*` facts; reuses `OPS_KEYS`); `BreakerStatus` from `thesis_breaker` events; every payload type in `engine/types.ts`                                                                                                                                                  |
| **B4** | Earnings mode, scorecard, breakers, replay, acceptance tests  | `src/engine/earnings/{mode,hook,scorecard,guidance,push,breakers}.ts`, `src/replay/*.ts`, `scripts/record-fixture.mjs`, `test/acceptance/*.test.ts` (spec section 11), `test/fixtures/replay/**` (SYNTHETIC), tests (>= 90% for `src/engine/earnings/**`)                                                                                                                                                                                                                                                                          | Produces `EarningsHook` (`claims`, `foldTargetFor`), `PollModeProvider`, replay harness (baseline poll, then `normal` mode with a `FakeClock` just before the release); owns the scorecard push + the 240 s fallback (`earnings:` keys), guidance comparison (epsilon, period/unit normalization), thesis-breaker evaluation and `thesis_breaker` events, `runPreload`/`runPostCall`; asserts the exact P1 count                                                                     |
| **B5** | Packaging, CI, scripts, docs                                  | `Dockerfile`, `docker-compose.yml` (dev), `.github/workflows/{ci,release}.yml`, `scripts/{check-store,bump-store,smoke}.mjs`, `umbrel-store/herman-scout/**`, `README.md`, `LICENSE`, `docs/{THREAT_MODEL,VERIFY_LIVE,RUNBOOK}.md`; may EXTEND `scripts/guard-no-orders.mjs` (must stay self-match-proof)                                                                                                                                                                                                                          | Collates every `UNVERIFIED:` comment (incl. futures symbology) into `VERIFY_LIVE.md`; documents every egress host + dependency (D4, D8); a policy test that the README host table equals `coverage.yaml` `egress.allowed_hosts` (via `EgressPolicy.hostList()`); image ships the bundled `coverage.yaml` and the entry point seeds `/data/coverage.yaml` once                                                                                                                        |
| **F**  | Foundation (done; locked)                                     | `package.json`, `package-lock.json`, `tsconfig*.json`, `eslint.config.js`, `.prettier*`, `vitest.config.ts`, `.gitignore`, `.nvmrc`, `.dockerignore`, `src/types.ts`, `src/event-payloads.ts`, `src/core/**`, `src/config/**`, `src/store/**`, `src/{adapters,notify,llm,engine,api}/types.ts`, `src/engine/{schemas,breakers,pipeline-contract}.ts`, `src/test-support/**`, `config/**`, `scripts/guard-no-orders.*`, `test/policy/**`, `test/fixtures/{README.md,_selftest/**}`, `docs/{ARCHITECTURE,DECISIONS}.md`, `CLAUDE.md` | -                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Decision ownership (every decision has one implementing slot): D1/D2/D3/D4/D5 F+B5; D6 F (guard + POST path
allowlist) + A2 + B5 (threat model); D7 F (+A2/A3/A5 callers); D8 F+B5; D9 F (+A1-A4 usage); D10 F (`commitPoll`) + B1;
D11 A1; D12 A2 (+B2 reminders job); D13 A2; D14 A2 (+A4 feed, A6 rule); D15-D18 A5; D19 B3; D20 A8; D21 A8+B4+B2; D22
A8; D23 F+B2; D24 A6; D25 A3; D26 A3 (+A7 enforcement, test); D27 A4; D28 F (`core/text`) + A4 + A7; budget semantics
A7; D29 B4; D30 B5; D31 B2+B3; D32 everyone; F14-F27 as named in `DECISIONS.md`.

## 5. Database tables (migration 0001) and who touches them

| Table(s)                                                      | Written by                                      | Read by                                |
| ------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------- |
| `events`, `event_links`                                       | B1 (`commitPoll`, status moves), A7 links, B4   | B3 (API, briefs), A7, B4               |
| `pushes` (outbox), `push_events`                              | B1 (enqueue), A5 (`OutboxWorker`, `OpsAlerter`) | B3 (health, "was event X pushed?"), B2 |
| `watermarks`                                                  | B1 only, via `commitPoll`                       | B2 (doctor)                            |
| `filings`, `form4_rows`, `schedule13_filings`, `holdings_13f` | A1 via `DomainRecord`s                          | A6 context (B1), B3 briefs             |
| `quotes_daily`, `intraday_profile`, `intraday_bars`           | A2/B2 daily-bars job, B2 `profile` job (A6 fn)  | A6 (ATR, ADV), B3                      |
| `short_interest`, `reg_sho_daily`, `macro_observations`       | A3 via `DomainRecord`s                          | A6, B3                                 |
| `options_snapshots`                                           | B2 options poll (via `DomainRecord`s)           | A6 (IV30, strike volume), B3           |
| `newsletter_state`                                            | RESERVED (A4 uses the watermark cursor)         | -                                      |
| `llm_calls`, `fact_sheets`                                    | A8                                              | B3 (cost line), B2                     |
| `plan_snapshots`, `positions_snapshots`                       | B2 jobs                                         | B3                                     |
| `scorecards`, `guidance_history`                              | B4                                              | B3, B4                                 |
| `token_state`                                                 | A2                                              | B2 (reminders), B3 (health)            |
| `health_state`, `alert_state`, `daily_counters`, `kv_state`   | B1 / B3 / A5 / A7 / B4 (by key prefix)          | B3                                     |
| `api_tokens`                                                  | B3 (`IssueApiToken`)                            | B3                                     |
| `jobs_runs`                                                   | B2                                              | B3 (health)                            |

`kv_state` / `alert_state` key prefixes are owned (one writer each):

| Prefix            | Owner          | Holds                                                                                         |
| ----------------- | -------------- | --------------------------------------------------------------------------------------------- |
| `brief:`          | B2 (jobs)      | `MaterializedBrief` per `brief:<type>:<TICKER>:<tradingDate>` (B3 reads)                      |
| `quote:`          | A2 / B2 job    | `StoredQuote` per symbol (A2 tracker for stream symbols, `quotes_snapshot` for the rest)      |
| `weekly:`         | B2             | the weekly Opus Batch handle (survives restarts)                                              |
| `poll:`           | B1             | per-(adapter,ticker) orchestration scratch                                                    |
| `earnings:`       | B4             | earnings-mode state, preload/post-call done markers, claimed-event deadlines                  |
| `health:`         | B3             | derived component status and alert cooldowns                                                  |
| `adapter:`        | B1             | RAW per-(adapter,ticker) success/failure facts in `health_state` (B3 derives status + alerts) |
| `outage:`, `ops:` | A5             | gateway outage window, config/ops alert cooldowns                                             |
| `budget:`         | A7             | P1-overflow primary per day, halt/cluster windows                                             |
| `schwab:`         | A2 (+ OPS key) | token/stream facts; `OPS_KEYS.SCHWAB_*` dedupe keys                                           |

`health_state` is partitioned by component prefix: B1 writes only `adapter:*` facts, B3's monitor derives and alerts on
everything else (no double writer, no flapping). Wave-1 agents must NOT add migrations (numbering would conflict);
request schema changes through the orchestrator. A column you think is missing usually belongs in a JSON field or
`kv_state`.

## 6. Ground rules for wave 1

1. **Read first:** `CLAUDE.md`, `docs/DECISIONS.md`, the contract file(s) for your slot, and your slot's decision rows.
2. **Stay in your lane:** edit only your files (section 4). Do not edit foundation files, `package.json`, the lockfile,
   migrations, other slots' files, or anything outside `scout/`. Do not commit or push.
3. **No new dependencies.** Everything needed is installed (`@anthropic-ai/sdk`, `better-sqlite3`, `fast-xml-parser`,
   `node-cron`, `pino`, `ws`, `yaml`, `zod`; optional `imapflow`/`mailparser`). Need another? Report it.
4. **Egress only through the audited layers:** GET via `deps.http`; POST only in the audited files listed in
   `test/policy/egress.test.ts` and only to the paths `buildPostPathAllowlist` permits; sockets only via `deps.ws`;
   Anthropic only under `src/llm/` with `createGuardedStandardFetch`. `process.env` is forbidden outside
   `src/config/secrets.ts` and the entry points; each secret key is read only by the files that own it (policy test).
5. **Pure adapters:** `poll()` returns `{events, records, cursor, baseline?}` and never writes state; `deps.store` is a
   READ-ONLY `ReadStore` (see the cursor and baseline invariants at the top of `src/adapters/types.ts`). Event ids come
   from `eventId()` with a key from the per-kind builders in `core/ids` (D9). Components that own other state are
   constructed with the specific repo they own.
6. **Determinism and seams:** inject clock/scheduler/http/ws/llm/notifier/paths; no import-time singletons; no real
   network in tests; fixtures not recorded from a real service are labelled SYNTHETIC; coverage >= 90% (lines/functions)
   on `src/engine/**`. Use `src/test-support` (section 7). Timers come from `deps.scheduler`, never bare
   `setTimeout`/`setInterval`.
7. **Mark the unknown:** any field, endpoint or behavior not confirmed from official docs gets an `UNVERIFIED:` code
   comment AND a line in your report; B5 collates them into `docs/VERIFY_LIVE.md`. Implement `verifyLive()` where a
   live check is possible.
8. **Read-only:** no order endpoints, identifiers or non-GET Schwab calls anywhere (`npm run guard:orders`).
9. **Untrusted text:** filing/news/press-release/newsletter text is data; never interpolate it into instructions.
10. **Attribution:** borrowed code gets a header comment naming the source repo/path, its license (BlackGold is MIT,
    Copyright (c) 2026 Matt Herman) and what changed. The private repo's code is re-implemented, never pasted.
11. **Before you report done, run:** `npm run typecheck && npm run lint && npm test && npm run guard:orders` and report the
    exact results; do not claim a pass you did not observe.

## 7. Testing contract (`src/test-support`)

| Helper                                                    | Use                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FakeClock` (`core/clock`)                                | Deterministic time AND timers: `advance()` fires due timers in order, `set()` jumps without firing, `setTimeout`/`setInterval`/`sleep` (a `Scheduler`), `pendingTimers()` for shutdown-leak assertions                                                                |
| `makeDeps()`                                              | Full `AdapterDeps` on fakes: FakeClock (2026-12-03T14:00Z, also the scheduler), NyseCalendar, `FakeHttp`/`FakePost` built from the PRODUCTION egress policy (ports, POST path allowlist), `FakeWebSocketFactory`, read-only store view, silent logger, contact secret |
| `FakeHttp` / `FakeFetch` / `FakePost`                     | Canned routes (string, `prefix*`, RegExp, function; arrays consumed in order), request log, allowlist/port/POST-path enforcement; response headers filtered through the production whitelist; unmatched requests THROW                                                |
| `FakeWebSocketFactory`                                    | Drive a socket from the server side: `open()`, `receive(obj)`, `serverClose()`, `fail()`; inspect `sentJson()`; `behavior = { asyncClose, strictSend }` mimic real `ws` (async close, silent send after close)                                                        |
| `FakeLlmProvider`                                         | Scripted replies (text/json/refusal/maxTokens/error/function), request log for prompt-structure assertions, batches                                                                                                                                                   |
| `RecordingNotifier`                                       | Records sends; `failNext()` scripts outages                                                                                                                                                                                                                           |
| `tempDb()` / `tempDbFile()`                               | Migrated in-memory / real-WAL-file stores (`close()` in `afterEach`)                                                                                                                                                                                                  |
| `loadFixture` / `loadJsonFixture`                         | Read `test/fixtures/**`; missing fixture throws                                                                                                                                                                                                                       |
| `makeEvent` / `makeConfig` / `makeBars` / `makeQuoteTick` | Deterministic builders; `makeBars(n)` yields session-day bars ending 2026-12-02                                                                                                                                                                                       |

Policy tests (`test/policy`) are the CI tripwires: no order identifiers (the guard skips only the real `data/` dirs);
`fetch` only in the two HTTP files; POST helpers only in audited modules; `ws`/SDK/IMAP imports confined; raw
sockets, `child_process`, `worker_threads`, `vm` and dynamic `import()`/`require()` confined; no `process.env` outside
secrets/entry points (dot, bracket, destructuring); each secret key read only by its owner files; adapters name no
write API; production code never imports test-support; no module-level singletons. Comments are stripped with the
TypeScript parser, not a regex. The audited-module list there mirrors section 4: widening it is a security-relevant
change that goes through the orchestrator.

## 8. Acceptance-test semantics (spec section 11, decision F25)

- "Quiet day produces <= 3 pushes (pre-market, close, <= 1 event)": with `briefs.writer: mayer` the pre-market and close
  messages are Mayer's cron output and are NOT in Scout's `pushes` table, so B4 asserts (a) Scout-originated pushes
  <= 1 AND (b) the premarket and close payloads exist and are non-empty. The literal "<= 3 total" is asserted only
  with `briefs.writer: scout` (which sends `brief` pushes). `PushCountLine` reports event, digest and ops pushes
  separately. The same wording applies to "no more than 8 pushes" in the Aug 27 replay.
- "ONE P1 whose lead line is `FY guide cut`": B4 asserts the exact P1 count of the replay: the scorecard push replaces
  the generic 8-K P1 (invariant I13), the press release folds into it, the price P1 is separate, a paired volume P1
  folds into the price push.
- "Kill Schwab auth: exactly ONE 'quotes down' P1": every raiser uses `OPS_KEYS.SCHWAB_QUOTES_DOWN`; the test asserts
  one enqueued push however many components notice.
- "LLM down + 8-K": the push is enqueued within `pipeline.triage_deadline_seconds` of ingest (invariant I2).
- The replay harness runs a baseline poll of the pre-release state, then `mode: 'normal'` with a `FakeClock` just
  before the release (invariant I11), so an old filing replays as LIVE.
