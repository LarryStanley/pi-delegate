# pi-delegate Plugin Implementation Plan

> **歷史文件（2026-08-22）。** 這份 spec/plan 記錄的是 v0.1.0 當時的設計，其中把 provider 寫死成
> 一台本機 omlx 伺服器、把兩個 Qwen 模型 id 當成必要模型的部分**已經不是現況**。
> 現在的行為（三層 provider / model 解析、顧問式 pi-doctor）見 `docs/publish-prep-report.md`
> 與 `README.md`。原文保留是為了留下當初的決策理由。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Worktree:** Create an isolated worktree via `superpowers:using-git-worktrees` before Task 1. All tasks land on that branch.

**Goal:** 把 `delegating-to-pi` skill 轉成 Claude Code Plugin，讓 Claude 能以結構化 tool 派工給本機 pi（Qwen3.8 on omlx），並用 hooks 強制執行派工紀律。

**Architecture:** 一個常駐 MCP server，每次派工 spawn 一個 `pi --mode rpc` 子行程並持有其 stdio。判決在 server 端算完再回傳（約 15 行），深入資料由 Claude 按需向 `pi_transcript` / `pi_stats` 索取。紀律由 `PreToolUse` hook 依專案模式（`off`/`soft`/`strict`）執行。

**Tech Stack:** Node.js 26（ESM `.mjs`）、`@modelcontextprotocol/sdk` ^1.30.0、`node:test` 內建測試框架（零額外相依）、`node:child_process` spawn。

**Spec:** `docs/superpowers/specs/2026-08-22-pi-delegate-plugin-design.md`

## Global Constraints

- **Node ≥ 22**，實際開發於 v26.0.0。全部使用 ESM（`.mjs`），不使用 CommonJS。
- **測試框架一律 `node:test` ＋ `node:assert/strict`**，不引入 vitest/jest。
- **唯一 runtime 相依是 `@modelcontextprotocol/sdk`**（^1.30.0）。其餘一律用 Node 內建模組。
- **JSONL 解析只切 `\n`**，剝除可選的 `\r`。**嚴禁使用 `node:readline`** —— 它也會在 U+2028 / U+2029 處斷行，造成靜默資料損毀。
- **pi 沒有 `--cwd` 旗標。** 子行程工作目錄一律用 `spawn(cmd, args, { cwd })` 設定。
- **不使用 `timeout` / `gtimeout` 指令**（macOS 無此指令）。逾時一律用 Node `setTimeout` ＋ `child.kill()`。
- 插件內所有路徑引用使用 `${CLAUDE_PLUGIN_ROOT}`。
- 預設模型 `Qwen3.8-27B-oQ4e-mtp`；預設逾時 `1500` 秒；預設模式 `soft`。
- 狀態目錄 `~/.claude/pi-delegate/`（`modes.json`、`events.log`）。
- omlx baseUrl `http://127.0.0.1:8000/v1`，provider 名稱 **`omlx`**（不是 `omls`）。
- 提交訊息用 Conventional Commits（`feat:` / `fix:` / `test:` / `docs:` / `chore:`）。

---

## File Structure

| 檔案 | 責任 |
|---|---|
| `.claude-plugin/plugin.json` | Plugin 身分 |
| `.mcp.json` | MCP server 註冊 |
| `package.json` | 相依與 test script |
| `src/jsonl.mjs` | JSONL 切分（純函式） |
| `src/verdict.mjs` | 由事件陣列算判決（純函式） |
| `src/modes.mjs` | 專案模式狀態讀寫（純 I/O） |
| `src/doctor.mjs` | `~/.pi/agent/models.json` 檢查與修復 |
| `src/registry.mjs` | session 註冊表（記憶體） |
| `src/dispatch.mjs` | spawn pi、驅動 RPC、逾時控制 |
| `src/server.mjs` | MCP server：7 個 tool |
| `bin/pi-doctor` | `src/doctor.mjs` 的 CLI 包裝 |
| `hooks/hooks.json` | 三個 hook 註冊 |
| `hooks/doctor-check.mjs` | SessionStart：注入模式與設定問題 |
| `hooks/mode-guard.mjs` | PreToolUse：strict 模式擋 Write/Edit |
| `hooks/soft-nudge.mjs` | PostToolUse：soft 模式提醒 |
| `monitors/monitors.json` | 非同步完成通知 |
| `skills/**` | 瘦身版 SKILL.md ＋ 三個 slash skill |
| `test/*.test.mjs` | 對應單元測試 |

分檔原則：`jsonl` / `verdict` / `modes` 都是純函式或純 I/O，可獨立測試不需起子行程；`dispatch` 是唯一碰行程的地方；`server` 只做 tool 定義與分派，不含商業邏輯。

---

## Task 1: 專案骨架 ＋ `pi-doctor`

**Files:**
- Create: `package.json`
- Create: `.claude-plugin/plugin.json`
- Create: `src/doctor.mjs`
- Create: `bin/pi-doctor`
- Test: `test/doctor.test.mjs`

**Interfaces:**
- Consumes: 無（第一個 task）
- Produces:
  - `checkModels(modelsJson: object) => { ok: boolean, problems: Problem[] }`
  - `fixModels(modelsJson: object) => object`（回傳修好的新物件，不改原物件）
  - `Problem = { code: string, message: string, fixable: boolean }`
  - `problem.code` 取值：`"provider-missing"` / `"model-missing"` / `"reasoning-missing"` / `"compat-missing"` / `"drafter-unmarked"`
  - `REQUIRED_MODELS: string[]`、`DRAFTER_MODELS: string[]`

- [ ] **Step 1: 建立 `package.json`**

```json
{
  "name": "pi-delegate",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "node --test test/"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0"
  }
}
```

- [ ] **Step 2: 建立 `.claude-plugin/plugin.json`**

```json
{
  "name": "pi-delegate",
  "version": "0.1.0",
  "description": "把實作與測試派給本機 pi（Qwen3.8 on omlx），並強制執行派工紀律",
  "author": { "name": "stanley" }
}
```

- [ ] **Step 3: 寫失敗測試 `test/doctor.test.mjs`**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkModels, fixModels } from "../src/doctor.mjs";

const EMPTY = { providers: {} };

test("provider 不存在時回報 provider-missing", () => {
  const { ok, problems } = checkModels(EMPTY);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.code === "provider-missing"));
});

test("模型未註冊時回報 model-missing", () => {
  const cfg = { providers: { omlx: { baseUrl: "http://127.0.0.1:8000/v1", models: [] } } };
  const { problems } = checkModels(cfg);
  assert.ok(problems.some((p) => p.code === "model-missing"));
});

test("模型缺 reasoning 與 compat 時各回報一筆", () => {
  const cfg = {
    providers: {
      omlx: {
        baseUrl: "http://127.0.0.1:8000/v1",
        models: [{ id: "Qwen3.8-27B-oQ4e-mtp", name: "Qwen3.8", input: ["text"] }],
      },
    },
  };
  const { problems } = checkModels(cfg);
  assert.ok(problems.some((p) => p.code === "reasoning-missing"));
  assert.ok(problems.some((p) => p.code === "compat-missing"));
});

test("fixModels 補齊後 checkModels 全綠", () => {
  const fixed = fixModels(EMPTY);
  const { ok, problems } = checkModels(fixed);
  assert.equal(ok, true, JSON.stringify(problems));
});

test("fixModels 不改動傳入物件", () => {
  const input = { providers: {} };
  fixModels(input);
  assert.deepEqual(input, { providers: {} });
});

test("fixModels 補上的模型帶正確的 enable_thinking 綁定", () => {
  const fixed = fixModels(EMPTY);
  const m = fixed.providers.omlx.models.find((x) => x.id === "Qwen3.8-27B-oQ4e-mtp");
  assert.equal(m.reasoning, true);
  assert.deepEqual(m.compat.chatTemplateKwargs.enable_thinking, { $var: "thinking.enabled" });
});

test("drafter 模型被標記為不可派工", () => {
  const fixed = fixModels({
    providers: { omlx: { baseUrl: "http://127.0.0.1:8000/v1", models: [{ id: "Qwen3.6-27B-DFlash-draft" }] } },
  });
  const d = fixed.providers.omlx.models.find((x) => x.id === "Qwen3.6-27B-DFlash-draft");
  assert.equal(d["x-pi-delegate-forbidden"], true);
});

test("fixModels 保留既有的其他 provider", () => {
  const fixed = fixModels({ providers: { litellm: { baseUrl: "https://example/v1", models: [] } } });
  assert.ok(fixed.providers.litellm);
});
```

- [ ] **Step 4: 跑測試確認失敗**

Run: `node --test test/doctor.test.mjs`
Expected: FAIL — `Cannot find module '../src/doctor.mjs'`

- [ ] **Step 5: 實作 `src/doctor.mjs`**

```javascript
export const OMLX_BASE_URL = "http://127.0.0.1:8000/v1";
export const PROVIDER = "omlx";

export const REQUIRED_MODELS = [
  { id: "Qwen3.8-27B-oQ4e-mtp", name: "Qwen3.8 27B oQ4e MTP", contextWindow: 262144, maxTokens: 32768 },
  { id: "Qwen3.6-35B-A3B-4bit", name: "Qwen3.6 35B A3B 4bit", contextWindow: 262144, maxTokens: 32768 },
];

export const DRAFTER_MODELS = ["Qwen3.6-27B-DFlash-draft", "gemma-4-26B-A4B-it-assistant-bf16"];

const THINKING_BINDING = { $var: "thinking.enabled" };

function hasThinkingBinding(model) {
  const bound = model?.compat?.chatTemplateKwargs?.enable_thinking;
  return JSON.stringify(bound) === JSON.stringify(THINKING_BINDING);
}

