/**
 * Everything the model reads on a turn, held to one rule.
 *
 * `prompt.test.ts` audits `games/openrct2/prompt.md` - 14,698 characters, read every turn.
 * The tool list is read on the same turn, out of the same context window, and is 43,905
 * characters: three times the prompt, and until this file existed it was exempt from every
 * rule the prompt had. The rewrite that cleaned the prompt demonstrated what that buys, by
 * moving vocabulary out of the audited file into the unaudited one - `usually` ended up in
 * `view_map`'s description, `Never work that rectangle out from` in `describe_placement`'s,
 * and both passed.
 *
 * The model cannot tell the two sources apart. Neither does this file: the lists in
 * `modelFacingRules.ts` are imported by both, so a steer has no cheaper place to sit.
 *
 * Three kinds of check live here.
 *
 * 1. The prompt's own rules, applied to every description string - the vocabulary, the
 *    imperative openers, the ban on defending a sentence with a transcript.
 * 2. Claims the code does not back. The repo's worst bug class is a tool asserting something
 *    the game never said; a refusal once named a `park_status` field that did not exist. So
 *    every backticked identifier in model-facing text has to appear in `src/`.
 * 3. The two rules a banned-word list cannot express: a budget, so text cannot be added
 *    without a decision, and a provenance table for quantified and ranked claims about what
 *    the park gets - which is the shape a deleted measurement comes back in.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getMcpTools } from "../src/tools/index.ts";
import {
    DECLARED_CLAIMS,
    IMPERATIVE_OPENERS,
    OUTCOME_COMPARISON_HINGE,
    OUTCOME_NOUN_PATTERN,
    QUANTIFIED_OUTCOME,
    STEERS,
    TRANSCRIPT_CITATION,
    afterOpeningSentence,
    openerPattern,
    sentencesOf
} from "./modelFacingRules.ts";

const PROMPT_PATH = fileURLToPath(new URL("../../../games/openrct2/prompt.md", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

/** One description string as the model receives it, with enough address to fix it by. */
interface ModelFacingString {
    /** The tool it arrives with, or "prompt.md". */
    source: string;
    /** Where inside that tool: `description`, `inputSchema.properties.x.description`, ... */
    where: string;
    text: string;
}

/**
 * Every `description` the MCP layer hands the client, at any depth.
 *
 * Walking the schema rather than listing the fields is the point: an argument description,
 * an enum doc and a nested item's description are all read by the model on the same turn as
 * the tool's own sentence, so a rule that only checked `tool.description` would leave the
 * 8,200 characters of argument text exempt - which is roughly where `usually` was hiding.
 */
function collectToolStrings(): ModelFacingString[] {
    const collected: ModelFacingString[] = [];

    getMcpTools().forEach(function (tool) {
        function walk(value: unknown, where: string): void {
            if (value === null || typeof value !== "object") {
                return;
            }

            const record = value as Record<string, unknown>;

            Object.keys(record).forEach(function (key) {
                const child = record[key];

                if (key === "description" && typeof child === "string") {
                    collected.push({ source: tool.name, where: where + ".description", text: child });
                } else if (child !== null && typeof child === "object") {
                    walk(child, where + "." + key);
                }
            });
        }

        if (typeof tool.description === "string") {
            collected.push({ source: tool.name, where: "description", text: tool.description });
        }

        walk(tool.inputSchema, "inputSchema");

        if (tool.outputSchema) {
            walk(tool.outputSchema, "outputSchema");
        }
    });

    return collected;
}

function readPromptRaw(): string {
    return readFileSync(PROMPT_PATH, "utf8");
}

/** The prompt is hard-wrapped, so every word-level rule reads it folded to one line. */
function readPromptFolded(): string {
    return readPromptRaw().replace(/\s+/g, " ");
}

/** Prompt and descriptions together: this is the text arriving on one turn. */
function allModelFacingStrings(): ModelFacingString[] {
    return [{ source: "prompt.md", where: "whole file", text: readPromptFolded() }]
        .concat(collectToolStrings());
}

/**
 * A description literal, cut out of the source before the source is allowed to vouch for a
 * name.
 *
 * Without this the check is circular and passes anything: the descriptions LIVE in `src/`, so
 * a field invented in a description occurs in `src/` by virtue of having been written there.
 * The first version of this test waved through `mechanicIsWalkingOver` for exactly that
 * reason. What has to carry the name is code that builds a payload, not the sentence
 * promising it.
 */
