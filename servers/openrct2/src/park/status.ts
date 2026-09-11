import { flatRideShape, shopServingTile } from "./flatRides.js";
import { DIRECTION_VECTORS } from "./map.js";
import { findParkEntranceTiles, tileIsWalkable, walkableFromParkEntrance } from "./paths.js";

/** Bit positions in Ride.flags, from OpenRCT2's RideFlag enum. */
const RIDE_FLAG_BROKEN_DOWN = 1 << 7;
const RIDE_FLAG_QUEUE_FULL = 1 << 9;
const RIDE_FLAG_CRASHED = 1 << 10;

/**
 * RIDE_RATING_UNDEFINED, the game's own "this ride has not been rated yet".
 *
 * It is a sentinel stored in a signed 16-bit field, and the plugin API hands the ratings
 * over raw, so it arrives as -1 and reads exactly like a rating of -0.1. `value` is the
 * one the API does convert, to null, and it converts it because the game refuses to work
 * a value out for a ride with no ratings - the two are set by the same step. Nothing on
 * `Ride` marks the ride as rated, and `intensity` and `nausea` sit at 0 until it is
 * (measured: a fresh build reads excitement -1, intensity 0, nausea 0), so neither of
 * them can tell an unrated ride from a genuinely dull one. This is the test the game
 * itself uses, against the one field that carries the sentinel.
 */
const RIDE_RATING_UNDEFINED = -1;

/**
 * Every stream in the game's own ExpenditureType. All of them, because the sum is
 * reported as net profit: leaving construction and land out of it showed a month in
 * profit that the game's own finance graph showed in the red.
 */
const EXPENDITURE_STREAMS: ExpenditureType[] = [
    "ride_construction", "ride_runningcosts", "land_purchase", "landscaping",
    "park_entrance_tickets", "park_ride_tickets", "shop_sales", "shop_stock",
    "food_drink_sales", "food_drink_stock", "wages", "marketing", "research", "interest"
];

/**
 * How many reachable path tiles `paths.reachableSample` will list in full.
 *
 * A park that still needs connecting up has tens of path tiles, so this reports the
 * whole network and the model can see where it actually ends. Past this it is a spread,
 * and `reachableSampleComplete` says so: a mature park's network would otherwise cost
 * a few thousand tokens of every single turn.
 */
const MAX_REPORTED_PATH_TILES = 250;

export interface RideSummary {
    id: number;
    name: string;
    status: string;
    /** Fixed-point: 652 means 6.52. Null until the ride has been rated. */
    excitement: number | null;
    intensity: number | null;
    price: number;
    /** What the ride is worth to a guest. Charge far above this and they refuse to ride.
     *  Null until the ride has been rated, which is when the game works it out. */
    value: number | null;
    totalCustomers: number;
    totalProfit: number;
    queueTime: number;
    /** Shops and stalls: no entrance, no exit, no queue. Guests buy from the path beside them. */
    isShop: boolean;
    /** A queue is bound to the entrance. Necessary, but on its own it proves nothing. Null for a shop. */
    hasQueue: boolean | null;
    /**
     * Guests can get to this ride from the park entrance: for a ride, a queue bound to it
     * reaches its door; for a shop, a path they can walk to reaches `counter`. The one
     * that matters.
     */
    guestsCanReach: boolean;
    /**
     * Shops and stalls: the single tile guests buy over the counter from, the neighbour on
     * the side the stall faces. A path on any other side touches its wall and serves
     * nobody, so this is the tile to aim build_path at. Null for anything with a door.
     */
    counter: { x: number; y: number } | null;
    /** A path leads away from the exit, back to the rest of the park. Null for a shop. */
    exitConnected: boolean | null;
    /** The entrance building. Guests do not stand here: `entranceDoor` is the tile they use. */
    entrance: { x: number; y: number } | null;
    exit: { x: number; y: number } | null;
    /** The tile the entrance door opens onto — the one tile a queue must occupy. Null for a shop. */
    entranceDoor: { x: number; y: number } | null;
    /** The tile the exit door opens onto, which a path back into the park must reach. Null for a shop. */
    exitDoor: { x: number; y: number } | null;
    downtime: number;
    reliability: number;
    /** Broken down right now. It earns nothing until a mechanic reaches it. */
    brokenDown: boolean;
    crashed: boolean;
    queueFull: boolean;
}

