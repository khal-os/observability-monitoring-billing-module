# Full-Repo Audit — Remediation Spec

**Date:** 2026-08-01 (weekend run) · **Audited state:** commit `6d20d64`, working tree clean
**Method:** 8 parallel audit passes (billing correctness · sync/ingestion · HTTP/API · architecture/SOLID · MongoDB persistence · test suite · ops/UI/scripts · docs-vs-code drift), followed by a manual verification pass — every Critical/High finding and every sharp single-source claim below was re-verified line-by-line against the code before inclusion. Findings the verification pass could not reproduce were dropped.

**How to read this:** each finding has an ID (`A-1`, `B-3`, …), severity, the exact files, the failure scenario, and a fix spec'd to be implementable without re-analysis. Nothing has been changed in the codebase — this document is the proposal; implementation starts after your approval. The suggested approval workflow is at the end (§9): approve/veto per finding ID.

---

## 0. Executive summary

**The codebase is in unusually good shape.** This audit went looking for trouble in every corner and the dominant result is confirmation: zero cross-layer import violations (enforced by `architecture-boundaries.spec.ts`, not just convention), money is integer-µ¢/BigInt end-to-end with no float in any production billing path, all four CLAUDE.md "does the automated check exist?" questions answer *yes* (consistency check, snapshot reproducibility ×2, stamp immutability, idempotent re-sync — all real, all byte-exact), ingestion idempotency is anchored on a unique index + transactional counter writes, no NoSQL-injection path exists, all unmasked LLM content rendered by the UI is HTML-escaped, and the QA19/QA14 comment discipline demanded by CLAUDE.md is genuinely followed. §8 lists what was verified clean so nobody "fixes" it.

**That said, the audit found real defects.** The pattern: almost everything serious lives on the **newest perimeter** — the T6/T7/T8 billing lifecycle (closed-month edges, quarantine, snapshot writes) and the deployment/ops surface — exactly the code that shipped in the last few days and has the least test pressure.

The headline items:

| # | What | Why it matters |
|---|------|----------------|
| A-1 | **Enabling auth per the docs does nothing** — `AUTH_SYSTEM_*` never reaches the container | The only security gate silently fails open; full unmasked archive exposed |
| A-2 | API + LangWatch bound on `0.0.0.0` by default, auth off | Same exposure, network-level |
| A-3 | `rmSync` path traversal in the fixtures generator | `--client ..` deletes the repo |
| B-1 | Quarantine flag has no lifecycle + close races ingestion | The decision-97 guarantee (days ≡ frozen bill) breaks permanently after the *documented* reopen→re-close correction flow; traces can silently vanish from bills |
| B-2 | Snapshot write protocol: crash-retry wedges the close **and silently mutates stored snapshot inputs** | The one artifact that must be beyond doubt (T6 reproducibility) can be corrupted by a crash + retry |
| B-3 | One poison/oversized trace permanently stalls all ingestion | With LangWatch's ~49-day retention, a stall becomes real archive loss — the exact failure invariant 6 exists to prevent |
| B-4 | Windowed (backfill) sync misses the quiet-period guard on the update axis | In-flight traces get partial, immutable stamps → permanent undercharge |
| C-1 | Express 4.17.1 (qs 6.7.0 / body-parser 1.19.0) — known request-DoS CVEs | Reachable pre-validation on every endpoint |
| T-1 | `npm run test:ci` is broken | Coverage/CI gate unenforceable; would mask the other gaps |

Everything else is graded M/L: contract-hardening, consistency drift, duplication, and hygiene — individually small, and worth batching.

**Effort estimate (rough):** P0 ≈ 1 day · P1 ≈ 2–3 days · P2 ≈ 2 days · P3 ≈ 2 days · P4 (docs/hygiene) ≈ ½ day. Test additions are folded into each batch.

---

## 1. P0 — Security & data-destruction (fix first, small diffs)

