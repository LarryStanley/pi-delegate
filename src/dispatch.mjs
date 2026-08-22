import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { createJsonlSplitter } from "./jsonl.mjs";
import { computeVerdict } from "./verdict.mjs";

export const DEFAULT_MODEL = "Qwen3.8-27B-oQ4e-mtp";
export const DEFAULT_TIMEOUT_S = 1500;
const KILL_GRACE_MS = 2000;

// 旗標理由見 spec §6。不給 bash（給了會漫遊不動手）；--no-context-files 是
// 必要不是最佳化（實測：沒加 = 43 read / 0 write / 逾時；加了 = 93 秒完成）。
// 注意：pi 沒有 --cwd，工作目錄靠 spawn 的 options.cwd。
// 注意：刻意不帶 --no-session，否則 session 不落地，drill-down 讀不到。
export function buildPiArgs({ model, sessionId }) {
  return [
    "--mode", "rpc",
    "--provider", "omlx",
    "--model", model,
    "--thinking", "off",
    "--tools", "read,write,edit",
    "--session-id", sessionId,
    "--no-context-files",
    "--no-skills",
    "--no-extensions",
  ];
}

function extractRequestedFiles(taskFile) {
  try {
    const body = readFileSync(taskFile, "utf8");
    return [...body.matchAll(/[\w./-]+\.(?:ts|tsx|js|jsx|mjs|svelte|py|json|css)\b/g)].map((m) => m[0]);
  } catch {
    return [];
  }
}

export async function dispatch({
  taskFile,
  cwd,
  model = DEFAULT_MODEL,
  timeoutS = DEFAULT_TIMEOUT_S,
  sessionId,
  piCommand = ["pi"],
  gitDiffStat = "",
}) {
  const [command, ...prefixArgs] = piCommand;
  // piCommand 的路徑（例如測試用的 "node test/fixtures/fake-pi.mjs"）是相對於
  // 呼叫者的 process.cwd() 寫的，但子行程會被 spawn 到 task 的 cwd。若不先轉成
  // 絕對路徑，子行程啟動時會在 task 目錄下找不到那個相對路徑而 MODULE_NOT_FOUND
  // 直接以 exit_code 1 收工（判決會誤判成 "failed"）。真正的 piCommand（["pi"]，
  // 走 PATH 查找）沒有這個問題，這裡只在候選路徑實際存在時才改寫。
  const resolvedPrefixArgs = prefixArgs.map((arg) => {
    if (isAbsolute(arg) || arg.startsWith("-")) return arg;
    const candidate = resolvePath(process.cwd(), arg);
    return existsSync(candidate) ? candidate : arg;
  });
  const args = [...resolvedPrefixArgs, ...buildPiArgs({ model, sessionId })];
  const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });

  const events = [];
  const startedAt = Date.now();
  let aborted = false;
  let timedOut = false;
  let settledResolve;
  const settledPromise = new Promise((resolve) => {
    settledResolve = resolve;
  });

  const push = createJsonlSplitter();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    for (const line of push(chunk)) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // 非 JSON 行忽略（pi 偶爾會印非事件輸出）
      }
    }
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.killed || child.kill("SIGKILL"), KILL_GRACE_MS);
  }, timeoutS * 1000);

  function send(command_) {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(command_)}\n`);
  }

  send({ type: "prompt", message: `讀取 ${taskFile} 並照著做。` });

  child.on("close", (exitCode) => {
    clearTimeout(timer);
    settledResolve(
      computeVerdict({
        events,
        aborted,
        timedOut,
        exitCode,
        requestedFiles: extractRequestedFiles(taskFile),
        gitDiffStat,
        durationS: Math.round((Date.now() - startedAt) / 1000),
        sessionId,
      }),
    );
  });

  child.on("error", (error) => {
    clearTimeout(timer);
    stderr += String(error);
    settledResolve(
      computeVerdict({
        events, aborted, timedOut: false, exitCode: null,
        requestedFiles: [], gitDiffStat,
        durationS: Math.round((Date.now() - startedAt) / 1000),
        sessionId,
      }),
    );
  });

  const handle = {
    sessionId,
    steer(message) {
      send({ type: "steer", message });
    },
    async abort() {
      aborted = true;
      send({ type: "abort" });
      child.kill("SIGTERM");
      setTimeout(() => child.killed || child.kill("SIGKILL"), KILL_GRACE_MS);
    },
    state() {
      return {
        session_id: sessionId,
        running: child.exitCode === null && !child.killed,
        elapsed_s: Math.round((Date.now() - startedAt) / 1000),
        event_count: events.length,
        stderr_tail: stderr.slice(-500),
      };
    },
    events,
  };

  return { handle, done: settledPromise };
}
