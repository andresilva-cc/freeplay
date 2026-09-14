import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import { resetClockGate } from "../src/clockGate.ts";
import { getMcpToolDefinitions } from "../src/tools/decorators.ts";
import { getMcpTools } from "../src/tools/index.ts";
import { setGameSpeed } from "../src/tools/gameSpeed.ts";
import { WaitTools, wait } from "../src/tools/wait.ts";
import type { WaitOutcome, WaitRequest } from "../src/tools/wait.ts";
import type { DeferredMcpResult } from "../src/tools/types.ts";

/**
 * `wait` is the only thing that spends scenario time. The game is held still between tool
 * calls - src/clockGate.ts - so a turn the model spends thinking costs the park nothing, and
 * this is the call that hands the clock back on purpose.
 *
 * It used to take REAL seconds, which made the scenario time a call bought depend on the
 * speed setting and on the machine: measured over one scenario year, seven waits spent 62 of
 * 248 days and the other 186 went on inference latency. A host with twice the tokens per
 * second was playing a different game. The argument is game days now.
 *
 * Three things make these tests discriminating rather than decorative. The clock is asserted
 * against `game.date.ticksElapsed`, the fake's own counter, which nothing but time passing
 * moves - so a tool that returns a plausible outcome without ever handing control back to
 * the game fails here where an assertion on the returned object alone would pass. Every
 * refusal is asserted to have moved the clock ZERO ticks. And the tick counts are computed
 * by hand from the game's own arithmetic rather than read back out of the bridge's: at speed
 * s a 25ms slice is `1 << (s - 1)` ticks, `monthProgress` climbs 4 a tick, a month ends at
 * 65536 and March is 31 days, so one game day is 65536 / (4 * 31) = 528.5 ticks and the
 * first tick that reaches it is 529.
 */

/** Ticks to reach a fraction of a day in March, from the game's own monthProgress maths. */
function ticksForDays(days: number): number {
    return Math.ceil(days * 65536 / (4 * 31));
}

