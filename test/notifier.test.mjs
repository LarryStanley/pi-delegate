import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { socketPathFor, createNotifier } from "../src/notifier.mjs";

// github.com/LarryStanley/pi-delegate/issues/1, Cause B.
//
// Notifications used to travel by file: the server appended a line to events/<id>.log and
// a separate `tail -F` printed it. The reporter's evidence showed the write side working
// perfectly and the read side simply gone — 12 monitors alive on the machine, not one of
// them watching that session's file — with nothing anywhere announcing the death.
//
// That is the defect class, not the incident: the announcer could not observe whether the
// announcement landed. A file has no feedback at all. A socket's connection state IS the
// feedback, on both ends, for free.
//
// It buys two more things the file could not:
//   - the monitor RECONNECTS after /reload-plugins restarts the MCP server, instead of
//     being orphaned against a server that no longer exists;
//   - "is anyone listening?" becomes answerable, so pi_status can say the notification is
//     not coming rather than leaving it indistinguishable from "still running".

test("the socket path is per-session, so two sessions never share a notifier", () => {
  const a = socketPathFor("c299557e-53d1-42ab-b837-22c529e27922", "darwin", tmpdir());
  const b = socketPathFor("11111111-2222-3333-4444-555555555555", "darwin", tmpdir());
  assert.notEqual(a, b);
});

// A unix domain socket path is capped near 104 bytes by the OS — a long username plus a
// full UUID gets close enough to matter, and the failure is a bind error at startup, i.e.
// no notifications at all. Truncating the id keeps it well clear.
test("a unix socket path stays inside the OS length limit", () => {
  const path = socketPathFor("c299557e-53d1-42ab-b837-22c529e27922", "darwin", "/Users/a-rather-long-username/.claude/pi-delegate/events");
  assert.ok(path.length < 100, `socket path was ${path.length} bytes: ${path}`);
});

// Windows has no socket files; named pipes live in their own namespace and vanish with the
// process, so nothing on disk needs creating or cleaning up.
test("Windows gets a named pipe, not a filesystem path", () => {
  const path = socketPathFor("c299557e-53d1-42ab-b837-22c529e27922", "win32", "C:\\Users\\x");
  assert.match(path, /^\\\\[.]\\pipe\\/);
});

// The live tests below bind a real server, so the address has to be one the platform can
// actually bind. A ".sock" file path is not that on Windows — there are no socket files
// there and listen() fails EACCES — which is exactly why socketPathFor exists and returns a
// named pipe for win32. Asking it for the address instead of hand-rolling one keeps these
// tests on the same address the product would use.
function tmpSock() {
  const dir = join(tmpdir(), randomUUID().slice(0, 8));
  mkdirSync(dir, { recursive: true });
  return socketPathFor(randomUUID().replace(/-/g, ""), process.platform, dir);
}

// A leftover socket FILE is a POSIX-only failure mode: a named pipe lives in its own
// namespace and goes with the process that created it, so there is nothing to leave behind
// and reclaimIfStale returns early for a pipe address. Skipped rather than adapted — the
// behaviour under test does not exist on Windows.
const posixOnly = process.platform === "win32"
  ? { skip: "socket files (and therefore stale ones) do not exist on Windows" }
  : {};

const once = (emitter, event) => new Promise((r) => emitter.once(event, r));

test("a line broadcast to a connected watcher arrives", async () => {
  const notifier = createNotifier({ socketPath: tmpSock() });
  await notifier.listen();
  const client = connect(notifier.socketPath);
  await once(client, "connect");
  await new Promise((r) => setTimeout(r, 20));

  const received = once(client, "data");
  notifier.broadcast("pi dispatch abc completed");
  assert.match(String(await received), /pi dispatch abc completed/);

  client.destroy();
  await notifier.close();
});

test("the server can tell whether anyone is listening", async () => {
  const notifier = createNotifier({ socketPath: tmpSock() });
  await notifier.listen();
  assert.equal(notifier.watcherCount(), 0, "claimed a watcher before any connected");

  const client = connect(notifier.socketPath);
  await once(client, "connect");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(notifier.watcherCount(), 1);

  client.destroy();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(notifier.watcherCount(), 0, "a disconnected watcher was still counted");

  await notifier.close();
});

// Broadcasting into the void is the normal headless case, not an error.
test("broadcasting with nobody connected does not throw", async () => {
  const notifier = createNotifier({ socketPath: tmpSock() });
  await notifier.listen();
  assert.doesNotThrow(() => notifier.broadcast("nobody is listening"));
  await notifier.close();
});

// A crashed server leaves its socket file behind and the next listen() fails EADDRINUSE —
// which would mean no notifications for the whole session, silently. The only safe way to
// tell a stale socket from a live one is to try connecting to it.
test("a stale socket file left by a dead server is reclaimed", posixOnly, async () => {
  const path = tmpSock();
  writeFileSync(path, "");
  assert.ok(existsSync(path));

  const notifier = createNotifier({ socketPath: path });
  await notifier.listen();
  assert.equal(notifier.listening(), true, "a leftover socket file blocked startup");
  await notifier.close();
});

test("a socket a LIVE server holds is never stolen", async () => {
  const path = tmpSock();
  const first = createNotifier({ socketPath: path });
  await first.listen();

  const second = createNotifier({ socketPath: path });
  await assert.rejects(() => second.listen(), /in use|EADDRINUSE/i,
    "a second server took over a socket the first was still serving");

  await first.close();
});
