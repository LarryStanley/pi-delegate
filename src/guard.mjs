import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, dirname, extname, basename } from "node:path";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".svelte", ".py"]);
const EXEMPT_PREFIXES = ["tasks/", "scripts/", "docs/"];
const EXEMPT_EXTENSIONS = new Set([".md", ".json", ".toml", ".yaml", ".yml"]);
const SOURCE_DIR = "src";

// 專案根目錄的判準。這些檔案／目錄的存在是「這裡是一個專案的頂層」最便宜也最可靠
// 的訊號，而且不必知道使用者用什麼語言。
const ROOT_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "deno.json"];

export function probeFlagPath() {
  return join(homedir(), ".claude", "pi-delegate", "probe-active");
}

export function consumeProbe(file = probeFlagPath()) {
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

// 受保護的是**專案根目錄底下那個 `src/`**，不是絕對路徑裡任何一段叫 `src` 的目錄。
//
// 舊版拿 cwd 的每一段去比對 `src`，用意是補一個真實的漏洞：cwd 本身就落在
// `src/` 裡的時候，relative() 會把 `src/` 那一段吃掉（cwd=/proj/src、
// 檔案=/proj/src/a.ts → rel="a.ts"），於是守門對整個 session 靜默失效。
// 但那個補法連 `~/src/<project>` 也一起吃了 —— 一個放在 `~/src/` 底下的專案，
// 整棵樹（含 `lib/`、根目錄的 .ts）都被當成受保護，因為路徑裡剛好有一段 `src`。
//
// 正確的做法是先把專案根目錄找出來（從 cwd 往上找 ROOT_MARKERS），再拿
// **根目錄**去算相對路徑。這同時修好兩個方向：
//   cwd=/proj/src  → root=/proj → rel="src/a.ts"        → 擋（漏洞補上）
//   cwd=~/src/proj → root=~/src/proj → rel="lib/a.ts"   → 放行（誤擋修掉）
//   cwd=~/src/proj → root=~/src/proj → rel="src/a.ts"   → 擋（本來就該擋）
function findProjectRoot(cwd, markerExists) {
  let dir = resolve(String(cwd));
  for (;;) {
    if (ROOT_MARKERS.some((marker) => markerExists(join(dir, marker)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// 找不到任何專案標記時（不是 git repo、也沒有任何 manifest）就退回舊的保守判準。
// 理由跟當初一樣：這道守門是「派工紀律」而不是安全邊界，兩種錯的代價不對稱 ——
// 多擋一次很吵，但一個 `/pi-delegate:probe`（或切 mode）就解掉，而且看得見；
// 漏擋則是整個外掛的前提無聲蒸發。差別在於這條路現在只在「真的無從判斷」時走，
// 而不是對每一個住在 `~/src/` 底下的專案都走。
function cwdInsideSourceDir(cwd) {
  return String(cwd)
    .split(/[/\\]+/)
    .some((segment) => segment.toLowerCase() === SOURCE_DIR);
}

export function isProtectedPath(filePath, { cwd, exists = existsSync, markerExists = existsSync } = {}) {
  const root = findProjectRoot(cwd, markerExists);
  const base = root ?? cwd;
  const rel = relative(base, filePath);
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
  const inSourceDir = relLower === SOURCE_DIR
    || relLower.startsWith(`${SOURCE_DIR}/`)
    || (root === null && cwdInsideSourceDir(cwd));
  if (!inSourceDir) return false;
  if (!SOURCE_EXTENSIONS.has(ext)) return false;

  // 全新檔案放行 —— 從零寫新檔案是 pi 最擅長的形狀，但也不值得為此擋下探針
  return exists(filePath);
}
