# 選 harness 與模型

**什麼時候讀這一份**：逾時零產出、`--thinking off` 好像沒生效、要挑模型或量化建置。

核心：**先問「這個 harness 塞了多少東西給模型」，再問「哪個模型比較強」**——
顛倒這個順序會把一個其實可用的模型判成不能用。

← 回 `SKILL.md`（四路分流與紀律表）

## 先選 harness，再選模型——這個順序不能顛倒

**harness 的重量決定了哪些模型能用。** 同一個模型、同一個任務、同一個端點，只換 harness：

| harness | 工具數 | Qwen3.8-27B 的結果 |
|---|---|---|
| omp（oh-my-pi） | ~31，外加 todo 生命週期／委派／審查那一整套系統提示 | **600 秒逾時，0 次 write** |
| **pi**（`@earendil-works/pi-coding-agent`） | **4**（read/bash/edit/write） | **867 秒，12 條測試全綠，100% 覆蓋率** |

我在 omp 上花了好幾小時替這個模型做了兩個真的修正（關掉伺服器端 thinking、只給
read/write），才勉強讓它產出 9 條裡 4 條綠的東西。**換成 pi 之後，什麼特殊設定都不用，
一次就全綠。**

原因不神秘：那些重量級 harness 是為前沿模型設計的。31 個工具的 schema 加上長篇行為
規範會把小模型的注意力吃光，它就退化成「用文字描述我要做什麼」而不動手。

**所以先問「這個 harness 塞了多少東西給模型」，再問「哪個模型比較強」。** 前者常常
直接決定後者的答案——我因為顛倒了這個順序，把一個其實可用的最新模型判成不能用。

（12B 級別在**兩個** harness 上都失敗，所以尺寸下限是真的，與 harness 無關。）

## 選模型：看「思考／輸出比」，不是參數量

同一任務、同一份任務書的實測（2026-08-15）：

| 模型 | 秒 | thinking token | write 呼叫 | 結果 |
|---|---|---|---|---|
| Qwen3.8-27B（dense 4bit） | 600+ 逾時 | ~3600 | **0** | 沒有產出 |
| **Qwen3.6-35B-A3B（MoE, 3B 活躍）** | **178–227** | ~300 | 6–9 | **9 條測試全綠** |
| gemma-4-12b-coder（8bit） | 12–43 | ~60 | **0** | 在這個 harness 裡沒動手（見下） |

三件事：

