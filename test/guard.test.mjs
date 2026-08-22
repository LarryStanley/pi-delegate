import { test } from "node:test";
import assert from "node:assert/strict";
import { isProtectedPath, consumeProbe } from "../src/guard.mjs";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CWD = "/proj";
const guarded = (p) => isProtectedPath(p, { cwd: CWD, exists: () => true });
const missing = (p) => isProtectedPath(p, { cwd: CWD, exists: () => false });

test("擋已存在的 src 產品碼", () => {
  assert.equal(guarded("/proj/src/foo.ts"), true);
  assert.equal(guarded("/proj/src/a/b/c.svelte"), true);
  assert.equal(guarded("/proj/src/app.py"), true);
});

test("擋已存在的測試檔", () => {
  assert.equal(guarded("/proj/src/foo.test.ts"), true);
  assert.equal(guarded("/proj/src/foo.spec.js"), true);
});

test("放行不存在的檔案（新檔案是 pi 最擅長的形狀）", () => {
  assert.equal(missing("/proj/src/brand-new.ts"), false);
});

test("放行 tasks / scripts / docs", () => {
  assert.equal(guarded("/proj/tasks/T1.md"), false);
  assert.equal(guarded("/proj/scripts/check.ts"), false);
  assert.equal(guarded("/proj/docs/notes.ts"), false);
});

test("放行所有 markdown", () => {
  assert.equal(guarded("/proj/src/README.md"), false);
});

test("放行 config 檔與 dotfiles", () => {
  for (const p of ["/proj/src/a.json", "/proj/src/a.toml", "/proj/src/a.yaml", "/proj/src/a.yml", "/proj/.eslintrc"]) {
    assert.equal(guarded(p), false, p);
  }
});

test("放行 src 之外的原始碼", () => {
  assert.equal(guarded("/proj/lib/foo.ts"), false);
});

test("consumeProbe 有旗標時回 true 並刪掉旗標", () => {
  const file = join(mkdtempSync(join(tmpdir(), "probe-")), "probe-active");
  writeFileSync(file, "1");
  assert.equal(consumeProbe(file), true);
  assert.equal(existsSync(file), false);
});

test("consumeProbe 無旗標時回 false", () => {
  const file = join(mkdtempSync(join(tmpdir(), "probe-")), "probe-active");
  assert.equal(consumeProbe(file), false);
});
