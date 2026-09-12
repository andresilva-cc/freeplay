import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import { createApplication } from "../src/app.ts";
import { BUILD_ID } from "../src/buildInfo.ts";
import { httpGet, httpPath } from "../src/controllers/decorators.ts";
import { registerControllers } from "../src/controllers/index.ts";
import { HttpController, type ControllerContext } from "../src/controllers/types.ts";
import { parseHttpRequest } from "../src/http/request.ts";
import { HttpRouter } from "../src/http/router.ts";

function parseJsonBody(response: { getBody(): string }): unknown {
    return JSON.parse(response.getBody());
}

function createRawRequest(method: string, path: string, headers: Record<string, string>, body?: string): string {
    const headerLines = Object.keys(headers).map(function (name) {
        return name + ": " + headers[name];
    });
    const requestLines = [method + " " + path + " HTTP/1.1"].concat(headerLines);

    return requestLines.join("\r\n") + "\r\n\r\n" + (body || "");
}

function createMcpHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json"
    };

    if (typeof extraHeaders !== "undefined") {
        Object.keys(extraHeaders).forEach(function (name) {
            headers[name] = extraHeaders[name];
        });
    }

    return headers;
}

let testControllerInstanceCount = 0;

class TestController extends HttpController {
    private readonly instanceId: number;

    public constructor(context: ControllerContext) {
        super(context);
        this.instanceId = testControllerInstanceCount + 1;
        testControllerInstanceCount = this.instanceId;
        this.response.headers["X-Constructed"] = "yes";
        if (typeof context.params.id !== "undefined") {
            this.response.headers["X-Constructed-Id"] = context.params.id;
        }
    }

    public echo(context: ControllerContext) {
        context.response.headers["X-Instance-Id"] = String(this.instanceId);
        return {
            customHeader: this.request.headers["x-custom"],
            queryValue: context.request.query.name,
            instanceId: this.instanceId
        };
    }

    public lookup({ request, response, params }: ControllerContext) {
        response.headers["X-Instance-Id"] = String(this.instanceId);
        return {
            customHeader: request.headers["x-custom"],
            queryValue: request.query.name,
            paramId: params.id,
            requestParamId: request.params.id,
            instanceId: this.instanceId
        };
    }
}

/** The descriptor a decorator is handed, refusing rather than passing `undefined` along. */
function descriptorOf(target: object, key: string): PropertyDescriptor {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);

    if (typeof descriptor === "undefined") {
        throw new Error("TestController has no method named " + key);
    }

    return descriptor;
}

httpPath("/v1/test")(TestController);
httpGet("/echo", {
    summary: "Echo request data",
    description: "Returns request header, query, and instance information.",
    responseDescription: "Echo response"
})(
    TestController.prototype,
    "echo",
    descriptorOf(TestController.prototype, "echo")
);
httpGet("/items/:id", {
    summary: "Lookup a param by id",
    description: "Returns the extracted URL parameter.",
    responseDescription: "Param lookup"
})(
    TestController.prototype,
    "lookup",
    descriptorOf(TestController.prototype, "lookup")
);

test("parseHttpRequest parses method, headers, query parameters, and body", function () {
    const request = parseHttpRequest(
        "POST /v1/date?format=json HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nX-Test: hello\r\n\r\n{\"ok\":true}"
    );

    assert.equal(request.method, "POST");
    assert.equal(request.path, "/v1/date");
    assert.equal(request.query.format, "json");
    assert.equal(request.headers["x-test"], "hello");
    assert.equal(request.getHeader("content-type"), "application/json");
    assert.equal(request.body, "{\"ok\":true}");
});

test("HttpRouter applies path middleware and serializes object results", function () {
    const router = new HttpRouter();

    router.use("/v1", function (_request, response, next) {
        response.setHeader("X-Trace", "enabled");
        return next();
    });

    router.registerRoute({
        method: "GET",
        path: "/v1/ping",
        operationId: "getPing",
        summary: "Ping the API",
        handler: function (request) {
            assert.equal(request.headers["x-custom"], "abc");
            return { ok: true };
        }
    });

    const response = router.handleRawRequest("GET /v1/ping HTTP/1.1\r\nX-Custom: abc\r\n\r\n");

    assert.equal(response.statusCode, 200);
    assert.equal(response.getHeader("x-trace"), "enabled");
    assert.deepEqual(parseJsonBody(response), { ok: true });
});

