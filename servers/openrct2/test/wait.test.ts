import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import { getMcpToolDefinitions } from "../src/tools/decorators.ts";
import { getMcpTools } from "../src/tools/index.ts";
import { WaitTools, wait } from "../src/tools/wait.ts";
import type { WaitOutcome, WaitRequest } from "../src/tools/wait.ts";
import type { DeferredMcpResult } from "../src/tools/types.ts";

/**
 * A run ended because the model decided to let the park run and check back, and nothing
 * ever invoked it again: the agent loop only continues while a tool is called, so "I will
 * wait" is indistinguishable from "I am finished". `wait` is that turn made real.
 *
 * Two things make these tests discriminating rather than decorative, and both are
 * deliberate. The clock is asserted against `game.date.ticksElapsed`, the fake's own
 * counter, which only `advanceRealMilliseconds` moves - so a tool that answers a plausible
 * outcome without ever handing control back to the game fails, where an assertion on the
 * returned object alone would pass. And every refusal is asserted to have moved the clock
 * ZERO ticks, so a tool that clamped a bad argument and waited anyway cannot pass by
 * returning `ok: false`.
 */

function withGame(
    build: (game: FakeGame) => void,
    run: (game: FakeGame) => void,
    options?: { inert?: boolean }
): void {
    const game = new FakeGame(8, 8, options);
    build(game);
    const restore = game.install();

    try {
        run(game);
    } finally {
        restore();
    }
}

/** `context.setTimeout` in the fake runs the slice and returns, so the outcome is ready. */
function letItRun(request: WaitRequest): WaitOutcome {
    let outcome: WaitOutcome | null = null;

    wait(request, function (result) { outcome = result; });

    assert.ok(outcome, "wait never called back");
    return outcome as unknown as WaitOutcome;
}

/** The same call as the model makes it: raw arguments, through the MCP tool layer. */
function callTool(args: Record<string, unknown>): WaitOutcome {
    let outcome: WaitOutcome | null = null;

    (new WaitTools().wait(args) as DeferredMcpResult).start(function (result) {
        outcome = result as WaitOutcome;
    });

    assert.ok(outcome, "wait never answered");
    return outcome as unknown as WaitOutcome;
}

/**
 * Do something to the park between two seconds of the wait.
 *
 * The fake runs a timer's callback inline once it has advanced the clock, so wrapping
 * `context.setTimeout` is the only place a test can stand while the game is running. The
 * wrapper goes away with the rest of `context` when the fake is uninstalled.
 */
function duringEachSecond(action: (second: number) => void): void {
    const scope = globalThis as unknown as {
        context: { setTimeout(callback: () => void, delay?: number): number };
    };
    const original = scope.context.setTimeout;
    let second = 0;

    scope.context.setTimeout = function (callback: () => void, delay?: number): number {
        return original.call(scope.context, function () {
            second++;
            action(second);
            callback();
        }, delay);
    };
}

function nothing(): void { /* the fake starts at speed 1, running, on year 1 month 0 day 1 */ }

function waitTool() {
    const tools = getMcpTools().filter(function (tool) { return tool.name === "wait"; });

    assert.equal(tools.length, 1, "`wait` is registered exactly once");
    return tools[0];
}

/* -------------------------------------------------------------------------------------
 * It actually lets time pass.
 */

test("the game's clock runs for exactly as long as the wait asked for", function () {
    withGame(nothing, function (game) {
        const outcome = letItRun({ seconds: 10 });

        // 40 ticks a second at speed 1, from OpenRCT2's GAME_UPDATE_FPS. Asserted exactly:
        // the failure this tool exists to prevent is a turn that appears to wait and does
        // not, and that failure shows up here as 0 while `outcome` still reads perfectly.
        assert.equal(game.date.ticksElapsed, 400, "the simulation has to have actually run");
        assert.equal(outcome.ok, true);
        assert.equal(outcome.seconds, 10);
    });
});

