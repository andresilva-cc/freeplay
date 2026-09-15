/**
 * `games/openrct2/prompt.md` is the one piece of model-facing text nothing in this package
 * imports, so an edit to it breaks no build and fails no test - and it is the largest
 * influence of any of them, read on every turn of every run.
 *
 * The test a sentence has to pass is WHERE IT CAME FROM, not how detailed it is.
 *
 * - Game-derived: a fact a player reads off the game's own windows, its manual or the
 *   scenario briefing. The model has no screen, so stating what the screen would show is
 *   restoring perception, and it is fair however specific it is.
 * - Bridge-derived: what a tool is called, what arguments it takes, what it returns, and the
 *   fact that the game is held still between calls. Interface documentation, not game
 *   knowledge, and the model can read it nowhere else.
 * - Harness-derived: what the agent loop and its compaction do to the model's own context.
 *   Same standing as the bridge: it is a property of the runtime, not a move in the game.
 * - Transcript-derived: a sentence that is in the prompt only because someone watched a
 *   model get something wrong. That is an answer key. It goes, even when it is true, and
 *   even when removing it makes the next run worse.
 *
 * The last category is why the `why` strings below are provenance and not measurements.
 * Fifteen of the nineteen recorded sessions are one model, so a prompt justified session by
 * session is that model's mistakes written down - and every other model is then scored
 * against an exam it never sat. `noTranscriptCitations` enforces that mechanically.
 *
 * So this pins both halves - the facts that must be there, and the steers that have been cut
 * and must not come back. Every assertion is on words. The prompt is folded to a single line
 * first, so rewrapping a paragraph, renumbering a list or moving a section cannot fail it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getMcpTools } from "../src/tools/index.ts";
import {
    IMPERATIVE_OPENERS,
    STEERS,
    TRANSCRIPT_CITATION,
    openerPattern
} from "./modelFacingRules.ts";
import type { Provenance } from "./modelFacingRules.ts";

/** Across packages: the prompt belongs to the game, not to the bridge that serves it. */
const PROMPT_PATH = fileURLToPath(new URL("../../../games/openrct2/prompt.md", import.meta.url));

function readPrompt(): string {
    return readFileSync(PROMPT_PATH, "utf8").replace(/\s+/g, " ");
}

/**
 * `Provenance` and `TRANSCRIPT_CITATION` moved to ./modelFacingRules.ts, which the tool
 * descriptions are now held to as well. They arrive in the same context window as this file
 * on the same turn, so a rule that bound only prompt.md just moved the steer next door.
 */

/**
 * Rules the model can read nowhere else, each carrying the source that makes it fair to
 * state. Cutting one hides the rules rather than protecting the model's judgment; justifying
 * one by a transcript turns the prompt into an answer key for whichever model was watched.
 */
