import { createApplication } from "./app.js";
import { HttpResponse } from "./http/response.js";

/** Loopback only: the bridge is for a harness on the same machine, never the network. */
const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = 8080;

class ApiApplication {
    run(host: string, port: number) {
        const app = createApplication();
        console.log(`Starting API server on ${host}:${port}`);
        try {
            const server = network.createListener();
            server.on('connection', (socket) => {
                socket.setNoDelay(true);
                let responded = false;

                socket.on('data', (data) => {
                    if (responded) return;
                    responded = true;

                    try {
                        const result = app.handleSocketRequest((typeof data === 'string') ? data : String(data), socket);

                        if (!result.context.connection.hijacked) {
                            socket.end(result.response.toHttpString());
                        }
                    } catch (error) {
                        const response = this.createInternalServerErrorResponse(error);
                        try { socket.end(response.toHttpString()); } catch (e) { console.log('Socket end error: ' + e); }
                    }
                });

                socket.on('error', function (err) {
                    console.log('Socket error: ' + err);
                });
            });
            server.listen(port, host);
            console.log(`Server listening on ${host}:${port}`);
        } catch (e) {
            console.log('Failed to start server: ' + e);
        }
    }

    private createInternalServerErrorResponse(error: unknown): HttpResponse {
        console.log("Request handling error: " + error);
        return new HttpResponse().setJson({
            error: String(error)
        }, 500);
    }
}

function main() {
    const apiApp = new ApiApplication();
    apiApp.run(BRIDGE_HOST, BRIDGE_PORT);
}

registerPlugin({
    name: 'freeplay-bridge',
    version: '0.1.0',
    authors: ['IntelOrca', 'André Silva'],
    type: 'local',
    licence: 'MIT',
    targetApiVersion: 66,
    main: main
});
