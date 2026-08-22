# pi-delegate：把「派工給 pi」從 skill 轉成 Claude Code Plugin

> **歷史文件（2026-08-22）。** 這份 spec/plan 記錄的是 v0.1.0 當時的設計，其中把 provider 寫死成
> 一台本機 omlx 伺服器、把兩個 Qwen 模型 id 當成必要模型的部分**已經不是現況**。
> 現在的行為（三層 provider / model 解析、顧問式 pi-doctor）見 `docs/publish-prep-report.md`
> 與 `README.md`。原文保留是為了留下當初的決策理由。

> 設計日期：2026-08-22
> 狀態：待實作
> 前身：`delegating-to-pi` skill（148 行 SKILL.md ＋ 約 1400 行 references ＋ 5 支 bash/ps1）

## 1. 問題陳述

現有的 `delegating-to-pi` skill 在 Claude Code 裡「用不好」，原因分兩層，必須分開處理。

### 1.1 機制層：從 Windows 移植過來後有五個 bug

這些是實測（2026-08-22，macOS / M3 Ultra）確認的，不是推測：

| # | Bug | 證據 | 影響 |
|---|---|---|---|
| 1 | provider 名字錯 | 腳本寫 `--provider omls`，`~/.pi/agent/models.json` 裡叫 `omlx` | `Error: Unknown provider "omls"` — 派工必定失敗 |
| 2 | `timeout` 在 macOS 不存在 | `dispatch-pi.sh` 用 `timeout 1500`；本機 `timeout` / `gtimeout` 皆無 | 腳本第一行就掛 |
| 3 | 預設模型未註冊 | `omlx` provider 只有 `Qwen3.6-35B-A3B-4bit`、`Qwen3.6-27B-DFlash-draft` | `Warning: not found, using custom model id` |
| 4 | **`--thinking off` 是靜默空操作** | 承 #3：模型未註冊 → 缺 `reasoning: true` 與 `compat.chatTemplateKwargs.enable_thinking` | 這正是 skill description 自述的症狀「keeps reasoning forever even though thinking was turned off」 |
| 5 | 註冊清單含副駕駛 | `Qwen3.6-27B-DFlash-draft` 是 DFlash drafter，直接呼叫回 500 | 誤選即失敗 |

**bug #4 的重要性**：這個 skill 描述了自己的 bug，卻把成因歸給模型。任何只搬運腳本的方案都會把它一起搬過去。

> 現況備註：omlx server 端已於 2026-08-22 設定 `thinking_budget_tokens: 4096`，
> 目前那是**唯一**在阻止 `Qwen3.8-27B-oQ4e-mtp` 無限思考的機制。客戶端 `--thinking off`
> 修好之前不要移除它。

### 1.2 介面層：skill 是紀律文件，不是機制

SKILL.md 是給 Claude 讀的散文規則，機制只有 5 支 bash。Claude 必須自己讀規則、自己組指令、自己判讀 `events.json`。

而散文紀律有天花板 —— skill 自己記錄的實測：**規則寫著「只有三件事留給你」，同一輪仍有約八成字元是主模型打的**，且「每一件當下都有一個聽起來成立的理由」。

Plugin ＋ Hooks 能解的是這一層。

## 2. 目標與非目標

### 目標

1. Claude 能以**結構化 tool 呼叫**派工給 pi，不必自己組 CLI 指令
2. **同步**（派一件、等結果）與**非同步**（fan-out、完成時通知）都支援
3. 支援**執行中介入**：steer / abort
4. 進入 Claude context 的預設資訊壓到約 15 行；深入資訊**按需付費**
5. 紀律可**強制執行**，而且可依專案開關
6. **跨機器可攜** —— Windows → macOS 已證明會壞

### 非目標

- 不上 plugin marketplace（個人跨機器使用）
- 不取代 references/ 的內容（原樣保留，維持漸進式載入）
- 不支援 omp（原 skill 提及的另一個 harness），只做 pi

## 3. 關鍵決策與理由

| 決策 | 選擇 | 理由 |
|---|---|---|
| 呼叫形狀 | 同步 ＋ 非同步都要 | 使用者明確要求 |
| 紀律強度 | 三模式 `off` / `soft` / `strict`，可切換 | 有些專案根本不該讓 pi 介入 |
| 模式作用域 | **專案層級**，切一次記住 | 同上；session 層級不夠 |
| context 分層 | 第 0 層永遠回，第 1/2 層按需 | pi session 本來就存磁碟，drill-down 免費 |
| 第 0 層是否帶 assistant 訊息 | **帶，截斷 1000 字元** | pi 常在最後說明改了什麼、任務書哪裡有歧義，省一次往返 |
| 架構 | MCP server 起 `pi --mode rpc` 子行程 | 見下 |

