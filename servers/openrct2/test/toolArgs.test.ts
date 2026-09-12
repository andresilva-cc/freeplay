import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import { createApplication } from "../src/app.ts";
import type { SocketLike } from "../src/http/types.ts";

/**
 * The thin layer in src/tools is where a bad argument either gets caught or gets a
 * default invented for it. A silently defaulted price builds a free ride; a coerced
 * waypoint routes a path from off the map. So these drive the tools through the MCP
 * layer, the way the model reaches them, and check the refusal says what was wrong.
 */

class FakeSocket implements SocketLike {
    public written = "";
    public ended = false;

    public write(data: string): boolean {
        this.written += data;
        return true;
    }

    public end(data?: string): SocketLike {
        if (typeof data === "string") {
            this.written += data;
        }
        this.ended = true;
        return this;
    }

    public on(): SocketLike { return this; }
    public off(): SocketLike { return this; }
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

function openSession(app: ReturnType<typeof createApplication>): Record<string, string> {
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
    app: ReturnType<typeof createApplication>;
    headers: Record<string, string>;
    game: FakeGame;
}

/**
 * Ride object 0 is a merry-go-round, a flat ride. Object 1 is ride type 0, a roller
 * coaster, which has no single-piece footprint at all.
 */
function withSession(run: (session: Session) => void): void {
    const game = new FakeGame(32, 32);
    game.rideObjects = [
        { index: 0, name: "Merry-Go-Round", rideType: [33] },
        { index: 1, name: "Wooden Coaster", rideType: [0] }
    ];
    game.addParkEntrance(10, 2);

    for (let y = 3; y <= 20; y++) {
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

/** Call a tool and return its result payload, whichever path it answered on. */
function callTool(session: Session, name: string, args: Record<string, unknown>): ToolResult {
    const socket = new FakeSocket();
    const outcome = session.app.handleSocketRequest(rawRequest(JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: name, arguments: args }
    }), session.headers), socket);

    const raw = outcome.context.connection.hijacked
        ? socket.written.substring(socket.written.indexOf("\r\n\r\n") + 4)
        : outcome.response.getBody();

    const parsed = JSON.parse(raw) as { result?: ToolResult };

    assert.ok(parsed.result, name + " answered with no result: " + raw);
    return parsed.result as ToolResult;
}

/** The text of a refusal the argument check produced, or a failure if it was accepted. */
function refusal(result: ToolResult): string {
    assert.equal(result.isError, true, "the arguments were accepted: " + JSON.stringify(result));
    assert.ok(result.content && result.content.length > 0, "a refusal with no message is unusable");
    return (result.content as { text: string }[])[0].text;
}

/** The structured body of a tool that ran and answered for itself. */
function structured(result: ToolResult): Record<string, unknown> {
    assert.notEqual(result.isError, true, "the tool refused: " + JSON.stringify(result.content));
    assert.ok(result.structuredContent, "the tool answered with no structured result");
    return result.structuredContent as Record<string, unknown>;
}

const wholeRide = {
    rideObject: 0, x: 14, y: 10, rotation: 0, price: 10, open: false,
    entranceX: 12, entranceY: 10, exitX: 16, exitY: 10
};

function without(key: string): Record<string, unknown> {
    const args: Record<string, unknown> = { ...wholeRide };
    delete args[key];
    return args;
}

test("a required argument left out is refused by name, never defaulted", function () {
    withSession(function (session) {
        // A defaulted price of 0 is a ride that earns nothing, and nothing says so.
        assert.match(refusal(callTool(session, "build_flat_ride", without("price"))), /Missing required property: price/);

        // A defaulted `open` picks a side of a decision the model was asked to make.
        assert.match(refusal(callTool(session, "build_flat_ride", without("open"))), /Missing required property: open/);

        assert.equal(session.game.rides.length, 0, "and neither call built anything");
        assert.equal(session.game.attempted.length, 0, "nor sent a single action to the game");
    });
});

test("a required argument of the wrong type is refused rather than floored", function () {
    withSession(function (session) {
        const message = refusal(callTool(session, "build_flat_ride", { ...wholeRide, price: "10" }));

        assert.match(message, /price/, "the offending argument has to be named");
        assert.match(message, /expected integer/);
        assert.equal(session.game.rides.length, 0);
    });
});

test("an unknown argument is rejected where the schema forbids it, and tolerated by evaluate", function () {
    withSession(function (session) {
        // build_flat_ride closes its schema, so a misspelt or invented argument is caught
        // rather than dropped, which is how a model learns the name it wanted does not exist.
        const message = refusal(callTool(session, "build_flat_ride", { ...wholeRide, size: 3 }));
        assert.match(message, /Unexpected property: size/);

        // evaluate deliberately does not, so an extra argument does not cost a turn.
        const body = structured(callTool(session, "evaluate", { code: "1 + 1", note: "scratch" }));
        assert.equal(body.ok, true, "evaluate must still run: " + JSON.stringify(body));
        assert.equal(body.result, 2);
    });
});

test("an empty tile list is an argument error, not a failure to pave", function () {
    withSession(function (session) {
        const body = structured(callTool(session, "build_path", { tiles: [] }));

        assert.equal(body.ok, false);
        assert.match(String(body.error), /names no tiles/, "the argument at fault has to be named");
        assert.match(String(body.error), /one tile is a run/);
        assert.equal(session.game.attempted.length, 0, "and no tile was paved while working that out");
    });
});

