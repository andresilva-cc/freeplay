import { mcpTool, mcpToolController } from "./decorators.js";
import { buildFlatRide } from "../park/build.js";
import type { DeferredMcpResult } from "./types.js";

@mcpToolController
export class BuildTools {
    @mcpTool({
        name: "Build a flat ride",
        description: [
            "Create a flat ride, place it on the ground, attach an entrance and an exit, set the price and open it.",
            "Take `x`, `y` and `rotation` straight from a `find_build_sites` result; the footprint is worked out",
            "from the ride itself, so there is no size to get wrong.",
            "Shops and stalls have no entrance or exit: leave those out, and put a path beside them instead.",
            "For everything else you choose where the doors go with `entranceX`/`entranceY` and `exitX`/`exitY`, from the site's",
            "`access` options. That placement decides the queue's shape: both on the same side usually gives a",
            "shorter, straighter queue than opposite sides.",
            "It builds no paths: use `build_path` for the queue and for the walk away from the exit.",
            "Returns every step with whether it succeeded, and whether guests can actually reach the ride.",
            "This does not build roller coasters; those need track laid piece by piece with `evaluate`."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                rideObject: { type: "integer", description: "Index from context.getAllObjects(\"ride\")." },
                x: { type: "integer", description: "Tile x of the footprint centre." },
                y: { type: "integer", description: "Tile y of the footprint centre." },
                rotation: { type: "integer", description: "Which way the ride faces, 0-3. Use the `rotation` from the site you picked." },
                price: { type: "integer", description: "Ticket price in tenths of a currency unit. 10 means 1.00. Default 10." },
                entranceX: { type: "integer", description: "Tile x for the entrance building. Must be one of the site's `access` options." },
                entranceY: { type: "integer", description: "Tile y for the entrance building." },
                exitX: { type: "integer", description: "Tile x for the exit building." },
                exitY: { type: "integer", description: "Tile y for the exit building." },
                open: { type: "boolean", description: "Open the ride once it is built. Default true." },
                colour1: { type: "integer", description: "Main colour, 0-30. Default 0." },
                colour2: { type: "integer", description: "Second colour, 0-30. Default 0." },
                entranceObject: { type: "integer", description: "Style of the entrance and exit buildings. Default 0." },
                inspectionInterval: { type: "integer", description: "How often mechanics inspect: 0 is most frequent, 6 is never. Default 2." }
            },
            required: ["rideObject", "x", "y", "rotation"],
            additionalProperties: false
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false
        }
    })
    public buildFlatRide(args: Record<string, unknown>): DeferredMcpResult {
        const number = function (value: unknown, fallback: number): number {
            return typeof value === "number" ? Math.floor(value) : fallback;
        };
        const flag = function (value: unknown, fallback: boolean): boolean {
            return typeof value === "boolean" ? value : fallback;
        };

        const request = {
            rideObject: number(args.rideObject, -1),
            x: number(args.x, -1),
            y: number(args.y, -1),
            price: number(args.price, 10),
            open: flag(args.open, true),
            rotation: number(args.rotation, 0) % 4,
            colour1: number(args.colour1, 0),
            colour2: number(args.colour2, 0),
            entranceObject: number(args.entranceObject, 0),
            inspectionInterval: number(args.inspectionInterval, 2),
            entrance: typeof args.entranceX === "number" && typeof args.entranceY === "number"
                ? { x: number(args.entranceX, -1), y: number(args.entranceY, -1) }
                : undefined,
            exit: typeof args.exitX === "number" && typeof args.exitY === "number"
                ? { x: number(args.exitX, -1), y: number(args.exitY, -1) }
                : undefined
        };

        return {
            deferred: true,
            start: function (resolve) {
                buildFlatRide(request, resolve);
            }
        };
    }
}
