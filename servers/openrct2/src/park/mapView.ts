/**
 * A window of the map, rendered as text, for the one question that has no compact
 * non-pictorial answer: how much contiguous room is here, and what shape is it.
 *
 * This is deliberately the smallest of the three things in this area, and it is on demand
 * rather than on every turn. Measured across model sizes, a grid is the WORSE encoding in
 * this capacity band - an 8B model scored 66% on Cartesian coordinates and 30% on its best
 * grid format at the same task - so connectivity ("what joins what") is answered by
 * `readPathNetwork` in coordinates, and free ground by `readGroundCensus` in counts. What
 * is left for a picture is shape, which coordinates genuinely cannot carry.
 *
 * Two decisions follow from measurement rather than taste.
 *
 * ONE CHARACTER PER TILE, NO SEPARATOR. A space between cells doubles the render and stops
 * runs of identical ground collapsing into single tokens, which is most of what makes a
 * small window affordable. The cost is that one character has to carry the whole tile, so
 * the legend states the precedence outright: a tile shows the first thing on the list that
 * applies to it, and a tree on sloped ground reads as sloped, because clearing it would not
 * make that tile buildable.
 *
 * OWNERSHIP IS PART OF WHAT THE CHARACTER CARRIES. A footpath used to be `P` whether the
 * park owned the ground or not, and in Forest Frontiers the whole entrance corridor is path
 * on land the park neither owns nor can buy. A run read that corridor as ordinary paving and
 * spent 2,400 pounds buying ground to reach a path that could never be reached, then said in
 * its own words that a path on non-park land "doesn't make sense" - there was no way to tell
 * from the picture, because the picture did not carry the difference. So the paving glyphs
 * come in pairs: `P`/`=` for path and `Q`/`:` for queue, the park's land and not. The other
 * built glyphs - the gate, a ride's doors, its track - do not split, because nothing the
 * model can do about those tiles changes with ownership: they are occupied either way, and
 * they are the park's own structures. The ground glyphs already split, `-` being ground the
 * park does not own.
 *
 * COORDINATE HEADERS ON BOTH AXES. The way a text map fails is a silent off-by-one: the
 * model reads the right shape at the wrong offset and builds one tile out. x runs down the
 * header rows, one digit place per row, and every row carries its own y.
 *
 * The ground is read through `readMapGrid`, the same pass `find_build_sites` searches, so a
 * tile this map calls buildable is a tile that tool would consider. A second reader here
 * with its own idea of "owned and flat" would eventually disagree with it, and a map that
 * contradicts the tool that answers "where can I build" is worse than no map.
 */

import { normaliseRect } from "./clear.js";
import type { TileRect } from "./clear.js";
import { readMapGrid } from "./map.js";
import type { MapGrid } from "./map.js";
import { PARK_ENTRANCE, RIDE_ENTRANCE, RIDE_EXIT, findParkEntranceTiles } from "./paths.js";

/** The longest side one call renders. 40x40 is 1600 tiles, about 1,700 characters of grid. */
export const MAX_VIEW_SIDE = 40;
export const MIN_VIEW_SIZE = 3;
export const DEFAULT_VIEW_SIZE = 15;
export const MAX_VIEW_MARGIN = 10;
export const DEFAULT_VIEW_MARGIN = 4;

const ON_PARK_GATE = "G";
const ON_RIDE_ENTRANCE = "N";
const ON_RIDE_EXIT = "X";
/** A ride whose id is past z. Nothing can name it in one character, so it says so. */
const ON_RIDE_BEYOND_Z = "#";
const ON_QUEUE = "Q";
/** A queue on ground the park does not own: there, walked, and not the park's to touch. */
const ON_QUEUE_UNOWNED = ":";
const ON_PATH = "P";
/** A footpath on ground the park does not own - a scenario's entrance corridor, typically. */
const ON_PATH_UNOWNED = "=";
/** Something is standing here that this renderer has no name for. */
const ON_UNNAMED = "%";
const GROUND_UNREADABLE = "?";
const GROUND_WATER = "~";
const GROUND_UNOWNED = "-";
const GROUND_SLOPED = "^";
const GROUND_SCENERY = "*";
const GROUND_CLEAR = ".";

const RIDE_LETTERS = "abcdefghijklmnopqrstuvwxyz";

/**
 * The precedence, highest first, exactly as the legend states it. Anything built comes
 * before anything about the ground, because you cannot build on a tile that is taken
 * whatever the ground is like; then the ground, hardest fact first. Paving is the one built
 * thing whose glyph also carries whose land it stands on, because that is the one built
 * thing the park lays, replaces and joins onto.
 */
