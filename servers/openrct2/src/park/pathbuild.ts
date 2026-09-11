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

    if (!startCell || !startCell.owned) {
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
