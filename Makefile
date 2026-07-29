# Single-tenant operations. The Makefile knows NO client: every target takes
# CLIENT=<name>, which selects clients/<name>.env (the env contract —
# see clients/example.env). Deploying a new client = writing its env file.
#
#   make build                                  # build the API image locally
#   make up CLIENT=hapvida                      # dev form (build block + demo fixtures)
#   make up-prod CLIENT=hapvida                 # production form (image ref only)
#   make migrate CLIENT=hapvida
#   make seed-prices CLIENT=hapvida             # DEV ONLY: PoC demo price table
#   make sync CLIENT=claro FROM=2026-07-01 TO=2026-07-22
#   make price CLIENT=vivo ARGS='--model ... --token-type ... --price-brl ... --effective-from ...'
#   make logs CLIENT=vivo
#   make down CLIENT=claro                      # stop one client (volumes preserved)
#   make ps                                     # all compose projects on this host
#
# Continuous ingestion: once LANGWATCH_API_KEY is set in the client env,
# the trace-ingestion-worker sidecar (part of the stack) syncs
# automatically via direct ClickHouse reads — no window cap. `make sync`
# remains for manual backfills and fixture-backed demos.
#
# Keep MANUAL sync windows under ~100 traces ONLY on the HTTP path (QA14:
# LangWatch search ignores pageOffset — a bigger window silently caps at
# the newest 100). The ClickHouse path has no such cap.

.DEFAULT_GOAL := help

ENVFILE = clients/$(CLIENT).env
# `env -u`: compose interpolation ranks the OS environment ABOVE --env-file,
# so an exported LANGWATCH_API_KEY (e.g. from seeding a LangWatch instance)
# would leak into every stack — and an exported COMPOSE_PROJECT_NAME would
# collapse two clients into one project. The env file is the only source of
# truth for these.
# EVERY variable a compose file interpolates must be listed here — a var
# that escapes the scrub silently overrides all client env files at once.
SCRUB = env -u COMPOSE_PROJECT_NAME -u CLIENT_NAME -u API_PORT \
          -u LANGWATCH_PORT -u LANGWATCH_API_KEY -u LANGWATCH_ENDPOINT \
          -u LANGWATCH_PROJECT_ID \
          -u MONGO_DB_HOST -u MONGO_DB_PORT -u MONGO_MEMORY_LIMIT \
          -u MONGO_DB_USER -u MONGO_DB_PASSWORD -u MONGO_HOST_PORT \
          -u API_IMAGE -u UI_IMAGE -u UI_PORT \
          -u LW_NEXTAUTH_SECRET -u LW_API_TOKEN_JWT_SECRET -u LW_CREDENTIALS_SECRET \
          -u TRACE_INGESTION_INTERVAL_SECONDS -u TRACE_INGESTION_BATCH_SIZE \
          -u TRACE_INGESTION_QUIET_PERIOD_SECONDS -u REPROCESS_INTERVAL_SECONDS \
          -u LANGWATCH_WORKERS_REPLICAS -u LANGWATCH_MEMORY_LIMIT \
          -u LANGWATCH_WORKERS_MEMORY_LIMIT -u LW_POSTGRES_MEMORY_LIMIT \
          -u LW_REDIS_MEMORY_LIMIT -u LW_CLICKHOUSE_MEMORY_LIMIT \
          -u LW_CLICKHOUSE_CPU_LIMIT
