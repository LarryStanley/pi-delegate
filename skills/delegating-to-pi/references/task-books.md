# Task Books: Probe → Recipe → Scope

**When to read this**: you're writing a task book, deciding how finely to slice, or the output **followed the task
book exactly and is still wrong**.

Core idea: a small model's failures are mostly **wrong output shape** (wandering, never touching the file), not
knowing better and doing it anyway. So use a **positive recipe**, not a long list of prohibitions. And when a task
book can't be written, that usually means the fix itself hasn't been thought through yet.

← back to `SKILL.md` (the four-way split and the discipline table)

## Criterion zero, measured: table lookup vs. needs judgment

⚠ **The criterion itself lives in `SKILL.md`'s "four-way split." This section is only the evidence — don't rewrite
the criterion here.**
(Writing the same criterion twice guarantees one of them gets it wrong — see `references/verifying.md`.)

**Criterion zero (ask this first): does this transformation require "understanding context"?**
No (it's decidable by table lookup) → **write a script, don't even dispatch it.**

This comes first because getting it wrong is the most expensive mistake. Measured (2026-08-20): moving 33 files'
scoped CSS into utilities per a lookup table — dispatched, **46 minutes**, 5 hit timeout, the endpoint's generation
throughput dropped to a third of normal; the same work redone with a 100-line deterministic script took **seconds**,
zero endpoint load, **and it stops and reports instead of guessing whenever it hits something uncertain.**

| Requires understanding context → dispatch | Decidable by table lookup → script |
|---|---|
| "Which markup element does this CSS selector correspond to" (judgment needed when there are multiple candidates) | "`color: var(--ink)` maps to which utility" |
| "Which variant should this button be" (`.ghost` is white background plus border → that's `outline`, not `ghost`) | "Which rung of the spacing scale is `var(--sp-3)`" |
| "Should this property be moved at all" | "Is this declaration on the table" |

Control comparison from the same round: stage two's button migration (needs judgment about variant, which
attributes to keep, which element to target) was dispatched to pi — 13 outputs, zero errors. Stage three's
declaration migration (pure table lookup) was also dispatched to pi — most of it didn't survive.
**The difference isn't difficulty, it's whether judgment is required.**

## The probe: unlock N dispatches at once

### What the probe validates is "does the fix even hold up," not just the environment

The "template" section below is about environment gaps. There's an earlier failure mode that's worse:
**the fix you had in mind doesn't actually hold up in this stack**, and a small model will faithfully build it
exactly as described, and hand back a broken file.

Example: a test was asserting against a UI state that only exists for 1.5 seconds, and when the machine was busy
the state was already gone before the assertion started. The intuitive fix is fake timers to freeze time — but
`expect.element`'s polling **itself uses `setTimeout`**, so freezing it could stall the assertion forever. You
can't reason your way to this — you have to run it.

So before dispatching, make **the smallest possible version of that one change** yourself and run it:

```bash
cp target-file target-file.probe.ts   # rename it into a form the runner will pick up
# change exactly one spot, run it once
```

Once it's validated, "what this should look like" in the task book stops being a **guess** and becomes a
**verified recipe** — the small model is just applying it to the remaining spots.

The same piece of work happened to leave a clean control: **the one with a probe worked on the first try**
(fake timers validated as workable, the model applied it, all four tests green); **the one without a probe came
back with a file that didn't even compile** — because the edit location the task book specified was syntactically
impossible, and I never once tried it myself from start to finish.

**One probe unlocks N dispatches — this is exactly what "spend the expensive model once to unlock it" looks like.**

### The probe needs to be done once per task category, not once per round

"Probed" is not a boolean. If the same round of dispatches contains two **differently shaped** tasks, that's two
probes needed — one per shape.

Measured (2026-08-20, 12 dispatches in one round): 10 were "replace a global class with a component," 2 were
"swap the render source in a test." I did a full probe for the former (picked the smallest file, changed it
myself, ran it), and for the latter figured "it's just swapping one import line" and dispatched it directly.

Result: **all 10 probed ones were usable; the 2 un-probed ones came back with files that blew up with
`document is not defined`** — this repo's convention is that every test file needing the DOM writes
`// @vitest-environment jsdom` at the top itself, and that line wasn't in my task book, because I never ran it
myself once.

The criterion isn't "is this hard," it's **"have I personally run this exact transformation."** Swapping one
import line hits environment conventions just as easily.

### The probe needs to run the full completion command, not just the tests

Once the probe file is changed, **tests green does not mean the recipe is correct.**

Measured: after replacing `<button class="btn">` with `<Button>`, `npx vitest run` was all green, but
`npm run check` reported `Unused CSS selector ".cta .btn"` — that scoped rule (the 44px minimum tap-target height)
**had gone completely dead**, because Svelte's scoped CSS can't select into a child component's internals. The
correct recipe needed one more step (change it to `.cta :global([data-slot='button'])`), and **only the type/
compile check ever surfaces this** — the tests don't.

So the probe's completion criterion is **all** of this project's completion commands (tests, type-check, build),
not just tests. Skip one, and whatever defect that check would have caught gets copied N times.

### Templates need "data with actual content," or environment gaps blow up hours later

The first version of the template rendered with an **empty array**, all green the whole way. It wasn't until
someone fed real data in that jsdom turned out to be missing `IntersectionObserver` (needed for the thumbnail
component's lazy loading), and the entire batch of tests went red at once.

Empty data skips the biggest chunk — lists, cards, tables — so:

- The template looks usable but never actually exercised the path that matters
- The environment gap detonates late, and the symptom becomes "it broke when data was added," which is easy to
  misdiagnose as bad data
- A small model handed that template runs straight into a hole **you already should have cleared for it**, and
  ends the round in a timeout

**Feed the template edge-case fake data from the start**: null fields, empty lists, huge numbers, shared items,
items with no permission. The environment gap should blow up on your hands, not across forty outsourced tasks.


## The shape of a task book

A small model's failure is **wrong output shape** (wandering, never touching the file), not knowing better and
doing it anyway. So use a **positive recipe**, not a long list of prohibitions:

```markdown
# Task
Create <output-file>, for <purpose>.

## Do these four things, in order
1. read <source-file>
2. read <validated template file>
3. **write <output-file>** ← write it directly once you've read the two above
4. bash: <verification command> — fix and retry if it fails, two rounds max

## Forbidden
- No glob, no grep, no reading any file other than the two named above.
- No modifying product code.

Final output: DONE <count>
```

### The brief itself crosses a channel — write it with the Write tool, never a Bash heredoc

The task book is a contract, and it travels. The failure mode here is not the one above: the brief is
corrupted **in transit, before the model ever reads it**, and the model then faithfully builds exactly what
the corrupted bytes say. Measured (2026-08-24): a CJK brief full of backticks and quotes, written through a
Git-Bash heredoc, broke on the backtick/quote mix; the workaround (a Python writer) was *still* a heredoc —
a workaround for a workaround, with the same class of fragility one layer down.

**Write the brief with the Write tool.** Its content crosses as a JSON payload over stdio: the shell never
sees a byte of it, so there is no delimiter, no quoting layer, and no CJK codepage to break it. And in
`strict` mode there is no reason to route around it — the guard exempts `.md` unconditionally
(`src/guard.mjs`), so the Write on a task book is never blocked. The heredoc is habit, not necessity.

The symptom of a corrupted-in-transit brief — output follows the brief exactly, and is still wrong — is
**indistinguishable from a wrong brief** (the table in the next section). The fix is to re-write the file
through the Write tool and verify the bytes on disk, not to switch models or add wording.

### Mentioning an exception in a task book with "no exceptions" creates one anyway

A batch of task books shared one template: each listed "which selectors in this file are exceptions." One of
them had no exceptions, and I wrote:

> (**No exceptions — every corner on this diagram is 4px. One thing to watch specifically: `.panel`.
> It's named panel, but on this diagram it's on the control tier — do NOT treat it as a container.**)

That task book plainly said there were no exceptions, plainly named the trap, plainly said don't. **It made
`.panel` a container tier anyway.** The other 11 in the same batch were all correct.

The cause wasn't that it failed to read the sentence — it's that in an instruction that said "everything goes to
A," I **kept mentioning B** — `container`, `.panel`, `do not treat as container`. To a model doing pattern
matching, those three tokens appearing in the same passage puts B into the candidate set regardless of the negation.

**The full meaning of a positive recipe is: don't describe the wrong option, not even to say "don't pick it."**
That one should have read:

> Every `border-radius` in this file becomes `var(--radius)`. 5 occurrences.

One sentence, no second token name in it. **If you want it to do A, only talk about A.**

Criterion: once a task book is written, scan it — **how many times does the wrong option's name appear?**
More than zero, rewrite it. A warning phrased as "watch out, don't do X" backfires here — it accomplishes
"reminder" and "hint" at the same time.

(This particular one got caught by a guard, at the cost of one patch round. But a guard only catches it if you
**wrote** the guard — and if that batch hadn't had that particular test, "there's one 8px corner on the diagram"
would never have been noticed by anyone.)

### A wrong task book gets faithfully built into something broken

The failures described earlier in this skill were all "wrong shape" — wandering, never touching the file. But
**as long as the instruction is executable, it will be carried out to the letter**, including building something
syntactically impossible, and the symptom looks identical to "the model can't handle it."

Example: a task book said "insert a Svelte comment directly above the `href={...}` line." That line is **inside
an `<a>` tag's attribute list** — an HTML comment can't be inserted in the middle of a tag. The small model did it
anyway and handed back a file that didn't compile. It didn't do a single thing wrong relative to what it was told.

**Which way to look: when you get bad output, reread your own task book before you suspect the model.**
The two failure modes differ like this:

| | Model couldn't handle it | Task book was wrong |
|---|---|---|
| Output | Empty, or edited a file that wasn't named | Exactly what you said, just broken |
| Event log | High thinking, `write` low or 0 | Thinking 0, `write` normal |
| Rerun the same task book | Result varies | Breaks the same way every time |

**The single most common trip: content pasted into the task book that itself contains the syntax's own closing
delimiter.**

Measured (2026-08-20): asked it to replace a block of JSDoc, and the JSDoc **content** itself included a CSS
comment as an example — so the content contained `*` immediately followed by `/`. That combination is JSDoc's own
closing marker — the comment closed early right there, everything after it turned into code, and **the entire
test file became a syntax error, not one test would run.** I tried a zero-width space in the task book to break it
up; it didn't help (normalized away in transit).

Other shapes of the same trap: heredoc content containing the heredoc's own end marker, Markdown code-block
content containing three backticks, a shell single-quoted string containing a single quote.

**Criterion: does the content you're asking it to write contain the closing delimiter of the syntax it's
embedded in?** If so, use a different representation (describe the symbol in words, don't paste the literal
symbol) — don't rely on escaping or zero-width spaces. **Tests will catch this** (a syntax error is loud), but it
burns a whole round, and the symptom ("the whole file is broken") looks far worse than the cause
("I pasted a comment-closer inside a comment").

The fix is to fix the task book and dispatch again — not switch models, not add more wording. And it often pays
you back: that failure forced me to think through "even if it could be inserted, it shouldn't be" — the files in
that directory are CLI-generated, a disable comment written into the file would vanish on regeneration, and the
rule should live in a config file instead. **When a task book can't be written, that usually means the fix itself
hasn't been thought through.**

### A lookup table missing one precondition gets its error copied N times — and no automated check goes red

The section above is about "the task book asked for something impossible" — visibly broken output. There's a
more expensive variant: **the replacement recipe in the task book is itself legal, but it's missing a precondition.**

Example (2026-08-20). The recipe had this row:

```
button.btn { min-height: 44px; }   →   :global([data-slot='button']) { min-height: 44px; }
```

The replacement is perfectly legal, compiles, tests all green, `npm run check` 0 errors 0 warnings, build exit 0.
But it's **missing one condition**: `:global()` has no scope of its own. The original `.btn` was Svelte-scoped
(affects only this component); after the replacement, that 44px rule applied to **every** same-named element
**site-wide**.

Three files, same mistake, one dispatch, all three hit — because all three faithfully followed that one row.
The symptom shows up on **an unrelated page** (some button gains unexplained extra spacing), and the file that
broke it has nothing to do with that button.

**How to catch it while writing the recipe: ask, for every row, "does this transformation have a precondition?"**
Why is the left-hand side correct? If the reason involves "because it's constrained by something" (scope, layer,
namespace, lifetime), the right-hand side must carry that same constraint forward. In the example above, the
left side is safe because of Svelte's scoping, and the right side removes the scoping — that's exactly what the
recipe was missing.

When you're not confident about the recipe, **split that row into two tables: "always holds" and "depends" —**
keep the latter off dispatch and do it yourself. Fixing three files by hand is cheaper than fixing three broken ones.

### Explicit prohibitions work — but only against "actions," not against "shape"

Good news, and worth distinguishing from the earlier claim that "prohibitions have no grip on behavioural shape":

Measured, 12 dispatches, task book said "**do not modify the text of any comment**" and "**do not delete any
`<style>` rule, only change selectors**." Result: **0 lines of comment rewritten, 0 rules deleted.**

This doesn't contradict the earlier "take the capability away with `--tools`, don't just tell it" point. The
difference is what's being prohibited:

| What's prohibited | Effective? | Why |
|---|---|---|
| "Don't wander, don't glob" (**behavioural shape**) | ✗ No | It's not defiance — it doesn't know how else to start. Take the tool away instead |
| "Don't edit comments, don't delete rules" (**a specific action**) | ✓ Yes | This is a discrete choice it makes while editing; stating it clearly gets it followed |

So prohibitions in a task book should be written as **specific actions**, not behavioural tendencies.
"Do not modify comment text" works; "don't go off script" doesn't.

### Example text in a task book gets copied verbatim into every spot

A task book gave a two-line Chinese comment as an example, to be added at three edit points. It pasted **the
exact same two lines** three times, including at the one spot where it made no semantic sense (inside an
`afterEach`).

It will not rewrite the example to fit each spot on its own. Either state explicitly in the task book "write a
different sentence at each spot, don't paste the same block again," or treat it as a mandatory review item. This
isn't a defect — it **treats the example as a template**, and a template is exactly the thing you copy.

Three more points:

- **Name which two files it should read.** Leave it unnamed and it will read forty.
- **Size the time budget off the actual tool cost.** Measure the verification command's real wall time once
  (including startup), and multiply by "how many times it will run." On a project where one cold vitest start is
  80 seconds, a `--max-time` of 15 minutes won't be enough.

## Slicing: by what it must READ, never by what it must produce

This section is about **input size** — how many characters pi has to read before it can start working. That is a
real, measured ceiling and slicing against it works.

**It is not a licence to slice by output scope**, and the two get confused constantly. Measured the other way
(2026-08-22): the same job dispatched whole (three files, implementation plus tests) against the same job sliced
down to a single 30-line file. The whole version wrote exactly the two files it managed, and they passed all nine
acceptance tests. The sliced version finished its 30 lines, had nothing left to do, and spent the rest of its
budget rewriting a scratch file — 22 writes, 21 of them the same path, **12x the input tokens**, plus a file the
task book had explicitly forbidden. See the sizing section of SKILL.md.

So: a task that must READ a 1000-line file needs slicing. A task that must PRODUCE three files does not.

"One process per file" is a **floor, not the answer.** Measured breakpoints, all of them about reading:

| Source file size | Result |
|---|---|
| 27–75 lines | Smooth, 3–7 minutes each, 80–100% coverage |
| ~250 lines | Works, but takes 5+ minutes |
| **1044 lines** | **Timed out without even creating the test file, twice in a row** |

A large file isn't "a bit slower" — it's **completely undoable**: the whole budget gets spent on reading, and
there's no time left to start writing.

So for a target over two or three hundred lines, slice further into **functional chunks**: one agent handles only
"sorting and column width," another only "the import flow," each producing its own test file, with several
agents dividing up the same source file. Slicing needs to come with an **already-validated, runnable template**
(see the "probe" sections above) for each slice, or every slice will separately get stuck on the same environment problem.

The test isn't "is this task hard" — it's **"how many characters does it have to read before it can start working."**
