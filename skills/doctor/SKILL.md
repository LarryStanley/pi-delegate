---
description: 檢查 pi 的派工環境（派工會打到哪個 provider / 模型、thinking 綁定、副駕駛守門）
disable-model-invocation: true
---

先檢查：

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/pi-doctor" --check
```

輸出的 `effective` 區塊就是「派工實際會打到誰」。**沒有設定
`~/.claude/pi-delegate/config.json` 是正常的** —— 那代表派工會用使用者自己的 pi 預設
模型（`~/.pi/agent/settings.json` 的 `defaultProvider` / `defaultModel`）。

若回報有問題，向使用者說明各問題的影響後再詢問是否處理：

- `reasoning-missing` / `compat-missing` —— 只會對**本機 OpenAI 相容伺服器**
  （例如 omlx、LM Studio、llama.cpp、vLLM）出現：模型缺 `reasoning: true` 或
  `compat.chatTemplateKwargs.enable_thinking` 綁定時，`--thinking off` 會**靜默失效**，
  模型會一直思考不動手。這一類可以自動修。
- `drafter-selected` —— 即將派工的模型看起來是推測解碼的副駕駛（draft / assistant），
  直接呼叫會回 HTTP 500。請使用者改用 target model；若是誤判，調整 config 的
  `drafter_patterns`。**這一類不自動修**，因為該用哪顆模型是使用者的決定。

取得同意後修復可自動修的部分（會先備份成 `models.json.pi-delegate.bak`）：

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/pi-doctor" --fix
```

`--fix` 只會替**已經註冊、而且確定是本機 chat-template 端點**的那個模型補上 thinking
綁定。它不會建立 provider、不會插入模型、也不會碰其他模型 —— 那些需要只有使用者知道的
值，猜出來的設定比沒有設定更難除錯。
