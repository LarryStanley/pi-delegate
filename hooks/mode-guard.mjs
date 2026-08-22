#!/usr/bin/env node
import { getMode } from "../src/modes.mjs";
import { isProtectedPath, consumeProbe } from "../src/guard.mjs";

async function readStdin() {
  return new Promise((resolve) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { body += c; });
    process.stdin.on("end", () => resolve(body || "{}"));
  });
}

let input;
try {
  input = JSON.parse(await readStdin());
} catch {
  // stdin 壞掉時，唯一還能問的就是「目前 cwd 是不是 strict」—— 這裡故意 fail closed：
  // 一個解析不了的 hook payload不該悄悄變成「沒意見，放行」，尤其是在 strict 模式。
  if (getMode(process.cwd()) === "strict") {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "mode-guard 無法解析 hook 輸入（stdin 不是合法 JSON）。strict 模式下失敗即擋，" +
          "而非靜默放行。請重試這次寫入；若持續發生，回報 pi-delegate。",
      },
    }));
  }
  process.exit(0);
}

const cwd = input.cwd ?? process.cwd();
if (getMode(cwd) !== "strict") process.exit(0);

const filePath = input.tool_input?.file_path;
if (!filePath || !isProtectedPath(filePath, { cwd })) process.exit(0);

if (consumeProbe()) {
  console.log(JSON.stringify({ systemMessage: `探針放行：${filePath}（旗標已用掉）` }));
  process.exit(0);
}

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason:
      `${filePath} 是既有產品碼。寫一份任務書到 tasks/ 再用 pi_dispatch 派工。` +
      `要親手改請先執行 /pi-delegate:probe 取得一次性放行。`,
  },
}));
