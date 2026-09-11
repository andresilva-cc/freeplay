import type { HttpResponse } from "../http/response.js";
import type { HandlerResult, HttpMethod, HttpRequest } from "../http/types.js";

export interface ControllerContext {
    request: HttpRequest;
    response: HttpResponse;
    params: Record<string, string>;
}

export interface HttpRouteOptions {
    operationId?: string;
    summary: string;
    description?: string;
    responseDescription?: string;
    hideFromOpenApi?: boolean;
}

export interface ControllerRouteMetadata extends HttpRouteOptions {
    handlerName: string;
    method: HttpMethod;
    path: string;
}

export interface ControllerRouteDefinition extends ControllerRouteMetadata {
    fullPath: string;
    operationId: string;
}

export interface ControllerClass<TController extends HttpController = HttpController> {
    new (context: ControllerContext): TController;
}

export interface ControllerDefinition {
    controllerClass: ControllerClass;
    name: string;
    basePath: string;
    routes: ControllerRouteDefinition[];
}

export type ControllerAction = (context: ControllerContext) => HandlerResult;

export abstract class HttpController {
    public readonly request: HttpRequest;
    public readonly response: HttpResponse;

    public constructor(context: ControllerContext) {
        this.request = context.request;
        this.response = context.response;
    }
}
