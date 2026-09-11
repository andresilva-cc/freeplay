import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import type { FakeRide } from "./fakeGame.ts";
import { operateRide } from "../src/park/operate.ts";
import type { OperateRideOutcome, OperateRideRequest } from "../src/park/operate.ts";
import { OperateTools } from "../src/tools/operate.ts";
import { BuildTools } from "../src/tools/build.ts";
import { getMcpToolDefinitions } from "../src/tools/decorators.ts";
import type { DeferredMcpResult } from "../src/tools/types.ts";

/**
 * operate_ride is the tool best placed to lie. Every one of its jobs is a single action
 * the game refuses a tick later, so "I opened it" is cheap to say and expensive to get
 * wrong: the model moves on to laying a queue for a ride that is still shut. Each test
 * here checks the park as well as the sentence.
 */

interface FakeContext {
    executeAction: (name: string, args: Record<string, unknown>, callback?: (result: Record<string, unknown>) => void) => void;
    setTimeout: (callback: () => void, delay?: number) => number;
}

/** A ride carrying the inspection interval the real `Ride` object has and FakeRide does not. */
type InspectableRide = FakeRide & { inspectionInterval: number };

/**
 * `ridesetsetting` is not one of the actions test/fakeGame.ts models, and that file is
 * being changed elsewhere. Handle just that one action here, with the fake's own timing:
 * accepted now, applied when the caller waits for the next tick. Applying it immediately
 * would hide the very gap these tests exist to check.
 */
function addInspectionIntervals(game: FakeGame): void {
    const gameContext = (globalThis as unknown as { context: FakeContext }).context;
    const send = gameContext.executeAction;
    const wait = gameContext.setTimeout;
    const queued: { args: Record<string, unknown>; callback?: (result: Record<string, unknown>) => void }[] = [];

    gameContext.executeAction = function (name, args, callback) {
        if (name !== "ridesetsetting") {
            return send.call(gameContext, name, args, callback);
        }

        game.attempted.push({ name: name, args: args, callback: callback });

        if (!game.inert) {
            queued.push({ args: args, callback: callback });
        }
    };

    gameContext.setTimeout = function (callback, delay) {
        if (typeof delay !== "number" || delay <= FakeGame.WATCHDOG_THRESHOLD_MS) {
            while (queued.length > 0) {
                const action = queued.shift() as { args: Record<string, unknown>; callback?: (result: Record<string, unknown>) => void };

                if (game.refuse.ridesetsetting) {
                    if (action.callback) {
                        action.callback({ error: 1, errorTitle: "Refused", errorMessage: "test refusal" });
                    }
                    continue;
                }

                const target = game.rides.filter(function (ride) {
                    return ride.id === action.args.ride;
                })[0] as InspectableRide | undefined;

                // 5 is RideSetSetting::InspectionInterval. Any other index is a different
                // setting and must not quietly land on this one.
                if (target && action.args.setting === 5) {
                    target.inspectionInterval = action.args.value as number;
                }

                if (action.callback) {
                    action.callback({ error: 0 });
                }
            }
        }

        return wait.call(gameContext, callback, delay);
    };
}

function park(options?: { inert?: boolean }): { game: FakeGame; restore: () => void } {
    const game = new FakeGame(24, 24, options);
    game.rideObjects = [{ index: 0, name: "Merry-Go-Round", rideType: [33] }];
    const restore = game.install();
    addInspectionIntervals(game);

    return { game: game, restore: restore };
}

/** A merry-go-round the park already has. `built: false` leaves it half-finished. */
function addRide(game: FakeGame, options?: {
    built?: boolean; status?: string; price?: number; inspectionInterval?: number;
}): FakeRide {
    const built = !options || options.built !== false;
    const ride: FakeRide = {
        id: game.rides.length,
        name: "Carousel",
        type: 33,
        status: options && typeof options.status === "string" ? options.status : "closed",
        price: [options && typeof options.price === "number" ? options.price : 0],
        stations: [{
            start: built ? { x: 320, y: 320, z: 96 } : null,
            entrance: built ? { x: 288, y: 320, z: 96, direction: 0 } : null,
            exit: built ? { x: 352, y: 320, z: 96, direction: 2 } : null,
            length: 3,
            queueTime: 0
        }],
        excitement: 500,
        intensity: 300,
        totalCustomers: 0,
        totalProfit: 0,
        downtime: 0,
        reliability: 100,
        flags: 0,
        value: 40
    };

    (ride as InspectableRide).inspectionInterval = options
        && typeof options.inspectionInterval === "number" ? options.inspectionInterval : 6;

    game.rides.push(ride);
    return ride;
}

