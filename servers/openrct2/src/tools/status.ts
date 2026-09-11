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
            "ratings, customers, profit, queue time, breakdown record, and whether a queue is actually bound to",
            "its entrance. The one to act on is `guestsCanReach`: a queue can exist and still be an island,",
            "joined to the ride and to nothing else, in which case nobody ever boards. `exitConnected` says",
            "whether there is a way back out to the rest of the park.",
            "Money is in tenths of a currency unit: 1000 means 100.00. Ratings are fixed-point: 652 means 6.52.",
            "Each ride reports `value` next to `price`: that is roughly what a guest thinks the ride is worth.",
            "Price well above it and they walk past, which looks exactly like a ride nobody can reach —",
            "customers stay at 0 while the queue sits empty.",
            "`messages` is the game telling you what is wrong in its own words — unreachable rides, breakdowns,",
            "warnings about the park rating. It often names a problem outright.",
            "`paths` gives the park entrance tiles and a sample of the paths guests can reach from it:",
            "those are the targets a new path or queue has to join up with.",
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
                sample: { type: "integer", description: "How many guests to read (default 100)." }
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
            "tracked ride that has to be built piece by piece with evaluate. `footprint` is its size in tiles."
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

        return { count: objects.length, objects: objects };
    }
}
