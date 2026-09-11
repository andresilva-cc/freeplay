import { getGameDateInfo } from "../gameDate.js";
import { httpGet, httpPath } from "./decorators.js";
import { HttpController } from "./types.js";

@httpPath("/v1/date")
export class DateController extends HttpController {
    @httpGet("/", {
        operationId: "getDate",
        summary: "Get the current in-game date",
        description: "Returns the current OpenRCT2 date values from the running game.",
        responseDescription: "Current game date values"
    })
    public getDate() {
        return getGameDateInfo();
    }
}
