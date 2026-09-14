import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import { createApplication } from "../src/app.ts";
import { resetClockGate } from "../src/clockGate.ts";
import {
    readScenarioIndexEntry,
    readScenarioVerdict,
    resetScenarioWatch,
    sampleScenarioStatus,
    scenarioIsWatched,
    watchScenarioStatus
} from "../src/scenarioVerdict.ts";
import type { SocketLike } from "../src/http/types.ts";

/**
 * The scenario ending is something the model has to be TOLD.
 *
 * `scenario.status` goes `inProgress` -> `completed` or `failed`, and OpenRCT2 has no hook
 * for it: `HookType` carries the intervals, the map, the rides and the network and nothing
 * about the objective. So it was read in one place only, `park_status`, and a model that
 * stopped asking never found out. One recorded run played on past a failure it never saw.
 *
 * Two things are under test. That the verdict appears on tool results only from the day the
 * game actually decides, carrying THAT day rather than the day it was next asked. And that
 * `GET /v1` carries it too, so the harness can read it without an MCP session of its own.
 *
 * Every date assertion is against `game.date`, the fake's own clock, and the flip itself is
 * the fake's: `decideScenarioOn` turns the status as the day turns, the way an objective
 * check does, rather than a fixture reaching in and setting it where the bridge would like
 * it. A bridge that recorded the wrong day would agree with itself and fail here.
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

function withSession(run: (session: Session) => void): void {
    const game = new FakeGame(24, 24);
    game.addParkEntrance(10, 2);
    const restore = game.install();

    resetClockGate();
    resetScenarioWatch();

    try {
        const app = createApplication();
        run({ app: app, headers: openSession(app), game: game });
    } finally {
        resetClockGate();
        resetScenarioWatch();
        restore();
    }
}

let nextId = 900;

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

function versionIndex(app: App): Record<string, unknown> {
    return JSON.parse(app.handleRawRequest("GET /v1 HTTP/1.1\r\n\r\n").getBody()) as Record<string, unknown>;
}

/**
 * Run the fake's clock on by whole days, read off its own day counter rather than converted
 * from ticks here: 528 ticks is a day to three figures and not a day, and a fixture that
 * counted its own days would drift a day out by the ninth one.
 */
function runDays(game: FakeGame, days: number): void {
    const target = game.dayNumber() + days;

    while (game.dayNumber() < target) {
        game.advanceTicks(64);
    }
}

/** The three date fields the fake's own clock is standing on right now. */
function todayInFake(game: FakeGame): Record<string, number> {
    return { year: game.date.year, month: game.date.month, day: game.date.day };
}

/* -------------------------------------------------------------------------------------
 * The day hook, on its own.
 */

test("nothing is recorded while the scenario is still being played, however far the clock runs", function () {
    const game = new FakeGame(8, 8);
    const restore = game.install();

    resetScenarioWatch();

    try {
        watchScenarioStatus();
        runDays(game, 40);

        assert.equal(game.scenario.status, "inProgress", "the fake has to still be playing");
        assert.equal(readScenarioVerdict(), undefined,
            "a scenario in progress is not a verdict, and a field that appears anyway says the run is over");
    } finally {
        resetScenarioWatch();
        restore();
    }
});

test("the verdict names the day the game decided, not the day it was next read", function () {
    const game = new FakeGame(8, 8);
    const restore = game.install();

    resetScenarioWatch();

    try {
        watchScenarioStatus();
        assert.ok(scenarioIsWatched(), "the day hook is what makes this measurement possible");

        // The fake turns the status as day 3 turns, before that day's subscribers run, which
        // is the order OpenRCT2 reaches them in. Nothing here sets `scenario.status`.
        game.decideScenarioOn(3, "failed");

        runDays(game, 2);
        assert.equal(readScenarioVerdict(), undefined, "two days in, the game has decided nothing");

        // Straight past it, by another seven days: a bridge reading the status only when it
        // is asked would date the verdict here instead.
        runDays(game, 7);

        assert.equal(game.dayNumber(), 9, "the fixture has to have run well past the decision");

        const verdict = readScenarioVerdict();

        assert.ok(verdict, "the day hook is the only thing that can see this, and it saw nothing");
        assert.equal(verdict.status, "failed");
        assert.equal(verdict.year, 1);
        assert.equal(verdict.month, 0);
        assert.equal(verdict.day, 4, "day 4 of month 0 is day number 3, which is the day it happened");
    } finally {
        resetScenarioWatch();
        restore();
    }
});

