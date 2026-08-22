import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createToolHandlers } from "../src/server.mjs";

// The whole premise of this plugin is that pi spends the tokens and Claude does not. A
// tool reply that carries pi's OUTPUT back into Claude's context inverts that: the caller
// pays, in its own context, for the very characters it delegated in order not to write.
//
// Every other surface here already respects that — pi_status is counts-only until you ask
// for verbose, last_message stops at LAST_MESSAGE_LIMIT, stderr is tailed. pi_transcript
// was the one with no budget of any kind, and it is the one SKILL.md tells you to reach
// for when something looks wrong.
//
// These fixtures use the REAL shape of a pi write call. Every pre-existing fixture in this
// repo used `args: { path: "a.ts" }` — a path and nothing else — which is why no test ever
// caught this. pi's actual write tool takes { path, content } (verified against the
// shipped artifact, dist/core/tools/write.js: writeSchema has exactly those two keys), so
// `args` on a tool_execution_start event carries the entire file body.

const BODY = "export function slugify(input) {\n  return String(input).toLowerCase();\n}\n".repeat(200);
const SECRET = "SENTINEL_FILE_CONTENT_THAT_MUST_NOT_REACH_THE_CALLER";

function tmpFile(name) {
  const path = join(tmpdir(), `${randomUUID()}-${name}`);
  writeFileSync(path, "Write slugify.mjs");
  return path;
}

function bigWriteEvents() {
  return [
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Starting." }] } },
    {
      type: "tool_execution_start", toolCallId: "t1", toolName: "write",
      args: { path: "slugify.mjs", content: `${SECRET}\n${BODY}` },
    },
    { type: "tool_execution_end", toolCallId: "t1", toolName: "write", result: {}, isError: false },
    {
      type: "tool_execution_start", toolCallId: "t2", toolName: "edit",
      args: { path: "slugify.test.mjs", old_string: BODY, new_string: `${SECRET}\n${BODY}` },
    },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(50_000) }] } },
  ];
}

function setup(events) {
  const dispatchFn = async ({ sessionId }) => ({
    handle: {
      sessionId, steer() {}, async abort() {},
      state: () => ({ running: false }), events,
    },
    done: Promise.resolve({
      status: "completed", write_count: 2, files_written: [], files_read_unrequested: [],
      git_diff_stat: "", duration_s: 1, tokens: { input: 0, output: 0 },
      session_id: sessionId, last_message: "", last_message_truncated: false,
    }),
  });
  return createToolHandlers({
    dispatchFn,
    eventsLogPath: join(tmpdir(), `${randomUUID()}.log`),
    gitDiffStatFn: () => "",
    config: { model: null, provider: null, timeout_s: 60, drafter_patterns: [] },
    piDefaults: { provider: null, model: null },
  });
}

async function transcript(handlers, filter, n) {
  const task = tmpFile("TASK.md");
  const started = await handlers.pi_dispatch({ task_file: task, cwd: tmpdir(), mode: "async" });
  const sessionId = started.content[0].text.match(/session_id:\s*(\S+)/)[1];
  const result = await handlers.pi_transcript({ session_id: sessionId, filter, n });
  return result.content[0].text;
}

// The headline defect. filter=tools is the diagnostic SKILL.md recommends ("see what it's
// actually reading — a file that was never named is roaming"), and that diagnosis needs
// the tool name and the path. It has never needed the content, but it printed the content.
test("filter=tools never echoes the file content pi wrote", async () => {
  const body = await transcript(setup(bigWriteEvents()), "tools");
  assert.ok(!body.includes(SECRET), "the written file's content came back in the tool reply");
  assert.ok(body.length < 4_000, `filter=tools returned ${body.length} chars`);
});

// ...while keeping every bit of the diagnostic value it exists for.
test("filter=tools still names each tool and the path it touched", async () => {
  const body = await transcript(setup(bigWriteEvents()), "tools");
  assert.match(body, /write/);
  assert.match(body, /slugify\.mjs/);
  assert.match(body, /edit/);
  assert.match(body, /slugify\.test\.mjs/);
});

// "It wrote the file" and "it wrote 15KB into the file" are different diagnoses, and the
// second one is how you spot a runaway. Keep the magnitude, drop the payload.
test("filter=tools reports how big the elided argument was", async () => {
  const body = await transcript(setup(bigWriteEvents()), "tools");
  assert.match(body, /\d/, "no size indicator survived the elision");
});

test("filter=text is capped, and says so", async () => {
  const body = await transcript(setup(bigWriteEvents()), "text");
  assert.ok(body.length < 4_000, `filter=text returned ${body.length} chars`);
  assert.match(body, /truncat/i);
});

test("filter=last_n is capped and elides content too", async () => {
  const body = await transcript(setup(bigWriteEvents()), "last_n", 20);
  assert.ok(!body.includes(SECRET), "raw events leaked the file content");
  assert.ok(body.length < 4_000, `filter=last_n returned ${body.length} chars`);
});

// A cap that silently swallows the rest is the failure mode this repo keeps hitting:
// something stops working and says nothing. Truncation has to name the way forward.
test("a truncated transcript tells the caller where the full text actually is", async () => {
  const body = await transcript(setup(bigWriteEvents()), "text");
  assert.match(body, /pi_transcript|Read|file/i);
});
