#!/usr/bin/env bash
# pocket-term L0 — Zero-config web terminal via ttyd + Cloudflare Quick Tunnel.
# One binary, one script, zero accounts, zero domains, zero persistence.
# The tunnel URL changes on every restart (by design).
#
# Usage:
#   ./l0-quick.sh [--port PORT] [--user USER] [--no-tunnel]
#
#   --port PORT        Local port for ttyd (default 7682).
#   --user USER        Basic-auth username (default "pocket").
#   --no-tunnel        Skip Cloudflare tunnel; bind ttyd directly (dev/test only).
#
# Safety: ttyd always binds 127.0.0.1 with basic auth (-c user:password).
# The quick tunnel is transport-only; auth is handled by ttyd -c.
#
# Dependencies (auto-installed to /tmp if missing):
#   ttyd 1.6.3  https://github.com/tsl0922/ttyd
#   cloudflared  https://github.com/cloudflare/cloudflared

set -euo pipefail

PORT="${POCKET_PORT:-7682}"
USERNAME="${POCKET_USER:-pocket}"
NO_TUNNEL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --user) USERNAME="$2"; shift 2 ;;
    --no-tunnel) NO_TUNNEL=true; shift ;;
    -h|--help)
      echo "pocket-term L0 — Zero-config web terminal"
      echo "Usage: $0 [--port PORT] [--user USER] [--no-tunnel]"
      echo "  --port PORT     Local port (default 7682)"
      echo "  --user USER     Basic-auth username (default pocket)"
      echo "  --no-tunnel     Skip Cloudflare tunnel; bind directly"
      exit 0 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

# ── Platform / architecture detection ─────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Linux)  OS="linux" ;;
  Darwin) OS="darwin" ;;
  *)
    echo "ERROR: Unsupported OS: $OS. WSL recommended on Windows." >&2
    exit 1 ;;
esac

# ttyd 1.6.3 binary naming: x86_64, aarch64, arm, armhf
# Linux-only: ttyd 1.6.3 does not ship macOS binaries.
case "$ARCH" in
  x86_64)        TTYD_ARCH="x86_64";  CF_ARCH="amd64" ;;
  aarch64|arm64) TTYD_ARCH="aarch64"; CF_ARCH="arm64" ;;
  armv7l)        TTYD_ARCH="arm";     CF_ARCH="arm" ;;
  armv6l)        TTYD_ARCH="armhf";   CF_ARCH="armhf" ;;
  *)
    echo "ERROR: Unsupported architecture: $ARCH" >&2
    exit 1 ;;
esac

if [[ "$OS" == "darwin" ]]; then
  echo "NOTE: ttyd 1.6.3 has no pre-built macOS binary." >&2
  echo "      macOS users: install via Homebrew (brew install ttyd)." >&2
  echo "      WARNING: Homebrew ships ttyd >=1.7.x; enhanced mobile page" >&2
  echo "      (L1) only works with 1.6.3. L0 bare page works with any version." >&2
  echo "      Using system ttyd..." >&2
  TTYD_BIN="ttyd"
elif [[ "$OS" == "linux" ]]; then
  # ── Resolve ttyd 1.6.3 (pinned for page compatibility) ────────────────
  TTYD_VERSION="1.6.3"
  # SHA256 checksums computed from official GitHub release assets.
  declare -A TTYD_SHA256
  TTYD_SHA256["x86_64"]="d69320cc45f51d144242935abe3443ad7d2fd1356a6732879ab175a406eafa85"
  TTYD_SHA256["aarch64"]="d0fafe4acc7017ac4f4745ea67a3a71c3bf1e4d4452872c1ada3c55bfb4d3dce"
  TTYD_SHA256["arm"]="eeb2f5bd98a4da76fed31781b4afdaad59e91a68e44501ec74e226a86781e5ad"
  TTYD_SHA256["armhf"]="12e4bb0872cb07b27fe18e0d02f1cf8761c0051ad0d922ef4e90cb50d9409af0"

  TTYD_EXPECTED="${TTYD_SHA256[$TTYD_ARCH]:-}"
  if [[ -z "$TTYD_EXPECTED" ]]; then
    echo "ERROR: ttyd 1.6.3 has no published binary for $TTYD_ARCH." >&2
    exit 1
  fi

  TTYD_BIN="/tmp/pocket-term-ttyd-${TTYD_VERSION}"
  if [[ ! -x "$TTYD_BIN" ]]; then
    TTYD_URL="https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${TTYD_ARCH}"
    echo "Downloading ttyd ${TTYD_VERSION} for ${OS}/${TTYD_ARCH}..."
    curl -fsSLo "$TTYD_BIN" "$TTYD_URL"
    chmod +x "$TTYD_BIN"
  fi
  # Always verify SHA256 — even if binary was cached from a previous run
  ACTUAL=$(sha256sum "$TTYD_BIN" | awk '{print $1}')
  if [[ "$ACTUAL" != "$TTYD_EXPECTED" ]]; then
    echo "ERROR: ttyd SHA256 mismatch!" >&2
    echo "  expected: $TTYD_EXPECTED" >&2
    echo "  got:      $ACTUAL" >&2
    rm -f "$TTYD_BIN"
    exit 1
  fi
  echo "ttyd ${TTYD_VERSION} verified OK (SHA256)."
