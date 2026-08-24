// A path that cannot be written, on every platform.
//
// Three tests needed one and each invented its own, and all three of them were POSIX
// assumptions wearing a portable comment:
//
//   chmodSync(dir, 0o500)      on Windows chmod only toggles the read-only attribute, and
//                              only on files — the directory stays writable.
//   "/proc/nope/events.log"    on Windows there is no /proc; the path resolves to
//   "/dev/null/impossible/..." C:\proc\nope on the current drive and mkdirSync recursive
//                              happily creates it. Both tests then wrote a file there and
//                              asserted the write had failed. They also left C:\proc and
//                              C:\dev behind on the developer's machine.
//
// A regular file standing where a directory has to be needs no permissions and no special
// filesystem: mkdirSync cannot replace it and nothing can be created underneath it, on
// POSIX and Windows alike. Verified on Windows: mkdir gives EEXIST, the write ENOENT.
//
// Lives in fixtures/ rather than test/ for the reason dispatch.test.mjs records: bare
// `node --test` treats every .mjs under a directory named "test" as a test file.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Returns { path, dir }: `path` is unwritable, `dir` is the temp directory to clean up.
export function unwritablePath(name = "target") {
  const dir = mkdtempSync(join(tmpdir(), "pi-unwritable-"));
  const blocker = join(dir, "not-a-directory");
  writeFileSync(blocker, "");
  return { path: join(blocker, name), dir };
}
