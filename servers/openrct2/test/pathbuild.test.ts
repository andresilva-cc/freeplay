import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import type { FakeElement } from "./fakeGame.ts";
import { buildPath, DEFAULT_PATH_OBJECT, DEFAULT_QUEUE_OBJECT } from "../src/park/pathbuild.ts";
import type { BuildPathOutcome } from "../src/park/pathbuild.ts";
import type { Tile } from "../src/park/paths.ts";

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
        assert.match(outcome.detail, /Laid 2 path tiles, joining 1 that were already path\./);
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
        assert.match(outcome.detail, /1 tiles replaced an ordinary footpath, but nothing was cut off by it/);
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
        assert.match(outcome.detail, /No level, owned, unobstructed route/);
        assert.equal(game.attempted.length, 0, "nothing should be attempted when there is no route");
    });
});
