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
