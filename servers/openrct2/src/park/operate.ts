import { flatRideShape } from "./flatRides.js";

const STEP_DELAY_MS = 200;

export interface OperateRideRequest {
    ride: number;
    open?: boolean;
    price?: number;
    demolish?: boolean;
}

export interface OperateRideOutcome {
    ok: boolean;
    ride: number;
    name?: string;
    status?: string;
    price?: number;
    detail: string;
}

/**
 * Open, close, reprice or remove a ride that already exists. Each of these is a single
 * game action, but the argument shapes are undiscoverable: a run once spent ten calls
 * inventing `ride.open = true` and `queryAction("set_ride_status")`, neither of which
 * exists, and queryAction answers an unknown action name with a cheerful null.
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

    context.setTimeout(function () {
        const after = map.getRide(request.ride);

        if (!after) {
            return done({ ok: false, ride: request.ride, name: name, detail: "The ride disappeared." });
        }

        const price = after.price.length > 0 ? after.price[0] : 0;
        const priceOk = typeof request.price !== "number" || price === request.price;
        const statusOk = typeof request.open !== "boolean"
            || (request.open ? after.status === "open" : after.status !== "open");

        const notes: string[] = [];

        if (!priceOk) {
            notes.push("asked for price " + String(request.price) + " but it is charging " + String(price)
                + "; the scenario may fix ride prices");
        }

        if (!statusOk) {
            const shape = flatRideShape(after.type);
            notes.push("it is " + after.status + " rather than " + (request.open ? "open" : "closed")
                + (request.open && typeof shape !== "undefined"
                    ? "; a ride will not open until it is built and has an entrance and an exit"
                    : ""));
        }

        done({
            ok: priceOk && statusOk,
            ride: request.ride,
            name: after.name,
            status: after.status,
            price: price,
            detail: notes.length === 0
                ? after.name + " is " + after.status + " at price " + String(price) + "."
                : notes.join("; ") + "."
        });
    }, STEP_DELAY_MS);
}
