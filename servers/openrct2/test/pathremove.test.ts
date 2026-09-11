import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import type { FakeElement, FakeRide } from "./fakeGame.ts";
import { buildPath, DEFAULT_PATH_OBJECT, DEFAULT_QUEUE_OBJECT } from "../src/park/pathbuild.ts";
import { removePath, straightRun } from "../src/park/pathremove.ts";
import type { RemovePathOutcome } from "../src/park/pathremove.ts";
import type { Tile } from "../src/park/paths.ts";
import { getMcpToolDefinitions } from "../src/tools/decorators.ts";
import { getMcpTools } from "../src/tools/index.ts";
import { PathRemoveTools } from "../src/tools/pathRemove.ts";
import type { DeferredMcpResult } from "../src/tools/types.ts";

function withGame(build: (game: FakeGame) => void, run: (game: FakeGame) => void, options?: { inert?: boolean }): void {
    const game = new FakeGame(24, 24, options);
    build(game);
    const restore = game.install();

    try {
        run(game);
    } finally {
        restore();
    }
}

/** `context.setTimeout` applies the queued actions, so the outcome is ready on return. */
function take(points: Tile[]): RemovePathOutcome {
    let outcome: RemovePathOutcome | null = null;

    removePath({ points: points }, function (result) { outcome = result; });

    assert.ok(outcome, "removePath never called back");
    return outcome as unknown as RemovePathOutcome;
}

/** The same call as the model makes it: raw arguments, through the MCP tool layer. */
function callTool(args: Record<string, unknown>): RemovePathOutcome {
    let outcome: RemovePathOutcome | null = null;

    new PathRemoveTools().removePath(args).start(function (result) {
        outcome = result as RemovePathOutcome;
    });

    assert.ok(outcome, "remove_path never answered");
    return outcome as unknown as RemovePathOutcome;
}

function footpathAt(game: FakeGame, x: number, y: number): FakeElement | undefined {
    return game.tile(x, y).elements.filter(function (element) { return element.type === "footpath"; })[0];
}

function entranceAt(game: FakeGame, x: number, y: number): FakeElement | undefined {
    return game.tile(x, y).elements.filter(function (element) { return element.type === "entrance"; })[0];
}

/** A gate at 10,4 with a straight run of path leading south from it. */
function parkWithSpine(game: FakeGame, lastY = 12): void {
    game.addParkEntrance(10, 4);

    for (let y = 5; y <= lastY; y++) {
        game.addPath(10, y);
    }
}

/**
 * A ride at 10,7 whose entrance building stands at 10,8 facing it, so its door opens onto
 * 10,9. The station's own `entrance` has to be set here: only `rideentranceexitplace` fills
 * it in, and these fixtures put the building on the map directly.
 */
function rideWithQueueAt(game: FakeGame, queue: Tile): FakeRide {
    const ride: FakeRide = {
        id: 0, name: "Ferris Wheel", type: 1, status: "open", price: [10],
        stations: [{
            start: { x: 10 * 32, y: 7 * 32, z: 96 },
            entrance: { x: 10 * 32, y: 8 * 32, z: 96, direction: 3 },
            exit: null, length: 0, queueTime: 0
        }],
        excitement: 500, intensity: 300, totalCustomers: 0, totalProfit: 0,
        downtime: 0, reliability: 100, flags: 0, value: 40
    };

    game.rides.push(ride);
    layQueue(game, queue.x, queue.y);
    // Placing the building is what makes the game walk the chain and bind the queue to it.
    game.addRideEntrance(10, 8, 0, 3);
    return ride;
}

/**
 * Turn a tile into a queue, replacing whatever footpath was there.
 *
 * `addPath` appends, and a tile carrying two footpath elements is a shape the game never
 * produces: the first one would answer every read while the second was the one the fixture
 * meant, which is a fixture that tests nothing.
 */
function layQueue(game: FakeGame, x: number, y: number): void {
    game.tile(x, y).elements = game.tile(x, y).elements.filter(function (element) {
        return element.type !== "footpath";
    });
    game.addPath(x, y, true);
}

test("a run of tiles loses its footpath, tile by tile, and its neighbours keep theirs", function () {
    withGame(parkWithSpine, function (game) {
        take([{ x: 10, y: 7 }, { x: 10, y: 9 }]);

        for (let y = 7; y <= 9; y++) {
            assert.equal(footpathAt(game, 10, y), undefined,
                "tile 10," + String(y) + " still carries a footpath");
        }

        assert.ok(footpathAt(game, 10, 6), "10,6 was outside the run and must be untouched");
        assert.ok(footpathAt(game, 10, 10), "10,10 was outside the run and must be untouched");
    });
});

