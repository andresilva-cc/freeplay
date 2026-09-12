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
            "tiles where an entrance or exit building fits, the `door` tile it opens onto, and what that",
            "door would cost. Pick any two",
            "for the entrance and exit; two on the same `side` put both doors on one face of the ride.",
            "`access` is a window, not the whole list: it holds at most " + String(MAX_ACCESS_OPTIONS) + " options — the option",
            "nearest a path on each side first, then the rest by distance to a path — while `accessTotal` is how many positions the",
            "ride actually has. A tile counts as one only when it is owned, level, at the ride's own height and",
            "carrying nothing but scenery, and the tile its door opens onto is owned and carries nothing but",
            "scenery, a footpath, or a queue belonging to no ride.",
            "A door's `guestsCanReach` says whether a guest can walk to that tile from the park gate",
            "today — the same question `park_status` answers about a ride that is already built. `pathDistance`",
            "counts the tiles between the door and the nearest footpath the gate reaches that the park could",
            "also join onto — paving on its own land or touching it, so a scenario's entrance corridor, which",
            "the park can never pave up to, is not measured against at all. It counts straight rather than",
            "routed round what is in the way, so it is a lower bound; 0 means the door stands on such a path.",
            "A door whose `isExistingPath` is true while `guestsCanReach` is false stands on paving the",
            "gate reaches nothing of, and `island` then gives that fragment's tile count and corners —",
            "the same fragments `park_status` lists under `paths.islands`. A queue there joins paving no",
            "guest arrives on, so the ride takes nobody until the fragment itself is joined to the",
            "network; those doors are offered like any other.",
            "READ `cost` ON EVERY OPTION: one sentence giving that option's whole price — the path to lay,",
            "the tile the queue takes and what stands on it, and how many path tiles lose their route to the",
            "park entrance once a ride claims a queue there. It is those three numbers said together, and it",
            "settles their one inversion: `pathDistance` 0 on a shop's serving tile means guests already stand",
            "there, while 0 on a ride's door means the tile is not free, so the queue must take paving that is",
            "already carrying traffic. `queueCutsOff` is that last figure alone. Guests walk a queue like any",
            "other path, and what severs a route is a ride claiming one, which dead-ends the single tile its",
            "door opens onto. The list is not reordered by any of it — the ordering is distance to a path, and",
            "which door to use is yours to pick.",
            "A door whose `hasUnboundQueue` is true already has a queue on it belonging to no ride — what a",
            "demolished ride leaves behind. That is a finished queue, not an obstacle: placing the entrance",
            "chains it to the new ride and dead-ends that one tile. Doors carrying a queue that belongs to",
            "another ride are not offered at all, because building there would take that ride's queue away.",
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
            "-1 when the gate reaches no footpath at all that the park could join onto — none laid yet, none",
            "of it joined to the gate, or none of it on or beside the park's own land.",
            "`nearestRideDistance` is measured to the nearest tile carrying ride track or an entrance building,",
            "and the park's own gate is an entrance building, so in a park with a gate it is never -1: with no",
            "ride built yet it is the distance to the gate.",
            "For a shop, `access` holds exactly one tile: the neighbour guests are served from, which is",
            "fixed by the site's `rotation` (0 is -x, 1 is +y, 2 is +x, 3 is -y). A shop has no entrance,",
            "no exit and no `door` — put an ordinary path on that tile itself. Its `pathDistance` and",
            "`cost` are that serving tile's own.",
            "Sites come back nearest-that-network first and cut to `limit`. A site within the ride's longest",
            "side plus two tiles of one already in the list is skipped, so the list is distinct places rather",
            "than the same place listed over and over. `totalFound` counts every site found, before both the",
            "skip and the cut, so raising `limit` returns more of them but never all `totalFound`.",
            "`candidateExtent` measures that same whole set rather than the returned list: the two inclusive",
            "corners every site found spans together, and the smallest and largest `pathDistance` among them.",
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
                    description: "Search one rotation only, 0-3 and not wrapped, so 4 is refused rather than read"
                        + " as 0; omitted, the tool already searches every rotation that covers different ground -"
                        + " all four for a shop, whose rotation is which neighbour guests are served from rather"
                        + " than which tiles it covers."
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
