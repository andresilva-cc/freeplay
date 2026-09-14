import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import type { FakeElement, FakeRide } from "./fakeGame.ts";
import { buildPath, DEFAULT_PATH_OBJECT, DEFAULT_QUEUE_OBJECT } from "../src/park/pathbuild.ts";
import type { BuildPathOutcome } from "../src/park/pathbuild.ts";
import type { Tile } from "../src/park/paths.ts";
import { PathTools } from "../src/tools/path.ts";
import { getMcpToolDefinitions } from "../src/tools/decorators.ts";
import { sanitizeToolResult } from "../src/scripting.ts";

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
function lay(tiles: Tile[], queue = false): BuildPathOutcome {
    let outcome: BuildPathOutcome | null = null;

    buildPath({
        tiles: tiles,
        queue: queue,
        surfaceObject: queue ? DEFAULT_QUEUE_OBJECT : DEFAULT_PATH_OBJECT,
        railingsObject: 0
    }, function (result) { outcome = result; });

    assert.ok(outcome, "buildPath never called back");
    return outcome as unknown as BuildPathOutcome;
}

/**
 * Every tile of a straight run, so a fixture can name a line without spelling it out.
 *
 * This is in the test and not in the tool on purpose: filling a line in between two ends
 * is the thing build_path stopped doing, so a fixture that wants one says so itself.
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

/**
 * `lay`, with the edge the game cuts when a ride claims a queue applied at the moment it
 * would land: after the placements, before build_path reads the map back.
 *
 * The fake binds a queue to its ride - `updateQueueChains` fills the tile's `ride` in - but
 * never derives an edge from that, because deriving edges by hand is the bug all of this
 * replaced. So the cut is stated as data with `severPath`, and it has to be stated inside
 * the run: build_path measures reachability before the placements and again after, and a
 * cut applied once the call has returned is a cut it never saw.
 */
function layAndLetTheRideClaimIt(game: FakeGame, tiles: Tile[], claim: () => void): BuildPathOutcome {
    const realSetTimeout = context.setTimeout;
    let outcome: BuildPathOutcome | null = null;

    context.setTimeout = function (callback: () => void): number {
        game.applyQueuedActions();
        claim();
        callback();
        return 0;
    };

    try {
        buildPath({
            tiles: tiles,
            queue: true,
            surfaceObject: DEFAULT_QUEUE_OBJECT,
            railingsObject: 0
        }, function (result) { outcome = result; });
    } finally {
        context.setTimeout = realSetTimeout;
    }

    assert.ok(outcome, "buildPath never called back");
    return outcome as unknown as BuildPathOutcome;
}

/**
 * The corridor every severance test below is built on: one line of path from the gate to
 * 10,12, and a ride to the east of 10,8 whose entrance door opens onto it. A queue laid on
 * 10,8 is the one the ride claims, and claiming it dead-ends that tile.
 */
function corridorWithADoorOnIt(game: FakeGame): void {
    game.addParkEntrance(10, 4);
    game.addPath(10, 5);

    for (let y = 6; y <= 12; y++) {
        game.addPath(10, y);
    }

    // The building at 11,8 with the ride at 12,8, so the door opens onto the corridor.
    game.addRideEntrance(11, 8, 0, 2);
}

/** The cut the game makes when the entrance at 11,8 claims a queue on 10,8. */
function theRideClaimsTheDoorTile(game: FakeGame): void {
    game.severPath(10, 8, 10, 9);
}

/** The same call as the model makes it: raw arguments, through the MCP tool layer. */
function callTool(args: Record<string, unknown>): BuildPathOutcome {
    let outcome: BuildPathOutcome | null = null;

    new PathTools().buildPath(args).start(function (result) {
        outcome = result as BuildPathOutcome;
    });

    assert.ok(outcome, "build_path never answered");
    return outcome as unknown as BuildPathOutcome;
}

function footpathAt(game: FakeGame, x: number, y: number): FakeElement | undefined {
    return game.tile(x, y).elements.filter(function (element) { return element.type === "footpath"; })[0];
}

function placements(game: FakeGame): { x: number; y: number }[] {
    return game.attempted.filter(function (action) {
        return action.name === "footpathplace";
    }).map(function (action) {
        return { x: (action.args.x as number) / 32, y: (action.args.y as number) / 32 };
    });
}

/**
 * A ride whose entrance building stands where the caller says, with the station's own
 * `entrance` filled in.
 *
 * Only `rideentranceexitplace` fills that field, and these fixtures put the building on the
 * map directly, so without this the ride has an entrance on the map and none in its record -
 * and whether a ride still has a queue is read out of the record.
 */
function rideWithAnEntranceAt(game: FakeGame, id: number, name: string, at: Tile, direction: number): FakeRide {
    const ride: FakeRide = {
        id: id, name: name, type: 1, status: "open", price: [10],
        stations: [{
            start: { x: at.x * 32, y: at.y * 32, z: 96 },
            entrance: { x: at.x * 32, y: at.y * 32, z: 96, direction: direction },
            exit: null, length: 0, queueTime: 0
        }],
        excitement: 500, intensity: 300, nausea: 200, totalCustomers: 0, totalProfit: 0,
        downtime: 0, reliability: 100, flags: 0, value: 40
    };

    game.rides.push(ride);
    game.addRideEntrance(at.x, at.y, id, direction);
    return ride;
}

/** An entrance at (10,4) with one path tile below it, so there is a network to join. */
function parkWithGate(game: FakeGame): void {
    game.addParkEntrance(10, 4);
    game.addPath(10, 5);
}

/** A gate at 10,4 with a straight run of ordinary path leading south from it. */
function parkWithSpine(game: FakeGame, lastY = 12): void {
    game.addParkEntrance(10, 4);

    for (let y = 5; y <= lastY; y++) {
        game.addPath(10, y);
    }
}

test("a run of bare tiles is laid and reported tile for tile", function () {
    withGame(parkWithGate, function (game) {
        const outcome = lay(line({ x: 10, y: 6 }, { x: 10, y: 10 }));

        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(outcome.tilesTargeted, 5);
        assert.equal(outcome.tilesPlaced, 5, "every named tile should carry a path");
        assert.equal(outcome.connectedToPark, true, "it joins the tile below the entrance");
        assert.match(outcome.detail, /^Laid 5 path tiles\./);

        for (let y = 6; y <= 10; y++) {
            const path = footpathAt(game, 10, y);
            assert.ok(path, "no footpath reached tile 10," + String(y));
            assert.equal(path.isQueue, false, "an ordinary path was asked for, not a queue");
        }
    });
});

/**
 * The whole of the change, in one assertion: what the model draws is what goes down.
 *
 * The tool used to take two endpoints and route between them - around scenery, with a turn
 * cost, picking the corners itself - so the shape of every path in the park was chosen by a
 * search in pathbuild.ts. This bites on a tile list that a router would have had every
 * reason to improve: it doubles back on itself, it is not the shortest way between its
 * ends, and it stops one tile short of the network. All three survive.
 */
test("the tiles named are the tiles laid, and no others", function () {
    withGame(parkWithGate, function (game) {
        const drawn = [
            { x: 14, y: 6 }, { x: 14, y: 7 }, { x: 13, y: 7 }, { x: 12, y: 7 },
            { x: 12, y: 8 }, { x: 12, y: 9 }
        ];
        const outcome = lay(drawn);

        assert.equal(outcome.ok, true, outcome.detail);
        assert.deepEqual(outcome.tiles, drawn, "the order the caller drew in is the order reported back");
        assert.deepEqual(placements(game), drawn,
            "the tool paved a tile the caller did not name, or skipped one it did");

        // The short way from 14,6 to 12,9 is five tiles; this is six, with a dog-leg. A
        // router would have straightened it, and straightening it is park layout.
        assert.equal(outcome.tilesPlaced, 6);
        assert.equal(footpathAt(game, 13, 6), undefined, "13,6 is the corner a router would have cut");

        // Nothing was added to reach the gate's network either: the run is an island, and
        // saying so is the tool's job where fixing it is not.
        assert.equal(outcome.connectedToPark, false);
        assert.equal(footpathAt(game, 11, 9), undefined,
            "the tool extended the run towards the park, which is the caller's line to draw");
    });
});

test("a gap in the tiles named is laid as given and reported, not closed up", function () {
    // Two stubs in one call is a legitimate run - a queue at a door and nothing else, or
    // paving two ends of a plaza - so a gap is not refused. It is still the one thing about
    // the run's own shape the caller cannot read back, so it is said.
    withGame(parkWithGate, function (game) {
        const outcome = lay([{ x: 4, y: 4 }, { x: 4, y: 5 }, { x: 8, y: 4 }, { x: 8, y: 5 }]);

        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(outcome.tilesPlaced, 4, "both stubs went down");
        assert.equal(footpathAt(game, 6, 4), undefined, "the gap was paved over to join them up");
        assert.match(outcome.detail, /These tiles are 2 separate runs rather than one line - 4,4 8,4 are each on a different one/,
            "the caller cannot see whether the tiles just drawn touch, so it has to be said");
    });

    // And a run that is one line says nothing about it: a note on every call is a note
    // that gets read as noise on the one call it matters for.
    withGame(parkWithGate, function () {
        const outcome = lay(line({ x: 4, y: 4 }, { x: 4, y: 8 }));

        assert.doesNotMatch(outcome.detail, /separate runs/);
    });
});

