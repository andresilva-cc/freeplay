/**
 * A window of the map, written as coordinate runs, for the one question that has no compact
 * non-pictorial answer: how much contiguous room is here, and what shape is it.
 *
 * This is deliberately the smallest of the three things in this area, and it is on demand
 * rather than on every turn. Connectivity ("what joins what") is answered by `readPathNetwork`
 * in coordinates and free ground by `readGroundCensus` in counts. What is left here is shape.
 *
 * THIS WAS A GRID AND THE GRID WAS THE BUG. It drew one character per tile under a two-row
 * vertical-digit x header, and the header's own comment said it was there because "the way a
 * text map fails is a silent off-by-one". It caused the failure it existed to prevent.
 * Measured on session 01a09887: of 27 tile claims the model made from that grid, 14 were
 * right and 13 were wrong, every error the same one-column shift; 6,886 of 21,014 output
 * tokens - 33% - went on column arithmetic; it wrote "this is getting too complicated" six
 * times, called the tool once on turn 3 and never again across 38 further tool calls, while
 * writing "let me look at the map again" seven times and each time quoting a remembered row
 * that had decayed (the real rows are 40 characters; its quotes were 38, 36, and one row's
 * content under another row's label). Downstream, 9 of 13 `describe_placement` calls came
 * back `fits: false`, 7 of them on ground the grid had correctly drawn as unowned.
 *
 * The header could not work. Reading it needs column alignment held across two lines, and
 * tokenisation destroys exactly that. The model tried to use it as documented - "the first
 * '8' is at column 3 (0-indexed), so x=48 starts at column 3+3=6... this is getting
 * confusing" - then fell back to counting dashes, got one row right and the next row wrong
 * in the same paragraph, and had no way to tell which was which.
 *
 * So no tile's coordinate is ever counted now. Every row names its `y` and every run names
 * the `x` it starts at and the `x` it ends at, which is the same encoding a controlled study
 * measures this size of model reading at 66% where its best grid format scored 30%.
 *
 * EVERY TILE IS IN EXACTLY ONE RUN. Unowned ground is written out like everything else. It
 * is the majority of most windows and dropping it would be the cheapest thing here by a wide
 * margin, and it is also the one fact the measured failure turned on. More than the tokens:
 * because nothing is omitted, the runs of a row are contiguous and ascending, so the first
 * run starts at `area.fromX`, each run starts one past where the last ended, and the last
 * ends at `area.toX`. That is a check the reader can run on the row in front of it, and it
 * is what the header was trying and failing to be. Silence cannot be checked.
 *
 * BOTH ENDS OF EVERY RUN, EVEN A RUN OF ONE. `51-51P` is three characters more than `51P`
 * and buys two things. `51P` has a false reading in English - fifty-one path tiles - and the
 * chaining check above needs every run's last x written down, not inferred.
 *
 * A KIND IS A SHORT TAG, NOT A CHARACTER, AND THERE IS NO LEGEND. One character per tile was
 * a budget, and runs spend it per run instead of per tile, so the tag is affordable. `U` is
 * the park not owning the ground, and `UP`/`UQ` are paving on ground it does not own, so the
 * fact that cost a run 2,400 pounds - buying land toward an entrance corridor that was never
 * the park's to reach - is the first letter of the tag rather than a hyphen that reads as
 * absence. The legend field is gone: it was a second copy of what the tool description says,
 * it was read 0 times, and the description is in context on every turn anyway.
 *
 * RIDE TRACK NAMES ITS RIDE. `r3` is ride 3, the id `park_status` reports. The old grid spent
 * a lowercase letter per ride and a `rides` table to map letters back, which put the ride's
 * identity one lookup away from the picture, and gave up entirely past 26 rides.
 *
 * ONE TILE, ONE KIND. A tile is the first kind on the precedence list that applies to it, so
 * a tree on sloped ground reads as sloped: clearing it would not make that tile buildable.
 *
 * The ground is read through `readMapGrid`, the same pass `describe_placement` searches, so a
 * tile this map calls buildable is a tile that tool would consider. A second reader here with
 * its own idea of "owned and flat" would eventually disagree with it, and a map that
 * contradicts the tool that answers "where can I build" is worse than no map.
 */

import { normaliseRect } from "./clear.js";
import type { TileRect } from "./clear.js";
import { readMapGrid } from "./map.js";
import type { MapGrid } from "./map.js";
import { PARK_ENTRANCE, RIDE_ENTRANCE, RIDE_EXIT, findParkEntranceTiles } from "./paths.js";

/**
 * The longest side one call renders.
 *
 * A grid cost one character a tile whatever was on them, so the cap was the whole budget.
 * Runs cost by the run instead, which is cheaper on the ground a park is mostly made of and
 * dearer on ground that alternates tile by tile: measured on a 40x40 window of a forest
 * scenario, 1,796 characters against the grid's 2,504 where trees stand in clumps, 2,440
 * where every tree stands alone, and break-even is a run of about three tiles. The worst
 * case is real and unbounded by this constant, and it is not truncated: a window the reader
 * cannot see the edge of is a false map, and the cap is the thing that bounds it.
 */
