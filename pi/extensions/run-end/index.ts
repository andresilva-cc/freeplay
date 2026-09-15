/**
 * run-end — a run has to be able to end without a human, and end on the same amount of game.
 *
 * Until this existed a Freeplay run ended exactly one way: somebody pressed Ctrl+C. There was
 * no scenario-end detection and no time cap, so every recorded run stopped when a person
 * decided it had gone on long enough, and no number taken off one is citable. All nineteen
 * sessions in pi/sessions ended that way; eleven of their final assistant turns carry
 * stopReason "aborted", which is what a Ctrl+C looks like in the transcript.
 *
 * Four conditions end a run here, and every one of them writes the same record:
 *
 *   scenario_decided      OpenRCT2 reports scenario.status as completed or failed.
 *   game_days_exhausted   The run spent the game days it was given. A played-out run.
 *   wall_clock_exhausted  The wall-clock safety net fired with game days still unspent.
 *                         An abandoned run, and not a result about how the model plays.
 *   model_stopped         The model ended a turn with no tool call and no sign of reaching
 *                         for one, and the scenario had already been decided. That is the
 *                         model stopping correctly, and it is recorded as such.
 *
 * A fifth, `interrupted`, is written when pi shuts down with none of the above having fired.
 * It is not a result. It exists so the file says out loud that a human stopped this one.
 *
 * WHY GAME DAYS AND NOT WALL CLOCK. This budget was 45 minutes of wall clock, justified as
 * "the same quantity for all of them". It is the same quantity and it buys different amounts
 * of game. Since commit 8a62694 the bridge holds the game paused between tool calls, so
 * scenario time advances only inside `wait` — which is capped at 12 game days and 20 real
 * seconds a call. A model thinking for 10 seconds a turn fits about 90 of those calls into
 * 45 minutes and reaches year 4; one thinking for 120 seconds fits 19 and reaches year 1.
 * Same model, same scenario, 4.7x difference in how much scenario got played, decided by
 * tokens per second. At speed 1 a run of nothing but back-to-back `wait` calls reaches 205
 * game days and cannot finish a one-year scenario at all. A budget in game days is the same
 * amount of SCENARIO for every model on every machine, which is the thing two runs have to
 * share before their numbers can be set beside each other.
 *
 * WHY THE WALL CLOCK STAYS, AS A NET. Game time only moves when the model calls `wait`, so a
 * model that never waits never exhausts a game-day budget, and neither does a wedged run.
 * The net is what terminates those. It is deliberately set far above any run that is
 * actually playing: a net that fires on a slow-but-playing run would put host speed straight
 * back in charge of the result, which is the defect above wearing a smaller number.
 *
 * WHY POLL. Watching tool results is free, and much less blind than it was: the bridge puts
 * `scenarioEnded` on EVERY tool result from the day the game decides, not only on park_status,
 * so any tool the model calls shows the flip. What is left is a model that stops calling tools
 * at all, which shows nothing — so the bridge is polled as well. The poll is a plain
 * `GET /v1`; see scenario.ts for why that replaced a park_status call on its own MCP session,
 * and for the park_status fallback that survives it. A poll that fails is "unknown", never
 * "decided": a bridge that is down cannot end a run. The clock is read the same way, off
 * `GET /v1/date`; see gameTime.ts.
 *
 * WHAT THE RECORD CARRIES. A run that ends on a budget used to record nothing about where it
 * got to: no guests, no cash, no date, no scenario name, no build id. Both ends of the run
 * are snapshotted now — see snapshot.ts — so two runs that both ran out of budget are
 * comparable on something. A snapshot that fails degrades to missing fields and a note; it
 * never loses the record and never invents a number.
 *
 * WHAT THE HARNESS DID TO THE MODEL. The record also carries `interventions`: every extension
 * that changes what the model sees, armed or not, with one entry each. It is collected by
 * asking, inside the function that writes the record, so no path can write a record without
 * disclosing — and a disarmed intervention is present and false rather than missing, because
 * "not in the list" and "not armed" have to be different states. See interventions.ts.
 *
 * RELATIONSHIP TO tool-less-turn-nudge. The nudge asks this extension, over pi's shared
 * EventBus, whether a stopped turn means the run is over; see channels.ts for the contract.
 * If this extension is not loaded the nudge falls back to its own judgement. If the NUDGE is
 * not loaded, the `agent_settled` handler below still ends and records the run, because that
 * event means the agent loop has stopped and nothing will restart it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NUDGE_CHANNEL, STOPPED_TURN_CHANNEL } from "./channels.ts";
import type { NudgeTelemetry, StoppedTurnRequest, StopVerdict } from "./channels.ts";
import {
	appendEntry,
	openRunEndLog,
	type EndCondition,
	type GameDayAccount,
	type ModelParams,
	type NudgeTotals,
	type RunEndRecord,
} from "./record.ts";
import {
	collectInterventions,
	INTERVENTION_CENSUS_CHANNEL,
	INTERVENTION_CHANNEL,
	type InterventionCensus,
	type InterventionId,
	type InterventionReport,
	type Interventions,
} from "./interventions.ts";
import {
	createScenarioPoller,
	isDecided,
	readScenarioFromToolResult,
	type ScenarioReading,
} from "./scenario.ts";
import { DAYS_IN_YEAR, readGameTimeFromToolResult, roundDays, type DateReading } from "./gameTime.ts";
import {
	createSnapshotReader,
	dateReadingOf,
	missingSnapshot,
	type BridgeSnapshot,
} from "./snapshot.ts";

/**
 * The budget, in game days, when nothing overrides it. 276.
 *
 * Worked out from the scenario rather than from the runs. Forest Frontiers asks for 250
 * guests by the end of Year 1, and a scenario year is 245 game days — the sum of OpenRCT2's
 * own `days_in_month`, which gameTime.ts mirrors. So the game decides this scenario on day
 * 245, and a budget of 245 would cut the run off at the exact moment the verdict lands: the
 * budget would pre-empt the game's own answer, and no run would ever end `scenario_decided`
 * on a scenario it was about to pass. One more game month — 31 days, the longest in the
 * table — is the headroom, which leaves 276.
 *
 * What that costs in real time is not the budget's business, which is the point of it. At
 * speed 4 it is 23 `wait` calls, eight real minutes of waiting; at speed 1 the same 276 days
 * is about an hour of waiting. Either way it is the same amount of scenario.
 *
 * It is measured from where the run began, not from scenario day 0: "how much scenario this
 * run played" is the quantity two runs are compared on, and every run here starts from a
 * freshly loaded scenario anyway.
 *
 * Raise it for a longer scenario. A scenario asking for a verdict in year 3 wants
 * 3 * 245 + 31.
 */
