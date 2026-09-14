import { currentDayNumber, dayNumberFromElapsedMonths } from "../gameClock.js";
import { pauseRefusesActions } from "../clockGate.js";
import { flatRideShape, shopServingTile } from "./flatRides.js";
import { DIRECTION_VECTORS } from "./map.js";
import { DEFAULT_CENSUS_BLOCK, readGroundCensus, readPathNetwork } from "./network.js";
import type { GroundCensus, PathNetworkShape } from "./network.js";
import { rideObjectResearched } from "./research.js";
import { tileIsWalkable, walkableFromParkEntrance } from "./paths.js";
import type { Tile } from "./paths.js";

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
 * Every stream in the game's own ExpenditureType, in the order the game declares them.
 *
 * All of them, because the sum is reported as net profit: leaving construction and land out
 * of it showed a month in profit that the game's own finance graph showed in the red. Each
 * is also reported on its own line, because the sum alone cannot tell a park bleeding wages
 * from one bleeding ride upkeep, and a person reading the Finances window sees the lines.
 */
const EXPENDITURE_STREAMS: ExpenditureType[] = [
    "ride_construction", "ride_runningcosts", "land_purchase", "landscaping",
    "park_entrance_tickets", "park_ride_tickets", "shop_sales", "shop_stock",
    "food_drink_sales", "food_drink_stock", "wages", "marketing", "research", "interest"
];

/**
 * OpenRCT2's own PeepThoughtType, in declaration order, as the plugin API's `ThoughtType`
 * union lists it. This is the order `guest_feedback` reports thoughts in.
 *
 * It is here to be an order that says nothing. The counts used to be sorted by size, which
 * put the park's commonest complaint at the top of the list and made the reading of them -
 * which problem is worth acting on - a thing this tool had already done. The game keeps no
 * such histogram and shows no such list: a person reads thought bubbles one guest at a time
 * and forms their own view. So the rows come back in the game's own enumeration order,
 * which is arbitrary with respect to anything a park could want, and stable from call to
 * call so two reads can be compared. The counts stay, because a count is a measurement.
 *
 * A type the game reports that is not listed here is still reported, after these, in the
 * order it was read. Nothing is dropped for being unrecognised.
 */
const THOUGHT_TYPE_ORDER: string[] = [
    "cant_afford_ride", "spent_money", "sick", "very_sick", "more_thrilling", "intense",
    "havent_finished", "sickening", "bad_value", "go_home", "good_value", "already_got",
    "cant_afford_item", "not_hungry", "not_thirsty", "drowning", "lost", "was_great",
    "queuing_ages", "tired", "hungry", "thirsty", "toilet", "cant_find", "not_paying",
    "not_while_raining", "bad_litter", "cant_find_exit", "get_off", "get_out", "not_safe",
    "path_disgusting", "crowded", "vandalism", "scenery", "very_clean", "fountains", "music",
    "balloon", "toy", "map", "photo", "umbrella", "drink", "burger", "chips", "ice_cream",
    "candyfloss", "pizza", "popcorn", "hot_dog", "tentacle", "hat", "toffee_apple", "tshirt",
    "doughnut", "coffee", "chicken", "lemonade", "wow", "wow2", "watched", "balloon_much",
    "toy_much", "map_much", "photo_much", "umbrella_much", "drink_much", "burger_much",
    "chips_much", "ice_cream_much", "candyfloss_much", "pizza_much", "popcorn_much",
    "hot_dog_much", "tentacle_much", "hat_much", "toffee_apple_much", "tshirt_much",
    "doughnut_much", "coffee_much", "chicken_much", "lemonade_much", "photo2", "photo3",
    "photo4", "pretzel", "hot_chocolate", "iced_tea", "funnel_cake", "sunglasses",
    "beef_noodles", "fried_rice_noodles", "wonton_soup", "meatball_soup", "fruit_juice",
    "soybean_milk", "sujongkwa", "sub_sandwich", "cookie", "roast_sausage", "photo2_much",
    "photo3_much", "photo4_much", "pretzel_much", "hot_chocolate_much", "iced_tea_much",
    "funnel_cake_much", "sunglasses_much", "beef_noodles_much", "fried_rice_noodles_much",
    "wonton_soup_much", "meatball_soup_much", "fruit_juice_much", "soybean_milk_much",
    "sujongkwa_much", "sub_sandwich_much", "cookie_much", "roast_sausage_much", "help",
    "running_out", "new_ride", "nice_ride_deprecated", "excited_deprecated", "here_we_are"
];

