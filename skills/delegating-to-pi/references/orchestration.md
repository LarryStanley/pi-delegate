# The Mechanics of Dispatch: Flags, Width, Timeouts

> **Read this for fan-out — many dispatches at once — not for sizing a single one.** Since `pi_dispatch` defaults
> to `mode=async`, one dispatch needs no orchestration at all: send it, keep working, poll `pi_status`, collect
> with `pi_result`. The shell-side width loops below predate that and are for driving a batch of tasks from a
> script. Never reach for a batch as a way to make one task smaller — that is the mistake the sizing section of
> SKILL.md measures.

> **The `dispatch-pi.sh` / `run-queue.ps1` plugin referenced in this document is not shipped here.**
> They were the environment that produced these measured numbers (old hand-written scripts) — the text and the numbers are kept as-is because they're the evidence.
> The equivalent in pi-delegate is the MCP tools: `pi_dispatch` for a single dispatch,
> and `pi_dispatch mode=async` fired several times in a row for fan-out, each collected back with `pi_result`
> — the judgment calls about concurrency width, timeouts, and verification discipline still apply exactly as written here; only the dispatch mechanism changed.

## Which of the six steps can't be skipped

**If step 1 is skipped, step 3 breaks, guaranteed.** A task book without a probe is a guess, and pi will
faithfully build the guess — measured control comparison in the same round: the probed one worked on the first
try, the un-probed one came back with a file that didn't even compile, because the edit location the task book
specified was syntactically impossible.

**Step 4 cannot be skipped.** The task book asks it to report "how many passed" — that number is not guaranteed
to be the number that actually ran.

**Step 5's output showing zero BAD does not mean the review is working.** Plant a real violation and watch
whether it goes red — and check both directions: also verify it doesn't false-alarm when the input is clean.


**When to read this**: fanning out a whole batch, deciding concurrency width, reading a timeout or an abort.

Core idea: the real cost of dispatch is "writing the task book + acceptance review," not wall-clock time —
**throw it in the background, work on the next thing while it runs.** To go faster, cut tokens per task, not
widen concurrency.

← back to `SKILL.md` (the four-way split and the discipline table)

## Ready-made scripts

This skill directory's `scripts/` has four you can use directly:

| Script | What it does |
|---|---|
| `dispatch-pi.sh` | Dispatch one task book to pi. Its value is entirely in the flags (see next section) |
| `pi-queue.sh` | Fixed-width fan-out; lists whichever tasks hit timeout when it finishes |
| `pi-verify-fix.sh` | Run tests → if red, automatically dispatch a patch round to pi → two rounds max |
| `run-queue.ps1` | The older PowerShell queue |

**Each one's header explains its flags and where the numbers came from** — rewriting it means re-hitting the same potholes.
`scripts/README.md` shows how to chain them together, and the three things these scripts **won't** do for you.


## Required flags

### pi

```bash
pi -p "Read TASK.md in the current working directory and follow it." \
  --provider <provider> --model <model> --thinking off \
  --tools read,write \
  --no-session --no-context-files --no-skills --no-extensions \
  --mode json > events.json 2>&1
```

`--no-context-files` is pi's equivalent of omp's `--no-rules` flag (blocks `AGENTS.md` / `CLAUDE.md` injection) —
same as the omp flag below, it's **required**, not an optimization.

pi has no `--max-time`; the dispatch script has to wrap its own timeout.

⚠ **On Windows, `timeout 900 pi …` does not actually bound it.** Measured: at 15 minutes the process wasn't
killed, the event file sat at 0 bytes for 45 minutes, and from the harness side it just looked "still running."
The cause: git-bash's `timeout` sends SIGTERM, and node on Windows ignores it. **Use `pi-queue.sh`** — it uses
`Wait-Process -Timeout` plus a forced kill; the same batch of 12 all finished on it.

How to read it: **the event file's size is the progress indicator.** 0 bytes and past the normal duration means
stuck, not slow — kill it and redispatch immediately, don't keep waiting.

### omp

```bash
omp -p "<instruction>" --model <provider>/<model> --cwd <worktree> \
  --auto-approve --max-time 1200 \
  --no-lsp --no-skills --no-extensions --no-rules --no-session \
  --mode json > events.json 2>&1
```

`--no-rules` is **required**, not an optimization: the project's `CLAUDE.md` gets injected into the system
prompt, and a long, dense rules file keeps a small model busy self-reviewing instead of getting to work. Measured
on the same task: without it = 43 reads / **0 writes** / timeout; with it = **done in 93 seconds.** Any required
project rules get rewritten into the task book instead.

