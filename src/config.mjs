import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// pi-delegate 對「該打哪個 provider / model」不做任何猜測，也**不要求使用者再設定一次**。
// 這個外掛原本寫死一台特定機器上的本機推論伺服器（omlx）與兩個 Qwen 模型 id，
// 對其他人一律是錯的。現在的規則是三層，由高到低：
//
//   1. pi_dispatch 的呼叫參數（Claude 逐次決定）
//   2. ~/.claude/pi-delegate/config.json（使用者的長期偏好，**可以完全不存在**）
//   3. pi 自己的設定（旗標整個不帶，pi 從 ~/.pi/agent/settings.json 的
//      defaultProvider / defaultModel 解析）
//
// 第 3 層是預設路徑，不是退路：裝好外掛、什麼都不設定，pi_dispatch 就會打使用者
// 本來就在用的那個模型（anthropic / openai / ollama / 本機伺服器都一樣）。
export const DEFAULT_TIMEOUT_S = 1500;

// 推測解碼的 draft / assistant 模型是副駕駛，直接呼叫會回 HTTP 500。
// 具體 id 是每個人自己的，但命名慣例夠穩定，所以守門改成 pattern 比對
// （大小寫不敏感的子字串）。要關掉就在 config 裡設 "drafter_patterns": []。
export const DEFAULT_DRAFTER_PATTERNS = ["-draft", "_assistant", "-assistant"];

// pi 接受的 thinking 等級。取自 pi 0.80.2 的 dist/cli/args.js:6
//   const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
// 不合法的值 pi 只會印一句 warning 然後**靜默忽略**（args.js:96-105），所以這裡要自己擋。
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

// 這三個是「量出來的預設」，不是結構性設定 —— 所以可以覆寫（理由見 server.mjs
// 的 tool 說明與 dispatch.mjs 的註解）。null 一律代表「不要帶這個旗標，讓 pi 自己決定」。
export const PLUGIN_DEFAULTS = Object.freeze({
  thinking: "off",
  tools: "read,write,edit",
  no_context_files: true,
  append_system_prompt: null,
});

// loadConfig() 在檔案不存在／壞掉時回傳的值。provider 與 model 是 null，代表
// 「不帶旗標，交給 pi 解析」—— 這是**正常狀態**，不是待辦事項。
export const DEFAULTS = Object.freeze({
  provider: null,
  model: null,
  timeout_s: DEFAULT_TIMEOUT_S,
  ...PLUGIN_DEFAULTS,
  drafter_patterns: Object.freeze([...DEFAULT_DRAFTER_PATTERNS]),
});

export function configPath() {
  return join(homedir(), ".claude", "pi-delegate", "config.json");
}

export function piSettingsPath() {
  return join(homedir(), ".pi", "agent", "settings.json");
}

export function piModelsPath() {
  return join(homedir(), ".pi", "agent", "models.json");
}

