---
name: bg-tasks
description: Run long-running shell commands in the background instead of blocking the agent. Use whenever a command is likely to take more than ~15 seconds — installs, builds, downloads, disk/search scans, test suites, dev servers. Routes them through the bg_run tool, which wakes you automatically when the task ends, so the session never blocks. Never poll, never sleep, never sit on bg_status waiting.
---

# Background tasks

The blocking `bash` tool freezes the whole agent until a command finishes. For
anything that is not quick, hand it to `bg_run` and keep working. **The task
calls you back when it ends — success, failure, cancel, or timeout.** That is
the whole contract: there is no reason to wait for it, and waiting defeats the
purpose of handing it off.

## The rule

1. `bg_run` → you get an `id` immediately.
2. Do other work, or end the turn.
3. A completion message arrives on its own and resumes you with the exit code
   and the tail of the output.

If you find yourself reaching for `sleep`, a poll loop, or
`bg_status { waitMs }`, ask whether the command was actually backgroundable. If
the very next step cannot start without its output, **do not `bg_run` it — run it
with `bash`** (foreground, with `timeout`). "Start it in the background, then
block on it" is strictly worse than a plain foreground call: you pay a process
detour and learn nothing sooner.

## When to use bg_run

- Package / dependency installs: `npm install`, `brew install`, `pip install`,
  `cargo build`, `go build`.
- Builds and compilations of any non-trivial project.
- Downloads of large files or release assets (`curl`, `wget`, `git clone`).
- Whole-project test suites, linters, formatters, and long searches
  (`rg` over a huge tree, `find /`, disk scans).
- Long-running servers and watchers (`dev`, `serve`, `watch`, `--watch`).
- Anything you expect to take more than ~15 seconds.

Keep using `bash` for quick things: `ls`, `rg` on a small tree, `git status`,
reads, single-file edits, `mkdir`, `which`, version checks, short scripts.
And use `bash` for anything interactive or that needs stdin (`ssh`, a prompt,
a pager) — `bg_run` gives the child no stdin.

## How to use it

1. `bg_run { command }` (optional `cwd`, `shell`, `timeoutMs`). It returns the
   `id`, `log` path, `pid`, and immediately hands control back.
   - The command runs through the same shell and settings as the `bash` tool
     (`settings.shellPath` + `shellCommandPrefix`), so **write bash syntax** —
     `&&`, `$VAR`, `seq`. Pass `shell: "pwsh"` only if you really need
     PowerShell.
   - If the command dies within ~0.5s (typo, missing binary), the failure is
     returned **in the same tool result** with its output — fix it and re-run,
     no extra turn.
   - Starting the same `command` + `cwd` while it is still running returns the
     **existing** task instead of starting a second copy.
   - `timeoutMs` adds a watchdog: a command that would otherwise hang (waiting
     on a prompt, a stalled network read) is killed and reported. Use it for
     downloads and anything that can wedge.
2. The task runs **detached from Pi**: quitting Pi does not kill it, and it
   keeps appending to its log.
3. On exit you get one `bg-task-done` message (tasks finishing together are
   coalesced into one message) containing status, exit code, duration, and the
   last lines. That message resumes you even if you ended the turn.
4. `bg_status { id, tail }` reads the current state and the end of the log.
   Use it when *you* have a reason to look — never on a timer.
5. `bg_kill { id }` stops one task, `bg_kill {}` stops all running tasks. It
   kills the whole process tree, so dev servers and their children actually
   die. Kill tasks you no longer need: a forgotten watcher holds ports and CPU.

## Never fake waiting

- **No `bash sleep`** after `bg_run` to "give it time" — that re-blocks the
  session and is worse than a foreground call.
- **No poll loops.** One `bg_status` look, then go do something useful or end
  the turn. The completion message is the notification; you do not need to
  check.
- `bg_status { waitMs }` exists only for the residual case "my next step needs
  this output and there is genuinely nothing else to do". It is capped at 30s
  on purpose. One call, never in a loop, and never as a substitute for simply
  ending the turn.
- When you have nothing else to do, say so and end the turn. Completion injects
  a message that resumes you — that is cheaper than any wait.

## Notes

- The task table is in-memory and lives for the Pi process; logs persist on
  disk (`~/.pi/bg-tasks/<id>.log`) and are pruned after 7 days. To recover a
  task from a previous session, read its log with `bash`.
- Tails are capped (last lines, bounded bytes), so a chatty log will not blow
  up the context. Read the log file directly if you need more.
- If a task fails, read the tail, diagnose, then either fix and re-run with
  `bg_run` or drop to a foreground `bash` call to debug.
- Use one `bg_run` per job. Long output from several parallel jobs is
  meaningless when interleaved; sequential is usually faster to debug.
- For a command the user wants to watch live, use `bash` and tell them it will
  block.