### 為什麼是 MCP server ＋ 子行程（而非 SDK in-process，或純 `bin/`）

- **steer / abort 需要持續握著 stdio**。Bash tool 每次呼叫都是新行程，做不到 → 純 `bin/` 方案交付不了「控制」
- **行程隔離**：fan-out 8 份時，一份崩潰不該拖垮其他 7 份。SDK in-process 會
- **可手打重現**：本文件 §1.1 那五個 bug 全靠手打指令逐一定位。SDK 方案出事時只能讀 server log

## 4. Plugin 結構

```
pi-delegate/
├── .claude-plugin/
│   └── plugin.json
├── .mcp.json                        MCP server 註冊
├── mcp/
│   ├── server.js                    tool 定義與分派
│   ├── dispatch.js                  spawn pi --mode rpc、持有 stdio、逾時 timer
│   ├── verdict.js                   判決計算（§7）
│   ├── registry.js                  session 註冊表：id → {pid, status, cwd, task_file}
│   └── jsonl.js                     嚴格 LF 切分（見 §6 警告）
├── hooks/
│   ├── hooks.json
│   ├── doctor-check.sh
│   ├── mode-guard.sh
│   └── soft-nudge.sh
├── skills/
│   ├── delegating-to-pi/
│   │   ├── SKILL.md                 瘦身版（§10）
│   │   └── references/              原樣沿用現有六份
│   ├── mode/SKILL.md                /pi:mode
│   ├── probe/SKILL.md               /pi:probe
│   └── doctor/SKILL.md              /pi:doctor
├── bin/
│   └── pi-doctor                    環境自檢與修復（§8）
├── monitors/
│   └── monitors.json                非同步完成通知
└── README.md
```

> ⚠️ `commands/`、`agents/`、`skills/`、`hooks/` 一律放 plugin **根目錄**，
> 不可放進 `.claude-plugin/`。後者只放 `plugin.json`。

### plugin.json

```json
{
  "name": "pi-delegate",
  "description": "把實作與測試派給本機 pi（Qwen3.8 on omlx），並強制執行派工紀律",
  "version": "0.1.0",
  "author": { "name": "stanley" }
}
```

## 5. MCP Tool 介面

| Tool | 參數 | 回傳 | 層 |
|---|---|---|---|
| `pi_dispatch` | `task_file`, `cwd`, `model?`, `mode=sync\|async`, `timeout_s?` | sync → 判決；async → `{session_id}` | 0 |
| `pi_status` | `session_id` | `{status, elapsed_s, current_tool, files_touched}` | 0 |
| `pi_steer` | `session_id`, `message` | `{ok}` | — |
| `pi_abort` | `session_id` | `{ok}` | — |
| `pi_result` | `session_id` | 判決（async 完成後取回） | 0 |
| `pi_transcript` | `session_id`, `filter=text\|tools\|last_n`, `n?` | 過濾後的對話片段 | 1 |
| `pi_stats` | `session_id` | `get_session_stats` 原樣（tokens / cost / context） | 2 |

**預設值**：`model` 預設 `Qwen3.8-27B-oQ4e-mtp`（dense）。`timeout_s` 預設 `1500`。

**模型選擇規則**（沿用原 skill 實測結論，寫進 tool description）：
編輯既有檔案一律 dense；只有「從零寫新檔案」才值得換 MoE（`Qwen3.6-35B-A3B-4bit`）換速度。

## 6. 行程模型

MCP server 常駐。每次 `pi_dispatch` 開一個子行程：

```
pi --mode rpc \
   --provider omlx --model <model> --thinking off \
   --tools read,write,edit \
   --session-id <id> \
   --no-context-files --no-skills --no-extensions
```

子行程的工作目錄用 `spawn(..., { cwd })` 設定。

> ⚠️ **pi 沒有 `--cwd` 旗標**（2026-08-22 對 `pi --help` 驗證）。
> 原 skill 的 `references/orchestration.md` 裡那個 `--cwd` 是 **omp** 的旗標，
> 不是 pi 的。照抄會直接 argparse 失敗。

> 旗標的理由沿用原 `dispatch-pi.sh` 檔頭，**不重新推導**：
> 不給 `bash`（給了會漫遊不動手）；`--no-context-files` 是必要不是最佳化
> （實測：沒加 = 43 read / 0 write / 逾時；加了 = 93 秒完成）。

