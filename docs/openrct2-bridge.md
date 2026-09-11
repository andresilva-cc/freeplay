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
usable as an agent interface rather than merely as a modding interface — and it is why
the clock is a tool the model holds rather than something the harness does to it. Both of
those actions have a trap in them: `gamesetspeed` takes a speed *setting*, 1 to 4, and the
loop runs `1 << (speed - 1)` updates, so 4 is eight times normal and there is no 8;
`pausetoggle` flips rather than sets, so firing it without reading `context.paused` first
does the opposite of what was asked half the time.

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

Fourteen tools, and the three inherited ones are gone. Upstream's `getDate`, `getParkInfo`
and `showError` are still in the tree but are no longer registered in `src/tools/index.ts`:
`park_status` covers both reads, and every tool in the list is re-read by the model on
every turn, so a redundant one costs context and invites it to pick the weaker option.
Where the line between these tools and the model sits is [tool-design.md](tool-design.md);
what each one does is in its own description, which is what the model reads.

| Tool | |
|---|---|
| `park_status` | Objective, money, rating, guests, staff, park messages, the walkable path network, and every ride: its doors, the tiles those doors open onto, whether a queue is bound to it, and whether guests can reach it |
| `guest_feedback` | Guest thoughts, counted over a sample |
| `list_ride_objects` | What can be built, with footprints |
| `find_build_sites` | Where a given ride fits, the ground it will stand on, and where each door can go on it |
| `clear_scenery` | Strip a rectangle of ground, or a square centred on a tile |
| `build_flat_ride` | Create, place, entrance, exit, price, open |
| `build_path` | A path or queue, along given waypoints or between two tiles |
| `remove_path` | Take the footpath or queue off a run of tiles, and report what guests can still reach and which rides lost their queue |
| `operate_ride` | Open, close, reprice, reschedule inspections for or demolish a ride that already exists |
| `open_park` | Open or close the park to guests, and set admission |
| `hire_staff` | Hire and place staff |
| `buy_land` | Buy the land rights to a rectangle of tiles, and report what the scenario would not sell |
| `set_game_speed` | Set the speed setting, and pause or unpause |
| `evaluate` | Arbitrary JavaScript against the plugin API |

`open_park` is the smallest, and it is there for a reason worth stating: opening the park
is two single game actions with undiscoverable argument shapes — `parksetparameter` takes
`0` for close and `1` for open, and neither name resembles what it does — so five of five
playable runs skipped them and hand-wrote `park.setFlag("open", true)` through `evaluate`.
The tool decides nothing about when to open or what to charge; it carries out whichever of
the two it was given and reports what the park reads back as afterwards, which is not
always the same thing: a scenario with free park entry will keep an entrance fee of 0
whatever it is asked for.

`set_game_speed` is the same story about the clock, and `remove_path` and `buy_land` are
the two most recent. `remove_path` closed a gap rather than an ergonomic problem: nothing
could delete a footpath at all, while `build_path` could lay a path over a queue (which
unbinds it from its ride) or a queue across a through route (which splits the park, because
guests cannot walk through one). It takes `build_path`'s own addressing, so that call's
`route` passed back as `waypoints` lifts exactly what it laid, and it reports how much of
the network is still reachable from the gate and any ride whose bound queue went with the
path. `buy_land` wraps `landbuyrights`, which is the only lever a plugin has over park
boundaries during a scenario: its sibling `landsetrights` carries the game's `EditorOnly`
flag, so there is no selling land back and no making an unlisted tile buyable, and ground
height (`landsetheight`, `landraise`, `landlower`) is not reachable through any tool here.

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

The tiles a footprint covers, relative to that origin, follow no rule at all. A 3x3 is
centred on its origin (-1..+1) and so is a 1x4 (-2..+1), but a 4x4 runs 0..3 from its
origin and a 2x4 is centred on neither axis. An earlier version generalised
`-floor(N/2)` to `N-1-floor(N/2)` from the 1x1 and 1x4 cases it had checked, which is
off by two tiles on a dodgems: it placed the entrance three tiles clear of the ride,
with every check in the tool agreeing the two were adjacent.

So the offsets are read from the game — `context.getTrackSegment(type).elements`,
divided by 32 and rotated — in `footprintOffsets`. `computeFootprintOffsets` survives
only as a fallback for when there is no game to ask, and a test asserts it disagrees
with the real 4x4, which is the point of not relying on it.

