import { mcpTool, mcpToolController } from "./decorators.js";
import { centredSquare } from "../park/clear.js";
import type { TileRect } from "../park/clear.js";
import {
    DEFAULT_VIEW_MARGIN,
    DEFAULT_VIEW_SIZE,
    MAX_VIEW_MARGIN,
    MAX_VIEW_SIDE,
    MIN_VIEW_SIZE,
    parkGateCentre,
    renderMapView
} from "../park/mapView.js";
import type { MapViewOutcome } from "../park/mapView.js";

interface ArgumentFailure {
    ok: false;
    error: string;
}

/**
 * The ground to read, and separately the corners the caller itself named.
 *
 * They differ only when `margin` grew the rectangle, and keeping them apart is the whole
 * point: the result reports `requested` as "the window asked for", and the margin-grown
 * rectangle is not a window anybody asked for.
 */
interface ViewWindow {
    window: TileRect;
    requested: TileRect;
}

function isFailure(value: ViewWindow | ArgumentFailure): value is ArgumentFailure {
    return (value as ArgumentFailure).ok === false;
}

const SQUARE_ARGS = ["x", "y", "size"];
const RECT_ARGS = ["fromX", "fromY", "toX", "toY", "margin"];
const RECT_CORNERS = ["fromX", "fromY", "toX", "toY"];

function given(args: Record<string, unknown>, names: string[]): string[] {
    return names.filter(function (name) {
        return typeof args[name] === "number";
    });
}

function whole(args: Record<string, unknown>, name: string, fallback: number): number {
    return typeof args[name] === "number" ? Math.floor(args[name] as number) : fallback;
}

/** A square form names its own window exactly, so nothing was added to it. */
function asItself(area: TileRect): ViewWindow {
    return { window: area, requested: area };
}

/**
 * Which window was asked for, or what was missing or contradictory about it.
 *
 * The two forms share no arguments, so which one a call means is never a judgement call,
 * and `describe_placement` reports a footprint's four corners under the same four names the rectangle
 * form takes. A call with neither form is the commonest one there is - "show me the park" -
 * and answering it from the gate costs the model nothing to get right.
 */
function areaFromArgs(args: Record<string, unknown>): ViewWindow | ArgumentFailure {
    const square = given(args, SQUARE_ARGS);
    const rect = given(args, RECT_ARGS);

    if (square.length > 0 && rect.length > 0) {
        return {
            ok: false,
            error: "view_map takes one form or the other, and this call mixes them: `"
                + square.join("`, `") + "` belong to the square form and `" + rect.join("`, `")
                + "` to the rectangle form. `x`/`y`/`size` is a square centred on x,y;"
                + " `fromX`/`fromY`/`toX`/`toY`/`margin` is a rectangle with room around it."
                + " Drop one set."
        };
    }

    if (rect.length > 0) {
        const missing = RECT_CORNERS.filter(function (name) {
            return rect.indexOf(name) < 0;
        });

        if (missing.length > 0) {
            return {
                ok: false,
                error: "A rectangle needs all four of `fromX`, `fromY`, `toX` and `toY`; `"
                    + missing.join("`, `") + "` " + (missing.length === 1 ? "was" : "were")
                    + " left out. A placement's `footprint` from describe_placement carries all four under those names."
            };
        }

        const margin = whole(args, "margin", DEFAULT_VIEW_MARGIN);
        const corners: TileRect = {
            left: Math.min(args.fromX as number, args.toX as number),
            top: Math.min(args.fromY as number, args.toY as number),
            right: Math.max(args.fromX as number, args.toX as number),
            bottom: Math.max(args.fromY as number, args.toY as number)
        };

        return {
            window: {
                left: corners.left - margin,
                top: corners.top - margin,
                right: corners.right + margin,
                bottom: corners.bottom + margin
            },
            requested: corners
        };
    }

    const size = whole(args, "size", DEFAULT_VIEW_SIZE);
    const hasX = typeof args.x === "number";
    const hasY = typeof args.y === "number";

    if (hasX !== hasY) {
        return {
            ok: false,
            error: "A square is centred on `x` and `y` together and this call passed only `"
                + (hasX ? "x" : "y") + "`. Pass both, or pass neither and the square is centred"
                + " on the park's own gate."
        };
    }

    if (hasX && hasY) {
        return asItself(centredSquare(args.x as number, args.y as number, size));
    }

    const gate = parkGateCentre();

    if (gate === null) {
        return {
            ok: false,
            error: "view_map centres on the park's gate when no window is named, and this park has"
                + " no gate on the map. Pass `x`, `y` and `size` for a square, or `fromX`, `fromY`,"
                + " `toX` and `toY` for a rectangle."
        };
    }

    return asItself(centredSquare(gate.x, gate.y, size));
}

