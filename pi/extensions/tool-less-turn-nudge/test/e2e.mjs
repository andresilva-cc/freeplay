/**
 * Run: node pi/extensions/tool-less-turn-nudge/test/e2e.mjs
 *
 * End-to-end test: real pi 0.85.1, real extension loading, scripted OpenAI-compatible provider.
 *
 * Proves the wiring the unit test cannot: that agent_end fires where we think it does, that a
 * follow-up queued from an agent_end handler actually continues the loop, and that the nudge
 * arrives at the provider as the last user message.
 *
 * Touches nothing in the repo: its own PI_CODING_AGENT_DIR, its own session dir, its own cwd,
 * a fake model server on an ephemeral port. Never contacts the OpenRCT2 bridge.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), "nudge-e2e-"));
const AGENT_DIR = join(ROOT, "agent");
const EXT_DIR = join(AGENT_DIR, "extensions");
const SESSION_DIR = join(ROOT, "sessions");
const CWD = join(ROOT, "cwd");
const REAL_EXT = join(HERE, "..", "index.ts");

const NUDGE_NARRATED =
	"You described what you would do but called no tool, so nothing happened. Make that tool call now.";

for (const d of [EXT_DIR, SESSION_DIR, CWD]) mkdirSync(d, { recursive: true });

// Symlink so the test exercises the file that ships, not a copy of it.
mkdirSync(join(EXT_DIR, "tool-less-turn-nudge"));
symlinkSync(REAL_EXT, join(EXT_DIR, "tool-less-turn-nudge", "index.ts"));

// One tool, so "the model called a tool" is a thing that can actually happen here.
writeFileSync(
	join(EXT_DIR, "e2e-ping-tool.ts"),
	`import { Type } from "typebox";
export default function (pi) {
	pi.registerTool({
		name: "ping",
		label: "Ping",
		description: "Returns pong.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "pong" }], details: {} };
		},
	});
}
`,
);

writeFileSync(join(AGENT_DIR, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }, null, 2));
writeFileSync(join(AGENT_DIR, "auth.json"), "{}");

/* ---------------------------------------------------------------- scripted provider ---- */

/**
 * Turn-by-turn script. "prose" ends a turn with no tool call (the failure being defended
 * against); "tool" calls ping.
 *
 * 1 prose  -> nudge 1 (consecutive 1)
 * 2 tool   -> NO nudge, and the consecutive counter resets
 * 3 prose  -> nudge 2 (consecutive 1)
 * 4 prose  -> nudge 3 (consecutive 2)
 * 5 prose  -> nudge 4 (consecutive 3)
 * 6 prose  -> CAP: no nudge, run ends
 */
const SCRIPT = ["prose", "tool", "prose", "prose", "prose", "prose"];
const PROSE = "I will now unpause the game and begin exploring the layout by viewing the map around the park gate.";

const requests = [];

