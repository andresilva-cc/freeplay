import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import type { FakeRide } from "./fakeGame.ts";
import { readGuestFeedback, readParkStatus } from "../src/park/status.ts";
import type { RideSummary } from "../src/park/status.ts";
import { tileIsWalkable, walkableFromParkEntrance } from "../src/park/paths.ts";
import { StatusTools } from "../src/tools/status.ts";
import { getMcpToolDefinitions } from "../src/tools/decorators.ts";
import { openPark } from "../src/tools/openPark.ts";
import type { OpenParkOutcome } from "../src/tools/openPark.ts";

/** A ride door: the tile the building sits on, and the direction that points at the ride. */
interface Door {
    x: number;
    y: number;
    direction: number;
}

/**
 * The fake covers `scenario`, `date` and `park.getMonthlyExpenditure`, but it is shared
 * with every other suite. Stand in for anything it stops providing so a missing global
 * fails as one clear assertion here rather than as a TypeError in every test.
 */
function installMissingGlobals(): () => void {
    const scope = globalThis as unknown as Record<string, unknown>;
    const previous = { scenario: scope.scenario, date: scope.date };
    const park = scope.park as Record<string, unknown>;

    if (!scope.scenario) {
        scope.scenario = { name: "Forest Frontiers", objective: { type: "guests_by" }, status: "inProgress" };
    }

    if (!scope.date) {
        scope.date = { year: 1, month: 3, day: 4 };
    }

    if (typeof park.getMonthlyExpenditure !== "function") {
        park.getMonthlyExpenditure = function () { return [0, 0, 0, 0]; };
    }

    return function () {
        scope.scenario = previous.scenario;
        scope.date = previous.date;
    };
}

/** A park with a gate at 10,2 and one main path running south from it. */
function withPark(
    build: (game: FakeGame) => void,
    run: (game: FakeGame) => void,
    options?: { inert?: boolean }
): void {
    const game = new FakeGame(32, 32, options);
    game.addParkEntrance(10, 2);

    for (let y = 3; y <= 22; y++) {
        game.addPath(10, y);
    }

    build(game);
    const restore = game.install();
    const restoreGlobals = installMissingGlobals();

    try {
        run(game);
    } finally {
        restoreGlobals();
        restore();
    }
}

function spot(door: Door | null): { x: number; y: number; z: number; direction: number } | null {
    return door === null ? null : { x: door.x * 32, y: door.y * 32, z: 96, direction: door.direction };
}

/** `type` defaults to a merry-go-round; `start` is where the ride itself stands, in tiles. */
function ride(
    id: number,
    entrance: Door | null,
    exit: Door | null,
    extra?: { type?: number; start?: { x: number; y: number } }
): FakeRide {
    const start = extra && extra.start
        ? { x: extra.start.x * 32, y: extra.start.y * 32, z: 96 }
        : null;

    return {
        id: id, name: "Ride " + String(id), type: extra && typeof extra.type === "number" ? extra.type : 33,
        status: "open", price: [10],
        stations: [{ start: start, entrance: spot(entrance), exit: spot(exit), length: 1, queueTime: 4 }],
        excitement: 600, intensity: 400, totalCustomers: 0, totalProfit: 0,
        downtime: 0, reliability: 100, flags: 0, value: 40
    };
}

/**
 * A stall standing on the ground, facing `rotation`, as the game leaves one: a drink stall
 * with no entrance and no exit, and the track element the game records its facing on.
 */
function stall(game: FakeGame, id: number, x: number, y: number, rotation: number): void {
    // trackType 262 is flatTrack1x1A, the piece every 1x1 stall is placed with.
    game.tile(x, y).elements.push({
        type: "track", baseZ: 96, ride: id, trackType: 262, direction: rotation
    });
    game.rides.push(ride(id, null, null, { type: 30, start: { x: x, y: y } }));
}

/** Whether the fake's own map carries a footpath on this tile. */
function hasPath(game: FakeGame, x: number, y: number): boolean {
    return game.tile(x, y).elements.filter(function (element) {
        return element.type === "footpath";
    }).length > 0;
}

