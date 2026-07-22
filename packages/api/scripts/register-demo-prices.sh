#!/usr/bin/env bash
# Registers the premium demo model's contracted prices in every client
# database, through the sanctioned job (prices are versioned data kept by
# direct inserts — invariant 9). Immutable: re-running reports duplicates
# and changes nothing.
#
#   ./packages/api/scripts/register-demo-prices.sh [cliente...]   # default: hapvida claro vivo
#
# Values must match PRICES in generate-demo-fixtures.mjs.
set -uo pipefail

cd "$(dirname "$0")/../../.."

MODEL="anthropic/claude-opus-4-8"
EFFECTIVE_FROM="2026-06-01"

# tokenType:priceBrlPerMillion:marketUsd  (PTAX 5.50, markup 0 — internal only)
ROWS=(
  "input:82.50:15"
  "output:412.50:75"
  "cache_read:8.25:1.50"
  "cache_write:103.125:18.75"
)

failures=0

CLIENTS=("$@")
[[ ${#CLIENTS[@]} -gt 0 ]] || CLIENTS=(hapvida claro vivo)

for client in "${CLIENTS[@]}"; do
  for row in "${ROWS[@]}"; do
    IFS=: read -r token_type price_brl market_usd <<< "$row"
    echo "→ ${client}: ${MODEL} ${token_type} R\$ ${price_brl}/M"
    if out=$(make price "CLIENT=${client}" ARGS="--model ${MODEL} --token-type ${token_type} \
      --price-brl ${price_brl} --effective-from ${EFFECTIVE_FROM} \
      --market-usd ${market_usd} --ptax 5.50 --markup 0" 2>&1); then
      continue
    elif grep -q 'already exists' <<< "$out"; then
      echo "  (já registrado — versões são imutáveis, mantido)"
    else
      echo "  FALHOU:"
      sed 's/^/  | /' <<< "$out" | tail -6
      failures=$((failures + 1))
    fi
  done
done

if [[ $failures -gt 0 ]]; then
  echo "ERRO: ${failures} inserção(ões) falharam de verdade (não eram duplicatas)."
  exit 1
fi

echo "Pronto. Preços do modelo premium registrados em: ${CLIENTS[*]}."
