/**
 * Verifies the core durability promise: a bg_run task keeps running after the
 * Pi host process exits, and keeps writing to its log.
 *
 * Before the `detached` + fd-stdio change the child died with its parent, so
 * "quit Pi, the download continues" was false.
 *
 *   node tests/detach-check.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HOST = fileURLToPath(import.meta.url);
const MARKER = fileURLToPath(new URL("../.smoke-survivor.json", import.meta.url));

if (process.env.BG_DETACH_HOST === "1") {
	// Child mode: start a task, record it, and exit like a quitting Pi process.
	const { default: registerBgTasks } = await import("../extensions/bg-tasks.ts");
	const tools = new Map();
	registerBgTasks({
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: () => {},
		on: () => {},
		getSettings: () => ({}),
		sendMessage: () => {},
	});
	const ctx = {
		cwd: process.cwd(),
		ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_c, t) => t } },
	};
	const task = await tools.get("bg_run").execute(
		"detach",
		{ command: "for i in $(seq 1 20); do echo tick-$i; sleep 0.2; done" },
		undefined,
		undefined,
		ctx,
	);
	const { writeFileSync } = await import("node:fs");
	writeFileSync(MARKER, JSON.stringify({ pid: task.details.pid, logPath: task.details.logPath }));
	process.exit(0);
}

if (existsSync(MARKER)) unlinkSync(MARKER);
const host = spawn(process.execPath, [HOST], {
	env: { ...process.env, BG_DETACH_HOST: "1" },
	stdio: "ignore",
	windowsHide: true,
});
await new Promise((resolve) => host.on("exit", resolve));
if (!existsSync(MARKER)) {
	console.log("✘ host never reported a task");
	process.exit(1);
}
const { pid, logPath } = JSON.parse(readFileSync(MARKER, "utf8"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (target) => {
	if (process.platform === "win32") {
		const out = spawn("tasklist", ["/FI", `PID eq ${target}`, "/NH"], { windowsHide: true });
		return new Promise((resolve) => {
			let text = "";
			out.stdout.on("data", (d) => {
				text += d;
			});
			out.on("exit", () => resolve(text.includes(String(target))));
		});
	}
	try {
		process.kill(target, 0);
		return Promise.resolve(true);
	} catch {
		return Promise.resolve(false);
	}
};
const killTree = (target) => {
	if (process.platform === "win32") spawn("taskkill", ["/PID", String(target), "/T", "/F"], { windowsHide: true });
	else {
		try {
			process.kill(-target, "SIGKILL");
		} catch {
			try {
				process.kill(target, "SIGKILL");
			} catch {
				/* gone */
			}
		}
	}
};

let failures = 0;
const check = (name, ok, extra = "") => {
	if (ok) console.log(`✔ ${name}`);
	else {
		failures += 1;
		console.log(`✘ ${name}${extra ? `\n${extra}` : ""}`);
	}
};

check("task is still running after the host exited", await alive(pid), `pid ${pid}`);
const sizeBefore = statSync(logPath).size;
await sleep(1200);
const sizeAfter = statSync(logPath).size;
check("task keeps writing to its log after the host exited", sizeAfter > sizeBefore, `${sizeBefore} → ${sizeAfter} bytes`);

killTree(pid);
await sleep(500);
check("cleanup killed the task", !(await alive(pid)));
if (existsSync(MARKER)) unlinkSync(MARKER);

console.log(failures === 0 ? "\nDETACH CHECK PASSED" : `\n${failures} DETACH CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);