function interval(ride: FakeRide): number {
    return (ride as InspectableRide).inspectionInterval;
}

function operate(request: OperateRideRequest): OperateRideOutcome {
    let outcome: OperateRideOutcome | null = null;

    operateRide(request, function (result) { outcome = result; });

    assert.ok(outcome, "operateRide never finished");
    return outcome as unknown as OperateRideOutcome;
}

/** The tool as the MCP layer reaches it: arguments in, one result out. */
function callTool(args: Record<string, unknown>): OperateRideOutcome {
    const result = new OperateTools().operateRide(args);

    if ((result as DeferredMcpResult).deferred !== true) {
        return result as OperateRideOutcome;
    }

    let outcome: OperateRideOutcome | null = null;
    (result as DeferredMcpResult).start(function (value) { outcome = value as OperateRideOutcome; });

    assert.ok(outcome, "the deferred tool never resolved");
    return outcome as unknown as OperateRideOutcome;
}

/** The definition with each property schema readable as a plain record of its keywords. */
interface ReadableToolDefinition {
    description?: string;
    inputSchema: { properties?: Record<string, Record<string, unknown>> };
}

function toolDefinition(): ReadableToolDefinition {
    const definitions = getMcpToolDefinitions(OperateTools).filter(function (definition) {
        return definition.name === "operate_ride";
    });

    assert.equal(definitions.length, 1, "operate_ride is registered once");
    return definitions[0] as unknown as ReadableToolDefinition;
}

test("opening a finished ride reports the status the ride actually has", function () {
    const { game, restore } = park();
    addRide(game);

    try {
        const outcome = operate({ ride: 0, open: true });

        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(outcome.status, "open", "the reported status is read back from the ride");
        assert.equal(game.rides[0].status, "open", "and the ride in the park really is open");
        assert.match(outcome.detail, /Carousel is open/);
    } finally {
        restore();
    }
});

test("closing an open ride shuts it, rather than sending the same status either way", function () {
    const { game, restore } = park();
    addRide(game, { status: "open" });

    try {
        const outcome = operate({ ride: 0, open: false });

        assert.equal(game.rides[0].status, "closed", "the park is what is being asserted: the ride really did shut");
        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(outcome.status, "closed");

        // A tool that hard-codes status 1 opens the ride on `open: false` and then reports
        // "open" quite truthfully, so the status sent has to be pinned as well.
        const sent = game.attempted.filter(function (action) { return action.name === "ridesetstatus"; });
        assert.equal(sent.length, 1);
        assert.equal(sent[0].args.status, 0, "closing sends status 0, not the open status");
    } finally {
        restore();
    }
});

test("a new price is read back from the ride, not echoed from the request", function () {
    const { game, restore } = park();
    addRide(game, { price: 5 });

    try {
        const accepted = operate({ ride: 0, price: 25 });

        assert.equal(accepted.ok, true, accepted.detail);
        assert.equal(accepted.price, 25);
        assert.equal(game.rides[0].price[0], 25, "and the ride is charging it");

        // Now the game refuses, and the tool must not repeat the number it asked for.
        game.refuse.ridesetprice = true;
        const refused = operate({ ride: 0, price: 40 });

        assert.equal(refused.ok, false, "a price that did not change is not a success");
        assert.equal(refused.price, 25, "the reported price is what the ride charges now");
        assert.match(refused.detail, /asked for price 40 but it is charging 25/);
    } finally {
        restore();
    }
});

