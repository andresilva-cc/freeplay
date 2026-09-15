/**
 * What the harness did to the model, so a published result cannot quietly omit it.
 *
 * THE RULE THIS ENFORCES. Anything in pi/extensions/ that changes what the model sees, or that
 * puts words in its mouth, is a harness intervention, and a benchmark number taken off a run
 * that carried one is only citable if the run's own artifact says so. Until this file existed
 * that rule was enforced by somebody remembering: reasoning-placeholder ships switched off and
 * reads an env var, and by its own arithmetic it can only ever fire on Gemma — 44 of Gemma's
 * 50 tool-calling turns carry no thinking against 0 of Qwen's 520 — so setting that variable
 * would have made a per-model intervention that the record had no field to mention.
 *
 * So the run-end record carries `interventions`, and it carries an entry for EVERY intervention
 * this harness knows of, armed or not. A disarmed one is present and false, never missing:
 * "not in the list" and "not armed" have to be different states or a reader cannot tell a clean
 * run from an incomplete record.
 *
 * TWO WAYS IN, because one of them is order-dependent and the other is not.
 *
 *   The census (pull). run-end emits INTERVENTION_CENSUS_CHANNEL while it builds the record and
 *   every intervention pushes its own report into the array it is handed. pi's EventBus is
 *   EventEmitter, so every subscriber runs synchronously before emit() returns — the same
 *   property STOPPED_TURN relies on; see channels.ts. This is the authoritative answer, because
 *   it is taken at the end of the run and carries the live counts.
 *
 *   The announcement (push). Each intervention also emits INTERVENTION_CHANNEL from its own
 *   `session_start`, once it knows whether it is on. run-end keeps those and uses them for any
 *   id the census did not answer for, which covers an extension whose census handler threw —
 *   EventEmitter.emit stops dispatching at the first throw, so one bad subscriber could
 *   otherwise silence a later one.
 *
 * KNOWN_INTERVENTIONS is the registry, and it is the belt to those two braces: an id in it that
 * answers neither way is still written into the record, marked "not loaded". An intervention
 * added later does NOT have to be added to the registry to be disclosed — answering the census
 * is enough — but adding it means its absence is disclosed too.
 *
 * run-end itself is deliberately not in the registry. It ends runs, which is a harness policy
 * and is already disclosed in full by the record's own `condition` and `detail`; it never adds
 * to or alters what goes to the model.
 */

/** An extension that intervenes, named by its directory under pi/extensions/. */
export type InterventionId = string;

export interface InterventionReport {
	id: InterventionId;
	/** Whether it was switched on for this run. Not whether it fired. */
	armed: boolean;
	/** How arming was decided: the flag or env var that turns it on, or that it is always on. */
	how: string;
	/** How many times it actually changed what the model saw. 0 is normal on an armed one. */
	fired: number;
	/** One sentence a person can read without opening the source. */
	detail: string;
}

export interface Interventions {
	/**
	 * False only on a record built without a census at all. Nothing else in here is then
	 * evidence, and in particular an empty `armed` must not be read as a clean run.
	 */
	disclosed: boolean;
	/** Ids of everything armed for this run. Empty means nothing intervened. */
	armed: InterventionId[];
	/** Every intervention known or reported, armed or not. One entry each, never partial. */
	all: InterventionReport[];
}

/**
 * Every intervention this repository ships. Add a directory here when it changes what the model
 * sees; the record will then say so even on a run where the extension was never loaded.
 */
export const KNOWN_INTERVENTIONS: readonly InterventionId[] = ["tool-less-turn-nudge", "reasoning-placeholder"];

/** Intervention -> run-end, once per session, as soon as the extension knows whether it is on. */
export const INTERVENTION_CHANNEL = "freeplay/run-end/intervention";

/** run-end -> every intervention, request/reply, while the record is being built. */
export const INTERVENTION_CENSUS_CHANNEL = "freeplay/run-end/intervention-census";

/** The array the census is collected into. Subscribers push; run-end reads it after emit(). */
export interface InterventionCensus {
	reports: InterventionReport[];
}

/** Just the shape of pi's EventBus that this file uses, so nothing here imports pi's types. */
interface Bus {
	emit(channel: string, data: unknown): unknown;
	on(channel: string, handler: (data: unknown) => void): unknown;
}

