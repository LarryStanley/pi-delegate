import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "../src/registry.mjs";
import { createToolHandlers, TOOL_DEFINITIONS } from "../src/server.mjs";
import { DEFAULTS } from "../src/config.mjs";

// Tests supply their own config and piDefaults: results must not depend on whatever
// ~/.claude/pi-delegate/config.json or ~/.pi/agent/settings.json happens to exist on this
// machine.
const CONFIG = { ...DEFAULTS, drafter_patterns: [...DEFAULTS.drafter_patterns] };
const NO_PI_DEFAULTS = { provider: null, model: null };

function tmpFile(name) {
  return join(mkdtempSync(join(tmpdir(), "pi-srv-")), name);
}

function setup(dispatchFn, config = CONFIG, piDefaults = NO_PI_DEFAULTS) {
  const eventsLogPath = tmpFile("events.log");
  return {
    eventsLogPath,
    handlers: createToolHandlers({
      registry: createRegistry(),
      dispatchFn,
      eventsLogPath,
      gitDiffStatFn: () => "1 file changed",
      config,
      piDefaults,
    }),
  };
}

const okVerdict = {
  status: "completed", write_count: 1, files_written: ["a.ts"],
  files_read_unrequested: [], git_diff_stat: "1 file changed", duration_s: 3,
  tokens: { input: 1, output: 2 }, session_id: "s1", last_message: "done",
  last_message_truncated: false,
};

function fakeDispatch(verdict = okVerdict) {
  return async ({ sessionId }) => ({
    handle: { sessionId, steer() {}, async abort() {}, state: () => ({ running: false }) },
    done: Promise.resolve({ ...verdict, session_id: sessionId }),
  });
}

test("tool descriptions are not welded to any one machine provider or model id", () => {
  const blob = JSON.stringify(TOOL_DEFINITIONS);
  for (const hardcoded of ["omlx", "Qwen", "gemma", "DFlash"]) {
    assert.ok(!blob.includes(hardcoded), `tool definitions should not mention ${hardcoded}`);
  }
});

test("every tunable pi_dispatch flag is an optional parameter whose description carries the measured rationale", () => {
  const dispatchTool = TOOL_DEFINITIONS.find((t) => t.name === "pi_dispatch");
  const props = dispatchTool.inputSchema.properties;
  for (const key of ["model", "provider", "thinking", "tools", "no_context_files", "append_system_prompt", "timeout_s"]) {
    assert.ok(props[key], `missing parameter ${key}`);
  }
  assert.deepEqual(dispatchTool.inputSchema.required, ["task_file", "cwd"]);
  // The caller has to know the defaults were measured to override them deliberately
  assert.match(props.tools.description, /bash/);
  assert.match(props.thinking.description, /off/);
  assert.match(props.no_context_files.description, /\d+/);
});

test("TOOL_DEFINITIONS defines all seven tools", () => {
  const names = TOOL_DEFINITIONS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "pi_abort", "pi_dispatch", "pi_result", "pi_stats",
    "pi_status", "pi_steer", "pi_transcript",
  ]);
});

test("every tool has a non-empty description and an inputSchema", () => {
  for (const tool of TOOL_DEFINITIONS) {
    assert.ok(tool.description?.length > 10, `${tool.name} description is too short`);
    assert.equal(tool.inputSchema.type, "object");
  }
});

test("a sync dispatch returns a formatted verdict, not raw JSON", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const { handlers } = setup(fakeDispatch());
  const result = await handlers.pi_dispatch({ task_file: task, cwd: "/tmp", mode: "sync" });
  assert.ok(result.content[0].text.includes("status:"));
  assert.ok(!result.content[0].text.trimStart().startsWith("{"));
});

test("an async dispatch returns a session_id immediately", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const { handlers } = setup(fakeDispatch());
  const result = await handlers.pi_dispatch({ task_file: task, cwd: "/tmp", mode: "async" });
  assert.match(result.content[0].text, /session_id/);
});

test("an async dispatch writes one line to events.log once it finishes", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const { handlers, eventsLogPath } = setup(fakeDispatch());
  await handlers.pi_dispatch({ task_file: task, cwd: "/tmp", mode: "async" });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(eventsLogPath));
  assert.match(readFileSync(eventsLogPath, "utf8"), /completed/);
});

