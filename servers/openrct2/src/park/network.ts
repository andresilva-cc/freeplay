/**
 * What joins what, in coordinates.
 *
 * Classified over nine runs, 63% of the spatial failures were connectivity: a path or queue
 * laid to nowhere, a queue bound to a ride dead-ending the only route through, an ordinary
 * path laid back over its own queue. The bridge already worked the answer out -
 * `walkableFromParkEntrance` knows exactly which tiles the gate reaches - and then threw the
 * structure away and handed over a flat list of tiles. A model with all 31 reachable tiles
 * in front of it still could not do set membership over them, and said so: "(51,26) and
 * (52,26) are BOTH in the reachableSample! Why are they not connected?"
 *
 * So this reports the shape rather than the membership: straight runs with their ends, the
 * runs each one touches, the dead ends, how much each run holds together, and the stranded
 * islands with the ride doors sitting on them. All of it measurement - `cutsIfBlocked` is a
 * count of what stops being reachable, not a recommendation about where to build.
 *
 * A run is a straight line of one kind of path and nothing more, and one run of this report
 * was read as a connected component seven times over: "(50, 28) and (51, 28) are adjacent
 * tiles but they're not connected because there's no path between them", of two paved,
 * reachable, touching tiles that happened to lie on different runs. Three build_path calls
 * went into repairing a break that was not there. So every run now names the runs it
 * touches, by their `index` here, over the game's own footpath edges - which answers the
 * question that was actually being asked, and which nothing in the report could answer
 * before. `junctions` went with it: three corridors meeting was the same fact said at a
 * tile rather than at a run, it was measured by plain adjacency while everything beside it
 * walks the game's edges, and across the whole run it was read zero times.
 *
 * Severance is reported per run rather than per tile on purpose. Every tile of a single-file
 * corridor severs something, so the tile list for a twenty-two tile park was nineteen
 * entries and two thirds of the whole report, while saying one thing: this corridor has no
 * way round. `describe_placement` still gives the exact figure for the one tile being decided
 * about, as each access option's `queueCutsOff`.
 *
 * It is also sized for a context that gets compacted. A compaction summary does carry
 * coordinates - three consecutive summaries in one run carried a demolished ride's - and
 * that is the reason to re-send this whole every turn rather than a reason not to: what
 * survives compaction is stale, so nothing in it can be trusted against the live park. The
 * tile list this replaces was 137 tokens at 31 tiles and about 1,111 at its 250-tile cap;
 * this is roughly flat in the size of the park because it scales with the number of
 * corridors, not the number of tiles.
 */

import { readMapGrid } from "./map.js";
import { findParkEntranceTiles } from "./paths.js";
import type { Tile } from "./paths.js";
import { doorTile } from "./status.js";

const NEIGHBOURS = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];

/**
 * Above this many reachable tiles, severance is not worked out. Every tile costs a walk of
 * the whole network, so the work is quadratic, and this runs on the game's own thread where
 * a long loop is a frozen game. The field says when it was skipped rather than reporting
 * "no severing tiles", which would be a lie in exactly the parks that need the answer most.
 */
export const MAX_TILES_FOR_SEVERANCE = 400;

/** How many blocks of ground the census reports at most, so one call cannot run away. */
export const MAX_CENSUS_BLOCKS = 64;
export const DEFAULT_CENSUS_BLOCK = 32;

interface PathTile {
    x: number;
    y: number;
    queue: boolean;
    /** The ride a queue is bound to. Null on ordinary path, and on a queue bound to nothing. */
    ride: number | null;
    /**
     * The sides a guest may leave this tile by, as the game records them: the `edges`
     * bitfield of every footpath on the tile, OR'd together, low nibble only. Bit 0 is -x,
     * 1 is +y, 2 is +x, 3 is -y. This is what `reachableFromGate` walks.
     */
    edges: number;
}

/** One straight line of one kind of path: the shape, with nothing said about the network. */
export interface PathRunLine {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    tiles: number;
    /** "path" or "queue". */
    kind: string;
    /** Set only on a queue: the ride it is bound to, or null when it is bound to nothing. */
    ride?: number | null;
}

