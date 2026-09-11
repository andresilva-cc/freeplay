import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import type { FakeElement } from "./fakeGame.ts";
import { buildPath, DEFAULT_PATH_OBJECT, DEFAULT_QUEUE_OBJECT } from "../src/park/pathbuild.ts";
import type { BuildPathOutcome } from "../src/park/pathbuild.ts";
import type { Tile } from "../src/park/paths.ts";
import { PathTools } from "../src/tools/path.ts";

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
function lay(points: Tile[], queue = false): BuildPathOutcome {
    let outcome: BuildPathOutcome | null = null;

    buildPath({
        points: points,
        queue: queue,
        surfaceObject: queue ? DEFAULT_QUEUE_OBJECT : DEFAULT_PATH_OBJECT,
        railingsObject: 0
    }, function (result) { outcome = result; });

    assert.ok(outcome, "buildPath never called back");
    return outcome as unknown as BuildPathOutcome;
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

function corners(route: Tile[]): number {
    let turns = 0;

    for (let i = 2; i < route.length; i++) {
        const before = { x: route[i - 1].x - route[i - 2].x, y: route[i - 1].y - route[i - 2].y };
        const after = { x: route[i].x - route[i - 1].x, y: route[i].y - route[i - 1].y };

        if (before.x !== after.x || before.y !== after.y) {
            turns++;
        }
    }

    return turns;
}

/** An entrance at (10,4) with one path tile below it, so there is a network to join. */
function parkWithGate(game: FakeGame): void {
    game.addParkEntrance(10, 4);
    game.addPath(10, 5);
}

test("a run of bare tiles is laid and reported tile for tile", function () {
    withGame(parkWithGate, function (game) {
        const outcome = lay([{ x: 10, y: 6 }, { x: 10, y: 10 }]);

        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(outcome.tilesRouted, 5);
        assert.equal(outcome.tilesPlaced, 5, "every routed tile should carry a path");
        assert.equal(outcome.connectedToPark, true, "it joins the tile below the entrance");
        assert.match(outcome.detail, /^Laid 5 path tiles\./);

        for (let y = 6; y <= 10; y++) {
            const path = footpathAt(game, 10, y);
            assert.ok(path, "no footpath reached tile 10," + String(y));
            assert.equal(path.isQueue, false, "an ordinary path was asked for, not a queue");
        }
    });
});

test("a path laid out of reach of the entrance is a success that says so", function () {
    withGame(parkWithGate, function () {
        // The run is nowhere near the network: the tiles are still laid.
        const outcome = lay([{ x: 2, y: 2 }, { x: 2, y: 6 }]);

        assert.equal(outcome.ok, true, "the tiles went down, so this is not a failure");
        assert.equal(outcome.tilesPlaced, 5);
        assert.equal(outcome.connectedToPark, false, "but nobody can walk to it");
        assert.match(outcome.detail, /does not reach the park entrance/);
        assert.match(outcome.detail, /neither end, 2,2 or 2,6, is connected/,
            "the ends that are cut off have to be named, not left to be guessed at");
        assert.match(outcome.detail, /`paths.reachableSample`/,
            "fourteen calls in the logs retried an adjacent endpoint for want of this");
    });
});

test("an unreachable run names the end that is cut off, not both", function () {
    // The commonest recovery loop in the corpus: "does not reach the park entrance" with
    // no end named, so the model moved whichever end it happened to think of first.
    withGame(function (game) {
        parkWithGate(game);
        game.refuse.footpathplace = true;
    }, function () {
        const outcome = lay([{ x: 10, y: 5 }, { x: 10, y: 9 }]);

        assert.equal(outcome.connectedToPark, false);
        assert.match(outcome.detail, /its far end 10,9 is cut off/, "the end at fault is not named");
        assert.ok(!/neither end/.test(outcome.detail), "the start is connected, so do not blame it");
    });
});

test("a run that comes up short names the tiles that got no path", function () {
    withGame(function (game) {
        parkWithGate(game);
        game.refuse.footpathplace = true;
    }, function () {
        const outcome = lay([{ x: 10, y: 5 }, { x: 10, y: 8 }]);

        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /Only 1 of 4 tiles carry a path: no path reached 10,6 10,7 10,8/,
            "\"Only N of M\" without the tiles is a category, not a fix");
        assert.match(outcome.detail, /`entranceDoor` and `exitDoor`/,
            "the commonest cause of a short run is aiming at a door building");
    });
});