### A-1 · CRITICAL — Documented auth enablement does not work: `AUTH_SYSTEM_*` never reaches the container
- **Files:** `compose.module.yml:38-48` (api `environment:` block) · `clients/example.env:30-32` · `packages/module/src/infrastructure/configuration/helpers/environment-setup.ts:46-48` · `Makefile:35-49` (SCRUB list) · README §"API auth" · decision 84
- **Verified:** repo-wide grep — `AUTH_SYSTEM` appears **only** in `example.env` comments. No compose file, script, or Makefile forwards it. Docker's `--env-file` feeds compose *interpolation* only, never container environment; `.dockerignore:21-22` excludes `**/.env.*` from images.
- **Failure:** operator uncomments the three vars per README, redeploys, believes auth is on. In-container `AUTH_SYSTEM_URL` is `undefined` → `makeAuthMiddleware()` returns the passthrough (`auth-factory.ts:12`) → the API — full **unmasked** trace content — stays open. The loud fail-closed warning at `auth-factory.ts:18` never fires because it's gated on the URL being set. Decision 84's smoke test evidently ran outside compose.
- **Fix:**
  1. `compose.module.yml`, api service `environment:` — add:
     ```yaml
     AUTH_SYSTEM_URL: ${AUTH_SYSTEM_URL:-}
     AUTH_SYSTEM_CLIENT_ID: ${AUTH_SYSTEM_CLIENT_ID:-}
     AUTH_SYSTEM_CLIENT_SECRET: ${AUTH_SYSTEM_CLIENT_SECRET:-}
     ```
  2. Add the three names to the Makefile `SCRUB` list (the Makefile's own rule at :35-36 requires every interpolated var to be scrubbed).
  3. Guard in code: `environment-setup.ts` — treat empty string as unset (`.transform(v => v || undefined)`) so the `:-` default doesn't half-enable auth.
  4. Smoke check in `scripts/5-verify-client.sh`: when the env file sets `AUTH_SYSTEM_URL`, assert a tokenless `GET /api/v1/traces` answers 401.
  5. Note in `docs/khal-os-inconsistencies.md` item 5 (it currently says "RESOLVIDO (parcial)").
- **Test:** none feasible at unit level (compose wiring); the step-5 smoke check is the executable guard.

### A-2 · HIGH — API and LangWatch published on all interfaces, auth-less by default
- **Files:** `compose.module.yml:49-50` (`"${API_PORT:-3000}:3000"`) · `compose.connector.yml:154-155` (5560) and `:48` (`NEXTAUTH_PROVIDER: email` — open signup, no verification)
- **Failure:** any host not firewalled to the client's network exposes the full unmasked archive (`GET /api/v1/traces`) and lets outsiders self-register on the client's LangWatch.
- **Fix:** default bindings to loopback — `"127.0.0.1:${API_PORT:-3000}:3000"` and same for 5560 — with explicit `API_BIND`/`LANGWATCH_BIND` override vars documented in `clients/example.env` for deliberate exposure (`compose.dev.yml:32` already does this for mongo). The UI container reaches the API over the compose network, not the host port, so the dashboard keeps working.
- **Note:** this changes deployment behavior for anyone relying on LAN access — flagged as an **open question** (§7-Q4) rather than auto-applied; my recommendation is loopback-by-default.

### A-3 · HIGH — `rmSync` path traversal in the fixtures generator
- **File:** `packages/module/scripts/generate-demo-fixtures.mjs` (~:480-507)
- **Verified:** `const dir = path.join(OUT_ROOT, name)` where `name` is raw `argv[clientFlag + 1]`; then `rmSync(dir, { recursive: true, force: true })`. `--client ..` resolves to the repo root. Shell wrappers validate the slug, but the script header documents direct invocation.
- **Fix:** at the top of the write loop:
  ```js
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) throw new Error(`invalid client slug: ${name}`);
  ```
  (same regex as `deploy-lib.sh:106`), plus a belt-and-braces `path.resolve(dir).startsWith(path.resolve(OUT_ROOT) + path.sep)` assertion before `rmSync`.

### A-4 · MEDIUM — CSV export: spreadsheet formula injection + unquoted `\r`
- **File:** `packages/module/src/presentation/controllers/billing/export-statement-controller.ts:23-26`
- **Verified:** `csvEscape` quotes only `"`, `;`, `\n`. `line.agent_id` / `line.model` originate from LangWatch trace metadata (agent-controlled). `=HYPERLINK(...)`, `@SUM(...)`, `=cmd|'/C calc'!A0` pass through verbatim into a file designed to "open straight in Excel". A literal `\r` in a cell breaks row structure (rows join with `\r\n`).
- **Fix:** in `csvEscape`: (1) extend the quote-trigger class to `/[";\n\r]/`; (2) when the value starts with `=`, `+`, `-`, `@`, `\t`, or `\r`, prefix `'` (OWASP CSV-injection mitigation) before the quoting logic. Unit test with hostile agent id (see §6 M3).

### A-5 · MEDIUM — Ops script safety batch (small fixes, one commit)
1. **`deploy-lib.sh get()` + `set -e` kills scripts on optional env vars** — `deploy-lib.sh:114`: `grep` exits 1 on no-match, `pipefail` propagates, the script dies with *no message*; the `${VAR:-default}` fallbacks right after are dead code (`5-verify-client.sh:17`). A minimal env file written per the published contract (`example.env` explicitly invites omitting ports/knobs) kills steps 2/4/5. **Fix:** `get() { grep -oP "(?<=^$1=).*" "$ENVFILE" | head -1 || true; }`.
2. **`register-module.sh:51` advertises `/health`, which doesn't exist** — the platform monitor would probe it and get the JSON 404. **Fix:** point the manifest at `/api/v1/docs/openapi.json` (the same URL the container healthcheck uses, deliberately open under auth) — or add a real `/health` route (then also see C-9).
3. **`make up` mkdir uses `$(CLIENT)` while compose mounts `${CLIENT_NAME}`** — `Makefile:87` vs `compose.dev.yml:20`; if they differ, the root-owned-dir bug the mkdir exists to prevent comes back, and the dev/prod sync discriminator checks the wrong dir. **Fix:** in `require-client`, assert `grep -qx "CLIENT_NAME=$(CLIENT)" $(ENVFILE)` (and same for `COMPOSE_PROJECT_NAME`).
4. **No backup runbook for the permanent archive** — the only volume command the docs teach is `down -v` ("apagar"), printed in three places; invariant 6 calls this store the permanent archive. **Fix:** add `make backup CLIENT=x` (`docker exec ${CLIENT}-mongo mongodump --archive --gzip > backups/${CLIENT}-$(date).gz`) + a restore note, referenced beside every `down -v` mention.
5. Small ones: `trap 'rm -f "$JAR"' EXIT` in `3-onboard-langwatch.sh` (cookie-jar leak on failure) · `chmod 600` on env files created by `1-init-client-env.sh` · escape sed replacement metacharacters in `1-init`/`3-onboard` env writes (`&` corrupts) · add healthchecks for `langwatch`, `langwatch-workers`, `trace-ingestion-worker` in `compose.connector.yml` · confirmation prompt on `make billing-reopen`.

---

## 2. P1 — Billing-lifecycle correctness (the invariant-bearing cluster)

These four findings interlock; **B-1 and B-2 should be designed together** (they share the close use case and one new post-close reconciliation step). Found independently by 3–4 of the audit passes each; all verified line-by-line.

### B-1 · HIGH — Quarantine has no lifecycle, and close races concurrent ingestion
Two defects, one fix.

**(a) The `billingQuarantine` flag is write-once and read inconsistently.**
- **Verified (exhaustive grep):** set in exactly one place (`trace-ingestor.ts:57`), cleared **nowhere**. Readers disagree: `dailyRollup` **excludes** flagged traces (`mongodb-billing-query-repository.ts:320` — with a comment promising "days of a closed month sum to its frozen total, decision 97"); `countQuarantined` counts them forever (`:380`); `fetchUsageRecords` (feeds live statement **and** close snapshots), `monthlyRollup`, and `listBills` have **no** quarantine filter at all. `list-bills-db-use-case.ts:106` additionally hardcodes `quarantinedTraceCount: 0` for open months — wrong for a reopened month (US5 says the admin must see them).
- **Failure:** decision 89 defines reopen→re-close as *the* correction flow ("reabrir re-inclui os quarentenados no v+1 — esse É o fluxo"). Run it: during the reopened window, summary + monthly series include the quarantined trace while the daily series excludes it (two "one-truth" endpoints disagree, visibly). After re-close, snapshot v2 **bills** the trace while `countQuarantined` still reports it "excluded from the bill" and the daily series excludes its cost **forever** — the decision-97 guarantee is permanently broken for every corrected month.

**(b) TOCTOU between ingestion and close.**
- **Verified:** the ingestor reads period status (`trace-ingestor.ts:49-53`) *before* the insert (`:62`), no re-check; the close is four non-atomic steps (pending guard → `fetchUsageRecords` → snapshot insert → `markClosed`, `close-billing-period-db-use-case.ts:70-127`). The continuous worker runs during runbook closes by design.
- **Failure:** a trace dated in the closing month, ingested between `fetchUsageRecords` and `markClosed` (or after the ingestor's stale `open` read), lands **stamped, unquarantined, inside a closed month, absent from the snapshot**: invisible to `countQuarantined`, included in `dailyRollup` (days ≠ frozen bill), and silently outside the bill — CLAUDE.md invariant 3 calls that a defect, not a footnote. The pending-trace variant slips past the close's pending guard and is then permanently unstampable (reprocess skips closed months) without being flagged.

**Fix (one coherent mechanism — "the snapshot adjudicates"):**
1. **New repository op** `TraceRepository.reconcileQuarantineAfterClose(monthStart, monthEnd, snapshotTraceIds, snapshotVersion)` implemented in `mongodb-trace-repository.ts` as two idempotent `updateMany`s:
   - *Flag stragglers:* traces in `[start, end)` **not** in `snapshotTraceIds` and not already flagged → `$set: { billingQuarantine: { reason: 'period_closed', quarantinedAt: now } }` (closes race (b) mechanically, regardless of interleaving).
   - *Absorb the adjudicated:* traces **in** `snapshotTraceIds` currently flagged → `$set: { 'billingQuarantine.absorbedInSnapshotVersion': snapshotVersion }` (the historical mark stays, per the model doc at `trace-model.ts:119-126`, but it no longer means "outside the bill").
2. **Call it in `CloseBillingPeriodDbUseCase.close()` after `markClosed` succeeds** (the usage records are already in memory — the id set is free).
3. **Readers filter on *unresolved* quarantine:** `dailyRollup` and `countQuarantined` change their filter to `'billingQuarantine.reason': {$exists: true}` **and** `'billingQuarantine.absorbedInSnapshotVersion': {$exists: false}` (exclusion/count respectively). `fetchUsageRecords`/`monthlyRollup`/`listBills` stay unfiltered for *open* months — that is decision 89's intended semantic (a reopened month's live bill includes the late traces; the daily series should too, so for **open/reopened** months `dailyRollup` includes unabsorbed quarantined traces of that month — simplest correct rule: exclude unabsorbed quarantined only when the month is closed; since after this fix a closed month structurally contains no unabsorbed stragglers, the filter change in (3) alone restores consistency in all states).
4. `list-bills-db-use-case.ts:106`: drop the hardcoded `0`; call `countQuarantined` for open months too.
5. Fix the now-false doc comment at `application/interfaces/billing-query-repository.ts:80-81`.
6. **Append a decision-log entry** (quarantine lifecycle: flag at ingest → adjudicated at close; absorbed ⇒ billed).
- **Tests (must-have, see §6 M1):** quarantined trace → reopen → re-close → `Σ dailyRollup(month) ≡ snapshot v2 total` and `countQuarantined === 0`; ingest-during-close straggler ends up flagged; the whole thing at the pipeline level.

### B-2 · HIGH — Snapshot write protocol: crash-retry wedges the close and silently mutates stored snapshot inputs; concurrent closes cross-contaminate
- **Files:** `close-billing-period-db-use-case.ts:90,110-127` · `mongodb-billing-snapshot-repository.ts:22-46`
- **Verified:** `version = (period?.snapshotVersion ?? 0) + 1` — and `snapshotVersion` is only ever written by `markClosed`. The snapshot repo does `deleteMany → insertMany → insertOne(header)`, no transaction.
  1. **Crash between snapshot insert and `markClosed`:** the retry recomputes the *same* version (the period doc never advanced), so the header insert hits the `(year, month, version)` unique index → raw `E11000` → **every retry fails**; the close is wedged until manual surgery. The code comment ("harmless — the next close writes version + 1") is only true after a *reopen*, not for the crash path it describes.
  2. **Worse:** on that failing retry, `deleteMany` + `insertMany` run **first** and succeed — replacing the usage records stored under the *existing* header with freshly fetched data. If any trace landed in between, the stored inputs of a supposedly immutable snapshot no longer reproduce its stored statement. T6's reproducibility contract breaks silently, in exactly the artifact built to be beyond doubt.
  3. **Concurrent closes** (hung run + operator retry): both compute v1; interleaving leaves A's header over B's usage rows; `markClosed`'s conflict guard fires only after the damage.
- **Fix:**
  1. Wrap `usage.deleteMany` + `usage.insertMany` + `snapshots.insertOne` + `billingPeriodRepository.markClosed` in **one `MongoDb.withTransaction`** (the decision-81 infrastructure exists; deployment and jest both run replica sets). This makes crash-retry and concurrency behave: either everything lands or nothing does.
  2. Derive the version collision-proof anyway: `version = max(period?.snapshotVersion ?? 0, (await snapshotRepository.findCurrent(year, month))?.version ?? 0) + 1`.
  3. In the snapshot repo, catch `E11000` on the header insert and rethrow a typed `BillingPeriodStateError` (mirror `markClosed`'s conflict mapping) so a concurrent close surfaces as a clean 409-class runbook message, not a raw MongoServerError.
  4. Update the misleading comment at `close-billing-period-db-use-case.ts:110-113`.
- **Tests:** simulated crash-then-retry close (kill between snapshot and flip → retry must succeed and reproduce); repo-level concurrent double close asserting usage-collection integrity (§6 M8).

### B-3 · HIGH — One deterministic per-trace failure permanently stalls all ingestion (no isolation, no dead-letter, no size guard)
- **Files:** `sync-batches-use-case.ts:77-102` · `sync-traces-use-case.ts:42-70` · `run-trace-ingestion-loop.ts:107-115` · `mongodb-trace-repository.ts:75-79`
- **Verified:** neither sync loop try/catches around `ingestSourceTrace` (contrast: `ReprocessPendingToDbUseCase` has per-trace isolation, decision 79g). `insertIfAbsent` swallows only E11000. The worker treats every cycle error as transient and retries the *same* batch forever (cursor correctly doesn't advance). Two deterministic triggers exist today: **(1) BSON 16MB** — one trace embeds full input/output + all spans' content (decision 47), no size guard anywhere; a long agent session over 16MB throws the same server error every cycle; **(2) money overflow** — boundary schemas validate token counts as non-negative safe integers only, so a corrupt-but-integer `10^12` count passes and `stampTokens` throws deterministically.
- **Failure:** head-of-line blocking forever; LangWatch's ~49-day retention keeps burning behind the stalled cursor → **permanent archive loss** for the stalled span. Secondary: the hourly reprocess sweep only runs after a successful drain (`run-trace-ingestion-loop.ts:90-105`), so pending re-stamps starve too.
- **Fix:**
  1. **Per-trace try/catch in both sync loops**: on failure, upsert into a new durable `ingest_failures` collection (`{traceId, cursorAtFailure, error, firstSeenAt, attempts}`), count `failed` in the report, continue the batch, advance the cursor for a fully-scanned batch.
  2. **Circuit breaker symmetry:** if *every* trace in a non-trivial batch fails ingestion, throw without advancing (store outage, not poison) — mirrors the decision-79e source-side breaker.
  3. **Size guard at the write boundary:** estimate BSON size pre-insert (`BSON.calculateObjectSize` from the mongodb package, or serialized-length heuristic > ~15MB); on breach, store the trace with span `input`/`output` replaced by `{truncated: true, originalBytes}` and an explicit `contentTruncated: true` top-level flag, and record the event in `ingest_failures` — a truncated archived trace beats a lost one (tokens/costs are unaffected; they come from counts, not content).
  4. **Decouple the reprocess sweep** from drain success: run it on its time cadence regardless (move the check outside the drain-success branch).
  5. Append a decision-log entry (dead-letter + truncation policy — this touches invariant 6's "store everything": the *content* may be truncated at 16MB, the trace never dropped).
- **Tests:** poison trace mid-batch doesn't block the batch (§6 M7); oversized-doc truncation path.

### B-4 · HIGH — Windowed (backfill) sync applies the quiet period on the wrong axis → partial immutable stamps
- **File:** `clickhouse-langwatch-client.ts:170-211` (vs the correct continuous path at `:146`)
- **Verified:** `fetchTraces` clamps the window on the trace's **start** instant (`clampWindowToQuietPeriod`) and queries by `OccurredAt` only — **no `UpdatedAt` filter**. `fetchBatch` (continuous) correctly filters `s.UpdatedAt < updatedBefore`.
- **Failure:** a trace started 30+ minutes ago and *still receiving spans* (long agent run, human-in-the-loop pause) passes the clamp; `make sync` — the documented backfill/onboarding path — stamps it with partial tokens, immutably: permanent undercharge, the exact failure decision 79(d) claims to close.
- **Fix:** add `AND s.UpdatedAt < fromUnixTimestamp64Milli({updatedBeforeMs:Int64})` (with `updatedBefore = now − quietPeriodMs`) to the windowed query, `console.warn` the deferred-row count so the operator knows to re-run.
- **Related residual (accepted-by-design but currently invisible):** a trace quiet >15min mid-run then resumed is ingested partial; the later `UpdatedAt` bump arrives as `skipped` and the extra tokens are silently discarded (`trace-ingestor.ts:78-85` refreshes attribution only). **Fix (visibility, not behavior):** on the `skipped` path, compare source `sumTokens(trace.tokens)` vs stored `tokensTotal`; log + count a `tokenDivergence` metric when they differ. Decide separately whether divergence should ever re-open a pending stamp (it must never touch a stamped one — invariant 1); logged as open question §7-Q3.

### B-5 · MEDIUM — `stampPendingTrace` CAS doesn't pin the model: reprocess can stamp old-model prices onto a corrected trace
- **Files:** `mongodb-trace-repository.ts:185-206` · `reprocess-pending-use-case.ts:65-86`
- **Verified:** the CAS filter is `{traceId, pricingStatus: 'pending_price'}` — status only. Reprocess reads the model, resolves prices, then CASes. A concurrent `updateAttribution` correcting the model (legal: trace pending, month open) still matches the CAS → prices for model A stamped, immutably, onto a document whose stored model is B. Per-line `tokens × price = cost` still checks out — against the wrong catalog entry, forever.
- **Fix:** one line — include the model in the filter: `{traceId, pricingStatus: 'pending_price', model: trace.model ?? null }` (the `PendingPriceTrace` projection already carries it). Mismatch → `matchedCount 0` → `'skipped'` → next sweep re-reads fresh. Note: `model` is a nested object; use an exact-match on the two fields (`'model.id'`, `'model.provider'`) rather than whole-doc equality to avoid key-order pitfalls. Contract test in the trace-repository contract suite (§6 M8).

### B-6 · MEDIUM — Session summaries: last-writer-wins recompute can persist stale numbers forever under the *legal* two-writer setup
- **Files:** `mongodb-session-summary-repository.ts:33-49` · `mongodb-trace-repository.ts:69-71` (documents worker + manual `make sync` as "a legal combination")
- **Verified:** `recompute` is aggregate-then-`replaceOne`, no versioning. Interleaving A(insert T1, aggregate) / B(insert T2, aggregate, write) / A(write) loses T2. "Healed by next touch" fails for finished conversations — the drift is permanent until `make rebuild-session-summaries`. Also, two first-touch upserts on the same `_id` can race into an uncaught E11000 that fails the batch *after* the trace transaction committed.
- **Fix:** replace the read-then-write pair with a single server-side `$merge` pipeline (`$match{sessionId} → …existing stages… → $merge{into: SESSION_SUMMARIES, on: '_id', whenMatched: 'replace', whenNotMatched: 'insert'}`), which serializes per document on the server; wrap with one retry-on-11000. Correct the "single-writer assumption" comment. Test: two-writer interleaving (§6 M8).

### B-7 · MEDIUM — Model-id casing never canonicalized; price lookup is exact-match
- **File:** `domain/models/model-ref.ts:41-52`
- **Verified:** provider lowercased; **id kept verbatim** (`inferProvider` even matches against the lowercased id but stores the original — the asymmetry is clearly unintentional). ClickHouse `gen_ai.*` model attributes are free-form (the file's own QA14 note).
- **Failure:** a source emitting `Anthropic/Claude-Sonnet-5` yields key `anthropic/Claude-Sonnet-5`, which never matches the registered `anthropic/claude-sonnet-5` → silent `pending_price`, blocks month close, and registering the price *as the operator knows it* doesn't unblock — they must discover the casing variant and register a duplicate price row that then becomes a distinct billing dimension.
- **Fix:** lowercase the id in `parseModelRef` (matching the provider treatment) — the canonicalization point is single by design (decision 82), so this is one line + ripples: (a) a new migration `018-lowercase-model-ids.ts` backfilling stored `traces.model.id` and `price_versions.model` keys (attribution-only change on traces — never touches stamps, invariant 7 allows it in open months; for closed months the stored *snapshot* keys stay as-frozen, which is correct); (b) note in the decision log. **If** case-sensitive ids are ever real (none known today), the alternative is a warning in the pending-models list on case-only mismatch — my recommendation is lowercasing; flagged §7-Q2.

### B-8 · MEDIUM — `effective_from` (and query `from`/`to`) accept timezone-less local datetimes → server-TZ-dependent immutable stamps
- **Files:** `price-view-schemas.ts:23-26` · `presentation/helpers/query-validation.ts:19-22` · `main/jobs/insert-price-version.ts:48`
- **Verified:** `z.iso.datetime({ offset: true, local: true })` admits `2026-07-01T00:00:00`, which `new Date()` reads in the **server's** TZ; date-only strings read as UTC — the two spellings of "July 1 midnight" differ. The runbook is looser: any `Date`-parsable string (`07/01/2026` parses US-local).
- **Failure:** on a UTC-3 host, `effective_from: 2026-07-01T00:00:00` becomes 03:00Z — traces from the first three hours of July 1 stamp with the *previous* price, immutably.
- **Fix:** drop `local: true` from both unions (accept date-only or offset-carrying datetimes only); in the runbook validate `--effective-from` with `/^\d{4}-\d{2}-\d{2}(T.*(Z|[+-]\d{2}:?\d{2}))?$/` and reject otherwise. Add a TZ-pinned test (run one spec with `process.env.TZ = 'America/Sao_Paulo'`).

### B-9 · MEDIUM — `model_mix.by_agent` re-reconciles cents independently → can contradict the agent card by 1 cent
- **File:** `billing-view-model.ts:249-277` (`toModelShareViews`) as used at `:418` (`by_agent`)
- **Verified:** the agent card shows statement-level largest-remainder cents (`statement-engine.ts` reconciliation); `by_agent` runs an *independent* `reconcileDisplayCents` per agent whose total is half-up of the agent's exact µ¢. Half-cent case: agents A and B each one 500 000 µ¢ line → cards R$ 0,01 / R$ 0,00 (consistent with total 0,01), but B's model breakdown shows R$ 0,01 — contradicting B's own card, and Σ by-agent models = 0,02 ≠ 0,01. This is the exact drift class the file's own comment says "once shipped".
- **Fix:** derive by-agent model cents from the engine's already-reconciled `line.displayCents` (sum per agent×model — they close with the agent group by construction). Keep the independent reconciliation only for `model_mix.total` (where the target *is* the statement total). Extend `billing-view-model.spec.ts` with the half-cent fixture asserting per-agent closure.

### B-10 · Statement/series/summary — smaller correctness items
1. **Monthly series has no zero-fill** (`get-billing-series-db-use-case.ts:76-110`) — a month with zero traces and no lifecycle doc vanishes; the daily lens deliberately zero-fills ("a gap must LOOK like a gap"). Also `slice(-maxMonths)` runs *after* per-month snapshot fetches (wasted queries). **Fix:** enumerate the continuous month range oldest→current, zero-fill absent months (`open`/`in_progress` status), slice before snapshot fetches. — LOW
2. **`list-bills` corrupt-state inconsistency** (`list-bills-db-use-case.ts:73-77` vs `:115-120`): closed+no-snapshot **throws** when the month has traces, but is **silently skipped** when it has none — the bill disappears from the list. **Fix:** throw in both branches. — LOW
3. **Future months labeled "Aberto — aguardando fechamento"** (`get-billing-summary-db-use-case.ts:101-113`): `?year=2027&month=1` renders a legit-looking zero bill, exportable without PARCIAL. **Fix:** 400 on future months (or a distinct `future` status; recommendation: 400 — nothing legitimate queries the future). — LOW
4. **`BillListItem.tokens` semantics flip at close** (interface doc says "stamped and pending alike"; closed months serve `stampedTokensTotal`). **Fix:** align open months to stamped-only, or document; recommendation: expose both `tokens` and `stamped_tokens` and label. — LOW
5. **Agent-mix donut merges by label** (`billing-view-model.ts:209-231` keyed on `agentId ?? '(sem agente)'` — a real agent named `(sem agente)` merges with null). **Fix:** key on the id (`string | null`), label at render. — LOW
6. **HTML statement lines table omits `vigente desde`** (`export-statement-controller.ts:174-178`): a mid-month price change renders two visually identical rows with different prices, unexplained (the CSV has the column). **Fix:** add the column to the HTML table. — LOW
7. **`shareBasisPoints` / engine group sums use float arithmetic** (`statement-engine.ts:62-84,112-114,152-157,195-197`): deterministic (snapshots reproduce) but precision-lossy at scale; `money.ts` insists on BigInt for exactly this. **Fix:** BigInt floors + BigInt remainder ordering in `shareBasisPoints`; route group accumulations through `sumMicrocents`. **Bump `STATEMENT_LOGIC_VERSION`** (the file's own rule: any math change bumps it) — which is why this ships *before* real closes pile up. — LOW
8. **`reconcileDisplayCents` floors via float division** (`money.ts:129-131`): near 2^53 µ¢ the division can cross an integer boundary → floors sum > total → parts don't close. The exact remainder is already computed two lines below. **Fix:** `floors = (microcents - remainder) / MICROCENTS_PER_CENT`. Two lines + an extreme-magnitude spec case. — LOW

---

## 3. P2 — API contract, auth hardening, dependencies

### C-1 · HIGH — Express 4.17.1 stack: known query/body DoS CVEs reachable pre-validation on every endpoint
- **Verified:** installed `express 4.17.1`, hoisted `qs 6.7.0`, `body-parser 1.19.0`. qs 6.7.0 → CVE-2022-24999 (`?a[__proto__]=b&a[__proto__]&a[length]=100000000` hangs the process inside Express routing, before any zod). body-parser 1.19.0 → CVE-2024-45590 (urlencoded DoS), and `urlencoded({extended:true})` is mounted globally on a JSON-only API.
- **Fix:** bump to `express@^4.21.2` (pulls qs ≥6.13, body-parser 1.20.3), reinstall, run the suite (Express 4 minor bumps are API-compatible; the route tests cover the surface). **Delete `urlEncodedMiddleware`** entirely (`main/server/middlewares/url-encoded.ts` + its mount) — no endpoint consumes form bodies, and it currently accepts an undocumented content type on `POST /prices`.

### C-2 · MEDIUM — POST /prices: unbounded price string → 500; `"0"` → permanent R$ 0.00 stamps
- **Verified:** `price-view-schemas.ts:20-22` regex has no length cap — `"999999999999"` passes schema, `brlToMicrocents` throws above ~R$ 90M, controller rethrows → 500 (contract documents 400). The same regex admits `"0"` — an accidental zero price triggers the immediate reprocess (decision 57) and stamps every pending trace for that model at R$ 0,00, immutably; invariant 2's spirit ("never valued at R$ 0.00") makes this the most expensive typo the endpoint accepts.
- **Fix:** tighten the regex to `/^\d{1,8}(\.\d{1,8})?$/` (≤ R$ 99,999,999/M — far above any real price) → overflow becomes a 400 `InvalidParamError('price_brl_per_million')`; add `.refine(v => parseMicrocents(v) > 0)` to reject zero (if free-tier models ever become real, that's a new decision-log entry, not a silent default). Mirror both rules in the runbook job's validation. Tests: overflow → 400, zero → 400, both via HTTP.

### C-3 · MEDIUM — "Strict queries" is not uniform: every billing endpoint (and both detail endpoints) silently accepts unknown params
- **Verified:** all five billing controllers hand-roll `(query as {...})` + `Number()` (which also accepts `0x7E2`→2018, `2e1`→20 — spellings the zod endpoints reject); `?granularity=month&days=7` silently ignores `days`; `/bills` and `/billing/projection` ignore the query entirely; the two detail controllers never look at it. The traces/sessions layer states the policy explicitly ("an unknown param is a 400, never silently ignored") — billing is where the money is, and it's the layer that doesn't comply. The year/month block is also copy-pasted between summary and export controllers.
- **Fix:** add `yearMonthQueryShape` (`z.coerce.number().int().min(1970).max(9999)` / month 1-12) to `presentation/helpers/query-validation.ts`; route all five billing controllers through the existing `parseQuery` + `z.strictObject` (statement adds `format: z.enum(['csv','html']).default('csv')`; series adds `granularity`/`months`/`days` with a cross-field 400 when `days` is used with `granularity=month` and vice versa; `/bills` + `/billing/projection` get the empty strict object); pass an empty strict schema over `query` in the two detail controllers. Extend `parseQuery`'s issue mapping to emit `MissingParamError` for undefined-required (matching the house rule in `register-price-version-controller.ts:56-66`).

### C-4 · MEDIUM — Auth-layer gaps (docs + performance + edge cases)
1. **OpenAPI omits auth entirely** — no `securitySchemes`, no 401s, no Authorize button in Swagger; `info.version` hardcoded `0.1.0` vs package `1.0.0`. **Fix:** add `bearerAuth` scheme + top-level `security` + shared 401 response with an "env-gated" description; wire the version from package.json.
2. **Introspection has no cache** — one auth-system round trip per API request, 3s timeout, stampede on parallel dashboard loads, hard availability coupling. **Fix:** in-memory TTL cache in `HttpTokenAuthenticator` keyed by SHA-256 of the token (never the raw token), ~30s positive / ~5s negative, plus in-flight promise de-duplication. Fail-closed semantics unchanged.
3. **Bearer scheme matching is case-sensitive** (`auth.ts:29-31`), contra RFC 7235. **Fix:** `/^Bearer\s+(.+)$/i`.
4. **Docs/OPTIONS bypass is deliberate but undocumented** — `/api/v1/docs*` + `openapi.json` open under auth ("they are the healthcheck"), OPTIONS enumerates methods. **Fix:** decision-log entry + soften the CLAUDE.md "every request" sentence. (Gating `openapi.json` itself: open question §7-Q5.)
5. **UI has no token mechanism** — enabling auth bricks the dashboard with "A API do cliente está no ar?" (an outage message for an auth condition); export links 401. **Fix (minimal, this pass):** branch on 401 with a dedicated "autenticação ativa — esta UI ainda não envia token" message. The real service-token flow is future work (§7-Q6).

### C-5 · MEDIUM — Missing HTTP-layer robustness (batch)
1. **Error boundary flattens middleware 4xx** — a 413 too-large body answers `400 InvalidParamError('body')` (`error-handler.ts:26-30`). **Fix:** preserve the original status, keep the `{name, msg}` shape.
2. **No 405** — wrong method on an existing path answers 404 "Not found: POST /api/v1/traces" (`not-found.ts:10-12`). **Fix:** small route table in the 404 middleware → 405 + `Allow` for known paths.
3. **`/api/v1/docs` without trailing slash serves a broken page** (assets resolve outside the mount → 401/404), and `/api/v1/docs/<garbage>` answers 200. **Fix:** `app.get('/api/v1/docs', 301 → '/api/v1/docs/')` and pin `swaggerUi.setup` to the exact index path so garbage falls through to the JSON 404.
4. **No graceful shutdown** — SIGTERM never calls `server.stop()`/db disconnect (`main/index.ts`; `ExpressServer.stop()` exists, unused). **Fix:** `process.once('SIGTERM'|'SIGINT', …)` with a hard-kill timeout.

### C-6 · MEDIUM — Source-client hardening (HTTP + ClickHouse)
1. **HTTP client** (`http-langwatch-client.ts:88-148`): one malformed N+1 detail throws away the whole windowed run (no decision-62 skip on this path — the CH path has it); no timeout/retry on any request (undici's ~300s default hang); the QA14 cap guard trusts `pagination.totalHits` — if LangWatch omits `pagination` (schema marks it optional), a >pageSize window degrades to a **silent partial sync**, the exact failure the guard exists to prevent; the pagination `for(;;)` loop is dead scaffolding (the guard throws before any second page). **Fix:** `safeParse` + skip-and-log per detail with an all-poison breaker; `AbortSignal.timeout(30_000)` + one retry on GETs; treat a full page with missing `totalHits` as an error; delete the dead loop.
2. **Poison durable trail** (`clickhouse-langwatch-client.ts:216-331`): skipped rows are `console.warn`-only; the breaker fires only on *all*-poison batches ≥10 — up to 9 poison rows per batch advance the cursor permanently; container logs rotate; after retention expiry the trace is irrecoverably gone with no durable record. Also asymmetric: the same bad-token defect drops the *whole trace* at CH-summary level but only the *count* at span/HTTP level. **Fix:** persist every skip at skip time into a `poison_rows` collection (`{id, cursor, zodError, seenAt, rawRow-if-small}`, upsert by id — same durable store as the archive); for summary rows failing *only* the token-count refinement, salvage: null the offending counts → trace lands `pending_price`/unclassified with content preserved, logged.
3. **Windowed backfill is unbounded in memory** (`fetchTraces` has no LIMIT; buffers all rows + all spans + full content): the 49-day onboarding backfill of a busy source OOMs before the first insert, and retries hit the same wall. **Fix:** paginate internally with the `(OccurredAt, TraceId)` tuple-cursor machinery from `fetchBatch`, ingesting page-by-page (async-iterator or callback), or route `run-sync` through `SyncBatchesToDbUseCase` with a window-bounded cursor.
4. **Quiet period measured against the worker's clock** (`sync-batches-use-case.ts:65`): worker clock behind ClickHouse's by N min shrinks the quiet period to 15−N. **Fix:** derive `updatedBefore` from the source's `SELECT now64(3)` once per cycle (or assert |skew| < tolerance at startup, next to the schema tripwire). — LOW
5. **`offsetMs` not clamped while `durationMs` is** (`trace-mapper.ts:82-86`, same clock-skew rationale). **Fix:** clamp to 0. — LOW

### C-7 · MEDIUM — Mongo query-layer scale guards (the class decision 79 fixed for /traces, now needed for billing)
1. **`listBills` + `monthlyRollup` are unbounded full-collection scans** over documents embedding full content (`mongodb-billing-query-repository.ts:26-71` — `$project` first stage still fetches whole docs; `:183-218` — near-zero-selectivity match then `$unwind` all history), on every `/bills` and series request. At the project's own 1M-trace sizing, that's tens of seconds and working-set eviction per Billing-tab load. **Fix:** bound both to *open* months (`startedAt: {$gte: firstOpenMonthStart}` derived from `billingPeriodRepository.listAll()`, which callers already fetch) — closed months are served from snapshots/period docs in both callers already.
2. **`fetchUsageRecords` sorts by `{traceId: 1}` with no serving index and no `allowDiskUse`** (`:99-117`): above the 100MB sort ceiling the query aborts — taking down `GET /billing/summary` *and* `make billing-close` for that month, with no workaround. **Fix:** drop the DB-side sort and sort in Node (the array is fully materialized for `buildStatement` anyway — determinism is the only contract requirement); or `allowDiskUse: true`.
3. **N+1s:** period lookup per trace in the ingest hot path (1000 lookups/batch; `reprocess` already models the fix: one `listAll()` → `Set` of closed month-keys per cycle, passed into `ingestSourceTrace`); `list-bills` awaits `findCurrent` + `countQuarantined` inside its per-month loop; `listVersions` probes `findVersion(1..n)` sequentially (add a real `listVersions()` repo method — one indexed find). Also drop the redundant pre-insert `findOne` in `insertIfAbsent` (insert directly; the E11000 catch already exists).
4. **Filter-counter decrement unguarded** (`mongodb-filter-counter-repository.ts:48-57`): drifted cube can go negative and *deflate* facet sums (negative tuples participate in `$sum` before the `count > 0` post-filter). **Fix:** `count: {$gt: 0}` on the decrement filter. — LOW
5. **Durability/serialization made explicit** (`mongodb-connection-setup.ts`): local URI pins neither `retryWrites` nor `w=majority` (Atlas URI does); the null-storage convention relies on the driver's `ignoreUndefined: false` default. **Fix:** explicit `{w: 'majority', retryWrites: true, ignoreUndefined: false}` at client construction. — LOW
6. Small ones: session-detail chain sort not index-aligned (extend migration index to `{sessionId, startedAt, traceId}`) · migration 013 `.catch(() => undefined)` swallows *all* dropIndex errors (match `codeName === 'IndexNotFound'`, rethrow otherwise) · migration runner check-then-act (claim via `findOneAndUpdate` + `$setOnInsert`) · `estimatedDocumentCount` comment claims "exact" (soften or use capped `countDocuments`) · watermark string-CAS assumes binary collation ≡ source ordering (assert ASCII trace-ids at the boundary). — LOW

### C-8 · MEDIUM — `MONGO_DB_ATLAS` can never be set (boot crash) — the Atlas branch is dead code
- **Verified:** `environment-setup.ts:53` — `z.boolean().optional()` parsing `process.env` strings; any set value fails validation → `process.exit(1)`. `docker/api.Dockerfile:47` *documents the trap instead of fixing it*.
- **Fix:** `z.enum(['true','false']).optional()` + transform to boolean in the existing transform block; one spec case. (Or, if Atlas is truly out of scope, delete the branch + var and note it — §7-Q7; recommendation: fix, it's two lines.)

### C-9 · LOW — Postman/OpenAPI drift
Add `GET /api/v1/sessions/filters` to the Postman collection (only missing endpoint); add collection-level `Authorization: Bearer {{token}}` with an "only when AUTH_SYSTEM_URL is set" note; add a day-granularity series example. Covered further by the docs batch (§5).

---

## 4. P3 — Structure, duplication, hygiene (behavior-preserving)

### D-1 · MEDIUM — Test code ships in the production build
`tsconfig.json` includes all of `src` with global jest types and `build` = plain `tsc` → every `.spec.ts`/`.test.ts`/`.contract.ts`, `billing-test-fakes.ts`, and the route harness compile into `dist/`, and the production build depends on jest ambient types. **Fix:** `tsconfig.build.json` excluding `**/*.{spec,test,contract}.ts`, the fakes, the harness, and `architecture-boundaries.spec.ts`, with `types: ["node"]`; `build: tsc -p tsconfig.build.json`; add `billing-test-fakes.ts` to the jest coverage excludes (currently forgotten).

### D-2 · MEDIUM — Extract the four duplicated business rules
1. **Period-status rule ×4** (summary `:101-113`, list-bills `:55-65`, series `:87-93` and `:208-215`): extract `resolvePeriodStatus(year, month, period, now)` into `domain/models/billing-period-model.ts` — it is a pure domain rule and the invariant-8 label logic should exist once.
2. **Calendar helpers cross-imported from a use-case file:** `monthWindowUtc`/`previousMonthOf` live in `get-billing-summary-db-use-case.ts:15-33` and are imported by three sibling feature folders. Move to `billing-period-model.ts` (the calendar month *is* the billing-period concept).
3. **TTL cache duplicated and already drifted** (session copy has LRU-refresh, trace copy doesn't — so a hot trace-filter key can be evicted first): extract `application/helpers/ttl-cache.ts` with the session semantics; both use cases delegate.
4. **Token-type order declared 4×** (canonical `TOKEN_TYPES` in price-version-model; re-declared in statement-engine, twice in billing-view-model, and as literals in docs-schemas): use `TOKEN_TYPES` + `z.enum(TOKEN_TYPES)` everywhere.
5. **Facet-cube tuple rule duplicated** between `toFilterCounterDims` (JS, incremental writes) and `rebuildFromTraces` (hand-written `$group`): extract a shared `filter-counter-pipeline.ts` (the codebase already models this correctly for sessions) + an incremental≡rebuild identity test.

### D-3 · LOW — Dead code, stale comments, naming
- Delete `BillingSummaryLine` (`domain/useCases/get-billing-summary-use-case.ts:140-147`) + its unused import (`billing-query-repository.ts:2`); reword the ghost `aggregateMonth` reference (`:57`) to `fetchUsageRecords`.
- Fix stale comments: `fake-trace-source-client.ts:10-13` ("pending the QA14 spike" — spike closed 2026-07-20); `session-model.ts:840-842` ("no materialized state" — contradicts decision 80); `push-demo-to-langwatch.mjs:36` (`compose.client.yml` rename); `docker/api.Dockerfile:7-8` (nonexistent lock file); stale test name "MUST pass the internal margin columns through" (`register-price-version-use-case.spec.ts:103`).
- `billing-view-model.ts:671-672` hardcodes "a partir de 3 dias" — import `PROJECTION_MIN_COMPLETE_DAYS` (already imported from that module at :11) and interpolate.
- Remove the one non-null assertion (`price-stamper.ts:57`) via the `flatMap` rewrite; behavior-identical.
- Naming (one mechanical commit, optional): `*ToDbUseCase` → `*DbUseCase` for the four write use cases (Close already uses the read style — the convention is inconsistent, pick one); `Database.ts`/`Server.ts` → lowercase; align `session-filter-query.ts` to `z.strictObject`.
- Break the repo↔counter-repo lazy-import cycle by moving `TRACES_COLLECTION` (and friends) to a `collections.ts` module.
- Add one CLAUDE.md line documenting the load-bearing `.spec.ts`=unit / `.test.ts`=integration convention (it's enforced by the two jest configs but written nowhere).
- `ApiError` base class in `presentation/errors/` so the `{name, msg}` wire shape is structural, not seven hand-maintained conventions.

### D-4 · MEDIUM — UI batch (`packages/ui/app.js`)
1. **Auto-refresh destroys keyboard focus in the tables every 5s** — selects are protected from background repaints, rows aren't (`innerHTML` swap drops focus to body). Reuse the existing `rowIdentitySelector` machinery to capture/restore, or skip the repaint while focus is inside the tbody. (Accessibility regression, the codebase clearly cares — c0dd8b6.)
2. **Panel is not a modal dialog** — no `role="dialog"`/`aria-modal`/focus trap; static label says "Detalhe do trace" even for sessions/faturas; `#error` has no `aria-live`. Fix all four.
3. **Attribute-context interpolations of assumed-numbers** (14 sites: waterfall widths, donut stops, `data-year`, export hrefs, `renderStat`): no live XSS (verified — every user/LLM string goes through `escapeHtml`), but one API schema drift away from attribute breakout. Coerce with `Number()`/`escapeHtml` at bind time to honor the file's own header contract.
4. Small: pager re-enables Prev on error at page 1; `costCellHtml(...).replace('preço pendente', …)` string surgery → parameter; 401-specific message (C-4.5).

---

## 5. P4 — Documentation & decision-log alignment

All are "update docs" unless marked (code):

1. **CLAUDE.md:** bump "decisions 87–95" → 87–98; one clause under invariant 9 for `pricingType` (decision 96 made price *resolution* a declared, dispatched property); soften the auth "every request" sentence per C-4.4; add the spec/test-suffix convention line (D-3).
2. **Backlog (`backlog-v2.3.md`):** strike QA4/QA7/QA13 with pointers to decisions 87/91/94 (QA1/QA14 style); annotate the T4 margin-columns text (`:37`, `:287`) as superseded by decision 96; **append new decision-log entries** for: `GET /sessions/filters` (shipped citing "76/80", neither records it), the quarantine lifecycle (B-1), the dead-letter/truncation policy (B-3), the docs-open-under-auth scope (C-4.4), and zero-price rejection (C-2).
3. **README:** add the T6 runbook (`billing-close`/`billing-reopen`/`rebuild-*` + the new `backup`) to Day-2 operations; fix the garbled ASCII diagram + the "(3000/5560)" port aside (UI 8080 exists).
4. **demo.md:** the step-1 banner must include `make seed-prices` — following the current instructions yields an empty price table and every trace `pending_price` (migrations are indexes-only since decision 74).
5. **billing-implementacao.md:** errata note — `billing:close` → `billing-close` target names; series section predates decision 97.
6. **Postman:** C-9 items.
7. **example.env / compose (code):** decision 78's external-LangWatch path is currently impossible — all `LANGWATCH_*` forwarding lives inside `compose.connector.yml`, the file decision 78 says to drop. Either forward the vars from a generic path or amend decision 78 to "write a sibling connector file for the external stack". Also: remove or fix `MONGO_DB_ATLAS` (C-8) and document `API_BIND`/`LANGWATCH_BIND` if A-2 is approved.

---

## 6. Test plan (consolidated)

**Suite state:** 50 suites / 342 tests, all green, ~17s, stable. Well-above-average: the CLAUDE.md invariants are mostly *executable* (independent plain-JS recomputation of billing ≡ Σ stamps; snapshot reproducibility byte-for-byte, twice, including through real BSON round-trip; byte-identical stamps after price change; contract suites against the ports). The gaps cluster precisely on the newest perimeter.

### T-1 · HIGH — `npm run test:ci` is broken (must fix before anything else lands)
`ENOENT globalConfig.json`, 25–49 suites failing nondeterministically — specifically the `@shelf/jest-mongodb@6` preset + `--collectCoverage=true` under Jest 30 (plain `npm test` green; unit-only coverage green). Coverage thresholds are currently unenforceable; any CI wired to `test:ci` is red or absent. **Fix:** drop the preset in favor of explicit `globalSetup`/`globalTeardown` scripts using `mongodb-memory-server` directly (same replica-set config as `jest-mongodb-config.js`); also de-conflict the contradictory `--collectCoverage` flags in the script chain.

### New tests, in implementation order (each tied to its finding)
- **M1 (B-1):** post-close arrival quarantined — unit (`sync-traces-use-case.spec.ts`: closed 2026-06 + June trace → `report.quarantined === 1`, doc flagged, `updateAttribution` NOT called on quarantined skip; July trace in same run not flagged) + integration (`sync-traces-pipeline.test.ts`: sync → close → late trace → summary total unchanged, `quarantined_trace_count === 1`, June days still sum to the frozen bill). Then the full lifecycle: quarantine → reopen → re-close → `Σ dailyRollup ≡ v2 total`, `countQuarantined === 0`.
- **M2 (B-1/reprocess):** new `reprocess-pending-use-case.spec.ts` (file doesn't exist): closed-month guard (`{examined: 2, stamped: 1, blockedClosedMonth: 1}` — today only ever asserted `0`, i.e. never firing); per-trace `failed` isolation; concurrent-`skipped` counts as stamped.
- **M3 (A-4/C):** new `export-statement-controller.spec.ts` (0% today over ~252 lines): PARCIAL watermark present for `in_progress` (HTML span + CSV marker) and absent for closed — a named acceptance criterion with zero coverage; CSV structure/BOM/Content-Disposition (`-PARCIAL` filename suffix); hostile agent/model names (`=cmd(),x`, `<script>`, `;`, `"`, `\r\n`) for both escapers; `format=banana` → 400.
- **M4:** `/billing/series` + `/billing/projection` over HTTP (zero response-level tests today): series June total ≡ summary June total (**the series↔statement one-truth check — currently no test compares the two summation paths**); Σ day buckets ≡ month total; `?months=abc`/`?days=0` → 400; add series/projection/statement to the strict docs-contract parsing in `docs-routes.test.ts`.
- **M5:** migration 015 rewrite proof (the only data-rewriting migration, 0%): legacy string + structured + null model docs → run twice → correct rewrite, stamps byte-identical, second run modifies zero docs.
- **M6:** repo-level `pendingPriceSummary` + `listBills` (the two untested methods of the invariant-3 repository); pin quarantined-pending semantics.
- **M7 (B-3):** poison/oversized trace does not block the batch; truncation path stores flagged trace.
- **M8 (B-2/B-5/B-6):** crash-between-snapshot-and-flip → retry succeeds and reproduces; concurrent double close preserves usage-collection integrity; `stampPendingTrace` vs concurrent model correction (contract suite); two-writer session recompute.
- **Auth/HTTP:** overflow + zero price → 400; app-level test that auth mounts for `/api/v1/*` while docs stay open; TZ-pinned datetime test (B-8).
- **Hygiene (from the audit of the tests themselves):** add the three billing collections to `route-db-harness.resetAndMigrate` (cross-suite leakage today is prevented only by accidental ordering); move `billing-routes.test.ts`'s fixture restore from the demo-step-7 test *body* into `afterEach`; break the two order-dependent test couplings (pending-APART before demo-7; 409 depending on the previous test's insert).

---

## 7. Open questions for Matheus (decisions I did not make for you)

- **Q1 — B-1 semantics:** I spec'd "the snapshot adjudicates" (absorb-at-close, historical mark kept). The alternative — clear the flag entirely at close — is simpler but loses the audit trail the model doc promises. Confirm absorb-at-close?
- **Q2 — B-7:** lowercase model ids at the canonicalization point (+ backfill migration)? Only say no if case-sensitive model ids are a real thing for some provider you care about.
- **Q3 — B-4 residual:** when a `skipped` re-sync reveals the source now has *more* tokens than we stamped (trace resumed after the quiet period), today we silently keep the smaller stamp. Spec'd: log + metric only. Should divergence ever re-open a *pending* trace's counts? (A *stamped* trace is untouchable — invariant 1.)
- **Q4 — A-2:** loopback-by-default breaks anyone currently reaching the API/LangWatch over LAN without a firewall. OK to flip the default and document `*_BIND` overrides?
- **Q5 — C-4.4:** keep `openapi.json` open under auth (healthcheck + docs) or gate it and add a dedicated tokenless `/health` (which A-5.2 would then use)?
- **Q6 — UI auth:** minimal 401 message now; the real flow (nginx service-token injection vs session login) is a design decision — which direction, and when?
- **Q7 — C-8:** fix `MONGO_DB_ATLAS` or delete the Atlas branch outright?
- **Q8 — B-3 truncation:** confirm that truncating span *content* at ~15MB (with an explicit flag, tokens/costs unaffected) is an acceptable reading of invariant 6's "store everything" — the alternative is a spans-in-separate-collection redesign, which is a much bigger change.

## 8. Verified clean (do not "fix")

- **Layering:** zero violations, enforced by `architecture-boundaries.spec.ts`; Mongo/Express/vendor types fully contained; no `any` in production; 12 `as unknown as` all at the storage boundary; no TODO/FIXME anywhere; no commented-out or unreferenced code.
- **Money:** integer µ¢ + BigInt end-to-end; no floats/`toFixed`/`parseFloat` in billing production paths; strings on the wire (JSON float → 400, tested); half-up + largest-remainder reconciliation correct and closure-tested (the P1/P3 items are extreme-magnitude edges, not present-scale bugs).
- **Invariants:** all 10 traced to enforcing code; 8 of 10 also have automated checks (single-tenant and store-everything are enforced by construction). The mandatory consistency check, both reproducibility tests, byte-identical stamp immutability, and idempotent re-sync all exist and are strong.
- **Idempotency & races that ARE handled:** unique traceId + E11000→skipped + transactional counter (decision 81 verified); watermark CAS monotonic under all interleavings (both directions tested); `markClosed`/`markReopened` guarded updates race-correct; price 409 race-safe via unique index; as-of stamping correct on all three paths (ingest/re-sync/reprocess price by the TRACE's date — integration-proven); `updateAttribution` structurally cannot touch stamps.
- **HTTP:** no NoSQL injection path; uniform `{name,msg}` error surface (exact-shape tested); pagination + 10k-horizon hardening consistent end-to-end; date hygiene on list endpoints; invariant 4 enforced three independent ways (whitelist view-models, forbidden-key regex over responses *and* the OpenAPI doc, strict response schemas that generate the docs).
- **Ops/UI:** all unmasked LLM content HTML-escaped in every UI sink; zero client-side money math; same-origin proxy; `.dockerignore` keeps secrets/fixtures out of images; SCRUB list currently complete; deploy scripts idempotent; mongo posture correct (no prod host port, dev loopback, replica init once); dependency hygiene clean.
- **QA discipline:** QA19 flagged at every dependent site including the load-bearing `startedAt` choice in the ingestor; QA14 comments correctly mark findings (one stale comment → D-3).

## 9. Suggested approval workflow

Reply with finding IDs to approve/veto (e.g. "approve all P0+P1 except B-7; Q1=yes, Q2=yes, Q4=no"). Anything approved gets implemented in the batch order above — P0 first (small, independent diffs), then T-1 (so CI guards the rest), then B-1+B-2 together (shared mechanism), then the rest of P1 → P2 → P3 → P4. Every invariant-adjacent change lands with its §6 test and, where flagged, its decision-log entry. Nothing here has been implemented yet.
