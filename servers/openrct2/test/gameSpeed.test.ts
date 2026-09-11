import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import { getMcpToolDefinitions } from "../src/tools/decorators.ts";
import { getMcpTools } from "../src/tools/index.ts";
import { GameSpeedTools, setGameSpeed } from "../src/tools/gameSpeed.ts";
import type { GameSpeedOutcome, GameSpeedRequest } from "../src/tools/gameSpeed.ts";
import type { DeferredMcpResult } from "../src/tools/types.ts";

function withGame(build: (game: FakeGame) => void, run: (game: FakeGame) => void, options?: { inert?: boolean }): void {
    const game = new FakeGame(8, 8, options);
    build(game);
    const restore = game.install();

    try {
        run(game);
    } finally {
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
