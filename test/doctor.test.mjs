import { test } from "node:test";
import assert from "node:assert/strict";
import { checkModels, fixModels, chatTemplateThinkingApplies, isLocalBaseUrl, THINKING_BINDING } from "../src/doctor.mjs";
import { DEFAULTS } from "../src/config.mjs";

// checkModels is an advisor, not a gate: it is handed "which model this dispatch will
// actually reach" and raises a problem only under conditions that genuinely hold. Every
// case passes its own selection; none of them touch this machine's real config files.
const sel = (provider, model, source = "pi settings.json") => ({ provider, model, source });
const patterns = { drafterPatterns: [...DEFAULTS.drafter_patterns] };

// The shape of a local OpenAI-compatible server (omlx, LM Studio, llama.cpp, vLLM, ...).
function localModels(models) {
  return {
    providers: {
      myprovider: { api: "openai-completions", baseUrl: "http://127.0.0.1:8000/v1", apiKey: "x", models },
    },
  };
}

// The shape of a hosted service (litellm, openrouter, OpenAI itself, ...).
function hostedModels(models, api = "openai-completions") {
  return {
    providers: {
      myprovider: { api, baseUrl: "https://api.example.com/v1", apiKey: "sk-x", models },
    },
  };
}

const withThinking = (id = "my-model") => ({
  id,
  reasoning: true,
  compat: { chatTemplateKwargs: { enable_thinking: { ...THINKING_BINDING } } },
});

// --- Configuring nothing is fine: that is the default path, not a to-do item ---

test("reports no problems when pi has no default model to resolve", () => {
  const { ok, problems, checks } = checkModels({ providers: {} }, sel(null, null), patterns);
  assert.equal(ok, true, JSON.stringify(problems));
  assert.equal(problems.length, 0);
  assert.equal(checks.chat_template_thinking, "skipped");
});

// models.json holds only user-defined providers; anthropic / openai / google are built
// into pi (the KnownProvider union at pi-ai types.d.ts:17) and never appear in that file.
// The old version reported provider-missing here, i.e. a fake error for every hosted user.
test("a provider absent from models.json is not a problem (it is most likely a pi built-in)", () => {
  const { ok, problems, checks } = checkModels({ providers: {} }, sel("anthropic", "claude-sonnet-4-6"), patterns);
  assert.equal(ok, true, JSON.stringify(problems));
  assert.ok(!problems.some((p) => p.code === "provider-missing"));
  assert.equal(checks.provider_in_models_json, false);
  assert.match(checks.chat_template_thinking_reason, /built-in/);
});

test("a model missing from a custom provider is not an error either (pi merges in built-in models)", () => {
  const { ok, checks } = checkModels(localModels([{ id: "other" }]), sel("myprovider", "my-model"), patterns);
  assert.equal(ok, true);
  assert.equal(checks.provider_in_models_json, true);
  assert.equal(checks.model_in_models_json, false);
});

test("checks report which model a dispatch will actually reach", () => {
  const { checks } = checkModels(localModels([withThinking()]), sel("myprovider", "my-model", "pi settings.json"), patterns);
  assert.equal(checks.provider, "myprovider");
  assert.equal(checks.model, "my-model");
  assert.equal(checks.source, "pi settings.json");
});

// --- The thinking binding applies only to a local openai-completions endpoint ---

test("a local openai-completions model missing reasoning and compat reports one problem each", () => {
  const { problems, checks } = checkModels(localModels([{ id: "my-model", name: "M" }]), sel("myprovider", "my-model"), patterns);
  assert.ok(problems.some((p) => p.code === "reasoning-missing"));
  assert.ok(problems.some((p) => p.code === "compat-missing"));
  assert.equal(checks.chat_template_thinking, "applied");
});

// This is the core false positive fixed in this round: a hosted provider controls thinking
// through its own API parameters, and chatTemplateKwargs is not even present in pi's
// AnthropicMessagesCompatSchema / OpenAIResponsesCompatSchema (only
// OpenAICompletionsCompatSchema has it, dist/core/model-registry.js:92). Reporting a
// problem to those users is one they can never fix.
test("a hosted anthropic provider does not report reasoning-missing / compat-missing", () => {
  const modelsCfg = hostedModels([{ id: "my-model" }], "anthropic-messages");
  const { ok, problems, checks } = checkModels(modelsCfg, sel("myprovider", "my-model"), patterns);
  assert.equal(ok, true, JSON.stringify(problems));
  assert.equal(checks.chat_template_thinking, "skipped");
  assert.match(checks.chat_template_thinking_reason, /anthropic-messages/);
});

test("a hosted openai-completions endpoint (litellm and friends) reports no thinking-binding problem either", () => {
  const { ok, problems, checks } = checkModels(hostedModels([{ id: "my-model" }]), sel("myprovider", "my-model"), patterns);
  assert.equal(ok, true, JSON.stringify(problems));
  assert.equal(checks.chat_template_thinking, "skipped");
  assert.match(checks.chat_template_thinking_reason, /api\.example\.com/);
});

test("with no api declared in models.json the thinking check is skipped rather than mis-reported", () => {
  const modelsCfg = { providers: { myprovider: { baseUrl: "http://127.0.0.1:8000/v1", models: [{ id: "my-model" }] } } };
  const { ok, checks } = checkModels(modelsCfg, sel("myprovider", "my-model"), patterns);
  assert.equal(ok, true);
  assert.equal(checks.chat_template_thinking, "skipped");
});

test("a local model that already has reasoning plus the binding is clean", () => {
  const { ok, problems } = checkModels(localModels([withThinking()]), sel("myprovider", "my-model"), patterns);
  assert.equal(ok, true, JSON.stringify(problems));
});

