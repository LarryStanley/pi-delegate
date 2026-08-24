import { realpathSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";

export const LAST_MESSAGE_LIMIT = 1000;
export const STDERR_TAIL_CHARS = 500;
export const STDERR_TAIL_LINES = 5;

const WRITE_TOOLS = new Set(["write", "edit"]);
const READ_TOOLS = new Set(["read"]);

// files_read_unrequested exists to catch roaming: pi reading files the task book never
// named. Verified against the shipped artifact (@earendil-works/pi-agent-core
// dist/agent-loop.js:266-271, executeToolCallsSequential/-Parallel): the `args` on a
// tool_execution_start event is `toolCall.arguments` — the literal, unresolved arguments
// the model produced for its tool call. pi does NOT normalize this to an absolute path
// before emitting it; resolution to an absolute path (resolveReadPathAsync/resolveToCwd,
// dist/core/tools/path-utils.js) happens only inside the tool's own execute(), for actual
// file access, and never flows back into the event. So whatever the model chose to write —
// relative or absolute — is exactly what shows up here. A real dispatch showed this is not
// hypothetical: pi was told (via the initial prompt) to "Read /tmp/.../TASK.md", so it
// called read with that exact absolute string, while extractRequestedFiles() below only
// ever produces relative strings scraped out of the task book body. A plain Set membership
// test between an absolute string and a relative string can never match, so every read pi
// performed was reported as "unrequested" — the feature had degraded to "list all reads".
//
// The fix is to resolve both sides to the same absolute, symlink-resolved path before
// comparing:
//
// - Resolve relative paths against `cwd`, not against this process's own process.cwd().
// - Then realpath() the result. This matters specifically because of how the child
//   process's own working directory gets established: dispatch() passes `cwd` to
//   node:child_process's spawn() as a plain string (e.g. "/tmp/pi-trial-zlCu"), and pi
//   resolves its own relative paths against ITS process.cwd() (confirmed in pi's shipped
//   CLI code — dist/cli/file-processor.js:17 and dist/cli/startup-ui.js:47 both call
//   `process.cwd()` directly to seed path resolution). Node's process.cwd() calls the OS
//   getcwd(), which returns the PHYSICAL path, not the logical one chdir() was given. On
//   macOS, /tmp is a symlink to /private/tmp, so a child spawned with
//   `{ cwd: "/tmp/pi-trial-zlCu" }` reports its own process.cwd() as
//   "/private/tmp/pi-trial-zlCu" — and every relative path pi resolves lands under
//   /private/tmp, while our own side (never having chdir'd) still has the /tmp string. Two
//   representations of the identical file would otherwise never string-match.
// - realpath() can throw (ENOENT) for a path that does not exist on disk — a requested
//   filename scraped from the task book body is not guaranteed to exist (typos, files not
//   yet created). Normalization must never throw in that case: fall back to the resolved
//   (non-realpath'd) path instead, so a missing file still normalizes to *some* deterministic
//   value rather than aborting verdict computation. Both sides use the same fallback, so
//   the comparison stays symmetric even when realpath can't run.
function normalizePath(p, cwd) {
  const abs = isAbsolute(p) ? p : resolvePath(cwd, p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

// pi 0.80.2's read / write / edit tool schemas all have only `path`
// (`dist/core/tools/{read,write,edit}.js`: `path: Type.String({ description: "Path to the file to …" })`).
// This code once also accepted `file_path` / `filePath` as speculative aliases — that
// "accept a few more plausible names" habit is exactly the mechanism that let C3 (usage
// read from the wrong field) survive to the final review round: a shape mismatch does
// not throw, it silently falls back to an empty value, so no test ever goes red. Before
// adding another alias, go read pi's actual tool schema first.
function toolPath(args) {
  return args?.path ?? null;
}

// A single tool call fires 3-4 events (start / update* / end). Only look at start and
// dedupe by toolCallId, or "4 files touched once each" gets misread as 12 touches.
function uniqueToolCalls(events, toolNames) {
  // A call that ENDED in an error changed nothing, and counting it overstates the verdict
  // in the direction that matters most: files_written is what a reviewer trusts to know
  // where to look. Seen live — write_count 2 on a task that created one file, because pi's
  // empty edit was "rejected before applying" and the untouched TASK.md got listed anyway.
  //
  // Only an explicit isError === true disqualifies a call. A start with no end yet is still
  // in flight, not failed: a poll reporting 0 writes while pi is midway through one would
  // be its own kind of wrong.
  const failed = new Set();
  for (const event of events) {
    if (event?.type === "tool_execution_end" && event.isError === true) failed.add(event.toolCallId);
  }
  const seen = new Map();
  for (const event of events) {
    if (event?.type !== "tool_execution_start") continue;
    if (!toolNames.has(event.toolName)) continue;
    if (failed.has(event.toolCallId)) continue;
    if (seen.has(event.toolCallId)) continue;
    seen.set(event.toolCallId, toolPath(event.args));
  }
  return [...seen.values()].filter((p) => p !== null);
}

// AssistantMessage.content is typed as an array in pi's types, but rpc.md explicitly
// states that UserMessage's content "can be a string or an array of
// TextContent/ImageContent" — in practice both shapes show up. The verdict (verdict.mjs)
// and the transcript (server.mjs's pi_transcript) must use the same parser for this, or
// you get the kind of drift where string-shaped content shows up in the verdict but goes
// missing from the transcript.
export function assistantText(message) {
  if (message?.role !== "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function lastAssistantText(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== "message_end") continue;
    const text = assistantText(event.message);
    if (text) return text;
  }
  return "";
}

// usage hangs off the AssistantMessage; it is not a top-level field of the event:
//   @earendil-works/pi-ai types.d.ts:270-283 → `interface AssistantMessage { … usage: Usage … }`
//   @earendil-works/pi-agent-core types.d.ts:360-398 → AgentEvent's message_update /
//   message_end carry only `message` and `assistantMessageEvent`, no `usage`.
// The old code read `events[i].usage`, and fixtures/fake-pi.mjs invented a matching
// top-level usage — double and implementation sprang from the same unverified assumption,
// so the tests were all green while real dispatches always reported `in 0 / out 0`.
// The top-level `?? event.usage` below is only tolerance (so a stream that really does
// hoist usage still reads), not the contract.
//
// **Per-message usage is not cumulative; it has to be summed.** This was verified against
// the shipped artifact: pi's own `getSessionStats()`
// (dist/core/agent-session.js:2364-2404) does exactly this —
//     for (const message of state.messages)
//       if (message.role === "assistant") { totalInput += assistantMsg.usage.input;
//                                           totalOutput += assistantMsg.usage.output; … }
// If usage were already a running total, pi would not need to add it up. The old version
// took only "the last event carrying usage", so a multi-turn dispatch under-reported
// output badly (it counted just the final reply) while input became "the context size at
// the moment of settling" rather than the run's input — a field named tokens whose value
// was not a total.
//
// What gets summed is **message_end**, not message_update: one message emits many
// message_update events while streaming, each carrying a usage snapshot, and adding those
// double-counts. message_end fires once per message (agent-session.js:277 is where a
// message_end appends the message into the session — the same state.messages that
// getSessionStats sums over).
function totalUsage(events) {
  let input = 0;
  let output = 0;
  let seen = false;
  for (const event of events) {
    if (event?.type !== "message_end") continue;
    if (event.message?.role !== "assistant") continue;
    const usage = event.message?.usage ?? event.usage;
    if (!usage) continue;
    seen = true;
    input += usage.input ?? 0;
    output += usage.output ?? 0;
  }
  if (seen) return { input, output };

  // Tolerance: when there is no message_end carrying usage at all (only streaming events
  // arrived, or some version hoisted usage to the top level), fall back to "the last usage
  // visible anywhere". This is a fallback, not the primary contract.
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const usage = events[i]?.message?.usage ?? events[i]?.usage;
    if (usage) return { input: usage.input ?? 0, output: usage.output ?? 0 };
  }
  return { input: 0, output: 0 };
}

// The terminal signal that decides "completed". This used to accept only `agent_settled`,
// but a real `pi --mode rpc` run has never emitted that event — `fixtures/fake-pi.mjs`
// emitted the very same invented event, so the test double and the implementation both
// grew out of one unverified reading, and 94 green unit tests caught nothing: in the real
// environment a sync dispatch could never reach `completed` and had to be closed out by
// the timeout (see the 2026-08-22 end-to-end verification report).
//
// Correction (verified against the shipped artifacts): `agent_settled` is **not** an event
// described anywhere in pi's RPC documentation. It is absent from the event table in the
// `docs/rpc.md` shipped with 0.80.2, and absent from the `AgentEvent` union in
// `@earendil-works/pi-agent-core` (whose members are only agent_start / agent_end /
// turn_start / turn_end / message_start / message_update / message_end /
// tool_execution_{start,update,end}). The name was invented by the test double from the
// very beginning. Keeping it in the accepted set costs nothing and has forward-compatible
// value should a future version add such a stronger signal — but there is no documentary
// basis for it today, so never again cite "it is in the docs" as the reason to keep it.
// What actually runs is `agent_end`: pi 0.80.2 emits it, and it exists in both the types
// and the documentation.
export const TERMINAL_SUCCESS_EVENTS = new Set(["agent_end", "agent_settled"]);

// "A terminal failure reported by pi" has two shapes on real 0.80.2, and both must be
// recognized:
//
// (1) `{type:"response", command, success:false, error}` — an rpc-layer command failure
//     (preflight didn't pass, command parsing failed, …). Shape taken from the
//     RpcResponse union in rpc-types.d.ts and the error() helper at rpc-mode.js:37.
//
// (2) An assistant message carrying `stopReason:"error"` + `errorMessage` — **the API
//     call itself failed** (inference server not running, model id doesn't exist,
//     429/500, …). This was verified by actually running it: `pi --mode rpc` against a
//     nonexistent model id, preflight first returns `success:true`, then it emits an
//     assistant message with empty content, `stopReason:"error"`, and
//     `errorMessage:"404 Model '…' not found. Available models: …"`, and finally sends
//     `agent_end` as usual.
//     In other words, (1) alone catches none of this — recognizing only (1) would make a
//     wrong model id report **completed** in 0 seconds (a false green with write_count 0,
//     tokens 0/0), which is worse than a timeout.
function lastAssistantMessage(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== "message_end") continue;
    if (event.message?.role === "assistant") return event.message;
  }
  return null;
}

