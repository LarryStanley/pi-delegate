#!/usr/bin/env node
// pi --mode rpc 的最小替身。只實作測試需要的行為。
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (prefix) => {
  const found = args.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
};

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

emit({ type: "session", version: 3, id: "fake", cwd: process.cwd() });

if (has("--ignore-sigterm")) {
  // 吃掉 SIGTERM，逼 dispatch() 的逾時/中止邏輯必須真的送出 SIGKILL 才能
  // 結束這個子行程 —— 用來驗證 grace-period escalation 有沒有被
  // child.killed 誤判短路掉。SIGKILL 本身不能被攔截，所以最終還是會死。
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (has("--hang")) {
  // 永不結束，等待被 kill 或 abort
  setInterval(() => {}, 1000);
} else {
  const writes = valueOf("--write=");
  if (writes) {
    writes.split(",").forEach((path, index) => {
      emit({ type: "tool_execution_start", toolCallId: `c${index}`, toolName: "write", args: { path } });
      emit({ type: "tool_execution_end", toolCallId: `c${index}`, toolName: "write", result: {}, isError: false });
    });
  }

  if (has("--stay-alive")) {
    // 模擬真實 pi --mode rpc 的行為：吐完正常事件序列（含 agent_end）之後
    // 不會 exit，而是繼續活著等下一個指令（steer/abort）。dispatch() 若還在
    // 用 child.on("close") 當唯一判決入口，這裡就會一路卡到 timeout。
    emit({ type: "message_update", usage: { input: 10, output: 5 } });
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
    emit({ type: "agent_end" });
    setInterval(() => {}, 1000);
  } else if (has("--echo-steer")) {
    let buffer = "";
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const command = JSON.parse(line);
        // NOTE (deviation from task-6-brief.md): the brief's condition was
        // `command.type === "steer" || command.type === "prompt"`. dispatch()
        // sends a {type:"prompt"} immediately on spawn, so that condition would
        // answer the initial prompt, emit agent_settled, and exit before the
        // test ever calls handle.steer() — the steer assertion could never
        // observe its own message. Restricting to "steer" only forces the fake
        // to wait for the actual steer write, which is the behavior the test
        // is meant to prove.
        if (command.type === "steer") {
          emit({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: `收到：${command.message}` }] },
          });
          // 真實 pi 0.80.2 發的是 agent_end，不是 agent_settled（文件裡有
          // agent_settled，但實跑 `pi --mode rpc` 從沒看過）。payload 就用
          // 裸物件：computeVerdict 只看 e.type，不讀 agent_end 的欄位，帶著
          // messages 只是徒增假象的真實感，卻沒有測試在驗證它。
          emit({ type: "agent_end" });
          process.exit(0);
        }
      }
    });
  } else {
    emit({ type: "message_update", usage: { input: 10, output: 5 } });
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
    emit({ type: "agent_end" });
    process.exit(0);
  }
}