export const MAX_VIEW_SIDE = 40;
export const MIN_VIEW_SIZE = 3;
export const DEFAULT_VIEW_SIZE = 15;
export const MAX_VIEW_MARGIN = 10;
export const DEFAULT_VIEW_MARGIN = 4;

const ON_PARK_GATE = "G";
const ON_RIDE_ENTRANCE = "N";
const ON_RIDE_EXIT = "X";
const ON_QUEUE = "Q";
/** A queue on ground the park does not own: there, walked, and not the park's to touch. */
const ON_QUEUE_UNOWNED = "UQ";
const ON_PATH = "P";
/** A footpath on ground the park does not own - a scenario's entrance corridor, typically. */
const ON_PATH_UNOWNED = "UP";
/** Something is standing here that this renderer has no name for. */
const ON_UNNAMED = "!";
const GROUND_UNREADABLE = "?";
const GROUND_WATER = "~";
const GROUND_UNOWNED = "U";
const GROUND_SLOPED = "^";
const GROUND_SCENERY = "S";
const GROUND_CLEAR = "E";

/** What `clear_scenery` will take down, which is what `S` promises. Same set as map.ts. */
const SCENERY_TYPES: Record<string, boolean> = {
    small_scenery: true,
    large_scenery: true,
    wall: true,
    banner: true
};

export interface MapViewRect {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
}

export interface MapViewSuccess {
    ok: true;
    /**
     * The ground this render actually covers, margin included. It is a view box, not a ride's
     * footprint: handing it to `clear_scenery` would clear every tile in the picture.
     */
    area: MapViewRect;
    /** The corners the caller itself named, before any margin was added around them. */
    requested: MapViewRect;
    clipped: boolean;
    /**
     * One line per y, in ascending y, each a list of runs covering `area.fromX` to
     * `area.toX` with no gap. A clipped window adds a final line starting `cut:`.
     */
    rows: string[];
}

export interface MapViewFailure {
    ok: false;
    error: string;
}

export type MapViewOutcome = MapViewSuccess | MapViewFailure;

/**
 * One tile, read rather than inferred.
 *
 * `grid` answers for ownership and slope so this agrees with `describe_placement`; the
 * element walk answers for everything that grid does not carry - water, which kind of
 * entrance a building is, and which ride a piece of track belongs to.
 */
function readTile(grid: MapGrid, x: number, y: number): string {
    const cell = grid.at(x, y);
    const tile = map.getTile(x, y);

    let hasSurface = false;
    let water = false;
    let gate = false;
    let rideEntrance = false;
    let rideExit = false;
    let trackRide = -1;
    let queue = false;
    let path = false;
    let scenery = false;
    let unnamed = false;

    for (let i = 0; i < tile.numElements; i++) {
        const element = tile.getElement(i);

        if (element.type === "surface") {
            hasSurface = true;
            const height = (element as SurfaceElement).waterHeight;

            if (typeof height === "number" && height > 0) {
                water = true;
            }

            continue;
        }

        if (element.type === "entrance") {
            const entrance = element as EntranceElement;

            if (entrance.object === PARK_ENTRANCE) {
                gate = true;
            } else if (entrance.object === RIDE_ENTRANCE) {
                rideEntrance = true;
            } else if (entrance.object === RIDE_EXIT) {
                rideExit = true;
            } else {
                unnamed = true;
            }

            continue;
        }

        if (element.type === "track") {
            const track = element as TrackElement;

            if (typeof track.ride === "number") {
                if (trackRide < 0) {
                    trackRide = track.ride;
                }
            } else {
                unnamed = true;
            }

            continue;
        }

        if (element.type === "footpath") {
            path = true;

            if ((element as FootpathElement).isQueue) {
                queue = true;
            }

            continue;
        }

        if (SCENERY_TYPES[element.type]) {
            scenery = true;
            continue;
        }

        // Not a lie by omission: something is on this tile and nothing here can name it.
        unnamed = true;
    }

    if (gate) {
        return ON_PARK_GATE;
    }

    if (rideEntrance) {
        return ON_RIDE_ENTRANCE;
    }

    if (rideExit) {
        return ON_RIDE_EXIT;
    }

    if (trackRide >= 0) {
        return "r" + String(trackRide);
    }

    // Paving is drawn before the ground it sits on, and carries the ground's one fact that
    // still changes what can be done here. A path the park does not own is walked by guests
    // and is not the park's to queue, to pave up to, or in most scenarios to buy.
    const owned = !!cell && cell.owned;

    if (queue) {
        return owned ? ON_QUEUE : ON_QUEUE_UNOWNED;
    }

    if (path) {
        return owned ? ON_PATH : ON_PATH_UNOWNED;
    }

    if (unnamed) {
        return ON_UNNAMED;
    }

    if (!hasSurface || !cell) {
        return GROUND_UNREADABLE;
    }

    if (water) {
        return GROUND_WATER;
    }

    if (!cell.owned) {
        return GROUND_UNOWNED;
    }

    if (!cell.flat) {
        return GROUND_SLOPED;
    }

    return scenery ? GROUND_SCENERY : GROUND_CLEAR;
}

