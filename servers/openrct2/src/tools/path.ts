import { mcpTool, mcpToolController } from "./decorators.js";
import { buildPath, pathRefusal, DEFAULT_PATH_OBJECT, DEFAULT_QUEUE_OBJECT } from "../park/pathbuild.js";
import type { DeferredMcpResult } from "./types.js";

const END_FIELDS = ["fromX", "fromY", "toX", "toY"];

/** An argument refusal in the same shape buildPath answers with, so there is one shape. */
function refuse(detail: string): DeferredMcpResult {
    return {
        deferred: true,
        start: function (resolve) {
            resolve(pathRefusal(detail));
        }
    };
}

@mcpToolController
export class PathTools {
    @mcpTool({
        name: "Build a path",
        description: [
            "Lay a footpath or a queue line. Coordinates are tile coordinates, and every tile you name is paved.",
            "Give `waypoints` to draw the line yourself — a list of corners, laid as straight runs between them.",
            "That is how you control the shape of your park. With only `fromX/fromY` and `toX/toY` the tool picks",
            "the line for you, which is convenient but means it is choosing your layout.",
            "Give either all four of `fromX`, `fromY`, `toX`, `toY`, or `waypoints`; nothing is defaulted.",
            "Either way it routes around trees, because you cannot see them from here.",
            "Set `queue: true` to build a queue line: a ride's entrance needs a queue tile touching its door,",
            "or guests crowd around the building and never board. Ordinary paths are how guests get anywhere else.",
            "Aim at the tile a door opens onto, never at the entrance or exit building itself — park_status gives",
            "those tiles as `entranceDoor` and `exitDoor`. A path cannot be laid on a building.",
            "`connectedToPark: false` means one end is an island: the tiles guests can really walk to are",
            "park_status `paths.reachableSample`, and a tile being paved does not make it one of them.",
            "Every result has the same shape — `ok`, `tilesPlaced`, `tilesRouted`, `route`, `connectedToPark`",
            "and `detail` — including refusals, where `detail` says what was wrong.",
            "Where paths go is your decision — this only handles the placement."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                fromX: { type: "integer", minimum: 0, description: "Tile x of one end. Required with fromY, toX and toY unless you give waypoints." },
                fromY: { type: "integer", minimum: 0, description: "Tile y of one end." },
                toX: { type: "integer", minimum: 0, description: "Tile x of the other end." },
                toY: { type: "integer", minimum: 0, description: "Tile y of the other end." },
                waypoints: {
                    type: "array",
                    description: "Corners of the path, in order, each an object with integer `x` and `y`. Use this to choose the shape yourself. At least two.",
                    minItems: 2,
                    items: {
                        type: "object",
                        description: "One corner, in tile coordinates.",
                        properties: {
                            x: { type: "integer", minimum: 0, description: "Tile x of this corner." },
                            y: { type: "integer", minimum: 0, description: "Tile y of this corner." }
                        },
                        required: ["x", "y"],
                        additionalProperties: false
                    }
                },
                queue: { type: "boolean", description: "Build a queue line rather than an ordinary path. Default false." },
                surfaceObject: { type: "integer", minimum: 0, description: "Footpath surface style, from context.getAllObjects(\"footpath_surface\"). Queue styles are separate objects. Defaults to a plain path, or a blue queue." },
                railingsObject: { type: "integer", minimum: 0, description: "Railing style, from context.getAllObjects(\"footpath_railings\"). Default 0." }
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
        const queue = args.queue === true;
        const waypoints: { x: number; y: number }[] = [];

        if (Array.isArray(args.waypoints)) {
            const given = args.waypoints as { x?: unknown; y?: unknown }[];

            for (let i = 0; i < given.length; i++) {
                const point = given[i];

                // Coercing a malformed point to -1 would quietly route from off the map.
                if (!point || typeof point.x !== "number" || typeof point.y !== "number") {
                    return refuse("waypoints[" + String(i) + "] needs a numeric x and y.");
                }

                waypoints.push({ x: Math.floor(point.x), y: Math.floor(point.y) });
            }
        }

        if (waypoints.length === 1) {
            return refuse("waypoints needs at least two points: where the path starts and ends.");
        }

        if (waypoints.length === 0) {
            // A missing end was floored to -1 and routed from off the map, which came back
            // as "no level, owned, unobstructed route" - a routing failure standing in for
            // an argument that was never given.
            const missing: string[] = [];

            for (let i = 0; i < END_FIELDS.length; i++) {
                if (typeof args[END_FIELDS[i]] !== "number") {
                    missing.push(END_FIELDS[i]);
                }
            }

            if (missing.length > 0) {
                return refuse(missing.join(", ") + (missing.length === 1 ? " is missing" : " are missing")
                    + ". build_path needs both ends of the run: give fromX, fromY, toX and toY together,"
                    + " or give `waypoints` instead and leave all four out. Nothing was built.");
            }
        }

        const floor = function (value: unknown): number {
            return Math.floor(value as number);
        };

        const request = {
            points: waypoints.length >= 2
                ? waypoints
                : [{ x: floor(args.fromX), y: floor(args.fromY) }, { x: floor(args.toX), y: floor(args.toY) }],
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