test("a run aimed at a ride entrance building names the door tile instead", function () {
    // Four calls in the logs started from the entrance building rather than the tile in
    // front of it, and got back a tile count that named neither the cause nor the fix.
    withGame(function (game) {
        parkWithGate(game);
        // An entrance at 10,10 facing south: the ride is at 10,11, the door opens onto 10,9.
        game.addRideEntrance(10, 10, 7, 1);
    }, function (game) {
        const outcome = lay([{ x: 10, y: 10 }, { x: 10, y: 6 }], true);

        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /Point 0 of this run, 10,10, is a ride entrance BUILDING/);
        assert.match(outcome.detail, /which is 10,9/, "the tile to use instead is not named");
        assert.match(outcome.detail, /`entranceDoor`/, "the field park_status reports it as is not named");
        assert.equal(game.attempted.length, 0, "and not one tile was paved while working that out");
        assert.equal(footpathAt(game, 10, 10), undefined, "nothing was laid on the building");
    });
});

test("a run aimed at a ride exit building names exitDoor", function () {
    withGame(function (game) {
        parkWithGate(game);
        game.addRideEntrance(10, 10, 7, 1, true);
    }, function (game) {
        const outcome = lay([{ x: 10, y: 6 }, { x: 10, y: 10 }]);

        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /Point 1 of this run, 10,10, is a ride exit BUILDING/);
        assert.match(outcome.detail, /which is 10,9/);
        assert.match(outcome.detail, /`exitDoor`/);
        assert.equal(game.attempted.length, 0);
    });
});

test("a run aimed at the park gate says so rather than failing to route", function () {
    withGame(parkWithGate, function (game) {
        const outcome = lay([{ x: 10, y: 4 }, { x: 10, y: 8 }]);

        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /is the park entrance BUILDING/);
        assert.match(outcome.detail, /`paths.reachableSample`/);
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
        const outcome = lay([{ x: 10, y: 6 }, { x: 10, y: 8 }], true);

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
        const outcome = lay([{ x: 10, y: 6 }, { x: 10, y: 6 }], true);

        assert.equal(outcome.ok, false, "the tile still carries ordinary path, so this is not done");
        assert.equal(outcome.tilesPlaced, 1, "there is a path on it, just not the right kind");
        assert.match(outcome.detail, /10,6 still carries path rather than queue/);
        assert.equal(footpathAt(game, 10, 6).isQueue, false, "and that is true on the map");
    });
});

test("a missing end is refused by name, not routed from off the map", function () {
    withGame(parkWithGate, function (game) {
        const outcome = callTool({ fromX: 10, fromY: 6, toX: 10 });

        assert.equal(outcome.ok, false);
        assert.match(outcome.detail, /toY is missing/, "the argument at fault is not named");
        assert.match(outcome.detail, /fromX, fromY, toX and toY together/);
        assert.ok(!/unobstructed route/.test(outcome.detail),
            "a missing argument must not be reported as a routing failure");
        assert.equal(game.attempted.length, 0, "and nothing was paved on the way to finding out");
    });
});

test("every build_path failure answers in the same shape", function () {
    // The audit found two: waypoint refusals answered {ok, error} while everything else
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
            callTool({ waypoints: [{ x: 10, y: 6 }] }),
            callTool({ waypoints: [{ x: 10 }, { x: 12, y: 6 }] }),
            callTool({ fromX: 10, fromY: 6, toX: 10, toY: 20, queue: false })
        ];

        failures.forEach(function (outcome, index) {
            const fields = Object.keys(outcome).sort().join(",");

            assert.equal(outcome.ok, false, "failure " + String(index) + " is not a failure");
            assert.ok(fields === "connectedToPark,detail,error,ok,route,tilesPlaced,tilesRouted"
                || fields === "connectedToPark,detail,ok,route,tilesPlaced,tilesRouted",
                "failure " + String(index) + " answers with " + fields);
            assert.equal(typeof outcome.detail, "string", "failure " + String(index) + " has no detail");
            assert.ok(outcome.detail.length > 0);
            assert.equal(outcome.tilesPlaced, 0);
            assert.deepEqual(outcome.route, []);
        });
    });
});

test("when nothing is applied, it claims nothing", function () {
    // The whole bug class: actions accepted, never taking effect, reported as success.
    withGame(parkWithGate, function (game) {
        const outcome = lay([{ x: 10, y: 6 }, { x: 10, y: 10 }]);

        assert.equal(outcome.ok, false, "a path that was never laid is not a success");
        assert.equal(outcome.tilesPlaced, 0, "no tile carries a path");
        assert.equal(outcome.tilesRouted, 5, "the route it tried to lay is still reported");
        assert.match(outcome.detail, /Only 0 of 5 tiles carry a path/);
        assert.equal(game.attempted.length, 5, "it did attempt one action per tile");
    }, { inert: true });
});

