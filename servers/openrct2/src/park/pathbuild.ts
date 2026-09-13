import { readMapGrid, toWorld } from "./map.js";
import type { MapGrid } from "./map.js";
import { immovableOn, isParkGate, neighboursOf, plural, rideDoorOn, tileName } from "./neighbours.js";
import { countPathTiles, tileIsWalkable, walkableFromParkEntrance } from "./paths.js";
import type { Tile } from "./paths.js";
import { ridesServedByQueue, ridesThatLostTheirQueue } from "./pathremove.js";
import type { RideWithoutQueue } from "./pathremove.js";

const STEP_DELAY_MS = 200;
export const DEFAULT_QUEUE_OBJECT = 11;
export const DEFAULT_PATH_OBJECT = 1;
const FOOTPATH_QUEUE_FLAG = 1;

const NEIGHBOURS = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];

/** How many tile names one message spells out before it starts counting instead. */
const MAX_NAMED_TILES = 12;

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
    /**
     * Exactly the tiles to pave, in the order given.
     *
     * Nothing is routed, nothing is inserted between them and nothing is reordered. This
     * used to be a pair of endpoints, or a list of corners with a router filling in the
     * legs, and both of those were this file choosing the shape of the park's paths. Wiring
     * one ride needs two runs that must not collide - a queue from the entrance door and an
     * ordinary path from the exit door - and a router picking each line independently laid
     * them over each other, unbinding the queue and orphaning the exit. There is no shape
     * this file can pick that is the caller's shape, so it picks none.
     */
    tiles: Tile[];
    queue: boolean;
    /** Surface and railing styles: the player's choice, not the bridge's. */
    surfaceObject: number;
    railingsObject: number;
}

export interface BuildPathOutcome {
    ok: boolean;
    tilesPlaced: number;
    /** Every tile the run named, once each, whether or not a path reached it. */
    tilesTargeted: number;
    /**
     * The tiles this call paved, in the order given. Handed back to `remove_path` as its
     * own `tiles` it lifts exactly these, which is why the two share one field name.
     */
    tiles: Tile[];
    /**
     * Whether guests can walk to every tile of the run from the park entrance.
     *
     * With one exception, which is the game's rather than this file's: the tile a ride's
     * entrance has claimed is dead-ended on purpose, so a tile of the run sitting on one
     * counts as connected as long as some other tile of the run reaches the network.
     * Demanding it be walkable demands that a queue not touch the door, which is the one
     * tile it must.
     */
    connectedToPark: boolean;
    /**
     * A ride that had a queue bound to it before this call and has none after.
     *
     * Measured by re-reading the chain out of each ride's entrance, the same way
     * `remove_path` measures it, because this is damage nothing in the game's API shows.
     * An ordinary path over a queue unbinds it and is refused before anything is laid; a
     * queue laid onto another ride's queue chains the two lines into one, which the game
     * allows and which takes the first ride's line away.
     */
    ridesLeftWithoutQueue: RideWithoutQueue[];
    detail: string;
    /**
     * Set only when the arguments were refused before anything was laid. Every failure
     * carries the whole outcome shape as well, so `detail` always holds the message.
     */
    error?: string;
}

