import { test } from "node:test";
import assert from "node:assert/strict";
import { computeVerdict, formatVerdict, LAST_MESSAGE_LIMIT } from "../src/verdict.mjs";

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

test("token 用量取最後一個 message_update 的累計值", () => {
  const events = [
    { type: "message_update", usage: { input: 10, output: 1 } },
    { type: "message_update", usage: { input: 100, output: 42 } },
    settled,
  ];
  const v = computeVerdict({ ...BASE, events });
  assert.deepEqual(v.tokens, { input: 100, output: 42 });
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
