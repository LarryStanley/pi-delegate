export const LAST_MESSAGE_LIMIT = 1000;
export const STDERR_TAIL_CHARS = 500;
export const STDERR_TAIL_LINES = 5;

const WRITE_TOOLS = new Set(["write", "edit"]);
const READ_TOOLS = new Set(["read"]);

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
  const seen = new Map();
  for (const event of events) {
    if (event?.type !== "tool_execution_start") continue;
    if (!toolNames.has(event.toolName)) continue;
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

export function computeVerdict({
  events = [],
  aborted = false,
  timedOut = false,
  failure = null,
  stderr = "",
  exitCode = null,
  requestedFiles = [],
  gitDiffStat = "",
  durationS = 0,
  sessionId = "",
}) {
  const filesWritten = writtenPaths(events);
  const filesRead = uniqueToolCalls(events, READ_TOOLS);
  const requested = new Set(requestedFiles);

  const raw = lastAssistantText(events);
  const truncated = raw.length > LAST_MESSAGE_LIMIT;
  const resolvedFailure = failure ?? terminalErrorMessage(events);

  return {
    status: resolveStatus({ aborted, timedOut, failure: resolvedFailure, events }),
    write_count: filesWritten.length,
    files_written: filesWritten,
    files_read_unrequested: filesRead.filter((p) => !requested.has(p)),
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

export function formatVerdict(v) {
  const list = (arr) => (arr.length ? arr.join(", ") : "(none)");
  const lines = [
    `status:                 ${v.status}`,
    `write_count:            ${v.write_count}`,
    `files_written:          ${list(v.files_written)}`,
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