> ⚠️ **刻意不帶 `--no-session`**（與原 `dispatch-pi.sh` 相異）。
> 原腳本用它把 harness 重量降到最低，但 session 儲存是磁碟 I/O，
> **不會進入模型的 context**，所以省不到 token。
> 而 §5 的第 1/2 層 drill-down（`pi_transcript` / `pi_stats`）依賴 session 落在 `~/.pi/agent/sessions/` 才讀得到 ——
> 帶了 `--no-session` 會讓 `pi_transcript` / `pi_stats` 在子行程結束後無資料可讀。
> 改用 `--session-id <id>` 讓 session 可定址。

- **逾時由 server 的 timer 管，不呼叫 `timeout`** → 結構性消滅 bug #2，Windows / macOS 行為一致
- `mode=sync`：阻塞到 `agent_settled`，回判決
- `mode=async`：立刻回 `session_id`；完成時 append 一行到 `~/.claude/pi-delegate/events.log`
- `monitors.json` 跑 `tail -F` 那個 log，每行 stdout 成為 Claude 的通知

```json
[
  {
    "name": "pi-dispatch-complete",
    "command": "tail -F ${HOME}/.claude/pi-delegate/events.log",
    "description": "pi 派工完成通知"
  }
]
```

### ⚠️ JSONL 解析

pi 的 RPC 協定是**嚴格 LF 分隔**。文件明講**不可用 Node `readline`** —— 它也會在 JSON payload 內的 Unicode 分隔符處斷行，造成靜默資料損毀。

`mcp/jsonl.js` 必須只切 `\n`，並剝除可選的 `\r`。

### 相關事件

| 事件 | 用途 |
|---|---|
| `agent_settled` | 整個 session 定案，無自動續跑 → 判決的權威訊號 |
| `tool_execution_start` | `toolCallId` / `toolName` / `args` → 計數與漫遊偵測 |
| `tool_execution_end` | `isError` |
| `message_end` | 取最後一則 assistant 訊息 |

## 7. 判決計算（第 0 層）

原 skill 把三個判讀陷阱寫成散文交給 Claude。**寫成散文每次都可能錯，寫成程式碼只會錯一次。**

| 陷阱 | 程式做法 |
|---|---|
| 一次 tool call 噴 3–4 事件 → 誤數 | 以 `tool_execution_start.toolCallId` 去重後再計數 |
| 「被中止」與「失敗」處置相反 | 三步 enum，順序不可顛倒：`agent_settled` 到了沒 → grep 目標字串 → `git status` |
| 「逾時」≠「什麼都沒做」 | 自動附 `git diff --stat` |
| 漫遊偵測 | `read` 過的檔案 ∖ 任務書點名的檔案 |

### 回傳格式（固定約 15 行）

```
status:                 completed | timeout | aborted | failed
write_count:            3
files_written:          src/foo.ts, src/foo.test.ts
files_read_unrequested: src/unrelated.ts
git_diff_stat:          2 files changed, 47 insertions(+), 3 deletions(-)
duration_s:             93
tokens:                 in 4210 / out 890
session_id:             a1b2c3
last_message:           <最後一則 assistant 訊息，截斷 1000 字元>
```

`last_message` 超過 1000 字元時截斷並標記，完整內容留給 `pi_transcript`。

## 8. 可攜性：`bin/pi-doctor`

冪等檢查與修復，這是跨機器搬遷的保險。

| 檢查 | 修復動作 | 對應 bug |
|---|---|---|
| `~/.pi/agent/models.json` 有 `omlx` provider | 建立，`baseUrl: http://127.0.0.1:8000/v1` | #1 |
| 目標模型已註冊 | 加入 models 陣列 | #3 |
| 模型有 `reasoning: true` | 補上 | #4 |
| 模型有 `compat.chatTemplateKwargs.enable_thinking: {"$var": "thinking.enabled"}` | 補上 | #4 |
| drafter 類模型標記不可派工 | 標記 `x-pi-delegate-forbidden: true`，`pi_dispatch` 拒絕 | #5 |
| omlx server 存活 | 只報告，不自動啟動 | — |

- `pi-doctor --check`：唯讀，回結構化報告
- `pi-doctor --fix`：實際寫入，寫入前備份 `models.json`

`SessionStart` hook 只跑 `--check`。

## 9. Hooks 與模式

### 狀態

`~/.claude/pi-delegate/modes.json`，key 為專案絕對路徑：

```json
{ "/path/to/project-a": "strict", "/path/to/project-b": "off" }
```

未列出的專案預設 `soft`。放家目錄而非 repo：不污染專案、不必 gitignore。代價是換機器要重設一次（已接受）。

### hooks.json

