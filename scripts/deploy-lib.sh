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
LOG="$(mktemp)"
quiet() { "$@" > "$LOG" 2>&1 || { tail -15 "$LOG"; return 1; }; }

line() { printf '%s\n' "${DIM}──────────────────────────────────────────────────────────────${RST}"; }
row()  { printf '   %s%-12s%s %s\n' "$B" "$1" "$RST" "$2"; }

# ---------- client name + env file ----------
# require_name <name-arg>: validates the slug and sets NAME/ENVFILE.
require_name() {
  NAME="${1:-}"
  [[ -n "$NAME" ]] || die "uso: $0 <name> [options]"
  [[ "$NAME" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "nome deve ser um slug ([a-z][a-z0-9-]+): '$NAME'"
  ENVFILE="clients/${NAME}.env"
}

require_envfile() {
  [[ -f "$ENVFILE" ]] || die "faltando ${ENVFILE} — rode ./scripts/init-client-env.sh ${NAME} primeiro"
}

get() { grep -oP "(?<=^$1=).*" "$ENVFILE" | head -1; }

# Append a line to the env file, healing a missing trailing newline first —
# appending onto a file whose last line lacks \n would CONCATENATE onto it
# (seen in the wild: REPROCESS_INTERVAL_SECONDS=3600# LangWatch admin ...,
# which crash-looped the sync-worker on config validation).
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
