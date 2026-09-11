import assert from "node:assert/strict";
import test from "node:test";

import { createApplication } from "../src/app.ts";
import { BUILD_ID } from "../src/buildInfo.ts";
import { runScript, stateGuardSummary } from "../src/scripting.ts";
import { UiTools } from "../src/tools/ui.ts";

/**
 * A stand-in for the live plugin API, shaped the way the real one is rather than the way
 * test/fakeGame.ts is.
 *
 * DO NOT replace this with the shared FakeGame. Its `park` is an object literal of bare
 * getters, so `park.cash = 800000` against it is a silent no-op in non-strict code - which
 * is indistinguishable from a working guard. Every assertion in this file would go green
 * with the guards ripped out entirely, and the one thing being tested here is that an
 * assignment which really would have landed does not. The same goes for its rides, which
 * are plain objects with no shared prototype, so a guard installed on the prototype - the
 * only place one guard can cover every ride - would appear to cover nothing.
 *
 * So: every figure below sits behind a prototype accessor whose setter really writes.
 */

interface RideInstance {
    id: number;
    data: Record<string, number>;
}

const RIDE_FIGURES = [
    "excitement", "intensity", "nausea", "value", "runningCost",
    "totalProfit", "totalCustomers", "buildDate", "lifecycleFlags", "price"
];

/**
 * One prototype for every ride in the file, as the game has one for every ride in the
 * park. The guard lands here, so a ride built after it was installed is covered too.
 */
const ridePrototype: Record<string, unknown> = {};

RIDE_FIGURES.forEach(function (key) {
    Object.defineProperty(ridePrototype, key, {
        get: function (this: RideInstance) { return this.data[key]; },
        set: function (this: RideInstance, value: number) { this.data[key] = value; },
        configurable: true,
        enumerable: false
    });
});

function makeRide(id: number): RideInstance {
    const ride = Object.create(ridePrototype) as RideInstance;

    ride.id = id;
    ride.data = {
        excitement: 5.1, intensity: 4.2, nausea: 3.3, value: 40, runningCost: 30,
        totalProfit: 0, totalCustomers: 0, buildDate: 0, lifecycleFlags: 0, price: 10
    };

    return ride;
}

const PARK_FIGURES = [
    "cash", "rating", "bankLoan", "maxBankLoan", "value", "companyValue",
    "guests", "totalAdmissions", "totalIncomeFromAdmissions", "entranceFee"
];

const SCENARIO_FIGURES = ["status", "completedCompanyValue", "companyValueRecord", "parkRatingWarningDays"];

const OBJECTIVE_FIGURES = ["type", "guests", "year", "parkValue"];

const CHEAT_FIGURES = ["sandboxMode", "forcedParkRating", "disableAllBreakdowns"];

interface World {
    park: Record<string, number>;
    scenario: Record<string, unknown>;
    objective: Record<string, unknown>;
    cheats: Record<string, unknown>;
    rides: RideInstance[];
    executed: string[];
    queried: string[];
    calls: string[];
    created: string[];
    /** What reached the game's timers, so a refusal that leaked would show up here. */
    scheduled: string[];
    subscribed: string[];
    /** What reached the game's window system, and every callback it was handed. */
    uiCalls: string[];
    uiCallbacks: unknown[];
    /** The namespace itself, for the assertions about reading it from outside a script. */
    ui: Record<string, unknown>;
    timers: {
        setTimeout(callback: () => void, delay?: number): number;
        clearTimeout(handle: number): void;
    };
    addRide(): RideInstance;
    /**
     * Run `during` with action callbacks held rather than called, the way the game holds one
     * until the tick it applies the action on. `release` is that tick.
     */
    deferCallbacks(during: (release: () => void) => void): void;
    restore(): void;
}

interface WorldOptions {
    /**
     * Members the guard will fail to freeze, because they are already non-configurable.
     * Stands in for a route neither the guard nor its author thought of.
     */
    stubborn?: string[];
}

function defineFigures(prototype: object, keys: string[], store: Record<string, unknown>, stubborn: string[]): void {
    keys.forEach(function (key) {
        Object.defineProperty(prototype, key, {
            get: function () { return store[key]; },
            set: function (value: unknown) { store[key] = value; },
            configurable: stubborn.indexOf(key) < 0,
            enumerable: false
        });
    });
}

