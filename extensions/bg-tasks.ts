/**
 * Background Tasks Extension for Pi
 *
 * Adds two tools the model can call:
 *   - bg_run   : start a shell command in the background, return immediately,
 *                and notify via ctx.ui.notify() when it finishes.
 *   - bg_status: report status of background tasks (running / done / failed)
 *                and optionally tail the log.
 *
 * Plus a `/bg` command for the user to see the task list in the TUI.
 *
 * Why: pi's built-in bash tool blocks until a command finishes. Long installs
 * (e.g. `brew install --cask codex`) freeze the agent. This extension lets the
 * model hand the job off, keep working, and get pinged when it's done — like
 * opencode 2.x background tasks.
 *
 * Tasks live in memory for the lifetime of the Pi process. Logs are written to
 * ~/.pi/bg-tasks/<id>.log so you can inspect them even after Pi exits.
 */

import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface BgTask {
	id: string;
	command: string;
	cwd: string;
	pid: number;
	startedAt: number;
	finishedAt?: number;
	exitCode?: number;
	status: "running" | "done" | "failed";
	logPath: string;
}

const BgRunParams = Type.Object({
	command: Type.String({ description: "Shell command to run in the background." }),
	cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the session cwd." })),
});

const BgStatusParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Inspect a single task by id. Omit to list all." })),
	tail: Type.Optional(
		Type.Number({ description: "Number of trailing log lines to include (default 20). 0 = none." }),
	),
});

const LOG_DIR = join(homedir(), ".pi", "bg-tasks");

