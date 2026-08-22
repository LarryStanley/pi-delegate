# 公開釋出前的整備報告

> 最後更新：2026-08-22

這份文件記錄 `feat/publish-prep` 這一輪做了什麼、為什麼那樣做，以及每個決定是對
**哪一份實際檔案**查證出來的。查證來源一律是 pi 隨附的產物（`dist/**`），不是文件 ——
這個 codebase 五次嚴重缺陷都來自「替身與實作對同一個沒查證的假設達成共識」。

引用的 pi 版本：`@earendil-works/pi-coding-agent` 0.80.2
（`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`）。

---

## Job 1：provider-agnostic

### 原本的問題

外掛把一台特定機器的設定寫死在程式碼裡：`PROVIDER = "omlx"`、
`OMLX_BASE_URL = "http://127.0.0.1:8000/v1"`、兩個 Qwen 模型 id 當 `REQUIRED_MODELS`、
兩個副駕駛模型 id 當 `DRAFTER_MODELS`。對沒有那台伺服器的人，`pi-doctor` 會報一串
永遠修不好的問題，而 `--fix` 會把那兩個模型憑空插進他的 `~/.pi/agent/models.json`。

### 查證到的關鍵事實

| 事實 | 出處（隨附產物） |
|---|---|
| pi 的 `--provider` 預設是 **google** | `dist/cli/args.js:226` 的 usage 字串 |
| 不帶旗標時 pi 用 `~/.pi/agent/settings.json` 的 `defaultProvider` / `defaultModel` | `dist/core/settings-manager.js:440,443` → `dist/core/sdk.js:100-101` → `dist/core/model-resolver.js:451-459` |
| 解析順序：CLI 旗標 → scoped models → settings 預設 → 第一個有 API key 的模型 | `dist/core/model-resolver.js:415-476`（docstring + 實作） |
| **CLI 旗標只在 provider 與 model 同時存在時才算數**，單獨一個會被靜默忽略 | `dist/core/model-resolver.js:428`：`if (cliProvider && cliModel)` |
| `chatTemplateKwargs` 只存在於 **openai-completions** 的 compat schema | `dist/core/model-registry.js:70,92`；`OpenAIResponsesCompatSchema` / `AnthropicMessagesCompatSchema` 沒有這個欄位 |
| `$var` 只接受 `thinking.enabled` / `thinking.effort` | `dist/core/model-registry.js:66` |
| `api` / `baseUrl` 的解析順序是 model → provider → 內建預設 | `dist/core/model-registry.js:452-457` |
| 合法的 thinking 等級是 off/minimal/low/medium/high/xhigh，不合法只印 warning 然後**丟掉** | `dist/cli/args.js:6, 96-105` |
| `--append-system-prompt`、`--tools`、`--no-context-files`、`--no-skills`、`--no-extensions` 都存在 | `dist/cli/args.js:47,82,124,139,148` |

### 現在的設計

**三層解析，由高到低：**

1. `pi_dispatch` 的呼叫參數（Claude 逐次決定）
2. `~/.claude/pi-delegate/config.json`（使用者的長期偏好，**可以完全不存在**）
3. pi 自己的設定 —— 旗標整個不帶，pi 從 `~/.pi/agent/settings.json` 解析

第 3 層是**預設路徑**：裝好外掛、什麼都不設定，`pi_dispatch` 就打使用者本來就在用的
那個模型（anthropic / openai / ollama / 本機伺服器都一樣）。外掛不發明任何預設模型。

**新模組 `src/config.mjs`** —— `configPath()` / `loadConfig(file?)` / `saveConfig(patch, file?)`，
沿用 `src/modes.mjs` 的可注入 `file` 與降級策略（檔案不存在或壞掉 → 預設值，不 throw）。
另外提供 `loadPiDefaults()`（讀 pi 的 settings.json）與 `resolveModelSelection()`。

`resolveModelSelection()` 處理上表第 4 列那個陷阱：只解析出 provider / model 其中一個時，
另一個從 pi 的預設補齊；補不出來就**明確拋錯**，而不是送出一個會被 pi 靜默忽略的旗標。

