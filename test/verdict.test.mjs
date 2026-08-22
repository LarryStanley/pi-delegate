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

// 迴歸測試：真實 pi 0.80.2 發的是 agent_end，不是 agent_settled（後者只存在於
// 文件，實跑 `pi --mode rpc` 從沒出現過）。事件陣列裡刻意只放 agent_end、完全
// 不含 agent_settled，確保 resolveStatus 不是「剛好兩個都靠 agent_settled 那條
// 分支過」——這正是原本讓 94 個單元測試全綠、卻在真實環境把每一次成功派工都
// 誤判成 timeout 的那個缺陷（fixture 和實作都以為 pi 會發 agent_settled）。
test("只有 agent_end（沒有 agent_settled）也是 completed", () => {
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

test("token 用量取最後一個事件的 message.usage（真實 pi 形狀）", () => {
  const events = [updateWithUsage(10, 1), updateWithUsage(100, 42), ended];
  const v = computeVerdict({ ...BASE, events });
  assert.deepEqual(v.tokens, { input: 100, output: 42 });
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
  const v = computeVerdict({ ...BASE, failure: "omlx: connect ECONNREFUSED" });
  assert.equal(v.status, "failed");
  assert.equal(v.failure, "omlx: connect ECONNREFUSED");
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