test("a refused action is not counted as a laid tile", function () {
    withGame(function (game) {
        parkWithGate(game);
        game.refuse.footpathplace = true;
    }, function () {
        const outcome = lay([{ x: 10, y: 6 }, { x: 10, y: 10 }]);

        assert.equal(outcome.ok, false, "the game rejected every tile");
        assert.equal(outcome.tilesPlaced, 0);
        assert.ok(!/^Laid/.test(outcome.detail), "it must not open by claiming tiles were laid");
    });
});

test("a route that ends on existing path counts that tile as joined, not failed", function () {
    withGame(function (game) {
        parkWithGate(game);
        for (let y = 6; y <= 8; y++) {
            game.addPath(10, y);
        }
    }, function () {
        const outcome = lay([{ x: 10, y: 10 }, { x: 10, y: 8 }]);

        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(outcome.tilesRouted, 3);
        assert.equal(outcome.tilesPlaced, 3);
        assert.match(outcome.detail, /Laid 2 path tiles, joined 1 tile that was already path\./);
    });
});

test("a queue laid across a walking route reports how much of the park it cut off", function () {
    withGame(function (game) {
        parkWithGate(game);
        for (let y = 6; y <= 12; y++) {
            game.addPath(10, y);
        }
    }, function () {
        // A queue straight across the only corridor: everything south of it is stranded.
        const outcome = lay([{ x: 8, y: 8 }, { x: 12, y: 8 }], true);

        assert.equal(outcome.ok, true, "the queue itself was laid");
        assert.equal(outcome.connectedToPark, true, "and both its ends are still reachable");
        assert.match(outcome.detail, /WARNING: 4 path tiles are no longer reachable/,
            "tiles 10,9 through 10,12 lost their only way back to the entrance");
    });
});

test("ordinary path laid over a queue warns that the queue was unbound", function () {
    withGame(function (game) {
        parkWithGate(game);
        game.addPath(10, 6);
        game.addPath(10, 7, true, 0);
        game.addPath(10, 8, true, 0);
    }, function (game) {
        const outcome = lay([{ x: 10, y: 7 }, { x: 10, y: 8 }]);

        assert.equal(outcome.ok, true, outcome.detail);
        assert.match(outcome.detail, /WARNING: 2 tiles replaced an existing queue line/);
        assert.ok(!/no longer reachable/.test(outcome.detail), "nothing was cut off, so do not say so");

        const path = footpathAt(game, 10, 7);
        assert.ok(path);
        assert.equal(path.isQueue, false, "the damage the warning is about is real");
    });
});

test("a route goes round an existing queue rather than through it", function () {
    withGame(function (game) {
        parkWithGate(game);
        game.addPath(10, 6);
        // A queue lying across the corridor. Guests cannot walk through it, so neither may a route.
        game.addPath(9, 7, true, 0);
        game.addPath(10, 7, true, 0);
        game.addPath(11, 7, true, 0);
    }, function () {
        const outcome = lay([{ x: 10, y: 6 }, { x: 10, y: 9 }]);

        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(outcome.tilesRouted, 8, "the shortest way round the three queue tiles");
        outcome.route.forEach(function (tile) {
            assert.ok(!(tile.y === 7 && tile.x >= 9 && tile.x <= 11),
                "the route crossed a queue at " + String(tile.x) + "," + String(tile.y));
        });
    });
});

test("a queue tile may be the far end of a route", function () {
    withGame(function (game) {
        parkWithGate(game);
        for (let y = 6; y <= 8; y++) {
            game.addPath(10, y);
        }
        game.addPath(11, 8, true, 0);
    }, function () {
        const outcome = lay([{ x: 10, y: 8 }, { x: 11, y: 8 }], true);

        assert.equal(outcome.ok, true, outcome.detail);
        assert.deepEqual(outcome.route, [{ x: 10, y: 8 }, { x: 11, y: 8 }],
            "a run must be allowed to finish on the queue it is joining");
        assert.match(outcome.detail, /Turned 1 path tile into queue, joined 1 tile that was already queue\./);
        assert.match(outcome.detail, /Nothing was cut off by it/);
    });
});

test("waypoints are the corners of the run, not hints", function () {
    // Left to itself the tool turns this corner at 12,4.
    withGame(function () { /* open ground */ }, function () {
        const outcome = lay([{ x: 4, y: 4 }, { x: 12, y: 10 }]);

        assert.equal(outcome.tilesRouted, 15);
        assert.ok(outcome.route.some(function (tile) { return tile.x === 12 && tile.y === 4; }),
            "with two points the tool is the one choosing the line");
    });

    // Asked for the other corner, it lays the other corner.
    withGame(function () { /* open ground */ }, function () {
        const outcome = lay([{ x: 4, y: 4 }, { x: 4, y: 10 }, { x: 12, y: 10 }]);

        assert.equal(outcome.tilesRouted, 15, "6 tiles down, then 8 across, sharing the corner");
        assert.deepEqual(outcome.route[0], { x: 4, y: 4 });
        assert.deepEqual(outcome.route[outcome.route.length - 1], { x: 12, y: 10 });
        outcome.route.forEach(function (tile) {
            assert.ok(tile.x === 4 || tile.y === 10,
                "tile " + String(tile.x) + "," + String(tile.y) + " is off the line the caller drew");
        });
    });
});

