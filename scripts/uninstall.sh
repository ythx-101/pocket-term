#!/usr/bin/env bash
# pocket-term uninstall — Clean removal driven by manifest.json.
#
# Reads <prefix>/manifest.json, reverses every step via pt_lib.py (argv-only
# subprocess calls, no shell strings), restores the pre-install tailscale
# serve/funnel config from its snapshot, then verifies the prefix is empty.
#
# Usage:
#   ./uninstall.sh [--prefix DIR] [--dry-run]

set -euo pipefail

PREFIX="${HOME}/.local/share/pocket-term"
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) echo "pocket-term uninstall"; exit 0 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

MANIFEST="${PREFIX}/manifest.json"
ROUTE_SNAPSHOT="${PREFIX}/.tailscale-routes-snapshot.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PT_LIB="${SCRIPT_DIR}/pt_lib.py"

if [[ ! -f "$MANIFEST" ]]; then
  echo "No manifest found at $MANIFEST."
  echo "Nothing to uninstall via manifest. Manual cleanup: rm -rf $PREFIX"
  exit 0
fi

echo "=== pocket-term uninstall ==="
echo "Prefix: $PREFIX"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "DRY RUN: would reverse steps recorded in $MANIFEST and restore $ROUTE_SNAPSHOT"
  exit 0
fi

echo "Reversing install steps..."
if ! python3 "$PT_LIB" rollback "$MANIFEST" "$ROUTE_SNAPSHOT"; then
  echo "Completed with warnings (see above)." >&2
fi

# Remove manifest
rm -f "$MANIFEST"
echo "Manifest removed."

# Verify cleanup
REMAINING=$(ls -A "$PREFIX" 2>/dev/null || true)
if [[ -z "$REMAINING" ]]; then
  rmdir "$PREFIX" 2>/dev/null || true
  echo "Prefix directory removed (empty)."
else
  echo "NOTE: $PREFIX still contains files (may be uploads or user data):"
  echo "  $REMAINING"
  echo "  To fully remove: rm -rf $PREFIX"
fi

echo "=== Uninstall complete ==="
