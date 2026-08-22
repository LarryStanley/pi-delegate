import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPiArgs, dispatch } from "../src/dispatch.mjs";
import { formatVerdict } from "../src/verdict.mjs";
import { DEFAULTS } from "../src/config.mjs";

// Every test supplies its own config and piDefaults; results must never depend on whatever
// ~/.claude/pi-delegate/config.json or ~/.pi/agent/settings.json happens to exist on this
// machine.
const CONFIG = { ...DEFAULTS, drafter_patterns: [...DEFAULTS.drafter_patterns] };
const NO_PI_DEFAULTS = { provider: null, model: null };

// NOTE (deviation from task-6-brief.md): the brief places this fixture at
// test/fixtures/fake-pi.mjs. Node's `node --test` (bare, per package.json)
// auto-discovers ANY .js/.mjs/.cjs file under a directory literally named
// "test" (glob **/test/**/*.{cjs,mjs,js} — confirmed empirically and in the
// Node docs), regardless of filename or whether it uses node:test. That made
// the fixture itself show up as a phantom 54th "test" in `npm test` output,
// contradicting the required count of 53. Moving it to a top-level
// fixtures/ directory (outside any "test" path segment) avoids the
// auto-discovery glob without touching package.json's test script.
const FAKE_PI = ["node", "fixtures/fake-pi.mjs"];

function tmpTask(body = "Modify a.ts") {
  const dir = mkdtempSync(join(tmpdir(), "pi-task-"));
  const file = join(dir, "TASK.md");
  writeFileSync(file, body);
  return { dir, file };
}

// --- Structural flags: fixed ---

test("buildPiArgs emits the structural flags", () => {
  const args = buildPiArgs({ sessionId: "s1", config: CONFIG, piDefaults: NO_PI_DEFAULTS });
  assert.ok(args.includes("--mode") && args.includes("rpc"));
  assert.ok(args.includes("--session-id") && args.includes("s1"));
  assert.ok(args.includes("--no-skills"));
  assert.ok(args.includes("--no-extensions"));
});

test("buildPiArgs must not emit --cwd (pi has no such flag)", () => {
  assert.ok(!buildPiArgs({ sessionId: "s", config: CONFIG, piDefaults: NO_PI_DEFAULTS }).includes("--cwd"));
});

test("buildPiArgs must not emit --no-session (it would leave drill-down with no data)", () => {
  assert.ok(!buildPiArgs({ sessionId: "s", config: CONFIG, piDefaults: NO_PI_DEFAULTS }).includes("--no-session"));
});

// --- provider / model: with nothing configured, emit nothing and let pi resolve ---
//
// This is the regression guard for the whole provider-agnostic change. With no CLI flags,
// pi's findInitialModel (dist/core/model-resolver.js:423-476) uses defaultProvider /
// defaultModel from ~/.pi/agent/settings.json — the model the user already works with.
// A plugin inventing its own default model is a plugin overriding somebody's setup.
test("with no config and no arguments, neither --provider nor --model is emitted", () => {
  const args = buildPiArgs({ sessionId: "s", config: DEFAULTS, piDefaults: NO_PI_DEFAULTS });
  assert.ok(!args.includes("--provider"), `should carry no --provider: ${args.join(" ")}`);
  assert.ok(!args.includes("--model"), `should carry no --model: ${args.join(" ")}`);
  assert.ok(!args.join(" ").includes("omlx"));
  assert.ok(!args.join(" ").includes("Qwen"));
});

test("when the config specifies provider / model, both flags appear", () => {
  const config = { ...DEFAULTS, provider: "anthropic", model: "claude-sonnet-4-6" };
  const args = buildPiArgs({ sessionId: "s", config, piDefaults: NO_PI_DEFAULTS });
  assert.equal(args[args.indexOf("--provider") + 1], "anthropic");
  assert.equal(args[args.indexOf("--model") + 1], "claude-sonnet-4-6");
});