test("a tile named twice is laid once", function () {
    withGame(parkWithGate, function (game) {
        const outcome = lay([{ x: 4, y: 4 }, { x: 4, y: 5 }, { x: 4, y: 4 }]);

        assert.equal(outcome.tilesTargeted, 2, "the repeat is not a third tile");
        assert.equal(outcome.tilesPlaced, 2);
        assert.equal(placements(game).length, 2, "and no tile is built over twice");
        assert.deepEqual(outcome.tiles, [{ x: 4, y: 4 }, { x: 4, y: 5 }],
            "the first mention keeps its place in the order the caller drew");
    });
});

test("a path laid out of reach of the entrance is a success that says so", function () {
    withGame(parkWithGate, function () {
        // The run is nowhere near the network: the tiles are still laid.
        const outcome = lay(line({ x: 2, y: 2 }, { x: 2, y: 6 }));

        assert.equal(outcome.ok, true, "the tiles went down, so this is not a failure");
        assert.equal(outcome.tilesPlaced, 5);
        assert.equal(outcome.connectedToPark, false, "but nobody can walk to it");
        assert.match(outcome.detail, /does not reach the park entrance/);
        assert.match(outcome.detail, /no tile of it is in the network guests can walk/,
            "every tile is stranded, so the run itself is what has to be named");
        assert.match(outcome.detail, /`paths.runs`/,
            "fourteen calls in the logs retried an adjacent endpoint for want of this");
        assert.match(outcome.detail, /`kind` is "queue"/,
            "and a bare tile list cost two more: the model aimed an ordinary path at a queue tile,"
            + " because nothing said which of the reachable tiles were queues");
    });
});

test("an unreachable run names the tiles that are cut off, not the whole run", function () {
    // The commonest recovery loop in the corpus: "does not reach the park entrance" with
    // no tile named, so the model moved whichever tile it happened to think of first.
    withGame(parkWithSpine, function () {
        const outcome = lay([{ x: 10, y: 6 }, { x: 4, y: 6 }, { x: 4, y: 7 }]);

        assert.equal(outcome.connectedToPark, false);
        assert.match(outcome.detail, /4,6 4,7 are cut off/, "the tiles at fault are not named");
        assert.doesNotMatch(outcome.detail, /no tile of it is in the network/,
            "10,6 is on the spine and reachable, so do not report the whole run as stranded");
        assert.ok(outcome.detail.indexOf("10,6 is cut off") < 0, "and do not blame the tile that is fine");
    });
});

test("a run that comes up short names the tiles that got no path", function () {
    withGame(function (game) {
        parkWithGate(game);
        game.refuse.footpathplace = true;
    }, function () {
        const outcome = lay(line({ x: 10, y: 5 }, { x: 10, y: 8 }));

        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /Only 1 of 4 tiles carry a path: no path reached 10,6 10,7 10,8/,
            "\"Only N of M\" without the tiles is a category, not a fix");
        // The game answered this call, so its words are the cause. The door-building sentence
        // used to be appended here too, which is a cause the call had never read.
        assert.match(outcome.detail, /The game refused the placement: Refused: test refusal\./,
            "the game gave a reason and the result has to carry it");
        assert.doesNotMatch(outcome.detail, /`entranceDoor` and `exitDoor`/,
            "a cause the game supplied must not be displaced by one nothing checked");
    });
});

test("a run naming a ride entrance building names the door tile instead", function () {
    // Four calls in the logs started from the entrance building rather than the tile in
    // front of it, and got back a tile count that named neither the cause nor the fix.
    withGame(function (game) {
        parkWithGate(game);
        // An entrance at 10,10 facing south: the ride is at 10,11, the door opens onto 10,9.
        game.addRideEntrance(10, 10, 7, 1);
    }, function (game) {
        const outcome = lay(line({ x: 10, y: 10 }, { x: 10, y: 6 }), true);

        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /Tile 10,10 of this run is a ride entrance BUILDING/);
        assert.match(outcome.detail, /which is 10,9/, "the tile to use instead is not named");
        assert.match(outcome.detail, /`entranceDoor`/, "the field park_status reports it as is not named");
        assert.equal(game.attempted.length, 0, "and not one tile was paved while working that out");
        assert.equal(footpathAt(game, 10, 10), undefined, "nothing was laid on the building");
    });
});

test("a run naming a ride exit building names exitDoor", function () {
    withGame(function (game) {
        parkWithGate(game);
        game.addRideEntrance(10, 10, 7, 1, true);
    }, function (game) {
        const outcome = lay(line({ x: 10, y: 6 }, { x: 10, y: 10 }));

        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /Tile 10,10 of this run is a ride exit BUILDING/);
        assert.match(outcome.detail, /which is 10,9/);
        assert.match(outcome.detail, /`exitDoor`/);
        assert.equal(game.attempted.length, 0);
    });
});

test("a run naming the park gate says so rather than reporting a tile that would not pave", function () {
    withGame(parkWithGate, function (game) {
        const outcome = lay(line({ x: 10, y: 4 }, { x: 10, y: 8 }));

        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /is the park entrance BUILDING/);
        assert.match(outcome.detail, /`paths.runs`/);
        assert.match(outcome.detail, /`paths.gate`/);
        assert.equal(game.attempted.length, 0);
        assert.equal(footpathAt(game, 10, 4), undefined);
    });
});

test("turning a path tile into a queue is reported as the change it is", function () {
    // The number was right and the sentence was wrong: tilesPlaced said 1, the tile on
    // the map really did become a queue, and the detail read "Laid 0 queue tiles".
    withGame(function (game) {
        parkWithGate(game);
        for (let y = 6; y <= 8; y++) {
            game.addPath(10, y);
        }
    }, function (game) {
        const outcome = lay(line({ x: 10, y: 6 }, { x: 10, y: 8 }), true);

        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(outcome.tilesPlaced, 3);
        assert.match(outcome.detail, /^Turned 3 path tiles into queue\./);
        assert.ok(!/Laid 0/.test(outcome.detail), "a tile that changed type was not laid \"0\" times");

        // The claim is about the world, so read the world.
        for (let y = 6; y <= 8; y++) {
            const path = footpathAt(game, 10, y);
            assert.ok(path);
            assert.equal(path.isQueue, true, "tile 10," + String(y) + " never became a queue");
        }
    });
});

test("a queue that will not convert is a failure that names the tiles", function () {
    withGame(function (game) {
        parkWithGate(game);
        game.addPath(10, 6);
        game.refuse.footpathplace = true;
    }, function (game) {
        const outcome = lay([{ x: 10, y: 6 }], true);

        assert.equal(outcome.ok, false, "the tile still carries ordinary path, so this is not done");
        assert.equal(outcome.tilesPlaced, 1, "there is a path on it, just not the right kind");
        assert.match(outcome.detail, /10,6 still carries path rather than queue/);
        assert.equal(footpathAt(game, 10, 6)?.isQueue, false, "and that is true on the map");
    });
});

test("a missing tile list is refused by name, not paved from off the map", function () {
    withGame(parkWithGate, function (game) {
        const outcome = callTool({ queue: true });

        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /`tiles` is missing/, "the argument at fault is not named");
        assert.match(outcome.detail, /one tile is a run/,
            "and the shortest legal call, because a queue is often a single tile");
        assert.equal(game.attempted.length, 0, "and nothing was paved on the way to finding out");
    });
});

test("every build_path failure answers in the same shape", function () {
    // The audit found two: argument refusals answered {ok, error} while everything else
    // answered the outcome. A model that has to work out which payload it is holding
    // spends a turn on it.
    withGame(function (game) {
        parkWithGate(game);

        for (let x = 0; x < 24; x++) {
            game.own(x, 12, false);
        }
    }, function () {
        const failures = [
            callTool({}),
            callTool({ tiles: [] }),
            callTool({ tiles: [{ x: 10 }, { x: 12, y: 6 }] }),
            callTool({ tiles: [{ x: 10, y: 12 }], queue: false })
        ];

        failures.forEach(function (outcome, index) {
            const fields = Object.keys(outcome).sort().join(",");

            assert.equal(outcome.ok, false, "failure " + String(index) + " is not a failure");
            assert.equal(fields,
                "connectedToPark,detail,error,ok,ridesLeftWithoutQueue,tiles,tilesPlaced,tilesTargeted",
                "failure " + String(index) + " answers with " + fields);
            assert.equal(typeof outcome.detail, "string", "failure " + String(index) + " has no detail");
            assert.ok(outcome.detail.length > 0);
            assert.equal(outcome.tilesPlaced, 0);
            assert.deepEqual(outcome.tiles, []);
        });
    });
});

