import { test } from "node:test";
import assert from "node:assert/strict";
import { checkModels, fixModels, chatTemplateThinkingApplies, isLocalBaseUrl, THINKING_BINDING } from "../src/doctor.mjs";
import { DEFAULTS } from "../src/config.mjs";

// checkModels 是顧問而不是關卡：它拿到的是「這次派工實際會打到誰」，只在確實成立
// 的條件下才提出問題。測試一律自己傳 selection，不碰這台機器上真實的設定檔。
const sel = (provider, model, source = "pi settings.json") => ({ provider, model, source });
const patterns = { drafterPatterns: [...DEFAULTS.drafter_patterns] };

// 本機 OpenAI 相容伺服器（例如 omlx / LM Studio / llama.cpp / vLLM）的形狀。
function localModels(models) {
  return {
    providers: {
      myprovider: { api: "openai-completions", baseUrl: "http://127.0.0.1:8000/v1", apiKey: "x", models },
    },
  };
}

// 託管服務的形狀（litellm / openrouter / OpenAI 本家…）。
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

// --- 不設定就沒問題：這是預設路徑，不是待辦事項 ---

test("pi 沒有預設模型可解析時不報任何問題", () => {
  const { ok, problems, checks } = checkModels({ providers: {} }, sel(null, null), patterns);
  assert.equal(ok, true, JSON.stringify(problems));
  assert.equal(problems.length, 0);
  assert.equal(checks.chat_template_thinking, "skipped");
});

// models.json 只放使用者自訂的 provider；anthropic / openai / google 這些是 pi
// 內建的（pi-ai types.d.ts:17 的 KnownProvider union），本來就不會出現在那個檔案。
// 舊版對這種情況報 provider-missing，等於對每個託管使用者噴假錯誤。
test("provider 不在 models.json 裡不是問題（多半是 pi 內建 provider）", () => {
  const { ok, problems, checks } = checkModels({ providers: {} }, sel("anthropic", "claude-sonnet-4-6"), patterns);
  assert.equal(ok, true, JSON.stringify(problems));
  assert.ok(!problems.some((p) => p.code === "provider-missing"));
  assert.equal(checks.provider_in_models_json, false);
  assert.match(checks.chat_template_thinking_reason, /內建/);
});

test("自訂 provider 底下找不到該模型也不報錯（pi 會合併內建模型）", () => {
  const { ok, checks } = checkModels(localModels([{ id: "other" }]), sel("myprovider", "my-model"), patterns);
  assert.equal(ok, true);
  assert.equal(checks.provider_in_models_json, true);
  assert.equal(checks.model_in_models_json, false);
});

test("checks 回報派工實際會打到誰", () => {
  const { checks } = checkModels(localModels([withThinking()]), sel("myprovider", "my-model", "pi settings.json"), patterns);
  assert.equal(checks.provider, "myprovider");
  assert.equal(checks.model, "my-model");
  assert.equal(checks.source, "pi settings.json");
});

// --- thinking 綁定：只對「本機 openai-completions 端點」適用 ---

test("本機 openai-completions 模型缺 reasoning 與 compat 時各回報一筆", () => {
  const { problems, checks } = checkModels(localModels([{ id: "my-model", name: "M" }]), sel("myprovider", "my-model"), patterns);
  assert.ok(problems.some((p) => p.code === "reasoning-missing"));
  assert.ok(problems.some((p) => p.code === "compat-missing"));
  assert.equal(checks.chat_template_thinking, "applied");
});

// 這是這一輪要修的核心誤報：託管 provider 的 thinking 是由該服務自己的 API 參數
// 控制的，chatTemplateKwargs 根本不在 pi 的 AnthropicMessagesCompatSchema /
// OpenAIResponsesCompatSchema 裡（dist/core/model-registry.js:92 只在
// OpenAICompletionsCompatSchema 有）。對這些使用者報問題是一筆永遠修不掉的假問題。
test("託管 anthropic provider 不報 reasoning-missing / compat-missing", () => {
  const modelsCfg = hostedModels([{ id: "my-model" }], "anthropic-messages");
  const { ok, problems, checks } = checkModels(modelsCfg, sel("myprovider", "my-model"), patterns);
  assert.equal(ok, true, JSON.stringify(problems));
  assert.equal(checks.chat_template_thinking, "skipped");
  assert.match(checks.chat_template_thinking_reason, /anthropic-messages/);
});

test("託管 openai-completions 端點（litellm 等）也不報 thinking 綁定問題", () => {
  const { ok, problems, checks } = checkModels(hostedModels([{ id: "my-model" }]), sel("myprovider", "my-model"), patterns);
  assert.equal(ok, true, JSON.stringify(problems));
  assert.equal(checks.chat_template_thinking, "skipped");
  assert.match(checks.chat_template_thinking_reason, /api\.example\.com/);
});

test("models.json 沒寫 api 時略過 thinking 檢查而不是誤報", () => {
  const modelsCfg = { providers: { myprovider: { baseUrl: "http://127.0.0.1:8000/v1", models: [{ id: "my-model" }] } } };
  const { ok, checks } = checkModels(modelsCfg, sel("myprovider", "my-model"), patterns);
  assert.equal(ok, true);
  assert.equal(checks.chat_template_thinking, "skipped");
});

test("本機模型已有 reasoning + 綁定時全綠", () => {
  const { ok, problems } = checkModels(localModels([withThinking()]), sel("myprovider", "my-model"), patterns);
  assert.equal(ok, true, JSON.stringify(problems));
});

