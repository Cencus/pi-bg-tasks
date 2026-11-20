# pi-bg-tasks

A [Pi](https://pi.dev) package that lets the agent run long shell commands
**detached from the session** instead of freezing it.

Pi's built-in `bash` tool blocks until a command finishes — a `brew install`,
a big `npm install`, a 2 GB download, or a disk-wide search can lock the agent
for minutes. This package hands those jobs off to a detached process and
**calls the model back when they end**, so the agent keeps working and never
has to poll.

## What it adds

| Surface | What it does |
| --- | --- |
| `bg_run` | Start a shell command detached; returns `id`, log path, pid immediately. |
| `bg_status` | List tasks, or inspect one: state, exit code, pid, log path, tail of the log. |
| `bg_kill` | Stop a task **and its whole process tree** (dev servers included). |
| `/bg` | Show the task list in the TUI. |
| status line | `bg:N running` while tasks are active. |
| skill | Tells the model when to background a command and, more importantly, that it must never wait on one. |

## The contract: completion is a callback

A task ends in exactly one of `done`, `failed`, `cancelled`, `timeout`. Each one
injects a message into the session with `triggerTurn`, which wakes the model with
the exit code and the tail of the output. Tasks that finish within ~1.5 s of each
other are coalesced into a single message, so five parallel jobs cost one turn.

Consequences worth knowing:

- The agent never needs to `sleep`, poll, or sit on `bg_status`. If it would
  block on the result anyway, the right move is a foreground `bash` call — the
  skill says this explicitly.
- `bg_status { waitMs }` exists only as a last resort and is capped at 30 s.
- `bg_status` never reads the whole log: tails are read from the end of the file
  with a byte cap, so a 1 GB build log costs nothing.

## What it is *not* for

- Interactive commands or anything that needs stdin (`ssh`, prompts, pagers).
  `bg_run` gives the child no stdin — use `bash` for those.
- "Start it, then immediately wait for it." That is a foreground call with extra
  steps. Pass `timeoutMs` instead if the risk is a hang.

## Behaviour details

- **The task survives Pi.** Children are spawned detached with the log file as a
  real file descriptor, so quitting Pi (or `/reload`) does not kill a running
  install and does not break its log. `tests/detach-check.mjs` verifies this.
- **Same shell as `bash`.** `bg_run` resolves the shell through Pi itself
  (`settings.shellPath`, Git Bash on Windows, `/bin/bash` on Unix) and applies
  `settings.shellCommandPrefix`, so nvm/alias/CI setup works the same way.
- **Instant failures come back inline.** If the command dies within ~0.5 s (typo,
  missing binary), the output is in the `bg_run` result itself instead of costing
  an extra turn.
- **No duplicate runners.** Starting the same `command` + `cwd` while it is still
  running returns the existing task id.
- **Watchdog.** `bg_run { timeoutMs }` kills the tree if the task is still
  running after that long — the fix for commands that hang on a prompt.
- Tasks live in memory for the Pi process lifetime; logs persist in
  `~/.pi/bg-tasks/` and are pruned after 7 days.

## Install

From git:

```bash
pi install git:github.com/Cencus/pi-bg-tasks
```

Try without saving:

```bash
pi -e ./pi-bg-tasks
```

Restart Pi (or start a new session) and `bg_run` / `bg_status` / `bg_kill` plus
`/bg` are available.

## Development

```bash
npm install           # peer deps come from the Pi host
npm test              # pure-helper unit tests (node:test), no deps needed
node tests/link-host.mjs  # link a globally installed Pi instead of npm install
npm run smoke         # drives the extension against a fake Pi host
npm run detach-check  # asserts a task survives the host process exiting
```

`extensions/bg-lib.ts` holds the testable pieces (shell classification, argv
building, log tailing, formatting); `extensions/bg-tasks.ts` wires them to Pi.

## Publish

1. `npm publish` (needs the `pi-package` keyword, already set), or
2. push to a git repo and tag a version, then share the `pi install git:...`
   command.

The `@earendil-works/*` and `typebox` packages are provided by the Pi host, so
they are declared as `peerDependencies` and must not be bundled.