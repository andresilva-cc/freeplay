import { httpGet, httpPath } from "./decorators.js";
import { HttpController, type ControllerContext } from "./types.js";
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
