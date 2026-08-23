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

const LIVE = process.pid;   // this test process: a pid guaranteed to be alive
const DEAD = 2147483646;    // above every pid_max in practice, so guaranteed not to be

// A pinned clock, and the default for anything that asserts a duration.
//
// The alternative — build the fixture from Date.now() and let the script read the real
// clock — straddles a second boundary whenever a test takes longer than the slack in its
// regex. On Windows these tests run 1-4s each, so "5s" arrives as "7s" and the suite fails
// for reasons that have nothing to do with the code. A round epoch also makes T % 10 === 0,
// which the breathing-dot tests depend on.
const T = 1_800_000_000;
const NOW = () => T;

// Every fixture line is written with MINE as its owner unless a test says otherwise, so
// the default case under test is "this session's own dispatches".
const MINE = "/tmp/cc-socks/1111.sock";
const THEIRS = "/tmp/cc-socks/2222.sock";

// A status file is two lines: the facts, then the owner alone on line 2. Fixtures built
// with this helper carry NO per-dispatch lines, which makes every one of them a test of
// the version-skew path as well — an older server's file, read by today's reader.
const file = (facts, owner = MINE) => `${facts}\n${owner}\n`;

// The current format: those same two lines, then one line per running dispatch. `rows` is
// [[startedEpochSeconds, model], ...]. The writer emits them oldest-first; the reader
// re-sorts defensively, so tests may pass them in any order.
const withRows = (facts, rows, owner = MINE) =>
  `${facts}\n${owner}\n${rows.map(([started, model]) => `started=${started} model=${model}`).join("\n")}\n`;

const lines = (out) => out.split("\n").filter((l) => l !== "");
const plain = (out) => out.replace(/\[[0-9;]*m/g, "");

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
      PI_DELEGATE_NOW: String(T),
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

test("a legacy aggregate file renders one row carrying its count", () => {
  const out = plain(run({
    "a.status": file(`pid=${LIVE} running=2 oldest=${NOW() - 47} updated=${NOW()} models=Qwen3.8-27B`),
  }));
  assert.equal(lines(out).length, 1);
  assert.match(out, /2× Qwen3\.8-27B/);
  assert.match(out, /\b47s\b/);
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
  assert.equal(lines(out).length, 1);
  assert.match(plain(out), /Qwen3\.8-27B/);
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
  const out = plain(run(
    { "a.status": `pid=${LIVE} running=2 oldest=${NOW() - 5} updated=${NOW()} models=Qwen3.8-27B\n` },
    { PI_DELEGATE_OWNER: "", CLAUDE_CODE_MESSAGING_SOCKET: "" },
  ));
  assert.match(out, /2× Qwen3\.8-27B/);
});

test("the row never reports a session count, because it only ever shows one session", () => {
  const out = run({ "a.status": file(`pid=${LIVE} running=1 oldest=${NOW() - 5} updated=${NOW()} models=-`) });
  assert.ok(!out.includes("session"), out);
});

// ---------------------------------------------------------------- one row per dispatch

// Every row's elapsed is its own. A dispatch holding the endpoint for an hour and one that
// started five seconds ago used to collapse into a single number that could only ever be
// true of one of them.
test("one row per dispatch, oldest first, each with its own elapsed", () => {
  const out = plain(run({
    "a.status": withRows(
      `pid=${LIVE} running=2 oldest=${NOW() - 3720} updated=${NOW()} models=ancient,fresh`,
      // Newest first on purpose: the reader must not depend on the order it is handed.
      [[NOW() - 5, "fresh"], [NOW() - 3720, "ancient"]],
    ),
  }));
  const rows = lines(out);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /1h02m/);
  assert.match(rows[0], /ancient/);
  assert.match(rows[1], /\b5s\b/);
  assert.match(rows[1], /fresh/);
});

// Rows from DIFFERENT files have to interleave by time too. That is the hand-run and
// preview path, where no owner is set and every session's file is read, and it is the case
// a per-file sort would silently get wrong.
test("rows from separate files are ordered by start, not by filename", () => {
  const out = plain(run(
    {
      "z-newest.status": withRows(`pid=${LIVE} running=1 oldest=${NOW() - 10} updated=${NOW()} models=newest`, [[NOW() - 10, "newest"]], ""),
      "a-oldest.status": withRows(`pid=${LIVE} running=1 oldest=${NOW() - 900} updated=${NOW()} models=oldest`, [[NOW() - 900, "oldest"]], ""),
    },
    { PI_DELEGATE_OWNER: "", CLAUDE_CODE_MESSAGING_SOCKET: "" },
  ));
  const rows = lines(out);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /oldest/);
  assert.match(rows[1], /newest/);
});

