# Verification and Review: Three Layers, a Ladder, and Falsification

> **The `dispatch-pi.sh` / `run-queue.ps1` plugin referenced in this document is not shipped here.**
> They were the environment that produced these measured numbers (old hand-written scripts) — the text and the numbers are kept as-is because they're the evidence.
> The equivalent in pi-delegate is the MCP tools: `pi_dispatch` for a single dispatch,
> and `pi_dispatch mode=async` fired several times in a row for fan-out, each collected back with `pi_result`
> — the judgment calls about concurrency width, timeouts, and verification discipline still apply exactly as written here; only the dispatch mechanism changed.

**When to read this**: you need to accept a batch of output, you want to outsource the second layer of review, or
**type-checking / unit tests / build are all green but the screen is wrong**.

Core idea: verification always happens outside the model, and "it runs" is only the floor. The three automated checks all ask
"is this **legal** right now" — **none of them ever asks "did anything land in the wrong place."**

← back to `SKILL.md` (the four-way split and the discipline table)

## The two script shapes for criterion zero

Criterion zero says: a transformation that's decidable by table lookup gets a script. That script has a shape, and
the same round **needs a second one** — because once the first one is done, no existing check ever asks
"did anything land somewhere it shouldn't have."

### Shape one: the deterministic applier — **when unsure, stop and report; don't guess**

This is the single most important difference between it and a small model. A small model facing ambiguity will
**guess something that looks plausible**; the script should skip and list it — that list is the work list for a human.

```js
for (const rule of rules) {
  // 1. Is this target even "movable" — the criterion must be narrow, because narrow is what makes it provably safe
  if (!isConvertible(rule.selector)) { skipped.push({rule, why: 'not a single class'}); continue; }

  // 2. Is the landing spot unique — with multiple candidates, "which one to apply to" is not a mechanical decision
  const hits = countExact(markup, rule.name);
  if (hits !== 1) { skipped.push({rule, why: `${hits} candidates`}); continue; }

  // 3. Look up each declaration one by one. Anything not on the table is left **untouched** — no rounding, no inference
  for (const decl of rule.declarations) {
    const out = lookup(decl);          // null = not on the table
    if (out === null) { left.push(decl); continue; }
    apply(decl, out);
  }
}
console.log(`applied ${applied.length}, skipped ${skipped.length}`);
for (const s of skipped) console.log(`  ${s.rule.selector}  ${s.why}`);  // ← the work list
```

Measured: on a 1264-line file this auto-processed about 60%, with the remaining 40% being state variants and
relational selectors — that 40% should be looked at by a human anyway. **60% free, 40% with a list beats "dispatch everything and review 33 diffs."**

### Shape two: diff against HEAD — **ask "did anything land somewhere it shouldn't have"**

Type-checking, unit tests, and build **never ask this question**. They ask "is this legal right now,"
and the single most typical bug in a large mechanical refactor is "legal, but landed in the wrong place."

```js
const before = rules(styleOf(execSync(`git show HEAD:"${file}"`)));
const after  = rules(styleOf(readFileSync(file)));

for (const [selector, decls] of before) {
  if (isSafeToHaveConverted(selector)) continue;   // it's normal for this one to have been moved
  for (const d of decls) {
    if (!(after.get(selector) ?? []).includes(d)) lost.push(`${selector} { ${d} }`);
  }
}
```