function terminalErrorMessage(events) {
  const message = lastAssistantMessage(events);
  if (message?.stopReason !== "error") return null;
  return message.errorMessage || "pi reported stopReason=error (no error message attached)";
}

// `agent_end` is not necessarily terminal: pi's auto-retry (on by default, maxRetries 3)
// runs **another pass** after a retryable error, and agent-session.js:275 attaches
// `willRetry: true` to that particular agent_end. Treating it as terminal would close
// things out early on the first failure and kill a child process that still had a retry
// coming. (`willRetry` does not appear in pi-agent-core's AgentEvent type — agent-session
// adds it before the rpc output goes out, so it's only visible in a real run.)
export function isTerminalEvent(event) {
  if (!TERMINAL_SUCCESS_EVENTS.has(event?.type)) return false;
  return event.willRetry !== true;
}

function resolveStatus({ aborted, timedOut, failure, events }) {
  if (aborted) return "aborted";
  if (timedOut) return "timeout";
  // A terminal failure reported by pi (inference server down, model id does not exist,
  // ...) outranks anything in the event stream: no agent_end is coming in that case, and
  // waiting for one only ever reaches the timeout.
  if (failure) return "failed";
  if (events.some(isTerminalEvent)) return "completed";
  return "failed";
}

// pi_status's files_touched and the verdict's files_written are the same thing, sharing
// the one dedup routine so the two never drift apart (I7 fixed exactly this kind of
// duplicated-implementation drift).
export function writtenPaths(events) {
  return uniqueToolCalls(events, WRITE_TOOLS);
}