**可覆寫的「量出來的預設」**（`pi_dispatch` 參數 / config / 內建三層都適用）：

| 參數 | 預設 | 為什麼是這個值 |
|---|---|---|
| `thinking` | `off` | 小的本機模型會把 budget 全花在思考上、一次 tool call 都不發；強的託管模型在難題上開 thinking 有幫助，所以開放覆寫 |
| `tools` | `read,write,edit` | 給了 bash 會變成一直 `ls`/`cat` 漫遊而不動手 |
| `no_context_files` | `true` | 實測：沒關掉 = 43 read / 0 write / 逾時；關掉 = 93 秒完成 |
| `append_system_prompt` | 不帶 | pi 支援，之前沒開放 |
| `timeout_s` | 1500 | 沿用 |

**結構性旗標**（不開放覆寫）：`--mode rpc`、`--session-id`、`--no-skills`、`--no-extensions`，
以及**刻意不帶** `--no-session`（不帶才會落地 session，drill-down 讀得到）。

理由寫進了 tool description 本身，不只是程式碼註解 —— 呼叫端是 Claude，它需要知道
「預設值是量出來的」才會刻意而不是順手地覆寫。

**`pi-doctor` 從關卡變顧問。** 它現在回報「派工實際會打到誰」，並且只在確實成立的
條件下提出問題：

- `provider` 不在 `models.json` 裡**不是問題** —— anthropic / openai / google 是 pi 內建的
  provider，本來就不會出現在那個檔案（舊版報 `provider-missing`，等於對每個託管使用者噴假錯誤）。
- 自訂 provider 底下找不到該模型也不報錯（pi 會把內建模型與自訂模型合併）。
- `reasoning: true` + `compat.chatTemplateKwargs.enable_thinking` 只在
  **api 是 openai-completions 且 baseUrl 指向本機／內網**時才檢查。判不出來就不報。
- 副駕駛守門改成對「即將被派工的那個模型」發 `drafter-selected` 警告
  （pattern 比對，預設 `-draft` / `_assistant` / `-assistant`，可在 config 關掉），
  不再往使用者的 `models.json` 塞 `x-pi-delegate-forbidden` 這種 pi 不認得的欄位。
- `--fix` 只補一件有把握的事：已註冊、且確定是本機 chat-template 端點的那個模型的
  thinking 綁定。不建立 provider、不插入模型。

omlx 降級成「例如 omlx 或 LM Studio」這種舉例，不再是預設假設。

---

## Job 2：四個停放的問題

1. **`src/server.mjs` 的 null handle 迴歸**（先修）。`registry.add` 佔位之後有一個
   `await dispatchFn(...)`，所以「已註冊、handle 還是 null」是一段真實存在的窗口。
   `pi_steer` / `pi_abort` / `pi_transcript` 在那個窗口會拋
   `TypeError: Cannot read properties of null`。三處都加了 `requireHandle()` 前置檢查 +
   optional chaining，回一句說得出原因的錯誤。**~147 行那句宣稱「佔位到 spawn 之間沒有
   await」的註解本身是錯的，已改寫。** 新測試用一個卡住的 `dispatchFn` 真的製造出那個窗口。

2. **`src/verdict.mjs` 的 `tokens`**：改成**加總**所有 assistant 訊息的 usage。
   依據是 pi 自己的 `getSessionStats()`（`dist/core/agent-session.js:2364-2404`）：
   它對 `state.messages` 裡每一則 assistant 訊息做 `totalInput += usage.input` —— 要自己
   加總就證明了 per-message 的 usage 不是累計值。加總對象是 `message_end`（一則訊息一次，
   `agent-session.js:277` 就是在這個事件上 `appendMessage` 進 session），不是
   `message_update`（串流期間發很多次，加起來會重複計數）。沒有任何帶 usage 的
   `message_end` 時退回舊行為（最後一個看得到的 usage）當容錯。

3. **過時的假宣稱**：`fixtures/fake-pi.mjs` 與 `test/verdict.test.mjs` 還寫著
   `agent_settled`「文件裡有」。實際查證：`grep -rn agent_settled docs/ dist/` 在 pi 0.80.2
   全樹**零筆**，`AgentEvent` union（`pi-agent-core/dist/types.d.ts:360-398`）也沒有它。
   兩處註解都已更正（`src/verdict.mjs` 早就改過，這兩份是後來漂掉的）。