function summary(id: number): RideSummary {
    const found = readParkStatus().rides.filter(function (r) { return r.id === id; });
    assert.equal(found.length, 1, "ride " + String(id) + " was not in the status");
    return found[0];
}

/**
 * The ride a queue tile is bound to, read back off the map the way the game stores it.
 * `undefined` means there is no queue on that tile at all.
 */
function queueBinding(game: FakeGame, x: number, y: number): number | null | undefined {
    const elements = game.tile(x, y).elements;

    for (let i = 0; i < elements.length; i++) {
        if (elements[i].type === "footpath" && elements[i].isQueue) {
            return elements[i].ride;
        }
    }

    return undefined;
}

/** Replaces the fake's empty crowd, which is all it offers, with guests that have thoughts. */
function putGuestsInPark(crowd: { happiness: number; cash: number; thoughts: string[] }[]): void {
    const scope = globalThis as unknown as Record<string, unknown>;
    const gameMap = scope.map as Record<string, unknown>;

    gameMap.getAllEntities = function (kind: string) {
        if (kind !== "guest") {
            return [];
        }

        return crowd.map(function (guest) {
            return {
                happiness: guest.happiness,
                cash: guest.cash,
                thoughts: guest.thoughts.map(function (thought) { return { type: thought }; })
            };
        });
    };
}

test("a guest walks the whole length of a queue to reach the door", function () {
    withPark(function (game) {
        // Five queue tiles from the main path at 10,10 out to the entrance building at 16,10.
        for (let x = 11; x <= 15; x++) {
            game.addPath(x, 10, true, 0);
        }

        game.rides = [ride(0, { x: 16, y: 10, direction: 2 }, null)];
    }, function () {
        const found = summary(0);

        assert.equal(found.hasQueue, true, "a queue is bound to the entrance");
        assert.equal(found.guestsCanReach, true,
            "a queue longer than one tile is still walked end to end, so the ride is reachable");
    });
});

/**
 * Pins the walkability half of `guestsCanReach`. The queue here is bound to the ride by
 * the game's own chaining, so everything except the walk from the gate is in order: drop
 * the flood check and this ride reads reachable while no guest can ever get to it.
 */
test("a queue the game has bound to the ride is still unreachable when nothing joins it", function () {
    withPark(function (game) {
        game.addPath(20, 20, true);
        game.addPath(21, 20, true);
        // Placing the entrance is what binds the queue, exactly as it does in the game.
        game.addRideEntrance(22, 20, 0, 2);
        game.rides = [ride(0, { x: 22, y: 20, direction: 2 }, null)];
    }, function (game) {
        assert.equal(queueBinding(game, 21, 20), 0,
            "the game bound the queue at the door to ride 0, so hasQueue is not the missing part");

        const walkable = walkableFromParkEntrance();

        assert.equal(tileIsWalkable(walkable, { x: 21, y: 20 }), false,
            "and the game's own flood from the park entrance does not reach that queue");

        const found = summary(0);

        assert.deepEqual(found.entranceDoor, { x: 21, y: 20 }, "the door is the tile the queue occupies");
        assert.equal(found.hasQueue, true, "the queue exists and serves this ride");
        assert.equal(found.guestsCanReach, false,
            "but no guest can walk to it, so the ride must not be reported as reachable");
    });
});

test("an ordinary path at the door is not a queue, so guests still cannot board", function () {
    withPark(function (game) {
        game.addPath(11, 6);
        game.rides = [ride(0, { x: 12, y: 6, direction: 2 }, null)];
    }, function () {
        const walkable = walkableFromParkEntrance();
        assert.equal(tileIsWalkable(walkable, { x: 11, y: 6 }), true,
            "the tile the door opens onto really is reachable on foot");

        const found = summary(0);

        assert.equal(found.hasQueue, false, "an ordinary footpath is not a queue");
        assert.equal(found.guestsCanReach, false,
            "guests crowd a door with no queue and never board, so this must not be reported as reachable");
    });
});

