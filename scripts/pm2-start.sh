#!/usr/bin/env bash
# Boot the poker app under pm2 and snapshot it for `pm2 resurrect`.
#
# This is what the systemd unit (`systemd/poker.service`) runs on boot / on
# restart. It is safe to run repeatedly: against an already-running daemon it
# simply (re)starts the app and re-saves the dump.
#
# pm2 state lives in the project-local PM2_HOME (default: <repo>/.pm2) so the
# daemon never touches a shared ~/.pm2 — or offtube's.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PM2_HOME="${PM2_HOME:-$ROOT/.pm2}"

# nvm installs are not on systemd's PATH by default, so put the right node in
# front and include the project-local node_modules/.bin (where pm2 lives).
# Override with NODE_DIR if your node lives elsewhere.
export PATH="${NODE_DIR:-/home/imre/.nvm/versions/node/v26.8.1}/bin:$ROOT/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"

cd "$ROOT"
pm2 start ecosystem.config.cjs >/dev/null
pm2 save >/dev/null
