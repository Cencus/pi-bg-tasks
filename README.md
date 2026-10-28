# pi-bg-tasks

A [Pi](https://pi.dev) package that lets the agent run long shell commands **in
the background** instead of freezing the session.

Pi's built-in `bash` tool blocks until a command finishes — a `brew install`,
big `npm install`, or build can lock the agent for minutes. This package hands
those jobs off to a detached process so the session stays responsive, and fires
a desktop/terminal notification when the command exits.

## What it adds

- **`bg_run`** tool — start a shell command in the background, return
  immediately. Output is tee'd to a log file under `~/.pi/bg-tasks/`.
- **`bg_status`** tool — list tasks, or inspect one by id and tail its log.
- **`/bg`** slash command — see the task list in the TUI.
- A status line showing `bg:N running` while tasks are active.
- A bundled **skill** that tells the model when to reach for `bg_run` (installs,
  builds, downloads, test suites, dev servers — anything over ~15s) versus the
  blocking `bash` tool.

The task table is in-memory for the lifetime of the Pi process. Logs persist on
disk, so you can read them even after a restart.

## Install

From npm (once published):

```bash
pi install npm:pi-bg-tasks
```

From git:

```bash
pi install git:github.com/<owner>/pi-bg-tasks@v1
```

Local / try without saving:

```bash
pi -e ./pi-bg-tasks
```

Restart Pi (or start a new session) and the `bg_run` / `bg_status` tools and
`/bg` command are available.

## Publish

1. `npm publish` (needs the `pi-package` keyword, already set), or
2. push to a git repo and tag a version (`v1`), then share the
   `pi install git:...` command.

The `@earendil-works/*` and `typebox` packages are provided by the Pi host, so
they are declared as `peerDependencies` and must not be bundled.