/** A queue serving the ride next door is not a queue for this one. */
test("a queue at the door bound to another ride does not serve this ride", function () {
    withPark(function (game) {
        game.addPath(11, 6, true, 7);
        game.rides = [ride(0, { x: 12, y: 6, direction: 2 }, null)];
    }, function (game) {
        assert.equal(queueBinding(game, 11, 6), 7, "the queue on the door tile belongs to ride 7");
        assert.equal(tileIsWalkable(walkableFromParkEntrance(), { x: 11, y: 6 }), true,
            "and guests can walk to it, so only the binding is wrong");

        const found = summary(0);

        assert.deepEqual(found.entranceDoor, { x: 11, y: 6 }, "ride 0's door is still reported");
        assert.equal(found.hasQueue, false, "a queue bound to another ride is no queue for this one");
        assert.equal(found.guestsCanReach, false, "so nobody boards ride 0");
    });
});

/**
 * The door is one step out from the building, on the side away from the ride. Turn that
 * around and every door lands inside the ride, where no queue can ever be.
 */
test("the entrance door is the tile in front of the building, away from the ride", function () {
    withPark(function (game) {
        game.addPath(11, 10, true);
        game.addRideEntrance(12, 10, 0, 2);
        game.rides = [ride(0, { x: 12, y: 10, direction: 2 }, null)];
    }, function (game) {
        const station = game.rides[0].stations[0];

        assert.deepEqual(station.entrance, { x: 384, y: 320, z: 96, direction: 2 },
            "the game holds the entrance in world units, twelve tiles across and ten down");
        assert.equal(queueBinding(game, 11, 10), 0, "the queue in front of it is bound to ride 0");

        const found = summary(0);

        assert.deepEqual(found.entrance, { x: 12, y: 10 }, "the building is reported in tiles, not world units");
        assert.deepEqual(found.entranceDoor, { x: 11, y: 10 },
            "a building at 12,10 facing the ride at +x opens onto 11,10, not 13,10");
        assert.equal(found.guestsCanReach, true,
            "the queue on 11,10 joins the main path, so guests reach the ride");
    });
});

test("the exit is reported on its own, not copied from the entrance", function () {
    withPark(function (game) {
        for (let x = 11; x <= 15; x++) {
            game.addPath(x, 10, true, 0);
        }

        game.rides = [ride(0, { x: 16, y: 10, direction: 2 }, { x: 16, y: 14, direction: 2 })];
    }, function (game) {
        const before = summary(0);

        assert.equal(before.guestsCanReach, true, "guests can get in");
        assert.equal(before.exitConnected, false, "but the exit opens onto bare ground");
        assert.deepEqual(before.exitDoor, { x: 15, y: 14 }, "and the tile a path has to reach is named");

        for (let x = 11; x <= 15; x++) {
            game.addPath(x, 14);
        }

        const after = summary(0);

        assert.equal(after.exitConnected, true, "a path back to the park makes the exit connected");
        assert.equal(after.guestsCanReach, true, "and the way in is unchanged");
    });
});

test("a ride with no entrance building reports nothing rather than guessing", function () {
    withPark(function (game) {
        game.addPath(11, 8);
        game.rides = [ride(0, null, { x: 12, y: 8, direction: 2 })];
    }, function () {
        const found = summary(0);

        assert.equal(found.entrance, null, "there is no entrance to report");
        assert.equal(found.entranceDoor, null, "and so no door either");
        assert.equal(found.hasQueue, false);
        assert.equal(found.guestsCanReach, false, "a ride guests cannot enter is never reachable");
        assert.equal(found.exitConnected, true, "the exit is still judged on its own");
        assert.deepEqual(found.exit, { x: 12, y: 8 }, "door coordinates come back in tiles, not world units");
        assert.deepEqual(found.exitDoor, { x: 11, y: 8 }, "the exit door is the tile it opens onto");
    });
});

/**
 * A stall has no entrance, no exit and no queue: guests buy over the counter from the one
 * tile it faces. Judged by a door it never has, every working stall reads unreachable, and
 * the model spends turns rebuilding a shop that was already serving customers.
 */
