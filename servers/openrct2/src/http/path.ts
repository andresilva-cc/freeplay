export function normalizeRoutePath(path: string): string {
    if (path === "") {
        return "/";
    }

    if (path.charAt(0) !== "/") {
        return "/" + path;
    }

    if (path.length > 1) {
        return path.replace(/\/+$/, "");
    }

    return path;
}

export function combineRoutePaths(basePath: string, childPath: string): string {
    const normalizedBasePath = normalizeRoutePath(basePath);

    if (childPath === "" || childPath === "/") {
        return normalizedBasePath;
    }

    const trimmedChildPath = childPath.replace(/^\/+/, "");
    return normalizeRoutePath(normalizedBasePath + "/" + trimmedChildPath);
}

function splitPathSegments(path: string): string[] {
    const normalizedPath = normalizeRoutePath(path);

    if (normalizedPath === "/") {
        return [];
    }

    return normalizedPath.substring(1).split("/");
}

export function pathMatchesPrefix(requestPath: string, registeredPath: string): boolean {
    if (registeredPath === "/") {
        return true;
    }

    return requestPath === registeredPath || requestPath.indexOf(registeredPath + "/") === 0;
}

export function matchRoutePath(routePath: string, requestPath: string): Record<string, string> | undefined {
    const routeSegments = splitPathSegments(routePath);
    const requestSegments = splitPathSegments(requestPath);
    const params: Record<string, string> = {};

    if (routeSegments.length !== requestSegments.length) {
        return undefined;
    }

    for (let index = 0; index < routeSegments.length; index++) {
        const routeSegment = routeSegments[index];
        const requestSegment = requestSegments[index];

        if (routeSegment.charAt(0) === ":") {
            const paramName = routeSegment.substring(1);

            if (paramName === "") {
                return undefined;
            }

            params[paramName] = requestSegment;
            continue;
        }

        if (routeSegment !== requestSegment) {
            return undefined;
        }
    }

    return params;
}

export function getRouteParameterNames(routePath: string): string[] {
    return splitPathSegments(routePath)
        .filter(function (segment) {
            return segment.charAt(0) === ":" && segment.length > 1;
        })
        .map(function (segment) {
            return segment.substring(1);
        });
}

export function toOpenApiPath(routePath: string): string {
    return normalizeRoutePath(routePath).replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}
