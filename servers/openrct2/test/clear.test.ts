import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import { FakeSocket } from "./fakeSocket.ts";
import { createApplication } from "../src/app.ts";
import { centredSquare, clearRect } from "../src/park/clear.ts";
import { ClearTools } from "../src/tools/clear.ts";
import { getMcpToolDefinitions } from "../src/tools/decorators.ts";
import type { ClearAreaOutcome } from "../src/park/clear.ts";

/** A flat, owned, entirely bare park. Each test puts in its own obstructions. */
function withPark(run: (game: FakeGame) => void, options?: { inert?: boolean }): void {
    const game = new FakeGame(24, 24, options);
    const restore = game.install();

    try {
        run(game);
    } finally {
        restore();
    }
}

/** `clearRect` answers from inside `context.setTimeout`, which the fake runs straight away. */
function clear(cx: number, cy: number, size: number): ClearAreaOutcome {
    let outcome: ClearAreaOutcome | null = null;

    clearRect(centredSquare(cx, cy, size), function (result) { outcome = result; });

    assert.ok(outcome, "clearRect never finished");
    return outcome as unknown as ClearAreaOutcome;
}

/** Puts one piece of scenery on every tile of a square, so what survives can be counted. */
function fillScenery(game: FakeGame, left: number, top: number, span: number, type?: string): void {
    for (let x = left; x < left + span; x++) {
        for (let y = top; y < top + span; y++) {
            game.addScenery(x, y, type);
        }
    }
}

function countElements(game: FakeGame, type: string): number {
    let total = 0;

    for (let x = 0; x < game.width; x++) {
        for (let y = 0; y < game.height; y++) {
            const elements = game.tile(x, y).elements;

            for (let i = 0; i < elements.length; i++) {
                if (elements[i].type === type) {
                    total++;
                }
            }
        }
    }

    return total;
}

function hasElement(game: FakeGame, x: number, y: number, type: string): boolean {
    const elements = game.tile(x, y).elements;

    for (let i = 0; i < elements.length; i++) {
        if (elements[i].type === type) {
            return true;
        }
    }

    return false;
}

test("a square of size n clears exactly n by n tiles", function () {
    // An earlier off-by-one spanned size+1 on even sizes: asking for 4 felled 25 trees.
    // Then asking the game for track type 0 - real flat track, one tile - collapsed every
    // size to a single tile while still reporting size*size. Both counts are asserted.
    const expected = [1, 4, 9, 16, 25];

    for (let size = 1; size <= 5; size++) {
        withPark(function (game) {
            fillScenery(game, 6, 6, 9);
            const before = countElements(game, "small_scenery");
            const outcome = clear(10, 10, size);

            assert.equal(outcome.tilesRequested, expected[size - 1],
                "size " + String(size) + " should be a square of " + String(expected[size - 1]) + " tiles");
            assert.equal(before - countElements(game, "small_scenery"), expected[size - 1],
                "size " + String(size) + " should have removed one piece of scenery per tile of that square");
            assert.equal(outcome.ok, true, outcome.detail);
        });
    }
});

test("the square is centred on the tile it was given", function () {
    withPark(function (game) {
        fillScenery(game, 7, 7, 7);

        const outcome = clear(10, 10, 3);

        assert.equal(outcome.ok, true, outcome.detail);

        for (let x = 9; x <= 11; x++) {
            for (let y = 9; y <= 11; y++) {
                assert.equal(hasElement(game, x, y, "small_scenery"), false,
                    "the tile at " + String(x) + "," + String(y) + " is inside the square and should be bare");
            }
        }

        assert.equal(hasElement(game, 8, 10, "small_scenery"), true, "the tile west of the square was not asked for");
        assert.equal(hasElement(game, 12, 10, "small_scenery"), true, "the tile east of the square was not asked for");
        assert.equal(hasElement(game, 10, 8, "small_scenery"), true, "the tile north of the square was not asked for");
        assert.equal(hasElement(game, 10, 12, "small_scenery"), true, "the tile south of the square was not asked for");
    });
});

