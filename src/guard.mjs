import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, extname, basename } from "node:path";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".svelte", ".py"]);
const EXEMPT_PREFIXES = ["tasks/", "scripts/", "docs/"];
const EXEMPT_EXTENSIONS = new Set([".md", ".json", ".toml", ".yaml", ".yml"]);

export function probeFlagPath() {
  return join(homedir(), ".claude", "pi-delegate", "probe-active");
}

export function consumeProbe(file = probeFlagPath()) {
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

export function isProtectedPath(filePath, { cwd, exists = existsSync } = {}) {
  const rel = relative(cwd, filePath);
  if (rel.startsWith("..")) return false;
  if (basename(filePath).startsWith(".")) return false;

  const ext = extname(filePath);
  if (EXEMPT_EXTENSIONS.has(ext)) return false;
  if (EXEMPT_PREFIXES.some((prefix) => rel.startsWith(prefix))) return false;
  if (!rel.startsWith("src/")) return false;
  if (!SOURCE_EXTENSIONS.has(ext)) return false;

  // 全新檔案放行 —— 從零寫新檔案是 pi 最擅長的形狀，但也不值得為此擋下探針
  return exists(filePath);
}
