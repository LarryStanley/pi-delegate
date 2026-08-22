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
    // 狀態檔損毀不該讓 hook 掛掉 —— 回退到預設模式
    return {};
  }
}

export function getMode(projectPath, file = stateFilePath()) {
  const mode = load(file)[projectPath];
  return MODES.includes(mode) ? mode : DEFAULT_MODE;
}

export function setMode(projectPath, mode, file = stateFilePath()) {
  if (!MODES.includes(mode)) {
    throw new Error(`不合法的模式 "${mode}"，只接受：${MODES.join(" / ")}`);
  }
  const state = load(file);
  state[projectPath] = mode;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}