test("dispatching to a drafter model is rejected and never calls dispatch", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  let called = false;
  const { handlers } = setup(async (...a) => {
    called = true;
    return fakeDispatch()(...a);
  });
  const result = await handlers.pi_dispatch({
    task_file: task, cwd: "/tmp", mode: "sync", model: "whatever-DFlash-draft",
  });
  assert.equal(result.isError, true);
  assert.equal(called, false);
});

// The co-pilot guard keys off patterns in the config, not one machine model id
test("clearing drafter_patterns lets the same model be dispatched to", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const { handlers } = setup(fakeDispatch(), { ...CONFIG, drafter_patterns: [] });
  const result = await handlers.pi_dispatch({
    task_file: task, cwd: "/tmp", mode: "sync", model: "whatever-DFlash-draft",
  });
  assert.equal(result.isError, undefined);
});

// --- provider-agnostic: dispatching must work with nothing configured ---
//
// This is the heart of the whole change: the user installs the plugin, configures nothing,
// and pi_dispatch uses their own default pi model. What dispatch() receives for provider /
// model should be undefined (i.e. emit no flag), not some model id the plugin invented.
test("with no config and no arguments pi_dispatch still dispatches, specifying neither provider nor model", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const seen = [];
  const { handlers } = setup(async (args) => {
    seen.push(args);
    return fakeDispatch()(args);
  }, DEFAULTS, NO_PI_DEFAULTS);
  const result = await handlers.pi_dispatch({ task_file: task, cwd: "/tmp", mode: "sync" });
  assert.equal(result.isError, undefined);
  assert.equal(seen[0].provider, undefined);
  assert.equal(seen[0].model, undefined);
});

test("pi_dispatch passes its provider / model / timeout_s arguments through to dispatch", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const seen = [];
  const { handlers } = setup(async (args) => {
    seen.push(args);
    return fakeDispatch()(args);
  });
  await handlers.pi_dispatch({
    task_file: task, cwd: "/tmp", mode: "sync",
    provider: "anthropic", model: "claude-sonnet-4-6", timeout_s: 7,
  });
  assert.equal(seen[0].provider, "anthropic");
  assert.equal(seen[0].model, "claude-sonnet-4-6");
  assert.equal(seen[0].timeoutS, 7);
});

// A schema that accepts an override the handler then quietly drops is the failure shape
// this codebase has hit five times.
test("thinking / tools / no_context_files / append_system_prompt overrides really reach dispatch", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const seen = [];
  const { handlers } = setup(async (args) => {
    seen.push(args);
    return fakeDispatch()(args);
  });
  await handlers.pi_dispatch({
    task_file: task, cwd: "/tmp", mode: "sync",
    thinking: "high", tools: "read,write,edit,bash",
    no_context_files: false, append_system_prompt: "only touch the files named in the task book",
  });
  assert.equal(seen[0].thinking, "high");
  assert.equal(seen[0].tools, "read,write,edit,bash");
  assert.equal(seen[0].noContextFiles, false);
  assert.equal(seen[0].appendSystemPrompt, "only touch the files named in the task book");
});

test("the config timeout_s applies when none is specified", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const seen = [];
  const { handlers } = setup(async (args) => {
    seen.push(args);
    return fakeDispatch()(args);
  }, { ...CONFIG, timeout_s: 42 });
  await handlers.pi_dispatch({ task_file: task, cwd: "/tmp", mode: "sync" });
  assert.equal(seen[0].timeoutS, 42);
});

test("a missing task book returns an error and never calls dispatch", async () => {
  let called = false;
  const { handlers } = setup(async (...a) => {
    called = true;
    return fakeDispatch()(...a);
  });
  const result = await handlers.pi_dispatch({ task_file: "/nope/TASK.md", cwd: "/tmp", mode: "sync" });
  assert.equal(result.isError, true);
  assert.equal(called, false);
});

