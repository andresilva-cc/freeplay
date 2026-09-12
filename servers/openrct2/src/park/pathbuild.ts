import { DIRECTION_VECTORS, readMapGrid, toWorld, unitStep } from "./map.js";
import type { MapGrid } from "./map.js";
import {
    countPathTiles, isParkEntranceElement, RIDE_ENTRANCE, RIDE_EXIT, tileIsWalkable, walkableFromParkEntrance
} from "./paths.js";
import type { Tile } from "./paths.js";

const STEP_DELAY_MS = 200;
export const DEFAULT_QUEUE_OBJECT = 11;
export const DEFAULT_PATH_OBJECT = 1;
const FOOTPATH_QUEUE_FLAG = 1;

const NEIGHBOURS = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];

/**
 * OpenRCT2 refuses any game action that does not carry `Flags::AllowWhilePaused` while the
 * game is paused - `GameActionRunner.cpp`, `CheckActionInPausedMode` - answering
 * STR_CONSTRUCTION_NOT_POSSIBLE_WHILE_GAME_IS_PAUSED.
 *
 * `footpathplace` is the only action this file fires, and it does not carry the flag, so a
 * paused run lays nothing. The run is still made rather than refused up front: a refused
 * placement creates nothing and charges nothing, so there is no orphan to protect against
 * the way `src/park/build.ts` has to, and letting it run quotes the reason the game gave
 * instead of restating a rule this file would have to transcribe.
 */
function gamePaused(): boolean {
    return context.paused === true;
}

/**
 * `gamesetspeed` and `pausetoggle` both carry `Flags::AllowWhilePaused`, so this is the one
 * call named in a paused refusal that is not itself refused by the pause.
 */
const UNPAUSE_CALL = "set_game_speed is not one of the calls a paused game refuses, so"
    + " set_game_speed {paused: false} goes through and starts the clock.";

/** The game's own words for a refusal. Same shape `src/park/build.ts` quotes them in. */
function actionError(result: GameActionResult): string {
    return (result.errorTitle || "") + (result.errorMessage ? ": " + result.errorMessage : "");
}

export interface BuildPathRequest {
    /** Corners of the run, in order. Two points means "you pick the line". */
    points: Tile[];
    queue: boolean;
    /** Surface and railing styles: the player's choice, not the bridge's. */
    surfaceObject: number;
    railingsObject: number;
}

export interface BuildPathOutcome {
    ok: boolean;
    tilesPlaced: number;
    tilesRouted: number;
    route: Tile[];
    /**
     * Whether both ends can be walked to from the park entrance.
     *
     * With one exception, which is the game's rather than this file's: the tile a ride's
     * entrance has claimed is dead-ended on purpose, so an end sitting on one counts as
     * connected as long as some other tile of the run reaches the network. Demanding it be
     * walkable demands that a queue not touch the door, which is the one tile it must.
     */
    connectedToPark: boolean;
    detail: string;
    /**
     * Set only when the arguments were refused before anything was routed. Every failure
     * carries the whole outcome shape as well, so `detail` always holds the message.
     */
    error?: string;
}

/** An outcome for a run that never started, in the shape every other outcome uses. */
export function pathRefusal(detail: string): BuildPathOutcome {
    return {
        ok: false,
        tilesPlaced: 0,
        tilesRouted: 0,
        route: [],
        connectedToPark: false,
        detail: detail,
        error: detail
    };
}

function tileName(tile: Tile): string {
    return String(tile.x) + "," + String(tile.y);
}

function plural(count: number, singular: string): string {
    return String(count) + " " + singular + (count === 1 ? "" : "s");
}

/** Whether this tile carries a path, and whether that path is a queue. */
function pathState(x: number, y: number): { path: boolean; queue: boolean } {
    if (x < 0 || y < 0 || x >= map.size.x || y >= map.size.y) {
        return { path: false, queue: false };
    }

    const tile = map.getTile(x, y);
    let path = false;
    let queue = false;

    for (let i = 0; i < tile.numElements; i++) {
        const element = tile.getElement(i);

        if (element.type !== "footpath") {
            continue;
        }

        path = true;

        if ((element as FootpathElement).isQueue) {
            queue = true;
        }
    }

    return { path: path, queue: queue };
}

/** The ride a queue on this tile is bound to, or null for bare path and unclaimed queue. */
function queueBinding(x: number, y: number): number | null {
    if (x < 0 || y < 0 || x >= map.size.x || y >= map.size.y) {
        return null;
    }

    const tile = map.getTile(x, y);

    for (let i = 0; i < tile.numElements; i++) {
        const element = tile.getElement(i);

        if (element.type !== "footpath") {
            continue;
        }

        const path = element as FootpathElement;

        if (path.isQueue && typeof path.ride === "number") {
            return path.ride;
        }
    }

    return null;
}