export interface PathRun extends PathRunLine {
    /** This run's position in `runs`, so `touches` can name runs without counting them. */
    index: number;
    /**
     * The `index` of every run a guest can step onto from a tile of this one, lowest first.
     *
     * Walked over the game's own footpath edges with both ends of a link required to claim
     * it, exactly as `reachableFromGate` walks them, so a link the game has cut is not
     * offered here: the tile a ride's entrance has claimed keeps its edge back along its own
     * queue and has lost the one to whatever lay past it.
     *
     * Two runs can touch and still be two runs - a corner, a junction, a queue meeting the
     * path it hangs off - and separate runs were read as separate networks seven times in
     * one session. Empty means nothing steps off this run at all, which for a reachable run
     * happens only where the gate is its single link.
     */
    touches: number[];
    /**
     * The most tiles that stop being reachable from the gate when one tile of this run stops
     * carrying traffic - which is what a ride's entrance claiming a queue on it does: the
     * tile the door opens onto dead-ends there. Laying the queue is not what does it; a
     * queue no ride owns is walked like any other path. 0 means no tile of this run cuts
     * anything off, so there is a way round all of it. A higher figure is the worst tile of
     * the run, usually its end nearest the gate; `describe_placement` gives the exact figure
     * for one particular tile, as an access option's `queueCutsOff`. The tile that is
     * claimed is not itself in the count: it is the tile handed to the ride rather than
     * something lost beside it, which is the same tile `describe_placement` prices
     * separately as "the queue takes x,y". Absent when `severingComputed` is false.
     */
    cutsIfBlocked?: number;
}

export interface StrandedDoor {
    ride: number;
    /** "entrance" or "exit". */
    door: string;
    x: number;
    y: number;
}

/**
 * A stretch of path the park gate reaches none of.
 *
 * The list of these is in the order a row-by-row scan of the map first reaches one: islands
 * come in the order of their lowest-y tile, and of its lowest x within that row. That is scan
 * order and nothing else - not by size, not by what is on them, not by anything about the
 * park - because which stranded fragment is worth reconnecting is the model's to weigh.
 */
export interface PathIsland {
    /** Path tiles on it. The `runs` below cover exactly these. */
    tiles: number;
    /**
     * The island as straight lines, the same shape `runs` takes, and for the same reason.
     *
     * This used to be `fromX`,`fromY`,`toX`,`toY`: min and max over an arbitrary blob, so a
     * six-tile L reported the 3x4 box around it. Meanwhile `build_path` tells the model in
     * its own words that "a run covers every tile between its `fromX`,`fromY` and its
     * `toX`,`toY`", and a model that applied that rule to an island concluded a tile was on
     * it that was on the reachable network instead, then spent its longest turn of the
     * session - 1,793 tokens - on the contradiction and issued a no-op. Two tool messages
     * asserting incompatible things about one field shape is the defect; a box is not a
     * line, so it is not written in a line's four names.
     */
    runs: PathRunLine[];
    /** Rides whose queues are on this island. */
    rides: number[];
    /** Ride doors standing on it. These rides are built and cannot be reached. */
    doors: StrandedDoor[];
}

export interface PathNetworkShape {
    /** The tiles of the park's own gate. Guests start here. */
    gate: Tile[];
    /** Path tiles the gate reaches, counted. The runs below cover exactly these. */
    reachableTiles: number;
    /** Straight lines of one kind of path. Both ends included, so `tiles` adds up to `reachableTiles`. */
    runs: PathRun[];
    /** Reachable tiles with one way off them or none. The gate counts as one way off. */
    deadEnds: Tile[];
    /**
     * False when the network was too large to work severance out, and the runs then carry
     * no `cutsIfBlocked`. Never quietly reported as "nothing severs".
     */
    severingComputed: boolean;
    /** Runs of path the gate cannot reach at all. */
    islands: PathIsland[];
}

function key(x: number, y: number): string {
    return String(x) + "," + String(y);
}

/**
 * One pass for every footpath on the map, with the thing `readMapGrid` does not carry: the
 * ride a queue is bound to.
 *
 * Every footpath element on the tile is looked at, not just the first, because that is what
 * `paths.ts` does and the two readers disagreeing is exactly the failure this module exists
 * to prevent: a tile that one of them calls a queue and the other calls a path is a tile the
 * model is told two different things about in the same turn.
 */
function readPathTiles(): Record<string, PathTile> {
    const tiles: Record<string, PathTile> = {};

    for (let y = 0; y < map.size.y; y++) {
        for (let x = 0; x < map.size.x; x++) {
            const tile = map.getTile(x, y);
            let found: PathTile | undefined;

            for (let i = 0; i < tile.numElements; i++) {
                const element = tile.getElement(i);

                if (element.type !== "footpath") {
                    continue;
                }

                const footpath = element as FootpathElement;

                if (!found) {
                    found = { x: x, y: y, queue: false, ride: null, edges: 0 };
                }

                // Only the low nibble is the four orthogonal edges; the high nibble is corners.
                found.edges |= footpath.edges & 0x0f;

                if (footpath.isQueue === true) {
                    found.queue = true;
                    found.ride = typeof footpath.ride === "number" ? footpath.ride : null;
                }
            }

            if (found) {
                tiles[key(x, y)] = found;
            }
        }
    }

    return tiles;
}

