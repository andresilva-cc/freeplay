/**
 * The channel reasoning-placeholder publishes its counts on.
 *
 * Same route the nudge uses to get its total into the run-end record: pi hands every
 * extension the same EventBus on `pi.events`, and that is the only shared channel between
 * two extensions — jiti loads each one with `moduleCache: false`, so an imported module is
 * evaluated once per importer and a module-level singleton would NOT be shared state. See
 * ../run-end/channels.ts, which says the same thing at more length.
 *
 * NOTHING SUBSCRIBES TO THIS YET. run-end listens on NUDGE_CHANNEL and on nothing else, and
 * this extension was written under a scope that did not allow editing run-end. The count is
 * therefore already on the bus and already in two files — pi/logs/reasoning-placeholder/ and
 * pi's own session transcript (see `pi.appendEntry` in index.ts) — so a published result can
 * say whether this was active and how often it fired. To put it in the run-end record as
 * well, run-end needs one subscription and one field:
 *
 *   record.ts   add `reasoningPlaceholders: { enabled: boolean; substitutions: number }`
 *               to RunEndRecord
 *   index.ts    import PLACEHOLDER_CHANNEL and PlaceholderTelemetry from here, add
 *                 pi.events.on(PLACEHOLDER_CHANNEL, (d) => {
 *                   const t = d as PlaceholderTelemetry | undefined;
 *                   if (t) placeholders = { enabled: t.enabled, substitutions: t.substitutions };
 *                 });
 *               and carry `placeholders` into the record next to `nudges`.
 *
 * `enabled` is the load-bearing half of that pair, not `substitutions`: the extension is off
 * by default because the oMLX build in front of Gemma drops the field it writes. See the block
 * at the top of index.ts.
 */

export const PLACEHOLDER_CHANNEL = "freeplay/run-end/reasoning-placeholder";

export interface PlaceholderTelemetry {
	/** "substituted" on every request that was changed, "summary" once at session shutdown. */
	event: "substituted" | "summary";
	/** Whether the extension was switched on for this run at all. Off is the default. */
	enabled: boolean;
	/** Assistant messages given a placeholder, counted across the whole session. */
	substitutions: number;
	/** Requests in which at least one message was changed. */
	requests: number;
	/** The model the substitutions were made for, so a comparison can name what was touched. */
	model: string | null;
}
