import assert from "node:assert/strict";
import test from "node:test";

import { FakeSocket, responsesOn, soleToolResult } from "./fakeSocket.ts";
import type { HttpMessage } from "./fakeSocket.ts";
import { createApplication } from "../src/app.ts";
import type { Application } from "../src/app.ts";
import { createRequestContext } from "../src/http/connection.ts";
import { parseHttpRequest } from "../src/http/request.ts";
import { HttpResponse } from "../src/http/response.ts";
import { McpServer } from "../src/mcp.ts";
import { getMcpToolDefinitions } from "../src/tools/decorators.ts";
import { getMcpToolControllers } from "../src/tools/index.ts";
import { ParkTools } from "../src/tools/park.ts";
import type { McpToolDefinition, McpToolSchema } from "../src/tools/index.ts";

/**
 * The MCP layer is the last thing between a 35B model's JSON and a game action, and it is
 * the only place the published schemas are enforced. Everything here drives it the way the
 * model reaches it - a real session, a real `tools/call` - and checks two things: that a
 * refusal happens at all, and that its wording names the property, the value and the fix.
 * A refusal that names only a category ("Value out of range") is one the model cannot act
 * on, which is the failure these tests exist to prevent.
 *
 * None of the argument tests need a game installed: an argument the schema rejects must
 * never reach a tool, so a missing `map` global is itself part of the assertion.
 */

interface Responder {
    statusCode: number;
    getBody(): string;
    getHeader(name: string): string | undefined;
}

type Post = (body: string, headers: Record<string, string>) => Responder;

interface ToolResult {
    content?: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
}

function baseHeaders(): Record<string, string> {
    return {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json"
    };
}

function rawRequest(body: string, headers: Record<string, string>): string {
    const lines = ["POST /mcp HTTP/1.1"].concat(Object.keys(headers).map(function (name) {
        return name + ": " + headers[name];
    }));

    return lines.join("\r\n") + "\r\n\r\n" + body;
}

/** The whole plugin, as the game serves it. */
function postToApplication(): Post {
    const app = createApplication();

    return function (body, headers) {
        return app.handleRawRequest(rawRequest(body, headers));
    };
}

/** One MCP server on its own, so a test can register a tool of its own on it. */
function postToServer(server: McpServer): Post {
    return function (body, headers) {
        return server.handlePost(parseHttpRequest(rawRequest(body, headers)), new HttpResponse());
    };
}

function openSession(post: Post): Record<string, string> {
    const response = post(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" }
        }
    }), baseHeaders());

    const headers = baseHeaders();
    headers["MCP-Session-Id"] = String(response.getHeader("mcp-session-id"));
    headers["MCP-Protocol-Version"] = "2025-11-25";

    post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), headers);

    return headers;
}

function callTool(post: Post, headers: Record<string, string>, name: string, args: Record<string, unknown>): ToolResult {
    const response = post(JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: name, arguments: args }
    }), headers);

    const body = JSON.parse(response.getBody()) as { result?: ToolResult };

    assert.ok(body.result, name + " answered with no result: " + response.getBody());
    return body.result as ToolResult;
}

/** The text of a refusal, or a failure if the arguments were let through. */
function refusal(result: ToolResult): string {
    assert.equal(result.isError, true, "the arguments were accepted: " + JSON.stringify(result));
    assert.ok(result.content && result.content.length > 0, "a refusal with no message is unusable");
    return (result.content as { text: string }[])[0].text;
}

function structured(result: ToolResult): Record<string, unknown> {
    assert.notEqual(result.isError, true, "the call was refused: " + JSON.stringify(result.content));
    assert.ok(result.structuredContent, "the tool answered with no structured result");
    return result.structuredContent as Record<string, unknown>;
}

/**
 * A native OpenRCT2 object in miniature: its data is on prototype getters, so
 * JSON.stringify alone sees `{}` and the model is handed an empty field.
 */
class NativeRide {
    public get name(): string {
        return "Spiral";
    }

    public get excitement(): number {
        return 7;
    }
}

const probeCalls: Record<string, unknown>[] = [];

class ProbeTools {
    public probe(args: Record<string, unknown>): unknown {
        probeCalls.push(args);
        return { ok: true, ride: new NativeRide() };
    }
}