/** Scenery a player can simply remove, as `src/park/map.ts` counts it for `clearable`. */
const REMOVABLE_TYPES: Record<string, boolean> = {
    small_scenery: true,
    large_scenery: true,
    wall: true,
    banner: true
};

/**
 * What is standing on a tile that a bulldozer will not take off, by element type.
 *
 * The same list `src/park/build.ts` names a blocked door tile with, kept local because
 * that one is private to its file and this one is read for a different call's message.
 */
function immovableOn(x: number, y: number): string[] {
    if (x < 0 || y < 0 || x >= map.size.x || y >= map.size.y) {
        return [];
    }

    const tile = map.getTile(x, y);
    const seen: Record<string, boolean> = {};
    const names: string[] = [];

    for (let i = 0; i < tile.numElements; i++) {
        const type = tile.getElement(i).type;

        if (type === "surface" || REMOVABLE_TYPES[type] || seen[type]) {
            continue;
        }

        seen[type] = true;
        names.push(type);
    }

    return names;
}

/**
 * The ride door standing on a tile, if one is, and the tile it opens onto.
 *
 * The single commonest build_path mistake in the logs: aiming at the entrance *building*
 * rather than the tile in front of it. The building is not ground and takes no path, so
 * the run either refuses or comes up short, and neither message named the real tile.
 */
function rideDoorOn(tile: Tile): { isExit: boolean; ride: number; opensOnto: Tile } | null {
    if (tile.x < 0 || tile.y < 0 || tile.x >= map.size.x || tile.y >= map.size.y) {
        return null;
    }

    const mapTile = map.getTile(tile.x, tile.y);

    for (let i = 0; i < mapTile.numElements; i++) {
        const element = mapTile.getElement(i);

        if (element.type !== "entrance") {
            continue;
        }

        const entrance = element as EntranceElement;

        // Only a ride entrance or a ride exit has a door. `object` is the only field that
        // says so: the API reports a ride index for the park gate too, so testing `ride`
        // classified the gate as a ride door and handed back a door tile off the side of it.
        if (entrance.object !== RIDE_ENTRANCE && entrance.object !== RIDE_EXIT) {
            return null;
        }

        // `direction` points at the ride, so the door opens the other way.
        const towardsRide = DIRECTION_VECTORS[(entrance.direction || 0) % 4];

        return {
            isExit: entrance.object === RIDE_EXIT,
            ride: typeof entrance.ride === "number" ? entrance.ride : -1,
            opensOnto: { x: tile.x - towardsRide.dx, y: tile.y - towardsRide.dy }
        };
    }

    return null;
}

/**
 * The ride whose entrance has claimed the queue on this tile, or null.
 *
 * This is the one tile the game deliberately dead-ends, and `src/park/paths.ts` measured
 * it: when an entrance claims a queue, the tile its door opens onto loses the edge it had
 * to the path beside it, so the flood out of the park gate stops short of that tile. A
 * queue built exactly right therefore reads as unreachable at precisely the tile a queue
 * has to touch, and calling that "cut off" told one run to tear out a working line.
 */
function rideClaimingDoorTile(tile: Tile): number | null {
    const bound = queueBinding(tile.x, tile.y);

    if (bound === null) {
        return null;
    }

    for (let i = 0; i < NEIGHBOURS.length; i++) {
        const door = rideDoorOn({ x: tile.x + NEIGHBOURS[i].dx, y: tile.y + NEIGHBOURS[i].dy });

        if (door && !door.isExit && door.ride === bound
            && door.opensOnto.x === tile.x && door.opensOnto.y === tile.y) {
            return bound;
        }
    }

    return null;
}

/** True when the park's gate structure stands on this tile. */
function isParkGate(tile: Tile): boolean {
    if (tile.x < 0 || tile.y < 0 || tile.x >= map.size.x || tile.y >= map.size.y) {
        return false;
    }

    const mapTile = map.getTile(tile.x, tile.y);

    for (let i = 0; i < mapTile.numElements; i++) {
        const element = mapTile.getElement(i);

        if (element.type === "entrance" && isParkEntranceElement(element as EntranceElement)) {
            return true;
        }
    }

    return false;
}

/**
 * One tile a run cannot use, the condition it failed, and the call that lifts it.
 *
 * A routing failure used to name the four conditions as a set and no tile at all. The
 * transcripts put a number on what that costs: this model recovers from 14 of 14 messages
 * that name the failing value and the call that fixes it, and 0 of 6 that name only a
 * category. One run read "no level, owned, unobstructed route", guessed ownership, bought
 * £270 of land it already owned and never retried; the blocker was scenery on the tile the
 * run started from.
 */
interface Blocker {
    tile: Tile;
    /** What is wrong with it, as a phrase that follows the coordinates. */
    what: string;
    /** The call that resolves it, or null where nothing in this bridge does. */
    remedy: string | null;
    /**
     * True when the thing in the way is something a build puts there or takes away, so
     * the ground has changed rather than the coordinates being wrong. `src/park/build.ts`
     * draws the same line, and the two need opposite answers.
     */
    stale: boolean;
}

