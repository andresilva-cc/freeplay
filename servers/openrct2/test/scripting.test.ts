import assert from "node:assert/strict";
import test from "node:test";

import { runScript, sanitizeToolResult, sanitizeValue } from "../src/scripting.ts";

interface Success {
    ok: true;
    result: unknown;
    truncated?: boolean;
}

function expectOk(code: string): Success {
    const outcome = runScript(code);
    assert.equal(outcome.ok, true, "expected success, got: " + JSON.stringify(outcome));
    return outcome as Success;
}

function expectError(code: string): string {
    const outcome = runScript(code);
    assert.equal(outcome.ok, false, "expected failure, got: " + JSON.stringify(outcome));
    return (outcome as { ok: false; error: string }).error;
}

test("runScript evaluates a bare expression", function () {
    assert.equal(expectOk("1 + 1").result, 2);
});

test("runScript tolerates a trailing semicolon on an expression", function () {
    assert.equal(expectOk("1 + 1;").result, 2);
});

test("runScript strips a markdown code fence", function () {
    assert.equal(expectOk("```javascript\n2 * 21\n```").result, 42);
});

test("runScript runs a statement body that returns", function () {
    assert.equal(expectOk("var a = 2;\nvar b = 3;\nreturn a * b;").result, 6);
});

test("runScript reports a syntax error instead of throwing", function () {
    assert.match(expectError("function ("), /SyntaxError/);
});

test("runScript reports a thrown error with its message", function () {
    assert.match(expectError("throw new Error('park is closed')"), /park is closed/);
});

test("runScript rejects an empty script", function () {
    assert.match(expectError("   "), /Empty script/);
});

test("runScript executes a failing mutation exactly once", function () {
    const scope = globalThis as unknown as Record<string, unknown>;
    scope.__freeplayCalls = 0;

    expectError("globalThis.__freeplayCalls++; throw new Error('action rejected');");

    assert.equal(scope.__freeplayCalls, 1);
    delete scope.__freeplayCalls;
});

test("runScript serialises values behind prototype getters", function () {
    const outcome = expectOk(`
        var Ride = function () {};
        Object.defineProperty(Ride.prototype, "name", { get: function () { return "Wooden Coaster"; } });
        Object.defineProperty(Ride.prototype, "excitement", { get: function () { return 7.12; } });
        return new Ride();
    `);

    assert.deepEqual(outcome.result, { name: "Wooden Coaster", excitement: 7.12 });
});

test("runScript survives a getter that throws", function () {
    const outcome = expectOk(`
        var obj = {};
        Object.defineProperty(obj, "dead", { enumerable: true, get: function () { throw new Error("entity gone"); } });
        return obj;
    `);

    assert.match(String((outcome.result as Record<string, unknown>).dead), /unreadable: .*entity gone/);
});

test("runScript replaces circular references", function () {
    const outcome = expectOk("var a = {}; a.self = a; return a;");
    assert.deepEqual(outcome.result, { self: "<circular>" });
});

test("runScript drops functions from results", function () {
    const outcome = expectOk("return { keep: 1, drop: function () {} };");
    assert.deepEqual(outcome.result, { keep: 1 });
});

test("runScript caps long arrays and says how many were omitted", function () {
    const outcome = expectOk("var out = []; for (var i = 0; i < 100; i++) { out.push(i); } return out;");
    const items = outcome.result as unknown[];

    assert.equal(items.length, 41);
    assert.equal(items[40], "<60 more of 100 omitted>");
});

test("runScript truncates a result that would flood the context", function () {
    const outcome = expectOk("var out = []; for (var i = 0; i < 40; i++) { out.push(new Array(600).join('x')); } return out;");

    assert.equal(outcome.truncated, true);
    assert.match(String(outcome.result), /narrow the script/);
});

test("runScript returns null for undefined so the result is always JSON", function () {
    assert.equal(expectOk("undefined").result, null);
});

test("a tool's nested result keeps the depth the tool promised", function () {
    // An AccessOption sits at depth 4 - the result, sites, a site, access, the option
    // itself - which is exactly where evaluate's depth limit cuts. Every door in
    // find_build_sites came back as "<object depth limit>", so the model saw no valid
    // entrance position at all and invented coordinates instead.
    const result = sanitizeToolResult({
        ok: true,
        sites: [
            {
                x: 10,
                y: 12,
                access: [
                    { x: 9, y: 12, side: "-x", door: { x: 8, y: 12, isExistingPath: false } }
                ]
            }
        ]
    }) as { sites: { access: { door: { x: unknown; y: unknown } }[] }[] };

    const option = result.sites[0].access[0];
    assert.equal(typeof option, "object", "an access option must stay an object, not become: " + JSON.stringify(option));

    assert.equal(typeof option.door.x, "number", "the door's x must still be a number, got: " + JSON.stringify(option.door));
    assert.equal(typeof option.door.y, "number", "the door's y must still be a number, got: " + JSON.stringify(option.door));
});