/** Where each thought type sits in `THOUGHT_TYPE_ORDER`, built once. */
const THOUGHT_TYPE_RANK: Record<string, number> = (function () {
    const rank: Record<string, number> = {};

    for (let i = 0; i < THOUGHT_TYPE_ORDER.length; i++) {
        rank[THOUGHT_TYPE_ORDER[i]] = i;
    }

    return rank;
})();

export interface RideSummary {
    id: number;
    name: string;
    status: string;
    /** Fixed-point: 652 means 6.52. Null until the ride has been rated. */
    excitement: number | null;
    intensity: number | null;
    /**
     * The third of the three numbers the game works out together and shows together in the
     * ride window. It was the one missing here, and it is not a spare: nausea is what sends
     * guests looking for a bin or a toilet and leaves the mess a handyman then has to sweep,
     * so a park with a queue of sick guests reads exactly like a healthy one without it.
     * Null until the ride has been rated, on the same test as the other two.
     */
    nausea: number | null;
    price: number;
    /** What the ride is worth to a guest. Charge far above this and they refuse to ride.
     *  Null until the ride has been rated, which is when the game works it out. */
    value: number | null;
    totalCustomers: number;
    totalProfit: number;
    queueTime: number;
    /** Shops and stalls: no entrance, no exit, no queue. Guests buy from the path beside them. */
    isShop: boolean;
    /**
     * A queue is bound to the entrance. This is throughput, not reachability: without one a
     * ride still takes guests, one at a time - `PeepInteractWithEntrance` puts a guest who
     * walks up on ordinary path straight into queuing state, and `shouldGoOnRide` with
     * `atQueue` false then turns away anyone who arrives while that guest is still there.
     * A bound queue is what lets several wait at once. Null for a shop.
     */
    hasQueue: boolean | null;
    /**
     * Guests can get to this ride from the park entrance: for a ride, they can walk to the
     * tile its entrance door opens onto; for a shop, to `counter`. A queue is not part of
     * this - a ride with none is reachable, it just boards one guest at a time - and
     * demanding one here reported four rides unreachable through 29 recorded boardings.
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

export interface ParkStatus {
    scenario: { name: string; objective: object; status: string };
    /**
     * Where guests come in and what joins what: the gate, how many path tiles it reaches,
     * every one of those tiles as a straight run with the runs that run touches, the dead
     * ends, and the fragments of path it reaches nothing of. A new path has to join a run.
     */
    paths: PathNetworkShape;
    /** How much of what kind of ground the park owns, per map-aligned block. */
    ground: GroundCensus;
    parkOpen: boolean;
    date: { year: number; month: number; day: number };
    /** What the sky is doing, which nothing here reported and a person never stops seeing. */
    weather: WeatherReading;
    /**
     * The game's own speed setting, 1 to 4. Under the clock gate it buys nothing but real
     * time inside a `wait`: the game days a run spends are whatever `wait` is asked for.
     */
    speed: number;
    /**
     * A pause that is refusing what the model does - which since the clock gate is only ever
     * one the model asked for with `set_game_speed`.
     *
     * This was `context.paused` verbatim. The bridge now holds the game paused between tool
     * calls, so that flag is true on essentially every turn while nothing whatever is being
     * refused, and a field that says "paused" every single turn is a field that says the game
     * is stuck. src/clockGate.ts has the whole reading, including why a pause a human sets in
     * the game window reads as false here.
     */
    paused: boolean;
    cash: number;
    bankLoan: number;
    maxBankLoan: number;
    rating: number;
    guests: number;
    suggestedGuestMaximum: number;
    entranceFee: number;
    companyValue: number;
    /** Net profit for the last four months, index 0 is this month. The sum, per month, of
     *  every line in `monthlyExpenditure` and nothing else. */
    monthlyProfit: number[];
    /**
     * The same four months broken into the game's own expenditure streams, keyed by the
     * game's name for each, in the game's own ExpenditureType order: the lines a person
     * reads down the Finances window. Signed as the game signs them, so takings are
     * positive and costs negative, and each array is four months with index 0 this month.
     *
     * Every stream is present whether or not anything moved through it, because a zero is
     * a reading and an absent key is not. The fourteen add up to `monthlyProfit` month by
     * month - which is all the total ever was, and all it could say: a park losing money on
     * wages and a park losing the same money on ride upkeep were one number here, and the
     * two want opposite things done about them.
     */
    monthlyExpenditure: Record<string, number[]>;
    staff: Record<string, number>;
    /** The game's own notifications, newest last. It names problems before you find them. */
    messages: ParkMessageReading[];
    rides: RideSummary[];
}