const DEFAULT_BUDGET_GAME_DAYS = 276;

/**
 * The safety net, in minutes of wall clock. 240 — four hours.
 *
 * This is NOT the budget and must never be able to act like one: if it fires on a run that
 * is still playing, tokens per second is deciding the result again. So it is set above any
 * run that could still be playing. The worst case that is still real play is a model that
 * never raises the game speed: 276 game days at speed 1 is about an hour of `wait` alone, on
 * top of a couple of hundred turns of thinking. Four hours covers that and still bounds a
 * run that is wedged, or one whose model never calls `wait` at all, at an afternoon rather
 * than forever.
 *
 * A run that ends here is recorded as `wall_clock_exhausted`, which is not a played-out run
 * and must never be read as one.
 */
const DEFAULT_WALL_CLOCK_MINUTES = 240;

/** The bridge's fixed port, set in servers/openrct2/src/index.ts. */
const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8080";

/**
 * Throttled rather than run every turn. `GET /v1` is cheap enough that this is now about the
 * bridge's game thread rather than about the request, and the park_status fallback behind it
 * still walks the whole park.
 */
const POLL_INTERVAL_MS = 30_000;

/** A poll is loopback to a local process; anything slower than this has gone wrong. */
const POLL_TIMEOUT_MS = 10_000;

/**
 * How often the clock is read independently of tool results.
 *
 * Tool results are the main meter and they are free: `wait` reports the days it moved and
 * every result carries `gameDaysSinceLastCall`. This read covers what they cannot — a long
 * `wait` still in flight, and anything that moved the clock without going through a tool
 * result at all. `GET /v1/date` is seven property reads with no MCP session behind it.
 */
const DATE_INTERVAL_MS = 30_000;

/** The closing snapshot is three reads and the record waits on it, so it gets a shorter leash. */
const SNAPSHOT_TIMEOUT_MS = 5_000;

/** How often the budgets are re-checked independently of turns, so one long turn cannot outlast them. */
const TICK_MS = 5_000;

const STATUS_KEY = "run-end";

const FLAG_GAME_DAYS = "run-budget-days";
const FLAG_WALL_CLOCK = "run-budget-minutes";

function emptyTotals(): NudgeTotals {
	return { total: 0, narrated: 0, empty: 0, declined: 0, capHits: 0, runaways: 0 };
}

/**
 * What pi exposes about the model, without asserting a shape pi does not promise.
 *
 * Read defensively field by field: null means pi did not hand it to the extension, never
 * that the model ran without it. See ModelParams in record.ts for why this is recorded.
 */