test("a scenario loaded over the top puts the verdict back, because it is not a fact about this one", function () {
    const game = new FakeGame(8, 8);
    const restore = game.install();

    resetScenarioWatch();

    try {
        watchScenarioStatus();
        game.decideScenarioOn(1, "completed");
        runDays(game, 2);
        assert.ok(readScenarioVerdict(), "the fixture has to have reached a verdict first");

        game.scenario.status = "inProgress";
        sampleScenarioStatus();

        assert.equal(readScenarioVerdict(), undefined,
            "last scenario's verdict would otherwise ride on every result of the new one");
    } finally {
        resetScenarioWatch();
        restore();
    }
});

test("a game that will not take the hook still reports the verdict, a read later", function () {
    const game = new FakeGame(8, 8);
    const restore = game.install();
    const scope = globalThis as unknown as { context: Record<string, unknown> };

    resetScenarioWatch();

    try {
        delete scope.context.subscribe;
        watchScenarioStatus();

        assert.equal(scenarioIsWatched(), false, "the fixture has to actually have no hook");

        game.scenario.status = "failed";
        runDays(game, 3);
        assert.equal(readScenarioVerdict(), undefined, "with no hook nothing reads it until something asks");

        sampleScenarioStatus();

        const verdict = readScenarioVerdict();

        assert.ok(verdict, "the opportunistic read is what covers a build with no hook");
        assert.equal(verdict.status, "failed");
        assert.deepEqual(
            { year: verdict.year, month: verdict.month, day: verdict.day },
            todayInFake(game),
            "with no hook the day recorded is the day it was read, which is the day it is asked on"
        );
    } finally {
        resetScenarioWatch();
        restore();
    }
});

/* -------------------------------------------------------------------------------------
 * On every tool result after it happens, and on none before.
 */

test("no tool result carries the verdict while the scenario is still in progress", function () {
    withSession(function (session) {
        const body = structured(callTool(session, "park_status"));

        assert.equal(session.game.scenario.status, "inProgress");
        assert.equal(body.scenarioEnded, undefined,
            "the field appearing is the whole signal, so it must not appear before there is one");
    });
});

test("once the game decides, every later tool result carries it, dated where it happened", function () {
    withSession(function (session) {
        const game = session.game;

        // Speed 4 so a day costs 66 slices rather than 528; the clock gate is what lets the
        // wait run at all, since the game is held paused between these calls.
        structured(callTool(session, "set_game_speed", { speed: 4 }));
        game.decideScenarioOn(1, "failed");

        const waited = structured(callTool(session, "wait", { days: 3 }));
        const onTheWait = waited.scenarioEnded as Record<string, unknown> | undefined;

        assert.ok(onTheWait, "the call the game decided during must carry it");
        assert.equal(onTheWait.status, "failed");
        assert.equal(onTheWait.day, 2, "day number 1 is day 2 of the month, and that is when it happened");
        assert.ok(game.dayNumber() >= 3, "the wait has to have run past the decision: " + String(game.dayNumber()));

        // A different tool, a turn later. The verdict is on the result whatever was called.
        const status = structured(callTool(session, "park_status"));
        const later = status.scenarioEnded as Record<string, unknown> | undefined;

        assert.ok(later, "a model that stops calling park_status has to be told anyway");
        assert.deepEqual(later, onTheWait, "and told the same thing, not re-dated to today");
        assert.equal((status.scenario as Record<string, unknown>).status, "failed");
    });
});

test("a completed scenario reads as completed, which is the other half of the verdict", function () {
    withSession(function (session) {
        session.game.decideScenarioOn(1, "completed");
        runDays(session.game, 2);

        const body = structured(callTool(session, "park_status"));
        const verdict = body.scenarioEnded as Record<string, unknown> | undefined;

        assert.ok(verdict);
        assert.equal(verdict.status, "completed");
    });
});

/* -------------------------------------------------------------------------------------
 * And on `GET /v1`, for a harness that has no session.
 */

