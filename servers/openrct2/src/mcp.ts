import type { HttpRequest, RequestContext } from "./http/types.js";
import { HttpResponse } from "./http/response.js";
import { BUILD_ID } from "./buildInfo.js";
import { getMcpTools, invokeMcpTool, isDeferredMcpResult } from "./tools/index.js";
import type { DeferredMcpResult, McpToolDefinition, McpToolSchema } from "./tools/index.js";

const JSON_RPC_VERSION = "2.0";
const MCP_PROTOCOL_VERSION = "2025-11-25";

/** A deferred tool that never resolves must not hold the socket open forever. */
const DEFERRED_TIMEOUT_MS = 30000;

interface JsonRpcError {
    code: number;
    message: string;
    data?: unknown;
}

interface JsonRpcRequestMessage {
    jsonrpc: string;
    id: string | number;
    method: string;
    params?: Record<string, unknown>;
}

interface JsonRpcNotificationMessage {
    jsonrpc: string;
    method: string;
    params?: Record<string, unknown>;
}

interface JsonRpcResponseMessage {
    jsonrpc: string;
    id?: string | number | null;
    result?: unknown;
    error?: unknown;
}

interface McpSession {
    protocolVersion: string;
    initialized: boolean;
}

interface ValidationResult {
    valid: boolean;
    message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
    return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
    return typeof value === "boolean";
}

function isNumber(value: unknown): value is number {
    return typeof value === "number" && !isNaN(value);
}

function isRequestId(value: unknown): value is string | number {
    return typeof value === "string" || typeof value === "number";
}

function hasAcceptedContentType(acceptHeader: string | undefined, expectedType: string): boolean {
    if (typeof acceptHeader === "undefined") {
        return false;
    }

    return acceptHeader.split(",").some(function (part) {
        return part.trim().toLowerCase().split(";")[0] === expectedType;
    });
}

function isAllowedOrigin(origin: string | undefined): boolean {
    if (typeof origin === "undefined" || origin === "null") {
        return true;
    }

    const normalizedOrigin = origin.toLowerCase();
    return normalizedOrigin.indexOf("http://localhost") === 0 || normalizedOrigin.indexOf("http://127.0.0.1") === 0;
}

function createTextContent(text: string): { type: "text"; text: string } {
    return {
        type: "text",
        text: text
    };
}

function createToolListEntry(tool: McpToolDefinition): Record<string, unknown> {
    const entry: Record<string, unknown> = {
        name: tool.name,
        inputSchema: tool.inputSchema
    };

    if (typeof tool.title !== "undefined") {
        entry.title = tool.title;
    }

    if (typeof tool.description !== "undefined") {
        entry.description = tool.description;
    }

    if (typeof tool.outputSchema !== "undefined") {
        entry.outputSchema = tool.outputSchema;
    }

    if (typeof tool.annotations !== "undefined") {
        entry.annotations = tool.annotations;
    }

    return entry;
}

function validatePrimitiveType(value: unknown, expectedType: string): boolean {
    if (expectedType === "string") {
        return isString(value);
    }
    if (expectedType === "boolean") {
        return isBoolean(value);
    }
    if (expectedType === "integer") {
        return isNumber(value) && Math.floor(value) === value;
    }
    if (expectedType === "number") {
        return isNumber(value);
    }
    if (expectedType === "object") {
        return isRecord(value);
    }

    return true;
}

