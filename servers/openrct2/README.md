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
npm test               # the suite, against test/fakeGame.ts
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
| `park_status` | `tools/status.ts` | Objective, money, rating, guests, staff, park messages, the walkable path network, and every ride with its doors, door tiles and whether guests can reach it |
| `guest_feedback` | `tools/status.ts` | Guest thoughts, counted |
| `list_ride_objects` | `tools/status.ts` | What can be built, with footprints |
| `find_build_sites` | `tools/sites.ts` | Where a given ride fits, the ground it stands on, and every door position |
| `clear_scenery` | `tools/clear.ts` | Strip a rectangle of ground, or a square centred on a tile |
| `build_flat_ride` | `tools/build.ts` | Create, place, entrance, exit, price, open |
| `build_path` | `tools/path.ts` | A path or queue, optionally along given waypoints |
| `operate_ride` | `tools/operate.ts` | Open, close, reprice, reschedule inspections for or demolish a ride that exists |
| `open_park` | `tools/openPark.ts` | Open or close the park to guests, and set admission |
| `hire_staff` | `tools/staff.ts` | Hire and place staff |
| `evaluate` | `tools/eval.ts` | Arbitrary JavaScript against the plugin API |

Eleven tools. Upstream's `DateTools`, `ParkTools` and `UiTools` remain in the tree but are
deliberately not registered in `tools/index.ts`: `park_status` covers both reads, and
every tool in the list is re-read by the model on every turn, so a redundant one costs
context and invites the model to pick the weaker option.

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
| `test/fakeGame.ts` | Stand-in for the OpenRCT2 globals: queues actions like the real game, applies them a tick later, and throws on one it does not model |

`src/tools/` is deliberately thin — schemas and descriptions — with the work in
`src/park/`. The description is the part the model actually reads, so it is worth as much
care as the code.

That is meant strictly. No registered tool declares an `outputSchema`, so a tool's prose
`description` and its `inputSchema` property descriptions are the *only* text that reaches
the model. Every doc comment on a field in `src/park/status.ts` or `src/park/sites.ts` —
what `counter` is, why `hasQueue` is null for a shop, what `queueCutsOff` counts — is for
whoever reads the code and is invisible to the model unless the description says it too.
That is why the descriptions are long and why some facts appear in both places.

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

Register the class in `src/tools/index.ts` — a class that is not registered there is not
served. The tool name is derived from the method name by `toToolName` in
`tools/decorators.ts`, so `doTheThing` becomes `do_the_thing`; `@mcpTool`'s `name` is the
human-readable title, not the tool name. Results are sanitised centrally, so returning
native OpenRCT2 objects is safe.

Declare `enum`, `minimum` and `maximum` wherever they apply. The MCP layer enforces the
whole declared slice of JSON Schema — type, `required`, unknown properties, and those
three — and refuses the call naming the property, the value that arrived and the legal
range. It is worth more than it looks: left to the game, a number out of range comes back
as "Value out of range" naming no field, and a run lost several turns sending
`inspectionInterval: 30` meaning thirty minutes to a setting that is an index from 0 to 6.
Do not also clamp the value in the tool. Clamping means reporting a number the caller never
asked for as though they had.

Three things to get right:

- **Verify, do not assume.** Game actions apply on a *later tick*, so a tool that acts and
  checks in the same call always sees the old world. Report what you found, never what you
  attempted. Returning `ok: true` for work that did not happen — or `ok: false` for work
  that did — has caused real bugs here. Check where you are reading, too: a verification
  aimed at the wrong tiles passes while being entirely wrong.
- **Decide nothing.** Defaults, sorting, filtering and caps all quietly make choices, and
  so does a sentence of advice in a description. Read
  [`../../docs/tool-design.md`](../../docs/tool-design.md) before adding one.
- **Make a refusal actionable.** Name the value that was wrong and the call that fixes it,
  not the category it belongs to. Across the runs so far the model recovered from 14 of 14
  errors that named the fix and 0 of 6 that named only a category.