test("an unknown session_id returns an error listing the valid ids", async () => {
  const { handlers } = setup(fakeDispatch());
  const result = await handlers.pi_result({ session_id: "ghost" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ghost/);
});

test("pi_result retrieves the verdict of an async dispatch", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const { handlers } = setup(fakeDispatch());
  const started = await handlers.pi_dispatch({ task_file: task, cwd: "/tmp", mode: "async" });
  const sessionId = started.content[0].text.match(/session_id:\s*(\S+)/)[1];
  await new Promise((r) => setTimeout(r, 50));
  const result = await handlers.pi_result({ session_id: sessionId });
  assert.match(result.content[0].text, /status:\s+completed/);
});

test("pi_result returns a failed verdict rather than throwing when done rejects", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  // rejects on a later tick so the registry's `verdict` field is still null
  // when pi_result is called — forces pi_result to await entry.done itself
  // instead of short-circuiting on an already-stored verdict.
  const dispatchFn = async ({ sessionId }) => ({
    handle: { sessionId, steer() {}, async abort() {}, state: () => ({ running: true }) },
    done: new Promise((_, reject) => setTimeout(() => reject(new Error("boom")), 20)),
  });
  const { handlers } = setup(dispatchFn);
  const started = await handlers.pi_dispatch({ task_file: task, cwd: "/tmp", mode: "async" });
  const sessionId = started.content[0].text.match(/session_id:\s*(\S+)/)[1];
  const result = await handlers.pi_result({ session_id: sessionId });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /status:\s+failed/);
});

// --- fix round 1: coverage for pi_status / pi_steer / pi_abort / pi_transcript / pi_stats ---

function buildTranscriptEvents() {
  return [
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "ignored" }] } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first" }] } },
    { type: "tool_execution_start", toolCallId: "t1", toolName: "write", args: { path: "a.ts" } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "second" }] } },
  ];
}

function fakeDispatchWithEvents(events) {
  return async ({ sessionId }) => ({
    handle: {
      sessionId, steer() {}, async abort() {}, state: () => ({ running: false }),
      events,
    },
    done: Promise.resolve({ ...okVerdict, session_id: sessionId }),
  });
}

async function dispatchAndGetSessionId(handlers, task, mode = "async") {
  const started = await handlers.pi_dispatch({ task_file: task, cwd: "/tmp", mode });
  return started.content[0].text.match(/session_id:\s*(\S+)/)[1];
}

// [I8] field names aligned with spec §5: {status, elapsed_s, current_tool, files_touched}
test("pi_status returns the four spec §5 fields for a completed dispatch", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const { handlers } = setup(fakeDispatch());
  const sessionId = await dispatchAndGetSessionId(handlers, task, "sync");
  const status = await handlers.pi_status({ session_id: sessionId });
  const parsed = JSON.parse(status.content[0].text);
  assert.deepEqual(Object.keys(parsed).sort(), ["current_tool", "elapsed_s", "status", "writes"]);
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.elapsed_s, 3);
  assert.equal(parsed.current_tool, null);
  assert.equal(parsed.writes, 1);

  // The path list is behind verbose for the finished case too — the compact reply is what
  // gets polled, and a finished dispatch's paths are already in its verdict.
  const verbose = JSON.parse((await handlers.pi_status({ session_id: sessionId, verbose: true })).content[0].text);
  assert.deepEqual(verbose.files_touched, ["a.ts"]);
});

test("pi_status returns running / the tool in progress / files already written for a dispatch still running", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const events = [
    { type: "tool_execution_start", toolCallId: "t1", toolName: "write", args: { path: "a.ts" } },
    { type: "tool_execution_end", toolCallId: "t1", toolName: "write", result: {}, isError: false },
    { type: "tool_execution_start", toolCallId: "t2", toolName: "edit", args: { path: "b.ts" } },
  ];
  const dispatchFn = async ({ sessionId }) => ({
    handle: {
      sessionId, steer() {}, async abort() {},
      state: () => ({ running: true, elapsed_s: 7 }),
      events,
    },
    done: new Promise(() => {}), // never settles: still running
  });
  const { handlers } = setup(dispatchFn);
  const sessionId = await dispatchAndGetSessionId(handlers, task);
  const parsed = JSON.parse((await handlers.pi_status({ session_id: sessionId })).content[0].text);
  // Compact by default: counts, not lists. pi_status is meant to be polled, and every
  // reply stays in the caller's context for the rest of the session.
  assert.deepEqual(parsed, {
    status: "running",
    elapsed_s: 7,
    remaining_s: parsed.remaining_s,
    current_tool: "edit",
    writes: 2,
    distinct_files: 2,
    reads: 0,
    tokens: { input: 0, output: 0 },
  });

  const verbose = JSON.parse((await handlers.pi_status({ session_id: sessionId, verbose: true })).content[0].text);
  assert.deepEqual(verbose.files_touched, ["a.ts", "b.ts"]);
});