/** An outcome for a run that never started, in the shape every other outcome uses. */
export function pathRefusal(detail: string): BuildPathOutcome {
    return {
        ok: false,
        tilesPlaced: 0,
        tilesTargeted: 0,
        tiles: [],
        connectedToPark: false,
        ridesLeftWithoutQueue: [],
        detail: detail,
        error: detail
    };
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
 * Not a reordering and not a repair: the order is the caller's and survives. A tile listed
 * twice would be paved twice and counted twice, and the second placement is a no-op the
 * game answers as a refusal, which would read as a tile that failed.
 */
function uniqueTiles(tiles: Tile[]): Tile[] {
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

/**
 * One tile a run cannot use, the condition it failed, and the call that lifts it.
 *
 * A failure used to name the four conditions as a set and no tile at all. The transcripts
 * put a number on what that costs: this model recovers from 14 of 14 messages that name the
 * failing value and the call that fixes it, and 0 of 6 that name only a category. One run
 * read "no level, owned, unobstructed route", guessed ownership, bought £270 of land it
 * already owned and never retried; the blocker was scenery on the tile the run started from.
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
 * The one condition a tile fails, as a code, or null when it will take a path.
 *
 * Cell fields only, so this stays cheap: it runs on the game's own thread, where a long
 * loop is a frozen game. Naming the blocker is `describeBlock`'s job, and that reads the
 * tile itself.
 *
 * The order is the order the conditions have to be fixed in. Ownership comes before
 * scenery because clearing ground the park does not own removes nothing.
 *
 * There is no height condition. Every tile is laid at its own ground height, so a run does
 * not have one height to hold its tiles to. A run drawn across a step is laid and does not
 * join up, and that is reported as the tiles guests cannot reach rather than guessed at.
 */
function blockCode(grid: MapGrid, x: number, y: number, queueAllowed: boolean): string | null {
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

    if (!cell.clear && !cell.path) {
        return cell.clearable ? "scenery" : "structure";
    }

    // A queue is ordinary walkable path - guests cross one - so this is not about routes.
    // Ordinary path laid over a queue unbinds it from its ride, and that damage is
    // invisible from the API, so a run that is not a queue never takes a queue tile.
    if (cell.queue && !queueAllowed) {
        return "queue";
    }

    return null;
}

function describeBlock(tile: Tile, code: string, wantQueue: boolean): Blocker {
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
            remedy: "remove_path takes a queue up, and takes the same `tiles` as this call",
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

    return { tile: tile, what: "off the map, which is " + String(map.size.x) + " by "
        + String(map.size.y) + " tiles", remedy: null, stale: false };
}

/**
 * How many tiles of one kind a failure lists before it counts the rest.
 *
 * The remedies are rectangles - clear_scenery and buy_land both take two corners - so a
 * run that fails on a dozen scenery tiles needs the extent, not a specimen. The cap is
 * what stops a long run spending a paragraph on it.
 */
const BLOCKERS_LISTED = 6;

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
 * A tile that is a building rather than ground, named with the tile to use instead.
 *
 * Checked before anything is laid, because afterwards the same mistake surfaces as a run
 * that came up one tile short, and the model then changes the wrong tile.
 */
function buildingOnRun(tiles: Tile[]): string | null {
    for (let i = 0; i < tiles.length; i++) {
        const door = rideDoorOn(tiles[i]);

        if (door) {
            const which = door.isExit ? "exit" : "entrance";
            const field = door.isExit ? "exitDoor" : "entranceDoor";

            return "Tile " + tileName(tiles[i]) + " of this run is a ride " + which
                + " BUILDING. A path cannot be laid on it; guests stand on the tile the door opens onto, which is "
                + tileName(door.opensOnto) + ". Re-run this call with " + tileName(door.opensOnto)
                + " in place of " + tileName(tiles[i]) + ". park_status reports that tile for every ride as `"
                + field + "`, so read it from there rather than working it out. Nothing was built.";
        }

        if (isParkGate(tiles[i])) {
            return "Tile " + tileName(tiles[i]) + " of this run is the park entrance"
                + " BUILDING. A path cannot be laid on it. A path tile beside the gate carries a run instead:"
                + " park_status gives the gate's own tiles as `paths.gate` and the tiles guests can walk to"
                + " as `paths.runs`. Nothing was built.";
        }
    }

    return null;
}

/** Why the tiles named cannot be paved, in tiles and conditions rather than as a category. */
function blockedRunRefusal(blockers: Blocker[], named: number): string {
    let anyStale = false;

    for (let i = 0; i < blockers.length; i++) {
        if (blockers[i].stale) {
            anyStale = true;
        }
    }

    return String(blockers.length) + " of the " + plural(named, "tile") + " named cannot take a path: "
        + blockerGroups(blockers) + "."
        + " Every tile of a run has to be owned, flat, and carrying nothing a footpath cannot share,"
        + " and a run that is not a queue takes no tile carrying a queue."
        // The same split `src/park/build.ts` draws between a coordinate that was wrong and
        // a coordinate that has gone stale: they read alike and need opposite answers.
        + (anyStale
            ? " The ground changes as you build, so a tile that was clear when you last read the map may not be now."
            : "")
        + " Nothing was built.";
}

/**
 * The tiles of the run that no other tile of the run touches, one per separate piece.
 *
 * A gap is not refused: two stubs at opposite ends of the park are a legitimate call, and
 * insisting on one unbroken line would be this file deciding what shape a run is. It is
 * still worth saying, because whether the tiles just drawn join up is exactly what the
 * caller cannot see.
 */
function fragmentSamples(tiles: Tile[]): Tile[] {
    const inRun: Record<string, boolean> = {};
    const seen: Record<string, boolean> = {};
    const samples: Tile[] = [];

    for (let i = 0; i < tiles.length; i++) {
        inRun[tileName(tiles[i])] = true;
    }

    for (let i = 0; i < tiles.length; i++) {
        if (seen[tileName(tiles[i])]) {
            continue;
        }

        samples.push(tiles[i]);
        const pending: Tile[] = [tiles[i]];

        while (pending.length > 0) {
            const at = pending.pop() as Tile;
            const key = tileName(at);

            if (seen[key] || !inRun[key]) {
                continue;
            }

            seen[key] = true;

            for (let d = 0; d < NEIGHBOURS.length; d++) {
                pending.push({ x: at.x + NEIGHBOURS[d].dx, y: at.y + NEIGHBOURS[d].dy });
            }
        }
    }

    return samples;
}

export function buildPath(request: BuildPathRequest, done: (outcome: BuildPathOutcome) => void): void {
    const kind = request.queue ? "queue" : "path";
    const otherKind = request.queue ? "path" : "queue";

    for (let i = 0; i < request.tiles.length; i++) {
        const tile = request.tiles[i];

        if (!isFinite(tile.x) || !isFinite(tile.y)
            || Math.floor(tile.x) !== tile.x || Math.floor(tile.y) !== tile.y) {
            return done(pathRefusal("Tile " + String(i) + " of this run is " + String(tile.x) + ","
                + String(tile.y) + ", which is not a pair of whole tile coordinates. Nothing was built."));
        }
    }

    const tiles = uniqueTiles(request.tiles);

    if (tiles.length === 0) {
        return done(pathRefusal("This run names no tiles. `tiles` is the list of tiles to pave and every"
            + " tile in it is paved, so one tile is a run and there is no shorter one. Nothing was built."));
    }

    const building = buildingOnRun(tiles);

    if (building !== null) {
        return done(pathRefusal(building));
    }

    const grid = readMapGrid();
    const blockers: Blocker[] = [];

    for (let i = 0; i < tiles.length; i++) {
        const code = blockCode(grid, tiles[i].x, tiles[i].y, request.queue);

        if (code !== null) {
            blockers.push(describeBlock(tiles[i], code, request.queue));
        }
    }

    // Every failing tile at once, and nothing laid. A run half on the ground is a park the
    // caller did not ask for and now has to diagnose, which is the failure this tool was
    // rebuilt to stop producing.
    if (blockers.length > 0) {
        return done(pathRefusal(blockedRunRefusal(blockers, tiles.length)));
    }

    const reachableBefore = walkableFromParkEntrance();
    const servedBefore = ridesServedByQueue();
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

    for (let i = 0; i < tiles.length; i++) {
        const cell = grid.at(tiles[i].x, tiles[i].y);

        if (!cell) {
            continue;
        }

        before[tileName(tiles[i])] = { path: cell.path, queue: cell.queue };

        if (request.queue && cell.path && !cell.queue) {
            replacedExistingPath++;
        }

        context.executeAction("footpathplace", {
            x: toWorld(tiles[i].x),
            y: toWorld(tiles[i].y),
            // Each tile at its own ground height. The run holds no single height, so a run
            // drawn across a step lays every tile and simply does not join up.
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
        const placed = countPathTiles(tiles);
        const walkable = walkableFromParkEntrance();
        const lostQueue = ridesThatLostTheirQueue(servedBefore, ridesServedByQueue());

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

        for (let i = 0; i < tiles.length; i++) {
            const was = before[tileName(tiles[i])] || { path: false, queue: false };
            const now = pathState(tiles[i].x, tiles[i].y);
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
                noPath.push(tiles[i]);
            } else if (!rightKind) {
                wrongKind.push(tiles[i]);
            }
        }

        // The tile a ride's entrance claims is dead-ended by the game on purpose, so its
        // absence from the walk out of the gate is not evidence about this run. It is
        // evidence about nothing at all unless some tile of the run does reach the
        // network - otherwise excusing it would excuse an island.
        let touchesNetwork = false;

        for (let i = 0; i < tiles.length; i++) {
            if (tileIsWalkable(walkable, tiles[i])) {
                touchesNetwork = true;
                break;
            }
        }

        /** Tiles guests really cannot reach: a tile a ride has claimed is not one of them. */
        const stranded: Tile[] = [];
        const claimed: string[] = [];
        let anyClaimed = false;

        for (let i = 0; i < tiles.length; i++) {
            if (tileIsWalkable(walkable, tiles[i])) {
                continue;
            }

            const claimedBy = rideClaimingDoorTile(tiles[i]);

            if (claimedBy === null) {
                stranded.push(tiles[i]);
            } else {
                anyClaimed = true;
                claimed.push(tileName(tiles[i]) + " carries ride " + String(claimedBy) + "'s queue");
            }
        }

        // A claimed door tile is excused from the verdict only while some tile of the run
        // does reach the network: excusing it otherwise excuses an island.
        const connected = stranded.length === 0 && (!anyClaimed || touchesNetwork);
        // Severance is tiles that used to be walkable and no longer are. Comparing raw
        // totals instead double-counted: laying an unconnected stub left the totals equal
        // and reported the whole run as "cut off", telling the model to move a queue that
        // had broken nothing.
        //
        // A tile a ride's entrance has claimed is not one of them, for the same reason
        // `connectedToPark` two clauses up already excuses it: the game dead-ends it on
        // purpose and it is the tile the caller handed to the ride, not damage beside it.
        // Counting it made this call disagree by exactly one with the prediction
        // `describe_placement` had given for the same event - `queueCutsOff` 5 against
        // "6 path tiles are no longer reachable" - and `describe_placement` prices that tile
        // separately in the same breath ("the queue takes x,y"), so counting it here states
        // one cost twice. Its own severance figure is the one that has to be able to read 0,
        // which is how the model is told there is a way round.
        let lost = 0;

        for (const tile in reachableBefore) {
            if (!reachableBefore[tile] || walkable[tile]) {
                continue;
            }

            const at = tile.split(",");

            if (rideClaimingDoorTile({ x: Number(at[0]), y: Number(at[1]) }) === null) {
                lost++;
            }
        }

        const everyTileIsRight = placed === tiles.length && laid === bare && converted === toConvert;
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
                shortfall.push("no path reached " + nameTiles(noPath));
            }

            if (wrongKind.length > 0) {
                shortfall.push(nameTiles(wrongKind) + " still carr"
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

            summary = "Only " + String(placed) + " of " + String(tiles.length) + " tiles carry a path: "
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

        const pieces = placed > 0 ? fragmentSamples(tiles) : [];
        const inRun: Record<string, boolean> = {};

        for (let i = 0; i < tiles.length; i++) {
            inRun[tileName(tiles[i])] = true;
        }

        // Nothing of the run reaches the network, or the game dead-ended the only tiles that
        // would have: either way the run as a whole is what has to be named, not a subset.
        const wholeRunIsStranded = stranded.length === 0 || stranded.length === tiles.length;
        // Read back rather than reusing `grid`, which was taken before the placements: this
        // reports what the map says now, and its cell fields sit in the same sentence as
        // live element reads, which must not be able to disagree about a tile. Only taken
        // where the run failed to join up, which is the one case whose message needs it.
        const beside = connected || placed === 0
            ? ""
            : neighboursOf(readMapGrid(), walkable, wholeRunIsStranded ? tiles : stranded, inRun, "the run");

        done({
            // `ok` is whether the path got laid. Whether it reaches the park is
            // `connectedToPark`: a queue built before its connecting path is not a failure.
            ok: everyTileIsRight,
            tilesPlaced: placed,
            tilesTargeted: tiles.length,
            tiles: tiles,
            connectedToPark: connected,
            ridesLeftWithoutQueue: lostQueue,
            detail: summary
                // The tiles were named one by one, so whether they touch each other is the
                // one thing about the run's own shape the caller cannot read back. Stated,
                // not refused: two stubs in one call is a run this tool has no business
                // turning down.
                + (pieces.length > 1
                    ? " These tiles are " + String(pieces.length) + " separate runs rather than one line -"
                        + " " + nameTiles(pieces) + " are each on a different one - so a guest standing on one"
                        + " cannot walk to another."
                    : "")
                // The good outcome said out loud, because `connectedToPark` is a field and
                // the fields of this result go unread: `tilesPlaced`, `tilesTargeted`,
                // `connectedToPark` and `ridesLeftWithoutQueue` drew 0 mentions between them
                // across a whole session while `detail` was quoted back every turn. The
                // counts and the lost queues were already in the sentence; whether guests
                // can get here was the one that was only ever a boolean.
                + (connected && placed > 0
                    ? " Guests can walk to this run from the park entrance."
                    : "")
                // `placed === 0` is a run with no tile of it on the ground, so there is
                // nothing for guests to walk and nothing to connect. Saying it is cut off
                // there points at moving tiles, which is a fix for a different failure - the
                // same defect as the door-building sentence above, one clause along.
                + (connected || placed === 0
                    ? ""
                    : " This run does not reach the park entrance, so guests cannot walk it: "
                        + (wholeRunIsStranded
                            ? "no tile of it is in the network guests can walk"
                            : nameTiles(stranded) + (stranded.length === 1 ? " is" : " are") + " cut off")
                        + "."
                        // What was actually examined and what was found there, before the
                        // general explanation, because the general explanation is what the
                        // model already has and this is what only this call read.
                        + (beside === ""
                            ? ""
                            : " The tiles beside " + (wholeRunIsStranded ? "this run" : "them")
                                + " were read: " + beside)
                        + " Having a path on a tile is not the same as that tile being reachable: the tiles"
                        + " guests can really walk to are the ones park_status covers with `paths.runs`, and a"
                        + " run covers every tile between its `fromX`,`fromY` and its `toX`,`toY`. A run whose"
                        + " `kind` is \"queue\" is not an anchor for either kind of run: ordinary path laid onto"
                        + " one unbinds that queue from its ride, and a queue laid onto one joins two rides'"
                        + " lines together.")
                // Said whether or not the run reaches the park, because it is the sentence
                // that stops the one above being read about the wrong tile. A run was torn
                // out over this: the verdict called a correctly built queue "cut off" at
                // the one tile a queue has to touch, and the advice above then pointed at
                // moving it off the door.
                + (connected || placed === 0 || claimed.length === 0
                    ? ""
                    : " " + claimed.join(", and ") + " at the tile that ride's entrance opens onto. The game"
                        + " dead-ends the tile a ride claims, so it drops out of the walk from the park gate"
                        + " however the rest of the run is laid; it is not a tile that has to reach the park,"
                        + " and a queue that does not touch it leaves the ride with no line.")
                + (lost > 0
                    ? " WARNING: " + String(lost) + " path tiles are no longer reachable from the park entrance."
                        + " A queue on its own is walked like any other path; what dead-ends is the one tile a"
                        + " ride's entrance claims, and the route to those tiles ran through such a tile."
                    : (replacedExistingPath > 0
                        ? " Nothing was cut off by it."
                        : ""))
                // Measured rather than counted up from what was asked for. An ordinary path
                // over a queue is refused before anything is laid, so this is the damage that
                // gets through: a queue laid onto another ride's queue chains the two lines
                // into one, and nothing in the game's API shows the first ride lost its line.
                + lostQueue.map(function (ride) {
                    return " WARNING: ride " + String(ride.id) + " " + ride.name + " no longer has a queue"
                        + " bound to it. Its entrance door is at " + tileName(ride.entranceDoor) + ", and until"
                        + " a queue tile sits there guests crowd the building and never board.";
                }).join("")
        });
    }, STEP_DELAY_MS);
}
