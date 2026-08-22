---
description: Use when delegating coding work to the local pi agent to cut cost, or when you are about to hand-write source or test files yourself instead of specifying them, or when a small-model agent reads files endlessly without ever writing, times out having produced nothing, or keeps reasoning forever even though thinking was turned off.
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

**模型選擇**：不指定就用使用者自己的 pi 預設模型（`~/.pi/agent/settings.json`）——
絕大多數情況就這樣。真的要換才用 `pi_dispatch` 的 `provider` / `model` 參數，
而且兩個要一起給（pi 只認成對的覆寫）。挑模型的判準見
`references/choosing-models.md`：編輯既有檔案一律 dense，只有從零寫新檔案才值得換
MoE 換速度。

**`pi_dispatch` 的其他旗標有量出來的預設**：`thinking=off`、`tools=read,write,edit`、
`no_context_files=true`。要覆寫請刻意 —— 每個預設值背後都有一次「不這樣做就逾時零產出」
的實測（理由寫在 tool 說明裡）。

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
