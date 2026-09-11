import type { RequestConnection, RequestContext, SocketChannel, SocketLike } from "./types.js";

export class SocketConnection implements SocketChannel {
    private readonly socket: SocketLike;

    public constructor(socket: SocketLike) {
        this.socket = socket;
    }

    public send(data: string): boolean {
        return this.socket.write(data);
    }

    public close(data?: string): void {
        this.socket.end(data);
    }

    public onData(callback: (data: string) => void): SocketChannel {
        this.socket.on("data", callback);
        return this;
    }

    public onClose(callback: (hadError: boolean) => void): SocketChannel {
        this.socket.on("close", callback);
        return this;
    }

    public onError(callback: (errorString: string) => void): SocketChannel {
        this.socket.on("error", callback);
        return this;
    }

    public offData(callback: (data: string) => void): SocketChannel {
        this.socket.off("data", callback);
        return this;
    }

    public offClose(callback: (hadError: boolean) => void): SocketChannel {
        this.socket.off("close", callback);
        return this;
    }

    public offError(callback: (errorString: string) => void): SocketChannel {
        this.socket.off("error", callback);
        return this;
    }
}

class ManagedRequestConnection implements RequestConnection {
    public readonly socket?: SocketLike;
    private channel?: SocketChannel;
    private hasBeenHijacked: boolean;

    public constructor(socket?: SocketLike) {
        this.socket = socket;
        this.hasBeenHijacked = false;
    }

    public get hijacked(): boolean {
        return this.hasBeenHijacked;
    }

    public takeOver(): SocketChannel | undefined {
        if (typeof this.socket === "undefined") {
            return undefined;
        }

        this.hasBeenHijacked = true;
        if (typeof this.channel === "undefined") {
            this.channel = new SocketConnection(this.socket);
        }
        return this.channel;
    }
}

export function createRequestContext(socket?: SocketLike): RequestContext {
    return {
        connection: new ManagedRequestConnection(socket)
    };
}
