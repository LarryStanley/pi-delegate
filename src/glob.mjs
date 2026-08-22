// A minimal glob matcher for the discipline policy's protect/allow lists.
//
// Hand-rolled on purpose. node:path.matchesGlob would do the job, but it is still
// experimental on the Node 22 floor this plugin supports and prints an ExperimentalWarning
// to stderr — which is the MCP server's only channel for real diagnostics, and noise there
// is how a genuine error gets scrolled past. Adding a dependency is not an option either:
// Claude Code installs a plugin by copying the repo and never runs `npm install`.
//
// Supported, and nothing more: `**` (crosses separators, matches zero segments too), `*`
// (within one segment), `?` (one character, never a separator). Everything else is
// literal.

const SPECIAL = /[.+^${}()|[\]\\]/g;

function normalize(p) {
  // Windows paths arrive with backslashes; patterns are always written with forward
  // slashes. Lowercased for the same reason the rest of the guard lowercases: APFS is
  // case-insensitive by default, so SRC/Foo.TS and src/foo.ts are one file.
  return String(p).replaceAll("\\", "/").toLowerCase();
}

function toRegExp(pattern) {
  // "internal/" means the directory's contents. Left as-is it would match nothing at all,
  // which is the silent-miss failure this policy exists to remove.
  const normalized = pattern.endsWith("/") ? `${pattern}**` : pattern;

  let source = "";
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          // `**/` must also match zero directories, so `**/*.go` covers a top-level a.go.
          source += "(?:[^/]*/)*";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else if (ch === "/") {
      source += "/";
    } else {
      source += ch.replace(SPECIAL, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

export function matchesGlob(path, pattern) {
  if (typeof pattern !== "string" || pattern === "") return false;
  return toRegExp(normalize(pattern)).test(normalize(path));
}

// modes.json is a user-editable file, so a list can hold anything at all. A bad entry is
// skipped rather than thrown: a policy that crashes the hook would, in strict mode, either
// block everything or (worse) fail open.
export function matchesAny(path, patterns) {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((pattern) => matchesGlob(path, pattern));
}
