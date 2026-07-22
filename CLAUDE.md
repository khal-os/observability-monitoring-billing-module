# CLAUDE.md — AI Agent Platform (Traces · Sessions · Billing)

This repo implements the **PoC of the platform API**: one API, three faces —
**Billing** (what it cost), **Traces** (the real executions behind it),
**Sessions** (the conversations those executions belong to). Data source:
**LangWatch** (the connector between the agents and this platform).

Full product context lives in `docs/produto/` — treat those files as the
source of truth for scope, acceptance criteria, decisions, and open questions:

- `docs/produto/backlog-v2.3.md` — the whole backlog (épicos, tech stories
  T1–T11, user stories, critérios de pronto, adiados, log de decisões, QAs)
- `docs/produto/poc.md` — exactly what this PoC builds, in what order, and
  what "demo done" means
- `docs/produto/kickoff-prompt.md` — the first-task prompt (already consumed
  if you are reading this mid-project)

## Architecture in one line

LangWatch API → trace-level sync → **price stamping at write time** (each
trace is stored already priced) → own permanent store (traces + spans + full
content) → live views (traces/sessions) + monthly aggregates (billing).

## Invariants — never violate these

1. **Price is stamped at ingestion and is immutable.** The stamp uses the
   price version **effective on the trace's date** (as-of at write time —
   pending confirmation, QA19). A later price change NEVER re-prices a stored
   trace; it only affects traces ingested afterward.
2. **A trace with no applicable price is stored as `pending_price`** — tokens
   kept, cost open, excluded from R$ totals. It is NEVER valued at R$ 0.00.
   When the price is registered (open month only), pending traces get stamped.
3. **One store, one truth.** Billing aggregates are **sums of stamped trace
   costs** — never an independent calculation path. Session cost = exact sum
   of its traces' costs. An automated consistency check may assert
   `billing aggregate ≡ Σ stamped costs` for open periods; divergence is a
   defect, not a footnote.
4. **Client-facing data is R$ only.** US$, PTAX, markup, and internal cost
   fields must not exist in client-facing projection schemas — absent by
   construction, not hidden by the UI.
5. **Single-tenant.** One client per deployment. No tenant keys in the domain
   model. `domain`/`subdomain` are plain optional strings on traces.
6. **Store everything.** Traces, spans, and full input/output content
   (unmasked — logged decision). LangWatch retains only ~49 days, so this
   store is the permanent archive; the sync is data-loss prevention.
7. **Attribution (agent/metadata) is mutable in open periods; the price stamp
   is not.** Corrections re-aggregate, never re-price.
8. **Billing period = calendar month.** Current month is always partial and
   must be labeled so. Month close/snapshot (T6) is OUT of PoC scope.
9. **Prices are versioned data, maintained by direct DB inserts** (no admin
   UI in v1). Versions are immutable — changes are new inserts with
   `effective_from`; the model list is data, not code.
10. **Text-only agents** in v1; every trace carries a `channel` field so voice
    can arrive later without a migration.

## PoC scope (see docs/produto/poc.md for details)

IN: T4 price table (seeded) · T2-lite sync worker against a **fake LangWatch
client** (interface + fixtures shaped like the real API; real client is a
later swap — QA14 spike) · T5 stamping · T3 store (traces/spans/content) ·
endpoints `GET /traces`, `GET /traces/:id`, `GET /sessions`,
`GET /sessions/:id` (session = derived read-model grouped by `session_id`) ·
one billing aggregate endpoint (month × agent × model) that visibly equals
the sum of stamped costs.

OUT: month close/snapshot, exports, trends/projection, RBAC/auth, voice,
masking/retention, admin UIs, alerts.

## Working agreements

- Follow the boilerplate's existing conventions (structure, naming, error
  handling, testing style) — do not introduce a parallel style.
- Money: integer cents (or decimal type) — never floats. Full precision at
  line level; round only displayed totals (half-up, 2 decimals).
- Ingestion must be idempotent: re-running a sync window never double-counts.
- When a decision is made during implementation, append it to the decision
  log in `docs/produto/backlog-v2.3.md` instead of leaving it implicit.
- Open questions (QA1–QA19) are listed at the end of the backlog doc; QA14
  (LangWatch API fidelity) and QA19 (stamp rule) are the two that most affect
  this code — flag any code path that depends on their answers with a
  `// QA14:` / `// QA19:` comment.