fi

# ── Resolve cloudflared ───────────────────────────────────────────────
CF_BIN="/tmp/pocket-term-cloudflared"
if [[ ! -x "$CF_BIN" ]]; then
  CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${OS}-${CF_ARCH}"
  echo "Downloading cloudflared for ${OS}/${ARCH}..."
  curl -fsSLo "$CF_BIN" "$CF_URL"
  chmod +x "$CF_BIN"
fi

# ── Generate random password ──────────────────────────────────────────
PASSWORD=$(python3 -c "import secrets; print(secrets.token_urlsafe(18))" 2>/dev/null || \
           python3 -c "import secrets,base64; print(base64.urlsafe_b64encode(secrets.token_bytes(18)).decode().rstrip('='))")
CRED_FILE="/tmp/pocket-term-credentials-$$"
echo "${USERNAME}:${PASSWORD}" > "$CRED_FILE"
chmod 600 "$CRED_FILE"

# ── Cleanup on exit ───────────────────────────────────────────────────
cleanup() {
  echo ""
  echo "pocket-term L0 stopping..."
  [[ -n "${TTYD_PID:-}" ]] && kill "$TTYD_PID" 2>/dev/null || true
  [[ -n "${CF_PID:-}" ]] && kill "$CF_PID" 2>/dev/null || true
  rm -f "$CRED_FILE"
  wait 2>/dev/null || true
  echo "Cleaned up. Goodbye."
}
trap cleanup EXIT INT TERM

# ── Start ttyd ────────────────────────────────────────────────────────
echo "Starting ttyd on 127.0.0.1:${PORT}..."
"$TTYD_BIN" \
  -i 127.0.0.1 \
  -p "$PORT" \
  -c "${USERNAME}:${PASSWORD}" \
  -t "disableLeaveAlert=true" \
  -t "disableResizeOverlay=true" \
  "$SHELL" &
TTYD_PID=$!
sleep 1

# Verify ttyd is alive
if ! kill -0 "$TTYD_PID" 2>/dev/null; then
  echo "ERROR: ttyd failed to start." >&2
  exit 1
fi

# ── Health check ──────────────────────────────────────────────────────
echo -n "Health check (127.0.0.1:${PORT})..."
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -u "${USERNAME}:${PASSWORD}" \
  "http://127.0.0.1:${PORT}/" 2>/dev/null || echo "000")
if [[ "$HTTP_CODE" != "200" ]]; then
  echo " FAIL (HTTP $HTTP_CODE)"
  echo "ERROR: ttyd not responding correctly." >&2
  exit 1
fi
echo " OK (200)"

# ── Anonymous auth check ──────────────────────────────────────────────
ANON_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  "http://127.0.0.1:${PORT}/" 2>/dev/null || echo "000")
if [[ "$ANON_CODE" == "200" ]]; then
  echo "ERROR: ttyd is accessible WITHOUT basic auth!" >&2
  exit 1
fi

# ── Start cloudflared tunnel or print local URL ───────────────────────
if $NO_TUNNEL; then
  echo ""
  echo "══════════════════════════════════════════════════════════════"
  echo "  pocket-term L0 (local-only)"
  echo "  URL:   http://127.0.0.1:${PORT}"
  echo "  User:  ${USERNAME}"
  echo "  Pass:  ${PASSWORD}"
  echo ""
  echo "  WARNING: No tunnel. Only accessible from this machine."
  echo "  Press Ctrl-C to stop."
  echo "══════════════════════════════════════════════════════════════"
  wait "$TTYD_PID"
else
  echo "Starting Cloudflare quick tunnel..."
  "$CF_BIN" tunnel --url "http://127.0.0.1:${PORT}" \
    --no-autoupdate 2>&1 | while IFS= read -r line; do
    echo "$line"
    # Extract trycloudflare.com URL from output
    if [[ "$line" =~ https://[a-zA-Z0-9.-]+\.trycloudflare\.com ]]; then
      CF_URL="${BASH_REMATCH[0]}"
      echo ""
      echo "══════════════════════════════════════════════════════════════"
      echo "  pocket-term L0"
      echo "  URL:   ${CF_URL}"
      echo "  User:  ${USERNAME}"
      echo "  Pass:  ${PASSWORD}"
      echo ""
      echo "  Open in browser → enter credentials → your terminal."
      echo "  Press Ctrl-C to stop."
      echo "══════════════════════════════════════════════════════════════"
    fi
  done &
  CF_PID=$!
  wait "$TTYD_PID" || true
fi
