import { combineRoutePaths, normalizeRoutePath } from "../http/path.js";
import type { ControllerClass, ControllerDefinition, ControllerRouteMetadata, HttpRouteOptions } from "./types.js";

const controllerPathMetadataKey = "__httpControllerPath__";
const controllerRoutesMetadataKey = "__httpControllerRoutes__";

type DecoratedControllerClass = ControllerClass & {
    [controllerPathMetadataKey]?: string;
    [controllerRoutesMetadataKey]?: ControllerRouteMetadata[];
};

function getControllerName(controllerClass: ControllerClass): string {
    const controllerFunction = controllerClass as unknown as { name?: string; toString(): string };
    const constructorName = controllerFunction.name || "Controller";
    const trimmedName = constructorName.replace(/Controller$/, "");

    if (trimmedName === "") {
        return "controller";
    }

    return trimmedName.charAt(0).toLowerCase() + trimmedName.substring(1);
}

function getDecoratedControllerClass(target: object): DecoratedControllerClass {
    return target as unknown as DecoratedControllerClass;
}

function createMethodDecorator(method: string) {
    return function httpMethod(path: string, options?: HttpRouteOptions): MethodDecorator {
        return function (target, propertyKey): void {
            const controllerClass = getDecoratedControllerClass(target.constructor);
            const existingRoutes = controllerClass[controllerRoutesMetadataKey] || [];

            controllerClass[controllerRoutesMetadataKey] = existingRoutes.concat({
                handlerName: String(propertyKey),
                method: method,
                path: path,
                operationId: options?.operationId ?? '',
                summary: options?.summary ?? '',
                description: options?.description ?? '',
                responseDescription: options?.responseDescription ?? '',
                hideFromOpenApi: options?.hideFromOpenApi ?? false
            });
        };
    };
}

export function httpPath(path: string): ClassDecorator {
    return function (target): void {
        getDecoratedControllerClass(target)[controllerPathMetadataKey] = normalizeRoutePath(path);
    };
}

export const httpDelete = createMethodDecorator("DELETE");
export const httpGet = createMethodDecorator("GET");
export const httpPatch = createMethodDecorator("PATCH");
export const httpPost = createMethodDecorator("POST");
export const httpPut = createMethodDecorator("PUT");

export function getControllerDefinition(controllerClass: ControllerClass): ControllerDefinition {
    const decoratedControllerClass = controllerClass as DecoratedControllerClass;
    const basePath = decoratedControllerClass[controllerPathMetadataKey];
    const routes = decoratedControllerClass[controllerRoutesMetadataKey] || [];

    if (typeof basePath === "undefined") {
        throw new Error("Controller is missing @httpPath metadata");
    }

    return {
        controllerClass: controllerClass,
        name: getControllerName(controllerClass),
        basePath: basePath,
        routes: routes.map(function (route) {
            return {
                handlerName: route.handlerName,
                method: route.method,
                path: route.path,
                fullPath: combineRoutePaths(basePath, route.path),
                operationId: route.operationId || getControllerName(controllerClass) + "_" + route.handlerName,
                summary: route.summary,
                description: route.description,
                responseDescription: route.responseDescription,
                hideFromOpenApi: route.hideFromOpenApi
            };
        })
    };
}