const probeTool: McpToolDefinition = {
    controllerClass: ProbeTools,
    handlerName: "probe",
    name: "probe",
    inputSchema: {
        type: "object",
        properties: {
            interval: { type: "integer", minimum: 0, maximum: 6, enum: [0, 1, 2, 3, 4, 5, 6] },
            sample: { type: "integer", minimum: 1, maximum: 500 },
            depth: { type: "integer", minimum: 0 },
            mode: { type: "string", enum: ["open", "closed"] },
            label: { type: "string" }
        },
        required: [],
        additionalProperties: false
    }
};

/**
 * `tools`/`toolsByName` are private to the server; a test tool has to go in from outside
 * because the registry is a fixed list. Nothing else reaches these fields.
 */
function serverWithProbeTool(): McpServer {
    const server = new McpServer();
    const internals = server as unknown as {
        tools: McpToolDefinition[];
        toolsByName: Record<string, McpToolDefinition | undefined>;
    };

    internals.tools.push(probeTool);
    internals.toolsByName[probeTool.name] = probeTool;
    probeCalls.length = 0;

    return server;
}

test("a required property left out is refused by name, before the game is touched", function () {
    const post = postToApplication();
    const headers = openSession(post);

    // No `map` global exists in this test: reaching the tool at all would throw.
    const message = refusal(callTool(post, headers, "operate_ride", { open: true }));

    assert.match(message, /Missing required property: ride/);
    assert.match(message, /integer/, "and says what shape the missing argument has");
});

test("a property of the wrong primitive type names the property and both types", function () {
    const post = postToApplication();
    const headers = openSession(post);

    const message = refusal(callTool(post, headers, "guest_feedback", { sample: "100" }));

    assert.match(message, /sample/, "the offending property has to be named");
    assert.match(message, /expected integer/, "the type it wanted");
    assert.match(message, /string "100"/, "and the type and value that arrived");
});

test("a fractional number is refused where the schema declares an integer", function () {
    const post = postToApplication();
    const headers = openSession(post);

    const message = refusal(callTool(post, headers, "operate_ride", { ride: 1.5 }));

    assert.match(message, /ride/);
    assert.match(message, /expected integer/);
    assert.match(message, /1\.5/, "the value that was sent has to be quoted back");
});

test("an unknown property is rejected by name, with the properties that do exist", function () {
    const post = postToApplication();
    const headers = openSession(post);

    const message = refusal(callTool(post, headers, "operate_ride", { ride: 0, colour: 2 }));

    assert.match(message, /Unexpected property: colour/);
    assert.match(message, /inspectionInterval/, "the real property names are the fix for a wrong one");

    // A tool that takes nothing has to say so rather than list an empty set.
    const noArguments = refusal(callTool(post, headers, "park_status", { verbose: true }));

    assert.match(noArguments, /Unexpected property: verbose/);
    assert.match(noArguments, /takes no arguments/);
});

test("a number outside its declared range is refused with the range", function () {
    const post = postToApplication();
    const headers = openSession(post);

    const tooMany = refusal(callTool(post, headers, "guest_feedback", { sample: 900 }));

    assert.match(tooMany, /sample/);
    assert.match(tooMany, /1 to 500/, "the legal range has to be in the message");
    assert.match(tooMany, /900/, "next to the value that was refused");

    const tooExpensive = refusal(callTool(post, headers, "operate_ride", { ride: 0, price: 5000 }));

    assert.match(tooExpensive, /price/);
    assert.match(tooExpensive, /0 to 2000/);
});

test("an out-of-enum value is refused with the values that are legal", function () {
    const post = postToApplication();
    const headers = openSession(post);

    // The real one: 30 read as thirty minutes. The game answers this with "Value out of
    // range", naming none of the five arguments, and the model cannot tell which was wrong.
    const message = refusal(callTool(post, headers, "operate_ride", { ride: 0, inspectionInterval: 30 }));

    assert.match(message, /inspectionInterval/, "which of the arguments was wrong");
    assert.match(message, /0, 1, 2, 3, 4, 5, 6/, "and the whole set it had to choose from");
    assert.match(message, /30/);
});