test("a tool's own list is never trimmed a second time", function () {
    const sites: { x: number; y: number }[] = [];

    for (let i = 0; i < 60; i++) {
        sites.push({ x: i, y: 0 });
    }

    const result = sanitizeToolResult({ ok: true, sites: sites, totalFound: 60 }) as { sites: unknown[] };
    const serialized = JSON.stringify(result);

    assert.equal(result.sites.length, 60, "the tool already chose how many rows to return, so all 60 must survive");
    assert.equal(serialized.indexOf("more of"), -1,
        "a tool's result must carry no omission marker, or its own count contradicts its own list: " + serialized.substring(0, 200));
});

test("evaluate still caps depth and array length", function () {
    // The counterpart to the two above: a tool's result gets its own, looser limits.
    // Loosening evaluate's instead would let one careless script flood the context.
    const deep = sanitizeValue({ a: { b: { c: { d: { e: 1 } } } } }) as { a: { b: { c: { d: unknown } } } };
    assert.equal(deep.a.b.c.d, "<object depth limit>", "evaluate must still stop descending");

    const long: number[] = [];

    for (let i = 0; i < 100; i++) {
        long.push(i);
    }

    const capped = sanitizeValue(long) as unknown[];

    assert.equal(capped.length, 41, "evaluate must still cut a long array down to its cap plus a marker");
    assert.match(String(capped[40]), /more of 100 omitted/, "and say how many it dropped");
});

/**
 * A stand-in for the `context` global, small enough to keep the sandbox's own behaviour in
 * view. test/fakeGame.ts is not used here on purpose: these tests are about what happens
 * before an action reaches the game at all, including one that the game has never heard of.
 */
interface FakeContextCalls {
    queried: string[];
    executed: string[];
    registered: string[];
}

interface FakeContextOptions {
    /** What the fake hands to a queryAction callback, synchronously. */
    queryResult?: unknown;
    /** Put the methods on a prototype rather than on the object itself. */
    onPrototype?: boolean;
}

function installFakeContext(options?: FakeContextOptions): { calls: FakeContextCalls; restore(): void } {
    const scope = globalThis as unknown as Record<string, unknown>;
    const previous = scope.context;
    const calls: FakeContextCalls = { queried: [], executed: [], registered: [] };

    const methods = {
        queryAction: function (name: string, _args: object, callback?: (result: unknown) => void): void {
            calls.queried.push(name);

            if (typeof callback === "function") {
                callback(options && "queryResult" in options ? options.queryResult : { error: 0 });
            }
        },
        executeAction: function (name: string, _args: object, callback?: (result: unknown) => void): void {
            calls.executed.push(name);

            if (typeof callback === "function") {
                callback({ error: 0 });
            }
        },
        registerAction: function (name: string): void {
            calls.registered.push(name);
        }
    };

    if (options && options.onPrototype) {
        const FakeContext = function () { /* the game's own objects are built this way */ };
        FakeContext.prototype = methods;
        scope.context = new (FakeContext as unknown as { new (): object })();
    } else {
        scope.context = { ...methods };
    }

    return {
        calls: calls,
        restore: function () { scope.context = previous; }
    };
}

test("an action name the game does not know fails instead of answering null", function () {
    const fake = installFakeContext();

    try {
        const error = expectError('context.queryAction("set_ride_status", { ride: 0, status: 1 })');

        assert.match(error, /set_ride_status/, "the error must name the action that does not exist: " + error);
        assert.match(error, /ridesetstatus/, "and point at the real one: " + error);
        assert.deepEqual(fake.calls.queried, [],
            "the unknown name must never reach the game, which would answer it with a cheerful null");
    } finally {
        fake.restore();
    }
});

test("executeAction refuses an unknown action name too", function () {
    const fake = installFakeContext();

    try {
        const error = expectError('context.executeAction("ride_demolish", { ride: 1 })');

        assert.match(error, /ride_demolish/);
        assert.match(error, /ridedemolish/, "the suggestion is the point: " + error);
        assert.deepEqual(fake.calls.executed, []);
    } finally {
        fake.restore();
    }
});

test("a real action name still goes straight through", function () {
    const fake = installFakeContext();

    try {
        expectOk('context.executeAction("ridesetstatus", { ride: 0, status: 1 }); return "done";');
        assert.deepEqual(fake.calls.executed, ["ridesetstatus"]);
    } finally {
        fake.restore();
    }
});

test("queryAction hands back the game's answer rather than nothing", function () {
    // queryAction returns void and reports through a callback, so a script that did not
    // pass one read every query - refusals included - as { ok: true, result: null }.
    const fake = installFakeContext({ queryResult: { error: 1, errorMessage: "Dodgems 1 in the way" } });

    try {
        const outcome = expectOk('context.queryAction("trackplace", { ride: 0 })');

        assert.deepEqual(outcome.result, { error: 1, errorMessage: "Dodgems 1 in the way" });
    } finally {
        fake.restore();
    }
});

