/**
 * Did this turn try to call a tool, or did it stop?
 *
 * Shared by run-end and tool-less-turn-nudge because the two must never disagree about one
 * turn: the nudge declines exactly the turns run-end is willing to end the run on.
 *
 * Every function here is pure. pi loads each extension through its own jiti instance with
 * `moduleCache: false`, so this file is evaluated once per importer and module-level state
 * would NOT be shared. Nothing here holds any.
 */

/** The bridge's tools, as a fallback when pi.getActiveTools() cannot be reached. */
export const BRIDGE_TOOLS = [
	"build_flat_ride",
	"build_path",
	"buy_land",
	"clear_scenery",
	"describe_placement",
	"evaluate",
	"guest_feedback",
	"hire_staff",
	"list_ride_objects",
	"open_park",
	"operate_ride",
	"park_status",
	"remove_path",
	"set_game_speed",
	"view_map",
	"wait",
] as const;

/**
 * Tool-call syntax that reached the text channel instead of the tool channel.
 *
 * This is the oMLX adapter failing to parse what the model emitted, not the model failing to
 * act: one recorded Qwen turn ends with a bare `</parameter></function></tool_call>`. Kept
 * wide on purpose — several chat templates are in play and each has its own wrapper.
 */
const MARKUP_PATTERNS: RegExp[] = [
	/<\/?tool_call>/i,
	/<\/?tool_response>/i,
	/<\/?function[\s>]/i,
	/<\/?parameter[\s>]/i,
	/<\/?invoke[\s>]/i,
	/<\|tool[_a-z]*\|>/i,
	/<\|python_tag\|>/i,
	/"name"\s*:\s*"[a-z_]+"\s*,\s*"(?:arguments|parameters)"\s*:/i,
];

export type SignalKind = "markup" | "tool_name" | "none";

export interface ToolCallSignal {
	kind: SignalKind;
	/** The literal thing that was found, for the log. Empty when kind is "none". */
	evidence: string;
}

/** Text the model actually emitted, thinking blocks excluded. */
export function visibleText(content: readonly unknown[]): string {
	return contentField(content, "text", "text");
}

/** The thinking blocks, which is where a small model often names the tool it then never calls. */
export function thinkingText(content: readonly unknown[]): string {
	return contentField(content, "thinking", "thinking");
}

function contentField(content: readonly unknown[], type: string, field: string): string {
	let out = "";
	for (const block of content) {
		const b = block as Record<string, unknown> | null;
		if (b && b.type === type && typeof b[field] === "string") out += b[field] as string;
	}
	return out.trim();
}

export function hasToolCall(content: readonly unknown[]): boolean {
	return content.some((c) => (c as Record<string, unknown> | null)?.type === "toolCall");
}

function escapeForRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether the turn shows the model reaching for a tool.
 *
 * Two signals, and the second is deliberately fussy about one-word tool names. `wait` and
 * `evaluate` are ordinary English: "I'll wait for the first guests" is not an attempted tool
 * call, and counting it as one would have kept the single recorded terminal post-mortem alive.
 * A one-word name therefore only counts inside backticks or followed by `(`; a name with an
 * underscore in it is not a word anyone types by accident and counts anywhere.
 *
 * Thinking is scanned as well as visible text: one recorded turn narrates neutrally and says
 * "I'll use `view_map`" in the thinking block alone, which is the same failure wearing a hat.
 */
export function detectToolCallSignal(text: string, thinking: string, toolNames: readonly string[]): ToolCallSignal {
	const blob = `${text}\n${thinking}`;

	for (const pattern of MARKUP_PATTERNS) {
		const found = pattern.exec(blob);
		if (found) return { kind: "markup", evidence: found[0] };
	}

	for (const name of toolNames) {
		if (!name) continue;
		const escaped = escapeForRegex(name);
		const pattern = name.includes("_")
			? new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`)
			: new RegExp("(?<![A-Za-z0-9_])(?:`" + escaped + "`|" + escaped + "\\s*\\()", "i");
		if (pattern.test(blob)) return { kind: "tool_name", evidence: name };
	}

	return { kind: "none", evidence: "" };
}
