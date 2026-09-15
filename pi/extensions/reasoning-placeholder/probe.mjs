#!/usr/bin/env node
/**
 * Does the server forward `reasoning_content` into the chat template, and does it matter?
 *
 * This exists because reasoning-placeholder is committed switched OFF, and "the oMLX build in
 * front of Gemma throws the field away" is the whole reason. That claim should be re-runnable
 * rather than believed — the same rule run-end/census.mjs was written under — and it should be
 * re-run before anybody turns the extension on, because one upstream release could change it.
 *
 *   node pi/extensions/reasoning-placeholder/probe.mjs --passthrough
 *       Three near-identical 56-token requests. The only difference is one field on the
 *       assistant message. Prints the prompt_tokens the server reports for each.
 *
 *       Measured 2026-09-14, gemma-4-26B-A4B-it-qat-5bit on oMLX:
 *           no reasoning field ............ 56
 *           reasoning_content = 500 words . 56      <- dropped
 *           reasoning = 500 words ......... 56      <- dropped
 *           reasoning_text = 500 words .... 56      <- dropped
 *           thinking = 500 words .......... 56      <- dropped
 *           content = 500 words ........... 558     <- the control: the server does grow
 *       A run where the reasoning rows have grown is a run where the extension can work.
 *       The same three-way result holds on the real 15,293-token Freeplay prompt.
 *
 *   node pi/extensions/reasoning-placeholder/probe.mjs --replay <session.jsonl> [--n 30]
 *       Replays a recorded session's prefix up to its first tool-less assistant turn, N times
 *       with the placeholder and N times without, and counts how often the model leaks the
 *       bare word `thought` into the answer channel and how often it calls a tool. This is the
 *       measurement that has to move before any claim is made about play.
 *
 *       Measured 2026-09-14 on session 01a09370, n=30 per arm, max_tokens 512:
 *           without placeholder .. leaked 17/30, called a tool 22/30
 *           with placeholder ..... leaked 19/30, called a tool 19/30
 *       One distribution sampled twice, which is what --passthrough says it must be.
 *
 *   node pi/extensions/reasoning-placeholder/probe.mjs --census [sessions-dir]
 *       Counts the defect across the recorded sessions, per model. No server needed.
 *
 *       Measured 2026-09-14 over 19 sessions:
 *           gemma-4-26B-A4B-it-qat-5bit  58 assistant turns, 14 leaked `thought`,
 *                                        8 with no tool call, 44 of 50 tool-calling turns
 *                                        with empty thinking
 *           Qwen3.6-35B-A3B-4bit        535 assistant turns,  0 leaked `thought`,
 *                                       15 with no tool call,  0 of 520 tool-calling turns
 *                                        with empty thinking
 *       That last column is the gate: the extension's condition is never met by Qwen.
 *
 *       The "with no tool call" column counts every tool-less turn whatever stopped it, and
 *       is NOT the tool-less rate any comment in this repository quotes. Ten of Qwen's 15 are
 *       Ctrl+C aborts. `node pi/extensions/run-end/census.mjs` splits the same turns by
 *       stopReason; its "stop" line — 7 of 58 for Gemma, 2 of 535 for Qwen — is the one that
 *       is about the model, and it is what index.ts and tool-less-turn-nudge/index.ts quote.
 *
 * Needs OMLX_API_KEY in the environment for --passthrough and --replay (scripts/run.sh
 * exports it from .env; `set -a; . ./.env; set +a` does the same by hand). The endpoint comes
 * from pi/models.json, which is the single source for it. Sessions are gitignored, so --replay
 * and --census are reproducible only where the runs are; both print what they read so an empty
 * directory says so instead of printing zeros as if they meant something.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PI_DIR = resolve(HERE, "..", "..");
const DEFAULT_SESSIONS = join(PI_DIR, "sessions");
const PLACEHOLDER = "(no reasoning recorded)";
const FIVE_HUNDRED_WORDS = "WORD ".repeat(500).trim();

function modelsJson() {
	return JSON.parse(readFileSync(join(PI_DIR, "models.json"), "utf8")).providers.omlx;
}

function apiKey() {
	const key = process.env.OMLX_API_KEY;
	if (!key) {
		console.error("error: OMLX_API_KEY is not set. `set -a; . ./.env; set +a` first.");
		process.exit(1);
	}
	return key;
}

async function chat(body) {
	const provider = modelsJson();
	const response = await fetch(`${provider.baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey()}` },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 300)}`);
	return JSON.parse(text);
}

function gemmaId() {
	return process.env.OMLX_MODEL || modelsJson().models.find((m) => m.id.startsWith("gemma"))?.id;
}

/* ---------------------------------------------------------------- --passthrough */

