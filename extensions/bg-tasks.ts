/**
 * Background Tasks Extension for Pi
 *
 * Adds two tools the model can call:
 *   - bg_run   : start a shell command in the background and return immediately.
 *                On exit it injects a custom message into the session with
 *                triggerTurn, so the *model* is woken (not just the human via
 *                ctx.ui.notify) and can continue on its own.
 *   - bg_status: report status of background tasks (running / done / failed),
 *                optionally tail the log, and optionally block until the task
 *                finishes (waitMs).
 *
 * Completions used to only call ctx.ui.notify(), which shows a toast to the
 * human but injects nothing into the model's context. So "end the turn, the
 * completion notification will wake you" was false, and models compensated by
 * calling `sleep`. Every completion now also lands as a custom_message entry.
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
	waitMs: Type.Optional(
		Type.Number({
			description:
				"With id: block until the task finishes, up to this many ms (max 120000). " +
				"Returns as soon as it exits. Use this instead of shell sleep.",
		}),
	),
	tail: Type.Optional(
		Type.Number({ description: "Number of trailing log lines to include (default 20). 0 = none." }),
	),
});

// Delay used to merge tasks that finish together into a single wake message.
const WAKE_COALESCE_MS = 1500;
const WAIT_MAX_MS = 120_000;


const LOG_DIR = join(homedir(), ".pi", "bg-tasks");

export default function bgTasksExtension(pi: ExtensionAPI) {
	mkdirSync(LOG_DIR, { recursive: true });

	// In-memory task registry. Keyed by task id.
	const tasks = new Map<string, BgTask>();
	let counter = 0;

	// Resolvers waiting inside bg_status(waitMs), keyed by task id.
	const waiters = new Map<string, Array<() => void>>();

	function resolveWaiters(task: BgTask) {
		const list = waiters.get(task.id);
		if (!list) return;
		waiters.delete(task.id);
		for (const resolve of list) resolve();
	}

	// Resolves true when the task leaves "running", false on timeout or abort.
	function waitForExit(task: BgTask, ms: number, signal?: AbortSignal): Promise<boolean> {
		if (task.status !== "running") return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(value);
			};
			const onAbort = () => finish(false);
			const timer = setTimeout(() => finish(false), ms);
			const list = waiters.get(task.id) ?? [];
			list.push(() => finish(true));
			waiters.set(task.id, list);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	// A completion wakes the model through the session, not only the human.
	// One message per burst: tasks finishing together cost one turn, not one each.
	const finishedQueue: BgTask[] = [];
	let wakeTimer: ReturnType<typeof setTimeout> | null = null;

	function queueWake(task: BgTask) {
		finishedQueue.push(task);
		if (wakeTimer) return;
		wakeTimer = setTimeout(() => {
			wakeTimer = null;
			const batch = finishedQueue.splice(0, finishedQueue.length);
			if (batch.length === 0) return;
			const body = batch
				.map((t) => {
					const out = tailLog(t, 15);
					return out ? `${summarize(t)}\n--- last 15 lines ---\n${out}` : summarize(t);
				})
				.join("\n\n");
			try {
				pi.sendMessage(
					{
						customType: "bg-task-done",
						content:
							`Background task${batch.length > 1 ? "s" : ""} finished (${batch.length}):\n\n${body}\n\n` +
							"Read more with bg_status if needed. Do not sleep to wait for background tasks.",
						display: true,
						details: {
							tasks: batch.map((t) => ({
								id: t.id,
								status: t.status,
								exitCode: t.exitCode,
								command: t.command,
								logPath: t.logPath,
							})),
						},
					},
					{ deliverAs: "steer", triggerTurn: true },
				);
			} catch {
				/* session gone — the toast already told the human */
			}
		}, WAKE_COALESCE_MS);
		wakeTimer.unref?.();
	}

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
					resolveWaiters(task);
					queueWake(task);
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
					resolveWaiters(task);
					queueWake(task);
				});
			});

			refreshStatusLine(ctx);

			const head = summarize(task);
			return {
				content: [
					{
						type: "text",
						text: `${head}\nlog: ${logPath}\nThe command is running detached from the agent. Its ` +
							"completion is injected into this session as a message, so you do not need to stay " +
							"on it: end the turn and you will be resumed when it finishes. To block on it " +
							"instead, call bg_status with waitMs. Never follow bg_run with sleep.",
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
			"With an id, returns the same plus the last N lines of its log (tail, default 20). " +
			"Pass waitMs (up to 120000) to block until that task finishes or the deadline hits: " +
			"this is the supported way to wait for a bg task, not a shell sleep.",
		parameters: BgStatusParams,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const tail = params.tail ?? 20;

			if (params.id) {
				const t = tasks.get(params.id);
				if (!t) {
					return {
						content: [{ type: "text", text: `No background task with id ${params.id}` }],
						details: { id: params.id, found: false },
					};
				}
				const waitMs = Math.min(Math.max(params.waitMs ?? 0, 0), WAIT_MAX_MS);
				let waitNote = "";
				if (t.status === "running" && waitMs > 0) {
					const finished = await waitForExit(t, waitMs, signal as AbortSignal | undefined);
					waitNote = finished
						? "(finished while waiting)\n"
						: `(still running after waiting ${waitMs}ms — do not sleep; end the turn and the ` +
							"completion message will resume you)\n";
				}
				const lines = tailLog(t, tail);
				const body =
					`${summarize(t)}\nlog: ${t.logPath}\n` +
					(t.status === "running" ? waitNote || "(still running)\n" : waitNote) +
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