export function checkModels(cfg) {
  const problems = [];
  const provider = cfg?.providers?.[PROVIDER];

  if (!provider) {
    problems.push({
      code: "provider-missing",
      message: `~/.pi/agent/models.json 沒有 "${PROVIDER}" provider（腳本常誤寫成 "omls"）`,
      fixable: true,
    });
    return { ok: false, problems };
  }

  const models = provider.models ?? [];
  for (const required of REQUIRED_MODELS) {
    const found = models.find((m) => m.id === required.id);
    if (!found) {
      problems.push({ code: "model-missing", message: `模型 ${required.id} 未註冊`, fixable: true });
      continue;
    }
    if (found.reasoning !== true) {
      problems.push({
        code: "reasoning-missing",
        message: `${required.id} 缺 reasoning:true —— --thinking off 會靜默失效`,
        fixable: true,
      });
    }
    if (!hasThinkingBinding(found)) {
      problems.push({
        code: "compat-missing",
        message: `${required.id} 缺 compat.chatTemplateKwargs.enable_thinking 綁定 —— --thinking off 會靜默失效`,
        fixable: true,
      });
    }
  }

  for (const id of DRAFTER_MODELS) {
    const found = models.find((m) => m.id === id);
    if (found && found["x-pi-delegate-forbidden"] !== true) {
      problems.push({
        code: "drafter-unmarked",
        message: `${id} 是副駕駛模型，直接呼叫會 500，應標記為不可派工`,
        fixable: true,
      });
    }
  }

  return { ok: problems.length === 0, problems };
}

export function fixModels(cfg) {
  const next = structuredClone(cfg ?? {});
  next.providers ??= {};
  next.providers[PROVIDER] ??= { api: "openai-completions", baseUrl: OMLX_BASE_URL, apiKey: "not-needed", models: [] };

  const provider = next.providers[PROVIDER];
  provider.baseUrl ??= OMLX_BASE_URL;
  provider.models ??= [];

  for (const required of REQUIRED_MODELS) {
    let model = provider.models.find((m) => m.id === required.id);
    if (!model) {
      model = { id: required.id, name: required.name, input: ["text", "image"] };
      provider.models.push(model);
    }
    model.contextWindow ??= required.contextWindow;
    model.maxTokens ??= required.maxTokens;
    model.reasoning = true;
    model.compat ??= {};
    model.compat.chatTemplateKwargs ??= {};
    model.compat.chatTemplateKwargs.enable_thinking = { ...THINKING_BINDING };
  }

  for (const id of DRAFTER_MODELS) {
    const model = provider.models.find((m) => m.id === id);
    if (model) model["x-pi-delegate-forbidden"] = true;
  }

  return next;
}
```

- [ ] **Step 6: 跑測試確認通過**

Run: `node --test test/doctor.test.mjs`
Expected: PASS（8 tests）

- [ ] **Step 7: 實作 `bin/pi-doctor`**

```javascript
#!/usr/bin/env node
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { checkModels, fixModels } from "../src/doctor.mjs";

const MODELS_PATH = join(homedir(), ".pi", "agent", "models.json");
const mode = process.argv.includes("--fix") ? "fix" : "check";

function load() {
  if (!existsSync(MODELS_PATH)) return { providers: {} };
  return JSON.parse(readFileSync(MODELS_PATH, "utf8"));
}

const cfg = load();
const { ok, problems } = checkModels(cfg);

if (mode === "check") {
  console.log(JSON.stringify({ ok, problems, models_path: MODELS_PATH }, null, 2));
  process.exit(ok ? 0 : 1);
}

if (ok) {
  console.log(JSON.stringify({ ok: true, changed: false }, null, 2));
  process.exit(0);
}

if (existsSync(MODELS_PATH)) {
  copyFileSync(MODELS_PATH, `${MODELS_PATH}.pi-delegate.bak`);
} else {
  mkdirSync(dirname(MODELS_PATH), { recursive: true });
}
writeFileSync(MODELS_PATH, `${JSON.stringify(fixModels(cfg), null, 2)}\n`);
console.log(JSON.stringify({ ok: true, changed: true, fixed: problems.map((p) => p.code) }, null, 2));
```

- [ ] **Step 8: 手動驗證 `--check` 在真實環境回報現有問題**

Run: `chmod +x bin/pi-doctor && node bin/pi-doctor --check; echo "exit=$?"`
Expected: exit=1，`problems` 含 `model-missing`（`Qwen3.8-27B-oQ4e-mtp` 目前確實未註冊）

- [ ] **Step 9: Commit**

```bash
git add package.json .claude-plugin/plugin.json src/doctor.mjs bin/pi-doctor test/doctor.test.mjs
git commit -m "feat: pi-doctor 檢查與修復 pi models.json 設定"
```

---

## Task 2: `src/jsonl.mjs` —— 嚴格 LF 切分

**Files:**
- Create: `src/jsonl.mjs`
- Test: `test/jsonl.test.mjs`

**Interfaces:**
- Consumes: 無
- Produces: `createJsonlSplitter() => (chunk: string) => string[]`
  有狀態的閉包，餵入任意切割的字串片段，吐出完整的行（不含換行符，已剝 `\r`，跳過空行）

- [ ] **Step 1: 寫失敗測試 `test/jsonl.test.mjs`**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJsonlSplitter } from "../src/jsonl.mjs";

test("單一完整行", () => {
  const push = createJsonlSplitter();
  assert.deepEqual(push('{"a":1}\n'), ['{"a":1}']);
});

test("跨 chunk 的行會被接起來", () => {
  const push = createJsonlSplitter();
  assert.deepEqual(push('{"a":'), []);
  assert.deepEqual(push('1}\n'), ['{"a":1}']);
});

test("一個 chunk 含多行", () => {
  const push = createJsonlSplitter();
  assert.deepEqual(push('{"a":1}\n{"b":2}\n'), ['{"a":1}', '{"b":2}']);
});

test("剝除 CRLF 的 \\r", () => {
  const push = createJsonlSplitter();
  assert.deepEqual(push('{"a":1}\r\n'), ['{"a":1}']);
});

test("跳過空行", () => {
  const push = createJsonlSplitter();
  assert.deepEqual(push('\n{"a":1}\n\n'), ['{"a":1}']);
});

test("不在 U+2028 行分隔符處斷行", () => {
  const push = createJsonlSplitter();
  // JSON.stringify 會原樣輸出 U+2028（實測不轉義），所以 pi 的事件真的可能含它。
  const line = JSON.stringify({ text: "a\u2028b" });
  assert.ok(line.includes("\u2028"), "前提：這一行真的含 U+2028");
  assert.deepEqual(push(`${line}\n`), [line]);
});

test("不在 U+2029 段落分隔符處斷行", () => {
  const push = createJsonlSplitter();
  const line = JSON.stringify({ text: "a\u2029b" });
  assert.ok(line.includes("\u2029"), "前提：這一行真的含 U+2029");
  assert.deepEqual(push(`${line}\n`), [line]);
});

test("未完成的尾段留在緩衝區", () => {
  const push = createJsonlSplitter();
  push('{"a":1}\n{"b":');
  assert.deepEqual(push('2}\n'), ['{"b":2}']);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test test/jsonl.test.mjs`
Expected: FAIL — `Cannot find module '../src/jsonl.mjs'`

- [ ] **Step 3: 實作 `src/jsonl.mjs`**

```javascript
// 嚴格 LF 分隔。**不可**改用 node:readline —— 它也會在 U+2028 / U+2029
// 處斷行，會把 JSON payload 內含這些字元的行切壞，而且是靜默的。
export function createJsonlSplitter() {
  let buffer = "";

  return function push(chunk) {
    buffer += chunk;
    const lines = [];
    let index;

    while ((index = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) lines.push(line);
    }

    return lines;
  };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test test/jsonl.test.mjs`
Expected: PASS（8 tests）

- [ ] **Step 5: Commit**

```bash
git add src/jsonl.mjs test/jsonl.test.mjs
git commit -m "feat: 嚴格 LF 的 JSONL 切分器"
```

---

## Task 3: `src/verdict.mjs` —— 判決計算

**Files:**
- Create: `src/verdict.mjs`
- Test: `test/verdict.test.mjs`

**Interfaces:**
- Consumes: 無（純函式，輸入為已解析的事件陣列）
- Produces:
  ```
  computeVerdict({
    events: object[],      // 已 JSON.parse 的 pi 事件
    aborted: boolean,
    timedOut: boolean,
    exitCode: number | null,
    requestedFiles: string[],   // 任務書點名的檔案
    gitDiffStat: string,
    durationS: number,
    sessionId: string,
  }) => Verdict
  ```
  ```
  Verdict = {
    status: "completed" | "timeout" | "aborted" | "failed",
    write_count: number,
    files_written: string[],
    files_read_unrequested: string[],
    git_diff_stat: string,
    duration_s: number,
    tokens: { input: number, output: number },
    session_id: string,
    last_message: string,        // 已截斷至 1000 字元
    last_message_truncated: boolean,
  }
  ```
  另導出 `LAST_MESSAGE_LIMIT = 1000` 與 `formatVerdict(v) => string`（約 15 行純文字）

**判決規則**（spec §7，順序不可顛倒）：
1. `aborted` 為 true → `"aborted"`
2. `timedOut` 為 true → `"timeout"`
3. 事件中出現 `agent_settled` → `"completed"`
4. 其餘 → `"failed"`

`write_count` 必須以 `tool_execution_start.toolCallId` **去重後**再數 —— 一次 tool call 會噴 3–4 個事件，直接數會把「4 個檔各寫 1 次」誤讀成 12 次。

- [ ] **Step 1: 寫失敗測試 `test/verdict.test.mjs`**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeVerdict, formatVerdict, LAST_MESSAGE_LIMIT } from "../src/verdict.mjs";

const BASE = {
  events: [],
  aborted: false,
  timedOut: false,
  exitCode: 0,
  requestedFiles: [],
  gitDiffStat: "",
  durationS: 1,
  sessionId: "s1",
};

