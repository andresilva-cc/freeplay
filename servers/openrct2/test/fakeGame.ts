/**
 * A minimal stand-in for the OpenRCT2 globals, enough to exercise src/park.
 *
 * Every bug worth catching here is "the tool says X, the game says Y", which cannot be
 * found by reading the code. The fake carries the pieces that produce those bugs: tile
 * ownership, scenery, footpaths and whether they are queues, and the fact that a game
 * action does not take effect until a later tick.
 */

export interface FakeElement {
    type: string;
    baseZ?: number;
    hasOwnership?: boolean;
    slope?: number;
    isQueue?: boolean;
    ride?: number | null;
    surfaceObject?: number | null;
    sequence?: number | null;
    object?: number;
    direction?: number;
}

export interface FakeTile {
    elements: FakeElement[];
}

export class FakeGame {
    public readonly width: number;
    public readonly height: number;
    private readonly tiles: FakeTile[];
    public readonly actions: { name: string; args: Record<string, unknown> }[] = [];
    /** Ride objects `context.getAllObjects("ride")` will return. */
    public rideObjects: { index: number; name: string; rideType: number[] }[] = [];

    public constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
        this.tiles = [];

        for (let i = 0; i < width * height; i++) {
            this.tiles.push({ elements: [{ type: "surface", baseZ: 96, hasOwnership: true, slope: 0 }] });
        }
    }

    public tile(x: number, y: number): FakeTile {
        return this.tiles[y * this.width + x];
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

    /** A three-tile park entrance, which is how the real one is recognised. */
    public addParkEntrance(x: number, y: number): void {
        for (let i = 0; i < 3; i++) {
            this.tile(x + i, y).elements.push({ type: "entrance", baseZ: 96, object: 2, sequence: i });
        }
    }

    /** Install as the OpenRCT2 globals. Returns a function that removes them again. */
    public install(): () => void {
        return installGlobals(this);
    }
}

function installGlobals(game: FakeGame): () => void {
        const scope = globalThis as unknown as Record<string, unknown>;

        const fakeMap = {
            size: { x: game.width, y: game.height },
            rides: [] as unknown[],
            getTile: function (x: number, y: number) {
                if (x < 0 || y < 0 || x >= game.width || y >= game.height) {
                    return { numElements: 0, getElement: function () { return undefined; } };
                }

                const tile = game.tile(x, y);
                return {
                    numElements: tile.elements.length,
                    getElement: function (index: number) { return tile.elements[index]; }
                };
            },
            getRide: function () { return undefined; },
            getAllEntities: function () { return []; }
        };

        const fakeContext = {
            executeAction: function (name: string, args: Record<string, unknown>) {
                // Queued, not applied: the real game defers to a later tick.
                game.actions.push({ name: name, args: args });
            },
            queryAction: function () { /* no-op */ },
            getAllObjects: function () { return game.rideObjects; },
            setTimeout: function (callback: () => void) { callback(); return 0; }
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
