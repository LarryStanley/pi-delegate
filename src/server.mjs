import { existsSync, appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dispatch as realDispatch } from "./dispatch.mjs";
import { createRegistry } from "./registry.mjs";
import { serve } from "./stdio-server.mjs";
import { formatVerdict, assistantText, writtenPaths, progressSummary, collapseRepeats } from "./verdict.mjs";
import { loadConfig, loadPiDefaults, isDrafterModel } from "./config.mjs";
import { formatToolCalls, formatLastN, capped } from "./transcript.mjs";
import { eventsLogPath as sessionEventsLogPath } from "./events-log.mjs";

// Re-exported so existing callers keep one import site; the reasoning for the per-session
// path lives in src/events-log.mjs.
export { eventsLogPath } from "./events-log.mjs";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

const text = (body, isError = false) => ({ content: [{ type: "text", text: body }], isError: isError || undefined });

export function realGitDiffStat(cwd) {
  try {
    // stderr is discarded, not inherited: outside a git repo `git diff --stat` prints its
    // whole usage block, and with the default stdio that lands on the console of whoever
    // called us — 20 lines of git help in the middle of a verdict.
    return execFileSync("git", ["diff", "--stat"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim().split("\n").pop() ?? "";
  } catch {
    return "";
  }
}

// spec §5 requires pi_status to return current_tool. A single pi tool call fires
// start → update* → end, so "what's running right now" = whichever call has a start
// but no end yet.
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
      "Dispatch a task book to the local pi agent. Defaults to mode=async: returns a session_id immediately and " +
      "notifies you on completion, so give pi a whole coherent unit of work the way you would a subagent. " +
      "mode=sync blocks until completion and returns a ~15 line verdict. " +
      "Leave provider / model unset to use the user's own pi configuration (the default model in " +
      "~/.pi/agent/settings.json) — this plugin needs no separate setup. The defaults for the flags below " +
      "were measured, not guessed; read the reason before overriding one.",
    inputSchema: {
      type: "object",
      properties: {
        task_file: { type: "string", description: "Absolute path to the task book" },
        cwd: { type: "string", description: "Working directory for pi (usually the project root)" },
        model: {
          type: "string",
          description:
            "Model id. Omit it to use the user's default pi model. Supply provider and model either both or " +
            "neither — pi only honours a paired override.",
        },
        provider: {
          type: "string",
          description:
            "pi provider name (anything in ~/.pi/agent/models.json, or any pi built-in). Omit it to use the " +
            "user's pi default.",
        },
        mode: {
          type: "string", enum: ["sync", "async"],
          description:
            "Defaults to async — treat pi like a subagent: hand it a whole coherent task, get on with your own " +
            "work, poll pi_status when you want to, collect with pi_result. Blocking on sync is what pushes " +
            "people to slice work into pieces small enough to sit and wait for, and slicing measurably makes " +
            "things worse. Use sync only when your very next step depends on the result. Note: the completion " +
            "notification comes from a monitor, which runs in interactive CLI sessions only — in a headless " +
            "run, poll pi_status or use sync.",
        },
        timeout_s: {
          type: "number",
          description:
            "Timeout in seconds; defaults to 1200 (or whatever pi-delegate config.json sets). It is a backstop " +
            "for a wedged dispatch, not a target — raise it rather than shrinking the task to fit.",
        },
        thinking: {
          type: "string",
          enum: THINKING_LEVELS,
          description:
            "Defaults to off: measured, small local models spend their whole budget thinking and never emit a " +
            "single tool call. Strong hosted models do benefit from thinking on hard problems, so pass a level " +
            "explicitly when you want it.",
        },
        tools: {
          type: "string",
          description:
            "Comma-separated tool list; defaults to read,write,edit. Measured: granting bash made the agent roam " +
            "with ls/cat instead of writing anything. Add bash only for a task that genuinely has to run " +
            "commands — a deliberate decision, never a reflex.",
        },
        no_context_files: {
          type: "boolean",
          description:
            "Defaults to true (do not load AGENTS.md / CLAUDE.md). Measured: without it, 43 reads / 0 writes / " +
            "timed out; with it, finished in 93 seconds. Set false when a strong hosted model can digest the " +
            "project context.",
        },
        append_system_prompt: {
          type: "string",
          description: "Text appended to pi's system prompt (pi's --append-system-prompt). Nothing is appended by default.",
        },
      },
      required: ["task_file", "cwd"],
    },
  },
  {
    name: "pi_status",
    description:
      "Check where a dispatch stands right now — running or finished, elapsed and remaining time, writes and " +
      "reads so far, tokens spent, and a `spinning` warning when it is rewriting the same file over and over. " +
      "Cheap enough to poll while you get on with something else.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        verbose: {
          type: "boolean",
          description:
            "Defaults to false. The compact form is counts only, because every reply stays in your context for " +
            "the rest of the session — poll it freely. Set true to also get the file list and pi's last message, " +
            "once a poll looks wrong and you want to see what it is actually doing. The `spinning` warning " +
            "appears either way.",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "pi_steer",
    description: "Interject to correct a running dispatch. It takes effect right after the current tool call finishes.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" }, message: { type: "string" } },
      required: ["session_id", "message"],
    },
  },
  {
    name: "pi_abort",
    description: "Abort a dispatch immediately. Note that aborted and failed call for opposite responses: re-dispatch an aborted task unchanged, but rewrite the task book after a failure.",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] },
  },
  {
    name: "pi_result",
    description: "Retrieve the verdict (~15 lines) of a finished dispatch. This is how an async dispatch is collected.",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] },
  },
  {
    name: "pi_transcript",
    description:
      "Drill into pi's conversation. Only reach for this when the verdict is not enough. filter=text shows what it " +
      "said, tools shows only tool calls, last_n shows the last n events. Every reply is budgeted and file " +
      "contents are elided down to their size, so this cannot dump what pi wrote back into your context — " +
      "filter=tools is safe to reach for. When a reply says it was truncated, read the file from disk rather " +
      "than pulling more transcript.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        filter: { type: "string", enum: ["text", "tools", "last_n"] },
        n: { type: "number", description: "How many events when filter=last_n; defaults to 20" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "pi_stats",
    description: "Token usage and elapsed time for a dispatch. Only needed when debugging or estimating cost.",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] },
  },
];

