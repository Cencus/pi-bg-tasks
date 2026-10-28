---
name: bg-tasks
description: Run long-running shell commands in the background instead of blocking the agent. Use whenever a command is likely to take more than ~15 seconds — installs, builds, downloads, test suites, dev servers, long scripts, network fetches. Routes them through the bg_run tool so the session stays responsive and a notification fires on completion.
---

# Background tasks

The blocking `bash` tool freezes the whole agent until a command finishes. For
anything that is not quick, hand it off to `bg_run` instead and keep working.

## When to use bg_run

Use `bg_run` (not `bash`) when the command matches any of these:

- Package / dependency installs: `npm install`, `brew install`, `pip install`,
  `cargo build`, `go build`, etc.
- Builds and compilations of any non-trivial project.
- Downloads of large files or release assets (`curl`, `wget`, `git clone` of
  big repos).
- Test suites, linters, or formatters over a whole project.
- Long-running servers or watchers (`dev`, `serve`, `watch`, `--watch`).
- Anything you expect to take more than ~15 seconds.

Keep using `bash` for quick commands: `ls`, `rg`, `git status`, `cat`, reads,
single-file edits, `mkdir`, `which`, version checks, short scripts. Routing
those through `bg_run` just adds overhead.

## How to use it

1. Call `bg_run` with `command` (and optional `cwd`). It returns immediately
   with a task `id` and a `log` path under `~/.pi/bg-tasks/`.
2. The command keeps running detached. A notification fires when it exits.
3. To check progress, call `bg_status`:
   - No args → list every task and its status.
   - `id` → status of one task, plus the last lines of its log (`tail`,
     default 20).
4. Before reporting "done" to the user, confirm with `bg_status` that the task
   actually finished (status `done` / `failed`) and include the exit code and
   any relevant tail output.

## Notes

- The task table is in-memory and lives for the Pi process. Logs persist on
  disk, so you can read them even after a restart.
- If a background task fails, read the tail, diagnose, and either fix and
  re-run with `bg_run` or fall back to a foreground `bash` call for debugging.
- Don't start a second `bg_run` for the same job while the first is still
  running — check `bg_status` first.
- For a command the user explicitly wants to watch live, or that needs stdin,
  use `bash` (with a timeout) and tell the user it will block.
