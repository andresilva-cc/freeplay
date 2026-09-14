import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import { resetClockGate } from "../src/clockGate.ts";
import { createApplication } from "../src/app.ts";
import type { SocketLike } from "../src/http/types.ts";

/**
 * The game is held paused between tool calls, and `wait` is the only call that spends
 * scenario time.
 *
 * Measured over one scenario year before this: seven `wait` calls spent 62 of 248 days and
 * the other 186 elapsed between calls, on inference latency. At speed 4 an 82-second turn
 * costs 49 game days that nothing chose to spend, and a machine with twice the tokens per
 * second halves that - so two runs of the same model were two different games, and the model
 * was being charged for thinking rather than for thinking wrongly.
 *
 * The trap in fixing it is that OpenRCT2 refuses almost every game action through a pause
 * (`GameActionRunner.cpp`, `CheckActionInPausedMode`), so a bridge that simply held the
 * pause would have every build, path, clear and hire come back refused. These tests are
 * about the two halves having to be true at once: nothing moves while the model thinks, and
 * a tool that acts still acts.
 *
 * The assertions are on `game.date.ticksElapsed`, the fake's own counter, which nothing but
 * time passing moves - so a gate that reported itself held while the clock ran fails here.
 */

const mcpHeaders = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json"
};

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

function rawRequest(body: string, headers: Record<string, string>): string {
    const lines = ["POST /mcp HTTP/1.1"].concat(Object.keys(headers).map(function (name) {
        return name + ": " + headers[name];
    }));

    return lines.join("\r\n") + "\r\n\r\n" + body;
}

type App = ReturnType<typeof createApplication>;

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

/** A park with a gate and a spine of path, which is what build_path needs to extend. */
function withSession(run: (session: Session) => void): void {
    const game = new FakeGame(24, 24);
    game.addParkEntrance(10, 2);

    for (let y = 3; y <= 12; y++) {
        game.addPath(10, y);
    }

    const restore = game.install();

    resetClockGate();

    try {
        const app = createApplication();
        run({ app: app, headers: openSession(app), game: game });
    } finally {
        resetClockGate();
        restore();
    }
}

let nextId = 400;

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
    assert.ok(result.structuredContent, "the tool answered with no structured result: "
        + JSON.stringify(result.content));
    return result.structuredContent as Record<string, unknown>;
}

function pathTiles(game: FakeGame, from: number, to: number): number {
    let found = 0;

    for (let y = from; y <= to; y++) {
        if (game.tile(10, y).elements.filter(function (element) {
            return element.type === "footpath";
        }).length > 0) {
            found++;
        }
    }

    return found;
}

/* -------------------------------------------------------------------------------------
 * Nothing moves while the model thinks.
 */

test("the game is paused the moment the harness connects, before the first turn is taken", function () {
    withSession(function (session) {
        // The first turn is a whole inference latency with nobody watching. It used to be
        // spent at whatever speed the scenario had been left running at.
        assert.equal(session.game.gameValues.paused, true);
        assert.equal(session.game.date.ticksElapsed, 0);
    });
});

test("a run of reader calls costs the scenario nothing at all", function () {
    withSession(function (session) {
        callTool(session, "park_status");
        callTool(session, "view_map");
        callTool(session, "list_ride_objects");
        const last = structured(callTool(session, "park_status"));

        assert.equal(session.game.date.ticksElapsed, 0,
            "four turns of reading, and not one game tick spent");
        assert.equal(last.gameDaysSinceLastCall, 0,
            "and the figure the model is shown says so");
        assert.equal(session.game.gameValues.paused, true, "still held when the call is over");
    });
});

test("the clock runs for a wait and is held again the moment it answers", function () {
    withSession(function (session) {
        callTool(session, "park_status");

        const body = structured(callTool(session, "wait", { days: 0.2 }));

        assert.equal(body.days, 0.2, "the wait got the game time it asked for");
        assert.equal(session.game.date.ticksElapsed, 106, "106 ticks is the first that reaches 0.2 of a day");
        assert.equal(session.game.gameValues.paused, true, "and the hold went straight back on");

        const after = structured(callTool(session, "park_status"));

        assert.equal(session.game.date.ticksElapsed, 106, "the turn after a wait costs nothing either");
        assert.equal(after.gameDaysSinceLastCall, 0,
            "the wait's own days are its `days`; this is the thinking time, and there is none");
    });
});

/* -------------------------------------------------------------------------------------
 * And a tool that acts still acts.
 */

test("a build lands while the bridge is holding the clock, rather than being refused", function () {
    withSession(function (session) {
        assert.equal(session.game.gameValues.paused, true, "the hold has to be in force for this to mean anything");

        const body = structured(callTool(session, "build_path", {
            tiles: [{ x: 10, y: 13 }, { x: 10, y: 14 }]
        }));

        // OpenRCT2 refuses footpathplace through a pause - it carries no
        // Flags::AllowWhilePaused - so without a clock window this comes back
        // "Construction not possible while game is paused!" and nothing is built.
        assert.equal(body.ok, true, String(body.detail));
        assert.equal(body.tilesPlaced, 2);
        assert.doesNotMatch(String(body.detail), /Construction not possible while game is paused/,
            "the refusal the hold would otherwise have caused");
        assert.equal(pathTiles(session.game, 13, 14), 2, "and the path is really on the ground");
    });
});

