import { mcpTool, mcpToolController } from "./decorators.js";
import { findBuildSites } from "../park/sites.js";

@mcpToolController
export class SiteTools {
    @mcpTool({
        name: "Find build sites",
        description: [
            "Find where a particular flat ride will fit. Pass the ride's index from `list_ride_objects`",
            "and the tool works out its footprint for you, in both orientations.",
            "Each site gives the `x`, `y` and `rotation` to hand to `build_flat_ride`, plus `access`:",
            "every tile where an entrance or exit building fits, the `door` tile it opens onto, and that",
            "door's distance to the nearest footpath. Pick any two for the entrance and exit — putting both",
            "on the same side usually makes a shorter, straighter queue than opposite sides.",
            "`sceneryToClear` counts tiles holding trees: the site works, but run `clear_scenery` first.",
            "For a shop, `access` does not apply — it has no entrance or exit, and just needs a path beside it.",
            "Sites come back nearest-to-a-path first and cut to `limit`; `totalFound` says how many exist,",
            "so raise `limit` if you want to weigh somewhere further out."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                rideObject: { type: "integer", description: "Index from list_ride_objects." },
                rotation: { type: "integer", description: "Force one orientation, 0-3. Omit to see both." },
                limit: { type: "integer", description: "How many sites to return (default 3, max 50). Each one is sizeable, so ask for more only when you need the choice." }
            },
            required: ["rideObject"],
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
        const rideObject = typeof args.rideObject === "number" ? Math.floor(args.rideObject) : -1;
        const limit = typeof args.limit === "number" ? Math.floor(args.limit) : 3;
        const rotation = typeof args.rotation === "number" ? Math.floor(args.rotation) : undefined;

        return findBuildSites(rideObject, Math.max(1, Math.min(limit, 50)), rotation);
    }
}