export interface PathNetwork {
    /** Tiles of the park entrance itself. Guests enter here. */
    entrance: { x: number; y: number }[];
    /** How many path tiles guests can actually walk to from the entrance. */
    reachableTiles: number;
    /** Those tiles, as targets for build_path. Every one of them unless the network is huge. */
    reachableSample: { x: number; y: number }[];
    /**
     * True when `reachableSample` is every reachable tile, so a tile missing from it is
     * genuinely not connected. False means it is a spread of a larger network and
     * `reachableTiles` is the real count.
     */
    reachableSampleComplete: boolean;
}

export interface ParkStatus {
    scenario: { name: string; objective: object; status: string };
    /** Where guests come in, and which paths they can reach. Paths must join this. */
    paths: PathNetwork;
    parkOpen: boolean;
    date: { year: number; month: number; day: number };
    /**
     * The game's own speed setting, 1 to 4, and whether the clock is stopped. Nothing else
     * reported either, so a paused game looked exactly like a running one that nothing was
     * happening in: the date, the guest count and every ride read back unchanged turn after
     * turn with no field saying why.
     */
    speed: number;
    paused: boolean;
    cash: number;
    bankLoan: number;
    maxBankLoan: number;
    rating: number;
    guests: number;
    suggestedGuestMaximum: number;
    entranceFee: number;
    companyValue: number;
    /** Net profit for the last four months, index 0 is this month. */
    monthlyProfit: number[];
    staff: Record<string, number>;
    /** The game's own notifications, newest last. It names problems before you find them. */
    messages: string[];
    rides: RideSummary[];
}

/** The tile a door opens onto: one step further out than the building itself. */
function doorTile(access: CoordsXYZD): { x: number; y: number } {
    const towardsRide = DIRECTION_VECTORS[access.direction % 4];
    return { x: access.x / 32 - towardsRide.dx, y: access.y / 32 - towardsRide.dy };
}

/**
 * Which way a built stall faces, read off its own track element.
 *
 * Nothing else on a `Ride` records it: the rotation a stall was placed at survives only as
 * the `direction` the game stored on the track. No track on the tile means no stall on the
 * ground, and null rather than a guessed facing.
 */
function shopRotation(x: number, y: number, rideId: number): number | null {
    const tile = map.getTile(x, y);

    for (let i = 0; i < tile.numElements; i++) {
        const element = tile.getElement(i);

        if (element.type !== "track") {
            continue;
        }

        const track = element as TrackElement;

        if (track.ride === rideId) {
            return track.direction;
        }
    }

    return null;
}

/**
 * The one tile a stall is served from: its neighbour in the direction it faces, which is
 * what `shopServingTile` answers for find_build_sites and build_flat_ride as well.
 *
 * Measured in the running game, not reasoned: a rotation-1 stall at 56,33 was ringed with
 * footpath on all four sides and only the tile on its facing side formed a footpath edge
 * to it. A path on one of the other three touches its wall and serves nobody, so counting
 * any of the four neighbours reported a stall as working when no guest could buy from it.
 */
function shopCounterTile(start: CoordsXYZ | null, rideId: number): { x: number; y: number } | null {
    if (!start) {
        return null;
    }

    const x = start.x / 32;
    const y = start.y / 32;
    const rotation = shopRotation(x, y, rideId);

    return rotation === null ? null : shopServingTile(x, y, rotation);
}

