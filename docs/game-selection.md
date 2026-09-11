# Game selection

What makes a game reachable by an agent that reads state and issues actions, and which
games qualify. Surveyed September 2026; roughly seventy titles considered.

## Criteria

**Pausable or turn-based.** A local model takes seconds per decision. A game that will
not wait cannot be played this way — the decision arrives after the situation it was
made for is gone.

**A scriptable interface with both read and write depth.** Reading state is not enough;
the interface has to expose the actions that matter. A modding API that can query the
world but only change cosmetics is a dead end, and this is the first thing to check for
any candidate.

**Quantifiable outcomes.** A scenario objective, a score, a win condition — something
that says whether the run went well without a human adjudicating.

**Headless capability.** Not required, and for some games not even useful (see
[why-this-is-hard.md](why-this-is-hard.md) on where the bottleneck actually is), but it
matters for unattended batch runs.

**A licence that permits it**, and ideally a community that is fine with bots.

## Games that ship a first-party interface for a bot to play them

This turns out to be a whole class rather than a curiosity. OpenTTD's NoAI framework is
the best-known example, but it is far from alone.

Open source:

| Game | Interface |
|---|---|
| **0 A.D.** | `--rl-interface` socket plus a `zero_ad` Python client with `reset()` / `step(actions)`, and an in-engine JS AI API |
| **OpenRCT2** | Official JS/TS plugin API; `context.executeAction()` / `queryAction()` over ~80 typed actions; `context.subscribe()` hooks |
| **The Battle for Wesnoth** | Lua AI framework — an `ai` table with `ai.execute_*` and custom candidate actions |
| **FreeOrion** | The entire AI is Python behind a typed interface; swap it with `--ai-path` |
| **Warzone 2100** | JS skirmish-AI API of ~168 functions; bots ship as `.js`. Also `--enablecmdinterface` |
| **Freeciv** | `--LoadAI` pluggable AI modules |
| **Simutrans** | Squirrel scripted-AI-*player* API — commands, players, lines, convoys, schedules, pathfinding |
| **OpenTTD** | The NoAI framework |
| **Recoil / Spring** | `AI/Interfaces` plus language wrappers |
| **TripleA** | Java AI module |
| **Mindustry** | JS mods via Rhino, Java mods, a headless server console, and an in-game `mlog` VM |
| **Robocode Tank Royale** | WebSocket bot protocol |
| **Angband** | The Borg autoplayer is in mainline |
| **Screeps** | The game is the API |

Commercial: **Timberborn** (a first-party HTTP API, plus a community C# mod exposing
building placement and pathing over HTTP), **Dota 2** (Lua bot API), **StarCraft II**
(s2client), **Tabletop Simulator** (External Editor API, including *Execute Lua Code* —
one bridge would reach a very large number of board games).

## Why OpenRCT2 first

It has the best-documented action surface of anything in the list. `openrct2.d.ts` is
close to six thousand lines, the actions are typed, and `queryAction` will cost an action
without applying it. Game speed and pausing are themselves game actions, so pacing is
part of the same uniform interface rather than a side channel.

It is also pausable by construction, has explicit scenario objectives to score against,
and — the deciding practical factor — most of a bridge already existed. IntelOrca's
plugin had already solved serving a protocol from inside the sandboxed plugin, which was
the only genuinely uncertain piece.

The obvious alternative was **0 A.D.**, whose `--rl-interface` is a purpose-built,
step-based, headless interface and is in some ways cleaner. **Wesnoth** has the best
batch-run ergonomics of anything surveyed — `--nogui --multiplayer --exit-at-end
--multiplayer-repeat N` means repeated runs are a built-in feature rather than
scaffolding someone has to write. Both remain good next targets, and each would need its
own bridge: an external process wrapping 0 A.D.'s socket, a wrapper around Wesnoth's Lua
framework. Different implementations, same harness, because MCP already makes attachment
uniform.

## Ruled out, and why

- **Xonotic** — real-time only.
- **StarCraft II, Brood War, Dota 2** — first-party APIs, but real-time.
- **The Farmer Was Replaced** — the right idea, but no external API.
- **Endless Sky** — no runtime scripting API found.
- **Space Station 14** — real-time, and has no goal to score against.
- **Pixel-based benchmark harnesses** — orthogonal to this approach rather than
  competing with it; they measure a different thing.

## Unverified

Modding or scripting surfaces that could not be confirmed either way: Transport Fever 2,
Civilization IV's Python API, Offworld Trading Company, Prison Architect's Lua modding,
Hedgewars' Lua surface, Simutrans' headless flags, X4, Vintage Story, Stationeers, Old
World. Open questions, not negatives.
