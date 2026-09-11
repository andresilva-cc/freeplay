#!/usr/bin/env bash
# Start a Freeplay run against a running OpenRCT2.
#
# Everything pi needs lives in ./pi, so this never touches your global pi setup.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MCP_ADAPTER_VERSION="${MCP_ADAPTER_VERSION:-2.33.0}"

# pi discovers .mcp.json relative to the cwd, so the run must happen from the repo
# root or the bridge is silently not configured at all.
cd "$REPO_ROOT"

if [ ! -f "$REPO_ROOT/.env" ]; then
  echo "error: no .env found. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. "$REPO_ROOT/.env"
set +a

: "${OMLX_API_KEY:?set OMLX_API_KEY in .env}"
: "${OMLX_MODEL:?set OMLX_MODEL in .env}"
# The port is fixed in servers/openrct2/src/index.ts (BRIDGE_PORT); change it there.
BRIDGE_URL="http://127.0.0.1:8080"

# pi/models.json is the single source for the endpoint; pi does not expand $ENV there.
MODEL_BASE_URL=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["providers"]["omlx"]["baseUrl"])' "$REPO_ROOT/pi/models.json")

if ! curl -fsS -m 3 "${BRIDGE_URL}/v1" >/dev/null 2>&1; then
  cat >&2 <<EOF
error: the OpenRCT2 bridge is not answering on ${BRIDGE_URL}.

  1. Build the plugin:   npm --prefix servers/openrct2 install && npm --prefix servers/openrct2 run build
  2. Install it:         npm --prefix servers/openrct2 run copy
  3. Start OpenRCT2 and load a scenario.

The in-game console should print "Server listening on 127.0.0.1:8080".
EOF
  exit 1
fi

if ! curl -fsS -m 5 -H "Authorization: Bearer ${OMLX_API_KEY}" "${MODEL_BASE_URL}/models" >/dev/null 2>&1; then
  echo "error: no answer from ${MODEL_BASE_URL}. Is oMLX running, and is OMLX_API_KEY right?" >&2
  echo "       The endpoint is set in pi/models.json, not .env." >&2
  exit 1
fi

# prompt.md is the whole system prompt: pi replaces its default when SYSTEM.md exists.
cp "$REPO_ROOT/games/openrct2/prompt.md" "$REPO_ROOT/pi/SYSTEM.md"

# Confirm the game is running the plugin we think it is before spending a run on it.
BUNDLE="$REPO_ROOT/servers/openrct2/out/mcp.js"

if ! LIVE_BUILD=$(curl -s -m 3 \
  -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" \
  -X POST "${BRIDGE_URL}/mcp" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"run","version":"1"}}}' \
  | sed -n 's/.*"version":"0\.1\.0+\([0-9A-Z]*\)".*/\1/p'); then
  echo "warning: could not read the running plugin's build id from ${BRIDGE_URL}/mcp." >&2
  echo "         skipping the stale-plugin check; the run may be testing old code." >&2
  LIVE_BUILD=""
fi

if [ ! -f "$BUNDLE" ]; then
  echo "error: no built plugin at servers/openrct2/out/mcp.js, so the running build" >&2
  echo "       cannot be checked against the repo. Run ./scripts/deploy-plugin.sh." >&2
  exit 1
fi

BUILT=$(grep -oE 'BUILD_ID *= *"[0-9A-Z]+"' "$BUNDLE" | head -1 | grep -oE '"[0-9A-Z]+"' | tr -d '"') || BUILT=""

if [ -z "$BUILT" ]; then
  echo "warning: no BUILD_ID in servers/openrct2/out/mcp.js; cannot tell whether the" >&2
  echo "         game is running this build. Rebuild with ./scripts/deploy-plugin.sh." >&2
elif [ "$LIVE_BUILD" != "$BUILT" ]; then
  echo "warning: game is running plugin build ${LIVE_BUILD:-unknown}, repo has ${BUILT}." >&2
  echo "         run ./scripts/deploy-plugin.sh first." >&2
fi

export PI_CODING_AGENT_DIR="$REPO_ROOT/pi"
export PI_CODING_AGENT_SESSION_DIR="$REPO_ROOT/pi/sessions"

echo "bridge:  ${BRIDGE_URL}"
echo "model:   ${OMLX_MODEL} via ${MODEL_BASE_URL}"
echo

# --no-builtin-tools drops pi's own tools, and -xt mcp hides the adapter's proxy tool
# because directTools already registers the bridge's tools natively. The adapter also
# registers mcpScript; that one is turned off with "settings": {"scriptMode": false}
# in .mcp.json, so the bridge's tools really are the only ones the model sees.
# Drop `-xt mcp` if tool registration ever misbehaves.
exec pi \
  --provider omlx \
  --model "$OMLX_MODEL" \
  --no-builtin-tools \
  --no-context-files \
  --no-skills \
  --no-prompt-templates \
  --exclude-tools mcp \
  --extension "npm:pi-mcp-adapter@${MCP_ADAPTER_VERSION}" \
  --name freeplay-openrct2 \
  "$@"
