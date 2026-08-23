import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerIsGone } from "../src/events-log.mjs";

// Monitors accumulate. Observed on the maintainer's machine: a pi-watch from a plugin
// version two releases old, started at 00:04, still running at 10:30 — for a session that
// had long since ended. It reconnects forever to a socket that will never come back.
//
// Nothing ever told it to stop, because nothing knows when a session ends. But the monitor
// is handed CLAUDE_PID, the pid of the `claude` process that owns it, and that process
// dying IS the session ending.

test("the monitor keeps running while its claude process is alive", () => {
  assert.equal(ownerIsGone({ CLAUDE_PID: String(process.pid) }, () => true), false);
});

test("the monitor learns to stop once its claude process is gone", () => {
  const dead = () => { const e = new Error("no such process"); e.code = "ESRCH"; throw e; };
  assert.equal(ownerIsGone({ CLAUDE_PID: "999999" }, dead), true);
});

// A live process owned by another user answers EPERM, not ESRCH. Treating that as death
// would make the monitor quit while its session is still open — the exact failure being
// fixed, with the sign flipped.
test("a permission error means alive, not dead", () => {
  const denied = () => { const e = new Error("operation not permitted"); e.code = "EPERM"; throw e; };
  assert.equal(ownerIsGone({ CLAUDE_PID: "1" }, denied), false);
});

// Without the variable there is nothing to check, and guessing would risk killing a live
// watcher. Staying is the safe default: an extra idle process beats a session with no
// notifications.
test("with no CLAUDE_PID it stays running rather than guessing", () => {
  assert.equal(ownerIsGone({}, () => true), false);
  assert.equal(ownerIsGone({ CLAUDE_PID: "not-a-number" }, () => true), false);
});
