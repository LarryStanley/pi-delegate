import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const MODES = ["off", "soft", "strict"];
export const DEFAULT_MODE = "soft";

export function stateFilePath() {
  return join(homedir(), ".claude", "pi-delegate", "modes.json");
}

function load(file) {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // A corrupted state file must not crash the hook — fall back to the default mode
    return {};
  }
}

// An entry is either the bare mode string (the original format, still written by
// `pi-mode <mode>`) or an object carrying the mode plus this project's write policy. Both
// are read forever; nothing migrates a state file in place.
function entryOf(state, projectPath) {
  const raw = state[projectPath];
  if (typeof raw === "string") return { mode: raw };
  return raw && typeof raw === "object" ? raw : {};
}

export function getMode(projectPath, file = stateFilePath()) {
  const mode = entryOf(load(file), projectPath).mode;
  return MODES.includes(mode) ? mode : DEFAULT_MODE;
}

// The per-project write policy, or null when the project has none. null is meaningful: it
// tells the guard to fall back to its built-in heuristic rather than to "protect nothing",
// so a mode set outside the guided flow is never silently toothless.
export function getPolicy(projectPath, file = stateFilePath()) {
  const { protect, allow } = entryOf(load(file), projectPath);
  if (!Array.isArray(protect) || protect.length === 0) return null;
  return {
    protect: protect.filter((p) => typeof p === "string" && p !== ""),
    allow: Array.isArray(allow) ? allow.filter((p) => typeof p === "string" && p !== "") : [],
  };
}

function write(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

export function setMode(projectPath, mode, file = stateFilePath()) {
  if (!MODES.includes(mode)) {
    throw new Error(`Invalid mode "${mode}", must be one of: ${MODES.join(" / ")}`);
  }
  const state = load(file);
  const existing = entryOf(state, projectPath);
  // Switching to soft and back to strict must not silently discard a policy the user
  // reviewed and approved — having to re-do that survey is how people end up turning the
  // whole thing off instead.
  state[projectPath] = existing.protect ? { ...existing, mode } : mode;
  write(file, state);
}

export function setPolicy(projectPath, { protect, allow = [] }, file = stateFilePath()) {
  if (!Array.isArray(protect) || protect.length === 0) {
    throw new Error("A policy needs at least one protect pattern");
  }
  const state = load(file);
  const existing = entryOf(state, projectPath);
  state[projectPath] = {
    mode: MODES.includes(existing.mode) ? existing.mode : DEFAULT_MODE,
    protect: [...protect],
    allow: [...allow],
  };
  write(file, state);
}

export function clearPolicy(projectPath, file = stateFilePath()) {
  const state = load(file);
  const { mode } = entryOf(state, projectPath);
  state[projectPath] = MODES.includes(mode) ? mode : DEFAULT_MODE;
  write(file, state);
}
