import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderStatus, writeStatus, clearStatus, statusFilePath } from "../src/status.mjs";
import { createRegistry } from "../src/registry.mjs";

const dir = () => mkdtempSync(join(tmpdir(), "pi-status-"));

test("running means enrolled and not yet settled", () => {
  const line = renderStatus([
    { verdict: null, startedAt: 1_000_000 },
    { verdict: null, startedAt: 2_000_000 },
    { verdict: { status: "completed" }, startedAt: 500 },
  ], { pid: 42, now: 3_000_000 });
  assert.match(line, /\brunning=2\b/);
});

// The reservation window is real: pi_dispatch enrolls the session before the child spawns,
// and other tool calls get in during it. A status line that only counted spawned children
// would blink 0 at exactly the moment a dispatch is starting.
test("a reserved-but-unspawned dispatch counts as running", () => {
  const line = renderStatus([{ handle: null, done: null, verdict: null, startedAt: 10_000 }], { now: 20_000 });
  assert.match(line, /\brunning=1\b/);
});

test("oldest is the earliest running start, in seconds, ignoring settled ones", () => {
  const line = renderStatus([
    { verdict: null, startedAt: 5_000_000 },
    { verdict: null, startedAt: 3_000_000 },
    { verdict: { status: "completed" }, startedAt: 1_000 },
  ], { now: 9_000_000 });
  assert.match(line, /\boldest=3000\b/);
});

test("models are deduplicated and lose their provider prefix", () => {
  const line = renderStatus([
    { verdict: null, model: "omlx/Qwen3.8-27B", startedAt: 1 },
    { verdict: null, model: "omlx/Qwen3.8-27B", startedAt: 2 },
    { verdict: null, model: "anthropic/claude-sonnet-5", startedAt: 3 },
  ], { now: 10 });
  assert.match(line, /\bmodels=Qwen3\.8-27B,claude-sonnet-5\b/);
});

// The reader splits this line on whitespace in bash. A space inside any value would
// silently become an extra field and shift every key after it.
test("a value containing spaces cannot break the reader's word splitting", () => {
  const line = renderStatus([{ verdict: null, model: "local/my model v2", startedAt: 1 }], { now: 10 });
  const fields = line.split(" ");
  assert.equal(fields.length, 5, `expected 5 fields, got: ${line}`);
  for (const field of fields) assert.match(field, /^[a-z]+=/);
});

test("no models still produces a placeholder field, not an empty one", () => {
  const line = renderStatus([{ verdict: null, startedAt: 1 }], { now: 10 });
  assert.match(line, /\bmodels=-$/);
});

test("nothing running renders running=0 and oldest=0", () => {
  const line = renderStatus([], { now: 10 });
  assert.match(line, /\brunning=0\b/);
  assert.match(line, /\boldest=0\b/);
});

test("writeStatus writes one line and clearStatus removes it", () => {
  const path = join(dir(), "s.status");
  assert.equal(writeStatus([{ verdict: null, startedAt: 1000 }], { path, pid: 7, now: 2000 }), true);
  assert.equal(readFileSync(path, "utf8"), "pid=7 running=1 oldest=1 updated=2 models=-\n");
  assert.equal(clearStatus({ path }), true);
  assert.equal(existsSync(path), false);
});

test("clearStatus on a file that is not there is not an error", () => {
  assert.equal(clearStatus({ path: join(dir(), "never-existed.status") }), false);
});

// Same standing as appendEventsLog after issues/1: this is decoration, and decoration may
// never be allowed to take down the thing it decorates. An unwritable path returns false.
test("writeStatus never throws on an unwritable path", () => {
  const base = dir();
  const locked = join(base, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o500);
  assert.equal(writeStatus([], { path: join(locked, "s.status") }), false);
  chmodSync(locked, 0o700);
});

test("statusFilePath is keyed per session, so two sessions never share a file", () => {
  const a = statusFilePath({ CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/one.sock" });
  const b = statusFilePath({ CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/two.sock" });
  assert.notEqual(a, b);
  assert.match(a, /\.status$/);
});

// The secret that sits beside the messaging socket in the environment. Pinned here as well
// as in session-key.test.mjs because this is a second module deriving a path from that
// environment, and the rule has to hold in both.
test("the messaging token never reaches the status path", () => {
  const path = statusFilePath({
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/one.sock",
    CLAUDE_CODE_MESSAGING_TOKEN: "super-secret-value",
  });
  assert.ok(!path.includes("super-secret-value"));
});

test("the registry calls onChange after add and after update", () => {
  const seen = [];
  const registry = createRegistry({ onChange: (entries) => seen.push(entries.length) });
  registry.add("a", { verdict: null });
  registry.update("a", { verdict: { status: "completed" } });
  assert.deepEqual(seen, [1, 1]);
});

// The registry mutation is the mechanism; onChange is downstream of it. issues/1 is the
// precedent: a failure to announce a result was allowed to destroy the result.
test("an onChange that throws does not fail the registry mutation", () => {
  const registry = createRegistry({ onChange: () => { throw new Error("status disk is full"); } });
  registry.add("a", { verdict: null });
  assert.equal(registry.has("a"), true);
  registry.update("a", { verdict: { status: "completed" } });
  assert.deepEqual(registry.get("a").verdict, { status: "completed" });
});
