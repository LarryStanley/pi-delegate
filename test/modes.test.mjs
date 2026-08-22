import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMode, setMode, DEFAULT_MODE, MODES } from "../src/modes.mjs";

function tmpState() {
  return join(mkdtempSync(join(tmpdir(), "pi-delegate-")), "modes.json");
}

test("a project with no mode set returns the default mode soft", () => {
  assert.equal(getMode("/x/y", tmpState()), DEFAULT_MODE);
  assert.equal(DEFAULT_MODE, "soft");
});

test("getMode reads back what setMode wrote", () => {
  const file = tmpState();
  setMode("/x/y", "strict", file);
  assert.equal(getMode("/x/y", file), "strict");
});

test("different projects do not affect each other", () => {
  const file = tmpState();
  setMode("/a", "strict", file);
  setMode("/b", "off", file);
  assert.equal(getMode("/a", file), "strict");
  assert.equal(getMode("/b", file), "off");
});

test("an invalid mode throws", () => {
  assert.throws(() => setMode("/x", "turbo", tmpState()), /turbo/);
});

test("all three valid modes are accepted", () => {
  const file = tmpState();
  for (const mode of MODES) {
    setMode("/x", mode, file);
    assert.equal(getMode("/x", file), mode);
  }
});

test("a corrupted state file falls back to the default instead of throwing", () => {
  const file = tmpState();
  writeFileSync(file, "{ not json");
  assert.equal(getMode("/x", file), DEFAULT_MODE);
});

test("the written file is readable JSON keyed by project path", () => {
  const file = tmpState();
  setMode("/Users/s/Code/foo", "strict", file);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { "/Users/s/Code/foo": "strict" });
});
