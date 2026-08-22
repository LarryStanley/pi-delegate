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

// --- [I4] case-insensitive 檔案系統（APFS）上的大小寫繞道 ---

test("大寫的 SRC/ 一樣受保護（APFS 上跟 src/ 是同一個目錄）", () => {
  assert.equal(guarded("/proj/SRC/foo.ts"), true);
  assert.equal(guarded("/proj/Src/foo.ts"), true);
});

test("大寫副檔名一樣受保護", () => {
  assert.equal(guarded("/proj/src/foo.TS"), true);
  assert.equal(guarded("/proj/src/foo.Svelte"), true);
});

test("大小寫正規化不會弄壞既有的豁免", () => {
  assert.equal(guarded("/proj/src/README.MD"), false);
  assert.equal(guarded("/proj/src/a.JSON"), false);
  assert.equal(guarded("/proj/TASKS/T1.ts"), false);
  assert.equal(guarded("/proj/lib/foo.TS"), false);
});

// --- [I5] cwd 落在 src/ 底下時，relative() 會把 src/ 吃掉 ---

test("cwd 就在 src 裡時仍受保護（否則整個 session 靜默失去防護）", () => {
  const inSrc = (p, cwd) => isProtectedPath(p, { cwd, exists: () => true });
  assert.equal(inSrc("/proj/src/foo.ts", "/proj/src"), true);
  assert.equal(inSrc("/proj/src/deep/foo.ts", "/proj/src/deep"), true);
  assert.equal(inSrc("/proj/SRC/foo.ts", "/proj/SRC"), true);
});

test("cwd 在 src 裡時，豁免規則照舊生效", () => {
  const inSrc = (p, cwd) => isProtectedPath(p, { cwd, exists: () => true });
  assert.equal(inSrc("/proj/src/notes.md", "/proj/src"), false);
  assert.equal(inSrc("/proj/src/docs/y.ts", "/proj/src"), false);
  assert.equal(inSrc("/proj/src/brand-new.ts", "/proj/src"), true);
  assert.equal(isProtectedPath("/proj/src/brand-new.ts", { cwd: "/proj/src", exists: () => false }), false);
});

test("cwd 不在 src 裡時，src 之外的原始碼仍然放行（沒有被 I5 波及）", () => {
  assert.equal(guarded("/proj/lib/foo.ts"), false);
  assert.equal(guarded("/proj/foo.ts"), false);
});