/**
 * The one condition a tile fails, as a code, or null when a run may use it.
 *
 * Cell fields only: the probe below asks this of thousands of tiles, and this runs on the
 * game's own thread where a long loop is a frozen game. Naming the blocker is
 * `describeBlock`'s job, and that reads the tile itself.
 *
 * The order is the order the conditions have to be fixed in. Ownership comes before
 * scenery because clearing ground the park does not own removes nothing.
 */
function blockCode(grid: MapGrid, x: number, y: number, z: number | null, queueAllowed: boolean): string | null {
    const cell = grid.at(x, y);

    if (!cell) {
        return "offMap";
    }

    if (!cell.owned) {
        return "unowned";
    }

    if (!cell.flat) {
        return "sloped";
    }

    if (z !== null && cell.baseZ !== z) {
        return "height";
    }

    if (!cell.clear && !cell.path) {
        return cell.clearable ? "scenery" : "structure";
    }

    // A queue is ordinary walkable path - guests cross one - so this is not about
    // routing. Ordinary path laid over a queue unbinds it from its ride, and that damage
    // is invisible from the API, so a run that is not a queue never takes a queue tile.
    if (cell.queue && !queueAllowed) {
        return "queue";
    }

    return null;
}

function describeBlock(tile: Tile, code: string, grid: MapGrid, z: number | null, wantQueue: boolean): Blocker {
    if (code === "unowned") {
        return {
            tile: tile,
            what: "not land the park owns",
            remedy: "buy_land buys it, and takes two corners as fromX/fromY/toX/toY",
            stale: false
        };
    }

    if (code === "scenery") {
        return {
            tile: tile,
            what: "carrying scenery",
            remedy: "clear_scenery removes it, and takes two corners as fromX/fromY/toX/toY",
            stale: true
        };
    }

    if (code === "queue") {
        const ride = queueBinding(tile.x, tile.y);
        const whose = ride !== null ? "carrying ride " + String(ride) + "'s queue" : "carrying a queue no ride has claimed";

        return {
            tile: tile,
            what: whose + ", and " + (wantQueue
                ? "a queue laid onto an existing one chains the two lines into one"
                : (ride !== null
                    ? "ordinary path laid over it unbinds it from ride " + String(ride)
                    : "ordinary path laid over it replaces the queue")),
            remedy: "remove_path takes a queue up, and takes the same fromX/fromY/toX/toY or waypoints as this call",
            stale: true
        };
    }

    if (code === "sloped") {
        return {
            tile: tile,
            what: "on a slope, and a footpath needs level ground",
            remedy: null,
            stale: false
        };
    }

    if (code === "height") {
        const cell = grid.at(tile.x, tile.y);

        return {
            tile: tile,
            what: "at ground height " + String(cell ? cell.baseZ : -1)
                + " and this run is at height " + String(z),
            remedy: null,
            stale: false
        };
    }

    if (code === "structure") {
        const standing = immovableOn(tile.x, tile.y);

        return {
            tile: tile,
            what: "carrying " + (standing.length > 0 ? standing.join(" and ") : "a structure")
                + ", which is not scenery a bulldozer removes",
            remedy: null,
            stale: true
        };
    }

    return { tile: tile, what: "off the map", remedy: null, stale: false };
}

function blockerAt(grid: MapGrid, tile: Tile, z: number | null, wantQueue: boolean): Blocker | null {
    const code = blockCode(grid, tile.x, tile.y, z, wantQueue);
    return code === null ? null : describeBlock(tile, code, grid, z, wantQueue);
}

/** How far off the direct line the probe below will look for a way through. */
const PROBE_MARGIN = 6;
/** Tiles the probe will look at before giving up. This runs on the game's own thread. */
const PROBE_CELLS = 20000;
/**
 * How many tiles of one kind a failure lists before it counts the rest.
 *
 * Naming one blocker is enough to act on only when there is one. The router already goes
 * round scenery, so a run that fails on scenery has hit a barrier with no gap in it, and
 * clearing the single tile named would fail again on its neighbour. The remedies are
 * rectangles - clear_scenery and buy_land both take two corners - so the model needs the
 * extent, not a specimen. The cap is what stops a long run spending a paragraph on it.
 */
const BLOCKERS_LISTED = 6;

/**
 * The tiles that have to change for a route to exist, found by searching the router's own
 * grid with blocked tiles made passable at a cost of one each. The cheapest way through is
 * therefore the fewest tiles to fix, and those are the ones reported.
 *
 * This measures the ground. Whether to clear it, buy it, or draw `waypoints` round it is
 * the caller's, and the result says nothing about which.
 */