test("the window a build opens is closed again, so the next turn is free", function () {
    withSession(function (session) {
        callTool(session, "build_path", { tiles: [{ x: 10, y: 13 }] });

        assert.equal(session.game.gameValues.paused, true,
            "a window left open would charge the whole of the next turn to the park");

        const spent = session.game.date.ticksElapsed;

        callTool(session, "park_status");

        assert.equal(session.game.date.ticksElapsed, spent, "and the reading after it costs nothing");
    });
});

test("what a build costs is its own working time and one tick, and nothing else", function () {
    withSession(function (session) {
        callTool(session, "build_path", { tiles: [{ x: 10, y: 13 }] });

        // The whole leak, pinned. The window is open from the tool's first action until one
        // game tick after the call answered: build_path spends one 200ms step inside itself
        // and the close waits one more 25ms frame, so 225ms at speed 1 is 9 game ticks -
        // 0.017 of a game day, against the 49 days an 82-second turn used to cost at speed 4.
        // What it is made of is the tool's own timers, not the machine: a slower host runs
        // fewer frames in the same 225ms and spends fewer ticks, never more. It does scale
        // with the speed setting, `1 << (speed - 1)`, which is the one thing left that makes
        // a run's scenario cost depend on a setting.
        assert.equal(session.game.date.ticksElapsed, 9);
    });
});

test("a build answers as a result rather than on the watchdog", function () {
    withSession(function (session) {
        const result = callTool(session, "build_path", { tiles: [{ x: 10, y: 13 }] });

        assert.equal(result.isError, undefined, "no error result at all");
        assert.doesNotMatch(JSON.stringify(result), /did not finish in time/,
            "the watchdog's message is what a held clock would have produced if actions stalled");
        assert.equal(session.game.watchdogs.length, 0,
            "and the guard was never even armed, because the tool finished inside its own call");
    });
});

/* -------------------------------------------------------------------------------------
 * A pause the model asked for is a different thing.
 */

test("a pause the model asked for still refuses a build, in the game's own words", function () {
    withSession(function (session) {
        structured(callTool(session, "set_game_speed", { paused: true }));

        const body = structured(callTool(session, "build_path", { tiles: [{ x: 10, y: 13 }] }));

        // The bridge's hold is bookkeeping and is lifted around an action; a pause the model
        // asked for is a decision, and nine other tools' descriptions promise this refusal.
        assert.equal(body.ok, false);
        assert.equal(body.tilesPlaced, 0);
        assert.match(String(body.detail), /Construction not possible while game is paused!/);
        assert.equal(pathTiles(session.game, 13, 13), 0, "nothing reached the ground");
        assert.equal(session.game.date.ticksElapsed, 0, "and no window was opened for it");
    });
});

test("unpausing unpauses, which a clock window around pausetoggle would have inverted", function () {
    withSession(function (session) {
        structured(callTool(session, "set_game_speed", { paused: true }));

        const body = structured(callTool(session, "set_game_speed", { paused: false }));

        // `pausetoggle` flips rather than sets. Unpausing the game to let the action through
        // and then firing it would turn "unpause" into "pause", which is why the gate never
        // opens a window for an action that carries Flags::AllowWhilePaused. Asserted on what
        // unpausing is for rather than on the flag: the bridge takes the clock back as soon
        // as the call answers, so the flag is true again either way and proves nothing.
        assert.equal(body.paused, false, "the pause the model was holding is gone");

        const waited = structured(callTool(session, "wait", { days: 0.1 }));

        assert.equal(waited.ok, true, String(waited.detail));
        assert.equal(session.game.date.ticksElapsed, 53, "and the clock really ran for it");

        const built = structured(callTool(session, "build_path", { tiles: [{ x: 10, y: 13 }] }));

        assert.equal(built.ok, true, String(built.detail));
        assert.equal(pathTiles(session.game, 13, 13), 1, "and a build goes through again too");
    });
});

test("a wait refuses through a pause the model asked for, rather than lifting it", function () {
    withSession(function (session) {
        structured(callTool(session, "set_game_speed", { paused: true }));

        const body = structured(callTool(session, "wait", { days: 1 }));

        assert.equal(body.ok, false);
        assert.equal(session.game.date.ticksElapsed, 0, "not one tick was spent on a stopped clock");
        assert.match(String(body.detail), /set_game_speed \{paused: false\}/,
            "and the refusal carries the call that fixes it");
    });
});

test("changing the pause setting spends no scenario time", function () {
    withSession(function (session) {
        // `gamesetspeed` and `pausetoggle` both carry Flags::AllowWhilePaused, so neither
        // needs a clock window and neither may get one. Pinned on the clock rather than on
        // the list: opening a window around `pausetoggle` unpauses the game and then toggles
        // it, so the game ends up paused, the tool falls back on the plugin API's own setter
        // to put it right, and the only trace left of the whole detour is the game time it
        // spent. Zero is the assertion that catches it.
        const body = structured(callTool(session, "set_game_speed", { speed: 3, paused: false }));

        assert.equal(body.ok, true, String(body.detail));
        assert.equal(body.paused, false, "the model's pause is not in force");
        assert.equal(body.speed, 3);
        assert.equal(session.game.date.ticksElapsed, 0,
            "setting the speed and the pause is bookkeeping, and bookkeeping costs the park nothing");
    });
});
