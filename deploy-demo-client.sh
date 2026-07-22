#!/usr/bin/env bash
#
# ============================================================================
# LOCAL/DEV TOOL ONLY — NEVER RUN IN PRODUCTION.
# Production deploys apply compose.client.yml directly with an env file
# materialized from the CI/secret store (see README). This script exists to
# spin up DEMO clients on a workstation: it self-onboards LangWatch, mints
# secrets locally and injects fake traffic — all things a production deploy
# must not do.
# ============================================================================
#
# Deploys ONE single-tenant DEMO client end to end — env file, image, stack,
# health, migrations, LangWatch onboarding AND demo data (deterministic
# traffic pushed into the client's LangWatch and ingested via the real
# sync, every trace priced R$1-100). Idempotent: re-running completes/
# updates a deployment (it never regenerates secrets or duplicates data).
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
#   --demo-traces         push demo traces into LangWatch + sync (default)
#   --no-demo-traces      skip the demo traces only — LangWatch still boots
#                         and is fully onboarded (admin, org, project, API
#                         key wired, real sync enabled); prices are ALWAYS
#                         registered in the client DB regardless of this flag
#
# LangWatch onboarding is AUTOMATIC: the script registers admin@<name>.com
# with a random password (printed in the summary — save it), creates the
# organization and project via the instance's own API, wires the project
# API key into the env file and recreates the api with real sync enabled.
# --langwatch-key remains available to wire a manually-created key instead.

set -euo pipefail
cd "$(dirname "$0")"

# ---------- output helpers (colors only on a terminal) ----------
if [[ -t 1 ]]; then
  B=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; CYN=$'\033[36m'
  YLW=$'\033[33m'; RED=$'\033[31m'; RST=$'\033[0m'
else
  B='' DIM='' GRN='' CYN='' YLW='' RED='' RST=''
fi

step()  { printf '%s\n' "${CYN}▸${RST} ${B}$*${RST}"; }
info()  { printf '%s\n' "  ${DIM}$*${RST}"; }
die()   { printf '%s\n' "${RED}✖ ERRO:${RST} $*" >&2; exit 1; }
LOG="$(mktemp)"
quiet() { "$@" > "$LOG" 2>&1 || { tail -15 "$LOG"; return 1; }; }

# ---------- args ----------
NAME="${1:-}"; shift || true
[[ -n "$NAME" ]] || die "uso: ./deploy-demo-client.sh <name> [options]"
[[ "$NAME" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "nome deve ser um slug ([a-z][a-z0-9-]+): '$NAME'"

API_PORT="" LANGWATCH_PORT="" UI_PORT="" MONGO_HOST_PORT="" MONGO_USER="" MONGO_PASS=""
LANGWATCH_KEY="" IMAGE="platform-api:local" DEMO_TRACES=1

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
    --demo-traces)     DEMO_TRACES=1; shift ;;
    --no-demo-traces)  DEMO_TRACES=0; shift ;;
    *) die "opção desconhecida: $1" ;;
  esac
done

[[ -z "$MONGO_USER" || -n "$MONGO_PASS" ]] || die "--mongo-user exige --mongo-pass"

ENVFILE="clients/${NAME}.env"

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
# Gerado por deploy-demo-client.sh em $(date -u +%FT%TZ) — contrato: clients/example.env
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

get() { grep -oP "(?<=^$1=).*" "$ENVFILE" | head -1; }
API_PORT="$(get API_PORT)"; LANGWATCH_PORT="$(get LANGWATCH_PORT)"; UI_PORT="$(get UI_PORT)"
UI_PORT="${UI_PORT:-8080}"

# ---------- image ----------
docker image inspect "$(get API_IMAGE)" > /dev/null 2>&1 \
  || { step "buildando imagens (api + ui)"; quiet make build || die "build falhou"; }
docker image inspect platform-ui:local > /dev/null 2>&1 \
  || { step "buildando imagem da UI"; quiet docker build -f docker/ui.Dockerfile -t platform-ui:local . || die "build da UI falhou"; }

# ---------- stack ----------
step "subindo a stack (8 contêineres)"
quiet make up "CLIENT=${NAME}" || die "compose up falhou"

