/**
 * The contract between tool-less-turn-nudge and run-end.
 *
 * pi gives every extension the same EventBus on `pi.events`, and that is the only channel
 * between two extensions that is actually shared: extensions are loaded through separate jiti
 * instances with `moduleCache: false`, so an imported module is evaluated once per importer
 * and a module-level singleton would NOT be shared state.
 *
 * `emit` is `EventEmitter.emit`, so every subscriber's handler body runs synchronously up to
 * its first `await` before `emit` returns. STOPPED_TURN relies on exactly that: run-end
 * assigns `request.decision` synchronously, and the nudge awaits the promise afterwards. A
 * nudge running without run-end loaded sees `decision` still undefined and falls back to its
 * own judgement, which is the behaviour to preserve if either extension is ever removed.
 */

import type { ScenarioStatus } from "./scenario.ts";

/** Nudge -> run-end. Counts, so the nudge total lands in the run-end record. */
export const NUDGE_CHANNEL = "freeplay/run-end/nudge";

/** Nudge -> run-end, request/reply. "The model stopped; is this run over?" */
export const STOPPED_TURN_CHANNEL = "freeplay/run-end/stopped-turn";

export interface NudgeTelemetry {
	/** "nudge" was sent, "declined" was a stopped turn we chose not to nudge. */
	event: "nudge" | "declined" | "cap_reached" | "runaway";
	reason?: "narrated" | "empty";
	total: number;
	consecutive: number;
}

export type StopVerdict =
	/** run-end has ended the run. Do not nudge. */
	| "ended"
	/** The scenario is still running, or nothing could resolve it. The nudge decides. */
	| "undecided";

export interface StoppedTurnRequest {
	/** First 200 characters of what the model said, for the log. */
	turnPreview: string;
	/** Set synchronously by run-end. Undefined means run-end is not loaded. */
	decision?: Promise<StopVerdict>;
	/** Set by run-end alongside `decision`, for the nudge's own log line. */
	statusAtRequest?: ScenarioStatus | "unknown";
}
