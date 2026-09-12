import type { HttpRequest, RequestContext } from "./http/types.js";
import { HttpResponse } from "./http/response.js";
import { BUILD_ID } from "./buildInfo.js";
import { sanitizeToolResult } from "./scripting.js";
import { getMcpTools, invokeMcpTool, isDeferredMcpResult } from "./tools/index.js";
import type { DeferredMcpResult, McpToolDefinition, McpToolSchema } from "./tools/index.js";

const JSON_RPC_VERSION = "2.0";
const MCP_PROTOCOL_VERSION = "2025-11-25";

/** A deferred tool that never resolves must not hold the socket open forever. */
const DEFERRED_TIMEOUT_MS = 30000;

type DeferredFailureHandler = (error: unknown) => void;

/**
 * A deferred tool keeps working inside `context.setTimeout` callbacks it schedules for
 * itself, so a failure after `start` returned escapes into the game's tick loop: the MCP
 * layer never sees it and the caller waits out the whole watchdog only to be told the tool
 * was slow rather than what broke. While deferred calls are in flight the game's timer is
 * wrapped, so every continuation is attributed to the call that scheduled it and a throw
 * comes back as that call's error result.
 */
let deferredCallsInFlight = 0;
let gameSetTimeout: ((callback: () => void, delay: number) => number) | undefined;
/** The deferred call whose work is running right now. Its continuations inherit it. */
let runningDeferredCall: DeferredFailureHandler | undefined;

function runAttributedToCall(owner: DeferredFailureHandler, body: () => void): void {
    const previousOwner = runningDeferredCall;
    runningDeferredCall = owner;

    try {
        body();
    } catch (error) {
        owner(error);
    } finally {
        runningDeferredCall = previousOwner;
    }
}

function watchDeferredWork(): void {
    deferredCallsInFlight++;

    if (deferredCallsInFlight > 1) {
        return;
    }

    const gameTimer = context.setTimeout;
    const wrappedTimer = function (callback: () => void, delay: number): number {
        const owner = runningDeferredCall;

        if (typeof owner === "undefined") {
            return gameTimer.call(context, callback, delay);
        }

        return gameTimer.call(context, function () {
            runAttributedToCall(owner, callback);
        }, delay);
    };

    try {
        context.setTimeout = wrappedTimer;
    } catch (_error) {
        // A game build that will not let its timer be wrapped.
    }

    // If the assignment did not take, leave the game's timer alone: a later-tick failure
    // then falls back to the watchdog rather than taking the bridge down with it.
    gameSetTimeout = context.setTimeout === wrappedTimer ? gameTimer : undefined;
}

function unwatchDeferredWork(): void {
    deferredCallsInFlight--;

    if (deferredCallsInFlight > 0 || typeof gameSetTimeout === "undefined") {
        return;
    }

    context.setTimeout = gameSetTimeout;
    gameSetTimeout = undefined;
}

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