test("HttpRouter returns 405 and Allow when a path exists for another method", function () {
    const router = new HttpRouter();

    router.registerRoute({
        method: "GET",
        path: "/v1/resource",
        operationId: "getResource",
        summary: "Get a resource",
        handler: function () {
            return { ok: true };
        }
    });

    const response = router.handleRawRequest("POST /v1/resource HTTP/1.1\r\n\r\n");

    assert.equal(response.statusCode, 405);
    assert.equal(response.getHeader("allow"), "GET");
    assert.deepEqual(parseJsonBody(response), { error: "Method Not Allowed" });
});

test("registerControllers uses decorated controller classes and creates a new instance per request", function () {
    testControllerInstanceCount = 0;
    const router = new HttpRouter();
    const controllers = registerControllers(router, [TestController]);
    const firstResponse = router.handleRawRequest("GET /v1/test/echo?name=alpha HTTP/1.1\r\nX-Custom: abc\r\n\r\n");
    const secondResponse = router.handleRawRequest("GET /v1/test/echo?name=beta HTTP/1.1\r\nX-Custom: def\r\n\r\n");
    const paramResponse = router.handleRawRequest("GET /v1/test/items/21?name=gamma HTTP/1.1\r\nX-Custom: ghi\r\n\r\n");

    assert.equal(controllers[0].basePath, "/v1/test");
    assert.equal(controllers[0].routes[0].fullPath, "/v1/test/echo");
    assert.equal(controllers[0].routes[1].fullPath, "/v1/test/items/:id");
    assert.equal(firstResponse.getHeader("x-constructed"), "yes");
    assert.equal(firstResponse.getHeader("x-instance-id"), "1");
    assert.equal(secondResponse.getHeader("x-instance-id"), "2");
    assert.equal(paramResponse.getHeader("x-constructed"), "yes");
    assert.equal(paramResponse.getHeader("x-constructed-id"), "21");
    assert.equal(paramResponse.getHeader("x-instance-id"), "3");
    assert.deepEqual(parseJsonBody(firstResponse), {
        customHeader: "abc",
        queryValue: "alpha",
        instanceId: 1
    });
    assert.deepEqual(parseJsonBody(secondResponse), {
        customHeader: "def",
        queryValue: "beta",
        instanceId: 2
    });
    assert.deepEqual(parseJsonBody(paramResponse), {
        customHeader: "ghi",
        queryValue: "gamma",
        paramId: "21",
        requestParamId: "21",
        instanceId: 3
    });
});

