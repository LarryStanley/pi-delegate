import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { createJsonlSplitter } from "./jsonl.mjs";
import { computeVerdict, isTerminalEvent } from "./verdict.mjs";
import { loadConfig, loadPiDefaults, resolveModelSelection, THINKING_LEVELS } from "./config.mjs";

export { DEFAULT_TIMEOUT_S } from "./config.mjs";
const KILL_GRACE_MS = 2000;

// "Terminal event" is decided with the very same isTerminalEvent() from verdict.mjs —
// whether dispatch closes out the child process and whether the verdict decides
// completed must look at the same set of event names, or the two sides disagree and the
// bug class this round is fixing (settle signal and verdict signal not lining up) comes
// right back.

// The flags fall into two classes; do not conflate them.
//
// **Structural** (fixed, not overridable): `--mode rpc` (this plugin exists on top of the
// rpc bidirectional channel for steer/abort), `--session-id` (the verdict has to line up
// with a session), `--no-skills` and `--no-extensions` (do not pour the user's entire pi
// environment into a single dispatch), plus `--no-session` which is DELIBERATELY NOT
// passed (omitting it is what makes the session land on disk so drill-down can read it).
// Note: pi has no --cwd; the working directory comes from spawn's options.cwd.
//
// **Measured defaults** (overridable; the rationale is repeated in the tool descriptions
// in server.mjs so the caller sees it too):
//   --thinking off       small local models spend their whole budget thinking and never
//                        emit a single tool call; strong hosted models, on the other hand,
//                        do benefit from thinking on hard problems.
//   --tools read,write,edit  granting bash turned the agent into endless ls/cat roaming
//                        instead of writing anything.
//   --no-context-files   measured: without it, 43 reads / 0 writes / timed out; with it,
//                        finished in 93 seconds.
// All three take null to mean "do not emit this flag, let pi decide".
//
// provider / model go through the three-layer resolution (call arguments → config.json →
// pi's own defaults). **When neither layer supplies them, no flag is emitted at all** and
// pi uses defaultProvider / defaultModel from ~/.pi/agent/settings.json — i.e. the model
// the user already works with. That is the default path: with nothing configured, this
// plugin works against anthropic / openai / ollama / a local server (omlx, LM Studio, …)
// alike.
export function buildPiArgs({
  sessionId,
  config = loadConfig(),
  piDefaults = loadPiDefaults(),
  provider,
  model,
  thinking,
  tools,
  noContextFiles,
  appendSystemPrompt,
}) {
  const selection = resolveModelSelection({ provider, model, config, piDefaults });
  const resolvedThinking = thinking !== undefined ? thinking : config.thinking;
  const resolvedTools = tools !== undefined ? tools : config.tools;
  const resolvedNoContextFiles = noContextFiles !== undefined ? noContextFiles : config.no_context_files;
  const resolvedAppend = appendSystemPrompt !== undefined ? appendSystemPrompt : config.append_system_prompt;

  if (resolvedThinking !== null && !THINKING_LEVELS.includes(resolvedThinking)) {
    // pi merely prints a warning for an invalid --thinking value and then DROPS it
    // (dist/cli/args.js:96-105). Silently ignoring an override somebody asked for
    // explicitly is a pit this codebase has fallen into repeatedly, so reject it here.
    throw new Error(`Invalid thinking level "${resolvedThinking}". Accepted values: ${THINKING_LEVELS.join(" / ")}`);
  }

  const args = ["--mode", "rpc"];
  if (selection.provider && selection.model) {
    args.push("--provider", selection.provider, "--model", selection.model);
  }
  if (resolvedThinking !== null) args.push("--thinking", resolvedThinking);
  if (resolvedTools !== null) args.push("--tools", resolvedTools);
  args.push("--session-id", sessionId);
  if (resolvedNoContextFiles) args.push("--no-context-files");
  args.push("--no-skills", "--no-extensions");
  if (resolvedAppend !== null && resolvedAppend !== undefined) {
    args.push("--append-system-prompt", resolvedAppend);
  }
  return args;
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
  config = loadConfig(),
  piDefaults = loadPiDefaults(),
  model,
  provider,
  thinking,
  tools,
  noContextFiles,
  appendSystemPrompt,
  timeoutS,
  sessionId,
  piCommand = ["pi"],
  gitDiffStat = "",
}) {
  const effectiveTimeoutS = timeoutS ?? config.timeout_s;
  const [command, ...prefixArgs] = piCommand;
  // A piCommand path (e.g. "node test/fixtures/fake-pi.mjs" in tests) is written
  // relative to the caller's process.cwd(), but the child is spawned into the task's cwd.
  // Without resolving to an absolute path first, the child looks for that relative path
  // inside the task directory at startup, hits MODULE_NOT_FOUND, and exits 1 (the verdict
  // then misreads it as "failed"). The real piCommand (["pi"], resolved via PATH) has no
  // such problem, so this only rewrites the path when the candidate actually exists.
  const resolvedPrefixArgs = prefixArgs.map((arg) => {
    if (isAbsolute(arg) || arg.startsWith("-")) return arg;
    const candidate = resolvePath(process.cwd(), arg);
    return existsSync(candidate) ? candidate : arg;
  });
  const args = [
    ...resolvedPrefixArgs,
    ...buildPiArgs({ sessionId, config, piDefaults, provider, model, thinking, tools, noContextFiles, appendSystemPrompt }),
  ];
  const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });

  const events = [];
  const startedAt = Date.now();
  let aborted = false;
  let timedOut = false;
  // A terminal failure pi reports itself (inference server down, model id does not
  // exist, ...). See the stdout handler below.
  let failure = null;
  let stderr = "";
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

  // `pi --mode rpc` is a "persistent bidirectional control channel": after finishing one
  // prompt and emitting agent_end, it does not exit on its own — it's still waiting for a
  // follow-up steer / abort command, which is exactly what makes steer and abort possible.
  // That means "the process closed on its own" can never be the completion signal:
  // deciding the verdict on child.on("close") would leave it hanging all the way until
  // timeout's killWithEscalation() finally kills it and triggers close, by which point
  // timedOut is already true, and resolveStatus ranks timedOut above every other status —
  // so every single dispatch would report "timeout" even when pi finished the task and
  // wrote its files long ago. The truly reliable completion signal is a terminal event in
  // the event stream (agent_end / agent_settled, matching verdict.mjs's
  // TERMINAL_SUCCESS_EVENTS). So the verdict must settle the instant a terminal event is
  // seen in the stream, and only then close out the child process — do not "simplify"
  // this back to waiting on close, that is re-introducing this exact bug.
  let settled = false;

  // git_diff_stat must be evaluated **at the moment the verdict settles**, not before
  // spawn. server.mjs used to compute a string before dispatching and pass that in, so on
  // a clean working tree the verdict always read `(none)` regardless of what pi actually
  // wrote — which defeats the one reason spec §7/§11 introduced this field in the first
  // place ("timed out" does not mean "did nothing"). This accepts either a string (tests,
  // or a caller that genuinely wants to pin a value) or a thunk (the real path).
  function resolveGitDiffStat() {
    try {
      return typeof gitDiffStat === "function" ? gitDiffStat() : gitDiffStat;
    } catch {
      return "";
    }
  }

  function makeVerdict(exitCode = null) {
    return computeVerdict({
      events,
      aborted,
      timedOut,
      failure,
      stderr,
      exitCode,
      requestedFiles: extractRequestedFiles(taskFile),
      cwd,
      taskFile,
      gitDiffStat: resolveGitDiffStat(),
      durationS: Math.round((Date.now() - startedAt) / 1000),
      sessionId,
    });
  }

  function settleNow() {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    settledResolve(makeVerdict());
    // The verdict has settled, so the child process has no reason left to live — use the
    // existing killWithEscalation (do not bypass it: child.killed is unreliable, see the
    // note above about the "exit" event), a polite SIGTERM first, SIGKILL if it overstays.
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
        // Ignore non-JSON lines (pi occasionally prints non-event output)
        continue;
      }
      events.push(event);
      if (isTerminalEvent(event)) {
        settleNow();
        continue;
      }
      // pi's rpc mode emits, for a failed command,
      //   { id?, type:"response", command, success:false, error:string }
      // (the last member of the RpcResponse union in dist/modes/rpc/rpc-types.d.ts; the
      // error() helper at rpc-mode.js:37) and then **keeps running, waiting for the next
      // command** — rpc mode is deliberately persistent, so with nobody closing it out
      // this would hang all the way to timeout.
      //
      // Note: **an API call failure (inference server not running, wrong model id) does
      // NOT go through this path**. Verified by actually running it: a prompt's preflight
      // returns success:true first, and the error instead lands on the assistant
      // message's `stopReason:"error"` / `errorMessage` (see terminalErrorMessage() in
      // verdict.mjs), followed by a normal agent_end. This path covers the other class —
      // preflight itself failing, or command parsing failing. Both paths are needed; drop
      // either one and a whole class of failure gets missed.
      if (event?.type === "response" && event.success === false) {
        failure = String(event.error ?? `${event.command} failed`);
        settleNow();
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const timer = setTimeout(() => {
    timedOut = true;
    // The timeout also has to flip `settled`: otherwise a terminal event that arrives
    // just after the timeout would still run the whole settle path — a second SIGTERM,
    // graceTimer overwritten, the first timer orphaned. The verdict itself is still
    // produced by the close handler (timedOut is already true there, so resolveStatus
    // reports timeout); this just closes the mutual-exclusion gate.
    settled = true;
    killWithEscalation();
  }, effectiveTimeoutS * 1000);

  function send(command_) {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(command_)}\n`);
  }

  // The child process can die (a race) after we check `writable` but before the actual
  // write() happens. Without this listener, an unhandled EPIPE 'error' would crash the
  // host process outright.
  child.stdin.on("error", () => {
    // Ignore: the child is already dead or stdin already closed; let the close/exit
    // events drive the verdict path.
  });

  send({ type: "prompt", message: `Read ${taskFile} and follow it.` });

  child.on("close", (exitCode) => {
    clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
    // Deliberately not checking `settled` here: if the terminal-event path already
    // resolved, Promise resolution is idempotent anyway; but the timeout path **only**
    // flips settled and leaves producing the verdict to this handler.
    settledResolve(makeVerdict(exitCode));
  });

  child.on("error", (error) => {
    clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
    settled = true;
    // spec §11: "pi child process failed to spawn → status: failed, with stderr
    // attached." This string (e.g. `Error: spawn pi ENOENT`) used to only reach
    // handle.state(); the verdict itself never mentioned it, so when pi wasn't on PATH
    // you'd just get a clueless failed with no lead to follow.
    stderr += `${error}\n`;
    settledResolve(makeVerdict());
  });

  const handle = {
    sessionId,
    steer(message) {
      send({ type: "steer", message });
    },
    async abort() {
      aborted = true;
      send({ type: "abort" });
      // Shares the same `settled` flag with settleNow(): a terminal event can still be
      // read by the stdout handler just after abort() sets aborted, and if both paths
      // each called killWithEscalation() independently, that's two stacked SIGTERMs, with
      // the second graceTimer overwriting the first into an orphaned timer. Only whichever
      // path arrives first gets to close things out; resolveStatus already checks aborted
      // ahead of the terminal-event branch, so the verdict itself is unaffected.
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
