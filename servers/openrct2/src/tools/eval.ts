import { mcpTool, mcpToolController } from "./decorators.js";
import { runScript } from "../scripting.js";

@mcpToolController
export class EvalTools {
    @mcpTool({
        name: "Evaluate JavaScript",
        description: [
            "Run JavaScript inside the running OpenRCT2 game and return the result.",
            "The whole OpenRCT2 plugin API is in scope: `park`, `map`, `context`, `date`, `scenario`, `ui`.",
            "State is read by writing an expression, e.g. `park.cash` or `map.rides.length`.",
            "Change the game with `context.executeAction(name, args, callback)`.",
            "Multi-statement code must end with `return`. Large results are truncated.",
            "The park's own figures are read-only: cash, rating, loan, park and company value, guest count,",
            "ride ratings and the scenario objective refuse assignment and answer with what does move them.",
            "Those figures are read before and after every script, and a change no game action accounts for",
            "comes back in the result as `unaccountedChanges` with a note.",
            "Returns { ok: true, result } or { ok: false, error } — a thrown error is reported, not hidden.",
            "An action name the game does not know fails with an error naming it, instead of answering null.",
            "`Object.keys` is empty on game objects, which keep their data behind prototype getters:",
            "`keys(value)` is what lists what a value really has.",
            "A property a value does not have reads back as \"<undefined>\", which is not the same as null.",
            "This runs on the game's own thread: a loop that never ends freezes the game with no error and ends the run."
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