function installWorld(options?: WorldOptions): World {
    const scope = globalThis as unknown as Record<string, unknown>;
    const stubborn = (options && options.stubborn) || [];

    const parkStore: Record<string, number> = {
        cash: 100000, rating: 700, bankLoan: 70000, maxBankLoan: 100000,
        value: 150000, companyValue: 180000, guests: 12, totalAdmissions: 40,
        totalIncomeFromAdmissions: 8000, entranceFee: 15
    };
    const scenarioStore: Record<string, unknown> = {
        status: "inProgress", completedCompanyValue: 0, companyValueRecord: 180000, parkRatingWarningDays: 0
    };
    const objectiveStore: Record<string, unknown> = { type: "guestsBy", guests: 250, year: 4, parkValue: 0 };
    const cheatStore: Record<string, unknown> = {
        sandboxMode: false, forcedParkRating: -1, disableAllBreakdowns: false
    };

    const parkPrototype: Record<string, unknown> = {};
    defineFigures(parkPrototype, PARK_FIGURES, parkStore as unknown as Record<string, unknown>, stubborn);

    const calls: string[] = [];

    parkPrototype.generateGuest = function () {
        parkStore.guests += 1;
        return { id: parkStore.guests };
    };
    parkPrototype.grantAward = function (type: string) { calls.push("grantAward:" + type); };
    parkPrototype.clearAwards = function () { calls.push("clearAwards"); };
    parkPrototype.getFlag = function () { return false; };
    parkPrototype.setFlag = function (flag: string, value: boolean) {
        calls.push("setFlag:" + flag + "=" + String(value));
    };

    const objectivePrototype: Record<string, unknown> = {};
    defineFigures(objectivePrototype, OBJECTIVE_FIGURES, objectiveStore, stubborn);
    const objective = Object.create(objectivePrototype) as Record<string, unknown>;

    const scenarioPrototype: Record<string, unknown> = {};
    defineFigures(scenarioPrototype, SCENARIO_FIGURES, scenarioStore, stubborn);
    Object.defineProperty(scenarioPrototype, "objective", {
        get: function () { return objective; },
        set: function () { /* the game would reject this too */ },
        configurable: true,
        enumerable: false
    });

    const cheatPrototype: Record<string, unknown> = {};
    defineFigures(cheatPrototype, CHEAT_FIGURES, cheatStore, stubborn);

    const rides: RideInstance[] = [makeRide(0)];
    const created: string[] = [];
    const executed: string[] = [];
    const queried: string[] = [];
    const scheduled: string[] = [];
    const subscribed: string[] = [];

    const fakeMap = {
        get rides() { return rides; },
        getRide: function (id: number) {
            return rides.filter(function (ride) { return ride.id === id; })[0];
        },
        createEntity: function (type: string, _initializer: object) {
            created.push(type);
            return { type: type };
        }
    };

    /** Callbacks the game is holding until the tick it applies the action on. */
    const held: (() => void)[] = [];
    let deferring = false;

    /** Actions cost the park money, the way the game charges for them. */
    const fakeContext = {
        executeAction: function (name: string, args: Record<string, unknown>, callback?: (r: unknown) => void) {
            executed.push(name);

            if (name === "ridecreate") {
                parkStore.cash -= 12000;
            }

            if (name === "parksetloan") {
                const wanted = Number(args.value);
                parkStore.cash += wanted - parkStore.bankLoan;
                parkStore.bankLoan = wanted;
            }

            if (typeof callback === "function") {
                const answer = callback;

                if (deferring) {
                    held.push(function () { answer({ error: 0 }); });
                } else {
                    answer({ error: 0 });
                }
            }
        },
        queryAction: function (name: string, _args: object, callback?: (r: unknown) => void) {
            queried.push(name);

            if (typeof callback === "function") {
                callback({ error: 0 });
            }
        },
        registerAction: function () { /* not used here */ },

        /**
         * The timers the typed tools live on: every deferred tool schedules its own
         * continuation here, so these must keep working everywhere except inside a script.
         */
        setTimeout: function (callback: () => void, _delay?: number) {
            scheduled.push("timeout");
            callback();
            return scheduled.length;
        },
        setInterval: function (_callback: () => void, _delay?: number) {
            scheduled.push("interval");
            return scheduled.length;
        },
        clearTimeout: function (_handle: number) { scheduled.push("clearTimeout"); },
        clearInterval: function (_handle: number) { scheduled.push("clearInterval"); },
        subscribe: function (hook: string, _callback: () => void) {
            subscribed.push(hook);
            return { dispose: function () { /* not used here */ } };
        }
    };

    const uiCalls: string[] = [];
    const uiCallbacks: unknown[] = [];

    /** Records the call and every callback it was handed, so a leak shows up as either. */
    function reachedUi(name: string, handlers: unknown[]): void {
        uiCalls.push(name);

        for (let i = 0; i < handlers.length; i++) {
            if (typeof handlers[i] === "function") {
                uiCallbacks.push(handlers[i]);
            }
        }
    }

    /**
     * Shaped from the `Ui` interface in @openrct2/types rather than from what the plugin
     * happens to call: the members that hand the game a callback to run on a later tick are
     * the whole point, and the plugin itself uses exactly one member, showError.
     */
    const fakeUi: Record<string, unknown> = {
        get width() { return 1280; },
        get height() { return 720; },
        get windows() { return 3; },
        get tool() { return null; },
        get tileSelection() { return { range: null, tiles: [] }; },
        get mainViewport() { return { rotation: 0, zoom: 1 }; },
        showError: function (title: string, message: string) {
            reachedUi("showError:" + title + ":" + message, []);
        },
        openWindow: function (desc: Record<string, unknown>) {
            const widgets = (desc.widgets as Record<string, unknown>[]) || [];
            const handlers: unknown[] = [desc.onUpdate, desc.onClose, desc.onTabChange];

            for (let i = 0; i < widgets.length; i++) {
                handlers.push(widgets[i].onClick, widgets[i].onChange, widgets[i].onIncrement, widgets[i].onDraw);
            }

            reachedUi("openWindow", handlers);

            return { widgets: widgets, close: function () { /* not used here */ } };
        },
        getWindow: function () {
            reachedUi("getWindow", []);
            return { widgets: [], close: function () { /* not used here */ } };
        },
        closeWindows: function () { reachedUi("closeWindows", []); },
        closeAllWindows: function () { reachedUi("closeAllWindows", []); },
        activateTool: function (desc: Record<string, unknown>) {
            reachedUi("activateTool", [desc.onStart, desc.onDown, desc.onMove, desc.onUp, desc.onFinish]);
        },
        registerMenuItem: function (_text: string, callback: unknown) {
            reachedUi("registerMenuItem", [callback]);
        },
        registerToolboxMenuItem: function (_text: string, callback: unknown) {
            reachedUi("registerToolboxMenuItem", [callback]);
        },
        registerShortcut: function (desc: Record<string, unknown>) { reachedUi("registerShortcut", [desc.callback]); },
        showTextInput: function (desc: Record<string, unknown>) { reachedUi("showTextInput", [desc.callback]); },
        showFileBrowse: function (desc: Record<string, unknown>) { reachedUi("showFileBrowse", [desc.callback]); },
        showScenarioSelect: function (desc: Record<string, unknown>) { reachedUi("showScenarioSelect", [desc.callback]); },
        showGridlines: function () { reachedUi("showGridlines", []); },
        hideGridlines: function () { reachedUi("hideGridlines", []); }
    };

    const previous = {
        park: scope.park, scenario: scope.scenario, cheats: scope.cheats,
        map: scope.map, context: scope.context, ui: scope.ui
    };

    scope.park = Object.create(parkPrototype);
    scope.scenario = Object.create(scenarioPrototype);
    scope.cheats = Object.create(cheatPrototype);
    scope.map = fakeMap;
    scope.context = fakeContext;
    scope.ui = fakeUi;

    return {
        park: parkStore,
        scenario: scenarioStore,
        objective: objectiveStore,
        cheats: cheatStore,
        rides: rides,
        executed: executed,
        queried: queried,
        calls: calls,
        created: created,
        scheduled: scheduled,
        subscribed: subscribed,
        uiCalls: uiCalls,
        uiCallbacks: uiCallbacks,
        ui: fakeUi,
        timers: scope.context as unknown as World["timers"],
        addRide: function () {
            const ride = makeRide(rides.length);
            rides.push(ride);
            return ride;
        },
        deferCallbacks: function (during: (release: () => void) => void) {
            deferring = true;

            try {
                during(function () {
                    const pending = held.splice(0, held.length);

                    for (let i = 0; i < pending.length; i++) {
                        pending[i]();
                    }
                });
            } finally {
                deferring = false;
                held.length = 0;
            }
        },
        restore: function () {
            scope.park = previous.park;
            scope.scenario = previous.scenario;
            scope.cheats = previous.cheats;
            scope.map = previous.map;
            scope.context = previous.context;
            scope.ui = previous.ui;
        }
    };
}

interface Outcome {
    ok: boolean;
    result?: unknown;
    error?: string;
    unaccountedChanges?: { property: string; before: unknown; after: unknown }[];
    note?: string;
}

function run(code: string): Outcome {
    return runScript(code) as unknown as Outcome;
}

function expectRefusal(code: string): string {
    const outcome = run(code);

    assert.equal(outcome.ok, false, "expected a refusal, got: " + JSON.stringify(outcome));
    return String(outcome.error);
}