test("call arguments override the config's provider / model", () => {
  const config = { ...DEFAULTS, provider: "anthropic", model: "claude-sonnet-4-6" };
  const args = buildPiArgs({ sessionId: "s", config, piDefaults: NO_PI_DEFAULTS, provider: "ollama", model: "qwen3:8b" });
  assert.equal(args[args.indexOf("--provider") + 1], "ollama");
  assert.equal(args[args.indexOf("--model") + 1], "qwen3:8b");
});

// pi honours a command-line model selection only when provider and model are both present
// (model-resolver.js:428); a lone flag is silently ignored. So the two appear as a pair or
// not at all.
test("when only model is given, provider comes from pi's defaults and both flags appear as a pair", () => {
  const args = buildPiArgs({
    sessionId: "s", config: DEFAULTS, model: "some-model",
    piDefaults: { provider: "litellm", model: "other" },
  });
  assert.equal(args[args.indexOf("--provider") + 1], "litellm");
  assert.equal(args[args.indexOf("--model") + 1], "some-model");
});

// --- Measured defaults: overridable, and an override must really reach the args ---

test("bash is not granted by default", () => {
  const args = buildPiArgs({ sessionId: "s", config: CONFIG, piDefaults: NO_PI_DEFAULTS });
  const tools = args[args.indexOf("--tools") + 1];
  assert.equal(tools, "read,write,edit");
  assert.ok(!tools.split(",").includes("bash"));
});

// A schema that accepts an override which buildPiArgs then quietly drops is exactly the
// "internally consistent, wrong about reality" defect this codebase has hit five times.
// This test watches that path.
test("overriding tools to include bash really shows up in the args", () => {
  const args = buildPiArgs({ sessionId: "s", config: CONFIG, piDefaults: NO_PI_DEFAULTS, tools: "read,write,edit,bash" });
  assert.equal(args[args.indexOf("--tools") + 1], "read,write,edit,bash");
});

test("thinking defaults to off and can be overridden to another level", () => {
  const off = buildPiArgs({ sessionId: "s", config: CONFIG, piDefaults: NO_PI_DEFAULTS });
  assert.equal(off[off.indexOf("--thinking") + 1], "off");
  const high = buildPiArgs({ sessionId: "s", config: CONFIG, piDefaults: NO_PI_DEFAULTS, thinking: "high" });
  assert.equal(high[high.indexOf("--thinking") + 1], "high");
});

test("thinking set to null omits --thinking entirely", () => {
  const args = buildPiArgs({ sessionId: "s", config: CONFIG, piDefaults: NO_PI_DEFAULTS, thinking: null });
  assert.ok(!args.includes("--thinking"));
});

// pi merely warns about an invalid --thinking value and then drops it
// (dist/cli/args.js:96-105). Silently ignoring an explicit override is the failure shape
// this round set out to avoid.
test("an invalid thinking level throws instead of being handed to pi to ignore silently", () => {
  assert.throws(
    () => buildPiArgs({ sessionId: "s", config: CONFIG, piDefaults: NO_PI_DEFAULTS, thinking: "maximum" }),
    /thinking/,
  );
});

test("no_context_files emits the flag by default and omits it when overridden to false", () => {
  const on = buildPiArgs({ sessionId: "s", config: CONFIG, piDefaults: NO_PI_DEFAULTS });
  assert.ok(on.includes("--no-context-files"));
  const off = buildPiArgs({ sessionId: "s", config: CONFIG, piDefaults: NO_PI_DEFAULTS, noContextFiles: false });
  assert.ok(!off.includes("--no-context-files"));
});

test("append_system_prompt is omitted by default and emitted when supplied", () => {
  const none = buildPiArgs({ sessionId: "s", config: CONFIG, piDefaults: NO_PI_DEFAULTS });
  assert.ok(!none.includes("--append-system-prompt"));
  const appended = buildPiArgs({ sessionId: "s", config: CONFIG, piDefaults: NO_PI_DEFAULTS, appendSystemPrompt: "only touch the files named in the task book" });
  assert.equal(appended[appended.indexOf("--append-system-prompt") + 1], "only touch the files named in the task book");
});

