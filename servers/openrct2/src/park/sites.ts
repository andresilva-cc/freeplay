import { DIRECTION_VECTORS, directionBetween, readMapGrid } from "./map.js";
import { findParkEntranceTiles } from "./paths.js";
import { flatRideShape, footprintOffsets, perimeterOffsets, shopServingTile } from "./flatRides.js";
import { rideObjectResearched } from "./research.js";
import type { MapGrid } from "./map.js";
import type { FlatRideShape, Offset } from "./flatRides.js";

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
    /** What this option costs, in one sentence: the path to lay, the tile the queue takes
     *  and what stands on it, and how much of the park's walking loses its route when a
     *  ride claims a queue there. The same facts as `pathDistance`, `door` and
     *  `queueCutsOff`, combined and said in words, because the three read separately are
     *  three numbers the caller has to put together and one of them went unread every time.
     *  A price, not a recommendation, and no option is ordered or marked by it. */
    cost: string;
    /** The tile the door opens onto, where a queue goes. Absent for a shop, which is
     *  served from the `x`,`y` tile itself and has no door. */
    door?: DoorTile;
    /** Trees or scenery stand on this tile or its door; clear_scenery them first. */
    needsClearing: boolean;
    /** Tiles from the door to the nearest footpath the park gate reaches AND the park could
     *  lay path onto - paving on its own land, or paving touching its own land. 0 means the
     *  door already stands on such a path. -1 when there is no such paving at all.
     *  A straight tile count and so a lower bound: it does not check whether the ground
     *  between is owned, level or clear.
     *  Both filters are there because paving that fails either one priced a connection that
     *  could not be made. A stranded fragment is still paving, and a door standing on one
     *  read 0 - the same number as a door on the main walk - while no guest could arrive at
     *  it. A scenario's entrance corridor is reachable paving on land the park neither owns
     *  nor can buy, and a site beside it read two or three tiles for a connection nothing
     *  could ever lay. */
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

/** ES5 target: no template strings, and "1 tiles" reads as a bug in the renderer. */
function tiles(count: number): string {
    return String(count) + (count === 1 ? " tile" : " tiles");
}

/**
 * What this door costs, in one sentence, said where the model is already reading.
 *
 * `queueCutsOff` is correct and was never read. Measured over three runs of the model
 * choosing a door: it wrote `pathDistance` 77 times in its own reasoning and `queueCutsOff`
 * 3 times, and in the run that put a queue across the park's trunk path it enumerated all
 * seven options, copying `door`, `pathDistance` and `needsClearing` for each, and
 * `queueCutsOff` for none. It was not weighing the number and overriding it. It never saw
 * it. A correct field nothing reads is a presentation defect, so the field stays and this
 * says the same fact in the place the reading actually happens.
 *
 * It also settles the one inversion in the numbers. For a shop's serving tile
 * `pathDistance` 0 means guests can already stand there, which is the best case there is.
 * For a ride's door 0 means the opposite - the door needs a free tile, and 0 says the tile
 * is not free, so the queue must take paving that is already carrying traffic. Same field,
 * opposite meaning, nothing in the number to tell them apart. In words they cannot collide.
 *
 * It states a price and stops. No option is reordered, filtered, marked or recommended by
 * it; whether the price is worth paying is the caller's call, and this is the same list in
 * the same order it was before.
 *
 * The premise above is on notice. The same treatment was given to `park_status`'s
 * `cutsIfBlocked` as a `cuts` sentence and did not replicate: 117 sentences across 12 calls,
 * 0 mentions and 0 paraphrases, and `cost` read 0 times in that same run. `cuts` has been
 * removed. This stays because the run that measured it read no door options at all - it
 * abandoned every ride it described - so it is untested here rather than disproved, and the
 * measurement behind it was taken on a different model. A run with completed builds, counting
 * `cost` against `pathDistance` with the counting script kept, is what decides it.
 */
