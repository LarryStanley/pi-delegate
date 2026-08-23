import { existsSync, readFileSync } from "node:fs";

// Recovering a dispatch this server process never knew about.
//
// github.com/LarryStanley/pi-delegate/issues/1: the registry is a Map inside the MCP
// server, so /reload-plugins empties it. pi itself survives the restart and finishes its
// work, but the dispatch becomes unobservable — no notification, and pi_status answering
// `Unknown session_id ... Currently valid: (none)`, which reads like the caller made it up.
//
// The data to answer with was already on disk: appendEventsLog writes one line per async
// completion. A restarted server genuinely cannot steer or abort an orphaned child (that
// control handle died with the old process), but "did it finish?" is answerable, and that
// is the question actually being asked.
//
// Parsing our own log format is a real coupling, so the shape is asserted by tests on both
// sides. Written to survive a Windows cwd (backslashes, a drive letter, spaces).
const LINE = /^pi dispatch (\S+) (\S+) in (.*) — (.*)\. Collect it with pi_result/;

export function parseEventsLog(body) {
  const out = [];
  for (const line of String(body).split("\n")) {
    const m = LINE.exec(line.trim());
    if (m) out.push({ sessionId: m[1], status: m[2], cwd: m[3], files: m[4] });
  }
  return out;
}

// Last wins: a session id could legitimately appear twice if a dispatch was resumed.
export function findCompletion(sessionId, logPath) {
  if (!logPath || !existsSync(logPath)) return null;
  try {
    const found = parseEventsLog(readFileSync(logPath, "utf8")).filter((r) => r.sessionId === sessionId);
    return found.length ? found[found.length - 1] : null;
  } catch {
    return null;
  }
}

export function formatRecovered(record, logPath) {
  return [
    `status:                 ${record.status}   (recovered from the events log)`,
    `files:                  ${record.files}`,
    `cwd:                    ${record.cwd}`,
    `session_id:             ${record.sessionId}`,
    "",
    "This MCP server has no live record of that dispatch — it was started before the server " +
    "restarted (/reload-plugins restarts MCP servers, and the session registry lives in memory). " +
    "pi kept running and finished; the line above is what it recorded on completion in " +
    `${logPath}. Live control (pi_steer / pi_abort) and the full transcript are gone with the ` +
    "old process, but the work itself is done — check the working tree.",
  ].join("\n");
}

export function unknownSessionMessage(sessionId, validIds, logPath) {
  return (
    `Unknown session_id "${sessionId}" — this server has no record of it, and no completion ` +
    `for it was found in ${logPath}. ` +
    `Sessions known to this server: ${validIds.length ? validIds.join(", ") : "(none)"}. ` +
    "Note that the registry is in-memory: if /reload-plugins ran (or the MCP server restarted " +
    "for any other reason) since the dispatch started, the record is gone from here even though " +
    "pi may still be running and will still write its files. In that case the completion line " +
    "will appear in the log above once it finishes, and the working tree is the place to look."
  );
}
