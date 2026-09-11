import { mcpTool, mcpToolController } from "./decorators.js";
import { operateRide } from "../park/operate.js";
import type { DeferredMcpResult } from "./types.js";

@mcpToolController
export class OperateTools {
    @mcpTool({
        name: "Operate a ride",
        description: [
            "Open, close, reprice or remove a ride that already exists, by its `ride` id from `park_status`.",
            "Set `open` to true or false, `price` in tenths of a currency unit, or `demolish` to remove it.",
            "You can change the price and the status in one call.",
            "The result reports what the ride is actually doing afterwards, which is not always what you asked:",
            "a ride will not open until it is built and has both an entrance and an exit, and some scenarios",
            "fix ride prices."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                ride: { type: "integer", description: "Ride id, from park_status." },
                open: { type: "boolean", description: "true to open it, false to close it." },
                price: { type: "integer", description: "Ticket price in tenths: 10 means 1.00. Compare against the ride's `value`." },
                demolish: { type: "boolean", description: "true to remove the ride entirely. This cannot be undone." }
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
    public operateRide(args: Record<string, unknown>): DeferredMcpResult {
        const request = {
            ride: typeof args.ride === "number" ? Math.floor(args.ride) : -1,
            open: typeof args.open === "boolean" ? args.open : undefined,
            price: typeof args.price === "number" ? Math.floor(args.price) : undefined,
            demolish: args.demolish === true
        };

        return {
            deferred: true,
            start: function (resolve) {
                operateRide(request, resolve);
            }
        };
    }
}
