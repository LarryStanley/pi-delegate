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
