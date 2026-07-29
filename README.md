# AI Agent Platform — PoC (Traces · Sessions · Billing)

One API, three faces — **Billing** (what it cost), **Traces** (the real
executions behind it), **Sessions** (the conversations those executions belong
to). Data source: **LangWatch**. Product context, scope, and the decision log
live in [docs/produto/](docs/produto/) (see `CLAUDE.md` for the invariants).

## Deployment model (single-tenant by construction)

**One client = one compose project, fully self-contained.** The same
the compose role files ([module](compose.module.yml) + [langwatch](compose.connector.yml) + [mongodb](compose.mongodb.yml)) are applied once per client with that
client's env file — nothing in the images, the compose file, or the
application knows any client:

```
one client deployment (9 containers, own network, own volumes):
┌──────────────────────────────────────────────────────────────┐
│ ui (:UI_PORT) ──► api (:API_PORT) ──────► mongo (own volume) │
│  nginx, proxies                              ▲               │
│  /api same-origin   trace-ingestion-worker ─────────────┘               │
│                      │  continuous ingestion: watermark loop,│
│                      │  price-stamp at write (decisions 59-63)│
│                      ▼                                       │
│ langwatch (:LANGWATCH_PORT) ── workers                       │
│   ├─ postgres   ├─ redis   └─ clickhouse ◄── (direct read)   │
└──────────────────────────────────────────────────────────────┘
```

Ingestion is **continuous and automatic**: once the client is onboarded
(`LANGWATCH_API_KEY` set), the `trace-ingestion-worker` sidecar reads new traces
straight from the LangWatch stack's ClickHouse (no API caps), stamps
prices at write time, and stays ~15–16 min behind live (15-min quiet
period so incrementally-built traces settle before their immutable price
stamp — `TRACE_INGESTION_*` knobs in the env contract). Before onboarding the
worker idles and `make sync` over fixtures is the demo path.

The env file is the whole contract and the client's **deployment state** —
identity, ports, mongo credentials, LangWatch key + per-instance secrets,
image pin. [clients/example.env](clients/example.env) is the committed
template; real files are gitignored and treated as the single source of
truth for every operation (lose one and you lose the stack's operational
identity — the LangWatch admin password is only recorded there).
**Back up `clients/*.env` somewhere durable after each deploy** — until a
CI/secret store owns these values, the files are the only copy. In CI, the
pipeline holds the same keys as protected variables and writes the env file
(or exports the vars) before running the same compose command.

## Deploying a demo client (dev tool — NEVER in production)

```bash
./deploy-demo-client.sh <name>
```

One idempotent command does everything: env file with generated secrets and
auto-allocated free ports → images (built if missing) → 9-container stack →
health waits → migrations → **automatic LangWatch onboarding** (registers
`admin@<name>.com` with a random password — printed in the summary and noted
in the env file — creates organization + project via the instance's own API,
wires the project API key into the env, recreates the api with real sync
enabled) → **demo data** (deterministic traffic generated for this client,
PoC price table via `make seed-prices` + premium-model prices, pushed into
its LangWatch, ingested through the real
sync — every trace priced between R$ 1 and R$ 100). The summary prints the
UI, API, LangWatch and Compass URLs plus the login credentials.

Options: `--api-port/--ui-port/--langwatch-port/--mongo-host-port` to pin
ports, `--mongo-user/--mongo-pass` for an auth-enabled mongo (before first
boot), `--image REF` to pin the api image, `--langwatch-key` to wire a
manually created key. Re-running completes/updates a deployment — secrets
are never regenerated, data is never duplicated.

## Production deployment

The script above is a workstation tool (it mints secrets locally,
self-onboards LangWatch and injects fake traffic). A production deploy is
the raw contract, driven by CI: materialize the client's env file from the
protected variable store, then apply the production form —

```bash
docker compose -f compose.module.yml -f compose.connector.yml -f compose.mongodb.yml --env-file <client>.env up -d
```

(no `compose.dev.yml`, prebuilt registry images via `API_IMAGE`/`UI_IMAGE`).
`make up-prod CLIENT=<name>` rehearses exactly this form locally.

## Day-2 operations (client-generic)

Continuous ingestion runs by itself (the `trace-ingestion-worker` container —
`make logs` shows its batch lines); the commands below are for manual
backfills, price registration, and lifecycle:

