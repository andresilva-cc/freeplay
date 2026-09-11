import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import { findBuildSites } from "../src/park/sites.ts";

/** Ride type 33 is the 3x3 merry-go-round; 37 is the 1x4 ferris wheel; 28 a 1x1 stall. */
function gameWith(rideType: number, build?: (game: FakeGame) => void): { game: FakeGame; restore: () => void } {
    const game = new FakeGame(24, 24);
    game.rideObjects = [{ index: 0, name: "Test Ride", rideType: [rideType] }];

    if (build) {
        build(game);
    }

    return { game: game, restore: game.install() };
}

test("a tracked ride is refused, with a reason", function () {
    const { restore } = gameWith(0);

    try {
        const result = findBuildSites(0, 3);
        assert.equal(result.ok, false);
        assert.match(String(result.error), /built from track/);
    } finally {
        restore();
    }
});

test("every side of the footprint is offered, not just those nearest a path", function () {
    const { restore } = gameWith(37, function (game) {
        game.addParkEntrance(10, 0);
        for (let y = 1; y <= 20; y++) {
            game.addPath(2, y);
        }
    });

    try {
        const result = findBuildSites(0, 1);
        assert.equal(result.ok, true);

        const sites = findBuildSites(0, 50).sites || [];
        assert.ok(sites.length > 0);

        // A 1x4 in open ground has all four sides available. Trimming purely by distance
        // to the path used to hide the far one, and with it the same-side layout.
        const withAllSides = sites.filter(function (site) {
            const sides: Record<string, boolean> = {};
            site.access.forEach(function (option) { sides[option.side] = true; });
            return Object.keys(sides).length === 4;
        });

        assert.ok(withAllSides.length > 0, "no site offered all four sides");
    } finally {
        restore();
    }
});

test("sites are spread apart, so three results are three places", function () {
    const { restore } = gameWith(33, function (game) {
        game.addParkEntrance(10, 0);
        for (let y = 1; y <= 20; y++) {
            game.addPath(10, y);
        }
    });

    try {
        const sites = findBuildSites(0, 3).sites || [];
        assert.equal(sites.length, 3);

        for (let i = 0; i < sites.length; i++) {
            for (let j = i + 1; j < sites.length; j++) {
                const apart = Math.abs(sites[i].x - sites[j].x) + Math.abs(sites[i].y - sites[j].y);
                assert.ok(apart >= 5, "sites " + String(i) + " and " + String(j) + " are " + String(apart) + " apart");
            }
        }
    } finally {
        restore();
    }
});

test("scenery does not disqualify a site, it is counted", function () {
    // Own only a small patch, all of it treed, so no clear alternative can outrank it.
    const { restore } = gameWith(33, function (game) {
        for (let x = 0; x < 24; x++) {
            for (let y = 0; y < 24; y++) {
                game.own(x, y, false);
            }
        }

        for (let x = 8; x <= 14; x++) {
            for (let y = 8; y <= 14; y++) {
                game.own(x, y, true);
                game.addScenery(x, y);
            }
        }
    });

    try {
        const sites = findBuildSites(0, 10).sites || [];

        assert.ok(sites.length > 0, "a forest is buildable once cleared, not unbuildable");
        sites.forEach(function (site) {
            assert.ok(site.sceneryToClear > 0, "and the trees in the way are counted");
        });
    } finally {
        restore();
    }
});

test("unowned land is never offered", function () {
    const { restore } = gameWith(33, function (game) {
        game.addParkEntrance(10, 0);
        for (let y = 1; y <= 20; y++) {
            game.addPath(10, y);
        }

        for (let x = 0; x < 24; x++) {
            for (let y = 14; y < 24; y++) {
                game.own(x, y, false);
            }
        }
    });

    try {
        const sites = findBuildSites(0, 50).sites || [];
        sites.forEach(function (site) {
            assert.ok(site.y < 13, "site at y=" + String(site.y) + " is on unowned land");
        });
    } finally {
        restore();
    }
});

test("a park with no footpath still reports its sites", function () {
    const { restore } = gameWith(33);

    try {
        const result = findBuildSites(0, 3);
        assert.equal(result.ok, true);

        const sites = result.sites || [];
        assert.ok(sites.length > 0, "an empty park is buildable, not unbuildable");
        assert.equal(sites[0].pathDistance, -1, "-1 says there is no path to measure against");
    } finally {
        restore();
    }
});

test("a shop needs no entrance and exit", function () {
    const { restore } = gameWith(28, function (game) {
        game.addParkEntrance(10, 0);
        game.addPath(10, 1);
    });

    try {
        const result = findBuildSites(0, 3);
        assert.equal(result.ok, true);
        assert.equal((result.ride || { isShop: false }).isShop, true);
        assert.ok((result.sites || []).length > 0);
    } finally {
        restore();
    }
});
