import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import { readGroundCensus, readPathNetwork } from "../src/park/network.ts";
import { walkableFromParkEntrance } from "../src/park/paths.ts";

/**
 * The network report has to be the same network the rest of the bridge walks. If it
 * disagrees with `walkableFromParkEntrance` even slightly, the model is told one thing and
 * every other tool acts on another, so that agreement is asserted directly rather than
 * assumed from the two having been written to the same rules.
 */

function withGame(build: (game: FakeGame) => void, run: (game: FakeGame) => void, size = 40): void {
    const game = new FakeGame(size, size);
    build(game);
    const restore = game.install();

    try {
        run(game);
    } finally {
        restore();
    }
}

function addRide(game: FakeGame, id: number): void {
    game.rides.push({
        id: id, name: "Ride " + String(id), type: 0, status: "closed", price: [0],
        stations: [{ start: null, entrance: null, exit: null, length: 0, queueTime: 0 }],
        excitement: -1, intensity: 0, totalCustomers: 0, totalProfit: 0,
        downtime: 0, reliability: 100, flags: 0, value: null
    });
}

/**
 * A door on the map AND on the ride, the way the game keeps it. `direction` points at the
 * ride, so the tile the door opens onto is one step the other way.
 */
function addDoor(game: FakeGame, x: number, y: number, ride: number, direction: number, isExit = false): void {
    game.addRideEntrance(x, y, ride, direction, isExit);
    const spot = { x: x * 32, y: y * 32, z: 96, direction: direction };
    const station = game.rides.filter(function (r) { return r.id === ride; })[0].stations[0];

    if (isExit) {
        station.exit = spot;
    } else {
        station.entrance = spot;
    }
}

// ---------------------------------------------------------------------------
// Agreement with the reachability the rest of the bridge uses.
// ---------------------------------------------------------------------------

/**
 * The fixture is the whole point of this test, so it is spelled out.
 *
 * What stood here was a queue hanging off the end of the spine with nothing beyond it. A
 * dead-end queue reads the same under either rule - there is nothing past it to lose - so
 * the assertion passed for months while `readPathNetwork` and `walkableFromParkEntrance`
 * disagreed about every queue in the middle of a park. It proved the two agreed on a case
 * neither could get wrong.
 *
 * So: a queue with ordinary path on BOTH sides, which the old rule stranded six tiles
 * past, and a queue a ride has claimed, whose door tile the game itself cut off. The
 * first fails if a copy goes back to "a queue expands only to queue tiles"; the second
 * fails if a copy floods plain adjacency and never reads `edges`.
 */
test("the reachable count is exactly what walkableFromParkEntrance finds", function () {
    withGame(function (game) {
        addRide(game, 3);
        game.addParkEntrance(10, 4);

        // The spine, with two queue tiles in the middle of it and path above and below.
        for (let y = 5; y <= 9; y++) {
            game.addPath(10, y);
        }

        game.addPath(10, 10, true);
        game.addPath(10, 11, true);

        for (let y = 12; y <= 16; y++) {
            game.addPath(10, y);
        }

        // A spur ending in a queue ride 3 owns. Claiming it dead-ends the door tile 13,14:
        // the game drops its edge to what lies beyond, which is the rest of the spur.
        game.addPath(11, 14);
        game.addPath(12, 14, true);
        game.addPath(13, 14, true);
        addDoor(game, 14, 14, 3, 2);
        game.severPath(13, 14, 12, 14);

        // And an island nobody can reach at all.
        game.addPath(30, 30);
        game.addPath(31, 30);
    }, function () {
        const shape = readPathNetwork();
        const walkable = walkableFromParkEntrance();

        assert.equal(shape.reachableTiles, Object.keys(walkable).length,
            "two different answers to `what can guests reach` is the bug this report exists to kill");
        assert.equal(shape.reachableTiles, 14,
            "the twelve spine tiles and the two spur tiles this side of the claimed door tile");
        assert.equal(shape.islands.length, 2, "the claimed door tile, and the pair at 30,30");
        assert.deepEqual(shape.islands.filter(function (island) { return island.tiles === 1; })[0].doors,
            [{ ride: 3, door: "entrance", x: 13, y: 14 }],
            "ride 3 is built with a queue and no guest can get to its door");
    });
});

