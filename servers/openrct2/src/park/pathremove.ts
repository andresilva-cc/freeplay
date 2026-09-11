import { DIRECTION_VECTORS, toWorld, unitStep } from "./map.js";
import { PARK_ENTRANCE, queuePathServes, RIDE_ENTRANCE, RIDE_EXIT, walkableFromParkEntrance } from "./paths.js";
import type { Tile } from "./paths.js";

const STEP_DELAY_MS = 200;

/** How many tile names one message will spell out before it starts counting instead. */
const MAX_NAMED_TILES = 12;

/**
 * OpenRCT2 refuses any game action that does not carry `Flags::AllowWhilePaused` while the
 * game is paused - `GameActionRunner.cpp`, `CheckActionInPausedMode` - answering
 * STR_CONSTRUCTION_NOT_POSSIBLE_WHILE_GAME_IS_PAUSED.
 *
 * `footpathremove` is the only action this file fires, and it does not carry the flag, so a
 * paused run takes nothing up. The run is still made rather than refused up front: a refused
 * removal changes nothing and charges nothing, so there is nothing to protect against, and
 * letting it run quotes the reason the game gave instead of restating a transcribed rule.
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

export interface RemovePathRequest {
    /** Corners of the run, in order. Two points means "you pick the corner". */
    points: Tile[];
}

/** A ride whose entrance had a queue bound to it before this call and has none now. */
export interface RideWithoutQueue {
    id: number;
    name: string;
    entranceDoor: Tile;
}

export interface RemovePathOutcome {
    ok: boolean;
    /** Tiles that carried a footpath and no longer do, counted by re-reading the map. */
    tilesRemoved: number;
    /** Every tile the run covered, whether or not anything was on it. */
    tilesTargeted: number;
    route: Tile[];
    removed: Tile[];
    /**
     * Path tiles guests can still walk to from the park entrance, counted afterwards.
     *
     * `null` when the call was refused before anything was touched: the network was never
     * walked, so there is no figure. It used to report 0 there, which reads as "the park is
     * completely severed" - a measurement that was never taken, in the one message the model
     * is already reading because something went wrong.
     */
    reachableFromEntrance: number | null;
    ridesLeftWithoutQueue: RideWithoutQueue[];
    detail: string;
    /**
     * Set only when the arguments were refused before anything was touched. Every failure
     * carries the whole outcome shape as well, so `detail` always holds the message.
     */
    error?: string;
}