export function createToolHandlers({
  registry = createRegistry(),
  dispatchFn = realDispatch,
  eventsLogPath: logPath = sessionEventsLogPath(),
  gitDiffStatFn = realGitDiffStat,
  config = loadConfig(),
  piDefaults = loadPiDefaults(),
} = {}) {
  // Every line here reaches the session as a notification, so it is written to be read by
  // a person rather than parsed. It names the project as well as the session_id: if this
  // ever lands in a session that does not own the dispatch (the shared-log fallback in
  // src/events-log.mjs), that session can see at a glance that it is not theirs instead of
  // trying pi_result and getting "Unknown session_id".
  function appendEventsLog(verdict, cwd) {
    mkdirSync(dirname(logPath), { recursive: true });
    const files = verdict.write_count === 1 ? "1 file written" : `${verdict.write_count} files written`;
    appendFileSync(
      logPath,
      `pi dispatch ${verdict.session_id} ${verdict.status} in ${cwd} — ${files}. Collect it with pi_result session_id=${verdict.session_id}.\n`,
    );
  }

  // registry.add reserves the slot before dispatchFn spawns anything (see the note in
  // pi_dispatch), so there is a real window in which entry.handle is null. These three
  // tools used to call `entry.handle.steer(...)` straight out and blew up inside that
  // window with TypeError: Cannot read properties of null — an exception with no clue in
  // it as far as the user is concerned.
  function requireHandle(entry, sessionId) {
    if (entry?.handle) return null;
    return text(
      `The pi child process for ${sessionId} is still starting up (no control handle yet). ` +
      "Try again in a moment; if it stays this way, call pi_result to see whether the spawn itself failed.",
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
      last_message: `dispatch failed: ${error?.message ?? error}`,
      last_message_truncated: false,
    };
  }

  return {
    async pi_dispatch({
      task_file, cwd, model, provider, mode = "async", timeout_s,
      thinking, tools, no_context_files, append_system_prompt,
    }) {
      if (!existsSync(task_file)) return text(`Task book does not exist: ${task_file}`, true);
      // Three-layer resolution: call arguments -> config.json -> pi's own defaults (no
      // flag emitted). When neither layer supplies one, effectiveModel is null, meaning
      // "let pi decide" — a normal state, not an error. The co-pilot guard only has
      // meaning for a model whose id we actually know.
      const effectiveModel = model ?? config.model ?? piDefaults.model;
      const effectiveProvider = provider ?? config.provider ?? piDefaults.provider;
      if (isDrafterModel(effectiveModel, config.drafter_patterns)) {
        return text(
          `${effectiveModel} matches a drafter pattern (${config.drafter_patterns.join(" / ")}). ` +
          "Speculative-decoding co-pilot models return HTTP 500 when called directly — dispatch to the target " +
          "model instead. If this is a false positive, adjust drafter_patterns in the pi-delegate config.json.",
          true,
        );
      }

      const sessionId = randomUUID().slice(0, 8);
      // Reserve the slot, then spawn. The other way round (the old version) meant a
      // throwing `registry.add` (a session_id collision) blew up after the child process
      // was already running, leaving an orphaned pi process nobody could reach — not even
      // pi_abort.
      //
      // The price is a window in which handle is null, and that window is REAL: the
      // `await dispatchFn(...)` below hands control back to the event loop, other tool
      // calls get in during that time, and what they see is the null stored here. (The old
      // comment claimed "there is no await between reserving and spawning, so no other
      // tool can get in" — that was wrong, and it is why pi_steer / pi_abort /
      // pi_transcript threw TypeError inside the window.) Hence requireHandle() runs first
      // in all three.
      registry.add(sessionId, {
        handle: null, done: null, verdict: null,
        cwd, taskFile: task_file, model: effectiveModel, provider: effectiveProvider,
        timeoutS: timeout_s ?? config.timeout_s,
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
          // A thunk, not a precomputed string: git diff has to be measured after pi
          // finishes, or a clean working tree always reports (none), which defeats
          // spec §7/§11's "timed out does not mean did nothing".
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
          if (mode === "async") appendEventsLog(verdict, cwd);
        })
        .catch((error) => {
          const verdict = failedVerdict(sessionId, error);
          registry.update(sessionId, { verdict });
          if (mode === "async") appendEventsLog(verdict, cwd);
        });

      if (mode === "async") {
        return text(
          `Dispatched (async). session_id: ${sessionId}\n` +
          "Get on with your own work — a completion notification will arrive naming this session_id, and " +
          `pi_result session_id=${sessionId} collects the verdict. pi_status is cheap to poll meanwhile and ` +
          "warns if pi starts rewriting the same file. If no notification ever arrives (monitors run in " +
          "interactive CLI sessions only), poll pi_status.",
        );
      }
      return text(formatVerdict(await done));
    },

    // Fields aligned with spec §5: {status, elapsed_s, current_tool, files_touched}.
    async pi_status({ session_id, verbose = false }) {
      return withSession(session_id, (entry) => {
        if (entry.verdict) {
          return text(JSON.stringify({
            status: entry.verdict.status,
            elapsed_s: entry.verdict.duration_s,
            current_tool: null,
            ...(verbose ? { files_touched: collapseRepeats(entry.verdict.files_written) } : { writes: entry.verdict.write_count }),
          }, null, 2));
        }
        const events = entry.handle?.events ?? [];
        const state = entry.handle?.state?.() ?? {};
        const elapsed = state.elapsed_s ?? 0;
        // Enough to answer "is this moving forward or going in circles" without reading the
        // transcript. A bare {status: "running", elapsed_s} cannot: a dispatch rewriting the
        // same scratch file for ten minutes looks exactly like one making steady progress.
        return text(JSON.stringify({
          status: "running",
          elapsed_s: elapsed,
          remaining_s: entry.timeoutS ? Math.max(0, entry.timeoutS - elapsed) : null,
          current_tool: currentTool(events),
          ...progressSummary(events, { verbose }),
        }, null, 2));
      });
    },

    async pi_steer({ session_id, message }) {
      return withSession(session_id, (entry) => {
        const notReady = requireHandle(entry, session_id);
        if (notReady) return notReady;
        entry.handle?.steer(message);
        return text(`Sent: ${message}`);
      });
    },

    async pi_abort({ session_id }) {
      return withSession(session_id, (entry) => {
        const notReady = requireHandle(entry, session_id);
        if (notReady) return notReady;
        entry.handle?.abort();
        return text(`Aborted ${session_id}. Remember: re-dispatch an aborted task unchanged; do not rewrite the task book.`);
      });
    },

    async pi_result({ session_id }) {
      // There is exactly one error message for an unknown session: the one registry.get
      // throws. An earlier version rewrote it here too ("valid:" vs the registry's
      // "currently valid:"), and the two strings had already drifted apart once —
      // a duplicated implementation like that will drift again sooner or later.
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
        // All three filters are budgeted. This tool is the one place that used to hand pi's
        // raw output straight back to the caller, which inverts the whole point of
        // delegating: see the header of src/transcript.mjs.
        if (filter === "tools") return text(formatToolCalls(events));
        if (filter === "last_n") return text(formatLastN(events, n));
        // Uses the same parser as verdict.mjs: an earlier version here recognized only
        // array-shaped content, so a string-shaped-content message would show up in the
        // verdict but go missing from the transcript.
        const said = events
          .filter((e) => e.type === "message_end")
          .map((e) => assistantText(e.message))
          .filter((t) => t !== "");
        return text(capped(said.join("\n---\n") || "(no text output)"));
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
  const handlers = createToolHandlers();
  const version = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8")).version;

  await serve({
    serverInfo: { name: "pi-delegate", version },
    tools: TOOL_DEFINITIONS,
    callTool: async (name, args) => {
      const handler = handlers[name];
      if (!handler) return text(`Unknown tool: ${name}`, true);
      return handler(args);
    },
  });
}

// `file://` + argv[1] only happens to work on POSIX, where the path already starts with
// `/` and needs no escaping. On Windows argv[1] is `C:\Users\...\server.mjs`, so the
// template produces `file://C:\Users\...` while import.meta.url is
// `file:///C:/Users/.../server.mjs` — two slashes against three, backslashes against
// forward ones. The comparison is false, main() never runs, and the process exits 0
// having spoken no protocol at all. The client reports that as `CONNECTION_CLOSED`,
// which names the symptom and hides the cause completely.
//
// pathToFileURL does the platform-correct conversion (drive letter, separators, and
// percent-escaping of characters that are legal in a path but not in a URL).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