test("when nothing is applied, it claims nothing", function () {
    // The whole bug class: actions accepted, never taking effect, reported as success.
    withGame(parkWithGate, function (game) {
        const outcome = lay(line({ x: 10, y: 6 }, { x: 10, y: 10 }));

        assert.equal(outcome.ok, false, "a path that was never laid is not a success");
        assert.equal(outcome.tilesPlaced, 0, "no tile carries a path");
        assert.equal(outcome.tilesTargeted, 5, "the run it tried to lay is still reported");
        assert.match(outcome.detail, /Only 0 of 5 tiles carry a path/);
        assert.equal(game.attempted.length, 5, "it did attempt one action per tile");
    }, { inert: true });
});

test("a refused action is not counted as a laid tile", function () {
    withGame(function (game) {
        parkWithGate(game);
        game.refuse.footpathplace = true;
    }, function () {
        const outcome = lay(line({ x: 10, y: 6 }, { x: 10, y: 10 }));

        assert.equal(outcome.ok, false, "the game rejected every tile");
        assert.equal(outcome.tilesPlaced, 0);
        assert.ok(!/^Laid/.test(outcome.detail), "it must not open by claiming tiles were laid");
    });
});

test("a run that names existing path counts that tile as joined, not failed", function () {
    withGame(function (game) {
        parkWithGate(game);
        for (let y = 6; y <= 8; y++) {
            game.addPath(10, y);
        }
    }, function () {
        const outcome = lay(line({ x: 10, y: 10 }, { x: 10, y: 8 }));

        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(outcome.tilesTargeted, 3);
        assert.equal(outcome.tilesPlaced, 3);
        assert.match(outcome.detail, /Laid 2 path tiles, joined 1 tile that was already path\./);
    });
});

/**
 * The failure this whole change came out of, watched in a live run.
 *
 * Wiring one ride needs two runs that must not collide: a queue from the entrance door to
 * the network, and an ordinary path from the exit door. The tool routed each line for
 * itself, the queue's line was laid over part of the exit's path, the ride claimed the
 * whole chain, and the exit was orphaned - with nothing in the result saying so, because
 * each call had done exactly what it was asked.
 *
 * Drawn tile by tile the two runs share no tile, and this reads the world rather than the
 * sentence: the exit's tiles are still ordinary path, still reachable, and the ride still
 * has the queue that was laid for it.
 */
test("a queue run and a path run drawn separately leave each other alone", function () {
    withGame(function (game) {
        parkWithSpine(game, 12);
        // Entrance building at 13,7 facing +x, so its door opens onto 12,7; exit building
        // at 13,9 the same way, opening onto 12,9.
        rideWithAnEntranceAt(game, 0, "Ferris Wheel", { x: 13, y: 7 }, 2);
        game.addRideEntrance(13, 9, 0, 2, true);
    }, function (game) {
        const exitRun = lay([{ x: 12, y: 9 }, { x: 11, y: 9 }]);

        assert.equal(exitRun.ok, true, exitRun.detail);
        assert.equal(exitRun.connectedToPark, true, "11,9 touches the spine, so guests can get off");

        const queueRun = lay([{ x: 12, y: 7 }, { x: 11, y: 7 }], true);

        assert.equal(queueRun.ok, true, queueRun.detail);
        assert.deepEqual(queueRun.tiles, [{ x: 12, y: 7 }, { x: 11, y: 7 }],
            "the queue took a tile the caller never named");
        assert.deepEqual(queueRun.ridesLeftWithoutQueue, [],
            "nothing lost a queue: this run gave one");

        // The exit's own tiles: still ordinary path, and still walkable from the gate.
        for (let x = 11; x <= 12; x++) {
            const path = footpathAt(game, x, 9);
            assert.ok(path, "the exit lost its path at " + String(x) + ",9");
            assert.equal(path.isQueue, false,
                "the queue run was laid over the exit's path at " + String(x) + ",9, which unbinds and orphans it");
        }

        // And the spine is untouched: a run that reached for the network on its own would
        // have converted 10,7 on its way there.
        assert.equal(footpathAt(game, 10, 7)?.isQueue, false, "the spine was turned into queue");
        assert.equal(footpathAt(game, 12, 7)?.ride, 0, "the queue is not bound to the ride it was laid for");
    });
});

/**
 * The fixture that tells the two rules apart. What stood here laid an UNBOUND queue across
 * the corridor and expected four stranded tiles; measured against a running game an
 * unbound queue strands nothing - turning path into queue moves no edge bit - so the old
 * assertion was proving the bridge's own invented rule. Here a ride owns the queue, which
 * is what actually cuts, and it cuts exactly one tile's worth of through traffic.
 */
test("a queue the ride claims at its door reports how much of the park it cut off", function () {
    withGame(corridorWithADoorOnIt, function (game) {
        // A queue from bare ground onto the corridor tile the door opens onto.
        const outcome = layAndLetTheRideClaimIt(game, [{ x: 9, y: 8 }, { x: 10, y: 8 }], function () {
            theRideClaimsTheDoorTile(game);
        });

        assert.equal(outcome.ok, true, "the queue itself was laid");
        assert.equal(outcome.connectedToPark, true, "and every tile of it is still reachable");
        assert.match(outcome.detail, /WARNING: 4 path tiles are no longer reachable/,
            "tiles 10,9 through 10,12 lost their only way back to the entrance");
    });
});

/**
 * `detail` is the whole of what gets read. Measured over a session: `tilesPlaced`,
 * `tilesTargeted`, `connectedToPark` and `ridesLeftWithoutQueue` drew 0 mentions between
 * them while `detail` was quoted back turn after turn. The counts and the lost queues were
 * already in the sentence; whether guests can get to the run was only ever a boolean, so a
 * run that worked said nothing at all about the one thing a new run is laid to achieve.
 *
 * The assertion is against `connectedToPark` itself rather than a fixed string, so a
 * sentence that stops tracking the field fails rather than drifting away from it.
 */
test("a run guests can reach says so in the sentence, not only in a field", function () {
    withGame(parkWithSpine, function () {
        const outcome = lay(line({ x: 11, y: 8 }, { x: 14, y: 8 }));

        assert.equal(outcome.connectedToPark, true, outcome.detail);
        assert.match(outcome.detail, /Guests can walk to this run from the park entrance\./,
            "the field said it and nothing read the field");
        assert.match(outcome.detail, /4 path tiles/,
            "and the count is in the sentence too, which is why tilesPlaced never had to be read");

        const island = lay(line({ x: 3, y: 20 }, { x: 5, y: 20 }));

        assert.equal(island.connectedToPark, false, island.detail);
        assert.doesNotMatch(island.detail, /Guests can walk to this run/,
            "a stub joined to nothing must not claim it: the sentence follows the measurement");
    });
});

/**
 * The tile the ride claims is the price, not the damage, and it used to be counted twice.
 *
 * `describe_placement` predicted `queueCutsOff: 5` for a door and build_path measured "6
 * path tiles are no longer reachable" for that same event, because the prediction counts
 * what is lost BESIDE the claimed tile and the measurement counted the claimed tile too.
 * The same message already excuses that tile from `connectedToPark` for exactly this
 * reason, and `describe_placement` already prices it separately in the same breath ("the
 * queue takes x,y"), so counting it here said one cost twice and made the two numbers
 * disagree by one on every build. The prediction is the one that has to be able to read 0 -
 * that is how the model is told there is a way round - so the measurement moved.
 *
 * The fixture is the one where the two answers differ, which the corridor tests above are
 * not: the queue runs AWAY from the gate, so the game's cut falls on the door tile's link
 * back to the entrance and the door tile drops out of the walk along with everything past
 * it. Five tiles stop being reachable and four of them are damage; revert the fix and this
 * reads 5. `readPathNetwork` counts the same way - a five-tile corridor reports
 * `cutsIfBlocked` 4 - so the prediction and the measurement are one convention now.
 */
test("a tile the ride claimed is not counted among the tiles that were cut off", function () {
    withGame(corridorWithADoorOnIt, function (game) {
        const outcome = layAndLetTheRideClaimIt(game, [{ x: 10, y: 8 }, { x: 10, y: 9 }], function () {
            // The queue chain runs south, so the link the game dead-ends is the one north,
            // back towards the gate.
            game.severPath(10, 8, 10, 7);
        });

        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(outcome.connectedToPark, false,
            "the whole queue is on the far side of the cut, which is a different fact from the count");
        assert.match(outcome.detail, /WARNING: 4 path tiles are no longer reachable/,
            "10,9 through 10,12: the claimed door tile at 10,8 is the tile handed to the ride, not damage");
        assert.doesNotMatch(outcome.detail, /WARNING: 5 path tiles/,
            "counting the claimed tile is what made this disagree with describe_placement by one");
    });
});

