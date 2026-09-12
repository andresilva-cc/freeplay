import { mcpTool, mcpToolController } from "./decorators.js";
import { removePath, removePathRefusal } from "../park/pathremove.js";
import type { DeferredMcpResult } from "./types.js";

const END_FIELDS = ["fromX", "fromY", "toX", "toY"];

/** An argument refusal in the same shape removePath answers with, so there is one shape. */
function refuse(detail: string): DeferredMcpResult {
    return {
        deferred: true,
        start: function (resolve) {
            resolve(removePathRefusal(detail));
        }
    };
}

@mcpToolController
export class PathRemoveTools {
    @mcpTool({
        name: "Remove a path",
        description: [
            "Take the footpath or queue off a run of tiles. Coordinates are tile coordinates, and the",
            "addressing is `build_path`'s: either all four of `fromX`, `fromY`, `toX`, `toY`, or `waypoints`,",
            "a list of corners laid as straight runs between them. Nothing is defaulted.",
            "Unlike `build_path` this does not route around anything — the run is the literal line, and a leg",
            "whose ends share neither row nor column turns once, along x first and then along y. To take back",
            "exactly what a `build_path` call laid, pass the `route` it returned as `waypoints`.",
            "Tiles in the run with no footpath on them are left alone and counted; this is the only way to",
            "remove one. An ordinary path laid over a queue unbinds that queue from its ride, and a ride's",
            "entrance claiming a queue, not the queue itself, dead-ends the tile its door opens onto and cuts",
            "off whatever lay past it.",
            "Ride entrances, ride exits and the park gate are not footpaths: a run that crosses one is refused by",
            "name and nothing is removed. A ride itself goes with `operate_ride` `demolish`.",
            "The result reports what the map says afterwards: `tilesRemoved` counted by re-reading each tile,",
            "`reachableFromEntrance` — how many path tiles guests can walk to from the park entrance now — and",
            "`ridesLeftWithoutQueue`, any ride whose bound queue went with the path.",
            "On a refusal nothing is measured, so `reachableFromEntrance` is `null` rather than a number:",
            "it is not a report that the park has been cut off.",
            "`ok: true` means every tile named now carries no footpath, which is also true of a run that never",
            "had one; `tilesRemoved` is what actually came up.",
            "Every result has the same shape, including refusals, where `detail` says what was wrong.",
            "Which tiles to take up is your decision — this only handles the removal."
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
                    description: "Corners of the run, in order, each an object with integer `x` and `y`. A build_path result's `route` can be passed here whole. At least two.",
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
                }
            },
            required: [],
            additionalProperties: false
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false
        }
    })
    public removePath(args: Record<string, unknown>): DeferredMcpResult {
        const waypoints: { x: number; y: number }[] = [];

        if (Array.isArray(args.waypoints)) {
            const given = args.waypoints as { x?: unknown; y?: unknown }[];

            for (let i = 0; i < given.length; i++) {
                const point = given[i];

                // Coercing a malformed point to -1 would quietly run the line off the map.
                if (!point || typeof point.x !== "number" || typeof point.y !== "number") {
                    return refuse("waypoints[" + String(i) + "] needs a numeric x and y.");
                }

                waypoints.push({ x: Math.floor(point.x), y: Math.floor(point.y) });
            }
        }

        if (waypoints.length === 1) {
            return refuse("waypoints needs at least two points: where the run starts and ends."
                + " For a single tile give the same point twice, or give fromX, fromY, toX and toY"
                + " with both ends the same. Nothing was removed.");
        }

        if (waypoints.length === 0) {
            const missing: string[] = [];

            for (let i = 0; i < END_FIELDS.length; i++) {
                if (typeof args[END_FIELDS[i]] !== "number") {
                    missing.push(END_FIELDS[i]);
                }
            }

            if (missing.length > 0) {
                return refuse(missing.join(", ") + (missing.length === 1 ? " is missing" : " are missing")
                    + ". remove_path needs both ends of the run: give fromX, fromY, toX and toY together,"
                    + " or give `waypoints` instead and leave all four out. Nothing was removed.");
            }
        }

        const floor = function (value: unknown): number {
            return Math.floor(value as number);
        };

        const request = {
            points: waypoints.length >= 2
                ? waypoints
                : [{ x: floor(args.fromX), y: floor(args.fromY) }, { x: floor(args.toX), y: floor(args.toY) }]
        };

        return {
            deferred: true,
            start: function (resolve) {
                removePath(request, resolve);
            }
        };
    }
}