function validateAgainstSchema(value: unknown, schema: McpToolSchema): ValidationResult {
    if (typeof value === "undefined") {
        value = {};
    }

    if (!isRecord(value)) {
        return {
            valid: false,
            message: "Tool arguments must be a JSON object."
        };
    }

    const properties = schema.properties || {};
    const requiredProperties = schema.required || [];

    for (const propertyName of requiredProperties) {
        if (typeof value[propertyName] === "undefined") {
            return {
                valid: false,
                message: "Missing required property: " + propertyName
            };
        }
    }

    if (schema.additionalProperties === false) {
        for (const propertyName of Object.keys(value)) {
            if (typeof properties[propertyName] === "undefined") {
                return {
                    valid: false,
                    message: "Unexpected property: " + propertyName
                };
            }
        }
    }

    for (const propertyName of Object.keys(properties)) {
        const propertyValue = value[propertyName];
        const propertySchema = properties[propertyName] as { type?: string };

        if (typeof propertyValue === "undefined" || typeof propertySchema.type === "undefined") {
            continue;
        }

        if (!validatePrimitiveType(propertyValue, propertySchema.type)) {
            return {
                valid: false,
                message: "Invalid type for property " + propertyName + ": expected " + propertySchema.type
            };
        }
    }

    return {
        valid: true
    };
}

function createToolResult(result: unknown): Record<string, unknown> {
    if (isRecord(result)) {
        return {
            content: [
                createTextContent(JSON.stringify(result))
            ],
            structuredContent: result
        };
    }

    return {
        content: [
            createTextContent(typeof result === "string" ? result : JSON.stringify(result))
        ]
    };
}

export class McpServer {
    private readonly sessions: Record<string, McpSession | undefined>;
    private readonly tools: McpToolDefinition[];
    private readonly toolsByName: Record<string, McpToolDefinition | undefined>;

    public constructor() {
        this.sessions = {};
        this.tools = getMcpTools();
        this.toolsByName = this.tools.reduce(function (entries, tool) {
            entries[tool.name] = tool;
            return entries;
        }, {} as Record<string, McpToolDefinition | undefined>);
    }

    public handlePost(request: HttpRequest, response: HttpResponse, requestContext?: RequestContext): HttpResponse {
        if (!isAllowedOrigin(request.getHeader("origin"))) {
            return response.setJson({
                jsonrpc: JSON_RPC_VERSION,
                error: {
                    code: -32600,
                    message: "Forbidden origin"
                }
            }, 403);
        }

        if (!hasAcceptedContentType(request.getHeader("accept"), "application/json")
            || !hasAcceptedContentType(request.getHeader("accept"), "text/event-stream")) {
            return response.setText("MCP POST requests must accept application/json and text/event-stream.", 400);
        }

        if (request.body.trim() === "") {
            return response.setText("MCP request body is required.", 400);
        }

        const message = this.parseMessage(request.body, response);

        if (typeof message === "undefined") {
            return response;
        }

        if (this.isNotification(message)) {
            return this.handleNotification(request, response, message);
        }

        if (this.isResponse(message)) {
            return response.setStatus(202);
        }

        return this.handleRequestMessage(request, response, message, requestContext);
    }

    private parseMessage(body: string, response: HttpResponse): JsonRpcRequestMessage | JsonRpcNotificationMessage | JsonRpcResponseMessage | undefined {
        let parsedBody: unknown;

        try {
            parsedBody = JSON.parse(body);
        } catch (error) {
            response.setJson({
                jsonrpc: JSON_RPC_VERSION,
                error: {
                    code: -32700,
                    message: "Parse error",
                    data: String(error)
                }
            }, 400);
            return undefined;
        }

        if (!isRecord(parsedBody) || parsedBody.jsonrpc !== JSON_RPC_VERSION) {
            response.setJson({
                jsonrpc: JSON_RPC_VERSION,
                error: {
                    code: -32600,
                    message: "Invalid Request"
                }
            }, 400);
            return undefined;
        }

        if (isString(parsedBody.method)) {
            if (isRequestId(parsedBody.id)) {
                return {
                    jsonrpc: JSON_RPC_VERSION,
                    id: parsedBody.id,
                    method: parsedBody.method,
                    params: isRecord(parsedBody.params) ? parsedBody.params : undefined
                };
            }

            return {
                jsonrpc: JSON_RPC_VERSION,
                method: parsedBody.method,
                params: isRecord(parsedBody.params) ? parsedBody.params : undefined
            };
        }

        if ("result" in parsedBody || "error" in parsedBody) {
            return {
                jsonrpc: JSON_RPC_VERSION,
                id: isRequestId(parsedBody.id) || parsedBody.id === null ? parsedBody.id : undefined,
                result: parsedBody.result,
                error: parsedBody.error
            };
        }

        response.setJson({
            jsonrpc: JSON_RPC_VERSION,
            error: {
                code: -32600,
                message: "Invalid Request"
            }
        }, 400);
        return undefined;
    }

