# Architecture

Freeplay has three parts: a bridge inside the game, an agent harness outside it, and a
model behind the harness. They are joined by MCP, and that choice does most of the
architectural work.

## Why the bridge lives inside the game

An agent can be attached to a game in three broad ways.

**Pixels and input simulation.** Screenshot the window, have the model decide, synthesise
mouse and keyboard events. It works on anything, which is its only real advantage. You
pay for it in every other dimension: the model spends its capacity on reading a UI
instead of on playing, actions fail silently when a click lands a pixel off, and nothing
about the run is inspectable afterwards. The game is also not obliged to tell you
anything — you are reverse-engineering a rendering.

**An external process talking to the game over a socket the game already opens.** Where
it exists this is excellent, and several games ship exactly this (see
[game-selection.md](game-selection.md)). OpenRCT2 does not.

**A plugin running inside the game process.** OpenRCT2 has a first-party JavaScript
plugin API, so code can run inside the game with direct access to its state and its
action system. The plugin can open a TCP listener, which means the agent harness can be
an ordinary process outside the game talking HTTP to it.

The third is what Freeplay uses. The consequence that matters: the model reads
`park.rating` as a number and calls `ridesetstatus` as a typed action. It never infers
state from an image and never guesses whether an action landed — a rejected action comes
back with an error message.

## Why MCP rather than a REST wrapper

The plugin already serves a REST API, and wrapping those endpoints in a small harness
extension would have fewer moving parts today.

It optimises the wrong thing. The plan for this project is to watch what the model
reaches for and add capability in response, which makes *adding a tool* the highest-
frequency operation there is. Under MCP, a tool added in the plugin appears in the
harness through `tools/list`, with its schema, and nothing outside the game changes. Under
a REST wrapper, every new tool is an edit on both sides.

MCP also turns out to be the only shared layer this project needs. Anything built later
that spans games — run recording, agent memory, checking the agent's beliefs against
actual state — needs to know *that a tool was called, with what arguments, and what came
back*. MCP guarantees that shape already. An extra abstraction on top of it, a forced
common vocabulary of `get_state` / `execute_action` across every game, buys nothing and
costs a layer. Each game's server should expose whatever tools fit that game.

## The pieces

**`servers/openrct2/`** — an OpenRCT2 plugin, forked from
[IntelOrca/openrct2-mcp](https://github.com/IntelOrca/openrct2-mcp). It opens a loopback
TCP listener inside the game process, parses HTTP on it, and serves MCP Streamable HTTP
at `POST /mcp` alongside a REST surface, generated OpenAPI, and a status dashboard.
Details in [openrct2-bridge.md](openrct2-bridge.md).

**`games/openrct2/`** — `prompt.md` is the model's entire system prompt: what it is
doing, what it can read, what it can change, and the API gotchas that would otherwise
cost it turns. It is the only copy that is edited; `scripts/run.sh` copies it to
`pi/SYSTEM.md` on every run, which is where pi looks and which is gitignored for exactly
that reason. `game.yml` records how the game is reached and driven — descriptively, since
nothing loads it at runtime.

**`pi/` and `.mcp.json`** — [pi](https://pi.dev) is the harness, with
[pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) attaching it to the
plugin's MCP endpoint. The adapter's `directTools` mode registers all eleven bridge tools
as first-class tools with their real schemas, rather than behind a discovery proxy the
model would have to search before it could call anything. Eleven tools is well inside the
range where that is the right trade; a server with a hundred would want the proxy. The
adapter's own two tools are turned off so the bridge's are the only ones the model sees:
the `mcp` discovery proxy with `--exclude-tools mcp` in `scripts/run.sh`, and `mcpScript`
with `"scriptMode": false` in `.mcp.json`.

pi is configured through a repo-local agent directory (`PI_CODING_AGENT_DIR`), so a run
is self-contained and does not read or write a developer's global pi setup.

## Why one tool first, and eleven now

`evaluate` takes a JavaScript string, runs it in the plugin context, and returns the
result. It reaches the whole plugin API, which means it reaches every game action, and
for the first runs it was deliberately the entire action surface.

The alternative was a set of typed tools — `find_build_sites`, `build_path`,
`operate_ride` — which is better in most respects: the schema teaches the model what is
possible, invalid calls are rejected before they run, and the tool list is a readable
contract. It was also, at that point, a guess. Which typed tools to build depends on
which actions a model actually reaches for and which it fumbles, and nobody knew that
yet. One general tool answers the question; a hand-picked set of typed tools assumes the
answer.

The runs answered it, and there are now ten typed tools beside `evaluate`. Each exists
because transcripts showed the same failure repeatedly: the model could not discover a
ride's footprint, could not find anywhere to put one, laid paths that connected nothing,
could not open the park without hand-writing `park.setFlag("open", true)`, and in one run
spent ten calls inventing `ride.open = true` and `queryAction("set_ride_status")` —
neither of which exists, and the game answers an unknown action name with a cheerful
null. `evaluate` stayed, because the typed tools do not reach tracked rides and were
never going to reach everything; it now refuses an action name the game does not know
rather than passing that null back as a result.

"Rejected before they run" is meant literally, and had to be made so. The MCP layer
validates each argument against the slice of JSON Schema the tools declare — type,
`required`, unknown properties, and now `enum`, `minimum` and `maximum` — and names the
property and its legal range in the refusal. Left to the game, an out-of-range number
comes back as "Value out of range" naming no field, which is a message a model cannot act
on: a run lost several turns sending `inspectionInterval: 30`, meaning thirty minutes, to
a setting that is an index from 0 to 6.

The list is capped by the same reasoning that produced it. Every tool is re-read by the
model on every turn, so a redundant one costs context and invites it to pick the weaker
option; that is why upstream's `getDate`, `getParkInfo` and `showError` remain in the
tree but are not registered. What each tool is allowed to decide on the model's behalf
is [tool-design.md](tool-design.md).

Results from `evaluate` are sanitised before they are returned: prototype getters are
walked so native game objects do not serialise as `{}`, circular references are cut,
functions are dropped, arrays and object keys are capped, and an oversized result is
truncated with a note telling the model to narrow its query. Without this, a single
`map.rides` would consume the context window.

## The model side

The harness talks to an OpenAI-compatible endpoint. The first runs use open-weight
models on Apple Silicon, which sets a tight context budget and makes two things matter
more than they otherwise would:

- **A lean, byte-stable prompt prefix.** A local runner can cache the prefix across turns
  and skip re-processing it, but only if it does not change. Nothing injects a timestamp
  or per-turn preamble at the top of the prompt.
- **A short tool list.** Small models handle a handful of tools far better than dozens.
  Eleven is a deliberate ceiling, not an accident: a tool earns its place by fixing a
  failure a run actually showed, and the three inherited from upstream were dropped for
  failing that test.