```bash
make sync CLIENT=<name> FROM=2026-07-01 TO=2026-07-22   # manual backfill (idempotent windows)
make price CLIENT=<name> ARGS='--model ... --token-type ... --price-brl ... --effective-from ...'
# ...or over HTTP (same single path — canonical model key + immediate reprocess):
#   POST /api/v1/prices  {"model","token_type","price_brl_per_million","effective_from"}
make reprocess CLIENT=<name>   # re-stamp pending traces now (price registration and the worker also do this)
make logs CLIENT=<name>
make up CLIENT=<name>          # re-apply the stack (dev form)
make up-prod CLIENT=<name>     # production form
make down CLIENT=<name>        # stop (volumes preserved)
make ps
```

Full wipe of one client:
`docker compose -f compose.module.yml -f compose.connector.yml -f compose.mongodb.yml --env-file clients/<name>.env down -v`
plus deleting `clients/<name>.env` and `demo-data/<name>/`.

Manual `make sync` uses the direct-ClickHouse source when the client is
onboarded — no window cap. Only the legacy HTTP path (no ClickHouse
configured) still needs windows under ~100 traces (QA14 finding:
LangWatch's search API ignores `pageOffset`, silently capping at the
newest 100).

## LangWatch (per client, inside the deployment)

Each client's stack carries its own LangWatch (pinned
`langwatch/langwatch:3.5.0` + postgres/redis/clickhouse, mirroring the
official upstream compose). Onboarding is automated by the deploy script;
the manual path still works (sign up in the browser, then re-run with
`--langwatch-key`). While the key is empty the sync falls back to the
fixture-backed fake client (offline dev).

LangWatch retains ~49 days and serves span detail per its plan window — the
platform's own store is the permanent archive (invariant 6).

**Expected divergence — LangWatch's "Tokens" card vs the platform's token
totals.** LangWatch's dashboard headline sums `prompt + completion` tokens
only; the platform sums **all four billed token types** (input, output,
cache_read, cache_write), because cache tokens carry contracted R$ prices
and the token number must stay consistent with the R$ number next to it
(invariant 3 is computed over all four). A cache-heavy client can show a
much larger platform total than the LangWatch card — that difference is
exactly the cache traffic, not a sync bug. The fatura statement's per-type
token bars show the breakdown.

## Demo data

Generated per client by the deploy script (gitignored `demo-data/<name>/`):
a deterministic profile seeded from the client name — agents, channels,
sessions, durations, spans, error rate, three models — dated over the last
~12 days and sized so every stamped cost lands in **R$ 1–100**. It flows the
honest pipeline: pushed into the client's LangWatch via the collector API,
then ingested by the real sync with prices stamped at write time.

`node packages/api/scripts/generate-demo-fixtures.mjs` (no args) still
produces the three richer PoC profiles (hapvida/claro/vivo);
`--client <name> [--traces N]` produces any client's generic set.

## Client UI (inside the deployment)

nginx serves `packages/ui` and reverse-proxies `/api` to that client's api
service — same origin, no client selector, no addresses in the UI. The
header shows the deployment's client name via `/client.json`, which nginx
templates from `CLIENT_NAME` at container start (the image stays
client-agnostic).

## Operational notes

- **Mongo**: in-stack, no host port in the production form. Dev form
  publishes `127.0.0.1:<MONGO_HOST_PORT>` for Compass/mongosh
  (`mongodb://localhost:<port>/?directConnection=true`, db = client name).
  Direct access without the port: `docker exec -it <client>-mongo mongosh
  <client>`. Auth is opt-in and must be set before first boot.
- **RAM**: LangWatch is the heavy part (~4–5 GB/client with the configured
  caps). On one dev machine, prefer one or two clients at a time; the first
  boot of a client's LangWatch takes ~1–2 min (its own migrations).
- **Images**: `API_IMAGE`/`UI_IMAGE` pin the platform images per deployment
  (dev default `platform-api:local`/`platform-ui:local`). Only the ROOT
  `package-lock.json` is authoritative; `tsc` always runs in-image because
  the local `dist/` may be stale.
- **LangWatch secrets** (`LW_*`) are per instance; `LW_CREDENTIALS_SECRET`
  must never change after first boot.
