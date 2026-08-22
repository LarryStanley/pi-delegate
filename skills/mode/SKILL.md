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