test("a normal finish returns a completed verdict", async () => {
  const { dir, file } = tmpTask();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, config: CONFIG, piDefaults: NO_PI_DEFAULTS, timeoutS: 10,
    sessionId: "s1", piCommand: FAKE_PI, gitDiffStat: "",
  });
  const verdict = await done;
  assert.equal(verdict.status, "completed");
  assert.equal(verdict.session_id, "s1");
});

test("a timeout returns a timeout verdict and still attaches git_diff_stat", async () => {
  const { dir, file } = tmpTask();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, config: CONFIG, piDefaults: NO_PI_DEFAULTS, timeoutS: 1,
    sessionId: "s2", piCommand: [...FAKE_PI, "--hang"],
    gitDiffStat: "1 file changed",
  });
  const verdict = await done;
  assert.equal(verdict.status, "timeout");
  assert.equal(verdict.git_diff_stat, "1 file changed");
});

test("abort returns an aborted verdict", async () => {
  const { dir, file } = tmpTask();
  const { handle, done } = await dispatch({
    taskFile: file, cwd: dir, config: CONFIG, piDefaults: NO_PI_DEFAULTS, timeoutS: 30,
    sessionId: "s3", piCommand: [...FAKE_PI, "--hang"], gitDiffStat: "",
  });
  await handle.abort();
  assert.equal((await done).status, "aborted");
});

test("write events are reflected in the verdict's write_count", async () => {
  const { dir, file } = tmpTask();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, config: CONFIG, piDefaults: NO_PI_DEFAULTS, timeoutS: 10,
    sessionId: "s4", piCommand: [...FAKE_PI, "--write=a.ts,b.ts"], gitDiffStat: "",
  });
  const verdict = await done;
  assert.equal(verdict.write_count, 2);
  assert.deepEqual(verdict.files_written, ["a.ts", "b.ts"]);
});

test("steer sends its message into the child process's stdin", async () => {
  const { dir, file } = tmpTask();
  const { handle, done } = await dispatch({
    taskFile: file, cwd: dir, config: CONFIG, piDefaults: NO_PI_DEFAULTS, timeoutS: 10,
    sessionId: "s5", piCommand: [...FAKE_PI, "--echo-steer"], gitDiffStat: "",
  });
  await handle.steer("a bit to the left");
  const verdict = await done;
  assert.ok(verdict.last_message.includes("a bit to the left"));
});

test("the child staying alive after agent_end (real pi RPC behavior) must still return completed well under the timeout", async () => {
  const { dir, file } = tmpTask();
  const timeoutS = 15;
  const startedAt = Date.now();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, config: CONFIG, piDefaults: NO_PI_DEFAULTS, timeoutS,
    sessionId: "s7", piCommand: [...FAKE_PI, "--stay-alive"], gitDiffStat: "",
  });
  const verdict = await done;
  const elapsedS = (Date.now() - startedAt) / 1000;
  assert.equal(verdict.status, "completed");
  assert.ok(
    elapsedS < timeoutS / 2,
    `expected settle well under timeout (${timeoutS}s), took ${elapsedS}s`,
  );
});