test("a queue no ride owns cuts nothing, and the run says so", function () {
    withGame(function (game) {
        parkWithGate(game);
        for (let y = 6; y <= 12; y++) {
            game.addPath(10, y);
        }
    }, function () {
        // The old rule's own fixture: a queue straight across the only corridor, bound to
        // nothing. Guests walk over it, so the corridor south of it is untouched.
        const outcome = lay(line({ x: 8, y: 8 }, { x: 12, y: 8 }), true);

        assert.equal(outcome.ok, true, outcome.detail);
        assert.doesNotMatch(outcome.detail, /no longer reachable/,
            "an unclaimed queue severs nothing: this is the claim that was wrong");
        assert.match(outcome.detail, /Nothing was cut off by it\.$/);
    });
});

test("a severed park is counted and explained, not told what to do about it", function () {
    // The warning used to end "Move the queue off the main path, or lay a path around it."
    // Where a queue goes is park layout, which is the decision describe_placement hands over
    // with this very measurement: the tool reports the count and the cause and stops.
    withGame(corridorWithADoorOnIt, function (game) {
        const outcome = layAndLetTheRideClaimIt(game, [{ x: 9, y: 8 }, { x: 10, y: 8 }], function () {
            theRideClaimsTheDoorTile(game);
        });

        assert.match(outcome.detail, /WARNING: 4 path tiles are no longer reachable from the park entrance\./,
            "the count stays: it is a measurement");
        assert.match(outcome.detail, /the one tile a ride's entrance claims, and the route to those tiles ran through such a tile\./,
            "and so does the cause, which is now the cause the game has");
        assert.doesNotMatch(outcome.detail, /cannot walk through a queue/,
            "the mechanic it used to name is not the game's");
        assert.doesNotMatch(outcome.detail, /Move the queue|lay a path around/,
            "what to do about it is the model's call");
    });
});

test("an ordinary path run that names a queue tile is refused, not apologised for", function () {
    // The tool used to contradict its own refusal: that text promised "no route is taken
    // across" a queue, and the router exempted the far end of every leg from the rule -
    // for queue runs and ordinary ones alike. So a run ended on a bound queue, paved it,
    // unbound the ride, and only then said so in a WARNING. One such call cost eleven
    // turns and about seven minutes of remove_path, failed rebuilds and view_map.
    withGame(function (game) {
        parkWithGate(game);
        game.addPath(10, 6);
        game.addPath(10, 7, true, 0);
        game.addPath(10, 8, true, 0);
    }, function (game) {
        const outcome = lay(line({ x: 10, y: 6 }, { x: 10, y: 8 }));

        assert.equal(outcome.ok, false, outcome.detail);
        assert.match(outcome.detail, /10,7 10,8 - carrying ride 0's queue/,
            "the tiles and the ride whose line they are have to be named, not the category");
        assert.match(outcome.detail, /unbinds it from ride 0/,
            "and what paving them would have done, which is damage nothing in the API shows");
        assert.match(outcome.detail, /remove_path takes a queue up/,
            "a blocker with a remedy names the call that lifts it");
        assert.doesNotMatch(outcome.detail, /WARNING/,
            "a refusal before the fact, not an apology after it");

        // The claim is about the world, so read the world: the queue is still a queue and
        // still bound. A test that only read the message would pass on a tool that paved
        // the tile and merely described the refusal.
        const path = footpathAt(game, 10, 8);
        assert.ok(path);
        assert.equal(path.isQueue, true, "the queue was paved over anyway");
        assert.equal(path.ride, 0, "the queue was unbound from its ride anyway");
        assert.equal(game.attempted.length, 0, "and not one tile was laid on the way to refusing");
    });
});

test("a path run takes no queue tile wherever in the run it sits", function () {
    // Three separate exemptions used to exist - the first tile of a run was never checked
    // at all, and the last was exempt on purpose - and each is a different way to unbind a
    // ride silently. With no route to pick there is no end to exempt: every named tile is
    // held to the same rule.
    const positions: { where: string; tiles: Tile[]; queueAt: Tile }[] = [
        { where: "first", tiles: line({ x: 10, y: 6 }, { x: 10, y: 8 }), queueAt: { x: 10, y: 6 } },
        { where: "middle", tiles: line({ x: 10, y: 6 }, { x: 10, y: 8 }), queueAt: { x: 10, y: 7 } },
        { where: "last", tiles: line({ x: 10, y: 6 }, { x: 10, y: 8 }), queueAt: { x: 10, y: 8 } }
    ];

    positions.forEach(function (position) {
        withGame(function (game) {
            parkWithGate(game);
            game.addPath(position.queueAt.x, position.queueAt.y, true, 3);
        }, function (game) {
            const outcome = lay(position.tiles);

            assert.equal(outcome.ok, false,
                "a queue " + position.where + " in the run was paved over: " + outcome.detail);
            assert.match(outcome.detail,
                new RegExp(String(position.queueAt.x) + "," + String(position.queueAt.y) + " - carrying ride 3's queue"),
                "the " + position.where + " tile is the one at fault and it has to be named");
            assert.equal(footpathAt(game, position.queueAt.x, position.queueAt.y)?.isQueue, true,
                "the queue " + position.where + " in the run was paved over on the map");
            assert.equal(game.attempted.length, 0, "and no tile of the run was laid");
        });
    });
});

test("a queue run may name a queue tile, which is how one line joins another", function () {
    withGame(function (game) {
        parkWithGate(game);
        for (let y = 6; y <= 8; y++) {
            game.addPath(10, y);
        }
        game.addPath(11, 8, true, 0);
    }, function () {
        const outcome = lay([{ x: 10, y: 8 }, { x: 11, y: 8 }], true);

        assert.equal(outcome.ok, true, outcome.detail);
        assert.deepEqual(outcome.tiles, [{ x: 10, y: 8 }, { x: 11, y: 8 }],
            "a run must be allowed to join the queue it is extending");
        assert.match(outcome.detail, /Turned 1 path tile into queue, joined 1 tile that was already queue\./);
        assert.match(outcome.detail, /Nothing was cut off by it/);
    });
});

/**
 * The damage that gets through, and the only kind that can.
 *
 * An ordinary path over a queue is refused above, before anything is laid. A queue laid
 * onto another ride's queue is not: the game allows it, chains the two lines into one and
 * binds the whole chain to one entrance, and the ride at the other end is left with a door
 * and no line. Nothing in the game's API reports that, so it is measured - the chain out of
 * every ride's entrance, read before the call and again after.
 */
test("a queue that chains onto another ride's line reports the ride that lost it", function () {
    withGame(function (game) {
        parkWithSpine(game, 12);
        rideWithAnEntranceAt(game, 0, "Ferris Wheel", { x: 12, y: 6 }, 2);
        rideWithAnEntranceAt(game, 1, "Merry-Go-Round", { x: 12, y: 9 }, 2);
        // Ride 0 already has its queue, on the tile its door opens onto.
        game.addPath(11, 6, true, 0);
    }, function (game) {
        assert.equal(footpathAt(game, 11, 6)?.ride, 0, "the fixture has to start with ride 0 served");

        // Ride 1's queue, drawn up to and including ride 0's tile.
        const outcome = lay(line({ x: 11, y: 9 }, { x: 11, y: 6 }), true);

        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(outcome.ridesLeftWithoutQueue.length, 1,
            "ride 0's line was chained to ride 1 and nothing said so");
        assert.equal(outcome.ridesLeftWithoutQueue[0].id, 0);
        assert.equal(outcome.ridesLeftWithoutQueue[0].name, "Ferris Wheel");
        assert.deepEqual(outcome.ridesLeftWithoutQueue[0].entranceDoor, { x: 11, y: 6 });
        assert.match(outcome.detail, /WARNING: ride 0 Ferris Wheel no longer has a queue bound to it/);
        assert.match(outcome.detail, /entrance door is at 11,6/,
            "the tile a queue has to sit on to fix it, so the warning has a lever");

        // The world agrees: the tile at ride 0's door now serves ride 1.
        assert.equal(footpathAt(game, 11, 6)?.ride, 1, "the chain did not actually move");
    });

    // And a run that takes nobody's line reports nobody's.
    withGame(function (game) {
        parkWithSpine(game, 12);
        rideWithAnEntranceAt(game, 0, "Ferris Wheel", { x: 12, y: 6 }, 2);
        game.addPath(11, 6, true, 0);
    }, function () {
        const outcome = lay([{ x: 8, y: 8 }, { x: 8, y: 9 }], true);

        assert.equal(outcome.ok, true, outcome.detail);
        assert.deepEqual(outcome.ridesLeftWithoutQueue, [],
            "a queue laid nowhere near a ride took nothing away from one");
        assert.doesNotMatch(outcome.detail, /no longer has a queue/);
    });
});

