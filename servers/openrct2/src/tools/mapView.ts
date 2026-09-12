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

function isFailure(value: TileRect | ArgumentFailure): value is ArgumentFailure {
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

/**
 * Which window was asked for, or what was missing or contradictory about it.
 *
 * The two forms share no arguments, so which one a call means is never a judgement call,
 * and `find_build_sites` reports its four bounds under the same four names the rectangle
 * form takes. A call with neither form is the commonest one there is - "show me the park" -
 * and answering it from the gate costs the model nothing to get right.
 */
function areaFromArgs(args: Record<string, unknown>): TileRect | ArgumentFailure {
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
                    + " left out. A site from find_build_sites carries all four under those names."
            };
        }

        const margin = whole(args, "margin", DEFAULT_VIEW_MARGIN);

        return {
            left: Math.min(args.fromX as number, args.toX as number) - margin,
            top: Math.min(args.fromY as number, args.toY as number) - margin,
            right: Math.max(args.fromX as number, args.toX as number) + margin,
            bottom: Math.max(args.fromY as number, args.toY as number) + margin
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
        return centredSquare(args.x as number, args.y as number, size);
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

    return centredSquare(gate.x, gate.y, size);
}

@mcpToolController
export class MapViewTools {
    @mcpTool({
        name: "View the map",
        description: [
            "Draw a window of the park as a text grid, so the SHAPE of the ground is something you",
            "read rather than work out from coordinates. It reports; it recommends nothing.",
            "Use it when you are siting something and need to see how much room is where.",
            "For what joins what, read `park_status`: a grid is the weaker way to answer that.",
            "Called with no arguments at all it draws a",
            String(DEFAULT_VIEW_SIZE) + "x" + String(DEFAULT_VIEW_SIZE),
            "square around the park's own gate.",
            "TO SEE A SITE AND ITS SURROUNDINGS, pass `fromX`, `fromY`, `toX` and `toY` copied",
            "straight off a site from `find_build_sites` - the same four names - and `margin` tiles",
            "of ground are drawn around them, " + String(DEFAULT_VIEW_MARGIN) + " unless you say otherwise.",
            "TO SEE AROUND A TILE, pass `x`, `y` and `size`: a square of `size` tiles centred there,",
            "the same form `clear_scenery` takes. Any tile another tool reported works - a ride's",
            "`x`,`y`, a door tile, the park gate.",
            "ONE CHARACTER IS ONE TILE and there are no gaps between them. A tile shows the first of",
            "these that applies to it: `G` the park's gate, `N` a ride's entrance building, `X` a",
            "ride's exit building, a lowercase letter for ride track - `rides` says which ride each",
            "letter is - `#` track belonging to a ride numbered past z, `Q` queue and `P` footpath on",
            "the park's land, `:` and `=` those same two on land it does not own,",
            "`%` something this map cannot name, `?` no surface could be read, `~` water, `-` not",
            "the park's land, `^` the park's but sloped, which nothing here levels, `*` the park's",
            "and flat with scenery on it, which `clear_scenery` takes down, and `.` the park's,",
            "flat and empty. So a tree on sloped ground reads as `^`: clearing it would not make",
            "that tile buildable, and a scenario's entrance corridor reads as `=`: guests walk it and",
            "the park can neither pave onto it nor usually buy it. The `legend` in each result explains",
            "every character that render actually used, and no character it did not.",
            "The rows above the grid give each column's `x`, one digit place per row, so a column's",
            "digits read downwards; each row is labelled with its `y` on the left.",
            "`area` is the ground drawn and `requested` the window asked for; they differ when the",
            "map's edge cut it down, and `clipped` is then true and `note` says so. `area` is a view",
            "box and not a ride's footprint: never hand it to `clear_scenery`, which would clear",
            "every tile in the picture.",
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
                fromX: { type: "integer", minimum: 0, description: "Rectangle form: the site's `fromX`. Tile x of one corner, included." },
                fromY: { type: "integer", minimum: 0, description: "Rectangle form: the site's `fromY`. Tile y of one corner, included." },
                toX: { type: "integer", minimum: 0, description: "Rectangle form: the site's `toX`. Tile x of the opposite corner, included." },
                toY: { type: "integer", minimum: 0, description: "Rectangle form: the site's `toY`. Tile y of the opposite corner, included." },
                margin: {
                    type: "integer",
                    minimum: 0,
                    maximum: MAX_VIEW_MARGIN,
                    description: "Rectangle form: extra tiles drawn on every side of it, 0 to "
                        + String(MAX_VIEW_MARGIN) + ". Default " + String(DEFAULT_VIEW_MARGIN)
                        + ". A ride's own ground tells you nothing about what it would sit next to."
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
        const area = areaFromArgs(args);

        if (isFailure(area)) {
            return area;
        }

        return renderMapView(area);
    }
}
