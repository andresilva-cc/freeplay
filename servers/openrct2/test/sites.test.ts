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

/** Every tile the game itself lays for this piece, read back after placing it. */
function realFootprint(size: number, trackType: number, x: number, y: number, rotation: number): string[] {
    const game = new FakeGame(size, size);
    const restore = game.install();

    try {
        context.executeAction("trackplace", {
            x: x * 32, y: y * 32, z: 96, direction: rotation, ride: 0, trackType: trackType,
            rideType: 0, brakeSpeed: 0, colour: 0, seatRotation: 4, trackPlaceFlags: 0, isFromTrackDesign: false
        }, function () { /* applied below */ });
        game.applyQueuedActions();
    } finally {
        restore();
    }

    const tiles: string[] = [];

    for (let ty = 0; ty < size; ty++) {
        for (let tx = 0; tx < size; tx++) {
            const elements = game.tile(tx, ty).elements;

            for (let i = 0; i < elements.length; i++) {
                if (elements[i].type === "track") {
                    tiles.push(String(tx) + "," + String(ty));
                    break;
                }
            }
        }
    }

    return tiles;
}

function openPark(rideType: number, size = 24): { game: FakeGame; restore: () => void } {
    const game = new FakeGame(size, size);
    game.rideObjects = [{ index: 0, name: "Test Ride", rideType: [rideType] }];
    game.addParkEntrance(10, 0);

    for (let y = 1; y <= size - 4; y++) {
        game.addPath(10, y);
    }

    return { game: game, restore: game.install() };
}

/**
 * The property the whole class of door bugs violates, checked against the tiles the game
 * lays rather than against the plugin's own idea of them.
 *
 * `build_flat_ride` returns ok:true for a door that touches nothing, because it reports
 * that the entrance action succeeded rather than reading adjacency back; the game then
 * says "Guests can't get to the entrance of X!". This is the assertion that would have
 * caught that from the search side, and it catches every rotation at once.
 */
test("every access tile touches the ride, at every rotation", function () {
    const rides = [
        { type: 37, trackType: 265, label: "1x4 ferris wheel" },
        { type: 27, trackType: 263, label: "1x4 swinging inverter ship" },
        { type: 25, trackType: 259, label: "4x4 dodgems" },
        { type: 26, trackType: 261, label: "1x5 pirate ship" },
        { type: 33, trackType: 266, label: "3x3 merry-go-round" },
        { type: 38, trackType: 258, label: "2x2 motion simulator" }
    ];
    let checked = 0;

    rides.forEach(function (ride) {
        for (let rotation = 0; rotation < 4; rotation++) {
            const { restore } = openPark(ride.type);
            let sites;

            try {
                sites = findBuildSites(0, 6, rotation).sites || [];
            } finally {
                restore();
            }

            assert.ok(sites.length > 0, ride.label + " at rotation " + String(rotation) + " found nowhere to go");

            sites.forEach(function (site) {
                const footprint = realFootprint(24, ride.trackType, site.x, site.y, site.rotation);
                const inside: Record<string, boolean> = {};
                footprint.forEach(function (tile) { inside[tile] = true; });

                assert.ok(footprint.length > 0, ride.label + " laid no track at " + String(site.x) + "," + String(site.y));

                site.access.forEach(function (option) {
                    const where = ride.label + " rotation " + String(rotation) + " site " + String(site.x) + ","
                        + String(site.y) + " access " + String(option.x) + "," + String(option.y);

                    assert.equal(inside[String(option.x) + "," + String(option.y)], undefined,
                        where + " is inside the ride itself");

                    const touching = footprint.filter(function (tile) {
                        const parts = tile.split(",");
                        return Math.abs(Number(parts[0]) - option.x) + Math.abs(Number(parts[1]) - option.y) === 1;
                    });

                    assert.equal(touching.length > 0, true,
                        where + " touches no tile of the ride; the ride is on " + footprint.join(" "));
                    checked++;
                });
            });
        }
    });

    assert.ok(checked > 100, "only " + String(checked) + " access tiles were checked");
});