test("a price that did not take names no cause the tool never checked", function () {
    // "the scenario may fix ride prices" used to be appended to every refused price, with no
    // flag read. `RideSetPriceAction` consults no park flag at all, so a scenario was never
    // the cause; the clause was a guess the model would have acted on.
    const { game, restore } = park();
    addRide(game, { price: 5 });
    game.refuse.ridesetprice = true;

    try {
        const outcome = operate({ ride: 0, price: 40 });

        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /asked for price 40 but it is charging 5\.$/,
            "the sentence ends at what was asked for and what was read back");
        assert.doesNotMatch(outcome.detail, /scenario/, "no cause is named that was never checked");
        assert.doesNotMatch(outcome.detail, /fix ride prices/);
    } finally {
        restore();
    }
});

test("a price is in tenths, and the number sent is the number the ride ends up charging", function () {
    const { game, restore } = park();
    addRide(game, { price: 0 });

    try {
        // 1000 tenths is 100.00. A tool that quietly scaled it would land on 10000 or 100.
        const outcome = operate({ ride: 0, price: 1000 });

        assert.equal(game.rides[0].price[0], 1000, "the ride charges 1000 tenths, not 100 and not 10000");
        assert.equal(outcome.price, 1000);

        const sent = game.attempted.filter(function (action) { return action.name === "ridesetprice"; });
        assert.equal(sent[0].args.price, 1000, "and that is the number handed to the game");
        assert.equal(sent[0].args.isPrimaryPrice, true);
    } finally {
        restore();
    }
});

test("the tool says prices are tenths, in both the description and the argument", function () {
    const definition = toolDefinition();
    const properties = definition.inputSchema.properties || {};

    assert.match(String(definition.description), /tenths/,
        "a model that does not know the unit charges a hundred times too little");
    assert.match(String(definition.description), /1000 means 100\.00/);
    assert.match(String(properties.price.description), /tenths/);
});

test("a ride that is not finished is reported still closed, with the reason", function () {
    const { game, restore } = park();
    addRide(game, { built: false });

    try {
        const outcome = operate({ ride: 0, open: true });

        assert.equal(outcome.ok, false, "the game refused to open it, so this is not a success");
        assert.equal(outcome.status, "closed", "and it says so rather than claiming it is open");
        assert.match(outcome.detail, /closed rather than open/);
        assert.match(outcome.detail, /nothing has been built/, "and names the actual reason: no track on the ground");
        assert.doesNotMatch(outcome.detail, /entrance or exit/, "not a different reason that happens to sound plausible");
        assert.equal(game.rides[0].status, "closed");
    } finally {
        restore();
    }
});

test("when nothing is applied, every request says nothing changed", function () {
    // The expensive bug class: actions accepted, never taking effect, reported as done.
    const { game, restore } = park({ inert: true });
    addRide(game, { price: 5 });

    try {
        const both = operate({ ride: 0, open: true, price: 25 });

        assert.equal(both.ok, false, "nothing happened, so nothing succeeded");
        assert.equal(both.status, "closed");
        assert.equal(both.price, 5);
        assert.match(both.detail, /asked for price 25/);
        assert.match(both.detail, /closed rather than open/);
        assert.equal(game.attempted.length, 2, "both actions were sent; only the read-back reveals they did nothing");

        const removal = operate({ ride: 0, demolish: true });

        assert.equal(removal.ok, false, "a ride that is still standing was not demolished");
        assert.match(removal.detail, /Could not demolish Carousel/);
        assert.equal(game.rides.length, 1, "and it is still there");
    } finally {
        restore();
    }
});

test("an inspection interval that never took effect is not reported as set", function () {
    const { game, restore } = park({ inert: true });
    addRide(game, { inspectionInterval: 6 });

    try {
        const outcome = operate({ ride: 0, inspectionInterval: 2 });

        assert.equal(interval(game.rides[0]), 6, "the park never changed");
        assert.equal(outcome.ok, false, "so the call did not succeed");
        assert.equal(outcome.inspectionInterval, 6, "the interval reported is the one the ride has");
        assert.match(outcome.detail, /asked for inspection interval 2 \(every 30 minutes\)/);
        assert.match(outcome.detail, /set to 6 \(never\)/);
    } finally {
        restore();
    }
});

