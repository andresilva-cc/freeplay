import { DIRECTION_VECTORS, directionBetween, readMapGrid } from "./map.js";
import { findParkEntranceTiles } from "./paths.js";
import { flatRideShape, footprintOffsets, perimeterOffsets, shopServingTile } from "./flatRides.js";
import type { MapGrid } from "./map.js";
import type { FlatRideShape, Offset } from "./flatRides.js";

/** How many door positions to return per site, after every side is represented. */
export const MAX_ACCESS_OPTIONS = 8;

/** A run of footpath the park gate reaches nothing of, named the way park_status names it. */
export interface StrandedIsland {
    /** Footpath tiles in the fragment. */
    tiles: number;
    /** The two corners it spans, which is how park_status lists it under `paths.islands`. */
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
}

export interface DoorTile {
    x: number;
    y: number;
    /** True when this tile is already a footpath, so a queue here would replace it. */
    isExistingPath: boolean;
    /** A guest can walk here from the park gate today - the same question park_status asks
     *  of a ride it has already built, under the same name. False on bare ground, which
     *  nothing leads to yet and `pathDistance` prices; false as well on a footpath the gate
     *  cannot reach, which looks identical to the main walk from the tile itself and takes
     *  no guests. Measured over the game's own footpath edges, so a line the game has cut -
     *  a queue another ride claimed - reads as cut here too. */
    guestsCanReach: boolean;
    /** True when a queue already stands here bound to no ride - what a demolished ride
     *  leaves behind. It is not in the way: placing the entrance chains it to the new ride,
     *  so the queue is done before it is built. A queue bound to another ride is a
     *  different thing, and those tiles are not offered at all. */
    hasUnboundQueue: boolean;
    /** Set only when this tile carries a footpath the gate cannot reach: the fragment it
     *  belongs to. A ride whose queue joins one takes no guests until the fragment itself
     *  is joined to the network. */
    island?: StrandedIsland;
}

/** One place an entrance or exit can go: the kiosk tile, and the tile its door opens onto. */
export interface AccessOption {
    x: number;
    y: number;
    /** Direction the building faces, pointing at the ride. */
    direction: number;
    /** Which side of the ride this sits on, as an axis: "+x", "-x", "+y" or "-y".
     *  Two options sharing a side put both doors on one face of the ride. */
    side: string;
    /** The tile the door opens onto, where a queue goes. Absent for a shop, which is
     *  served from the `x`,`y` tile itself and has no door. */
    door?: DoorTile;
    /** Trees or scenery stand on this tile or its door; clear_scenery them first. */
    needsClearing: boolean;
    /** Tiles from the door to the nearest footpath the park gate reaches. 0 means the door
     *  already stands on that network. -1 when the gate reaches no footpath at all.
     *  Measured against the reachable network rather than against paving anywhere, because
     *  a stranded fragment is still paving: a door standing on one read 0 - the same number
     *  as a door on the main walk, and the first place this list sorts to - while no guest
     *  could ever arrive at it. */
    pathDistance: number;
    /** How many path tiles stop being reachable from the park entrance once an entrance
     *  here claims a queue on `door`. A ride claiming a queue dead-ends the one tile its
     *  door opens onto, so this is what the park loses if that tile stops carrying traffic
     *  through. A door on bare ground is 0: the queue tiles leading to it are new ground
     *  that carried nobody before. A door the gate cannot reach is 0 as well, for the
     *  opposite reason - there is no route through it to lose - so the figure says what it
     *  says only beside `door.guestsCanReach`. The rest of a queue line is walked like any
     *  other path and cuts nothing. A measurement of what would happen, not a ranking: the
     *  list is not reordered by it. */
    queueCutsOff: number;
}

export interface BuildSite {
    /** Origin tile to pass to build_flat_ride. Inside the footprint, but not a corner of
     *  it: a 3x3 is centred on its origin and a 1x4 runs -2..+1 from it. */
    x: number;
    y: number;
    z: number;
    rotation: number;
    /** The ground the ride will stand on, as two inclusive corners. These are clear_scenery's
     *  four rectangle arguments under the same names, so they cross unchanged. Read from the
     *  tiles the game lays for this piece at this rotation, never from width and depth: a 4x4
     *  runs 0..3 from its origin while a 1x4 runs -2..+1, so a square centred on `x`,`y` is
     *  the wrong ground for every footprint but a 3x3. */
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    /** Tiles of the footprint holding scenery. 0 means bare ground; otherwise clear it first. */
    sceneryToClear: number;
    /** Door positions, nearest a path first. Not exhaustive for large footprints. */
    access: AccessOption[];
    /** How many positions exist in total, before this list was trimmed. */
    accessTotal: number;
    /** Distance to the nearest footpath the park gate reaches: from the best door, or from
     *  the shop's serving tile. -1 when the gate reaches no footpath at all. */
    pathDistance: number;
    /** Tiles to the nearest existing ride. Small numbers mean no room for queues between them. */
    nearestRideDistance: number;
}