/* ------------------------------------------------------------------ *
 * The entry point the model actually uses
 *
 * Calling the exported `runScript` is a different question from calling the evaluate tool:
 * it proves this module refuses, not that the function the game ends up calling belongs to
 * this load of the module. Three guards passed the first question for months while doing
 * nothing at all in the running game, so anything about a guard biting is asked through a
 * real MCP session on a real application, the way the model asks it.
 * ------------------------------------------------------------------ */

const MCP_PROTOCOL = "2025-11-25";

function rawMcpPost(headers: Record<string, string>, body: string): string {
    const lines = ["POST /mcp HTTP/1.1"].concat(Object.keys(headers).map(function (name) {
        return name + ": " + headers[name];
    }));

    return lines.join("\r\n") + "\r\n\r\n" + body;
}

/** An initialised MCP session, returning a function that calls any tool on it. */
function mcpSession(): (name: string, args: Record<string, unknown>) => Record<string, unknown> {
    const app = createApplication();
    const headers: Record<string, string> = {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json"
    };

    const opened = app.handleRawRequest(rawMcpPost(headers, JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: MCP_PROTOCOL,
            capabilities: {},
            clientInfo: { name: "state-guard-test", version: "1.0.0" }
        }
    })));

    headers["MCP-Session-Id"] = String(opened.getHeader("mcp-session-id"));
    headers["MCP-Protocol-Version"] = MCP_PROTOCOL;

    app.handleRawRequest(rawMcpPost(headers, JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized"
    })));

    return function (name: string, args: Record<string, unknown>): Record<string, unknown> {
        const response = app.handleRawRequest(rawMcpPost(headers, JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: name, arguments: args }
        })));

        const body = JSON.parse(response.getBody()) as { result?: { structuredContent?: Record<string, unknown> } };

        assert.ok(body.result, "the " + name + " tool answered with no result: " + response.getBody());
        assert.ok(body.result.structuredContent,
            "the " + name + " tool answered with no structured result: " + response.getBody());

        return body.result.structuredContent;
    };
}

/** The same session, asking the one question most of this file asks. */
function mcpEvaluate(): (code: string) => Outcome {
    const call = mcpSession();

    return function (code: string): Outcome {
        return call("evaluate", { code: code }) as unknown as Outcome;
    };
}

function expectMcpRefusal(evaluate: (code: string) => Outcome, code: string): string {
    const outcome = evaluate(code);

    assert.equal(outcome.ok, false, code + " was let through: " + JSON.stringify(outcome));
    return String(outcome.error);
}

/**
 * A second, independent load of the same module against the same globals.
 *
 * This is what a hot reload is: OpenRCT2 keeps one `context` object for the whole process
 * and re-runs the plugin file, and `npm run watch` re-runs it on every save. The wrappers
 * the earlier load installed are marked and still in their slots, and the `insideEvaluate`,
 * refusal list and action log they close over are that load's, not the one now running.
 */
async function loadPluginAgain(): Promise<typeof import("../src/scripting.ts")> {
    const again = await import(new URL("../src/scripting.ts?previous-load", import.meta.url).href);

    return again as typeof import("../src/scripting.ts");
}

/* ------------------------------------------------------------------ *
 * Part 1 - the direct levers
 * ------------------------------------------------------------------ */

test("assigning any frozen lever throws, and the figure behind it does not move", function () {
    const world = installWorld();

    try {
        const attempts: { code: string; read(): unknown; name: string }[] = [
            { name: "park.cash", code: "park.cash = 800000", read: function () { return world.park.cash; } },
            { name: "park.rating", code: "park.rating = 999", read: function () { return world.park.rating; } },
            { name: "park.bankLoan", code: "park.bankLoan = 0", read: function () { return world.park.bankLoan; } },
            { name: "park.maxBankLoan", code: "park.maxBankLoan = 9e6", read: function () { return world.park.maxBankLoan; } },
            { name: "park.value", code: "park.value = 9e6", read: function () { return world.park.value; } },
            { name: "park.companyValue", code: "park.companyValue = 9e6", read: function () { return world.park.companyValue; } },
            { name: "park.guests", code: "park.guests = 5000", read: function () { return world.park.guests; } },
            { name: "park.totalAdmissions", code: "park.totalAdmissions = 9999", read: function () { return world.park.totalAdmissions; } },
            { name: "scenario.status", code: "scenario.status = 'completed'", read: function () { return world.scenario.status; } },
            { name: "scenario.companyValueRecord", code: "scenario.companyValueRecord = 9e6", read: function () { return world.scenario.companyValueRecord; } },
            { name: "scenario.parkRatingWarningDays", code: "scenario.parkRatingWarningDays = 0", read: function () { return world.scenario.parkRatingWarningDays; } },
            { name: "scenario.objective.guests", code: "scenario.objective.guests = 1", read: function () { return world.objective.guests; } },
            { name: "scenario.objective.year", code: "scenario.objective.year = 99", read: function () { return world.objective.year; } },
            { name: "cheats.sandboxMode", code: "cheats.sandboxMode = true", read: function () { return world.cheats.sandboxMode; } },
            { name: "cheats.forcedParkRating", code: "cheats.forcedParkRating = 999", read: function () { return world.cheats.forcedParkRating; } },
            { name: "ride.excitement", code: "map.getRide(0).excitement = 9.9", read: function () { return world.rides[0].data.excitement; } },
            { name: "ride.value", code: "map.getRide(0).value = 5000", read: function () { return world.rides[0].data.value; } },
            { name: "ride.totalProfit", code: "map.getRide(0).totalProfit = 5000", read: function () { return world.rides[0].data.totalProfit; } }
        ];

        for (let i = 0; i < attempts.length; i++) {
            const attempt = attempts[i];
            const was = attempt.read();
            const error = expectRefusal(attempt.code);

            assert.match(error, /cannot be assigned/,
                attempt.name + " must refuse in words, not silently: " + error);
            assert.equal(attempt.read(), was,
                attempt.name + " must still read " + JSON.stringify(was) + " after the refusal");
        }
    } finally {
        world.restore();
    }
});

test("a refusal names what does move the value, so it is worth reading", function () {
    const world = installWorld();

    try {
        const cash = expectRefusal("park.cash = 800000");
        assert.match(cash, /takings/, "cash must be pointed at the park earning it: " + cash);
        assert.match(cash, /parksetloan/, "and at the one action that raises it: " + cash);

        const rating = expectRefusal("park.rating = 999");
        assert.match(rating, /queue lengths/, "rating must be pointed at the park's condition: " + rating);

        const excitement = expectRefusal("map.getRide(0).excitement = 9.9");
        assert.match(excitement, /Rebuild the track/, "a ride's ratings must be pointed at the track: " + excitement);

        // Every refusal closes the same way, so none of them is a bare "denied".
        [cash, rating, excitement].forEach(function (message) {
            assert.match(message, /come out of running the park/, "a refusal must name the alternative: " + message);
        });
    } finally {
        world.restore();
    }
});

