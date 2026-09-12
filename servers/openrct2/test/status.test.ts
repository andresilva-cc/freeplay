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

/**
 * The failure this whole reachability rule was rewritten for, read at the surface the model
 * actually sees.
 *
 * Ride 1's door is down the main walk, past a stretch that ride 0 has taken for its queue.
 * The old flood refused to step off a queue tile onto ordinary path, so it stopped dead at
 * ride 0's line and called ride 1 unreachable. The game does not stop there: in a running
 * Forest Frontiers with exactly this shape, the ride behind the queue took 62 paying
 * customers while `guestsCanReach` said false at every reading.
 */
test("a ride down the walk past another ride's queue is reachable, because guests walk over it", function () {
    withPark(function (game) {
        // Ride 0's queue occupies two tiles of the only walk south.
        game.addPath(10, 8, true);
        game.addPath(10, 9, true);
        game.addRideEntrance(11, 9, 0, 2);
        // Ride 1 is further down the same walk, with a queue of its own.
        game.addPath(10, 14, true);
        game.addRideEntrance(11, 14, 1, 2);
        game.rides = [
            ride(0, { x: 11, y: 9, direction: 2 }, null),
            ride(1, { x: 11, y: 14, direction: 2 }, null)
        ];
    }, function (game) {
        assert.equal(queueBinding(game, 10, 9), 0, "ride 0 owns the queue across the walk");
        assert.equal(queueBinding(game, 10, 14), 1, "and ride 1 owns its own");

        const walkable = walkableFromParkEntrance();

        assert.equal(tileIsWalkable(walkable, { x: 10, y: 10 }), true,
            "the walk continues past ride 0's queue, because the game left those edges alone");

        assert.equal(summary(0).guestsCanReach, true, "the near ride is reachable");
        assert.equal(summary(1).guestsCanReach, true,
            "and so is the one beyond it: a queue in the way is a corridor, not a wall");
    });
});

/**
 * The same walk, with the one cut the game really does make: when a ride claims the queue at
 * its door, the tile at the door loses its edge to whatever lies past it. Measured going
 * both ways in a running park - stripping the queue back to ordinary path put the edge back
 * and reopened the walk.
 */
test("a ride behind a door the game has dead-ended is not reachable", function () {
    withPark(function (game) {
        game.addPath(10, 8, true);
        game.addPath(10, 9, true);
        game.addRideEntrance(11, 9, 0, 2);
        game.addPath(10, 14, true);
        game.addRideEntrance(11, 14, 1, 2);
        // Ride 0's line ends at its door: the game clears the bit on the far side of it.
        game.severPath(10, 9, 10, 10);
        game.rides = [
            ride(0, { x: 11, y: 9, direction: 2 }, null),
            ride(1, { x: 11, y: 14, direction: 2 }, null)
        ];
    }, function () {
        assert.equal(summary(0).guestsCanReach, true, "the near ride still has its queue joined to the walk");
        assert.equal(summary(1).guestsCanReach, false,
            "but nothing past the dead-ended door can be walked to, and the report must say so");
    });
});

/**
 * The discriminator for the old rule, which ANDed `hasQueue` into `guestsCanReach`: a door
 * on ordinary walkable path with no queue anywhere near it. The old rule called this
 * unreachable; OpenRCT2's `PeepInteractWithEntrance` has an explicit branch for a guest
 * arriving on ordinary path with no queue and puts them straight into queuing state, so it
 * is reachable and boards one guest at a time.
 */
test("a door on walkable path with no queue is reachable, and says so separately from hasQueue", function () {
    withPark(function (game) {
        game.addPath(11, 6);
        game.rides = [ride(0, { x: 12, y: 6, direction: 2 }, null)];
    }, function () {
        const walkable = walkableFromParkEntrance();
        assert.equal(tileIsWalkable(walkable, { x: 11, y: 6 }), true,
            "the tile the door opens onto really is reachable on foot");

        const found = summary(0);

        assert.equal(found.hasQueue, false, "an ordinary footpath is not a queue");
        assert.equal(found.guestsCanReach, true,
            "a ride with no queue takes guests one at a time; calling it unreachable reported four rides"
            + " false through 29 recorded boardings");
    });
});

