# Post-Split Full-Repo Audit — Remediation Spec

**Date:** 2026-08-03 · **Audited state:** commit `eb455d5`, working tree clean
**Predecessor:** [full-repo-audit-2026-08.md](full-repo-audit-2026-08.md) + [implementation-log-2026-08.md](implementation-log-2026-08.md) — that exercise converged to zero findings at `fba0a13` (decisions 99–123).

**Why this document exists.** Five commits landed *after* that convergence — `f9bc451`, `079a604`, `cbbda9f`, `cb7f643`, `51fb7eb`, `a9ceced`, `eb455d5`: one package split into `core`/`module`/`connector`, the Docker images split, versions unified, the npm scope renamed, two docs deleted. That is ~2,600 lines of new, never-audited refactor, and the predecessor log's own hardest-won lesson is that **a fix wave is itself a source of defects and must be re-audited as one**. This audit re-ran the full sweep over the current tree with that surface as the priority.

**Method.** Ten independent lenses (billing correctness · connector sync/ingestion · REST contract · security · clean architecture/SOLID · duplication/dead code/naming · MongoDB persistence · test integrity · edge cases · docs drift · UI · domain modelling · docker/ops · completeness critic), plus a direct verification pass by the lead. Findings were not accepted on assertion: the persistence lens ran **real MongoDB servers with `explain('executionStats')`**, the REST lens ran the **built `dist` in-process** and probed it over HTTP, the sync lens ran the **built mappers** against synthetic source rows, and the lead independently re-verified every CRITICAL/HIGH and every surprising MEDIUM by executing the check. Claims that could not be reproduced were dropped; several plausible findings were killed this way and are recorded in §10 so nobody re-files them.

**How to read this.** Each finding has an ID, a severity, exact files, a concrete failure scenario with real inputs, and a fix specified to be implementable without re-analysis. **Nothing has been changed in the code** — this document is the proposal. Approve or veto per ID; §11 has the suggested batch order.

---

## 0. Executive summary

**The core engineering remains excellent, and the predecessor audit's work held.** The statement engine is still one calculation folded two ways; money is BigInt/integer-µ¢ end to end with no float in any billing path; the quarantine lifecycle survives the full reopen→re-close cycle; the close/publish protocol is crash-safe with a bounded transaction; there is no NoSQL-injection path; the auth gate has no bypass and no fail-open; every `find().sort()` in production rides a serving index; and no test file was lost by the split (70 → 74). §10 lists what was verified clean in detail, much of it by experiment rather than by reading.

**What the split broke is real, and it clusters in three places.**

1. **The type contract between the new packages does not exist.** `tsc --noEmit` is red in two of the three packages, and the jest configuration structurally hides it.
2. **Rules that were single-sourced inside one package became copies when they crossed a package boundary** — exactly the root pattern the predecessor log names as the cause of its worst defects.
3. **The ingestion path has three independent ways to silently lose or fabricate archive data**, which is the one failure shape invariant 6 exists to prevent.

Headline items — **1 CRITICAL, 9 HIGH**:

| # | Sev | What | Why it matters |
|---|---|------|----------------|
| **A-1** | **CRIT** | The split moved `make sync` into a container **with no LangWatch credentials**, so the backfill door falls through to the shipped demo fixtures | A backfill exits 0 having written nine **fabricated** priced traces into a real client's permanent archive and bill, while the real window is never fetched and LangWatch expires it at ~49 days |
| **A-2** | HIGH | A source-declared `0` suppresses the span-token fallback | Immutable **R$ 0,00** stamp on a trace with real usage — invariant 2, unrecoverable without a reopen |
| **A-3** | HIGH | A null timestamp coerces to epoch 0 in the cursor helpers | Ingestion wedges or spins forever with no error, no dead letter, no backoff — invariant 6 |
| **A-5** | HIGH | A **stamped** trace's `model` is still mutable by `updateAttribution` | A frozen stamp gets re-attributed to a model whose price it never used; the bill reports one model's money under another's name |
| **B-1** | HIGH | The future-month guard exists in exactly **one** of three readers | `/bills` offers a month `/billing/summary` answers 400 for; one far-future trace empties the entire series chart — invariant 3 |
| **B-2** | HIGH | `make billing-close YEAR=26` closes June **1926** and succeeds | Permanently destroys the decision-119 open-month scan bound; every `/bills` and `/billing/series` reverts to a full-collection scan |
| **C-1** | HIGH | `module` and `connector` emit **zero** `.d.ts`; core's build excludes a file both import | `tsc --noEmit` red in both; test fakes degrade to `any` and stop being checked against their ports |
| **D-1** | HIGH | Wildcard `Access-Control-Allow-Origin: *` on every endpoint, auth off by default | Any web page the operator visits can exfiltrate the unmasked archive from a LAN-reachable dashboard |
| **E-1** | HIGH | The split removed the only command that runs the test suite | `npm test` at the root is `Missing script`; a core change that breaks 37 module suites lands unrun |
| **G-1** | HIGH | The ingestion worker's healthcheck is `pgrep node`, and its no-source branch idles forever by design | `docker compose ps` reads **healthy** while nothing has been ingested for weeks |
| **G-2** | HIGH | The documented production deploy starts the worker **before** migrations | Without the unique `traceId` index, `insertIfAbsent` cannot raise E11000 — the same trace is stored twice, each with its own immutable stamp; the client is over-billed with no evidence |
| **G-3** | HIGH | `API_IMAGE` was retired with no guard; existing client env files silently fall back to `:local` | A pinned production tag is ignored and a developer's stale local build serves the client's archive |

Three of these — **A-1**, **A-5** and **G-2** — exist *because* of the split: a credential, a rule and an ordering each stayed behind when the code depending on it moved. That is the predecessor log's predicted failure mode, and it happened anyway.

**Effort estimate (rough):** P0 ≈ 1½ days · P1 ≈ 3 days · P2 ≈ 2 days · P3 ≈ 1½ days · P4 (docs) ≈ ½ day. Tests fold into each batch.

---

## 1. State of the tree (ground truth, measured)

Everything in this section was executed, not inferred.

| Check | Result |
|---|---|
| `npm run build` (all four workspaces) | **green** |
| `npm test -w @observability/core` | **20 suites / 152 tests green** |
| `npm test -w @observability/module` | **37 suites / 335 tests green** |
| `npm test -w @observability/connector` | **15 suites / 150 tests green** |
| Total | **72 suites / 637 tests** (pre-split: 68 / 623) |
| Coverage — core | **45.79 %** lines |
| Coverage — module | **91.31 %** lines |
| Coverage — connector | **71.71 %** lines |
| `coverageThreshold` configured | **none, in any package** |
| CI pipeline (`.github/`) | **absent** |
| `npm test` at repo root | **`Missing script: "test"`** |
| `tsc --noEmit -p packages/core/tsconfig.json` | clean |
| `tsc --noEmit -p packages/module/tsconfig.json` | **22 errors** |
| `tsc --noEmit -p packages/connector/tsconfig.json` | **2 errors** |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `make deploy-smoke` | **green** (all four groups) |
| `.only` / `.skip` / `xit` in any suite | none |
| `TODO` / `FIXME` / `XXX` / `HACK` in `src` or `app.js` | none |
| Surviving `@khal/*` references | none — but see **I-4**, the rename over-reached |
| Emitted-`dist` specifier resolution | **476 specifiers, 0 unresolved** |

Two of these deserve emphasis because they bound findings below.

**The `dist` really does resolve.** A walk over every emitted `.js` in all three packages resolving each relative and `@observability/*` specifier found zero unresolved, and `node dist/main/index.js` reaches `MongoClient` construction through the exports map. **C-1 and C-2 are therefore strictly a type-contract and developer-experience defect, not runtime breakage.** Do not let the fix wave over-correct.

**Coverage per package is structurally misleading.** Core reports 45.79 % not because its code is untested but because *its tests live in `module`* (**E-3**). Read the three numbers as one aggregate until that is fixed.

---

## 2. P0 — Archive integrity and money corruption

These four are the highest priority because every one of them fails **silently** and, for three of them, **irreversibly** — the stamp is immutable and LangWatch's retention window is ~49 days.

### A-1 · CRITICAL — the split moved `make sync` into a container that has no LangWatch credentials, so the backfill door degrades to the shipped demo fixtures

> **RESOLVED — 2026-08-04, decision 127 (goes further than the fix below).** Matheus ruled that **no client will ever ingest over HTTP**, so instead of restoring the HTTP link, the `HttpLangWatchClient` (+ schema/mapper/specs) was **deleted**. The source is now *declared, never inferred*: ClickHouse is the only real source, gated on `LANGWATCH_PROJECT_ID` (the value the queries actually filter by — not the API key, which no container of this component reads anymore); the fixture fake requires the explicit `TRACE_SOURCE=fixtures`; with no source configured the sync **crashes** naming both remedies; every branch logs its selection. Pinned by `sync-factory.spec.ts` (7 cases, fails on revert to the inferred chain). The `api:` fragment in `compose.connector.yml` was deleted with it (H-1), `3-onboard-langwatch.sh` now treats the project id as the load-bearing output (hard error + stack re-apply), `require-client` warns on pre-127 env files, and `5-verify` keys its "onboarded" signal on the project id. The fix text below is kept as the record of what the finding originally proposed.

This is the most serious finding in the audit, and it is a **regression introduced by the package split**.

- **Files:** `Makefile:153` · `compose.connector.yml:70-84` (the `api` fragment) and `:108-133` (the worker) · `packages/connector/src/main/factories/sync-factory.ts:48-58` · `docker/connector.Dockerfile:45-46` · `clients/example.env` · `packages/connector/src/infrastructure/configuration/helpers/environment-setup.ts`
- **Invariant:** 6 (the real window is never fetched and the source expires it), 1 (the fabrications are stamped immutably), 3 (they enter the bill)
- **Verified — three independent facts that compose:**
  1. **The sync door moved containers.** `git diff fba0a13..HEAD -- Makefile`: `run --rm --no-deps api node dist/main/jobs/run-sync.js` → `run --rm --no-deps trace-ingestion-worker node …`.
  2. **The credentials did not move with it.** I read both env blocks. The `api` fragment still carries `LANGWATCH_ENDPOINT: ${LANGWATCH_API_KEY:+http://langwatch:5560}` and `LANGWATCH_API_KEY: ${LANGWATCH_API_KEY:-}`. The `trace-ingestion-worker` block sets **only** `LANGWATCH_CLICKHOUSE_{URL,USER,PASSWORD,DATABASE}` and `LANGWATCH_PROJECT_ID` — **no endpoint, no API key**. Since the factory chain is `makeClickHouseClient() ?? (endpoint && apiKey ? Http… : new FakeTraceSourceClient())`, inside the only container that now runs `run-sync.js` the **middle link is structurally unreachable**: it is ClickHouse-or-fake. Decision 78's external/SaaS-LangWatch path (API key, no reachable ClickHouse) is therefore impossible from the sync door.
  3. **The ClickHouse source is gated on the wrong variable.** `LANGWATCH_CLICKHOUSE_URL: ${LANGWATCH_API_KEY:+http://clickhouse:8123}` — the direct-read URL is conditioned on the **API key**, which the ClickHouse path never uses. An empty or not-yet-onboarded `LANGWATCH_API_KEY` therefore disables *both* real sources at once.

  Two aggravating facts: `grep -c LANGWATCH_ENDPOINT clients/example.env` → **0**, so the variable is in the Makefile SCRUB list but in no env contract and no operator can supply it manually; and `docker/connector.Dockerfile:45-46` copies the fixtures into the **runtime** stage, so the fake has realistic data to serve in the production compose form (confirmed present: `window-1.json`, `window-2.json` — nine traces dated 2026-06-05…06-20, priced models, non-zero token counts). Nothing in `sync-factory.ts` or `run-sync.ts` logs which source was selected.
- **Failure:** an operator backfills June before onboarding completes, or after an API-key rotation, or against an external LangWatch: `make sync CLIENT=<real> FROM=2026-06-01 TO=2026-07-01`. Every real source is unreachable, the chain falls to `FakeTraceSourceClient`, and the job prints `fetched 9, inserted 9, skipped 0, pending price 0, failed 0` and **exits 0**. Nine **fabricated** traces enter that client's permanent archive, price-stamped and immutable, and are counted into `/traces`, `/sessions` and June's billing aggregate — while the real June window is never fetched and LangWatch drops it at ~49 days. If June closes before anyone notices, both the fabrications and the omissions freeze into the snapshot (invariant 8) and removal requires an audited reopen.
- **Fix — all four parts; the first alone is not enough:**
  1. **`compose.connector.yml`** — move `LANGWATCH_ENDPOINT` and `LANGWATCH_API_KEY` onto the `trace-ingestion-worker` environment block and delete them (with the whole `api:` fragment, see **H-1**) from the module's. Add `LANGWATCH_ENDPOINT` to `clients/example.env` so the contract can express it.
  2. **Decouple the ClickHouse gate** — give `LANGWATCH_CLICKHOUSE_URL` its own contract variable instead of `${LANGWATCH_API_KEY:+…}`, so onboarding state cannot silently disable the direct read path.
  3. **`sync-factory.ts`** — make the fake **opt-in**, not a fall-through: select it only under an explicit `TRACE_SOURCE=fixtures` or `Environment !== 'production'`, and **throw** otherwise. "No source configured" must be a crash on a backfill door, never an empty-source success.
  4. **Log the selection unconditionally** in both `makeTraceSourceClient` and `makeSyncBatchesUseCase`, and have `run-sync.ts` print it before syncing: `Sync source: clickhouse | langwatch-http | FIXTURE FAKE (offline demo)`. Add `.min(1)` to the three `LANGWATCH_*` string fields so a blank value is a boot error rather than a silent falsy.
- **Test:** a `sync-factory` spec (module-mocked `config`): ClickHouse URL set → `ClickHouseLangWatchClient`; endpoint+key set → `HttpLangWatchClient`; **endpoint set with an empty key under `Environment: 'production'` → throws**; explicit opt-in → `FakeTraceSourceClient`. Plus a compose-level assertion in `deploy-smoke-test.sh` that every variable the connector's zod schema declares as a source input is present on the `trace-ingestion-worker` service. Both fail today.

### A-2 · HIGH — a source-declared `0` suppresses the span fallback, minting an immutable R$ 0,00 stamp

- **Files:** `packages/connector/src/infrastructure/traceSource/langwatch/clickhouse/clickhouse-row-mapper.ts:249-260` (and `:58-75`, `:77-87`) · `packages/connector/src/infrastructure/traceSource/langwatch/langwatch-api-mapper.ts:186-199` · `packages/core/src/application/useCases/priceStamping/price-stamper.ts:39-52` · `packages/connector/src/application/useCases/syncTraces/trace-ingestor.ts:180`
- **Invariant:** 2 (never valued at R$ 0,00) and 1 (the stamp is immutable, so this is unrecoverable)
- **Verified:** both files treat `0` as *absent* everywhere (`clickhouse-row-mapper.ts:68` `value > 0`, `:81` `count > 0`) **except** in the one place that decides whether to fall back to the spans:
  ```ts
  input:  summary.promptTokens     ?? sumSpanTokens(spans, 'input'),
  output: summary.completionTokens ?? sumSpanTokens(spans, 'output'),
  ```
  `??` fires only on `null`/`undefined`, so a declared `0` wins over the span sums. The HTTP adapter is symmetric (`langwatch-api-mapper.ts:187`). Running the **built** mapper on a summary row with `promptTokens: 0, completionTokens: 0` whose single LLM span carries `input_tokens: 1200 / output_tokens: 350` yields `trace.tokens = {}`, and `stampTokens` then returns `{pricingStatus:'stamped', stampedCosts:[], totalCostMicrocents:0}`. The comment at `:245-248` states that this very `??` is what decides the decision-110 salvage — so a declared `0` also bypasses salvage reconstruction. The salvage gate cannot help: it runs only when `nulledTokenFields.length > 0`, and a plain `0` passes `z.number().int().nonnegative()` cleanly (there is a spec pinning that a legitimate zero count is healthy).
