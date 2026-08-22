import { existsSync, appendFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { dispatch as realDispatch } from "./dispatch.mjs";
import { createRegistry } from "./registry.mjs";
import { formatVerdict, assistantText, writtenPaths } from "./verdict.mjs";
import { loadConfig, loadPiDefaults, isDrafterModel } from "./config.mjs";

export function eventsLogPath() {
  return join(homedir(), ".claude", "pi-delegate", "events.log");
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

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
      "provider / model 不指定就用使用者自己的 pi 設定（~/.pi/agent/settings.json 的預設模型），" +
      "不需要為這個外掛另外設定。下面幾個旗標的預設值是實測出來的，覆寫前先讀它們的理由。",
    inputSchema: {
      type: "object",
      properties: {
        task_file: { type: "string", description: "任務書的絕對路徑" },
        cwd: { type: "string", description: "pi 的工作目錄（通常是專案根目錄）" },
        model: {
          type: "string",
          description: "模型 id。不給就用使用者 pi 的預設模型。provider 與 model 要嘛都給、要嘛都不給（pi 只認成對的覆寫）。",
        },
        provider: {
          type: "string",
          description: "pi provider 名稱（~/.pi/agent/models.json 或 pi 內建的任一個）。不給就用使用者 pi 的預設。",
        },
        mode: { type: "string", enum: ["sync", "async"], description: "預設 sync" },
        timeout_s: { type: "number", description: "逾時秒數，預設 1500（或 pi-delegate config.json 設的值）" },
        thinking: {
          type: "string",
          enum: THINKING_LEVELS,
          description:
            "預設 off —— 實測小的本機模型會把 budget 全花在思考上、一次 tool call 都不發。" +
            "強的託管模型在難題上開 thinking 是有幫助的，要開就明確指定。",
        },
        tools: {
          type: "string",
          description:
            "逗號分隔的工具清單，預設 read,write,edit —— 實測給了 bash，模型會一直 ls/cat 漫遊而不動手。" +
            "確實需要跑指令的任務才加 bash，這是刻意的決定不是順手加。",
        },
        no_context_files: {
          type: "boolean",
          description:
            "預設 true（不載 AGENTS.md / CLAUDE.md）—— 實測沒關掉是 43 read / 0 write / 逾時，關掉是 93 秒完成。" +
            "強的託管模型吃得下專案脈絡時可以設 false。",
        },
        append_system_prompt: {
          type: "string",
          description: "附加到 pi system prompt 後面的文字（pi 的 --append-system-prompt）。預設不加。",
        },
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
  config = loadConfig(),
  piDefaults = loadPiDefaults(),
} = {}) {
  function appendEventsLog(verdict) {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(
      logPath,
      `${JSON.stringify({ session_id: verdict.session_id, status: verdict.status, write_count: verdict.write_count })}\n`,
    );
  }

  // registry.add 先佔位、dispatchFn 之後才 spawn（見 pi_dispatch 的說明），所以
  // entry.handle 有一段真實存在的空窗期是 null。這三個 tool 以前直接
  // `entry.handle.steer(...)`，在那個空窗裡會炸 TypeError
  // （Cannot read properties of null），使用者看到的是一句沒有線索的例外。
  function requireHandle(entry, sessionId) {
    if (entry?.handle) return null;
    return text(
      `${sessionId} 的 pi 子行程還在啟動中（尚未取得控制 handle）。` +
      "稍等一下再試；若一直如此，用 pi_result 取判決看是不是 spawn 就失敗了。",
      true,
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
    async pi_dispatch({
      task_file, cwd, model, provider, mode = "sync", timeout_s,
      thinking, tools, no_context_files, append_system_prompt,
    }) {
      if (!existsSync(task_file)) return text(`任務書不存在：${task_file}`, true);
      // 三層解析：呼叫參數 → config.json → pi 自己的預設（旗標不帶）。
      // 兩邊都沒指定時 effectiveModel 是 null，代表「交給 pi 決定」—— 那是正常
      // 狀態，不是錯誤。副駕駛守門只對「我們知道 id 的那個模型」有意義。
      const effectiveModel = model ?? config.model ?? piDefaults.model;
      const effectiveProvider = provider ?? config.provider ?? piDefaults.provider;
      if (isDrafterModel(effectiveModel, config.drafter_patterns)) {
        return text(
          `${effectiveModel} 命中 drafter pattern（${config.drafter_patterns.join(" / ")}）——` +
          "推測解碼的副駕駛模型直接呼叫會回 500。改派給 target model；" +
          "若這是誤判，改 pi-delegate config.json 的 drafter_patterns。",
          true,
        );
      }

      const sessionId = randomUUID().slice(0, 8);
      // 先佔位再 spawn。反過來的話（舊版）`registry.add` 若拋錯（session_id 撞號）
      // 會在子行程已經起來之後才炸，留下一個沒人管得到、pi_abort 也叫不到的孤兒
      // pi 行程。
      //
      // 代價是**真的存在**一段 handle 為 null 的空窗：下面的 `await dispatchFn(...)`
      // 會把控制權交回 event loop，這段期間其他 tool 呼叫進得來，看到的 entry.handle
      // 就是這裡塞的 null。（舊註解寫「佔位到 spawn 之間沒有 await，其他 tool 進不來」
      // 是錯的，pi_steer / pi_abort / pi_transcript 因此會在那個窗口拋 TypeError。）
      // 所以那三個 tool 一律先跑 requireHandle()。
      registry.add(sessionId, {
        handle: null, done: null, verdict: null,
        cwd, taskFile: task_file, model: effectiveModel, provider: effectiveProvider,
      });

      let handle;
      let done;
      try {
        ({ handle, done } = await dispatchFn({
          taskFile: task_file, cwd,
          model, provider,
          thinking, tools,
          noContextFiles: no_context_files,
          appendSystemPrompt: append_system_prompt,
          timeoutS: timeout_s ?? config.timeout_s,
          config, piDefaults,
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
        const notReady = requireHandle(entry, session_id);
        if (notReady) return notReady;
        entry.handle?.steer(message);
        return text(`已送出：${message}`);
      });
    },

    async pi_abort({ session_id }) {
      return withSession(session_id, (entry) => {
        const notReady = requireHandle(entry, session_id);
        if (notReady) return notReady;
        entry.handle?.abort();
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
        const notReady = requireHandle(entry, session_id);
        if (notReady) return notReady;
        const events = entry.handle?.events ?? [];
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