function doorCost(door: DoorTile, pathDistance: number, queueCutsOff: number): string {
    const lay = pathDistance === 0
        ? "nothing to lay"
        : (pathDistance < 0
            ? "no paving the park could join is reachable, so there is nothing to price the walk against"
            : "at least " + tiles(pathDistance) + " of path to lay");

    const takes = door.hasUnboundQueue
        ? "which already carries a queue belonging to no ride"
        : (door.isExistingPath
            ? (door.guestsCanReach
                ? "which is path guests walk today"
                : "which is paving no guest reaches from the gate")
            : "which is bare ground");

    const loses = queueCutsOff > 0
        ? (queueCutsOff === 1
            ? "and 1 tile of path loses its route to the park entrance"
            : "and " + String(queueCutsOff) + " tiles of path lose their route to the park entrance")
        : (door.guestsCanReach
            ? "and no path loses its route to the park entrance"
            : "and no route runs through it to lose");

    return lay + "; the queue takes " + String(door.x) + "," + String(door.y)
        + ", " + takes + ", " + loses + ".";
}

/** The same sentence for a shop, which has no door and claims no queue. */
function shopCost(pathDistance: number): string {
    const lay = pathDistance === 0
        ? "nothing to lay: guests can already stand on this tile"
        : (pathDistance < 0
            ? "no paving the park could join is reachable, so there is nothing to price the walk against"
            : "at least " + tiles(pathDistance) + " of path to lay to reach this tile");

    return lay + "; a shop claims no queue, so nothing loses its route to the park entrance.";
}

/** One tile of the footprint the ride cannot stand on, and the one condition it fails. */
export interface FootprintBlocker {
    x: number;
    y: number;
    /** The condition this tile fails, as a clause that follows the coordinates. Worded the
     *  way build_flat_ride words the same refusals, because the two are read minutes apart
     *  and a rule stated two ways reads as two rules. */
    reason: string;
}

/** The ground a ride would stand on, as the two inclusive corners it spans. */
export interface Footprint {
    /** These are clear_scenery's four rectangle arguments under the same names, so they
     *  cross unchanged. Read from the tiles the game lays for this piece at this rotation,
     *  never from width and depth: a 4x4 runs 0..3 from its origin while a 1x4 runs -2..+1,
     *  so a square centred on the origin is the wrong ground for every footprint but a 3x3. */
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    /** Tiles the ride covers. The footprint of a one-piece ride fills its rectangle, so
     *  this is also the area of the four corners above. */
    tiles: number;
}

/**
 * What would happen if this ride went up at this origin, at this rotation. One placement,
 * the one that was asked about.
 *
 * It searches for nothing and offers no alternative. The tool it replaced swept the park,
 * scored every candidate on distance to a footpath and handed back the nearest three: the
 * model took site #1 in 11 of 12 builds and access option #1 in 12 of 12, out of more than
 * 1,200 candidates a time, so where every ride in every run went was chosen by a sort in
 * this file rather than by the player. The mechanics it cannot derive are still here -
 * which tiles a piece covers is not a formula, and neither is what a queue at a door would
 * sever - and the choice of tile is not.
 */