// NOTE (round-2 review correction): the previous version of this test
// asserted `status === "aborted"` after calling `handle.abort()` right
// after `dispatch()` returned. That is NOT a race — `dispatch()` and
// `abort()` contain no `await`s before the SIGTERM is sent, so abort()
// always runs and sets `aborted = true` well before the spawned fake-pi
// process has even started, let alone emitted agent_end. The assertion
// passed identically whether or not the `settled` guard existed in
// abort() — it never exercised the guard it was written to prove. See
// task-10-report.md round-2 section for the full explanation.
//
// This version tests the guard directly instead of inferring it from
// `status`: it lets the dispatch genuinely settle via a terminal event
// first (so `settleFromTerminalEvent()` has already flipped `settled`
// and already sent one real SIGTERM to the child), and only then calls
// `handle.abort()`. Without the guard, abort() would unconditionally
// call killWithEscalation() again — a second, distinguishable SIGTERM.
// The fixture's `--sigterm-log` counts real signal deliveries, so this
// observes the actual OS-level effect of the guard, not just the
// resulting status field (which — honestly — is "completed" here, not
// "aborted": abort() arriving after the verdict has already resolved
// is a no-op by design, it cannot retroactively change a settled
// Promise. That "abort while genuinely still running returns aborted"
// behaviour is unchanged and already covered by the unrelated "abort
// returns an aborted verdict" test above, which uses --hang and never triggers a
// terminal event at all).
test("calling abort() after the terminal event has already settled: the settled mutual-exclusion gate must block a second SIGTERM", async () => {
  const { dir, file } = tmpTask();
  const logDir = mkdtempSync(join(tmpdir(), "pi-sigterm-"));
  const sigtermLog = join(logDir, "sigterm.log");
  const { handle, done } = await dispatch({
    taskFile: file, cwd: dir, config: CONFIG, piDefaults: NO_PI_DEFAULTS, timeoutS: 15,
    sessionId: "s8",
    piCommand: [...FAKE_PI, "--stay-alive", `--sigterm-log=${sigtermLog}`],
    gitDiffStat: "",
  });

  // The terminal event lets settleFromTerminalEvent() run to completion here: settled
  // flips true, the verdict settles, and the first SIGTERM goes out. Because the child
  // process registered a --sigterm-log handler, it doesn't actually die from this first
  // SIGTERM, and stays alive for us to inspect.
  const verdict = await done;
  assert.equal(verdict.status, "completed");

  // settled is already true at this point. Without the mutual-exclusion gate, this
  // would send another SIGTERM.
  await handle.abort();

  // Wait past dispatch.mjs's internal SIGKILL grace period (2000ms), so that any effect
  // from "a second killWithEscalation() scheduling its own graceTimer" gets a chance to
  // actually happen and be recorded by --sigterm-log, while also letting the child
  // process get closed out by SIGKILL rather than left as a zombie.
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const received = readFileSync(sigtermLog, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(
    received.length,
    1,
    `expected exactly 1 SIGTERM (settled guard should block abort()'s), got ${received.length}: ${JSON.stringify(received)}`,
  );
});

test("when the child ignores SIGTERM, a timeout still ends it via SIGKILL escalation and returns timeout", async () => {
  const { dir, file } = tmpTask();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, config: CONFIG, piDefaults: NO_PI_DEFAULTS, timeoutS: 1,
    sessionId: "s6", piCommand: [...FAKE_PI, "--ignore-sigterm"], gitDiffStat: "",
  });
  const verdict = await done;
  assert.equal(verdict.status, "timeout");
});

// --- [I1] when gitDiffStat gets evaluated ---

test("when gitDiffStat is a thunk, it is evaluated at settle time (not at spawn time)", async () => {
  const { dir, file } = tmpTask();
  let stat = "at spawn time (a clean working tree)";
  const { done } = await dispatch({
    taskFile: file, cwd: dir, config: CONFIG, piDefaults: NO_PI_DEFAULTS, timeoutS: 1,
    sessionId: "g1", piCommand: [...FAKE_PI, "--hang"],
    gitDiffStat: () => stat,
  });
  // dispatch() has already returned and pi is still running — only now does the working tree get touched
  stat = "1 file changed, 3 insertions(+)";
  const verdict = await done;
  assert.equal(verdict.status, "timeout");
  assert.equal(
    verdict.git_diff_stat,
    "1 file changed, 3 insertions(+)",
    "a timeout verdict must reflect what pi actually wrote, not a pre-dispatch snapshot",
  );
});

test("when gitDiffStat is given a plain string, it is carried into the verdict unchanged", async () => {
  const { dir, file } = tmpTask();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, config: CONFIG, piDefaults: NO_PI_DEFAULTS, timeoutS: 10,
    sessionId: "g2", piCommand: FAKE_PI, gitDiffStat: "2 files changed",
  });
  assert.equal((await done).git_diff_stat, "2 files changed");
});

// --- [I2] a terminal failure reported by pi must close things out immediately, not run out the timeout ---

