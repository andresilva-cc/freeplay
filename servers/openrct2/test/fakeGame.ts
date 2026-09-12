import { flatRideShape } from "../src/park/flatRides.ts";

/**
 * A stand-in for the OpenRCT2 globals, enough to exercise src/park.
 *
 * The point is the timing. A real game action does not take effect until a later tick,
 * which is what makes "did this actually happen?" hard and is the source of this
 * project's worst bugs. So actions queue here too, and `setTimeout` applies the queue
 * before running its callback — exactly like the real thing. Construct with
 * `{ inert: true }` and actions are accepted and never applied, which is how the
 * false-success direction gets tested: every tool must then report that nothing happened.
 */

export interface FakeElement {
    type: string;
    baseZ?: number;
    hasOwnership?: boolean;
    /** Surface only: the scenario has put this tile up for sale, so landbuyrights can take it. */
    forSale?: boolean;
    slope?: number;
    isQueue?: boolean;
    /**
     * Footpath only: the sides a guest may leave this tile by, as OpenRCT2 stores them.
     * Bit 0 is -x, 1 is +y, 2 is +x, 3 is -y, matching `CoordsDirectionDelta`. The guest
     * pathfinder reads this and nothing else, so it is what decides reachability.
     */
    edges?: number;
    ride?: number | null;
    station?: number | null;
    surfaceObject?: number | null;
    sequence?: number | null;
    object?: number;
    direction?: number;
    trackType?: number;
}

export interface FakeStation {
    start: { x: number; y: number; z: number } | null;
    entrance: { x: number; y: number; z: number; direction: number } | null;
    exit: { x: number; y: number; z: number; direction: number } | null;
    length: number;
    queueTime: number;
}

export interface FakeRide {
    id: number;
    name: string;
    type: number;
    status: string;
    price: number[];
    stations: FakeStation[];
    /**
     * Fixed-point ratings. -1 in `excitement` is the game's RIDE_RATING_UNDEFINED, which the
     * plugin API hands over raw; `intensity` and `nausea` sit at 0 while it does.
     */
    excitement: number;
    intensity: number;
    totalCustomers: number;
    totalProfit: number;
    downtime: number;
    reliability: number;
    flags: number;
    /** Null while the ride has no ratings: the plugin API converts RIDE_VALUE_UNDEFINED
     *  itself, so this is the one sentinel that never reaches a plugin as a number. */
    value: number | null;
}

export interface FakeGuest {
    happiness: number;
    cash: number;
    thoughts: { type: string }[];
}

export interface FakeStaff {
    staffType: string;
}

/** A park notification, shaped as the game gives it: the text carries format codes. */
export interface FakeMessage {
    text: string;
}

interface QueuedAction {
    name: string;
    args: Record<string, unknown>;
    callback?: (result: Record<string, unknown>) => void;
}

const STAFF_TYPE_NAMES: Record<number, string> = {
    0: "handyman", 1: "mechanic", 2: "security", 3: "entertainer"
};

/**
 * The actions this plugin fires that OpenRCT2 lets through while the game is paused.
 *
 * Read off each action's `GetActionFlags()` in OpenRCT2 (`src/openrct2/actions/…`): these
 * are the ones that OR in `Flags::AllowWhilePaused`. Everything else the bridge fires -
 * footpathplace, footpathremove, landbuyrights, trackplace, rideentranceexitplace,
 * ridedemolish, and the scenery, wall and banner removals - does not, so a paused game
 * answers it with "Construction not possible while game is paused!" and changes nothing.
 */
export const ALLOWED_WHILE_PAUSED: Record<string, boolean> = {
    gamesetspeed: true,
    pausetoggle: true,
    ridecreate: true,
    ridesetstatus: true,
    ridesetprice: true,
    ridesetsetting: true,
    parksetparameter: true,
    parksetentrancefee: true,
    staffhire: true
};

/** Money the way the game prints it in an error: tenths of a unit, so 150 is £15.00. */
function formatMoney(tenths: number): string {
    return "£" + (tenths / 10).toFixed(2);
}

/**
 * Offsets of each flat-ride piece, unrotated, in tiles.
 *
 * Transcribed from OpenRCT2's own track element data (ride/ted/TED.FlatRide.h, where each
 * sequence carries its x/y clearance offset in world units) and not from what this plugin
 * expects to get back. The two have disagreed before: a 3x3 is centred on its origin but a
 * 4x4 runs 0..3 from it, and assuming one rule for both put a dodgems' entrance three
 * tiles clear of the ride with every check agreeing it was adjacent.
 */
