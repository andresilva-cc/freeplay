import { mcpTool, mcpToolController } from "./decorators.js";
import { buildPath, DEFAULT_PATH_OBJECT, DEFAULT_QUEUE_OBJECT } from "../park/pathbuild.js";
import type { DeferredMcpResult } from "./types.js";

@mcpToolController
export class PathTools {
    @mcpTool({
        name: "Build a path",
        description: [
            "Lay a footpath or a queue line between two tiles, routing around trees and other obstacles.",
            "Coordinates are tile coordinates. Both ends are paved, including the tiles you name.",
            "Set `queue: true` to build a queue line: a ride's entrance needs a queue tile touching its door,",
            "or guests crowd around the building and never board. Ordinary paths are how guests get anywhere else.",
            "Where paths go is your decision — this only handles the placement."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                fromX: { type: "integer", description: "Tile x of one end." },
                fromY: { type: "integer", description: "Tile y of one end." },
                toX: { type: "integer", description: "Tile x of the other end." },
                toY: { type: "integer", description: "Tile y of the other end." },
                queue: { type: "boolean", description: "Build a queue line rather than an ordinary path. Default false." },
                surfaceObject: { type: "integer", description: "Footpath surface style, from context.getAllObjects(\"footpath_surface\"). Queue styles are separate objects. Defaults to a plain path, or a blue queue." },
                railingsObject: { type: "integer", description: "Railing style, from context.getAllObjects(\"footpath_railings\"). Default 0." }
            },
            required: ["fromX", "fromY", "toX", "toY"],
            additionalProperties: false
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false
        }
    })
    public buildPath(args: Record<string, unknown>): DeferredMcpResult {
        const number = function (value: unknown): number {
            return typeof value === "number" ? Math.floor(value) : -1;
        };

        const queue = args.queue === true;

        const request = {
            from: { x: number(args.fromX), y: number(args.fromY) },
            to: { x: number(args.toX), y: number(args.toY) },
            queue: queue,
            surfaceObject: typeof args.surfaceObject === "number"
                ? Math.floor(args.surfaceObject)
                : (queue ? DEFAULT_QUEUE_OBJECT : DEFAULT_PATH_OBJECT),
            railingsObject: typeof args.railingsObject === "number" ? Math.floor(args.railingsObject) : 0
        };

        return {
            deferred: true,
            start: function (resolve) {
                buildPath(request, resolve);
            }
        };
    }
}
