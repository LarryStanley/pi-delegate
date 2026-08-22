#!/usr/bin/env node
import { getMode, getPolicy } from "../src/modes.mjs";
import { isProtectedPath, consumeProbe, projectRootForFile, projectRootForDir } from "../src/guard.mjs";

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
  // When stdin is broken, the only thing left to ask is "is the current cwd strict" —
  // this deliberately fails closed: a hook payload that cannot be parsed must not quietly
  // become "no opinion, allow it", especially in strict mode.
  if (getMode(projectRootForDir(process.cwd())) === "strict") {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "mode-guard could not parse its hook input (stdin was not valid JSON). In strict mode, " +
          "a failure blocks rather than silently allowing. Please retry this write; if it keeps " +
          "happening, report it to pi-delegate.",
      },
    }));
  }
  process.exit(0);
}

const filePath = input.tool_input?.file_path;
if (!filePath) process.exit(0);

// The mode belongs to the project being EDITED, not to wherever the session is sitting.
// Anchoring to the file's own project root is what makes strict hold when the edit comes
// from another project's session, or from a subdirectory of this one. Falling back to cwd
// covers a file that belongs to no project at all (no .git, no manifest anywhere above it).
const root = projectRootForFile(filePath) ?? (input.cwd ?? process.cwd());
if (getMode(root) !== "strict") process.exit(0);

if (!isProtectedPath(filePath, { cwd: root, policy: getPolicy(root) })) process.exit(0);

if (consumeProbe()) {
  console.log(JSON.stringify({ systemMessage: `Probe allowed this write: ${filePath} (flag consumed)` }));
  process.exit(0);
}

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason:
      `${filePath} is existing product code. Write a task book to tasks/ and dispatch it with pi_dispatch instead. ` +
      `To edit it by hand, run /pi-delegate:probe first for a one-time bypass.`,
  },
}));
