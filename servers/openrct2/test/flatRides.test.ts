import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import { computeFootprintOffsets, flatRideShape, flatRideTypes, footprintOffsets, perimeterOffsets, segmentOffsets } from "../src/park/flatRides.ts";

test("flatRideShape knows the footprint of a square flat ride", function () {
    const carousel = flatRideShape(33);
    assert.ok(carousel);
    assert.equal(carousel.width, 3);
    assert.equal(carousel.depth, 3);
    assert.equal(carousel.trackType, 266);
    assert.equal(carousel.isShop, false);
});

test("flatRideShape knows the rides that are not square", function () {
    const wheel = flatRideShape(37);
    assert.ok(wheel);
    assert.equal(wheel.width, 1);
    assert.equal(wheel.depth, 4);
});

test("flatRideShape marks shops, which have no entrance or exit", function () {
    const stall = flatRideShape(28);
    assert.ok(stall);
    assert.equal(stall.isShop, true);
    assert.deepEqual([stall.width, stall.depth], [1, 1]);
});

test("flatRideShape returns nothing for a ride built from track", function () {
    assert.equal(flatRideShape(0), undefined);
});

test("a footprint covers exactly width times depth tiles", function () {
    const sizes = [1, 2, 3, 4];

    sizes.forEach(function (size) {
        const offsets = computeFootprintOffsets({ width: size, depth: size, trackType: 0, isShop: false, name: "x" }, 0);
        assert.equal(offsets.length, size * size, "size " + String(size));
    });
});

test("the computed fallback spans -floor(n/2) to n-1-floor(n/2)", function () {
    // Only a fallback: real pieces are read from the game, and they do not all follow this.
    const stall = computeFootprintOffsets({ width: 1, depth: 1, trackType: 0, isShop: true, name: "s" }, 0);
    assert.deepEqual(stall, [{ dx: 0, dy: 0 }]);

    const wheel = computeFootprintOffsets({ width: 1, depth: 4, trackType: 0, isShop: false, name: "w" }, 0);
    assert.deepEqual(wheel.map(function (o) { return o.dx; }), [-2, -1, 0, 1]);
    assert.deepEqual(wheel.map(function (o) { return o.dy; }), [0, 0, 0, 0]);
});

test("an odd rotation swaps the two axes", function () {
    const shape = { width: 1, depth: 4, trackType: 0, isShop: false, name: "w" };
    const across = computeFootprintOffsets(shape, 1);

    assert.equal(across.length, 4);
    assert.deepEqual(across.map(function (o) { return o.dx; }), [0, 0, 0, 0]);
    assert.deepEqual(across.map(function (o) { return o.dy; }), [-2, -1, 0, 1]);
});

test("the perimeter is every tile orthogonally touching the footprint", function () {
    const single = perimeterOffsets([{ dx: 0, dy: 0 }]);
    assert.equal(single.length, 4);

    const square = perimeterOffsets(computeFootprintOffsets(
        { width: 3, depth: 3, trackType: 0, isShop: false, name: "c" }, 0
    ));
    // Four sides of three, and no corners: corners touch only diagonally.
    assert.equal(square.length, 12);
});

test("the perimeter never overlaps the footprint", function () {
    const offsets = computeFootprintOffsets({ width: 2, depth: 4, trackType: 0, isShop: false, name: "x" }, 0);
    const inside: Record<string, boolean> = {};
    offsets.forEach(function (o) { inside[String(o.dx) + "," + String(o.dy)] = true; });

    perimeterOffsets(offsets).forEach(function (o) {
        assert.equal(inside[String(o.dx) + "," + String(o.dy)], undefined);
    });
});

test("real pieces do not follow one rule, so they are read from the game", function () {
    // Measured from context.getTrackSegment: a 3x3 is centred on its origin while a 4x4
    // runs 0..3 from it. Any formula that fits both does not exist, which is why
    // footprintOffsets asks the game and only falls back to the computed shape.
    const carousel = computeFootprintOffsets({ width: 3, depth: 3, trackType: 266, isShop: false, name: "c" }, 0);
    const dodgems = computeFootprintOffsets({ width: 4, depth: 4, trackType: 259, isShop: false, name: "d" }, 0);

    assert.deepEqual(carousel.map(function (o) { return o.dx; }).sort(), [-1, -1, -1, 0, 0, 0, 1, 1, 1]);

    // The computed shape says -2..1 here; the game says 0..3. The fallback is wrong for
    // this piece, which is precisely the point of not relying on it.
    const computedRange = dodgems.map(function (o) { return o.dx; });
    assert.ok(Math.min.apply(null, computedRange) === -2, "fallback centres a 4x4, the game does not");
});

