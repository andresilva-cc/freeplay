/**
 * Unit test for pi/extensions/run-end.
 *
 * Run: node --test pi/extensions/run-end/test/unit.test.ts
 *
 * SCOPE, stated plainly. This drives the extension's own handlers with synthetic events whose
 * shapes were read off pi 0.85.1's TurnEndEvent / ToolResultEvent / AgentSettledEvent /
 * SessionShutdownEvent definitions, and it stubs globalThis.fetch rather than the poller, so
 * the MCP handshake the poller builds — initialize, notifications/initialized, tools/call — is
 * exercised for real against a fake bridge. What it does NOT prove is that pi actually quits
 * when ctx.shutdown() is called; it proves only that the extension calls it, having written
 * the record first.
 *
 * Every test here was mutation-tested: the source was broken so the behaviour disappeared, the
 * named test was confirmed to fail, and the source was restored.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import factory from "../index.ts";
import { NUDGE_CHANNEL, STOPPED_TURN_CHANNEL, type StoppedTurnRequest } from "../channels.ts";
import { detectToolCallSignal } from "../signals.ts";

const AGENT_DIR = mkdtempSync(join(tmpdir(), "run-end-unit-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.FREEPLAY_BRIDGE_URL = "http://127.0.0.1:8080";

const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
	rmSync(AGENT_DIR, { recursive: true, force: true });
});

interface BridgeStub {
	/** What the bridge answers with, or "throw" to make every call fail. */
	status: "inProgress" | "completed" | "failed" | "throw";
	calls: string[];
	/**
	 * An older plugin, whose `GET /v1` reports controllers and state guards and no scenario.
	 * The poller then falls back to park_status over MCP, which is the path this used to take
	 * every time.
	 */
	indexHasNoScenario?: boolean;
	/** The in-game day `GET /v1` says the scenario ended on, where it says one. */
	endedOn?: { year: number; month: number; day: number };
}

/** A fake bridge that speaks just enough HTTP and MCP Streamable HTTP for the poller. */
function installBridge(stub: BridgeStub): void {
	globalThis.fetch = (async (input: any, init: any) => {
		if (!init?.body) {
			// GET /v1, the cheap read the poller tries first.
			assert.match(String(input), /\/v1$/);
			stub.calls.push("GET /v1");

			if (stub.status === "throw") throw new Error("bridge is not answering");

			const index: Record<string, unknown> = { buildId: "test", controllers: [], stateGuards: {} };
			if (!stub.indexHasNoScenario) {
				index.scenario = {
					name: "Forest Frontiers",
					objective: { type: "guestsBy" },
					status: stub.status,
					endedOn: stub.endedOn ?? null,
				};
			}

			return {
				ok: true,
				status: 200,
				headers: { get: () => null },
				text: async () => JSON.stringify(index),
			};
		}

		const body = JSON.parse(String(init.body));
		stub.calls.push(body.method);

		if (stub.status === "throw") throw new Error("bridge is not answering");

		if (body.method === "initialize") {
			return {
				ok: true,
				status: 200,
				headers: { get: (name: string) => (name.toLowerCase() === "mcp-session-id" ? "sess-1" : null) },
				text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25" } }),
			};
		}

		if (body.method === "notifications/initialized") {
			return { ok: true, status: 202, headers: { get: () => null }, text: async () => "" };
		}

		assert.equal(body.method, "tools/call");
		assert.equal(body.params.name, "park_status");
		assert.equal(String(init.headers["MCP-Session-Id"]), "sess-1");
		const payload = { scenario: { name: "Forest Frontiers", objective: { type: "guestsBy" }, status: stub.status } };
		return {
			ok: true,
			status: 200,
			headers: { get: () => null },
			text: async () =>
				JSON.stringify({
					jsonrpc: "2.0",
					id: body.id,
					result: { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload },
				}),
		};
	}) as any;
}

interface Harness {
	entries: Array<{ customType: string; data: any }>;
	notifications: Array<{ text: string; level: string }>;
	status: Record<string, string | undefined>;
	shutdowns: number;
	aborts: number;
	sessionId: string;
	fire(event: string, payload?: any): Promise<void>;
	emit(channel: string, data: unknown): void;
	logLines(): any[];
	record(): any | undefined;
}

let sessionCounter = 0;

