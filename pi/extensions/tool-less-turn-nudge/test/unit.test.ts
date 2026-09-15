/**
 * Unit test for pi/extensions/tool-less-turn-nudge.ts.
 *
 * Run: node --test pi/extensions/tool-less-turn-nudge/test/unit.test.ts
 *
 * SCOPE, stated plainly: this drives the extension's own handlers with synthetic events whose
 * shapes were read off pi 0.85.1's AgentEndEvent / TurnEndEvent / MessageStartEvent type
 * definitions. It proves the DECISION (when a nudge is sent, with what text, and when it is
 * suppressed). It does not prove that pi delivers the queued message — that is what the
 * companion e2e.mjs run against a scripted provider proves.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import factory from "../index.ts";
import { NUDGE_CHANNEL, STOPPED_TURN_CHANNEL } from "../../run-end/channels.ts";
import {
	INTERVENTION_CENSUS_CHANNEL,
	INTERVENTION_CHANNEL,
	type InterventionCensus,
	type InterventionReport,
} from "../../run-end/interventions.ts";
import { BRIDGE_TOOLS } from "../../run-end/signals.ts";

const NUDGE_NARRATED =
	"You described what you would do but called no tool, so nothing happened. Make that tool call now.";
const NUDGE_EMPTY = "Your last response was empty, so nothing happened. Make the next tool call now.";

interface Harness {
	sent: string[];
	entries: Array<{ customType: string; data: any }>;
	notifications: Array<{ text: string; level: string }>;
	status: Record<string, string | undefined>;
	fire(event: string, payload: any): Promise<void>;
	logLines(): any[];
	pendingOverride: boolean | undefined;
	/** Channels the extension emitted on, so the run-end handoff can be asserted. */
	emitted: Array<{ channel: string; data: any }>;
	/**
	 * Stands in for the run-end extension. undefined means run-end is not loaded, which is the
	 * case the pre-run-end tests below run under.
	 */
	verdict: "ended" | "undecided" | undefined;
	scenarioStatus: string;
	/** Stands in for run-end asking every intervention what it did. Returns what answered. */
	census(): InterventionReport[];
}

let sessionCounter = 0;

function makeHarness(agentDir: string): Harness {
	const sessionId = `test-session-${++sessionCounter}`;
	const logPath = join(agentDir, "logs", "nudges", `${sessionId}.jsonl`);
	rmSync(logPath, { force: true });
	const handlers = new Map<string, Array<(e: any, c: any) => any>>();
	const busHandlers = new Map<string, Array<(data: unknown) => void>>();
	const h: Harness = {
		census() {
			const request: InterventionCensus = { reports: [] };
			for (const fn of busHandlers.get(INTERVENTION_CENSUS_CHANNEL) ?? []) fn(request);
			return request.reports;
		},
		sent: [],
		entries: [],
		notifications: [],
		status: {},
		pendingOverride: undefined,
		emitted: [],
		verdict: undefined,
		scenarioStatus: "inProgress",
		logLines() {
			try {
				return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
			} catch {
				return [];
			}
		},
		async fire(event, payload) {
			for (const fn of handlers.get(event) ?? []) {
				const r = await fn({ type: event, ...payload }, ctx);
				assert.equal(r, undefined, `${event} handler must return undefined (message_end-style replacement trap)`);
			}
		},
	};

	const ctx: any = {
		mode: "json",
		hasUI: false,
		cwd: "/tmp",
		model: { id: "gemma-4-26B-A4B-it-qat-5bit" },
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => "/dev/null" },
		ui: {
			notify: (text: string, level = "info") => h.notifications.push({ text, level }),
			setStatus: (key: string, text: string | undefined) => {
				h.status[key] = text;
			},
		},
		isIdle: () => false,
		// After a nudge the extension waits for the follow-up queue to fill; say it filled.
		hasPendingMessages: () => h.pendingOverride ?? h.sent.length > 0,
	};

	const pi: any = {
		on: (event: string, fn: any) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(fn);
		},
		sendUserMessage: (text: string) => h.sent.push(text),
		appendEntry: (customType: string, data: any) => h.entries.push({ customType, data }),
		registerCommand: () => {},
		getActiveTools: () => [...BRIDGE_TOOLS],
		events: {
			// pi's EventBus dispatches synchronously, which is what lets run-end assign
			// `decision` before emit() returns. The stand-in must do the same or the test
			// would pass for a reason the real bus does not supply.
			emit: (channel: string, data: any) => {
				h.emitted.push({ channel, data });
				if (channel !== STOPPED_TURN_CHANNEL || h.verdict === undefined) return;
				data.statusAtRequest = h.scenarioStatus;
				data.decision = Promise.resolve(h.verdict);
			},
			on: (channel: string, fn: (data: unknown) => void) => {
				if (!busHandlers.has(channel)) busHandlers.set(channel, []);
				busHandlers.get(channel)!.push(fn);
				return () => {};
			},
		},
	};

	process.env.PI_CODING_AGENT_DIR = agentDir;
	factory(pi);
	return h;
}

