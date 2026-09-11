#!/usr/bin/env bash
# Build the plugin, install it, and confirm the running game actually loaded it.
#
# OpenRCT2's hot reloading is quiet when it does not fire, and testing against a
# stale bundle wastes far more time than this check costs.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$REPO_ROOT/servers/openrct2"
PORT="${FREEPLAY_BRIDGE_PORT:-8080}"

npm --prefix "$SERVER" run build >/dev/null
npm --prefix "$SERVER" run copy >/dev/null

EXPECTED=$(grep -oE 'BUILD_ID *= *"[0-9A-Z]+"' "$SERVER/out/mcp.js" | head -1 | grep -oE '"[0-9A-Z]+"' | tr -d '"')
echo "built $EXPECTED"

live_build() {
  curl -s -m 3 \
    -H "Accept: application/json, text/event-stream" \
    -H "Content-Type: application/json" \
    -X POST "http://127.0.0.1:${PORT}/mcp" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"deploy","version":"1"}}}' \
    2>/dev/null | sed -n 's/.*"version":"0\.1\.0+\([0-9A-Z]*\)".*/\1/p'
}

if ! curl -fsS -m 3 "http://127.0.0.1:${PORT}/v1" >/dev/null 2>&1; then
  echo "bridge not answering; start OpenRCT2 and load a scenario, then rerun."
  exit 1
fi

for _ in $(seq 1 20); do
  if [ "$(live_build)" = "$EXPECTED" ]; then
    echo "game is running $EXPECTED"
    exit 0
  fi
  python3 -c 'import time; time.sleep(1)'
done

cat >&2 <<EOF
error: the game is still running build "$(live_build)", not "$EXPECTED".

Hot reloading did not pick this up. Either enable it
([plugin] enable_hot_reloading in config.ini, with the game closed) or restart
OpenRCT2. Do not test until this matches, or you are testing old code.
EOF
exit 1
