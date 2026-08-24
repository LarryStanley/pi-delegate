import { test } from "node:test";
import assert from "node:assert/strict";
import { refreshInBackground } from "../src/arena-refresh.mjs";

// The one side effect in the arena path, kept in its own module with an injectable spawn so
// the mechanics are testable without a network call.
//
// It has to be a DETACHED child, not an await. This runs from a SessionStart hook that
// hooks.json registers with timeout: 10 — refreshing inline would put a network round trip
// (or the whole 8s fetch timeout) in front of every session start once a week, and the hook
// being killed at the deadline would leave nothing updated and say nothing about it.

function fakeSpawn() {
  const calls = [];
  const spawnFn = (command, args, options) => {
    const child = { unrefCalled: false, unref() { this.unrefCalled = true; } };
    calls.push({ command, args, options, child });
    return child;
  };
  return { calls, spawnFn };
}

test("refreshInBackground spawns arena-fetch detached, silent, and unreferenced", () => {
  const { calls, spawnFn } = fakeSpawn();

  const started = refreshInBackground({ spawnFn });

  assert.equal(started, true);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.command, process.execPath, "must run the same node that is running the hook");
  assert.match(call.args[0], /arena-fetch\.mjs$/);
  assert.equal(call.options.detached, true, "an attached child dies with the hook that spawned it");
  assert.equal(call.options.stdio, "ignore", "inherited stdio would corrupt the hook's JSON envelope");
  assert.equal(call.child.unrefCalled, true, "without unref the hook cannot exit until the fetch finishes");
});

// A hook that cannot refresh the snapshot must still print its report. Every other failure
// in this plugin's hooks degrades to "carry on and say so", and a spawn that throws (no
// node on PATH, a sandbox that forbids it) may not be the exception.
test("refreshInBackground reports failure instead of throwing", () => {
  const started = refreshInBackground({
    spawnFn: () => { throw new Error("EPERM"); },
  });
  assert.equal(started, false);
});

test("refreshInBackground reports failure when spawn returns nothing to unref", () => {
  assert.equal(refreshInBackground({ spawnFn: () => null }), false);
});