const FACTS: { fact: string; from: Provenance; why: string }[] = [
    { fact: "`open_park` is the only thing in this bridge that opens it", from: "bridge", why: "which call admits guests is interface, not game knowledge: `open_park` fires the action, `evaluate` reaches the same flag, and nothing else here does" },
    { fact: "no guests exist otherwise", from: "game", why: "the game puts nobody in a closed park, which is why every other condition below is unmeasurable until this one is met" },
    { fact: "`guestsCanReach` is that walk and nothing else, because a guest boards off ordinary path abutting the door", from: "bridge", why: "what the field measures, and the game rule under it: a guest boards from ordinary path beside the door, so reachability is that walk and not the presence of a queue" },
    { fact: "`hasQueue` is not on that list", from: "game", why: "the game admits a guest to a ride with no bound queue, so a queue is not an admission condition" },
    { fact: "throughput rather than admission", from: "game", why: "what a bound queue buys in the simulation: several guests waiting at once instead of one" },
    { fact: "`brokenDown` is shut until a mechanic walks to it, and", from: "game", why: "the game's own rule for a broken ride, stated where the ride-is-open condition is rather than in a dispatch list at the end" },
    { fact: "`hire_staff` is what puts a mechanic in the park", from: "bridge", why: "the only call here that hires one, named beside the breakdown it answers" },
    { fact: "counted nowhere but `guest_feedback`", from: "bridge", why: "which tool carries guest thoughts; no other result contains them, and a reader has no slot in a list about changing things" },
    { fact: "A path reaches its `exitDoor`, or guests board and cannot get off: `exitConnected`", from: "game", why: "the game requires a way out as well as a way in, and this is the field that reports it" },
    { fact: "Guests weigh `price` against that ride's `value`", from: "game", why: "the game's own pricing rule, shown to a player as `value` beside the price in the ride window" },
    { fact: "Miss one and the ride is finished, paid for, and earning nothing", from: "game", why: "the game charges the build cost up front, so an unmet condition is a paid-for zero rather than a neutral outcome" },
    { fact: "It sells over the counter from the ONE tile it faces", from: "game", why: "how the game serves a stall: one neighbouring tile, fixed by the rotation it was built at" },
    { fact: "guests standing in a queue buy nothing", from: "game", why: "why a queue on a stall's serving tile serves nobody. This replaced an imperative - `run an ordinary path onto that tile, not a queue` - with the game rule underneath it" },
    { fact: "`build_flat_ride` is the only build tool there is", from: "bridge", why: "this bridge has one build call; without saying so the recipe reads as one option among several" },
    { fact: "`isFlatRide: false` is a tracked ride, laid piece by piece with `evaluate`", from: "bridge", why: "what the field means, and which call reaches the rides the build tool excludes" },
    { fact: "Building again builds and pays for a second ride", from: "game", why: "the game places and charges for a second ride rather than repairing the first, so a half-attached ride is not fixed by rebuilding it" },
    { fact: "Money is in tenths: 1000 means 100.00", from: "bridge", why: "the unit every price argument and every money field in this API is in, where the game's own windows show a decimal" },
    { fact: "`inspectionInterval` is an index from 0 to 6, not minutes", from: "bridge", why: "an enum the API takes where the game's window shows minutes" },
    { fact: "Ratings are fixed-point (652 is 6.52, -1 unrated)", from: "bridge", why: "the encoding the API returns, where the game's window shows a decimal" },
    { fact: "A queue is ordinary walkable path, and guests cross one no ride has claimed like any other path", from: "game", why: "how the game's own pathfinding treats a queue tile: it is path, not a wall" },
    { fact: "What severs a route is a ride claiming a tile: binding a queue to an entrance dead-ends the one tile that door opens onto", from: "game", why: "the game clears the far-side edge of the tile at the door and nothing else, which is the whole of the severing rule" },
    { fact: "0 for a door on bare ground, counted for a door already carrying an unbound queue", from: "bridge", why: "what `queueCutsOff` counts, which follows from the severing rule above" },
    { fact: "path laid back over a queue unbinds it from its ride", from: "game", why: "the game unbinds the queue when ordinary path is laid over it, which undoes a working entrance with no refusal; pinned without its article because the sentence moved to the front of a bullet" },
    { fact: "counts the park gate and every ride door as a ride", from: "bridge", why: "what `nearestRideDistance` measures against: ride track or an entrance building, and the park's gate is an entrance building" },
    { fact: "an unbounded loop freezes the game with no error and ends the run", from: "bridge", why: "`evaluate` runs on the game's own thread, which no schema states and no result can report" },
    { fact: "`keys(value)` is what reads them", from: "bridge", why: "the plugin API's own replacement for `Object.keys`, which is empty on game objects. Stated as what the API provides rather than as an instruction to use it" },
    { fact: "Nothing here searches for one", from: "bridge", why: "there is no site-search call in this bridge, so the tile is the model's to name. A prompt that does not say so implies a finder that does not exist, and a turn is spent asking for it" },
    { fact: "and only a 3x3 is centred on it", from: "game", why: "how the game lays a ride's tiles around the origin - the layout a player sees as the ghost under the cursor, and the half of the geometry no rule covers" },
    { fact: "its door opens onto the tile one further out, which is where that ride's queue goes", from: "game", why: "the game's own door geometry: a door position is two tiles, and the second is the one a player sees and the model cannot" },
    { fact: "A ride needs two of these, one for the entrance and one for the exit", from: "game", why: "the game requires both buildings before a ride takes anyone" },
    { fact: "A tile carrying another ride's queue is a door position the game takes", from: "game", why: "the game accepts an entrance there and re-chains the queue. The prompt asserted the opposite until `describe_placement` was read against it, and `describe_placement` lists such doors with `queueServesRide` set" },
    { fact: "A placement's origin and rotation are yours and nothing reports them", from: "bridge", why: "the one placement value no tool returns, which is why the rest of that section is a map from reported field to argument and not a rule against naming a tile" },
    { fact: "every reachable tile is on exactly one run, and their `tiles` add up to `reachableTiles`", from: "bridge", why: "the arithmetic `paths` guarantees, and the only check available on the payload the model was handed" },
    { fact: "`severingComputed` false says so rather than reporting nothing severs", from: "bridge", why: "a figure that was not computed has to be distinguishable from a zero" },
    { fact: "`queueCutsOff` measures that before you build", from: "bridge", why: "the cost of a door is reported ahead of the build rather than discovered after it" },
    { fact: "`remove_path` takes the footpath or queue off the tiles it names", from: "bridge", why: "the call that undoes a path, named at the trap it answers" },
    { fact: "handed back to `remove_path` as its own `tiles` it lifts exactly those, so a run laid wrong is not permanent", from: "bridge", why: "both calls take the same field under the same name, so the undo is a copy rather than a reconstruction - and it sits in the build recipe beside the call that lays the run, not in Traps" },
    { fact: "It paves the tiles listed in `tiles` and no others: no line is filled in between them, nothing is added to reach anything, and the order is left alone", from: "bridge", why: "`build_path`'s whole contract. Nothing routes and nothing is filled in, so a model expecting a router draws two tiles and waits for a line that never comes" },
    { fact: "those two runs cannot share a tile", from: "game", why: "follows from the unbinding rule above: a tile in both runs breaks one of them" },
    { fact: "A queue laid onto another ride's queue is not refused: the game chains the two lines into one", from: "game", why: "the game chains them, so the bridge reports what was lost rather than refusing a move the game allows" },
    { fact: "Nothing goes on ground the park does not own, and `buy_land` buys only the tiles a scenario has put up for sale", from: "game", why: "the scenario decides which tiles are for sale, and nothing can make an unlisted tile buyable" },
    { fact: "A rectangle that is part for sale buys the part that is rather than failing, and `buy_land`'s `notOwned` names the tiles it did not get, so the purchase is itself the reading", from: "bridge", why: "what the call does with a mixed rectangle, which is the only way to read which tiles a scenario sells; it has to arrive before `no tool lists which tiles those are` reads as a closed door" },
    { fact: "Buying a sloped tile makes it the park's, not flat", from: "game", why: "ownership and terrain are separate in the game, and no typed tool here levels ground" },
    { fact: "`build_path` lays flat path only, and that is the tool's limit rather than the game's", from: "bridge", why: "the slope claim the prompt used to make as the game's: OpenRCT2 footpaths run up slopes, so a model told a path needs level ground is told the game refuses something it does not" },
    { fact: "Water is not ground: a tile of it fails `fits`", from: "game", why: "the game will not stand a ride on water, and `fits` counts it with unowned and sloped ground rather than silently" },
    { fact: "How fast the clock runs is `set_game_speed`, whose `speed` is a setting and not a multiplier", from: "bridge", why: "the argument's shape, which looks like a multiplier and is not; the scale itself lives once, on the `speed` argument, pinned below" },
    { fact: "the only picture of the park there is, and its size in tiles is its price", from: "bridge", why: "`view_map` is the one tool that draws rather than reports, and its cost scales with the window asked for, which no tool description states" },
    { fact: "The game is held still between your calls", from: "bridge", why: "the clock gate in src/clockGate.ts: no scenario time passes while the model thinks. It reverses what this paragraph said for nine commits, and a prompt that still says time runs while you think is read every turn and cannot be checked" },
    { fact: "`wait` is the only call that spends any: it takes a number of GAME days, 0.1 to 12", from: "bridge", why: "the unit and the bounds of the one call that advances the clock. The argument used to be real seconds, and a prompt naming the old unit asks for a call the schema refuses" },
    { fact: "while it is `paused` no scenario time passes at all", from: "bridge", why: "what a pause the model asked for does, which is a different thing from the hold the bridge keeps between calls" },
    { fact: "`park_status` carries both, as `speed` and `paused`", from: "bridge", why: "which fields report the two settings `set_game_speed` writes" },
    { fact: "A result carrying `scenarioEnded` is the game saying the scenario is over", from: "bridge", why: "the field that appears on every result once the game decides, and is absent while the scenario is still being played, so its presence is the whole signal" },
    { fact: "Nothing asks you anything again unless you call a tool, so a turn that ends by letting the park run and checking back later ends the run there", from: "harness", why: "the agent loop continues only while a tool is called. No schema can carry it, because it is a fact about the loop and not about any tool in it" },
    { fact: "When the context fills it is replaced by a written summary", from: "harness", why: "a property of the runtime the model is running inside, which nothing in the game or the bridge reports and the model has no other way to learn" },
    { fact: "the summaries are additive: each carries the last one's facts forward and has no way to say that one of them has stopped being true", from: "harness", why: "pi's own update prompt says PRESERVE all existing information from the previous summary, so a superseded fact is carried forward rather than corrected" },
    { fact: "Nothing in a summary was read from the park", from: "harness", why: "which text in context is evidence and which is recollection, with no procedure attached to it" },
    { fact: "A tool result is not summarised at all but dropped whole", from: "harness", why: "the other half of what compaction does, and the silent half: the rule above describes facts carried forward and wrong, this one describes readings that are simply gone" },
    { fact: "a tile named with no reading of it in context is recalled rather than seen", from: "harness", why: "what follows from the two rules above. It states which text is an observation and leaves the decision to go and look to the model" }
];

