import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createToolHandlers } from "../src/server.mjs";

// github.com/LarryStanley/pi-delegate/issues/1
//
// Writing the completion line can fail — a bad path, a permission, a full disk. When it
// did, three things happened, in order, and each was worse than the last:
//
//   1. .then stored the REAL verdict, then appendEventsLog threw.
//   2. .catch caught that throw and overwrote the real verdict with failedVerdict(),
//      so a dispatch that had written its files correctly reported `failed` — carrying an
//      mkdir error that had nothing to do with pi.
//   3. .catch then called the SAME failing appendEventsLog again, which threw again with
//      nothing left to catch it: an unhandled rejection, and total silence.
//
// The reporter's own evidence rules this out as the cause of THEIR lost notifications
// (pi_status showed `completed`, which is only reachable when appendEventsLog did not
// throw) — but it is a real defect found on the way, and it turns a success into a
// reported failure, which is worse than the silence in the issue title.

const okVerdict = {
  status: "completed", write_count: 1, files_written: ["a.ts"], files_read_unrequested: [],
  git_diff_stat: "", duration_s: 3, tokens: { input: 1, output: 1 },
  last_message: "done", last_message_truncated: false,
};

function tmpTask() {
  const path = join(tmpdir(), `${randomUUID()}-TASK.md`);
  writeFileSync(path, "write a.ts");
  return path;
}

// A directory that cannot exist: mkdirSync throws ENOTDIR, exactly as a bad path on
// Windows would.
const IMPOSSIBLE = "/dev/null/impossible/events.log";

function setup(logPath) {
  return createToolHandlers({
    eventsLogPath: logPath,
    dispatchFn: async ({ sessionId }) => ({
      handle: { sessionId, steer() {}, async abort() {}, state: () => ({ running: false }), events: [] },
      done: Promise.resolve({ ...okVerdict, session_id: sessionId }),
    }),
    gitDiffStatFn: () => "",
    config: { model: null, provider: null, timeout_s: 60, drafter_patterns: [] },
    piDefaults: { provider: null, model: null },
  });
}

async function dispatchAndSettle(handlers) {
  const started = await handlers.pi_dispatch({ task_file: tmpTask(), cwd: tmpdir(), mode: "async" });
  const id = started.content[0].text.match(/session_id:\s*(\S+)/)[1];
  await new Promise((r) => setTimeout(r, 50));
  return id;
}

test("a dispatch that succeeded is not reported as failed because the log write broke", async () => {
  const handlers = setup(IMPOSSIBLE);
  const id = await dispatchAndSettle(handlers);

  const verdict = (await handlers.pi_result({ session_id: id })).content[0].text;
  assert.match(verdict, /status:\s+completed/, "a successful dispatch was reported as failed");
  assert.match(verdict, /a\.ts/, "the real verdict's file list was lost");
  assert.ok(!/ENOTDIR|mkdir/.test(verdict), "an fs error leaked into the verdict as pi's failure");
});

test("a broken notification never becomes an unhandled rejection", async () => {
  const seen = [];
  const onUnhandled = (e) => seen.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    await dispatchAndSettle(setup(IMPOSSIBLE));
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(seen, [], "the failed log write escaped as an unhandled rejection");
});

// The whole issue is that a lost notification is indistinguishable from "still running".
// If we know the notification could not be delivered, the caller has to be able to find
// that out from the place it already looks.
test("pi_status says so when this session's completion could not be announced", async () => {
  const handlers = setup(IMPOSSIBLE);
  const id = await dispatchAndSettle(handlers);

  const status = JSON.parse((await handlers.pi_status({ session_id: id })).content[0].text);
  assert.equal(status.status, "completed");
  assert.match(
    String(status.notify_failed ?? ""),
    /./,
    "nothing in pi_status revealed that the completion notification was never delivered",
  );
});

test("a working log path still notifies, and says nothing about failure", async () => {
  const good = join(tmpdir(), randomUUID(), "events.log");
  const handlers = setup(good);
  const id = await dispatchAndSettle(handlers);

  const status = JSON.parse((await handlers.pi_status({ session_id: id })).content[0].text);
  assert.equal(status.status, "completed");
  assert.equal(status.notify_failed, undefined);
  assert.match((await handlers.pi_result({ session_id: id })).content[0].text, /status:\s+completed/);
});
