# The OpenRCT2 bridge

`servers/openrct2/` is a fork of
[IntelOrca/openrct2-mcp](https://github.com/IntelOrca/openrct2-mcp) by Ted John, MIT
licensed. This page describes what the upstream plugin provides, what Freeplay adds, and
the parts worth knowing about if you are extending it.

## What OpenRCT2 gives a plugin

OpenRCT2 ships a first-party JavaScript plugin API, typed in `@openrct2/types`. Plugins
run in a sandboxed interpreter inside the game process with access to:

- **`park`** — cash, rating, loan, entrance fee, guest counts, park value, monthly
  expenditure history, awards, the message queue.
- **`map`** — map size, the ride list, tile access, and entity queries by type (guests,
  staff, cars, litter).
- **`date`** and **`scenario`** — game time, and the scenario's objective and status.
- **`context`** — most importantly `executeAction(name, args, callback)` and
  `queryAction(...)`, over roughly eighty typed game actions covering rides, staff,
  finance, marketing, footpaths, track, scenery, land and water. `queryAction` costs a
  proposed action without applying it.
- **`network`** — including `network.createListener()`, which is what makes an in-process
  server possible at all.

Everything a human player can do is a game action, including setting game speed
(`gamesetspeed`) and pausing (`pausetoggle`). That uniformity is what makes the API
usable as an agent interface rather than merely as a modding interface.

## What upstream already solved

The hard part was never the OpenRCT2 API — it was serving a protocol from inside a
sandboxed plugin. Upstream did that work:

- a TCP listener opened from plugin code;
- a hand-rolled HTTP stack — request parsing, response building, middleware, a router
  with path parameters;
- controllers behind `@httpPath` / `@httpGet` decorators, with OpenAPI generated from
  them and a Swagger UI to browse it;
- an MCP Streamable HTTP endpoint at `POST /mcp` implementing `initialize`, `ping`,
  `tools/list` and `tools/call`, with `MCP-Session-Id` session state;
- a `@mcpToolController` / `@mcpTool` decorator pair, so a new tool is about fifteen
  lines;
- a rollup build producing a single plugin bundle.

Upstream's MCP tool surface is three tools — `getDate`, `getParkInfo` and `showError` —
none of which change the park. It also has a REST endpoint, `GET /v1/eval?q=...`, which
evaluates a JavaScript expression inside the plugin. That endpoint reaches the entire
plugin API, and it is not exposed over MCP.

## What Freeplay adds

Nine tools beyond the three inherited ones. Where the line between them and the model
sits is [tool-design.md](tool-design.md); what each one does is in its own description,
which is what the model reads.

| Tool | |
|---|---|
| `park_status` | Objective, money, rating, guests, and every ride including whether a queue is bound to it |
| `guest_feedback` | Guest thoughts, counted |
| `list_ride_objects` | What can be built, with footprints |
| `find_build_sites` | Where a given ride fits, with every entrance and exit position |
| `clear_scenery` | Fell trees on a square |
| `build_flat_ride` | Create, place, entrance, exit, price, open |
| `build_path` | A path or queue between two tiles |
| `hire_staff` | Hire and place staff |
| `evaluate` | Arbitrary JavaScript against the plugin API |

### Things the API will not tell you, learned the hard way

**Directions.** `TileDirectionDelta` is `0 = -x, 1 = +y, 2 = +x, 3 = -y`. Getting this
rotated by one puts every ride entrance's door on the wrong wall. Nothing in the API
complains; the ride reports itself open, with a rating, and no guest ever boards.

**Flat-ride footprints.** A flat ride is placed with a single `trackplace` using the
piece named by its `RideTypeDescriptor.StartTrackPiece` — `flatTrack3x3` is track type
266, `flatTrack1x1A` is 262, and so on. The plugin API exposes no footprint at all, so
`src/park/flatRides.ts` carries the table generated from OpenRCT2's source. Guessing
fails in the worst way: a wrong piece can place *something* that satisfies the game's
"constructed" check while building nothing visible.

A footprint of N tiles spans `-floor(N/2)` to `N-1-floor(N/2)` from the origin passed to
`trackplace`, verified in game against a 1x1 stall and a 1x4 Ferris Wheel.

**Queues.** A ride entrance needs a *queue* path on the tile its door opens onto, bound
to that ride. An ordinary footpath touching the door looks identical through the API and
does nothing. The binding is `FootpathElement.ride`, set by the game when the queue
connects; check it rather than assuming.

**Actions apply on the next tick.** Nothing a game action does is visible within the
same `evaluate` call. Tools that need to act then verify use the deferred-result path
described below.

**One MCP tool, `evaluate`.** It takes a `code` string, runs it in the plugin context and
returns the value, annotated `readOnlyHint: false` and `destructiveHint: true`. This is
the whole action surface; the reasoning is in [architecture.md](architecture.md).

The evaluation logic lives in `src/scripting.ts` rather than reusing the REST
controller's, for two reasons.

**Parse-time form selection.** Upstream's evaluator tries expression form, and on *any*
failure retries the code as a statement body:

```js
try { return new Function("return (" + expression + ");")(); }
catch { return new Function(expression)(); }
```

That is fine for a read-only endpoint. For a tool that mutates the game it is not: an
expression that parses but throws halfway through is executed a second time, so a
partially-applied action can be applied again. `src/scripting.ts` chooses the form by
whether it *parses*, then executes exactly once.

**Result sanitisation.** Raw values from the plugin API are not safely serialisable.
Native game objects expose their data through prototype getters, so `JSON.stringify` on
a `Ride` yields `{}`. Some getters throw when the entity behind them is gone. Structures
contain cycles. And `map.rides` on a mature park is far larger than a local model's
context window. `sanitize` walks the prototype chain for accessors, catches throwing
getters and reports them inline, cuts cycles, drops functions, caps array length, object
key count, string length and total node count, and truncates an over-long result with a
note telling the model to narrow the query.

**Input normalisation.** Models emit markdown code fences and trailing semicolons.
Both are stripped rather than turned into a wasted turn.

Failures come back as `{ ok: false, error }` rather than as a transport error, so the
model sees the message and can correct itself.

## Endpoints

The listener binds `127.0.0.1:8080`, loopback only.

| Path | What it is |
|---|---|
| `POST /mcp` | The MCP endpoint. Streamable HTTP. |
| `GET /v1` | Index of registered REST controllers |
| `GET /v1/eval?q=` | Upstream's expression evaluator |
| `GET /openapi.yaml` | Generated OpenAPI document |
| `GET /swagger` | Swagger UI over the above |
| `GET /dashboard` | Status page |

## Tools that span game ticks

A game action does not take effect until a later tick, so a tool that creates a ride and
then places track cannot do both in one call. `McpServer` supports deferred results for
this: a tool returns `{ deferred: true, start }`, the MCP layer hijacks the connection
with `context.connection.takeOver()`, and the response is written once `start` resolves.
A 30 second timeout closes the socket if a tool never finishes. From the caller's side it
is one request and one result.

`build_flat_ride` uses this to run five actions in sequence, verifying each before the
next, and reports which step failed.

## Adding a tool

```ts
@mcpToolController
export class ParkTools {
    @mcpTool({
        name: "Get park info",
        description: "…",
        outputSchema: { /* … */ },
        annotations: { readOnlyHint: true, destructiveHint: false }
    })
    public getParkInfo() {
        return getParkInfo();
    }
}
```

Register the class in `src/tools/index.ts`. The tool name is derived from the method
name, so `getParkInfo` becomes `get_park_info`. Tools with an `outputSchema` have their
result validated against it, and a mismatch throws — leave it off for a tool whose
result shape varies.

## Known limitations

**One TCP segment per request.** The socket handler treats the first `data` event as the
complete HTTP request. On loopback this holds for the request sizes involved here, but a
sufficiently large body would be truncated rather than reassembled. If a very long script
ever fails oddly, this is the first thing to suspect.

**No streaming.** The MCP endpoint answers with a single JSON response; the SSE half of
Streamable HTTP is not implemented. Nothing here needs it.

**Actions may be asynchronous.** `context.executeAction` takes a callback. In local
single-player it generally runs inline, but that is not guaranteed, so the prompt tells
the model to capture the callback result and to verify by reading state back rather than
assuming.

## Building

```bash
npm --prefix servers/openrct2 install
npm --prefix servers/openrct2 run build     # → out/mcp.js and out/mcp.min.js
npm --prefix servers/openrct2 run copy      # → the OpenRCT2 plugin directory (macOS)
npm --prefix servers/openrct2 test
npm --prefix servers/openrct2 run lint
```
