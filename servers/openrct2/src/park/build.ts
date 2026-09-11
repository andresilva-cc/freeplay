import { DIRECTION_VECTORS, directionBetween, unitStep, readMapGrid, toWorld } from "./map.js";
import { queuePathServes, tileIsWalkable, walkableFromParkEntrance } from "./paths.js";
import { flatTrackTypeForSize } from "./sites.js";
import type { MapGrid } from "./map.js";

/** Game actions apply on a later tick, so every step waits before verifying. */
const STEP_DELAY_MS = 150;

/**
 * The door of an entrance or exit faces away from the ride, so its path must land on
 * the tile beyond it. A path alongside the kiosk touches a wall and connects nothing.
 */
function apronTile(access: { x: number; y: number; direction: number }): { x: number; y: number } {
    const towardsRide = DIRECTION_VECTORS[access.direction % 4];
    return { x: access.x - towardsRide.dx, y: access.y - towardsRide.dy };
}

export interface BuildFlatRideRequest {
    rideObject: number;
    x: number;
    y: number;
    size: number;
    price: number;
    open: boolean;
    /** Aesthetic and operational choices the player would normally make. */
    colour1: number;
    colour2: number;
    entranceObject: number;
    inspectionInterval: number;
    rotation: number;
    /** Where the entrance and exit buildings go. Omit to let the tool pick the two
     *  tiles closest to a path — but placing them yourself is how you control the
     *  queue's shape, and putting both on the same side is often tidier. */
    entrance?: { x: number; y: number };
    exit?: { x: number; y: number };
}

export interface BuildStep {
    step: string;
    ok: boolean;
    detail?: string;
}

export interface BuildOutcome {
    ok: boolean;
    rideId: number | null;
    rideName: string | null;
    /** Whether guests can actually walk from the existing paths to this ride. */
    reachable: boolean;
    steps: BuildStep[];
}

function actionError(result: GameActionResult | undefined): string | undefined {
    if (!result || !result.error) {
        return undefined;
    }
    return (result.errorTitle || "") + (result.errorMessage ? ": " + result.errorMessage : "");
}

function tileHasTrackFor(x: number, y: number, rideId: number): boolean {
    const tile = map.getTile(x, y);

    for (let i = 0; i < tile.numElements; i++) {
        const element = tile.getElement(i);
        if (element.type === "track" && (element as TrackElement).ride === rideId) {
            return true;
        }
    }

    return false;
}

function accessAt(grid: MapGrid, cx: number, cy: number, size: number, z: number, tile: { x: number; y: number }) {
    const half = Math.floor(size / 2);
    const withinSide = Math.abs(tile.x - cx) === half + 1 || Math.abs(tile.y - cy) === half + 1;

    if (!withinSide) {
        return null;
    }

    const cell = grid.at(tile.x, tile.y);

    if (!cell || !cell.owned || !cell.clear || cell.baseZ !== z) {
        return null;
    }

    const towards = { x: tile.x + unitStep(cx - tile.x), y: tile.y + unitStep(cy - tile.y) };
    return { x: tile.x, y: tile.y, direction: directionBetween(tile, towards) };
}

/** Fallback when the caller does not say where the doors go: the two tiles nearest a path. */
function nearestAccessPair(grid: MapGrid, cx: number, cy: number, size: number, z: number) {
    const half = Math.floor(size / 2);
    const candidates: { x: number; y: number; direction: number; distance: number }[] = [];

    for (let d = 0; d < DIRECTION_VECTORS.length; d++) {
        const outward = DIRECTION_VECTORS[d];

        for (let offset = -half; offset <= half; offset++) {
            const along = { dx: outward.dy, dy: outward.dx };
            const tile = {
                x: cx + outward.dx * (half + 1) + along.dx * offset,
                y: cy + outward.dy * (half + 1) + along.dy * offset
            };
            const access = accessAt(grid, cx, cy, size, z, tile);

            if (!access) {
                continue;
            }

            const door = { x: tile.x + outward.dx, y: tile.y + outward.dy };
            const doorCell = grid.at(door.x, door.y);

            if (!doorCell || !doorCell.owned) {
                continue;
            }

            candidates.push({
                x: access.x,
                y: access.y,
                direction: access.direction,
                distance: nearestPathDistance(grid, door.x, door.y)
            });
        }
    }

    if (candidates.length < 2) {
        return null;
    }

    candidates.sort(function (left, right) {
        return left.distance - right.distance;
    });

    return { entrance: candidates[0], exit: candidates[1] };
}