test("the side an access tile is named by is the side it is on", function () {
    // Verified against tile coordinates rather than against the direction index, because
    // SIDE_NAMES being rotated by one is invisible to anything that reads the same index back.
    const { restore } = openPark(25);
    let sites;

    try {
        sites = findBuildSites(0, 4, 1).sites || [];
    } finally {
        restore();
    }

    assert.ok(sites.length > 0);
    let checked = 0;

    sites.forEach(function (site) {
        const footprint = realFootprint(24, 259, site.x, site.y, site.rotation);

        site.access.forEach(function (option) {
            const neighbour = footprint.filter(function (tile) {
                const parts = tile.split(",");
                return Math.abs(Number(parts[0]) - option.x) + Math.abs(Number(parts[1]) - option.y) === 1;
            })[0].split(",");

            const expected = Number(neighbour[0]) < option.x ? "+x"
                : (Number(neighbour[0]) > option.x ? "-x"
                    : (Number(neighbour[1]) < option.y ? "+y" : "-y"));

            assert.equal(option.side, expected,
                "access " + String(option.x) + "," + String(option.y) + " touches the ride at "
                + neighbour.join(",") + ", so it is on the " + expected + " side");
            checked++;
        });
    });

    assert.ok(checked > 0);
});

test("buildability is judged on the tiles the ride will really cover", function () {
    // Live repro C: the dodgems refused to build at a rotation-1 site with "Ferris Wheel 3
    // in the way", because the tool had checked a 4x4 block three tiles away from the one
    // the game was going to use. Nothing it offers may overlap a ride that is already there.
    const { game, restore } = openPark(25);

    for (let x = 14; x <= 17; x++) {
        for (let y = 14; y <= 17; y++) {
            game.addScenery(x, y, "track");
        }
    }

    try {
        for (let rotation = 0; rotation < 4; rotation++) {
            const sites = findBuildSites(0, 20, rotation).sites || [];

            sites.forEach(function (site) {
                realFootprint(24, 259, site.x, site.y, site.rotation).forEach(function (tile) {
                    const parts = tile.split(",");
                    const onRide = Number(parts[0]) >= 14 && Number(parts[0]) <= 17
                        && Number(parts[1]) >= 14 && Number(parts[1]) <= 17;

                    assert.equal(onRide, false, "a site at " + String(site.x) + "," + String(site.y)
                        + " rotation " + String(site.rotation) + " would be built on " + tile + ", where a ride already stands");
                });
            });
        }
    } finally {
        restore();
    }
});

test("a door that a queue would join is marked with what it cuts off", function () {
    // Eight "N path tiles are no longer reachable" events came from queueing the trunk
    // path. The trunk here runs x=10, y=1..11, so the only site worth having has its three
    // doors on it: queueing the top one strands two tiles, the middle one strands one, and
    // the dead end at the bottom strands nothing. Same site, same distance, three answers.
    const game = new FakeGame(24, 24);
    game.rideObjects = [{ index: 0, name: "Merry-Go-Round", rideType: [33] }];
    game.addParkEntrance(9, 0);

    for (let y = 1; y <= 11; y++) {
        game.addPath(10, y);
    }

    for (let x = 0; x < 24; x++) {
        for (let y = 0; y < 24; y++) {
            game.own(x, y, x >= 10 && x <= 17 && y >= 9 && y <= 11);
        }
    }

    const restore = game.install();

    try {
        const sites = findBuildSites(0, 50, 0).sites || [];
        assert.equal(sites.length, 1, "only one 3x3 site has room here");

        const byDoor: Record<string, { queueCutsOff: number; isExistingPath: boolean }> = {};

        sites[0].access.forEach(function (option) {
            const door = option.door;
            assert.ok(door, "a ride's access option must carry the door its queue goes on");
            byDoor[String(door.x) + "," + String(door.y)] = {
                queueCutsOff: option.queueCutsOff,
                isExistingPath: door.isExistingPath
            };
        });

        assert.equal(byDoor["10,9"].queueCutsOff, 2, "queueing the trunk at y=9 strands (10,10) and (10,11)");
        assert.equal(byDoor["10,10"].queueCutsOff, 1, "queueing it at y=10 strands (10,11)");
        assert.equal(byDoor["10,11"].queueCutsOff, 0, "the trunk ends at y=11, so a queue there cuts nothing");
        assert.equal(byDoor["10,9"].isExistingPath, true, "a door already on the path network is the best kind, not a rejected one");

        // Away from the trunk there is nothing to cut, and the doors say so rather than
        // saying nothing.
        assert.equal(byDoor["16,10"].queueCutsOff, 0);
        assert.equal(byDoor["16,10"].isExistingPath, false);

        // And the severing doors are still offered, in distance order, not buried.
        assert.equal(sites[0].access[0].queueCutsOff > 0, true,
            "the trunk doors are nearest the path, so they still come first - the fact is reported, the list is not reordered");
    } finally {
        restore();
    }
});

