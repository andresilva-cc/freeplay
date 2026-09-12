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
    { fact: "`open_park` is the only thing in this bridge that opens it", why: "nothing else here admits guests, and `open_park.ts` says it with the same care: `evaluate` can still set the flag, which is what five earlier runs did" },
    { fact: "no guests exist otherwise", why: "a closed park has no guests to measure anything with" },
    { fact: "`guestsCanReach` is that walk and nothing else, because a guest boards off ordinary path abutting the door", why: "guestsCanReach is the entrance door tile being walkable from the gate and nothing more; demanding a queue of it reported four rides unreachable through 29 recorded boardings" },
    { fact: "`hasQueue` is not on that list", why: "a ride with no bound queue still takes guests, so pinning hasQueue as an admission condition was the disproven rule" },
    { fact: "throughput rather than admission", why: "what a bound queue actually buys: several guests waiting at once instead of one" },
    { fact: "one run measured 3 customers against 16", why: "the size of the throughput difference, and a number the model can read nowhere else" },
    { fact: "`brokenDown` is shut until a mechanic walks to it, and", why: "a broken ride is the one way an open ride earns nothing, and it is stated where the ride-is-open condition is, not in a dispatch list at the end" },
    { fact: "`hire_staff` is what puts a mechanic in the park", why: "hire_staff was named only in the closing dispatch list and went uncalled in a run with a breakdown" },
    { fact: "counted nowhere but `guest_feedback`", why: "guest_feedback reads and so has no slot in a list about changing things; this is the one place it is named beside the question it answers" },
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
    { fact: "A queue is ordinary walkable path, and guests cross one no ride has claimed like any other path", why: "measured live: turning two tiles into a queue changed no edge bit at all, so the old rule that a queue splits the park was false and sent the model round obstacles that were not there" },
    { fact: "What severs a route is a ride claiming a tile: binding a queue to an entrance dead-ends the one tile that door opens onto", why: "the real severing rule, and the only one - the game clears the far-side edge of the tile at the door and nothing else" },
    { fact: "0 for a door on bare ground, counted for a door already carrying an unbound queue", why: "which doors queueCutsOff charges, now that it no longer charges a bare-ground door the worst of its neighbours" },
    { fact: "path laid back over a queue unbinds it from its ride", why: "undoes a working entrance invisibly; pinned without its article because the sentence moved to the front of a bullet" },
    { fact: "counts the park gate and every ride door as a ride", why: "what `nearestRideDistance` is actually measuring" },
    { fact: "an unbounded loop freezes the game with no error and ends the run", why: "evaluate runs on the game's own thread" },
    { fact: "use `keys(value)`", why: "`Object.keys` is empty on game objects" },
    { fact: "`totalFound` is how many exist altogether", why: "the site list is a window, not the whole truth" },
    { fact: "`access` shows at most 8 of `accessTotal`", why: "the door list is a window too" },
    { fact: "every reachable tile is on exactly one run, and their `tiles` add up to `reachableTiles`", why: "the arithmetic that replaced the flat tile list, and the only check the model can run on the payload it was handed" },
    { fact: "`severingComputed` false says so rather than reporting nothing severs", why: "a missing figure read as a zero is the lie the flag exists to prevent" },
    { fact: "`queueCutsOff` measures that before you build", why: "the cost of a door is countable ahead of time" },
    { fact: "`remove_path` takes the footpath or queue off the tiles it names", why: "the path mistakes above had no remedy for eight sessions, and the model looped instead of undoing them" },
    { fact: "handed back to `remove_path` as its `waypoints` it lifts exactly those, so a run laid wrong is not permanent", why: "the undo now sits in the build recipe beside the build_path that lays the run, because a run of three failing build_path retries is where the model needed it and Traps is not where it was looking" },
    { fact: "Nothing goes on ground the park does not own, and `buy_land` buys only the tiles a scenario has put up for sale", why: "a tile outside the park is the one situation buying resolves, and an unlisted tile cannot be made buyable" },
    { fact: "A rectangle that is part for sale buys the part that is rather than failing, and `buy_land`'s `notOwned` names the tiles it did not get, so the purchase is itself the reading", why: "the model reasoned verbatim `I don't know which tiles are for sale` and gave up; the answer has to arrive before `no tool lists which tiles those are` reads as a closed door" },
    { fact: "Buying a sloped tile makes it the park's, not flat", why: "there is no levelling tool, so buying is not a remedy for ground a ride will not stand on" },
    { fact: "How fast it runs is `set_game_speed`, whose `speed` is a setting and not a multiplier", why: "the trap is that the numbers look like multipliers; the scale itself now lives once, on the `speed` argument, pinned below" },
    { fact: "`find_build_sites` is the largest single payload in a run", why: "measured across nine sessions: find_build_sites averages 1700 tokens and peaks at 6000, park_status averages 694 and peaks at 1506. The prompt named park_status, which sent the model economising on the cheaper of the two" },
    { fact: "the only picture of the park there is, and its size in tiles is its price", why: "view_map is the one tool that draws rather than reports, and its cost scales with the window asked for, which no tool description says" },
    { fact: "while it is `paused` no scenario time passes at all", why: "scenario time is charged against thinking time, and one test run lost a full scenario year that way" },
    { fact: "`park_status` carries both, as `speed` and `paused`", why: "a paused game is otherwise indistinguishable from a running one nothing is happening in, and a run can sit frozen to the end of it" },
    { fact: "When the context fills it is replaced by a written summary", why: "the model has no other way to know its own memory is not the transcript; measured in session 01a092cd, three consecutive summaries kept a demolished ride at its dead coordinates" },
    { fact: "the summaries are additive: each carries the last one's facts forward and has no way to say that one of them has stopped being true", why: "why a stale coordinate is never corrected rather than merely late - pi's own update prompt says PRESERVE all existing information from the previous summary" },
    { fact: "A ride demolished and rebuilt elsewhere still reads at its first coordinates there", why: "the exact measured failure: a Pirate Ship built at (56,26), demolished, rebuilt at (54,31), still summarised at (56,26)" },
    { fact: "Nothing in a summary was read from the park", why: "the fact that settles which text is evidence, with no procedure attached to it" },
    { fact: "A tool result is not summarised at all but dropped whole", why: "the other half of what a summary does, and the silent half: the additive-staleness rule above describes facts that are carried and wrong, this one describes readings that are simply gone. Five `view_map` results were dropped by one compaction while seventeen routine turns were kept" },
    { fact: "a tile named with no grid in context is recalled rather than seen", why: "what the model was doing on the turn after that compaction - it invented a path tile as empty and a ride's track three tiles off, walled off its own only fix, and spent the whole output budget with zero tool calls. States which text is an observation; the decision to go and look is left to it" }
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
    // Narrowed from /\bworth\b/: `park_status` describes a ride's `value` as roughly what a
    // guest thinks the ride is worth, which is the natural wording of the rule FACTS pins as
    // the one that makes a price good or bad. The steer is the verdict, not the noun.
    { pattern: /\bworth (?:it|doing)\b/i, why: "whether something is worth it is the decision itself" },
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
    assert.doesNotMatch(text, /1 is normal|2 twice|four times|eight times/,
        "the scale belongs to `set_game_speed.speed`, and a third copy is a third payment for it");
});