1. **總參數更大的 MoE 快 3 倍以上**——每次只啟用少數專家，而且不會把預算燒在自言自語。
2. **thinking-first 的模型不適合 agent loop。** 它停不下來思考，永遠輪不到發 tool call。
3. **12B 級別在完整的 agent 系統提示下撐不住，跟微調類型無關。**
   實測（同一任務、同一份任務書）：

   | 模型 | 秒 | 工具呼叫 | 產出 |
   |---|---|---|---|
   | gemma-4-12b-**coder** | 12–43 | 0 | ✗ |
   | gemma-4-12B-**it**（純 instruct，同尺寸對照組） | 14 | 0 | ✗ |
   | gemma-4-**26B-A4B**（MoE） | 271 | 38 | **✓** |

   換成純 instruct 版沒有變好，換成 26B 就活了——所以**不要用「coder 特調不會用工具」
   這種理由淘汰模型，那是錯的歸因**。

   證據：那支 12B 直接打端點時，1／2／25 個工具、長系統提示、strict mode、平行呼叫
   **全部**都正確回傳原生 `tool_calls`。它有工具能力。但在 harness 完整的系統提示下
   （todo 生命週期、委派規則、審查流程…），注意力被吃光，就退化成「用文字描述我要做
   什麼」——吐 ```` ```json ```` 區塊或 Python 偽程式碼，harness 看不到工具呼叫。

   **能力問題與接線問題的症狀完全一樣（零產出），要分辨：** 拿同一個模型直接打端點、
   帶 `tools` 陣列。回文字 → 接線／方言問題，修 harness。回 `tool_calls` 但在 harness
   裡仍然不動手 → 模型撐不住這個提示，換大一點的。

   附帶一提，`tools.format native` 對這種情況**無效**（實測過），因為問題不在傳輸格式。

### 同一個底模的不同建置也要挑——差距不比換模型小

模型選定之後還有一層：**同一個底模常常有多個量化／解碼建置**，而派工這種長輸出場景吃得到差別。

實測（`omp bench --runs 3 --par 1 --max-tokens 512`，2026-08-19）：

| 建置 | TTFT | 生成吞吐 | 總時間 |
|---|---|---|---|
| **Qwen3.8-27B-oQ4e-mtp** | 901ms | **53.8 tok/s** | **9.5 秒** |
| Qwen3.8-27B-4bit | **711ms** | 35.1 tok/s | 14.6 秒 |

兩者是同一個底模、同一個品質定位（dense 27B，屬於「準但慢」那一類），差在 MTP
（multi-token prediction）解碼。**生成吞吐約 1.5 倍，但 TTFT 反而略差**——MTP 的 draft
有固定開銷。所以短回應的互動場景幾乎沒差，**長輸出與派工才吃得到好處**。

**派工預設用 `Qwen3.8-27B-oQ4e-mtp`（dense）。** 下面所有設定範例都以它為準。
`~/.pi/agent/settings.json` 的 `defaultModel` 也設成它，這樣忘了帶 `--model` 時的落點是對的。

**這個預設不要為了「這件事很小」而降級。** 下面「兩個都能用的時候」那一節原本讀起來像是
「小事丟給快的」——實測證明那對**編輯既有檔案**不成立，理由見該節最後一小節。

⚠️ 其他檔案的表格裡標著 `Qwen3.8-27B-4bit` 的數字，是**在那個建置上量到的**，不要
直接換算到 oQ4e-mtp——兩者的品質定位相同，但秒數不能互相套用。

### 兩個都能用的時候：快的做量，準的做難的

同一個 harness（pi）、同一個任務，兩個可用模型的差距是**取捨**，不是優劣：

| | MoE 35B-A3B | Qwen3.8-27B（dense） |
|---|---|---|
| 耗時 | **157 秒** | 867 秒（5.5 倍） |
| 測試數 | 5 | **12** |
| 行覆蓋率 | 81% | **100%** |
| 分支覆蓋率 | 67% | **100%** |
| 遵守風格指示 | 部分 | **完整** |

MoE 快五倍但**漏掉三分之一的分支**。所以排派工的時候分兩批：量大的簡單目標給快的，
覆蓋率權重高的目標、以及第一輪失敗的那些，給準的。

（n=1，單一檔案。方向可信，數字不要當精確值。）

#### 但「量」不包含編輯既有檔案——那一格一律用 dense

上面那條分工只在**新寫檔案**（greenfield，例如整支測試檔）成立。**編輯既有檔案不要交給 MoE**，
不管任務多小。

實測（2026-08-19，grill-me 的 token 重構）：同一份任務書、同一個 harness、同一個端點，
內容是「在一個陣列裡插入一行 `'dg-grid',`」——**這是能想像的最小編輯**：

| 模型 | 事件分布 | 結果 |
|---|---|---|
| Qwen3.6-35B-A3B-4bit（MoE） | 28 read / 12 write / **4 execute** | ✗ 目標檔一行未動，反而在 repo 根目錄生出 `list-superpowers.sh` 與 `search.ps1` |
| **Qwen3.8-27B-oQ4e-mtp（dense）** | **2 read / 1 edit** | **✓ 一次過** |

那兩個檔案的內容是 `dir /s /b` 與 `Get-ChildItem -Recurse`——**列目錄用的探索腳本**。
`execute` 這個工具我根本沒給（只給 `read,write,edit`），是它自己叫的。

**所以這是「把工具收掉」那一節的重要補充：收掉 bash 只擋住一半。** 那一節說模型會改用
`ls`／`cat` 繞道，前提是它還有 bash；**bash 也拿掉之後，它會把 `write` 當成 bash 的替代品，
去寫一支腳本**。症狀不是零產出，是**多出你沒要求的檔案，而目標檔完全沒動**——
而且 exit code 是 0，自報成功。

這是「退化成用文字描述我要做什麼」的變體：不是吐 ```` ```json ```` 區塊，是吐 `.sh` / `.ps1`。

**判準：任務要動既有檔案 → dense。任務是從零寫一個新檔案 → 才可以考慮 MoE 換速度。**
省下來的那幾分鐘不值得一輪重派，何況重派前還得先把它亂寫的檔案找出來刪掉——
那個清理成本沒有出現在上面的秒數表裡。

### 健康指標（30 秒判斷要不要換模型）

跑一次 `--mode json`，統計事件：

```bash
grep -c thinking_delta events.json                    # 思考量
grep -o '"name":"[a-z_]*"' events.json | sort | uniq -c  # 工具呼叫分布
```

⚠️ **這兩個數字都要先除以事件倍數，不然你會診斷一個不存在的問題。**
`--mode json` 的每一次 tool call 會噴**好幾個**事件（呼叫、參數、結果…），實測 pi 是
**一次呼叫約 3–4 個事件**。所以 `uniq -c` 數出來的「12 read」很可能只是**4 個檔案各讀一次**。

先校準再判讀，做法是看它讀了**哪些**檔案而不是讀了幾次：

```bash
grep -o '"path":"[^"]*"' events.json | sort | uniq -c   # 每個檔案出現幾次 → 倍數就是這個數
```

出現的檔案如果正好是任務書點名的那幾個、次數又整齊一致，那就是正常工作，不是漫遊。
真正的漫遊長相是**出現了沒被點名的檔案**，或次數遠超過檔案數。

沒校準的後果我踩過：把「4 個檔案各讀 1 次」讀成「12 次 read、0 次 write」，
差點按下面那條去換模型——而它其實正在正常地生成 250 行的檔案。

