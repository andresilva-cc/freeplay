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

/**
 * A tool whose work spans game ticks. The MCP layer hijacks the connection and
 * answers once `start` resolves, so the caller still sees one request and one result.
 */
export interface DeferredMcpResult {
    deferred: true;
    start(resolve: (value: unknown) => void): void;
}

export function isDeferredMcpResult(value: unknown): value is DeferredMcpResult {
    return typeof value === "object"
        && value !== null
        && (value as DeferredMcpResult).deferred === true
        && typeof (value as DeferredMcpResult).start === "function";
}
