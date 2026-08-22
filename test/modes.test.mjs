import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMode, setMode, DEFAULT_MODE, MODES } from "../src/modes.mjs";

function tmpState() {
  return join(mkdtempSync(join(tmpdir(), "pi-delegate-")), "modes.json");
}

test("未設定過的專案回傳預設模式 soft", () => {
  assert.equal(getMode("/x/y", tmpState()), DEFAULT_MODE);
  assert.equal(DEFAULT_MODE, "soft");
});

test("setMode 之後 getMode 讀得到", () => {
  const file = tmpState();
  setMode("/x/y", "strict", file);
  assert.equal(getMode("/x/y", file), "strict");
});

test("不同專案互不影響", () => {
  const file = tmpState();
  setMode("/a", "strict", file);
  setMode("/b", "off", file);
  assert.equal(getMode("/a", file), "strict");
  assert.equal(getMode("/b", file), "off");
});

test("不合法的模式會 throw", () => {
  assert.throws(() => setMode("/x", "turbo", tmpState()), /turbo/);
});

test("三個合法模式都接受", () => {
  const file = tmpState();
  for (const mode of MODES) {
    setMode("/x", mode, file);
    assert.equal(getMode("/x", file), mode);
  }
});

test("狀態檔損毀時回退到預設而不是 throw", () => {
  const file = tmpState();
  writeFileSync(file, "{ not json");
  assert.equal(getMode("/x", file), DEFAULT_MODE);
});

test("寫入的是可讀的 JSON，key 為專案路徑", () => {
  const file = tmpState();
  setMode("/Users/s/Code/foo", "strict", file);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { "/Users/s/Code/foo": "strict" });
});
