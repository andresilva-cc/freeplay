import type { RouteDefinition } from "./types.js";
import { getRouteParameterNames, toOpenApiPath } from "./path.js";

function quoteYaml(value: string): string {
    return JSON.stringify(value);
}

export function generateOpenApiYaml(title: string, version: string, routes: RouteDefinition[]): string {
    const lines = [
        "openapi: 3.1.0",
        "info:",
        "  title: " + quoteYaml(title),
        "  version: " + quoteYaml(version),
        "paths:"
    ];
    const visibleRoutes = routes
        .filter(function (route) {
            return route.hideFromOpenApi !== true;
        })
        .sort(function (left, right) {
            if (left.path === right.path) {
                if (left.method < right.method) {
                    return -1;
                }
                if (left.method > right.method) {
                    return 1;
                }
                return 0;
            }

            if (left.path < right.path) {
                return -1;
            }
            return 1;
        });
    let currentPath = "";

    if (visibleRoutes.length === 0) {
        lines.push("  {}");
        return lines.join("\n");
    }

    for (const route of visibleRoutes) {
        const openApiPath = toOpenApiPath(route.path);

        if (openApiPath !== currentPath) {
            currentPath = openApiPath;
            lines.push("  " + quoteYaml(openApiPath) + ":");
        }

        lines.push("    " + route.method.toLowerCase() + ":");
        lines.push("      operationId: " + quoteYaml(route.operationId));
        lines.push("      summary: " + quoteYaml(route.summary));

        if (typeof route.description !== "undefined") {
            lines.push("      description: " + quoteYaml(route.description));
        }

        if (typeof route.tags !== "undefined" && route.tags.length > 0) {
            lines.push("      tags:");
            route.tags.forEach(function (tag) {
                lines.push("        - " + quoteYaml(tag));
            });
        }

        const pathParameterNames = getRouteParameterNames(route.path);
        if (pathParameterNames.length > 0) {
            lines.push("      parameters:");
            pathParameterNames.forEach(function (parameterName) {
                lines.push("        - name: " + quoteYaml(parameterName));
                lines.push("          in: \"path\"");
                lines.push("          required: true");
                lines.push("          schema:");
                lines.push("            type: string");
            });
        }

        const responseDescription = route.responseDescription || "Successful response";
        lines.push("      responses:");
        lines.push("        '200':");
        lines.push("          description: " + quoteYaml(responseDescription));
        lines.push("          content:");
        lines.push("            application/json:");
        lines.push("              schema:");
        lines.push("                type: object");
    }

    return lines.join("\n");
}