async function passthrough() {
	const model = gemmaId();
	const tools = [{ type: "function", function: { name: "ping", description: "ping", parameters: { type: "object", properties: {} } } }];
	const call = { id: "c1", type: "function", function: { name: "ping", arguments: "{}" } };

	const rows = [
		["no reasoning field", {}],
		["reasoning_content = 500 words", { reasoning_content: FIVE_HUNDRED_WORDS }],
		["reasoning = 500 words", { reasoning: FIVE_HUNDRED_WORDS }],
		["reasoning_text = 500 words", { reasoning_text: FIVE_HUNDRED_WORDS }],
		["thinking = 500 words", { thinking: FIVE_HUNDRED_WORDS }],
		["content = 500 words (control)", { content: FIVE_HUNDRED_WORDS }],
	];

	console.log(`model: ${model}\n`);
	let baseline;
	for (const [label, extra] of rows) {
		const messages = [
			{ role: "user", content: "Go." },
			{ role: "assistant", content: null, tool_calls: [call], ...extra },
			{ role: "tool", tool_call_id: "c1", content: "ok" },
		];
		const result = await chat({ model, messages, tools, stream: false, max_tokens: 1 });
		const tokens = result.usage?.prompt_tokens;
		const isBaseline = baseline === undefined;
		baseline ??= tokens;
		const verdict = isBaseline || label.includes("control") ? "" : tokens === baseline ? "   <- DROPPED" : "   <- forwarded";
		console.log(`  ${label.padEnd(32)} prompt_tokens=${String(tokens).padStart(5)}${verdict}`);
	}
	console.log("\nEvery reasoning row equal to the first means the server never shows the field to the");
	console.log("chat template, and reasoning-placeholder cannot do anything. Leave it switched off.");
}

/* ------------------------------------------------------------- session reading */

function readSession(file) {
	const messages = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (entry.type === "message") messages.push(entry.message);
	}
	return messages;
}

const blocks = (message) => (Array.isArray(message?.content) ? message.content : []);
const partText = (message, type, field) =>
	blocks(message).filter((b) => b?.type === type && typeof b[field] === "string").map((b) => b[field]).join("");
const hasToolCall = (message) => blocks(message).some((b) => b?.type === "toolCall");

/** pi-ai's convertMessages, abridged to what this prefix needs. */
function toWire(messages, systemPrompt, inject) {
	const wire = [{ role: "system", content: systemPrompt }];
	for (const message of messages) {
		if (message.role === "user") {
			wire.push({ role: "user", content: partText(message, "text", "text") });
		} else if (message.role === "assistant") {
			const text = partText(message, "text", "text");
			const thinking = partText(message, "thinking", "thinking");
			const calls = blocks(message).filter((b) => b?.type === "toolCall");
			const out = { role: "assistant", content: null };
			// nonEmptyThinkingBlocks: a whitespace-only thinking block is dropped entirely.
			if (thinking.trim()) out.reasoning_content = thinking;
			if (text) out.content = text;
			if (calls.length > 0) {
				out.tool_calls = calls.map((c) => ({
					id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) },
				}));
			}
			if (inject && out.tool_calls && !out.reasoning_content) out.reasoning_content = PLACEHOLDER;
			wire.push(out);
		} else if (message.role === "toolResult") {
			wire.push({ role: "tool", tool_call_id: message.toolCallId, content: partText(message, "text", "text") });
		}
	}
	return wire;
}

/* -------------------------------------------------------------------- --replay */