test("a stall is reachable from the tile it faces, with no door and no queue", function () {
    withPark(function (game) {
        // A drink stall against the main path, facing it: rotation 0 is served from -x.
        stall(game, 0, 11, 10, 0);
    }, function (game) {
        const track = game.tile(11, 10).elements.filter(function (element) {
            return element.type === "track";
        })[0];

        assert.equal(track.direction, 0, "the stall on the map was laid facing -x");
        assert.equal(tileIsWalkable(walkableFromParkEntrance(), { x: 10, y: 10 }), true,
            "the tile it faces is inside the park entrance flood");
        assert.deepEqual(
            [hasPath(game, 12, 10), hasPath(game, 11, 9), hasPath(game, 11, 11)],
            [false, false, false],
            "and no other side of it carries a path at all, so only the facing tile can serve it");

        const found = summary(0);

        assert.equal(found.isShop, true, "a drink stall is a shop");
        assert.deepEqual(found.counter, { x: 10, y: 10 }, "the counter is the neighbour its rotation points at");
        assert.equal(found.guestsCanReach, true, "and guests can walk to it");
        assert.equal(found.hasQueue, null, "a stall takes no queue, which is not the same as missing one");
        assert.equal(found.exitConnected, null, "and has no exit to connect");
        assert.equal(found.entranceDoor, null, "no entrance building, so no door");
        assert.equal(found.exitDoor, null);
    });
});

/**
 * The other half of the same rule, and the expensive half to get wrong in the other
 * direction: counting any of the four neighbours reported a stall as working when the only
 * path ran along its back wall. Measured in the game - a rotation-1 stall at 56,33 ringed
 * with footpath formed a footpath edge only on its facing side, and a path on one of the
 * other three left it with no connection at all.
 */
test("a path on every side but the one a stall faces serves nobody", function () {
    withPark(function (game) {
        // Facing +x, so the counter is 12,10 and the main path at 10,10 is its back wall.
        stall(game, 0, 11, 10, 2);
        game.addPath(11, 9);
        game.addPath(11, 11);
    }, function (game) {
        const walkable = walkableFromParkEntrance();

        assert.deepEqual(
            [
                tileIsWalkable(walkable, { x: 10, y: 10 }),
                tileIsWalkable(walkable, { x: 11, y: 9 }),
                tileIsWalkable(walkable, { x: 11, y: 11 })
            ],
            [true, true, true],
            "three of the stall's four sides carry path guests can walk to");
        assert.equal(hasPath(game, 12, 10), false, "and the side it faces is bare ground");

        const ringed = summary(0);

        assert.deepEqual(ringed.counter, { x: 12, y: 10 }, "rotation 2 is served from +x, and it says so");
        assert.equal(ringed.guestsCanReach, false,
            "a path against three walls buys nothing: only the facing tile is a counter");

        // Now run the path round to the side it actually faces.
        game.addPath(12, 11);
        game.addPath(12, 10);

        assert.equal(tileIsWalkable(walkableFromParkEntrance(), { x: 12, y: 10 }), true,
            "the counter tile is now joined to the park's paths");

        const served = summary(0);

        assert.deepEqual(served.counter, { x: 12, y: 10 }, "the counter has not moved");
        assert.equal(served.guestsCanReach, true, "and the stall is served");
    });
});

test("a stall no path touches is reported unreachable", function () {
    withPark(function (game) {
        stall(game, 0, 20, 20, 0);
    }, function (game) {
        assert.equal(hasPath(game, 19, 20), false, "the tile it faces is bare");

        const found = summary(0);

        assert.equal(found.isShop, true);
        assert.deepEqual(found.counter, { x: 19, y: 20 }, "the tile a path has to reach is still named");
        assert.equal(found.guestsCanReach, false, "nobody can buy from a stall in the middle of a field");
    });
});

/**
 * Which way a stall faces is recorded on its track and nowhere else. With no track on the
 * ground there is no facing to read, and a guessed one is how a stall gets reported as
 * served from a tile it turns its back on.
 */
