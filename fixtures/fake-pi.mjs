#!/usr/bin/env node
// A minimal stand-in for `pi --mode rpc`. Only implements the behavior the tests need.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (prefix) => {
  const found = args.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
};

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

// Real pi's usage hangs off the AssistantMessage, not off a top-level event field
// (pi-ai's `interface AssistantMessage { … usage: Usage … }`; pi-agent-core's AgentEvent
// carries only message + assistantMessageEvent on message_update / message_end). This
// fake used to invent a top-level `usage` of its own, and the implementation read it
// that way, so unit tests were all green while real dispatches always reported
// in 0 / out 0. The fake has to look like the real thing, or the tests are only testing
// their own imagination.
const assistantMessage = (text, { input = 10, output = 5 } = {}) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "fake-provider",
  model: "fake",
  usage: {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

emit({ type: "session", version: 3, id: "fake", cwd: process.cwd() });

// --sigterm-log=<path>: append one line to that file every time a SIGTERM is received.
// Works independently of --ignore-sigterm/--stay-alive, letting a test observe from the
// outside exactly how many SIGTERMs dispatch() sent — verifying whether abort()'s and
// settleFromTerminalEvent()'s `settled` mutual-exclusion gate actually blocks a second
// killWithEscalation(). Registering the listener itself already stops Node from running
// SIGTERM's default termination behavior, so the child process cannot die on its own; it
// only ends once a real SIGKILL eventually arrives.
const sigtermLog = valueOf("--sigterm-log=");
if (sigtermLog) {
  process.on("SIGTERM", () => {
    try {
      appendFileSync(sigtermLog, "SIGTERM\n");
    } catch {
      // Ignore write errors; they don't affect the main goal of counting signals
    }
  });
}

// --late-agent-end=<ms>: emits the terminal event only after a delay of ms. Combined
// with --ignore-sigterm, this manufactures the race where "the terminal event arrives
// later than the timeout": if dispatch()'s timeout path did not flip `settled`, this late
// event would run the whole settle path a second time (a second SIGTERM, graceTimer
// overwritten, the first timer orphaned).
const lateAgentEnd = valueOf("--late-agent-end=");
if (lateAgentEnd) {
  setTimeout(() => emit({ type: "agent_end", messages: [] }), Number(lateAgentEnd));
}

// --model-error: the real "API call failed" shape (measured against pi 0.80.2 given a
// wrong model id): preflight succeeds first, then an assistant message with empty
// content, stopReason:"error", and an errorMessage, and finally a normal agent_end. If
// the verdict recognized only response success:false, this would turn into a false
// completed in 0 seconds.
if (has("--model-error")) {
  emit({ type: "response", command: "prompt", success: true });
  const failed = {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "fake-provider",
    model: "nope",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    errorMessage: "404 Model 'nope' not found.",
    timestamp: Date.now(),
  };
  emit({ type: "message_end", message: failed });
  emit({ type: "agent_end", messages: [failed], willRetry: false });
  setInterval(() => {}, 1000);
} else if (has("--retry-then-end")) {
  // pi's auto-retry: the first agent_end carries willRetry:true (another pass is
  // coming), and the real terminal event follows later. If dispatch() treated the first
  // one as terminal, it would close things out early and kill the child process while it
  // still had a retry pending.
  const failed = {
    role: "assistant", content: [], stopReason: "error",
    errorMessage: "429 rate limited", timestamp: Date.now(),
  };
  emit({ type: "message_end", message: failed });
  emit({ type: "agent_end", messages: [failed], willRetry: true });
  setTimeout(() => {
    emit({ type: "message_end", message: assistantMessage("Succeeded after retry") });
    emit({ type: "agent_end", messages: [], willRetry: false });
  }, 400);
  setInterval(() => {}, 1000);
} else if (has("--api-error")) {
  // Simulates "inference server down / wrong model id": when a prompt's preflight fails,
  // pi's rpc mode emits {type:"response", command:"prompt", success:false, error} and
  // then **keeps running**, waiting for the next command (rpc mode deliberately never
  // exits). Shape taken from the last member of the RpcResponse union in
  // dist/modes/rpc/rpc-types.d.ts and the error() helper at rpc-mode.js:37.
  process.stdin.on("data", () => {
    emit({
      type: "response",
      command: "prompt",
      success: false,
      error: "provider: connect ECONNREFUSED 127.0.0.1:8000",
    });
  });
  setInterval(() => {}, 1000);
} else if (has("--ignore-sigterm")) {
  // Swallows SIGTERM, forcing dispatch()'s timeout/abort logic to actually send SIGKILL
  // to end this child process — used to verify that grace-period escalation isn't
  // short-circuited by a mistaken read of child.killed. SIGKILL itself cannot be trapped,
  // so the process still dies in the end.
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (has("--hang")) {
  // Never ends; waits to be killed or aborted
  setInterval(() => {}, 1000);
} else {
  const writes = valueOf("--write=");
  if (writes) {
    writes.split(",").forEach((path, index) => {
      emit({ type: "tool_execution_start", toolCallId: `c${index}`, toolName: "write", args: { path } });
      emit({ type: "tool_execution_end", toolCallId: `c${index}`, toolName: "write", result: {}, isError: false });
    });
  }

  if (has("--stay-alive")) {
    // Simulates real `pi --mode rpc` behavior: after emitting the normal event sequence
    // (including agent_end) it does not exit, but keeps running to wait for the next
    // command (steer/abort). If dispatch() still used child.on("close") as its only
    // entry point for the verdict, this would hang all the way to timeout.
    emit({ type: "message_update", message: assistantMessage("done"), assistantMessageEvent: { type: "text_end" } });
    emit({ type: "message_end", message: assistantMessage("done") });
    emit({ type: "agent_end", messages: [assistantMessage("done")] });
    setInterval(() => {}, 1000);
  } else if (has("--echo-steer")) {
    let buffer = "";
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const command = JSON.parse(line);
        // NOTE (deviation from task-6-brief.md): the brief's condition was
        // `command.type === "steer" || command.type === "prompt"`. dispatch()
        // sends a {type:"prompt"} immediately on spawn, so that condition would
        // answer the initial prompt, emit its terminal event, and exit before the
        // test ever calls handle.steer() — the steer assertion could never
        // observe its own message. Restricting to "steer" only forces the fake
        // to wait for the actual steer write, which is the behavior the test
        // is meant to prove.
        if (command.type === "steer") {
          emit({ type: "message_end", message: assistantMessage(`Received: ${command.message}`) });
          // Real pi 0.80.2 emits agent_end. `agent_settled` is **not in pi's
          // documentation** — it's absent from the event table in docs/rpc.md, and
          // absent from pi-agent-core's AgentEvent union (types.d.ts:360-398); that name
          // was invented by this fake from the very start (src/verdict.mjs's
          // TERMINAL_SUCCESS_EVENTS already corrected the same claim once — this was the
          // second copy that had since drifted). The payload is a bare object:
          // computeVerdict only looks at e.type, never reads agent_end's fields, so
          // carrying messages here would only add a false sense of realism.
          emit({ type: "agent_end" });
          process.exit(0);
        }
      }
    });
  } else {
    emit({ type: "message_update", message: assistantMessage("done"), assistantMessageEvent: { type: "text_end" } });
    emit({ type: "message_end", message: assistantMessage("done") });
    emit({ type: "agent_end", messages: [assistantMessage("done")] });
    process.exit(0);
  }
}