export function readPaths(events) {
  return uniqueToolCalls(events, READ_TOOLS);
}

// Collapse a flat write list into path + how many times it was written.
//
// The flat list hides the single most important signal a running dispatch can give: the
// same file being rewritten over and over. Measured in a real dispatch — a task deliberately
// scoped to one 30-line file — pi finished it, had nothing left to do, and spent the rest of
// its budget writing a scratch file, running it, adjusting it and writing it again: 22
// writes, 21 of them the same path, and input tokens 12x the equivalent larger task. The
// data was there the whole time; `files_written` just printed the path 22 times in a row,
// which reads as noise rather than as a spin.
export function writeCounts(events) {
  const counts = new Map();
  for (const path of writtenPaths(events)) counts.set(path, (counts.get(path) ?? 0) + 1);
  return [...counts].map(([path, count]) => ({ path, count }));
}

export function formatWriteCounts(counts) {
  return counts.map(({ path, count }) => (count > 1 ? `${path} (x${count})` : path));
}

// Same collapse, straight off a flat list — what formatVerdict has to work with.
export function collapseRepeats(paths = []) {
  const counts = new Map();
  for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1);
  return formatWriteCounts([...counts].map(([path, count]) => ({ path, count })));
}

// What the model is doing between tool calls.
//
// Every other number in a running pi_status comes from an event a long reasoning turn does
// not produce: totalUsage sums message_end, the write and read counts come from tool
// events, and current_tool is null because no tool is running. So a dispatch thinking hard
// and a dispatch that has wedged report identical JSON — measured on a real run, unchanged
// between 40s and 137s while the model reasoned its way to a correct answer at 290s.
//
// The stream says otherwise the whole time. message_update carries an assistantMessageEvent
// (see updateWithUsage in verdict.test.mjs for the verified shape), and its type names what
// is being streamed. Reading the last one turns "no numbers moved" into "no numbers moved
// BECAUSE it is thinking", which is the distinction the caller actually needs.
//
// The scan stops at message_end rather than running to the start of the array: the newest
// thinking_delta anywhere would still be found minutes after the turn that produced it had
// finished, latching "thinking" on for the rest of the run. That is wrong in the same
// direction as the bug this replaces, and harder to doubt, because a positive signal reads
// as evidence in a way an absent one does not.
export function streamPhase(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === "message_end" || event?.type === "tool_execution_start") return null;
    if (event?.type !== "message_update") continue;
    if (event.assistantMessageEvent?.type === "thinking_delta") return "thinking";
  }
  return null;
}