**Rotation.** Reading the offsets from the game only helps if they are then turned the way
the game turns them. One turn is `(dx, dy) → (dy, -dx)`, which is what OpenRCT2's
`CoordsXY::rotate` does to every block of a piece in `TrackPlaceAction`. Turning the other
way — `(dx, dy) → (-dy, dx)` — is a different bug from the one above and survived far
longer, because it is *indistinguishable* on anything symmetric about its origin. A 3x3, a
1x5 and a 1x1 all come out identical either way round, and rotations 0 and 2 are mirror
images either way round, so the whole of the covered surface agreed with it. What it
actually did was swap rotations 1 and 3 for every asymmetric footprint: a 1x4 at rotation 1
was computed at -2..+1 along y when the game lays it at -1..+2, and a 4x4 at rotation 1 was
computed on the quadrant the game uses for rotation 3.

Because the same offsets drive access tiles, `sceneryToClear` and the buildability check,
all three were being answered about ground the ride would never stand on — and the build
still reported success, because the ride did go up, just not where the tool thought. A door
placed against the computed edge of a 1x4 ends up two tiles clear of the real one.

This is the failure mode the [tool-design](tool-design.md) rule is aimed at, so it is worth
naming how it was settled rather than argued: the game's own `getTrackSegment` offsets at
each rotation, OpenRCT2's C++ source, and a mutation test. The mutation is the damning one
— flipping the rotation in shipped code broke no test at all, because every rotation any
test covered was one of the ones that cannot tell the two apart. The tests now pin all four
rotations of the 1x4, 2x4 and 4x4 pieces to the tiles the game lays, and one test states the
rule itself, so it fails on the rule rather than on a table someone could regenerate wrong.

**Queues.** A ride entrance needs a *queue* path on the tile its door opens onto, bound
to that ride. An ordinary footpath touching the door looks identical through the API and
does nothing. The binding is `FootpathElement.ride`, set by the game when the queue
connects; check it rather than assuming.

A queue is walkable in only one sense. A guest walks the whole length of a queue to reach
the ride at the end of it, but cannot cut *through* one to get somewhere else, so it is
not a shortcut to anywhere. A reachability search therefore expands from a queue tile
to further queue tiles — following the line to its door — and never back out onto
ordinary path (`walkableFromParkEntrance` in `src/park/paths.ts`). Getting this wrong is
expensive in either direction: treating a queue as ordinary path marks everything behind
it reachable when it is not, and refusing to expand from a queue at all marks every ride
with more than a one-tile queue unreachable, which is worse, because that is the normal
case.

**Actions apply on the next tick.** Nothing a game action does is visible within the
same `evaluate` call. Tools that need to act then verify use the deferred-result path
described below.

**`evaluate` is the escape hatch, not the whole surface.** It takes a `code` string, runs
it in the plugin context and returns the value, annotated `readOnlyHint: false` and
`destructiveHint: true`. It was the entire action surface to begin with; the thirteen typed
tools beside it were added in response to what runs showed the model fumbling, and
`evaluate` covers what they still do not reach — tracked rides above all. The reasoning
is in [architecture.md](architecture.md).

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
note telling the model to narrow the query. It runs on two budgets: a tight one for
`evaluate`, where the model wrote the query and can be told to narrow it, and a much
looser one for typed tool results, whose shape the bridge chose and already bounds.

**Input normalisation.** Models emit markdown code fences and trailing semicolons.
Both are stripped rather than turned into a wasted turn.

**Action names are checked before the game sees them.** `context.executeAction` and
`context.queryAction` answer a name the game has never heard of with a null result and no
error, which reads as success: `queryAction("set_ride_status")` returns
`{"ok":true,"result":null}`, and so does every other misspelling. One run was told twice
that a ride had been demolished, wrote that down, and then failed to build because the
ride was still standing. Both invokers are now wrapped, an unknown name throws instead,
and the message suggests the real one — `set_ride_status` is answered with "Did you mean
ridesetstatus?", because the actual names are a single lowercase word with no separators
and that is not a thing a model guesses.

**Introspection had to be given back.** `Object.keys` returns `[]` on `map`, `park` and
`context`: the native objects own no enumerable properties and keep everything behind
prototype getters. Seven attempts at introspection across two runs found nothing at all,
which is a model concluding the API is empty. Scripts are handed a `keys(value)` helper
that walks the prototype chain, and inside a sanitised structure a property the value does
not have renders as `"<undefined>"` rather than being dropped — so "this does not exist"
and "this is null" stop looking the same.

Failures come back as `{ ok: false, error }` rather than as a transport error, so the
model sees the message and can correct itself.

## Arguments are validated before a tool runs

`src/mcp.ts` checks `tools/call` arguments against the slice of JSON Schema the tools
declare, and refuses the call with an `isError` result rather than running it: type,
`required`, unknown properties when `additionalProperties` is false, and `enum`,
`minimum` and `maximum`. The last three are recent and matter more than they sound. Left
to the game, a number outside its range comes back as "Value out of range" naming no
field, which tells the model nothing it can act on; a run lost several turns sending
`inspectionInterval: 30` meaning thirty minutes to a setting that is an index from 0 to 6.
Each refusal names the property, the value that arrived and the legal set, and nothing
else — a category without a fix is a message the model cannot use.