test("the guard cannot be deleted, redefined or shadowed", function () {
    const world = installWorld();

    try {
        const deleted = expectRefusal(`
            delete park.cash;
            delete Object.getPrototypeOf(park).cash;
            park.cash = 800000;
        `);
        assert.match(deleted, /cannot be assigned/, "delete must not take the guard with it: " + deleted);

        const redefined = expectRefusal(`
            Object.defineProperty(Object.getPrototypeOf(park), "cash", { value: 800000, writable: true });
            return park.cash;
        `);
        assert.match(redefined, /redefine|Cannot|not extensible/i,
            "redefining the guarded property must fail outright: " + redefined);

        // Shadowing would not make the park richer, but it would make the check in Part 2
        // read the script's number instead of the game's.
        const shadowed = expectRefusal(`
            Object.defineProperty(park, "cash", { value: 800000 });
            return park.cash;
        `);
        assert.match(shadowed, /extensible|Cannot|define/i, "an own property must not shadow the guard: " + shadowed);

        assert.equal(world.park.cash, 100000, "after all three, the park still has what it had");
    } finally {
        world.restore();
    }
});

test("park.generateGuest() refuses and no guest appears", function () {
    const world = installWorld();

    try {
        const error = expectRefusal("park.generateGuest()");

        assert.match(error, /cannot be called/, error);
        assert.match(error, /Guests walk in on their own/, "the message must say where guests come from: " + error);
        assert.equal(world.park.guests, 12, "the guest count must be untouched");
    } finally {
        world.restore();
    }
});

test("map.createEntity refuses a guest and lets everything else through", function () {
    const world = installWorld();

    try {
        const error = expectRefusal('map.createEntity("guest", { x: 10, y: 10, z: 14 })');

        assert.match(error, /cannot be called/, error);
        assert.deepEqual(world.created, [], "the refused type must never reach the game");

        const outcome = run('map.createEntity("balloon", { x: 10, y: 10, z: 14 }); return "done";');

        assert.equal(outcome.ok, true, "a harmless entity type is not a lever: " + JSON.stringify(outcome));
        assert.deepEqual(world.created, ["balloon"]);
    } finally {
        world.restore();
    }
});

test("setFlag still opens the park, and still refuses the four rule flags", function () {
    const world = installWorld();

    try {
        const opened = run('park.setFlag("open", true); return "open";');

        assert.equal(opened.ok, true, "open_park sets this flag on every run: " + JSON.stringify(opened));
        assert.deepEqual(world.calls, ["setFlag:open=true"]);

        ["noMoney", "unlockAllPrices", "difficultGuestGeneration", "difficultParkRating"].forEach(function (flag) {
            const error = expectRefusal('park.setFlag("' + flag + '", true)');

            assert.match(error, new RegExp(flag), "the refusal must name the flag: " + error);
        });

        assert.deepEqual(world.calls, ["setFlag:open=true"], "none of the four may reach the game");
    } finally {
        world.restore();
    }
});

const REFUSED_ACTION_CALLS = [
    { code: 'context.executeAction("cheatset", { type: 16, param1: 1000000, param2: 0 })', names: /cheatset/ },
    { code: 'context.executeAction("scenariosetsetting", { setting: 1, value: 1 })', names: /scenariosetsetting/ },
    { code: 'context.executeAction("parksetdate", { year: 1, month: 1, day: 1 })', names: /parksetdate/ },
    { code: 'context.executeAction("ridefreezerating", { ride: 0 })', names: /ridefreezerating/ },
    // A query changes nothing, but probing for a cheat is not play either.
    { code: 'context.queryAction("cheatset", { type: 16, param1: 1, param2: 0 })', names: /cheatset/ }
];

test("the cheat and scenario-editor actions are refused by name and never reach the game", function () {
    const world = installWorld();

    try {
        const evaluate = mcpEvaluate();

        const cheat = expectMcpRefusal(evaluate, REFUSED_ACTION_CALLS[0].code);
        assert.match(cheat, /cheatset is not available in this run/, cheat);
        assert.match(cheat, /come out of running the park/, "a refused action must name the alternative too: " + cheat);

        REFUSED_ACTION_CALLS.forEach(function (attempt) {
            assert.match(expectMcpRefusal(evaluate, attempt.code), attempt.names, attempt.code);
        });

        assert.deepEqual(world.executed, [], "no refused action may reach the game");
        assert.deepEqual(world.queried, []);

        const legitimate = evaluate('context.executeAction("ridesetstatus", { ride: 0, status: 1 }); return "ok";');

        assert.equal(legitimate.ok, true, "an ordinary action still goes through: " + JSON.stringify(legitimate));
        assert.deepEqual(world.executed, ["ridesetstatus"]);
    } finally {
        world.restore();
    }
});

/** What an older build left in the slot: the unknown-name check, marked, and no refusal list. */
function installPreviousLoadActionGuard(key: string, lock: boolean): void {
    const scope = globalThis as unknown as { context: Record<string, unknown> };
    const original = scope.context[key] as (this: unknown, name: string, args: object, callback?: (r: unknown) => void) => unknown;

    const wrapper = function (this: unknown, name: string, args: object, callback?: (r: unknown) => void): unknown {
        if (typeof name !== "string" || name.indexOf("_") >= 0) {
            throw new Error("there is no game action named \"" + String(name) + "\"");
        }

        return original.call(this, name, args, callback);
    };

    (wrapper as unknown as Record<string, unknown>).__freeplayActionGuard = true;

    Object.defineProperty(scope.context, key, {
        value: wrapper, writable: !lock, configurable: false, enumerable: false
    });
}

test("a cheat is refused even when an older build's action guard is already in the slot", function () {
    const world = installWorld();

    try {
        // The live failure, reproduced: `cheatset` reached the game while an invented name
        // still threw, because the wrapper doing the checking was an older build's - marked
        // as guarded, and written before the refusal list existed.
        installPreviousLoadActionGuard("executeAction", false);
        installPreviousLoadActionGuard("queryAction", false);

        const evaluate = mcpEvaluate();

        REFUSED_ACTION_CALLS.forEach(function (attempt) {
            assert.match(expectMcpRefusal(evaluate, attempt.code), attempt.names,
                "a mark from another load is not this load's refusal list: " + attempt.code);
        });

        assert.deepEqual(world.executed, [], "no refused action may reach the game");
        assert.deepEqual(world.queried, []);

        // The older wrapper is still in the chain, so ordinary play must still pass through it.
        const legitimate = evaluate('context.executeAction("ridesetstatus", { ride: 0, status: 1 }); return "ok";');

        assert.equal(legitimate.ok, true, "an ordinary action still goes through: " + JSON.stringify(legitimate));
        assert.deepEqual(world.executed, ["ridesetstatus"]);
    } finally {
        world.restore();
    }
});

