import assert from "node:assert/strict";
import test from "node:test";

import { installActionGuards } from "../src/scripting.ts";
import { openPark, OpenParkTools } from "../src/tools/openPark.ts";
import type { OpenParkOutcome, OpenParkRequest } from "../src/tools/openPark.ts";
import { getMcpToolDefinitions } from "../src/tools/decorators.ts";
import { getMcpTools } from "../src/tools/index.ts";
import type { DeferredMcpResult } from "../src/tools/types.ts";

/**
 * A stand-in for the park half of the OpenRCT2 globals.
 *
 * test/fakeGame.ts models neither `parksetparameter` nor `parksetentrancefee` and throws on
 * an action it does not know, which is deliberate, so this file brings its own. It keeps the
 * one property that matters: an action does not take effect until a later tick, so anything
 * that acts and reads in the same breath sees the old world. Construct it with
 * `{ inert: true }` and actions are accepted and never applied; with `{ frozen: true }` the
 * plugin API's own setters do nothing either, which is how a tool gets caught reporting
 * what it attempted rather than what happened.
 */
interface FakeParkOptions {
    open?: boolean;
    entranceFee?: number;
    flags?: Record<string, boolean>;
    inert?: boolean;
    frozen?: boolean;
}

interface AttemptedAction {
    name: string;
    args: Record<string, unknown>;
}

class FakePark {
    public readonly flags: Record<string, boolean>;
    public entranceFee: number;
    public readonly attempted: AttemptedAction[] = [];
    public readonly inert: boolean;
    public readonly frozen: boolean;

    public readonly pending: AttemptedAction[] = [];

    public constructor(options?: FakeParkOptions) {
        const settings = options || {};

        this.flags = { open: settings.open === true };
        this.entranceFee = typeof settings.entranceFee === "number" ? settings.entranceFee : 0;
        this.inert = settings.inert === true;
        this.frozen = settings.frozen === true;

        const extra = settings.flags || {};

        for (const key in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, key)) {
                this.flags[key] = extra[key];
            }
        }
    }

    public namesAttempted(): string[] {
        return this.attempted.map(function (action) { return action.name; });
    }

    public argsFor(name: string): Record<string, unknown> | undefined {
        const found = this.attempted.filter(function (action) { return action.name === name; });
        return found.length > 0 ? found[0].args : undefined;
    }

    public install(): () => void {
        return installParkGlobals(this);
    }

    public applyPending(): void {
        while (this.pending.length > 0) {
            const action = this.pending.shift() as AttemptedAction;

            if (action.name === "parksetparameter") {
                const parameter = action.args.parameter;

                if (parameter === 0 || parameter === 1) {
                    this.flags.open = parameter === 1;
                }

                continue;
            }

            if (action.name === "parksetentrancefee") {
                // A scenario with free park entry accepts the action and charges nothing,
                // which is the shape of refusal this tool has to report honestly.
                if (!this.flags.freeParkEntry) {
                    this.entranceFee = action.args.value as number;
                }

                continue;
            }

            throw new Error("the fake park does not apply the \"" + action.name + "\" action");
        }
    }
}

function installParkGlobals(game: FakePark): () => void {
    const scope = globalThis as unknown as Record<string, unknown>;
    const previous = { context: scope.context, park: scope.park };

    scope.context = {
        executeAction: function (name: string, args: Record<string, unknown>, callback?: (r: unknown) => void): void {
            const action = { name: name, args: args };
            game.attempted.push(action);

            if (!game.inert) {
                game.pending.push(action);
            }

            if (typeof callback === "function") {
                callback({ error: 0 });
            }
        },
        queryAction: function () { /* nothing here queries */ },
        setTimeout: function (callback: () => void): number {
            game.applyPending();
            callback();
            return 0;
        }
    };

    scope.park = {
        getFlag: function (flag: string) { return game.flags[flag] === true; },
        setFlag: function (flag: string, value: boolean) {
            if (!game.frozen) {
                game.flags[flag] = value;
            }
        },
        get entranceFee() { return game.entranceFee; },
        set entranceFee(value: number) {
            if (!game.frozen && !game.flags.freeParkEntry) {
                game.entranceFee = value;
            }
        }
    };

    return function () {
        scope.context = previous.context;
        scope.park = previous.park;
    };
}

function run(game: FakePark, request: OpenParkRequest): OpenParkOutcome {
    const restore = game.install();

    try {
        let outcome: OpenParkOutcome | undefined;

        openPark(request, function (value) { outcome = value; });

        assert.notEqual(typeof outcome, "undefined", "open_park must answer within the ticks it schedules");
        return outcome as OpenParkOutcome;
    } finally {
        restore();
    }
}

