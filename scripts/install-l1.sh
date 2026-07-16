#!/usr/bin/env bash
# pocket-term L1 — Persistent web terminal with enhanced mobile page.
#
# Transactional install: every step records to manifest.json as an argv list
# (never a shell string — see scripts/pt_lib.py) so rollback can't be turned
# into command injection by a hostile --prefix/--shell value.
# On failure (including signals and `exit 1` inside this script), steps are
# reversed in order and undone.
# The upload unit's credentials file lives under $PREFIX (inside $HOME by
# default) and stays readable under ProtectHome=tmpfs via BindReadOnlyPaths —
# see templates/pocket-term-upload.service.tmpl.
# Tailscale serve+funnel routes are snapshotted before changes and restored
# from that snapshot on rollback/uninstall (pt_lib.py restore_tailscale_routes).
#
# Usage:
#   ./install-l1.sh [--prefix DIR] [--port PORT] [--upload-port PORT]
#                    [--shell SHELL] [--with-upload|--without-upload]
#                    [--lang en|zh] [--theme dark|light] [--dry-run]
#
# Safety: never binds to 0.0.0.0; ttyd -c required; non-root enforced.

set -euo pipefail

PREFIX="${HOME}/.local/share/pocket-term"
PORT=7681
UPLOAD_PORT=7698
SHELL_CMD="${SHELL:-/bin/bash}"
LANG="en"
THEME="dark"
WITH_UPLOAD="detect"
DRY_RUN=false
NO_PERSIST=false

# ttyd 1.6.3 SHA256 (official GitHub release assets)
TTYD_VERSION="1.6.3"
declare -A TTYD_SHA256
TTYD_SHA256["x86_64"]="d69320cc45f51d144242935abe3443ad7d2fd1356a6732879ab175a406eafa85"
TTYD_SHA256["aarch64"]="d0fafe4acc7017ac4f4745ea67a3a71c3bf1e4d4452872c1ada3c55bfb4d3dce"
TTYD_SHA256["arm"]="eeb2f5bd98a4da76fed31781b4afdaad59e91a68e44501ec74e226a86781e5ad"
TTYD_SHA256["armhf"]="12e4bb0872cb07b27fe18e0d02f1cf8761c0051ad0d922ef4e90cb50d9409af0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --upload-port) UPLOAD_PORT="$2"; shift 2 ;;
    --shell) SHELL_CMD="$2"; shift 2 ;;
    --with-upload) WITH_UPLOAD="yes"; shift ;;
    --without-upload) WITH_UPLOAD="no"; shift ;;
    --lang) LANG="$2"; shift 2 ;;
    --theme) THEME="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --no-persist) NO_PERSIST=true; shift ;;
    -h|--help)
      echo "pocket-term L1 installer"
      exit 0 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

