import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, extname, basename } from "node:path";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".svelte", ".py"]);
const EXEMPT_PREFIXES = ["tasks/", "scripts/", "docs/"];
const EXEMPT_EXTENSIONS = new Set([".md", ".json", ".toml", ".yaml", ".yml"]);
const SOURCE_DIR = "src";

export function probeFlagPath() {
  return join(homedir(), ".claude", "pi-delegate", "probe-active");
}

export function consumeProbe(file = probeFlagPath()) {
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

// cwd 本身就落在某個 `src` 目錄裡的時候，relative() 會把 `src/` 那一段吃掉
// （cwd=/proj/src、檔案=/proj/src/a.ts → rel="a.ts"），於是 `rel` 永遠不會以
// `src/` 開頭，守門對整個 session 完全失效 —— 而且是全無徵兆的失效：不報錯、
// 不輸出、hook 每次都乾淨地 exit 0。
//
// 兩個選項（loud warning vs 視為受保護）裡選了後者，理由：這道守門是「派工紀律」
// 而不是安全邊界，它的兩種錯代價不對稱。多擋一次很吵，但使用者一個
// `/pi-delegate:probe`（或切 mode）就解掉，而且錯誤是看得見的；漏擋則是整個
// 外掛的前提無聲蒸發，還剛好發生在最容易發生的情境（在 src/ 底下開 Claude）。
// 已知的誤判：專案根目錄本身在某個 `src` 段底下（例如 ~/src/myproj），那整個
// 專案的原始碼都會被視為受保護。同樣用 probe / mode 解，代價可接受。
function cwdInsideSourceDir(cwd) {
  return String(cwd)
    .split(/[/\\]+/)
    .some((segment) => segment.toLowerCase() === SOURCE_DIR);
}

export function isProtectedPath(filePath, { cwd, exists = existsSync } = {}) {
  const rel = relative(cwd, filePath);
  if (rel.startsWith("..")) return false;
  if (basename(filePath).startsWith(".")) return false;

  // macOS 的 APFS 預設 case-insensitive：`SRC/foo.ts` 跟 `src/foo.ts` 是同一個
  // 檔案、`foo.TS` 跟 `foo.ts` 也是，但 `startsWith("src/")` 與副檔名 Set 都是
  // 大小寫敏感的 —— 換個大小寫就整個繞過守門。比對一律先轉小寫。
  // 在 case-sensitive 檔案系統上，這會讓真的另外存在的 `SRC/` 目錄也被當成受
  // 保護；跟上面同樣的理由，這個方向的誤判是可接受的那一種。
  const relLower = rel.toLowerCase();
  const ext = extname(filePath).toLowerCase();

  if (EXEMPT_EXTENSIONS.has(ext)) return false;
  if (EXEMPT_PREFIXES.some((prefix) => relLower.startsWith(prefix))) return false;
  if (!relLower.startsWith(`${SOURCE_DIR}/`) && !cwdInsideSourceDir(cwd)) return false;
  if (!SOURCE_EXTENSIONS.has(ext)) return false;

  // 全新檔案放行 —— 從零寫新檔案是 pi 最擅長的形狀，但也不值得為此擋下探針
  return exists(filePath);
}