test("the wait is denominated in real time, so a faster game buys more of the scenario", function () {
    let slowDays = -1;
    let slowTicks = -1;

    withGame(nothing, function (game) {
        slowDays = letItRun({ seconds: 10 }).gameDays;
        slowTicks = game.date.ticksElapsed;
    });

    withGame(function (game) {
        game.gameValues.speed = 4;
    }, function (game) {
        const fast = letItRun({ seconds: 10 });

        // Speed 4 runs 1 << 3 updates per frame, so the same ten real seconds are worth
        // eight times the game time. A tool that worked its own game time out from
        // `seconds` - the obvious shortcut, and the one the description would then be
        // lying about - reports the same `gameDays` in both runs and fails here.
        assert.equal(game.date.ticksElapsed, slowTicks * 8, "eight times the simulation, same real wait");
        assert.equal(slowDays, 0, "ten seconds at speed 1 does not reach the next day");
        assert.equal(fast.gameDays, 6, "ten seconds at speed 4 is six game days");
        assert.ok(fast.gameDays > slowDays, "the same wait has to be worth more at a higher speed");
    });
});

test("the date the wait reports is the date the game is on", function () {
    withGame(function (game) {
        game.gameValues.speed = 4;
    }, function (game) {
        const outcome = letItRun({ seconds: 10 });

        assert.deepEqual(outcome.from, { year: 1, month: 0, day: 1 }, "where the clock started");
        assert.deepEqual(outcome.to, { year: 1, month: 0, day: 7 });
        assert.deepEqual(
            { year: game.date.year, month: game.date.month, day: game.date.day },
            outcome.to,
            "`to` is read off the game after the wait, not worked out from `seconds`"
        );
    });
});

test("waiting fires no game action at all", function () {
    withGame(nothing, function (game) {
        letItRun({ seconds: 3 });

        // Making time pass by nudging `gamesetspeed` or `pausetoggle` would leave the
        // model's own speed setting different from the one it chose, silently.
        assert.deepEqual(game.attempted, [], "waiting is a read; it changes nothing in the park");
    });
});

/* -------------------------------------------------------------------------------------
 * It answers.
 */

test("the wait answers exactly once", function () {
    withGame(nothing, function () {
        const outcomes: WaitOutcome[] = [];

        wait({ seconds: 4 }, function (result) { outcomes.push(result); });

        // The slice loop calls itself, so a missing `return` on either exit answers twice.
        // Over MCP the second answer is written to a socket the layer has already closed.
        assert.equal(outcomes.length, 1, "one call, one result");
    });
});

test("a wait that runs its full length answers rather than waiting on the watchdog", function () {
    withGame(nothing, function (game) {
        const outcome = callTool({ seconds: 20 });

        assert.equal(outcome.ok, true);
        assert.equal(outcome.seconds, 20, "the longest wait the schema allows still answers");
        assert.equal(game.watchdogs.length, 0, "the tool armed nothing that only a timeout can clear");
        assert.equal(game.date.ticksElapsed, 800);
    });
});

/* -------------------------------------------------------------------------------------
 * The bound.
 */

test("the cap is in the schema, which is what refuses the call before a second is spent", function () {
    const tool = waitTool();
    const properties = tool.inputSchema.properties as Record<string, {
        type: string;
        minimum: number;
        maximum: number;
        description: string;
    }>;

    assert.deepEqual(tool.inputSchema.required, ["seconds"],
        "a default length would be the tool deciding how long to wait, which is the model's call");
    assert.equal(properties.seconds.type, "integer");
    assert.equal(properties.seconds.minimum, 1);

    // src/mcp.ts answers a deferred call at 30 seconds with a timeout error and .mcp.json
    // gives the client 60. A cap above the shorter of those makes the tool fail at exactly
    // the lengths it was asked for, which is worse than not having it.
    assert.ok(properties.seconds.maximum <= 20,
        "the longest wait has to finish inside the bridge's 30 second answer window, with room"
            + " for the slices to land and the park to be read back");
    assert.equal(tool.inputSchema.additionalProperties, false);
});

