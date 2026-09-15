import { mcpTool, mcpToolController } from "./decorators.js";
import { buildFlatRide } from "../park/build.js";
import type { BuildOutcome } from "../park/build.js";
import type { DeferredMcpResult } from "./types.js";

const DOOR_FIELDS = ["entranceX", "entranceY", "exitX", "exitY"];
/**
 * Kept in step with operate_ride, which bounds the same two values, and there for the same
 * reason: the price is in tenths, and 2000 is 100.00 a ride. It is a units guard, not a view
 * on what a ticket is worth - a guest's `value` runs in the tens, so nothing inside the bound
 * is a price the model might have wanted and been refused, while a currency unit sent as if
 * it were tenths is the mistake that costs a turn and reads as a mechanic nobody explained.
 */
const MAX_PRICE = 2000;
const MAX_INSPECTION_INTERVAL = 6;
/**
 * OpenRCT2's own interval for a newly built ride - every 30 minutes. Unlike `price`, which
 * is required because defaulting an economic decision makes it, sending this is what a
 * player who never opens the ride's inspection dropdown already gets. Changing it to
 * anything else would be the choice.
 */
const DEFAULT_INSPECTION_INTERVAL = 2;
const MAX_COLOUR = 30;
const MAX_ROTATION = 3;

/**
 * An argument refusal in the same shape as every other outcome, so a caller never has to
 * work out which of two payloads it is holding.
 */
function refuseArguments(detail: string): DeferredMcpResult {
    const outcome: BuildOutcome = {
        ok: false,
        rideId: null,
        rideName: null,
        doorsAttached: null,
        status: null,
        open: false,
        reachable: false,
        ridesLeftWithoutQueue: [],
        steps: [{ step: "arguments", ok: false, detail: detail }]
    };

    return {
        deferred: true,
        start: function (resolve) {
            resolve(outcome);
        }
    };
}

