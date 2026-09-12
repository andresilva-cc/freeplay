import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import {
    countNewPathTiles,
    countPathTiles,
    findParkEntranceTiles,
    queuePathServes,
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

/**
 * Measured, not reasoned. In a running Forest Frontiers the main walk was turned into a
 * queue at 51,24 and 51,25 and every edge bit came back unchanged - 10 before, 10 after -
 * so the game had not cut anything. The park then ran with the tool insisting the Dodgems
 * beyond it could not be reached: it went from 48 to 96 paying customers while it said so,
 * and 94 of the 106 guests were past the queue.
 */
test("a queue laid across a walk does not cut it, because the game does not cut it", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);
        game.addPath(10, 6, true);   // queue across the corridor
        game.addPath(10, 7);         // beyond it
    }, function () {
        const walkable = walkableFromParkEntrance();

        assert.equal(tileIsWalkable(walkable, { x: 10, y: 5 }), true);
        assert.equal(tileIsWalkable(walkable, { x: 10, y: 6 }), true, "the queue itself can be reached");
        assert.equal(tileIsWalkable(walkable, { x: 10, y: 7 }), true,
            "and so is what lies beyond it: guests walk over a queue, they are not stopped by one");
    });
});

/**
 * The other half of the same rule, and the half the old one got right by accident.
 *
 * What actually severs a line is the ride claiming its queue: when the entrance at 50,25
 * took the queue at 51,25, the game cleared the bit on the far side of it - 51,25 went from
 * `edges` 10 to 9 and the tile past it, 51,26, from 10 to 3 - so the queue dead-ends at the
 * door. That cut is real and guests obey it: 94 of 106 guests ended up in the pocket behind
 * it, arriving through the ride's exit and unable to walk back out.
 */
test("a link the game has cut is not walked, even between two paths", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);
        game.addPath(10, 6, true);
        game.addPath(10, 7);
        game.severPath(10, 6, 10, 7);
    }, function () {
        const walkable = walkableFromParkEntrance();

        assert.equal(tileIsWalkable(walkable, { x: 10, y: 6 }), true, "the queue is still joined to the walk");
        assert.equal(tileIsWalkable(walkable, { x: 10, y: 7 }), false,
            "but the tile past the door is not, because the game took that edge away");
    });
});

/**
 * A guard against reading one stale bit as a doorway. The game keeps `edges` symmetric -
 * measured over every footpath of a running park, not one pair disagreed - so a lone bit is
 * a reading error, and inventing a route out of it is the failure that has to stay dead.
 */
