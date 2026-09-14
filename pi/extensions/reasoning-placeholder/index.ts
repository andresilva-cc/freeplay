/**
 * reasoning-placeholder — put a thought back on the wire so the model stops imitating its absence.
 *
 * OFF BY DEFAULT, and the reason is at the bottom of this comment. Read that before enabling it.
 *
 * THE DEFECT, in one loop. gemma-4-26B-A4B-it-qat-5bit marks reasoning with a special token
 * followed by the literal header word: `<|channel>thought\n…<channel|>`. Its chat template
 * re-renders a previous turn's reasoning only when that assistant message carries BOTH a
 * non-empty `reasoning`/`reasoning_content` AND `tool_calls` — chat_template.jinja lines
 * 237-241 in the model directory under ~/.omlx/models:
 *
 *     {%- set thinking_text = message.get('reasoning') or message.get('reasoning_content') -%}
 *     {%- if thinking_text and loop.index0 > ns_turn.last_user_idx and message.get('tool_calls') -%}
 *         {{- '<|channel>thought\n' + thinking_text + '\n<channel|>' -}}
 *
 * Turn 1 of every Gemma session is a bare park_status call with no reasoning, so nothing
 * renders as a thought channel in the next prompt. The model imitates what it sees and writes
 * the bare word `thought` as ordinary text; oMLX's channel splitter never opens the reasoning
 * channel, so the header and the whole chain of reasoning land in `content`; pi records the
 * thinking block as "\n"; pi-ai's `nonEmptyThinkingBlocks` filter (openai-completions.js near
 * line 980) drops a whitespace-only block, so no reasoning goes back out; and the next prompt
 * again shows no thought channel. Measured over the recorded sessions by probe.mjs: 14 of 58
 * Gemma assistant turns carry the leaked `thought` header and 8 of 58 end with no tool call at
 * all, against 15 of 535 for Qwen — and a turn whose reasoning is prose in the answer channel
 * sometimes just finishes the prose and stops, which ends the run.
 *
 * WHAT THIS DOES. On the outgoing request, an assistant message that has tool_calls and no
 * non-empty reasoning field gets `reasoning_content` set to a short placeholder, which is
 * enough for the template's `if` to fire.
 *
 * WHAT DOES NOT WORK, previously verified live, so that nobody retries them:
 * `chat_template_kwargs: {"enable_thinking": true}` makes it worse (1538 characters of prose,
 * zero tool calls); pi's `thinkingFormat: "qwen-chat-template"` would turn thinking off
 * entirely given this repo's `supportsReasoningEffort: false`; and pi's
 * `requiresReasoningContentOnAssistantMessages` sets `reasoning_content: ""`, which is falsy
 * in Jinja and so never triggers the render.
 *
 * THE HOOK. `before_provider_request`, which is the only hook in pi 0.85.1 that can change an
 * outgoing request. sdk.js wires it to pi-ai's `onPayload`, which runs on the fully built
 * request body immediately before the HTTP call (openai-completions.js `buildParams`, then
 * `await options?.onPayload?.(params, model)`), and runner.js `emitBeforeProviderRequest`
 * replaces the payload with any non-undefined return. `context` is the only other candidate
 * and comes too early: it carries pi's own AgentMessage[], where the same whitespace-only
 * thinking block would be filtered out again downstream. Because the result type is `unknown`,
 * ANY non-undefined return replaces the payload — so every path below that changes nothing
 * returns undefined explicitly.
 *
 * THE GATE: the observed condition, not the model id. This fires only on an assistant message
 * that has tool_calls and no reasoning, which is the defect's own precondition. It is a no-op
 * for Qwen not by name but by arithmetic: across the recorded sessions all 520 of
 * Qwen3.6-35B-A3B-4bit's 520 tool-calling assistant turns carry non-empty thinking, so the
 * condition is never met; 44 of Gemma's 50 do not. A model-id gate would have been a per-model
 * harness intervention, which is the thing that contaminated a cross-model comparison once
 * already. The log names the model on every substitution anyway, so a published result can
 * still say exactly what was touched and how often.
 *
 * Applied to EVERY qualifying assistant message, not only the ones after the last user message
 * that the template actually renders. Deliberate: the substitution has to be a pure function
 * of the message, or the same message would carry a placeholder on one request and lose it on
 * the next — a nudge inserting a user message moves `last_user_idx` — which would invalidate
 * the provider's prompt-cache prefix every time. A placeholder on a message the template
 * ignores costs about six tokens and renders nothing.
 *
 * ================================================================================
 * WHY IT IS OFF BY DEFAULT: the oMLX build in front of this model throws the field away.
 *
 * `node pi/extensions/reasoning-placeholder/probe.mjs --passthrough` sends three near-identical
 * 56-token requests and prints the prompt_tokens the server reports. With no reasoning field:
 * 56. With `reasoning_content` set to five hundred words: 56. With `content` set to the same
 * five hundred words: 1001. The same three-way result holds on the full 15,293-token Freeplay
 * prompt. oMLX's own OpenAPI schema declares `reasoning_content` on its Message model, so the
 * request is accepted — and then the field never reaches the chat template. `reasoning`,
 * `reasoning_text`, `thinking` and `thought` are all dropped the same way.
 *
 * So the substitution is real on pi's side and renders correctly when the template is run over
 * it directly (0 thought channels before, 2 after), and it currently changes nothing the model
 * sees. Replaying the exact failing prefix of session 01a09370 thirty times per arm against
 * the live server says the same thing from the other end: the `thought` header leaked in 17 of
 * 30 without the placeholder and 19 of 30 with it, and a tool call followed in 22 of 30 against
 * 19 of 30. That is one distribution sampled twice, which is what it must be if the two
 * requests reach the model identically.
 *
 * This is therefore a fix that is correct and inert. It is committed rather than dropped
 * because the pi-side half is the hard half and is proven, and because the server half is one
 * upstream change away. Enable it with `--reasoning-placeholder` or
 * FREEPLAY_REASONING_PLACEHOLDER=1, and only after `probe.mjs --passthrough` shows a prompt
 * that grows — otherwise a run would carry an intervention that a published result would have
 * to disclose and that did nothing to earn the disclosure.
 * ================================================================================
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PLACEHOLDER_CHANNEL, type PlaceholderTelemetry } from "./channels.ts";

/**
 * What the model is shown as its own previous thought.
 *
 * This goes into the context as something it appears to have thought, so it is a structural
 * marker and nothing else: no strategy, no instruction, no game noun, nothing to imitate as a
 * plan. Chosen for four reasons.
 *
 *   1. It is non-empty and not whitespace, which is the whole mechanical requirement — Jinja
 *      treats "" as falsy, and pi's own `requiresReasoningContentOnAssistantMessages` already
 *      proved that an empty string does nothing here.
 *   2. It is true. pi recorded no reasoning for that turn; the placeholder says so.
 *   3. Parenthesised and lower-case, so it reads as an editorial marker rather than as a
 *      sentence the model produced. If the model imitates it, it imitates an empty thought,
 *      which is the regime this repo runs in anyway (thinkingLevel is "off").
 *   4. Short: 23 characters, about six tokens per assistant message.
 *
 * Rewording it is untested, and so is the text itself in the only sense that matters — see the
 * block above. Nothing about the behaviour of ANY placeholder string has been established
 * against a server that forwards the field.
 */
