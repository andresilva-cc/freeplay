#!/usr/bin/env bash
# Start a Freeplay run against a running OpenRCT2.
#
# Everything pi needs lives in ./pi, so this never touches your global pi setup.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MCP_ADAPTER_VERSION="${MCP_ADAPTER_VERSION:-2.33.0}"

if [ ! -f "$REPO_ROOT/.env" ]; then
  echo "error: no .env found. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. "$REPO_ROOT/.env"
set +a

: "${OMLX_BASE_URL:?set OMLX_BASE_URL in .env}"
: "${OMLX_API_KEY:?set OMLX_API_KEY in .env}"
: "${OMLX_MODEL:?set OMLX_MODEL in .env}"
BRIDGE_PORT="${FREEPLAY_BRIDGE_PORT:-8080}"
BRIDGE_URL="http://127.0.0.1:${BRIDGE_PORT}"

if ! curl -fsS -m 3 "${BRIDGE_URL}/v1" >/dev/null 2>&1; then
  cat >&2 <<EOF
error: the OpenRCT2 bridge is not answering on ${BRIDGE_URL}.

  1. Build the plugin:   npm --prefix servers/openrct2 install && npm --prefix servers/openrct2 run build
  2. Install it:         npm --prefix servers/openrct2 run copy
  3. Start OpenRCT2 and load a scenario.

The in-game console should print "Server listening on 127.0.0.1:${BRIDGE_PORT}".
EOF
  exit 1
fi

if ! curl -fsS -m 5 -H "Authorization: Bearer ${OMLX_API_KEY}" "${OMLX_BASE_URL}/models" >/dev/null 2>&1; then
  echo "error: no answer from ${OMLX_BASE_URL}. Is oMLX running and is OMLX_API_KEY right?" >&2
  exit 1
fi

# prompt.md is the whole system prompt: pi replaces its default when SYSTEM.md exists.
cp "$REPO_ROOT/games/openrct2/prompt.md" "$REPO_ROOT/pi/SYSTEM.md"

export PI_CODING_AGENT_DIR="$REPO_ROOT/pi"

echo "bridge:  ${BRIDGE_URL}"
echo "model:   ${OMLX_MODEL} via ${OMLX_BASE_URL}"
echo

# --no-builtin-tools leaves `evaluate` as the only tool the model can see, and
# -xt mcp hides the adapter's proxy tool because directTools already registers
# `evaluate` natively. Drop `-xt mcp` if tool registration ever misbehaves.
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
