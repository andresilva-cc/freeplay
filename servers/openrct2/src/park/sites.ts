import { DIRECTION_VECTORS, directionBetween, readMapGrid } from "./map.js";
import { flatRideShape, footprintOffsets, perimeterOffsets } from "./flatRides.js";
import type { MapGrid } from "./map.js";
import type { FlatRideShape, Offset } from "./flatRides.js";

/** How many door positions to return per site. */
const MAX_ACCESS_OPTIONS = 6;

export interface DoorTile {
    x: number;
    y: number;
    /** True when this tile is already a footpath, so a queue here would replace it. */
    isExistingPath: boolean;
}

/** One place an entrance or exit can go: the kiosk tile, and the tile its door opens onto. */
export interface AccessOption {
    x: number;
    y: number;
    /** Direction the building faces, pointing at the ride. */
    direction: number;
    door: DoorTile;
    /** Tiles from the door to the nearest existing footpath. 0 means it is already on one. */
    pathDistance: number;
}

export interface BuildSite {
    /** Origin tile to pass to build_flat_ride. */
    x: number;
    y: number;
    z: number;
    rotation: number;
    /** Tiles of the footprint holding scenery. 0 means bare ground; otherwise clear it first. */
    sceneryToClear: number;
    /** Door positions, nearest a path first. Not exhaustive for large footprints. */
    access: AccessOption[];
    /** How many positions exist in total, before this list was trimmed. */
    accessTotal: number;
    /** The shortest door-to-footpath distance among those options. */
    pathDistance: number;
}

export interface SiteSearchResult {
    ok: boolean;
    ride?: { name: string; rideType: number; width: number; depth: number };
    sites?: BuildSite[];
    /** How many sites matched before the list was cut to `limit`. */
    totalFound?: number;
    error?: string;
}

function areaState(grid: MapGrid, cx: number, cy: number, offsets: Offset[]): { z: number; scenery: number } | null {
    let z: number | null = null;
    let scenery = 0;

    for (let i = 0; i < offsets.length; i++) {
        const cell = grid.at(cx + offsets[i].dx, cy + offsets[i].dy);

        if (!cell || !cell.owned || !cell.flat || !cell.clearable) {
            return null;
        }

        if (!cell.clear) {
            scenery++;
        }

        if (z === null) {
            z = cell.baseZ;
        } else if (cell.baseZ !== z) {
            return null;
        }
    }

    return z === null ? null : { z: z, scenery: scenery };
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

/** Which way a perimeter tile faces: towards whichever footprint tile it touches. */
function facingDirection(offsets: Offset[], perimeter: Offset): number | null {
    for (let i = 0; i < offsets.length; i++) {
        const dx = offsets[i].dx - perimeter.dx;
        const dy = offsets[i].dy - perimeter.dy;

        if (Math.abs(dx) + Math.abs(dy) === 1) {
            return directionBetween({ x: 0, y: 0 }, { x: dx, y: dy });
        }
    }

    return null;
}

export function findBuildSites(rideObjectIndex: number, limit: number, rotation?: number): SiteSearchResult {
    const objects = context.getAllObjects("ride");

    if (rideObjectIndex < 0 || rideObjectIndex >= objects.length) {
        return { ok: false, error: "No ride object at index " + String(rideObjectIndex) + "." };
    }

    const rideObject = objects[rideObjectIndex];
    const rideType = rideObject.rideType[0];
    const shape: FlatRideShape | undefined = flatRideShape(rideType);

    if (typeof shape === "undefined") {
        return {
            ok: false,
            error: rideObject.name + " is not a flat ride: it is built from track, piece by piece, with evaluate."
        };
    }

    const grid = readMapGrid();
    const paths = collectPathTiles(grid);
    const rotations = typeof rotation === "number" ? [rotation % 4] : [0, 1];
    const found: BuildSite[] = [];

    for (let r = 0; r < rotations.length; r++) {
        const turn = rotations[r];
        const offsets = footprintOffsets(shape, turn);
        const perimeter = perimeterOffsets(offsets);

        for (let cy = 0; cy < grid.height; cy++) {
            for (let cx = 0; cx < grid.width; cx++) {
                const area = areaState(grid, cx, cy, offsets);

                if (area === null) {
                    continue;
                }

                const options: AccessOption[] = [];

                for (let p = 0; p < perimeter.length; p++) {
                    const tile = { x: cx + perimeter[p].dx, y: cy + perimeter[p].dy };
                    const cell = grid.at(tile.x, tile.y);

                    if (!cell || !cell.owned || !cell.flat || !cell.clear || cell.baseZ !== area.z) {
                        continue;
                    }

                    const direction = facingDirection(offsets, perimeter[p]);

                    if (direction === null) {
                        continue;
                    }

                    const outward = DIRECTION_VECTORS[(direction + 2) % 4];
                    const door = { x: tile.x + outward.dx, y: tile.y + outward.dy };
                    const doorCell = grid.at(door.x, door.y);

                    if (!doorCell || !doorCell.owned) {
                        continue;
                    }

                    options.push({
                        x: tile.x,
                        y: tile.y,
                        direction: direction,
                        door: { x: door.x, y: door.y, isExistingPath: doorCell.path },
                        pathDistance: nearestPathDistance(paths, door.x, door.y)
                    });
                }

                if (options.length < 2) {
                    continue;
                }

                // Every option is read by the model on every call, so return the ones
                // nearest a path rather than all twelve sides of a large footprint.
                options.sort(function (left, right) {
                    return left.pathDistance - right.pathDistance;
                });

                const shown = options.slice(0, MAX_ACCESS_OPTIONS);

                const shortest = shown[0].pathDistance;

                if (shortest === Infinity) {
                    continue;
                }

                found.push({
                    x: cx,
                    y: cy,
                    z: area.z,
                    rotation: turn,
                    sceneryToClear: area.scenery,
                    access: shown,
                    accessTotal: options.length,
                    pathDistance: shortest
                });
            }
        }
    }

    found.sort(function (left, right) {
        if (left.pathDistance !== right.pathDistance) {
            return left.pathDistance - right.pathDistance;
        }
        return left.sceneryToClear - right.sceneryToClear;
    });

    return {
        ok: true,
        ride: { name: rideObject.name, rideType: rideType, width: shape.width, depth: shape.depth },
        sites: found.slice(0, limit),
        totalFound: found.length
    };
}
