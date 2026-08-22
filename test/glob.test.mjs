import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesGlob, matchesAny } from "../src/glob.mjs";

// Hand-rolled rather than node:path.matchesGlob, which is still experimental on the Node
// 22 floor this plugin supports and prints a warning to stderr — and stderr is the MCP
// server's only channel for real diagnostics.

test("* stays inside one path segment", () => {
  assert.equal(matchesGlob("src/a.ts", "src/*.ts"), true);
  assert.equal(matchesGlob("src/deep/a.ts", "src/*.ts"), false);
});

test("** crosses segments, and also matches zero of them", () => {
  assert.equal(matchesGlob("a.go", "**/*.go"), true, "zero directories");
  assert.equal(matchesGlob("cmd/a.go", "**/*.go"), true);
  assert.equal(matchesGlob("cmd/x/y/a.go", "**/*.go"), true);
});

test("a trailing /** covers everything below, but not the directory itself", () => {
  assert.equal(matchesGlob("internal/a.go", "internal/**"), true);
  assert.equal(matchesGlob("internal/x/y.go", "internal/**"), true);
  assert.equal(matchesGlob("internal", "internal/**"), false);
  assert.equal(matchesGlob("internals/a.go", "internal/**"), false, "prefix must be a whole segment");
});

test("a bare directory pattern is normalized to cover its contents", () => {
  // Writing "internal/" and getting nothing protected is the kind of silent miss this
  // whole change exists to remove.
  assert.equal(matchesGlob("internal/a.go", "internal/"), true);
  assert.equal(matchesGlob("internal/x/y.go", "internal/"), true);
});

test("? matches exactly one character and never a separator", () => {
  assert.equal(matchesGlob("a1.ts", "a?.ts"), true);
  assert.equal(matchesGlob("a12.ts", "a?.ts"), false);
  assert.equal(matchesGlob("a/b.ts", "a?b.ts"), false);
});

test("regex metacharacters in a pattern are literal", () => {
  assert.equal(matchesGlob("src/a.ts", "src/a.ts"), true);
  assert.equal(matchesGlob("src/axts", "src/a.ts"), false, "the dot must not act as 'any character'");
  assert.equal(matchesGlob("src/a+b.ts", "src/a+b.ts"), true);
  assert.equal(matchesGlob("src/(x).ts", "src/(x).ts"), true);
});

test("matching is case-insensitive, matching the rest of the guard", () => {
  // APFS is case-insensitive by default: SRC/Foo.TS and src/foo.ts are the same file.
  assert.equal(matchesGlob("SRC/Foo.TS", "src/**/*.ts"), true);
});

test("backslash-separated paths are normalized, so a Windows path still matches", () => {
  assert.equal(matchesGlob("src\\deep\\a.ts", "src/**/*.ts"), true);
});

test("matchesAny is false for an empty or missing pattern list", () => {
  assert.equal(matchesAny("src/a.ts", []), false);
  assert.equal(matchesAny("src/a.ts", undefined), false);
  assert.equal(matchesAny("src/a.ts", null), false);
});

test("matchesAny is true as soon as one pattern hits", () => {
  assert.equal(matchesAny("cmd/main.go", ["internal/**", "cmd/**"]), true);
  assert.equal(matchesAny("docs/x.md", ["internal/**", "cmd/**"]), false);
});

test("a non-string pattern is ignored rather than throwing", () => {
  // modes.json is user-editable, so the list can contain anything.
  assert.equal(matchesAny("src/a.ts", [null, 42, "src/**"]), true);
  assert.equal(matchesAny("src/a.ts", [null, 42]), false);
});
