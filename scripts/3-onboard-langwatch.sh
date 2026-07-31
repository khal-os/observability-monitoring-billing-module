#!/usr/bin/env bash
#
# STEP 3 — onboard: automatic LangWatch onboarding for one client.
# Registers admin@<name>.com with a random password (persisted as a
# comment in the env file BEFORE any fallible step — a crash never loses
# the password of a created user), creates organization + project via the
# instance's own tRPC API, extracts the project API key from LangWatch's
# Postgres, wires it into the env file and re-applies the stack so the
# real sync (api + trace-ingestion-worker) goes live.
#
#   ./scripts/3-onboard-langwatch.sh <name>
#
# Idempotent: an already-onboarded instance (key in Postgres) is reused;
# a key already in the env file is a no-op. If the automatic flow fails,
# onboard manually in the LangWatch UI and apply the key with
# ./scripts/1-init-client-env.sh <name> --langwatch-key KEY

cd "$(dirname "$0")/.."
source scripts/deploy-lib.sh

require_name "${1:-}"
require_envfile
banner 3 "onboarding LangWatch — admin · org · projeto · API key"

LANGWATCH_PORT="$(get LANGWATCH_PORT)"

if [[ -n "$(get LANGWATCH_API_KEY)" ]]; then
  # Backfill the project id if this env predates its stamping.
  if [[ -z "$(get LANGWATCH_PROJECT_ID)" ]]; then
    PROJECT_ID="$(docker exec "${NAME}-langwatch-postgres" psql -U prisma -d mydb -t -A \
      -c 'SELECT id FROM mydb."Project" ORDER BY "createdAt" DESC LIMIT 1' 2>/dev/null | head -1 || true)"
    if [[ -n "$PROJECT_ID" ]]; then
      if grep -q '^LANGWATCH_PROJECT_ID=' "$ENVFILE"; then
        sed -i "s|^LANGWATCH_PROJECT_ID=.*|LANGWATCH_PROJECT_ID=$(sed_escape "$PROJECT_ID")|" "$ENVFILE"
      else
        sed -i "/^LANGWATCH_API_KEY=/a LANGWATCH_PROJECT_ID=${PROJECT_ID}" "$ENVFILE"
      fi
      step "onboarding: key já presente — project id backfilled (${PROJECT_ID})"
      summary_credentials
      exit 0
    fi
  fi
  step "onboarding: LANGWATCH_API_KEY já presente no env — nada a fazer"
  summary_credentials
  exit 0
fi

check_lw() {
  local c
  c=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://localhost:${LANGWATCH_PORT}/" 2>/dev/null || true)
  [[ "$c" == "200" || "$c" == "302" || "$c" == "307" ]]
}
check_lw || die "LangWatch não responde em http://localhost:${LANGWATCH_PORT} — rode ./scripts/2-provision-client-stack.sh ${NAME} antes"

lw_project_key() {
  docker exec "${NAME}-langwatch-postgres" psql -U prisma -d mydb -t -A \
    -c 'SELECT "apiKey" FROM mydb."Project" ORDER BY "createdAt" DESC LIMIT 1' 2>/dev/null | head -1
}

lw_project_id() {
  docker exec "${NAME}-langwatch-postgres" psql -U prisma -d mydb -t -A \
    -c 'SELECT id FROM mydb."Project" ORDER BY "createdAt" DESC LIMIT 1' 2>/dev/null | head -1
}

trpc_ok() { # $1 = tRPC batch response; fails if it carries an error
  python3 -c 'import json,sys; body=json.loads(sys.argv[1]); sys.exit(1 if "error" in body[0] else 0)' "$1"
}

LW_ADMIN_EMAIL="admin@${NAME}.com"

KEY_NOW="$(lw_project_key || true)"
if [[ -n "$KEY_NOW" ]]; then
  step "LangWatch já onboarded — reaproveitando a API key existente"
