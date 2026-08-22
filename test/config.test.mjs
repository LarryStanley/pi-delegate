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

test("configPath 指向 ~/.claude/pi-delegate/config.json", () => {
  assert.match(configPath(), /\.claude[/\\]pi-delegate[/\\]config\.json$/);
});

test("piSettingsPath 指向 ~/.pi/agent/settings.json", () => {
  assert.match(piSettingsPath(), /\.pi[/\\]agent[/\\]settings\.json$/);
});

// 「沒有 config.json」是正常狀態，不是待辦事項：provider / model 為 null 代表
// 「不要帶旗標，交給 pi 自己解析」。
test("設定檔不存在時 provider / model 是 null，其餘是量出來的預設", () => {
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

test("設定檔損毀時退回預設而不是 throw（跟 modes.mjs 的 load() 同一套降級）", () => {
  const cfg = loadConfig(tmpJson("config.json", "{ not json"));
  assert.equal(cfg.provider, null);
  assert.equal(cfg.timeout_s, DEFAULT_TIMEOUT_S);
  assert.equal(cfg.thinking, PLUGIN_DEFAULTS.thinking);
});

test("設定檔是陣列時也退回預設", () => {
  assert.deepEqual(loadConfig(tmpJson("config.json", "[1,2,3]")).drafter_patterns, [...DEFAULTS.drafter_patterns]);
});

test("讀得到使用者設定的任意 provider / model", () => {
  const cfg = loadConfig(tmpJson("config.json", { provider: "ollama", model: "qwen3:8b", timeout_s: 300 }));
  assert.equal(cfg.provider, "ollama");
  assert.equal(cfg.model, "qwen3:8b");
  assert.equal(cfg.timeout_s, 300);
});

test("不合法的 timeout_s 與 thinking 等級退回預設", () => {
  const cfg = loadConfig(tmpJson("config.json", { timeout_s: -5, thinking: "maximum" }));
  assert.equal(cfg.timeout_s, DEFAULT_TIMEOUT_S);
  assert.equal(cfg.thinking, "off");
});

// null 是有意義的值：「不要帶這個旗標，讓 pi 自己決定」。不能跟「沒寫」混為一談。
test("thinking / tools 設成 null 代表不帶那個旗標", () => {
  const cfg = loadConfig(tmpJson("config.json", { thinking: null, tools: null }));
  assert.equal(cfg.thinking, null);
  assert.equal(cfg.tools, null);
});

test("drafter_patterns 可以被設成空陣列（關掉守門）", () => {
  assert.deepEqual(loadConfig(tmpJson("config.json", { drafter_patterns: [] })).drafter_patterns, []);
});

test("saveConfig 只覆寫傳進來的欄位，其餘沿用", () => {
  const file = tmpJson("config.json");
  saveConfig({ provider: "lmstudio", model: "m1" }, file);
  saveConfig({ model: "m2" }, file);
  const cfg = loadConfig(file);
  assert.equal(cfg.provider, "lmstudio");
  assert.equal(cfg.model, "m2");
  assert.equal(cfg.timeout_s, DEFAULT_TIMEOUT_S);
});

test("saveConfig 寫出的是可讀的 JSON", () => {
  const file = tmpJson("config.json");
  saveConfig({ provider: "openai", model: "gpt-x", timeout_s: 900 }, file);
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(parsed.provider, "openai");
  assert.equal(parsed.model, "gpt-x");
  assert.equal(parsed.timeout_s, 900);
  assert.ok(Array.isArray(parsed.drafter_patterns));
});

// --- 第 3 層：pi 自己的預設 ---

test("loadPiDefaults 讀 settings.json 的 defaultProvider / defaultModel", () => {
  const file = tmpJson("settings.json", { defaultProvider: "litellm", defaultModel: "DeepSeek-V4-Pro", theme: "dark" });
  assert.deepEqual(loadPiDefaults(file), { provider: "litellm", model: "DeepSeek-V4-Pro" });
});

test("loadPiDefaults 在 settings.json 不存在或壞掉時回 null", () => {
  assert.deepEqual(loadPiDefaults(tmpJson("settings.json")), { provider: null, model: null });
  assert.deepEqual(loadPiDefaults(tmpJson("settings.json", "{oops")), { provider: null, model: null });
});

// --- 三層解析 ---

test("什麼都沒指定時解析結果是「交給 pi」", () => {
  assert.deepEqual(resolveModelSelection({ config: DEFAULTS }), { provider: null, model: null, source: "pi" });
});

test("config 指定了就用 config 的", () => {
  const config = { ...DEFAULTS, provider: "ollama", model: "qwen3:8b" };
  assert.deepEqual(resolveModelSelection({ config }), { provider: "ollama", model: "qwen3:8b", source: "override" });
});

test("呼叫參數覆寫 config", () => {
  const config = { ...DEFAULTS, provider: "ollama", model: "qwen3:8b" };
  const got = resolveModelSelection({ provider: "anthropic", model: "claude-sonnet-4-6", config });
  assert.deepEqual(got, { provider: "anthropic", model: "claude-sonnet-4-6", source: "override" });
});

// pi 的 model-resolver.js:428 是 `if (cliProvider && cliModel)` —— 只給一個旗標會被
// 整組忽略。所以只解析出一個時要從 pi 的預設補齊。
test("只指定 model 時，provider 從 pi 的預設補齊", () => {
  const got = resolveModelSelection({
    model: "some-model",
    config: DEFAULTS,
    piDefaults: { provider: "litellm", model: "other" },
  });
  assert.deepEqual(got, { provider: "litellm", model: "some-model", source: "override" });
});

test("補不齊時明確報錯，而不是送出一個會被 pi 靜默忽略的旗標", () => {
  assert.throws(
    () => resolveModelSelection({ model: "some-model", config: DEFAULTS, piDefaults: { provider: null, model: null } }),
    /model-resolver/,
  );
});

// --- 副駕駛守門 ---

test("isDrafterModel 用 pattern 比對而不是寫死 id", () => {
  const p = DEFAULTS.drafter_patterns;
  assert.equal(isDrafterModel("Qwen3.6-27B-DFlash-draft", p), true);
  assert.equal(isDrafterModel("gemma-4-26B-A4B-it-assistant-bf16", p), true);
  assert.equal(isDrafterModel("some-model_assistant", p), true);
  assert.equal(isDrafterModel("Llama-3-8B-Instruct", p), false);
  assert.equal(isDrafterModel("gpt-5.4", p), false);
});

test("isDrafterModel 大小寫不敏感", () => {
  assert.equal(isDrafterModel("MODEL-DRAFT-V2", DEFAULTS.drafter_patterns), true);
});

test("isDrafterModel 在 pattern 清單為空或 model 未知時放行", () => {
  assert.equal(isDrafterModel("Qwen3.6-27B-DFlash-draft", []), false);
  assert.equal(isDrafterModel(null, DEFAULTS.drafter_patterns), false);
});
