import type { HttpResponse } from "./response.js";

export type HttpMethod = string;

export interface HttpRequest {
    method: HttpMethod;
    rawPath: string;
    path: string;
    httpVersion: string;
    headers: Record<string, string>;
    query: Record<string, string>;
    params: Record<string, string>;
    body: string;
    getHeader(name: string): string | undefined;
}

export interface SocketLike {
    write(data: string): boolean;
    end(data?: string): SocketLike;
    on(event: "close", callback: (hadError: boolean) => void): SocketLike;
    on(event: "error", callback: (errorString: string) => void): SocketLike;
    on(event: "data", callback: (data: string) => void): SocketLike;
    off(event: "close", callback: (hadError: boolean) => void): SocketLike;
    off(event: "error", callback: (errorString: string) => void): SocketLike;
    off(event: "data", callback: (data: string) => void): SocketLike;
}

export interface SocketChannel {
    send(data: string): boolean;
    close(data?: string): void;
    onData(callback: (data: string) => void): SocketChannel;
    onClose(callback: (hadError: boolean) => void): SocketChannel;
    onError(callback: (errorString: string) => void): SocketChannel;
    offData(callback: (data: string) => void): SocketChannel;
    offClose(callback: (hadError: boolean) => void): SocketChannel;
    offError(callback: (errorString: string) => void): SocketChannel;
}

export interface RequestConnection {
    readonly socket?: SocketLike;
    readonly hijacked: boolean;
    takeOver(): SocketChannel | undefined;
}

export interface RequestContext {
    connection: RequestConnection;
}

export type HandlerResult =
    | HttpResponse
    | Record<string, unknown>
    | unknown[]
    | string
    | number
    | boolean
    | null
    | void;

export type NextFunction = () => HandlerResult;

export type Middleware = (request: HttpRequest, response: HttpResponse, next: NextFunction, context: RequestContext) => HandlerResult;

export type RouteHandler = (request: HttpRequest, response: HttpResponse, context: RequestContext) => HandlerResult;

export interface RequestHandlingResult {
    response: HttpResponse;
    context: RequestContext;
}

export interface RouteDefinition {
    method: HttpMethod;
    path: string;
    operationId: string;
    summary: string;
    description?: string;
    tags?: string[];
    responseDescription?: string;
    hideFromOpenApi?: boolean;
    controllerName?: string;
    handler: RouteHandler;
}
