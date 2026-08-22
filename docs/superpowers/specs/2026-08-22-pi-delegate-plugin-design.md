# pi-delegate: turning "dispatching to pi" from a skill into a Claude Code Plugin

> **Editor's note (2026-08-22).** This spec/plan documents the design as of v0.1.0. The parts that
> hardcode the provider to a single local omlx server, and treat two specific Qwen model ids as
> required models, **no longer reflect current behavior**. For current behavior (three-tier
> provider/model resolution, the advisory `pi-doctor`), see `docs/publish-prep-report.md` and
> `README.md`. The original text is kept as-is to preserve the reasoning behind the original
> decisions.

> Design date: 2026-08-22
> Status: pending implementation
> Predecessor: the `delegating-to-pi` skill (148-line SKILL.md + ~1400 lines of references + 5 bash/ps1 scripts)

## 1. Problem statement

The existing `delegating-to-pi` skill "doesn't work well" in Claude Code, for two separate reasons that have to be handled separately.

### 1.1 Mechanism layer: five bugs from the Windows port

These were confirmed by hands-on testing (2026-08-22, macOS / M3 Ultra), not speculation:

| # | Bug | Evidence | Impact |
|---|---|---|---|
| 1 | Wrong provider name | The script writes `--provider omls`, but `~/.pi/agent/models.json` calls it `omlx` | `Error: Unknown provider "omls"` — dispatch fails every time |
| 2 | `timeout` doesn't exist on macOS | `dispatch-pi.sh` uses `timeout 1500`; this machine has neither `timeout` nor `gtimeout` | The script dies on its first line |
| 3 | Default model not registered | The `omlx` provider only has `Qwen3.6-35B-A3B-4bit` and `Qwen3.6-27B-DFlash-draft` | `Warning: not found, using custom model id` |
| 4 | **`--thinking off` is a silent no-op** | Follows from #3: unregistered model → missing `reasoning: true` and `compat.chatTemplateKwargs.enable_thinking` | This is exactly the symptom the skill description reports about itself: "keeps reasoning forever even though thinking was turned off" |
| 5 | The registered list includes a co-pilot model | `Qwen3.6-27B-DFlash-draft` is a DFlash drafter; calling it directly returns 500 | Pick it by mistake and it fails |

**Why bug #4 matters**: this skill documents its own bug, but attributes the cause to the model. Any approach that just carries the scripts over will carry this bug over with it.

> Current-state note: as of 2026-08-22 the omlx server side has `thinking_budget_tokens: 4096` set,
> which is currently the **only** mechanism stopping `Qwen3.8-27B-oQ4e-mtp` from thinking forever. Do not
> remove it before the client-side `--thinking off` is actually fixed.

### 1.2 Interface layer: a skill is a discipline document, not a mechanism

SKILL.md is prose rules for Claude to read; the only mechanism is 5 bash scripts. Claude has to read the rules itself, assemble the command itself, and interpret `events.json` itself.

And prose discipline has a ceiling — the skill's own recorded test result: **the rules say "only three things are left to you," yet in the same run about 80% of the characters were still typed by the primary model**, each time with "a reason that sounded valid in the moment."

Plugin + Hooks is what can fix this layer.

## 2. Goals and non-goals

### Goals

1. Claude can dispatch to pi via **structured tool calls**, without assembling CLI commands itself
2. Support both **sync** (dispatch one, wait for the result) and **async** (fan-out, notify on completion)
3. Support **mid-run intervention**: steer / abort
4. Compress the default information entering Claude's context to about 15 lines; deeper information is **paid for on demand**
5. Discipline can be **enforced**, and toggled per project
6. **Portable across machines** — Windows → macOS has already proven it breaks

### Non-goals

- Not published to the plugin marketplace (personal, cross-machine use)
- Does not replace the contents of references/ (kept as-is, preserving progressive loading)
- Does not support omp (the other harness the original skill mentions) — pi only

## 3. Key decisions and rationale

| Decision | Choice | Rationale |
|---|---|---|
| Call shape | Both sync and async | Explicitly requested by the user |
| Discipline strength | Three switchable modes: `off` / `soft` / `strict` | Some projects shouldn't let pi touch code at all |
| Mode scope | **Project-level**, remembered after being set once | Same as above; session-level isn't enough |
| Context tiering | Tier 0 always returned, tiers 1/2 on demand | pi sessions are already persisted to disk, so drill-down is free |
| Whether tier 0 includes the assistant message | **Yes, truncated to 1000 characters** | pi often explains at the end what it changed or where the task book was ambiguous — this saves a round trip |
| Architecture | MCP server spawns a `pi --mode rpc` child process | See below |

