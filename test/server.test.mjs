import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "../src/registry.mjs";
import { createToolHandlers, TOOL_DEFINITIONS } from "../src/server.mjs";
import { DEFAULTS } from "../src/config.mjs";

// 測試自己帶 config 與 piDefaults：結果不該取決於這台機器上剛好存在的
// ~/.claude/pi-delegate/config.json 或 ~/.pi/agent/settings.json。
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

test("tool 說明不綁死任何一台機器的 provider / 模型 id", () => {
  const blob = JSON.stringify(TOOL_DEFINITIONS);
  for (const hardcoded of ["omlx", "Qwen", "gemma", "DFlash"]) {
    assert.ok(!blob.includes(hardcoded), `tool 定義不該提到 ${hardcoded}`);
  }
});

test("pi_dispatch 的可調旗標都是選填參數，而且說明帶著實測理由", () => {
  const dispatchTool = TOOL_DEFINITIONS.find((t) => t.name === "pi_dispatch");
  const props = dispatchTool.inputSchema.properties;
  for (const key of ["model", "provider", "thinking", "tools", "no_context_files", "append_system_prompt", "timeout_s"]) {
    assert.ok(props[key], `缺少參數 ${key}`);
  }
  assert.deepEqual(dispatchTool.inputSchema.required, ["task_file", "cwd"]);
  // 呼叫端要知道「預設值是量出來的」才會刻意而非順手地覆寫
  assert.match(props.tools.description, /bash/);
  assert.match(props.thinking.description, /off/);
  assert.match(props.no_context_files.description, /\d+/);
});

test("TOOL_DEFINITIONS 定義了全部七個 tool", () => {
  const names = TOOL_DEFINITIONS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "pi_abort", "pi_dispatch", "pi_result", "pi_stats",
    "pi_status", "pi_steer", "pi_transcript",
  ]);
});

test("每個 tool 都有非空 description 與 inputSchema", () => {
  for (const tool of TOOL_DEFINITIONS) {
    assert.ok(tool.description?.length > 10, `${tool.name} description 太短`);
    assert.equal(tool.inputSchema.type, "object");
  }
});

test("sync 派工回傳格式化判決而非原始 JSON", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const { handlers } = setup(fakeDispatch());
  const result = await handlers.pi_dispatch({ task_file: task, cwd: "/tmp", mode: "sync" });
  assert.ok(result.content[0].text.includes("status:"));
  assert.ok(!result.content[0].text.trimStart().startsWith("{"));
});

test("async 派工立刻回 session_id", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const { handlers } = setup(fakeDispatch());
  const result = await handlers.pi_dispatch({ task_file: task, cwd: "/tmp", mode: "async" });
  assert.match(result.content[0].text, /session_id/);
});

test("async 完成後寫一行到 events.log", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const { handlers, eventsLogPath } = setup(fakeDispatch());
  await handlers.pi_dispatch({ task_file: task, cwd: "/tmp", mode: "async" });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(eventsLogPath));
  assert.match(readFileSync(eventsLogPath, "utf8"), /completed/);
});

test("派工給 drafter 模型會被拒絕且不呼叫 dispatch", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
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

// drafter 守門的判準是 config 裡的 pattern，不是某一台機器上的模型 id
test("drafter_patterns 清空後同一個 model 就派得出去", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const { handlers } = setup(fakeDispatch(), { ...CONFIG, drafter_patterns: [] });
  const result = await handlers.pi_dispatch({
    task_file: task, cwd: "/tmp", mode: "sync", model: "whatever-DFlash-draft",
  });
  assert.equal(result.isError, undefined);
});