test("values on the edge of a declared range are accepted, not refused", function () {
    const post = postToServer(serverWithProbeTool());
    const headers = openSession(post);

    [
        { interval: 0 },
        { interval: 6 },
        { sample: 1 },
        { sample: 500 },
        { depth: 0 },
        { mode: "open" },
        {}
    ].forEach(function (args) {
        const body = structured(callTool(post, headers, "probe", args));
        assert.equal(body.ok, true, "these arguments are legal: " + JSON.stringify(args));
    });

    assert.equal(probeCalls.length, 7, "every legal call has to have reached the tool");
});

test("a string outside its enum, and a bare minimum, are enforced too", function () {
    const post = postToServer(serverWithProbeTool());
    const headers = openSession(post);

    const mode = refusal(callTool(post, headers, "probe", { mode: "ajar" }));
    assert.match(mode, /mode/);
    assert.match(mode, /"open", "closed"/);
    assert.match(mode, /"ajar"/);

    const depth = refusal(callTool(post, headers, "probe", { depth: -1 }));
    assert.match(depth, /depth/);
    assert.match(depth, /0 or more/, "a lone minimum reads as a floor, not as a range");

    assert.equal(probeCalls.length, 0, "neither call may have reached the tool");
});

test("a tool result behind prototype getters comes back populated", function () {
    // Native game objects keep their data on prototype getters, so an unsanitised result
    // serialises as {} and silently empties a field the tool promised.
    const post = postToServer(serverWithProbeTool());
    const headers = openSession(post);

    const result = callTool(post, headers, "probe", {});
    const body = structured(result);
    const ride = body.ride as Record<string, unknown>;

    assert.deepEqual(ride, { name: "Spiral", excitement: 7 }, "the getters have to be read, not skipped");
    assert.equal(
        (result.content as { text: string }[])[0].text,
        JSON.stringify(body),
        "and the text copy has to be the same object, not a second serialisation"
    );
});

test("a request without a session id is refused rather than served", function () {
    const post = postToApplication();
    openSession(post);

    const response = post(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }), baseHeaders());

    assert.equal(response.statusCode, 400, "a session-less request must not be answered: " + response.getBody());
    assert.match(response.getBody(), /MCP-Session-Id/);

    const headers = baseHeaders();
    headers["MCP-Session-Id"] = "mcp-not-a-session";

    const unknownSession = post(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }), headers);

    assert.equal(unknownSession.statusCode, 404);
    assert.match(unknownSession.getBody(), /Unknown MCP session/);
});

const COUNT_WORDS: Record<string, number | undefined> = {
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15
};

test("the instructions name every tool, and count them correctly", function () {
    // The model reads this once per session and cannot check it. A tool added without a
    // mention here is one it never learns exists, and a stale count reads as a truncated list.
    const post = postToApplication();
    const headers = baseHeaders();

    const response = post(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" }
        }
    }), headers);

    const instructions = String((JSON.parse(response.getBody()) as {
        result: { instructions?: string };
    }).result.instructions);

    const sessionHeaders = openSession(post);
    const listed = (JSON.parse(post(JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/list"
    }), sessionHeaders).getBody()) as { result: { tools: { name: string }[] } }).result.tools;

    listed.forEach(function (tool) {
        assert.ok(instructions.indexOf(tool.name) >= 0, tool.name + " is not mentioned in the instructions");
    });

    const countWord = /^(\w+) tools/.exec(instructions);
    assert.ok(countWord, "the instructions have to open by saying how many tools there are");
    assert.equal(COUNT_WORDS[countWord[1].toLowerCase()], listed.length,
        "the instructions say " + countWord[1] + " tools, but " + String(listed.length) + " are registered");
});

test("no registered tool declares an outputSchema, and the one class that does is not registered", function () {
    const post = postToApplication();
    const headers = openSession(post);

    const response = post(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }), headers);
    const body = JSON.parse(response.getBody()) as {
        result: { tools: { name: string; outputSchema?: unknown }[] };
    };

    body.result.tools.forEach(function (tool) {
        // Output validation is live on both paths, so a schema added here is enforced from
        // that moment: it has to be declared knowing that, not inherited by accident.
        assert.equal(typeof tool.outputSchema, "undefined", tool.name + " now declares an outputSchema");
    });

    assert.equal(getMcpToolControllers().indexOf(ParkTools), -1, "ParkTools is deliberately not registered");
    assert.notEqual(typeof getMcpToolDefinitions(ParkTools)[0].outputSchema, "undefined",
        "ParkTools is the class the audit found, and it still declares one");
});

