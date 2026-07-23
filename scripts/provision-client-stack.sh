#!/usr/bin/env bash
#
# STEP 2 — provision: images (built only if missing) → stack up (9
# containers, dev form) → API health → migrations → LangWatch health.
# Idempotent: a stack already up is a fast no-op pass. First LangWatch
# boot runs its own migrations and takes a few minutes.
#
#   ./scripts/provision-client-stack.sh <name>
#
# Exits 0 with LangWatch still booting (warns) — onboarding can be
# re-run later; everything else failing is fatal.

cd "$(dirname "$0")/.."
source scripts/deploy-lib.sh

require_name "${1:-}"
require_envfile

API_PORT="$(get API_PORT)"; LANGWATCH_PORT="$(get LANGWATCH_PORT)"

# ---------- images ----------
docker image inspect "$(get API_IMAGE)" > /dev/null 2>&1 \
  || { step "buildando imagens (api + ui)"; quiet make build || die "build falhou"; }
docker image inspect platform-ui:local > /dev/null 2>&1 \
  || { step "buildando imagem da UI"; quiet docker build -f docker/ui.Dockerfile -t platform-ui:local . || die "build da UI falhou"; }

# ---------- stack ----------
# Sem `quiet`: o próprio renderer do docker compose mostra cada contêiner
# subindo em tempo real (Created → Started → Healthy), como num `up` manual.
step "subindo a stack (9 contêineres)"
make -s up "CLIENT=${NAME}" || die "compose up falhou"

# ---------- health: api (implies mongo healthy via depends_on) ----------
check_api() { curl -sf -o /dev/null -m 3 "http://localhost:${API_PORT}/api/v1/docs/openapi.json"; }
wait_live "aguardando API" "http://localhost:${API_PORT}/api/v1" check_api 30 4 \
  || die "API não respondeu em http://localhost:${API_PORT} — veja: make logs CLIENT=${NAME}"

# ---------- migrations (idempotent) ----------
step "rodando migrações"
quiet make migrate "CLIENT=${NAME}" || die "migrações falharam"
info "migrações aplicadas"

# ---------- health: langwatch (first boot runs its own migrations, be patient) ----------
check_lw() {
  local c
  c=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://localhost:${LANGWATCH_PORT}/" 2>/dev/null || true)
  [[ "$c" == "200" || "$c" == "302" || "$c" == "307" ]]
}
if ! wait_live "aguardando LangWatch (primeiro boot roda migrações — paciência)" \
     "http://localhost:${LANGWATCH_PORT}" check_lw 60 5; then
  info "${YLW}LangWatch AINDA SUBINDO — re-rode o onboarding depois (make logs CLIENT=${NAME})${RST}"
fi