/**
 * The four directions in OpenRCT2's own order, so the index is the bit position in a
 * footpath's `edges`: 0 is -x, 1 is +y, 2 is +x, 3 is -y. This is `CoordsDirectionDelta`,
 * and it is the same constant `paths.ts` keeps for the same reason: `NEIGHBOURS` above is
 * in an arbitrary order and is walked by callers that have nothing to do with edge bits.
 */
const EDGE_DIRECTIONS = [{ dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 1, dy: 0 }, { dx: 0, dy: -1 }];

/** The bit in `edges` that points the other way down the same link. */
function opposite(direction: number): number {
    return (direction + 2) % 4;
}

/**
 * Every path tile the gate reaches, with `skip` treated as if it were not there.
 *
 * This is `walkableFromParkEntrance` over the same graph and has to stay identical to it:
 * the game's own footpath edges, with both ends of a link required to claim it. Read
 * `src/park/paths.ts` for why - in short, `PathGetPermittedEdges` hands the guest
 * pathfinder that bitfield verbatim, so the edges are the connectivity rather than a hint
 * about it.
 *
 * What stood here was a hand-rolled rule - "a queue tile expands only to other queue
 * tiles" - which is not what the game does. Turning path into queue moves no edge bit, so
 * guests walk a queue like any other path; a ride's entrance claiming a queue is what
 * severs, and it dead-ends the single tile the door opens onto. The old rule dead-ended
 * every queue tile, so this report under-counted reachable tiles and over-counted what a
 * queue would cut off.
 */
function reachableFromGate(tiles: Record<string, PathTile>, gate: Tile[], skip?: string): Record<string, boolean> {
    const seen: Record<string, boolean> = {};
    const pending: PathTile[] = [];

    for (let g = 0; g < gate.length; g++) {
        for (let i = 0; i < NEIGHBOURS.length; i++) {
            const at = key(gate[g].x + NEIGHBOURS[i].dx, gate[g].y + NEIGHBOURS[i].dy);
            const tile = tiles[at];

            if (tile && !seen[at] && at !== skip) {
                seen[at] = true;
                pending.push(tile);
            }
        }
    }

    while (pending.length > 0) {
        const current = pending.shift() as PathTile;

        for (let d = 0; d < EDGE_DIRECTIONS.length; d++) {
            if ((current.edges & (1 << d)) === 0) {
                continue;
            }

            const at = key(current.x + EDGE_DIRECTIONS[d].dx, current.y + EDGE_DIRECTIONS[d].dy);
            const tile = tiles[at];

            if (!tile || seen[at] || at === skip) {
                continue;
            }

            if ((tile.edges & (1 << opposite(d))) === 0) {
                continue;
            }

            seen[at] = true;
            pending.push(tile);
        }
    }

    return seen;
}

/** Two tiles belong to the same run only if a guest would read them as the same thing. */
function sameKind(a: PathTile, b: PathTile): boolean {
    return a.queue === b.queue && (!a.queue || a.ride === b.ride);
}

function runKind(tile: PathTile): string {
    return tile.queue ? "queue" : "path";
}

/** One straight line, with the tiles on it, so adjacency and severance can be worked out. */
interface RunTiles {
    line: PathRunLine;
    /** The key of every tile the line covers. */
    members: string[];
}

/**
 * Straight lines, greedily and longest-first per tile, covering each tile exactly once.
 *
 * Straight rather than "chains between junctions" on purpose: `x 51, y 19 to 26` is a line
 * the reader can picture, while a run that bends twice is a tile count and two endpoints
 * that describe no shape at all. Covering each tile once means `tiles` across the runs adds
 * up to `reachableTiles`, which is a check the reader can actually perform.
 *
 * `include` rather than the whole map decides which tiles are on the table, and the order
 * is read off it rather than off a sweep of every tile there is, because this is now called
 * once per island as well as once for the network and a 256-tile map is 65,536 cells a
 * side. Sorting by y and then x is the sweep's own order, so the runs come out unchanged.
 */
