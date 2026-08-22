// Every `${VAR}` inside a shell command template must be double-quoted.
//
// The bug this exists for: monitors.json declared
//
//     tail -n 0 -F ${HOME}/.claude/pi-delegate/events.log
//
// On POSIX that is fine — HOME has no backslashes. On Windows the substituted value is
// `C:\Users\Someone`, the whole command is then run through `bash -c "… eval '<command>'"`,
// and eval consumes the backslashes as escapes: tail ends up watching
// `C:UsersSomeone/.claude/…`. `tail -F` on a path that does not exist retries forever
// without a word, so an async dispatch completed, its line was appended to events.log, and
// no notification ever arrived. Nothing failed loudly; the feature was simply absent.
//
// hooks.json already had this right (`node "${CLAUDE_PLUGIN_ROOT}/hooks/…"`), which is the
// point: the rule was known and one file missed it. That is precisely the kind of thing a
// scan should hold, not a habit.
//
// Quoting is the fix rather than switching to a POSIX-style path, because it survives
// whichever form the host substitutes, and it also covers a home directory with a space in
// it — a second Windows-shaped failure with the same one-character cure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function jsonFiles(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    // node_modules is not ours to police, and .git holds no command templates.
    if (entry === "node_modules" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) jsonFiles(full, found);
    else if (entry.endsWith(".json")) found.push(full);
  }
  return found;
}

/** Every string value under a `command` key, with the path it was found at. */
function commandStrings(value, path = [], found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => commandStrings(item, [...path, String(i)], found));
    return found;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "command" && typeof child === "string") found.push({ at: [...path, key].join("."), command: child });
      else commandStrings(child, [...path, key], found);
    }
  }
  return found;
}

// A bare `${VAR}` — one not immediately preceded by a double quote. This is deliberately
// crude: it accepts `"${VAR}/x"` and rejects `${VAR}/x`, which is exactly the distinction
// that matters. It cannot tell a shell command from an args array entry, so the caller
// skips the shapes that never reach a shell.
const UNQUOTED = /(^|[^"])\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

test("no shell command template interpolates a variable unquoted", () => {
  const offenders = [];

  for (const file of jsonFiles(ROOT)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // A .json that does not parse is a different problem; not this test's business.
      continue;
    }
    for (const { at, command } of commandStrings(parsed, [])) {
      // .mcp.json's `command` is an executable name with its arguments in a separate
      // `args` array — spawned without a shell, so nothing can eat a backslash there.
      // Only a string that is itself a shell line can be mangled, and those are the ones
      // carrying a substitution.
      if (!UNQUOTED.test(command)) continue;
      offenders.push(`${relative(ROOT, file)} (${at}): ${command}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "these command templates interpolate a variable without double quotes. On Windows the " +
      "substituted value contains backslashes, and a command run through `eval` loses them " +
      "(C:\\Users\\x becomes C:Usersx), so the command silently addresses a path that cannot " +
      `exist:\n  ${offenders.join("\n  ")}`,
  );
});