const TRACK_PIECE_OFFSETS: Record<number, { x: number; y: number }[]> = {
    // Type 0 is real flat track, one tile. The game answers for it, so anything that
    // asks the track table for a plain square gets a single tile back.
    0: [{ x: 0, y: 0 }],
    // flatTrack1x1A and flatTrack1x1B: the shops and stalls.
    262: [{ x: 0, y: 0 }],
    264: [{ x: 0, y: 0 }],
    // flatTrack2x2, laid from its origin rather than centred on it.
    258: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
    // flatTrack3x3, centred on its origin.
    266: [
        { x: -1, y: -1 }, { x: -1, y: 0 }, { x: -1, y: 1 },
        { x: 0, y: -1 }, { x: 0, y: 0 }, { x: 0, y: 1 },
        { x: 1, y: -1 }, { x: 1, y: 0 }, { x: 1, y: 1 }
    ],
    // flatTrack4x4, laid from its origin: the piece the centring rule gets wrong.
    259: [
        { x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }, { x: 0, y: 3 },
        { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 3 },
        { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 2, y: 3 },
        { x: 3, y: 0 }, { x: 3, y: 1 }, { x: 3, y: 2 }, { x: 3, y: 3 }
    ],
    // flatTrack2x4, two wide from its origin and four deep.
    260: [
        { x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }, { x: 0, y: 3 },
        { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 3 }
    ],
    // The three 1x4 pieces - flatTrack1x4A, B and C - all run -2..+1 along x.
    257: [{ x: -2, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }],
    263: [{ x: -2, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }],
    265: [{ x: -2, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }],
    // flatTrack1x5, centred on its origin.
    261: [{ x: -2, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]
};

/**
 * OpenRCT2's TileDirectionDelta: 0 is -x, 1 is +y, 2 is +x, 3 is -y.
 *
 * Deliberately a copy rather than an import of the plugin's own table. A fake that reads
 * the direction table out of the code it is testing agrees with whatever that table says,
 * including a rotation nobody checked, which is how this project's door-on-the-wrong-wall
 * bugs stayed invisible.
 */
const DIRECTION_DELTAS = [
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 1, dy: 0 },
    { dx: 0, dy: -1 }
];

/**
 * Turns a piece offset the way the game turns it when it places track.
 *
 * TrackPlaceAction rotates every block of a piece by `CoordsXY::rotate(origin.direction)`,
 * which is (x, y) -> (y, -x) for one turn - the turn that carries direction 0's delta onto
 * direction 1's. Written from the game, not from flatRides.ts: if the fake spun pieces the
 * way the plugin expects, a build at rotation 1 would land on the tiles the plugin had
 * guessed and no test could tell the two conventions apart.
 */
function rotateOffset(offset: { x: number; y: number }, direction: number): { x: number; y: number } {
    const turns = ((direction % 4) + 4) % 4;

    if (turns === 1) {
        return { x: offset.y, y: -offset.x };
    }

    if (turns === 2) {
        return { x: -offset.x, y: -offset.y };
    }

    if (turns === 3) {
        return { x: -offset.y, y: offset.x };
    }

    return { x: offset.x, y: offset.y };
}

export class FakeGame {
    public readonly width: number;
    public readonly height: number;
    public rideObjects: { index: number; name: string; rideType: number[] }[] = [];
    public rides: FakeRide[] = [];
    /** Actions accepted but not yet applied. */
    public readonly pending: QueuedAction[] = [];
    /** Every action ever accepted, for assertions about what was attempted. */
    public readonly attempted: QueuedAction[] = [];
    /** When true, actions are accepted and never take effect. */
    public inert: boolean;
    /** Action names to refuse, to test a step failing mid-sequence. */
    public refuse: Record<string, boolean> = {};
    /**
     * What taking one piece of small or large scenery down costs, in tenths of a currency
     * unit. Zero - the default - keeps removal free, which is how every suite that predates
     * the money check sees it. Set it and removals are paid for out of `parkValues.cash`,
     * and refused with the game's own InsufficientFunds once the park cannot afford one.
     */
    public sceneryRemovalCost = 0;
    /**
     * How many entertainer costumes this park has loaded. `staffhire` names a costume by
     * index and the game refuses any index past them, so 0 is a scenario where no
     * entertainer can be hired at all - which is what Forest Frontiers is. One - the
     * default - leaves costume 0 there, the only one this plugin ever asks for.
     */
    public entertainerCostumes = 1;
    /** Staff hired through the staffhire action, or put there by `addStaff`. */
    public readonly staff: FakeStaff[] = [];
    /** Guests in the park, as `map.getAllEntities("guest")` returns them. */
    public readonly guests: FakeGuest[] = [];
    /** The game's own notifications, oldest first. */
    public readonly messages: FakeMessage[] = [];
    /** Park-wide figures park_status reads. Set any of them from a test. */
    public readonly parkValues = {
        cash: 100000,
        bankLoan: 70000,
        maxBankLoan: 200000,
        rating: 700,
        guests: 0,
        suggestedGuestMaximum: 200,
        entranceFee: 0,
        companyValue: 150000,
        /** What one tile of land costs, in tenths, as the scenario sets it. */
        landPrice: 200
    };
    /**
     * The clock, as `context` reports it. `speed` is the game's own setting and not a
     * multiplier - the real loop runs `1 << (speed - 1)` updates per frame - and only 1 to
     * 4 are accepted, exactly as `GameSetSpeedAction::IsValidSpeed` accepts them without
     * debugging tools. `pausetoggle` flips `paused` rather than setting it.
     */
    public readonly gameValues = {
        speed: 1,
        paused: false
    };
    /** Park flags by name, as `park.getFlag` reads them. Unset names are false. */
    public readonly parkFlags: Record<string, boolean> = { open: false };
    /**
     * Expenditure per stream, newest month first, signed the way the game signs it.
     * A stream nothing was set for reads as four zero months.
     */
    public readonly expenditure: Record<string, number[]> = {};
    /** The scenario being played, as `scenario` reports it. */
    public readonly scenario = {
        name: "Forest Frontiers",
        objective: { type: "guests_by", guests: 250, year: 4 },
        status: "inProgress"
    };
    /**
     * The in-game date, as `date` reports it. Month is the index within the year, 0 being
     * March. Every field is derived from the tick count by `advanceTicks`, so nothing can
     * move the day without the clock having actually run.
     */
    public readonly date = {
        ticksElapsed: 0,
        monthsElapsed: 0,
        yearsElapsed: 0,
        monthProgress: 0,
        year: 1,
        month: 0,
        day: 1
    };
    /** Long waits, held rather than fired. Call `fireWatchdogs()` to test a timeout. */
    public readonly watchdogs: (() => void)[] = [];
    /** Waits longer than this are treated as watchdogs rather than ticks. */
    public static readonly WATCHDOG_THRESHOLD_MS = 5000;
    /** Game updates per real second at speed 1: OpenRCT2's GAME_UPDATE_FPS. */
    public static readonly TICKS_PER_SECOND = 40;
    /** `monthProgress` is incremented by 4 per tick and a month ends at 65536. */
    public static readonly MONTH_PROGRESS_PER_TICK = 4;
    public static readonly MONTH_PROGRESS_PER_MONTH = 65536;
    /** Months in a game year, March to October. */
    public static readonly MONTHS_PER_YEAR = 8;
    /** OpenRCT2's `days_in_month` from Date.cpp, in the same order. */
    public static readonly DAYS_IN_MONTH = [31, 30, 31, 30, 31, 31, 30, 31];

