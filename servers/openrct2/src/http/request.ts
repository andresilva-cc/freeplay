import type { HttpMethod, HttpRequest } from "./types.js";

function safeDecodeURIComponent(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch (_error) {
        return value;
    }
}

function normalizeMethod(method: string): HttpMethod {
    const normalized = method.toUpperCase();
    return normalized === "" ? "GET" : normalized;
}

export function parseQueryParameters(rawPath: string): Record<string, string> {
    const query: Record<string, string> = {};
    const index = rawPath.indexOf("?");
    const queryString: string = rawPath.substring(index + 1);
    const parts = queryString.split("&");

    if (index === -1) {
        return query;
    }

    if (queryString === "") {
        return query;
    }

    for (const part of parts) {
        if (part === "") {
            continue;
        }

        const pair = part.split("=");
        const key = safeDecodeURIComponent(pair[0] || "");
        const value = safeDecodeURIComponent(pair.length > 1 ? pair.slice(1).join("=") : "");
        query[key] = value;
    }

    return query;
}

export function normalizePath(rawPath: string): string {
    const withoutQuery = rawPath.split("?")[0] || "/";
    const decoded = safeDecodeURIComponent(withoutQuery);
    const normalized = decoded.replace(/\/+$/, "");

    if (normalized === "") {
        return "/";
    }

    if (normalized.charAt(0) !== "/") {
        return "/" + normalized;
    }

    return normalized;
}

function parseHeaders(headerLines: string[]): Record<string, string> {
    const headers: Record<string, string> = {};

    for (const line of headerLines) {
        if (line === "") {
            continue;
        }

        const separatorIndex = line.indexOf(":");
        if (separatorIndex === -1) {
            continue;
        }

        const name = line.substring(0, separatorIndex).trim().toLowerCase();
        const value = line.substring(separatorIndex + 1).trim();
        headers[name] = value;
    }

    return headers;
}

export function parseHttpRequest(rawRequest: string): HttpRequest {
    const sections = rawRequest.split("\r\n\r\n");
    const head = sections[0] || "";
    const body = sections.slice(1).join("\r\n\r\n");
    const lines = head.split("\r\n");
    const requestLine = lines.shift() || "";
    const parts = requestLine.split(" ");

    if (requestLine.trim() === "") {
        throw new Error("Invalid HTTP request line");
    }

    const method = normalizeMethod(parts[0] || "GET");
    const rawPath = parts[1] || "/";
    const headers = parseHeaders(lines);

    return {
        method: method,
        rawPath: rawPath,
        path: normalizePath(rawPath),
        httpVersion: parts[2] || "HTTP/1.1",
        headers: headers,
        query: parseQueryParameters(rawPath),
        params: {},
        body: body,
        getHeader: function (name: string): string | undefined {
            return headers[name.toLowerCase()];
        }
    };
}