test("createApplication provides the automatic /v1 index and date controller response", function () {
    const originalDate = (globalThis as unknown as Record<string, unknown>).date;
    const originalMap = (globalThis as unknown as Record<string, unknown>).map;
    const originalPark = (globalThis as unknown as Record<string, unknown>).park;
    (globalThis as unknown as Record<string, unknown>).date = {
        ticksElapsed: 123,
        monthsElapsed: 4,
        yearsElapsed: 5,
        monthProgress: 6,
        day: 7,
        month: 8,
        year: 9
    };
    (globalThis as unknown as Record<string, unknown>).map = {
        rides: [{}, {}],
        getRide: function (index: number) {
            if (index === 0) {
                return {
                    object: { identifier: "ride-1" },
                    id: 10,
                    type: "thrill",
                    classification: "coaster",
                    name: "Spiral",
                    status: "open",
                    price: 3.5
                };
            }

            if (index === 1) {
                return {
                    object: { identifier: "ride-21" },
                    id: 21,
                    type: "gentle",
                    classification: "family",
                    name: "Carousel",
                    status: "open",
                    price: 2.5
                };
            }

            return undefined;
        }
    };
    (globalThis as unknown as Record<string, unknown>).park = {
        name: "Mega Park",
        guests: 1234,
        rating: 999,
        cash: 45678,
        bankLoan: 2000,
        companyValue: 77777,
        value: 55555,
        entranceFee: 25
    };

    try {
        const app = createApplication();
        const indexResponse = app.handleRawRequest("GET /v1 HTTP/1.1\r\n\r\n");
        const dateResponse = app.handleRawRequest("GET /v1/date HTTP/1.1\r\n\r\n");
        const parkResponse = app.handleRawRequest("GET /v1/park HTTP/1.1\r\n\r\n");

        const index = parseJsonBody(indexResponse) as Record<string, unknown>;

        // Pinned as a whole: /v1 is what a pre-run check reads, so a field appearing or
        // disappearing is a change to that contract and should have to be said out loud.
        assert.deepEqual(Object.keys(index).sort(), ["buildId", "controllers", "stateGuards"]);
        assert.equal(index.buildId, BUILD_ID);
        assert.deepEqual(index.controllers, [
            {
                name: "date",
                path: "/v1/date",
                methods: ["GET"]
            },
            {
                name: "eval",
                path: "/v1/eval",
                methods: ["GET"]
            },
            {
                name: "park",
                path: "/v1/park",
                methods: ["GET"]
            },
            {
                name: "rides",
                path: "/v1/rides",
                methods: ["GET"]
            }
        ]);
        assert.deepEqual(Object.keys(index.stateGuards as object).sort(), ["frozen", "ok", "unfrozen"]);
        assert.deepEqual(parseJsonBody(dateResponse), {
            ticksElapsed: 123,
            monthsElapsed: 4,
            yearsElapsed: 5,
            monthProgress: 6,
            day: 7,
            month: 8,
            year: 9
        });
        assert.deepEqual(parseJsonBody(parkResponse), {
            name: "Mega Park",
            numGuests: 1234,
            rating: 999,
            cash: 45678,
            bankLoan: 2000,
            companyValue: 77777,
            parkValue: 55555,
            entranceFee: 25
        });
        const ridesResponse = app.handleRawRequest("GET /v1/rides/21 HTTP/1.1\r\n\r\n");
        assert.deepEqual(parseJsonBody(ridesResponse), {
            object: "ride-21",
            id: 21,
            type: "gentle",
            classification: "family",
            name: "Carousel",
            status: "open",
            price: 2.5
        });
    } finally {
        (globalThis as unknown as Record<string, unknown>).date = originalDate;
        (globalThis as unknown as Record<string, unknown>).map = originalMap;
        (globalThis as unknown as Record<string, unknown>).park = originalPark;
    }
});

test("createApplication redirects / to /dashboard and serves the dashboard page", function () {
    const app = createApplication();
    const redirectResponse = app.handleRawRequest("GET / HTTP/1.1\r\n\r\n");
    const dashboardResponse = app.handleRawRequest("GET /dashboard HTTP/1.1\r\n\r\n");
    const dashboardCssResponse = app.handleRawRequest("GET /static/dashboard.css HTTP/1.1\r\n\r\n");
    const dashboardJsResponse = app.handleRawRequest("GET /static/dashboard.js HTTP/1.1\r\n\r\n");

    assert.equal(redirectResponse.statusCode, 302);
    assert.equal(redirectResponse.getHeader("location"), "/dashboard");
    assert.equal(dashboardResponse.getHeader("content-type"), "text/html; charset=utf-8");
    assert.equal(dashboardCssResponse.getHeader("content-type"), "text/css; charset=utf-8");
    assert.equal(dashboardJsResponse.getHeader("content-type"), "text/javascript; charset=utf-8");
    assert.match(dashboardResponse.getBody(), /\/static\/dashboard\.css/);
    assert.match(dashboardResponse.getBody(), /\/static\/dashboard\.js/);
    assert.match(dashboardCssResponse.getBody(), /overflow:\s*hidden/);
    assert.match(dashboardJsResponse.getBody(), /ArrowUp/);
    assert.match(dashboardJsResponse.getBody(), /event\.ctrlKey/);
    assert.match(dashboardJsResponse.getBody(), /fetch\("\/v1\/eval\?q=" \+ encodeURIComponent\(command\)\)/);
});

test("createApplication preserves the /v1/eval controller", function () {
    const app = createApplication();
    const evalResponse = app.handleRawRequest("GET /v1/eval?q=1%2B1 HTTP/1.1\r\n\r\n");
    const missingQueryResponse = app.handleRawRequest("GET /v1/eval HTTP/1.1\r\n\r\n");

    assert.equal(evalResponse.getHeader("x-eval-endpoint"), "true");
    assert.deepEqual(parseJsonBody(evalResponse), {
        result: 2
    });
    assert.equal(missingQueryResponse.statusCode, 400);
    assert.deepEqual(parseJsonBody(missingQueryResponse), {
        error: "Missing q parameter"
    });
});