function blockedWayBetween(grid: MapGrid, from: Tile, to: Tile, z: number, wantQueue: boolean): Blocker[] {
    const minX = Math.max(0, Math.min(from.x, to.x) - PROBE_MARGIN);
    const maxX = Math.min(grid.width - 1, Math.max(from.x, to.x) + PROBE_MARGIN);
    const minY = Math.max(0, Math.min(from.y, to.y) - PROBE_MARGIN);
    const maxY = Math.min(grid.height - 1, Math.max(from.y, to.y) + PROBE_MARGIN);

    const cameFrom: Record<string, string | null> = {};
    cameFrom[tileName(from)] = null;

    let frontier: Tile[] = [from];
    let visited = 1;
    let goal: string | null = null;

    // Breadth-first within a layer, so every tile reachable without fixing anything more
    // is seen before the next tile to fix is opened: 0-1 search without a priority queue.
    while (frontier.length > 0 && goal === null && visited < PROBE_CELLS) {
        const blockedNext: Tile[] = [];
        const open: Tile[] = frontier.slice();

        while (open.length > 0 && visited < PROBE_CELLS) {
            const current = open.shift() as Tile;

            if (current.x === to.x && current.y === to.y) {
                goal = tileName(current);
                break;
            }

            for (let d = 0; d < NEIGHBOURS.length; d++) {
                const next = { x: current.x + NEIGHBOURS[d].dx, y: current.y + NEIGHBOURS[d].dy };

                if (next.x < minX || next.x > maxX || next.y < minY || next.y > maxY) {
                    continue;
                }

                const nextKey = tileName(next);

                if (typeof cameFrom[nextKey] !== "undefined") {
                    continue;
                }

                cameFrom[nextKey] = tileName(current);
                visited++;

                if (blockCode(grid, next.x, next.y, z, false) === null) {
                    open.push(next);
                } else {
                    blockedNext.push(next);
                }
            }
        }

        frontier = blockedNext;
    }

    if (goal === null) {
        return [];
    }

    const blockers: Blocker[] = [];
    let cursor: string | null = goal;

    while (cursor !== null) {
        const parts = cursor.split(",");
        const tile = { x: Number(parts[0]), y: Number(parts[1]) };
        const code = blockCode(grid, tile.x, tile.y, z, false);

        if (code !== null) {
            blockers.push(describeBlock(tile, code, grid, z, wantQueue));
        }

        cursor = cameFrom[cursor];
    }

    blockers.reverse();
    return blockers;
}

/** The literal line between two tiles, turning once: the fallback the probe cannot miss. */
function lineBetween(from: Tile, to: Tile): Tile[] {
    const tiles: Tile[] = [{ x: from.x, y: from.y }];
    let x = from.x;
    let y = from.y;

    while (x !== to.x) {
        x += unitStep(to.x - x);
        tiles.push({ x: x, y: y });
    }

    while (y !== to.y) {
        y += unitStep(to.y - y);
        tiles.push({ x: x, y: y });
    }

    return tiles;
}

function blockersOn(grid: MapGrid, tiles: Tile[], z: number, wantQueue: boolean): Blocker[] {
    const blockers: Blocker[] = [];

    for (let i = 0; i < tiles.length; i++) {
        const code = blockCode(grid, tiles[i].x, tiles[i].y, z, false);

        if (code !== null) {
            blockers.push(describeBlock(tiles[i], code, grid, z, wantQueue));
        }
    }

    return blockers;
}

/** Tiles that failed the same way, gathered into one clause with one remedy. */
function blockerGroups(blockers: Blocker[]): string {
    const order: string[] = [];
    const tiles: Record<string, Tile[]> = {};
    const first: Record<string, Blocker> = {};

    for (let i = 0; i < blockers.length; i++) {
        const key = blockers[i].what + "|" + String(blockers[i].remedy);

        if (!tiles[key]) {
            tiles[key] = [];
            first[key] = blockers[i];
            order.push(key);
        }

        tiles[key].push(blockers[i].tile);
    }

    return order.map(function (key) {
        const group = tiles[key];
        const shown = group.slice(0, BLOCKERS_LISTED).map(tileName).join(" ");
        const rest = group.length > BLOCKERS_LISTED
            ? " and " + String(group.length - BLOCKERS_LISTED) + " more of them"
            : "";

        return shown + rest + " - " + first[key].what + "; " + (first[key].remedy !== null
            ? String(first[key].remedy)
            : "nothing in this bridge changes that");
    }).join(". ");
}

/**
 * Route between two tiles at the same height, around obstructions.
 *
 * Plain breadth-first search returns *a* shortest path and breaks ties arbitrarily,
 * which produces staircases: a diagonal drawn as a dozen alternating steps. Turning is
 * given a cost so equally short routes come out as straight runs with few corners,
 * which is what a person dragging a path would produce.
 */
const TURN_COST = 4;

interface Node {
    x: number;
    y: number;
    /** Direction taken to arrive here, or -1 at the start. */
    from: number;
    cost: number;
}