    private readonly tiles: { elements: FakeElement[] }[];
    private nextRideId = 0;

    public constructor(width: number, height: number, options?: { inert?: boolean }) {
        this.width = width;
        this.height = height;
        this.inert = options ? options.inert === true : false;
        this.tiles = [];

        for (let i = 0; i < width * height; i++) {
            this.tiles.push({ elements: [{ type: "surface", baseZ: 96, hasOwnership: true, slope: 0 }] });
        }
    }

    public tile(x: number, y: number): { elements: FakeElement[] } {
        return this.tiles[y * this.width + x];
    }

    public inBounds(x: number, y: number): boolean {
        return x >= 0 && y >= 0 && x < this.width && y < this.height;
    }

    public own(x: number, y: number, owned: boolean): void {
        this.tile(x, y).elements[0].hasOwnership = owned;
    }

    /**
     * Put a tile up for sale, the way a scenario does. Only tiles marked this way can be
     * bought: the game answers `landbuyrights` on anything else with an error it then
     * ignores, so an unsold tile is silently left alone rather than failing the call.
     */
    public putUpForSale(x: number, y: number, forSale = true): void {
        this.tile(x, y).elements[0].forSale = forSale;
    }

    public addScenery(x: number, y: number, type = "small_scenery"): void {
        this.tile(x, y).elements.push({ type: type, baseZ: 96, object: 0, direction: 0 });
    }

    public addPath(x: number, y: number, queue = false, ride: number | null = null): void {
        this.tile(x, y).elements.push({
            type: "footpath", baseZ: 96, isQueue: queue, ride: ride, surfaceObject: queue ? 11 : 0, edges: 0
        });
        this.connectEdgesAround(x, y);
    }

    /**
     * Join every footpath here to the footpaths and doorways beside it, in both directions.
     *
     * The game keeps `edges` symmetric - measured across every footpath of a running park,
     * there was not one pair where only one side claimed the link - so this sets both. A
     * queue is joined exactly like ordinary path, because that is what the game does:
     * turning two path tiles into a queue changed no edge bit at all.
     *
     * Deliberately not a model of OpenRCT2's edge bookkeeping, which is several hundred
     * lines and the thing whose reimplementation caused the bug this replaced. It lays down
     * the ordinary case; a test that needs a link the game would have cut says so with
     * `severPath`, the way the real API hands that state over as data.
     */
    private connectEdgesAround(x: number, y: number): void {
        for (let i = -1; i <= 1; i++) {
            for (let j = -1; j <= 1; j++) {
                if (i !== 0 && j !== 0) {
                    continue;
                }

                if (this.inBounds(x + i, y + j)) {
                    this.recomputeEdges(x + i, y + j);
                }
            }
        }
    }

    private recomputeEdges(x: number, y: number): void {
        const directions = [{ dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 1, dy: 0 }, { dx: 0, dy: -1 }];
        let edges = 0;

        for (let d = 0; d < directions.length; d++) {
            const nx = x + directions[d].dx;
            const ny = y + directions[d].dy;

            if (!this.inBounds(nx, ny)) {
                continue;
            }

            const neighbours = this.tile(nx, ny).elements;

            for (let i = 0; i < neighbours.length; i++) {
                // A doorway counts: guests step between a path and the building it serves.
                if (neighbours[i].type === "footpath" || neighbours[i].type === "entrance") {
                    edges |= 1 << d;
                    break;
                }
            }
        }

        const elements = this.tile(x, y).elements;

        for (let i = 0; i < elements.length; i++) {
            if (elements[i].type === "footpath") {
                elements[i].edges = edges;
            }
        }
    }

