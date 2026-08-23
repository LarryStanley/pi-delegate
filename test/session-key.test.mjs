import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionKeyFrom, eventsLogPath, eventsSocketPath, sharedEventsLogPath } from "../src/events-log.mjs";

// The real root cause of issues/1 Cause B, caught live on the maintainer's own machine:
//
//   MCP server  CLAUDE_CODE_SESSION_ID=a62909da-08d1-4b9f-b487-3c503bed29f0
//   monitor     CLAUDE_CODE_SESSION_ID=c299557e-53d1-42ab-b837-22c529e27922
//
// One Claude Code session, two processes, two DIFFERENT session ids. The monitor keeps the
// id from when the session started; the MCP server is handed a fresh one when
// /reload-plugins restarts it. Both then derive an address from "the session id" and never
// speak to each other again. It matched the reporter's Windows evidence exactly, where the
// newest monitor watched ec8f1e23 while the server wrote to 733159be.
//
// Keying by project directory was the obvious alternative and is wrong here: two sessions
// in one project is a normal working pattern, and they would cross.
//
// CLAUDE_CODE_MESSAGING_SOCKET is what actually works. It is Claude Code's own messaging
// socket, named for the `claude` process itself — present in both processes, IDENTICAL in
// both, unique per session, and unchanged by /reload-plugins, because the claude process is
// not what restarts. It is hashed rather than used raw so nothing depends on the path
// format (a named pipe on Windows) and no part of it is echoed anywhere.
//
// CLAUDE_CODE_MESSAGING_TOKEN sits right beside it and is a SECRET. It is never read here.

const SOCKET = "/tmp/cc-socks/34699.sock";
const SERVER_ENV = { CLAUDE_CODE_MESSAGING_SOCKET: SOCKET, CLAUDE_CODE_SESSION_ID: "a62909da-08d1-4b9f-b487-3c503bed29f0" };
const MONITOR_ENV = { CLAUDE_CODE_MESSAGING_SOCKET: SOCKET, CLAUDE_CODE_SESSION_ID: "c299557e-53d1-42ab-b837-22c529e27922" };

test("the two processes of one session agree, even with different session ids", () => {
  assert.equal(sessionKeyFrom(SERVER_ENV), sessionKeyFrom(MONITOR_ENV));
});

test("the socket and the log both follow that agreement", () => {
  assert.equal(eventsSocketPath(SERVER_ENV, "darwin"), eventsSocketPath(MONITOR_ENV, "darwin"));
  // The log matters for the same reason: after a reload the server must still find the
  // completion line an earlier server wrote, or the Cause A recovery cannot work either.
  assert.equal(eventsLogPath(SERVER_ENV), eventsLogPath(MONITOR_ENV));
});

test("two different Claude Code sessions never collide, same project or not", () => {
  const other = { CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/99999.sock" };
  assert.notEqual(sessionKeyFrom(SERVER_ENV), sessionKeyFrom(other));
  assert.notEqual(eventsSocketPath(SERVER_ENV, "darwin"), eventsSocketPath(other, "darwin"));
});

test("the messaging token is never part of the key", () => {
  const withToken = { ...SERVER_ENV, CLAUDE_CODE_MESSAGING_TOKEN: "0a8909fa4f8ab2b50c5da63aeba4c6d5" };
  assert.equal(sessionKeyFrom(withToken), sessionKeyFrom(SERVER_ENV));
  assert.ok(!sessionKeyFrom(withToken).includes("0a8909"));
});

test("without the messaging socket it falls back to the session id, not to nothing", () => {
  const key = sessionKeyFrom({ CLAUDE_CODE_SESSION_ID: "c299557e-53d1-42ab-b837-22c529e27922" });
  assert.ok(key);
  assert.match(key, /c299557e/);
});

test("with neither, it degrades to the shared log rather than to silence", () => {
  assert.equal(sessionKeyFrom({}), null);
  assert.equal(eventsLogPath({}), sharedEventsLogPath());
});

test("a hostile messaging socket value cannot climb out of the directory", () => {
  const key = sessionKeyFrom({ CLAUDE_CODE_MESSAGING_SOCKET: "../../../etc/passwd" });
  assert.match(key, /^[A-Za-z0-9]+$/, `key was not filename-safe: ${key}`);
});
