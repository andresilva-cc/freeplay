import { mcpTool, mcpToolController } from "./decorators.js";
import { listRideObjects, readGuestFeedback, readParkStatus } from "../park/status.js";

@mcpToolController
export class StatusTools {
    @mcpTool({
        name: "Park status",
        description: [
            "Everything the game would show you at a glance: the scenario objective and how far along it is,",
            "whether the park is open, the date, the weather, cash, loan, rating, guest count, entrance fee,",
            "the last four months of takings and costs stream by stream,",
            "how many staff of each kind you have, and every ride with its status, price,",
            "ratings, `totalCustomers`, profit, queue time, breakdown record, and whether a queue is bound to",
            "its entrance. `hasQueue` is throughput, not reachability: without one a ride boards one guest at",
            "a time; a bound queue lets several wait at once. `guestsCanReach` is separate: a queue can exist",
            "and still be an island, joined to the ride and to nothing else, in which case nobody ever boards.",
            "`exitConnected`",
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
            "`excitement`, `intensity`, `nausea` and `value` are null until the ride has been rated, which happens a",
            "little after it opens with guests able to reach it. Null there is the game saying it has not",
            "measured the ride yet, which is a different thing from a ride it has measured and scored low.",
            "`nausea` is the third rating the game works out and shows alongside the other two: it is what",
            "leaves guests looking for a bin or a toilet, and the mess after that is a handyman's work.",
            "`monthlyProfit` is net profit for the last four months, index 0 being this month, and",
            "`monthlyExpenditure` breaks those same four months into the game's fourteen expenditure streams",
            "under the game's own names — `wages`, `ride_runningcosts`, `park_ride_tickets`, `shop_sales`,",
            "`land_purchase` and the rest — signed the way the game signs them, takings positive and costs",
            "negative, four months each with index 0 this month. The fourteen add up to `monthlyProfit` month",
            "by month, which is the whole of what the total says: a park bleeding wages and a park bleeding",
            "ride upkeep read as one number there and want different things done about them. These are the",
            "lines of the game's own Finances window.",
            "`weather` is the toolbar: `climate` is the weather pattern the scenario runs on, `current` is",
            "what the sky is doing now — `sunny`, `partiallyCloudy`, `cloudy`, `rain`, `heavyRain`, `thunder`,",
            "`snow`, `heavySnow`, `blizzard` — with the game's own temperature beside it, and `next` is the",
            "game's own forecast of what comes after that. Rain is not decoration in OpenRCT2: guests shelter,",
            "buy umbrellas, stop boarding unsheltered rides and go home, and every bit of that arrives here as",
            "takings and a guest count moving for a reason no other field names.",
            "Each ride reports `value` next to `price`: that is roughly what a guest thinks the ride is worth.",
            "Price well above it and they walk past, which looks exactly like a ride nobody can reach —",
            "`totalCustomers` stays at 0 while the queue sits empty.",
            "`messages` is the game telling you what is wrong in its own words — unreachable rides, breakdowns,",
            "warnings about the park rating. It often names a problem outright. Each carries `gameDaysAgo`,",
            "whole game days since the day it arrived, 0 being today: the list is the last dozen the game raised",
            "and holds messages from months apart. Nothing is dropped, reordered or marked by that number.",
            "`paths` measures the walkable network instead of listing it. `gate` is the park's own entrance",
            "tiles and `reachableTiles` how many path tiles guests can walk to from them. `runs` is every one",
            "of those tiles, as straight lines: an `index`, `fromX`,`fromY` to `toX`,`toY` with both ends",
            "included, a `tiles` count, a `kind` of `path` or `queue`, and a queue's bound `ride`. Each",
            "reachable tile is on exactly one run, so the `tiles` add up to `reachableTiles` and a tile is",
            "reachable exactly when a run covers it. A run is a straight line and NOT a separate network:",
            "`touches` is the `index` of every run a guest can step onto from this one, so two runs whose",
            "`touches` name each other are joined, and tiles on them are connected however far apart the two",
            "sit in the list. `deadEnds` are tiles with one way off them or none, the gate counting as a way",
            "off. A run's `cutsIfBlocked` is how many OTHER tiles stop being reachable when one tile of it",
            "stops carrying traffic, which is what a ride's entrance claiming a queue there does; the claimed",
            "tile itself is not counted and 0 means there is a way round. `severingComputed` false means that was not worked",
            "out at all, which is not the same as nothing severing. `islands` are stretches of path the gate reaches none of,",
            "each as its own straight `runs` in the same four names, with the `rides` and the ride `doors`",
            "standing on them: a door there belongs to a ride that is built and that no guest can walk to.",
            // What `clear_scenery` takes down and that nothing here levels sloped ground are both
            // stated by the tools that do those jobs, and by the prompt. Only the categories are here.
            "`ground` counts owned land per map-aligned block of `block` tiles a side: `clear` is flat and",
            "empty, `scenery` flat with something standing on it, `sloped` not flat, then `water`, `path`",
            "and `built`. The six add up to `owned`, and ground the park does not own is not counted.",
            "`speed` and `paused` are the two values `set_game_speed` sets. `paused` true means a pause you",
            "asked for is in force and is refusing map changes and refusing `wait` until you unpause it;",
            "it is NOT the clock being stopped between your calls, which is how this bridge always runs and",
            "which every tool acts through. `speed` changes only how much REAL time a `wait` costs and never",
            "how much of the scenario a run spends.",
            "`clockHeldBy` says who is holding the clock still, which `paused` cannot: `nobody` means the",
            "game is running, `you` means the pause you set with `set_game_speed` — the one `paused` reports —",
            "`bridge` means the hold this bridge keeps between your calls, which your calls act through, and",
            "`unknown` means the game is paused by something this bridge neither set nor was told about, which",
            "refuses actions the same way and which `set_game_speed {paused: false}` is your lever on.",
            "A pause set in the game window reads as `bridge`: the hold claims it, acts through it the same",
            "way, and nothing in the game says who set it, so that is not a distinction this can draw.",
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
            "What guests are thinking, counted over the guests this call read.",
            "This is the game telling you what is wrong in its own words: whether they cannot find a ride,",
            "think a price is too high, are hungry, lost, or want to go home.",
            "`thoughts` comes back in the game's own thought enumeration order. That order is arbitrary with",
            "respect to your park: it is NOT by count, NOT by severity and NOT by anything else, because which",
            "complaint is worth acting on is yours to weigh and the game keeps no such ranking of its own.",
            "`count` is how many thought slots of that kind were read — slots, not guests, so one guest",
            "carrying two thoughts lands in two counts.",
            "`freshness` is the game's own field on those same slots, counted per value: each key is a number",
            "the game held and each value is how many slots carried it, so those add up to `count`.",
            "OpenRCT2 documents it as one thing only: the larger the number, the less",
            "fresh the thought. Nothing is dropped or discounted by it, so a complaint the game answered weeks",
            "ago is still in its count until the game itself lets go of it, and these numbers are what you have",
            "to tell the two apart.",
            "`guestsRead` says how many guests every count and average came from, against `guests` in the park.",
            "It walks the game's guest list from the front and stops there, so it is not a random sample: it is",
            "the same end of the same list on every call, and the counts carry whatever that end has in common.",
            "Raise `sample` to read more of them.",
            "Also gives average happiness out of 255 and average cash carried, both over the guests read.",
            "This is the game's own account of why guests are unhappy."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                sample: {
                    type: "integer",
                    minimum: 1,
                    maximum: 500,
                    description: "How many guests to read, taken off the front of the game's own guest list (default 100, most 500)."
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
            "Every ride and stall this scenario has loaded, with the index `describe_placement` and",
            "`build_flat_ride` expect. `isFlatRide` true means it goes up in one action; false means it is a",
            "tracked ride that has to be built piece by piece with evaluate. `footprint` is its size in tiles.",
            "`researched` false means the scenario still has it behind research and has not announced it as",
            "available yet; locked ones are listed all the same and nothing is filtered out.",
            "`count` is how many came back, `researchedCount` how many of those are researched,",
            "`totalLoaded` how many exist before any filter."
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

        // `totalAvailable` was this figure's name until research was read: a scenario loads
        // every object it may ever offer, so the count of loaded objects is not the count of
        // available ones and calling it that was the same unread-claim defect as the list.
        return {
            count: objects.length,
            researchedCount: objects.filter(function (object) { return object.researched; }).length,
            totalLoaded: all.length,
            objects: objects
        };
    }
}