function makeHarness(): Harness {
	const sessionId = `run-end-test-${++sessionCounter}`;
	const logPath = join(AGENT_DIR, "logs", "run-end", `${sessionId}.jsonl`);
	rmSync(logPath, { force: true });

	const handlers = new Map<string, Array<(e: any, c: any) => any>>();
	const busHandlers = new Map<string, Array<(data: unknown) => void>>();

	const h: Harness = {
		entries: [],
		notifications: [],
		status: {},
		shutdowns: 0,
		aborts: 0,
		sessionId,
		logLines() {
			try {
				return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
			} catch {
				return [];
			}
		},
		record() {
			return h.logLines().find((l) => l.event === "run_end");
		},
		emit(channel, data) {
			for (const fn of busHandlers.get(channel) ?? []) fn(data);
		},
		async fire(event, payload = {}) {
			for (const fn of handlers.get(event) ?? []) {
				const result = await fn({ type: event, ...payload }, ctx);
				assert.equal(result, undefined, `${event} handler must return undefined`);
			}
		},
	};

	const ctx: any = {
		mode: "json",
		hasUI: false,
		cwd: "/tmp",
		model: { id: "gemma-4-26B-A4B-it-qat-5bit" },
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			notify: (text: string, level = "info") => h.notifications.push({ text, level }),
			setStatus: (key: string, text: string | undefined) => {
				h.status[key] = text;
			},
		},
		isIdle: () => false,
		hasPendingMessages: () => false,
		shutdown: () => {
			h.shutdowns += 1;
		},
		abort: () => {
			h.aborts += 1;
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
		getFlag: () => undefined,
		events: {
			emit: (channel: string, data: unknown) => h.emit(channel, data),
			on: (channel: string, fn: (data: unknown) => void) => {
				if (!busHandlers.has(channel)) busHandlers.set(channel, []);
				busHandlers.get(channel)!.push(fn);
				return () => {};
			},
		},
	};

	factory(pi);
	return h;
}

function parkStatusResult(status: string) {
	const payload = { scenario: { name: "Forest Frontiers", objective: { type: "guestsBy" }, status } };
	return {
		toolCallId: "c1",
		toolName: "park_status",
		input: {},
		content: [{ type: "text", text: JSON.stringify(payload) }],
		isError: false,
	};
}

async function start(stub: BridgeStub): Promise<Harness> {
	installBridge(stub);
	const h = makeHarness();
	await h.fire("session_start", { reason: "startup" });
	await h.fire("turn_start", { turnIndex: 0, timestamp: Date.now() });
	return h;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a scenario the model reads as completed ends the run and writes the record", async () => {
	const h = await start({ status: "inProgress", calls: [] });
	await h.fire("tool_result", parkStatusResult("completed"));
	await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] });

	const record = h.record();
	assert.ok(record, "a run_end record must be written");
	assert.equal(record.condition, "scenario_decided");
	assert.equal(record.scenario.status, "completed");
	assert.equal(record.scenario.source, "tool_result");
	assert.equal(record.scenario.name, "Forest Frontiers");
	assert.equal(record.turns, 1);
	assert.equal(record.toolCalls, 1);
	assert.equal(record.model, "gemma-4-26B-A4B-it-qat-5bit");
	assert.equal(record.sessionId, h.sessionId);
	assert.ok(record.elapsedMs >= 0 && typeof record.elapsedMinutes === "number");
	assert.equal(h.shutdowns, 1, "the run must be asked to shut down");
	assert.equal(h.aborts, 1, "the in-flight loop must be aborted so shutdown can land");
});

test("a scenario the model reads as failed ends the run the same way", async () => {
	const h = await start({ status: "inProgress", calls: [] });
	await h.fire("tool_result", parkStatusResult("failed"));
	await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] });

	const record = h.record();
	assert.ok(record);
	assert.equal(record.condition, "scenario_decided");
	assert.equal(record.scenario.status, "failed");
	assert.equal(h.shutdowns, 1);
});

test("the blind spot is covered: a flip the model never reads is found by the poll", async () => {
	// The model calls nothing at all this turn, so a result-watching extension would see
	// nothing. The bridge says the scenario is over, and says it on one plain GET: no MCP
	// session is opened, so there is no per-session gameDaysSinceLastCall to disturb.
	const stub: BridgeStub = { status: "completed", calls: [], endedOn: { year: 2, month: 3, day: 14 } };
	const h = await start(stub);
	await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] });
	// turn_end does not await its own poll, on purpose: see the handler.
	await sleep(20);

	assert.deepEqual(stub.calls, ["GET /v1"], "the poll must not open an MCP session of its own");
	const record = h.record();
	assert.ok(record, "the poll must be able to end a run on its own");
	assert.equal(record.condition, "scenario_decided");
	assert.equal(record.scenario.source, "bridge_index");
	assert.deepEqual(record.scenario.endedOn, { year: 2, month: 3, day: 14 },
		"the in-game day the scenario ended is the figure a benchmark cites, and the record has to carry it");
});

