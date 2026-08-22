import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../src/registry.mjs";

test("add 之後 get 拿得到", () => {
  const r = createRegistry();
  r.add("s1", { cwd: "/x", status: "running" });
  assert.equal(r.get("s1").cwd, "/x");
});

test("get 不存在的 id 會 throw 且訊息列出有效 id", () => {
  const r = createRegistry();
  r.add("alpha", { status: "running" });
  assert.throws(() => r.get("ghost"), /alpha/);
});

test("has 正確回報存在與否", () => {
  const r = createRegistry();
  r.add("s1", {});
  assert.equal(r.has("s1"), true);
  assert.equal(r.has("s2"), false);
});

test("update 只覆蓋指定欄位並回傳新狀態", () => {
  const r = createRegistry();
  r.add("s1", { cwd: "/x", status: "running" });
  const next = r.update("s1", { status: "done" });
  assert.equal(next.status, "done");
  assert.equal(next.cwd, "/x");
});

test("ids 列出所有 session", () => {
  const r = createRegistry();
  r.add("a", {});
  r.add("b", {});
  assert.deepEqual(r.ids().sort(), ["a", "b"]);
});

test("重複 add 同一個 id 會 throw", () => {
  const r = createRegistry();
  r.add("s1", {});
  assert.throws(() => r.add("s1", {}), /s1/);
});