test("a slot this load cannot take back is reported as open, not counted as frozen", function () {
    const world = installWorld();

    try {
        // Builds before this one locked the action slots shut, so a plugin hot-reloaded onto
        // one of those cannot get its refusal list in front of the game at all. That case is
        // unfixable from here and must not read as clean: it has to reach the endpoint a run
        // is gated on. One clean load of the game is what clears it.
        installPreviousLoadActionGuard("executeAction", true);

        const index = getV1(createApplication());

        assert.equal(index.stateGuards.ok, false, "a guard that could not be installed is not ok");
        assert.ok(index.stateGuards.unfrozen.indexOf("context.executeAction") >= 0,
            "and it must be named: " + JSON.stringify(index.stateGuards.unfrozen));

        // And the hole is real, which is what makes reporting it worth anything.
        const evaluate = mcpEvaluate();
        const outcome = evaluate('context.executeAction("cheatset", { type: 16, param1: 1, param2: 0 }); return "through";');

        assert.equal(outcome.ok, true, "the stand-in must be a real hole, or this proves nothing");
        assert.deepEqual(world.executed, ["cheatset"]);
    } finally {
        world.restore();
    }
});

test("a ride built after the guard went in is covered, and its price is still the model's to set", function () {
    const world = installWorld();

    try {
        run("1 + 1");

        const built = world.addRide();
        const error = expectRefusal("map.getRide(" + built.id + ").excitement = 9.9");

        assert.match(error, /cannot be assigned/, "the guard sits on the shared prototype, not on one ride: " + error);
        assert.equal(built.data.excitement, 5.1);

        // Charging what you like is playing the game, so price must stay writable.
        const priced = run("map.getRide(" + built.id + ").price = 25; return map.getRide(" + built.id + ").price;");

        assert.equal(priced.ok, true, JSON.stringify(priced));
        assert.equal(built.data.price, 25);
    } finally {
        world.restore();
    }
});

/* ------------------------------------------------------------------ *
 * Part 2 - the check that survives a route nobody thought of
 * ------------------------------------------------------------------ */

test("money spent through a real action is play, not an unaccounted change", function () {
    const world = installWorld();

    try {
        const outcome = run('context.executeAction("ridecreate", { rideType: 1 }); return park.cash;');

        assert.equal(outcome.ok, true, JSON.stringify(outcome));
        assert.equal(outcome.result, 88000, "the ride really did cost the park 12,000");
        assert.equal(outcome.unaccountedChanges, undefined,
            "a ridecreate that spends money is the model playing: " + JSON.stringify(outcome.unaccountedChanges));
        assert.equal(outcome.note, undefined, "and nothing is said about it");
    } finally {
        world.restore();
    }
});

test("a script that changes nothing says nothing", function () {
    const world = installWorld();

    try {
        const outcome = run("park.cash");

        assert.deepEqual(outcome, { ok: true, result: 100000 },
            "a read-only script's result must carry no extra fields at all");
    } finally {
        world.restore();
    }
});

test("cash that moves with no action behind it is reported", function () {
    // `cash` is non-configurable here, so the guard above cannot freeze it. That is the
    // whole point of this test: it stands in for a route neither of us thought of.
    const world = installWorld({ stubborn: ["cash"] });

    try {
        const outcome = run("park.cash = 900000; return park.cash;");

        assert.equal(outcome.ok, true, "the assignment went through, which is what makes this worth reporting");
        assert.equal(world.park.cash, 900000);

        assert.deepEqual(outcome.unaccountedChanges, [{ property: "park.cash", before: 100000, after: 900000 }]);
        assert.match(String(outcome.note), /park\.cash 100000 -> 900000/, String(outcome.note));
        assert.match(String(outcome.note), /executed no game action/, String(outcome.note));
        assert.match(String(outcome.note), /running the park/, "it must read as an observation: " + String(outcome.note));
    } finally {
        world.restore();
    }
});

test("an action that cannot move the value does not excuse it", function () {
    const world = installWorld({ stubborn: ["rating"] });

    try {
        const outcome = run(`
            context.executeAction("ridesetstatus", { ride: 0, status: 1 });
            park.rating = 999;
            return park.rating;
        `);

        assert.equal(outcome.ok, true, JSON.stringify(outcome));
        assert.deepEqual(outcome.unaccountedChanges, [{ property: "park.rating", before: 700, after: 999 }],
            "opening a ride does not move the park rating inside one tick");
        assert.match(String(outcome.note), /ridesetstatus/, "the note must say which action was executed: " + String(outcome.note));
    } finally {
        world.restore();
    }
});

test("a loan taken through its own action is accounted for, cash and all", function () {
    const world = installWorld();

    try {
        const outcome = run('context.executeAction("parksetloan", { value: 90000 }); return park.bankLoan;');

        assert.equal(outcome.ok, true, JSON.stringify(outcome));
        assert.equal(world.park.bankLoan, 90000);
        assert.equal(world.park.cash, 120000);
        assert.equal(outcome.unaccountedChanges, undefined,
            "borrowing is a game mechanic with interest attached: " + JSON.stringify(outcome.unaccountedChanges));
    } finally {
        world.restore();
    }
});

test("replacing the park global does not hide what was done to the real one", function () {
    const world = installWorld({ stubborn: ["cash"] });

    try {
        const outcome = run(`
            var real = park;
            real.cash = 900000;
            park = { cash: 100000 };
            return park.cash;
        `);

        assert.equal(outcome.ok, true, JSON.stringify(outcome));
        assert.equal(outcome.result, 100000, "the script's own reading is its decoy");
        assert.deepEqual(outcome.unaccountedChanges, [{ property: "park.cash", before: 100000, after: 900000 }],
            "the check reads the object it captured, not whatever the script left in the global");
        assert.equal(world.park.cash, 900000);
    } finally {
        world.restore();
    }
});

test("a script that moves something and then throws is still reported", function () {
    const world = installWorld({ stubborn: ["cash"] });

    try {
        const outcome = run("park.cash = 900000; throw new Error('never mind');");

        assert.equal(outcome.ok, false);
        assert.match(String(outcome.error), /never mind/);
        assert.deepEqual(outcome.unaccountedChanges, [{ property: "park.cash", before: 100000, after: 900000 }],
            "the throw is not the interesting part");
        assert.equal(world.park.cash, 900000);
    } finally {
        world.restore();
    }
});

test("the objective's own numbers are watched as well as frozen", function () {
    const world = installWorld({ stubborn: ["guests"] });

    try {
        // `guests` is stubborn on both park and objective here, so this is the objective
        // being moved rather than the score being faked - the same cheat from the far end.
        const outcome = run("scenario.objective.guests = 1; return scenario.objective.guests;");

        assert.equal(outcome.ok, true, JSON.stringify(outcome));
        assert.equal(world.objective.guests, 1);

        const changed = (outcome.unaccountedChanges || []).map(function (change) { return change.property; });

        assert.ok(changed.indexOf("scenario.objective.guests") >= 0,
            "moving the goalposts must be reported: " + JSON.stringify(outcome.unaccountedChanges));
    } finally {
        world.restore();
    }
});

/* ------------------------------------------------------------------ *
 * Deferred work - the one route that escapes both halves at once
 * ------------------------------------------------------------------ */

