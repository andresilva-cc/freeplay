import { httpGet, httpPath } from "./decorators.js";
import { HttpController, type ControllerContext } from "./types.js";

@httpPath("/v1/rides")
export class RidesController extends HttpController {
    @httpGet("/", {
        operationId: "listRides",
        summary: "List rides",
        description: "Returns the available rides in the current park.",
        responseDescription: "Ride list"
    })
    public getAll() {
        const results = [];
        const rides = map.rides;
        for (let i = 0; i < rides.length; i++) {
            const r = map.getRide(i);
            if (!r) continue;

            results.push({
                object: r.object.identifier,
                id: r.id,
                type: r.type,
                classification: r.classification,
                name: r.name,
                status: r.status,
                price: r.price
            });
        }
        return results;
    }

    @httpGet("/:id", {
        operationId: "getRide",
        summary: "Get a ride",
        description: "Returns a single ride by id.",
        responseDescription: "Ride details"
    })
    public get({ params, response }: ControllerContext) {
        const rides = map.rides;
        const rideId = params.id;

        for (let i = 0; i < rides.length; i++) {
            const r = map.getRide(i);
            if (!r) continue;

            if (String(r.id) !== rideId) {
                continue;
            }

            return {
                object: r.object.identifier,
                id: r.id,
                type: r.type,
                classification: r.classification,
                name: r.name,
                status: r.status,
                price: r.price
            };
        }

        response.statusCode = 404;
        return {
            error: "Ride not found"
        };
    }
}
