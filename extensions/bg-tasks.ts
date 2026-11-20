/**
 * Background Tasks Extension for Pi
 *
 * Adds three tools the model can call:
 *   - bg_run   : start a shell command detached from the agent and return
 *                immediately. On exit it injects a custom message into the
 *                session with triggerTurn, so the *model* is woken (not just
 *                the human via ctx.ui.notify) and can continue on its own.
 *   - bg_status: report status of background tasks, optionally tail the log.
 *                Waiting is deliberately a rare, short, opt-in escape hatch —
 *                completion (success / failure / cancel / timeout) is a
 *                callback, so polling is never the intended pattern.
 *   - bg_kill  : stop a task and its whole process tree. Without this, a
 *                `npm run dev` in the background was unstoppable.
 *
 * Plus a `/bg` command for the user to see the task list in the TUI.
 *
 * Design notes worth keeping:
 *   - Children are spawned `detached` with the log file passed as a real fd.
 *     With pipes + a non-detached child, the task dies the moment Pi exits
 *     (verified on Windows: the child vanished with its parent), which made
 *     "quit Pi, the install keeps going" false. fd + detached makes it true,
 *     and also removes the parent's memory from the output path.
 *   - A completion is the primary contract. `waitMs` exists for the residual
 *     case and is capped low, because "bg_run then block" is strictly worse
 *     than a foreground `bash` call.
 *   - Tasks live in memory for the lifetime of the Pi process. Logs are
 *     written to ~/.pi/bg-tasks/<id>.log and pruned by age on session start.
 */

import { spawn, spawnSync } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	mkdirSync,
	openSync,
	readdirSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as piHost from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	buildInvocation,
	classifyShell,
	formatBytes,
	formatCommand,
	formatDuration,
	tailLines,
	windowsKillArgs,
	type ShellPick,
} from "./bg-lib.ts";

type BgTaskStatus = "running" | "done" | "failed" | "cancelled" | "timeout";

interface BgTask {
	id: string;
	command: string;
	cwd: string;
	shell: string;
	pid: number;
	startedAt: number;
	finishedAt?: number;
	exitCode?: number;
	signal?: string;
	status: BgTaskStatus;
	logPath: string;
	timeoutMs?: number;
	timer?: ReturnType<typeof setTimeout>;
	/** Set when the tool result already carries the outcome (early exit, kill). */
	wakeSuppressed?: boolean;
	/** True while bg_run is still probing for an instant exit: no toast needed. */
	quiet?: boolean;
	cancelled?: boolean;
	timedOut?: boolean;
}

const BgRunParams = Type.Object({
	command: Type.String({ description: "Shell command to run in the background." }),
	cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the session cwd." })),
	shell: Type.Optional(
		Type.String({
			description:
				"Shell executable to run the command with. Defaults to the shell the bash tool uses " +
				"(settings.shellPath, else Git Bash on Windows, else sh/bash). Pass pwsh for PowerShell.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description:
				"Optional watchdog: kill the task (and its process tree) if it is still running after " +
				"this many ms. Use it for commands that can hang on a prompt or a stalled network read. " +
				"A timeout is reported back to you like any other completion.",
		}),
	),
});

const BgStatusParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Inspect a single task by id. Omit to list all." })),
	waitMs: Type.Optional(
		Type.Number({
			description:
				"Rarely needed. Block up to this many ms (max 30000) for this task — or, without id, " +
				"for every running task — to finish. Completions are delivered to you automatically; " +
				"only wait when your very next step truly needs the output and you have no other work. " +
				"Never poll with it.",
		}),
	),
	tail: Type.Optional(
		Type.Number({ description: "Trailing log lines to include (default 20, max 500). 0 = none." }),
	),
});

const BgKillParams = Type.Object({
	id: Type.Optional(
		Type.String({
			description: "Task to stop. Omit to stop every running task.",
		}),
	),
});

// Completions that land close together are merged into one wake message.
const WAKE_COALESCE_MS = 1500;
// Waiting is an escape hatch, not a workflow: keep it short.
const WAIT_MAX_MS = 30_000;
// How long bg_run holds the tool call open to catch instant failures inline.
const EARLY_EXIT_PROBE_MS = 500;
const MAX_TAIL_LINES = 500;
const WAKE_TAIL_LINES = 15;
const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LARGE_LOG_BYTES = 50 * 1024 * 1024;

