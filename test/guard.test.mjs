import { test } from "node:test";
import assert from "node:assert/strict";
import { isProtectedPath, consumeProbe, normalizeRelSeparators } from "../src/guard.mjs";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CWD = "/proj";
const guarded = (p) => isProtectedPath(p, { cwd: CWD, exists: () => true });
const missing = (p) => isProtectedPath(p, { cwd: CWD, exists: () => false });

test("blocks existing product code under src", () => {
  assert.equal(guarded("/proj/src/foo.ts"), true);
  assert.equal(guarded("/proj/src/a/b/c.svelte"), true);
  assert.equal(guarded("/proj/src/app.py"), true);
});

test("blocks existing test files", () => {
  assert.equal(guarded("/proj/src/foo.test.ts"), true);
  assert.equal(guarded("/proj/src/foo.spec.js"), true);
});

test("allows a file that does not exist yet (new files are the shape pi is best at)", () => {
  assert.equal(missing("/proj/src/brand-new.ts"), false);
});

test("allows tasks / scripts / docs", () => {
  assert.equal(guarded("/proj/tasks/T1.md"), false);
  assert.equal(guarded("/proj/scripts/check.ts"), false);
  assert.equal(guarded("/proj/docs/notes.ts"), false);
});

test("allows all markdown", () => {
  assert.equal(guarded("/proj/src/README.md"), false);
});

test("allows config files and dotfiles", () => {
  for (const p of ["/proj/src/a.json", "/proj/src/a.toml", "/proj/src/a.yaml", "/proj/src/a.yml", "/proj/.eslintrc"]) {
    assert.equal(guarded(p), false, p);
  }
});

test("allows source code outside src", () => {
  assert.equal(guarded("/proj/lib/foo.ts"), false);
});

test("consumeProbe returns true and deletes the flag when it exists", () => {
  const file = join(mkdtempSync(join(tmpdir(), "probe-")), "probe-active");
  writeFileSync(file, "1");
  assert.equal(consumeProbe(file), true);
  assert.equal(existsSync(file), false);
});

test("consumeProbe returns false when there is no flag", () => {
  const file = join(mkdtempSync(join(tmpdir(), "probe-")), "probe-active");
  assert.equal(consumeProbe(file), false);
});

// --- [I4] case-sensitivity bypass on a case-insensitive filesystem (APFS) ---

test("uppercase SRC/ is protected too (on APFS it's the same directory as src/)", () => {
  assert.equal(guarded("/proj/SRC/foo.ts"), true);
  assert.equal(guarded("/proj/Src/foo.ts"), true);
});

test("an uppercase extension is protected too", () => {
  assert.equal(guarded("/proj/src/foo.TS"), true);
  assert.equal(guarded("/proj/src/foo.Svelte"), true);
});

test("case normalization does not break the existing exemptions", () => {
  assert.equal(guarded("/proj/src/README.MD"), false);
  assert.equal(guarded("/proj/src/a.JSON"), false);
  assert.equal(guarded("/proj/TASKS/T1.ts"), false);
  assert.equal(guarded("/proj/lib/foo.TS"), false);
});

// --- [I5] when cwd sits inside src/, relative() swallows the src/ segment ---
//
// These three cases exercise the conservative fallback for "no project marker
// (.git / package.json / ...) found anywhere": markerExists is not injected, and paths like
// /proj do not exist on the filesystem, so findProjectRoot returns null and isProtectedPath
// falls back to the old cwd-segment test. The normal case, where a root IS found, is
// covered by "with a project root found, a cwd inside the project own src/ stays protected"
// below.

test("still protected when cwd is itself inside src (otherwise the whole session silently loses protection)", () => {
  const inSrc = (p, cwd) => isProtectedPath(p, { cwd, exists: () => true });
  assert.equal(inSrc("/proj/src/foo.ts", "/proj/src"), true);
  assert.equal(inSrc("/proj/src/deep/foo.ts", "/proj/src/deep"), true);
  assert.equal(inSrc("/proj/SRC/foo.ts", "/proj/SRC"), true);
});

test("exemption rules still apply when cwd is inside src", () => {
  const inSrc = (p, cwd) => isProtectedPath(p, { cwd, exists: () => true });
  assert.equal(inSrc("/proj/src/notes.md", "/proj/src"), false);
  assert.equal(inSrc("/proj/src/docs/y.ts", "/proj/src"), false);
  assert.equal(inSrc("/proj/src/brand-new.ts", "/proj/src"), true);
  assert.equal(isProtectedPath("/proj/src/brand-new.ts", { cwd: "/proj/src", exists: () => false }), false);
});