const DEFERRED_WORK = [
    'context.setTimeout(function () { park.cash = 9e6; }, 10)',
    'context.setInterval(function () { park.cash = 9e6; }, 10)',
    "context.clearTimeout(1)",
    "context.clearInterval(1)",
    'context.subscribe("ride.ratings.calculate", function (e) { e.excitement = 999; })'
];

test("the evaluate tool refuses to schedule or subscribe, and nothing reaches the game", function () {
    const world = installWorld();

    try {
        const evaluate = mcpEvaluate();

        DEFERRED_WORK.forEach(function (code) {
            const error = expectMcpRefusal(evaluate, code);

            assert.match(error, /cannot be called from an evaluated script/, code + " -> " + error);
            assert.match(error, /come out of running the park/, "and it closes the way the others do: " + error);
        });

        assert.deepEqual(world.scheduled, [], "no callback may reach the game's timers");
        assert.deepEqual(world.subscribed, [], "no hook may be left behind after the script has answered");
    } finally {
        world.restore();
    }
});

test("a timer guard left by a previous load of the plugin does not count as guarded", async function () {
    const world = installWorld();

    try {
        // The live failure, reproduced: the previous load guards `context` first, so every
        // slot is already marked and already holds a working-looking wrapper by the time
        // this load installs. Its wrapper reads its own `insideEvaluate`, which no evaluate
        // running here will ever set, so treating the mark as proof leaves the route open.
        const previousLoad = await loadPluginAgain();

        previousLoad.runScript("1 + 1");

        const evaluate = mcpEvaluate();

        DEFERRED_WORK.forEach(function (code) {
            assert.match(expectMcpRefusal(evaluate, code), /cannot be called from an evaluated script/,
                "a wrapper this load did not install is not this load's guard: " + code);
        });

        assert.deepEqual(world.scheduled, [], "an interval registered here would keep running between tool calls");
        assert.deepEqual(world.subscribed, [],
            "and a ride.ratings.calculate subscriber would rewrite ratings after the freeze, every recalculation");
    } finally {
        world.restore();
    }
});

test("the other endpoint that runs script is inside the guards too", function () {
    const world = installWorld();

    try {
        // GET /v1/eval took a bare `new Function`, so `insideEvaluate` was never set on it
        // and every guard that only bites inside a script did nothing there. It is the same
        // code from the same author reaching the same game, so it runs the same way.
        const app = createApplication();
        const refused = JSON.parse(app.handleRawRequest(
            "GET /v1/eval?q=" + encodeURIComponent("context.setInterval(function () {}, 10)") + " HTTP/1.1\r\n\r\n"
        ).getBody()) as { error?: string; result?: unknown };

        assert.match(String(refused.error), /cannot be called from an evaluated script/, JSON.stringify(refused));
        assert.deepEqual(world.scheduled, [], "nothing may reach the game's timers through this door either");

        const cheat = JSON.parse(app.handleRawRequest(
            "GET /v1/eval?q=" + encodeURIComponent('context.executeAction("cheatset", { type: 16 })') + " HTTP/1.1\r\n\r\n"
        ).getBody()) as { error?: string };

        assert.match(String(cheat.error), /cheatset is not available in this run/, JSON.stringify(cheat));
        assert.deepEqual(world.executed, []);

        // Reading the park through it still works, which is what the dashboard uses it for.
        const read = JSON.parse(app.handleRawRequest("GET /v1/eval?q=park.cash HTTP/1.1\r\n\r\n").getBody()) as { result?: unknown };

        assert.equal(read.result, 100000, "an ordinary read must still answer: " + JSON.stringify(read));
    } finally {
        world.restore();
    }
});

test("the refusals say why a script has no use for either", function () {
    const world = installWorld();

    try {
        const evaluate = mcpEvaluate();

        const timer = expectMcpRefusal(evaluate, "context.setTimeout(function () {}, 10)");
        assert.match(timer, /answers the moment it/, "the reason is that the model is already gone: " + timer);
        assert.match(timer, /typed tool/, "and the alternative is the tools that do span ticks: " + timer);

        const hook = expectMcpRefusal(evaluate, 'context.subscribe("interval.tick", function () {})');
        assert.match(hook, /fires on a later tick/, hook);
        // The point of naming this one: it would undo the ride ratings guard outright.
        assert.match(hook, /ride\.ratings\.calculate/, "the message must name what a hook can overwrite: " + hook);

        const cancel = expectMcpRefusal(evaluate, "context.clearTimeout(1)");
        assert.match(cancel, /belong to the typed tools/, cancel);
    } finally {
        world.restore();
    }
});

test("outside a script the game's timer is untouched, including after a script threw", function () {
    const world = installWorld();

    try {
        expectRefusal("context.setTimeout(function () {}, 10)");
        expectRefusal("throw new Error('the script blew up mid-way');");

        // This is the deferred tools' own call, made the way build_flat_ride makes it.
        let ran = false;
        world.timers.setTimeout(function () { ran = true; }, 10);

        assert.equal(ran, true, "a typed tool's continuation must still run after an evaluated script");
        assert.deepEqual(world.scheduled, ["timeout"], "and it must reach the game, not the guard");

        world.timers.clearTimeout(1);
        assert.deepEqual(world.scheduled, ["timeout", "clearTimeout"], "clearTimeout is the tools' too");
    } finally {
        world.restore();
    }
});

test("src/mcp.ts can still swap the game timer for its own and swap it back", function () {
    const world = installWorld();

    try {
        // The guard has to be in the slot before the swap, or this proves nothing: the
        // guards install on the first evaluate, not when the world does.
        expectRefusal("context.setTimeout(function () {}, 10)");

        // Exactly what watchDeferredWork / unwatchDeferredWork do while a deferred tool
        // is in flight. A locked slot here would take build_flat_ride down with it.
        const scope = globalThis as unknown as { context: Record<string, unknown> };
        const gameTimer = scope.context.setTimeout as (callback: () => void, delay: number) => number;
        const attributed: string[] = [];
        const wrappedTimer = function (callback: () => void, delay: number): number {
            attributed.push("wrapped");
            return gameTimer.call(scope.context, callback, delay);
        };

        scope.context.setTimeout = wrappedTimer;
        assert.equal(scope.context.setTimeout, wrappedTimer, "the assignment must take");

        let ran = false;
        (scope.context.setTimeout as typeof wrappedTimer)(function () { ran = true; }, 10);

        assert.equal(ran, true);
        assert.deepEqual(attributed, ["wrapped"], "the tool's continuation went through mcp's wrapper");
        assert.deepEqual(world.scheduled, ["timeout"], "and on to the game");

        scope.context.setTimeout = gameTimer;
        assert.equal(scope.context.setTimeout, gameTimer, "and the restore must take too");

        // The guard survives the round trip: it was never the thing being swapped.
        assert.match(expectRefusal("context.setTimeout(function () {}, 10)"), /cannot be called from an evaluated script/);
    } finally {
        world.restore();
    }
});

