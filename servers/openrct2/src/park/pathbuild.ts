import { DIRECTION_VECTORS, readMapGrid, toWorld } from "./map.js";
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
    /** Whether both ends can be walked to from the park entrance. */
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

/**
 * The ride door standing on a tile, if one is, and the tile it opens onto.
 *
 * The single commonest build_path mistake in the logs: aiming at the entrance *building*
 * rather than the tile in front of it. The building is not ground and takes no path, so
 * the run either refuses or comes up short, and neither message named the real tile.
 */
function rideDoorOn(tile: Tile): { isExit: boolean; opensOnto: Tile } | null {
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
            isExit: entrance.object === 1,
            opensOnto: { x: tile.x - towardsRide.dx, y: tile.y - towardsRide.dy }
        };
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

function route(from: Tile, to: Tile): Tile[] | null {
    const grid = readMapGrid();
    const startCell = grid.at(from.x, from.y);

    // Hold the start tile to the same standard as every other tile on the run. Checking
    // only ownership accepted a start on a slope or on blocked ground, fired an action
    // there, and reported "something blocked the rest" rather than naming the real cause.
    if (!startCell || !startCell.owned || !startCell.flat || (!startCell.clear && !startCell.path)) {
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
            const cell = grid.at(x, y);

            if (!cell || !cell.owned || !cell.flat || cell.baseZ !== z || (!cell.clear && !cell.path)) {
                continue;
            }

            // Never route through someone's queue: paving over it unbinds the ride and
            // the damage is invisible from the API.
            if (cell.queue && !(x === to.x && y === to.y)) {
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
                + " park_status gives the gate's own tiles as `paths.entrance` and the tiles guests can walk to"
                + " as `paths.reachableSample`. Nothing was built.";
        }
    }

    return null;
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
        const leg = route(request.points[i], request.points[i + 1]);

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
        const between = failedLeg >= 0
            ? " between " + tileName(request.points[failedLeg]) + " and " + tileName(request.points[failedLeg + 1])
            : "";

        return done({
            ok: false,
            tilesPlaced: 0,
            tilesRouted: 0,
            route: [],
            connectedToPark: false,
            detail: "No level, owned, unobstructed route" + between + ". Every tile of a run has to be owned,"
                + " flat and at the same height as the tile the run starts on. Clear the way, or give waypoints"
                + " that go round it. Existing queues also block a route: guests cannot walk through a queue, so"
                + " paths are never laid across one. Nothing was built."
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
        const startConnected = tileIsWalkable(walkable, first);
        const endConnected = tileIsWalkable(walkable, last);
        const connected = startConnected && endConnected;
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
                        + (startConnected
                            ? "its far end " + tileName(last) + " is cut off"
                            : (endConnected
                                ? "its start " + tileName(first) + " is cut off"
                                : "neither end, " + tileName(first) + " or " + tileName(last) + ", is connected"))
                        + ". Having a path on a tile is not the same as that tile being reachable. Aim one end at a"
                        + " tile park_status lists under `paths.reachableSample` - those are the tiles guests can"
                        + " actually walk to - rather than at a neighbouring tile that happens to be paved.")
                + (replacedQueue > 0
                    ? " WARNING: " + String(replacedQueue) + " tiles replaced an existing queue line with ordinary path,"
                        + " which unbinds it from its ride."
                    : "")
                + (lost > 0
                    ? " WARNING: " + String(lost) + " path tiles are no longer reachable from the park entrance."
                        + " Guests cannot walk through a queue, so this run cut an existing route in two."
                    : (replacedExistingPath > 0
                        ? " Nothing was cut off by it."
                        : ""))
        });
    }, STEP_DELAY_MS);
}
