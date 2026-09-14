import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { FakeGame } from "./fakeGame.ts";
import type { FakeElement, FakeRide } from "./fakeGame.ts";
import { buildPath, DEFAULT_PATH_OBJECT, DEFAULT_QUEUE_OBJECT } from "../src/park/pathbuild.ts";
import { removePath } from "../src/park/pathremove.ts";
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
function take(tiles: Tile[]): RemovePathOutcome {
    let outcome: RemovePathOutcome | null = null;

    removePath({ tiles: tiles }, function (result) { outcome = result; });

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

/**
 * Every tile of a straight run, so a fixture can name a line without spelling it out.
 *
 * This is in the test and not in the tool on purpose: filling a line in between two ends
 * is the thing both path tools stopped doing, so a fixture that wants one says so itself.
 */
function line(from: Tile, to: Tile): Tile[] {
    const tiles: Tile[] = [{ x: from.x, y: from.y }];
    let x = from.x;
    let y = from.y;

    while (x !== to.x) {
        x += Math.sign(to.x - x);
        tiles.push({ x: x, y: y });
    }

    while (y !== to.y) {
        y += Math.sign(to.y - y);
        tiles.push({ x: x, y: y });
    }

    return tiles;
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
        excitement: 500, intensity: 300, nausea: 200, totalCustomers: 0, totalProfit: 0,
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
        take(line({ x: 10, y: 7 }, { x: 10, y: 9 }));

        for (let y = 7; y <= 9; y++) {
            assert.equal(footpathAt(game, 10, y), undefined,
                "tile 10," + String(y) + " still carries a footpath");
        }

        assert.ok(footpathAt(game, 10, 6), "10,6 was outside the run and must be untouched");
        assert.ok(footpathAt(game, 10, 10), "10,10 was outside the run and must be untouched");
    });
});

/**
 * The mirror of build_path's tile list: what is named comes up and what is not stays.
 *
 * Both tools used to take two ends and work out the tiles between them - build_path by
 * routing, remove_path by drawing the literal line - so a removal could take up paving the
 * caller never named. Two named tiles with a paved tile between them is the case that tells
 * the two apart.
 */
test("a tile between two named tiles keeps its path", function () {
    withGame(parkWithSpine, function (game) {
        const outcome = take([{ x: 10, y: 6 }, { x: 10, y: 8 }]);

        assert.equal(outcome.tilesTargeted, 2, "the tile between them is not part of the run");
        assert.equal(outcome.tilesRemoved, 2);
        assert.deepEqual(outcome.tiles, [{ x: 10, y: 6 }, { x: 10, y: 8 }]);
        assert.equal(footpathAt(game, 10, 6), undefined, "10,6 was named and is still paved");
        assert.equal(footpathAt(game, 10, 8), undefined, "10,8 was named and is still paved");
        assert.ok(footpathAt(game, 10, 7), "10,7 was never named and this call took it up anyway");
    });
});

test("a run the game never applied is reported as nothing removed", function () {
    withGame(parkWithSpine, function (game) {
        const outcome = take(line({ x: 10, y: 7 }, { x: 10, y: 9 }));

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

        const outcome = take([{ x: 10, y: 9 }]);

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

        const outcome = take([{ x: 10, y: 9 }]);

        assert.deepEqual(outcome.ridesLeftWithoutQueue, [],
            "nothing was bound to the ride before the call, so nothing was lost by it");
    });
});

test("a run across a ride entrance building is refused by name and removes nothing", function () {
    withGame(function (game) {
        parkWithSpine(game, 12);
        rideWithQueueAt(game, { x: 10, y: 9 });
    }, function (game) {
        const outcome = take(line({ x: 10, y: 6 }, { x: 10, y: 10 }));

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
        const outcome = take([{ x: 11, y: 4 }]);

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
        const outcome = take([{ x: 10, y: 6 }]);

        assert.equal(footpathAt(game, 10, 6), undefined);
        assert.equal(outcome.reachableFromEntrance, 1, "10,5 is all that is left of the network");
        assert.doesNotMatch(outcome.detail, /cut off/,
            "10,6 was removed, not stranded, and calling that a severance warns about the tool's own work");
    });
});

test("severing the park is reported as tiles cut off", function () {
    withGame(parkWithSpine, function () {
        const outcome = take([{ x: 10, y: 8 }]);

        // 10,5 10,6 10,7 remain walkable; 10,9 through 10,12 are stranded.
        assert.equal(outcome.reachableFromEntrance, 3);
        assert.match(outcome.detail, /4 path tiles guests could reach before are now cut off/);
    });
});