test("a timer the game handed back to us is guarded again on the next script", function () {
    const world = installWorld();

    try {
        expectRefusal("context.setTimeout(function () {}, 10)");

        // mcp.ts restores whatever it captured, which can drop the wrapper. The next
        // evaluate has to put it back rather than leave the route open for the session.
        const scope = globalThis as unknown as { context: Record<string, unknown> };
        scope.context.setTimeout = function (callback: () => void) {
            world.scheduled.push("raw");
            callback();
            return 1;
        };

        assert.match(expectRefusal("context.setTimeout(function () {}, 10)"),
            /cannot be called from an evaluated script/, "the guard must reinstall itself");
        assert.deepEqual(world.scheduled, [], "and the raw timer must not have been reached");
    } finally {
        world.restore();
    }
});

/* ------------------------------------------------------------------ *
 * The window system - the same hole as a hook, one namespace along
 * ------------------------------------------------------------------ */

const UI_ROUTES = [
    // The one this is all for: a callback the game runs every tick, registered and left
    // behind, on a tick where nothing is watching and after evaluate has answered.
    'ui.openWindow({ classification: "freeplay", width: 200, height: 100, title: "x",'
        + " onUpdate: function () { park.cash = 9e6; } })",
    // And the same thing one level down, where a window's widgets carry their own.
    'ui.openWindow({ classification: "freeplay", width: 200, height: 100, title: "x",'
        + ' widgets: [{ type: "button", x: 0, y: 0, width: 10, height: 10, onClick: function () {} }] })',
    'ui.activateTool({ id: "freeplay", onMove: function () {} })',
    'ui.registerMenuItem("cheat", function () {})',
    'ui.registerToolboxMenuItem("cheat", function () {})',
    'ui.registerShortcut({ id: "freeplay.x", text: "x", callback: function () {} })',
    'ui.showTextInput({ title: "x", description: "x", callback: function () {} })',
    'ui.showFileBrowse({ type: "load", fileType: "game", callback: function () {} })',
    'ui.showScenarioSelect({ callback: function () {} })',
    // These take no callback. They are refused all the same, because the namespace is
    // refused rather than a list of members, which is the point of doing it this way.
    'ui.showError("a", "b")',
    "ui.closeAllWindows()",
    "ui.getWindow(0)",
    "ui.width",
    "ui.tool",
    // However it is spelled, it is the same read of the same slot.
    "globalThis.ui.openWindow",
    "var handle = ui; return typeof handle;"
];

test("the evaluate tool refuses the whole ui namespace, and nothing reaches the window system", function () {
    const world = installWorld();

    try {
        const evaluate = mcpEvaluate();

        UI_ROUTES.forEach(function (code) {
            const error = expectMcpRefusal(evaluate, code);

            assert.match(error, /ui cannot be reached from an evaluated script/, code + " -> " + error);
            assert.match(error, /come out of running the park/, "and it closes the way the others do: " + error);
        });

        assert.deepEqual(world.uiCalls, [], "no window call may reach the game");
        assert.deepEqual(world.uiCallbacks, [],
            "and a window's onUpdate would go on running every tick, long after evaluate had answered");
    } finally {
        world.restore();
    }
});

test("the ui refusal says why a script has no use for a window", function () {
    const world = installWorld();

    try {
        const error = expectMcpRefusal(mcpEvaluate(), UI_ROUTES[0]);

        assert.match(error, /answers the moment it/, "the reason is that the model is already gone: " + error);
        assert.match(error, /nobody is at the screen/i, "and that there is nobody to read a window: " + error);
        assert.match(error, /openWindow/, "the message must name what it is refusing: " + error);
        assert.match(error, /typed tool/, "and the alternative is the tools that do span ticks: " + error);
    } finally {
        world.restore();
    }
});

test("a ui guard left by a previous load of the plugin does not count as guarded", async function () {
    const world = installWorld();

    try {
        // The previous load has to reach the slot first, which is what a hot reload is:
        // nothing of this load's may be sitting in it, or the previous load stands aside
        // and there is no stale accessor left to be fooled by.
        const scope = globalThis as unknown as Record<string, unknown>;

        delete scope.ui;
        scope.ui = world.ui;

        // The same failure the timer guards had, reproduced on the namespace: the previous
        // load's accessor is in the slot, marked, and reads its own `insideEvaluate`, which
        // no evaluate running here will ever set. Treating the mark as proof leaves it open.
        const previousLoad = await loadPluginAgain();

        previousLoad.runScript("1 + 1");

        const evaluate = mcpEvaluate();

        UI_ROUTES.forEach(function (code) {
            assert.match(expectMcpRefusal(evaluate, code), /ui cannot be reached from an evaluated script/,
                "an accessor this load did not install is not this load's guard: " + code);
        });

        assert.deepEqual(world.uiCalls, [], "no window call may reach the game");
        assert.deepEqual(world.uiCallbacks, []);
    } finally {
        world.restore();
    }
});

test("the plugin's own window calls are untouched, before and after a script", function () {
    const world = installWorld();

    try {
        // The guards go in when the plugin starts, not when the first script runs.
        createApplication();

        // The plugin's own use of the namespace is a typed tool, which is outside any
        // script - so this must reach the game exactly as it did before the guard went in.
        const shown = new UiTools().showError({ title: "Ride broken", message: "The Corkscrew has stalled" });

        assert.equal(shown.shown, true, "the plugin's own dialog must still go up: " + JSON.stringify(shown));
        assert.deepEqual(world.uiCalls, ["showError:Ride broken:The Corkscrew has stalled"]);

        // And a script that threw must not leave the namespace refused for everyone else.
        expectRefusal("throw new Error('the script blew up mid-way');");

        const scope = globalThis as unknown as { ui: Record<string, unknown> };

        assert.equal(scope.ui.width, 1280, "reading the namespace outside a script is the game's own business");
        assert.equal(typeof scope.ui.openWindow, "function");
    } finally {
        world.restore();
    }
});

test("a script cannot take the window system away from the plugin", function () {
    const world = installWorld();

    try {
        const evaluate = mcpEvaluate();

        // Two lines, and the plugin's own error dialog would be calling a function of the
        // script's on some later tick: the deferred hole again, from the far end. The slot
        // has to stay replaceable so the next load of the plugin can take it back, so what
        // closes this is putting the guard back rather than refusing the delete.
        const outcome = evaluate("delete globalThis.ui;"
            + " globalThis.ui = { showError: function () { park.cash = 9e6; } };"
            + " return typeof globalThis.ui;");

        const scope = globalThis as unknown as { ui: Record<string, unknown> };

        assert.equal(scope.ui.width, 1280,
            "the game's own ui must be back in the slot the moment the script returns: " + JSON.stringify(outcome));
        assert.equal(scope.ui, world.ui, "and it must be the game's object, not the script's stand-in");
        assert.match(expectMcpRefusal(evaluate, "ui.width"), /cannot be reached from an evaluated script/,
            "with the guard still over it");
    } finally {
        world.restore();
    }
});