test("an unclaimed queue is walked straight through, because the game moves no edge for it", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);
        game.addPath(10, 6, true);   // a queue laid across the only corridor
        game.addPath(10, 7);
        game.addPath(10, 8);
    }, function () {
        const shape = readPathNetwork();

        assert.equal(shape.reachableTiles, 4,
            "turning a path tile into a queue changed no edge bit in the running game, so guests walk on");
        assert.deepEqual(shape.islands, [], "nothing is cut off: there is no ride here to claim anything");
    });
});

test("a ride claiming a queue dead-ends the one tile its door opens onto", function () {
    withGame(function (game) {
        addRide(game, 0);
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);

        for (let y = 6; y <= 8; y++) {
            game.addPath(10, y, true);
        }

        // The building at 11,6 with the ride at 12,6, so the door opens onto 10,6.
        addDoor(game, 11, 6, 0, 2);
        game.severPath(10, 6, 10, 7);
    }, function () {
        const shape = readPathNetwork();

        assert.equal(shape.reachableTiles, 2, "10,5 and the door tile; the queue past it carries nobody");
        assert.equal(shape.islands.length, 1);
        assert.equal(shape.islands[0].tiles, 2);
        assert.deepEqual(shape.islands[0].runs,
            [{ fromX: 10, fromY: 7, toX: 10, toY: 8, tiles: 2, kind: "queue", ride: 0 }]);
    });
});

// ---------------------------------------------------------------------------
// Runs: the shape, and the arithmetic the reader can check.
// ---------------------------------------------------------------------------

test("a straight corridor is one run, and the runs add up to the reachable count", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);

        for (let y = 5; y <= 20; y++) {
            game.addPath(10, y);
        }
    }, function () {
        const shape = readPathNetwork();

        assert.equal(shape.runs.length, 1, "sixteen tiles in a line are one corridor, not sixteen facts");
        assert.deepEqual(shape.runs[0], {
            index: 0, fromX: 10, fromY: 5, toX: 10, toY: 20, tiles: 16, kind: "path",
            touches: [], cutsIfBlocked: 15,
            cuts: "If a ride's entrance claims a queue on the worst tile of this run,"
                + " 15 tiles of path lose their route to the park entrance."
        });

        let total = 0;

        for (let i = 0; i < shape.runs.length; i++) {
            total += shape.runs[i].tiles;
        }

        assert.equal(total, shape.reachableTiles,
            "every reachable tile is in exactly one run, so the reader can check the sum");
    });
});

test("path and queue are never the same run, and a queue names its ride", function () {
    withGame(function (game) {
        addRide(game, 3);
        game.addParkEntrance(10, 4);

        for (let y = 5; y <= 9; y++) {
            game.addPath(10, y);
        }

        for (let y = 10; y <= 12; y++) {
            game.addPath(10, y, true);
        }

        addDoor(game, 10, 13, 3, 1);   // direction 1 is +y: the ride is beyond, the queue behind
    }, function () {
        const shape = readPathNetwork();
        const queues = shape.runs.filter(function (run) { return run.kind === "queue"; });
        const paths = shape.runs.filter(function (run) { return run.kind === "path"; });

        assert.equal(paths.length, 1);
        assert.equal(queues.length, 1);
        assert.deepEqual(queues[0], {
            index: 1, fromX: 10, fromY: 10, toX: 10, toY: 12, tiles: 3, kind: "queue",
            touches: [0], ride: 3, cutsIfBlocked: 2,
            cuts: "If a ride's entrance claims a queue on the worst tile of this run,"
                + " 2 tiles of path lose their route to the park entrance."
        });
        assert.equal(typeof paths[0].ride, "undefined", "an ordinary path belongs to no ride and says nothing");
    });
});

test("a corner is two straight runs, because a bend describes no shape", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);

        for (let y = 5; y <= 10; y++) {
            game.addPath(10, y);
        }

        for (let x = 11; x <= 16; x++) {
            game.addPath(x, 10);
        }
    }, function () {
        const shape = readPathNetwork();
        let total = 0;

        for (let i = 0; i < shape.runs.length; i++) {
            total += shape.runs[i].tiles;
        }

        assert.equal(shape.runs.length, 2);
        assert.equal(total, shape.reachableTiles);
        assert.equal(shape.runs.filter(function (run) { return run.fromY === run.toY; }).length, 1,
            "one of the two is the horizontal leg");
    });
});

// ---------------------------------------------------------------------------
// What touches what, dead ends, and severance.
// ---------------------------------------------------------------------------

