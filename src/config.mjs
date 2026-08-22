import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// pi-delegate makes no guess about which provider/model to dispatch to, and it does NOT
// ask the user to configure that a second time. This plugin used to hardcode one
// particular machine's local inference server (omlx) plus two Qwen model ids, which is
// simply wrong for everybody else. The rule now is three layers, highest first:
//
//   1. pi_dispatch call arguments (Claude decides per dispatch)
//   2. ~/.claude/pi-delegate/config.json (the user's standing preference; MAY NOT EXIST)
//   3. pi's own configuration — emit no flags at all and let pi resolve
//      defaultProvider / defaultModel from ~/.pi/agent/settings.json
//
// Layer 3 is the default path, not a fallback: install the plugin, configure nothing, and
// pi_dispatch hits whatever model the user already uses (anthropic, openai, ollama, a
// local server — all the same).
export const DEFAULT_TIMEOUT_S = 1500;

// Speculative-decoding draft/assistant models are co-pilots: calling one directly returns
// HTTP 500. The concrete ids belong to whoever set them up, but the naming convention is
// stable enough, so the guard matches patterns instead (case-insensitive substring).
// Set "drafter_patterns": [] in the config to switch the guard off.
export const DEFAULT_DRAFTER_PATTERNS = ["-draft", "_assistant", "-assistant"];

// Thinking levels pi accepts. Taken from pi 0.80.2, dist/cli/args.js:6
//   const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
// pi only prints a warning for an invalid value and then SILENTLY DROPS it
// (args.js:96-105), so we reject it here instead.
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

// These three are MEASURED defaults, not structural settings — which is exactly why they
// are overridable (rationale lives in the pi_dispatch tool descriptions in server.mjs and
// in dispatch.mjs). null always means "do not emit this flag; let pi decide".
export const PLUGIN_DEFAULTS = Object.freeze({
  thinking: "off",
  tools: "read,write,edit",
  no_context_files: true,
  append_system_prompt: null,
});

// What loadConfig() returns when the file is missing or corrupt. provider and model are
// null, meaning "emit no flag, let pi resolve it" — that is the NORMAL state, not a
// to-do item.
export const DEFAULTS = Object.freeze({
  provider: null,
  model: null,
  timeout_s: DEFAULT_TIMEOUT_S,
  // null means "work it out" — see src/pi-command.mjs. Set pi_command to a string or an
  // argv array to pin the launcher explicitly (the escape hatch when the Windows shim
  // resolution cannot find an unusual install).
  pi_command: null,
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

// Degradation strategy is word for word the one in src/modes.mjs's load(): a missing or
// corrupt file yields an empty object. A broken config file must not take down a
// SessionStart hook or the MCP server — that is precisely the moment it most needs to
// stay up and say "you have not configured this yet".
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

// `key in raw` rather than `raw[key] ?? default`: null is a meaningful value here ("do not
// emit this flag"), and ?? would conflate it with "not written at all".
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
    pi_command: Array.isArray(raw.pi_command)
      ? raw.pi_command.map(nonEmptyString).filter((p) => p !== null)
      : nonEmptyString(raw.pi_command),
    drafter_patterns: Array.isArray(raw.drafter_patterns)
      ? raw.drafter_patterns.map(nonEmptyString).filter((p) => p !== null)
      : [...DEFAULTS.drafter_patterns],
  };
}

// Patch semantics: only the supplied fields are overwritten, everything else keeps its
// current (or default) value. Returns what was written so callers need not re-read.
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

// Layer 3: pi's own defaults. Verified against pi 0.80.2's shipped implementation, not its
// documentation:
//   dist/core/settings-manager.js:440/443 → getDefaultProvider() / getDefaultModel()
//     return settings.json's defaultProvider / defaultModel verbatim
//   dist/core/sdk.js:100-101 → feeds both into findInitialModel()
//   dist/core/model-resolver.js:423-476 → resolution order:
//     1. CLI provider+model (only when BOTH are present) 2. scoped models
//     3. the saved default from settings 4. first model with a valid API key
export function loadPiDefaults(file = piSettingsPath()) {
  const raw = loadJsonObject(file);
  return {
    provider: nonEmptyString(raw.defaultProvider),
    model: nonEmptyString(raw.defaultModel),
  };
}

// model-resolver.js:428 reads `if (cliProvider && cliModel)` — passing ONLY ONE of the two
// flags makes pi ignore the pair entirely and quietly fall back to the settings.json
// default. That is exactly the "an override we promised gets silently swallowed" failure
// this codebase keeps hitting. So the rule is: emit both flags or neither. When only one
// resolves, complete the other from pi's settings.json; if that is impossible, fail loudly.
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
      `Only ${have} was specified and ${missing} is missing. pi's model-resolver honours a ` +
      "command-line model selection only when provider and model are BOTH present " +
      "(dist/core/model-resolver.js:428); a lone flag is silently ignored. " +
      `Specify both, or set defaultProvider / defaultModel in ${piSettingsPath()}.`,
    );
  }
  return { ...resolved, source: "override" };
}

// Case-insensitive: model-id casing conventions differ across setups (DFlash-draft vs
// dflash-draft), and the cost of letting a co-pilot through is an HTTP 500 with no clue
// attached.
export function isDrafterModel(modelId, patterns = DEFAULTS.drafter_patterns) {
  if (typeof modelId !== "string" || modelId === "") return false;
  const id = modelId.toLowerCase();
  return patterns.some((pattern) => id.includes(String(pattern).toLowerCase()));
}