// The actionable half of splitting the rows: the colour thresholds apply per dispatch, so a
// stalled one goes red on its own line without dragging a healthy one red with it.
test("a stalled dispatch reddens its own row only", () => {
  const raw = run({
    "a.status": withRows(
      `pid=${LIVE} running=2 oldest=${NOW() - 1200} updated=${NOW()} models=stalled,fresh`,
      [[NOW() - 1200, "stalled"], [NOW() - 4, "fresh"]],
    ),
  });
  const rows = lines(raw);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].includes(RED), `stalled row should be red: ${JSON.stringify(rows[0])}`);
  assert.ok(!rows[1].includes(RED), `fresh row must not be: ${JSON.stringify(rows[1])}`);
  assert.match(plain(rows[0]), /stalled/);
  assert.match(plain(rows[1]), /fresh/);
});

// This deliberately reverses the old behaviour. One row per session could only ever show
// one elapsed time, so repeating a model name in it bought nothing and it was deduplicated.
// A row per dispatch is the whole point now: the same model started ten minutes apart is
// two facts, and collapsing them would hide the one that has been holding the endpoint.
test("two dispatches on the same model get a row each, because their elapsed differs", () => {
  const out = run({
    "a.status": withRows(
      `pid=${LIVE} running=2 oldest=${NOW() - 400} updated=${NOW()} models=Qwen3.8-27B`,
      [[NOW() - 400, "Qwen3.8-27B"], [NOW() - 20, "Qwen3.8-27B"]],
    ),
  });
  assert.equal(lines(out).length, 2);
  assert.equal(out.match(/Qwen3\.8-27B/g).length, 2);
  // And they are distinguishable, which is the reason both are there.
  assert.match(plain(out), /6m40s/);
  assert.match(plain(out), /\b20s\b/);
});

// The duration is right-aligned in a fixed-width column precisely so the model names form
// a second column. That only holds if the padding is applied BEFORE the colour escapes —
// pad a coloured string and every row is misaligned by the length of a colour code, which
// is invisible until one row crosses a threshold and the others have not.
test("the duration column is fixed width, so model names line up even across colours", () => {
  const models = ["stalled", "middling", "fresh"];
  const out = plain(run({
    "a.status": withRows(
      `pid=${LIVE} running=3 oldest=${NOW() - 1200} updated=${NOW()} models=x`,
      [[NOW() - 1200, "stalled"], [NOW() - 400, "middling"], [NOW() - 3, "fresh"]],
    ),
  }));
  const rows = lines(out);
  assert.equal(rows.length, 3);
  const columns = rows.map((row, i) => row.indexOf(models[i]));
  assert.ok(columns.every((c) => c > 0), rows.join("\n"));
  assert.equal(new Set(columns).size, 1, `models start at differing columns: ${JSON.stringify(rows)}`);
});

// One row per dispatch, and never a blank one. A blank line still takes a row of the user's
// status bar and makes the bar's height flicker — the same property the
// "prints absolutely nothing" test protects at zero dispatches.
test("output is one line per running dispatch, with no blank lines", () => {
  const out = run({
    "a.status": withRows(
      `pid=${LIVE} running=3 oldest=${NOW() - 30} updated=${NOW()} models=a,b,c`,
      [[NOW() - 30, "a"], [NOW() - 20, "b"], [NOW() - 10, "c"]],
    ),
  });
  assert.equal(lines(out).length, 3);
  assert.ok(!out.includes("\n\n"), JSON.stringify(out));
  assert.ok(out.endsWith("\n"), JSON.stringify(out));
});

// MAX_ROWS discards rows, so it has to discard the right ones and say that it did. A capped
// list that looks complete is a worse lie than one that admits what it is holding back.
test("rows are capped, oldest kept, and the overflow says how many are hidden", () => {
  const out = plain(run({
    "a.status": withRows(
      `pid=${LIVE} running=6 oldest=${NOW() - 600} updated=${NOW()} models=x`,
      [1, 2, 3, 4, 5, 6].map((i) => [NOW() - i * 100, `model-${i}`]),
    ),
  }));
  const rows = lines(out);
  assert.equal(rows.length, 5, out);
  assert.match(rows[0], /model-6/);   // oldest kept
  assert.match(rows[3], /model-3/);
  assert.match(rows[4], /\+2 more/);
  assert.ok(!out.includes("model-1"), out);
  assert.ok(!out.includes("model-2"), out);
});

