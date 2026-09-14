import { mcpTool, mcpToolController } from "./decorators.js";
import { recordPlayerPause } from "../clockGate.js";
import type { DeferredMcpResult } from "./types.js";

/** Long enough for a queued game action to have been applied on a later tick. */
const STEP_DELAY_MS = 200;

/**
 * OpenRCT2's own range. `GameSetSpeedAction::IsValidSpeed` accepts 1 to 4, and 5 to 8 only
 * when the game was started with debugging tools on, which is not something a plugin can
 * turn on or read. The MCP layer enforces the enum before the tool is reached; this is
 * here for a direct call.
 */
const MIN_SPEED = 1;
const MAX_SPEED = 4;

/**
 * What each setting does, from the game's own loop: it runs `1 << (speed - 1)` updates
 * per frame. The numbers are not multipliers, which is the whole trap - asking for 8
 * meaning eight times normal is out of range, and 4 is what eight times is called.
 */
const SPEED_NAMES: Record<number, string> = {
    1: "normal",
    2: "twice normal",
    3: "four times normal",
    4: "eight times normal"
};

const SPEED_HELP = "1 is normal, 2 runs the simulation twice as fast, 3 four times, 4 eight times";

export interface GameSpeedRequest {
    speed?: number;
    paused?: boolean;
}

export interface GameSpeedOutcome {
    ok: boolean;
    /** The speed the game reads back as, not the speed that was asked for. */
    speed: number;
    paused: boolean;
    detail: string;
}

/** What the game reads back as, and whether that matches what was asked for. */
interface SpeedReview {
    speed: number;
    paused: boolean;
    speedOk: boolean;
    pausedOk: boolean;
}

function currentSpeed(): number {
    return typeof context.gameSpeed === "number" ? context.gameSpeed : 0;
}

function currentlyPaused(): boolean {
    return context.paused === true;
}

function review(request: GameSpeedRequest): SpeedReview {
    const speed = currentSpeed();
    const paused = currentlyPaused();

    return {
        speed: speed,
        paused: paused,
        speedOk: typeof request.speed !== "number" || speed === request.speed,
        pausedOk: typeof request.paused !== "boolean" || paused === request.paused
    };
}

function describeSpeed(speed: number): string {
    const name = SPEED_NAMES[speed];

    return typeof name === "string" ? String(speed) + " (" + name + ")" : String(speed);
}

function describe(request: GameSpeedRequest, state: SpeedReview): GameSpeedOutcome {
    const notes: string[] = [];

    if (!state.speedOk) {
        // No cause named: `gamesetspeed` consults nothing a plugin can read, so anything
        // added here would be a guess, and a guess in a result gets acted on as a fact.
        notes.push("asked for speed " + String(request.speed) + " but the game is running at "
            + describeSpeed(state.speed));
    }

    if (!state.pausedOk) {
        notes.push("asked to " + (request.paused === true ? "pause" : "unpause")
            + " but the game is " + (state.paused ? "paused" : "running"));
    }

    return {
        ok: state.speedOk && state.pausedOk,
        speed: state.speed,
        paused: state.paused,
        detail: notes.length === 0
            ? (state.paused
                ? "The game is paused, so no scenario time passes until it is unpaused, and it"
                    + " refuses the map changes listed on `paused`. Its speed setting is "
                    + describeSpeed(state.speed) + ", which is what a game day costs in real"
                    + " seconds inside a wait."
                : "The game is running at speed " + describeSpeed(state.speed) + ". The bridge"
                    + " holds it still again the moment this call answers; what unpausing changed is"
                    + " that map changes and wait are no longer refused.")
            : notes.join("; ") + "."
    };
}

function isWholeSpeedInRange(value: number): boolean {
    return Math.floor(value) === value && value >= MIN_SPEED && value <= MAX_SPEED;
}

/**
 * Set how fast the simulation runs, and pause or unpause it.
 *
 * The scenario clock runs while the model decides what to do, so thinking time is charged
 * against the scenario the same way playing time is. Both levers are ordinary game actions
 * with undiscoverable shapes: `gamesetspeed` takes an index that looks like a multiplier
 * and is not, and `pausetoggle` flips rather than sets, so asking for "paused" twice
 * unpauses unless something reads the state first. Nothing here decides when to use either.
 */