export interface SiteSearchResult {
    ok: boolean;
    /** What was searched for. `width` and `depth` are the ride's size for reference only:
     *  the ground a site needs cleared is that site's own fromX/fromY/toX/toY, never a
     *  rectangle worked out from these two numbers. */
    ride?: { name: string; rideType: number; width: number; depth: number; isShop: boolean };
    sites?: BuildSite[];
    /** How many sites matched before the list was cut to `limit`. */
    totalFound?: number;
    /** What `access` means for this ride, or - when `sites` is empty - which constraint
     *  nothing satisfied, so the caller knows what to change. */
    note?: string;
    error?: string;
}

function key(x: number, y: number): string {
    return String(x) + "," + String(y);
}

/**
 * The ride a queue on this tile is chained to, or null when it is bound to nothing.
 *
 * Read from the live tile rather than from the cached grid, because the grid carries only
 * "is a queue" and this is asked about a handful of tiles. The distinction is the one
 * build_flat_ride draws: an unbound queue at a door is a finished queue waiting for its
 * ride, and a queue already chained to another ride would be stolen from it.
 */
function queueBoundTo(x: number, y: number): number | null {
    const tile = map.getTile(x, y);

    for (let i = 0; i < tile.numElements; i++) {
        const element = tile.getElement(i);

        if (element.type !== "footpath") {
            continue;
        }

        const path = element as FootpathElement;

        if (path.isQueue && path.ride !== null && typeof path.ride === "number") {
            return path.ride;
        }
    }

    return null;
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

/**
 * The footpath tiles a guest can actually walk to from the gate, which is what every
 * distance here is measured against.
 *
 * This swept the whole grid for anything carrying a footpath. Paving the gate reaches
 * nothing of counted the same as the main walk, so a door standing on a stranded fragment
 * came back `pathDistance` 0 with `isExistingPath` true - the markers of the best door in
 * the park - and sorted to the top of a list the model takes the first entry of. Two rides
 * of one run went onto a five-tile island that park_status had named as stranded in the
 * turn before.
 */
function reachablePathTiles(grid: MapGrid, reachable: Record<string, boolean>): { x: number; y: number }[] {
    const tiles: { x: number; y: number }[] = [];

    for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
            const cell = grid.at(x, y);
            if (cell && cell.path && reachable[key(x, y)]) {
                tiles.push({ x: x, y: y });
            }
        }
    }

    return tiles;
}

/**
 * The fragments of footpath the gate reaches nothing of, keyed by every tile on one, so a
 * door standing on a fragment can name it.
 *
 * Grouped by plain adjacency rather than by route, which is how `network.ts` groups the
 * same fragments for park_status's `paths.islands`: an island is a physical thing, and the
 * two reports naming one thing differently is the state the model cannot reconcile.
 */
function strandedIslands(grid: MapGrid, reachable: Record<string, boolean>): Record<string, StrandedIsland> {
    const found: Record<string, StrandedIsland> = {};

    for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
            const cell = grid.at(x, y);

            if (!cell || !cell.path || reachable[key(x, y)] || found[key(x, y)]) {
                continue;
            }

            const blob: { x: number; y: number }[] = [];
            const pending: { x: number; y: number }[] = [{ x: x, y: y }];
            const seen: Record<string, boolean> = {};
            seen[key(x, y)] = true;

            while (pending.length > 0) {
                const current = pending.shift() as { x: number; y: number };
                blob.push(current);

                for (let i = 0; i < NEIGHBOURS.length; i++) {
                    const nx = current.x + NEIGHBOURS[i].dx;
                    const ny = current.y + NEIGHBOURS[i].dy;
                    const neighbour = grid.at(nx, ny);

                    if (!neighbour || !neighbour.path || reachable[key(nx, ny)] || seen[key(nx, ny)]) {
                        continue;
                    }

                    seen[key(nx, ny)] = true;
                    pending.push({ x: nx, y: ny });
                }
            }

            const island: StrandedIsland = {
                tiles: blob.length,
                fromX: blob[0].x,
                fromY: blob[0].y,
                toX: blob[0].x,
                toY: blob[0].y
            };

            for (let i = 0; i < blob.length; i++) {
                island.fromX = Math.min(island.fromX, blob[i].x);
                island.fromY = Math.min(island.fromY, blob[i].y);
                island.toX = Math.max(island.toX, blob[i].x);
                island.toY = Math.max(island.toY, blob[i].y);
                found[key(blob[i].x, blob[i].y)] = island;
            }
        }
    }

    return found;
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

