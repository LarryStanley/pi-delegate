import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../src/registry.mjs";

test("get retrieves what add stored", () => {
  const r = createRegistry();
  r.add("s1", { cwd: "/x", status: "running" });
  assert.equal(r.get("s1").cwd, "/x");
});

test("get on a nonexistent id throws and the message lists the valid ids", () => {
  const r = createRegistry();
  r.add("alpha", { status: "running" });
  assert.throws(() => r.get("ghost"), /alpha/);
});

test("has correctly reports presence or absence", () => {
  const r = createRegistry();
  r.add("s1", {});
  assert.equal(r.has("s1"), true);
  assert.equal(r.has("s2"), false);
});

test("update overwrites only the given fields and returns the new state", () => {
  const r = createRegistry();
  r.add("s1", { cwd: "/x", status: "running" });
  const next = r.update("s1", { status: "done" });
  assert.equal(next.status, "done");
  assert.equal(next.cwd, "/x");
});

test("ids lists every session", () => {
  const r = createRegistry();
  r.add("a", {});
  r.add("b", {});
  assert.deepEqual(r.ids().sort(), ["a", "b"]);
});

test("adding the same id twice throws", () => {
  const r = createRegistry();
  r.add("s1", {});
  assert.throws(() => r.add("s1", {}), /s1/);
});
