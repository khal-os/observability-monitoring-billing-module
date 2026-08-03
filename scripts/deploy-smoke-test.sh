#!/usr/bin/env bash
#
# Docker-free smoke test of the deploy scripts: `make deploy-smoke`.
#
# It exercises the two things that only break on a FRESH client — the state
# no manual re-run ever reproduces, which is why both defects survived two
# fix waves:
#
#   A. step 4 must complete for a client that has never had fixtures.
#      `make up` creates demo-data/<cliente>/ EMPTY, and that directory is
#      the dev discriminator `make seed-prices` gates on (decision 74), so
#      generating the fixtures as a side effect of the --traces block made
#      the --prices block abort every first-ever deploy.
#   B. every URL the scripts build must survive the ports being OMITTED
#      from the env file — the env contract explicitly invites that on a
#      dedicated host, and "http://localhost:/api/v1" is a port-80 request
#      that can never answer 401 (the auth fail-closed check then blamed
#      auth forwarding for a URL bug).
#
# Real Makefile, real step-4 script, real deploy-lib. Only `docker` is
# stubbed (nothing here should reach a container), so the ordering and the
# guards under test are the production ones.

set -euo pipefail
cd "$(dirname "$0")/.."

SLUG="deploy-smoke-test"
ENVFILE="clients/${SLUG}.env"
FIXTURES="demo-data/${SLUG}"
STUBS=""
FAILURES=0

if [[ -e "$ENVFILE" || -e "$FIXTURES" ]]; then
  echo "abortado: ${ENVFILE} ou ${FIXTURES} já existe — remova antes de rodar o smoke" >&2
  exit 1
fi

cleanup() {
  rm -rf "$ENVFILE" "$FIXTURES" "${STUBS:-/nonexistent-stub-dir}"
}
trap cleanup EXIT

ok()   { printf '  \033[32m✔\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✖\033[0m %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
case_() { printf '\n\033[36m▸\033[0m \033[1m%s\033[0m\n' "$1"; }

# `docker` is the ONLY stub: the jobs it would run need a live stack, and
# what is under test is which command runs FIRST, not what the job does.
STUBS="$(mktemp -d)"
printf '#!/bin/sh\nexit 0\n' > "${STUBS}/docker"
chmod +x "${STUBS}/docker"

# The minimal env file the contract sanctions: identity only. No API_PORT,
# no LANGWATCH_PORT, no UI_PORT — exactly the "dedicated host, omit them"
# case of clients/example.env.
cat > "$ENVFILE" <<EOF
COMPOSE_PROJECT_NAME=${SLUG}
CLIENT_NAME=${SLUG}
EOF

# ---------------------------------------------------------------------------
case_ "A · fresh client: step 4 --prices completes with an EMPTY demo-data/"
# ---------------------------------------------------------------------------
# This is precisely what step 2 leaves behind (Makefile `up`: mkdir -p only).
mkdir -p "$FIXTURES"

if PATH="${STUBS}:${PATH}" ./scripts/4-seed-demo-data.sh "$SLUG" --prices \
     > "${STUBS}/step4.log" 2>&1; then
  ok "./scripts/4-seed-demo-data.sh ${SLUG} --prices saiu 0"
else
  bad "step 4 abortou (exit $?) — as fixtures ainda são geradas depois do bloco de preços?"
  sed 's/^/    | /' "${STUBS}/step4.log" | tail -20
fi

if compgen -G "${FIXTURES}/*.json" > /dev/null; then
  ok "as fixtures do discriminador DEV existem em ${FIXTURES}/"
else
  bad "nenhum ${FIXTURES}/*.json — o gerador não rodou antes da guarda de seed-prices"
fi

# The guard itself must now be satisfied — asserted through the REAL recipe.
if make -n seed-prices "CLIENT=${SLUG}" 2>&1 | grep -q 'test -n "demo-data/'"${SLUG}"'/'; then
  ok "a guarda DEV do make seed-prices enxerga as fixtures"
else
  bad "a guarda DEV do make seed-prices continua vazia"
fi

# ---------------------------------------------------------------------------
case_ "B · portas omitidas: toda URL construída continua bem-formada"
# ---------------------------------------------------------------------------
(
  # shellcheck source=scripts/deploy-lib.sh
  source scripts/deploy-lib.sh
  NAME="$SLUG"
  ENVFILE="clients/${SLUG}.env"

  [[ "$(host_port API_PORT)"       == "3000" ]] || { echo "API_PORT sem default"; exit 1; }
  [[ "$(host_port LANGWATCH_PORT)" == "5560" ]] || { echo "LANGWATCH_PORT sem default"; exit 1; }
  [[ "$(host_port UI_PORT)"        == "8080" ]] || { echo "UI_PORT sem default"; exit 1; }

  # The exact URL the auth fail-closed check curls (5-verify-client.sh).
  url="http://localhost:$(host_port API_PORT)/api/v1/traces"
  [[ "$url" == "http://localhost:3000/api/v1/traces" ]] || { echo "URL malformada: ${url}"; exit 1; }

  summary_access | grep -q 'http://localhost:/' && { echo "summary_access ainda imprime porta vazia"; exit 1; }
  exit 0
) && ok "host_port aplica os defaults do compose (3000/5560/8080) e as URLs fecham" \
  || bad "URLs quebram quando as portas são omitidas do env file"

# A port var that IS set must still win over the default.
printf 'API_PORT=3007\n' >> "$ENVFILE"
(
  source scripts/deploy-lib.sh
  NAME="$SLUG"; ENVFILE="clients/${SLUG}.env"
  [[ "$(host_port API_PORT)" == "3007" ]]
) && ok "um API_PORT explícito vence o default" \
  || bad "host_port ignora o valor do env file"

# Source-level: no deploy script may build a URL straight from a raw get()
# of a port var — that is the bug, and it is invisible on any host whose
# env file happens to set the ports.
RAW_PORT_READS="$(grep -rn '\$(get \(API_PORT\|LANGWATCH_PORT\|UI_PORT\))' \
  --exclude=deploy-smoke-test.sh scripts/ deploy-demo-client.sh || true)"
if [[ -n "$RAW_PORT_READS" ]]; then
  bad "porta lida com get() em vez de host_port() — URL vira http://localhost:/…"
  sed 's/^/    | /' <<< "$RAW_PORT_READS"
else
  ok "nenhum script constrói URL a partir de um get() cru de porta"
fi

echo
if (( FAILURES == 0 )); then
  printf '\033[32m✔\033[0m deploy smoke: tudo verde\n'
else
  printf '\033[31m✖\033[0m deploy smoke: %d verificação(ões) falharam\n' "$FAILURES"
  exit 1
fi
