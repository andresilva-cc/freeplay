import { readMapGrid, toWorld } from "./map.js";
import { countPathTiles, tileIsWalkable, walkableFromParkEntrance } from "./paths.js";
import type { Tile } from "./paths.js";

const STEP_DELAY_MS = 200;
export const DEFAULT_QUEUE_OBJECT = 11;
export const DEFAULT_PATH_OBJECT = 1;
const FOOTPATH_QUEUE_FLAG = 1;

const NEIGHBOURS = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];

export interface BuildPathRequest {
    from: Tile;
    to: Tile;
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
}

function key(x: number, y: number): string {
    return String(x) + "," + String(y);
}

/** Shortest walkable route between two tiles at the same height, around obstructions. */
function route(from: Tile, to: Tile): Tile[] | null {
    const grid = readMapGrid();
    const startCell = grid.at(from.x, from.y);

    if (!startCell || !startCell.owned) {
        return null;
    }

    const z = startCell.baseZ;
    const cameFrom: Record<string, string | null> = {};
    const queue: Tile[] = [from];
    cameFrom[key(from.x, from.y)] = null;

    let reached = false;

    while (queue.length > 0 && !reached) {
        const current = queue.shift() as Tile;

        if (current.x === to.x && current.y === to.y) {
            reached = true;
            break;
        }

        for (let i = 0; i < NEIGHBOURS.length; i++) {
            const x = current.x + NEIGHBOURS[i].dx;
            const y = current.y + NEIGHBOURS[i].dy;

            if (typeof cameFrom[key(x, y)] !== "undefined") {
                continue;
            }

            const cell = grid.at(x, y);

            if (!cell || !cell.owned || !cell.flat || cell.baseZ !== z || (!cell.clear && !cell.path)) {
                continue;
            }

            // Never route through someone's queue: paving over it unbinds the ride and
            // the damage is invisible from the API.
            if (cell.queue && !(x === to.x && y === to.y)) {
                continue;
            }

            cameFrom[key(x, y)] = key(current.x, current.y);
            queue.push({ x: x, y: y });
        }
    }

    if (!reached) {
        return null;
    }

    const tiles: Tile[] = [];
    let cursor: string | null = key(to.x, to.y);

    while (cursor !== null) {
        const parts = cursor.split(",");
        tiles.push({ x: Number(parts[0]), y: Number(parts[1]) });
        cursor = cameFrom[cursor];
    }

    tiles.reverse();
    return tiles;
}

export function buildPath(request: BuildPathRequest, done: (outcome: BuildPathOutcome) => void): void {
    const tiles = route(request.from, request.to);

    if (tiles === null) {
        return done({
            ok: false,
            tilesPlaced: 0,
            tilesRouted: 0,
            route: [],
            connectedToPark: false,
            detail: "No level, owned, unobstructed route between those tiles. Clear the way or pick another line."
        });
    }

    const grid = readMapGrid();
    const reachableBefore = Object.keys(walkableFromParkEntrance()).length;
    let replacedExistingPath = 0;
    let replacedQueue = 0;

    for (let i = 0; i < tiles.length; i++) {
        const cell = grid.at(tiles[i].x, tiles[i].y);

        if (!cell) {
            continue;
        }

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
        }, function () { /* verified by re-read */ });
    }

    context.setTimeout(function () {
        const placed = countPathTiles(tiles);
        const walkable = walkableFromParkEntrance();
        const connected = tileIsWalkable(walkable, request.from) && tileIsWalkable(walkable, request.to);
        // Measure the damage rather than warn about it in the abstract: a queue laid across
        // a through route cuts everything beyond it off from the park entrance.
        const reachableAfter = Object.keys(walkable).length;
        const lost = reachableBefore + placed - reachableAfter;

        done({
            ok: placed === tiles.length && connected,
            tilesPlaced: placed,
            tilesRouted: tiles.length,
            route: tiles,
            connectedToPark: connected,
            detail: (placed === tiles.length
                ? "Laid " + String(placed) + (request.queue ? " queue" : " path") + " tiles."
                : "Only " + String(placed) + " of " + String(tiles.length) + " tiles were laid; something blocked the rest.")
                + (connected
                    ? ""
                    : " This path does not reach the park entrance, so guests cannot walk it."
                        + " One of its ends is a dead end - route it to a tile that is already reachable.")
                + (replacedQueue > 0
                    ? " WARNING: " + String(replacedQueue) + " tiles replaced an existing queue line with ordinary path,"
                        + " which unbinds it from its ride. Rebuild that queue."
                    : "")
                + (lost > 0
                    ? " WARNING: " + String(lost) + " path tiles are no longer reachable from the park entrance."
                        + " Guests cannot walk through a queue, so this run cut an existing route in two."
                        + " Move the queue off the main path, or lay a path around it."
                    : (replacedExistingPath > 0
                        ? " " + String(replacedExistingPath) + " tiles replaced an ordinary footpath, but nothing was"
                            + " cut off by it."
                        : ""))
        });
    }, STEP_DELAY_MS);
}