/**
 * STEERS moved to ./modelFacingRules.ts with the rest of the vocabulary, because the tool
 * descriptions are held to it now too. `usually` was on this list and in `view_map`'s
 * description at the same time, and the description was the copy nothing read.
 */

test("the prompt states the rules of the simulation the model can read nowhere else", function () {
    const prompt = readPrompt();

    for (let i = 0; i < FACTS.length; i++) {
        assert.ok(
            prompt.indexOf(FACTS[i].fact) >= 0,
            "prompt.md no longer says \"" + FACTS[i].fact + "\" - " + FACTS[i].why
        );
    }
});

test("the prompt tells the model what the world is, never what to want", function () {
    const prompt = readPrompt();

    for (let i = 0; i < STEERS.length; i++) {
        const match = STEERS[i].pattern.exec(prompt);

        assert.equal(
            match,
            null,
            "prompt.md has picked up \"" + (match ? match[0] : "") + "\" - " + STEERS[i].why
                + ". docs/tool-design.md: a fact about the world stays, a steer goes."
        );
    }
});

/**
 * The defect this file had itself, and the one it exists to stop.
 *
 * Every pinned fact above used to be defended by a recorded run - "measured in session
 * 01a092cd", "9 of 17 calls", "site #1 in 11 of 12 builds". Fifteen of the nineteen recorded
 * sessions are one model, so a prompt assembled that way is that model's mistakes written
 * out, and every other model is then scored against an exam it never sat. The worst single
 * line it produced was a throughput figure - "one run measured 3 customers against 16" -
 * which is available from no game window and pre-answers the build-a-queue question.
 *
 * So a fact is defended by where it comes from: the game a player can see, the bridge's own
 * interface, or the harness the model runs inside. A run may still be what prompted someone
 * to look; it may not be what the sentence rests on. If the only defence of a sentence is
 * that a model got it wrong, the sentence is an answer key and belongs out of the prompt.
 */