const settled = { type: "agent_settled" };

function writeStart(id, path) {
  return { type: "tool_execution_start", toolCallId: id, toolName: "write", args: { path } };
}
function readStart(id, path) {
  return { type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path } };
}

test("有 agent_settled 就是 completed", () => {
  const v = computeVerdict({ ...BASE, events: [settled] });
  assert.equal(v.status, "completed");
});

test("timedOut 優先於 agent_settled 之外的一切，但 aborted 更優先", () => {
  assert.equal(computeVerdict({ ...BASE, timedOut: true }).status, "timeout");
  assert.equal(computeVerdict({ ...BASE, timedOut: true, aborted: true }).status, "aborted");
});

test("沒有 agent_settled 且未逾時未中止就是 failed", () => {
  assert.equal(computeVerdict({ ...BASE, exitCode: 1 }).status, "failed");
});

test("write_count 以 toolCallId 去重，重複事件不重複計數", () => {
  const events = [
    writeStart("c1", "a.ts"),
    { type: "tool_execution_update", toolCallId: "c1", toolName: "write", args: { path: "a.ts" } },
    { type: "tool_execution_end", toolCallId: "c1", toolName: "write", result: {}, isError: false },
    writeStart("c2", "b.ts"),
    settled,
  ];
  const v = computeVerdict({ ...BASE, events });
  assert.equal(v.write_count, 2);
  assert.deepEqual(v.files_written, ["a.ts", "b.ts"]);
});

test("edit 與 write 都計入 write_count", () => {
  const events = [
    writeStart("c1", "a.ts"),
    { type: "tool_execution_start", toolCallId: "c2", toolName: "edit", args: { path: "b.ts" } },
    settled,
  ];
  assert.equal(computeVerdict({ ...BASE, events }).write_count, 2);
});

test("讀到任務書沒點名的檔案會列入 files_read_unrequested", () => {
  const events = [readStart("r1", "src/a.ts"), readStart("r2", "src/other.ts"), settled];
  const v = computeVerdict({ ...BASE, events, requestedFiles: ["src/a.ts"] });
  assert.deepEqual(v.files_read_unrequested, ["src/other.ts"]);
});

test("最後一則 assistant 訊息超過上限時截斷並標記", () => {
  const long = "x".repeat(LAST_MESSAGE_LIMIT + 50);
  const events = [
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: long }] } },
    settled,
  ];
  const v = computeVerdict({ ...BASE, events });
  assert.equal(v.last_message.length, LAST_MESSAGE_LIMIT);
  assert.equal(v.last_message_truncated, true);
});

test("最後一則訊息在上限內時不截斷", () => {
  const events = [
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    settled,
  ];
  const v = computeVerdict({ ...BASE, events });
  assert.equal(v.last_message, "done");
  assert.equal(v.last_message_truncated, false);
});

test("取的是最後一則 assistant 訊息，不是第一則", () => {
  const mk = (t) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: t }] } });
  const v = computeVerdict({ ...BASE, events: [mk("first"), mk("last"), settled] });
  assert.equal(v.last_message, "last");
});

test("token 用量取最後一個 message_update 的累計值", () => {
  const events = [
    { type: "message_update", usage: { input: 10, output: 1 } },
    { type: "message_update", usage: { input: 100, output: 42 } },
    settled,
  ];
  const v = computeVerdict({ ...BASE, events });
  assert.deepEqual(v.tokens, { input: 100, output: 42 });
});

test("逾時仍附上 git_diff_stat（逾時不等於沒做事）", () => {
  const v = computeVerdict({ ...BASE, timedOut: true, gitDiffStat: "1 file changed, 3 insertions(+)" });
  assert.equal(v.status, "timeout");
  assert.equal(v.git_diff_stat, "1 file changed, 3 insertions(+)");
});

test("formatVerdict 輸出不超過 20 行且含所有欄位", () => {
  const v = computeVerdict({ ...BASE, events: [settled] });
  const text = formatVerdict(v);
  assert.ok(text.split("\n").length <= 20);
  for (const key of ["status", "write_count", "session_id", "last_message"]) {
    assert.ok(text.includes(key), `缺欄位 ${key}`);
  }
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test test/verdict.test.mjs`
Expected: FAIL — `Cannot find module '../src/verdict.mjs'`

- [ ] **Step 3: 實作 `src/verdict.mjs`**

```javascript
export const LAST_MESSAGE_LIMIT = 1000;

const WRITE_TOOLS = new Set(["write", "edit"]);
const READ_TOOLS = new Set(["read"]);

function toolPath(args) {
  return args?.path ?? args?.file_path ?? args?.filePath ?? null;
}

// 一次 tool call 會噴 3–4 個事件（start / update* / end）。只看 start 並以
// toolCallId 去重，否則會把「4 個檔各動 1 次」誤讀成 12 次。
function uniqueToolCalls(events, toolNames) {
  const seen = new Map();
  for (const event of events) {
    if (event?.type !== "tool_execution_start") continue;
    if (!toolNames.has(event.toolName)) continue;
    if (seen.has(event.toolCallId)) continue;
    seen.set(event.toolCallId, toolPath(event.args));
  }
  return [...seen.values()].filter((p) => p !== null);
}

function lastAssistantText(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== "message_end") continue;
    if (event.message?.role !== "assistant") continue;
    const content = event.message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    if (text) return text;
  }
  return "";
}

function lastUsage(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const usage = events[i]?.usage;
    if (usage) return { input: usage.input ?? 0, output: usage.output ?? 0 };
  }
  return { input: 0, output: 0 };
}

function resolveStatus({ aborted, timedOut, events }) {
  if (aborted) return "aborted";
  if (timedOut) return "timeout";
  if (events.some((e) => e?.type === "agent_settled")) return "completed";
  return "failed";
}

export function computeVerdict({
  events = [],
  aborted = false,
  timedOut = false,
  exitCode = null,
  requestedFiles = [],
  gitDiffStat = "",
  durationS = 0,
  sessionId = "",
}) {
  const filesWritten = uniqueToolCalls(events, WRITE_TOOLS);
  const filesRead = uniqueToolCalls(events, READ_TOOLS);
  const requested = new Set(requestedFiles);

  const raw = lastAssistantText(events);
  const truncated = raw.length > LAST_MESSAGE_LIMIT;

  return {
    status: resolveStatus({ aborted, timedOut, events }),
    write_count: filesWritten.length,
    files_written: filesWritten,
    files_read_unrequested: filesRead.filter((p) => !requested.has(p)),
    git_diff_stat: gitDiffStat,
    duration_s: durationS,
    tokens: lastUsage(events),
    session_id: sessionId,
    last_message: truncated ? raw.slice(0, LAST_MESSAGE_LIMIT) : raw,
    last_message_truncated: truncated,
    exit_code: exitCode,
  };
}

