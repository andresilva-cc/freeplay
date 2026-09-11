import type { ControllerDefinition } from "./controllers/index.js";
import { getControllers, registerControllers } from "./controllers/index.js";
import { createRequestContext } from "./http/connection.js";
import { generateOpenApiYaml } from "./http/openapi.js";
import type { HttpResponse } from "./http/response.js";
import { HttpRouter } from "./http/router.js";
import type { Middleware, RequestHandlingResult, SocketLike } from "./http/types.js";
import { McpServer } from "./mcp.js";
import { embeddedStaticFiles } from "./embeddedStaticAssets.js";
import { BUILD_ID } from "./buildInfo.js";
import { installStateGuards, stateGuardSummary } from "./scripting.js";

function getControllerMethods(controller: ControllerDefinition): string[] {
    const seen: Record<string, boolean> = {};
    const methods: string[] = [];

    controller.routes.forEach(function (route) {
        if (!seen[route.method]) {
            seen[route.method] = true;
            methods.push(route.method);
        }
    });

    return methods.sort();
}

function createVersionIndex(controllers: ControllerDefinition[]): Record<string, unknown> {
    const sortedControllers = controllers.slice(0).sort(function (left, right) {
        if (left.name < right.name) {
            return -1;
        }
        if (left.name > right.name) {
            return 1;
        }
        return 0;
    });

    return {
        buildId: BUILD_ID,
        controllers: sortedControllers.map(function (controller) {
            return {
                name: controller.name,
                path: controller.basePath,
                methods: getControllerMethods(controller)
            };
        }),
        // Read fresh on every request rather than captured at startup: a scenario load
        // re-guards new `park` and `scenario` objects, so the answer can change.
        stateGuards: stateGuardSummary()
    };
}

function createSwaggerPage(): string {
    return `
        <!doctype html>
        <html lang="en">
        <head>
          <meta charset="utf-8">
          <title>API docs</title>
          <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css">
        </head>
        <body>
          <div id="swagger"></div>
          <script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script>
          <script>
            SwaggerUIBundle({
              url: "/openapi.yaml",
              dom_id: "#swagger"
            });
          </script>
        </body>
        </html>
    `;
}

function createRequestLogger(): Middleware {
    return function (request, response, next) {
        const result = next();
        const level = response.statusCode >= 500 ? "error" : (response.statusCode >= 400 ? "warn" : "info");

        console.log(request.method + " " + request.path + " -- " + level);
        return result;
    };
}

function respondWithEmbeddedFile(path: string, response: HttpResponse): HttpResponse {
    const file = embeddedStaticFiles[path];

    if (typeof file === "undefined") {
        return response.setText("Not Found", 404);
    }

    return response.setText(file.body, 200, file.contentType);
}

function registerEmbeddedStaticRoutes(router: HttpRouter): void {
    Object.keys(embeddedStaticFiles).forEach(function (path) {
        router.registerRoute({
            method: "GET",
            path: path,
            operationId: "getStatic_" + path.replace(/[^a-zA-Z0-9]+/g, "_"),
            summary: "Get an embedded static asset",
            hideFromOpenApi: true,
            handler: function (_request, response) {
                return respondWithEmbeddedFile(path, response);
            }
        });
    });
}

export interface Application {
    handleRawRequest(rawRequest: string): ReturnType<HttpRouter["handleRawRequest"]>;
    handleSocketRequest(rawRequest: string, socket: SocketLike): RequestHandlingResult;
    getOpenApiYaml(): string;
}

export function createApplication(): Application {
    // Before the listener exists, so no request can be the thing that installs them and
    // the guard report is answerable from the first `GET /v1`. Re-entrant: `runScript`
    // calls it again on every evaluate to re-guard what a scenario load replaced.
    installStateGuards();

    const router = new HttpRouter();
    const controllers = registerControllers(router, getControllers());
    const mcpServer = new McpServer();

    router.use("/", createRequestLogger());
    registerEmbeddedStaticRoutes(router);

    router.registerRoute({
        method: "GET",
        path: "/",
        operationId: "redirectToDashboard",
        summary: "Redirect to the dashboard",
        description: "Redirects the root path to the dashboard UI.",
        hideFromOpenApi: true,
        handler: function (_request, response) {
            response.setStatus(302);
            response.setHeader("Location", "/dashboard");
            return response.setText("Redirecting to /dashboard");
        }
    });

    router.registerRoute({
        method: "GET",
        path: "/dashboard",
        operationId: "getDashboardPage",
        summary: "Get the dashboard page",
        hideFromOpenApi: true,
        handler: function (_request, response) {
            return respondWithEmbeddedFile("/static/dashboard.html", response);
        }
    });

    router.registerRoute({
        method: "GET",
        path: "/v1",
        operationId: "getV1Index",
        summary: "List v1 controllers",
        description: "Returns the registered v1 controllers and their supported methods.",
        responseDescription: "Registered v1 controllers",
        handler: function () {
            return createVersionIndex(controllers);
        }
    });

    router.registerRoute({
        method: "GET",
        path: "/openapi.yaml",
        operationId: "getOpenApiYaml",
        summary: "Get the generated OpenAPI YAML",
        hideFromOpenApi: true,
        handler: function (_request, response) {
            return response.setText(
                generateOpenApiYaml("freeplay-bridge", "0.1.0", router.getRoutes()),
                200,
                "application/yaml; charset=utf-8"
            );
        }
    });

    router.registerRoute({
        method: "GET",
        path: "/swagger",
        operationId: "getSwaggerPage",
        summary: "Get the generated Swagger page",
        hideFromOpenApi: true,
        handler: function (_request, response) {
            return response.setText(
                createSwaggerPage(),
                200,
                "text/html; charset=utf-8"
            );
        }
    });

    router.registerRoute({
        method: "POST",
        path: "/mcp",
        operationId: "mcp",
        summary: "Handle MCP requests",
        description: "Handles MCP Streamable HTTP POST requests for initialization, tool discovery, and tool invocation.",
        responseDescription: "MCP response",
        hideFromOpenApi: false,
        handler: function (request, response, context) {
            return mcpServer.handlePost(request, response, context);
        }
    });

    return {
        handleRawRequest: function (rawRequest) {
            return router.handleRawRequest(rawRequest);
        },
        handleSocketRequest: function (rawRequest, socket) {
            return router.handleRawRequestWithContext(rawRequest, createRequestContext(socket));
        },
        getOpenApiYaml: function () {
            return generateOpenApiYaml("freeplay-bridge", "0.1.0", router.getRoutes());
        }
    };
}