/** An assistant message that ends a run. */
function assistant(opts: { text?: string; toolCall?: boolean; stopReason?: string; output?: number }) {
	const content: any[] = [];
	if (opts.text !== undefined) content.push({ type: "text", text: opts.text });
	if (opts.toolCall) content.push({ type: "toolCall", id: "c1", name: "view_map", arguments: { x: 50 } });
	return {
		role: "assistant",
		content,
		stopReason: opts.stopReason ?? "stop",
		usage: { input: 100, output: opts.output ?? 20, cacheRead: 0, cacheWrite: 0 },
		timestamp: Date.now(),
	};
}

// Nudge logs land under AGENT_DIR/logs/nudges; keep them out of the repo.
const AGENT_DIR = mkdtempSync(join(tmpdir(), "nudge-unit-"));

/** Default: run-end is loaded and says the scenario is still running. */
async function start(): Promise<Harness> {
	const h = makeHarness(AGENT_DIR);
	h.verdict = "undecided";
	await h.fire("session_start", { reason: "startup" });
	await h.fire("turn_start", { turnIndex: 0, timestamp: Date.now() });
	return h;
}

/** A recorded gemma turn that names the tool it then never calls. */
const NARRATED_WITH_SIGNAL = "I'll check `park_status` to see if any guests have arrived yet.";

/** A recorded gemma turn that names nothing: mid-plan, but with no sign of a tool call. */
const NARRATED_NO_SIGNAL = "I'll list the available ride objects to see what our options are.";

/** The recorded Qwen post-mortem the nudge used to tell to keep playing. */
const POST_MORTEM =
	'I failed the "Forest Frontiers" scenario. Key mistakes that led to failure: ' +
	"insufficient staff management, over-reliance on a single ride. Thank you for playing!";

test("fires on the failure it was built for: prose, no tool call", async () => {
	const h = await start();
	const msg = assistant({ text: NARRATED_WITH_SIGNAL });
	await h.fire("turn_end", { turnIndex: 0, message: msg, toolResults: [] });
	await h.fire("agent_end", { messages: [msg] });

	assert.deepEqual(h.sent, [NUDGE_NARRATED]);
	assert.equal(h.entries.length, 1);
	assert.equal(h.entries[0].data.event, "nudge");
	assert.equal(h.entries[0].data.reason, "narrated");
	assert.equal(h.entries[0].data.total, 1);
});

test("a turn that shows the model reaching for a tool is nudged without asking run-end", async () => {
	const h = await start();
	// run-end would say the run is over. It must never be asked: this turn is a delivery
	// failure, not a model that stopped.
	h.verdict = "ended";
	h.scenarioStatus = "failed";
	await h.fire("agent_end", { messages: [assistant({ text: NARRATED_WITH_SIGNAL })] });

	assert.deepEqual(h.sent, [NUDGE_NARRATED]);
	assert.equal(
		h.emitted.filter((e) => e.channel === STOPPED_TURN_CHANNEL).length,
		0,
		"a signalled turn must not cost a bridge call",
	);
});

