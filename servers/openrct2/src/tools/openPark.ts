import { mcpTool, mcpToolController } from "./decorators.js";
import type { DeferredMcpResult } from "./types.js";

/** Long enough for a queued game action to have been applied on a later tick. */
const STEP_DELAY_MS = 200;

/**
 * Admission is in tenths, like a ride ticket, and the same ceiling as `operate_ride`'s
 * `price` catches a currency unit sent as if it were tenths. The MCP layer enforces the
 * schema bound before the tool is reached; this is here for a direct call.
 */
const MAX_ENTRANCE_FEE = 2000;

export interface OpenParkRequest {
    open?: boolean;
    entranceFee?: number;
}

export interface OpenParkOutcome {
    ok: boolean;
    parkOpen: boolean;
    entranceFee: number;
    detail: string;
}

/** What the park reads back as, and whether that matches what was asked for. */
interface ParkReview {
    parkOpen: boolean;
    entranceFee: number;
    openOk: boolean;
    feeOk: boolean;
}

function review(request: OpenParkRequest): ParkReview {
    const parkOpen = park.getFlag("open");
    const entranceFee = park.entranceFee;

    return {
        parkOpen: parkOpen,
        entranceFee: entranceFee,
        openOk: typeof request.open !== "boolean" || parkOpen === request.open,
        feeOk: typeof request.entranceFee !== "number" || entranceFee === request.entranceFee
    };
}

function describe(request: OpenParkRequest, state: ParkReview): OpenParkOutcome {
    const notes: string[] = [];

    if (!state.openOk) {
        notes.push("asked to " + (request.open === true ? "open" : "close") + " the park but it is still "
            + (state.parkOpen ? "open" : "closed"));
    }

    if (!state.feeOk) {
        // Only name a cause that is actually present. A guessed explanation appended to
        // every refusal reads as a fact and gets acted on.
        let because = "";

        if (park.getFlag("freeParkEntry")) {
            because = "; this scenario has free park entry, so guests pay for rides instead";
        } else if (park.getFlag("noMoney")) {
            because = "; this scenario has money turned off";
        }

        notes.push("asked for an entrance fee of " + String(request.entranceFee)
            + " but the park charges " + String(state.entranceFee) + because);
    }

    return {
        ok: state.openOk && state.feeOk,
        parkOpen: state.parkOpen,
        entranceFee: state.entranceFee,
        detail: notes.length === 0
            ? "The park is " + (state.parkOpen ? "open" : "closed")
                + " and the entrance fee is " + String(state.entranceFee) + "."
            : notes.join("; ") + "."
    };
}

function isWholeFeeInRange(value: number): boolean {
    return Math.floor(value) === value && value >= 0 && value <= MAX_ENTRANCE_FEE;
}

/**
 * Open or close the park, and set what it charges to get in.
 *
 * Both are single game actions with undiscoverable argument shapes - `parksetparameter`
 * takes 0 for close and 1 for open, and neither name resembles what it does - so five of
 * five playable runs hand-wrote `park.setFlag("open", true)` through `evaluate` instead.
 * Nothing here decides when to open the park or what to charge; it carries out whichever
 * of the two was asked for and reports what the park reads back as afterwards.
 */
export function openPark(request: OpenParkRequest, done: (outcome: OpenParkOutcome) => void): void {
    const wantsOpen = typeof request.open === "boolean";
    const wantsFee = typeof request.entranceFee === "number";

    if (!wantsOpen && !wantsFee) {
        const state = review(request);

        return done({
            ok: false,
            parkOpen: state.parkOpen,
            entranceFee: state.entranceFee,
            detail: "Nothing to do: pass open, entranceFee, or both. Nothing was changed."
        });
    }

    if (wantsFee && !isWholeFeeInRange(request.entranceFee as number)) {
        const state = review({});

        return done({
            ok: false,
            parkOpen: state.parkOpen,
            entranceFee: state.entranceFee,
            detail: "`entranceFee` must be a whole number between 0 and " + String(MAX_ENTRANCE_FEE)
                + ", in tenths of a currency unit (10 means 1.00); " + String(request.entranceFee)
                + " is outside that range. Nothing was changed."
        });
    }

    if (wantsFee) {
        context.executeAction("parksetentrancefee", {
            value: request.entranceFee as number
        }, function () { /* verified by re-read */ });
    }

    if (wantsOpen) {
        context.executeAction("parksetparameter", {
            parameter: request.open === true ? 1 : 0, value: 0
        }, function () { /* verified by re-read */ });
    }

    context.setTimeout(function () {
        const first = review(request);

        if (first.openOk && first.feeOk) {
            return done(describe(request, first));
        }

        // One bounded retry through the plugin API's own setters, which is the route every
        // run took by hand and is known to work. Not a loop: if this does not take either,
        // the second read is reported as it stands.
        if (!first.openOk && wantsOpen) {
            park.setFlag("open", request.open === true);
        }

        if (!first.feeOk && wantsFee) {
            park.entranceFee = request.entranceFee as number;
        }

        context.setTimeout(function () {
            done(describe(request, review(request)));
        }, STEP_DELAY_MS);
    }, STEP_DELAY_MS);
}

@mcpToolController
export class OpenParkTools {
    @mcpTool({
        name: "Open or close the park",
        description: [
            "Open the park to guests, close it again, or set the entrance fee.",
            "Guests only arrive while the park is open; `park_status` reports `parkOpen` and `entranceFee`.",
            "Pass `open` to open or close it, `entranceFee` to change the price of admission, or both in one call.",
            "Neither happens on its own: nothing else in this bridge opens the park or changes the fee.",
            "The result reports what the park reads back as afterwards, which is not always what you asked:",
            "some scenarios let guests in free and charge for rides instead."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                open: {
                    type: "boolean",
                    description: "true to open the park to guests, false to close it. Omit to leave it as it is."
                },
                entranceFee: {
                    type: "integer",
                    minimum: 0,
                    maximum: MAX_ENTRANCE_FEE,
                    description: "Admission price in tenths: 10 means 1.00, 0 means free. Omit to leave it as it is."
                }
            },
            additionalProperties: false
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
        }
    })
    public openPark(args: Record<string, unknown>): DeferredMcpResult {
        const request: OpenParkRequest = {
            open: typeof args.open === "boolean" ? args.open : undefined,
            entranceFee: typeof args.entranceFee === "number" ? Math.floor(args.entranceFee) : undefined
        };

        return {
            deferred: true,
            start: function (resolve) {
                openPark(request, resolve);
            }
        };
    }
}
