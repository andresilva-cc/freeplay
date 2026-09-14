/**
 * run-end — a run has to be able to end without a human.
 *
 * Until this existed a Freeplay run ended exactly one way: somebody pressed Ctrl+C. There was
 * no scenario-end detection and no time cap, so every recorded run stopped when a person
 * decided it had gone on long enough, and no number taken off one is citable. All nineteen
 * sessions in pi/sessions ended that way; eleven of their final assistant turns carry
 * stopReason "aborted", which is what a Ctrl+C looks like in the transcript.
 *
 * Three conditions end a run here, and every one of them writes the same record:
 *
 *   scenario_decided   OpenRCT2 reports scenario.status as completed or failed.
 *   budget_exhausted   The wall-clock budget ran out.
 *   model_stopped      The model ended a turn with no tool call and no sign of reaching for
 *                      one, and the scenario had already been decided. That is the model
 *                      stopping correctly, and it is recorded as such.
 *
 * A fourth, `interrupted`, is written when pi shuts down with none of the above having fired.
 * It is not a result. It exists so the file says out loud that a human stopped this one.
 *
 * WHY POLL. Watching tool results is free, and much less blind than it was: the bridge puts
 * `scenarioEnded` on EVERY tool result from the day the game decides, not only on park_status,
 * so any tool the model calls shows the flip. What is left is a model that stops calling tools
 * at all, which shows nothing — so the bridge is polled as well. The poll is a plain
 * `GET /v1`; see scenario.ts for why that replaced a park_status call on its own MCP session,
 * and for the park_status fallback that survives it. A poll that fails is "unknown", never
 * "decided": a bridge that is down cannot end a run.
 *
 * WHY WALL CLOCK AND NOT TURNS. A turn here has run from under a second to over three
 * minutes, so a turn cap would be a different amount of time for every model and for every
 * run of the same model. Elapsed wall clock is the same quantity for all of them.
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
	type NudgeTotals,
	type RunEndRecord,
} from "./record.ts";
import {
	createScenarioPoller,
	isDecided,
	readScenarioFromToolResult,
	type ScenarioReading,
} from "./scenario.ts";

/**
 * Wall-clock budget, in minutes, when nothing overrides it.
 *
 * The nineteen recorded runs lasted 0.2 to 23.4 minutes, median 3.3, and every one of them
 * was cut short by a human — so 23.4 is a floor on how long a run wants to be, not a ceiling.
 * The only run that reached a scenario verdict took 12.3 minutes over 55 turns. 45 is a little
 * under twice the longest run anybody has watched and three and a half times the one that
 * finished, which leaves room for a slower model or a longer scenario while still bounding a
 * wedged run at under an hour. It is a starting point chosen from the runs that exist, not a
 * measured optimum; raise it the first time a real run is cut off mid-play.
 */
const DEFAULT_BUDGET_MINUTES = 45;

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

/** How often the budget is re-checked independently of turns, so one long turn cannot outlast it. */
const TICK_MS = 5_000;

const STATUS_KEY = "run-end";

const FLAG_BUDGET = "run-budget-minutes";

function emptyTotals(): NudgeTotals {
	return { total: 0, narrated: 0, empty: 0, declined: 0, capHits: 0, runaways: 0 };
}

