export const LAST_MESSAGE_LIMIT = 1000;
export const STDERR_TAIL_CHARS = 500;
export const STDERR_TAIL_LINES = 5;

const WRITE_TOOLS = new Set(["write", "edit"]);
const READ_TOOLS = new Set(["read"]);

// pi 0.80.2 的 read / write / edit 三支工具 schema 都只有 `path`
// （`dist/core/tools/{read,write,edit}.js`：`path: Type.String({ description: "Path to the file to …" })`）。
// 這裡曾經多接 `file_path` / `filePath` 兩個猜測性別名 —— 那種「多接幾個可能的名字」
// 正是 C3（usage 讀錯欄位）能活到最後一輪 review 的機制：形狀對不上時不會壞，
// 只會靜默回退成空值，於是沒有任何測試會紅。要再加別名之前，先去看 pi 的 tool schema。
function toolPath(args) {
  return args?.path ?? null;
}

// 一次 tool call 會噴 3–4 個事件（start / update* / end）。只看 start 並以
// toolCallId 去重，否則會把「4 個檔各動 1 次」誤讀成 12 次。
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

// AssistantMessage.content 在 pi 的型別裡是陣列，但 rpc.md 明講 UserMessage 的
// content「可以是字串或 TextContent/ImageContent 陣列」，實務上兩種都遇得到。
// 判決（verdict.mjs）跟逐字稿（server.mjs 的 pi_transcript）必須用同一支解析器，
// 否則就會出現「字串型 content 出現在判決裡、卻從逐字稿消失」這種兩邊各自漂移的落差。
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

// 「pi 回報的終局失敗」在真實 0.80.2 上有兩種形狀，兩種都要認：
//
// ① `{type:"response", command, success:false, error}` —— rpc 層的指令失敗
//    （preflight 就沒過、指令解析失敗…）。形狀取自 rpc-types.d.ts 的 RpcResponse
//    union 與 rpc-mode.js:37 的 error() helper。
//
// ② assistant 訊息帶 `stopReason:"error"` + `errorMessage` —— **API 呼叫本身失敗**
//    （推論伺服器沒開、model id 不存在、429/500…）。這是實測打出來的：用一個不存在的
//    model id 實跑 `pi --mode rpc`，preflight 先回 `success:true`，接著吐一個
//    content 為空、`stopReason:"error"`、
//    `errorMessage:"404 Model '…' not found. Available models: …"` 的 assistant
//    訊息，最後照常發 `agent_end`。
//    也就是說 ① 完全攔不到這一類 —— 只認 ① 的話，「打錯 model id」會在 0 秒內
//    回報 **completed**（write_count 0、tokens 0/0 的假綠燈），比逾時更糟。
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
  return message.errorMessage || "pi 回報 stopReason=error（未附錯誤訊息）";
}

// `agent_end` 不一定是終局：pi 的 auto-retry（預設開啟，maxRetries 3）會在
// 可重試的錯誤之後**再跑一輪**，而 agent-session.js:275 會在這種 agent_end 上補
// `willRetry: true`。把它當成終局事件就會在第一次失敗時提早收尾、順手把還要
// 重試的子行程殺掉。（`willRetry` 沒有出現在 pi-agent-core 的 AgentEvent 型別裡，
// 是 agent-session 在 rpc 輸出前加上去的，實跑才看得到。）
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

// pi_status 的 files_touched 跟判決的 files_written 是同一件事，共用同一支
// 去重邏輯，免得兩邊各自漂移（I7 修的就是這種重複實作走鐘）。
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

// spec §11：「pi 子行程 spawn 失敗 → status: failed，附 stderr」。stderr 只在
// 真的有東西時才印，而且只印尾巴 —— 判決的賣點是「約 15 行讀完」，一份完整的
// Python traceback 會把它撐爆。
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
    `last_message:${v.last_message_truncated ? " (截斷，完整內容用 pi_transcript)" : ""}`,
    v.last_message || "(empty)",
  );
  return lines.join("\n");
}