function readModelParams(ctx: ExtensionContext): ModelParams | null {
	const model = ctx.model as unknown as Record<string, unknown> | undefined;
	if (!model) return null;

	const params: ModelParams = {
		name: typeof model.name === "string" ? model.name : null,
		provider: typeof model.provider === "string" ? model.provider : null,
		reasoning: typeof model.reasoning === "boolean" ? model.reasoning : null,
		contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : null,
		maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : null,
		samplingParams:
			model.samplingParams && typeof model.samplingParams === "object"
				? ({ ...(model.samplingParams as Record<string, unknown>) })
				: null,
	};

	// Nothing but the id was visible. Say that with a null rather than with six nulls.
	const anything = Object.values(params).some((value) => value !== null);
	return anything ? params : null;
}

export default function (pi: ExtensionAPI) {
	let gameDayBudget = DEFAULT_BUDGET_GAME_DAYS;
	let wallClockMs = DEFAULT_WALL_CLOCK_MINUTES * 60_000;
	let bridgeUrl = DEFAULT_BRIDGE_URL;
	let poll: (() => Promise<ScenarioReading | undefined>) | undefined;
	let bridge: ReturnType<typeof createSnapshotReader> | undefined;

	let logFile: string | undefined;
	let startedAt = 0;
	let startedAtIso = "";
	let turns = 0;
	let toolCalls = 0;
	let scenario: ScenarioReading | undefined;
	let nudges = emptyTotals();
	let ended = false;
	let ending = false;
	/** The condition a closing snapshot is already being taken for. See `endRunWith`. */
	let pending: { condition: EndCondition; detail: string } | undefined;
	let pollFailures = 0;
	let lastPollAt = 0;
	let lastDateAt = 0;
	let dateInFlight = false;
	let inFlight: Promise<ScenarioReading | undefined> | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let lastCtx: ExtensionContext | undefined;

	// The game-day meter. See GameDayAccount in record.ts for what each of these means.

	/**
	 * Whether a reading may still establish where the run began. Shut the moment the run
	 * starts ending: the CLOSING snapshot must never be able to become the baseline, or a
	 * run whose bridge was down at the start would report having spent no scenario at all.
	 */
	let baselineOpen = true;
	let startDay: number | undefined;
	let startDate: DateReading | undefined;
	let currentDay: number | undefined;
	let currentDate: DateReading | undefined;
	let waitDays = 0;
	let waitCalls = 0;
	let billedDays = 0;
	let billedCalls = 0;

	let startState: BridgeSnapshot | undefined;
	let lastState: BridgeSnapshot | undefined;

	/**
	 * Interventions that announced themselves at their own `session_start`.
	 *
	 * Deliberately NOT cleared in `session_start` below. Extension handlers for one event run in
	 * load order, and an intervention that announces before run-end resets would have its
	 * announcement thrown away — a run could then be armed and say nothing. Every intervention
	 * announces once per session and overwrites its own entry, so nothing here goes stale, and
	 * the census at record time overrides all of it anyway.
	 */
	const announced = new Map<InterventionId, InterventionReport>();

	pi.registerFlag(FLAG_GAME_DAYS, {
		type: "string",
		description: `Budget for the run, in GAME days (default ${DEFAULT_BUDGET_GAME_DAYS}; 0 disables it)`,
	});
	pi.registerFlag(FLAG_WALL_CLOCK, {
		type: "string",
		description: `Wall-clock safety net, in minutes (default ${DEFAULT_WALL_CLOCK_MINUTES}; 0 disables it)`,
	});

	const now = () => Date.now();
	const elapsed = () => (startedAt > 0 ? now() - startedAt : 0);

	/** Visible without a debug flag, and without corrupting the TUI. */
	const announce = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error") => {
		if (ctx.hasUI) ctx.ui.notify(text, level);
		if (ctx.mode !== "tui") process.stderr.write(`[run-end] ${text}\n`);
	};

	const readOverride = (flag: string, envVar: string, fallback: number): number => {
		const fromFlag = pi.getFlag(flag);
		const raw = typeof fromFlag === "string" && fromFlag.length > 0 ? fromFlag : process.env[envVar];
		const value = raw === undefined || raw === "" ? fallback : Number(raw);
		if (!Number.isFinite(value) || value < 0) return fallback;
		return value;
	};

	const noteScenario = (reading: ScenarioReading | undefined) => {
		if (!reading) return;
		// A verdict is not takeable back. The closing snapshot is read a moment after the
		// run has already ended on a decided scenario, and a reading that says `inProgress`
		// there — an older plugin, a scenario the game has reloaded, a race — must not be
		// able to record the run as undecided.
		if (isDecided(scenario?.status) && !isDecided(reading.status)) return;
		const changed = !scenario || scenario.status !== reading.status;
		scenario = reading;
		if (!changed) return;
		appendEntry(logFile, {
			event: "scenario_status",
			status: reading.status,
			source: reading.source,
			name: reading.name,
			elapsedMs: elapsed(),
			timestamp: new Date().toISOString(),
		});
	};

	/**
	 * Fold one clock reading in.
	 *
	 * `startDay` is the FIRST reading of the run, whenever it lands. Normally that is the
	 * opening snapshot; if the bridge was not answering then, it is whatever answered first,
	 * and a bridge that is not answering is also a bridge the model cannot play through — so
	 * there is no stretch of play hiding before the baseline.
	 *
	 * `currentDay` only ever moves forward, and the date reported beside it moves with it. A
	 * reloaded or cheated scenario can put the date back, and there is no honest bill for
	 * negative time; nor may a reading taken after the run stopped pull the reported date
	 * back to where the run was not.
	 */
	const noteDay = (day: number | undefined, date: DateReading | undefined, baseline?: DateReading, baselineDay?: number) => {
		if (baselineOpen && startDay === undefined && typeof baselineDay === "number") {
			startDay = baselineDay;
			startDate = baseline;
		}
		if (baselineOpen && startDay === undefined && typeof day === "number") {
			startDay = day;
			startDate = date;
		}

		if (typeof day !== "number") {
			if (date && currentDate === undefined) currentDate = date;
			return;
		}
		if (currentDay !== undefined && day < currentDay) return;
		currentDay = day;
		if (date) currentDate = date;
	};

	/** How much scenario this run has spent, and which meter said so. */
	const account = (): GameDayAccount => {
		const measured =
			startDay !== undefined && currentDay !== undefined
				? { spent: roundDays(Math.max(0, currentDay - startDay)), source: "date" as const }
				: billedCalls > 0
					? { spent: roundDays(billedDays), source: "since_last_call" as const }
					: { spent: null, source: "unmeasured" as const };

		return {
			spent: measured.spent,
			source: measured.source,
			budget: gameDayBudget,
			inWait: roundDays(waitDays),
			waitCalls,
			startedOn: startDate ?? null,
			reachedOn: currentDate ?? null,
		};
	};

	const noteSnapshot = (state: BridgeSnapshot) => {
		lastState = state;
		if (state.date) noteDay(state.date.dayNumber ?? undefined, dateReadingOf(state.date));
		if (state.scenario && state.scenario.status !== "unknown") {
			noteScenario({
				status: state.scenario.status,
				name: state.scenario.name ?? undefined,
				objective: state.scenario.objective,
				endedOn: state.scenario.endedOn ?? undefined,
				source: "bridge_index",
				observedAt: state.observedAt,
			});
		}
	};

	/** Never throws: a snapshot that cannot be taken is still a snapshot, and says why. */
	const takeSnapshot = async (): Promise<BridgeSnapshot> => {
		if (!bridge) return missingSnapshot("the run had no bridge reader: the session never started one");
		try {
			const state = await bridge.read();
			noteSnapshot(state);
			return state;
		} catch (error) {
			return missingSnapshot(
				`the snapshot could not be taken: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	/**
	 * The cheapest read there is, throttled. This is what sees a clock that moved without a
	 * tool result to report it — inside a `wait` that is still running, above all.
	 */
	const refreshGameDay = async (force: boolean): Promise<void> => {
		if (!bridge || dateInFlight) return;
		if (!force && now() - lastDateAt < DATE_INTERVAL_MS) return;

		lastDateAt = now();
		dateInFlight = true;
		try {
			const reading = await bridge.readDate();
			noteDay(reading.dayNumber ?? undefined, dateReadingOf(reading));
		} catch {
			// A clock the bridge will not read out is not a day spent. The tool-result meter
			// carries the run in the meantime, and the record says which meter answered.
		} finally {
			dateInFlight = false;
		}
	};

	/**
	 * Best current reading. `force` skips the throttle; it is only set on the decision the
	 * nudge is waiting for, which happens a handful of times in a run at most.
	 *
	 * Never throws and never rejects. A failed poll leaves the last known reading in place,
	 * which for a run that has never seen one means "unknown".
	 */
	const resolveScenario = async (force: boolean): Promise<ScenarioReading | undefined> => {
		if (isDecided(scenario?.status)) return scenario;
		if (!poll) return scenario;
		if (!force && now() - lastPollAt < POLL_INTERVAL_MS) return scenario;
		if (inFlight) return inFlight;

		lastPollAt = now();
		inFlight = (async () => {
			try {
				const reading = await poll!();
				pollFailures = 0;
				noteScenario(reading);
			} catch (error) {
				pollFailures += 1;
				appendEntry(logFile, {
					event: "poll_failed",
					error: error instanceof Error ? error.message : String(error),
					consecutiveFailures: pollFailures,
					elapsedMs: elapsed(),
					timestamp: new Date().toISOString(),
				});
			}
			return scenario;
		})();

		try {
			return await inFlight;
		} finally {
			inFlight = undefined;
		}
	};

	const stopTicker = () => {
		if (ticker === undefined) return;
		clearInterval(ticker);
		ticker = undefined;
	};

	/**
	 * Write the record, then stop pi.
	 *
	 * The record is written first and synchronously: it is the artifact, and it must be on
	 * disk before anything that could fail gets a turn. `shutdown()` asks pi to quit at the
	 * next settling point rather than killing it, so pi's own session file is flushed and
	 * session_shutdown handlers — including the nudge's summary line — still run.
	 * `abort()` is then what makes that settling point arrive: on its own, shutdown() would
	 * wait for an agent loop that has no reason to stop.
	 *
	 * `endState` is passed in rather than fetched here, because fetching it is three HTTP
	 * reads and this function must stay synchronous. `endRunWith` below is the path that
	 * takes a fresh one; the shutdown path hands over the last one it already had.
	 */
	const endRun = (
		ctx: ExtensionContext,
		condition: EndCondition,
		detail: string,
		endState: BridgeSnapshot,
		shutdownReason?: string,
	): void => {
		if (ended) return;
		ended = true;
		stopTicker();

		const days = account();
		const record: RunEndRecord = {
			event: "run_end",
			condition,
			detail,
			scenario: {
				status: scenario?.status ?? "unknown",
				name: scenario?.name ?? null,
				objective: scenario?.objective ?? null,
				source: scenario?.source ?? "unknown",
				observedAt: scenario?.observedAt ?? null,
				// The in-game day the game decided, which is the figure a benchmark cites
				// when the game is what ended the run. `gameDays` below is the figure for
				// every other ending.
				endedOn: scenario?.endedOn ?? null,
			},
			gameDays: days,
			elapsedMs: elapsed(),
			elapsedMinutes: Math.round((elapsed() / 60_000) * 100) / 100,
			wallClockBudgetMs: wallClockMs,
			turns,
			toolCalls,
			nudges: { ...nudges },
			// Taken here rather than passed in, so that there is no path through this function
			// that writes a record without asking what the harness did to the model.
			interventions: takeInterventionCensus(),
			model: ctx.model?.id ?? null,
			modelParams: readModelParams(ctx),
			startState: startState ?? null,
			endState,
			sessionId: ctx.sessionManager.getSessionId(),
			startedAt: startedAtIso,
			endedAt: new Date().toISOString(),
			timestamp: new Date().toISOString(),
		};
		if (shutdownReason) record.shutdownReason = shutdownReason;

		appendEntry(logFile, record);
		try {
			// A second copy in pi's own session file, so the record travels with the transcript.
			// It can refuse during shutdown, when the session is already being torn down; the
			// JSONL above is the authoritative one and is already written.
			pi.appendEntry<RunEndRecord>("run-end", record);
		} catch {
			// Ignored on purpose.
		}

		try {
			const spent = days.spent === null ? "unmeasured" : `${days.spent} game days`;
			const armed =
				record.interventions.armed.length > 0
					? ` Harness interventions armed: ${record.interventions.armed.join(", ")}.`
					: "";
			announce(
				ctx,
				`run ended: ${detail} (${spent}, ${record.elapsedMinutes} min, ${turns} turns).${armed} Record: ${logFile ?? "unavailable"}`,
				"warning",
			);
			ctx.ui.setStatus(STATUS_KEY, `run ended — ${condition}`);
		} catch {
			// The TUI is already stopped when this runs from session_shutdown.
		}

		// `interrupted` is written from session_shutdown: pi is already on its way out and
		// asking it to leave again would be noise.
		if (condition === "interrupted") return;

		try {
			ctx.shutdown();
		} catch {
			// Nothing here may throw past the handler that called it.
		}
		try {
			ctx.abort();
		} catch {
			// Same.
		}
	};

	/**
	 * Take a closing snapshot, then end.
	 *
	 * `pending` holds the door for the few seconds the snapshot takes, so two conditions that
	 * fire together cannot write two records — and, more importantly, so a shutdown landing
	 * inside that window writes the condition that was ALREADY decided rather than
	 * `interrupted`. A run that ended because the game called the scenario must not be
	 * recorded as one a human stopped, just because the snapshot was still in the air.
	 */
	const endRunWith = async (ctx: ExtensionContext, condition: EndCondition, detail: string): Promise<void> => {
		if (ended || ending) return;
		ending = true;
		baselineOpen = false;
		pending = { condition, detail };
		let state: BridgeSnapshot;
		try {
			state = await takeSnapshot();
		} finally {
			ending = false;
		}
		endRun(ctx, condition, detail, state);
	};

	/** The snapshot for a run that is being torn down, which cannot wait for a fresh read. */
	const snapshotOnHand = (why: string): BridgeSnapshot => {
		if (!lastState) return missingSnapshot(why);
		const age = Math.round((now() - Date.parse(lastState.observedAt)) / 1000);
		const note = `read ${age}s before the run ended: ${why}`;
		return { ...lastState, note: lastState.note ? `${lastState.note}; ${note}` : note };
	};

	const describeScenario = () => scenario?.status ?? "unknown";

	/**
	 * Ask every intervention what it did, and fold in the announcements for any that did not
	 * answer. Census answers go first because `collectInterventions` keeps the first entry per
	 * id and the census carries the live counts; see interventions.ts.
	 *
	 * Never throws. A census that cannot be taken still returns a complete list, because the
	 * registry supplies an entry for every known intervention that said nothing.
	 */
	const takeInterventionCensus = (): Interventions => {
		const census: InterventionCensus = { reports: [] };
		try {
			pi.events.emit(INTERVENTION_CENSUS_CHANNEL, census);
		} catch {
			// A subscriber threw. Whatever was pushed before it is still in the array, and the
			// announcements below cover the rest.
		}
		return collectInterventions([...census.reports, ...announced.values()]);
	};

	/**
	 * The budget. Checked before the net, so a run that has played out its game days is never
	 * recorded as one that was abandoned.
	 */
	const checkGameDays = (ctx: ExtensionContext): boolean => {
		if (ended || ending || gameDayBudget <= 0 || startedAt === 0) return false;
		const days = account();
		if (days.spent === null || days.spent < gameDayBudget) return false;

		void endRunWith(
			ctx,
			"game_days_exhausted",
			`the ${gameDayBudget} game day budget ran out: the run spent ${days.spent} game days` +
				`${days.reachedOn ? `, reaching year ${days.reachedOn.year}, month ${days.reachedOn.month}, day ${days.reachedOn.day}` : ""}` +
				`, with the scenario ${describeScenario()}`,
		);
		return true;
	};

	/** The net. Only ever fires on a run that did NOT spend its game days. */
	const checkWallClock = (ctx: ExtensionContext): boolean => {
		if (ended || ending || wallClockMs <= 0 || startedAt === 0) return false;
		if (elapsed() < wallClockMs) return false;

		const days = account();
		const minutes = Math.round((wallClockMs / 60_000) * 100) / 100;
		void endRunWith(
			ctx,
			"wall_clock_exhausted",
			`the ${minutes} minute wall-clock safety net ran out with only ` +
				`${days.spent === null ? "an unmeasured number of" : days.spent} of ${gameDayBudget} game days spent` +
				` and the scenario ${describeScenario()}. This run was abandoned, not played out`,
		);
		return true;
	};

	const checkBudgets = (ctx: ExtensionContext): boolean => checkGameDays(ctx) || checkWallClock(ctx);

	const endIfDecided = (ctx: ExtensionContext): boolean => {
		if (ended || ending || !isDecided(scenario?.status)) return false;
		void endRunWith(ctx, "scenario_decided", `the scenario was reported ${scenario?.status} by the game`);
		return true;
	};

	pi.on("session_start", (_event, ctx) => {
		ended = false;
		ending = false;
		pending = undefined;
		turns = 0;
		toolCalls = 0;
		scenario = undefined;
		nudges = emptyTotals();
		pollFailures = 0;
		lastPollAt = 0;
		lastDateAt = 0;
		dateInFlight = false;
		inFlight = undefined;
		baselineOpen = true;
		startDay = undefined;
		startDate = undefined;
		currentDay = undefined;
		currentDate = undefined;
		waitDays = 0;
		waitCalls = 0;
		billedDays = 0;
		billedCalls = 0;
		startState = undefined;
		lastState = undefined;
		startedAt = now();
		startedAtIso = new Date(startedAt).toISOString();
		gameDayBudget = readOverride(FLAG_GAME_DAYS, "FREEPLAY_RUN_BUDGET_DAYS", DEFAULT_BUDGET_GAME_DAYS);
		wallClockMs = Math.round(
			readOverride(FLAG_WALL_CLOCK, "FREEPLAY_RUN_BUDGET_MINUTES", DEFAULT_WALL_CLOCK_MINUTES) * 60_000,
		);
		bridgeUrl = process.env.FREEPLAY_BRIDGE_URL || DEFAULT_BRIDGE_URL;
		poll = createScenarioPoller({ baseUrl: bridgeUrl, timeoutMs: POLL_TIMEOUT_MS });
		bridge = createSnapshotReader({ baseUrl: bridgeUrl, timeoutMs: SNAPSHOT_TIMEOUT_MS });
		logFile = openRunEndLog(ctx.sessionManager.getSessionId());
		lastCtx = ctx;

		appendEntry(logFile, {
			event: "run_start",
			gameDayBudget,
			wallClockBudgetMs: wallClockMs,
			bridgeUrl,
			model: ctx.model?.id ?? null,
			modelParams: readModelParams(ctx),
			sessionId: ctx.sessionManager.getSessionId(),
			timestamp: startedAtIso,
		});
		ctx.ui.setStatus(
			STATUS_KEY,
			gameDayBudget > 0 ? `budget ${gameDayBudget} game days` : "no game-day budget",
		);

		// Deliberately not awaited: the session must not wait on three HTTP reads, and the
		// run's first turn cannot spend game time before the model has called anything.
		void takeSnapshot().then((state) => {
			if (startState) return;
			startState = state;
			appendEntry(logFile, {
				event: "run_start_state",
				state,
				elapsedMs: elapsed(),
				timestamp: new Date().toISOString(),
			});
		});

		stopTicker();
		// One long turn must not be able to outlast the budget, and turn_end is the only other
		// place it is checked. Unref'd so this timer can never be the reason pi stays alive.
		ticker = setInterval(() => {
			const target = lastCtx;
			if (!target) return;
			void refreshGameDay(false);
			checkBudgets(target);
		}, TICK_MS);
		(ticker as unknown as { unref?: () => void }).unref?.();
	});

	pi.on("turn_start", (_event, ctx) => {
		lastCtx = ctx;
	});

	// Free: when the model reads park_status itself, the flip is in the result — and so is
	// the clock. `wait` reports the game days it actually moved, and EVERY result carries the
	// bridge's own bill for the turn that led to it.
	pi.on("tool_result", (event, ctx) => {
		lastCtx = ctx;
		toolCalls += 1;
		if (event.isError) return;
		noteScenario(readScenarioFromToolResult(event.content));

		const time = readGameTimeFromToolResult(event.content);
		if (!time) return;
		if (typeof time.waitDays === "number") {
			waitDays += time.waitDays;
			waitCalls += 1;
		}
		if (typeof time.sinceLastCall === "number") {
			billedDays += time.sinceLastCall;
			billedCalls += 1;
		}
		noteDay(time.dayNumber, time.date, time.from, time.fromDayNumber);
		checkBudgets(ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		lastCtx = ctx;
		turns += 1;
		if (endIfDecided(ctx)) return;
		if (checkBudgets(ctx)) return;

		// Deliberately not awaited. pi waits for this handler before the next turn starts, and
		// a poll that is merely slow — a big park, a busy game thread — must not be able to add
		// its timeout to every turn. Nobody is waiting on the answer here, so it lands when it
		// lands and ends the run then.
		void resolveScenario(false).then(() => {
			const target = lastCtx;
			if (target) endIfDecided(target);
		});
		void refreshGameDay(false).then(() => {
			const target = lastCtx;
			if (target) checkBudgets(target);
		});
	});

	pi.on("agent_end", (_event, ctx) => {
		lastCtx = ctx;
	});

	/**
	 * The agent loop has stopped and nothing — no retry, no compaction, no queued nudge — will
	 * restart it. That is the run over, whatever else is true, so it gets a record rather than
	 * a session sitting at an idle prompt until somebody notices.
	 */
	pi.on("agent_settled", async (_event, ctx) => {
		lastCtx = ctx;
		if (ended || ending) return;

		await resolveScenario(true);
		if (endIfDecided(ctx)) return;

		await endRunWith(
			ctx,
			"model_stopped",
			`the agent loop stopped with the scenario ${describeScenario()} and nothing queued to continue it`,
		);
	});

	pi.on("session_shutdown", (event, ctx) => {
		stopTicker();
		if (ended) return;

		// No fresh snapshot on this path: pi is already leaving, and a record that arrives
		// after the process has gone is not a record.
		const state = snapshotOnHand("pi was shutting down and a fresh read would not have been written in time");

		// A condition was already chosen and is only waiting on its snapshot. Write THAT,
		// not `interrupted`: the run ended for the reason it ended for.
		if (pending) {
			endRun(ctx, pending.condition, `${pending.detail} (recorded as pi shut down)`, state);
			return;
		}

		// Nothing fired, so a person stopped this one. Say so in the record rather than
		// leaving a reader to infer it from a missing file.
		endRun(
			ctx,
			"interrupted",
			`pi shut down (${event.reason}) with no end condition met and the scenario ${describeScenario()}`,
			state,
			event.reason,
		);
	});

	/**
	 * An intervention announcing itself at its own session_start. Kept as the fallback for the
	 * census, and written to the log the moment it lands so that a run which never reaches a
	 * record still says what was armed in it.
	 *
	 * The log line is best-effort and the map is not: an announcement that arrives before this
	 * extension's own session_start has opened `logFile` writes nothing, but is still counted
	 * in the record, which is the half that a published result depends on.
	 */
	pi.events.on(INTERVENTION_CHANNEL, (data) => {
		if (!data || typeof data !== "object") return;
		const report = data as InterventionReport;
		if (typeof report.id !== "string" || report.id.length === 0) return;
		announced.set(report.id, report);
		appendEntry(logFile, {
			event: "intervention_armed",
			id: report.id,
			armed: report.armed === true,
			how: typeof report.how === "string" ? report.how : "unstated",
			detail: typeof report.detail === "string" ? report.detail : "",
			elapsedMs: elapsed(),
			timestamp: new Date().toISOString(),
		});
	});

	pi.events.on(NUDGE_CHANNEL, (data) => {
		const telemetry = data as NudgeTelemetry | undefined;
		if (!telemetry) return;
		if (telemetry.event === "nudge") {
			nudges.total = telemetry.total;
			if (telemetry.reason === "narrated") nudges.narrated += 1;
			if (telemetry.reason === "empty") nudges.empty += 1;
		} else if (telemetry.event === "declined") {
			nudges.declined += 1;
		} else if (telemetry.event === "cap_reached") {
			nudges.capHits += 1;
		} else if (telemetry.event === "runaway") {
			nudges.runaways += 1;
		}
	});

	/**
	 * "The model stopped. Is this run over?"
	 *
	 * Assigns `request.decision` synchronously so the emitting nudge can await it; see
	 * channels.ts. Answers "ended" only when the scenario is actually decided. An undecided
	 * scenario — including one nothing could resolve — comes back "undecided" and the nudge
	 * does what it always did, because the recorded evidence says a turn with no tool name in
	 * it is usually mid-plan narration, not a decision to stop.
	 */
	pi.events.on(STOPPED_TURN_CHANNEL, (data) => {
		const request = data as StoppedTurnRequest | undefined;
		if (!request || request.decision) return;

		request.decision = (async (): Promise<StopVerdict> => {
			const ctx = lastCtx;
			if (!ctx) return "undecided";
			if (ended) return "ended";

			await resolveScenario(true);
			request.statusAtRequest = scenario?.status ?? "unknown";

			if (!isDecided(scenario?.status)) return "undecided";

			await endRunWith(
				ctx,
				"model_stopped",
				`model stopped correctly: it ended a turn with no tool call and the scenario was already ${scenario?.status}`,
			);
			return "ended";
		})();
	});

	pi.registerCommand("run-end", {
		description: "Show the run's game-day budget, wall-clock net and last known scenario status",
		handler: async (_args, ctx) => {
			await resolveScenario(true);
			await refreshGameDay(true);
			const days = account();
			const year = roundDays(gameDayBudget / DAYS_IN_YEAR);
			const interventions = takeInterventionCensus();
			const lines = [
				`game days: ${days.spent ?? "unmeasured"} of ${gameDayBudget} (${year} scenario years), via ${days.source}`,
				`wait: ${days.inWait} days over ${days.waitCalls} calls`,
				`wall-clock net: ${Math.round((elapsed() / 60_000) * 10) / 10} min of ${Math.round(wallClockMs / 60_000)} min`,
				`turns: ${turns}, tool calls: ${toolCalls}`,
				`scenario: ${describeScenario()}${scenario ? ` (via ${scenario.source})` : ""}`,
				`harness interventions armed: ${interventions.armed.length > 0 ? interventions.armed.join(", ") : "none"}` +
					` (of ${interventions.all.map((i) => i.id).join(", ")})`,
				`bridge: ${bridgeUrl}${pollFailures > 0 ? ` — ${pollFailures} poll failures in a row` : ""}`,
				`record: ${logFile ?? "unavailable"}`,
			];
			announce(ctx, lines.join(" | "), "info");
		},
	});
}
