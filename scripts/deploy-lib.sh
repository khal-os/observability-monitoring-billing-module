# Shared helpers for the deploy step scripts (sourced, never executed).
# Each step script is independently runnable:
#   ./scripts/<step>.sh <name> [options]
# and deploy-demo-client.sh orchestrates them in order. Conventions here:
# $NAME (validated slug), $ENVFILE, colored output, live container tree.

set -euo pipefail

# ---------- output helpers (colors only on a terminal) ----------
if [[ -t 1 ]]; then
  B=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; CYN=$'\033[36m'
  YLW=$'\033[33m'; RED=$'\033[31m'; RST=$'\033[0m'
else
  B='' DIM='' GRN='' CYN='' YLW='' RED='' RST=''
fi

step()  { printf '%s\n' "${CYN}▸${RST} ${B}$*${RST}"; }
info()  { printf '%s\n' "  ${DIM}$*${RST}"; }
sub()   { printf '  %s %s\n' "${DIM}·${RST}" "$*"; }
die()   { printf '%s\n' "${RED}✖ ERRO:${RST} $*" >&2; exit 1; }

# Step banner: every step script announces itself the same way, whether
# run standalone or via the orchestrator — number first, so the sequence
# is impossible to miss. Call AFTER require_name. Usage: banner <n> <título>
BANNER_RULE="━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
banner() {
  printf '\n%s\n' "${CYN}${BANNER_RULE}${RST}"
  printf '%s\n' " ${B}${CYN}[$1/5]${RST} ${B}$2${RST}   ${DIM}cliente: ${NAME}${RST}"
  printf '%s\n' "${CYN}${BANNER_RULE}${RST}"
}

# Run a command streaming its output LIVE under the current step — every
# line shown as it happens behind a dim │ gutter, closed by ✔/✖ + elapsed.
# Nothing is swallowed: what the tool prints is what the operator watches.
live() {
  local t0=$SECONDS rc=0
  "$@" 2>&1 | sed -u "s/^/  ${DIM}│ /;s/\$/${RST}/" || rc=$?
  if (( rc == 0 )); then
    printf '  %s✔%s %s%ds%s\n' "$GRN" "$RST" "$DIM" "$(( SECONDS - t0 ))" "$RST"
  else
    printf '  %s✖ falhou%s %s(%ds)%s\n' "$RED" "$RST" "$DIM" "$(( SECONDS - t0 ))" "$RST"
  fi
  return $rc
}

line() { printf '%s\n' "${DIM}──────────────────────────────────────────────────────────────${RST}"; }
row()  { printf '   %s%-12s%s %s\n' "$B" "$1" "$RST" "$2"; }

# ---------- summary sections ----------
# Each step closes by printing ITS slice of the final summary (the full
# picture stays in 5-verify-client.sh): env → ACESSOS · provisão →
# OPERAÇÃO · onboarding → CREDENCIAIS · seed → DADOS.

summary_access() {
  local ui_port; ui_port="$(get UI_PORT)"; ui_port="${ui_port:-8080}"
  echo
  printf '  %s\n' "${CYN}ACESSOS${RST}"
  row "UI"        "http://localhost:${ui_port}"
  row "API"       "http://localhost:$(get API_PORT)/api/v1"
  row "API docs"  "http://localhost:$(get API_PORT)/api/v1/docs/"
  row "LangWatch" "http://localhost:$(get LANGWATCH_PORT)"
  row "Mongo dev" "mongodb://localhost:$(get MONGO_HOST_PORT)/?directConnection=true   ${DIM}(db: ${NAME})${RST}"
}

