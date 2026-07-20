#!/usr/bin/env bash
# pocket-term-2 non-interactive installer (agent-drivable).
#
# Detects environment, installs npm deps, renders systemd unit from template,
# optionally installs herdr Claude integration, optionally writes VAPID env,
# installs+enables the unit, verifies /herd/api/state.
#
# Usage:
#   ./scripts/install.sh [flags]
#
# Flags / env (flags win):
#   --workdir DIR       Repo root (default: parent of scripts/)
#   --port PORT         PT2_PORT (default: 7690)
#   --host HOST         PT2_HOST (default: 127.0.0.1)
#   --user USER         systemd User= (default: current user)
#   --home DIR          HOME for the service (default: ~user or $HOME)
#   --node-bin PATH     node binary (default: $(command -v node))
#   --system            Install system unit to /etc/systemd/system (needs root)
#   --user-unit         Install user unit to ~/.config/systemd/user (default if non-root)
#   --no-start          Install unit but do not enable/start
#   --no-herdr-integ    Skip `herdr integration install claude`
#   --with-push         Generate VAPID keys into state/pt2.env (subject required)
#   --vapid-subject S   mailto: or https: contact for Web Push (with --with-push)
#   --env-file PATH     Write/merge EnvironmentFile (default: <workdir>/state/pt2.env)
#   --dry-run           Print actions only
#   -h|--help
#
# Env overrides: PT2_PORT PT2_HOST PT2_HERDR_SOCK PT2_PROJECTS_ROOT
#                PT2_CHAT_UPLOAD_DIR PT2_FILE_SERVE_ROOT PT2_READONLY
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKDIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PORT="${PT2_PORT:-7690}"
HOST="${PT2_HOST:-127.0.0.1}"
USER_NAME="$(id -un)"
HOME_DIR="${HOME:-}"
NODE_BIN="$(command -v node 2>/dev/null || true)"
SYSTEM_UNIT=false
USER_UNIT=false
NO_START=false
NO_HERDR_INTEG=false
WITH_PUSH=false
VAPID_SUBJECT="${PT2_VAPID_SUBJECT:-}"
ENV_FILE=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workdir) WORKDIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --user) USER_NAME="$2"; shift 2 ;;
    --home) HOME_DIR="$2"; shift 2 ;;
    --node-bin) NODE_BIN="$2"; shift 2 ;;
    --system) SYSTEM_UNIT=true; shift ;;
    --user-unit) USER_UNIT=true; shift ;;
    --no-start) NO_START=true; shift ;;
    --no-herdr-integ) NO_HERDR_INTEG=true; shift ;;
    --with-push) WITH_PUSH=true; shift ;;
    --vapid-subject) VAPID_SUBJECT="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

WORKDIR="$(cd "$WORKDIR" && pwd)"
if [[ -z "$HOME_DIR" ]]; then
  HOME_DIR="$(getent passwd "$USER_NAME" 2>/dev/null | cut -d: -f6 || true)"
  HOME_DIR="${HOME_DIR:-$HOME}"
fi
if [[ -z "$ENV_FILE" ]]; then
  ENV_FILE="${WORKDIR}/state/pt2.env"
fi

# Default unit scope
if ! $SYSTEM_UNIT && ! $USER_UNIT; then
  if [[ "$(id -u)" -eq 0 ]]; then
    SYSTEM_UNIT=true
  else
    USER_UNIT=true
  fi
fi

log() { echo "[install] $*"; }
run() {
  if $DRY_RUN; then
    log "DRY-RUN: $*"
  else
    "$@"
  fi
}

die() { echo "ERROR: $*" >&2; exit 1; }

# ── Preflight ──────────────────────────────────────────────────────────
[[ -f "$WORKDIR/server.js" ]] || die "server.js not found in $WORKDIR"
[[ -f "$WORKDIR/package.json" ]] || die "package.json not found in $WORKDIR"
[[ -f "$WORKDIR/systemd/pocket-term-2.service.tmpl" ]] || die "missing systemd template"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || die "node not found (need Node >= 20)"

NODE_VER="$("$NODE_BIN" -v 2>/dev/null | sed 's/^v//')"
NODE_MAJOR="${NODE_VER%%.*}"
[[ "${NODE_MAJOR:-0}" -ge 20 ]] || die "Node >= 20 required (found v${NODE_VER:-unknown})"