test("createApplication supports parameterized routes in OpenAPI output", function () {
    const app = createApplication();

    assert.match(app.getOpenApiYaml(), /"\/v1\/rides\/\{id\}":/);
    assert.match(app.getOpenApiYaml(), /name: "id"/);
});

test("createApplication exposes generated OpenAPI YAML and the /swagger page", function () {
    const app = createApplication();
    const openApiResponse = app.handleRawRequest("GET /openapi.yaml HTTP/1.1\r\n\r\n");
    const swaggerResponse = app.handleRawRequest("GET /swagger HTTP/1.1\r\n\r\n");

    assert.match(app.getOpenApiYaml(), /"\/v1\/date":/);
    assert.match(app.getOpenApiYaml(), /"\/v1\/eval":/);
    assert.match(openApiResponse.getBody(), /openapi: 3.1.0/);
    assert.equal(openApiResponse.getHeader("content-type"), "application/yaml; charset=utf-8");
    assert.equal(swaggerResponse.getHeader("content-type"), "text/html; charset=utf-8");
    assert.match(swaggerResponse.getBody(), /SwaggerUIBundle/);
    assert.match(swaggerResponse.getBody(), /\/openapi\.yaml/);
});

test("createApplication only allows POST for /mcp", function () {
    const app = createApplication();
    const response = app.handleRawRequest("GET /mcp HTTP/1.1\r\n\r\n");

    assert.equal(response.statusCode, 405);
    assert.equal(response.getHeader("allow"), "POST");
    assert.deepEqual(parseJsonBody(response), { error: "Method Not Allowed" });
});

