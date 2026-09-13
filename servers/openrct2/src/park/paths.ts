import { readMapGrid } from "./map.js";

const NEIGHBOURS = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];

/**
 * Which of the three kinds of entrance an entrance element is, from its `object` field.
 *
 * These are OpenRCT2's `EntranceType` enum, which the plugin API hands over as
 * `element.object`: rideEntrance, rideExit, parkEntrance, in that order. It is the *only*
 * field that distinguishes them. `element.ride` does not: the API returns the raw ride
 * index for every entrance element, so a park gate reads back as ride 0 rather than null,
 * and `typeof element.ride !== "number"` is never true in the running game.
 */
export const RIDE_ENTRANCE = 0;
export const RIDE_EXIT = 1;
export const PARK_ENTRANCE = 2;

/** True for the park's own gate, which belongs to no ride and no tool here can remove. */
export function isParkEntranceElement(element: EntranceElement): boolean {
    return element.object === PARK_ENTRANCE;
}

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
 * The four directions in OpenRCT2's own order, so the index is the bit position in a
 * footpath's `edges`: 0 is -x, 1 is +y, 2 is +x, 3 is -y. This is `CoordsDirectionDelta`.
 *
 * Kept separate from `NEIGHBOURS`, whose order is arbitrary and which several callers walk
 * for reasons that have nothing to do with edge bits.
 */
const EDGE_DIRECTIONS = [{ dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 1, dy: 0 }, { dx: 0, dy: -1 }];

/** The bit in `edges` that points the other way down the same link. */
function opposite(direction: number): number {
    return (direction + 2) % 4;
}

/**
 * Which sides of this tile a guest may step off, as the game itself records it: the
 * `edges` bitfield of the footpaths on it, OR'd together. -1 where there is no path at all.
 *
 * OR'd rather than taking the first element because a tile can carry more than one footpath
 * (a bridge over a path), and the pair-wise check in `walkableFromParkEntrance` means an
 * over-generous OR on one tile still cannot invent a link the neighbour does not also
 * claim.
 */
function pathEdges(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= map.size.x || y >= map.size.y) {
        return -1;
    }

    const tile = map.getTile(x, y);
    let edges = -1;

    for (let i = 0; i < tile.numElements; i++) {
        const element = tile.getElement(i);

        if (element.type !== "footpath") {
            continue;
        }

        // Only the low nibble is the four orthogonal edges; the high nibble is corners.
        edges = (edges < 0 ? 0 : edges) | ((element as FootpathElement).edges & 0x0f);
    }

    return edges;
}

/**
 * Every path tile guests can walk to from the park entrance.
 *
 * This walks the game's own footpath graph: OpenRCT2 stores on every footpath element the
 * sides a guest may leave it by, and `PathGetPermittedEdges` - the one function the guest
 * pathfinder asks which way it may go - returns exactly that bitfield. So the edges are not
 * a hint about connectivity, they *are* the connectivity, and reading them is the only way
 * to be right about it that does not involve reimplementing the game.
 *
 * What this replaced was a hand-rolled rule: "a queue tile expands only to other queue
 * tiles", on the theory that a guest cannot cut through a queue to get anywhere else.
 * Measured against a running game, that is not what happens. Turning two path tiles into a
 * queue changed no edge bit at all (51,24 and 51,25 of Forest Frontiers, `edges` 10 before
 * and 10 after), so guests walked straight over it. What does cut the line is *binding* a
 * queue to a ride: when the entrance claimed that queue, the game cleared the bit on the
 * far side of the tile at the door - 51,25 went 10 to 9 and the tile past it, 51,26, went
 * 10 to 3 - leaving the queue a cul-de-sac ending at the door. So the game severs one
 * specific edge, and only when a ride owns the line; the old rule severed every edge off
 * every queue tile, which is why it under-reported. Mid-line queue tiles keep their edges
 * to ordinary path and were measured doing so (51,27, bound to a ride, `edges` 10, joined
 * to the plain path at 51,26).
 *
 * Both sides of a link have to claim it. The game keeps them symmetric - across every
 * footpath in the measured park there was not one pair where only one side agreed - so
 * requiring both costs nothing and refuses to invent a link out of one stale bit.
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
        const from = pathEdges(current.x, current.y);

        for (let d = 0; d < EDGE_DIRECTIONS.length; d++) {
            if ((from & (1 << d)) === 0) {
                continue;
            }

            const x = current.x + EDGE_DIRECTIONS[d].dx;
            const y = current.y + EDGE_DIRECTIONS[d].dy;

            if (seen[key(x, y)]) {
                continue;
            }

            const to = pathEdges(x, y);

            if (to < 0 || (to & (1 << opposite(d))) === 0) {
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
 * Whether the game's own edge bits join these two neighbouring tiles, both ways.
 *
 * Exactly the pair-wise test `walkableFromParkEntrance` floods with, exported rather than
 * restated so that a caller explaining why a tile is missing from that flood reads the
 * same bitfield the flood read. A second, hand-rolled rule about what connects to what is
 * how this file got connectivity wrong before.
 *
 * False for tiles that are not neighbours and for a tile carrying no footpath at all.
 */
export function edgesLink(from: Tile, to: Tile): boolean {
    for (let d = 0; d < EDGE_DIRECTIONS.length; d++) {
        if (from.x + EDGE_DIRECTIONS[d].dx !== to.x || from.y + EDGE_DIRECTIONS[d].dy !== to.y) {
            continue;
        }

        const here = pathEdges(from.x, from.y);
        const there = pathEdges(to.x, to.y);

        return here >= 0 && there >= 0
            && (here & (1 << d)) !== 0 && (there & (1 << opposite(d))) !== 0;
    }

    return false;
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