function queueServes(entrance: CoordsXYZD | null, rideId: number): boolean {
    if (!entrance) {
        return false;
    }

    const directions = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];
    const ex = entrance.x / 32;
    const ey = entrance.y / 32;

    for (let i = 0; i < directions.length; i++) {
        const tile = map.getTile(ex + directions[i].dx, ey + directions[i].dy);

        for (let e = 0; e < tile.numElements; e++) {
            const element = tile.getElement(e);

            if (element.type !== "footpath") {
                continue;
            }

            const path = element as FootpathElement;

            if (path.isQueue && path.ride === rideId) {
                return true;
            }
        }
    }

    return false;
}

/** The last few park notifications, most recent last. */
function recentMessages(count: number): string[] {
    const all = park.messages;
    const start = Math.max(0, all.length - count);
    const out: string[] = [];

    for (let i = start; i < all.length; i++) {
        // Messages carry colour and layout codes like {RED} and {NEWLINE}: noise to a reader.
        out.push(all[i].text.replace(/\{[A-Z_]+\}/g, " ").replace(/\s+/g, " ").trim());
    }

    return out;
}

export function readParkStatus(): ParkStatus {
    const staff: Record<string, number> = { handyman: 0, mechanic: 0, security: 0, entertainer: 0 };
    const allStaff = map.getAllEntities("staff");

    for (let i = 0; i < allStaff.length; i++) {
        const type = allStaff[i].staffType;
        staff[type] = (staff[type] || 0) + 1;
    }

    const walkableNow = walkableFromParkEntrance();

    const rides: RideSummary[] = map.rides.map(function (ride) {
        const station = ride.stations.length > 0 ? ride.stations[0] : undefined;
        const entrance = station && station.entrance ? station.entrance : null;
        const exit = station && station.exit ? station.exit : null;
        const entranceDoor = entrance ? doorTile(entrance) : null;
        const exitDoor = exit ? doorTile(exit) : null;
        const shape = flatRideShape(ride.type);
        const isShop = typeof shape !== "undefined" && shape.isShop;
        // A shop with no entrance is served off the path; anything with a door is judged by it.
        const overTheCounter = isShop && entrance === null;
        const counter = overTheCounter
            ? shopCounterTile(station ? station.start : null, ride.id)
            : null;
        // A rated ride can legitimately score zero - the game rates every shop 0.00 - so
        // only the sentinel separates "not measured yet" from "measured and low".
        const rated = ride.excitement !== RIDE_RATING_UNDEFINED;

        return {
            id: ride.id,
            name: ride.name,
            status: ride.status,
            excitement: rated ? ride.excitement : null,
            intensity: rated ? ride.intensity : null,
            price: ride.price.length > 0 ? ride.price[0] : 0,
            // Already null from the API when the game has not worked one out. Passed through.
            value: ride.value,
            totalCustomers: ride.totalCustomers,
            totalProfit: ride.totalProfit,
            queueTime: station ? station.queueTime : 0,
            isShop: isShop,
            hasQueue: overTheCounter ? null : queueServes(entrance, ride.id),
            guestsCanReach: overTheCounter
                ? counter !== null && tileIsWalkable(walkableNow, counter)
                : entranceDoor !== null
                    && queueServes(entrance, ride.id)
                    && tileIsWalkable(walkableNow, entranceDoor),
            counter: counter,
            exitConnected: overTheCounter
                ? null
                : exitDoor !== null && tileIsWalkable(walkableNow, exitDoor),
            entrance: entrance ? { x: entrance.x / 32, y: entrance.y / 32 } : null,
            exit: exit ? { x: exit.x / 32, y: exit.y / 32 } : null,
            entranceDoor: entranceDoor,
            exitDoor: exitDoor,
            downtime: ride.downtime,
            reliability: ride.reliability,
            brokenDown: (ride.flags & RIDE_FLAG_BROKEN_DOWN) !== 0,
            crashed: (ride.flags & RIDE_FLAG_CRASHED) !== 0,
            queueFull: (ride.flags & RIDE_FLAG_QUEUE_FULL) !== 0
        };
    });

    // Expenditure comes back signed, so summing the streams gives net profit per month.
    const profit: number[] = [0, 0, 0, 0];

    for (let s = 0; s < EXPENDITURE_STREAMS.length; s++) {
        const months = park.getMonthlyExpenditure(EXPENDITURE_STREAMS[s]);

        for (let i = 0; i < profit.length && i < months.length; i++) {
            profit[i] += months[i] || 0;
        }
    }

    const reachableKeys = Object.keys(walkableNow);
    const sample: { x: number; y: number }[] = [];
    const complete = reachableKeys.length <= MAX_REPORTED_PATH_TILES;
    const stride = complete ? 1 : Math.ceil(reachableKeys.length / MAX_REPORTED_PATH_TILES);

    for (let i = 0; i < reachableKeys.length; i += stride) {
        const parts = reachableKeys[i].split(",");
        sample.push({ x: Number(parts[0]), y: Number(parts[1]) });
    }

    return {
        scenario: { name: scenario.name, objective: scenario.objective, status: scenario.status },
        paths: {
            entrance: findParkEntranceTiles(),
            reachableTiles: reachableKeys.length,
            reachableSample: sample,
            reachableSampleComplete: complete
        },
        parkOpen: park.getFlag("open"),
        date: { year: date.year, month: date.month, day: date.day },
        speed: typeof context.gameSpeed === "number" ? context.gameSpeed : 0,
        paused: context.paused === true,
        cash: park.cash,
        bankLoan: park.bankLoan,
        maxBankLoan: park.maxBankLoan,
        rating: park.rating,
        guests: park.guests,
        suggestedGuestMaximum: park.suggestedGuestMaximum,
        entranceFee: park.entranceFee,
        companyValue: park.companyValue,
        monthlyProfit: profit,
        staff: staff,
        messages: recentMessages(12),
        rides: rides
    };
}

