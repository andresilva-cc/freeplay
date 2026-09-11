import assert from "node:assert/strict";
import test from "node:test";

import { computeFootprintOffsets, flatRideShape, perimeterOffsets } from "../src/park/flatRides.ts";

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
