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
            "`access` is a window, not the whole list: it holds at most " + String(MAX_ACCESS_OPTIONS) + " options — the option",
            "nearest a path on each side first, then the rest by distance to a path — while `accessTotal` is how many positions the",
            "ride actually has. A tile counts as one only when it is owned, level, at the ride's own height and",
            "carrying nothing but scenery, and the tile its door opens onto is owned and carries nothing but",
            "scenery, a footpath, or a queue belonging to no ride.",
            "An access option's `queueCutsOff` counts the path tiles that stop being reachable from the",
            "park entrance once a queue reaches that `door`. A queue does not stop at the door: it is laid",
            "onto the footpath it joins, and guests cannot walk through a queue, so any number above 0",
            "means queueing there cuts that many tiles off the park. The list is not reordered by it —",
            "the ordering is distance to a path, and which door to use is yours to pick. A door whose",
            "`isExistingPath` is true already carries a footpath, so a queue there replaces it rather than",
            "extending the network, which is when `queueCutsOff` matters most. A door whose",
            "`hasUnboundQueue` is true already has a queue on it belonging to no ride — what a demolished",
            "ride leaves behind. That is a finished queue, not an obstacle: placing the entrance chains it",
            "to the new ride. Doors carrying a queue that belongs to another ride are not offered at all,",
            "because building there would take that ride's queue away.",
            "`fromX`, `fromY`, `toX` and `toY` are the ground the ride will stand on, as two inclusive",
            "corners. Pass all four to `clear_scenery` unchanged — they are its `fromX`, `fromY`, `toX`",
            "and `toY`. Never work the rectangle out from `x`, `y` and the ride's size: `x`,`y` is the",
            "build origin, which sits inside the footprint but is not a corner of it, so a square centred",
            "on it is the wrong ground for every footprint but a 3x3.",
            "The `ride` block's `width` and `depth` are the ride's size, for reference — they are not the",
            "ground to clear, and a rectangle worked out from them is the wrong ground.",
            "`sceneryToClear` counts trees inside that same rectangle, and an access option with",
            "`needsClearing` has one where its building or door would go. Either way the site works once",
            "`clear_scenery` has run.",
            "Any distance of -1 means there was nothing to measure against, never zero: `pathDistance` is",
            "-1 when the park has no footpath at all.",
            "`nearestRideDistance` is measured to the nearest tile carrying ride track or an entrance building,",
            "and the park's own gate is an entrance building, so in a park with a gate it is never -1: with no",
            "ride built yet it is the distance to the gate.",
            "For a shop, `access` holds exactly one tile: the neighbour guests are served from, which is",
            "fixed by the site's `rotation` (0 is -x, 1 is +y, 2 is +x, 3 is -y). A shop has no entrance,",
            "no exit and no `door` — put an ordinary path on that tile itself.",
            "Sites come back nearest-to-a-path first and cut to `limit`. A site within the ride's longest",
            "side plus two tiles of one already in the list is skipped, so the list is distinct places rather",
            "than the same place listed over and over. `totalFound` counts every site found, before both the",
            "skip and the cut, so raising `limit` returns more of them but never all `totalFound`.",
            "When nothing is found, `note` says which constraint nothing got past."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                rideObject: { type: "integer", minimum: 0, description: "The `index` field of an entry from list_ride_objects. This is the object's own index, not its position in that list." },
                rotation: {
                    type: "integer",
                    minimum: 0,
                    maximum: 3,
                    description: "Search one rotation only, 0-3. It is not wrapped, so 4 is refused rather than"
                        + " read as 0. Omitted, the tool searches every rotation that covers different ground, which"
                        + " is three different things: a square footprint is searched at 0 alone, because 1, 2 and 3"
                        + " put the same tiles under a different origin; a non-square footprint at 0 and 1, which"
                        + " covers every position it can occupy, with 2 and 3 the same tiles and the ride facing the"
                        + " other way; and a shop at all four, because a shop's rotation is not which tiles it covers"
                        + " but which neighbour guests are served from. So passing one narrows a ride's search to a"
                        + " facing, and a shop's to a serving side."
                },
                limit: { type: "integer", minimum: 1, maximum: 50, description: "How many sites to return (default 3, max 50). Each one is a sizeable object." }
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