export interface PlacementResult {
    ok: boolean;
    /** What was asked about. `width` and `depth` are the ride's size for reference only:
     *  the ground it stands on is `footprint`, never a rectangle worked out from these two.
     *  `researched` is whether the scenario has unlocked this ride yet; the placement is
     *  described either way, because whether to wait for it is the caller's decision. */
    ride?: { name: string; rideType: number; width: number; depth: number; isShop: boolean; researched: boolean };
    /** The origin and rotation asked about, echoed, so the answer reads on its own and the
     *  three values that go to build_flat_ride are in the result that describes them. */
    x?: number;
    y?: number;
    rotation?: number;
    footprint?: Footprint;
    /** The height the ride would stand at, which is the origin tile's own ground height -
     *  the same tile build_flat_ride takes it from, so the two agree by construction. A
     *  door and every other footprint tile is measured against this. */
    z?: number;
    /** True when every tile of the footprint is the park's, level, at `z`, and carrying
     *  nothing but scenery. Scenery is not counted against it: it is `sceneryToClear`, and
     *  it is in the way of the build all the same. */
    fits?: boolean;
    /** Every footprint tile that fails one of those conditions, with which one. Empty when
     *  `fits` is true. */
    blockers?: FootprintBlocker[];
    /** Tiles of the footprint holding scenery. 0 means bare ground. */
    sceneryToClear?: number;
    /** What the ground is, in one sentence: how much of the footprint the ride can stand
     *  on, what stops the rest, and what is standing on it. The same facts as `fits`,
     *  `blockers` and `sceneryToClear`, said in words, for the same reason `cost` says a
     *  door's three numbers in words - a field read as a number beside a field read as a
     *  list is two readings, and the second one went unmade. A measurement, not a verdict. */
    ground?: string;
    /** Every place an entrance or exit could go for this placement - all of them, in the
     *  order they ring the footprint, which is a shape and not a ranking. A shop has one
     *  entry, the tile guests are served from. Empty when the origin tile has no readable
     *  ground to measure a door against. */
    access?: AccessOption[];
    /** Tiles from the origin to the nearest tile carrying ride track or an entrance
     *  building. The park's own gate is an entrance building, so in a park with a gate this
     *  is never -1: with no ride built yet it is the distance to the gate. */
    nearestRideDistance?: number;
    /** What `access` means for this ride, when it means something particular - a shop's
     *  one serving tile - or why there is none to report. */
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

/**
 * What the ground under one placement is, tile by tile.
 *
 * The search this replaced asked the same question and answered it yes or no, because it
 * was sifting thousands of candidates and only needed to know which to drop. One placement
 * the caller named is the opposite case: "no" on its own sends it guessing at another
 * origin, so every tile that fails says which condition it failed.
 *
 * Height is measured against the ORIGIN tile, not against the first tile of the footprint
 * or the commonest height under it. That is the tile `build_flat_ride` takes the ride's
 * height from, and a describe that picked a different reference would report a placement
 * as level that the build then refuses.
 */
interface GroupedBlocker extends FootprintBlocker {
    /** How the sentence counts this one, as a plural clause: "are not the park's land".
     *  Kept off the returned blocker, which carries the tile's own reason and nothing else. */
    group: string;
}

function footprintState(grid: MapGrid, cx: number, cy: number, z: number, offsets: Offset[]): { scenery: number; blockers: GroupedBlocker[] } {
    const blockers: GroupedBlocker[] = [];
    let scenery = 0;

    for (let i = 0; i < offsets.length; i++) {
        const x = cx + offsets[i].dx;
        const y = cy + offsets[i].dy;
        const cell = grid.at(x, y);

        if (!cell) {
            blockers.push({ x: x, y: y, reason: "is off the map", group: "are off the map" });
            continue;
        }

        if (!cell.owned) {
            blockers.push({ x: x, y: y, reason: "is not land the park owns", group: "are not land the park owns" });
            continue;
        }

        if (!cell.flat) {
            blockers.push({
                x: x, y: y,
                reason: "is on a slope, and a ride needs level ground",
                group: "are on a slope, and a ride needs level ground"
            });
            continue;
        }

        if (cell.baseZ !== z) {
            blockers.push({
                x: x,
                y: y,
                reason: "is at height " + String(cell.baseZ) + " and the ride stands at height " + String(z),
                group: "stand at a different height from the ride's origin"
            });
            continue;
        }

        if (!cell.clearable) {
            blockers.push({
                x: x,
                y: y,
                reason: "carries " + standingOn(x, y) + ", which is not scenery a bulldozer removes",
                group: "carry something a bulldozer does not remove"
            });
            continue;
        }

        // Scenery is not a blocker: a player fells it, and the search this came from
        // counted it rather than refusing the ground. It is still in the way of the build,
        // which is what `sceneryToClear` is for.
        if (!cell.clear) {
            scenery++;
        }
    }

    return { scenery: scenery, blockers: blockers };
}

/** What is standing on a tile, named rather than called "a structure". */
function standingOn(x: number, y: number): string {
    const tile = map.getTile(x, y);
    const seen: Record<string, boolean> = {};
    const names: string[] = [];

    for (let i = 0; i < tile.numElements; i++) {
        const type = tile.getElement(i).type;

        if (type === "surface" || seen[type]) {
            continue;
        }

        seen[type] = true;
        names.push(type === "footpath" ? "a footpath" : (type === "track" ? "ride track" : "a " + type));
    }

    return names.length > 0 ? names.join(" and ") : "something";
}

/**
 * The footprint's ground in one sentence: how much of it the ride can stand on, what stops
 * the rest, and what else is on it.
 *
 * Same reasoning as `cost` on a door, which exists because three correct numbers went
 * unread when they were three numbers. `fits`, `blockers` and `sceneryToClear` are a flag,
 * a list and a count, and reading them together is a step. It states what the ground is and
 * stops: nothing here says whether to build, where else to look, or which constraint to
 * relax - and two of the three obvious levers do not exist anyway, since no tool levels
 * ground and none moves a ride out of the way.
 */
function groundSentence(footprintTiles: number, z: number, scenery: number, blockers: GroupedBlocker[]): string {
    const trees = scenery === 0
        ? " Nothing is standing on it."
        : " " + tiles(scenery) + " of it " + (scenery === 1 ? "carries" : "carry") + " scenery, which is in the"
            + " way of the build and is what clear_scenery takes down.";

    if (blockers.length === 0) {
        return "All " + tiles(footprintTiles) + " the ride would stand on are the park's, level and at height "
            + String(z) + "." + trees;
    }

    const counts: Record<string, number> = {};
    const order: string[] = [];

    for (let i = 0; i < blockers.length; i++) {
        const group = blockers[i].group;

        if (typeof counts[group] !== "number") {
            counts[group] = 0;
            order.push(group);
        }

        counts[group]++;
    }

    const said: string[] = [];

    for (let i = 0; i < order.length; i++) {
        said.push(String(counts[order[i]]) + " " + order[i]);
    }

    const standsOn = footprintTiles - blockers.length;

    return "The ride does not stand here: of the " + tiles(footprintTiles) + " it would cover, "
        + String(blockers.length) + " cannot take it - " + said.join("; ") + "."
        + (standsOn > 0 ? " The other " + tiles(standsOn) + " could." : "") + trees;
}

/** Tiles already occupied by a ride, so a placement can report how tight the fit is. */
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

/** True when the park owns at least one tile orthogonally touching this one. */
function touchesOwnedLand(grid: MapGrid, x: number, y: number): boolean {
    for (let i = 0; i < NEIGHBOURS.length; i++) {
        const cell = grid.at(x + NEIGHBOURS[i].dx, y + NEIGHBOURS[i].dy);

        if (cell && cell.owned) {
            return true;
        }
    }

    return false;
}

/**
 * The footpath tiles a guest can walk to from the gate AND the park could lay path onto,
 * which together are what every distance here is measured against.
 *
 * Two filters, each put here by a run that went wrong.
 *
 * REACHABLE. This swept the whole grid for anything carrying a footpath. Paving the gate
 * reaches nothing of counted the same as the main walk, so a door standing on a stranded
 * fragment came back `pathDistance` 0 with `isExistingPath` true - the markers of the best
 * door in the park - and sorted to the top of a list the model takes the first entry of.
 * Two rides of one run went onto a five-tile island park_status had named as stranded in
 * the turn before.
 *
 * JOINABLE. Reachable was still not enough. A scenario's entrance corridor is footpath on
 * land the park does not own and cannot buy, and it is reachable by definition - guests
 * arrive along it. A site beside it priced at two or three tiles for a connection that can
 * never be laid, which is the same lie the old 0 told, one step further out. So a tile
 * counts only when the park owns it, or owns a tile touching it: those are the tiles it can
 * lay a footpath up to, and a footpath laid beside an existing one joins to it whoever owns
 * the ground. A corridor running away across land the park owns nothing beside drops out,
 * one tile at a time, exactly where it stops being connectable.
 *
 * The distance itself stays a straight tile count and so stays a lower bound: nothing here
 * checks whether the ground in between is owned, level or clear. Routing it properly is a
 * search per door over thousands of candidates, on the game's own thread.
 */
function connectablePathTiles(grid: MapGrid, reachable: Record<string, boolean>): { x: number; y: number }[] {
    const tiles: { x: number; y: number }[] = [];

    for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
            const cell = grid.at(x, y);

            if (!cell || !cell.path || !reachable[key(x, y)]) {
                continue;
            }

            if (cell.owned || touchesOwnedLand(grid, x, y)) {
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
 * What one placement of one ride would be: the ground it would cover, whether that ground
 * takes it, and every door position it would have with what each would cost.
 *
 * It is handed an origin and a rotation and it describes those. It does not look at any
 * other tile of the park, rank anything, or offer an alternative, because the tool it
 * replaced did all three and the model stopped choosing: across every measured run it took
 * site #1 in 11 of 12 builds and access option #1 in 12 of 12, from a list of three cut out
 * of more than 1,200 candidates by a sort in this file. What stayed is the half the model
 * cannot work out for itself - a piece's footprint offsets are not a formula, and what a
 * queue at a door would sever is a walk over the game's own footpath edges.
 *
 * `rotation` is taken as given and never wrapped or chosen: 4 is refused rather than read
 * as 0, and there is no default, because a rotation this picked would be this file deciding
 * which way the ride faces.
 */
export function describePlacement(rideObjectIndex: number, cx: number, cy: number, rotation: number): PlacementResult {
    const objects = context.getAllObjects("ride");
    // Indexed by `.index`, not by position: `list_ride_objects` reports `.index`, and the
    // two only coincide while the loaded object list has no gaps in it. build_flat_ride
    // resolves it the same way, and a tool that disagrees with it describes one ride and
    // then builds another, with every step reporting success.
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

    if (rotation < 0 || rotation > 3 || Math.floor(rotation) !== rotation) {
        return {
            ok: false,
            error: "`rotation` is 0, 1, 2 or 3 and " + String(rotation) + " is none of them. It is not wrapped:"
                + " 4 is refused rather than read as 0."
        };
    }

    const grid = readMapGrid();
    const origin = grid.at(cx, cy);

    if (!origin) {
        return {
            ok: false,
            error: "There is no tile at " + String(cx) + "," + String(cy) + ": the map runs 0 to "
                + String(map.size.x - 1) + " across and 0 to " + String(map.size.y - 1) + " down."
        };
    }

    if (origin.baseZ < 0) {
        return {
            ok: false,
            error: "No ground could be read at " + String(cx) + "," + String(cy) + ", so there is no height for"
                + " a ride to stand at there."
        };
    }

    // The ride's height is the origin tile's, because that is the tile build_flat_ride takes
    // it from. Every other footprint tile and every door is measured against it, so the two
    // tools cannot disagree about whether this placement is level.
    const z = origin.baseZ;
    const offsets = footprintOffsets(shape, rotation);
    const perimeter = perimeterOffsets(offsets);
    const bounds = footprintBounds(offsets);
    const state = footprintState(grid, cx, cy, z, offsets);

    const rideTiles = collectRideTiles();
    const gate = findParkEntranceTiles();
    const edges = readPathEdges(grid);
    const reachableNow = gate.length > 0 ? walkableFrom(edges, gate, null) : {};
    // Everything a distance is measured against, and everything it is not: paving the gate
    // reaches and the park could lay path onto, as against stranded fragments and paving
    // running away over ground the park owns nothing beside.
    const paths = connectablePathTiles(grid, reachableNow);
    const islands = strandedIslands(grid, reachableNow);

    // The answer is a property of the footpath tile, not of the door, and two doors of one
    // placement can open onto the same paving, so it is measured once per tile and kept.
    // Only a tile the gate reaches can cut anything: a queue laid on bare ground adds to the
    // network and takes no route out of it, and a stranded fragment has no route to take.
    // A reachable tile already carrying a queue counts - an entrance placed here claims that
    // queue and dead-ends this tile, which is the `hasUnboundQueue` door offered as a
    // finished one.
    const severance: Record<string, number> = {};

    const queueCutsOffAt = function (x: number, y: number): number {
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

    const options: AccessOption[] = [];

    if (shape.isShop) {
        // Measured in the game by ringing a stall with four paths: only the neighbour in
        // direction `rotation` formed a footpath edge to it. The other three touch the shop
        // and serve nobody. There is no door beyond it either - a queue tile one further out
        // is a tile too far.
        const serving = shopServingTile(cx, cy, rotation);
        const cell = grid.at(serving.x, serving.y);

        // A footpath here is the best case, not a blocker: the shop is already served.
        // Demanding bare ground threw away every stall position beside the park's paths. A
        // queue is a blocker, though - guests in a queue buy nothing.
        if (cell && cell.owned && cell.flat && cell.baseZ === z
            && (cell.clearable || (cell.path && !cell.queue))) {
            const facing = (rotation + 2) % 4;
            const distance = pathDistanceOrNone(paths, serving.x, serving.y);

            options.push({
                x: serving.x,
                y: serving.y,
                direction: facing,
                side: SIDE_NAMES[facing],
                cost: shopCost(distance),
                needsClearing: !cell.clear && !cell.path,
                pathDistance: distance,
                queueCutsOff: 0
            });
        }
    } else {
        // In the order the tiles ring the footprint, which is a shape rather than a
        // judgement. The list this replaced was sorted by distance to a path and cut to
        // eight, and the model took the first entry of it every time; there is no sort here
        // and nothing is left out, so the order carries no claim about which door is worth
        // using.
        for (let p = 0; p < perimeter.length; p++) {
            const tile = { x: cx + perimeter[p].dx, y: cy + perimeter[p].dy };
            const cell = grid.at(tile.x, tile.y);

            // Scenery is not a blocker here any more than it is on the footprint: a player
            // fells it, and `needsClearing` says so. Requiring bare ground dropped whole
            // sites in a forest because a tree stood where the entrance would go.
            if (!cell || !cell.owned || !cell.flat || !cell.clearable || cell.baseZ !== z) {
                continue;
            }

            const direction = facingDirection(offsets, perimeter[p]);

            if (direction === null) {
                continue;
            }

            const outward = DIRECTION_VECTORS[(direction + 2) % 4];
            const door = { x: tile.x + outward.dx, y: tile.y + outward.dy };
            const doorCell = grid.at(door.x, door.y);

            // A door onto the path network the gate reaches is the shortest work there is -
            // pathDistance 0, nothing to lay but the queue itself. Requiring bare ground here
            // quietly discarded exactly those, and left `isExistingPath` a flag that could
            // never be true. A door onto paving the gate does not reach looks identical from
            // this tile and is not the same thing at all, which is what `guestsCanReach`
            // below separates.
            if (!doorCell || !doorCell.owned || (!doorCell.clearable && !doorCell.path)) {
                continue;
            }

            // The one queue that is a blocker, and it is the same line build_flat_ride draws:
            // a queue chained to another ride would be re-chained to this one, leaving that
            // ride with none. An unbound queue is a working door - the entrance chains it
            // when it is placed - and refusing those made a demolished ride's own spot
            // unbuildable.
            const boundTo = doorCell.queue ? queueBoundTo(door.x, door.y) : null;

            if (boundTo !== null) {
                continue;
            }

            const doorTile: DoorTile = {
                x: door.x,
                y: door.y,
                isExistingPath: doorCell.path,
                guestsCanReach: reachableNow[key(door.x, door.y)] === true,
                hasUnboundQueue: doorCell.queue,
                island: islands[key(door.x, door.y)]
            };
            const distance = pathDistanceOrNone(paths, door.x, door.y);
            const cutsOff = queueCutsOffAt(door.x, door.y);

            options.push({
                x: tile.x,
                y: tile.y,
                direction: direction,
                side: SIDE_NAMES[direction % 4],
                cost: doorCost(doorTile, distance, cutsOff),
                needsClearing: !cell.clear || (!doorCell.clear && !doorCell.path),
                door: doorTile,
                pathDistance: distance,
                queueCutsOff: cutsOff
            });
        }
    }

    let nearestRide = Infinity;

    for (let i = 0; i < rideTiles.length; i++) {
        const distance = Math.abs(rideTiles[i].x - cx) + Math.abs(rideTiles[i].y - cy);

        if (distance < nearestRide) {
            nearestRide = distance;
        }
    }

    const blockers: FootprintBlocker[] = state.blockers.map(function (blocker) {
        return { x: blocker.x, y: blocker.y, reason: blocker.reason };
    });

    return {
        ok: true,
        ride: {
            name: rideObject.name, rideType: rideType, width: shape.width, depth: shape.depth,
            isShop: shape.isShop, researched: rideObjectResearched(rideObject.index)
        },
        x: cx,
        y: cy,
        rotation: rotation,
        z: z,
        footprint: {
            fromX: cx + bounds.minDx,
            fromY: cy + bounds.minDy,
            toX: cx + bounds.maxDx,
            toY: cy + bounds.maxDy,
            tiles: offsets.length
        },
        fits: blockers.length === 0,
        blockers: blockers,
        sceneryToClear: state.scenery,
        ground: groundSentence(offsets.length, z, state.scenery, state.blockers),
        access: options,
        nearestRideDistance: nearestRide === Infinity ? -1 : nearestRide,
        note: accessNote(shape, options.length)
    };
}

/**
 * What `access` means for this ride, when it means something the list itself does not say.
 *
 * A shop's one tile is not a door and following it as one puts the path a tile too far out.
 * A ride with fewer than two positions cannot be built at all - the game needs one for the
 * entrance and one for the exit - and an `access` list of one reads as a working placement
 * with an obvious choice in it.
 *
 * It states the rule and what a usable tile is. Which lever to pull is not here: naming one
 * picks which constraint to relax, and that is the caller's.
 */
function accessNote(shape: FlatRideShape, found: number): string | undefined {
    if (shape.isShop) {
        return "A shop has no entrance or exit. Its one `access` tile is the tile guests are served"
            + " from, and which neighbour that is comes from the `rotation` asked about: 0 is -x, 1 is"
            + " +y, 2 is +x, 3 is -y. That tile takes an ordinary path, not a queue - there is"
            + " no `door` beyond it."
            + (found === 0
                ? " Here it is unowned, sloped, at a different height, or carrying something other than"
                    + " scenery or an ordinary footpath, so this placement has none."
                : "");
    }

    if (found >= 2) {
        return undefined;
    }

    return "A ride needs two of these, one for the entrance and one for the exit, and this placement has "
        + (found === 0 ? "none" : "one") + "."
        + " A tile counts only when it is owned, level, at the ride's height and carrying nothing but"
        + " scenery, and the tile its door opens onto is owned and carries nothing but scenery, a"
        + " footpath, or a queue belonging to no ride. Scenery alone never disqualifies either.";
}
