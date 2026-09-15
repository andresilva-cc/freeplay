/**
 * Unit test for pi/extensions/run-end.
 *
 * Run: node --test pi/extensions/run-end/test/unit.test.ts
 *
 * SCOPE, stated plainly. This drives the extension's own handlers with synthetic events whose
 * shapes were read off pi 0.85.1's TurnEndEvent / ToolResultEvent / AgentSettledEvent /
 * SessionShutdownEvent definitions, and it stubs globalThis.fetch rather than the poller, so
 * the MCP handshake the poller builds — initialize, notifications/initialized, tools/call — is
 * exercised for real against a fake bridge. The fake bridge answers the three REST reads the
 * record's snapshot is built from (`GET /v1`, `/v1/park`, `/v1/date`) with the field names
 * servers/openrct2/src/app.ts, parkInfo.ts and gameDate.ts actually serve. What it does NOT
 * prove is that pi actually quits when ctx.shutdown() is called; it proves only that the
 * extension calls it, having written the record first.
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
import { DAYS_IN_YEAR, dayNumber, readGameTimeFromValue } from "../gameTime.ts";
import { appendEntry, openRunEndLog } from "../record.ts";
import {
	announceIntervention,
	answerInterventionCensus,
	KNOWN_INTERVENTIONS,
	type InterventionReport,
} from "../interventions.ts";

const AGENT_DIR = mkdtempSync(join(tmpdir(), "run-end-unit-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.FREEPLAY_BRIDGE_URL = "http://127.0.0.1:8080";

const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
	rmSync(AGENT_DIR, { recursive: true, force: true });
});

interface GameDate {
	year: number;
	month: number;
	day: number;
	monthsElapsed: number;
	monthProgress: number;
	ticksElapsed: number;
}

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
	/**
	 * An older plugin again, this time one whose guard summary is the four fields it had
	 * before `unexamined`: a build that swept no namespace and cannot say so.
	 */
	guardsPredateUnexamined?: boolean;
	/** Members of the plugin API this build has no verdict on, where it has any. */
	guardsUnexamined?: string[];
	/** The in-game day `GET /v1` says the scenario ended on, where it says one. */
	endedOn?: { year: number; month: number; day: number };
	/** Where the game clock stands. Day 1 of year 1 is the start of a scenario. */
	date?: GameDate;
	/** REST paths that answer HTTP 503, for the degrading-snapshot tests. */
	failing?: string[];
}

const START_OF_SCENARIO: GameDate = { year: 1, month: 0, day: 1, monthsElapsed: 0, monthProgress: 0, ticksElapsed: 0 };