/** A queue serving the ride next door is not a queue for this one - but the door is still reachable. */
test("a queue at the door bound to another ride is no queue for this ride, and does not hide the door", function () {
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
        assert.equal(found.guestsCanReach, true,
            "guests reach ride 0's door on foot whatever that queue belongs to: hasQueue is the throughput"
            + " signal, not the reachability one");
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

        assert.deepEqual(paths.gate.map(function (tile) { return tile.x; }), [10, 11, 12],
            "the three tiles of the gate are the park's own entrance");
        assert.equal(paths.reachableTiles, 20, "only the twenty tiles of the main path are reachable");

        const orphans = paths.runs.filter(function (run) { return run.fromX >= 20 || run.toX >= 20; });
        assert.deepEqual(orphans, [], "the orphan block must not be offered as somewhere to build from");

        const stranded = paths.islands.filter(function (island) { return island.fromX >= 20; });

        assert.equal(stranded.length, 1,
            "and it is named as an island, which the flat tile list had no way of saying at all");
        assert.equal(stranded[0].tiles, 3);
    });
});

/** Every tile of every run, in the order the run lays them down. Runs are always straight. */
function tilesOf(runs: { fromX: number; fromY: number; toX: number; toY: number; tiles: number }[]): string[] {
    const covered: string[] = [];

    for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        const dx = run.toX === run.fromX ? 0 : 1;
        const dy = run.toY === run.fromY ? 0 : 1;

        for (let step = 0; step < run.tiles; step++) {
            covered.push(String(run.fromX + dx * step) + "," + String(run.fromY + dy * step));
        }
    }

    return covered;
}

function totalRunTiles(runs: { tiles: number }[]): number {
    let total = 0;

    for (let i = 0; i < runs.length; i++) {
        total += runs[i].tiles;
    }

    return total;
}

/**
 * The arithmetic that replaces the flat tile list.
 *
 * The list existed so the model could answer "is this tile connected" by membership, and
 * it could not do that reliably even with all 31 tiles in front of it. The runs answer the
 * same question by covering every reachable tile exactly once - which makes `sum(run.tiles)
 * === reachableTiles` a check the model can perform on the payload it was handed. If the
 * runs ever stop covering the network exactly, that check goes on passing while the shape
 * silently loses tiles, so it is asserted against the walk itself here.
 */
test("every reachable tile is on exactly one run, so sum(run.tiles) is reachableTiles", function () {
    withPark(function (game) {
        // Forty tiles: the size a park actually is while it still needs connecting up.
        for (let x = 11; x <= 30; x++) {
            game.addPath(x, 10);
        }
    }, function () {
        const paths = readParkStatus().paths;
        const everyTile = Object.keys(walkableFromParkEntrance()).sort();

        assert.equal(everyTile.length, 40, "the main path and its branch are forty tiles");
        assert.equal(paths.reachableTiles, everyTile.length, "and the count agrees with the walk");
        assert.equal(totalRunTiles(paths.runs), paths.reachableTiles,
            "sum(run.tiles) === reachableTiles: the check the model can make on what it was handed");
        assert.deepEqual(tilesOf(paths.runs).sort(), everyTile,
            "every tile the game says guests can reach is on a run, exactly once");
    });
});

test("a network too big for the old listing is still covered exactly, corridor by corridor", function () {
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
        assert.equal(paths.reachableTiles, 400, "the count is of the whole network");
        assert.equal(totalRunTiles(paths.runs), 400,
            "all four hundred are covered - this is where the 250-tile listing had to start thinning out");
        assert.ok(paths.runs.length < 60,
            "and it costs corridors rather than tiles: " + String(paths.runs.length) + " of them");
    });
});

/**
 * The failure the whole report exists for: a ride that is built, has a queue, and that no
 * guest can walk to. The flat list could only ever say which tiles were reachable, so a
 * stranded ride was something the model had to notice by its absence.
 */
