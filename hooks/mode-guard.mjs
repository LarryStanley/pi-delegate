#!/usr/bin/env node
import { getMode } from "../src/modes.mjs";
import { isProtectedPath, consumeProbe } from "../src/guard.mjs";

const input = JSON.parse(await new Promise((resolve) => {
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { body += c; });
  process.stdin.on("end", () => resolve(body || "{}"));
}));

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