test("a run the game never applied is reported as nothing removed", function () {
    withGame(parkWithSpine, function (game) {
        const outcome = take([{ x: 10, y: 7 }, { x: 10, y: 9 }]);

        assert.equal(outcome.ok, false, "the paths are all still there, so this is not ok");
        assert.equal(outcome.tilesRemoved, 0);

        for (let y = 7; y <= 9; y++) {
            assert.ok(footpathAt(game, 10, y), "an inert game must leave 10," + String(y) + " paved");
        }
    }, { inert: true });
});

test("taking up the queue at a ride's door leaves the ride without one, and says so", function () {
    withGame(function (game) {
        parkWithSpine(game, 12);
        rideWithQueueAt(game, { x: 10, y: 9 });
    }, function (game) {
        const queueBefore = footpathAt(game, 10, 9);
        assert.equal(queueBefore?.isQueue, true, "the fixture has to start with a queue at the door");
        assert.equal(queueBefore?.ride, 0, "and it has to be bound to the ride");

        const outcome = take([{ x: 10, y: 9 }, { x: 10, y: 9 }]);

        assert.equal(footpathAt(game, 10, 9), undefined, "the queue tile is still on the map");
        assert.equal(outcome.ridesLeftWithoutQueue.length, 1,
            "the ride lost the only queue bound to it and nothing said so");
        assert.equal(outcome.ridesLeftWithoutQueue[0].id, 0);
        assert.deepEqual(outcome.ridesLeftWithoutQueue[0].entranceDoor, { x: 10, y: 9 });
        assert.match(outcome.detail, /no longer has a queue/);
    });
});

test("a ride that never had a queue is not reported as having lost one", function () {
    withGame(function (game) {
        parkWithSpine(game, 12);
        rideWithQueueAt(game, { x: 11, y: 9 });
    }, function (game) {
        assert.equal(footpathAt(game, 10, 9)?.isQueue, false,
            "the fixture puts an ordinary path at the door, not a queue");

        const outcome = take([{ x: 10, y: 9 }, { x: 10, y: 9 }]);

        assert.deepEqual(outcome.ridesLeftWithoutQueue, [],
            "nothing was bound to the ride before the call, so nothing was lost by it");
    });
});

test("a run across a ride entrance building is refused by name and removes nothing", function () {
    withGame(function (game) {
        parkWithSpine(game, 12);
        rideWithQueueAt(game, { x: 10, y: 9 });
    }, function (game) {
        const outcome = take([{ x: 10, y: 6 }, { x: 10, y: 10 }]);

        assert.equal(outcome.ok, false);
        assert.match(String(outcome.error), /10,8/, "the refusal has to name the tile that stopped it");
        assert.match(String(outcome.error), /entrance BUILDING/);
        assert.ok(entranceAt(game, 10, 8), "the entrance building must still be standing");

        for (let y = 6; y <= 10; y++) {
            if (y === 8) {
                continue;
            }

            assert.ok(footpathAt(game, 10, y),
                "a refused run must remove nothing, and 10," + String(y) + " is gone");
        }
    });
});

test("a run across the park gate is refused and the gate is left alone", function () {
    withGame(parkWithSpine, function (game) {
        const outcome = take([{ x: 11, y: 4 }, { x: 11, y: 4 }]);

        assert.equal(outcome.ok, false);
        assert.match(String(outcome.error), /park entrance BUILDING/);
        assert.ok(entranceAt(game, 11, 4), "the gate must still be standing");
    });
});

test("the tile this call took up is not counted as a tile it cut off", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);
        game.addPath(10, 6);
    }, function (game) {
        const outcome = take([{ x: 10, y: 6 }, { x: 10, y: 6 }]);

        assert.equal(footpathAt(game, 10, 6), undefined);
        assert.equal(outcome.reachableFromEntrance, 1, "10,5 is all that is left of the network");
        assert.doesNotMatch(outcome.detail, /cut off/,
            "10,6 was removed, not stranded, and calling that a severance warns about the tool's own work");
    });
});

test("severing the park is reported as tiles cut off", function () {
    withGame(parkWithSpine, function () {
        const outcome = take([{ x: 10, y: 8 }, { x: 10, y: 8 }]);

        // 10,5 10,6 10,7 remain walkable; 10,9 through 10,12 are stranded.
        assert.equal(outcome.reachableFromEntrance, 3);
        assert.match(outcome.detail, /4 path tiles guests could reach before are now cut off/);
    });
});

test("a run over ground with no path removes nothing and says so", function () {
    withGame(parkWithSpine, function () {
        const outcome = take([{ x: 15, y: 15 }, { x: 15, y: 17 }]);

        assert.equal(outcome.ok, true, "there is no footpath left on those tiles, which is what was asked");
        assert.equal(outcome.tilesRemoved, 0);
        assert.match(outcome.detail, /None of the 3 tiles/);
    });
});

