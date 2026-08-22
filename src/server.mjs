import { existsSync, appendFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { dispatch as realDispatch, DEFAULT_MODEL, DEFAULT_TIMEOUT_S } from "./dispatch.mjs";
import { createRegistry } from "./registry.mjs";
import { formatVerdict, assistantText, writtenPaths } from "./verdict.mjs";
import { DRAFTER_MODELS } from "./doctor.mjs";

export function eventsLogPath() {
  return join(homedir(), ".claude", "pi-delegate", "events.log");
}

const text = (body, isError = false) => ({ content: [{ type: "text", text: body }], isError: isError || undefined });

export function realGitDiffStat(cwd) {
  try {
    return execFileSync("git", ["diff", "--stat"], { cwd, encoding: "utf8" }).trim().split("\n").pop() ?? "";
  } catch {
    return "";
  }
}

// spec §5 的 pi_status 要回 current_tool。pi 一次 tool call 會發
// start → update* → end，所以「現在正在做什麼」＝ 有 start 但還沒 end 的那個。
function currentTool(events) {
  const open = new Map();
  for (const event of events) {
    if (event?.type === "tool_execution_start") open.set(event.toolCallId, event.toolName);
    else if (event?.type === "tool_execution_end") open.delete(event.toolCallId);
  }
  const names = [...open.values()];
  return names.length ? names[names.length - 1] : null;
}

export const TOOL_DEFINITIONS = [
  {
    name: "pi_dispatch",
    description:
      "把一份任務書派給本機 pi。mode=sync 阻塞到完成並回傳約 15 行判決；mode=async 立刻回 session_id，完成時會有通知。" +
      "模型選擇：編輯既有檔案一律用 dense（預設 Qwen3.8-27B-oQ4e-mtp）；只有從零寫新檔案才值得換 MoE（Qwen3.6-35B-A3B-4bit）。",
    inputSchema: {
      type: "object",
      properties: {
        task_file: { type: "string", description: "任務書的絕對路徑" },
        cwd: { type: "string", description: "pi 的工作目錄（通常是專案根目錄）" },
        model: { type: "string", description: `模型 id，預設 ${DEFAULT_MODEL}` },
        mode: { type: "string", enum: ["sync", "async"], description: "預設 sync" },
        timeout_s: { type: "number", description: `逾時秒數，預設 ${DEFAULT_TIMEOUT_S}` },
      },
      required: ["task_file", "cwd"],
    },
  },
  {
    name: "pi_status",
    description: "查一個派工現在的狀態：還在跑嗎、跑多久了、收到幾個事件。",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] },
  },
  {
    name: "pi_steer",
    description: "對執行中的派工插話糾正。會在當前 tool call 做完後插隊生效。",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" }, message: { type: "string" } },
      required: ["session_id", "message"],
    },
  },
  {
    name: "pi_abort",
    description: "立刻中止一個派工。注意「被中止」與「失敗」的處置相反：中止要原樣重派，失敗要改任務書。",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] },
  },
  {
    name: "pi_result",
    description: "取回一個已完成派工的判決（約 15 行）。async 派工用這個收工。",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] },
  },
  {
    name: "pi_transcript",
    description:
      "深入查看 pi 的對話內容。判決不夠用時才呼叫。filter=text 只看它說的話、tools 只看工具呼叫、last_n 看最後 n 個事件。",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        filter: { type: "string", enum: ["text", "tools", "last_n"] },
        n: { type: "number", description: "filter=last_n 時的數量，預設 20" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "pi_stats",
    description: "查一個派工的 token 用量與耗時。除錯或估成本時才需要。",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] },
  },
];