function straightRuns(tiles: Record<string, PathTile>, include: Record<string, boolean>): RunTiles[] {
    const assigned: Record<string, boolean> = {};
    const ordered: PathTile[] = [];
    const names = Object.keys(include);

    for (let i = 0; i < names.length; i++) {
        const tile = tiles[names[i]];

        if (tile && include[names[i]]) {
            ordered.push(tile);
        }
    }

    ordered.sort(function (a, b) { return a.y === b.y ? a.x - b.x : a.y - b.y; });

    const reach = function (seed: PathTile, dx: number, dy: number): number {
        let steps = 0;
        let x = seed.x + dx;
        let y = seed.y + dy;

        for (;;) {
            const at = key(x, y);
            const tile = tiles[at];

            if (!tile || !include[at] || assigned[at] || !sameKind(seed, tile)) {
                return steps;
            }

            steps++;
            x += dx;
            y += dy;
        }
    };

    const runs: RunTiles[] = [];

    for (let i = 0; i < ordered.length; i++) {
        const seed = ordered[i];

        if (assigned[key(seed.x, seed.y)]) {
            continue;
        }

        const left = reach(seed, -1, 0);
        const right = reach(seed, 1, 0);
        const up = reach(seed, 0, -1);
        const down = reach(seed, 0, 1);
        const horizontal = left + right;
        const vertical = up + down;
        const dx = horizontal >= vertical ? 1 : 0;
        const dy = horizontal >= vertical ? 0 : 1;
        const before = horizontal >= vertical ? left : up;
        const after = horizontal >= vertical ? right : down;

        const fromX = seed.x - dx * before;
        const fromY = seed.y - dy * before;
        const toX = seed.x + dx * after;
        const toY = seed.y + dy * after;

        const members: string[] = [];

        for (let step = -before; step <= after; step++) {
            const at = key(seed.x + dx * step, seed.y + dy * step);
            assigned[at] = true;
            members.push(at);
        }

        const line: PathRunLine = {
            fromX: fromX,
            fromY: fromY,
            toX: toX,
            toY: toY,
            tiles: before + after + 1,
            kind: runKind(seed)
        };

        if (seed.queue) {
            line.ride = seed.ride;
        }

        runs.push({ line: line, members: members });
    }

    return runs;
}

/**
 * For each run, the runs a guest can step onto from it, by position in the same list.
 *
 * The game's own edges, both ends of a link required to claim it, which is the rule
 * `reachableFromGate` and `walkableFromParkEntrance` walk. Plain adjacency would be cheaper
 * and would report the one link the game actually cuts - the tile a ride's entrance has
 * claimed, to whatever lay past it - as a road still open, which is the failure this whole
 * module exists to stop.
 */
function runAdjacency(tiles: Record<string, PathTile>, runs: RunTiles[]): number[][] {
    const owner: Record<string, number> = {};
    const touches: number[][] = [];
    const seen: Record<string, boolean>[] = [];

    for (let i = 0; i < runs.length; i++) {
        touches.push([]);
        seen.push({});

        for (let m = 0; m < runs[i].members.length; m++) {
            owner[runs[i].members[m]] = i;
        }
    }

    for (let i = 0; i < runs.length; i++) {
        for (let m = 0; m < runs[i].members.length; m++) {
            const tile = tiles[runs[i].members[m]];

            for (let d = 0; d < EDGE_DIRECTIONS.length; d++) {
                if ((tile.edges & (1 << d)) === 0) {
                    continue;
                }

                const at = key(tile.x + EDGE_DIRECTIONS[d].dx, tile.y + EDGE_DIRECTIONS[d].dy);
                const other = tiles[at];
                const j = owner[at];

                if (!other || typeof j !== "number" || j === i || seen[i][String(j)]) {
                    continue;
                }

                if ((other.edges & (1 << opposite(d))) === 0) {
                    continue;
                }

                seen[i][String(j)] = true;
                touches[i].push(j);
            }
        }

        touches[i].sort(function (a, b) { return a - b; });
    }

    return touches;
}

/**
 * How many ways off this tile there are. The gate counts as one: the tile outside the park
 * entrance has a single footpath neighbour and is not a dead end, and reporting it as one
 * would point at the busiest tile in the park as somewhere that leads nowhere.
 */
function degreeOf(tiles: Record<string, PathTile>, gate: Record<string, boolean>, tile: PathTile): number {
    let count = 0;

    for (let i = 0; i < NEIGHBOURS.length; i++) {
        const at = key(tile.x + NEIGHBOURS[i].dx, tile.y + NEIGHBOURS[i].dy);

        if (tiles[at] || gate[at]) {
            count++;
        }
    }

    return count;
}