test("chatTemplateThinkingApplies 的判斷與理由", () => {
  const local = { api: "openai-completions", baseUrl: "http://127.0.0.1:8000/v1" };
  assert.equal(chatTemplateThinkingApplies(local, { id: "m" }).applies, true);
  assert.equal(chatTemplateThinkingApplies({ api: "openai-responses", baseUrl: "http://127.0.0.1:8000/v1" }, { id: "m" }).applies, false);
  // 模型自己的 api / baseUrl 蓋過 provider 的（model-registry.js:452-457 的順序）
  assert.equal(chatTemplateThinkingApplies(local, { id: "m", baseUrl: "https://api.example.com/v1" }).applies, false);
  assert.equal(chatTemplateThinkingApplies({ baseUrl: "http://127.0.0.1:8000/v1" }, { id: "m", api: "openai-completions" }).applies, true);
});

test("isLocalBaseUrl 認得 loopback 與私有網段，不認託管網域", () => {
  for (const url of ["http://127.0.0.1:8000/v1", "http://localhost:1234/v1", "http://192.168.1.9:8080/v1", "http://10.0.0.4/v1", "http://box.local:8000/v1"]) {
    assert.equal(isLocalBaseUrl(url), true, url);
  }
  for (const url of ["https://api.openai.com/v1", "https://api.anthropic.com", "https://litellm.example.com/v1", "", null, "not-a-url"]) {
    assert.equal(isLocalBaseUrl(url), false, String(url));
  }
});

// --- 副駕駛守門：針對「即將被派工的那個模型」提出警告，不去改使用者的檔案 ---

test("即將派工的模型命中 drafter pattern 時回報 drafter-selected", () => {
  const { ok, problems } = checkModels(localModels([{ id: "my-model-DFlash-draft" }]), sel("myprovider", "my-model-DFlash-draft"), patterns);
  assert.equal(ok, false);
  const problem = problems.find((p) => p.code === "drafter-selected");
  assert.ok(problem);
  assert.equal(problem.fixable, false, "該由使用者換模型，不是自動改他的 models.json");
});

test("其他 drafter 模型存在但沒被選到時不吵", () => {
  const modelsCfg = localModels([withThinking(), { id: "my-model-draft" }]);
  const { ok, problems } = checkModels(modelsCfg, sel("myprovider", "my-model"), patterns);
  assert.equal(ok, true, JSON.stringify(problems));
});

test("drafter_patterns 設成空陣列時完全不管 drafter", () => {
  const modelsCfg = localModels([{ id: "my-model-draft", ...withThinking("my-model-draft") }]);
  const { ok } = checkModels(modelsCfg, sel("myprovider", "my-model-draft"), { drafterPatterns: [] });
  assert.equal(ok, true);
});

// --- fixModels：只補一件有把握的事 ---

test("fixModels 補上 reasoning 與 enable_thinking 綁定後 checkModels 全綠", () => {
  const before = localModels([{ id: "my-model", name: "M" }]);
  const fixed = fixModels(before, sel("myprovider", "my-model"));
  const model = fixed.providers.myprovider.models.find((m) => m.id === "my-model");
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.compat.chatTemplateKwargs.enable_thinking, { $var: "thinking.enabled" });
  const { ok, problems } = checkModels(fixed, sel("myprovider", "my-model"), patterns);
  assert.equal(ok, true, JSON.stringify(problems));
});

test("fixModels 不改動傳入物件", () => {
  const before = localModels([{ id: "my-model" }]);
  const snapshot = JSON.stringify(before);
  fixModels(before, sel("myprovider", "my-model"));
  assert.equal(JSON.stringify(before), snapshot);
});

// 舊版會把兩個寫死的 Qwen id 憑空插進 models.json —— 對沒有那台伺服器的人是在
// 製造永遠打不通的垃圾設定。現在缺什麼就報什麼，絕不發明。
test("fixModels 不會發明 provider，也不會插入未註冊的模型", () => {
  assert.deepEqual(fixModels({ providers: {} }, sel("myprovider", "my-model")), { providers: {} });
  const fixed = fixModels(localModels([{ id: "other" }]), sel("myprovider", "my-model"));
  assert.deepEqual(fixed.providers.myprovider.models.map((m) => m.id), ["other"]);
});

test("fixModels 對託管 provider 什麼都不加", () => {
  const fixed = fixModels(hostedModels([{ id: "my-model" }], "anthropic-messages"), sel("myprovider", "my-model"));
  const model = fixed.providers.myprovider.models.find((m) => m.id === "my-model");
  assert.equal(model.compat, undefined);
  assert.equal(model.reasoning, undefined);
});

// 舊版會在使用者的 models.json 裡塞一個 pi 不認得的 x-pi-delegate-forbidden 欄位。
// 副駕駛守門現在在派工當下用 pattern 比對就好，不必動別人的檔案。
test("fixModels 不會在別的模型上加自訂欄位", () => {
  const fixed = fixModels(localModels([{ id: "my-model" }, { id: "my-model-draft" }]), sel("myprovider", "my-model"));
  const drafter = fixed.providers.myprovider.models.find((m) => m.id === "my-model-draft");
  assert.deepEqual(Object.keys(drafter), ["id"]);
});

test("fixModels 保留既有的其他 provider", () => {
  const before = localModels([{ id: "my-model" }]);
  before.providers.litellm = { api: "openai-completions", baseUrl: "https://example/v1", models: [] };
  const fixed = fixModels(before, sel("myprovider", "my-model"));
  assert.ok(fixed.providers.litellm);
});

test("沒有可解析的 provider / model 時 fixModels 什麼都不動", () => {
  const before = localModels([{ id: "my-model" }]);
  assert.deepEqual(fixModels(before, sel(null, null)), before);
});
