import assert from "node:assert/strict";
import test from "node:test";

import { runScript } from "../src/scripting.ts";

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
