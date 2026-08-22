import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { createJsonlSplitter } from "./jsonl.mjs";
import { computeVerdict, TERMINAL_SUCCESS_EVENTS } from "./verdict.mjs";

export const DEFAULT_MODEL = "Qwen3.8-27B-oQ4e-mtp";
export const DEFAULT_TIMEOUT_S = 1500;
const KILL_GRACE_MS = 2000;

// 判定「終局事件」用同一份 verdict.mjs 的 TERMINAL_SUCCESS_EVENTS ——
// dispatch 要不要收尾子行程、verdict 要不要判 completed，看的必須是同一組
// 事件名稱，否則兩邊一邊認一邊不認，就會重新出現本輪要修的那個 bug
// class（settle 訊號跟判決訊號對不上）。

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
  // `child.killed` only reflects whether kill() successfully *sent* a signal,
  // not whether the process actually died — it flips true the instant
  // SIGTERM is sent, so `child.killed || child.kill("SIGKILL")` always
  // short-circuits and SIGKILL never fires against a child that ignores or
  // traps SIGTERM. Track real termination ourselves via the "exit" event
  // (fires as soon as the process has actually exited, ahead of "close"
  // which waits on stdio) and gate escalation on that instead.
  let terminated = false;
  let graceTimer = null;
  let settledResolve;
  const settledPromise = new Promise((resolve) => {
    settledResolve = resolve;
  });

  child.on("exit", () => {
    terminated = true;
  });

  function killWithEscalation() {
    child.kill("SIGTERM");
    graceTimer = setTimeout(() => {
      if (!terminated) child.kill("SIGKILL");
    }, KILL_GRACE_MS);
  }

  // pi --mode rpc 是「持久化雙向控制通道」：跑完一個 prompt、發完 agent_end
  // 之後，它不會自己 exit — 還在等後續的 steer / abort 指令，這正是 steer
  // 跟 abort 能運作的前提。這代表「process 自然關閉」永遠不能當作完成訊號：
  // 靠 child.on("close") 判決會一路空等到 timeout 的 killWithEscalation()
  // 把它殺掉才觸發 close，屆時 timedOut 已經是 true，resolveStatus 裡
  // timedOut 又贏過其他狀態 —— 結果是每一次派工都回報 "timeout"，即使
  // pi 早就完成任務、寫完檔案。真正可靠的完成訊號是事件流裡的終局事件
  // （agent_end / agent_settled，跟 verdict.mjs 的 TERMINAL_SUCCESS_EVENTS
  // 一致）。所以判決要在「事件流裡看到終局事件」的當下就定案，然後才去收
  // 尾子行程 —— 不要「簡化」回等 close，那就是在重新引入這個 bug。
  let settled = false;
  function settleFromTerminalEvent() {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    settledResolve(
      computeVerdict({
        events,
        aborted,
        timedOut,
        exitCode: null,
        requestedFiles: extractRequestedFiles(taskFile),
        gitDiffStat,
        durationS: Math.round((Date.now() - startedAt) / 1000),
        sessionId,
      }),
    );
    // 判決已經定案，子行程沒有繼續活著的理由了 —— 用既有的
    // killWithEscalation（不能繞過去：child.killed 不可靠，見上面關於
    // "exit" 事件的說明），SIGTERM 先禮貌一次，逾期再 SIGKILL。
    killWithEscalation();
  }

  const push = createJsonlSplitter();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    for (const line of push(chunk)) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // 非 JSON 行忽略（pi 偶爾會印非事件輸出）
        continue;
      }
      events.push(event);
      if (TERMINAL_SUCCESS_EVENTS.has(event?.type)) settleFromTerminalEvent();
    }
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const timer = setTimeout(() => {
    timedOut = true;
    killWithEscalation();
  }, timeoutS * 1000);

  function send(command_) {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(command_)}\n`);
  }

  // 子行程可能在我們判斷 `writable` 之後、實際 write() 之前就死掉（race）；
  // 沒有這個監聽器，未處理的 EPIPE 'error' 會直接讓 host process crash。
  child.stdin.on("error", () => {
    // 忽略：子行程已死或 stdin 已關閉，讓 close/exit 事件走判決流程即可。
  });

  send({ type: "prompt", message: `讀取 ${taskFile} 並照著做。` });

  child.on("close", (exitCode) => {
    clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
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
    if (graceTimer) clearTimeout(graceTimer);
    stderr += String(error);
    settledResolve(
      computeVerdict({
        events, aborted, timedOut: false, exitCode: null,
        requestedFiles: extractRequestedFiles(taskFile), gitDiffStat,
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
      // 跟 settleFromTerminalEvent 共用同一個 `settled` 旗標：一個終局事件
      // 有可能在 abort() 設完 aborted 之後、才被 stdout handler 讀到，兩條
      // 路徑若都各自呼叫 killWithEscalation()，就是兩次 SIGTERM 疊加、
      // 第一個 graceTimer 被第二個蓋掉變成孤兒計時器。只讓先到的那條路徑
      // 動手收尾；resolveStatus 已經把 aborted 排在 terminal-event 分支
      // 之前判斷，所以判決本身不受影響。
      if (settled) return;
      settled = true;
      killWithEscalation();
    },
    state() {
      return {
        session_id: sessionId,
        running: !terminated,
        elapsed_s: Math.round((Date.now() - startedAt) / 1000),
        event_count: events.length,
        stderr_tail: stderr.slice(-500),
      };
    },
    events,
  };

  return { handle, done: settledPromise };
}
