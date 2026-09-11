import { mcpTool, mcpToolController } from "./decorators.js";
import { centredSquare, clearRect, normaliseRect, rectTileCount } from "../park/clear.js";
import type { TileRect } from "../park/clear.js";
import type { DeferredMcpResult } from "./types.js";

/** The most ground one call will take, which is what a 16x16 square already came to. */
const MAX_TILES = 256;

interface ArgumentFailure {
    ok: false;
    error: string;
}

function isFailure(value: TileRect | ArgumentFailure): value is ArgumentFailure {
    return (value as ArgumentFailure).ok === false;
}

const SQUARE_ARGS = ["x", "y", "size"];
const RECT_ARGS = ["fromX", "fromY", "toX", "toY"];

function given(args: Record<string, unknown>, names: string[]): string[] {
    return names.filter(function (name) {
        return typeof args[name] === "number";
    });
}

/**
 * Which of the two forms was asked for, or what was missing or contradictory about it.
 *
 * The forms share no arguments, so which one a call means is never a judgement call, and
 * a site's four bounds are copied across field for field with nothing to work out on the
 * way. Half a form is refused rather than completed with a default: a `toX` without a
 * `toY` silently squared off would clear different ground from the ground that was named,
 * and clearing is destructive and costs money.
 */
function areaFromArgs(args: Record<string, unknown>): TileRect | ArgumentFailure {
    const square = given(args, SQUARE_ARGS);
    const rect = given(args, RECT_ARGS);

    if (square.length > 0 && rect.length > 0) {
        return {
            ok: false,
            error: "clear_scenery takes one form or the other, and this call mixes them: `"
                + square.join("`, `") + "` belong to the square form and `" + rect.join("`, `")
                + "` to the rectangle form. `x`/`y`/`size` is a square centred on x,y;"
                + " `fromX`/`fromY`/`toX`/`toY` is a rectangle between two corners. Drop one set."
        };
    }

    if (square.length === 0 && rect.length === 0) {
        return {
            ok: false,
            error: "clear_scenery needs one of its two forms and was given neither. For ordinary ground,"
                + " `x`, `y` and `size`: a square of `size` tiles centred on x,y. For a ride's ground,"
                + " `fromX`, `fromY`, `toX` and `toY`, copied straight off a site from find_build_sites."
        };
    }

    if (rect.length > 0) {
        const missing = RECT_ARGS.filter(function (name) {
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

        return normaliseRect({
            left: args.fromX as number,
            top: args.fromY as number,
            right: args.toX as number,
            bottom: args.toY as number
        });
    }

    const missing = SQUARE_ARGS.filter(function (name) {
        return square.indexOf(name) < 0;
    });

    if (missing.length > 0) {
        return {
            ok: false,
            error: "A square needs all three of `x`, `y` and `size`; `" + missing.join("`, `") + "` "
                + (missing.length === 1 ? "was" : "were") + " left out."
        };
    }

    return centredSquare(args.x as number, args.y as number, args.size as number);
}

@mcpToolController
export class ClearTools {
    @mcpTool({
        name: "Clear scenery",
        description: [
            "Remove trees, scenery, walls and banners from a patch of ground, so you can build there.",
            "There are two forms, they share no arguments, and a call uses exactly one of them.",
            "TO CLEAR A RIDE'S GROUND, pass `fromX`, `fromY`, `toX` and `toY` copied straight off the",
            "site from `find_build_sites`, which reports them under those four names. It clears that",
            "rectangle of tiles, both corners included. Take them from the site; do not work them out",
            "from the ride's size and do not use the site's `x`,`y`. `x`,`y` is the build origin: it sits",
            "inside the footprint without being a corner of it, because a footprint is not a centred",
            "square. A 4x4 ride runs from its origin to three tiles beyond it on each axis; a 1x4 runs",
            "from two tiles before its origin to one after; only a 3x3 is centred on it.",
            "TO CLEAR ORDINARY GROUND, such as room for a path, pass `x`, `y` and `size`: a square of",
            "`size` tiles centred on `x`,`y`.",
            "Rides, paths and park structures are never touched and are reported as still blocking.",
            "`area` in the result is the rectangle actually worked on, and `tilesStillBlocked` what is",
            "still standing on it, split into `tilesOccupied` - tiles a ride, a path or a park structure",
            "stands on - `tilesRefused`, tiles whose scenery the game would not take down, and",
            "`tilesOutsidePark`. `refusals` quotes the game's own reason for each refusal and",
            "`notEnoughCash` is true when one of them was the park being unable to pay.",
            "At most " + String(MAX_TILES) + " tiles in one call.",
            "Small and large scenery each cost their removal price to take down; walls are free and a",
            "banner refunds part of its price. Scenery within five tiles of a ride's station counts towards",
            "that ride's excitement rating, so clearing there lowers the ride's ratings and its `value`."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                x: { type: "integer", minimum: 0, description: "Square form: tile x of the centre. Needs y and size." },
                y: { type: "integer", minimum: 0, description: "Square form: tile y of the centre. Needs x and size." },
                size: { type: "integer", minimum: 1, maximum: 16, description: "Square form: width of the square in tiles, 1 to 16." },
                fromX: { type: "integer", minimum: 0, description: "Rectangle form: the site's `fromX`. Tile x of one corner, included." },
                fromY: { type: "integer", minimum: 0, description: "Rectangle form: the site's `fromY`. Tile y of one corner, included." },
                toX: { type: "integer", minimum: 0, description: "Rectangle form: the site's `toX`. Tile x of the opposite corner, included." },
                toY: { type: "integer", minimum: 0, description: "Rectangle form: the site's `toY`. Tile y of the opposite corner, included." }
            },
            additionalProperties: false
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false
        }
    })
    public clearScenery(args: Record<string, unknown>): DeferredMcpResult | ArgumentFailure {
        const area = areaFromArgs(args);

        if (isFailure(area)) {
            return area;
        }

        const tiles = rectTileCount(area);

        if (tiles > MAX_TILES) {
            return {
                ok: false,
                error: "That is " + String(area.right - area.left + 1) + " by " + String(area.bottom - area.top + 1)
                    + " tiles, " + String(tiles) + " in all; clear_scenery clears at most " + String(MAX_TILES)
                    + " in one call. Ask for a smaller rectangle, or clear it in parts."
            };
        }

        return {
            deferred: true,
            start: function (resolve) {
                clearRect(area, resolve);
            }
        };
    }
}