test("footprintOffsets reads a real piece from the game instead of computing it", function () {
    const restore = new FakeGame(8, 8).install();

    try {
        const dodgems = { width: 4, depth: 4, trackType: 259, isShop: false, name: "d" };
        const fromGame = footprintOffsets(dodgems, 0).map(function (o) { return o.dx; });
        const computed = computeFootprintOffsets(dodgems, 0).map(function (o) { return o.dx; });

        assert.equal(fromGame.length, 16, "a 4x4 covers sixteen tiles either way");
        assert.equal(Math.min.apply(null, fromGame), 0, "the game runs a 4x4 from its origin, so the offsets start at 0");
        assert.equal(Math.max.apply(null, fromGame), 3, "and end at 3");

        // The whole point: the fallback disagrees, by two tiles. Taking it for a piece the
        // game can describe puts the ride's entrance clear of the ride.
        assert.equal(Math.min.apply(null, computed), -2, "while the computed fallback centres the same 4x4");
        assert.equal(Math.max.apply(null, computed), 1);
    } finally {
        restore();
    }
});

/** Every tile of a rectangular block, as sorted "x,y" keys, so a whole footprint compares in one line. */
function block(x0: number, x1: number, y0: number, y1: number): string[] {
    const keys: string[] = [];

    for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
            keys.push(String(x) + "," + String(y));
        }
    }

    return keys.sort();
}

function tilesOf(trackType: number, rotation: number, x = 0, y = 0): string[] {
    const shape = { width: 1, depth: 1, trackType: trackType, isShop: false, name: "p" };

    return footprintOffsets(shape, rotation)
        .map(function (o) { return String(x + o.dx) + "," + String(y + o.dy); })
        .sort();
}

/**
 * Every rotation of every asymmetric piece, pinned to the tiles the game actually lays.
 *
 * Rotation 0 and 2 were the only ones any test covered, and they are exactly the two a
 * wrong rotation cannot be caught by: turning a piece the wrong way is invisible on
 * anything symmetric about its origin, and 0 and 2 are mirror images either way round.
 * Rotations 1 and 3 were swapped in shipped code for months, and a mutation flipping the
 * rotation broke no test at all.
 *
 * The base offsets come from context.getTrackSegment; one turn is (dx, dy) -> (dy, -dx),
 * which is OpenRCT2's CoordsXY::rotate as TrackPlaceAction applies it.
 */
test("each rotation of a 1x4 piece lands on the tiles the game lays", function () {
    const restore = new FakeGame(8, 8).install();

    try {
        // Base offsets dx -2..+1 along x, so one turn puts the piece +y-heavy and the next
        // turn back -y-heavy. Live: the ferris wheel at rotation 1 spans dy -1..+2.
        assert.deepEqual(tilesOf(265, 0), block(-2, 1, 0, 0));
        assert.deepEqual(tilesOf(265, 1), block(0, 0, -1, 2));
        assert.deepEqual(tilesOf(265, 2), block(-1, 2, 0, 0));
        assert.deepEqual(tilesOf(265, 3), block(0, 0, -2, 1));

        // The other two 1x4 pieces share those base offsets, so they share the answer.
        assert.deepEqual(tilesOf(263, 1), block(0, 0, -1, 2));
        assert.deepEqual(tilesOf(263, 3), block(0, 0, -2, 1));
        assert.deepEqual(tilesOf(257, 1), block(0, 0, -1, 2));
        assert.deepEqual(tilesOf(257, 3), block(0, 0, -2, 1));
    } finally {
        restore();
    }
});

test("each rotation of a 4x4 piece lands on the tiles the game lays", function () {
    const restore = new FakeGame(8, 8).install();

    try {
        // A 4x4 runs 0..3 from its origin rather than being centred on it, so every
        // rotation is a different quadrant around the origin, not the same square.
        assert.deepEqual(tilesOf(259, 0), block(0, 3, 0, 3));
        assert.deepEqual(tilesOf(259, 1), block(0, 3, -3, 0));
        assert.deepEqual(tilesOf(259, 2), block(-3, 0, -3, 0));
        assert.deepEqual(tilesOf(259, 3), block(-3, 0, 0, 3));
    } finally {
        restore();
    }
});