- **Failure:** LangWatch's `TotalPromptTokenCount`/`TotalCompletionTokenCount` are non-nullable counters — an un-aggregated or failed roll-up reads **0**, not null. Any such trace whose spans *do* carry usage is stored `stamped`, `tokensTotal: 0`, `totalCostMicrocents: 0`. It is **not** `pending_price`, so the reprocess sweep never revisits it; the stamp is immutable, so the only repair is a month reopen plus manual surgery. The bill silently under-counts, and invariant 3 still "holds" because the aggregate equals the sum of the *wrong* stamps.
- **Fix:** make the trace-level count zero-aware before the fallback, matching each file's own `> 0` convention, in **one shared helper both mappers import** (this is a rule with two spellings today):
  ```ts
  const declared = (count: number | null | undefined): number | undefined =>
    typeof count === 'number' && count > 0 ? count : undefined;
  // …
  input: declared(summary.promptTokens) ?? sumSpanTokens(spans, 'input'),
  ```
  Separately, decide the residual explicitly: a trace that ends with **no** positive token count but carries a model is still stamped R$ 0,00 today. The honest options are `pending_price` or the poison path, and either belongs at the `stampTokens` call site (`trace-ingestor.ts:180`), not in an adapter — see **A-4**.
- **Test:** extend `token-salvage-parity.spec.ts` (it already drives both real adapters through one contract): declared `{prompt: 0, completion: 0}` with span usage `{input: 1200, output: 350}` MUST yield `tokens: {input:1200, output:350}` on **both** adapters; plus a `trace-ingestor` case asserting `totalCostMicrocents > 0`. Both fail on revert.

### A-3 · HIGH — cursor helpers coerce a null timestamp to epoch 0, wedging ingestion forever

- **Files:** `packages/connector/src/infrastructure/traceSource/langwatch/clickhouse/clickhouse-langwatch-client.ts:494-534` (`nextCursorOf`, `windowCursorOf`), call sites `:225`, `:320-330` · `packages/connector/src/application/useCases/syncBatches/sync-batches-db-use-case.ts:105`, `:185-187`
- **Invariant:** 6 — ingestion stops while LangWatch's ~49-day retention burns
- **Verified:** the doc comment at `:494-502` claims the safety property — *"a row too broken to even carry (updatedAtMs, traceId) is unrepresentable in the cursor and simply skipped here"*. The code does not provide it:
  ```ts
  const updatedAtMs = Number(row?.updatedAtMs);
  if (Number.isFinite(updatedAtMs) && typeof row.traceId === 'string') { … }
  ```
  `Number(null) === 0` and `Number.isFinite(0) === true` — I ran both. (`Number(undefined)` is `NaN` and *is* skipped, which is why the guard reads as if it works.) These helpers consume **raw** rows, so a row `summaryRowSchema` rejects as poison — `occurredAtMs` requires `z.number()` — is skipped for ingestion and then used to build the cursor at epoch 0. No spec covers this shape.
- **Failure:** a full 1000-row page whose **last** row has `OccurredAt`/`UpdatedAt` arriving as JSON `null` (e.g. after a LangWatch upgrade makes the column `Nullable(DateTime64)`):
  - **Windowed (`make sync`):** the cursor is `{occurredAtMs: 0, traceId}`, so the next query's `(OccurredAt, TraceId) > (1970-01-01, traceId)` matches the whole window again → identical page → identical cursor → the `for(;;)` at `:283` **never terminates**. The backfill hangs, re-yielding and re-ingesting the same 1000 traces; `assertNotAllPoison` cannot fire because 999 rows mapped fine.
  - **Continuous worker:** the CAS correctly refuses the regression so the stored watermark never moves, but `caughtUp = scanned < batchSize` is false, so the drain loop re-fetches the identical batch **with no sleep and no backoff**, forever. Ingestion is wedged with no error and no dead letter.
- **Fix:** reject non-numeric values instead of coercing, in both helpers:
  ```ts
  const raw = row?.updatedAtMs; // resp. occurredAtMs
  if (typeof raw === 'number' && Number.isFinite(raw) && typeof row.traceId === 'string') { … }
  ```
  Independently, add a **strict-monotonicity assertion** at both consumers so a future coercion bug crashes instead of spinning: in `fetchTracesPaged`, throw when the next cursor is not strictly greater than the previous; in `SyncBatchesDbUseCase`, treat a `nextCursor` not strictly ahead of the read cursor as a halt condition.
- **Test:** `clickhouse-langwatch-client.spec.ts`: (1) `fetchBatch` over a page whose last raw row is `{traceId:'zzz', occurredAtMs:null, updatedAtMs:null}` MUST return the cursor of the last *well-formed* row, never `new Date(0)`; (2) `fetchTracesPaged` driven by a `queryFn` returning one such full page MUST terminate — assert the call count is bounded (today it loops until the test times out).

### A-5 · HIGH — an already-stamped trace's `model` is mutable, so a frozen stamp can be re-attributed to a model whose price it never used

- **Files:** `packages/core/src/infrastructure/database/mongodb/trace/mongodb-trace-repository.ts:124-176` (esp. `:147`, `:162-167`) · `packages/core/src/application/interfaces/trace-repository.ts:96-118` · `packages/connector/src/application/useCases/syncTraces/trace-ingestor.ts:287-294` · `packages/core/src/application/interfaces/trace-repository.contract.ts:170-192`
- **Invariant:** 1 and 7 — attribution is mutable in open periods, **but not the attribution the immutable stamp depends on**
- **Verified:** I read the method. `updateAttribution`'s only write guards are `if (!before || before.attributionCorrectedAt) return null;` and, one layer up, the ingestor's quarantine check. There is **no `pricingStatus` condition anywhere in the method**: `if (attribution.model !== undefined) { set['model'] = { id, provider } }` rewrites the model of a `stamped` document exactly as it does a pending one. The sibling write path was hardened for precisely this hazard — `stampPendingTrace`'s contract says the CAS *"pins the MODEL the prices were resolved for … Without the pin, model A's prices could be stamped — immutably — onto a trace whose stored model is B"* (predecessor B-5) — and `StampedTokenCost` records `appliedPriceMicrocentsPerMillion` and `appliedPriceEffectiveFrom` but **not the model key the price came from**, so the drift is undetectable after the fact. The contract test at `:170` ("MUST update attribution fields and NEVER touch the stamp") exercises `agent` and `domain` only; `model` on a stamped trace is untested.
- **Failure:** trace `t1` (2026-07-05, `anthropic/claude-sonnet-5`, 1.2M input tokens) is stamped at Sonnet's R$ 2,75/M → `totalCostMicrocents = 330_000`. Re-sync of an already-stored trace is the **steady state** — the whole quiet-period/`tokenDivergence` design exists because of it — and on a later cycle the source reports a corrected `gen_ai.request.model` of `openai/gpt-5-mini`. `insertIfAbsent` returns `skipped`, the ingestor calls `updateAttribution`, and the store now holds `model: {id:'gpt-5-mini'}` beside `stampedCosts[0].appliedPriceMicrocentsPerMillion = 275_000_000`. `GET /traces/t1` renders "modelo openai/gpt-5-mini" over a shows-the-math panel quoting a price that does not exist in the price table for that model, and `GET /billing/summary` (month × agent × **model**) reports Sonnet-priced money under the `gpt-5-mini` line. The same divergence class on *token counts* is explicitly detected and refused (`tokenDivergence`, logged, never mutating) — the one attribution field the stamp actually depends on has no such treatment.
- **Fix:** in `updateAttribution`, drop `model` from the `$set` when the `before` snapshot (already read at `:141`) has `pricingStatus === 'stamped'`, and return the fact so the ingestor can count and log a `modelDivergence` exactly like `tokenDivergence`. State the rule in the port doc above `updateAttribution` (it has none today) and add the missing contract case beside `:170`: stamped trace + `updateAttribution({model: other})` ⇒ stored model unchanged, `stampedCosts` unchanged. Longer term, persist the model key **on the stamp** so a reader can assert stamp-versus-attribution agreement instead of trusting it.
- **Test:** the contract case above, plus an ingestor unit case asserting a `skipped` re-sync carrying a different model leaves the stored model untouched and increments `modelDivergence`.

### A-4 · MEDIUM — invariant 2's only guard lives in a connector adapter, not in the package that owns "the store and its rules"

- **Files:** `packages/core/src/application/useCases/priceStamping/price-stamper.ts:38-53` · `packages/connector/src/infrastructure/traceSource/token-salvage-gate.ts` · `packages/core/package.json` (`exports`)
- **Verified:** `stampTokens` returns `{pricingStatus:'stamped', stampedCosts:[], totalCostMicrocents:0}` when **every** token count is 0 or absent: `usedTokenTypes` is empty ⇒ `missingPriceTokenTypes` is empty ⇒ the `pending_price` branch at `:51` is skipped. A grep across `packages/core/src` for `stampedCosts.length`, `sumTokens` or any zero-token guard returns nothing. The only thing preventing a corrupt row from reaching that state is `token-salvage-gate.ts` — an **infrastructure adapter of the connector** (decision 110).
- **Failure:** this is the structural cause of **A-2**, and the split sharpened it. `@observability/core` is now a standalone package whose exports map publishes `stampTokens` and the trace repository to any consumer, and the entire point of the module⊥connector split is that a second connector can be added ("a future connector = a new `compose.<name>.yml`"). A second connector that does not re-implement the salvage gate mints immutable R$ 0,00 stamps — the exact defect decision 110 was written to close, and which the predecessor log records as having escaped once already **precisely because the rule lived in one adapter**.
- **Fix:** move the invariant-2 floor into core, where it cannot be bypassed. Either (a) `stampTokens` returns `pending_price` with a distinct reason when no token type has a positive count and a model is present, or (b) the trace repository's write boundary rejects a `stamped` outcome whose `stampedCosts` is empty while `tokensTotal` is 0 and a model is set. (a) is preferable: it keeps the decision in the pure domain function that already owns the rule. Whichever is chosen, the connector's salvage gate stays as defence in depth, and the choice is a decision-log entry — it changes what a legitimately zero-token trace means.
- **Test:** a `price-stamper.spec.ts` case pinning the chosen semantics, plus a `trace-repository.contract.ts` case asserting the write boundary refuses the bypass shape.

---

## 3. P1 — Billing correctness

### B-1 · HIGH — the future-month guard exists in exactly one of three readers

- **Files:** `packages/module/src/application/useCases/billingSummary/get-billing-summary-db-use-case.ts:55-64` · `packages/module/src/application/useCases/billingSummary/list-bills-db-use-case.ts:61-64` · `packages/module/src/application/useCases/billingSeries/get-billing-series-db-use-case.ts:104-118` · `packages/core/src/domain/models/billing-period-model.ts:49-60` · `packages/core/src/infrastructure/database/mongodb/billing/mongodb-billing-query-repository.ts:80-82,290-312`
- **Invariant:** 3 (two readers of one truth disagree) and 8 (a future month is labelled "Aberto — aguardando fechamento")
- **Verified:** the guard's message `está no futuro` appears in **exactly one** use case — I grepped it. `resolvePeriodStatus` has **no `future` case**, so a future month resolves to `'open'`. Both live scan paths are open-ended above: `listBills` and `monthlyRollup` apply only `startedAt: {$gte: sinceInclusive}`. The ingest boundary admits future timestamps (`started_at` is a bare `z.number()`), and the quiet-period guard filters on `UpdatedAt`, not `OccurredAt`.
- **Failure:** one stored trace at `2027-05-10` (source clock skew, or an agent emitting a wrong `started_at`), today being 2026-08:
  1. `GET /api/v1/bills` returns `{year: 2027, month: 5, periodStatus: "open"}` labelled *"Aberto — aguardando fechamento"* with that trace's cost, offered in the UI's month selector.
  2. `GET /api/v1/billing/summary?year=2027&month=5` answers **400** — the selector row cannot be opened and `/billing/statement` cannot export it. Two readers of one store disagree about whether the month exists.
  3. Worst: `GET /api/v1/billing/series` computes `lastOrdinal = Math.max(...knownOrdinals, currentOrdinal)`, enumerates every month through 2027-05, and `slice(-12)` keeps 2026-06…2027-05 — **nine zero-filled future bars**. With a trace dated ≥12 months out the chart contains **no real month at all** and the current month falls off the left edge, every bar at R$ 0,00 with status `open`, nothing signalling the anomaly.
- **Fix:** give the label rule its missing case in its one home, then let the readers use it.
  1. `billing-period-model.ts` — extend `BillingPeriodStatus` with `'future'` and return it from `resolvePeriodStatus` when `(year, month)` is after `now`'s UTC calendar month (a lifecycle-closed future month is impossible; the close guard rejects it).
  2. `ListBillsDbUseCase.list` — map `'future'` rows to a distinct, non-selectable item (or exclude them and report a `futureDatedTraceCount`) instead of `openItem`.
  3. `GetBillingSeriesDbUseCase.list` — clamp `lastOrdinal` to `currentOrdinal` and drop future ordinals from `knownOrdinals` before the min.
  4. `GetBillingSummaryDbUseCase` — raise its existing error off `resolvePeriodStatus(...) === 'future'` rather than re-spelling the comparison, so the three readers cannot drift again.
  5. Optionally surface future-dated traces at ingest as a counted anomaly — they are archived correctly (invariant 6) but are unbillable until their month arrives.
- **Test:** `list-bills-db-use-case.spec.ts` and `get-billing-series-db-use-case.spec.ts` with a pinned `now` of 2026-08-03 and one stamped trace at 2027-05-10; plus an HTTP-level test that **every month `/bills` lists is accepted by `/billing/summary`** — the direct invariant-3 cross-check the suite lacks.

### B-2 · HIGH — `make billing-close YEAR=26` closes June 1926 and permanently destroys the live-scan bound

- **Files:** `packages/module/src/main/jobs/close-billing-period.ts:26-31` · `packages/module/src/main/jobs/reopen-billing-period.ts:23-31` · `packages/core/src/domain/models/billing-period-model.ts:63-75`, `:150-195` · `packages/module/src/presentation/helpers/query-validation.ts:31-34`
- **Invariant:** 8 (a billing period must be a real calendar month)
- **Verified:** both runbook doors validate integrality only —
  ```ts
  if (!Number.isInteger(year) || !Number.isInteger(month)) { …usage…; process.exit(1); }
  ```
  while the HTTP door for the same two values is bounded (`min(1970).max(9999)` / `min(1).max(12)`). `monthWindowUtc` guards `month < 1 || month > 12` but **not** `year` — I read the source and ran `Date.UTC(26,5,1)` → `1926-06-01T00:00:00.000Z` (ES two-digit-year mapping). Every file under module `main/jobs/` reports **0 % coverage**, which is why neither door has a test. Decision 123 unified the *date* border across runbook doors and left the *year/month* border forked. **Found independently by two lenses.**
- **Failure:** the operator abbreviates the year: `make billing-close CLIENT=x YEAR=26 MONTH=6`. `Number.isInteger(26)` passes, `monthWindowUtc(26,6)` returns `[1926-06-01, 1926-07-01)`, which is fully past, holds no traces and no `pending_price` — so `assertOlderMonthsClosed` returns early and the close **succeeds**, printing `✔ Mês 26-06 FECHADO` and persisting `{year: 26, month: 6, status: 'closed'}` plus a zero-total snapshot. Then, permanently, until someone hand-edits Mongo:
  - `firstOpenMonthStart` sorts `earliestClosed` to `{26,6}`, the anchor test `Date.UTC(2026,…) < Date.UTC(26,5,1)` is false, the walk starts at 1926 and returns **1926-07-01**. The decision-119/C-7.1 scan bound is destroyed: every `/bills` and `/billing/series` reverts to a **full-collection scan over full-content trace documents** — silently reintroducing the exact regression that bound was written to fix, and pulling legitimately closed months back into the live scan.
  - `/bills` lists a bogus closed bill "junho de 26 — R$ 0,00" forever.
  - `MONTH=13`/`MONTH=0` is the loud sibling: `monthWindowUtc` throws a bare `Error`, which the job's `catch` (narrowed to `BillingCloseBlockedError | BillingPeriodStateError`) rethrows — an unhandled-rejection stack instead of the usage line.
