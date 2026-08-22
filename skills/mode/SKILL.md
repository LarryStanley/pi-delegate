---
description: 切換這個專案的 pi 派工模式（off / soft / strict）
disable-model-invocation: true
---

使用者要求把 pi-delegate 模式設為：$ARGUMENTS

執行下列指令（把 `<mode>` 換成 `$ARGUMENTS`，只接受 `off`、`soft`、`strict`）：

```bash
node -e "import('${CLAUDE_PLUGIN_ROOT}/src/modes.mjs').then(m => { m.setMode(process.cwd(), '<mode>'); console.log('模式已設為', m.getMode(process.cwd())); })"
```

若 `$ARGUMENTS` 為空，改為只顯示目前模式：

```bash
node -e "import('${CLAUDE_PLUGIN_ROOT}/src/modes.mjs').then(m => console.log('目前模式：', m.getMode(process.cwd())))"
```

三個模式的差別：
- `off` —— 完全不介入。適合不該讓 pi 碰的專案。
- `soft` —— 動到既有產品碼時提醒（預設）。
- `strict` —— 動到既有產品碼時**擋下來**，要求改用 `pi_dispatch`。
