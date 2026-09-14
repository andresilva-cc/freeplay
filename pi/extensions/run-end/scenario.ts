/**
 * Where the scenario stands: read off a tool result when the model happens to look, polled
 * off the bridge when it does not.
 *
 * OpenRCT2 reports `scenario.status` as `inProgress`, `completed` or `failed`, and there is
 * no hook for it changing — so the bridge samples it once an in-game day and reports the
 * verdict two ways. `GET /v1` carries `scenario` with the live status and the in-game day it
 * ended on; every MCP tool result carries `scenarioEnded` from the day it happens. Watching
 * results alone still has the blind spot that matters — a model that stops calling tools
 * altogether shows nothing — so this polls as well.
 *
 * The poll is now `GET /v1`, one plain HTTP read with no MCP session behind it. It replaced a
 * `POST /mcp` park_status call that walked the whole park for one string. That call had to
 * keep its OWN MCP session, because `gameDaysSinceLastCall` is measured per session
 * (`McpSession.lastResultAt` in servers/openrct2/src/mcp.ts) and polling on the model's
 * session would have reset the figure the model is shown. `GET /v1` has no session to keep,
 * so that whole concern is gone rather than managed.
 *
 * park_status stays as a fallback, reached only when `GET /v1` answers without a scenario.
 * The plugin is copied into OpenRCT2's own plugin directory by hand (`npm run copy`), so a
 * bridge older than this field is a real state and not a hypothetical, and the failure it
 * would otherwise cause is silent: no verdict, ever, and every run ending on the budget.
 *
 * What is NOT used is `GET /v1/eval?q=scenario.status`. It runs JavaScript through the same
 * guards the run's honesty rests on, and the harness is the last thing that should be typing
 * into it.
 */

export type ScenarioStatus = "inProgress" | "completed" | "failed";

/** An in-game date, in the three numbers the bridge reports dates in. */
export interface GameDay {
	year: number;
	month: number;
	day: number;
}

export interface ScenarioReading {
	status: ScenarioStatus;
	name?: string;
	objective?: unknown;
	/** The in-game day the scenario ended, where the bridge recorded one. */
	endedOn?: GameDay;
	/** Where this reading came from: the model's own tool result, our index read, or our poll. */
	source: "tool_result" | "bridge_index" | "poll";
	observedAt: string;
}

export function isDecided(status: ScenarioStatus | undefined): boolean {
	return status === "completed" || status === "failed";
}

function asStatus(value: unknown): ScenarioStatus | undefined {
	return value === "inProgress" || value === "completed" || value === "failed" ? value : undefined;
}

function asGameDay(value: unknown): GameDay | undefined {
	if (!value || typeof value !== "object") return undefined;
	const day = value as Record<string, unknown>;
	if (typeof day.year !== "number" || typeof day.month !== "number" || typeof day.day !== "number") {
		return undefined;
	}
	return { year: day.year, month: day.month, day: day.day };
}

/**
 * Pull `scenario` out of a park_status result.
 *
 * The bridge answers `{content:[{type:"text",text:"<json>"}], structuredContent:{...}}`, and
 * pi's tool_result event carries the content blocks. Parsed leniently: a result that is not
 * JSON, or JSON without a scenario, is simply not a reading — never an error, because a
 * malformed result must not be able to end somebody's run.
 */
export function readScenarioFromToolResult(content: readonly unknown[] | undefined): ScenarioReading | undefined {
	if (!Array.isArray(content)) return undefined;

	for (const block of content) {
		const b = block as Record<string, unknown> | null;
		if (!b || b.type !== "text" || typeof b.text !== "string") continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(b.text);
		} catch {
			continue;
		}

		const reading = readScenarioFromValue(parsed, "tool_result");
		if (reading) return reading;
	}

	return undefined;
}

/**
 * Two shapes are read here, because the bridge says this in two places.
 *
 * `scenario: {name, objective, status, endedOn}` is what `GET /v1` carries and what
 * `park_status` has always carried (without `endedOn`). `scenarioEnded: {status, year,
 * month, day}` is the field every MCP tool result carries once the scenario is over — so a
 * turn that called `view_map` and nothing else now shows the verdict too, which is exactly
 * the blind spot that let one recorded run play on past a failure.
 */
