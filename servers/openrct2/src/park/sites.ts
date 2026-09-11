import { DIRECTION_VECTORS, directionBetween, readMapGrid } from "./map.js";
import { flatRideShape, footprintOffsets, perimeterOffsets } from "./flatRides.js";
import type { MapGrid } from "./map.js";
import type { FlatRideShape, Offset } from "./flatRides.js";

/** How many door positions to return per site, after every side is represented. */
const MAX_ACCESS_OPTIONS = 8;

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
    /** Which side of the ride this sits on, as an axis: "+x", "-x", "+y" or "-y".
     *  Two options sharing a side make a short, straight queue. */
    side: string;
    door: DoorTile;
    /** Trees or scenery stand on this tile or its door; clear_scenery them first. */
    needsClearing: boolean;
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
    /** Distance to the nearest footpath: from the best door, or from the shop itself.
     *  -1 when the park has no footpath at all. */
    pathDistance: number;
    /** Tiles to the nearest existing ride. Small numbers mean no room for queues between them. */
    nearestRideDistance: number;
}

export interface SiteSearchResult {
    ok: boolean;
    ride?: { name: string; rideType: number; width: number; depth: number; isShop: boolean };
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

/** Tiles already occupied by a ride, so new sites can report how tight the fit is. */
function collectRideTiles(): { x: number; y: number }[] {
    const tiles: { x: number; y: number }[] = [];

    for (let y = 0; y < map.size.y; y++) {
        for (let x = 0; x < map.size.x; x++) {
            const tile = map.getTile(x, y);

            for (let i = 0; i < tile.numElements; i++) {
                const type = tile.getElement(i).type;

                if (type === "track" || type === "entrance") {
                    tiles.push({ x: x, y: y });
                    break;
                }
            }
        }
    }

    return tiles;
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

/** -1 rather than Infinity, which JSON turns into null. */
function pathDistanceOrNone(paths: { x: number; y: number }[], x: number, y: number): number {
    const distance = nearestPathDistance(paths, x, y);
    return distance === Infinity ? -1 : distance;
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
 * The side of the footprint a tile sits on, indexed by the direction it faces. A door
 * facing direction 0 has the ride to its -x, so the door itself is on the +x side.
 * Named by axis rather than compass: the model reasons in tile coordinates, and the
 * screen's orientation is beside the point.
 */
const SIDE_NAMES = ["+x", "-y", "-x", "+y"];

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
    const rideTiles = collectRideTiles();
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

                    // Scenery is not a blocker here any more than it is on the footprint:
                    // a player fells it. Requiring bare ground dropped whole sites in a
                    // forest because a tree stood where the entrance would go.
                    if (!cell || !cell.owned || !cell.flat || !cell.clearable || cell.baseZ !== area.z) {
                        continue;
                    }

                    const direction = facingDirection(offsets, perimeter[p]);

                    if (direction === null) {
                        continue;
                    }

                    const outward = DIRECTION_VECTORS[(direction + 2) % 4];
                    const door = { x: tile.x + outward.dx, y: tile.y + outward.dy };
                    const doorCell = grid.at(door.x, door.y);

                    if (!doorCell || !doorCell.owned || !doorCell.clearable) {
                        continue;
                    }

                    options.push({
                        x: tile.x,
                        y: tile.y,
                        direction: direction,
                        side: SIDE_NAMES[direction % 4],
                        needsClearing: !cell.clear || !doorCell.clear,
                        door: { x: door.x, y: door.y, isExistingPath: doorCell.path },
                        pathDistance: pathDistanceOrNone(paths, door.x, door.y)
                    });
                }

                // A shop has no entrance or exit; it just needs a path beside it.
                if (!shape.isShop && options.length < 2) {
                    continue;
                }

                const rank = function (distance: number): number {
                    return distance < 0 ? Infinity : distance;
                };

                options.sort(function (left, right) {
                    return rank(left.pathDistance) - rank(right.pathDistance);
                });

                // Trimming purely by distance to a path can hide a whole side of the ride,
                // which quietly removes the option of putting both doors on one face. Take
                // the best of every side first, then fill the rest by distance.
                const shown: AccessOption[] = [];
                const sideSeen: Record<string, boolean> = {};

                for (let i = 0; i < options.length; i++) {
                    if (!sideSeen[options[i].side]) {
                        sideSeen[options[i].side] = true;
                        shown.push(options[i]);
                    }
                }

                for (let i = 0; i < options.length && shown.length < MAX_ACCESS_OPTIONS; i++) {
                    let already = false;

                    for (let j = 0; j < shown.length; j++) {
                        if (shown[j].x === options[i].x && shown[j].y === options[i].y) {
                            already = true;
                            break;
                        }
                    }

                    if (!already) {
                        shown.push(options[i]);
                    }
                }
                const distanceToPath = shape.isShop
                    ? nearestPathDistance(paths, cx, cy)
                    : (shown.length > 0 ? shown[0].pathDistance : Infinity);



                // A park with no footpath anywhere leaves every distance infinite. Dropping
                // those sites would report an empty park as an unbuildable one.
                if (distanceToPath === Infinity && paths.length > 0) {
                    continue;
                }

                let nearestRide = Infinity;
                for (let i = 0; i < rideTiles.length; i++) {
                    const distance = Math.abs(rideTiles[i].x - cx) + Math.abs(rideTiles[i].y - cy);
                    if (distance < nearestRide) {
                        nearestRide = distance;
                    }
                }

                found.push({
                    x: cx,
                    y: cy,
                    z: area.z,
                    rotation: turn,
                    sceneryToClear: area.scenery,
                    access: shown,
                    accessTotal: options.length,
                    nearestRideDistance: nearestRide === Infinity ? -1 : nearestRide,
                    pathDistance: distanceToPath === Infinity ? -1 : distanceToPath
                });
            }
        }
    }

    // Ordered by distance to a footpath only. Preferring bare ground over treed ground at
    // equal distance would be a preference, not a measurement; sceneryToClear is reported
    // so the caller can weigh it.
    found.sort(function (left, right) {
        const rank = function (distance: number): number {
            return distance < 0 ? Infinity : distance;
        };
        return rank(left.pathDistance) - rank(right.pathDistance);
    });

    // Returning the top N by path distance hands back the same spot N times, which reads
    // as N options and is not. Keep them a footprint apart so the choice is a real one.
    const spread = Math.max(shape.width, shape.depth) + 2;
    const chosen: BuildSite[] = [];

    for (let i = 0; i < found.length && chosen.length < limit; i++) {
        let tooClose = false;

        for (let c = 0; c < chosen.length; c++) {
            if (Math.abs(chosen[c].x - found[i].x) + Math.abs(chosen[c].y - found[i].y) < spread) {
                tooClose = true;
                break;
            }
        }

        if (!tooClose) {
            chosen.push(found[i]);
        }
    }

    return {
        ok: true,
        ride: { name: rideObject.name, rideType: rideType, width: shape.width, depth: shape.depth, isShop: shape.isShop },
        sites: chosen,
        totalFound: found.length
    };
}
