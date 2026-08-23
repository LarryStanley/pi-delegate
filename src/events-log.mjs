import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { socketPathFor } from "./notifier.mjs";

// Where an async dispatch's completion line is written, and where the monitor reads it.
//
// It used to be one global file, ~/.claude/pi-delegate/events.log. Monitors run one
// process per session (per the plugin reference), so every open session tailed that same
// file: a dispatch finishing in session A woke B, C and D as well. The combination was the
// worst possible one, because the MCP server IS per-session — its registry lives in that
// process — so the woken session got a session_id that its own pi_result cannot resolve.
// Interrupted, and with nothing it could do about it.
//
// The path is therefore scoped by CLAUDE_CODE_SESSION_ID, which Claude Code puts in the
// environment of the processes it spawns (verified in a live MCP server's environment).
//
// This module is deliberately separate from server.mjs: bin/pi-watch has to compute the
// exact same path, and importing the whole MCP surface to ask one question would drag
// dispatch, the registry and the config loader along with it.

const DIR = () => join(homedir(), ".claude", "pi-delegate");

// The pre-0.5.0 shared log. Still the target when no session id is available, so the
// feature degrades to its old behaviour rather than to silence.
export function sharedEventsLogPath() {
  return join(DIR(), "events.log");
}

export function sessionIdFrom(env = process.env) {
  const id = env.CLAUDE_CODE_SESSION_ID;
  // Used as a filename, so refuse anything that could climb out of the directory. A
  // session id is a UUID; nothing else is worth accommodating.
  return typeof id === "string" && /^[A-Za-z0-9._-]+$/.test(id) ? id : null;
}

// The address both halves of one session must agree on.
//
// CLAUDE_CODE_SESSION_ID cannot be that address, which is the root cause of issues/1's
// lost notifications. Caught live:
//
//   MCP server  CLAUDE_CODE_SESSION_ID=a62909da-08d1-4b9f-b487-3c503bed29f0
//   monitor     CLAUDE_CODE_SESSION_ID=c299557e-53d1-42ab-b837-22c529e27922
//
// One session, two processes, two different ids — the monitor keeps the id from when the
// session started, the MCP server is handed a fresh one when /reload-plugins restarts it.
// Each then derives its own address and they never meet. It matches the reporter's Windows
// evidence exactly: the newest monitor watched ec8f1e23 while the server wrote 733159be.
//
// CLAUDE_CODE_MESSAGING_SOCKET is Claude Code's own messaging socket, named for the
// `claude` process itself. It is present in both processes, IDENTICAL in both, unique per
// session, and untouched by /reload-plugins — because the claude process is not the thing
// that restarts. Keying by project directory was the obvious alternative and is wrong:
// two sessions in one project is a normal working pattern and they would cross.
//
// Hashed, not used raw: nothing then depends on the path format (Windows uses a named pipe),
// the result is always filename-safe, and no part of the value is echoed into a path.
// CLAUDE_CODE_MESSAGING_TOKEN sits beside it in the environment and is a secret; it is
// deliberately never read.
export function sessionKeyFrom(env = process.env) {
  const messaging = env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (typeof messaging === "string" && messaging.trim() !== "") {
    return `cc${createHash("sha256").update(messaging.trim()).digest("hex").slice(0, 12)}`;
  }
  // Older Claude Code, or a context without the messaging socket: the session id is still
  // better than nothing, and in a run with no reload the two halves do agree.
  return sessionIdFrom(env);
}

export function eventsLogPath(env = process.env) {
  const key = sessionKeyFrom(env);
  return key ? join(DIR(), "events", `${key}.log`) : sharedEventsLogPath();
}

export function isSessionScoped(env = process.env) {
  // Follows sessionKeyFrom, not sessionIdFrom: with the messaging socket present the
  // channel IS session-scoped, and warning otherwise would be false.
  return sessionKeyFrom(env) !== null;
}

// Where the live notification channel lives, alongside the durable log. The two are
// deliberately both used: the socket carries the completion to a watcher that is attached
// right now, the log is what pi_result reads back when a reload emptied the registry.
//
// Same session scoping and the same reasoning as eventsLogPath — bin/pi-watch has to
// derive the identical address without importing the MCP surface.
export function eventsSocketPath(env = process.env, platform = process.platform) {
  return socketPathFor(sessionKeyFrom(env) ?? "shared", platform, join(DIR(), "events"));
}