test("when cwd is not inside src, source outside src is still allowed (unaffected by the I5 fix)", () => {
  assert.equal(guarded("/proj/lib/foo.ts"), false);
  assert.equal(guarded("/proj/foo.ts"), false);
});

// --- The `src/` under the project root, not any `src` segment in the path ---
//
// Regression case: a project that lives under `~/src/` (`~/src/myproj`). The old version
// compared every segment of cwd against `src`, so the entire tree was treated as protected
// — even `lib/foo.ts`, which is plainly not in the project's own `src/`. Now the project
// root is located via ROOT_MARKERS first and the relative path computed from there.

const HOME_SRC_ROOT = "/home/u/src/myproj";
// markerExists models "the project root has a .git". exists answers "does this file exist"
// — two different questions, hence two separate injection points (folding them into one
// would make the tests' `exists: () => true` make every directory look like a project root).
// The candidate is built the way findProjectRoot builds it — resolve() then join() — rather
// than by string-concatenating a forward slash. On Windows those differ twice over: resolve()
// prefixes the current drive and join() uses a backslash, so the literal never matched, root
// came back null, the cwd-inside-src fallback took over, and the whole tree looked protected.
const hasGitAt = (root) => {
  const marker = join(resolve(root), ".git");
  return (p) => p === marker;
};

test("a project under ~/src/ no longer has its lib/ treated as protected (regression)", () => {
  assert.equal(
    isProtectedPath(`${HOME_SRC_ROOT}/lib/foo.ts`, {
      cwd: HOME_SRC_ROOT, exists: () => true, markerExists: hasGitAt(HOME_SRC_ROOT),
    }),
    false,
  );
});

test("a project under ~/src/ no longer has root-level .ts files over-blocked either", () => {
  assert.equal(
    isProtectedPath(`${HOME_SRC_ROOT}/foo.ts`, {
      cwd: HOME_SRC_ROOT, exists: () => true, markerExists: hasGitAt(HOME_SRC_ROOT),
    }),
    false,
  );
});

test("that same project's own src/ stays protected", () => {
  assert.equal(
    isProtectedPath(`${HOME_SRC_ROOT}/src/foo.ts`, {
      cwd: HOME_SRC_ROOT, exists: () => true, markerExists: hasGitAt(HOME_SRC_ROOT),
    }),
    true,
  );
});

test("with a project root found, a cwd inside the project own src/ stays protected", () => {
  const inSrc = (p, cwd) => isProtectedPath(p, { cwd, exists: () => true, markerExists: hasGitAt("/proj") });
  assert.equal(inSrc("/proj/src/foo.ts", "/proj/src"), true);
  assert.equal(inSrc("/proj/src/deep/foo.ts", "/proj/src/deep"), true);
  assert.equal(inSrc("/proj/lib/foo.ts", "/proj/src"), false);
});

test("project roots are detected by more than .git (manifests such as package.json count too)", () => {
  const byManifest = (p) => p === "/proj/package.json";
  assert.equal(isProtectedPath("/proj/src/foo.ts", { cwd: "/proj/src", exists: () => true, markerExists: byManifest }), true);
  assert.equal(isProtectedPath("/proj/lib/foo.ts", { cwd: "/proj/src", exists: () => true, markerExists: byManifest }), false);
});

// --- Windows separator handling -------------------------------------------------
// node:path's relative() emits the platform separator, so on Windows every prefix test in
// isProtectedPath (all written with "/") silently fails and strict mode stops blocking
// anything. These pin the normalization directly, because relative() itself cannot be made
// to produce a Windows-shaped path while the test runs on POSIX.

test("normalizeRelSeparators rewrites backslashes when the platform separator is a backslash", () => {
  assert.equal(normalizeRelSeparators("src\\foo.ts", "\\"), "src/foo.ts");
  assert.equal(normalizeRelSeparators("src\\a\\b\\c.svelte", "\\"), "src/a/b/c.svelte");
  assert.equal(normalizeRelSeparators("tasks\\note.ts", "\\"), "tasks/note.ts");
});

test("normalizeRelSeparators leaves POSIX paths untouched, backslashes included", () => {
  assert.equal(normalizeRelSeparators("src/foo.ts", "/"), "src/foo.ts");
  // On POSIX a backslash is a legal filename character; rewriting it would corrupt the
  // comparison rather than fix it.
  assert.equal(normalizeRelSeparators("src/we\\ird.ts", "/"), "src/we\\ird.ts");
});

test("a Windows-shaped relative path still reads as being inside src (the guard stays live)", () => {
  const rel = normalizeRelSeparators("src\\foo.ts", "\\").toLowerCase();
  assert.equal(rel.startsWith("src/"), true, "without normalization strict mode blocks nothing on Windows");
});