- **Fix:** two layers, mirroring exactly how decision 123 unified the date doors.
  1. **Structural:** bound the year inside `monthWindowUtc` itself (`year < 1970 || year > 9999` → throw), so the *domain* refuses an impossible period at every caller.
  2. **Door-level:** move `yearMonthQueryShape` into `@observability/core` — it is a domain rule, not a presentation one, the same move made for `isoDateRule` — and have both jobs `safeParse` through it, printing the usage line naming the offending value. Name the helper after the **rule**, not after one door; that naming mistake is what let the second date door keep its own spelling for four passes.
- **Test:** `billing-period-model.spec.ts` — `expect(() => monthWindowUtc(26, 6)).toThrow(/Invalid billing period/)`, plus `1969` and `10000`. A `close-billing-period-wiring.spec.ts` in the same source-pin style as the existing `runbook-date-wiring.spec.ts` asserting both jobs apply the shared schema. Both fail on revert.

### B-3 · MEDIUM — `lineKey`/`agentKey` join on `@@`, a separator legal inside the fields it separates

- **Files:** `packages/module/src/application/useCases/billingStatement/statement-engine.ts:133-141` (`lineKey`), `:182-185` (`agentKey`), `:397-407` (`addRecordPriceVersions`)
- **Invariant:** 3 — the agent/model rows stop being a partition of the total
- **Verified:** all three keys are `[...].join('@@')`, and the doc comment above `lineKey` reasons **only about the null sentinel** (U+0000 versus a space). Nothing constrains the *separator*. I ran it:
  ```
  lineKey({id:'suporte@@v', version:'2'})  -> "suporte@@v@@2@@gpt@@input@@100@@0"
  lineKey({id:'suporte',    version:'v@@2'}) -> "suporte@@v@@2@@gpt@@input@@100@@0"
  COLLIDE: true      agentKey COLLIDE: true
  ```
  Agent ids and versions are free-form source metadata with no charset constraint (`z.record(z.string(), z.unknown())`; both mappers accept any non-empty string).
- **Failure:** two agents in one month — `{id:'suporte@@v', version:'2'}` and `{id:'suporte', version:'v@@2'}` — on the same model, token type and price version. The fold merges them into **one** `StatementLine` carrying the first-seen `agentId`; `buildAgentGroups` emits **one** agent card; `comparison.by_agent` emits **one** row. `/billing/summary` reports one agent where the store holds two, the second agent's entire cost is attributed to the first, and the frozen snapshot records the misattribution permanently. The month **total is unaffected**, so no total-versus-parts check catches it — the exact silent shape of re-audit iteration 6's space sentinel, one level deeper.
- **Fix:** make the keys **injective** rather than choosing a "safer" separator: replace each `[...].join('@@')` with `JSON.stringify([...])` over the same tuple. Nulls stay `null`, so the U+0000 sentinel and its comment disappear entirely and `agentKey` keeps its exported one-home role. **Do not move `STATEMENT_LOGIC_VERSION`**: for every key without `@@` the grouping is byte-identical, and bumping would falsely mark already-frozen reproducible snapshots as another calculation's output — decision 122's own rationale. While there, route `buildModelMixByAgent` (`:285-289`) and `agentModelDisplayCents` (`billing-view-model.ts:304-319`) through `agentKey` instead of their hand-spelled field comparisons, so the grouping rule has one spelling everywhere.
- **Test:** in `statement-engine.spec.ts`, fold two records with the agent pairs above and assert `lines.length === 2` and `agents.length === 2`. Fails on revert with 1 and 1.

### B-4 · MEDIUM — billing buckets by UTC day and month while every displayed timestamp is UTC−3

- **Files:** `packages/core/src/common/helpers/display/display.ts:10`, `:67`, `:78` · `packages/core/src/infrastructure/database/mongodb/billing/mongodb-billing-query-repository.ts:480` · `packages/module/src/presentation/controllers/billing/billing-view-model.ts:665-673` · `packages/ui/app.js:148`, `:461`, `:1199-1208` · `docs/produto/billing-implementacao.md:246-248`
- **Verified:** `display.ts:10` `const DISPLAY_UTC_OFFSET_MS = -3 * 60 * 60 * 1000;` and `:67` renders every datetime through that shifted value, so `started_at_display` is BRT. The daily rollup groups with `$dateTrunc: { date: '$startedAt', unit: 'day', timezone: 'UTC' }`, the chart's labels come from raw UTC components via `formatUtcDateDisplay` (which does **not** apply the offset), and `monthWindowUtc` is UTC. The UI binds both with no math.
- **Failure:** for the BR client this is deployed for, a trace at `2026-08-01T01:00Z` is listed and detailed as **31/07/2026 22:00** but charted in the **01/08** bar and billed in the **August** invoice. Every day's last three local hours land in the next day's bar; every month's last three land in the next month's bill. An operator reconciling "o que rodou em julho" against the July statement finds a discrepancy no page explains, and the daily chart's own labels use a different clock from every other date on screen.
- **Note:** `billing-implementacao.md:247-248` records the month boundary as an open product question and states that changing it touches `monthWindowUtc` "e nada mais" — there are at least two other sites, so that sentence is wrong regardless of which way the question is decided.
- **Fix:** make it one rule instead of three. Export a single `DISPLAY_TIME_ZONE` / `DISPLAY_UTC_OFFSET_MS` pair from `display.ts`; pass `timezone: DISPLAY_TIME_ZONE` to the `$dateTrunc`; build the daily labels from the same offset helper `formatDateTimeDisplay` uses; decide `monthWindowUtc` in the same change and record it as a decision row. **If the product answer is "keep UTC boundaries",** the minimum honest fix is the inverse: label the daily lens explicitly ("dias UTC") and correct `billing-implementacao.md:247`. This is a product decision — see §9-Q1.

### B-5 · MEDIUM — `POST /prices` runs an unbounded, fully sequential reprocess inside the request

- **Files:** `packages/core/src/infrastructure/database/mongodb/trace/mongodb-trace-repository.ts:281-295` · `packages/core/src/application/interfaces/trace-repository.ts:111-112` · `packages/core/src/application/useCases/reprocessPending/reprocess-pending-db-use-case.ts:39`, `:57-106` · `packages/module/src/application/useCases/registerPriceVersion/register-price-version-db-use-case.ts:54-56`
- **Verified:** `findPendingPrice()` is `find({pricingStatus:'pending_price'}, {projection…}).sort({startedAt:1}).toArray()` — **no `limit`** — while its own comment says the sweep *"must stay bounded even when a new unpriced model has accumulated a day of traffic"*. The projection bounds bytes per document, not the number of documents. `RegisterPriceVersionDbUseCase.register` then awaits `reprocess()` on the HTTP path, and the sweep is a strictly serial loop: per trace one `findEffectivePrices` aggregation, one `stampPendingTrace` CAS, one post-stamp `findOne`, and one session recompute. The read plan was verified on a real server: it rides `pricingStatus_1_startedAt_1` with no blocking sort, so the cost is purely count × round-trips.
- **Failure:** at the project's stated sizing (1M traces/month ≈ 33k/day) a model whose price was not registered before its traffic started accumulates ~33k `pending_price` traces in a day — which invariant 2 keeps pending by design. `POST /prices` for that model then issues ~165k serial Mongo operations inside one HTTP request: minutes of wall time. Any proxy or client timeout aborts the response while the loop keeps running; the operator gets no reprocess report and cannot tell how many traces were stamped, and a second `POST` answers **409** without re-running the sweep, so the only recovery is `make reprocess`.
- **Fix:** add `findPendingPrice(limit: number)` (`.limit()` on the existing indexed read; the sort key already gives a stable oldest-first order); have `reprocess()` page until a page yields no progress, reporting per run; on the HTTP path cap the synchronous work at one page and return the report plus `pending_remaining`, leaving the worker's periodic sweep (decision 57, already the documented backstop) to drain the rest. The runbook job stays uncapped.
- **Test:** unit test with N > page-size pending traces asserting `findPendingPrice` is called with the limit and the HTTP report exposes the remainder; repository integration test asserting `findPendingPrice(10)` returns exactly 10 of 25, oldest first.

---

## 4. P1 — Package-split integrity (the new surface)

This section is the point of the audit: everything here was introduced by `fba0a13..HEAD`.

### C-1 · HIGH — `module` and `connector` emit no type declarations, and core's build excludes a file both import

Two defects with one consequence, so they are specified together.

**(a) No declaration emission.** Only `packages/core/tsconfig.json` sets `composite`/`declaration`/`declarationMap`. `find packages/{module,connector}/dist -name '*.d.ts' | wc -l` → **0**; core → 73. So `packages/connector/dist/application/interfaces/trace-source-client.js` is a 58-byte stub with every interface erased and no `.d.ts` beside it. A typed import of `SourceTrace` from `@observability/connector` therefore fails: `tsc` reports `TS2305: Module '…/trace-source-client.js' has no exported member 'SourceTrace'`.

**(b) `billing-test-fakes.ts` is excluded from core's build but imported by two packages.** `packages/core/tsconfig.build.json` excludes `src/**/billing-test-fakes.ts`, and `core/dist/application/` contains only `interfaces` and `useCases`. But `@observability/core/application/testSupport/billing-test-fakes.js` is imported by **8 files in module** and **2 in connector**.

