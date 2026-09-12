import { DIRECTION_VECTORS, directionBetween, readMapGrid, toWorld } from "./map.js";
import { queuePathServes, tileIsWalkable, walkableFromParkEntrance } from "./paths.js";
import { flatRideShape, footprintOffsets, shopServingTile } from "./flatRides.js";
import type { MapGrid } from "./map.js";

/** Game actions apply on a later tick, so every step waits before verifying. */
const STEP_DELAY_MS = 150;

/**
 * OpenRCT2 refuses any game action that does not carry `Flags::AllowWhilePaused` while the
 * game is paused - `GameActionRunner.cpp`, `CheckActionInPausedMode` - answering
 * STR_CONSTRUCTION_NOT_POSSIBLE_WHILE_GAME_IS_PAUSED.
 *
 * Of the six actions a build fires, `ridecreate`, `ridesetprice` and `ridesetstatus` carry
 * the flag and `trackplace`, `rideentranceexitplace` and the `ridedemolish` that cleans up
 * after a failed track do not. That split is the whole problem: a build started while
 * paused creates the ride, cannot lay a single tile of its track, and cannot take the ride
 * back out again either - and the remedy the failure would otherwise name, `operate_ride`
 * with `demolish`, is the same refused action.
 */
function gamePaused(): boolean {
    return context.paused === true;
}

/**
 * `gamesetspeed` and `pausetoggle` both carry `Flags::AllowWhilePaused`, so this is the one
 * call named in a paused refusal that is not itself refused by the pause.
 */
const UNPAUSE_CALL = "set_game_speed is not one of the calls a paused game refuses, so"
    + " set_game_speed {paused: false} goes through and starts the clock.";

/** Scenery a player bulldozes. Anything else standing on a tile is a structure. */
const REMOVABLE_TYPES: Record<string, boolean> = {
    small_scenery: true,
    large_scenery: true,
    wall: true,
    banner: true
};

/**
 * The door of an entrance or exit faces away from the ride, so its path must land on
 * the tile beyond it. A path alongside the kiosk touches a wall and connects nothing.
 */
function apronTile(access: { x: number; y: number; direction: number }): { x: number; y: number } {
    const towardsRide = DIRECTION_VECTORS[access.direction % 4];
    return { x: access.x - towardsRide.dx, y: access.y - towardsRide.dy };
}

/** What is standing on a tile that a bulldozer would not shift, named by element type. */
function immovableElementsOn(x: number, y: number): string[] {
    const tile = map.getTile(x, y);
    const seen: Record<string, boolean> = {};
    const names: string[] = [];

    for (let i = 0; i < tile.numElements; i++) {
        const type = tile.getElement(i).type;

        if (type === "surface" || REMOVABLE_TYPES[type] || seen[type]) {
            continue;
        }

        seen[type] = true;
        names.push(type);
    }

    return names;
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
    /**
     * The ride exists and its track is standing on the ground. Deliberately not "every
     * step worked": a ride that is built but shut, or built but missing a door, is still
     * a ride that was paid for. Reporting those as `ok: false` had the model build a
     * second copy of something already standing.
     */
    ok: boolean;
    rideId: number | null;
    rideName: string | null;
    /** Both doors are attached to the station. Null for a shop, which has neither. */
    doorsAttached: boolean | null;
    /** Whether the ride is open right now. Failing to open is not a failure to build. */
    open: boolean;
    /** Whether guests can actually walk from the existing paths to this ride. */
    reachable: boolean;
    steps: BuildStep[];
}