# ---------- health: api (implies mongo healthy via depends_on) ----------
printf '%s' "${CYN}▸${RST} ${B}aguardando API${RST}"
for _ in $(seq 1 30); do
  curl -sf -o /dev/null -m 3 "http://localhost:${API_PORT}/api/v1/docs/openapi.json" && break
  echo -n "."; sleep 4
done
curl -sf -o /dev/null -m 3 "http://localhost:${API_PORT}/api/v1/docs/openapi.json" \
  || die "API não respondeu em http://localhost:${API_PORT} — veja: make logs CLIENT=${NAME}"
printf ' %s\n' "${GRN}ok${RST}"

# ---------- migrations (idempotent) ----------
step "rodando migrações"
quiet make migrate "CLIENT=${NAME}" || die "migrações falharam"
info "migrações aplicadas"

# ---------- health: langwatch (first boot runs its own migrations, be patient) ----------
printf '%s' "${CYN}▸${RST} ${B}aguardando LangWatch${RST}"
LW_OK=0
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://localhost:${LANGWATCH_PORT}/" 2>/dev/null || true)
  [[ "$code" == "200" || "$code" == "302" || "$code" == "307" ]] && { LW_OK=1; break; }
  echo -n "."; sleep 5
done
[[ "$LW_OK" -eq 1 ]] && printf ' %s\n' "${GRN}ok${RST}" || echo " AINDA SUBINDO (primeiro boot demora; acompanhe com make logs CLIENT=${NAME})"


# ---------- langwatch onboarding (automatic) ----------
lw_project_key() {
  docker exec "${NAME}-langwatch-postgres" psql -U prisma -d mydb -t -A \
    -c 'SELECT "apiKey" FROM mydb."Project" ORDER BY "createdAt" DESC LIMIT 1' 2>/dev/null | head -1
}

trpc_ok() { # $1 = tRPC batch response; fails if it carries an error
  python3 -c 'import json,sys; body=json.loads(sys.argv[1]); sys.exit(1 if "error" in body[0] else 0)' "$1"
}