const DESCRIPTION_LITERAL = /description:\s*(?:\[[\s\S]*?\]\.join\([^)]*\)|"(?:[^"\\]|\\.)*")/g;

function readSourceTree(): string {
    const files: string[] = [];

    function walk(directory: string): void {
        readdirSync(directory, { withFileTypes: true }).forEach(function (entry) {
            const full = directory + "/" + entry.name;

            if (entry.isDirectory()) {
                walk(full);
            } else if (/\.(ts|js)$/.test(entry.name)) {
                files.push(readFileSync(full, "utf8").replace(DESCRIPTION_LITERAL, ""));
            }
        });
    }

    walk(SRC_DIR);

    return files.join("\n");
}

/**
 * Names this bridge never touches, which no payload of its own can therefore vouch for.
 *
 * Each is OpenRCT2's own, quoted so the model knows it exists and that this bridge does not
 * reach it. The list is short and every entry says which game thing it is, so an invented
 * field cannot be waved through by adding a line here without saying what it is.
 */
const GAME_OWN_NAMES: Record<string, string> = {
    freshTimeout: "the plugin API's second field on a guest thought; guest_feedback says outright that it does not read it",
    footpath_railings: "an OpenRCT2 object type, passed to context.getAllObjects by the caller rather than held by this bridge",
    footpath_surface: "the same, for the surface style"
};

test("the tool list is big enough that exempting it was the whole of the hole", function () {
    const strings = collectToolStrings();
    const total = strings.reduce(function (sum, entry) { return sum + entry.text.length; }, 0);

    assert.ok(strings.length > 60,
        "the description sweep found " + String(strings.length) + " strings, so it is walking the schema wrong"
            + " and every check below is checking almost nothing");
    assert.ok(total > readPromptFolded().length,
        "the descriptions came to " + String(total) + " characters against the prompt's "
            + String(readPromptFolded().length) + ". If that ever inverts, this file is reading the wrong thing:"
            + " the tool list has always been the larger half of what the model reads.");
});

test("no tool description steers the model the way the prompt may not", function () {
    collectToolStrings().forEach(function (entry) {
        STEERS.forEach(function (steer) {
            const match = steer.pattern.exec(entry.text);

            assert.equal(
                match,
                null,
                entry.source + " " + entry.where + " has picked up \"" + (match ? match[0] : "") + "\" - "
                    + steer.why + ". It arrives in the same context window as prompt.md on the same turn,"
                    + " so the prompt's list binds it. docs/tool-design.md: a fact about the world stays,"
                    + " a steer goes."
            );
        });
    });
});

/**
 * The exemption, and why it is one sentence wide.
 *
 * A tool description opens by naming what the tool does - "Buy the land rights to a rectangle
 * of tiles", "Open the ride once it is built", "Pave the tiles you name". That is the MCP
 * convention and it is the interface, not a steer: the imperative is the tool's own action,
 * not a move in the park. Everything after that first sentence is prose the model reads
 * beside the prompt, and an order there is an order.
 *
 * Five sentences failed this when it was written, all of them mid-description and all of them
 * shaped by a watched failure rather than by the game: `Never work that rectangle out from`,
 * `READ `cost` ON EVERY OPTION`, `Use it when you are siting something`, `never hand it to
 * clear_scenery`, `Do not work them out from the ride's size`.
 */
test("no sentence after a description's first opens by telling the model what to do", function () {
    collectToolStrings().forEach(function (entry) {
        const body = afterOpeningSentence(entry.text);

        IMPERATIVE_OPENERS.forEach(function (opener) {
            const match = openerPattern(opener).exec(body);

            assert.equal(
                match,
                null,
                entry.source + " " + entry.where + " has a sentence opening \"" + (match ? match[1] : "")
                    + "\" - only an action can follow it, so the line is an instruction whatever it goes on to"
                    + " say. The tool's FIRST sentence is exempt, because that one names what the tool does."
            );
        });
    });
});

test("no description is defended by a run rather than by the game or the bridge", function () {
    collectToolStrings().forEach(function (entry) {
        const cited = TRANSCRIPT_CITATION.exec(entry.text);

        assert.equal(
            cited,
            null,
            entry.source + " " + entry.where + " cites a transcript (\"" + (cited ? cited[0] : "") + "\")."
                + " Fifteen of the nineteen recorded sessions are one model, so text assembled that way is that"
                + " model's mistakes written down, and every other model is then scored against an exam it"
                + " never sat."
        );
    });
});

