---
description: Use when delegating coding work to the local pi agent to cut cost, or when you are about to hand-write source or test files yourself instead of specifying them, or when a small-model agent reads files endlessly without ever writing, times out having produced nothing, or keeps reasoning forever even though thinking was turned off.
---

# Delegating to pi

**You are the tech lead, not the typist. All source code is written by pi — implementation and tests alike.**

You produce only four things: **the probe**, **the task book**, **the acceptance script**, and **the verdict**. Every other character gets dispatched.

The test is not "does this need judgment" — it's structural: **"is this a character that gets committed" — if yes, dispatch it**.

## The four-way split (the one decision that must be right)

| What this really is | Who does it | The test |
|---|---|---|
| **Writing any source code**: implementation, tests, patches | **pi** | "Is this a character that gets committed?" |
| **A lookup, decidable without reading context** | **a script** | "Does this transformation require understanding context?" |
| **Comparing two lists item by item** | **pi** | Extract and normalize with a script, hand the comparison to pi |
| **Deciding the contract, judging success/failure** | **you** | probe, task book, acceptance script, verdict |

⚠ **The "a lookup, decidable" branch is the most expensive misjudgment**, and no hook can catch it.
Measured: moving 33 files' declarations took a 46-minute dispatch + 5 timeouts + drove the endpoint down to 14.6 tok/s (normally 50),
while a deterministic script finished in seconds at zero load. **It needs no context understanding, so it should never pass through a model at all.**

**"pi can't handle this" is not a reason to do it yourself — it's a signal to split the work.** pi can't reliably edit a file past roughly 700 lines —
extract the part that needs changing into a new file, then hand pi the whole new file.

## How to dispatch

Use the MCP tools; don't assemble CLI commands by hand:

| Tool | When to use it |
|---|---|
| `pi_dispatch` | Dispatch a task book. `mode=sync` waits for the result, `mode=async` runs it in the background |
| `pi_status` | Check progress |
| `pi_steer` | Interject mid-run when you notice it's heading the wrong way |
| `pi_abort` | Abort. **Re-dispatch an aborted task unchanged; only rewrite the task book after a real failure** |
| `pi_result` | Collect the verdict of an async dispatch |
| `pi_transcript` | Drill in only when the verdict isn't enough |
| `pi_stats` | Check token usage |

**Two-stage dispatch**: dispatch the tests first (with the contract), confirm they genuinely fail, and fail where expected; then dispatch the implementation
(with that failing test set, plus "do not touch the tests"). Put tests and implementation in the same task book and it will write tests that happen to pass whatever it wrote.

**Model choice**: leave it unspecified to use the user's own pi default model (`~/.pi/agent/settings.json`) —
that is the right choice almost every time. Only switch it deliberately, via `pi_dispatch`'s `provider` / `model` parameters,
and always supply both together (pi only honours a paired override). See `references/choosing-models.md` for the selection criteria:
editing an existing file always calls for dense; only writing a brand-new file from scratch is worth trading to a MoE for speed.

**`pi_dispatch`'s other flags have measured defaults**: `thinking=off`, `tools=read,write,edit`,
`no_context_files=true`. Override them deliberately — every one of these defaults exists because of a measured
"without this it times out with zero output" run (the reasoning is in the tool descriptions).

## Modes

`/pi-delegate:mode strict` makes the hook block your own edits to existing product code outright.
Use `/pi-delegate:probe` to get a one-time bypass for a probe.

## Further reading (load on demand, not all at once)

| File | When to read it |
|---|---|
| `references/delegating-implementation.md` | Dispatching implementation — how to write the contract, two-stage dispatch, how to split work down to what pi can handle |
| `references/task-books.md` | Writing a task book, or when the output followed it exactly but is still wrong |
| `references/verifying.md` | Acceptance review, or a second layer of review |
| `references/choosing-models.md` | Timeouts with zero output, or choosing a model |
| `references/orchestration.md` | Fan-out, deciding concurrency width |
| `references/diagnosing.md` | Wrong output and you're not sure what to adjust — a symptom lookup table |

## Symptoms don't point to causes

Failure symptoms (timeout, no output) all look the same. **Measure the thinking/tool ratio before touching anything.**
Use `pi_transcript`'s `filter=tools` to see what it's actually reading — a file that was never named is roaming.