function route(from: Tile, to: Tile, wantQueue: boolean): Tile[] | null {
    const grid = readMapGrid();
    const startCell = grid.at(from.x, from.y);

    // Hold the start tile to the same standard as every other tile on the run. Checking
    // only ownership accepted a start on a slope or on blocked ground, fired an action
    // there, and reported "something blocked the rest" rather than naming the real cause.
    // A queue run may start on a queue, the same way it may finish on one; a run that is
    // not a queue may not, which is the whole of the fix below.
    if (!startCell || blockCode(grid, from.x, from.y, null, wantQueue) !== null) {
        return null;
    }

    const z = startCell.baseZ;
    const best: Record<string, number> = {};
    const cameFrom: Record<string, string | null> = {};
    const open: Node[] = [{ x: from.x, y: from.y, from: -1, cost: 0 }];

    const stateKey = function (x: number, y: number, dir: number): string {
        return String(x) + "," + String(y) + "," + String(dir);
    };

    best[stateKey(from.x, from.y, -1)] = 0;
    cameFrom[stateKey(from.x, from.y, -1)] = null;

    let goalKey: string | null = null;

    while (open.length > 0) {
        // Small maps and short routes: a linear scan is cheaper than a heap.
        let pick = 0;
        for (let i = 1; i < open.length; i++) {
            if (open[i].cost < open[pick].cost) {
                pick = i;
            }
        }

        const current = open.splice(pick, 1)[0];
        const currentKey = stateKey(current.x, current.y, current.from);

        if (current.cost > (best[currentKey] ?? Infinity)) {
            continue;
        }

        if (current.x === to.x && current.y === to.y) {
            goalKey = currentKey;
            break;
        }

        for (let d = 0; d < NEIGHBOURS.length; d++) {
            const x = current.x + NEIGHBOURS[d].dx;
            const y = current.y + NEIGHBOURS[d].dy;
            const code = blockCode(grid, x, y, z, false);

            // Never route through someone's queue: paving over it unbinds the ride and
            // the damage is invisible from the API. One queue tile is exempt and only
            // one: the tile a *queue* run finishes on, which is how a new line joins the
            // one already at a ride's door. A run that is not a queue had the same
            // exemption, so the tool ended runs on bound queues and unbound them - after
            // the fact, in a warning, while its own refusal said it never crossed one.
            if (code !== null && !(code === "queue" && wantQueue && x === to.x && y === to.y)) {
                continue;
            }

            const cost = current.cost + 1 + (current.from !== -1 && current.from !== d ? TURN_COST : 0);
            const key = stateKey(x, y, d);

            if (cost < (best[key] ?? Infinity)) {
                best[key] = cost;
                cameFrom[key] = currentKey;
                open.push({ x: x, y: y, from: d, cost: cost });
            }
        }
    }

    if (goalKey === null) {
        return null;
    }

    const tiles: Tile[] = [];
    let cursor: string | null = goalKey;

    while (cursor !== null) {
        const parts = cursor.split(",");
        tiles.push({ x: Number(parts[0]), y: Number(parts[1]) });
        cursor = cameFrom[cursor];
    }

    tiles.reverse();
    return tiles;
}

/**
 * A point that is a building rather than ground, named with the tile to use instead.
 *
 * Checked before routing, because after routing the same mistake surfaces as a routing
 * failure or a short run, and the model then changes the wrong end of the call.
 */
function buildingOnPoint(points: Tile[]): string | null {
    for (let i = 0; i < points.length; i++) {
        const door = rideDoorOn(points[i]);

        if (door) {
            const which = door.isExit ? "exit" : "entrance";
            const field = door.isExit ? "exitDoor" : "entranceDoor";

            return "Point " + String(i) + " of this run, " + tileName(points[i]) + ", is a ride " + which
                + " BUILDING. A path cannot be laid on it; guests stand on the tile the door opens onto, which is "
                + tileName(door.opensOnto) + ". Re-run this call with " + tileName(door.opensOnto)
                + " in place of " + tileName(points[i]) + ". park_status reports that tile for every ride as `"
                + field + "`, so read it from there rather than working it out. Nothing was built.";
        }

        if (isParkGate(points[i])) {
            return "Point " + String(i) + " of this run, " + tileName(points[i]) + ", is the park entrance"
                + " BUILDING. A path cannot be laid on it. Start from a path tile beside the gate instead:"
                + " park_status gives the gate's own tiles as `paths.gate` and the tiles guests can walk to"
                + " as `paths.runs`. Nothing was built.";
        }
    }

    return null;
}

/** "Point 1 of this run, 54,28, is carrying scenery. clear_scenery removes it, ..." */
function pointRefusal(index: number, blocker: Blocker): string {
    return "Point " + String(index) + " of this run, " + tileName(blocker.tile) + ", is " + blocker.what + "."
        + (blocker.remedy !== null
            ? " " + blocker.remedy + "."
            : " Nothing in this bridge changes that, so this run needs a different point.")
        // The same split `src/park/build.ts` draws between a coordinate that was wrong and
        // a coordinate that has gone stale: they read alike and need opposite answers.
        + (blocker.stale
            ? " The ground changes as you build, so a tile that was clear when you last read the map may not be now."
            : "");
}

