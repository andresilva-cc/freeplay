import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import { resetClockGate } from "../src/clockGate.ts";
import { operateRide } from "../src/park/operate.ts";
import { buildPath, DEFAULT_PATH_OBJECT } from "../src/park/pathbuild.ts";
import type { BuildPathOutcome } from "../src/park/pathbuild.ts";
import { removePath } from "../src/park/pathremove.ts";
import type { RemovePathOutcome } from "../src/park/pathremove.ts";
import { getMcpToolDefinitions } from "../src/tools/decorators.ts";
import { getMcpTools } from "../src/tools/index.ts";
import { GameSpeedTools, setGameSpeed } from "../src/tools/gameSpeed.ts";
import type { GameSpeedOutcome, GameSpeedRequest } from "../src/tools/gameSpeed.ts";
import type { DeferredMcpResult } from "../src/tools/types.ts";

function withGame(build: (game: FakeGame) => void, run: (game: FakeGame) => void, options?: { inert?: boolean }): void {
    const game = new FakeGame(8, 8, options);
    build(game);
    const restore = game.install();

    // The gate remembers whether the model asked for a pause, and that outlives a test in
    // the same file. A pause left set would make the next test's fixture mean something else.
    resetClockGate();

    try {
        run(game);
    } finally {
        resetClockGate();
        restore();
    }
}

/** `context.setTimeout` applies the queued actions, so the outcome is ready on return. */
function set(request: GameSpeedRequest): GameSpeedOutcome {
    let outcome: GameSpeedOutcome | null = null;

    setGameSpeed(request, function (result) { outcome = result; });

    assert.ok(outcome, "setGameSpeed never called back");
    return outcome as unknown as GameSpeedOutcome;
}

/** The same call as the model makes it: raw arguments, through the MCP tool layer. */
function callTool(args: Record<string, unknown>): GameSpeedOutcome {
    let outcome: GameSpeedOutcome | null = null;

    (new GameSpeedTools().setGameSpeed(args) as DeferredMcpResult).start(function (result) {
        outcome = result as GameSpeedOutcome;
    });

    assert.ok(outcome, "set_game_speed never answered");
    return outcome as unknown as GameSpeedOutcome;
}

function names(game: FakeGame): string[] {
    return game.attempted.map(function (action) { return action.name; });
}

function nothing(): void { /* the default fake is already a running game at speed 1 */ }

test("the game runs at the speed that was asked for", function () {
    withGame(nothing, function (game) {
        set({ speed: 3 });

        assert.equal(game.gameValues.speed, 3, "the game itself has to be running faster");
    });
});

test("the speed goes through the game's own action, with the setting it takes", function () {
    withGame(nothing, function (game) {
        set({ speed: 4 });

        assert.deepEqual(names(game), ["gamesetspeed"]);
        assert.equal(game.attempted[0].args.speed, 4,
            "4 is the setting for eight times normal; sending 8 is out of range");
    });
});

test("pausing a running game stops the clock", function () {
    withGame(nothing, function (game) {
        set({ paused: true });

        assert.equal(game.gameValues.paused, true);
        assert.deepEqual(names(game), ["pausetoggle"]);
    });
});

test("asking to pause a game that is already paused leaves it paused", function () {
    // `pausetoggle` flips rather than sets. Firing it here would start the clock again,
    // which is the opposite of what was asked and invisible from the action's own result.
    withGame(function (game) {
        game.gameValues.paused = true;
    }, function (game) {
        set({ paused: true });

        assert.equal(game.gameValues.paused, true, "the game was unpaused by a call asking it to pause");
        assert.deepEqual(names(game), [], "nothing had to be toggled, so nothing should have been");
    });
});

test("unpausing lets the clock run again", function () {
    withGame(function (game) {
        game.gameValues.paused = true;
    }, function (game) {
        set({ paused: false });

        assert.equal(game.gameValues.paused, false);
    });
});

test("speed and pause can be set in one call", function () {
    withGame(nothing, function (game) {
        set({ speed: 2, paused: true });

        assert.equal(game.gameValues.speed, 2);
        assert.equal(game.gameValues.paused, true);
    });
});

test("a speed the game does not have is refused and the game keeps the one it had", function () {
    withGame(function (game) {
        game.gameValues.speed = 2;
    }, function (game) {
        const outcome = set({ speed: 8 });

        assert.equal(game.gameValues.speed, 2, "a refused call must not change the speed");
        assert.deepEqual(names(game), [], "and must not reach the game at all");
        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /between 1 and 4/);
        assert.match(outcome.detail, /not a multiplier/,
            "8 was almost certainly meant as eight times normal, which is 4");
    });
});