test("a stall with no track on the ground names no counter and reaches nobody", function () {
    withPark(function (game) {
        game.rides = [ride(0, null, null, { type: 30, start: { x: 11, y: 10 } })];
    }, function (game) {
        assert.equal(game.tile(11, 10).elements.filter(function (element) {
            return element.type === "track";
        }).length, 0, "nothing of this stall is standing on the map");
        assert.equal(tileIsWalkable(walkableFromParkEntrance(), { x: 10, y: 10 }), true,
            "even though the tile beside it is path guests can walk to");

        const found = summary(0);

        assert.equal(found.counter, null, "there is no facing to read, so none is invented");
        assert.equal(found.guestsCanReach, false);
    });
});

/** Each flag is read off its own bit: one wrong shift turns a broken ride into a full queue. */
test("each ride flag comes from its own bit", function () {
    withPark(function (game) {
        game.rides = [ride(0, null, null)];
    }, function (game) {
        game.rides[0].flags = 1 << 7;
        let found = summary(0);
        assert.equal(found.brokenDown, true, "bit 7 is broken down");
        assert.equal(found.crashed, false, "bit 7 is not crashed");
        assert.equal(found.queueFull, false, "bit 7 is not a full queue");

        game.rides[0].flags = 1 << 9;
        found = summary(0);
        assert.equal(found.queueFull, true, "bit 9 is the full queue");
        assert.equal(found.brokenDown, false);
        assert.equal(found.crashed, false);

        game.rides[0].flags = 1 << 10;
        found = summary(0);
        assert.equal(found.crashed, true, "bit 10 is crashed");
        assert.equal(found.brokenDown, false);
        assert.equal(found.queueFull, false);

        game.rides[0].flags = (1 << 7) | (1 << 9) | (1 << 10);
        found = summary(0);
        assert.deepEqual(
            { brokenDown: found.brokenDown, crashed: found.crashed, queueFull: found.queueFull },
            { brokenDown: true, crashed: true, queueFull: true },
            "and all three read together");

        game.rides[0].flags = (1 << 6) | (1 << 8) | (1 << 11);
        found = summary(0);
        assert.deepEqual(
            { brokenDown: found.brokenDown, crashed: found.crashed, queueFull: found.queueFull },
            { brokenDown: false, crashed: false, queueFull: false },
            "the bits either side of them mean other things and must not leak in");
    });
});

/**
 * Net profit is the sum of every expenditure stream the game keeps. Miss one and a month
 * that spent its cash on rides or land reports a profit the game's own finances deny.
 */
test("monthly profit adds up all fourteen expenditure streams", function () {
    // The game's own ExpenditureType, in full.
    const streams = [
        "ride_construction", "ride_runningcosts", "land_purchase", "landscaping",
        "park_entrance_tickets", "park_ride_tickets", "shop_sales", "shop_stock",
        "food_drink_sales", "food_drink_stock", "wages", "marketing", "research", "interest"
    ];

    withPark(function () { /* no scenery needed */ }, function () {
        const scope = globalThis as unknown as Record<string, unknown>;
        const park = scope.park as Record<string, unknown>;
        const asked: string[] = [];
        const values: Record<string, number[]> = {};

        for (let i = 0; i < streams.length; i++) {
            // Distinct per stream, so dropping any one of them changes the total.
            values[streams[i]] = [i + 1, -(i + 1), 0, 0];
        }

        park.getMonthlyExpenditure = function (stream: string) {
            asked.push(stream);
            return values[stream] || [0, 0, 0, 0];
        };

        const status = readParkStatus();

        assert.equal(streams.length, 14, "the game keeps fourteen expenditure streams");
        assert.equal(status.monthlyProfit[0], 105,
            "this month is 1 + 2 + ... + 14, the sum over all fourteen streams");
        assert.equal(status.monthlyProfit[1], -105, "and last month is the same sum, signed the other way");

        const missed = streams.filter(function (stream) { return asked.indexOf(stream) < 0; });

        assert.deepEqual(missed, [], "every stream the game keeps has to be read");
        assert.equal(asked.length, 14, "fourteen streams, read once each");
    });
});