    private handleNotification(
        request: HttpRequest,
        response: HttpResponse,
        message: JsonRpcNotificationMessage
    ): HttpResponse {
        const session = this.requireSession(request, response);

        if (typeof session === "undefined") {
            return response;
        }

        if (message.method === "notifications/initialized") {
            session.initialized = true;
            return response.setStatus(202);
        }

        return response.setText("Unsupported MCP notification.", 400);
    }

    private handleRequestMessage(
        request: HttpRequest,
        response: HttpResponse,
        message: JsonRpcRequestMessage,
        requestContext?: RequestContext
    ): HttpResponse {
        if (message.method === "initialize") {
            return this.handleInitialize(response, message);
        }

        const session = this.requireSession(request, response);

        if (typeof session === "undefined") {
            return response;
        }

        if (!session.initialized && message.method !== "ping") {
            return this.setJsonRpcError(response, message.id, {
                code: -32600,
                message: "Session not initialized"
            });
        }

        if (message.method === "ping") {
            return this.setJsonRpcResult(response, message.id, {});
        }

        if (message.method === "tools/list") {
            return this.setJsonRpcResult(response, message.id, {
                tools: this.tools.map(createToolListEntry)
            });
        }

        if (message.method === "tools/call") {
            return this.handleToolCall(response, message, requestContext);
        }

        return this.setJsonRpcError(response, message.id, {
            code: -32601,
            message: "Method not found"
        });
    }

    private handleInitialize(response: HttpResponse, message: JsonRpcRequestMessage): HttpResponse {
        const params = message.params;

        if (!isRecord(params)
            || !isString(params.protocolVersion)
            || !isRecord(params.capabilities)
            || !isRecord(params.clientInfo)
            || !isString(params.clientInfo.name)
            || !isString(params.clientInfo.version)) {
            return this.setJsonRpcError(response, message.id, {
                code: -32600,
                message: "Invalid initialize request"
            });
        }

        const sessionId = this.createSessionId();

        this.sessions[sessionId] = {
            protocolVersion: MCP_PROTOCOL_VERSION,
            initialized: false
        };

        response.setHeader("MCP-Session-Id", sessionId);
        response.setHeader("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);

        return this.setJsonRpcResult(response, message.id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {
                tools: {}
            },
            serverInfo: {
                name: "freeplay-openrct2",
                title: "Freeplay OpenRCT2 bridge",
                version: "0.1.0+" + BUILD_ID,
                description: "MCP bridge into a running OpenRCT2 game."
            },
            instructions: "Use `evaluate` to run JavaScript against the OpenRCT2 plugin API to read park state and take actions."
        });
    }

    private handleToolCall(response: HttpResponse, message: JsonRpcRequestMessage, requestContext?: RequestContext): HttpResponse {
        const params = message.params;

        if (!isRecord(params) || !isString(params.name)) {
            return this.setJsonRpcError(response, message.id, {
                code: -32602,
                message: "Invalid tool call request"
            });
        }

        const tool = this.toolsByName[params.name];

        if (typeof tool === "undefined") {
            return this.setJsonRpcError(response, message.id, {
                code: -32602,
                message: "Unknown tool: " + params.name
            });
        }

        const validation = validateAgainstSchema(params.arguments, tool.inputSchema);

        if (!validation.valid) {
            return this.setJsonRpcResult(response, message.id, {
                content: [
                    createTextContent(validation.message || "Tool arguments are invalid.")
                ],
                isError: true
            });
        }

        const result = invokeMcpTool(tool, (params.arguments as Record<string, unknown>) || {});

        if (isDeferredMcpResult(result)) {
            return this.handleDeferredToolCall(response, message, result, requestContext);
        }

        const resultPayload = createToolResult(result);

        if (typeof tool.outputSchema !== "undefined" && typeof resultPayload.structuredContent !== "undefined") {
            const outputValidation = validateAgainstSchema(resultPayload.structuredContent, tool.outputSchema);

            if (!outputValidation.valid) {
                throw new Error("MCP tool output failed schema validation for " + tool.name + ": " + outputValidation.message);
            }
        }

        return this.setJsonRpcResult(response, message.id, resultPayload);
    }

