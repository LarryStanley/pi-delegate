import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createToolHandlers } from "../src/server.mjs";

// github.com/LarryStanley/pi-delegate/issues/1, Cause A.
//
// The registry is a Map inside the MCP server process, so /reload-plugins empties it. pi
// itself survives — the reporter's file landed correctly — but the dispatch becomes
// unobservable: no notification, and
//
//     pi_status -> Unknown session_id "4b1e5d13". Currently valid: (none)
//
// which, as the issue puts it, "reads like a bug in the caller". The work was finished and
// there was no way to learn that from the plugin.
//
// The recovery data was on disk the whole time: appendEventsLog writes a completion line
// per async dispatch. A restarted server cannot steer or abort an orphaned child — that
// handle died with the old process — but it can absolutely still answer "did it finish?".

function logWith(lines) {
  const path = join(tmpdir(), randomUUID(), "events.log");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join("\n") + (lines.length ? "\n" : ""));
  return path;
}

function setup(logPath) {
  return createToolHandlers({
    eventsLogPath: logPath,
    dispatchFn: async ({ sessionId }) => ({
      handle: { sessionId, steer() {}, async abort() {}, state: () => ({ running: false }), events: [] },
      done: Promise.resolve({
        status: "completed", write_count: 1, files_written: ["a.ts"], files_read_unrequested: [],
        git_diff_stat: "", duration_s: 1, tokens: { input: 0, output: 0 },
        session_id: sessionId, last_message: "", last_message_truncated: false,
      }),
    }),
    gitDiffStatFn: () => "",
    config: { model: null, provider: null, timeout_s: 60, drafter_patterns: [] },
    piDefaults: { provider: null, model: null },
  });
}

const RECORDED = "pi dispatch 4b1e5d13 completed in /Users/x/proj — 1 file written. " +
  "Collect it with pi_result session_id=4b1e5d13.";

test("pi_result recovers a dispatch this server never knew about, from the log on disk", async () => {
  const handlers = setup(logWith([RECORDED]));
  const reply = await handlers.pi_result({ session_id: "4b1e5d13" });

  assert.ok(!reply.isError, "a recoverable dispatch was reported as an error");
  assert.match(reply.content[0].text, /completed/);
  assert.match(reply.content[0].text, /1 file written/);
});

test("pi_status recovers it too, since that is what a caller polls", async () => {
  const handlers = setup(logWith([RECORDED]));
  const reply = await handlers.pi_status({ session_id: "4b1e5d13" });

  assert.ok(!reply.isError);
  assert.match(reply.content[0].text, /completed/);
});

// The distinction the issue asks for as a floor: "never existed" and "this server was
// restarted" are different situations and used to produce identical text.
test("a genuinely unknown id explains the restart case instead of blaming the caller", async () => {
  const handlers = setup(logWith([]));
  const reply = await handlers.pi_result({ session_id: "deadbeef" });

  assert.ok(reply.isError);
  const body = reply.content[0].text;
  assert.match(body, /deadbeef/);
  assert.match(body, /restart|reload/i, "nothing mentioned that a restart loses the registry");
  assert.match(body, /events\.log/, "the log path the caller could check was not named");
});

// Recovery must not shadow a live dispatch: the in-memory entry is richer (it has the
// handle, so steer and abort still work) and always wins.
test("a session this server actually owns is answered from memory, not the log", async () => {
  const handlers = setup(logWith([RECORDED]));
  const task = join(tmpdir(), `${randomUUID()}-TASK.md`);
  writeFileSync(task, "write a.ts");
  const started = await handlers.pi_dispatch({ task_file: task, cwd: tmpdir(), mode: "sync" });
  const id = started.content[0].text.match(/session_id:\s*(\S+)/)[1];

  const reply = await handlers.pi_result({ session_id: id });
  assert.match(reply.content[0].text, /files_written:\s+a\.ts/);
});