test("the reachable path count leaves out paths guests cannot get to", function () {
    withPark(function (game) {
        // An orphan path block in the corner, joined to nothing.
        game.addPath(20, 20);
        game.addPath(20, 21);
        game.addPath(21, 20);
    }, function () {
        const paths = readParkStatus().paths;

        assert.deepEqual(paths.entrance.map(function (tile) { return tile.x; }), [10, 11, 12],
            "the three tiles of the gate are the entrance");
        assert.equal(paths.reachableTiles, 20, "only the twenty tiles of the main path are reachable");

        const orphans = paths.reachableSample.filter(function (tile) { return tile.x >= 20; });
        assert.deepEqual(orphans, [], "the orphan block must not be offered as somewhere to build from");
    });
});

/**
 * A short network is reported whole. Handing back a thinned-out spread with nothing
 * saying so reads as the end of the path network, and the model aims a path at a tile
 * it has decided is unconnected.
 */
test("a small path network is reported in full, and says that it is", function () {
    withPark(function (game) {
        // Forty tiles: the size a park actually is while it still needs connecting up.
        for (let x = 11; x <= 30; x++) {
            game.addPath(x, 10);
        }
    }, function () {
        const paths = readParkStatus().paths;
        const walkable = walkableFromParkEntrance();
        const everyTile = Object.keys(walkable).sort();
        const reported = paths.reachableSample.map(function (tile) {
            return String(tile.x) + "," + String(tile.y);
        }).sort();

        assert.equal(everyTile.length, 40, "the main path and its branch are forty tiles");
        assert.equal(paths.reachableSampleComplete, true, "forty tiles is nothing like a full park");
        assert.deepEqual(reported, everyTile,
            "every tile the game says guests can reach is listed, not a spread of them");
        assert.equal(paths.reachableTiles, everyTile.length, "and the count agrees with the list");
    });
});

test("a network too big to list says so, and still reports the true count", function () {
    withPark(function (game) {
        // A twenty by twenty square of path hanging off the gate: four hundred tiles.
        for (let y = 3; y <= 22; y++) {
            for (let x = 3; x <= 22; x++) {
                if (x !== 10) {
                    game.addPath(x, y);
                }
            }
        }
    }, function () {
        const paths = readParkStatus().paths;
        const everyTile = Object.keys(walkableFromParkEntrance());

        assert.equal(everyTile.length, 400, "the square and the main path make four hundred reachable tiles");
        assert.equal(paths.reachableTiles, 400, "the count is of the whole network, never of the listing");
        assert.equal(paths.reachableSampleComplete, false, "and the listing says it is only a spread");
        assert.ok(paths.reachableSample.length <= 250,
            "which is capped, or park_status costs more context than it is worth");
        assert.ok(paths.reachableSample.length >= 100, "but is still a usable spread of the network");
    });
});

test("guest feedback says how many guests it read, next to how many there are", function () {
    withPark(function () { /* no scenery needed */ }, function () {
        const crowd = [];

        for (let i = 0; i < 50; i++) {
            crowd.push({ happiness: 200, cash: 100, thoughts: [i < 5 ? "hungry" : "thirsty"] });
        }

        putGuestsInPark(crowd);
        const feedback = readGuestFeedback(10);

        assert.equal(feedback.guests, 50, "there are fifty guests in the park");
        assert.equal(feedback.sampled, 10, "only ten of them were read");

        let counted = 0;

        for (let i = 0; i < feedback.thoughts.length; i++) {
            counted += feedback.thoughts[i].count;
        }

        assert.equal(counted, 10, "the thought counts add up to the sample, not to the park");
        assert.equal(feedback.thoughts[0].thought, "hungry", "the commonest thought in the sample comes first");
    });
});

test("an empty park reports no guests rather than an average of nothing", function () {
    withPark(function () { /* no scenery needed */ }, function () {
        putGuestsInPark([]);
        const feedback = readGuestFeedback(100);

        assert.equal(feedback.guests, 0);
        assert.equal(feedback.sampled, 0, "nothing was read, and it says so");
        assert.deepEqual(feedback.thoughts, []);
        assert.equal(feedback.averageHappiness, 0, "an average of no guests is reported as zero, not as NaN");
        assert.equal(feedback.averageCash, 0);
    });
});

