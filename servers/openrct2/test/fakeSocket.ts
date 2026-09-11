import assert from "node:assert/strict";

import type { SocketLike } from "../src/http/types.ts";

type SocketEvent = "close" | "error" | "data";

/**
 * A client connection the tests can read back.
 *
 * Deferred tools answer by writing to the socket themselves, ticks after the request
 * handler returned, so internal bookkeeping proves nothing: the only honest question is
 * what bytes reached the client. This records them, keeps anything written after the
 * client hung up apart, and lets a test play the client going away mid-work.
 */
export class FakeSocket implements SocketLike {
    /** Chunks handed to the socket while the client was still connected, in order. */
    public readonly chunks: string[] = [];
    /** Chunks handed to the socket after the client hung up. */
    public readonly chunksAfterClose: string[] = [];
    public ended = false;
    public closed = false;

    private readonly closeListeners: ((hadError: boolean) => void)[] = [];
    private readonly errorListeners: ((errorString: string) => void)[] = [];
    private readonly dataListeners: ((data: string) => void)[] = [];

    /** Everything the client actually received. */
    public get written(): string {
        return this.chunks.join("");
    }

    public write(data: string): boolean {
        if (this.closed) {
            this.chunksAfterClose.push(data);
            return false;
        }

        this.chunks.push(data);
        return true;
    }

    public end(data?: string): SocketLike {
        if (typeof data === "string") {
            this.write(data);
        }

        this.ended = true;
        return this;
    }

    public on(event: "close", callback: (hadError: boolean) => void): SocketLike;
    public on(event: "error", callback: (errorString: string) => void): SocketLike;
    public on(event: "data", callback: (data: string) => void): SocketLike;
    public on(event: SocketEvent, callback: (value: never) => void): SocketLike {
        this.listenersFor(event).push(callback);
        return this;
    }

    public off(event: "close", callback: (hadError: boolean) => void): SocketLike;
    public off(event: "error", callback: (errorString: string) => void): SocketLike;
    public off(event: "data", callback: (data: string) => void): SocketLike;
    public off(event: SocketEvent, callback: (value: never) => void): SocketLike {
        const listeners = this.listenersFor(event);
        const index = listeners.indexOf(callback);

        if (index >= 0) {
            listeners.splice(index, 1);
        }

        return this;
    }

    /** The client goes away, as the game reports it when the peer disconnects. */
    public hangUp(hadError = false): void {
        this.closed = true;
        this.closeListeners.slice(0).forEach(function (listener) {
            listener(hadError);
        });
    }

    /** The game reporting a socket-level failure. */
    public failWith(errorString: string): void {
        this.errorListeners.slice(0).forEach(function (listener) {
            listener(errorString);
        });
    }

    /** Bytes arriving from the client. */
    public deliver(data: string): void {
        this.dataListeners.slice(0).forEach(function (listener) {
            listener(data);
        });
    }

    public get closeListenerCount(): number {
        return this.closeListeners.length;
    }

    private listenersFor(event: SocketEvent): ((value: never) => void)[] {
        if (event === "close") {
            return this.closeListeners;
        }

        if (event === "error") {
            return this.errorListeners;
        }

        return this.dataListeners;
    }
}

export interface HttpMessage {
    statusLine: string;
    statusCode: number;
    reason: string;
    /** Header names lower-cased; values as sent. */
    headers: Record<string, string>;
    body: string;
}

export interface JsonRpcMessage {
    jsonrpc?: unknown;
    id?: unknown;
    result?: ToolResult;
    error?: { code: number; message: string };
}

export interface ToolResult {
    content?: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
}

export function utf8ByteLength(value: string): number {
    return unescape(encodeURIComponent(value)).length;
}

/**
 * Split a socket's bytes into HTTP responses. Content-Length decides where each one
 * ends, so two responses written to one client come back as two messages rather than
 * one blob that happens to parse — which is the whole point of the double-write tests.
 */
