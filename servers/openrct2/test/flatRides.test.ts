import assert from "node:assert/strict";
import test from "node:test";

import { flatRideShape, footprintOffsets, perimeterOffsets } from "../src/park/flatRides.ts";

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
        const offsets = footprintOffsets({ width: size, depth: size, trackType: 0, isShop: false, name: "x" }, 0);
        assert.equal(offsets.length, size * size, "size " + String(size));
    });
});

test("a footprint spans -floor(n/2) to n-1-floor(n/2), as the game places it", function () {
    // Verified in game: a 1x1 stall covers only its origin; a 1x4 ferris wheel covers -2..+1.
    const stall = footprintOffsets({ width: 1, depth: 1, trackType: 0, isShop: true, name: "s" }, 0);
    assert.deepEqual(stall, [{ dx: 0, dy: 0 }]);

    const wheel = footprintOffsets({ width: 1, depth: 4, trackType: 0, isShop: false, name: "w" }, 0);
    assert.deepEqual(wheel.map(function (o) { return o.dx; }), [-2, -1, 0, 1]);
    assert.deepEqual(wheel.map(function (o) { return o.dy; }), [0, 0, 0, 0]);
});

test("an odd rotation swaps the two axes", function () {
    const shape = { width: 1, depth: 4, trackType: 0, isShop: false, name: "w" };
    const across = footprintOffsets(shape, 1);

    assert.equal(across.length, 4);
    assert.deepEqual(across.map(function (o) { return o.dx; }), [0, 0, 0, 0]);
    assert.deepEqual(across.map(function (o) { return o.dy; }), [-2, -1, 0, 1]);
});

test("the perimeter is every tile orthogonally touching the footprint", function () {
    const single = perimeterOffsets([{ dx: 0, dy: 0 }]);
    assert.equal(single.length, 4);

    const square = perimeterOffsets(footprintOffsets(
        { width: 3, depth: 3, trackType: 0, isShop: false, name: "c" }, 0
    ));
    // Four sides of three, and no corners: corners touch only diagonally.
    assert.equal(square.length, 12);
});

test("the perimeter never overlaps the footprint", function () {
    const offsets = footprintOffsets({ width: 2, depth: 4, trackType: 0, isShop: false, name: "x" }, 0);
    const inside: Record<string, boolean> = {};
    offsets.forEach(function (o) { inside[String(o.dx) + "," + String(o.dy)] = true; });

    perimeterOffsets(offsets).forEach(function (o) {
        assert.equal(inside[String(o.dx) + "," + String(o.dy)], undefined);
    });
});
