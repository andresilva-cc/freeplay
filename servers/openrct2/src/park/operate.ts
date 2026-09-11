import { flatRideShape } from "./flatRides.js";

const STEP_DELAY_MS = 200;

/**
 * `RideSetSetting::InspectionInterval` in the game's own enum. The action takes a setting
 * index and a value, so the wrong index changes a different setting and still answers
 * `error: 0`; only the read-back below can tell the two apart.
 */
const SETTING_INSPECTION_INTERVAL = 5;

/** What each inspection interval index means. The game stores the index, not the minutes. */
const INSPECTION_INTERVAL_NAMES = [
    "every 10 minutes", "every 20 minutes", "every 30 minutes", "every 45 minutes",
    "every hour", "every 2 hours", "never"
];

export interface OperateRideRequest {
    ride: number;
    open?: boolean;
    price?: number;
    inspectionInterval?: number;
    demolish?: boolean;
}

export interface OperateRideOutcome {
    ok: boolean;
    ride: number;
    name?: string;
    status?: string;
    price?: number;
    inspectionInterval?: number;
    detail: string;
}

function describeInterval(value: number): string {
    const name = INSPECTION_INTERVAL_NAMES[value];

    return typeof name === "string" ? String(value) + " (" + name + ")" : String(value);
}

/**
 * Open, close, reprice, reschedule inspections for, or remove a ride that already exists.
 * Each of these is a single game action, but the argument shapes are undiscoverable: a run
 * once spent ten calls inventing `ride.open = true` and `queryAction("set_ride_status")`,
 * neither of which exists, and queryAction answers an unknown action name with a cheerful
 * null.
 *
 * Every branch reports the ride as it reads a tick later, never as it was asked for. An
 * action the game accepts and then refuses is the normal case here, not the exception.
 */
export function operateRide(request: OperateRideRequest, done: (outcome: OperateRideOutcome) => void): void {
    const ride = map.getRide(request.ride);

    if (!ride) {
        return done({ ok: false, ride: request.ride, detail: "There is no ride with id " + String(request.ride) + "." });
    }

    const name = ride.name;

    if (request.demolish === true) {
        context.executeAction("ridedemolish", { ride: request.ride, modifyType: 0 }, function () { /* verified by re-read */ });

        return context.setTimeout(function () {
            const gone = !map.getRide(request.ride);
            done({
                ok: gone,
                ride: request.ride,
                name: name,
                detail: gone ? "Demolished " + name + "." : "Could not demolish " + name + "."
            });
        }, STEP_DELAY_MS) as unknown as void;
    }

    if (typeof request.price === "number") {
        context.executeAction("ridesetprice", {
            ride: request.ride, price: request.price, isPrimaryPrice: true
        }, function () { /* verified by re-read */ });
    }

    if (typeof request.open === "boolean") {
        context.executeAction("ridesetstatus", {
            ride: request.ride, status: request.open ? 1 : 0
        }, function () { /* verified by re-read */ });
    }

    if (typeof request.inspectionInterval === "number") {
        context.executeAction("ridesetsetting", {
            ride: request.ride, setting: SETTING_INSPECTION_INTERVAL, value: request.inspectionInterval
        }, function () { /* verified by re-read */ });
    }

    context.setTimeout(function () {
        const after = map.getRide(request.ride);

        if (!after) {
            return done({ ok: false, ride: request.ride, name: name, detail: "The ride disappeared." });
        }

        const price = after.price.length > 0 ? after.price[0] : 0;
        const interval = after.inspectionInterval;
        const priceOk = typeof request.price !== "number" || price === request.price;
        const statusOk = typeof request.open !== "boolean"
            || (request.open ? after.status === "open" : after.status !== "open");
        const intervalOk = typeof request.inspectionInterval !== "number"
            || interval === request.inspectionInterval;

        const notes: string[] = [];

        if (!priceOk) {
            // No cause named: `ridesetprice` consults no park flag, so nothing readable explains this.
            notes.push("asked for price " + String(request.price) + " but it is charging " + String(price));
        }

        if (!statusOk) {
            // Only name a cause that is actually present. Appending "it needs an entrance
            // and an exit" to every refusal is a guess dressed as an explanation, and the
            // model acts on it.
            const station = after.stations.length > 0 ? after.stations[0] : undefined;
            const unbuilt = !station || !station.start;
            const shape = flatRideShape(after.type);
            const needsDoors = typeof shape === "undefined" || !shape.isShop;
            const missingDoors = needsDoors && (!station || !station.entrance || !station.exit);

            let because = "";

            if (request.open && unbuilt) {
                because = "; nothing has been built on the ground yet";
            } else if (request.open && missingDoors) {
                because = "; it has no entrance or exit yet";
            }

            notes.push("it is " + after.status + " rather than " + (request.open ? "open" : "closed") + because);
        }

        if (!intervalOk) {
            notes.push("asked for inspection interval " + describeInterval(request.inspectionInterval as number)
                + " but it is set to "
                + (typeof interval === "number" ? describeInterval(interval) : "something the game did not report"));
        }

        const settled = after.name + " is " + after.status + " at price " + String(price)
            + (typeof request.inspectionInterval === "number" && typeof interval === "number"
                ? ", inspected " + String(INSPECTION_INTERVAL_NAMES[interval] || interval)
                : "")
            + ".";

        done({
            ok: priceOk && statusOk && intervalOk,
            ride: request.ride,
            name: after.name,
            status: after.status,
            price: price,
            inspectionInterval: typeof interval === "number" ? interval : undefined,
            detail: notes.length === 0 ? settled : notes.join("; ") + "."
        });
    }, STEP_DELAY_MS);
}