test("a queue that cuts nothing is never flagged", function () {
    // The flag has to be rare enough to mean something. A door with no footpath anywhere
    // near it has nothing to join and nothing to cut, and must come back 0 - otherwise the
    // model learns to ignore the number.
    const { game, restore } = openPark(33);

    const carriesPath = function (x: number, y: number): boolean {
        if (!game.inBounds(x, y)) {
            return false;
        }

        return game.tile(x, y).elements.filter(function (e) { return e.type === "footpath"; }).length > 0;
    };

    try {
        const sites = findBuildSites(0, 10, 0).sites || [];
        assert.ok(sites.length > 0);
        let clearDoors = 0;

        sites.forEach(function (site) {
            site.access.forEach(function (option) {
                const door = option.door;
                assert.ok(door);

                const touchesPath = carriesPath(door.x, door.y)
                    || carriesPath(door.x + 1, door.y) || carriesPath(door.x - 1, door.y)
                    || carriesPath(door.x, door.y + 1) || carriesPath(door.x, door.y - 1);

                if (!touchesPath) {
                    clearDoors++;
                    assert.equal(option.queueCutsOff, 0,
                        "a queue at " + String(door.x) + "," + String(door.y) + " has no footpath to join, so it removes no route");
                }
            });
        });

        assert.ok(clearDoors > 0, "no door was far enough from the path to be a control");
    } finally {
        restore();
    }
});

test("a shop is served from the neighbour its rotation points at", function () {
    const deltas = [{ dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 1, dy: 0 }, { dx: 0, dy: -1 }];

    for (let rotation = 0; rotation < 4; rotation++) {
        const { restore } = openPark(28);

        try {
            const result = findBuildSites(0, 5, rotation);
            const sites = result.sites || [];

            assert.ok(sites.length > 0, "no shop site at rotation " + String(rotation));

            sites.forEach(function (site) {
                assert.equal(site.access.length, 1, "a stall has exactly one serving tile, not four");
                assert.equal(site.access[0].x, site.x + deltas[rotation].dx,
                    "rotation " + String(rotation) + " is served from " + String(deltas[rotation].dx) + "," + String(deltas[rotation].dy));
                assert.equal(site.access[0].y, site.y + deltas[rotation].dy);
                assert.equal(site.access[0].door, undefined,
                    "`door` is a ride-entrance idea; following it puts the shop's path one tile too far out");
            });

            assert.match(String(result.note), /no entrance or exit/);
        } finally {
            restore();
        }
    }
});

test("live repro: a rotation-0 stall is served from -x, and that tile is offered even when it is already a path", function () {
    // Measured in the game: every rotation-0 stall site offered access on plus and minus y,
    // while the real serving tile (51,24) - already a footpath - was never in the list, and
    // a path laid on the offered tile gave edges=1, no connection at all.
    const game = new FakeGame(64, 40);
    game.rideObjects = [{ index: 0, name: "Burger Bar", rideType: [28] }];
    game.addParkEntrance(50, 20);
    game.addPath(51, 24);

    for (let x = 0; x < 64; x++) {
        for (let y = 0; y < 40; y++) {
            game.own(x, y, x >= 50 && x <= 54 && y >= 22 && y <= 26);
        }
    }

    const restore = game.install();

    try {
        const sites = findBuildSites(0, 50, 0).sites || [];
        assert.ok(sites.length > 0);

        assert.equal(sites[0].x, 52, "the tile beside the path is the nearest site");
        assert.equal(sites[0].y, 24);
        assert.equal(sites[0].pathDistance, 0, "its serving tile is the footpath itself");
        assert.deepEqual([sites[0].access[0].x, sites[0].access[0].y], [51, 24]);

        sites.forEach(function (site) {
            site.access.forEach(function (option) {
                assert.equal(option.y, site.y, "a rotation-0 stall is never served from plus or minus y");
                assert.equal(option.x, site.x - 1);
            });
        });
    } finally {
        restore();
    }
});

