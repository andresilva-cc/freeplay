/**
 * Where the scenario stands: read off a tool result when the model happens to look, polled
 * off the bridge when it does not.
 *
 * OpenRCT2 reports `scenario.status` as `inProgress`, `completed` or `failed`, and
 * `park_status` carries it. Watching results alone has one blind spot that matters: a model
 * that never calls `park_status` again after the objective resolves never shows the flip, and
 * a result-watching extension would sit there forever. So this also polls.
 *
 * The poll goes through `POST /mcp` — the same public tool the model calls — rather than
 * `GET /v1/eval?q=scenario.status`, which would be one cheap property read. Two reasons. The
 * eval route runs model-authored JavaScript through the same guards the run's honesty rests
 * on, and the harness is the last thing that should be typing into it. And `GET /v1` reports
 * controllers and state guards only; it carries no scenario at all.
 *
 * The poller keeps its OWN MCP session. That is load-bearing rather than tidy:
 * `gameDaysSinceLastCall` is measured per MCP session (`McpSession.lastResultAt` in
 * servers/openrct2/src/mcp.ts), so polling on the model's session would silently reset the
 * clock the model is shown. On its own session the model's figures are untouched.
 */

export type ScenarioStatus = "inProgress" | "completed" | "failed";

export interface ScenarioReading {
	status: ScenarioStatus;
	name?: string;
	objective?: unknown;
	/** Where this reading came from: the model's own tool result, or our poll. */
	source: "tool_result" | "poll";
	observedAt: string;
}

export function isDecided(status: ScenarioStatus | undefined): boolean {
	return status === "completed" || status === "failed";
}

function asStatus(value: unknown): ScenarioStatus | undefined {
	return value === "inProgress" || value === "completed" || value === "failed" ? value : undefined;
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

export function readScenarioFromValue(value: unknown, source: ScenarioReading["source"]): ScenarioReading | undefined {
	if (!value || typeof value !== "object") return undefined;
	const scenario = (value as Record<string, unknown>).scenario;
	if (!scenario || typeof scenario !== "object") return undefined;

	const record = scenario as Record<string, unknown>;
	const status = asStatus(record.status);
	if (!status) return undefined;

	return {
		status,
		name: typeof record.name === "string" ? record.name : undefined,
		objective: record.objective,
		source,
		observedAt: new Date().toISOString(),
	};
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
 * One poll is three requests on a cold session (initialize, notifications/initialized,
 * tools/call) and one on a warm one. The session is reused for the life of the run and
 * re-established once if the game restarts and forgets it.
 */
export function createScenarioPoller(options: PollerOptions) {
	const baseUrl = options.baseUrl.replace(/\/+$/, "");
	const doFetch: FetchLike = options.fetchImpl ?? ((input, init) => (globalThis as any).fetch(input, init));
	const timeoutMs = options.timeoutMs ?? 15000;
	let sessionId: string | undefined;
	let nextId = 1;

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