/** An outcome for a run that never started, in the shape every other outcome uses. */
export function removePathRefusal(detail: string): RemovePathOutcome {
    return {
        ok: false,
        tilesRemoved: 0,
        tilesTargeted: 0,
        route: [],
        removed: [],
        reachableFromEntrance: null,
        ridesLeftWithoutQueue: [],
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

function inBounds(tile: Tile): boolean {
    return tile.x >= 0 && tile.y >= 0 && tile.x < map.size.x && tile.y < map.size.y;
}

/** Names up to a dozen tiles, then says how many more there were. */
function nameTiles(tiles: Tile[]): string {
    const named = tiles.slice(0, MAX_NAMED_TILES).map(tileName).join(" ");

    return tiles.length > MAX_NAMED_TILES
        ? named + " and " + String(tiles.length - MAX_NAMED_TILES) + " more"
        : named;
}

/**
 * The tiles a run covers: straight legs between the points, x first and then y.
 *
 * `build_path` routes around obstructions because a path cannot be laid on a tree.
 * Removal has nothing to route around — a tile either carries a footpath or it does
 * not — so the run is the literal line, and a leg whose ends share neither row nor
 * column turns once, along x and then along y. Passing `build_path`'s own `route`
 * back as `waypoints` therefore takes out exactly the tiles it laid.
 */
export function straightRun(points: Tile[]): Tile[] {
    const tiles: Tile[] = [];
    const seen: Record<string, boolean> = {};

    const add = function (tile: Tile): void {
        const key = tileName(tile);

        if (!seen[key]) {
            seen[key] = true;
            tiles.push(tile);
        }
    };

    add({ x: points[0].x, y: points[0].y });

    for (let i = 0; i + 1 < points.length; i++) {
        const to = points[i + 1];
        let x = points[i].x;
        let y = points[i].y;
        // The step is taken once, not recomputed. `unitStep` of a difference that is not a
        // number is 0, and a loop that adds 0 while waiting to arrive never ends - inside
        // the game process that is a hung OpenRCT2, not a failed call.
        const stepX = unitStep(to.x - x);
        const stepY = unitStep(to.y - y);

        while (stepX !== 0 && x !== to.x) {
            x += stepX;
            add({ x: x, y: y });
        }

        while (stepY !== 0 && y !== to.y) {
            y += stepY;
            add({ x: x, y: y });
        }
    }

    return tiles;
}

/** Whether this tile carries a footpath, whether it is a queue, and the height it sits at. */
function footpathOn(tile: Tile): { queue: boolean; baseZ: number } | null {
    if (!inBounds(tile)) {
        return null;
    }

    const mapTile = map.getTile(tile.x, tile.y);

    for (let i = 0; i < mapTile.numElements; i++) {
        const element = mapTile.getElement(i);

        if (element.type !== "footpath") {
            continue;
        }

        const path = element as FootpathElement;

        return { queue: path.isQueue, baseZ: path.baseZ };
    }

    return null;
}

/**
 * A tile in the run that is a structure rather than ground, named with what stands on it.
 *
 * Checked before anything is removed, because `footpathremove` on a ride entrance takes
 * nothing away and answers as if it had: the model would be told the run came up short
 * with no way to tell which tile refused, or why.
 */
function structureOnRun(tiles: Tile[]): string | null {
    for (let i = 0; i < tiles.length; i++) {
        if (!inBounds(tiles[i])) {
            return "Tile " + tileName(tiles[i]) + " of this run is off the map, which is "
                + String(map.size.x) + " by " + String(map.size.y) + " tiles. Nothing was removed.";
        }

        const mapTile = map.getTile(tiles[i].x, tiles[i].y);

        for (let e = 0; e < mapTile.numElements; e++) {
            const element = mapTile.getElement(e);

            if (element.type !== "entrance") {
                continue;
            }

            const entrance = element as EntranceElement;

            if (entrance.object === PARK_ENTRANCE) {
                return "Tile " + tileName(tiles[i]) + " of this run is the park entrance BUILDING - the"
                    + " park's own gate, which belongs to no ride and is not a footpath. Nothing in this"
                    + " bridge removes it, and demolishing a ride will not: route around it instead."
                    + " park_status gives the gate's own tiles as `paths.entrance`. Nothing was removed.";
            }

            if (entrance.object !== RIDE_ENTRANCE && entrance.object !== RIDE_EXIT) {
                // Deliberately names no ride. The bug this replaces printed `ride 0` for the park
                // gate because it treated "not a ride exit" as "a ride entrance"; an entrance kind
                // this build does not know about must not inherit that guess.
                return "Tile " + tileName(tiles[i]) + " of this run carries an entrance BUILDING of an"
                    + " unrecognised kind (`object` " + String(entrance.object) + "), which is not a"
                    + " footpath and cannot be removed here. Give a run that goes round it."
                    + " Nothing was removed.";
            }

            const which = entrance.object === RIDE_EXIT ? "exit" : "entrance";

            return "Tile " + tileName(tiles[i]) + " of this run is the " + which + " BUILDING of ride "
                + String(entrance.ride) + ", which is not a footpath and cannot be removed here."
                + " park_status gives that building as `" + which + "` and the tile it opens onto as `"
                + which + "Door`; the door tile is the one that carries a path. Remove the ride itself"
                + " with operate_ride `demolish`. Nothing was removed.";
        }
    }

    return null;
}

/** The tile a ride's entrance door opens onto: one step out from the building. */
function entranceDoorOf(ride: Ride): Tile | null {
    const station = ride.stations.length > 0 ? ride.stations[0] : undefined;
    const entrance = station && station.entrance ? station.entrance : null;

    if (!entrance) {
        return null;
    }

    // `direction` points at the ride, so the door opens the other way.
    const towardsRide = DIRECTION_VECTORS[entrance.direction % 4];

    return { x: entrance.x / 32 - towardsRide.dx, y: entrance.y / 32 - towardsRide.dy };
}

/**
 * Which rides have a queue bound to them right now, by ride id.
 *
 * The game binds a queue to a ride by walking the chain outward from the entrance
 * building, so the one tile that decides it is the tile that door opens onto. A queue
 * elsewhere on the map, however long, serves nobody.
 */
function ridesServedByQueue(): Record<number, boolean> {
    const served: Record<number, boolean> = {};
    const rides = map.rides;

    for (let i = 0; i < rides.length; i++) {
        const door = entranceDoorOf(rides[i]);

        served[rides[i].id] = door !== null && inBounds(door) && queuePathServes(door, rides[i].id);
    }

    return served;
}

/**
 * Take the footpath off a run of tiles.
 *
 * Nothing else in this bridge removes a path. `build_path` can lay a path over a queue or
 * a queue over a path, and both of those are mistakes with no other remedy: an ordinary
 * path laid over a queue unbinds it from its ride, and a queue laid across a through route
 * splits the park, because guests cannot walk through one.
 *
 * Every count here comes from reading the map back a tick later, including whether a ride
 * still has the queue that served it, which is the damage that is otherwise invisible.
 */
export function removePath(request: RemovePathRequest, done: (outcome: RemovePathOutcome) => void): void {
    for (let i = 0; i < request.points.length; i++) {
        const point = request.points[i];

        if (!isFinite(point.x) || !isFinite(point.y)
            || Math.floor(point.x) !== point.x || Math.floor(point.y) !== point.y) {
            return done(removePathRefusal("Point " + String(i) + " of this run is "
                + String(point.x) + "," + String(point.y) + ", which is not a pair of whole tile"
                + " coordinates. Nothing was removed."));
        }
    }

    const tiles = straightRun(request.points);
    const blocked = structureOnRun(tiles);

    if (blocked !== null) {
        return done(removePathRefusal(blocked));
    }

    const reachableBefore = walkableFromParkEntrance();
    const servedBefore = ridesServedByQueue();
    const hadPath: { tile: Tile; queue: boolean }[] = [];
    /**
     * The game's answer to every removal it turned down, keyed by the tile it was asked
     * about. A tile that still carries a path afterwards has exactly one honest explanation
     * - the one the game gave - and this file used to report the count and discard it.
     */
    const refused: Record<string, string> = {};
    const recorder = function (key: string): (result: GameActionResult) => void {
        return function (result) {
            if (result && result.error) {
                refused[key] = actionError(result);
            }
        };
    };

    for (let i = 0; i < tiles.length; i++) {
        const path = footpathOn(tiles[i]);

        if (!path) {
            continue;
        }

        hadPath.push({ tile: tiles[i], queue: path.queue });

        context.executeAction("footpathremove", {
            x: toWorld(tiles[i].x),
            y: toWorld(tiles[i].y),
            z: path.baseZ
        }, recorder(tileName(tiles[i])));
    }

    context.setTimeout(function () {
        const removed: Tile[] = [];
        const stayed: Tile[] = [];
        let removedQueues = 0;

        for (let i = 0; i < hadPath.length; i++) {
            if (footpathOn(hadPath[i].tile) === null) {
                removed.push(hadPath[i].tile);

                if (hadPath[i].queue) {
                    removedQueues++;
                }
            } else {
                stayed.push(hadPath[i].tile);
            }
        }

        const walkable = walkableFromParkEntrance();
        const servedAfter = ridesServedByQueue();
        const rides = map.rides;
        const lostQueue: RideWithoutQueue[] = [];

        for (let i = 0; i < rides.length; i++) {
            if (!servedBefore[rides[i].id] || servedAfter[rides[i].id]) {
                continue;
            }

            const door = entranceDoorOf(rides[i]);

            lostQueue.push({
                id: rides[i].id,
                name: rides[i].name,
                entranceDoor: door || { x: -1, y: -1 }
            });
        }

        const wasRemoved: Record<string, boolean> = {};

        for (let i = 0; i < removed.length; i++) {
            wasRemoved[tileName(removed[i])] = true;
        }

        let reachableNow = 0;
        let cutOff = 0;

        for (const tile in walkable) {
            if (walkable[tile]) {
                reachableNow++;
            }
        }

        // A tile this call took up is not a tile that got cut off, and counting it as one
        // turns every successful removal into a severance warning about its own work.
        for (const tile in reachableBefore) {
            if (reachableBefore[tile] && !walkable[tile] && !wasRemoved[tile]) {
                cutOff++;
            }
        }

        const bare = tiles.length - hadPath.length;
        let summary: string;

        if (stayed.length > 0) {
            // The count on its own names a category, not a fact the model can act on. What
            // the game said about each tile it would not clear is the fact, so it is quoted.
            const said: string[] = [];
            let unexplained = 0;

            for (let i = 0; i < stayed.length; i++) {
                const answer = refused[tileName(stayed[i])];

                if (typeof answer !== "string") {
                    unexplained++;
                } else if (said.indexOf(answer) < 0) {
                    said.push(answer);
                }
            }

            summary = "Removed " + String(removed.length) + " of " + String(hadPath.length)
                + " footpath tiles; " + nameTiles(stayed) + " still "
                + (stayed.length === 1 ? "carries" : "carry") + " a path."
                + (said.length > 0 ? " The game refused the removal: " + said.join("; ") + "." : "")
                + (unexplained > 0
                    ? " The game gave no refusal for " + String(unexplained) + " of them and the path is"
                        + " still on the map."
                    : "")
                // Read back now rather than inferred from the refusal text: a pause can arrive
                // after these actions were fired, and the state at the moment the message is
                // written is the one the model has to act on.
                + (gamePaused()
                    ? " The game is paused, and footpathremove - the action remove_path fires for every tile"
                        + " that carries a path - is one of the actions a paused game refuses, so no path can"
                        + " be taken up while the clock is stopped. " + UNPAUSE_CALL
                    : "");
        } else if (hadPath.length === 0) {
            summary = "None of the " + plural(tiles.length, "tile") + " in this run carried a footpath,"
                + " so nothing was removed.";
        } else {
            summary = "Removed " + plural(removed.length, "footpath tile")
                + (removedQueues > 0 ? ", " + String(removedQueues) + " of them queue" : "")
                + "."
                + (bare > 0 ? " " + String(bare) + " of the " + plural(tiles.length, "tile")
                    + " in the run carried no footpath." : "");
        }

        const notes: string[] = [];

        notes.push(plural(reachableNow, "path tile") + " "
            + (reachableNow === 1 ? "is" : "are") + " reachable from the park entrance.");

        if (cutOff > 0) {
            // Taking a tile out of a route strands whatever was behind it. Rebuilding the
            // route is the only thing that reconnects it: removal never adds a way through,
            // so there is no opposite case to report here.
            notes.push("WARNING: " + plural(cutOff, "path tile")
                + " guests could reach before are now cut off from the park entrance.");
        }

        for (let i = 0; i < lostQueue.length; i++) {
            notes.push("WARNING: ride " + String(lostQueue[i].id) + " " + lostQueue[i].name
                + " no longer has a queue bound to it. Its entrance door is at "
                + tileName(lostQueue[i].entranceDoor) + ", and until a queue tile sits there guests"
                + " crowd the building and never board.");
        }

        done({
            // `ok` means one thing: every tile the run named is free of footpath now. A run
            // over ground that never had a path is not a failure, and `tilesRemoved` says so.
            ok: stayed.length === 0,
            tilesRemoved: removed.length,
            tilesTargeted: tiles.length,
            route: tiles,
            removed: removed,
            reachableFromEntrance: reachableNow,
            ridesLeftWithoutQueue: lostQueue,
            detail: summary + " " + notes.join(" ")
        });
    }, STEP_DELAY_MS);
}
