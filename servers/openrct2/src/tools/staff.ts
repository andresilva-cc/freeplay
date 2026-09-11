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
                    enum: ["handyman", "mechanic", "security", "entertainer"],
                    description: "handyman, mechanic, security or entertainer."
                },
                count: { type: "integer", minimum: 1, maximum: 10, description: "How many to hire, 1 to 10. Defaults to 1." }
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
        // Not clamped. The schema's minimum and maximum refuse a count outside 1-10 before
        // the tool is reached, so what arrives here is what was asked for and `requested`
        // can be reported honestly. Clamping 30 to 10 and calling 10 the request was a lie.
        const count = typeof args.count === "number" ? Math.floor(args.count) : 1;

        return {
            deferred: true,
            start: function (resolve) {
                if (typeof staffType === "undefined") {
                    return resolve({
                        ok: false,
                        error: "Unknown staff type '" + name + "'. Use handyman, mechanic, security or entertainer."
                    });
                }

                // Counted by type, not by total: a total that went up by three says three
                // people were hired, not that three of them are the mechanics that were asked
                // for, and the tool's whole job is answering the second question.
                const countOfType = function (): number {
                    return map.getAllEntities("staff").filter(function (member) {
                        return member.staffType === name;
                    }).length;
                };

                const before = countOfType();

                for (let i = 0; i < count; i++) {
                    context.executeAction("staffhire", {
                        autoPosition: true,
                        staffType: staffType,
                        costumeIndex: 0,
                        staffOrders: 0
                    }, function () { /* verified by re-read */ });
                }

                context.setTimeout(function () {
                    const hired = countOfType() - before;

                    resolve({
                        ok: hired === count,
                        requested: count,
                        hired: hired,
                        totalStaff: map.getAllEntities("staff").length,
                        detail: hired === count
                            ? "Hired " + String(hired) + " " + name + "."
                            : "Only " + String(hired) + " of " + String(count) + " were hired; check you can afford them."
                    });
                }, 250);
            }
        };
    }
}