// ---------------------------------------------------------------- version skew

// The reader and the writer are copied to different places at different times: step 4 of
// /pi-delegate:statusline puts the reader in ~/.claude by hand, so a plugin upgrade moves
// the writer forward while the reader stays behind, or the reverse. Neither direction may
// go blank — that failure is invisible, which is exactly how the Windows liveness bug hid.
test("a file from a writer that predates per-dispatch lines still renders its aggregate", () => {
  const out = plain(run({
    "a.status": file(`pid=${LIVE} running=3 oldest=${NOW() - 200} updated=${NOW()} models=gemma-26b,Qwen3.8-27B`),
  }));
  assert.equal(lines(out).length, 1);
  assert.match(out, /3× gemma-26b,Qwen3\.8-27B/);
  assert.match(out, /3m20s/);
});

// A row that stands for exactly one dispatch does not need to announce that it is one.
test("a per-dispatch row prints no count prefix", () => {
  const out = plain(run({
    "a.status": withRows(`pid=${LIVE} running=1 oldest=${NOW() - 5} updated=${NOW()} models=solo`, [[NOW() - 5, "solo"]]),
  }));
  assert.match(out, /pi\s+5s\s+solo/);
  assert.ok(!out.includes("×"), out);
});

// ---------------------------------------------------------------- degradation

// A server killed rather than shut down leaves its file behind. Without the pid gate the
// status line would keep claiming those dispatches are running, forever.
test("a file whose owning process is gone is ignored entirely", () => {
  assert.equal(run({ "dead.status": file(`pid=${DEAD} running=9 oldest=${NOW() - 10} updated=${NOW()} models=ghost`) }), "");
  const out = run({
    "dead.status": file(`pid=${DEAD} running=9 oldest=${NOW() - 99999} updated=${NOW()} models=ghost`),
    "live.status": file(`pid=${LIVE} running=1 oldest=${NOW() - 12} updated=${NOW()} models=Qwen3.8-27B`),
  });
  assert.equal(lines(out).length, 1);
  assert.match(plain(out), /Qwen3\.8-27B/);
  assert.ok(!out.includes("ghost"), out);
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
  assert.equal(lines(out).length, 1);
  assert.match(plain(out), /Qwen3\.8-27B/);
  assert.ok(!/error|bad|integer|expression/i.test(out), out);
});

// Same standing as the file above, one level down: a junk per-dispatch line must cost its
// own row and nothing else.
test("malformed per-dispatch lines are skipped without any error output", () => {
  const out = run({
    "a.status": `pid=${LIVE} running=2 oldest=${NOW() - 100} updated=${NOW()} models=ok\n${MINE}\n`
      + "started=notanumber model=junk\n"
      + "a line with no keys at all\n"
      + "started= model=alsojunk\n"
      + `started=${NOW() - 100} model=ok\n`,
  });
  assert.equal(lines(out).length, 1);
  assert.match(plain(out), /\bok\b/);
  assert.ok(!out.includes("junk"), out);
  assert.ok(!/error|bad|integer|expression/i.test(out), out);
});

test("elapsed is coloured at the two thresholds and plain below them", () => {
  const at = (secondsAgo) =>
    run({ "a.status": withRows(
      `pid=${LIVE} running=1 oldest=${NOW() - secondsAgo} updated=${NOW()} models=m`,
      [[NOW() - secondsAgo, "m"]],
    ) });
  const fresh = at(60);
  assert.ok(!fresh.includes(YELLOW) && !fresh.includes(RED), fresh);
  assert.ok(at(400).includes(YELLOW), "5+ minutes should be yellow");
  assert.ok(at(1200).includes(RED), "15+ minutes should be red");
});

// ---------------------------------------------------------------- the dot

// The phase is taken from the wall clock rather than a frame counter, so the animation
// looks the same whatever cadence Claude Code actually reruns us at — and cannot freeze
// into one frame when the session goes quiet and only the refresh timer is firing.
//
// That property is exactly what makes it testable: pin the clock and the frame is
// determined. It also means the shape survives Claude Code's real cadence — with
// refreshInterval=2 you see every other step of this ramp, which is still a triangle.
test("the breathing dot is a triangle ramp driven by the clock", () => {
  const base = T;   // a round epoch, so base % 10 === 0
  const brightness = (t) =>
    run(
      { "a.status": file(`pid=${LIVE} running=1 oldest=${t - 5} updated=${t} models=-`) },
      { PI_DELEGATE_NOW: String(t), COLORTERM: "truecolor" },
    ).match(/38;2;(\d+);/)?.[1];

  const cycle = Array.from({ length: 10 }, (_, i) => brightness(base + i));
  assert.deepEqual(cycle, ["90", "119", "148", "177", "206", "235", "206", "177", "148", "119"]);
  // And it repeats rather than running off the end of the ramp.
  assert.equal(brightness(base + 10), "90");
});

