import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import type { FakeElement } from "./fakeGame.ts";
import { buildFlatRide } from "../src/park/build.ts";
import type { BuildOutcome } from "../src/park/build.ts";
import { tileIsWalkable, walkableFromParkEntrance } from "../src/park/paths.ts";
import { BuildTools } from "../src/tools/build.ts";
import { getMcpToolDefinitions } from "../src/tools/decorators.ts";

/**
 * Ride object 0 is a 3x3 merry-go-round (type 33); object 1 a 1x1 stall (type 28);
 * object 2 a 4x4 dodgems (25); object 3 a 1x4 swinging inverter ship (27); object 4 a
 * 1x5 swinging ship (26). Append only: the earlier tests build by index.
 */
function park(options?: { inert?: boolean }): { game: FakeGame; restore: () => void } {
    const game = new FakeGame(32, 32, options);
    game.rideObjects = [
        { index: 0, name: "Merry-Go-Round", rideType: [33] },
        { index: 1, name: "Burger Bar", rideType: [28] },
        { index: 2, name: "Dodgems", rideType: [25] },
        { index: 3, name: "Inverter Ship", rideType: [27] },
        { index: 4, name: "Pirate Ship", rideType: [26] }
    ];
    game.addParkEntrance(10, 2);

    for (let y = 3; y <= 20; y++) {
        game.addPath(10, y);
    }

    return { game: game, restore: game.install() };
}

/** Every tile of the map carrying a track element for this ride, in reading order. */
function trackTiles(game: FakeGame, ride: number): string[] {
    const tiles: string[] = [];

    for (let y = 0; y < game.height; y++) {
        for (let x = 0; x < game.width; x++) {
            const elements = game.tile(x, y).elements;

            for (let i = 0; i < elements.length; i++) {
                if (elements[i].type === "track" && elements[i].ride === ride) {
                    tiles.push(String(x) + "," + String(y));
                    break;
                }
            }
        }
    }

    return tiles;
}

/** The entrance (or exit) building standing on a tile, if one is there. */
function doorAt(game: FakeGame, x: number, y: number, isExit: boolean): FakeElement | undefined {
    return game.tile(x, y).elements.filter(function (element) {
        return element.type === "entrance" && element.object === (isExit ? 1 : 0);
    })[0];
}

