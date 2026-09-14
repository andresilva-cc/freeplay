import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import { createApplication } from "../src/app.ts";
import type { SocketLike } from "../src/http/types.ts";

/**
 * The clock keeps running while the model thinks, and only the waiting half was ever
 * reported. Measured over one scenario year: seven `wait` calls spent 62 of 248 days, and
 * the other 186 elapsed between calls with nothing saying so.
 *
 * Two things make these discriminating rather than decorative.
 *
 * Every expected figure is a hand-computed day count, not a number read back out of the
 * same arithmetic the bridge uses. The fake advances `monthProgress` by 4 a tick and turns
 * the month over at 65536, so 16384 ticks is exactly one month - and OpenRCT2's months are
 * 31, 30, 31 days, so two months is 61 and not 60 or 62. An implementation that assumed a
 * fixed month length gets a different number here.
 *
 * And the clock is moved by `game.advanceTicks` BETWEEN calls, which is the thing that was
 * invisible. A tool that reported its own duration, or that read the clock after running
 * instead of before, passes an assertion on the returned object and fails these.
 */

/** One month of the fake's clock: `monthProgress` climbs 4 a tick and turns over at 65536. */
const TICKS_PER_MONTH = 16384;

class FakeSocket implements SocketLike {
    public written = "";

    public write(data: string): boolean {
        this.written += data;
        return true;
    }

    public end(data?: string): SocketLike {
        if (typeof data === "string") {
            this.written += data;
        }
        return this;
    }

    public on(): SocketLike { return this; }
    public off(): SocketLike { return this; }
}

const mcpHeaders = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json"
};

function rawRequest(body: string, headers: Record<string, string>): string {
    const lines = ["POST /mcp HTTP/1.1"].concat(Object.keys(headers).map(function (name) {
        return name + ": " + headers[name];
    }));

    return lines.join("\r\n") + "\r\n\r\n" + body;
}

type App = ReturnType<typeof createApplication>;

function openSession(app: App): Record<string, string> {
    const response = app.handleRawRequest(rawRequest(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
            protocolVersion: "2025-11-25", capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" }
        }
    }), mcpHeaders));

    const headers: Record<string, string> = {
        Accept: mcpHeaders.Accept,
        "Content-Type": mcpHeaders["Content-Type"],
        "MCP-Session-Id": String(response.getHeader("mcp-session-id")),
        "MCP-Protocol-Version": "2025-11-25"
    };

    app.handleRawRequest(rawRequest(JSON.stringify({
        jsonrpc: "2.0", method: "notifications/initialized"
    }), headers));

    return headers;
}

interface ToolResult {
    content?: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
}

interface Session {
    app: App;
    headers: Record<string, string>;
    game: FakeGame;
}

function withSession(run: (session: Session) => void): void {
    const game = new FakeGame(24, 24);
    game.rideObjects = [{ index: 0, name: "Merry-Go-Round", rideType: [33] }];
    game.addParkEntrance(10, 2);

    for (let y = 3; y <= 12; y++) {
        game.addPath(10, y);
    }

    const restore = game.install();

    try {
        const app = createApplication();
        run({ app: app, headers: openSession(app), game: game });
    } finally {
        restore();
    }
}

let nextId = 100;

/** Call a tool the way the model does, on whichever path it answers on. */
function callTool(session: Session, name: string, args: Record<string, unknown> = {}): ToolResult {
    const socket = new FakeSocket();
    const outcome = session.app.handleSocketRequest(rawRequest(JSON.stringify({
        jsonrpc: "2.0", id: ++nextId, method: "tools/call",
        params: { name: name, arguments: args }
    }), session.headers), socket);

    const raw = outcome.context.connection.hijacked
        ? socket.written.substring(socket.written.indexOf("\r\n\r\n") + 4)
        : outcome.response.getBody();

    const parsed = JSON.parse(raw) as { result?: ToolResult };

    assert.ok(parsed.result, name + " answered with no result: " + raw);
    return parsed.result as ToolResult;
}

function structured(result: ToolResult): Record<string, unknown> {
    assert.ok(result.structuredContent, "the tool answered with no structured result");
    return result.structuredContent as Record<string, unknown>;
}

function elapsed(result: ToolResult): unknown {
    return structured(result).gameDaysSinceLastCall;
}

test("the figure is the game time that actually passed between the two calls", function () {
    withSession(function (session) {
        callTool(session, "park_status");

        // Two whole months of the game's own calendar: March is 31 days and April is 30.
        session.game.advanceTicks(TICKS_PER_MONTH * 2);

        assert.equal(elapsed(callTool(session, "park_status")), 61,
            "March plus April is 61 days; 60 or 62 is a month length we invented");

        session.game.advanceTicks(TICKS_PER_MONTH);

        assert.equal(elapsed(callTool(session, "park_status")), 31,
            "and each figure is since the LAST call, not since the scenario began");
    });
});