test("unparsed tool-call markup counts as reaching for a tool", async () => {
	const h = await start();
	h.verdict = "ended";
	const msg = assistant({
		text: "Let me check what objects are loaded.\n</parameter>\n</function>\n</tool_call>",
	});
	await h.fire("agent_end", { messages: [msg] });

	assert.deepEqual(h.sent, [NUDGE_NARRATED]);
	assert.equal(h.emitted.filter((e) => e.channel === STOPPED_TURN_CHANNEL).length, 0);
});

test("a stopped turn with the scenario already decided is left alone", async () => {
	const h = await start();
	h.verdict = "ended";
	h.scenarioStatus = "failed";
	await h.fire("agent_end", { messages: [assistant({ text: POST_MORTEM })] });

	assert.deepEqual(h.sent, [], "a model that finished must not be told to keep playing");
	const declined = h.logLines().filter((l) => l.event === "declined");
	assert.equal(declined.length, 1, "the decision must be in the run record");
	assert.equal(declined[0].scenarioStatus, "failed");
	assert.equal(h.entries[0].data.event, "declined");
	assert.match(h.status["tool-less-nudge"] ?? "", /stopped correctly/);
});

test("a stopped turn with the scenario still running is nudged anyway", async () => {
	const h = await start();
	h.verdict = "undecided";
	await h.fire("agent_end", { messages: [assistant({ text: NARRATED_NO_SIGNAL })] });

	// Three of the four recorded no-signal turns read like this one and were plainly mid-plan.
	// Ending a run on them would call a narration failure a decision.
	assert.deepEqual(h.sent, [NUDGE_NARRATED]);
	assert.equal(h.emitted.filter((e) => e.channel === STOPPED_TURN_CHANNEL).length, 1);
});

test("with run-end absent the nudge falls back to its old behaviour", async () => {
	const h = makeHarness(AGENT_DIR);
	h.verdict = undefined; // nothing subscribes, so no decision comes back
	await h.fire("session_start", { reason: "startup" });
	await h.fire("turn_start", { turnIndex: 0, timestamp: Date.now() });
	await h.fire("agent_end", { messages: [assistant({ text: POST_MORTEM })] });

	assert.deepEqual(h.sent, [NUDGE_NARRATED]);
});

test("nudge counts are reported to run-end", async () => {
	const h = await start();
	await h.fire("agent_end", { messages: [assistant({ text: NARRATED_WITH_SIGNAL })] });

	const reported = h.emitted.filter((e) => e.channel === NUDGE_CHANNEL);
	assert.equal(reported.length, 1, "the run-end record has to be able to carry the nudge count");
	assert.deepEqual(reported[0].data, { event: "nudge", reason: "narrated", total: 1, consecutive: 1 });
});

test("does not fire when the turn called a tool", async () => {
	const h = await start();
	const msg = assistant({ text: "Looking at the map.", toolCall: true });
	// A tool-calling turn does not end the loop, but assert the guard holds even if handed one.
	await h.fire("turn_end", { turnIndex: 0, message: msg, toolResults: [{ role: "toolResult", toolName: "view_map" }] });
	await h.fire("agent_end", { messages: [msg] });
	assert.deepEqual(h.sent, []);
});

test("does not fire when the run ended on a tool result (terminate hint)", async () => {
	const h = await start();
	const msg = assistant({ text: "done", toolCall: true });
	const result = { role: "toolResult", toolCallId: "c1", toolName: "view_map", content: [] };
	await h.fire("agent_end", { messages: [msg, result] });
	assert.deepEqual(h.sent, []);
});

test("does not fire on abort or on a provider error", async () => {
	for (const stopReason of ["aborted", "error", "deferred"]) {
		const h = await start();
		await h.fire("agent_end", { messages: [assistant({ text: "half a sen", stopReason })] });
		assert.deepEqual(h.sent, [], `stopReason ${stopReason} must not be nudged`);
	}
});

test("zero-token response gets its own wording", async () => {
	const h = await start();
	await h.fire("agent_end", { messages: [assistant({ output: 0 })] });
	assert.deepEqual(h.sent, [NUDGE_EMPTY]);
	assert.equal(h.entries[0].data.reason, "empty");
});

