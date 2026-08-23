import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createNotifier, socketPathFor } from "../src/notifier.mjs";

// Two defects got through the whole unit suite and were caught only by running the real
// monitor process. Both were silent, and both were the very failure this rewrite exists to
// remove, so they get a test at the level that actually catches them.
//
//   1. The reconnect timer was unref'd. This process has nothing else holding the event
//      loop open, so node exited the instant the first connect failed — the monitor died
//      silently, exactly like the tail it replaced.
//   2. A failed attempt emits BOTH 'error' and 'close'. The unguarded handler scheduled two
//      reconnects, so the connection count doubled on every retry.

const WATCH = fileURLToPath(new URL("../bin/pi-watch", import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function withWatcher(run) {
  const sessionId = randomUUID();
  const socketPath = socketPathFor(sessionId, process.platform, join(tmpdir(), randomUUID().slice(0, 8)));
  mkdirSync(dirname(socketPath), { recursive: true });

  // The monitor derives its own address, so it must agree with the server's — which is why
  // both go through socketPathFor rather than being told a path.
  const child = spawn(process.execPath, [WATCH], {
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId, PI_DELEGATE_SOCKET: socketPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = [];
  child.stdout.on("data", (d) => lines.push(...String(d).split("\n").filter(Boolean)));
  try {
    return await run({ socketPath, child, lines });
  } finally {
    child.kill();
  }
}

test("the monitor survives a server that is not there yet, then attaches and delivers", async () => {
  await withWatcher(async ({ socketPath, child, lines }) => {
    // Started before any server exists: the old unref'd timer made node exit right here.
    await wait(600);
    assert.equal(child.exitCode, null, "the monitor exited while waiting for a server");

    const notifier = createNotifier({ socketPath });
    await notifier.listen();
    await wait(2600);

    assert.equal(notifier.watcherCount(), 1, "expected exactly one attached watcher");
    notifier.broadcast("pi dispatch abc1234 completed in /proj — 2 files written. Collect it with pi_result session_id=abc1234.");
    await wait(300);
    assert.ok(lines.some((l) => l.includes("abc1234")), `completion never reached the monitor: ${JSON.stringify(lines)}`);
    await notifier.close();
  });
});

test("the monitor reconnects after the server restarts, without piling up connections", async () => {
  await withWatcher(async ({ socketPath, lines }) => {
    const first = createNotifier({ socketPath });
    await first.listen();
    await wait(2600);
    assert.equal(first.watcherCount(), 1);
    await first.close();
    await wait(400);

    // What /reload-plugins does: the MCP server restarts while the monitor, whose name is
    // unchanged, keeps running and outlives it.
    const second = createNotifier({ socketPath });
    await second.listen();
    await wait(2800);

    assert.equal(second.watcherCount(), 1, "reconnect produced a duplicate connection");
    second.broadcast("pi dispatch xyz9999 completed in /proj — 1 file written. Collect it with pi_result session_id=xyz9999.");
    await wait(300);
    assert.ok(lines.some((l) => l.includes("xyz9999")), "nothing arrived after the restart");
    await second.close();
  });
});