export function setGameSpeed(request: GameSpeedRequest, done: (outcome: GameSpeedOutcome) => void): void {
    const wantsSpeed = typeof request.speed === "number";
    const wantsPause = typeof request.paused === "boolean";

    if (!wantsSpeed && !wantsPause) {
        const state = review({});

        return done({
            ok: false,
            speed: state.speed,
            paused: state.paused,
            detail: "Nothing to do: pass speed, paused, or both. Nothing was changed."
        });
    }

    if (wantsSpeed && !isWholeSpeedInRange(request.speed as number)) {
        const state = review({});

        return done({
            ok: false,
            speed: state.speed,
            paused: state.paused,
            detail: "`speed` must be a whole number between " + String(MIN_SPEED) + " and " + String(MAX_SPEED)
                + " - it is the game's speed setting and not a multiplier, so " + SPEED_HELP + "; "
                + String(request.speed) + " is outside that range. Nothing was changed."
        });
    }

    if (wantsSpeed) {
        context.executeAction("gamesetspeed", {
            speed: request.speed as number
        }, function () { /* verified by re-read */ });
    }

    if (wantsPause) {
        // Told before the action goes out, because the action goes through the clock gate and
        // the gate has to know whose pause this is: a pause the model asked for stays in force
        // across the calls that follow, and the game refuses through it as it always did.
        recordPlayerPause(request.paused === true);
    }

    // `pausetoggle` flips the flag, so firing it when the game is already in the state
    // that was asked for would put it into the other one.
    if (wantsPause && currentlyPaused() !== request.paused) {
        context.executeAction("pausetoggle", {}, function () { /* verified by re-read */ });
    }

    context.setTimeout(function () {
        const first = review(request);

        if (first.speedOk && first.pausedOk) {
            return done(describe(request, first));
        }

        // One bounded retry through the plugin API's own setter, which takes effect at once
        // rather than on a tick. Not a loop: if this does not take either, the second read
        // is reported as it stands. Speed has no setter, so only pause can be retried.
        if (!first.pausedOk && wantsPause) {
            context.paused = request.paused === true;
        }

        context.setTimeout(function () {
            done(describe(request, review(request)));
        }, STEP_DELAY_MS);
    }, STEP_DELAY_MS);
}

@mcpToolController
export class GameSpeedTools {
    @mcpTool({
        name: "Set the game speed",
        description: [
            "Set how fast the simulation runs, and pause or unpause it. Pass either or both in one call.",
            "The scenario clock does not run between your calls: the bridge holds the game still until",
            "`wait` is called, so deciding costs the scenario nothing and `speed` changes no outcome.",
            "What `speed` changes is how much REAL time a `wait` takes, and so how many game days one",
            "`wait` call can reach inside its twenty real seconds: about 1.5 at speed 1 and 12 at speed 4."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                speed: {
                    type: "integer",
                    enum: [1, 2, 3, 4],
                    minimum: MIN_SPEED,
                    maximum: MAX_SPEED,
                    description: "The game's speed setting: " + SPEED_HELP
                        + ". These are settings, not multipliers, so eight times normal is 4 and there is no 8."
                        + " It sets the real seconds a game day costs inside `wait` - about 13 at speed 1 and"
                        + " 1.7 at speed 4 - and nothing else: the game days a run spends are whatever `wait`"
                        + " is asked for, at any speed."
                        + " `speed` in the result is the setting in effect afterwards, not the one you asked for."
                        + " Omit to leave the speed as it is."
                },
                paused: {
                    type: "boolean",
                    description: "true to pause the simulation, false to let it run. The bridge already holds"
                        + " the game still between calls, so this buys no thinking time; what it changes is that"
                        + " the game refuses map changes through a pause you asked for, and `wait` refuses too"
                        + " until you unpause. While paused no scenario"
                        + " time passes at all, and the game refuses every action that changes the map, with"
                        + " \"Construction not possible while game is paused!\". build_path, remove_path,"
                        + " buy_land, clear_scenery and operate_ride demolish each fire such an action and"
                        + " report that refusal in their own result; build_flat_ride refuses the whole call"
                        + " while the game is paused, and builds and charges nothing. Settings do go through:"
                        + " operate_ride opening, closing, pricing and inspection intervals, hire_staff,"
                        + " open_park and this tool itself, and reading is never affected. A ride opened while"
                        + " paused is open, but takes its first guest only once the clock runs again."
                        + " Omit to leave it as it is."
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
    public setGameSpeed(args: Record<string, unknown>): DeferredMcpResult {
        const request: GameSpeedRequest = {
            speed: typeof args.speed === "number" ? Math.floor(args.speed) : undefined,
            paused: typeof args.paused === "boolean" ? args.paused : undefined
        };

        return {
            deferred: true,
            start: function (resolve) {
                setGameSpeed(request, resolve);
            }
        };
    }
}