Without `--auto-approve` it stalls on the approval prompt, and in `-p` mode there's no one there to click it.


## Pushing the outsourced fraction higher

To get a small model to take on most of the work, the bottleneck isn't model capability — it's the **overhead of
dispatching and accepting.** Three things drive that overhead close to zero:

**One: always throw dispatches into the background; the strong model doesn't wait.**
pi has no `--max-time`, so wrap it in shell's `timeout` and background it — the strong model moves on to the next
thing while it runs (writing the next task book, verifying the previous output). Measured: three dispatches took
35–55 seconds each, but the strong model wasn't idle for any of that time — **the real cost of outsourcing is
"writing the task book + acceptance review," not wall-clock time.**

```bash
timeout 900 pi -p "Read TASK.md in the current working directory and follow it." \
  --provider <provider> --model <model> --thinking off \
  --tools read,write --no-session --no-context-files --no-skills --no-extensions \
  --mode json > task1.json 2>&1 &
```

**Two: write a whole batch of task books first, then measure concurrency width before fanning out.**

Write task books in a batch (`TASK1.md`, `TASK2.md`…) — while writing them your head is still in the same
context, and writing ten at once is much cheaper than context-switching back ten separate times.

⚠ **An earlier version of this document said "local endpoints are mostly serialized, running two at once just
slows them both down." That statement is wrong, at least for MLX/vLLM-style endpoints.** Measured
(2026-08-20, `Qwen3.8-27B-oQ4e-mtp`).

**Small batches first (3 and 6 tasks, minimal task books):**

| Concurrency width | Wall | Cost per task | vs. single dispatch |
|---|---|---|---|
| 1 | 37s | 37s | — |
| 3 | 56s | 18.7s | 1.98× |
| 6 | 118s | 19.7s | 1.88× |

Looks like "it saturates at width 3." **That conclusion is wrong, and the way it's wrong is worth recording:
the batch was too small to see the wave-boundary waste.**

**Controlled experiment, same 10-task batch, only width changed:**

| Concurrency width | Wall (10 tasks) | Cost per task |
|---|---|---|
| 3 | 247s | 24.7s |
| **8** | **198s** | **19.8s** |
| 10 (unbounded) | 225s | 22.5s |

Width 8 is **1.25× faster** than width 3. And the reason isn't more headroom on the GPU — it's that
**the shell-side width limit is manufacturing its own waiting**: `while [ $(jobs -rp | wc -l) -ge W ]; do sleep 2; done`
only polls every 2 seconds, and it has to wait for the slowest task in the current wave before starting the next
one. The endpoint's own internal queueing is more efficient than shell-side queueing — it starts the next request
the instant a slot frees up.

**Conclusion: width 6–8, and stop tuning past that.** 8 vs. 10 differ by 14%, already close to run-to-run
measurement noise; further tuning buys less than the noise. When the batch is smaller than 6, just set width
equal to batch size.

⚠⚠ **But both tables above measured "light tasks" (read one file, write a few lines), and the optimal width
depends on task weight.** Same day, width 8, running 29 **heavy tasks** (each editing 15–61 markup spots plus
deleting the same number of CSS lines):

- The endpoint's generation throughput dropped from about **50 tok/s to 14.6 tok/s** (as seen from the server side)
- **5 of the 29 hit the timeout** (1500s at the time; the default is now 1200s), and 2 of those left **half-edited files** behind
- Wall time 2772 seconds

**Heavy tasks need width dropped to 2–3.** Don't judge "heavy" by file line count — judge it by **how much it
has to produce** (how many spots it edits). Light task = 8, heavy task = 3 — and **check the server's current
tok/s first**; that's more direct than any wall-clock measurement: dropping to a third of normal means the width
is too wide.

