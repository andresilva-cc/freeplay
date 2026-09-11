import { flatRideShape } from "./flatRides.js";
import { findParkEntranceTiles, walkableFromParkEntrance } from "./paths.js";

/** Bit positions in Ride.flags, from OpenRCT2's RideFlag enum. */
const RIDE_FLAG_BROKEN_DOWN = 1 << 7;
const RIDE_FLAG_QUEUE_FULL = 1 << 9;
const RIDE_FLAG_CRASHED = 1 << 10;

export interface RideSummary {
    id: number;
    name: string;
    status: string;
    /** Fixed-point: 652 means 6.52. -1 means not yet rated. */
    excitement: number;
    intensity: number;
    price: number;
    /** What the ride is worth to a guest. Charge far above this and they refuse to ride. */
    value: number;
    totalCustomers: number;
    totalProfit: number;
    queueTime: number;
    /** Whether a queue is bound to the entrance. Without one, guests never board. */
    hasQueue: boolean;
    entrance: { x: number; y: number } | null;
    exit: { x: number; y: number } | null;
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
    /** A spread of those tiles, as targets for build_path. */
    reachableSample: { x: number; y: number }[];
}

export interface ParkStatus {
    scenario: { name: string; objective: object; status: string };
    /** Where guests come in, and which paths they can reach. Paths must join this. */
    paths: PathNetwork;
    parkOpen: boolean;
    date: { year: number; month: number; day: number };
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

    const rides: RideSummary[] = map.rides.map(function (ride) {
        const station = ride.stations.length > 0 ? ride.stations[0] : undefined;
        const entrance = station && station.entrance ? station.entrance : null;
        const exit = station && station.exit ? station.exit : null;

        return {
            id: ride.id,
            name: ride.name,
            status: ride.status,
            excitement: ride.excitement,
            intensity: ride.intensity,
            price: ride.price.length > 0 ? ride.price[0] : 0,
            value: ride.value,
            totalCustomers: ride.totalCustomers,
            totalProfit: ride.totalProfit,
            queueTime: station ? station.queueTime : 0,
            hasQueue: queueServes(entrance, ride.id),
            entrance: entrance ? { x: entrance.x / 32, y: entrance.y / 32 } : null,
            exit: exit ? { x: exit.x / 32, y: exit.y / 32 } : null,
            downtime: ride.downtime,
            reliability: ride.reliability,
            brokenDown: (ride.flags & RIDE_FLAG_BROKEN_DOWN) !== 0,
            crashed: (ride.flags & RIDE_FLAG_CRASHED) !== 0,
            queueFull: (ride.flags & RIDE_FLAG_QUEUE_FULL) !== 0
        };
    });

    // Expenditure comes back signed, so summing the streams gives net profit per month.
    const streams: ExpenditureType[] = [
        "park_entrance_tickets", "park_ride_tickets", "shop_sales", "shop_stock",
        "food_drink_sales", "food_drink_stock", "ride_runningcosts", "wages",
        "marketing", "research", "interest"
    ];
    const profit: number[] = [0, 0, 0, 0];

    for (let s = 0; s < streams.length; s++) {
        const months = park.getMonthlyExpenditure(streams[s]);

        for (let i = 0; i < profit.length && i < months.length; i++) {
            profit[i] += months[i] || 0;
        }
    }

    const walkable = walkableFromParkEntrance();
    const reachableKeys = Object.keys(walkable);
    const sample: { x: number; y: number }[] = [];
    const stride = Math.max(1, Math.floor(reachableKeys.length / 12));

    for (let i = 0; i < reachableKeys.length; i += stride) {
        const parts = reachableKeys[i].split(",");
        sample.push({ x: Number(parts[0]), y: Number(parts[1]) });
    }

    return {
        scenario: { name: scenario.name, objective: scenario.objective, status: scenario.status },
        paths: {
            entrance: findParkEntranceTiles(),
            reachableTiles: reachableKeys.length,
            reachableSample: sample
        },
        parkOpen: park.getFlag("open"),
        date: { year: date.year, month: date.month, day: date.day },
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
    guests: number;
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
