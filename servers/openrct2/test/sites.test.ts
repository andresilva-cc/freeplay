import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import { MAX_ACCESS_OPTIONS, findBuildSites } from "../src/park/sites.ts";
import type { AccessOption, BuildSite } from "../src/park/sites.ts";
import { tileIsWalkable, walkableFromParkEntrance } from "../src/park/paths.ts";
import { SiteTools } from "../src/tools/sites.ts";
import { getMcpToolDefinitions } from "../src/tools/decorators.ts";

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
        // The gate is at the head of the path column, so the column is paving guests reach
        // and the distances this trim sorts on are real ones. A gate across the map would
        // leave every option at -1, where sorting by distance cannot be told from not
        // sorting at all.
        game.addParkEntrance(1, 0);
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

/**
 * The discriminator for the fallback this figure used to have: a door on BARE ground with
 * the trunk path one tile away. The old code charged such a door the worst of its four
 * neighbours, on the theory that the queue run to it would block the footpath it joined -
 * so 11,9 came back 2 and 11,10 came back 1, telling the model that a ride beside the main
 * path would cut the park up. It does not. A queue no ride has claimed is walked like any
 * other path, the run to the door is new ground that carried nobody, and only the door
 * tile itself dead-ends - and on bare ground there was no route through it to lose.
 */
test("a door on bare ground beside the trunk cuts nothing, whatever the trunk carries", function () {
    const game = new FakeGame(24, 24);
    game.rideObjects = [{ index: 0, name: "Merry-Go-Round", rideType: [33] }];
    game.addParkEntrance(9, 0);

    for (let y = 1; y <= 11; y++) {
        game.addPath(10, y);
    }

    // Owned land starts one tile east of the trunk, so every door lands on bare ground
    // next to it rather than on it.
    for (let x = 0; x < 24; x++) {
        for (let y = 0; y < 24; y++) {
            game.own(x, y, x >= 11 && x <= 16 && y >= 9 && y <= 11);
        }
    }

    const restore = game.install();

    try {
        const sites = findBuildSites(0, 50, 0).sites || [];
        assert.equal(sites.length, 1, "only one 3x3 site has room here");

        const doors = sites[0].access.map(function (option) {
            assert.ok(option.door, "a ride's access option must carry the door its queue goes on");
            return { at: String(option.door.x) + "," + String(option.door.y), cuts: option.queueCutsOff };
        });

        assert.deepEqual(doors, [
            { at: "11,9", cuts: 0 },
            { at: "11,10", cuts: 0 },
            { at: "11,11", cuts: 0 }
        ], "each of these is one tile from a trunk tile whose own severance is 2, 1 and 0");

        // The control: the trunk really does have something to lose, so the zeros above are
        // the rule changing and not an empty park.
        assert.equal(findBuildSites(0, 50, 0).sites?.length, 1);
    } finally {
        restore();
    }
});

/**
 * A door already carrying a queue no ride owns - what a demolished ride leaves behind, and
 * a door the search offers as a finished one. Placing an entrance here claims that queue,
 * which dead-ends the tile, so it can sever exactly like an ordinary path tile can. The
 * old code returned 0 for any tile that was already a queue.
 */