test("response success:false (inference server down) settles as failed at once and carries the error string", async () => {
  const { dir, file } = tmpTask();
  const timeoutS = 20;
  const startedAt = Date.now();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, config: CONFIG, piDefaults: NO_PI_DEFAULTS, timeoutS,
    sessionId: "f1", piCommand: [...FAKE_PI, "--api-error"], gitDiffStat: "",
  });
  const verdict = await done;
  const elapsedS = (Date.now() - startedAt) / 1000;
  assert.equal(verdict.status, "failed");
  assert.match(verdict.failure, /ECONNREFUSED/);
  assert.ok(
    elapsedS < timeoutS / 4,
    `expected to settle within seconds rather than the full ${timeoutS}s timeout, measured ${elapsedS}s`,
  );
});

// --- [I3] spec §11: a spawn failure must report status: failed with stderr attached ---

test("when pi is not on PATH, the verdict is failed and still carries a stderr clue", async () => {
  const { dir, file } = tmpTask();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, config: CONFIG, piDefaults: NO_PI_DEFAULTS, timeoutS: 10,
    sessionId: "e1", piCommand: ["pi-definitely-not-on-path"], gitDiffStat: "",
  });
  const verdict = await done;
  assert.equal(verdict.status, "failed");
  assert.match(verdict.stderr, /ENOENT/);
  assert.match(formatVerdict(verdict), /stderr:/);
  assert.match(formatVerdict(verdict), /ENOENT/);
});

// --- [I6] the settled mutual-exclusion gate must also hold on the timeout path ---

test("when the terminal event arrives after the timeout, a second SIGTERM is not sent", async () => {
  const { dir, file } = tmpTask();
  const logDir = mkdtempSync(join(tmpdir(), "pi-sigterm-late-"));
  const sigtermLog = join(logDir, "sigterm.log");

  // The timeout fires at 1s (SIGTERM #1, swallowed by the child process); agent_end
  // doesn't arrive until 1.5s. Without the gate, that late event would call
  // killWithEscalation() again → SIGTERM #2.
  const { done } = await dispatch({
    taskFile: file, cwd: dir, config: CONFIG, piDefaults: NO_PI_DEFAULTS, timeoutS: 1,
    sessionId: "t1",
    piCommand: [...FAKE_PI, "--ignore-sigterm", "--late-agent-end=1500", `--sigterm-log=${sigtermLog}`],
    gitDiffStat: "",
  });

  const verdict = await done;
  assert.equal(verdict.status, "timeout");

  await new Promise((resolve) => setTimeout(resolve, 1000));

  const received = readFileSync(sigtermLog, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(
    received.length,
    1,
    `expected exactly 1 SIGTERM (the timeout path must also flip settled), got ${received.length}`,
  );
});

// --- [C3] the fake and the implementation agree on the same real shape (the fixture has also switched to message.usage) ---

test("the verdict's tokens are computed from message.usage in the event stream, not 0/0", async () => {
  const { dir, file } = tmpTask();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, config: CONFIG, piDefaults: NO_PI_DEFAULTS, timeoutS: 10,
    sessionId: "u1", piCommand: FAKE_PI, gitDiffStat: "",
  });
  assert.deepEqual((await done).tokens, { input: 10, output: 5 });
});

// --- [I2, corrected] a real-shaped API failure must close out within seconds and be judged failed ---

test("a wrong model id (stopReason=error) is judged failed, not a false 0-second completed", async () => {
  const { dir, file } = tmpTask();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, config: CONFIG, piDefaults: NO_PI_DEFAULTS, timeoutS: 20,
    sessionId: "m1", piCommand: [...FAKE_PI, "--model-error"], gitDiffStat: "",
  });
  const verdict = await done;
  assert.equal(verdict.status, "failed");
  assert.match(verdict.failure, /404 Model 'nope' not found/);
});

test("an agent_end carrying willRetry:true does not settle; it waits for the terminal event after pi retries", async () => {
  const { dir, file } = tmpTask();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, config: CONFIG, piDefaults: NO_PI_DEFAULTS, timeoutS: 20,
    sessionId: "r1", piCommand: [...FAKE_PI, "--retry-then-end"], gitDiffStat: "",
  });
  const verdict = await done;
  assert.equal(verdict.status, "completed");
  assert.equal(verdict.last_message, "Succeeded after retry");
});
