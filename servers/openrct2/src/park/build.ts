import { DIRECTION_VECTORS, directionBetween, readMapGrid, toWorld } from "./map.js";
import { queuePathServes, tileIsWalkable, walkableFromParkEntrance } from "./paths.js";
import { flatRideShape, footprintOffsets } from "./flatRides.js";
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
    price: number;
    open: boolean;
    /** Aesthetic and operational choices the player would normally make. */
    colour1: number;
    colour2: number;
    entranceObject: number;
    inspectionInterval: number;
    rotation: number;
    /** Where the entrance and exit buildings go. Their placement decides the queue's
     *  shape, which is park design and therefore the caller's call. Shops have neither. */
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

function accessAt(
    grid: MapGrid,
    cx: number,
    cy: number,
    offsets: { dx: number; dy: number }[],
    z: number,
    tile: { x: number; y: number }
) {
    let facing: number | null = null;

    for (let i = 0; i < offsets.length; i++) {
        const dx = (cx + offsets[i].dx) - tile.x;
        const dy = (cy + offsets[i].dy) - tile.y;

        if (Math.abs(dx) + Math.abs(dy) === 1) {
            facing = directionBetween({ x: 0, y: 0 }, { x: dx, y: dy });
            break;
        }
    }

    if (facing === null) {
        return null;
    }

    const cell = grid.at(tile.x, tile.y);

    // `clearable`, not `clear`: find_build_sites offers tiles with scenery on them and
    // flags needsClearing. Demanding bare ground here rejected the tool's own advice.
    if (!cell || !cell.owned || !cell.clearable || cell.baseZ !== z) {
        return null;
    }

    return { x: tile.x, y: tile.y, direction: facing };
}