test("open_park opens the park and reports the state it read back", function () {
    const game = new FakePark();
    const outcome = run(game, { open: true });

    assert.equal(outcome.ok, true, outcome.detail);
    assert.equal(outcome.parkOpen, true);
    assert.equal(game.flags.open, true, "the park itself must actually be open");
    assert.match(outcome.detail, /open/);
});

test("open_park opens the park through the game's own action", function () {
    const game = new FakePark();
    run(game, { open: true });

    assert.deepEqual(game.namesAttempted(), ["parksetparameter"]);
    assert.equal((game.argsFor("parksetparameter") as Record<string, unknown>).parameter, 1,
        "1 opens the park and 0 closes it, which is the whole reason this is not hand-written");
});

test("open_park closes the park again", function () {
    const game = new FakePark({ open: true });
    const outcome = run(game, { open: false });

    assert.equal(outcome.ok, true, outcome.detail);
    assert.equal(outcome.parkOpen, false);
    assert.equal((game.argsFor("parksetparameter") as Record<string, unknown>).parameter, 0);
});

test("open_park sets the entrance fee and reports the fee it read back", function () {
    const game = new FakePark();
    const outcome = run(game, { entranceFee: 20 });

    assert.equal(outcome.ok, true, outcome.detail);
    assert.equal(outcome.entranceFee, 20);
    assert.equal(game.entranceFee, 20);
    assert.deepEqual(game.namesAttempted(), ["parksetentrancefee"]);
});

test("open_park does both in one call", function () {
    const game = new FakePark();
    const outcome = run(game, { open: true, entranceFee: 15 });

    assert.equal(outcome.ok, true, outcome.detail);
    assert.equal(outcome.parkOpen, true);
    assert.equal(outcome.entranceFee, 15);
});

test("setting a fee never opens the park as a side effect", function () {
    // When to open the park is the player's call. A tool that opens it while doing
    // something else has made that call for them.
    const game = new FakePark({ open: false });
    const outcome = run(game, { entranceFee: 25 });

    assert.equal(game.flags.open, false, "the park must still be closed");
    assert.equal(outcome.parkOpen, false);
    assert.deepEqual(game.namesAttempted(), ["parksetentrancefee"]);
});

test("opening the park never changes the fee as a side effect", function () {
    const game = new FakePark({ entranceFee: 30 });
    const outcome = run(game, { open: true });

    assert.equal(game.entranceFee, 30, "the price of admission is the player's decision, not this tool's");
    assert.equal(outcome.entranceFee, 30);
    assert.deepEqual(game.namesAttempted(), ["parksetparameter"]);
});

test("open_park never advises when to open the park", function () {
    const game = new FakePark();
    const outcome = run(game, { open: true });

    assert.equal(/should|worth|ready|recommend|first|before you/i.test(outcome.detail), false,
        "the detail must state what the park is doing, not what to do about it: " + outcome.detail);
});

test("an action that silently does nothing is caught by the plugin API", function () {
    // The action is accepted and never applied, which is the failure this whole project is
    // built around. The tool falls back to the plugin API's own setter - the route every
    // run took by hand - and still verifies by reading the world back.
    const game = new FakePark({ inert: true });
    const outcome = run(game, { open: true });

    assert.equal(outcome.ok, true, outcome.detail);
    assert.equal(outcome.parkOpen, true);
    assert.equal(game.flags.open, true);
    assert.deepEqual(game.namesAttempted(), ["parksetparameter"], "the game action is still tried first");
});

test("a park that will not open is reported as closed, not as opened", function () {
    const game = new FakePark({ inert: true, frozen: true });
    const outcome = run(game, { open: true });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.parkOpen, false);
    assert.match(outcome.detail, /still closed/, outcome.detail);
    assert.equal(/is open\b/.test(outcome.detail), false,
        "reporting the attempt as the outcome is the bug this tool exists to avoid: " + outcome.detail);
});

test("a fee the scenario refuses is reported with the reason the game actually gives", function () {
    const game = new FakePark({ flags: { freeParkEntry: true } });
    const outcome = run(game, { entranceFee: 20 });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.entranceFee, 0);
    assert.match(outcome.detail, /free park entry/, outcome.detail);
});

