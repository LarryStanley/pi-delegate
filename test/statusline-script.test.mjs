import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The aggregation lives in bash because the alternative was measured and rejected: a node
// process that only reads one small file costs 40-60ms of startup on every status-line
// tick. Bash is where the logic is, so bash is where it has to be tested — running the
// real script, not a JS re-implementation of it that could happily agree with a bug.
const SCRIPT = fileURLToPath(new URL("../scripts/statusline.sh", import.meta.url));

const YELLOW = "[33m";
const RED = "[31m";

const NOW = () => Math.floor(Date.now() / 1000);
const LIVE = process.pid;   // this test process: a pid guaranteed to be alive
const DEAD = 2147483646;    // above every pid_max in practice, so guaranteed not to be

// Every fixture line is written with MINE as its owner unless a test says otherwise, so
// the default case under test is "this session's own dispatches".
const MINE = "/tmp/cc-socks/1111.sock";
const THEIRS = "/tmp/cc-socks/2222.sock";

// A status file is two lines: the facts, then the owner alone on line 2.
const file = (facts, owner = MINE) => `${facts}\n${owner}\n`;

function run(files, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return execFileSync("bash", [SCRIPT], {
    encoding: "utf8",
    // PI_DELEGATE_OWNER pins who "we" are. Without it the script would inherit the real
    // CLAUDE_CODE_MESSAGING_SOCKET of whatever session is running the tests.
    env: {
      ...process.env,
      PI_DELEGATE_STATUS_DIR: dir,
      COLORTERM: "truecolor",
      PI_DELEGATE_OWNER: MINE,
      ...env,
    },
  });
}

// The property the whole "append a line" composition rests on: when nothing is running the
// script must contribute NOTHING — not a blank line, which would still take a row of the
// user's status bar and make the bar's height flicker on every dispatch.
test("prints absolutely nothing when no dispatch is running", () => {
  assert.equal(run({}), "");
  assert.equal(run({ "a.status": file(`pid=${LIVE} running=0 oldest=0 updated=${NOW()} models=-`) }), "");
});

test("counts one session's running dispatches", () => {
  const out = run({ "a.status": file(`pid=${LIVE} running=2 oldest=${NOW() - 47} updated=${NOW()} models=Qwen3.8-27B`) });
  assert.match(out, /2 running/);
  assert.match(out, /4[5-9]s/);
  assert.match(out, /Qwen3\.8-27B/);
});

// The 0.13.0 bug, reported from the user's other window: it summed every session's file,
// so a window that had dispatched nothing displayed `1 running` for work its own
// pi_result answers "Unknown session_id" to. Visible and unactionable, which is the shape
// of issues/1 — a session told about work that is not its own.
test("another session's dispatches are not counted, and produce no row at all", () => {
  assert.equal(
    run({ "theirs.status": file(`pid=${LIVE} running=2 oldest=${NOW() - 30} updated=${NOW()} models=gemma-26b`, THEIRS) }),
    "",
  );
});

test("our own dispatches are counted while another session's are ignored", () => {
  const out = run({
    "mine.status": file(`pid=${LIVE} running=1 oldest=${NOW() - 12} updated=${NOW()} models=Qwen3.8-27B`),
    "theirs.status": file(`pid=${LIVE} running=5 oldest=${NOW() - 900} updated=${NOW()} models=gemma-26b`, THEIRS),
  });
  assert.match(out, /1 running/);
  assert.ok(!out.includes("gemma-26b"), out);
  // Their 15-minute-old dispatch must not colour our 12-second-old one red either.
  assert.ok(!out.includes(RED), out);
});

// A file we cannot attribute is not ours to report. Two sessions is a normal working
// pattern, so guessing is how the reported bug happened in the first place.
test("a file with no owner line is skipped when we know who we are", () => {
  const legacy = `pid=${LIVE} running=3 oldest=${NOW() - 20} updated=${NOW()} models=ghost\n`;
  assert.equal(run({ "legacy.status": legacy }), "");
});

