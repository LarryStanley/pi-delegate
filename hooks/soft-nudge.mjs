#!/usr/bin/env node
import { getMode } from "../src/modes.mjs";
import { isProtectedPath } from "../src/guard.mjs";

const input = JSON.parse(await new Promise((resolve) => {
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { body += c; });
  process.stdin.on("end", () => resolve(body || "{}"));
}));

const cwd = input.cwd ?? process.cwd();
if (getMode(cwd) !== "soft") process.exit(0);

const filePath = input.tool_input?.file_path;
if (!filePath || !isProtectedPath(filePath, { cwd })) process.exit(0);

console.log(JSON.stringify({
  additionalContext:
    `提醒：你剛動了 ${filePath}，那是會被 commit 的產品碼 —— 判準是「這是會被 commit 的字元嗎」，` +
    `是就該用 pi_dispatch 派給 pi。下一個同類的編輯請改成寫任務書。`,
}));