/* ---------------------------------------------------------------------------------------
 * Transport guards.
 *
 * The plugin listens on a loopback TCP port from inside the running game, so anything on
 * the player's machine - including a web page they happen to have open - can POST to it.
 * Five guards stand in front of the tools, and until now every test in the suite opened a
 * session with correct headers and never probed a refusal, so all five could be deleted
 * with the suite still green.
 *
 * These drive the plugin over a socket and assert on the bytes the client received. A
 * refusal that only exists on a response object is not a refusal. The reason phrase is
 * deliberately not asserted: HttpResponse has no text for 202 or 403 and writes "OK" for
 * both, which is a wart in src/http/response.ts rather than something to pin here.
 */

const PROTOCOL_VERSION = "2025-11-25";

const INITIALIZE_BODY = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" }
    }
});

/** The game globals the deferred path reaches for, typed without pulling in the game. */
const gameScope = globalThis as unknown as {
    context: {
        setTimeout(callback: () => void, delay?: number): number;
        clearTimeout(handle: number): void;
    };
};

function headersWith(extra: Record<string, string>): Record<string, string> {
    const headers = baseHeaders();

    Object.keys(extra).forEach(function (name) {
        headers[name] = extra[name];
    });

    return headers;
}

/** Headers carrying exactly the given Accept, or none at all when it is left out. */
function withAccept(accept?: string): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    if (typeof accept === "string") {
        headers.Accept = accept;
    }

    return headers;
}

/** One POST over a socket, answered as the plugin's connection handler answers it. */
function postBytes(app: Application, body: string, headers: Record<string, string>): HttpMessage {
    const socket = new FakeSocket();
    const result = app.handleSocketRequest(rawRequest(body, headers), socket);

    if (!result.context.connection.hijacked) {
        socket.end(result.response.toHttpString());
    }

    const messages = responsesOn(socket);

    assert.equal(messages.length, 1, "expected exactly one HTTP response, got "
        + String(messages.length) + ": " + JSON.stringify(socket.written));

    return messages[0];
}

function errorOf(message: HttpMessage): { code: number; message: string } {
    const payload = JSON.parse(message.body) as { error?: { code: number; message: string } };

    assert.ok(payload.error, "the request was served rather than refused: " + message.body);
    return payload.error as { code: number; message: string };
}

/** A fully handshaken session, opened over a socket, as headers for the calls that follow. */
function openSessionOverSocket(app: Application): Record<string, string> {
    const opened = postBytes(app, INITIALIZE_BODY, baseHeaders());

    assert.equal(opened.statusCode, 200, "the session could not be opened: " + opened.body);

    const headers = headersWith({
        "MCP-Session-Id": String(opened.headers["mcp-session-id"]),
        "MCP-Protocol-Version": PROTOCOL_VERSION
    });

    assert.equal(postBytes(app, JSON.stringify({
        jsonrpc: "2.0", method: "notifications/initialized"
    }), headers).statusCode, 202);

    return headers;
}

test("an origin the player did not come from never reaches the game", function () {
    const app = createApplication();
    const forbidden = postBytes(app, INITIALIZE_BODY, headersWith({ Origin: "http://evil.test" }));

    assert.equal(forbidden.statusCode, 403, "a page on another site must not be served: " + forbidden.body);
    assert.equal(typeof forbidden.headers["mcp-session-id"], "undefined",
        "and must not be handed a session to go on with");

    const error = errorOf(forbidden);
    assert.equal(error.code, -32600);
    assert.match(error.message, /Forbidden origin/);
});

test("the callers that are meant to reach it still do", function () {
    const app = createApplication();

    [
        { Origin: "http://localhost:8080" },
        { Origin: "http://127.0.0.1:8080" },
        { Origin: "http://localhost" },
        { Origin: "HTTP://LOCALHOST:8080" },
        // An MCP client over plain HTTP sends no Origin header at all; refusing that would
        // lock every real client out.
        {}
    ].forEach(function (extra) {
        const allowed = postBytes(app, INITIALIZE_BODY, headersWith(extra));

        assert.equal(allowed.statusCode, 200, JSON.stringify(extra) + " is a legitimate caller: " + allowed.body);
        assert.equal(typeof allowed.headers["mcp-session-id"], "string",
            JSON.stringify(extra) + " got no session");
    });
});

