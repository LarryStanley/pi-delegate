# Choosing a Harness and a Model

**When to read this**: timeout with zero output, `--thinking off` seemingly not taking effect, or picking a model or a quantization build.

Core idea: **ask "how much does this harness stuff into the model" before you ask "which model is stronger"** —
getting that order backwards will judge a genuinely usable model as unusable.

← back to `SKILL.md` (the four-way split and the discipline table)

## Pick the harness first, then the model — this order cannot be reversed

**The harness's weight determines which models can even work.** Same model, same task, same endpoint, only the harness changed:

| Harness | Tool count | Result on Qwen3.8-27B |
|---|---|---|
| omp (oh-my-pi) | ~31, plus the whole todo-lifecycle / delegation / review system-prompt apparatus | **600-second timeout, 0 writes** |
| **pi** (`@earendil-works/pi-coding-agent`) | **4** (read/bash/edit/write) | **867 seconds, 12/12 tests green, 100% coverage** |

I spent hours on omp making two genuinely correct fixes for this model (turn off server-side thinking, give it
only read/write) just to squeeze out 4 green out of 9. **Switch to pi, no special configuration at all, and it's
all green on the first try.**

The reason isn't mysterious: those heavyweight harnesses are designed for frontier models. Schemas for 31 tools
plus a long behavioural spec eat a small model's attention whole, and it degrades into "describe in text what I'm
about to do" instead of actually doing it.

**So ask "how much does this harness stuff into the model" before "which model is stronger."** The former often
directly determines the answer to the latter — because I had this order backwards, I once judged a genuinely
capable, up-to-date model as unusable.

(The 12B tier failed on **both** harnesses, so the size floor is real, independent of the harness.)

## Picking a model: look at the thinking/output ratio, not parameter count

Measured on the same task, same task book (2026-08-15):

| Model | Seconds | Thinking tokens | Write calls | Result |
|---|---|---|---|---|
| Qwen3.8-27B (dense, 4bit) | 600+, timeout | ~3600 | **0** | No output |
| **Qwen3.6-35B-A3B (MoE, 3B active)** | **178–227** | ~300 | 6–9 | **9/9 tests green** |
| gemma-4-12b-coder (8bit) | 12–43 | ~60 | **0** | Never touched the file in this harness (see below) |

Three things:

1. **The MoE with the larger total parameter count is 3×+ faster** — only a handful of experts activate per
   token, and it doesn't burn its budget talking to itself.