test("a refused fee does not invent a reason that is not there", function () {
    const game = new FakePark({ frozen: true, inert: true });
    const outcome = run(game, { entranceFee: 20 });

    assert.equal(outcome.ok, false);
    assert.equal(/free park entry|money turned off/.test(outcome.detail), false,
        "no cause is present, so none may be named: " + outcome.detail);
});

test("open_park with nothing to do changes nothing and says so", function () {
    const game = new FakePark();
    const outcome = run(game, {});

    assert.equal(outcome.ok, false);
    assert.deepEqual(game.namesAttempted(), [], "no arguments must mean no actions");
    assert.match(outcome.detail, /Nothing to do/);
});

test("open_park refuses a fee outside the range without touching the game", function () {
    // The MCP layer enforces the schema bound first, so this only fires on a direct call -
    // but a fee sent in currency units rather than tenths is the mistake worth naming.
    const negative = new FakePark({ entranceFee: 10 });
    const refusedLow = run(negative, { entranceFee: -5 });

    assert.equal(refusedLow.ok, false);
    assert.equal(negative.entranceFee, 10);
    assert.deepEqual(negative.namesAttempted(), []);

    const huge = new FakePark({ entranceFee: 10 });
    const refusedHigh = run(huge, { entranceFee: 50000 });

    assert.equal(refusedHigh.ok, false);
    assert.match(refusedHigh.detail, /tenths/);
    assert.deepEqual(huge.namesAttempted(), []);
});

test("open_park declares the fee bounds the MCP layer enforces", function () {
    const schema = getMcpToolDefinitions(OpenParkTools)[0].inputSchema;
    const fee = (schema.properties as Record<string, Record<string, unknown>>).entranceFee;

    assert.equal(fee.minimum, 0);
    assert.equal(fee.maximum, 2000, "2000 tenths is 200.00, the same ceiling as a ride ticket");
});

test("the action names open_park uses survive the evaluate sandbox's action guard", function () {
    // The guard rejects action names the game does not know. A tool's own names getting
    // caught by it would be a silent regression, so it is checked rather than assumed.
    const game = new FakePark();
    const restore = game.install();

    try {
        installActionGuards();

        let outcome: OpenParkOutcome | undefined;
        openPark({ open: true, entranceFee: 12 }, function (value) { outcome = value; });

        assert.equal((outcome as OpenParkOutcome).ok, true, (outcome as OpenParkOutcome).detail);
        assert.deepEqual(game.namesAttempted().sort(), ["parksetentrancefee", "parksetparameter"]);
    } finally {
        restore();
    }
});

test("open_park is registered as a deferred tool called open_park", function () {
    const definitions = getMcpToolDefinitions(OpenParkTools);

    assert.equal(definitions.length, 1);
    assert.equal(definitions[0].name, "open_park");
    assert.equal(definitions[0].inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(definitions[0].inputSchema.properties || {}).sort(), ["entranceFee", "open"]);
    assert.equal(typeof definitions[0].inputSchema.required, "undefined",
        "neither argument is required: forcing `open` would make a fee change decide when the park opens");

    const registered = getMcpTools().filter(function (tool) { return tool.name === "open_park"; });
    assert.equal(registered.length, 1, "the tool has to be in the registry or the model never sees it");
});

test("the tool handler defers, floors the fee and reports the world afterwards", function () {
    const game = new FakePark();
    const restore = game.install();

    try {
        const controller = new OpenParkTools();
        const deferred = controller.openPark({ open: true, entranceFee: 20.7 }) as DeferredMcpResult;

        assert.equal(deferred.deferred, true, "the park changes on a later tick, so the tool has to wait for it");

        let outcome: OpenParkOutcome | undefined;
        deferred.start(function (value) { outcome = value as OpenParkOutcome; });

        assert.equal((outcome as OpenParkOutcome).ok, true);
        assert.equal((outcome as OpenParkOutcome).entranceFee, 20);
        assert.equal((outcome as OpenParkOutcome).parkOpen, true);
    } finally {
        restore();
    }
});

test("a non-boolean open and a non-numeric fee are ignored rather than guessed at", function () {
    const game = new FakePark();
    const restore = game.install();

    try {
        const controller = new OpenParkTools();
        const deferred = controller.openPark({ open: "yes", entranceFee: "free" }) as DeferredMcpResult;

        let outcome: OpenParkOutcome | undefined;
        deferred.start(function (value) { outcome = value as OpenParkOutcome; });

        assert.equal((outcome as OpenParkOutcome).ok, false);
        assert.deepEqual(game.namesAttempted(), []);
    } finally {
        restore();
    }
});
