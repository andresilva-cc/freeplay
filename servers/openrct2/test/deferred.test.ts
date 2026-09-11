import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import {
    FakeSocket,
    responsesOn,
    soleJsonRpcResponse,
    soleToolResult,
    utf8ByteLength
} from "./fakeSocket.ts";
import { createApplication } from "../src/app.ts";

/**
 * Every mutating tool answers through the deferred path: the MCP layer takes over the
 * connection and writes the response itself once the tool finishes, several game ticks
 * later, with a 30 second watchdog behind it. Nothing exercised it until now, so a break
 * here would have silenced build_flat_ride, build_path, clear_scenery, hire_staff and
 * operate_ride at once.
 *
 * The assertions are on the bytes that reach the client, never on internal bookkeeping:
 * the failures worth catching are a response that never arrives, arrives twice, or
 * arrives on somebody else's connection.
 */

const PROTOCOL_VERSION = "2025-11-25";
const TIMEOUT_TEXT = /did not finish in time/;

/**
 * Control over game time. The tools wait for ticks with `context.setTimeout` and the MCP
 * watchdog uses the same call with a far longer delay, so holding both queues lets a test
 * decide when a tool finishes, whether the watchdog beats it, and what happens when they
 * land in the wrong order.
 */
interface DeferredClock {
    /** Tool work waiting for a game tick. */
    readonly steps: number;
    /** Watchdogs still armed: the MCP layer's guard against a tool that never finishes. */
    readonly watchdogs: number;
    /** Timers cancelled with `context.clearTimeout`, so a leak shows up as a zero here. */
    readonly cancelled: number;
    /** False while something has the game's timer wrapped, as the deferred path does. */
    readonly timerIsTheGames: boolean;
    /**
     * Record whatever is in the `context.setTimeout` slot right now as the idle state.
     *
     * Called once, after the plugin has started. Plugin startup installs the state
     * guards, which replace that slot with a wrapper of their own that delegates to this
     * clock; `unwatchDeferredWork` restores whatever it captured, which is that wrapper
     * and not the bare clock function. So the identity that proves nothing is in flight
     * has to be read after startup. It is still an identity check: mcp.ts failing to
     * restore leaves its own wrapper in the slot and this goes false.
     */
    settle(): void;
    /** Errors that escaped a tick callback, as the game's own tick loop would see them. */
    readonly tickErrors: string[];
    /** Advance until no tool has work left, applying queued actions as the game does. */
    runSteps(): void;
    /** Let every armed watchdog fire, as if 30 seconds had passed. */
    fireWatchdogs(): void;
}

interface FakeTimer {
    handle: number;
    callback: () => void;
}

function installClock(game: FakeGame): DeferredClock {
    const scope = globalThis as unknown as {
        context: {
            setTimeout(callback: () => void, delay?: number): number;
            clearTimeout(handle: number): void;
        };
    };
    const steps: FakeTimer[] = [];
    const watchdogs: FakeTimer[] = [];
    const tickErrors: string[] = [];
    let nextHandle = 0;
    let cancelled = 0;

    // Handles are unique across both queues: a cancelled watchdog must not take a tool's
    // pending tick with it.
    scope.context.setTimeout = function (callback: () => void, delay?: number): number {
        const timer = { handle: ++nextHandle, callback: callback };

        if (typeof delay === "number" && delay > FakeGame.WATCHDOG_THRESHOLD_MS) {
            watchdogs.push(timer);
        } else {
            steps.push(timer);
        }

        return timer.handle;
    };

    let idleTimer = scope.context.setTimeout;

    scope.context.clearTimeout = function (handle: number): void {
        [steps, watchdogs].forEach(function (queue) {
            for (let i = queue.length - 1; i >= 0; i--) {
                if (queue[i].handle === handle) {
                    queue.splice(i, 1);
                    cancelled++;
                }
            }
        });
    };

    const run = function (queue: FakeTimer[]): void {
        let guard = 0;

        while (queue.length > 0) {
            if (++guard > 200) {
                throw new Error("a deferred tool kept scheduling work and never settled");
            }

            const timer = queue.shift() as FakeTimer;
            game.applyQueuedActions();

            try {
                timer.callback();
            } catch (error) {
                // The game's tick loop is what catches these, not the tool. Recorded so a
                // test can say whether the plugin threw where the player would see it.
                tickErrors.push(String(error));
            }
        }
    };

    return {
        get steps() { return steps.length; },
        get watchdogs() { return watchdogs.length; },
        get cancelled() { return cancelled; },
        get timerIsTheGames() { return scope.context.setTimeout === idleTimer; },
        settle: function () { idleTimer = scope.context.setTimeout; },
        tickErrors: tickErrors,
        runSteps: function () { run(steps); },
        fireWatchdogs: function () { run(watchdogs); }
    };
}

