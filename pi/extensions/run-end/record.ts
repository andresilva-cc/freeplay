/**
 * The run-end record: the artifact a benchmark result cites.
 *
 * Deliberately boring and fully populated. Every field is either measured or explicitly
 * absent; nothing is inferred at read time, because the reader will be a person a year from
 * now trying to work out whether a number is citable. In particular `condition` always says
 * what stopped the run, including when the answer is "a human did", which is the case that
 * makes a result uncitable and so is the one that must not be silent.
 *
 * Written as JSONL to AGENT_DIR/logs/run-end/<sessionId>.jsonl, alongside the nudge logs.
 * AGENT_DIR is the repo's own pi/ directory during a run (scripts/run.sh exports
 * PI_CODING_AGENT_DIR), so the file lands in pi/logs/run-end/ and is gitignored with the rest.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ScenarioReading } from "./scenario.ts";

/** Why the run stopped. */
export type EndCondition =
	/** scenario.status became completed or failed. */
	| "scenario_decided"
	/** The wall-clock budget ran out. */
	| "budget_exhausted"
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
	};
	elapsedMs: number;
	elapsedMinutes: number;
	budgetMs: number;
	turns: number;
	toolCalls: number;
	nudges: NudgeTotals;
	model: string | null;
	sessionId: string;
	startedAt: string;
	endedAt: string;
	/** Present only when the run ended because a session was replaced or pi quit. */
	shutdownReason?: string;
	timestamp: string;
}

export interface RunStartEntry {
	event: "run_start";
	budgetMs: number;
	bridgeUrl: string;
	model: string | null;
	sessionId: string;
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

export type RunEndLogEntry = RunEndRecord | RunStartEntry | ScenarioEntry | PollFailedEntry;

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
