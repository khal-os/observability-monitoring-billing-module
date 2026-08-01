#!/usr/bin/env bash
# DEV-ONLY: (re-)registers this module in a LOCAL khal module-register, so
# apps (Farol) can discover it by id. The register is the source of truth for
# the deployed module VERSION — the manifest's `version` is read from
# package.json automatically, so run this after every bump/deploy
# (scripts/bump-version.sh).
#
# The local register stores manifests IN MEMORY — run this again after every
# dev-server restart. Idempotent: an existing module is updated in place
# (ETag/If-Match handled automatically).
#
# Env:
#   CLIENT        REQUIRED — client slug; tenant AND source of API_PORT
#                 (read from clients/$CLIENT.env unless API_PORT is set;
#                 absent there, the compose default applies — see host_port)
#   REGISTER_URL  default http://127.0.0.1:7102 (the module-register)
#   MODULE_ID     default tracing
#   ENDPOINT      default http://localhost:${API_PORT}
#   TOKEN         a USER token for the PUT (registration is a user action).
#                 Unset → dev claims token minted below.
#   DRY_RUN       any value → print the resolved endpoint + manifest and stop
#                 before touching the register (how `make deploy-smoke`
#                 exercises the port resolution offline).
set -euo pipefail

: "${CLIENT:?export CLIENT first (client slug = tenant)}"
REGISTER_URL="${REGISTER_URL:-http://127.0.0.1:7102}"
MODULE_ID="${MODULE_ID:-tracing}"
TENANT="${TENANT:-$CLIENT}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/deploy-lib.sh
source "$ROOT/scripts/deploy-lib.sh"

# The port goes through deploy-lib's host_port, exactly like every deploy
# step: the env contract EXPLICITLY invites omitting API_PORT on a dedicated
# host (clients/example.env), so reading the var rawly made a contract-legal
# env file abort registration — stack healthy on the compose default 3000,
# module never registered, Farol unable to discover it, and the operator told
# to set a variable the contract told him to leave out. An explicit
# API_PORT (or ENDPOINT) still wins.
ENVFILE="$ROOT/clients/$CLIENT.env"
if [[ -z "${ENDPOINT:-}" ]]; then
  if [[ -z "${API_PORT:-}" ]]; then
    [[ -f "$ENVFILE" ]] \
      || { echo "ERROR: missing $ENVFILE — pass API_PORT=<port> or ENDPOINT=<url> to register without it"; exit 1; }
    API_PORT="$(host_port API_PORT)"
  fi
  ENDPOINT="http://localhost:${API_PORT}"
fi

VERSION=$(node -p "require('$ROOT/package.json').version")

# LEGACY until SPEC-3 lands: the local register still guards routes by scope,
# so the dev claims token carries them. Once the platform removes scopes,
# drop the scope field here. A real user token can be passed via TOKEN.
TOKEN="${TOKEN:-$(python3 -c "import base64,json,sys;print(base64.urlsafe_b64encode(json.dumps({'tenant':sys.argv[1],'client_id':'register-module.sh','scope':'modules.registry:write modules.registry:read'}).encode()).decode().rstrip('='))" "$TENANT")}"

MANIFEST=$(cat <<EOF
{
  "id": "${MODULE_ID}",
  "manifestVersion": "1.0.0",
  "version": "${VERSION}",
  "info": {
    "name": { "pt-BR": "Módulo de Observabilidade (Tracing)" },
    "protocol": "rest"
  },
  "connection": { "endpoint": "${ENDPOINT}", "health": "/api/v1/docs/openapi.json" },
  "auth": { "requiredScopes": ["monitoring.trace:read"] }
}
EOF
)

if [[ -n "${DRY_RUN:-}" ]]; then
  echo "DRY_RUN: module '${MODULE_ID}' v${VERSION} (tenant ${TENANT}) → ${ENDPOINT}"
  echo "${MANIFEST}"
  exit 0
fi

# Existing module? Grab its ETag so the update satisfies If-Match.
ETAG=$(curl -s -o /dev/null -w '%{header_json}' \
  -H "Authorization: Bearer ${TOKEN}" \
  "${REGISTER_URL}/modules/${MODULE_ID}" \
  | python3 -c "import json,sys;h=json.load(sys.stdin);print((h.get('etag') or [''])[0])")

ARGS=(-sS -X PUT "${REGISTER_URL}/modules/${MODULE_ID}"
  -H "Authorization: Bearer ${TOKEN}" -H 'content-type: application/json'
  -w '\nHTTP %{http_code}\n' -d "${MANIFEST}")
[[ -n "$ETAG" ]] && ARGS+=(-H "If-Match: ${ETAG}")

curl "${ARGS[@]}"
echo "module '${MODULE_ID}' v${VERSION} registered at ${REGISTER_URL} (tenant ${TENANT}) → ${ENDPOINT}"