test("the stem and the crossbar of a T touch, and its ends are dead ends", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);

        for (let y = 5; y <= 12; y++) {
            game.addPath(10, y);
        }

        for (let x = 11; x <= 14; x++) {
            game.addPath(x, 8);
        }
    }, function () {
        const shape = readPathNetwork();

        assert.equal(shape.runs.length, 2, "the stem and the crossbar");
        assert.deepEqual(shape.runs[0].touches, [1], "the stem meets the crossbar at 10,8");
        assert.deepEqual(shape.runs[1].touches, [0], "and says so from the other end too");
        assert.deepEqual(shape.deadEnds, [{ x: 14, y: 8 }, { x: 10, y: 12 }],
            "the two loose ends, and not 10,5 - that one has the gate on its other side");
    });
});

/**
 * The defect this field was added for, as its own fixture.
 *
 * Verbatim from the session that found it: "(50, 28) and (51, 28) are adjacent tiles but
 * they're not connected because there's no path between them" - of two paved, reachable,
 * touching tiles that happened to lie on two different runs. It paved them again, was told
 * it had joined tiles that were already path, never resolved the contradiction, and spent
 * three build_path calls laying zero tiles.
 *
 * So the fixture holds both answers at once: a corner, whose two legs touch at exactly such
 * a pair of adjacent tiles on different runs, and a spur off the same gate that touches
 * neither. A `touches` that reported the connected component - every run here is reachable
 * from the gate - would name the spur from all three, and this fails.
 */
test("two runs that touch name each other, and one that touches nothing says so", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);

        // The corner: down from the gate, then east along y 10.
        for (let y = 5; y <= 10; y++) {
            game.addPath(10, y);
        }

        for (let x = 11; x <= 16; x++) {
            game.addPath(x, 10);
        }

        // A stub hanging off the far tile of the same gate, joined to nothing else.
        for (let y = 5; y <= 7; y++) {
            game.addPath(12, y);
        }
    }, function () {
        const shape = readPathNetwork();
        const down = shape.runs.filter(function (run) { return run.fromX === 10 && run.fromY === 5; })[0];
        const across = shape.runs.filter(function (run) { return run.fromY === 10 && run.toY === 10; })[0];
        const stub = shape.runs.filter(function (run) { return run.fromX === 12 && run.fromY === 5; })[0];

        assert.ok(down && across && stub, JSON.stringify(shape.runs));
        assert.deepEqual(down.touches, [across.index],
            "10,10 and 11,10 are adjacent, both paved, both reachable, and on two different runs");
        assert.deepEqual(across.touches, [down.index], "and the link is claimed from both ends");
        assert.deepEqual(stub.touches, [],
            "the stub reaches the gate and nothing else: reachable is not the same as joined");
        assert.equal(down.touches.indexOf(stub.index), -1, "nothing steps from the corner onto the stub");
        assert.equal(across.touches.indexOf(stub.index), -1);
    });
});

/**
 * Adjacency has to be the game's edges and not the tile grid, because the one link the game
 * actually cuts is between two tiles that still sit side by side. Here that cut is stated
 * as data with `severPath`, the way the API hands it over, and both runs stay reachable by
 * another route - so a `touches` built on plain adjacency passes every other test in this
 * file and fails only this one.
 */
test("two runs that only look adjacent do not touch, because the game cut the link", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);

        for (let y = 5; y <= 8; y++) {
            game.addPath(10, y);
        }

        // The other way round to 11,8: down the far side of the gate and back along y 8.
        for (let y = 5; y <= 8; y++) {
            game.addPath(12, y);
        }

        game.addPath(11, 8);
        game.severPath(10, 8, 11, 8);
    }, function () {
        const shape = readPathNetwork();
        const west = shape.runs.filter(function (run) { return run.fromX === 10 && run.fromY === 5; })[0];
        const east = shape.runs.filter(function (run) { return run.fromX === 12 && run.fromY === 5; })[0];
        const middle = shape.runs.filter(function (run) { return run.tiles === 1; })[0];

        assert.ok(west && east && middle, JSON.stringify(shape.runs));
        assert.equal(shape.reachableTiles, 9, "the cut took no tile out of the network, only one link");
        assert.deepEqual(west.touches, [],
            "10,8 and 11,8 are neighbours on the map and the game has cut the edge between them");
        assert.deepEqual(middle.touches, [east.index], "11,8 is reached the long way round, off 12,8");
    });
});