export default function (pi: ExtensionAPI) {
	let budgetMs = DEFAULT_BUDGET_MINUTES * 60_000;
	let bridgeUrl = DEFAULT_BRIDGE_URL;
	let poll: (() => Promise<ScenarioReading | undefined>) | undefined;

	let logFile: string | undefined;
	let startedAt = 0;
	let startedAtIso = "";
	let turns = 0;
	let toolCalls = 0;
	let scenario: ScenarioReading | undefined;
	let nudges = emptyTotals();
	let ended = false;
	let pollFailures = 0;
	let lastPollAt = 0;
	let inFlight: Promise<ScenarioReading | undefined> | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let lastCtx: ExtensionContext | undefined;

	pi.registerFlag(FLAG_BUDGET, {
		type: "string",
		description: `Wall-clock budget for the run, in minutes (default ${DEFAULT_BUDGET_MINUTES}; 0 disables it)`,
	});

	const now = () => Date.now();
	const elapsed = () => (startedAt > 0 ? now() - startedAt : 0);

	/** Visible without a debug flag, and without corrupting the TUI. */
	const announce = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error") => {
		if (ctx.hasUI) ctx.ui.notify(text, level);
		if (ctx.mode !== "tui") process.stderr.write(`[run-end] ${text}\n`);
	};

	const readBudgetMs = (): number => {
		const fromFlag = pi.getFlag(FLAG_BUDGET);
		const raw = typeof fromFlag === "string" && fromFlag.length > 0 ? fromFlag : process.env.FREEPLAY_RUN_BUDGET_MINUTES;
		const minutes = raw === undefined || raw === "" ? DEFAULT_BUDGET_MINUTES : Number(raw);
		if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_BUDGET_MINUTES * 60_000;
		return Math.round(minutes * 60_000);
	};

	const noteScenario = (reading: ScenarioReading | undefined) => {
		if (!reading) return;
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
	 */
	const endRun = (ctx: ExtensionContext, condition: EndCondition, detail: string, shutdownReason?: string): void => {
		if (ended) return;
		ended = true;
		stopTicker();

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
				// The in-game day the game decided, which is the figure a benchmark cites:
				// the wall clock says how long a machine took, this says how much scenario
				// was played. Null where the bridge never recorded one.
				endedOn: scenario?.endedOn ?? null,
			},
			elapsedMs: elapsed(),
			elapsedMinutes: Math.round((elapsed() / 60_000) * 100) / 100,
			budgetMs,
			turns,
			toolCalls,
			nudges: { ...nudges },
			model: ctx.model?.id ?? null,
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
			announce(
				ctx,
				`run ended: ${detail} (${record.elapsedMinutes} min, ${turns} turns). Record: ${logFile ?? "unavailable"}`,
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

	const checkBudget = (ctx: ExtensionContext): boolean => {
		if (ended || budgetMs <= 0 || startedAt === 0) return false;
		if (elapsed() < budgetMs) return false;
		const minutes = Math.round((budgetMs / 60_000) * 100) / 100;
		endRun(
			ctx,
			"budget_exhausted",
			`the ${minutes} minute wall-clock budget ran out with the scenario ${scenario?.status ?? "unknown"}`,
		);
		return true;
	};

	const endIfDecided = (ctx: ExtensionContext): boolean => {
		if (ended || !isDecided(scenario?.status)) return false;
		endRun(ctx, "scenario_decided", `the scenario was reported ${scenario?.status} by the game`);
		return true;
	};

	pi.on("session_start", (_event, ctx) => {
		ended = false;
		turns = 0;
		toolCalls = 0;
		scenario = undefined;
		nudges = emptyTotals();
		pollFailures = 0;
		lastPollAt = 0;
		inFlight = undefined;
		startedAt = now();
		startedAtIso = new Date(startedAt).toISOString();
		budgetMs = readBudgetMs();
		bridgeUrl = process.env.FREEPLAY_BRIDGE_URL || DEFAULT_BRIDGE_URL;
		poll = createScenarioPoller({ baseUrl: bridgeUrl, timeoutMs: POLL_TIMEOUT_MS });
		logFile = openRunEndLog(ctx.sessionManager.getSessionId());
		lastCtx = ctx;

		appendEntry(logFile, {
			event: "run_start",
			budgetMs,
			bridgeUrl,
			model: ctx.model?.id ?? null,
			sessionId: ctx.sessionManager.getSessionId(),
			timestamp: startedAtIso,
		});
		ctx.ui.setStatus(STATUS_KEY, budgetMs > 0 ? `budget ${Math.round(budgetMs / 60_000)} min` : "no budget");

		stopTicker();
		// One long turn must not be able to outlast the budget, and turn_end is the only other
		// place it is checked. Unref'd so this timer can never be the reason pi stays alive.
		ticker = setInterval(() => {
			const target = lastCtx;
			if (target) checkBudget(target);
		}, TICK_MS);
		(ticker as unknown as { unref?: () => void }).unref?.();
	});

	pi.on("turn_start", (_event, ctx) => {
		lastCtx = ctx;
	});

	// Free: when the model reads park_status itself, the flip is in the result.
	pi.on("tool_result", (event, ctx) => {
		lastCtx = ctx;
		toolCalls += 1;
		if (event.isError) return;
		noteScenario(readScenarioFromToolResult(event.content));
	});

	pi.on("turn_end", (_event, ctx) => {
		lastCtx = ctx;
		turns += 1;
		if (endIfDecided(ctx)) return;
		if (checkBudget(ctx)) return;

		// Deliberately not awaited. pi waits for this handler before the next turn starts, and
		// a poll that is merely slow — a big park, a busy game thread — must not be able to add
		// its timeout to every turn. Nobody is waiting on the answer here, so it lands when it
		// lands and ends the run then.
		void resolveScenario(false).then(() => {
			const target = lastCtx;
			if (target) endIfDecided(target);
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
		if (ended) return;

		await resolveScenario(true);
		if (endIfDecided(ctx)) return;

		const condition: EndCondition = "model_stopped";
		endRun(
			ctx,
			condition,
			`the agent loop stopped with the scenario ${scenario?.status ?? "unknown"} and nothing queued to continue it`,
		);
	});

	pi.on("session_shutdown", (event, ctx) => {
		stopTicker();
		if (ended) return;
		// Nothing above fired, so a person stopped this one. Say so in the record rather than
		// leaving a reader to infer it from a missing file.
		endRun(
			ctx,
			"interrupted",
			`pi shut down (${event.reason}) with no end condition met and the scenario ${scenario?.status ?? "unknown"}`,
			event.reason,
		);
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

			endRun(
				ctx,
				"model_stopped",
				`model stopped correctly: it ended a turn with no tool call and the scenario was already ${scenario?.status}`,
			);
			return "ended";
		})();
	});

	pi.registerCommand("run-end", {
		description: "Show the run's elapsed clock, budget and last known scenario status",
		handler: async (_args, ctx) => {
			await resolveScenario(true);
			const lines = [
				`elapsed: ${Math.round((elapsed() / 60_000) * 10) / 10} min of ${Math.round(budgetMs / 60_000)} min`,
				`turns: ${turns}, tool calls: ${toolCalls}`,
				`scenario: ${scenario?.status ?? "unknown"}${scenario ? ` (via ${scenario.source})` : ""}`,
				`bridge: ${bridgeUrl}${pollFailures > 0 ? ` — ${pollFailures} poll failures in a row` : ""}`,
				`record: ${logFile ?? "unavailable"}`,
			];
			announce(ctx, lines.join(" | "), "info");
		},
	});
}