    /**
     * Cut the link between two neighbouring tiles, both ways, leaving the paths in place.
     *
     * This is the state a ride entrance puts its own queue into: the game clears the bit on
     * the far side of the queue tile at the door, so the line dead-ends there instead of
     * carrying traffic past it. Measured in a running park - the tile at the door went from
     * `edges` 10 to 9 and the tile beyond it from 10 to 3 - and set here as data rather than
     * derived, because deriving it is what went wrong before.
     */
    public severPath(ax: number, ay: number, bx: number, by: number): void {
        const directions = [{ dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 1, dy: 0 }, { dx: 0, dy: -1 }];

        for (let d = 0; d < directions.length; d++) {
            if (ax + directions[d].dx !== bx || ay + directions[d].dy !== by) {
                continue;
            }

            this.clearEdge(ax, ay, d);
            this.clearEdge(bx, by, (d + 2) % 4);
            return;
        }

        throw new Error(String(ax) + "," + String(ay) + " and " + String(bx) + "," + String(by)
            + " are not neighbours, so there is no link between them to cut");
    }

    private clearEdge(x: number, y: number, direction: number): void {
        const elements = this.tile(x, y).elements;

        for (let i = 0; i < elements.length; i++) {
            if (elements[i].type === "footpath") {
                elements[i].edges = (elements[i].edges || 0) & ~(1 << direction);
            }
        }
    }

    /**
     * Put a ride's entrance or exit building on a tile without building the ride.
     *
     * `direction` points at the ride, which is the game's own convention: it walks a
     * queue away from the entrance along the reverse of this.
     */
    public addRideEntrance(x: number, y: number, ride: number, direction: number, isExit = false): void {
        this.tile(x, y).elements.push({
            type: "entrance", baseZ: 96, object: isExit ? 1 : 0, sequence: 0, ride: ride, direction: direction
        });
        this.connectEdgesAround(x, y);
        this.updateQueueChains();
    }

    /**
     * Put the park's own gate down: three tiles, `object: 2`, sequence 0 to 2.
     *
     * `ride: 0` is not a ride. The plugin API hands an entrance element's ride index over
     * raw (`JS_NewUint32(el->getRideIndex())`), and the field is unused on a park entrance,
     * so the gate of a park with no rides in it reads back as ride 0 rather than null. The
     * fake used to leave it undefined, which let `typeof element.ride !== "number"` stand in
     * for "this is the gate" - a test that only passed because the fake was gentler than the
     * game. `object` is the only field that says which of the three kinds of entrance this is.
     */
    public addParkEntrance(x: number, y: number): void {
        for (let i = 0; i < 3; i++) {
            this.tile(x + i, y).elements.push({
                type: "entrance", baseZ: 96, object: 2, sequence: i, ride: 0
            });
            this.connectEdgesAround(x + i, y);
        }
    }

    /** Put a guest in the park. The park's own guest count follows unless a test sets it. */
    public addGuest(guest?: Partial<FakeGuest>): FakeGuest {
        const added: FakeGuest = {
            happiness: guest && typeof guest.happiness === "number" ? guest.happiness : 200,
            cash: guest && typeof guest.cash === "number" ? guest.cash : 500,
            thoughts: guest && guest.thoughts ? guest.thoughts : []
        };

        this.guests.push(added);
        this.parkValues.guests = this.guests.length;
        return added;
    }

    /**
     * The step the game runs a little after a ride opens: it works the ratings out and
     * fills `value` in from them, which is why an unrated ride has neither.
     */
    public rateRide(id: number, ratings: { excitement: number; intensity: number; value: number }): void {
        const ride = this.findRide(id);

        if (!ride) {
            throw new Error("the fake game has no ride " + String(id) + " to rate");
        }

        ride.excitement = ratings.excitement;
        ride.intensity = ratings.intensity;
        ride.value = ratings.value;
    }

    /** Put a staff member in the park without going through the hiring action. */
    public addStaff(staffType: string): void {
        this.staff.push({ staffType: staffType });
    }

    /** Add a park notification. Newest last, exactly as the game orders them. */
    public addMessage(text: string): void {
        this.messages.push({ text: text });
    }

    /** Fire every held watchdog, as if the work had never finished. */
    public fireWatchdogs(): void {
        while (this.watchdogs.length > 0) {
            (this.watchdogs.shift() as () => void)();
        }
    }

    /**
     * Run the simulation for a number of game ticks, exactly as OpenRCT2's `DateUpdate`
     * does: `monthProgress` climbs by 4 a tick, a month ends at 65536, and the day of the
     * month is how far through it that leaves us. Nothing else here moves the date, so a
     * test that sees a later day has seen the clock run.
     */
    public advanceTicks(ticks: number): void {
        if (ticks <= 0) {
            return;
        }

        this.date.ticksElapsed += ticks;
        this.date.monthProgress += ticks * FakeGame.MONTH_PROGRESS_PER_TICK;

        while (this.date.monthProgress >= FakeGame.MONTH_PROGRESS_PER_MONTH) {
            this.date.monthProgress -= FakeGame.MONTH_PROGRESS_PER_MONTH;
            this.date.monthsElapsed++;
        }

        this.date.yearsElapsed = Math.floor(this.date.monthsElapsed / FakeGame.MONTHS_PER_YEAR);
        this.date.year = this.date.yearsElapsed + 1;
        this.date.month = this.date.monthsElapsed % FakeGame.MONTHS_PER_YEAR;
        this.date.day = Math.floor(
            this.date.monthProgress * FakeGame.DAYS_IN_MONTH[this.date.month]
                / FakeGame.MONTH_PROGRESS_PER_MONTH
        ) + 1;
    }