test("a host that merely starts with localhost is not this machine", function () {
    // The guard was a prefix match and let all of these through. `localhost.evil.test` is a
    // name anyone can register and point wherever they like, and `null` is the origin a
    // sandboxed iframe sends - which any page can obtain, so honouring it removed the
    // guard entirely.
    const app = createApplication();

    [
        "http://localhost.evil.test",
        "http://127.0.0.1.evil.test",
        "http://localhost:8080.evil.test",
        "http://127.0.0.1evil.test",
        "null",
        "https://localhost:8080",
        "http://evil.test/localhost",
        "http://evil.test?x=http://localhost"
    ].forEach(function (origin) {
        const response = postBytes(app, INITIALIZE_BODY, headersWith({ Origin: origin }));

        assert.equal(response.statusCode, 403, origin + " is not the machine the game runs on: " + response.body);
    });
});

test("a POST that cannot read both of the transport's media types is refused", function () {
    // Streamable HTTP answers either with JSON or with an SSE stream and chooses per
    // request, so a client naming only one of them cannot be answered at all.
    const app = createApplication();

    [undefined, "application/json", "text/event-stream", "*/*", "text/plain"].forEach(function (accept) {
        const response = postBytes(app, INITIALIZE_BODY, withAccept(accept));

        assert.equal(response.statusCode, 400, String(accept) + " must be refused: " + response.body);
        assert.match(response.body, /must accept application\/json and text\/event-stream/);
        assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
        assert.equal(typeof response.headers["mcp-session-id"], "undefined",
            "a refused request must not open a session");
    });

    [
        "application/json, text/event-stream",
        "text/event-stream, application/json",
        "application/json;q=0.9, text/event-stream;q=0.8",
        "APPLICATION/JSON, TEXT/EVENT-STREAM",
        "text/html, application/json, text/event-stream"
    ].forEach(function (accept) {
        const response = postBytes(app, INITIALIZE_BODY, withAccept(accept));

        assert.equal(response.statusCode, 200, accept + " names both types: " + response.body);
    });
});

test("a session that never finished its handshake cannot call tools", function () {
    const app = createApplication();
    const opened = postBytes(app, INITIALIZE_BODY, baseHeaders());
    const headers = headersWith({
        "MCP-Session-Id": String(opened.headers["mcp-session-id"]),
        "MCP-Protocol-Version": PROTOCOL_VERSION
    });

    // No notifications/initialized has been sent.
    [
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "park_status", arguments: {} } }
    ].forEach(function (message) {
        const response = postBytes(app, JSON.stringify(message), headers);

        assert.equal(response.statusCode, 200, "a half-open session is a protocol error, not a transport one");

        const error = errorOf(response);
        assert.equal(error.code, -32600);
        assert.equal(error.message, "Session not initialized");
    });

    // `ping` is the one thing the handshake deliberately lets past, so a client can check
    // the server is alive before committing to it.
    const ping = postBytes(app, JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }), headers);

    assert.deepEqual(JSON.parse(ping.body), { jsonrpc: "2.0", id: 4, result: {} });

    const initialized = postBytes(app, JSON.stringify({
        jsonrpc: "2.0", method: "notifications/initialized"
    }), headers);

    assert.equal(initialized.statusCode, 202);
    assert.equal(initialized.body, "");

    const afterHandshake = postBytes(app, JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }), headers);
    const listed = (JSON.parse(afterHandshake.body) as { result: { tools: unknown[] } }).result;

    assert.ok(listed.tools.length > 0, "the same call has to work once the handshake finished");
});

test("a protocol version this server does not speak is refused", function () {
    const app = createApplication();
    const headers = openSessionOverSocket(app);

    const stale = postBytes(app, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }), headersWith({
        "MCP-Session-Id": headers["MCP-Session-Id"],
        "MCP-Protocol-Version": "2024-01-01"
    }));

    assert.equal(stale.statusCode, 400, "a version this server cannot honour must not be served: " + stale.body);
    assert.match(stale.body, /Unsupported MCP-Protocol-Version/);

    const current = postBytes(app, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }), headers);

    assert.equal(current.statusCode, 200);
    assert.equal(current.headers["mcp-protocol-version"], PROTOCOL_VERSION,
        "and every served answer says which version it was served under");

    // A client that sends no version header is taken at the session's word. That is the
    // spec's compatibility rule, pinned here so it reads as a decision rather than a hole.
    const unversioned = postBytes(app, JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }), headersWith({
        "MCP-Session-Id": headers["MCP-Session-Id"]
    }));

    assert.equal(unversioned.statusCode, 200);
});

