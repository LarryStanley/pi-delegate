import { test } from "node:test";
import assert from "node:assert/strict";
import { createJsonlSplitter } from "../src/jsonl.mjs";

test("單一完整行", () => {
  const push = createJsonlSplitter();
  assert.deepEqual(push('{"a":1}\n'), ['{"a":1}']);
});

test("跨 chunk 的行會被接起來", () => {
  const push = createJsonlSplitter();
  assert.deepEqual(push('{"a":'), []);
  assert.deepEqual(push('1}\n'), ['{"a":1}']);
});

test("一個 chunk 含多行", () => {
  const push = createJsonlSplitter();
  assert.deepEqual(push('{"a":1}\n{"b":2}\n'), ['{"a":1}', '{"b":2}']);
});

test("剝除 CRLF 的 \\r", () => {
  const push = createJsonlSplitter();
  assert.deepEqual(push('{"a":1}\r\n'), ['{"a":1}']);
});

test("跳過空行", () => {
  const push = createJsonlSplitter();
  assert.deepEqual(push('\n{"a":1}\n\n'), ['{"a":1}']);
});

test("不在 U+2028 行分隔符處斷行", () => {
  const push = createJsonlSplitter();
  // JSON.stringify 會原樣輸出 U+2028（實測不轉義），所以 pi 的事件真的可能含它。
  const line = JSON.stringify({ text: "a b" });
  assert.ok(line.includes(" "), "前提：這一行真的含 U+2028");
  assert.deepEqual(push(`${line}\n`), [line]);
});

test("不在 U+2029 段落分隔符處斷行", () => {
  const push = createJsonlSplitter();
  const line = JSON.stringify({ text: "a b" });
  assert.ok(line.includes(" "), "前提：這一行真的含 U+2029");
  assert.deepEqual(push(`${line}\n`), [line]);
});

test("未完成的尾段留在緩衝區", () => {
  const push = createJsonlSplitter();
  push('{"a":1}\n{"b":');
  assert.deepEqual(push('2}\n'), ['{"b":2}']);
});