function nearestPathDistance(grid: MapGrid, x: number, y: number): number {
    let best = Infinity;

    for (let ty = 0; ty < grid.height; ty++) {
        for (let tx = 0; tx < grid.width; tx++) {
            const cell = grid.at(tx, ty);

            if (!cell || !cell.path) {
                continue;
            }

            const distance = Math.abs(tx - x) + Math.abs(ty - y);

            if (distance < best) {
                best = distance;
            }
        }
    }

    return best;
}

export function buildFlatRide(request: BuildFlatRideRequest, done: (outcome: BuildOutcome) => void): void {
    const steps: BuildStep[] = [];
    const finish = function (ok: boolean, rideId: number | null, rideName: string | null, reachable: boolean): void {
        done({ ok: ok, rideId: rideId, rideName: rideName, reachable: reachable, steps: steps });
    };

    const trackType = flatTrackTypeForSize(request.size);

    if (typeof trackType === "undefined") {
        steps.push({ step: "size", ok: false, detail: "No flat-ride track piece for size " + String(request.size) + "; use 1, 2, 3 or 4." });
        return finish(false, null, null, false);
    }

    const objects = context.getAllObjects("ride");

    if (request.rideObject < 0 || request.rideObject >= objects.length) {
        steps.push({ step: "rideObject", ok: false, detail: "No ride object at index " + String(request.rideObject) + "." });
        return finish(false, null, null, false);
    }

    const rideObject = objects[request.rideObject];
    const grid = readMapGrid();
    const centre = grid.at(request.x, request.y);

    if (!centre || !centre.owned) {
        steps.push({ step: "site", ok: false, detail: "Tile is outside the park's owned land." });
        return finish(false, null, null, false);
    }

    let access: { entrance: { x: number; y: number; direction: number }; exit: { x: number; y: number; direction: number } } | null = null;

    if (request.entrance && request.exit) {
        const entrance = accessAt(grid, request.x, request.y, request.size, centre.baseZ, request.entrance);
        const exit = accessAt(grid, request.x, request.y, request.size, centre.baseZ, request.exit);

        if (!entrance || !exit) {
            steps.push({ step: "site", ok: false, detail: "Those entrance or exit tiles are not clear, level, owned tiles touching the footprint." });
            return finish(false, null, null, false);
        }

        access = { entrance: entrance, exit: exit };
    } else {
        access = nearestAccessPair(grid, request.x, request.y, request.size, centre.baseZ);
    }

    if (!access) {
        steps.push({ step: "site", ok: false, detail: "No pair of clear tiles around the footprint for an entrance and exit." });
        return finish(false, null, null, false);
    }

    const idsBefore: Record<number, boolean> = {};
    map.rides.forEach(function (ride) {
        idsBefore[ride.id] = true;
    });

    let createResult: GameActionResult | undefined;
    context.executeAction("ridecreate", {
        rideType: rideObject.rideType[0],
        rideObject: rideObject.index,
        entranceObject: request.entranceObject,
        colour1: request.colour1,
        colour2: request.colour2,
        inspectionInterval: request.inspectionInterval
    }, function (result) {
        createResult = result;
    });

    context.setTimeout(function () {
        let rideId: number | null = null;
        map.rides.forEach(function (ride) {
            if (!idsBefore[ride.id]) {
                rideId = ride.id;
            }
        });

        if (rideId === null) {
            steps.push({ step: "ridecreate", ok: false, detail: actionError(createResult) || "Ride was not created." });
            return finish(false, null, null, false);
        }

        const created = rideId as number;
        steps.push({ step: "ridecreate", ok: true, detail: "ride " + String(created) });

        let trackResult: GameActionResult | undefined;
        context.executeAction("trackplace", {
            x: toWorld(request.x),
            y: toWorld(request.y),
            z: centre.baseZ,
            direction: request.rotation,
            ride: created,
            trackType: trackType,
            rideType: rideObject.rideType[0],
            brakeSpeed: 0,
            colour: 0,
            seatRotation: 4,
            trackPlaceFlags: 0,
            isFromTrackDesign: false
        }, function (result) {
            trackResult = result;
        });

        context.setTimeout(function () {
            if (!tileHasTrackFor(request.x, request.y, created)) {
                steps.push({ step: "trackplace", ok: false, detail: actionError(trackResult) || "Nothing was built on the ground." });
                return finish(false, created, map.getRide(created) ? map.getRide(created).name : null, false);
            }

            steps.push({ step: "trackplace", ok: true, detail: "track type " + String(trackType) });

            context.executeAction("rideentranceexitplace", {
                x: toWorld(access.entrance.x), y: toWorld(access.entrance.y),
                direction: access.entrance.direction, ride: created, station: 0, isExit: false
            }, function () { /* verified by re-read */ });

            context.executeAction("rideentranceexitplace", {
                x: toWorld(access.exit.x), y: toWorld(access.exit.y),
                direction: access.exit.direction, ride: created, station: 0, isExit: true
            }, function () { /* verified by re-read */ });

            context.setTimeout(function () {
                const station = map.getRide(created).stations[0];

                if (!station || !station.entrance || !station.exit) {
                    steps.push({ step: "entrance/exit", ok: false, detail: "Entrance or exit did not attach to the station." });
                    return finish(false, created, map.getRide(created).name, false);
                }

                steps.push({
                    step: "entrance/exit",
                    ok: true,
                    detail: "entrance " + String(access.entrance.x) + "," + String(access.entrance.y)
                        + " exit " + String(access.exit.x) + "," + String(access.exit.y)
                });

                context.setTimeout(function () {
                    // Report, do not fix: where paths go is the player's decision.
                    const entranceDoor = apronTile(access.entrance);
                    const exitDoor = apronTile(access.exit);
                    const nowWalkable = walkableFromParkEntrance();
                    const queued = queuePathServes(entranceDoor, created);
                    const exitOk = tileIsWalkable(nowWalkable, exitDoor);
                    const reachable = queued && tileIsWalkable(nowWalkable, entranceDoor);

                    steps.push({
                        step: "access",
                        ok: reachable && exitOk,
                        detail: "entrance door is at " + String(entranceDoor.x) + "," + String(entranceDoor.y)
                            + " and exit door at " + String(exitDoor.x) + "," + String(exitDoor.y) + ". "
                            + (queued ? "A queue serves the entrance" : "NO QUEUE at the entrance - guests cannot board")
                            + "; " + (exitOk ? "the exit reaches the park's paths" : "the exit is not connected")
                            + (reachable && exitOk ? "." : ". Use build_path to connect them.")
                    });

                    context.executeAction("ridesetprice", { ride: created, price: request.price, isPrimaryPrice: true }, function () { /* verified by re-read */ });

                    if (request.open) {
                        context.executeAction("ridesetstatus", { ride: created, status: 1 }, function () { /* verified by re-read */ });
                    }

                    context.setTimeout(function () {
                        const ride = map.getRide(created);
                        const opened = ride.status === "open";

                        if (request.open && !opened) {
                            steps.push({ step: "open", ok: false, detail: "Ride is still " + ride.status + "." });
                            return finish(false, created, ride.name, reachable);
                        }

                        steps.push({ step: "open", ok: true, detail: ride.status });
                        finish(reachable, created, ride.name, reachable);
                    }, STEP_DELAY_MS);
                }, STEP_DELAY_MS);
            }, STEP_DELAY_MS);
        }, STEP_DELAY_MS);
    }, STEP_DELAY_MS);
}