function rawRequest(body: string, headers: Record<string, string>): string {
    const lines = ["POST /mcp HTTP/1.1"].concat(Object.keys(headers).map(function (name) {
        return name + ": " + headers[name];
    }));

    return lines.join("\r\n") + "\r\n\r\n" + body;
}

const mcpHeaders = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json"
};

function jsonBody(response: { getBody(): string }): Record<string, unknown> {
    return JSON.parse(response.getBody()) as Record<string, unknown>;
}

/** Open an MCP session and return headers for subsequent calls. */
function openSession(app: ReturnType<typeof createApplication>): Record<string, string> {
    const response = app.handleRawRequest(rawRequest(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
            protocolVersion: PROTOCOL_VERSION, capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" }
        }
    }), mcpHeaders));

    const headers: Record<string, string> = {
        Accept: mcpHeaders.Accept,
        "Content-Type": mcpHeaders["Content-Type"],
        "MCP-Session-Id": String(response.getHeader("mcp-session-id")),
        "MCP-Protocol-Version": PROTOCOL_VERSION
    };

    app.handleRawRequest(rawRequest(JSON.stringify({
        jsonrpc: "2.0", method: "notifications/initialized"
    }), headers));

    return headers;
}

/**
 * Call a tool over a socket exactly the way the plugin's connection handler does,
 * including its rule that a hijacked connection answers itself.
 */
function callTool(
    app: ReturnType<typeof createApplication>,
    headers: Record<string, string>,
    socket: FakeSocket,
    id: string | number,
    name: string,
    args: Record<string, unknown>
): { hijacked: boolean } {
    const result = app.handleSocketRequest(rawRequest(JSON.stringify({
        jsonrpc: "2.0", id: id, method: "tools/call",
        params: { name: name, arguments: args }
    }), headers), socket);

    if (!result.context.connection.hijacked) {
        socket.end(result.response.toHttpString());
    }

    return { hijacked: result.context.connection.hijacked };
}

function withPark(run: (
    app: ReturnType<typeof createApplication>,
    game: FakeGame,
    clock: DeferredClock
) => void): void {
    const game = new FakeGame(32, 32);
    game.rideObjects = [{ index: 0, name: "Merry-Go-Round", rideType: [33] }];
    game.addParkEntrance(10, 2);

    for (let y = 3; y <= 20; y++) {
        game.addPath(10, y);
    }

    const restore = game.install();
    const clock = installClock(game);

    try {
        const app = createApplication();

        // Startup guards the timer slot, so the idle baseline is read after it, not before.
        clock.settle();
        run(app, game, clock);
    } finally {
        restore();
    }
}

/** Replace the map with one that fails, standing in for the game going away mid-call. */
function breakTheMap(): void {
    const scope = globalThis as unknown as { map: { getTile: unknown } };
    scope.map.getTile = function (): never {
        throw new Error("the map is gone");
    };
}

