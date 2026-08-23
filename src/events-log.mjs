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

export function eventsLogPath(env = process.env) {
  const id = sessionIdFrom(env);
  return id ? join(DIR(), "events", `${id}.log`) : sharedEventsLogPath();
}

export function isSessionScoped(env = process.env) {
  return sessionIdFrom(env) !== null;
}

// Where the live notification channel lives, alongside the durable log. The two are
// deliberately both used: the socket carries the completion to a watcher that is attached
// right now, the log is what pi_result reads back when a reload emptied the registry.
//
// Same session scoping and the same reasoning as eventsLogPath — bin/pi-watch has to
// derive the identical address without importing the MCP surface.
export function eventsSocketPath(env = process.env, platform = process.platform) {
  const id = sessionIdFrom(env) ?? "shared";
  return socketPathFor(id, platform, join(DIR(), "events"));
}
