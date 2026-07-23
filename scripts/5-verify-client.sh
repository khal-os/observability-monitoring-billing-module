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

API_PORT="$(get API_PORT)"; LANGWATCH_PORT="$(get LANGWATCH_PORT)"
UI_PORT="$(get UI_PORT)"; UI_PORT="${UI_PORT:-8080}"

# ---------- health: ui ----------
check_ui() { curl -sf -o /dev/null -m 3 "http://localhost:${UI_PORT}/"; }
wait_live "aguardando UI" "http://localhost:${UI_PORT}" check_ui 15 2 \
  || die "UI não respondeu em http://localhost:${UI_PORT} — veja: make logs CLIENT=${NAME}"

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
row "Mongo dev" "mongodb://localhost:$(get MONGO_HOST_PORT)/?directConnection=true   ${DIM}(db: ${NAME})${RST}"
if [[ -n "$LW_ADMIN_PASSWORD" ]]; then
  echo
  printf '  %s   %s\n' "${CYN}CREDENCIAIS LANGWATCH${RST}" "${YLW}⚠ guarde — a senha não é recuperável${RST}"
  row "login" "${LW_ADMIN_EMAIL}"
  row "senha" "${B}${LW_ADMIN_PASSWORD}${RST}   ${DIM}(também em ${ENVFILE})${RST}"
fi
echo
if [[ -n "$(get LANGWATCH_API_KEY)" ]]; then
  TOT=$(curl -s -m 8 "http://localhost:${API_PORT}/api/v1/traces?page=1&page_size=1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["total"])' 2>/dev/null || echo '?')
  printf '  %s\n' "${CYN}DADOS${RST}"
  row "traces" "${TOT} ingeridos na plataforma"
  if [[ "$TOT" == "0" ]]; then
    QUIET_S="$(get SYNC_QUIET_PERIOD_SECONDS)"; QUIET_S="${QUIET_S:-900}"
    row "" "${DIM}o sync-worker ingere continuamente (quarentena ~$(( (QUIET_S + 59) / 60 )) min);${RST}"
    row "" "${DIM}acompanhe com: make logs CLIENT=${NAME} (linhas 'Sync: batch')${RST}"
  fi
else
  printf '  %s\n' "${YLW}ONBOARDING PENDENTE${RST} — rode ./scripts/3-onboard-langwatch.sh ${NAME}"
fi
echo
printf '  %s\n' "${CYN}OPERAÇÃO${RST}"
row "logs"     "make logs CLIENT=${NAME}   ${DIM}(sync-worker: linhas 'Sync: batch')${RST}"
row "backfill" "make sync CLIENT=${NAME} FROM=YYYY-MM-DD TO=YYYY-MM-DD   ${DIM}(manual/opcional)${RST}"
row "parar"    "make down CLIENT=${NAME}   ${DIM}(dados preservados)${RST}"
row "apagar"   "docker compose -f compose.module.yml -f compose.langwatch.yml -f compose.mongodb.yml --env-file ${ENVFILE} down -v"
line
