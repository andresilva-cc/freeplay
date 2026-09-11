import { mcpTool, mcpToolController } from "./decorators.js";
import { getParkInfo } from "../parkInfo.js";

@mcpToolController
export class ParkTools {
    @mcpTool({
        name: "Get park info",
        description: "Get key park information such as guest count, rating, finances, and park name.",
        outputSchema: {
            type: "object",
            properties: {
                name: { type: "string" },
                numGuests: { type: "number" },
                rating: { type: "number" },
                cash: { type: "number" },
                bankLoan: { type: "number" },
                companyValue: { type: "number" },
                parkValue: { type: "number" },
                entranceFee: { type: "number" }
            },
            required: [
                "name",
                "numGuests",
                "rating",
                "cash",
                "bankLoan",
                "companyValue",
                "parkValue",
                "entranceFee"
            ],
            additionalProperties: false
        },
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
            destructiveHint: false,
            openWorldHint: false
        }
    })
    public getParkInfo() {
        return getParkInfo();
    }
}
