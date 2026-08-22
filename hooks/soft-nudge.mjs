#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { getMode } from "../src/modes.mjs";
import { isProtectedPath } from "../src/guard.mjs";

async function readStdin() {
  return new Promise((resolve) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { body += c; });
    process.stdin.on("end", () => resolve(body || "{}"));
  });
}

let input;
try {
  input = JSON.parse(await readStdin());
} catch {
  // soft-nudge can only nudge, never block, so a parse failure leaves nothing useful to
  // do — exit silently.
  process.exit(0);
}

const cwd = input.cwd ?? process.cwd();
if (getMode(cwd) !== "soft") process.exit(0);

const filePath = input.tool_input?.file_path;
if (!filePath) process.exit(0);

// soft-nudge is a PostToolUse hook — by this point the file is already written to disk,
// so existsSync is always true and would misjudge a just-created file as "existing
// product code" too. Use "was this path already tracked by git before the write" as the
// substitute for exists instead: tracked means it existed before the write, i.e. it's a
// genuinely existing file; not tracked (a new file, or not a git repo at all) always
// passes through — better to miss a nudge than to nag needlessly.
const existedBefore = (p) => {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", p], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

if (!isProtectedPath(filePath, { cwd, exists: existedBefore })) process.exit(0);

// Claude Code's hook JSON schema only accepts `additionalContext` inside
// `hookSpecificOutput` (and it must be paired with a `hookEventName`); a top-level
// `additionalContext` is collected as an "unrecognized key" and dropped, leaving only one
// line in the debug log:
// `Hook JSON output had unrecognized keys (ignored): additionalContext.
//  Did you mean hookSpecificOutput.additionalContext (with a hookEventName)?`
// — that exact string was pulled straight from the claude 2.1.239 binary, not from the
// docs (the public docs draw additionalContext at the top level, which is wrong, and is
// exactly how the whole soft mode went silently inert).
// soft is DEFAULT_MODE, so getting the envelope wrong means the plugin's default tier
// does nothing at all.
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext:
      `Heads up: you just touched ${filePath}, which is product code that gets committed — the test is ` +
      `"will this character end up in a commit". If so, dispatch it to pi with pi_dispatch instead. ` +
      `Write the next edit like this as a task book.`,
  },
}));