// What pi_status reports for a dispatch still in flight. Its job is to answer one question
// a bare "running" cannot: is this moving forward, or going in circles?
// Compact by default. pi_status exists to be called repeatedly while a dispatch runs, and
// everything it returns lands in the caller's context permanently — a status that dumps the
// path list and the last message on every poll costs more context than the dispatch saved.
// So the default answers only "is it moving, and roughly where", and `verbose` opts into the
// rest when a poll actually looks wrong.
//
// `spinning` is the exception: it is never omitted, because it is the one thing the caller
// cannot work out from the numbers and the one thing worth interrupting for.
export function progressSummary(events, { verbose = false } = {}) {
  const counts = writeCounts(events);
  const repeated = counts.filter(({ count }) => count > 2);
  const summary = {
    writes: writtenPaths(events).length,
    distinct_files: counts.length,
    reads: readPaths(events).length,
    tokens: totalUsage(events),
    // Not a number anyone reads on its own — it is the difference between two polls that
    // means something. Every other counter here can legitimately sit still for minutes
    // while the model reasons, so none of them separates slow from stopped; this one moves
    // whenever the stream does. One integer, and it retires the pi_transcript call that
    // answering "is it alive?" used to need.
    stream_events: events.length,
  };
  const phase = streamPhase(events);
  if (phase) summary.phase = phase;
  if (repeated.length > 0) {
    summary.spinning =
      `Rewriting ${repeated.map((r) => `${r.path} (x${r.count})`).join(", ")} — usually a task with ` +
      "nothing left to do rather than a hard problem. pi_steer can redirect it; a larger task avoids it.";
  }
  if (verbose) {
    // Capped for the same reason, and it matters more here: pi_status is built to be
    // polled, so an uncapped verbose reply is paid once per poll.
    summary.files_touched = formatWriteCounts(counts).slice(0, FILE_LIST_CAP);
    if (counts.length > FILE_LIST_CAP) {
      summary.files_touched_note = `showing ${FILE_LIST_CAP} of ${counts.length} files`;
    }
    summary.last_message = lastAssistantText(events).slice(0, 300);
  }
  return summary;
}