const NEIGHBOURS = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];

/**
 * The four directions in OpenRCT2's own order, so the index is the bit position in a
 * footpath's `edges`: 0 is -x, 1 is +y, 2 is +x, 3 is -y. This is `CoordsDirectionDelta`,
 * kept separate from `NEIGHBOURS`, whose order is arbitrary.
 */
const EDGE_DIRECTIONS = [{ dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 1, dy: 0 }, { dx: 0, dy: -1 }];

/** The bit in `edges` that points the other way down the same link. */
function opposite(direction: number): number {
    return (direction + 2) % 4;
}

/**
 * The sides a guest may step off each footpath tile, as the game records them.
 *
 * `readMapGrid` carries whether a tile has a path but not its `edges`, and the edges are
 * the connectivity rather than a hint about it - `PathGetPermittedEdges` hands the guest
 * pathfinder that bitfield verbatim. `src/park/paths.ts` has the measurement. Only tiles
 * the grid already calls a path are read, so this costs one native lookup per footpath
 * rather than one per tile.
 */
function readPathEdges(grid: MapGrid): Record<string, number> {
    const edges: Record<string, number> = {};

    for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
            const cell = grid.at(x, y);

            if (!cell || !cell.path) {
                continue;
            }

            const tile = map.getTile(x, y);
            let bits = 0;

            for (let i = 0; i < tile.numElements; i++) {
                const element = tile.getElement(i);

                if (element.type === "footpath") {
                    // Only the low nibble is the four orthogonal edges; the high nibble is corners.
                    bits |= (element as FootpathElement).edges & 0x0f;
                }
            }

            edges[key(x, y)] = bits;
        }
    }

    return edges;
}

/**
 * Path tiles guests can walk to from the park entrance, optionally with one named tile
 * treated as a dead end: reachable, but carrying nobody through to the far side.
 *
 * The same walk as paths.ts `walkableFromParkEntrance` over the same graph - the game's own
 * footpath edges, with both ends of a link required to claim it - so this tool and
 * park_status answer "can a guest get there" the same way. It stood on plain adjacency over
 * the cached grid instead, which agrees with the game only where the game has cut no link:
 * a queue another ride has claimed, the one cut the game actually makes, read as a road
 * still open.
 *
 * A queue is walked like any other path. The rule that stood here - a queue tile expands
 * only to other queue tiles - is not what the game does: turning path into queue moves no
 * edge bit at all. A ride's entrance claiming a queue is what severs, and it dead-ends the
 * single tile the door opens onto, which is exactly what `deadEnd` models.
 */
function walkableFrom(edges: Record<string, number>, gate: { x: number; y: number }[], deadEnd: string | null): Record<string, boolean> {
    const seen: Record<string, boolean> = {};
    const frontier: { x: number; y: number }[] = [];

    for (let g = 0; g < gate.length; g++) {
        for (let i = 0; i < NEIGHBOURS.length; i++) {
            const x = gate[g].x + NEIGHBOURS[i].dx;
            const y = gate[g].y + NEIGHBOURS[i].dy;

            if (typeof edges[key(x, y)] === "number" && !seen[key(x, y)]) {
                seen[key(x, y)] = true;
                frontier.push({ x: x, y: y });
            }
        }
    }

    while (frontier.length > 0) {
        const current = frontier.shift() as { x: number; y: number };

        // Reached, and that is as far as it goes: a claimed door tile is where the line ends.
        if (key(current.x, current.y) === deadEnd) {
            continue;
        }

        const from = edges[key(current.x, current.y)];

        for (let d = 0; d < EDGE_DIRECTIONS.length; d++) {
            if ((from & (1 << d)) === 0) {
                continue;
            }

            const x = current.x + EDGE_DIRECTIONS[d].dx;
            const y = current.y + EDGE_DIRECTIONS[d].dy;
            const to = edges[key(x, y)];

            if (seen[key(x, y)] || typeof to !== "number" || (to & (1 << opposite(d))) === 0) {
                continue;
            }

            seen[key(x, y)] = true;
            frontier.push({ x: x, y: y });
        }
    }

    return seen;
}