/**
 * A report from another extension is untrusted input: it arrives over a shared bus and a
 * malformed one must not be able to cost the whole field. Anything unusable is dropped, and a
 * dropped id falls back to the registry's "not loaded" entry rather than vanishing.
 */
function clean(value: unknown): InterventionReport | undefined {
	if (!value || typeof value !== "object") return undefined;
	const report = value as Partial<InterventionReport>;
	if (typeof report.id !== "string" || report.id.length === 0) return undefined;
	const fired = typeof report.fired === "number" && Number.isFinite(report.fired) ? Math.max(0, Math.trunc(report.fired)) : 0;
	return {
		id: report.id,
		armed: report.armed === true,
		how: typeof report.how === "string" && report.how.length > 0 ? report.how : "unstated",
		fired,
		detail: typeof report.detail === "string" ? report.detail : "",
	};
}

function notLoaded(id: InterventionId): InterventionReport {
	return {
		id,
		armed: false,
		how: "not loaded",
		fired: 0,
		detail: `${id} answered neither the run-end census nor an announcement, so it was not loaded for this run and changed nothing.`,
	};
}

function unreported(id: InterventionId): InterventionReport {
	return {
		id,
		armed: false,
		how: "unreported",
		fired: 0,
		detail: `this record was written without a census, so whether ${id} was armed is unknown. Do not read this run as clean.`,
	};
}

/**
 * Build the field from whatever answered.
 *
 * `reports` is in priority order and the FIRST entry for an id wins, so run-end passes the
 * census answers before the session_start announcements. Registry order comes first in the
 * output, then anything that answered without being registered, so an intervention added later
 * is disclosed on the strength of its answer alone.
 */
export function collectInterventions(reports: readonly unknown[]): Interventions {
	const seen = new Map<InterventionId, InterventionReport>();
	for (const raw of reports) {
		const report = clean(raw);
		if (!report || seen.has(report.id)) continue;
		seen.set(report.id, report);
	}

	const all: InterventionReport[] = KNOWN_INTERVENTIONS.map((id) => seen.get(id) ?? notLoaded(id));
	for (const [id, report] of seen) {
		if (!KNOWN_INTERVENTIONS.includes(id)) all.push(report);
	}

	return {
		disclosed: true,
		armed: all.filter((report) => report.armed).map((report) => report.id),
		all,
	};
}

/**
 * What goes in a run_end record that was written without a census. Every known intervention is
 * present and marked "unreported", and `disclosed` is false, so the record says the harness
 * failed to disclose rather than saying nothing at all.
 */
export function undisclosedInterventions(): Interventions {
	return {
		disclosed: false,
		armed: [],
		all: KNOWN_INTERVENTIONS.map(unreported),
	};
}

/** True for a value that is a usable `interventions` field. Used by the guard in record.ts. */
export function isInterventions(value: unknown): value is Interventions {
	if (!value || typeof value !== "object") return false;
	const field = value as Partial<Interventions>;
	return typeof field.disclosed === "boolean" && Array.isArray(field.armed) && Array.isArray(field.all);
}

/**
 * Subscribe to the census. Call once, from the extension's factory, so the subscription exists
 * before any session starts; `describe` is called at census time and must read live state.
 *
 * The push is the first thing the handler does and the whole handler cannot throw, because
 * EventEmitter.emit stops dispatching at the first subscriber that does.
 */
export function answerInterventionCensus(events: Bus, describe: () => InterventionReport): void {
	try {
		events.on(INTERVENTION_CENSUS_CHANNEL, (data) => {
			try {
				const census = data as InterventionCensus | undefined;
				if (!census || !Array.isArray(census.reports)) return;
				census.reports.push(describe());
			} catch {
				// A census that cannot be answered leaves the registry's "not loaded" entry,
				// which is the wrong answer but a visible one. Losing the run is worse.
			}
		});
	} catch {
		// No bus. The announcement below is the other half of the belt and braces.
	}
}

/** Announce arming, from the extension's own `session_start`, once `armed` is known. */
export function announceIntervention(events: Bus, report: InterventionReport): void {
	try {
		events.emit(INTERVENTION_CHANNEL, report);
	} catch {
		// run-end is not loaded, or the bus is gone. Neither is fatal here.
	}
}