test("a shop is searched at all four rotations, because rotation is which side serves it", function () {
    // The only buildable tile is (12,12) and the only path is the tile above it, so the
    // one site that exists is rotation 1. Searching a square footprint at rotation 0 alone
    // - right for a ride, because rotation 2 is the same tiles - finds nothing here.
    const game = new FakeGame(24, 24);
    game.rideObjects = [{ index: 0, name: "Drink Stall", rideType: [30] }];
    game.addParkEntrance(4, 4);
    game.addPath(12, 13);

    for (let x = 0; x < 24; x++) {
        for (let y = 0; y < 24; y++) {
            game.own(x, y, (x === 12 && y === 12) || (x === 12 && y === 13));
        }
    }

    const restore = game.install();

    try {
        const all = findBuildSites(0, 10);
        assert.equal((all.sites || []).length, 1);
        assert.equal((all.sites || [])[0].rotation, 1);
        assert.deepEqual([(all.sites || [])[0].access[0].x, (all.sites || [])[0].access[0].y], [12, 13]);

        const rotationZero = findBuildSites(0, 10, 0);
        assert.equal((rotationZero.sites || []).length, 0);
        assert.match(String(rotationZero.note), /serving tile/);
    } finally {
        restore();
    }
});

test("a square footprint is not searched twice, which would double totalFound", function () {
    const { restore } = openPark(33);

    try {
        const both = findBuildSites(0, 3);
        const justZero = findBuildSites(0, 3, 0);

        assert.equal(both.totalFound, justZero.totalFound, "rotation 2 covers the same tiles as rotation 0");
        (both.sites || []).forEach(function (site) {
            assert.equal(site.rotation, 0);
        });
    } finally {
        restore();
    }
});

test("a place with room for only one door is not a site", function () {
    // A ride needs an entrance and an exit. One usable tile beside it is half a site, and
    // offering it sends the model to build_flat_ride with nowhere to put the exit.
    const game = new FakeGame(24, 24);
    game.rideObjects = [{ index: 0, name: "Merry-Go-Round", rideType: [33] }];
    game.addParkEntrance(2, 0);
    game.addPath(9, 10);

    for (let x = 0; x < 24; x++) {
        for (let y = 0; y < 24; y++) {
            const footprint = x >= 11 && x <= 13 && y >= 9 && y <= 11;
            game.own(x, y, footprint || (x === 10 && y === 10) || (x === 9 && y === 10));
        }
    }

    const restore = game.install();

    try {
        const result = findBuildSites(0, 10, 0);

        assert.equal(result.ok, true);
        assert.equal((result.sites || []).length, 0);
        assert.equal(result.totalFound, 0);
        assert.match(String(result.note), /entrance and one for the exit/);
    } finally {
        restore();
    }
});

