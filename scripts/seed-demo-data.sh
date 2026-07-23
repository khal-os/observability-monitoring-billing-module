#!/usr/bin/env bash
#
# STEP 4 — demo data (DEV ONLY): premium-model prices and/or deterministic
# demo traffic for one client.
#
#   ./scripts/seed-demo-data.sh <name> [--prices] [--traces]
#
#   --prices   register the premium demo model's price versions (make
#              price runbook, insert-only, idempotent)
#   --traces   generate deterministic fixtures for this client and push
#              them into its LangWatch (requires onboarding)
#
# No flag = both. Ingestion into the platform store is the sync-worker's
# job: pushed traces are indexed by LangWatch and picked up by the worker
# after the quiet period (~15-16 min). For instant ingestion use a manual
# backfill: make sync CLIENT=<name> FROM=... TO=...

cd "$(dirname "$0")/.."
source scripts/deploy-lib.sh

require_name "${1:-}"; shift || true
require_envfile

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
  quiet ./packages/api/scripts/register-demo-prices.sh "${NAME}" || die "registro de preços falhou"
  grep -E '^→|já registrado' "$LOG" | sed "s/^→ /  ${DIM}·${RST} /; s/^ *(/  ${DIM}·${RST} (/" || true
fi

# ---------- traces ----------
if [[ "$DO_TRACES" -eq 1 ]]; then
  KEY_NOW="$(get LANGWATCH_API_KEY)"
  [[ -n "$KEY_NOW" ]] || die "LangWatch sem API key — rode ./scripts/onboard-langwatch.sh ${NAME} antes"

  step "demo: gerando tráfego determinístico para '${NAME}'"
  node packages/api/scripts/generate-demo-fixtures.mjs --client "${NAME}" > /dev/null

  step "demo: enviando o tráfego para o LangWatch do cliente"
  node packages/api/scripts/push-demo-to-langwatch.mjs "${NAME}" | tr '\r' '\n' | grep . | tail -1 | sed 's/^/  /'

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

  info "ingestão contínua: o sync-worker ingere após a quarentena (~15-16 min);"
  info "para ingerir JÁ: make sync CLIENT=${NAME} FROM=$(date -u -d '14 days ago' +%F) TO=$(date -u -d 'tomorrow' +%F)"
fi
