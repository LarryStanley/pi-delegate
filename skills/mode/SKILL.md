---
description: Switch this project's pi dispatch mode (off / soft / strict)
disable-model-invocation: true
---

The user wants to set the pi-delegate mode to: $ARGUMENTS

If `$ARGUMENTS` is empty, just show the current mode and policy — do nothing else:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/pi-mode"
```

For `off` and `soft`, set it directly and report the result:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/pi-mode" <mode>
```

What the three modes do:
- `off` — no intervention at all. Suitable for a project pi should never touch.
- `soft` — nudges when existing product code is touched (default).
- `strict` — **blocks** edits to existing product code, requiring `pi_dispatch` instead.

The mode is recorded against the **project root** and applied by the project root of the
file being edited — not by wherever the session happens to be sitting. A strict project
therefore stays strict when edited from another project's session, or from one of its own
subdirectories. Report the path the command prints, so the user can see which project the
mode actually landed on.

## Setting `strict`: survey the project first

`strict` is the mode with teeth, so it needs to know what to protect. Without a policy it
falls back to a built-in heuristic that only fits one shape — a `src/` directory holding
`.ts/.tsx/.js/.jsx/.mjs/.svelte/.py`. On a Go, Rust, Elixir, or `<pkg>/`-layout Python
tree that heuristic protects **nothing**, and says nothing about it: strict looks switched
on and is not. So work out this project's real answer.

**1. Look at the project.** Read the manifest (`go.mod`, `Cargo.toml`, `pyproject.toml`,
`package.json`, `mix.exs`, …) and list the top-level directories. You are answering one
question: *which paths hold product source that should be written by pi rather than by
hand?*

Typical answers, as a starting point and not a lookup table — the repo in front of you
wins over any of them:

| Layout | Usually protect | Usually allow (exceptions) |
|---|---|---|
| Node / TS | `src/**` | `src/**/*.test.ts`, generated clients |
| Go | `internal/**`, `cmd/**`, `pkg/**` | `**/*_test.go`, `**/*.pb.go` |
| Rust | `src/**/*.rs` | `src/**/tests/**` |
| Python (`<pkg>/`) | `<pkg>/**/*.py` | `**/conftest.py`, `**/test_*.py` |
| Elixir | `lib/**` | `test/**` |

Things that are **not** product source and should stay writable: docs, config, migrations
you hand-write, fixtures, scripts, and anything generated (`*.pb.go`, `*_pb2.py`,
`src/generated/**`, snapshots). Getting these wrong is what makes someone switch strict off
entirely rather than live with it.

**2. Show the user what you propose, and why.** List the `protect` globs and the `allow`
globs, each with a one-line reason, and name anything you were unsure about. Patterns are
relative to the project root; `**` crosses directories, `*` stays inside one segment, and
a trailing `/` means "everything under here".

**3. Wait for their answer.** Do not write the policy until they approve it. They may edit
the lists — use what they say, not what you proposed. This confirmation step is the whole
reason this is safe: otherwise the model editing the files is also the model deciding
which files it may edit.

**4. Then write it:**

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/pi-mode" strict \
  --protect "internal/**,cmd/**/*.go" \
  --allow "**/*_test.go"
```

The command prints back the mode, the project root, and the stored policy. Show that
output — it is the user's confirmation that what landed is what they agreed to.

To go back to the built-in heuristic, `--clear-policy` removes the stored lists. The policy
survives a switch to `soft` and back, so nobody has to redo the survey to toggle the mode.

## What strict can and cannot do

Be straight with the user about the limits, at least the first time they enable it:

- Only `Write` and `Edit` are intercepted. The same edit made through `Bash` (`sed -i`, a
  heredoc, `python - <<EOF`) is never seen. This is a discipline rail against your own
  habit, not a security boundary.
- Brand-new files are always allowed, whatever the policy says — writing a file from
  scratch is the shape pi is best at.
- `/pi-delegate:probe` grants a one-time bypass for a deliberate hand-edit.
- The policy lives in `~/.claude/pi-delegate/modes.json`, outside any project, so it is not
  protected by the guard it configures.