export function formatVerdict(v) {
  const list = (arr) => (arr.length ? arr.join(", ") : "(none)");
  return [
    `status:                 ${v.status}`,
    `write_count:            ${v.write_count}`,
    `files_written:          ${list(v.files_written)}`,
    `files_read_unrequested: ${list(v.files_read_unrequested)}`,
    `git_diff_stat:          ${v.git_diff_stat || "(none)"}`,
    `duration_s:             ${v.duration_s}`,
    `tokens:                 in ${v.tokens.input} / out ${v.tokens.output}`,
    `session_id:             ${v.session_id}`,
    `last_message:${v.last_message_truncated ? " (截斷，完整內容用 pi_transcript)" : ""}`,
    v.last_message || "(empty)",
  ].join("\n");
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test test/verdict.test.mjs`
Expected: PASS（12 tests）

- [ ] **Step 5: Commit**

```bash
git add src/verdict.mjs test/verdict.test.mjs
git commit -m "feat: 由 pi 事件流計算派工判決"
```

---

## Task 4: `src/modes.mjs` —— 專案模式狀態

**Files:**
- Create: `src/modes.mjs`
- Test: `test/modes.test.mjs`

**Interfaces:**
- Consumes: 無
- Produces:
  - `MODES = ["off", "soft", "strict"]`、`DEFAULT_MODE = "soft"`
  - `stateFilePath() => string`（`~/.claude/pi-delegate/modes.json`）
  - `getMode(projectPath, file?) => "off" | "soft" | "strict"`
  - `setMode(projectPath, mode, file?) => void`（mode 不合法時 throw）
  - 兩個函式的 `file` 參數預設 `stateFilePath()`，測試時注入暫存路徑

- [ ] **Step 1: 寫失敗測試 `test/modes.test.mjs`**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMode, setMode, DEFAULT_MODE, MODES } from "../src/modes.mjs";

function tmpState() {
  return join(mkdtempSync(join(tmpdir(), "pi-delegate-")), "modes.json");
}

test("未設定過的專案回傳預設模式 soft", () => {
  assert.equal(getMode("/x/y", tmpState()), DEFAULT_MODE);
  assert.equal(DEFAULT_MODE, "soft");
});

test("setMode 之後 getMode 讀得到", () => {
  const file = tmpState();
  setMode("/x/y", "strict", file);
  assert.equal(getMode("/x/y", file), "strict");
});

test("不同專案互不影響", () => {
  const file = tmpState();
  setMode("/a", "strict", file);
  setMode("/b", "off", file);
  assert.equal(getMode("/a", file), "strict");
  assert.equal(getMode("/b", file), "off");
});

test("不合法的模式會 throw", () => {
  assert.throws(() => setMode("/x", "turbo", tmpState()), /turbo/);
});

test("三個合法模式都接受", () => {
  const file = tmpState();
  for (const mode of MODES) {
    setMode("/x", mode, file);
    assert.equal(getMode("/x", file), mode);
  }
});

test("狀態檔損毀時回退到預設而不是 throw", () => {
  const file = tmpState();
  writeFileSync(file, "{ not json");
  assert.equal(getMode("/x", file), DEFAULT_MODE);
});

test("寫入的是可讀的 JSON，key 為專案路徑", () => {
  const file = tmpState();
  setMode("/Users/s/Code/foo", "strict", file);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { "/Users/s/Code/foo": "strict" });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test test/modes.test.mjs`
Expected: FAIL — `Cannot find module '../src/modes.mjs'`

- [ ] **Step 3: 實作 `src/modes.mjs`**

```javascript
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const MODES = ["off", "soft", "strict"];
export const DEFAULT_MODE = "soft";

export function stateFilePath() {
  return join(homedir(), ".claude", "pi-delegate", "modes.json");
}

function load(file) {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // 狀態檔損毀不該讓 hook 掛掉 —— 回退到預設模式
    return {};
  }
}

export function getMode(projectPath, file = stateFilePath()) {
  const mode = load(file)[projectPath];
  return MODES.includes(mode) ? mode : DEFAULT_MODE;
}

export function setMode(projectPath, mode, file = stateFilePath()) {
  if (!MODES.includes(mode)) {
    throw new Error(`不合法的模式 "${mode}"，只接受：${MODES.join(" / ")}`);
  }
  const state = load(file);
  state[projectPath] = mode;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test test/modes.test.mjs`
Expected: PASS（7 tests）

- [ ] **Step 5: Commit**

```bash
git add src/modes.mjs test/modes.test.mjs
git commit -m "feat: 專案層級的派工模式狀態"
```

---

## Task 5: `src/registry.mjs` —— session 註冊表

**Files:**
- Create: `src/registry.mjs`
- Test: `test/registry.test.mjs`

**Interfaces:**
- Consumes: 無
- Produces:
  - `createRegistry() => Registry`
  - `Registry.add(sessionId, entry) => void`
  - `Registry.get(sessionId) => Entry`（不存在時 throw，訊息含所有有效 id）
  - `Registry.has(sessionId) => boolean`
  - `Registry.update(sessionId, patch) => Entry`
  - `Registry.ids() => string[]`
  - `Entry = { child, cwd, taskFile, model, status, startedAt, events, verdict, aborted, timedOut }`

- [ ] **Step 1: 寫失敗測試 `test/registry.test.mjs`**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../src/registry.mjs";

test("add 之後 get 拿得到", () => {
  const r = createRegistry();
  r.add("s1", { cwd: "/x", status: "running" });
  assert.equal(r.get("s1").cwd, "/x");
});

test("get 不存在的 id 會 throw 且訊息列出有效 id", () => {
  const r = createRegistry();
  r.add("alpha", { status: "running" });
  assert.throws(() => r.get("ghost"), /alpha/);
});

test("has 正確回報存在與否", () => {
  const r = createRegistry();
  r.add("s1", {});
  assert.equal(r.has("s1"), true);
  assert.equal(r.has("s2"), false);
});

test("update 只覆蓋指定欄位並回傳新狀態", () => {
  const r = createRegistry();
  r.add("s1", { cwd: "/x", status: "running" });
  const next = r.update("s1", { status: "done" });
  assert.equal(next.status, "done");
  assert.equal(next.cwd, "/x");
});

test("ids 列出所有 session", () => {
  const r = createRegistry();
  r.add("a", {});
  r.add("b", {});
  assert.deepEqual(r.ids().sort(), ["a", "b"]);
});

test("重複 add 同一個 id 會 throw", () => {
  const r = createRegistry();
  r.add("s1", {});
  assert.throws(() => r.add("s1", {}), /s1/);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test test/registry.test.mjs`
Expected: FAIL — `Cannot find module '../src/registry.mjs'`

- [ ] **Step 3: 實作 `src/registry.mjs`**

```javascript
export function createRegistry() {
  const sessions = new Map();

  function get(sessionId) {
    if (!sessions.has(sessionId)) {
      const known = [...sessions.keys()];
      throw new Error(
        `未知的 session_id "${sessionId}"。目前有效的：${known.length ? known.join(", ") : "(無)"}`,
      );
    }
    return sessions.get(sessionId);
  }

  return {
    add(sessionId, entry) {
      if (sessions.has(sessionId)) throw new Error(`session_id "${sessionId}" 已存在`);
      sessions.set(sessionId, { ...entry });
    },
    get,
    has: (sessionId) => sessions.has(sessionId),
    update(sessionId, patch) {
      const next = { ...get(sessionId), ...patch };
      sessions.set(sessionId, next);
      return next;
    },
    ids: () => [...sessions.keys()],
  };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test test/registry.test.mjs`
Expected: PASS（6 tests）

- [ ] **Step 5: Commit**

```bash
git add src/registry.mjs test/registry.test.mjs
git commit -m "feat: session 註冊表"
```

---

## Task 6: `src/dispatch.mjs` —— spawn pi 並驅動 RPC

**Files:**
- Create: `src/dispatch.mjs`
- Create: `test/fixtures/fake-pi.mjs`
- Test: `test/dispatch.test.mjs`

**Interfaces:**
- Consumes: `createJsonlSplitter`（Task 2）、`computeVerdict`（Task 3）
- Produces:
  - `buildPiArgs({ model, sessionId }) => string[]`
  - `dispatch({ taskFile, cwd, model, timeoutS, sessionId, piCommand?, gitDiffStat? }) => Promise<{ handle, done }>`
    - `handle = { sessionId, steer(msg), abort(), state() }`
    - `done` 是 Promise，resolve 成 Verdict
    - `piCommand` 預設 `["pi"]`，測試時注入 `["node", "test/fixtures/fake-pi.mjs"]`

**關鍵約束**：
- **不呼叫 `timeout` 指令**，用 `setTimeout` ＋ `child.kill("SIGTERM")`，2 秒後仍在則 `SIGKILL`
- **pi 沒有 `--cwd`**，用 `spawn(cmd, args, { cwd })`
- **不帶 `--no-session`**，改 `--session-id`，否則 `pi_transcript` / `pi_stats` 事後無資料可讀

- [ ] **Step 1: 寫失敗測試 `test/dispatch.test.mjs`**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPiArgs, dispatch } from "../src/dispatch.mjs";

const FAKE_PI = ["node", "test/fixtures/fake-pi.mjs"];

function tmpTask(body = "改 a.ts") {
  const dir = mkdtempSync(join(tmpdir(), "pi-task-"));
  const file = join(dir, "TASK.md");
  writeFileSync(file, body);
  return { dir, file };
}

test("buildPiArgs 帶上必要旗標", () => {
  const args = buildPiArgs({ model: "M", sessionId: "s1" });
  assert.ok(args.includes("--mode") && args.includes("rpc"));
  assert.ok(args.includes("--provider") && args.includes("omlx"));
  assert.ok(args.includes("--model") && args.includes("M"));
  assert.ok(args.includes("--thinking") && args.includes("off"));
  assert.ok(args.includes("--tools") && args.includes("read,write,edit"));
  assert.ok(args.includes("--no-context-files"));
  assert.ok(args.includes("--no-skills"));
  assert.ok(args.includes("--no-extensions"));
  assert.ok(args.includes("--session-id") && args.includes("s1"));
});

test("buildPiArgs 不得帶 --cwd（pi 沒有這個旗標）", () => {
  assert.ok(!buildPiArgs({ model: "M", sessionId: "s" }).includes("--cwd"));
});

test("buildPiArgs 不得帶 --no-session（會讓 drill-down 無資料）", () => {
  assert.ok(!buildPiArgs({ model: "M", sessionId: "s" }).includes("--no-session"));
});

test("不給 bash 工具", () => {
  const args = buildPiArgs({ model: "M", sessionId: "s" });
  const tools = args[args.indexOf("--tools") + 1];
  assert.ok(!tools.split(",").includes("bash"));
});

test("正常結束回傳 completed 判決", async () => {
  const { dir, file } = tmpTask();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, model: "M", timeoutS: 10,
    sessionId: "s1", piCommand: FAKE_PI, gitDiffStat: "",
  });
  const verdict = await done;
  assert.equal(verdict.status, "completed");
  assert.equal(verdict.session_id, "s1");
});

test("逾時回傳 timeout 判決且仍附 git_diff_stat", async () => {
  const { dir, file } = tmpTask();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, model: "M", timeoutS: 1,
    sessionId: "s2", piCommand: [...FAKE_PI, "--hang"],
    gitDiffStat: "1 file changed",
  });
  const verdict = await done;
  assert.equal(verdict.status, "timeout");
  assert.equal(verdict.git_diff_stat, "1 file changed");
});

test("abort 回傳 aborted 判決", async () => {
  const { dir, file } = tmpTask();
  const { handle, done } = await dispatch({
    taskFile: file, cwd: dir, model: "M", timeoutS: 30,
    sessionId: "s3", piCommand: [...FAKE_PI, "--hang"], gitDiffStat: "",
  });
  await handle.abort();
  assert.equal((await done).status, "aborted");
});

test("write 事件反映在判決的 write_count", async () => {
  const { dir, file } = tmpTask();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, model: "M", timeoutS: 10,
    sessionId: "s4", piCommand: [...FAKE_PI, "--write=a.ts,b.ts"], gitDiffStat: "",
  });
  const verdict = await done;
  assert.equal(verdict.write_count, 2);
  assert.deepEqual(verdict.files_written, ["a.ts", "b.ts"]);
});

test("steer 會把訊息送進子行程的 stdin", async () => {
  const { dir, file } = tmpTask();
  const { handle, done } = await dispatch({
    taskFile: file, cwd: dir, model: "M", timeoutS: 10,
    sessionId: "s5", piCommand: [...FAKE_PI, "--echo-steer"], gitDiffStat: "",
  });
  await handle.steer("往左一點");
  const verdict = await done;
  assert.ok(verdict.last_message.includes("往左一點"));
});
```

- [ ] **Step 2: 寫測試替身 `test/fixtures/fake-pi.mjs`**

```javascript
#!/usr/bin/env node
// pi --mode rpc 的最小替身。只實作測試需要的行為。
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (prefix) => {
  const found = args.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
};

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

emit({ type: "session", version: 3, id: "fake", cwd: process.cwd() });

if (has("--hang")) {
  // 永不結束，等待被 kill 或 abort
  setInterval(() => {}, 1000);
} else {
  const writes = valueOf("--write=");
  if (writes) {
    writes.split(",").forEach((path, index) => {
      emit({ type: "tool_execution_start", toolCallId: `c${index}`, toolName: "write", args: { path } });
      emit({ type: "tool_execution_end", toolCallId: `c${index}`, toolName: "write", result: {}, isError: false });
    });
  }

  if (has("--echo-steer")) {
    let buffer = "";
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const command = JSON.parse(line);
        if (command.type === "steer" || command.type === "prompt") {
          emit({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: `收到：${command.message}` }] },
          });
          emit({ type: "agent_settled" });
          process.exit(0);
        }
      }
    });
  } else {
    emit({ type: "message_update", usage: { input: 10, output: 5 } });
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
    emit({ type: "agent_settled" });
    process.exit(0);
  }
}
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `node --test test/dispatch.test.mjs`
Expected: FAIL — `Cannot find module '../src/dispatch.mjs'`

- [ ] **Step 4: 實作 `src/dispatch.mjs`**

```javascript
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createJsonlSplitter } from "./jsonl.mjs";
import { computeVerdict } from "./verdict.mjs";

export const DEFAULT_MODEL = "Qwen3.8-27B-oQ4e-mtp";
export const DEFAULT_TIMEOUT_S = 1500;
const KILL_GRACE_MS = 2000;

// 旗標理由見 spec §6。不給 bash（給了會漫遊不動手）；--no-context-files 是
// 必要不是最佳化（實測：沒加 = 43 read / 0 write / 逾時；加了 = 93 秒完成）。
// 注意：pi 沒有 --cwd，工作目錄靠 spawn 的 options.cwd。
// 注意：刻意不帶 --no-session，否則 session 不落地，drill-down 讀不到。
export function buildPiArgs({ model, sessionId }) {
  return [
    "--mode", "rpc",
    "--provider", "omlx",
    "--model", model,
    "--thinking", "off",
    "--tools", "read,write,edit",
    "--session-id", sessionId,
    "--no-context-files",
    "--no-skills",
    "--no-extensions",
  ];
}

function extractRequestedFiles(taskFile) {
  try {
    const body = readFileSync(taskFile, "utf8");
    return [...body.matchAll(/[\w./-]+\.(?:ts|tsx|js|jsx|mjs|svelte|py|json|css)\b/g)].map((m) => m[0]);
  } catch {
    return [];
  }
}

export async function dispatch({
  taskFile,
  cwd,
  model = DEFAULT_MODEL,
  timeoutS = DEFAULT_TIMEOUT_S,
  sessionId,
  piCommand = ["pi"],
  gitDiffStat = "",
}) {
  const [command, ...prefixArgs] = piCommand;
  const args = [...prefixArgs, ...buildPiArgs({ model, sessionId })];
  const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });

  const events = [];
  const startedAt = Date.now();
  let aborted = false;
  let timedOut = false;
  let settledResolve;
  const settledPromise = new Promise((resolve) => {
    settledResolve = resolve;
  });

  const push = createJsonlSplitter();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    for (const line of push(chunk)) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // 非 JSON 行忽略（pi 偶爾會印非事件輸出）
      }
    }
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.killed || child.kill("SIGKILL"), KILL_GRACE_MS);
  }, timeoutS * 1000);

  function send(command_) {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(command_)}\n`);
  }

  send({ type: "prompt", message: `讀取 ${taskFile} 並照著做。` });

  child.on("close", (exitCode) => {
    clearTimeout(timer);
    settledResolve(
      computeVerdict({
        events,
        aborted,
        timedOut,
        exitCode,
        requestedFiles: extractRequestedFiles(taskFile),
        gitDiffStat,
        durationS: Math.round((Date.now() - startedAt) / 1000),
        sessionId,
      }),
    );
  });

  child.on("error", (error) => {
    clearTimeout(timer);
    stderr += String(error);
    settledResolve(
      computeVerdict({
        events, aborted, timedOut: false, exitCode: null,
        requestedFiles: [], gitDiffStat,
        durationS: Math.round((Date.now() - startedAt) / 1000),
        sessionId,
      }),
    );
  });

  const handle = {
    sessionId,
    steer(message) {
      send({ type: "steer", message });
    },
    async abort() {
      aborted = true;
      send({ type: "abort" });
      child.kill("SIGTERM");
      setTimeout(() => child.killed || child.kill("SIGKILL"), KILL_GRACE_MS);
    },
    state() {
      return {
        session_id: sessionId,
        running: child.exitCode === null && !child.killed,
        elapsed_s: Math.round((Date.now() - startedAt) / 1000),
        event_count: events.length,
        stderr_tail: stderr.slice(-500),
      };
    },
    events,
  };

  return { handle, done: settledPromise };
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `node --test test/dispatch.test.mjs`
Expected: PASS（9 tests）

- [ ] **Step 6: 跑全部測試確認沒有回歸**

Run: `npm test`
Expected: PASS（全部檔案）

- [ ] **Step 7: Commit**

```bash
git add src/dispatch.mjs test/dispatch.test.mjs test/fixtures/fake-pi.mjs
git commit -m "feat: spawn pi --mode rpc 並驅動派工"
```

---

## Task 7: `src/server.mjs` —— MCP server 與七個 tool

**Files:**
- Create: `src/server.mjs`
- Create: `.mcp.json`
- Test: `test/server.test.mjs`

**Interfaces:**
- Consumes: `dispatch`、`createRegistry`、`formatVerdict`、`DRAFTER_MODELS`
- Produces:
  - `createToolHandlers({ registry, dispatchFn, eventsLogPath, gitDiffStatFn }) => handlers`
  - `handlers` 的 key：`pi_dispatch`、`pi_status`、`pi_steer`、`pi_abort`、`pi_result`、`pi_transcript`、`pi_stats`
  - 每個 handler 簽名 `(args: object) => Promise<{ content: [{ type: "text", text: string }], isError?: boolean }>`
  - `TOOL_DEFINITIONS: Array<{ name, description, inputSchema }>`

- [ ] **Step 1: 寫失敗測試 `test/server.test.mjs`**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "../src/registry.mjs";
import { createToolHandlers, TOOL_DEFINITIONS } from "../src/server.mjs";

function tmpFile(name) {
  return join(mkdtempSync(join(tmpdir(), "pi-srv-")), name);
}

function setup(dispatchFn) {
  const eventsLogPath = tmpFile("events.log");
  return {
    eventsLogPath,
    handlers: createToolHandlers({
      registry: createRegistry(),
      dispatchFn,
      eventsLogPath,
      gitDiffStatFn: () => "1 file changed",
    }),
  };
}

const okVerdict = {
  status: "completed", write_count: 1, files_written: ["a.ts"],
  files_read_unrequested: [], git_diff_stat: "1 file changed", duration_s: 3,
  tokens: { input: 1, output: 2 }, session_id: "s1", last_message: "done",
  last_message_truncated: false,
};

function fakeDispatch(verdict = okVerdict) {
  return async ({ sessionId }) => ({
    handle: { sessionId, steer() {}, async abort() {}, state: () => ({ running: false }) },
    done: Promise.resolve({ ...verdict, session_id: sessionId }),
  });
}

test("TOOL_DEFINITIONS 定義了全部七個 tool", () => {
  const names = TOOL_DEFINITIONS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "pi_abort", "pi_dispatch", "pi_result", "pi_stats",
    "pi_status", "pi_steer", "pi_transcript",
  ]);
});

test("每個 tool 都有非空 description 與 inputSchema", () => {
  for (const tool of TOOL_DEFINITIONS) {
    assert.ok(tool.description?.length > 10, `${tool.name} description 太短`);
    assert.equal(tool.inputSchema.type, "object");
  }
});

test("sync 派工回傳格式化判決而非原始 JSON", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const { handlers } = setup(fakeDispatch());
  const result = await handlers.pi_dispatch({ task_file: task, cwd: "/tmp", mode: "sync" });
  assert.ok(result.content[0].text.includes("status:"));
  assert.ok(!result.content[0].text.trimStart().startsWith("{"));
});

test("async 派工立刻回 session_id", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const { handlers } = setup(fakeDispatch());
  const result = await handlers.pi_dispatch({ task_file: task, cwd: "/tmp", mode: "async" });
  assert.match(result.content[0].text, /session_id/);
});

test("async 完成後寫一行到 events.log", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const { handlers, eventsLogPath } = setup(fakeDispatch());
  await handlers.pi_dispatch({ task_file: task, cwd: "/tmp", mode: "async" });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(eventsLogPath));
  assert.match(readFileSync(eventsLogPath, "utf8"), /completed/);
});

test("派工給 drafter 模型會被拒絕且不呼叫 dispatch", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  let called = false;
  const { handlers } = setup(async (...a) => {
    called = true;
    return fakeDispatch()(...a);
  });
  const result = await handlers.pi_dispatch({
    task_file: task, cwd: "/tmp", mode: "sync", model: "Qwen3.6-27B-DFlash-draft",
  });
  assert.equal(result.isError, true);
  assert.equal(called, false);
});

test("任務書不存在時回錯誤且不呼叫 dispatch", async () => {
  let called = false;
  const { handlers } = setup(async (...a) => {
    called = true;
    return fakeDispatch()(...a);
  });
  const result = await handlers.pi_dispatch({ task_file: "/nope/TASK.md", cwd: "/tmp", mode: "sync" });
  assert.equal(result.isError, true);
  assert.equal(called, false);
});

test("未知的 session_id 回錯誤並列出有效 id", async () => {
  const { handlers } = setup(fakeDispatch());
  const result = await handlers.pi_result({ session_id: "ghost" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ghost/);
});

test("pi_result 取回 async 派工的判決", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const { handlers } = setup(fakeDispatch());
  const started = await handlers.pi_dispatch({ task_file: task, cwd: "/tmp", mode: "async" });
  const sessionId = started.content[0].text.match(/session_id:\s*(\S+)/)[1];
  await new Promise((r) => setTimeout(r, 50));
  const result = await handlers.pi_result({ session_id: sessionId });
  assert.match(result.content[0].text, /status:\s+completed/);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test test/server.test.mjs`
