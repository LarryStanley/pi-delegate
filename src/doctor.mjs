import { isDrafterModel, DEFAULTS } from "./config.mjs";

// pi 的 model-registry 用這個綁定把「客戶端的 thinking 開關」接到伺服器端 chat
// template 的 kwarg 上。字面值取自 pi 0.80.2 的 schema：
//   dist/core/model-registry.js:66
//     $var: Type.Union([Type.Literal("thinking.enabled"), Type.Literal("thinking.effort")])
export const THINKING_BINDING = { $var: "thinking.enabled" };

// pi 解析 api / baseUrl 的順序（dist/core/model-registry.js:452-457）：
//   const api = modelDef.api ?? providerConfig.api ?? builtInDefaults?.api;
//   const baseUrl = modelDef.baseUrl ?? providerConfig.baseUrl ?? builtInDefaults?.baseUrl;
// 這裡只看使用者自己寫在 models.json 裡的兩層；內建 provider 的預設值我們讀不到，
// 讀不到就當作「無法判定」——見 chatTemplateThinkingApplies() 的保守處理。
function effectiveApi(provider, model) {
  return model?.api ?? provider?.api ?? null;
}

function effectiveBaseUrl(provider, model) {
  return model?.baseUrl ?? provider?.baseUrl ?? null;
}

// 本機／內網端點的判準。命中就代表「模型跑在自己機器上的 OpenAI 相容伺服器」
// （例如 omlx、LM Studio、llama.cpp、vLLM），thinking 只能靠 chat template kwarg
// 關掉；沒命中就是託管端點，thinking 由該家 API 自己的參數控制。
export function isLocalBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string" || baseUrl === "") return false;
  let host;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "0.0.0.0" || host === "::1" || host === "[::1]") return true;
  if (host.endsWith(".local") || host.endsWith(".localhost")) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

// `reasoning: true` + `compat.chatTemplateKwargs.enable_thinking` 這組要求是**真的**，
// 但它只對一種 provider 成立，不是所有人都該被念。兩個查證過的理由：
//
// ① `chatTemplateKwargs` 只存在於 pi 的 **openai-completions** compat schema
//    （dist/core/model-registry.js:92，在 OpenAICompletionsCompatSchema 裡）。
//    OpenAIResponsesCompatSchema 與 AnthropicMessagesCompatSchema 完全沒有這個欄位 ——
//    對 anthropic / openai-responses 的模型要求它，只會產生一筆永遠修不好的假問題。
// ② 就算 api 是 openai-completions，託管端點（litellm、openrouter、OpenAI 本家…）
//    的 thinking 也是由該服務自己的參數決定的，chat template kwarg 不會生效。
//    只有本機／內網那台自己跑 chat template 的伺服器才需要這個綁定。
//
// 判不出來（沒寫 api、沒寫 baseUrl、或 provider 根本不在 models.json 裡而是 pi
// 的內建 provider）時一律**不報**：這道檢查的兩種錯代價不對稱 —— 漏報只是少一句
// 提醒，誤報是對每個託管使用者在每次 SessionStart 噴一個他永遠修不掉的紅字。
export function chatTemplateThinkingApplies(provider, model) {
  const api = effectiveApi(provider, model);
  if (api === null) {
    return { applies: false, reason: "models.json 沒有寫 api，無法判定是否走 openai-completions，略過 thinking 綁定檢查" };
  }
  if (api !== "openai-completions") {
    return {
      applies: false,
      reason: `api 是 "${api}"；pi 只有 openai-completions 的 compat schema 有 chatTemplateKwargs，此檢查不適用`,
    };
  }
  const baseUrl = effectiveBaseUrl(provider, model);
  if (!isLocalBaseUrl(baseUrl)) {
    return {
      applies: false,
      reason: baseUrl
        ? `baseUrl ${baseUrl} 不是本機／內網端點；託管服務的 thinking 由它自己的 API 參數控制，此檢查不適用`
        : "models.json 沒有寫 baseUrl，無法判定是不是本機伺服器，略過 thinking 綁定檢查",
    };
  }
  return {
    applies: true,
    reason: `本機 openai-completions 端點（${baseUrl}）：--thinking off 要靠 chat template kwarg 才傳得到`,
  };
}

function hasThinkingBinding(model) {
  const bound = model?.compat?.chatTemplateKwargs?.enable_thinking;
  return JSON.stringify(bound) === JSON.stringify(THINKING_BINDING);
}