/**
 * One row of the window: its y, then every tile of it as `<firstX>-<lastX><kind>`.
 *
 * Both ends are always written, a run of one tile included, so a reader can chain the runs -
 * each starts one past where the last ended - without holding a column count anywhere.
 */
function renderRow(grid: MapGrid, y: number, fromX: number, toX: number): string {
    let row = "y" + String(y) + ":";
    let runFrom = fromX;
    let runKind = readTile(grid, fromX, y);

    for (let x = fromX + 1; x <= toX + 1; x++) {
        const kind = x <= toX ? readTile(grid, x, y) : "";

        if (kind === runKind) {
            continue;
        }

        row += " " + String(runFrom) + "-" + String(x - 1) + runKind;
        runFrom = x;
        runKind = kind;
    }

    return row;
}

/** The centre of the park's own gate, for a call that named no window at all. */
export function parkGateCentre(): { x: number; y: number } | null {
    const gate = findParkEntranceTiles();

    if (gate.length === 0) {
        return null;
    }

    let sumX = 0;
    let sumY = 0;

    for (let i = 0; i < gate.length; i++) {
        sumX += gate[i].x;
        sumY += gate[i].y;
    }

    return { x: Math.floor(sumX / gate.length), y: Math.floor(sumY / gate.length) };
}

function asViewRect(area: TileRect): MapViewRect {
    return { fromX: area.left, fromY: area.top, toX: area.right, toY: area.bottom };
}

/**
 * Render `window`, both corners included, clipped to the map.
 *
 * `requested` is the caller's own corners, which is what the result reports under that name.
 * It is not `window` whenever a margin was added: the rectangle form draws `margin` tiles of
 * ground around the corners it was given, and reporting the grown rectangle as the one that
 * was asked for tells the model it asked for a window it never named.
 *
 * Clipping is reported rather than silently applied: a smaller window than the one this set
 * out to draw, handed back with no word about it, reads as "there is nothing out there".
 */
export function renderMapView(window: TileRect, requested?: TileRect): MapViewOutcome {
    const asked = normaliseRect(window);
    const named = normaliseRect(requested || window);
    const width = map.size.x;
    const height = map.size.y;

    const area: TileRect = {
        left: Math.max(0, asked.left),
        top: Math.max(0, asked.top),
        right: Math.min(width - 1, asked.right),
        bottom: Math.min(height - 1, asked.bottom)
    };

    if (area.left > area.right || area.top > area.bottom) {
        return {
            ok: false,
            error: "That window is entirely off the map, so there is nothing to draw. The map runs"
                + " from 0,0 to " + String(width - 1) + "," + String(height - 1) + " in tiles."
        };
    }

    const viewWidth = area.right - area.left + 1;
    const viewHeight = area.bottom - area.top + 1;

    if (viewWidth > MAX_VIEW_SIDE || viewHeight > MAX_VIEW_SIDE) {
        // The margin is the difference between the two rectangles, and saying only the grown
        // size measures a window the caller never named: four corners well inside the cap can
        // be refused by a number nothing in the call adds up to.
        const around = named.left - asked.left;

        return {
            ok: false,
            error: "That window is " + String(viewWidth) + " by " + String(viewHeight)
                + " tiles and view_map draws at most " + String(MAX_VIEW_SIDE) + " on a side."
                + (around > 0
                    ? " The corners named are " + String(named.right - named.left + 1) + " by "
                        + String(named.bottom - named.top + 1) + " tiles and `margin` read "
                        + String(around) + " more on every side." : "")
                + " Ask for a smaller rectangle"
                + (around > 0 ? ", a smaller `margin`," : ",")
                + " or pass `x`, `y` and `size` for a square centred somewhere inside it."
        };
    }

    const grid = readMapGrid();
    const rows: string[] = [];

    for (let y = area.top; y <= area.bottom; y++) {
        rows.push(renderRow(grid, y, area.left, area.right));
    }

    const clipped = area.left !== asked.left || area.top !== asked.top
        || area.right !== asked.right || area.bottom !== asked.bottom;

    if (clipped) {
        // In the rows rather than beside them, because the rows are what gets read.
        rows.push("cut: the map runs 0-" + String(width - 1) + " in x and 0-" + String(height - 1)
            + " in y, so the window was cut to the ground drawn above: x " + String(area.left)
            + "-" + String(area.right) + ", y " + String(area.top) + "-" + String(area.bottom) + ".");
    }

    return {
        ok: true,
        area: asViewRect(area),
        requested: asViewRect(named),
        clipped: clipped,
        rows: rows
    };
}
