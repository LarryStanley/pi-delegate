// 這個檔案測的是 hooks/*.mjs 腳本本身「餵 stdin JSON、讀 stdout」的行為，
// 不是透過 import 呼叫函式 —— 因為 mode-guard.mjs / soft-nudge.mjs 是頂層 await 的
// 可執行腳本，唯一忠實的測法是真的 spawn 一個 node 子程序模擬 hook 被呼叫的樣子。
//
// 每個測試用獨立的 HOME（讓 os.homedir() 指向一個乾淨的 tmp 目錄）配合
// setMode(project, mode, customStateFile) 寫入該 tmp HOME 下的 modes.json，
// 這樣子程序裡 getMode(cwd) 讀到的狀態跟我們在測試裡設的完全對得上，
// 而且不會動到跑測試這台機器上真正的 ~/.claude/pi-delegate/modes.json。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setMode } from "../src/modes.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODE_GUARD = join(REPO_ROOT, "hooks", "mode-guard.mjs");
const SOFT_NUDGE = join(REPO_ROOT, "hooks", "soft-nudge.mjs");
const DOCTOR_CHECK = join(REPO_ROOT, "hooks", "doctor-check.mjs");

function tmpProject() {
  // macOS 的 tmpdir() 在 /var/folders/... 底下，而 /var 是 /private/var 的 symlink ——
  // 子程序裡的 process.cwd() 會回傳 realpath（/private/var/...），跟我們拿到的原始路徑不一樣。
  // 用 realpathSync 先解開 symlink，確保 setMode 寫入的 key 跟子程序讀到的 process.cwd() 一致。
  return realpathSync(mkdtempSync(join(tmpdir(), "pi-delegate-proj-")));
}

function tmpHome() {
  return mkdtempSync(join(tmpdir(), "pi-delegate-home-"));
}

function stateFileFor(home) {
  return join(home, ".claude", "pi-delegate", "modes.json");
}

function runHook(scriptPath, { cwd, home, stdin }) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd,
    env: { ...process.env, HOME: home },
    input: stdin,
    encoding: "utf8",
  });
}

function gitInit(dir) {
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

// ---- [Important 2] mode-guard 對壞掉的 stdin 要 fail closed ----

test("mode-guard: strict 模式下壞掉的 stdin JSON 會 deny，不是靜默放行", () => {
  const project = tmpProject();
  const home = tmpHome();
  setMode(project, "strict", stateFileFor(home));

  const result = runHook(MODE_GUARD, { cwd: project, home, stdin: "{ 這不是合法 JSON" });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"permissionDecision":"deny"/);
});

test("mode-guard: soft 模式下壞掉的 stdin JSON 靜默退出（不 deny、無輸出）", () => {
  const project = tmpProject();
  const home = tmpHome();
  setMode(project, "soft", stateFileFor(home));

  const result = runHook(MODE_GUARD, { cwd: project, home, stdin: "{ 這不是合法 JSON" });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "");
});

test("mode-guard: 合法 JSON、strict 模式、既有 src 檔仍正常 deny（迴歸）", () => {
  const project = tmpProject();
  const home = tmpHome();
  setMode(project, "strict", stateFileFor(home));
  mkdirSync(join(project, "src"), { recursive: true });
  const filePath = join(project, "src", "existing.ts");
  writeFileSync(filePath, "export const x = 1;\n");

  const payload = JSON.stringify({ cwd: project, tool_input: { file_path: filePath } });
  const result = runHook(MODE_GUARD, { cwd: project, home, stdin: payload });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"permissionDecision":"deny"/);
  assert.match(result.stdout, /existing\.ts/);
});

// ---- [Important 1] soft-nudge 不該對「剛新建的檔案」哭狼來了 ----

test("soft-nudge: 新建（git 未 track）的 src/*.ts 保持靜默", () => {
  const project = tmpProject();
  const home = tmpHome();
  gitInit(project);
  mkdirSync(join(project, "src"), { recursive: true });
  const filePath = join(project, "src", "brand-new.ts");
  writeFileSync(filePath, "export const x = 1;\n");
  // 故意不 git add —— 模擬 Write 工具剛新建、還沒進 git index 的檔案
  setMode(project, "soft", stateFileFor(home));

  const payload = JSON.stringify({ cwd: project, tool_input: { file_path: filePath } });
  const result = runHook(SOFT_NUDGE, { cwd: project, home, stdin: payload });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "");
});