export function buildFlatRide(request: BuildFlatRideRequest, done: (outcome: BuildOutcome) => void): void {
    const steps: BuildStep[] = [];
    const finish = function (ok: boolean, rideId: number | null, rideName: string | null, reachable: boolean): void {
        done({ ok: ok, rideId: rideId, rideName: rideName, reachable: reachable, steps: steps });
    };

    const objects = context.getAllObjects("ride");

    if (request.rideObject < 0 || request.rideObject >= objects.length) {
        steps.push({ step: "rideObject", ok: false, detail: "No ride object at index " + String(request.rideObject) + "." });
        return finish(false, null, null, false);
    }

    const rideObject = objects[request.rideObject];
    const shape = flatRideShape(rideObject.rideType[0]);

    if (typeof shape === "undefined") {
        steps.push({
            step: "ride",
            ok: false,
            detail: rideObject.name + " is not a flat ride: it is built from track, piece by piece, with evaluate."
        });
        return finish(false, null, null, false);
    }

    const trackType = shape.trackType;
    const offsets = footprintOffsets(shape, request.rotation);
    const grid = readMapGrid();
    const centre = grid.at(request.x, request.y);

    if (!centre || !centre.owned) {
        steps.push({ step: "site", ok: false, detail: "Tile is outside the park's owned land." });
        return finish(false, null, null, false);
    }

    let access: { entrance: { x: number; y: number; direction: number }; exit: { x: number; y: number; direction: number } } | null = null;

    if (!shape.isShop) {
        if (!request.entrance || !request.exit) {
            steps.push({ step: "site", ok: false, detail: "This ride needs an entrance and an exit tile from the site's `access` list." });
            return finish(false, null, null, false);
        }

        const entranceAccess = accessAt(grid, request.x, request.y, offsets, centre.baseZ, request.entrance);
        const exitAccess = accessAt(grid, request.x, request.y, offsets, centre.baseZ, request.exit);

        if (!entranceAccess || !exitAccess) {
            steps.push({
                step: "site",
                ok: false,
                detail: "The entrance or exit tile is not a clear, level, owned tile touching the footprint."
                    + " Use an option from this site's `access` list, and clear_scenery it first if the"
                + " option says needsClearing."
            });
            return finish(false, null, null, false);
        }

        access = { entrance: entranceAccess, exit: exitAccess };
    }

    const idsBefore: Record<number, boolean> = {};
    map.rides.forEach(function (ride) {
        idsBefore[ride.id] = true;
    });

    let createResult: RideCreateActionResult | undefined;
    context.executeAction("ridecreate", {
        rideType: rideObject.rideType[0],
        rideObject: rideObject.index,
        entranceObject: request.entranceObject,
        colour1: request.colour1,
        colour2: request.colour2,
        inspectionInterval: request.inspectionInterval
    }, function (result) {
        createResult = result as RideCreateActionResult;
    });

    context.setTimeout(function () {
        // The action tells us which ride it made. Diffing the ride list instead breaks
        // the moment two builds are in flight at once - which happens whenever the model
        // issues parallel tool calls, and made two different rides report the same id.
        let rideId: number | null = null;

        if (createResult && typeof createResult.ride === "number") {
            rideId = createResult.ride;
        } else {
            map.rides.forEach(function (ride) {
                if (!idsBefore[ride.id]) {
                    rideId = ride.id;
                }
            });
        }

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

                // ridecreate succeeded, so without this the park keeps a ride with no
                // track on it forever, occupying an id and showing up in park_status.
                context.executeAction("ridedemolish", { ride: created, modifyType: 0 }, function () { /* best effort */ });
                steps.push({ step: "cleanup", ok: true, detail: "removed the ride that had nothing built on it" });

                return finish(false, null, null, false);
            }

            steps.push({ step: "trackplace", ok: true, detail: "track type " + String(trackType) });

            if (access) {
                context.executeAction("rideentranceexitplace", {
                    x: toWorld(access.entrance.x), y: toWorld(access.entrance.y),
                    direction: access.entrance.direction, ride: created, station: 0, isExit: false
                }, function () { /* verified by re-read */ });

                context.executeAction("rideentranceexitplace", {
                    x: toWorld(access.exit.x), y: toWorld(access.exit.y),
                    direction: access.exit.direction, ride: created, station: 0, isExit: true
                }, function () { /* verified by re-read */ });
            }

            context.setTimeout(function () {
                if (access) {
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
                } else {
                    steps.push({ step: "entrance/exit", ok: true, detail: "shops have none; guests buy from the path beside it" });
                }

                context.setTimeout(function () {
                    // Report, do not fix: where paths go is the player's decision.
                    const nowWalkable = walkableFromParkEntrance();
                    let reachable: boolean;

                    if (access) {
                        const entranceDoor = apronTile(access.entrance);
                        const exitDoor = apronTile(access.exit);
                        const queued = queuePathServes(entranceDoor, created);
                        const exitOk = tileIsWalkable(nowWalkable, exitDoor);
                        // Both halves matter: a ride guests can enter but not leave backs up.
                        reachable = queued && tileIsWalkable(nowWalkable, entranceDoor) && exitOk;

                        steps.push({
                            step: "access",
                            ok: reachable && exitOk,
                            detail: "entrance door is at " + String(entranceDoor.x) + "," + String(entranceDoor.y)
                                + " and exit door at " + String(exitDoor.x) + "," + String(exitDoor.y) + ". "
                                + (queued ? "A queue serves the entrance" : "NO QUEUE at the entrance - guests cannot board")
                                + "; " + (exitOk ? "the exit reaches the park's paths" : "the exit is not connected")
                                + (reachable && exitOk ? "." : ". Use build_path to connect them.")
                        });
                    } else {
                        // A shop is served by whichever path touches it.
                        const steps4 = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];
                        let touching = false;

                        for (let i = 0; i < steps4.length; i++) {
                            if (tileIsWalkable(nowWalkable, { x: request.x + steps4[i].dx, y: request.y + steps4[i].dy })) {
                                touching = true;
                                break;
                            }
                        }

                        reachable = touching;
                        steps.push({
                            step: "access",
                            ok: touching,
                            detail: touching
                                ? "A path reaches this shop."
                                : "NO PATH touches this shop, so nobody can buy from it. Run build_path to one of its"
                                    + " four neighbouring tiles."
                        });
                    }

                    context.executeAction("ridesetprice", { ride: created, price: request.price, isPrimaryPrice: true }, function () { /* verified by re-read */ });

                    if (request.open) {
                        context.executeAction("ridesetstatus", { ride: created, status: 1 }, function () { /* verified by re-read */ });
                    }

                    context.setTimeout(function () {
                        const ride = map.getRide(created);
                        const opened = ride.status === "open";
                        const actualPrice = ride.price.length > 0 ? ride.price[0] : 0;

                        steps.push({
                            step: "price",
                            ok: actualPrice === request.price,
                            detail: actualPrice === request.price
                                ? "charging " + String(actualPrice)
                                : "asked for " + String(request.price) + " but the ride is charging "
                                    + String(actualPrice) + "; the scenario may fix ride prices."
                        });

                        if (request.open && !opened) {
                            steps.push({ step: "open", ok: false, detail: "Ride is still " + ride.status + "." });
                            return finish(false, created, ride.name, reachable);
                        }

                        steps.push({ step: "open", ok: true, detail: ride.status });
                        // `ok` is whether the ride got built. Whether guests can use it is
                        // `reachable`, and is a separate job - this tool lays no paths, so
                        // reporting a correct build as a failure makes the model build it twice.
                        finish(true, created, ride.name, reachable);
                    }, STEP_DELAY_MS);
                }, STEP_DELAY_MS);
            }, STEP_DELAY_MS);
        }, STEP_DELAY_MS);
    }, STEP_DELAY_MS);
}
