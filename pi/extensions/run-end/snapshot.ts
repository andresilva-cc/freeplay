/**
 * Where the park stood, at the start of a run and at the end of it.
 *
 * WHY. The run-end record carried turns, tool calls, elapsed milliseconds, the end condition
 * and — only when the game itself had decided — the in-game day it decided on. Most runs end
 * on a budget, and that record said nothing at all about how far into the scenario the run
 * got: no guests, no cash, no rating, no date, no scenario name, no plugin build id, no
 * guard state. Two timed-out runs were comparable on nothing, which is not a benchmark.
 *
 * WHAT IS READ, and why it is not `park_status`. Three plain GETs on the bridge's REST
 * surface, fired in parallel:
 *
 *   GET /v1        buildId, stateGuards {ok, frozen, unfrozen, open, unexamined} and the scenario block
 *                  {name, objective, status, endedOn}.        (src/app.ts, createVersionIndex)
 *   GET /v1/park   name, guests, rating, cash, bankLoan, companyValue, parkValue,
 *                  entranceFee.                               (src/parkInfo.ts)
 *   GET /v1/date   the in-game date plus monthsElapsed, monthProgress and ticksElapsed,
 *                  which is the only sub-day reading there is. (src/gameDate.ts)
 *
 * Between them that is everything the record needs, and NONE of it needs a `park_status`
 * call. park_status would cost an MCP session of our own and a walk of the whole park — the
 * path network, the ground census, every ride — for four numbers, and it does not even carry
 * `parkValue`, which only `/v1/park` reports. The REST reads hold no session, so they cannot
 * disturb the per-session `gameDaysSinceLastCall` the model is shown.
 *
 * HOW IT FAILS. Never by throwing, and never by inventing. Each endpoint is read on its own:
 * one that does not answer leaves its block null and its reason in `note`, and the record is
 * written with the fields missing and the reason attached. A snapshot that could not be
 * taken at all is `ok: false` with every block null — which is still a record, and still
 * says why.
 */

import { readScenarioFromValue, type FetchLike, type GameDay, type ScenarioStatus } from "./scenario.ts";
import { dayPosition, type DateReading } from "./gameTime.ts";

/**
 * src/scripting.ts `stateGuardSummary`: what is shut, what would not shut, what is open on
 * purpose — and what nobody has a verdict on at all.
 *
 * `ok` there means "something froze, nothing refused to freeze, and nothing is unexamined".
 * `open` is a disclosure that rides alongside it rather than a term of it, so a record can
 * read `ok: true` and still name four writable levers; the reason for each is in the
 * plugin's full `stateGuardReport`, not in this summary.
 *
 * `unexamined` is null, not empty, when the bridge did not report the field: a plugin built
 * before it existed swept nothing, and recording that as `[]` would publish "nobody looked"
 * as "nothing to find", which is the defect this whole field was added to end. It arrives
 * already capped by the plugin at twenty names plus an "and N more" entry, because `/v1` is
 * polled — so a record carries what the endpoint published, not a truncation of it.
 */
export interface GuardSummary {
	ok: boolean;
	frozen: number;
	unfrozen: string[];
	open: string[];
	unexamined: string[] | null;
}

/** src/parkInfo.ts. Money is in tenths of a currency unit; `rating` is the park rating, 0 to 999. */
export interface ParkReading {
	name: string | null;
	guests: number | null;
	rating: number | null;
	cash: number | null;
	bankLoan: number | null;
	companyValue: number | null;
	parkValue: number | null;
	entranceFee: number | null;
}

/** src/gameDate.ts, plus the day number gameTime.ts puts the other readings on. */
export interface DateSnapshot {
	year: number;
	month: number;
	day: number;
	monthsElapsed: number | null;
	monthProgress: number | null;
	ticksElapsed: number | null;
	/** Days since the start of year 1, part-day included. Null when the counters were unreadable. */
	dayNumber: number | null;
}

export interface ScenarioSnapshot {
	name: string | null;
	objective: unknown;
	status: ScenarioStatus | "unknown";
	endedOn: GameDay | null;
}

export interface BridgeSnapshot {
	/**
	 * True only when all three reads answered and each answered in full. False is a partial
	 * snapshot, or one whose bridge predates a field this reader expects — never a lie, and
	 * `note` always says which. It is not the guards' own `ok`, which is in `guards.ok`.
	 */
	ok: boolean;
	/** Wall-clock time the snapshot was taken, not game time. */
	observedAt: string;
	/** Why anything is missing. Null when nothing is. */
	note: string | null;
	/** The plugin bundle the game has loaded, so a result names the build it was played on. */
	buildId: string | null;
	guards: GuardSummary | null;
	scenario: ScenarioSnapshot | null;
	date: DateSnapshot | null;
	park: ParkReading | null;
}

