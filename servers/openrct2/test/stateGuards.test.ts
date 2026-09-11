import assert from "node:assert/strict";
import test from "node:test";

import { createApplication } from "../src/app.ts";
import { BUILD_ID } from "../src/buildInfo.ts";
import { runScript, stateGuardSummary } from "../src/scripting.ts";

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
    timers: {
        setTimeout(callback: () => void, delay?: number): number;
        clearTimeout(handle: number): void;
    };
    addRide(): RideInstance;
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
                callback({ error: 0 });
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

    const previous = {
        park: scope.park, scenario: scope.scenario, cheats: scope.cheats,
        map: scope.map, context: scope.context
    };

    scope.park = Object.create(parkPrototype);
    scope.scenario = Object.create(scenarioPrototype);
    scope.cheats = Object.create(cheatPrototype);
    scope.map = fakeMap;
    scope.context = fakeContext;

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
        timers: scope.context as unknown as World["timers"],
        addRide: function () {
            const ride = makeRide(rides.length);
            rides.push(ride);
            return ride;
        },
        restore: function () {
            scope.park = previous.park;
            scope.scenario = previous.scenario;
            scope.cheats = previous.cheats;
            scope.map = previous.map;
            scope.context = previous.context;
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

test("the cheat and scenario-editor actions are refused by name and never reach the game", function () {
    const world = installWorld();

    try {
        const cheat = expectRefusal('context.executeAction("cheatset", { type: 16, param1: 1000000, param2: 0 })');
        assert.match(cheat, /cheatset is not available in this run/, cheat);
        assert.match(cheat, /come out of running the park/, "a refused action must name the alternative too: " + cheat);

        assert.match(expectRefusal('context.executeAction("scenariosetsetting", { setting: 1, value: 1 })'), /scenariosetsetting/);
        assert.match(expectRefusal('context.executeAction("parksetdate", { year: 1, month: 1, day: 1 })'), /parksetdate/);
        assert.match(expectRefusal('context.executeAction("ridefreezerating", { ride: 0 })'), /ridefreezerating/);

        // A query changes nothing, but probing for a cheat is not play either.
        assert.match(expectRefusal('context.queryAction("cheatset", { type: 16, param1: 1, param2: 0 })'), /cheatset/);

        assert.deepEqual(world.executed, [], "no refused action may reach the game");
        assert.deepEqual(world.queried, []);

        const legitimate = run('context.executeAction("ridesetstatus", { ride: 0, status: 1 }); return "ok";');

        assert.equal(legitimate.ok, true, "an ordinary action still goes through: " + JSON.stringify(legitimate));
        assert.deepEqual(world.executed, ["ridesetstatus"]);
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

test("a script cannot schedule or subscribe to anything, and nothing reaches the game", function () {
    const world = installWorld();

    try {
        [
            'context.setTimeout(function () { park.cash = 9e6; }, 10)',
            'context.setInterval(function () { park.cash = 9e6; }, 10)',
            "context.clearTimeout(1)",
            "context.clearInterval(1)",
            'context.subscribe("ride.ratings.calculate", function (e) { e.excitement = 999; })'
        ].forEach(function (code) {
            const error = expectRefusal(code);

            assert.match(error, /cannot be called from an evaluated script/, code + " -> " + error);
            assert.match(error, /come out of running the park/, "and it closes the way the others do: " + error);
        });

        assert.deepEqual(world.scheduled, [], "no callback may reach the game's timers");
        assert.deepEqual(world.subscribed, [], "no hook may be left behind after the script has answered");
    } finally {
        world.restore();
    }
});

test("the refusals say why a script has no use for either", function () {
    const world = installWorld();

    try {
        const timer = expectRefusal("context.setTimeout(function () {}, 10)");
        assert.match(timer, /answers the moment it/, "the reason is that the model is already gone: " + timer);
        assert.match(timer, /typed tool/, "and the alternative is the tools that do span ticks: " + timer);

        const hook = expectRefusal('context.subscribe("interval.tick", function () {})');
        assert.match(hook, /fires on a later tick/, hook);
        // The point of naming this one: it would undo the ride ratings guard outright.
        assert.match(hook, /ride\.ratings\.calculate/, "the message must name what a hook can overwrite: " + hook);

        const cancel = expectRefusal("context.clearTimeout(1)");
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
