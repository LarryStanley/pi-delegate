# Dispatching Implementation, Not Just Tests

Dispatching tests is easy to accept. Dispatching implementation keeps getting overruled by yourself. This
document does exactly one thing: makes the case for why implementation should also be dispatched, and gives the
three mechanisms that actually make it possible (the contract, two-stage dispatch, cutting a seam).

## Why the line has to be drawn at "is this source code"

Because the criterion "does this need judgment" will keep expanding until it swallows everything.

Measured (2026-08-21, the summary panel's Q&A view): the skill at the time said "only three things are left for
you: the probe, diagnosis, and the final look." In the same round, I still hand-wrote a new component (180
lines), wiring for an existing component (125 lines), and 21 rendering tests (190 lines), and only dispatched two
test files. **Roughly 80% of the characters were typed by me**, and each one had a reason at the time:

| The reason at the time | Why it doesn't hold up |
|---|---|
| "The wiring needs too much judgment" | The judgment is "where does it connect, what does the contract look like" — that's **a paragraph in a task book**, not 125 lines of code |
| "This file is a thousand lines, pi can't edit it" | Correct, so **cut a seam**. Once cut, the whole new file can be dispatched |
| "The 18 existing tests will get broken" | That's the job of **a prohibition + an acceptance script**, not "I'll do it myself, it's safer" |
| "Writing the new component from scratch is faster" | Writing a new file from zero is exactly the shape pi is best at, and it can even be traded to a MoE (5× faster) |

So the criterion has to be formal and non-negotiable: **a character that gets committed → dispatch it.**

## Mechanism one: the contract

The part of the task book describing "what this file should look like." **Being able to write the contract is
proof you've actually thought it through** — which is also why this part stays with you: the contract is
judgment, the characters are not.

An implementation contract needs these seven items; missing even one gets back output that "looks right but doesn't connect":

1. **File path** (create or edit, line-count ceiling)
2. **Exported signature** (function signature, prop types, defaults) — copy it verbatim, don't describe it
3. **Existing things it depends on** (which imports, their signatures)
4. **DOM contract**: `data-testid`, `aria-*` (which attribute appears only under what condition)
5. **What's off-limits**: which files not to touch, which tests not to change, don't create `.sh`/`.py`/`.md` files
6. **Acceptance command** (it can't run it itself, but writing it down tells it what success looks like)
7. **One validated example** — real code from the probe. **This item is the most expensive and the most
   effective**: without it, when a location described in the task book is syntactically impossible, pi will
   faithfully produce a file that doesn't compile.

## Mechanism two: two-stage dispatch (tests first)

Don't ask it to write tests and implementation in the same task book — it will write tests that just happen to pass whatever it wrote.

```
Stage 1  dispatch tests    contract + "these tests must be red right now"
         ↓                 you run it externally, confirm it's genuinely red, and red where expected
Stage 2  dispatch impl     same contract + that test file's path + "do not modify the test file"
         ↓                 you run it externally, confirm green
Stage 3  you               mutation check (deliberately break the implementation, tests must go red)
```

Stage 1's red is a **free RED**: it simultaneously validates that the contract was clear enough to write tests
from, and that the tests actually catch something (they go red with no implementation present). Skip this stage
and you don't find out about either problem until the very end.

Stage 2's prohibition is load-bearing: without it, when pi hits a test it can't satisfy, it edits the test — and
in `git diff --stat` that just looks like "one more file changed."

## Mechanism two-b: every output goes through a reviewer

Treat dispatched output as a draft, and the "verdict" step can itself be outsourced to a review agent
**carrying the task book** — what it does is item-by-item matching, exactly the shape pi is best at, from the
table at the top of this document.

Three things the reviewer needs (missing any one, and it can only go by feel):

1. **The task book itself** (the contract) — without it, review degenerates into "I think it'd be nicer this way"
2. **The path to the diff file** (don't paste it into the prompt — pasted, it permanently occupies your context)
3. **An item-by-item checklist**, each item a question answerable OK/BAD, and it must include
   **this project's specific gate landmines** (bare `.sort()`, `innerHTML` + interpolation…)

**Fix the output format to** `ACCEPT` or `NEEDS_FIX + a severity-ordered list`, and explicitly require it to
"only report things that cause an actual problem, not style preferences" — otherwise you still have to filter
what comes back yourself.

### Order matters: verify RED → send for review → only then do GREEN

Measured 2026-08-21: I edited the implementation (copy) **at the same time** the reviewer was reviewing the test
code. So the premise I'd given it ("these 10 tests are currently 9 red, 1 green") had already stopped being true
by the time it read the files — it saw 10 green. That time the reviewer correctly reported the contradiction, but
that was luck — it could just as easily have concluded "these tests don't catch anything at all."

**Review happens against a frozen state.** While it's running, only do things that **don't touch the files it's reading.**

## Running dispatches in a worktree: node_modules can be borrowed, but there's a boundary

A worktree saves you branch-switching risk, at the cost of `npm install` (a few minutes plus a copy of disk, on
this repo). On Windows you can borrow the main directory's copy with a junction:

```bash
cmd //c "mklink /J .worktrees\<name>\node_modules node_modules"
```

**Boundary (measured 2026-08-21)**: plain-node-environment tests work completely normally; but if vitest's setup
file resolves to `/@fs/<absolute path in the main directory>` (e.g. `@testing-library/jest-dom`), Vite refuses it
because that path falls outside the worktree root — the symptom is **the whole test file shows 0 tests plus
`Cannot find module '/@fs/…'`**.

So: **a worktree borrowing node_modules can only run tests that don't depend on Vite's filesystem allowlist.**
If you need to run rendering tests, do it after merging into the main directory (that round needs a full run
anyway), or just do a real `npm install`.

## Mechanism three: cut a seam

pi's measured ceiling for editable file size is around 700 lines (past that, the budget gets spent on reading).
This bounds **one file being edited**, not how much work a dispatch may carry: a dispatch handling three files at
once measured cleaner and 12x cheaper in input tokens than the same job sliced down to one small file. See the
sizing section of SKILL.md.
For an existing large file:

**You decide the seam, pi fills in the content.** Concretely: extract the behaviour being added into a **new
file** (a new file has no line-count problem, and no risk of accidentally breaking something nearby), then leave
only a **mount point** in the large file.

Editing that mount point is the only place you're allowed to touch source code by hand, and it has a **hard
ceiling: no more than 10 lines in any one file, and only at a seam you named yourself.** Going over means the
seam wasn't cut cleanly — go back and change how it's cut, don't just write 20 extra lines while you're at it.

Without that ceiling, "integration" becomes a new catch-all excuse. The wiring in that round was measured at 125
lines, and the reason it was 125 lines is that it wasn't just a mount point — it also covered view-switching
state, header conditionals, accessibility attributes — all of which should have been in the contract, for pi to write.

## Signs you shouldn't be touching source code

Three red flags — stop the moment you see one and turn what's in your hands into a task book instead:

- You're editing a `.ts` / `.svelte` / `.py` product or test file
- You're typing your second curly brace
- You just thought "it's faster if I write this myself"

## After integration, who's responsible for what

**The verdict is yours, the patching is pi's.** If output comes back with three red, don't fix those three
yourself — feed the failure messages back and dispatch a patch round (see "don't throw away a whole failed run"
in this directory's `verifying.md`). Only look at that piece by hand once **the same spot is still red on the
third round** — and at that point what you usually need to fix is the task book, not the code.