test("a single-file corridor reports what blocking its worst tile costs", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);

        for (let y = 5; y <= 9; y++) {
            game.addPath(10, y);
        }
    }, function () {
        const shape = readPathNetwork();

        assert.equal(shape.severingComputed, true);
        assert.equal(shape.runs.length, 1);
        assert.equal(shape.runs[0].cutsIfBlocked, 4,
            "blocking the tile nearest the gate strands the other four");
        assert.equal(shape.runs[0].tiles, 5,
            "five tiles, four stranded: the tile that stops carrying traffic is not itself in the count");
    });
});

/**
 * The number is correct and was read zero times in a whole session, on every run of every
 * turn, answering the exact question that broke the park it was reported in. The precedent
 * for the fix is measured rather than guessed: `describe_placement`'s `queueCutsOff` went
 * from 3 mentions against `pathDistance`'s 77 to a 4.6:1 ratio when the same figure was put
 * into a prose sentence, and was weighed out loud for the first time.
 *
 * So the sentence has to carry the figure itself, not a word standing in for it: the
 * assertion reads the number back out of the prose and demands it equal `cutsIfBlocked`. A
 * sentence that said "some tiles" or that hard-coded a count fails. And it appears only
 * where there is a price - a run with a way round every tile of it says 0 and stops, which
 * is the other half, asserted on the ring below.
 */
test("a run that severs says so in a sentence, with the figure in it", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);

        for (let y = 5; y <= 9; y++) {
            game.addPath(10, y);
        }
    }, function () {
        const run = readPathNetwork().runs[0];
        const said = /(\d+) tiles of path lose their route to the park entrance/.exec(run.cuts || "");

        assert.ok(said, "the severance figure is not in the sentence at all: " + String(run.cuts));
        assert.equal(Number(said[1]), run.cutsIfBlocked,
            "the sentence and the field have to be the same measurement");
        assert.match(run.cuts || "", /ride's entrance claims a queue/,
            "and it names what does the blocking, which is the part the field could never say");
    });
});

test("a run with a way round every tile of it states no price", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);

        for (let x = 9; x <= 12; x++) {
            game.addPath(x, 6);
            game.addPath(x, 9);
        }

        for (let y = 7; y <= 8; y++) {
            game.addPath(9, y);
            game.addPath(12, y);
        }
    }, function () {
        const shape = readPathNetwork();
        const loop = shape.runs.filter(function (run) { return run.cutsIfBlocked === 0; });

        assert.ok(loop.length > 0, "the ring's own sides cut nothing off");

        for (let i = 0; i < loop.length; i++) {
            assert.equal(typeof loop[i].cuts, "undefined",
                "a run that costs nothing is not worth a sentence every turn: " + JSON.stringify(loop[i]));
        }
    });
});

test("a ring has a way round, so only the stem into it severs", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);

        for (let x = 9; x <= 12; x++) {
            game.addPath(x, 6);
            game.addPath(x, 9);
        }

        for (let y = 7; y <= 8; y++) {
            game.addPath(9, y);
            game.addPath(12, y);
        }
    }, function () {
        const shape = readPathNetwork();
        const stem = shape.runs.filter(function (run) {
            return run.fromX === 10 && run.fromY === 5 && run.toY === 6;
        });

        assert.equal(stem.length, 1, "the stem and the tile it joins the ring at are one straight run");
        assert.equal(stem[0].cutsIfBlocked, 12, "blocking the stem strands the whole ring");

        const sides = shape.runs.filter(function (run) { return run.fromY >= 7 && run.toY <= 9; });
        assert.ok(sides.length > 0, "the ring's own sides are runs too");

        for (let i = 0; i < sides.length; i++) {
            assert.equal(sides[i].cutsIfBlocked, 0,
                "once you are on the loop there is always a way round: " + JSON.stringify(sides[i]));
        }
    });
});

test("severance is skipped rather than guessed at when the network is too large", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 0);

        for (let y = 1; y < 60; y++) {
            for (let x = 0; x < 60; x++) {
                game.addPath(x, y);
            }
        }
    }, function () {
        const shape = readPathNetwork();

        assert.equal(shape.severingComputed, false);
        assert.equal(typeof shape.runs[0].cutsIfBlocked, "undefined",
            "no figure at all beats a 0 that would read as `there is a way round`");
        assert.equal(typeof shape.runs[0].cuts, "undefined",
            "and no sentence either: a sentence with nothing measured behind it is the same lie");
    }, 64);
});

// ---------------------------------------------------------------------------
// Islands: the 34 paths laid to nowhere, and the doors stranded on them.
// ---------------------------------------------------------------------------