test("a wait longer than the cap is refused, not quietly shortened", function () {
    withGame(nothing, function (game) {
        const outcome = letItRun({ seconds: 60 });

        // hire_staff used to clamp an out-of-range count and report the clamped number as
        // the one asked for. Clamping here would be the same lie with a bigger bill: the
        // caller is told it got the wait it asked for and the scenario clock disagrees.
        assert.equal(outcome.ok, false);
        assert.equal(outcome.seconds, 0);
        assert.equal(game.date.ticksElapsed, 0, "a refused wait must not have waited");
        assert.match(outcome.detail, /between 1 and 20/, "the legal range, by name");
        assert.match(outcome.detail, /60 is outside that range/, "and the value that arrived");
        assert.match(outcome.detail, /Nothing was waited/);
    });
});

test("a wait of zero, a fraction, or nothing at all is refused the same way", function () {
    withGame(nothing, function (game) {
        [{ seconds: 0 }, { seconds: 2.5 }, {}].forEach(function (request) {
            const outcome = letItRun(request);

            assert.equal(outcome.ok, false, JSON.stringify(request) + " has to be refused");
            assert.equal(outcome.seconds, 0);
        });

        assert.equal(game.date.ticksElapsed, 0, "none of the three moved the clock");
    });
});

/* -------------------------------------------------------------------------------------
 * Pause.
 */

test("a paused game is refused before a single second is spent", function () {
    withGame(function (game) {
        game.gameValues.paused = true;
    }, function (game) {
        const outcome = letItRun({ seconds: 20 });

        assert.equal(outcome.ok, false);
        assert.equal(outcome.seconds, 0);

        // The clock is the assertion that bites. A tool that waited the full twenty
        // seconds through a stopped clock and then reported that nothing had changed
        // would satisfy `ok: false` exactly, and would have burned the turn and the
        // wall-clock time to say it.
        assert.equal(game.date.ticksElapsed, 0, "no scenario time passes while paused, so none may be spent");
        assert.match(outcome.detail, /set_game_speed \{paused: false\}/,
            "a refusal carries the call that fixes it, as build_flat_ride's paused refusal does");
        assert.equal(outcome.paused, true);
    });
});

test("a pause that arrives mid-wait ends the wait instead of running out the clock", function () {
    withGame(nothing, function (game) {
        duringEachSecond(function (second) {
            if (second === 2) {
                game.gameValues.paused = true;
            }
        });

        const outcome = letItRun({ seconds: 6 });

        assert.equal(outcome.ok, true, "two seconds of scenario time did pass, and were read");
        assert.equal(outcome.seconds, 2, "`seconds` is what was waited, never what was asked");
        assert.equal(game.date.ticksElapsed, 80, "and the clock stopped where the wait stopped");
        assert.equal(outcome.paused, true);
        assert.match(outcome.detail, /paused after 2 seconds/);
        assert.match(outcome.detail, /remaining 4 seconds were not waited/);
    });
});

/* -------------------------------------------------------------------------------------
 * What it reports.
 */

test("the result is the change over the wait, which is what park_status cannot give", function () {
    withGame(function (game) {
        game.parkValues.guests = 40;
        game.parkValues.cash = 1000;
        game.parkValues.rating = 700;
    }, function (game) {
        duringEachSecond(function (second) {
            if (second === 1) {
                game.parkValues.guests = 52;
                game.parkValues.cash = 1180;
                game.parkValues.rating = 685;
            }
        });

        const outcome = letItRun({ seconds: 3 });

        // The before-reading has to be taken before the clock runs. Taking it afterwards
        // is a real bug shape - the tool reads the world back the way every other tool
        // does - and it reports every change as zero while every absolute field is right.
        assert.deepEqual(
            { guests: outcome.guests, cash: outcome.cash, rating: outcome.rating },
            { guests: 52, cash: 1180, rating: 685 },
            "where the park stands now"
        );
        assert.deepEqual(
            {
                guests: outcome.guestsChange,
                cash: outcome.cashChange,
                rating: outcome.ratingChange
            },
            { guests: 12, cash: 180, rating: -15 },
            "and what moved while the game ran, which is the whole reason to spend the turn"
        );
    });
});