summary_credentials() {
  local email="admin@${NAME}.com" password
  password="$(grep -oP "(?<=^# LangWatch admin \(gerado pelo deploy\): admin@${NAME}.com / ).*" "$ENVFILE" | head -1 || true)"
  echo
  printf '  %s   %s\n' "${CYN}CREDENCIAIS LANGWATCH${RST}" "${YLW}⚠ guarde — a senha não é recuperável${RST}"
  row "login" "${email}"
  if [[ -n "$password" ]]; then
    row "senha" "${B}${password}${RST}   ${DIM}(também em ${ENVFILE})${RST}"
  else
    row "senha" "${DIM}(não registrada em ${ENVFILE} — onboarding manual ou comentário removido)${RST}"
  fi
}

summary_data() {
  local total
  total=$(curl -s -m 8 "http://localhost:$(get API_PORT)/api/v1/traces?page=1&page_size=1" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["total"])' 2>/dev/null || echo '?')
  echo
  printf '  %s\n' "${CYN}DADOS${RST}"
  row "traces" "${total} ingeridos na plataforma"
  if [[ "$total" == "0" ]]; then
    local quiet_s; quiet_s="$(get TRACE_INGESTION_QUIET_PERIOD_SECONDS)"; quiet_s="${quiet_s:-900}"
    row "" "${DIM}o trace-ingestion-worker ingere continuamente (quarentena ~$(( (quiet_s + 59) / 60 )) min);${RST}"
    row "" "${DIM}acompanhe com: make logs CLIENT=${NAME} (linhas 'Sync: batch')${RST}"
  fi
}

summary_operation() {
  echo
  printf '  %s\n' "${CYN}OPERAÇÃO${RST}"
  row "logs"     "make logs CLIENT=${NAME}   ${DIM}(trace-ingestion-worker: linhas 'Sync: batch')${RST}"
  row "backfill" "make sync CLIENT=${NAME} FROM=YYYY-MM-DD TO=YYYY-MM-DD   ${DIM}(manual/opcional)${RST}"
  row "parar"    "make down CLIENT=${NAME}   ${DIM}(dados preservados)${RST}"
  row "backup"   "make backup CLIENT=${NAME}   ${DIM}(mongodump -> backups/ — o arquivo permanente)${RST}"
  row "apagar"   "docker compose -f compose.module.yml -f compose.connector.yml -f compose.mongodb.yml --env-file ${ENVFILE} down -v   ${DIM}(faça make backup antes)${RST}"
}

# ---------- client name + env file ----------
# require_name <name-arg>: validates the slug and sets NAME/ENVFILE.
require_name() {
  NAME="${1:-}"
  [[ -n "$NAME" ]] || die "uso: $0 <name> [options]"
  [[ "$NAME" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "nome deve ser um slug ([a-z][a-z0-9-]+): '$NAME'"
  ENVFILE="clients/${NAME}.env"
}

require_envfile() {
  [[ -f "$ENVFILE" ]] || die "faltando ${ENVFILE} — rode ./scripts/1-init-client-env.sh ${NAME} primeiro"
}

# `|| true`: a var absent from the env file is a NORMAL state (the contract
# invites omitting optional knobs) — without it, grep's exit 1 rides
# pipefail/set -e and kills the caller with no message, turning every
# `${VAR:-default}` fallback after a get() into dead code.
get() { grep -oP "(?<=^$1=).*" "$ENVFILE" | head -1 || true; }

# Escape a value for the REPLACEMENT side of a sed s|…|…| on the env file:
# `&` (whole-match), `\` (escape) and `|` (our delimiter) are metacharacters
# there — an API key containing any of them would corrupt the write.
sed_escape() { printf '%s' "$1" | sed -e 's/[&\|]/\\&/g'; }

# Append a line to the env file, healing a missing trailing newline first —
# appending onto a file whose last line lacks \n would CONCATENATE onto it
# (seen in the wild: REPROCESS_INTERVAL_SECONDS=3600# LangWatch admin ...,
# which crash-looped the trace-ingestion-worker on config validation).
append_env_line() {
  [[ -s "$ENVFILE" && -n "$(tail -c1 "$ENVFILE")" ]] && echo >> "$ENVFILE"
  printf '%s\n' "$1" >> "$ENVFILE"
}

# ---------- live container tree ----------
# One line per container of this client's stack, in docker compose's own
# visual language (` Container <name>  <Status>`), status colored by health
# (verde = up/healthy, amarelo = starting, vermelho = down).
containers() {
  local rows i cname cstatus color
  mapfile -t rows < <(docker ps -a --filter "label=com.docker.compose.project=${NAME}" \
    --format '{{.Names}}\t{{.Status}}' | sort)
  for i in "${!rows[@]}"; do
    cname="${rows[$i]%%$'\t'*}"; cstatus="${rows[$i]#*$'\t'}"
    case "$cstatus" in
      *starting*)          color="$YLW" ;;
      *healthy*|Up*)       color="$GRN" ;;
      *)                   color="$RED" ;;
    esac
    printf ' %sContainer %-34s%s %s%s%s\n' "$DIM" "$cname" "$RST" "$color" "$cstatus" "$RST"
  done
}

# Live wait: while polling a readiness check, redraws the container tree IN
# PLACE (TTY) with a footer showing the target and elapsed time — the stack's
# health dots update in real time as containers come up. Non-TTY (CI/pipes)
# falls back to the classic dots. Usage: wait_live <rótulo> <alvo> <check_fn> <tentativas> <intervalo>
wait_live() {
  local label="$1" target="$2" check="$3" tries="$4" delay="$5"
  local i lines=0 t0=$SECONDS ok=0 block footer
  step "$label"
  if [[ ! -t 1 ]]; then
    for ((i = 0; i < tries; i++)); do
      "$check" && { ok=1; break; }
      echo -n "."; sleep "$delay"
    done
    [[ "$ok" -eq 1 ]] && echo " ok" || echo " timeout"
    return $(( 1 - ok ))
  fi
  for ((i = 0; i < tries; i++)); do
    "$check" && ok=1
    if [[ "$ok" -eq 1 ]]; then
      footer="  ${GRN}✔${RST} ${target} ${DIM}· $(( SECONDS - t0 ))s${RST}"
    else
      footer="  ${DIM}⏳ ${target} · $(( SECONDS - t0 ))s${RST}"
    fi
    block="$(containers)"$'\n'"$footer"
    (( lines > 0 )) && printf '\033[%dA\033[0J' "$lines"
    printf '%s\n' "$block"
    lines=$(printf '%s\n' "$block" | wc -l)
    [[ "$ok" -eq 1 ]] && return 0
    sleep "$delay"
  done
  return 1
}