/** A ceiling the caller cannot see is a ceiling the caller cannot plan around. */
test("the guest sample argument declares the ceiling it is silently clamped to", function () {
    withPark(function () { /* no scenery needed */ }, function () {
        const definitions = getMcpToolDefinitions(StatusTools).filter(function (definition) {
            return definition.handlerName === "guestFeedback";
        });

        assert.equal(definitions.length, 1, "guest_feedback is a registered tool");

        const properties = definitions[0].inputSchema.properties || {};
        const sample = properties.sample as { type?: string; minimum?: number; maximum?: number };

        assert.equal(sample.maximum, 500, "the schema names the largest sample that will be read");
        assert.equal(sample.minimum, 1, "and the smallest");

        const crowd = [];

        for (let i = 0; i < 600; i++) {
            crowd.push({ happiness: 200, cash: 100, thoughts: ["hungry"] });
        }

        putGuestsInPark(crowd);
        const tools = new StatusTools();

        assert.equal(tools.guestFeedback({ sample: 9999 }).sampled, sample.maximum,
            "and asking for more reads exactly the declared maximum");
    });
});

test("the ride object list keeps its count and its contents in step", function () {
    withPark(function (game) {
        for (let i = 0; i < 40; i++) {
            // Type 33 is a merry-go-round, placed in one action; type 5 is a tracked coaster.
            game.rideObjects.push({ index: i, name: "Object " + String(i), rideType: [i % 2 === 0 ? 33 : 5] });
        }
    }, function () {
        const tools = new StatusTools();
        const all = tools.listRideObjects({});

        assert.equal(all.totalAvailable, 40, "forty objects exist");
        assert.equal(all.count, 40);
        assert.equal(all.objects.length, 40, "the whole list comes back, nothing is trimmed off the end");

        const flat = tools.listRideObjects({ flatRidesOnly: true });

        assert.equal(flat.totalAvailable, 40, "the total is of everything, before the filter");
        assert.equal(flat.count, 20, "half of them go up in one action");
        assert.equal(flat.objects.length, flat.count, "the count is of the list that was actually returned");
        assert.equal(flat.objects[0].footprint, "3x3", "and each one says how much room it needs");
    });
});

/** A footprint is width by depth. Printed the other way round it sites the ride sideways. */
test("an oblong footprint is printed width first", function () {
    withPark(function (game) {
        // Type 37 is the ferris wheel: one tile wide and four deep.
        game.rideObjects.push({ index: 0, name: "Ferris Wheel", rideType: [37] });
        game.rideObjects.push({ index: 1, name: "Merry-Go-Round", rideType: [33] });
    }, function () {
        const objects = new StatusTools().listRideObjects({}).objects;
        const wheel = objects.filter(function (object) { return object.rideType === 37; })[0];

        assert.equal(wheel.footprint, "1x4", "the ferris wheel is one wide by four deep, not four by one");
        assert.equal(objects.filter(function (object) { return object.rideType === 33; })[0].footprint, "3x3",
            "and a square one reads the same either way round, which is why this needs an oblong");
    });
});

/**
 * The two park actions, which the shared fake now models.
 *
 * Until it did, `open_park` could not be run against it at all - the fake throws on an
 * action it does not model - so the tool carried a fake of its own and the shared deferred
 * transport was only covered for it second-hand. Each of these reads the park state back
 * off the fake rather than off what a call returned: a tool that reports what it attempted
 * passes every assertion made against its own return value.
 */