// checkModels 是**顧問**，不是驗收關卡。它回報「這次派工實際上會打到誰」，並且
// 只在**確實成立**的條件下才提出問題。
//
// 舊版寫死兩個 Qwen id 當 REQUIRED_MODELS，缺了就報 model-missing、--fix 就把它們
// 憑空插進 models.json —— 對沒有那台伺服器的人是在製造垃圾設定。
//
// 特別注意：**provider 不在 models.json 裡不是問題**。models.json 只放使用者自訂的
// provider；anthropic / openai / google 這些是 pi 內建的（pi-ai types.d.ts:17 的
// KnownProvider union），它們本來就不會出現在這個檔案裡。對這種情況報
// provider-missing 就是對每一個託管使用者噴假錯誤。
export function checkModels(modelsCfg, selection = {}, options = {}) {
  const drafterPatterns = options.drafterPatterns ?? [...DEFAULTS.drafter_patterns];
  const problems = [];
  const checks = {
    provider: selection.provider ?? null,
    model: selection.model ?? null,
    source: selection.source ?? "pi",
    provider_in_models_json: false,
    model_in_models_json: false,
    chat_template_thinking: "skipped",
    chat_template_thinking_reason: "",
  };

  if (!selection.provider || !selection.model) {
    checks.chat_template_thinking_reason =
      "pi 尚未在 ~/.pi/agent/settings.json 設定 defaultProvider / defaultModel，" +
      "pi 會自己挑第一個有 API key 的模型（model-resolver.js:461-475），這裡無從檢查。";
    return { ok: true, problems, checks };
  }

  // 副駕駛守門：只針對**實際會被派工的那個模型**提出警告，不去改使用者的 models.json。
  if (isDrafterModel(selection.model, drafterPatterns)) {
    problems.push({
      code: "drafter-selected",
      message:
        `即將派工的模型 ${selection.model} 命中副駕駛命名 pattern（${drafterPatterns.join(" / ")}）。` +
        "推測解碼的 draft / assistant 模型直接呼叫會回 HTTP 500 —— 請改用 target model。" +
        "若是誤判，在 pi-delegate config.json 調整 drafter_patterns。",
      fixable: false,
    });
  }

  const provider = modelsCfg?.providers?.[selection.provider];
  if (!provider) {
    checks.chat_template_thinking_reason =
      `"${selection.provider}" 不在 ~/.pi/agent/models.json 裡 —— 多半是 pi 內建的 provider` +
      "（anthropic / openai / google…），這是正常的，不需要處理。";
    return { ok: problems.length === 0, problems, checks };
  }
  checks.provider_in_models_json = true;

  const models = provider.models ?? [];
  const model = models.find((m) => m.id === selection.model);
  if (!model) {
    // 自訂 provider 底下找不到這個模型 id，也**不一定**是錯的：pi 對內建 provider
    // 會把內建模型與自訂模型合併起來（model-registry.js 的 getAll()）。所以這裡
    // 只記錄事實，不當成問題 —— 真的打不通時 pi 自己會回
    // `Model "…" not found`（model-resolver.js:411）。
    checks.chat_template_thinking_reason =
      `${selection.model} 沒有註冊在 models.json 的 "${selection.provider}" 底下` +
      "（可能是該 provider 的內建模型），無從檢查 thinking 綁定。";
    return { ok: problems.length === 0, problems, checks };
  }
  checks.model_in_models_json = true;

  const applies = chatTemplateThinkingApplies(provider, model);
  checks.chat_template_thinking = applies.applies ? "applied" : "skipped";
  checks.chat_template_thinking_reason = applies.reason;
  if (applies.applies) {
    if (model.reasoning !== true) {
      problems.push({
        code: "reasoning-missing",
        message: `${model.id} 缺 reasoning:true —— 對本機 chat-template 伺服器來說，--thinking off 會靜默失效`,
        fixable: true,
      });
    }
    if (!hasThinkingBinding(model)) {
      problems.push({
        code: "compat-missing",
        message: `${model.id} 缺 compat.chatTemplateKwargs.enable_thinking 綁定 —— --thinking off 會靜默失效`,
        fixable: true,
      });
    }
  }

  return { ok: problems.length === 0, problems, checks };
}

// fixModels 只補一件我們有把握的事：**已經註冊在 models.json 裡、而且確定是本機
// openai-completions 端點**的那個模型，加上 thinking 綁定。
// 它不會建立 provider、不會插入模型、不會碰其他模型 —— 那些需要 baseUrl / apiKey /
// contextWindow 這些只有使用者知道的值，猜出來的設定比沒有設定更難除錯。
export function fixModels(modelsCfg, selection = {}) {
  const next = structuredClone(modelsCfg ?? {});
  if (!selection.provider || !selection.model) return next;

  const provider = next?.providers?.[selection.provider];
  if (!provider || !Array.isArray(provider.models)) return next;

  const model = provider.models.find((m) => m.id === selection.model);
  if (!model || !chatTemplateThinkingApplies(provider, model).applies) return next;

  model.reasoning = true;
  model.compat ??= {};
  model.compat.chatTemplateKwargs ??= {};
  model.compat.chatTemplateKwargs.enable_thinking = { ...THINKING_BINDING };
  return next;
}
