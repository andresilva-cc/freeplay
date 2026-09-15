/**
 * The run-end record: the artifact a benchmark result cites.
 *
 * Deliberately boring and fully populated. Every field is either measured or explicitly
 * absent; nothing is inferred at read time, because the reader will be a person a year from
 * now trying to work out whether a number is citable. In particular `condition` always says
 * what stopped the run, including when the answer is "a human did", which is the case that
 * makes a result uncitable and so is the one that must not be silent.
 *
 * TWO BUDGETS, TWO CONDITIONS, AND THEY ARE NOT THE SAME EVENT. `game_days_exhausted` is a
 * run that played the scenario out to its budget: it spent the game days it was given, and
 * the guests, cash and rating in the record are what that much scenario produced.
 * `wall_clock_exhausted` is a run that was abandoned by the safety net — wedged, or a model
 * that never called `wait` — and it says nothing about how good a player the model is. A
 * single `budget_exhausted` used to mean the second while being read as the first. Records
 * written before that split carry the old name; it always meant wall clock.
 *
 * WHAT A SNAPSHOT IS FOR. `startState` and `endState` are where the park stood when the run
 * began and when it stopped, so that two runs that both ran out of budget can be compared at
 * all. They degrade rather than fail: a bridge that will not answer leaves blocks null and
 * says why in `note`. A missing number is never a zero.
 *
 * Written as JSONL to AGENT_DIR/logs/run-end/<sessionId>.jsonl. AGENT_DIR is the repo's own
 * pi/ directory during a run (scripts/run.sh exports PI_CODING_AGENT_DIR), so the file lands
 * in pi/logs/run-end/ — which, unlike the rest of pi/logs, is tracked: it is the artifact a
 * published result cites, and a result nobody else can read is not one.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DateReading } from "./gameTime.ts";
import type { BridgeSnapshot } from "./snapshot.ts";
import type { GameDay, ScenarioReading } from "./scenario.ts";

/** Why the run stopped. */
export type EndCondition =
	/** scenario.status became completed or failed. */
	| "scenario_decided"
	/** The game-day budget ran out: the run played the scenario as far as it was given. */
	| "game_days_exhausted"
	/** The wall-clock safety net ran out with game days still unspent. Not a played-out run. */
	| "wall_clock_exhausted"
	/** The model ended a turn with no tool call and no sign of reaching for one. */
	| "model_stopped"
	/** Nothing above fired: Ctrl+C, /quit, or a session switch. Not a result. */
	| "interrupted";

export interface NudgeTotals {
	total: number;
	narrated: number;
	empty: number;
	declined: number;
	capHits: number;
	runaways: number;
}

/**
 * How much scenario the run spent, and how that was worked out.
 *
 * `source` is part of the measurement. `date` is the in-game date at the end minus the one
 * at the start, which is the true figure and needs the bridge to have answered at both ends.
 * `since_last_call` is the fallback: the bridge bills every tool result with
 * `gameDaysSinceLastCall`, so summing those covers the whole run from its first call without
 * needing a baseline — it misses only whatever moved before that first call.
 * `unmeasured` means neither was available and `spent` is null, which is why a run can end
 * on the wall clock having never been able to check the game-day budget at all.
 */
export interface GameDayAccount {
	/** Game days this run spent, or null where nothing could measure it. */
	spent: number | null;
	source: "date" | "since_last_call" | "unmeasured";
	/** The budget `spent` was measured against, in game days. 0 means no game-day budget. */
	budget: number;
	/** Game days bought deliberately with `wait`, as `wait` itself measured them. */
	inWait: number;
	/** How many `wait` calls that was. */
	waitCalls: number;
	/** The in-game date the run began on, where the bridge answered at the start. */
	startedOn: DateReading | null;
	/** The furthest in-game date the run reached. */
	reachedOn: DateReading | null;
}

/**
 * The model as pi describes it to an extension.
 *
 * Sampling parameters are here because a run was once compared against parameters it never
 * had: Gemma was judged beside Qwen while carrying neither its `presence_penalty` nor its
 * reasoning setting (commit c32a402). A field that is null means pi did not expose it to the
 * extension — NOT that the model ran without it.
 */
export interface ModelParams {
	name: string | null;
	provider: string | null;
	reasoning: boolean | null;
	contextWindow: number | null;
	maxTokens: number | null;
	samplingParams: Record<string, unknown> | null;
}

export interface RunEndRecord {
	event: "run_end";
	condition: EndCondition;
	/** One plain sentence naming what happened, for a human reading the file. */
	detail: string;
	scenario: {
		status: ScenarioReading["status"] | "unknown";
		name: string | null;
		objective: unknown;
		source: ScenarioReading["source"] | "unknown";
		observedAt: string | null;
		/** The in-game day the game decided, as the bridge recorded it. Null where it did not. */
		endedOn: GameDay | null;
	};
	/** The budget that actually measures the run. */
	gameDays: GameDayAccount;
	elapsedMs: number;
	elapsedMinutes: number;
	/** The safety net, not the budget. 0 means it was disabled. */
	wallClockBudgetMs: number;
	turns: number;
	toolCalls: number;
	nudges: NudgeTotals;
	model: string | null;
	modelParams: ModelParams | null;
	/** Where the park stood when the run began. Null when the run never got a snapshot at all. */
	startState: BridgeSnapshot | null;
	/** Where it stood when the run stopped. */
	endState: BridgeSnapshot | null;
	sessionId: string;
	startedAt: string;
	endedAt: string;
	/** Present only when the run ended because a session was replaced or pi quit. */
	shutdownReason?: string;
	timestamp: string;
}

export interface RunStartEntry {
	event: "run_start";
	/** The game-day budget. 0 means it was disabled. */
	gameDayBudget: number;
	/** The wall-clock safety net, in milliseconds. 0 means it was disabled. */
	wallClockBudgetMs: number;
	bridgeUrl: string;
	model: string | null;
	modelParams: ModelParams | null;
	sessionId: string;
	timestamp: string;
}

/**
 * Where the park stood at the start, written on its own line because it arrives a moment
 * after `run_start` does: the snapshot is three HTTP reads and the session must not wait on
 * them. The same snapshot is carried in the run_end record as `startState`.
 */
export interface RunStartStateEntry {
	event: "run_start_state";
	state: BridgeSnapshot;
	elapsedMs: number;
	timestamp: string;
}

export interface ScenarioEntry {
	event: "scenario_status";
	status: ScenarioReading["status"];
	source: ScenarioReading["source"];
	name?: string;
	elapsedMs: number;
	timestamp: string;
}

export interface PollFailedEntry {
	event: "poll_failed";
	error: string;
	consecutiveFailures: number;
	elapsedMs: number;
	timestamp: string;
}

export type RunEndLogEntry =
	| RunEndRecord
	| RunStartEntry
	| RunStartStateEntry
	| ScenarioEntry
	| PollFailedEntry;

export function agentDir(): string {
	const fromEnv = process.env.PI_CODING_AGENT_DIR;
	return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".pi", "agent");
}

/** Returns the log path, or undefined when the directory cannot be made. */
export function openRunEndLog(sessionId: string): string | undefined {
	try {
		const dir = join(agentDir(), "logs", "run-end");
		mkdirSync(dir, { recursive: true });
		return join(dir, `${sessionId}.jsonl`);
	} catch {
		return undefined;
	}
}

export function appendEntry(logFile: string | undefined, entry: RunEndLogEntry): void {
	if (!logFile) return;
	try {
		appendFileSync(logFile, `${JSON.stringify(entry)}\n`, "utf8");
	} catch {
		// A run must not die because its own log is unwritable.
	}
}