test("finding nothing says which constraint nothing got past", function () {
    // "ok: true, sites: [], totalFound: 0" and no reason produced turns of re-guessed
    // coordinates. Each of these has a different fix, so each has to say a different thing.
    const tooBig = new FakeGame(24, 24);
    tooBig.rideObjects = [{ index: 0, name: "Dodgems", rideType: [25] }];

    for (let x = 0; x < 24; x++) {
        for (let y = 0; y < 24; y++) {
            tooBig.own(x, y, x >= 10 && x <= 11 && y >= 10 && y <= 11);
        }
    }

    let restore = tooBig.install();

    try {
        const result = findBuildSites(0, 3);
        assert.equal(result.ok, true);
        assert.equal((result.sites || []).length, 0);
        assert.match(String(result.note), /4x4/, "the size that would not fit has to be in the message");
        assert.match(String(result.note), /list_ride_objects/, "and the call that offers something smaller");
    } finally {
        restore();
    }

    const noRoomForDoors = new FakeGame(24, 24);
    noRoomForDoors.rideObjects = [{ index: 0, name: "Merry-Go-Round", rideType: [33] }];

    for (let x = 0; x < 24; x++) {
        for (let y = 0; y < 24; y++) {
            noRoomForDoors.own(x, y, x >= 10 && x <= 12 && y >= 10 && y <= 12);
        }
    }

    restore = noRoomForDoors.install();

    try {
        const result = findBuildSites(0, 3);
        assert.match(String(result.note), /entrance and one for the exit/);
        assert.match(String(result.note), /clear_scenery|buy the land/, "and what to do about it");
    } finally {
        restore();
    }
});

test("an index that does not exist names the call that lists the ones that do", function () {
    const { restore } = gameWith(33);

    try {
        const result = findBuildSites(9, 3);
        assert.equal(result.ok, false);
        assert.match(String(result.error), /index 9/);
        assert.match(String(result.error), /list_ride_objects/);
    } finally {
        restore();
    }
});

test("a ride object is found by its index, not by where it sits in the list", function () {
    // The loaded object list has gaps, and `list_ride_objects` reports `.index`. Reading
    // `rideObject` as a position instead measures sites for one ride and lets
    // build_flat_ride build a different one, with every step of both reporting success.
    const game = new FakeGame(24, 24);
    game.rideObjects = [
        { index: 5, name: "Merry-Go-Round", rideType: [33] },
        { index: 9, name: "Ferris Wheel", rideType: [37] }
    ];
    game.addParkEntrance(10, 0);

    for (let y = 1; y <= 20; y++) {
        game.addPath(10, y);
    }

    const restore = game.install();

    try {
        const byIndex = findBuildSites(9, 1);
        assert.equal(byIndex.ok, true);
        assert.equal((byIndex.ride || { name: "" }).name, "Ferris Wheel");
        assert.deepEqual([(byIndex.ride || { width: 0 }).width, (byIndex.ride || { depth: 0 }).depth], [1, 4]);

        const other = findBuildSites(5, 1);
        assert.equal((other.ride || { name: "" }).name, "Merry-Go-Round");

        // Position 1 is the ferris wheel. Asking for 1 must not find it, or the two tools
        // disagree about which ride the model asked for.
        const byPosition = findBuildSites(1, 1);
        assert.equal(byPosition.ok, false, "index 1 is not loaded; only 5 and 9 are");
        assert.match(String(byPosition.error), /not the same/);

        assert.equal(findBuildSites(0, 1).ok, false, "and neither is index 0");
    } finally {
        restore();
    }
});

test("no distance ever leaves as Infinity, which JSON turns into null", function () {
    // A park with no footpath at all is where every distance is unmeasurable, so it is the
    // case that leaks. -1 says "there is nothing to measure against"; null says nothing.
    const empty = gameWith(37);

    try {
        const result = findBuildSites(0, 5);
        const round = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;

        assert.equal(JSON.stringify(round).indexOf("null"), -1, "a null in the result is an Infinity that leaked: " + JSON.stringify(round));

        (result.sites || []).forEach(function (site) {
            assert.equal(isFinite(site.pathDistance), true);
            assert.equal(isFinite(site.nearestRideDistance), true);
            assert.equal(site.pathDistance, -1, "no footpath in the park, so there is no distance");

            site.access.forEach(function (option) {
                assert.equal(isFinite(option.pathDistance), true);
                assert.equal(isFinite(option.queueCutsOff), true);
            });
        });
    } finally {
        empty.restore();
    }

    const withPaths = openPark(37);

    try {
        const result = findBuildSites(0, 5);
        assert.equal(JSON.stringify(result).indexOf("null"), -1);
    } finally {
        withPaths.restore();
    }
});

