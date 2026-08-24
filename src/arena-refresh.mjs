// Refreshing the arena snapshot without making anyone wait for it.
//
// hooks.json registers every hook with timeout: 10. Refreshing inline from SessionStart
// would put a network round trip in front of a session start once a week — and when the
// fetch is slow, the hook gets killed at the deadline, which leaves the snapshot un-updated
// AND says nothing about it. So the fetch goes to a detached child: the hook prints its
// report and exits, the child finishes on its own, and the result shows up in the next
// session.
//
// scripts/arena-fetch.mjs already writes atomically and keeps the previous snapshot on a
// failed fetch, so nothing here has to care whether the child succeeds.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const FETCH_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "arena-fetch.mjs");

// Returns whether the child was started — the caller words its report accordingly rather
// than claiming a refresh that never began.
export function refreshInBackground({ spawnFn = spawn, script = FETCH_SCRIPT } = {}) {
  try {
    // stdio must be ignored, not inherited: this runs from a hook whose stdout is a JSON
    // envelope, and a stray line from the child would corrupt it.
    const child = spawnFn(process.execPath, [script], { detached: true, stdio: "ignore" });
    if (!child) return false;
    // Without unref the parent's event loop stays alive until the fetch finishes, which
    // defeats the entire point of detaching.
    child.unref();
    return true;
  } catch {
    // Every hook in this plugin degrades to "carry on and say so". A sandbox that forbids
    // spawning is not a reason to lose the report.
    return false;
  }
}
