import { mcpTool, mcpToolController } from "./decorators.js";
import { buildPath, pathRefusal, DEFAULT_PATH_OBJECT, DEFAULT_QUEUE_OBJECT } from "../park/pathbuild.js";
import type { DeferredMcpResult } from "./types.js";

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
            "Pave the tiles you name. `tiles` is the whole of it: every tile in that list is paved and no",
            "other tile is touched. Nothing is routed, nothing is filled in between them, nothing is",
            "reordered, and no tile is added to reach anything — the line is yours to draw, tile by tile,",
            "and this lays it and says what happened. One tile is a run.",
            "Set `queue: true` to build a queue line: a ride's entrance needs a queue tile on the tile its",
            "door opens onto, and without one the single guest standing at that door is the whole line. A",
            "ride's exit needs",
            "ordinary path — `queue: false` — on the tile its door opens onto, or guests board and cannot",
            "get off. Those are two runs and they cannot share a tile: ordinary path laid over a queue",
            "unbinds that queue from its ride. That is not refused — whether a park spends one ride's line",
            "on another is yours to weigh — so the run goes down and `ridesLeftWithoutQueue` names every",
            "ride left without a queue, read off the map afterwards rather than predicted from the tiles.",
            "The tile a path goes on is the one a door opens onto rather than the entrance or exit building",
            "itself — park_status gives those two tiles as `entranceDoor` and `exitDoor`, and a path cannot",
            "be laid on a building.",
            "A tile that will not take a path is refused by name with what is on it and the call that lifts",
            "it, and nothing at all is built: the whole run goes down or none of it does. A run has to be",
            "owned, dry, flat, and carrying nothing a footpath cannot share. Dry is the game's own condition —",
            "it refuses a footpath under water one tile at a time, which is what would break the all-or-nothing",
            "above. Flat is this tool's limit rather than",
            "the game's - OpenRCT2 footpaths run up slopes, this tool lays flat path only, and levelling ground",
            "is the game's own landsetheight, landraise, landlower and landsmooth, which `evaluate` reaches.",
            "Each tile is laid at its own ground",
            "height, so tiles at different heights are all laid and do not join up.",
            "Tiles that do not touch each other are laid as given and reported as separate runs; a gap is",
            "not an error here.",
            "`connectedToPark: false` means some tile of the run is an island: the tiles guests can really",
            "walk to are the ones park_status covers with `paths.runs`, and a tile being paved does not make",
            "it one of them. Each run carries a `kind`, so which of those tiles are queue and which are",
            "ordinary path is something you read rather than guess.",
            "`ridesLeftWithoutQueue` names any ride that had a queue bound to it before this call and has",
            "none after — a queue laid onto another ride's queue chains the two lines into one, and nothing",
            "in the game's API shows the first ride lost its line.",
            "Every result has the same shape — `ok`, `tilesPlaced`, `tilesTargeted`, `tiles`,",
            "`connectedToPark`, `ridesLeftWithoutQueue` and `detail` — including refusals, where `detail`",
            "says what was wrong. `tiles` is what this call paved, and handed to `remove_path` as its own",
            "`tiles` it lifts exactly those.",
            "Where paths go is your decision — this only handles the paving."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                tiles: {
                    type: "array",
                    description: "Every tile to pave, each an object with integer `x` and `y`. This is the literal list of tiles that will carry a path — not corners, not endpoints, and nothing is filled in between them. At least one.",
                    minItems: 1,
                    items: {
                        type: "object",
                        description: "One tile to pave, in tile coordinates.",
                        properties: {
                            x: { type: "integer", minimum: 0, description: "Tile x." },
                            y: { type: "integer", minimum: 0, description: "Tile y." }
                        },
                        required: ["x", "y"],
                        additionalProperties: false
                    }
                },
                queue: { type: "boolean", description: "Build a queue line rather than an ordinary path. Default false." },
                surfaceObject: { type: "integer", minimum: 0, description: "Footpath surface style, from context.getAllObjects(\"footpath_surface\"). Queue styles are separate objects. Defaults to a plain path, or a blue queue." },
                railingsObject: { type: "integer", minimum: 0, description: "Railing style, from `footpath_railings` the same way. Default 0." }
            },
            required: ["tiles"],
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
        const tiles: { x: number; y: number }[] = [];

        if (!Array.isArray(args.tiles)) {
            return refuse("`tiles` is missing. build_path paves the tiles you name and nothing else, so"
                + " it needs the list: `tiles` is an array of objects with integer `x` and `y`, and one"
                + " tile is a run. Nothing was built.");
        }

        const given = args.tiles as { x?: unknown; y?: unknown }[];

        for (let i = 0; i < given.length; i++) {
            const tile = given[i];

            // Coercing a malformed tile to -1 would quietly pave from off the map.
            if (!tile || typeof tile.x !== "number" || typeof tile.y !== "number") {
                return refuse("tiles[" + String(i) + "] needs a numeric x and y.");
            }

            tiles.push({ x: Math.floor(tile.x), y: Math.floor(tile.y) });
        }

        const request = {
            tiles: tiles,
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
