import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderStatus, writeStatus, clearStatus, statusFilePath, ownerToken } from "../src/status.mjs";

// Line 1 is the facts the reader parses; line 2 is the owner, alone, so a socket path
// containing a space cannot be mistaken for a field.
const facts = (line) => line.split("\n")[0];
const owner = (line) => line.split("\n")[1];
import { createRegistry } from "../src/registry.mjs";

const dir = () => mkdtempSync(join(tmpdir(), "pi-status-"));

test("running means enrolled and not yet settled", () => {
  const line = renderStatus([
    { verdict: null, startedAt: 1_000_000 },
    { verdict: null, startedAt: 2_000_000 },
    { verdict: { status: "completed" }, startedAt: 500 },
  ], { pid: 42, now: 3_000_000 });
  assert.match(facts(line), /\brunning=2\b/);
});

// The reservation window is real: pi_dispatch enrolls the session before the child spawns,
// and other tool calls get in during it. A status line that only counted spawned children
// would blink 0 at exactly the moment a dispatch is starting.
test("a reserved-but-unspawned dispatch counts as running", () => {
  const line = renderStatus([{ handle: null, done: null, verdict: null, startedAt: 10_000 }], { now: 20_000 });
  assert.match(facts(line), /\brunning=1\b/);
});

test("oldest is the earliest running start, in seconds, ignoring settled ones", () => {
  const line = renderStatus([
    { verdict: null, startedAt: 5_000_000 },
    { verdict: null, startedAt: 3_000_000 },
    { verdict: { status: "completed" }, startedAt: 1_000 },
  ], { now: 9_000_000 });
  assert.match(facts(line), /\boldest=3000\b/);
});

test("models are deduplicated and lose their provider prefix", () => {
  const line = renderStatus([
    { verdict: null, model: "omlx/Qwen3.8-27B", startedAt: 1 },
    { verdict: null, model: "omlx/Qwen3.8-27B", startedAt: 2 },
    { verdict: null, model: "anthropic/claude-sonnet-5", startedAt: 3 },
  ], { now: 10 });
  assert.match(facts(line), /\bmodels=Qwen3\.8-27B,claude-sonnet-5\b/);
});

// The reader splits this line on whitespace in bash. A space inside any value would
// silently become an extra field and shift every key after it.
test("a value containing spaces cannot break the reader's word splitting", () => {
  const line = renderStatus([{ verdict: null, model: "local/my model v2", startedAt: 1 }], { now: 10 });
  const fields = facts(line).split(" ");
  assert.equal(fields.length, 5, `expected 5 fields, got: ${line}`);
  for (const field of fields) assert.match(field, /^[a-z]+=/);
});

test("no models still produces a placeholder field, not an empty one", () => {
  const line = renderStatus([{ verdict: null, startedAt: 1 }], { now: 10, owner: "" });
  assert.match(facts(line), /\bmodels=-$/);
});

test("nothing running renders running=0 and oldest=0", () => {
  const line = renderStatus([], { now: 10 });
  assert.match(facts(line), /\brunning=0\b/);
  assert.match(facts(line), /\boldest=0\b/);
});

test("writeStatus writes facts then owner, and clearStatus removes the file", () => {
  const path = join(dir(), "s.status");
  const opts = { path, pid: 7, now: 2000, owner: "/tmp/cc-socks/9.sock" };
  assert.equal(writeStatus([{ verdict: null, startedAt: 1000 }], opts), true);
  assert.equal(
    readFileSync(path, "utf8"),
    "pid=7 running=1 oldest=1 updated=2 models=-\n/tmp/cc-socks/9.sock\nstarted=1 model=-\n",
  );
  assert.equal(clearStatus({ path }), true);
  assert.equal(existsSync(path), false);
});

// The whole ownership fix rests on this value matching what the status-line process reads
// out of its own environment. Verified live: Claude Code puts CLAUDE_CODE_MESSAGING_SOCKET
// in the status-line command's environment, the same value the writer keys its file from.
// Lines 3+ are why a dispatch can have a row of its own. Line 1 keeps its aggregate so an
// older reader still works — see the skew test in statusline-script.test.mjs.
test("one line per running dispatch is appended, oldest first, settled ones excluded", () => {
  const line = renderStatus([
    { verdict: null, model: "omls/newer", startedAt: 5_000_000 },
    { verdict: null, model: "omls/older", startedAt: 1_000_000 },
    { verdict: { status: "completed" }, model: "omls/settled", startedAt: 2_000_000 },
  ], { pid: 42, now: 9_000_000, owner: "/tmp/s.sock" });

  const rows = line.split("\n").slice(2);
  assert.deepEqual(rows, ["started=1000 model=older", "started=5000 model=newer"]);
  assert.ok(!line.includes("settled"));
});

// Lines 1 and 2 are byte-identical to what they were before per-dispatch lines existed.
// An older reader stops after line 2, so anything that shifted there would break it.
test("appending per-dispatch lines leaves the first two lines untouched", () => {
  const entries = [{ verdict: null, model: "omls/m", startedAt: 3_000 }];
  const line = renderStatus(entries, { pid: 7, now: 9_000, owner: "/tmp/s.sock" });
  assert.equal(facts(line), "pid=7 running=1 oldest=3 updated=9 models=m");
  assert.equal(owner(line), "/tmp/s.sock");
});

test("a per-dispatch model is provider-stripped and space-free, like the aggregate", () => {
  const line = renderStatus([{ verdict: null, model: "local/my model v2", startedAt: 1_000 }], { now: 9_000 });
  const row = line.split("\n")[2];
  assert.equal(row.split(" ").length, 2, row);
  assert.match(row, /^started=1 model=my-model-v2$/);
});

// A dispatch enrolled in the reservation window has no startedAt yet. It still counts as
// running, so it still gets a row; 0 is the reader's cue to show no elapsed rather than
// an elapsed measured from 1970.
test("a dispatch with no usable startedAt gets a row with started=0", () => {
  const line = renderStatus([{ verdict: null, model: "omls/m" }], { now: 9_000 });
  assert.equal(line.split("\n")[2], "started=0 model=m");
});

test("nothing running appends no per-dispatch lines at all", () => {
  const line = renderStatus([{ verdict: { status: "completed" }, startedAt: 1 }], { now: 10, owner: "o" });
  assert.equal(line.split("\n").length, 2);
});

test("the owner is the messaging socket, verbatim and unhashed", () => {
  assert.equal(ownerToken({ CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/34699.sock" }), "/tmp/cc-socks/34699.sock");
  assert.equal(ownerToken({}), "");
  assert.equal(ownerToken({ CLAUDE_CODE_MESSAGING_SOCKET: "   " }), "");
});

// A path with a space is why the owner gets a line to itself rather than a sixth field.
test("an owner containing a space cannot disturb the facts line", () => {
  const line = renderStatus([{ verdict: null, startedAt: 1 }], { now: 10, owner: "/tmp/my socks/1.sock" });
  assert.equal(facts(line).split(" ").length, 5);
  assert.equal(owner(line), "/tmp/my socks/1.sock");
});

// The secret that sits beside the messaging socket in the environment.
test("the messaging token never reaches the owner line", () => {
  const line = renderStatus([], {
    now: 1,
    owner: ownerToken({
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/1.sock",
      CLAUDE_CODE_MESSAGING_TOKEN: "super-secret-value",
    }),
  });
  assert.ok(!line.includes("super-secret-value"));
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
