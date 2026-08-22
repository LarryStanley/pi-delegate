# Symptom Lookup Table: Failures All Look the Same, Causes Don't

Failure symptoms (timeout, no output) all look identical, and it's easy to fix in the wrong direction.
**Measure the thinking/tool ratio before touching anything** — the symptom points to nothing about the cause;
this exact table cost six wrong directions and two hours of pure wasted effort before I wrote it down.

| Symptom | The intuitive fix | Actual cause |
|---|---|---|
| Timeout, zero output | Concurrency, `--max-time`, `--thinking` | Rules-file injection (`--no-rules` / `--no-context-files`) or the wrong model |
| `--thinking off` set, thinking still past a thousand | Raise `max_tokens`, switch models | **That flag is a no-op.** The model config never declared `reasoning`, or the key sent isn't one the endpoint honours. The harness doesn't error |
| Lots of `read`, `write` at 0 | Task too hard → slice it finer | Exploration was never prohibited, files were never named |
| Comes back empty-handed, very short time | Prompt unclear, or rule the model out | Usually the tool call never reached the harness. Hit the endpoint directly first to check whether it returns `tool_calls` at all |
| Self-reports success but the thing is broken | Trust it | No external verification |
| **Followed the task book exactly, but the output is broken** | Switch models, add stronger wording | **The task book asked for something impossible.** The event log shows thinking 0, `write` normal, and every rerun breaks in the exact same spot |
| The same comment shows up at every edit point | Assume it's being lazy | It's treating the task book's example text as a template and copying it verbatim. Either state explicitly that each spot needs different text, or catch it in review |
| Target file untouched by a single line, but an unrequested script file appeared | Assume the task book was unclear | **It's using `write` as a substitute for the bash it lost.** Explicitly forbid those file extensions |
| A whole batch times out, and the server gets slower | Raise `timeout`, switch models | **Concurrency is too wide.** Check the endpoint's tok/s — dropping to a third of normal is the tell. Drop heavy tasks to width 2–3 |
| A batch's output is all-green on the three checks, but the screen is wrong | Trust those three checks | **None of them ever asks "did anything land somewhere it shouldn't have."** See the ladder in `references/verifying.md` |
| A guard goes red after a refactor, message like "this thing is gone" | Loosen that guard's regex | **The guard is scanning for the old pattern**, and it's broken in both the false-positive and the missed-detection direction at once. Rewrite it to check "where the intent now lives" |
| Event file at 0 bytes, harness says "still running" | Raise the timeout, wait longer | **`timeout` can't kill pi on Windows** (node ignores SIGTERM). Measured: 0 bytes for 45 minutes. Use `scripts/pi-queue.sh`, and **read the event file's size as the progress indicator** |
| A job just dispatched already shows a 0-byte event file | Assume it's stalled, kill and redispatch | **`pi … > file`'s stdout is block-buffered** (~4KB), so a job that just started or produces little output will sit at 0 for a while. Judge by **whether the process is still alive** (`Get-CimInstance Win32_Process` filtered to `pi-coding-agent`) **plus elapsed time**: a few minutes at 0 bytes with a live process is normal; twenty minutes still at 0 is actually stalled |
| The same bug produces different results across two hand-written tools | Fix the broken one | **The same criterion was written twice.** Factor it into one function, no matter how short it is |
| Output passes every check, but deployment gets blocked by the vulnerability scanner | Assume it's a platform issue | **The output contains a shape-based landmine unrelated to functionality** (bare `.sort()`, `innerHTML` + template interpolation). Add one more grep to acceptance — see "release gates" in `references/verifying.md` |