# ── Path safety: reject shell metacharacters ──────────────────────────
for var in PREFIX SHELL_CMD LANG THEME; do
  if [[ "${!var}" =~ [\`\$\;\|\&\>\<\(\)\{\}\[\]\#\!\\] ]]; then
    echo "ERROR: $var contains shell metacharacters — rejected." >&2
    exit 1
  fi
done

# Credentials live under $PREFIX (inside $HOME by default). The upload unit
# uses ProtectHome=tmpfs (hides the rest of $HOME behind an empty, ephemeral
# mount) plus BindReadOnlyPaths on this exact path to punch through only the
# credentials file — see templates/pocket-term-upload.service.tmpl. Verified
# with a real systemd-run test in docs/test-evidence.md; do not switch this
# back to ProtectHome=read-only/true without re-running that test, since
# read-only leaves the whole home tree visible and true+BindReadOnlyPaths on
# the same path is a known-broken systemd combination (also in the evidence).
CREDENTIALS="${PREFIX}/credentials"
MANIFEST="${PREFIX}/manifest.json"
INDEX_HTML="${PREFIX}/index.html"
LAUNCH_SCRIPT="${PREFIX}/launch.sh"
UPLOAD_SCRIPT="${PREFIX}/upload-server.py"
UPLOAD_DIR="${PREFIX}/uploads"
ROUTE_SNAPSHOT="${PREFIX}/.tailscale-routes-snapshot.json"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_PAGE="${SCRIPT_DIR}/build-page.py"
UPLOAD_SERVER_SRC="${SCRIPT_DIR}/upload-server.py"

_ROLLBACK_RAN=false
PT_LIB="${SCRIPT_DIR}/pt_lib.py"

# ── Helpers ───────────────────────────────────────────────────────────
_dry() { [[ "$DRY_RUN" == "true" ]]; }

manifest_init() {
  _dry && return
  mkdir -p "$PREFIX"
  python3 "$PT_LIB" init "$MANIFEST"
}

# manifest_add ACTION TARGET [UNDO_ARGV...]
# UNDO_ARGV, if given, is executed later as subprocess.run(UNDO_ARGV) — a
# real argv list, never a shell string. Every element reaches pt_lib.py as
# its own argv slot, so embedded shell metacharacters or newlines in e.g.
# $PREFIX-derived paths are inert data, not re-parsed shell syntax.
manifest_add() {
  local action="$1" target="$2"; shift 2
  if _dry; then echo "  [DRY] $action: $target"; return; fi
  python3 "$PT_LIB" add "$MANIFEST" "$action" "$target" "$@"
}

manifest_rollback() {
  [[ "$_ROLLBACK_RAN" == "true" ]] && return
  _ROLLBACK_RAN=true
  _dry && return
  [[ ! -f "$MANIFEST" ]] && return
  echo "=== ROLLBACK: reversing install steps ==="
  python3 "$PT_LIB" rollback "$MANIFEST" "$ROUTE_SNAPSHOT"
  rm -f "$MANIFEST"
}

# ── Trap ──────────────────────────────────────────────────────────────
# EXIT is included (not just ERR/INT/TERM) because bash's ERR trap does NOT
# fire for an explicit `exit N` inside the script (only for a command failing
# under `set -e`) — several checks below call `exit 1` directly, and without
# EXIT here those failures would skip rollback entirely and leave a half
# installed prefix behind. Disarmed with `trap - ... EXIT` on a clean finish.
trap 'manifest_rollback; echo "FATAL: install failed — rolled back." >&2; exit 1' ERR INT TERM EXIT

# ── ttyd: download pinned 1.6.3 + sha256 ─────────────────────────────
resolve_ttyd() {
  local arch="$(uname -m)" ttyd_arch expected
  case "$arch" in
    x86_64) ttyd_arch="x86_64" ;;
    aarch64|arm64) ttyd_arch="aarch64" ;;
    armv7l) ttyd_arch="arm" ;;
    armv6l) ttyd_arch="armhf" ;;
    *)
      echo "ERROR: unsupported architecture: $arch" >&2; exit 1 ;;
  esac
  expected="${TTYD_SHA256[$ttyd_arch]:-}"
  [[ -n "$expected" ]] || { echo "ERROR: no SHA256 for $ttyd_arch" >&2; exit 1; }

  TTYD_BIN="/tmp/pocket-term-ttyd-${TTYD_VERSION}"
  if [[ ! -x "$TTYD_BIN" ]]; then
    if _dry; then
      echo "  [DRY] would download ttyd ${TTYD_VERSION} for ${ttyd_arch} and verify SHA256 ${expected}"
      return
    fi
    local url="https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}"
    echo "Downloading ttyd ${TTYD_VERSION} for ${ttyd_arch}..."
    curl -fsSLo "$TTYD_BIN" "$url"
    chmod +x "$TTYD_BIN"
  fi
  # Always verify SHA256 — even a binary cached from a previous run, and
  # even in --dry-run once a cached copy exists (cheap, catches tampering).
  local actual
  actual=$(sha256sum "$TTYD_BIN" 2>/dev/null | awk '{print $1}')
  if [[ "$actual" != "$expected" ]]; then
    echo "ERROR: ttyd SHA256 mismatch!" >&2
    echo "  expected: $expected" >&2
    echo "  got:      $actual" >&2
    rm -f "$TTYD_BIN"
    exit 1
  fi
  echo "ttyd ${TTYD_VERSION} verified OK (SHA256)."
  TTYD_VERSION_STR=$("$TTYD_BIN" --version 2>&1 | head -1)
  echo "ttyd: $TTYD_VERSION_STR"
}

# ── Safety checks ─────────────────────────────────────────────────────
if [[ "$(id -u)" -eq 0 ]]; then
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  WARNING: Running as root!                                   ║"
  echo "║  Press Ctrl-C within 5s to abort.                            ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  sleep 5
fi
_dry && echo "DRY RUN: no changes will be made."

if [[ "$WITH_UPLOAD" == "detect" ]]; then
  if tailscale status --json >/dev/null 2>&1; then WITH_UPLOAD="yes"
  else
    echo "NOTE: Tailscale not detected. Upload (/up) disabled."
    echo "      Install Tailscale and re-run with --with-upload."
    WITH_UPLOAD="no"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════
# MAIN INSTALL
# ═══════════════════════════════════════════════════════════════════════
echo "=== pocket-term L1 install ==="
echo "Prefix: $PREFIX  Port: $PORT  Upload: $WITH_UPLOAD  Theme: $THEME  Lang: $LANG"
echo ""

resolve_ttyd
manifest_init

# ── Step 1: Credentials ───────────────────────────────────────────────
echo "[1/8] Generating credentials..."
if _dry; then echo "  [DRY] mkdir + credentials"; else
  mkdir -p "$PREFIX"
  PASSWORD=$(python3 -c "import secrets; print(secrets.token_urlsafe(18))")
  echo "pocket:${PASSWORD}" > "$CREDENTIALS"
  chmod 600 "$CREDENTIALS"
fi
manifest_add "write" "$CREDENTIALS" rm -f "$CREDENTIALS"

# ── Step 2: Extract ttyd HTML ─────────────────────────────────────────
echo "[2/8] Extracting ttyd base HTML..."
TTYD_ORIG="${PREFIX}/index-orig.html"
if _dry; then echo "  [DRY] extract HTML"; else
  if [[ ! -s "$TTYD_ORIG" ]]; then
    EXTRACT_PORT=$((PORT + 100))
    EXTRACT_PASS=$(python3 -c "import secrets; print(secrets.token_urlsafe(12))")
    "$TTYD_BIN" -i 127.0.0.1 -p "$EXTRACT_PORT" -c "extract:${EXTRACT_PASS}" /bin/true &
    EXTRACT_PID=$!
    sleep 2
    curl -s -u "extract:${EXTRACT_PASS}" -o "$TTYD_ORIG" "http://127.0.0.1:${EXTRACT_PORT}/" || true
    kill "$EXTRACT_PID" 2>/dev/null || true; wait "$EXTRACT_PID" 2>/dev/null || true
    [[ -s "$TTYD_ORIG" ]] || {
      echo "ERROR: Failed to extract ttyd base HTML from ttyd ${TTYD_VERSION}." >&2
      echo "  Ensure port $EXTRACT_PORT is free." >&2
      exit 1
    }
  fi
fi
manifest_add "extract" "$TTYD_ORIG" rm -f "$TTYD_ORIG"

# ── Step 3: Build enhanced page ───────────────────────────────────────
echo "[3/8] Building enhanced terminal page..."
if _dry; then echo "  [DRY] build-page"; else
  UPLOAD_FLAG=""; [[ "$WITH_UPLOAD" == "yes" ]] && UPLOAD_FLAG="--with-upload"
  python3 "$BUILD_PAGE" --index-src "$TTYD_ORIG" --output "$INDEX_HTML" \
    --lang "$LANG" --theme "$THEME" $UPLOAD_FLAG
fi
manifest_add "build" "$INDEX_HTML" rm -f "$INDEX_HTML"

# ── Step 4: Launch script ─────────────────────────────────────────────
echo "[4/8] Writing launch script..."
THEME_JSON_DARK='{"background":"#191724","foreground":"#e0def4","cursor":"#f6c177","cursorAccent":"#191724","selectionBackground":"#403d52","black":"#26233a","red":"#eb6f92","green":"#31748f","yellow":"#f6c177","blue":"#c4a7e7","magenta":"#c4a7e7","cyan":"#ebbcba","white":"#e0def4","brightBlack":"#6e6a86","brightRed":"#eb6f92","brightGreen":"#31748f","brightYellow":"#f6c177","brightBlue":"#c4a7e7","brightMagenta":"#c4a7e7","brightCyan":"#ebbcba","brightWhite":"#e0def4"}'
THEME_JSON_LIGHT='{"background":"#faf4ed","foreground":"#575279","cursor":"#286983","cursorAccent":"#faf4ed","selectionBackground":"#6c6f93","black":"#f2e9e1","red":"#b4637a","green":"#286983","yellow":"#ea9d34","blue":"#907aa9","magenta":"#907aa9","cyan":"#d7827e","white":"#575279","brightBlack":"#9893a5","brightRed":"#b4637a","brightGreen":"#286983","brightYellow":"#ea9d34","brightBlue":"#907aa9","brightMagenta":"#907aa9","brightCyan":"#d7827e","brightWhite":"#575279"}'
THEME_JSON="$THEME_JSON_DARK"; [[ "$THEME" == "light" ]] && THEME_JSON="$THEME_JSON_LIGHT"
if _dry; then echo "  [DRY] write launch script"; else
  sed -e "s|__PORT__|$PORT|g" -e "s|__COMMAND__|$SHELL_CMD|g" \
      -e "s|__INDEX__|$INDEX_HTML|g" -e "s|__CREDENTIALS__|$CREDENTIALS|g" \
      -e "s|__THEME__|$THEME_JSON|g" \
      "${SCRIPT_DIR}/templates/launch-ttyd.sh.tmpl" > "$LAUNCH_SCRIPT"
  chmod +x "$LAUNCH_SCRIPT"
fi
manifest_add "write" "$LAUNCH_SCRIPT" rm -f "$LAUNCH_SCRIPT"

# ── Step 5: Upload server (if enabled) ────────────────────────────────
if [[ "$WITH_UPLOAD" == "yes" ]]; then
  echo "[5/8] Setting up upload server..."
  if _dry; then echo "  [DRY] upload setup"; else
    cp "$UPLOAD_SERVER_SRC" "$UPLOAD_SCRIPT"
    chmod +x "$UPLOAD_SCRIPT"
    mkdir -p "$UPLOAD_DIR"
  fi
  manifest_add "write" "$UPLOAD_SCRIPT" rm -f "$UPLOAD_SCRIPT"
  manifest_add "mkdir" "$UPLOAD_DIR" rm -rf "$UPLOAD_DIR"

  # ── Tailscale serve+funnel ──────────────────────────────────────────
  # Every tailscale call below is wrapped in `timeout` — an unreachable
  # control plane must fail fast with a clear error, not hang the installer
  # forever (previously observed: a bare `tailscale serve --set-path` with
  # no timeout can block indefinitely). A failure here is fatal (exit 1),
  # which triggers the EXIT trap -> manifest_rollback -> real route restore,
  # instead of being swallowed as a WARNING while the install continues.
  echo "  Configuring tailscale serve + funnel for /up..."
  if _dry; then echo "  [DRY] snapshot + configure tailscale routes"; else
    # ONE snapshot covers both: `tailscale serve status --json` and
    # `tailscale funnel status --json` print the exact same underlying
    # ipn.ServeConfig (TCP/Web/AllowFunnel/Services all together) — funnel
    # has no separate config domain. See pt_lib.py's module docstring for
    # the source references. A second, separate ".funnel" snapshot would
    # just be a redundant copy of the same JSON.
    timeout 15 tailscale serve status --json > "$ROUTE_SNAPSHOT" 2>/dev/null || echo '{}' > "$ROUTE_SNAPSHOT"

    if timeout 20 tailscale serve --set-path /up --bg "http://127.0.0.1:${UPLOAD_PORT}"; then
      echo "  tailscale serve: OK"
    else
      echo "ERROR: tailscale serve failed or timed out — /up routing via Tailscale unavailable." >&2
      echo "  Re-run with --without-upload, or fix Tailscale (tailscale status) and retry." >&2
      exit 1
    fi

    if timeout 20 tailscale funnel --set-path /up --bg "http://127.0.0.1:${UPLOAD_PORT}"; then
      echo "  tailscale funnel: OK"
    else
      echo "ERROR: tailscale funnel failed or timed out (needs Funnel enabled in the admin console)." >&2
      echo "  Re-run with --without-upload if you only need tailnet-local access via serve." >&2
      exit 1
    fi
  fi
  # No per-step undo argv here: actual removal + declarative restore of the
  # pre-install serve/funnel config from $ROUTE_SNAPSHOT is handled by
  # pt_lib.py's restore_tailscale_routes(), invoked once at the end of every
  # rollback/uninstall (see manifest_rollback and uninstall.sh). This entry
  # exists for audit visibility in manifest.json.
  manifest_add "tailscale" "serve+funnel /up"

  # ── systemd upload unit (Linux) ─────────────────────────────────────
  if [[ "$(uname -s)" == "Linux" ]]; then
    UNIT_SRC="${SCRIPT_DIR}/templates/pocket-term-upload.service.tmpl"
    UNIT_DST="${PREFIX}/pocket-term-upload.service"
    SYSTEMD_UNIT="${HOME}/.config/systemd/user/pocket-term-upload.service"
    UPLOAD_CMD="python3 $UPLOAD_SCRIPT --upload-dir $UPLOAD_DIR --port $UPLOAD_PORT --credentials $CREDENTIALS"
    if _dry; then echo "  [DRY] upload systemd unit"; else
      sed -e "s|__USER__|$(whoami)|g" -e "s|__GROUP__|$(id -gn)|g" \
          -e "s|__UPLOAD_SCRIPT__|${UPLOAD_CMD}|g" -e "s|__UPLOAD_DIR__|$UPLOAD_DIR|g" \
          -e "s|__CREDENTIALS_FILE__|$CREDENTIALS|g" \
          "$UNIT_SRC" > "$UNIT_DST"
    fi
    manifest_add "write" "$UNIT_DST" rm -f "$UNIT_DST"
    if [[ "$NO_PERSIST" != "true" ]]; then
      if _dry; then echo "  [DRY] enable+start upload unit"; else
        mkdir -p "$(dirname "$SYSTEMD_UNIT")"
        cp "$UNIT_DST" "$SYSTEMD_UNIT"
        manifest_add "write" "$SYSTEMD_UNIT" rm -f "$SYSTEMD_UNIT"
        if ! systemctl --user daemon-reload; then
          echo "ERROR: systemctl --user daemon-reload failed (may need: loginctl enable-linger $(whoami))" >&2
          exit 1
        fi
        manifest_add "systemd-reload" "daemon-reload" systemctl --user daemon-reload
        if ! systemctl --user enable pocket-term-upload.service; then
          echo "ERROR: upload service enable failed (journalctl --user -u pocket-term-upload)" >&2
          exit 1
        fi
        manifest_add "systemd-enable" "pocket-term-upload.service" systemctl --user disable pocket-term-upload.service
        if ! systemctl --user start pocket-term-upload.service; then
          echo "ERROR: upload service start failed (journalctl --user -u pocket-term-upload)" >&2
          exit 1
        fi
        manifest_add "systemd-start" "pocket-term-upload.service" systemctl --user stop pocket-term-upload.service
      fi
    fi
  elif [[ "$(uname -s)" == "Darwin" ]]; then
    echo "  NOTE: macOS upload service is manual-only (launchd plist not yet automated)."
    echo "    See docs/security.md 'macOS upload (manual-only)' for the exact command."
    echo "    Start manually: python3 $UPLOAD_SCRIPT --upload-dir $UPLOAD_DIR --port $UPLOAD_PORT --credentials $CREDENTIALS &"
  fi
else
  echo "[5/8] Upload: DISABLED"
fi

# ── Step 6: Service unit ──────────────────────────────────────────────
echo "[6/8] Installing service unit..."
OS_NAME="$(uname -s)"
if [[ "$OS_NAME" == "Linux" ]]; then
  UNIT_SRC="${SCRIPT_DIR}/templates/pocket-term.service.tmpl"
  UNIT_DST="${PREFIX}/pocket-term.service"
  SYSTEMD_UNIT="${HOME}/.config/systemd/user/pocket-term.service"
  if _dry; then echo "  [DRY] systemd unit"; else
    sed -e "s|__USER__|$(whoami)|g" -e "s|__GROUP__|$(id -gn)|g" \
        -e "s|__HOME__|$HOME|g" -e "s|__PATH__|$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin|g" \
        -e "s|__LAUNCH_SCRIPT__|$LAUNCH_SCRIPT|g" \
        "$UNIT_SRC" > "$UNIT_DST"
  fi
  manifest_add "write" "$UNIT_DST" rm -f "$UNIT_DST"
  if [[ "$NO_PERSIST" != "true" ]]; then
    if _dry; then echo "  [DRY] enable+start service unit"; else
      mkdir -p "$(dirname "$SYSTEMD_UNIT")"
      cp "$UNIT_DST" "$SYSTEMD_UNIT"
      manifest_add "write" "$SYSTEMD_UNIT" rm -f "$SYSTEMD_UNIT"
      if ! systemctl --user daemon-reload; then
        echo "ERROR: daemon-reload failed (may need: loginctl enable-linger $(whoami))" >&2
        exit 1
      fi
      manifest_add "systemd-reload" "daemon-reload" systemctl --user daemon-reload
      if ! systemctl --user enable pocket-term.service; then
        echo "ERROR: service enable failed (journalctl --user -u pocket-term)" >&2
        exit 1
      fi
      manifest_add "systemd-enable" "pocket-term.service" systemctl --user disable pocket-term.service
      if ! systemctl --user start pocket-term.service; then
        echo "ERROR: service start failed (journalctl --user -u pocket-term)" >&2
        exit 1
      fi
      manifest_add "systemd-start" "pocket-term.service" systemctl --user stop pocket-term.service
    fi
  fi
elif [[ "$OS_NAME" == "Darwin" ]]; then
  PLIST_DST="${HOME}/Library/LaunchAgents/com.pocket-term.terminal.plist"
  if _dry; then echo "  [DRY] launchd plist"; else
    sed -e "s|__LAUNCH_SCRIPT__|$LAUNCH_SCRIPT|g" -e "s|__PREFIX__|$PREFIX|g" \
        -e "s|__HOME__|$HOME|g" -e "s|__PATH__|$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin|g" \
        "${SCRIPT_DIR}/templates/launchd.plist.tmpl" > "$PLIST_DST"
  fi
  manifest_add "write" "$PLIST_DST" rm -f "$PLIST_DST"
  if [[ "$NO_PERSIST" != "true" ]]; then
    if _dry; then echo "  [DRY] launchctl load"; else
      if ! launchctl load "$PLIST_DST"; then
        echo "ERROR: launchctl load failed." >&2
        exit 1
      fi
    fi
    manifest_add "launchd-load" "$PLIST_DST" launchctl unload "$PLIST_DST"
  fi
else
  echo "WARNING: Unknown OS '$OS_NAME'. No service unit installed." >&2
  echo "  Start manually: $LAUNCH_SCRIPT" >&2
fi

# ── Step 7: Finalize ──────────────────────────────────────────────────
echo "[7/8] Finalizing..."
_dry || manifest_add "complete" "install-l1"

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  pocket-term L1 installed!"
echo "  Prefix:     $PREFIX"
echo "  Port:       $PORT"
echo "  User:       pocket"
CRED_PASS=$(head -1 "$CREDENTIALS" 2>/dev/null | cut -d: -f2 || echo "(see credentials file)")
echo "  Password:   $CRED_PASS"
echo "  Local URL:  http://127.0.0.1:${PORT}"
[[ "$WITH_UPLOAD" == "yes" ]] && echo "  Upload:     http://127.0.0.1:${PORT}/up"
echo "  Uninstall:  ${SCRIPT_DIR}/uninstall.sh --prefix $PREFIX"
echo "══════════════════════════════════════════════════════════════"

trap - ERR INT TERM EXIT
