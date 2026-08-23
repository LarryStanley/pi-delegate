import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { eventsLogPath } from "./events-log.mjs";

// Why a crash gets written to events.log rather than to stderr.
//
// A peer session reported the MCP server disappearing mid-run: no exit code, no stderr,
// the tools simply gone from the tool list. The server's stderr goes to the plugin host,
// not to the transcript, so from inside the session there was nothing to read at all —
// twenty minutes of guessing to find something one `tail` would have answered.
//
// events.log is the one channel that still works when the transport is dead: bin/pi-watch
// prints every line of it, so a crash line reaches the monitor live rather than waiting to
// be found.
//
// Only abnormal exits are written. A clean shutdown happens on every /reload-plugins, and
// logging those would turn a routine reload into a notification and teach the user to
// ignore the channel.

export function formatFatal(kind, reason, { pid = process.pid } = {}) {
  // `throw "string"` and `Promise.reject(undefined)` both land here, so nothing may assume
  // an Error. A stack would be more useful, but events.log is line-oriented — a multi-line
  // entry becomes several records, and the monitor prints each of them as its own message.
  const message = String(reason?.stack ?? reason?.message ?? reason ?? "no reason given")
    .split("\n")[0]
    .trim();
  return (
    `pi-delegate server exited abnormally (${kind}) — pid ${pid}: ${message}. ` +
    `Its tools are gone from this session until /reload-plugins restarts it.`
  );
}

export function recordFatal(kind, reason, { path = eventsLogPath(), pid = process.pid } = {}) {
  // This runs while something is already going wrong, and on a full volume the write it is
  // attempting is the very write that failed. Throwing here would convert a logged crash
  // into an unlogged one.
  try {
    if (!path) return false;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${formatFatal(kind, reason, { pid })}\n`);
    return true;
  } catch {
    return false;
  }
}

export function installFatalLog({
  path = eventsLogPath(),
  pid = process.pid,
  onExit = (code) => process.exit(code),
} = {}) {
  // Deliberately NOT a recovery mechanism. Node's default for both of these is to die, and
  // a server that survives an unknown fault is a server in an unknown state — it would go
  // on answering tool calls out of corrupted memory. All this buys is that the death is
  // explained.
  const onRejection = (reason) => {
    recordFatal("unhandledRejection", reason, { path, pid });
    onExit(1);
  };
  const onException = (error) => {
    recordFatal("uncaughtException", error, { path, pid });
    onExit(1);
  };
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  return () => {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  };
}