test("an unknown ride id is named back, not guessed at", function () {
    const { game, restore } = park();

    try {
        const outcome = operate({ ride: 7, open: true });

        assert.equal(outcome.ok, false);
        assert.equal(outcome.ride, 7);
        assert.match(outcome.detail, /no ride with id 7/);
        assert.equal(game.attempted.length, 0, "nothing is sent to the game for a ride that does not exist");
    } finally {
        restore();
    }
});

test("demolishing removes the ride and checks it is gone", function () {
    const { game, restore } = park();
    addRide(game);
    addRide(game);

    try {
        const outcome = operate({ ride: 0, demolish: true });

        assert.equal(outcome.ok, true, outcome.detail);
        assert.match(outcome.detail, /Demolished Carousel/);
        assert.equal(game.rides.length, 1, "one ride was removed");
        assert.equal(game.rides[0].id, 1, "and it was the one that was asked for");
    } finally {
        restore();
    }
});

test("a demolition the game refuses is reported as a failure that names it", function () {
    // The game refuses this for real reasons - guests still on the ride, a scenario that
    // protects it - and answers the action itself. Assuming the ride is gone sends the
    // model off to rebuild on ground that is still occupied.
    const { game, restore } = park();
    addRide(game);
    game.refuse.ridedemolish = true;

    try {
        const outcome = operate({ ride: 0, demolish: true });

        assert.equal(game.rides.length, 1, "the ride is still standing");
        assert.equal(outcome.ok, false, "so the demolition did not succeed");
        assert.match(outcome.detail, /Could not demolish Carousel/, "and the failure names the demolition");
        assert.doesNotMatch(outcome.detail, /^Demolished/);
    } finally {
        restore();
    }
});

test("a refused price is named while the status that took effect is not", function () {
    const { game, restore } = park();
    addRide(game, { price: 5 });
    game.refuse.ridesetprice = true;

    try {
        const outcome = operate({ ride: 0, open: true, price: 25 });

        assert.equal(outcome.ok, false, "half of the request failed, so the call failed");
        assert.equal(outcome.status, "open", "the half that worked is still reported as done");
        assert.equal(outcome.price, 5);
        assert.match(outcome.detail, /asked for price 25/);
        assert.doesNotMatch(outcome.detail, /rather than open/, "the ride did open; saying otherwise sends the model to fix it");
        assert.equal(game.rides[0].status, "open");
    } finally {
        restore();
    }
});

test("a refused status is named while the price that took effect is not", function () {
    const { game, restore } = park();
    addRide(game, { price: 5 });
    game.refuse.ridesetstatus = true;

    try {
        const outcome = operate({ ride: 0, open: true, price: 25 });

        assert.equal(outcome.ok, false);
        assert.equal(outcome.price, 25, "the price change went through and is reported");
        assert.equal(outcome.status, "closed");
        assert.match(outcome.detail, /closed rather than open/);
        assert.doesNotMatch(outcome.detail, /asked for price/, "the price is right; complaining about it would be untrue");
        assert.equal(game.rides[0].price[0], 25);
    } finally {
        restore();
    }
});

test("an inspection interval is set on the ride and read back from it", function () {
    const { game, restore } = park();
    addRide(game, { inspectionInterval: 6 });

    try {
        const outcome = operate({ ride: 0, inspectionInterval: 2 });

        assert.equal(interval(game.rides[0]), 2, "the ride in the park is on the 30 minute interval");
        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(outcome.inspectionInterval, 2);
        assert.match(outcome.detail, /inspected every 30 minutes/);

        const sent = game.attempted.filter(function (action) { return action.name === "ridesetsetting"; });
        assert.equal(sent[0].args.setting, 5, "setting 5 is the inspection interval; another index changes another setting");
        assert.equal(sent[0].args.value, 2, "and the value is the index, not a number of minutes");
    } finally {
        restore();
    }
});

