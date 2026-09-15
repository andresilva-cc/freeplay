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

# The body is kept: /v1 also reports the state guards, checked further down.
if ! BRIDGE_INFO=$(curl -fsS -m 3 "${BRIDGE_URL}/v1" 2>/dev/null); then
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

# The plugin freezes the levers an evaluated script could use to hand itself a result it
# has not earned, and reports at /v1 which of them this build actually managed to freeze.
#
# This warns; it never refuses. An open lever does not make the run dishonest on its own:
# nothing has touched it, evaluate still reports every change it cannot account for, and
# the report names the gap either way - so the run stays auditable, which is the thing
# that matters. Refusing would also stop a run against any plugin older than this field,
# which is the stale-build warning's job above, not this one's.
GUARDS=$(printf '%s' "$BRIDGE_INFO" | python3 -c '
import json, sys


def names(value):
    # ", " and not ",": `unexamined` arrives already capped and closed with an "and N more"
    # entry, and jammed against a comma that reads as one more member name.
    return ", ".join(str(name) for name in value) if isinstance(value, list) else ""


try:
    info = json.load(sys.stdin)
except ValueError:
    info = None

guards = info.get("stateGuards") if isinstance(info, dict) else None

# Four states, because two could not tell the truth and three still could not say "nobody
# looked". `unfrozen` has only ever meant "the slot refused"; so a whole surface nobody had
# listed - the guest prototype, the tile elements - left both lists empty and this printed
# "ok". `open` is what the plugin knows it is leaving writable and says so by name.
# `unexamined` is the members of a declared namespace that are in none of the three: not
# shut, not refused, not a decision. The plugin caps that list and closes it with "and N
# more", so what arrives here is already short enough to print.
if not isinstance(guards, dict):
    print("absent||||")
else:
    frozen = guards.get("frozen") or 0
    refused = names(guards.get("unfrozen"))
    declared = names(guards.get("open"))
    unexamined = names(guards.get("unexamined"))

    if not frozen:
        status = "none"
    elif refused:
        status = "refused"
    elif unexamined:
        status = "unexamined"
    elif declared:
        status = "declared"
    else:
        status = "ok"

    print("|".join([status, str(frozen), refused, declared, unexamined]))
') || GUARDS="absent||||"

GUARD_STATUS="${GUARDS%%|*}"
GUARD_REST="${GUARDS#*|}"
GUARD_FROZEN="${GUARD_REST%%|*}"
GUARD_REST="${GUARD_REST#*|}"
GUARD_REFUSED="${GUARD_REST%%|*}"
GUARD_REST="${GUARD_REST#*|}"
GUARD_DECLARED="${GUARD_REST%%|*}"
GUARD_UNEXAMINED="${GUARD_REST#*|}"

case "$GUARD_STATUS" in
  ok)
    GUARD_LINE="${GUARD_FROZEN} levers frozen"
    ;;
  declared)
    # The endpoint's own `ok` is TRUE here and the two do not disagree: a declared-open lever
    # is a disclosure, not a failure - named in OPEN_LEVERS with a reason, and reported. This
    # prints it anyway, because a stated condition is still a condition to state out loud.
    GUARD_LINE="${GUARD_FROZEN} frozen, open on purpose: ${GUARD_DECLARED}"
    echo "note: the running plugin leaves these levers writable on purpose: ${GUARD_DECLARED}" >&2
    echo "      they are free settings the game's own windows offer and freezing them would" >&2
    echo "      stop the model playing; every other member it declares has a verdict on it." >&2
    ;;
  refused)
    GUARD_LINE="${GUARD_FROZEN} frozen, could not freeze: ${GUARD_REFUSED}"
    echo "warning: the running plugin could not freeze these levers: ${GUARD_REFUSED}" >&2
    echo "         an evaluated script can still write them, so the run is only honest if" >&2
    echo "         the model does not. Watch what evaluate reports as unaccounted." >&2

    if [ -n "$GUARD_DECLARED" ]; then
      GUARD_LINE="${GUARD_LINE}, open on purpose: ${GUARD_DECLARED}"
      echo "         these are writable on purpose as well: ${GUARD_DECLARED}" >&2
    fi

    if [ -n "$GUARD_UNEXAMINED" ]; then
      GUARD_LINE="${GUARD_LINE}, nobody looked at: ${GUARD_UNEXAMINED}"
      echo "         and nobody has looked at these at all: ${GUARD_UNEXAMINED}" >&2
    fi
    ;;
  unexamined)
    # Neither of the two above. "Could not freeze" is a build that tried and lost; "open on
    # purpose" is a decision somebody wrote down. This is the absence of both: the plugin
    # swept a namespace it declares and found members no table in it names either way. It
    # may be harmless and it may be the calendar again - what is known is that nobody has
    # said which, so it is reported flatly and the run goes ahead.
    GUARD_LINE="${GUARD_FROZEN} frozen, nobody looked at: ${GUARD_UNEXAMINED}"
    echo "unchecked: nobody has a verdict on these members of the plugin API: ${GUARD_UNEXAMINED}" >&2
    echo "           they are neither guarded nor knowingly left open, which is a weaker" >&2
    echo "           claim than either - not that they are a hole, only that nothing in" >&2
    echo "           src/scripting.ts has decided. Give them one, or say they are reads." >&2

    if [ -n "$GUARD_DECLARED" ]; then
      GUARD_LINE="${GUARD_LINE}, open on purpose: ${GUARD_DECLARED}"
      echo "           these are writable on purpose, which is a decision: ${GUARD_DECLARED}" >&2
    fi
    ;;
  none)
    GUARD_LINE="none installed"
    echo "warning: the running plugin reports no state guards installed at all. Every" >&2
    echo "         lever a script could use to fake a result is open. Check the in-game" >&2
    echo "         console for what went wrong at plugin startup." >&2
    ;;
  *)
    GUARD_LINE="not reported"
    echo "warning: the running plugin does not report its guard state, so there is no way" >&2
    echo "         to tell from here whether the levers are frozen. It predates the check;" >&2
    echo "         run ./scripts/deploy-plugin.sh to refresh it." >&2
    ;;
esac

export PI_CODING_AGENT_DIR="$REPO_ROOT/pi"
export PI_CODING_AGENT_SESSION_DIR="$REPO_ROOT/pi/sessions"

echo "bridge:  ${BRIDGE_URL}"
echo "model:   ${OMLX_MODEL} via ${MODEL_BASE_URL}"
echo "guards:  ${GUARD_LINE}"
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