test("a bridge too old to carry the scenario on its index is polled the way it always was", async () => {
	// The plugin is copied into OpenRCT2's plugin directory by hand, so a bridge older than
	// the scenario field is a real state. Losing the verdict there would be silent: no end
	// condition, ever, and every run stopping on the wall-clock budget instead.
	const stub: BridgeStub = { status: "failed", calls: [], indexHasNoScenario: true };
	const h = await start(stub);
	await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] });
	await sleep(20);

	assert.deepEqual(stub.calls, ["GET /v1", "initialize", "notifications/initialized", "tools/call"]);
	const record = h.record();
	assert.ok(record, "the fallback is the whole point of keeping park_status");
	assert.equal(record.condition, "scenario_decided");
	assert.equal(record.scenario.source, "poll");
	assert.equal(record.scenario.endedOn, null, "an old bridge has no day to give, and none is invented");
});

test("the verdict on any tool result ends the run, not only on park_status", async () => {
	// `scenarioEnded` rides on EVERY tool result, so a turn that called view_map and nothing
	// else shows the flip. Before that field the free path could only see a park_status.
	const h = await start({ status: "inProgress", calls: [] });
	await h.fire("tool_result", {
		toolCallId: "c9",
		toolName: "view_map",
		input: {},
		content: [{ type: "text", text: JSON.stringify({ rows: [], scenarioEnded: { status: "failed", year: 1, month: 5, day: 12 } }) }],
		isError: false,
	});
	await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] });

	const record = h.record();
	assert.ok(record, "a run that ended must be recorded whichever tool showed it");
	assert.equal(record.condition, "scenario_decided");
	assert.equal(record.scenario.status, "failed");
	assert.equal(record.scenario.source, "tool_result");
	assert.deepEqual(record.scenario.endedOn, { year: 1, month: 5, day: 12 });
});

test("a poll that throws never ends the run", async () => {
	const h = await start({ status: "throw", calls: [] });
	await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] });
	await sleep(20);

	assert.equal(h.record(), undefined, "a bridge that is down is not a scenario that is decided");
	assert.equal(h.shutdowns, 0);
	assert.equal(h.aborts, 0);
	assert.ok(
		h.logLines().some((l) => l.event === "poll_failed"),
		"the failure must still be recorded",
	);
	await h.fire("session_shutdown", { reason: "quit" });
});

test("an exhausted wall-clock budget ends the run", async () => {
	process.env.FREEPLAY_RUN_BUDGET_MINUTES = "0.0002"; // 12ms
	try {
		const h = await start({ status: "inProgress", calls: [] });
		await sleep(40);
		await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] });

		const record = h.record();
		assert.ok(record, "the budget must write the same record");
		assert.equal(record.condition, "budget_exhausted");
		assert.equal(record.budgetMs, 12);
		assert.ok(record.elapsedMs >= 12);
		assert.equal(record.scenario.status, "unknown");
		assert.equal(h.shutdowns, 1);
		assert.equal(h.aborts, 1);
	} finally {
		delete process.env.FREEPLAY_RUN_BUDGET_MINUTES;
	}
});

test("a stopped turn with the scenario decided ends the run and says the model stopped correctly", async () => {
	const h = await start({ status: "failed", calls: [] });
	const request: StoppedTurnRequest = { turnPreview: "I failed the \"Forest Frontiers\" scenario." };
	h.emit(STOPPED_TURN_CHANNEL, request);

	assert.ok(request.decision, "run-end must answer synchronously enough for the nudge to await it");
	assert.equal(await request.decision, "ended");
	assert.equal(request.statusAtRequest, "failed");

	const record = h.record();
	assert.ok(record);
	assert.equal(record.condition, "model_stopped");
	assert.match(record.detail, /model stopped correctly/);
	assert.equal(record.scenario.status, "failed");
	assert.equal(h.shutdowns, 1);
});