const PLACEHOLDER = "(no reasoning recorded)";

/**
 * The fields pi-ai will accept as reasoning on an outgoing assistant message
 * (OPENAI_COMPLETIONS_REASONING_FIELDS, openai-completions.js line 155). A message carrying
 * any of them non-empty is already fine and is not touched.
 */
const REASONING_FIELDS = ["reasoning", "reasoning_content", "reasoning_text"] as const;

const STATUS_KEY = "reasoning-placeholder";
const ENTRY_TYPE = "reasoning-placeholder";
const FLAG_ENABLE = "reasoning-placeholder";
const ENV_ENABLE = "FREEPLAY_REASONING_PLACEHOLDER";

interface WireMessage {
	role?: unknown;
	tool_calls?: unknown;
	reasoning_details?: unknown;
	[key: string]: unknown;
}

interface PlaceholderEntry {
	event: "armed" | "substituted" | "summary";
	enabled: boolean;
	/** Messages changed by this one request. Absent except on "substituted". */
	changed?: number;
	/** Running totals for the session. */
	substitutions: number;
	requests: number;
	placeholder?: string;
	model?: string | null;
	sessionId?: string;
	timestamp: string;
}

function agentDir(): string {
	const fromEnv = process.env.PI_CODING_AGENT_DIR;
	return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".pi", "agent");
}

function hasReasoning(message: WireMessage): boolean {
	if (message.reasoning_details !== undefined && message.reasoning_details !== null) return true;
	for (const field of REASONING_FIELDS) {
		const value = message[field];
		if (typeof value === "string" && value.trim().length > 0) return true;
	}
	return false;
}

/** An assistant message that made a tool call and shows no reasoning: the defect's own shape. */
function needsPlaceholder(message: unknown): message is WireMessage {
	if (!message || typeof message !== "object") return false;
	const m = message as WireMessage;
	if (m.role !== "assistant") return false;
	if (!Array.isArray(m.tool_calls) || m.tool_calls.length === 0) return false;
	return !hasReasoning(m);
}

export interface SubstitutionResult {
	/** The payload to send. The same object it was given when nothing qualified. */
	payload: unknown;
	changed: number;
}

/**
 * Pure. Returns a new payload with new message objects for the ones it changed, so nothing pi
 * still holds a reference to is mutated; untouched messages are passed through by reference.
 */
export function substituteReasoning(payload: unknown, placeholder: string = PLACEHOLDER): SubstitutionResult {
	if (!payload || typeof payload !== "object") return { payload, changed: 0 };
	const body = payload as { messages?: unknown };
	if (!Array.isArray(body.messages)) return { payload, changed: 0 };

	let changed = 0;
	const messages = body.messages.map((message) => {
		if (!needsPlaceholder(message)) return message;
		changed += 1;
		return { ...(message as WireMessage), reasoning_content: placeholder };
	});

	if (changed === 0) return { payload, changed: 0 };
	return { payload: { ...(payload as Record<string, unknown>), messages }, changed };
}

