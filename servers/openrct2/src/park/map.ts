/**
 * A single pass over the map, cached per call, so site searching does not make
 * tens of thousands of native tile lookups.
 */

export interface SurfaceCell {
    owned: boolean;
    flat: boolean;
    /** Nothing on the tile at all. */
    clear: boolean;
    /** Only scenery, walls or banners are in the way: a bulldozer would fix it. */
    clearable: boolean;
    baseZ: number;
    path: boolean;
    queue: boolean;
    /**
     * The surface carries water above it. A lake bed is owned, level, at a height and empty,
     * so every other field here reads exactly like open ground and a placement on it came
     * back buildable until `trackplace` refused it, one `ridecreate` and one `ridedemolish`
     * later. `readGroundCensus` and `view_map` were already reading `waterHeight` off the
     * same surface element, so the park could call one tile water and buildable in one turn.
     */
    water: boolean;
}

/** Scenery a player can simply remove, as opposed to rides, paths and park structures. */
const REMOVABLE_TYPES: Record<string, boolean> = {
    small_scenery: true,
    large_scenery: true,
    wall: true,
    banner: true
};

export interface MapGrid {
    width: number;
    height: number;
    cells: SurfaceCell[];
    at(x: number, y: number): SurfaceCell | undefined;
}

export function readMapGrid(): MapGrid {
    const width = map.size.x;
    const height = map.size.y;
    const cells: SurfaceCell[] = [];

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const tile = map.getTile(x, y);
            let surface: SurfaceElement | null = null;
            let clear = true;
            let onlyRemovable = true;
            let path = false;
            let queue = false;

            for (let i = 0; i < tile.numElements; i++) {
                const element = tile.getElement(i);

                if (element.type === "surface") {
                    surface = element as SurfaceElement;
                    continue;
                }

                clear = false;

                if (!REMOVABLE_TYPES[element.type]) {
                    onlyRemovable = false;
                }

                if (element.type === "footpath") {
                    path = true;

                    if ((element as FootpathElement).isQueue) {
                        queue = true;
                    }
                }
            }

            cells.push({
                owned: surface !== null && surface.hasOwnership,
                flat: surface !== null && surface.slope === 0,
                clear: clear,
                clearable: clear || onlyRemovable,
                baseZ: surface !== null ? surface.baseZ : -1,
                path: path,
                queue: queue,
                water: surface !== null && typeof surface.waterHeight === "number" && surface.waterHeight > 0
            });
        }
    }

    return {
        width: width,
        height: height,
        cells: cells,
        at: function (x, y) {
            if (x < 0 || y < 0 || x >= width || y >= height) {
                return undefined;
            }
            return cells[y * width + x];
        }
    };
}

/** Tile coordinates to the world coordinates every game action expects. */
export function toWorld(tile: number): number {
    return tile * 32;
}

/**
 * OpenRCT2's TileDirectionDelta: 0 is -x, 1 is +y, 2 is +x, 3 is -y. Getting this
 * rotated by one puts every ride door on the wrong wall, which is invisible in the
 * API and obvious on screen.
 */
export const DIRECTION_VECTORS = [
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 1, dy: 0 },
    { dx: 0, dy: -1 }
];

/** ES5 target: no Math.sign. */
export function unitStep(value: number): number {
    if (value > 0) {
        return 1;
    }
    return value < 0 ? -1 : 0;
}

/** The direction that points from `from` to the adjacent tile `to`. */
export function directionBetween(from: { x: number; y: number }, to: { x: number; y: number }): number {
    for (let d = 0; d < DIRECTION_VECTORS.length; d++) {
        if (from.x + DIRECTION_VECTORS[d].dx === to.x && from.y + DIRECTION_VECTORS[d].dy === to.y) {
            return d;
        }
    }
    return 0;
}
