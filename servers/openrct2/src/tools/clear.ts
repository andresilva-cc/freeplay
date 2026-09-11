import { mcpTool, mcpToolController } from "./decorators.js";
import { clearArea } from "../park/clear.js";
import type { DeferredMcpResult } from "./types.js";

@mcpToolController
export class ClearTools {
    @mcpTool({
        name: "Clear scenery",
        description: [
            "Remove trees, scenery, walls and banners from a square of tiles, so you can build there.",
            "`x` and `y` are tile coordinates of the CENTRE, `size` the width in tiles.",
            "Rides, paths and park structures are never touched and are reported as still blocking.",
            "Clearing costs money and guests like scenery, so it is a trade, not free ground."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                x: { type: "integer", description: "Tile x of the centre." },
                y: { type: "integer", description: "Tile y of the centre." },
                size: { type: "integer", description: "Width of the square in tiles." }
            },
            required: ["x", "y", "size"],
            additionalProperties: false
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false
        }
    })
    public clearScenery(args: Record<string, unknown>): DeferredMcpResult {
        const number = function (value: unknown, fallback: number): number {
            return typeof value === "number" ? Math.floor(value) : fallback;
        };
        const x = number(args.x, -1);
        const y = number(args.y, -1);
        const size = Math.max(1, Math.min(number(args.size, 1), 16));

        return {
            deferred: true,
            start: function (resolve) {
                clearArea(x, y, size, resolve);
            }
        };
    }
}
