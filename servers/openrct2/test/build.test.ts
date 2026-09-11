import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import { buildFlatRide } from "../src/park/build.ts";
import type { BuildOutcome } from "../src/park/build.ts";

/** Ride object 0 is a 3x3 merry-go-round (type 33); object 1 a 1x1 stall (type 28). */
function park(options?: { inert?: boolean }): { game: FakeGame; restore: () => void } {
    const game = new FakeGame(32, 32, options);
    game.rideObjects = [
        { index: 0, name: "Merry-Go-Round", rideType: [33] },
        { index: 1, name: "Burger Bar", rideType: [28] },
        { index: 2, name: "Dodgems", rideType: [25] }
    ];
    game.addParkEntrance(10, 2);

    for (let y = 3; y <= 20; y++) {
        game.addPath(10, y);
    }

    return { game: game, restore: game.install() };
}

function build(request: Record<string, unknown>): BuildOutcome {
    let outcome: BuildOutcome | null = null;

    buildFlatRide({
        rideObject: 0, x: 14, y: 10, price: 10, open: true, rotation: 0,
        colour1: 0, colour2: 0, entranceObject: 0, inspectionInterval: 2,
        entrance: { x: 12, y: 10 }, exit: { x: 16, y: 10 },
        ...request
    } as never, function (result) { outcome = result; });

    assert.ok(outcome, "buildFlatRide never finished");
    return outcome as unknown as BuildOutcome;
}

test("a built ride reports every step and its own id", function () {
    const { game, restore } = park();

    try {
        const outcome = build({});

        assert.equal(outcome.ok, true);
        assert.equal(outcome.rideId, 0);
        assert.deepEqual(outcome.steps.map(function (s) { return s.step; }),
            ["ridecreate", "trackplace", "entrance/exit", "access", "price", "open"]);
        assert.equal(game.rides.length, 1);
        assert.equal(game.rides[0].status, "open");
    } finally {
        restore();
    }
});

test("when nothing is applied, it claims nothing", function () {
    // The whole bug class: actions accepted, never taking effect, reported as success.
    const { restore } = park({ inert: true });

    try {
        const outcome = build({});

        assert.equal(outcome.ok, false, "a build that did not happen is not a success");
        const failed = outcome.steps.filter(function (s) { return !s.ok; });
        assert.ok(failed.length > 0, "some step must say so");
    } finally {
        restore();
    }
});

test("a ride that fails to place is removed rather than left as a phantom", function () {
    const { game, restore } = park();
    game.refuse.trackplace = true;

    try {
        const outcome = build({});

        assert.equal(outcome.ok, false);
        assert.equal(outcome.rideId, null, "no id is reported for a ride that does not exist");
        assert.equal(game.rides.length, 0, "the created ride was demolished");
        assert.ok(outcome.steps.some(function (s) { return s.step === "cleanup"; }));
    } finally {
        restore();
    }
});

test("the id comes from the action, so parallel builds do not collide", function () {
    const { game, restore } = park();

    try {
        const first = build({});
        const second = build({ x: 20, y: 10, entrance: { x: 18, y: 10 }, exit: { x: 22, y: 10 } });

        assert.notEqual(first.rideId, second.rideId);
        assert.equal(game.rides.length, 2);
    } finally {
        restore();
    }
});

test("a door tile that does not touch the ride is refused", function () {
    const { game, restore } = park();

    try {
        const outcome = build({ entrance: { x: 12, y: 14 } });

        assert.equal(outcome.ok, false);
        assert.equal(outcome.steps[0].step, "site");
        assert.match(String(outcome.steps[0].detail), /touching the footprint/);
        assert.equal(game.rides.length, 0, "nothing is created when the site is rejected");
    } finally {
        restore();
    }
});

test("a 4x4 footprint uses the game's offsets, not a computed guess", function () {
    const { game, restore } = park();

    try {
        // Dodgems run 0..3 from their origin, so (13,10) touches a footprint at (14,10).
        const outcome = build({ rideObject: 2, x: 14, y: 10, entrance: { x: 13, y: 10 }, exit: { x: 13, y: 11 } });

        assert.equal(outcome.ok, true, JSON.stringify(outcome.steps));

        // And a tile that the -floor(N/2) rule would have called adjacent is not.
        const wrong = build({ rideObject: 2, x: 20, y: 10, entrance: { x: 18, y: 8 }, exit: { x: 18, y: 9 } });
        assert.equal(wrong.ok, false, "the old centred rule would have accepted this");
        assert.equal(game.rides.length, 1, "and no phantom ride is left behind");
    } finally {
        restore();
    }
});

test("a shop needs no entrance or exit, and wants a path beside it", function () {
    const { game, restore } = park();

    try {
        const outcome = build({ rideObject: 1, x: 11, y: 10, entrance: undefined, exit: undefined });

        assert.equal(outcome.ok, true, JSON.stringify(outcome.steps));
        const access = outcome.steps.filter(function (s) { return s.step === "access"; })[0];
        assert.equal(access.ok, true, "a shop against the main path is reachable");
        assert.equal(game.rides[0].stations[0].entrance, null, "and never got an entrance building");
    } finally {
        restore();
    }
});

test("a ride with no queue is built but reported unreachable", function () {
    const { restore } = park();

    try {
        const outcome = build({ x: 20, y: 15, entrance: { x: 18, y: 15 }, exit: { x: 22, y: 15 } });

        assert.equal(outcome.ok, true, "the ride itself was built");
        assert.equal(outcome.reachable, false, "but nobody can get to it");

        const access = outcome.steps.filter(function (s) { return s.step === "access"; })[0];
        assert.match(String(access.detail), /NO QUEUE/);
    } finally {
        restore();
    }
});

test("the price is read back, not assumed", function () {
    const { game, restore } = park();
    game.refuse.ridesetprice = true;

    try {
        const outcome = build({ price: 25 });
        const price = outcome.steps.filter(function (s) { return s.step === "price"; })[0];

        assert.equal(price.ok, false);
        assert.match(String(price.detail), /asked for 25/);
    } finally {
        restore();
    }
});