/**
 * The weather, read off the game's `climate`.
 *
 * Nothing in `src/` touched `climate` before this. Rain in OpenRCT2 is not scenery: guests
 * stop boarding rides that have no shelter, buy umbrellas, head for cover and leave, and
 * every one of those shows up here as a takings figure or a guest count falling for no
 * reason park_status could name. A person sees it in the toolbar continuously and sees the
 * forecast beside it, so a turn planned in the sun that lands in a storm is a turn the model
 * was reading a park a person was not.
 *
 * Read and reported, not interpreted: which of these weathers is worth changing a plan for
 * is the model's call, and nothing here ranks them or says a ride will close.
 */
export interface WeatherReading {
    /** The scenario's climate, the game's own `climate.type`: the weather pattern this park
     *  runs on, not today's weather. One of `coolAndWet`, `warm`, `hotAndDry`, `cold`. */
    climate: string;
    /** Right now. `weather` is the game's own name for it - `sunny`, `partiallyCloudy`,
     *  `cloudy`, `rain`, `heavyRain`, `thunder`, `snow`, `heavySnow`, `blizzard` - and
     *  `temperature` is the game's own number, which its display renders in °C or °F
     *  depending on a setting this bridge cannot read. */
    current: { weather: string; temperature: number };
    /** What the game says is coming: its own `climate.future`, in the same two fields. */
    next: { weather: string; temperature: number };
}

/**
 * One park notification, with when it arrived.
 *
 * The game keeps a bounded queue of these and the bridge reports the last dozen, newest
 * last, and that was all it reported: a complaint raised in month 2 sat beside one raised in
 * month 7 looking identical, because nothing in the result said when either arrived. A run
 * read "Guests can't get to the entrance of Ferris Wheel 1!" on two turns after that ride's
 * `exitConnected` had gone true and called it stale both times - correct, but reached by
 * noticing a contradiction with another field, which only works while the contradiction is
 * obvious. `wait` can report `newMessages` because it holds a before and an after; a single
 * `park_status` call has no memory of the previous read, so the age has to be on the message.
 *
 * The stamp is an age rather than a date because the game records the arrival to the day
 * anyway, and a date would leave the subtraction to the reader: OpenRCT2's year is eight
 * months of unequal length, so "month 2 day 20 against month 7 day 3" is calendar arithmetic
 * this bridge does everywhere else precisely so the model does not have to. It is also the
 * same unit as `wait`'s `gameDays` and a result's `gameDaysSinceLastCall`, so game time has
 * one denomination throughout.
 *
 * Nothing is filtered, reordered or marked by it. Whether a three-week-old complaint still
 * stands is the reader's call - and it is a call the model got right, in the run above, as
 * soon as it had the means to make it.
 */
export interface ParkMessageReading {
    /**
     * Whole game days between the day this arrived and today. 0 means today. The game
     * records the arrival to the day and no finer, so this is counted in whole days and not
     * rounded from something more precise.
     */
    gameDaysAgo: number;
    text: string;
}

