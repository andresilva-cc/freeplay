#!/usr/bin/env node
/**
 * Count tool-less turns across the recorded sessions.
 *
 * This exists because the numbers that used to sit in tool-less-turn-nudge's header comment
 * ("42%", "25/60", "30/30", "never did across ten runs") could not be reproduced from
 * anything in this repository: they came from resampling one reconstructed request, not from
 * play. Every figure quoted in that file now comes out of this script, so the next person can
 * re-run it instead of believing it.
 *
 * It is the single source for the tool-less rate in BOTH files that quote one -
 * tool-less-turn-nudge/index.ts and reasoning-placeholder/index.ts. They disagreed once:
 * 8/58 and 15/535 in one, 7/58 and 2/535 in the other, which read as 13.8%/2.8% against
 * 12.1%/0.4% for the same phenomenon. They were two different populations, and only one of
 * them is about the model. See TWO POPULATIONS below; both are printed, with the headline
 * figure being the one both files now quote.
 *
 *   node pi/extensions/run-end/census.mjs [sessions-dir]
 *   node pi/extensions/run-end/census.mjs --json
 *
 * Default sessions directory is pi/sessions relative to this file. Those files are
 * gitignored, so this script is reproducible only where the runs are; it prints what it read
 * so a run against an empty directory says so instead of printing zeros as if they meant
 * something.
 *
 * Definitions, stated because they are the whole argument:
 *
 *   assistant turn   one assistant message in the session file.
 *   tool-less turn   an assistant message whose content carries no toolCall block.
 *   stopReason       pi's own: "stop" is the model finishing, "aborted" is Ctrl+C, "error"
 *                    is a failed request, "length" is the output-token cap.
 *   real             a tool-less turn with stopReason "stop". Aborts, errors and token-cap
 *                    runaways are not the model choosing to say something instead of acting.
 *   signal           the turn shows it was reaching for a tool: unparsed tool-call markup, or
 *                    a tool named in the text or the thinking. Same detector the extension
 *                    uses at runtime — signals.ts, imported here rather than copied.
 *
 * TWO POPULATIONS, and which one a file may quote.
 *
 *   "real" — tool-less AND stopReason "stop". This is the headline, and the only population
 *   any comment in this repository is allowed to call a rate for the model: it is the model
 *   deciding to say something instead of acting. Both files quote it.
 *
 *   "every tool-less turn" — the same turns plus aborts, failed requests and token-cap
 *   runaways. It is printed per model because it is worth seeing, but it is NOT a property of
 *   the model: an abort is a human pressing Ctrl+C and an error is the server. Quoting it for
 *   one model beside the other model's "real" figure is what made the two files disagree.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIDGE_TOOLS, detectToolCallSignal, hasToolCall, thinkingText, visibleText } from "./signals.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SESSIONS = resolve(HERE, "..", "..", "sessions");

function parseArgs(argv) {
	const args = argv.slice(2);
	const json = args.includes("--json");
	const dir = args.find((a) => !a.startsWith("--"));
	return { json, dir: dir ? resolve(dir) : DEFAULT_SESSIONS };
}

function readSessions(dir) {
	let names;
	try {
		names = readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort();
	} catch {
		return undefined;
	}

	return names.map((name) => {
		const messages = [];
		for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let entry;
			try {
				entry = JSON.parse(trimmed);
			} catch {
				continue;
			}
			if (entry.type !== "message" || !entry.message) continue;
			messages.push(entry.message);
		}
		return { name, messages, turns: messages.filter((m) => m.role === "assistant") };
	});
}

/** The two sentences the nudge sends, matched on their opening so a reword still counts. */
const NUDGE_OPENINGS = ["You described what you would do but called no tool", "Your last response was empty"];

function messageText(message) {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("");
}

/**
 * Every nudge that was actually sent during play, and whether the next assistant message
 * called a tool. This is the only evidence in the repository about whether the nudge works;
 * it is two data points, which is why the extension's header now says two.
 */
function nudgeRecovery(sessions) {
	let sent = 0;
	let recovered = 0;
	const rows = [];

	for (const session of sessions) {
		for (let i = 0; i < session.messages.length; i++) {
			const message = session.messages[i];
			if (message.role !== "user") continue;
			const text = messageText(message);
			if (!NUDGE_OPENINGS.some((opening) => text.startsWith(opening))) continue;

			sent += 1;
			const next = session.messages[i + 1];
			const calledTool =
				!!next && next.role === "assistant" && (next.content ?? []).some((c) => c?.type === "toolCall");
			if (calledTool) recovered += 1;
			rows.push({ session: session.name, model: next?.model ?? null, calledTool });
		}
	}

	return { sent, recovered, rows };
}