Expected: FAIL — `Cannot find module '../src/server.mjs'`

- [ ] **Step 3: 實作 `src/server.mjs`**

```javascript
import { existsSync, appendFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { dispatch as realDispatch, DEFAULT_MODEL, DEFAULT_TIMEOUT_S } from "./dispatch.mjs";
import { createRegistry } from "./registry.mjs";
import { formatVerdict } from "./verdict.mjs";
import { DRAFTER_MODELS } from "./doctor.mjs";

export function eventsLogPath() {
  return join(homedir(), ".claude", "pi-delegate", "events.log");
}

const text = (body, isError = false) => ({ content: [{ type: "text", text: body }], isError: isError || undefined });

export function realGitDiffStat(cwd) {
  try {
    return execFileSync("git", ["diff", "--stat"], { cwd, encoding: "utf8" }).trim().split("\n").pop() ?? "";
  } catch {
    return "";
  }
}

export const TOOL_DEFINITIONS = [
  {
    name: "pi_dispatch",
    description:
      "把一份任務書派給本機 pi。mode=sync 阻塞到完成並回傳約 15 行判決；mode=async 立刻回 session_id，完成時會有通知。" +
      "模型選擇：編輯既有檔案一律用 dense（預設 Qwen3.8-27B-oQ4e-mtp）；只有從零寫新檔案才值得換 MoE（Qwen3.6-35B-A3B-4bit）。",
    inputSchema: {
      type: "object",
      properties: {
        task_file: { type: "string", description: "任務書的絕對路徑" },
        cwd: { type: "string", description: "pi 的工作目錄（通常是專案根目錄）" },
        model: { type: "string", description: `模型 id，預設 ${DEFAULT_MODEL}` },
        mode: { type: "string", enum: ["sync", "async"], description: "預設 sync" },
        timeout_s: { type: "number", description: `逾時秒數，預設 ${DEFAULT_TIMEOUT_S}` },
      },
      required: ["task_file", "cwd"],
    },
  },
  {
    name: "pi_status",
    description: "查一個派工現在的狀態：還在跑嗎、跑多久了、收到幾個事件。",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] },
  },
  {
    name: "pi_steer",
    description: "對執行中的派工插話糾正。會在當前 tool call 做完後插隊生效。",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" }, message: { type: "string" } },
      required: ["session_id", "message"],
    },
  },
  {
    name: "pi_abort",
    description: "立刻中止一個派工。注意「被中止」與「失敗」的處置相反：中止要原樣重派，失敗要改任務書。",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] },
  },
  {
    name: "pi_result",
    description: "取回一個已完成派工的判決（約 15 行）。async 派工用這個收工。",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] },
  },
  {
    name: "pi_transcript",
    description:
      "深入查看 pi 的對話內容。判決不夠用時才呼叫。filter=text 只看它說的話、tools 只看工具呼叫、last_n 看最後 n 個事件。",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        filter: { type: "string", enum: ["text", "tools", "last_n"] },
        n: { type: "number", description: "filter=last_n 時的數量，預設 20" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "pi_stats",
    description: "查一個派工的 token 用量與耗時。除錯或估成本時才需要。",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] },
  },
];

export function createToolHandlers({
  registry = createRegistry(),
  dispatchFn = realDispatch,
  eventsLogPath: logPath = eventsLogPath(),
  gitDiffStatFn = realGitDiffStat,
} = {}) {
  function appendEventsLog(verdict) {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(
      logPath,
      `${JSON.stringify({ session_id: verdict.session_id, status: verdict.status, write_count: verdict.write_count })}\n`,
    );
  }

  function withSession(sessionId, fn) {
    try {
      return fn(registry.get(sessionId));
    } catch (error) {
      return text(String(error.message ?? error), true);
    }
  }

  return {
    async pi_dispatch({ task_file, cwd, model = DEFAULT_MODEL, mode = "sync", timeout_s = DEFAULT_TIMEOUT_S }) {
      if (!existsSync(task_file)) return text(`任務書不存在：${task_file}`, true);
      if (DRAFTER_MODELS.includes(model)) {
        return text(`${model} 是副駕駛模型，直接呼叫會回 500。改派給 target model。`, true);
      }

      const sessionId = randomUUID().slice(0, 8);
      const { handle, done } = await dispatchFn({
        taskFile: task_file, cwd, model, timeoutS: timeout_s,
        sessionId, gitDiffStat: gitDiffStatFn(cwd),
      });
      registry.add(sessionId, { handle, done, verdict: null, cwd, taskFile: task_file, model });

      done.then((verdict) => {
        registry.update(sessionId, { verdict });
        if (mode === "async") appendEventsLog(verdict);
      });

      if (mode === "async") {
        return text(`已派工（非同步）。session_id: ${sessionId}\n完成時會通知；也可用 pi_status 查進度。`);
      }
      return text(formatVerdict(await done));
    },

    async pi_status({ session_id }) {
      return withSession(session_id, (entry) =>
        text(JSON.stringify(entry.verdict ? { status: entry.verdict.status, done: true } : entry.handle.state(), null, 2)),
      );
    },

    async pi_steer({ session_id, message }) {
      return withSession(session_id, (entry) => {
        entry.handle.steer(message);
        return text(`已送出：${message}`);
      });
    },

    async pi_abort({ session_id }) {
      return withSession(session_id, (entry) => {
        entry.handle.abort();
        return text(`已中止 ${session_id}。注意：中止要原樣重派，不要改任務書。`);
      });
    },

    async pi_result({ session_id }) {
      if (!registry.has(session_id)) {
        return text(`未知的 session_id "${session_id}"。有效的：${registry.ids().join(", ") || "(無)"}`, true);
      }
      return text(formatVerdict(await registry.get(session_id).done));
    },

    async pi_transcript({ session_id, filter = "text", n = 20 }) {
      return withSession(session_id, (entry) => {
        const events = entry.handle.events ?? [];
        if (filter === "tools") {
          const calls = events
            .filter((e) => e.type === "tool_execution_start")
            .map((e) => `${e.toolName} ${JSON.stringify(e.args)}`);
          return text(calls.join("\n") || "(無工具呼叫)");
        }
        if (filter === "last_n") {
          return text(events.slice(-n).map((e) => JSON.stringify(e)).join("\n") || "(無事件)");
        }
        const said = events
          .filter((e) => e.type === "message_end" && e.message?.role === "assistant")
          .flatMap((e) => (Array.isArray(e.message.content) ? e.message.content : []))
          .filter((p) => p?.type === "text")
          .map((p) => p.text);
        return text(said.join("\n---\n") || "(無文字輸出)");
      });
    },

    async pi_stats({ session_id }) {
      return withSession(session_id, (entry) =>
        text(JSON.stringify(entry.verdict ? { tokens: entry.verdict.tokens, duration_s: entry.verdict.duration_s } : { running: true }, null, 2)),
      );
    },
  };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test test/server.test.mjs`