/** Why a leg could not be routed, in tiles and conditions rather than as a category. */
function routeRefusal(points: Tile[], leg: number, wantQueue: boolean): string {
    const grid = readMapGrid();
    const from = points[leg];
    const to = points[leg + 1];
    const rule = " Every tile of a run has to be owned, flat, at the same height as the tile the run starts"
        + " on, and carrying nothing a footpath cannot share. Nothing was built.";

    // The start defines the run's height, so it is checked without one.
    const atStart = blockerAt(grid, from, null, wantQueue);

    if (atStart) {
        return pointRefusal(leg, atStart) + rule;
    }

    const startCell = grid.at(from.x, from.y);
    const z = startCell ? startCell.baseZ : -1;
    const atEnd = blockerAt(grid, to, z, wantQueue);

    if (atEnd) {
        return pointRefusal(leg + 1, atEnd) + rule;
    }

    // Both ends are ground a run can take, so what is in the way is ground between them -
    // ground the caller has no way of seeing, which is the half of this call that is
    // perception rather than layout.
    let blockers = blockedWayBetween(grid, from, to, z, wantQueue);

    if (blockers.length === 0) {
        blockers = blockersOn(grid, lineBetween(from, to), z, wantQueue);
    }

    if (blockers.length === 0) {
        return "No route between " + tileName(from) + " and " + tileName(to)
            + ", and this call could not narrow it to particular tiles." + rule;
    }

    let anyWithoutRemedy = false;

    for (let i = 0; i < blockers.length; i++) {
        if (blockers[i].remedy === null) {
            anyWithoutRemedy = true;
        }
    }

    return "No route between " + tileName(from) + " and " + tileName(to)
        + ". Both of those tiles can take a path; what is between them cannot: "
        + blockerGroups(blockers) + "."
        + (anyWithoutRemedy
            ? " `waypoints` draws the run round ground nothing here can change: a list of corners,"
                + " laid as straight runs between them."
            : "")
        + rule;
}

