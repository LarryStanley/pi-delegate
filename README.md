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
