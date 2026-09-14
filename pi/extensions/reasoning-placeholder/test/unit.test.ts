/**
 * Unit test for pi/extensions/reasoning-placeholder.
 *
 * Run: node --test pi/extensions/reasoning-placeholder/test/unit.test.ts
 *
 * SCOPE, stated plainly. This drives the extension's own handler with synthetic payloads whose
 * shapes were read off pi 0.85.1's BeforeProviderRequestEvent and off what pi-ai's
 * openai-completions.js `convertMessages` actually builds; the two message fixtures below are
 * transcriptions of real recorded turns, sourced on each. It proves the DECISION: whether the
 * extension is on at all, which outgoing assistant messages get a placeholder, which requests
 * are handed back untouched, and that the count reaches the log, the session transcript and
 * the bus.
 *
 * It does NOT prove that the placeholder changes what the model does. It does not, on the
 * server this repo runs against: oMLX drops every reasoning field on the way in, which is why
 * the extension is committed switched off. `node pi/extensions/reasoning-placeholder/probe.mjs
 * --passthrough` is the measurement, and it is committed next to this file so it can be re-run
 * instead of believed.
 *
 * Every test here was mutation-tested: the source was broken so the behaviour disappeared, the
 * named test was confirmed to fail, and the source was restored.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import factory, { isEnabled, substituteReasoning } from "../index.ts";
import { PLACEHOLDER_CHANNEL } from "../channels.ts";

/** The exact string probe.mjs was run with. A reword is untested. */
const PLACEHOLDER = "(no reasoning recorded)";

const AGENT_DIR = mkdtempSync(join(tmpdir(), "reasoning-placeholder-unit-"));
after(() => rmSync(AGENT_DIR, { recursive: true, force: true }));

interface Harness {
	entries: Array<{ customType: string; data: any }>;
	emitted: Array<{ channel: string; data: any }>;
	status: Record<string, string | undefined>;
	flags: Record<string, boolean | string | undefined>;
	sessionId: string;
	fire(event: string, payload?: any): Promise<any>;
	logLines(): any[];
}

let sessionCounter = 0;

function makeHarness(modelId: string, on: boolean): Harness {
	const sessionId = `reasoning-placeholder-test-${++sessionCounter}`;
	const logPath = join(AGENT_DIR, "logs", "reasoning-placeholder", `${sessionId}.jsonl`);
	rmSync(logPath, { force: true });

	const handlers = new Map<string, Array<(e: any, c: any) => any>>();
	const h: Harness = {
		entries: [],
		emitted: [],
		status: {},
		flags: { "reasoning-placeholder": on ? true : undefined },
		sessionId,
		logLines() {
			try {
				return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
			} catch {
				return [];
			}
		},
		async fire(event, payload = {}) {
			let last: any;
			for (const fn of handlers.get(event) ?? []) {
				last = await fn({ type: event, ...payload }, ctx);
			}
			return last;
		},
	};

	const ctx: any = {
		mode: "json",
		hasUI: false,
		cwd: "/tmp",
		model: { id: modelId },
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			notify: () => {},
			setStatus: (key: string, text: string | undefined) => {
				h.status[key] = text;
			},
		},
	};

	const pi: any = {
		on: (event: string, fn: any) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(fn);
		},
		appendEntry: (customType: string, data: any) => h.entries.push({ customType, data }),
		registerCommand: () => {},
		registerFlag: () => {},
		getFlag: (name: string) => h.flags[name],
		events: {
			emit: (channel: string, data: unknown) => h.emitted.push({ channel, data }),
			on: () => () => {},
		},
	};

	process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
	delete process.env.FREEPLAY_REASONING_PLACEHOLDER;
	factory(pi);
	return h;
}

async function start(modelId = "gemma-4-26B-A4B-it-qat-5bit", on = true): Promise<Harness> {
	const h = makeHarness(modelId, on);
	await h.fire("session_start", { reason: "startup" });
	return h;
}