test("a build_path route handed back as waypoints takes up exactly what it laid", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);
    }, function (game) {
        let built: { route: Tile[] } | null = null;

        buildPath({
            points: [{ x: 10, y: 6 }, { x: 14, y: 9 }],
            queue: false,
            surfaceObject: DEFAULT_PATH_OBJECT,
            railingsObject: 0
        }, function (result) { built = result; });

        const route = (built as unknown as { route: Tile[] }).route;
        assert.ok(route.length > 4, "the fixture needs a route with a corner in it");

        callTool({ waypoints: route });

        for (let i = 0; i < route.length; i++) {
            assert.equal(footpathAt(game, route[i].x, route[i].y), undefined,
                "build_path laid " + String(route[i].x) + "," + String(route[i].y) + " and it is still there");
        }
    });
});

test("a diagonal run turns once, along x and then along y", function () {
    // The one layout decision this tool makes, pinned so it cannot drift into routing.
    assert.deepEqual(straightRun([{ x: 2, y: 2 }, { x: 4, y: 4 }]), [
        { x: 2, y: 2 }, { x: 3, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 3 }, { x: 4, y: 4 }
    ]);
});

test("a queue tile is taken up as readily as a path tile", function () {
    withGame(function (game) {
        parkWithSpine(game, 12);
        game.addPath(12, 6, true);
    }, function (game) {
        take([{ x: 12, y: 6 }, { x: 12, y: 6 }]);

        assert.equal(footpathAt(game, 12, 6), undefined, "a queue is a footpath and must come up too");
    });
});

test("remove_path refuses a run with only one end, naming what is missing", function () {
    withGame(parkWithSpine, function (game) {
        const outcome = callTool({ fromX: 10, fromY: 7 });

        assert.equal(outcome.ok, false);
        assert.match(String(outcome.error), /toX, toY are missing/);
        assert.ok(footpathAt(game, 10, 7), "a refused call must not have touched the map");
    });
});

test("remove_path refuses a single waypoint rather than guessing the other end", function () {
    withGame(parkWithSpine, function (game) {
        const outcome = callTool({ waypoints: [{ x: 10, y: 7 }] });

        assert.equal(outcome.ok, false);
        assert.match(String(outcome.error), /at least two points/);
        assert.ok(footpathAt(game, 10, 7));
    });
});

test("a coordinate that is not a whole number is refused, not walked towards forever", function () {
    // Found by mutation: with the tool's own argument check removed, a missing end reached
    // the run as NaN, and stepping towards a tile you can never equal hung the game process
    // rather than failing the call.
    withGame(parkWithSpine, function (game) {
        const outcome = take([{ x: Number.NaN, y: 7 }, { x: 10, y: 9 }]);

        assert.equal(outcome.ok, false);
        assert.match(String(outcome.error), /whole tile coordinates/);
        assert.ok(footpathAt(game, 10, 9), "a refused run must not have touched the map");
    });
});

test("remove_path is registered as a deferred tool called remove_path", function () {
    const definitions = getMcpToolDefinitions(PathRemoveTools);

    assert.equal(definitions.length, 1);
    assert.equal(definitions[0].name, "remove_path");
    assert.equal(definitions[0].inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(definitions[0].inputSchema.properties || {}).sort(),
        ["fromX", "fromY", "toX", "toY", "waypoints"]);
    assert.deepEqual(definitions[0].inputSchema.required, [],
        "the two forms are alternatives, so neither set can be required");

    const registered = getMcpTools().filter(function (tool) { return tool.name === "remove_path"; });
    assert.equal(registered.length, 1, "the tool has to be in the registry or the model never sees it");

    const game = new FakeGame(8, 8);
    const restore = game.install();

    try {
        const deferred = new PathRemoveTools().removePath({ fromX: 1, fromY: 1, toX: 1, toY: 1 }) as DeferredMcpResult;
        assert.equal(deferred.deferred, true, "removal lands on a later tick, so the tool has to wait for it");
    } finally {
        restore();
    }
});

test("a queue laid over a path, then taken up, leaves the ride bound to nothing", function () {
    // The sequence the transcripts actually show: build_path lays a queue across a live
    // route, and the only way back is to take those tiles up again.
    withGame(function (game) {
        parkWithSpine(game, 12);
        rideWithQueueAt(game, { x: 10, y: 9 });
    }, function (game) {
        buildPath({
            points: [{ x: 10, y: 9 }, { x: 10, y: 11 }],
            queue: true,
            surfaceObject: DEFAULT_QUEUE_OBJECT,
            railingsObject: 0
        }, function () { /* the fixture, not the assertion */ });

        assert.equal(footpathAt(game, 10, 11)?.isQueue, true, "the fixture needs the queue laid over the spine");

        const outcome = take([{ x: 10, y: 10 }, { x: 10, y: 11 }]);

        for (let y = 10; y <= 11; y++) {
            assert.equal(footpathAt(game, 10, y), undefined, "10," + String(y) + " is still paved");
        }

        assert.equal(footpathAt(game, 10, 9)?.isQueue, true, "the door's own queue tile was not in the run");
        assert.deepEqual(outcome.ridesLeftWithoutQueue, [],
            "the tile at the door survived, so the ride still has its queue");
    });
});