test("a deferred tool answers over the hijacked connection", function () {
    withPark(function (app, game, clock) {
        const headers = openSession(app);
        const socket = new FakeSocket();

        const call = callTool(app, headers, socket, 2, "clear_scenery", { x: 14, y: 10, size: 3 });

        assert.equal(call.hijacked, true, "the tool must take over the connection");
        assert.equal(socket.written, "", "and answer only once the work is done");

        clock.runSteps();

        assert.ok(socket.written.length > 0, "the answer must reach the client");
        assert.equal(socket.ended, true);

        const result = soleToolResult(socket, 2);
        const structured = result.structuredContent as { ok: boolean; tilesRequested: number };

        assert.equal(structured.ok, true);
        assert.equal(structured.tilesRequested, 9, "a size of 3 is nine tiles");
        assert.equal(game.pending.length, 0, "and its actions were applied");
    });
});

test("the deferred answer is one well-formed HTTP response carrying the caller's id", function () {
    withPark(function (app, _game, clock) {
        const headers = openSession(app);
        const socket = new FakeSocket();

        callTool(app, headers, socket, "call-7", "clear_scenery", { x: 20, y: 8, size: 2 });

        assert.equal(clock.watchdogs, 1, "a watchdog must be armed while the tool runs");

        clock.runSteps();

        const messages = responsesOn(socket);
        assert.equal(messages.length, 1);

        const message = messages[0];
        assert.equal(message.statusLine, "HTTP/1.1 200 OK");
        assert.equal(message.headers["content-type"], "application/json; charset=utf-8");
        assert.equal(message.headers["mcp-protocol-version"], PROTOCOL_VERSION);
        assert.equal(message.headers["connection"], "close");
        assert.equal(Number(message.headers["content-length"]), utf8ByteLength(message.body));

        const payload = soleJsonRpcResponse(socket);
        assert.equal(payload.jsonrpc, "2.0");
        assert.equal(payload.id, "call-7", "a string id must come back as a string, not coerced");
        assert.equal(payload.error, undefined);

        const result = payload.result as { content: { type: string; text: string }[]; structuredContent: Record<string, unknown> };
        assert.equal(result.content[0].type, "text");
        assert.equal(result.content[0].text, JSON.stringify(result.structuredContent),
            "the text content must be the structured content, not a summary of it");
        assert.equal(result.structuredContent.tilesRequested, 4);
        assert.deepEqual(clock.tickErrors, []);
    });
});

test("a tool that never finishes is answered once by the watchdog", function () {
    withPark(function (app, _game, clock) {
        const headers = openSession(app);
        const socket = new FakeSocket();

        callTool(app, headers, socket, 2, "clear_scenery", { x: 14, y: 10, size: 3 });

        assert.equal(socket.written, "", "nothing is owed to the client yet");

        // The work never lands: only the 30 second guard does.
        clock.fireWatchdogs();

        const result = soleToolResult(socket, 2);
        assert.equal(result.isError, true);
        assert.match(String((result.content as { text: string }[])[0].text), TIMEOUT_TEXT);
        assert.equal(socket.chunks.length, 1, "the timeout answer must be written exactly once");
        assert.equal(socket.ended, true, "and the connection closed behind it");
        assert.deepEqual(clock.tickErrors, []);
    });
});

test("a tool finishing either side of the watchdog still answers exactly once", function () {
    withPark(function (app, _game, clock) {
        const headers = openSession(app);

        // The watchdog wins the race, then the tool finishes a moment later.
        const lateSocket = new FakeSocket();
        callTool(app, headers, lateSocket, 2, "clear_scenery", { x: 14, y: 10, size: 3 });
        clock.fireWatchdogs();
        clock.runSteps();

        const lateResult = soleToolResult(lateSocket, 2);
        assert.equal(lateResult.isError, true, "the client was already told it timed out");
        assert.match(String((lateResult.content as { text: string }[])[0].text), TIMEOUT_TEXT);
        assert.equal(lateSocket.chunks.length, 1, "the late finish must not write a second response");

        // The other order: the tool finishes first. Its watchdog is cancelled on the way
        // out, and the `settled` guard behind that still refuses a second answer.
        const earlySocket = new FakeSocket();
        callTool(app, headers, earlySocket, 3, "clear_scenery", { x: 20, y: 8, size: 2 });
        assert.equal(clock.watchdogs, 1, "a watchdog is armed while the tool runs");

        clock.runSteps();

        assert.equal(clock.watchdogs, 0, "an answered call must not leave its watchdog holding the socket");

        const beforeWatchdog = earlySocket.written;
        clock.fireWatchdogs();

        assert.equal(earlySocket.written, beforeWatchdog, "a fired watchdog must not overwrite a real answer");

        const earlyResult = soleToolResult(earlySocket, 3);
        assert.equal(earlyResult.isError, undefined);
        assert.equal((earlyResult.structuredContent as { tilesRequested: number }).tilesRequested, 4);
        assert.deepEqual(clock.tickErrors, []);
    });
});