    /**
     * Real time passing, which is what a tool's `context.setTimeout` is denominated in.
     *
     * How much of the simulation that buys is the speed setting: the loop runs
     * `1 << (speed - 1)` updates per frame, so a second of real time at speed 4 advances
     * the game eight times as far as it does at speed 1. A paused game advances not at
     * all, which is the whole reason waiting through a pause is a wasted call.
     */
    public advanceRealMilliseconds(milliseconds: number): void {
        if (this.gameValues.paused || milliseconds <= 0) {
            return;
        }

        const updatesPerTick = 1 << (this.gameValues.speed - 1);

        this.advanceTicks(Math.floor(
            milliseconds / 1000 * FakeGame.TICKS_PER_SECOND * updatesPerTick
        ));
    }

    public applyQueuedActions(): void {
        while (this.pending.length > 0) {
            const action = this.pending.shift() as QueuedAction;

            if (this.refuse[action.name]) {
                if (action.callback) {
                    action.callback({ error: 1, errorTitle: "Refused", errorMessage: "test refusal" });
                }
                continue;
            }

            const result = this.apply(action);

            if (action.callback) {
                action.callback(result);
            }
        }
    }

    private apply(action: QueuedAction): Record<string, unknown> {
        if (this.gameValues.paused && !ALLOWED_WHILE_PAUSED[action.name]) {
            // OpenRCT2's own gate, GameActionRunner.cpp `CheckActionInPausedMode`: while the
            // game is paused every action is refused unless it carries Flags::AllowWhilePaused.
            // The message is the game's STR_CONSTRUCTION_NOT_POSSIBLE_WHILE_GAME_IS_PAUSED.
            return {
                error: 1,
                errorTitle: "Can't do this...",
                errorMessage: "Construction not possible while game is paused!"
            };
        }

        const args = action.args as Record<string, number & boolean>;
        const tileX = Math.floor((args.x as number) / 32);
        const tileY = Math.floor((args.y as number) / 32);

        if (action.name === "ridecreate") {
            const id = this.nextRideId++;
            this.rides.push({
                id: id, name: "Ride " + String(id), type: args.rideType as number, status: "closed",
                price: [0], stations: [{ start: null, entrance: null, exit: null, length: 0, queueTime: 0 }],
                // The state a real freshly built ride is in, measured in the running game:
                // excitement is the RIDE_RATING_UNDEFINED sentinel, intensity and nausea are
                // left at 0, and value comes back null. A fake that handed out a rating and a
                // value here would let the unrated case pass untested.
                excitement: -1, intensity: 0, totalCustomers: 0, totalProfit: 0,
                downtime: 0, reliability: 100, flags: 0, value: null
            });
            return { error: 0, ride: id };
        }

        if (action.name === "trackplace") {
            const offsets = TRACK_PIECE_OFFSETS[args.trackType as number];

            if (!offsets) {
                return { error: 1, errorTitle: "Unknown piece", errorMessage: String(args.trackType) };
            }

            // The piece is turned to face `direction` before it is laid, so where a ride
            // ends up is the game's decision, not the caller's.
            const spun = offsets.map(function (offset) {
                return rotateOffset(offset, (args.direction as number) || 0);
            });

            for (let i = 0; i < spun.length; i++) {
                const x = tileX + spun[i].x;
                const y = tileY + spun[i].y;

                if (!this.inBounds(x, y)) {
                    return { error: 1, errorTitle: "Off the map", errorMessage: "out of bounds" };
                }
            }

            for (let i = 0; i < spun.length; i++) {
                this.tile(tileX + spun[i].x, tileY + spun[i].y).elements.push({
                    // The game records the facing it laid the piece at on the track itself,
                    // and it is the only record of it: a Ride carries no rotation, so which
                    // way a built stall faces can only be read back off this.
                    type: "track", baseZ: 96, ride: args.ride as number, trackType: args.trackType as number,
                    direction: ((((args.direction as number) || 0) % 4) + 4) % 4
                });
            }

            const ride = this.findRide(args.ride as number);

            if (ride) {
                ride.stations[0].start = { x: tileX * 32, y: tileY * 32, z: 96 };
            }

            return { error: 0 };
        }

        if (action.name === "rideentranceexitplace") {
            const ride = this.findRide(args.ride as number);

            if (!ride) {
                return { error: 1, errorTitle: "No ride", errorMessage: "unknown ride" };
            }

            const spot = { x: tileX * 32, y: tileY * 32, z: 96, direction: args.direction as number };

            if (args.isExit) {
                ride.stations[0].exit = spot;
            } else {
                ride.stations[0].entrance = spot;
            }

            this.tile(tileX, tileY).elements.push({
                type: "entrance", baseZ: 96, object: args.isExit ? 1 : 0, sequence: 0,
                ride: ride.id, direction: args.direction as number
            });
            this.updateQueueChains();
            return { error: 0 };
        }

        if (action.name === "ridesetprice") {
            const ride = this.findRide(args.ride as number);
            if (ride) { ride.price = [args.price as number]; }
            return { error: 0 };
        }

        if (action.name === "ridesetstatus") {
            const ride = this.findRide(args.ride as number);

            if (ride) {
                const built = ride.stations[0].start !== null;
                const shape = flatRideShape(ride.type);
                // A shop has no entrance or exit and opens without them.
                const needsDoors = !shape || !shape.isShop;
                const hasDoors = ride.stations[0].entrance !== null && ride.stations[0].exit !== null;

                if (args.status === 1 && !(built && (!needsDoors || hasDoors))) {
                    return { error: 1, errorTitle: "Can't open", errorMessage: "Not yet constructed!" };
                }

                ride.status = args.status === 1 ? "open" : "closed";
            }

            return { error: 0 };
        }

        if (action.name === "ridedemolish") {
            const gone = args.ride as number;
            this.rides = this.rides.filter(function (ride) { return ride.id !== gone; });

            // Demolishing takes the ride off the ground too. Leaving its track behind would
            // let a test pass that had only checked the ride list.
            for (let i = 0; i < this.tiles.length; i++) {
                this.tiles[i].elements = this.tiles[i].elements.filter(function (element) {
                    const owned = element.type === "track" || element.type === "entrance";
                    return !(owned && element.ride === gone);
                });
            }

            this.updateQueueChains();
            return { error: 0 };
        }

        if (action.name === "parksetparameter") {
            // ParkParameter: 0 closes the park, 1 opens it. The action carries the rest of
            // what it does in `value`, which neither of those two reads.
            if (args.parameter === 0 || args.parameter === 1) {
                this.parkFlags.open = args.parameter === 1;
                return { error: 0 };
            }

            return {
                error: 1, errorTitle: "Unknown parameter", errorMessage: String(args.parameter)
            };
        }

        if (action.name === "parksetentrancefee") {
            this.parkValues.entranceFee = args.value as number;
            return { error: 0 };
        }

        if (action.name === "staffhire") {
            const staffType = STAFF_TYPE_NAMES[args.staffType as number] || "handyman";

            // StaffHireNewAction checks an entertainer's costume index against the costumes
            // this park has loaded and refuses anything past them, which is how a scenario
            // with no entertainer costume at all turns down every entertainer there is.
            if (staffType === "entertainer" && (args.costumeIndex as number) >= this.entertainerCostumes) {
                return {
                    error: 1, errorTitle: "Can't hire new staff", errorMessage: "Value out of range"
                };
            }

            this.staff.push({ staffType: staffType });
            return { error: 0 };
        }

        if (action.name === "footpathplace") {
            if (!this.inBounds(tileX, tileY)) {
                return { error: 1, errorTitle: "Off the map", errorMessage: "out of bounds" };
            }

            const isQueue = ((args.constructFlags as number) & 1) !== 0;
            const tile = this.tile(tileX, tileY);
            const existing = tile.elements.filter(function (e) { return e.type === "footpath"; })[0];

            if (existing) {
                existing.isQueue = isQueue;
                existing.surfaceObject = args.object as number;
            } else {
                tile.elements.push({
                    type: "footpath", baseZ: 96, isQueue: isQueue, ride: null,
                    surfaceObject: args.object as number, edges: 0
                });
            }

            // The game rebuilds a tile's edges and its neighbours' whenever a path lands or
            // leaves. Without this a tile the plugin laid itself carries no edges at all and
            // reads as an island, which is not what the game hands back.
            this.connectEdgesAround(tileX, tileY);
            this.updateQueueChains();
            return { error: 0 };
        }

        if (action.name === "footpathremove") {
            const tile = this.tile(tileX, tileY);
            tile.elements = tile.elements.filter(function (e) { return e.type !== "footpath"; });
            this.connectEdgesAround(tileX, tileY);
            this.updateQueueChains();
            return { error: 0 };
        }

        if (action.name === "gamesetspeed") {
            const speed = args.speed as number;

            // GameSetSpeedAction::IsValidSpeed. 5 to 8 exist only with debugging tools on,
            // which a plugin can neither set nor read, so they are out of range here.
            if (speed < 1 || speed > 4 || Math.floor(speed) !== speed) {
                return {
                    error: 1, errorTitle: "Invalid parameter", errorMessage: "Value out of range"
                };
            }

            this.gameValues.speed = speed;
            return { error: 0 };
        }

        if (action.name === "pausetoggle") {
            // The action toggles. Something that fires it to reach a state it is already in
            // leaves the game in the other one, which is the bug this models.
            this.gameValues.paused = !this.gameValues.paused;
            return { error: 0 };
        }

        if (action.name === "landbuyrights") {
            // Only LandBuyRightSetting::buyLand is modelled. Answering for a setting this
            // does not carry out would be the same lie as answering for an unknown action.
            if (args.setting !== 0) {
                throw new Error("the fake game only applies landbuyrights setting 0 (buy land), not "
                    + String(args.setting));
            }

            return this.buyLandRights(args);
        }

        if (action.name === "smallsceneryremove" || action.name === "largesceneryremove"
            || action.name === "wallremove" || action.name === "bannerremove") {
            const removing = action.name.replace("remove", "");
            const type = removing === "smallscenery" ? "small_scenery"
                : (removing === "largescenery" ? "large_scenery" : removing);
            // Only scenery is charged for: WallRemoveAction sets cost 0 and BannerRemoveAction
            // refunds, which is the same split the tool's own description states.
            const price = removing === "smallscenery" || removing === "largescenery"
                ? this.sceneryRemovalCost
                : 0;

            if (price > this.parkValues.cash) {
                // GameActions::Status::InsufficientFunds, worded the way the game words it.
                return {
                    error: 4, errorTitle: "Can't remove this",
                    errorMessage: "Not enough cash - requires " + formatMoney(price), cost: price
                };
            }

            this.parkValues.cash -= price;
            const tile = this.tile(tileX, tileY);
            tile.elements = tile.elements.filter(function (e) { return e.type !== type; });
            return { error: 0, cost: price };
        }

        // An action the fake does not model must not read as one that worked. Answering
        // `error: 0` to anything at all is the same lie the tools are being tested for.
        throw new Error("the fake game does not apply the \"" + action.name + "\" action");
    }