Expected: PASS（9 tests）

- [ ] **Step 5: 加上 MCP 傳輸層進入點（`src/server.mjs` 檔尾）**

```javascript
export async function main() {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");

  const handlers = createToolHandlers();
  const server = new Server({ name: "pi-delegate", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const handler = handlers[request.params.name];
    if (!handler) return text(`未知的 tool：${request.params.name}`, true);
    try {
      return await handler(request.params.arguments ?? {});
    } catch (error) {
      return text(`${request.params.name} 失敗：${error.message ?? error}`, true);
    }
  });

  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
```

- [ ] **Step 6: 建立 `.mcp.json`**

```json
{
  "mcpServers": {
    "pi-delegate": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/src/server.mjs"]
    }
  }
}
```

- [ ] **Step 7: 安裝相依並確認 server 起得來**

Run: `npm install && node -e "import('./src/server.mjs').then(m => console.log('tools:', m.TOOL_DEFINITIONS.length))"`
Expected: `tools: 7`

- [ ] **Step 8: Commit**

```bash
git add src/server.mjs .mcp.json package.json package-lock.json test/server.test.mjs
git commit -m "feat: MCP server 與七個派工 tool"
```

---

## Task 8: Hooks —— 三模式紀律執行

**Files:**
- Create: `hooks/hooks.json`
- Create: `hooks/mode-guard.mjs`
- Create: `hooks/soft-nudge.mjs`
- Create: `hooks/doctor-check.mjs`
- Create: `src/guard.mjs`
- Test: `test/guard.test.mjs`

**Interfaces:**
- Consumes: `getMode`（Task 4）、`checkModels`（Task 1）
- Produces:
  - `isProtectedPath(filePath, { cwd, exists }) => boolean`
  - `probeFlagPath() => string`（`~/.claude/pi-delegate/probe-active`）
  - `consumeProbe(file?) => boolean`（有旗標則刪除並回 true）

**保護規則**（spec §9）：**擋**已存在的 `src/**` 底下 `.ts` `.tsx` `.js` `.jsx` `.mjs` `.svelte` `.py`（含 `*.test.*` / `*.spec.*`）。**放行**：不存在的檔案、`tasks/**`、`scripts/**`、`docs/**`、所有 `.md`、config 檔（`.json` `.toml` `.yaml` `.yml` 與 dotfiles）。

