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

test("agent_settled alone counts as completed", () => {
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

test("timedOut outranks everything but agent_settled, but aborted outranks timedOut", () => {
  assert.equal(computeVerdict({ ...BASE, timedOut: true }).status, "timeout");
  assert.equal(computeVerdict({ ...BASE, timedOut: true, aborted: true }).status, "aborted");
});

test("no agent_settled, not timed out, not aborted, is failed", () => {
  assert.equal(computeVerdict({ ...BASE, exitCode: 1 }).status, "failed");
});

test("write_count dedupes by toolCallId, so repeated events are not double-counted", () => {
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

test("both edit and write count toward write_count", () => {
  const events = [
    writeStart("c1", "a.ts"),
    { type: "tool_execution_start", toolCallId: "c2", toolName: "edit", args: { path: "b.ts" } },
    settled,
  ];
  assert.equal(computeVerdict({ ...BASE, events }).write_count, 2);
});

test("a file read that the task book never named lands in files_read_unrequested", () => {
  const events = [readStart("r1", "src/a.ts"), readStart("r2", "src/other.ts"), settled];
  const v = computeVerdict({ ...BASE, events, requestedFiles: ["src/a.ts"] });
  assert.deepEqual(v.files_read_unrequested, ["src/other.ts"]);
});

test("a final assistant message over the limit is truncated and flagged", () => {
  const long = "x".repeat(LAST_MESSAGE_LIMIT + 50);
  const events = [
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: long }] } },
    settled,
  ];
  const v = computeVerdict({ ...BASE, events });
  assert.equal(v.last_message.length, LAST_MESSAGE_LIMIT);
  assert.equal(v.last_message_truncated, true);
});

test("a final message within the limit is not truncated", () => {
  const events = [
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    settled,
  ];
  const v = computeVerdict({ ...BASE, events });
  assert.equal(v.last_message, "done");
  assert.equal(v.last_message_truncated, false);
});

test("takes the last assistant message, not the first", () => {
  const mk = (t) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: t }] } });
  const v = computeVerdict({ ...BASE, events: [mk("first"), mk("last"), settled] });
  assert.equal(v.last_message, "last");
});

// [C3] The real shape: usage is a field of AssistantMessage (pi-ai types.d.ts); the
// event itself carries no top-level usage (pi-agent-core's AgentEvent union). If this
// test goes red, it means the verdict went back to reading the event's top level — real
// dispatches would then always report in 0 / out 0.
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
    assistantMessageEnd(100, 20, "turn one"),
    { type: "tool_execution_start", toolCallId: "c1", toolName: "write", args: { path: "a.ts" } },
    assistantMessageEnd(250, 35, "turn two"),
    assistantMessageEnd(400, 50, "turn three"),
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

// Tolerance branch: in case some version really does hoist usage to the top level of
// the event, it must still be readable. This is a fallback, not the primary contract —
// the test above is the primary contract.
test("token usage is still read when it is carried at the event's top level (tolerance fallback)", () => {
  const events = [
    { type: "message_update", usage: { input: 10, output: 1 } },
    { type: "message_update", usage: { input: 100, output: 42 } },
    settled,
  ];
  const v = computeVerdict({ ...BASE, events });
  assert.deepEqual(v.tokens, { input: 100, output: 42 });
});

test("falls back to 0/0 when there is no usage anywhere", () => {
  assert.deepEqual(computeVerdict({ ...BASE, events: [ended] }).tokens, { input: 0, output: 0 });
});

test("git_diff_stat is still attached on a timeout (timed out does not mean nothing happened)", () => {
  const v = computeVerdict({ ...BASE, timedOut: true, gitDiffStat: "1 file changed, 3 insertions(+)" });
  assert.equal(v.status, "timeout");
  assert.equal(v.git_diff_stat, "1 file changed, 3 insertions(+)");
});

test("formatVerdict output is at most 20 lines and includes every field", () => {
  const v = computeVerdict({ ...BASE, events: [settled] });
  const text = formatVerdict(v);
  assert.ok(text.split("\n").length <= 20);
  for (const key of ["status", "write_count", "session_id", "last_message"]) {
    assert.ok(text.includes(key), `missing field ${key}`);
  }
});

