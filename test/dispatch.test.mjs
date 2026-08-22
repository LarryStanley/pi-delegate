import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPiArgs, dispatch } from "../src/dispatch.mjs";
import { formatVerdict } from "../src/verdict.mjs";

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

function tmpTask(body = "改 a.ts") {
  const dir = mkdtempSync(join(tmpdir(), "pi-task-"));
  const file = join(dir, "TASK.md");
  writeFileSync(file, body);
  return { dir, file };
}

test("buildPiArgs 帶上必要旗標", () => {
  const args = buildPiArgs({ model: "M", sessionId: "s1" });
  assert.ok(args.includes("--mode") && args.includes("rpc"));
  assert.ok(args.includes("--provider") && args.includes("omlx"));
  assert.ok(args.includes("--model") && args.includes("M"));
  assert.ok(args.includes("--thinking") && args.includes("off"));
  assert.ok(args.includes("--tools") && args.includes("read,write,edit"));
  assert.ok(args.includes("--no-context-files"));
  assert.ok(args.includes("--no-skills"));
  assert.ok(args.includes("--no-extensions"));
  assert.ok(args.includes("--session-id") && args.includes("s1"));
});

test("buildPiArgs 不得帶 --cwd（pi 沒有這個旗標）", () => {
  assert.ok(!buildPiArgs({ model: "M", sessionId: "s" }).includes("--cwd"));
});

test("buildPiArgs 不得帶 --no-session（會讓 drill-down 無資料）", () => {
  assert.ok(!buildPiArgs({ model: "M", sessionId: "s" }).includes("--no-session"));
});

test("不給 bash 工具", () => {
  const args = buildPiArgs({ model: "M", sessionId: "s" });
  const tools = args[args.indexOf("--tools") + 1];
  assert.ok(!tools.split(",").includes("bash"));
});

test("正常結束回傳 completed 判決", async () => {
  const { dir, file } = tmpTask();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, model: "M", timeoutS: 10,
    sessionId: "s1", piCommand: FAKE_PI, gitDiffStat: "",
  });
  const verdict = await done;
  assert.equal(verdict.status, "completed");
  assert.equal(verdict.session_id, "s1");
});

test("逾時回傳 timeout 判決且仍附 git_diff_stat", async () => {
  const { dir, file } = tmpTask();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, model: "M", timeoutS: 1,
    sessionId: "s2", piCommand: [...FAKE_PI, "--hang"],
    gitDiffStat: "1 file changed",
  });
  const verdict = await done;
  assert.equal(verdict.status, "timeout");
  assert.equal(verdict.git_diff_stat, "1 file changed");
});

test("abort 回傳 aborted 判決", async () => {
  const { dir, file } = tmpTask();
  const { handle, done } = await dispatch({
    taskFile: file, cwd: dir, model: "M", timeoutS: 30,
    sessionId: "s3", piCommand: [...FAKE_PI, "--hang"], gitDiffStat: "",
  });
  await handle.abort();
  assert.equal((await done).status, "aborted");
});

test("write 事件反映在判決的 write_count", async () => {
  const { dir, file } = tmpTask();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, model: "M", timeoutS: 10,
    sessionId: "s4", piCommand: [...FAKE_PI, "--write=a.ts,b.ts"], gitDiffStat: "",
  });
  const verdict = await done;
  assert.equal(verdict.write_count, 2);
  assert.deepEqual(verdict.files_written, ["a.ts", "b.ts"]);
});

test("steer 會把訊息送進子行程的 stdin", async () => {
  const { dir, file } = tmpTask();
  const { handle, done } = await dispatch({
    taskFile: file, cwd: dir, model: "M", timeoutS: 10,
    sessionId: "s5", piCommand: [...FAKE_PI, "--echo-steer"], gitDiffStat: "",
  });
  await handle.steer("往左一點");
  const verdict = await done;
  assert.ok(verdict.last_message.includes("往左一點"));
});

