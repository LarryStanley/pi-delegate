import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "../src/registry.mjs";
import { createToolHandlers, TOOL_DEFINITIONS } from "../src/server.mjs";

function tmpFile(name) {
  return join(mkdtempSync(join(tmpdir(), "pi-srv-")), name);
}

function setup(dispatchFn) {
  const eventsLogPath = tmpFile("events.log");
  return {
    eventsLogPath,
    handlers: createToolHandlers({
      registry: createRegistry(),
      dispatchFn,
      eventsLogPath,
      gitDiffStatFn: () => "1 file changed",
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
    task_file: task, cwd: "/tmp", mode: "sync", model: "Qwen3.6-27B-DFlash-draft",
  });
  assert.equal(result.isError, true);
  assert.equal(called, false);
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
  });

  await assert.rejects(
    () => handlers.pi_dispatch({ task_file: task, cwd: "/tmp", mode: "sync" }),
    /已存在/,
  );
  assert.equal(spawned, 0, "registry.add 失敗時不該已經 spawn 出 pi 子行程");
});
