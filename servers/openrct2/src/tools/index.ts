import { getMcpToolDefinitions } from "./decorators.js";
import { DateTools } from "./date.js";
import { EvalTools } from "./eval.js";
import { ParkTools } from "./park.js";
import { UiTools } from "./ui.js";
import type { McpToolAction, McpToolClass, McpToolDefinition } from "./types.js";

export function getMcpToolControllers(): McpToolClass[] {
    return [
        DateTools,
        EvalTools,
        ParkTools,
        UiTools
    ];
}

export function getMcpTools(): McpToolDefinition[] {
    return getMcpToolControllers().reduce(function (allTools, toolControllerClass) {
        return allTools.concat(getMcpToolDefinitions(toolControllerClass));
    }, [] as McpToolDefinition[]);
}

export function invokeMcpTool(tool: McpToolDefinition, argumentsObject: Record<string, unknown>): unknown {
    const controller = new tool.controllerClass() as Record<string, unknown>;
    const action = controller[tool.handlerName];

    if (typeof action !== "function") {
        throw new Error("MCP tool handler is not a function: " + tool.name);
    }

    return (action as McpToolAction).call(controller, argumentsObject);
}

export { mcpTool, mcpToolController } from "./decorators.js";
export type { McpToolAnnotations, McpToolDefinition, McpToolOptions, McpToolSchema } from "./types.js";
