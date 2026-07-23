#!/usr/bin/env bash
#
# ============================================================================
# LOCAL/DEV TOOL ONLY — NEVER RUN IN PRODUCTION.
# Production deploys apply the compose role files (module+langwatch+mongodb)
# with an env file materialized from the CI/secret store (see README). This
# script exists to spin up DEMO clients on a workstation: it self-onboards
# LangWatch, mints secrets locally and injects fake traffic — all things a
# production deploy must not do.
# ============================================================================
#
# Thin orchestrator over the step scripts in scripts/ — each step is
# idempotent and independently re-runnable (run one directly to redo just
# that step):
#
#   1. scripts/init-client-env.sh        env file (secrets, ports, --env overrides)
#   2. scripts/provision-client-stack.sh images + stack + health + migrations
#   3. scripts/onboard-langwatch.sh      admin/org/project/API key -> sync live
#   4. scripts/seed-demo-data.sh         demo prices and/or demo traffic
#   5. scripts/verify-client.sh          health + totals + operator summary
#
#   ./deploy-demo-client.sh <name> [options]
#
#   --api-port N          host port for the API        (default: first free from 3001)
#   --langwatch-port N    host port for LangWatch      (default: first free from 5561)
#   --ui-port N           host port for the client UI  (default: first free from 8081)
#   --mongo-host-port N   dev-only Compass port        (default: first free from 27018)
#   --mongo-user U        enable mongo auth (with --mongo-pass; BEFORE first boot)
#   --mongo-pass P
#   --langwatch-key KEY   LangWatch project API key (from onboarding; can be
#                         applied later by re-running with this flag)
#   --image REF           API image reference          (default: platform-api:local)
#   --env KEY=VALUE       set/override ANY contract var (repeatable) — e.g.
#                         --env SYNC_QUIET_PERIOD_SECONDS=60
#   --demo-traces         push demo traces into LangWatch (default)
#   --no-demo-traces      skip the demo traces only — LangWatch still boots
#                         and is fully onboarded (admin, org, project, API
#                         key wired, real sync enabled)
#   --demo-prices         register the premium demo model's prices (default)
#   --no-demo-prices      skip price registration — traces then land as
#                         pending_price until prices are registered
#                         (make price) and reprocessed (price:insert also
#                         reprocesses; the sync-worker sweeps hourly)
#
# Ingestion is continuous (sync-worker): pushed demo traces enter the
# platform after the ~15-min quiet period; `make sync` remains for
# instant manual backfills.

set -euo pipefail
cd "$(dirname "$0")"

NAME="${1:-}"; shift || true

declare -a INIT_ARGS=()
declare -a SEED_FLAGS=()
DEMO_TRACES=1 DEMO_PRICES=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-port|--langwatch-port|--ui-port|--mongo-host-port|--mongo-user|--mongo-pass|--langwatch-key|--image|--env)
      INIT_ARGS+=("$1" "$2"); shift 2 ;;
    --demo-traces)     DEMO_TRACES=1; shift ;;
    --no-demo-traces)  DEMO_TRACES=0; shift ;;
    --demo-prices)     DEMO_PRICES=1; shift ;;
    --no-demo-prices)  DEMO_PRICES=0; shift ;;
    *) printf '✖ ERRO: opção desconhecida: %s\n' "$1" >&2; exit 1 ;;
  esac
done

# Demo default: 1-min quiet period so pushed traffic ingests fast (prod
# default is 900s — decision 61). Creation-time only (never clobbers an
# existing env), and an explicit --env SYNC_QUIET_PERIOD_SECONDS=... in
# INIT_ARGS is applied later, so it wins.
[[ -f "clients/${NAME}.env" ]] || INIT_ARGS=(--env SYNC_QUIET_PERIOD_SECONDS=60 "${INIT_ARGS[@]}")

./scripts/init-client-env.sh "$NAME" "${INIT_ARGS[@]}"
./scripts/provision-client-stack.sh "$NAME"
./scripts/onboard-langwatch.sh "$NAME"

[[ "$DEMO_PRICES" -eq 1 ]] && SEED_FLAGS+=(--prices)
[[ "$DEMO_TRACES" -eq 1 ]] && SEED_FLAGS+=(--traces)
if [[ ${#SEED_FLAGS[@]} -gt 0 ]]; then
  ./scripts/seed-demo-data.sh "$NAME" "${SEED_FLAGS[@]}"
else
  printf '▸ demo: preços e traces pulados (--no-demo-prices --no-demo-traces)\n'
fi

./scripts/verify-client.sh "$NAME"