- [ ] **Step 1: 寫失敗測試 `test/guard.test.mjs`**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { isProtectedPath, consumeProbe } from "../src/guard.mjs";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CWD = "/proj";
const guarded = (p) => isProtectedPath(p, { cwd: CWD, exists: () => true });
const missing = (p) => isProtectedPath(p, { cwd: CWD, exists: () => false });

test("擋已存在的 src 產品碼", () => {
  assert.equal(guarded("/proj/src/foo.ts"), true);
  assert.equal(guarded("/proj/src/a/b/c.svelte"), true);
  assert.equal(guarded("/proj/src/app.py"), true);
});

test("擋已存在的測試檔", () => {
  assert.equal(guarded("/proj/src/foo.test.ts"), true);
  assert.equal(guarded("/proj/src/foo.spec.js"), true);
});

test("放行不存在的檔案（新檔案是 pi 最擅長的形狀）", () => {
  assert.equal(missing("/proj/src/brand-new.ts"), false);
});

test("放行 tasks / scripts / docs", () => {
  assert.equal(guarded("/proj/tasks/T1.md"), false);
  assert.equal(guarded("/proj/scripts/check.ts"), false);
  assert.equal(guarded("/proj/docs/notes.ts"), false);
});

test("放行所有 markdown", () => {
  assert.equal(guarded("/proj/src/README.md"), false);
});

test("放行 config 檔與 dotfiles", () => {
  for (const p of ["/proj/src/a.json", "/proj/src/a.toml", "/proj/src/a.yaml", "/proj/src/a.yml", "/proj/.eslintrc"]) {
    assert.equal(guarded(p), false, p);
  }
});

test("放行 src 之外的原始碼", () => {
  assert.equal(guarded("/proj/lib/foo.ts"), false);
});

test("consumeProbe 有旗標時回 true 並刪掉旗標", () => {
  const file = join(mkdtempSync(join(tmpdir(), "probe-")), "probe-active");
  writeFileSync(file, "1");
  assert.equal(consumeProbe(file), true);
  assert.equal(existsSync(file), false);
});

test("consumeProbe 無旗標時回 false", () => {
  const file = join(mkdtempSync(join(tmpdir(), "probe-")), "probe-active");
  assert.equal(consumeProbe(file), false);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test test/guard.test.mjs`
Expected: FAIL — `Cannot find module '../src/guard.mjs'`

- [ ] **Step 3: 實作 `src/guard.mjs`**

```javascript
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
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test test/guard.test.mjs`
Expected: PASS（9 tests）

- [ ] **Step 5: 實作 `hooks/mode-guard.mjs`**

```javascript
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
```

- [ ] **Step 6: 實作 `hooks/soft-nudge.mjs`**

```javascript
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
```

- [ ] **Step 7: 實作 `hooks/doctor-check.mjs`**

```javascript
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
```

- [ ] **Step 8: 建立 `hooks/hooks.json`**

```json
{
  "description": "pi-delegate 派工紀律與環境自檢",
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/doctor-check.mjs\"", "timeout": 10 }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/mode-guard.mjs\"", "timeout": 10 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/soft-nudge.mjs\"", "timeout": 10 }
        ]
      }
    ]
  }
}
```

- [ ] **Step 9: 手動驗證三個模式的行為**

```bash
node -e "import('./src/modes.mjs').then(m => m.setMode(process.cwd(), 'strict'))"
mkdir -p src && touch src/existing.ts
echo '{"cwd":"'$PWD'","tool_input":{"file_path":"'$PWD'/src/existing.ts"}}' | node hooks/mode-guard.mjs
```
Expected: 輸出含 `"permissionDecision":"deny"`

```bash
node -e "import('./src/modes.mjs').then(m => m.setMode(process.cwd(), 'off'))"
echo '{"cwd":"'$PWD'","tool_input":{"file_path":"'$PWD'/src/existing.ts"}}' | node hooks/mode-guard.mjs; echo "exit=$?"
```
Expected: 無輸出、`exit=0`

- [ ] **Step 10: Commit**

```bash
git add hooks/ src/guard.mjs test/guard.test.mjs
git commit -m "feat: 三模式派工紀律 hooks"
```

---

## Task 9: Skills、monitors 與文件

**Files:**
- Create: `monitors/monitors.json`
- Create: `skills/mode/SKILL.md`
- Create: `skills/probe/SKILL.md`
- Create: `skills/doctor/SKILL.md`
- Create: `skills/delegating-to-pi/SKILL.md`
- Copy: `skills/delegating-to-pi/references/`（六份，原樣自舊 skill 複製）
- Create: `README.md`

**Interfaces:**
- Consumes: `setMode` / `getMode`（Task 4）、`probeFlagPath`（Task 8）、`bin/pi-doctor`（Task 1）
- Produces: 無程式介面

- [ ] **Step 1: 建立 `monitors/monitors.json`**

```json
[
  {
    "name": "pi-dispatch-complete",
    "command": "tail -n 0 -F ${HOME}/.claude/pi-delegate/events.log",
    "description": "pi 非同步派工完成通知"
  }
]
```

- [ ] **Step 2: 建立 `skills/mode/SKILL.md`**

```markdown
---
description: 切換這個專案的 pi 派工模式（off / soft / strict）
disable-model-invocation: true
---

使用者要求把 pi-delegate 模式設為：$ARGUMENTS

執行下列指令（把 `<mode>` 換成 `$ARGUMENTS`，只接受 `off`、`soft`、`strict`）：

```bash
node -e "import('${CLAUDE_PLUGIN_ROOT}/src/modes.mjs').then(m => { m.setMode(process.cwd(), '<mode>'); console.log('模式已設為', m.getMode(process.cwd())); })"
```

若 `$ARGUMENTS` 為空，改為只顯示目前模式：

```bash
node -e "import('${CLAUDE_PLUGIN_ROOT}/src/modes.mjs').then(m => console.log('目前模式：', m.getMode(process.cwd())))"
```

三個模式的差別：
- `off` —— 完全不介入。適合不該讓 pi 碰的專案。
- `soft` —— 動到既有產品碼時提醒（預設）。
- `strict` —— 動到既有產品碼時**擋下來**，要求改用 `pi_dispatch`。
```

- [ ] **Step 3: 建立 `skills/probe/SKILL.md`**

```markdown
---
description: 取得一次性放行，讓下一個 Write/Edit 不被 strict 模式擋下（用於探針）
disable-model-invocation: true
---

使用者要做探針 —— 親手做**一處**最小可行的修改並跑過，之後要把配方寫進任務書。

建立一次性放行旗標：

```bash
node -e "import('${CLAUDE_PLUGIN_ROOT}/src/guard.mjs').then(async g => { const {mkdirSync,writeFileSync}=await import('node:fs'); const {dirname}=await import('node:path'); const p=g.probeFlagPath(); mkdirSync(dirname(p),{recursive:true}); writeFileSync(p,'1'); console.log('探針放行已開啟：下一個 Write/Edit 會通過'); })"
```

然後告訴使用者：**這個旗標只能用一次**，下一個 Write/Edit 通過後自動關閉。
做完探針後立刻把已驗證的配方寫成任務書，其餘的照樣派給 pi。
```

- [ ] **Step 4: 建立 `skills/doctor/SKILL.md`**

```markdown
---
description: 檢查並修復 pi 的 omlx 設定（provider、模型註冊、thinking 綁定）
disable-model-invocation: true
---

先檢查：

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/pi-doctor" --check
```

若回報有問題，向使用者說明各問題的影響後再詢問是否修復：

- `provider-missing` / `model-missing` —— 派工會直接失敗
- `reasoning-missing` / `compat-missing` —— **`--thinking off` 會靜默失效**，pi 會一直思考不動手
- `drafter-unmarked` —— 副駕駛模型未標記，誤選會回 500

取得同意後修復（會先備份成 `models.json.pi-delegate.bak`）：

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/pi-doctor" --fix
```
```

- [ ] **Step 5: 建立瘦身版 `skills/delegating-to-pi/SKILL.md`**

```markdown
---
description: Use when delegating coding work to the local pi agent (Qwen3.8 on omlx) to cut cost, or when you are about to hand-write source or test files yourself instead of specifying them, or when a small-model agent reads files endlessly without ever writing, times out having produced nothing, or keeps reasoning forever even though thinking was turned off.
---

# 派工給 pi

**你是 tech lead，不是打字的人。原始碼全部由 pi 寫 —— 實作與測試都是。**

你只出四樣東西：**探針**、**任務書**、**驗收腳本**、**判決**。其餘每一個字元都是派出去的。

判準不是「這件需不需要判斷」，而是形式的：**「這是會被 commit 的字元嗎」—— 是就派**。

## 四路分流（唯一一定要做對的決定）

| 這件事的本質 | 誰做 | 判準 |
|---|---|---|
| **寫任何原始碼**：實作、測試、修補 | **pi** | 「這是會被 commit 的字元嗎」 |
| **查表就能決定**，不需要讀上下文 | **腳本** | 「這個轉換需要讀懂上下文嗎」 |
| 逐筆**比對兩份清單** | **pi** | 抽取正規化交腳本，比對交 pi |
| **決定契約、判斷成敗** | **你** | 探針、任務書、驗收腳本、判決 |

⚠ **「查表就能決定」那一路是最貴的誤判**，而且 hook 管不到它。
實測：33 個檔案的宣告搬移，派工 46 分鐘＋5 份逾時＋把端點壓到 14.6 tok/s（平常 50），
確定性腳本幾秒做完、零負載。**它不需要讀上下文，所以它不該經過任何模型。**

**「pi 做不動」不是自己做的理由，是拆的訊號。** 超過約 700 行的檔案 pi 編輯不動 ——
把要改的那一塊抽成新檔案，再把新檔案整份交給 pi。