### Why an MCP server + child process (rather than an in-process SDK, or plain `bin/`)

- **steer / abort require holding stdio open continuously**. A Bash tool call is a fresh process every time, which can't do this → a plain `bin/` approach can't deliver "control"
- **Process isolation**: when fanning out 8 dispatches, one crashing shouldn't take the other 7 down with it. An in-process SDK would
- **Reproducible by hand**: every one of the five bugs in §1.1 of this document was pinned down by typing commands by hand, one at a time. With an SDK approach, when something goes wrong all you can do is read the server log

## 4. Plugin structure

```
pi-delegate/
├── .claude-plugin/
│   └── plugin.json
├── .mcp.json                        MCP server registration
├── mcp/
│   ├── server.js                    tool definitions and dispatch
│   ├── dispatch.js                  spawns pi --mode rpc, holds stdio, timeout timer
│   ├── verdict.js                   verdict computation (§7)
│   ├── registry.js                  session registry: id → {pid, status, cwd, task_file}
│   └── jsonl.js                     strict LF splitting (see §6 warning)
├── hooks/
│   ├── hooks.json
│   ├── doctor-check.sh
│   ├── mode-guard.sh
│   └── soft-nudge.sh
├── skills/
│   ├── delegating-to-pi/
│   │   ├── SKILL.md                 slimmed-down version (§10)
│   │   └── references/              existing six files carried over as-is
│   ├── mode/SKILL.md                /pi:mode
│   ├── probe/SKILL.md               /pi:probe
│   └── doctor/SKILL.md              /pi:doctor
├── bin/
│   └── pi-doctor                    environment self-check and repair (§8)
├── monitors/
│   └── monitors.json                async completion notifications
└── README.md
```

> ⚠️ `commands/`, `agents/`, `skills/`, `hooks/` all go in the plugin's **root directory**,
> never inside `.claude-plugin/`. The latter holds only `plugin.json`.

### plugin.json

```json
{
  "name": "pi-delegate",
  "description": "Dispatch implementation and tests to a local pi (Qwen3.8 on omlx), and enforce dispatch discipline",
  "version": "0.1.0",
  "author": { "name": "stanley" }
}
```

## 5. MCP tool interface

| Tool | Parameters | Returns | Tier |
|---|---|---|---|
| `pi_dispatch` | `task_file`, `cwd`, `model?`, `mode=sync\|async`, `timeout_s?` | sync → verdict; async → `{session_id}` | 0 |
| `pi_status` | `session_id` | `{status, elapsed_s, current_tool, files_touched}` | 0 |
| `pi_steer` | `session_id`, `message` | `{ok}` | — |
| `pi_abort` | `session_id` | `{ok}` | — |
| `pi_result` | `session_id` | verdict (retrieved after async completion) | 0 |
| `pi_transcript` | `session_id`, `filter=text\|tools\|last_n`, `n?` | filtered conversation excerpt | 1 |
| `pi_stats` | `session_id` | `get_session_stats` verbatim (tokens / cost / context) | 2 |

**Defaults**: `model` defaults to `Qwen3.8-27B-oQ4e-mtp` (dense). `timeout_s` defaults to `1500`.

