# Freeplay OpenRCT2 adapter

An OpenRCT2 plugin that opens a loopback TCP listener from inside the running game and
serves an MCP endpoint over it, so an agent can read park state and take actions without
touching the screen or the keyboard.

This directory is self-contained: everything the game loads is built from here. For why
the tools are shaped the way they are, see [`../../docs/tool-design.md`](../../docs/tool-design.md);
for what the OpenRCT2 API will and will not tell you, see
[`../../docs/openrct2-bridge.md`](../../docs/openrct2-bridge.md).

## Upstream

A fork of [IntelOrca/openrct2-mcp](https://github.com/IntelOrca/openrct2-mcp) by Ted
John, MIT licensed. The in-plugin TCP listener, the hand-rolled HTTP stack, the routing
and controller decorators, the MCP Streamable HTTP implementation, the OpenAPI generation
and the rollup build all come from there. The original licence is preserved in
[`LICENSE`](LICENSE).

## Build and install

```bash
npm install
npm run build          # → out/mcp.js and out/mcp.min.js
npm run copy           # → the OpenRCT2 plugin directory (macOS)
npm test
npm run lint
npm run typecheck
```

In practice use the repo's deploy script instead, from the repo root:

```bash
./scripts/deploy-plugin.sh
```

It builds, installs, and then **refuses to return until the running game reports the
build id it just produced**. Every bundle is stamped at build time (`src/buildInfo.ts`,
filled in by rollup) and the id comes back in the MCP `initialize` response as
`serverInfo.version`. OpenRCT2's plugin hot reloading is silent when it does not fire,
and an afternoon went into testing a stale bundle before this existed.

Hot reloading is off by default. Enable it with `enable_hot_reloading` under `[plugin]`
in OpenRCT2's `config.ini`, edited while the game is closed.

**Do not deploy while an agent run is in progress** — reloading the plugin resets MCP
session state, and the connected client's session id becomes unknown.

## Tools

| Tool | Source | |
|---|---|---|
| `park_status` | `tools/status.ts` | Objective, money, rating, guests, staff, park messages, the walkable path network, and every ride |
| `guest_feedback` | `tools/status.ts` | Guest thoughts, counted |
| `list_ride_objects` | `tools/status.ts` | What can be built, with footprints |
| `find_build_sites` | `tools/sites.ts` | Where a given ride fits, with every door position |
| `clear_scenery` | `tools/clear.ts` | Fell trees on a square |
| `build_flat_ride` | `tools/build.ts` | Create, place, entrance, exit, price, open |
| `build_path` | `tools/path.ts` | A path or queue, optionally along given waypoints |
| `hire_staff` | `tools/staff.ts` | Hire and place staff |
| `evaluate` | `tools/eval.ts` | Arbitrary JavaScript against the plugin API |

Upstream's `DateTools`, `ParkTools` and `UiTools` remain in the tree but are deliberately
not registered in `tools/index.ts`: `park_status` covers both reads, and every tool in the
list is re-read by the model on every turn.

## Layout

| Path | |
|---|---|
| `src/index.ts` | Plugin entry point; binds `127.0.0.1:8080` |
| `src/mcp.ts` | MCP protocol, including deferred results |
| `src/scripting.ts` | Runs model-authored JavaScript; sanitises every tool result |
| `src/tools/` | One file per tool: schema, description, argument handling |
| `src/park/` | The game logic the tools call |
| `src/park/flatRides.ts` | Generated footprint and track-piece table (see below) |
| `src/http/`, `src/controllers/` | Inherited from upstream, largely untouched |

`src/tools/` is deliberately thin — schemas and descriptions — with the work in
`src/park/`. The description is the part the model actually reads, so it is worth as much
care as the code.

## Adding a tool

```ts
@mcpToolController
export class ThingTools {
    @mcpTool({
        name: "Do the thing",
        description: "What it does, what the arguments mean, and what the result means.",
        inputSchema: { type: "object", properties: { /* … */ }, required: [], additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false }
    })
    public doTheThing(args: Record<string, unknown>) {
        return { /* … */ };
    }
}
```

Register the class in `src/tools/index.ts`. The tool name is derived from the method name,
so `doTheThing` becomes `do_the_thing`. Results are sanitised centrally, so returning
native OpenRCT2 objects is safe.

Two things to get right:

- **Verify, do not assume.** Game actions apply on a *later tick*, so a tool that acts and
  checks in the same call always sees the old world. Report what you found, never what you
  attempted. Returning `ok: true` for work that did not happen — or `ok: false` for work
  that did — has caused real bugs here.
- **Decide nothing.** Defaults, sorting, filtering and caps all quietly make choices.
  Read [`../../docs/tool-design.md`](../../docs/tool-design.md) before adding one.

### Tools that span game ticks

A tool needing several actions in sequence returns `{ deferred: true, start }`. The MCP
layer hijacks the connection with `context.connection.takeOver()` and answers once `start`
resolves, with a 30 second timeout. From the caller's side it stays one request and one
result. `build_flat_ride` uses this to run five actions, verifying each before the next.

### The generated table

`src/park/flatRides.ts` maps ride type to footprint, placement track piece and whether it
is a shop. None of that is in the plugin API, and guessing fails in the worst way — the
wrong track piece can place *something* that satisfies the game's "constructed" check
while building nothing visible. It was generated from OpenRCT2's `RideTypeDescriptor`
values (`StartTrackPiece`, `Category`) and the `kTrackElementDescriptors` ordering in
`src/openrct2/ride/TrackData.cpp`. Regenerate it against a newer OpenRCT2 if ride types
change.

## Endpoints

The listener binds `127.0.0.1:8080`, loopback only.

| Path | |
|---|---|
| `POST /mcp` | The MCP endpoint (Streamable HTTP) |
| `GET /v1` | Index of inherited REST controllers |
| `GET /v1/eval?q=` | Upstream's expression evaluator |
| `GET /openapi.yaml` | Generated OpenAPI document |
| `GET /swagger` | Swagger UI |
| `GET /dashboard` | Status page |

## Known limitations

- **One TCP segment per request.** The socket handler treats the first `data` event as the
  whole HTTP request. Fine on loopback at these sizes; a very large body would be truncated
  rather than reassembled.
- **No streaming.** The MCP endpoint answers with a single JSON response; the SSE half of
  Streamable HTTP is not implemented.
- **Tracked rides are not buildable through a tool.** Roller coasters need track laid piece
  by piece; only `evaluate` reaches that.