test("a client that hangs up mid-work is noticed and never written to again", function () {
    withPark(function (app, _game, clock) {
        const headers = openSession(app);
        const socket = new FakeSocket();

        callTool(app, headers, socket, 2, "clear_scenery", { x: 14, y: 10, size: 3 });

        assert.equal(socket.closeListenerCount, 1, "the call must hear the client leave");

        // The client gives up while the tool is still working.
        socket.hangUp();

        assert.equal(clock.watchdogs, 0, "a call nobody is waiting for must not hold its watchdog");

        clock.runSteps();
        clock.fireWatchdogs();

        assert.deepEqual(clock.tickErrors, [], "answering a gone client must not throw into the game's tick");
        assert.equal(socket.written, "", "nothing reached the client, which is no longer there");
        assert.equal(socket.chunksAfterClose.length, 0, "and nothing was handed to the dead socket either");
        assert.equal(socket.closeListenerCount, 0, "the settled call leaves no listener on the socket");
    });
});

test("six deferred calls in flight at once each get their own answer", function () {
    withPark(function (app, _game, clock) {
        const headers = openSession(app);
        const calls = [
            { id: 10, x: 3, y: 3, size: 1 },
            { id: "call-11", x: 16, y: 4, size: 2 },
            { id: 12, x: 20, y: 8, size: 3 },
            { id: "call-13", x: 24, y: 14, size: 4 },
            { id: 14, x: 4, y: 20, size: 5 },
            { id: 15, x: 16, y: 24, size: 6 }
        ];
        const sockets = calls.map(function () { return new FakeSocket(); });

        calls.forEach(function (call, index) {
            const started = callTool(app, headers, sockets[index], call.id, "clear_scenery", {
                x: call.x, y: call.y, size: call.size
            });

            assert.equal(started.hijacked, true);
            assert.equal(sockets[index].written, "", "no call may answer before its work is done");
        });

        assert.equal(clock.steps, 6, "six tools are waiting on the game");
        assert.equal(clock.watchdogs, 6, "each with its own watchdog");

        clock.runSteps();

        const seen: number[] = [];

        calls.forEach(function (call, index) {
            const result = soleToolResult(sockets[index], call.id);
            const structured = result.structuredContent as { ok: boolean; tilesRequested: number };

            assert.equal(structured.ok, true, "call " + String(call.id) + " cleared its own square");
            assert.equal(structured.tilesRequested, call.size * call.size,
                "call " + String(call.id) + " got another call's result");
            seen.push(structured.tilesRequested);
        });

        assert.deepEqual(seen.slice(0).sort(function (a, b) { return a - b; }), [1, 4, 9, 16, 25, 36],
            "every call must come back with a different, correct answer");
        assert.deepEqual(clock.tickErrors, []);
        assert.equal(clock.watchdogs, 0, "no answered call may leave a watchdog behind");
        assert.equal(clock.timerIsTheGames, true,
            "with nothing in flight the game's own timer must be back in place");
    });
});

test("a deferred tool that throws on the spot answers with an error result", function () {
    withPark(function (app, _game, clock) {
        const headers = openSession(app);
        const socket = new FakeSocket();

        breakTheMap();
        callTool(app, headers, socket, 2, "clear_scenery", { x: 14, y: 10, size: 3 });

        const result = soleToolResult(socket, 2);

        assert.equal(result.isError, true);
        assert.match(String((result.content as { text: string }[])[0].text), /Tool failed: .*map is gone/);
        assert.equal(socket.chunks.length, 1);
        assert.equal(socket.ended, true);
        assert.equal(clock.watchdogs, 0, "an answered call must not arm a watchdog it no longer needs");
    });
});

