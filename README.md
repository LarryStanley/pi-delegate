# pi-delegate

Delegate implementation and tests to a local
[`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) agent, with hooks that
enforce dispatch discipline.

Claude acts as tech lead: it produces the probe, the task book, the acceptance script, and the
verdict. **pi writes the source code.**

## Install

```bash
claude --plugin-dir /path/to/pi-delegate
```

Requires Node ≥ 22 and a `pi` installation that is already set up.

## Configuration: nothing is required by default

`pi_dispatch` **specifies no provider or model**, so pi uses your own default
(`defaultProvider` / `defaultModel` in `~/.pi/agent/settings.json`). In other words:
whatever model you already point pi at, dispatches go there too — anthropic, openai, litellm,
ollama, LM Studio, or a local OpenAI-compatible server (e.g. omlx) all work the same way, with
nothing to configure for this plugin specifically.

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

`/pi-delegate:doctor` tells you which model a dispatch will actually reach, and raises a
problem only under conditions that genuinely hold.

### The defaults below were measured, not guessed

| Parameter | Default | Why |
|---|---|---|
| `thinking` | `off` | Small local models spend their whole thinking budget and never emit a single tool call. Strong hosted models do benefit from thinking on hard problems, so it's overridable. |
| `tools` | `read,write,edit` | Granting `bash` made the model roam endlessly with `ls` / `cat` instead of writing anything. |
| `no_context_files` | `true` | Measured: without it, 43 reads / 0 writes / timed out; with it, finished in 93 seconds. |

To override, specify it directly in the `pi_dispatch` call (`thinking`, `tools`,
`no_context_files`, `append_system_prompt`, `provider`, `model`, `timeout_s`).

`--mode rpc`, `--session-id`, `--no-skills`, and `--no-extensions` are structural and not
overridable; `--no-session` is **deliberately never passed** (omitting it is what makes the
session land on disk, which is what gives `pi_transcript` something to read).

## Modes

| Mode | Behavior |
|---|---|
| `off` | No intervention at all |
| `soft` | Nudges when existing product code is touched (default) |
| `strict` | Blocks edits to existing product code |

Switch modes with `/pi-delegate:mode <mode>`; state lives in `~/.claude/pi-delegate/modes.json`,
remembered per project. "Existing product code" means a source file that already exists under
the project root's `src/`; `tasks/`, `scripts/`, `docs/`, markdown, config files, and brand-new
files are all allowed through.

`strict` is a discipline guardrail, not enforcement: the hook is only wired to `Write|Edit`, so
editing the same file with `Bash` (`sed -i`, a heredoc, `python - <<EOF`, …) is never intercepted.
There's always a way around it — it blocks editing the file yourself out of habit, not a
deliberate workaround.

To make one hand-edit (a probe), run `/pi-delegate:probe` first for a one-time bypass.

## MCP tools

| Tool | Purpose |
|---|---|
| `pi_dispatch` | Dispatch a task book. `mode=sync` waits for the result, `mode=async` runs it in the background |
| `pi_status` | Check progress |
| `pi_steer` | Interject mid-run when it's heading the wrong way |
| `pi_abort` | Abort. **Re-dispatch an aborted task unchanged; only rewrite the task book after a real failure** |
| `pi_result` | Collect the verdict of an async dispatch |
| `pi_transcript` | Drill in only when the verdict isn't enough |
| `pi_stats` | Check token usage |

## Known gaps

`pi_stats` only returns the `tokens` and `duration_s` already present in the verdict. spec
§5's `get_session_stats` passthrough (including `cost` / `context` usage) is not yet
implemented.

## Documentation

| File | Contents |
|---|---|
| `docs/publish-prep-report.md` | Changes and verification notes from the pre-release pass |
| `docs/superpowers/specs/2026-08-22-pi-delegate-plugin-design.md` | Design spec (historical) |
| `docs/superpowers/plans/2026-08-22-pi-delegate-plugin.md` | Implementation plan (historical) |
| `skills/delegating-to-pi/` | The dispatch discipline itself: the four-way split, task books, acceptance, model choice |

## Development

```bash
npm test                    # node --test, no external dependencies
claude plugin validate .
```

`fixtures/fake-pi.mjs` stands in for `pi --mode rpc`. It deliberately lives **outside**
`test/` — `node --test` treats any file under `**/test/**/*.{cjs,mjs,js}` as a test file, and
putting it in `test/` would add one permanently-passing phantom test.