/** A fake bridge that speaks just enough HTTP and MCP Streamable HTTP for the poller. */
function installBridge(stub: BridgeStub): void {
	const json = (body: unknown) => ({
		ok: true,
		status: 200,
		headers: { get: () => null },
		text: async () => JSON.stringify(body),
	});

	globalThis.fetch = (async (input: any, init: any) => {
		if (!init?.body) {
			// The REST reads: the poll and the snapshot, neither of which opens an MCP session.
			const url = String(input);
			const path = url.slice(url.indexOf("/v1"));
			stub.calls.push(`GET ${path}`);

			if (stub.status === "throw") throw new Error("bridge is not answering");
			if (stub.failing?.includes(path)) {
				return { ok: false, status: 503, headers: { get: () => null }, text: async () => "" };
			}

			if (path === "/v1/date") return json(stub.date ?? START_OF_SCENARIO);
			if (path === "/v1/park") {
				return json({
					name: "Forest Frontiers",
					numGuests: 42,
					rating: 780,
					cash: 12_500,
					bankLoan: 10_000,
					companyValue: 80_000,
					parkValue: 55_000,
					entranceFee: 100,
				});
			}

			assert.equal(path, "/v1", "the extension must only read the three documented REST paths");
			const index: Record<string, unknown> = {
				buildId: "test-build",
				controllers: [],
				stateGuards: stub.guardsPredateUnexamined
					? { ok: true, frozen: 56, unfrozen: [], open: [] }
					: {
							ok: (stub.guardsUnexamined ?? []).length === 0,
							frozen: 56,
							unfrozen: [],
							open: ["ride.price", "staff.orders"],
							unexamined: stub.guardsUnexamined ?? [],
						},
			};
			if (!stub.indexHasNoScenario) {
				index.scenario = {
					name: "Forest Frontiers",
					objective: { type: "guestsBy" },
					status: stub.status,
					endedOn: stub.endedOn ?? null,
				};
			}

			return json(index);
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
	/**
	 * The same EventBus stand-in the extension was handed, so a test can subscribe to it the
	 * way another extension does — synchronously, through the real helpers in interventions.ts
	 * rather than through a copy of them.
	 */
	bus: { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): void };
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
		bus: {
			emit: (channel, data) => {
				for (const fn of busHandlers.get(channel) ?? []) fn(data);
			},
			on: (channel, fn) => {
				if (!busHandlers.has(channel)) busHandlers.set(channel, []);
				busHandlers.get(channel)!.push(fn);
			},
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
		// Shaped like pi/models.json, which is where the sampling params the record has to
		// carry actually live.
		model: {
			id: "gemma-4-26B-A4B-it-qat-5bit",
			name: "Gemma 4 26B-A4B (5bit QAT, local)",
			reasoning: true,
			contextWindow: 65536,
			maxTokens: 8192,
			samplingParams: { presence_penalty: 0.5 },
		},
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
	const payload = {
		scenario: { name: "Forest Frontiers", objective: { type: "guestsBy" }, status },
		date: { year: 1, month: 0, day: 1 },
		gameDaysSinceLastCall: 0,
	};
	return {
		toolCallId: "c1",
		toolName: "park_status",
		input: {},
		content: [{ type: "text", text: JSON.stringify(payload) }],
		isError: false,
	};
}

/** A `wait` outcome, in the shape servers/openrct2/src/tools/wait.ts answers with. */
function waitResult(from: { year: number; month: number; day: number }, days: number, to: { year: number; month: number; day: number }) {
	const payload = {
		ok: true,
		daysRequested: days,
		days,
		ticks: days * 40 * 13,
		complete: true,
		seconds: 20,
		speed: 4,
		from,
		to,
		guests: 42,
		guestsChange: 3,
		cash: 12_500,
		cashChange: 100,
		rating: 780,
		ratingChange: 5,
		newMessageCount: 0,
		newMessages: [],
		detail: "The game ran.",
		gameDaysSinceLastCall: days,
	};
	return {
		toolCallId: "w1",
		toolName: "wait",
		input: { days },
		content: [{ type: "text", text: JSON.stringify(payload) }],
		isError: false,
	};
}

/** A tool that acts and reports no date at all, which is most of them. */
function silentResult(sinceLastCall = 0) {
	const payload = { ok: true, placed: 1, gameDaysSinceLastCall: sinceLastCall };
	return {
		toolCallId: "b1",
		toolName: "build_path",
		input: {},
		content: [{ type: "text", text: JSON.stringify(payload) }],
		isError: false,
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Long enough for an unawaited poll or snapshot against the stub to land. */
const settle = () => sleep(30);

async function start(stub: BridgeStub): Promise<Harness> {
	installBridge(stub);
	const h = makeHarness();
	await h.fire("session_start", { reason: "startup" });
	// The opening snapshot is fired and not awaited, on purpose: see session_start.
	await settle();
	await h.fire("turn_start", { turnIndex: 0, timestamp: Date.now() });
	return h;
}

const turnEnd = (index = 0) => ({ turnIndex: index, message: { role: "assistant" }, toolResults: [] });

test("a scenario the model reads as completed ends the run and writes the record", async () => {
	const h = await start({ status: "inProgress", calls: [] });
	await h.fire("tool_result", parkStatusResult("completed"));
	await h.fire("turn_end", turnEnd());
	await settle();

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
	await h.fire("turn_end", turnEnd());
	await settle();

	const record = h.record();
	assert.ok(record);
	assert.equal(record.condition, "scenario_decided");
	assert.equal(record.scenario.status, "failed");
	assert.equal(h.shutdowns, 1);
});

test("the blind spot is covered: a flip the model never reads is found by the poll", async () => {
	// The model calls nothing at all this turn, so a result-watching extension would see
	// nothing. The bridge says the scenario is over, and says it on plain GETs: no MCP
	// session is opened, so there is no per-session gameDaysSinceLastCall to disturb.
	const stub: BridgeStub = { status: "completed", calls: [], endedOn: { year: 2, month: 3, day: 14 } };
	const h = await start(stub);
	await h.fire("turn_end", turnEnd());
	// turn_end does not await its own poll, on purpose: see the handler.
	await settle();

	assert.ok(
		stub.calls.every((call) => call.startsWith("GET ")),
		"nothing the extension does may open an MCP session of its own",
	);
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
	// condition, ever, and every run stopping on the wall-clock net instead.
	const stub: BridgeStub = { status: "failed", calls: [], indexHasNoScenario: true };
	const h = await start(stub);
	await h.fire("turn_end", turnEnd());
	await settle();

	assert.ok(
		stub.calls.includes("initialize") && stub.calls.includes("tools/call"),
		"the fallback is the whole point of keeping park_status",
	);
	const record = h.record();
	assert.ok(record);
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
	await h.fire("turn_end", turnEnd());
	await settle();

	const record = h.record();
	assert.ok(record, "a run that ended must be recorded whichever tool showed it");
	assert.equal(record.condition, "scenario_decided");
	assert.equal(record.scenario.status, "failed");
	assert.equal(record.scenario.source, "tool_result");
	assert.deepEqual(record.scenario.endedOn, { year: 1, month: 5, day: 12 });
});

test("a poll that throws never ends the run", async () => {
	const h = await start({ status: "throw", calls: [] });
	await h.fire("turn_end", turnEnd());
	await settle();

	assert.equal(h.record(), undefined, "a bridge that is down is not a scenario that is decided");
	assert.equal(h.shutdowns, 0);
	assert.equal(h.aborts, 0);
	assert.ok(
		h.logLines().some((l) => l.event === "poll_failed"),
		"the failure must still be recorded",
	);
	await h.fire("session_shutdown", { reason: "quit" });
});

test("the game-day budget ends the run once the scenario has been played that far", async () => {
	// THE DEFECT THIS EXTENSION WAS FIXED FOR. The budget used to be 45 minutes of wall
	// clock, which buys four times as much scenario for a fast model as for a slow one. It
	// is game days now: the same amount of SCENARIO whatever the host does.
	process.env.FREEPLAY_RUN_BUDGET_DAYS = "12";
	try {
		const h = await start({ status: "inProgress", calls: [] });
		await h.fire("tool_result", waitResult({ year: 1, month: 0, day: 1 }, 12, { year: 1, month: 0, day: 13 }));
		await settle();

		const record = h.record();
		assert.ok(record, "a run that has spent its game days must end");
		assert.equal(record.condition, "game_days_exhausted");
		assert.equal(record.gameDays.spent, 12);
		assert.equal(record.gameDays.source, "date", "the date at both ends is the honest meter");
		assert.equal(record.gameDays.budget, 12);
		assert.equal(record.gameDays.inWait, 12);
		assert.equal(record.gameDays.waitCalls, 1);
		assert.deepEqual(record.gameDays.startedOn, { year: 1, month: 0, day: 1 });
		assert.deepEqual(record.gameDays.reachedOn, { year: 1, month: 0, day: 13 });
		assert.equal(h.shutdowns, 1);
		assert.equal(h.aborts, 1);
	} finally {
		delete process.env.FREEPLAY_RUN_BUDGET_DAYS;
	}
});

test("the wall-clock net never fires on a run that has spent its game days", async () => {
	// Both budgets are blown at the same instant. A played-out run must be recorded as
	// played out: `wall_clock_exhausted` on this run would say the model was abandoned when
	// it had actually finished its scenario.
	process.env.FREEPLAY_RUN_BUDGET_DAYS = "12";
	process.env.FREEPLAY_RUN_BUDGET_MINUTES = "0.0002"; // 12ms
	try {
		const h = await start({ status: "inProgress", calls: [] });
		await sleep(40);
		await h.fire("tool_result", waitResult({ year: 1, month: 0, day: 1 }, 12, { year: 1, month: 0, day: 13 }));
		await settle();

		const record = h.record();
		assert.ok(record);
		assert.equal(record.condition, "game_days_exhausted", "game days are checked before the net, not after");
		assert.ok(record.elapsedMs >= 12, "the wall clock was over its cap as well, and lost");
	} finally {
		delete process.env.FREEPLAY_RUN_BUDGET_DAYS;
		delete process.env.FREEPLAY_RUN_BUDGET_MINUTES;
	}
});

test("a model that never calls wait still terminates, and the record says it was abandoned", async () => {
	// Game time only moves inside `wait`, so a model that never waits can never exhaust a
	// game-day budget. This is the case the net exists for, and the case that must never be
	// read as a result about how the model plays.
	process.env.FREEPLAY_RUN_BUDGET_MINUTES = "0.0002"; // 12ms
	try {
		const h = await start({ status: "inProgress", calls: [] });
		await h.fire("tool_result", silentResult());
		await h.fire("tool_result", silentResult());
		await sleep(40);
		await h.fire("turn_end", turnEnd());
		await settle();

		const record = h.record();
		assert.ok(record, "the net must write the same record");
		assert.equal(record.condition, "wall_clock_exhausted");
		assert.equal(record.wallClockBudgetMs, 12);
		assert.ok(record.elapsedMs >= 12);
		assert.equal(record.gameDays.spent, 0, "not one game day was spent, and the record says so");
		assert.equal(record.gameDays.waitCalls, 0);
		assert.ok(record.gameDays.spent < record.gameDays.budget, "the game-day budget was NOT exhausted");
		assert.match(record.detail, /abandoned, not played out/);
		assert.equal(h.shutdowns, 1);
		assert.equal(h.aborts, 1);
	} finally {
		delete process.env.FREEPLAY_RUN_BUDGET_MINUTES;
	}
});

test("the two budget conditions are told apart by the record, not by its prose", async () => {
	// A reader who never opens `detail` still has to be able to separate a played-out run
	// from an abandoned one, because that is the difference between a citable number and a
	// machine's bad afternoon.
	process.env.FREEPLAY_RUN_BUDGET_DAYS = "6";
	process.env.FREEPLAY_RUN_BUDGET_MINUTES = "0.0002";
	let abandoned: any;
	let playedOut: any;
	try {
		const slow = await start({ status: "inProgress", calls: [] });
		await sleep(40);
		await slow.fire("turn_end", turnEnd());
		await settle();
		abandoned = slow.record();

		const fast = await start({ status: "inProgress", calls: [] });
		await fast.fire("tool_result", waitResult({ year: 1, month: 0, day: 1 }, 6, { year: 1, month: 0, day: 7 }));
		await settle();
		playedOut = fast.record();
	} finally {
		delete process.env.FREEPLAY_RUN_BUDGET_DAYS;
		delete process.env.FREEPLAY_RUN_BUDGET_MINUTES;
	}

	assert.ok(abandoned && playedOut);
	assert.notEqual(abandoned.condition, playedOut.condition);
	assert.equal(abandoned.condition, "wall_clock_exhausted");
	assert.equal(playedOut.condition, "game_days_exhausted");
	assert.ok(abandoned.gameDays.spent < abandoned.gameDays.budget);
	assert.ok(playedOut.gameDays.spent >= playedOut.gameDays.budget);
});

test("game days are still measured when the opening snapshot never landed", async () => {
	// The bridge answers nothing at the start, so there is no date to measure from. Every
	// tool result carries the bridge's own bill for the turn before it, which is what covers
	// that — and the record says which meter answered rather than quietly changing units.
	process.env.FREEPLAY_RUN_BUDGET_DAYS = "9";
	try {
		const stub: BridgeStub = { status: "throw", calls: [] };
		const h = await start(stub);

		// The bridge comes back, but nothing re-reads a start that has already gone by.
		stub.status = "inProgress";
		await h.fire("tool_result", silentResult(4));
		await h.fire("tool_result", silentResult(5));
		await settle();

		const record = h.record();
		assert.ok(record, "a run with no opening snapshot must still be able to end on its budget");
		assert.equal(record.condition, "game_days_exhausted");
		assert.equal(record.gameDays.source, "since_last_call");
		assert.equal(record.gameDays.spent, 9);
		assert.equal(record.startState.ok, false, "the failed opening snapshot is recorded as failed");
		assert.match(String(record.startState.note), /GET \/v1/);
	} finally {
		delete process.env.FREEPLAY_RUN_BUDGET_DAYS;
	}
});

test("both ends of the run are snapshotted into the record", async () => {
	// A run that ends on a budget used to record nothing about where it got to. Two runs
	// that both ran out of budget were comparable on nothing at all.
	process.env.FREEPLAY_RUN_BUDGET_DAYS = "5";
	try {
		const stub: BridgeStub = { status: "inProgress", calls: [] };
		const h = await start(stub);
		stub.date = { year: 1, month: 0, day: 6, monthsElapsed: 0, monthProgress: 10_568, ticksElapsed: 16_000 };
		await h.fire("tool_result", waitResult({ year: 1, month: 0, day: 1 }, 5, { year: 1, month: 0, day: 6 }));
		await settle();

		const record = h.record();
		assert.ok(record);
		assert.equal(record.condition, "game_days_exhausted");

		for (const state of [record.startState, record.endState]) {
			assert.ok(state, "both ends of the run have to be in the record");
			assert.equal(state.ok, true);
			assert.equal(state.note, null);
			assert.equal(state.buildId, "test-build", "a result has to name the plugin build it was played on");
			assert.deepEqual(state.guards, {
				ok: true,
				frozen: 56,
				unfrozen: [],
				open: ["ride.price", "staff.orders"],
				unexamined: [],
			}, "all four guard categories reach the record, `unexamined` included");
			assert.equal(state.scenario.name, "Forest Frontiers");
			assert.equal(state.scenario.status, "inProgress");
			assert.equal(state.park.guests, 42);
			assert.equal(state.park.cash, 12_500);
			assert.equal(state.park.rating, 780);
			assert.equal(state.park.parkValue, 55_000, "only GET /v1/park carries park value at all");
		}

		assert.deepEqual(
			{ year: record.startState.date.year, month: record.startState.date.month, day: record.startState.date.day },
			{ year: 1, month: 0, day: 1 },
			"where the run began",
		);
		assert.equal(record.endState.date.day, 6, "and where it stopped");
		assert.equal(record.modelParams.samplingParams.presence_penalty, 0.5,
			"a run compared against sampling params it never had is the c32a402 defect");
		assert.equal(record.modelParams.reasoning, true);

		const started = h.logLines().find((l) => l.event === "run_start_state");
		assert.ok(started, "the opening state is its own line as well, so it survives a lost record");
		assert.equal(started.state.park.guests, 42);
	} finally {
		delete process.env.FREEPLAY_RUN_BUDGET_DAYS;
	}
});

test("the record names the members nobody swept, not merely that the guards were not ok", async () => {
	// The same defect as 39f4a72, one layer down. The bridge learned to say which lever it
	// was; this reader picked the guard fields by name and kept four of the five, so a
	// published record carried `ok: false` with three empty lists and no reason anywhere in
	// it. Anyone reading the run afterwards would have had to go back to a bridge that is no
	// longer running to find out what the guards had found.
	process.env.FREEPLAY_RUN_BUDGET_DAYS = "5";
	try {
		const stub: BridgeStub = {
			status: "inProgress",
			calls: [],
			guardsUnexamined: ["date.quarterProgress", "and 3 more"],
		};
		const h = await start(stub);
		stub.date = { year: 1, month: 0, day: 6, monthsElapsed: 0, monthProgress: 10_568, ticksElapsed: 16_000 };
		await h.fire("tool_result", waitResult({ year: 1, month: 0, day: 1 }, 5, { year: 1, month: 0, day: 6 }));
		await settle();

		const record = h.record();
		assert.ok(record);

		for (const state of [record.startState, record.endState]) {
			assert.equal(state.guards.ok, false, "the bridge says its own check failed");
			assert.deepEqual(state.guards.unexamined, ["date.quarterProgress", "and 3 more"],
				"and the record has to carry which member it was, capping and all: "
				+ JSON.stringify(state.guards));
			assert.deepEqual(state.guards.unfrozen, [], "it is not a refusal");
			assert.deepEqual(state.guards.open, ["ride.price", "staff.orders"],
				"and it is not one of the levers left open on purpose, which ride alongside a"
				+ " green check rather than failing it");
		}

		assert.equal(record.startState.ok, true, "a guard verdict of false is not a failed read");
		assert.equal(record.startState.note, null);
	} finally {
		delete process.env.FREEPLAY_RUN_BUDGET_DAYS;
	}
});

test("a bridge whose guard summary predates `unexamined` still writes a record, and says the field is absent", async () => {
	// Old plugin, new extension. The record must not be lost over a missing field, and the
	// missing field must not be published as an empty list: "nobody looked" recorded as
	// "nothing to find" is the thing this whole category exists to stop.
	process.env.FREEPLAY_RUN_BUDGET_DAYS = "5";
	try {
		const stub: BridgeStub = { status: "inProgress", calls: [], guardsPredateUnexamined: true };
		const h = await start(stub);
		stub.date = { year: 1, month: 0, day: 6, monthsElapsed: 0, monthProgress: 10_568, ticksElapsed: 16_000 };
		await h.fire("tool_result", waitResult({ year: 1, month: 0, day: 1 }, 5, { year: 1, month: 0, day: 6 }));
		await settle();

		const record = h.record();
		assert.ok(record, "an older bridge must still produce a record");
		assert.equal(record.condition, "game_days_exhausted");
		assert.equal(record.endState.buildId, "test-build", "and everything it did answer is still in it");
		assert.equal(record.endState.park.guests, 42);
		assert.equal(record.endState.guards.frozen, 56, "including the four fields it does have");
		assert.deepEqual(record.endState.guards.open, []);

		assert.equal(record.endState.guards.unexamined, null,
			"the field it does not have is null, never []: " + JSON.stringify(record.endState.guards));
		assert.match(record.endState.note, /predates the field/);
		assert.equal(record.endState.ok, false, "and the snapshot says it is not a complete reading");
	} finally {
		delete process.env.FREEPLAY_RUN_BUDGET_DAYS;
	}
});

test("a snapshot that cannot be taken degrades to missing fields and a reason", async () => {
	// Never a lost record and never an invented number: the two ways this could have been
	// written wrong.
	process.env.FREEPLAY_RUN_BUDGET_DAYS = "5";
	try {
		const stub: BridgeStub = { status: "inProgress", calls: [], failing: ["/v1/park"] };
		const h = await start(stub);
		await h.fire("tool_result", waitResult({ year: 1, month: 0, day: 1 }, 5, { year: 1, month: 0, day: 6 }));
		await settle();

		const record = h.record();
		assert.ok(record, "a failed snapshot must never cost the record");
		assert.equal(record.condition, "game_days_exhausted");
		assert.equal(record.gameDays.spent, 5, "the measurement that did work is still reported");
		assert.equal(record.endState.ok, false);
		assert.equal(record.endState.park, null, "a park that could not be read is null, not zeroes");
		assert.match(record.endState.note, /GET \/v1\/park failed/);
		assert.equal(record.endState.buildId, "test-build", "what did answer is still recorded");
		assert.ok(record.endState.date, "and so is the rest of it");
	} finally {
		delete process.env.FREEPLAY_RUN_BUDGET_DAYS;
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
	assert.ok(record.endState, "even a Ctrl+C gets the last state that was read");
	assert.match(record.endState.note, /shutting down/);
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

/** An intervention's answer to the census, in the shape its own extension pushes. */
function reportOf(id: string, armed: boolean, fired = 0): InterventionReport {
	return {
		id,
		armed,
		how: armed ? "switched on for this run" : "off by default",
		fired,
		detail: armed ? "changed what the model saw" : "changed nothing",
	};
}

test("an armed intervention is named in the run-end record", async () => {
	// THE DEFECT. reasoning-placeholder reads an env var, and by its own arithmetic it can only
	// fire on Gemma. Before this field a run with that variable set produced a record
	// indistinguishable from a run without it.
	const h = await start({ status: "inProgress", calls: [] });
	answerInterventionCensus(h.bus, () => reportOf("reasoning-placeholder", true, 7));
	await h.fire("session_shutdown", { reason: "quit" });

	const record = h.record();
	assert.ok(record);
	assert.equal(record.interventions.disclosed, true);
	assert.deepEqual(record.interventions.armed, ["reasoning-placeholder"]);
	const entry = record.interventions.all.find((i: any) => i.id === "reasoning-placeholder");
	assert.ok(entry, "an armed intervention has to be in the full list as well as the armed list");
	assert.equal(entry.armed, true);
	assert.equal(entry.fired, 7, "how often it fired is part of the disclosure");
});

test("a disarmed intervention is recorded as absent, not left out", async () => {
	// "not in the list" and "not armed" have to be different states, or a reader cannot tell a
	// clean run from a record that was written by an older harness.
	const h = await start({ status: "inProgress", calls: [] });
	answerInterventionCensus(h.bus, () => reportOf("reasoning-placeholder", false));
	answerInterventionCensus(h.bus, () => reportOf("tool-less-turn-nudge", true, 2));
	await h.fire("session_shutdown", { reason: "quit" });

	const record = h.record();
	assert.ok(record);
	assert.deepEqual(record.interventions.armed, ["tool-less-turn-nudge"]);
	const off = record.interventions.all.find((i: any) => i.id === "reasoning-placeholder");
	assert.ok(off, "the one that was switched off must still be in the record");
	assert.equal(off.armed, false);
	assert.equal(off.fired, 0);
});

test("an intervention that answers nothing is still listed, so an empty armed list is a claim", async () => {
	const h = await start({ status: "inProgress", calls: [] });
	await h.fire("session_shutdown", { reason: "quit" });

	const record = h.record();
	assert.ok(record);
	assert.deepEqual(record.interventions.armed, []);
	assert.deepEqual(
		record.interventions.all.map((i: any) => i.id).sort(),
		[...KNOWN_INTERVENTIONS].sort(),
		"every registered intervention is in the record whether or not it was loaded",
	);
	for (const entry of record.interventions.all) {
		assert.equal(entry.armed, false);
		assert.equal(entry.how, "not loaded", "and it says which of the two silences this was");
	}
});

test("an intervention nobody registered discloses itself on the strength of its answer", async () => {
	// The rule is about the next intervention as much as these two: answering the census is
	// enough to be in the record, so a new extension cannot be undisclosed by being new.
	const h = await start({ status: "inProgress", calls: [] });
	answerInterventionCensus(h.bus, () => reportOf("some-later-intervention", true, 1));
	await h.fire("session_shutdown", { reason: "quit" });

	const record = h.record();
	assert.ok(record);
	assert.ok(record.interventions.armed.includes("some-later-intervention"));
	assert.equal(record.interventions.all.length, KNOWN_INTERVENTIONS.length + 1);
});

test("an announcement at session_start survives a census answer that never comes", async () => {
	// EventEmitter.emit stops dispatching at the first subscriber that throws, so the census
	// alone could be silenced by an unrelated extension. The announcement is the other half.
	const h = await start({ status: "inProgress", calls: [] });
	announceIntervention(h.bus, reportOf("reasoning-placeholder", true, 3));
	await h.fire("session_shutdown", { reason: "quit" });

	const record = h.record();
	assert.ok(record);
	assert.deepEqual(record.interventions.armed, ["reasoning-placeholder"]);
	assert.equal(record.interventions.all.find((i: any) => i.id === "reasoning-placeholder").fired, 3);

	const announcement = h.logLines().find((l) => l.event === "intervention_armed");
	assert.ok(announcement, "the announcement is logged when it lands, so a run with no record still says it");
	assert.equal(announcement.id, "reasoning-placeholder");
	assert.equal(announcement.armed, true);
});

test("every way a run can end writes the interventions field", async () => {
	// The field is only worth anything if it cannot be skipped, and there are five end
	// conditions reaching two different record-writing paths.
	process.env.FREEPLAY_RUN_BUDGET_DAYS = "5";
	const records: any[] = [];
	try {
		const decided = await start({ status: "inProgress", calls: [] });
		answerInterventionCensus(decided.bus, () => reportOf("tool-less-turn-nudge", true, 1));
		await decided.fire("tool_result", parkStatusResult("completed"));
		await decided.fire("turn_end", turnEnd());
		await settle();
		records.push(decided.record());

		const playedOut = await start({ status: "inProgress", calls: [] });
		answerInterventionCensus(playedOut.bus, () => reportOf("tool-less-turn-nudge", true, 1));
		await playedOut.fire("tool_result", waitResult({ year: 1, month: 0, day: 1 }, 5, { year: 1, month: 0, day: 6 }));
		await settle();
		records.push(playedOut.record());

		process.env.FREEPLAY_RUN_BUDGET_MINUTES = "0.0002"; // 12ms, for this one run only
		const abandoned = await start({ status: "inProgress", calls: [] });
		answerInterventionCensus(abandoned.bus, () => reportOf("tool-less-turn-nudge", true, 1));
		await sleep(40);
		await abandoned.fire("turn_end", turnEnd());
		await settle();
		records.push(abandoned.record());
		delete process.env.FREEPLAY_RUN_BUDGET_MINUTES;

		const stopped = await start({ status: "inProgress", calls: [] });
		answerInterventionCensus(stopped.bus, () => reportOf("tool-less-turn-nudge", true, 1));
		await stopped.fire("agent_settled", {});
		records.push(stopped.record());

		const interrupted = await start({ status: "inProgress", calls: [] });
		answerInterventionCensus(interrupted.bus, () => reportOf("tool-less-turn-nudge", true, 1));
		await interrupted.fire("session_shutdown", { reason: "quit" });
		records.push(interrupted.record());
	} finally {
		delete process.env.FREEPLAY_RUN_BUDGET_DAYS;
		delete process.env.FREEPLAY_RUN_BUDGET_MINUTES;
	}

	assert.deepEqual(
		records.map((r) => r?.condition),
		["scenario_decided", "game_days_exhausted", "wall_clock_exhausted", "model_stopped", "interrupted"],
		"all five end conditions, so none of them is the one that forgets",
	);
	for (const record of records) {
		assert.equal(record.interventions.disclosed, true);
		assert.deepEqual(record.interventions.armed, ["tool-less-turn-nudge"]);
		assert.equal(record.interventions.all.length, KNOWN_INTERVENTIONS.length);
	}
});

test("a run_end record written without a census is marked undisclosed, not clean", () => {
	// The guard in record.ts. A record with the field missing reads as a clean run to anyone
	// who does not already know the field exists, which is the failure this whole thing is
	// about — so appendEntry fills it in and says the harness did not disclose.
	const logFile = openRunEndLog("interventions-guard");
	assert.ok(logFile);
	appendEntry(logFile, { event: "run_end", condition: "interrupted", detail: "written by older code" } as any);

	const written = JSON.parse(readFileSync(logFile, "utf8").trim().split("\n").pop()!);
	assert.equal(written.event, "run_end");
	assert.equal(written.interventions.disclosed, false, "an empty armed list here must not be read as a clean run");
	assert.deepEqual(written.interventions.armed, []);
	assert.deepEqual(written.interventions.all.map((i: any) => i.id).sort(), [...KNOWN_INTERVENTIONS].sort());
	for (const entry of written.interventions.all) assert.equal(entry.how, "unreported");

	// Every other entry type passes through untouched: the guard is about run_end alone.
	appendEntry(logFile, { event: "poll_failed", error: "x", consecutiveFailures: 1, elapsedMs: 0, timestamp: "t" });
	const poll = JSON.parse(readFileSync(logFile, "utf8").trim().split("\n").pop()!);
	assert.equal(poll.interventions, undefined);
});

test("a run ends exactly once", async () => {
	const h = await start({ status: "inProgress", calls: [] });
	await h.fire("tool_result", parkStatusResult("completed"));
	await h.fire("turn_end", turnEnd(0));
	await h.fire("turn_end", turnEnd(1));
	await h.fire("agent_settled", {});
	await h.fire("session_shutdown", { reason: "quit" });
	await settle();

	const lines = h.logLines().filter((l) => l.event === "run_end");
	assert.equal(lines.length, 1);
	assert.equal(lines[0].condition, "scenario_decided",
		"a shutdown landing while the closing snapshot is in the air must not relabel the run");
	assert.equal(h.shutdowns, 1);
});

test("the calendar is the bridge's own, and a scenario year is 245 game days", () => {
	// The default budget is derived from this number, so a wrong one here is a wrong budget.
	// It is the sum of OpenRCT2's days_in_month, mirrored in gameTime.ts from
	// servers/openrct2/src/gameClock.ts. Note it is NOT the 248 quoted in clockGate.ts.
	assert.equal(DAYS_IN_YEAR, 245);
	assert.equal(dayNumber({ year: 1, month: 0, day: 1 }), 0, "a scenario starts on day zero of its own count");
	assert.equal(dayNumber({ year: 1, month: 1, day: 1 }), 31, "March is 31 days");
	assert.equal(dayNumber({ year: 2, month: 0, day: 1 }), 245, "and a year is eight months of them");

	// The three fields the meter reads off a tool result, in the bridge's own names.
	const wait = readGameTimeFromValue({
		from: { year: 1, month: 0, day: 1 },
		to: { year: 1, month: 0, day: 13 },
		days: 12,
		gameDaysSinceLastCall: 12,
	});
	assert.equal(wait?.waitDays, 12);
	assert.equal(wait?.dayNumber, 12);
	assert.equal(wait?.fromDayNumber, 0);
	assert.equal(readGameTimeFromValue({ date: { year: 1, month: 2, day: 5 } })?.dayNumber, 65);
	assert.equal(readGameTimeFromValue({ rows: [] }), undefined, "a result that says nothing about the clock is not a reading");
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