test("every pinned fact is defended by where it came from, not by a session it was measured in", function () {
    for (let i = 0; i < FACTS.length; i++) {
        const entry = FACTS[i];
        const cited = TRANSCRIPT_CITATION.exec(entry.why);

        assert.equal(
            cited,
            null,
            "the pin on \"" + entry.fact + "\" is defended by a transcript (\"" + (cited ? cited[0] : "")
                + "\"). Defend it by the game window, the manual, the scenario briefing, this API or the"
                + " agent loop - or drop the sentence from prompt.md. A fact that exists only because a"
                + " model was watched getting it wrong is that model's answer key."
        );

        assert.ok(
            entry.from === "game" || entry.from === "bridge" || entry.from === "harness",
            "\"" + entry.fact + "\" has no provenance, so nothing says why it is fair to state"
        );
    }

    for (let i = 0; i < STEERS.length; i++) {
        assert.equal(
            TRANSCRIPT_CITATION.exec(STEERS[i].why),
            null,
            "a steer is cut for what it does to a decision, not for what one run did with it"
        );
    }
});

/**
 * A fact that lives in two places is a fact paid for twice, on every turn of every run. A fact
 * that lives in neither is worse, and silent. So where a fact was cut from one place it is
 * pinned in the other, and the prompt is checked for having let it back in.
 */
