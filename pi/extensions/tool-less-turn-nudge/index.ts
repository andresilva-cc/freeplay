/**
 * tool-less-turn-nudge — keep the agent loop alive when the model narrates instead of acting.
 *
 * pi's loop continues only while the assistant emits a tool call. A turn that ends in prose
 * with no tool call ends the run silently, with the model believing it is mid-plan.
 *
 * HOW OFTEN, from play rather than from a bench. Every figure below is printed by
 * `node pi/extensions/run-end/census.mjs`, which reads pi/sessions and is committed next to
 * this file so it can be re-run instead of believed. Across 19 sessions and 593 assistant
 * turns there are 23 tool-less turns: 11 are Ctrl+C aborts, 1 is a failed request, 2 are
 * token-cap runaways, leaving 9 where the model really did stop with something to say.
 *
 * That 9 — tool-less AND stopReason "stop", the model choosing to say something instead of
 * acting — is the only population quoted as a rate for a model anywhere in this repository:
 * gemma-4-26B-A4B-it-qat-5bit accounts for 7 of it in 58 assistant turns over 4 sessions
 * (12.1%); Qwen3.6-35B-A3B-4bit for 2 in 535 turns over 15 sessions (0.4%).
 * reasoning-placeholder/index.ts quotes the same two figures from the same script. Counting
 * every tool-less turn whatever stopped it instead gives 8/58 and 15/535, which census.mjs
 * also prints and which neither file quotes: ten of Qwen's fifteen are a human pressing
 * Ctrl+C, so that population measures the operator rather than the model.
 *
 * (The numbers that used to stand here — 42%, 25/60, 30/30, and "Qwen never did across ten
 * runs" — are gone. None was reproducible from this repository: 25/60 was 60 resamples of one
 * reconstructed request rather than 60 turns of play, and Qwen did it twice in 15 runs, not
 * never in 10.)
 *
 * DOES THE NUDGE WORK. Two nudges have ever been sent during play and both were followed by a
 * tool call, which is all the evidence there is; the census script counts them. One of those
 * two should never have been sent — see the gate below.
 *
 * WHAT IT WILL NOT DO NOW. Of the 9 real cases, 5 show the model reaching for a tool (unparsed
 * tool-call markup, or a tool named in the text or the thinking) and 4 show nothing of the
 * kind. One of those 4 was a correct terminal post-mortem — "I failed the Forest Frontiers
 * scenario... Key mistakes that led to failure:" — and the nudge told it to carry on playing;
 * the forced park_status that followed came back "failed", so the model had been right. A turn
 * with no such sign is therefore handed to the run-end extension first: if the scenario is
 * already decided the run ends and the record says the model stopped correctly. If it is not
 * decided the nudge is sent anyway, because the other 3 of those 4 are plainly mid-plan ("I'll
 * list the available ride objects to see what our options are") and stopping the run on them
 * would call a narration failure a decision.
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
 *
 * THIS IS A HARNESS INTERVENTION: it puts a user message into the conversation that no human
 * typed. It is always armed — there is no flag — so every run-end record names it, with the
 * count it sent. See ../run-end/interventions.ts.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NUDGE_CHANNEL, STOPPED_TURN_CHANNEL } from "../run-end/channels.ts";
import type { NudgeTelemetry, StoppedTurnRequest, StopVerdict } from "../run-end/channels.ts";
import { announceIntervention, answerInterventionCensus, type InterventionReport } from "../run-end/interventions.ts";
import { BRIDGE_TOOLS, detectToolCallSignal, hasToolCall, thinkingText, visibleText } from "../run-end/signals.ts";

/**
 * Consecutive nudges allowed before the extension stops and says so.
 *
 * Both nudges ever sent in play were followed by a tool call, so a second consecutive nudge
 * means the model failed to act even when told directly, which has not been seen; a third is
 * past anything observed at all. Three bounds a wedge at a few seconds and well under a
 * hundred output tokens while leaving two retries past the first unexplained failure. The
 * counter resets to zero the moment any tool runs, so this is three nudges per wedge, not
 * three per run.
 */
const MAX_CONSECUTIVE_NUDGES = 3;

/**
 * The wording that has been used in play. Two sends, two tool calls after — which is a
 * direction, not a measurement, so treat a reword as untested rather than as a regression.
 */
const NUDGE_NARRATED =
	"You described what you would do but called no tool, so nothing happened. Make that tool call now.";

/**
 * Zero-output-token responses get their own line: the sentence above opens with "You described
 * what you would do", which is false when the model described nothing, and a small model that
 * is told something false about its own last turn has less to work with, not more. Same length
 * class and same imperative close, which is the load-bearing half. Never sent in a recorded
 * run, so nothing at all is known about this one.
 */
const NUDGE_EMPTY = "Your last response was empty, so nothing happened. Make the next tool call now.";

const STATUS_KEY = "tool-less-nudge";
const ENTRY_TYPE = "tool-less-nudge";

/** The directory this extension lives in, which is how the run-end record names it. */
const INTERVENTION_ID = "tool-less-turn-nudge";

/**
 * How long to wait for run-end's verdict on a stopped turn before nudging anyway.
 *
 * The verdict costs one park_status over loopback. If the bridge is wedged, waiting longer
 * than this buys nothing: the fallback is the behaviour this extension had before run-end
 * existed, which is a safe place to land.
 */