/** Names of the tiles of a rectangle, in the same reading order `trackTiles` uses. */
function square(left: number, top: number, width: number, height: number): string[] {
    const tiles: string[] = [];

    for (let y = top; y < top + height; y++) {
        for (let x = left; x < left + width; x++) {
            tiles.push(String(x) + "," + String(y));
        }
    }

    return tiles;
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

/** The same call as the model makes it: raw arguments, through the MCP tool layer. */
function callTool(args: Record<string, unknown>): BuildOutcome {
    let outcome: BuildOutcome | null = null;

    new BuildTools().buildFlatRide(args).start(function (result) {
        outcome = result as BuildOutcome;
    });

    assert.ok(outcome, "build_flat_ride never answered");
    return outcome as unknown as BuildOutcome;
}

/** The detail of a named step, or a failure naming the steps that did run. */
function step(outcome: BuildOutcome, name: string): string {
    const found = outcome.steps.filter(function (s) { return s.step === name; })[0];
    assert.ok(found, "no \"" + name + "\" step in " + JSON.stringify(outcome.steps));
    return String(found.detail);
}

type ExecuteAction = (name: string, args: Record<string, unknown>, callback?: (result: Record<string, unknown>) => void) => void;

/**
 * Accept one action and never apply it, which is how a single door fails in the game:
 * the other one still goes up. `restore()` puts the whole context back, so this needs
 * no undoing of its own.
 */
function dropAction(match: (name: string, args: Record<string, unknown>) => boolean): void {
    const scope = globalThis as unknown as { context: { executeAction: ExecuteAction } };
    const real = scope.context.executeAction;

    scope.context.executeAction = function (name, args, callback) {
        if (match(name, args)) {
            return;
        }

        real(name, args, callback);
    };
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

test("a door tile that does not touch the ride is refused, and says which one and why", function () {
    // Six sessions in the logs died on "not a clear, level, owned tile touching the
    // footprint": four coordinates, four conditions, and no way to tell which pair broke.
    const { game, restore } = park();

    try {
        const outcome = build({ entrance: { x: 12, y: 14 } });
        const detail = step(outcome, "site");

        assert.equal(outcome.ok, false);
        assert.match(detail, /entranceX\/entranceY 12,14/, "the coordinate at fault is not named");
        assert.match(detail, /does not touch the ride's footprint/, "the condition it failed is not named");
        assert.match(detail, /x 13-15, y 9-11/, "the tiles it had to touch are not given");
        assert.match(detail, /exitX\/exitY 16,10 is fine/, "the door that was fine is not cleared");
        assert.ok(!/16,10 does not/.test(detail), "the exit must not be blamed as well");
        assert.match(detail, /`access` list/, "and it has to say where a good option comes from");
        assert.ok(!/find_build_sites for this ride again/.test(detail),
            "the list in hand is still good here, so it must not send the model back to re-measure");
        assert.equal(game.rides.length, 0, "nothing is created when the site is rejected");
    } finally {
        restore();
    }
});

test("each ground condition a door tile fails is named as itself", function () {
    const cases = [
        {
            name: "unowned land",
            arrange: function (game: FakeGame) { game.own(12, 10, false); },
            expect: /is not land the park owns/
        },
        {
            name: "a slope",
            arrange: function (game: FakeGame) { game.tile(12, 10).elements[0].slope = 2; },
            expect: /is on a slope/
        },
        {
            name: "a different height",
            arrange: function (game: FakeGame) { game.tile(12, 10).elements[0].baseZ = 112; },
            expect: /is not level with the ride: its ground is at height 112 and the footprint is at height 96/
        }
    ];

    cases.forEach(function (probe) {
        const { game, restore } = park();
        probe.arrange(game);

        try {
            const detail = step(build({}), "site");

            assert.match(detail, /entranceX\/entranceY 12,10/, probe.name + ": the tile is not named");
            assert.match(detail, probe.expect, probe.name + ": got " + detail);
            assert.equal(game.rides.length, 0, probe.name + ": something was built anyway");
        } finally {
            restore();
        }
    });
});

test("a door tile with a structure on it says the site data is stale, not to pick another option", function () {
    // The three worst recoveries in the logs: the coordinates HAD come from a fresh
    // `access` list, and a build that failed moments earlier had left track on one of the
    // tiles. Telling the model to use the list again told it to do what it had just done.
    const { game, restore } = park();
    game.tile(12, 10).elements.push({ type: "track", baseZ: 96, ride: 9 });

    try {
        const detail = step(build({}), "site");

        assert.match(detail, /entranceX\/entranceY 12,10/, "the stale tile is not named");
        assert.match(detail, /is not clear: track is standing on it/, "what is on the tile is not named");
        assert.match(detail, /out of date/, "it does not say the site data has gone stale");
        assert.match(detail, /find_build_sites for this ride again/, "it does not name the call that fixes it");
        assert.match(detail, /Do not re-send these coordinates/,
            "re-guessing coordinates is exactly what the model did six times out of six");
        assert.equal(game.rides.length, 0, "nothing is created when the site is rejected");
    } finally {
        restore();
    }
});

test("a door with nowhere to queue is refused, not built into an unusable ride", function () {
    // Touching the footprint is necessary and not sufficient: find_build_sites checks the
    // tile the door opens onto too. Skipping that check accepted a door nothing could ever
    // queue to and then reported the build a success.
    const cases = [
        {
            name: "unowned",
            arrange: function (game: FakeGame) { game.own(11, 10, false); },
            expect: /is not land the park owns, so no queue could ever reach this door/,
            stale: false
        },
        {
            name: "built on",
            arrange: function (game: FakeGame) {
                game.tile(11, 10).elements.push({ type: "track", baseZ: 96, ride: 9 });
            },
            expect: /is blocked by track, so no queue could ever reach this door/,
            stale: true
        },
        {
            name: "another ride's queue",
            arrange: function (game: FakeGame) {
                // A queue bound to ride 6: a door here would re-chain it and strand that ride.
                // The entrance goes on second, because placing one is what chains the queue.
                game.addPath(11, 10, true);
                game.addRideEntrance(11, 11, 6, 1);
            },
            expect: /is already the queue for ride 6/,
            stale: true
        }
    ];

    cases.forEach(function (probe) {
        const { game, restore } = park();
        probe.arrange(game);

        try {
            const outcome = build({});
            const detail = step(outcome, "site");

            assert.equal(outcome.ok, false, probe.name + ": the ride went up anyway");
            assert.match(detail, /entranceX\/entranceY 12,10 touches the footprint, but/,
                probe.name + ": it does not say the tile itself was fine");
            assert.match(detail, /11,10/, probe.name + ": the door tile is not named");
            assert.match(detail, probe.expect, probe.name + ": got " + detail);
            assert.equal(/find_build_sites for this ride again/.test(detail), probe.stale,
                probe.name + ": wrong remedy for this kind of failure");
            assert.equal(game.rides.length, 0, probe.name + ": a ride was created for a door that cannot work");
        } finally {
            restore();
        }
    });
});

test("a queue already lying at the door is still a legal place to build", function () {
    // The other direction: an unbound queue on the door tile is the normal
    // lay-the-queue-first order, and the entrance chains it. Refusing it would make
    // build_flat_ride stricter than the game.
    const { game, restore } = park();
    game.addPath(11, 10, true);

    try {
        const outcome = build({});

        assert.equal(outcome.ok, true, JSON.stringify(outcome.steps));
        assert.equal(game.tile(11, 10).elements.filter(function (e) {
            return e.type === "footpath";
        })[0].ride, outcome.rideId, "the queue on the map did not bind to the new ride");
    } finally {
        restore();
    }
});

test("one tile for both doors is refused, naming both arguments and the fix", function () {
    // A 1x4 ride has sides with a single perimeter tile, so this is easy to ask for.
    const { game, restore } = park();

    try {
        const outcome = build({ entrance: { x: 12, y: 10 }, exit: { x: 12, y: 10 } });
        const detail = step(outcome, "site");

        assert.equal(outcome.ok, false);
        assert.match(detail, /entranceX\/entranceY and exitX\/exitY are the same tile, 12,10/,
            "the model spent three turns changing the wrong variable for want of this");
        assert.match(detail, /Change exitX\/exitY/, "it does not say which of the two to move");
        assert.match(detail, /`side`/, "it does not say how to find a door on another face");
        assert.equal(game.rides.length, 0, "nothing is created when the site is rejected");
    } finally {
        restore();
    }
});

test("a ride that is not a shop names the four arguments it is missing", function () {
    const { game, restore } = park();

    try {
        const detail = step(build({ entrance: undefined, exit: undefined }), "site");

        assert.match(detail, /entranceX/);
        assert.match(detail, /entranceY/);
        assert.match(detail, /exitX/);
        assert.match(detail, /exitY/);
        assert.match(detail, /Merry-Go-Round is not a shop/, "the ride that needs them is not named");
        assert.equal(game.rides.length, 0);
    } finally {
        restore();
    }
});

test("half a door pair is refused by name rather than silently dropped", function () {
    // entranceX with no entranceY used to drop the whole entrance and fail further down
    // with a message that named neither argument.
    const { game, restore } = park();

    try {
        const outcome = callTool({
            rideObject: 0, x: 14, y: 10, rotation: 0, price: 10, open: false,
            entranceX: 12, exitX: 16, exitY: 10
        });

        assert.equal(outcome.ok, false);
        assert.match(step(outcome, "arguments"), /entranceY is missing/, "the argument at fault is not named");
        assert.match(step(outcome, "arguments"), /entranceX, exitX, exitY were given/);
        assert.equal(game.attempted.length, 0, "not one action reached the game");
        assert.equal(game.rides.length, 0);
    } finally {
        restore();
    }
});

test("rideObject is the object's own index, not its place in the list", function () {
    // `listRideObjects` reports `.index`; building by array position agrees with it only
    // while the loaded list has no gaps, and silently builds the wrong ride when it does.
    const { game, restore } = park();
    game.rideObjects = [
        { index: 4, name: "Merry-Go-Round", rideType: [33] },
        { index: 9, name: "Burger Bar", rideType: [28] }
    ];

    try {
        const outcome = build({ rideObject: 4 });

        assert.equal(outcome.ok, true, JSON.stringify(outcome.steps));
        assert.deepEqual(trackTiles(game, outcome.rideId as number), square(13, 9, 3, 3),
            "index 4 did not build the object whose `index` is 4");

        const missing = build({ rideObject: 0 });
        assert.equal(missing.ok, false, "there is no object with index 0 in this park");
        assert.match(String(missing.steps[0].detail), /No ride object has index 0/);
        assert.match(String(missing.steps[0].detail), /list_ride_objects/,
            "the call that gives a real index is not named");
        assert.equal(game.rides.length, 1, "and the refused call built nothing");
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

test("a shop needs no entrance or exit, and wants a path on the side it faces", function () {
    const { game, restore } = park();

    try {
        // Rotation 0 faces -x, so a stall at 11,10 is served from 10,10 - the main path.
        const outcome = build({ rideObject: 1, x: 11, y: 10, rotation: 0, entrance: undefined, exit: undefined });

        assert.equal(outcome.ok, true, JSON.stringify(outcome.steps));
        assert.equal(outcome.reachable, true, "a stall facing the main path is reachable");
        assert.match(step(outcome, "access"), /Guests buy from 10,10/, "the counter tile is not named");
        assert.equal(game.rides[0].stations[0].entrance, null, "and never got an entrance building");
    } finally {
        restore();
    }
});

test("a stall with a path against its back wall is not reachable, and is told which tile is", function () {
    // The loose rule - any of the four neighbours - called this one reachable. The game
    // serves a stall from the tile it faces and nowhere else, so that was a false success.
    const { game, restore } = park();

    try {
        // Rotation 2 faces +x, so a stall at 11,10 is served from 12,10, not from the
        // main path at 10,10 behind it.
        const outcome = build({ rideObject: 1, x: 11, y: 10, rotation: 2, entrance: undefined, exit: undefined });
        const detail = step(outcome, "access");

        assert.equal(outcome.ok, true, "the stall was built");
        assert.equal(outcome.reachable, false, "but the only path touches its back wall");
        assert.match(detail, /NO PATH guests can reach at 12,10/, "the serving tile is not named");
        assert.match(detail, /only from the neighbour on the side it faces/, "the rule itself is not stated");
        assert.match(detail, /other three sides touches a wall and serves nobody/,
            "the other half of the rule - why the three remaining neighbours are useless - is not stated");
        assert.match(detail, /The tiles guests can walk to are park_status `paths\.reachableSample`/,
            "where the reachable tiles are listed is a fact and has to stay");
        assert.doesNotMatch(detail, /Run build_path to 12,10/,
            "which tile to pave, and whether to pave one at all, is the model's call");

        // The world agrees: there is path beside the stall, and it is the wrong tile.
        assert.ok(game.tile(10, 10).elements.some(function (e) { return e.type === "footpath"; }));
        assert.ok(!game.tile(12, 10).elements.some(function (e) { return e.type === "footpath"; }));
    } finally {
        restore();
    }
});

test("door arguments handed to a stall are called out, not silently dropped", function () {
    // Sent to a burger bar five times in one session, because nothing ever said otherwise.
    const { game, restore } = park();

    try {
        const outcome = build({
            rideObject: 1, x: 11, y: 10, rotation: 0,
            entrance: { x: 10, y: 10 }, exit: { x: 12, y: 10 }
        });
        const detail = step(outcome, "entrance/exit");

        assert.equal(outcome.ok, true, "the stall still goes up");
        assert.match(detail, /entranceX\/entranceY and exitX\/exitY were ignored/);
        assert.match(detail, /Burger Bar has nowhere to put them/);
        assert.match(detail, /buy over the counter from 10,10/, "the tile that does matter is not named");
        assert.match(detail, /no `access` list for a stall/);

        let doors = 0;

        for (let y = 0; y < game.height; y++) {
            for (let x = 0; x < game.width; x++) {
                doors += game.tile(x, y).elements.filter(function (e) {
                    // A ride door is `object` 0 or 1; the park gate is 2 and belongs to no ride.
                    return e.type === "entrance" && e.object !== 2;
                }).length;
            }
        }

        assert.equal(doors, 0, "a door was built for a stall that cannot use one");
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
        assert.match(String(access.detail), /NO QUEUE at the entrance - guests cannot board/,
            "the fact stays: a queue bound to the ride is what lets a guest board");
        assert.match(String(access.detail), /the exit is not connected/,
            "and so does the other half, which is a separate way to strand guests");
        assert.doesNotMatch(String(access.detail), /Use build_path to connect them/,
            "`reachable` is false by design until the queue goes down, so this steer fired on nearly"
            + " every ride the model ever built; the facts above are what it needs, not the order");
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

test("a price the ride did not take names no cause the tool never checked", function () {
    // The same guess operate_ride carried: an unconditional "the scenario may fix ride
    // prices" on a price that did not land. No flag was read, and `RideSetPriceAction`
    // reads none either, so there was nothing to read.
    const { game, restore } = park();
    game.refuse.ridesetprice = true;

    try {
        const outcome = build({ price: 25 });
        const price = outcome.steps.filter(function (s) { return s.step === "price"; })[0];

        assert.equal(price.ok, false);
        assert.match(String(price.detail), /asked for 25 but the ride is charging 0\.$/,
            "the step ends at what was asked for and what the ride charges");
        assert.doesNotMatch(String(price.detail), /scenario/, "no cause is named that was never checked");
    } finally {
        restore();
    }
});

/**
 * The tiles each footprint should end up on, written out rather than derived, so the
 * test disagrees with the code when the code is wrong. Taken from OpenRCT2's own track
 * element data: a 3x3 and a 1x5 are centred on their origin, a 1x4 runs -2..+1 along x,
 * and a 4x4 runs 0..+3 on both axes from its origin.
 */
test("the track lands on the tiles the piece really covers, shape by shape", function () {
    const shapes = [
        { name: "3x3 merry-go-round", rideObject: 0, entrance: { x: 12, y: 10 }, exit: { x: 16, y: 10 }, tiles: square(13, 9, 3, 3) },
        { name: "1x4 inverter ship", rideObject: 3, entrance: { x: 13, y: 9 }, exit: { x: 13, y: 11 }, tiles: square(12, 10, 4, 1) },
        { name: "4x4 dodgems", rideObject: 2, entrance: { x: 13, y: 10 }, exit: { x: 13, y: 11 }, tiles: square(14, 10, 4, 4) },
        { name: "1x5 pirate ship", rideObject: 4, entrance: { x: 13, y: 9 }, exit: { x: 13, y: 11 }, tiles: square(12, 10, 5, 1) },
        { name: "1x1 burger bar", rideObject: 1, entrance: undefined, exit: undefined, tiles: ["14,10"] }
    ];

    shapes.forEach(function (shape) {
        const { game, restore } = park();

        try {
            const outcome = build({
                rideObject: shape.rideObject, x: 14, y: 10, entrance: shape.entrance, exit: shape.exit
            });

            assert.equal(outcome.ok, true, shape.name + ": " + JSON.stringify(outcome.steps));
            assert.equal(typeof outcome.rideId, "number");

            assert.deepEqual(trackTiles(game, outcome.rideId as number), shape.tiles,
                shape.name + " did not put its track on the tiles the game lays that piece on");
        } finally {
            restore();
        }
    });
});

test("the entrance and the exit really stand on the tiles the outcome names", function () {
    const { game, restore } = park();

    try {
        const outcome = build({ entrance: { x: 12, y: 10 }, exit: { x: 16, y: 10 } });
        const rideId = outcome.rideId as number;

        assert.equal(outcome.ok, true, JSON.stringify(outcome.steps));

        const entrance = doorAt(game, 12, 10, false);
        const exit = doorAt(game, 16, 10, true);

        assert.ok(entrance, "no entrance building stands on 12,10");
        assert.ok(exit, "no exit building stands on 16,10");
        assert.equal(entrance.ride, rideId, "the entrance belongs to some other ride");
        assert.equal(exit.ride, rideId, "the exit belongs to some other ride");

        // Both doors face the ride, which is what decides where their queue and apron go.
        assert.equal(entrance.direction, 2, "the entrance at 12,10 faces east, towards the ride at 13,10");
        assert.equal(exit.direction, 0, "the exit at 16,10 faces west, towards the ride at 15,10");

        const station = game.rides[0].stations[0];
        assert.deepEqual(station.entrance, { x: 384, y: 320, z: 96, direction: 2 }, "the station's entrance is 12,10 in world units");
        assert.deepEqual(station.exit, { x: 512, y: 320, z: 96, direction: 0 }, "the station's exit is 16,10 in world units");
    } finally {
        restore();
    }
});

test("a shop leaves no entrance or exit building anywhere on the map", function () {
    const { game, restore } = park();

    try {
        const outcome = build({ rideObject: 1, x: 11, y: 10, entrance: undefined, exit: undefined });
        assert.equal(outcome.ok, true, JSON.stringify(outcome.steps));

        let doors = 0;

        for (let y = 0; y < game.height; y++) {
            for (let x = 0; x < game.width; x++) {
                const elements = game.tile(x, y).elements;

                for (let i = 0; i < elements.length; i++) {
                    // A ride door is `object` 0 or 1; the park gate is 2 and belongs to no ride.
                    if (elements[i].type === "entrance" && elements[i].object !== 2) {
                        doors++;
                    }
                }
            }
        }

        assert.equal(doors, 0, "a shop was given a ride entrance it has no way to use");
    } finally {
        restore();
    }
});

test("the price and the status on the ride are the ones that were asked for", function () {
    const { game, restore } = park();

    try {
        const opened = build({ price: 35, open: true });
        assert.equal(opened.ok, true, JSON.stringify(opened.steps));
        assert.equal(game.rides[0].price[0], 35, "the ride in the park is not charging what was asked");
        assert.equal(game.rides[0].status, "open", "the ride in the park is not open");

        const shut = build({ x: 20, y: 10, entrance: { x: 18, y: 10 }, exit: { x: 22, y: 10 }, price: 0, open: false });
        assert.equal(shut.ok, true, JSON.stringify(shut.steps));
        assert.equal(game.rides[1].status, "closed", "a ride nobody asked to open must stay shut");
        assert.equal(shut.steps.filter(function (s) { return s.step === "open"; })[0].detail, "closed");
    } finally {
        restore();
    }
});

test("the id in the outcome is the ride the new track belongs to", function () {
    const { game, restore } = park();

    try {
        const first = build({ x: 14, y: 10, entrance: { x: 12, y: 10 }, exit: { x: 16, y: 10 } });
        const second = build({ x: 14, y: 16, entrance: { x: 12, y: 16 }, exit: { x: 16, y: 16 } });

        assert.deepEqual(trackTiles(game, first.rideId as number), square(13, 9, 3, 3),
            "the first outcome's id names a ride whose track is somewhere else");
        assert.deepEqual(trackTiles(game, second.rideId as number), square(13, 15, 3, 3),
            "the second outcome's id names a ride whose track is somewhere else");
        assert.equal(doorAt(game, 12, 16, false)?.ride, second.rideId, "the second ride's entrance is bound to the first");
    } finally {
        restore();
    }
});

test("a queue already at the door binds to the new ride and makes it reachable", function () {
    // The direction never covered before: every earlier test could only watch this fail.
    const { game, restore } = park();

    // The entrance at 12,10 faces the ride, so its queue belongs on 11,10 behind it.
    game.addPath(11, 10, true);

    // And a way back out for the exit at 16,10, whose door is 17,10.
    for (let x = 10; x <= 17; x++) {
        game.addPath(x, 14);
    }
    for (let y = 10; y <= 14; y++) {
        game.addPath(17, y);
    }

    try {
        const outcome = build({ entrance: { x: 12, y: 10 }, exit: { x: 16, y: 10 } });
        const rideId = outcome.rideId as number;

        assert.equal(outcome.ok, true, JSON.stringify(outcome.steps));
        assert.equal(outcome.reachable, true, "queue in, path out: guests can ride it");

        const queue = game.tile(11, 10).elements.filter(function (e) { return e.type === "footpath"; })[0];
        assert.ok(queue);
        assert.equal(queue.isQueue, true);
        assert.equal(queue.ride, rideId, "the queue on the map is not bound to the ride it serves");

        const access = outcome.steps.filter(function (s) { return s.step === "access"; })[0];
        assert.match(String(access.detail), /A queue serves the entrance/);
    } finally {
        restore();
    }
});

test("a door that does not attach names that door, and says the ride is standing", function () {
    // The duplicate-burger-bar bug, seen in the live park: this path returned ok:false
    // with the ride built and standing, and the model built a second one.
    const { game, restore } = park();
    dropAction(function (name, args) { return name === "rideentranceexitplace" && args.isExit === true; });

    try {
        const outcome = build({});
        const rideId = outcome.rideId as number;
        const detail = step(outcome, "entrance/exit");

        assert.equal(outcome.ok, true, "the ride exists, so ok is true: " + JSON.stringify(outcome.steps));
        assert.equal(outcome.doorsAttached, false, "but its doors are not both on");
        assert.match(detail, /The exit at 16,10 did not attach/, "the door that failed is not named");
        assert.match(detail, /The entrance did attach/, "the door that worked is not named either");
        assert.match(detail, /EXISTS/, "it does not say the ride is standing");
        assert.match(detail, /operate_ride \{ride: 0, demolish: true\}/, "it does not name the way to undo it");
        assert.match(detail, /rideentranceexitplace/, "nor the way to finish it");

        // The claim is about the world, so read the world.
        assert.equal(game.rides.length, 1, "the ride really is still in the park");
        assert.deepEqual(trackTiles(game, rideId), square(13, 9, 3, 3), "with its track on the ground");
        assert.ok(doorAt(game, 12, 10, false), "the entrance building really did go up");
        assert.equal(doorAt(game, 16, 10, true), undefined, "and the exit building really did not");
    } finally {
        restore();
    }
});

test("when the game refuses a door, its own reason is quoted back", function () {
    const { game, restore } = park();
    game.refuse.rideentranceexitplace = true;

    try {
        const outcome = build({});
        const detail = step(outcome, "entrance/exit");

        assert.equal(outcome.ok, true, "the ride is built even when neither door goes on");
        assert.equal(outcome.doorsAttached, false);
        assert.match(detail, /The entrance at 12,10 did not attach: Refused: test refusal/);
        assert.match(detail, /The exit at 16,10 did not attach: Refused: test refusal/);
        assert.equal(game.rides.length, 1, "and the ride it could not finish is still standing");
    } finally {
        restore();
    }
});

test("a ride that will not open is built, not lost", function () {
    const { game, restore } = park();
    game.refuse.ridesetstatus = true;

    try {
        const outcome = build({ open: true });
        const detail = step(outcome, "open");

        assert.equal(outcome.ok, true, "ok means the ride exists, and it does");
        assert.equal(outcome.open, false, "opening is reported on its own");
        assert.equal(outcome.doorsAttached, true, "its doors went on regardless");
        assert.match(detail, /Ride 0 was built but is still closed: Refused: test refusal/);
        assert.match(detail, /do not build it again/i);
        assert.match(detail, /operate_ride \{ride: 0, open: true\}/, "the call that opens it later is not named");

        assert.equal(game.rides.length, 1, "one ride, not two");
        assert.equal(game.rides[0].status, "closed", "and it really is shut");
    } finally {
        restore();
    }
});

test("a finished ride reports doors and opening separately from ok", function () {
    const { game, restore } = park();

    try {
        const built = build({ open: true });

        assert.equal(built.ok, true);
        assert.equal(built.doorsAttached, true);
        assert.equal(built.open, true);
        assert.equal(game.rides[0].status, "open");

        const shop = build({ rideObject: 1, x: 11, y: 10, entrance: undefined, exit: undefined, open: false });

        assert.equal(shop.ok, true);
        assert.equal(shop.doorsAttached, null, "a shop has no doors to report on");
        assert.equal(shop.open, false, "nobody asked for it to be open");
    } finally {
        restore();
    }
});

test("a ride left behind by a failed cleanup names the call that removes it", function () {
    const { game, restore } = park();
    game.refuse.trackplace = true;
    game.refuse.ridedemolish = true;

    try {
        const outcome = build({});

        assert.equal(outcome.ok, false, "nothing is standing on the ground, so this built nothing");
        assert.equal(outcome.rideId, 0, "but the id it is squatting on is still reported");
        assert.match(step(outcome, "cleanup"), /operate_ride \{ride: 0, demolish: true\}/);
        assert.equal(game.rides.length, 1, "the orphan really is still there");
        assert.equal(trackTiles(game, 0).length, 0, "with nothing on the ground");
    } finally {
        restore();
    }
});

test("the arguments with a legal range declare it, so the MCP layer refuses instead of the game", function () {
    // The bounds are enforced centrally, before the tool runs, and the message the model
    // sees comes from the schema. A field with no bound falls through to "Value out of
    // range" from the game, which names no field: `inspectionInterval: 30` cost a whole run.
    const schema = getMcpToolDefinitions(BuildTools)[0].inputSchema;
    const properties = (schema.properties || {}) as Record<string, { minimum?: number; maximum?: number; enum?: unknown[] }>;

    assert.deepEqual(properties.inspectionInterval.enum, [0, 1, 2, 3, 4, 5, 6],
        "inspectionInterval is seven settings, not a number of minutes");
    assert.equal(properties.rotation.maximum, 3, "rotation is no longer wrapped, so it has to be bounded");
    assert.equal(properties.price.maximum, 2000, "and must match the bound operate_ride uses");
    assert.equal(properties.colour1.maximum, 30);
    assert.equal(properties.colour2.maximum, 30);

    ["rideObject", "x", "y", "entranceX", "entranceY", "exitX", "exitY", "entranceObject"].forEach(function (name) {
        assert.equal(properties[name].minimum, 0, name + " may not be negative");
    });
});

test("a ride whose track will not fit on the map builds nothing at all", function () {
    const { game, restore } = park();

    try {
        // A 1x5 centred one tile from the edge runs off it. Half a ride is worse than none.
        const outcome = build({ rideObject: 4, x: 1, y: 10, entrance: { x: 1, y: 9 }, exit: { x: 1, y: 11 } });

        assert.equal(outcome.ok, false);
        assert.equal(trackTiles(game, 0).length, 0, "part of the piece was laid before the rest was refused");
        assert.equal(game.rides.length, 0, "and the ride it could not build was cleaned up");
    } finally {
        restore();
    }
});

test("a turned ride is laid on the tiles the tool checked its doors against", function () {
    // The invariant the whole tool rests on: the tiles `footprintOffsets` reports are the
    // tiles the game puts track on. When they differ, every door is measured against a
    // ride that is not there, and the build still reports success.
    //
    // All four quarter-turns, now that segmentOffsets turns a piece the way
    // TrackPlaceAction does: (dx, dy) -> (dy, -dx). The two disagreed at rotation 1 and 3,
    // which put a 1x4 one tile further on than the tool believed and measured its doors
    // against a ride that was not there.
    const laidOut: Record<number, string[]> = {
        0: square(12, 10, 4, 1),
        1: square(14, 9, 1, 4),
        2: square(13, 10, 4, 1),
        3: square(14, 8, 1, 4)
    };

    [0, 1, 2, 3].forEach(function (rotation) {
        const { game, restore } = park();

        try {
            const outcome = build({
                rideObject: 3, x: 14, y: 10, rotation: rotation,
                entrance: { x: 13, y: 9 }, exit: { x: 13, y: 11 }
            });

            assert.equal(outcome.ok, true, "rotation " + String(rotation) + ": " + JSON.stringify(outcome.steps));
            assert.deepEqual(trackTiles(game, outcome.rideId as number), laidOut[rotation],
                "a 1x4 at rotation " + String(rotation) + " was not laid where the game lays it");
        } finally {
            restore();
        }
    });
});

test("an ordinary path at the door, with no queue on it, is still not reachable", function () {
    // The other no-queue test puts the ride where nothing reaches it, so it passes whether
    // or not `reachable` asks for a queue at all. Here the door tile carries ordinary
    // footpath joined to the park and the exit is connected too: the queue is the only
    // thing missing, and it is what decides whether a guest ever boards.
    const { game, restore } = park();

    // The entrance at 12,10 faces the ride, so its door opens onto 11,10 - which touches
    // the main path at 10,10, so guests can walk right up to the building.
    game.addPath(11, 10);

    // And a way back out for the exit at 16,10, whose door is 17,10.
    for (let x = 10; x <= 17; x++) {
        game.addPath(x, 14);
    }
    for (let y = 10; y <= 14; y++) {
        game.addPath(17, y);
    }

    try {
        const outcome = build({ entrance: { x: 12, y: 10 }, exit: { x: 16, y: 10 } });
        const door = game.tile(11, 10).elements.filter(function (e) { return e.type === "footpath"; })[0];
        const walkable = walkableFromParkEntrance();

        assert.ok(door, "the door tile lost its path");
        assert.notEqual(door.isQueue, true, "the door tile has to carry ordinary path, not a queue");
        assert.equal(tileIsWalkable(walkable, { x: 11, y: 10 }), true, "guests can walk to the door");
        assert.equal(tileIsWalkable(walkable, { x: 17, y: 10 }), true, "and away from the exit");

        assert.equal(outcome.ok, true, JSON.stringify(outcome.steps));
        assert.equal(outcome.reachable, false,
            "guests crowd a door with no queue and never board, however walkable the tile in front of it is");
        assert.match(step(outcome, "access"), /NO QUEUE/, "and the access step has to name the half that is missing");
    } finally {
        restore();
    }
});

test("a stall is judged by its counter, not by a tile next to its counter", function () {
    const { game, restore } = park();

    // Rotation 2 faces +x, so a stall at 11,10 is served from 12,10 and nowhere else. The
    // path stops one tile short of it, at 13,10 - a neighbour OF THE COUNTER, which is not
    // the counter. It joins the park the long way round so 12,10 itself stays bare.
    for (let x = 11; x <= 13; x++) {
        game.addPath(x, 13);
    }
    for (let y = 10; y <= 12; y++) {
        game.addPath(13, y);
    }

    try {
        const outcome = build({ rideObject: 1, x: 11, y: 10, rotation: 2, entrance: undefined, exit: undefined });
        const walkable = walkableFromParkEntrance();

        assert.equal(tileIsWalkable(walkable, { x: 13, y: 10 }), true, "the tile beside the counter is reachable");
        assert.ok(!game.tile(12, 10).elements.some(function (e) { return e.type === "footpath"; }),
            "and the counter tile itself carries no path at all");

        assert.equal(outcome.ok, true, "the stall was built");
        assert.equal(outcome.reachable, false, "but a path beside the counter serves nobody");
        assert.match(step(outcome, "access"), /NO PATH guests can reach at 12,10/, "the counter tile is not named");
    } finally {
        restore();
    }
});

test("called directly, past the MCP layer, rotation 7 is passed on rather than wrapped to 3", function () {
    // The schema bounds rotation 0-3, so this cannot arrive over MCP. The `% 4` it stands
    // in for was real: 7 silently became 3, the ride went up facing a way nobody asked
    // for, and nothing said so. The game refuses a direction it does not know, so handing
    // 7 on fails loudly - which is the outcome a model can act on.
    const { game, restore } = park();
    const directions: unknown[] = [];

    // The game's own refusal, as the fake has no notion of an illegal direction.
    dropAction(function (name, args) {
        if (name !== "trackplace") {
            return false;
        }

        directions.push(args.direction);
        return (args.direction as number) > 3;
    });

    try {
        const outcome = callTool({
            rideObject: 0, x: 14, y: 10, rotation: 7, price: 10, open: true,
            entranceX: 12, entranceY: 10, exitX: 16, exitY: 10
        });

        assert.deepEqual(directions, [7], "7 has to reach the game as 7, not quietly become 3");
        assert.equal(outcome.ok, false, "a rotation the game will not take must not report a ride");
        assert.equal(game.rides.length, 0, "and must leave nothing standing in the park");
        assert.equal(trackTiles(game, 0).length, 0, "nor any track on the ground");
    } finally {
        restore();
    }
});

/**
 * Pause the game the moment a named action is fired, which is how a pause reaches a build
 * that is already under way: `set_game_speed` is a separate call, and the model issues
 * calls in parallel. The action still reaches the game and is refused there by the gate,
 * exactly as it would be in OpenRCT2.
 */
function pauseWhen(game: FakeGame, actionName: string): void {
    const scope = globalThis as unknown as { context: { executeAction: ExecuteAction } };
    const real = scope.context.executeAction;

    scope.context.executeAction = function (name, args, callback) {
        if (name === actionName) {
            game.gameValues.paused = true;
        }

        real(name, args, callback);
    };
}

test("a paused game is refused before a ride is created, so nothing is stranded", function () {
    // The trap this closes: `ridecreate` carries Flags::AllowWhilePaused and `trackplace`,
    // `rideentranceexitplace` and `ridedemolish` do not, so a build begun while paused used
    // to buy a ride, fail to lay a single tile of track, and then fail to remove it - and
    // the remedy it named, operate_ride demolish, fires the same refused ridedemolish.
    const { game, restore } = park();
    game.gameValues.paused = true;

    try {
        const outcome = build({});

        assert.equal(outcome.ok, false, "a paused build cannot finish, so it must not report one");
        assert.equal(outcome.rideId, null, "and must not hand back an id for a ride nobody owns");
        assert.deepEqual(game.attempted.map(function (a) { return a.name; }), [],
            "not one game action may be fired: ridecreate is the one that goes through and strands the ride");
        assert.equal(game.rides.length, 0, "no ride was created");
        assert.equal(trackTiles(game, 0).length, 0, "and nothing is on the ground");
        assert.equal(game.gameValues.paused, true, "and the clock is left exactly where the model put it");
    } finally {
        restore();
    }
});

test("the paused refusal names the pause, and names a call the pause does not refuse", function () {
    const { game, restore } = park();
    game.gameValues.paused = true;

    try {
        const detail = step(build({}), "paused");

        assert.match(detail, /game is paused/, "it does not say the game is paused");
        assert.match(detail, /trackplace/, "nor which action the pause refuses");
        assert.match(detail, /set_game_speed \{paused: false\}/, "nor the call that starts the clock again");
        assert.match(detail, /Nothing was created/, "nor that this call left nothing behind");
        // A remedy that cannot work is worse than none, so the message must not offer
        // operate_ride demolish as something to do now - it fires the refused ridedemolish.
        assert.match(detail, /operate_ride demolish cannot take out/,
            "it offers operate_ride demolish without saying the pause refuses that too");
    } finally {
        restore();
    }
});

test("the way out the paused refusal names goes through while paused, and demolish does not", function () {
    // The message's claim, executed. Pinning only the wording lets the wording drift away
    // from the gate; this fires the two actions at the paused game and reads back what
    // happened, which is the same thing OpenRCT2's CheckActionInPausedMode does.
    const { game, restore } = park();

    try {
        // ridecreate carries the flag, so a ride can exist in a paused park - which is
        // precisely how one used to get stranded.
        game.gameValues.paused = true;
        let createError: unknown;
        context.executeAction("ridecreate", {
            rideType: 33, rideObject: 0, entranceObject: 0, colour1: 0, colour2: 0, inspectionInterval: 2
        }, function (result) { createError = result.errorMessage; });
        game.applyQueuedActions();

        assert.equal(createError, undefined, "ridecreate is not refused while paused");
        assert.equal(game.rides.length, 1, "so a paused game really can end up holding a ride");

        let demolishError: unknown;
        context.executeAction("ridedemolish", { ride: 0, modifyType: 0 }, function (result) {
            demolishError = result.errorMessage;
        });
        game.applyQueuedActions();

        assert.equal(demolishError, "Construction not possible while game is paused!",
            "ridedemolish - which is what operate_ride demolish fires - must be refused while paused");
        assert.equal(game.rides.length, 1, "and the ride must still be there");

        // The call the refusal names, fired at the same paused game.
        context.executeAction("pausetoggle", {}, function () { /* read back below */ });
        game.applyQueuedActions();

        assert.equal(context.paused, false, "set_game_speed's action must go through while paused");

        context.executeAction("ridedemolish", { ride: 0, modifyType: 0 }, function () { /* read back below */ });
        game.applyQueuedActions();

        assert.equal(game.rides.length, 0, "and the ride comes out once the clock is running");
    } finally {
        restore();
    }
});

test("a pause landing mid-build strands the ride, and the cleanup says the remedy is refused too", function () {
    // The race the up-front refusal cannot cover: set_game_speed is its own call, and the
    // model issues calls in parallel, so a pause can arrive between ridecreate and
    // trackplace. The ride is then stranded for real and the message has to be accurate.
    const { game, restore } = park();
    pauseWhen(game, "trackplace");

    try {
        const outcome = build({});
        const detail = step(outcome, "cleanup");

        assert.equal(outcome.ok, false, "nothing reached the ground");
        assert.equal(outcome.rideId, 0, "but the id the orphan is squatting on is reported");
        assert.equal(game.rides.length, 1, "the orphan really is in the park");
        assert.equal(trackTiles(game, 0).length, 0, "with nothing on the ground");

        assert.match(detail, /Construction not possible while game is paused!/,
            "the game's own reason for refusing the cleanup is not reported");
        assert.match(detail, /ridedemolish is one of the actions a paused game refuses/,
            "it does not say why the cleanup failed");
        assert.match(detail, /operate_ride \{ride: 0, demolish: true\} is refused for the same reason/,
            "it hands over a remedy without saying the pause refuses it too");
        assert.match(detail, /set_game_speed \{paused: false\}/,
            "and never names a call that would actually go through");
    } finally {
        restore();
    }
});

test("a pause landing after the track says both ways out of a missing door are refused", function () {
    const { game, restore } = park();
    pauseWhen(game, "rideentranceexitplace");

    try {
        const outcome = build({});
        const detail = step(outcome, "entrance/exit");

        assert.equal(outcome.ok, true, "the track is on the ground, so the ride exists");
        assert.equal(outcome.doorsAttached, false, "but neither door went up");
        assert.deepEqual(trackTiles(game, 0), square(13, 9, 3, 3), "the track really is standing");
        assert.equal(doorAt(game, 12, 10, false), undefined, "and the entrance building really is not");

        assert.match(detail, /rideentranceexitplace/, "the way to finish the ride is not named");
        assert.match(detail, /operate_ride \{ride: 0, demolish: true\}/, "nor the way to undo it");
        // Both of those fire an action the pause refuses, so offering them bare is the same
        // defect one step later.
        assert.match(detail, /neither of those two ways out goes through until the clock is running/,
            "it offers two remedies that the pause refuses, without saying so");
        assert.match(detail, /set_game_speed \{paused: false\}/, "and never names the call that lifts the pause");
    } finally {
        restore();
    }
});

test("a running game gets no pause clause on either failure", function () {
    // The other half of every guard above: a clause appended unconditionally would satisfy
    // all of them and would lie on every ordinary failure.
    const cleanup = park();
    cleanup.game.refuse.trackplace = true;
    cleanup.game.refuse.ridedemolish = true;

    try {
        const detail = step(build({}), "cleanup");

        assert.doesNotMatch(detail, /paused/, "an unpaused failure must not blame the clock");
        assert.doesNotMatch(detail, /set_game_speed/, "nor send the model to a lever it does not need");
        assert.match(detail, /Remove it with operate_ride \{ride: 0, demolish: true\}/,
            "the plain remedy is the right one when the clock is running");
    } finally {
        cleanup.restore();
    }

    const doors = park();
    dropAction(function (name, args) { return name === "rideentranceexitplace" && args.isExit === true; });

    try {
        const detail = step(build({}), "entrance/exit");

        assert.doesNotMatch(detail, /paused/, "an unpaused door failure must not blame the clock either");
        assert.doesNotMatch(detail, /set_game_speed/, "nor name a lever that changes nothing here");
    } finally {
        doors.restore();
    }
});

test("build_flat_ride's description states that a paused game builds nothing", function () {
    // The refusal above is reachable - no schema can check the clock - but the description
    // is what the model reads before it decides to pause, and the fact belongs there too.
    const definition = getMcpToolDefinitions(BuildTools)
        .filter(function (tool) { return tool.name === "build_flat_ride"; })[0];

    assert.ok(definition, "build_flat_ride is not registered");
    assert.match(String(definition.description), /paused game refuses the track and door actions/,
        "the description never says a paused game cannot build");
    assert.match(String(definition.description), /set_game_speed/, "nor names what starts the clock");
});