test("token-cap runaway is recorded, never nudged", async () => {
	const h = await start();
	const runaway = assistant({
		text: "Actually, I'll call view_map(x=50, y=19, size=30). ".repeat(200),
		stopReason: "length",
		output: 8192,
	});
	await h.fire("agent_end", { messages: [runaway] });
	assert.deepEqual(h.sent, []);
	assert.match(h.status["tool-less-nudge"] ?? "", /runaway/);
});

test("caps at 3 consecutive, then stops and says so", async () => {
	const h = await start();
	for (let i = 0; i < 6; i++) {
		await h.fire("agent_end", { messages: [assistant({ text: "I will now unpause the game." })] });
	}
	assert.equal(h.sent.length, 3, "must stop nudging after 3 in a row");
	const cap = h.entries.filter((e) => e.data.event === "cap_reached");
	assert.equal(cap.length, 1, "cap must be announced exactly once");
	assert.match(h.status["tool-less-nudge"] ?? "", /cap hit/);
});

test("a tool call resets the consecutive counter", async () => {
	const h = await start();
	for (let i = 0; i < 3; i++) {
		await h.fire("agent_end", { messages: [assistant({ text: "I will now unpause." })] });
	}
	assert.equal(h.sent.length, 3);
	// Model acts again.
	await h.fire("turn_end", {
		turnIndex: 1,
		message: assistant({ toolCall: true }),
		toolResults: [{ role: "toolResult", toolName: "set_game_speed" }],
	});
	// Then narrates again: budget is back.
	await h.fire("agent_end", { messages: [assistant({ text: "I will now look at the map." })] });
	assert.equal(h.sent.length, 4, "counter must reset once the model acts");
});

test("our own nudge does not re-arm a capped session, a human message does", async () => {
	const h = await start();
	for (let i = 0; i < 4; i++) {
		await h.fire("agent_end", { messages: [assistant({ text: "I will now unpause." })] });
	}
	assert.equal(h.sent.length, 3);

	// The nudge itself arriving back as a user message must not reset anything.
	await h.fire("message_start", { message: { role: "user", content: [{ type: "text", text: NUDGE_NARRATED }] } });
	await h.fire("agent_end", { messages: [assistant({ text: "I will now unpause." })] });
	assert.equal(h.sent.length, 3, "our own nudge must not re-arm the cap");

	// A human typing does.
	await h.fire("message_start", { message: { role: "user", content: "build a coaster near the gate" } });
	await h.fire("agent_end", { messages: [assistant({ text: "I will now unpause." })] });
	assert.equal(h.sent.length, 4, "a human message must re-arm");
});

test("a nudge that never reaches the queue is reported, not swallowed", async () => {
	const h = await start();
	h.pendingOverride = false;
	await h.fire("agent_end", { messages: [assistant({ text: "I will now unpause." })] });
	assert.ok(
		h.logLines().some((l) => l.event === "not_queued"),
		"a lost nudge must land in the run record",
	);
});

test("the nudge discloses itself to run-end as always armed, with the count it sent", async () => {
	// This extension puts a user message into the conversation that no human typed, and it has
	// no flag: being loaded is being armed. A run-end record that did not name it would be
	// describing a conversation the model never had.
	const h = await start();

	const announced = h.emitted.filter((e) => e.channel === INTERVENTION_CHANNEL);
	assert.equal(announced.length, 1, "it must announce itself at session_start, before it fires");
	assert.equal(announced[0].data.id, "tool-less-turn-nudge");
	assert.equal(announced[0].data.armed, true);
	assert.equal(announced[0].data.fired, 0);

	const before = h.census();
	assert.equal(before.length, 1, "and answer the census whether or not it has fired");
	assert.equal(before[0].armed, true, "there is no flag: loaded is armed");
	assert.equal(before[0].fired, 0);
	assert.match(before[0].detail, /did not fire/);

	await h.fire("agent_end", { messages: [assistant({ text: NARRATED_WITH_SIGNAL })] });
	await h.fire("agent_end", { messages: [assistant({ text: "", output: 0 })] });
	assert.equal(h.sent.length, 2);

	const after = h.census();
	assert.equal(after[0].fired, 2, "the census is read at the end of the run and carries live counts");
	assert.match(after[0].detail, /1 after prose, 1 after an empty response/);
});