function toolCall(name: string, args: Record<string, unknown> = {}) {
	return { id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/**
 * The Gemma request that loses its thought channel.
 *
 * Transcribed from session 01a09370 (pi/sessions is gitignored, so it is copied rather than
 * read): turn 1 is a bare park_status call with no text and no reasoning at all, turn 2 has
 * prose and a tool call but a thinking block of "\n", which pi-ai's nonEmptyThinkingBlocks
 * filter drops — so neither message reaches the wire with any reasoning field.
 */
function gemmaPayload(): any {
	return {
		model: "gemma-4-26B-A4B-it-qat-5bit",
		stream: true,
		max_tokens: 8192,
		tools: [{ type: "function", function: { name: "park_status" } }],
		messages: [
			{ role: "system", content: "You are playing OpenRCT2." },
			{ role: "user", content: "Start" },
			{ role: "assistant", content: null, tool_calls: [toolCall("park_status")] },
			{ role: "tool", tool_call_id: "call_park_status", content: '{"scenario":{"status":"inProgress"}}' },
			{
				role: "assistant",
				content: "\nI have initialized the park.\n\nI will start by listing the available flat rides.\n\n",
				tool_calls: [toolCall("list_ride_objects", { flatRidesOnly: true })],
			},
			{ role: "tool", tool_call_id: "call_list_ride_objects", content: '{"count":18}' },
		],
	};
}

/**
 * The same shape from a model that does not have the defect.
 *
 * Every one of Qwen3.6-35B-A3B-4bit's 520 tool-calling assistant turns across the 15 recorded
 * Qwen sessions carries non-empty thinking (probe.mjs --census), so its assistant messages
 * always reach the wire with reasoning_content set. That is why the gate is the condition and
 * not the model id: it is a no-op here by arithmetic, not by name.
 */
function qwenPayload(): any {
	return {
		model: "Qwen3.6-35B-A3B-4bit",
		stream: true,
		messages: [
			{ role: "system", content: "You are playing OpenRCT2." },
			{ role: "user", content: "Start" },
			{
				role: "assistant",
				content: null,
				reasoning_content: "The park is paused. I should read its status before anything else.",
				tool_calls: [toolCall("park_status")],
			},
			{ role: "tool", tool_call_id: "call_park_status", content: '{"scenario":{"status":"inProgress"}}' },
		],
	};
}

test("it is off unless somebody asked for it, and the log says which", async () => {
	// The default matters more than anything else in this file. oMLX drops the field this
	// extension writes (probe.mjs --passthrough), so a run that carried it by default would be
	// carrying an intervention a published result must disclose and that did nothing to earn
	// the disclosure.
	const h = await start("gemma-4-26B-A4B-it-qat-5bit", false);
	const payload = gemmaPayload();
	const result = await h.fire("before_provider_request", { payload });

	assert.equal(result, undefined, "off means the payload pi built is what gets sent");
	assert.equal(payload.messages[2].reasoning_content, undefined);
	assert.equal(h.status["reasoning-placeholder"], undefined);

	const armed = h.logLines().find((l) => l.event === "armed");
	assert.ok(armed, "a run has to say in its own log whether this was on");
	assert.equal(armed.enabled, false);

	// Both switches, and neither of them tripped by an accidental empty string.
	assert.equal(isEnabled(true, undefined), true);
	assert.equal(isEnabled(undefined, "1"), true);
	assert.equal(isEnabled(undefined, "true"), true);
	assert.equal(isEnabled(undefined, "YES"), true);
	assert.equal(isEnabled(undefined, undefined), false);
	assert.equal(isEnabled(false, "0"), false);
	assert.equal(isEnabled(undefined, ""), false);
});

test("an assistant message with tool calls and no reasoning is given the placeholder", async () => {
	const h = await start();
	const payload = gemmaPayload();
	const result = await h.fire("before_provider_request", { payload });

	assert.ok(result, "a changed payload must be returned, or pi keeps the original");
	const messages = result.messages;
	assert.equal(messages[2].reasoning_content, PLACEHOLDER, "the bare park_status call is the head of the loop");
	assert.equal(messages[4].reasoning_content, PLACEHOLDER, 'the turn whose thinking was "\\n" is the same case');

	// The template needs reasoning AND tool_calls on the same message; neither may be lost.
	assert.deepEqual(messages[2].tool_calls, payload.messages[2].tool_calls);
	assert.equal(messages[4].content, payload.messages[4].content);

	// Everything else about the request is passed through untouched.
	assert.equal(result.model, "gemma-4-26B-A4B-it-qat-5bit");
	assert.equal(result.stream, true);
	assert.equal(result.max_tokens, 8192);
	assert.deepEqual(result.tools, payload.tools);
	assert.equal(messages[0], payload.messages[0], "untouched messages are passed by reference");
	assert.equal(messages[3], payload.messages[3]);

	// pi still holds the payload it built; it must not come back mutated.
	assert.equal(payload.messages[2].reasoning_content, undefined);
	assert.equal(payload.messages[4].reasoning_content, undefined);
});

test("an assistant message that already reasoned is left exactly as it was", async () => {
	const h = await start();
	const payload = qwenPayload();
	const original = payload.messages[2].reasoning_content;
	const result = await h.fire("before_provider_request", { payload });

	assert.equal(result, undefined, "nothing qualified, so pi's own payload object must stand");
	assert.equal(payload.messages[2].reasoning_content, original, "real reasoning is never overwritten");

	// Whitespace-only counts as no reasoning; a single real word counts as reasoning.
	assert.equal(substituteReasoning({ messages: [{ role: "assistant", tool_calls: [toolCall("x")], reasoning_content: "   \n " }] }).changed, 1);
	assert.equal(substituteReasoning({ messages: [{ role: "assistant", tool_calls: [toolCall("x")], reasoning_content: "ok" }] }).changed, 0);
	// pi-ai will send any of three field names; all three mean the message already reasoned.
	assert.equal(substituteReasoning({ messages: [{ role: "assistant", tool_calls: [toolCall("x")], reasoning: "ok" }] }).changed, 0);
	assert.equal(substituteReasoning({ messages: [{ role: "assistant", tool_calls: [toolCall("x")], reasoning_text: "ok" }] }).changed, 0);
	// Structured reasoning the provider asked pi to preserve is also reasoning.
	assert.equal(substituteReasoning({ messages: [{ role: "assistant", tool_calls: [toolCall("x")], reasoning_details: [{}] }] }).changed, 0);
});

test("an assistant message with no tool call is left alone", async () => {
	const h = await start();
	// This is the turn the defect produces — prose, no tool call. The chat template renders a
	// thought channel only on a message that also has tool_calls, so a placeholder here would
	// change the request and render nothing.
	const payload = {
		model: "gemma-4-26B-A4B-it-qat-5bit",
		messages: [
			{ role: "user", content: "Start" },
			{ role: "assistant", content: "thought\n\nThe park has been initialized. I will now unpause the game." },
		],
	};
	const result = await h.fire("before_provider_request", { payload });

	assert.equal(result, undefined);
	assert.equal((payload.messages[1] as any).reasoning_content, undefined);
	// An empty tool_calls array is not a tool call either.
	assert.equal(substituteReasoning({ messages: [{ role: "assistant", content: "x", tool_calls: [] }] }).changed, 0);
	// Neither is a user or tool message, whatever else is on it.
	assert.equal(substituteReasoning({ messages: [{ role: "user", content: "x", tool_calls: [toolCall("x")] }] }).changed, 0);
});

test("a non-Gemma model is untouched, and so is anything that is not an OpenAI request body", async () => {
	const h = await start("Qwen3.6-35B-A3B-4bit");
	const payload = qwenPayload();
	const result = await h.fire("before_provider_request", { payload });

	assert.equal(result, undefined, "the run that is not broken must be byte-identical to one without this extension");
	assert.equal(h.status["reasoning-placeholder"], "reasoning placeholder on", "switched on but never triggered");
	assert.deepEqual(h.emitted, [], "and it must not report a substitution it did not make");
	assert.equal(h.logLines().filter((l) => l.event === "substituted").length, 0);

	// Payloads this extension has no business in are handed straight back.
	assert.equal(substituteReasoning(undefined).changed, 0);
	assert.equal(substituteReasoning("not a payload").changed, 0);
	assert.equal(substituteReasoning({ messages: "not an array" }).changed, 0);
	assert.equal(substituteReasoning({ input: [], model: "gpt-5" }).changed, 0);
	assert.equal(substituteReasoning({ messages: [null, 7, "x"] }).changed, 0);
});

test("the count reaches the log, the session transcript and the bus", async () => {
	const h = await start();
	await h.fire("before_provider_request", { payload: gemmaPayload() });
	await h.fire("before_provider_request", { payload: qwenPayload() }); // changes nothing
	await h.fire("before_provider_request", { payload: gemmaPayload() });
	await h.fire("session_shutdown", { reason: "quit" });

	const lines = h.logLines();
	const substituted = lines.filter((l) => l.event === "substituted");
	assert.equal(substituted.length, 2, "one line per request that was actually changed");
	assert.deepEqual(substituted.map((l) => l.changed), [2, 2]);
	assert.deepEqual(substituted.map((l) => l.substitutions), [2, 4], "the total has to be a running one");
	assert.deepEqual(substituted.map((l) => l.requests), [1, 2]);
	assert.equal(substituted[0].model, "gemma-4-26B-A4B-it-qat-5bit", "a published result must be able to name what was touched");
	assert.equal(substituted[0].placeholder, PLACEHOLDER, "and what was put in the context");
	assert.equal(substituted[0].sessionId, h.sessionId);

	const summary = lines.find((l) => l.event === "summary");
	assert.ok(summary, "a run with no substitutions still has to say so, so the log is never ambiguous");
	assert.equal(summary.substitutions, 4);
	assert.equal(summary.requests, 2);
	assert.equal(summary.enabled, true);

	// The same totals travel with pi's own transcript.
	assert.equal(h.entries.length, 1);
	assert.equal(h.entries[0].customType, "reasoning-placeholder");
	assert.equal(h.entries[0].data.substitutions, 4);
	assert.equal(h.entries[0].data.requests, 2);
	assert.equal(h.entries[0].data.enabled, true);

	// And onto the shared bus, which is the route run-end reads the nudge count from.
	const telemetry = h.emitted.filter((e) => e.channel === PLACEHOLDER_CHANNEL);
	assert.equal(telemetry.length, 3, "two substitutions and the shutdown summary");
	assert.deepEqual(telemetry.map((e) => e.data.substitutions), [2, 4, 4]);
	assert.equal(telemetry[2].data.event, "summary");
	assert.equal(telemetry[2].data.model, "gemma-4-26B-A4B-it-qat-5bit");
	assert.equal(telemetry[2].data.enabled, true);

	assert.equal(h.status["reasoning-placeholder"], "reasoning placeholders 4 in 2 requests");
});

test("a session that starts again counts from zero", async () => {
	const h = await start();
	await h.fire("before_provider_request", { payload: gemmaPayload() });
	await h.fire("session_start", { reason: "switch" });
	await h.fire("before_provider_request", { payload: gemmaPayload() });

	const substituted = h.logLines().filter((l) => l.event === "substituted");
	assert.deepEqual(substituted.map((l) => l.substitutions), [2, 2]);
});
