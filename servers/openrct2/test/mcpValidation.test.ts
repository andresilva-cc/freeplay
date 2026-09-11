import assert from "node:assert/strict";
import test from "node:test";

import { createApplication } from "../src/app.ts";
import { parseHttpRequest } from "../src/http/request.ts";
import { HttpResponse } from "../src/http/response.ts";
import { McpServer } from "../src/mcp.ts";
import { getMcpToolDefinitions } from "../src/tools/decorators.ts";
import { getMcpToolControllers } from "../src/tools/index.ts";
import { ParkTools } from "../src/tools/park.ts";
import type { McpToolDefinition } from "../src/tools/index.ts";

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
