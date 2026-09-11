export interface McpToolSchema {
    $schema?: string;
    type: "object";
    properties?: Record<string, object>;
    required?: string[];
    additionalProperties?: boolean;
}

export interface McpToolAnnotations {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
}

export interface McpToolOptions {
    name?: string;
    description?: string;
    inputSchema?: McpToolSchema;
    outputSchema?: McpToolSchema;
    annotations?: McpToolAnnotations;
}

export interface McpToolMetadata extends McpToolOptions {
    handlerName: string;
}

export interface McpToolClass {
    new (): object;
}

export interface McpToolDefinition {
    controllerClass: McpToolClass;
    handlerName: string;
    name: string;
    title?: string;
    description?: string;
    inputSchema: McpToolSchema;
    outputSchema?: McpToolSchema;
    annotations?: McpToolAnnotations;
}

export type McpToolAction = (argumentsObject: Record<string, unknown>) => unknown;