test("a tile the park does not own is named with buy_land", function () {
    // 9 of 17 build_path calls in one run failed with one sentence between them, which
    // named the four conditions as a set and no tile at all. The model could not see which
    // had failed or where, so it guessed ownership, spent £270 on three buy_land calls and
    // about eight turns, and never retried. Here ownership really is the cause - so the
    // test bites on the tile being named, not on the word "owned" appearing.
    withGame(function (game) {
        parkWithGate(game);
        game.addPath(10, 6);

        for (let x = 0; x < 24; x++) {
            game.own(x, 8, false);
        }
    }, function (game) {
        const outcome = lay(line({ x: 10, y: 6 }, { x: 10, y: 10 }));

        assert.equal(outcome.ok, false);
        assert.equal(outcome.tilesTargeted, 0);
        assert.equal(outcome.tilesPlaced, 0);
        assert.equal(outcome.tiles.length, 0);
        assert.match(outcome.detail, /1 of the 5 tiles named cannot take a path/,
            "how much of the run is at fault, so the model knows whether to redraw or to buy");
        assert.match(outcome.detail, /10,8 - not land the park owns/,
            "the blocking tile and its condition, not a list of conditions and no tile");
        assert.match(outcome.detail, /buy_land/, "a blocker with a remedy names the call that lifts it");
        assert.doesNotMatch(outcome.detail, /No level, owned, unobstructed route/,
            "the sentence that named a category and nothing else must not come back");
        assert.doesNotMatch(outcome.detail, /clear_scenery/,
            "there is no scenery here: naming every remedy every time is naming none of them");
        assert.doesNotMatch(outcome.detail, /cannot walk through a queue/,
            "guests do walk through a queue; what dead-ends is the tile a ride's entrance claims");
        assert.equal(game.attempted.length, 0, "nothing should be attempted when a tile is refused");
    });
});

test("a tile carrying scenery is named with clear_scenery", function () {
    // The actual blocker in the run above, visible as `*` in view_map the whole time: one
    // tile of scenery on the tile the run started from. It was cleared eight turns later by
    // accident, while clearing ground for a different ride, and the ride whose exit this
    // run was for was never connected.
    withGame(function (game) {
        parkWithGate(game);
        game.addScenery(10, 12);
    }, function (game) {
        const outcome = lay(line({ x: 10, y: 12 }, { x: 10, y: 8 }));

        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /10,12 - carrying scenery/,
            "the tile at fault, by coordinate, and what is on it");
        assert.match(outcome.detail, /clear_scenery/, "and the call that takes it off");
        assert.match(outcome.detail, /fromX\/fromY\/toX\/toY/,
            "clear_scenery has two argument forms and only one of them can express a strip");
        assert.match(outcome.detail, /The ground changes as you build/,
            "scenery is something a build puts there, so a stale coordinate is the other reading");
        assert.doesNotMatch(outcome.detail, /buy_land/, "the park owns this tile: do not offer to buy it");
        assert.equal(game.attempted.length, 0);
    });
});

test("a blocker with no remedy says so rather than implying one", function () {
    // The failure mode this guards is a message that names a call for every blocker
    // because every other blocker has one. Nothing in this bridge takes a ride's entrance
    // building off a tile, and saying "clear_scenery" here would cost a call and a turn
    // and change nothing.
    withGame(function (game) {
        parkWithGate(game);
        game.addPath(10, 6);
        game.addScenery(9, 8);
        // The tile the run wants is a ride's entrance building; the one beside it is a tree,
        // so the message has to carry a remedy for one and none for the other.
        game.addRideEntrance(10, 8, 3, 1);
    }, function () {
        const outcome = lay([{ x: 10, y: 6 }, { x: 9, y: 8 }, { x: 10, y: 8 }]);

        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /Tile 10,8 of this run is a ride entrance BUILDING/,
            "a door building is named as a door building, with the tile it opens onto");
    });

    // And a structure that is not a door: nothing in this bridge takes one off.
    withGame(function (game) {
        parkWithGate(game);
        game.addPath(10, 6);
        game.tile(10, 8).elements.push({ type: "track", baseZ: 96, object: 0, direction: 0 });
    }, function () {
        const outcome = lay(line({ x: 10, y: 6 }, { x: 10, y: 10 }));

        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /10,8 - carrying track, which is not scenery a bulldozer removes/,
            "what is standing there, by name");
        assert.match(outcome.detail, /nothing in this bridge changes that/,
            "a blocker with no remedy has to say so plainly");
        assert.doesNotMatch(outcome.detail, /clear_scenery removes it, and takes two corners/,
            "offering a call that cannot touch this tile is the defect, one remedy along");
    });

    // Sloped ground is NOT the other one, and saying it was is the defect this pins against.
    // "a footpath needs level ground" is false - OpenRCT2 footpaths run up slopes, and
    // `footpathplace` takes the slopeType and slopeDirection that do it - and pairing it with
    // `remedy: null` printed "nothing in this bridge changes that" over a limit this file
    // chose itself and over terrain actions `evaluate` reaches. The model believed it.
    withGame(function (game) {
        parkWithGate(game);
        game.addPath(10, 6);
        game.tile(10, 8).elements[0].slope = 1;
    }, function () {
        const outcome = lay(line({ x: 10, y: 6 }, { x: 10, y: 10 }));

        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /10,8 - on a slope, and this tool lays flat path only/,
            "the condition, on the tile that fails it, as this tool's condition");
        assert.doesNotMatch(outcome.detail, /needs level ground/,
            "the game does not need level ground for a footpath; this tool does");
        assert.doesNotMatch(outcome.detail, /nothing in this bridge changes that/,
            "something does change it, so claiming nothing did was the lie");
        assert.match(outcome.detail, /landsetheight/,
            "the route that exists has to be named, the way buy_land already names it");
        assert.match(outcome.detail, /evaluate/,
            "and how it is reached");
        assert.doesNotMatch(outcome.detail, /buy_land|clear_scenery|remove_path/,
            "no typed call here levels ground, so naming one would send the model round a loop");
    });
});

test("a queue the ride claims cuts the corridor, and no part of this test says which tile", function () {
    // The fixture states one thing: a ride's entrance, and a queue laid up to its door.
    // Binding is what cuts, and the cut comes out of the fake. While it was a `severPath`
    // in the test body, this test - and `park_status.guestsCanReach`, `build_flat_ride`'s
    // `reachable` and `describe_placement`'s `queueCutsOff` with it - was checking the tool
    // against a world whose one hard invariant the test author had filled in by hand.
    withGame(function (game) {
        game.addParkEntrance(10, 4);

        for (let y = 5; y <= 12; y++) {
            game.addPath(10, y);
        }

        // The building at 11,7 with the ride at 12,7, so the door opens onto 10,7.
        game.addRideEntrance(11, 7, 0, 2);
    }, function (game) {
        const outcome = lay([{ x: 10, y: 6 }, { x: 10, y: 7 }], true);

        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(footpathAt(game, 10, 7)?.ride, 0, "the entrance has to have claimed the line");
        assert.equal(outcome.connectedToPark, true, "the queue still reaches the gate from its other end");
        assert.match(outcome.detail, /WARNING: 5 path tiles are no longer reachable/,
            "10,8 through 10,12 lost their only way back, because the line dead-ends at the door");
    });
});

test("a queue no entrance has claimed cuts nothing, so the corridor stays open", function () {
    // The other half of the same rule, and the one an earlier version of this bridge got
    // wrong: turning path into queue moves no edge bit at all. Only binding cuts.
    withGame(function (game) {
        game.addParkEntrance(10, 4);

        for (let y = 5; y <= 12; y++) {
            game.addPath(10, y);
        }
    }, function (game) {
        const outcome = lay([{ x: 10, y: 6 }, { x: 10, y: 7 }], true);

        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(footpathAt(game, 10, 7)?.ride, null, "no entrance, so nothing claimed it");
        assert.doesNotMatch(outcome.detail, /no longer reachable/,
            "an unclaimed queue is a corridor guests walk over, not a wall");
    });
});

test("a run drawn across a step is laid and does not join up", function () {
    // build_path's own claim, and until the fake gave a footpath a height it could not be
    // tested: every fake path sat at 96 and the fixture joined any two neighbouring paths
    // whatever height they were on.
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);
        game.addPath(10, 6);

        // The ground steps up one level from 10,7 on.
        for (let y = 7; y <= 9; y++) {
            game.tile(10, y).elements[0].baseZ = 112;
        }
    }, function (game) {
        const outcome = lay(line({ x: 10, y: 7 }, { x: 10, y: 9 }));

        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(outcome.tilesPlaced, 3, "every tile of the run is laid; the step refuses nothing");
        assert.equal(footpathAt(game, 10, 7)?.baseZ, 112, "each tile is laid at its own ground height");
        assert.equal(outcome.connectedToPark, false,
            "and the step is not joined, so none of what was laid is reachable from the gate");

        // Bit 3 is -y and bit 1 is +y, so this is the link across the step, from both sides.
        assert.equal((footpathAt(game, 10, 7)?.edges || 0) & (1 << 3), 0,
            "the game joins no footpath across a step");
        assert.equal((footpathAt(game, 10, 6)?.edges || 0) & (1 << 1), 0,
            "and it keeps both sides of a link in step");
    });
});

test("the same run on level ground joins up, so the step is what did it", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);
        game.addPath(10, 6);
    }, function (game) {
        const outcome = lay(line({ x: 10, y: 7 }, { x: 10, y: 9 }));

        assert.equal(outcome.connectedToPark, true, outcome.detail);
        assert.notEqual((footpathAt(game, 10, 7)?.edges || 0) & (1 << 3), 0);
    });
});