function rideDoors(): StrandedDoor[] {
    const doors: StrandedDoor[] = [];
    const rides = map.rides;

    for (let i = 0; i < rides.length; i++) {
        const stations = rides[i].stations;

        for (let s = 0; s < stations.length; s++) {
            if (stations[s].entrance) {
                const at = doorTile(stations[s].entrance as CoordsXYZD);
                doors.push({ ride: rides[i].id, door: "entrance", x: at.x, y: at.y });
            }

            if (stations[s].exit) {
                const at = doorTile(stations[s].exit as CoordsXYZD);
                doors.push({ ride: rides[i].id, door: "exit", x: at.x, y: at.y });
            }
        }
    }

    return doors;
}

/** Connected blobs of path, by plain adjacency: an island is a physical thing, not a route. */
function components(tiles: Record<string, PathTile>, among: Record<string, boolean>): PathTile[][] {
    const seen: Record<string, boolean> = {};
    const blobs: PathTile[][] = [];
    const names = Object.keys(among);

    for (let i = 0; i < names.length; i++) {
        if (seen[names[i]] || !tiles[names[i]]) {
            continue;
        }

        const blob: PathTile[] = [];
        const pending = [tiles[names[i]]];
        seen[names[i]] = true;

        while (pending.length > 0) {
            const current = pending.shift() as PathTile;
            blob.push(current);

            for (let n = 0; n < NEIGHBOURS.length; n++) {
                const at = key(current.x + NEIGHBOURS[n].dx, current.y + NEIGHBOURS[n].dy);

                if (among[at] && !seen[at] && tiles[at]) {
                    seen[at] = true;
                    pending.push(tiles[at]);
                }
            }
        }

        blobs.push(blob);
    }

    return blobs;
}

export function readPathNetwork(): PathNetworkShape {
    const tiles = readPathTiles();
    const gate = findParkEntranceTiles();
    const reachable = reachableFromGate(tiles, gate);
    const reachableNames = Object.keys(reachable);
    const stranded: Record<string, boolean> = {};
    const allNames = Object.keys(tiles);

    for (let i = 0; i < allNames.length; i++) {
        if (!reachable[allNames[i]]) {
            stranded[allNames[i]] = true;
        }
    }

    const deadEnds: Tile[] = [];
    const gateTiles: Record<string, boolean> = {};

    for (let i = 0; i < gate.length; i++) {
        gateTiles[key(gate[i].x, gate[i].y)] = true;
    }

    for (let y = 0; y < map.size.y; y++) {
        for (let x = 0; x < map.size.x; x++) {
            const at = key(x, y);

            if (!reachable[at]) {
                continue;
            }

            if (degreeOf(tiles, gateTiles, tiles[at]) <= 1) {
                deadEnds.push({ x: x, y: y });
            }
        }
    }

    const severingComputed = reachableNames.length <= MAX_TILES_FOR_SEVERANCE;
    let severance: Record<string, number> | null = null;

    if (severingComputed) {
        severance = {};

        for (let i = 0; i < reachableNames.length; i++) {
            const without = reachableFromGate(tiles, gate, reachableNames[i]);
            let lost = 0;

            for (let r = 0; r < reachableNames.length; r++) {
                if (reachableNames[r] !== reachableNames[i] && !without[reachableNames[r]]) {
                    lost++;
                }
            }

            severance[reachableNames[i]] = lost;
        }
    }

    const found = straightRuns(tiles, reachable);
    const touching = runAdjacency(tiles, found);
    const runs: PathRun[] = [];

    for (let i = 0; i < found.length; i++) {
        const line = found[i].line;
        const run: PathRun = {
            index: i,
            fromX: line.fromX,
            fromY: line.fromY,
            toX: line.toX,
            toY: line.toY,
            tiles: line.tiles,
            kind: line.kind,
            touches: touching[i]
        };

        if (typeof line.ride !== "undefined") {
            run.ride = line.ride;
        }

        if (severance) {
            let worst = 0;

            for (let m = 0; m < found[i].members.length; m++) {
                worst = Math.max(worst, severance[found[i].members[m]] || 0);
            }

            run.cutsIfBlocked = worst;
        }

        runs.push(run);
    }

    const doors = rideDoors();
    const islands: PathIsland[] = components(tiles, stranded).map(function (blob) {
        const rides: number[] = [];
        const onIsland: Record<string, boolean> = {};

        for (let i = 0; i < blob.length; i++) {
            onIsland[key(blob[i].x, blob[i].y)] = true;

            if (blob[i].queue && typeof blob[i].ride === "number"
                && rides.indexOf(blob[i].ride as number) < 0) {
                rides.push(blob[i].ride as number);
            }
        }

        rides.sort(function (a, b) { return a - b; });

        return {
            tiles: blob.length,
            runs: straightRuns(tiles, onIsland).map(function (run) { return run.line; }),
            rides: rides,
            doors: doors.filter(function (door) { return onIsland[key(door.x, door.y)] === true; })
        };
    });

    // NOT sorted. It was sorted by `tiles` descending, undisclosed, two lines from
    // `GroundCensus.blocks` saying "Unordered - these are counts, not a ranking" - and the
    // biggest stranded fragment is the most walking recovered per tile of path laid, so
    // putting it first ranked the model's repair options for it. The order is now whatever
    // the scan produces, which `PathIsland` states.
    return {
        gate: gate,
        reachableTiles: reachableNames.length,
        runs: runs,
        deadEnds: deadEnds,
        severingComputed: severingComputed,
        islands: islands
    };
}