/**
 * The defect this file exists to stop repeating, measured on a real run: the model took the
 * spine tile its park entrance ran through, read `reachableFromEntrance: 27` with no figure
 * to compare it against and not one tile named, and concluded that a ride queue elsewhere
 * had "permanently lost" the eight tiles its own call had just stranded. It never relaid the
 * tile. Only this call can answer either half: the network was walked before the removal and
 * again after it, and nothing else on the map records which tiles fell out between.
 */
test("the tiles guests can no longer reach are named, not merely counted", function () {
    withGame(parkWithSpine, function () {
        const outcome = take([{ x: 10, y: 8 }]);

        assert.match(outcome.detail,
            /cut off from the park entrance: 10,9 10,10 10,11 10,12\./,
            "the count names a category; the tiles are the fact the model has to act on");
        assert.match(outcome.detail, /3 path tiles are reachable from the park entrance, against 8 before this call/,
            "a reachability figure with nothing to read it against is what was there before");
        assert.match(outcome.detail,
            /10,8 was itself reachable from the park entrance before this call and carries no path now/,
            "and which tile this call took out of the walk, which the run above blamed on a queue");
    });
});

test("a removal that strands nothing raises no severance warning, however much it takes up", function () {
    // A ring, so the tile taken out has a way round it. The reachable count still drops by
    // the tile itself, and a warning keyed to that drop rather than to what it stranded
    // would cry severance over every successful removal there is.
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);

        const ring = [
            { x: 10, y: 6 }, { x: 11, y: 6 }, { x: 12, y: 6 }, { x: 12, y: 7 },
            { x: 12, y: 8 }, { x: 11, y: 8 }, { x: 10, y: 8 }, { x: 10, y: 7 }
        ];

        for (let i = 0; i < ring.length; i++) {
            game.addPath(ring[i].x, ring[i].y);
        }
    }, function () {
        const outcome = take([{ x: 12, y: 7 }]);

        assert.equal(outcome.reachableFromEntrance, 8, "the other eight tiles of the ring are still walkable");
        assert.match(outcome.detail, /8 path tiles are reachable from the park entrance, against 9 before this call/,
            "the drop is the tile that came up, and saying both figures is what makes that readable");
        assert.doesNotMatch(outcome.detail, /cut off/,
            "nothing was stranded: guests walk round the other side of the ring");
    });
});

test("a removal that changes no reachability says the figure is unchanged", function () {
    withGame(parkWithSpine, function () {
        const outcome = take(line({ x: 15, y: 15 }, { x: 15, y: 17 }));

        assert.match(outcome.detail, /8 path tiles are reachable from the park entrance, the same as before this call/,
            "a run over bare ground costs the network nothing, and that is worth saying plainly");
        assert.doesNotMatch(outcome.detail, /cut off/);
    });
});

test("a severance longer than the message will spell out says how many more there are", function () {
    withGame(function (game) {
        parkWithSpine(game, 20);
    }, function () {
        const outcome = take([{ x: 10, y: 6 }]);

        // 10,7 through 10,20 are stranded: fourteen tiles, and the message names twelve.
        assert.match(outcome.detail, /14 path tiles guests could reach before are now cut off/);
        assert.match(outcome.detail,
            /10,7 10,8 10,9 10,10 10,11 10,12 10,13 10,14 10,15 10,16 10,17 10,18 and 2 more\./,
            "an unbounded list of tiles is how one message swallows the rest of the result");
    });
});

test("a run over ground with no path removes nothing and says so", function () {
    withGame(parkWithSpine, function () {
        const outcome = take(line({ x: 15, y: 15 }, { x: 15, y: 17 }));

        assert.equal(outcome.ok, true, "there is no footpath left on those tiles, which is what was asked");
        assert.equal(outcome.tilesRemoved, 0);
        assert.match(outcome.detail, /None of the 3 tiles/);
    });
});

test("a build_path result's tiles handed straight back take up exactly what it laid", function () {
    // The two tools share one field name for one reason: the undo is a copy, not a
    // reconstruction. A model that has to re-derive the run it just laid re-derives it
    // wrong, and the tiles it misses are the ones it cannot see.
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);
    }, function (game) {
        const drawn = [
            { x: 10, y: 6 }, { x: 11, y: 6 }, { x: 11, y: 7 }, { x: 12, y: 7 },
            { x: 12, y: 8 }, { x: 14, y: 9 }
        ];
        let built: { tiles: Tile[] } | null = null;

        buildPath({
            tiles: drawn,
            queue: false,
            surfaceObject: DEFAULT_PATH_OBJECT,
            railingsObject: 0
        }, function (result) { built = result; });

        const tiles = (built as unknown as { tiles: Tile[] }).tiles;
        assert.deepEqual(tiles, drawn, "the fixture rests on build_path reporting what it laid");

        callTool({ tiles: tiles });

        for (let i = 0; i < tiles.length; i++) {
            assert.equal(footpathAt(game, tiles[i].x, tiles[i].y), undefined,
                "build_path laid " + String(tiles[i].x) + "," + String(tiles[i].y) + " and it is still there");
        }

        // Including the tile nothing touches: a run that filled in the line between the
        // tiles named would have missed 14,9 or taken 13,9 with it.
        assert.equal(footpathAt(game, 13, 9), undefined, "13,9 was never laid, so it must not be reported either");
    });
});