# Role files (decision 65): module (api+ui) + connector (LangWatch +
# trace-ingestion-worker) + database (mongo) merge into ONE project per
# client. Couplings live in the file that introduces them, so dropping a
# role (e.g. external mongo) is a change of THIS list + the client env.
COMPOSE_FILES = -f compose.module.yml -f compose.connector.yml -f compose.mongodb.yml
COMPOSE_PROD = $(SCRUB) docker compose $(COMPOSE_FILES) --env-file $(ENVFILE)
COMPOSE_DEV  = $(SCRUB) docker compose $(COMPOSE_FILES) -f compose.dev.yml --env-file $(ENVFILE)
# One-off jobs run in the PROD form — none of them read demo fixtures, and
# the dev overlay would auto-create a root-owned demo-data/<client> dir.
# --no-deps: without it, `run` reconciles the mongo service against THIS
# form's config and recreates a dev-form mongo (dropping its Compass port).
# Jobs therefore require the stack to be up (`make up` first).
JOB = $(COMPOSE_PROD) run --rm --no-deps api node
# sync is the exception: the fixture-backed fake client (empty
# LANGWATCH_API_KEY) needs this client's demo fixtures mounted — use the dev
# form exactly when generated fixtures exist, the prod form otherwise.
SYNC_COMPOSE = $(if $(wildcard demo-data/$(CLIENT)/*.json),$(COMPOSE_DEV),$(COMPOSE_PROD))

.PHONY: help build up up-prod down logs ps migrate seed-prices sync price reprocess rebuild-filter-counters rebuild-session-summaries require-client

help:
	@grep -E '^#( |$$)' Makefile | sed 's/^# \?//'

require-client:
	@test "$(origin CLIENT)" = "command line" || { echo "pass CLIENT=<name> explicitly on the make command line (env file: clients/<name>.env)"; exit 1; }
	@test -f "$(ENVFILE)" || { echo "missing $(ENVFILE) — copy clients/example.env and fill it in"; exit 1; }

build:
	docker build -f docker/api.Dockerfile -t platform-api:local .
	docker build -f docker/ui.Dockerfile -t platform-ui:local .

# --remove-orphans: a renamed service (e.g. sync-worker →
# trace-ingestion-worker) would otherwise leave the old container running
# alongside the new one — two ingestors racing the same watermark cursor.
# All containers of a project come from the role files, so orphans are
# always leftovers, never wanted.
up: require-client
	@mkdir -p demo-data/$(CLIENT) # user-owned before docker can root-create it via the bind mount
	$(COMPOSE_DEV) up -d --remove-orphans

up-prod: require-client
	$(COMPOSE_PROD) up -d --remove-orphans

# --remove-orphans on the way DOWN too: after a service rename, plain
# `down` would leave the old container running — a second ingestor.
down: require-client
	$(COMPOSE_PROD) down --remove-orphans

logs: require-client
	$(COMPOSE_PROD) logs -f

ps:
	@docker compose ls

# ---- one-off jobs ----

migrate: require-client
	$(JOB) dist/main/jobs/run-migrations.js

# DEV ONLY (decision 74): seeds the PoC demo price table (formerly migration
# 002). Gated on the same dev discriminator as `make sync` (demo-data/
# fixtures present) — prod prices are registered exclusively via `make price`
# (invariant 9).
seed-prices: require-client
	@test -n "$(wildcard demo-data/$(CLIENT)/*.json)" || { echo "seed-prices é DEV ONLY — '$(CLIENT)' não tem demo-data/ (preços de produção: make price)"; exit 1; }
	$(JOB) dist/main/jobs/seed-poc-prices.js

sync: require-client
	@test -n "$(FROM)" -a -n "$(TO)" || { echo "usage: make sync CLIENT=<name> FROM=YYYY-MM-DD TO=YYYY-MM-DD"; exit 1; }
	$(SYNC_COMPOSE) run --rm --no-deps api node dist/main/jobs/run-sync.js --from $(FROM) --to $(TO)

price: require-client
	@test -n "$(ARGS)" || { echo "usage: make price CLIENT=<name> ARGS='--model ... --token-type ... --price-brl ... --effective-from ...'"; exit 1; }
	$(JOB) dist/main/jobs/insert-price-version.js $(ARGS)

reprocess: require-client
	$(JOB) dist/main/jobs/reprocess-pending.js

# Recompute the facet cube (decision 77) from the traces collection —
# one-time after restoring pre-existing data; anytime to repair drift.
rebuild-filter-counters: require-client
	$(JOB) dist/main/jobs/rebuild-filter-counters.js

# Recompute the sessions read-model (decision 80) from the traces
# collection — one-time after restoring pre-existing data; ingestion
# maintains it by recompute-on-touch from then on.
rebuild-session-summaries: require-client
	$(JOB) dist/main/jobs/rebuild-session-summaries.js
