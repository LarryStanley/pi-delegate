#!/usr/bin/env node
// pi --mode rpc 的最小替身。只實作測試需要的行為。
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (prefix) => {
  const found = args.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
};

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

// 真實 pi 的 usage 掛在 AssistantMessage 上，不是事件的頂層欄位
// （pi-ai `interface AssistantMessage { … usage: Usage … }`；pi-agent-core 的
// AgentEvent 裡 message_update / message_end 只有 message + assistantMessageEvent）。
// 這個替身以前自己發明了頂層 `usage`，實作照著讀，於是單元測試全綠、真實派工
// 永遠回報 in 0 / out 0。替身要長得像真品，否則測試只是在測自己的想像。
const assistantMessage = (text, { input = 10, output = 5 } = {}) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "omlx",
  model: "fake",
  usage: {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

emit({ type: "session", version: 3, id: "fake", cwd: process.cwd() });

// --sigterm-log=<path>：每收到一次 SIGTERM 就在該檔案追加一行。獨立於
// --ignore-sigterm/--stay-alive 之外運作，用來讓測試從外部觀察 dispatch()
// 到底送了幾次 SIGTERM —— 驗證 abort() 跟 settleFromTerminalEvent() 的
// `settled` 互斥閘門有沒有真的擋掉第二次 killWithEscalation()。註冊監聽器
// 這件事本身就會讓 Node 不對 SIGTERM 執行預設的終止行為，所以子行程不會
// 自己死，只能靠之後真的送達的 SIGKILL 收尾。
const sigtermLog = valueOf("--sigterm-log=");
if (sigtermLog) {
  process.on("SIGTERM", () => {
    try {
      appendFileSync(sigtermLog, "SIGTERM\n");
    } catch {
      // 忽略寫檔錯誤，不影響信號計數這個主要目的
    }
  });
}

// --late-agent-end=<ms>：延遲 ms 之後才發終局事件。搭配 --ignore-sigterm 用來
// 製造「終局事件比 timeout 晚到」這個競態：dispatch() 的 timeout 路徑若沒有把
// `settled` 翻起來，這個遲到的事件會再跑一次完整的 settle 路徑（第二次 SIGTERM、
// graceTimer 被覆蓋、第一個計時器變孤兒）。
const lateAgentEnd = valueOf("--late-agent-end=");
if (lateAgentEnd) {
  setTimeout(() => emit({ type: "agent_end", messages: [] }), Number(lateAgentEnd));
}

// --model-error：真實的「API 呼叫失敗」形狀（實測自打錯 model id 的 pi 0.80.2）：
// preflight 先成功，接著一個 content 空、stopReason:"error"、帶 errorMessage 的
// assistant 訊息，最後照常 agent_end。判決若只認 response success:false，這裡會
// 變成 0 秒的假 completed。
if (has("--model-error")) {
  emit({ type: "response", command: "prompt", success: true });
  const failed = {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "omlx",
    model: "nope",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    errorMessage: "404 Model 'nope' not found.",
    timestamp: Date.now(),
  };
  emit({ type: "message_end", message: failed });
  emit({ type: "agent_end", messages: [failed], willRetry: false });
  setInterval(() => {}, 1000);
} else if (has("--retry-then-end")) {
  // pi 的 auto-retry：第一次 agent_end 帶 willRetry:true（還會再跑一輪），
  // 真正的終局事件在後面。dispatch() 若把前者當終局，會提早收尾並殺掉
  // 還要重試的子行程。
  const failed = {
    role: "assistant", content: [], stopReason: "error",
    errorMessage: "429 rate limited", timestamp: Date.now(),
  };
  emit({ type: "message_end", message: failed });
  emit({ type: "agent_end", messages: [failed], willRetry: true });
  setTimeout(() => {
    emit({ type: "message_end", message: assistantMessage("重試之後成功了") });
    emit({ type: "agent_end", messages: [], willRetry: false });
  }, 400);
  setInterval(() => {}, 1000);
} else if (has("--api-error")) {
  // 模擬「omlx 掛了 / model id 打錯」：pi 的 rpc mode 對 prompt 的 preflight 失敗
  // 會吐一個 {type:"response", command:"prompt", success:false, error} 然後**繼續活著**
  // 等下一個指令（rpc mode 刻意不 exit）。形狀取自 dist/modes/rpc/rpc-types.d.ts 的
  // RpcResponse union 最後一支與 rpc-mode.js:37 的 error() helper。
  process.stdin.on("data", () => {
    emit({
      type: "response",
      command: "prompt",
      success: false,
      error: "omlx: connect ECONNREFUSED 127.0.0.1:8000",
    });
  });
  setInterval(() => {}, 1000);
} else if (has("--ignore-sigterm")) {
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
    emit({ type: "message_update", message: assistantMessage("done"), assistantMessageEvent: { type: "text_end" } });
    emit({ type: "message_end", message: assistantMessage("done") });
    emit({ type: "agent_end", messages: [assistantMessage("done")] });
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
          emit({ type: "message_end", message: assistantMessage(`收到：${command.message}`) });
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
    emit({ type: "message_update", message: assistantMessage("done"), assistantMessageEvent: { type: "text_end" } });
    emit({ type: "message_end", message: assistantMessage("done") });
    emit({ type: "agent_end", messages: [assistantMessage("done")] });
    process.exit(0);
  }
}