test("the footprint geometry clear_scenery dropped still stands in find_build_sites", function () {
    // `clear_scenery` explained that `x`,`y` is a build origin and not a centre, which is the
    // same explanation `find_build_sites` carries - and find_build_sites is the tool that hands
    // the rectangle over, so it is the one that has to say not to recompute it.
    const tools = getMcpTools();
    const sites = tools.filter(function (tool) { return tool.name === "find_build_sites"; })[0];
    const clear = tools.filter(function (tool) { return tool.name === "clear_scenery"; })[0];
    const sitesText = String(sites.description);

    assert.match(sitesText, /`x`,`y` is the build origin, which sits inside the footprint but is not a corner of it/,
        "what the origin is");
    assert.match(sitesText, /a square centred on it is the wrong ground for every footprint but a 3x3/,
        "and why a recomputed rectangle is wrong");
    assert.match(sitesText, /Never work the rectangle out from `x`, `y` and the ride's size/,
        "and the instruction that avoids the error, at the tool that hands the rectangle over");

    const clearText = String(clear.description);

    assert.match(clearText, /do not work them out\s+from the ride's size and do not use the site's `x`,`y`/,
        "clear_scenery keeps the short form: copy the four corners, do not derive them");
    assert.doesNotMatch(clearText, /A 4x4 ride runs from its origin/,
        "the worked examples were the duplicated half and live in find_build_sites");
});