test("pi_status returns an error listing the valid id for an unknown session_id", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const { handlers } = setup(fakeDispatch());
  const knownId = await dispatchAndGetSessionId(handlers, task, "sync");
  const result = await handlers.pi_status({ session_id: "ghost" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ghost/);
  assert.ok(result.content[0].text.includes(knownId), "should list a valid session id");
});

test("pi_steer sends the message into handle.steer", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const steerCalls = [];
  const dispatchFn = async ({ sessionId }) => ({
    handle: {
      sessionId,
      steer(msg) { steerCalls.push(msg); },
      async abort() {},
      state: () => ({ running: true }),
    },
    done: Promise.resolve({ ...okVerdict, session_id: sessionId }),
  });
  const { handlers } = setup(dispatchFn);
  const sessionId = await dispatchAndGetSessionId(handlers, task);
  const result = await handlers.pi_steer({ session_id: sessionId, message: "switch to async/await" });
  assert.deepEqual(steerCalls, ["switch to async/await"]);
  assert.match(result.content[0].text, /Sent:/);
});

test("pi_steer returns an error for an unknown session_id", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const { handlers } = setup(fakeDispatch());
  const knownId = await dispatchAndGetSessionId(handlers, task, "sync");
  const result = await handlers.pi_steer({ session_id: "ghost", message: "hi" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ghost/);
  assert.ok(result.content[0].text.includes(knownId), "should list a valid session id");
});

test("pi_abort calls handle.abort", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  let abortCalled = 0;
  const dispatchFn = async ({ sessionId }) => ({
    handle: {
      sessionId,
      steer() {},
      async abort() { abortCalled += 1; },
      state: () => ({ running: true }),
    },
    done: Promise.resolve({ ...okVerdict, session_id: sessionId }),
  });
  const { handlers } = setup(dispatchFn);
  const sessionId = await dispatchAndGetSessionId(handlers, task);
  const result = await handlers.pi_abort({ session_id: sessionId });
  assert.equal(abortCalled, 1);
  assert.match(result.content[0].text, /Aborted /);
});

test("pi_abort returns an error for an unknown session_id", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const { handlers } = setup(fakeDispatch());
  const knownId = await dispatchAndGetSessionId(handlers, task, "sync");
  const result = await handlers.pi_abort({ session_id: "ghost" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ghost/);
  assert.ok(result.content[0].text.includes(knownId), "should list a valid session id");
});

test("pi_transcript filter=text returns only the assistant's text", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const { handlers } = setup(fakeDispatchWithEvents(buildTranscriptEvents()));
  const sessionId = await dispatchAndGetSessionId(handlers, task);
  const result = await handlers.pi_transcript({ session_id: sessionId, filter: "text" });
  assert.equal(result.content[0].text, "first\n---\nsecond");
});

test("pi_transcript filter=tools returns only tool calls", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const { handlers } = setup(fakeDispatchWithEvents(buildTranscriptEvents()));
  const sessionId = await dispatchAndGetSessionId(handlers, task);
  const result = await handlers.pi_transcript({ session_id: sessionId, filter: "tools" });
  assert.equal(result.content[0].text, 'write {"path":"a.ts"}');
});

test("pi_transcript filter=last_n returns the last n events", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const events = buildTranscriptEvents();
  const { handlers } = setup(fakeDispatchWithEvents(events));
  const sessionId = await dispatchAndGetSessionId(handlers, task);
  const result = await handlers.pi_transcript({ session_id: sessionId, filter: "last_n", n: 2 });
  const lines = result.content[0].text.split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), events[2]);
  assert.deepEqual(JSON.parse(lines[1]), events[3]);
});