test("build_path says flat ground is its own limit, not a rule of the game", function () {
    withGame(function (game) {
        parkWithGate(game);
        game.addPath(10, 6);
        game.tile(10, 8).elements[0].slope = 1;
    }, function () {
        const outcome = lay(line({ x: 10, y: 6 }, { x: 10, y: 10 }));

        assert.match(outcome.detail, /Flat is this tool's limit and not the game's/,
            "the summary sentence carried the same false rule and has to carry the true one");
        assert.match(outcome.detail, /OpenRCT2 footpaths run up slopes/,
            "what is actually true about footpaths and slopes");
        assert.match(outcome.detail, /landsetheight, landraise, landlower and landsmooth/,
            "the terrain actions by name, so the model can reach them");
    });
});

test("every tile that cannot take a path is named at once, capped", function () {
    // Naming one blocker is enough to act on only when there is one. A run drawn across a
    // wall of scenery fails on every tile of it, and clearing the single tile named would
    // fail again on the tile behind it - the eight-turn loop this message exists to end.
    // The remedies are rectangles, so what the model needs is the extent.
    withGame(function (game) {
        parkWithGate(game);
        game.addPath(10, 6);

        for (let y = 8; y <= 9; y++) {
            game.addScenery(10, y);
        }
    }, function () {
        const outcome = lay(line({ x: 10, y: 6 }, { x: 10, y: 12 }));

        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /2 of the 7 tiles named cannot take a path/);
        assert.match(outcome.detail, /10,8 10,9 - carrying scenery/,
            "a two-deep wall is two tiles to clear, and naming one of them wastes the call");
    });

    // And a run blocked deep enough that listing it whole would be the message. The count
    // of what is not listed is what keeps it a window rather than a truncated list read as
    // the whole truth.
    withGame(function (game) {
        parkWithGate(game);
        game.addPath(10, 6);

        for (let y = 8; y <= 18; y++) {
            game.addScenery(10, y);
        }
    }, function () {
        const outcome = lay(line({ x: 10, y: 6 }, { x: 10, y: 20 }));

        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /10,8 10,9 10,10 10,11 10,12 10,13 and 5 more of them - carrying scenery/,
            "six tiles and then a count: a long run must not spend a paragraph on its blockers");
    });
});

test("two conditions in one run are two clauses with two remedies", function () {
    // The one-sentence failure could not have said this at all. Reporting only the first
    // blocker would be nearly as bad: the model buys the land, retries, and fails on the
    // scenery behind it.
    withGame(function (game) {
        parkWithGate(game);
        game.addPath(10, 6);

        for (let x = 0; x < 24; x++) {
            game.own(x, 8, false);
        }

        game.addScenery(10, 9);
    }, function () {
        const outcome = lay(line({ x: 10, y: 6 }, { x: 10, y: 12 }));

        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /10,8 - not land the park owns; buy_land/);
        assert.match(outcome.detail, /10,9 - carrying scenery; clear_scenery/);
    });
});

test("every tile of a queue run is laid as a queue, not just described as one", function () {
    withGame(parkWithGate, function (game) {
        const outcome = lay(line({ x: 10, y: 6 }, { x: 10, y: 10 }), true);

        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(outcome.tilesPlaced, 5);
        assert.match(outcome.detail, /^Laid 5 queue tiles\./);

        for (let y = 6; y <= 10; y++) {
            const path = footpathAt(game, 10, y);
            assert.ok(path, "no footpath reached tile 10," + String(y));
            assert.equal(path.isQueue, true, "tile 10," + String(y) + " carries ordinary path, not the queue that was asked for");
            assert.equal(path.surfaceObject, DEFAULT_QUEUE_OBJECT, "and it is surfaced as a queue");
        }
    });
});

test("a queue run laid to a ride's door binds to that ride", function () {
    withGame(function (game) {
        parkWithGate(game);
        // A ride entrance at 10,10 facing south, so the ride is at 10,11 and its queue
        // belongs on 10,9 behind the building.
        game.addRideEntrance(10, 10, 7, 1);
    }, function (game) {
        const outcome = lay(line({ x: 10, y: 9 }, { x: 10, y: 6 }), true);

        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(outcome.tilesTargeted, 4);

        for (let y = 6; y <= 9; y++) {
            const path = footpathAt(game, 10, y);
            assert.ok(path);
            assert.equal(path.ride, 7,
                "tile 10," + String(y) + " is a queue that serves nobody, so guests would never board");
        }

        const ordinary = footpathAt(game, 10, 5);
        assert.ok(ordinary);
        assert.equal(ordinary.isQueue, false, "the tile below the gate is ordinary path and stays that way");
        assert.equal(ordinary.ride, null, "an ordinary path is bound to no ride, so the chain stops at it");
    });
});

test("a queue beside the door but off its queue side binds to nothing", function () {
    // Touching the entrance is not the test the game applies: the queue has to be on the
    // tile the building opens onto. A fake that bound anything adjacent would let a
    // misplaced queue report a ride as reachable.
    withGame(function (game) {
        parkWithGate(game);
        game.addRideEntrance(10, 10, 7, 1);
    }, function (game) {
        const outcome = lay(line({ x: 11, y: 10 }, { x: 11, y: 12 }), true);

        assert.equal(outcome.ok, true, outcome.detail);

        for (let y = 10; y <= 12; y++) {
            const path = footpathAt(game, 11, y);
            assert.ok(path);
            assert.equal(path.isQueue, true);
            assert.equal(path.ride, null,
                "tile 11," + String(y) + " was bound to a ride whose entrance does not open onto it");
        }
    });
});

test("the route a claimed queue severs is severed on the map, not only in the sentence", function () {
    withGame(corridorWithADoorOnIt, function (game) {
        const outcome = layAndLetTheRideClaimIt(game, [{ x: 9, y: 8 }, { x: 10, y: 8 }], function () {
            theRideClaimsTheDoorTile(game);
        });

        assert.match(outcome.detail, /WARNING: 4 path tiles are no longer reachable/);

        // The queue is real, and it reaches the tile the door opens onto.
        for (let x = 9; x <= 10; x++) {
            const line = footpathAt(game, x, 8);
            assert.ok(line, "the queue is missing from " + String(x) + ",8");
            assert.equal(line.isQueue, true, "tile " + String(x) + ",8 is not a queue, so no ride claims it");
        }

        // The cut is one tile's: the door tile no longer carries traffic to the tile beyond.
        assert.equal((footpathAt(game, 10, 8)?.edges ?? 0) & (1 << 1), 0,
            "10,8 still claims its edge south, so the ride never dead-ended it");
        assert.equal((footpathAt(game, 10, 9)?.edges ?? 0) & (1 << 3), 0,
            "and 10,9 still claims the same link back, which the game keeps symmetric");

        // And what it cut off is still there: the loss is reachability, not tiles.
        for (let y = 9; y <= 12; y++) {
            const stranded = footpathAt(game, 10, y);
            assert.ok(stranded, "tile 10," + String(y) + " lost its path as well as its route");
            assert.equal(stranded.isQueue, false, "it is ordinary path with no way back to the gate");
        }

        assert.equal(footpathAt(game, 10, 7)?.isQueue, false, "the corridor north of the door is untouched");
    });
});

test("a queue at the tile a ride claims is not reported as a tile that is cut off", function () {
    // The verdict is a membership test against the walk out of the park gate, taken after
    // the build - and the ride claims its queue inside that same call. The game dead-ends
    // the tile the door opens onto, so a queue built exactly right drops out of the walk at
    // precisely the tile a queue has to touch. One run read "neither end, 51,25 or 51,30,
    // is connected" for a queue whose door end was working, tore it out, and spent four
    // turns re-deriving it; an equivalent line later ran and was ridden.
    withGame(function (game) {
        game.addParkEntrance(10, 4);

        for (let y = 5; y <= 8; y++) {
            game.addPath(10, y);
        }

        // The entrance building at 11,9, ride at 12,9, so its door opens onto 10,9.
        game.addRideEntrance(11, 9, 0, 2);
    }, function (game) {
        const outcome = layAndLetTheRideClaimIt(game, line({ x: 10, y: 9 }, { x: 10, y: 12 }), function () {
            game.severPath(10, 9, 10, 8);
        });

        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(footpathAt(game, 10, 9)?.ride, 0, "the door tile has to be the ride's queue for this to bite");

        // The tail really is stranded here, and those are the tiles worth naming: a queue
        // is entered at the end away from the door.
        assert.match(outcome.detail, /10,10 10,11 10,12 are cut off/);
        assert.ok(outcome.detail.indexOf("10,9 is cut off") < 0,
            "the door tile is not a cut-off tile, and calling it one hides the real ones");
        assert.match(outcome.detail, /10,9 carries ride 0's queue at the tile that ride's entrance opens onto/,
            "the tile the game dead-ended has to be named as that, not left to be inferred");
        assert.match(outcome.detail, /dead-ends the tile a ride claims/,
            "and why, because the model cannot read the game's edge bits");
        assert.match(outcome.detail, /leaves the ride with no line/,
            "the sentence above is about tiles that need paving, which off this tile breaks the ride");
    });
});

