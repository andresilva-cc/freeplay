import { mcpTool, mcpToolController } from "./decorators.js";
import { describePlacement } from "../park/sites.js";

@mcpToolController
export class SiteTools {
    @mcpTool({
        name: "Describe a placement",
        description: [
            "Say what would happen if a particular flat ride went up at a particular tile, facing a",
            "particular way. It describes the placement you name and nothing else: it looks for no",
            "site, ranks nothing, and offers no alternative. Where a ride goes is read off `view_map`,",
            "`park_status`'s ground census and `park_status`'s paths.",
            "`x` and `y` are the build origin and `rotation` is which way round — the same three values",
            "`build_flat_ride` takes, so a placement that reads well is copied across unchanged.",
            "THE ORIGIN IS NOT THE CENTRE AND NOT A CORNER. A ride's tiles are laid out around it by",
            "the game, and the layout is not a formula: a 4x4 runs 0..3 from the origin, a 1x4 runs",
            "-2..+1, and only a 3x3 is centred on it. `footprint` is the ground the ride would really",
            "stand on, as two inclusive corners — `fromX`, `fromY`, `toX` and `toY`, which are",
            "`clear_scenery`'s four arguments under the same names. Never work that rectangle out from",
            "`x`, `y` and the ride's size: a square centred on the origin is the wrong ground for every",
            "footprint but a 3x3, and `ride.width`/`ride.depth` are the ride's size for reference, not",
            "the ground to clear.",
            "`ride.researched` false means the scenario still has this ride behind research and has not",
            "announced it as available yet. It is reported, not enforced: the placement is described",
            "either way.",
            "`fits` is whether every tile of that footprint is the park's, dry, level, at the ride's height",
            "and carrying nothing but scenery; `blockers` names each tile that is not and says which of",
            "those it fails. `z` is the height the ride would stand at, which is the origin tile's own",
            "ground — the same tile `build_flat_ride` reads it from, so a tile at a different height is",
            "one the build refuses too. `sceneryToClear` counts trees inside the footprint: scenery is",
            "not counted against `fits`, and it is in the way of the build all the same.",
            "READ `ground`: one sentence giving the whole state of the footprint — how much of it takes",
            "the ride, what stops the rest, and what is standing on it.",
            "`access` is the tiles an entrance or exit building could go on for this placement, with",
            "the `door` tile each opens onto and what that door would cost. A ride needs TWO, one for",
            "the entrance and one for the exit; pick any two, and two sharing a `side` put both doors on",
            "one face. The list is a clockwise walk of the tiles round the footprint, starting on its -y",
            "side: consecutive entries are next to each other on the ground except at the four corners, where",
            "the walk turns and the step is diagonal. It is ordered by nothing else — not sorted, not marked,",
            "and the first entry is first only because a walk has to start somewhere, which is a fact about",
            "this list and not about your park. Which door to use is yours to pick.",
            "IT IS FILTERED, AND IT SAYS SO. `accessTotal` is how many door positions the footprint has",
            "at all - a 4x4 has 16 - and `accessRuledOut` is why the rest are missing, by cause and",
            "count, with the same sentence in `note`. A tile is in the list only when it is owned, dry,",
            "level, at the ride's own height and carrying nothing but scenery, and the tile its door",
            "opens onto is owned, dry and carries nothing but scenery, a footpath, or a queue.",
            "READ `cost` ON EVERY OPTION: one sentence giving that option's whole price — the path to",
            "lay, the tile the queue takes and what stands on it, and how many path tiles lose their",
            "route to the park entrance once a ride claims a queue there. It is those three numbers said",
            "together, and it settles their one inversion: `pathDistance` 0 on a shop's serving tile",
            "means guests already stand there, while 0 on a ride's door means the tile is not free, so",
            "the queue must take paving that is already carrying traffic. `queueCutsOff` is that last",
            "figure alone. Guests walk a queue like any other path, and what severs a route is a ride",
            "claiming one, which dead-ends the single tile its door opens onto.",
            "A door's `guestsCanReach` says whether a guest can walk to that tile from the park gate",
            "today — the same question `park_status` answers about a ride that is already built.",
            "`pathDistance` counts the tiles between the door and the nearest footpath the gate reaches",
            "that the park could also join onto — paving on its own land or touching it, so a scenario's",
            "entrance corridor, which the park can never pave up to, is not measured against at all. It",
            "counts straight rather than routed round what is in the way, so it is a lower bound; 0",
            "means the door stands on such a path.",
            "A door whose `isExistingPath` is true while `guestsCanReach` is false stands on paving the",
            "gate reaches nothing of, and `island` then gives that fragment's tile count and corners —",
            "the same fragments `park_status` lists under `paths.islands`. A queue there joins paving no",
            "guest arrives on, so the ride takes nobody until the fragment itself is joined to the",
            "network; those doors are listed like any other.",
            "A door whose `hasUnboundQueue` is true already has a queue on it belonging to no ride — what",
            "a demolished ride leaves behind. That is a finished queue, not an obstacle: placing the",
            "entrance chains it to the new ride and dead-ends that one tile.",
            "A door whose `queueServesRide` is set carries a queue that belongs to ANOTHER ride, named by",
            "id and by `queueServesRideName`. The game allows a door there and re-chains the queue to the",
            "new ride, which leaves that one with no queue at its own entrance until another is laid, so",
            "guests stop boarding it. It is listed like any other option, `cost` says what it costs, and",
            "`build_flat_ride` reports every ride that actually lost a queue under `ridesLeftWithoutQueue`.",
            "Whether one ride's queue is worth spending on another is yours.",
            "An access option with `needsClearing` has scenery where its building or its door would go.",
            "Either way the placement works once `clear_scenery` has run.",
            "Any distance of -1 means there was nothing to measure against, never zero: `pathDistance`",
            "is -1 when the gate reaches no footpath at all that the park could join onto — none laid",
            "yet, none of it joined to the gate, or none of it on or beside the park's own land.",
            "`nearestRideDistance` is measured from the origin to the nearest tile carrying ride track",
            "or an entrance building, and the park's own gate is an entrance building, so in a park with",
            "a gate it is never -1: with no ride built yet it is the distance to the gate.",
            "For a shop, `access` holds exactly one tile: the neighbour guests are served from, which is",
            "fixed by the `rotation` you asked about (0 is -x, 1 is +y, 2 is +x, 3 is -y). A shop has no",
            "entrance, no exit and no `door` — put an ordinary path on that tile itself. Its",
            "`pathDistance` and `cost` are that serving tile's own.",
            "`ok: false` means the question could not be asked at all — no such ride object, a ride built",
            "from track, a rotation outside 0-3, or a tile off the map. A placement that simply does not",
            "work is `ok: true` with `fits` false, and `blockers` and `ground` say why."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                rideObject: { type: "integer", minimum: 0, description: "The `index` field of an entry from list_ride_objects. This is the object's own index, not its position in that list." },
                x: { type: "integer", minimum: 0, description: "Tile x of the build origin — the tile you are asking about, and the one `build_flat_ride` takes as its `x`. It ends up inside the ride's footprint without being its centre or a corner of it, so the ground the ride covers is the `footprint` this reports back." },
                y: { type: "integer", minimum: 0, description: "Tile y of the build origin. Same rule as `x`: it is not the centre of anything." },
                rotation: {
                    type: "integer",
                    minimum: 0,
                    maximum: 3,
                    description: "Which way the ride faces, 0-3, and not wrapped, so 4 is refused rather than"
                        + " read as 0. There is no default: which way round a ride stands is part of the"
                        + " placement, and for a shop it is the whole of it — a shop covers one tile at every"
                        + " rotation, and the rotation is which neighbour guests are served from."
                }
            },
            required: ["rideObject", "x", "y", "rotation"],
            additionalProperties: false
        },
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
            destructiveHint: false,
            openWorldHint: false
        }
    })
    public describePlacement(args: Record<string, unknown>) {
        const rideObject = typeof args.rideObject === "number" ? Math.floor(args.rideObject) : -1;
        const x = typeof args.x === "number" ? Math.floor(args.x) : -1;
        const y = typeof args.y === "number" ? Math.floor(args.y) : -1;
        // Not clamped and not defaulted. The schema refuses anything outside 0-3 before the
        // handler runs, and a missing rotation reaches describePlacement as -1, which it
        // refuses by name: filling one in here would be this tool choosing which way the
        // ride faces, which is the decision it exists not to make.
        const rotation = typeof args.rotation === "number" ? Math.floor(args.rotation) : -1;

        return describePlacement(rideObject, x, y, rotation);
    }
}
