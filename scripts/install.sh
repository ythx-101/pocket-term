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

# Resolve herdr socket path (env wins, else service-user home default).
HERDR_SOCK="${PT2_HERDR_SOCK:-${HOME_DIR}/.config/herdr/herdr.sock}"

# True if TCP HOST:PORT already has a listener (0 = free, 1 = busy).
port_is_busy() {
  local host="$1" port="$2"
  # Prefer ss (iproute2); fall back to bash /dev/tcp probe.
  if command -v ss >/dev/null 2>&1; then
    # Match IPv4/IPv6 listen lines for the exact port.
    if ss -H -tln 2>/dev/null | awk -v p=":${port}" '
      {
        # last colon-separated field of Local Address:Port is the port
        n = split($4, a, ":");
        if (a[n] == substr(p, 2)) { found=1; exit }
      }
      END { exit found ? 0 : 1 }
    '; then
      return 0
    fi
    return 1
  fi
  # bash /dev/tcp: successful open means something is listening.
  if (echo >/dev/tcp/"$host"/"$port") >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# PID listening on HOST:PORT, or empty if unknown/free.
port_listener_pid() {
  local host="$1" port="$2"
  local line pid
  if command -v ss >/dev/null 2>&1; then
    line="$(ss -H -tlnp 2>/dev/null | awk -v p=":${port}" '
      {
        n = split($4, a, ":");
        if (a[n] == substr(p, 2)) { print; exit }
      }
    ')"
    if [[ -n "$line" ]]; then
      # users:(("node",pid=1234,fd=26))
      pid="$(echo "$line" | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -1)"
      echo "$pid"
      return 0
    fi
  fi
  if command -v fuser >/dev/null 2>&1; then
    # fuser prints "7690/tcp:  1234"
    pid="$(fuser "${port}/tcp" 2>/dev/null | tr -s '[:space:]' ' ' | awk '{print $NF}')"
    echo "$pid"
    return 0
  fi
  echo ""
}

# Is PID a pocket-term-2 server.js for THIS workdir?
is_pt2_process() {
  local pid="$1"
  [[ -n "$pid" && -r "/proc/$pid/cmdline" ]] || return 1
  local cmd work
  cmd="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
  [[ "$cmd" == *server.js* ]] || return 1
  work="$(readlink -f "$WORKDIR" 2>/dev/null || echo "$WORKDIR")"
  # Prefer cwd match (systemd WorkingDirectory).
  if [[ -r "/proc/$pid/cwd" ]]; then
    local cwd
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    if [[ -n "$cwd" ]]; then
      [[ "$cwd" == "$work" ]] && return 0
      return 1
    fi
  fi
  # Fallback when cwd unreadable: cmdline must reference this workdir.
  [[ "$cmd" == *"$work"* ]] && return 0
  return 1
}

# systemd unit MainPID for pocket-term-2 (empty if unit missing/inactive).
unit_main_pid() {
  if $SYSTEM_UNIT; then
    systemctl show -p MainPID --value pocket-term-2 2>/dev/null || true
  elif $USER_UNIT; then
    systemctl --user show -p MainPID --value pocket-term-2 2>/dev/null || true
  else
    echo ""
  fi
}

# ── Preflight (fail-fast BEFORE any install side effects) ───────────────
log "preflight: fail-fast checks"

[[ -f "$WORKDIR/server.js" ]] || die "server.js not found in $WORKDIR"
[[ -f "$WORKDIR/package.json" ]] || die "package.json not found in $WORKDIR"
[[ -f "$WORKDIR/systemd/pocket-term-2.service.tmpl" ]] || die "missing systemd template"

# 1) Node present and >= 20
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || die "node not found (need Node >= 20). Install Node 20+ or pass --node-bin PATH"
NODE_VER="$("$NODE_BIN" -v 2>/dev/null | sed 's/^v//')"
NODE_MAJOR="${NODE_VER%%.*}"
[[ "${NODE_MAJOR:-0}" -ge 20 ]] || die "Node >= 20 required (found v${NODE_VER:-unknown})"
log "preflight OK: node=$NODE_BIN (v$NODE_VER)"

# 2) Running as the right user for the chosen unit scope
CURRENT_UID="$(id -u)"
CURRENT_USER="$(id -un)"
if $SYSTEM_UNIT; then
  [[ "$CURRENT_UID" -eq 0 ]] || die "--system requires root (run as root, or use --user-unit)"
  # Service will run as USER_NAME; that account must exist.
  getent passwd "$USER_NAME" >/dev/null 2>&1 \
    || die "service user '$USER_NAME' does not exist (pass --user NAME)"
  log "preflight OK: root installing system unit (service User=$USER_NAME)"
elif $USER_UNIT; then
  if [[ "$CURRENT_USER" != "$USER_NAME" ]]; then
    # Installing another user's unit needs root or matching identity.
    if [[ "$CURRENT_UID" -ne 0 ]]; then
      die "user-unit install as '$CURRENT_USER' cannot target --user $USER_NAME (run as that user or as root)"
    fi
  fi
  log "preflight OK: user-unit install for User=$USER_NAME (installer=$CURRENT_USER)"
fi

# 3) herdr binary/socket reachable — required; do NOT install without it
HERDR_OK=false
if command -v herdr >/dev/null 2>&1; then
  if herdr status >/dev/null 2>&1; then
    HERDR_OK=true
    log "preflight OK: herdr status succeeded"
  fi
fi
if ! $HERDR_OK; then
  if [[ -S "$HERDR_SOCK" ]]; then
    HERDR_OK=true
    log "preflight OK: herdr socket present at $HERDR_SOCK"
  fi
fi
if ! $HERDR_OK; then
  die "herdr not reachable — refusing to install.
  Need either:
    • 'herdr' on PATH with a running server ('herdr status' ok), or
    • Unix socket at: $HERDR_SOCK
  Start herdr first, set PT2_HERDR_SOCK if non-default, then re-run install.
  (Do not use --no-herdr-integ to skip this: that flag only skips Claude integration.)"
fi

# 4) Target port free (or already our pocket-term-2 — reinstall path)
if port_is_busy "$HOST" "$PORT"; then
  LISTENER_PID="$(port_listener_pid "$HOST" "$PORT")"
  UNIT_PID="$(unit_main_pid)"
  UNIT_PID="${UNIT_PID//[^0-9]/}"
  OWN=false
  if [[ -n "$LISTENER_PID" ]] && is_pt2_process "$LISTENER_PID"; then
    if [[ -n "$UNIT_PID" && "$UNIT_PID" == "$LISTENER_PID" ]]; then
      OWN=true
    elif [[ -z "$UNIT_PID" || "$UNIT_PID" == "0" ]]; then
      # Process looks like ours (server.js in this workdir) even if unit not loaded yet.
      OWN=true
    fi
  fi
  if $OWN; then
    log "preflight OK: port $HOST:$PORT already held by pocket-term-2 (pid=${LISTENER_PID}) — reinstall allowed"
  else
    EXTRA=""
    if [[ -n "$LISTENER_PID" ]]; then
      EXTRA=" (pid=$LISTENER_PID: $(tr '\0' ' ' <"/proc/$LISTENER_PID/cmdline" 2>/dev/null | head -c 120))"
    fi
    die "target port ${HOST}:${PORT} is already in use${EXTRA}.
  Free the port or choose another with --port / PT2_PORT.
  Refusing to install (would falsely PASS health checks against a foreign listener)."
  fi
else
  log "preflight OK: port $HOST:$PORT is free"
fi

# 5) systemd available
command -v systemctl >/dev/null 2>&1 || die "systemctl not found — systemd is required for install"
if $SYSTEM_UNIT; then
  systemctl daemon-reload --dry-run >/dev/null 2>&1 \
    || systemctl status >/dev/null 2>&1 \
    || die "system systemd not usable (systemctl failed)"
  log "preflight OK: systemctl (system) available"
elif $USER_UNIT; then
  # User bus may be unavailable in some non-login contexts; still require binary + basic show.
  if ! systemctl --user status >/dev/null 2>&1; then
    # Soft-fail only when XDG_RUNTIME_DIR missing is the likely cause — still hard-fail install of user unit.
    die "systemctl --user not usable (is a user systemd session active? try loginctl enable-linger $USER_NAME)"
  fi
  log "preflight OK: systemctl --user available"
fi

log "workdir=$WORKDIR user=$USER_NAME home=$HOME_DIR port=$PORT host=$HOST"
log "node=$NODE_BIN (v$NODE_VER) herdr_sock=$HERDR_SOCK"
log "preflight: all checks passed"

# ── Dependencies ───────────────────────────────────────────────────────
log "npm ci"
if $DRY_RUN; then
  log "DRY-RUN: (cd $WORKDIR && npm ci)"
else
  (cd "$WORKDIR" && npm ci)
fi

# ── Optional herdr Claude integration (Tier A) ─────────────────────────
# Herdr server itself was required at preflight; this only installs the
# Claude integration helper (transcripts). Failures here are non-fatal.
if ! $NO_HERDR_INTEG; then
  if command -v herdr >/dev/null 2>&1; then
    log "herdr integration install claude"
    run herdr integration install claude || log "WARN: herdr integration install failed (Tier A optional)"
  else
    log "WARN: herdr CLI not on PATH — skip integration install (socket was present)"
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

# ── Verify (must be THIS service, not a foreign listener on the port) ──
BASE="http://${HOST}:${PORT}"
log "verify ${BASE}/herd/api/state (owned by pocket-term-2 unit)"
if $DRY_RUN || $NO_START; then
  log "skip live verify (dry-run or --no-start)"
  log "PASS: install steps complete"
  exit 0
fi

ok=false
code="000"
body_file="/tmp/pt2-state-check.$$.json"
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  # 1) Unit must be active with a MainPID
  MAIN_PID="$("${SYSTEMCTL[@]}" show -p MainPID --value pocket-term-2 2>/dev/null || true)"
  MAIN_PID="${MAIN_PID//[^0-9]/}"
  ACTIVE="$("${SYSTEMCTL[@]}" is-active pocket-term-2 2>/dev/null || true)"
  if [[ "$ACTIVE" != "active" || -z "$MAIN_PID" || "$MAIN_PID" == "0" ]]; then
    sleep 0.5
    continue
  fi
  # 2) MainPID must be our server.js
  if ! is_pt2_process "$MAIN_PID"; then
    sleep 0.5
    continue
  fi
  # 3) MainPID (or its children) must own the listen port
  LISTENER_PID="$(port_listener_pid "$HOST" "$PORT")"
  if [[ -n "$LISTENER_PID" && "$LISTENER_PID" != "$MAIN_PID" ]]; then
    # Accept if listener is in the same cgroup/process tree as MainPID
    if [[ -r "/proc/$LISTENER_PID/stat" ]]; then
      # Walk parent chain up to MainPID
      walk="$LISTENER_PID"
      owned=false
      for _ in 1 2 3 4 5 6 7 8; do
        [[ "$walk" == "$MAIN_PID" ]] && { owned=true; break; }
        [[ -z "$walk" || "$walk" == "0" || "$walk" == "1" ]] && break
        walk="$(awk '{print $4}' "/proc/$walk/stat" 2>/dev/null || true)"
      done
      if ! $owned; then
        sleep 0.5
        continue
      fi
    else
      sleep 0.5
      continue
    fi
  fi
  if [[ -z "$LISTENER_PID" ]]; then
    # Port not yet bound — wait
    sleep 0.5
    continue
  fi
  # 4) HTTP health from that listener
  code="$(curl -s -o "$body_file" -w '%{http_code}' --max-time 2 \
    "${BASE}/herd/api/state" 2>/dev/null || echo "000")"
  if [[ "$code" == "200" ]]; then
    # Cheap ownership signal: JSON should look like our state payload.
    if grep -qE '"panes"|"herdr"' "$body_file" 2>/dev/null; then
      ok=true
      break
    fi
    # 200 without expected keys — treat as foreign service on our port.
    log "WARN: ${BASE}/herd/api/state → 200 but body lacks panes/herdr (not pocket-term-2?)"
  fi
  sleep 0.5
done

if $ok; then
  log "PASS: /herd/api/state → 200 (unit MainPID=$MAIN_PID owns ${HOST}:${PORT})"
  head -c 200 "$body_file" 2>/dev/null || true
  echo
  rm -f "$body_file"
  exit 0
fi

rm -f "$body_file"
log "FAIL: /herd/api/state not healthy from this pocket-term-2 service (last http=$code)"
log "  unit active: $("${SYSTEMCTL[@]}" is-active pocket-term-2 2>/dev/null || echo unknown)"
log "  MainPID: $("${SYSTEMCTL[@]}" show -p MainPID --value pocket-term-2 2>/dev/null || echo unknown)"
log "  listener: $(port_listener_pid "$HOST" "$PORT")"
log "Check: ${SYSTEMCTL[*]} status pocket-term-2 --no-pager"
if $SYSTEM_UNIT; then
  log "Logs:  journalctl -u pocket-term-2 -n 50 --no-pager"
else
  log "Logs:  journalctl --user -u pocket-term-2 -n 50 --no-pager"
fi
exit 1
