# Freeplay OpenRCT2 bridge

An OpenRCT2 plugin that opens a loopback TCP listener from inside the running
game and serves an MCP endpoint over it, so an agent harness can read park
state and take actions without touching the screen or the keyboard.

## Upstream

This is a fork of [IntelOrca/openrct2-mcp](https://github.com/IntelOrca/openrct2-mcp)
by Ted John, MIT licensed. Everything that makes this possible — the in-plugin
TCP listener, the hand-rolled HTTP stack, the routing and controller
decorators, the MCP Streamable HTTP implementation, the OpenAPI generation and
the rollup build — comes from there. The original licence is preserved in
[`LICENSE`](LICENSE).

Freeplay adds one thing: an `evaluate` MCP tool that runs JavaScript in the
plugin context and returns a sanitised, size-bounded result. See
[`../../docs/openrct2-bridge.md`](../../docs/openrct2-bridge.md) for the full
description of the fork.

## Build

```bash
npm install
npm run build
```

`out/mcp.js` is the plugin bundle. `npm run copy` installs it into the OpenRCT2
plugin directory on macOS.

## Endpoints

The listener binds `127.0.0.1:8080`. `POST /mcp` is the MCP endpoint. The
inherited REST surface (`/v1/...`), the generated OpenAPI document
(`/openapi.yaml`), Swagger UI (`/swagger`) and the dashboard (`/dashboard`) are
all still there and are useful for poking at the bridge by hand.