const GLYPH_ORDER = ON_PARK_GATE + ON_RIDE_ENTRANCE + ON_RIDE_EXIT + "a" + ON_RIDE_BEYOND_Z
    + ON_QUEUE + ON_QUEUE_UNOWNED + ON_PATH + ON_PATH_UNOWNED + ON_UNNAMED + GROUND_UNREADABLE
    + GROUND_WATER + GROUND_UNOWNED + GROUND_SLOPED + GROUND_SCENERY + GROUND_CLEAR;

/** What `clear_scenery` will take down, which is what `*` promises. Same set as map.ts. */
const SCENERY_TYPES: Record<string, boolean> = {
    small_scenery: true,
    large_scenery: true,
    wall: true,
    banner: true
};

/**
 * One short phrase per glyph. Only the phrases for glyphs actually in the grid are sent
 * back: every character the model can see is explained, and no character it cannot see is
 * put in front of it to be imagined into the map.
 */
const LEGEND_PHRASES: Record<string, string> = {
    "G": "G park gate",
    "N": "N ride entrance",
    "X": "X ride exit",
    "a": "a-z ride track (see rides)",
    "#": "# ride track past z",
    "Q": "Q queue on the park's land",
    ":": ": queue, not the park's land",
    "P": "P path on the park's land",
    "=": "= path, not the park's land (no queue, no path, no buying it)",
    "%": "% unnamed thing on the tile",
    "?": "? unreadable",
    "~": "~ water",
    "-": "- not the park's land",
    "^": "^ owned, sloped, nothing levels it",
    "*": "* owned, flat, scenery (clear_scenery clears it)",
    ".": ". owned, flat, empty"
};

const PRECEDENCE_NOTE = "1 char/tile, no gaps; first that applies: G N X a-z # Q : P = % ? ~ - ^ * .";

export interface MapViewRect {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
}

export interface RideLetter {
    letter: string;
    ride: number;
}

export interface MapViewSuccess {
    ok: true;
    /**
     * The ground this render actually covers. It is a view box, not a ride's footprint:
     * handing it to `clear_scenery` would clear every tile in the picture.
     */
    area: MapViewRect;
    /** The window that was asked for, before the map's edges cut it down. */
    requested: MapViewRect;
    clipped: boolean;
    /** The x header rows, then one row per y. Read them in order. */
    rows: string[];
    /** Every character this render used, and nothing else. */
    legend: string;
    /** Which ride each letter in the grid stands for. Empty when no track is in view. */
    rides: RideLetter[];
    note?: string;
}

export interface MapViewFailure {
    ok: false;
    error: string;
}

export type MapViewOutcome = MapViewSuccess | MapViewFailure;

/** ES5 target: no String.prototype.repeat. */
function repeat(text: string, count: number): string {
    let out = "";

    for (let i = 0; i < count; i++) {
        out += text;
    }

    return out;
}

/** ES5 target: no String.prototype.padStart. */
function padLeft(text: string, width: number): string {
    return repeat(" ", Math.max(0, width - text.length)) + text;
}

interface TileReading {
    glyph: string;
    /** The ride the track belongs to, or -1 when the cell is not showing track. */
    ride: number;
}

/**
 * One tile, read rather than inferred.
 *
 * `grid` answers for ownership and slope so this agrees with `find_build_sites`; the
 * element walk answers for everything that grid does not carry - water, which kind of
 * entrance a building is, and which ride a piece of track belongs to.
 */
function readTile(grid: MapGrid, x: number, y: number): TileReading {
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
        return { glyph: ON_PARK_GATE, ride: -1 };
    }

    if (rideEntrance) {
        return { glyph: ON_RIDE_ENTRANCE, ride: -1 };
    }

    if (rideExit) {
        return { glyph: ON_RIDE_EXIT, ride: -1 };
    }

    if (trackRide >= 0) {
        return {
            glyph: trackRide < RIDE_LETTERS.length ? RIDE_LETTERS.charAt(trackRide) : ON_RIDE_BEYOND_Z,
            ride: trackRide
        };
    }

    // Paving is drawn before the ground it sits on, and carries the ground's one fact that
    // still changes what can be done here. A path the park does not own is walked by guests
    // and is not the park's to queue, to pave up to, or in most scenarios to buy.
    const owned = !!cell && cell.owned;

    if (queue) {
        return { glyph: owned ? ON_QUEUE : ON_QUEUE_UNOWNED, ride: -1 };
    }

    if (path) {
        return { glyph: owned ? ON_PATH : ON_PATH_UNOWNED, ride: -1 };
    }

    if (unnamed) {
        return { glyph: ON_UNNAMED, ride: -1 };
    }

    if (!hasSurface || !cell) {
        return { glyph: GROUND_UNREADABLE, ride: -1 };
    }

    if (water) {
        return { glyph: GROUND_WATER, ride: -1 };
    }

    if (!cell.owned) {
        return { glyph: GROUND_UNOWNED, ride: -1 };
    }

    if (!cell.flat) {
        return { glyph: GROUND_SLOPED, ride: -1 };
    }

    return { glyph: scenery ? GROUND_SCENERY : GROUND_CLEAR, ride: -1 };
}