// Every row shares one dot, computed once per tick: rows pulsing out of step would read as
// several competing indicators rather than one.
test("all rows pulse in unison", () => {
  const out = run({
    "a.status": withRows(
      `pid=${LIVE} running=3 oldest=${NOW() - 30} updated=${NOW()} models=x`,
      [[NOW() - 30, "a"], [NOW() - 20, "b"], [NOW() - 10, "c"]],
    ),
  });
  const dots = lines(out).map((row) => row.match(/38;2;(\d+);/)?.[1]);
  assert.equal(dots.length, 3);
  assert.equal(new Set(dots).size, 1, JSON.stringify(dots));
});

test("the same instant always renders the same frame", () => {
  const t = T + 3;
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
    { "a.status": file(`pid=${LIVE} running=1 oldest=${Math.floor(Date.now() / 1000) - 5} updated=${NOW()} models=Qwen3.8-27B`) },
    { PI_DELEGATE_NOW: "not-a-time" },
  );
  assert.equal(lines(out).length, 1);
  assert.match(plain(out), /Qwen3\.8-27B/);
  assert.ok(!/error|integer|expression/i.test(out), out);
});

// Note the pinned TERM and TERM_PROGRAM. `run` spreads process.env, so without them this
// test inherits the TERM of whatever terminal happens to run the suite — and since TERM can
// now select truecolor on its own, it would pass or fail depending on the developer's
// terminal rather than on the code.
test("a terminal without truecolor gets glyphs instead of an RGB escape", () => {
  const out = run(
    { "a.status": file(`pid=${LIVE} running=1 oldest=${NOW() - 5} updated=${NOW()} models=-`) },
    { COLORTERM: "", TERM: "xterm-256color", TERM_PROGRAM: "" },
  );
  assert.ok(!out.includes("38;2;"), out);
  assert.match(out, /[·•●]/);
});

// Truecolor is what makes the dot breathe: 256 brightness levels on one glyph, against
// three glyph steps at a constant dim. A 24-bit terminal that does not export COLORTERM to
// its children therefore loses the feature, not a nicety — reported as "the breathing light
// is gone" on Ghostty, which is 24-bit capable with TERM=xterm-ghostty and no COLORTERM.
test("a 24-bit terminal is detected from TERM when COLORTERM is absent", () => {
  const capable = [
    "xterm-ghostty", "ghostty", "xterm-kitty", "alacritty", "wezterm",
    "contour", "foot", "rio", "xterm-direct", "tmux-direct",
  ];
  for (const term of capable) {
    const out = run(
      { "a.status": file(`pid=${LIVE} running=1 oldest=${NOW() - 5} updated=${NOW()} models=-`) },
      { COLORTERM: "", TERM: term, TERM_PROGRAM: "" },
    );
    assert.match(out, /38;2;\d+;/, `${term} should be truecolor`);
  }
});

test("TERM_PROGRAM is a second chance, but Apple_Terminal is not 24-bit", () => {
  const at = (env) =>
    run({ "a.status": file(`pid=${LIVE} running=1 oldest=${NOW() - 5} updated=${NOW()} models=-`) },
        { COLORTERM: "", TERM: "xterm-256color", ...env });
  assert.match(at({ TERM_PROGRAM: "WezTerm" }), /38;2;\d+;/);
  assert.match(at({ TERM_PROGRAM: "ghostty" }), /38;2;\d+;/);
  // 256 colours only. Sending it RGB would be a downgrade, not an upgrade.
  assert.ok(!at({ TERM_PROGRAM: "Apple_Terminal" }).includes("38;2;"));
});

