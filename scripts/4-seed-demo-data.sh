#!/usr/bin/env bash
#
# STEP 4 — demo data (DEV ONLY): premium-model prices and/or deterministic
# demo traffic for one client.
#
#   ./scripts/4-seed-demo-data.sh <name> [--prices] [--traces]
#
#   --prices   register the premium demo model's price versions (make
#              price runbook, insert-only, idempotent)
#   --traces   generate deterministic fixtures for this client and push
#              them into its LangWatch (requires onboarding)
#
# No flag = both. Ingestion into the platform store is the trace-ingestion-worker's
# job: pushed traces are indexed by LangWatch and picked up by the worker
# after the quiet period (~15-16 min). For instant ingestion use a manual
# backfill: make sync CLIENT=<name> FROM=... TO=...

cd "$(dirname "$0")/.."
source scripts/deploy-lib.sh

require_name "${1:-}"; shift || true
require_envfile
banner 4 "dados demo — preços · tráfego"

DO_PRICES=0 DO_TRACES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prices) DO_PRICES=1; shift ;;
    --traces) DO_TRACES=1; shift ;;
    *) die "opção desconhecida: $1" ;;
  esac
done
if [[ "$DO_PRICES" -eq 0 && "$DO_TRACES" -eq 0 ]]; then
  DO_PRICES=1; DO_TRACES=1
fi

LANGWATCH_PORT="$(get LANGWATCH_PORT)"

# ---------- prices ----------
if [[ "$DO_PRICES" -eq 1 ]]; then
  step "demo: registrando preços do modelo premium no banco"
  live ./packages/api/scripts/register-demo-prices.sh "${NAME}" || die "registro de preços falhou"
fi

# ---------- traces ----------
if [[ "$DO_TRACES" -eq 1 ]]; then
  KEY_NOW="$(get LANGWATCH_API_KEY)"
  [[ -n "$KEY_NOW" ]] || die "LangWatch sem API key — rode ./scripts/3-onboard-langwatch.sh ${NAME} antes"

  step "demo: gerando tráfego determinístico para '${NAME}'"
  live node packages/api/scripts/generate-demo-fixtures.mjs --client "${NAME}" \
    || die "geração de fixtures falhou"

  step "demo: enviando o tráfego para o LangWatch do cliente"
  # tr '\r' '\n': o push reporta progresso com \r; via gutter cada tick
  # vira uma linha visível em vez de um carriage return perdido.
  live bash -c "set -o pipefail; node packages/api/scripts/push-demo-to-langwatch.mjs '${NAME}' | tr '\r' '\n' | grep --line-buffered ." \
    || die "push para o LangWatch falhou"

  EXPECTED=$(python3 -c "import json,glob; print(sum(len(json.load(open(f))) for f in glob.glob('demo-data/${NAME}/*.json')))")
  printf '%s' "${CYN}▸${RST} ${B}demo: aguardando indexar ${EXPECTED} traces${RST}"
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
  [[ "${INDEXED:-0}" -ge "$EXPECTED" ]] || info "(indexação incompleta — o restante indexa em seguida)"

  QUIET_S="$(get SYNC_QUIET_PERIOD_SECONDS)"; QUIET_S="${QUIET_S:-900}"

  # With a short demo quarantine, watch the worker ingest live instead of
  # leaving a "come back later" note (bounded: quarantine + a few cycles).
  if (( QUIET_S <= 60 )); then
    INTERVAL_S="$(get SYNC_INTERVAL_SECONDS)"; INTERVAL_S="${INTERVAL_S:-60}"
    DEADLINE=$(( SECONDS + QUIET_S + INTERVAL_S * 3 + 30 ))
    printf '%s' "${CYN}▸${RST} ${B}demo: aguardando o trace-ingestion-worker ingerir (quarentena ${QUIET_S}s)${RST}"
    while (( SECONDS < DEADLINE )); do
      TOT=$(curl -s -m 5 "http://localhost:$(get API_PORT)/api/v1/traces?page=1&page_size=1" \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["total"])' 2>/dev/null || echo 0)
      [[ "${TOT:-0}" -ge "$EXPECTED" ]] && break
      echo -n "."; sleep 3
    done
    echo " ${TOT:-0}/${EXPECTED}"
  else
    info "ingestão contínua: o trace-ingestion-worker ingere após a quarentena (~$(( (QUIET_S + 59) / 60 ))-$(( (QUIET_S + 59) / 60 + 1 )) min);"
    info "para ingerir JÁ: make sync CLIENT=${NAME} FROM=$(date -u -d '14 days ago' +%F) TO=$(date -u -d 'tomorrow' +%F)"
  fi
fi

summary_data