test("a door-tile queue whose tail reaches the park counts as connected", function () {
    // The other half of the same defect, and the one that makes the field wrong rather
    // than merely the sentence: this queue works, guests walk into it at 11,10, and the
    // old verdict reported connectedToPark false because the door tile is not in the walk.
    withGame(function (game) {
        game.addParkEntrance(10, 4);

        for (let y = 5; y <= 10; y++) {
            game.addPath(10, y);
        }

        // Entrance building at 12,6, ride at 13,6: its door opens onto 11,6.
        game.addRideEntrance(12, 6, 0, 2);
    }, function (game) {
        const outcome = layAndLetTheRideClaimIt(game, line({ x: 11, y: 6 }, { x: 11, y: 10 }), function () {
            game.severPath(11, 6, 11, 7);
        });

        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(footpathAt(game, 11, 6)?.ride, 0, "the door tile carries the ride's queue");
        assert.equal(outcome.connectedToPark, true,
            "guests reach this queue at 11,10 and walk up it: the door tile being dead-ended is the game's doing");
        assert.doesNotMatch(outcome.detail, /does not reach the park entrance/,
            "a working queue reported as unreachable is what got one torn out");
    });
});

test("a run that reaches nothing is still reported as cut off, door tile or not", function () {
    // The excuse above must not become a blanket one. The only tile of this run is a
    // claimed door tile, so excusing the door tile is the only thing standing between this
    // run and a verdict of "connected" - and nothing of it is within ten tiles of the gate.
    // A tool that reports success for work that did not happen teaches a false world, and a
    // tool that reports a reachable park that is not is the same bug pointed at guests.
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);
        // Entrance building at 3,20, ride at 4,20: its door opens onto 2,20.
        game.addRideEntrance(3, 20, 0, 2);
    }, function (game) {
        const outcome = lay([{ x: 2, y: 20 }], true);

        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(footpathAt(game, 2, 20)?.ride, 0,
            "the door tile has to carry the ride's queue or this test excuses nothing");
        assert.equal(outcome.connectedToPark, false, "nothing of this run is anywhere near the park");
        assert.match(outcome.detail, /does not reach the park entrance/);
        assert.match(outcome.detail, /no tile of it is in the network guests can walk/,
            "no tile of it is stranded in the ordinary way, so the run itself is what has to be named");
    });
});

/**
 * The default surfaces, asserted as the literal object numbers the game knows rather than
 * through the constants — a test that imports `DEFAULT_QUEUE_OBJECT` agrees with itself
 * whichever way round the two are defined. Swapping them surfaces every queue as ordinary
 * path in the game, which is the one thing a guest reads to tell a queue from a walkway.
 */
test("a queue laid with no surfaceObject is surfaced 11, and a path 1", function () {
    withGame(parkWithGate, function (game) {
        const queued = callTool({ tiles: line({ x: 10, y: 6 }, { x: 10, y: 8 }), queue: true });

        assert.equal(queued.ok, true, queued.detail);

        const laidQueue = game.attempted.filter(function (action) { return action.name === "footpathplace"; });

        assert.ok(laidQueue.length > 0, "no footpath was ever asked for");
        laidQueue.forEach(function (action) {
            assert.equal(action.args.object, 11, "a queue with no surfaceObject has to go down as object 11");
        });

        for (let y = 6; y <= 8; y++) {
            const path = footpathAt(game, 10, y);
            assert.ok(path, "no footpath reached tile 10," + String(y));
            assert.equal(path.isQueue, true);
            assert.equal(path.surfaceObject, 11, "the queue on the map is not surfaced as one");
        }
    });

    withGame(parkWithGate, function (game) {
        const walkway = callTool({ tiles: line({ x: 10, y: 6 }, { x: 10, y: 8 }), queue: false });

        assert.equal(walkway.ok, true, walkway.detail);

        const laidPath = game.attempted.filter(function (action) { return action.name === "footpathplace"; });

        assert.ok(laidPath.length > 0, "no footpath was ever asked for");
        laidPath.forEach(function (action) {
            assert.equal(action.args.object, 1, "an ordinary path with no surfaceObject has to go down as object 1");
        });

        for (let y = 6; y <= 8; y++) {
            const path = footpathAt(game, 10, y);
            assert.ok(path, "no footpath reached tile 10," + String(y));
            assert.equal(path.isQueue, false);
            assert.equal(path.surfaceObject, 1, "the walkway on the map is not surfaced as one");
        }
    });
});

/**
 * The pause, which build_path used to report as something else entirely.
 *
 * `footpathplace` carries no `Flags::AllowWhilePaused`, so OpenRCT2's
 * `GameActionRunner.cpp::CheckActionInPausedMode` turns down every tile of a run and
 * answers "Construction not possible while game is paused!". The tool discarded that answer
 * and printed a tile count followed by its standing sentence about door buildings - a cause
 * it had never read, in the one message the model reads because something went wrong.
 */
test("a paused run reports the game's own refusal rather than a cause nothing checked", function () {
    withGame(function (game) {
        parkWithGate(game);
        game.gameValues.paused = true;
    }, function (game) {
        const outcome = lay(line({ x: 10, y: 6 }, { x: 10, y: 9 }));

        assert.equal(outcome.ok, false, "a paused run lays nothing, so it is not a success");
        assert.equal(outcome.tilesPlaced, 0, "and no tile carries a path");
        assert.equal(footpathAt(game, 10, 6), undefined, "the map has to agree the tile is bare");
        assert.equal(game.gameValues.paused, true, "and the clock is left exactly where the model put it");

        assert.match(outcome.detail, /Construction not possible while game is paused!/,
            "the game's own words for the refusal are the fact, and they are missing");
        assert.match(outcome.detail, /footpathplace/,
            "nor does it name the action the pause refuses");
        assert.match(outcome.detail, /set_game_speed \{paused: false\}/,
            "nor the one call a paused game does not refuse");
        assert.doesNotMatch(outcome.detail, /`entranceDoor` and `exitDoor`/,
            "this run failed on the clock, and door buildings had nothing to do with it");
        assert.doesNotMatch(outcome.detail, /`paths.runs`/,
            "no tile of this run is on the ground, so telling it about reachable tiles is a fix"
            + " for a failure that did not happen");
    });
});

test("a refusal that is not the pause is quoted too, and gains no pause clause", function () {
    // The other half: the errorMessage gap was never a pause bug. A refusal for any other
    // reason was thrown away in exactly the same way, and a clause appended unconditionally
    // would satisfy the test above while lying here.
    withGame(function (game) {
        parkWithGate(game);
        game.refuse.footpathplace = true;
    }, function (game) {
        const outcome = lay(line({ x: 10, y: 6 }, { x: 10, y: 9 }));

        assert.equal(game.gameValues.paused, false, "the fixture has to be a running game");
        assert.match(outcome.detail, /The game refused the placement: Refused: test refusal\./,
            "a refusal the game gave has to be quoted whatever the reason was");
        assert.doesNotMatch(outcome.detail, /paused/, "an unpaused failure must not blame the clock");
        assert.doesNotMatch(outcome.detail, /set_game_speed/,
            "nor send the model to a lever it does not need");
    });
});

test("a shortfall the game never answered keeps the door-building explanation", function () {
    // Where nothing was read there is nothing to quote, and this is the case the standing
    // sentence was written for: a placement the game takes and no path appears.
    withGame(parkWithGate, function () {
        const outcome = lay(line({ x: 10, y: 6 }, { x: 10, y: 9 }));

        assert.equal(outcome.tilesPlaced, 0);
        assert.match(outcome.detail, /The game gave no refusal for 4 of them/,
            "it must say that nothing explained these tiles rather than inventing something");
        assert.match(outcome.detail, /`entranceDoor` and `exitDoor`/,
            "and the one general fact that fits is worth keeping where nothing else is known");
        assert.doesNotMatch(outcome.detail, /The game refused the placement/,
            "no refusal was read, so none may be reported");
    }, { inert: true });
});

/**
 * The argument that decided the shape of every path in the park, and is gone.
 *
 * A pair of endpoints, and a list of corners the tool routed between, were both this file
 * choosing the line. Measured on the model this runs against, the first option offered is
 * the option taken - site #1 in 11 of 12 builds, access option #1 in 12 of 12 - so leaving
 * either one available would have meant the tile list was never used and the change learned
 * nothing. The schema is the enforcement: `tiles` is required and nothing else is accepted.
 */
test("build_path takes tiles and nothing that picks a line for the caller", function () {
    const schema = getMcpToolDefinitions(PathTools)[0].inputSchema;
    const properties = (schema.properties || {}) as Record<string, unknown>;

    assert.deepEqual(Object.keys(properties).sort(), ["queue", "railingsObject", "surfaceObject", "tiles"],
        "an endpoint or a waypoint argument is back, and the model will take it every time");
    assert.deepEqual(schema.required, ["tiles"], "the tile list is the call");
    assert.equal(schema.additionalProperties, false,
        "otherwise fromX/fromY/toX/toY would be accepted silently and ignored");

    const description = String(getMcpToolDefinitions(PathTools)[0].description);

    assert.match(description, /Nothing is routed/, "the one thing the model has to know has to be said");
    assert.doesNotMatch(description, /routes around|picks the line|waypoints/i,
        "the description still offers a router");
});