@mcpToolController
export class MapViewTools {
    @mcpTool({
        name: "View the map",
        description: [
            "Read a window of the park tile by tile, so the SHAPE of the ground is something you",
            "read rather than work out from coordinates. It reports; it recommends nothing.",
            "Use it when you are siting something and need to see how much room is where.",
            "For what joins what, read `park_status`: this is the weaker way to answer that.",
            "Called with no arguments at all it reads a",
            String(DEFAULT_VIEW_SIZE) + "x" + String(DEFAULT_VIEW_SIZE),
            "square around the park's own gate.",
            "TO SEE A PLACEMENT AND ITS SURROUNDINGS, pass `fromX`, `fromY`, `toX` and `toY` copied",
            "straight off a `footprint` from `describe_placement` - the same four names - and `margin` tiles",
            "of ground are read around them, " + String(DEFAULT_VIEW_MARGIN) + " unless you say otherwise.",
            "TO SEE AROUND A TILE, pass `x`, `y` and `size`: a square of `size` tiles centred there,",
            "the same form `clear_scenery` takes. Any tile another tool reported works - a ride's",
            "`x`,`y`, a door tile, the park gate.",
            "`rows` IS ONE LINE PER `y`, in ascending `y`. A line is `y` and that row's y and a colon,",
            "then that row's tiles as runs, each written `<firstX>-<lastX><kind>` with both ends",
            "always given, so a single tile is `51-51P`. The runs of a line are contiguous and",
            "ascending: the first starts at `area.fromX`, each starts one past where the one before",
            "it ended, and the last ends at `area.toX`. So every tile of the window is in exactly one",
            "run, no tile's coordinate is ever counted off a column, and ground that carries on from",
            "one row to the next is runs whose spans overlap on neighbouring lines.",
            "A TILE IS THE FIRST OF THESE KINDS THAT APPLIES TO IT: `G` the park's gate, `N` a ride's",
            "entrance building, `X` a ride's exit building, `r` and a number for track belonging to",
            "that ride - `r3` is the ride `park_status` reports as id 3 - `Q` queue and `P` footpath",
            "on the park's land, `UQ` and `UP` those same two on land it does not own,",
            "`!` something this map cannot name, `?` no surface could be read, `~` water, `U` not",
            "the park's land, `^` the park's but sloped, which nothing here levels, `S` the park's",
            "and flat with scenery on it, which `clear_scenery` takes down, and `E` the park's,",
            "flat and empty. So a tree on sloped ground reads as `^`: clearing it would not make",
            "that tile buildable, and a scenario's entrance corridor reads as `UP`: guests walk it and",
            "the park can neither pave onto it nor usually buy it.",
            "`area` is the ground read, margin included, and `requested` the corners you named before",
            "any margin was added around them. `clipped` is true when the map's edge cut the window",
            "down, and `rows` then ends with one more line, starting `cut:`, saying what was read",
            "instead. `area` is a view box and not a ride's footprint: never hand it to",
            "`clear_scenery`, which would clear every tile in it.",
            "At most " + String(MAX_VIEW_SIDE) + " tiles on a side."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                x: {
                    type: "integer",
                    minimum: 0,
                    description: "Square form: tile x of the centre. Needs y. Leave x and y out"
                        + " altogether and the square is centred on the park's gate."
                },
                y: {
                    type: "integer",
                    minimum: 0,
                    description: "Square form: tile y of the centre. Needs x. Leave x and y out"
                        + " altogether and the square is centred on the park's gate."
                },
                size: {
                    type: "integer",
                    minimum: MIN_VIEW_SIZE,
                    maximum: MAX_VIEW_SIDE,
                    description: "Square form: width of the square in tiles, " + String(MIN_VIEW_SIZE)
                        + " to " + String(MAX_VIEW_SIDE) + ". Default " + String(DEFAULT_VIEW_SIZE)
                        + ". Works with x and y, and on its own with the gate-centred default."
                },
                fromX: { type: "integer", minimum: 0, description: "Rectangle form: a footprint's `fromX`. Tile x of one corner, included." },
                fromY: { type: "integer", minimum: 0, description: "Rectangle form: a footprint's `fromY`. Tile y of one corner, included." },
                toX: { type: "integer", minimum: 0, description: "Rectangle form: a footprint's `toX`. Tile x of the opposite corner, included." },
                toY: { type: "integer", minimum: 0, description: "Rectangle form: a footprint's `toY`. Tile y of the opposite corner, included." },
                margin: {
                    type: "integer",
                    minimum: 0,
                    maximum: MAX_VIEW_MARGIN,
                    description: "Rectangle form: extra tiles read on every side of it, 0 to "
                        + String(MAX_VIEW_MARGIN) + ". Default " + String(DEFAULT_VIEW_MARGIN)
                        + ". A ride's own ground tells you nothing about what it would sit next to."
                        + " `area` grows by it; `requested` stays the corners you named."
                }
            },
            additionalProperties: false
        },
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
            destructiveHint: false,
            openWorldHint: false
        }
    })
    public viewMap(args: Record<string, unknown>): MapViewOutcome | ArgumentFailure {
        const asked = areaFromArgs(args);

        if (isFailure(asked)) {
            return asked;
        }

        return renderMapView(asked.window, asked.requested);
    }
}