test("a path laid to nowhere is an island, with the ride doors standing on it", function () {
    withGame(function (game) {
        addRide(game, 1);
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);

        // A queue and its door, built nowhere near the gate's network.
        game.addPath(25, 25, true);
        game.addPath(25, 26, true);
        addDoor(game, 25, 27, 1, 1);
        addDoor(game, 20, 20, 1, 1, true);
    }, function () {
        const shape = readPathNetwork();

        assert.equal(shape.reachableTiles, 1);
        assert.equal(shape.islands.length, 1);

        const island = shape.islands[0];
        assert.equal(island.tiles, 2);
        assert.deepEqual(island.runs,
            [{ fromX: 25, fromY: 25, toX: 25, toY: 26, tiles: 2, kind: "queue", ride: 1 }]);
        assert.deepEqual(island.rides, [1]);
        assert.deepEqual(island.doors, [{ ride: 1, door: "entrance", x: 25, y: 26 }],
            "the ride is built, it has a queue, and no guest can get to either");
    });
});

test("an island of ordinary path with no door on it is still reported", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);

        for (let x = 20; x <= 24; x++) {
            game.addPath(x, 30);
        }
    }, function () {
        const shape = readPathNetwork();

        assert.equal(shape.islands.length, 1);
        assert.equal(shape.islands[0].tiles, 5);
        assert.deepEqual(shape.islands[0].runs,
            [{ fromX: 20, fromY: 30, toX: 24, toY: 30, tiles: 5, kind: "path" }]);
        assert.deepEqual(shape.islands[0].doors, []);
        assert.deepEqual(shape.islands[0].rides, []);
    });
});

/**
 * The shape defect that cost the model its longest turn of a session, 1,793 tokens.
 *
 * An island was min/max over an arbitrary blob and reported in a line's four names, so this
 * six-tile L came back as `fromX:20, fromY:20, toX:22, toY:22` - a 3x3 box holding six
 * tiles. `build_path`'s own message tells the model that "a run covers every tile between
 * its `fromX`,`fromY` and its `toX`,`toY`", and applying that rule to the box produced a
 * tile that was on the reachable network instead, a contradiction the model never resolved
 * and a no-op as its last action of the run.
 *
 * So the test is that rule, run against the island: expand every run the way the model is
 * told runs expand, and the tiles that come out have to be the tiles that are there. The
 * box fails it on both counts - it claims 21,20 and 22,20, which carry nothing at all.
 */
test("an island that bends is straight runs, and never claims a tile it does not hold", function () {
    withGame(function (game) {
        game.addParkEntrance(10, 4);
        game.addPath(10, 5);

        // An L: three tiles down x 20, then three more east along y 22.
        for (let y = 20; y <= 22; y++) {
            game.addPath(20, y);
        }

        for (let x = 21; x <= 23; x++) {
            game.addPath(x, 22);
        }
    }, function (game) {
        const island = readPathNetwork().islands[0];
        const covered: string[] = [];

        for (let i = 0; i < island.runs.length; i++) {
            const run = island.runs[i];
            const dx = Math.sign(run.toX - run.fromX);
            const dy = Math.sign(run.toY - run.fromY);

            assert.ok(dx === 0 || dy === 0, "a run that bends describes no shape: " + JSON.stringify(run));

            for (let step = 0; step < run.tiles; step++) {
                const x = run.fromX + dx * step;
                const y = run.fromY + dy * step;
                const path = game.tile(x, y).elements.filter(function (e) { return e.type === "footpath"; });

                assert.equal(path.length, 1, "the island claims " + String(x) + "," + String(y)
                    + ", which carries no path at all");
                covered.push(String(x) + "," + String(y));
            }
        }

        assert.equal(island.tiles, 6);
        assert.equal(covered.length, 6, "and it claims no more tiles than it holds");
        assert.deepEqual(covered.sort(),
            ["20,20", "20,21", "20,22", "21,22", "22,22", "23,22"].sort(),
            "every tile of the L exactly once");
    });
});

test("a park with no gate reaches nothing and says so rather than reporting an empty park", function () {
    withGame(function (game) {
        for (let x = 10; x <= 14; x++) {
            game.addPath(x, 10);
        }
    }, function () {
        const shape = readPathNetwork();

        assert.deepEqual(shape.gate, []);
        assert.equal(shape.reachableTiles, 0);
        assert.deepEqual(shape.runs, []);
        assert.equal(shape.islands.length, 1, "every path there is, is an island when there is no gate");
        assert.equal(shape.islands[0].tiles, 5);
    });
});

