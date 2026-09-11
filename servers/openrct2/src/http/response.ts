function getUtf8ByteLength(value: string): number {
    return unescape(encodeURIComponent(value)).length;
}

function getStatusText(statusCode: number): string {
    switch (statusCode) {
        case 302:
            return "Found";
        case 200:
            return "OK";
        case 201:
            return "Created";
        case 204:
            return "No Content";
        case 400:
            return "Bad Request";
        case 404:
            return "Not Found";
        case 405:
            return "Method Not Allowed";
        case 500:
            return "Internal Server Error";
        default:
            return "OK";
    }
}

function formatHeaderName(name: string): string {
    return name.replace(/(^|-)([a-z])/g, function (_match: string, prefix: string, letter: string) {
        return prefix + letter.toUpperCase();
    });
}

export class HttpResponse {
    public statusCode: number;
    public readonly headers: Record<string, string>;
    public body: string;

    public constructor() {
        this.statusCode = 200;
        this.headers = {};
        this.body = "";
    }

    public setStatus(statusCode: number): HttpResponse {
        this.statusCode = statusCode;
        return this;
    }

    public setHeader(name: string, value: string): HttpResponse {
        const existingHeaderName = this.findHeaderName(name);
        this.headers[existingHeaderName || name] = value;
        return this;
    }

    public getHeader(name: string): string | undefined {
        const existingHeaderName = this.findHeaderName(name);
        return typeof existingHeaderName === "undefined" ? undefined : this.headers[existingHeaderName];
    }

    public getHeaders(): Record<string, string> {
        return this.headers;
    }

    public getBody(): string {
        return this.body;
    }

    public setBody(body: string, contentType?: string): HttpResponse {
        this.body = body;
        if (typeof contentType !== "undefined") {
            this.setHeader("Content-Type", contentType);
        }
        return this;
    }

    public setJson(payload: unknown, statusCode?: number): HttpResponse {
        if (typeof statusCode !== "undefined") {
            this.setStatus(statusCode);
        }

        return this.setBody(JSON.stringify(payload), "application/json; charset=utf-8");
    }

    public setText(body: string, statusCode?: number, contentType?: string): HttpResponse {
        if (typeof statusCode !== "undefined") {
            this.setStatus(statusCode);
        }

        return this.setBody(body, contentType || "text/plain; charset=utf-8");
    }

    public toHttpString(): string {
        if (typeof this.getHeader("connection") === "undefined") {
            this.setHeader("Connection", "close");
        }

        if (typeof this.getHeader("content-length") === "undefined") {
            this.setHeader("Content-Length", String(getUtf8ByteLength(this.body)));
        }

        const responseLines = [
            "HTTP/1.1 " + this.statusCode + " " + getStatusText(this.statusCode)
        ];
        const headerNames = Object.keys(this.headers);

        for (const headerName of headerNames) {
            responseLines.push(formatHeaderName(headerName) + ": " + this.headers[headerName]);
        }

        responseLines.push("");
        responseLines.push(this.body);

        return responseLines.join("\r\n");
    }

    private findHeaderName(name: string): string | undefined {
        const normalizedName = name.toLowerCase();

        for (const headerName of Object.keys(this.headers)) {
            if (headerName.toLowerCase() === normalizedName) {
                return headerName;
            }
        }

        return undefined;
    }
}
