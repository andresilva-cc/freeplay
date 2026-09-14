/**
 * Whether the scenario is over, and on which in-game day it ended.
 *
 * OpenRCT2 reports `scenario.status` as `inProgress`, `completed` or `failed`, and there is
 * NO hook for it changing: `HookType` carries `interval.day`, `interval.tick`, the map, ride
 * and network hooks and nothing about the objective. So the status has to be read rather
 * than waited for.
 *
 * It was read in exactly one place - `park_status` - which made the end of the run something
 * the model only learned if it happened to ask. In one recorded run it did not ask, and went
 * on playing past a failure it never saw. A person gets a news item and a window the second
 * it happens.
 *
 * `interval.day` is what this reads on, because the game evaluates the objective as game
 * time passes and a day is the coarsest grain that cannot skip one. That the bridge now
 * holds the game paused between tool calls (src/clockGate.ts) does not cost this anything:
 * a paused game runs no update logic, so it decides nothing, so there is nothing to miss.
 * The hook fires inside a `wait` or inside the window an acting tool opens, which is exactly
 * when the status can move.
 *
 * `sampleScenarioStatus` is also called opportunistically wherever the answer is about to be
 * reported. That is the fallback for a game build that will not take the hook at all, and it
 * costs one property read. It never overrides the hook: the first reading of a finished
 * scenario is the one kept, so the date recorded is the day the bridge first saw it rather
 * than the day it happened to be asked.
 *
 * A scenario load puts the status back to `inProgress`, and this follows it: a verdict from
 * the last scenario is not a fact about this one.
 */

/** The two statuses that mean the run is over. `inProgress` is not a verdict. */
export type ScenarioEndStatus = "completed" | "failed";

/**
 * What happened and when, in the same three numbers `park_status` reports the date in:
 * `year` from 1, `month` as the game's index within the year, `day` of that month.
 */
export interface ScenarioVerdict {
    status: ScenarioEndStatus;
    year: number;
    month: number;
    day: number;
}

/** The scenario as `GET /v1` reports it, for a harness that has no MCP session. */
export interface ScenarioIndexEntry {
    name: string | null;
    objective: unknown;
    /** The live `scenario.status`, or null where there is no scenario to read. */
    status: string | null;
    /** The day the end was first read, or null while the scenario is still in progress. */
    endedOn: { year: number; month: number; day: number } | null;
}

let verdict: ScenarioVerdict | undefined;
let watching = false;

function gameScenario(): Partial<Scenario> | undefined {
    return typeof scenario === "undefined" || !scenario ? undefined : scenario;
}

function readStatus(): string | undefined {
    const run = gameScenario();

    return !run || typeof run.status !== "string" ? undefined : run.status;
}

function today(): { year: number; month: number; day: number } | undefined {
    const clock: Partial<GameDate> | undefined = typeof date === "undefined" ? undefined : date;

    if (!clock || typeof clock.year !== "number" || typeof clock.month !== "number"
        || typeof clock.day !== "number") {
        return undefined;
    }

    return { year: clock.year, month: clock.month, day: clock.day };
}

/**
 * Read the status once and record a verdict the first time it is not `inProgress`.
 *
 * Cheap enough to call from anywhere that is about to answer: two property reads and a
 * comparison, with no walk of the park behind it.
 */
export function sampleScenarioStatus(): void {
    const status = readStatus();

    if (status === "inProgress") {
        verdict = undefined;
        return;
    }

    if (typeof verdict !== "undefined" || (status !== "completed" && status !== "failed")) {
        return;
    }

    const when = today();

    if (typeof when === "undefined") {
        // No clock to date it with. Recording a verdict with a made-up day would be worse
        // than recording none: the next sample, once there is a date, gets it right.
        return;
    }

    verdict = { status: status, year: when.year, month: when.month, day: when.day };
}

/**
 * Subscribe to `interval.day`, once per plugin load, and take a first reading.
 *
 * A build that refuses the hook leaves `watching` false rather than throwing: the
 * opportunistic sampling still reports the verdict, a day or so later than the hook would.
 */
export function watchScenarioStatus(): void {
    const game: Partial<Context> | undefined = typeof context === "undefined" || !context
        ? undefined
        : context;

    if (!watching && game && typeof game.subscribe === "function") {
        try {
            game.subscribe("interval.day", sampleScenarioStatus);
            watching = true;
        } catch (_error) {
            // Left unwatched on purpose; the sampling below is what covers it.
        }
    }

    sampleScenarioStatus();
}

/** True once the day hook is in place, which is what `GET /v1` reports it by. */
export function scenarioIsWatched(): boolean {
    return watching;
}

/** The recorded verdict, or nothing while the scenario is still being played. */
export function readScenarioVerdict(): ScenarioVerdict | undefined {
    return verdict;
}

/** The whole scenario reading `GET /v1` carries, live status included. */
export function readScenarioIndexEntry(): ScenarioIndexEntry {
    sampleScenarioStatus();

    const run = gameScenario();
    const status = readStatus();

    return {
        name: run && typeof run.name === "string" ? run.name : null,
        objective: run && typeof run.objective !== "undefined" ? run.objective : null,
        status: typeof status === "string" ? status : null,
        endedOn: typeof verdict === "undefined"
            ? null
            : { year: verdict.year, month: verdict.month, day: verdict.day }
    };
}

/** Forget the verdict and the subscription, for a test that needs a fresh scenario. */
export function resetScenarioWatch(): void {
    verdict = undefined;
    watching = false;
}