test("opening the park is accepted now and applied on a later tick", function () {
    withPark(function () { /* no scenery needed */ }, function (game) {
        assert.equal(game.parkFlags.open, false, "the park starts closed");

        context.executeAction("parksetparameter", { parameter: 1, value: 0 }, function () { /* read back */ });

        assert.equal(game.parkFlags.open, false, "an accepted action has not taken effect yet");

        game.applyQueuedActions();

        assert.equal(game.parkFlags.open, true, "the park the fake holds is open");
        assert.equal(readParkStatus().parkOpen, true, "and park_status reads that back off it");

        context.executeAction("parksetparameter", { parameter: 0, value: 0 }, function () { /* read back */ });
        game.applyQueuedActions();

        assert.equal(game.parkFlags.open, false, "0 is the same action closing the park again");
        assert.equal(readParkStatus().parkOpen, false);
    });
});

test("the entrance fee is set by its own action, in tenths", function () {
    withPark(function () { /* no scenery needed */ }, function (game) {
        assert.equal(game.parkValues.entranceFee, 0, "admission starts free");

        context.executeAction("parksetentrancefee", { value: 25 }, function () { /* read back */ });

        assert.equal(game.parkValues.entranceFee, 0, "an accepted action has not taken effect yet");

        game.applyQueuedActions();

        assert.equal(game.parkValues.entranceFee, 25, "the park the fake holds charges 2.50");
        assert.equal(readParkStatus().entranceFee, 25, "and park_status reads that back off it");
    });
});

test("an inert game accepts both park actions and applies neither", function () {
    withPark(function () { /* no scenery needed */ }, function (game) {
        context.executeAction("parksetparameter", { parameter: 1, value: 0 }, function () { /* read back */ });
        context.executeAction("parksetentrancefee", { value: 25 }, function () { /* read back */ });

        assert.deepEqual(game.attempted.map(function (action) { return action.name; }),
            ["parksetparameter", "parksetentrancefee"], "both actions were accepted");
        assert.equal(game.pending.length, 0, "and neither was queued to be applied");

        game.applyQueuedActions();

        assert.equal(game.parkFlags.open, false, "so the park is still closed");
        assert.equal(game.parkValues.entranceFee, 0, "and admission is still free");

        const status = readParkStatus();

        assert.equal(status.parkOpen, false, "which is what park_status has to report");
        assert.equal(status.entranceFee, 0);
    }, { inert: true });
});

test("a refused park action leaves the park exactly as it was", function () {
    withPark(function () { /* no scenery needed */ }, function (game) {
        game.refuse.parksetparameter = true;
        let result: Record<string, unknown> | undefined;

        context.executeAction("parksetparameter", { parameter: 1, value: 0 }, function (answer) {
            result = answer as unknown as Record<string, unknown>;
        });
        game.applyQueuedActions();

        assert.equal(result && result.error, 1, "the refusal comes back as an error, not a silent no-op");
        assert.equal(game.parkFlags.open, false, "and the park the fake holds never opened");
        assert.equal(readParkStatus().parkOpen, false);
    });
});

/**
 * The whole point of modelling them: open_park now runs against the shared fake, tick
 * timing and all, instead of against a stand-in written for itself.
 */
test("open_park opens the park and prices admission on the shared fake", function () {
    withPark(function () { /* no scenery needed */ }, function (game) {
        let outcome: OpenParkOutcome | undefined;

        openPark({ open: true, entranceFee: 25 }, function (answer) { outcome = answer; });

        assert.equal(game.parkFlags.open, true, "the fake's own park flag says the park opened");
        assert.equal(game.parkValues.entranceFee, 25, "and that it charges 2.50 to get in");

        const status = readParkStatus();

        assert.equal(status.parkOpen, true, "park_status agrees");
        assert.equal(status.entranceFee, 25);
        assert.equal(outcome && outcome.ok, true, "and the tool reported what the park actually did");
    });
});

test("open_park reports a park that never opened as a failure", function () {
    withPark(function () { /* no scenery needed */ }, function (game) {
        let outcome: OpenParkOutcome | undefined;

        openPark({ open: true, entranceFee: 25 }, function (answer) { outcome = answer; });

        assert.equal(game.parkFlags.open, false, "nothing took effect in an inert game");
        assert.equal(game.parkValues.entranceFee, 0);
        assert.equal(outcome && outcome.ok, false, "so the tool must not report success");
        assert.equal(readParkStatus().parkOpen, false);
    }, { inert: true });
});
