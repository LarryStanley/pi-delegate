export const OMLX_BASE_URL = "http://127.0.0.1:8000/v1";
export const PROVIDER = "omlx";

export const REQUIRED_MODELS = [
  { id: "Qwen3.8-27B-oQ4e-mtp", name: "Qwen3.8 27B oQ4e MTP", contextWindow: 262144, maxTokens: 32768 },
  { id: "Qwen3.6-35B-A3B-4bit", name: "Qwen3.6 35B A3B 4bit", contextWindow: 262144, maxTokens: 32768 },
];

export const DRAFTER_MODELS = ["Qwen3.6-27B-DFlash-draft", "gemma-4-26B-A4B-it-assistant-bf16"];

const THINKING_BINDING = { $var: "thinking.enabled" };

function hasThinkingBinding(model) {
  const bound = model?.compat?.chatTemplateKwargs?.enable_thinking;
  return JSON.stringify(bound) === JSON.stringify(THINKING_BINDING);
}

export function checkModels(cfg) {
  const problems = [];
  const provider = cfg?.providers?.[PROVIDER];

  if (!provider) {
    problems.push({
      code: "provider-missing",
      message: `~/.pi/agent/models.json 沒有 "${PROVIDER}" provider（腳本常誤寫成 "omls"）`,
      fixable: true,
    });
    return { ok: false, problems };
  }

  const models = provider.models ?? [];
  for (const required of REQUIRED_MODELS) {
    const found = models.find((m) => m.id === required.id);
    if (!found) {
      problems.push({ code: "model-missing", message: `模型 ${required.id} 未註冊`, fixable: true });
      continue;
    }
    if (found.reasoning !== true) {
      problems.push({
        code: "reasoning-missing",
        message: `${required.id} 缺 reasoning:true —— --thinking off 會靜默失效`,
        fixable: true,
      });
    }
    if (!hasThinkingBinding(found)) {
      problems.push({
        code: "compat-missing",
        message: `${required.id} 缺 compat.chatTemplateKwargs.enable_thinking 綁定 —— --thinking off 會靜默失效`,
        fixable: true,
      });
    }
  }

  for (const id of DRAFTER_MODELS) {
    const found = models.find((m) => m.id === id);
    if (found && found["x-pi-delegate-forbidden"] !== true) {
      problems.push({
        code: "drafter-unmarked",
        message: `${id} 是副駕駛模型，直接呼叫會 500，應標記為不可派工`,
        fixable: true,
      });
    }
  }

  return { ok: problems.length === 0, problems };
}

export function fixModels(cfg) {
  const next = structuredClone(cfg ?? {});
  next.providers ??= {};
  next.providers[PROVIDER] ??= { api: "openai-completions", baseUrl: OMLX_BASE_URL, apiKey: "not-needed", models: [] };

  const provider = next.providers[PROVIDER];
  provider.baseUrl ??= OMLX_BASE_URL;
  provider.models ??= [];

  for (const required of REQUIRED_MODELS) {
    let model = provider.models.find((m) => m.id === required.id);
    if (!model) {
      model = { id: required.id, name: required.name, input: ["text", "image"] };
      provider.models.push(model);
    }
    model.contextWindow ??= required.contextWindow;
    model.maxTokens ??= required.maxTokens;
    model.reasoning = true;
    model.compat ??= {};
    model.compat.chatTemplateKwargs ??= {};
    model.compat.chatTemplateKwargs.enable_thinking = { ...THINKING_BINDING };
  }

  for (const id of DRAFTER_MODELS) {
    const model = provider.models.find((m) => m.id === id);
    if (model) model["x-pi-delegate-forbidden"] = true;
  }

  return next;
}