// Run by hand, or by an older Claude Code that sets no messaging socket: there is nothing
// to compare against, and no second session to be confused with either. Counting
// everything keeps the preview path in skills/statusline working.
test("with no owner of our own, everything is counted", () => {
  const out = run(
    { "a.status": `pid=${LIVE} running=2 oldest=${NOW() - 5} updated=${NOW()} models=Qwen3.8-27B\n` },
    { PI_DELEGATE_OWNER: "", CLAUDE_CODE_MESSAGING_SOCKET: "" },
  );
  assert.match(out, /2 running/);
});

test("the row never reports a session count, because it only ever shows one session", () => {
  const out = run({ "a.status": file(`pid=${LIVE} running=1 oldest=${NOW() - 5} updated=${NOW()} models=-`) });
  assert.ok(!out.includes("session"), out);
});

test("elapsed comes from the oldest running dispatch, not the newest", () => {
  const out = run({
    "a.status": file(`pid=${LIVE} running=1 oldest=${NOW() - 5} updated=${NOW()} models=-`),
    "b.status": file(`pid=${LIVE} running=1 oldest=${NOW() - 3600 - 120} updated=${NOW()} models=-`),
  });
  assert.match(out, /1h02m/);
});

test("a model running twice concurrently is printed once", () => {
  const out = run({
    "a.status": file(`pid=${LIVE} running=2 oldest=${NOW() - 6} updated=${NOW()} models=Qwen3.8-27B,Qwen3.8-27B,gemma-26b`),
  });
  assert.equal(out.match(/Qwen3\.8-27B/g).length, 1);
  assert.match(out, /gemma-26b/);
});

// A server killed rather than shut down leaves its file behind. Without the pid gate the
// status line would keep claiming those dispatches are running, forever.
test("a file whose owning process is gone is ignored entirely", () => {
  assert.equal(run({ "dead.status": file(`pid=${DEAD} running=9 oldest=${NOW() - 10} updated=${NOW()} models=ghost`) }), "");
  const out = run({
    "dead.status": file(`pid=${DEAD} running=9 oldest=${NOW() - 99999} updated=${NOW()} models=ghost`),
    "live.status": file(`pid=${LIVE} running=1 oldest=${NOW() - 12} updated=${NOW()} models=Qwen3.8-27B`),
  });
  assert.match(out, /1 running/);
  assert.ok(!out.includes("ghost"), out);
  assert.ok(!out.includes("sessions"), out);
});

// This output goes straight into the user's status bar. A malformed file must degrade to
// "skip it" — a bash arithmetic error printed across the bottom of the terminal would be a
// far worse failure than a missing line.
test("malformed, empty and truncated files are skipped without any error output", () => {
  const out = run({
    "junk.status": file("pid=abc running=x oldest=?? models="),
    "empty.status": "",
    "partial.status": file("pid="),
    "half.status": file(`pid=${LIVE} running=`),
    "good.status": file(`pid=${LIVE} running=1 oldest=${NOW() - 3} updated=${NOW()} models=Qwen3.8-27B`),
  });
  assert.match(out, /1 running/);
  assert.ok(!/error|bad|integer|expression/i.test(out), out);
});

test("elapsed is coloured at the two thresholds and plain below them", () => {
  const at = (secondsAgo) =>
    run({ "a.status": file(`pid=${LIVE} running=1 oldest=${NOW() - secondsAgo} updated=${NOW()} models=-`) });
  const fresh = at(60);
  assert.ok(!fresh.includes(YELLOW) && !fresh.includes(RED), fresh);
  assert.ok(at(400).includes(YELLOW), "5+ minutes should be yellow");
  assert.ok(at(1200).includes(RED), "15+ minutes should be red");
});

