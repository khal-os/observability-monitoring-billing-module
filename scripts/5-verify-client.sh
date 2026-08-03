#!/usr/bin/env bash
#
# STEP 5 — verify + summary: UI health, ingested-trace count, and the
# operator summary (URLs, LangWatch credentials from the env file,
# day-2 command cheatsheet). Read-only — safe to run any time.
#
#   ./scripts/5-verify-client.sh <name>

cd "$(dirname "$0")/.."
source scripts/deploy-lib.sh

require_name "${1:-}"
require_envfile
banner 5 "verificação — saúde · dados · resumo"

# host_port, never get: as três portas podem ser omitidas do env file (é o
# contrato — clients/example.env), e uma URL "http://localhost:/…" vira
# porta 80 no curl. Ver deploy-lib.sh.
API_PORT="$(host_port API_PORT)"
LANGWATCH_PORT="$(host_port LANGWATCH_PORT)"
UI_PORT="$(host_port UI_PORT)"

# ---------- health: ui ----------
check_ui() { curl -sf -o /dev/null -m 3 "http://localhost:${UI_PORT}/"; }
wait_live "aguardando UI" "http://localhost:${UI_PORT}" check_ui 15 2 \
  || die "UI não respondeu em http://localhost:${UI_PORT} — veja: make logs CLIENT=${NAME}"

# ---------- health: auth ----------
# When the env file enables auth (AUTH_SYSTEM_URL descomentado), prove it
# actually reached the container: a tokenless request MUST answer 401. Any
# other answer means the API is serving the archive open despite the env —
# the exact silent-fail this check exists to catch.
AUTH_SYSTEM_URL="$(get AUTH_SYSTEM_URL)"
if [[ -n "$AUTH_SYSTEM_URL" ]]; then
  step "auth habilitado no env — verificando fail-closed sem token"
  AUTH_URL="http://localhost:${API_PORT}/api/v1/traces"
  AUTH_CODE="$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$AUTH_URL" || true)"
  # 000 = nenhuma resposta HTTP (transporte). Isso NÃO é uma falha de auth —
  # dizer "o auth não chegou ao container" aqui manda o operador consertar
  # algo que não está quebrado.
  [[ "$AUTH_CODE" != "000" ]] \
    || die "a API não respondeu em ${AUTH_URL} — sem resposta HTTP, não dá para verificar o auth (a stack está no ar? make up CLIENT=${NAME}; confira API_PORT em ${ENVFILE})"
  [[ "$AUTH_CODE" == "401" ]] \
    || die "AUTH_SYSTEM_URL está definido em ${ENVFILE}, mas GET /api/v1/traces SEM token respondeu ${AUTH_CODE} (esperado: 401) — o auth não chegou ao container (recrie a stack: make up CLIENT=${NAME})"
  sub "sem token → 401 (fail closed)"
fi

# ---------- summary ----------
LW_ADMIN_EMAIL="admin@${NAME}.com"
LW_ADMIN_PASSWORD="$(grep -oP "(?<=^# LangWatch admin \(gerado pelo deploy\): ${LW_ADMIN_EMAIL} / ).*" "$ENVFILE" | head -1 || true)"

echo
line
printf '  %s\n' "${GRN}✔${RST} ${B}Cliente '${NAME}' no ar${RST}"
echo
printf '  %s\n' "${CYN}ACESSOS${RST}"
row "UI"        "http://localhost:${UI_PORT}"
row "API"       "http://localhost:${API_PORT}/api/v1"
row "API docs"  "http://localhost:${API_PORT}/api/v1/docs/"
row "LangWatch" "http://localhost:${LANGWATCH_PORT}"
MONGO_HOST_PORT="$(get MONGO_HOST_PORT)"
if [[ -n "$MONGO_HOST_PORT" ]]; then
  row "Mongo dev" "mongodb://localhost:${MONGO_HOST_PORT}/?directConnection=true   ${DIM}(db: ${NAME})${RST}"
else
  row "Mongo dev" "${DIM}sem porta fixa — defina MONGO_HOST_PORT em ${ENVFILE} (compose publica em porta efêmera)${RST}"
fi
if [[ -n "$LW_ADMIN_PASSWORD" ]]; then
  echo
  printf '  %s   %s\n' "${CYN}CREDENCIAIS LANGWATCH${RST}" "${YLW}⚠ guarde — a senha não é recuperável${RST}"
  row "login" "${LW_ADMIN_EMAIL}"
  row "senha" "${B}${LW_ADMIN_PASSWORD}${RST}   ${DIM}(também em ${ENVFILE})${RST}"
fi
echo
if [[ -n "$(get LANGWATCH_API_KEY)" ]]; then
  # total_display (não total): passado o teto de contagem da decisão 77/79
  # a API responde "10.000+" — o número cru mentiria sobre o arquivo.
  TOT=$(curl -s -m 8 "http://localhost:${API_PORT}/api/v1/traces?page=1&page_size=1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["total_display"])' 2>/dev/null || echo '?')
  printf '  %s\n' "${CYN}DADOS${RST}"
  row "traces" "${TOT} ingeridos na plataforma"
  if [[ "$TOT" == "0" ]]; then
    QUIET_S="$(get TRACE_INGESTION_QUIET_PERIOD_SECONDS)"; QUIET_S="${QUIET_S:-900}"
    row "" "${DIM}o trace-ingestion-worker ingere continuamente (quarentena ~$(( (QUIET_S + 59) / 60 )) min);${RST}"
    row "" "${DIM}acompanhe com: make logs CLIENT=${NAME} (linhas 'Sync: batch')${RST}"
  fi
else
  printf '  %s\n' "${YLW}ONBOARDING PENDENTE${RST} — rode ./scripts/3-onboard-langwatch.sh ${NAME}"
fi
echo
printf '  %s\n' "${CYN}OPERAÇÃO${RST}"
row "logs"     "make logs CLIENT=${NAME}   ${DIM}(trace-ingestion-worker: linhas 'Sync: batch')${RST}"
row "backfill" "make sync CLIENT=${NAME} FROM=YYYY-MM-DD TO=YYYY-MM-DD   ${DIM}(manual/opcional)${RST}"
row "parar"    "make down CLIENT=${NAME}   ${DIM}(dados preservados)${RST}"
row "backup"   "make backup CLIENT=${NAME}   ${DIM}(mongodump -> backups/ — o arquivo permanente)${RST}"
row "apagar"   "docker compose -f compose.module.yml -f compose.connector.yml -f compose.mongodb.yml --env-file ${ENVFILE} down -v   ${DIM}(faça make backup antes)${RST}"
line
