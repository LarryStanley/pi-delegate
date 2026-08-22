import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configPath, piSettingsPath, loadConfig, saveConfig, loadPiDefaults,
  resolveModelSelection, isDrafterModel, DEFAULTS, PLUGIN_DEFAULTS, DEFAULT_TIMEOUT_S,
} from "../src/config.mjs";

function tmpJson(name, body) {
  const file = join(mkdtempSync(join(tmpdir(), "pi-delegate-cfg-")), name);
  if (body !== undefined) writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  return file;
}

test("configPath points at ~/.claude/pi-delegate/config.json", () => {
  assert.match(configPath(), /\.claude[/\\]pi-delegate[/\\]config\.json$/);
});

test("piSettingsPath points at ~/.pi/agent/settings.json", () => {
  assert.match(piSettingsPath(), /\.pi[/\\]agent[/\\]settings\.json$/);
});

// Having no config.json is the normal state, not a to-do item: provider / model being
// null means "emit no flag, let pi resolve it".
test("with no config file, provider and model are null and the rest are the measured defaults", () => {
  const cfg = loadConfig(tmpJson("config.json"));
  assert.equal(cfg.provider, null);
  assert.equal(cfg.model, null);
  assert.equal(cfg.timeout_s, DEFAULT_TIMEOUT_S);
  assert.equal(cfg.thinking, "off");
  assert.equal(cfg.tools, "read,write,edit");
  assert.equal(cfg.no_context_files, true);
  assert.equal(cfg.append_system_prompt, null);
  assert.deepEqual(cfg.drafter_patterns, [...DEFAULTS.drafter_patterns]);
});

test("a corrupt config file degrades to the defaults instead of throwing (same scheme as modes.mjs load())", () => {
  const cfg = loadConfig(tmpJson("config.json", "{ not json"));
  assert.equal(cfg.provider, null);
  assert.equal(cfg.timeout_s, DEFAULT_TIMEOUT_S);
  assert.equal(cfg.thinking, PLUGIN_DEFAULTS.thinking);
});

test("a config file holding an array also degrades to the defaults", () => {
  assert.deepEqual(loadConfig(tmpJson("config.json", "[1,2,3]")).drafter_patterns, [...DEFAULTS.drafter_patterns]);
});

test("any provider / model the user configured is read back", () => {
  const cfg = loadConfig(tmpJson("config.json", { provider: "ollama", model: "qwen3:8b", timeout_s: 300 }));
  assert.equal(cfg.provider, "ollama");
  assert.equal(cfg.model, "qwen3:8b");
  assert.equal(cfg.timeout_s, 300);
});

test("an invalid timeout_s or thinking level falls back to the default", () => {
  const cfg = loadConfig(tmpJson("config.json", { timeout_s: -5, thinking: "maximum" }));
  assert.equal(cfg.timeout_s, DEFAULT_TIMEOUT_S);
  assert.equal(cfg.thinking, "off");
});

// null is a meaningful value here: "do not emit this flag, let pi decide". It must not be
// conflated with "not written at all".
test("thinking / tools set to null mean the flag is not emitted", () => {
  const cfg = loadConfig(tmpJson("config.json", { thinking: null, tools: null }));
  assert.equal(cfg.thinking, null);
  assert.equal(cfg.tools, null);
});

test("drafter_patterns can be set to an empty array to switch the guard off", () => {
  assert.deepEqual(loadConfig(tmpJson("config.json", { drafter_patterns: [] })).drafter_patterns, []);
});

test("saveConfig overwrites only the fields passed in and keeps the rest", () => {
  const file = tmpJson("config.json");
  saveConfig({ provider: "lmstudio", model: "m1" }, file);
  saveConfig({ model: "m2" }, file);
  const cfg = loadConfig(file);
  assert.equal(cfg.provider, "lmstudio");
  assert.equal(cfg.model, "m2");
  assert.equal(cfg.timeout_s, DEFAULT_TIMEOUT_S);
});

test("saveConfig writes readable JSON", () => {
  const file = tmpJson("config.json");
  saveConfig({ provider: "openai", model: "gpt-x", timeout_s: 900 }, file);
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(parsed.provider, "openai");
  assert.equal(parsed.model, "gpt-x");
  assert.equal(parsed.timeout_s, 900);
  assert.ok(Array.isArray(parsed.drafter_patterns));
});

// --- Layer 3: pi's own defaults ---

test("loadPiDefaults reads defaultProvider / defaultModel out of settings.json", () => {
  const file = tmpJson("settings.json", { defaultProvider: "litellm", defaultModel: "DeepSeek-V4-Pro", theme: "dark" });
  assert.deepEqual(loadPiDefaults(file), { provider: "litellm", model: "DeepSeek-V4-Pro" });
});

test("loadPiDefaults returns nulls when settings.json is missing or corrupt", () => {
  assert.deepEqual(loadPiDefaults(tmpJson("settings.json")), { provider: null, model: null });
  assert.deepEqual(loadPiDefaults(tmpJson("settings.json", "{oops")), { provider: null, model: null });
});

// --- Three-layer resolution ---

test("with nothing specified anywhere, the selection is left to pi", () => {
  assert.deepEqual(resolveModelSelection({ config: DEFAULTS }), { provider: null, model: null, source: "pi" });
});

test("what the config specifies is used", () => {
  const config = { ...DEFAULTS, provider: "ollama", model: "qwen3:8b" };
  assert.deepEqual(resolveModelSelection({ config }), { provider: "ollama", model: "qwen3:8b", source: "override" });
});

test("call arguments override the config", () => {
  const config = { ...DEFAULTS, provider: "ollama", model: "qwen3:8b" };
  const got = resolveModelSelection({ provider: "anthropic", model: "claude-sonnet-4-6", config });
  assert.deepEqual(got, { provider: "anthropic", model: "claude-sonnet-4-6", source: "override" });
});

// pi's model-resolver.js:428 reads `if (cliProvider && cliModel)` — a lone flag is ignored
// as a pair. So when only one side resolves, the other is completed from pi's defaults.
test("when only model is given, provider is completed from pi's defaults", () => {
  const got = resolveModelSelection({
    model: "some-model",
    config: DEFAULTS,
    piDefaults: { provider: "litellm", model: "other" },
  });
  assert.deepEqual(got, { provider: "litellm", model: "some-model", source: "override" });
});

test("when it cannot be completed it fails loudly rather than emitting a flag pi will silently ignore", () => {
  assert.throws(
    () => resolveModelSelection({ model: "some-model", config: DEFAULTS, piDefaults: { provider: null, model: null } }),
    /model-resolver/,
  );
});

// --- Co-pilot guard ---

test("isDrafterModel matches patterns rather than hardcoded ids", () => {
  const p = DEFAULTS.drafter_patterns;
  assert.equal(isDrafterModel("Qwen3.6-27B-DFlash-draft", p), true);
  assert.equal(isDrafterModel("gemma-4-26B-A4B-it-assistant-bf16", p), true);
  assert.equal(isDrafterModel("some-model_assistant", p), true);
  assert.equal(isDrafterModel("Llama-3-8B-Instruct", p), false);
  assert.equal(isDrafterModel("gpt-5.4", p), false);
});

test("isDrafterModel is case-insensitive", () => {
  assert.equal(isDrafterModel("MODEL-DRAFT-V2", DEFAULTS.drafter_patterns), true);
});

test("isDrafterModel lets everything through with an empty pattern list or an unknown model", () => {
  assert.equal(isDrafterModel("Qwen3.6-27B-DFlash-draft", []), false);
  assert.equal(isDrafterModel(null, DEFAULTS.drafter_patterns), false);
});
