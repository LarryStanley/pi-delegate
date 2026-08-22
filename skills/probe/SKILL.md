---
description: 取得一次性放行，讓下一個 Write/Edit 不被 strict 模式擋下（用於探針）
disable-model-invocation: true
---

使用者要做探針 —— 親手做**一處**最小可行的修改並跑過，之後要把配方寫進任務書。

建立一次性放行旗標：

```bash
node -e "import('${CLAUDE_PLUGIN_ROOT}/src/guard.mjs').then(async g => { const {mkdirSync,writeFileSync}=await import('node:fs'); const {dirname}=await import('node:path'); const p=g.probeFlagPath(); mkdirSync(dirname(p),{recursive:true}); writeFileSync(p,'1'); console.log('探針放行已開啟：下一個 Write/Edit 會通過'); })"
```

然後告訴使用者：**這個旗標只能用一次**，下一個 Write/Edit 通過後自動關閉。
做完探針後立刻把已驗證的配方寫成任務書，其餘的照樣派給 pi。
