import { mcpTool, mcpToolController } from "./decorators.js";
import { MAX_ACCESS_OPTIONS, findBuildSites } from "../park/sites.js";

@mcpToolController
export class SiteTools {
    @mcpTool({
        name: "Find build sites",
        description: [
            "Find where a particular flat ride will fit. Pass the `index` of a `list_ride_objects` entry",
            "and the tool works out its footprint for you and tries it every way round that covers",
            "different ground.",
            "Each site gives the `x`, `y` and `rotation` to hand to `build_flat_ride`, plus `access`:",
            "tiles where an entrance or exit building fits, the `door` tile it opens onto, and that",
            "door's distance to the nearest footpath. Pick any two for the entrance and exit; two on the",
            "same `side` put both doors on one face of the ride.",
            "`access` is a window, not the whole list: it holds at most " + String(MAX_ACCESS_OPTIONS) + " options — the best of each",
            "side first, then the rest by distance to a path — while `accessTotal` is how many positions the",
            "ride actually has. Any tile orthogonally touching the footprint works, listed or not.",
            "An access option's `queueCutsOff` counts the path tiles that stop being reachable from the",
            "park entrance once a queue reaches that `door`. A queue does not stop at the door: it is laid",
            "onto the footpath it joins, and guests cannot walk through a queue, so any number above 0",
            "means queueing there cuts that many tiles off the park. The list is not reordered by it —",
            "the ordering is distance to a path, and which door to use is yours to pick.",
            "`fromX`, `fromY`, `toX` and `toY` are the ground the ride will stand on, as two inclusive",
            "corners. Pass all four to `clear_scenery` unchanged — they are its `fromX`, `fromY`, `toX`",
            "and `toY`. Never work the rectangle out from `x`, `y` and the ride's size: `x`,`y` is the",
            "build origin, which sits inside the footprint but is not a corner of it, so a square centred",
            "on it is the wrong ground for every footprint but a 3x3.",
            "`sceneryToClear` counts trees inside that same rectangle, and an access option with",
            "`needsClearing` has one where its building or door would go. Either way the site works once",
            "`clear_scenery` has run.",
            "For a shop, `access` holds exactly one tile: the neighbour guests are served from, which is",
            "fixed by the site's `rotation` (0 is -x, 1 is +y, 2 is +x, 3 is -y). A shop has no entrance,",
            "no exit and no `door` — put an ordinary path on that tile itself.",
            "Sites come back nearest-to-a-path first and cut to `limit`; `totalFound` says how many exist,",
            "so raise `limit` if you want to weigh somewhere further out. When nothing is found, `note`",
            "says which constraint nothing got past."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                rideObject: { type: "integer", minimum: 0, description: "The `index` field of an entry from list_ride_objects. This is the object's own index, not its position in that list." },
                rotation: {
                    type: "integer",
                    minimum: 0,
                    maximum: 3,
                    description: "Search one rotation only, 0-3. Omitted, a ride is tried at 0 and 1, which"
                        + " covers every position its footprint can occupy — 2 and 3 cover the same tiles with the"
                        + " ride facing the other way. A shop is tried at all four, because its rotation is what"
                        + " decides which neighbour guests are served from."
                },
                limit: { type: "integer", minimum: 1, maximum: 50, description: "How many sites to return (default 3, max 50). Each one is sizeable, so ask for more only when you need the choice." }
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
