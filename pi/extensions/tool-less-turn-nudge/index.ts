/**
 * tool-less-turn-nudge — keep the agent loop alive when the model narrates instead of acting.
 *
 * pi's loop continues only while the assistant emits a tool call. A turn that ends in prose
 * with no tool call ends the run silently, with the model believing it is mid-plan. Measured
 * on the reconstructed request: gemma-4-26B-A4B-it-qat-5bit does this 42% of the time at the
 * turn where it matters (25/60), Qwen3.6-35B-A3B-4bit never did across ten runs. Feeding the
 * dead-end turn back with one short user message recovered a correct tool call 30/30, median
 * ~1s, 8-26 output tokens.
 *
 * Hook: `agent_end`. That event fires exactly when the loop is about to stop, and pi
 * explicitly supports queuing a continuation from it — agent-session.js `_handlePostAgentRun`
 * re-checks `agent.hasQueuedMessages()` after the event with the comment "Any messages here
 * were queued by agent_end extension handlers and need a continuation."
 *
 * Compaction cannot be reached from here: the summariser runs through
 * `compaction.js completeSummarization` -> streamFn directly and never emits agent_start /
 * turn_end / agent_end. Nothing in this file is global, so `"Summarization attempted to call
 * a tool"` is not reachable either.
 *
 * `agent_end` and `turn_end` are typed `ExtensionHandler<E>` with no result type, unlike
 * `message_end` (`MessageEndEventResult`), so a stray return value cannot replace anything.
 * Every handler below still returns undefined on purpose.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Consecutive nudges allowed before the extension stops and says so.
 *
 * One nudge recovered a tool call 30/30. A second consecutive nudge therefore means the model
 * failed to act even when told directly, which was never observed; a third is already well past
 * anything measured. Three bounds a wedge at ~3s and ~80 output tokens while leaving two
 * retries past the first unexplained failure. The counter resets to zero the moment any tool
 * runs, so this is three nudges per wedge, not three per run.
 */
const MAX_CONSECUTIVE_NUDGES = 3;

/** The measured wording. 30/30 recovery; do not edit without re-measuring. */
const NUDGE_NARRATED =
	"You described what you would do but called no tool, so nothing happened. Make that tool call now.";

/**
 * Zero-output-token responses get their own line: the measured sentence opens with "You
 * described what you would do", which is false when the model described nothing, and a small
 * model that is told something false about its own last turn has less to work with, not more.
 * Same length class and same imperative close, which is the load-bearing half. UNMEASURED —
 * the 30/30 figure does not cover this branch.
 */
const NUDGE_EMPTY = "Your last response was empty, so nothing happened. Make the next tool call now.";

const STATUS_KEY = "tool-less-nudge";
const ENTRY_TYPE = "tool-less-nudge";

type Reason = "narrated" | "empty";

interface NudgeEntry {
	event: "nudge" | "cap_reached" | "not_queued" | "runaway" | "summary";
	reason?: Reason;
	consecutive?: number;
	total?: number;
	turnPreview?: string;
	stopReason?: string;
	outputTokens?: number;
	durationMs?: number;
	byReason?: Record<Reason, number>;
	runaways?: number;
	capHits?: number;
	model?: string;
	sessionId?: string;
	timestamp: string;
}

function agentDir(): string {
	const fromEnv = process.env.PI_CODING_AGENT_DIR;
	return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".pi", "agent");
}