test("the game speed scale is stated once, in the schema and not in the prompt", function () {
    // The four-item scale was in the prompt, in `set_game_speed`'s tool description and in
    // `park_status`'s at the same time. The surviving copy is `set_game_speed.speed`, because
    // that is the text read at the moment a speed is being chosen, and a speed outside 1-4 is
    // refused only after the turn that asked for it is already spent.
    const tools = getMcpTools();
    const speedTool = tools.filter(function (tool) { return tool.name === "set_game_speed"; })[0];

    assert.ok(speedTool, "set_game_speed is registered");

    const properties = speedTool.inputSchema.properties as Record<string, { description: string }>;

    assert.match(properties.speed.description, /1 is normal, 2 runs the simulation twice as fast, 3 four times, 4 eight times/,
        "the scale has to survive somewhere the model reads, and this is where it was kept");

    const prompt = readPrompt();

    assert.doesNotMatch(prompt, /1 is normal, 2 twice/,
        "the prompt's copy was cut; it names `set_game_speed` and the tool states the numbers");
    assert.doesNotMatch(prompt, /4 eight times/);
});

test("park_status does not restate the speed scale a third time", function () {
    // It still has to say what its own `speed` and `paused` fields are - that is the fields'
    // meaning and nothing else carries it - but not what the numbers mean.
    const tools = getMcpTools();
    const status = tools.filter(function (tool) { return tool.name === "park_status"; })[0];
    const text = String(status.description);

    assert.match(text, /`speed` and `paused` are the two values `set_game_speed` sets/,
        "which fields they are, and which tool sets them, stays");
    // `paused` kept its name through the clock gate and changed meaning underneath it: it was
    // `context.paused` verbatim, which now answers true on essentially every turn. What it
    // reports is the pause the MODEL asked for, and the disambiguation is the load-bearing
    // half of the field - a name that survived a redefinition is the one that misleads.
    assert.match(text, /it is NOT the clock being stopped between your calls/,
        "the field kept its name through a redefinition, so the description has to say which pause it means");
    assert.doesNotMatch(text, /1 is normal|2 twice|four times|eight times/,
        "the scale belongs to `set_game_speed.speed`, and a third copy is a third payment for it");
});

/**
 * The prompt outlived a change to the clock and went on describing the old one.
 *
 * The bridge holds the game paused between tool calls, `wait` takes game days rather than
 * real seconds, and `set_game_speed` now buys real time rather than scenario time. The
 * prompt is read on every turn and the model cannot check it against anything, so a stale
 * sentence here is worse than a missing one: it is a false statement of the rules, believed.
 *
 * The facts themselves are pinned in FACTS. What this adds is the other side - the sentences
 * that were true and are not, kept out by their own words, and the prompt's bounds for `wait`
 * checked against the schema that enforces them so the two cannot drift apart again.
 */
test("the prompt describes the clock the bridge actually keeps", function () {
    const prompt = readPrompt();

    assert.doesNotMatch(prompt, /Time runs while you think|while you think,? so what you read is a snapshot/i,
        "the game is held still between calls; thinking costs the scenario nothing");
    assert.doesNotMatch(prompt, /lets the clock run for a few real seconds|for a few real seconds/i,
        "`wait` takes GAME days, not real seconds - a prompt naming the old unit asks for a call the schema refuses");
    assert.doesNotMatch(prompt, /money comes in on its own as the game runs/i,
        "takings arrive only while the clock is running, which is inside `wait`");
    assert.doesNotMatch(prompt, /counts `sampled` of|`sampled`/,
        "`guest_feedback` reports `guestsRead`; `sampled` was renamed when the read stopped claiming to be a sample");

    const tools = getMcpTools();
    const waitTool = tools.filter(function (tool) { return tool.name === "wait"; })[0];

    assert.ok(waitTool, "wait is registered");

    const days = (waitTool.inputSchema.properties as Record<string, { minimum: number; maximum: number }>).days;

    assert.ok(
        prompt.indexOf("GAME days, " + String(days.minimum) + " to " + String(days.maximum)) >= 0,
        "prompt.md states a range for `wait` that is not the schema's " + String(days.minimum)
            + " to " + String(days.maximum) + ", so one of the two is lying about what a call will be given"
    );
});