// --- provider-agnostic：什麼都不設定也要能派工 ---
//
// 這是整輪改動的核心：使用者裝好外掛、什麼都不設定，pi_dispatch 就用他自己的 pi
// 預設模型。dispatch() 收到的 provider / model 應該是 undefined（＝不帶旗標），
// 而不是外掛自己發明的某個模型 id。
test("沒有 config、沒有參數時 pi_dispatch 照樣派得出去，且不指定 provider / model", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
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

test("pi_dispatch 的 provider / model / timeout_s 參數會傳給 dispatch", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
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

// schema 收了一個覆寫、handler 卻默默丟掉，正是這個 codebase 踩過五次的失敗形狀。
test("thinking / tools / no_context_files / append_system_prompt 覆寫真的傳得到 dispatch", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const seen = [];
  const { handlers } = setup(async (args) => {
    seen.push(args);
    return fakeDispatch()(args);
  });
  await handlers.pi_dispatch({
    task_file: task, cwd: "/tmp", mode: "sync",
    thinking: "high", tools: "read,write,edit,bash",
    no_context_files: false, append_system_prompt: "只准改指定的檔案",
  });
  assert.equal(seen[0].thinking, "high");
  assert.equal(seen[0].tools, "read,write,edit,bash");
  assert.equal(seen[0].noContextFiles, false);
  assert.equal(seen[0].appendSystemPrompt, "只准改指定的檔案");
});

test("config 的 timeout_s 在沒指定時生效", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const seen = [];
  const { handlers } = setup(async (args) => {
    seen.push(args);
    return fakeDispatch()(args);
  }, { ...CONFIG, timeout_s: 42 });
  await handlers.pi_dispatch({ task_file: task, cwd: "/tmp", mode: "sync" });
  assert.equal(seen[0].timeoutS, 42);
});

test("任務書不存在時回錯誤且不呼叫 dispatch", async () => {
  let called = false;
  const { handlers } = setup(async (...a) => {
    called = true;
    return fakeDispatch()(...a);
  });
  const result = await handlers.pi_dispatch({ task_file: "/nope/TASK.md", cwd: "/tmp", mode: "sync" });
  assert.equal(result.isError, true);
  assert.equal(called, false);
});

test("未知的 session_id 回錯誤並列出有效 id", async () => {
  const { handlers } = setup(fakeDispatch());
  const result = await handlers.pi_result({ session_id: "ghost" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ghost/);
});

test("pi_result 取回 async 派工的判決", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const { handlers } = setup(fakeDispatch());
  const started = await handlers.pi_dispatch({ task_file: task, cwd: "/tmp", mode: "async" });
  const sessionId = started.content[0].text.match(/session_id:\s*(\S+)/)[1];
  await new Promise((r) => setTimeout(r, 50));
  const result = await handlers.pi_result({ session_id: sessionId });
  assert.match(result.content[0].text, /status:\s+completed/);
});

test("pi_result 對 reject 的 done 回傳失敗判決而非拋出錯誤", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
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

// [I8] 欄位名對齊 spec §5：{status, elapsed_s, current_tool, files_touched}
test("pi_status 對已完成的派工回傳 spec §5 的四個欄位", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const { handlers } = setup(fakeDispatch());
  const sessionId = await dispatchAndGetSessionId(handlers, task, "sync");
  const status = await handlers.pi_status({ session_id: sessionId });
  const parsed = JSON.parse(status.content[0].text);
  assert.deepEqual(Object.keys(parsed).sort(), ["current_tool", "elapsed_s", "files_touched", "status"]);
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.elapsed_s, 3);
  assert.equal(parsed.current_tool, null);
  assert.deepEqual(parsed.files_touched, ["a.ts"]);
});

test("pi_status 對還在跑的派工回傳 running / 進行中的工具 / 已經寫過的檔", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
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
    done: new Promise(() => {}), // 永不 settle：還在跑
  });
  const { handlers } = setup(dispatchFn);
  const sessionId = await dispatchAndGetSessionId(handlers, task);
  const parsed = JSON.parse((await handlers.pi_status({ session_id: sessionId })).content[0].text);
  assert.deepEqual(parsed, {
    status: "running",
    elapsed_s: 7,
    current_tool: "edit",
    files_touched: ["a.ts", "b.ts"],
  });
});

test("pi_status 對未知 session_id 回錯誤並列出有效 id", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const { handlers } = setup(fakeDispatch());
  const knownId = await dispatchAndGetSessionId(handlers, task, "sync");
  const result = await handlers.pi_status({ session_id: "ghost" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ghost/);
  assert.ok(result.content[0].text.includes(knownId), "應列出有效的 session id");
});

test("pi_steer 把訊息送進 handle.steer", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
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
  const result = await handlers.pi_steer({ session_id: sessionId, message: "改用 async/await" });
  assert.deepEqual(steerCalls, ["改用 async/await"]);
  assert.match(result.content[0].text, /已送出/);
});