test("a ui slot this load cannot take is reported as open, not counted as frozen", function () {
    const world = installWorld();
    const scope = globalThis as unknown as Record<string, unknown>;
    const realDefineProperty = Object.defineProperty;

    try {
        // The accessor an earlier test left has to come out first, or there is nothing for
        // this load to install and the slot never gets the chance to refuse.
        delete scope.ui;
        scope.ui = world.ui;

        // The stand-in for a plugin API that will not take the accessor - a global the game
        // declared non-configurable, say. Unfixable from here, and it must reach the
        // endpoint a run is gated on rather than quietly report a guard that is not there.
        Object.defineProperty = function (target: object, key: PropertyKey, attributes: PropertyDescriptor & ThisType<unknown>) {
            if (target === globalThis && key === "ui") {
                throw new TypeError("Cannot redefine property: ui");
            }

            return realDefineProperty(target, key, attributes);
        } as typeof Object.defineProperty;

        const index = getV1(createApplication());

        assert.equal(index.stateGuards.ok, false, "a guard that could not be installed is not ok");
        assert.ok(index.stateGuards.unfrozen.indexOf("ui") >= 0,
            "and it must be named: " + JSON.stringify(index.stateGuards.unfrozen));

        // And the hole is real, which is what makes reporting it worth anything.
        const outcome = mcpEvaluate()('ui.registerMenuItem("cheat", function () {}); return "through";');

        assert.equal(outcome.ok, true, "the stand-in must be a real hole, or this proves nothing");
        assert.deepEqual(world.uiCalls, ["registerMenuItem"]);
    } finally {
        Object.defineProperty = realDefineProperty;
        world.restore();
    }
});

/* ------------------------------------------------------------------ *
 * The two ways a script could still have handed the game a function
 * ------------------------------------------------------------------ */

test("a script cannot register a game action of its own", function () {
    const world = installWorld();

    try {
        const error = expectMcpRefusal(mcpEvaluate(),
            'context.registerAction("freeplaycheat", function () { return {}; }, function () { park.cash = 9e6; return {}; })');

        assert.match(error, /cannot be called from an evaluated script/, error);
        assert.match(error, /on a later tick/, "the execute function is run by the game, not by the script: " + error);
        assert.match(error, /catches an invented one/,
            "and registering a name is also how the unknown-name check would be got round: " + error);
        assert.deepEqual(world.executed, []);
    } finally {
        world.restore();
    }
});

test("a callback a script hands to an action runs under the same guards the script did", function () {
    const world = installWorld();

    try {
        // The game applies an action on a later tick and calls back then, by which point
        // evaluate has answered - so without this the script's own code would get a tick
        // with subscribe, the timers and ui all open to it.
        const evaluate = mcpEvaluate();
        let refusal = "";

        world.deferCallbacks(function (deferred) {
            const outcome = evaluate(`
                context.executeAction("ridesetstatus", { ride: 0, status: 1 }, function () {
                    try {
                        context.subscribe("ride.ratings.calculate", function (e) { e.excitement = 999; });
                    } catch (error) {
                        globalThis.__freeplayCallbackRefusal = String(error.message);
                    }
                });
                return "queued";
            `);

            assert.equal(outcome.ok, true, JSON.stringify(outcome));
            assert.deepEqual(world.subscribed, [], "nothing has run yet: the game has not applied the action");

            // The tick the game applies it on, which is after evaluate has already answered.
            deferred();
            refusal = String((globalThis as unknown as Record<string, unknown>).__freeplayCallbackRefusal);
        });

        assert.match(refusal, /cannot be called from an evaluated script/,
            "the callback is the script's own code, so it keeps the script's rules: " + refusal);
        assert.deepEqual(world.subscribed, [],
            "a subscriber left here would rewrite ride ratings on every recalculation");
    } finally {
        delete (globalThis as unknown as Record<string, unknown>).__freeplayCallbackRefusal;
        world.restore();
    }
});

/* ------------------------------------------------------------------ *
 * Part 4 - when the guards go in, and who can find out
 * ------------------------------------------------------------------ */

interface V1Index {
    buildId: string;
    controllers: { name: string; path: string; methods: string[] }[];
    stateGuards: { ok: boolean; frozen: number; unfrozen: string[] };
}

function getV1(app: ReturnType<typeof createApplication>): V1Index {
    return JSON.parse(app.handleRawRequest("GET /v1 HTTP/1.1\r\n\r\n").getBody()) as V1Index;
}

test("the guards are in place before any script has run", function () {
    const world = installWorld();

    try {
        // Deliberately not through runScript: the question is whether an evaluate is
        // needed to close the levers, so nothing may be evaluated before the assertion.
        createApplication();

        const scope = globalThis as unknown as { park: Record<string, unknown> };

        assert.throws(function () { scope.park.cash = 800000; }, /cannot be assigned/,
            "starting the plugin must be enough; the first evaluate is too late");
        assert.equal(world.park.cash, 100000, "and the figure behind it must not have moved");
        assert.ok(stateGuardSummary().frozen > 0, "the report must be answerable at startup too");
    } finally {
        world.restore();
    }
});

test("GET /v1 carries the build id and a machine-readable guard state", function () {
    const world = installWorld();

    try {
        const index = getV1(createApplication());

        assert.equal(index.buildId, BUILD_ID, "the build id must survive the new field");
        assert.ok(index.controllers.length > 0, "and so must the controller list");

        assert.equal(index.stateGuards.ok, true, "every lever froze in this world");
        assert.ok(index.stateGuards.frozen > 0, "and the count says the guards really ran");
        assert.deepEqual(index.stateGuards.unfrozen, [], "with nothing left open");
    } finally {
        world.restore();
    }
});

test("GET /v1 names the lever that would not freeze rather than reporting ok", function () {
    // `cash` is non-configurable here, so the guard cannot be installed over it - the
    // stand-in for a plugin API that has moved under this build.
    const world = installWorld({ stubborn: ["cash"] });

    try {
        const index = getV1(createApplication());

        assert.equal(index.stateGuards.ok, false, "one refusal is enough to fail the check");
        assert.ok(index.stateGuards.unfrozen.indexOf("park.cash") >= 0,
            "and it must be named, not just counted: " + JSON.stringify(index.stateGuards.unfrozen));

        // The whole point of the field: an assignment really does land on this one, so a
        // pre-run check reading `ok` learns something a log line would have buried.
        const scope = globalThis as unknown as { park: Record<string, unknown> };

        scope.park.cash = 800000;
        assert.equal(world.park.cash, 800000, "the stand-in must be a real hole, or this proves nothing");
    } finally {
        world.restore();
    }
});

test("an empty report is not a clean one", function () {
    // Nothing installed, nothing refused: the shape a build whose guards never ran would
    // serve. `ok` has to be false there or the preflight passes on no evidence at all.
    const summary = stateGuardSummary();

    assert.equal(summary.ok, summary.frozen > 0 && summary.unfrozen.length === 0,
        "ok must mean installed and complete, never merely 'nothing complained'");
});
