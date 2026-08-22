# Small Models: What the Field Reports

**When to read this**: choosing or replacing the model behind `pi`, sizing hardware for it, or working out why a
local model that benchmarks well still falls apart inside an agent loop.

Everything here is **secondhand** — published guidance and papers, collected 2026-08-22. None of it was measured
through `pi` on your endpoint, with your task books. Treat it as a way to shortlist candidates and to know what to
watch for, then run the bake-off yourself: every source below says the same thing about its own numbers, which is
that your tools, your prompts and your failure modes are not the ones they measured.

`choosing-models.md` is the companion file for what you find out that way.

---

## The one number that reframes everything: failure compounding

Per-call reliability multiplies across agent steps. At **95% well-formed tool calls**, an eight-step loop
completes about **66%** of the time.

That single line explains more agent failures than model choice does. A model that looks near-perfect in a
one-shot benchmark is a coin flip over a long horizon, and the fixes are structural rather than a better model:

- **Shorter horizons.** Fewer steps per dispatch beats a smarter model at the same step count.
- **A verdict you can check.** Which is what `pi_result` and your own acceptance test are for.
- **Idempotent, re-dispatchable tasks** — an aborted task should be safe to re-send unchanged.

Note the tension with this skill's sizing guidance, and resolve it the right way: *shorter horizon* means fewer
tool-call round trips, **not** less work per dispatch. Writing three files in one pass is not eight steps of risk;
it is one task whose output happens to be larger. Slicing it into three dispatches adds three fresh contexts and
three more chances to misread the contract. See the sizing section of SKILL.md.

## What degrades first as models shrink

The survey literature is consistent on the shape of the cliff: small models hold up on **schema- and
API-constrained** work and fall away on **open-ended reasoning and long-horizon planning**
([SLMs for Agentic Systems](https://arxiv.org/abs/2510.03847)).

That is a design instruction, not a limitation to work around:

- **Constrain the output.** Guided decoding, strict JSON Schema, validator-first execution — the paper reports
  these close much of the gap. A task book that fixes exact names and signatures is the same move in prose.
- **Keep judgment on your side of the line.** Deciding the contract is open-ended reasoning; filling it in is
  schema-constrained. That is the same split as the four-way table in SKILL.md, reached independently.
- **Expect to fall back** for genuinely open-domain work. Even the sources most enthusiastic about small models
  keep a larger model in the loop for planning.

## Model shortlist, and how much to trust it

Reported tool-call reliability, mid-2026, from
[a local tool-calling roundup](https://www.promptquorum.com/power-local-llm/best-local-models-tool-calling-2026):

| Model | Well-formed calls | ~VRAM @ Q4_K_M | Reported failure mode |
|---|---|---|---|
| Llama 3.3 70B | ~97% | ~42 GB | Slow per-token throughput |
| Qwen3-Coder 30B | ~96% code / ~91% non-code | ~18 GB | Weaker on non-code tools |
| Gemma 4 27B | ~95% | ~16 GB | Conservative about chaining calls |
| GLM-4.7 32B | ~94% | ~20 GB | Argument truncation on long inputs |
| Qwen3 32B | ~93% | ~20 GB | Rare XML malformation under strict formats |

**A filter, not a verdict.** None of these were run through `pi`, and the numbers come from one roundup. The
column actually worth reading is the failure-mode one: it tells you what to look for in your own bake-off.

Two claims recur firmly enough across sources to act on:

- **Below roughly 7B, tool calling does not work** regardless of harness — malformed output, not merely worse
  output. Several sources put the practical floor higher still.
- **A coder finetune is not automatically the tool-calling pick.** The roundup rates Qwen3-Coder highest on code
  and clearly lower off it. Finetune flavour is rarely the variable that decides whether a model can drive an
  agent loop at all; size and tool-call training are.

## Quantization: the floor is higher than it is for chat

**Q4_K_M (or an equivalent ~4-bit build) is the reported production floor. Q3 and Q2 degrade tool-calling before
they degrade chat quality** — so a build that still sounds fine in conversation can already be unable to emit a
well-formed call.

This may be the most immediately useful item here, because a 2-bit build is exactly what someone reaches for when
a model will not fit, and the damage lands on the one capability an agent depends on. Quantization cliffs are also
reported to be *model-family specific*, so test schema adherence and tool selection on the specific build rather
than trusting a bit-width.

## MoE vs dense: the memory nuance that gets skipped

A MoE's small active-parameter count buys speed, not a smaller machine. **All expert weights must be resident even
though only a fraction fire per token** — a 30B-A3B model needs 30B worth of memory, not 3B
([Epoch AI](https://epoch.ai/gradient-updates/moe-vs-dense-models-inference)).

The comparison usually quoted is that an 8-way sparse MoE has roughly the short-context inference economics of a
dense model **half its total size**, putting a 30B-A3B in the neighbourhood of a ~15B dense model rather than a 3B
one. Still an excellent trade for an agent loop — just do not size the machine off the active count.

Carry the counter-evidence too: dense models are reported to match or beat much larger MoEs specifically on tool
use and agentic tasks. Neither architecture wins by default.

## Context: retrieval beats a bigger window

The consistent advice is that **a large context window does not remove the need for retrieval**, and that loading a
whole repository into context collapses both speed and reliability
([agentic-coding roundup](https://www.kunalganglani.com/blog/best-local-model-agentic-coding)). Reported working
ranges: 8–32k effective context for a small repo with retrieval, 16–64k for medium, and retrieval as mandatory
beyond that regardless of the advertised window.

This is why `no_context_files` defaults to true, and why a task book naming the exact files beats letting the agent
explore. There is a throughput dimension as well: on local hardware, decode speed falls steadily as the KV cache
grows, so long context is not only less reliable but slower per token the whole way down.

## What to actually do

1. Shortlist from the table, weighted by the failure mode you can least afford.
2. Stay at ~4-bit or better, and verify schema adherence on the exact build.
3. Run the bake-off on your own repo, with `pi` and your own task books. Measure retries, tool-call failures, and
   whether patches apply — not benchmark scores.
4. Record what you find in `choosing-models.md`. Leave this file for other people's numbers.