test("a door on an unbound queue in the trunk is charged for dead-ending it", function () {
    const game = new FakeGame(24, 24);
    game.rideObjects = [{ index: 0, name: "Merry-Go-Round", rideType: [33] }];
    game.addParkEntrance(9, 0);

    for (let y = 1; y <= 11; y++) {
        game.addPath(10, y, y === 10);
    }

    for (let x = 0; x < 24; x++) {
        for (let y = 0; y < 24; y++) {
            game.own(x, y, x >= 10 && x <= 17 && y >= 9 && y <= 11);
        }
    }

    const restore = game.install();

    try {
        const sites = findBuildSites(0, 50, 0).sites || [];
        assert.equal(sites.length, 1);

        const onTheQueue = sites[0].access.filter(function (option) {
            return option.door && option.door.x === 10 && option.door.y === 10;
        });

        assert.equal(onTheQueue.length, 1, "a door on an unbound queue is still offered");
        assert.equal(onTheQueue[0].door?.hasUnboundQueue, true);
        assert.equal(onTheQueue[0].queueCutsOff, 1,
            "an entrance here claims that queue and dead-ends 10,10, which strands 10,11");

        const below = sites[0].access.filter(function (option) {
            return option.door && option.door.x === 10 && option.door.y === 11;
        });

        assert.equal(below[0].queueCutsOff, 0,
            "and the tile past it is still reachable today, which is what makes the 1 above a real loss");
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

/**
 * The park the run produced, rebuilt: a trunk the gate reaches, and a five-tile fragment of
 * path further down that joins nothing - the "islands" park_status had listed in the turn
 * before find_build_sites offered a door on one as option #1, twice.
 *
 * Two identical bands of owned ground, one beside each, leave exactly one 3x3 site apiece
 * with three of its doors on the paving beside it. The two sites are the same shape and the
 * same distance from their own paving, and differ in one thing: whether a guest can get
 * there. That is what makes the pair a discriminator - a fixture with only the island in it
 * cannot tell a tool that measures reachability from one that reports false for everything.
 */
function trunkAndIslandPark(): FakeGame {
    const game = new FakeGame(24, 24);
    game.rideObjects = [{ index: 0, name: "Merry-Go-Round", rideType: [33] }];
    game.addParkEntrance(9, 0);

    // Joined to the gate at (10,0).
    for (let y = 1; y <= 6; y++) {
        game.addPath(10, y);
    }

    // Five tiles, joined to nothing.
    for (let y = 14; y <= 18; y++) {
        game.addPath(10, y);
    }

    for (let x = 0; x < 24; x++) {
        for (let y = 0; y < 24; y++) {
            game.own(x, y, x >= 10 && x <= 17 && ((y >= 4 && y <= 6) || (y >= 15 && y <= 17)));
        }
    }

    return game;
}

function optionForDoor(site: BuildSite, x: number, y: number): AccessOption | undefined {
    return site.access.filter(function (option) {
        return option.door && option.door.x === x && option.door.y === y;
    })[0];
}

function siteAt(sites: BuildSite[], x: number, y: number): BuildSite | undefined {
    return sites.filter(function (site) { return site.x === x && site.y === y; })[0];
}

test("a door on paving the gate cannot reach is not reported as a door on the network", function () {
    const game = trunkAndIslandPark();
    const restore = game.install();

    try {
        // The park's own answer, not a second implementation of one: whatever this says is
        // what the tool has to agree with.
        const walkable = walkableFromParkEntrance();

        assert.equal(tileIsWalkable(walkable, { x: 10, y: 5 }), true, "the trunk is paving guests reach");
        assert.equal(tileIsWalkable(walkable, { x: 10, y: 16 }), false, "the fragment is not, or this fixture proves nothing");

        const sites = findBuildSites(0, 50, 0).sites || [];
        const onTheTrunk = siteAt(sites, 13, 5);
        const onTheIsland = siteAt(sites, 13, 16);

        assert.ok(onTheTrunk, "the site beside the trunk: " + sites.map(function (s) { return String(s.x) + "," + String(s.y); }).join(" "));
        assert.ok(onTheIsland, "and the one beside the fragment, which is still offered rather than hidden");

        const good = optionForDoor(onTheTrunk, 10, 5);
        const stranded = optionForDoor(onTheIsland, 10, 16);

        assert.ok(good && good.door, "the trunk door");
        assert.ok(stranded && stranded.door, "the fragment door");

        // Both stand on a footpath, which is the whole difficulty: from the tile itself they
        // look identical, and both used to come back with the markers of the best door in the
        // park - pathDistance 0, isExistingPath true, queueCutsOff 0.
        assert.equal(good.door.isExistingPath, true);
        assert.equal(stranded.door.isExistingPath, true);

        assert.equal(good.door.guestsCanReach, true, "a guest walks from the gate to this one");
        assert.equal(stranded.door.guestsCanReach, false, "and can never arrive at this one");

        assert.equal(good.pathDistance, 0, "the trunk door is on the network");
        assert.equal(stranded.pathDistance, 10,
            "(10,16) to the nearest tile the gate reaches, (10,6), is ten tiles of paving - it used to read 0");

        assert.equal(good.door.island, undefined, "a door on the network belongs to no fragment");
        assert.deepEqual(stranded.door.island, { tiles: 5, fromX: 10, fromY: 14, toX: 10, toY: 18 },
            "and the fragment is named, by the same corners park_status lists it under");

        // Every door, not just the two picked out, agrees with the park's own reachability.
        sites.forEach(function (site) {
            site.access.forEach(function (option) {
                const door = option.door;
                assert.ok(door);
                assert.equal(door.guestsCanReach, tileIsWalkable(walkable, { x: door.x, y: door.y }),
                    String(door.x) + "," + String(door.y) + " disagrees with walkableFromParkEntrance");
            });
        });

        assert.equal(JSON.stringify(sites).indexOf("null"), -1, "an absent island is an absent field, not a null");
    } finally {
        restore();
    }
});

test("a door the gate cannot reach is still offered, with what it is attached to named", function () {
    // Excluding it would be the tool deciding the site is not worth having, and a fragment
    // is joinable: build_path reaches it, and then the ride on it earns. What the tool owes
    // the caller is the fact, which is `guestsCanReach` and `island` - docs/tool-design.md.
    const game = trunkAndIslandPark();
    const restore = game.install();

    try {
        const sites = findBuildSites(0, 50, 0).sites || [];
        const onTheIsland = siteAt(sites, 13, 16);

        assert.ok(onTheIsland, "the site beside the fragment is in the list at all");

        const doors = onTheIsland.access.filter(function (option) {
            return option.door && option.door.x === 10;
        });

        assert.equal(doors.length, 3, "all three tiles of the fragment beside the ride are offered");
        doors.forEach(function (option) {
            assert.equal(option.door && option.door.guestsCanReach, false);
            assert.ok(option.door && option.door.island, "each says which fragment it is on");
        });
    } finally {
        restore();
    }
});

/**
 * The same two bands, with the ground beside the trunk stopping two tiles short of it, so
 * the network site's best door is on bare ground two tiles out while the fragment site's
 * door is on paving. Measured against any paving at all, the fragment site is the 0 and
 * sorts first - which is the run's failure exactly: option #1, taken in 4 of 4 builds.
 *
 * Nothing here reorders anything. The comparator is the same ascending pathDistance it has
 * always been; the number it sorts on stopped counting paving guests cannot reach.
 */
function islandOutranksNetworkPark(): FakeGame {
    const game = new FakeGame(24, 24);
    game.rideObjects = [{ index: 0, name: "Merry-Go-Round", rideType: [33] }];
    game.addParkEntrance(9, 0);

    for (let y = 1; y <= 6; y++) {
        game.addPath(10, y);
    }

    for (let y = 14; y <= 18; y++) {
        game.addPath(10, y);
    }

    for (let x = 0; x < 24; x++) {
        for (let y = 0; y < 24; y++) {
            const besideTheTrunk = x >= 12 && x <= 18 && y >= 4 && y <= 6;
            const besideTheIsland = x >= 10 && x <= 18 && y >= 15 && y <= 17;
            game.own(x, y, besideTheTrunk || besideTheIsland);
        }
    }

    return game;
}

test("a site whose doors are on a stranded fragment does not outrank one on the network", function () {
    const game = islandOutranksNetworkPark();
    const restore = game.install();

    try {
        const walkable = walkableFromParkEntrance();
        const sites = findBuildSites(0, 50, 0).sites || [];
        const first = sites[0];

        assert.ok(first, "the park holds sites at all");
        assert.deepEqual([first.x, first.y], [15, 5],
            "the site beside the trunk, whose best door is two tiles of bare ground from it");
        assert.equal(first.pathDistance, 2);

        const door = first.access[0].door;
        assert.ok(door);
        assert.equal(door.isExistingPath, false, "it is not even on a footpath, which is what makes this the test");

        const onTheIsland = siteAt(sites, 13, 16);
        assert.ok(onTheIsland, "and the fragment site is still in the list, below it");
        assert.equal(onTheIsland.pathDistance, 9,
            "nine tiles from its best door at (10,15) to (10,6), the nearest tile the gate reaches");

        const strandedDoor = optionForDoor(onTheIsland, 10, 15);
        assert.ok(strandedDoor && strandedDoor.door);
        assert.equal(strandedDoor.door.isExistingPath, true, "measured against paving anywhere this door is the 0");
        assert.equal(tileIsWalkable(walkable, { x: 10, y: 15 }), false, "and no guest can stand on it");

        assert.ok(sites.indexOf(onTheIsland) > sites.indexOf(first),
            "so the honest number, not a rule about islands, is what puts it second");
    } finally {
        restore();
    }
});

/**
 * The cut the game itself makes: a ride's entrance claiming the queue at its door clears the
 * edge on the far side of that tile, so the line past it is still touching the network and
 * still unreachable. Every tile here is adjacent to the next, so a reachability walked by
 * adjacency - which is what this tool used to do - calls the whole trunk reachable and the
 * fragment does not exist. Only the game's `edges` say otherwise, and paths.ts reads them.
 */
function severedTrunkPark(): FakeGame {
    const game = new FakeGame(24, 24);
    game.rideObjects = [{ index: 0, name: "Merry-Go-Round", rideType: [33] }];
    game.addParkEntrance(9, 0);

    for (let y = 1; y <= 18; y++) {
        game.addPath(10, y);
    }

    game.severPath(10, 9, 10, 10);

    for (let x = 0; x < 24; x++) {
        for (let y = 0; y < 24; y++) {
            game.own(x, y, x >= 10 && x <= 17 && ((y >= 4 && y <= 6) || (y >= 15 && y <= 17)));
        }
    }

    return game;
}

test("a fragment cut off by the game's own edges counts as cut off here too", function () {
    const game = severedTrunkPark();
    const restore = game.install();

    try {
        const carriesPath = function (x: number, y: number): boolean {
            return game.tile(x, y).elements.filter(function (e) { return e.type === "footpath"; }).length > 0;
        };

        // The two tiles either side of the cut are neighbours and both carry path, so
        // adjacency cannot tell this park from an unbroken trunk. The game can.
        assert.equal(carriesPath(10, 9), true);
        assert.equal(carriesPath(10, 10), true);

        const walkable = walkableFromParkEntrance();
        assert.equal(tileIsWalkable(walkable, { x: 10, y: 9 }), true);
        assert.equal(tileIsWalkable(walkable, { x: 10, y: 10 }), false, "the game's edges are what cut this line");

        const sites = findBuildSites(0, 50, 0).sites || [];
        const beyondTheCut = siteAt(sites, 13, 16);

        assert.ok(beyondTheCut, "the site past the cut");

        const stranded = optionForDoor(beyondTheCut, 10, 15);
        assert.ok(stranded && stranded.door);

        assert.equal(stranded.door.isExistingPath, true);
        assert.equal(stranded.door.guestsCanReach, false, "adjacency would have called this door reachable");
        assert.equal(stranded.pathDistance, 6, "(10,15) to (10,9), the last tile the gate reaches");
        assert.deepEqual(stranded.door.island, { tiles: 9, fromX: 10, fromY: 10, toX: 10, toY: 18 },
            "and the fragment is the nine tiles past the cut");
    } finally {
        restore();
    }
});

test("queueCutsOff counts what stops being reachable, so a door nothing reaches is 0", function () {
    // The figure answers "how many tiles stop being reachable", which is a question about
    // tiles that are reachable now. Past the cut there are five more tiles of path beyond
    // (10,15) and dead-ending it takes none of them from anybody: they were already gone.
    // Walked by adjacency the same door came back 3, a loss the park had already taken.
    const game = severedTrunkPark();
    const restore = game.install();

    try {
        const sites = findBuildSites(0, 50, 0).sites || [];
        const beyondTheCut = siteAt(sites, 13, 16);
        const onTheTrunk = siteAt(sites, 13, 5);

        assert.ok(beyondTheCut && onTheTrunk);

        const stranded = optionForDoor(beyondTheCut, 10, 15);
        const reachable = optionForDoor(onTheTrunk, 10, 5);

        assert.ok(stranded && stranded.door && reachable && reachable.door);

        assert.equal(stranded.queueCutsOff, 0, "nothing reachable stands past a door nothing reaches");
        assert.equal(stranded.door.guestsCanReach, false, "which is the field that tells that 0 from the other one");

        // The control: the same door position on the reachable half really does cost
        // something, so the 0 above is the fragment and not severance switched off.
        assert.equal(reachable.queueCutsOff, 4,
            "an entrance at (10,5) dead-ends it, stranding (10,6) to (10,9) - and nothing past the cut, which is already lost");
        assert.equal(reachable.door.guestsCanReach, true);
    } finally {
        restore();
    }
});

test("a park whose only paving the gate cannot reach measures against none of it", function () {
    // -1 means there was nothing to measure against. Paving guests cannot reach is nothing
    // to measure against, and the alternative - falling back to it when the network is
    // empty - is the same false 0 arriving by a quieter route.
    const game = new FakeGame(24, 24);
    game.rideObjects = [{ index: 0, name: "Merry-Go-Round", rideType: [33] }];
    game.addParkEntrance(9, 0);

    for (let y = 14; y <= 18; y++) {
        game.addPath(10, y);
    }

    // Narrow enough that the only 3x3 that fits has its doors on the fragment and nowhere
    // else, so the numbers below are that door's and not some bare tile's further out.
    for (let x = 0; x < 24; x++) {
        for (let y = 0; y < 24; y++) {
            game.own(x, y, x >= 10 && x <= 14 && y >= 15 && y <= 17);
        }
    }

    const restore = game.install();

    try {
        const result = findBuildSites(0, 50, 0);
        const sites = result.sites || [];

        assert.equal(result.ok, true);
        assert.ok(sites.length > 0, "a park with unreachable paving is still buildable, not unbuildable: " + String(result.note));

        const site = siteAt(sites, 13, 16);
        assert.ok(site);
        assert.equal(site.pathDistance, -1, "there is no reachable footpath to measure against");

        const stranded = optionForDoor(site, 10, 16);
        assert.ok(stranded && stranded.door);
        assert.equal(stranded.pathDistance, -1);
        assert.equal(stranded.door.isExistingPath, true, "the tile is paved");
        assert.equal(stranded.door.guestsCanReach, false, "and it is paving nobody can get to");
        assert.equal(stranded.door.island && stranded.door.island.tiles, 5);
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
            assert.match(String(result.note), /0 is -x, 1 is \+y, 2 is \+x, 3 is -y/,
                "which neighbour each rotation serves from is the game's geometry and has to stay");
            assert.match(String(result.note), /an ordinary path, not a queue/,
                "that a stall takes a path rather than a queue is a rule, not a preference");
            assert.match(String(result.note), /there is no `door` beyond it/,
                "and why it is that tile itself, not one further out, stays with it");
            assert.doesNotMatch(String(result.note), /Run build_path/,
                "whether to pave that tile at all is the decision find_build_sites exists to hand over");
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
    // Beside the footpath rather than across the map from it: every distance here is
    // measured against the paving the gate reaches, so a gate that reaches none of it
    // would make this a park with no measurable path in it at all.
    game.addParkEntrance(50, 23);
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
    game.addParkEntrance(12, 14);
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
        assert.match(String(result.note), /owned, level tiles all at one height/,
            "and the constraint nothing got past");
        // docs/tool-design.md: naming the constraint is mechanics; naming a lever picks which
        // constraint to relax, which is the model's call - and "level land" named a lever no
        // tool has, which is what teaches it to invent action names.
        assert.doesNotMatch(String(result.note), /smaller ride|list_ride_objects/,
            "what to build instead is not the refusal's to suggest");
        assert.doesNotMatch(String(result.note), /[Bb]uy|[Ll]evel land/,
            "nor which constraint to relax");
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
        // clear_scenery could never have changed this answer: scenery is explicitly not a
        // blocker for an access tile, so the old "clear_scenery around one of them" pointed
        // at a call that does nothing here. State what a usable tile is instead.
        assert.match(String(result.note), /Scenery alone never disqualifies/, "and what a usable tile is");
        assert.doesNotMatch(String(result.note), /clear_scenery|buy the land/,
            "without naming a lever, one of which was inert here");
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

test("accessTotal counts every door position, not the ones that fit in the window", function () {
    // `access` is a window; `accessTotal` is what tells the model it is one. A 4x4 in open
    // ground has sixteen tiles around it and the window holds eight, so a field that
    // reported the window's own length would say "eight of eight" forever and no caller
    // would ever think to look past the list it was handed.
    const { restore } = openPark(25);

    try {
        const sites = findBuildSites(0, 5).sites || [];
        assert.ok(sites.length > 0);

        const open = sites.filter(function (site) {
            return site.accessTotal === 16;
        });

        assert.ok(open.length > 0, "a 4x4 in open ground has sixteen door positions: "
            + sites.map(function (site) { return String(site.accessTotal); }).join(" "));

        sites.forEach(function (site) {
            const where = String(site.x) + "," + String(site.y);

            assert.ok(site.access.length <= MAX_ACCESS_OPTIONS, where + " overflowed the window");
            assert.ok(site.accessTotal >= site.access.length,
                where + ": accessTotal " + String(site.accessTotal) + " is below the " + String(site.access.length)
                    + " options it is supposed to be counting");
        });

        assert.ok(open.some(function (site) { return site.accessTotal > site.access.length; }),
            "no site reported more positions than it listed, so the window reads as the whole list");
    } finally {
        restore();
    }
});

/**
 * A park with exactly one 3x3 site, whose two doors are (14,11) and (14,12).
 *
 * Everything is pinned to one place so a door's own numbers can be asserted rather than
 * searched for: the owned strip is five wide and three tall with its top-right corner cut
 * off, which leaves (11,11) the only origin a 3x3 fits at with doors it can reach.
 */
function oneDoorPark(): FakeGame {
    const game = new FakeGame(24, 24);
    game.rideObjects = [{ index: 0, name: "Merry-Go-Round", rideType: [33] }];
    // The gate sits under the footpath these tests lay at (17,14), because a distance is
    // measured to paving guests can reach and paving the gate reaches nothing of is not
    // measured against at all.
    game.addParkEntrance(17, 15);

    for (let x = 0; x < 24; x++) {
        for (let y = 0; y < 24; y++) {
            game.own(x, y, x >= 10 && x <= 14 && y >= 10 && y <= 12 && !(x === 14 && y === 10));
        }
    }

    return game;
}

test("pathDistance is walked in tiles, not measured across the diagonal", function () {
    // The only footpath sits three tiles across and three down from the door at (14,11).
    // A guest walks orthogonally, so that is six tiles. Chebyshev - the metric that counts
    // a diagonal step as one - calls it three, and would have the model believe every
    // stretch of queue it has to lay is half the length it really is.
    const game = oneDoorPark();
    game.addPath(17, 14);

    const restore = game.install();

    try {
        const sites = findBuildSites(0, 50).sites || [];
        assert.equal(sites.length, 1, "the park is built to hold exactly one site");

        const doorAt = function (x: number, y: number) {
            return sites[0].access.filter(function (option) {
                return option.door && option.door.x === x && option.door.y === y;
            })[0];
        };

        const far = doorAt(14, 11);
        const near = doorAt(14, 12);

        assert.ok(far && near, "both doors are offered");
        assert.equal(far.pathDistance, 6, "(14,11) to (17,14) is 3 across and 3 down, which is 6 tiles of walking");
        assert.equal(near.pathDistance, 5, "(14,12) to (17,14) is 3 across and 2 down");

        // Chebyshev would make both of these 3, and the site's own distance 3 with them.
        assert.equal(sites[0].pathDistance, 5, "the site reports its nearest door");
    } finally {
        restore();
    }
});

test("needsClearing covers the door tile, not just the tile the building stands on", function () {
    // A tree on the door is as much in the way as a tree under the entrance: the queue has
    // to reach that tile. Reporting the option as clear sends the model to build_flat_ride
    // without the clear_scenery the door needs, and sceneryToClear will not cover for it -
    // that counts the ride's own ground, which here is bare.
    const game = oneDoorPark();
    game.addPath(17, 14);
    game.addScenery(14, 11);

    const restore = game.install();

    try {
        const sites = findBuildSites(0, 50).sites || [];
        assert.equal(sites.length, 1);
        assert.equal(sites[0].sceneryToClear, 0, "nothing stands on the ride's own ground");

        const doorAt = function (x: number, y: number) {
            return sites[0].access.filter(function (option) {
                return option.door && option.door.x === x && option.door.y === y;
            })[0];
        };

        assert.equal(doorAt(14, 11).needsClearing, true, "the tree is on this option's door");
        assert.equal(doorAt(14, 12).needsClearing, false, "and only on that one");
    } finally {
        restore();
    }
});

/** A stall on (12,12) whose only possible serving tile, (11,12), carries a path or a queue. */
function stallServedBy(queue: boolean): FakeGame {
    const game = new FakeGame(24, 24);
    game.rideObjects = [{ index: 0, name: "Burger Bar", rideType: [28] }];
    // Joined to the gate, so the tile under test is paving guests reach rather than a
    // stranded fragment, which is a different question and has its own tests.
    game.addParkEntrance(8, 12);

    for (let x = 0; x < 24; x++) {
        for (let y = 0; y < 24; y++) {
            game.own(x, y, y === 12 && (x === 11 || x === 12));
        }
    }

    game.addPath(11, 12, queue);
    return game;
}

test("a stall is not offered a serving tile that is a queue", function () {
    // Guests in a queue are walking to a ride, not stopping at a counter, so a stall whose
    // only neighbour is queue sells nothing. Worth pinning rather than inferring from the
    // path case: the two halves of `cell.path && !cell.queue` fail in opposite directions,
    // and dropping the queue half reads as widening the search rather than breaking it.
    const served = stallServedBy(false);
    let restore = served.install();

    try {
        const sites = findBuildSites(0, 10, 0).sites || [];

        assert.equal(sites.length, 1, "an ordinary footpath beside the stall is the best serving tile there is");
        assert.deepEqual([sites[0].x, sites[0].y], [12, 12]);
        assert.deepEqual([sites[0].access[0].x, sites[0].access[0].y], [11, 12]);
    } finally {
        restore();
    }

    const queued = stallServedBy(true);
    restore = queued.install();

    try {
        const result = findBuildSites(0, 10, 0);

        assert.deepEqual(result.sites, [], "the same spot, served only by a queue, is not a site");
        assert.match(String(result.note), /serving tile/);
    } finally {
        restore();
    }
});

test("the tool clamps `limit` into range instead of passing it through", function () {
    // The schema refuses anything outside 1..50 before the handler runs, so the clamp is
    // what holds when the handler is reached any other way. 5000 walks a whole park into
    // one reply; 0 returns an empty list, which reads as "nowhere fits" rather than as a
    // limit of zero.
    const game = new FakeGame(40, 40);
    game.rideObjects = [{ index: 0, name: "Merry-Go-Round", rideType: [33] }];
    game.addParkEntrance(10, 0);

    for (let y = 1; y <= 36; y++) {
        game.addPath(10, y);
    }

    const restore = game.install();

    try {
        // What an unclamped limit does here, so the two numbers below are the clamp and
        // not a coincidence of how many sites this park happens to hold.
        assert.ok((findBuildSites(0, 5000).sites || []).length > 50, "the park has more than 50 sites to give");
        assert.equal((findBuildSites(0, 0).sites || []).length, 0);

        const tools = new SiteTools();

        assert.equal((tools.findBuildSites({ rideObject: 0, limit: 5000 }).sites || []).length, 50,
            "50 is what reaches findBuildSites");
        assert.equal((tools.findBuildSites({ rideObject: 0, limit: 0 }).sites || []).length, 1, "and 1");
        assert.equal((tools.findBuildSites({ rideObject: 0 }).sites || []).length, 3, "an absent limit is 3");
    } finally {
        restore();
    }
});

test("`limit` says how big a site is and never how few to ask for", function () {
    // docs/tool-design.md: the size of a result is a fact about it. Telling the model to
    // ask for fewer discourages looking at alternatives, which is the deliberation this
    // tool exists to enable - and a description is read every single turn.
    const definitions = getMcpToolDefinitions(SiteTools).filter(function (definition) {
        return definition.handlerName === "findBuildSites";
    });

    assert.equal(definitions.length, 1, "find_build_sites is registered once");

    const properties = definitions[0].inputSchema.properties || {};
    const limit = String((properties.limit as { description?: string }).description);

    assert.match(limit, /sizeable/, "how large one site is stays: it is a fact about the result");
    assert.match(limit, /default 3, max 50/, "and so do the bounds");
    assert.doesNotMatch(limit, /ask for more only|only when you need/,
        "how many alternatives to look at is the model's call");
});

/**
 * Measured against the running game: turning two path tiles into a queue changed no edge
 * bit at all (51,24 and 51,25 of Forest Frontiers, `edges` 10 before and 10 after), so the
 * reason this description gave for `queueCutsOff` - that guests cannot walk through a queue -
 * was false, and it painted every door beside the trunk path as a park cut in two. What
 * severs is a ride claiming the tile its door opens onto.
 *
 * The absence of the old sentence is pinned as hard as the presence of the new one. A
 * falsehood this old comes back from a stale branch or a half-remembered paragraph, and the
 * description is read on every turn the tool is in play.
 */
test("find_build_sites says what actually severs a route, and not that a queue does", function () {
    const definitions = getMcpToolDefinitions(SiteTools).filter(function (definition) {
        return definition.handlerName === "findBuildSites";
    });

    assert.equal(definitions.length, 1, "find_build_sites is registered once");

    const text = String(definitions[0].description);

    assert.match(text, /Guests walk a queue like any other path/,
        "a queue is ordinary walkable path, which is the measured fact");
    assert.match(text, /a ride claiming one, which dead-ends the single tile its door opens onto/,
        "and the one thing that does sever a route");
    assert.match(text, /a door on bare ground is 0/,
        "so the queue run to a door on new ground carries nobody away");
    assert.match(text, /only a door whose `isExistingPath` is true .* can be above 0/,
        "and the only doors the figure can charge");
    assert.doesNotMatch(text, /cannot walk through/,
        "the disproven rule, which converting a path to a queue in the running game refuted");
    assert.doesNotMatch(text, /cuts that many tiles off the park/,
        "and the claim it was used to make about every positive number");
    assert.doesNotMatch(text, /matters most/,
        "no door is weighted: the ordering is distance to a path and the choice is the model's");
});

/**
 * The description is read on every turn the tool is in play, and the sentence it used to
 * carry - that a distance is to "the nearest footpath", -1 when "the park has no footpath at
 * all" - is the defect written down: it says paving is paving, which is what made a door on
 * a stranded fragment read as the best door in the park. The absence of that wording is
 * pinned as hard as the presence of the new.
 */
test("find_build_sites says a distance is to paving guests can reach", function () {
    const definitions = getMcpToolDefinitions(SiteTools).filter(function (definition) {
        return definition.handlerName === "findBuildSites";
    });

    assert.equal(definitions.length, 1, "find_build_sites is registered once");

    const text = String(definitions[0].description);

    assert.match(text, /`guestsCanReach` says whether a guest can walk to that tile from the park gate/,
        "the field that separates a door on the network from one on a fragment");
    assert.match(text, /the nearest footpath the gate reaches/,
        "and what pathDistance is counted against");
    assert.match(text, /`island` then gives that fragment's tile count and corners/,
        "the fragment a stranded door stands on, named rather than left to be inferred");
    assert.match(text, /-1 when the gate reaches no footpath at all/,
        "-1 is about the reachable network, not about paving anywhere");
    assert.doesNotMatch(text, /-1 when the park has no footpath at all/,
        "the old claim, which was false in a park whose paving the gate could not reach");
    assert.doesNotMatch(text, /avoid|do not build|prefer a door/,
        "what to do about a stranded door is the model's call, not the description's");
});

/**
 * A 40x40 park, entirely owned and flat, with the gate and a three-tile path stub in one
 * corner and nothing anywhere else.
 *
 * Every 3x3 block of it is a site, so the matched set covers the whole map, while the
 * sites returned are forced into the corner the stub is in - which is the shape the real
 * park has and the shape no small hand-built fixture reproduces. A test that only ever
 * looks at parks where the window and the set coincide cannot tell the two apart, which
 * is the entire bug this field can have.
 */
function sprawlingPark(): { game: FakeGame; restore: () => void } {
    const game = new FakeGame(40, 40);
    game.rideObjects = [{ index: 0, name: "Merry-Go-Round", rideType: [33] }];
    game.addParkEntrance(2, 0);

    for (let y = 1; y <= 3; y++) {
        game.addPath(2, y);
    }

    return { game: game, restore: game.install() };
}

test("candidateExtent spans every site found, not the corner the returned ones sit in", function () {
    const { restore } = sprawlingPark();

    try {
        const result = findBuildSites(0, 3);
        const sites = result.sites || [];
        const extent = result.candidateExtent;

        assert.equal(sites.length, 3);
        assert.equal(result.totalFound, 1430, "every 3x3 block of a 40x40 park is a site");
        assert.ok(extent, "a search that found sites reports where they are");

        // The three handed back are packed against the path stub: nothing beyond (12,12).
        // This is the premise the rest of the test rests on, so it is asserted rather than
        // assumed - without it the two boxes could coincide and the comparison prove nothing.
        sites.forEach(function (site) {
            assert.ok(site.toX <= 12 && site.toY <= 12,
                "site " + String(site.x) + "," + String(site.y) + " is not in the corner the stub is in");
        });

        // And the set they were cut from reaches all four edges of the map. Computing the
        // extent from the trimmed list instead of from everything found gives at most
        // 0,0-12,12 here: every one of these four fails, and the failure names itself.
        assert.equal(extent?.fromX, 0, "the matched set starts at the near edge of the map");
        assert.equal(extent?.fromY, 0);
        assert.equal(extent?.toX, 39, "and runs to the far edge, 27 tiles past the furthest site returned");
        assert.equal(extent?.toY, 39);
    } finally {
        restore();
    }
});

test("candidateExtent's distance range is the whole set's, not the three returned", function () {
    const { restore } = sprawlingPark();

    try {
        const result = findBuildSites(0, 3);
        const sites = result.sites || [];
        const extent = result.candidateExtent;

        assert.ok(extent);

        // The near end is the site already at the top of the list: the sort puts the global
        // nearest first, so this end of the range costs nothing to act on and is not news.
        assert.equal(extent?.nearestPathDistance, 0, "the nearest site stands on the path");
        assert.equal(extent?.nearestPathDistance, sites[0].pathDistance,
            "which is the first site's own distance, because that is what the sort means");

        // The far end is the far corner of a 40-tile park measured back to a stub in the
        // near one. No returned site is above 3, so a range taken after the trim reads
        // 0..3 and this assertion fails - which is what makes it worth asserting.
        const furthestReturned = sites.reduce(function (worst, site) {
            return Math.max(worst, site.pathDistance);
        }, 0);

        assert.equal(furthestReturned, 3, "the returned sites are all but on the path");
        assert.equal(extent?.furthestPathDistance, 67,
            "while connecting the furthest site found is 67 tiles of paving");
    } finally {
        restore();
    }
});

test("candidateExtent is the ground the sites stand on, not their build origins", function () {
    // A 3x3 is centred on its origin, so the two are three tiles apart in every direction
    // and a site's own corners are the ones already reported. Accumulating `x`,`y` instead
    // gives 11,11-11,11 here - a park-wide extent one footprint too small on every side,
    // and one that says a ride fits on a single tile.
    const game = oneDoorPark();
    game.addPath(17, 14);

    const restore = game.install();

    try {
        const result = findBuildSites(0, 50);
        const sites = result.sites || [];

        assert.equal(sites.length, 1, "the park is built to hold exactly one site");
        assert.equal(sites[0].x, 11, "whose origin is one tile");
        assert.equal(sites[0].y, 11);

        assert.deepEqual(result.candidateExtent, {
            fromX: 10,
            fromY: 10,
            toX: 12,
            toY: 12,
            nearestPathDistance: 5,
            furthestPathDistance: 5
        }, "one site's extent is that site's own rectangle and its own distance, twice over");
    } finally {
        restore();
    }
});

test("a park with nothing to measure against reports -1 at both ends of the range", function () {
    // -1 means there was nothing to measure against, and it has to survive into the range
    // as itself. Infinity is what the arithmetic wants to produce and JSON turns it into
    // null; a counter left at 0 would report the whole park as already on a path.
    const { restore } = gameWith(33);

    try {
        const result = findBuildSites(0, 3);
        const extent = result.candidateExtent;

        assert.ok(extent, "a park with no path still found sites, so it still has an extent");
        assert.equal(extent?.fromX, 0, "which covers the park");
        assert.equal(extent?.toX, 23);

        assert.equal(extent?.nearestPathDistance, -1);
        assert.equal(extent?.furthestPathDistance, -1);
        (result.sites || []).forEach(function (site) {
            assert.equal(site.pathDistance, -1, "and every site agrees, which is why the range can say it");
        });
    } finally {
        restore();
    }
});

test("a search that found nothing reports no extent rather than an empty one", function () {
    // Zeroed corners would put the whole matched set on tile 0,0 - a claim about a park
    // where nothing matched at all. Absent is the only honest shape, and it is the shape
    // `ride` and `note` already use.
    const game = new FakeGame(24, 24);
    game.rideObjects = [{ index: 0, name: "Dodgems", rideType: [25] }];

    for (let x = 0; x < 24; x++) {
        for (let y = 0; y < 24; y++) {
            game.own(x, y, x >= 10 && x <= 11 && y >= 10 && y <= 11);
        }
    }

    const restore = game.install();

    try {
        const result = findBuildSites(0, 3);

        assert.equal(result.totalFound, 0);
        assert.equal(result.candidateExtent, undefined, "nothing found spans nothing");
    } finally {
        restore();
    }
});

test("find_build_sites says candidateExtent measures the whole set, not the list", function () {
    const definitions = getMcpToolDefinitions(SiteTools).filter(function (definition) {
        return definition.handlerName === "findBuildSites";
    });

    assert.equal(definitions.length, 1, "find_build_sites is registered once");

    const text = String(definitions[0].description);

    // Which set it measures is the whole content of the field. A description that named it
    // without saying that leaves it indistinguishable from a summary of the three returned,
    // which is the reading it exists to prevent.
    assert.match(text, /`candidateExtent` measures that same whole set rather than the returned list/,
        "the fact that does the work: it is the set the window was cut from");
    assert.match(text, /smallest and largest `pathDistance` among them/,
        "and the cost range, in the unit each site already reports");

    // docs/tool-design.md: the description states what the world is and never what to do
    // about it. A spread of candidates is a measurement; building further out is a choice.
    assert.doesNotMatch(text, /further out|spread out|more variety|vary the|consider a site|elsewhere in the park/,
        "where to build is the model's call, not the description's");
    assert.doesNotMatch(text, /best|better site|recommend|should pick/,
        "and no site is marked as good: the ordering is distance and the choice is the model's");
});
