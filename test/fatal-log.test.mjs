import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatFatal, recordFatal, installFatalLog } from "../src/fatal-log.mjs";
import { unwritablePath } from "../fixtures/unwritable-path.mjs";

// The second half of the peer report: when the server went, the ONLY signal was that the
// tools disappeared from the tool list. No exit code, no stderr, nothing in events.log.
// Twenty minutes of guessing that one `tail` would have answered.
//
// events.log is the right place precisely because bin/pi-watch prints every line of it,
// so a crash line does not just sit on disk — it reaches the monitor live, which is the
// one surface still working when the MCP transport is gone.
//
// Which is also why only ABNORMAL exits are written here. A clean shutdown happens on
// every /reload-plugins; logging those would turn a routine reload into a notification
// and train the user to ignore the channel.

const dir = () => mkdtempSync(join(tmpdir(), "pi-fatal-"));

test("the line names the kind, the message and the pid", () => {
  const line = formatFatal("uncaughtException", new Error("ENOSPC: no space left on device"), { pid: 4242 });
  assert.match(line, /uncaughtException/);
  assert.match(line, /ENOSPC/);
  assert.match(line, /4242/);
  assert.equal(line.includes("\n"), false, "events.log is line-oriented; a multi-line entry would split into two records");
});

test("the line says what the reader has to do about it", () => {
  // A crash message that does not name the remedy leaves the user watching a monitor that
  // says something broke and nothing they can act on.
  assert.match(formatFatal("unhandledRejection", new Error("x"), { pid: 1 }), /reload-plugins/);
});

test("a non-Error reason still produces a usable line", () => {
  // `throw "string"` and `Promise.reject(undefined)` both reach these handlers.
  assert.match(formatFatal("unhandledRejection", "just a string", { pid: 1 }), /just a string/);
  assert.doesNotThrow(() => formatFatal("uncaughtException", undefined, { pid: 1 }));
});

test("recordFatal appends one line to the events log", () => {
  const path = join(dir(), "events.log");
  assert.equal(recordFatal("uncaughtException", new Error("boom"), { path, pid: 7 }), true);
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /boom/);
});

test("recordFatal appends rather than truncating an existing log", () => {
  const path = join(dir(), "events.log");
  recordFatal("uncaughtException", new Error("first"), { path, pid: 7 });
  recordFatal("unhandledRejection", new Error("second"), { path, pid: 7 });
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /first/);
  assert.match(lines[1], /second/);
});

// The whole point of this module is to run while something is already going wrong. If it
// can throw, it converts a logged crash into an unlogged one — and on a full volume, the
// write it is trying to make is exactly the write that fails.
test("recordFatal never throws, whatever the path is", () => {
  const { path, dir: blocked } = unwritablePath("events.log");
  assert.equal(recordFatal("uncaughtException", new Error("x"), { path, pid: 1 }), false);
  rmSync(blocked, { recursive: true, force: true });
  assert.equal(recordFatal("uncaughtException", new Error("x"), { path: "", pid: 1 }), false);
});

// These two run in a real child process rather than emitting the events here. Emitting
// them in-process fights node:test, which installs its own handlers to attribute a crash
// to the test that caused it — and more to the point, a handler that only works when the
// event is synthesised is not evidence that a genuine crash gets recorded. This kills a
// real process the real way.
function crashChild(body) {
  const d = dir();
  const path = join(d, "events.log");
  const script =
    `import { installFatalLog } from ${JSON.stringify(new URL("../src/fatal-log.mjs", import.meta.url).href)};\n` +
    `installFatalLog({ path: ${JSON.stringify(path)}, pid: 4242 });\n${body}\n`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  return { path, code: res.status, log: existsSync(path) ? readFileSync(path, "utf8") : "" };
}

test("a real unhandled rejection is recorded, and the process still dies", () => {
  const { code, log } = crashChild(`Promise.reject(new Error("queue died"));`);
  assert.match(log, /queue died/);
  assert.match(log, /unhandledRejection/);
  // The process must still die: this records the reason, it does not paper over it. A
  // server that survives an unknown fault goes on answering out of an unknown state.
  assert.notEqual(code, 0);
});

test("a real uncaught exception is recorded too", () => {
  const { code, log } = crashChild(`setTimeout(() => { throw new Error("socket blew up"); }, 0);`);
  assert.match(log, /socket blew up/);
  assert.match(log, /uncaughtException/);
  assert.notEqual(code, 0);
});

// Installing handlers is a global mutation of the process. A test suite — or a second
// server in the same process — must be able to put it back.
test("uninstall removes both handlers and leaves no others behind", () => {
  const path = join(dir(), "events.log");
  const before = {
    rej: process.listenerCount("unhandledRejection"),
    exc: process.listenerCount("uncaughtException"),
  };
  const uninstall = installFatalLog({ path, pid: 1, onExit: () => {} });
  assert.equal(process.listenerCount("unhandledRejection"), before.rej + 1);
  assert.equal(process.listenerCount("uncaughtException"), before.exc + 1);
  uninstall();
  assert.equal(process.listenerCount("unhandledRejection"), before.rej);
  assert.equal(process.listenerCount("uncaughtException"), before.exc);
});

test("a clean shutdown writes nothing — a reload must not look like a crash", () => {
  const path = join(dir(), "events.log");
  const uninstall = installFatalLog({ path, pid: 1, onExit: () => {} });
  uninstall();
  assert.equal(existsSync(path), false);
});