// 降級策略跟 src/modes.mjs 的 load() 一字不差：檔案不存在或壞掉時回空物件。
// 設定檔壞掉不該讓 SessionStart hook 或 MCP server 掛掉。
function loadJsonObject(file) {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// `key in raw` 而不是 `raw[key] ?? default`：null 是有意義的值（「不要帶這個旗標」），
// 用 ?? 會把它跟「沒寫」混為一談。
function optionalString(raw, key, fallback) {
  if (!(key in raw)) return fallback;
  if (raw[key] === null) return null;
  return nonEmptyString(raw[key]) ?? fallback;
}

export function loadConfig(file = configPath()) {
  const raw = loadJsonObject(file);
  const timeout = Number(raw.timeout_s);
  const thinking = optionalString(raw, "thinking", PLUGIN_DEFAULTS.thinking);
  return {
    provider: nonEmptyString(raw.provider) ?? DEFAULTS.provider,
    model: nonEmptyString(raw.model) ?? DEFAULTS.model,
    timeout_s: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULTS.timeout_s,
    thinking: thinking === null || THINKING_LEVELS.includes(thinking) ? thinking : PLUGIN_DEFAULTS.thinking,
    tools: optionalString(raw, "tools", PLUGIN_DEFAULTS.tools),
    no_context_files: typeof raw.no_context_files === "boolean" ? raw.no_context_files : PLUGIN_DEFAULTS.no_context_files,
    append_system_prompt: optionalString(raw, "append_system_prompt", PLUGIN_DEFAULTS.append_system_prompt),
    drafter_patterns: Array.isArray(raw.drafter_patterns)
      ? raw.drafter_patterns.map(nonEmptyString).filter((p) => p !== null)
      : [...DEFAULTS.drafter_patterns],
  };
}

// patch 語意：只覆寫傳進來的欄位，其餘沿用現有設定（或預設值）。
export function saveConfig(patch, file = configPath()) {
  const merged = { ...loadConfig(file), ...patch };
  const normalized = {
    provider: nonEmptyString(merged.provider),
    model: nonEmptyString(merged.model),
    timeout_s: Number.isFinite(Number(merged.timeout_s)) && Number(merged.timeout_s) > 0
      ? Number(merged.timeout_s)
      : DEFAULTS.timeout_s,
    thinking: merged.thinking === null ? null : (THINKING_LEVELS.includes(merged.thinking) ? merged.thinking : PLUGIN_DEFAULTS.thinking),
    tools: nonEmptyString(merged.tools),
    no_context_files: typeof merged.no_context_files === "boolean" ? merged.no_context_files : PLUGIN_DEFAULTS.no_context_files,
    append_system_prompt: nonEmptyString(merged.append_system_prompt),
    drafter_patterns: Array.isArray(merged.drafter_patterns)
      ? merged.drafter_patterns.map(nonEmptyString).filter((p) => p !== null)
      : [...DEFAULTS.drafter_patterns],
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

// 第 3 層：pi 自己的預設。查證來源是 pi 0.80.2 的實作，不是文件：
//   dist/core/settings-manager.js:440/443 → getDefaultProvider() / getDefaultModel()
//     直接回 settings.json 的 defaultProvider / defaultModel
//   dist/core/sdk.js:100-101 → 把這兩個值餵給 findInitialModel()
//   dist/core/model-resolver.js:423-476 → 解析順序：
//     1. CLI 的 provider+model（**兩個都有**才算）2. scoped models
//     3. settings 的 saved default 4. 第一個有 API key 的模型
export function loadPiDefaults(file = piSettingsPath()) {
  const raw = loadJsonObject(file);
  return {
    provider: nonEmptyString(raw.defaultProvider),
    model: nonEmptyString(raw.defaultModel),
  };
}

// model-resolver.js:428 是 `if (cliProvider && cliModel)` —— **只給一個旗標，pi 會
// 整組忽略**，靜靜地改用 settings.json 的預設。這正是這個 codebase 反覆踩到的那種
// 「說好的覆寫被無聲吃掉」。所以這裡的規則是：要嘛兩個都帶，要嘛兩個都不帶；
// 只解析出一個時，另一個從 pi 的 settings.json 補齊，補不出來就明確報錯。
export function resolveModelSelection({ provider, model, config = DEFAULTS, piDefaults = { provider: null, model: null } } = {}) {
  const wanted = {
    provider: provider ?? config.provider ?? null,
    model: model ?? config.model ?? null,
  };
  if (!wanted.provider && !wanted.model) {
    return { provider: null, model: null, source: "pi" };
  }
  const resolved = {
    provider: wanted.provider ?? piDefaults.provider,
    model: wanted.model ?? piDefaults.model,
  };
  if (!resolved.provider || !resolved.model) {
    const have = resolved.provider ? "provider" : "model";
    const missing = resolved.provider ? "model" : "provider";
    throw new Error(
      `只指定了 ${have} 而缺 ${missing}，而 pi 的 ` +
      "model-resolver 只在 provider 與 model **同時**存在時才採用命令列的選擇" +
      "（dist/core/model-resolver.js:428），單獨一個會被靜默忽略。" +
      `請兩個都指定，或在 ${piSettingsPath()} 設好 defaultProvider / defaultModel。`,
    );
  }
  return { ...resolved, source: "override" };
}

// 大小寫不敏感：模型 id 的大小寫慣例各家不同（DFlash-draft / dflash-draft），
// 而「誤放行一個副駕駛」的代價是一個沒有線索的 HTTP 500。
export function isDrafterModel(modelId, patterns = DEFAULTS.drafter_patterns) {
  if (typeof modelId !== "string" || modelId === "") return false;
  const id = modelId.toLowerCase();
  return patterns.some((pattern) => id.includes(String(pattern).toLowerCase()));
}