/**
 * The tile a door opens onto: one step further out than the building itself.
 *
 * Exported because `network.ts` needs the same answer to say which ride doors are standing
 * on an unreachable island, and two copies of this would be two different maps of where
 * guests queue.
 */
export function doorTile(access: CoordsXYZD): Tile {
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
 * what `shopServingTile` answers for describe_placement and build_flat_ride as well.
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
function recentMessages(count: number): ParkMessageReading[] {
    const all = park.messages;
    const start = Math.max(0, all.length - count);
    const today = currentDayNumber();
    const out: ParkMessageReading[] = [];

    for (let i = start; i < all.length; i++) {
        const message = all[i];
        const arrived = dayNumberFromElapsedMonths(message.month, message.day);

        out.push({
            gameDaysAgo: Math.max(0, today - arrived),
            // Messages carry colour and layout codes like {RED} and {NEWLINE}: noise to a reader.
            text: message.text.replace(/\{[A-Z_]+\}/g, " ").replace(/\s+/g, " ").trim()
        });
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
            nausea: rated ? ride.nausea : null,
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
                : entranceDoor !== null && tileIsWalkable(walkableNow, entranceDoor),
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

    // Expenditure comes back signed, so summing the streams gives net profit per month. Each
    // stream is kept as it was read as well as added in, so the total is an arithmetic fact
    // about the lines beside it rather than a figure with nothing to check it against.
    const profit: number[] = [0, 0, 0, 0];
    const expenditure: Record<string, number[]> = {};

    for (let s = 0; s < EXPENDITURE_STREAMS.length; s++) {
        const months = park.getMonthlyExpenditure(EXPENDITURE_STREAMS[s]);
        const reported: number[] = [];

        for (let i = 0; i < profit.length; i++) {
            const value = i < months.length ? months[i] || 0 : 0;

            reported.push(value);
            profit[i] += value;
        }

        expenditure[EXPENDITURE_STREAMS[s]] = reported;
    }

    return {
        scenario: { name: scenario.name, objective: scenario.objective, status: scenario.status },
        paths: readPathNetwork(),
        ground: readGroundCensus(DEFAULT_CENSUS_BLOCK),
        parkOpen: park.getFlag("open"),
        date: { year: date.year, month: date.month, day: date.day },
        weather: {
            climate: climate.type,
            current: { weather: climate.current.weather, temperature: climate.current.temperature },
            next: { weather: climate.future.weather, temperature: climate.future.temperature }
        },
        speed: typeof context.gameSpeed === "number" ? context.gameSpeed : 0,
        paused: pauseRefusesActions(),
        cash: park.cash,
        bankLoan: park.bankLoan,
        maxBankLoan: park.maxBankLoan,
        rating: park.rating,
        guests: park.guests,
        suggestedGuestMaximum: park.suggestedGuestMaximum,
        entranceFee: park.entranceFee,
        companyValue: park.companyValue,
        monthlyProfit: profit,
        monthlyExpenditure: expenditure,
        staff: staff,
        messages: recentMessages(12),
        rides: rides
    };
}

/**
 * One kind of thought, with how many of them were read and how stale the game says they are.
 *
 * `freshness` is here because every thought slot a guest is carrying used to be counted the
 * same, and a slot the game has stopped showing counts the same as one it is showing right
 * now: a complaint that was answered two months ago goes on inflating its own count until
 * the game finally drops it. Filtering the stale ones out would be this tool deciding which
 * complaints still stand, which is the reading a person does for themselves. So nothing is
 * filtered, and the number the game does that reading from is reported beside the count.
 */
export interface GuestThoughtReading {
    /** The game's own name for the thought, e.g. `queuing_ages`, `cant_find`, `hungry`. */
    thought: string;
    /**
     * Thought slots of this kind across the guests read. Slots, not guests: a guest holding
     * two thoughts contributes to two counts, exactly as the game stores them.
     */
    count: number;
    /**
     * The game's own `freshness` on those slots, counted per value: each key is a number the
     * game held and each value is how many of the slots read carried it, so the counts here
     * add up to `count`.
     *
     * The plugin API documents the field as "the larger the number, the less fresh the
     * thought" and documents nothing else about it - no unit, no scale, and no number at
     * which the game stops showing a thought - so it is passed through exactly as the game
     * holds it and described in the one direction the game states.
     *
     * A count per value rather than a row per value, because the rows cost what they carry:
     * measured on the worst read this tool can be asked for - 500 guests, all 125 thought
     * types, every one of them at 28 different freshness numbers - `{"1":8}` came to 23,000
     * characters where `[{"value":1,"count":8}]` came to 63,000 for the same figures.
     */
    freshness: Record<string, number>;
}

export interface GuestFeedback {
    /** Guests in the park: the length of the game's own guest list. */
    guests: number;
    /**
     * How many guests were read, which is where every count and average below comes from.
     *
     * This was called `sampled` and it was not a sample. The read walks the game's guest
     * list from the front and stops, so it is the same end of the same list every call, and
     * whatever that end has in common - it is the game's entity order, which no part of the
     * API says anything about - is what the counts over-represent. Named for what it does
     * rather than for a sampling method that was never implemented.
     */
    guestsRead: number;
    /**
     * Every kind of thought found, in the game's own thought enumeration order. That order
     * is arbitrary with respect to the park: it is not by count, not by severity and not by
     * anything else that would amount to saying which complaint matters. See
     * `THOUGHT_TYPE_ORDER`.
     */
    thoughts: GuestThoughtReading[];
    /** Mean over the guests read, out of 255. */
    averageHappiness: number;
    /** Mean over the guests read, in tenths of a currency unit. */
    averageCash: number;
}

/** The thought types found, in the game's enumeration order, unlisted ones last. */
function inThoughtTypeOrder(found: string[]): string[] {
    const known: string[] = [];
    const unknown: string[] = [];

    for (let i = 0; i < found.length; i++) {
        if (typeof THOUGHT_TYPE_RANK[found[i]] === "number") {
            known.push(found[i]);
        } else {
            unknown.push(found[i]);
        }
    }

    known.sort(function (left, right) {
        return THOUGHT_TYPE_RANK[left] - THOUGHT_TYPE_RANK[right];
    });

    return known.concat(unknown);
}

export function readGuestFeedback(readLimit: number): GuestFeedback {
    const guests = map.getAllEntities("guest");
    const counts: Record<string, number> = {};
    const freshness: Record<string, Record<string, number>> = {};
    const found: string[] = [];
    let happiness = 0;
    let cash = 0;
    let read = 0;

    for (let i = 0; i < guests.length && read < readLimit; i++) {
        const guest = guests[i];
        read++;
        happiness += guest.happiness;
        cash += guest.cash;

        const thoughts = guest.thoughts;

        for (let t = 0; t < thoughts.length; t++) {
            const type = thoughts[t].type as string;

            if (typeof counts[type] !== "number") {
                counts[type] = 0;
                freshness[type] = {};
                found.push(type);
            }

            counts[type] += 1;

            const value = String(thoughts[t].freshness);
            freshness[type][value] = (freshness[type][value] || 0) + 1;
        }
    }

    return {
        guests: guests.length,
        guestsRead: read,
        thoughts: inThoughtTypeOrder(found).map(function (thought) {
            return { thought: thought, count: counts[thought], freshness: freshness[thought] };
        }),
        averageHappiness: read > 0 ? Math.round(happiness / read) : 0,
        averageCash: read > 0 ? Math.round(cash / read) : 0
    };
}

export interface RideObjectInfo {
    index: number;
    name: string;
    rideType: number;
    /** Flat rides go up in one action with build_flat_ride. */
    isFlatRide: boolean;
    footprint: string | null;
    /** False while the scenario still has this one behind research. Read per object rather
     *  than filtered on: which rides exist and which are locked are both facts, and dropping
     *  the locked ones would decide what the park can be planned towards. */
    researched: boolean;
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
            footprint: typeof shape === "undefined" ? null : String(shape.width) + "x" + String(shape.depth),
            researched: rideObjectResearched(object.index)
        };
    });
}
