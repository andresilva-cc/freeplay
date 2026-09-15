import { DIRECTION_VECTORS } from "./map.js";
import type { MapGrid } from "./map.js";
import { edgesLink, isParkEntranceElement, RIDE_ENTRANCE, RIDE_EXIT, tileIsWalkable } from "./paths.js";
import type { Tile } from "./paths.js";

/**
 * What the tiles around a place on the map are, in one vocabulary.
 *
 * Two tools have to answer the same question - "you say guests cannot get there; what IS
 * beside it?" - about two different places: the run `build_path` just laid, and the tile a
 * ride's door opens onto. They were answered in one file and not at all in the other, and
 * the half that had no answer is the one the transcripts show most: "NO QUEUE at the
 * entrance - guests cannot board" appears 45 times across 10 of 19 recorded runs, never
 * once saying what was standing on the tiles around that door.
 *
 * One vocabulary rather than two, because the same ground read by two tools that word it
 * differently reads as two different maps.
 */

const NEIGHBOURS = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];

/** How many tiles beside a place one clause names before it counts the rest. */
const NEIGHBOURS_LISTED = 6;

/** How many different things the tiles beside a place are reported as before the list stops. */
const NEIGHBOUR_KINDS_LISTED = 6;

export function tileName(tile: Tile): string {
    return String(tile.x) + "," + String(tile.y);
}

