import { test } from "node:test";
import assert from "node:assert/strict";
import { computeVerdict, writtenPaths, progressSummary } from "../src/verdict.mjs";

// Seen in a live dispatch: write_count 2 on a task that created exactly one file. pi's own
// closing message explained it — "the empty edit call was rejected before applying" — and
// TASK.md, which was never modified, was listed under files_written.
//
// verdict.mjs counted every tool_execution_start and never looked at how the call ENDED, so
// a rejected call was indistinguishable from a successful one. That overstates the verdict
// in the direction that matters: it claims a file was touched when it was not, and
// files_written is what a reviewer trusts to know where to look.

const start = (id, tool, path) => ({ type: "tool_execution_start", toolCallId: id, toolName: tool, args: { path } });
const end = (id, tool, isError) => ({ type: "tool_execution_end", toolCallId: id, toolName: tool, result: {}, isError });

const EVENTS = [
  start("c1", "write", "clamp.mjs"),
  end("c1", "write", false),
  start("c2", "edit", "TASK.md"),
  end("c2", "edit", true), // rejected before applying — nothing changed on disk
];

test("a rejected write is not counted and not listed", () => {
  assert.deepEqual(writtenPaths(EVENTS), ["clamp.mjs"]);
});

test("the verdict's write_count matches what actually landed", () => {
  const v = computeVerdict({ events: EVENTS, cwd: "/proj", gitDiffStat: "" });
  assert.equal(v.write_count, 1);
  assert.deepEqual(v.files_written, ["clamp.mjs"]);
});

test("pi_status agrees, so a poll does not report progress that did not happen", () => {
  assert.equal(progressSummary(EVENTS).writes, 1);
});

// A call still in flight has a start and no end yet. It has not failed, and a poll saying
// "0 writes" while pi is midway through one would be its own kind of wrong.
test("a write still in progress still counts", () => {
  const inFlight = [start("c1", "write", "a.ts")];
  assert.equal(progressSummary(inFlight).writes, 1);
  assert.deepEqual(writtenPaths(inFlight), ["a.ts"]);
});

test("reads are judged the same way", () => {
  const events = [
    start("r1", "read", "good.ts"), end("r1", "read", false),
    start("r2", "read", "missing.ts"), end("r2", "read", true),
  ];
  const v = computeVerdict({ events, cwd: "/proj", gitDiffStat: "" });
  assert.deepEqual(v.files_read_unrequested, ["good.ts"]);
});