export default function bgTasksExtension(pi: ExtensionAPI) {
	mkdirSync(LOG_DIR, { recursive: true });

	// In-memory task registry. Keyed by task id.
	const tasks = new Map<string, BgTask>();
	let counter = 0;

	function newId(): string {
		counter += 1;
		const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		return `bg-${counter}-${stamp}`;
	}

	function runningCount(): number {
		let n = 0;
		for (const t of tasks.values()) if (t.status === "running") n += 1;
		return n;
	}

	function refreshStatusLine(ctx: ExtensionContext) {
		const n = runningCount();
		if (n > 0) {
			ctx.ui.setStatus("bg-tasks", ctx.ui.theme.fg("accent", `bg:${n} running`));
		} else {
			ctx.ui.setStatus("bg-tasks", "");
		}
	}

	function tailLog(task: BgTask, lines: number): string {
		if (lines <= 0) return "";
		try {
			const data = readFileSync(task.logPath, "utf8");
			const all = data.split("\n");
			if (all.length && all[all.length - 1] === "") all.pop();
			return all.slice(-lines).join("\n");
		} catch {
			return "(no log yet)";
		}
	}

	function summarize(t: BgTask): string {
		const dur = t.finishedAt ? ((t.finishedAt - t.startedAt) / 1000).toFixed(1) + "s" : "—";
		return `[${t.id}] ${t.status}${t.exitCode !== undefined ? ` (exit ${t.exitCode})` : ""} ${dur} — ${t.command}`;
	}

	// --- bg_run tool ----------------------------------------------------------
	pi.registerTool({
		name: "bg_run",
		label: "BgRun",
		description:
			"Run a shell command in the background and return immediately. " +
			"Output is tee'd to a log file under ~/.pi/bg-tasks/. " +
			"A desktop/terminal notification fires when the command exits. " +
			"Use this for long-running installs, builds, downloads, or servers " +
			"instead of the blocking bash tool. Returns the task id and log path. " +
			"Poll completion with bg_status.",
		parameters: BgRunParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = params.cwd || ctx.cwd;
			const id = newId();
			const logPath = join(LOG_DIR, `${id}.log`);

			const child = spawn(params.command, {
				shell: true,
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
			});

			const task: BgTask = {
				id,
				command: params.command,
				cwd,
				pid: child.pid ?? -1,
				startedAt: Date.now(),
				status: "running",
				logPath,
			};
			tasks.set(id, task);

			const log = createWriteStream(logPath, { flags: "w" });
			log.write(`$ ${params.command}\n# cwd: ${cwd}\n# pid: ${child.pid}\n\n`);

			child.stdout.on("data", (chunk: Buffer) => log.write(chunk));
			child.stderr.on("data", (chunk: Buffer) => log.write(chunk));

			child.on("error", (err) => {
				log.write(`\n# error: ${err.message}\n`);
				task.status = "failed";
				task.exitCode = -1;
				task.finishedAt = Date.now();
				log.end(() => {
					try {
						ctx.ui.notify(`bg ${id} failed: ${err.message}`, "error");
					} catch {
						/* ui gone */
					}
					refreshStatusLine(ctx);
				});
			});

			child.on("close", (code) => {
				task.finishedAt = Date.now();
				task.exitCode = code ?? -1;
				task.status = code === 0 ? "done" : "failed";
				log.write(`\n# exit ${code}\n`);
				log.end(() => {
					const ok = task.status === "done";
					const dur = ((task.finishedAt - task.startedAt) / 1000).toFixed(1);
					const msg = `${id} ${ok ? "done" : "failed"} (${dur}s, exit ${code})`;
					try {
						ctx.ui.notify(msg, ok ? "info" : "error");
					} catch {
						/* ui gone */
					}
					refreshStatusLine(ctx);
				});
			});

			refreshStatusLine(ctx);

			const head = summarize(task);
			return {
				content: [
					{
						type: "text",
						text: `${head}\nlog: ${logPath}\nThe command is running detached from the agent. ` +
							`It will notify on completion. Use bg_status to check progress.`,
					},
				],
				details: { id, logPath, pid: task.pid, status: "running" },
			};
		},

		renderCall(args, theme) {
			const cmd = String(args.command ?? "");
			return new Text(
				theme.fg("toolTitle", theme.bold("bg_run ")) + theme.fg("muted", cmd),
				0,
				0,
			);
		},

		renderResult(result, _opts, theme) {
			const text = result.content[0];
			return new Text(
				theme.fg("success", "✓ ") + theme.fg("muted", text?.type === "text" ? text.text.split("\n")[0] : ""),
				0,
				0,
			);
		},
	});

	// --- bg_status tool -------------------------------------------------------
	pi.registerTool({
		name: "bg_status",
		label: "BgStatus",
		description:
			"Report status of background tasks started with bg_run. " +
			"Without an id, lists every task (id, status, exit code, duration, command). " +
			"With an id, returns the same plus the last N lines of its log (tail, default 20).",
		parameters: BgStatusParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const tail = params.tail ?? 20;

			if (params.id) {
				const t = tasks.get(params.id);
				if (!t) {
					return {
						content: [{ type: "text", text: `No background task with id ${params.id}` }],
						details: { id: params.id, found: false },
					};
				}
				const lines = tailLog(t, tail);
				const body =
					`${summarize(t)}\nlog: ${t.logPath}\n` +
					(t.status === "running" ? "(still running)\n" : "") +
					(lines ? `\n--- last ${tail} lines ---\n${lines}\n` : "");
				return {
					content: [{ type: "text", text: body }],
					details: {
						id: t.id,
						status: t.status,
						exitCode: t.exitCode,
						logPath: t.logPath,
						found: true,
					},
				};
			}

			if (tasks.size === 0) {
				return {
					content: [{ type: "text", text: "No background tasks." }],
					details: { tasks: [] },
				};
			}

			const list = Array.from(tasks.values())
				.sort((a, b) => b.startedAt - a.startedAt)
				.map(summarize)
				.join("\n");
			return {
				content: [{ type: "text", text: `${list}\n\nTip: bg_status with id and tail to see log output.` }],
				details: {
					tasks: Array.from(tasks.values()).map((t) => ({
						id: t.id,
						status: t.status,
						exitCode: t.exitCode,
						command: t.command,
					})),
				},
			};
		},

		renderCall(args, theme) {
			const label = args.id ? `bg_status ${args.id}` : "bg_status";
			return new Text(theme.fg("toolTitle", theme.bold(label)), 0, 0);
		},

		renderResult(result, _opts, theme) {
			const text = result.content[0];
			return new Text(theme.fg("muted", text?.type === "text" ? text.text : ""), 0, 0);
		},
	});

	// --- /bg command ----------------------------------------------------------
	pi.registerCommand("bg", {
		description: "List background tasks and their status",
		handler: async (_args, ctx) => {
			if (tasks.size === 0) {
				ctx.ui.notify("No background tasks", "info");
				return;
			}
			const lines = Array.from(tasks.values())
				.sort((a, b) => b.startedAt - a.startedAt)
				.map((t) => {
					const mark = t.status === "running" ? "▶" : t.status === "done" ? "✓" : "✗";
					const dur = t.finishedAt ? ((t.finishedAt - t.startedAt) / 1000).toFixed(1) + "s" : "running";
					return `${mark} ${t.id}  ${dur}  ${t.command}`;
				})
				.join("\n");
			ctx.ui.notify(`Background tasks:\n${lines}`, "info");
		},
	});

	// Keep log dir tidy is the user's job; we only ensure it exists on load.
	pi.on("session_start", async (_event, ctx) => {
		mkdirSync(LOG_DIR, { recursive: true });
		refreshStatusLine(ctx);
	});

	// On shutdown, leave children running (truly background). We only flush a note.
	pi.on("session_shutdown", async () => {
		const running = Array.from(tasks.values()).filter((t) => t.status === "running");
		if (running.length > 0) {
			for (const t of running) {
				try {
					const s = statSync(t.logPath);
					void s;
				} catch {
					/* ignore */
				}
			}
		}
	});
}
