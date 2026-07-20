#!/usr/bin/env bash
# Generate Web Push VAPID key pair. Prints JSON to stdout only.
# Never writes keys to disk or git — caller decides where to store them.
#
# Usage:
#   ./scripts/gen-vapid.sh
#   ./scripts/gen-vapid.sh --env   # print shell export lines for PT2_VAPID_*
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) MODE="env"; shift ;;
    -h|--help)
      echo "Usage: $0 [--env]"
      echo "  default: print { publicKey, privateKey } JSON on stdout"
      echo "  --env:   print PT2_VAPID_* export lines (subject still required)"
      exit 0
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

# Prefer local web-push from repo node_modules (after npm ci).
export NODE_PATH="${ROOT}/node_modules${NODE_PATH:+:$NODE_PATH}"

JSON="$(
  node -e "
const wp = require('web-push');
const k = wp.generateVAPIDKeys();
process.stdout.write(JSON.stringify({ publicKey: k.publicKey, privateKey: k.privateKey }));
"
)"

if [[ "$MODE" == "json" ]]; then
  echo "$JSON"
  exit 0
fi

# --env: shell-friendly; subject is a placeholder the operator must set.
PUB="$(node -e "const k=JSON.parse(process.argv[1]); process.stdout.write(k.publicKey)" "$JSON")"
PRIV="$(node -e "const k=JSON.parse(process.argv[1]); process.stdout.write(k.privateKey)" "$JSON")"
cat <<EOF
# Web Push VAPID — do not commit. Set subject to a mailto: or https: contact.
export PT2_VAPID_SUBJECT="mailto:admin@example.com"
export PT2_VAPID_PUBLIC_KEY="${PUB}"
export PT2_VAPID_PRIVATE_KEY="${PRIV}"
EOF
