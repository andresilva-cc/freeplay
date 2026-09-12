# Freeplay

An AI that actually plays video games — by reading real game state and issuing real
game actions, not by looking at screenshots and simulating a keyboard.

The first game is [OpenRCT2](https://openrct2.org), the open-source RollerCoaster
Tycoon 2 reimplementation. A plugin runs inside the game process and serves an MCP
endpoint over loopback TCP. An agent harness connects to it and plays the scenario.

The first models are open-weight models running locally on Apple Silicon. Neither that
nor OpenRCT2 is baked into the design.

## How it fits together

```
  ┌──────────────────────┐         ┌──────────────────────────────────┐
  │ pi + pi-mcp-adapter  │  MCP    │ OpenRCT2                         │
  │                      │ ──────► │  └ freeplay-bridge plugin        │
  │ local model via oMLX │  HTTP   │      TCP listener → POST /mcp    │
  └──────────────────────┘         │      evaluate → plugin API       │
                                   └──────────────────────────────────┘
```

The model sees the park through tools that report what a player reads off the screen,
and changes it through tools that carry out a decision it has already made. Sixteen of
them, because every tool is re-read by the model on every turn and a small model handles
a handful far better than dozens. That includes the game's own clock: a person playing
controls the speed and the pause key, so the model does too. Where that line sits — and
why it matters — is
[docs/tool-design.md](docs/tool-design.md). `evaluate` runs arbitrary JavaScript against
the plugin API and remains available for everything the other tools do not cover,
tracked rides above all.

## Prerequisites

- **macOS on Apple Silicon.** Nothing here is macOS-specific in principle; the paths and
  the local-inference setup are.
- **OpenRCT2**, plus the original RCT2 data files from Steam or GOG. The free
  OpenGraphics/OpenSFX replacements are untested here.
- **Node.js 20+** to build the plugin.
- **[pi](https://pi.dev)** as the agent harness.
- **An OpenAI-compatible endpoint serving a local model.** These instructions assume
  [oMLX](https://omlx.ai); anything speaking the same API works.

## Setup

Build the plugin and install it into OpenRCT2:

```bash
npm --prefix servers/openrct2 install
npm --prefix servers/openrct2 run build
npm --prefix servers/openrct2 run copy
```

`run copy` writes the bundle to
`~/Library/Application Support/OpenRCT2/plugin/freeplay-bridge.js`. On Linux the plugin
directory is `~/.config/OpenRCT2/plugin`.

Then configure the endpoint:

```bash
cp .env.example .env
$EDITOR .env
```

## Running

1. Start OpenRCT2 and load a scenario.
2. Check the in-game console for `Server listening on 127.0.0.1:8080`.
3. Start the run:

```bash
./scripts/run.sh
```

The script verifies both the bridge and the model endpoint before starting, copies
`games/openrct2/prompt.md` to `pi/SYSTEM.md` as the system prompt, and launches pi with
the bridge's tools and nothing else. Everything pi needs lives in `./pi`, so your global
pi configuration is untouched. `prompt.md` is the copy to edit — `pi/SYSTEM.md` is
generated on every run and gitignored.

It also compares the plugin build the game is running against the one in `out/`, and warns
if they differ, so a run is not spent testing code that is not loaded.

While the bridge is up you can also poke at it directly — `http://127.0.0.1:8080/swagger`
for the REST surface, `/dashboard` for a status page.

## Working on the plugin

```bash
./scripts/deploy-plugin.sh
```

Builds, installs, and then refuses to return until the running game reports the build id
it just produced. OpenRCT2's plugin hot reloading is silent when it does not fire, and
testing against a stale bundle is an expensive way to spend an afternoon. Turn hot
reloading on with `enable_hot_reloading` under `[plugin]` in OpenRCT2's `config.ini`,
edited while the game is closed.

The park logic has a test suite — over four hundred tests over a fake game that queues
actions the way the real one does, rotates track pieces the way the game does, and throws
on an action it does not model rather than answering "that worked". It also has an inert
mode where actions are accepted and never applied, so a tool that reports success for work
that did not happen fails the suite:

```bash
npm --prefix servers/openrct2 test
```

## What this is at the moment

One game, one model, attached and observed. There is no scoring, no scenario suite, no
persistent agent memory and no reconciliation of what the agent believes against what
the game says. Those are all interesting and all deferred.

[docs/tool-design.md](docs/tool-design.md) covers where the line sits between helping
the model and playing for it. [docs/why-this-is-hard.md](docs/why-this-is-hard.md) covers
the problems that show up once runs get long, and
[docs/game-selection.md](docs/game-selection.md) covers what makes a game reachable this
way at all.

## Layout

| Path | What it is |
|---|---|
| `servers/openrct2/` | The OpenRCT2 plugin that serves MCP from inside the game |
| `servers/openrct2/test/` | Tests for the park logic, against a fake game |
| `games/openrct2/` | The system prompt and the game definition |
| `pi/` | Repo-local pi configuration: provider, models, settings |
| `scripts/run.sh` | Preflight checks, then launch |
| `docs/` | Architecture and background |

## Licence

MIT. `servers/openrct2/` is a fork of
[IntelOrca/openrct2-mcp](https://github.com/IntelOrca/openrct2-mcp) by Ted John, also
MIT; its licence and attribution are preserved in place.