test("the first call of a session carries no figure at all", function () {
    withSession(function (session) {
        const first = structured(callTool(session, "park_status"));

        assert.equal("gameDaysSinceLastCall" in first, false,
            "there is no previous call to measure from, and 0 would be a measurement: " + JSON.stringify(first));

        session.game.advanceTicks(TICKS_PER_MONTH);

        assert.equal(elapsed(callTool(session, "park_status")), 31,
            "the first call still stamps the clock, so the second has something to measure from");
    });
});

test("a fresh session measures from its own first call, not the previous session's", function () {
    withSession(function (session) {
        callTool(session, "park_status");
        session.game.advanceTicks(TICKS_PER_MONTH * 3);

        const second: Session = {
            app: session.app,
            headers: openSession(session.app),
            game: session.game
        };

        assert.equal("gameDaysSinceLastCall" in structured(callTool(second, "park_status")), false,
            "a client that reconnects mid-scenario is not owed the gap since somebody else's call");
    });
});

/**
 * The claim the whole shape rests on: `wait` reports the game time it spent running, and
 * this reports the game time between calls, and the two tile the timeline rather than
 * overlapping. The clock is read when the call arrives, before the tool runs, which is the
 * only reason that holds - a reading taken afterwards would charge the wait twice.
 */
test("a wait's own game time is not billed again as thinking time", function () {
    withSession(function (session) {
        session.game.gameValues.speed = 4;
        callTool(session, "park_status");

        // Half of March: 8192 ticks is half a month, and March is 31 days.
        session.game.advanceTicks(TICKS_PER_MONTH / 2);

        const before = session.game.date.ticksElapsed;
        const result = structured(callTool(session, "wait", { days: 1 }));

        assert.ok(session.game.date.ticksElapsed > before,
            "the wait has to have run the clock, or this proves nothing");
        assert.equal(result.gameDaysSinceLastCall, 15.5,
            "only the time between the calls; the wait's own game days are its `days`");
        assert.ok((result.days as number) > 0,
            "and the wait still reports what it spent, which is the other half of the clock");
    });
});

test("a turn shorter than a game day reports a fraction rather than rounding to nothing", function () {
    withSession(function (session) {
        callTool(session, "park_status");

        // 264 ticks is 1056 of March's 65536, which is 0.4995 of its 31 days.
        session.game.advanceTicks(264);

        assert.equal(elapsed(callTool(session, "park_status")), 0.5,
            "at speed 1 a game day is about thirteen real seconds, so whole days would read 0"
                + " for most turns and teach that thinking is free");
    });
});

/**
 * A call the schema refused never reached a tool, so it takes no stamp. The time it spent
 * is still the model's, and it comes back in the next figure instead of being dropped.
 */
test("a refused call folds its time into the next figure rather than resetting it", function () {
    withSession(function (session) {
        callTool(session, "park_status");
        session.game.advanceTicks(TICKS_PER_MONTH / 2);

        const refused = callTool(session, "hire_staff", { staffType: "handyman", count: 30 });
        assert.equal(refused.isError, true, "the count is out of range and this has to be the refusal");

        session.game.advanceTicks(TICKS_PER_MONTH / 2);

        assert.equal(elapsed(callTool(session, "park_status")), 31,
            "both halves of March, not just the half since the refusal");
    });
});

test("the figure adds a key and changes nothing else about a result", function () {
    withSession(function (session) {
        const first = structured(callTool(session, "list_ride_objects"));
        session.game.advanceTicks(TICKS_PER_MONTH);

        const second = structured(callTool(session, "list_ride_objects"));

        assert.equal(second.gameDaysSinceLastCall, 31);
        delete second.gameDaysSinceLastCall;
        assert.deepEqual(second, first, "the same call answers the same way with time added to it");
        assert.deepEqual(session.game.attempted, [],
            "and reading the clock fires no game action: nothing about the park changed");
    });
});

test("the text and the structured result carry the same figure", function () {
    withSession(function (session) {
        callTool(session, "park_status");
        session.game.advanceTicks(TICKS_PER_MONTH);

        const result = callTool(session, "park_status");
        const text = (result.content as { text: string }[])[0].text;

        assert.equal(text, JSON.stringify(result.structuredContent),
            "a client reading the text and one reading the structure must not see different clocks");
        assert.match(text, /"gameDaysSinceLastCall":31/);
    });
});

test("the session instructions say what the figure is and when it is missing", function () {
    withSession(function (session) {
        const response = session.app.handleRawRequest(rawRequest(JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "initialize",
            params: {
                protocolVersion: "2025-11-25", capabilities: {},
                clientInfo: { name: "test", version: "1.0.0" }
            }
        }), mcpHeaders));

        const instructions = String((JSON.parse(response.getBody()) as {
            result: { instructions?: string };
        }).result.instructions);

        assert.match(instructions, /gameDaysSinceLastCall/,
            "a key nothing defines is a key the model has to guess the meaning of");
        assert.match(instructions, /first call of a session/,
            "and an absent field has to be explained, or it reads as a bug");
        assert.doesNotMatch(instructions, /deadline|running out|too long|hurry|objective/i,
            "the clock is the model's to spend; this reports a number and says nothing about it");
    });
});