test("soft-nudge: 既有（git 已 track）的 src/*.ts 會提醒", () => {
  const project = tmpProject();
  const home = tmpHome();
  gitInit(project);
  mkdirSync(join(project, "src"), { recursive: true });
  const filePath = join(project, "src", "existing.ts");
  writeFileSync(filePath, "export const x = 1;\n");
  spawnSync("git", ["add", "src/existing.ts"], { cwd: project });
  setMode(project, "soft", stateFileFor(home));

  const payload = JSON.stringify({ cwd: project, tool_input: { file_path: filePath } });
  const result = runHook(SOFT_NUDGE, { cwd: project, home, stdin: payload });

  assert.equal(result.status, 0);
  // 只 match /"additionalContext"/ 是不夠的 —— 壞掉的頂層信封同樣會 match（這正是
  // C1 能一路綠燈到最後一次 review 的原因）。這裡改成解析出結構、指名
  // hookSpecificOutput.hookEventName，讓「退回頂層」這件事一定紅。
  // 契約來源是 claude 2.1.239 binary 裡的 zod schema，不是公開文件（文件把
  // additionalContext 畫在頂層，是錯的）；查證過程見 final-fix-report.md。
  const payloadOut = JSON.parse(result.stdout);
  assert.equal(payloadOut.additionalContext, undefined, "additionalContext 不能放在頂層");
  assert.equal(payloadOut.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.equal(typeof payloadOut.hookSpecificOutput.additionalContext, "string");
  assert.match(payloadOut.hookSpecificOutput.additionalContext, /existing\.ts/);
});

test("soft-nudge: 不是 git repo 時對既有檔案也放行（漏提醒比濫提醒安全）", () => {
  const project = tmpProject(); // 沒有 git init
  const home = tmpHome();
  mkdirSync(join(project, "src"), { recursive: true });
  const filePath = join(project, "src", "existing.ts");
  writeFileSync(filePath, "export const x = 1;\n");
  setMode(project, "soft", stateFileFor(home));

  const payload = JSON.stringify({ cwd: project, tool_input: { file_path: filePath } });
  const result = runHook(SOFT_NUDGE, { cwd: project, home, stdin: payload });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "");
});

test("soft-nudge: 壞掉的 stdin JSON 靜默退出", () => {
  const project = tmpProject();
  const home = tmpHome();
  setMode(project, "soft", stateFileFor(home));

  const result = runHook(SOFT_NUDGE, { cwd: project, home, stdin: "not json at all" });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "");
});

// ---- [C2] doctor-check 的 SessionStart 信封 ----

function runDoctorCheck({ cwd, home }) {
  return spawnSync(process.execPath, [DOCTOR_CHECK], {
    cwd,
    env: { ...process.env, HOME: home },
    input: "",
    encoding: "utf8",
  });
}

test("doctor-check: 模式公告與派工目標包在 hookSpecificOutput/SessionStart 裡", () => {
  const project = tmpProject();
  const home = tmpHome();
  setMode(project, "strict", stateFileFor(home));

  const result = runDoctorCheck({ cwd: project, home });

  assert.equal(result.status, 0);
  const out = JSON.parse(result.stdout);
  assert.equal(out.additionalContext, undefined, "additionalContext 不能放在頂層");
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /pi-delegate 模式：strict/);
  assert.match(out.hookSpecificOutput.additionalContext, /派工目標/);
});

// 這個 tmp HOME 底下什麼設定都沒有 —— 那是**正常狀態**（派工會用 pi 自己的預設
// 模型），不是一堆待修的問題。舊版在這個情境會噴 provider-missing / model-missing，
// 也就是對每一個剛裝好外掛的人在每次 SessionStart 噴紅字。
test("doctor-check: 完全沒有設定時不報任何問題", () => {
  const project = tmpProject();
  const home = tmpHome();
  setMode(project, "soft", stateFileFor(home));

  const result = runDoctorCheck({ cwd: project, home });

  assert.equal(result.status, 0);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.ok(!context.includes("⚠️"), `不該有警告：${context}`);
  assert.ok(!context.includes("provider-missing"));
});

// 使用者的 pi 已經設好 defaultProvider / defaultModel（絕大多數人的狀態）——
// 這時 doctor 要如實回報「派工會打到誰」，而不是要求他再設定一次。
test("doctor-check: 回報 pi 自己的預設模型當作派工目標", () => {
  const project = tmpProject();
  const home = tmpHome();
  setMode(project, "soft", stateFileFor(home));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "settings.json"),
    JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-6" }),
  );

  const result = runDoctorCheck({ cwd: project, home });

  assert.equal(result.status, 0);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /anthropic \/ claude-sonnet-4-6/);
  assert.ok(!context.includes("⚠️"), `託管 provider 不該有任何警告：${context}`);
});

test("doctor-check: models.json 壞掉時降級成警告，不是讓 hook 掛掉", () => {
  const project = tmpProject();
  const home = tmpHome();
  setMode(project, "soft", stateFileFor(home));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "models.json"), "{ 這不是合法 JSON");

  const result = runDoctorCheck({ cwd: project, home });

  assert.equal(result.status, 0, `hook 不該非零退出：${result.stderr}`);
  const out = JSON.parse(result.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /不是合法 JSON/);
  assert.match(out.hookSpecificOutput.additionalContext, /pi-delegate 模式：soft/);
});