test("an equally short run is laid as one corner, not a staircase", function () {
    withGame(function (game) {
        // One tree beside the start: enough to make plain shortest-path search stagger.
        game.addScenery(6, 4);
    }, function () {
        const outcome = lay([{ x: 4, y: 4 }, { x: 11, y: 11 }]);

        assert.equal(outcome.tilesRouted, 15, "the detour costs no extra tiles");
        assert.equal(corners(outcome.route), 1,
            "a run of the same length came out with more corners than a person would draw");
    });
});

test("legs that double back lay each tile once", function () {
    withGame(function () { /* open ground */ }, function (game) {
        const outcome = lay([{ x: 4, y: 4 }, { x: 4, y: 8 }, { x: 4, y: 4 }]);

        assert.equal(outcome.tilesRouted, 5, "the return leg retreads the same five tiles");
        assert.equal(outcome.tilesPlaced, 5);
        assert.equal(game.attempted.length, 5, "and no tile is built over twice");
    });
});

test("scenery in the way is routed around", function () {
    withGame(function (game) {
        parkWithGate(game);
        game.addPath(10, 6);
        for (let x = 8; x <= 12; x++) {
            game.addScenery(x, 8);
        }
    }, function () {
        const outcome = lay([{ x: 10, y: 6 }, { x: 10, y: 10 }]);

        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(outcome.tilesRouted, 11, "four tiles as the crow flies, plus the detour round the trees");
        outcome.route.forEach(function (tile) {
            assert.ok(!(tile.y === 8 && tile.x >= 8 && tile.x <= 12),
                "the route ran through scenery at " + String(tile.x) + "," + String(tile.y));
        });
    });
});

test("a run with no owned, level way through is refused outright", function () {
    withGame(function (game) {
        parkWithGate(game);
        game.addPath(10, 6);

        for (let x = 0; x < 24; x++) {
            game.own(x, 8, false);
        }
    }, function (game) {
        const outcome = lay([{ x: 10, y: 6 }, { x: 10, y: 10 }]);

        assert.equal(outcome.ok, false);
        assert.equal(outcome.tilesRouted, 0);
        assert.equal(outcome.tilesPlaced, 0);
        assert.equal(outcome.route.length, 0);
        assert.match(outcome.detail, /No level, owned, unobstructed route between 10,6 and 10,10/,
            "the leg that could not be routed has to be named");
        assert.equal(game.attempted.length, 0, "nothing should be attempted when there is no route");
    });
});

test("every tile of a queue run is laid as a queue, not just described as one", function () {
    withGame(parkWithGate, function (game) {
        const outcome = lay([{ x: 10, y: 6 }, { x: 10, y: 10 }], true);

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
        const outcome = lay([{ x: 10, y: 9 }, { x: 10, y: 6 }], true);

        assert.equal(outcome.ok, true, outcome.detail);
        assert.equal(outcome.tilesRouted, 4);

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
        const outcome = lay([{ x: 11, y: 10 }, { x: 11, y: 12 }], true);

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

test("the route a queue severs is severed on the map, not only in the sentence", function () {
    withGame(function (game) {
        parkWithGate(game);
        for (let y = 6; y <= 12; y++) {
            game.addPath(10, y);
        }
    }, function (game) {
        const outcome = lay([{ x: 8, y: 8 }, { x: 12, y: 8 }], true);

        assert.match(outcome.detail, /WARNING: 4 path tiles are no longer reachable/);

        // The wall is real: five queue tiles straight across the only corridor.
        for (let x = 8; x <= 12; x++) {
            const wall = footpathAt(game, x, 8);
            assert.ok(wall, "the queue is missing from " + String(x) + ",8");
            assert.equal(wall.isQueue, true, "tile " + String(x) + ",8 is not a queue, so it blocks nobody");
        }

        // And what it cut off is still there: the loss is reachability, not tiles.
        for (let y = 9; y <= 12; y++) {
            const stranded = footpathAt(game, 10, y);
            assert.ok(stranded, "tile 10," + String(y) + " lost its path as well as its route");
            assert.equal(stranded.isQueue, false, "it is ordinary path with no way back to the gate");
        }

        assert.equal(footpathAt(game, 10, 7).isQueue, false, "the corridor north of the wall is untouched");
    });
});