| Hook | 事件 | matcher | 行為 |
|---|---|---|---|
| `doctor-check` | `SessionStart` | — | 跑 `pi-doctor --check`，用 `additionalContext` 注入「當前模式 ＋ 設定問題」 |
| `mode-guard` | `PreToolUse` | `Write\|Edit` | **strict**：命中受保護路徑 → `permissionDecision: "deny"` |
| `soft-nudge` | `PostToolUse` | `Write\|Edit` | **soft**：注入 `additionalContext` 提醒 |

`off` 模式下兩個 hook 都直接 `exit 0`，不做任何事。

### strict 的保護範圍（保守白名單）

**擋**：已存在的產品碼與測試檔 —— `src/**` 底下的 `.ts` / `.tsx` / `.js` / `.svelte` / `.py`，含 `*.test.*` / `*.spec.*`。

**放行**（一律不擋）：
- 全新檔案（路徑不存在）
- `tasks/**`、`scripts/**`、`docs/**`
- 所有 `.md`
- config 檔（`*.json` / `*.toml` / `*.yaml` / `*.yml` / dotfiles）

deny 的 `permissionDecisionReason` 要直接給出替代動作，例如：
「這是產品碼。寫一份任務書到 `tasks/` 再用 `pi_dispatch` 派工。要親手改請先 `/pi:probe`。」

### 探針例外

`/pi:probe` 設一次性放行旗標，下一個 Write/Edit 通過後自動關閉。比「10 行上限」自動計數更好稽核。

## 10. Skill 瘦身

`strict` 模式下紀律由 hook 執行，散文不必再承擔強制力。SKILL.md 從 148 行縮為：

- 四路分流表（**唯一一定要做對的決定**）
- 「查表就能決定的不要派，寫腳本」判準 —— 這條 hook 管不到，必須留在散文
- 指向 MCP tools 的說明
- 現有的「往下讀」references 索引

**移除**：紅旗清單、「你自己動手之前先過這張表」—— 那些已由 `mode-guard` 執行。
**保留**：全部六份 references 原樣不動。

## 11. 錯誤處理

| 情況 | 行為 |
|---|---|
| MCP server 起不來 | `/plugin` Errors 分頁可見；tool 呼叫回明確錯誤，不靜默失敗 |
| pi 子行程 spawn 失敗 | `status: failed`，附 stderr |
| 逾時 | `status: timeout`，**仍附 `git diff --stat`**（逾時 ≠ 沒做事） |
| `pi-doctor --check` 發現問題 | SessionStart 注入警告，但**不阻擋** session |
| 派工目標是 drafter 模型 | `pi_dispatch` 直接拒絕，不送出請求 |
| `session_id` 不存在 | 明確錯誤，列出目前有效的 session |

## 12. 驗證方式

```bash
claude plugin validate ./pi-delegate
claude --plugin-dir ./pi-delegate
```

逐項檢查：

1. **MCP tools** —— `pi_dispatch` 一份最小任務書，確認回傳是 15 行判決而非原始 JSON
2. **Hooks** —— 三個模式各觸發一次 Write，比對 debug log 的 matched hooks 與 exit code
3. **strict 誤擋** —— 對白名單各類路徑各寫一次，確認全部放行
4. **判決正確性** —— 刻意製造 timeout / abort / failed 三種情況，確認 enum 分對
5. **漫遊偵測** —— 任務書只點名 A 檔，觀察 pi 讀了 B 檔時是否列入 `files_read_unrequested`
6. **`--thinking off` 真的生效** —— `pi-doctor --fix` 後對照 omlx server log 的 `reasoning_content` 長度

第 4 項要**種一個真的違規進去看它會不會紅**，並驗證乾淨時不亂報 —— 沿用原 skill 對審查有效性的判準。

## 13. 實作順序

1. `pi-doctor` ＋ `plugin.json`（先讓環境是對的，否則後面每一步都在對抗 §1.1 的五個 bug）
2. `mcp/` 的 `jsonl.js` → `dispatch.js` → `verdict.js` → `server.js`（sync 路徑）
3. async 路徑 ＋ `monitors.json`
4. `hooks/` 三支 ＋ 模式狀態
5. `/pi:mode`、`/pi:probe`、`/pi:doctor`
6. SKILL.md 瘦身

第 1 步完成後就該能用現有的 `dispatch-pi.sh`（改掉 provider 名與 timeout）驗證派工本身是通的，再往上疊。

## 14. 未決事項

- **模型路由自動化**：目前 `model` 由呼叫端指定，tool description 寫明 dense/MoE 規則。是否要讓 `pi_dispatch` 依「目標檔存在與否」自動路由，待實作後觀察誤判率再定。
- **fan-out 併發寬度**：原 skill 建議輕任務 8、重任務 2–3。是否由 server 統一節流，或維持呼叫端自理，待第 3 步實作時決定。