// --- [I2] a terminal failure reported by pi ---

test("a non-empty failure is failed even with no terminal event anywhere in the stream", () => {
  const v = computeVerdict({ ...BASE, failure: "provider: connect ECONNREFUSED" });
  assert.equal(v.status, "failed");
  assert.equal(v.failure, "provider: connect ECONNREFUSED");
});

test("aborted / timedOut still outrank failure", () => {
  assert.equal(computeVerdict({ ...BASE, failure: "x", timedOut: true }).status, "timeout");
  assert.equal(computeVerdict({ ...BASE, failure: "x", aborted: true }).status, "aborted");
});

test("formatVerdict prints an extra line when there is a failure", () => {
  const text = formatVerdict(computeVerdict({ ...BASE, failure: "model not found" }));
  assert.match(text, /failure:\s+model not found/);
});

// --- [I3] spec §11: a spawn failure must "attach stderr" ---

test("stderr reaches the verdict and gets printed", () => {
  const v = computeVerdict({ ...BASE, stderr: "spawn pi ENOENT\n" });
  assert.equal(v.stderr, "spawn pi ENOENT\n");
  assert.match(formatVerdict(v), /stderr:\n {2}spawn pi ENOENT/);
});

test("formatVerdict omits the stderr section when stderr is empty", () => {
  assert.ok(!formatVerdict(computeVerdict({ ...BASE, events: [ended] })).includes("stderr:"));
});

test("formatVerdict prints only the stderr tail, so a long traceback cannot blow up the verdict", () => {
  const noisy = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const text = formatVerdict(computeVerdict({ ...BASE, stderr: noisy }));
  assert.ok(text.includes("line 39"), "must keep the last line");
  assert.ok(!text.includes("line 30"), "must not print anything before line 30");
});

// --- [I7] the verdict and the transcript share the same assistant-text parser ---

test("assistantText accepts both string-shaped and array-shaped content", () => {
  assert.equal(assistantText({ role: "assistant", content: "plain string" }), "plain string");
  assert.equal(
    assistantText({ role: "assistant", content: [{ type: "text", text: "a" }, { type: "thinking", thinking: "x" }, { type: "text", text: "b" }] }),
    "ab",
  );
  assert.equal(assistantText({ role: "user", content: "not an assistant" }), "");
  assert.equal(assistantText(undefined), "");
});

test("a message_end with string-shaped content can also become last_message", () => {
  const events = [{ type: "message_end", message: { role: "assistant", content: "a string-shaped reply" } }, ended];
  assert.equal(computeVerdict({ ...BASE, events }).last_message, "a string-shaped reply");
});

// --- [I2, corrected] real pi's API failure shape: an assistant message carrying
// stopReason:"error" ---
// Measured (pi 0.80.2 given a wrong model id): preflight returns success:true, the error
// hangs off the assistant message, and agent_end follows as usual afterward. Recognizing
// only response success:false would report completed here — a false green in 0 seconds,
// harder to notice than a timeout.

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

test("an assistant message with stopReason=error is judged failed, even with an agent_end afterward", () => {
  const v = computeVerdict({
    ...BASE,
    events: [failedAssistantMessage("404 Model 'nope' not found."), { type: "agent_end", willRetry: false }],
  });
  assert.equal(v.status, "failed");
  assert.match(v.failure, /404 Model 'nope' not found\./);
});

test("a stream that fails then succeeds (a successful retry) is still judged completed", () => {
  const v = computeVerdict({
    ...BASE,
    events: [
      failedAssistantMessage("429 rate limited"),
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done now" }], stopReason: "stop" } },
      ended,
    ],
  });
  assert.equal(v.status, "completed");
  assert.equal(v.failure, null);
});

test("an agent_end carrying willRetry:true does not count as terminal (pi will retry another pass on its own)", () => {
  const v = computeVerdict({ ...BASE, events: [{ type: "agent_end", willRetry: true }] });
  assert.notEqual(v.status, "completed");
});
