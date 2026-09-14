import { httpGet, httpPath } from "./decorators.js";
import { HttpController, type ControllerContext } from "./types.js";
import { isAllowedOrigin } from "../http/origin.js";
import { runScript } from "../scripting.js";

@httpPath("/v1/eval")
export class EvalController extends HttpController {
    @httpGet("/", {
        operationId: "evaluateExpression",
        summary: "Evaluate a JavaScript expression",
        description: "Evaluates the q query parameter and returns the resulting value.",
        responseDescription: "Evaluation result"
    })
    public evaluateExpression(context: ControllerContext) {
        // The same check `POST /mcp` makes, for the same reason and before anything else.
        // This route runs arbitrary model-authored JavaScript inside the player's game over
        // a GET, which is a simple request: any page open in their browser could make one
        // with no preflight to stop it, and the bridge would run it. The MCP endpoint had
        // this from the start and this one never did, which made the origin check on the
        // other route decorative.
        if (!isAllowedOrigin(this.request.getHeader("origin"))) {
            this.response.statusCode = 403;
            return {
                error: "Forbidden origin"
            };
        }

        const expression = this.request.query.q;

        if (typeof expression === "undefined") {
            this.response.statusCode = 400;
            return {
                error: "Missing q parameter"
            };
        }

        context.response.headers["X-Eval-Endpoint"] = "true";

        // Through runScript rather than a bare `new Function`, which is what this used to
        // be: it is the same thing the evaluate tool does with the same code, so it has to
        // carry the same guards. A second entry point running model-authored script with no
        // `insideEvaluate` set is a way round every guard that only bites inside a script,
        // whoever is typing into it. It also stops a mutating expression running twice,
        // which the old try/catch did whenever the expression threw rather than failed to
        // parse, and carries the unaccounted-change note through instead of dropping it.
        const outcome = runScript(expression);

        if (!outcome.ok) {
            this.response.statusCode = 400;
            return {
                error: outcome.error,
                unaccountedChanges: outcome.unaccountedChanges,
                note: outcome.note
            };
        }

        return {
            result: outcome.result,
            unaccountedChanges: outcome.unaccountedChanges,
            note: outcome.note
        };
    }
}
