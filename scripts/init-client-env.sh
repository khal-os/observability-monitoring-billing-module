#!/usr/bin/env bash
#
# STEP 1 — env: materialize clients/<name>.env (the client's whole contract
# and deployment state). Creates it once — secrets minted here, ports
# auto-allocated skipping other clients and live listeners — and NEVER
# regenerates secrets on re-run. Idempotent extras that do apply to an
# existing file: --langwatch-key and --env overrides.
#
#   ./scripts/init-client-env.sh <name> [options]
#
#   --api-port N          host port for the API        (default: first free from 3001)
#   --langwatch-port N    host port for LangWatch      (default: first free from 5561)
#   --ui-port N           host port for the client UI  (default: first free from 8081)
#   --mongo-host-port N   dev-only Compass port        (default: first free from 27018)
#   --mongo-user U        enable mongo auth (with --mongo-pass; BEFORE first boot)
#   --mongo-pass P
#   --langwatch-key KEY   LangWatch project API key (can be applied later by re-running)
#   --image REF           API image reference          (default: platform-api:local)
#   --env KEY=VALUE       set/override ANY contract var (repeatable) — e.g.
#                         --env SYNC_QUIET_PERIOD_SECONDS=60 --env SYNC_BATCH_SIZE=200
#                         (see clients/example.env for the full contract)

cd "$(dirname "$0")/.."
source scripts/deploy-lib.sh

require_name "${1:-}"; shift || true

API_PORT="" LANGWATCH_PORT="" UI_PORT="" MONGO_HOST_PORT="" MONGO_USER="" MONGO_PASS=""
LANGWATCH_KEY="" IMAGE="platform-api:local"
declare -a ENV_OVERRIDES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-port)        API_PORT="$2"; shift 2 ;;
    --langwatch-port)  LANGWATCH_PORT="$2"; shift 2 ;;
    --ui-port)         UI_PORT="$2"; shift 2 ;;
    --mongo-host-port) MONGO_HOST_PORT="$2"; shift 2 ;;
    --mongo-user)      MONGO_USER="$2"; shift 2 ;;
    --mongo-pass)      MONGO_PASS="$2"; shift 2 ;;
    --langwatch-key)   LANGWATCH_KEY="$2"; shift 2 ;;
    --image)           IMAGE="$2"; shift 2 ;;
    --env)             [[ "$2" =~ ^[A-Z_]+=.*$ ]] || die "--env espera KEY=VALUE: '$2'"
                       ENV_OVERRIDES+=("$2"); shift 2 ;;
    *) die "opção desconhecida: $1" ;;
  esac
done

[[ -z "$MONGO_USER" || -n "$MONGO_PASS" ]] || die "--mongo-user exige --mongo-pass"

# ---------- port allocation (skip ports used by env files or listeners) ----------
used_ports() {
  grep -hoE '^(API_PORT|LANGWATCH_PORT|UI_PORT|MONGO_HOST_PORT)=[0-9]+' clients/*.env 2>/dev/null | grep -oE '[0-9]+$'
  ss -ltnH 2>/dev/null | awk '{print $4}' | grep -oE '[0-9]+$'
}

next_free() {
  local port=$1
  local used; used="$(used_ports)"
  while grep -qx "$port" <<< "$used"; do port=$((port + 1)); done
  echo "$port"
}

# ---------- env file (create once; never regenerate secrets) ----------
if [[ -f "$ENVFILE" ]]; then
  step "env: reaproveitando ${ENVFILE} (idempotente)"
else
  API_PORT="${API_PORT:-$(next_free 3001)}"
  LANGWATCH_PORT="${LANGWATCH_PORT:-$(next_free 5561)}"
  UI_PORT="${UI_PORT:-$(next_free 8081)}"
  MONGO_HOST_PORT="${MONGO_HOST_PORT:-$(next_free 27018)}"
  step "env: criando ${ENVFILE}"
  info "portas: api ${API_PORT} · ui ${UI_PORT} · langwatch ${LANGWATCH_PORT} · mongo-dev ${MONGO_HOST_PORT}"
  cat > "$ENVFILE" << EOF
# Gerado por init-client-env.sh em $(date -u +%FT%TZ) — contrato: clients/example.env
COMPOSE_PROJECT_NAME=${NAME}
CLIENT_NAME=${NAME}

API_PORT=${API_PORT}
LANGWATCH_PORT=${LANGWATCH_PORT}
UI_PORT=${UI_PORT}

MONGO_DB_USER=${MONGO_USER}
MONGO_DB_PASSWORD=${MONGO_PASS}

LANGWATCH_API_KEY=${LANGWATCH_KEY}

LW_NEXTAUTH_SECRET=$(openssl rand -base64 32)
LW_API_TOKEN_JWT_SECRET=$(openssl rand -base64 32)
LW_CREDENTIALS_SECRET=$(openssl rand -base64 32)

API_IMAGE=${IMAGE}

# Dev-only: host port for Compass/mongosh (compose.dev.yml, localhost-bound)
MONGO_HOST_PORT=${MONGO_HOST_PORT}
EOF
fi

# Apply --langwatch-key to an existing deployment (the idempotent second run).
if [[ -n "$LANGWATCH_KEY" ]]; then
  sed -i "s|^LANGWATCH_API_KEY=.*|LANGWATCH_API_KEY=${LANGWATCH_KEY}|" "$ENVFILE"
  step "LANGWATCH_API_KEY aplicado em ${ENVFILE}"
fi

# Apply --env overrides: replace the var's line if present, append otherwise.
for override in "${ENV_OVERRIDES[@]}"; do
  key="${override%%=*}"
  if grep -q "^${key}=" "$ENVFILE"; then
    sed -i "s|^${key}=.*|${override}|" "$ENVFILE"
  else
    printf '%s\n' "$override" >> "$ENVFILE"
  fi
  step "env: ${override}"
done