export function parseHttpMessages(raw: string): HttpMessage[] {
    const messages: HttpMessage[] = [];
    let rest = raw;

    while (rest.length > 0) {
        const separator = rest.indexOf("\r\n\r\n");

        if (separator < 0) {
            throw new Error("Response has no header terminator: " + JSON.stringify(rest));
        }

        const lines = rest.substring(0, separator).split("\r\n");
        const statusLine = lines[0];
        const statusMatch = /^HTTP\/1\.1 (\d{3})(?: (.*))?$/.exec(statusLine);

        if (!statusMatch) {
            throw new Error("Not an HTTP response: " + JSON.stringify(statusLine));
        }

        const headers: Record<string, string> = {};

        for (let i = 1; i < lines.length; i++) {
            const colon = lines[i].indexOf(":");

            if (colon > 0) {
                headers[lines[i].substring(0, colon).trim().toLowerCase()] = lines[i].substring(colon + 1).trim();
            }
        }

        const afterHead = rest.substring(separator + 4);
        const declaredLength = headers["content-length"];
        let bodyEnd = afterHead.length;

        if (typeof declaredLength !== "undefined") {
            const wanted = Number(declaredLength);
            let bytes = 0;
            let index = 0;

            while (index < afterHead.length && bytes < wanted) {
                const code = afterHead.charCodeAt(index);
                // Keep a surrogate pair together, or its halves encode as two characters.
                const width = code >= 0xD800 && code <= 0xDBFF && index + 1 < afterHead.length ? 2 : 1;

                bytes += utf8ByteLength(afterHead.substring(index, index + width));
                index += width;
            }

            if (bytes < wanted) {
                throw new Error("Response body is shorter than its Content-Length of " + declaredLength
                    + ": " + JSON.stringify(afterHead));
            }

            bodyEnd = index;
        }

        messages.push({
            statusLine: statusLine,
            statusCode: Number(statusMatch[1]),
            reason: statusMatch[2] || "",
            headers: headers,
            body: afterHead.substring(0, bodyEnd)
        });

        rest = afterHead.substring(bodyEnd);
    }

    return messages;
}

/** Every HTTP response the client received on this socket. */
export function responsesOn(socket: FakeSocket): HttpMessage[] {
    return parseHttpMessages(socket.written);
}

export function jsonRpcOf(message: HttpMessage): JsonRpcMessage {
    return JSON.parse(message.body) as JsonRpcMessage;
}

/**
 * The one response a request is allowed to produce, parsed, with the envelope every
 * deferred answer must carry checked on the way through.
 */
export function soleJsonRpcResponse(socket: FakeSocket): JsonRpcMessage {
    const messages = responsesOn(socket);

    assert.equal(messages.length, 1, "expected exactly one HTTP response, got " + String(messages.length)
        + ": " + JSON.stringify(socket.written));

    const message = messages[0];

    assert.equal(message.statusLine, "HTTP/1.1 200 OK");
    assert.equal(message.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(message.headers["mcp-protocol-version"], "2025-11-25");
    assert.equal(message.headers["connection"], "close", "the client needs to know the response ended");
    assert.equal(Number(message.headers["content-length"]), utf8ByteLength(message.body),
        "Content-Length must match the body it announces");

    const payload = jsonRpcOf(message);
    assert.equal(payload.jsonrpc, "2.0");

    return payload;
}

/** The tool result inside a deferred answer, with the JSON-RPC envelope already checked. */
export function soleToolResult(socket: FakeSocket, expectedId: unknown): ToolResult {
    const payload = soleJsonRpcResponse(socket);

    assert.equal(payload.id, expectedId, "the answer must carry the id of the request that asked for it");
    assert.equal(payload.error, undefined, "a tool outcome belongs in `result`, not in a transport error");
    assert.ok(payload.result, "the response carries no result: " + JSON.stringify(payload));

    return payload.result as ToolResult;
}