const LOG_DIR = join(homedir(), ".pi", "bg-tasks");

export default function bgTasksExtension(pi: ExtensionAPI) {
	mkdirSync(LOG_DIR, { recursive: true });

	// In-memory task registry. Keyed by task id.
	const tasks = new Map<string, BgTask>();
	let counter = 0;
	let liveness = 0;

	// Resolvers waiting inside bg_status(waitMs), keyed by task id.
	const waiters = new Map<string, Array<() => void>>();

	function resolveWaiters(task: BgTask) {
		const list = waiters.get(task.id);
		if (!list) return;
		waiters.delete(task.id);
		for (const resolve of list) resolve();
	}

	type WaitOutcome = "exited" | "timeout" | "aborted";

	function waitForExit(task: BgTask, ms: number, signal?: AbortSignal): Promise<WaitOutcome> {
		if (task.status !== "running") return Promise.resolve("exited");
		// An already-aborted tool call must not burn the full deadline.
		if (signal?.aborted) return Promise.resolve("aborted");
		return new Promise<WaitOutcome>((resolve) => {
			let settled = false;
			const finish = (value: WaitOutcome) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(value);
			};
			const onAbort = () => finish("aborted");
			const timer = setTimeout(() => finish("timeout"), ms);
			const list = waiters.get(task.id) ?? [];
			list.push(() => finish("exited"));
			waiters.set(task.id, list);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/** Resolves true once nothing is running, false on deadline/abort. */
	async function waitUntilIdle(ms: number, signal?: AbortSignal): Promise<boolean> {
		const deadline = Date.now() + ms;
		for (;;) {
			const running = Array.from(tasks.values()).filter((t) => t.status === "running");
			if (running.length === 0) return true;
			const remaining = deadline - Date.now();
			if (remaining <= 0 || signal?.aborted) return false;
			await Promise.all(running.map((t) => waitForExit(t, remaining, signal)));
			if (signal?.aborted) return false;
		}
	}

	// A completion wakes the model through the session, not only the human.
	// One message per burst: tasks finishing together cost one turn, not one each.
	const finishedQueue: BgTask[] = [];
	let wakeTimer: ReturnType<typeof setTimeout> | null = null;

	function queueWake(task: BgTask) {
		if (dead) return;
		finishedQueue.push(task);
		if (wakeTimer) return;
		wakeTimer = setTimeout(() => {
			wakeTimer = null;
			// Suppression is decided after finalize (the early-exit probe and bg_kill
			// deliver the outcome in their own tool result), so filter at flush time.
			const batch = finishedQueue.splice(0, finishedQueue.length).filter((t) => !t.wakeSuppressed);
			if (batch.length === 0) return;
			if (dead) return;
			const body = batch
				.map((t) => {
					const tail = tailLog(t, WAKE_TAIL_LINES);
					return tail.text ? `${summarize(t)}\n--- last ${WAKE_TAIL_LINES} lines ---\n${tail.text}` : summarize(t);
				})
				.join("\n\n");
			try {
				pi.sendMessage(
					{
						customType: "bg-task-done",
						content:
							`Background task${batch.length > 1 ? "s" : ""} finished (${batch.length}):\n\n${body}\n\n` +
							"Logs: bg_status { id } for more output. Do not sleep or poll to wait for background tasks.",
						display: true,
						details: {
							tasks: batch.map((t) => ({
								id: t.id,
								status: t.status,
								exitCode: t.exitCode,
								signal: t.signal,
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
		// Counter + clock alone collide across concurrent Pi processes writing to
		// the same ~/.pi/bg-tasks, and the log is opened with "w" — so salt it.
		const now = new Date();
		const hms = [now.getHours(), now.getMinutes(), now.getSeconds()]
			.map((n) => String(n).padStart(2, "0"))
			.join("");
		const salt = Math.random().toString(36).slice(2, 5);
		return `bg-${counter}-${hms}${salt}`;
	}

	// --- shell resolution -----------------------------------------------------

	let settingsCache: { shellPath?: string; shellCommandPrefix?: string } | undefined;

	function settings(): { shellPath?: string; shellCommandPrefix?: string } {
		if (settingsCache) return settingsCache;
		try {
			const raw = pi.getSettings() as { shellPath?: string; shellCommandPrefix?: string };
			settingsCache = { shellPath: raw?.shellPath, shellCommandPrefix: raw?.shellCommandPrefix };
		} catch {
			settingsCache = {};
		}
		return settingsCache;
	}

	function expandHome(path: string): string {
		return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
	}

	function isFile(path: string): boolean {
		try {
			return statSync(path).isFile();
		} catch {
			return false;
		}
	}

	function whichSync(command: string): string | undefined {
		for (const dir of (process.env.PATH ?? "").split(delimiter)) {
			if (!dir) continue;
			const full = join(dir, command);
			if (isFile(full)) return full;
		}
		return undefined;
	}

	/**
	 * Host-provided resolver. Read off the module namespace rather than imported by
	 * name: a named import of a symbol an older Pi does not export throws at load
	 * time, which would take the whole extension down.
	 */
	const hostResolveShell = (piHost as {
		getShellConfig?: (customShellPath?: string) => {
			shell: string;
			args: string[];
			commandTransport?: "argv" | "stdin";
		};
	}).getShellConfig;

	// Fallback for older hosts (or a host that cannot find bash at all).
	function fallbackShell(): ShellPick {
		const configured = settings().shellPath;
		if (configured) {
			const expanded = expandHome(configured);
			if (isFile(expanded)) return { shell: expanded, args: ["-c"], commandTransport: "argv" };
		}
		if (process.platform === "win32") {
			const gitBash = [
				join(process.env.ProgramFiles ?? "", "Git", "bin", "bash.exe"),
				join(process.env["ProgramFiles(x86)"] ?? "", "Git", "bin", "bash.exe"),
			].find(isFile);
			const found = gitBash ?? whichSync("bash.exe");
			if (found) return { shell: found, args: ["-c"], commandTransport: "argv" };
			return { shell: process.env.ComSpec || "cmd.exe", args: [], commandTransport: "argv" };
		}
		const posix = ["/bin/bash", "/usr/bin/bash", "/bin/sh"].find(isFile);
		return { shell: posix ?? process.env.SHELL ?? "sh", args: ["-c"], commandTransport: "argv" };
	}

	// Prefer pi's own resolver so bg_run really uses the bash tool's shell
	// (settings.shellPath, Git Bash on Windows, /bin/bash on Unix).
	function resolveShell(override?: string): ShellPick {
		if (override) {
			const kind = classifyShell(override);
			return {
				shell: override,
				args: kind === "bash" ? ["-c"] : [],
				commandTransport: "argv",
			};
		}
		const shellPath = settings().shellPath;
		if (hostResolveShell) {
			try {
				const config = hostResolveShell(shellPath ? expandHome(shellPath) : undefined);
				return {
					shell: config.shell,
					args: config.args,
					commandTransport: config.commandTransport ?? "argv",
				};
			} catch {
				/* fall through */
			}
		}
		return fallbackShell();
	}

	/**
	 * `shellCommandPrefix` runs before every built-in bash command (nvm, aliases,
	 * `export CI=1`…). bg_run used to drop it, so commands that worked in `bash`
	 * failed with `command not found` here. Only bash-family shells get it —
	 * the prefix is bash syntax.
	 */
	function applyCommandPrefix(pick: ShellPick, command: string): string {
		const prefix = settings().shellCommandPrefix;
		if (!prefix || classifyShell(pick.shell) !== "bash") return command;
		return `${prefix}\n${command}`;
	}

	// --- ui plumbing ----------------------------------------------------------

	function runningCount(): number {
		let n = 0;
		for (const t of tasks.values()) if (t.status === "running") n += 1;
		return n;
	}

	// The freshest session ctx we've been handed. Session-bound ctx objects go
	// stale after newSession / fork / switchSession / reload, and child-process
	// callbacks (plus their timers) can fire long after that. So never keep a
	// ctx around to use later: re-read this slot at call time, and treat every
	// ui touch as best-effort — a stale ctx throws on property access, and that
	// throw escaping an async callback kills pi with an uncaughtException.
	let uiCtx: ExtensionContext | null = null;
	let dead = false;

	function adoptCtx(ctx: ExtensionContext | null | undefined) {
		if (ctx) uiCtx = ctx;
	}

	function withUi(touch: (ui: ExtensionContext["ui"]) => void) {
		const ctx = uiCtx;
		if (dead || !ctx) return;
		try {
			touch(ctx.ui);
		} catch {
			// Session was replaced: drop the stale ctx until session_start re-adopts.
			uiCtx = null;
		}
	}

	function notify(message: string, level: "info" | "error") {
		withUi((ui) => ui.notify(message, level));
	}

	function refreshStatusLine() {
		const n = runningCount();
		withUi((ui) => ui.setStatus("bg-tasks", n > 0 ? ui.theme.fg("accent", `bg:${n} running`) : ""));
	}

	// --- task formatting ------------------------------------------------------

	function tailLog(task: BgTask, lines: number): { text: string; truncated: boolean } {
		const limit = Math.min(Math.max(lines, 0), MAX_TAIL_LINES);
		return tailLines(task.logPath, limit);
	}

	function logSizeNote(task: BgTask): string {
		try {
			const size = statSync(task.logPath).size;
			if (size < LARGE_LOG_BYTES) return "";
			return ` (${formatBytes(size)} — large; tail is capped, read the file if you need more)`;
		} catch {
			return "";
		}
	}

	function outcomeLabel(t: BgTask): string {
		if (t.status === "running") return "running";
		const bits: string[] = [t.status];
		if (t.signal) bits.push(`signal ${t.signal}`);
		else if (t.exitCode !== undefined) bits.push(`exit ${t.exitCode}`);
		return bits.join(", ");
	}

	function summarize(t: BgTask): string {
		const dur = formatDuration((t.finishedAt ?? Date.now()) - t.startedAt);
		return `[${t.id}] ${outcomeLabel(t)} ${dur} — ${formatCommand(t.command)}`;
	}

	// --- process control ------------------------------------------------------

	function killTree(task: BgTask) {
		if (task.pid <= 0) return;
		if (process.platform === "win32") {
			try {
				spawnSync("taskkill", windowsKillArgs(task.pid), { windowsHide: true });
			} catch {
				/* already gone */
			}
			return;
		}
		// detached: true put the child in its own process group, so -pid is the tree.
		try {
			process.kill(-task.pid, "SIGTERM");
		} catch {
			try {
				process.kill(task.pid, "SIGTERM");
			} catch {
				return;
			}
		}
		const hard = setTimeout(() => {
			try {
				process.kill(-task.pid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}, 3000);
		hard.unref?.();
	}

	function findRunning(command: string, cwd: string): BgTask | undefined {
		for (const t of tasks.values()) {
			if (t.status === "running" && t.command === command && t.cwd === cwd) return t;
		}
		return undefined;
	}

	function finalize(task: BgTask, code: number | null, signal: string | null, note?: string) {
		// A spawn error and a close can both fire; first one wins.
		if (task.finishedAt) return;
		task.finishedAt = Date.now();
		task.signal = signal ?? undefined;
		task.exitCode = code ?? (signal ? 128 : -1);
		if (task.timer) {
			clearTimeout(task.timer);
			task.timer = undefined;
		}
		if (task.cancelled) task.status = "cancelled";
		else if (task.timedOut) task.status = "timeout";
		else task.status = code === 0 ? "done" : "failed";

		const dur = formatDuration(task.finishedAt - task.startedAt);
		try {
			appendFileSync(
				task.logPath,
				`\n# ${note ? `${note} — ` : ""}${task.status} after ${dur}` +
					(signal ? ` (signal ${signal})` : code !== null ? ` (exit ${code})` : "") +
					"\n",
			);
		} catch {
			/* log vanished */
		}

		const ok = task.status === "done";
		if (!task.quiet) notify(`${task.id} ${outcomeLabel(task)} (${dur})`, ok ? "info" : "error");
		refreshStatusLine();
		resolveWaiters(task);
		queueWake(task);
	}

	// --- bg_run tool ----------------------------------------------------------

	pi.registerTool({
		name: "bg_run",
		label: "BgRun",
		description:
			"Run a shell command detached from the agent and return immediately. " +
			"Output goes to a log file under ~/.pi/bg-tasks/; the command keeps running even if Pi exits. " +
			"Runs via the bash tool's shell and settings (settings.shellPath + shellCommandPrefix) — write bash syntax. " +
			"Use it for long installs, builds, downloads, searches, or servers instead of the blocking bash tool. " +
			"You are woken automatically when the task ends (success, failure, cancel or timeout), so do NOT poll, " +
			"sleep, or bg_status-wait for it. If you would block on the result anyway, use bash instead. " +
			"Starting the same command+cwd twice returns the existing task id. " +
			"Stop a task with bg_kill.",
		parameters: BgRunParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			adoptCtx(ctx);
			const cwd = params.cwd || ctx.cwd;

			try {
				if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
			} catch {
				return textResult(`Working directory does not exist: ${cwd}`, { status: "error" });
			}

			const duplicate = findRunning(params.command, cwd);
			if (duplicate) {
				return textResult(
					`Already running as ${duplicate.id} (same command and cwd) — not starting a second copy.\n` +
						`${summarize(duplicate)}\nlog: ${duplicate.logPath}\n` +
						"You will be woken when it finishes; use bg_kill to stop it first if you really want a fresh run.",
					{ id: duplicate.id, logPath: duplicate.logPath, status: "duplicate" },
				);
			}

			const pick = resolveShell(params.shell);
			const invocation = buildInvocation(pick, applyCommandPrefix(pick, params.command));
			const id = newId();
			const logPath = join(LOG_DIR, `${id}.log`);
			const timeoutMs = params.timeoutMs && params.timeoutMs > 0 ? Math.min(params.timeoutMs, 604_800_000) : undefined;

			let logFd: number;
			try {
				logFd = openSync(logPath, "w");
				writeSync(logFd, `$ ${params.command}\n# cwd: ${cwd}\n# shell: ${pick.shell}\n\n`);
			} catch (err) {
				return textResult(`Could not create ${logPath}: ${(err as Error).message}`, { status: "error" });
			}

			let child: ReturnType<typeof spawn>;
			try {
				child = spawn(invocation.shell, invocation.args, {
					cwd,
					// Detached + fd stdio: the child outlives Pi and writes straight to
					// the file (no pipe for the parent to hold or for the child to die on).
					detached: true,
					windowsHide: true,
					stdio: [invocation.stdinCommand ? "pipe" : "ignore", logFd, logFd],
				});
			} catch (err) {
				closeSync(logFd);
				return textResult(`Failed to spawn ${invocation.shell}: ${(err as Error).message}`, { status: "error" });
			}
			// The child owns its copy of the descriptor now.
			try {
				closeSync(logFd);
			} catch {
				/* ignore */
			}

			const task: BgTask = {
				id,
				command: params.command,
				cwd,
				shell: pick.shell,
				pid: child.pid ?? -1,
				startedAt: Date.now(),
				status: "running",
				logPath,
				timeoutMs,
				quiet: true,
			};
			tasks.set(id, task);

			if (invocation.stdinCommand) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(invocation.stdinCommand);
			}

			child.on("error", (err) => finalize(task, null, null, `spawn error: ${err.message}`));
			child.on("close", (code, signal) => finalize(task, code, signal ?? null));

			if (timeoutMs) {
				task.timer = setTimeout(() => {
					task.timedOut = true;
					killTree(task);
				}, timeoutMs);
				task.timer.unref?.();
			}

			refreshStatusLine();

			// Nothing else to do: if it dies instantly (typo, missing binary), report
			// that in this same tool result instead of spending a whole extra turn.
			const early = await waitForExit(task, EARLY_EXIT_PROBE_MS);
			task.quiet = false;
			if (early === "exited" && task.finishedAt) {
				task.wakeSuppressed = true;
				const tail = tailLog(task, 40);
				return textResult(
					`${summarize(task)}\nlog: ${logPath}${logSizeNote(task)}\n` +
						(tail.text
							? `--- output ---\n${tail.truncated ? "…\n" : ""}${tail.text}\n--- end of output ---\n`
							: "") +
						(task.status === "done"
							? "It already finished successfully."
							: "It exited immediately — read the output above, fix the cause, and re-run with bg_run (or use bash for a quick foreground retry)."),
					{ id, logPath, pid: task.pid, status: task.status, exitCode: task.exitCode },
				);
			}

			return textResult(
				`${summarize(task)}\nlog: ${logPath}\npid: ${task.pid}\n\n` +
					"Running detached. You will be resumed automatically when it ends (success, failure, cancel or timeout). " +
					"Do not sleep and do not poll — go do other work, or end the turn. " +
					"Only if your next step cannot start without this output, call bg_status with a short waitMs once.",
				{ id, logPath, pid: task.pid, status: "running", timeoutMs },
			);
		},

		renderCall(args, theme) {
			const cmd = formatCommand(String(args.command ?? ""));
			return new Text(theme.fg("toolTitle", theme.bold("bg_run ")) + theme.fg("muted", cmd), 0, 0);
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
			"Report status of background tasks started with bg_run, and optionally tail a task's log. " +
			"Without an id, lists every task (id, status, exit code, duration, command). " +
			"With an id, returns its state, log path and the last N lines (tail, default 20, max 500). " +
			"Completions are delivered to you automatically, so checking is optional — never poll. " +
			"waitMs (max 30000) is a last-resort short block, not a way to babysit a task.",
		parameters: BgStatusParams,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const tailWanted = Math.min(Math.max(params.tail ?? 20, 0), MAX_TAIL_LINES);
			const waitMs = Math.min(Math.max(params.waitMs ?? 0, 0), WAIT_MAX_MS);

			if (params.id) {
				const t = tasks.get(params.id);
				if (!t) {
					const known = Array.from(tasks.values())
						.map((x) => x.id)
						.join(", ");
					return textResult(
						`No background task with id ${params.id}.` + (known ? ` Known ids: ${known}` : " No tasks have been started."),
						{ id: params.id, found: false },
					);
				}

				let waitNote = "";
				if (t.status === "running" && waitMs > 0) {
					const outcome = await waitForExit(t, waitMs, signal as AbortSignal | undefined);
					if (outcome === "aborted") waitNote = "(the wait was cancelled)\n";
					else if (outcome === "timeout")
						waitNote =
							`(still running after ${formatDuration(waitMs)} — waiting further is the wrong move: ` +
							"end the turn or do other work; the completion message will resume you)\n";
					else waitNote = "(finished while waiting)\n";
				}

				const tail = tailLog(t, tailWanted);
				const body =
					`${summarize(t)}\n` +
					`cwd: ${t.cwd}\nshell: ${t.shell}\npid: ${t.pid}\nlog: ${t.logPath}${logSizeNote(t)}\n` +
					(t.status === "running" ? waitNote || "(still running — you will be woken when it ends)\n" : waitNote) +
					(tail.text
						? `\n--- last ${Math.min(tailWanted, MAX_TAIL_LINES)} lines${tail.truncated ? " (earlier output omitted)" : ""} ---\n${tail.text}\n`
						: "");
				return textResult(body, {
					id: t.id,
					status: t.status,
					exitCode: t.exitCode,
					signal: t.signal,
					logPath: t.logPath,
					pid: t.pid,
					found: true,
				});
			}

			if (tasks.size === 0) return textResult("No background tasks.", { tasks: [] });

			let idleNote = "";
			if (waitMs > 0 && runningCount() > 0) {
				const idle = await waitUntilIdle(waitMs, signal as AbortSignal | undefined);
				idleNote = idle
					? "(all tasks finished while waiting)\n\n"
					: signal?.aborted
						? "(the wait was cancelled)\n\n"
						: `(still running after ${formatDuration(waitMs)} — do not keep waiting; the completion message will resume you)\n\n`;
			}

			const list = Array.from(tasks.values())
				.sort((a, b) => {
					const runningDelta = Number(b.status === "running") - Number(a.status === "running");
					return runningDelta !== 0 ? runningDelta : b.startedAt - a.startedAt;
				})
				.map(summarize)
				.join("\n");

			return textResult(
				`${idleNote}${list}\n\n` +
					`${LOG_DIR}${process.platform === "win32" ? "\\" : "/"}<id>.log — tails above are capped; ` +
					"bg_status { id } for one task, bg_kill { id } to stop it.",
				{
					tasks: Array.from(tasks.values()).map((t) => ({
						id: t.id,
						status: t.status,
						exitCode: t.exitCode,
						pid: t.pid,
						cwd: t.cwd,
						logPath: t.logPath,
						command: t.command,
					})),
				},
			);
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

	// --- bg_kill tool ---------------------------------------------------------

	pi.registerTool({
		name: "bg_kill",
		label: "BgKill",
		description:
			"Stop background task(s) started with bg_run, killing the whole process tree. " +
			"Pass an id, or omit it to stop every running task. Use it for dev servers, watchers, " +
			"and long jobs you no longer need. The task is marked cancelled and logged.",
		parameters: BgKillParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			adoptCtx(ctx);

			if (params.id) {
				const t = tasks.get(params.id);
				if (!t) return textResult(`No background task with id ${params.id}.`, { id: params.id, found: false });
				if (t.status !== "running") {
					return textResult(`${t.id} is not running (${outcomeLabel(t)}).`, {
						id: t.id,
						status: t.status,
						exitCode: t.exitCode,
					});
				}
				t.cancelled = true;
				t.wakeSuppressed = true; // the tool result already says what happened
				killTree(t);
				return textResult(
					`Sent kill to ${t.id} (pid ${t.pid}, whole process tree): ${formatCommand(t.command)}\n` +
						"Signal sent; the log keeps the last lines it wrote.",
					{ id: t.id, status: "cancelled", pid: t.pid },
				);
			}

			const running = Array.from(tasks.values()).filter((t) => t.status === "running");
			if (running.length === 0) return textResult("No running background tasks.", { killed: [] });
			for (const t of running) {
				t.cancelled = true;
				t.wakeSuppressed = true;
				killTree(t);
			}
			refreshStatusLine();
			return textResult(
				`Sent kill to ${running.length} task(s):\n${running.map(summarize).join("\n")}`,
				{ killed: running.map((t) => t.id) },
			);
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold(args.id ? `bg_kill ${args.id}` : "bg_kill (all)")),
				0,
				0,
			);
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
				.sort((a, b) => {
					const runningDelta = Number(b.status === "running") - Number(a.status === "running");
					return runningDelta !== 0 ? runningDelta : b.startedAt - a.startedAt;
				})
				.map((t) => `${outcomeLabel(t)}  ${t.id}  ${formatCommand(t.command, 70)}`);
			ctx.ui.notify(`Background tasks:\n${lines.join("\n")}`, "info");
		},
	});

	// Old logs are pure garbage after a while; nobody remembers to clean them.
	function pruneLogs() {
		let entries: string[];
		try {
			entries = readdirSync(LOG_DIR);
		} catch {
			return;
		}
		const cutoff = Date.now() - LOG_RETENTION_MS;
		for (const name of entries) {
			if (!name.endsWith(".log")) continue;
			const full = join(LOG_DIR, name);
			try {
				if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
			} catch {
				/* raced with another Pi */
			}
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		mkdirSync(LOG_DIR, { recursive: true });
		dead = false;
		settingsCache = undefined;
		adoptCtx(ctx);
		liveness += 1;
		if (liveness === 1) pruneLogs();
		refreshStatusLine();
	});

	// On shutdown, children keep running: they are detached and hold the log fd
	// themselves. Only stop touching this (now dead) session.
	pi.on("session_shutdown", async () => {
		dead = true;
		uiCtx = null;
		if (wakeTimer) {
			clearTimeout(wakeTimer);
			wakeTimer = null;
		}
		finishedQueue.length = 0;
	});
}

function textResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}