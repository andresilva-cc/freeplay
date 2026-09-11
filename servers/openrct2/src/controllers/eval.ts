import { httpGet, httpPath } from "./decorators.js";
import { HttpController, type ControllerContext } from "./types.js";

function evaluateExpression(expression: string): unknown {
    try {
        return new Function("return (" + expression + ");")();
    } catch (_error) {
        return new Function(expression)();
    }
}

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

        try {
            context.response.headers["X-Eval-Endpoint"] = "true";
            return {
                result: evaluateExpression(expression)
            };
        } catch (error) {
            this.response.statusCode = 400;
            return {
                error: String(error)
            };
        }
    }
}
