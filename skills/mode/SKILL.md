---
description: Switch this project's pi dispatch mode (off / soft / strict)
disable-model-invocation: true
---

The user wants to set the pi-delegate mode to: $ARGUMENTS

Run the following command (replace `<mode>` with `$ARGUMENTS`; only `off`, `soft`, or `strict` are accepted):

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/pi-mode" <mode>
```

If `$ARGUMENTS` is empty, just show the current mode instead:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/pi-mode"
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
