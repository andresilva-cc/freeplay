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
            "Returns { ok: true, result } or { ok: false, error } — a thrown error is reported, not hidden.",
            "An action name the game does not know fails with an error naming it, instead of answering null.",
            "`Object.keys` is empty on game objects, which keep their data behind prototype getters:",
            "call `keys(value)` to list what a value really has.",
            "A property a value does not have reads back as \"<undefined>\", which is not the same as null.",
            "This runs on the game's own thread: a loop that never ends freezes the game with no error, so bound every loop."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                code: {
                    type: "string",
                    description: "JavaScript to evaluate in the plugin context."
                }
            },
            required: ["code"]
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