4. **`src/guard.mjs` 的過度攔截**：舊版拿 cwd 的每一段去比對 `src`，於是放在
   `~/src/<project>` 底下的專案整棵樹都被當成受保護。改成先從 cwd 往上找專案根目錄
   （`.git` / `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` / `deno.json`），
   再拿**根目錄**算相對路徑。這同時修好兩個方向：`~/src/proj/lib/foo.ts` 放行、
   `~/src/proj/src/foo.ts` 照擋、cwd 就在 `/proj/src` 裡時也照擋。找不到任何專案標記時
   才退回舊的保守判準（理由不變：漏擋是無聲失效，誤擋看得見而且一個 probe 就解掉）。

---

## Job 3：移除個人識別資訊

- `docs/superpowers/specs/…-design.md:245` 那組寫死的家目錄絕對路徑 → `/path/to/project-a` / `/path/to/project-b`。
- `.claude-plugin/plugin.json` 與 README 的描述不再寫死 `Qwen3.8 on omlx`。
- fixture 裡的 `provider: "omlx"` 改成中性值。
- `test@example.com`（`test/hooks-stdin.test.mjs`）是 RFC 2606 保留網域，依指示保留。

---

## 驗證

### 測試

`npm test` → **190 tests / 190 pass / 0 fail / 0 skipped**（原本 131）。
`test/` 底下只有 `*.test.mjs`，沒有幽靈測試；替身留在頂層 `fixtures/`。

`claude plugin validate .` → `✔ Validation passed`。

### Bite-check（把修好的東西弄壞，確認測試真的會紅）

| 弄壞的地方 | 變紅的測試 | 觀察到的輸出 |
|---|---|---|
| `totalUsage()` 的 `input += …` 改回 `input = …` | 「多輪派工的 tokens 是所有 assistant 訊息的總和，不是最後一則」 | `actual: { input: 400, output: 50 }` vs `expected: { input: 750, output: 105 }` |
| `isProtectedPath()` 改回舊的「cwd 任一段等於 src」 | 「放在 ~/src/ 底下的專案，其 lib/ 不再被當成受保護（回歸）」＋根目錄那一條 | `actual: true` vs `expected: false`（兩條） |
| `pi_steer` 拿掉 `requireHandle()` 前置檢查 | 「spawn 還沒完成時，pi_steer / pi_abort / pi_transcript 回可讀的錯誤而不是 TypeError」 | `actual: "Cannot read properties of null (reading 'steer')"` |

三處復原後各自回到全綠。

### provider-agnostic 的實證（用臨時 HOME 跑真的指令）

**A. 完全沒有任何設定** —— `buildPiArgs` 不帶 `--provider`、不帶 `--model`：

```
["--mode","rpc","--thinking","off","--tools","read,write,edit",
 "--session-id","demo","--no-context-files","--no-skills","--no-extensions"]
```

**B. 託管 provider（`defaultProvider: anthropic`，沒有 models.json）** ——
`pi-doctor --check` 回 `ok: true`、`problems: []`，理由：
「"anthropic" 不在 ~/.pi/agent/models.json 裡 —— 多半是 pi 內建的 provider…這是正常的」。

**C. 託管 openai-completions（litellm，遠端 baseUrl）** —— `ok: true`、`problems: []`，理由：
「baseUrl https://litellm.example.com/v1 不是本機／內網端點；託管服務的 thinking 由它自己的
API 參數控制，此檢查不適用」。**這就是原本會誤報 `reasoning-missing` / `compat-missing` 的情境。**

**D. 本機 OpenAI 相容伺服器（`http://127.0.0.1:8000/v1`）缺綁定** —— 照樣報
`reasoning-missing` / `compat-missing`（兩者 `fixable: true`），`--fix` 之後
`ok: true`，寫進去的正是 `{"$var": "thinking.enabled"}`。