    /**
     * Buys the land rights to a world-coordinate rectangle, the way LandBuyRightsAction does.
     *
     * The game walks the rectangle a tile at a time. A tile the park already owns is skipped
     * at no cost; a tile the scenario has not put up for sale answers `notOwned`, and the
     * action ignores that error and carries on, so a rectangle that is half for sale buys the
     * half that is and reports no failure at all. The whole cost is then checked against the
     * park's cash before anything is applied, so a rectangle the park cannot afford buys none
     * of it. Buying replaces the tile's ownership flags outright, which is why the for-sale
     * mark does not survive the purchase.
     */
    private buyLandRights(args: Record<string, number & boolean>): Record<string, unknown> {
        const left = Math.min(args.x1 as number, args.x2 as number) / 32;
        const right = Math.max(args.x1 as number, args.x2 as number) / 32;
        const top = Math.min(args.y1 as number, args.y2 as number) / 32;
        const bottom = Math.max(args.y1 as number, args.y2 as number) / 32;
        const buyable: { x: number; y: number }[] = [];

        for (let y = top; y <= bottom; y++) {
            for (let x = left; x <= right; x++) {
                if (!this.inBounds(x, y)) {
                    continue;
                }

                const surface = this.tile(x, y).elements[0];

                if (surface.hasOwnership || surface.forSale !== true) {
                    continue;
                }

                buyable.push({ x: x, y: y });
            }
        }

        const cost = buyable.length * this.parkValues.landPrice;

        if (cost > this.parkValues.cash) {
            // GameActions::Status::InsufficientFunds, worded the way the game words it.
            return {
                error: 4, errorTitle: "Can't buy land...",
                errorMessage: "Not enough cash - requires " + formatMoney(cost), cost: cost
            };
        }

        for (let i = 0; i < buyable.length; i++) {
            const surface = this.tile(buyable[i].x, buyable[i].y).elements[0];
            surface.hasOwnership = true;
            surface.forSale = false;
        }

        this.parkValues.cash -= cost;
        return { error: 0, cost: cost };
    }

