import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import { createApplication } from "../src/app.ts";
import type { SocketLike } from "../src/http/types.ts";

/**
 * Every mutating tool answers through the deferred path: the MCP layer takes over the
 * connection and writes the response once the tool finishes, several game ticks later.
 * Nothing exercised it until now, so a break here would have silenced build_flat_ride,
 * build_path, clear_scenery, hire_staff and operate_ride at once.
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

function jsonBody(response: { getBody(): string }): Record<string, unknown> {
    return JSON.parse(response.getBody()) as Record<string, unknown>;
}

/** Open an MCP session and return headers for subsequent calls. */
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

function withPark(run: (app: ReturnType<typeof createApplication>, game: FakeGame) => void): void {
    const game = new FakeGame(32, 32);
    game.rideObjects = [{ index: 0, name: "Merry-Go-Round", rideType: [33] }];
    game.addParkEntrance(10, 2);

    for (let y = 3; y <= 20; y++) {
        game.addPath(10, y);
    }

    const restore = game.install();

    try {
        run(createApplication(), game);
    } finally {
        restore();
    }
}

test("a deferred tool answers over the hijacked connection", function () {
    withPark(function (app, game) {
        const headers = openSession(app);
        const socket = new FakeSocket();

        const result = app.handleSocketRequest(rawRequest(JSON.stringify({
            jsonrpc: "2.0", id: 2, method: "tools/call",
            params: { name: "clear_scenery", arguments: { x: 14, y: 10, size: 3 } }
        }), headers), socket);

        assert.equal(result.context.connection.hijacked, true, "the tool must take over the connection");
        assert.ok(socket.written.length > 0, "and write its own response to it");
        assert.equal(socket.ended, true);

        const body = socket.written.substring(socket.written.indexOf("\r\n\r\n") + 4);
        const parsed = JSON.parse(body) as { result: { structuredContent: { ok: boolean; tilesRequested: number } } };

        assert.equal(parsed.result.structuredContent.ok, true);
        assert.equal(parsed.result.structuredContent.tilesRequested, 9, "a size of 3 is nine tiles");
        assert.equal(game.pending.length, 0, "and its actions were applied");
    });
});

test("a deferred tool without a connection says so instead of hanging", function () {
    withPark(function (app) {
        const headers = openSession(app);

        // handleRawRequest has no socket to take over.
        const response = app.handleRawRequest(rawRequest(JSON.stringify({
            jsonrpc: "2.0", id: 2, method: "tools/call",
            params: { name: "clear_scenery", arguments: { x: 14, y: 10, size: 3 } }
        }), headers));

        const body = jsonBody(response) as { error?: { message: string } };
        assert.ok(body.error, "it must report an error rather than silently do nothing");
        assert.match(String(body.error.message), /live connection/);
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
    withPark(function (app) {
        const headers = openSession(app);
        const socket = new FakeSocket();

        app.handleSocketRequest(rawRequest(JSON.stringify({
            jsonrpc: "2.0", id: 2, method: "tools/call",
            params: { name: "operate_ride", arguments: { ride: 99, open: true } }
        }), headers), socket);

        const body = socket.written.substring(socket.written.indexOf("\r\n\r\n") + 4);
        const parsed = JSON.parse(body) as { result: { structuredContent: { ok: boolean; detail: string } } };

        assert.equal(parsed.result.structuredContent.ok, false);
        assert.match(parsed.result.structuredContent.detail, /no ride with id 99/);
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
            "build_flat_ride", "build_path", "clear_scenery", "evaluate", "find_build_sites",
            "guest_feedback", "hire_staff", "list_ride_objects", "operate_ride", "park_status"
        ]);
    });
});
