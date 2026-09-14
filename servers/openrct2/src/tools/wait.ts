import { mcpTool, mcpToolController } from "./decorators.js";
import { gameDaysBetween, readGameDayPosition } from "../gameClock.js";
import type { DateReading } from "../gameClock.js";
import {
    closeClockWindow,
    openClockWindow,
    playerPausedTheGame,
    readGameTicks
} from "../clockGate.js";
import type { DeferredMcpResult } from "./types.js";

/**
 * The clock is read once a frame, which is what OpenRCT2's 40Hz loop leaves to read. A wait
 * therefore overshoots by at most one frame - `1 << (speed - 1)` ticks - and reports the
 * days it actually got rather than the days it was asked for.
 */
const SLICE_MS = 25;

const MIN_DAYS = 0.1;

/**
 * Twelve game days is what the twenty real seconds below buy at speed 4, so it is the most
 * one call can deliver at any speed. Asking for more could never be honoured; asking for
 * this at a slower speed is honoured as far as the seconds reach, and the result says so.
 */
const MAX_DAYS = 12;

/**
 * src/mcp.ts answers a deferred call that has not finished within `DEFERRED_TIMEOUT_MS`
 * - 30 seconds - with a timeout error, and `.mcp.json` gives the client 60. A tool whose
 * whole job is to take time has to stop well inside the shorter of the two, or it reports
 * a failure for a wait that worked. 20 leaves ten seconds of headroom for the last slice to
 * land and the park to be read back.
 */
const REAL_BUDGET_MS = 20000;

/** The same dozen `park_status` reports, so a long wait does not out-cost a park report. */
const MESSAGE_LIMIT = 12;

/** Real seconds a game day costs at each speed setting: 40 ticks a second, doubling. */
const SECONDS_PER_DAY_AT_SPEED: Record<number, string> = {
    1: "13",
    2: "7",
    3: "3.3",
    4: "1.7"
};

export interface WaitRequest {
    days?: number;
}

export interface WaitOutcome {
    /** True once game time has actually been let run. False means nothing was waited. */
    ok: boolean;
    /** Game days asked for. */
    daysRequested: number;
    /** Game days the clock actually moved, which is the number the scenario is spent in. */
    days: number;
    /** The same span in the game's own ticks, which is the exact figure `days` rounds. */
    ticks: number;
    /** False when the real-time budget ran out first: the rest is a second call away. */
    complete: boolean;
    /** Real seconds this took, which is the cost of the wait and not its measure. */
    seconds: number;
    /** The game's speed setting, which decides how much real time the game days cost. */
    speed: number;
    from: DateReading;
    to: DateReading;
    guests: number;
    guestsChange: number;
    cash: number;
    cashChange: number;
    rating: number;
    ratingChange: number;
    /** How many park messages arrived while the game ran, before `newMessages` is trimmed. */
    newMessageCount: number;
    newMessages: string[];
    detail: string;
}

interface Snapshot {
    date: DateReading;
    position: number;
    ticks: number;
    guests: number;
    cash: number;
    rating: number;
    messages: string[];
}

/**
 * `gamesetspeed` and `pausetoggle` both carry `Flags::AllowWhilePaused`, so this is a call
 * a paused game does not refuse. Named for the same reason `build_flat_ride` names it: a
 * refusal that does not carry the call that fixes it costs a turn.
 */
const UNPAUSE_CALL = "set_game_speed is not one of the calls a paused game refuses, so"
    + " set_game_speed {paused: false} goes through and starts the clock.";

function currentSpeed(): number {
    return typeof context.gameSpeed === "number" ? context.gameSpeed : 0;
}

function currentlyPaused(): boolean {
    return context.paused === true;
}

function readMessages(): string[] {
    const all = park.messages;
    const out: string[] = [];

    for (let i = 0; i < all.length; i++) {
        // Messages carry colour and layout codes like {RED} and {NEWLINE}: noise to a reader.
        out.push(all[i].text.replace(/\{[A-Z_]+\}/g, " ").replace(/\s+/g, " ").trim());
    }

    return out;
}