log "workdir=$WORKDIR user=$USER_NAME home=$HOME_DIR port=$PORT host=$HOST"
log "node=$NODE_BIN (v$NODE_VER)"

# ── Dependencies ───────────────────────────────────────────────────────
log "npm ci"
if $DRY_RUN; then
  log "DRY-RUN: (cd $WORKDIR && npm ci)"
else
  (cd "$WORKDIR" && npm ci)
fi

# ── Optional herdr Claude integration (Tier A) ─────────────────────────
if ! $NO_HERDR_INTEG; then
  if command -v herdr >/dev/null 2>&1; then
    log "herdr integration install claude"
    run herdr integration install claude || log "WARN: herdr integration install failed (Tier A optional)"
  else
    log "WARN: herdr not on PATH — skip integration install"
  fi
else
  log "skip herdr integration (--no-herdr-integ)"
fi

# ── Env file (optional push + common overrides) ────────────────────────
mkdir -p "$(dirname "$ENV_FILE")" 2>/dev/null || true
if ! $DRY_RUN; then
  mkdir -p "$WORKDIR/state"
fi

# Seed env file with host/port if missing
write_env_line() {
  local key="$1" val="$2"
  if $DRY_RUN; then
    log "DRY-RUN: env $key=$val → $ENV_FILE"
    return
  fi
  touch "$ENV_FILE"
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    # keep existing
    return
  fi
  printf '%s=%s\n' "$key" "$val" >>"$ENV_FILE"
}

write_env_line "PT2_HOST" "$HOST"
write_env_line "PT2_PORT" "$PORT"
[[ -n "${PT2_HERDR_SOCK:-}" ]] && write_env_line "PT2_HERDR_SOCK" "$PT2_HERDR_SOCK"
[[ -n "${PT2_PROJECTS_ROOT:-}" ]] && write_env_line "PT2_PROJECTS_ROOT" "$PT2_PROJECTS_ROOT"
[[ -n "${PT2_CHAT_UPLOAD_DIR:-}" ]] && write_env_line "PT2_CHAT_UPLOAD_DIR" "$PT2_CHAT_UPLOAD_DIR"
[[ -n "${PT2_FILE_SERVE_ROOT:-}" ]] && write_env_line "PT2_FILE_SERVE_ROOT" "$PT2_FILE_SERVE_ROOT"

if $WITH_PUSH; then
  [[ -n "$VAPID_SUBJECT" ]] || die "--with-push requires --vapid-subject (mailto: or https:)"
  if $DRY_RUN; then
    log "DRY-RUN: generate VAPID into $ENV_FILE"
  else
    if ! grep -q '^PT2_VAPID_PUBLIC_KEY=' "$ENV_FILE" 2>/dev/null; then
      log "generating VAPID keys → $ENV_FILE"
      # shellcheck disable=SC1090
      eval "$(bash "$SCRIPT_DIR/gen-vapid.sh" --env | grep -E '^export PT2_VAPID_(PUBLIC|PRIVATE)_KEY=')"
      {
        echo "PT2_VAPID_SUBJECT=${VAPID_SUBJECT}"
        echo "PT2_VAPID_PUBLIC_KEY=${PT2_VAPID_PUBLIC_KEY}"
        echo "PT2_VAPID_PRIVATE_KEY=${PT2_VAPID_PRIVATE_KEY}"
      } >>"$ENV_FILE"
      chmod 600 "$ENV_FILE"
    else
      log "VAPID keys already present in $ENV_FILE — keeping"
    fi
  fi
fi

# ── Render systemd unit ────────────────────────────────────────────────
GROUP_NAME="$(id -gn "$USER_NAME" 2>/dev/null || echo "$USER_NAME")"
NODE_DIR="$(dirname "$NODE_BIN")"
# PATH for service: node dir + common locals + system
NODE_PATH="${NODE_DIR}:${HOME_DIR}/.local/bin:/usr/local/bin:/usr/bin:/bin"

TMPL="$WORKDIR/systemd/pocket-term-2.service.tmpl"
UNIT_OUT="$WORKDIR/systemd/pocket-term-2.service.generated"

