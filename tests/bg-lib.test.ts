import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	buildInvocation,
	classifyShell,
	encodePowerShell,
	formatBytes,
	formatCommand,
	formatDuration,
	tailLines,
	windowsKillArgs,
} from "../extensions/bg-lib.ts";

test("classifyShell ignores case, directories and .exe", () => {
	assert.equal(classifyShell("C:\\Program Files\\PowerShell\\7\\pwsh.exe"), "powershell");
	assert.equal(classifyShell("/usr/local/bin/pwsh"), "powershell");
	assert.equal(classifyShell("PowerShell.EXE"), "powershell");
	assert.equal(classifyShell("C:\\Windows\\System32\\cmd.exe"), "cmd");
	assert.equal(classifyShell("C:\\Program Files\\Git\\bin\\bash.exe"), "bash");
	assert.equal(classifyShell("/bin/sh"), "bash");
	assert.equal(classifyShell("zsh"), "bash");
});

test("buildInvocation: bash passes the command as argv", () => {
	const inv = buildInvocation({ shell: "/bin/bash", args: ["-c"], commandTransport: "argv" }, "ls -la");
	assert.deepEqual(inv.args, ["-c", "ls -la"]);
	assert.equal(inv.legacyString, false);
	assert.equal(inv.stdinCommand, undefined);
});

test("buildInvocation: stdin transport keeps the command off argv", () => {
	const inv = buildInvocation(
		{ shell: "C:\\Windows\\System32\\bash.exe", args: ["-s"], commandTransport: "stdin" },
		"echo hi",
	);
	assert.deepEqual(inv.args, ["-s"]);
	assert.equal(inv.stdinCommand, "echo hi");
});

test("buildInvocation: powershell uses -EncodedCommand round-trippable to the source", () => {
	const command = `Write-Output 'a "quoted" thing'\nGet-Item .`;
	const inv = buildInvocation({ shell: "pwsh", args: [], commandTransport: "argv" }, command);
	assert.deepEqual(inv.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
	const encoded = inv.args[3];
	assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), command);
});

test("buildInvocation: cmd needs the legacy string form", () => {
	const inv = buildInvocation({ shell: "cmd.exe", args: [], commandTransport: "argv" }, "dir");
	assert.equal(inv.legacyString, true);
	assert.deepEqual(inv.args, []);
});

test("encodePowerShell is base64 of UTF-16LE", () => {
	assert.equal(Buffer.from(encodePowerShell("echo hi"), "base64").toString("utf16le"), "echo hi");
});

test("formatCommand collapses newlines so lists stay one line per task", () => {
	assert.equal(formatCommand("echo a\necho b"), "echo a ⏎ echo b");
	assert.equal(formatCommand("  spaced   out  "), "spaced out");
	assert.equal(formatCommand("x".repeat(200), 10), `${"x".repeat(9)}…`);
	assert.equal(formatCommand("multi\r\nline"), "multi ⏎ line");
});

test("formatDuration switches units", () => {
	assert.equal(formatDuration(250), "250ms");
	assert.equal(formatDuration(1500), "1.5s");
	assert.equal(formatDuration(90_000), "1m30s");
	assert.equal(formatDuration(3 * 3600_000 + 5 * 60_000), "3h05m");
	assert.equal(formatDuration(-1), "—");
});

test("formatBytes switches units", () => {
	assert.equal(formatBytes(512), "512B");
	assert.equal(formatBytes(2048), "2KB");
	assert.equal(formatBytes(3 * 1024 * 1024), "3.0MB");
	assert.equal(formatBytes(2 * 1024 ** 3), "2.00GB");
});

test("tailLines returns the last N lines only", () => {
	const dir = mkdtempSync(join(tmpdir(), "bglib-"));
	try {
		const log = join(dir, "a.log");
		writeFileSync(log, "1\n2\n3\n4\n5\n");
		const tail = tailLines(log, 2);
		assert.equal(tail.text, "4\n5");
		assert.equal(tail.truncated, true);
		assert.equal(tailLines(log, 100).text, "1\n2\n3\n4\n5");
		assert.equal(tailLines(log, 0).text, "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("tailLines handles an empty file and a missing file", () => {
	const dir = mkdtempSync(join(tmpdir(), "bglib-"));
	try {
		const empty = join(dir, "empty.log");
		writeFileSync(empty, "");
		assert.deepEqual(tailLines(empty, 5), { text: "", truncated: false });
		assert.deepEqual(tailLines(join(dir, "nope.log"), 5), { text: "", truncated: false });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("tailLines stays cheap on a huge log with long lines", () => {
	const dir = mkdtempSync(join(tmpdir(), "bglib-"));
	try {
		const log = join(dir, "big.log");
		// ~8 MB of lines; asking for 3 must not read the whole thing.
		const line = `${"y".repeat(1000)}\n`;
		writeFileSync(log, line.repeat(8000) + "last-1\nlast-2\nlast-3\n");
		const startedAt = Date.now();
		const tail = tailLines(log, 3);
		const elapsed = Date.now() - startedAt;
		assert.equal(tail.text, "last-1\nlast-2\nlast-3");
		assert.equal(tail.truncated, true);
		assert.ok(elapsed < 1000, `tail took ${elapsed}ms`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("tailLines respects the byte cap on very long lines", () => {
	const dir = mkdtempSync(join(tmpdir(), "bglib-"));
	try {
		const log = join(dir, "huge-line.log");
		writeFileSync(log, `${"z".repeat(500_000)}\n`);
		const tail = tailLines(log, 5, 8 * 1024);
		assert.ok(tail.text.length <= 8 * 1024 + 10, `got ${tail.text.length} chars`);
		assert.equal(tail.truncated, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("windowsKillArgs walks the process tree", () => {
	assert.deepEqual(windowsKillArgs(42), ["/PID", "42", "/T", "/F"]);
});