function sse(res, obj) {
	res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const server = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		if (req.method === "GET" && req.url.startsWith("/v1/models")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ id: "e2e-model", object: "model" }] }));
			return;
		}
		if (!req.url.includes("chat/completions")) {
			res.writeHead(404).end();
			return;
        }

		const parsed = JSON.parse(body);
		requests.push(parsed);
		const turn = SCRIPT[requests.length - 1] ?? "prose";

		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const base = { id: `chatcmpl-${requests.length}`, object: "chat.completion.chunk", created: 0, model: "e2e-model" };

		sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
		if (turn === "tool") {
			sse(res, {
				...base,
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: "ping", arguments: "" } },
							],
						},
						finish_reason: null,
					},
				],
			});
			sse(res, {
				...base,
				choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, finish_reason: null }],
			});
			sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
		} else {
			sse(res, { ...base, choices: [{ index: 0, delta: { content: PROSE }, finish_reason: null }] });
			sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
		}
		sse(res, { ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

writeFileSync(
	join(AGENT_DIR, "models.json"),
	JSON.stringify(
		{
			providers: {
				fake: {
					baseUrl: `http://127.0.0.1:${port}/v1`,
					api: "openai-completions",
					apiKey: "$E2E_KEY",
					models: [
						{
							id: "e2e-model",
							name: "e2e",
							reasoning: false,
							input: ["text"],
							contextWindow: 65536,
							maxTokens: 8192,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		},
		null,
		2,
	),
);

/* ------------------------------------------------------------------------------ run ---- */

const child = spawn(
	"pi",
	[
		"--mode",
		"json",
		"--provider",
		"fake",
		"--model",
		"e2e-model",
		"--no-builtin-tools",
		"--no-context-files",
		"--no-skills",
		"--no-prompt-templates",
		"start the run",
	],
	{
		cwd: CWD,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: AGENT_DIR,
			PI_CODING_AGENT_SESSION_DIR: SESSION_DIR,
			E2E_KEY: "not-a-real-key",
		},
		stdio: ["ignore", "pipe", "pipe"],
	},
);

let stdout = "";
let stderr = "";
child.stdout.on("data", (c) => (stdout += c));
child.stderr.on("data", (c) => (stderr += c));

const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
const code = await new Promise((resolve) => child.on("close", resolve));
clearTimeout(timeout);
server.close();

/* -------------------------------------------------------------------------- asserts ---- */

const failures = [];
const check = (ok, msg) => {
	console.log(`${ok ? "  ok  " : " FAIL "} ${msg}`);
	if (!ok) failures.push(msg);
};

const lastUserText = (req) => {
	for (let i = req.messages.length - 1; i >= 0; i--) {
		const m = req.messages[i];
		if (m.role !== "user") continue;
		return typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join("");
	}
	return undefined;
};

console.log(`\npi exited ${code}; ${requests.length} provider requests\n`);

check(requests.length === 6, `provider saw 6 requests (saw ${requests.length})`);
check(lastUserText(requests[0]) === "start the run", "request 1 is the human prompt");
check(lastUserText(requests[1]) === NUDGE_NARRATED, "request 2 is driven by the nudge, verbatim");
check(
	requests[2] && requests[2].messages.some((m) => m.role === "tool"),
	"request 3 follows the tool result, with NO nudge in between",
);
// Request 3 is the second turn of the SAME agent run as request 2, so its last user message
// is still request 2's nudge. What matters is that no NEW nudge was injected for the
// tool-calling turn: request 3 carries a tool result and the nudge tally is still 1 here.
check(
	requests[2].messages.filter((m) => m.role === "user").length === 2,
	"the tool-calling turn added no new user message (still prompt + 1 nudge)",
);
for (const i of [3, 4, 5]) {
	check(lastUserText(requests[i]) === NUDGE_NARRATED, `request ${i + 1} is driven by a nudge`);
}

const events = stdout
	.split("\n")
	.filter(Boolean)
	.flatMap((l) => {
		try {
			return [JSON.parse(l)];
		} catch {
			return [];
		}
	});
// 6 provider requests but 5 agent runs: the tool-calling turn and the turn that consumes its
// result are two turns inside one run, so that run emits one agent_end.
const agentEnds = events.filter((e) => e.type === "agent_end").length;
check(agentEnds === 5, `5 agent_end events for 6 provider requests (saw ${agentEnds})`);

const sessionId = events.find((e) => e.type === "session")?.id;
const logPath = join(AGENT_DIR, "logs", "nudges", `${sessionId}.jsonl`);
let logLines = [];
try {
	logLines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
} catch (err) {
	check(false, `nudge log readable at ${logPath} (${err.message})`);
}
const nudges = logLines.filter((l) => l.event === "nudge");
check(nudges.length === 4, `log records 4 nudges (records ${nudges.length})`);
check(
	nudges.map((n) => n.consecutive).join(",") === "1,1,2,3",
	`consecutive counter resets after the tool call (saw ${nudges.map((n) => n.consecutive).join(",")})`,
);
check(logLines.filter((l) => l.event === "cap_reached").length === 1, "log records the cap being hit once");
check(logLines.some((l) => l.event === "summary" && l.total === 4), "shutdown summary carries the total");
check(/nudge cap/i.test(stderr) || logLines.some((l) => l.event === "cap_reached"), "the cap is announced, not silent");

if (failures.length > 0) {
	console.log(`\npi stderr:\n${stderr.slice(-3000)}`);
	console.log(`\n${failures.length} FAILED`);
	process.exit(1);
}
console.log("\nall e2e checks passed");