/** True only when somebody asked for it. See the block at the top of this file. */
export function isEnabled(flag: boolean | string | undefined, env: string | undefined): boolean {
	if (flag === true) return true;
	if (typeof flag === "string" && flag.length > 0 && flag !== "false" && flag !== "0") return true;
	if (env === undefined) return false;
	return ["1", "true", "yes", "on"].includes(env.trim().toLowerCase());
}

export default function (pi: ExtensionAPI) {
	let enabled = false;
	let substitutions = 0;
	let requests = 0;
	let logFile: string | undefined;

	pi.registerFlag(FLAG_ENABLE, {
		type: "boolean",
		description: `Substitute a placeholder reasoning_content on assistant tool-call messages (default off; also ${ENV_ENABLE}=1)`,
	});

	const log = (entry: PlaceholderEntry) => {
		if (!logFile) return;
		try {
			appendFileSync(logFile, `${JSON.stringify(entry)}\n`, "utf8");
		} catch {
			// A run must not die because its own log is unwritable.
		}
	};

	/** Counts for whatever is listening. Never allowed to break a request. */
	const report = (event: PlaceholderTelemetry["event"], model: string | null) => {
		try {
			pi.events.emit(PLACEHOLDER_CHANNEL, {
				event,
				enabled,
				substitutions,
				requests,
				model,
			} satisfies PlaceholderTelemetry);
		} catch {
			// Nobody is subscribed, or the bus is gone. Neither is fatal here.
		}
	};

	pi.on("session_start", (_event, ctx) => {
		substitutions = 0;
		requests = 0;
		enabled = isEnabled(pi.getFlag(FLAG_ENABLE), process.env[ENV_ENABLE]);
		try {
			const dir = join(agentDir(), "logs", "reasoning-placeholder");
			mkdirSync(dir, { recursive: true });
			logFile = join(dir, `${ctx.sessionManager.getSessionId()}.jsonl`);
		} catch {
			logFile = undefined;
		}

		// Written whether or not it is on, so that a run with no substitutions says which of
		// the two reasons it had: switched off, or switched on and never triggered.
		log({
			event: "armed",
			enabled,
			substitutions: 0,
			requests: 0,
			placeholder: PLACEHOLDER,
			model: ctx.model?.id ?? null,
			sessionId: ctx.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
		});
		ctx.ui.setStatus(STATUS_KEY, enabled ? "reasoning placeholder on" : undefined);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled) return undefined;

		let result: SubstitutionResult;
		try {
			result = substituteReasoning(event.payload);
		} catch {
			// A malformed payload is not worth losing a turn over. Send it untouched.
			return undefined;
		}

		// Nothing qualified: this model, or this point in this run, does not have the defect.
		// Returning undefined leaves pi's own payload object in place.
		if (result.changed === 0) return undefined;

		substitutions += result.changed;
		requests += 1;
		const model = ctx.model?.id ?? null;

		log({
			event: "substituted",
			enabled,
			changed: result.changed,
			substitutions,
			requests,
			placeholder: PLACEHOLDER,
			model,
			sessionId: ctx.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
		});
		report("substituted", model);
		ctx.ui.setStatus(STATUS_KEY, `reasoning placeholders ${substitutions} in ${requests} requests`);

		return result.payload;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const model = ctx.model?.id ?? null;
		log({
			event: "summary",
			enabled,
			substitutions,
			requests,
			placeholder: PLACEHOLDER,
			model,
			sessionId: ctx.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
		});
		report("summary", model);
		try {
			// A second copy in pi's own session file, so a reader of the transcript can tell
			// whether this was active without going looking for the log. run-end does the same
			// with its record. It can refuse during shutdown; the JSONL above is the
			// authoritative one and is already written.
			pi.appendEntry<PlaceholderEntry>(ENTRY_TYPE, {
				event: "summary",
				enabled,
				substitutions,
				requests,
				placeholder: PLACEHOLDER,
				model,
				timestamp: new Date().toISOString(),
			});
		} catch {
			// Ignored on purpose.
		}
	});

	pi.registerCommand("reasoning-placeholder", {
		description: "Show how many outgoing assistant messages were given a placeholder thought",
		handler: async (_args, ctx) => {
			const lines = [
				enabled ? "enabled" : `disabled (--${FLAG_ENABLE} or ${ENV_ENABLE}=1 turns it on)`,
				`substitutions: ${substitutions} across ${requests} requests`,
				`placeholder: ${JSON.stringify(PLACEHOLDER)}`,
				`model: ${ctx.model?.id ?? "unknown"}`,
				`log: ${logFile ?? "unavailable"}`,
			];
			const text = lines.join(" | ");
			if (ctx.hasUI) ctx.ui.notify(text, substitutions > 0 ? "warning" : "info");
			if (ctx.mode !== "tui") process.stderr.write(`[reasoning-placeholder] ${text}\n`);
		},
	});
}
