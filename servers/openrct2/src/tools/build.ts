import { mcpTool, mcpToolController } from "./decorators.js";
import { buildFlatRide } from "../park/build.js";
import type { BuildOutcome } from "../park/build.js";
import type { DeferredMcpResult } from "./types.js";

const DOOR_FIELDS = ["entranceX", "entranceY", "exitX", "exitY"];
/** Kept in step with operate_ride, which bounds the same two values. */
const MAX_PRICE = 2000;
const MAX_INSPECTION_INTERVAL = 6;
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
        open: false,
        reachable: false,
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
            "Take `x`, `y` and `rotation` straight from a `find_build_sites` result; the footprint is worked out",
            "from the ride itself, so there is no size to get wrong.",
            "Shops and stalls have no entrance or exit: leave all four door arguments out. A stall is served from",
            "one tile only — the neighbour on the side it faces, decided by `rotation` — so that is where its path",
            "goes. `find_build_sites` returns no `access` list for a stall for the same reason.",
            "For everything else you choose where the doors go with `entranceX`/`entranceY` and `exitX`/`exitY`, from the site's",
            "`access` options. Each carries a `side`, so two with the same `side` put both doors on one face.",
            "All four go together: give one and you must give all four.",
            "It builds no paths: use `build_path` for the queue and for the walk away from the exit.",
            "`ok` means the ride EXISTS with its track on the ground — nothing more. Read `doorsAttached`, `open`",
            "and `reachable` for the rest. `ok: true` with any of those false is a ride you already own:",
            "fix what is missing, never build a second copy.",
            "`reachable` is normally false straight after building — you still have to lay the queue and the exit path.",
            "The only build that leaves nothing behind is `ok: false`; anything else means a ride is standing, and",
            "`operate_ride` with `demolish` is how it goes away.",
            "This does not build roller coasters; those need track laid piece by piece with `evaluate`."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                rideObject: { type: "integer", minimum: 0, description: "The `index` field of an entry from list_ride_objects. This is the object's own index, not its position in that list." },
                x: { type: "integer", minimum: 0, description: "Tile x of the build origin, copied from a find_build_sites site's `x`. The origin is inside the footprint but it is NOT its centre and NOT a corner: a 4x4 runs 0..3 from it, a 1x4 runs -2..+1, a 3x3 runs -1..+1. Derive nothing from it — the ground the ride stands on is the site's `fromX`/`fromY`/`toX`/`toY`." },
                y: { type: "integer", minimum: 0, description: "Tile y of the build origin, copied from a find_build_sites site's `y`. Same rule as `x`: it is not the centre of anything." },
                rotation: { type: "integer", minimum: 0, maximum: MAX_ROTATION, description: "Which way the ride faces, 0-3. Use the `rotation` from the site you picked; it is not wrapped, so 4 is refused rather than read as 0." },
                price: { type: "integer", minimum: 0, maximum: MAX_PRICE, description: "Ticket price in tenths of a currency unit: 10 means 1.00. Charge above what guests think the ride is worth and they walk past; park_status reports each ride's `value`. 0 is free." },
                entranceX: { type: "integer", minimum: 0, description: "Tile x for the entrance building. Must be one of the site's `access` options. Required with entranceY, exitX and exitY for anything that is not a shop." },
                entranceY: { type: "integer", minimum: 0, description: "Tile y for the entrance building." },
                exitX: { type: "integer", minimum: 0, description: "Tile x for the exit building. Must be a different `access` option from the entrance: one tile holds one door." },
                exitY: { type: "integer", minimum: 0, description: "Tile y for the exit building." },
                open: { type: "boolean", description: "Open the ride once it is built. An open ride guests cannot reach costs park rating." },
                colour1: { type: "integer", minimum: 0, maximum: MAX_COLOUR, description: "Main colour, 0-30. Default 0." },
                colour2: { type: "integer", minimum: 0, maximum: MAX_COLOUR, description: "Second colour, 0-30. Default 0." },
                entranceObject: { type: "integer", minimum: 0, description: "Style of the entrance and exit buildings. Default 0." },
                inspectionInterval: {
                    type: "integer",
                    minimum: 0,
                    maximum: MAX_INSPECTION_INTERVAL,
                    enum: [0, 1, 2, 3, 4, 5, 6],
                    description: "How often mechanics inspect. An index into the game's seven inspection intervals, NOT a number of minutes: 0 every 10 minutes, 1 every 20, 2 every 30, 3 every 45, 4 every hour, 5 every two hours, 6 never. Default 2."
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
            inspectionInterval: number(args.inspectionInterval, 2),
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
