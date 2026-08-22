#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkModels } from "../src/doctor.mjs";
import { getMode } from "../src/modes.mjs";

const modelsPath = join(homedir(), ".pi", "agent", "models.json");

// 這個 hook 每一次 SessionStart 都會跑，而它讀的正是這個外掛存在的理由 ——
// 一份可能壞掉的 models.json。裸 JSON.parse 會讓「設定壞了，該提醒使用者去修」
// 變成「hook 自己拋例外掛掉」，剛好在最需要它出聲的那一刻閉嘴。
// 降級策略跟 src/modes.mjs 的 load() 一致：解析不了就當成空設定往下走，
// checkModels 會照常把缺的 provider / model 列成問題清單。
function loadModels(file) {
  if (!existsSync(file)) return { providers: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { providers: {} };
  } catch {
    return { providers: {}, __unreadable: true };
  }
}

const cfg = loadModels(modelsPath);
const { ok, problems } = checkModels(cfg);
const mode = getMode(process.cwd());

const lines = [`pi-delegate 模式：${mode}（off / soft / strict 可用 /pi-delegate:mode 切換）`];
if (cfg.__unreadable) {
  lines.push(`⚠️ ${modelsPath} 不是合法 JSON，已當成空設定處理。跑 /pi-delegate:doctor 重建。`);
}
if (!ok) {
  lines.push(`⚠️ pi 設定有 ${problems.length} 個問題，派工會失敗。跑 /pi-delegate:doctor 修復：`);
  for (const problem of problems) lines.push(`  - [${problem.code}] ${problem.message}`);
}

// 信封形狀見 hooks/soft-nudge.mjs 的說明：頂層 additionalContext 會被靜默丟掉。
// 這裡是 SessionStart，所以 hookEventName 必須是 "SessionStart"。
// 注意「JSON 解析失敗會退回純 stdout」那條後路救不了這個 bug —— 這支 hook 吐的是
// 合法 JSON，走的就是 JSON 那條路，欄位認不得就直接被丟掉。
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: lines.join("\n"),
  },
}));