log "render unit → $UNIT_OUT"
if $DRY_RUN; then
  log "DRY-RUN: sed template → $UNIT_OUT"
else
  sed \
    -e "s|__USER__|${USER_NAME}|g" \
    -e "s|__GROUP__|${GROUP_NAME}|g" \
    -e "s|__WORKDIR__|${WORKDIR}|g" \
    -e "s|__HOME__|${HOME_DIR}|g" \
    -e "s|__NODE_PATH__|${NODE_PATH}|g" \
    -e "s|__NODE_BIN__|${NODE_BIN}|g" \
    "$TMPL" >"$UNIT_OUT"
  # Ensure EnvironmentFile line points at real env file
  if [[ -f "$ENV_FILE" ]]; then
    if ! grep -q "EnvironmentFile=.*pt2.env" "$UNIT_OUT"; then
      # Template has commented EnvironmentFile; uncomment with real path
      sed -i "s|# EnvironmentFile=-__WORKDIR__/state/pt2.env|EnvironmentFile=-${ENV_FILE}|" "$UNIT_OUT" 2>/dev/null || true
      # If still commented with expanded workdir:
      sed -i "s|# EnvironmentFile=-${WORKDIR}/state/pt2.env|EnvironmentFile=-${ENV_FILE}|" "$UNIT_OUT" 2>/dev/null || true
    fi
    # Force-enable EnvironmentFile for generated unit
    if ! grep -q "^EnvironmentFile=" "$UNIT_OUT"; then
      # Insert after PATH env line
      sed -i "/^Environment=PATH=/a EnvironmentFile=-${ENV_FILE}" "$UNIT_OUT"
    fi
  fi
fi

install_unit() {
  local src="$1" dest="$2"
  log "install unit $dest"
  if $DRY_RUN; then
    log "DRY-RUN: cp $src $dest"
    return
  fi
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
}

if $SYSTEM_UNIT; then
  [[ "$(id -u)" -eq 0 ]] || die "--system requires root (or use --user-unit)"
  UNIT_DEST="/etc/systemd/system/pocket-term-2.service"
  install_unit "$UNIT_OUT" "$UNIT_DEST"
  SYSTEMCTL=(systemctl)
elif $USER_UNIT; then
  UNIT_DEST="${HOME_DIR}/.config/systemd/user/pocket-term-2.service"
  install_unit "$UNIT_OUT" "$UNIT_DEST"
  SYSTEMCTL=(systemctl --user)
else
  die "no unit scope selected"
fi

if ! $NO_START; then
  log "daemon-reload + enable --now"
  if $DRY_RUN; then
    log "DRY-RUN: ${SYSTEMCTL[*]} daemon-reload"
    log "DRY-RUN: ${SYSTEMCTL[*]} enable --now pocket-term-2"
  else
    "${SYSTEMCTL[@]}" daemon-reload
    "${SYSTEMCTL[@]}" enable --now pocket-term-2
  fi
else
  log "skip start (--no-start); unit installed at ${UNIT_DEST:-$UNIT_OUT}"
  if ! $DRY_RUN; then
    "${SYSTEMCTL[@]}" daemon-reload || true
  fi
fi

# ── Verify ─────────────────────────────────────────────────────────────
BASE="http://${HOST}:${PORT}"
log "verify ${BASE}/herd/api/state"
if $DRY_RUN || $NO_START; then
  log "skip live verify (dry-run or --no-start)"
  log "PASS: install steps complete"
  exit 0
fi

ok=false
for i in 1 2 3 4 5 6 7 8 9 10; do
  code="$(curl -s -o /tmp/pt2-state-check.json -w '%{http_code}' --max-time 2 \
    "${BASE}/herd/api/state" 2>/dev/null || echo "000")"
  if [[ "$code" == "200" ]]; then
    ok=true
    break
  fi
  sleep 0.5
done

if $ok; then
  log "PASS: /herd/api/state → 200"
  head -c 200 /tmp/pt2-state-check.json 2>/dev/null || true
  echo
  exit 0
fi

log "FAIL: /herd/api/state not healthy (last http=$code)"
log "Check: ${SYSTEMCTL[*]} status pocket-term-2 --no-pager"
log "Logs:  ${SYSTEMCTL[*]} journal -u pocket-term-2 -n 50  (or journalctl)"
exit 1