test("createApplication implements the MCP initialize, tools/list, tools/call, and ping flow", function () {
    const app = createApplication();
    const originalDate = (globalThis as unknown as Record<string, unknown>).date;
    const originalPark = (globalThis as unknown as Record<string, unknown>).park;
    const originalContext = (globalThis as unknown as Record<string, unknown>).context;
    const originalUi = (globalThis as unknown as Record<string, unknown>).ui;
    const uiCalls: Array<{ title: string; message: string }> = [];
    (globalThis as unknown as Record<string, unknown>).date = {
        day: 10,
        month: 11,
        year: 12,
        monthsElapsed: 131
    };
    (globalThis as unknown as Record<string, unknown>).park = {
        name: "Mega Park",
        guests: 1234,
        rating: 999,
        cash: 45678,
        bankLoan: 2000,
        companyValue: 77777,
        value: 55555,
        entranceFee: 25
    };
    (globalThis as unknown as Record<string, unknown>).context = {
        formatString: function (_format: string, day: number, monthsElapsed: number) {
            return day + " / " + monthsElapsed;
        }
    };
    (globalThis as unknown as Record<string, unknown>).ui = {
        showError: function (title: string, message: string) {
            uiCalls.push({
                title: title,
                message: message
            });
        }
    };

    try {
        const initializeResponse = app.handleRawRequest(createRawRequest(
            "POST",
            "/mcp",
            createMcpHeaders(),
            JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2025-11-25",
                    capabilities: {},
                    clientInfo: {
                        name: "test-client",
                        version: "1.0.0"
                    }
                }
            })
        ));
        const initializeBody = parseJsonBody(initializeResponse) as {
            result: {
                protocolVersion: string;
                capabilities: {
                    tools: Record<string, never>;
                };
                serverInfo: {
                    name: string;
                };
            };
        };
        const sessionId = initializeResponse.getHeader("mcp-session-id");

        assert.equal(initializeResponse.statusCode, 200);
        assert.equal(initializeBody.result.protocolVersion, "2025-11-25");
        assert.equal(initializeBody.result.serverInfo.name, "freeplay-openrct2");
        assert.deepEqual(initializeBody.result.capabilities.tools, {});
        assert.equal(typeof sessionId, "string");

        const sessionHeaders = createMcpHeaders({
            "MCP-Session-Id": String(sessionId),
            "MCP-Protocol-Version": "2025-11-25"
        });
        const initializedResponse = app.handleRawRequest(createRawRequest(
            "POST",
            "/mcp",
            sessionHeaders,
            JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/initialized"
            })
        ));

        assert.equal(initializedResponse.statusCode, 202);
        assert.equal(initializedResponse.getBody(), "");

        const listResponse = app.handleRawRequest(createRawRequest(
            "POST",
            "/mcp",
            sessionHeaders,
            JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "tools/list"
            })
        ));
        const listBody = parseJsonBody(listResponse) as {
            result: {
                tools: Array<{
                    name: string;
                    title?: string;
                    inputSchema: {
                        type: string;
                        additionalProperties: boolean;
                        properties?: Record<string, unknown>;
                        required?: string[];
                    };
                    outputSchema?: {
                        type: string;
                        required: string[];
                    };
                    annotations?: {
                        readOnlyHint?: boolean;
                        destructiveHint?: boolean;
                    };
                }>;
            };
        };

        assert.equal(listResponse.statusCode, 200);

        const toolsByName: Record<string, (typeof listBody.result.tools)[number]> = {};
        listBody.result.tools.forEach(function (tool) {
            toolsByName[tool.name] = tool;
        });

        assert.deepEqual(
            Object.keys(toolsByName).sort(),
            ["build_flat_ride", "build_path", "buy_land", "clear_scenery", "evaluate", "find_build_sites", "guest_feedback", "hire_staff", "list_ride_objects", "open_park", "operate_ride", "park_status", "remove_path", "set_game_speed", "view_map", "wait"]
        );

        assert.equal(toolsByName.evaluate.annotations?.readOnlyHint, false);
        assert.equal(toolsByName.find_build_sites.annotations?.readOnlyHint, true);
        assert.equal(toolsByName.build_flat_ride.annotations?.readOnlyHint, false);
        assert.equal(toolsByName.build_path.annotations?.readOnlyHint, false);
        assert.equal(toolsByName.clear_scenery.annotations?.destructiveHint, true);
        assert.equal(toolsByName.park_status.annotations?.readOnlyHint, true);

        const callResponse = app.handleRawRequest(createRawRequest(
            "POST",
            "/mcp",
            sessionHeaders,
            JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: {
                    name: "evaluate",
                    arguments: { code: "1 + 1" }
                }
            })
        ));
        const callBody = parseJsonBody(callResponse) as {
            result: {
                content: Array<{ type: string; text: string }>;
                structuredContent: Record<string, string | number | boolean>;
            };
        };

        assert.equal(callResponse.statusCode, 200);
        assert.equal(callBody.result.content[0].type, "text");
        assert.equal(callBody.result.content[0].text, JSON.stringify(callBody.result.structuredContent));
        assert.deepEqual(callBody.result.structuredContent, { ok: true, result: 2 });

        const pingResponse = app.handleRawRequest(createRawRequest(
            "POST",
            "/mcp",
            sessionHeaders,
            JSON.stringify({
                jsonrpc: "2.0",
                id: 7,
                method: "ping"
            })
        ));

        assert.deepEqual(parseJsonBody(pingResponse), {
            jsonrpc: "2.0",
            id: 7,
            result: {}
        });
    } finally {
        (globalThis as unknown as Record<string, unknown>).date = originalDate;
        (globalThis as unknown as Record<string, unknown>).park = originalPark;
        (globalThis as unknown as Record<string, unknown>).context = originalContext;
        (globalThis as unknown as Record<string, unknown>).ui = originalUi;
    }
});

test("createApplication logs each request", function () {
    const app = createApplication();
    const originalLog = console.log;
    const messages: string[] = [];

    console.log = function (message?: unknown): void {
        messages.push(String(message));
    };

    try {
        app.handleRawRequest("GET /v1 HTTP/1.1\r\n\r\n");
    } finally {
        console.log = originalLog;
    }

    assert.equal(messages[messages.length - 1], "GET /v1 -- info");
});