test("pi_steer 對未知 session_id 回錯誤", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const { handlers } = setup(fakeDispatch());
  const knownId = await dispatchAndGetSessionId(handlers, task, "sync");
  const result = await handlers.pi_steer({ session_id: "ghost", message: "hi" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ghost/);
  assert.ok(result.content[0].text.includes(knownId), "應列出有效的 session id");
});

test("pi_abort 呼叫 handle.abort", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
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
  assert.match(result.content[0].text, /已中止/);
});

test("pi_abort 對未知 session_id 回錯誤", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const { handlers } = setup(fakeDispatch());
  const knownId = await dispatchAndGetSessionId(handlers, task, "sync");
  const result = await handlers.pi_abort({ session_id: "ghost" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ghost/);
  assert.ok(result.content[0].text.includes(knownId), "應列出有效的 session id");
});

test("pi_transcript filter=text 只回傳 assistant 文字", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const { handlers } = setup(fakeDispatchWithEvents(buildTranscriptEvents()));
  const sessionId = await dispatchAndGetSessionId(handlers, task);
  const result = await handlers.pi_transcript({ session_id: sessionId, filter: "text" });
  assert.equal(result.content[0].text, "first\n---\nsecond");
});

test("pi_transcript filter=tools 只回傳工具呼叫", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const { handlers } = setup(fakeDispatchWithEvents(buildTranscriptEvents()));
  const sessionId = await dispatchAndGetSessionId(handlers, task);
  const result = await handlers.pi_transcript({ session_id: sessionId, filter: "tools" });
  assert.equal(result.content[0].text, 'write {"path":"a.ts"}');
});

test("pi_transcript filter=last_n 回傳最後 n 個事件", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const events = buildTranscriptEvents();
  const { handlers } = setup(fakeDispatchWithEvents(events));
  const sessionId = await dispatchAndGetSessionId(handlers, task);
  const result = await handlers.pi_transcript({ session_id: sessionId, filter: "last_n", n: 2 });
  const lines = result.content[0].text.split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), events[2]);
  assert.deepEqual(JSON.parse(lines[1]), events[3]);
});

test("pi_transcript 在 handle 沒有 events 時退回空陣列", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const { handlers } = setup(fakeDispatch());
  const sessionId = await dispatchAndGetSessionId(handlers, task);
  const result = await handlers.pi_transcript({ session_id: sessionId, filter: "text" });
  assert.equal(result.content[0].text, "(無文字輸出)");
});

test("pi_transcript 對未知 session_id 回錯誤", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const { handlers } = setup(fakeDispatch());
  const knownId = await dispatchAndGetSessionId(handlers, task, "sync");
  const result = await handlers.pi_transcript({ session_id: "ghost" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ghost/);
  assert.ok(result.content[0].text.includes(knownId), "應列出有效的 session id");
});

test("pi_stats 回傳已完成派工的 token 與耗時", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const { handlers } = setup(fakeDispatch());
  const sessionId = await dispatchAndGetSessionId(handlers, task, "sync");
  const stats = await handlers.pi_stats({ session_id: sessionId });
  const parsed = JSON.parse(stats.content[0].text);
  assert.deepEqual(parsed.tokens, { input: 1, output: 2 });
  assert.equal(parsed.duration_s, 3);
});

test("pi_stats 對還在跑的派工回傳 running", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const dispatchFn = async ({ sessionId }) => ({
    handle: { sessionId, steer() {}, async abort() {}, state: () => ({ running: true }) },
    done: new Promise(() => {}), // never settles: session is still running
  });
  const { handlers } = setup(dispatchFn);
  const sessionId = await dispatchAndGetSessionId(handlers, task);
  const stats = await handlers.pi_stats({ session_id: sessionId });
  assert.deepEqual(JSON.parse(stats.content[0].text), { running: true });
});

test("pi_stats 對未知 session_id 回錯誤", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const { handlers } = setup(fakeDispatch());
  const knownId = await dispatchAndGetSessionId(handlers, task, "sync");
  const result = await handlers.pi_stats({ session_id: "ghost" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ghost/);
  assert.ok(result.content[0].text.includes(knownId), "應列出有效的 session id");
});

// --- [I1] git_diff_stat 的求值時機 ---