test("a deferred tool that throws mid-work answers with the reason, not a timeout", function () {
    withPark(function (app, _game, clock) {
        const headers = openSession(app);
        const socket = new FakeSocket();

        callTool(app, headers, socket, 2, "clear_scenery", { x: 14, y: 10, size: 3 });

        // The game breaks after the tool started, so the failure lands in a tick callback
        // rather than in the synchronous call the MCP layer wrapped.
        breakTheMap();
        clock.runSteps();

        assert.deepEqual(clock.tickErrors, [], "the failure belongs to the caller, not to the game's tick loop");

        const result = soleToolResult(socket, 2);
        assert.equal(result.isError, true);
        assert.match(String((result.content as { text: string }[])[0].text), /Tool failed: .*map is gone/,
            "the client must be told what broke, not that the tool was slow");
        assert.equal(socket.chunks.length, 1);
        assert.equal(socket.ended, true);
        assert.equal(clock.watchdogs, 0, "and the watchdog it no longer needs is cancelled");

        clock.fireWatchdogs();

        assert.equal(socket.chunks.length, 1, "nothing may answer a second time");
    });
});

test("a deferred tool without a connection says so instead of hanging", function () {
    withPark(function (app, _game, clock) {
        const headers = openSession(app);

        // handleRawRequest has no socket to take over.
        const response = app.handleRawRequest(rawRequest(JSON.stringify({
            jsonrpc: "2.0", id: 2, method: "tools/call",
            params: { name: "clear_scenery", arguments: { x: 14, y: 10, size: 3 } }
        }), headers));

        const body = jsonBody(response) as { error?: { message: string } };
        assert.ok(body.error, "it must report an error rather than silently do nothing");
        assert.match(String(body.error.message), /live connection/);
        assert.equal(clock.steps, 0, "and the tool must not have been started");
    });
});

test("an ordinary tool still answers on the normal path", function () {
    withPark(function (app) {
        const headers = openSession(app);
        const socket = new FakeSocket();

        const result = app.handleSocketRequest(rawRequest(JSON.stringify({
            jsonrpc: "2.0", id: 2, method: "tools/call",
            params: { name: "find_build_sites", arguments: { rideObject: 0, limit: 1 } }
        }), headers), socket);

        assert.equal(result.context.connection.hijacked, false, "no need to take the connection over");

        const body = jsonBody(result.response) as { result: { structuredContent: { ok: boolean } } };
        assert.equal(body.result.structuredContent.ok, true);
    });
});

test("a deferred tool's failure comes back as a result, not a broken connection", function () {
    withPark(function (app, _game, clock) {
        const headers = openSession(app);
        const socket = new FakeSocket();

        callTool(app, headers, socket, 2, "operate_ride", { ride: 99, open: true });
        clock.runSteps();

        const result = soleToolResult(socket, 2);
        const structured = result.structuredContent as { ok: boolean; detail: string };

        assert.equal(structured.ok, false);
        assert.match(structured.detail, /no ride with id 99/);
    });
});

test("every mutating tool is reachable through tools/call", function () {
    withPark(function (app) {
        const headers = openSession(app);
        const response = app.handleRawRequest(rawRequest(JSON.stringify({
            jsonrpc: "2.0", id: 2, method: "tools/list"
        }), headers));

        const body = jsonBody(response) as { result: { tools: { name: string }[] } };
        const names = body.result.tools.map(function (tool) { return tool.name; }).sort();

        assert.deepEqual(names, [
            "build_flat_ride", "build_path", "buy_land", "clear_scenery", "evaluate", "find_build_sites",
            "guest_feedback", "hire_staff", "list_ride_objects", "open_park", "operate_ride",
            "park_status", "remove_path", "set_game_speed"
        ]);
    });
});
