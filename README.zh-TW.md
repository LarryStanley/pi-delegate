<!-- 這份翻譯對應的 README.md 版本；用 `git hash-object README.md` 比對，不一樣就是落後了。
     synced-with-blob: 8726f79de6d903c442cb51a11584af5579cf05dc -->

# pi-delegate

[English](README.md) · [繁體中文](README.zh-TW.md)

在文件裡寫一條規則叫 Claude 把寫程式的工作交出去，這條規則撐不住：從這個 repo 自己的歷史來看，大約 80% 被 commit 的字元仍然是主模型打出來的。pi-delegate 把那段文字換成一個 hook —— Claude 繼續當 tech lead，負責寫任務書與判定，然後用本地的 [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) agent 來寫原始碼與測試。

![A Claude Code session: Claude reads the source, writes a task book, calls pi_dispatch, and three pi rows appear under the user's own status line with their elapsed times](docs/diagrams/statusline-mockup.svg)

*Claude 讀程式碼並寫下契約；`pi_dispatch` 把要寫的部分交給 pi。狀態列下方的每一列代表這一個視窗的一次 dispatch，一列一個，當最後一個結束時就會消失。*

dispatch 會送到你的 `pi` 目前已經指向的任何 provider 與 model；這個 plugin 不會綁定任何東西。在 `strict` 模式下，一個 `PreToolUse` hook 會拒絕 Claude 對既有產品原始碼進行自己的 `Write` 與 `Edit`，並叫它改用 dispatch。

這條護欄有個洞，而且是刻意的：hook 只會比對 `Write` 與 `Edit`，所以同樣的修改如果透過 `Bash`（例如 `sed -i` 或 heredoc）進行，就永遠攔截不到。它擋的是你順手自己改檔案的習慣，不是有心人的繞道。

## 安裝

```
/plugin marketplace add LarryStanley/pi-delegate
/plugin install pi-delegate@pi-delegate
```

在 Claude Code 內執行這兩行：第一行會把這個 repository 註冊為 plugin marketplace，第二行會從中安裝 plugin。如果安裝摘要顯示 `Run /reload-plugins to activate.`，也請執行該指令。需要 Node ≥ 22 以及已經設定好的 `pi` 安裝；相依套件會從 commit 的 lockfile 自動安裝，所以你不需要自己執行 `npm install`。

之後要更新時：

```
/plugin marketplace update pi-delegate
```

<details>
<summary>Local development install</summary>

```bash
claude --plugin-dir /path/to/pi-delegate
```

執行的是開發中的版本而非發佈版。該 session 會優先使用 `--plugin-dir` 版本而非已安裝的版本，所以你不需要解除安裝就能測試改動。

</details>

接著執行 `/pi-delegate:setup`：它會尋找 `pi` 並確認 dispatch 實際上會送到哪個 provider 與 model，解釋各種 discipline modes 並詢問你想用哪一種，接著會修補它能修補的部分。最後它會提供驗收用的 dispatch 與狀態列指示器，並說明接下來該做什麼。

## 設定：預設什麼都不用設

`pi_dispatch` 沒有指定 provider 或 model，所以 dispatch 會直接落到你已經指向 pi 的地方
（`~/.pi/agent/settings.json` 裡的 `defaultProvider` / `defaultModel`）：anthropic, openai, litellm,
ollama, LM Studio, 或像 omlx 這類本地 OpenAI 相容的伺服器，處理方式都一樣。
`/pi-delegate:doctor` 會告訴你 dispatch 實際上會到達哪個模型，且只會提出適用的問題。

### 下面這些預設值是量出來的，不是猜的

| 參數 | 預設值 | 為什麼 |
|---|---|---|
| `thinking` | `off` | 小的本地模型會把整個 thinking budget 花光，一個 tool call 都不吐。夠強的託管模型碰到難題確實吃得到 thinking 的好處，所以這個值可以覆寫。 |
| `tools` | `read,write,edit` | 一給 `bash`，模型就一路 `ls` / `cat` 逛下去，什麼都不寫。 |
| `no_context_files` | `true` | 實測：沒開的時候 43 次 read、0 次 write、timeout；開了之後 93 秒跑完。 |

關於鎖定 provider 與 model、呼叫參數與設定檔與 pi 預設值之間的解析順序，以及哪些旗標屬於結構性而非讓你覆寫的：
[docs/configuration.md](docs/configuration.md)。

## 模式

| 模式 | 行為 |
|---|---|
| `off` | 完全不介入 |
| `soft` | 動到既有產品程式碼時會提醒（預設） |
| `strict` | 阻擋對既有產品程式碼的修改 |

`strict` 會阻擋 `Write` 和 `Edit`，這跟阻擋修改是不一樣的 — `sed -i` 和 heredoc 會直接繞過去，而 `/pi-delegate:probe` 會為刻意的手動修改清路。
關於什麼算既有產品程式碼、per-project state 存在哪裡，以及漏洞在哪裡：
[docs/configuration.md](docs/configuration.md)。

## MCP 工具

| 工具 | 用途 |
|---|---|
| `pi_dispatch` | dispatch 一個任務書。`mode=sync` 會等待結果，`mode=async` 在背景執行 |
| `pi_status` | 檢查進度；若沒掛載 notification watcher 也會回報 |
| `pi_steer` | 當執行方向不對時，中途插話導正 |
| `pi_abort` | 中止執行中的作業 |
| `pi_result` | 收集非同步 dispatch 的判定 |
| `pi_transcript` | 只有在判定不夠用時才深入查看 |
| `pi_stats` | 檢查 token 使用量 |

## 諮詢 pi 而非將其委派

以上所有操作都是把 pi 會用到的字元交給它，而下面這兩個正好相反：
pi 不會寫任何東西，且輸出是它的意見。

| 指令 | 用途 |
|---|---|
| `/pi-delegate:review [ref\|files]` | 在 diff 上進行第二次審查。pi 會寫出結構化的發現；接著 Claude 會**針對每一條進行程式碼比對**，並將其報告為確認 / 誤判 / 無法判定 |
| `/pi-delegate:discuss <question>` | 透過多次回合深入思考問題，並用 `resume_session_id` 帶著執行緒 |

這兩者刻意設計成 slash command 而非 MCP tools，因為工具的 schema 會在每個 context 中產生開銷，而 skill 在你呼叫它之前是不會耗費資源的。
這樣的推理邏輯與其餘的 plumbing 決策都在 [docs/design-notes.md](docs/design-notes.md)。

## 在批評方門檻後進行 dispatch

`/pi-delegate:critique <task>` 是正常的 dispatch，但多了一件事：工作不會因為 pi 說做完了就被視為完成。

| 角色 | 是誰 | 看到什麼 |
|---|---|---|
| Contract | Claude，**在任何 dispatch 發生前就已寫好** | 任務書 |
| Generator | 一個 pi session | 任務書與 contract |
| Critic | 一個**獨立的、每一輪都會重新啟動**的 pi session | contract 與 diff — 從不看 generator 的推理過程 |
| Judge | Claude | 真實的程式碼 |

成本大約是普通 dispatch 的 3-10×，且在面對本地 endpoint 時，各輪次是序列式的牆鐘時間（wall-clock）。
但在後續要花大成本找出錯誤的場景（如 auth、錢、migrations、public interfaces、silent failures）下，這很值得；
對於這種「跑完看看」的內部工具，則不值得。

## 如何得知 dispatch 已完成

兩個管道，只有一個算保證。**`pi_status` / `pi_result`：可靠。** MCP server 透過 RPC（`pi --mode rpc`）跟 pi 對話，結果一發生它就知道。**完成通知：只是方便。** MCP 沒有給 server 任何辦法把訊息推進對話裡，所以完成訊息走 per-session socket 送到 plugin 的 monitor，Claude Code 再把 monitor 的 stdout 轉成通知；而 monitor 只在互動式 CLI session 裡跑，headless 執行完全沒有 watcher。

通知本來是 `tail -F` 讀一個 log 檔，讀取端一死，完成訊息就跟著停，而且沒有任何東西會說一聲。那件事的代價、以及後來換成什麼：
[docs/design-notes.md](docs/design-notes.md).

## 在執行時查看 dispatch

`/pi-delegate:setup` 會在第 5 步提供這一列；如果你在 setup 時拒絕了，`/pi-delegate:statusline` 之後會補上。無論如何，這都是 Claude Code 狀態列（status line）上的一列，且只會在 pi dispatch 執行中存在：

```
● pi   18m22s  Qwen3.8-27B-Instruct-MLX
● pi    7m04s  qwen3-coder-30b
```

每一列都帶有自己的執行時間，會各自在 5 分鐘時轉為琥珀色、15 分鐘時轉為紅色，這就是為什麼要拆分：一個跑了 18 分鐘的 dispatch 不應該把另一個 20 秒的 dispatch 也一起變紅。安裝這列會透過執行來 probe 你現有的任何狀態列，它是與現有狀態進行整合（compose）而非取代。為什麼這列是 bash 而不是 Node，為什麼所有權是在狀態檔的第 2 行，以及 0.13.0 在計算每個視窗的 dispatches 時錯在哪裡：
[docs/design-notes.md](docs/design-notes.md).

## dispatch 如何運作

![Architecture: Claude calls MCP tools, the MCP server holds each pi child's stdio open, pi children call the user's own provider](docs/diagrams/architecture.svg)

*Claude 從不直接對話 RPC 協定 —— MCP server 持有 pipe，這才讓執行中的 `pi_steer` 和 `pi_abort` 成為可能。*

![Sequence diagram of one pi_dispatch call followed by a mid-run pi_steer, showing Claude, the MCP server, a pi child, and the provider](docs/diagrams/dispatch-sequence.svg)

*MCP server 的啟動涵蓋整個 session；這就是為什麼它在執行中仍能將 `steer` 傳送到 pi child 的 stdin，以及為什麼是它 —— 而不是 child process —— 決定執行何時結束。*

## 已知的限制

`pi_stats` 只會回傳 verdict 中已有的 `tokens` 和 `duration_s`。用來回傳 `cost` 與 `context` 使用量量的 `get_session_stats` passthrough 尚未開發完成。

## 文件

當情況需要時，Claude 會自行載入下列的 skill。列出這些是為了讓你讀出它會被告知的內容；`setup`、`doctor`、`mode` 和 `probe` 是引導你操作的指令，而不是要讀的文件。

| 檔案 | 內容 |
|---|---|
| `docs/configuration.md` | 設定檔、解析順序、不能被覆寫的旗標，以及 mode hook 涵蓋與不涵蓋的範圍 |
| `docs/design-notes.md` | 為什麼要設計完成通知 socket、per-session 狀態列、bash 狀態列以及兩個 slash command |
| `skills/delegating-to-pi/` | dispatch 紀律本身：四向拆分、任務書、驗收、模型選擇 |
| `skills/review/` | 第二意見的 review 流程，以及為什麼是由 Claude 進行判定而非轉發 |
| `skills/discuss/` | 多輪諮詢，以及為什麼回覆要保持簡短 |
| `skills/critique/` | 受限的 generator–critic loop：撰寫可判定的 contract、為什麼 critic 從不續接，以及門檻不值得建立的時機 |
| `skills/statusline/` | 將 pi 狀態指標整合進現有的 status line：使用 probe 而非假設，以及 `refreshInterval` 的代價 |

## 開發

```bash
npm test                    # node --test, no external dependencies
claude plugin validate .
```

`fixtures/fake-pi.mjs` 代表了 `pi --mode rpc`。它刻意放在 `test/` 之外，因為 `node --test` 會將 `**/test/**/*.{cjs,mjs,js}` 路徑下的任何檔案視為測試檔，如果放在 `test/` 裡會多出一個永遠會通過的虛假測試。

## 授權

MIT. 參閱 [LICENSE](LICENSE).