test("git_diff_stat 在派工結束時才求值，不是在派工之前", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");

  let tree = "(乾淨的工作樹)";
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
        // pi 在這段期間動了工作樹
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

  assert.equal(callsWhenDispatchStarted, 0, "派工開始前不該已經量過 git diff");
  assert.match(result.content[0].text, /git_diff_stat:\s+1 file changed, 3 insertions\(\+\)/);
});

// --- [I7] 逐字稿與判決共用同一支 assistant 文字解析器 ---

test("pi_transcript filter=text 也吃字串型 content（不再從逐字稿消失）", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const events = [
    { type: "message_end", message: { role: "assistant", content: "字串型回答" } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "陣列型回答" }] } },
    { type: "message_end", message: { role: "user", content: "使用者說的不算" } },
  ];
  const { handlers } = setup(fakeDispatchWithEvents(events));
  const sessionId = await dispatchAndGetSessionId(handlers, task);
  const result = await handlers.pi_transcript({ session_id: sessionId, filter: "text" });
  assert.equal(result.content[0].text, "字串型回答\n---\n陣列型回答");
});

// --- [I7] 未知 session_id 的錯誤訊息只有一份 ---

test("pi_result 與 pi_status 對未知 session_id 給出同一句錯誤", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  const { handlers } = setup(fakeDispatch());
  await dispatchAndGetSessionId(handlers, task, "sync");
  const fromResult = await handlers.pi_result({ session_id: "ghost" });
  const fromStatus = await handlers.pi_status({ session_id: "ghost" });
  assert.equal(fromResult.isError, true);
  assert.equal(fromResult.content[0].text, fromStatus.content[0].text);
  assert.match(fromResult.content[0].text, /目前有效的：/);
});

// --- registry.add 要在 spawn 之前，否則撞號會留下孤兒 pi 行程 ---

test("session_id 撞號時不會先 spawn 子行程", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");
  let spawned = 0;
  const registry = createRegistry();
  const handlers = createToolHandlers({
    registry: {
      ...registry,
      add() { throw new Error('session_id "x" 已存在'); },
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
    /已存在/,
  );
  assert.equal(spawned, 0, "registry.add 失敗時不該已經 spawn 出 pi 子行程");
});

// --- registry.add 佔位到 spawn 之間的 handle 空窗 ---
//
// pi_dispatch 先 `registry.add({handle: null, …})` 再 `await dispatchFn(...)`。
// 那個 await 會把控制權交回 event loop，所以「session 已註冊、handle 還是 null」
// 是一段**真實存在**的窗口（舊註解宣稱「中間沒有 await，其他 tool 進不來」是錯的）。
// 在這個窗口裡，pi_steer / pi_abort / pi_transcript 以前會直接
// `entry.handle.steer(...)` 而拋 TypeError: Cannot read properties of null，
// 使用者拿到的是一句沒有線索的例外。
test("spawn 還沒完成時，pi_steer / pi_abort / pi_transcript 回可讀的錯誤而不是 TypeError", async () => {
  const task = tmpFile("TASK.md");
  writeFileSync(task, "改 a.ts");

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

  const { handlers } = setup(dispatchFn);
  const pending = handlers.pi_dispatch({ task_file: task, cwd: "/tmp", mode: "async" });
  // dispatchFn 卡在 spawnGate 上：這時 registry 裡已經有 entry，但 handle 還是 null。
  await new Promise((resolve) => setImmediate(resolve));

  const registryIds = [];
  for (const tool of ["pi_steer", "pi_abort", "pi_transcript"]) {
    // session id 是 pi_dispatch 內部產生的，這裡從錯誤訊息裡撈出唯一一個有效 id
    const ghost = await handlers[tool]({ session_id: "ghost", message: "x" });
    const id = ghost.content[0].text.match(/目前有效的：(\S+)/)[1];
    registryIds.push(id);
    const result = await handlers[tool]({ session_id: id, message: "往左一點" });
    assert.equal(result.isError, true, `${tool} 應回報錯誤`);
    assert.match(result.content[0].text, /啟動中/, `${tool} 的訊息要說明原因`);
    assert.ok(!result.content[0].text.includes("Cannot read properties"), `${tool} 不該拋 TypeError`);
  }
  assert.ok(registryIds.every((id) => id === registryIds[0]));

  releaseSpawn();
  await pending;
});
