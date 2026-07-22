# Single-tenant operations. The Makefile knows NO client: every target takes
# CLIENT=<name>, which selects clients/<name>.env (the env contract —
# see clients/example.env). Deploying a new client = writing its env file.
#
#   make build                                  # build the API image locally
#   make up CLIENT=hapvida                      # dev form (build block + demo fixtures)
#   make up-prod CLIENT=hapvida                 # production form (image ref only)
#   make migrate CLIENT=hapvida
#   make sync CLIENT=claro FROM=2026-07-01 TO=2026-07-22
#   make price CLIENT=vivo ARGS='--model ... --token-type ... --price-brl ... --effective-from ...'
#   make logs CLIENT=vivo
#   make down CLIENT=claro                      # stop one client (volumes preserved)
#   make ps                                     # all compose projects on this host
#
# Keep sync windows under ~100 traces (QA14: LangWatch search ignores
# pageOffset — a bigger window silently caps at the newest 100).

.DEFAULT_GOAL := help

ENVFILE = clients/$(CLIENT).env
# `env -u`: compose interpolation ranks the OS environment ABOVE --env-file,
# so an exported LANGWATCH_API_KEY (e.g. from seeding a LangWatch instance)
# would leak into every stack — and an exported COMPOSE_PROJECT_NAME would
# collapse two clients into one project. The env file is the only source of
# truth for these.
SCRUB = env -u COMPOSE_PROJECT_NAME -u CLIENT_NAME -u API_PORT \
          -u LANGWATCH_PORT -u LANGWATCH_API_KEY -u LANGWATCH_ENDPOINT \
          -u MONGO_DB_USER -u MONGO_DB_PASSWORD -u API_IMAGE \
          -u LW_NEXTAUTH_SECRET -u LW_API_TOKEN_JWT_SECRET -u LW_CREDENTIALS_SECRET
COMPOSE_PROD = $(SCRUB) docker compose -f compose.client.yml --env-file $(ENVFILE)
COMPOSE_DEV  = $(SCRUB) docker compose -f compose.client.yml -f compose.dev.yml --env-file $(ENVFILE)
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

.PHONY: help build up up-prod down logs ps migrate sync price reprocess require-client

help:
	@grep -E '^#( |$$)' Makefile | sed 's/^# \?//'

require-client:
	@test "$(origin CLIENT)" = "command line" || { echo "pass CLIENT=<name> explicitly on the make command line (env file: clients/<name>.env)"; exit 1; }
	@test -f "$(ENVFILE)" || { echo "missing $(ENVFILE) — copy clients/example.env and fill it in"; exit 1; }

build:
	docker build -f docker/api.Dockerfile -t platform-api:local .
	docker build -f docker/ui.Dockerfile -t platform-ui:local .

up: require-client
	@mkdir -p demo-data/$(CLIENT) # user-owned before docker can root-create it via the bind mount
	$(COMPOSE_DEV) up -d

up-prod: require-client
	$(COMPOSE_PROD) up -d

down: require-client
	$(COMPOSE_PROD) down

logs: require-client
	$(COMPOSE_PROD) logs -f

ps:
	@docker compose ls

# ---- one-off jobs ----

migrate: require-client
	$(JOB) dist/main/jobs/run-migrations.js

sync: require-client
	@test -n "$(FROM)" -a -n "$(TO)" || { echo "usage: make sync CLIENT=<name> FROM=YYYY-MM-DD TO=YYYY-MM-DD"; exit 1; }
	$(SYNC_COMPOSE) run --rm --no-deps api node dist/main/jobs/run-sync.js --from $(FROM) --to $(TO)

price: require-client
	@test -n "$(ARGS)" || { echo "usage: make price CLIENT=<name> ARGS='--model ... --token-type ... --price-brl ... --effective-from ...'"; exit 1; }
	$(JOB) dist/main/jobs/insert-price-version.js $(ARGS)

reprocess: require-client
	$(JOB) dist/main/jobs/reprocess-pending.js