test("agent_end 之後子行程仍存活（真實 pi RPC 行為）也要在遠短於 timeout 內回傳 completed", async () => {
  const { dir, file } = tmpTask();
  const timeoutS = 15;
  const startedAt = Date.now();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, model: "M", timeoutS,
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
// 回傳 aborted 判決" test above, which uses --hang and never triggers a
// terminal event at all).
test("abort() 在終局事件已經 settle 之後呼叫，settled 互斥閘門要擋掉第二次 SIGTERM", async () => {
  const { dir, file } = tmpTask();
  const logDir = mkdtempSync(join(tmpdir(), "pi-sigterm-"));
  const sigtermLog = join(logDir, "sigterm.log");
  const { handle, done } = await dispatch({
    taskFile: file, cwd: dir, model: "M", timeoutS: 15,
    sessionId: "s8",
    piCommand: [...FAKE_PI, "--stay-alive", `--sigterm-log=${sigtermLog}`],
    gitDiffStat: "",
  });

  // 終局事件會在這裡讓 settleFromTerminalEvent() 跑完：settled 翻 true、
  // 判決定案、送出第一次 SIGTERM。子行程因為註冊了 --sigterm-log 的
  // handler 而不會真的死於這第一次 SIGTERM，繼續活著等我們檢查。
  const verdict = await done;
  assert.equal(verdict.status, "completed");

  // 這時 settled 已經是 true。沒有互斥閘門的話，這裡會再送一次 SIGTERM。
  await handle.abort();

  // 等超過 dispatch.mjs 內部的 SIGKILL grace period（2000ms），讓任何
  // 「第二次 killWithEscalation() 又各自排了一個 graceTimer」的效果有
  // 機會真的發生並被 --sigterm-log 記下來，同時也讓子行程被 SIGKILL
  // 收尾，不留殭屍行程。
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const received = readFileSync(sigtermLog, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(
    received.length,
    1,
    `expected exactly 1 SIGTERM (settled guard should block abort()'s), got ${received.length}: ${JSON.stringify(received)}`,
  );
});

test("子行程忽略 SIGTERM 時，逾時仍靠 SIGKILL escalation 結束並回傳 timeout", async () => {
  const { dir, file } = tmpTask();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, model: "M", timeoutS: 1,
    sessionId: "s6", piCommand: [...FAKE_PI, "--ignore-sigterm"], gitDiffStat: "",
  });
  const verdict = await done;
  assert.equal(verdict.status, "timeout");
});

// --- [I1] gitDiffStat 的求值時機 ---

test("gitDiffStat 是 thunk 時，在 settle 當下才求值（不是 spawn 當下）", async () => {
  const { dir, file } = tmpTask();
  let stat = "spawn 當下（乾淨的工作樹）";
  const { done } = await dispatch({
    taskFile: file, cwd: dir, model: "M", timeoutS: 1,
    sessionId: "g1", piCommand: [...FAKE_PI, "--hang"],
    gitDiffStat: () => stat,
  });
  // dispatch() 已經回來、pi 還在跑 —— 這時候工作樹才被動到
  stat = "1 file changed, 3 insertions(+)";
  const verdict = await done;
  assert.equal(verdict.status, "timeout");
  assert.equal(
    verdict.git_diff_stat,
    "1 file changed, 3 insertions(+)",
    "逾時判決要反映 pi 實際寫了什麼，不是派工前的快照",
  );
});

test("gitDiffStat 傳字串時照舊原樣帶進判決", async () => {
  const { dir, file } = tmpTask();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, model: "M", timeoutS: 10,
    sessionId: "g2", piCommand: FAKE_PI, gitDiffStat: "2 files changed",
  });
  assert.equal((await done).git_diff_stat, "2 files changed");
});

// --- [I2] pi 回報終局失敗時要立刻收尾，不要拖滿 timeout ---

test("response success:false（omlx 掛了）立刻判 failed 並附上錯誤字串", async () => {
  const { dir, file } = tmpTask();
  const timeoutS = 20;
  const startedAt = Date.now();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, model: "M", timeoutS,
    sessionId: "f1", piCommand: [...FAKE_PI, "--api-error"], gitDiffStat: "",
  });
  const verdict = await done;
  const elapsedS = (Date.now() - startedAt) / 1000;
  assert.equal(verdict.status, "failed");
  assert.match(verdict.failure, /ECONNREFUSED/);
  assert.ok(
    elapsedS < timeoutS / 4,
    `應該秒級收尾而不是等滿 ${timeoutS}s timeout，實測 ${elapsedS}s`,
  );
});

// --- [I3] spec §11：spawn 失敗要 status: failed 附 stderr ---

test("pi 不在 PATH 上時，判決是 failed 而且帶得出 stderr 線索", async () => {
  const { dir, file } = tmpTask();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, model: "M", timeoutS: 10,
    sessionId: "e1", piCommand: ["pi-definitely-not-on-path"], gitDiffStat: "",
  });
  const verdict = await done;
  assert.equal(verdict.status, "failed");
  assert.match(verdict.stderr, /ENOENT/);
  assert.match(formatVerdict(verdict), /stderr:/);
  assert.match(formatVerdict(verdict), /ENOENT/);
});

// --- [I6] settled 互斥閘門在 timeout 路徑上也要生效 ---

test("終局事件比 timeout 晚到時，不會再送第二次 SIGTERM", async () => {
  const { dir, file } = tmpTask();
  const logDir = mkdtempSync(join(tmpdir(), "pi-sigterm-late-"));
  const sigtermLog = join(logDir, "sigterm.log");

  // timeout 在 1s 觸發（SIGTERM #1，被子行程吃掉），agent_end 在 1.5s 才到。
  // 沒有閘門的話那個遲到的事件會呼叫 killWithEscalation() → SIGTERM #2。
  const { done } = await dispatch({
    taskFile: file, cwd: dir, model: "M", timeoutS: 1,
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
    `expected exactly 1 SIGTERM (timeout 路徑也該翻 settled)，got ${received.length}`,
  );
});

// --- [C3] 替身與實作對同一個真實形狀（fixture 也已改成 message.usage） ---

test("判決的 tokens 由事件流裡的 message.usage 算出，不是 0/0", async () => {
  const { dir, file } = tmpTask();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, model: "M", timeoutS: 10,
    sessionId: "u1", piCommand: FAKE_PI, gitDiffStat: "",
  });
  assert.deepEqual((await done).tokens, { input: 10, output: 5 });
});

// --- [I2, 修正版] 真實形狀的 API 失敗要秒級收尾並判 failed ---

test("model id 打錯（stopReason=error）判 failed 而不是 0 秒的假 completed", async () => {
  const { dir, file } = tmpTask();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, model: "M", timeoutS: 20,
    sessionId: "m1", piCommand: [...FAKE_PI, "--model-error"], gitDiffStat: "",
  });
  const verdict = await done;
  assert.equal(verdict.status, "failed");
  assert.match(verdict.failure, /404 Model 'nope' not found/);
});

test("agent_end 帶 willRetry:true 時不收尾，等 pi 重試完的那個終局事件", async () => {
  const { dir, file } = tmpTask();
  const { done } = await dispatch({
    taskFile: file, cwd: dir, model: "M", timeoutS: 20,
    sessionId: "r1", piCommand: [...FAKE_PI, "--retry-then-end"], gitDiffStat: "",
  });
  const verdict = await done;
  assert.equal(verdict.status, "completed");
  assert.equal(verdict.last_message, "重試之後成功了");
});
