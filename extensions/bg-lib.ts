/**
 * Pure helpers for the background-tasks extension.
 *
 * Kept free of Pi imports so they can be unit-tested with plain `node --test`
 * (`node --test tests/`), which is the part of this package most likely to
 * regress (shell resolution, log tailing, command formatting).
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

export type ShellKind = "bash" | "powershell" | "cmd";

/** Shell config as resolved by pi (`getShellConfig`) or by an explicit override. */
export interface ShellPick {
	shell: string;
	/** Base args, e.g. `["-c"]`, `["-s"]`. Ignored for PowerShell/cmd. */
	args: string[];
	/** `"stdin"` means the command must be written to the child's stdin (WSL-era bash). */
	commandTransport: "argv" | "stdin";
}

export interface Invocation {
	shell: string;
	args: string[];
	/** cmd.exe needs the whole command as one literal string, not argv. */
	legacyString: boolean;
	/** When set, write this to the child's stdin instead of passing it as argv. */
	stdinCommand?: string;
}

const MAX_COMMAND_DISPLAY = 110;

/** Classify a shell executable by its file name (`C:\...\pwsh.exe` → `"powershell"`). */
export function classifyShell(shell: string): ShellKind {
	const base = shell.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
	const name = base.endsWith(".exe") ? base.slice(0, -4) : base;
	if (name === "pwsh" || name === "powershell") return "powershell";
	if (name === "cmd") return "cmd";
	return "bash";
}

/**
 * PowerShell shipping a command through `-Command` mangles quotes and newlines,
 * because Node quotes argv for CommandLineToArgvW and PowerShell then re-parses
 * the string with its own rules. `-EncodedCommand` takes base64(UTF-16LE) and
 * has no quoting rules at all.
 */
export function encodePowerShell(command: string): string {
	return Buffer.from(command, "utf16le").toString("base64");
}

/** Turn a resolved shell pick plus a command into concrete spawn arguments. */
export function buildInvocation(pick: ShellPick, command: string): Invocation {
	switch (classifyShell(pick.shell)) {
		case "powershell":
			return {
				shell: pick.shell,
				args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)],
				legacyString: false,
			};
		case "cmd":
			return { shell: pick.shell, args: [], legacyString: true };
		default:
			if (pick.commandTransport === "stdin") {
				return { shell: pick.shell, args: [...pick.args], legacyString: false, stdinCommand: command };
			}
			return { shell: pick.shell, args: [...pick.args, command], legacyString: false };
	}
}

/**
 * Collapse a (possibly multi-line) command into one display line. Without this
 * a heredoc-style command breaks every list rendering that interpolates it.
 */
export function formatCommand(command: string, max = MAX_COMMAND_DISPLAY): string {
	const oneLine = command.replace(/\s*\r?\n\s*/g, " ⏎ ").replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const totalSeconds = Math.round(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

export interface TailResult {
	text: string;
	/** True when earlier output was skipped, either by the line count or the byte cap. */
	truncated: boolean;
}

/**
 * Read the last `lines` lines of a log **from the end of the file**.
 *
 * The previous implementation did `readFileSync` on the whole log, which turns
 * a 1 GB build log into a 1 GB string on every `bg_status` and every completion
 * wake. Here we read backwards in chunks and stop as soon as we have enough
 * lines, and never read more than `maxBytes`.
 */
export function tailLines(logPath: string, lines: number, maxBytes = 256 * 1024): TailResult {
	if (lines <= 0) return { text: "", truncated: false };
	let fd: number | undefined;
	try {
		fd = openSync(logPath, "r");
		let size: number;
		try {
			size = statSync(logPath).size;
		} catch {
			return { text: "", truncated: false };
		}
		if (size === 0) return { text: "", truncated: false };

		const chunk = 32 * 1024;
		let position = size;
		let readBytes = 0;
		let text = "";
		while (position > 0 && readBytes < maxBytes) {
			const len = Math.max(1, Math.min(chunk, position, maxBytes - readBytes));
			const buf = Buffer.allocUnsafe(len);
			const read = readSync(fd, buf, 0, len, position - len);
			if (read <= 0) break;
			text = buf.subarray(0, read).toString("utf8") + text;
			position -= read;
			readBytes += read;
			if (countNewlines(text) > lines) break;
		}

		const all = text.split("\n");
		if (all.length > 0 && all[all.length - 1] === "") all.pop();
		const truncated = position > 0 || all.length > lines;
		return { text: all.slice(-lines).join("\n"), truncated };
	} catch {
		return { text: "", truncated: false };
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* already closed */
			}
		}
	}
}

function countNewlines(text: string): number {
	let n = 0;
	for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
	return n;
}

/** Windows cannot kill a process group with signals; `taskkill /T` walks the tree. */
export function windowsKillArgs(pid: number): string[] {
	return ["/PID", String(pid), "/T", "/F"];
}