**E. 這台開發機的真實設定（只跑 `--check`）** —— `ok: true`、`problems: []`、
`effective: litellm / DeepSeek-V4-Pro (pi settings.json)`、`config_exists: false`。
也就是說：沒有 pi-delegate 設定檔，派工照樣會打到使用者本來就在用的模型。

### 個人識別資訊

掃過所有被追蹤的檔案，找不到任何家目錄絕對路徑或機器名稱（這份報告本身也刻意不寫出那個字串，
否則掃描會被自己的紀錄污染）。
`.claude-plugin/plugin.json` 的 `author.name` 保留（那是作者署名，不是機器設定）。

---

## 附錄：2026-08-22 Task 10 的端到端驗證紀錄（歷史，原本放在 README）

保留原文以免遺失。注意這份紀錄早於本輪改動：其中「94/94」的測試數、以及對
`agent_settled` 的推論都已被後續修正取代（詳見上面 Job 2 第 3 點）。

## 驗證紀錄（2026-08-22）

Task 10 端到端驗證，完整輸出見
`.superpowers/sdd/2026-08-22-pi-delegate-plugin/task-10-report.md`。摘要：

- **Step 1（`npm test`）**：PASS，94/94，無 skipped。
- **Step 2（`claude plugin validate .`）**：PASS，`✔ Validation passed`，無 warning。
- **Step 3（環境修復）**：PASS，`node bin/pi-doctor --check` 回 `ok: true`，
  `~/.pi/agent/models.json.pi-delegate.bak` 存在。
- **Step 4（真實派工，sync）**：PASS，13:55 實測 4 requests 打到 `Qwen3.8-27B-oQ4e-mtp`，
  `finish_reason=stop`，`/tmp/pi-e2e/src/add.ts` 內容正確。
- **Step 5（四種 verdict status）**：四種都實測產生，但 `failed` 不是用 brief 建議的
  「不存在的 model id」做到的——那個方法實測是 `timeout`（omlx 對不存在的 model 回 404，
  但 `pi --mode rpc` 的 session 不會自己關閉，永遠等不到判定 `failed` 所需的 process 結束，
  只能靠逾時收尾，於是變成 `timeout`）。改用「不存在的 cwd」讓 `spawn()` 直接 ENOENT 才拿到
  真正的 `failed`（`duration_s: 0`）。另外發現：多次真實 `pi` 事件流（`--mode json` 與
  `--mode rpc`，成功與失敗案例都測過）都沒有出現 `agent_settled` 事件——這是 `computeVerdict`
  判定 `completed` 的唯一訊號，但翻 `fixtures/fake-pi.mjs` 才發現這個事件類型是測試替身自己
  發明的，真實 `pi` CLI 從未發出過。也就是說 sync 派工在真實環境下可能永遠等不到
  `completed`，只能靠逾時（預設 1500 秒）收尾，即使工作其實已經正確完成也會回報
  `status: timeout`。未重跑 Step 4 去驗證這個假說（該步驟已由外部驗證通過且明確交代不要重跑），
  記錄下來供後續核對，可能是需要修的缺陷。
- **Step 6（漫遊偵測雙向驗證）**：PASS。下「先讀 src/unrelated.ts」指示時，
  `files_read_unrequested` 含 `src/unrelated.ts`；不下指示時不含。核心訊號（有/無 unrelated.ts）
  兩個方向都分得出來。次要落差：不下指示時欄位值不是字面 `(none)`，而是列出任務書自己
  （`TASK_NOROAM.md`）——因為 harness 每次都會先讀一次任務書，而 `.md` 不算「有點名的檔案」，
  這與漫遊偵測本身無關。
- **Step 7（strict 模式誤擋掃描）**：PASS。`tasks/T1.md`、`scripts/x.ts`、`docs/y.ts`、
  `src/README.md`、`src/a.json`、`.eslintrc`、`lib/foo.ts`、不存在的 `src/brand-new.ts`
  八個路徑全部 `exit 0` 無輸出；已存在的 `src/existing.ts` 正確輸出
  `permissionDecision: "deny"`。九個案例與預期完全一致。

Step 8（互動式 `claude --plugin-dir` session 檢查）留給人工手動驗證，未在本輪執行。

