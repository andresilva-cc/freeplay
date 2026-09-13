import { mcpTool, mcpToolController } from "./decorators.js";
import { dayNumber } from "../gameClock.js";
import type { DateReading } from "../gameClock.js";
import type { DeferredMcpResult } from "./types.js";

/**
 * The wait is taken in one-second steps rather than one long timer, so a pause that
 * arrives part-way through ends it instead of spending the rest of its length on a
 * stopped clock.
 */
const SLICE_MS = 1000;

const MIN_SECONDS = 1;

/**
 * src/mcp.ts answers a deferred call that has not finished within `DEFERRED_TIMEOUT_MS`
 * - 30 seconds - with a timeout error, and `.mcp.json` gives the client 60. A tool whose
 * whole job is to take time has to stop well inside the shorter of the two, or it reports
 * a failure for a wait that worked. 20 leaves ten seconds of headroom for the slices to
 * land and the park to be read back.
 */
const MAX_SECONDS = 20;

/** The same dozen `park_status` reports, so a long wait does not out-cost a park report. */
const MESSAGE_LIMIT = 12;

export interface WaitRequest {
    seconds?: number;
}

export interface WaitOutcome {
    /** True once time has actually been let run. False means nothing was waited at all. */
    ok: boolean;
    /** Real seconds waited, which is short of the number asked for only if the clock stopped. */
    seconds: number;
    /** The game's speed setting while it ran, which is what decides how much game time that was. */
    speed: number;
    paused: boolean;
    from: DateReading;
    to: DateReading;
    /** Whole game days between `from` and `to`. */
    gameDays: number;
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
    return {
        date: { year: date.year, month: date.month, day: date.day },
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

function plural(count: number, word: string): string {
    return String(count) + " " + word + (count === 1 ? "" : "s");
}

function nothingWaited(detail: string): WaitOutcome {
    const now = snapshot();

    return {
        ok: false,
        seconds: 0,
        speed: currentSpeed(),
        paused: currentlyPaused(),
        from: now.date,
        to: now.date,
        gameDays: 0,
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

function describe(asked: number, waited: number, before: Snapshot): WaitOutcome {
    const after = snapshot();
    const fresh = messagesSince(before.messages, after.messages);
    const gameDays = dayNumber(after.date) - dayNumber(before.date);
    const stoppedEarly = waited < asked;

    return {
        ok: true,
        seconds: waited,
        speed: currentSpeed(),
        paused: currentlyPaused(),
        from: before.date,
        to: after.date,
        gameDays: gameDays,
        guests: after.guests,
        guestsChange: after.guests - before.guests,
        cash: after.cash,
        cashChange: after.cash - before.cash,
        rating: after.rating,
        ratingChange: after.rating - before.rating,
        newMessageCount: fresh.length,
        newMessages: fresh.slice(fresh.length > MESSAGE_LIMIT ? fresh.length - MESSAGE_LIMIT : 0),
        detail: "The game ran for " + plural(waited, "real second") + " at speed "
            + String(currentSpeed()) + ": " + plural(gameDays, "game day") + ", from "
            + dateText(before.date) + " to " + dateText(after.date) + "."
            + (stoppedEarly
                ? " The game was paused after " + plural(waited, "second") + ", so the remaining "
                    + plural(asked - waited, "second") + " were not waited."
                : "")
    };
}

/**
 * Let the game run for a number of real seconds, then report what moved while it ran.
 *
 * The agent loop only continues while the model calls a tool, so a turn that ends by
 * deciding to let the park run and check back later ends the run instead: the game keeps
 * ticking and nothing ever asks the model anything again. `set_game_speed` handed over how
 * fast the clock runs; this is the other half, the deliberate pass that a player makes
 * constantly and that had no representation here at all.
 *
 * The argument is in REAL seconds because real time is the only thing that can be bounded.
 * A game day costs about thirteen real seconds at speed 1 and about one and a half at
 * speed 4, so a wait measured in game days is a request for a real wait of unknown length,
 * and at the low speeds it would routinely be longer than the MCP watchdog - answered as a
 * timeout error for a wait that was working. Game time is what the result is denominated
 * in, which is the half the model reasons about.
 *
 * Nothing here decides when to wait or for how long, and nothing is built, bought or
 * changed: no game action is fired at all.
 */
export function wait(request: WaitRequest, done: (outcome: WaitOutcome) => void): void {
    const seconds = request.seconds;

    if (typeof seconds !== "number" || Math.floor(seconds) !== seconds
        || seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
        return done(nothingWaited("`seconds` must be a whole number of real seconds between "
            + String(MIN_SECONDS) + " and " + String(MAX_SECONDS) + " - the cap is what keeps the"
            + " call inside the bridge's 30 second answer window, and is not a limit on game time,"
            + " which the game's speed setting decides; " + String(seconds) + " is outside that"
            + " range. Nothing was waited."));
    }

    // Checked before a single second is spent. A paused game advances no scenario time at
    // all, so waiting through one costs the whole duration and reports a park identical to
    // the one the last call read - which is indistinguishable from a park where nothing is
    // happening, and is how a run sits frozen to the end of a scenario.
    if (currentlyPaused()) {
        return done(nothingWaited("The game is paused, and no scenario time passes while it is:"
            + " the date, the guests, the money and every ride stand still, so a wait would spend"
            + " its whole length on a stopped clock. Nothing was waited. " + UNPAUSE_CALL));
    }

    const before = snapshot();
    let waited = 0;

    const step = function (): void {
        if (waited >= seconds || currentlyPaused()) {
            return done(describe(seconds, waited, before));
        }

        context.setTimeout(function () {
            waited++;
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
            "Let the game run for a number of real seconds without doing anything to the park,",
            "then report what moved while it ran: the date before and after, the game days between",
            "them, the change in guests, cash and park rating, and the park messages that arrived.",
            "Nothing is built, bought, opened or priced, and no game action is fired.",
            "The wait is in REAL seconds because that is the only thing that can be capped;",
            "how much GAME time it buys is set by the speed the game is running at.",
            "A game month takes about seven real minutes at speed 1 and about fifty seconds at speed 4,",
            "so twenty real seconds is about a day and a half of game time at speed 1",
            "and about twelve days at speed 4 - `set_game_speed` is what changes that rate.",
            "`ok: false` means nothing was waited: the game was already paused, or `seconds` was out of range.",
            "While the game is paused no scenario time passes, so this refuses rather than waiting through it."
        ].join(" "),
        inputSchema: {
            type: "object",
            properties: {
                seconds: {
                    type: "integer",
                    minimum: MIN_SECONDS,
                    maximum: MAX_SECONDS,
                    description: "How long to let the game run, in real seconds, from "
                        + String(MIN_SECONDS) + " to " + String(MAX_SECONDS) + ". The ceiling is the"
                        + " bridge's own answer window and not a limit on how much game time a wait can"
                        + " buy: at speed 4 the same " + String(MAX_SECONDS) + " seconds are worth eight"
                        + " times the game time they are at speed 1. `gameDays` in the result is how much"
                        + " the date actually moved."
                }
            },
            required: ["seconds"],
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
            seconds: typeof args.seconds === "number" ? Math.floor(args.seconds) : undefined
        };

        return {
            deferred: true,
            start: function (resolve) {
                wait(request, resolve);
            }
        };
    }
}
