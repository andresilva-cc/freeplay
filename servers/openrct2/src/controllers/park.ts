import { getParkInfo } from "../parkInfo.js";
import { httpGet, httpPath } from "./decorators.js";
import { HttpController } from "./types.js";

@httpPath("/v1/park")
export class ParkController extends HttpController {
    @httpGet("/", {
        operationId: "getParkInfo",
        summary: "Get the current park information",
        description: "Returns key OpenRCT2 park information from the running game.",
        responseDescription: "Current park information"
    })
    public getParkInfo() {
        return getParkInfo();
    }
}