export function plural(count: number, singular: string): string {
    return String(count) + " " + singular + (count === 1 ? "" : "s");
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
 * The same list `src/park/build.ts` names a blocked door tile with, kept separate because
 * that one names the ride a door belongs to and this one reports element types.
 */
export function immovableOn(x: number, y: number): string[] {
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
 * the tile either refuses or comes up short, and neither message named the real tile.
 */
export function rideDoorOn(tile: Tile): { isExit: boolean; ride: number; opensOnto: Tile } | null {
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

/** True when the park's gate structure stands on this tile. */
export function isParkGate(tile: Tile): boolean {
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
 * What one tile is, read off the map after the work.
 *
 * Written as the predicate of "x,y is ...", so every branch is a noun phrase.
 *
 * Only what was read, and nothing about what to do with it. A run that does not reach the
 * park used to say so with no tile named on either side of it: one session built a single
 * queue tile, was told "no tile of it is in the network guests can walk", and never found
 * out that the tile it would have joined was the one its own remove_path call had taken up
 * two turns earlier. Which neighbour was examined and what was standing there is knowable
 * only here - the call read those tiles, and nothing in the result carried the answer.
 *
 * `from` is the tile this one was read as a neighbour OF, and `subject` is what the message
 * calls that tile - "the run" for a run of path, the coordinates themselves for a single
 * tile. Pass `from` as null to read a tile on its own account rather than as somebody's
 * neighbour: there is then no pair to compare heights across and no pair of edge bits to
 * report, and the two clauses that state them are left off.
 */
export function tileState(
    grid: MapGrid, walkable: Record<string, boolean>, from: Tile | null, at: Tile, subject: string
): string {
    const cell = grid.at(at.x, at.y);

    if (!cell) {
        return "off the map";
    }

    if (cell.path) {
        const here = from ? grid.at(from.x, from.y) : undefined;

        return (cell.queue ? "a queue" : "a footpath")
            + (tileIsWalkable(walkable, at)
                ? " guests can reach from the park entrance"
                // "either" only against a tile that was itself just reported unreachable,
                // which is what a neighbour is read against and a tile on its own is not.
                : " guests cannot reach from the park entrance" + (from ? " either" : ""))
            // Each tile of a run is laid at its own ground height, so a neighbour at another
            // height is a step the game does not join across. Reported as the two heights
            // rather than as a verdict about them.
            + (here && here.baseZ !== cell.baseZ
                ? ", at ground height " + String(cell.baseZ) + " against " + subject + "'s " + String(here.baseZ)
                : "")
            // The game's own bitfield, read through the same test the flood out of the gate
            // uses, because a second rule about what connects to what would disagree with it.
            // Left off where the other tile carries no footpath: an edge bit is a thing a
            // footpath has, so "no edge bit joins these two" said of bare ground states a
            // fault where there is only nothing there yet.
            + (from && here && here.path
                ? (edgesLink(from, at)
                    ? ", joined to " + subject + " by the edge bits the game keeps on both tiles"
                    : ", with no edge bit on either tile joining it to " + subject)
                : "");
    }

    const door = rideDoorOn(at);

    if (door) {
        return "the " + (door.isExit ? "exit" : "entrance") + " BUILDING of ride " + String(door.ride)
            + ", whose door opens onto " + tileName(door.opensOnto);
    }

    // After `rideDoorOn`, which returns null for the gate: the park's own gate carries a
    // raw ride index of 0, so anything that reads `ride` rather than `object` calls it the
    // entrance building of ride 0 - a ride that may not exist and never owns that gate.
    if (isParkGate(at)) {
        return "the park entrance BUILDING";
    }

    if (!cell.owned) {
        return "not land the park owns";
    }

    const standing = immovableOn(at.x, at.y);

    if (standing.length > 0) {
        return "carrying " + standing.join(" and ") + ", which is not scenery a bulldozer removes";
    }

    if (!cell.clear) {
        return "carrying scenery";
    }

    // Not "which takes no footpath", which is false and was read back to the model inside
    // build_path's own refusal, one sentence away from that tool saying the opposite:
    // OpenRCT2 footpaths run up slopes on footpathplace's slopeType and slopeDirection, and
    // build_path sends 0 for both. The limit is the bridge's and is named as the bridge's.
    return cell.flat
        ? "bare ground the park owns"
        : "bare ground on a slope, which no typed tool here lays path on";
}

/**
 * Every tile beside the tiles examined that is not one of them, and what each one is.
 *
 * Tiles that read the same share a clause, the way a blocked run's do: the answer that
 * matters is which side has what on it, and six copies of "bare ground" spend a line
 * saying it once. Both caps are what keeps this bounded well inside the length a tool
 * result is cut at, however long the run. A single tile has four neighbours and reaches
 * neither cap; a run of forty reaches both.
 */
export function neighboursOf(
    grid: MapGrid, walkable: Record<string, boolean>, of: Tile[], exclude: Record<string, boolean>, subject: string
): string {
    const order: string[] = [];
    const tiles: Record<string, Tile[]> = {};
    const seen: Record<string, boolean> = {};

    for (let i = 0; i < of.length; i++) {
        for (let d = 0; d < NEIGHBOURS.length; d++) {
            const at = { x: of[i].x + NEIGHBOURS[d].dx, y: of[i].y + NEIGHBOURS[d].dy };
            const name = tileName(at);

            if (exclude[name] || seen[name]) {
                continue;
            }

            seen[name] = true;
            const state = tileState(grid, walkable, of[i], at, subject);

            if (!tiles[state]) {
                tiles[state] = [];
                order.push(state);
            }

            tiles[state].push(at);
        }
    }

    if (order.length === 0) {
        return "";
    }

    const listed = order.slice(0, NEIGHBOUR_KINDS_LISTED).map(function (state) {
        const group = tiles[state];
        const shown = group.slice(0, NEIGHBOURS_LISTED).map(tileName).join(" ");
        const more = group.length > NEIGHBOURS_LISTED
            ? " and " + String(group.length - NEIGHBOURS_LISTED) + " more"
            : "";

        return shown + more + (group.length === 1 ? " is " : " are ") + state;
    });

    let unnamed = 0;

    for (let i = NEIGHBOUR_KINDS_LISTED; i < order.length; i++) {
        unnamed += tiles[order[i]].length;
    }

    return listed.join(". ") + "."
        + (unnamed > 0 ? " " + plural(unnamed, "further tile") + " beside it went unnamed here." : "");
}