2. **A thinking-first model doesn't fit an agent loop.** It can't stop thinking long enough to ever emit a tool call.
3. **The 12B tier can't survive a full agent system prompt, regardless of finetune flavor.**
   Measured (same task, same task book):

   | Model | Seconds | Tool calls | Output |
   |---|---|---|---|
   | gemma-4-12b-**coder** | 12–43 | 0 | ✗ |
   | gemma-4-12B-**it** (plain instruct, same size, control) | 14 | 0 | ✗ |
   | gemma-4-**26B-A4B** (MoE) | 271 | 38 | **✓** |

   Switching to the plain instruct build didn't help; going to 26B brought it to life — so **don't rule out a
   model with "the coder finetune can't use tools," that's the wrong attribution.**

   Evidence: hitting the endpoint directly with that same 12B, with 1/2/25 tools, a long system prompt, strict
   mode, parallel calls — it correctly returned native `tool_calls` in **every** case. It has tool-calling
   capability. But under the harness's full system prompt (todo lifecycle, delegation rules, review flow…), its
   attention gets eaten whole and it degrades into "describe in text what I'm about to do" — emitting a
   ```` ```json ```` block or Python pseudocode that the harness never sees as a tool call.

   **A capability problem and a wiring problem produce the identical symptom (zero output) — to tell them apart:**
   hit the same model directly at the endpoint with a `tools` array. Returns text → wiring/dialect problem, fix
   the harness. Returns `tool_calls` but still won't act inside the harness → the model can't survive this
   prompt, go bigger.

   As an aside, `tools.format native` is **ineffective** for this (measured), because the problem isn't the transport format.

### Different builds of the same base model need picking too — the gap is not smaller than switching models

Once the model is chosen there's another layer: **the same base model often has multiple quantization/decoding
builds**, and a long-output scenario like dispatch feels the difference.

Measured (`omp bench --runs 3 --par 1 --max-tokens 512`, 2026-08-19):

| Build | TTFT | Generation throughput | Total time |
|---|---|---|---|
| **Qwen3.8-27B-oQ4e-mtp** | 901ms | **53.8 tok/s** | **9.5s** |
| Qwen3.8-27B-4bit | **711ms** | 35.1 tok/s | 14.6s |

Both are the same base model, the same quality tier (dense 27B, in the "accurate but slow" class), differing only
in MTP (multi-token prediction) decoding. **Generation throughput is about 1.5×, but TTFT is actually slightly
worse** — MTP's draft carries a fixed overhead. So a short-response interactive scenario barely notices, and
**only long output and dispatch actually feel the benefit.**

**Dispatch defaults to `Qwen3.8-27B-oQ4e-mtp` (dense).** Every configuration example below assumes it.
`~/.pi/agent/settings.json`'s `defaultModel` is also set to it, so forgetting `--model` lands on the right default.

**Don't downgrade this default just because "this task is small."** The "when either one works" section below
reads at first like "give small things to the fast model" — measurement shows that doesn't hold for **editing an
existing file**, reasons at the end of that section.

⚠️ Numbers in other files' tables labelled `Qwen3.8-27B-4bit` were **measured on that specific build** — don't
carry them over to oQ4e-mtp. Both sit at the same quality tier, but the seconds don't transfer between them.

### When either one works: give volume to the fast one, hard cases to the accurate one

Same harness (pi), same task, two usable models — the gap is a **trade-off**, not one being strictly better:

| | MoE 35B-A3B | Qwen3.8-27B (dense) |
|---|---|---|
| Time | **157s** | 867s (5.5×) |
| Test count | 5 | **12** |
| Line coverage | 81% | **100%** |
| Branch coverage | 67% | **100%** |
| Follows style instructions | Partially | **Fully** |

The MoE is five times faster but **misses a third of the branches.** So split the dispatch queue in two: give the
fast model large, simple targets; give the accurate model targets where coverage matters, and anything that
failed on the first pass.

(n=1, single file. Trust the direction, not the exact numbers.)

#### But "volume" does not include editing an existing file — that cell always goes to dense

The split above only holds for **writing a brand-new file** (greenfield, e.g. a whole test file from scratch).
**Don't hand an existing-file edit to the MoE**, no matter how small the task is.

Measured (2026-08-19, grill-me's token refactor): same task book, same harness, same endpoint, the task was
"insert one line, `'dg-grid',`, into an array" — **about as small an edit as you can imagine:**

| Model | Event breakdown | Result |
|---|---|---|
| Qwen3.6-35B-A3B-4bit (MoE) | 28 read / 12 write / **4 execute** | ✗ Target file untouched — instead generated `list-superpowers.sh` and `search.ps1` at the repo root |
| **Qwen3.8-27B-oQ4e-mtp (dense)** | **2 read / 1 edit** | **✓ correct on the first try** |

Those two generated files contained `dir /s /b` and `Get-ChildItem -Recurse` — **directory-listing scripts.**
I never gave it the `execute` tool at all (only `read,write,edit`) — it invoked it on its own.

**So this is an important addendum to the "take the tools away" section: removing bash only blocks half the
problem.** That section said the model routes around it with `ls`/`cat`, on the premise that it still has bash;
**once bash is also gone, it treats `write` as a substitute for bash and writes itself a script instead.**
The symptom isn't zero output — it's **extra files you never asked for, and the target file completely untouched**
— and the exit code is 0, self-reported success.

This is a variant of "degrades into describing in text what it's about to do": instead of a ```` ```json ````
block, it's a `.sh` / `.ps1` file.

**Criterion: task touches an existing file → dense. Task is writing a brand-new file from zero → only then is
trading to a MoE for speed worth considering.** The few minutes saved aren't worth a redispatch round, especially
since redispatching means first finding and deleting the garbage files it wrote — that cleanup cost never shows
up in the seconds table above.

### Health indicators (a 30-second call on whether to switch models)

Run once with `--mode json`, count events:

```bash
grep -c thinking_delta events.json                    # how much thinking
grep -o '"name":"[a-z_]*"' events.json | sort | uniq -c  # tool-call distribution
```

⚠️ **Both numbers need to be divided by the event multiplier first, or you'll diagnose a problem that doesn't exist.**
Each tool call under `--mode json` fires **several** events (call, arguments, result…) — measured, pi emits
**roughly 3–4 events per call.** So a `uniq -c` count of "12 reads" might just be **4 files, each read once.**

Calibrate before you read the numbers, by looking at **which** files it read, not how many times:

```bash
grep -o '"path":"[^"]*"' events.json | sort | uniq -c   # count per file → that count is your multiplier
```

If the files that show up are exactly the ones named in the task book, and the counts are consistently uniform,
that's normal work, not wandering. Genuine wandering looks like **files that were never named** showing up, or
counts far exceeding the file count.

I've hit the consequence of skipping calibration: read "4 files, each read once" as "12 reads, 0 writes," and
nearly switched models by the rule below — when it was actually generating a 250-line file normally.

**Thinking past a thousand and `write` at 0 → switch models, don't tune parameters.**
Many `read`s and `write` at 0 → the task book didn't shut off exploration
(the fix is **removing the tool**, not stronger wording — see `references/verifying.md`).

