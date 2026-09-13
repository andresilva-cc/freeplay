import { DIRECTION_VECTORS, toWorld } from "./map.js";
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
    /**
     * Exactly the tiles to take the footpath off, in the order given.
     *
     * The same field `build_path` takes and the same field it hands back, so a run laid
     * wrong is undone by passing that call's own `tiles` straight here.
     */
    tiles: Tile[];
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
    /** Every tile the run named, once each, whether or not anything was on it. */
    tilesTargeted: number;
    /** The tiles this call named, in the order given: `build_path`'s own field name. */
    tiles: Tile[];
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
        tiles: [],
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
 * The tiles as given, with any tile named twice kept once.
 *
 * There is no line to fill in and nothing to route around: a tile either carries a
 * footpath or it does not, and the caller named the tiles. `build_path` reports the tiles
 * it laid under the same name, so handing that list straight back lifts exactly them.
 */
export function uniqueTiles(tiles: Tile[]): Tile[] {
    const seen: Record<string, boolean> = {};
    const kept: Tile[] = [];

    for (let i = 0; i < tiles.length; i++) {
        const key = tileName(tiles[i]);

        if (!seen[key]) {
            seen[key] = true;
            kept.push({ x: tiles[i].x, y: tiles[i].y });
        }
    }

    return kept;
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
                    + " park_status gives the gate's own tiles as `paths.gate`. Nothing was removed.";
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
export function entranceDoorOf(ride: Ride): Tile | null {
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
export function ridesServedByQueue(): Record<number, boolean> {
    const served: Record<number, boolean> = {};
    const rides = map.rides;

    for (let i = 0; i < rides.length; i++) {
        const door = entranceDoorOf(rides[i]);

        served[rides[i].id] = door !== null && inBounds(door) && queuePathServes(door, rides[i].id);
    }

    return served;
}

/**
 * The rides that had a queue bound to them before a call and have none after.
 *
 * Shared with `build_path`, which can take a ride's line away without removing a single
 * tile: a queue laid onto another ride's queue chains the two into one line, and the game
 * then binds the whole chain to one entrance. Nothing in the API reports that, so both
 * calls measure it the same way - read the chain out of every ride's entrance twice.
 */
export function ridesThatLostTheirQueue(
    before: Record<number, boolean>, after: Record<number, boolean>
): RideWithoutQueue[] {
    const rides = map.rides;
    const lost: RideWithoutQueue[] = [];

    for (let i = 0; i < rides.length; i++) {
        if (!before[rides[i].id] || after[rides[i].id]) {
            continue;
        }

        const door = entranceDoorOf(rides[i]);

        lost.push({
            id: rides[i].id,
            name: rides[i].name,
            entranceDoor: door || { x: -1, y: -1 }
        });
    }

    return lost;
}

/**
 * Take the footpath off a run of tiles.
 *
 * Nothing else in this bridge removes a path. `build_path` refuses an ordinary path over a
 * queue, because that unbinds it from its ride invisibly, but it will lay a queue over a
 * path and a queue onto another ride's queue, and a ride's entrance claiming a queue - not
 * the queue itself - dead-ends the tile its door opens onto, cutting off whatever lay past
 * it. Those are mistakes with no other remedy than taking the paving back up.
 *
 * Every count here comes from reading the map back a tick later, including whether a ride
 * still has the queue that served it, which is the damage that is otherwise invisible.
 */
export function removePath(request: RemovePathRequest, done: (outcome: RemovePathOutcome) => void): void {
    for (let i = 0; i < request.tiles.length; i++) {
        const tile = request.tiles[i];

        if (!isFinite(tile.x) || !isFinite(tile.y)
            || Math.floor(tile.x) !== tile.x || Math.floor(tile.y) !== tile.y) {
            return done(removePathRefusal("Tile " + String(i) + " of this run is "
                + String(tile.x) + "," + String(tile.y) + ", which is not a pair of whole tile"
                + " coordinates. Nothing was removed."));
        }
    }

    const tiles = uniqueTiles(request.tiles);

    if (tiles.length === 0) {
        return done(removePathRefusal("This run names no tiles. `tiles` is the list of tiles to take"
            + " the footpath off, so one tile is a run and there is no shorter one."
            + " Nothing was removed."));
    }

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
        const lostQueue = ridesThatLostTheirQueue(servedBefore, ridesServedByQueue());
        const wasRemoved: Record<string, boolean> = {};

        for (let i = 0; i < removed.length; i++) {
            wasRemoved[tileName(removed[i])] = true;
        }

        let reachableNow = 0;
        let reachableThen = 0;
        /**
         * The tiles guests could walk to before this call and cannot now, named.
         *
         * A count alone names a category. One session took up the tile its park entrance
         * path ran through, read "reachableFromEntrance: 27" with no figure to compare it
         * to and no tile named, concluded that a ride queue elsewhere had severed them, and
         * never relaid the tile. Which tiles went is measurable only either side of the
         * removal, which is to say only here.
         */
        const cutOffTiles: Tile[] = [];

        for (const tile in walkable) {
            if (walkable[tile]) {
                reachableNow++;
            }
        }

        // A tile this call took up is not a tile that got cut off, and counting it as one
        // turns every successful removal into a severance warning about its own work.
        for (const tile in reachableBefore) {
            if (!reachableBefore[tile]) {
                continue;
            }

            reachableThen++;

            if (!walkable[tile] && !wasRemoved[tile]) {
                const at = tile.split(",");
                cutOffTiles.push({ x: Number(at[0]), y: Number(at[1]) });
            }
        }

        // In coordinate order rather than the order the flood happened to reach them, which
        // interleaves separate branches and reads as a shuffle.
        cutOffTiles.sort(function (a, b) { return a.x === b.x ? a.y - b.y : a.x - b.x; });

        // The tiles this call took up that guests could reach before. Not a cause - nothing
        // here measured which tile carried the route - but the fact the model was missing
        // when it blamed a queue for tiles its own removal had stranded.
        const removedFromNetwork: Tile[] = [];

        for (let i = 0; i < removed.length; i++) {
            if (reachableBefore[tileName(removed[i])]) {
                removedFromNetwork.push(removed[i]);
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

        // Both figures, because one of them on its own is a number with nothing to read it
        // against: the network was walked before the removal and again after it, and the
        // pair is the only thing that says whether this call cost the park anything.
        notes.push(plural(reachableNow, "path tile") + " "
            + (reachableNow === 1 ? "is" : "are") + " reachable from the park entrance"
            + (reachableThen === reachableNow
                ? ", the same as before this call."
                : ", against " + String(reachableThen) + " before this call."));

        if (cutOffTiles.length > 0) {
            // Taking a tile out of a route strands whatever was behind it. Rebuilding the
            // route is the only thing that reconnects it: removal never adds a way through,
            // so there is no opposite case to report here.
            notes.push("WARNING: " + plural(cutOffTiles.length, "path tile")
                + " guests could reach before are now cut off from the park entrance: "
                + nameTiles(cutOffTiles) + "."
                + (removedFromNetwork.length > 0
                    ? " " + nameTiles(removedFromNetwork)
                        + (removedFromNetwork.length === 1 ? " was itself" : " were themselves")
                        + " reachable from the park entrance before this call and carr"
                        + (removedFromNetwork.length === 1 ? "ies" : "y") + " no path now."
                    : ""));
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
            tiles: tiles,
            removed: removed,
            reachableFromEntrance: reachableNow,
            ridesLeftWithoutQueue: lostQueue,
            detail: summary + " " + notes.join(" ")
        });
    }, STEP_DELAY_MS);
}
