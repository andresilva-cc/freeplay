import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import { describePlacement } from "../src/park/sites.ts";
import type { AccessOption, PlacementResult } from "../src/park/sites.ts";
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

/** A 24x24 park the park owns all of, with the gate at the head of a path column at x=10. */
function openPark(rideType: number, size = 24): { game: FakeGame; restore: () => void } {
    const game = new FakeGame(size, size);
    game.rideObjects = [{ index: 0, name: "Test Ride", rideType: [rideType] }];
    game.addParkEntrance(10, 0);

    for (let y = 1; y <= size - 4; y++) {
        game.addPath(10, y);
    }

    return { game: game, restore: game.install() };
}

function access(result: PlacementResult): AccessOption[] {
    return result.access || [];
}

function optionForDoor(result: PlacementResult, x: number, y: number): AccessOption | undefined {
    return access(result).filter(function (option) {
        return option.door && option.door.x === x && option.door.y === y;
    })[0];
}

function doorKeys(result: PlacementResult): string[] {
    return access(result).filter(function (option) {
        return typeof option.door !== "undefined";
    }).map(function (option) {
        return String(option.door?.x) + "," + String(option.door?.y);
    });
}

function blockerAt(result: PlacementResult, x: number, y: number): string | undefined {
    return (result.blockers || []).filter(function (blocker) {
        return blocker.x === x && blocker.y === y;
    }).map(function (blocker) {
        return blocker.reason;
    })[0];
}

test("a tracked ride is refused, with a reason", function () {
    const { restore } = gameWith(0);

    try {
        const result = describePlacement(0, 10, 10, 0);
        assert.equal(result.ok, false);
        assert.match(String(result.error), /built from track/);
    } finally {
        restore();
    }
});

test("an index that does not exist names the call that lists the ones that do", function () {
    const { restore } = gameWith(33);

    try {
        const result = describePlacement(9, 10, 10, 0);
        assert.equal(result.ok, false);
        assert.match(String(result.error), /index 9/);
        assert.match(String(result.error), /list_ride_objects/);
    } finally {
        restore();
    }
});

test("a ride object is found by its index, not by where it sits in the list", function () {
    // The loaded object list has gaps, and `list_ride_objects` reports `.index`. Reading
    // `rideObject` as a position instead describes a placement for one ride and lets
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
        const byIndex = describePlacement(9, 16, 16, 0);
        assert.equal(byIndex.ok, true);
        assert.equal((byIndex.ride || { name: "" }).name, "Ferris Wheel");
        assert.deepEqual([(byIndex.ride || { width: 0 }).width, (byIndex.ride || { depth: 0 }).depth], [1, 4]);

        const other = describePlacement(5, 16, 16, 0);
        assert.equal((other.ride || { name: "" }).name, "Merry-Go-Round");

        // Position 1 is the ferris wheel. Asking for 1 must not find it, or the two tools
        // disagree about which ride the model asked for.
        const byPosition = describePlacement(1, 16, 16, 0);
        assert.equal(byPosition.ok, false, "index 1 is not loaded; only 5 and 9 are");
        assert.match(String(byPosition.error), /not the same/);

        assert.equal(describePlacement(0, 16, 16, 0).ok, false, "and neither is index 0");
    } finally {
        restore();
    }
});

test("a tile off the map is refused with the map's own bounds, not described as unbuildable", function () {
    // The difference matters: `fits: false` says a real tile will not take the ride, and a
    // coordinate outside the map is a question that cannot be asked at all. Reporting the
    // second as the first sends the model looking for what is standing on a tile that does
    // not exist.
    const { restore } = gameWith(33);

    try {
        const offMap = describePlacement(0, 40, 4, 0);

        assert.equal(offMap.ok, false);
        assert.match(String(offMap.error), /no tile at 40,4/);
        assert.match(String(offMap.error), /0 to 23 across/, "the bounds have to be in the message");

        assert.equal(describePlacement(0, 10, 10, 0).ok, true, "and a tile on the map is still described");
    } finally {
        restore();
    }
});

/**
 * No rotation is chosen for the caller, at either layer.
 *
 * The tool this replaced searched every rotation and returned the ones that fit, so which
 * way round a ride stood was decided by a sort. A default here would be the same decision
 * in a smaller place: 0 for every ride, forever, with nothing in the result to say a choice
 * had been made.
 */