test("GET /v1 answers the scenario question without spending an MCP session", function () {
    withSession(function (session) {
        const before = versionIndex(session.app).scenario as Record<string, unknown>;

        assert.equal(before.status, "inProgress");
        assert.equal(before.endedOn, null, "a scenario still being played has no end date");
        assert.equal(before.name, "Forest Frontiers");

        session.game.decideScenarioOn(2, "failed");
        runDays(session.game, 4);

        const after = versionIndex(session.app).scenario as Record<string, unknown>;

        assert.equal(after.status, "failed");
        assert.deepEqual(after.endedOn, { year: 1, month: 0, day: 3 },
            "the index has to carry WHEN, or the harness has only what park_status already gave it");
    });
});

test("reading GET /v1 does not disturb the clock the model is shown", function () {
    withSession(function (session) {
        structured(callTool(session, "park_status"));

        const ticksBefore = session.game.date.ticksElapsed;

        versionIndex(session.app);
        versionIndex(session.app);

        assert.equal(session.game.date.ticksElapsed, ticksBefore, "an index read must not run the game");

        const body = structured(callTool(session, "park_status"));

        assert.equal(body.gameDaysSinceLastCall, 0,
            "the poll must not land in the model's own session and reset the figure it is shown");
    });
});

test("readScenarioIndexEntry says unknown rather than in-progress when there is no scenario", function () {
    const scope = globalThis as unknown as Record<string, unknown>;
    const previous = scope.scenario;

    resetScenarioWatch();
    delete scope.scenario;

    try {
        assert.deepEqual(readScenarioIndexEntry(), {
            name: null, objective: null, status: null, endedOn: null
        }, "a missing scenario read as still running would keep a harness waiting forever");
    } finally {
        scope.scenario = previous;
        resetScenarioWatch();
    }
});

/* -------------------------------------------------------------------------------------
 * `paused` under the clock gate.
 */

test("park_status does not call the game paused for the hold the bridge keeps on it", function () {
    withSession(function (session) {
        const body = structured(callTool(session, "park_status"));

        assert.equal(session.game.gameValues.paused, true,
            "the fake's own flag has to be set, or this test proves nothing");
        assert.equal(body.paused, false,
            "reporting the between-calls hold as `paused` says the game is stuck on every single turn");
    });
});

test("park_status does report a pause the model asked for, which is the one that refuses", function () {
    withSession(function (session) {
        structured(callTool(session, "set_game_speed", { paused: true }));

        const body = structured(callTool(session, "park_status"));

        assert.equal(session.game.gameValues.paused, true);
        assert.equal(body.paused, true,
            "a pause the model set refuses map changes and refuses wait, and has to read as one");

        structured(callTool(session, "set_game_speed", { paused: false }));

        const after = structured(callTool(session, "park_status"));

        assert.equal(session.game.gameValues.paused, true,
            "the bridge holds the clock again the moment that call answers");
        assert.equal(after.paused, false, "but nothing is being refused any more, and the field says so");
    });
});

test("build_flat_ride builds through the bridge's hold and refuses only the model's own pause", function () {
    withSession(function (session) {
        const game = session.game;
        game.rideObjects = [{ index: 0, name: "Merry-Go-Round", rideType: [33] }];

        for (let y = 3; y <= 12; y++) {
            game.addPath(10, y);
        }

        assert.equal(game.gameValues.paused, true, "the hold has to be in force for this to mean anything");

        const built = structured(callTool(session, "build_flat_ride", {
            rideObject: 0, x: 14, y: 8, rotation: 0, price: 10, open: true,
            entranceX: 14, entranceY: 6, exitX: 12, exitY: 8
        }));

        assert.equal(built.ok, true, "the hold refuses nothing: " + JSON.stringify(built.steps));
        assert.equal(game.rides.length, 1, "and the ride really is in the park");

        structured(callTool(session, "set_game_speed", { paused: true }));

        const refused = structured(callTool(session, "build_flat_ride", {
            rideObject: 0, x: 20, y: 8, rotation: 0, price: 10, open: true,
            entranceX: 20, entranceY: 6, exitX: 18, exitY: 8
        }));

        assert.equal(refused.ok, false, "a pause the model set does refuse a build");
        assert.equal(game.rides.length, 1, "and must leave nothing stranded behind it");
    });
});
