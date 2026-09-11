import { DIRECTION_VECTORS, directionBetween, readMapGrid } from "./map.js";
import type { MapGrid } from "./map.js";

export interface DoorTile {
    x: number;
    y: number;
    /** True when this tile is already a footpath, so a queue here would replace it. */
    isExistingPath: boolean;
}

/** One place an entrance or exit can go: the kiosk tile, and the tile its door opens onto. */
export interface AccessOption {
    /** Tile the entrance or exit building occupies. */
    x: number;
    y: number;
    /** Direction the building faces, pointing at the ride. */
    direction: number;
    /** The tile in front of the door, where a queue or path must reach. */
    door: DoorTile;
    /** Tiles from the door to the nearest existing footpath. 0 means the door is already on one. */
    pathDistance: number;
}

export interface BuildSite {
    x: number;
    y: number;
    z: number;
    size: number;
    /**
     * Every tile around the footprint where an entrance or exit will fit. Pick any two:
     * they may sit on the same side, which usually gives a shorter, tidier queue than
     * putting them on opposite sides.
     */
    access: AccessOption[];
    /** The shortest door-to-footpath distance among those options. */
    pathDistance: number;
}

/** Track piece for a square flat ride of a given footprint, from OpenRCT2's track table. */
const FLAT_TRACK_BY_SIZE: Record<number, number | undefined> = {
    1: 262,
    2: 258,
    3: 266,
    4: 259
};

export function flatTrackTypeForSize(size: number): number | undefined {
    return FLAT_TRACK_BY_SIZE[size];
}

function squareIsBuildable(grid: MapGrid, cx: number, cy: number, size: number): number | null {
    const half = Math.floor(size / 2);
    let z: number | null = null;

    for (let dx = -half; dx <= half; dx++) {
        for (let dy = -half; dy <= half; dy++) {
            const cell = grid.at(cx + dx, cy + dy);

            if (!cell || !cell.owned || !cell.flat || !cell.clear) {
                return null;
            }

            if (z === null) {
                z = cell.baseZ;
            } else if (cell.baseZ !== z) {
                return null;
            }
        }
    }

    return z;
}

function tileIsFree(grid: MapGrid, x: number, y: number, z: number): boolean {
    const cell = grid.at(x, y);
    return !!cell && cell.owned && cell.flat && cell.clear && cell.baseZ === z;
}

function collectPathTiles(grid: MapGrid): { x: number; y: number }[] {
    const tiles: { x: number; y: number }[] = [];

    for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
            const cell = grid.at(x, y);
            if (cell && cell.path) {
                tiles.push({ x: x, y: y });
            }
        }
    }

    return tiles;
}

function nearestPathDistance(paths: { x: number; y: number }[], x: number, y: number): number {
    let best = Infinity;

    for (let i = 0; i < paths.length; i++) {
        const distance = Math.abs(paths[i].x - x) + Math.abs(paths[i].y - y);
        if (distance < best) {
            best = distance;
        }
    }

    return best;
}

/**
 * Sites are ranked by how far the entrance is from the existing footpath network.
 * A correctly built ride that guests cannot walk to is worthless, and that is the
 * mistake this ordering exists to prevent.
 */
export function findBuildSites(size: number, limit: number): BuildSite[] {
    const grid = readMapGrid();
    const paths = collectPathTiles(grid);
    const half = Math.floor(size / 2);
    const found: BuildSite[] = [];

    for (let cy = 0; cy < grid.height; cy++) {
        for (let cx = 0; cx < grid.width; cx++) {
            const z = squareIsBuildable(grid, cx, cy, size);

            if (z === null) {
                continue;
            }

            const options: AccessOption[] = [];
            const half2 = half;

            for (let d = 0; d < DIRECTION_VECTORS.length; d++) {
                const outward = DIRECTION_VECTORS[d];
                // Walk the whole side, not just its middle tile.
                for (let offset = -half2; offset <= half2; offset++) {
                    const along = { dx: outward.dy, dy: outward.dx };
                    const tile = {
                        x: cx + outward.dx * (half2 + 1) + along.dx * offset,
                        y: cy + outward.dy * (half2 + 1) + along.dy * offset
                    };

                    if (!tileIsFree(grid, tile.x, tile.y, z)) {
                        continue;
                    }

                    const towardsRide = { x: tile.x - outward.dx, y: tile.y - outward.dy };
                    const door = { x: tile.x + outward.dx, y: tile.y + outward.dy };
                    const doorCell = grid.at(door.x, door.y);

                    if (!doorCell || !doorCell.owned) {
                        continue;
                    }

                    options.push({
                        x: tile.x,
                        y: tile.y,
                        direction: directionBetween(tile, towardsRide),
                        door: { x: door.x, y: door.y, isExistingPath: doorCell.path },
                        pathDistance: nearestPathDistance(paths, door.x, door.y)
                    });
                }
            }

            if (options.length < 2) {
                continue;
            }

            let shortest = Infinity;
            for (let i = 0; i < options.length; i++) {
                if (options[i].pathDistance < shortest) {
                    shortest = options[i].pathDistance;
                }
            }

            if (shortest === Infinity) {
                continue;
            }

            found.push({
                x: cx,
                y: cy,
                z: z,
                size: size,
                access: options,
                pathDistance: shortest
            });
        }
    }

    found.sort(function (left, right) {
        return left.pathDistance - right.pathDistance;
    });

    return found.slice(0, limit);
}