/**
 * The x coordinate of every column, written down the page one digit place per row, so the
 * digits of a column's number sit in that column. A single header row cannot do this:
 * two- and three-digit coordinates do not fit a one-character cell.
 */
function headerRows(fromX: number, toX: number, prefixWidth: number): string[] {
    const places = String(toX).length;
    const rows: string[] = [];

    for (let place = places - 1; place >= 0; place--) {
        let row = repeat(" ", prefixWidth);

        for (let x = fromX; x <= toX; x++) {
            const digits = String(x);
            const index = digits.length - 1 - place;
            row += index >= 0 ? digits.charAt(index) : " ";
        }

        rows.push(row);
    }

    return rows;
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
 * Render `requested`, both corners included, clipped to the map.
 *
 * Clipping is reported rather than silently applied: a smaller grid than was asked for,
 * handed back with no word about it, reads as "there is nothing out there".
 */
export function renderMapView(requested: TileRect): MapViewOutcome {
    const asked = normaliseRect(requested);
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
        return {
            ok: false,
            error: "That window is " + String(viewWidth) + " by " + String(viewHeight)
                + " tiles and view_map draws at most " + String(MAX_VIEW_SIDE) + " on a side."
                + " Ask for a smaller rectangle, or pass `x`, `y` and `size` for a square"
                + " centred somewhere inside it."
        };
    }

    const grid = readMapGrid();
    const labelWidth = String(area.bottom).length;
    const prefixWidth = labelWidth + 1;
    const rows = headerRows(area.left, area.right, prefixWidth);
    const seenGlyphs: Record<string, boolean> = {};
    const seenRides: Record<number, boolean> = {};
    const rides: RideLetter[] = [];

    for (let y = area.top; y <= area.bottom; y++) {
        let row = padLeft(String(y), labelWidth) + " ";

        for (let x = area.left; x <= area.right; x++) {
            const reading = readTile(grid, x, y);
            row += reading.glyph;
            seenGlyphs[reading.glyph] = true;

            // A ride past z has no letter of its own, so a mapping entry for it would
            // claim `#` meant that ride when a second overflowing ride uses `#` too.
            if (reading.ride >= 0 && reading.glyph !== ON_RIDE_BEYOND_Z && !seenRides[reading.ride]) {
                seenRides[reading.ride] = true;
                rides.push({ letter: reading.glyph, ride: reading.ride });
            }
        }

        rows.push(row);
    }

    rides.sort(function (a, b) { return a.ride - b.ride; });

    const phrases: string[] = [];

    for (let i = 0; i < GLYPH_ORDER.length; i++) {
        const glyph = GLYPH_ORDER.charAt(i);

        if (glyph === "a") {
            if (rides.length > 0) {
                phrases.push(LEGEND_PHRASES.a);
            }

            continue;
        }

        if (seenGlyphs[glyph]) {
            phrases.push(LEGEND_PHRASES[glyph]);
        }
    }

    const clipped = area.left !== asked.left || area.top !== asked.top
        || area.right !== asked.right || area.bottom !== asked.bottom;

    const view: MapViewSuccess = {
        ok: true,
        area: asViewRect(area),
        requested: asViewRect(asked),
        clipped: clipped,
        rows: rows,
        legend: PRECEDENCE_NOTE + " | " + phrases.join(" | "),
        rides: rides
    };

    if (clipped) {
        view.note = "The window was cut to the map's edge: you asked for "
            + String(asked.left) + "," + String(asked.top) + " to "
            + String(asked.right) + "," + String(asked.bottom) + " and this draws "
            + String(area.left) + "," + String(area.top) + " to "
            + String(area.right) + "," + String(area.bottom)
            + ". The map runs from 0,0 to " + String(width - 1) + "," + String(height - 1) + ".";
    }

    return view;
}