/**
 * `view_map` stopped drawing a grid of one character per tile and now reads each row as runs
 * of `<firstX>-<lastX><kind>`. A grid asks its reader to count columns against a coordinate
 * header to name a tile; a run states the tile numbers it covers. Naming a tile is the whole
 * point of reading the map, and one of those two formats makes the reader do arithmetic to
 * get there.
 *
 * The kinds and the shape of a run are stated once, in the tool's own description, which is
 * the text in context on the turn a window is being read. The prompt says what the tool
 * answers and what it costs - the cost is the part no description carries - and the grid's
 * vocabulary must not survive in it, because a picture the prompt promises and the tool does
 * not draw is a falsehood the model reads every single turn and cannot check.
 */
test("the map's kinds are stated once, in view_map's description and not in the prompt", function () {
    const tools = getMcpTools();
    const view = tools.filter(function (tool) { return tool.name === "view_map"; })[0];

    assert.ok(view, "view_map is registered");

    const text = String(view.description);

    assert.match(text, /<firstX>-<lastX><kind>/, "the shape of a run lives here");
    assert.match(text, /A leading `U` means the park does not own that\s+ground/, "and so do the kinds");

    const prompt = readPrompt();

    assert.doesNotMatch(prompt, /one character per tile|character a tile|a text grid|`view_map` grid/i,
        "the prompt promised a grid; it is not a grid any more, and the prompt is read every turn");
    assert.doesNotMatch(prompt, /<firstX>|`UP`|`UQ`|first of these kinds/,
        "the run format and the kind list belong to the description, and a second copy is a second payment for them");
    assert.ok(prompt.indexOf("the only picture of the park there is, and its size in tiles is its price") >= 0,
        "what stays in the prompt is the cost, which no tool description states");
});

test("the footprint geometry clear_scenery dropped still stands in describe_placement", function () {
    // `clear_scenery` explained that `x`,`y` is a build origin and not a centre, which is the
    // same explanation `describe_placement` carries - and describe_placement is the tool that
    // hands the rectangle over, so it is the one that has to say not to recompute it.
    const tools = getMcpTools();
    const placement = tools.filter(function (tool) { return tool.name === "describe_placement"; })[0];
    const clear = tools.filter(function (tool) { return tool.name === "clear_scenery"; })[0];
    const placementText = String(placement.description);

    assert.match(placementText, /THE ORIGIN IS NOT THE CENTRE AND NOT A CORNER/,
        "what the origin is");
    assert.match(placementText, /a square centred on the origin is the wrong ground for every footprint but a 3x3/,
        "and why a recomputed rectangle is wrong");
    // Both halves used to be orders - "Never work that rectangle out from ..." here and "do
    // not work them out from the ride's size" in clear_scenery. They state the same geometry
    // now without opening on one, because test/toolDescriptions.test.ts holds every tool
    // description to the same imperative-opener list this file holds prompt.md to.
    assert.match(placementText, /That rectangle is the game's own layout and not a function of `x`, `y` and the ride's size/,
        "and where the rectangle comes from, at the tool that hands it over");

    const clearText = String(clear.description);

    assert.match(clearText, /Those four ARE the ride's\s+ground: the ride's size does not give the rectangle/,
        "clear_scenery keeps the short form: the four corners are the ground, and the size is not");
    assert.doesNotMatch(clearText, /A 4x4 ride runs from its origin/,
        "the worked examples were the duplicated half and live in describe_placement");
});

/**
 * The argument that used to be optional, and now cannot be.
 *
 * `rideObject`, `x`, `y` and `rotation` between them ARE the placement. A tool that defaults
 * any of the four is choosing part of it, which is the decision this bridge hands back - so
 * the schema requires all four and the text says why there is nothing to fall back on.
 * Rotation is the one that reads as optional, because three of the four look like a location
 * and it looks like a detail; for a shop it is the whole of the placement.
 */