test("the whole report of a small park stays inside a few hundred tokens", function () {
    withGame(function (game) {
        addRide(game, 0);
        addRide(game, 1);
        game.addParkEntrance(10, 4);

        for (let y = 5; y <= 20; y++) {
            game.addPath(10, y);
        }

        for (let x = 11; x <= 20; x++) {
            game.addPath(x, 12);
        }

        for (let y = 13; y <= 15; y++) {
            game.addPath(20, y, true);
        }

        addDoor(game, 20, 16, 0, 1);
        game.addPath(30, 30, true);
        addDoor(game, 30, 31, 1, 1);
    }, function () {
        const shape = readPathNetwork();
        const wire = JSON.stringify(shape).length;

        assert.ok(wire < 1300, "the report came to " + String(wire)
            + " characters; it is re-sent every turn because compaction wipes coordinates");
    });
});

// ---------------------------------------------------------------------------
// The ground census.
// ---------------------------------------------------------------------------

test("every owned tile is counted once, in one category", function () {
    withGame(function (game) {
        addRide(game, 0);

        for (let y = 0; y < 40; y++) {
            for (let x = 20; x < 40; x++) {
                game.own(x, y, false);
            }
        }

        game.addPath(2, 2);
        game.addScenery(3, 3);
        game.tile(4, 4).elements[0].slope = 4;
        Object.assign(game.tile(5, 5).elements[0], { waterHeight: 112 });
        game.tile(6, 6).elements.push({ type: "track", baseZ: 96, ride: 0, trackType: 0, direction: 0 });
    }, function () {
        const census = readGroundCensus(16);
        let counted = 0;

        for (let i = 0; i < census.blocks.length; i++) {
            const block = census.blocks[i];
            counted += block.clear + block.scenery + block.sloped + block.water + block.path + block.built;
        }

        assert.equal(census.owned, 20 * 40, "half the map is owned");
        assert.equal(counted, census.owned, "the six counts have to account for every owned tile exactly once");
        assert.equal(census.complete, true);

        const first = census.blocks.filter(function (b) { return b.x === 0 && b.y === 0; })[0];
        assert.equal(first.path, 1);
        assert.equal(first.scenery, 1);
        assert.equal(first.sloped, 1);
        assert.equal(first.water, 1);
        assert.equal(first.built, 1);
        assert.equal(first.clear, 16 * 16 - 5);
    });
});

test("blocks are aligned to the map, so a block means the same square every turn", function () {
    withGame(function (game) {
        for (let y = 0; y < 40; y++) {
            for (let x = 0; x < 40; x++) {
                game.own(x, y, x >= 17 && x <= 18 && y >= 17 && y <= 18);
            }
        }
    }, function () {
        const census = readGroundCensus(16);

        assert.equal(census.owned, 4);
        assert.deepEqual(census.blocks.map(function (block) { return { x: block.x, y: block.y }; }),
            [{ x: 16, y: 16 }], "the four tiles are all inside the block whose corner is 16,16");
        assert.equal(census.blocks[0].clear, 4);
    });
});

test("unowned ground is not counted at all, so the census is about the park", function () {
    withGame(function (game) {
        for (let y = 0; y < 40; y++) {
            for (let x = 0; x < 40; x++) {
                game.own(x, y, false);
            }
        }

        game.own(5, 5, true);
        game.addScenery(6, 6);   // unowned scenery: outside the census
    }, function () {
        const census = readGroundCensus(16);

        assert.equal(census.owned, 1);
        assert.equal(census.blocks.length, 1);
        assert.equal(census.blocks[0].clear, 1);
        assert.equal(census.blocks[0].scenery, 0);
    });
});

test("the census of a park-sized area is small enough to send every turn", function () {
    withGame(function (game) {
        for (let y = 0; y < 40; y++) {
            for (let x = 0; x < 40; x++) {
                game.own(x, y, x < 32 && y < 32);
            }
        }

        for (let i = 0; i < 80; i++) {
            game.addScenery((i * 7) % 32, (i * 13) % 32);
        }
    }, function () {
        const census = readGroundCensus(16);
        const wire = JSON.stringify(census).length;

        assert.equal(census.blocks.length, 4);
        assert.ok(wire < 420, "the census came to " + String(wire) + " characters");
    });
});
