import { mcpTool, mcpToolController } from "./decorators.js";
import { removePath, removePathRefusal } from "../park/pathremove.js";
import type { DeferredMcpResult } from "./types.js";

/** An argument refusal in the same shape removePath answers with, so there is one shape. */
function refuse(detail: string): DeferredMcpResult {
    return {
        deferred: true,
        start: function (resolve) {
            resolve(removePathRefusal(detail));
        }
    };
}

@mcpToolController
export class PathRemoveTools {
    @mcpTool({
        name: "Remove a path",
        description: [
            "Take the footpath or queue off the tiles you name. The addressing is `build_path`'s and the",
            "field is the same one: `tiles`, the literal list of tiles, with nothing routed and nothing",
            "filled in between them. To take back exactly what a `build_path` call laid, pass the `tiles`",
            "it returned straight here.",
            "Tiles in the run with no footpath on them are left alone and counted; this is the only way to",
            "remove one. An ordinary path laid over a queue unbinds that queue from its ride, and a ride's",
            "entrance claiming a queue, not the queue itself, dead-ends the tile its door opens onto and cuts",
            "off whatever lay past it.",
            "Ride entrances, ride exits and the park gate are not footpaths: a run that names one is refused by",
            "name and nothing is removed. A ride itself goes with `operate_ride` `demolish`.",
            "The result reports what the map says afterwards: `tilesRemoved` counted by re-reading each tile,",
            "`reachableFromEntrance` — how many path tiles guests can walk to from the park entrance now — and",
            "`ridesLeftWithoutQueue`, any ride whose bound queue went with the path.",
            "On a refusal nothing is measured, so `reachableFromEntrance` is `null` rather than a number:",
            "it is not a report that the park has been cut off.",
            "`ok: true` means every tile named now carries no footpath, which is also true of a run that never",
            "had one; `tilesRemoved` is what actually came up.",
            "Every result has the same shape, including refusals, where `detail` says what was wrong.",
            "Which tiles to take up is your decision — this only handles the removal."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                tiles: {
                    type: "array",
                    description: "Every tile to take the footpath off, each an object with integer `x` and `y`. A build_path result's `tiles` can be passed here whole. At least one.",
                    minItems: 1,
                    items: {
                        type: "object",
                        description: "One tile, in tile coordinates.",
                        properties: {
                            x: { type: "integer", minimum: 0, description: "Tile x." },
                            y: { type: "integer", minimum: 0, description: "Tile y." }
                        },
                        required: ["x", "y"],
                        additionalProperties: false
                    }
                }
            },
            required: ["tiles"],
            additionalProperties: false
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false
        }
    })
    public removePath(args: Record<string, unknown>): DeferredMcpResult {
        const tiles: { x: number; y: number }[] = [];

        if (!Array.isArray(args.tiles)) {
            return refuse("`tiles` is missing. remove_path takes the footpath off the tiles you name, so"
                + " it needs the list: `tiles` is an array of objects with integer `x` and `y`, and a"
                + " build_path result's own `tiles` can be passed here whole. Nothing was removed.");
        }

        const given = args.tiles as { x?: unknown; y?: unknown }[];

        for (let i = 0; i < given.length; i++) {
            const tile = given[i];

            // Coercing a malformed tile to -1 would quietly run the removal off the map.
            if (!tile || typeof tile.x !== "number" || typeof tile.y !== "number") {
                return refuse("tiles[" + String(i) + "] needs a numeric x and y.");
            }

            tiles.push({ x: Math.floor(tile.x), y: Math.floor(tile.y) });
        }

        const request = { tiles: tiles };

        return {
            deferred: true,
            start: function (resolve) {
                removePath(request, resolve);
            }
        };
    }
}
