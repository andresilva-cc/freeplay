import type { McpToolClass, McpToolDefinition, McpToolMetadata, McpToolOptions, McpToolSchema } from "./types.js";

const mcpToolControllerMetadataKey = "__mcpToolController__";
const mcpToolMetadataKey = "__mcpTools__";

type DecoratedMcpToolClass = McpToolClass & {
    [mcpToolControllerMetadataKey]?: boolean;
    [mcpToolMetadataKey]?: McpToolMetadata[];
};

function getDecoratedMcpToolClass(target: object): DecoratedMcpToolClass {
    return target as unknown as DecoratedMcpToolClass;
}

function toToolName(value: string): string {
    const withWordBoundaries = value
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/[\s-]+/g, "_");

    return withWordBoundaries.toLowerCase();
}

function createDefaultInputSchema(): McpToolSchema {
    return {
        type: "object",
        additionalProperties: false
    };
}

export function mcpToolController(target: object): void {
    getDecoratedMcpToolClass(target)[mcpToolControllerMetadataKey] = true;
}

export function mcpTool(options?: McpToolOptions): MethodDecorator {
    return function (target, propertyKey): void {
        const controllerClass = getDecoratedMcpToolClass(target.constructor);
        const existingTools = controllerClass[mcpToolMetadataKey] || [];

        controllerClass[mcpToolMetadataKey] = existingTools.concat({
            handlerName: String(propertyKey),
            name: options?.name,
            description: options?.description,
            inputSchema: options?.inputSchema,
            outputSchema: options?.outputSchema,
            annotations: options?.annotations
        });
    };
}

export function getMcpToolDefinitions(controllerClass: McpToolClass): McpToolDefinition[] {
    const decoratedControllerClass = controllerClass as DecoratedMcpToolClass;
    const tools = decoratedControllerClass[mcpToolMetadataKey] || [];

    if (!decoratedControllerClass[mcpToolControllerMetadataKey]) {
        throw new Error("MCP tool controller is missing @mcpToolController metadata");
    }

    return tools.map(function (tool) {
        return {
            controllerClass: controllerClass,
            handlerName: tool.handlerName,
            name: toToolName(tool.handlerName),
            title: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema || createDefaultInputSchema(),
            outputSchema: tool.outputSchema,
            annotations: tool.annotations
        };
    });
}