test("small scenery, large scenery, walls and banners all go", function () {
    withPark(function (game) {
        game.addScenery(9, 9, "small_scenery");
        game.addScenery(10, 9, "large_scenery");
        game.addScenery(11, 9, "wall");
        game.addScenery(9, 10, "banner");

        const outcome = clear(10, 10, 3);

        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(outcome.tilesStillBlocked, 0, "every tile of the square ended up bare");
        assert.equal(countElements(game, "small_scenery"), 0, "the small scenery was removed");
        assert.equal(countElements(game, "large_scenery"), 0, "the large scenery was removed");
        assert.equal(countElements(game, "wall"), 0, "the wall was removed");
        assert.equal(countElements(game, "banner"), 0, "the banner was removed");
        assert.match(outcome.detail, /Cleared 9 tiles/);
    });
});

test("a path and a ride are left standing and counted as still blocking", function () {
    withPark(function (game) {
        game.addScenery(9, 9);
        game.addPath(10, 10);
        game.tile(11, 11).elements.push({ type: "track", baseZ: 96, ride: 0, trackType: 262 });

        const outcome = clear(10, 10, 3);

        assert.equal(outcome.ok, false, "two tiles are still occupied, so this is not a clean sweep");
        assert.equal(outcome.tilesStillBlocked, 2, "the path tile and the ride tile are both still in the way");
        assert.equal(hasElement(game, 10, 10, "footpath"), true, "the path was not touched");
        assert.equal(hasElement(game, 11, 11, "track"), true, "the ride was not touched");
        assert.equal(countElements(game, "small_scenery"), 0, "the scenery it can remove was still removed");

        const names = game.attempted.map(function (action) { return action.name; });
        assert.deepEqual(names, ["smallsceneryremove"], "it only ever asks to remove scenery, walls and banners");

        assert.match(outcome.detail, /occupied by something that is not scenery/);
        assert.doesNotMatch(outcome.detail, /Cleared/, "it must not claim to have cleared a square it did not clear");
    });
});