export interface SnapshotOptions {
	baseUrl: string;
	fetchImpl?: FetchLike;
	timeoutMs?: number;
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function readGuards(value: unknown): GuardSummary | null {
	if (!value || typeof value !== "object") return null;
	const guards = value as Record<string, unknown>;

	return {
		ok: guards.ok === true,
		frozen: typeof guards.frozen === "number" ? guards.frozen : 0,
		unfrozen: Array.isArray(guards.unfrozen) ? guards.unfrozen.map(String) : [],
		open: Array.isArray(guards.open) ? guards.open.map(String) : [],
		unexamined: Array.isArray(guards.unexamined) ? guards.unexamined.map(String) : null,
	};
}

function readPark(value: unknown): ParkReading | null {
	if (!value || typeof value !== "object") return null;
	const park = value as Record<string, unknown>;

	return {
		name: stringOrNull(park.name),
		// The endpoint's own name for the field. Called `guests` here because that is what it
		// is called everywhere else a result would be read.
		guests: numberOrNull(park.numGuests),
		rating: numberOrNull(park.rating),
		cash: numberOrNull(park.cash),
		bankLoan: numberOrNull(park.bankLoan),
		companyValue: numberOrNull(park.companyValue),
		parkValue: numberOrNull(park.parkValue),
		entranceFee: numberOrNull(park.entranceFee),
	};
}

export function readDateSnapshot(value: unknown): DateSnapshot | null {
	if (!value || typeof value !== "object") return null;
	const date = value as Record<string, unknown>;

	if (typeof date.year !== "number" || typeof date.month !== "number" || typeof date.day !== "number") {
		return null;
	}

	return {
		year: date.year,
		month: date.month,
		day: date.day,
		monthsElapsed: numberOrNull(date.monthsElapsed),
		monthProgress: numberOrNull(date.monthProgress),
		ticksElapsed: numberOrNull(date.ticksElapsed),
		dayNumber: dayPosition(date.monthsElapsed, date.monthProgress) ?? null,
	};
}

/** The three numbers the rest of the extension dates a reading by. */
export function dateReadingOf(snapshot: DateSnapshot): DateReading {
	return { year: snapshot.year, month: snapshot.month, day: snapshot.day };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createSnapshotReader(options: SnapshotOptions) {
	const baseUrl = options.baseUrl.replace(/\/+$/, "");
	const doFetch: FetchLike = options.fetchImpl ?? ((input, init) => (globalThis as any).fetch(input, init));
	const timeoutMs = options.timeoutMs ?? 5000;

	/** Throws on anything that is not a JSON body with HTTP 200, so each caller can name its own failure. */
	async function get(path: string): Promise<unknown> {
		const response = await doFetch(`${baseUrl}${path}`, {
			method: "GET",
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);

		return JSON.parse(await response.text());
	}

	/** The cheapest read there is, for the budget meter between snapshots. Throws when it fails. */
	async function readDate(): Promise<DateSnapshot> {
		const snapshot = readDateSnapshot(await get("/v1/date"));
		if (!snapshot) throw new Error("GET /v1/date answered without a date");

		return snapshot;
	}

	/**
	 * Everything, in one round trip each. Never throws: a failed read is a missing block and
	 * a sentence in `note`.
	 */
	async function read(): Promise<BridgeSnapshot> {
		const observedAt = new Date().toISOString();
		const notes: string[] = [];

		const [index, park, date] = await Promise.all([
			get("/v1").catch((error) => {
				notes.push(`GET /v1 failed (${describe(error)}): no build id, guard report or scenario`);
				return undefined;
			}),
			get("/v1/park").catch((error) => {
				notes.push(`GET /v1/park failed (${describe(error)}): no guests, cash, rating or park value`);
				return undefined;
			}),
			get("/v1/date").catch((error) => {
				notes.push(`GET /v1/date failed (${describe(error)}): no game date`);
				return undefined;
			}),
		]);

		const root = index && typeof index === "object" ? (index as Record<string, unknown>) : undefined;
		const reading = root ? readScenarioFromValue(root, "bridge_index") : undefined;
		const scenario: ScenarioSnapshot | null = root
			? {
					name: reading?.name ?? null,
					objective: reading?.objective ?? null,
					status: reading?.status ?? "unknown",
					endedOn: reading?.endedOn ?? null,
				}
			: null;

		if (root && !reading) notes.push("GET /v1 answered without a scenario: the plugin predates the field");

		const guards = root ? readGuards(root.stateGuards) : null;

		if (guards && guards.unexamined === null) {
			notes.push("GET /v1 reported guards without `unexamined`: the plugin predates the field, so"
				+ " this record cannot say whether anything in the plugin API went unswept");
		}

		const dateSnapshot = date ? readDateSnapshot(date) : null;
		if (date && !dateSnapshot) notes.push("GET /v1/date answered without a readable date");

		const parkReading = park ? readPark(park) : null;

		return {
			ok: notes.length === 0,
			observedAt,
			note: notes.length > 0 ? notes.join("; ") : null,
			buildId: root ? stringOrNull(root.buildId) : null,
			guards,
			scenario,
			date: dateSnapshot,
			park: parkReading,
		};
	}

	return { read, readDate };
}

/** What the record carries when a snapshot could not be attempted at all. */
export function missingSnapshot(note: string): BridgeSnapshot {
	return {
		ok: false,
		observedAt: new Date().toISOString(),
		note,
		buildId: null,
		guards: null,
		scenario: null,
		date: null,
		park: null,
	};
}