test("a ride door on a path the gate cannot reach is named in islands", function () {
    withPark(function (game) {
        // A queue and its ride, out in the corner, joined to nothing.
        game.addPath(25, 25, true, 0);
        game.addPath(25, 26, true, 0);
        game.rides = [ride(0, { x: 25, y: 27, direction: 1 }, null)];
    }, function () {
        const status = readParkStatus();
        const islands = status.paths.islands;

        assert.equal(islands.length, 1, "the queue is a fragment the gate reaches nothing of");
        assert.equal(islands[0].kind, "queue");
        assert.deepEqual(islands[0].rides, [0]);
        assert.deepEqual(islands[0].doors, [{ ride: 0, door: "entrance", x: 25, y: 26 }],
            "the ride is built, it has a queue, and no guest can get to either");
        assert.equal(status.rides[0].guestsCanReach, false, "which is what the ride's own line says too");
    });
});

/**
 * The census is emitted on every turn, so its resolution is a standing cost. Block 32 is
 * the largest a 256-tile map can use and still fit inside MAX_CENSUS_BLOCKS, which is the
 * difference between a complete census and a truncated one on a full-sized map.
 */
test("park_status counts the ground the park owns, in map-aligned blocks", function () {
    withPark(function (game) {
        game.addScenery(15, 15);
        game.own(31, 31, false);
    }, function () {
        const ground = readParkStatus().ground;

        assert.equal(ground.block, 32, "32 a side: a 256-tile map is 64 blocks, which is exactly the cap");
        assert.equal(ground.owned, 32 * 32 - 1, "the one tile sold off is not the park's and is not counted");
        assert.equal(ground.complete, true);
        assert.equal(ground.blocks.length, 1, "a 32-tile park is one block");

        const block = ground.blocks[0];
        const counted = block.clear + block.scenery + block.sloped + block.water + block.path + block.built;

        assert.equal(counted, ground.owned, "the six counts account for every owned tile exactly once");
        assert.equal(block.scenery, 1, "the one tree");
        assert.equal(block.path, 20, "and the twenty tiles of the main path");
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

/**
 * Money is in tenths throughout this codebase: 25 is 2.50. Reported in whole units, every
 * price the model reads is a tenth of what guests are really charged, so a ride it believes
 * costs 0.20 gets "corrected" upwards and the queue empties.
 */
test("a ride's price is reported in the tenths the game holds it in", function () {
    withPark(function (game) {
        game.rides = [ride(0, null, null)];
        game.rides[0].price = [25];
    }, function (game) {
        assert.deepEqual(game.rides[0].price, [25], "the game holds a 2.50 ticket as 25 tenths");
        assert.equal(summary(0).price, game.rides[0].price[0],
            "and park_status reports that number unchanged, not the 2 whole units it rounds to");
    });
});

/**
 * A rating and "no rating yet" are different answers and have to look different.
 *
 * Measured in the running game: a freshly built ride reads excitement -1, intensity 0,
 * nausea 0 and value null, and the same ride once the game has rated it reads excitement
 * 182, intensity 140, value 39. The -1 is RIDE_RATING_UNDEFINED in a signed 16-bit field,
 * which the plugin API hands over raw - `value` is the only one it converts. Reported as a
 * number it reads as a rating of -0.1, and a ride the game has not looked at yet becomes a
 * ride the game hates.
 */
test("a ride the game has not rated reports no ratings rather than the sentinel", function () {
    withPark(function (game) {
        game.rides = [ride(0, null, null)];
        // Exactly what the game holds for a ride it has not rated.
        game.rides[0].excitement = -1;
        game.rides[0].intensity = 0;
        game.rides[0].value = null;
    }, function (game) {
        const held = game.rides[0];

        assert.equal(held.excitement, -1, "the game is holding the undefined-rating sentinel");
        assert.equal(held.value, null, "and no value, because it works one out from the ratings");

        const found = summary(0);

        assert.equal(found.excitement, null, "-1 is not a rating and must not be reported as one");
        assert.equal(found.intensity, null, "and 0 alongside it is not a measurement either");
        assert.equal(found.value, null);
    });
});

test("once the game rates a ride, the ratings it worked out are reported unchanged", function () {
    withPark(function (game) {
        game.rides = [ride(0, null, null)];
        game.rides[0].excitement = -1;
        game.rides[0].intensity = 0;
        game.rides[0].value = null;
        // The numbers the same ride came back with after the game rated it.
        game.rateRide(0, { excitement: 182, intensity: 140, value: 39 });
    }, function (game) {
        const held = game.rides[0];
        const found = summary(0);

        assert.equal(found.excitement, held.excitement, "182, the number the game holds");
        assert.equal(found.intensity, held.intensity);
        assert.equal(found.value, held.value);
        assert.notEqual(found.excitement, null, "a rated ride must not read as an unrated one");
    });
});

test("a rated ride that scored zero is a measurement, not a missing one", function () {
    // The game rates every shop 0.00 across the board, so keying "unrated" off a falsy or
    // low rating would report a rated stall as never measured. Only the sentinel means it.
    withPark(function (game) {
        game.rides = [ride(0, null, null)];
        game.rateRide(0, { excitement: 0, intensity: 0, value: 0 });
    }, function (game) {
        assert.equal(game.rides[0].excitement, 0, "the game holds a real rating of 0.00");

        const found = summary(0);

        assert.equal(found.excitement, 0, "which is a measurement and comes back as the number it is");
        assert.equal(found.intensity, 0);
        assert.equal(found.value, 0);
    });
});

test("a ride the game has only just created has no ratings and no value", function () {
    // Through the game's own ridecreate rather than a literal, so the state under test is
    // the one a build actually leaves behind.
    withPark(function () { /* the ride is created inside the run */ }, function (game) {
        context.executeAction("ridecreate", { rideType: 33, rideObject: 0 }, function () { /* read back */ });
        game.applyQueuedActions();

        assert.equal(game.rides.length, 1, "the fake created the ride");
        assert.equal(game.rides[0].excitement, -1, "and left it unrated, the way the game does");
        assert.equal(game.rides[0].value, null);

        const found = summary(game.rides[0].id);

        assert.equal(found.excitement, null, "so park_status has nothing to report for it");
        assert.equal(found.intensity, null);
        assert.equal(found.value, null);
    });
});

/**
 * `price` and `value` together are the whole diagnosis of an overpriced ride: charge far
 * above what a guest thinks it is worth and they walk past, which looks exactly like a ride
 * nobody can reach. Either field echoing the other makes that diagnosis impossible.
 */
test("a ride's value is its own number and never an echo of its price", function () {
    withPark(function (game) {
        game.rides = [ride(0, null, null)];
        game.rides[0].price = [25];
        game.rides[0].value = 340;
    }, function (game) {
        const held = game.rides[0];

        assert.notEqual(held.price[0], held.value,
            "the two numbers the game holds are different to begin with, or this proves nothing");

        const found = summary(0);

        assert.equal(found.price, held.price[0], "the price is what the ride charges");
        assert.equal(found.value, held.value, "the value is what the game says a guest thinks it is worth");
        assert.notEqual(found.price, found.value, "and they are still two numbers when they come back");
    });
});

/**
 * A ride reporting `totalCustomers: 0` reads as a ride nobody can get to, and that is what
 * the model acts on: it rebuilds paths to a ride that has served customers all month.
 */
test("totalCustomers and totalProfit are read off the ride, not reported as nobody and nothing", function () {
    withPark(function (game) {
        game.rides = [ride(0, null, null)];
        game.rides[0].totalCustomers = 137;
        game.rides[0].totalProfit = 4210;
    }, function (game) {
        const held = game.rides[0];
        const found = summary(0);

        assert.equal(found.totalCustomers, held.totalCustomers, "137 guests have ridden it and it has to say so");
        assert.equal(found.totalProfit, held.totalProfit, "the takings are their own field, not the head count");
        assert.notEqual(found.totalCustomers, 0,
            "a hard-coded zero here is indistinguishable from a ride no guest can reach");
    });
});

/** The one number that says a queue is too long. Hard-coded to 0, no queue is ever too long. */
test("the queue time comes off the station the game holds", function () {
    withPark(function (game) {
        for (let x = 11; x <= 15; x++) {
            game.addPath(x, 10, true, 0);
        }

        game.rides = [ride(0, { x: 16, y: 10, direction: 2 }, null)];
        game.rides[0].stations[0].queueTime = 23;
    }, function (game) {
        const station = game.rides[0].stations[0];

        assert.equal(station.queueTime, 23, "the game holds a twenty-three minute wait on the station");

        const found = summary(0);

        assert.equal(found.queueTime, station.queueTime, "and park_status reports the station's own number");
        assert.equal(found.guestsCanReach, true, "on a ride guests really can queue for");
    });
});

/**
 * Happiness is out of 255 and cash is per guest, so a sum reads as a plausible number rather
 * than as an obvious fault - and every existing guest test uses a crowd of identical guests,
 * where a sum and a mean cannot be told apart.
 */
test("average happiness and average cash are means of the sample, not sums of it", function () {
    withPark(function (game) {
        game.addGuest({ happiness: 100, cash: 0 });
        game.addGuest({ happiness: 200, cash: 1000 });
    }, function (game) {
        const held = game.guests;

        assert.deepEqual(held.map(function (guest) { return guest.happiness; }), [100, 200],
            "two guests, deliberately unequal: identical guests make a sum look like a mean");

        let happiness = 0;
        let cash = 0;

        for (let i = 0; i < held.length; i++) {
            happiness += held[i].happiness;
            cash += held[i].cash;
        }

        const feedback = readGuestFeedback(100);

        assert.equal(feedback.sampled, held.length, "both guests in the park were read");
        assert.equal(feedback.averageHappiness, happiness / held.length,
            "happiness is the average of the two, 150, and not their sum");
        assert.equal(feedback.averageCash, cash / held.length, "and cash carried is an average too");
        assert.ok(feedback.averageHappiness <= 255,
            "happiness is out of 255, so a sum runs off the top of the scale it is reported on");
    });
});

/**
 * Eight park-wide figures, all read from `park` in one object literal, and none of them
 * asserted anywhere. Rating is out of 999 and guests is a head count: swap those two and the
 * model reads a park of 42 guests as a park in serious rating trouble, or the reverse.
 */
test("each park-wide figure comes from its own field", function () {
    withPark(function (game) {
        // All different, so any field carrying another's value shows up as a mismatch.
        game.parkValues.rating = 850;
        game.parkValues.guests = 42;
        game.parkValues.cash = 123456;
        game.parkValues.bankLoan = 7000;
        game.parkValues.maxBankLoan = 250000;
        game.parkValues.suggestedGuestMaximum = 333;
        game.parkValues.companyValue = 98765;
        game.parkValues.entranceFee = 15;
    }, function (game) {
        const held = game.parkValues;
        const status = readParkStatus();

        assert.deepEqual(
            {
                rating: status.rating, guests: status.guests, cash: status.cash,
                bankLoan: status.bankLoan, maxBankLoan: status.maxBankLoan,
                suggestedGuestMaximum: status.suggestedGuestMaximum,
                companyValue: status.companyValue, entranceFee: status.entranceFee
            },
            {
                rating: held.rating, guests: held.guests, cash: held.cash,
                bankLoan: held.bankLoan, maxBankLoan: held.maxBankLoan,
                suggestedGuestMaximum: held.suggestedGuestMaximum,
                companyValue: held.companyValue, entranceFee: held.entranceFee
            },
            "every figure is the one the park holds under that same name");
        assert.notEqual(status.rating, status.guests,
            "the rating out of 999 and the head count are never the same number here");
    });
});

/**
 * Stopping the clock is the one mistake that hides itself. A paused park reads back exactly
 * as it did last turn - same date, same guests, same rides, same cash - so without a field
 * saying so, a model that paused has nothing to notice, and a run can sit frozen to the end
 * of the scenario. Both values are read off `context` each time rather than remembered from
 * whatever set_game_speed was last asked for, which is what makes them true after a pause
 * from anywhere else.
 */
test("park_status reports the speed setting and whether the clock is stopped", function () {
    withPark(function () { /* the fake starts at speed 1, running */ }, function (game) {
        const running = readParkStatus();

        assert.deepEqual(
            { speed: running.speed, paused: running.paused },
            { speed: 1, paused: false },
            "a running park reports its speed setting and a clear pause flag");

        game.gameValues.speed = 4;
        game.gameValues.paused = true;

        const stopped = readParkStatus();

        assert.deepEqual(
            { speed: stopped.speed, paused: stopped.paused },
            { speed: 4, paused: true },
            "and both come from the game as it stands, not from anything park_status kept");
        assert.equal(stopped.date.day, running.date.day,
            "nothing else in the status moved, which is exactly why `paused` has to be there");
    });
});

/**
 * The rule `status.ts` and `build.ts` both exist to keep: a stall is served from ONE tile,
 * the neighbour on the side it faces, and `shopServingTile` is the single answer to which.
 * build.test.ts pins a path against the back wall; this pins the near miss the loose
 * any-neighbour rule also accepts - a path that stops one tile beyond the counter, touching
 * it but not standing on it. The model is told to run build_path to `counter`, so a stall
 * reported reachable from a tile that is not the counter is a fix it never makes.
 */
test("a stall is judged by its counter tile, not by a neighbour of the counter", function () {
    withPark(function (game) {
        // Rotation 2 faces +x, so the counter is 12,10 and nowhere else.
        stall(game, 0, 11, 10, 2);
        // Path guests can walk to that reaches 13,10 - the far side of the counter - taking
        // the long way round so that nothing on the route stands on 12,10 itself.
        game.addPath(11, 12);
        game.addPath(12, 12);
        game.addPath(13, 12);
        game.addPath(13, 11);
        game.addPath(13, 10);
    }, function (game) {
        const walkable = walkableFromParkEntrance();

        assert.equal(hasPath(game, 12, 10), false, "the counter itself is bare ground");
        assert.equal(tileIsWalkable(walkable, { x: 12, y: 10 }), false, "so no guest stands on it");
        assert.equal(tileIsWalkable(walkable, { x: 13, y: 10 }), true,
            "while the tile just past it is joined to the park and full of guests");

        const found = summary(0);

        assert.deepEqual(found.counter, { x: 12, y: 10 }, "the counter is the neighbour its rotation points at");
        assert.equal(found.guestsCanReach, false,
            "a path beside the counter is not a path on it: guests walk past and buy nothing");

        // Standing on the counter itself is what serves it.
        game.addPath(12, 10);

        assert.equal(tileIsWalkable(walkableFromParkEntrance(), { x: 12, y: 10 }), true,
            "the counter tile now carries path joined to the network");

        const served = summary(0);

        assert.deepEqual(served.counter, { x: 12, y: 10 }, "the counter has not moved");
        assert.equal(served.guestsCanReach, true, "and only now is the stall served");
    });
});

test("a stall's fix names the counter tile without arguing against rebuilding", function () {
    // docs/tool-design.md: `counter` being the tile a path has to reach is the game's
    // geometry. Whether to path to it or tear the stall down and rebuild it facing the
    // other way is park design - and rebuilding is right when the counter tile is unowned
    // or sloped, which the description was talking the model out of.
    const definitions = getMcpToolDefinitions(StatusTools).filter(function (definition) {
        return definition.handlerName === "parkStatus";
    });

    assert.equal(definitions.length, 1, "park_status is registered once");

    const text = String(definitions[0].description);

    assert.match(text, /`counter` is the tile build_path has to reach/, "the mechanic and the call stay");
    assert.doesNotMatch(text, /rather than rebuilding/,
        "which of the two fixes to use is the model's decision");
});

test("`price` against `value` is stated as a symptom, not as a price to charge", function () {
    // Kept deliberately: an overpriced ride and an unreachable one both show
    // `totalCustomers: 0`, so this sentence separates two causes of one symptom. That is
    // perception. It stops short of saying what to charge.
    const definitions = getMcpToolDefinitions(StatusTools).filter(function (definition) {
        return definition.handlerName === "parkStatus";
    });

    const text = String(definitions[0].description);

    assert.match(text, /Price well above it and they walk past/);
    assert.match(text, /looks exactly like a ride nobody can reach/, "the two causes it separates");
    assert.doesNotMatch(text, /\bshould\b|\brecommend|\badvis/i, "and no instruction on what to charge");
});

test("the description says a null rating is a measurement that has not been taken yet", function () {
    // Without it, a model that sees null where it expected a number reads the tool as broken
    // and goes looking for the rating somewhere else. When ratings appear is a rule of the
    // game it cannot read anywhere: they arrive a little after the ride opens with guests
    // able to reach it.
    const definitions = getMcpToolDefinitions(StatusTools).filter(function (definition) {
        return definition.handlerName === "parkStatus";
    });

    const text = String(definitions[0].description);

    assert.match(text, /null until the ride has been rated/, "which fields are null and when");
    assert.match(text, /after it opens/, "and when the rating turns up");
    assert.match(text, /has not measured the ride yet/,
        "null is the absence of a measurement, not a low one");
});

/**
 * The description has to describe the shape that is actually in the payload. It described
 * a flat tile list for as long as one was sent, and the one thing that list could not say -
 * which of the reachable tiles are queues - is a fact two build_path calls failed for want
 * of. It is a measurement throughout: which run to use and which island to repair are the
 * model's to decide.
 */
test("park_status describes the network it now sends, and recommends nothing about it", function () {
    const definitions = getMcpToolDefinitions(StatusTools).filter(function (definition) {
        return definition.handlerName === "parkStatus";
    });

    const text = String(definitions[0].description);

    assert.doesNotMatch(text, /reachableSample/,
        "the flat tile list is gone from the payload, so describing one sends the model looking for it");
    assert.match(text, /`runs` is every one\s+of those tiles, as straight lines/, "what a run is");
    assert.match(text, /a `kind` of `path` or `queue`/,
        "which tiles are queue: the fact the tile list could not carry, and two build_path calls failed on");
    assert.match(text, /the `tiles` add up to `reachableTiles`/,
        "the arithmetic that makes the shape checkable");
    assert.match(text, /a tile is reachable exactly\s+when a run covers it/,
        "and the membership rule the flat list used to answer");
    assert.match(text, /`severingComputed` false means that was not worked out at all, which is\s+not the same as nothing severing/,
        "a missing figure must never read as a zero");
    assert.match(text, /`islands` are stretches of path the gate reaches none of/, "and what an island is");
    assert.match(text, /a door there belongs to a ride that is built\s+and that no guest can walk to/,
        "which is the whole failure the report exists to name");
    assert.match(text, /`ground` counts owned land per map-aligned block/, "the census");
    assert.match(text, /six add up to `owned`/, "and its own arithmetic");

    assert.doesNotMatch(text, /\bshould\b|\brecommend|\badvis|\bfirst\b|\bprefer/i,
        "which run to join, where to build and which island to repair are the model's decisions");
});

/**
 * `guestsCanReach` no longer asks for a queue - it is the entrance door tile being walkable
 * from the gate - which leaves `hasQueue` meaning exactly one thing, and the description
 * never said what. Without a bound queue `PeepInteractWithEntrance` still puts a guest who
 * walks up on ordinary path into queuing state, and `shouldGoOnRide` with `atQueue` false
 * turns away anyone arriving while that guest is still there: one at a time. One run took 3
 * customers on a ride with no queue against 16 on one with a queue.
 */
test("`hasQueue` is described as throughput, which is now the only thing it says", function () {
    const definitions = getMcpToolDefinitions(StatusTools).filter(function (definition) {
        return definition.handlerName === "parkStatus";
    });

    assert.equal(definitions.length, 1, "park_status is registered once");

    const text = String(definitions[0].description);

    assert.match(text, /`hasQueue` is throughput, not reachability/,
        "the field's one meaning, stated where the model reads it every turn");
    assert.match(text, /without one a ride boards one guest at a time/,
        "what a ride with no queue still does, so an absent queue is not an absent ride");
    assert.match(text, /a bound queue lets several wait at once/, "and what binding one buys");
    assert.match(text, /`guestsCanReach` is separate/,
        "the two fields answer different questions and always did");
});

/**
 * A run's severance is a count of what a ride's entrance claim would cost. Laying the queue
 * is not what does it: a queue no ride owns changed no edge bit in the running game, so the
 * trailing clause was naming the wrong action for a real number.
 */
test("`cutsIfBlocked` names the entrance claim as what stops a tile carrying traffic", function () {
    const definitions = getMcpToolDefinitions(StatusTools).filter(function (definition) {
        return definition.handlerName === "parkStatus";
    });

    const text = String(definitions[0].description);

    assert.match(text, /which is what a ride's entrance claiming a queue there does/,
        "the action that actually severs an edge");
    assert.doesNotMatch(text, /which is what laying a queue on it does/,
        "laying one severs nothing; a ride owning the line is what does");
    assert.doesNotMatch(text, /cannot walk through/,
        "and the rule behind the old clause, which the game does not implement");
});