test("pi_transcript falls back to an empty array when handle has no events", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const { handlers } = setup(fakeDispatch());
  const sessionId = await dispatchAndGetSessionId(handlers, task);
  const result = await handlers.pi_transcript({ session_id: sessionId, filter: "text" });
  assert.equal(result.content[0].text, "(no text output)");
});

test("pi_transcript returns an error for an unknown session_id", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const { handlers } = setup(fakeDispatch());
  const knownId = await dispatchAndGetSessionId(handlers, task, "sync");
  const result = await handlers.pi_transcript({ session_id: "ghost" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ghost/);
  assert.ok(result.content[0].text.includes(knownId), "should list a valid session id");
});

test("pi_stats returns the token usage and duration of a completed dispatch", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const { handlers } = setup(fakeDispatch());
  const sessionId = await dispatchAndGetSessionId(handlers, task, "sync");
  const stats = await handlers.pi_stats({ session_id: sessionId });
  const parsed = JSON.parse(stats.content[0].text);
  assert.deepEqual(parsed.tokens, { input: 1, output: 2 });
  assert.equal(parsed.duration_s, 3);
});

test("pi_stats returns running for a dispatch still in progress", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const dispatchFn = async ({ sessionId }) => ({
    handle: { sessionId, steer() {}, async abort() {}, state: () => ({ running: true }) },
    done: new Promise(() => {}), // never settles: session is still running
  });
  const { handlers } = setup(dispatchFn);
  const sessionId = await dispatchAndGetSessionId(handlers, task);
  const stats = await handlers.pi_stats({ session_id: sessionId });
  assert.deepEqual(JSON.parse(stats.content[0].text), { running: true });
});

test("pi_stats returns an error for an unknown session_id", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const { handlers } = setup(fakeDispatch());
  const knownId = await dispatchAndGetSessionId(handlers, task, "sync");
  const result = await handlers.pi_stats({ session_id: "ghost" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ghost/);
  assert.ok(result.content[0].text.includes(knownId), "should list a valid session id");
});

// --- [I1] when git_diff_stat gets evaluated ---

test("git_diff_stat is evaluated when the dispatch finishes, not before it starts", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");

  let tree = "(a clean working tree)";
  let calls = 0;
  let callsWhenDispatchStarted = null;

  const gitDiffStatFn = () => {
    calls += 1;
    return tree;
  };

  const dispatchFn = async ({ sessionId, gitDiffStat }) => {
    callsWhenDispatchStarted = calls;
    return {
      handle: { sessionId, steer() {}, async abort() {}, state: () => ({ running: false }) },
      done: (async () => {
        // pi touches the working tree during this stretch
        tree = "1 file changed, 3 insertions(+)";
        return {
          ...okVerdict,
          session_id: sessionId,
          git_diff_stat: typeof gitDiffStat === "function" ? gitDiffStat() : gitDiffStat,
        };
      })(),
    };
  };

  const handlers = createToolHandlers({
    registry: createRegistry(),
    dispatchFn,
    eventsLogPath: tmpFile("events.log"),
    gitDiffStatFn,
    config: CONFIG,
    piDefaults: NO_PI_DEFAULTS,
  });

  const result = await handlers.pi_dispatch({ task_file: task, cwd: "/tmp", mode: "sync" });

  assert.equal(callsWhenDispatchStarted, 0, "git diff should not have been measured before the dispatch started");
  assert.match(result.content[0].text, /git_diff_stat:\s+1 file changed, 3 insertions\(\+\)/);
});

// --- [I7] the transcript and the verdict share the same assistant-text parser ---

test("pi_transcript filter=text also accepts string-shaped content (no longer goes missing from the transcript)", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const events = [
    { type: "message_end", message: { role: "assistant", content: "a string-shaped reply" } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "an array-shaped reply" }] } },
    { type: "message_end", message: { role: "user", content: "what the user said does not count" } },
  ];
  const { handlers } = setup(fakeDispatchWithEvents(events));
  const sessionId = await dispatchAndGetSessionId(handlers, task);
  const result = await handlers.pi_transcript({ session_id: sessionId, filter: "text" });
  assert.equal(result.content[0].text, "a string-shaped reply\n---\nan array-shaped reply");
});

