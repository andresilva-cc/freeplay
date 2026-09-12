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
}

let sessionCounter = 0;

function makeHarness(agentDir: string): Harness {
	const sessionId = `test-session-${++sessionCounter}`;
	const logPath = join(agentDir, "logs", "nudges", `${sessionId}.jsonl`);
	rmSync(logPath, { force: true });
	const handlers = new Map<string, Array<(e: any, c: any) => any>>();
	const h: Harness = {
		sent: [],
		entries: [],
		notifications: [],
		status: {},
		pendingOverride: undefined,
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

async function start(): Promise<Harness> {
	const h = makeHarness(AGENT_DIR);
	await h.fire("session_start", { reason: "startup" });
	await h.fire("turn_start", { turnIndex: 0, timestamp: Date.now() });
	return h;
}

test("fires on the measured failure: prose, no tool call", async () => {
	const h = await start();
	const msg = assistant({
		text: "I will now unpause the game and begin exploring the layout by viewing the map around the park gate.",
	});
	await h.fire("turn_end", { turnIndex: 0, message: msg, toolResults: [] });
	await h.fire("agent_end", { messages: [msg] });

	assert.deepEqual(h.sent, [NUDGE_NARRATED]);
	assert.equal(h.entries.length, 1);
	assert.equal(h.entries[0].data.event, "nudge");
	assert.equal(h.entries[0].data.reason, "narrated");
	assert.equal(h.entries[0].data.total, 1);
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