test("a queue tile is taken up as readily as a path tile", function () {
    withGame(function (game) {
        parkWithSpine(game, 12);
        game.addPath(12, 6, true);
    }, function (game) {
        take([{ x: 12, y: 6 }]);

        assert.equal(footpathAt(game, 12, 6), undefined, "a queue is a footpath and must come up too");
    });
});

test("remove_path refuses a call with no tile list, naming what is missing", function () {
    withGame(parkWithSpine, function (game) {
        const outcome = callTool({});

        assert.equal(outcome.ok, false);
        assert.match(String(outcome.error), /`tiles` is missing/);
        assert.match(String(outcome.error), /build_path result's own `tiles` can be passed here whole/,
            "the undo is a copy, and the call that is missing its list is where that has to be said");
        assert.ok(footpathAt(game, 10, 7), "a refused call must not have touched the map");
    });
});

test("remove_path refuses a malformed tile rather than coercing it", function () {
    withGame(parkWithSpine, function (game) {
        // A missing y coerced to -1 would run the removal off the map.
        const outcome = callTool({ tiles: [{ x: 10, y: 7 }, { x: 10 }] });

        assert.equal(outcome.ok, false);
        assert.match(String(outcome.error), /tiles\[1\]/, "the bad tile is identified by position");
        assert.match(String(outcome.error), /numeric x and y/);
        assert.ok(footpathAt(game, 10, 7));
    });
});

