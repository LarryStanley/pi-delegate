import { test } from "node:test";
import assert from "node:assert/strict";
import { progressSummary } from "../src/verdict.mjs";

// Seen in a live dispatch (deepseek-v4-pro, thinking=medium): pi_status returned the exact
// same JSON at 40s and at 137s — writes 0, reads 1, tokens in 1564 / out 118, current_tool
// null. Nothing in the reply had moved, which reads as a wedged dispatch. It was not: the
// model was mid-reasoning the whole time and went on to finish correctly at 290s.
//
// Every number pi_status reports comes from an event that a long reasoning turn does not
// produce. totalUsage() sums message_end only (deliberately — message_update carries a
// usage snapshot per streaming chunk and adding those double-counts), the write and read
// counts come from tool events, and current_tool is null precisely because no tool is
// running. So "thinking hard" and "hung" are byte-identical in the reply.
//
// The signal was never missing. The stream carries message_update events whose
// assistantMessageEvent.type is thinking_delta, and they were sitting in handle.events the
// whole time — the server knew, and had no way to say so. Confirming it cost a
// pi_transcript call, which is the one thing pi_status exists to avoid.

const thinking = () => ({
  type: "message_update",
  message: { role: "assistant", content: [] },
  assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "ms" },
});

const messageEnd = () => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "done" }] },
});

test("a dispatch mid-reasoning reports that it is thinking", () => {
  assert.equal(progressSummary([thinking(), thinking()]).phase, "thinking");
});

// Scanning back for the newest thinking_delta and stopping there would report "thinking"
// for the rest of the run, long after the turn that did the thinking had ended — a status
// that is wrong in the same direction as the bug it replaces, and harder to doubt because
// it looks like a positive signal rather than an absent one.
test("the turn ending clears the phase rather than latching it", () => {
  assert.equal(progressSummary([thinking(), messageEnd()]).phase, undefined);
});

// current_tool already answers "what is running right now", and it is derived from these
// same events. A reply carrying both current_tool: "read" and phase: "thinking" contradicts
// itself, and the caller has no way to tell which half to believe.
test("a tool call in flight clears the phase, leaving current_tool to speak", () => {
  const events = [thinking(), { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "a.ts" } }];
  assert.equal(progressSummary(events).phase, undefined);
});

// Absent rather than "idle": pi_status is polled, so every key is paid for on every poll
// for the rest of the session. A field that says nothing should not be there at all.
test("a dispatch with no streaming events carries no phase key", () => {
  const events = [{ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "a.ts" } }];
  assert.ok(!("phase" in progressSummary(events)));
});

// `phase` names what is happening; this proves that anything is. Every other counter can
// legitimately sit still for minutes — a model reasoning writes nothing and reads nothing —
// so none of them separates slow from stopped. This one moves whenever the stream does,
// which makes two polls a liveness test rather than a guess, and it costs one integer.
test("a poll carries an event count, so two polls can prove the stream is moving", () => {
  assert.equal(progressSummary([thinking()]).stream_events, 1);
  assert.equal(progressSummary([thinking(), thinking(), messageEnd()]).stream_events, 3);
});