test("each rotation of a 2x4 piece lands on the tiles the game lays", function () {
    const restore = new FakeGame(8, 8).install();

    try {
        // Centred on neither axis, so it is the piece that catches a rotation that is only
        // half wrong: getting the turn right but the handedness wrong still fits a square.
        assert.deepEqual(tilesOf(260, 0), block(0, 1, 0, 3));
        assert.deepEqual(tilesOf(260, 1), block(0, 3, -1, 0));
        assert.deepEqual(tilesOf(260, 2), block(-1, 0, -3, 0));
        assert.deepEqual(tilesOf(260, 3), block(-3, 0, 0, 1));
    } finally {
        restore();
    }
});

test("a 1x5 piece is symmetric about its origin, so it is the same either way round", function () {
    const restore = new FakeGame(8, 8).install();

    try {
        // Pinned precisely because it cannot tell the two rotations apart. The pirate ship
        // was one of the rides that stayed correct throughout, and it is not evidence of
        // anything: it would have looked correct with the rotation reversed too.
        assert.deepEqual(tilesOf(261, 0), block(-2, 2, 0, 0));
        assert.deepEqual(tilesOf(261, 1), block(0, 0, -2, 2));
        assert.deepEqual(tilesOf(261, 2), block(-2, 2, 0, 0));
        assert.deepEqual(tilesOf(261, 3), block(0, 0, -2, 2));

        // Same blind spot, same reason: a 3x3 and a 1x1 are unchanged by any rotation.
        assert.deepEqual(tilesOf(266, 1), block(-1, 1, -1, 1));
        assert.deepEqual(tilesOf(266, 3), block(-1, 1, -1, 1));
        assert.deepEqual(tilesOf(262, 1), block(0, 0, 0, 0));
    } finally {
        restore();
    }
});

test("each rotation of a 2x2 piece lands on the tiles the game lays", function () {
    const restore = new FakeGame(8, 8).install();

    try {
        assert.deepEqual(tilesOf(258, 0), block(0, 1, 0, 1));
        assert.deepEqual(tilesOf(258, 1), block(0, 1, -1, 0));
        assert.deepEqual(tilesOf(258, 2), block(-1, 0, -1, 0));
        assert.deepEqual(tilesOf(258, 3), block(-1, 0, 0, 1));
    } finally {
        restore();
    }
});

test("live repro A: a ferris wheel at rotation 1 runs +y from its origin", function () {
    const restore = new FakeGame(80, 60).install();

    try {
        // Measured in the running game: rideObject 23 at rotation 1, origin (53,33), laid
        // track on (53,32) to (53,35). The tool had offered an entrance at (54,31), which
        // is diagonal to the nearest ride tile - a door onto nothing, reported ok.
        const tiles = tilesOf(265, 1, 53, 33);
        assert.deepEqual(tiles, block(53, 53, 32, 35));

        const adjacent = tiles.filter(function (tile) {
            const parts = tile.split(",");
            return Math.abs(Number(parts[0]) - 54) + Math.abs(Number(parts[1]) - 31) === 1;
        });

        assert.equal(adjacent.length, 0, "(54,31) touches no tile of the ride; it is the tile the bug offered");
    } finally {
        restore();
    }
});

test("live repro B: a ferris wheel at rotation 3 runs -y from its origin", function () {
    const restore = new FakeGame(80, 60).install();

    try {
        // Measured: rotation 3, origin (60,30), track on (60,28) to (60,31). The tool
        // called (60,33) the "+y" door, which sits two clear tiles past the end of the ride.
        const tiles = tilesOf(265, 3, 60, 30);
        assert.deepEqual(tiles, block(60, 60, 28, 31));
        assert.equal(tiles.indexOf("60,32"), -1, "the ride stops at y=31, so a door at 33 has a gap before it");
    } finally {
        restore();
    }
});

test("live repro C: a dodgems at rotation 1 occupies the quadrant the game builds on", function () {
    const restore = new FakeGame(80, 60).install();

    try {
        // Measured: rideObject 20 at rotation 1, origin (58,32), refused with "Ferris Wheel
        // 3 in the way" - the real footprint is x58-61 / y29-32, while the tool had reported
        // x55-58 / y32-35 and had checked buildability and sceneryToClear on those instead.
        assert.deepEqual(tilesOf(259, 1, 58, 32), block(58, 61, 29, 32));
        assert.notDeepEqual(tilesOf(259, 1, 58, 32), block(55, 58, 32, 35));
    } finally {
        restore();
    }
});

test("live repro D: a 1x4 inverter ship at rotation 1 runs +y from its origin", function () {
    const restore = new FakeGame(40, 40).install();

    try {
        // Measured: origin (14,10) rotation 1 lays track on (14,9) to (14,12), while the
        // tool believed (14,8) to (14,11) and put the entrance at (14,7).
        assert.deepEqual(tilesOf(263, 1, 14, 10), block(14, 14, 9, 12));
    } finally {
        restore();
    }
});