test("a call with neither argument changes nothing", function () {
    withGame(function (game) {
        game.gameValues.speed = 3;
    }, function (game) {
        const outcome = set({});

        assert.equal(game.gameValues.speed, 3);
        assert.deepEqual(names(game), []);
        assert.equal(outcome.ok, false);
    });
});

test("a speed the game never applied is reported as the speed the game has", function () {
    withGame(nothing, function (game) {
        const outcome = set({ speed: 4 });

        assert.equal(game.gameValues.speed, 1, "an inert game must not change speed");
        assert.equal(outcome.ok, false, "the game is still at 1, so this is not ok");
        assert.equal(outcome.speed, 1, "the speed reported has to be the one read back, not the one asked for");
    }, { inert: true });
});

test("a pause the game never applied is reported as still running", function () {
    withGame(nothing, function (game) {
        const outcome = set({ paused: true });

        assert.equal(game.gameValues.paused, false, "an inert game must not pause");
        assert.equal(outcome.ok, false);
        assert.equal(outcome.paused, false);
    }, { inert: true });
});

test("a paused game says plainly that no scenario time is passing", function () {
    withGame(nothing, function () {
        const outcome = set({ paused: true });

        assert.equal(outcome.ok, true);
        assert.match(outcome.detail, /no scenario time passes/);
    });
});

test("set_game_speed is registered as a deferred tool that bounds speed to 1 to 4", function () {
    const definitions = getMcpToolDefinitions(GameSpeedTools);

    assert.equal(definitions.length, 1);
    assert.equal(definitions[0].name, "set_game_speed");
    assert.equal(definitions[0].inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(definitions[0].inputSchema.properties || {}).sort(), ["paused", "speed"]);

    const speed = (definitions[0].inputSchema.properties || {}).speed as {
        enum?: number[]; minimum?: number; maximum?: number;
    };

    // src/mcp.ts enforces these before the tool runs, so a speed of 8 never reaches the
    // refusal above: the bound is what the model actually gets told about.
    assert.deepEqual(speed.enum, [1, 2, 3, 4]);
    assert.equal(speed.minimum, 1);
    assert.equal(speed.maximum, 4);

    const registered = getMcpTools().filter(function (tool) { return tool.name === "set_game_speed"; });
    assert.equal(registered.length, 1, "the tool has to be in the registry or the model never sees it");
});

test("the tool handler defers, floors a fractional speed and ignores a non-boolean pause", function () {
    withGame(nothing, function (game) {
        const outcome = callTool({ speed: 3.7, paused: "yes" });

        assert.equal(game.gameValues.speed, 3, "a fractional speed is floored, not rounded up out of range");
        assert.equal(game.gameValues.paused, false, "a pause that is not a boolean is ignored, never guessed at");
        assert.equal(outcome.ok, true);
    });
});

/** The registered tool's own description, which is the text the model reads every turn. */
function description(): string {
    const text = getMcpToolDefinitions(GameSpeedTools)[0].description;

    assert.equal(typeof text, "string", "the tool has to carry a description at all");
    return text as string;
}

/** The `paused` argument's description, which the MCP schema carries alongside it. */
function pausedArgumentDescription(): string {
    return argumentDescription("paused");
}

/** An argument's own description. The properties are where a fact the model needs to avoid an
 *  error belongs: a refusal only arrives after the turn that earned it is already spent. */
function argumentDescription(name: string): string {
    const properties = getMcpToolDefinitions(GameSpeedTools)[0].inputSchema.properties as
        Record<string, { description: string }>;

    assert.equal(typeof properties[name].description, "string", name + " has to carry a description");
    return properties[name].description;
}

test("the speed scale is stated once, on the argument that takes it", function () {
    // It used to be in three places at once - here, in `park_status`, and in the prompt - which
    // is ~350 tokens of the window spent on one four-item list, re-read on every single turn.
    // The argument is the copy that survives, because a bad `speed` is refused after the turn
    // is already spent: this is the text that has to stop that happening.
    const scale = /1 is normal, 2 runs the simulation twice as fast, 3 four times, 4 eight times/;

    assert.match(argumentDescription("speed"), scale,
        "the scale has to live on `speed` itself, which is the last place read before a call is made");
    assert.doesNotMatch(description(), scale, "and nowhere else on this tool");
    assert.match(argumentDescription("speed"), /not multipliers, so eight times normal is 4 and there is no 8/,
        "the trap is the point of stating the scale at all");
});

