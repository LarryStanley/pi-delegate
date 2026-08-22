#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { getMode } from "../src/modes.mjs";
import { isProtectedPath } from "../src/guard.mjs";

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
  // soft-nudge 只能提醒、不能擋，解析失敗就沒什麼好做的 —— 靜默退出即可。
  process.exit(0);
}

const cwd = input.cwd ?? process.cwd();
if (getMode(cwd) !== "soft") process.exit(0);

const filePath = input.tool_input?.file_path;
if (!filePath) process.exit(0);

// soft-nudge 是 PostToolUse —— 這時檔案已經寫到磁碟上了，existsSync 永遠是 true，
// 會把「剛新建的檔案」也誤判成「既有產品碼」。改用「這個路徑在寫入之前，git 是否已經
// track 它」當作 exists 的替代判準：有 track 過代表寫入前就存在，是既有檔案；
// git 沒 track（新檔案，或根本不是 git repo）一律放行，寧可漏提醒也不要濫提醒。
const existedBefore = (p) => {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", p], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

if (!isProtectedPath(filePath, { cwd, exists: existedBefore })) process.exit(0);

console.log(JSON.stringify({
  additionalContext:
    `提醒：你剛動了 ${filePath}，那是會被 commit 的產品碼 —— 判準是「這是會被 commit 的字元嗎」，` +
    `是就該用 pi_dispatch 派給 pi。下一個同類的編輯請改成寫任務書。`,
}));