## 怎麼派

用 MCP tool，不要自己組 CLI 指令：

| Tool | 什麼時候用 |
|---|---|
| `pi_dispatch` | 派一份任務書。`mode=sync` 等結果，`mode=async` 丟背景 |
| `pi_status` | 查進度 |
| `pi_steer` | 跑到一半發現方向錯了，插話糾正 |
| `pi_abort` | 中止。**中止要原樣重派，失敗才改任務書** |
| `pi_result` | 收 async 派工的判決 |
| `pi_transcript` | 判決不夠用時才深入看 |
| `pi_stats` | 查 token 用量 |

**兩段派工**：先派測試（帶契約），確認真的紅、紅在預期的地方；再派實作
（帶那份會紅的測試 ＋「不准改測試」）。同一份任務書裡同時要測試與實作，
它會寫出剛好讓自己通過的測試。

**模型選擇**：編輯既有檔案一律 dense（預設）。只有從零寫新檔案才值得換 MoE 換速度。

## 模式

`/pi-delegate:mode strict` 會讓 hook 直接擋下你對既有產品碼的編輯。
做探針時用 `/pi-delegate:probe` 取得一次性放行。

## 往下讀（要用才讀，不要一次全載）

| 檔案 | 什麼時候讀 |
|---|---|
| `references/delegating-implementation.md` | 要派實作 —— 契約怎麼寫、兩段派工、怎麼拆到 pi 做得動 |
| `references/task-books.md` | 要寫任務書、或產出完全照做但結果是壞的 |
| `references/verifying.md` | 要驗收、要做第二層審查 |
| `references/choosing-models.md` | 逾時零產出、要挑模型 |
| `references/orchestration.md` | 要 fan-out、決定併發寬度 |
| `references/diagnosing.md` | 產出不對而不確定該調什麼 —— 症狀對照表 |

## 症狀不指向原因

失敗症狀（逾時、無產出）長得都一樣。**先量 thinking／tool 比例再動手修。**
`pi_transcript` 的 `filter=tools` 看它到底在讀什麼 —— 出現沒被點名的檔案才是漫遊。
```

- [ ] **Step 6: 複製六份 references（原樣，不修改內容）**

```bash
mkdir -p skills/delegating-to-pi/references
cp ~/.claude/skills/delegating-to-pi/references/*.md skills/delegating-to-pi/references/
ls skills/delegating-to-pi/references/
```
Expected: 六個檔案 —— `orchestration.md`、`delegating-implementation.md`、`task-books.md`、`verifying.md`、`diagnosing.md`、`choosing-models.md`

> 若來源路徑不存在，改從本次分析用的解壓目錄複製。**內容一律不改** —— 它們記錄的是實測數字。

- [ ] **Step 7: 建立 `README.md`**

```markdown
# pi-delegate

把實作與測試派給本機 pi（Qwen3.8 on omlx），並用 hooks 強制執行派工紀律。

## 安裝

```bash
claude --plugin-dir /path/to/pi-delegate
```

首次使用先跑 `/pi-delegate:doctor` 修復 pi 的 omlx 設定。

## 模式

| 模式 | 行為 |
|---|---|
| `off` | 完全不介入 |
| `soft` | 動到既有產品碼時提醒（預設） |
| `strict` | 動到既有產品碼時擋下 |

用 `/pi-delegate:mode <模式>` 切換，狀態存在 `~/.claude/pi-delegate/modes.json`，按專案記憶。

## 設計文件

- Spec：`docs/superpowers/specs/2026-08-22-pi-delegate-plugin-design.md`
- Plan：`docs/superpowers/plans/2026-08-22-pi-delegate-plugin.md`
```

- [ ] **Step 8: Commit**

```bash
git add monitors/ skills/ README.md
git commit -m "feat: skills、monitors 與說明文件"
```

---

## Task 10: 端到端驗證

**Files:**
- Modify: 依驗證結果修補（不預設要改哪個檔）

**Interfaces:**
- Consumes: 全部
- Produces: 無

驗證項目對應 spec §12。

- [ ] **Step 1: 全部單元測試通過**

Run: `npm test`
Expected: PASS，無 skipped

- [ ] **Step 2: Plugin 結構驗證**

Run: `claude plugin validate .`
Expected: `✔ Validation passed`（有 warning 可接受，但要逐條讀過）

- [ ] **Step 3: 修復真實環境設定並確認 `--thinking off` 生效**

```bash
node bin/pi-doctor --fix
node bin/pi-doctor --check
```
Expected: 第二次 `ok: true`

接著實測 thinking 真的關掉了：
```bash
pi -p "1+1=?" --provider omlx --model Qwen3.8-27B-oQ4e-mtp --thinking off \
   --no-session --no-context-files --no-skills --no-extensions --mode json \
  | grep -c thinking_delta
```
Expected: `0`（修復前會 > 0）

- [ ] **Step 4: 真實派工一次（sync）**

```bash
mkdir -p /tmp/pi-e2e/src && cd /tmp/pi-e2e && git init -q
cat > TASK.md <<'EOF'
建立檔案 src/add.ts，內容為一個具名匯出函式 add(a: number, b: number): number，回傳 a + b。
不要建立其他檔案。不要寫 .sh / .ps1 / .bat / .py 檔。
EOF
node -e "
import('/path/to/pi-delegate/src/server.mjs').then(async m => {
  const h = m.createToolHandlers();
  const r = await h.pi_dispatch({ task_file: '/tmp/pi-e2e/TASK.md', cwd: '/tmp/pi-e2e', mode: 'sync' });
  console.log(r.content[0].text);
});"
```
Expected: 輸出是約 10 行的判決，`status: completed`、`write_count: 1`、`files_written` 含 `src/add.ts`

- [ ] **Step 5: 驗證判決的四種 status 都分得出來**

- `completed`：Step 4 已驗
- `timeout`：`timeout_s: 1` 重跑同一份任務書 → 應為 `timeout` 且仍有 `git_diff_stat`
- `aborted`：async 派工後立刻 `pi_abort` → 應為 `aborted`
- `failed`：把 `model` 設成不存在的 id → 應為 `failed`

四種都要實際跑過並記錄結果。

- [ ] **Step 6: 漫遊偵測種一個違規進去看它會不會紅**

在 `/tmp/pi-e2e` 多放一個 `src/unrelated.ts`，任務書只點名 `src/add.ts`，
指示 pi「先讀 src/unrelated.ts 再動手」。
Expected: `files_read_unrequested` 含 `src/unrelated.ts`

反向驗證：不下那句指示重跑一次 → `files_read_unrequested` 應為 `(none)`。
**兩個方向都要驗** —— 只驗一邊無法排除「它永遠亂報」或「它永遠不報」。

- [ ] **Step 7: strict 模式誤擋檢查**

對下列每個路徑各送一次 `mode-guard.mjs`，全部應 `exit 0` 無輸出：
`tasks/T1.md`、`scripts/x.ts`、`docs/y.ts`、`src/README.md`、`src/a.json`、`.eslintrc`、`lib/foo.ts`、`src/brand-new.ts`（不存在）

再對已存在的 `src/existing.ts` 送一次 → 應輸出 `permissionDecision: "deny"`。

- [ ] **Step 8: 在真實 Claude Code session 裡載入**

```bash
claude --plugin-dir /path/to/pi-delegate
```
確認：
- SessionStart 注入了模式訊息
- `/plugin` 的 Errors 分頁沒有 pi-delegate 的項目
- 七個 `pi_*` tool 在 `/context` 可見
- `/pi-delegate:mode`、`/pi-delegate:probe`、`/pi-delegate:doctor` 三個 skill 可執行

- [ ] **Step 9: 把驗證結果寫進 README**

在 `README.md` 末尾加一節「驗證紀錄」，記下 Step 3–7 的實際輸出摘要與日期。

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "test: 端到端驗證並記錄結果"
```

---

## Self-Review 結果

**Spec 覆蓋檢查：**

| Spec 章節 | 對應 Task |
|---|---|
| §1.1 五個 bug | Task 1（#1/#3/#4/#5）、Task 6（#2 用 setTimeout 取代 timeout） |
| §4 Plugin 結構 | Task 1（骨架）、Task 7（.mcp.json）、Task 8（hooks）、Task 9（skills/monitors） |
| §5 七個 MCP tool | Task 7 |
| §6 行程模型 ＋ JSONL 陷阱 | Task 2（jsonl）、Task 6（dispatch） |
| §7 判決計算 | Task 3 |
| §8 pi-doctor | Task 1 |
| §9 Hooks 與三模式 | Task 4（modes）、Task 8（guard ＋ hooks） |
| §10 Skill 瘦身 | Task 9 Step 5 |
| §11 錯誤處理 | Task 7（drafter 拒絕、未知 session、任務書不存在）、Task 6（spawn 失敗、逾時仍附 diff） |
| §12 驗證方式 | Task 10 |

無未覆蓋章節。§14 的兩項未決事項刻意不實作（模型自動路由、併發節流），維持呼叫端指定。

**型別一致性檢查：**
- `computeVerdict` 回傳的欄位名（`write_count` / `files_written` / `files_read_unrequested` / `last_message_truncated`）在 Task 6、7、10 中一致使用 ✓
- `Problem.code` 五個取值在 Task 1 定義、Task 8 `doctor-check.mjs` 引用 ✓
- `DRAFTER_MODELS` 於 Task 1 導出、Task 7 引用 ✓
- `probeFlagPath` / `consumeProbe` 於 Task 8 定義、Task 9 `skills/probe` 引用 ✓
- `dispatch` 的 `handle.events` 於 Task 6 導出、Task 7 `pi_transcript` 引用 ✓

**Placeholder 掃描：** 無 TBD / TODO；每個程式步驟都有完整可貼上的實作。
