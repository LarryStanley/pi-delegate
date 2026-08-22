import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPiArgs, dispatch } from "../src/dispatch.mjs";

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
