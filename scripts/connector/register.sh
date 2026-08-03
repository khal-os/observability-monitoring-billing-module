#!/usr/bin/env bash
# DEV-ONLY: (re-)registers the LangWatch OTLP connector in a LOCAL khal
# connector-register, so the agent can resolve `monitoring.trace`/`write`
# against the real register instead of any mock. (Moved here from
# martino-agent — the connector is provisioned by this module's stack, so its
# scripts live with it.)
#
# The manifest's `version` is read from scripts/connector/version — bump with
# scripts/connector/bump-version.sh and re-run this.
#
# The local register stores manifests IN MEMORY — run this again after every
# dev-server restart. Idempotent: an existing connector is updated in place
# (ETag/If-Match handled automatically).
#
# For the resolved credential to be REAL (not dev-secret-*), start the register
# with the vault seed (see khal-platform docs/platform/connector-register/sops.md):
#   VAULT_CREDENTIALS_JSON='{"workos-vault://langwatch-cliente":"<api key>"}' \
#     pnpm --filter @observability/connector-register dev
#
# Env overrides (all optional):
#   REGISTER_URL   default http://127.0.0.1:7103
#   TENANT         default acme
#   CONNECTOR_ID   default langwatch-cliente
#   OTLP_ENDPOINT  default http://localhost:5562/api/otel/v1/traces
#   CREDENTIAL_REF default workos-vault://<CONNECTOR_ID> — MUST match a key of
#                  the register's VAULT_CREDENTIALS_JSON for the resolved
#                  credential to be real
#   VERSION        default: contents of scripts/connector/version
#   TOKEN          a USER token for the PUT (registration is a user action).
#                  Unset → dev claims token minted below.
set -euo pipefail

REGISTER_URL="${REGISTER_URL:-http://127.0.0.1:7103}"
TENANT="${TENANT:-acme}"
CONNECTOR_ID="${CONNECTOR_ID:-langwatch-cliente}"
OTLP_ENDPOINT="${OTLP_ENDPOINT:-http://localhost:5562/api/otel/v1/traces}"
CREDENTIAL_REF="${CREDENTIAL_REF:-workos-vault://${CONNECTOR_ID}}"
VERSION="${VERSION:-$(tr -d '[:space:]' <"$(dirname "$0")/version")}"

# Empty shell expansions produce silent garbage (id "langwatch-", endpoint
# "http://localhost:/..." ) — refuse them loudly instead of registering it.
[[ "$CONNECTOR_ID" =~ ^[a-z0-9][a-z0-9-]*[a-z0-9]$ ]] \
  || { echo "ERROR: CONNECTOR_ID '$CONNECTOR_ID' looks like an empty expansion (export CLIENT?)"; exit 1; }
[[ "$OTLP_ENDPOINT" =~ ^https?://[^/:]+(:[0-9]+)?/ ]] \
  || { echo "ERROR: OTLP_ENDPOINT '$OTLP_ENDPOINT' is malformed (empty \$LANGWATCH_PORT?)"; exit 1; }

# LEGACY until SPEC-3 lands: the local register still guards routes by scope,
# so the dev claims token carries them. Once the platform removes scopes,
# drop the scope field here. A real user token can be passed via TOKEN.
TOKEN="${TOKEN:-$(python3 -c "import base64,json,sys;print(base64.urlsafe_b64encode(json.dumps({'tenant':sys.argv[1],'client_id':'connector-register.sh','scope':'connectors.registry:read connectors.registry:write'}).encode()).decode().rstrip('='))" "$TENANT")}"

BASE_URL="${OTLP_ENDPOINT%/api/otel/v1/traces}"
MANIFEST=$(cat <<EOF
{
  "id": "${CONNECTOR_ID}",
  "manifestVersion": "1.0.0",
  "version": "${VERSION}",
  "type": "otlp-stream",
  "connectsTo": "monitoring",
  "capabilities": [
    {
      "signal": "monitoring.trace",
      "operation": "write",
      "bindings": [
        {
          "transport": "http",
          "protocol": "otlp",
          "encoding": "protobuf",
          "endpoint": "${OTLP_ENDPOINT}",
          "auth": { "placement": "header", "name": "authorization", "scheme": "Bearer" }
        }
      ]
    }
  ],
  "baseUrl": "${BASE_URL}",
  "credentialRef": "${CREDENTIAL_REF}",
  "lifecycle": "active"
}
EOF
)

# Existing connector? Grab its ETag so the update satisfies If-Match.
ETAG=$(curl -s -o /dev/null -w '%{header_json}' \
  -H "Authorization: Bearer ${TOKEN}" \
  "${REGISTER_URL}/connectors/${CONNECTOR_ID}" \
  | python3 -c "import json,sys;h=json.load(sys.stdin);print((h.get('etag') or [''])[0])")

ARGS=(-sS -X PUT "${REGISTER_URL}/connectors/${CONNECTOR_ID}"
  -H "Authorization: Bearer ${TOKEN}" -H 'content-type: application/json'
  -w '\nHTTP %{http_code}\n' -d "${MANIFEST}")
[[ -n "$ETAG" ]] && ARGS+=(-H "If-Match: ${ETAG}")

curl "${ARGS[@]}"
echo "connector '${CONNECTOR_ID}' v${VERSION} registered at ${REGISTER_URL} (tenant ${TENANT}) → ${OTLP_ENDPOINT}"