test("find_build_sites.rotation still says why it can be left out", function () {
    // Never passed in 34 calls across nine sessions, which is the tool being used correctly.
    // Cutting the text that produces that would cost more than the text does, so both of its
    // facts are pinned: the tool already covers every distinct rotation, and a shop's rotation
    // is a serving side rather than a footprint.
    const tools = getMcpTools();
    const sites = tools.filter(function (tool) { return tool.name === "find_build_sites"; })[0];
    const properties = sites.inputSchema.properties as Record<string, { description: string }>;
    const rotation = properties.rotation.description;

    assert.match(rotation, /already searches every rotation that covers different ground/,
        "why passing one is unnecessary");
    assert.match(rotation, /a shop, whose rotation is which neighbour guests are served from/,
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
 * Openers that address the model directly. Not a list of forbidden English: each one can only
 * be followed by an action, so a sentence starting with it is an instruction however carefully
 * the rest of it is worded. The build recipe's own 1-4 is untouched by this, because the order
 * the game requires - ride, then doors, then paths - is a mechanic and not a cadence.
 */
const IMPERATIVE_OPENERS = ["Open with", "Start with", "Start by", "Decide", "Pick", "Choose"];

/** Start of a line, of a bullet, of a numbered step, or of a sentence. */
function openerPattern(opener: string): RegExp {
    return new RegExp("(?:^|\\n|[.!?;:]\\s|—\\s)[ \\t]*(?:[-*][ \\t]+|\\d+[.)][ \\t]+)?(" + opener + ")\\b", "i");
}

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

test("no sentence in the prompt opens by telling the model what to do", function () {
    const raw = readFileSync(PROMPT_PATH, "utf8");

    for (let i = 0; i < IMPERATIVE_OPENERS.length; i++) {
        const match = openerPattern(IMPERATIVE_OPENERS[i]).exec(raw);

        assert.equal(
            match,
            null,
            "prompt.md has picked up a sentence opening \"" + (match ? match[1] : "") + "\" - only an action can"
                + " follow it, so the sentence is an instruction whatever it goes on to say."
                + " docs/tool-design.md: a fact about the world stays, a steer goes."
        );
    }
});

/**
 * Naming a tool is not the same as making it findable.
 *
 * Five of fourteen tools were never called once in session 01a092cd - `remove_path`,
 * `guest_feedback`, `buy_land`, `hire_staff` and `evaluate` - and every one of them was
 * already named in the prompt. Four were named only in the closing "Which tool changes what"
 * sentence, which the model reads at the end of a prompt whose problems were all described
 * further up, and a tool that only reads has no slot in a list about changing things at all.
 *
 * So the check is position, not presence: each of the five has to be named somewhere above
 * "## Each turn", which is where the situation it answers is stated. Falling back to naming
 * it only in the dispatch list is the regression, and the one the previous test cannot see.
 */
const TOOLS_NAMED_AT_THE_PROBLEM: { tool: string; problem: string }[] = [
    { tool: "remove_path", problem: "a path or queue that went down wrong - the model retried the same failing build_path three times instead" },
    { tool: "guest_feedback", problem: "a ride that meets every condition and still takes nobody, which was the run's central question" },
    { tool: "buy_land", problem: "ground the park does not own, and which tiles a scenario is selling" },
    { tool: "hire_staff", problem: "a ride the game has marked brokenDown, which no other tool reopens" },
    { tool: "evaluate", problem: "everything the typed tools do not reach, including a tile's ownership" }
];

test("the five tools no run has called are named where their problem is stated", function () {
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