function withGame(
    build: (game: FakeGame) => void,
    run: (game: FakeGame) => void,
    options?: { inert?: boolean }
): void {
    const game = new FakeGame(8, 8, options);
    build(game);
    const restore = game.install();

    resetClockGate();

    try {
        run(game);
    } finally {
        resetClockGate();
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
 * Do something to the park between two slices of the wait.
 *
 * The fake runs a timer's callback inline once it has advanced the clock, so wrapping
 * `context.setTimeout` is the only place a test can stand while the game is running. The
 * wrapper goes away with the rest of `context` when the fake is uninstalled.
 */
function duringEachSlice(action: (slice: number) => void): void {
    const scope = globalThis as unknown as {
        context: { setTimeout(callback: () => void, delay?: number): number };
    };
    const original = scope.context.setTimeout;
    let slice = 0;

    scope.context.setTimeout = function (callback: () => void, delay?: number): number {
        return original.call(scope.context, function () {
            slice++;
            action(slice);
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
 * It advances GAME time, by the amount asked for.
 */

test("the clock advances the game days the call asked for, and stops there", function () {
    withGame(function (game) {
        game.gameValues.speed = 4;
    }, function (game) {
        const outcome = letItRun({ days: 1 });

        // 529 ticks is the first that reaches a whole day; speed 4 moves 8 a slice, so the
        // 67th slice is the one that crosses it and lands on 536. Asserted exactly, because
        // the failure this tool exists to prevent is a turn that appears to wait and does
        // not, and that shows up here as 0 while `outcome` still reads perfectly.
        assert.equal(game.date.ticksElapsed, 536, "the simulation has to have actually run");
        assert.equal(outcome.ok, true);
        assert.equal(outcome.days, 1, "and the days it reports are the days it was asked for");
        assert.equal(outcome.ticks, 536, "with the game's own ticks beside them");
        assert.equal(outcome.complete, true);
    });
});

test("the same request buys the same game time at every speed, which is the whole point", function () {
    let slow: WaitOutcome | null = null;
    let fast: WaitOutcome | null = null;
    let slowTicks = -1;
    let fastTicks = -1;

    withGame(nothing, function (game) {
        slow = letItRun({ days: 0.2 });
        slowTicks = game.date.ticksElapsed;
    });

    withGame(function (game) {
        game.gameValues.speed = 4;
    }, function (game) {
        fast = letItRun({ days: 0.2 });
        fastTicks = game.date.ticksElapsed;
    });

    const slowResult = slow as unknown as WaitOutcome;
    const fastResult = fast as unknown as WaitOutcome;

    // The old tool took real seconds, so the same call at speed 4 advanced the scenario
    // eight times as far. That is the defect: a run's scenario cost depended on a setting
    // and on the host. Both of these have to land on the same day.
    assert.equal(slowResult.days, 0.2);
    assert.equal(fastResult.days, 0.2, "the same game time, whatever the game is running at");
    assert.equal(slowTicks, ticksForDays(0.2), "106 ticks, one per 25ms slice at speed 1");
    assert.equal(fastTicks, 112, "speed 4 moves 8 a slice and overshoots by at most one slice");

    // What the speed does change is the bill in real time, which is the half that is
    // allowed to differ between machines because nothing is denominated in it.
    assert.equal(slowResult.seconds, 2.7);
    assert.equal(fastResult.seconds, 0.4, "eight times faster in real terms, same scenario");
});

test("the date the wait reports is the date the game is on", function () {
    withGame(function (game) {
        game.gameValues.speed = 4;
    }, function (game) {
        const outcome = letItRun({ days: 6 });

        assert.deepEqual(outcome.from, { year: 1, month: 0, day: 1 }, "where the clock started");
        assert.deepEqual(outcome.to, { year: 1, month: 0, day: 7 });
        assert.deepEqual(
            { year: game.date.year, month: game.date.month, day: game.date.day },
            outcome.to,
            "`to` is read off the game after the wait, not worked out from `days`"
        );
    });
});

test("waiting fires no game action at all", function () {
    withGame(nothing, function (game) {
        letItRun({ days: 0.1 });

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

        wait({ days: 0.1 }, function (result) { outcomes.push(result); });

        // The slice loop calls itself, so a missing `return` on either exit answers twice.
        // Over MCP the second answer is written to a socket the layer has already closed.
        assert.equal(outcomes.length, 1, "one call, one result");
    });
});

test("a request the speed cannot reach comes back with what it got, not a timeout", function () {
    withGame(nothing, function (game) {
        const outcome = callTool({ days: 12 });

        // Twelve days at speed 1 is about 158 real seconds and the call has twenty, so this
        // is the case that has to answer honestly rather than run into the bridge's 30
        // second watchdog and be reported as a tool that broke.
        assert.equal(outcome.ok, true, "the time it did get was got");
        assert.equal(outcome.complete, false, "and the rest of the request plainly was not");
        assert.equal(outcome.daysRequested, 12);
        assert.equal(outcome.days, 1.5, "twenty real seconds at speed 1 is a day and a half");
        assert.equal(game.date.ticksElapsed, 800, "800 slices of one tick, and no more");
        assert.equal(game.watchdogs.length, 0, "the tool armed nothing that only a timeout can clear");
        assert.match(outcome.detail, /remaining 10\.5 days/, "how much is left, in the unit asked for");
        assert.match(outcome.detail, /raise the speed with set_game_speed/, "and the call that helps");
    });
});

/* -------------------------------------------------------------------------------------
 * The bound.
 */

test("the schema carries the unit and the cap, which is what refuses a call before it runs", function () {
    const tool = waitTool();
    const properties = tool.inputSchema.properties as Record<string, {
        type: string;
        minimum: number;
        maximum: number;
        description: string;
    }>;

    assert.deepEqual(tool.inputSchema.required, ["days"],
        "a default length would be the tool deciding how long to wait, which is the model's call");
    assert.equal(typeof properties.seconds, "undefined",
        "real seconds are the cost of a wait, never its measure, so nothing asks for them");
    assert.equal(properties.days.type, "number",
        "part of a day is a real request: at speed 1 a whole one costs thirteen real seconds");
    assert.equal(properties.days.minimum, 0.1);
    assert.equal(properties.days.maximum, 12,
        "twelve game days is what twenty real seconds buy at speed 4, and no speed buys more");
    assert.equal(tool.inputSchema.additionalProperties, false);
});

test("a wait outside the range is refused, not quietly shortened", function () {
    withGame(nothing, function (game) {
        const outcome = letItRun({ days: 60 });

        // hire_staff used to clamp an out-of-range count and report the clamped number as
        // the one asked for. Clamping here would be the same lie with a bigger bill: the
        // caller is told it got the wait it asked for and the scenario clock disagrees.
        assert.equal(outcome.ok, false);
        assert.equal(outcome.days, 0);
        assert.equal(game.date.ticksElapsed, 0, "a refused wait must not have waited");
        assert.match(outcome.detail, /between 0\.1 and 12/, "the legal range, by name");
        assert.match(outcome.detail, /60 is outside that range/, "and the value that arrived");
        assert.match(outcome.detail, /Nothing was waited/);
    });
});

test("zero, a sliver below the floor, and nothing at all are refused the same way", function () {
    withGame(nothing, function (game) {
        [{ days: 0 }, { days: 0.04 }, {}].forEach(function (request) {
            const outcome = letItRun(request);

            assert.equal(outcome.ok, false, JSON.stringify(request) + " has to be refused");
            assert.equal(outcome.days, 0);
        });

        assert.equal(game.date.ticksElapsed, 0, "none of the three moved the clock");
    });
});

/* -------------------------------------------------------------------------------------
 * Pause.
 */

test("a game the model paused is refused before a single tick is spent", function () {
    withGame(nothing, function (game) {
        setGameSpeed({ paused: true }, function () { /* the model's own pause */ });
        assert.equal(game.gameValues.paused, true, "the fixture has to actually be paused");

        const ticksAfterPausing = game.date.ticksElapsed;
        const outcome = letItRun({ days: 12 });

        assert.equal(outcome.ok, false);
        assert.equal(outcome.days, 0);

        // The clock is the assertion that bites. A tool that waited the full twenty
        // seconds through a stopped clock and then reported that nothing had changed
        // would satisfy `ok: false` exactly, and would have burned the turn and the
        // wall-clock time to say it.
        assert.equal(game.date.ticksElapsed, ticksAfterPausing,
            "no scenario time passes while paused, so none may be spent");
        assert.match(outcome.detail, /set_game_speed \{paused: false\}/,
            "a refusal carries the call that fixes it, as build_flat_ride's paused refusal does");
        assert.match(outcome.detail, /paused because set_game_speed paused it/,
            "and names the pause it is: the bridge holds the clock still between every call, so"
                + " \"the game is paused\" on its own tells the model nothing it can undo");
    });
});

test("a pause that arrives mid-wait ends the wait instead of running out the clock", function () {
    withGame(nothing, function (game) {
        duringEachSlice(function (slice) {
            if (slice === 40) {
                game.gameValues.paused = true;
            }
        });

        const outcome = letItRun({ days: 1 });

        assert.equal(outcome.ok, true, "forty ticks of scenario time did pass, and were read");
        assert.equal(outcome.complete, false, "`complete` is what was got, never what was asked");
        assert.equal(outcome.ticks, 40, "and the clock stopped where the wait stopped");
        assert.equal(game.date.ticksElapsed, 40);
        assert.match(outcome.detail, /remaining 0\.9 days/);
    });
});

/* -------------------------------------------------------------------------------------
 * What it reports.
 */

test("the result is the change over the wait, which is what park_status cannot give", function () {
    withGame(function (game) {
        game.gameValues.speed = 4;
        game.parkValues.guests = 40;
        game.parkValues.cash = 1000;
        game.parkValues.rating = 700;
    }, function (game) {
        duringEachSlice(function (slice) {
            if (slice === 1) {
                game.parkValues.guests = 52;
                game.parkValues.cash = 1180;
                game.parkValues.rating = 685;
            }
        });

        const outcome = letItRun({ days: 0.5 });

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
        game.gameValues.speed = 4;
        game.addMessage("{RED}Guests are lost");
    }, function () {
        duringEachSlice(function (slice) {
            if (slice === 2) {
                (globalThis as unknown as { park: { messages: { text: string; month: number; day: number }[] } })
                    .park.messages.push({ text: "Merry-Go-Round has broken down", month: 0, day: 1 });
            }
        });

        const outcome = letItRun({ days: 0.5 });

        assert.deepEqual(outcome.newMessages, ["Merry-Go-Round has broken down"],
            "park_status already ships the last dozen every turn; the new ones are what this adds");
        assert.equal(outcome.newMessageCount, 1);
    });
});

test("a news queue that has rotated still reports what arrived", function () {
    withGame(function (game) {
        game.gameValues.speed = 4;
        game.addMessage("one");
        game.addMessage("two");
        game.addMessage("three");
    }, function (game) {
        duringEachSlice(function (slice) {
            if (slice === 2) {
                // OpenRCT2's news queue is bounded and drops from the front, so once it is
                // full an arrival leaves the length unchanged. A tool that counted new
                // messages by length difference reports none from here on - and that is
                // the half of a scenario where breakdowns and complaints actually happen.
                game.messages.shift();
                game.addMessage("four");
            }
        });

        const outcome = letItRun({ days: 0.5 });

        assert.equal(game.messages.length, 3, "the queue is the same length it started at");
        assert.deepEqual(outcome.newMessages, ["four"]);
        assert.equal(outcome.newMessageCount, 1);
    });
});

test("the result carries the change and nothing else, so it does not re-buy park_status", function () {
    withGame(nothing, function () {
        const outcome = letItRun({ days: 0.1 });

        // Pinned whole. `park_status` averages 694 tokens and peaks at 1506 because it
        // carries the path network, the ground census and every ride; a wait that came
        // back with all of that would make letting the clock run the most expensive call
        // in the set, and the model waits repeatedly by design.
        assert.deepEqual(Object.keys(outcome).sort(), [
            "cash", "cashChange", "complete", "days", "daysRequested", "detail", "from",
            "guests", "guestsChange", "newMessageCount", "newMessages", "ok", "rating",
            "ratingChange", "seconds", "speed", "ticks", "to"
        ]);
    });
});

/* -------------------------------------------------------------------------------------
 * Registration.
 */

test("wait is deferred, because a synchronous wait freezes the game outright", function () {
    withGame(nothing, function () {
        const result = new WaitTools().wait({ days: 0.1 }) as DeferredMcpResult;

        // Tools run inside the game's own update loop. A tool that blocked for its
        // duration would stop rendering, stop the simulation, and wait for a clock that
        // is not running - the one shape this tool must never have.
        assert.equal(result.deferred, true);
        assert.equal(typeof result.start, "function");
    });
});

test("the tool says that the game is otherwise held still, and what a day costs in real time", function () {
    // Two facts the model cannot measure and the schema cannot carry: that no other call
    // spends scenario time, and the exchange rate between a game day and the wall clock,
    // which is what decides how much one call can reach.
    const tool = waitTool();
    const text = String(tool.description);
    const argument = String((tool.inputSchema.properties as Record<string, { description: string }>)
        .days.description);

    assert.match(text, /GAME days/, "which clock `days` is on");
    assert.match(text, /held still between your calls/,
        "the fact that changes how the model plays: thinking is free now, and it was not");
    assert.doesNotMatch(text, /REAL seconds without/,
        "the old unit cannot survive anywhere in the text that is read on every turn");
    assert.match(argument, /13 real seconds at speed 1/, "what a game day costs at the slow end");
    assert.match(argument, /1\.7 at speed 4/, "and at the fast end");

    const registered = getMcpToolDefinitions(WaitTools);

    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, "wait");
});