export function computeVerdict({
  events = [],
  aborted = false,
  timedOut = false,
  failure = null,
  stderr = "",
  exitCode = null,
  requestedFiles = [],
  cwd = process.cwd(),
  taskFile = null,
  gitDiffStat = "",
  durationS = 0,
  sessionId = "",
}) {
  const filesWritten = writtenPaths(events);
  const filesRead = uniqueToolCalls(events, READ_TOOLS);

  // The task book itself is always requested, whether or not its own filename happens to
  // appear inside its own body (it usually doesn't — extractRequestedFiles() scrapes code
  // filenames by extension, and a task book is typically a .md file, which isn't even in
  // that extension list). pi reading its own instructions is not roaming.
  const requested = new Set(requestedFiles.map((p) => normalizePath(p, cwd)));
  if (taskFile) requested.add(normalizePath(taskFile, cwd));

  const raw = lastAssistantText(events);
  const truncated = raw.length > LAST_MESSAGE_LIMIT;
  const resolvedFailure = failure ?? terminalErrorMessage(events);

  return {
    status: resolveStatus({ aborted, timedOut, failure: resolvedFailure, events }),
    write_count: filesWritten.length,
    files_written: filesWritten,
    files_read_unrequested: filesRead.filter((p) => !requested.has(normalizePath(p, cwd))),
    git_diff_stat: gitDiffStat,
    duration_s: durationS,
    tokens: totalUsage(events),
    session_id: sessionId,
    last_message: truncated ? raw.slice(0, LAST_MESSAGE_LIMIT) : raw,
    last_message_truncated: truncated,
    exit_code: exitCode,
    failure: resolvedFailure,
    stderr,
  };
}

// spec §11: "pi child process failed to spawn → status: failed, with stderr attached."
// stderr is only printed when there's actually something there, and only the tail — the
// verdict's whole selling point is "readable in about 15 lines", and a full Python
// traceback would blow that out.
function stderrTail(stderr) {
  return stderr
    .slice(-STDERR_TAIL_CHARS)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-STDERR_TAIL_LINES)
    .map((line) => `  ${line}`);
}

// The verdict is a judgment, not an inventory. A 300-file dispatch used to render a
// 25,866-character reply — and pi_result, unlike pi_transcript, is called for EVERY async
// dispatch, so that landed in Claude Code's context every single time.
//
// There was a guard for this already ("formatVerdict output is at most 20 lines") and it
// passed the whole time, because 300 paths joined with ", " is one line. Lines were never
// the budget; characters are.
//
// The cap must never cost the COUNT, though: "20 files written" when it wrote 300 is a
// wrong verdict, not a short one. So the total is always stated, and the paths are what
// gets trimmed — they are recoverable from git_diff_stat and from the working tree.
export const FILE_LIST_CAP = 20;

export function capFileList(paths, cap = FILE_LIST_CAP) {
  if (paths.length <= cap) return paths.join(", ");
  const rest = paths.length - cap;
  return `${paths.slice(0, cap).join(", ")}, … and ${rest} more (${paths.length} total)`;
}

export function formatVerdict(v) {
  const list = (arr) => (arr.length ? capFileList(arr) : "(none)");
  const lines = [
    `status:                 ${v.status}`,
    `write_count:            ${v.write_count}`,
    `files_written:          ${list(collapseRepeats(v.files_written))}`,
    `files_read_unrequested: ${list(v.files_read_unrequested)}`,
    `git_diff_stat:          ${v.git_diff_stat || "(none)"}`,
    `duration_s:             ${v.duration_s}`,
    `tokens:                 in ${v.tokens.input} / out ${v.tokens.output}`,
    `session_id:             ${v.session_id}`,
  ];
  if (v.failure) lines.push(`failure:                ${v.failure}`);
  if (v.stderr) lines.push("stderr:", ...stderrTail(v.stderr));
  lines.push(
    `last_message:${v.last_message_truncated ? " (truncated; use pi_transcript for the full text)" : ""}`,
    v.last_message || "(empty)",
  );
  return lines.join("\n");
}