/**
 * `surfaceObject` and `railingsObject` both spelled out the same `context.getAllObjects`
 * lookup. It is one fact about the plugin API, so it is stated on the first of them and
 * referred to by the second, which is what a reader does with it anyway.
 */
test("the footpath object lookup is spelled out once across the two style arguments", function () {
    const properties = (getMcpToolDefinitions(PathTools)[0].inputSchema.properties
        || {}) as Record<string, { description?: string }>;
    const surface = String(properties.surfaceObject.description);
    const railings = String(properties.railingsObject.description);

    assert.match(surface, /context\.getAllObjects\("footpath_surface"\)/, "where a surface index comes from");
    assert.match(surface, /Queue styles are separate objects/,
        "the fact a queue needs its own object, which nothing else says");
    assert.doesNotMatch(railings, /getAllObjects/, "the second copy of the lookup was the duplicate");
    assert.match(railings, /`footpath_railings` the same way/, "and it names its own object type");
    assert.match(railings, /Default 0/);
});

/**
 * `lay`, with a change the game itself would have made applied at the moment it would land:
 * after the placements, before build_path reads the map back.
 *
 * The same shape `layAndLetTheRideClaimIt` uses and for the same reason - an edge the game
 * cuts is stated as data rather than derived - but for ordinary path, and for any change a
 * fixture needs to have happened by the time the result is composed.
 */
function layAndThen(game: FakeGame, tiles: Tile[], change: () => void, queue = false): BuildPathOutcome {
    const realSetTimeout = context.setTimeout;
    let outcome: BuildPathOutcome | null = null;

    context.setTimeout = function (callback: () => void): number {
        game.applyQueuedActions();
        change();
        callback();
        return 0;
    };

    try {
        buildPath({
            tiles: tiles,
            queue: queue,
            surfaceObject: queue ? DEFAULT_QUEUE_OBJECT : DEFAULT_PATH_OBJECT,
            railingsObject: 0
        }, function (result) { outcome = result; });
    } finally {
        context.setTimeout = realSetTimeout;
    }

    assert.ok(outcome, "buildPath never called back");
    return outcome as unknown as BuildPathOutcome;
}

/** A footpath on ground raised to `baseZ`, which is a step the game does not join across. */
function addPathAtHeight(game: FakeGame, x: number, y: number, baseZ: number): void {
    game.tile(x, y).elements[0].baseZ = baseZ;
    game.addPath(x, y);

    const elements = game.tile(x, y).elements;

    for (let i = 0; i < elements.length; i++) {
        if (elements[i].type === "footpath") {
            elements[i].baseZ = baseZ;
        }
    }
}

/**
 * The other half of the run this file's severance tests come from. Having taken up the path
 * tile its queue would have joined, the model laid a single queue tile beside the hole and
 * was told "no tile of it is in the network guests can walk" - true, and silent about the
 * one thing it could not see: that the tile next door, which had been path two turns
 * earlier, was now bare ground. It spent the rest of the session on the wrong tile.
 *
 * Which neighbours were examined and what was standing on each is knowable only here. The
 * call read them; nothing in the result carried the answer.
 */
test("a run that reaches nothing names the tiles beside it and what each one is", function () {
    withGame(parkWithSpine, function () {
        const outcome = lay([{ x: 15, y: 15 }], true);

        assert.equal(outcome.connectedToPark, false);
        assert.match(outcome.detail, /The tiles beside this run were read: /,
            "the message has to say that neighbours were examined at all");
        assert.match(outcome.detail, /16,15 14,15 15,16 15,14 are bare ground the park owns/,
            "every neighbour by name, with what was found on it: bare ground is the answer that"
            + " ended one run on the wrong tile for fifteen turns");
    });
});

test("a tile of the run is never listed among the tiles beside it", function () {
    // Every tile of the run carries a path by the time this is composed, so a run tile that
    // leaked into its own neighbour list would read as "a footpath guests cannot reach" -
    // the run reporting itself as the thing it failed to join.
    withGame(parkWithSpine, function () {
        const outcome = lay([{ x: 15, y: 15 }, { x: 15, y: 16 }, { x: 16, y: 16 }]);
        const beside = outcome.detail.substring(outcome.detail.indexOf("The tiles beside"));

        assert.equal(outcome.connectedToPark, false);
        assert.ok(beside.indexOf("The tiles beside") === 0, "this run has to produce a neighbour listing at all");

        const run = ["15,15", "15,16", "16,16"];

        for (let i = 0; i < run.length; i++) {
            assert.ok(beside.indexOf(run[i]) < 0,
                run[i] + " is a tile of the run and must not be reported as a tile beside it: " + beside);
        }

        assert.match(beside, /16,15/, "and the corner the L leaves bare is a neighbour, so it must be there");
    });
});

test("a neighbour the park does not own, one carrying scenery and one off the map are each named as that", function () {
    withGame(function (game) {
        parkWithSpine(game);
        game.addScenery(1, 1);
        game.own(0, 0, false);
    }, function () {
        const outcome = lay([{ x: 0, y: 1 }]);

        assert.equal(outcome.connectedToPark, false);
        assert.match(outcome.detail, /1,1 is carrying scenery/);
        assert.match(outcome.detail, /0,0 is not land the park owns/);
        assert.match(outcome.detail, /-1,1 is off the map/,
            "a tile past the edge is a real answer and reads nothing like an empty one");
    });
});

/**
 * The case the count alone cannot tell apart from bare ground: there IS a path next door,
 * and guests walk it, and the game still does not join the two tiles. Read off the game's
 * own `edges` bitfield through the same test the walk out of the gate floods with, because
 * a second rule about what connects to what is what this file got wrong before.
 */
test("a neighbour that carries walkable path the game has not joined is named as exactly that", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);

        for (let y = 5; y <= 9; y++) {
            game.addPath(10, y);
        }
    }, function (game) {
        const outcome = layAndThen(game, [{ x: 10, y: 10 }], function () {
            game.severPath(10, 9, 10, 10);
        });

        assert.equal(outcome.connectedToPark, false);
        assert.match(outcome.detail,
            /10,9 is a footpath guests can reach from the park entrance, with no edge bit on either tile joining it to the run/,
            "path next door that guests walk, and the game still does not join the two: the one"
            + " neighbour a bare count of stranded tiles cannot be told apart from bare ground");
    });
});

test("a neighbour that carries path at another height is named with both heights", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);

        for (let y = 5; y <= 8; y++) {
            game.addPath(10, y);
        }

        addPathAtHeight(game, 10, 10, 112);
    }, function (game) {
        const outcome = layAndThen(game, [{ x: 10, y: 11 }, { x: 10, y: 12 }], function () {
            // The game joins no footpath across a step; handed over as the edge data it is.
            game.severPath(10, 10, 10, 11);
        });

        assert.equal(outcome.connectedToPark, false);
        assert.match(outcome.detail,
            /10,10 is a footpath guests cannot reach from the park entrance either, at ground height 112 against the run's 96, with no edge bit on either tile joining it to the run/,
            "a tile that is path and still does not connect needs the reason, or the model relays a tile that is already there");
    });
});

/**
 * Both caps together, against a run long enough and a map varied enough to blow the length
 * a tool result is cut at. The cut keeps the head and the tail of an over-long string and
 * drops the middle, so an unbounded neighbour list does not merely run long: it pushes the
 * explanation and the warnings either side of it apart until the middle goes.
 */
test("the tiles beside a run cannot push the detail past the length a tool result is cut at", function () {
    const game = new FakeGame(48, 48);
    game.addParkEntrance(2, 2);
    game.addPath(2, 3);

    const run: Tile[] = [];

    for (let y = 4; y <= 43; y++) {
        run.push({ x: 20, y: y });
        // Forty neighbours, every one of them a path at its own height, so every one of them
        // reads differently and no two can share a clause.
        addPathAtHeight(game, 19, y, 96 + (y - 4) * 8);
    }

    const restore = game.install();

    try {
        const outcome = layAndThen(game, run, function () {
            for (let y = 4; y <= 43; y++) {
                game.severPath(19, y, 20, y);
            }
        });

        assert.equal(outcome.connectedToPark, false, outcome.detail);
        assert.match(outcome.detail, /and 36 more are bare ground the park owns/,
            "the per-clause cap has to fire and say how many it did not name");
        assert.match(outcome.detail, /35 further tiles beside it went unnamed here/,
            "and the cap on how many different answers are spelled out, with the count it left");
        assert.equal((sanitizeToolResult({ detail: outcome.detail }) as { detail: string }).detail, outcome.detail,
            "the detail was long enough to be cut, which silently drops whatever sat in its middle");
    } finally {
        restore();
    }
});