test("a tool name the server does not have is refused by name", function () {
    const app = createApplication();
    const headers = openSessionOverSocket(app);

    const unknown = postBytes(app, JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "no_such_tool", arguments: {} }
    }), headers);

    assert.equal(unknown.statusCode, 200, "a wrong tool name is the caller's error, not a transport failure");

    const error = errorOf(unknown);
    assert.equal(error.code, -32602);
    assert.match(error.message, /no_such_tool/, "the model has to be told which name it got wrong");

    // A call carrying no name at all is the same class of error and must not reach a tool.
    const nameless = postBytes(app, JSON.stringify({
        jsonrpc: "2.0", id: 3, method: "tools/call", params: {}
    }), headers);

    assert.equal(errorOf(nameless).code, -32602);
});

/* ---------------------------------------------------------------------------------------
 * Output schemas.
 *
 * `checkToolOutput` is shared by the immediate and the deferred path, and no shipped tool
 * declares an outputSchema - which is pinned deliberately above - so the mechanism was
 * proved on neither. These register tools that break their own declared schema, one on
 * each path.
 */

const TILES_SCHEMA: McpToolSchema = {
    type: "object",
    properties: { tiles: { type: "integer" } },
    required: ["tiles"]
};

function deferring(value: unknown): unknown {
    return {
        deferred: true,
        start: function (resolve: (resolved: unknown) => void): void {
            // A game tick later, which is what makes "answered" and "timed out" separable.
            gameScope.context.setTimeout(function () {
                resolve(value);
            }, 1);
        }
    };
}

class OutputSchemaTools {
    public immediateBad(): unknown {
        return { tiles: "nine" };
    }

    public immediateGood(): unknown {
        return { tiles: 9 };
    }

    public immediateUnstructured(): unknown {
        return "nine tiles";
    }

    public deferredBad(): unknown {
        return deferring({ tiles: "nine" });
    }

    public deferredGood(): unknown {
        return deferring({ tiles: 9 });
    }
}

function outputSchemaTool(name: string, handlerName: string): McpToolDefinition {
    return {
        controllerClass: OutputSchemaTools,
        handlerName: handlerName,
        name: name,
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
        outputSchema: TILES_SCHEMA
    };
}

const outputSchemaTools = [
    outputSchemaTool("immediate_bad", "immediateBad"),
    outputSchemaTool("immediate_good", "immediateGood"),
    outputSchemaTool("immediate_unstructured", "immediateUnstructured"),
    outputSchemaTool("deferred_bad", "deferredBad"),
    outputSchemaTool("deferred_good", "deferredGood")
];

function serverWithOutputSchemaTools(): McpServer {
    const server = new McpServer();
    const internals = server as unknown as {
        tools: McpToolDefinition[];
        toolsByName: Record<string, McpToolDefinition | undefined>;
    };

    outputSchemaTools.forEach(function (tool) {
        internals.tools.push(tool);
        internals.toolsByName[tool.name] = tool;
    });

    return server;
}

interface FakeTimer {
    handle: number;
    callback: () => void;
}

interface TestClock {
    /** Watchdogs still armed: the MCP layer's 30 second guard on a deferred call. */
    readonly watchdogs: number;
    /** Run the work a deferred tool is waiting on a game tick for. */
    runSteps(): void;
    /** Let every armed watchdog fire, as if 30 seconds had passed. */
    fireWatchdogs(): void;
    restore(): void;
}

/**
 * Control over game time. Tool work and the watchdog both go through
 * `context.setTimeout`, so separating the queues is what makes "the caller was told what
 * was wrong" distinguishable from "the caller waited out the watchdog".
 */