LW_ADMIN_EMAIL="admin@${NAME}.com"
LW_ADMIN_PASSWORD=""
if [[ -z "$(get LANGWATCH_API_KEY)" && "$LW_OK" -eq 1 ]]; then
  KEY_NOW="$(lw_project_key || true)"
  if [[ -n "$KEY_NOW" ]]; then
    step "LangWatch já onboarded — reaproveitando a API key existente"
  else
    step "onboarding do LangWatch (admin: ${LW_ADMIN_EMAIL})"
    BASE="http://localhost:${LANGWATCH_PORT}"
    JAR="$(mktemp)"

    # Senha persistida no env (gitignored) ANTES de qualquer passo que possa
    # falhar — um crash no meio nunca perde a senha de um usuário já criado.
    STORED_PW="$(grep -oP "(?<=^# LangWatch admin \(gerado pelo deploy\): ${LW_ADMIN_EMAIL} / ).*" "$ENVFILE" | head -1 || true)"
    if [[ -n "$STORED_PW" ]]; then
      LW_ADMIN_PASSWORD="$STORED_PW"
    else
      LW_ADMIN_PASSWORD="$(openssl rand -base64 18)"
      printf '# LangWatch admin (gerado pelo deploy): %s / %s\n' "$LW_ADMIN_EMAIL" "$LW_ADMIN_PASSWORD" >> "$ENVFILE"
    fi

    reg=$(curl -s -m 20 -X POST "${BASE}/api/trpc/user.register?batch=1" \
      -H 'Content-Type: application/json' -H "Origin: ${BASE}" \
      -d "{\"0\":{\"json\":{\"name\":\"Admin ${NAME}\",\"email\":\"${LW_ADMIN_EMAIL}\",\"password\":\"${LW_ADMIN_PASSWORD}\"}}}")
    # Usuário já existente não é fatal: o sign-in abaixo decide (senha vem
    # do env quando o registro aconteceu numa execução anterior).
    trpc_ok "$reg" || info "(usuário já existia — sign-in com a senha registrada no env)"

    curl -sf -m 20 -c "$JAR" -o /dev/null -X POST "${BASE}/api/auth/sign-in/email" \
      -H 'Content-Type: application/json' -H "Origin: ${BASE}" \
      -d "{\"email\":\"${LW_ADMIN_EMAIL}\",\"password\":\"${LW_ADMIN_PASSWORD}\"}" \
      || die "sign-in do admin falhou — complete manualmente em ${BASE} e re-rode com --langwatch-key"

    org=$(curl -s -m 20 -b "$JAR" -X POST "${BASE}/api/trpc/organization.createAndAssign?batch=1" \
      -H 'Content-Type: application/json' -H "Origin: ${BASE}" \
      -d "{\"0\":{\"json\":{\"orgName\":\"${NAME}\"}}}")
    trpc_ok "$org" || die "criação da organização falhou: ${org:0:200}"
    ORG_ID=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1])[0]["result"]["data"]["json"]; print(d["organization"]["id"])' "$org")
    TEAM_ID=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1])[0]["result"]["data"]["json"]; print(d["team"]["id"])' "$org")

    proj=$(curl -s -m 20 -b "$JAR" -X POST "${BASE}/api/trpc/project.create?batch=1" \
      -H 'Content-Type: application/json' -H "Origin: ${BASE}" \
      -d "{\"0\":{\"json\":{\"organizationId\":\"${ORG_ID}\",\"teamId\":\"${TEAM_ID}\",\"name\":\"${NAME}\",\"language\":\"other\",\"framework\":\"other\"}}}")
    trpc_ok "$proj" || die "criação do projeto falhou: ${proj:0:200}"
    rm -f "$JAR"

    KEY_NOW="$(lw_project_key || true)"
    [[ -n "$KEY_NOW" ]] || die "projeto criado mas API key não encontrada no Postgres do LangWatch"
  fi
  sed -i "s|^LANGWATCH_API_KEY=.*|LANGWATCH_API_KEY=${KEY_NOW}|" "$ENVFILE"
  step "API key aplicada — recriando a api com sync real"
  make up "CLIENT=${NAME}" > /dev/null 2>&1
fi


# ---------- prices (SEMPRE — independem do LangWatch) ----------
step "demo: registrando preços do modelo premium no banco"
quiet ./packages/api/scripts/register-demo-prices.sh "${NAME}" || die "registro de preços falhou"

# ---------- demo traces (opcional: --no-demo-traces pula SÓ os traces) ----------
if [[ "$DEMO_TRACES" -eq 0 ]]; then
  step "demo: traces pulados (--no-demo-traces) — LangWatch onboarded, sem tráfego"
else
  if [[ -z "$(get LANGWATCH_API_KEY)" ]]; then
    step "${YLW}demo pulado: LangWatch ainda sem API key (re-rode o deploy)${RST}"
  else
    step "demo: gerando tráfego determinístico para '${NAME}'"
    node packages/api/scripts/generate-demo-fixtures.mjs --client "${NAME}" > /dev/null

    step "demo: enviando o tráfego para o LangWatch do cliente"
    node packages/api/scripts/push-demo-to-langwatch.mjs "${NAME}" | tr '\r' '\n' | grep . | tail -1 | sed 's/^/  /' 

    EXPECTED=$(python3 -c "import json,glob; print(sum(len(json.load(open(f))) for f in glob.glob('demo-data/${NAME}/*.json')))")
    printf '%s' "${CYN}▸${RST} ${B}demo: aguardando indexar ${EXPECTED} traces${RST}"
    KEY_NOW="$(get LANGWATCH_API_KEY)"
    INDEXED=0
    for _ in $(seq 1 36); do
      INDEXED=$(curl -s -m 10 -X POST "http://localhost:${LANGWATCH_PORT}/api/traces/search" \
        -H "X-Auth-Token: ${KEY_NOW}" -H 'Content-Type: application/json' \
        -d '{"pageSize":1,"pageOffset":0,"startDate":0,"endDate":1900000000000}' \
        | python3 -c 'import json,sys; print(json.load(sys.stdin).get("pagination",{}).get("totalHits",0))' 2>/dev/null || echo 0)
      [[ "${INDEXED:-0}" -ge "$EXPECTED" ]] && break
      echo -n "."; sleep 5
    done
    echo " ${INDEXED}/${EXPECTED}"
    [[ "${INDEXED:-0}" -ge "$EXPECTED" ]] || info "(indexação incompleta — o sync pega o restante numa re-execução)"

    SYNC_FROM=$(date -u -d '14 days ago' +%F)
    SYNC_TO=$(date -u -d 'tomorrow' +%F)
    step "demo: sincronizando (${SYNC_FROM} → ${SYNC_TO})"
    make sync "CLIENT=${NAME}" FROM="${SYNC_FROM}" TO="${SYNC_TO}" 2>&1 | grep 'Sync:' | sed 's/^/  /' || die "sync falhou"
  fi