export interface GuestFeedback {
    /** Guests in the park. */
    guests: number;
    /** How many of them these counts came from. */
    sampled: number;
    /** Every thought guests are having, most common first. */
    thoughts: { thought: string; count: number }[];
    averageHappiness: number;
    averageCash: number;
}

export function readGuestFeedback(sampleSize: number): GuestFeedback {
    const guests = map.getAllEntities("guest");
    const counts: Record<string, number> = {};
    let happiness = 0;
    let cash = 0;
    let sampled = 0;

    for (let i = 0; i < guests.length && sampled < sampleSize; i++) {
        const guest = guests[i];
        sampled++;
        happiness += guest.happiness;
        cash += guest.cash;

        const thoughts = guest.thoughts;

        for (let t = 0; t < thoughts.length; t++) {
            const type = thoughts[t].type;
            counts[type] = (counts[type] || 0) + 1;
        }
    }

    const ordered: { thought: string; count: number }[] = [];
    Object.keys(counts).forEach(function (thought) {
        ordered.push({ thought: thought, count: counts[thought] });
    });
    ordered.sort(function (left, right) {
        return right.count - left.count;
    });

    return {
        guests: guests.length,
        sampled: sampled,
        thoughts: ordered,
        averageHappiness: sampled > 0 ? Math.round(happiness / sampled) : 0,
        averageCash: sampled > 0 ? Math.round(cash / sampled) : 0
    };
}

export interface RideObjectInfo {
    index: number;
    name: string;
    rideType: number;
    /** Flat rides go up in one action with build_flat_ride. */
    isFlatRide: boolean;
    footprint: string | null;
}

export function listRideObjects(): RideObjectInfo[] {
    return context.getAllObjects("ride").map(function (object) {
        const rideType = object.rideType[0];
        const shape = flatRideShape(rideType);

        return {
            index: object.index,
            name: object.name,
            rideType: rideType,
            isFlatRide: typeof shape !== "undefined",
            footprint: typeof shape === "undefined" ? null : String(shape.width) + "x" + String(shape.depth)
        };
    });
}
