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
    slope?: number;
    isQueue?: boolean;
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
    excitement: number;
    intensity: number;
    totalCustomers: number;
    totalProfit: number;
    downtime: number;
    reliability: number;
    flags: number;
    value: number;
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
        companyValue: 150000
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
    /** The in-game date, as `date` reports it. Month is the index within the year. */
    public readonly date = { year: 1, month: 0, day: 1 };
    /** Long waits, held rather than fired. Call `fireWatchdogs()` to test a timeout. */
    public readonly watchdogs: (() => void)[] = [];
    /** Waits longer than this are treated as watchdogs rather than ticks. */
    public static readonly WATCHDOG_THRESHOLD_MS = 5000;

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

    public addScenery(x: number, y: number, type = "small_scenery"): void {
        this.tile(x, y).elements.push({ type: type, baseZ: 96, object: 0, direction: 0 });
    }

    public addPath(x: number, y: number, queue = false, ride: number | null = null): void {
        this.tile(x, y).elements.push({
            type: "footpath", baseZ: 96, isQueue: queue, ride: ride, surfaceObject: queue ? 11 : 0
        });
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
        this.updateQueueChains();
    }

    public addParkEntrance(x: number, y: number): void {
        for (let i = 0; i < 3; i++) {
            this.tile(x + i, y).elements.push({ type: "entrance", baseZ: 96, object: 2, sequence: i });
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
        const args = action.args as Record<string, number & boolean>;
        const tileX = Math.floor((args.x as number) / 32);
        const tileY = Math.floor((args.y as number) / 32);

        if (action.name === "ridecreate") {
            const id = this.nextRideId++;
            this.rides.push({
                id: id, name: "Ride " + String(id), type: args.rideType as number, status: "closed",
                price: [0], stations: [{ start: null, entrance: null, exit: null, length: 0, queueTime: 0 }],
                excitement: -1, intensity: -1, totalCustomers: 0, totalProfit: 0,
                downtime: 0, reliability: 100, flags: 0, value: 40
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
            this.staff.push({ staffType: STAFF_TYPE_NAMES[args.staffType as number] || "handyman" });
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
                    type: "footpath", baseZ: 96, isQueue: isQueue, ride: null, surfaceObject: args.object as number
                });
            }

            this.updateQueueChains();
            return { error: 0 };
        }

        if (action.name === "footpathremove") {
            const tile = this.tile(tileX, tileY);
            tile.elements = tile.elements.filter(function (e) { return e.type !== "footpath"; });
            this.updateQueueChains();
            return { error: 0 };
        }

        if (action.name === "smallsceneryremove" || action.name === "largesceneryremove"
            || action.name === "wallremove" || action.name === "bannerremove") {
            const removing = action.name.replace("remove", "");
            const type = removing === "smallscenery" ? "small_scenery"
                : (removing === "largescenery" ? "large_scenery" : removing);
            const tile = this.tile(tileX, tileY);
            tile.elements = tile.elements.filter(function (e) { return e.type !== type; });
            return { error: 0 };
        }

        // An action the fake does not model must not read as one that worked. Answering
        // `error: 0` to anything at all is the same lie the tools are being tested for.
        throw new Error("the fake game does not apply the \"" + action.name + "\" action");
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
         */
        setTimeout: function (callback: () => void, delay?: number) {
            if (typeof delay === "number" && delay > FakeGame.WATCHDOG_THRESHOLD_MS) {
                game.watchdogs.push(callback);
                return game.watchdogs.length;
            }

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