test("a refused inspection interval is not reported as set", function () {
    const { game, restore } = park();
    addRide(game, { inspectionInterval: 6 });
    game.refuse.ridesetsetting = true;

    try {
        const outcome = operate({ ride: 0, price: 25, inspectionInterval: 2 });

        assert.equal(interval(game.rides[0]), 6, "the interval never changed");
        assert.equal(outcome.ok, false, "so the call failed even though the price landed");
        assert.equal(outcome.price, 25, "and the half that worked is still reported");
        assert.match(outcome.detail, /asked for inspection interval 2/);
        assert.doesNotMatch(outcome.detail, /asked for price/);
    } finally {
        restore();
    }
});

test("a built ride with no doors is told that, not something else", function () {
    const { game, restore } = park();
    // Built on the ground, but no entrance or exit yet.
    game.rides.push({
        id: 0, name: "Merry-Go-Round 1", type: 33, status: "closed", price: [10],
        stations: [{ start: { x: 448, y: 320, z: 96 }, entrance: null, exit: null, length: 0, queueTime: 0 }],
        excitement: -1, intensity: -1, totalCustomers: 0, totalProfit: 0,
        downtime: 0, reliability: 100, flags: 0, value: 40
    });

    try {
        const outcome = operate({ ride: 0, open: true });

        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /no entrance or exit/, "the reason is the missing doors");
        assert.doesNotMatch(outcome.detail, /nothing has been built/, "it has been built");
    } finally {
        restore();
    }
});

test("a refusal with no obvious cause offers no invented one", function () {
    const { game, restore } = park();
    addRide(game);
    game.refuse.ridesetstatus = true;

    try {
        const outcome = operate({ ride: 0, open: true });

        assert.equal(outcome.ok, false);
        assert.doesNotMatch(outcome.detail, /entrance/, "the ride has both; do not guess");
        assert.doesNotMatch(outcome.detail, /nothing has been built/, "it is built; do not guess");
    } finally {
        restore();
    }
});

test("an inspection interval of 30 is refused by name, with the range and what it means", function () {
    // A real run passed 30 meaning thirty minutes. The game answered "Value out of range",
    // which names no field, and several turns went on guessing which argument it meant.
    const { game, restore } = park();
    addRide(game);

    try {
        const outcome = callTool({ ride: 0, inspectionInterval: 30 });

        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /`inspectionInterval`/, "the offending field is named");
        assert.match(outcome.detail, /between 0 and 6/, "with its legal range");
        assert.match(outcome.detail, /not a number of minutes/, "and why 30 looked reasonable");
        assert.match(outcome.detail, /2 every 30/, "and the value that means what was wanted");
        assert.equal(game.attempted.length, 0, "nothing reaches the game, so nothing has to be undone");
    } finally {
        restore();
    }
});

test("a price outside the accepted range is refused by name before any action is sent", function () {
    const { game, restore } = park();
    addRide(game, { price: 25 });

    try {
        const tooHigh = callTool({ ride: 0, price: 500000 });

        assert.equal(tooHigh.ok, false);
        assert.match(tooHigh.detail, /`price`/);
        assert.match(tooHigh.detail, /between 0 and 2000/);
        assert.match(tooHigh.detail, /tenths/);

        const negative = callTool({ ride: 0, price: -5 });

        assert.equal(negative.ok, false);
        assert.match(negative.detail, /`price`/);

        assert.equal(game.attempted.length, 0, "neither call touched the game");
        assert.equal(game.rides[0].price[0], 25, "and the ride still charges what it charged");
    } finally {
        restore();
    }
});

test("a ride id below zero is refused by name rather than sent as -1", function () {
    const { game, restore } = park();
    addRide(game);

    try {
        const outcome = callTool({ open: true });

        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /`ride`/);
        assert.match(outcome.detail, /park_status/, "and says where a real id comes from");
        assert.equal(game.attempted.length, 0);
    } finally {
        restore();
    }
});

