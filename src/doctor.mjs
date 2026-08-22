import { isDrafterModel, DEFAULTS } from "./config.mjs";

// pi's model-registry uses this binding to wire the client-side "thinking" toggle to the
// server-side chat template's kwarg. The literal value is taken from pi 0.80.2's schema:
//   dist/core/model-registry.js:66
//     $var: Type.Union([Type.Literal("thinking.enabled"), Type.Literal("thinking.effort")])
export const THINKING_BINDING = { $var: "thinking.enabled" };

// The order in which pi resolves api / baseUrl (dist/core/model-registry.js:452-457):
//   const api = modelDef.api ?? providerConfig.api ?? builtInDefaults?.api;
//   const baseUrl = modelDef.baseUrl ?? providerConfig.baseUrl ?? builtInDefaults?.baseUrl;
// We only see the two layers the user actually wrote into models.json; we cannot read a
// built-in provider's defaults, and treat that as "cannot determine" — see the
// conservative handling in chatTemplateThinkingApplies().
function effectiveApi(provider, model) {
  return model?.api ?? provider?.api ?? null;
}

function effectiveBaseUrl(provider, model) {
  return model?.baseUrl ?? provider?.baseUrl ?? null;
}

// Criteria for a local / LAN endpoint. A match means "the model runs on an
// OpenAI-compatible server on this machine" (e.g. omlx, LM Studio, llama.cpp, vLLM),
// where thinking can only be turned off via the chat template kwarg; no match means a
// hosted endpoint, where thinking is controlled by that API's own parameters.
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

// The `reasoning: true` + `compat.chatTemplateKwargs.enable_thinking` requirement is
// REAL, but it only holds for one kind of provider — not everybody should be nagged
// about it. Two verified reasons:
//
// (1) `chatTemplateKwargs` exists ONLY in pi's **openai-completions** compat schema
//     (dist/core/model-registry.js:92, inside OpenAICompletionsCompatSchema).
//     OpenAIResponsesCompatSchema and AnthropicMessagesCompatSchema have no such field at
//     all — requiring it for an anthropic / openai-responses model would produce a false
//     problem that can never be fixed.
// (2) Even when api is openai-completions, a hosted endpoint (litellm, openrouter,
//     OpenAI itself, …) still controls thinking through its own service parameters, so
//     the chat template kwarg has no effect there. Only a local/LAN server that runs its
//     own chat template actually needs this binding.
//
// Whenever it cannot be determined (no api written, no baseUrl written, or the provider
// isn't in models.json at all because it's one of pi's built-ins), we NEVER raise a
// problem: the two kinds of error here are asymmetric — a missed warning is just one
// fewer reminder, but a false positive means every hosted-provider user gets a red flag
// on every SessionStart that they can never fix.
export function chatTemplateThinkingApplies(provider, model) {
  const api = effectiveApi(provider, model);
  if (api === null) {
    return { applies: false, reason: "models.json has no api set, so whether this is openai-completions cannot be determined; skipping the thinking-binding check" };
  }
  if (api !== "openai-completions") {
    return {
      applies: false,
      reason: `api is "${api}"; only pi's openai-completions compat schema has chatTemplateKwargs, so this check does not apply`,
    };
  }
  const baseUrl = effectiveBaseUrl(provider, model);
  if (!isLocalBaseUrl(baseUrl)) {
    return {
      applies: false,
      reason: baseUrl
        ? `baseUrl ${baseUrl} is not a local/LAN endpoint; a hosted service controls thinking through its own API parameters, so this check does not apply`
        : "models.json has no baseUrl set, so whether this is a local server cannot be determined; skipping the thinking-binding check",
    };
  }
  return {
    applies: true,
    reason: `Local openai-completions endpoint (${baseUrl}): --thinking off only reaches the model via the chat template kwarg`,
  };
}

function hasThinkingBinding(model) {
  const bound = model?.compat?.chatTemplateKwargs?.enable_thinking;
  return JSON.stringify(bound) === JSON.stringify(THINKING_BINDING);
}

// checkModels is an **advisor**, not a gate. It reports which model a dispatch will
// actually reach, and raises a problem only under conditions that **genuinely hold**.
//
// An earlier version hardcoded two Qwen ids as REQUIRED_MODELS: missing either reported
// model-missing, and --fix inserted them into models.json out of thin air — for anyone
// without that server, that's manufacturing garbage configuration.
//
// Note in particular: **a provider missing from models.json is not a problem.**
// models.json only holds user-defined providers; anthropic / openai / google are built
// into pi (the KnownProvider union in pi-ai's types.d.ts:17) and never appear in this
// file in the first place. Reporting provider-missing for that case would be a false
// error blasted at every hosted-provider user.
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
      "pi has no defaultProvider / defaultModel configured in ~/.pi/agent/settings.json; " +
      "pi will pick the first model with an API key on its own (model-resolver.js:461-475), " +
      "so there is nothing to check here.";
    return { ok: true, problems, checks };
  }

  // Drafter guard: only warns about the model that will **actually be dispatched to**;
  // it never touches the user's models.json.
  if (isDrafterModel(selection.model, drafterPatterns)) {
    problems.push({
      code: "drafter-selected",
      message:
        `The model about to be dispatched to, ${selection.model}, matches a drafter naming pattern (${drafterPatterns.join(" / ")}). ` +
        "Speculative-decoding draft/assistant models return HTTP 500 when called directly — use the target model instead. " +
        "If this is a false positive, adjust drafter_patterns in pi-delegate's config.json.",
      fixable: false,
    });
  }

  const provider = modelsCfg?.providers?.[selection.provider];
  if (!provider) {
    checks.chat_template_thinking_reason =
      `"${selection.provider}" is not in ~/.pi/agent/models.json — most likely one of pi's ` +
      "built-in providers (anthropic / openai / google / …), which is normal and needs no action.";
    return { ok: problems.length === 0, problems, checks };
  }
  checks.provider_in_models_json = true;

  const models = provider.models ?? [];
  const model = models.find((m) => m.id === selection.model);
  if (!model) {
    // Not finding this model id under a custom provider is **not necessarily** wrong
    // either: for built-in providers, pi merges its built-in models with the user's
    // custom ones (model-registry.js's getAll()). So this just records the fact rather
    // than treating it as a problem — if the dispatch genuinely can't reach the model, pi
    // itself will return `Model "…" not found` (model-resolver.js:411).
    checks.chat_template_thinking_reason =
      `${selection.model} is not registered under "${selection.provider}" in models.json ` +
      "(it may be one of that provider's built-in models); the thinking binding cannot be checked.";
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
        message: `${model.id} is missing reasoning:true — on a local chat-template server, --thinking off silently has no effect`,
        fixable: true,
      });
    }
    if (!hasThinkingBinding(model)) {
      problems.push({
        code: "compat-missing",
        message: `${model.id} is missing the compat.chatTemplateKwargs.enable_thinking binding — --thinking off silently has no effect`,
        fixable: true,
      });
    }
  }

  return { ok: problems.length === 0, problems, checks };
}

// fixModels only patches the one thing it can be sure about: adding the thinking binding
// to a model that is **already registered in models.json and confirmed to be a local
// openai-completions endpoint**.
// It never creates a provider, never inserts a model, never touches other models — those
// need baseUrl / apiKey / contextWindow values that only the user knows, and a guessed
// configuration is harder to debug than no configuration.
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