// The phase is taken from the wall clock rather than a frame counter, so the animation
// looks the same whatever cadence Claude Code actually reruns us at — and cannot freeze
// into one frame when the session goes quiet and only the refresh timer is firing.
//
// That property is exactly what makes it testable: pin the clock and the frame is
// determined. It also means the shape survives Claude Code's real cadence — with
// refreshInterval=2 you see every other step of this ramp, which is still a triangle.
test("the breathing dot is a triangle ramp driven by the clock", () => {
  const base = 1_800_000_000;   // a round epoch, so base % 10 === 0
  const brightness = (t) =>
    run(
      { "a.status": file(`pid=${LIVE} running=1 oldest=${t - 5} updated=${t} models=-`) },
      { PI_DELEGATE_NOW: String(t) },
    ).match(/38;2;(\d+);/)?.[1];

  const cycle = Array.from({ length: 10 }, (_, i) => brightness(base + i));
  assert.deepEqual(cycle, ["90", "119", "148", "177", "206", "235", "206", "177", "148", "119"]);
  // And it repeats rather than running off the end of the ramp.
  assert.equal(brightness(base + 10), "90");
});

test("the same instant always renders the same frame", () => {
  const t = 1_800_000_003;
  const at = () =>
    run(
      { "a.status": file(`pid=${LIVE} running=1 oldest=${t - 5} updated=${t} models=-`) },
      { PI_DELEGATE_NOW: String(t) },
    );
  assert.equal(at(), at());
});

// A pinned clock is a test seam, and a test seam that can be fed junk is a way to get a
// bash arithmetic error into the user's status bar.
test("a non-numeric pinned clock falls back to the real one instead of erroring", () => {
  const out = run(
    { "a.status": file(`pid=${LIVE} running=1 oldest=${NOW() - 5} updated=${NOW()} models=-`) },
    { PI_DELEGATE_NOW: "not-a-time" },
  );
  assert.match(out, /1 running/);
  assert.ok(!/error|integer|expression/i.test(out), out);
});

test("a terminal without truecolor gets glyphs instead of an RGB escape", () => {
  const out = run(
    { "a.status": file(`pid=${LIVE} running=1 oldest=${NOW() - 5} updated=${NOW()} models=-`) },
    { COLORTERM: "" },
  );
  assert.ok(!out.includes("38;2;"), out);
  assert.match(out, /[·•●]/);
});

test("output is exactly one line", () => {
  const out = run({
    "a.status": file(`pid=${LIVE} running=2 oldest=${NOW() - 5} updated=${NOW()} models=Qwen3.8-27B`),
    "b.status": file(`pid=${LIVE} running=1 oldest=${NOW() - 9} updated=${NOW()} models=gemma-26b`),
  });
  assert.equal(out.split("\n").filter((l) => l !== "").length, 1);
});

// The writer and the reader are in different languages and tested separately, so the line
// format is exactly the seam where they can drift apart without either side's tests
// noticing. This is the only test that runs a real registry mutation all the way through
// to rendered output.
test("a real registry mutation renders through to the status line", async () => {
  const { createRegistry } = await import("../src/registry.mjs");
  const { writeStatus } = await import("../src/status.mjs");

  const dir = mkdtempSync(join(tmpdir(), "pi-roundtrip-"));
  const path = join(dir, "session.status");
  const registry = createRegistry({ onChange: (entries) => writeStatus(entries, { path, pid: LIVE }) });

  const render = () =>
    execFileSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, PI_DELEGATE_STATUS_DIR: dir, COLORTERM: "truecolor" },
    });

  assert.equal(render(), "", "no dispatches yet");

  registry.add("aaa", { verdict: null, model: "omlx/Qwen3.8-27B", startedAt: Date.now() });
  registry.add("bbb", { verdict: null, model: "omlx/Qwen3.8-27B", startedAt: Date.now() });
  const busy = render();
  assert.match(busy, /2 running/);
  assert.match(busy, /Qwen3\.8-27B/);
  assert.ok(!busy.includes("sessions"), busy);

  registry.update("aaa", { verdict: { status: "completed" } });
  assert.match(render(), /1 running/);

  registry.update("bbb", { verdict: { status: "completed" } });
  assert.equal(render(), "", "everything settled, so the row goes away again");
});