async function replay(file, n) {
	const messages = readSession(file);
	if (messages.length === 0) {
		console.error(`error: no messages in ${file}`);
		process.exit(1);
	}

	// The prefix that produced the first tool-less assistant turn, i.e. everything before it.
	let cut = messages.findIndex((m, i) => i > 0 && m.role === "assistant" && !hasToolCall(m));
	if (cut < 0) {
		console.error("error: this session has no tool-less assistant turn to reproduce.");
		process.exit(1);
	}
	const prefix = messages.slice(0, cut);

	let systemPrompt;
	try {
		systemPrompt = readFileSync(join(PI_DIR, "SYSTEM.md"), "utf8");
	} catch {
		console.error("error: no pi/SYSTEM.md. scripts/run.sh writes it from games/openrct2/prompt.md.");
		process.exit(1);
	}

	const cache = JSON.parse(readFileSync(join(PI_DIR, "mcp-cache.json"), "utf8"));
	const tools = cache.servers.openrct2.tools.map((t) => ({
		type: "function",
		function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema ?? { type: "object", properties: {} } },
	}));

	const model = gemmaId();
	console.log(`session: ${file}\nprefix:  ${prefix.length} messages, up to message ${cut} (the first tool-less turn)`);
	console.log(`model:   ${model}, ${n} samples per arm\n`);

	for (const [label, inject] of [["without placeholder", false], ["with placeholder   ", true]]) {
		let leaked = 0;
		let called = 0;
		const wire = toWire(prefix, systemPrompt, inject);
		for (let i = 0; i < n; i++) {
			const result = await chat({ model, messages: wire, tools, stream: false, max_tokens: 512, presence_penalty: 0.5 });
			const message = result.choices?.[0]?.message ?? {};
			const leak = (message.content ?? "").trimStart().startsWith("thought");
			const calls = (message.tool_calls ?? []).map((c) => c.function?.name);
			if (leak) leaked += 1;
			if (calls.length > 0) called += 1;
			process.stdout.write(`  ${label} ${i + 1}/${n} leak=${leak} tools=${calls.join(",") || "-"}\n`);
		}
		console.log(`  => ${label}: leaked ${leaked}/${n}, called a tool ${called}/${n}\n`);
	}
}

/* -------------------------------------------------------------------- --census */

function census(dir) {
	let names;
	try {
		names = readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort();
	} catch {
		console.error(`error: cannot read ${dir}`);
		process.exit(1);
	}
	console.log(`read ${names.length} session file(s) from ${dir}\n`);

	const byModel = new Map();
	for (const name of names) {
		for (const message of readSession(join(dir, name))) {
			if (message?.role !== "assistant") continue;
			const id = message.model ?? "unknown";
			if (!byModel.has(id)) byModel.set(id, { turns: 0, leaked: 0, toolLess: 0, calling: 0, callingEmptyThinking: 0 });
			const s = byModel.get(id);
			s.turns += 1;
			if (partText(message, "text", "text").trimStart().startsWith("thought")) s.leaked += 1;
			if (hasToolCall(message)) {
				s.calling += 1;
				if (!partText(message, "thinking", "thinking").trim()) s.callingEmptyThinking += 1;
			} else {
				s.toolLess += 1;
			}
		}
	}

	for (const [id, s] of byModel) {
		console.log(`${id}`);
		console.log(`  assistant turns ................... ${s.turns}`);
		console.log(`  leaked the \`thought\` header ....... ${s.leaked}`);
		// Every tool-less turn, whatever stopped it — aborts and failed requests included.
		// NOT the rate quoted in any comment: run-end/census.mjs splits it by stopReason and
		// its "stop" line is the one that is about the model. Quoting this one beside that
		// one is what made two committed files disagree about the same phenomenon.
		console.log(`  ended with no tool call ........... ${s.toolLess}   <- all stop reasons; see run-end/census.mjs`);
		console.log(`  tool-calling turns, empty thinking  ${s.callingEmptyThinking} of ${s.calling}   <- what the extension would act on`);
		console.log();
	}
}

/* ----------------------------------------------------------------------- main */

const argv = process.argv.slice(2);
const mode = argv.find((a) => a.startsWith("--"));
const positional = argv.filter((a) => !a.startsWith("--"));
const nIndex = argv.indexOf("--n");
const n = nIndex >= 0 ? Number(argv[nIndex + 1]) : 30;

if (mode === "--passthrough") {
	await passthrough();
} else if (mode === "--replay") {
	const file = positional.find((p) => p.endsWith(".jsonl"));
	if (!file) {
		console.error("usage: probe.mjs --replay <session.jsonl> [--n 30]");
		process.exit(1);
	}
	await replay(resolve(file), n);
} else if (mode === "--census") {
	census(resolve(positional[0] ?? DEFAULT_SESSIONS));
} else {
	console.error(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
	process.exit(1);
}