test("describe_placement.rotation says it is required and why there is no default", function () {
    const tools = getMcpTools();
    const placement = tools.filter(function (tool) { return tool.name === "describe_placement"; })[0];
    const properties = placement.inputSchema.properties as Record<string, { description: string }>;
    const rotation = properties.rotation.description;

    assert.deepEqual((placement.inputSchema.required || []).slice().sort(), ["rideObject", "rotation", "x", "y"],
        "all four name the placement, so none of them may be filled in by the tool");
    assert.match(rotation, /There is no default/,
        "why there is nothing to leave out");
    assert.match(rotation, /for a shop it is the whole of it/,
        "and the one case where rotation means something other than a footprint");
    assert.match(rotation, /4 is refused rather than read as 0/,
        "the bound, which is the part that stops a wasted turn");
});

/**
 * The steer that survives a vocabulary audit is the one made of structure rather than words.
 *
 * Three passes cut steering phrases out of "Each turn" and left its shape untouched: a
 * numbered 1-4 procedure, singular throughout, whose step 1 fixed the opening call of every
 * turn and whose step 2 was one act. That is `start by` and "decide the one thing holding the
 * park back" said in punctuation instead of words, and both of those are in STEERS above. The
 * proof that STEERS cannot see it: "1. Call `park_status`. 2. Build a merry-go-round. 3. Price
 * it at 15." passes every pattern in that list. So the shape is pinned here directly.
 */
const TURN_HEADING = "## Each turn";

/** The "Each turn" section on its own, unfolded: the shape is what is being read. */
function turnSection(): string {
    const raw = readFileSync(PROMPT_PATH, "utf8");
    const start = raw.indexOf(TURN_HEADING);

    assert.ok(start >= 0, "prompt.md no longer has an \"" + TURN_HEADING + "\" section, so this is checking nothing");

    const body = raw.slice(start + TURN_HEADING.length);
    const next = body.indexOf("\n## ");

    return next < 0 ? body : body.slice(0, next);
}

/**
 * IMPERATIVE_OPENERS and openerPattern moved to ./modelFacingRules.ts. The tool descriptions
 * run the same two against everything after their opening sentence, which is where
 * `Never work that rectangle out from` and `READ `cost` ON EVERY OPTION` were sitting.
 */


test("the turn section is prose, so it fixes no opening call and no act-per-turn", function () {
    const numbered = /^[ \t]*\d+[.)][ \t]/m.exec(turnSection());

    assert.equal(
        numbered,
        null,
        "prompt.md's \"Each turn\" section has picked up a numbered step (\"" + (numbered ? numbered[0].trim() : "")
            + "\"). A numbered procedure read every turn prescribes a first call and one action per turn, which is"
            + " the steer STEERS cannot see because it is made of structure. docs/tool-design.md: a fact about the"
            + " world stays, a steer goes."
    );
});

test("no sentence or heading in the prompt opens by telling the model what to do", function () {
    const raw = readFileSync(PROMPT_PATH, "utf8");

    for (let i = 0; i < IMPERATIVE_OPENERS.length; i++) {
        const match = openerPattern(IMPERATIVE_OPENERS[i]).exec(raw);

        assert.equal(
            match,
            null,
            "prompt.md has picked up a sentence or heading opening \"" + (match ? match[1] : "") + "\" - only an"
                + " action can follow it, so the line is an instruction whatever it goes on to say."
                + " docs/tool-design.md: a fact about the world stays, a steer goes."
        );
    }
});

/**
 * The same check, aimed at the line the eye lands on first.
 *
 * A heading is read before the paragraph under it and is the one line a model skimming for
 * the relevant section actually reads, so an instruction there is read more often than one
 * anywhere else in the file. `## Copy values across; never work them out` was two of them in
 * eight words, and every word-level pattern in this file walked past it.
 *
 * A heading that names what a section is about is a noun phrase. One that joins two clauses
 * with a semicolon, or forbids something, is a rule of conduct with a `##` in front of it.
 */
