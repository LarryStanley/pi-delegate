#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkModels } from "../src/doctor.mjs";
import { getMode } from "../src/modes.mjs";

const modelsPath = join(homedir(), ".pi", "agent", "models.json");
const cfg = existsSync(modelsPath) ? JSON.parse(readFileSync(modelsPath, "utf8")) : { providers: {} };
const { ok, problems } = checkModels(cfg);
const mode = getMode(process.cwd());

const lines = [`pi-delegate 模式：${mode}（off / soft / strict 可用 /pi-delegate:mode 切換）`];
if (!ok) {
  lines.push(`⚠️ pi 設定有 ${problems.length} 個問題，派工會失敗。跑 /pi-delegate:doctor 修復：`);
  for (const problem of problems) lines.push(`  - [${problem.code}] ${problem.message}`);
}

console.log(JSON.stringify({ additionalContext: lines.join("\n") }));
