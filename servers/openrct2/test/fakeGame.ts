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

interface QueuedAction {
    name: string;
    args: Record<string, unknown>;
    callback?: (result: Record<string, unknown>) => void;
}

/** Offsets of each flat-ride piece, as the real game reports them. */
const TRACK_PIECE_OFFSETS: Record<number, { x: number; y: number }[]> = {
    262: [{ x: 0, y: 0 }],
    264: [{ x: 0, y: 0 }],
    258: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
    266: [
        { x: -1, y: -1 }, { x: -1, y: 0 }, { x: -1, y: 1 },
        { x: 0, y: -1 }, { x: 0, y: 0 }, { x: 0, y: 1 },
        { x: 1, y: -1 }, { x: 1, y: 0 }, { x: 1, y: 1 }
    ],
    259: [
        { x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }, { x: 0, y: 3 },
        { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 3 },
        { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 2, y: 3 },
        { x: 3, y: 0 }, { x: 3, y: 1 }, { x: 3, y: 2 }, { x: 3, y: 3 }
    ],
    263: [{ x: -2, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }],
    261: [{ x: -2, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]
};

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

    public addParkEntrance(x: number, y: number): void {
        for (let i = 0; i < 3; i++) {
            this.tile(x + i, y).elements.push({ type: "entrance", baseZ: 96, object: 2, sequence: i });
        }
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

            for (let i = 0; i < offsets.length; i++) {
                const x = tileX + offsets[i].x;
                const y = tileY + offsets[i].y;

                if (!this.inBounds(x, y)) {
                    return { error: 1, errorTitle: "Off the map", errorMessage: "out of bounds" };
                }

                this.tile(x, y).elements.push({
                    type: "track", baseZ: 96, ride: args.ride as number, trackType: args.trackType as number
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
            this.rides = this.rides.filter(function (ride) { return ride.id !== (args.ride as number); });
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

            return { error: 0 };
        }

        if (action.name === "footpathremove") {
            const tile = this.tile(tileX, tileY);
            tile.elements = tile.elements.filter(function (e) { return e.type !== "footpath"; });
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

        return { error: 0 };
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
        getAllEntities: function () { return []; }
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

    const previous = { map: scope.map, context: scope.context, park: scope.park };
    scope.map = fakeMap;
    scope.context = fakeContext;
    scope.park = { messages: [], getFlag: function () { return false; } };

    return function () {
        scope.map = previous.map;
        scope.context = previous.context;
        scope.park = previous.park;
    };
}