/** Text the model actually emitted, thinking blocks excluded. */
function visibleText(content: readonly any[]): string {
	return content
		.filter((c) => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("")
		.trim();
}

function hasToolCall(content: readonly any[]): boolean {
	return content.some((c) => c?.type === "toolCall");
}

export default function (pi: ExtensionAPI) {
	let consecutive = 0;
	let total = 0;
	let capHits = 0;
	let runaways = 0;
	const byReason: Record<Reason, number> = { narrated: 0, empty: 0 };
	let capped = false;
	let logFile: string | undefined;
	let turnStartedAt = 0;

	const log = (entry: NudgeEntry) => {
		if (!logFile) return;
		try {
			appendFileSync(logFile, `${JSON.stringify(entry)}\n`, "utf8");
		} catch {
			// A run must not die because its own log is unwritable.
		}
	};

	/** Visible without a debug flag, and without corrupting the TUI. */
	const announce = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error") => {
		if (ctx.hasUI) ctx.ui.notify(text, level);
		if (ctx.mode !== "tui") process.stderr.write(`[tool-less-nudge] ${text}\n`);
	};

	const refreshStatus = (ctx: ExtensionContext) => {
		if (capped) {
			ctx.ui.setStatus(STATUS_KEY, `nudge cap hit (${MAX_CONSECUTIVE_NUDGES}) — not nudging`);
		} else if (total > 0) {
			ctx.ui.setStatus(STATUS_KEY, `nudges ${total} (${consecutive}/${MAX_CONSECUTIVE_NUDGES} in a row)`);
		} else {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	};

	pi.on("session_start", (_event, ctx) => {
		consecutive = 0;
		total = 0;
		capHits = 0;
		runaways = 0;
		byReason.narrated = 0;
		byReason.empty = 0;
		capped = false;
		try {
			const dir = join(agentDir(), "logs", "nudges");
			mkdirSync(dir, { recursive: true });
			logFile = join(dir, `${ctx.sessionManager.getSessionId()}.jsonl`);
		} catch {
			logFile = undefined;
		}
		refreshStatus(ctx);
	});

	pi.on("turn_start", () => {
		turnStartedAt = Date.now();
	});

	// Any tool that actually ran means the model is acting again: this wedge is over.
	pi.on("turn_end", (event, ctx) => {
		if (event.toolResults.length === 0) return;
		if (consecutive === 0 && !capped) return;
		consecutive = 0;
		capped = false;
		refreshStatus(ctx);
	});

	// A human typing into a capped session re-arms it. Our own nudges must not.
	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "user") return;
		const content = event.message.content;
		const text = typeof content === "string" ? content : visibleText(content as any[]);
		if (text === NUDGE_NARRATED || text === NUDGE_EMPTY) return;
		if (consecutive === 0 && !capped) return;
		consecutive = 0;
		capped = false;
		refreshStatus(ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		const last = event.messages[event.messages.length - 1];

		// Ended on a tool result (an early-termination hint), not on prose. Not our case.
		if (!last || last.role !== "assistant") return;

		const message = last as any;
		const content: any[] = Array.isArray(message.content) ? message.content : [];

		// Belt and braces: the loop cannot end on a tool call, so if one is here, leave it alone.
		if (hasToolCall(content)) return;

		const stopReason: string = message.stopReason;
		const durationMs = turnStartedAt > 0 ? Date.now() - turnStartedAt : 0;
		const outputTokens: number = message.usage?.output ?? 0;

		// The runaway: 8,192 output tokens of "Actually, I'll call view_map(...)" over 212s.
		// Deliberately NOT nudged. The model is in a repetition loop, the loop's own output is
		// now in context making repetition likelier, and another nudge buys another cap-length
		// response at another ~3.5 minutes. Ending the run visibly is the cheaper honest answer.
		if (stopReason === "length") {
			runaways += 1;
			log({
				event: "runaway",
				stopReason,
				outputTokens,
				durationMs,
				turnPreview: visibleText(content).slice(0, 200),
				model: ctx.model?.id,
				sessionId: ctx.sessionManager.getSessionId(),
				timestamp: new Date().toISOString(),
			});
			announce(
				ctx,
				`run ended on a token-cap runaway (${outputTokens} output tokens in ${Math.round(durationMs / 1000)}s). Not nudging — see ${logFile ?? "the log"}.`,
				"error",
			);
			ctx.ui.setStatus(STATUS_KEY, "token-cap runaway — run ended");
			return;
		}

		// "aborted" is Ctrl+C, "error" is a failed request, "deferred" is a provider batch.
		// None of them is a model that narrated instead of acting.
		if (stopReason !== "stop") return;

		const text = visibleText(content);
		const reason: Reason = text.length === 0 ? "empty" : "narrated";
		const nudge = reason === "empty" ? NUDGE_EMPTY : NUDGE_NARRATED;

		if (consecutive >= MAX_CONSECUTIVE_NUDGES) {
			if (!capped) {
				capped = true;
				capHits += 1;
				log({
					event: "cap_reached",
					reason,
					consecutive,
					total,
					stopReason,
					turnPreview: text.slice(0, 200),
					model: ctx.model?.id,
					sessionId: ctx.sessionManager.getSessionId(),
					timestamp: new Date().toISOString(),
				});
				pi.appendEntry<NudgeEntry>(ENTRY_TYPE, {
					event: "cap_reached",
					reason,
					consecutive,
					total,
					timestamp: new Date().toISOString(),
				});
				announce(
					ctx,
					`${MAX_CONSECUTIVE_NUDGES} nudges in a row and still no tool call — the model is wedged. Run stopped; ${total} nudges total this session.`,
					"error",
				);
				refreshStatus(ctx);
			}
			return;
		}

		consecutive += 1;
		total += 1;
		byReason[reason] += 1;

		log({
			event: "nudge",
			reason,
			consecutive,
			total,
			stopReason,
			outputTokens,
			durationMs,
			turnPreview: text.slice(0, 200),
			model: ctx.model?.id,
			sessionId: ctx.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
		});
		pi.appendEntry<NudgeEntry>(ENTRY_TYPE, {
			event: "nudge",
			reason,
			consecutive,
			total,
			turnPreview: text.slice(0, 200),
			timestamp: new Date().toISOString(),
		});
		announce(ctx, `nudge ${total} (${reason}, ${consecutive}/${MAX_CONSECUTIVE_NUDGES} in a row)`, "warning");
		refreshStatus(ctx);

		pi.sendUserMessage(nudge, { deliverAs: "followUp" });

		// sendUserMessage is fire-and-forget (agent-session.js bindCore swallows the promise),
		// and _handlePostAgentRun reads the follow-up queue the instant this handler returns.
		// Wait for the push to land so a missed continuation is loud rather than a silent stop.
		for (let i = 0; i < 100 && !ctx.hasPendingMessages(); i++) {
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		if (!ctx.hasPendingMessages()) {
			log({
				event: "not_queued",
				reason,
				consecutive,
				total,
				sessionId: ctx.sessionManager.getSessionId(),
				timestamp: new Date().toISOString(),
			});
			announce(ctx, "the nudge was never queued — the run has stopped anyway.", "error");
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		log({
			event: "summary",
			total,
			byReason: { ...byReason },
			runaways,
			capHits,
			model: ctx.model?.id,
			sessionId: ctx.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
		});
	});

	pi.registerCommand("nudges", {
		description: "Show how many tool-less turns were nudged this run",
		handler: async (_args, ctx) => {
			const lines = [
				`nudges: ${total} (narrated ${byReason.narrated}, empty ${byReason.empty})`,
				`consecutive: ${consecutive}/${MAX_CONSECUTIVE_NUDGES}${capped ? " — CAPPED, not nudging" : ""}`,
				`token-cap runaways (not nudged): ${runaways}`,
				`log: ${logFile ?? "unavailable"}`,
			];
			announce(ctx, lines.join(" | "), total > 0 ? "warning" : "info");
		},
	});
}