Tools still range-check anything they are willing to be called with directly, and some
constraints cannot be expressed in the schema at all: `build_flat_ride`'s four door
coordinates are all-or-nothing because a shop legitimately has none, and `clear_scenery`'s
two argument forms are mutually exclusive. Those are checked in the tool, by name, and
refused with a message that says which form was meant.

## Endpoints

The listener binds `127.0.0.1:8080`, loopback only.

| Path | What it is |
|---|---|
| `POST /mcp` | The MCP endpoint. Streamable HTTP. |
| `GET /v1` | Build id, the state guard summary, and the index of registered REST controllers |
| `GET /v1/eval?q=` | Upstream's expression evaluator |
| `GET /openapi.yaml` | Generated OpenAPI document |
| `GET /swagger` | Swagger UI over the above |
| `GET /dashboard` | Status page |

## Tools that span game ticks

A game action does not take effect until a later tick, so a tool that creates a ride and
then places track cannot do both in one call. `McpServer` supports deferred results for
this: a tool returns `{ deferred: true, start }`, the MCP layer hijacks the connection
with `context.connection.takeOver()`, and the response is written once `start` resolves.
From the caller's side it is one request and one result.

Three things can end such a call, and each has to end it exactly once. The tool resolves;
a 30 second watchdog answers with an error result — "The tool did not finish in time;
check the game state before retrying" — rather than leaving the caller with a dead socket;
or the client goes away, in which case there is nobody left to answer and writing to the
dropped socket would throw out of whatever tick the bridge happened to be in. All three
funnel through one `finish` that settles the call, cancels the watchdog and drops whatever
arrives second. The watchdog is armed *after* `start` returns, so a tool that finishes
immediately is never beaten to the answer by its own timer.

The subtler problem is that a deferred tool does most of its work inside `context.setTimeout`
callbacks it schedules for itself, and a throw in one of those escapes into the game's tick
loop: the MCP layer never sees it, and the caller waits out the full 30 seconds only to be
told the tool was slow rather than what broke. So while deferred calls are in flight the
game's timer is wrapped, every continuation is attributed to the call that scheduled it, and
a later-tick failure comes back as that call's error. If a game build will not let its timer
be wrapped, the wrap is abandoned and the watchdog remains the fallback — a slow answer is
worse than a real one, but it is much better than taking the bridge down mid-tick.

Nine of the fourteen tools are deferred: `build_flat_ride`, `build_path`, `remove_path`,
`clear_scenery`, `operate_ride`, `open_park`, `hire_staff`, `buy_land` and
`set_game_speed`, which is every tool that acts.
`build_flat_ride` is the longest, running up to six actions in sequence — `ridecreate`,
`trackplace`, an entrance, an exit, `ridesetprice`, `ridesetstatus` — and reading the world
back between them. It reports which step failed, and demolishes the ride it created when
nothing lands on the ground, so a failed build does not leave an empty ride holding an id in
`park_status`. `open_park` is the shortest and shows the shape at its smallest: send the
action, read the park back a tick later, and if it did not take, try once through the plugin
API's own setters — the route every run took by hand — before reporting whatever the second
read says.

## Adding a tool

```ts
@mcpToolController
export class ThingTools {
    @mcpTool({
        name: "Do the thing",
        description: "…",
        inputSchema: { type: "object", properties: { /* … */ }, required: [], additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false }
    })
    public doTheThing(args: Record<string, unknown>) {
        return doTheThing(args);
    }
}
```

Register the class in `src/tools/index.ts` — a class that is not registered there is not
served, which is how upstream's three tools are kept out. The tool name is derived from
the method name by `toToolName` in `src/tools/decorators.ts`, so `doTheThing` becomes
`do_the_thing`; `@mcpTool`'s `name` is the human-readable title, not the tool name.

An `outputSchema` is optional and no registered tool declares one, because these results
change shape with what was found. A tool that declares one has its `structuredContent`
validated against it and a mismatch throws — on the deferred path it comes back as that
call's error result instead, since a throw inside a later tick would strand the caller.

The consequence of having no output schemas is worth knowing before you go looking for
somewhere to document a field: the tool's prose `description` and its `inputSchema`
property descriptions are the only text that reaches the model. The field-level comments
in `src/park/status.ts` and `src/park/sites.ts` — what `counter` means, why `hasQueue` is
null for a shop, what `queueCutsOff` counts — are for whoever reads the code. If the model
needs a fact, it has to be in the description, which is why they read long.

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
npm --prefix servers/openrct2 test        # the fake-game suite; it prints the count
npm --prefix servers/openrct2 run lint
npm --prefix servers/openrct2 run typecheck
```