export function buildPath(request: BuildPathRequest, done: (outcome: BuildPathOutcome) => void): void {
    const kind = request.queue ? "queue" : "path";
    const otherKind = request.queue ? "path" : "queue";
    const blocked = buildingOnPoint(request.points);

    if (blocked !== null) {
        return done(pathRefusal(blocked));
    }

    // Route each leg separately: with waypoints the caller has chosen the shape and the
    // tool only fills in tiles. With two points the tool picks the line, which is a
    // design decision it is making on the caller's behalf.
    let tiles: Tile[] | null = [];
    const placedAlready: Record<string, boolean> = {};
    let failedLeg = -1;

    for (let i = 0; i + 1 < request.points.length && tiles !== null; i++) {
        const leg = route(request.points[i], request.points[i + 1], request.queue);

        if (leg === null) {
            failedLeg = i;
            tiles = null;
            break;
        }

        for (let t = 0; t < leg.length; t++) {
            // Legs can double back over each other, so check the whole run, not just the
            // previous tile: otherwise the same tile is laid and counted twice.
            const key = String(leg[t].x) + "," + String(leg[t].y);

            if (!placedAlready[key]) {
                placedAlready[key] = true;
                tiles.push(leg[t]);
            }
        }
    }

    if (tiles === null || tiles.length === 0) {
        return done({
            ok: false,
            tilesPlaced: 0,
            tilesRouted: 0,
            route: [],
            connectedToPark: false,
            detail: failedLeg >= 0
                ? routeRefusal(request.points, failedLeg, request.queue)
                : "This run has no legs to route: give two points or more. Nothing was built."
        });
    }

    const grid = readMapGrid();
    const reachableBefore = walkableFromParkEntrance();
    const before: Record<string, { path: boolean; queue: boolean }> = {};
    /**
     * The game's answer to every placement it turned down, keyed by the tile it was asked
     * about. Kept because a tile that carries no path afterwards has exactly one honest
     * explanation - the one the game gave - and this file used to discard it.
     */
    const refused: Record<string, string> = {};
    const recorder = function (key: string): (result: GameActionResult) => void {
        return function (result) {
            if (result && result.error) {
                refused[key] = actionError(result);
            }
        };
    };
    let replacedExistingPath = 0;
    let replacedQueue = 0;

    for (let i = 0; i < tiles.length; i++) {
        const cell = grid.at(tiles[i].x, tiles[i].y);

        if (!cell) {
            continue;
        }

        before[tileName(tiles[i])] = { path: cell.path, queue: cell.queue };

        if (request.queue && cell.path && !cell.queue) {
            replacedExistingPath++;
        }

        if (!request.queue && cell.queue) {
            replacedQueue++;
        }

        context.executeAction("footpathplace", {
            x: toWorld(tiles[i].x),
            y: toWorld(tiles[i].y),
            z: cell.baseZ,
            direction: 0,
            object: request.surfaceObject,
            railingsObject: request.railingsObject,
            slopeType: 0,
            slopeDirection: 0,
            constructFlags: request.queue ? FOOTPATH_QUEUE_FLAG : 0
        }, recorder(tileName(tiles[i])));
    }

    context.setTimeout(function () {
        const laidTiles = tiles as Tile[];
        const placed = countPathTiles(laidTiles);
        const walkable = walkableFromParkEntrance();

        // Four outcomes per tile, and the old count collapsed two of them: a tile that was
        // already a footpath and really did become a queue was counted as "already path",
        // so converting one printed "Laid 0 queue tiles, joining 1 that were already path"
        // while tilesPlaced said 1 and the tile on the map had changed type.
        let bare = 0;
        let laid = 0;
        let toConvert = 0;
        let converted = 0;
        let joined = 0;
        const wrongKind: Tile[] = [];
        const noPath: Tile[] = [];

        for (let i = 0; i < laidTiles.length; i++) {
            const was = before[tileName(laidTiles[i])] || { path: false, queue: false };
            const now = pathState(laidTiles[i].x, laidTiles[i].y);
            const rightKind = now.path && now.queue === request.queue;

            if (!was.path) {
                bare++;

                if (rightKind) {
                    laid++;
                }
            } else if (was.queue !== request.queue) {
                toConvert++;

                if (rightKind) {
                    converted++;
                }
            } else {
                joined++;
            }

            if (!now.path) {
                noPath.push(laidTiles[i]);
            } else if (!rightKind) {
                wrongKind.push(laidTiles[i]);
            }
        }

        const first = request.points[0];
        const last = request.points[request.points.length - 1];
        const startWalkable = tileIsWalkable(walkable, first);
        const endWalkable = tileIsWalkable(walkable, last);
        // The tile a ride's entrance claims is dead-ended by the game on purpose, so its
        // absence from the walk out of the gate is not evidence about this run. It is
        // evidence about nothing at all unless some tile of the run does reach the
        // network - otherwise excusing it would excuse an island.
        let touchesNetwork = false;

        for (let i = 0; i < laidTiles.length; i++) {
            if (tileIsWalkable(walkable, laidTiles[i])) {
                touchesNetwork = true;
                break;
            }
        }

        const startDoorRide = startWalkable ? null : rideClaimingDoorTile(first);
        const endDoorRide = endWalkable ? null : rideClaimingDoorTile(last);
        const startConnected = startWalkable || (startDoorRide !== null && touchesNetwork);
        const endConnected = endWalkable || (endDoorRide !== null && touchesNetwork);
        const connected = startConnected && endConnected;
        /** The ends that really are stranded: a claimed door tile is not one of them. */
        const stranded: Tile[] = [];

        if (!startWalkable && startDoorRide === null) {
            stranded.push(first);
        }

        if (!endWalkable && endDoorRide === null) {
            stranded.push(last);
        }

        const claimed: string[] = [];

        if (startDoorRide !== null) {
            claimed.push(tileName(first) + " carries ride " + String(startDoorRide) + "'s queue");
        }

        if (endDoorRide !== null) {
            claimed.push(tileName(last) + " carries ride " + String(endDoorRide) + "'s queue");
        }
        // Severance is tiles that used to be walkable and no longer are. Comparing raw
        // totals instead double-counted: laying an unconnected stub left the totals equal
        // and reported the whole run as "cut off", telling the model to move a queue that
        // had broken nothing.
        let lost = 0;

        for (const tile in reachableBefore) {
            if (reachableBefore[tile] && !walkable[tile]) {
                lost++;
            }
        }

        const everyTileIsRight = placed === laidTiles.length && laid === bare && converted === toConvert;
        let summary: string;

        if (everyTileIsRight) {
            const clauses: string[] = [];

            if (laid > 0 || (converted === 0 && joined === 0)) {
                clauses.push("laid " + plural(laid, kind + " tile"));
            }

            if (converted > 0) {
                clauses.push("turned " + plural(converted, otherKind + " tile") + " into " + kind);
            }

            if (joined > 0) {
                clauses.push("joined " + plural(joined, "tile") + " that "
                    + (joined === 1 ? "was" : "were") + " already " + kind);
            }

            const sentence = clauses.join(", ");
            summary = sentence.charAt(0).toUpperCase() + sentence.substring(1) + ".";
        } else {
            const shortfall: string[] = [];

            if (noPath.length > 0) {
                shortfall.push("no path reached " + noPath.map(tileName).join(" "));
            }

            if (wrongKind.length > 0) {
                shortfall.push(wrongKind.map(tileName).join(" ") + " still carr"
                    + (wrongKind.length === 1 ? "ies" : "y") + " " + otherKind + " rather than " + kind);
            }

            // What the game said about the tiles that came up short, quoted rather than
            // guessed at. Every shortfall used to carry the same sentence about door tiles,
            // including the ones the game had turned down for money, for land, or for the
            // pause - a cause this call had never read, in the one message it is read for.
            const said: string[] = [];
            const shortTiles = noPath.concat(wrongKind);
            let unexplained = 0;

            for (let i = 0; i < shortTiles.length; i++) {
                const answer = refused[tileName(shortTiles[i])];

                if (typeof answer !== "string") {
                    unexplained++;
                } else if (said.indexOf(answer) < 0) {
                    said.push(answer);
                }
            }

            summary = "Only " + String(placed) + " of " + String(laidTiles.length) + " tiles carry a path: "
                + shortfall.join("; ") + "."
                + (said.length > 0 ? " The game refused the placement: " + said.join("; ") + "." : "")
                + (unexplained > 0
                    // Only where nothing was read is a general fact the best there is to offer,
                    // and this is the one that fits: the game takes a placement on a door tile
                    // and nothing appears.
                    ? " The game gave no refusal for " + String(unexplained) + " of them. A tile a ride"
                        + " entrance, exit or park gate stands on cannot take a path at all - park_status gives"
                        + " the tile each door opens onto as `entranceDoor` and `exitDoor`, and those are the"
                        + " tiles a queue and an exit path run to."
                    : "")
                // Read back now rather than inferred from the refusal text: a pause can arrive
                // after these actions were fired, and the state at the moment the message is
                // written is the one the model has to act on.
                + (gamePaused()
                    ? " The game is paused, and footpathplace - the action build_path fires for every tile of"
                        + " a run - is one of the actions a paused game refuses, so no tile of this run could"
                        + " be laid. " + UNPAUSE_CALL
                    : "");
        }

        done({
            // `ok` is whether the path got laid. Whether it reaches the park is
            // `connectedToPark`: a queue built before its connecting path is not a failure.
            ok: everyTileIsRight,
            tilesPlaced: placed,
            tilesRouted: laidTiles.length,
            route: laidTiles,
            connectedToPark: connected,
            detail: summary
                // `placed === 0` is a run with no tile of it on the ground, so there is
                // nothing for guests to walk and nothing to connect. Saying it is cut off
                // and offering `reachableSample` there points at moving the endpoints, which
                // is a fix for a different failure - the same defect as the door-building
                // sentence above, one clause along.
                + (connected || placed === 0
                    ? ""
                    : " This run does not reach the park entrance, so guests cannot walk it: "
                        + (stranded.length === 2
                            ? "neither end, " + tileName(first) + " or " + tileName(last) + ", is connected"
                            : (stranded.length === 1
                                ? (stranded[0] === first
                                    ? "its start " + tileName(first) + " is cut off"
                                    : "its far end " + tileName(last) + " is cut off")
                                : "no tile of it is in the network guests can walk"))
                        + "."
                        + (stranded.length > 0
                            ? " Having a path on a tile is not the same as that tile being reachable. Aim one end"
                                + " at a tile covered by a run park_status reports under `paths.runs` whose `kind`"
                                + " is \"path\" - those are the tiles guests can actually walk to, and a run covers"
                                + " every tile between its `fromX`,`fromY` and its `toX`,`toY` - rather than at a"
                                + " neighbouring tile that happens to be paved. A run whose `kind` is \"queue\" is"
                                + " not an anchor for either kind of run: ordinary path laid onto one unbinds that"
                                + " queue from its ride, and a queue laid onto one joins two rides' lines together."
                            : ""))
                // Said whether or not the run reaches the park, because it is the sentence
                // that stops the one above being read about the wrong tile. A run was torn
                // out over this: the verdict called a correctly built queue "cut off" at
                // the one tile a queue has to touch, and the advice above then pointed at
                // moving it off the door.
                + (connected || placed === 0 || claimed.length === 0
                    ? ""
                    : " " + claimed.join(", and ") + " at the tile that ride's entrance opens onto. The game"
                        + " dead-ends the tile a ride claims, so it drops out of the walk from the park gate"
                        + " however the rest of the run is laid; it is not the end that has to reach the park,"
                        + " and a queue that does not touch it leaves the ride with no line.")
                // A backstop rather than an outcome the router can now produce: a run that
                // is not a queue refuses a queue tile anywhere on it, endpoints included,
                // and says so before anything is built. It stays because this is damage
                // nothing in the API shows, so noticing it late still beats not noticing.
                + (replacedQueue > 0
                    ? " WARNING: " + String(replacedQueue) + " tiles replaced an existing queue line with ordinary path,"
                        + " which unbinds it from its ride."
                    : "")
                + (lost > 0
                    ? " WARNING: " + String(lost) + " path tiles are no longer reachable from the park entrance."
                        + " A queue on its own is walked like any other path; what dead-ends is the one tile a"
                        + " ride's entrance claims, and the route to those tiles ran through such a tile."
                    : (replacedExistingPath > 0
                        ? " Nothing was cut off by it."
                        : ""))
        });
    }, STEP_DELAY_MS);
}
