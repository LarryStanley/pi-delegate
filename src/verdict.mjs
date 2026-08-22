export const LAST_MESSAGE_LIMIT = 1000;

const WRITE_TOOLS = new Set(["write", "edit"]);
const READ_TOOLS = new Set(["read"]);

function toolPath(args) {
  return args?.path ?? args?.file_path ?? args?.filePath ?? null;
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

function lastAssistantText(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== "message_end") continue;
    if (event.message?.role !== "assistant") continue;
    const content = event.message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    if (text) return text;
  }
  return "";
}

function lastUsage(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const usage = events[i]?.usage;
    if (usage) return { input: usage.input ?? 0, output: usage.output ?? 0 };
  }
  return { input: 0, output: 0 };
}

// 判定 "completed" 的終局訊號。曾經只認 `agent_settled`，但那是 pi RPC
// 文件裡描述的事件，真實 pi 0.80.2 從未發出過（用 `pi --mode rpc` 實際跑過
// 才發現）——`fixtures/fake-pi.mjs` 也發出同一個事件，測試替身和實作源自同一次
// 對文件的誤讀，所以 94 個單元測試全綠也沒攔到：sync 派工在真實環境下永遠等不到
// `completed`，只能靠逾時收尾（詳見 2026-08-22 端到端驗證報告）。
// 現在兩個都接受：`agent_end` 是真實 pi 0.80.2 實際發出的那個，`agent_settled`
// 留著是為了前向相容——pi 文件把它描述成更強的訊號（「整個 session 定案，無
// 自動續跑」），未來版本有可能補上，接受兩者不花額外成本。
// 之後如果想「簡化」成只看一個事件，先重新驗證真實 pi 到底發什麼，不要單靠文件。
export const TERMINAL_SUCCESS_EVENTS = new Set(["agent_end", "agent_settled"]);

function resolveStatus({ aborted, timedOut, events }) {
  if (aborted) return "aborted";
  if (timedOut) return "timeout";
  if (events.some((e) => TERMINAL_SUCCESS_EVENTS.has(e?.type))) return "completed";
  return "failed";
}

export function computeVerdict({
  events = [],
  aborted = false,
  timedOut = false,
  exitCode = null,
  requestedFiles = [],
  gitDiffStat = "",
  durationS = 0,
  sessionId = "",
}) {
  const filesWritten = uniqueToolCalls(events, WRITE_TOOLS);
  const filesRead = uniqueToolCalls(events, READ_TOOLS);
  const requested = new Set(requestedFiles);

  const raw = lastAssistantText(events);
  const truncated = raw.length > LAST_MESSAGE_LIMIT;

  return {
    status: resolveStatus({ aborted, timedOut, events }),
    write_count: filesWritten.length,
    files_written: filesWritten,
    files_read_unrequested: filesRead.filter((p) => !requested.has(p)),
    git_diff_stat: gitDiffStat,
    duration_s: durationS,
    tokens: lastUsage(events),
    session_id: sessionId,
    last_message: truncated ? raw.slice(0, LAST_MESSAGE_LIMIT) : raw,
    last_message_truncated: truncated,
    exit_code: exitCode,
  };
}

export function formatVerdict(v) {
  const list = (arr) => (arr.length ? arr.join(", ") : "(none)");
  return [
    `status:                 ${v.status}`,
    `write_count:            ${v.write_count}`,
    `files_written:          ${list(v.files_written)}`,
    `files_read_unrequested: ${list(v.files_read_unrequested)}`,
    `git_diff_stat:          ${v.git_diff_stat || "(none)"}`,
    `duration_s:             ${v.duration_s}`,
    `tokens:                 in ${v.tokens.input} / out ${v.tokens.output}`,
    `session_id:             ${v.session_id}`,
    `last_message:${v.last_message_truncated ? " (截斷，完整內容用 pi_transcript)" : ""}`,
    v.last_message || "(empty)",
  ].join("\n");
}
