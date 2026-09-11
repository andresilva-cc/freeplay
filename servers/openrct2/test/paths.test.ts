import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import {
    countPathTiles,
    findParkEntranceTiles,
    routeToParkNetwork,
    tileIsWalkable,
    walkableFromParkEntrance
} from "../src/park/paths.ts";

function withGame(build: (game: FakeGame) => void, run: (game: FakeGame) => void): void {
    const game = new FakeGame(24, 24);
    build(game);
    const restore = game.install();

    try {
        run(game);
    } finally {
        restore();
    }
}

test("the park entrance is found by its three-tile shape", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        // A ride entrance is a single tile and must not be mistaken for it.
        game.tile(3, 3).elements.push({ type: "entrance", baseZ: 96, object: 0, sequence: 0 });
    }, function () {
        const gate = findParkEntranceTiles();
        assert.equal(gate.length, 3);
        assert.deepEqual(gate.map(function (t) { return t.x; }).sort(), [10, 11, 12]);
    });
});

test("guests reach paths joined to the entrance", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        for (let y = 5; y <= 9; y++) {
            game.addPath(10, y);
        }
    }, function () {
        const walkable = walkableFromParkEntrance();
        assert.equal(tileIsWalkable(walkable, { x: 10, y: 9 }), true);
    });
});

test("a queue can be joined but not walked through", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);
        game.addPath(10, 6, true);   // queue across the corridor
        game.addPath(10, 7);         // only reachable by passing through it
    }, function () {
        const walkable = walkableFromParkEntrance();

        assert.equal(tileIsWalkable(walkable, { x: 10, y: 5 }), true);
        assert.equal(tileIsWalkable(walkable, { x: 10, y: 6 }), true, "the queue itself can be reached");
        assert.equal(tileIsWalkable(walkable, { x: 10, y: 7 }), false, "but not what lies beyond it");
    });
});

test("an isolated queue is not reachable at all", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);
        game.addPath(18, 18, true);
    }, function () {
        const walkable = walkableFromParkEntrance();
        assert.equal(tileIsWalkable(walkable, { x: 18, y: 18 }), false);
    });
});

test("counting laid tiles distinguishes a queue from a path", function () {
    withGame(function (game) {
        game.addPath(5, 5, false);
        game.addPath(5, 6, true);
    }, function () {
        const tiles = [{ x: 5, y: 5 }, { x: 5, y: 6 }];

        assert.equal(countPathTiles(tiles, false), 1, "one ordinary path");
        assert.equal(countPathTiles(tiles, true), 1, "one queue");
    });
});

test("counting does not credit a tile that was never laid", function () {
    withGame(function () { /* bare ground */ }, function () {
        assert.equal(countPathTiles([{ x: 5, y: 5 }, { x: 5, y: 6 }], false), 0);
    });
});

test("a route reaches the park network around an obstruction", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);
        game.addScenery(10, 7);
    }, function () {
        const route = routeToParkNetwork({ x: 10, y: 9 }, 96, walkableFromParkEntrance());

        assert.ok(route);
        assert.equal(route[0].x, 10);
        assert.equal(route[0].y, 9, "starts at the tile asked for, not one beyond it");

        const last = route[route.length - 1];
        assert.equal(tileIsWalkable(walkableFromParkEntrance(), last), true, "ends on the network");
        route.forEach(function (tile) {
            assert.ok(!(tile.x === 10 && tile.y === 7), "never routes through the scenery");
        });
    });
});

test("no route exists across unowned land", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);

        for (let x = 0; x < 24; x++) {
            game.own(x, 7, false);
        }
    }, function () {
        assert.equal(routeToParkNetwork({ x: 10, y: 9 }, 96, walkableFromParkEntrance()), null);
    });
});
