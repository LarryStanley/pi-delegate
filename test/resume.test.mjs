import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createToolHandlers } from "../src/server.mjs";

// Continuing a dispatch instead of starting a fresh one.
//
// This is what makes a back-and-forth with pi possible at all: /pi-delegate:discuss is a
// conversation, and a conversation that forgets everything between turns is just a
// question box you have to re-paste the premise into every time.
//
// pi already owns the hard half — `--session-id <id>` is documented as "use exact project
// session ID, creating it if missing", so handing it an id it has seen before resumes that
// session off disk. buildPiArgs has always passed --session-id. The only thing missing was
// on this side: pi_dispatch minted a fresh randomUUID every call and registry.add throws
// outright on a duplicate.

const okVerdict = {
  status: "completed", write_count: 0, files_written: [], files_read_unrequested: [],
  git_diff_stat: "", duration_s: 1, tokens: { input: 0, output: 0 },
  last_message: "sure", last_message_truncated: false,
};

function tmpTask() {
  const path = join(tmpdir(), `${randomUUID()}-TASK.md`);
  writeFileSync(path, "Talk to me about a.ts");
  return path;
}

// Captures what sessionId each dispatch was handed, which is the only way to prove the
// second turn actually continued the first rather than quietly starting over.
function setup({ running = false } = {}) {
  const seen = [];
  const dispatchFn = async ({ sessionId }) => {
    seen.push(sessionId);
    return {
      handle: {
        sessionId, steer() {}, async abort() {},
        state: () => ({ running, elapsed_s: 1 }), events: [],
      },
      done: running ? new Promise(() => {}) : Promise.resolve({ ...okVerdict, session_id: sessionId }),
    };
  };
  const handlers = createToolHandlers({
    dispatchFn,
    eventsLogPath: join(tmpdir(), `${randomUUID()}.log`),
    gitDiffStatFn: () => "",
    config: { model: null, provider: null, timeout_s: 60, drafter_patterns: [] },
    piDefaults: { provider: null, model: null },
  });
  return { handlers, seen };
}

const idOf = (reply) => reply.content[0].text.match(/session_id:\s*(\S+)/)[1];

test("resuming reuses the session id, so pi continues the same conversation", async () => {
  const { handlers, seen } = setup();
  const first = idOf(await handlers.pi_dispatch({ task_file: tmpTask(), cwd: tmpdir(), mode: "sync" }));

  const second = await handlers.pi_dispatch({
    task_file: tmpTask(), cwd: tmpdir(), mode: "sync", resume_session_id: first,
  });

  assert.equal(idOf(second), first, "the follow-up turn was given a different session_id");
  assert.deepEqual(seen, [first, first], "pi was not handed the same session id twice");
});

test("resuming a session id nobody dispatched fails loudly, naming what is valid", async () => {
  const { handlers, seen } = setup();
  await handlers.pi_dispatch({ task_file: tmpTask(), cwd: tmpdir(), mode: "sync" });

  const reply = await handlers.pi_dispatch({
    task_file: tmpTask(), cwd: tmpdir(), mode: "sync", resume_session_id: "typo1234",
  });

  // Silently starting a brand-new session on a typo'd id is the failure shape this repo
  // keeps getting bitten by: it does not break, it just quietly does something else.
  assert.ok(reply.isError, "a bad resume id was accepted");
  assert.match(reply.content[0].text, /typo1234/);
  assert.equal(seen.length, 1, "a fresh pi session was spawned despite the bad id");
});

test("resuming a dispatch that is still running is refused", async () => {
  const { handlers } = setup({ running: true });
  const first = idOf(await handlers.pi_dispatch({ task_file: tmpTask(), cwd: tmpdir(), mode: "async" }));

  const reply = await handlers.pi_dispatch({
    task_file: tmpTask(), cwd: tmpdir(), mode: "async", resume_session_id: first,
  });

  // Two pi processes on one session file is corruption, not concurrency.
  assert.ok(reply.isError, "resumed a session that had not finished");
  assert.match(reply.content[0].text, /still running|pi_status|pi_abort/i);
});

test("a resumed session stays collectable afterwards, like any other", async () => {
  const { handlers } = setup();
  const first = idOf(await handlers.pi_dispatch({ task_file: tmpTask(), cwd: tmpdir(), mode: "sync" }));
  await handlers.pi_dispatch({ task_file: tmpTask(), cwd: tmpdir(), mode: "sync", resume_session_id: first });

  const result = await handlers.pi_result({ session_id: first });
  assert.ok(!result.isError);
  assert.match(result.content[0].text, /status:\s+completed/);
});