const VERDICT_TIMEOUT_MS = 20_000;

type Reason = "narrated" | "empty";

interface NudgeEntry {
	event: "nudge" | "declined" | "cap_reached" | "not_queued" | "runaway" | "summary";
	reason?: Reason;
	consecutive?: number;
	total?: number;
	declined?: number;
	turnPreview?: string;
	stopReason?: string;
	outputTokens?: number;
	durationMs?: number;
	scenarioStatus?: string;
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

export default function (pi: ExtensionAPI) {
	let consecutive = 0;
	let total = 0;
	let capHits = 0;
	let runaways = 0;
	let declined = 0;
	const byReason: Record<Reason, number> = { narrated: 0, empty: 0 };
	let capped = false;
	let logFile: string | undefined;
	let turnStartedAt = 0;

	/** The live tool list when pi will give it, the bridge's own list when it will not. */
	const toolNames = (): readonly string[] => {
		try {
			const active = pi.getActiveTools();
			return active.length > 0 ? active : BRIDGE_TOOLS;
		} catch {
			return BRIDGE_TOOLS;
		}
	};

	/**
	 * What this extension tells the run-end record it did. It has no flag and no env var: being
	 * loaded is being armed, so `armed` is unconditionally true and the count is what separates
	 * a run it touched from one it merely watched.
	 */
	const describeIntervention = (): InterventionReport => ({
		id: INTERVENTION_ID,
		armed: true,
		how: "always on when the extension is loaded; it has no flag and no env var",
		fired: total,
		detail:
			total === 0
				? "loaded and able to insert a user message on a tool-less turn; it did not fire in this run"
				: `inserted ${total} user message(s) telling the model to make a tool call` +
					` (${byReason.narrated} after prose, ${byReason.empty} after an empty response)`,
	});

	answerInterventionCensus(pi.events, describeIntervention);

	/** Counts for the run-end record. Never allowed to break a run. */
	const report = (telemetry: NudgeTelemetry) => {
		try {
			pi.events.emit(NUDGE_CHANNEL, telemetry);
		} catch {
			// run-end is not loaded, or the bus is gone. Neither is fatal here.
		}
	};

	/**
	 * "The model stopped with no sign of reaching for a tool. Is the run over?"
	 *
	 * run-end answers, and ends the run itself when the scenario is already decided. Anything
	 * that goes wrong — run-end not loaded, a bridge that will not answer, a slow verdict —
	 * comes back "undecided", which is this extension's behaviour from before run-end existed.
	 */
	const askRunEnd = async (request: StoppedTurnRequest): Promise<StopVerdict> => {
		try {
			pi.events.emit(STOPPED_TURN_CHANNEL, request);
		} catch {
			return "undecided";
		}
		if (!request.decision) return "undecided";

		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				request.decision,
				new Promise<StopVerdict>((resolve) => {
					timer = setTimeout(() => resolve("undecided"), VERDICT_TIMEOUT_MS);
					(timer as unknown as { unref?: () => void }).unref?.();
				}),
			]);
		} catch {
			return "undecided";
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	};

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
		declined = 0;
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
		announceIntervention(pi.events, describeIntervention());
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
			report({ event: "runaway", total, consecutive });
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

		// The gate. A turn with no unparsed tool-call markup and no tool named in its text or
		// thinking is the one shape that has ever been nudged wrongly, so it is not decided
		// here: run-end resolves the scenario and ends the run if the game has already called
		// it. The 5 of 9 recorded cases that DO carry a sign skip this entirely and are nudged
		// exactly as before, with no bridge call and no wait.
		const signal = detectToolCallSignal(text, thinkingText(content), toolNames());
		if (signal.kind === "none") {
			const request: StoppedTurnRequest = { turnPreview: text.slice(0, 200) };
			const verdict = await askRunEnd(request);

			if (verdict === "ended") {
				declined += 1;
				const entry: NudgeEntry = {
					event: "declined",
					reason,
					consecutive,
					total,
					declined,
					stopReason,
					outputTokens,
					durationMs,
					scenarioStatus: request.statusAtRequest ?? "unknown",
					turnPreview: text.slice(0, 200),
					model: ctx.model?.id,
					sessionId: ctx.sessionManager.getSessionId(),
					timestamp: new Date().toISOString(),
				};
				log(entry);
				pi.appendEntry<NudgeEntry>(ENTRY_TYPE, {
					event: "declined",
					reason,
					total,
					declined,
					scenarioStatus: request.statusAtRequest ?? "unknown",
					turnPreview: text.slice(0, 200),
					timestamp: new Date().toISOString(),
				});
				report({ event: "declined", reason, total, consecutive });
				announce(ctx, "model stopped correctly — the scenario is already decided. Not nudging; run-end has the run.", "info");
				ctx.ui.setStatus(STATUS_KEY, "model stopped correctly");
				return;
			}
		}

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
				report({ event: "cap_reached", reason, total, consecutive });
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
		report({ event: "nudge", reason, total, consecutive });
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
			declined,
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
				`stopped turns left alone (scenario already decided): ${declined}`,
				`token-cap runaways (not nudged): ${runaways}`,
				`log: ${logFile ?? "unavailable"}`,
			];
			announce(ctx, lines.join(" | "), total > 0 ? "warning" : "info");
		},
	});
}