else
  step "onboarding do LangWatch (admin: ${LW_ADMIN_EMAIL})"
  BASE="http://localhost:${LANGWATCH_PORT}"
  JAR="$(mktemp)"
  # The jar holds an authenticated session cookie — never leave it in /tmp,
  # success or failure (every die/curl-failure path exits through this trap).
  trap 'rm -f "$JAR"' EXIT

  # Senha persistida no env (gitignored) ANTES de qualquer passo que possa
  # falhar — um crash no meio nunca perde a senha de um usuário já criado.
  STORED_PW="$(grep -oP "(?<=^# LangWatch admin \(gerado pelo deploy\): ${LW_ADMIN_EMAIL} / ).*" "$ENVFILE" | head -1 || true)"
  if [[ -n "$STORED_PW" ]]; then
    LW_ADMIN_PASSWORD="$STORED_PW"
  else
    LW_ADMIN_PASSWORD="$(openssl rand -base64 18)"
    append_env_line "$(printf '# LangWatch admin (gerado pelo deploy): %s / %s' "$LW_ADMIN_EMAIL" "$LW_ADMIN_PASSWORD")"
  fi

  reg=$(curl -s -m 20 -X POST "${BASE}/api/trpc/user.register?batch=1" \
    -H 'Content-Type: application/json' -H "Origin: ${BASE}" \
    -d "{\"0\":{\"json\":{\"name\":\"Admin ${NAME}\",\"email\":\"${LW_ADMIN_EMAIL}\",\"password\":\"${LW_ADMIN_PASSWORD}\"}}}")
  # Usuário já existente não é fatal: o sign-in abaixo decide (senha vem
  # do env quando o registro aconteceu numa execução anterior).
  if trpc_ok "$reg"; then sub "usuário admin criado"; else sub "usuário já existia — sign-in com a senha do env"; fi

  curl -sf -m 20 -c "$JAR" -o /dev/null -X POST "${BASE}/api/auth/sign-in/email" \
    -H 'Content-Type: application/json' -H "Origin: ${BASE}" \
    -d "{\"email\":\"${LW_ADMIN_EMAIL}\",\"password\":\"${LW_ADMIN_PASSWORD}\"}" \
    || die "sign-in do admin falhou — complete manualmente em ${BASE} e aplique a key com ./scripts/1-init-client-env.sh ${NAME} --langwatch-key KEY"
  sub "sessão autenticada"

  org=$(curl -s -m 20 -b "$JAR" -X POST "${BASE}/api/trpc/organization.createAndAssign?batch=1" \
    -H 'Content-Type: application/json' -H "Origin: ${BASE}" \
    -d "{\"0\":{\"json\":{\"orgName\":\"${NAME}\"}}}")
  trpc_ok "$org" || die "criação da organização falhou: ${org:0:200}"
  ORG_ID=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1])[0]["result"]["data"]["json"]; print(d["organization"]["id"])' "$org")
  TEAM_ID=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1])[0]["result"]["data"]["json"]; print(d["team"]["id"])' "$org")
  sub "organização criada (${ORG_ID})"

  proj=$(curl -s -m 20 -b "$JAR" -X POST "${BASE}/api/trpc/project.create?batch=1" \
    -H 'Content-Type: application/json' -H "Origin: ${BASE}" \
    -d "{\"0\":{\"json\":{\"organizationId\":\"${ORG_ID}\",\"teamId\":\"${TEAM_ID}\",\"name\":\"${NAME}\",\"language\":\"other\",\"framework\":\"other\"}}}")
  trpc_ok "$proj" || die "criação do projeto falhou: ${proj:0:200}"
  sub "projeto criado"

  KEY_NOW="$(lw_project_key || true)"
  [[ -n "$KEY_NOW" ]] || die "projeto criado mas API key não encontrada no Postgres do LangWatch"
  sub "API key extraída do Postgres do LangWatch"
fi

# sed_escape: the replacement side treats & \ | as metacharacters — a key
# containing any of them would silently corrupt the env file.
sed -i "s|^LANGWATCH_API_KEY=.*|LANGWATCH_API_KEY=$(sed_escape "$KEY_NOW")|" "$ENVFILE"

# Also stamp the project id — the sync's optional tenant filter. Costless
# now, protective the day a second project appears on the instance.
PROJECT_ID="$(lw_project_id || true)"
if [[ -n "$PROJECT_ID" ]]; then
  if grep -q '^LANGWATCH_PROJECT_ID=' "$ENVFILE"; then
    sed -i "s|^LANGWATCH_PROJECT_ID=.*|LANGWATCH_PROJECT_ID=$(sed_escape "$PROJECT_ID")|" "$ENVFILE"
  else
    sed -i "/^LANGWATCH_API_KEY=/a LANGWATCH_PROJECT_ID=${PROJECT_ID}" "$ENVFILE"
  fi
  sub "project id aplicado (${PROJECT_ID})"
fi

step "API key aplicada — recriando a stack com sync real (api + trace-ingestion-worker)"
# Direto no terminal (sem `live`): preserva o renderer nativo animado do compose.
make -s up "CLIENT=${NAME}"

summary_credentials