/**
 * The bug class this repo keeps producing: a tool asserting something the game never said.
 *
 * Two refusals once sent the model to a `park_status` field that did not exist, which costs
 * a turn and teaches it to invent field names. A backticked identifier in a description is a
 * promise that the payload carries it, and the cheapest possible check on that promise is
 * that the name occurs somewhere in the source that builds the payload.
 *
 * It is a weak check - `src/` contains the word, not necessarily on the object the sentence
 * claims - but it is the one that catches a name that was renamed, misspelled or imagined,
 * which is every instance of the defect so far. Names under four characters are skipped: `UQ`
 * and `UE` are map tags built up from two letters rather than fields, and a two-letter
 * substring search vouches for everything anyway.
 */
test("every field and tool named in model-facing text exists in the source", function () {
    const source = readSourceTree();
    const registered: Record<string, boolean> = {};

    getMcpTools().forEach(function (tool) { registered[tool.name] = true; });

    allModelFacingStrings().forEach(function (entry) {
        const named = entry.text.match(/`([A-Za-z][A-Za-z0-9_.:]*)`/g) || [];

        named.forEach(function (backticked) {
            const name = backticked.replace(/`/g, "");
            // `ride.width` is the `width` field of the result's `ride`: the path is how the
            // sentence addresses it, the last segment is the name the payload carries.
            const field = name.slice(name.lastIndexOf(".") + 1);

            if (field.length < 4) {
                return;
            }

            assert.ok(
                registered[name] || GAME_OWN_NAMES[field] !== undefined || source.indexOf(field) >= 0,
                entry.source + " " + entry.where + " names `" + name + "`, which is neither a registered tool,"
                    + " nor a name any code in src/ carries once the descriptions themselves are cut out, nor"
                    + " one of OpenRCT2's own in GAME_OWN_NAMES. A name the payload does not carry costs the"
                    + " turn that goes looking for it and teaches the model to invent the next one."
            );
        });
    });
});

test("every name declared as OpenRCT2's own is still quoted somewhere", function () {
    const everything = allModelFacingStrings().map(function (entry) { return entry.text; }).join("\n");

    Object.keys(GAME_OWN_NAMES).forEach(function (name) {
        assert.ok(
            everything.indexOf(name) >= 0,
            "GAME_OWN_NAMES still excuses `" + name + "`, which nothing the model reads mentions any more."
                + " A dead entry is a hole in the one check on invented field names."
        );
    });
});

/**
 * A budget, because the audit only ever runs on text that is already there.
 *
 * Every rule above is a filter on words someone already regretted. None of them is a reason
 * NOT to add a sentence, so the text grows and each new sentence is free. A ceiling makes
 * adding one a decision: it fails the build, and the commit that wants the sentence has to
 * raise this number, in the diff, where a reviewer reads it.
 *
 * These are the measured sizes rounded up, not an estimate of what is enough. Raising them
 * is allowed. Raising them silently is what this stops.
 */
const PROMPT_CEILING = 15000;
const DESCRIPTION_CEILING = 44200;

test("the prompt and the tool list are inside the budget they were last given", function () {
    const prompt = readPromptRaw().length;
    const descriptions = collectToolStrings().reduce(function (sum, entry) {
        return sum + entry.text.length;
    }, 0);

    assert.ok(
        prompt <= PROMPT_CEILING,
        "prompt.md is " + String(prompt) + " characters against a ceiling of " + String(PROMPT_CEILING)
            + ". Every turn of every run pays for it. Raise PROMPT_CEILING in the same commit and say what"
            + " the sentence is for, or cut something to make room."
    );
    assert.ok(
        descriptions <= DESCRIPTION_CEILING,
        "the tool descriptions are " + String(descriptions) + " characters against a ceiling of "
            + String(DESCRIPTION_CEILING) + ". Same bill, three times the size."
    );
});

/**
 * The share of the prompt that is pinned with a source.
 *
 * `prompt.test.ts`'s FACTS table covers about 27% of the file. The other 73% is not checked
 * by anything, and that is where the last of the answer key was found - "`reachable` is false
 * until step 4 and does not mean the build failed", a sentence no game window states and
 * which exists because someone watched a model rebuild a ride it already owned.
 *
 * Pinning all of it is a bigger change than this commit; holding the ratio is not. With the
 * pinned characters fixed, this floor is about 250 characters of unattributed prose before
 * the build fails, so a new SECTION cannot arrive unattributed. A new SENTENCE still can,
 * and that limit is stated in the report rather than hidden here.
 */
const MINIMUM_ATTRIBUTED_SHARE = 0.265;

test("the pinned share of the prompt does not slide", function () {
    const prompt = readPromptFolded();
    const promptTest = readFileSync(fileURLToPath(new URL("./prompt.test.ts", import.meta.url)), "utf8");
    const pinned = promptTest.match(/\{ fact: "((?:[^"\\]|\\.)*)"/g) || [];

    assert.ok(pinned.length > 40, "the FACTS scan found " + String(pinned.length) + " pins, so it is reading the wrong file");

    const covered: boolean[] = new Array(prompt.length).fill(false) as boolean[];

    pinned.forEach(function (entry) {
        const fact = entry.replace(/^\{ fact: "/, "").replace(/"$/, "").replace(/\\"/g, "\"");
        const at = prompt.indexOf(fact);

        if (at < 0) {
            return;
        }

        for (let i = at; i < at + fact.length; i++) {
            covered[i] = true;
        }
    });

    const share = covered.filter(Boolean).length / prompt.length;

    assert.ok(
        share >= MINIMUM_ATTRIBUTED_SHARE,
        "FACTS now pins " + (share * 100).toFixed(1) + "% of prompt.md, under the "
            + (MINIMUM_ATTRIBUTED_SHARE * 100).toFixed(1) + "% floor. Prose was added without a source, or a"
            + " pinned sentence was reworded so its pin no longer matches. Pin the new text or cut it."
    );
});

/**
 * The rule the banned-word list cannot express, and the reason this file is not theatre.
 *
 * A reviewer wrote a sentence that passes all 30 steers, all 33 imperative openers and the
 * heading rule: "A queue eight tiles long carries eight guests to a ride that a bare door
 * carries one to." It is a deleted throughput measurement - "one run measured 3 customers
 * against 16" - put back as prose. Nothing about its vocabulary is wrong, because vocabulary
 * was never what made it an answer key.
 *
 * What made it one is that it puts a NUMBER on what the park gets. A rule of the simulation
 * says what the game does; it almost never needs a figure, and when it does, someone can name
 * the window a player reads the figure off. So a quantified or ranked outcome claim has to be
 * declared in DECLARED_CLAIMS with a provenance, and one that is not fails here.
 */
test("no quantified or ranked claim about what the park gets goes undeclared", function () {
    allModelFacingStrings().forEach(function (entry) {
        sentencesOf(entry.text).forEach(function (sentence) {
            const quantified = QUANTIFIED_OUTCOME.exec(sentence);
            const ranked = OUTCOME_COMPARISON_HINGE.exec(sentence) && OUTCOME_NOUN_PATTERN.test(sentence);

            if (!quantified && !ranked) {
                return;
            }

            const declared = DECLARED_CLAIMS.some(function (claim) {
                return sentence.indexOf(claim.claim) >= 0;
            });

            assert.ok(
                declared,
                entry.source + " " + entry.where + " states \"" + sentence.trim().slice(0, 140) + "\", which "
                    + (quantified ? "puts a figure on" : "ranks two ways of running the park by")
                    + " what the park gets. That is the shape a deleted measurement comes back in: the words"
                    + " are clean and the arithmetic is the answer key. Declare it in DECLARED_CLAIMS with the"
                    + " game window, the manual or this API that makes it fair to state - or cut it."
            );
        });
    });
});

test("every declared claim is still in the text, and none is defended by a run", function () {
    const everything = allModelFacingStrings().map(function (entry) { return entry.text; }).join("\n");

    DECLARED_CLAIMS.forEach(function (entry) {
        assert.ok(
            everything.indexOf(entry.claim) >= 0,
            "DECLARED_CLAIMS still allows \"" + entry.claim + "\", which no longer appears anywhere the model"
                + " reads. A dead entry is a hole: it licenses the sentence coming back unreviewed."
        );

        const cited = TRANSCRIPT_CITATION.exec(entry.why);

        assert.equal(
            cited,
            null,
            "the claim \"" + entry.claim + "\" is defended by a transcript (\"" + (cited ? cited[0] : "")
                + "\"). A figure defended by a run is the answer key this rule exists to catch, declared"
                + " instead of hidden."
        );

        assert.ok(
            entry.from === "game" || entry.from === "bridge" || entry.from === "harness",
            "\"" + entry.claim + "\" has no provenance, so nothing says why a figure is fair there"
        );
    });
});