**Going too wide costs more than speed**: a timeout leaves half-finished work behind (see "'timed out' doesn't
mean 'did nothing'" in `references/verifying.md`), and in this "add a utility + delete a declaration" two-step
edit, half-finished work **silently drops styles.**

Payoff on a real editing task: 12 dispatches of "edit one Svelte file," 1637 seconds serialized total, 602
seconds wall at width 3 (2.72×). Editing is more expensive than review (50s/task vs. 20s/task), because it has to
read the target file.

**To go faster still, cut tokens per task, not width.** Each of those 12 tasks had to read "task book + template
file + target file," and the template file (96 lines) got re-read 12 times — inlining the needed pattern directly
into the task book saves those 12 re-reads. The GPU is spending tokens, not task-count.

**When measuring, use a real-sized batch, not 3 tasks.** Run the same batch of ≥10 tasks twice (width 3 and width 8):

```bash
S=$(date +%s)
for n in 1 2 3; do
  ( bash dispatch-pi.sh "TASK-probe-$n.md" "/tmp/ev-$n.json" >/dev/null 2>&1 ) &
done; wait
echo "wall=$(( $(date +%s) - S ))s"
```

Once measured, use a fixed-width queue:

```bash
WIDTH=8
for t in TASK-*.md; do
  while [ "$(jobs -rp | wc -l)" -ge "$WIDTH" ]; do sleep 2; done
  ( bash dispatch-pi.sh "$t" "/tmp/ev-$(basename "$t" .md).json" >/dev/null 2>&1 ) &
done; wait
```

⚠ Throwing everything out with no width limit **is not faster** (measured: 10-way unbounded 225s vs. width-8
198s), and the last one has to wait for everything ahead of it to clear — on a large batch, that wait creeps
toward the `timeout` ceiling.

⚠ Two things to keep in mind together: **the strong model shouldn't sit idle while the queue runs, but it also
shouldn't touch the same batch of files.** The dispatched work runs on a remote endpoint, the local CPU is idle,
so this is exactly the window for the judgment calls only the strong model can make (architecture decisions on a
different file, hands-on measurement in a browser). Pick a different file and there's no collision.

**Three: script the acceptance check, don't eyeball it every time.**
Fix four things and write them into one rerunnable check:

```bash
git diff --stat                    # only the named files should have changed
git status --short                 # any files that shouldn't exist
<test command>                     # rerun externally, don't pipe through | tail (swallows the failure code)
grep -nE "toBeDefined|expect\(true|\.skip" <output-file>   # dead tests
```

Once acceptance is a one-line command, "should this be outsourced" stops being something to re-weigh every time —
outsourcing becomes the default.

**After fanning out, don't read each diff one by one — scan for invariants.** Reading 12 diffs one at a time is
several thousand lines; **the ways a batch like this can go wrong usually reduce to three or four shapes**, and
each one is a single line of grep. Example (a batch of "replace a global class with a component" tasks):

```bash
grep -rn 'variant="ghost"' src --include=*.svelte      # the cell in the lookup table most likely to be wrong
git diff -U0 | grep -E "^-.*(/\*|<!--)"                # any comment deleted or rewritten
grep -rn 'class="[^"]*btn' src --include=*.svelte  # how many old-pattern spots remain
```

Three lines caught everything that mattered, and **each line maps to one specific failure mode**, not a vague
"does this look right." The cost of reading diffs one by one grows linearly with batch size; scanning invariants
doesn't — that's the other half of why fanning out pays off.

**What still stays with you: diagnosis, the probe, and the final look.** What these three have in common is that
**they produce judgment, not characters.** Judgment can't be outsourced, but characters can — and characters are
the overwhelming majority of the work.

## Treat "aborted" and "failed" as different, with opposite handling

Once a dispatch is backgrounded, the harness or the system can kill it mid-generation. Measured twice, and the
correct handling is the **opposite** of "the model got it wrong" — **an abort gets redispatched unchanged;
a failure means rewrite the task book or switch models.**

Three steps to tell them apart, in this order, don't skip ahead:

1. **Check the log for the line that marks completion.** My chained script prints one `── TASKn ──` line per
   task and a final "done" line. Only a start with no end = it was cut off mid-run.
2. **Grep for the target string.** Count of 0 = the task never wrote a single character.
3. **⚠ But step 2 alone is not conclusive** — pi uses `edit`, which in principle could have written something
   that doesn't contain the string you searched for. **Run that file's tests directly**: only once both syntax
   and semantics check out can you be sure it's "untouched" and not "half-edited."

Only step 3 rules out "half-broken." The first two only tell you "probably untouched."

Decision table:

| Symptom | Verdict | Handling |
|---|---|---|
| Events file exists, target file unchanged, tests still green | Aborted | **Redispatch unchanged**, don't touch anything |
| No events file | Didn't even finish the first round | Redispatch unchanged |
| Events file exists, target file changed but broken | Failed | Reread your own task book first (see `references/task-books.md`), then suspect the model |

**Don't start rewriting the task book just because "it's been redispatched twice."** The first time I hit an
abort, I nearly rewrote a task book that was actually correct — that would have broken a good recipe, and then
gotten a genuine failure on the third redispatch.
