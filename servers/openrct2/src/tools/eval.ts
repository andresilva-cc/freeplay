import { mcpTool, mcpToolController } from "./decorators.js";
import { runScript } from "../scripting.js";

@mcpToolController
export class EvalTools {
    @mcpTool({
        name: "Evaluate JavaScript",
        description: [
            "Run JavaScript inside the running OpenRCT2 game and return the result.",
            "The whole OpenRCT2 plugin API is in scope: `park`, `map`, `context`, `date`, `scenario`, `ui`.",
            "Read state by writing an expression, e.g. `park.cash` or `map.rides.length`.",
            "Change the game with `context.executeAction(name, args, callback)`.",
            "Multi-statement code must end with `return`. Large results are truncated; narrow the script instead.",
            "Returns { ok: true, result } or { ok: false, error } — a thrown error is reported, not hidden."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                code: {
                    type: "string",
                    description: "JavaScript to evaluate in the plugin context."
                }
            },
            required: ["code"],
            additionalProperties: false
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false
        }
    })
    public evaluate(args: Record<string, unknown>) {
        return runScript(String(args.code));
    }
}
