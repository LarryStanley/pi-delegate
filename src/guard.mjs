import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, dirname, extname, basename, sep } from "node:path";
import { matchesAny } from "./glob.mjs";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".svelte", ".py"]);
const EXEMPT_PREFIXES = ["tasks/", "scripts/", "docs/"];
const EXEMPT_EXTENSIONS = new Set([".md", ".json", ".toml", ".yaml", ".yml"]);
const SOURCE_DIR = "src";

// Criteria for a project root. The presence of any of these files/directories is the
// cheapest and most reliable signal that "this is the top of a project", and it works
// without knowing what language the user is working in.
const ROOT_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "deno.json"];

export function probeFlagPath() {
  return join(homedir(), ".claude", "pi-delegate", "probe-active");
}

export function consumeProbe(file = probeFlagPath()) {
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

// What's protected is **the `src/` directly under the project root**, not any path
// segment that happens to be named `src` anywhere in the absolute path.
//
// An earlier version matched `src` against every segment of cwd, to close a real hole:
// when cwd itself sits inside `src/`, relative() swallows that `src/` segment
// (cwd=/proj/src, file=/proj/src/a.ts → rel="a.ts"), so the guard goes silently inert for
// the whole session. But that fix also swallowed `~/src/<project>` — a project that
// happens to live under `~/src/` had its whole tree (including `lib/`, and .ts files at
// its own root) treated as protected, just because some segment of the path was named
// `src`.
//
// The correct approach is to find the project root first (walk up from cwd looking for
// ROOT_MARKERS), then compute the relative path against **that root**. This fixes both
// directions at once:
//   cwd=/proj/src  → root=/proj → rel="src/a.ts"        → blocked (hole closed)
//   cwd=~/src/proj → root=~/src/proj → rel="lib/a.ts"   → allowed (false positive fixed)
//   cwd=~/src/proj → root=~/src/proj → rel="src/a.ts"   → blocked (correctly, as before)
export function findProjectRoot(cwd, markerExists = existsSync) {
  let dir = resolve(String(cwd));
  for (;;) {
    if (ROOT_MARKERS.some((marker) => markerExists(join(dir, marker)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The project a given FILE belongs to — the anchor for "which mode applies to this edit".
//
// The discipline mode is a property of the project being edited, not of wherever the
// session happens to be sitting. Keying it on cwd left two holes, both silent:
//   - editing a strict project's src/ from a session opened elsewhere sailed through,
//     because getMode(cwd) read the other project's mode (and isProtectedPath then
//     measured relative() from the wrong root, so the file read as "../…" = unprotected);
//   - even inside the right project, `cd src/deep` was enough to escape, because the mode
//     was recorded under the project root and getMode() is an exact key lookup.
// Anchoring both the mode lookup and the protection check to the file's own root closes
// both at once.
export function projectRootForFile(filePath, markerExists = existsSync) {
  return findProjectRoot(dirname(resolve(String(filePath))), markerExists);
}

// The project a DIRECTORY belongs to — used when recording a mode, so that setting it from
// a subdirectory records it against the same root the hook will later look up.
export function projectRootForDir(dir, markerExists = existsSync) {
  return findProjectRoot(resolve(String(dir)), markerExists) ?? resolve(String(dir));
}

// When no project marker can be found at all (not a git repo, no manifest of any kind),
// fall back to the old conservative check. The reasoning is the same as before: this
// guard is "dispatch discipline", not a security boundary, and the two kinds of error
// have asymmetric cost — an extra block is annoying but one `/pi-delegate:probe` (or a
// mode switch) clears it, visibly; a missed block means the whole plugin's premise
// silently evaporates. The difference now is that this fallback only runs when the root
// truly cannot be determined, instead of running for every project that happens to live
// under `~/src/`.
function cwdInsideSourceDir(cwd) {
  return String(cwd)
    .split(/[/\\]+/)
    .some((segment) => segment.toLowerCase() === SOURCE_DIR);
}

// node:path's relative() emits the PLATFORM separator, so on Windows it returns
// `src\\foo.ts`. Every prefix test below is written with a forward slash, so without this
// normalization `startsWith("src/")` is false for every file on Windows and the guard
// goes silently inert — strict mode stops blocking anything at all. Only rewrite when the
// platform separator really is a backslash: on POSIX a backslash is a legal character in
// a filename, and rewriting it there would corrupt the comparison instead of fixing it.
export function normalizeRelSeparators(rel, platformSep = sep) {
  return platformSep === "\\" ? rel.replaceAll("\\", "/") : rel;
}

export function isProtectedPath(filePath, { cwd, policy = null, exists = existsSync, markerExists = existsSync } = {}) {
  const root = findProjectRoot(cwd, markerExists);
  const base = root ?? cwd;
  const rel = relative(base, filePath);
  if (rel.startsWith("..")) return false;
  if (basename(filePath).startsWith(".")) return false;

  // An explicit policy replaces the built-in heuristic entirely, rather than layering on
  // top of it. The heuristic only ever fitted one project shape (a `src/` directory of
  // TS/JS/Svelte/Python), so on a Go, Rust, or Elixir tree it protected nothing at all and
  // said nothing about it. A project that has been surveyed states its own answer, and
  // intersecting that with a rule written for someone else's layout would only reintroduce
  // the same blind spots.
  //
  // Two things stay outside the policy's reach because they are properties of the
  // workflow, not of the project's shape: a brand-new file is always allowed (writing one
  // from scratch is the shape pi is best at), and only Write/Edit reach this code at all.
  if (policy) {
    const relPath = normalizeRelSeparators(rel);
    if (!matchesAny(relPath, policy.protect)) return false;
    if (matchesAny(relPath, policy.allow)) return false;
    return exists(filePath);
  }

  // macOS's APFS is case-insensitive by default: `SRC/foo.ts` and `src/foo.ts` are the
  // same file, and so are `foo.TS` and `foo.ts` — but `startsWith("src/")` and the
  // extension Set are both case-sensitive, so a different case entirely bypasses the
  // guard. Always lowercase before comparing.
  // On a case-sensitive filesystem this also treats a genuinely separate `SRC/`
  // directory as protected; for the same reasoning as above, that direction of false
  // positive is the acceptable one.
  const relLower = normalizeRelSeparators(rel).toLowerCase();
  const ext = extname(filePath).toLowerCase();

  if (EXEMPT_EXTENSIONS.has(ext)) return false;
  if (EXEMPT_PREFIXES.some((prefix) => relLower.startsWith(prefix))) return false;
  const inSourceDir = relLower === SOURCE_DIR
    || relLower.startsWith(`${SOURCE_DIR}/`)
    || (root === null && cwdInsideSourceDir(cwd));
  if (!inSourceDir) return false;
  if (!SOURCE_EXTENSIONS.has(ext)) return false;

  // Brand-new files are allowed through — writing a file from scratch is the shape pi
  // is best at, and it's not worth blocking a probe over
  return exists(filePath);
}
