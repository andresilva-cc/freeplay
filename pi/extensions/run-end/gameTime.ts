/**
 * How much scenario a run has spent, in the game's own calendar.
 *
 * WHY THIS EXISTS. The run used to end on a wall-clock budget, and a wall clock buys
 * different amounts of game on different machines. Since the bridge began holding the game
 * paused between tool calls (servers/openrct2/src/clockGate.ts) scenario time advances only
 * inside `wait`, which is capped at 12 game days and 20 real seconds a call — so the number
 * of `wait` calls that fit in 45 minutes, and therefore the amount of scenario played, was
 * decided by how fast the model emitted tokens. Two models on the same scenario were not
 * playing the same game. The budget is game days now, and this file is the meter.
 *
 * THE CALENDAR IS NOT OURS. OpenRCT2's year is eight months long and its months are not the
 * same length, so one date cannot be subtracted from another without the table. The table
 * and the arithmetic below are a deliberate mirror of servers/openrct2/src/gameClock.ts —
 * same `DAYS_IN_MONTH`, same `dayNumber`, same `monthProgress` fraction — because the
 * harness and the bridge must not be able to disagree about how long a game year is. The
 * copy is here rather than imported because the plugin is bundled for the game's own
 * JavaScript engine and is not on this process's module path.
 *
 * `month` is the game's own 0-based index within the year (0 is March), which is what
 * `date.month` reports and what `gameClock.dayNumber` reads.
 *
 * WHERE READINGS COME FROM, cheapest first:
 *
 *   tool results   `wait` answers with `from`/`to`/`days`, `park_status` with `date`, and
 *                  EVERY result carries `gameDaysSinceLastCall` — the game days that
 *                  elapsed between the previous result and this one, stamped by the bridge
 *                  at src/mcp.ts. Free: the model paid for these calls already.
 *   GET /v1/date   seven property reads on the game thread, no MCP session. The only source
 *                  with sub-day resolution, and the only one that sees the clock move when
 *                  the model is not calling a dated tool.
 */

/** Days per month, March to October, as OpenRCT2's `days_in_month` in `Date.cpp`. */
export const DAYS_IN_MONTH = [31, 30, 31, 30, 31, 31, 30, 31];

export const MONTHS_PER_YEAR = DAYS_IN_MONTH.length;

/**
 * 245, from the table above. Note that this is NOT the 248 quoted in the bridge's
 * clockGate.ts header: that figure was measured off one run's date arithmetic and is three
 * days long. Anything here that needs the length of a scenario year uses this.
 */
export const DAYS_IN_YEAR = DAYS_IN_MONTH.reduce((total, days) => total + days, 0);

/** `monthProgress` runs 0 to this and then the month turns over. The game's own sub-day grain. */
const MONTH_PROGRESS_PER_MONTH = 65536;

/** An in-game date, in the three numbers the bridge reports dates in. */
export interface DateReading {
	year: number;
	month: number;
	day: number;
}

/** Whole days since the start of year 1, so two dates subtract across a month or a year. */
export function dayNumber(reading: DateReading): number {
	let days = (reading.year - 1) * DAYS_IN_YEAR;

	for (let month = 0; month < reading.month && month < MONTHS_PER_YEAR; month++) {
		days += DAYS_IN_MONTH[month];
	}

	return days + (reading.day - 1);
}

/** Days before the start of a month, counted from total elapsed months as the game does. */
function daysBeforeElapsedMonth(monthsElapsed: number): number {
	const months = Math.max(0, Math.floor(monthsElapsed));
	const month = months % MONTHS_PER_YEAR;
	let days = Math.floor(months / MONTHS_PER_YEAR) * DAYS_IN_YEAR;

	for (let i = 0; i < month; i++) days += DAYS_IN_MONTH[i];

	return days;
}

/**
 * The same scale as `dayNumber`, with the part-day included, from what `GET /v1/date`
 * carries. Undefined where the two counters are not both readable: a missing reading is
 * never substituted with 0, because 0 days is a measurement.
 */