/** The slice of JSON Schema a property may declare, and all of it is enforced. */
interface McpPropertySchema {
    type?: string;
    enum?: unknown[];
    minimum?: number;
    maximum?: number;
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

/** The only hosts that are this machine. An origin is one of these, with an optional port. */
const LOOPBACK_ORIGIN_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/**
 * This runs on a loopback port inside the player's game, so the Origin header is the only
 * thing between a web page they happen to have open and their park.
 *
 * It has to match the whole host, not a prefix: `http://localhost.evil.test` is a name an
 * attacker registers and points wherever they like, and it starts with `http://localhost`.
 * An opaque origin - the literal string `null`, which is what a sandboxed iframe sends -
 * is likewise refused rather than waved through: no legitimate client produces one, and a
 * page that wants to bypass the check can always ask for one. A real MCP client over plain
 * HTTP sends no Origin header at all, and that is the case this lets through.
 */
function isAllowedOrigin(origin: string | undefined): boolean {
    if (typeof origin === "undefined") {
        return true;
    }

    const parsed = /^http:\/\/([^/?#]+)\/?$/.exec(origin.toLowerCase());

    if (parsed === null) {
        return false;
    }

    return LOOPBACK_ORIGIN_HOSTS.indexOf(parsed[1].replace(/:[0-9]+$/, "")) >= 0;
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
    if (expectedType === "array") {
        return Array.isArray(value);
    }
    if (expectedType === "object") {
        return isRecord(value);
    }

    return true;
}

/** What arrived, short enough for a one-line refusal: `string "12"`, `number 1.5`, `array`. */
function describeValue(value: unknown): string {
    if (value === null) {
        return "null";
    }

    if (Array.isArray(value)) {
        return "array";
    }

    const valueType = typeof value;

    if (valueType === "string" || valueType === "number" || valueType === "boolean") {
        return valueType + " " + JSON.stringify(value);
    }

    return valueType;
}

function listValues(values: unknown[]): string {
    return values.map(function (value) {
        return JSON.stringify(value);
    }).join(", ");
}

/**
 * The schemas declare `enum`, `minimum` and `maximum`, and this is the only place they are
 * enforced. Left to the game, an out-of-range number comes back as "Value out of range"
 * naming no field: a run lost turns sending `inspectionInterval: 30` meaning thirty
 * minutes. Each message names the property, the value that arrived and the legal set, and
 * nothing else - a category without a fix is a message the model cannot act on.
 */
function checkProperty(propertyName: string, value: unknown, schema: McpPropertySchema): string | undefined {
    if (typeof schema.type === "string" && !validatePrimitiveType(value, schema.type)) {
        return "Invalid type for property " + propertyName + ": expected " + schema.type
            + ", got " + describeValue(value) + ".";
    }

    const allowedValues = schema.enum;

    if (typeof allowedValues !== "undefined" && allowedValues.indexOf(value) < 0) {
        return "Invalid value for property " + propertyName + ": expected one of "
            + listValues(allowedValues) + ", got " + describeValue(value) + ".";
    }

    if (!isNumber(value)) {
        return undefined;
    }

    const minimum = schema.minimum;
    const maximum = schema.maximum;
    const belowMinimum = typeof minimum === "number" && value < minimum;
    const aboveMaximum = typeof maximum === "number" && value > maximum;

    if (!belowMinimum && !aboveMaximum) {
        return undefined;
    }

    const range = typeof minimum === "number" && typeof maximum === "number"
        ? String(minimum) + " to " + String(maximum)
        : (belowMinimum ? String(minimum) + " or more" : String(maximum) + " or less");

    return "Invalid value for property " + propertyName + ": expected " + range + ", got " + String(value) + ".";
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
    const knownProperties = Object.keys(properties);

    for (const propertyName of requiredProperties) {
        if (typeof value[propertyName] === "undefined") {
            const declaredType = (properties[propertyName] as McpPropertySchema | undefined)?.type;

            return {
                valid: false,
                message: "Missing required property: " + propertyName
                    + (typeof declaredType === "string" ? " (" + declaredType + ")." : ".")
            };
        }
    }

    if (schema.additionalProperties === false) {
        for (const propertyName of Object.keys(value)) {
            if (typeof properties[propertyName] === "undefined") {
                return {
                    valid: false,
                    message: "Unexpected property: " + propertyName + ". "
                        + (knownProperties.length > 0
                            ? "This tool takes: " + knownProperties.join(", ") + "."
                            : "This tool takes no arguments.")
                };
            }
        }
    }

    for (const propertyName of knownProperties) {
        const propertyValue = value[propertyName];

        if (typeof propertyValue === "undefined") {
            continue;
        }

        const failure = checkProperty(propertyName, propertyValue, properties[propertyName] as McpPropertySchema);

        if (typeof failure !== "undefined") {
            return {
                valid: false,
                message: failure
            };
        }
    }

    return {
        valid: true
    };
}

/**
 * Every tool's result goes through the same sanitiser, not just evaluate's: native
 * OpenRCT2 objects expose their data through prototype getters and would otherwise
 * serialise as {}, silently emptying a field the model was told to rely on.
 */
function createToolResult(rawResult: unknown): Record<string, unknown> {
    const result = sanitizeToolResult(rawResult);

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

/**
 * Both paths validate their output. The check used to sit on the immediate path only, so
 * the first deferred tool to declare an outputSchema would have had it quietly ignored.
 */
function checkToolOutput(tool: McpToolDefinition, payload: Record<string, unknown>): string | undefined {
    if (typeof tool.outputSchema === "undefined") {
        return undefined;
    }

    if (typeof payload.structuredContent === "undefined") {
        // A declared outputSchema is a promise of a structured result. Skipping the check
        // when there is none let a tool answer with a bare string and pass, which is the
        // one failure the schema exists to catch.
        return "MCP tool output failed schema validation for " + tool.name
            + ": the tool declares an outputSchema but answered with no structured content.";
    }

    const outputValidation = validateAgainstSchema(payload.structuredContent, tool.outputSchema);

    if (outputValidation.valid) {
        return undefined;
    }

    return "MCP tool output failed schema validation for " + tool.name + ": " + outputValidation.message;
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
            instructions: [
                "Fifteen tools reach the running game.",
                "`park_status` returns the whole park in one call;",
                "`guest_feedback`, `list_ride_objects`, `find_build_sites` and `view_map` read further.",
                "`clear_scenery`, `build_flat_ride`, `build_path`, `remove_path`, `buy_land`, `operate_ride`,",
                "`open_park`, `hire_staff` and `set_game_speed` act,",
                "and answer once the work has landed a few ticks later.",
                "`evaluate` runs plugin-API JavaScript and is the escape hatch for what no typed tool covers,",
                "such as tracked rides."
            ].join(" ")
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
            return this.handleDeferredToolCall(response, message, tool, result, requestContext);
        }

        const resultPayload = createToolResult(result);
        const outputFailure = checkToolOutput(tool, resultPayload);

        if (typeof outputFailure !== "undefined") {
            throw new Error(outputFailure);
        }

        return this.setJsonRpcResult(response, message.id, resultPayload);
    }

    private handleDeferredToolCall(
        response: HttpResponse,
        message: JsonRpcRequestMessage,
        tool: McpToolDefinition,
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
        let watchdog: number | undefined;

        function clientWentAway(): void {
            // There is nobody left to answer, and handing bytes to a socket the peer has
            // dropped throws out of whatever tick we happen to be in.
            finish();
        }

        /** Close the call down exactly once; false means somebody else already did. */
        const finish = function (): boolean {
            if (settled) {
                return false;
            }

            settled = true;
            channel.offClose(clientWentAway);
            unwatchDeferredWork();

            if (typeof watchdog !== "undefined") {
                context.clearTimeout(watchdog);
                watchdog = undefined;
            }

            return true;
        };

        const send = function (payload: Record<string, unknown>): void {
            if (!finish()) {
                return;
            }

            const deferredResponse = new HttpResponse();
            deferredResponse.setHeader("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
            deferredResponse.setJson({
                jsonrpc: JSON_RPC_VERSION,
                id: message.id,
                result: payload
            }, 200);

            try {
                channel.close(deferredResponse.toHttpString());
            } catch (_error) {
                // The socket refused the write. The call is answered as far as we are
                // concerned and there is no second way to reach the client, so this must
                // not escape into the game's tick loop.
            }
        };

        const fail = function (error: unknown): void {
            send({
                content: [createTextContent("Tool failed: " + String(error))],
                isError: true
            });
        };

        channel.onClose(clientWentAway);
        watchDeferredWork();

        runAttributedToCall(fail, function () {
            deferred.start(function (value) {
                const payload = createToolResult(value);
                const outputFailure = checkToolOutput(tool, payload);

                if (typeof outputFailure !== "undefined") {
                    // The immediate path throws here; on this one a throw would land in a
                    // tick and leave the caller on the watchdog, so send the reason.
                    send({
                        content: [createTextContent(outputFailure)],
                        isError: true
                    });
                    return;
                }

                send(payload);
            });
        });

        // Armed after starting, so a tool that finishes immediately is never beaten to the
        // answer by its own watchdog, and cancelled by `finish` as soon as the call is
        // settled. `send` still ignores whichever arrives second.
        if (!settled) {
            watchdog = context.setTimeout(function () {
                send({
                    content: [createTextContent("The tool did not finish in time; check the game state before retrying.")],
                    isError: true
                });
            }, DEFERRED_TIMEOUT_MS);
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