test("a malformed tile is refused rather than coerced", function () {
    withSession(function (session) {
        // A missing y coerced to -1 would pave a tile off the map.
        const missing = structured(callTool(session, "build_path", {
            tiles: [{ x: 10 }, { x: 12, y: 10 }]
        }));

        assert.equal(missing.ok, false);
        assert.match(String(missing.error), /tiles\[0\]/, "the bad tile is identified by position");
        assert.match(String(missing.error), /numeric x and y/);

        const text = structured(callTool(session, "build_path", {
            tiles: [{ x: 10, y: 12 }, { x: "14", y: 12 }]
        }));

        assert.equal(text.ok, false, "a string coordinate is not a coordinate");
        assert.match(String(text.error), /tiles\[1\]/);
        assert.equal(session.game.attempted.length, 0, "neither call laid any path");
    });
});

test("an unknown staff type comes back with the types that do exist", function () {
    withSession(function (session) {
        // `staffType` declares its four values, so this is caught centrally before the tool
        // runs rather than inside it. hire_staff still carries the same refusal of its own
        // for a direct call - test/staff.test.ts drives that path - but over MCP the model
        // sees the earlier one, which names the property as well as the legal values.
        const message = refusal(callTool(session, "hire_staff", { staffType: "clown", count: 2 }));

        assert.match(message, /staffType/, "the property at fault has to be named");
        assert.match(message, /clown/, "the value that was rejected has to be quoted back");
        assert.match(message, /handyman/);
        assert.match(message, /mechanic/);
        assert.match(message, /security/);
        assert.match(message, /entertainer/);
        assert.equal(session.game.attempted.length, 0, "and nobody was hired in the meantime");
    });
});

test("a staff count outside 1 to 10 is refused rather than clamped into range", function () {
    withSession(function (session) {
        // It used to clamp to ten and report ten as `requested`, so a call for thirty came
        // back saying thirty had never been asked for.
        const message = refusal(callTool(session, "hire_staff", { staffType: "handyman", count: 30 }));

        assert.match(message, /count/);
        assert.match(message, /1 to 10/);
        assert.match(message, /30/);
        assert.equal(session.game.attempted.length, 0, "and nobody was hired on the way to that answer");
    });
});

test("clear_scenery refuses half a rectangle instead of squaring it off", function () {
    withSession(function (session) {
        // The two forms are `x`/`y`/`size` - a square centred on x,y - and the four corner
        // fields a site carries, `fromX`/`fromY`/`toX`/`toY`. They share no arguments, so
        // which one a call means is never in doubt; half of one silently completed would
        // clear different ground from the ground that was named, and clearing is
        // destructive. Which form was meant is the tool's own question, so these come back
        // the way build_path's argument errors do, as `ok: false` with the reason.
        const half = structured(callTool(session, "clear_scenery", { fromX: 12, fromY: 12, toX: 15 }));

        assert.equal(half.ok, false);
        assert.match(String(half.error), /toY/, "the missing argument has to be named");

        const both = structured(callTool(session, "clear_scenery", {
            x: 12, y: 12, size: 4, fromX: 12, fromY: 12, toX: 15, toY: 15
        }));

        assert.equal(both.ok, false);
        assert.match(String(both.error), /size/);
        assert.match(String(both.error), /fromX/);

        const oversized = refusal(callTool(session, "clear_scenery", { x: 12, y: 12, size: 30 }));

        assert.match(oversized, /size/);
        assert.match(oversized, /1 to 16/);

        assert.equal(session.game.attempted.length, 0, "and not a tree was felled by any of the three");
    });
});

test("describing a placement for a tracked ride explains it has to be built from track", function () {
    withSession(function (session) {
        const body = structured(callTool(session, "describe_placement", { rideObject: 1, x: 12, y: 12, rotation: 0 }));

        assert.equal(body.ok, false, "a coaster has no one-piece footprint to find room for");
        assert.match(String(body.error), /Wooden Coaster/, "the ride that was asked about has to be named");
        assert.match(String(body.error), /not a flat ride/);
        assert.match(String(body.error), /track/, "and the message has to say what to do instead");
    });
});

test("every registered tool describes itself and its arguments", function () {
    withSession(function (session) {
        const response = session.app.handleRawRequest(rawRequest(JSON.stringify({
            jsonrpc: "2.0", id: 2, method: "tools/list"
        }), session.headers));

        const body = JSON.parse(response.getBody()) as {
            result: { tools: { name: string; description?: string; inputSchema?: { type?: string; properties?: Record<string, { description?: string }> } }[] };
        };
        const tools = body.result.tools;

        assert.ok(tools.length > 0, "the model sees no tools at all");

        tools.forEach(function (tool) {
            // A tool with no description is one the model has to guess at, and it guesses badly.
            assert.equal(typeof tool.description, "string", tool.name + " has no description");
            assert.ok(String(tool.description).trim().length > 0, tool.name + " has an empty description");
            assert.ok(tool.inputSchema, tool.name + " has no inputSchema");
            assert.equal((tool.inputSchema as { type?: string }).type, "object", tool.name + " does not take an object");

            const properties = (tool.inputSchema as { properties?: Record<string, { description?: string }> }).properties || {};

            Object.keys(properties).forEach(function (property) {
                assert.ok(String(properties[property].description || "").trim().length > 0,
                    tool.name + "." + property + " is undocumented, so its meaning has to be guessed");
            });
        });
    });
});