export function dayPosition(monthsElapsed: unknown, monthProgress: unknown): number | undefined {
	if (typeof monthsElapsed !== "number" || typeof monthProgress !== "number") return undefined;
	if (!Number.isFinite(monthsElapsed) || !Number.isFinite(monthProgress)) return undefined;

	const month = Math.max(0, Math.floor(monthsElapsed)) % MONTHS_PER_YEAR;

	return daysBeforeElapsedMonth(monthsElapsed) + (monthProgress / MONTH_PROGRESS_PER_MONTH) * DAYS_IN_MONTH[month];
}

/** Round to the tenth of a day the bridge's own `gameDaysBetween` reports in. */
export function roundDays(value: number): number {
	return Math.round(value * 10) / 10;
}

/** A date somewhere in a JSON value, or nothing. Never throws on a shape it does not know. */
export function asDateReading(value: unknown): DateReading | undefined {
	if (!value || typeof value !== "object") return undefined;
	const reading = value as Record<string, unknown>;

	if (typeof reading.year !== "number" || typeof reading.month !== "number" || typeof reading.day !== "number") {
		return undefined;
	}

	return { year: reading.year, month: reading.month, day: reading.day };
}

/** What one tool result said about the clock. Every field is optional; a result may say nothing. */
export interface GameTimeReading {
	/** The in-game date the result was taken at, where it carried one. */
	date?: DateReading;
	/** `date` on the same scale as `dayPosition`. */
	dayNumber?: number;
	/**
	 * The date a `wait` STARTED from. Only a baseline candidate: it is the one reading that
	 * is older than the result carrying it, so a run whose first clock reading arrives on a
	 * wait can still date its own start rather than losing that wait's days.
	 */
	from?: DateReading;
	fromDayNumber?: number;
	/** Game days this call bought with `wait`, as `wait` itself measured them. */
	waitDays?: number;
	/** The bridge's own bill for the turn that led to this call, from `gameDaysSinceLastCall`. */
	sinceLastCall?: number;
}

/**
 * Read the clock off one tool result value.
 *
 * Three fields, all of them the bridge's own and all of them documented in
 * servers/openrct2/src/mcp.ts and src/tools/wait.ts:
 *
 *   `to` + `days` + `from`   a `wait` outcome. `days` is how far the clock ACTUALLY moved,
 *                            which is not what was asked for when the 20 real seconds ran
 *                            out first, so it is the only honest figure for what was spent.
 *   `date`                   a `park_status` reading.
 *   `gameDaysSinceLastCall`  on every result, including the ones above.
 */
export function readGameTimeFromValue(value: unknown): GameTimeReading | undefined {
	if (!value || typeof value !== "object") return undefined;
	const root = value as Record<string, unknown>;
	const out: GameTimeReading = {};

	const waited = asDateReading(root.to);
	const from = asDateReading(root.from);
	if (waited && from && typeof root.days === "number") {
		out.date = waited;
		out.from = from;
		out.fromDayNumber = dayNumber(from);
		out.waitDays = root.days;
	}

	if (!out.date) {
		const dated = asDateReading(root.date);
		if (dated) out.date = dated;
	}

	if (typeof root.gameDaysSinceLastCall === "number") out.sinceLastCall = root.gameDaysSinceLastCall;

	if (out.date) out.dayNumber = dayNumber(out.date);

	return out.date || typeof out.waitDays === "number" || typeof out.sinceLastCall === "number" ? out : undefined;
}

/**
 * The same, off the content blocks pi hands to a `tool_result` handler.
 *
 * Parsed as leniently as scenario.ts parses the same blocks: a result that is not JSON is
 * simply not a reading, because a malformed result must not be able to end somebody's run
 * early — or, here, to make the record claim a day the game never reached.
 */
export function readGameTimeFromToolResult(content: readonly unknown[] | undefined): GameTimeReading | undefined {
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

		const reading = readGameTimeFromValue(parsed);
		if (reading) return reading;
	}

	return undefined;
}
