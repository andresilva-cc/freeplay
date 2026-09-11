import { mcpTool, mcpToolController } from "./decorators.js";
import { buyLand, buyLandRefusal } from "../park/land.js";
import { rectTileCount } from "../park/clear.js";
import type { TileRect } from "../park/clear.js";
import type { DeferredMcpResult } from "./types.js";

/** The most ground one purchase will take, which is the same ceiling `clear_scenery` uses. */
const MAX_TILES = 256;

const RECT_ARGS = ["fromX", "fromY", "toX", "toY"];

/** An argument refusal in the same shape buyLand answers with, so there is one shape. */
function refuse(detail: string, area: TileRect): DeferredMcpResult {
    return {
        deferred: true,
        start: function (resolve) {
            resolve(buyLandRefusal(detail, area));
        }
    };
}

@mcpToolController
export class LandTools {
    @mcpTool({
        name: "Buy land",
        description: [
            "Buy the land rights to a rectangle of tiles, bringing them inside the park.",
            "Pass `fromX`, `fromY`, `toX` and `toY`: two opposite corners in tile coordinates, both included -",
            "the same four names a `find_build_sites` site reports its bounds under, so a site's bounds copy",
            "straight across.",
            "Only tiles the scenario has put up for sale can be bought. Tiles the park already owns cost nothing",
            "and are skipped, and tiles that are not for sale are left alone rather than failing the call, so a",
            "rectangle that is half for sale buys the half that is. If the park cannot afford the whole",
            "rectangle the game refuses all of it rather than part of it.",
            "Land cannot be sold back, and a tile the scenario is not selling cannot be made buyable: the game",
            "refuses both of those outside the scenario editor, however they are asked for.",
            "No typed tool levels ground. Buying a sloped tile makes it the park's without flattening it, and",
            "rides and paths still need level ground; the game's own terrain actions are reachable only",
            "through `evaluate`.",
            "The result reports the ground as the map reads back afterwards - `tilesOwned` of those asked for,",
            "`tilesBought`, and `notOwned` naming the tiles the park still does not have - along with `cost`,",
            "which is what the game charged, and `landPrice`, what one tile costs in this scenario.",
            "`ok: true` means the park owns every tile asked for.",
            "At most " + String(MAX_TILES) + " tiles in one call.",
            "Whether the land is worth buying is your decision."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                fromX: { type: "integer", minimum: 0, description: "Tile x of one corner, included. A site's `fromX`." },
                fromY: { type: "integer", minimum: 0, description: "Tile y of one corner, included. A site's `fromY`." },
                toX: { type: "integer", minimum: 0, description: "Tile x of the opposite corner, included. A site's `toX`." },
                toY: { type: "integer", minimum: 0, description: "Tile y of the opposite corner, included. A site's `toY`." }
            },
            required: ["fromX", "fromY", "toX", "toY"],
            additionalProperties: false
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
        }
    })
    public buyLand(args: Record<string, unknown>): DeferredMcpResult {
        const missing = RECT_ARGS.filter(function (name) {
            return typeof args[name] !== "number";
        });

        if (missing.length > 0) {
            return refuse("buy_land needs all four corners: `" + missing.join("`, `") + "` "
                + (missing.length === 1 ? "was" : "were") + " left out. Give `fromX`, `fromY`, `toX` and"
                + " `toY` together, copied off a site from find_build_sites, which reports all four under"
                + " those names. Nothing was bought.", { left: 0, top: 0, right: 0, bottom: 0 });
        }

        // Left as the caller gave it: `buyLand` puts the corners the right way round, and
        // `rectTileCount` counts either way, so doing it here too would be a second copy of
        // the same rule that nothing could ever catch drifting.
        const area = {
            left: Math.floor(args.fromX as number),
            top: Math.floor(args.fromY as number),
            right: Math.floor(args.toX as number),
            bottom: Math.floor(args.toY as number)
        };
        const tiles = rectTileCount(area);

        if (tiles > MAX_TILES) {
            return refuse("That is " + String(Math.abs(area.right - area.left) + 1) + " by "
                + String(Math.abs(area.bottom - area.top) + 1) + " tiles, " + String(tiles) + " in all; buy_land buys"
                + " at most " + String(MAX_TILES) + " in one call. Ask for a smaller rectangle, or buy it in"
                + " parts. Nothing was bought.", area);
        }

        return {
            deferred: true,
            start: function (resolve) {
                buyLand(area, resolve);
            }
        };
    }
}