test("a stopped turn with the scenario still running is handed back undecided", async () => {
	const h = await start({ status: "inProgress", calls: [] });
	const request: StoppedTurnRequest = { turnPreview: "I'll list the available ride objects." };
	h.emit(STOPPED_TURN_CHANNEL, request);

	assert.ok(request.decision);
	assert.equal(await request.decision, "undecided");
	assert.equal(request.statusAtRequest, "inProgress");
	assert.equal(h.record(), undefined, "an undecided scenario is not an ended run");
	assert.equal(h.shutdowns, 0);
	await h.fire("session_shutdown", { reason: "quit" });
});

test("a settled agent loop ends the run even when nothing else fired", async () => {
	const h = await start({ status: "inProgress", calls: [] });
	await h.fire("agent_settled", {});

	const record = h.record();
	assert.ok(record, "a loop that has stopped and will not restart is a run that is over");
	assert.equal(record.condition, "model_stopped");
	assert.equal(record.scenario.status, "inProgress");
	assert.equal(h.shutdowns, 1);
});

test("a run nobody ended is recorded as interrupted, not as a result", async () => {
	const h = await start({ status: "inProgress", calls: [] });
	await h.fire("session_shutdown", { reason: "quit" });

	const record = h.record();
	assert.ok(record);
	assert.equal(record.condition, "interrupted");
	assert.equal(record.shutdownReason, "quit");
	assert.equal(h.shutdowns, 0, "pi is already leaving; asking it to leave again is noise");
});

test("the nudge count reaches the run-end record", async () => {
	const h = await start({ status: "inProgress", calls: [] });
	h.emit(NUDGE_CHANNEL, { event: "nudge", reason: "narrated", total: 1, consecutive: 1 });
	h.emit(NUDGE_CHANNEL, { event: "nudge", reason: "empty", total: 2, consecutive: 2 });
	h.emit(NUDGE_CHANNEL, { event: "declined", reason: "narrated", total: 2, consecutive: 2 });
	h.emit(NUDGE_CHANNEL, { event: "cap_reached", total: 2, consecutive: 3 });
	h.emit(NUDGE_CHANNEL, { event: "runaway", total: 2, consecutive: 0 });
	await h.fire("session_shutdown", { reason: "quit" });

	const record = h.record();
	assert.ok(record);
	assert.deepEqual(record.nudges, { total: 2, narrated: 1, empty: 1, declined: 1, capHits: 1, runaways: 1 });
});

test("a run ends exactly once", async () => {
	const h = await start({ status: "inProgress", calls: [] });
	await h.fire("tool_result", parkStatusResult("completed"));
	await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] });
	await h.fire("turn_end", { turnIndex: 1, message: { role: "assistant" }, toolResults: [] });
	await h.fire("agent_settled", {});
	await h.fire("session_shutdown", { reason: "quit" });

	assert.equal(h.logLines().filter((l) => l.event === "run_end").length, 1);
	assert.equal(h.shutdowns, 1);
});

test("the signal detector separates reaching for a tool from stopping", () => {
	const tools = ["park_status", "view_map", "wait", "evaluate", "build_path"];

	// The one Qwen turn that ends in unparsed markup.
	assert.equal(detectToolCallSignal("...loaded at all.\n</parameter>\n</function>\n</tool_call>", "", tools).kind, "markup");
	// A tool named in the text.
	assert.equal(detectToolCallSignal("I'll check `park_status` to see if guests arrived.", "", tools).kind, "tool_name");
	// A tool named only in the thinking.
	assert.equal(detectToolCallSignal("I will proceed.", "I'll use `view_map` around the gate.", tools).kind, "tool_name");
	// The terminal post-mortem: no markup, no tool named, and "guest feedback" with a space
	// must not count as the guest_feedback tool.
	assert.equal(
		detectToolCallSignal(
			"I failed the \"Forest Frontiers\" scenario. Use guest feedback proactively. Thank you for playing!",
			"",
			[...tools, "guest_feedback"],
		).kind,
		"none",
	);
	// One-word tool names are ordinary English and only count as code.
	assert.equal(detectToolCallSignal("I'll wait for the first guests to arrive.", "", tools).kind, "none");
	assert.equal(detectToolCallSignal("I'll call `wait` now.", "", tools).kind, "tool_name");
	assert.equal(detectToolCallSignal("Now I will evaluate the options.", "", tools).kind, "none");
	assert.equal(detectToolCallSignal("Then I await(the next result).", "", tools).kind, "none", "await( is not wait(");
	// Plain mid-plan narration, which is what the run must NOT be ended on while the scenario
	// is still running.
	assert.equal(detectToolCallSignal("I'll list the available ride objects to see our options.", "", tools).kind, "none");
});