interface FinishState {
    ok: boolean;
    rideId: number | null;
    rideName: string | null;
    doorsAttached: boolean | null;
    open: boolean;
    reachable: boolean;
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

/** The rectangle the ride's track will cover, for messages about tiles that miss it. */
function footprintBounds(cx: number, cy: number, offsets: { dx: number; dy: number }[]): string {
    let minX = cx + offsets[0].dx;
    let maxX = minX;
    let minY = cy + offsets[0].dy;
    let maxY = minY;

    for (let i = 1; i < offsets.length; i++) {
        const x = cx + offsets[i].dx;
        const y = cy + offsets[i].dy;

        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
    }

    return "x " + String(minX) + "-" + String(maxX) + ", y " + String(minY) + "-" + String(maxY);
}

interface AccessAttempt {
    access?: { x: number; y: number; direction: number };
    /** The one condition this tile failed, as a clause that follows the coordinates. */
    reason?: string;
    /**
     * True when the tile carries something find_build_sites would never have offered.
     * The caller's `access` list is therefore older than the ground, and re-reading it
     * is the fix - which is the opposite of "pick another option from the list you have".
     */
    stale?: boolean;
}

function accessAt(
    grid: MapGrid,
    cx: number,
    cy: number,
    offsets: { dx: number; dy: number }[],
    z: number,
    tile: { x: number; y: number }
): AccessAttempt {
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
        return { reason: "does not touch the ride's footprint, which covers " + footprintBounds(cx, cy, offsets) };
    }

    const cell = grid.at(tile.x, tile.y);

    if (!cell) {
        return { reason: "is off the map" };
    }

    if (!cell.owned) {
        return { reason: "is not land the park owns" };
    }

    if (!cell.flat) {
        return { reason: "is on a slope, and a door needs level ground" };
    }

    if (cell.baseZ !== z) {
        return {
            reason: "is not level with the ride: its ground is at height " + String(cell.baseZ)
                + " and the footprint is at height " + String(z)
        };
    }

    // `clearable`, not `clear`: find_build_sites offers tiles with scenery on them and
    // flags needsClearing. Demanding bare ground here rejected the tool's own advice.
    if (!cell.clearable) {
        const blockers = immovableElementsOn(tile.x, tile.y);

        return {
            reason: "is not clear: " + (blockers.length > 0 ? blockers.join(" and ") : "a structure")
                + " is standing on it, and that is not scenery a bulldozer removes",
            stale: true
        };
    }

    // Touching the footprint is necessary and not sufficient. find_build_sites checks the
    // tile the door will open onto as well, and a build that skipped it accepted a door
    // nothing could ever queue to - and then reported success, which is the worst shape a
    // failure takes here.
    const door = apronTile({ x: tile.x, y: tile.y, direction: facing });
    const doorCell = grid.at(door.x, door.y);
    const opensOnto = "touches the footprint, but the tile its door would open onto, "
        + String(door.x) + "," + String(door.y) + ", ";

    if (!doorCell) {
        return { reason: opensOnto + "is off the map, so no queue could ever reach this door" };
    }

    if (!doorCell.owned) {
        return { reason: opensOnto + "is not land the park owns, so no queue could ever reach this door" };
    }

    if (!doorCell.clearable && !doorCell.path) {
        const blockers = immovableElementsOn(door.x, door.y);

        return {
            reason: opensOnto + "is blocked by " + (blockers.length > 0 ? blockers.join(" and ") : "a structure")
                + ", so no queue could ever reach this door",
            stale: true
        };
    }

    const servingRide = queueServingOther(door.x, door.y);

    if (servingRide !== null) {
        return {
            reason: opensOnto + "is already the queue for ride " + String(servingRide)
                + ". Putting a door on it would re-chain that queue to this ride and leave ride "
                + String(servingRide) + " with none",
            stale: true
        };
    }

    return { access: { x: tile.x, y: tile.y, direction: facing } };
}

/** The ride a queue on this tile already serves, or null. An unbound queue chains freely. */
function queueServingOther(x: number, y: number): number | null {
    const tile = map.getTile(x, y);

    for (let i = 0; i < tile.numElements; i++) {
        const element = tile.getElement(i);

        if (element.type !== "footpath") {
            continue;
        }

        const path = element as FootpathElement;

        if (path.isQueue && typeof path.ride === "number") {
            return path.ride;
        }
    }

    return null;
}