test("demolish combined with price or open is refused, not silently obeyed in part", function () {
    // The old shape took the demolish branch and dropped the other two arguments on the
    // floor, so a call asking for a price got a destroyed ride and no word about it.
    const { game, restore } = park();
    addRide(game, { price: 25 });

    try {
        const withPrice = callTool({ ride: 0, price: 40, demolish: true });

        assert.equal(withPrice.ok, false);
        assert.match(withPrice.detail, /`demolish` cannot be combined with `price` or `open`/);
        assert.equal(game.rides.length, 1, "the ride is untouched, which is the point: demolition is final");

        const withOpen = callTool({ ride: 0, open: true, demolish: true });

        assert.equal(withOpen.ok, false);
        assert.match(withOpen.detail, /`demolish` cannot be combined/);
        assert.equal(game.rides.length, 1);
        assert.equal(game.attempted.length, 0, "no action was sent for either call");
    } finally {
        restore();
    }
});

test("a demolition on its own still goes through the tool", function () {
    const { game, restore } = park();
    addRide(game);

    try {
        const outcome = callTool({ ride: 0, demolish: true });

        assert.equal(game.rides.length, 0, "the ride is gone");
        assert.equal(outcome.ok, true, outcome.detail);
    } finally {
        restore();
    }
});

test("the ranges the tool enforces are in the schema, so the model can read them", function () {
    // src/mcp.ts enforces enum, minimum and maximum centrally, so these are both the
    // enforcement and what the model sees before it guesses.
    const properties = toolDefinition().inputSchema.properties || {};

    assert.equal(properties.price.minimum, 0);
    assert.equal(properties.price.maximum, 2000);
    assert.equal(properties.ride.minimum, 0);
    assert.equal(properties.inspectionInterval.minimum, 0);
    assert.equal(properties.inspectionInterval.maximum, 6);
    assert.deepEqual(properties.inspectionInterval.enum, [0, 1, 2, 3, 4, 5, 6]);
});

test("the schema itself explains the traps, because the refusals below it may never run", function () {
    // Central schema validation refuses a bad number before the tool is invoked, so the
    // hand-written refusal for `inspectionInterval: 30` is unreachable over MCP. Anything
    // the model has to know to avoid the mistake has to be in the description it reads
    // every turn, not in a sentence it only sees after paying for the mistake.
    const properties = toolDefinition().inputSchema.properties || {};
    const interval = String(properties.inspectionInterval.description);

    assert.match(interval, /not a number of minutes/, "the trap named in the property itself");
    assert.match(interval, /0 is every 10 minutes/, "with the whole mapping");
    assert.match(interval, /6 never/);
    assert.match(interval, /thirty minutes is 2, not 30/, "and the correction for the mistake a run actually made");

    assert.match(String(properties.price.description), /tenths/, "the money unit, likewise");
    assert.match(String(properties.price.description), /1000 means 100\.00/);
});

test("the description reports facts and never advises what to charge or when to open", function () {
    // docs/tool-design.md: the tool owns the actions and the read-back. Whether a ride
    // should be open, and what it should cost, is the game the model is here to play.
    // How the simulation answers a price is a different thing, and it stays - see below.
    const definition = toolDefinition();
    const properties = definition.inputSchema.properties || {};
    const text = String(definition.description) + " "
        + Object.keys(properties).map(function (key) { return String(properties[key].description); }).join(" ");

    assert.doesNotMatch(text, /\bshould\b/i);
    assert.doesNotMatch(text, /\b(recommend|advis|best|worth it|profitable)/i);
    assert.match(definition.description as string, /what the ride is actually doing afterwards/,
        "what it does say is what it read back");
});

test("repricing teaches the same value mechanic building does, in the same words", function () {
    // Guests weighing price against value is a rule of OpenRCT2's simulation, not an
    // opinion: the model cannot read it anywhere else, so removing it hid a rule rather
    // than a recommendation. It was live in build_flat_ride and missing here, so the model
    // learnt it when building a ride and not when repricing one - which is exactly the
    // repair five runs failed to make. The two now say it identically; drifting apart is
    // the failure this pins.
    const MECHANIC = "Charge above what guests think the ride is worth and they walk past;"
        + " park_status reports each ride's `value`.";

    const price = String((toolDefinition().inputSchema.properties || {}).price.description);
    const buildPrice = String(((getMcpToolDefinitions(BuildTools).filter(function (definition) {
        return definition.handlerName === "buildFlatRide";
    })[0].inputSchema.properties || {}).price as { description?: string }).description);

    assert.ok(price.indexOf(MECHANIC) >= 0, "operate_ride's price states the mechanic: " + price);
    assert.ok(buildPrice.indexOf(MECHANIC) >= 0, "and build_flat_ride still does: " + buildPrice);

    // The fact and the field that measures it, and nothing about what to charge.
    assert.doesNotMatch(price, /\b(should|recommend|advis|too (high|low)|aim for)\b/i);
});

