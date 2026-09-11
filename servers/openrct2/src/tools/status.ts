import { mcpTool, mcpToolController } from "./decorators.js";
import { listRideObjects, readGuestFeedback, readParkStatus } from "../park/status.js";

@mcpToolController
export class StatusTools {
    @mcpTool({
        name: "Park status",
        description: [
            "Everything the game would show you at a glance: the scenario objective and how far along it is,",
            "whether the park is open, the date, cash, loan, rating, guest count, entrance fee, net profit for",
            "the last four months, how many staff of each kind you have, and every ride with its status, price,",
            "ratings, `totalCustomers`, profit, queue time, breakdown record, and whether a queue is bound to",
            "its entrance. `guestsCanReach` is a separate fact from `hasQueue`: a queue can exist and still be",
            "an island, joined to the ride and to nothing else, in which case nobody ever boards. `exitConnected`",
            "says whether there is a way back out to the rest of the park.",
            "`entranceDoor` and `exitDoor` are the tiles those buildings open onto, one step out from",
            "`entrance` and `exit` themselves. A queue only serves a ride if it occupies `entranceDoor`,",
            "and a path only connects the exit if it reaches `exitDoor`: those are the tiles to aim",
            "build_path at, not the buildings.",
            "A ride with `isShop` true is a stall: no entrance, no exit and no queue, so `hasQueue`,",
            "`exitConnected`, `entranceDoor` and `exitDoor` are all null for it. A stall is served over",
            "the counter from ONE tile — its neighbour on the side it faces, reported as `counter` — so",
            "`guestsCanReach` means guests can walk to that tile. A path on any of its other three sides",
            "touches a wall and serves nobody: `counter` is the tile build_path has to reach for a stall",
            "with `guestsCanReach: false`.",
            "Money is in tenths of a currency unit: 1000 means 100.00. Ratings are fixed-point: 652 means 6.52.",
            "Each ride reports `value` next to `price`: that is roughly what a guest thinks the ride is worth.",
            "Price well above it and they walk past, which looks exactly like a ride nobody can reach —",
            "`totalCustomers` stays at 0 while the queue sits empty.",
            "`messages` is the game telling you what is wrong in its own words — unreachable rides, breakdowns,",
            "warnings about the park rating. It often names a problem outright.",
            "`paths` gives the park entrance tiles and the paths guests can reach from it: those are the",
            "targets a new path or queue has to join up with. `reachableSample` lists every reachable tile",
            "while `reachableSampleComplete` is true, so a tile that is not in it is not connected. Once the",
            "network outgrows the listing that flag turns false and `reachableSample` is a spread of it —",
            "`reachableTiles` is the real count either way, so compare the two before concluding that a",
            "tile is out of reach.",
            "`brokenDown` on a ride means it stays shut until a mechanic reaches it.",
            "It is cheaper than piecing the same picture together with evaluate."
        ].join(" "),
        inputSchema: { type: "object", additionalProperties: false },
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
            destructiveHint: false,
            openWorldHint: false
        }
    })
    public parkStatus() {
        return readParkStatus();
    }

    @mcpTool({
        name: "Guest feedback",
        description: [
            "What guests are thinking, counted over a sample of them, most common first.",
            "This is the game telling you what is wrong in its own words: whether they cannot find a ride,",
            "think a price is too high, are hungry, lost, or want to go home.",
            "`sampled` says how many guests the counts came from, against `guests` in the park —",
            "the counts are of that sample, not of everyone.",
            "Also gives average happiness out of 255 and average cash carried.",
            "This is the game's own account of why guests are unhappy."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                sample: {
                    type: "integer",
                    minimum: 1,
                    maximum: 500,
                    description: "How many guests to read (default 100, most 500)."
                }
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
    public guestFeedback(args: Record<string, unknown>) {
        const sample = typeof args.sample === "number" ? Math.floor(args.sample) : 100;
        return readGuestFeedback(Math.max(1, Math.min(sample, 500)));
    }

    @mcpTool({
        name: "List ride objects",
        description: [
            "Every ride and stall this scenario lets you build, with the index `find_build_sites` and",
            "`build_flat_ride` expect. `isFlatRide` true means it goes up in one action; false means it is a",
            "tracked ride that has to be built piece by piece with evaluate. `footprint` is its size in tiles.",
            "`count` is how many came back, `totalAvailable` how many exist before any filter."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                flatRidesOnly: { type: "boolean", description: "Only rides that can be built in one action." }
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
    public listRideObjects(args: Record<string, unknown>) {
        const all = listRideObjects();
        const objects = args.flatRidesOnly === true
            ? all.filter(function (object) { return object.isFlatRide; })
            : all;

        return { count: objects.length, totalAvailable: all.length, objects: objects };
    }
}