This indicator is more reliable than any error message, because a stuck agent **doesn't error out** — it just times out.

## `--thinking off` might be a no-op — verify it, don't trust it

Once you've measured thinking past a thousand, the first move is turning it off. But **setting the flag doesn't
guarantee it worked.** Two distinct failures measured, identical symptoms (thinking past a thousand, `write` at
0, timeout), completely different causes:

| Failure | What happened | How to tell |
|---|---|---|
| **Switch never wired up** | The model config never declares `reasoning`, so the harness's entire thinking-control block is skipped, not a single parameter gets sent, and the endpoint falls back to its own default | `pi --list-models`'s reasoning column reads `no` |
| **Wrong key name** | The harness sent `reasoning_effort`, but the endpoint only honours `chat_template_kwargs.enable_thinking` | Record the request body with a logging proxy, or hit the endpoint directly for comparison |

The first is especially insidious: in pi's `pi-ai/dist/api/openai-completions.js`, **every single** thinking
branch is gated behind the `model.reasoning` condition. Without that declaration, nothing gets sent at all —
`--thinking off` produces no error, no warning, it just does nothing.

### Diagnosis: hit the endpoint directly, measure `reasoning_content` length

Don't guess — two curl calls give you the answer: send with and without the candidate off-key, compare
`reasoning_content` length:

```bash
curl -s "$BASE/chat/completions" -H "Content-Type: application/json" \
  -d '{"model":"'"$M"'","max_tokens":120,
       "messages":[{"role":"user","content":"1+1=?"}],
       "chat_template_kwargs":{"enable_thinking":false}}'
```

Measured on Qwen3.8-27B (MLX endpoint):

| Parameter sent | Reasoning length | Content length |
|---|---|---|
| Default (nothing sent) | 97 | 1 |
| `chat_template_kwargs.enable_thinking=false` | **0** | 13 |
| `thinking_token_budget=64` | 216 | 185 (**completely ineffective**) |

The last row is the important one: **don't assume the middle-ground option, "cap thinking length," exists.**
pi has `compat.supportsThinkingTokenBudget` (sends a top-level `thinking_token_budget`), and the source comment
describes exactly this symptom — but this particular endpoint just doesn't honour that parameter, and turning it
on only buys false confidence. Endpoints like this are a binary switch, no middle setting.

The same key works just as well on Qwen3.6-35B-A3B (MoE): default reasoning 443 chars / content 5 chars,
0/9 once turned off. **A MoE thinking less by default doesn't mean it doesn't need to be turned off.**

### Config: pi (`~/.pi/agent/models.json`)

Both fields are required, neither is optional:

```json
{
  "id": "Qwen3.8-27B-oQ4e-mtp",
  "contextWindow": 262144,
  "maxTokens": 32768,
  "reasoning": true,
  "compat": {
    "thinkingFormat": "chat-template",
    "chatTemplateKwargs": {
      "enable_thinking": { "$var": "thinking.enabled" }
    }
  }
}
```

- `reasoning: true` is the **master switch**, not a descriptive label meaning "this model can think." Without
  it, the compat block below never executes at all.
- `$var: thinking.enabled` resolves to `!!reasoningEffort`: `--thinking off` → `false`, any other level → `true`.
  This is a **live switch**, better than hardcoding `false` — a hard target can still opt back into thinking.
- Don't use `thinkingFormat: "qwen-chat-template"` — it sends an extra `preserve_thinking`. Only send the one key you've verified.

### Config: omp (`~/.omp/agent/models.yml`)

omp has no equivalent of the `$var` mechanism, so it has to be hardcoded:

```yaml
- id: Qwen3.8-27B-oQ4e-mtp
  compat:
    extraBody:
      chat_template_kwargs:
        enable_thinking: false
```

The cost: this model never thinks under omp, `--thinking` has no effect on it at all. Fine for pure dispatch use.

### Verification: run a real task, check both directions

Don't trust the config once changed — run it once and count events:

```bash
pi -p "Create a file named hello.txt containing exactly: hello" \
  --provider <provider> --model <model> --thinking off \
  --tools read,write --no-session --no-context-files --no-skills --no-extensions \
  --mode json > events.json 2>&1
grep -c thinking_delta events.json
```

Measured on Qwen3.8-27B:

| | thinking_delta | Tool calls |
|---|---|---|
| `--thinking off` | **0** | write ×4 |
| `--thinking high` | 26 | read ×4 + write ×4 |

**Check both directions.** Running only the "off" case and seeing 0 can't distinguish "the switch works" from
"the config is wrong so it's permanently off" — and the latter will silently deceive you the moment you actually
want high-precision mode.

As an aside, the 4 extra reads in the "high" run are the compulsive exploration. Dispatch always carries `--thinking off`.
