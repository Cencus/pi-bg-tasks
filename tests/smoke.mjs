/**
 * Manual smoke test for the extension itself (not part of `node --test`).
 *
 * Requires the Pi host packages to be resolvable (a `node_modules` link to the
 * host's, or a real install):
 *   node tests/smoke.mjs
 */
import registerBgTasks from "../extensions/bg-tasks.ts";

const tools = new Map();
const commands = new Map();
const handlers = new Map();
const messages = [];
const notices = [];
const statuses = [];

const pi = {
	registerTool: (tool) => tools.set(tool.name, tool),
	registerCommand: (name, def) => commands.set(name, def),
	on: (event, handler) => handlers.set(event, handler),
	getSettings: () => ({ shellPath: undefined, shellCommandPrefix: "export SMOKE_PREFIX=yes" }),
	sendMessage: (message, options) => messages.push({ message, options }),
};

registerBgTasks(pi);

const ctx = {
	cwd: process.cwd(),
	ui: {
		notify: (text, level) => notices.push(`${level}: ${text}`),
		setStatus: (key, value) => statuses.push(`${key}=${value}`),
		theme: { fg: (_color, text) => text },
	},
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (result) => result.content[0].text;
const run = tools.get("bg_run");
const status = tools.get("bg_status");
const kill = tools.get("bg_kill");
let failures = 0;

function check(name, condition, extra = "") {
	if (condition) console.log(`✔ ${name}`);
	else {
		failures += 1;
		console.log(`✘ ${name}${extra ? `\n${extra}` : ""}`);
	}
}

await handlers.get("session_start")({}, ctx);

// 1. A command that dies inside the probe window comes back in the same tool result.
const fast = await run.execute("c1", { command: "echo hello-from-bg; echo prefix=$SMOKE_PREFIX" }, undefined, undefined, ctx);
check("instant command returns inline", /It already finished successfully/.test(text(fast)), text(fast));
check("inline output is included", /hello-from-bg/.test(text(fast)));
check("shellCommandPrefix is applied", /prefix=yes/.test(text(fast)), text(fast));

// 2. A real background task: returns "running", then wakes the model on completion.
const bg = await run.execute("c2", { command: "sleep 1.2; echo done-late" }, undefined, undefined, ctx);
check("long command returns running", /Running detached/.test(text(bg)), text(bg));
check("no wake yet for a running task", messages.length === 0);
await sleep(3400);
check("completion woke the model", messages.length === 1, JSON.stringify(messages.map((m) => m.message.content)));
check("wake message is steer + triggerTurn", messages[0]?.options?.deliverAs === "steer" && messages[0]?.options?.triggerTurn === true);
check("wake message carries output", /done-late/.test(messages[0]?.message?.content ?? ""));

const single = await status.execute("c3", { id: bg.details.id, tail: 10 }, undefined, undefined, ctx);
check("status shows it done with exit 0", /done, exit 0/.test(text(single)), text(single));

// 3. An instant failure is reported inline and does not cost an extra turn.
const before = messages.length;
const failed = await run.execute("c4", { command: "definitely-not-a-binary-xyz" }, undefined, undefined, ctx);
check("instant failure reported inline", /exited immediately/.test(text(failed)) && /not found/.test(text(failed)), text(failed));
await sleep(1900);
check("instant failure did not wake the model", messages.length === before);

// 4. Duplicate command+cwd reuses the running task instead of starting another.
const long = await run.execute("c5", { command: "sleep 30" }, undefined, undefined, ctx);
const duplicate = await run.execute("c6", { command: "sleep 30" }, undefined, undefined, ctx);
check("duplicate run returns the existing id", duplicate.details.id === long.details.id, text(duplicate));

// 5. bg_kill stops the tree and marks the task cancelled.
const killed = await kill.execute("c7", { id: long.details.id }, undefined, undefined, ctx);
check("bg_kill reports the kill", /Sent kill/.test(text(killed)), text(killed));
await sleep(1200);
const afterKill = await status.execute("c8", { id: long.details.id }, undefined, undefined, ctx);
check("killed task is cancelled", /cancelled/.test(text(afterKill)), text(afterKill));

// 6. timeoutMs kills a hung task and reports it like any other completion.
const timed = await run.execute(
	"c9",
	{ command: "echo hung; sleep 60; echo never", timeoutMs: 1200 },
	undefined,
	undefined,
	ctx,
);
await sleep(2600);
const afterTimeout = await status.execute("c10", { id: timed.details.id }, undefined, undefined, ctx);
check("timeout marks the task as timeout", /timeout/.test(text(afterTimeout)), text(afterTimeout));
check("timeout log has no output after the kill", !/^never$/m.test(text(afterTimeout)));

// 7. waitMs is capped and never used as a polling loop.
const waitStartedAt = Date.now();
const waited = await status.execute("c11", { id: timed.details.id, waitMs: 999_999 }, undefined, undefined, ctx);
check("waitMs on a finished task does not wait", Date.now() - waitStartedAt < 500 && /timeout/.test(text(waited)));

// 8. Listing does not block.
const listStartedAt = Date.now();
await status.execute("c12", {}, undefined, undefined, ctx);
check("plain list is instant", Date.now() - listStartedAt < 500);

// 9. /bg and unknown-id handling.
await commands.get("bg").handler("", ctx);
check("/bg renders the list", notices.some((n) => /Background tasks:/.test(n)), notices.join("\n"));
const unknown = await status.execute("c13", { id: "bg-nope" }, undefined, undefined, ctx);
check("unknown id lists known ids", /Known ids:/.test(text(unknown)), text(unknown));

// 10. Shell overrides: PowerShell quoting and cmd.exe legacy string form.
if (process.platform === "win32") {
	const ps = await run.execute(
		"c14",
		{ command: 'Write-Output "a b"; Write-Output "second line"', shell: "powershell" },
		undefined,
		undefined,
		ctx,
	);
	check("powershell override survives quotes", /a b/.test(text(ps)) && /second line/.test(text(ps)), text(ps));
	const cmd = await run.execute("c15", { command: "echo cmd-ok", shell: "cmd.exe" }, undefined, undefined, ctx);
	check("cmd.exe override runs", /cmd-ok/.test(text(cmd)), text(cmd));
}

// 11. Clean up: nothing should be left running.
await kill.execute("c16", {}, undefined, undefined, ctx);
console.log(failures === 0 ? "\nALL SMOKE CHECKS PASSED" : `\n${failures} SMOKE CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);