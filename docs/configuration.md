# Configuration

Everything you can change about a dispatch, and the edges of what the mode hook covers, for
someone who has pi-delegate running and has hit something they want to adjust.

## Pinning a provider and a model

If you want to pin a different model long-term (for example, a cheap local model dedicated to
dispatches while interactive pi uses something else), write
`~/.claude/pi-delegate/config.json`:

```json
{
  "provider": "ollama",
  "model": "qwen3:8b",
  "timeout_s": 1500,
  "thinking": "off",
  "tools": "read,write,edit",
  "no_context_files": true,
  "drafter_patterns": ["-draft", "_assistant", "-assistant"]
}
```

Every field is optional. Resolution order is **`pi_dispatch` call arguments → this file → pi's
own defaults**.

## Overriding one dispatch

To override one of the measured defaults for a single dispatch, specify it directly in the
`pi_dispatch` call (`thinking`, `tools`, `no_context_files`, `append_system_prompt`, `provider`,
`model`, `timeout_s`).

`--mode rpc`, `--session-id`, `--no-skills`, and `--no-extensions` are structural and not
overridable; `--no-session` is **deliberately never passed** (omitting it is what makes the
session land on disk, which is what gives `pi_transcript` something to read).

## Modes, and what counts as existing product code

Switch modes with `/pi-delegate:mode <mode>`; state lives in `~/.claude/pi-delegate/modes.json`,
remembered per project. "Existing product code" means a source file that already exists under
the project root's `src/`; `tasks/`, `scripts/`, `docs/`, markdown, config files, and brand-new
files are all allowed through.

`strict` is a discipline guardrail, not enforcement: the hook is only wired to `Write|Edit`, so
editing the same file with `Bash` (`sed -i`, a heredoc, `python - <<EOF`, …) is never intercepted.
There's always a way around it — it blocks editing the file yourself out of habit, not a
deliberate workaround.

To make one hand-edit (a probe), run `/pi-delegate:probe` first for a one-time bypass.