export interface GroundBlock {
    /** The block's own corner. Blocks are aligned to the map, so this tile means the same thing every turn. */
    x: number;
    y: number;
    /** Owned, flat, nothing standing on it. */
    clear: number;
    /** Owned and flat, with scenery, a wall or a banner on it: clear_scenery makes these `clear`. */
    scenery: number;
    /**
     * Owned but sloped, with nothing built on it. No typed tool here levels ground; the game's
     * own landsetheight, landraise, landlower and landsmooth do, and `evaluate` reaches them.
     */
    sloped: number;
    /** Owned water. */
    water: number;
    /** Owned and carrying a footpath or a queue. */
    path: number;
    /** Owned and carrying a ride, a building, or anything else that is not scenery. */
    built: number;
}

export interface GroundCensus {
    /** The side of one block in tiles. */
    block: number;
    /** Owned tiles in all: the six counts across every block add up to this. */
    owned: number;
    /** Only blocks holding owned land. Unordered - these are counts, not a ranking. */
    blocks: GroundBlock[];
    /** False when the park owns more blocks than one call reports, and `blocks` is a part of it. */
    complete: boolean;
}

/**
 * How much of what kind of ground the park owns, per block.
 *
 * Counts and nothing else. The obvious next field - the largest clear rectangle in each
 * block - is an extremum rather than a measurement, and reporting one is a step towards
 * telling the model where to build, which is not this bridge's to answer.
 */
export function readGroundCensus(block: number): GroundCensus {
    const side = Math.max(1, Math.floor(block));
    const grid = readMapGrid();
    const found: Record<string, GroundBlock> = {};
    const blocks: GroundBlock[] = [];
    let owned = 0;

    for (let y = 0; y < map.size.y; y++) {
        for (let x = 0; x < map.size.x; x++) {
            const cell = grid.at(x, y);

            if (!cell || !cell.owned) {
                continue;
            }

            owned++;
            const cornerX = Math.floor(x / side) * side;
            const cornerY = Math.floor(y / side) * side;
            const at = key(cornerX, cornerY);
            let entry = found[at];

            if (!entry) {
                entry = {
                    x: cornerX, y: cornerY,
                    clear: 0, scenery: 0, sloped: 0, water: 0, path: 0, built: 0
                };
                found[at] = entry;
                blocks.push(entry);
            }

            if (cell.path) {
                entry.path++;
            } else if (!cell.clear && !cell.clearable) {
                entry.built++;
            } else if (isWater(x, y)) {
                entry.water++;
            } else if (!cell.flat) {
                entry.sloped++;
            } else if (!cell.clear) {
                entry.scenery++;
            } else {
                entry.clear++;
            }
        }
    }

    return {
        block: side,
        owned: owned,
        blocks: blocks.slice(0, MAX_CENSUS_BLOCKS),
        complete: blocks.length <= MAX_CENSUS_BLOCKS
    };
}

function isWater(x: number, y: number): boolean {
    const tile = map.getTile(x, y);

    for (let i = 0; i < tile.numElements; i++) {
        const element = tile.getElement(i);

        if (element.type === "surface") {
            const height = (element as SurfaceElement).waterHeight;
            return typeof height === "number" && height > 0;
        }
    }

    return false;
}