    private handleDeferredToolCall(
        response: HttpResponse,
        message: JsonRpcRequestMessage,
        deferred: DeferredMcpResult,
        requestContext?: RequestContext
    ): HttpResponse {
        const channel = requestContext ? requestContext.connection.takeOver() : undefined;

        if (typeof channel === "undefined") {
            return this.setJsonRpcError(response, message.id, {
                code: -32603,
                message: "This tool needs a live connection and cannot run on this transport."
            });
        }

        let settled = false;
        const send = function (payload: Record<string, unknown>): void {
            if (settled) {
                return;
            }
            settled = true;

            const deferredResponse = new HttpResponse();
            deferredResponse.setHeader("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
            deferredResponse.setJson({
                jsonrpc: JSON_RPC_VERSION,
                id: message.id,
                result: payload
            }, 200);
            channel.close(deferredResponse.toHttpString());
        };

        context.setTimeout(function () {
            send({
                content: [createTextContent("The tool did not finish in time; check the game state before retrying.")],
                isError: true
            });
        }, DEFERRED_TIMEOUT_MS);

        try {
            deferred.start(function (value) {
                send(createToolResult(value));
            });
        } catch (error) {
            send({
                content: [createTextContent("Tool failed: " + String(error))],
                isError: true
            });
        }

        return response;
    }

    private requireSession(request: HttpRequest, response: HttpResponse): McpSession | undefined {
        const sessionId = request.getHeader("mcp-session-id");

        if (typeof sessionId === "undefined" || sessionId === "") {
            response.setText("MCP-Session-Id header is required.", 400);
            return undefined;
        }

        const session = this.sessions[sessionId];

        if (typeof session === "undefined") {
            response.setText("Unknown MCP session.", 404);
            return undefined;
        }

        const protocolHeader = request.getHeader("mcp-protocol-version");

        if (typeof protocolHeader !== "undefined" && protocolHeader !== session.protocolVersion) {
            response.setText("Unsupported MCP-Protocol-Version header.", 400);
            return undefined;
        }

        response.setHeader("MCP-Protocol-Version", session.protocolVersion);
        return session;
    }

    private setJsonRpcResult(response: HttpResponse, id: string | number, result: Record<string, unknown>): HttpResponse {
        return response.setJson({
            jsonrpc: JSON_RPC_VERSION,
            id: id,
            result: result
        }, 200);
    }

    private setJsonRpcError(response: HttpResponse, id: string | number, error: JsonRpcError): HttpResponse {
        return response.setJson({
            jsonrpc: JSON_RPC_VERSION,
            id: id,
            error: error
        }, 200);
    }

    private isNotification(message: JsonRpcRequestMessage | JsonRpcNotificationMessage | JsonRpcResponseMessage): message is JsonRpcNotificationMessage {
        return isString((message as JsonRpcNotificationMessage).method) && !isRequestId((message as JsonRpcRequestMessage).id);
    }

    private isResponse(message: JsonRpcRequestMessage | JsonRpcNotificationMessage | JsonRpcResponseMessage): message is JsonRpcResponseMessage {
        return !isString((message as JsonRpcNotificationMessage).method);
    }

    private createSessionId(): string {
        return "mcp-" + String(Date.now()) + "-" + String(Math.floor(Math.random() * 1000000));
    }
}