test("a link only one side of it claims is not a link", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);
        game.addPath(10, 6);
        // Only the far tile forgets the link; the near one still points at it.
        game.tile(10, 6).elements.forEach(function (element) {
            if (element.type === "footpath") {
                element.edges = (element.edges || 0) & ~(1 << 3);
            }
        });
    }, function () {
        const walkable = walkableFromParkEntrance();

        assert.equal(tileIsWalkable(walkable, { x: 10, y: 5 }), true);
        assert.equal(tileIsWalkable(walkable, { x: 10, y: 6 }), false,
            "one side claiming a link the other does not is not a route guests can walk");
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

test("counting laid tiles credits any path, so a route may end on the network", function () {
    withGame(function (game) {
        game.addPath(5, 5, false);
        game.addPath(5, 6, true);
    }, function () {
        assert.equal(countPathTiles([{ x: 5, y: 5 }, { x: 5, y: 6 }]), 2);
    });
});

test("counting new tiles judges only those that were bare, by kind", function () {
    withGame(function (game) {
        game.addPath(5, 5, false);   // was already path: not ours to claim
        game.addPath(5, 6, true);    // we laid this queue
    }, function () {
        const tiles = [{ x: 5, y: 5 }, { x: 5, y: 6 }];
        const wasBare = { "5,5": false, "5,6": true };

        assert.equal(countNewPathTiles(tiles, wasBare, true), 1);
        assert.equal(countNewPathTiles(tiles, wasBare, false), 0, "it is a queue, not a path");
    });
});

test("counting does not credit a tile that was never laid", function () {
    withGame(function () { /* bare ground */ }, function () {
        assert.equal(countPathTiles([{ x: 5, y: 5 }, { x: 5, y: 6 }]), 0);
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

test("a guest can walk the length of a queue to its ride", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);
        // A four-tile queue leading away from the path, as any real ride has.
        game.addPath(10, 6, true);
        game.addPath(10, 7, true);
        game.addPath(10, 8, true);
        game.addPath(10, 9, true);
    }, function () {
        const walkable = walkableFromParkEntrance();

        assert.equal(tileIsWalkable(walkable, { x: 10, y: 6 }), true, "the near end");
        assert.equal(tileIsWalkable(walkable, { x: 10, y: 9 }), true, "and the ride door at the far end");
    });
});

/**
 * The case the old rule was built to stop, and which the game simply allows. A queue with
 * ordinary path on both ends is a corridor, and it was measured carrying traffic: with two
 * such queues in the way the Merry-Go-Round behind them took 52 customers while the tool
 * called its door unreachable.
 *
 * Only the tile a ride has claimed for its door dead-ends, and that is `severPath` above.
 */
test("a queue between two paths is a corridor, not a wall", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);
        game.addPath(10, 6, true);
        game.addPath(10, 7, true);
        game.addPath(10, 8);          // ordinary path on the far side of the queue
        game.addPath(10, 9);
    }, function () {
        const walkable = walkableFromParkEntrance();

        assert.equal(tileIsWalkable(walkable, { x: 10, y: 7 }), true, "the queue itself");
        assert.equal(tileIsWalkable(walkable, { x: 10, y: 8 }), true, "and through it back onto open path");
        assert.equal(tileIsWalkable(walkable, { x: 10, y: 9 }), true);
    });
});

/**
 * The shape of a real ride's door: a queue joined to the walk at one end and ending at the
 * entrance at the other, with the rest of the park past it. The queue is walkable for its
 * whole length; the tile beyond the door is not.
 */
test("a queue that ends at a door carries guests in and stops there", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);
        game.addPath(10, 6, true);
        game.addPath(10, 7, true);   // the door tile: the ride's entrance is beside it
        game.addRideEntrance(11, 7, 3, 2);
        game.addPath(10, 8);
        game.addPath(10, 9);
        // What the entrance did to its own line, as measured in the running game.
        game.severPath(10, 7, 10, 8);
    }, function () {
        const walkable = walkableFromParkEntrance();

        assert.equal(tileIsWalkable(walkable, { x: 10, y: 6 }), true, "the near end of the queue");
        assert.equal(tileIsWalkable(walkable, { x: 10, y: 7 }), true, "and the door tile at the far end");
        assert.equal(tileIsWalkable(walkable, { x: 10, y: 8 }), false, "but the line stops at the door");
        assert.equal(tileIsWalkable(walkable, { x: 10, y: 9 }), false);
    });
});

/**
 * The twin of `queueServes` in status.ts, which has this test already. The two answer the
 * same question about the same tile and are meant to agree, so a binding check dropped
 * from one of them has to fail here too.
 */
test("a queue at the door bound to another ride does not serve this one", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);
        // Ride 3's door tile, carrying a queue the game has bound to ride 7.
        game.addPath(11, 6, true, 7);
    }, function (game) {
        const queue = game.tile(11, 6).elements.filter(function (element) {
            return element.type === "footpath";
        })[0];

        assert.ok(queue, "the door tile carries no footpath at all");
        assert.equal(queue.isQueue, true, "and what it carries is a queue");
        assert.equal(queue.ride, 7, "which the map says belongs to ride 7");

        assert.equal(queuePathServes({ x: 11, y: 6 }, 3), false,
            "a queue bound to ride 7 is no queue for ride 3: guests crowd the door and never board");
        assert.equal(queuePathServes({ x: 11, y: 6 }, 7), true,
            "but it does serve the ride it is bound to");
    });
});
