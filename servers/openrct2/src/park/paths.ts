import { readMapGrid } from "./map.js";

const NEIGHBOURS = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];

export interface Tile {
    x: number;
    y: number;
}

function key(x: number, y: number): string {
    return String(x) + "," + String(y);
}

function isPath(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= map.size.x || y >= map.size.y) {
        return false;
    }

    const tile = map.getTile(x, y);

    for (let i = 0; i < tile.numElements; i++) {
        if (tile.getElement(i).type === "footpath") {
            return true;
        }
    }

    return false;
}

function isQueue(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= map.size.x || y >= map.size.y) {
        return false;
    }

    const tile = map.getTile(x, y);

    for (let i = 0; i < tile.numElements; i++) {
        const element = tile.getElement(i);

        if (element.type === "footpath" && (element as FootpathElement).isQueue) {
            return true;
        }
    }

    return false;
}

/**
 * The park entrance, found by shape: only its structure spans several tiles, so its
 * element sequence runs past 0. Ride entrances and exits are always a single tile.
 */
export function findParkEntranceTiles(): Tile[] {
    const multiTileObjects: Record<number, boolean> = {};
    const entrances: { tile: Tile; object: number }[] = [];

    for (let y = 0; y < map.size.y; y++) {
        for (let x = 0; x < map.size.x; x++) {
            const tile = map.getTile(x, y);

            for (let i = 0; i < tile.numElements; i++) {
                const element = tile.getElement(i);

                if (element.type !== "entrance") {
                    continue;
                }

                const entrance = element as EntranceElement;
                entrances.push({ tile: { x: x, y: y }, object: entrance.object });

                if (entrance.sequence !== null && entrance.sequence > 0) {
                    multiTileObjects[entrance.object] = true;
                }
            }
        }
    }

    const gate: Tile[] = [];

    for (let i = 0; i < entrances.length; i++) {
        if (multiTileObjects[entrances[i].object]) {
            gate.push(entrances[i].tile);
        }
    }

    return gate;
}

/**
 * Every path tile guests can walk to from the park entrance.
 *
 * Queues are one-way in a particular sense: a guest walks the length of a queue to reach
 * the ride at the end of it, but cannot cut through one to get anywhere else. So a queue
 * tile expands only to other queue tiles — following the line to its door — and never
 * back out onto ordinary path.
 *
 * Getting this wrong in either direction is expensive. Treating a queue as ordinary path
 * marks everything behind it reachable when it is not; refusing to expand from it at all
 * marks every ride with more than a one-tile queue unreachable, which is worse, because
 * that is the normal case.
 */
export function walkableFromParkEntrance(): Record<string, boolean> {
    const gate = findParkEntranceTiles();
    const seen: Record<string, boolean> = {};
    const queue: Tile[] = [];

    for (let g = 0; g < gate.length; g++) {
        for (let i = 0; i < NEIGHBOURS.length; i++) {
            const x = gate[g].x + NEIGHBOURS[i].dx;
            const y = gate[g].y + NEIGHBOURS[i].dy;

            if (!seen[key(x, y)] && isPath(x, y)) {
                seen[key(x, y)] = true;
                queue.push({ x: x, y: y });
            }
        }
    }

    while (queue.length > 0) {
        const current = queue.shift() as Tile;
        const alongQueue = isQueue(current.x, current.y);

        for (let i = 0; i < NEIGHBOURS.length; i++) {
            const x = current.x + NEIGHBOURS[i].dx;
            const y = current.y + NEIGHBOURS[i].dy;

            if (seen[key(x, y)] || !isPath(x, y)) {
                continue;
            }

            if (alongQueue && !isQueue(x, y)) {
                continue;
            }

            seen[key(x, y)] = true;
            queue.push({ x: x, y: y });
        }
    }

    return seen;
}

export function tileIsWalkable(walkable: Record<string, boolean>, tile: Tile): boolean {
    return walkable[key(tile.x, tile.y)] === true;
}

/**
 * How many of these tiles now carry a path at all.
 *
 * Deliberately not "a path of the kind we asked for": a route legitimately ends on
 * existing path, and OpenRCT2 will not always convert an ordinary tile into a queue.
 * Demanding the exact kind reported "only 1 of 2 tiles were laid" on the commonest call
 * there is - joining a new queue to the path network - and the model gave up after two
 * retries. `laidBareTiles` answers the stricter question where it is the right one.
 */
export function countPathTiles(tiles: Tile[]): number {
    let placed = 0;

    for (let i = 0; i < tiles.length; i++) {
        if (isPath(tiles[i].x, tiles[i].y)) {
            placed++;
        }
    }

    return placed;
}

/** Of the tiles that were bare before, how many now carry the kind of path asked for. */
export function countNewPathTiles(tiles: Tile[], wasBare: Record<string, boolean>, wantQueue: boolean): number {
    let placed = 0;

    for (let i = 0; i < tiles.length; i++) {
        if (!wasBare[key(tiles[i].x, tiles[i].y)]) {
            continue;
        }

        if (isPath(tiles[i].x, tiles[i].y) && isQueue(tiles[i].x, tiles[i].y) === wantQueue) {
            placed++;
        }
    }

    return placed;
}

/**
 * Route from `start` — the tile a door actually opens onto — to the path network the
 * park entrance connects to. `start` is included, because a route that stops one tile
 * short of the door connects nothing. Routes around trees, which Forest Frontiers is
 * mostly made of.
 */
export function routeToParkNetwork(start: Tile, z: number, walkable: Record<string, boolean>): Tile[] | null {
    const grid = readMapGrid();
    const cameFrom: Record<string, string | null> = {};
    const queue: Tile[] = [];

    const startCell = grid.at(start.x, start.y);

    if (!startCell || !startCell.owned || !startCell.flat || startCell.baseZ !== z
        || (!startCell.clear && !startCell.path)) {
        return null;
    }

    cameFrom[key(start.x, start.y)] = null;
    queue.push(start);

    let goal: Tile | null = null;

    while (queue.length > 0 && !goal) {
        const current = queue.shift() as Tile;

        if (tileIsWalkable(walkable, current)) {
            goal = current;
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

            cameFrom[key(x, y)] = key(current.x, current.y);
            queue.push({ x: x, y: y });
        }
    }

    if (!goal) {
        return null;
    }

    // Walk the chain back so the tiles nearest the door come first; queue tiles belong there.
    const route: Tile[] = [];
    let cursor: string | null = key(goal.x, goal.y);

    while (cursor !== null) {
        const parts = cursor.split(",");
        route.push({ x: Number(parts[0]), y: Number(parts[1]) });
        cursor = cameFrom[cursor];
    }

    route.reverse();
    return route;
}

/**
 * Whether a queue path adjacent to the entrance door is bound to this ride. A plain
 * footpath touching the door is not enough: guests will crowd the building and never
 * board, which looks exactly like a working ride from the outside.
 */
export function queuePathServes(door: Tile, rideId: number): boolean {
    const tile = map.getTile(door.x, door.y);

    for (let i = 0; i < tile.numElements; i++) {
        const element = tile.getElement(i);

        if (element.type !== "footpath") {
            continue;
        }

        const path = element as FootpathElement;

        if (path.isQueue && path.ride === rideId) {
            return true;
        }
    }

    return false;
}