function installClock(): TestClock {
    const original = gameScope.context;
    const steps: FakeTimer[] = [];
    const watchdogs: FakeTimer[] = [];
    let nextHandle = 0;

    gameScope.context = {
        setTimeout: function (callback: () => void, delay?: number): number {
            const timer = { handle: ++nextHandle, callback: callback };

            (typeof delay === "number" && delay >= 1000 ? watchdogs : steps).push(timer);
            return timer.handle;
        },
        clearTimeout: function (handle: number): void {
            [steps, watchdogs].forEach(function (queue) {
                for (let i = queue.length - 1; i >= 0; i--) {
                    if (queue[i].handle === handle) {
                        queue.splice(i, 1);
                    }
                }
            });
        }
    };

    const run = function (queue: FakeTimer[]): void {
        let guard = 0;

        while (queue.length > 0) {
            if (++guard > 100) {
                throw new Error("a deferred tool kept scheduling work and never settled");
            }

            (queue.shift() as FakeTimer).callback();
        }
    };

    return {
        get watchdogs() { return watchdogs.length; },
        runSteps: function () { run(steps); },
        fireWatchdogs: function () { run(watchdogs); },
        restore: function () { gameScope.context = original; }
    };
}

/** A tools/call over a socket the deferred path can take over, as the plugin serves it. */
function callToolOverSocket(
    server: McpServer,
    headers: Record<string, string>,
    id: string | number,
    name: string
): FakeSocket {
    const socket = new FakeSocket();
    const context = createRequestContext(socket);
    const response = server.handlePost(parseHttpRequest(rawRequest(JSON.stringify({
        jsonrpc: "2.0", id: id, method: "tools/call",
        params: { name: name, arguments: {} }
    }), headers)), new HttpResponse(), context);

    if (!context.connection.hijacked) {
        socket.end(response.toHttpString());
    }

    return socket;
}

test("a deferred result that breaks its own outputSchema is reported, not waited out", function () {
    const server = serverWithOutputSchemaTools();
    const headers = openSession(postToServer(server));
    const clock = installClock();

    try {
        const socket = callToolOverSocket(server, headers, 2, "deferred_bad");

        assert.equal(socket.written, "", "the tool has not finished yet");
        assert.equal(clock.watchdogs, 1, "and its watchdog is armed behind it");

        clock.runSteps();

        const result = soleToolResult(socket, 2);
        const text = String((result.content as { text: string }[])[0].text);

        assert.equal(result.isError, true, "a result that breaks its declared schema is not a success");
        assert.match(text, /output failed schema validation for deferred_bad/);
        assert.match(text, /tiles/, "and names the property that was wrong");
        assert.match(text, /expected integer, got string "nine"/);
        assert.equal(clock.watchdogs, 0, "the caller must not be left waiting out the 30 second watchdog");

        clock.fireWatchdogs();
        assert.equal(socket.chunks.length, 1, "and nothing may answer a second time");
    } finally {
        clock.restore();
    }
});

test("a deferred result that honours its outputSchema is served as it stands", function () {
    const server = serverWithOutputSchemaTools();
    const headers = openSession(postToServer(server));
    const clock = installClock();

    try {
        const socket = callToolOverSocket(server, headers, "call-9", "deferred_good");
        clock.runSteps();

        const result = soleToolResult(socket, "call-9");

        assert.equal(result.isError, undefined, "the check must not refuse a result that conforms");
        assert.deepEqual(result.structuredContent, { tiles: 9 });
        assert.equal(clock.watchdogs, 0);
    } finally {
        clock.restore();
    }
});

test("an immediate result that breaks its own outputSchema is never handed to the caller", function () {
    const server = serverWithOutputSchemaTools();
    const post = postToServer(server);
    const headers = openSession(post);

    assert.throws(function () {
        post(JSON.stringify({
            jsonrpc: "2.0", id: 2, method: "tools/call",
            params: { name: "immediate_bad", arguments: {} }
        }), headers);
    }, /output failed schema validation for immediate_bad/,
    "the immediate path stops the response being built at all");

    // A tool that declares a structured schema and answers with a bare string has broken
    // the same promise, and used to pass because there was no structuredContent to check.
    assert.throws(function () {
        post(JSON.stringify({
            jsonrpc: "2.0", id: 3, method: "tools/call",
            params: { name: "immediate_unstructured", arguments: {} }
        }), headers);
    }, /declares an outputSchema but answered with no structured content/);

    assert.deepEqual(structured(callTool(post, headers, "immediate_good", {})), { tiles: 9 },
        "a conforming result still goes through untouched");
});
