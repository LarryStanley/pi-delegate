import { test } from "node:test";
import assert from "node:assert/strict";
import { computeVerdict, formatVerdict, assistantText, LAST_MESSAGE_LIMIT } from "../src/verdict.mjs";

const BASE = {
  events: [],
  aborted: false,
  timedOut: false,
  exitCode: 0,
  requestedFiles: [],
  gitDiffStat: "",
  durationS: 1,
  sessionId: "s1",
};

const settled = { type: "agent_settled" };
const ended = { type: "agent_end" };

function writeStart(id, path) {
  return { type: "tool_execution_start", toolCallId: id, toolName: "write", args: { path } };
}
function readStart(id, path) {
  return { type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path } };
}

test("有 agent_settled 就是 completed", () => {
  const v = computeVerdict({ ...BASE, events: [settled] });
  assert.equal(v.status, "completed");
});

// Regression test: pi 0.80.2 emits agent_end, not agent_settled. `agent_settled` is **not
// in pi's documentation** — it is absent from the event table in docs/rpc.md and from
// pi-agent-core's AgentEvent union (types.d.ts:360-398); the name was invented by the test
// double. It stays in TERMINAL_SUCCESS_EVENTS purely for forward compatibility, never
// because "the docs say so". The event array here deliberately carries only agent_end and
// no agent_settled at all, so resolveStatus cannot be passing merely because both cases
// happen to take the agent_settled branch — which is precisely the defect that kept 94 unit
// tests green while misjudging every successful real dispatch as a timeout (fixture and
// implementation both believed pi would emit agent_settled).
test("agent_end alone (with no agent_settled) also counts as completed", () => {
  const v = computeVerdict({ ...BASE, events: [ended] });
  assert.equal(v.status, "completed");
});

test("timedOut 優先於 agent_settled 之外的一切，但 aborted 更優先", () => {
  assert.equal(computeVerdict({ ...BASE, timedOut: true }).status, "timeout");
  assert.equal(computeVerdict({ ...BASE, timedOut: true, aborted: true }).status, "aborted");
});

test("沒有 agent_settled 且未逾時未中止就是 failed", () => {
  assert.equal(computeVerdict({ ...BASE, exitCode: 1 }).status, "failed");
});

test("write_count 以 toolCallId 去重，重複事件不重複計數", () => {
  const events = [
    writeStart("c1", "a.ts"),
    { type: "tool_execution_update", toolCallId: "c1", toolName: "write", args: { path: "a.ts" } },
    { type: "tool_execution_end", toolCallId: "c1", toolName: "write", result: {}, isError: false },
    writeStart("c2", "b.ts"),
    settled,
  ];
  const v = computeVerdict({ ...BASE, events });
  assert.equal(v.write_count, 2);
  assert.deepEqual(v.files_written, ["a.ts", "b.ts"]);
});

test("edit 與 write 都計入 write_count", () => {
  const events = [
    writeStart("c1", "a.ts"),
    { type: "tool_execution_start", toolCallId: "c2", toolName: "edit", args: { path: "b.ts" } },
    settled,
  ];
  assert.equal(computeVerdict({ ...BASE, events }).write_count, 2);
});

test("讀到任務書沒點名的檔案會列入 files_read_unrequested", () => {
  const events = [readStart("r1", "src/a.ts"), readStart("r2", "src/other.ts"), settled];
  const v = computeVerdict({ ...BASE, events, requestedFiles: ["src/a.ts"] });
  assert.deepEqual(v.files_read_unrequested, ["src/other.ts"]);
});

test("最後一則 assistant 訊息超過上限時截斷並標記", () => {
  const long = "x".repeat(LAST_MESSAGE_LIMIT + 50);
  const events = [
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: long }] } },
    settled,
  ];
  const v = computeVerdict({ ...BASE, events });
  assert.equal(v.last_message.length, LAST_MESSAGE_LIMIT);
  assert.equal(v.last_message_truncated, true);
});

test("最後一則訊息在上限內時不截斷", () => {
  const events = [
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    settled,
  ];
  const v = computeVerdict({ ...BASE, events });
  assert.equal(v.last_message, "done");
  assert.equal(v.last_message_truncated, false);
});

test("取的是最後一則 assistant 訊息，不是第一則", () => {
  const mk = (t) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: t }] } });
  const v = computeVerdict({ ...BASE, events: [mk("first"), mk("last"), settled] });
  assert.equal(v.last_message, "last");
});

