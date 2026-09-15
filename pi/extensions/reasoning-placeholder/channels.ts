/**
 * The channel reasoning-placeholder publishes its counts on.
 *
 * Same route the nudge uses to get its total into the run-end record: pi hands every
 * extension the same EventBus on `pi.events`, and that is the only shared channel between
 * two extensions — jiti loads each one with `moduleCache: false`, so an imported module is
 * evaluated once per importer and a module-level singleton would NOT be shared state. See
 * ../run-end/channels.ts, which says the same thing at more length.
 *
 * THIS IS THE EXTENSION'S OWN TELEMETRY, NOT THE DISCLOSURE. Nothing subscribes to this
 * channel; the counts it carries are written to pi/logs/reasoning-placeholder/ and to pi's own
 * session transcript (see `pi.appendEntry` in index.ts) for whoever wants the per-request
 * detail.
 *
 * The disclosure that a benchmark result depends on goes a different way, and is not this
 * channel's job: index.ts answers the run-end intervention census, so the run_end record names
 * this extension in `interventions` on every run, armed or not. The earlier plan sketched here
 * — a `reasoningPlaceholders` field of its own on RunEndRecord — was the special case of that,
 * and a special case is exactly what leaves the next intervention undisclosed. See
 * ../run-end/interventions.ts.
 *
 * `enabled` is still the load-bearing half of the pair below, not `substitutions`: the
 * extension is off by default because the oMLX build in front of Gemma drops the field it
 * writes. See the block at the top of index.ts.
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
