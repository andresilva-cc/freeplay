/**
 * `games/openrct2/prompt.md` is the one piece of model-facing text nothing in this package
 * imports, so an edit to it breaks no build and fails no test - and it is the largest
 * influence of any of them, read on every turn of every run.
 *
 * `docs/tool-design.md` draws the same line through the prompt that it draws through a tool
 * description. A fact about how the simulation works stays: the model cannot read OpenRCT2's
 * source, so a game rule is knowledge it has no other way to get. An instruction, preference,
 * ranking or steer goes: it teaches nothing, and because a small model follows text more
 * reliably than it reasons, a steer makes a good run unmeasurable rather than merely impure.
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

/** Across packages: the prompt belongs to the game, not to the bridge that serves it. */
const PROMPT_PATH = fileURLToPath(new URL("../../../games/openrct2/prompt.md", import.meta.url));

function readPrompt(): string {
    return readFileSync(PROMPT_PATH, "utf8").replace(/\s+/g, " ");
}

/**
 * Rules of the simulation. Each one is something a human learns by playing and the model can
 * learn nowhere else, so cutting one hides the rules rather than protecting its judgment.
 */
const FACTS: { fact: string; why: string }[] = [
    { fact: "`open_park` is the only thing that opens it", why: "nothing else admits guests" },
    { fact: "no guests exist otherwise", why: "a closed park has no guests to measure anything with" },
    { fact: "A queue bound to that ride sits on its `entranceDoor` tile: `hasQueue`", why: "an entrance needs a queue, not a footpath" },
    { fact: "`guestsCanReach` is what proves it; `hasQueue` alone proves nothing, because a queue can be an island", why: "the failure that looks finished from every angle the API offers" },
    { fact: "A path reaches its `exitDoor`, or guests board and cannot get off: `exitConnected`", why: "both doors matter, not just the entrance" },
    { fact: "Guests weigh `price` against that ride's `value`", why: "the one rule that makes a price good or bad" },
    { fact: "Miss one and the ride is finished, paid for, and earning nothing", why: "an unmet condition is a paid-for zero, not a neutral outcome" },
    { fact: "It sells over the counter from the ONE tile it faces", why: "a stall serves one neighbour, fixed by its rotation" },
    { fact: "run an ordinary path onto that tile, not a queue", why: "guests in a queue buy nothing" },
    { fact: "`build_flat_ride` is the only build tool there is", why: "without it the build recipe reads as one option among several" },
    { fact: "`isFlatRide: false` is a tracked ride, laid piece by piece with `evaluate`", why: "what to do when the only build tool does not apply" },
    { fact: "Building again builds and pays for a second ride", why: "the mistake that produced two half-built burger bars" },
    { fact: "Money is in tenths: 1000 means 100.00", why: "every price argument in every tool" },
    { fact: "`inspectionInterval` is an index from 0 to 6, not minutes", why: "the values look like minutes and are not" },
    { fact: "Ratings are fixed-point (652 is 6.52, -1 unrated)", why: "a rating read as a plain number is off by a hundred" },
    { fact: "a queue laid across a route splits the park", why: "guests walk a queue to its ride but never through it" },
    { fact: "an ordinary path laid back over a queue unbinds it from its ride", why: "undoes a working entrance invisibly" },
    { fact: "counts the park gate and every ride door as a ride", why: "what `nearestRideDistance` is actually measuring" },
    { fact: "an unbounded loop freezes the game with no error and ends the run", why: "evaluate runs on the game's own thread" },
    { fact: "use `keys(value)`", why: "`Object.keys` is empty on game objects" },
    { fact: "`totalFound` is how many exist altogether", why: "the site list is a window, not the whole truth" },
    { fact: "`access` shows at most 8 of `accessTotal`", why: "the door list is a window too" },
    { fact: "`paths.reachableSample` is every reachable tile while `reachableSampleComplete` is", why: "when the sample is the truth and when it is a spread" },
    { fact: "`queueCutsOff` measures that before you build", why: "the cost of a door is countable ahead of time" },
    { fact: "Neither is permanent: `remove_path` takes the footpath or queue off the tiles it names", why: "the two path mistakes above had no remedy for eight sessions, and the model looped instead of undoing them" },
    { fact: "a `build_path` result's `route` handed back as its `waypoints` lifts exactly what that call laid", why: "the one addressing that undoes a build_path without working any coordinate out" },
    { fact: "Nothing goes on ground the park does not own, and `buy_land` buys only the tiles a scenario has put up for sale", why: "a tile outside the park is the one situation buying resolves, and an unlisted tile cannot be made buyable" },
    { fact: "Buying a sloped tile makes it the park's, not flat", why: "there is no levelling tool, so buying is not a remedy for ground a ride will not stand on" },
    { fact: "How fast it runs is `set_game_speed`: 1 is normal, 2 twice, 3 four times, 4 eight times", why: "these are the game's speed settings and not multipliers, so 8 is out of range and 4 is what eight times is called" },
    { fact: "while it is `paused` no scenario time passes at all", why: "scenario time is charged against thinking time, and one test run lost a full scenario year that way" }
];

/**
 * Steers. Each of these either was in the prompt and was cut, or is the shape of the thing
 * that keeps coming back: a ranking, a preference, a cadence, or a probability offered in
 * place of a reading. The bare words are here because they are how one arrives.
 */
const STEERS: { pattern: RegExp; why: string }[] = [
    { pattern: /holding the park back/i, why: "prescribes diagnose-then-remediate, and one thing per turn" },
    { pattern: /says nothing new/i, why: "talks the model out of looking, and is only probably true" },
    { pattern: /few considered decisions/i, why: "a verdict on one play style, cut once already" },
    { pattern: /fix the missing piece/i, why: "an imperative wrapped round a fact that already stands alone" },
    { pattern: /never a reason to rebuild/i, why: "same fact, stated as a prohibition" },
    { pattern: /\busually\b/i, why: "a probability standing in for a reading" },
    { pattern: /\bprefer/i, why: "ranks two options the model is supposed to choose between" },
    { pattern: /\bideally\b/i, why: "names a preferred outcome" },
    { pattern: /\bbest\b/i, why: "ranking is the tool playing" },
    { pattern: /\bworth\b/i, why: "whether something is worth it is the decision itself" },
    { pattern: /\bconsider(?:s|ing|ed)?\b/i, why: "steers attention rather than stating a fact" },
    { pattern: /\bmake sure\b/i, why: "an instruction" },
    { pattern: /\bremember\b/i, why: "an instruction" },
    { pattern: /\bsimply\b/i, why: "argues a course of action is easy, which is a judgment" },
    { pattern: /\bbetter\b/i, why: "a comparison between options" },
    { pattern: /\bmost important\b/i, why: "a ranking" },
    { pattern: /\bfocus on\b/i, why: "directs attention at one thing" },
    { pattern: /\bstart by\b/i, why: "prescribes an opening move" },
    { pattern: /\bpriorit/i, why: "ordering the model's options is the model's job" }
];

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