/** "entranceX/entranceY 12,10" - the argument names, so the model edits the right one. */
function doorLabel(field: string, tile: { x: number; y: number }): string {
    return field + "X/" + field + "Y " + String(tile.x) + "," + String(tile.y);
}

export function buildFlatRide(request: BuildFlatRideRequest, done: (outcome: BuildOutcome) => void): void {
    const steps: BuildStep[] = [];
    const finish = function (state: FinishState): void {
        done({
            ok: state.ok,
            rideId: state.rideId,
            rideName: state.rideName,
            doorsAttached: state.doorsAttached,
            open: state.open,
            reachable: state.reachable,
            steps: steps
        });
    };
    const refuse = function (): void {
        finish({ ok: false, rideId: null, rideName: null, doorsAttached: null, open: false, reachable: false });
    };

    // Checked before anything else, and before a single action is fired. A paused game
    // refuses trackplace, so no build can finish; ridecreate is not refused, so going ahead
    // would buy a ride, leave the ground empty, and strand it - the cleanup is refused too.
    // Every other refusal below is a true statement about a call that was never going to
    // run, so naming one of those instead would cost a turn and still leave the game paused.
    if (gamePaused()) {
        steps.push({
            step: "paused",
            ok: false,
            detail: "The game is paused, and OpenRCT2 refuses construction while it is: trackplace and"
                + " rideentranceexitplace both come back \"Construction not possible while game is paused!\"."
                + " ridecreate is not refused, so going ahead would create the ride, put no track on the"
                + " ground, and then fail to remove it - leaving a ride in the park with no track that"
                + " operate_ride demolish cannot take out either, for the same reason. Nothing was created"
                + " and nothing was charged. " + UNPAUSE_CALL
        });
        return refuse();
    }

    const objects = context.getAllObjects("ride");
    // Indexed by `.index`, not by position: `list_ride_objects` reports `.index`, and the
    // two only coincide while the loaded object list has no gaps in it.
    let rideObject: RideObject | undefined;

    for (let i = 0; i < objects.length; i++) {
        if (objects[i].index === request.rideObject) {
            rideObject = objects[i];
            break;
        }
    }

    if (!rideObject) {
        steps.push({
            step: "rideObject",
            ok: false,
            detail: "No ride object has index " + String(request.rideObject) + "."
                + " `rideObject` is the `index` field of an entry from list_ride_objects, which is not the same"
                + " as its position in that list. Call list_ride_objects and copy the `index` of the ride you want."
        });
        return refuse();
    }

    const shape = flatRideShape(rideObject.rideType[0]);

    if (typeof shape === "undefined") {
        steps.push({
            step: "ride",
            ok: false,
            detail: rideObject.name + " is not a flat ride: it is built from track, piece by piece, with evaluate."
        });
        return refuse();
    }

    const trackType = shape.trackType;
    const offsets = footprintOffsets(shape, request.rotation);
    const grid = readMapGrid();
    const centre = grid.at(request.x, request.y);

    if (!centre || !centre.owned) {
        steps.push({ step: "site", ok: false, detail: "Tile is outside the park's owned land." });
        return refuse();
    }

    let access: { entrance: { x: number; y: number; direction: number }; exit: { x: number; y: number; direction: number } } | null = null;

    if (!shape.isShop) {
        if (!request.entrance || !request.exit) {
            steps.push({
                step: "site",
                ok: false,
                detail: rideObject.name + " is not a shop, so it needs a door on each side: pass entranceX,"
                    + " entranceY, exitX and exitY. Take entranceX/entranceY from one option in this site's"
                    + " `access` list and exitX/exitY from another. Only shops and stalls go up without them."
            });
            return refuse();
        }

        // One tile holds one door: placing the exit on the entrance's tile replaces it, and
        // the build then fails further down with a message that does not name this cause.
        if (request.entrance.x === request.exit.x && request.entrance.y === request.exit.y) {
            steps.push({
                step: "site",
                ok: false,
                detail: "entranceX/entranceY and exitX/exitY are the same tile, "
                    + String(request.entrance.x) + "," + String(request.entrance.y) + "."
                    + " A tile holds one door, so the exit would replace the entrance and the ride would end up"
                    + " with neither. Change exitX/exitY to a different option from this site's `access` list:"
                    + " two options with different `side` values put the doors on different faces of the ride."
            });
            return refuse();
        }

        const entranceAttempt = accessAt(grid, request.x, request.y, offsets, centre.baseZ, request.entrance);
        const exitAttempt = accessAt(grid, request.x, request.y, offsets, centre.baseZ, request.exit);

        if (!entranceAttempt.access || !exitAttempt.access) {
            const faults: string[] = [];

            if (!entranceAttempt.access) {
                faults.push(doorLabel("entrance", request.entrance) + " " + String(entranceAttempt.reason));
            }

            if (!exitAttempt.access) {
                faults.push(doorLabel("exit", request.exit) + " " + String(exitAttempt.reason));
            }

            let intact = "";

            if (entranceAttempt.access && !exitAttempt.access) {
                intact = " " + doorLabel("entrance", request.entrance) + " is fine; only the exit has to change.";
            } else if (exitAttempt.access && !entranceAttempt.access) {
                intact = " " + doorLabel("exit", request.exit) + " is fine; only the entrance has to change.";
            }

            // Two failures that read alike and need opposite answers. A tile that simply is
            // not a door position is fixed from the `access` list already in hand; a tile with
            // a structure on it was never in one, so the list itself is out of date and the
            // model has to go back to find_build_sites. Six thrashing sessions came from
            // telling it to re-use an `access` list that no longer described the ground.
            const stale = (!entranceAttempt.access && entranceAttempt.stale === true)
                || (!exitAttempt.access && exitAttempt.stale === true);

            steps.push({
                step: "site",
                ok: false,
                detail: faults.join(". ") + "." + intact
                    + (stale
                        ? " find_build_sites never offers a tile like that, so these coordinates either did not come"
                            + " from its `access` list or that list is now out of date: the ground changes as you"
                            + " build, and a build that fails leaves its track behind. Call find_build_sites for this"
                            + " ride again and take a fresh `access` pair from the result. Do not re-send these"
                            + " coordinates and do not guess new ones."
                        : " Pick a different option from this site's `access` list: every option in it is a clear,"
                            + " level, owned tile touching this footprint, with somewhere for its queue behind it.")
            });
            return refuse();
        }

        access = { entrance: entranceAttempt.access, exit: exitAttempt.access };
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
            return refuse();
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
                let demolishResult: GameActionResult | undefined;
                context.executeAction("ridedemolish", { ride: created, modifyType: 0 }, function (result) {
                    demolishResult = result;
                });

                return context.setTimeout(function () {
                    const stillThere = !!map.getRide(created);
                    // Read back now rather than inferred from the refusal text: the pause can
                    // only have arrived after this build started, so the state at the moment
                    // the message is written is the one the model has to act on.
                    const pausedNow = gamePaused();

                    steps.push({
                        step: "cleanup",
                        ok: !stillThere,
                        detail: stillThere
                            ? "Ride " + String(created) + " was created but nothing was built on the ground, and"
                                + " removing it failed: "
                                + (actionError(demolishResult)
                                    || "the game accepted ridedemolish but the ride is still there")
                                + ". It is in the park with no track."
                                // Naming operate_ride demolish on its own here is a remedy that
                                // cannot work while the game is paused: it fires the same
                                // ridedemolish the game has just refused.
                                + (pausedNow
                                    ? " The game is paused, and ridedemolish is one of the actions a paused game"
                                        + " refuses, so operate_ride {ride: " + String(created) + ", demolish: true}"
                                        + " is refused for the same reason and cannot remove it yet. " + UNPAUSE_CALL
                                        + " operate_ride {ride: " + String(created) + ", demolish: true} takes the"
                                        + " ride out once the clock is running."
                                    : " Remove it with operate_ride {ride: " + String(created)
                                        + ", demolish: true} before building again.")
                            : "removed the ride that had nothing built on it"
                    });

                    finish({
                        ok: false,
                        rideId: stillThere ? created : null,
                        rideName: null,
                        doorsAttached: null,
                        open: false,
                        reachable: false
                    });
                }, STEP_DELAY_MS) as unknown as void;
            }

            steps.push({ step: "trackplace", ok: true, detail: "track type " + String(trackType) });

            let entranceResult: GameActionResult | undefined;
            let exitResult: GameActionResult | undefined;

            if (access) {
                context.executeAction("rideentranceexitplace", {
                    x: toWorld(access.entrance.x), y: toWorld(access.entrance.y),
                    direction: access.entrance.direction, ride: created, station: 0, isExit: false
                }, function (result) { entranceResult = result; });

                context.executeAction("rideentranceexitplace", {
                    x: toWorld(access.exit.x), y: toWorld(access.exit.y),
                    direction: access.exit.direction, ride: created, station: 0, isExit: true
                }, function (result) { exitResult = result; });
            }

            context.setTimeout(function () {
                if (access) {
                    const station = map.getRide(created).stations[0];
                    const entranceOn = !!(station && station.entrance);
                    const exitOn = !!(station && station.exit);

                    if (!entranceOn || !exitOn) {
                        const doors = access as { entrance: { x: number; y: number }; exit: { x: number; y: number } };
                        const why = function (result: GameActionResult | undefined, tile: { x: number; y: number }): string {
                            return actionError(result)
                                || "the game accepted the action but no building stands at "
                                    + String(tile.x) + "," + String(tile.y);
                        };
                        const failures: string[] = [];

                        if (!entranceOn) {
                            failures.push("The entrance at " + String(doors.entrance.x) + "," + String(doors.entrance.y)
                                + " did not attach: " + why(entranceResult, doors.entrance));
                        }

                        if (!exitOn) {
                            failures.push("The exit at " + String(doors.exit.x) + "," + String(doors.exit.y)
                                + " did not attach: " + why(exitResult, doors.exit));
                        }

                        if (entranceOn) {
                            failures.push("The entrance did attach");
                        }

                        if (exitOn) {
                            failures.push("The exit did attach");
                        }

                        // Both ways out fire an action a paused game refuses -
                        // rideentranceexitplace and ridedemolish - so offering them without
                        // saying so hands the model two remedies that cannot work.
                        const pausedNow = gamePaused();

                        // The ride is standing. Saying only "failed" here is what produced two
                        // half-built burger bars: the model read it as "nothing happened" and
                        // built a second one.
                        steps.push({
                            step: "entrance/exit",
                            ok: false,
                            detail: failures.join(". ") + ". Ride " + String(created) + " EXISTS with its track on"
                                + " the ground, so calling build_flat_ride again builds a second one. Two ways out:"
                                + " place the missing " + (entranceOn || exitOn ? "door" : "doors")
                                + " with evaluate, using a rideentranceexitplace action on"
                                + " ride " + String(created) + "; or remove this ride with operate_ride {ride: "
                                + String(created) + ", demolish: true} and build it again on a site from a fresh"
                                + " find_build_sites."
                                + (pausedNow
                                    ? " The game is paused, and rideentranceexitplace and ridedemolish are both"
                                        + " actions a paused game refuses, so neither of those two ways out goes"
                                        + " through until the clock is running. " + UNPAUSE_CALL
                                    : "")
                        });

                        return finish({
                            ok: true,
                            rideId: created,
                            rideName: map.getRide(created).name,
                            doorsAttached: false,
                            open: false,
                            reachable: false
                        }) as unknown as void;
                    }

                    steps.push({
                        step: "entrance/exit",
                        ok: true,
                        detail: "entrance " + String(access.entrance.x) + "," + String(access.entrance.y)
                            + " exit " + String(access.exit.x) + "," + String(access.exit.y)
                    });
                } else {
                    const counter = shopServingTile(request.x, request.y, request.rotation);
                    const overTheCounter = "A stall has no entrance and no exit: guests buy over the counter from "
                        + String(counter.x) + "," + String(counter.y) + ", the one tile it faces.";

                    // Passed five times in one session to a burger bar. Ignoring them silently
                    // taught the model nothing, so it kept sending them.
                    steps.push({
                        step: "entrance/exit",
                        ok: true,
                        detail: (request.entrance || request.exit)
                            ? overTheCounter + " entranceX/entranceY and exitX/exitY were ignored - "
                                + rideObject.name + " has nowhere to put them, which is why find_build_sites"
                                + " returns no `access` list for a stall."
                            : overTheCounter
                    });
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
                                + "."
                        });
                    } else {
                        // One tile, not four: the game serves a stall from the neighbour on
                        // the side it faces. Accepting any of the four called a stall with a
                        // path against its back wall reachable, which is a false "it works".
                        const counter = shopServingTile(request.x, request.y, request.rotation);
                        const served = tileIsWalkable(nowWalkable, counter);

                        reachable = served;
                        steps.push({
                            step: "access",
                            ok: served,
                            detail: served
                                ? "Guests buy from " + String(counter.x) + "," + String(counter.y)
                                    + ", which they can reach."
                                : "NO PATH guests can reach at " + String(counter.x) + "," + String(counter.y) + ", so"
                                    + " nobody can buy from this stall. That one tile is the counter: a stall is served"
                                    + " only from the neighbour on the side it faces, which at rotation "
                                    + String(request.rotation) + " is " + String(counter.x) + "," + String(counter.y)
                                    + ". A path on any of its other three sides touches a wall and serves nobody."
                                    + " The tiles guests can walk to are the ones park_status covers with"
                                    + " `paths.runs`."
                        });
                    }

                    context.executeAction("ridesetprice", { ride: created, price: request.price, isPrimaryPrice: true }, function () { /* verified by re-read */ });

                    let statusResult: GameActionResult | undefined;

                    if (request.open) {
                        context.executeAction("ridesetstatus", { ride: created, status: 1 }, function (result) {
                            statusResult = result;
                        });
                    }

                    context.setTimeout(function () {
                        const ride = map.getRide(created);
                        const opened = ride.status === "open";
                        const actualPrice = ride.price.length > 0 ? ride.price[0] : 0;

                        steps.push({
                            step: "price",
                            ok: actualPrice === request.price,
                            // No cause named: `ridesetprice` consults no park flag, so nothing readable explains this.
                            detail: actualPrice === request.price
                                ? "charging " + String(actualPrice)
                                : "asked for " + String(request.price) + " but the ride is charging "
                                    + String(actualPrice) + "."
                        });

                        if (request.open && !opened) {
                            // Built and shut is not built and gone. Opening is a separate action
                            // with its own tool, so it gets its own verdict rather than sinking `ok`.
                            steps.push({
                                step: "open",
                                ok: false,
                                detail: "Ride " + String(created) + " was built but is still " + ride.status + ": "
                                    + (actionError(statusResult) || "the game refused to open it")
                                    + ". The ride EXISTS - do not build it again. Open it with operate_ride {ride: "
                                    + String(created) + ", open: true} once whatever it is waiting on is in place."
                            });

                            return finish({
                                ok: true,
                                rideId: created,
                                rideName: ride.name,
                                doorsAttached: access ? true : null,
                                open: false,
                                reachable: reachable
                            }) as unknown as void;
                        }

                        steps.push({ step: "open", ok: true, detail: ride.status });
                        // `ok` is whether the ride got built. Whether guests can use it is
                        // `reachable`, and is a separate job - this tool lays no paths, so
                        // reporting a correct build as a failure makes the model build it twice.
                        finish({
                            ok: true,
                            rideId: created,
                            rideName: ride.name,
                            doorsAttached: access ? true : null,
                            open: opened,
                            reachable: reachable
                        });
                    }, STEP_DELAY_MS);
                }, STEP_DELAY_MS);
            }, STEP_DELAY_MS);
        }, STEP_DELAY_MS);
    }, STEP_DELAY_MS);
}