@mcpToolController
export class BuildTools {
    @mcpTool({
        name: "Build a flat ride",
        description: [
            "Create a flat ride, place it on the ground, attach an entrance and an exit, set the price and open it.",
            "`x`, `y` and `rotation` are the placement: which tile the ride is laid from and which way round. The",
            "footprint is worked out from the ride itself, so there is no size to get wrong, and",
            "`describe_placement` is what says whether the ground takes it before anything is paid for.",
            "Shops and stalls have no entrance or exit: leave all four door arguments out. A stall is served from",
            "one tile only — the neighbour on the side it faces, decided by `rotation` — so that is where its path",
            "goes. `describe_placement` reports that one serving tile for a stall and no `access` doors at all,",
            "for the same reason.",
            "For everything else you choose where the doors go with `entranceX`/`entranceY` and `exitX`/`exitY`, from the",
            "`access` options `describe_placement` reports for this same origin and rotation. Each carries a",
            "`side`, so two with the same `side` put both doors on one face.",
            "All four go together: give one and you must give all four.",
            "It builds no paths: the queue and the walk away from the exit are `build_path`.",
            "`ok` means the ride EXISTS with its track on the ground — nothing more. `doorsAttached`, `open`",
            "and `reachable` are separate fields and carry the rest. `status` is the game's own word for",
            "the ride — closed, open, testing or simulating, as the ride reads back after the build — and",
            "`open` is that word being \"open\".",
            "`ok: true` with any of those false is a ride you already own, and",
            "calling this again builds and pays for a second one.",
            "`reachable` is false straight after building until the queue and the exit path are laid.",
            "`ridesLeftWithoutQueue` names any ride that had a queue bound to it before this call and has",
            "none after, read off the map afterwards. A door placed on a tile already carrying another",
            "ride's queue is allowed and re-chains that queue to this ride; the build does not refuse it,",
            "and this is what it cost.",
            "The only build that leaves nothing behind is `ok: false`; anything else means a ride is standing, and",
            "`operate_ride` with `demolish` is how it goes away.",
            "A pause YOU set with `set_game_speed` refuses the track and door actions, so this builds nothing",
            "and refuses through one: the ride record `ridecreate` would leave behind has no track and cannot",
            "be demolished until you unpause. The clock being stopped between your calls is a different thing",
            "and builds go through it — `park_status` tells the two apart as `clockHeldBy`, which reads",
            "`you` for the pause you set and `bridge` for the hold.",
            "This does not build roller coasters; those need track laid piece by piece with `evaluate`."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                rideObject: { type: "integer", minimum: 0, description: "The `index` field of an entry from list_ride_objects. This is the object's own index, not its position in that list." },
                x: { type: "integer", minimum: 0, description: "Tile x of the build origin - the tile you are laying the ride from, and the `x` you asked describe_placement about. The origin ends up inside the footprint but it is NOT its centre and NOT a corner: a 4x4 runs 0..3 from it, a 1x4 runs -2..+1, a 3x3 runs -1..+1. Nothing is derived from it — the ground the ride stands on is the `footprint` describe_placement reports for this placement." },
                y: { type: "integer", minimum: 0, description: "Tile y of the build origin, the `y` you asked describe_placement about. Same rule as `x`: it is not the centre of anything." },
                rotation: { type: "integer", minimum: 0, maximum: MAX_ROTATION, description: "Which way the ride faces, 0-3, and the same `rotation` describe_placement answered for: a different one covers different tiles and has different doors. It is not wrapped, so 4 is refused rather than read as 0." },
                price: { type: "integer", minimum: 0, maximum: MAX_PRICE, description: "Ticket price in tenths of a currency unit: 10 means 1.00. Charge above what guests think the ride is worth and they walk past; park_status reports each ride's `value`. A ride being built has no `value` yet - it appears once the ride has been rated, which happens shortly after it opens with guests able to reach it - and `operate_ride` sets the price again at any time afterwards. 0 is free." },
                entranceX: { type: "integer", minimum: 0, description: "Tile x for the entrance building. Must be one of this placement's `access` options. Required with entranceY, exitX and exitY for anything that is not a shop." },
                entranceY: { type: "integer", minimum: 0, description: "Tile y for the entrance building." },
                exitX: { type: "integer", minimum: 0, description: "Tile x for the exit building. Must be a different `access` option from the entrance: one tile holds one door." },
                exitY: { type: "integer", minimum: 0, description: "Tile y for the exit building." },
                open: { type: "boolean", description: "Open the ride once it is built. A ride the game will not open - one with no entrance or no exit - is built closed and reports `open: false`." },
                colour1: { type: "integer", minimum: 0, maximum: MAX_COLOUR, description: "Main colour, 0-30. Default 0." },
                colour2: { type: "integer", minimum: 0, maximum: MAX_COLOUR, description: "Second colour, 0-30. Default 0." },
                entranceObject: { type: "integer", minimum: 0, description: "Style of the entrance and exit buildings. Default 0." },
                inspectionInterval: {
                    type: "integer",
                    minimum: 0,
                    maximum: MAX_INSPECTION_INTERVAL,
                    enum: [0, 1, 2, 3, 4, 5, 6],
                    // The seven intervals are listed once, on `operate_ride.inspectionInterval`,
                    // which is in the same tool list the model is reading. What stays here is the
                    // trap itself - these are not minutes - because this is where a wrong number
                    // would be sent, and the schema's refusal costs the turn that sent it.
                    description: "How often mechanics inspect. The same index `operate_ride`'s `inspectionInterval` describes, and NOT a number of minutes. Default 2, which is the interval OpenRCT2 itself gives a newly built ride."
                }
            },
            required: ["rideObject", "x", "y", "rotation", "price", "open"],
            additionalProperties: false
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false
        }
    })
    public buildFlatRide(args: Record<string, unknown>): DeferredMcpResult {
        const number = function (value: unknown, fallback: number): number {
            return typeof value === "number" ? Math.floor(value) : fallback;
        };
        const flag = function (value: unknown, fallback: boolean): boolean {
            return typeof value === "boolean" ? value : fallback;
        };

        // The schema cannot express "all four or none" - a shop legitimately has none - so
        // the pairing is checked here. Without it, entranceX with no entranceY dropped the
        // whole entrance and the build failed later on with a message naming neither field.
        const given: string[] = [];
        const missing: string[] = [];

        for (let i = 0; i < DOOR_FIELDS.length; i++) {
            if (typeof args[DOOR_FIELDS[i]] === "number") {
                given.push(DOOR_FIELDS[i]);
            } else {
                missing.push(DOOR_FIELDS[i]);
            }
        }

        if (given.length > 0 && missing.length > 0) {
            return refuseArguments(
                missing.join(", ") + (missing.length === 1 ? " is missing" : " are missing")
                + ", but " + given.join(", ") + (given.length === 1 ? " was given" : " were given")
                + ". A door needs both of its coordinates, so entranceX, entranceY, exitX and exitY go together:"
                + " entranceX/entranceY from one option in the site's `access` list, exitX/exitY from another."
                + " A shop takes none of the four. Nothing was built."
            );
        }

        const request = {
            rideObject: number(args.rideObject, -1),
            x: number(args.x, -1),
            y: number(args.y, -1),
            price: number(args.price, 0),
            open: flag(args.open, false),
            // No `% 4`: the schema bounds it, and wrapping silently turned 7 into 3.
            rotation: number(args.rotation, 0),
            colour1: number(args.colour1, 0),
            colour2: number(args.colour2, 0),
            entranceObject: number(args.entranceObject, 0),
            inspectionInterval: number(args.inspectionInterval, DEFAULT_INSPECTION_INTERVAL),
            entrance: given.length === DOOR_FIELDS.length
                ? { x: number(args.entranceX, -1), y: number(args.entranceY, -1) }
                : undefined,
            exit: given.length === DOOR_FIELDS.length
                ? { x: number(args.exitX, -1), y: number(args.exitY, -1) }
                : undefined
        };

        return {
            deferred: true,
            start: function (resolve) {
                buildFlatRide(request, resolve);
            }
        };
    }
}