test("land outside the park is reported as unowned, not blamed on a ride or a path", function () {
    withPark(function (game) {
        game.own(9, 9, false);
        game.own(9, 10, false);

        const outcome = clear(10, 10, 3);

        assert.equal(outcome.ok, false);
        assert.equal(outcome.tilesStillBlocked, 2, "the two tiles outside the park are still not usable");
        assert.match(outcome.detail, /2 of 9 tiles are outside the park's land/);
        assert.doesNotMatch(outcome.detail, /a ride, a path/,
            "unowned land is not something a demolition would fix, so it must not be described as one");
        assert.doesNotMatch(outcome.detail, /Cleared/);
    });
});

test("a square that hangs off the edge of the map counts the missing tiles", function () {
    withPark(function (game) {
        fillScenery(game, 0, 0, 4);

        // Centred on 1,1 a four-wide square runs -1..2, so its whole north and west edges are off the map.
        const outcome = clear(1, 1, 4);

        assert.equal(outcome.tilesRequested, 16);
        assert.equal(outcome.ok, false, "seven of the sixteen tiles are not part of the park");
        assert.equal(outcome.tilesStillBlocked, 7, "the tiles beyond the map edge are counted, not quietly dropped");
        assert.match(outcome.detail, /outside the park's land/);
        assert.equal(hasElement(game, 0, 0, "small_scenery"), false, "the tiles that are on the map were cleared");
    });
});

test("an already bare square is reported as cleared without touching anything", function () {
    withPark(function (game) {
        const outcome = clear(10, 10, 3);

        assert.equal(outcome.ok, true);
        assert.equal(outcome.tilesRequested, 9);
        assert.equal(outcome.tilesStillBlocked, 0);
        assert.equal(game.attempted.length, 0, "there was nothing to remove, so nothing was asked for");
    });
});

test("when nothing is applied, it does not claim to have cleared anything", function () {
    // The whole bug class: removals accepted, never taking effect, reported as success.
    withPark(function (game) {
        fillScenery(game, 9, 9, 3);

        const outcome = clear(10, 10, 3);

        assert.ok(game.attempted.length > 0, "the removals were asked for");
        assert.equal(outcome.ok, false, "a clearance that did not happen is not a success");
        assert.equal(outcome.tilesStillBlocked, 9, "all nine tiles still have their scenery");
        assert.equal(countElements(game, "small_scenery"), 9, "and the scenery really is still there");
        assert.doesNotMatch(outcome.detail, /Cleared/);
        assert.doesNotMatch(outcome.detail, /a ride, a path/,
            "scenery that is still standing is not a ride, and saying so sends the model somewhere else");
    }, { inert: true });
});

test("a removal the park cannot pay for is reported as the money it was, not as a ride in the way", function () {
    // Measured in the running game: clear_scenery on 37,72 - plain small scenery on owned,
    // flat, clear land - came back saying the tile was "occupied by something that is not
    // scenery", while the game had answered {error: 4, "Not enough cash - requires £15.00"}.
    // Set cash and the identical call went through. A model told a ride is in the way
    // bulldozes elsewhere and never finds out it only needed money.
    withPark(function (game) {
        game.sceneryRemovalCost = 150;
        game.parkValues.cash = 100;
        game.addScenery(10, 10);

        const outcome = clear(10, 10, 1);

        assert.equal(hasElement(game, 10, 10, "small_scenery"), true, "the scenery is still on the ground");
        assert.equal(game.parkValues.cash, 100, "and the park never paid for a removal that did not happen");
        assert.equal(outcome.ok, false);
        assert.equal(outcome.tilesRefused, 1, "one tile kept its scenery because the game said no");
        assert.equal(outcome.tilesOccupied, 0, "and nothing on it was a ride, a path or a park structure");
        assert.equal(outcome.notEnoughCash, true, "which is the one fact that makes this fixable");
        assert.deepEqual(outcome.refusals, ["Can't remove this: Not enough cash - requires £15.00"],
            "the game's own words, not a paraphrase");
        assert.match(outcome.detail, /Not enough cash/);
        assert.doesNotMatch(outcome.detail, /a ride, a path/,
            "the tile held nothing but scenery, so no structure may be blamed for it");
    });
});

test("with the money there, the identical call clears the same tile", function () {
    // The other half of the measurement: money was the whole of it, so the tool must not
    // be reporting a permanent obstruction.
    withPark(function (game) {
        game.sceneryRemovalCost = 150;
        game.parkValues.cash = 1000;
        game.addScenery(10, 10);

        const outcome = clear(10, 10, 1);

        assert.equal(hasElement(game, 10, 10, "small_scenery"), false, "the scenery came down");
        assert.equal(game.parkValues.cash, 850, "and the park paid the game's price for it");
        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(outcome.notEnoughCash, false);
        assert.deepEqual(outcome.refusals, []);
    });
});

test("some tiles blocked and some unaffordable reports both counts and both reasons", function () {
    // The mixed case must not collapse into whichever reason is counted first: one of these
    // is fixed with cash and the other never is.
    withPark(function (game) {
        game.sceneryRemovalCost = 150;
        game.parkValues.cash = 150;
        game.addScenery(9, 9);
        game.addScenery(9, 10);
        game.addPath(10, 10);
        game.tile(11, 11).elements.push({ type: "track", baseZ: 96, ride: 0, trackType: 262 });

        const outcome = clear(10, 10, 3);

        // 150 pays for exactly one of the two pieces of scenery, so the other is refused.
        assert.equal(countElements(game, "small_scenery"), 1, "one piece was affordable and one was not");
        assert.equal(game.parkValues.cash, 0, "every penny the park had went on the one it could pay for");
        assert.equal(hasElement(game, 10, 10, "footpath"), true, "the path was never touched");
        assert.equal(hasElement(game, 11, 11, "track"), true, "nor was the ride");

        assert.equal(outcome.ok, false);
        assert.equal(outcome.tilesOccupied, 2, "the path tile and the ride tile");
        assert.equal(outcome.tilesRefused, 1, "and the one piece of scenery the park could not pay for");
        assert.equal(outcome.tilesStillBlocked, 3, "all three are still in the way");
        assert.equal(outcome.notEnoughCash, true);
        assert.match(outcome.detail, /occupied by something that is not scenery/,
            "the ride and the path still get the message that is right for them");
        assert.match(outcome.detail, /Not enough cash/,
            "and the unaffordable tile still gets the message that is right for it");
    });
});

test("a refusal the tool has no name for is quoted rather than explained away", function () {
    // Money is only the reason that was measured. Anything else the game says comes back in
    // its own words, the way src/park/build.ts quotes a refused trackplace.
    withPark(function (game) {
        game.refuse.smallsceneryremove = true;
        game.addScenery(10, 10);

        const outcome = clear(10, 10, 1);

        assert.equal(hasElement(game, 10, 10, "small_scenery"), true, "the scenery survived");
        assert.equal(outcome.tilesRefused, 1);
        assert.equal(outcome.tilesOccupied, 0);
        assert.equal(outcome.notEnoughCash, false, "the game never said anything about money");
        assert.deepEqual(outcome.refusals, ["Refused: test refusal"]);
        assert.match(outcome.detail, /Refused: test refusal/);
    });
});

test("each size clears exactly the square it names, tile for tile", function () {
    // Written out rather than computed from the tool: a square of n is n tiles across,
    // starting floor(n/2) tiles before the one it was given. Counting the right number of
    // felled trees in the wrong place would pass the count test above.
    const expected: Record<number, { left: number; right: number }> = {
        1: { left: 10, right: 10 },
        2: { left: 9, right: 10 },
        3: { left: 9, right: 11 },
        4: { left: 8, right: 11 },
        5: { left: 8, right: 12 }
    };

    for (let size = 1; size <= 5; size++) {
        withPark(function (game) {
            fillScenery(game, 5, 5, 11);
            const outcome = clear(10, 10, size);
            assert.equal(outcome.ok, true, outcome.detail);

            const bounds = expected[size];

            for (let x = 5; x < 16; x++) {
                for (let y = 5; y < 16; y++) {
                    const inside = x >= bounds.left && x <= bounds.right && y >= bounds.left && y <= bounds.right;

                    assert.equal(hasElement(game, x, y, "small_scenery"), !inside,
                        "size " + String(size) + ": tile " + String(x) + "," + String(y)
                            + (inside ? " is inside the square and should be bare" : " is outside it and should be untouched"));
                }
            }
        });
    }
});

test("clearing a square never takes the ground with it", function () {
    for (let size = 1; size <= 5; size++) {
        withPark(function (game) {
            fillScenery(game, 6, 6, 9);
            const before = countElements(game, "surface");

            const outcome = clear(10, 10, size);

            assert.equal(outcome.ok, true, outcome.detail);
            assert.equal(countElements(game, "surface"), before,
                "size " + String(size) + " removed part of the landscape along with the scenery");
            assert.equal(before, game.width * game.height, "every tile should still have its one surface");
        });
    }
});

/*
 * The rest of this file drives clear_scenery through MCP, the way the model reaches it.
 *
 * A centred square is the wrong shape for a ride. `find_build_sites` reports a site's
 * origin, and a flat ride's footprint runs from that origin rather than around it: a 4x4
 * covers origin..origin+3 on both axes, a 2x2 covers origin..origin+1, and a 1x4 runs from
 * two tiles before it to one after. So `size: 4` at a 4x4 site clears sixteen tiles of
 * which only four are the ride's, and `size: 4` at a 1x4 site clears sixteen to cover
 * four. Those numbers are measured - they are OpenRCT2's own track piece offsets, which
 * test/fakeGame.ts transcribes from ride/ted/TED.FlatRide.h - and are written out here as
 * literal tiles rather than computed, so a change to the footprint tables cannot quietly
 * move the ground these tests say was cleared.
 */

const mcpHeaders = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json"
};

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

function rawRequest(body: string, headers: Record<string, string>): string {
    const lines = ["POST /mcp HTTP/1.1"].concat(Object.keys(headers).map(function (name) {
        return name + ": " + headers[name];
    }));

    return lines.join("\r\n") + "\r\n\r\n" + body;
}

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

/** A 32x32 park, every tile owned and wooded, reachable over a real MCP session. */
function withSession(run: (session: Session) => void): void {
    const game = new FakeGame(32, 32);

    for (let x = 0; x < game.width; x++) {
        for (let y = 0; y < game.height; y++) {
            game.addScenery(x, y);
        }
    }

    const restore = game.install();

    try {
        const app = createApplication();
        run({ app: app, headers: openSession(app), game: game });
    } finally {
        restore();
    }
}

/** Call a tool and return its result, whichever path it answered on. */
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

function structured(result: ToolResult): Record<string, unknown> {
    assert.notEqual(result.isError, true, "the tool refused: " + JSON.stringify(result.content));
    assert.ok(result.structuredContent, "the tool answered with no structured result");
    return result.structuredContent as Record<string, unknown>;
}

/** The message behind a refusal, whether the schema caught it or the tool did. */
function refusal(result: ToolResult): string {
    if (result.isError === true) {
        assert.ok(result.content && result.content.length > 0, "a refusal with no message is unusable");
        return (result.content as { text: string }[])[0].text;
    }

    const body = result.structuredContent as { ok?: boolean; error?: string } | undefined;

    assert.ok(body, "the call was neither refused nor answered: " + JSON.stringify(result));
    assert.equal(body.ok, false, "the arguments were accepted: " + JSON.stringify(body));
    assert.equal(typeof body.error, "string", "a refusal with no message is unusable");
    return String(body.error);
}

/** Exactly which tiles lost their scenery, read back off the map. */
function baredTiles(game: FakeGame): string[] {
    const bare: string[] = [];

    for (let x = 0; x < game.width; x++) {
        for (let y = 0; y < game.height; y++) {
            if (!hasElement(game, x, y, "small_scenery")) {
                bare.push(String(x) + "," + String(y));
            }
        }
    }

    return bare.sort();
}

/** Every tile of an inclusive rectangle, named the same way, for comparing against. */
function rectTiles(left: number, top: number, right: number, bottom: number): string[] {
    const tiles: string[] = [];

    for (let x = left; x <= right; x++) {
        for (let y = top; y <= bottom; y++) {
            tiles.push(String(x) + "," + String(y));
        }
    }

    return tiles.sort();
}

test("the rectangle form clears exactly the rectangle it names, tile for tile", function () {
    const cases = [
        { name: "a 4x4 ride's footprint, which runs from its origin", args: { fromX: 10, fromY: 10, toX: 13, toY: 13 }, tiles: rectTiles(10, 10, 13, 13) },
        { name: "a 2x2, which runs from its origin too", args: { fromX: 6, fromY: 20, toX: 7, toY: 21 }, tiles: rectTiles(6, 20, 7, 21) },
        { name: "a 1x4 ferris wheel, two tiles before its origin to one after", args: { fromX: 8, fromY: 16, toX: 11, toY: 16 }, tiles: rectTiles(8, 16, 11, 16) },
        { name: "a single tile", args: { fromX: 3, fromY: 3, toX: 3, toY: 3 }, tiles: rectTiles(3, 3, 3, 3) },
        { name: "a long thin strip", args: { fromX: 20, fromY: 4, toX: 20, toY: 15 }, tiles: rectTiles(20, 4, 20, 15) }
    ];

    cases.forEach(function (scenario) {
        withSession(function (session) {
            const body = structured(callTool(session, "clear_scenery", scenario.args));

            assert.equal(body.ok, true, scenario.name + ": " + String(body.detail));
            assert.deepEqual(baredTiles(session.game), scenario.tiles,
                scenario.name + ": the ground that lost its scenery is not the rectangle that was asked for");
            assert.equal(body.tilesRequested, scenario.tiles.length, scenario.name);
        });
    });
});

test("a rectangle given back to front clears the same ground as one given the right way round", function () {
    withSession(function (session) {
        const body = structured(callTool(session, "clear_scenery", { fromX: 13, fromY: 13, toX: 10, toY: 10 }));

        assert.equal(body.ok, true, String(body.detail));
        assert.deepEqual(baredTiles(session.game), rectTiles(10, 10, 13, 13),
            "two opposite corners name one rectangle whichever order they arrive in");
        assert.deepEqual(body.area, { left: 10, top: 10, right: 13, bottom: 13 },
            "and the rectangle it reports back is the one it worked on");
    });
});

test("a 4x4 site needs the rectangle form: the centred square misses most of its footprint", function () {
    // The defect this form exists for. A dodgems placed at site 10,10 stands on 10..13 on
    // both axes. `size: 4` reports sixteen tiles cleared and is telling the truth about the
    // count while clearing the wrong sixteen: twelve of them are the ride's neighbours.
    const footprint = rectTiles(10, 10, 13, 13);

    withSession(function (session) {
        const square = structured(callTool(session, "clear_scenery", { x: 10, y: 10, size: 4 }));

        assert.equal(square.tilesRequested, 16);
        assert.deepEqual(baredTiles(session.game), rectTiles(8, 8, 11, 11),
            "a square of 4 centred on 10,10 is 8..11, which is not where the ride goes");

        const stillWooded = footprint.filter(function (tile) {
            return baredTiles(session.game).indexOf(tile) < 0;
        });

        assert.equal(stillWooded.length, 12,
            "twelve of the ride's sixteen tiles still have trees on them after a square of 4");
    });

    withSession(function (session) {
        const body = structured(callTool(session, "clear_scenery", { fromX: 10, fromY: 10, toX: 13, toY: 13 }));

        assert.equal(body.ok, true, String(body.detail));
        assert.deepEqual(baredTiles(session.game), footprint,
            "the rectangle form clears the footprint and nothing else");
    });
});

test("a 1x4 ride's ground is four tiles, not the sixteen a square of 4 would fell", function () {
    withSession(function (session) {
        structured(callTool(session, "clear_scenery", { fromX: 8, fromY: 16, toX: 11, toY: 16 }));

        assert.equal(baredTiles(session.game).length, 4,
            "a square of 4 would have taken sixteen trees to clear ground for four tiles");
        assert.deepEqual(baredTiles(session.game), rectTiles(8, 16, 11, 16));
    });
});

test("the square form still clears the centred square, through the tool, for sizes 1 to 5", function () {
    const expected: Record<number, { first: number; last: number }> = {
        1: { first: 10, last: 10 },
        2: { first: 9, last: 10 },
        3: { first: 9, last: 11 },
        4: { first: 8, last: 11 },
        5: { first: 8, last: 12 }
    };

    for (let size = 1; size <= 5; size++) {
        withSession(function (session) {
            const body = structured(callTool(session, "clear_scenery", { x: 10, y: 10, size: size }));
            const bounds = expected[size];

            assert.equal(body.ok, true, "size " + String(size) + ": " + String(body.detail));
            assert.deepEqual(baredTiles(session.game), rectTiles(bounds.first, bounds.first, bounds.last, bounds.last),
                "size " + String(size) + " cleared ground that is not the centred square it names");
            assert.deepEqual(body.area, { left: bounds.first, top: bounds.first, right: bounds.last, bottom: bounds.last });
        });
    }
});

test("part of a rectangle is refused by the names of the arguments that are missing", function () {
    withSession(function (session) {
        const withoutY = refusal(callTool(session, "clear_scenery", { fromX: 10, fromY: 10, toX: 13 }));

        assert.match(withoutY, /toY/, "the missing argument has to be named");

        const onlyCorner = refusal(callTool(session, "clear_scenery", { toX: 13, toY: 13 }));

        assert.match(onlyCorner, /fromX/, "both of the ones that are missing, not just the first");
        assert.match(onlyCorner, /fromY/);

        assert.equal(session.game.attempted.length, 0, "and no tree was felled while working that out");
        assert.equal(baredTiles(session.game).length, 0);
    });
});

test("part of a square is refused the same way", function () {
    withSession(function (session) {
        const withoutSize = refusal(callTool(session, "clear_scenery", { x: 10, y: 10 }));

        assert.match(withoutSize, /size/, "a square with no width is not a square");
        assert.doesNotMatch(withoutSize, /fromX/,
            "and it is a square that is half given, so the rectangle form is not what to talk about");

        const withoutY = refusal(callTool(session, "clear_scenery", { x: 10, size: 3 }));

        assert.match(withoutY, /y/);
        assert.equal(session.game.attempted.length, 0);
    });
});

test("giving both forms at once is refused rather than one of them being picked", function () {
    withSession(function (session) {
        // The forms share no arguments, so a call carrying both is unambiguously two
        // requests rather than an overload to resolve. A tool that quietly preferred one
        // would clear ground the caller did not name, and clearing is destructive.
        const message = refusal(callTool(session, "clear_scenery", {
            x: 10, y: 10, size: 4, fromX: 10, fromY: 10, toX: 13, toY: 13
        }));

        assert.match(message, /size/);
        assert.match(message, /fromX/);
        assert.match(message, /toX/);
        assert.equal(session.game.attempted.length, 0);
        assert.equal(baredTiles(session.game).length, 0, "nothing was cleared on either reading of it");
    });
});

test("no arguments at all is an error naming both forms", function () {
    withSession(function (session) {
        const message = refusal(callTool(session, "clear_scenery", {}));

        assert.match(message, /size/);
        assert.match(message, /fromX/);
        assert.match(message, /toY/);
        assert.equal(session.game.attempted.length, 0);
    });
});

test("a size outside 1 to 16 is refused by name, not clamped to the nearest legal one", function () {
    // A transcript has the tool reporting tilesRequested: 256 for a requested size of 30.
    // Clearing a different square from the one asked for is destructive and silent; the
    // refusal says the property and the range so the next call can be right.
    withSession(function (session) {
        const tooBig = refusal(callTool(session, "clear_scenery", { x: 10, y: 10, size: 30 }));

        assert.match(tooBig, /size/, "the property at fault has to be named");
        assert.match(tooBig, /1 to 16/, "and the range it had to be in");
        assert.match(tooBig, /30/, "and the value that arrived");

        const tooSmall = refusal(callTool(session, "clear_scenery", { x: 10, y: 10, size: 0 }));

        assert.match(tooSmall, /size/);
        assert.match(tooSmall, /1 to 16/);

        assert.equal(session.game.attempted.length, 0, "a refused call clears nothing");
        assert.equal(baredTiles(session.game).length, 0, "and no tile lost its scenery to a clamped square");
    });
});

test("a tile coordinate off the bottom of the map is refused, not floored to the edge", function () {
    withSession(function (session) {
        const negative = refusal(callTool(session, "clear_scenery", { x: -3, y: 10, size: 3 }));

        assert.match(negative, /x/);
        assert.match(negative, /0 or more/);

        const corner = refusal(callTool(session, "clear_scenery", { fromX: 10, fromY: 10, toX: 13, toY: -1 }));

        assert.match(corner, /toY/);
        assert.equal(session.game.attempted.length, 0);
    });
});

test("a rectangle bigger than one call clears is refused with its size and the cap", function () {
    withSession(function (session) {
        const message = refusal(callTool(session, "clear_scenery", { fromX: 0, fromY: 0, toX: 31, toY: 31 }));

        assert.match(message, /1024/, "the number of tiles asked for");
        assert.match(message, /256/, "and the number it will do");
        assert.equal(session.game.attempted.length, 0, "nothing was half-cleared before it gave up");
        assert.equal(baredTiles(session.game).length, 0);
    });

    withSession(function (session) {
        // The cap is exactly what a square of 16 already came to, so that stays legal.
        const body = structured(callTool(session, "clear_scenery", { fromX: 8, fromY: 8, toX: 23, toY: 23 }));

        assert.equal(body.ok, true, String(body.detail));
        assert.equal(baredTiles(session.game).length, 256);
    });
});

test("the rectangle form reports what is still standing rather than what it asked for", function () {
    withSession(function (session) {
        session.game.addPath(11, 11);
        session.game.tile(12, 12).elements.push({ type: "track", baseZ: 96, ride: 0, trackType: 262 });

        const body = structured(callTool(session, "clear_scenery", { fromX: 10, fromY: 10, toX: 13, toY: 13 }));

        assert.equal(body.ok, false, "two of the sixteen tiles are still occupied");
        assert.equal(body.tilesStillBlocked, 2);
        assert.equal(hasElement(session.game, 11, 11, "footpath"), true, "the path was left alone");
        assert.equal(hasElement(session.game, 12, 12, "track"), true, "and so was the ride");
        assert.doesNotMatch(String(body.detail), /Cleared/);
    });
});

test("a site's four bounds go straight into clear_scenery and clear the ride's ground", function () {
    // The contract the two tools share, and the reason the rectangle form is named the way
    // it is: `find_build_sites` reports `fromX`, `fromY`, `toX` and `toY`, and they are
    // handed over field for field with nothing computed on the way. Anything the model has
    // to transform first is a step it can get wrong, and getting it wrong here fells the
    // wrong trees or leaves the ride's ground blocked.
    const game = new FakeGame(32, 32);

    // A dodgems: 4x4, and its footprint runs from its origin rather than around it, so the
    // site's `x`,`y` is inside the ground it needs without being a corner of it.
    game.rideObjects = [{ index: 0, name: "Dodgems", rideType: [25] }];
    game.addParkEntrance(10, 2);

    for (let x = 0; x < game.width; x++) {
        for (let y = 0; y < game.height; y++) {
            game.addScenery(x, y);
        }
    }

    for (let y = 3; y <= 20; y++) {
        game.addPath(10, y);
    }

    const restore = game.install();

    try {
        const app = createApplication();
        const session = { app: app, headers: openSession(app), game: game };
        const search = structured(callTool(session, "find_build_sites", { rideObject: 0 }));
        const sites = search.sites as Record<string, number>[];

        assert.ok(sites && sites.length > 0, "no site to clear: " + JSON.stringify(search.note));

        const site = sites[0];

        ["fromX", "fromY", "toX", "toY"].forEach(function (field) {
            assert.equal(typeof site[field], "number",
                "find_build_sites must report `" + field + "` for clear_scenery to copy");
        });

        const body = structured(callTool(session, "clear_scenery", {
            fromX: site.fromX, fromY: site.fromY, toX: site.toX, toY: site.toY
        }));

        assert.equal(body.ok, true, String(body.detail));
        assert.equal(body.tilesRequested, 16, "a dodgems stands on sixteen tiles");
        assert.deepEqual(baredTiles(game), rectTiles(site.fromX, site.fromY, site.toX, site.toY),
            "the ground that lost its scenery is not the ground the site named");

        // And the site's own origin is inside that rectangle without being its corner,
        // which is why `x`,`y` could not have been used as the near corner.
        assert.ok(site.x >= site.fromX && site.x <= site.toX && site.y >= site.fromY && site.y <= site.toY,
            "the build origin has to be inside the footprint");

        const reclear = structured(callTool(session, "clear_scenery", {
            fromX: site.fromX, fromY: site.fromY, toX: site.toX, toY: site.toY
        }));

        assert.equal(reclear.tilesStillBlocked, 0, "and nothing is left standing on it");
    } finally {
        restore();
    }
});

test("the description states what clearing costs and never weighs it up", function () {
    // docs/tool-design.md: what clearing costs is a rule of the game the model cannot read
    // anywhere else, so it stays. Whether felling a tree is worth it is the model's call,
    // and a description that frames it as "a trade" has made half of that call already.
    // Verified against OpenRCT2: SmallSceneryRemoveAction and LargeSceneryRemoveAction
    // charge `removal_price`, WallRemoveAction sets cost 0, BannerRemoveAction refunds
    // three quarters of the price, and CalculateParkRating has no scenery term at all -
    // scenery reaches ratings through ride_ratings_get_scenery_score, which counts small
    // and large scenery within five tiles of a ride's station.
    const definitions = getMcpToolDefinitions(ClearTools).filter(function (definition) {
        return definition.handlerName === "clearScenery";
    });

    assert.equal(definitions.length, 1, "clear_scenery is registered once");

    const text = String(definitions[0].description);

    assert.match(text, /removal price/, "clearing costs money, which is a fact about the game");
    assert.match(text, /five tiles of a ride's station/, "and so is where scenery reaches a ride's ratings");
    assert.match(text, /excitement rating/);
    assert.doesNotMatch(text, /park rating/i,
        "OpenRCT2's park rating has no scenery term: claiming one would teach a false rule");
    assert.doesNotMatch(text, /it is a trade|not free ground|guests like scenery/,
        "whether the ground is worth the money is the model's to weigh");
});