test("a script cannot put the unguarded action back, and cannot leave its own in the slot", function () {
    const fake = installFakeContext();

    try {
        // The slot is writable on purpose: a non-writable one cannot be taken back off the
        // wrapper a previous load of the plugin left in it, which is how the refusal list
        // came to be installed and never consulted. So the script's assignment does land -
        // on a function of its own, which reaches nothing. The guard is what stands between
        // the script and the game, and the raw invoker exists only inside its closure.
        const outcome = expectOk(`
            context.queryAction = function () { return "bypassed"; };
            delete context.queryAction;
            return context.queryAction("set_ride_status", {});
        `);

        assert.equal(outcome.result, "bypassed", "the script talked to itself, which is all it can do");
        assert.deepEqual(fake.calls.queried, [], "and nothing reached the game");

        // The stub must not outlive the script: every typed tool calls this slot.
        const error = expectError('context.queryAction("set_ride_status", {})');

        assert.match(error, /no game action named/, "the next evaluate must put the guard back: " + error);
        assert.deepEqual(fake.calls.queried, []);
    } finally {
        fake.restore();
    }
});

test("the guard is installed where the method lives, so the prototype is not a way round it", function () {
    const fake = installFakeContext({ onPrototype: true });

    try {
        const error = expectError(`
            var raw = Object.getPrototypeOf(context).queryAction;
            return raw.call(context, "set_ride_status", {});
        `);

        assert.match(error, /no game action named/, "the prototype must hold the guard too: " + error);
        assert.deepEqual(fake.calls.queried, []);
    } finally {
        fake.restore();
    }
});

test("an action a plugin registers at runtime counts as known", function () {
    const fake = installFakeContext();

    try {
        // Registered the way a plugin registers one - outside any script, where the guard
        // stands aside. Inside a script it is refused, because the game runs a custom
        // action's execute function on a later tick.
        expectOk("1 + 1");

        const scope = globalThis as unknown as { context: Record<string, unknown> };
        const register = scope.context.registerAction as (name: string, query: () => void, execute: () => void) => void;

        register.call(scope.context, "freeplaycustom", function () { /* query */ }, function () { /* execute */ });

        expectOk('context.queryAction("freeplaycustom", {})');

        assert.deepEqual(fake.calls.registered, ["freeplaycustom"]);
        assert.deepEqual(fake.calls.queried, ["freeplaycustom"]);
    } finally {
        fake.restore();
    }
});

test("a script cannot register a game action for the game to run later", function () {
    const fake = installFakeContext();

    try {
        const error = expectError('context.registerAction("freeplaycheat", function () {}, function () {})');

        assert.match(error, /cannot be called from an evaluated script/, error);
        assert.match(error, /on a later tick/, "the execute function is the game's to run, not the script's: " + error);
        assert.deepEqual(fake.calls.registered, [], "and nothing may reach the game's registry");

        // The name must not have been let into the known-action set on the way past either.
        assert.match(expectError('context.queryAction("freeplaycheat", {})'), /no game action named/);
        assert.deepEqual(fake.calls.queried, []);
    } finally {
        fake.restore();
    }
});

test("keys() lists what a game object really has, where Object.keys sees nothing", function () {
    const outcome = expectOk(`
        var Map = function () {};
        Object.defineProperty(Map.prototype, "rides", { get: function () { return []; } });
        Map.prototype.getTile = function () { return null; };
        var map = new Map();
        return { own: Object.keys(map), real: keys(map) };
    `);

    const result = outcome.result as { own: string[]; real: string[] };

    assert.deepEqual(result.own, [], "this is the dead end: a game object owns no enumerable keys");
    assert.deepEqual(result.real, ["getTile", "rides"], "keys() must see the prototype getters and methods");
});

test("a property that is not there is not reported as null", function () {
    // map.getTile(x, y) has no `type`; the data is under elements[]. Reading it back as
    // null convinced one run the terrain did not exist, and it spent twelve turns on that.
    const outcome = expectOk("return { type: undefined, rideIndex: null };");

    assert.deepEqual(outcome.result, { type: "<undefined>", rideIndex: null });
});

test("a missing array item is marked too", function () {
    assert.deepEqual(expectOk("return [1, undefined, null];").result, [1, "<undefined>", null]);
});

test("a tool's own result still renders an absent optional field as null", function () {
    // A tool composes its result deliberately, so an optional field it left out means
    // nothing and must not read as an error marker.
    assert.deepEqual(sanitizeToolResult({ ok: true, name: undefined }), { ok: true, name: null });
});

test("a function is rendered as one wherever it turns up, not only as a property", function () {
    // "drops functions from results" covers a function held as an object property, which
    // sanitize handles in a different branch - it skips the key outright. A function
    // returned on its own, or sitting in an array, goes down the type branch instead and
    // nothing was watching it: a script that returned one rendered as its own source.
    assert.equal(expectOk("(function(){})").result, "<function>");
    assert.deepEqual(expectOk("[function(){}]").result, ["<function>"]);
});