**The criterion here should be one notch looser than the applier's.** The applier being conservative is correct
(it can't see the whole picture); if the auditor is equally conservative it will fire false alarms on correct
conversions, and a rule that false-alarms always ends up getting turned off. That extra notch of looseness belongs
in the function, not left for the next person to guess.

Measured: this script caught **16** files out of 33 that had been converted incorrectly, while type-checking, unit
tests, and build **caught none of them** (type-checking only caught 3 spots that happened to turn into syntax
errors — that's a different symptom of the same defect).

⚠ These two scripts share some criteria ("what's convertible," "where does this name show up").
**Those need to be factored into one place** — see "writing the same criterion twice" below; I hit that pothole
twice in the same round.

### Climb the ladder — don't jump straight to the most expensive rung

"The three checks never ask whether anything landed in the wrong place" is true, but it doesn't mean **every time**
you need to open a browser. Three same-shaped bugs in the same round, and the cost of the tool that catches each
one differs by three orders of magnitude:

| Rung | Tool | Cost | What it caught |
|---|---|---|---|
| 1 | **Static rule** (a test that scans source) | seconds | A comment closed early, turning the next seven lines into visible text on screen. All three checks green (text inside a `<div>` is legal) |
| 2 | **Diff against HEAD** (shape two above) | minutes | A declaration fell from `.body` to `.warn-body`. Legal, but landed in the wrong place |
| 3 | **Open a browser and measure computed style** | ten minutes+, and it has to be running | A whole batch of markup never got written in. Type-check 0/0, build 0, tests green, and at 390px the full desktop layout is displayed |

**Rule: whatever can become a static rule should become a static rule; only what's left goes to measurement.**
The test is "can this bug be seen in the source" — rung 1's bug can (`-->` shows up at depth 0), so it should
never be a human's or a browser's job; rung 3's bug can't (the missing thing isn't in the file at all).

The rung-1 rule reads about fifteen lines total: HTML comments don't nest, so depth is only ever 0 or 1;
strip `<script>`/`<style>` first (the `-->` inside those isn't an HTML comment), then walk through —
"seeing `-->` at depth 0" turns it red. **It only counts once it's been falsified** — put the `-->` back
where it was and it must turn that exact file red.

### Once measurement has validated a model, you don't need to measure that whole class again

The spec said "this cell can't be computed, only measured" — referring to the actual colour after CSS `filter`
compositing. What the measurement bought was much bigger than that one cell:

| | Measured | Computed from "sRGB luminance matrix → alpha composite" |
|---|---|---|
| Large fill area in dim state | `rgb(237,237,237)` | `rgb(237,237,238)` |
| Darkest stroke pixel in dim state | `rgb(120,121,121)` | `rgb(121,121,121)` |

**Within 1/255, and that's two independent measurements agreeing with the same model** (the second row was
derived by taking the anti-aliasing coverage measured in the non-dim state and feeding it into the model to
predict the dim state). So the line "can't be computed" can be struck — **from here on this whole class of
compositing can just be computed, no browser required.**

This is what "spend the expensive model once to unlock it" looks like applied to measurement: **the output of
one measurement isn't a number, it's a validated model**, and a model can be reused N times. Worth asking before
dispatching: is what I'm about to measure something that, once measured, turns the next N times into a computation?

⚠ Two traps that make measurement lie, one line each:

- **A property with a `transition`, read immediately after adding the class, gets caught mid-transition.**
  Measured: `transition: filter .12s`, and the read came back `grayscale(0)` — looks like "the rule didn't take,"
  and it nearly got investigated as "the selector isn't matching." Wait before you measure.
- **Anti-aliasing means the darkest pixel never reaches the nominal value.** With a 2px dashed line, fractional
  coordinates, dpr=1, the darkest stroke pixel measured was `rgb(76,79,81)`, not `#14181b` (coverage ~0.74).
  **Don't infer "insufficient contrast" from an edge pixel** — or every thin line will fail.

## Verification happens outside the model

The task book asks it to report back "how many passed, what's the coverage," and it will give you a number —
**that number is not guaranteed to be the number that actually ran.** The dispatch script re-runs it once itself;
the cost is negligible. See `run-queue.ps1` in this directory.

**But "it runs" is only the floor, not the acceptance bar.** The following, in ascending order of strength — do at
least as far as the mutation check:

| Strength | Check |
|---|---|
| Minimum | Rerun externally, check the exit code (don't pipe through `\| tail` — that swallows the failure code) |
| Required | `git diff --stat`: only new test files should be allowed. Making product code changes to turn tests green is the most common form of cheating |
| Required | Scan for dead tests: `toBeDefined`, `expect(true)`, `.skip`, an `it()` with no `expect` |
| **Critical** | **Mutation check**: pick a few at random, deliberately break the code under test, and the tests **must go red**. If they don't, that test suite isn't touching anything — this is the only way to tell "a real test" from "green decoration" |

Coverage numbers are only a supporting signal, never a pass bar: a test can cover every line and assert nothing.

One more item, same strength as the mutation check but asking an entirely different question:

| Strength | Check |
|---|---|
| **Critical** | **The project's own release gate**: will this repo's deploy / vulnerability scan / lint reject this output |

### Output also has to pass "release gates unrelated to the feature"

**"All tests green" is not the same as "shippable."** Every project has a handful of gate rules that judge shape,
not behaviour, and dispatched output runs straight into them by nature — **the model was never told that
blocklist exists**, and the task book rarely thinks to mention it either.

The most expensive instance (2026-08-21): a test file with 21/21 green and all five planted mutations caught,
containing two bare `.sort()` calls. The company's vulnerability scanner rates a bare `.sort()` (no comparator)
as **CRITICAL**, and Tier 2 release requires 0 CRITICAL — **it counts even inside a test file** — and that one
finding alone was enough to block the whole service from shipping.

Why none of the existing acceptance checks caught it: **it has nothing to do with functional correctness.**
External rerun green, mutation check red exactly as expected, `git diff --stat` shows only new test files, dead-test
scan clean, type-check passes. That gate asks "is this string pattern on the blocklist," and the model was never
told that blocklist exists.

Two things to do, and you need both:

1. **Write the known gate rules into the task book** (e.g. "sorting is always `.sort((a, b) => a.localeCompare(b))`"),
   and phrase them as **concrete actions**, not "be careful about security."
2. **Add one more static scan at acceptance time**, because item 1 will still miss things — the task book can never
   enumerate the whole blocklist, and the entries it misses are the ones you need to know about before push, not
   after deployment gets blocked:

```bash
scripts/pi-gate-scan.sh $(git diff --name-only --cached)
```

That script's rule table *is* this project's list of gate landmines — **the first time something gets blocked,
add that rule to the list.** It deliberately skips lines that are entirely comments — the first version didn't,
and it fired on the very comment explaining why bare `.sort()` isn't allowed; a false positive like that trains
people to start ignoring the script, and then the real misses stop being noticed too.

**Criterion: any rule of the shape "tests all green but still won't ship" belongs to this class.** What they have
in common is that they judge **shape**, not behaviour, so only a static grep catches them, and one hit is enough
to block a release.

### Firing multiple mutations at once — they can mask each other

Running the mutation check one mutation at a time is expensive (a single `vitest run` in this project is 80
wall-clock seconds), so it's tempting to apply five mutations at once and just check whether the red count matches.
**You can — but counting reds is not enough. You have to match each red test against the one it was expected to catch.**

Measured: one batch had two mutations, "ignore the 'already dismissed' flag" and "the prompt never auto-opens."
The second one meant the prompt never appeared at all, so the test that the first mutation was supposed to turn
red **stayed green** — one fewer red than expected, and if you only look at "5 mutations, 4 went red, probably one
mutation didn't take," you'd misdiagnose it as the script's assertion not firing.

Rules:
- Mutations in the same batch must have **non-overlapping target tests**, and **none can be upstream of another**
  ("turn this whole feature off" masks "one condition in this feature is wrong").
- The script should print the **names of the red tests**, not just `N failed`.
- If the names don't match up, split the batch and rerun — a masked mutation means that test was never actually falsified.

### Review has three layers, and only the middle one is not safe to outsource

"Leave acceptance to yourself" was too broad a claim. In practice, review breaks into three kinds of work, and only
the third can't be outsourced:

| Layer | Who does it | Example |
|---|---|---|
| **Decidable** | **A script** | Did the change scope stay in bounds, were extra files generated, dead-test patterns, is what should be untouched still there |
| **Mechanical but hard to script** | **A small model** | Match a table of values back against the source line by line, confirm every named location actually got changed, check that a number written in a comment matches the actual value |
| **Needs judgment** | **A strong model / you** | Is the formula correct, does this assertion actually catch anything, is the reasoning in the comment actually true, is this over-engineered |

Measured (2026-08-19): matching 37 colour values back against a 330-line CSS file, output as a fixed-format verdict —
`Qwen3.8-27B-oQ4e-mtp`'s result was **bit-for-bit identical across all 38 lines** to an independent script's correct
answer, with 3 reads / 1 write, and it never touched any source code.

**What matters is the shape of the task, not the label "review."** That task book gave it "read the list → read
the file → output OK/BAD/MISSING for every entry, one output line per list entry" — the same
**positive recipe + fixed output format** as a dispatch task book. It was never asked for an opinion.

Conversely, **don't** tell a small model "review this diff, find the problems." That's the third layer, and it
will hand back an opinion that sounds confident and is unreliable — **worse than no review at all, because it
manufactures false confidence.** The same model is zero-error at the second layer and untrustworthy at the third —
the entire difference is the shape of the task.

The real reason the second layer is worth outsourcing isn't the few cents it saves — it's that **it shrinks the
third layer's workload**: the strong model no longer has to check every single hex value by hand, and can spend
its attention only on what genuinely needs judgment.

#### A repeatable recipe for the second layer: turn "what to compare" into two lists

The second layer gets skipped a lot because "what should it review" is hard to specify. One shape keeps working:
**write a script that extracts both sides into plain lists first, then have the small model diff those two lists.**

Example (2026-08-20, a batch of dispatches restricted to "only change CSS selectors, don't touch declarations"):

```js
// The script owns extraction and normalization — this part is decidable, layer one
function declarations(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '').split('
')
    .map(l => l.trim())
    .filter(l => /^[a-z-]+\s*:\s*[^;]*;$/.test(l))   // keep declarations only, discard selectors
    .map(l => l.replace(/\s+/g, ' '));
}
// For each target file, produce a CMP-N.txt with two lists: "declarations before" and "declarations after"
```

The task book asks for exactly one thing, and the output format is fixed enough to need no judgment:

```markdown
The file contains two lists. They **should be identical**. List anything missing from "after," anything
extra in "after," or any value that changed.

The first line is a single word only: identical → `SAME`, any difference → `DIFF`.
If DIFF, one line per finding after that: `missing: <declaration>` or `extra: <declaration>`.

Do not judge "is this change correct" — only report where the two lists differ.
```

Result: all 10 tasks came back `SAME`, 121 declarations checked with zero mismatches, 198 seconds wall time
(concurrency width 8).

**Why this step isn't a script** (this is the criterion for choosing a layer, worth writing down): once the
selector is rewritten, a naive text diff flags every single rule as "changed" — the noise drowns the signal;
doing this precisely would require a CSS parser plus selector normalization, which costs far more than letting a
small model read through it line by line, **and the parser's own edge cases become a new source of bugs** —
a review tool that false-alarms always ends up getting turned off.

**Criterion: if extraction and normalization can be scripted → script it. If the comparison itself needs to be
read line by line but doesn't need judgment → give it to a small model. If it's "is this change correct" →
keep it for yourself.** The same review job often spans all three layers — split it up, don't hand the whole
thing to one side.

What the third layer caught in that round, that the first two missed: when a global class was retired, it carried
two declarations (`text-decoration: none`, `cursor: pointer`) that **nobody picked up** — and neither one would
turn any test red. Layer one checked "did anything cross scope," layer two checked "do the two lists match" —
neither ever asks "who's affected when this declaration disappears."

### Have pi fix its own mistakes, but keep verification outside — automate the "patch round"

If the "add a patch round" idea from the previous section always means a human pastes the failure message,
hand-writes the task book, and manually dispatches it, that overhead is enough to make people just skip it —
and then the salvageable part of a red result gets thrown away wholesale. **It should be a script.**

The intuitive approach is **give pi bash and let it run the tests itself.** Don't. Two reasons:

1. Earlier in this document: given bash, it will keep wandering with `ls`/`cat` instead of ever editing
   (43 reads / 0 writes / timed out). That measurement was taken on "exploratory test writing" — the risk on
   "edit exactly the named file per a table" might be much lower — **but it hasn't been measured, so don't bet on it.**
   (Tried once on 2026-08-20: 10-minute timeout, 0 writes, 0 bash calls, file untouched by a single character;
   **but that run was contaminated** — it was dispatched while a queue of 29 tasks was running at concurrency
   width 8, as the 9th concurrent request, and got starved by the 8 ahead of it. So that run proves nothing —
   it just means there's still no answer.)
2. **Its self-reported "tests passed" cannot be trusted.** The same model runs it, judges it, and reports it —
   all three steps are in its own hands. Running it once outside costs nothing worth mentioning.

The following shape makes that question moot in the first place: **verification runs outside, the patching is pi's job.**

```bash
# scripts/pi-verify-fix.sh <target-file> <test-paths...>
for round in 1 2 3; do
  OUT="$(npx vitest run "${TESTS[@]}" 2>&1)"
  FAILS="$(printf '%s' "$OUT" | grep -E '^ *× |AssertionError|expected .* to ' | head -20)"
  [ -z "$FAILS" ] && { echo "PASS (round $round)"; exit 0; }
  [ "$round" -eq 3 ] && { echo "FAIL (still red after two patch rounds, hand to a human)"; printf '%s\n' "$FAILS"; exit 1; }

  cat > "FIX-$NAME-$round.md" <<EOF
# Task
\`$TARGET\` was just changed and tests are failing. Fix them.

## Do these three things, in order
1. read \`$TARGET\`
2. **edit \`$TARGET\`**
3. output DONE

## Failure messages
\`\`\`
$FAILS
\`\`\`

## Absolutely do not
- **Do not touch a single already-passing test.** You cannot see them; any "quick tidy" is a risk.
- **Do not edit the test file.** The tests describe what this file should look like; if they're red, this file is wrong.
- Do not add anything the failure messages didn't mention.
- You are forbidden from reading any file other than \`$TARGET\`, and forbidden from creating any new file.
EOF
  bash dispatch-pi.sh "FIX-$NAME-$round.md" "/tmp/fix-$NAME-$round.json" >/dev/null 2>&1
done
```

Four details, each one mapping to a pothole actually hit:

- **Paste only the failing lines, not the whole output.** A full vitest run's output has hundreds of lines of
  stack trace, and that eats its attention whole — the same thing `--no-context-files` is meant to prevent.
- **"Do not edit the test file" has to be written explicitly.** The path of least resistance to passing is
  rewriting the assertion, and that will silently pass every check. (Same logic for "do not edit product code" —
  pick whichever sentence fits the task.)
- **"Do not touch a single already-passing test" needs its reason spelled out** ("you cannot see them"). A bare
  prohibition it will follow, but a prohibition with a reason it follows more reliably.
- **Two rounds max, then hand it to a human.** What doesn't get fixed by then usually isn't a mechanical problem —
  that's exactly what the third layer is for.

The batch version (`pi-verify-fix-all.sh`) does one more thing: **explicitly separates "passed," "still red," and
"no tests to verify against."** The third category has to be listed out, not counted as verified — those files'
gatekeeping falls entirely on type-checking, build, and human eyes, and lumping them into the "passed" pile is the
easiest way this whole pipeline fools itself.

**Don't run this round in parallel.** Not because of pi — because of vitest: running two vitest processes at once,
red count in this repo jumps from 4 to 27 (`process.env` interference across files), and the result becomes unreadable.

### "Timed out" doesn't mean "did nothing" — check whether the file moved first

Measured (2026-08-20, a batch of 29 conversion tasks): two hit `timeout 1500`, and their states were **not the same**:

| Task | File state | Handling |
|---|---|---|
| A | **Unmodified** | Clean, just redo it |
| B | **Modified** | **Half-edited** |

Half-edited is what timeout actually endangers. This class of edit is two steps (add a utility + remove the
matching CSS declaration); if it deleted the declaration but got cut off before adding the utility, **that style
silently disappears** — type-check passes, build passes, tests pass, and only measuring computed style or a human
eye catches it.

So the first move after a timeout is `git status -- <target-file>`, not re-dispatching.
**Anything already modified should always be `git checkout`-reverted before redoing it** — never stack a second
round on top of a half-finished one. The second round sees a file with some declarations already gone and will
assume they never existed.

### The size limit isn't just line count — it's also "how much has to be produced"

The earlier limit in this document was about **source file line count** (27–75 lines went smoothly, 250 lines took
5 minutes, 1044 lines timed out) — that limit measures "how many characters have to be read before it can start
working."

There's a second limit, measuring **output**: those two timed-out tasks had source files of 149 and 470 lines —
well inside the 700-line boundary — but the number of declaration types they had to convert was 36 and **61**,
and each type meant editing one spot in the markup and deleting one line of CSS. The output volume blew the budget.

**Watch both limits: input by line count, output by "how many spots need changing."** Past about 30 spots, split
the task — or, if the transformation is deterministic, write it as a script instead, which is cheaper and more
reliable than splitting.

### A large mechanical refactor breaks every guard that "scans for the old pattern" — in both directions

(The "write a script for a deterministic transformation, don't dispatch it" rule is criterion zero from the top of
this document — not repeating it here.)

This section is about what happens **after** the refactor, and it's more easily missed than the refactor itself.

Example: a repo had a guard rule requiring "any file that removes a link's underline must be registered in a
manifest with a reason." It detects this by scanning CSS for `text-decoration: none`. The refactor moved those
into a `no-underline` markup utility, so:

| Direction | Symptom |
|---|---|
| **Missed detection** | Any file rewritten to use the utility now slips past the manifest requirement entirely — the guard stays green |
| **False positive** | **Correct** entries already in the manifest get judged as stale, "this no longer applies" |

The second direction is the one that got discovered (a test went red). **The first direction would never have
been noticed on its own**, and it's the entire reason that guard exists.

The same round had three more tests go red over the same underlying issue, all the same shape — they assert
against **source-code strings**:

    /<ul class="picks">/                 → adding the utility to the class attribute breaks this match
    ruleOf(src, '.section')              → that whole rule no longer exists
    ruleOf(src, '.body') containing var(--font-mono) → moved into the font-mono utility

**There are two ways to handle this, and picking the wrong one grows a bad habit:**

- ✅ **Rewrite it to check "where the intent now lives"**: read the rendered DOM, or read the markup's class list.
  `<ul class="picks">` becomes `container.querySelector('ul.picks')` plus `querySelectorAll('ol')` returning 0 —
  that's the actual intent, "this must not auto-number."
- ❌ **Loosen the regex until it passes.** That leaves it able to go red from any unrelated change from then on,
  and every time it goes red someone loosens it again.

**And if a guard has two use sites — "scan" and "cross-check the manifest" — that decision logic has to be
factored into one function**, so it recognizes both the old and new pattern at both sites. Writing it twice means
only one side gets fixed — the false-positive side (because it goes red), while the missed-detection side stays silent.

### When a dispatch deletes a comment, something still alive might be in it

Large refactors correctly delete a lot of comments that "describe something that no longer exists." But the same
comment block often has **a still-live warning mixed in**, and a small model (like a rushed human) will delete the
whole block.

Example: a comment block explaining "the hue token for each node type" — the first half described CSS that had
since been retired, but the second half was a still-live warning: "having this written in three separate places
means the legend's starting point is green while the minimap's is grey." That sentence describes **two sources
that still exist today** (CSS can't import TS constants).

**The right cleanup move isn't to relocate that sentence into another comment — it's to turn it into something
that goes red.** A test now asserts that the `stroke` in the CSS equals that TS constant, falsified (change it to
a different value and it goes red). The comment will vanish again in the next refactor; the test won't.

Add a line to the review checklist: **among the comments deleted this round, is there one describing something
that's still true?**

### Writing the same criterion twice guarantees one of them is wrong

The root cause behind that generator defect above is worth recording on its own: **the criterion "which selectors
are convertible" was written twice** — once in the task-book generator, once in the deterministic script. The
script's version was correct from the start (single class only); the generator's version missed pseudo-classes
and compound selectors.

**Two out-of-sync criteria are harder to catch than one wrong one**, because each side looks reasonable on its
own. Once you have both a "dispatch route" and a "script route," the criterion they share has to be factored into
**one place** (one module, one function), with a test holding both sides in sync.

**And this same thing happened a second time in the same round**, so the rule needs to be stronger than the
sentence above.

The second instance was **inside the deterministic script itself**: it needed to "find elements carrying a given
class." Counting used exact token matching (correct); writing used a word-boundary regex — and **word boundary
holds at a hyphen**, so searching for `body` also matched `class="warn-body"`. The result: `.body`'s styles got
written onto the `.warn-body` element — the two elements' styles half swapped, and type-check, build, and unit
tests **all passed** (the class string is perfectly legal, just attached to the wrong element).

**Rule: the moment a criterion has two use sites, factor it into one function. No exceptions, no matter how short
it is.** "It's just a one-line regex" is exactly why it gets written a second time — and gets it wrong the second time.

How that one got caught: while tracking down a failing test, comparing against `git show HEAD:<file>` for what
that rule originally had turned up that `.warn-body` had only three declarations at HEAD and was now carrying six
utilities that didn't belong to it. **"Diff against HEAD" is the general-purpose x-ray for this whole class of
bug**, because it asks "did anything land somewhere it shouldn't have" — the one question none of the automated
checks ever ask.

### A model that won't stop exploring? Take the tools away, don't just tell it

Some models explore compulsively: the task book states in plain writing "no glob, no grep," and it still does
36 reads, 6 globs, 4 greps, **0 writes**. Take glob/grep away via `--tools` and it **routes around it** — switches
to bash's `ls`/`cat` and keeps searching, 104 bash calls, still 0 writes.

What works is **giving it only read and write**, not even bash:

```bash
omp -p "..." --tools read,write --thinking off ...
```

Same model, same task, and it immediately produces 190 lines and 9 tests.

This requires taking "run the tests" away from the agent and handing it to the driver — but **that was always the
driver's job** (see "verification happens outside the model" above), so this isn't a compromise, it's putting the
responsibility back where it belongs. The cost is the agent can't self-verify, and what it hands back is redder
than before (measured: 5 of 9 red), picked up by the patch round.

**General rule: when a model won't listen, change what it's capable of, don't strengthen the wording.**
Prohibitions have no grip on "behaviour shaped wrong"; taking away the tool does.

### Don't throw away a whole failed run — add a patch round

**An all-or-nothing verdict throws away most of the value.** Measured: one output had **13 of 16** tests passing,
and got judged a failure and discarded whole because 3 were red. That's not "50% success rate" — that's throwing
80% of the result in the trash.

The tests that fail are usually a small model's wrong assumption about the environment (didn't await a promise,
guessed the wrong object shape), and **fixing is much cheaper than rewriting.** So when verification fails, add
one more round:

```
# Patch task
Some tests in <test-file> are failing. Fix them, or delete outright any that can't be fixed.

## Absolutely do not touch
- Do not change a single already-passing test.
- Do not change a single line of product code. If a test's assumption is wrong, fix the test, not the code.

## Failure messages
<paste only the failing lines, not the whole output>
```

"Do not touch product code" matters **especially** in the patch round: the small model's path of least resistance
is to break the code under test to suit the test, and that will silently pass every check.

Always treat the output as a **draft**: a small model follows instructions selectively (measured: the test logic
was entirely correct, but the explicitly required Traditional Chinese comments were simply ignored). Have a human
look before merging.
