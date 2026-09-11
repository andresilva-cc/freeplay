import { mcpTool, mcpToolController } from "./decorators.js";
import { findBuildSites } from "../park/sites.js";

@mcpToolController
export class SiteTools {
    @mcpTool({
        name: "Find build sites",
        description: [
            "Find where a particular flat ride will fit. Pass the ride's index from `list_ride_objects`",
            "and the tool works out its footprint for you, trying it lengthways and crossways.",
            "Each site gives the `x`, `y` and `rotation` to hand to `build_flat_ride`, plus `access`:",
            "every tile where an entrance or exit building fits, the `door` tile it opens onto, and that",
            "door's distance to the nearest footpath. Pick any two for the entrance and exit — putting both",
            "on the same side usually makes a shorter, straighter queue than opposite sides.",
            "`sceneryToClear` counts trees on the footprint, and an access option with `needsClearing` has one",
            "where its building or door would go. Either way the site works once `clear_scenery` has run.",
            "For a shop, `access` does not apply — it has no entrance or exit, and just needs a path beside it.",
            "Sites come back nearest-to-a-path first and cut to `limit`; `totalFound` says how many exist,",
            "so raise `limit` if you want to weigh somewhere further out."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                rideObject: { type: "integer", description: "Index from list_ride_objects." },
                rotation: { type: "integer", description: "Search one rotation only, 0-3. Omitted, it tries 0 and 1, which covers every position a footprint can occupy — but 2 and 3 face the ride the other way, which matters for rides with a front." },
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
