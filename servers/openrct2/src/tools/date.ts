import { mcpTool, mcpToolController } from "./decorators.js";

@mcpToolController
export class DateTools {
    @mcpTool({
        name: "Get the current date",
        description: "Get the current in-game date values from the running game.",
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
            destructiveHint: false,
            openWorldHint: false
        }
    })
    public getDate() {
        const d = date;
        return {
            day: d.day,
            month: d.month,
            year: d.year,
            formatted: context.formatString("{INT32} {MONTHYEAR}", date.day, date.monthsElapsed)
        };
    }
}