    /**
     * Rebinds every queue on the map to the ride it serves, the way the game does.
     *
     * A ride entrance's `direction` points at the ride, and the game walks the queue from
     * the entrance tile in the reverse of it, setting the ride on each connected queue
     * tile as it goes (Footpath.cpp, FootpathChainRideQueue, called with
     * `DirectionReverse(entrance->GetDirection())`). So which tile a queue has to occupy
     * to serve a ride is decided by the entrance, not by touching the ride anywhere.
     *
     * Queues no chain reaches end up bound to nothing, which is also what the game does:
     * a queue cut off from its entrance is an ordinary line of tiles guests will not board
     * from. A queue put on the map by `addPath(x, y, true, ride)` therefore keeps that ride
     * only until something makes the game recompute.
     */
    private updateQueueChains(): void {
        const queues: FakeElement[] = [];

        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const elements = this.tile(x, y).elements;

                for (let i = 0; i < elements.length; i++) {
                    if (elements[i].type !== "footpath") {
                        continue;
                    }

                    elements[i].ride = null;

                    if (elements[i].isQueue) {
                        queues.push(elements[i]);
                    }
                }
            }
        }

        if (queues.length === 0) {
            return;
        }

        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const elements = this.tile(x, y).elements;

                for (let i = 0; i < elements.length; i++) {
                    const element = elements[i];

                    // object 0 is a ride entrance, 1 its exit: only the entrance has a queue.
                    if (element.type !== "entrance" || element.object !== 0 || typeof element.ride !== "number") {
                        continue;
                    }

                    const away = DIRECTION_DELTAS[((element.direction || 0) % 4 + 4) % 4];
                    this.chainQueue(x - away.dx, y - away.dy, element.ride);
                }
            }
        }
    }

    /** Walks a connected run of queue tiles from `x,y`, binding each one to `ride`. */
    private chainQueue(x: number, y: number, ride: number): void {
        const pending = [{ x: x, y: y }];
        const seen: Record<string, boolean> = {};

        while (pending.length > 0) {
            const at = pending.shift() as { x: number; y: number };
            const key = String(at.x) + "," + String(at.y);

            if (seen[key] || !this.inBounds(at.x, at.y)) {
                continue;
            }

            seen[key] = true;
            const elements = this.tile(at.x, at.y).elements;
            let queue: FakeElement | undefined;

            for (let i = 0; i < elements.length; i++) {
                if (elements[i].type === "footpath" && elements[i].isQueue) {
                    queue = elements[i];
                    break;
                }
            }

            if (!queue) {
                continue;
            }

            queue.ride = ride;

            for (let d = 0; d < DIRECTION_DELTAS.length; d++) {
                pending.push({ x: at.x + DIRECTION_DELTAS[d].dx, y: at.y + DIRECTION_DELTAS[d].dy });
            }
        }
    }

    private findRide(id: number): FakeRide | undefined {
        for (let i = 0; i < this.rides.length; i++) {
            if (this.rides[i].id === id) {
                return this.rides[i];
            }
        }

        return undefined;
    }

    public install(): () => void {
        return installGlobals(this);
    }
}