/**
 * The side of the footprint a tile sits on, indexed by the direction it faces. A door
 * facing direction 0 has the ride to its -x, so the door itself is on the +x side.
 * Named by axis rather than compass: the model reasons in tile coordinates, and the
 * screen's orientation is beside the point.
 */
const SIDE_NAMES = ["+x", "-y", "-x", "+y"];

/** The two corners the footprint spans, so a site can name the ground to clear. */
function footprintBounds(offsets: Offset[]): { minDx: number; minDy: number; maxDx: number; maxDy: number } {
    let minDx = offsets[0].dx;
    let minDy = offsets[0].dy;
    let maxDx = offsets[0].dx;
    let maxDy = offsets[0].dy;

    for (let i = 1; i < offsets.length; i++) {
        minDx = Math.min(minDx, offsets[i].dx);
        minDy = Math.min(minDy, offsets[i].dy);
        maxDx = Math.max(maxDx, offsets[i].dx);
        maxDy = Math.max(maxDy, offsets[i].dy);
    }

    return { minDx: minDx, minDy: minDy, maxDx: maxDx, maxDy: maxDy };
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

/**
 * Which constraint nothing got past, so the caller knows what to change rather than
 * re-guessing coordinates. "Nothing found" with no reason produced whole turns of the
 * model inventing tiles instead of asking a different question.
 *
 * It names the constraint and stops there. Naming a lever - buy land, level it, clear the
 * scenery - picks which constraint to relax, which is the caller's call, and two of those
 * three were false here anyway: no tool levels ground, and scenery never disqualifies a
 * tile in the first place, so clear_scenery could not have changed either answer.
 */
function whyNothingFound(shape: FlatRideShape, footprintFits: number, accessFits: number): string {
    const size = String(shape.width) + "x" + String(shape.depth);

    if (footprintFits === 0) {
        return "Nothing found: nowhere in the park is a " + size + " block of owned, level tiles all at"
            + " one height. Trees do not count against it, but rides, paths and slopes do.";
    }

    if (accessFits === 0) {
        return shape.isShop
            ? "Nothing found: " + String(footprintFits) + " tiles fit the shop, but on every one the"
                + " serving tile - its neighbour in direction `rotation` - is unowned, sloped, at a"
                + " different height, or carries something other than scenery or an ordinary footpath."
            : "Nothing found: " + String(footprintFits) + " places fit the " + size + " footprint, but none"
                + " has two usable tiles beside it, and a ride needs one for the entrance and one for the"
                + " exit. A tile counts only when it is owned, level, at the ride's height and carrying"
                + " nothing but scenery, and the tile its door opens onto is owned and carries nothing but"
                + " scenery, a footpath, or a queue belonging to no ride. Scenery alone never disqualifies"
                + " either.";
    }

    return "Nothing found: " + String(accessFits) + " places fit with room for doors, but none could be"
        + " measured against a footpath.";
}

export function findBuildSites(rideObjectIndex: number, limit: number, rotation?: number): SiteSearchResult {
    const objects = context.getAllObjects("ride");
    // Indexed by `.index`, not by position: `list_ride_objects` reports `.index`, and the
    // two only coincide while the loaded object list has no gaps in it. build_flat_ride
    // resolves it the same way, and a tool that disagrees with it hands back sites measured
    // for one ride and then builds another, with every step reporting success.
    let rideObject: RideObject | undefined;

    for (let i = 0; i < objects.length; i++) {
        if (objects[i].index === rideObjectIndex) {
            rideObject = objects[i];
            break;
        }
    }

    if (!rideObject) {
        return {
            ok: false,
            error: "No ride object has index " + String(rideObjectIndex) + "."
                + " `rideObject` is the `index` field of an entry from list_ride_objects, which is not the same"
                + " as its position in that list. Call list_ride_objects and copy the `index` of the ride you want."
        };
    }

    const rideType = rideObject.rideType[0];
    const shape: FlatRideShape | undefined = flatRideShape(rideType);

    if (typeof shape === "undefined") {
        return {
            ok: false,
            error: rideObject.name + " is not a flat ride: it is built from track, piece by piece, with evaluate."
        };
    }

    const grid = readMapGrid();
    const rideTiles = collectRideTiles();
    const gate = findParkEntranceTiles();
    const edges = readPathEdges(grid);
    const reachableNow = gate.length > 0 ? walkableFrom(edges, gate, null) : {};
    // Everything a distance is measured against, and everything it is not: paving the gate
    // reaches, and the fragments it does not.
    const paths = reachablePathTiles(grid, reachableNow);
    const islands = strandedIslands(grid, reachableNow);

    // The answer is a property of the footpath tile, not of the door, and thousands of
    // doors share a handful of footpaths, so it is measured once per tile and kept. Only a
    // tile the gate reaches can cut anything: a queue laid on bare ground adds to the
    // network and takes no route out of it, and a stranded fragment has no route to take.
    // A reachable tile already carrying a queue counts - an entrance placed here claims
    // that queue and dead-ends this tile, which is the `hasUnboundQueue` door the search
    // offers as a finished one.
    const severance: Record<string, number> = {};

    const costOfDeadEnding = function (x: number, y: number): number {
        const tile = key(x, y);

        // Only a tile guests reach today has a route through it to lose. Bare ground carries
        // nobody, and neither does paving on a fragment the gate cannot reach: dead-ending
        // one of those takes nothing from anyone, which is a true 0 and a different 0 from
        // the one a door on the network earns.
        if (gate.length === 0 || !reachableNow[tile]) {
            return 0;
        }

        if (typeof severance[tile] === "number") {
            return severance[tile];
        }

        const after = walkableFrom(edges, gate, tile);
        let lost = 0;

        for (const reached in reachableNow) {
            if (reachableNow[reached] && !after[reached]) {
                lost++;
            }
        }

        severance[tile] = lost;
        return lost;
    };

    // An entrance built here claims whatever queue reaches its door, and claiming it
    // dead-ends that one tile. So the cost is the door tile's own, and nothing else's.
    //
    // This used to charge a door standing on bare ground for the worst of its four
    // neighbours, on the theory that the queue run to it would block the footpath it
    // joined. It does not: a queue no ride has claimed is walked like any other path, and
    // the tiles the run adds are new ground that carried nobody before. That door is 0 -
    // measured, not assumed - and the old figure told the model that putting a ride beside
    // the trunk path would cut the park in half. Reported, never used to reorder: which
    // tile to use is the player's call.
    const queueCutsOffAt = function (x: number, y: number): number {
        return costOfDeadEnding(x, y);
    };

    // A square footprint occupies the same tiles either way round, so searching both
    // finds every position twice and doubles totalFound. A shop is the exception: it is
    // 1x1, but its rotation is the one thing that decides which neighbour guests are
    // served from, so all four are genuinely different placements.
    const squareFootprint = shape.width === shape.depth;
    const rotations = typeof rotation === "number"
        ? [((rotation % 4) + 4) % 4]
        : (shape.isShop ? [0, 1, 2, 3] : (squareFootprint ? [0] : [0, 1]));
    const found: BuildSite[] = [];
    let footprintFits = 0;
    let accessFits = 0;

    for (let r = 0; r < rotations.length; r++) {
        const turn = rotations[r];
        const offsets = footprintOffsets(shape, turn);
        const perimeter = perimeterOffsets(offsets);
        const bounds = footprintBounds(offsets);

        for (let cy = 0; cy < grid.height; cy++) {
            for (let cx = 0; cx < grid.width; cx++) {
                const area = areaState(grid, cx, cy, offsets);

                if (area === null) {
                    continue;
                }

                footprintFits++;
                const options: AccessOption[] = [];

                if (shape.isShop) {
                    // Measured in the game by ringing a stall with four paths: only the
                    // neighbour in direction `rotation` formed a footpath edge to it. The
                    // other three touch the shop and serve nobody. There is no door beyond
                    // it either - a queue tile one further out is a tile too far.
                    const serving = shopServingTile(cx, cy, turn);
                    const cell = grid.at(serving.x, serving.y);

                    // A footpath here is the best case, not a blocker: the shop is already
                    // served. Demanding bare ground threw away every stall position that was
                    // beside the park's paths, which is every position worth having. A queue
                    // is a blocker, though - guests in a queue buy nothing.
                    if (cell && cell.owned && cell.flat && cell.baseZ === area.z
                        && (cell.clearable || (cell.path && !cell.queue))) {
                        const facing = (turn + 2) % 4;

                        options.push({
                            x: serving.x,
                            y: serving.y,
                            direction: facing,
                            side: SIDE_NAMES[facing],
                            needsClearing: !cell.clear && !cell.path,
                            pathDistance: pathDistanceOrNone(paths, serving.x, serving.y),
                            queueCutsOff: 0
                        });
                    }
                } else {
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

                        // A door onto the path network the gate reaches is the shortest work
                        // there is - pathDistance 0, nothing to lay but the queue itself.
                        // Requiring bare ground here quietly discarded exactly those, and left
                        // `isExistingPath` a flag that could never be true. A door onto paving
                        // the gate does not reach looks identical from this tile and is not the
                        // same thing at all, which is what `guestsCanReach` below separates.
                        if (!doorCell || !doorCell.owned || (!doorCell.clearable && !doorCell.path)) {
                            continue;
                        }

                        // The one queue that is a blocker, and it is the same line
                        // build_flat_ride draws: a queue chained to another ride would be
                        // re-chained to this one, leaving that ride with none. An unbound
                        // queue is a working door - the entrance chains it when it is placed -
                        // and refusing those made a demolished ride's own spot unbuildable.
                        const boundTo = doorCell.queue ? queueBoundTo(door.x, door.y) : null;

                        if (boundTo !== null) {
                            continue;
                        }

                        options.push({
                            x: tile.x,
                            y: tile.y,
                            direction: direction,
                            side: SIDE_NAMES[direction % 4],
                            needsClearing: !cell.clear || (!doorCell.clear && !doorCell.path),
                            door: {
                                x: door.x,
                                y: door.y,
                                isExistingPath: doorCell.path,
                                guestsCanReach: reachableNow[key(door.x, door.y)] === true,
                                hasUnboundQueue: doorCell.queue,
                                island: islands[key(door.x, door.y)]
                            },
                            pathDistance: pathDistanceOrNone(paths, door.x, door.y),
                            queueCutsOff: queueCutsOffAt(door.x, door.y)
                        });
                    }
                }

                // A ride needs two: one for the entrance, one for the exit. One viable tile
                // is not a site, it is half of one. A shop needs the single serving tile.
                if (options.length < (shape.isShop ? 1 : 2)) {
                    continue;
                }

                accessFits++;

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

                // Already -1 rather than Infinity, and a shop measures from its serving
                // tile rather than from itself: the shop tile is where the building goes,
                // the serving tile is where the guest has to be able to stand.
                const distanceToPath = shown[0].pathDistance;

                // A park whose gate reaches no footpath at all - none laid yet, or every
                // fragment of it stranded - leaves every distance unmeasurable, and dropping
                // those sites would report such a park as unbuildable. `paths` is the
                // reachable network, so a park with paving the gate cannot reach is that
                // case too, and every site there comes back at -1 rather than vanishing.
                if (distanceToPath < 0 && paths.length > 0) {
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
                    fromX: cx + bounds.minDx,
                    fromY: cy + bounds.minDy,
                    toX: cx + bounds.maxDx,
                    toY: cy + bounds.maxDy,
                    sceneryToClear: area.scenery,
                    access: shown,
                    accessTotal: options.length,
                    nearestRideDistance: nearestRide === Infinity ? -1 : nearestRide,
                    pathDistance: distanceToPath
                });
            }
        }
    }

    // Ordered by distance to the footpath network the gate reaches, and by nothing else.
    // Preferring bare ground over treed ground at equal distance would be a preference, not
    // a measurement; sceneryToClear is reported so the caller can weigh it. A site whose
    // doors stand on paving the gate cannot reach is not moved anywhere either, and not
    // dropped: it sorts on the same number as every other site, which for it is the tiles
    // between it and the network rather than the 0 it used to report. Doors that would sever
    // the park are reported, not moved down the list: naming the consequence is perception,
    // choosing the tile is not.
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

    const note = chosen.length === 0
        ? whyNothingFound(shape, footprintFits, accessFits)
        : (shape.isShop
            ? "A shop has no entrance or exit. Its one `access` tile is the tile guests are served"
                + " from, and which neighbour that is comes from the site's `rotation`: 0 is -x, 1 is"
                + " +y, 2 is +x, 3 is -y. That tile takes an ordinary path, not a queue - there is"
                + " no `door` beyond it."
            : undefined);

    return {
        ok: true,
        ride: { name: rideObject.name, rideType: rideType, width: shape.width, depth: shape.depth, isShop: shape.isShop },
        sites: chosen,
        totalFound: found.length,
        note: note
    };
}