function classify(sessions) {
	const perModel = new Map();
	const toolLess = [];
	let assistantTurns = 0;

	const bucket = (model) => {
		if (!perModel.has(model)) {
			perModel.set(model, {
				model,
				sessions: new Set(),
				turns: 0,
				toolLess: 0,
				real: 0,
				signalled: 0,
				silent: 0,
				byStopReason: {},
			});
		}
		return perModel.get(model);
	};

	for (const session of sessions) {
		for (const message of session.turns) {
			const model = message.model ?? "unknown";
			const entry = bucket(model);
			entry.sessions.add(session.name);
			entry.turns += 1;
			assistantTurns += 1;

			const content = Array.isArray(message.content) ? message.content : [];
			if (hasToolCall(content)) continue;

			entry.toolLess += 1;
			const stopReason = message.stopReason ?? "unknown";
			entry.byStopReason[stopReason] = (entry.byStopReason[stopReason] ?? 0) + 1;
			const text = visibleText(content);
			const thinking = thinkingText(content);
			const signal = stopReason === "stop" ? detectToolCallSignal(text, thinking, BRIDGE_TOOLS) : { kind: "n/a", evidence: "" };

			if (stopReason === "stop") {
				entry.real += 1;
				if (signal.kind === "none") entry.silent += 1;
				else entry.signalled += 1;
			}

			toolLess.push({
				session: session.name,
				model,
				stopReason,
				outputTokens: message.usage?.output ?? null,
				signal: signal.kind,
				evidence: signal.evidence,
				preview: text.slice(-160),
			});
		}
	}

	const byStopReason = {};
	for (const t of toolLess) byStopReason[t.stopReason] = (byStopReason[t.stopReason] ?? 0) + 1;

	const real = toolLess.filter((t) => t.stopReason === "stop");

	return {
		sessions: sessions.length,
		assistantTurns,
		toolLessTurns: toolLess.length,
		byStopReason,
		real: real.length,
		realWithSignal: real.filter((t) => t.signal !== "none").length,
		realWithoutSignal: real.filter((t) => t.signal === "none").length,
		perModel: [...perModel.values()]
			.sort((a, b) => b.turns - a.turns)
			.map((m) => ({ ...m, sessions: m.sessions.size })),
		detail: toolLess,
	};
}

function percent(part, whole) {
	return whole === 0 ? "n/a" : `${Math.round((part / whole) * 1000) / 10}%`;
}

function main() {
	const { json, dir } = parseArgs(process.argv);
	const sessions = readSessions(dir);

	if (!sessions) {
		console.error(`No sessions directory at ${dir}. Point this at pi/sessions from a machine that has run Freeplay.`);
		process.exit(1);
	}
	if (sessions.length === 0) {
		console.error(`${dir} holds no .jsonl session files, so there is nothing to count.`);
		process.exit(1);
	}

	const census = classify(sessions);
	census.nudges = nudgeRecovery(sessions);

	if (json) {
		console.log(JSON.stringify({ sessionsDir: dir, ...census }, null, 2));
		return;
	}

	console.log(`sessions dir:     ${dir}`);
	console.log(`sessions:         ${census.sessions}`);
	console.log(`assistant turns:  ${census.assistantTurns}`);
	console.log(`tool-less turns:  ${census.toolLessTurns} (${percent(census.toolLessTurns, census.assistantTurns)})`);
	for (const [reason, count] of Object.entries(census.byStopReason).sort()) {
		console.log(`  stopReason ${reason.padEnd(8)} ${count}`);
	}
	console.log(`real (stopReason "stop"):        ${census.real}`);
	console.log(`  reaching for a tool (signal):  ${census.realWithSignal}`);
	console.log(`  no sign of a tool call:        ${census.realWithoutSignal}`);
	console.log("");
	console.log("per model. THE HEADLINE is the first line: tool-less turns with stopReason \"stop\",");
	console.log("which is the model choosing to say something instead of acting. Quote that one.");
	for (const m of census.perModel) {
		console.log(
			`  ${m.model}: ${m.real}/${m.turns} (${percent(m.real, m.turns)}) over ${m.sessions} sessions` +
				`; signal ${m.signalled}, none ${m.silent}`,
		);
		const reasons = Object.entries(m.byStopReason)
			.sort()
			.map(([reason, count]) => `${reason} ${count}`)
			.join(", ");
		console.log(
			`    not a rate for the model — every tool-less turn whatever stopped it: ` +
				`${m.toolLess}/${m.turns} (${percent(m.toolLess, m.turns)}) = ${reasons}`,
		);
	}
	console.log("");
	console.log(`nudges actually sent in play: ${census.nudges.sent}, followed by a tool call: ${census.nudges.recovered}`);
	for (const row of census.nudges.rows) {
		console.log(`  ${row.session.slice(0, 24)} ${String(row.model).slice(0, 28).padEnd(28)} ${row.calledTool ? "tool call" : "no tool call"}`);
	}
	console.log("");
	console.log("every tool-less turn:");
	for (const t of census.detail) {
		console.log(
			`  ${t.session.slice(0, 24)} ${t.model.slice(0, 28).padEnd(28)} ${String(t.stopReason).padEnd(8)}` +
				` signal=${String(t.signal).padEnd(10)} ${t.evidence ? `[${t.evidence}] ` : ""}${JSON.stringify(t.preview.slice(-90))}`,
		);
	}
}

main();