function installGlobals(game: FakeGame): () => void {
    const scope = globalThis as unknown as Record<string, unknown>;

    const fakeMap = {
        size: { x: game.width, y: game.height },
        get rides() { return game.rides; },
        getTile: function (x: number, y: number) {
            if (!game.inBounds(x, y)) {
                return { numElements: 0, getElement: function () { return undefined; } };
            }

            const tile = game.tile(x, y);
            return {
                numElements: tile.elements.length,
                getElement: function (index: number) { return tile.elements[index]; }
            };
        },
        getRide: function (id: number) {
            return game.rides.filter(function (ride) { return ride.id === id; })[0];
        },
        getAllEntities: function (type: string) {
            if (type === "staff") {
                return game.staff;
            }

            if (type === "guest") {
                return game.guests;
            }

            return [];
        }
    };

    const fakeContext = {
        executeAction: function (name: string, args: Record<string, unknown>, callback?: (r: Record<string, unknown>) => void) {
            const action = { name: name, args: args, callback: callback };
            game.attempted.push(action);

            if (!game.inert) {
                game.pending.push(action);
            }
        },
        queryAction: function () { /* no-op */ },
        get gameSpeed() { return game.gameValues.speed; },
        get paused() { return game.gameValues.paused; },
        /**
         * The plugin API's own setter, which is not a game action: it takes effect at once
         * rather than on a later tick. `inert` still holds it, because inert is the fake's
         * way of saying the world does not change, and a tool that got its way through a
         * setter there would report a pause the game never took.
         */
        set paused(value: boolean) {
            if (!game.inert) {
                game.gameValues.paused = value;
            }
        },
        getAllObjects: function () { return game.rideObjects; },
        getTrackSegment: function (type: number) {
            const offsets = TRACK_PIECE_OFFSETS[type];

            if (!offsets) {
                return null;
            }

            return {
                type: type,
                elements: offsets.map(function (o) { return { x: o.x * 32, y: o.y * 32, z: 0 }; })
            };
        },
        /**
         * The real game applies queued actions between ticks, so do that before the wait
         * ends. Long waits are watchdogs — a tool's 30 second timeout — and must not fire
         * just because work was queued; they are held so a test can trigger them itself.
         *
         * The delay is real time, and real time is what the simulation runs on, so the
         * clock moves by it too. Without that a tool could claim a wait it never took.
         */
        setTimeout: function (callback: () => void, delay?: number) {
            if (typeof delay === "number" && delay > FakeGame.WATCHDOG_THRESHOLD_MS) {
                game.watchdogs.push(callback);
                return game.watchdogs.length;
            }

            game.advanceRealMilliseconds(typeof delay === "number" ? delay : 0);
            game.applyQueuedActions();
            callback();
            return 0;
        }
    };

    const fakePark = {
        get cash() { return game.parkValues.cash; },
        get bankLoan() { return game.parkValues.bankLoan; },
        get maxBankLoan() { return game.parkValues.maxBankLoan; },
        get rating() { return game.parkValues.rating; },
        get guests() { return game.parkValues.guests; },
        get suggestedGuestMaximum() { return game.parkValues.suggestedGuestMaximum; },
        get entranceFee() { return game.parkValues.entranceFee; },
        /**
         * The plugin API's own setters, which are not game actions: they take effect at
         * once rather than on a later tick. `inert` still holds them, because inert is the
         * fake's way of saying the world does not change, and a tool that got its way
         * through a setter there would report a success the park never had.
         */
        set entranceFee(value: number) {
            if (!game.inert) {
                game.parkValues.entranceFee = value;
            }
        },
        get companyValue() { return game.parkValues.companyValue; },
        get landPrice() { return game.parkValues.landPrice; },
        get messages() { return game.messages; },
        getFlag: function (flag: string) { return game.parkFlags[flag] === true; },
        setFlag: function (flag: string, value: boolean) {
            if (!game.inert) {
                game.parkFlags[flag] = value;
            }
        },
        getMonthlyExpenditure: function (stream: string) {
            return game.expenditure[stream] || [0, 0, 0, 0];
        }
    };

    const previous = {
        map: scope.map, context: scope.context, park: scope.park,
        scenario: scope.scenario, date: scope.date
    };
    scope.map = fakeMap;
    scope.context = fakeContext;
    scope.park = fakePark;
    scope.scenario = game.scenario;
    scope.date = game.date;

    return function () {
        scope.map = previous.map;
        scope.context = previous.context;
        scope.park = previous.park;
        scope.scenario = previous.scenario;
        scope.date = previous.date;
    };
}