// --- [I7] there is exactly one error message for an unknown session_id ---

// Renamed from "...the same single sentence...": the reply is deliberately no longer a
// single sentence. issues/1 reported that "Currently valid: (none)" reads like a bug in the
// caller, when the real situation is usually that /reload-plugins emptied an in-memory
// registry while pi carried on working. What this test is actually for — that both tools
// answer identically — is unchanged and still asserted.
test("pi_result and pi_status answer an unknown session_id identically, and explain the restart case", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  const { handlers } = setup(fakeDispatch());
  await dispatchAndGetSessionId(handlers, task, "sync");
  const fromResult = await handlers.pi_result({ session_id: "ghost" });
  const fromStatus = await handlers.pi_status({ session_id: "ghost" });
  assert.equal(fromResult.isError, true);
  assert.equal(fromResult.content[0].text, fromStatus.content[0].text);
  assert.match(fromResult.content[0].text, /Sessions known to this server:/);
  assert.match(fromResult.content[0].text, /reload-plugins/);
});

// --- registry.add must happen before spawn, or a colliding id leaves an orphaned pi process ---

test("a colliding session_id never spawns the child process first", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "Modify a.ts");
  let spawned = 0;
  const registry = createRegistry();
  const handlers = createToolHandlers({
    registry: {
      ...registry,
      add() { throw new Error('session_id "x" already exists'); },
    },
    dispatchFn: async (...a) => {
      spawned += 1;
      return fakeDispatch()(...a);
    },
    eventsLogPath: tmpFile("events.log"),
    gitDiffStatFn: () => "",
    config: CONFIG,
    piDefaults: NO_PI_DEFAULTS,
  });

  await assert.rejects(
    () => handlers.pi_dispatch({ task_file: task, cwd: "/tmp", mode: "sync" }),
    /already exists/,
  );
  assert.equal(spawned, 0, "a failed registry.add should never already have spawned a pi child process");
});

// --- The handle window between registry.add and the spawn ---
//
// pi_dispatch calls `registry.add({handle: null, …})` first and only then
// `await dispatchFn(...)`. That await hands control back to the event loop, so
// "session registered, handle still null" is a REAL window (the old comment claimed there
// was no await in between and no other tool could get in — that was wrong).
// Inside that window pi_steer / pi_abort / pi_transcript used to call
// `entry.handle.steer(...)` directly and throw
// TypeError: Cannot read properties of null, leaving the user with a clueless exception.
test("while the spawn is pending, pi_steer / pi_abort / pi_transcript return a readable error rather than a TypeError", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "edit a.ts");

  let releaseSpawn;
  const spawnGate = new Promise((resolve) => {
    releaseSpawn = resolve;
  });
  const dispatchFn = async ({ sessionId }) => {
    await spawnGate;
    return {
      handle: { sessionId, steer() {}, async abort() {}, state: () => ({ running: true }), events: [] },
      done: new Promise(() => {}),
    };
  };

  // Capture the generated session id straight off registry.add, so this test does not
  // depend on the wording of any user-facing message.
  const registry = createRegistry();
  let sessionId = null;
  const handlers = createToolHandlers({
    registry: {
      ...registry,
      add(id, entry) {
        sessionId = id;
        return registry.add(id, entry);
      },
    },
    dispatchFn,
    eventsLogPath: tmpFile("events.log"),
    gitDiffStatFn: () => "",
    config: CONFIG,
    piDefaults: NO_PI_DEFAULTS,
  });

  const pending = handlers.pi_dispatch({ task_file: task, cwd: "/tmp", mode: "async" });
  // dispatchFn is parked on spawnGate: the registry entry exists but handle is still null.
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(sessionId, "registry.add should have run before the spawn");

  for (const tool of ["pi_steer", "pi_abort", "pi_transcript"]) {
    const result = await handlers[tool]({ session_id: sessionId, message: "nudge left" });
    assert.equal(result.isError, true, `${tool} should report an error`);
    assert.match(result.content[0].text, /still starting up/, `${tool} should explain why`);
    assert.ok(!result.content[0].text.includes("Cannot read properties"), `${tool} must not throw a TypeError`);
  }

  releaseSpawn();
  await pending;
});
