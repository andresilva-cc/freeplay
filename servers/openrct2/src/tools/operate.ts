import { mcpTool, mcpToolController } from "./decorators.js";
import { operateRide } from "../park/operate.js";
import type { OperateRideOutcome, OperateRideRequest } from "../park/operate.js";
import type { DeferredMcpResult } from "./types.js";

/**
 * Ticket prices are in tenths of a currency unit, and no scenario charges anywhere near
 * 200.00 for a ride. The ceiling is here to catch a currency unit sent as if it were the
 * price, which is the mistake that costs a turn.
 */
const MAX_PRICE = 2000;

/** Inspection intervals are an enum of seven values, not a number of minutes. */
const MAX_INSPECTION_INTERVAL = 6;

const INSPECTION_INTERVAL_HELP = "0 is every 10 minutes, 1 every 20, 2 every 30, 3 every 45,"
    + " 4 every hour, 5 every 2 hours, 6 never";

/**
 * The MCP layer checks types, `required` and unknown properties, and nothing else: a
 * number outside its range reaches the game, which answers "Value out of range" without
 * naming a field. A run lost several turns to exactly that, passing 30 to
 * `inspectionInterval` meaning thirty minutes. So the ranges are checked here, by name,
 * before any action is sent.
 */
function isWholeNumberWithin(value: number, min: number, max: number): boolean {
    return Math.floor(value) === value && value >= min && value <= max;
}

function refuseBadArguments(request: OperateRideRequest): string | undefined {
    if (request.demolish === true && (typeof request.price === "number" || typeof request.open === "boolean")) {
        return "`demolish` cannot be combined with `price` or `open`: the ride is gone, so it has"
            + " no price and no status afterwards. Send the demolition on its own, or drop"
            + " `demolish` to change a ride you are keeping.";
    }

    if (typeof request.ride !== "number" || Math.floor(request.ride) !== request.ride || request.ride < 0) {
        return "`ride` must be a whole ride id of 0 or more, as listed by park_status; "
            + String(request.ride) + " is not one.";
    }

    if (typeof request.price === "number" && !isWholeNumberWithin(request.price, 0, MAX_PRICE)) {
        return "`price` must be between 0 and " + String(MAX_PRICE) + ", in tenths of a currency unit"
            + " (1000 means 100.00); " + String(request.price) + " is outside that range.";
    }

    if (typeof request.inspectionInterval === "number"
        && !isWholeNumberWithin(request.inspectionInterval, 0, MAX_INSPECTION_INTERVAL)) {
        return "`inspectionInterval` must be a whole number between 0 and " + String(MAX_INSPECTION_INTERVAL) + "."
            + " It is an index into the game's inspection intervals and not a number of minutes: "
            + INSPECTION_INTERVAL_HELP + ". " + String(request.inspectionInterval)
            + " is outside that range.";
    }

    return undefined;
}

@mcpToolController
export class OperateTools {
    @mcpTool({
        name: "Operate a ride",
        description: [
            "Open, close, reprice, reschedule inspections for, or remove a ride that already exists,",
            "by its `ride` id from `park_status`.",
            "`price` is in tenths of a currency unit: 1000 means 100.00.",
            "`inspectionInterval` is an index from 0 to 6 and not a number of minutes:",
            INSPECTION_INTERVAL_HELP + ".",
            "`price`, `open` and `inspectionInterval` can be changed in one call.",
            "`demolish` must be sent on its own; combined with `price` or `open` the call is refused.",
            "The result reports what the ride is actually doing afterwards, which is not always what you asked:",
            "a ride will not open until it is built and has both an entrance and an exit, and some scenarios",
            "fix ride prices."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                ride: { type: "integer", minimum: 0, description: "Ride id, from park_status." },
                open: { type: "boolean", description: "true to open it, false to close it." },
                price: {
                    type: "integer",
                    minimum: 0,
                    maximum: MAX_PRICE,
                    description: "Ticket price in tenths of a currency unit: 10 means 1.00 and 1000 means 100.00."
                },
                inspectionInterval: {
                    type: "integer",
                    minimum: 0,
                    maximum: MAX_INSPECTION_INTERVAL,
                    enum: [0, 1, 2, 3, 4, 5, 6],
                    description: "How often a mechanic inspects the ride, as an index and not as minutes: "
                        + INSPECTION_INTERVAL_HELP + "."
                },
                demolish: {
                    type: "boolean",
                    description: "true to remove the ride entirely. This cannot be undone,"
                        + " and cannot be sent together with price or open."
                }
            },
            required: ["ride"],
            additionalProperties: false
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false
        }
    })
    public operateRide(args: Record<string, unknown>): DeferredMcpResult | OperateRideOutcome {
        const request: OperateRideRequest = {
            ride: typeof args.ride === "number" ? args.ride : -1,
            open: typeof args.open === "boolean" ? args.open : undefined,
            price: typeof args.price === "number" ? args.price : undefined,
            inspectionInterval: typeof args.inspectionInterval === "number" ? args.inspectionInterval : undefined,
            demolish: args.demolish === true
        };

        const refusal = refuseBadArguments(request);

        if (typeof refusal === "string") {
            return { ok: false, ride: request.ride, detail: refusal };
        }

        return {
            deferred: true,
            start: function (resolve) {
                operateRide(request, resolve);
            }
        };
    }
}