test("the footprints verified against the live game stay put", function () {
    const restore = new FakeGame(80, 60).install();

    try {
        // The regression baseline: these four were checked tile by tile in the running game
        // and were correct before the rotation fix. They have to still be correct after it.
        assert.deepEqual(tilesOf(266, 0, 47, 26), block(46, 48, 25, 27), "3x3 merry-go-round, rotation 0 at (47,26)");
        assert.deepEqual(tilesOf(259, 0, 45, 29), block(45, 48, 29, 32), "4x4 dodgems, rotation 0 at (45,29)");
        assert.deepEqual(tilesOf(261, 3, 54, 28), block(54, 54, 26, 30), "1x5 pirate ship, rotation 3 at (54,28)");
        assert.deepEqual(tilesOf(262, 0, 51, 25), block(51, 51, 25, 25), "a 1x1 stall is its origin tile, every way round");
    } finally {
        restore();
    }
});

test("the rotation the plugin uses is the one the game uses", function () {
    const restore = new FakeGame(8, 8).install();

    try {
        // Guards the mutation that broke no test: replacing (dx,dy) -> (dy,-dx) with its
        // inverse. Stated as the rule rather than as a table, so it fails on the rule.
        const base = segmentOffsets(260, 0) || [];
        const once = segmentOffsets(260, 1) || [];

        assert.equal(base.length, 8);
        assert.deepEqual(
            once.map(function (o) { return String(o.dx) + "," + String(o.dy); }).sort(),
            base.map(function (o) { return String(o.dy) + "," + String(-o.dx); }).sort()
        );
    } finally {
        restore();
    }
});

/**
 * Every row of the table, against the piece the game says that row's `trackType` is.
 *
 * Five of the twenty-four rows were named by a test; the other nineteen could carry any
 * `trackType` and any size with the suite still green. That is the shape of the two bugs
 * this project has already paid for: a wrong piece satisfied the game's "constructed"
 * check while building nothing visible, and a wrong footprint put a ride's entrance two
 * tiles clear of the ride.
 *
 * The expectation is read from the piece, never restated from the row, or the test just
 * asserts the table equals itself.
 */
test("every row of the ride table matches the piece the game lays for it", function () {
    const restore = new FakeGame(16, 16).install();

    try {
        const types = flatRideTypes();
        assert.equal(types.length, 24, "the table describes every flat ride OpenRCT2 places in one piece");

        types.forEach(function (rideType) {
            const shape = flatRideShape(rideType);
            assert.ok(shape, "ride type " + String(rideType) + " is listed but has no shape");

            const label = "ride type " + String(rideType) + " (" + shape.name + ")";

            // segmentOffsets, not footprintOffsets: footprintOffsets falls back to the
            // computed shape when the game has no such piece, and the computed shape
            // returns width * depth tiles by construction. A row naming a piece that does
            // not exist would sail through the size check on the fallback alone.
            const tiles = segmentOffsets(shape.trackType, 0);

            assert.ok(tiles, label + ": the game has no track piece " + String(shape.trackType));
            assert.equal(tiles.length, shape.width * shape.depth,
                label + ": declared " + String(shape.width) + "x" + String(shape.depth) + " = "
                    + String(shape.width * shape.depth) + " tiles, but piece " + String(shape.trackType)
                    + " covers " + String(tiles.length));

            if (shape.isShop) {
                assert.deepEqual([shape.width, shape.depth], [1, 1],
                    label + ": a shop is one tile, served from a neighbour it does not occupy");
            }
        });
    } finally {
        restore();
    }
});

test("a shop's footprint is the one tile it stands on, every way round", function () {
    // Pinned because everything downstream depends on it: the serving tile is worked out
    // from the shop's own tile, so a shop that quietly covered two tiles would be served
    // from a tile it was standing on.
    const restore = new FakeGame(16, 16).install();

    try {
        let shops = 0;

        flatRideTypes().forEach(function (rideType) {
            const shape = flatRideShape(rideType);
            assert.ok(shape);

            if (!shape.isShop) {
                return;
            }

            shops++;

            for (let rotation = 0; rotation < 4; rotation++) {
                assert.deepEqual(footprintOffsets(shape, rotation), [{ dx: 0, dy: 0 }],
                    shape.name + " at rotation " + String(rotation));
            }
        });

        assert.equal(shops, 7, "seven of the twenty-four rows are shops and stalls");
    } finally {
        restore();
    }
});