test("createApplication runs the evaluate tool through tools/call", function () {
    const app = createApplication();

    const initializeResponse = app.handleRawRequest(createRawRequest(
        "POST",
        "/mcp",
        createMcpHeaders(),
        JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2025-11-25",
                capabilities: {},
                clientInfo: { name: "test-client", version: "1.0.0" }
            }
        })
    ));

    const sessionHeaders = createMcpHeaders({
        "MCP-Session-Id": String(initializeResponse.getHeader("mcp-session-id")),
        "MCP-Protocol-Version": "2025-11-25"
    });

    app.handleRawRequest(createRawRequest(
        "POST",
        "/mcp",
        sessionHeaders,
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    ));

    const callResponse = app.handleRawRequest(createRawRequest(
        "POST",
        "/mcp",
        sessionHeaders,
        JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
                name: "evaluate",
                arguments: { code: "21 * 2" }
            }
        })
    ));

    const callBody = parseJsonBody(callResponse) as {
        result: {
            structuredContent: { ok: boolean; result: unknown };
            content: Array<{ type: string; text: string }>;
        };
    };

    assert.equal(callResponse.statusCode, 200);
    assert.deepEqual(callBody.result.structuredContent, { ok: true, result: 42 });
    assert.equal(callBody.result.content[0].text, JSON.stringify({ ok: true, result: 42 }));
});

test("createApplication reports a failing evaluate script without a transport error", function () {
    const app = createApplication();

    const initializeResponse = app.handleRawRequest(createRawRequest(
        "POST",
        "/mcp",
        createMcpHeaders(),
        JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2025-11-25",
                capabilities: {},
                clientInfo: { name: "test-client", version: "1.0.0" }
            }
        })
    ));

    const sessionHeaders = createMcpHeaders({
        "MCP-Session-Id": String(initializeResponse.getHeader("mcp-session-id")),
        "MCP-Protocol-Version": "2025-11-25"
    });

    app.handleRawRequest(createRawRequest(
        "POST",
        "/mcp",
        sessionHeaders,
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    ));

    const callResponse = app.handleRawRequest(createRawRequest(
        "POST",
        "/mcp",
        sessionHeaders,
        JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
                name: "evaluate",
                arguments: { code: "noSuchGlobal.doThing()" }
            }
        })
    ));

    const callBody = parseJsonBody(callResponse) as {
        result: { structuredContent: { ok: boolean; error: string } };
    };

    assert.equal(callResponse.statusCode, 200);
    assert.equal(callBody.result.structuredContent.ok, false);
    assert.match(callBody.result.structuredContent.error, /noSuchGlobal/);
});

test("find_build_sites hands back a door the model can build on", function () {
    // The end-to-end twin of scripting.test.ts: every access option sits deep enough in
    // the result to be cut by a tight depth limit, and a cut one reads as the string
    // "<object depth limit>" where a door tile should be.
    const game = new FakeGame(32, 32);
    game.rideObjects = [{ index: 0, name: "Merry-Go-Round", rideType: [33] }];
    game.addParkEntrance(10, 2);

    for (let y = 3; y <= 20; y++) {
        game.addPath(10, y);
    }

    const restore = game.install();

    try {
        const app = createApplication();

        const initializeResponse = app.handleRawRequest(createRawRequest(
            "POST",
            "/mcp",
            createMcpHeaders(),
            JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2025-11-25",
                    capabilities: {},
                    clientInfo: { name: "test-client", version: "1.0.0" }
                }
            })
        ));

        const sessionHeaders = createMcpHeaders({
            "MCP-Session-Id": String(initializeResponse.getHeader("mcp-session-id")),
            "MCP-Protocol-Version": "2025-11-25"
        });

        app.handleRawRequest(createRawRequest(
            "POST",
            "/mcp",
            sessionHeaders,
            JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
        ));

        const callResponse = app.handleRawRequest(createRawRequest(
            "POST",
            "/mcp",
            sessionHeaders,
            JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: {
                    name: "find_build_sites",
                    arguments: { rideObject: 0, limit: 1 }
                }
            })
        ));

        const callBody = parseJsonBody(callResponse) as {
            result: {
                structuredContent: {
                    ok: boolean;
                    sites: { access: { door: { x: unknown; y: unknown } }[] }[];
                };
            };
        };

        assert.equal(callBody.result.structuredContent.ok, true);

        const sites = callBody.result.structuredContent.sites;
        assert.ok(sites.length > 0, "this park has room for a carousel");

        const option = sites[0].access[0];
        assert.equal(typeof option, "object", "an access option must arrive as an object, not as: " + JSON.stringify(option));

        assert.equal(typeof option.door.x, "number", "the door needs a real x to build on, got: " + JSON.stringify(option.door));
        assert.equal(typeof option.door.y, "number", "the door needs a real y to build on, got: " + JSON.stringify(option.door));
    } finally {
        restore();
    }
});
