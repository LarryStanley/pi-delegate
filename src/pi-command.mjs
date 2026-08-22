import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// How pi actually gets launched.
//
// On macOS and Linux `spawn("pi")` just works: npm links a real executable into PATH.
// On Windows it does NOT, and the failure is total — every dispatch dies with
// `Error: spawn pi ENOENT` before pi is ever reached. npm installs global bins on Windows
// as `pi.cmd` / `pi.ps1` shims, and:
//   - `spawn("pi")` never finds them, because bare `pi` has no extension and Node does not
//     apply PATHEXT the way cmd.exe does;
//   - `spawn("pi.cmd")` is refused outright since the CVE-2024-27980 fix — Node will not
//     run a batch file without an explicit shell.
//
// The fix deliberately does NOT reach for `shell: true`. That would hand the task-book
// path and every flag to cmd.exe for a second round of parsing, where `&`, `^` and `|` in
// a path become command separators. Instead we resolve the shim to the JS entry point it
// was going to run anyway, and spawn `node` on that directly: same program, no shell, no
// quoting surface.

const WINDOWS_CANDIDATES = ["pi.exe", "pi.cmd", "pi.bat", "pi"];

// npm's generated .cmd shim ends up invoking node on the package's real entry point, e.g.
//   "%_prog%"  "%dp0%\node_modules\@earendil-works\pi-coding-agent\dist\cli.js" %*
// The .ps1 variant spells the same path with `$PSScriptRoot`. Rather than parse either
// format properly, pull out the first thing that looks like a path to a .js file and
// expand the one variable that stands between it and being absolute.
export function extractShimTarget(shimBody, shimDir) {
  const match = shimBody.match(/["']?((?:[A-Za-z]:)?[^"'\s]*\.[cm]?js)["']?/);
  if (!match) return null;
  const raw = match[1]
    .replace(/%~?dp0%\\?/gi, "")
    .replace(/\$(?:PSScriptRoot|basedir)[\\/]?/gi, "")
    .replace(/%_prog%/gi, "");
  if (!raw) return null;
  const normalized = raw.replaceAll("\\", "/");
  // An absolute path (drive letter or leading slash) stands on its own; anything else was
  // written relative to the shim's own directory.
  const isAbsolute = /^[A-Za-z]:/.test(normalized) || normalized.startsWith("/");
  if (isAbsolute) return normalized;
  // Built with "/" rather than node:path.join, which would use the separator of whichever
  // platform this happens to run on. Windows accepts forward slashes everywhere, and this
  // way the string a POSIX unit test sees is the string Windows would see.
  return `${String(shimDir).replaceAll("\\", "/").replace(/\/+$/, "")}/${normalized}`;
}

function findOnPath(env, exists) {
  // Always ";" — this only ever runs for win32, and node:path's `delimiter` would be ":"
  // when the unit tests run on POSIX. Splitting on ":" as well is NOT a safe superset: it
  // tears "C:\\Windows" in half at the drive letter and every lookup then misses.
  const dirs = String(env.PATH ?? env.Path ?? "").split(";").filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of WINDOWS_CANDIDATES) {
      const full = `${dir.replace(/[\\/]+$/, "")}\\${candidate}`;
      if (exists(full)) return { full, candidate, dir };
    }
  }
  return null;
}

// Returns the argv array to spawn. Resolution order, most explicit first:
//   1. an explicit `pi_command` in the pi-delegate config — always wins, never second-
//      guessed, so a user whose install this heuristic cannot find has a way out;
//   2. on non-Windows, plain ["pi"] — the thing that has always worked;
//   3. on Windows, the resolved shim target as [node, cli.js];
//   4. ["pi"] as a last resort, so the failure mode stays the familiar ENOENT rather than
//      something new and confusing.
export function resolvePiCommand({
  configured = null,
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
  exists = existsSync,
  readFile = (p) => readFileSync(p, "utf8"),
} = {}) {
  if (Array.isArray(configured) && configured.length > 0) return [...configured];
  if (typeof configured === "string" && configured.trim() !== "") return [configured.trim()];
  if (platform !== "win32") return ["pi"];

  const found = findOnPath(env, exists);
  if (!found) return ["pi"];
  // A real .exe needs no unwrapping — Node can spawn it directly.
  if (found.candidate === "pi.exe") return [found.full];

  let body;
  try {
    body = readFile(found.full);
  } catch {
    return ["pi"];
  }
  const target = extractShimTarget(body, found.dir);
  if (!target || !exists(target)) return ["pi"];
  return [execPath, target];
}