export function createToolHandlers({
  registry = createRegistry(),
  dispatchFn = realDispatch,
  eventsLogPath: logPath = eventsLogPath(),
  gitDiffStatFn = realGitDiffStat,
} = {}) {
  function appendEventsLog(verdict) {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(
      logPath,
      `${JSON.stringify({ session_id: verdict.session_id, status: verdict.status, write_count: verdict.write_count })}\n`,
    );
  }

  function withSession(sessionId, fn) {
    try {
      return fn(registry.get(sessionId));
    } catch (error) {
      return text(String(error.message ?? error), true);
    }
  }

  function failedVerdict(sessionId, error) {
    return {
      status: "failed",
      write_count: 0,
      files_written: [],
      files_read_unrequested: [],
      git_diff_stat: "",
      duration_s: 0,
      tokens: { input: 0, output: 0 },
      session_id: sessionId,
      last_message: `dispatch 失敗：${error?.message ?? error}`,
      last_message_truncated: false,
    };
  }

  return {
    async pi_dispatch({ task_file, cwd, model = DEFAULT_MODEL, mode = "sync", timeout_s = DEFAULT_TIMEOUT_S }) {
      if (!existsSync(task_file)) return text(`任務書不存在：${task_file}`, true);
      if (DRAFTER_MODELS.includes(model)) {
        return text(`${model} 是副駕駛模型，直接呼叫會回 500。改派給 target model。`, true);
      }

      const sessionId = randomUUID().slice(0, 8);
      // 先佔位再 spawn。反過來的話（舊版）`registry.add` 若拋錯（session_id 撞號）
      // 會在子行程已經起來之後才炸，留下一個沒人管得到、pi_abort 也叫不到的孤兒
      // pi 行程。佔位到 spawn 之間沒有 await，其他 tool 進不來。
      registry.add(sessionId, { handle: null, done: null, verdict: null, cwd, taskFile: task_file, model });

      let handle;
      let done;
      try {
        ({ handle, done } = await dispatchFn({
          taskFile: task_file, cwd, model, timeoutS: timeout_s,
          sessionId,
          // thunk，不是先算好的字串：git diff 必須在 pi 跑完之後才量，否則乾淨
          // 工作樹上永遠回報 (none)，spec §7/§11 的「逾時 ≠ 什麼都沒做」就廢了。
          gitDiffStat: () => gitDiffStatFn(cwd),
        }));
      } catch (error) {
        const verdict = failedVerdict(sessionId, error);
        registry.update(sessionId, { verdict });
        return text(formatVerdict(verdict), true);
      }
      registry.update(sessionId, { handle, done });

      done
        .then((verdict) => {
          registry.update(sessionId, { verdict });
          if (mode === "async") appendEventsLog(verdict);
        })
        .catch((error) => {
          const verdict = failedVerdict(sessionId, error);
          registry.update(sessionId, { verdict });
          if (mode === "async") appendEventsLog(verdict);
        });

      if (mode === "async") {
        return text(`已派工（非同步）。session_id: ${sessionId}\n完成時會通知；也可用 pi_status 查進度。`);
      }
      return text(formatVerdict(await done));
    },

    // 欄位對齊 spec §5：{status, elapsed_s, current_tool, files_touched}。
    async pi_status({ session_id }) {
      return withSession(session_id, (entry) => {
        if (entry.verdict) {
          return text(JSON.stringify({
            status: entry.verdict.status,
            elapsed_s: entry.verdict.duration_s,
            current_tool: null,
            files_touched: entry.verdict.files_written,
          }, null, 2));
        }
        const events = entry.handle?.events ?? [];
        const state = entry.handle?.state?.() ?? {};
        return text(JSON.stringify({
          status: "running",
          elapsed_s: state.elapsed_s ?? 0,
          current_tool: currentTool(events),
          files_touched: writtenPaths(events),
        }, null, 2));
      });
    },

    async pi_steer({ session_id, message }) {
      return withSession(session_id, (entry) => {
        entry.handle.steer(message);
        return text(`已送出：${message}`);
      });
    },

    async pi_abort({ session_id }) {
      return withSession(session_id, (entry) => {
        entry.handle.abort();
        return text(`已中止 ${session_id}。注意：中止要原樣重派，不要改任務書。`);
      });
    },

    async pi_result({ session_id }) {
      // 未知 session 的錯誤訊息只有一份，就是 registry.get 拋的那句。舊版在這裡
      // 自己重寫了一次（「有效的：」vs registry 的「目前有效的：」），兩份字串已經
      // 漂移過一次；重複實作遲早會再漂。
      let entry;
      try {
        entry = registry.get(session_id);
      } catch (error) {
        return text(String(error.message ?? error), true);
      }
      if (entry.verdict) return text(formatVerdict(entry.verdict));
      try {
        return text(formatVerdict(await entry.done));
      } catch (error) {
        return text(formatVerdict(failedVerdict(session_id, error)));
      }
    },

    async pi_transcript({ session_id, filter = "text", n = 20 }) {
      return withSession(session_id, (entry) => {
        const events = entry.handle.events ?? [];
        if (filter === "tools") {
          const calls = events
            .filter((e) => e.type === "tool_execution_start")
            .map((e) => `${e.toolName} ${JSON.stringify(e.args)}`);
          return text(calls.join("\n") || "(無工具呼叫)");
        }
        if (filter === "last_n") {
          return text(events.slice(-n).map((e) => JSON.stringify(e)).join("\n") || "(無事件)");
        }
        // 用 verdict.mjs 的同一支解析器：舊版這裡只認陣列型 content，於是
        // 字串型 content 的訊息會出現在判決裡、卻從逐字稿消失。
        const said = events
          .filter((e) => e.type === "message_end")
          .map((e) => assistantText(e.message))
          .filter((t) => t !== "");
        return text(said.join("\n---\n") || "(無文字輸出)");
      });
    },

    async pi_stats({ session_id }) {
      return withSession(session_id, (entry) =>
        text(JSON.stringify(entry.verdict ? { tokens: entry.verdict.tokens, duration_s: entry.verdict.duration_s } : { running: true }, null, 2)),
      );
    },
  };
}

export async function main() {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");

  const handlers = createToolHandlers();
  const server = new Server({ name: "pi-delegate", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const handler = handlers[request.params.name];
    if (!handler) return text(`未知的 tool：${request.params.name}`, true);
    try {
      return await handler(request.params.arguments ?? {});
    } catch (error) {
      return text(`${request.params.name} 失敗：${error.message ?? error}`, true);
    }
  });

  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
