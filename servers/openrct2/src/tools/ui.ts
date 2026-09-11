import { mcpTool, mcpToolController } from "./decorators.js";

@mcpToolController
export class UiTools {
    @mcpTool({
        name: "Show error dialog",
        description: "Show a red in-game error dialog with a title and message.",
        inputSchema: {
            type: "object",
            properties: {
                title: { type: "string" },
                message: { type: "string" }
            },
            required: ["title", "message"],
            additionalProperties: false
        },
        annotations: {
            readOnlyHint: false,
            idempotentHint: false,
            destructiveHint: false,
            openWorldHint: false
        }
    })
    public showError(argumentsObject: Record<string, unknown>) {
        const title = String(argumentsObject.title);
        const message = String(argumentsObject.message);

        ui.showError(title, message);
        return {
            shown: true,
            title: title,
            message: message
        };
    }
}