test("every heading names a subject rather than giving an order", function () {
    const headings = (readFileSync(PROMPT_PATH, "utf8").match(/^#{1,6} .*$/gm) || []);

    assert.ok(headings.length > 3, "the heading scan found almost nothing, so it is not checking anything");

    for (let i = 0; i < headings.length; i++) {
        const heading = headings[i];

        assert.doesNotMatch(heading, /;/,
            "the heading \"" + heading + "\" joins two clauses, which is how an order gets into a title");
        assert.doesNotMatch(heading, /\bnever\b|\balways\b|\bdo not\b|\bdon't\b|\bmust\b/i,
            "the heading \"" + heading + "\" forbids or requires something, so it is a rule of conduct and not a subject");
    }
});

/**
 * Naming a tool is not the same as making it findable.
 *
 * The closing "Which tool changes what" sentence is a dispatch list, read at the end of a
 * prompt whose problems were all described further up - and a tool that only reads has no
 * slot in a list about changing things at all. A lever named only there is named at the
 * moment the model has stopped looking for one.
 *
 * So the check is position, not presence: each of these has to appear somewhere above
 * "## Each turn", beside the situation it answers. This is a claim about the shape of the
 * document rather than about any run: the prompt states the problems first, so the tool that
 * answers a problem belongs where the problem is stated. Falling back to the dispatch list is
 * the regression, and the one the previous test cannot see.
 */
const TOOLS_NAMED_AT_THE_PROBLEM: { tool: string; problem: string }[] = [
    { tool: "remove_path", problem: "a path or queue that went down wrong, which is otherwise permanent as far as the prompt says" },
    { tool: "guest_feedback", problem: "a ride that meets every condition and still takes nobody" },
    { tool: "buy_land", problem: "ground the park does not own, and which tiles a scenario is selling" },
    { tool: "hire_staff", problem: "a ride the game has marked brokenDown, which no other tool reopens" },
    { tool: "evaluate", problem: "everything the typed tools do not reach, including a tile's ownership" }
];

test("a tool is named where the problem it answers is stated, not only in the dispatch list", function () {
    const raw = readFileSync(PROMPT_PATH, "utf8");
    const dispatch = raw.indexOf(TURN_HEADING);

    assert.ok(dispatch >= 0, "there is no \"" + TURN_HEADING + "\" section, so this is checking nothing");

    const problems = raw.slice(0, dispatch);

    for (let i = 0; i < TOOLS_NAMED_AT_THE_PROBLEM.length; i++) {
        const entry = TOOLS_NAMED_AT_THE_PROBLEM[i];

        assert.ok(
            problems.indexOf("`" + entry.tool + "`") >= 0,
            "prompt.md names `" + entry.tool + "` nowhere before \"" + TURN_HEADING + "\", so the only place the"
                + " model meets it is the dispatch list at the end - not beside " + entry.problem + "."
                + " All five of these were named in the prompt and called zero times in session 01a092cd."
        );
    }
});

test("every tool the prompt names is a tool that exists", function () {
    const prompt = readFileSync(PROMPT_PATH, "utf8");
    const tools = getMcpTools();
    const registered: Record<string, boolean> = {};

    for (let i = 0; i < tools.length; i++) {
        registered[tools[i].name] = true;
    }

    // Tool names are the only snake_case thing the prompt puts in backticks; fields are
    // camelCase. Naming a lever the model cannot reach is what teaches it to invent action
    // names, so this fails on a tool that was renamed or never shipped.
    const named = prompt.match(/`[a-z]+(?:_[a-z]+)+`/g) || [];

    for (let i = 0; i < named.length; i++) {
        const name = named[i].replace(/`/g, "");
        assert.ok(registered[name], "prompt.md names `" + name + "`, which is not a registered tool");
    }

    assert.ok(registered.evaluate, "the prompt sends the model to `evaluate` for everything the typed tools miss");
    assert.ok(named.length > 5, "the tool-name scan found almost nothing, so it is not checking anything");
});

/**
 * And the other direction. A tool the prompt never names is one the model has to find in
 * the tool list on its own; `view_map` shipped and went unnamed here, which is how this
 * check came to exist.
 */
test("every tool that reaches the game is named in the prompt", function () {
    const prompt = readFileSync(PROMPT_PATH, "utf8");
    const missing = getMcpTools().filter(function (tool) {
        return prompt.indexOf("`" + tool.name + "`") < 0;
    }).map(function (tool) {
        return tool.name;
    });

    assert.deepEqual(missing, [], "prompt.md names no " + missing.join(", ")
        + ", so nothing in the text the model reads every turn says the tool is there");
});
