import { test } from "node:test";
import assert from "node:assert/strict";
import { createJsonlSplitter } from "../src/jsonl.mjs";

test("a single complete line", () => {
  const push = createJsonlSplitter();
  assert.deepEqual(push('{"a":1}\n'), ['{"a":1}']);
});

test("a line split across chunks is stitched back together", () => {
  const push = createJsonlSplitter();
  assert.deepEqual(push('{"a":'), []);
  assert.deepEqual(push('1}\n'), ['{"a":1}']);
});

test("a single chunk containing multiple lines", () => {
  const push = createJsonlSplitter();
  assert.deepEqual(push('{"a":1}\n{"b":2}\n'), ['{"a":1}', '{"b":2}']);
});

test("strips the \\r from CRLF", () => {
  const push = createJsonlSplitter();
  assert.deepEqual(push('{"a":1}\r\n'), ['{"a":1}']);
});

test("skips empty lines", () => {
  const push = createJsonlSplitter();
  assert.deepEqual(push('\n{"a":1}\n\n'), ['{"a":1}']);
});

test("does not split on the U+2028 line separator", () => {
  const push = createJsonlSplitter();
  // JSON.stringify emits U+2028 verbatim (verified: it does not escape it), so a real pi
  // event really can contain one.
  const line = JSON.stringify({ text: "a b" });
  assert.ok(line.includes(" "), "前提：這一行真的含 U+2028");
  assert.deepEqual(push(`${line}\n`), [line]);
});

test("does not split on the U+2029 paragraph separator", () => {
  const push = createJsonlSplitter();
  const line = JSON.stringify({ text: "a b" });
  assert.ok(line.includes(" "), "前提：這一行真的含 U+2029");
  assert.deepEqual(push(`${line}\n`), [line]);
});

test("an incomplete trailing segment stays in the buffer", () => {
  const push = createJsonlSplitter();
  push('{"a":1}\n{"b":');
  assert.deepEqual(push('2}\n'), ['{"b":2}']);
});