test("a rotation is required and never filled in, wrapped or clamped", function () {
    const { restore } = openPark(33);

    try {
        const tools = new SiteTools();

        const missing = tools.describePlacement({ rideObject: 0, x: 16, y: 16 });
        assert.equal(missing.ok, false, "an absent rotation is refused, not defaulted to 0");
        assert.match(String(missing.error), /`rotation` is 0, 1, 2 or 3/);

        const wrapped = describePlacement(0, 16, 16, 4);
        assert.equal(wrapped.ok, false, "4 is refused rather than read as 0");
        assert.match(String(wrapped.error), /not wrapped/);

        assert.equal(describePlacement(0, 16, 16, -1).ok, false);

        for (let rotation = 0; rotation < 4; rotation++) {
            const result = tools.describePlacement({ rideObject: 0, x: 16, y: 16, rotation: rotation });
            assert.equal(result.ok, true, "rotation " + String(rotation) + " is a question with an answer");
            assert.equal(result.rotation, rotation, "and the answer says which rotation it answered for");
        }
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

/** The rides whose footprint offsets are not a formula, which is all of them. */
const RIDES = [
    { type: 33, trackType: 266, label: "3x3 merry-go-round" },
    { type: 37, trackType: 265, label: "1x4 ferris wheel" },
    { type: 27, trackType: 263, label: "1x4 swinging inverter ship" },
    { type: 25, trackType: 259, label: "4x4 dodgems" },
    { type: 26, trackType: 261, label: "1x5 pirate ship" },
    { type: 38, trackType: 258, label: "2x2 motion simulator" }
];

test("the footprint reported is exactly the ground the ride stands on, at every rotation", function () {
    // The rectangle a model hands to clear_scenery, and the reason this tool still exists at
    // all: a footprint is not a formula. Checked against a real trackplace, not against the
    // code that produced it - a square centred on the origin clears 4 of the 16 tiles a 4x4
    // needs, and 25 tiles to place a 1x5, and it is right only for a 3x3.
    let checked = 0;

    RIDES.forEach(function (ride) {
        for (let rotation = 0; rotation < 4; rotation++) {
            const { restore } = openPark(ride.type);
            let result: PlacementResult;

            try {
                result = describePlacement(0, 16, 16, rotation);
            } finally {
                restore();
            }

            const where = ride.label + " rotation " + String(rotation) + " origin 16,16";
            const footprint = result.footprint;

            assert.equal(result.ok, true, where + ": " + String(result.error));
            assert.ok(footprint, where + " reported no footprint");
            assert.equal(result.fits, true, where + " does not fit in open ground: " + String(result.ground));

            const laid = realFootprint(24, ride.trackType, 16, 16, rotation);
            const inside: Record<string, boolean> = {};
            laid.forEach(function (tile) { inside[tile] = true; });

            assert.ok(laid.length > 0, where + " laid no track");
            assert.equal(footprint.tiles, laid.length, where + " counts " + String(footprint.tiles)
                + " tiles and the game lays " + String(laid.length));
            assert.ok(footprint.fromX <= footprint.toX && footprint.fromY <= footprint.toY,
                where + " has its corners the wrong way round");

            // Every tile of the ride is in the rectangle...
            laid.forEach(function (tile) {
                const parts = tile.split(",");
                assert.ok(Number(parts[0]) >= footprint.fromX && Number(parts[0]) <= footprint.toX
                    && Number(parts[1]) >= footprint.fromY && Number(parts[1]) <= footprint.toY,
                where + " stands on " + tile + ", outside the rectangle "
                    + String(footprint.fromX) + "," + String(footprint.fromY) + " to "
                    + String(footprint.toX) + "," + String(footprint.toY));
            });

            // ...and nothing else is, so clearing it fells no tree the ride did not need.
            const corners = [footprint.fromX, footprint.fromY, footprint.toX, footprint.toY];
            let area = 0;

            for (let x = corners[0]; x <= corners[2]; x++) {
                for (let y = corners[1]; y <= corners[3]; y++) {
                    assert.equal(inside[String(x) + "," + String(y)], true,
                        where + " would clear " + String(x) + "," + String(y) + ", which the ride never covers");
                    area++;
                }
            }

            assert.equal(area, laid.length, where + " clears " + String(area) + " tiles to place " + String(laid.length));

            // The origin is inside the footprint, which is why deriving the corners from it
            // and a size looks plausible and is wrong. A 1x4 proves it is not the centre
            // either: it runs -2..+1, so the origin sits off centre by half a tile.
            assert.equal(inside["16,16"], true, where + " has its origin off the ride");
            checked++;
        }
    });

    assert.equal(checked, 24, "six rides at four rotations each");
});

test("a shop's footprint is the one tile it stands on, at every rotation", function () {
    const { restore } = openPark(28);

    try {
        for (let rotation = 0; rotation < 4; rotation++) {
            const result = describePlacement(0, 16, 16, rotation);

            assert.deepEqual(result.footprint, { fromX: 16, fromY: 16, toX: 16, toY: 16, tiles: 1 },
                "a stall covers its own tile and no other, whichever way it faces");
        }
    } finally {
        restore();
    }
});

/**
 * The property the whole class of door bugs violates, checked against the tiles the game
 * lays rather than against the plugin's own idea of them.
 *
 * `build_flat_ride` returns ok:true for a door that touches nothing, because it reports
 * that the entrance action succeeded rather than reading adjacency back; the game then
 * says "Guests can't get to the entrance of X!". This is the assertion that catches that
 * from the describing side, at every rotation at once.
 */
test("every access tile touches the ride, at every rotation", function () {
    let checked = 0;

    RIDES.forEach(function (ride) {
        for (let rotation = 0; rotation < 4; rotation++) {
            const { restore } = openPark(ride.type);
            let options: AccessOption[];

            try {
                options = access(describePlacement(0, 16, 16, rotation));
            } finally {
                restore();
            }

            const laid = realFootprint(24, ride.trackType, 16, 16, rotation);
            const inside: Record<string, boolean> = {};
            laid.forEach(function (tile) { inside[tile] = true; });

            assert.ok(options.length > 0, ride.label + " at rotation " + String(rotation) + " offered no door at all");

            options.forEach(function (option) {
                const where = ride.label + " rotation " + String(rotation) + " access "
                    + String(option.x) + "," + String(option.y);

                assert.equal(inside[String(option.x) + "," + String(option.y)], undefined,
                    where + " is inside the ride itself");

                const touching = laid.filter(function (tile) {
                    const parts = tile.split(",");
                    return Math.abs(Number(parts[0]) - option.x) + Math.abs(Number(parts[1]) - option.y) === 1;
                });

                assert.equal(touching.length > 0, true,
                    where + " touches no tile of the ride; the ride is on " + laid.join(" "));
                checked++;
            });
        }
    });

    assert.ok(checked > 100, "only " + String(checked) + " access tiles were checked");
});

test("the side an access tile is named by is the side it is on", function () {
    // Verified against tile coordinates rather than against the direction index, because
    // SIDE_NAMES being rotated by one is invisible to anything that reads the same index back.
    const { restore } = openPark(25);
    let options: AccessOption[];

    try {
        options = access(describePlacement(0, 16, 16, 1));
    } finally {
        restore();
    }

    const laid = realFootprint(24, 259, 16, 16, 1);
    assert.ok(options.length > 0);
    let checked = 0;

    options.forEach(function (option) {
        const neighbour = laid.filter(function (tile) {
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

    assert.ok(checked > 0);
});

/**
 * The list is every position there is, in the order the tiles ring the footprint, and in
 * no other order.
 *
 * Both halves are the point of this tool. The one it replaced sorted by distance to a path
 * and then cut the list to eight, and the model took entry #1 in 12 builds out of 12. A
 * 4x4 in open ground has sixteen positions and the old window could show at most half of
 * them.
 */
test("every door position is listed, and the list is not sorted by anything", function () {
    // Origin 5,12 puts the path column at x=10 off the ride's +x side, so the ring - which
    // starts on -x - reaches the far doors first and the distance-0 doors eleventh. In a
    // park where the ring happened to agree with distance this assertion would pass under
    // a sort as well, and prove nothing.
    const { restore } = openPark(25);

    try {
        const result = describePlacement(0, 5, 12, 0);
        const options = access(result);

        assert.equal(options.length, 16, "a 4x4 in open ground has sixteen door positions, and all sixteen are listed");

        const distances = options.map(function (option) { return option.pathDistance; });

        assert.deepEqual(distances, [7, 5, 7, 7, 7, 5, 4, 4, 3, 3, 0, 2, 0, 0, 0, 2],
            "the ring order, which is a shape rather than a ranking");

        const sorted = distances.slice().sort(function (left, right) { return left - right; });
        assert.notDeepEqual(distances, sorted,
            "a list in ascending distance order is a list something ranked, which is the decision this tool gave back");

        // And the near doors really are in there, so the un-sortedness above is a list that
        // was left alone rather than a park with nothing to sort.
        assert.equal(distances.filter(function (d) { return d === 0; }).length, 4,
            "four doors open straight onto the path column");
    } finally {
        restore();
    }
});

test("scenery does not stop a placement, it is counted", function () {
    const { game, restore } = openPark(33);

    for (let x = 15; x <= 17; x++) {
        for (let y = 15; y <= 17; y++) {
            game.addScenery(x, y);
        }
    }

    try {
        const result = describePlacement(0, 16, 16, 0);

        assert.equal(result.fits, true, "a forest is buildable once cleared, not unbuildable");
        assert.deepEqual(result.blockers, [], "and a tree is not a blocker");
        assert.equal(result.sceneryToClear, 9, "every tile of the footprint carries one");
        assert.match(String(result.ground), /9 tiles of it carry scenery/);
        assert.match(String(result.ground), /clear_scenery/, "which is the call that takes it down");
    } finally {
        restore();
    }
});

test("sceneryToClear counts the trees inside the rectangle the placement reports", function () {
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
            const result = describePlacement(0, 16, 16, rotation);
            const footprint = result.footprint;

            assert.ok(footprint);

            let trees = 0;

            for (let x = footprint.fromX; x <= footprint.toX; x++) {
                for (let y = footprint.fromY; y <= footprint.toY; y++) {
                    if (game.tile(x, y).elements.filter(function (e) { return e.type === "small_scenery"; }).length > 0) {
                        trees++;
                    }
                }
            }

            assert.ok(trees > 0, "rotation " + String(rotation) + " has no tree on it, so it is not a test");
            assert.equal(result.sceneryToClear, trees,
                "rotation " + String(rotation) + " says " + String(result.sceneryToClear)
                + " trees, the rectangle holds " + String(trees));
        }
    } finally {
        restore();
    }
});

test("unowned ground is named tile by tile, not refused as a whole", function () {
    // The search reported "nowhere in the park fits" and left the model re-guessing
    // coordinates. A named placement can say which of its own tiles are the problem, and
    // this is the half of the answer no search could give.
    const { game, restore } = openPark(33);

    for (let y = 0; y < 24; y++) {
        game.own(17, y, false);
    }

    try {
        const result = describePlacement(0, 16, 16, 0);

        assert.equal(result.ok, true, "the question was asked and answered");
        assert.equal(result.fits, false);
        assert.equal((result.blockers || []).length, 3, "the whole -x..+x column at x=17 is outside the park");
        assert.equal(blockerAt(result, 17, 15), "is not land the park owns");
        assert.equal(blockerAt(result, 16, 16), undefined, "and the tiles that are the park's are not blockers");

        assert.match(String(result.ground), /3 are not land the park owns/);
        assert.match(String(result.ground), /The other 6 tiles could\./);
        assert.doesNotMatch(String(result.ground), /buy_land|buy the land|somewhere else|try /i,
            "which constraint to relax, and where else to look, are the caller's");
    } finally {
        restore();
    }
});

test("sloped ground and a step in height are different answers, and neither is a slope", function () {
    // Two conditions the model cannot see and cannot fix - no tool levels ground - and they
    // are told apart because the remedies differ: a slope is never buildable, while a step
    // means the origin was picked one terrace off.
    const { game, restore } = openPark(33);

    game.tile(15, 15).elements[0].slope = 4;
    game.tile(17, 17).elements[0].baseZ = 112;

    try {
        const result = describePlacement(0, 16, 16, 0);

        assert.equal(result.z, 96, "the ride stands at the origin tile's own height, which is where build_flat_ride reads it");
        assert.equal(result.fits, false);
        assert.equal(blockerAt(result, 15, 15), "is on a slope, and a ride needs level ground");
        assert.equal(blockerAt(result, 17, 17), "is at height 112 and the ride stands at height 96");

        assert.match(String(result.ground), /1 are on a slope/);
        assert.match(String(result.ground), /1 stand at a different height from the ride's origin/);
    } finally {
        restore();
    }
});

test("the height everything is judged against is the origin's, the tile build_flat_ride reads", function () {
    // build_flat_ride takes the ride's height from the origin tile and refuses any footprint
    // tile or door that is not level with it. A describe that used the commonest height
    // under the footprint, or the first tile's, would call a placement level that the build
    // then refuses - and the model would have no way to tell which of the two was lying.
    const { game, restore } = openPark(33);

    // The origin is the odd one out: eight tiles at 96 and the origin at 112.
    game.tile(16, 16).elements[0].baseZ = 112;

    try {
        const result = describePlacement(0, 16, 16, 0);

        assert.equal(result.z, 112, "a majority vote would have said 96 here");
        assert.equal((result.blockers || []).length, 8, "the other eight tiles are the ones out of step");
        assert.equal(blockerAt(result, 15, 15), "is at height 96 and the ride stands at height 112");

        assert.equal(access(result).length, 0,
            "and no door is level with a ride standing a terrace above everything around it");
    } finally {
        restore();
    }
});

test("a placement that does not fit still reports the doors it would have", function () {
    // Refusing to describe the rest of a blocked placement would send the model back to
    // guessing whole origins when one tile of nine is the problem. The two readings are kept
    // apart by `fits`, which is false whatever the doors say.
    const { game, restore } = openPark(33);

    game.own(15, 15, false);

    try {
        const result = describePlacement(0, 16, 16, 0);

        assert.equal(result.fits, false);
        assert.equal((result.blockers || []).length, 1);
        assert.equal(access(result).length, 12, "a 3x3 has twelve door positions and they are all still measured");
    } finally {
        restore();
    }
});

test("a ride already standing there is what stops the placement, named by what it is", function () {
    // Live repro C: the dodgems refused to build at a rotation-1 site with "Ferris Wheel 3
    // in the way", because the tool had checked a 4x4 block three tiles away from the one
    // the game was going to use. The footprint offsets are the fix, and this is the check:
    // whatever the game would lay on is what gets judged, at every rotation.
    const { game, restore } = openPark(25);

    for (let x = 14; x <= 17; x++) {
        for (let y = 14; y <= 17; y++) {
            game.addScenery(x, y, "track");
        }
    }

    try {
        for (let rotation = 0; rotation < 4; rotation++) {
            const result = describePlacement(0, 16, 16, rotation);
            const laid = realFootprint(24, 259, 16, 16, rotation);
            const expected = laid.filter(function (tile) {
                const parts = tile.split(",");
                return Number(parts[0]) >= 14 && Number(parts[0]) <= 17
                    && Number(parts[1]) >= 14 && Number(parts[1]) <= 17;
            });

            assert.ok(expected.length > 0, "rotation " + String(rotation) + " overlaps nothing, so it is not a test");
            assert.equal(result.fits, false, "rotation " + String(rotation) + " would be built on a ride");
            assert.deepEqual((result.blockers || []).map(function (blocker) {
                return String(blocker.x) + "," + String(blocker.y);
            }).sort(), expected.slice().sort(),
            "rotation " + String(rotation) + " must block on exactly the tiles the game would lay on the ride");

            assert.match(String(blockerAt(result, Number(expected[0].split(",")[0]), Number(expected[0].split(",")[1]))),
                /carries ride track, which is not scenery a bulldozer removes/,
                "and say what is standing there rather than \"a structure\"");
        }
    } finally {
        restore();
    }
});

test("a park with no footpath still describes a placement, at -1", function () {
    const { restore } = gameWith(33);

    try {
        const result = describePlacement(0, 10, 10, 0);

        assert.equal(result.ok, true);
        assert.equal(result.fits, true, "an empty park is buildable, not unbuildable");
        access(result).forEach(function (option) {
            assert.equal(option.pathDistance, -1, "-1 says there is no path to measure against");
        });
    } finally {
        restore();
    }
});

test("no distance ever leaves as Infinity, which JSON turns into null", function () {
    // A park with no footpath at all is where every distance is unmeasurable, so it is the
    // case that leaks. -1 says "there is nothing to measure against"; null says nothing.
    const empty = gameWith(37);

    try {
        const result = describePlacement(0, 10, 10, 0);
        const round = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;

        assert.equal(JSON.stringify(round).indexOf("null"), -1,
            "a null in the result is an Infinity that leaked: " + JSON.stringify(round));
        assert.equal(isFinite(Number(result.nearestRideDistance)), true);

        access(result).forEach(function (option) {
            assert.equal(isFinite(option.pathDistance), true);
            assert.equal(isFinite(option.queueCutsOff), true);
        });
    } finally {
        empty.restore();
    }

    const withPaths = openPark(37);

    try {
        assert.equal(JSON.stringify(describePlacement(0, 16, 16, 0)).indexOf("null"), -1);
    } finally {
        withPaths.restore();
    }
});

test("nearestRideDistance counts the gate, so an empty park is not -1", function () {
    const { restore } = openPark(33);

    try {
        const result = describePlacement(0, 16, 16, 0);

        // The gate is three tiles wide from 10,0, so its nearest tile is (12,0): four across
        // and sixteen down from the origin. Nothing else in the park carries track.
        assert.equal(result.nearestRideDistance, 20, "measured from the origin to the park's own gate");
    } finally {
        restore();
    }
});

/**
 * The trunk park of the severance tests: a path at x=10 running y=1..11, with an owned band
 * beside it at x 10..17, y 9..11. A 3x3 at origin 13,10 covers 12..14 x 9..11, which puts
 * three of its doors on the trunk at (10,9), (10,10) and (10,11) and three on bare ground
 * at x=16.
 */
function trunkDoorPark(): FakeGame {
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

    return game;
}

test("a door that a queue would join is marked with what it cuts off", function () {
    // Eight "N path tiles are no longer reachable" events came from queueing the trunk
    // path. Queueing the top door strands two tiles, the middle one strands one, and the
    // dead end at the bottom strands nothing. Same placement, same distance, three answers.
    const game = trunkDoorPark();
    const restore = game.install();

    try {
        const result = describePlacement(0, 13, 10, 0);
        const byDoor: Record<string, { queueCutsOff: number; isExistingPath: boolean }> = {};

        access(result).forEach(function (option) {
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
        assert.equal(byDoor["10,9"].isExistingPath, true,
            "a door already on the path network is offered like any other, not rejected");

        // Away from the trunk there is nothing to cut, and the doors say so rather than
        // saying nothing.
        assert.equal(byDoor["16,10"].queueCutsOff, 0);
        assert.equal(byDoor["16,10"].isExistingPath, false);
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
 * other path, the run to the door is new ground that carried nobody, and only the door tile
 * itself dead-ends - and on bare ground there was no route through it to lose.
 */
test("a door on bare ground beside the trunk cuts nothing, whatever the trunk carries", function () {
    const game = new FakeGame(24, 24);
    game.rideObjects = [{ index: 0, name: "Merry-Go-Round", rideType: [33] }];
    game.addParkEntrance(9, 0);

    for (let y = 1; y <= 11; y++) {
        game.addPath(10, y);
    }

    // Owned land starts one tile east of the trunk, so every door lands on bare ground next
    // to it rather than on it.
    for (let x = 0; x < 24; x++) {
        for (let y = 0; y < 24; y++) {
            game.own(x, y, x >= 11 && x <= 16 && y >= 9 && y <= 11);
        }
    }

    const restore = game.install();

    try {
        const result = describePlacement(0, 14, 10, 0);
        const doors = access(result).filter(function (option) {
            return option.door && option.door.x === 11;
        }).map(function (option) {
            return { at: String(option.door?.x) + "," + String(option.door?.y), cuts: option.queueCutsOff };
        });

        assert.deepEqual(doors, [
            { at: "11,9", cuts: 0 },
            { at: "11,10", cuts: 0 },
            { at: "11,11", cuts: 0 }
        ], "each of these is one tile from a trunk tile whose own severance is 2, 1 and 0");

        // The control: the trunk really does have something to lose, which is what makes the
        // three zeros above the rule and not an empty park.
        const onTheTrunk = trunkDoorPark();
        const restoreTrunk = onTheTrunk.install();

        try {
            assert.equal(optionForDoor(describePlacement(0, 13, 10, 0), 10, 9)?.queueCutsOff, 2);
        } finally {
            restoreTrunk();
        }
    } finally {
        restore();
    }
});

/**
 * A door already carrying a queue no ride owns - what a demolished ride leaves behind, and
 * a door offered as a finished one. Placing an entrance here claims that queue, which
 * dead-ends the tile, so it can sever exactly like an ordinary path tile can. The old code
 * returned 0 for any tile that was already a queue.
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
        const result = describePlacement(0, 13, 10, 0);
        const onTheQueue = optionForDoor(result, 10, 10);

        assert.ok(onTheQueue, "a door on an unbound queue is still offered");
        assert.equal(onTheQueue.door?.hasUnboundQueue, true);
        assert.equal(onTheQueue.queueCutsOff, 1,
            "an entrance here claims that queue and dead-ends 10,10, which strands 10,11");

        assert.equal(optionForDoor(result, 10, 11)?.queueCutsOff, 0,
            "and the tile past it is still reachable today, which is what makes the 1 above a real loss");
    } finally {
        restore();
    }
});

test("a queue that cuts nothing is never flagged", function () {
    // The flag has to be rare enough to mean something. A placement with no footpath near
    // any of its doors has nothing to join and nothing to cut, and every option must come
    // back 0 - otherwise the model learns to ignore the number.
    const { restore } = openPark(33);

    try {
        const result = describePlacement(0, 16, 16, 0);
        const options = access(result);

        assert.equal(options.length, 12);
        options.forEach(function (option) {
            assert.ok(option.pathDistance >= 2,
                "no door here is even next to the path column, which is what makes this a control");
            assert.equal(option.queueCutsOff, 0,
                "a queue at " + String(option.door?.x) + "," + String(option.door?.y)
                + " has no footpath to join, so it removes no route");
        });
    } finally {
        restore();
    }
});

/**
 * The park the run produced, rebuilt: a trunk the gate reaches, and a five-tile fragment of
 * path further down that joins nothing - the "islands" park_status had listed in the turn
 * before the old tool offered a door on one as option #1, twice.
 *
 * Two identical bands of owned ground, one beside each, take the same 3x3 at 13,5 and at
 * 13,16 with three of its doors on the paving beside it. The two placements are the same
 * shape and the same distance from their own paving, and differ in one thing: whether a
 * guest can get there. That is what makes the pair a discriminator - a fixture with only
 * the island in it cannot tell a tool that measures reachability from one that reports
 * false for everything.
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

test("a door on paving the gate cannot reach is not reported as a door on the network", function () {
    const game = trunkAndIslandPark();
    const restore = game.install();

    try {
        // The park's own answer, not a second implementation of one: whatever this says is
        // what the tool has to agree with.
        const walkable = walkableFromParkEntrance();
        assert.equal(tileIsWalkable(walkable, { x: 10, y: 5 }), true, "the trunk is paving guests reach");
        assert.equal(tileIsWalkable(walkable, { x: 10, y: 16 }), false, "the fragment is not, or this fixture proves nothing");

        const onTheTrunk = describePlacement(0, 13, 5, 0);
        const onTheIsland = describePlacement(0, 13, 16, 0);

        assert.equal(onTheTrunk.fits, true);
        assert.equal(onTheIsland.fits, true, "the fragment's band is buildable ground too");

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

        // Every door of both, not just the two picked out, agrees with the park's own
        // reachability.
        [onTheTrunk, onTheIsland].forEach(function (result) {
            access(result).forEach(function (option) {
                const door = option.door;
                assert.ok(door);
                assert.equal(door.guestsCanReach, tileIsWalkable(walkable, { x: door.x, y: door.y }),
                    String(door.x) + "," + String(door.y) + " disagrees with walkableFromParkEntrance");
            });
        });

        assert.equal(JSON.stringify(onTheTrunk).indexOf("null"), -1, "an absent island is an absent field, not a null");
    } finally {
        restore();
    }
});

test("a door the gate cannot reach is still offered, with what it is attached to named", function () {
    // Leaving it out would be the tool deciding the placement is not worth having, and a
    // fragment is joinable: build_path reaches it, and then the ride on it earns. What the
    // tool owes the caller is the fact, which is `guestsCanReach` and `island`.
    const game = trunkAndIslandPark();
    const restore = game.install();

    try {
        const result = describePlacement(0, 13, 16, 0);
        const doors = access(result).filter(function (option) {
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
 * the network placement's doors are on bare ground two tiles out while the fragment
 * placement's are on paving. Measured against any paving at all, the fragment reads 0 -
 * which is the run's failure exactly: it was option #1, taken in 4 of 4 builds.
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
            // The trunk is the park's own walk, so the park owns it. A distance is measured
            // only against paving the park could lay path onto, and a trunk on land it owned
            // nothing of would be unmeasurable-against - which would leave every door in this
            // fixture at -1 and the numbers below with nothing in them.
            const theTrunk = x === 10 && y >= 1 && y <= 6;
            const besideTheTrunk = x >= 12 && x <= 18 && y >= 4 && y <= 6;
            const besideTheIsland = x >= 10 && x <= 18 && y >= 15 && y <= 17;
            game.own(x, y, theTrunk || besideTheTrunk || besideTheIsland);
        }
    }

    return game;
}

test("a door on a stranded fragment is measured to the network, not to the paving under it", function () {
    const game = islandOutranksNetworkPark();
    const restore = game.install();

    try {
        const walkable = walkableFromParkEntrance();
        const onTheNetwork = describePlacement(0, 15, 5, 0);
        const onTheIsland = describePlacement(0, 13, 16, 0);

        const bare = optionForDoor(onTheNetwork, 12, 5);
        const stranded = optionForDoor(onTheIsland, 10, 15);

        assert.ok(bare && bare.door && stranded && stranded.door);

        assert.equal(bare.door.isExistingPath, false, "bare ground two tiles from the trunk");
        assert.equal(bare.pathDistance, 2);

        assert.equal(stranded.door.isExistingPath, true, "measured against paving anywhere this door is the 0");
        assert.equal(tileIsWalkable(walkable, { x: 10, y: 15 }), false, "and no guest can stand on it");
        assert.equal(stranded.pathDistance, 9,
            "nine tiles from (10,15) to (10,6), the nearest tile the gate reaches - it used to read 0");
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
            const theTrunk = x === 10 && y >= 1 && y <= 18;
            const bands = x >= 10 && x <= 17 && ((y >= 4 && y <= 6) || (y >= 15 && y <= 17));
            game.own(x, y, theTrunk || bands);
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

        const stranded = optionForDoor(describePlacement(0, 13, 16, 0), 10, 15);
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
    // tiles that are reachable now. Past the cut there are three more tiles of path beyond
    // (10,15) and dead-ending it takes none of them from anybody: they were already gone.
    // Walked by adjacency the same door came back 3, a loss the park had already taken.
    const game = severedTrunkPark();
    const restore = game.install();

    try {
        const stranded = optionForDoor(describePlacement(0, 13, 16, 0), 10, 15);
        const reachable = optionForDoor(describePlacement(0, 13, 5, 0), 10, 5);

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

    for (let x = 0; x < 24; x++) {
        for (let y = 0; y < 24; y++) {
            game.own(x, y, x >= 10 && x <= 14 && y >= 15 && y <= 17);
        }
    }

    const restore = game.install();

    try {
        const result = describePlacement(0, 13, 16, 0);

        assert.equal(result.ok, true);
        assert.equal(result.fits, true, "a park with unreachable paving is still buildable");

        const stranded = optionForDoor(result, 10, 16);
        assert.ok(stranded && stranded.door);
        assert.equal(stranded.pathDistance, -1, "there is no reachable footpath to measure against");
        assert.equal(stranded.door.isExistingPath, true, "the tile is paved");
        assert.equal(stranded.door.guestsCanReach, false, "and it is paving nobody can get to");
        assert.equal(stranded.door.island && stranded.door.island.tiles, 5);
    } finally {
        restore();
    }
});

/**
 * The band and trunk of `trunkDoorPark` with the trunk's middle tile left out, so a queue
 * can be laid there without the path under it deciding the answer.
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

test("a door with a queue bound to no ride is offered, because placing the entrance chains it", function () {
    // What a demolished ride leaves behind. Refusing these made the obvious place to rebuild
    // read as having no access at all, with nothing in the result to say why.
    const game = oneSitePark();
    game.addPath(10, 10, true);

    const restore = game.install();

    try {
        const result = describePlacement(0, 13, 10, 0);
        const doors = doorKeys(result);

        assert.ok(doors.indexOf("10,10") >= 0, "the unbound queue is a working door, offered: " + doors.join(" "));
        assert.ok(doors.indexOf("10,9") >= 0);
        assert.ok(doors.indexOf("10,11") >= 0);

        const onTheQueue = optionForDoor(result, 10, 10);
        assert.equal(onTheQueue?.door?.hasUnboundQueue, true, "and it says the queue is already there");
        assert.equal(onTheQueue?.door?.isExistingPath, true);

        // Nothing else on the map has a queue on it, so nothing else claims one.
        access(result).forEach(function (option) {
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

        const result = describePlacement(0, 13, 10, 0);
        const doors = doorKeys(result);

        assert.equal(result.fits, true, "the placement is still there; only the one door is gone");
        assert.equal(doors.indexOf("10,10"), -1,
            "building there would re-chain ride 6's queue and leave it with none: " + doors.join(" "));
        assert.ok(doors.indexOf("10,9") >= 0, "the plain path tiles either side of it are untouched");
        assert.ok(doors.indexOf("10,11") >= 0);
    } finally {
        restore();
    }
});

/**
 * A park with room for one 3x3 at 11,11 and two door positions, at (13,11) and (13,12).
 *
 * Everything is pinned to one place so a door's own numbers can be asserted rather than
 * searched for: the owned strip is five wide and three tall with its top-right corner cut
 * off, and the one footpath in the park is a stub at (17,14) under the gate.
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
            // (17,14) is where these tests lay the one footpath, and the park owns it: a
            // distance is measured only against paving the park could lay path onto, so a
            // stub on land it owns nothing of would leave every distance here -1 and the
            // numbers these tests assert would stop being numbers at all.
            const theStrip = x >= 10 && x <= 14 && y >= 10 && y <= 12 && !(x === 14 && y === 10);
            game.own(x, y, theStrip || (x === 17 && y === 14));
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
        const result = describePlacement(0, 11, 11, 0);

        assert.equal(access(result).length, 2, "the strip leaves exactly two door positions");

        const far = optionForDoor(result, 14, 11);
        const near = optionForDoor(result, 14, 12);

        assert.ok(far && near, "both doors are offered");
        assert.equal(far.pathDistance, 6, "(14,11) to (17,14) is 3 across and 3 down, which is 6 tiles of walking");
        assert.equal(near.pathDistance, 5, "(14,12) to (17,14) is 3 across and 2 down");
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
        const result = describePlacement(0, 11, 11, 0);

        assert.equal(result.sceneryToClear, 0, "nothing stands on the ride's own ground");
        assert.equal(optionForDoor(result, 14, 11)?.needsClearing, true, "the tree is on this option's door");
        assert.equal(optionForDoor(result, 14, 12)?.needsClearing, false, "and only on that one");
    } finally {
        restore();
    }
});

test("a placement with room for only one door says a ride needs two", function () {
    // A ride needs an entrance and an exit. One usable tile beside it is half a placement,
    // and the search this replaced dropped such places silently - which told the model
    // nothing about the origin it had just asked about.
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
        const result = describePlacement(0, 12, 10, 0);

        assert.equal(result.ok, true);
        assert.equal(result.fits, true, "the ground takes the ride; it is the doors that are missing");
        assert.equal(access(result).length, 1);
        assert.match(String(result.note), /needs two of these, one for the entrance and one for the exit/);
        assert.match(String(result.note), /this placement has one/);
        assert.match(String(result.note), /Scenery alone never disqualifies/, "and what a usable tile is");
        assert.doesNotMatch(String(result.note), /clear_scenery|buy the land|try |instead/i,
            "without naming a lever or a next move, which are the caller's");
    } finally {
        restore();
    }
});

test("a shop is served from the neighbour its rotation points at", function () {
    const deltas = [{ dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 1, dy: 0 }, { dx: 0, dy: -1 }];

    for (let rotation = 0; rotation < 4; rotation++) {
        const { restore } = openPark(28);

        try {
            const result = describePlacement(0, 16, 16, rotation);
            const options = access(result);

            assert.equal(result.ride?.isShop, true);
            assert.equal(options.length, 1, "a stall has exactly one serving tile, not four");
            assert.equal(options[0].x, 16 + deltas[rotation].dx,
                "rotation " + String(rotation) + " is served from "
                + String(deltas[rotation].dx) + "," + String(deltas[rotation].dy));
            assert.equal(options[0].y, 16 + deltas[rotation].dy);
            assert.equal(options[0].door, undefined,
                "`door` is a ride-entrance idea; following it puts the shop's path one tile too far out");

            assert.match(String(result.note), /no entrance or exit/);
            assert.match(String(result.note), /0 is -x, 1 is \+y, 2 is \+x, 3 is -y/,
                "which neighbour each rotation serves from is the game's geometry and has to stay");
            assert.match(String(result.note), /an ordinary path, not a queue/,
                "that a stall takes a path rather than a queue is a rule, not a preference");
            assert.match(String(result.note), /there is no `door` beyond it/,
                "and why it is that tile itself, not one further out, stays with it");
            assert.doesNotMatch(String(result.note), /Run build_path/,
                "whether to pave that tile at all is the decision this tool hands over");
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
        const result = describePlacement(0, 52, 24, 0);
        const serving = access(result)[0];

        assert.ok(serving, "the stall beside the path has a serving tile");
        assert.deepEqual([serving.x, serving.y], [51, 24], "a rotation-0 stall is served from -x, never plus or minus y");
        assert.equal(serving.pathDistance, 0, "its serving tile is the footpath itself");
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
    // and dropping the queue half reads as widening the list rather than breaking it.
    const served = stallServedBy(false);
    let restore = served.install();

    try {
        const result = describePlacement(0, 12, 12, 0);

        assert.equal(access(result).length, 1, "an ordinary footpath beside the stall is a serving tile");
        assert.deepEqual([access(result)[0].x, access(result)[0].y], [11, 12]);
    } finally {
        restore();
    }

    const queued = stallServedBy(true);
    restore = queued.install();

    try {
        const result = describePlacement(0, 12, 12, 0);

        assert.deepEqual(result.access, [], "the same spot, served only by a queue, has no serving tile");
        assert.match(String(result.note), /this placement has none/);
    } finally {
        restore();
    }
});

// ---------------------------------------------------------------------------
// What a door costs, said where the model reads.
//
// `queueCutsOff` is correct and was never read: across three runs the model wrote
// `pathDistance` 77 times in its own reasoning and `queueCutsOff` 3, and in the run that
// laid a queue across the park's trunk it enumerated all seven access options, copying
// `door`, `pathDistance` and `needsClearing` for each and `queueCutsOff` for none. These
// pin the sentence that says the same fact in the place the reading happens.
// ---------------------------------------------------------------------------

test("a door on the trunk and a door on the end of it cost different things and say so", function () {
    const game = trunkDoorPark();
    const restore = game.install();

    try {
        const result = describePlacement(0, 13, 10, 0);
        const trunk = optionForDoor(result, 10, 9);
        const middle = optionForDoor(result, 10, 10);
        const end = optionForDoor(result, 10, 11);

        assert.ok(trunk && middle && end, "all three trunk doors are offered");

        // The control, and the whole reason a sentence exists. Every number and flag the
        // model was observed copying is identical across these three doors: same distance,
        // same existing path, same reachability, same clearing. Nothing it read could tell
        // them apart, and they cost 2, 1 and 0 tiles of the park's walking.
        [trunk, middle, end].forEach(function (option) {
            assert.equal(option.pathDistance, 0, "each door already stands on the network");
            assert.equal(option.needsClearing, false);
            assert.ok(option.door);
            assert.equal(option.door.isExistingPath, true);
            assert.equal(option.door.guestsCanReach, true);
        });

        assert.notEqual(trunk.cost, end.cost,
            "two doors with identical numbers that cost 2 tiles and 0 tiles must not read the same");

        assert.ok(trunk.cost.indexOf("2 tiles of path lose their route to the park entrance") >= 0,
            "the trunk door's price is the two tiles behind it: " + trunk.cost);
        assert.ok(middle.cost.indexOf("1 tile of path loses its route to the park entrance") >= 0,
            "and one tile is one tile, not \"1 tiles\": " + middle.cost);
        assert.ok(end.cost.indexOf("no path loses its route to the park entrance") >= 0,
            "the dead end takes nothing from anybody: " + end.cost);

        // The other two facts the sentence has to carry, and the tile it is about.
        assert.ok(trunk.cost.indexOf("nothing to lay") === 0, trunk.cost);
        assert.ok(trunk.cost.indexOf("the queue takes 10,9") >= 0, trunk.cost);
        assert.ok(end.cost.indexOf("the queue takes 10,11") >= 0, end.cost);
        assert.ok(trunk.cost.indexOf("which is path guests walk today") >= 0, trunk.cost);

        assert.equal(access(result).length, 6,
            "three doors on the trunk and three on the far side, all listed, none marked");
    } finally {
        restore();
    }
});

test("a shop's serving tile at distance 0 does not acquire a ride door's meaning", function () {
    // `pathDistance` inverts between the two. On a shop's serving tile 0 means guests can
    // already stand there, which is the best case there is. On a ride's door 0 means the
    // tile is NOT free - the door needs one - so the queue must take paving already carrying
    // traffic. Same field, opposite meaning, nothing in the number to tell them apart, and
    // the shop has no `door` and no `guestsCanReach` to read beside it either.
    const shopGame = new FakeGame(64, 40);
    shopGame.rideObjects = [{ index: 0, name: "Burger Bar", rideType: [28] }];
    shopGame.addParkEntrance(50, 23);
    shopGame.addPath(51, 24);

    for (let x = 0; x < 64; x++) {
        for (let y = 0; y < 40; y++) {
            shopGame.own(x, y, x >= 50 && x <= 54 && y >= 22 && y <= 26);
        }
    }

    const restoreShop = shopGame.install();
    let shopCostText = "";

    try {
        const serving = access(describePlacement(0, 52, 24, 0))[0];

        assert.equal(serving.pathDistance, 0, "the serving tile is the footpath itself");
        assert.equal(serving.queueCutsOff, 0);
        assert.equal(serving.door, undefined, "a shop has no door, so there is no flag beside the 0");

        shopCostText = serving.cost;
        assert.ok(serving.cost.indexOf("guests can already stand on this tile") >= 0,
            "a shop's 0 is the best case and has to read like one: " + serving.cost);
        assert.ok(serving.cost.indexOf("a shop claims no queue") >= 0, serving.cost);
        assert.ok(serving.cost.indexOf("the queue takes") < 0,
            "a stall claims nothing, so nothing about a queue belongs in its price: " + serving.cost);
        assert.ok(serving.cost.indexOf("lose their route") < 0, serving.cost);
    } finally {
        restoreShop();
    }

    const rideGame = trunkDoorPark();
    const restoreRide = rideGame.install();

    try {
        const door = optionForDoor(describePlacement(0, 13, 10, 0), 10, 9);

        assert.ok(door);
        assert.equal(door.pathDistance, 0, "the same number the shop reported");
        assert.notEqual(door.cost, shopCostText, "and the opposite thing meant by it");
        assert.ok(door.cost.indexOf("the queue takes 10,9, which is path guests walk today") >= 0,
            "a ride door's 0 means the tile is not free: " + door.cost);
        assert.ok(door.cost.indexOf("guests can already stand") < 0, door.cost);
    } finally {
        restoreRide();
    }
});

test("a door on bare ground prices the path to lay and says no route runs through it", function () {
    const game = new FakeGame(24, 24);
    game.rideObjects = [{ index: 0, name: "Merry-Go-Round", rideType: [33] }];
    game.addParkEntrance(9, 0);

    for (let y = 1; y <= 11; y++) {
        game.addPath(10, y);
    }

    // Owned land starts one tile east of the trunk, so every door lands on bare ground one
    // tile from it: distance 1, which is where "1 tile" has to read as one tile.
    for (let x = 0; x < 24; x++) {
        for (let y = 0; y < 24; y++) {
            game.own(x, y, x >= 11 && x <= 16 && y >= 9 && y <= 11);
        }
    }

    const restore = game.install();

    try {
        const door = optionForDoor(describePlacement(0, 14, 10, 0), 11, 10);

        assert.ok(door && door.door);
        assert.equal(door.pathDistance, 1);
        assert.equal(door.door.isExistingPath, false);
        assert.equal(door.door.guestsCanReach, false);

        assert.ok(door.cost.indexOf("at least 1 tile of path to lay") === 0,
            "one tile is one tile: " + door.cost);
        assert.ok(door.cost.indexOf("which is bare ground") >= 0, door.cost);
        assert.ok(door.cost.indexOf("no route runs through it to lose") >= 0,
            "bare ground carried nobody, which is a different 0 from a tile that loses nothing: " + door.cost);
        assert.ok(door.cost.indexOf("no path loses its route") < 0,
            "and it must not borrow the wording for a reachable tile that severs nothing: " + door.cost);
    } finally {
        restore();
    }
});

test("a door on a stranded fragment and a door on bare ground both cut 0 and read differently", function () {
    // Both are `queueCutsOff` 0 with `guestsCanReach` false, and they are not the same
    // thing: one is paving that goes somewhere no guest arrives, the other is ground nothing
    // has ever been laid on. The numbers cannot separate them; the sentence does.
    const game = islandOutranksNetworkPark();
    const restore = game.install();

    try {
        const stranded = optionForDoor(describePlacement(0, 13, 16, 0), 10, 15);
        const bare = optionForDoor(describePlacement(0, 15, 5, 0), 12, 5);

        assert.ok(stranded && stranded.door && bare && bare.door);
        assert.equal(stranded.queueCutsOff, 0);
        assert.equal(bare.queueCutsOff, 0);
        assert.equal(stranded.door.guestsCanReach, false);
        assert.equal(bare.door.guestsCanReach, false);
        assert.notEqual(stranded.cost, bare.cost, "same two numbers, different tiles, different sentences");

        assert.ok(stranded.cost.indexOf("at least 9 tiles of path to lay") === 0,
            "nine tiles from (10,15) to the nearest paving the park could join: " + stranded.cost);
        assert.ok(stranded.cost.indexOf("which is paving no guest reaches from the gate") >= 0,
            "a door on a fragment is on paving, and on paving that takes nobody: " + stranded.cost);
        assert.ok(bare.cost.indexOf("which is bare ground") >= 0, bare.cost);
        assert.ok(bare.cost.indexOf("at least 2 tiles of path to lay") === 0, bare.cost);
    } finally {
        restore();
    }
});

// ---------------------------------------------------------------------------
// What a distance is measured against: paving the park could actually lay path onto.
// ---------------------------------------------------------------------------

/**
 * Forest Frontiers' entrance corridor, which is where the old number broke.
 *
 * The walk from the gate runs east along y=10 from x=4 to x=20. West of x=12 it crosses
 * land the park neither owns nor can buy; from x=16 east it is the park's own trunk. Every
 * tile of it is reachable - guests arrive along it - so reachability, the filter that was
 * already here, does not exclude one tile of the corridor.
 *
 * The park also owns a patch at x 5..9, y 3..5, five rows north of the corridor with nothing
 * but unowned ground between. A ride there had its doors priced at five tiles to the
 * corridor, for a connection that cannot be laid at any price.
 */
function unbuyableCorridorPark(): FakeGame {
    const game = new FakeGame(24, 24);
    game.rideObjects = [{ index: 0, name: "Merry-Go-Round", rideType: [33] }];
    game.addParkEntrance(1, 10);

    for (let x = 4; x <= 20; x++) {
        game.addPath(x, 10);
    }

    for (let x = 0; x < 24; x++) {
        for (let y = 0; y < 24; y++) {
            const theParksOwnGround = x >= 16 && x <= 20 && y >= 6 && y <= 14;
            const theNorthernPatch = x >= 5 && x <= 9 && y >= 3 && y <= 5;
            game.own(x, y, theParksOwnGround || theNorthernPatch);
        }
    }

    return game;
}

test("paving the park could never lay a path up to is not what a distance is measured against", function () {
    const game = unbuyableCorridorPark();
    const restore = game.install();

    try {
        // The controls first. The corridor is paving, and it is paving guests reach - so the
        // reachability filter that was already here excludes none of it, and anything this
        // test shows is the ownership filter and nothing else.
        const walkable = walkableFromParkEntrance();
        assert.equal(game.tile(9, 10).elements.filter(function (e) { return e.type === "footpath"; }).length, 1,
            "(9,10) carries a footpath");
        assert.equal(tileIsWalkable(walkable, { x: 9, y: 10 }), true,
            "and a guest can walk to it, which is why reachability alone never caught this");
        assert.equal(tileIsWalkable(walkable, { x: 20, y: 10 }), true, "the park's own trunk is reachable too");

        const northern = describePlacement(0, 6, 4, 0);
        assert.equal(northern.fits, true, "the northern patch takes the ride");

        const door = optionForDoor(northern, 9, 5);
        assert.ok(door && door.door);
        assert.equal(door.door.isExistingPath, false);

        // Five tiles straight down is (9,10), the corridor. The park owns nothing touching
        // it, so no path it is allowed to lay can ever reach that tile, and it is not what
        // this door is measured against.
        assert.notEqual(door.pathDistance, 5, "the corridor is five tiles away and cannot be connected to");

        // (15,10) is the answer: corridor paving too, but the park owns (16,10) beside it, so
        // a footpath laid on its own ground joins that tile. 6 across and 5 down.
        assert.equal(door.pathDistance, 11,
            "the nearest paving the park could join is (15,10), which is 6 across and 5 down");
        assert.equal(door.pathDistance, Math.abs(15 - 9) + Math.abs(10 - 5),
            "derived from the tile, not from a number typed here");
        assert.notEqual(door.pathDistance, Math.abs(16 - 9) + Math.abs(10 - 5),
            "unowned paving the park owns a tile beside is still joinable, so (15,10) counts and (16,10) is not the answer");

        assert.ok(door.cost.indexOf("at least 11 tiles of path to lay") === 0,
            "and the sentence quotes the same number: " + door.cost);

        // The other control: this park has paving that IS joinable, so the 11 above is a real
        // measurement and not a park with nothing to measure against. A 3x3 at 18,13 puts its
        // -y doors on the park's own stretch of the corridor.
        const onTheTrunk = describePlacement(0, 18, 13, 0);
        assert.equal(optionForDoor(onTheTrunk, 18, 10)?.pathDistance, 0,
            "the park's own trunk still gives a door at distance 0");
    } finally {
        restore();
    }
});

// ---------------------------------------------------------------------------
// The description, which is read on every turn the tool is in play.
// ---------------------------------------------------------------------------

function description(): string {
    const definitions = getMcpToolDefinitions(SiteTools).filter(function (definition) {
        return definition.handlerName === "describePlacement";
    });

    assert.equal(definitions.length, 1, "describe_placement is registered once");
    assert.equal(definitions[0].name, "describe_placement", "and under that name");

    return String(definitions[0].description);
}

test("the description says it describes one placement and searches for nothing", function () {
    // The whole point of the change. A description that talked about finding sites would
    // teach the model to expect a list of candidates from a tool that answers about one
    // tile, and the first thing it would do with that expectation is ask for the list.
    const text = description();

    assert.match(text, /It describes the placement you name and nothing else: it looks for no site, ranks nothing, and offers no alternative/,
        "the shape of the tool, said once and plainly");
    assert.match(text, /Where a ride goes is read off `view_map`/,
        "and where the choice is made instead, which is the reading it replaces");
    assert.doesNotMatch(text, /\bbest\b|\bprefer\b|recommend|should pick|nearest first/i,
        "no site is marked as good: choosing one is the decision this tool gave back");
    assert.doesNotMatch(text, /sorted by|ranked by|nearest.{0,20}first|in distance order/i,
        "nothing in the result is ordered by any measurement");
});

test("the footprint geometry stands in the description that hands the rectangle over", function () {
    // `clear_scenery` explained that `x`,`y` is a build origin and not a centre; this is the
    // tool that hands the rectangle over, so it is the one that has to say not to recompute
    // it. A 4x4 runs 0..3 from its origin and a 1x4 runs -2..+1.
    const text = description();

    assert.match(text, /THE ORIGIN IS NOT THE CENTRE AND NOT A CORNER/);
    assert.match(text, /a 4x4 runs 0\.\.3 from the origin, a 1x4 runs -2\.\.\+1, and only a 3x3 is centred on it/,
        "the worked examples, which are the part a rule cannot replace");
    assert.match(text, /Never work that rectangle out from `x`, `y` and the ride's size/,
        "and the instruction that avoids the error");
    assert.match(text, /`clear_scenery`'s four arguments under the same names/,
        "where the rectangle goes next");
});

/**
 * Measured against the running game: turning two path tiles into a queue changed no edge bit
 * at all (51,24 and 51,25 of Forest Frontiers, `edges` 10 before and 10 after), so the
 * reason this description used to give for `queueCutsOff` - that guests cannot walk through
 * a queue - was false, and it painted every door beside the trunk path as a park cut in two.
 * What severs is a ride claiming the tile its door opens onto.
 *
 * The absence of the old sentence is pinned as hard as the presence of the new one. A
 * falsehood this old comes back from a stale branch or a half-remembered paragraph.
 */
test("the description says what actually severs a route, and not that a queue does", function () {
    const text = description();

    assert.match(text, /Guests walk a queue like any other path/,
        "a queue is ordinary walkable path, which is the measured fact");
    assert.match(text, /a ride claiming one, which dead-ends the single tile its door opens onto/,
        "and the one thing that does sever a route");
    assert.match(text, /READ `cost` ON EVERY OPTION/,
        "the sentence has to be pointed at, or it is another field that goes unread");
    assert.match(text, /0 on a ride's door means the tile is not free/,
        "the inversion between a shop's 0 and a ride door's 0, which no number can carry");
    assert.doesNotMatch(text, /cannot walk through/,
        "the disproven rule, which converting a path to a queue in the running game refuted");
    assert.doesNotMatch(text, /cuts that many tiles off the park/,
        "and the claim it was used to make about every positive number");
});

test("the description says a distance is to paving guests can reach", function () {
    // The sentence it used to carry - that a distance is to "the nearest footpath", -1 when
    // "the park has no footpath at all" - is the defect written down: it says paving is
    // paving, which is what made a door on a stranded fragment read as the best door in the
    // park.
    const text = description();

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

test("the description says the access list is whole and unordered, and that a ride needs two", function () {
    const text = description();

    assert.match(text, /The list is in the order the tiles ring the footprint and is ordered by nothing else: it is not sorted, not trimmed, and not marked/,
        "both halves: nothing is left out, and nothing is ranked");
    assert.match(text, /A ride needs TWO, one for the entrance and one for the exit/,
        "the mechanic the model cannot read anywhere else");
    assert.doesNotMatch(text, /accessTotal|at most \d+ options|window/,
        "there is no window any more, so a description that mentions one describes a different tool");
});

test("the rotation argument says it is required and says why there is no default", function () {
    const definitions = getMcpToolDefinitions(SiteTools).filter(function (definition) {
        return definition.handlerName === "describePlacement";
    });
    const schema = definitions[0].inputSchema;
    const properties = schema.properties as Record<string, { description: string }>;

    assert.deepEqual((schema.required || []).slice().sort(), ["rideObject", "rotation", "x", "y"],
        "every one of the four is part of naming a placement, so none of them may be filled in");

    assert.match(properties.rotation.description, /There is no default/,
        "the absence is deliberate and the model is told so");
    assert.match(properties.rotation.description, /4 is refused rather than read as 0/,
        "the bound, which is the part that stops a wasted turn");
    assert.match(properties.rotation.description, /for a shop it is the whole of it/,
        "and the one case where rotation means something other than a footprint");
});
