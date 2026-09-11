import { mcpTool, mcpToolController } from "./decorators.js";
import { buildPath, DEFAULT_PATH_OBJECT, DEFAULT_QUEUE_OBJECT } from "../park/pathbuild.js";
import type { DeferredMcpResult } from "./types.js";

@mcpToolController
export class PathTools {
    @mcpTool({
        name: "Build a path",
        description: [
            "Lay a footpath or a queue line. Coordinates are tile coordinates, and every tile you name is paved.",
            "Give `waypoints` to draw the line yourself — a list of corners, laid as straight runs between them.",
            "That is how you control the shape of your park. With only `fromX/fromY` and `toX/toY` the tool picks",
            "the line for you, which is convenient but means it is choosing your layout.",
            "Either way it routes around trees, because you cannot see them from here.",
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
                waypoints: {
                    type: "array",
                    description: "Corners of the path, in order, each {x, y}. Use this to choose the shape yourself."
                },
                queue: { type: "boolean", description: "Build a queue line rather than an ordinary path. Default false." },
                surfaceObject: { type: "integer", description: "Footpath surface style, from context.getAllObjects(\"footpath_surface\"). Queue styles are separate objects. Defaults to a plain path, or a blue queue." },
                railingsObject: { type: "integer", description: "Railing style, from context.getAllObjects(\"footpath_railings\"). Default 0." }
            },
            required: [],
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

        const waypoints: { x: number; y: number }[] = [];

        if (Array.isArray(args.waypoints)) {
            const given = args.waypoints as { x?: unknown; y?: unknown }[];

            for (let i = 0; i < given.length; i++) {
                const point = given[i];

                // Coercing a malformed point to -1 would quietly route from off the map.
                if (!point || typeof point.x !== "number" || typeof point.y !== "number") {
                    return {
                        deferred: true,
                        start: function (resolve) {
                            resolve({
                                ok: false,
                                error: "waypoints[" + String(i) + "] needs a numeric x and y."
                            });
                        }
                    };
                }

                waypoints.push({ x: Math.floor(point.x), y: Math.floor(point.y) });
            }
        }

        const request = {
            points: waypoints.length >= 2
                ? waypoints
                : [{ x: number(args.fromX), y: number(args.fromY) }, { x: number(args.toX), y: number(args.toY) }],
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