test("the description does not promise that game actions work while paused", function () {
    // Measured false against the running game: `buy_land` while paused came back
    // ok:false, tilesBought:0, "Construction not possible while game is paused!". A model
    // that pauses to think and then builds gets refusals the description told it not to
    // expect, and the prompt now hands it the clock to control.
    const text = description() + " " + pausedArgumentDescription();

    assert.doesNotMatch(text, /Game actions still work while paused/,
        "this was the false claim; it cannot come back in any description here");
    assert.doesNotMatch(text, /actions still work/i);
});

test("the description states the rule the game actually applies while paused", function () {
    // OpenRCT2 GameActionRunner.cpp `CheckActionInPausedMode`: while paused an action is
    // refused unless its GetActionFlags() carries Flags::AllowWhilePaused. Of what this
    // bridge fires, the map-changing ones do not carry it and the settings ones do.
    //
    // This is read off `paused` rather than off the tool description: the tool description
    // carried a word-for-word second copy of the same list, and the argument is the copy that
    // has to survive, because it is what is read at the moment the call is being written.
    const text = pausedArgumentDescription();
    const refused = ["build_path", "remove_path", "buy_land", "clear_scenery", "build_flat_ride"];

    assert.match(text, /Construction not possible while game is paused/,
        "the model recovers from the game's own wording, so the description has to carry it");

    for (let i = 0; i < refused.length; i++) {
        assert.ok(text.indexOf(refused[i]) >= 0,
            refused[i] + " is refused while paused and the description has to say so by name");
    }

    assert.match(text, /hire_staff/, "hiring does go through, and understating that is its own error");
    assert.match(text, /operate_ride/);
});

test("while paused the game refuses a map change and lets a ride setting through", function () {
    // The description is only worth what the behaviour is, so both halves are pinned against
    // the game's own gate rather than against the sentence.
    withGame(function (game) {
        game.addParkEntrance(2, 0);
        game.addPath(2, 2);
        game.rides.push({
            id: 0, name: "Ferris Wheel", type: 1, status: "closed", price: [10],
            stations: [{
                start: { x: 64, y: 96, z: 96 },
                entrance: { x: 96, y: 96, z: 96, direction: 3 },
                exit: { x: 32, y: 96, z: 96, direction: 1 },
                length: 0, queueTime: 0
            }],
            excitement: 500, intensity: 300, nausea: 200, totalCustomers: 0, totalProfit: 0,
            downtime: 0, reliability: 100, flags: 0, value: 40
        });
    }, function (game) {
        set({ paused: true });
        assert.equal(game.gameValues.paused, true, "the fixture has to actually be paused");

        let removed: RemovePathOutcome | null = null;
        removePath({ tiles: [{ x: 2, y: 2 }] }, function (result) { removed = result; });

        const outcome = removed as unknown as RemovePathOutcome;
        assert.equal(outcome.tilesRemoved, 0, "footpathremove has no AllowWhilePaused flag");
        assert.equal(game.tile(2, 2).elements.filter(function (element) {
            return element.type === "footpath";
        }).length, 1, "the path is still on the map, which is what the refusal meant");

        let operated = false;
        operateRide({ ride: 0, open: true }, function () { operated = true; });

        assert.ok(operated, "operate_ride never answered");
        assert.equal(game.rides[0].status, "open",
            "ridesetstatus does carry AllowWhilePaused, so saying nothing works while paused"
            + " would be the same mistake pointed the other way");
    });
});

test("the description no longer says a paused build_flat_ride strands a ride record", function () {
    // It used to, and it was true when it was written: ridecreate carries
    // Flags::AllowWhilePaused, so a build begun while paused bought a ride, laid no track,
    // and could not take it out again. build_flat_ride now refuses the whole call up front
    // while the game is paused, so nothing is created - and a description still promising an
    // orphan sends the model hunting for a ride that does not exist.
    const text = description() + " " + pausedArgumentDescription();

    assert.doesNotMatch(text, /ride record behind/, "nothing is left behind any more");
    assert.doesNotMatch(text, /cannot be demolished until you unpause/);
    assert.match(pausedArgumentDescription(), /build_flat_ride/,
        "the refusal is still a fact about the game and has to be stated");
    assert.match(pausedArgumentDescription(), /refuses the whole call while the game is paused/,
        "and what it actually does now is what the model needs to know");
});

