# pi-delegate

把實作與測試派給本機的 [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
agent，並用 hooks 強制執行派工紀律。

Claude 當 tech lead：出探針、任務書、驗收腳本、判決。**原始碼由 pi 寫。**

## 安裝

```bash
claude --plugin-dir /path/to/pi-delegate
```

需要 Node ≥ 22 與已安裝、已設定好的 `pi`。

## 設定：預設情況下不需要設定

`pi_dispatch` **不指定 provider 與 model**，pi 會用你自己的預設
（`~/.pi/agent/settings.json` 的 `defaultProvider` / `defaultModel`）。也就是說：
你平常用 pi 打誰，派工就打誰 —— anthropic、openai、litellm、ollama、LM Studio、
一台本機 OpenAI 相容伺服器（例如 omlx）都一樣，不必為這個外掛再設定一次。

想長期固定成別的模型（例如派工專用一顆便宜的本機模型，而互動式 pi 用別的），
才需要寫 `~/.claude/pi-delegate/config.json`：

```json
{
  "provider": "ollama",
  "model": "qwen3:8b",
  "timeout_s": 1500,
  "thinking": "off",
  "tools": "read,write,edit",
  "no_context_files": true,
  "drafter_patterns": ["-draft", "_assistant", "-assistant"]
}
```

每個欄位都可以省略。解析順序是 **`pi_dispatch` 的呼叫參數 → 這個檔案 → pi 自己的預設**。

`/pi-delegate:doctor` 會告訴你派工實際會打到誰，並且只在確實成立的條件下提出問題。

### 那幾個預設值是量出來的

| 參數 | 預設 | 為什麼 |
|---|---|---|
| `thinking` | `off` | 小的本機模型會把思考 budget 花光、一次 tool call 都不發。強的託管模型在難題上開 thinking 是有幫助的，所以開放覆寫。 |
| `tools` | `read,write,edit` | 給了 `bash`，模型會一直 `ls` / `cat` 漫遊而不動手。 |
| `no_context_files` | `true` | 實測：沒關掉是 43 read / 0 write / 逾時；關掉是 93 秒完成。 |

要覆寫就在 `pi_dispatch` 呼叫時直接指定（`thinking`、`tools`、`no_context_files`、
`append_system_prompt`、`provider`、`model`、`timeout_s`）。

`--mode rpc`、`--session-id`、`--no-skills`、`--no-extensions` 是結構性的，不開放覆寫；
`--no-session` 則是**刻意不帶**（不帶才會落地 session，`pi_transcript` 才有東西可讀）。

## 模式

| 模式 | 行為 |
|---|---|
| `off` | 完全不介入 |
| `soft` | 動到既有產品碼時提醒（預設） |
| `strict` | 動到既有產品碼時擋下 |

用 `/pi-delegate:mode <模式>` 切換，狀態存在 `~/.claude/pi-delegate/modes.json`，按專案記憶。
「既有產品碼」＝ 專案根目錄底下 `src/` 裡已經存在的原始碼檔案；`tasks/`、`scripts/`、
`docs/`、markdown、設定檔、以及全新的檔案都放行。

`strict` 是紀律護欄，不是強制執行：hook 只掛在 `Write|Edit` 上，用 `Bash`
（`sed -i`、heredoc、`python - <<EOF`…）改同一個檔案完全不會被攔。要繞永遠繞得過去，
它擋的是「順手就自己改了」，不是有意的規避。

要親手改一處（做探針）就先 `/pi-delegate:probe` 拿一次性放行。

## MCP tools

| Tool | 用途 |
|---|---|
| `pi_dispatch` | 派一份任務書。`mode=sync` 等結果，`mode=async` 丟背景 |
| `pi_status` | 查進度 |
| `pi_steer` | 跑到一半發現方向錯了，插話糾正 |
| `pi_abort` | 中止。**中止要原樣重派，失敗才改任務書** |
| `pi_result` | 收 async 派工的判決 |
| `pi_transcript` | 判決不夠用時才深入看 |
| `pi_stats` | 查 token 用量 |

## 已知未實作

`pi_stats` 只回判決裡已有的 `tokens` 與 `duration_s`。spec §5 寫的
`get_session_stats` 原樣轉發（含 `cost` / `context` 用量）尚未實作。

## 文件

| 檔案 | 內容 |
|---|---|
| `docs/publish-prep-report.md` | 公開釋出前那一輪的改動與查證紀錄 |
| `docs/superpowers/specs/2026-08-22-pi-delegate-plugin-design.md` | 設計 spec（歷史文件） |
| `docs/superpowers/plans/2026-08-22-pi-delegate-plugin.md` | 實作 plan（歷史文件） |
| `skills/delegating-to-pi/` | 派工紀律本身：四路分流、任務書、驗收、挑模型 |

## 開發

```bash
npm test                    # node --test，無外部相依
claude plugin validate .
```

`fixtures/fake-pi.mjs` 是 `pi --mode rpc` 的替身。它刻意放在 `test/` **之外** ——
`node --test` 會把 `**/test/**/*.{cjs,mjs,js}` 底下的任何檔案都當成測試檔跑，
放在 `test/` 裡會多出一個永遠通過的幽靈測試。