**Model selection rule** (carried over from the original skill's tested conclusion, written into the tool description):
always use dense for editing existing files; only switch to MoE (`Qwen3.6-35B-A3B-4bit`) for speed when writing a brand-new file from scratch.

## 6. Process model

The MCP server is long-running. Each `pi_dispatch` spawns one child process:

```
pi --mode rpc \
   --provider omlx --model <model> --thinking off \
   --tools read,write,edit \
   --session-id <id> \
   --no-context-files --no-skills --no-extensions
```

The child process's working directory is set via `spawn(..., { cwd })`.

> ⚠️ **pi has no `--cwd` flag** (verified against `pi --help` on 2026-08-22).
> The `--cwd` in the original skill's `references/orchestration.md` is a flag belonging to **omp**,
> not pi. Copying it verbatim fails argparse outright.

> The rationale for the flags carries over from the original `dispatch-pi.sh` header, **not re-derived here**:
> don't grant `bash` (granting it makes it wander instead of doing the work); `--no-context-files` is necessary, not an optimization
> (measured: without it = 43 reads / 0 writes / timeout; with it = done in 93 seconds).

> ⚠️ **Deliberately omits `--no-session`** (unlike the original `dispatch-pi.sh`).
> The original script used it to keep the harness as lightweight as possible, but session storage is disk I/O —
> it **never enters the model's context**, so it saves no tokens.
> Meanwhile the tier-1/2 drill-down in §5 (`pi_transcript` / `pi_stats`) depends on the session landing in `~/.pi/agent/sessions/` to be readable at all —
> passing `--no-session` would leave `pi_transcript` / `pi_stats` with nothing to read once the child process ends.
> Use `--session-id <id>` instead, so the session is addressable.

- **Timeout is managed by a timer on the server, not by calling `timeout`** → structurally eliminates bug #2; Windows / macOS behave identically
- `mode=sync`: blocks until `agent_settled`, returns the verdict
- `mode=async`: returns `session_id` immediately; appends one line to `~/.claude/pi-delegate/events.log` on completion
- `monitors.json` runs `tail -F` on that log; each line of stdout becomes a notification to Claude

```json
[
  {
    "name": "pi-dispatch-complete",
    "command": "tail -F ${HOME}/.claude/pi-delegate/events.log",
    "description": "Notification that a pi dispatch has completed"
  }
]
```

### ⚠️ JSONL parsing

pi's RPC protocol is **strictly LF-delimited**. The docs explicitly state **do not use Node's `readline`** — it will also break lines at Unicode separator characters inside a JSON payload, causing silent data corruption.

`mcp/jsonl.js` must split only on `\n`, and strip an optional trailing `\r`.

### Relevant events

| Event | Purpose |
|---|---|
| `agent_settled` | The whole session has finalized, no auto-continuation → the authoritative signal for the verdict |
| `tool_execution_start` | `toolCallId` / `toolName` / `args` → used for counting and wander detection |
| `tool_execution_end` | `isError` |
| `message_end` | Used to get the last assistant message |

## 7. Verdict computation (tier 0)

The original skill wrote three interpretation traps as prose for Claude to handle. **Written as prose, it can go wrong every single time; written as code, it can only go wrong once.**

| Trap | Code-based approach |
|---|---|
| A single tool call fires 3–4 events → miscounting | Deduplicate by `tool_execution_start.toolCallId` before counting |
| "Aborted" and "failed" require opposite handling | A three-step enum, order must not be reversed: has `agent_settled` arrived → grep for the target string → `git status` |
| "Timeout" ≠ "did nothing" | Automatically attach `git diff --stat` |
| Wander detection | files `read` minus files named in the task book |

### Return format (fixed at roughly 15 lines)

```
status:                 completed | timeout | aborted | failed
write_count:            3
files_written:          src/foo.ts, src/foo.test.ts
files_read_unrequested: src/unrelated.ts
git_diff_stat:          2 files changed, 47 insertions(+), 3 deletions(-)
duration_s:             93
tokens:                 in 4210 / out 890
session_id:             a1b2c3
last_message:           <the last assistant message, truncated to 1000 characters>
```

When `last_message` exceeds 1000 characters it is truncated and marked; the full content is left for `pi_transcript`.

## 8. Portability: `bin/pi-doctor`

Idempotent checks and fixes — this is the insurance policy for moving across machines.

| Check | Fix action | Corresponding bug |
|---|---|---|
| `~/.pi/agent/models.json` has an `omlx` provider | Create it, `baseUrl: http://127.0.0.1:8000/v1` | #1 |
| Target model is registered | Add it to the models array | #3 |
| Model has `reasoning: true` | Add it | #4 |
| Model has `compat.chatTemplateKwargs.enable_thinking: {"$var": "thinking.enabled"}` | Add it | #4 |
| Drafter-type models are flagged non-dispatchable | Flag with `x-pi-delegate-forbidden: true`; `pi_dispatch` refuses | #5 |
| omlx server is alive | Report only, do not auto-start | — |

- `pi-doctor --check`: read-only, returns a structured report
- `pi-doctor --fix`: actually writes, backing up `models.json` first

The `SessionStart` hook only runs `--check`.

## 9. Hooks and modes

### State

`~/.claude/pi-delegate/modes.json`, keyed by the project's absolute path:

```json
{ "/path/to/project-a": "strict", "/path/to/project-b": "off" }
```

Projects not listed default to `soft`. Kept in the home directory rather than the repo: doesn't pollute the project, doesn't need a gitignore entry. The cost is having to reset it once per machine switch (accepted).

### hooks.json

| Hook | Event | matcher | Behavior |
|---|---|---|---|
| `doctor-check` | `SessionStart` | — | Runs `pi-doctor --check`, injects "current mode + configuration issues" via `additionalContext` |
| `mode-guard` | `PreToolUse` | `Write\|Edit` | **strict**: hits a protected path → `permissionDecision: "deny"` |
| `soft-nudge` | `PostToolUse` | `Write\|Edit` | **soft**: injects a reminder via `additionalContext` |

In `off` mode both hooks just `exit 0` and do nothing.

### strict's protection scope (a conservative whitelist)

**Blocked**: existing production code and test files — `.ts` / `.tsx` / `.js` / `.svelte` / `.py` under `src/**`, including `*.test.*` / `*.spec.*`.

**Allowed** (never blocked):
- Brand-new files (path doesn't exist)
- `tasks/**`, `scripts/**`, `docs/**`
- All `.md` files
- Config files (`*.json` / `*.toml` / `*.yaml` / `*.yml` / dotfiles)

The `permissionDecisionReason` for a deny must give a concrete alternative action directly, for example:
"This is production code. Write a task book to `tasks/` and dispatch it with `pi_dispatch`. To edit it by hand, run `/pi:probe` first."

### Probe exception

`/pi:probe` sets a one-shot allow flag, which turns itself off automatically after the next Write/Edit passes through. This is easier to audit than an automatic "10-line cap" counter.

## 10. Slimming down the skill

Under `strict` mode, discipline is enforced by the hook, so the prose no longer needs to carry enforcement weight. SKILL.md shrinks from 148 lines down to:

- A four-way routing table (**the one decision that absolutely has to be made correctly**)
- The criterion "if a lookup table can decide it, don't dispatch — write a script instead" — a hook can't enforce this, so it has to stay in prose
- An explanation pointing to the MCP tools
- The existing "read further" references index

**Removed**: the red-flag checklist, "run through this table before touching it yourself" — those are now enforced by `mode-guard`.
**Kept**: all six references files, unchanged.

## 11. Error handling

| Situation | Behavior |
|---|---|
| MCP server fails to start | Visible on the `/plugin` Errors tab; tool calls return an explicit error, never fail silently |
| pi child process fails to spawn | `status: failed`, with stderr attached |
| Timeout | `status: timeout`, **still attaches `git diff --stat`** (timeout ≠ nothing was done) |
| `pi-doctor --check` finds a problem | SessionStart injects a warning, but **does not block** the session |
| Dispatch target is a drafter model | `pi_dispatch` refuses outright, request never sent |
| `session_id` doesn't exist | Explicit error, listing the currently valid sessions |

## 12. Verification approach

```bash
claude plugin validate ./pi-delegate
claude --plugin-dir ./pi-delegate
```

Item-by-item checks:

1. **MCP tools** — dispatch a minimal task book with `pi_dispatch`, confirm the return is a 15-line verdict, not raw JSON
2. **Hooks** — trigger one Write under each of the three modes, compare matched hooks and exit codes in the debug log
3. **strict false-blocks** — write once to each category of whitelisted path, confirm all are allowed
4. **Verdict correctness** — deliberately induce the timeout / abort / failed conditions, confirm the enum classifies them correctly
5. **Wander detection** — a task book that names only file A; observe whether pi reading file B gets listed in `files_read_unrequested`
6. **`--thinking off` actually works** — after `pi-doctor --fix`, compare against the length of `reasoning_content` in the omlx server log

Item 4 must **plant a real violation and check it actually turns red**, and verify it doesn't false-positive when clean — this carries over the original skill's criterion for review validity.

## 13. Implementation order

1. `pi-doctor` + `plugin.json` (get the environment right first, otherwise every later step is fighting the five bugs in §1.1)
2. `mcp/`'s `jsonl.js` → `dispatch.js` → `verdict.js` → `server.js` (the sync path)
3. The async path + `monitors.json`
4. The three `hooks/` scripts + mode state
5. `/pi:mode`, `/pi:probe`, `/pi:doctor`
6. Slimming down SKILL.md

Once step 1 is done, the existing `dispatch-pi.sh` (with the provider name and timeout fixed) should be enough to verify dispatch itself works, before building further on top of it.

## 14. Open questions

- **Automating model routing**: currently `model` is specified by the caller, with the dense/MoE rule spelled out in the tool description. Whether `pi_dispatch` should auto-route based on "does the target file exist" is left for after implementation, once we've observed the misrouting rate.
- **Fan-out concurrency width**: the original skill recommends 8 for light tasks, 2–3 for heavy ones. Whether the server should throttle this centrally, or leave it to the caller, is to be decided during step 3's implementation.