- **Verified:** `tsc --noEmit -p packages/module/tsconfig.json` → **22 errors**; `-p packages/connector/tsconfig.json` → **2 errors**; core → clean. The module's errors are 7 × `TS2307` plus a cascade of `TS7006`/`TS4112`/`TS2554`/`TS2339`/`TS2740` that appear *because* the fakes degrade to `any`.
- **Failure, and it is worse than a red typecheck.** Two of those cascaded errors are `TS2740: Type 'WindowRecordingQueryRepository' is missing the following properties from type 'BillingQueryRepository': pendingPriceSummary, listBills, monthlyRollup, dailyRollup, and 5 more`. In other words, **the test fakes are no longer checked against their ports** — TypeScript is telling us they do not implement them, and the message is lost in noise nobody can act on. That is precisely the "fakes drift from adapters" class the predecessor log records as biting at iteration 4, now type-invisible; **E-4** is the same defect observed from the test side.
- **Scope bound (important — do not over-correct):** the emitted `dist` genuinely resolves. A walk over every emitted `.js` in all three packages resolved **476 specifiers with 0 unresolved**, and `node dist/main/index.js` reaches `MongoClient` construction through the exports map. This is a type-contract and DX defect, not runtime breakage.
- **Fix:**
  1. Add `"declaration": true, "declarationMap": true, "composite": true` to `packages/module/tsconfig.json` and `packages/connector/tsconfig.json` (matching core), so every package publishes types for the packages that consume it.
  2. Decide where the shared billing fakes live. They are **test-support consumed across package boundaries**, which the current layout has no home for. Two options: (i) keep them in core but **stop excluding them from the build**, accepting test-support in `core/dist` (simplest, and the exclusion buys little now that `module`'s own build already excludes its test files); or (ii) extract a private `@observability/test-support` workspace package that core, module and connector all devDepend on. Recommendation: **(i)** now, **(ii)** if the shared surface grows. Either way, add the resulting path to the coverage excludes.
  3. Add `"references": [{ "path": "../core" }]` to `packages/module/tsconfig.json` and `packages/connector/tsconfig.json` (the dev/editor configs — only the `.build` variants have them today), so an editor and a bare `tsc --noEmit` resolve the same way the build does.
- **Test:** a `deploy-smoke`-style assertion, or a CI step, running `tsc --noEmit` for all three packages. It fails today.

### C-2 · MEDIUM — the jest configuration structurally hides C-1, and no test runs the built output

- **Files:** `packages/{core,module,connector}/jest.config.mjs` (`moduleNameMapper`)
- **Verified:** all three map `^@observability/core/(.*)\.js$` → `<rootDir>/../core/src/$1.ts` (module additionally maps `connector`). The suite therefore **never** exercises the exports map, the emitted `dist`, or `.js`-specifier resolution — the entire mechanism the packages were split to create. 637 green tests cannot see either half of C-1.
- **Failure:** any defect in the packaging contract — a missing `exports` entry, a wrong `main`, a file excluded from a build, a bad extension — is invisible to the suite and surfaces only in a container. C-1 is the existence proof.
- **Fix:** keep the mapper (it is the right call for iteration speed) and add **one** integration check that runs the real thing: a `packaging.test.ts` that, after `npm run build`, resolves each package's public entry points through Node's real resolver (`import.meta.resolve` or a child process `node -e "await import('@observability/core/domain/models/trace-model.js')"`), and asserts the three packages' `dist` trees contain the `.d.ts` files their consumers import. Wire it into `test:ci`.

### C-3 · MEDIUM — the module ships the vendor SDK it is built not to know

- **Files:** `packages/module/package.json` (`dependencies`) · `docker/module.Dockerfile:18-21`, `:50` · `CLAUDE.md:43` · `docs/produto/backlog-v2.3.md` decision 125
- **Verified:** `dependencies` contains `@clickhouse/client` and `fast-glob`. A grep across `packages/module/src` finds **one** hit for either: a *comment* at `v1-routes-setup.ts:8` ("the previous fast-glob discovery"). No module source imports either. Both are genuine dependencies of `packages/connector`. Because they are `dependencies`, not `devDependencies`, `npm ci --workspace=@observability/module --omit=dev` (`module.Dockerfile:50`) installs them into the runtime image — which `module.Dockerfile:18-19` calls "VENDOR-FREE BY CONSTRUCTION". Decision 125's proof is *"verificado com grep na imagem"* — a **source** grep, which structurally cannot see a `node_modules` driver. **Found independently by three lenses.**
- **Failure:** the image sold as vendor-free ships the LangWatch stack's ClickHouse client: extra bytes, extra CVE surface, and a false claim in three documents.
- **Fix:** delete both entries from `packages/module/package.json` `dependencies`, re-run `npm install` to refresh the root lock, and close the hole that let it happen — see **C-4**.

### C-4 · MEDIUM — the vendor-blindness fitness test cannot see `package.json`, and its regex omits the storage vendor

- **Files:** `packages/module/src/architecture-boundaries.spec.ts:23`, `:72`, `:75-103`
- **Verified:** all three architecture specs build their file list from `walk(join(process.cwd(), 'src'))` filtered to `.endsWith('.ts')` — **no spec reads a `package.json` or any non-`src` file**. And the vendor pattern is `const VENDOR = /langwatch/i` only: `clickhouse` is not in it, so `import { createClient } from '@clickhouse/client'` in module production code would **pass** the vendor-blindness test. The claim that depends on the manifest is written in prose only, in `module.Dockerfile:20`.
- **Failure (concrete regression path):** moving `"@observability/connector": "*"` from `devDependencies` to `dependencies` — a one-line change nothing flags, and the *natural* "fix" for C-1's red typecheck — makes `npm ci --omit=dev` install the connector, its `@clickhouse/client` and its LangWatch adapters into the module runtime image, with **every architecture test still green** and the Dockerfile comment still asserting the opposite. Separately, `packages/module/.env.development` contains `LANGWATCH_ENDPOINT` and a live `sk-lw-…` key inside the package the test declares vendor-blind (not a leak — `packages/module/.gitignore:3` covers `.env*` and the key was never committed — but outside the test's reach).
- **Fix:** in `packages/module/src/architecture-boundaries.spec.ts`:
  1. Extend the vendor pattern to `/langwatch|clickhouse/i`.
  2. Add a manifest case reading `../package.json`: assert `dependencies` contains no `@observability/connector` and no key matching the vendor pattern. This turns the Dockerfile's prose into an enforced claim and fails today on C-3.
  3. Widen the file walk beyond `src` for the vendor rule (or at minimum add the package's `.env.example`), so the package-level claim is checked at package level.

### C-5 · MEDIUM — `core` has no public API surface; every internal file is a supported import path

- **Files:** `packages/core/package.json` (`"exports": { "./*": "./dist/*" }`) · consumers across module and connector
- **Verified:** the wildcard export publishes every emitted file. Module reaches into core's Mongo internals from **12 sites** (`@observability/core/infrastructure/database/mongodb/billing/…`, `…/trace/…`, `…/priceVersion/…`, `…/migrations/…`), connector from ~10.
- **Failure:** the encapsulation the split was supposed to create is nominal. Any internal reorganisation of core — renaming a file, moving a repository, splitting a module — is a breaking change to two packages with no compiler-visible contract to negotiate it, and nothing distinguishes "core's intended API" from "a file that happens to exist". This is the boundary equivalent of the `main` field problem in **H-3**.
- **Fix:** declare an intentional surface. Give core an explicit `exports` map naming the layers it means to publish (`./domain/*`, `./application/interfaces/*`, `./common/helpers/*`, and a deliberately-named `./infrastructure/database/mongodb/*` for the composition roots that legitimately need adapters), and drop the bare `./*`. Do the same for connector. The import sites do not change; what changes is that a future move inside core is caught at the boundary instead of at runtime in a container.

### C-6 · MEDIUM — the Mongo env bootstrap was copied, not moved, when the worker left the module

- **Files:** `packages/module/src/infrastructure/configuration/helpers/environment-setup.ts:1-102` · `packages/connector/src/infrastructure/configuration/helpers/environment-setup.ts:1-125`
- **Verified:** the two files share, verbatim: the `environmentEnum` block, the `Environment` type, all six `MONGO_DB_*` zod fields **with identical error messages** (`'MONGO_DB_PORT must be a valid integer string'`), the `MONGO_DB_ATLAS` `z.enum(['true','false'])` field **with the same explanatory comment**, the `parseInt`/`=== 'true'` transforms, and the whole `dotenv.config` → `safeParse` → `console.error` → `process.exit(1)` tail. The *interface* is correctly single-sourced in core (`MongoDbEnvironmentVariables`, re-exported by the module) — only the **parsing** was duplicated.
- **Failure:** core owns the type but neither container's parser. Adding `MONGO_DB_AUTH_SOURCE` or `MONGO_DB_TLS` to the shared interface compiles clean while only one of the two images actually reads it: the API connects with the new setting, the ingestion worker silently does not, and the symptom is an auth failure in a sidecar whose healthcheck is a process check. This is the textbook shape of the log's root pattern, created by the split.
- **Fix:** put the shared half in core as `common/config/parse-mongo-env.ts` (the zod fragment + the transform + the exit tail), and let each package's `environment-setup.ts` spread it into its own schema alongside its package-specific fields (`SERVER_PORT`/`AUTH_SYSTEM_*` for module, `LANGWATCH_*`/`TRACE_INGESTION_*` for connector). Core already owns the type; it should own the reader. Fold **G-4** and **G-5** into the same change.

### C-7 · MEDIUM — the connector's composition root exports concrete adapters as its public type surface

- **Files:** `packages/connector/src/main/factories/sync-factory.ts:85`, `:103` · `packages/connector/src/main/jobs/run-trace-ingestion-loop.ts:78`, `:85` · `packages/connector/src/application/interfaces/trace-batch-source.ts:35-66` · `packages/connector/src/architecture-boundaries.spec.ts:70-93`
- **Verified:** `makeIngestFailureRepository = (): MongoDbIngestFailureRepository` returns the concrete Mongo class although the `IngestFailureRepository` port declares every method used. `makeSyncBatchesUseCase` returns `{ useCase, source: ClickHouseLangWatchClient }` — the vendor class — because `assertCompatibleSchema()` is on **no port**: `TraceBatchSource` declares only `fetchBatch` and an optional `sourceNow`. `run-trace-ingestion-loop.ts:78` then calls `batchSync.source.assertCompatibleSchema()` from `main/jobs/`, which is **not** in `VENDOR_ALLOWED_PREFIXES`.
- **Failure:** the connector spec's headline — "MUST keep every layer outside the adapter vendor-blind (swap-safe)" — is a **text grep**, and it passes here only because the worker never spells the class name; the file is nonetheless statically bound to the ClickHouse adapter's type. Introducing a second batch source means editing the worker, and writing the honest type annotation turns a green "swap-safe" suite red for a change that swaps nothing.
- **Fix:** add `assertCompatibleSchema(): Promise<void>` to `TraceBatchSource` (it is a source-contract concern, not a ClickHouse one), narrow both factory return types to their ports, and extend the connector spec's vendor rule from a text grep to an **import** rule: no file outside the allow-list may import a specifier under `infrastructure/traceSource/langwatch/`. This also makes **G-2**'s fix expressible.

---

## 5. P2 — API contract and security

### D-1 · HIGH — wildcard CORS turns any browser into an exfiltration proxy for the unmasked archive

- **Files:** `packages/module/src/main/server/middlewares/cors.ts:8-10` · `packages/module/src/main/server/middlewares/cors.test.ts:14-19` · `docker/ui.nginx.conf.template:1-3` · `compose.module.yml:80-85`
- **Verified:** `res.set('access-control-allow-origin', '*')` **unconditionally**, on every `/api/v1` response, alongside `access-control-allow-headers: Content-Type, Authorization`. Probed live against the built `dist`: `GET /api/v1/traces` → `*`, `POST /api/v1/prices` → `*`, `OPTIONS` → `*`. The nginx template's own header states the opposite of the code: *"Same origin — the UI needs no API address, **no CORS**, no discovery."* Nothing in the repo is a cross-origin client. The wildcard is **pinned by a test that asserts it**, so it reads as intentional rather than as an unreviewed default. The priority is inverted, confirmed live: `/api/v1/docs/openapi.json` — the harmless integration surface — carries **no** ACAO (the docs mount precedes the CORS middleware at `app.ts:13-14`), while every data endpoint carries `*`.
- **Failure:** auth is off by default (PoC behaviour), and `compose.module.yml:81-85` documents `UI_BIND=0.0.0.0` as the override that "may legitimately be needed", with nginx proxying `/api/` through. An operator with the dashboard on the LAN visits any web page; that page runs `fetch('http://dash.client.local:8080/api/v1/traces?page_size=100')`, walks `/api/v1/traces/{id}`, and POSTs the results offsite. Because the response says `*` and no credentials are involved, the browser hands over the full **unmasked** LLM input/output — invariant 6's permanent archive. **No attacker network-reachability is required; the victim's browser is the reachability.** The A-2 remediation of the predecessor audit made the *ports* loopback, which does not close this.
- **Fix:** delete `corsMiddleware` from `middlewares-setup.ts` — the only shipped client is same-origin, exactly as the nginx template says. If a cross-origin client is ever anticipated, replace the wildcard with an env-driven allowlist: parse `CORS_ALLOWED_ORIGINS` (comma-separated), echo back `req.headers.origin` only on an exact match, always emit `Vary: Origin`, and emit nothing when the variable is unset.
- **Test:** invert `cors.test.ts` — `GET /api/v1/traces` with `Origin: https://evil.example` MUST NOT answer `access-control-allow-origin: *`, and MUST NOT echo the origin when `CORS_ALLOWED_ORIGINS` is unset. Fails on revert.

### D-2 · MEDIUM — a correct price body with the wrong `Content-Type` is reported as a missing field

- **Files:** `packages/module/src/main/server/middlewares/body-parser.ts:1-3` · `packages/module/src/main/server/helpers/middlewares-setup.ts:14-16` · `packages/module/src/presentation/controllers/prices/register-price-version-controller.ts:39-63`
- **Verified:** `bodyParserMiddleware = json()` — default `type: 'application/json'` only. body-parser 1.20.6 executes `req.body = req.body || {}` **before** its `shouldParse` type check, so a non-JSON content type leaves `req.body === {}` rather than erroring. Probed live against the built `dist`: `POST /api/v1/prices` with `Content-Type: text/plain` and a fully valid JSON price body → `400 {"msg":"Missing parameter: model","name":"MissingParamError"}`. Same for `application/x-www-form-urlencoded`.
- **Failure:** **curl's default for `-d @price.json` is `application/x-www-form-urlencoded`.** An operator registering a contracted price is told *"Missing parameter: model"* about a request whose `model` is present and correct. The diagnosis points at the payload, so they edit the payload; the price never lands; `pending_price` traces stay unstamped (invariant 2) and the month cannot close (T6 blocks on pending). `middlewares-setup.ts:14-16` claims "a form-encoded body must never be *silently accepted*" — it is silently accepted as empty and then misattributed.
- **Fix:** add a middleware before the parser: when the method is POST/PUT/PATCH and `Content-Type` does not match `application/json`, answer **415** with a new `UnsupportedMediaTypeError extends ApiError` in the same `{name,msg}` shape. Document `415` on `POST /api/v1/prices` in `openapi.ts`. (The alternative, `json({ type: () => true })`, surfaces body-parser's own `entity.parse.failed` but loses the strictness the comment intends.)
- **Test:** `app-error-shape.test.ts` — `POST /api/v1/prices` with `Content-Type: text/plain` and a valid body MUST answer 415 and MUST NOT answer `MissingParamError`.

### D-3 · MEDIUM — the registered price table has no read endpoint; `GET /api/v1/prices` answers 405

- **Files:** `packages/module/src/main/server/routes/v1/prices-routes.ts:5-7` · `packages/module/src/main/server/middlewares/not-found.ts:25` · `packages/module/src/main/docs/openapi.ts:452-487` · `docs/produto/backlog-v2.3.md` US4
- **Verified:** only `POST /prices` is registered and only `post` is documented. Probed live: `GET /api/v1/prices` → **405**, `Allow: POST`. Backlog **US4** is an explicit user story — *"quero ver a tabela de preços aplicada à minha empresa … para conferir a conta da fatura contra o meu contrato"* — with no API surface. `make seed-prices` and `price:insert` are write-only doors; there is no `price:list` job. `listVersions()` already exists on the repository (added by the predecessor audit's C-7.3).
- **Failure:** a trace is stored `pending_price`. The operator's entire diagnostic question is *"which `(model, token_type, effective_from)` rows exist?"* — and the only answer available is `mongosh` into the archive. Worse, the answer the API *does* give (`405 Allow: POST`) actively asserts the collection is unreadable, which is a wrong statement about a resource that exists and is versioned data (invariant 9). A second operator re-registering a price to find out gets **409** with no way to see what occupies the slot.
- **Fix:** add `GET /prices` backed by a `ListPriceVersionsController` over the existing `listVersions()`, with a strict query schema (`model?`, `token_type?`, unknown param → 400) whitelisting `{model, token_type, price_brl_per_million, price_display, effective_from, effective_from_display}` — R$-only by construction (invariant 4). Add the route to `not-found.ts`'s table and a `get` operation to `openapi.ts` and Postman.
- **Test:** `prices-routes.test.ts` — after inserting two versions of one model, `GET /api/v1/prices` answers 200 with both and the response matches the existing forbidden-key regex (no `usd`/`ptax`/`markup`/`margin`); `?bogus=1` → 400.

### D-4 · MEDIUM — the 405 route table is a second, untested spelling of the router

- **Files:** `packages/module/src/main/server/middlewares/not-found.ts:13-26` · `packages/module/src/main/server/helpers/v1-routes-setup.ts:13-18` · `packages/module/src/main/docs/openapi.ts:197-487` · `docs/observability-api.postman_collection.json`
- **Verified:** `KNOWN_ROUTES` hand-lists all twelve method+path pairs with the comment *"exactly as registered in routes/v1"*, and `not-found.ts:8` states the duplication is "Static ON PURPOSE — a new route module is one import + one line there, and one line here." A grep for `KNOWN_ROUTES`, `router.stack`, `_router` or `allowedMethods` across the module's specs returns **nothing**: no test compares the table to Express's actual router. Counting the OpenAPI `paths` block and the Postman collection, the route table exists in **four** hand-maintained places, none cross-checked. The gap is already observable: docs paths are absent from the table, so `POST /api/v1/docs/openapi.json` answers **404** while every other served path answers 405 with `Allow`.
- **Failure:** implement **D-3** (one line in `prices-routes.ts`) and forget the table line: `GET /api/v1/prices` is served 200 by the router while `DELETE /api/v1/prices` answers `405 Allow: POST`, telling a client the resource has no GET while the server serves it. A client that caches the `Allow` list (RFC 7231 §7.4.1 permits this) permanently stops polling an endpoint that works. This is the same class iteration 2 already fixed once for HEAD — that fix corrected the table's *contents* without removing the second source of truth. It is the repo's own named root-cause pattern, at the API's front door, four times over.
- **Fix:** derive `ROUTE_MATCHERS` from the Express router instead of a literal. `setupErrorHandling(app)` runs last, so the mounted `/api/v1` router's stack is complete: walk it, read each layer's `route.path` and `route.methods`, prefix with `/api/v1`. If deriving is rejected, keep the literal but add the test below — the point is that the two must not be able to disagree silently.
- **Test:** `app-error-shape.test.ts` — enumerate the live router stack and assert the derived `{method, path}` set deep-equals `KNOWN_ROUTES`. Add a route without touching the table and it must fail. Extend the same idea to `openapi.spec.ts` (paths ≡ router, modulo `:id`↔`{id}`).

### D-5 · MEDIUM — `/billing/statement` declares no media type, documents unbounded params, and ignores `Accept`

- **Files:** `packages/module/src/main/docs/openapi.ts:425-450` · `packages/module/src/presentation/controllers/billing/export-statement-controller.ts:206-260` · `packages/module/src/presentation/interfaces/http.ts` · `docs/observability-api.postman_collection.json`
- **Verified:** three drifts in one operation. (1) `openapi.ts:445` gives the 200 a prose description naming `text/csv` and `text/html` but **no `content` key at all**, while every other operation emits `content` via `okResponse()`. (2) `:437-438` documents `year`/`month` as bare `{type:'integer'}` while the controller shares `yearMonthQueryShape` (`min(1970).max(9999)` / `1-12`) — and `/billing/summary` documents the *same* params **with** those bounds, in the same file. (3) `HttpRequest` carries only `body`/`params`/`query`; a repo-wide grep for `req.accepts` or `'accept'` returns nothing, so `Accept` is structurally unreachable from any controller.
- **Failure:** a client generated from `openapi.json` has no declared response media type for `/billing/statement`, so generators default the deserializer to JSON; the server ignores `Accept` and returns `text/csv; charset=utf-8` with a UTF-8 BOM, and the generated client throws instead of receiving a statement. The same client happily sends `month=13` (no bound in the doc) and gets a 400 the schema said was impossible.
- **Fix:** (1) give the 200 a real `content` block for both media types; (2) hoist the bounded `year`/`month` parameter objects into one shared const used by both operations, so the doc cannot drift from `yearMonthQueryShape` again; (3) either honour `Accept` (with 406 when it matches neither) or state in the operation description that `format` is authoritative and `Accept` is ignored. Also reconcile the three spellings of the API port — Postman's `baseUrl`, `compose.module.yml`'s default `3000`, and `clients/example.env:24`'s `API_PORT=3001`.
- **Test:** `openapi.spec.ts` — the statement 200 declares both media types under `content`, and its `year`/`month` schemas deep-equal `/billing/summary`'s.

### D-6 · LOW — `z.coerce.number()` accepts hex, exponent and padded values on every numeric param

- **Files:** `packages/module/src/presentation/helpers/query-validation.ts:8-11`, `:31-34` · `packages/module/src/presentation/controllers/billing/get-billing-series-controller.ts:24-28`
- **Verified:** `z.coerce.number()` delegates to `Number()`, which accepts `0x`/`0o`/`0b` literals, exponent notation and surrounding whitespace. Probed live: `GET /api/v1/traces?page=%202%20&page_size=0x10` passed validation and reached the repository layer. (`Infinity`, `-0` and arrays are correctly rejected by `.int()`/`min(1)`.)
- **Failure:** `?page_size=0x10` serves 16 items per page while the published contract declares `type: integer` — a value no JSON-Schema validator accepts, so a gateway or generated client rejects what the server honours. It also contradicts the policy every controller states in a comment ("an unknown param is a 400, never silently ignored"): a *malformed* param is silently reinterpreted.
- **Fix:** replace `z.coerce.number().int()` with a string-first rule in `query-validation.ts` — `z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1))` — and apply it to `months`/`days` in the series controller too.
- **Test:** `query-validation.spec.ts` — `page=0x10`, `page=' 2 '`, `page_size=1e2` each yield `InvalidParamError` naming the param.

### D-7 · LOW — no cache directives in either direction

- **Files:** `packages/module/src/main/server/helpers/middlewares-setup.ts:10-22` · `packages/module/src/presentation/helpers/http-helper.ts:3-31` · `packages/module/src/presentation/controllers/billing/export-statement-controller.ts:240-260` · `docker/ui.nginx.conf.template:14-25`
- **Verified:** a repo-wide grep for `Cache-Control`, `no-store`, `ETag`, `Last-Modified` across `packages/**` returns **zero** hits; live probes confirm every response carries no `cache-control`. nginx sets `no-cache` on the static shell but adds nothing to `location /api/`. `HttpResponse` has no way to express a header — only the export controller sets any, and only Content-Type/Disposition.
- **Failure:** both directions are wrong at once. (a) `GET /api/v1/traces/{id}` returns full unmasked LLM content with no `no-store`, and `format=html` is served **inline** with no `X-Content-Type-Options: nosniff`; on a shared workstation the transcript and the month's figures persist in disk cache and back/forward history after the tab closes. (b) A **closed** month is immutable by invariant 8 and is nonetheless re-materialised from Mongo on every request with no `ETag`/`max-age` — the one provably cacheable endpoint advertises nothing.
- **Fix:** add `Cache-Control: no-store` plus `X-Content-Type-Options: nosniff` as defaults for `/api/v1` in `middlewares-setup.ts`; then, in the summary and statement controllers, override to `private, max-age=86400, immutable` with an `ETag` derived from `(year, month, snapshot_version)` **only when the view reports `final === true`**. This requires giving `HttpResponse` a `headers` field, which the export controller already needs.
- **Test:** `billing-routes.test.ts` — a trace detail and an *open*-month statement answer `no-store`; a *closed*-month statement answers a `max-age` and a stable `etag` that changes after a reopen→re-close bumps `snapshot_version`.

### D-8 · MEDIUM — `contentTruncated` is written by ingestion and surfaced by no reader

- **Files:** `packages/core/src/domain/models/trace-model.ts:138-148` · `packages/connector/src/application/useCases/syncTraces/content-size-guard.ts:15-25`, `:99` · `packages/module/src/presentation/controllers/traces/trace-view-model.ts:132-203` · `packages/module/src/presentation/controllers/traces/trace-view-schemas.ts` · `packages/ui/app.js:436-444`
- **Verified:** a grep for `contentTruncated`/`content_truncated` across the module's presentation layer and the UI returns **nothing** — the flag is written and read by no one. The guard's own doc claims the opposite: *"when clipped, this marker replaces the payload, **never silently**: `contentTruncated` on the trace plus the ingest_failures event point straight at it."* `toTraceDetail` builds `content.input_text: contentToText(trace.input)`, and `contentToText` is `JSON.stringify(value, null, 2)` for non-strings.
- **Failure:** a 20 MB conversation is clipped at ingestion. `GET /traces/:id` returns `content.input_text = "{\n  \"truncated\": true,\n  \"originalBytes\": 19923812\n}"` and the UI prints that JSON verbatim inside the "Entrada"/"Saída" panel — no badge, no label, no field in the response schema saying the archive clipped it. An operator sees what looks like a bizarre agent payload; the only trail is the `ingest_failures` collection, reachable exclusively through Mongo. Invariant 6's **one sanctioned dent** (decision 101) is auditable at the store and invisible at the API.
- **Fix:** add `content_truncated: z.boolean()` to `traceDetailSchema` (and a flag on the list item), project it in `toTraceDetail`, and have `app.js` render a warning strip above the content blocks when true — suppressing `input_text`/`output_text` for the marker object so the panel shows the notice instead of the JSON.

### D-9 · MEDIUM — quarantined traces are counted but not identifiable; no API answers "which ones?"

- **Files:** `packages/core/src/domain/models/trace-model.ts:118-137` · `packages/core/src/infrastructure/database/mongodb/billing/mongodb-billing-query-repository.ts:528-536` · `packages/module/src/presentation/controllers/billing/billing-view-model.ts:434`, `:498` · `packages/module/src/presentation/controllers/traces/trace-filter-query.ts` · `packages/ui/app.js:1052-1056`
- **Verified:** an exhaustive grep for `billingQuarantine` across all four packages returns exactly three kinds of site: the model definition, the ingestion/reconcile **writers**, and the **billing aggregate** readers. No trace-level reader touches it — `toTraceListItem`/`toTraceDetail` have no quarantine field and `trace-filter-query.ts` exposes no quarantine parameter. The entire client surface is one integer, `quarantined_trace_count`. The model's own doc says the flag makes the trace *"visible to the admin"*.
- **Failure:** July is closed; three late traces arrive and are flagged. `/billing/summary` tells the admin "3 traces em quarentena — fora da fatura congelada". The documented correction flow (decision 89: reopen → re-close) requires deciding **whether these three are worth reopening a frozen month for** — which requires knowing their agent, model, cost and arrival time. There is no request that returns them: `/traces` cannot filter on quarantine, `/traces/:id` does not report it even when you already know the id, and `/billing/*` returns only the count. The only way to see them is a hand-written Mongo query the runbook does not document.
- **Fix:** project the flag onto the trace views (`billing_quarantine: {reason, quarantined_at, absorbed_in_snapshot_version} | null` on the detail, a boolean on the list item) and add a `quarantined=true|false` filter to `trace-filter-query.ts`, backed by the partial index migration 021 already builds — so the count in the bill links to the rows behind it.

---

## 6. P2 — Test integrity and falsifiability

The suite is strong where it exists — but the split moved code out from under it, and three specific tests cannot fail.

### E-1 · HIGH — the split removed the only command that runs the test suite

- **Files:** `package.json:6-10` · `Makefile:72`
- **Verified:** root scripts are `build`, `bump`, `register-module` — no `test`, and `build` is the only `--workspaces` fan-out. `npm test` at the root answers **`npm error Missing script: "test"`**. The Makefile `.PHONY` list has no test target. Each package still has its own `test`/`test:ci`, so the three suites can only be run one `-w` at a time. Pre-split there was one package and therefore one `npm test`.
- **Failure:** a developer or agent following the repo's own conventions runs `npm test` at the root, gets a non-zero exit with **zero tests executed**, and — because the failure is an npm *usage* error rather than a red suite — reads it as tooling noise. A change in `packages/core` that breaks 37 module suites lands with nobody having run them. With no `.github` either, nothing compensates. This compounds **C-1**: nothing runs `tsc --noEmit` either.
- **Fix:** add to root `package.json`:
  ```json
  "test": "npm run test --workspaces --if-present",
  "test:ci": "npm run test:ci --workspaces --if-present",
  "typecheck": "npm run typecheck --workspaces --if-present"
  ```
  plus a `typecheck` script per package (`tsc --noEmit -p tsconfig.json`). Note `--workspaces` runs **alphabetically**, and all three integration suites boot their own `mongodb-memory-server`, so keep `--runInBand` per package as today. Add a `make test` target so the runbook vocabulary covers it.
- **Test:** a `deploy-smoke-test.sh` assertion that the root `test`, `test:ci` and `typecheck` scripts exist and are wired to `--workspaces`. Fails today.

### E-2 · MEDIUM — the billing-query fakes are arity-truncated against their port, so window regressions are unfalsifiable

- **Files:** `packages/core/src/application/testSupport/billing-test-fakes.ts:389-392`, `:451-460` · `packages/core/src/application/interfaces/billing-query-repository.ts:145`, `:153`, `:156` · `packages/core/src/infrastructure/database/mongodb/billing/mongodb-billing-query-repository.ts:514-535` · `packages/module/src/application/useCases/billingSeries/get-billing-projection-db-use-case.ts:43-51`
- **Verified:** the port declares `ingestionWatermark(monthStart, monthEnd)`, `countQuarantined(monthStart, monthEnd)` and `accruedCostMicrocents(monthStart, upTo)`. The fakes declare `ingestionWatermark(monthStart)`, `countQuarantined(monthStart)` and — worst — **`accruedCostMicrocents(): Promise<number> { return this.accrued; }`, with zero parameters**, against a real adapter the projection calls as `accruedCostMicrocents(start, startOfToday)`. TypeScript permits the narrowing, so the `implements` clause does not catch it. This is exactly the class the predecessor audit closed for `fetchUsageRecords` (whose fake now carries an explicit ordering comment) — the **window arguments were not swept with it**. Note this is also what **C-1** makes invisible: with the fakes typed as `any`, even the narrowing is unreported.
- **Failure:** drop `startOfToday` from the projection's numerator so it reads `accruedCostMicrocents(start, end)` — today's partial day now inflates the run-rate on every current-month `/billing/projection` response — and **every unit spec still passes**, because the fake returns `this.accrued` regardless of the window. Same shape for the watermark: regress the adapter's `$lt: monthEnd` and a closed month's snapshot records a freshness watermark from a *later* month — a lie in the immutable audit trail (invariant 8) — with `close-billing-period-db-use-case.spec.ts` green.
- **Fix:** give the fakes the port's full arity and make them honour it — seed `accruedCostMicrocents` from the same `usageByMonth` bucket filtered by `startedAt >= from && startedAt < toExclusive` (the bucket already carries `startedAt`), and filter `ingestionWatermark`/`countQuarantined` by the passed window rather than by `monthKey(monthStart)` alone. Then add a `billing-query-repository.contract.ts` that **both** the fake and `MongoDbBillingQueryRepository` must satisfy — the codebase already models contract suites for the trace repository.
- **Test:** in the contract suite, seed traces at `2026-06-15` and `2026-06-28`; assert `accruedCostMicrocents(JUNE_START, 2026-06-20)` counts only the first and `ingestionWatermark(JUNE_START, 2026-06-20)` returns the first's `ingestedAt`. Fails against today's fake.

### E-3 · MEDIUM — the connector's write path has no real-store test inside the connector package

- **Files:** `packages/connector/src/infrastructure/database/mongodb/syncState/mongodb-sync-state-repository.test.ts` · `packages/module/src/infrastructure/database/mongodb/sync-traces-pipeline.test.ts` · `packages/module/src/architecture-boundaries.spec.ts:87-104` · `packages/module/package.json` (devDependencies)
- **Verified:** `find packages/connector/src -name '*.test.ts'` returns **exactly one** file — the sync-state cursor repository. The other 14 connector suites are `*.spec.ts` against in-memory stubs. The only end-to-end proof that ingestion writes a correctly stamped trace to Mongo (`sync-traces-pipeline.test.ts`) and the only proof the ingested store satisfies invariant 3 over HTTP (`billing-routes.test.ts`, via `routeDbHarness.ingestJuneFixtures()`) both live in **`packages/module`**, reachable only through `"@observability/connector": "*"` in module's **devDependencies** — the very dependency the module's own architecture spec exists to fence off and that `module.Dockerfile` strips with `--omit=dev`. Symmetrically, core's two invariant-critical billing adapters are tested only from module: `mongodb-billing-snapshot-repository.ts` (525 lines) and `mongodb-billing-period-repository.ts` report **0 % in core's own coverage run**, and `mongodb-billing-query-repository.ts` 16.58 %.
- **Failure:** `npm test -w @observability/connector` is green while `insertIfAbsent`'s transactional trace+counter write, the stamp at ingestion, and the quarantine-at-write check have not touched a database — and the connector **image is built from exactly that package**. Concretely: break the write path so it stores `totalCostMicrocents` without `stampedCosts` and the connector suite still passes. Equally, edit core's T6 snapshot repository, run `npm test -w @observability/core`, and **zero tests exercise it**. Given **E-1**, nothing runs the suites together.
- **Fix:** move `sync-traces-pipeline.test.ts` into `packages/connector/src/application/useCases/syncTraces/` (it imports only `@observability/core` plus connector-local code — nothing in it needs the module), and move the billing lifecycle repository test into `packages/core`. Leave `billing-routes.test.ts` where it is — the HTTP invariant-3 check genuinely belongs to the read API — and keep the harness's connector devDependency for seeding only. Then per-package coverage becomes meaningful, and **E-5**'s thresholds can be set.
- **Test:** the moved suites themselves: they must run and pass under their new package's `npm test`, which they cannot do today.

### E-4 · MEDIUM — migration 018's unique indexes and both ingestion-failure repositories are exercised by nothing

- **Files:** `packages/core/src/infrastructure/database/mongodb/migrations/018-ingest-failure-indexes.ts` · `packages/connector/src/infrastructure/database/mongodb/ingestFailures/mongodb-poison-row-repository.ts:29-49` · `.../mongodb-ingest-failure-repository.ts` · `packages/module/src/main/server/routes/v1/helpers/route-db-harness.ts:48-68`
- **Verified:** migrations 015, 019, 020 and 021 each have a `*.test.ts`; **018 does not**, and core's coverage reports it at 0 %. Neither ingestion-failure repository is imported by any spec or test in any package. Migration 018's own comment states the contract the tests are missing: *"Unique indexes make the upserts race-safe (two concurrent syncs cannot mint duplicate dead letters for one trace)"* — and `retryOnceOnDuplicateKey`'s retry branch is reachable **only** when the E11000 that index produces actually fires. `route-db-harness.resetAndMigrate` runs all migrations but never writes to, nor clears, `ingest_failures` or `poison_rows`.
- **Failure:** drop `{ unique: true }` from either `createIndex` in migration 018 and the whole suite stays green. In production, two readers hitting the same poison row concurrently both take the upsert's insert branch: `poison_rows` accumulates duplicate documents for one `(kind, id)`, `seenCount` splits across them and permanently under-reports re-encounters, and the dead-letter recovery trail — the durable record invariant 6 leans on when a source row is skipped past the cursor and LangWatch's retention expires — silently stops being one-document-per-failure.
- **Fix:** add `018-ingest-failure-indexes.test.ts` in the shape of the existing `021-quarantine-index.test.ts` (both indexes exist with `unique: true` and the exact key order; a second run is a no-op). Add `mongodb-poison-row-repository.test.ts` running migration 018 in `beforeAll` — the same deliberate pattern `mongodb-trace-repository.test.ts:19-24` uses for the unique `traceId` index — recording the same `(kind, id)` twice and asserting one document with `seenCount: 2`, `firstSeenAt` pinned, `lastSeenAt` advanced, and an oversized `rawRow` dropped while `error` survives. Add `INGEST_FAILURES_COLLECTION` and `POISON_ROWS_COLLECTION` to the harness's reset list, for the same reason the billing collections were added there.

### E-5 · LOW — coverage is measured, never enforced; four `*.test.ts` files need no Mongo

- **Verified:** no `coverageThreshold` is configured in any of the twelve jest configs (all leave it commented out), and there is no `.github`, so `test:ci` is never invoked automatically. Separately, `middlewares/{cors,body-parser,default-content-type,auth}.test.ts` import only `express` and `supertest` — no Mongo — so under CLAUDE.md's load-bearing rule (`*.spec.ts` = unit, no Mongo; `*.test.ts` = integration, real Mongo) they are misnamed: they pay `mongodb-memory-server` startup for nothing and are invisible to `npm run test:unit`.
- **Fix:** after **E-3** makes per-package numbers meaningful, set a `coverageThreshold` per package at slightly below its current value so it ratchets rather than blocks. Rename the four middleware suites to `*.spec.ts`. If "integration" is meant to include HTTP-without-Mongo, then say so in CLAUDE.md instead — the rule is load-bearing precisely because it is mechanical, so it must be stated exactly once and be true.

---

## 7. P2 — Persistence and scale

All four were verified against **real MongoDB servers** with `explain('executionStats')`.

### F-1 · MEDIUM — the rebuild jobs use `$out`, which silently discards every maintenance write landing during the rebuild

- **Files:** `packages/core/src/infrastructure/database/mongodb/session/mongodb-session-summary-repository.ts:88-99` · `packages/core/src/infrastructure/database/mongodb/filterCounter/mongodb-filter-counter-repository.ts:66-82` · `packages/module/src/main/jobs/rebuild-{session-summaries,filter-counters}.ts` · `Makefile:128`, `:185-192` · `README.md:154-155`
- **Verified:** both rebuilds are `aggregate([…, { $out: TARGET }], { allowDiskUse: true })`. Tested on a real single-node replica set: **indexes survive** — the seven migration-013 indexes were byte-identical before and after, so the comment at `:69` is true — but the collection *content* is replaced wholesale. `$out` writes a temp collection and does `renameCollection … dropTarget: true`, so everything written to the target between the aggregation's first read and the rename is dropped with the old collection. Meanwhile the writers keep running: `insertIfAbsent` increments the cube inside its transaction and calls `recomputeSessionOf` immediately after, and `make rebuild-*` runs against the **live stack** while `trace-ingestion-worker` is a normal always-on service. Neither job, nor `Makefile:128`, nor `README.md:154-155` — all of which present the rebuild as *required* after a restore — says to stop the connector.
- **Failure:** restore a backup, bring the stack up, run `make rebuild-session-summaries` as documented. It takes minutes at 1M traces. During it the worker ingests trace `X` of a brand-new session `S`; the trace lands in `traces`, and the recompute writes summary `S` into the collection the rename is about to drop. `S` never appears in `GET /sessions` again — "healed on next touch" only fires if `S` gets another trace, and a finished conversation never does — while `GET /traces` and `GET /sessions/S` (live-derived) both show it. Same window on the facet cube, where decision 77's own note says a lost delta is wrong **forever**.
- **Fix:** make the jobs refuse to run blind. Before the aggregation, read the sync watermark (`sync_state`, `_id: 'trace-sync'`, field `advancedAt`) and `traces.estimatedDocumentCount()`; after the swap, read both again; if either moved, print *"ingestion advanced during the rebuild — the swap discarded concurrent maintenance writes; stop `trace-ingestion-worker` and re-run"* and set `process.exitCode = 1` (keeping the existing `finally { disconnect() }`). Add `docker compose stop trace-ingestion-worker` to the Makefile recipe comments and to `README.md:154-155`. Note `$merge` is **not** a substitute for the cube — it would clobber concurrent `$inc` results just as badly.
- **Test:** an integration test that advances `sync_state.advancedAt` between the job's two reads via the injected clock seam and asserts a non-zero exit instead of a success report.

### F-2 · MEDIUM — the re-sync path reads every stored trace twice, unprojected, inside a transaction, and always rewrites `unclassified`

- **Files:** `packages/core/src/infrastructure/database/mongodb/trace/mongodb-trace-repository.ts:134-217` (reads at `:139-142` and `:184`, unconditional write at `:202-206`) · `packages/connector/src/application/useCases/syncTraces/trace-ingestor.ts:287-294`
- **Invariant:** 6 — backfills over the archive are a first-class, documented operation
- **Verified:** on the `skipped` branch — i.e. **every trace a re-sync re-reads** — `updateAttribution`'s transaction does `traces.findOne({traceId}, {session})` with **no projection**, then a second unprojected `findOne`, then `traces.updateOne({traceId}, {$set: {unclassified: unclassified ?? null}})` **unconditionally**, outside the `if (Object.keys(set).length > 0)` guard. Trace documents embed the full unmasked input/output and every span (~3.4 KB average at 1M, per decision 77's own note); the callback consumes only `attributionCorrectedAt`, the seven cube dimensions, `model` and `sessionId`.
- **Failure:** `make sync CLIENT=x FROM=2026-07-01 TO=2026-08-01` over an already-ingested month — the documented dead-letter and backfill recovery path — at 1M traces means 1M transactions each pulling ~6.8 KB of transcript and spans through the WiredTiger cache to read ~200 bytes of attribution: **~6.8 GB of pure eviction pressure** against a default `MONGO_MEMORY_LIMIT` of 512m, flushing the working set that `/traces` and `/billing` depend on, plus 1M unnecessary document updates and their oplog entries when nothing changed.
- **Fix:** project both reads to exactly the fields the callback needs (`_id, traceId, startedAt, domain, subdomain, type, agent, channel, status, model, sessionId, attributionCorrectedAt, unclassified`), and guard the final write so it is issued only when the derived `unclassified` differs from the stored one. Both changes are inside the existing transaction, so the semantics are unchanged.
- **Test:** a repository integration test with `monitorCommands: true`: call `updateAttribution` with an attribution identical to the stored one and assert (a) both `find` commands carry the projection, and (b) **zero** `update` commands are issued. (b) fails immediately on revert.

### F-3 · LOW — `ingestionWatermark` fetches every document of the open month; one index makes it covered

- **Files:** `packages/core/src/infrastructure/database/mongodb/billing/mongodb-billing-query-repository.ts:514-526` · `packages/module/src/application/useCases/billingSummary/get-billing-summary-db-use-case.ts:162` · `packages/module/src/application/useCases/billingLifecycle/close-billing-period-db-use-case.ts:146-147`
- **Verified:** the pipeline is `$match {startedAt: {$gte, $lt}}` + `$group {watermark: {$max: '$ingestedAt'}}`, and `ingestedAt` is in no index, so the planner must fetch every document to read it. Measured on a real server with the exact migration index set (3000 docs, one month): `docsExamined=3000 keysExamined=3000`, stages `PROJECTION_SIMPLE, FETCH, IXSCAN`. Adding `{startedAt: 1, ingestedAt: 1}`: `docsExamined=0`, `PROJECTION_COVERED, IXSCAN`.
- **Failure:** `GET /api/v1/billing/summary` for the current month at 1M traces/month fetches ~3.4 GB of trace documents solely to compute one `max(ingestedAt)` — on every request — evicting every other endpoint's working set; the same pass repeats inside `make billing-close`. This is a *second* full-month document pass on the summary path, **distinct** from the `fetchUsageRecords` materialisation listed as an accepted remainder — and unlike that one it disappears entirely with an index, with no read-path restructuring.
- **Fix:** add migration `022-ingestion-watermark-index` creating `traces.createIndex({ startedAt: 1, ingestedAt: 1 })`. Nothing else changes.
- **Test:** integration test running the migration chain then `explain('executionStats')` on the watermark shape, asserting `totalDocsExamined === 0`.

### F-4 · LOW — worker knobs accept `0`, and `0` is a silent archive-loss setting

- **Files:** `packages/connector/src/infrastructure/configuration/helpers/environment-setup.ts` (`optionalIntString`)
- **Verified:** `optionalIntString` is `z.string().regex(/^\d+$/)` with no positivity refinement and no upper bound, applied to `TRACE_INGESTION_INTERVAL_SECONDS`, `TRACE_INGESTION_BATCH_SIZE`, `TRACE_INGESTION_QUIET_PERIOD_SECONDS` and `REPROCESS_INTERVAL_SECONDS`. All four are in the Makefile's SCRUB list and in `packages/connector/.env.example`, so an operator is explicitly invited to set them.
- **Failure:** `TRACE_INGESTION_BATCH_SIZE=0` boots cleanly and drives the source query with `LIMIT 0`: every cycle fetches nothing, the cursor never advances, and the worker logs a healthy "0 fetched" forever while LangWatch's ~49-day retention eats the backlog behind it — invariant 6 failing silently, which is the worst failure shape in this system. `TRACE_INGESTION_INTERVAL_SECONDS=0` busy-loops the worker.
- **Fix:** refine each knob to a positive integer with an explicit per-knob upper bound, and log the resolved knob values once at worker startup so a misconfiguration is visible in the first lines of the log.

### F-5 · LOW — nothing the store cannot run without is actually required by the env schema

- **Files:** both `environment-setup.ts` files · `packages/core/src/infrastructure/configuration/interfaces/mongodb-environment-variables.ts` · `packages/core/src/infrastructure/database/mongodb/helpers/mongodb-connection-setup.ts:33`
- **Verified:** every `MONGO_DB_*` field is `.optional()` in both schemas, and `MongoDbEnvironmentVariables` types all six as optional. With `MONGO_DB_HOST`/`NAME` unset, `buildMongoDbUri` composes the literal string `mongodb://undefined:undefined/undefined` and the process dies at connect time with a DNS error rather than a configuration error naming the missing variable. Separately, the **Atlas branch is unguarded on empty credentials** while the local branch two lines below guards the same rule:
  ```ts
  // :33  Atlas — no guard
  `mongodb+srv://${encodeURIComponent(mongoDbUser ?? '')}:${encodeURIComponent(mongoDbPassword ?? '')}@…`
  // :41-44  local — guarded
  const credentials = mongoDbUser && mongoDbPassword ? `…@` : '';
  ```
  With `MONGO_DB_ATLAS=true` (a supported string-boolean since decision 106) and empty credentials this yields `mongodb+srv://:@host/db` → **`MongoParseError: URI contained empty userinfo section` at boot**, which I reproduced. Coverage confirms line 33 is the single uncovered branch of that file. `packages/module/.env.production` is exactly this configuration (`MONGO_DB_ATLAS="true"` with empty host/name/user/password), so `ENVIRONMENT=production node dist/main/index.js` outside Docker crash-loops today; Docker is unaffected because `.dockerignore` excludes `**/.env.*`.
- **Fix:** apply the local branch's guard to the Atlas branch (one line — it is the same rule, spelled twice), require `MONGO_DB_HOST` and `MONGO_DB_NAME` in the schema so a missing one is named, and either fix or delete `packages/module/.env.production`. Fold this into **C-6**'s shared parser so both containers get it once.

---

## 8. P1 — Deployment and operations

**A-1** is the fourth finding in this group and the worst; it is filed in §2 because its consequence is archive corruption.

### G-1 · HIGH — the ingestion worker's healthcheck cannot distinguish "ingesting" from "idling forever"

- **Files:** `compose.connector.yml:128`, `:116-133` · `packages/connector/src/main/jobs/run-trace-ingestion-loop.ts:62-75`
- **Verified:** the healthcheck is `test: ["CMD-SHELL", "pgrep node > /dev/null || exit 1"]`. The loop's no-source branch is *designed* to stay alive: `console.log('… source not configured … — idling'); while (!stopping) { await sleep(3600_000); }`, commented "an exit would just crash-loop the service". Combined with **A-1**'s finding that `LANGWATCH_CLICKHOUSE_URL` is gated on `LANGWATCH_API_KEY`, the idle branch is reachable through ordinary onboarding order.
- **Failure:** an operator onboards LangWatch, obtains the API key, but does not write it back into `clients/<name>.env` (or writes it and never re-runs `up`). `LANGWATCH_CLICKHOUSE_URL` interpolates empty → the batch use case is `undefined` → the worker idles. `docker compose ps` shows **healthy** for all three services. Nothing ingests. LangWatch's ~49-day retention rolls forward and those traces are gone permanently. The same green-while-dead state covers every wedge that leaves the node process alive — including **A-3**'s epoch-0 spin, a hung ClickHouse socket, or a promise that never settles.
- **Fix:** make the healthcheck assert **progress**, not process existence. Have the loop touch a heartbeat file at the end of every completed cycle (and write nothing in the idle branch), then check its age against `2 × interval + 120s`. Independently, treat "no source configured" as **unhealthy** rather than idle-healthy — either exit non-zero at startup (a crash loop is the visible signal decision 117 already prefers) or write no heartbeat.

### G-2 · HIGH — the documented production deploy starts the ingestion worker before any index exists

- **Files:** `README.md:88-89` · `compose.connector.yml:108-136` · `packages/core/src/infrastructure/database/mongodb/trace/mongodb-trace-repository.ts:75-95` · `Makefile:140-141`
- **Verified:** README's production procedure is, in order, `docker compose … up -d` **then** `… run --rm --no-deps api node dist/main/jobs/run-migrations.js`. `up -d` starts `trace-ingestion-worker`, whose only gate is `depends_on: clickhouse: service_healthy` — nothing makes it wait for migrations. Meanwhile `insertIfAbsent` no longer pre-checks: *"audit C-7.3: insert directly — no pre-insert findOne. The unique traceId index IS the existence check"*, with dedup implemented purely as `isDuplicateKeyError(error) → 'skipped'`. Migration ownership also crossed the split: `run-migrations` builds into the **module** image while the writer racing it is the **connector** image. Decision 117 fixed "the deploy never migrates"; it did not fix the *order*.
- **Failure:** CI materialises the env file from the protected store — `LANGWATCH_API_KEY` already populated — and runs the two documented commands. The worker begins draining ClickHouse the moment Mongo answers, seconds before migrations land. **In that window `insertOne` can never raise E11000**, so any re-read (a crash mid-batch, a watermark replay, an overlapping `make sync`) stores the same trace twice — each copy with its own immutable price stamp and its own facet-cube increment. Billing is `Σ stamped costs`, so the client is **over-billed with no evidence in the archive**. The window reopens on every image upgrade, which README:104-105 also says requires `make migrate`.
- **Fix:** make migration precede any writer, in the documented order and in `make`:
  ```
  docker compose … up -d mongo
  docker compose … run --rm --no-deps api node dist/main/jobs/run-migrations.js
  docker compose … up -d
  ```
  Add a `make migrate-up` target that does exactly this. **Belt-and-braces:** have `run-trace-ingestion-loop.ts` assert at startup that the unique `traceId` index exists and exit non-zero if not — one `indexExists` call, and it is a fail-closed guard against every ordering an operator can invent.

### G-3 · HIGH — the image-reference contract was renamed with no guard; existing client env files fall back to `:local` silently

- **Files:** `clients/matheus.env:19` · `compose.module.yml:35` · `compose.connector.yml:109` · `Makefile:85-89` · `scripts/2-provision-client-stack.sh:23-25`
- **Verified:** the split replaced `API_IMAGE` with `MODULE_IMAGE` + `CONNECTOR_IMAGE`. The only real client env file in the tree still reads `API_IMAGE=platform-api:local` — a name no compose file interpolates any more (`grep -rn API_IMAGE compose.*.yml Makefile` returns nothing). `require-client` validates only `CLIENT_NAME` and `COMPOSE_PROJECT_NAME`. Client env files are gitignored, so they are exactly the artifacts that do **not** get updated by pulling the repo.
- **Failure:** a production client pinned to `API_IMAGE=registry.example.com/platform-api:1.4.2` is upgraded by pulling the repo and running `make up-prod`. `MODULE_IMAGE`/`CONNECTOR_IMAGE` are unset, so compose uses `platform-module:local` / `platform-connector:local`: either those tags exist on no host and the stack fails to come up, or **a stale local build from a developer's machine now serves the client's archive** — with the operator's pinned tag sitting in the file, apparently honoured. `2-provision-client-stack.sh:23-25` compounds it: `get MODULE_IMAGE` returns empty, `docker image inspect ""` fails, and the script silently rebuilds local images instead of reporting a broken contract.
- **Fix:** extend `require-client` to reject retired keys and require the new ones:
  ```make
  @! grep -q '^API_IMAGE=' "$(ENVFILE)" || { echo "$(ENVFILE) uses the retired API_IMAGE — the component now ships two images: set MODULE_IMAGE and CONNECTOR_IMAGE (see clients/example.env)"; exit 1; }
  @grep -q '^MODULE_IMAGE=' "$(ENVFILE)" && grep -q '^CONNECTOR_IMAGE=' "$(ENVFILE)" || { echo "…"; exit 1; }
  ```
  Add the same rejection to `deploy-lib.sh`'s `require_envfile`, and document the rename in README's upgrade section. Fix `clients/matheus.env` in the same pass.

### G-4 · MEDIUM — Mongo, the permanent archive, gets docker's default 10-second stop timeout

- **Files:** `compose.mongodb.yml:24-80` · `compose.module.yml:34-73` · `Makefile:110-111`, `:124-128`
- **Verified:** `grep -n stop_grace_period compose.*.yml` returns a **single** hit — `compose.connector.yml:115`, on `trace-ingestion-worker`. The mongo service sets `restart`, `healthcheck` and a memory limit (with a comment recommending 4g at 1M traces) but no stop grace, so `make down` sends SIGTERM then SIGKILL after 10s.
- **Failure:** `make down` (or a host reboot) on a client sized at `MONGO_MEMORY_LIMIT=4g` under active ingestion. mongod's shutdown must quiesce in-flight operations and take a final WiredTiger checkpoint; on a large dirty cache that regularly exceeds 10s, so the archive is SIGKILLed mid-checkpoint and the next start goes through journal recovery — and on a replica set, a rollback of unacknowledged writes. This is the **one container in the deployment whose data cannot be re-fetched**, and the worker — whose data *is* re-readable from ClickHouse — is the only service that got a grace period.
- **Fix:** `stop_grace_period: 120s` on `mongo`, and `stop_grace_period: 30s` on `api` (its graceful HTTP drain has the same 10s ceiling today). While there, the restore recipe at `Makefile:124-128` should carry `--drop` or state explicitly that it only restores into an empty database.

### G-5 · MEDIUM — `module.Dockerfile` credits `--omit=dev` with a guarantee it does not provide

- **Files:** `docker/module.Dockerfile:18-21`, `:45-52`
- **Verified:** the header claims *"`@observability/connector` is a devDependency (test seeding only); `--omit=dev` keeps it out of the runtime stage."* Reproducing the runtime install in a scratch tree (root manifest + lockfile + the four workspace manifests) and running `npm ci --workspace=@observability/module --omit=dev` produces:
  ```
  node_modules/@observability/connector -> ../../packages/connector
  ```
  npm links declared workspace dependencies **regardless of `--omit=dev`** (ordinary devDeps *were* correctly pruned — no `typescript`). The image is nevertheless vendor-code-free, but for a different reason: the runtime stage copies `packages/connector/package.json` and nothing else, so the symlink resolves to a code-less directory.
- **Failure:** the stated mechanism is not the one doing the work. Anyone who "simplifies" the four per-package `COPY` lines into `COPY packages/*/package.json` plus a broader dist copy, or who promotes the connector to a regular dependency for a tooling reason, ships LangWatch adapters and fixtures into the vendor-blind image while the comment assures them `--omit=dev` prevents exactly that. **C-4**'s test does not cover image contents.
- **Fix:** correct the comment to name the real invariant, then make it enforceable with a build-stage assertion in the module image — `RUN ! test -e packages/connector/dist && ! grep -rqi 'langwatch\|clickhouse' packages/module/dist` — so a regression fails the build rather than the prose.

---

## 9. P3 — Structure, duplication and naming

### H-1 · MEDIUM — the vendor-free module container is handed LangWatch and ClickHouse credentials

> **RESOLVED — 2026-08-04, with A-1 (decision 127).** The `api:` fragment is gone; rendered compose confirms the module's environment carries **zero** `LANGWATCH_*` keys.

- **Files:** `compose.connector.yml:68-84` · `Makefile:151-152` · `packages/module/src/infrastructure/configuration/helpers/environment-setup.ts:36-59`
- **Verified:** `compose.connector.yml:68` still opens `# ---- couplings onto the module (merged into compose.module.yml) ----` and injects six vendor variables into the `api` service, justified at `:77` by *"Manual `make sync` runs in the api service — give it the same direct-ClickHouse source the trace-ingestion-worker uses (decision 59)"*. `git diff fba0a13..HEAD -- Makefile` shows that sentence became false **in the same refactor**: `run --rm --no-deps api node dist/main/jobs/run-sync.js` → `run --rm --no-deps trace-ingestion-worker node …`. The module's zod schema declares no `LANGWATCH_*` key, so zod strips all six: they are read by nothing.
- **Failure:** the container the split exists to keep vendor-free is handed `LANGWATCH_API_KEY` plus the ClickHouse user, password and database. The module publishes an auth-optional HTTP API over the unmasked archive, so its process environment is the widest blast radius in the stack — and it now carries credentials for a service it cannot talk to. Meanwhile the next person changing the sync source will edit the fragment that does nothing (it reads as the live one) and leave the worker's real copy untouched.
- **Confirmed design intent (Matheus, 2026-08-03):** the trace source belongs to the ingestor, full stop — *"the module consumes the already-ingested traces, so the module cannot know anything from LangWatch."* This is not a preference to weigh against convenience; it is the boundary decision 125 exists to draw.
- **The deletion is provably non-breaking — verified, not assumed:**
  - the module's zod schema declares **zero** `LANGWATCH_*` keys (`grep -c LANGWATCH environment-setup.ts` → 0), so all seven injected variables are stripped by zod and read by nothing;
  - **no module job can construct a trace source** — a grep for `sync-factory` / `TraceSourceClient` / `makeSyncTracesUseCase` across `packages/module/src` (excluding tests and the route harness) returns only a *doc comment* in `reprocess-factory.ts`;
  - the nine jobs the `api` service runs are all store-side (`run-migrations`, `seed-poc-prices`, `insert-price-version`, `reprocess-pending`, `close-billing-period`, `reopen-billing-period`, `rebuild-filter-counters`, `rebuild-session-summaries`) and none needs a source;
  - `langwatch` appears in `packages/module/src` exactly once, in the fitness-test regex itself.
- **Fix:** delete the whole `api:` fragment (`compose.connector.yml:68-84`, header comment included) — the module has no coupling onto the connector any more, which *is* the decision-125 result. Move `LANGWATCH_ENDPOINT` and `LANGWATCH_API_KEY` onto the `trace-ingestion-worker` env block (this is the half **A-1** depends on: it is what restores the HTTP link for `make sync`), and rewrite the justification comment to say sync runs there. Note `compose.connector.yml:42` (`LANGWATCH_ENDPOINT: http://langwatch:5560`) is **not** in scope — that belongs to the `langwatch` service configuring its own in-project callbacks, which is legitimate.
- **Make it unable to regress:** the module's remaining vendor leak is its manifest (`@clickhouse/client`, **C-3**), invisible to every current test. **C-4**'s `package.json` assertion plus a compose-level check — "no `LANGWATCH_*` key may appear on any service running `MODULE_IMAGE`" in `deploy-smoke-test.sh` — turn this boundary from prose into a build failure.

### H-2 · MEDIUM — `firstOpenMonthStart` hand-copies `closedMonthKeys`, and the month key has four spellings

- **Files:** `packages/core/src/domain/models/billing-period-model.ts:150-156`, `:91-96` · `packages/core/src/domain/models/month-key.ts:26-31` · `packages/core/src/infrastructure/database/mongodb/billing/mongodb-billing-query-repository.ts:349` · `packages/module/src/application/useCases/billingSummary/list-bills-db-use-case.ts:68`, `:75-76`
- **Verified:** `month-key.ts:26-31` exports `closedMonthKeys(periods)` = `new Set(periods.filter(p => p.status === 'closed').map(p => \`${p.year}-${p.month}\`))`, imported repo-wide by the sync loops and the reprocess sweep. `firstOpenMonthStart` rebuilds byte-identical logic inline at `:154-156` — having *already* computed `closed` at `:150` — and `closedMonthWindows` at `:91-96` spells the same `status === 'closed'` filter a third time. The unpadded `${year}-${month}` string is separately constructed ad hoc in the billing query repository and twice in `list-bills`.
- **Failure:** no wrong outcome today — all four spellings agree, being unpadded. That is exactly the profile the predecessor log describes: *"the two spellings agree on every input anyone thought to test — they diverge only on the input the second author did not consider."* One author padding to `2026-07` in one site silently breaks a `Set.has` lookup that no test covers, in the function whose entire job is the scan bound **B-2** shows is already fragile.
- **Fix:** `firstOpenMonthStart` calls `closedMonthKeys(periods)`; `closedMonthWindows` derives from the same filtered list; export a single `monthKeyOf(year, month)` overload from `month-key.ts` and route the query repository and `list-bills` through it. Deleting the copies is the fix, not aligning them.

### H-3 · LOW — split-brain naming: the package is `module`, the deployment is still `api`

- **Files:** `compose.module.yml:35-37` · `Makefile:64` · `clients/example.env` (`API_PORT`/`API_BIND`) · `scripts/register-module.sh:29` · `packages/module/package.json:4` · `package.json:2`
- **Verified:** the refactor renamed the package, the images (`platform-module`/`platform-connector`) and the env contract (`API_IMAGE` → `MODULE_IMAGE` + `CONNECTOR_IMAGE`), but stopped at the service boundary: `compose.module.yml:35` still declares `api:` with `container_name: …-api`, and `Makefile:64` hard-codes `run --rm --no-deps api node`. Three further residuals from the same sweep: `register-module.sh:29` defaults `MODULE_ID="${MODULE_ID:-tracing}"` while the component is `observability` and `MODULE_ID` is what the platform discovers it by; `packages/module/package.json:4` declares `"main": "main/index.js"` while the build emits `dist/main/index.js` and the package publishes **no `exports` map** (unlike core and connector); and the workspace root is still `"name": "clean-architecture-workspace"`.
- **Failure:** the vocabulary now splits on which artifact you are holding — `make logs` shows `<client>-api`, `docker images` shows `platform-module`, CLAUDE.md's graph says `module`. The `main` field is the live trap: anything that ever does `import … from '@observability/module'` resolves to `packages/module/main/index.js`, which no build produces, and the error names a file nobody wrote.
- **Fix:** two separable moves. **(a)** Rename the compose service `api` → `module` in `compose.module.yml` and `compose.dev.yml`, update `Makefile:64` and the README, and either keep `API_PORT`/`API_BIND` as documented aliases or rename them with a note in the env contract — `--remove-orphans` is already on both `up` and `down`, which is exactly the guard a service rename needs. **(b)** Independently, drop `"main"` from `packages/module/package.json` or give it the `exports` map its siblings have, and set `MODULE_ID` and the root package name deliberately rather than by inheritance. (a) is a deployment-visible change; see §9-Q3.

### H-4 · LOW — the workspace build order is alphabetical and works by accident

- **Files:** root `package.json` (`"build": "npm run build --workspaces"`) · `packages/*/package.json` build scripts
- **Verified:** the observed order is `connector, core, module, ui` — alphabetical, not topological. It succeeds only because connector's `tsc -b` pulls core in as a project reference and builds it first; core's own script then runs `rm -rf dist && tsc -p` and rebuilds it. Swap connector's `-b` for `-p` and the workspace build breaks with no obvious cause.
- **Fix:** make the dependency explicit rather than incidental — either give core's build a `prepare`/`predependency` relationship npm honours, or replace the root fan-out with an explicit ordered sequence (`npm run build -w @observability/core && npm run build --workspace=@observability/module --workspace=@observability/connector`). A one-line comment is not enough here; the failure mode is a confusing type error in an unrelated package.

### H-5 · LOW — moved demo scripts document the path they no longer live at

- **Files:** `packages/connector/scripts/generate-demo-fixtures.mjs:4-5` · `packages/connector/scripts/push-demo-to-langwatch.mjs:7-8`
- **Verified:** both files sit under `packages/connector/scripts/`, and both carry usage headers naming `packages/module/scripts/…` — the mechanical `packages/api` → `packages/module` rename hit the doc comments before the files themselves moved to the connector. Every *caller* is correct (`scripts/4-seed-demo-data.sh`, `compose.dev.yml`, `README.md:215`); only the in-file instructions are wrong.
- **Failure:** copy-pasting either documented command fails with `Cannot find module`. `README.md:215` invites running the generator by hand, so the first thing a new demo stack does is hand back a path error.
- **Fix:** replace `packages/module/scripts/` with `packages/connector/scripts/` in the four header lines.

---

## 10. P4 — Documentation and decision-log integrity

### I-1 · MEDIUM — decision 124 is now false in three of its five "NÃO mudaram" clauses, with no superseded annotation

- **Files:** `docs/produto/backlog-v2.3.md` decisions 124 and 125 · `docker/` · `Makefile:92-94`
- **Verified:** decision 124 states that these did **not** change: the image `platform-api:local`, the container `<cliente>-api`, the file `docker/api.Dockerfile`, and the env `API_IMAGE`. Today `docker/` contains `connector.Dockerfile`, `module.Dockerfile`, `ui.Dockerfile` and `ui.nginx.conf.template` — no `api.Dockerfile`; `Makefile:92-94` builds `platform-module`/`platform-connector`/`platform-ui` — no `platform-api`; and `API_IMAGE` matches nothing outside decision 124 itself. Decision 125 records the rename but never annotates 124, and 124 gives no forward pointer — while the repo's own house style for exactly this (the "superseded by 96" annotations, the QA1-style strikes) already exists.
- **Failure:** a reader — or a future agent — taking the decision log as the source of truth reads 124 as current, looks for `docker/api.Dockerfile`, and sets `API_IMAGE=` in a client env; the variable is scrubbed and ignored and the stack silently runs the compose defaults. The log's integrity guarantee ("the known set is closed") depends on superseded rows being marked.
- **Fix:** append to decision 124's first column, before the closing `|`:
  > **Parcialmente superseded pela decisão 125 (03/08/2026)**: a imagem passou a ser `platform-module:local`, `docker/api.Dockerfile` virou `docker/module.Dockerfile` + `docker/connector.Dockerfile` + `docker/ui.Dockerfile` e `API_IMAGE` virou `MODULE_IMAGE`/`CONNECTOR_IMAGE`. Seguem intactos o prefixo HTTP `/api/v1`, o serviço `api` do compose e o container `<cliente>-api`.

### I-2 · LOW — CLAUDE.md cites a decision range that stops sixteen rows short of the log

- **Files:** `CLAUDE.md:102` · `docs/produto/backlog-v2.3.md`
- **Verified:** CLAUDE.md reads *"Billing épicos 5–8 (added post-PoC, decisions 87–109 …)"*. The decision table now ends at **125**: 110–123 are the re-audit decisions (112/114/116–122 are billing-lifecycle rules CLAUDE.md's own paragraph summarises) and 124/125 are the packaging decisions that produced its package-layout paragraph.
- **Failure:** an agent told to "read the decisions this paragraph cites" stops at 109 and misses the scan-bound rule (119), the total-order comparators (122), the runbook date rule (123) and the package split (125) — precisely the decisions governing the code it is about to touch.
- **Fix:** replace with *"decisions 87–122 … the package layout above is decisions 124–125"*.

### I-3 · MEDIUM — README documents `--image` but never `--connector-image`

- **Files:** `README.md:74-77`, `:92` · `scripts/1-init-client-env.sh:18-19`, `:31`, `:43-44`, `:94-95` · `clients/example.env:131-132`
- **Verified:** README:76 reads *"…`--image REF` to pin the api image…"* — a sentence the split invalidated. `scripts/1-init-client-env.sh` now has two flags (`--image` → `MODULE_IMAGE`, `--connector-image` → `CONNECTOR_IMAGE`) with independent defaults `platform-module:local` / `platform-connector:local`; only the first is documented anywhere.
- **Failure:** an operator pinning a released build (`--image ghcr.io/…/platform-module:1.4.0`) gets an env file whose `CONNECTOR_IMAGE=platform-connector:local` — a tag that exists on no fresh host. `make up-prod` brings `api` and `ui` up healthy while `trace-ingestion-worker` fails to pull and crash-loops: the API answers, the UI renders, and **nothing is being ingested**. Invariant 6 fails silently, and the sidecar's process-level healthcheck is the only signal.
- **Fix:** rewrite README:76 to document both flags and their defaults, and add both to the production-deployment section at README:92, which already names `MODULE_IMAGE`/`CONNECTOR_IMAGE` correctly.

### I-4 · MEDIUM — the scope rename renamed another repository's package

- **Files:** `scripts/connector/register.sh:14-18`
- **Verified:** commit `a9ceced` ("Rename mecânico @khal/* → @observability/*") rewrote a line documenting how to start a service belonging to the **khal-platform** repo — two lines below its own citation of that repo:
  ```
  # (see khal-platform docs/platform/connector-register/sops.md):
  #     pnpm --filter @observability/connector-register dev
  ```
  A repo-wide grep for `@observability/` outside `packages/` returns this line and nothing else, so it is the single over-reach of the sweep. **This is also why a repo-wide `@khal` grep now returns zero — the rename was too thorough, and the clean result is itself the symptom.**
- **Failure:** `pnpm --filter` on a name no workspace declares exits with "No projects matched the filters". An operator following the documented vault-seed procedure starts nothing, `scripts/connector/register.sh` then resolves a `dev-secret-*` placeholder instead of the real LangWatch API key, and the connector registers with a credential that does not work — while the doc that caused it looks authoritative.
- **Fix:** restore `@khal/connector-register` on line 18. This repo's `@observability/` scope covers `core`/`module`/`connector`/`ui` only.

### I-5 · LOW — two UI polish items

1. **Prototype-key lookups reach a text sink unescaped** (`packages/ui/app.js:60-67`, `:953`). `statusBadge`'s non-`undefined` branch is the only text-sink interpolation in the file that skips `escapeHtml`; because `STATUS_LABELS` is a plain object literal, a key like `constructor` or `__proto__` is *not* `undefined` and takes that branch, rendering `function Object() { [native code] }`. Same pattern for `TOKEN_TYPE_COLORS` inside a `style` attribute. **Not an XSS today** — both keys are closed server-side zod enums and no reachable prototype value contains `"`, `<` or `>` — but it bypasses the file's own stated binding discipline and is one schema change from mattering. **Fix:** `Object.hasOwn` guards on both lookups.
2. **The tab pattern declares `role="tab"` but never associates the panels** (`packages/ui/index.html:11-16`, `packages/ui/app.js:1318-1332`). No `role="tabpanel"`, no `aria-controls`, no `aria-labelledby`, no roving `tabindex`, no Arrow-key handling — all required once `role="tab"` is asserted. The dialog beside it is fully implemented, so this is an isolated gap rather than house style. **Fix:** add the associations in `index.html` and a roving-`tabindex` + Arrow/Home/End handler on `.tabs`.

---

## 11. Verified clean — do not "fix" these

Everything here was checked **in this audit**, against the current tree, and much of it by experiment rather than by reading. It is listed so the remediation wave does not spend effort re-deriving it, and so a future reader knows what the passes actually covered.

**Billing engine and money.** The fold *is* the one calculation — `buildStatement = foldRecords(records).statement()`, and both the day-paged close and the whole-month live read go through it; `statement()` is re-entrant and deterministic. All comparators are total orders over their own grouping keys (`compareLines` carries all six `lineKey` terms, `sortPriceVersions` all four), so nothing falls through to Map-insertion order. `shareBasisPoints` is BigInt end-to-end with index-ordered remainder ties; `reconcileDisplayCents` floors via the exact remainder; `round2` is applied only to bar widths and donut stops (all seven call sites checked), never to money. `blendedPerMillion`'s `(n + d/2n)/d` **is** correct half-up — `d/2n` truncates only for odd `d`, and an exact `.5` tie is impossible for odd `d`; I nearly filed this and it is not a defect. BSON money typing is exact at realistic scale: integers ≥ 2³¹ serialise as Double, but Double is exact for integers below 2⁵³ = R$ 90,071,992.55 per summed group — worth knowing as a bound, not a bug.

**Billing lifecycle.** Closed months are snapshot-served in all three readers, each throwing loudly on closed-without-snapshot. The quarantine lifecycle was traced through the full reopen → re-close cycle: Σ daily ≡ frozen total in closed, reopened and never-closed states, both reconcile passes idempotent, the straggler set chunked. The close/publish protocol stages rows outside the transaction under an attempt-private key, publishes header+flip in a two-document transaction, discards staging on every non-publishing exit, and derives the version collision-proof. Calendar edges (month 12 → next year, `previousMonthOf(y,1)`, leap February, the ordinal round-trip) are correct. Degenerate months — zero traces, only `pending_price`, a single trace — produce coherent all-zero statements, not NaN, and `pending_price` is excluded from every cost aggregation while being surfaced separately.

**Persistence, by experiment on real servers.** Migration 021's partial index genuinely serves `countQuarantined` (`docsExamined=4` of 3000). `$out` really does preserve the target's indexes — all seven cube indexes byte-identical before and after — so that comment is true (the *content* loss is **F-1**). The E11000 race inside `insertIfAbsent`'s transaction is **not** misread as "already stored": building the exact interleaving, `withTransaction` retried the callback, the trace stored and the counter reached 2. No production `find().sort()` runs without a serving index — `findTraces` including the `$or` search shape, `findPendingPrice`, `findSessions`, the session-detail chain, `findUsageRecords`, `listVersions`, `earliestTraceAt`, `listAll` — all IXSCAN-satisfied with no blocking SORT, so the 100 MB ceiling is not reachable. Null-versus-missing is consistent between writers and readers for `billingQuarantine`, the cube tuples, and `stampPendingTrace`'s `{model: null}` pin. Every job uses `process.exitCode` + `finally { disconnect() }`, so none exits before writes flush.

**Sync and ingestion.** The `(OccurredAt, TraceId)` / `(UpdatedAt, TraceId)` tuple cursors are genuine total orders on both paths — predicate, `ORDER BY` and cursor all carry the tie-breaker — so a page boundary landing mid-tie cannot skip a row. The watermark CAS cannot regress. Work-first/bookmark-second ordering, `assertNotAllFailed`, and `isSystemicStoreError`'s rethrow-versus-dead-letter split are consistent across both loops. The content-size guard's ordering is right: three clip passes, `UnstorableTraceError` thrown *before* the insert, truncation recorded only *after* the store call returns, tokens and costs untouched. The quiet period is applied on both axes and both adapters. Under zod 4.3.6, `z.number()` rejects `NaN`/`±Infinity` and `.int()` uses safe-integer semantics, so the ClickHouse `cleanTokens` lacking an explicit safe-integer check is not exploitable. `parseRunbookDate` serves both sync doors, pinned at source level — decision 123 held through the split.

**HTTP and security.** No NoSQL operator injection is reachable: `buildFilter` places only zod-validated `string`/`Date` values into `$in`/`$or`/equality, and `?agent[$gt]=x` answers 400. No `$where`/`$expr`/`$function`/`mapReduce` anywhere; the only `new RegExp` is built from a static table. The auth gate has **no bypass and no fail-open**: the path-less `app.use` precedes every route *and* the 404/405 handlers, an unreachable auth system yields 401 without caching, and the cache is SHA-256-keyed, bounded at 10k with eviction, negative-TTL'd separately, and in-flight-deduplicated. No log line can print unmasked content — `error-handler` returns for every 4xx *before* its `console.error`, so body-parser's `entity.parse.failed`, which carries the raw body, is never logged. 413 is preserved rather than flattened to 400; no response carries a stack, an internal class name, or `X-Powered-By`. CSV/HTML export hardening is complete (OWASP leading-character set applied *before* quoting; quoting on `" ; \n \r`). Strict query validation is genuinely uniform across all nine read endpoints, including `z.strictObject({})` on the parameterless ones.

**UI.** Every text and quoted-attribute interpolation of user or LLM data passes `escapeHtml` (complete for `& < > " '`); attribute, style and URL contexts carrying numbers are `Number()`-coerced; `CSS.escape` guards identity selectors and `encodeURIComponent` both detail URLs. No client-side money arithmetic exists, a `pending_price` trace can never surface as R$ 0,00, and "partial" is labelled in all five places it can appear. Every field `app.js` reads exists in the module's strict response schemas, and every nullable field it dereferences is null-guarded at the binding site.

**The split itself, where it held.** No test file was lost or orphaned: the `*.{spec,test,contract}.ts` inventory went 70 → 74, the only removals being two renames. The emitted `dist` genuinely resolves — 476 specifiers, 0 unresolved. `grep -rl langwatch packages/module/dist` is empty and no spec/test/harness/fakes `.js` reaches any `dist`, so the three `tsconfig.build.json` exclude lists hold. All three `architecture-boundaries.spec.ts` files are live and enforce their layer rules, including that `@observability/core/<layer>/…` counts as that layer so the package boundary cannot launder a forbidden dependency. Every job path resolves in both images; `tsc -b` + project references land where the Dockerfiles expect; ESM plumbing (`"type": "module"` beside each `dist`) is correct. Lockfile `packages/*` entries match all four manifests, and intra-workspace deps are `"*"`, so `bump-version.sh` cannot desynchronise them. The Makefile `SCRUB` list covers **every** variable any compose file interpolates, and every interpolated variable either appears in `clients/example.env` or carries a `:-` default. `bash -n` is clean on all twelve shell scripts. Secret hygiene is sound: per-package `.gitignore` covers `.env*` with `!.env.example`, `git check-ignore` confirms, and `git log -S` shows the live LangWatch key in a developer's `.env.development` was **never committed**. `npm audit --omit=dev` reports zero vulnerabilities.

**Invariants with live enforcement.** Invariant 3's route-level check is a *real* check — `billing-routes.test.ts` recomputes the month from raw stored documents in plain JS, asserts the line **count** matches an independent grouping, and pins each line's tokens and exact cost, so misattribution cannot cancel through the total. Invariant 4 is enforced three independent ways (whitelist view-models, a forbidden-key regex over responses *and* the OpenAPI document, strict response schemas). The idempotency test is not passing by accident: `mongodb-trace-repository.test.ts:19-24` explicitly creates the production unique index in `beforeAll`.

---

## 12. Open questions — decisions I did not make for you

- **Q1 — B-4, the timezone boundary.** Display is UTC−3; billing buckets and month windows are UTC. Do you want the billing calendar to follow **America/São_Paulo** (matching every date on screen and an operator's idea of "julho"), or to stay **UTC** and have the daily lens say so explicitly? This is a product decision with a real migration consequence — changing `monthWindowUtc` changes which month existing traces belong to, so it must happen before more months close, or never. `billing-implementacao.md:247` already flags it as open; it is now also an inconsistency, because the *display* already chose BRT.
- **Q2 — A-4/A-2 residual, the zero-usage trace.** A trace with a model and no measured usage is currently stamped R$ 0,00 immutably. The proposed fix gives `StampOutcome` a third arm so every writer must handle it. But what *should* it be — `pending_price` (blocks the month close until instrumentation is fixed: safe, noisy), or a new terminal `no_measured_usage` status (does not block the close, visible in the bill as a count)? I recommend the latter, because a genuinely tool-only trace legitimately costs nothing and blocking the close on it would be wrong. Either way it is a new decision-log entry.
- **Q3 — H-3(a), renaming the compose service `api` → `module`.** Deployment-visible: container names change, `make logs` output changes, and any external monitoring keyed on `<client>-api` breaks. `--remove-orphans` is already on `up` and `down`, so the mechanics are safe. Worth doing for one vocabulary, or leave `api` as the deployment-layer name and only fix the docs? I lean toward renaming, but it is your call and it is independent of everything else here.
- **Q4 — D-3, `GET /prices`.** I recommend adding it (backlog US4 asks for it and the `pending_price` diagnostic flow needs it). Confirm the response should be R$-only and unauthenticated-when-auth-is-off like every other read, i.e. no new access-control concept.
- **Q5 — C-1(2), where the shared billing fakes live.** Keep them in core and stop excluding them from the build (simple, ships test-support in `core/dist`), or extract a private `@observability/test-support` package (clean, one more workspace)? I recommend the former now and the latter if the shared surface grows.
- **Q6 — D-7, caching a closed month.** Adding `ETag`/`max-age` to a *closed* month's statement is safe by invariant 8 and would help the UI, but it requires giving `HttpResponse` a headers field. Do you want that now, or only the `no-store` half (which is the security-relevant half)?

---

## 13. Suggested batch order and approval workflow

Reply with finding IDs to approve or veto — e.g. *"approve all P0+P1 except H-3(a); Q1=São Paulo, Q2=new status, Q3=no"*. Suggested order, chosen so each batch leaves the tree releasable:

| Batch | Contents | Why first |
|---|---|---|
| **0 — stop the bleeding** | **A-1**, **G-1**, **G-2**, **G-3** | Four ways the deployment silently loses, fabricates or double-counts archive data. Small, independent diffs; all four are config + a guard. |
| **1 — the gate that guards the rest** | **E-1**, **C-1**, **C-2** | A root `test`/`typecheck` script and a green `tsc --noEmit` must exist *before* the larger waves land, or nothing catches what they break. |
| **2 — immutable-stamp correctness** | **A-2**, **A-4**, **A-5**, **A-3** | The stamp is forever; every day these ship later is more unrecoverable rows. A-2 and A-4 share the `StampOutcome` change (Q2), so design them together. |
| **3 — billing readers** | **B-1**, **B-2**, **B-3**, **B-5** | B-1 and B-2 both terminate in `resolvePeriodStatus`/`monthWindowUtc`, so they share one domain change. |
| **4 — API and security** | **D-1**, **D-2**, **D-3**, **D-4**, **D-5**, **D-8**, **D-9** | D-1 is one deletion and should arguably ride in batch 0; the rest are contract work that benefits from D-4's derived route table landing first. |
| **5 — test integrity** | **E-2**, **E-3**, **E-4**, **E-5** | Depends on batch 1. E-3's moves make per-package coverage meaningful, which is what E-5's thresholds need. |
| **6 — persistence and scale** | **F-1**, **F-2**, **F-3**, **F-4**, **F-5** | Independent; F-5 folds into C-6. |
| **7 — structure** | **C-3**, **C-4**, **C-5**, **C-6**, **C-7**, **H-1**, **H-2**, **H-4**, **H-5** | Behaviour-preserving. C-4's manifest test fails on C-3, so land C-3 first. |
| **8 — docs** | **I-1**, **I-2**, **I-3**, **I-4**, **I-5**, **G-4**, **G-5** | Cheap, and I-4 is a one-word fix with a real operational consequence. |

**Every invariant-adjacent change lands with the test named in its finding**, and each test must be verified to **fail on revert** — the predecessor log's clearest lesson is that a test which cannot fail is worse than no test, because it reads as coverage. Where a finding changes a rule rather than a bug (A-4/Q2, B-4/Q1, D-3), append a numbered entry to the decision log in `docs/produto/backlog-v2.3.md` rather than leaving it implicit; the next numbers are **126** onward. *(126 was subsequently taken by the Catalog/M2M decision; the A-1/H-1 resolution landed as **127**.)*

**A note on method, for whoever runs the remediation.** Three of the findings here (**A-1**, **A-5**, **G-2**) exist *because* of the package split, not despite it — a rule, a credential and an ordering each stayed behind when the code that depended on it moved. The predecessor log predicted exactly this and it happened anyway. Whatever wave implements this document should be re-audited as new code, by someone who did not write it.
