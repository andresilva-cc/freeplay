import { mcpTool, mcpToolController } from "./decorators.js";
import { findBuildSites } from "../park/sites.js";

@mcpToolController
export class SiteTools {
    @mcpTool({
        name: "Find build sites",
        description: [
            "List places a flat ride of the given footprint can be built: owned, level and unobstructed.",
            "Coordinates are tile coordinates; `x` and `y` are the CENTRE of the footprint.",
            "Each site lists every `access` option — a tile where an entrance or exit building fits, the `door`",
            "tile it opens onto, and that door's distance to the nearest existing footpath.",
            "Pick any two for the entrance and exit. They may share a side, which usually makes for a shorter",
            "queue than opposite sides. `pathDistance` is the best of those options; a ride guests cannot walk",
            "to earns nothing, so sites far from a path cost you a long path to connect them."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                size: { type: "integer", description: "Footprint in tiles: 1, 2, 3 or 4. Most flat rides are 3." },
                limit: { type: "integer", description: "How many sites to return (default 10)." }
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
    public findBuildSites(args: Record<string, unknown>) {
        const size = typeof args.size === "number" ? Math.floor(args.size) : 3;
        const limit = typeof args.limit === "number" ? Math.floor(args.limit) : 10;

        if (size < 1 || size > 4) {
            return { ok: false, error: "size must be 1, 2, 3 or 4." };
        }

        return {
            ok: true,
            size: size,
            sites: findBuildSites(size, Math.max(1, Math.min(limit, 50)))
        };
    }
}
