# Why this is hard

Attaching a model to a game is a weekend. Having it play well for three simulated years
is not. These are the problems that appear once runs get long. None of them is solved
here yet; this is the map, not the answer.

## Structured state is not a convenience, it is the precondition

The obvious way to make a model play a game is to send it screenshots and have it
synthesise mouse and keyboard input. It generalises to any game, and that is its only
advantage.

The costs are structural. The model spends its capacity reading a user interface rather
than playing — parsing a ride's status from rendered pixels is work that contributes
nothing. Actions fail quietly: a click that lands slightly wrong does something else, or
nothing, and the model has no way to tell. Nothing is inspectable afterwards, so you
cannot separate "decided badly" from "the click missed".

Reading `ride.status` and calling `ridesetstatus` removes all three. The model's
remaining errors are decisions, which is what is actually interesting about the exercise.

## Long-horizon runs break on context, not on reasoning

A full scenario is hundreds to thousands of decisions. The naive loop appends every
observation and every action to the conversation and dies well before the end. Four
things matter.

**A simulation is close to Markovian, so history is mostly redundant.** Unlike a coding
agent, the model does not need the transcript: the current park contains nearly
everything relevant. What the state does *not* carry is intent ("I am raising prices
until the rating recovers"), failed attempts ("closing the water ride made things
worse"), and self-imposed policy ("no new rides until cash is above X").

**So memory should be a file the agent maintains, not a conversation it accumulates.**
Compact state plus a short durable plan is the whole memory architecture. The natural
shape is a rewritten-not-appended plan, an append-only ledger of actions and their
expected effects that is queried rather than read whole, and a hard-capped lessons file
where adding an entry requires deleting one. The cap is the interesting part: it bounds
growth and reveals what the agent thinks matters by what it is willing to forget.

**The bridge should answer questions, not hand over the world.** "Which rides have
queues over twenty minutes?" is a better tool than "give me every ride". Bridge design is
context engineering, and getting it wrong is what makes the naive version fail. Freeplay's
typed tools are each one answer to one question — `park_status` is the park as a player
reads it off the screen, not `map.rides` — and `evaluate` remains for the questions
nobody anticipated, capping its own result when the model asks for too much.

**Decisions have different frequencies.** Strategic choices — pricing stance, expansion
policy — happen rarely and deserve a large context. Tactical ones happen constantly and
need almost none. Running both through one loop at one budget wastes the expensive
context on the cheap decisions.

## An agent's memory drifts from the world

The failure mode of any agent journal is that it records "hired three mechanics" when
no mechanic was hired. The belief then compounds: every later decision is built on it.

This is ordinarily hard to detect. Here it is not, because the bridge can read actual
game state, which makes journal claims mechanically checkable. A reconciliation pass can
diff what the plan asserts against what the game says and hand the divergence back to the
agent as a correction.

That is worth building for two separate reasons. It keeps the agent honest, and how often
an agent believes its own plans executed is a measurable, general fact about long-horizon
agent memory — one that has nothing to do with theme parks.

## Context length is not the only budget

Running local open-weight models makes a third constraint visible that a hosted frontier
model hides: memory. Weights, KV cache and the peak allocation during prompt processing
all compete for the same pool, and prompt processing — not the cache — is usually what
runs out first. A model that comfortably holds a 128k cache can still fail while
processing a 60k prompt.

This has a direct design consequence: the system prompt stays lean and, critically,
byte-stable across turns, so a local runner can reuse a cached prefix instead of
reprocessing it. Anything that injects a timestamp or a per-turn preamble at the top of
the prompt silently defeats that and turns every turn into a full prefill.

There is also an open question worth stating plainly: quantised models are known to be
near-lossless on single-shot reasoning benchmarks, but long-horizon planning — where
small errors compound over hundreds of decisions — is not what those benchmarks measure.
Whether quantisation degrades a three-hundred-decision run more than a ten-step one is,
as far as we know, unmeasured.

## Rendering is not the bottleneck

It is tempting to run headless for speed. For this game that is a rounding error:
OpenRCT2 is a 2002-era engine and draws a frame in milliseconds, while a single local
model decision costs seconds. Inference dominates by orders of magnitude.

The lever that actually controls throughput is `gamesetspeed`, which is a first-class
game action — the simulation can fast-forward between decisions with rendering left on.
So runs are rendered by default, and nothing is lost. That lever is the model's, through
`set_game_speed`: a person playing works the speed and pause keys constantly, so pacing is
part of the game rather than something the harness does around it, and a model that spends
scenario months deliberating at speed 4 has made a play mistake that shows up in the score.

One related assumption is worth retiring until someone verifies it: "run headless, then
re-render the interesting runs" depends on deterministic replay from a seed and command
log, which is unconfirmed for OpenRCT2. Record what you want to watch as you run it.