test("a single tile is a run, so removing one queue tile needs no second coordinate", function () {
    // The old shape needed both ends of a line and a one-tile removal was written as the
    // same point twice. A queue at a door is one tile, and it is the commonest thing here
    // that gets taken up.
    withGame(function (game) {
        parkWithSpine(game, 12);
        layQueue(game, 12, 6);
    }, function (game) {
        const outcome = take([{ x: 12, y: 6 }]);

        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(outcome.tilesTargeted, 1);
        assert.equal(outcome.tilesRemoved, 1);
        assert.equal(footpathAt(game, 12, 6), undefined, "the one tile named still carries a queue");
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
    assert.deepEqual(Object.keys(definitions[0].inputSchema.properties || {}).sort(), ["tiles"]);
    assert.deepEqual(definitions[0].inputSchema.required, ["tiles"],
        "the tile list is the call, and it is build_path's own field under the same name");

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
            tiles: [{ x: 10, y: 9 }, { x: 10, y: 10 }, { x: 10, y: 11 }],
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

test("the park gate is named as the park gate, in a park with no rides in it at all", function () {
    // Measured against the running game: an entrance element's `ride` is the raw ride index
    // for all three kinds, so the gate of an empty park reads back as ride 0 and the old
    // guard - `typeof entrance.ride !== "number"` - never fired. The refusal called the
    // park's own gate "the entrance BUILDING of ride 0" and told the model to demolish ride
    // 0, which cannot remove a gate and, in a park with a ride 0 in it, destroys that ride.
    withGame(parkWithSpine, function (game) {
        assert.equal(game.rides.length, 0, "the case that exposed this had no rides at all");

        const outcome = take([{ x: 11, y: 4 }]);
        const message = String(outcome.error);

        assert.equal(outcome.ok, false);
        assert.match(message, /11,4/, "the refusal has to name the tile that stopped it");
        assert.match(message, /park entrance BUILDING/);
        assert.doesNotMatch(message, /ride \d/,
            "there is no ride here to name, and naming one sends the model at the wrong thing");
        assert.doesNotMatch(message, /operate_ride/,
            "demolishing a ride cannot remove the park gate, so offering that call sends the model"
            + " at something that will fail, or at a ride it did not mean to lose");
        assert.match(message, /demolishing a ride will not/,
            "the advice it replaces was followed, so say plainly that it does not work");
        assert.ok(entranceAt(game, 11, 4), "the gate must still be standing");
    });
});

test("a gate tile is still the gate when a ride 0 exists to be confused with it", function () {
    // The defect printed "ride 0" whether or not a ride 0 existed. Checking `map.rides` would
    // silence the empty-park case above and leave the destructive one standing, so this pins
    // that the answer comes from the element's own `object` and not from the ride list.
    withGame(function (game) {
        parkWithSpine(game, 12);
        rideWithQueueAt(game, { x: 10, y: 9 });
    }, function (game) {
        assert.equal(game.rides[0].id, 0, "the fixture needs a ride 0 for the old message to have named");

        const outcome = take([{ x: 11, y: 4 }]);

        assert.match(String(outcome.error), /park entrance BUILDING/);
        assert.doesNotMatch(String(outcome.error), /ride 0/,
            "the gate belongs to no ride, however many rides the park has");
        assert.equal(game.rides.length, 1, "a refusal must not have touched the ride list");
    });
});

test("a ride door is still named with its ride, and its exit told apart from its entrance", function () {
    // The other side of the same branch: fixing the gate must not cost the ride-door wording,
    // which is the message that actually has a next call to name.
    withGame(function (game) {
        parkWithSpine(game, 12);
        rideWithQueueAt(game, { x: 10, y: 9 });
        game.addRideEntrance(12, 6, 0, 3, true);
    }, function () {
        assert.match(String(take([{ x: 10, y: 8 }]).error),
            /entrance BUILDING of ride 0[\s\S]*operate_ride `demolish`/);
        assert.match(String(take([{ x: 12, y: 6 }]).error),
            /exit BUILDING of ride 0/);
    });
});

test("an entrance kind this build does not know is refused without inheriting the ride wording", function () {
    // `object` is an enum, and the bug was a two-way branch treating "not 1" as "0". Anything
    // that is neither a ride door nor the gate must refuse on its own terms rather than be
    // guessed at as a ride entrance.
    withGame(parkWithSpine, function (game) {
        game.tile(12, 8).elements.push({ type: "entrance", baseZ: 96, object: 7, sequence: 0, ride: 0 });

        const outcome = take([{ x: 12, y: 8 }]);

        assert.equal(outcome.ok, false);
        assert.match(String(outcome.error), /12,8/);
        assert.match(String(outcome.error), /unrecognised kind \(`object` 7\)/);
        assert.doesNotMatch(String(outcome.error), /of ride/,
            "an unknown entrance kind must not be reported as a ride's door");
    });
});

test("a refusal reports no reachable count at all, rather than a zero that reads as a severed park", function () {
    // `reachableFromEntrance: 0` on a refusal is a measurement that was never taken, in the
    // one message the model reads when it is already off track.
    withGame(parkWithSpine, function () {
        const refused = take([{ x: 11, y: 4 }]);

        assert.equal(refused.ok, false);
        assert.equal(refused.reachableFromEntrance, null,
            "nothing was walked, so there is no figure to report");

        const argumentError = callTool({});
        assert.equal(argumentError.reachableFromEntrance, null,
            "an argument refusal never reaches the map either");

        // And the field still carries the real count when the call did the work.
        const done = take([{ x: 10, y: 12 }]);
        assert.equal(done.ok, true);
        assert.equal(done.reachableFromEntrance, 7, "10,5 through 10,11 are what is left");
    });
});

test("the fake's park gate carries a ride index, because the real one does", function () {
    // This is the assertion the four tests above rest on. Measured: an entrance element's
    // `ride` is the raw ride index for all three kinds of entrance, so the real gate reads
    // back as ride 0. While the fake left it undefined, `typeof ride !== "number"` stood in
    // for "this is the gate" and every gate test here passed with the defect in place -
    // which is exactly what happened for as long as the defect shipped. Take this away and
    // the gate tests stop being able to fail.
    withGame(parkWithSpine, function (game) {
        const gate = entranceAt(game, 11, 4);

        assert.equal(gate?.object, 2, "`object` 2 is the park entrance, and the only field that says so");
        assert.equal(gate?.ride, 0,
            "the game reports a ride index for the gate too; a fake that omits it is gentler"
            + " than the game and hides the branch these tests exist to check");
    });
});

/**
 * The pause, which remove_path used to report as a bare count.
 *
 * `footpathremove` carries no `Flags::AllowWhilePaused`, so OpenRCT2's
 * `GameActionRunner.cpp::CheckActionInPausedMode` turns down every tile and answers
 * "Construction not possible while game is paused!". The tool threw that answer away and
 * said only how many tiles still carried a path, which names a category and not a fix.
 */
test("a paused removal reports the game's own refusal, not just a count", function () {
    withGame(function (game) {
        parkWithSpine(game);
        game.gameValues.paused = true;
    }, function (game) {
        const outcome = take(line({ x: 10, y: 7 }, { x: 10, y: 9 }));

        assert.equal(outcome.ok, false, "a paused removal takes nothing up, so it is not a success");
        assert.equal(outcome.tilesRemoved, 0);
        assert.ok(footpathAt(game, 10, 7), "the path is still on the map, which is what the refusal meant");
        assert.equal(game.gameValues.paused, true, "and the clock is left exactly where the model put it");

        assert.match(outcome.detail, /Removed 0 of 3 footpath tiles/, "the count is still reported");
        assert.match(outcome.detail, /Construction not possible while game is paused!/,
            "but the count alone is a category: the game's own words are the fact");
        assert.match(outcome.detail, /footpathremove/, "and the action the pause refuses is not named");
        assert.match(outcome.detail, /set_game_speed \{paused: false\}/,
            "nor the one call a paused game does not refuse");
    });
});

test("a removal refused for another reason is quoted, and gains no pause clause", function () {
    // A clause appended unconditionally would satisfy the test above and be wrong here, and
    // the discarded result was never a pause bug: any refusal was thrown away the same way.
    withGame(function (game) {
        parkWithSpine(game);
        game.refuse.footpathremove = true;
    }, function (game) {
        const outcome = take(line({ x: 10, y: 7 }, { x: 10, y: 9 }));

        assert.equal(game.gameValues.paused, false, "the fixture has to be a running game");
        assert.equal(outcome.tilesRemoved, 0);
        assert.match(outcome.detail, /The game refused the removal: Refused: test refusal\./,
            "a refusal the game gave has to be quoted whatever the reason was");
        assert.doesNotMatch(outcome.detail, /paused/, "an unpaused failure must not blame the clock");
        assert.doesNotMatch(outcome.detail, /set_game_speed/,
            "nor send the model to a lever it does not need");
    });
});

test("tiles that stay put with no refusal read say that, rather than borrowing a reason", function () {
    withGame(parkWithSpine, function (game) {
        const outcome = take(line({ x: 10, y: 7 }, { x: 10, y: 9 }));

        assert.equal(game.attempted.length, 3, "the removals were sent; only the read-back shows they did nothing");
        assert.match(outcome.detail, /The game gave no refusal for 3 of them/,
            "nothing was read, so nothing may be quoted - and saying so is the honest report");
        assert.doesNotMatch(outcome.detail, /The game refused the removal/,
            "no refusal was read, so none may be reported");
    }, { inert: true });
});

/**
 * `remove_path` exists because two path mistakes had no remedy. One of the two was
 * described by a rule the game does not implement: a queue was said to split the park
 * because guests cannot walk through one. They can. What dead-ends is the single tile a
 * ride's entrance claims for its door, and only once a ride owns the line.
 *
 * Both halves are pinned - the mechanic that is true, and the sentence that is not - because
 * the false one is the half that comes back.
 */
test("remove_path names the entrance claim as what severs, not the queue", function () {
    const definitions = getMcpToolDefinitions(PathRemoveTools);

    assert.equal(definitions.length, 1, "remove_path is registered once");

    const text = String(definitions[0].description);

    assert.match(text, /An ordinary path laid over a queue unbinds that queue from its ride/,
        "the first mistake removal undoes");
    assert.match(text, /entrance claiming a queue, not the queue itself, dead-ends the tile its door opens onto/,
        "and the second, named by the cause the game actually implements");
    assert.doesNotMatch(text, /cannot walk through/,
        "guests cross a queue no ride has claimed like any other path, measured in the running game");
    assert.doesNotMatch(text, /splits the park/,
        "one tile dead-ends; the line is not a wall");
});

test("the module note on why removal exists carries the same rule", function () {
    // Nothing imports a comment, so an edit to one breaks no build and fails no test. This
    // paragraph is where the next reader of pathremove.ts learns why the tool is here, and
    // it carried the disproven rule for as long as the description did.
    // The leading `*` of each comment line goes with the newline, so rewrapping the
    // paragraph cannot fail this.
    const source = readFileSync(fileURLToPath(new URL("../src/park/pathremove.ts", import.meta.url)), "utf8")
        .replace(/\n\s*\*/g, " ")
        .replace(/\s+/g, " ");

    assert.match(source, /a ride's entrance claiming a queue - not the queue itself - dead-ends the tile its door opens onto/,
        "the mechanic, in the same words the tool description uses");
    assert.doesNotMatch(source, /guests cannot walk through/,
        "and not the rule the game does not implement");
    assert.doesNotMatch(source, /splits the park/,
        "nor the consequence that rule was used to claim");
});