function snapshot(): Snapshot {
    const position = readGameDayPosition();
    const ticks = readGameTicks();

    return {
        date: { year: date.year, month: date.month, day: date.day },
        position: typeof position === "number" ? position : 0,
        ticks: typeof ticks === "number" ? ticks : 0,
        guests: park.guests,
        cash: park.cash,
        rating: park.rating,
        messages: readMessages()
    };
}

function dateText(reading: DateReading): string {
    return "year " + String(reading.year) + ", month " + String(reading.month)
        + ", day " + String(reading.day);
}

/**
 * The messages that arrived while the game ran.
 *
 * The game's news queue is bounded and drops from the front, so a length difference
 * under-reports once it is full - which is the point in a scenario where messages matter
 * most. The new ones are whatever is left over after the longest run of `before`'s own
 * tail has been matched against the front of `after`.
 */
function messagesSince(before: string[], after: string[]): string[] {
    const most = before.length < after.length ? before.length : after.length;

    for (let kept = most; kept > 0; kept--) {
        let same = true;

        for (let i = 0; i < kept; i++) {
            if (before[before.length - kept + i] !== after[i]) {
                same = false;
                break;
            }
        }

        if (same) {
            return after.slice(kept);
        }
    }

    return after.slice(0);
}

function roundDays(value: number): number {
    return Math.round(value * 10) / 10;
}

function nothingWaited(asked: number, detail: string): WaitOutcome {
    const now = snapshot();

    return {
        ok: false,
        daysRequested: asked,
        days: 0,
        ticks: 0,
        complete: false,
        seconds: 0,
        speed: currentSpeed(),
        from: now.date,
        to: now.date,
        guests: now.guests,
        guestsChange: 0,
        cash: now.cash,
        cashChange: 0,
        rating: now.rating,
        ratingChange: 0,
        newMessageCount: 0,
        newMessages: [],
        detail: detail
    };
}

function describe(asked: number, milliseconds: number, before: Snapshot, complete: boolean): WaitOutcome {
    const after = snapshot();
    const fresh = messagesSince(before.messages, after.messages);
    const days = gameDaysBetween(before.position, after.position);
    const ticks = after.ticks > before.ticks ? after.ticks - before.ticks : 0;
    const seconds = Math.round(milliseconds / 100) / 10;
    const speed = currentSpeed();

    return {
        ok: ticks > 0,
        daysRequested: asked,
        days: days,
        ticks: ticks,
        complete: complete,
        seconds: seconds,
        speed: speed,
        from: before.date,
        to: after.date,
        guests: after.guests,
        guestsChange: after.guests - before.guests,
        cash: after.cash,
        cashChange: after.cash - before.cash,
        rating: after.rating,
        ratingChange: after.rating - before.rating,
        newMessageCount: fresh.length,
        newMessages: fresh.slice(fresh.length > MESSAGE_LIMIT ? fresh.length - MESSAGE_LIMIT : 0),
        detail: "The game ran for " + String(days) + " game days, from " + dateText(before.date)
            + " to " + dateText(after.date) + ", which took " + String(seconds)
            + " real seconds at speed " + String(speed) + "."
            + (complete
                ? ""
                : " The remaining " + String(roundDays(asked - days)) + " days did not fit in the"
                    + " twenty real seconds this call has: at speed " + String(speed) + " a game day"
                    + " costs about " + (SECONDS_PER_DAY_AT_SPEED[speed] || "13") + " real seconds."
                    + " Call wait again, or raise the speed with set_game_speed first.")
            + (ticks === 0
                ? " The clock did not move at all, so something outside this bridge is holding"
                    + " the game: check `paused` in park_status."
                : "")
    };
}

/**
 * Advance the scenario clock by an amount of GAME time, then report what moved while it ran.
 *
 * The argument used to be real seconds, which made the scenario time a call bought depend on
 * the game's speed setting and on how fast the machine was: the same run on a faster host
 * was a different game. It is game days now, and the real seconds are the cost rather than
 * the measure - reported, capped, and nothing the result is denominated in.
 *
 * This is also the only thing that spends scenario time. The bridge holds the game paused
 * between tool calls, so the clock does not run while the model thinks and a turn is no
 * longer charged to the park; what src/clockGate.ts holds still, this lets go.
 *
 * Nothing here decides when to wait or for how long, and nothing is built, bought or
 * changed: no game action is fired at all.
 */