// [C3] 真實形狀：usage 是 AssistantMessage 的欄位（pi-ai types.d.ts），
// 事件本身沒有頂層 usage（pi-agent-core 的 AgentEvent union）。這個測試若紅，
// 代表判決又回去讀事件頂層了 —— 真實派工會永遠回報 in 0 / out 0。
function updateWithUsage(input, output) {
  return {
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "…" }],
      usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output },
      stopReason: "stop",
    },
    assistantMessageEvent: { type: "text_delta" },
  };
}

test("with streaming events only (message_update), the last message.usage is used (the real pi shape)", () => {
  const events = [updateWithUsage(10, 1), updateWithUsage(100, 42), ended];
  const v = computeVerdict({ ...BASE, events });
  assert.deepEqual(v.tokens, { input: 100, output: 42 });
});

// --- tokens is the run total, not the last message's usage ---
//
// Each pi AssistantMessage carries the usage of its own API call; it is **not cumulative**.
// The evidence is pi's own getSessionStats() (dist/core/agent-session.js:2364-2404):
//   for (const message of state.messages)
//     if (message.role === "assistant") { totalInput += usage.input; totalOutput += usage.output; }
// The fact that it has to add them up proves usage is not a running total. The old version
// read only the last event carrying usage, so a multi-turn dispatch under-reported output
// badly and input became "the context size at the moment of settling".
//
// What is summed is message_end (once per message), not message_update (emitted many times
// while streaming, which would double-count) — agent-session.js:277 is likewise where a
// message_end appends the message into state.messages, the very array getSessionStats sums.
function assistantMessageEnd(input, output, text = "…") {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "fake-provider",
      model: "fake",
      usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 0,
    },
  };
}

test("tokens for a multi-turn dispatch is the sum over all assistant messages, not the last one", () => {
  const events = [
    assistantMessageEnd(100, 20, "第一輪"),
    { type: "tool_execution_start", toolCallId: "c1", toolName: "write", args: { path: "a.ts" } },
    assistantMessageEnd(250, 35, "第二輪"),
    assistantMessageEnd(400, 50, "第三輪"),
    ended,
  ];
  const v = computeVerdict({ ...BASE, events });
  assert.deepEqual(v.tokens, { input: 750, output: 105 });
  assert.notDeepEqual(v.tokens, { input: 400, output: 50 }, "must not report only the last message usage");
});

test("message_update events during streaming are not double-counted in the sum", () => {
  const events = [
    updateWithUsage(100, 10),
    updateWithUsage(100, 20),
    assistantMessageEnd(100, 20),
    ended,
  ];
  assert.deepEqual(computeVerdict({ ...BASE, events }).tokens, { input: 100, output: 20 });
});

test("message_end for user / toolResult messages does not count toward the token sum", () => {
  const events = [
    { type: "message_end", message: { role: "user", content: "hi", usage: { input: 999, output: 999 } } },
    assistantMessageEnd(10, 5),
    ended,
  ];
  assert.deepEqual(computeVerdict({ ...BASE, events }).tokens, { input: 10, output: 5 });
});

// 容錯分支：萬一某個版本真的把 usage 提到事件頂層也要讀得到。這是 fallback，
// 不是主要契約 —— 上面那個測試才是。
test("token 用量在事件頂層帶 usage 時也讀得到（容錯 fallback）", () => {
  const events = [
    { type: "message_update", usage: { input: 10, output: 1 } },
    { type: "message_update", usage: { input: 100, output: 42 } },
    settled,
  ];
  const v = computeVerdict({ ...BASE, events });
  assert.deepEqual(v.tokens, { input: 100, output: 42 });
});

test("沒有任何 usage 時退回 0/0", () => {
  assert.deepEqual(computeVerdict({ ...BASE, events: [ended] }).tokens, { input: 0, output: 0 });
});

test("逾時仍附上 git_diff_stat（逾時不等於沒做事）", () => {
  const v = computeVerdict({ ...BASE, timedOut: true, gitDiffStat: "1 file changed, 3 insertions(+)" });
  assert.equal(v.status, "timeout");
  assert.equal(v.git_diff_stat, "1 file changed, 3 insertions(+)");
});