test("a site's fromX/fromY/toX/toY is exactly the ground the ride stands on", function () {
    // The rectangle a model hands to clear_scenery. Checked against a real trackplace, not
    // against the code that produced it: a square centred on the origin clears 4 of the 16
    // tiles a 4x4 needs, and 25 tiles to place a 1x5, and it is right only for a 3x3.
    const rides = [
        { type: 33, trackType: 266, label: "3x3 merry-go-round" },
        { type: 37, trackType: 265, label: "1x4 ferris wheel" },
        { type: 25, trackType: 259, label: "4x4 dodgems" },
        { type: 26, trackType: 261, label: "1x5 pirate ship" },
        { type: 38, trackType: 258, label: "2x2 motion simulator" }
    ];
    let checked = 0;

    rides.forEach(function (ride) {
        for (let rotation = 0; rotation < 4; rotation++) {
            const { restore } = openPark(ride.type);
            let sites;

            try {
                sites = findBuildSites(0, 4, rotation).sites || [];
            } finally {
                restore();
            }

            assert.ok(sites.length > 0, ride.label + " at rotation " + String(rotation) + " found nowhere to go");

            sites.forEach(function (site) {
                const where = ride.label + " rotation " + String(rotation) + " origin "
                    + String(site.x) + "," + String(site.y);
                const footprint = realFootprint(24, ride.trackType, site.x, site.y, site.rotation);
                const inside: Record<string, boolean> = {};
                footprint.forEach(function (tile) { inside[tile] = true; });

                assert.ok(site.fromX <= site.toX && site.fromY <= site.toY, where + " has its corners the wrong way round");

                // Every tile of the ride is in the rectangle...
                footprint.forEach(function (tile) {
                    const parts = tile.split(",");
                    assert.ok(Number(parts[0]) >= site.fromX && Number(parts[0]) <= site.toX
                        && Number(parts[1]) >= site.fromY && Number(parts[1]) <= site.toY,
                    where + " stands on " + tile + ", outside the rectangle "
                        + String(site.fromX) + "," + String(site.fromY) + " to " + String(site.toX) + "," + String(site.toY));
                });

                // ...and nothing else is, so clearing it fells no tree the ride did not need.
                let area = 0;

                for (let x = site.fromX; x <= site.toX; x++) {
                    for (let y = site.fromY; y <= site.toY; y++) {
                        assert.equal(inside[String(x) + "," + String(y)], true,
                            where + " would clear " + String(x) + "," + String(y) + ", which the ride never covers");
                        area++;
                    }
                }

                assert.equal(area, footprint.length, where + " clears " + String(area) + " tiles to place " + String(footprint.length));

                // The origin is inside the footprint, which is why deriving the corners
                // from it and a size looks plausible and is wrong.
                assert.equal(inside[String(site.x) + "," + String(site.y)], true, where + " has its origin off the ride");
                checked++;
            });
        }
    });

    assert.ok(checked >= 20, "only " + String(checked) + " sites were checked");
});

test("sceneryToClear counts the trees inside the rectangle the site reports", function () {
    // The two fields have to be about the same ground, or the model clears a rectangle and
    // the count it was given never reaches zero.
    const { game, restore } = openPark(37);

    for (let x = 0; x < 24; x++) {
        for (let y = 0; y < 24; y++) {
            if ((x + y) % 3 === 0 && !(x === 10 && y >= 1)) {
                game.addScenery(x, y);
            }
        }
    }

    try {
        for (let rotation = 0; rotation < 4; rotation++) {
            const sites = findBuildSites(0, 5, rotation).sites || [];
            assert.ok(sites.length > 0);

            sites.forEach(function (site) {
                let trees = 0;

                for (let x = site.fromX; x <= site.toX; x++) {
                    for (let y = site.fromY; y <= site.toY; y++) {
                        if (game.tile(x, y).elements.filter(function (e) { return e.type === "small_scenery"; }).length > 0) {
                            trees++;
                        }
                    }
                }

                assert.equal(site.sceneryToClear, trees,
                    "site " + String(site.x) + "," + String(site.y) + " rotation " + String(rotation)
                    + " says " + String(site.sceneryToClear) + " trees, the rectangle holds " + String(trees));
            });
        }
    } finally {
        restore();
    }
});