// The failure mode the whitelist exists to prevent: an unknown terminal must NOT be sent
// RGB escapes on the chance it copes. A terminal that cannot parse them prints
// `[38;2;90;90;90m` as literal text across the status bar on every single redraw.
test("an unrecognised terminal is not guessed into truecolor", () => {
  for (const term of ["dumb", "vt100", "xterm", "screen", "linux", ""]) {
    const out = run(
      { "a.status": file(`pid=${LIVE} running=1 oldest=${NOW() - 5} updated=${NOW()} models=-`) },
      { COLORTERM: "", TERM: term, TERM_PROGRAM: "" },
    );
    assert.ok(!out.includes("38;2;"), `${term || "(empty)"} should stay on the glyph path: ${out}`);
  }
});

// ---------------------------------------------------------------- platform

// Regression, Windows. The pid in a status file is node's `process.pid` — a WINDOWS pid —
// while Git Bash's `kill -0` resolves only pids in the MSYS namespace. The two are
// unrelated numbers, so the liveness gate rejected every status file and this script
// printed nothing on Windows no matter how many dispatches were running.
//
// It was not a subtle failure, which is why it is worth a named test rather than trusting
// the coverage above: on win32, 13 of this file's tests failed, and the ones that passed
// were exactly the ones asserting empty output. A bug whose symptom is "the feature does
// not exist" is invisible to anyone who has not seen it work elsewhere.
test("a live Windows pid survives the liveness gate", { skip: process.platform !== "win32" && "win32 only" }, () => {
  const out = run({
    "a.status": withRows(`pid=${LIVE} running=1 oldest=${NOW() - 5} updated=${NOW()} models=gemma-26b`, [[NOW() - 5, "gemma-26b"]]),
  });
  assert.equal(lines(out).length, 1);
  assert.match(plain(out), /gemma-26b/);
});

// The winpid fallback must not degrade into a blanket pass. A killed server leaves its file
// behind, and the pid is the only evidence that its count still means anything — if the
// fallback accepted anything it could not disprove, the row would outlive the server.
test("the Windows fallback still rejects a dead pid", { skip: process.platform !== "win32" && "win32 only" }, () => {
  assert.equal(
    run({ "a.status": withRows(`pid=${DEAD} running=1 oldest=${NOW() - 5} updated=${NOW()} models=gemma-26b`, [[NOW() - 5, "gemma-26b"]]) }),
    "",
  );
});

// ---------------------------------------------------------------- the seam

// The writer and the reader are in different languages and tested separately, so the file
// format is exactly the seam where they can drift apart without either side's tests
// noticing. This is the only test that runs a real registry mutation all the way through to
// rendered output.
test("a real registry mutation renders through to the status line", async () => {
  const { createRegistry } = await import("../src/registry.mjs");
  const { writeStatus } = await import("../src/status.mjs");

  const dir = mkdtempSync(join(tmpdir(), "pi-roundtrip-"));
  const path = join(dir, "session.status");
  const registry = createRegistry({ onChange: (entries) => writeStatus(entries, { path, pid: LIVE }) });

  // The clock is pinned to the same instant the entries are dated from, so the elapsed
  // values below are exact rather than "whatever this machine took to get here".
  const nowMs = T * 1000;
  const render = () =>
    execFileSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, PI_DELEGATE_STATUS_DIR: dir, COLORTERM: "truecolor", PI_DELEGATE_NOW: String(T) },
    });

  assert.equal(render(), "", "no dispatches yet");

  // Two dispatches, deliberately started a measurable distance apart, because the seam
  // being tested is no longer just "how many" — it is that each dispatch's own start
  // survives the trip from the registry, through the file, to its own row.
  registry.add("aaa", { verdict: null, model: "omls/gemma-4-26b", startedAt: nowMs - 700_000 });
  registry.add("bbb", { verdict: null, model: "omls/Qwen3.8-27B", startedAt: nowMs - 9_000 });

  const busy = render();
  const rows = lines(busy);
  assert.equal(rows.length, 2, busy);
  // Oldest first, and it is the one carrying the eleven-minute elapsed.
  assert.match(plain(rows[0]), /11m40s/);
  assert.match(rows[0], /gemma-4-26b/);
  assert.match(plain(rows[1]), /\b9s\b/);
  assert.match(rows[1], /Qwen3\.8-27B/);
  // A per-dispatch row never prints a count, so no aggregate prefix may appear.
  assert.ok(!busy.includes("×"), busy);

  registry.update("aaa", { verdict: { status: "completed" } });
  const one = render();
  assert.equal(lines(one).length, 1);
  assert.match(one, /Qwen3\.8-27B/);
  assert.ok(!one.includes("gemma-4-26b"), one);

  registry.update("bbb", { verdict: { status: "completed" } });
  assert.equal(render(), "", "everything settled, so the rows go away again");
});