**thinking 破千而 `write` 是 0 → 換模型，不要調參數。**
`read` 很多而 `write` 是 0 → 任務書沒把探索關掉
（修法是**拿掉工具**，不是加強措辭——見 `references/verifying.md`）。

這個指標比任何錯誤訊息都準，因為卡住的 agent**不會報錯**，只會逾時。

## `--thinking off` 可能是空操作——要驗證，不要相信

量到 thinking 破千之後，第一個動作是關掉它。但**下旗標不等於關掉了**。實測過兩種
失敗，症狀一模一樣（thinking 破千、`write` 是 0、逾時），原因完全不同：

| 失敗 | 發生了什麼 | 怎麼看出來 |
|---|---|---|
| **開關沒接上** | 模型設定沒宣告 `reasoning`，harness 的 thinking 控制整段被跳過，一個參數都沒送，端點吃自己的預設 | `pi --list-models` 的 reasoning 欄是 `no` |
| **鍵名不對** | harness 送了 `reasoning_effort`，但端點只看 `chat_template_kwargs.enable_thinking` | 用記錄 proxy 錄下 request body，或直接打端點對照 |

第一種特別陰險：pi 的 `pi-ai/dist/api/openai-completions.js` 裡，**每一個** thinking
分支都被 `model.reasoning` 這個條件擋著。沒宣告就完全不送，`--thinking off` 不會報錯、
不會警告，只是什麼都沒做。

### 診斷：直接打端點，量 `reasoning_content` 長度

不要猜，兩發 curl 就有答案——分別送與不送候選的關閉鍵，比 `reasoning_content` 的長度：

```bash
curl -s "$BASE/chat/completions" -H "Content-Type: application/json" \
  -d '{"model":"'"$M"'","max_tokens":120,
       "messages":[{"role":"user","content":"1+1=?"}],
       "chat_template_kwargs":{"enable_thinking":false}}'
```

實測 Qwen3.8-27B（MLX 端點）：

| 送的參數 | reasoning 長度 | content 長度 |
|---|---|---|
| 預設（什麼都不送） | 97 | 1 |
| `chat_template_kwargs.enable_thinking=false` | **0** | 13 |
| `thinking_token_budget=64` | 216 | 185（**完全無效**） |

最後一行是重點：**不要假設「限制思考長度」這個中間選項存在。** pi 有
`compat.supportsThinkingTokenBudget`（送 top-level `thinking_token_budget`），原始碼
註解描述的正是這個病症，但這台端點根本不吃這個參數，開了只會得到假的安心感。
這類端點就是二元開關，沒有中間值。

同一個鍵在 Qwen3.6-35B-A3B（MoE）上一樣有效：預設 reasoning 443 字／content 5 字，
關掉之後 0／9。**MoE 思考比較少，不等於不用關。**

### 設定：pi（`~/.pi/agent/models.json`）

兩個欄位缺一不可：

```json
{
  "id": "Qwen3.8-27B-oQ4e-mtp",
  "contextWindow": 262144,
  "maxTokens": 32768,
  "reasoning": true,
  "compat": {
    "thinkingFormat": "chat-template",
    "chatTemplateKwargs": {
      "enable_thinking": { "$var": "thinking.enabled" }
    }
  }
}
```

- `reasoning: true` 是**總開關**，不是「這個模型會思考」的描述性標註。少了它，下面
  那段 compat 一行都不會執行。
- `$var: thinking.enabled` 解析成 `!!reasoningEffort`：`--thinking off` → `false`，
  其他等級 → `true`。這是**活的開關**，比寫死 `false` 好——難的目標還是可以開回來。
- 不要用 `thinkingFormat: "qwen-chat-template"`，它會多送一個 `preserve_thinking`。
  只送你驗證過的那個鍵。

### 設定：omp（`~/.omp/agent/models.yml`）

omp 沒有等價的 `$var` 機制，只能寫死：

```yaml
- id: Qwen3.8-27B-oQ4e-mtp
  compat:
    extraBody:
      chat_template_kwargs:
        enable_thinking: false
```

代價是這個模型在 omp 底下永遠不思考，`--thinking` 對它完全失效。純派工用途沒差。

### 驗證：跑一次真的任務，兩個方向都要看

改完設定不要相信它，跑一次數事件：

```bash
pi -p "Create a file named hello.txt containing exactly: hello" \
  --provider <provider> --model <model> --thinking off \
  --tools read,write --no-session --no-context-files --no-skills --no-extensions \
  --mode json > events.json 2>&1
grep -c thinking_delta events.json
```

實測 Qwen3.8-27B：

| | thinking_delta | 工具呼叫 |
|---|---|---|
| `--thinking off` | **0** | write ×4 |
| `--thinking high` | 26 | read ×4 + write ×4 |

**兩個方向都要跑。** 只跑 off 那次看到 0，分不出「開關有效」和「設定寫錯所以永遠關著」
——而後者會在你想用高精度模式時安靜地騙你。

順帶一提，high 那次多出來的 4 次 read 就是強迫性探索。派工一律帶 `--thinking off`。