test("chatTemplateThinkingApplies decides correctly and explains why", () => {
  const local = { api: "openai-completions", baseUrl: "http://127.0.0.1:8000/v1" };
  assert.equal(chatTemplateThinkingApplies(local, { id: "m" }).applies, true);
  assert.equal(chatTemplateThinkingApplies({ api: "openai-responses", baseUrl: "http://127.0.0.1:8000/v1" }, { id: "m" }).applies, false);
  // A model's own api / baseUrl outranks the provider's (the order at model-registry.js:452-457)
  assert.equal(chatTemplateThinkingApplies(local, { id: "m", baseUrl: "https://api.example.com/v1" }).applies, false);
  assert.equal(chatTemplateThinkingApplies({ baseUrl: "http://127.0.0.1:8000/v1" }, { id: "m", api: "openai-completions" }).applies, true);
});

test("isLocalBaseUrl recognises loopback and private ranges, but not hosted domains", () => {
  for (const url of ["http://127.0.0.1:8000/v1", "http://localhost:1234/v1", "http://192.168.1.9:8080/v1", "http://10.0.0.4/v1", "http://box.local:8000/v1"]) {
    assert.equal(isLocalBaseUrl(url), true, url);
  }
  for (const url of ["https://api.openai.com/v1", "https://api.anthropic.com", "https://litellm.example.com/v1", "", null, "not-a-url"]) {
    assert.equal(isLocalBaseUrl(url), false, String(url));
  }
});

// --- Co-pilot guard: warn about the model about to be dispatched to, never edit the user's file ---

test("a model about to be dispatched to that matches a drafter pattern reports drafter-selected", () => {
  const { ok, problems } = checkModels(localModels([{ id: "my-model-DFlash-draft" }]), sel("myprovider", "my-model-DFlash-draft"), patterns);
  assert.equal(ok, false);
  const problem = problems.find((p) => p.code === "drafter-selected");
  assert.ok(problem);
  assert.equal(problem.fixable, false, "the user picks the model; we do not silently rewrite their models.json");
});

test("other drafter models that exist but were not selected stay quiet", () => {
  const modelsCfg = localModels([withThinking(), { id: "my-model-draft" }]);
  const { ok, problems } = checkModels(modelsCfg, sel("myprovider", "my-model"), patterns);
  assert.equal(ok, true, JSON.stringify(problems));
});

test("an empty drafter_patterns list disables the co-pilot guard entirely", () => {
  const modelsCfg = localModels([{ id: "my-model-draft", ...withThinking("my-model-draft") }]);
  const { ok } = checkModels(modelsCfg, sel("myprovider", "my-model-draft"), { drafterPatterns: [] });
  assert.equal(ok, true);
});

// --- fixModels repairs exactly one thing it can be sure about ---

test("after fixModels adds reasoning and the enable_thinking binding, checkModels is clean", () => {
  const before = localModels([{ id: "my-model", name: "M" }]);
  const fixed = fixModels(before, sel("myprovider", "my-model"));
  const model = fixed.providers.myprovider.models.find((m) => m.id === "my-model");
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.compat.chatTemplateKwargs.enable_thinking, { $var: "thinking.enabled" });
  const { ok, problems } = checkModels(fixed, sel("myprovider", "my-model"), patterns);
  assert.equal(ok, true, JSON.stringify(problems));
});

test("fixModels does not mutate the object it was given", () => {
  const before = localModels([{ id: "my-model" }]);
  const snapshot = JSON.stringify(before);
  fixModels(before, sel("myprovider", "my-model"));
  assert.equal(JSON.stringify(before), snapshot);
});

// The old version inserted two hardcoded Qwen ids into models.json out of thin air, which
// for anyone without that server is manufacturing configuration that can never connect.
// Now it reports what is missing and invents nothing.
test("fixModels invents no provider and inserts no unregistered model", () => {
  assert.deepEqual(fixModels({ providers: {} }, sel("myprovider", "my-model")), { providers: {} });
  const fixed = fixModels(localModels([{ id: "other" }]), sel("myprovider", "my-model"));
  assert.deepEqual(fixed.providers.myprovider.models.map((m) => m.id), ["other"]);
});

test("fixModels adds nothing at all for a hosted provider", () => {
  const fixed = fixModels(hostedModels([{ id: "my-model" }], "anthropic-messages"), sel("myprovider", "my-model"));
  const model = fixed.providers.myprovider.models.find((m) => m.id === "my-model");
  assert.equal(model.compat, undefined);
  assert.equal(model.reasoning, undefined);
});

// The old version wrote an x-pi-delegate-forbidden field, which pi does not recognise, into
// the user's models.json. The co-pilot guard now matches patterns at dispatch time instead,
// so there is no reason to touch anybody's file.
test("fixModels adds no custom field to other models", () => {
  const fixed = fixModels(localModels([{ id: "my-model" }, { id: "my-model-draft" }]), sel("myprovider", "my-model"));
  const drafter = fixed.providers.myprovider.models.find((m) => m.id === "my-model-draft");
  assert.deepEqual(Object.keys(drafter), ["id"]);
});

test("fixModels preserves other existing providers", () => {
  const before = localModels([{ id: "my-model" }]);
  before.providers.litellm = { api: "openai-completions", baseUrl: "https://example/v1", models: [] };
  const fixed = fixModels(before, sel("myprovider", "my-model"));
  assert.ok(fixed.providers.litellm);
});

test("fixModels changes nothing when there is no resolvable provider / model", () => {
  const before = localModels([{ id: "my-model" }]);
  assert.deepEqual(fixModels(before, sel(null, null)), before);
});