test("only the messages that arrived during the wait come back", function () {
    withGame(function (game) {
        game.messages.push({ text: "{RED}Guests are lost" });
    }, function () {
        duringEachSecond(function (second) {
            if (second === 2) {
                (globalThis as unknown as { park: { messages: { text: string }[] } })
                    .park.messages.push({ text: "Merry-Go-Round has broken down" });
            }
        });

        const outcome = letItRun({ seconds: 3 });

        assert.deepEqual(outcome.newMessages, ["Merry-Go-Round has broken down"],
            "park_status already ships the last dozen every turn; the new ones are what this adds");
        assert.equal(outcome.newMessageCount, 1);
    });
});

test("a news queue that has rotated still reports what arrived", function () {
    withGame(function (game) {
        game.messages.push({ text: "one" }, { text: "two" }, { text: "three" });
    }, function (game) {
        duringEachSecond(function (second) {
            if (second === 2) {
                // OpenRCT2's news queue is bounded and drops from the front, so once it is
                // full an arrival leaves the length unchanged. A tool that counted new
                // messages by length difference reports none from here on - and that is
                // the half of a scenario where breakdowns and complaints actually happen.
                game.messages.shift();
                game.messages.push({ text: "four" });
            }
        });

        const outcome = letItRun({ seconds: 3 });

        assert.equal(game.messages.length, 3, "the queue is the same length it started at");
        assert.deepEqual(outcome.newMessages, ["four"]);
        assert.equal(outcome.newMessageCount, 1);
    });
});

test("the result carries the change and nothing else, so it does not re-buy park_status", function () {
    withGame(nothing, function () {
        const outcome = letItRun({ seconds: 2 });

        // Pinned whole. `park_status` averages 694 tokens and peaks at 1506 because it
        // carries the path network, the ground census and every ride; a wait that came
        // back with all of that would make letting the clock run the most expensive call
        // in the set, and the model waits repeatedly by design.
        assert.deepEqual(Object.keys(outcome).sort(), [
            "cash", "cashChange", "detail", "from", "gameDays", "guests", "guestsChange",
            "newMessageCount", "newMessages", "ok", "paused", "rating", "ratingChange",
            "seconds", "speed", "to"
        ]);
    });
});

/* -------------------------------------------------------------------------------------
 * Registration.
 */

test("wait is deferred, because a synchronous wait freezes the game outright", function () {
    withGame(nothing, function () {
        const result = new WaitTools().wait({ seconds: 1 }) as DeferredMcpResult;

        // Tools run inside the game's own update loop. A tool that blocked for its
        // duration would stop rendering, stop the simulation, and wait for a clock that
        // is not running - the one shape this tool must never have.
        assert.equal(result.deferred, true);
        assert.equal(typeof result.start, "function");
    });
});

test("the tool describes the real-seconds-to-game-time relationship it is built on", function () {
    // The argument is in real seconds and the objective is in game time, so the exchange
    // rate is the one fact the schema cannot carry and the model has no way to measure.
    const tool = waitTool();
    const text = String(tool.description);

    assert.match(text, /REAL seconds/, "which clock `seconds` is on");
    assert.match(text, /about seven real minutes at speed 1 and about fifty seconds at speed 4/,
        "what a game month costs at each end of the speed range");
    assert.match(text, /`set_game_speed` is what changes that rate/,
        "and the call that moves it, since this tool does not touch the speed");

    const registered = getMcpToolDefinitions(WaitTools);

    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, "wait");
    assert.equal(registered[0].annotations?.idempotentHint, false,
        "calling it again does not leave the world where the first call left it");
});