/**
 * The demolition, which is where build_flat_ride's own failures send the model.
 *
 * `ridedemolish` carries no `Flags::AllowWhilePaused`, so OpenRCT2's
 * `GameActionRunner.cpp::CheckActionInPausedMode` turns it down and answers "Construction
 * not possible while game is paused!". The tool discarded the action's result entirely and
 * said "Could not demolish <name>." - which sent a model following build_flat_ride's advice
 * into a dead end with nothing at all to act on.
 */
test("a demolition the pause refuses says so in the game's own words, and names the way out", function () {
    const { game, restore } = park();
    addRide(game);
    game.gameValues.paused = true;

    try {
        const outcome = operate({ ride: 0, demolish: true });

        assert.equal(outcome.ok, false, "the ride is still standing, so this is not a success");
        assert.equal(game.rides.length, 1, "and the park still holds it");
        assert.equal(game.gameValues.paused, true, "the clock is left exactly where the model put it");

        assert.match(outcome.detail, /Could not demolish Carousel/, "the failure still names the ride");
        assert.match(outcome.detail, /Construction not possible while game is paused!/,
            "and the game's own reason for refusing it is the fact that was missing");
        assert.match(outcome.detail, /ridedemolish/, "nor is the action the pause refuses named");
        assert.match(outcome.detail, /set_game_speed \{paused: false\}/,
            "nor the one call a paused game does not refuse");
    } finally {
        restore();
    }
});

test("a demolition refused for another reason is quoted, and gains no pause clause", function () {
    // A clause appended unconditionally would satisfy the test above and be wrong here. The
    // game refuses a demolition for real reasons of its own - guests still on the ride, a
    // scenario that protects it - and the result carried none of them.
    const { game, restore } = park();
    addRide(game);
    game.refuse.ridedemolish = true;

    try {
        const outcome = operate({ ride: 0, demolish: true });

        assert.equal(game.gameValues.paused, false, "the fixture has to be a running game");
        assert.equal(game.rides.length, 1, "the ride is still standing");
        assert.match(outcome.detail, /Could not demolish Carousel: Refused: test refusal\./,
            "the game gave a reason and the result has to carry it");
        assert.doesNotMatch(outcome.detail, /paused/, "an unpaused failure must not blame the clock");
        assert.doesNotMatch(outcome.detail, /set_game_speed/,
            "nor send the model to a lever it does not need");
    } finally {
        restore();
    }
});

test("a demolition the game never answered reports exactly that", function () {
    // Nothing was read, so nothing may be quoted - and claiming the game accepted it would
    // be the same defect one step along.
    const { game, restore } = park({ inert: true });
    addRide(game);

    try {
        const outcome = operate({ ride: 0, demolish: true });

        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /the game reported no refusal and the ride is still there/);
        assert.equal(game.rides.length, 1);
    } finally {
        restore();
    }
});

test("opening and pricing a ride are untouched by the pause, because the game allows them", function () {
    // The other side of the split, pinned against the fake's gate rather than a sentence:
    // ridesetstatus and ridesetprice both carry Flags::AllowWhilePaused, so a paused
    // operate_ride that is not a demolition works normally and must gain no pause clause.
    const { game, restore } = park();
    addRide(game, { price: 5 });
    game.gameValues.paused = true;

    try {
        const outcome = operate({ ride: 0, open: true, price: 25 });

        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(game.rides[0].status, "open", "ridesetstatus is allowed while paused");
        assert.equal(game.rides[0].price[0], 25, "and so is ridesetprice");
        assert.doesNotMatch(outcome.detail, /paused/,
            "nothing was refused, so the clock has no place in this message");
    } finally {
        restore();
    }
});