test("formatVerdict 輸出不超過 20 行且含所有欄位", () => {
  const v = computeVerdict({ ...BASE, events: [settled] });
  const text = formatVerdict(v);
  assert.ok(text.split("\n").length <= 20);
  for (const key of ["status", "write_count", "session_id", "last_message"]) {
    assert.ok(text.includes(key), `缺欄位 ${key}`);
  }
});

// --- [I2] pi 回報的終局失敗 ---

test("failure 非空時就是 failed，即使事件流裡沒有任何終局事件", () => {
  const v = computeVerdict({ ...BASE, failure: "provider: connect ECONNREFUSED" });
  assert.equal(v.status, "failed");
  assert.equal(v.failure, "provider: connect ECONNREFUSED");
});

test("aborted / timedOut 仍優先於 failure", () => {
  assert.equal(computeVerdict({ ...BASE, failure: "x", timedOut: true }).status, "timeout");
  assert.equal(computeVerdict({ ...BASE, failure: "x", aborted: true }).status, "aborted");
});

test("formatVerdict 在有 failure 時多印一行", () => {
  const text = formatVerdict(computeVerdict({ ...BASE, failure: "model not found" }));
  assert.match(text, /failure:\s+model not found/);
});

// --- [I3] spec §11：spawn 失敗要「附 stderr」 ---

test("stderr 進得了判決，也印得出來", () => {
  const v = computeVerdict({ ...BASE, stderr: "spawn pi ENOENT\n" });
  assert.equal(v.stderr, "spawn pi ENOENT\n");
  assert.match(formatVerdict(v), /stderr:\n {2}spawn pi ENOENT/);
});

test("stderr 為空時 formatVerdict 不印那一段", () => {
  assert.ok(!formatVerdict(computeVerdict({ ...BASE, events: [ended] })).includes("stderr:"));
});

test("formatVerdict 只印 stderr 尾巴，不讓長 traceback 撐爆判決", () => {
  const noisy = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const text = formatVerdict(computeVerdict({ ...BASE, stderr: noisy }));
  assert.ok(text.includes("line 39"), "要留最後一行");
  assert.ok(!text.includes("line 30"), "不該印到 30 行以前");
});

// --- [I7] 判決與逐字稿共用同一支 assistant 文字解析器 ---

test("assistantText 同時吃字串型與陣列型 content", () => {
  assert.equal(assistantText({ role: "assistant", content: "純字串" }), "純字串");
  assert.equal(
    assistantText({ role: "assistant", content: [{ type: "text", text: "a" }, { type: "thinking", thinking: "x" }, { type: "text", text: "b" }] }),
    "ab",
  );
  assert.equal(assistantText({ role: "user", content: "不是 assistant" }), "");
  assert.equal(assistantText(undefined), "");
});

test("字串型 content 的 message_end 也能成為 last_message", () => {
  const events = [{ type: "message_end", message: { role: "assistant", content: "字串型回答" } }, ended];
  assert.equal(computeVerdict({ ...BASE, events }).last_message, "字串型回答");
});

// --- [I2, 修正版] 真實 pi 的 API 失敗形狀：assistant 訊息帶 stopReason:"error" ---
// 實測（打錯 model id 的 pi 0.80.2）：preflight 回 success:true，錯誤是掛在
// assistant 訊息上的，後面照常有 agent_end。只認 response success:false 的話
// 這裡會回 completed —— 0 秒的假綠燈，比逾時更難發現。

function failedAssistantMessage(errorMessage) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      usage: { input: 0, output: 0 },
      stopReason: "error",
      errorMessage,
    },
  };
}

test("assistant 訊息 stopReason=error 時判 failed，即使後面有 agent_end", () => {
  const v = computeVerdict({
    ...BASE,
    events: [failedAssistantMessage("404 Model 'nope' not found."), { type: "agent_end", willRetry: false }],
  });
  assert.equal(v.status, "failed");
  assert.match(v.failure, /404 Model 'nope' not found\./);
});

test("先失敗後成功（重試成功）的事件流仍判 completed", () => {
  const v = computeVerdict({
    ...BASE,
    events: [
      failedAssistantMessage("429 rate limited"),
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "好了" }], stopReason: "stop" } },
      ended,
    ],
  });
  assert.equal(v.status, "completed");
  assert.equal(v.failure, null);
});

test("agent_end 帶 willRetry:true 不算終局（pi 還會自己重試一輪）", () => {
  const v = computeVerdict({ ...BASE, events: [{ type: "agent_end", willRetry: true }] });
  assert.notEqual(v.status, "completed");
});
