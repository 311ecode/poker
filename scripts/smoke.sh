#!/usr/bin/env bash
# Poker deploy smoke — the AC9 proof (public origin: HTTP room create + a raw
# WebSocket hello → vote flow from two sockets, through the Cloudflare tunnel).
#
#   bash scripts/smoke.sh                 # against https://poker.imre.dev
#   bash scripts/smoke.sh --origin http://localhost:64100
#
# The protocol work lives in scripts/smoke.mjs (no dependencies, hand-rolled
# RFC 6455 client). This wrapper only pins the fleet node.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${NODE_DIR:-/home/imre/.nvm/versions/node/v26.8.1}/bin:/usr/local/bin:/usr/bin:/bin"

exec node "$ROOT/scripts/smoke.mjs" "$@"