test("the descriptions say what the game does and never say when to pause", function () {
    // docs/tool-design.md: a fact about the simulation stays, an instruction goes. Which
    // actions a paused game refuses is a fact the model cannot read anywhere else; when to
    // stop the clock is the decision the clock was handed over for.
    const text = description() + " " + pausedArgumentDescription();

    assert.doesNotMatch(text, /Unpause before you build/, "that is an instruction, not a fact");
    assert.doesNotMatch(text, /pause to read and decide/, "and so is this one");
    assert.doesNotMatch(text, /unpause to build/i);
    assert.doesNotMatch(text, /when to (?:pause|run fast)/i,
        "the sentence that named whose decision it was has gone with the rest of the tool"
            + " description: it stated no fact about the game, and the doesNotMatch guards above"
            + " are what actually keep the steer out.");
});

test("every tool the description names as refused is a tool that reports that refusal", function () {
    // The description is a promise about four other tools. Pinning only its wording lets the
    // wording and the tools drift apart, which is how it came to describe an orphaned ride
    // that no longer happens.
    const text = pausedArgumentDescription();
    const reporting = ["build_path", "remove_path", "buy_land", "clear_scenery"];

    for (let i = 0; i < reporting.length; i++) {
        assert.ok(text.indexOf(reporting[i]) >= 0, reporting[i] + " has to be named as refused while paused");
    }

    assert.match(text, /report that refusal in their own result/,
        "a model that reads a refusal in the tool's own result recovers; one told only a category thrashes");
});

test("a paused build_path and a paused remove_path both come back with the game's own words", function () {
    // The description's claim, executed against the fake's gate rather than trusted.
    withGame(function (game) {
        game.addParkEntrance(2, 0);
        game.addPath(2, 2);
        game.addPath(2, 3);
    }, function (game) {
        set({ paused: true });
        assert.equal(game.gameValues.paused, true, "the fixture has to actually be paused");

        let laid: BuildPathOutcome | null = null;
        buildPath({
            tiles: [{ x: 2, y: 4 }, { x: 2, y: 5 }], queue: false,
            surfaceObject: DEFAULT_PATH_OBJECT, railingsObject: 0
        }, function (result) { laid = result; });

        const built = laid as unknown as BuildPathOutcome;
        assert.equal(built.tilesPlaced, 0, "footpathplace has no AllowWhilePaused flag");
        assert.match(built.detail, /Construction not possible while game is paused!/,
            "build_path has to report the game's refusal, which is what the description promises");

        let taken: RemovePathOutcome | null = null;
        removePath({ tiles: [{ x: 2, y: 2 }, { x: 2, y: 3 }] }, function (result) { taken = result; });

        const removed = taken as unknown as RemovePathOutcome;
        assert.equal(removed.tilesRemoved, 0, "footpathremove has no AllowWhilePaused flag either");
        assert.match(removed.detail, /Construction not possible while game is paused!/,
            "and remove_path has to report it too");
    });
});

test("the speed is described as a bill in real time, not as a lever on the scenario", function () {
    // It used to be both, and that was the defect: the clock ran between calls, so the speed
    // setting decided how much of the scenario a turn cost and a faster machine played a
    // different game. The game is held still between calls now, so speed buys nothing and
    // costs nothing - except how long a `wait` takes and therefore how far one can reach.
    const text = description();

    assert.match(text, /does not run between your calls/,
        "the fact that changes how the model plays, stated where it decides whether to call this");
    assert.match(text, /about 1\.5 at speed 1 and 12 at speed 4/,
        "and what the setting is actually worth: the game days one wait can cover");
    assert.doesNotMatch(text, /months and years pass while you think/,
        "the claim this change made false cannot survive anywhere in the text");
    assert.match(argumentDescription("speed"), /real seconds a game day costs inside `wait`/,
        "the exchange rate belongs on the argument, which is the last thing read before a call");
});

test("pausing is described as what it now changes, which is the refusals and not the clock", function () {
    const text = pausedArgumentDescription();

    assert.match(text, /bridge already holds/,
        "a model told pausing buys thinking time would pause for a reason that no longer exists");
    assert.match(text, /`wait` refuses too until you unpause/,
        "and the consequence it has to weigh: its only way to spend time stops working");
});