### Tools that span game ticks

A tool needing several actions in sequence returns `{ deferred: true, start }`. The MCP
layer hijacks the connection with `context.connection.takeOver()` and answers once `start`
resolves. From the caller's side it stays one request and one result.

Three things can end the call — the tool resolving, a 30 second watchdog, or the client
dropping the connection — and all three funnel through one `finish` that settles it once,
cancels the watchdog and discards whatever arrives second. The watchdog is armed after
`start` returns, so a tool that finishes immediately is not beaten to the answer by its own
timer. While deferred calls are in flight the game's timer is wrapped so that a throw in a
later tick comes back as that call's error result rather than escaping into the tick loop
and leaving the caller to wait out the full 30 seconds.

Six of the eleven tools are deferred — `build_flat_ride`, `build_path`, `clear_scenery`,
`operate_ride`, `open_park`, `hire_staff`, which is every tool that acts. `build_flat_ride`
is the longest: up to six actions (`ridecreate`, `trackplace`, entrance, exit,
`ridesetprice`, `ridesetstatus`), reading the world back between them, and demolishing the
ride it made if nothing lands on the ground. `open_park` is the shortest, and shows the
pattern bare: send the action, read the park back, and if it did not take, try once through
the plugin API's own setters before reporting what the second read says.

`build_flat_ride`'s `ok` means the ride exists with its track on the ground, and nothing
more; `doorsAttached`, `open` and `reachable` are separate. It used to return `ok: false`
for a ride that was standing but missing a door, and the model read that as "nothing
happened" and built a second one.

### The generated table

`src/park/flatRides.ts` maps ride type to footprint size, placement track piece and
whether it is a shop. None of that is in the plugin API, and guessing fails in the worst
way — the wrong track piece can place *something* that satisfies the game's "constructed"
check while building nothing visible. It was generated from OpenRCT2's
`RideTypeDescriptor` values (`StartTrackPiece`, `Category`) and the
`kTrackElementDescriptors` ordering in `src/openrct2/ride/TrackData.cpp`. Regenerate it
against a newer OpenRCT2 if ride types change.

The *tiles* a piece covers are not in that table and are not derived from its width and
depth, because real pieces follow no rule: a 3x3 is centred on its origin, a 4x4 runs
0..3 from it, and a 2x4 is centred on neither axis. `footprintOffsets` asks the game
instead — `context.getTrackSegment(type).elements` — and falls back to the computed
shape only when there is no game to ask. Assuming the rule once put a dodgems' entrance
three tiles clear of the ride, with every check agreeing it was adjacent.

Those offsets then have to be turned the way the game turns them. One turn is
`(dx, dy) → (dy, -dx)`, matching OpenRCT2's `CoordsXY::rotate` as `TrackPlaceAction`
applies it to every block of a piece. The opposite turn is invisible on anything symmetric
about its origin and on rotations 0 and 2, so it shipped for months while swapping
rotations 1 and 3 on every asymmetric footprint — a 1x4 computed at -2..+1 along y where
the game lays it at -1..+2, and a 4x4 at rotation 1 computed on rotation 3's quadrant.
Everything downstream (access tiles, `sceneryToClear`, the buildability check) was then
measured on the wrong ground while reporting success. `test/flatRides.test.ts` now pins all
four rotations of the 1x4, 2x4 and 4x4 pieces and states the rule itself, because a
mutation flipping the rotation previously broke no test at all.

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
  by piece; only `evaluate` reaches that. `list_ride_objects` reports `isFlatRide: false`
  for these, and `find_build_sites` and `build_flat_ride` refuse them by name rather than
  failing obscurely.
- **The port is fixed at 8080.** `BRIDGE_PORT` in `src/index.ts` is a constant, and a
  plugin cannot read the environment it was loaded into, so there is nothing to override
  it with. Moving the bridge means editing that constant and the three places that name
  the port back to it: `.mcp.json`, `games/openrct2/game.yml`, and the scripts.