test("a shop's rectangle is its one tile", function () {
    const { restore } = openPark(28);

    try {
        for (let rotation = 0; rotation < 4; rotation++) {
            (findBuildSites(0, 3, rotation).sites || []).forEach(function (site) {
                assert.deepEqual([site.fromX, site.fromY, site.toX, site.toY], [site.x, site.y, site.x, site.y]);
            });
        }
    } finally {
        restore();
    }
});

/**
 * The band and trunk that leave exactly one 3x3 site, at (13,10), with its three -x doors
 * on the trunk at (10,9), (10,10) and (10,11).
 */
function oneSitePark(): FakeGame {
    const game = new FakeGame(24, 24);
    game.rideObjects = [{ index: 0, name: "Merry-Go-Round", rideType: [33] }];
    game.addParkEntrance(9, 0);

    for (let y = 1; y <= 11; y++) {
        if (y !== 10) {
            game.addPath(10, y);
        }
    }

    for (let x = 0; x < 24; x++) {
        for (let y = 0; y < 24; y++) {
            game.own(x, y, x >= 10 && x <= 17 && y >= 9 && y <= 11);
        }
    }

    return game;
}

function doorKeys(sites: { access: { door?: { x: number; y: number } }[] }[]): string[] {
    const keys: string[] = [];

    sites.forEach(function (site) {
        site.access.forEach(function (option) {
            if (option.door) {
                keys.push(String(option.door.x) + "," + String(option.door.y));
            }
        });
    });

    return keys;
}

test("a door with a queue bound to no ride is offered, because placing the entrance chains it", function () {
    // What a demolished ride leaves behind. Refusing these made the obvious place to rebuild
    // read as having no access at all, with nothing in the result to say why.
    const game = oneSitePark();
    game.addPath(10, 10, true);

    const restore = game.install();

    try {
        const sites = findBuildSites(0, 50, 0).sites || [];
        assert.equal(sites.length, 1);

        const doors = doorKeys(sites);
        assert.ok(doors.indexOf("10,10") >= 0, "the unbound queue is a working door, offered: " + doors.join(" "));
        assert.ok(doors.indexOf("10,9") >= 0);
        assert.ok(doors.indexOf("10,11") >= 0);

        const onTheQueue = sites[0].access.filter(function (option) {
            return option.door && option.door.x === 10 && option.door.y === 10;
        })[0];

        assert.equal(onTheQueue.door && onTheQueue.door.hasUnboundQueue, true, "and it says the queue is already there");
        assert.equal(onTheQueue.door && onTheQueue.door.isExistingPath, true);

        // Nothing else on the map has a queue on it, so nothing else claims one.
        sites[0].access.forEach(function (option) {
            if (option.door && !(option.door.x === 10 && option.door.y === 10)) {
                assert.equal(option.door.hasUnboundQueue, false, String(option.door.x) + "," + String(option.door.y));
            }
        });
    } finally {
        restore();
    }
});

test("a door with a queue belonging to another ride is not offered", function () {
    // Bound the way the game binds it: a ride entrance, and the chain walked back from it.
    // Setting the field by hand would pass whatever the fake happened to store.
    const game = oneSitePark();
    game.addPath(10, 10, true);
    game.addRideEntrance(9, 10, 6, 0);

    const restore = game.install();

    try {
        const bound = game.tile(10, 10).elements.filter(function (e) { return e.type === "footpath"; })[0];
        assert.equal(bound.ride, 6, "the fake has to have actually chained the queue, or this test proves nothing");

        const sites = findBuildSites(0, 50, 0).sites || [];
        assert.equal(sites.length, 1, "the site is still there; only the one door is gone");

        const doors = doorKeys(sites);
        assert.equal(doors.indexOf("10,10"), -1,
            "building there would re-chain ride 6's queue and leave it with none: " + doors.join(" "));
        assert.ok(doors.indexOf("10,9") >= 0, "the plain path tiles either side of it are untouched");
        assert.ok(doors.indexOf("10,11") >= 0);
    } finally {
        restore();
    }
});
