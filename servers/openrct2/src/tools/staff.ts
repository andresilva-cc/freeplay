import { mcpTool, mcpToolController } from "./decorators.js";
import type { DeferredMcpResult } from "./types.js";

const STAFF_TYPES: Record<string, number | undefined> = {
    handyman: 0,
    mechanic: 1,
    security: 2,
    entertainer: 3
};

@mcpToolController
export class StaffTools {
    @mcpTool({
        name: "Hire staff",
        description: [
            "Hire staff and place them in the park. Handymen sweep paths and mow grass, mechanics fix and",
            "inspect rides, security deter vandals, entertainers keep queueing guests happy.",
            "Staff are hired near the park entrance and wander freely; set patrol areas with evaluate if you",
            "want them somewhere specific. Each one draws wages every month, so hiring is a running cost."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                staffType: {
                    type: "string",
                    description: "handyman, mechanic, security or entertainer."
                },
                count: { type: "integer", description: "How many to hire (default 1, max 10)." }
            },
            required: ["staffType"],
            additionalProperties: false
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false
        }
    })
    public hireStaff(args: Record<string, unknown>): DeferredMcpResult {
        const name = String(args.staffType || "").toLowerCase();
        const staffType = STAFF_TYPES[name];
        const count = Math.max(1, Math.min(typeof args.count === "number" ? Math.floor(args.count) : 1, 10));

        return {
            deferred: true,
            start: function (resolve) {
                if (typeof staffType === "undefined") {
                    return resolve({
                        ok: false,
                        error: "Unknown staff type '" + name + "'. Use handyman, mechanic, security or entertainer."
                    });
                }

                const before = map.getAllEntities("staff").length;

                for (let i = 0; i < count; i++) {
                    context.executeAction("staffhire", {
                        autoPosition: true,
                        staffType: staffType,
                        costumeIndex: 0,
                        staffOrders: 0
                    }, function () { /* verified by re-read */ });
                }

                context.setTimeout(function () {
                    const after = map.getAllEntities("staff").length;
                    const hired = after - before;

                    resolve({
                        ok: hired === count,
                        requested: count,
                        hired: hired,
                        totalStaff: after,
                        detail: hired === count
                            ? "Hired " + String(hired) + " " + name + "."
                            : "Only " + String(hired) + " of " + String(count) + " were hired; check you can afford them."
                    });
                }, 250);
            }
        };
    }
}