export function readScenarioFromValue(value: unknown, source: ScenarioReading["source"]): ScenarioReading | undefined {
	if (!value || typeof value !== "object") return undefined;
	const root = value as Record<string, unknown>;
	const observedAt = new Date().toISOString();

	const ended = root.scenarioEnded as Record<string, unknown> | undefined;
	const endedStatus = ended ? asStatus(ended.status) : undefined;
	const endedOn = ended ? asGameDay(ended) : undefined;

	const scenario = root.scenario;
	if (scenario && typeof scenario === "object") {
		const record = scenario as Record<string, unknown>;
		const status = asStatus(record.status);
		if (status) {
			return {
				status,
				name: typeof record.name === "string" ? record.name : undefined,
				objective: record.objective,
				endedOn: asGameDay(record.endedOn) ?? endedOn,
				source,
				observedAt,
			};
		}
	}

	// No scenario block, but the result says the run is over. That is still a reading.
	if (endedStatus) return { status: endedStatus, endedOn, source, observedAt };

	return undefined;
}

export type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<{
	ok: boolean;
	status: number;
	headers: { get(name: string): string | null };
	text(): Promise<string>;
}>;

export interface PollerOptions {
	baseUrl: string;
	fetchImpl?: FetchLike;
	timeoutMs?: number;
	/** Injected in tests so the clock is not real. */
	now?: () => number;
}

const PROTOCOL_VERSION = "2025-11-25";

/**
 * One poll is one `GET /v1`. On a bridge too old to carry the scenario there it is three
 * requests on a cold MCP session (initialize, notifications/initialized, tools/call) and one
 * on a warm one; the session is reused for the life of the run and re-established once if the
 * game restarts and forgets it.
 */
export function createScenarioPoller(options: PollerOptions) {
	const baseUrl = options.baseUrl.replace(/\/+$/, "");
	const doFetch: FetchLike = options.fetchImpl ?? ((input, init) => (globalThis as any).fetch(input, init));
	const timeoutMs = options.timeoutMs ?? 15000;
	let sessionId: string | undefined;
	let nextId = 1;
	/** False once `GET /v1` has answered without a scenario: an older bridge, so stop asking. */
	let indexCarriesScenario = true;

	async function post(body: Record<string, unknown>, withSession: boolean) {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};
		if (withSession && sessionId) {
			headers["MCP-Session-Id"] = sessionId;
			headers["MCP-Protocol-Version"] = PROTOCOL_VERSION;
		}

		return doFetch(`${baseUrl}/mcp`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
	}

	async function openSession(): Promise<void> {
		const response = await post(
			{
				jsonrpc: "2.0",
				id: nextId++,
				method: "initialize",
				params: {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "freeplay-run-end", version: "1" },
				},
			},
			false,
		);
		if (!response.ok) throw new Error(`initialize failed with HTTP ${response.status}`);

		const id = response.headers.get("MCP-Session-Id") ?? response.headers.get("mcp-session-id");
		if (!id) throw new Error("initialize returned no MCP-Session-Id");
		sessionId = id;

		// The bridge refuses every method but `ping` until this notification arrives.
		await post({ jsonrpc: "2.0", method: "notifications/initialized" }, true);
	}

	/**
	 * The cheap read. A throw is the bridge being unreachable and is the caller's "unknown";
	 * `undefined` is a bridge that answered without a scenario, which is an older plugin and
	 * is what the park_status fallback below is for.
	 */
	async function readIndex(): Promise<ScenarioReading | undefined> {
		const response = await doFetch(`${baseUrl}/v1`, {
			method: "GET",
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return undefined;

		let body: unknown;
		try {
			body = JSON.parse(await response.text());
		} catch {
			return undefined;
		}

		return readScenarioFromValue(body, "bridge_index");
	}

	async function callParkStatus() {
		return post(
			{ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: "park_status", arguments: {} } },
			true,
		);
	}

	/**
	 * Returns a reading, or throws. Callers must treat a throw as "unknown", never as an end
	 * condition: a bridge that is down is not a scenario that is decided.
	 */
	return async function poll(): Promise<ScenarioReading | undefined> {
		if (indexCarriesScenario) {
			const fromIndex = await readIndex();
			if (fromIndex) return fromIndex;
			indexCarriesScenario = false;
		}

		if (!sessionId) await openSession();

		let response = await callParkStatus();

		// 404 is the bridge saying it has never heard of this session, which is what a game
		// restart looks like from here. Re-open once and ask again.
		if (response.status === 404) {
			sessionId = undefined;
			await openSession();
			response = await callParkStatus();
		}

		if (!response.ok) throw new Error(`park_status failed with HTTP ${response.status}`);

		const envelope = JSON.parse(await response.text()) as Record<string, unknown>;
		if (envelope.error) throw new Error(`park_status returned a JSON-RPC error: ${JSON.stringify(envelope.error)}`);

		const result = envelope.result as Record<string, unknown> | undefined;
		if (!result) throw new Error("park_status returned no result");

		const structured = readScenarioFromValue(result.structuredContent, "poll");
		if (structured) return structured;

		const fromContent = readScenarioFromToolResult(result.content as unknown[] | undefined);
		return fromContent ? { ...fromContent, source: "poll" } : undefined;
	};
}