fi

# ---------- health: ui ----------
printf '%s' "${CYN}▸${RST} ${B}aguardando UI${RST}"
for _ in $(seq 1 15); do
  curl -sf -o /dev/null -m 3 "http://localhost:${UI_PORT}/" && break
  echo -n "."; sleep 2
done
curl -sf -o /dev/null -m 3 "http://localhost:${UI_PORT}/" \
  || die "UI não respondeu em http://localhost:${UI_PORT} — veja: make logs CLIENT=${NAME}"
printf ' %s\n' "${GRN}ok${RST}"

# ---------- summary ----------
line() { printf '%s\n' "${DIM}──────────────────────────────────────────────────────────────${RST}"; }
row()  { printf '   %s%-12s%s %s\n' "$B" "$1" "$RST" "$2"; }

echo
line
printf '  %s\n' "${GRN}✔${RST} ${B}Cliente '${NAME}' no ar${RST}"
echo
printf '  %s\n' "${CYN}ACESSOS${RST}"
row "UI"        "http://localhost:${UI_PORT}"
row "API"       "http://localhost:${API_PORT}/api/v1   ${DIM}(docs: /api/v1/docs)${RST}"
row "LangWatch" "http://localhost:${LANGWATCH_PORT}"
row "Mongo dev" "mongodb://localhost:$(get MONGO_HOST_PORT)/?directConnection=true   ${DIM}(db: ${NAME})${RST}"
if [[ -n "$LW_ADMIN_PASSWORD" ]]; then
  echo
  printf '  %s   %s\n' "${CYN}CREDENCIAIS LANGWATCH${RST}" "${YLW}⚠ guarde — a senha não é recuperável${RST}"
  row "login" "${LW_ADMIN_EMAIL}"
  row "senha" "${B}${LW_ADMIN_PASSWORD}${RST}   ${DIM}(também em ${ENVFILE})${RST}"
fi
echo
if [[ "$DEMO_TRACES" -eq 0 ]]; then
  printf '  %s\n' "${CYN}DADOS${RST}"
  row "demo" "sem traces demo (--no-demo-traces); LangWatch onboarded, preços no banco, sync real habilitado"
elif [[ -n "$(get LANGWATCH_API_KEY)" ]]; then
  TOT=$(curl -s -m 8 "http://localhost:${API_PORT}/api/v1/traces?page=1&page_size=1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["total"])' 2>/dev/null || echo '?')
  printf '  %s\n' "${CYN}DADOS${RST}"
  row "demo" "${TOT} traces ingeridos e precificados (R\$ 1–100), sync real habilitado"
else
  printf '  %s\n' "${YLW}ONBOARDING PENDENTE${RST} — re-rode ./deploy-demo-client.sh ${NAME}"
fi
echo
printf '  %s\n' "${CYN}OPERAÇÃO${RST}"
row "sync" "make sync CLIENT=${NAME} FROM=YYYY-MM-DD TO=YYYY-MM-DD   ${DIM}(janelas < 100 traces)${RST}"
row "logs"     "make logs CLIENT=${NAME}"
row "parar"    "make down CLIENT=${NAME}   ${DIM}(dados preservados)${RST}"
row "apagar"   "docker compose -f compose.client.yml --env-file ${ENVFILE} down -v"
line