export function wait(request: WaitRequest, done: (outcome: WaitOutcome) => void): void {
    const days = typeof request.days === "number" ? roundDays(request.days) : request.days;

    if (typeof days !== "number" || isNaN(days) || days < MIN_DAYS || days > MAX_DAYS) {
        return done(nothingWaited(typeof days === "number" ? days : 0,
            "`days` must be a number of game days between " + String(MIN_DAYS) + " and "
            + String(MAX_DAYS) + " - the ceiling is what one call can deliver inside the bridge's"
            + " 30 second answer window at the fastest speed; " + String(request.days)
            + " is outside that range. Nothing was waited."));
    }

    // Checked before the clock is touched. The pause the model asked for is the model's, and
    // lifting it here would be this tool deciding something it was not asked to decide.
    if (playerPausedTheGame()) {
        return done(nothingWaited(days, "The game is paused because set_game_speed paused it, and"
            + " no scenario time passes while it is: the date, the guests, the money and every ride"
            + " stand still. Nothing was waited. " + UNPAUSE_CALL));
    }

    openClockWindow();

    if (currentlyPaused()) {
        closeClockWindow();

        return done(nothingWaited(days, "The game is paused and this call could not start it, so"
            + " no scenario time would pass: the date, the guests, the money and every ride stand"
            + " still. Nothing was waited. " + UNPAUSE_CALL));
    }

    const before = snapshot();
    const target = before.position + days;
    let waited = 0;

    const step = function (): void {
        const now = readGameDayPosition();
        const reached = typeof now === "number" && now >= target;

        if (reached || waited >= REAL_BUDGET_MS || currentlyPaused()) {
            closeClockWindow();
            return done(describe(days, waited, before, reached));
        }

        context.setTimeout(function () {
            waited += SLICE_MS;
            step();
        }, SLICE_MS);
    };

    step();
}

@mcpToolController
export class WaitTools {
    @mcpTool({
        name: "Let the game run",
        description: [
            "Advance the scenario clock by a number of GAME days without doing anything to the park,",
            "then report what moved while it ran: the date before and after, the days and game ticks",
            "between them, the change in guests, cash and park rating, and the park messages that arrived.",
            "Nothing is built, bought, opened or priced, and no game action is fired.",
            "The game does not advance at any other time: it is held still between your calls, so a turn",
            "spent thinking costs the scenario nothing and this is the only call that spends it.",
            "`days` is game time and is the same amount of scenario wherever this runs;",
            "the REAL seconds it takes are set by `set_game_speed` and are reported as `seconds`.",
            "A call is capped at twenty real seconds, so a request the current speed cannot reach in that",
            "time comes back with `complete: false` and the days it did get - call again or raise the speed.",
            "`ok: false` means nothing was waited: `days` was out of range, or set_game_speed had paused the game."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                days: {
                    type: "number",
                    minimum: MIN_DAYS,
                    maximum: MAX_DAYS,
                    description: "How much game time to let pass, in game days, from "
                        + String(MIN_DAYS) + " to " + String(MAX_DAYS)
                        + ". A game month is about 31 days and a game year is 8 months."
                        + " What this costs in real time is the speed setting: a game day takes about "
                        + SECONDS_PER_DAY_AT_SPEED[1] + " real seconds at speed 1, "
                        + SECONDS_PER_DAY_AT_SPEED[2] + " at speed 2, "
                        + SECONDS_PER_DAY_AT_SPEED[3] + " at speed 3 and "
                        + SECONDS_PER_DAY_AT_SPEED[4] + " at speed 4, and one call has twenty real"
                        + " seconds - so speed 1 reaches about 1.5 days a call and speed 4 about "
                        + String(MAX_DAYS) + ". `days` in the result is how far the clock actually moved."
                }
            },
            required: ["days"],
            additionalProperties: false
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false
        }
    })
    public wait(args: Record<string, unknown>): DeferredMcpResult {
        const request: WaitRequest = {
            days: typeof args.days === "number" ? args.days : undefined
        };

        return {
            deferred: true,
            start: function (resolve) {
                wait(request, resolve);
            }
        };
    }
}
