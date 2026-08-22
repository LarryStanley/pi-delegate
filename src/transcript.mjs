// Budgets for pi_transcript.
//
// The premise of this plugin is that pi spends the tokens and Claude Code does not. A tool
// reply that carries pi's OUTPUT back is a straight inversion of that: the caller pays, in
// its own context window, for the very characters it delegated in order not to write. And
// it pays for the rest of the session, because a tool reply never leaves the transcript.
//
// Every other surface here already respects this — pi_status is counts-only until asked
// for verbose, last_message stops at LAST_MESSAGE_LIMIT, stderr is tailed to 5 lines.
// pi_transcript had no budget of any kind, which mattered more than it sounds: it is the
// tool SKILL.md tells you to reach for the moment a dispatch looks wrong.
//
// The specific trap is filter=tools. pi's write tool takes { path, content } (shipped
// artifact, dist/core/tools/write.js), and a tool_execution_start event's `args` is the
// literal argument object the model produced — so JSON.stringify(args) is the whole file.
// Asking "what files did it touch?" printed every byte it wrote.

export const TRANSCRIPT_BUDGET = 3000;

// Long enough for a path, a glob, a short flag; far too short for a file body. Anything
// over this is a payload, and a payload's SIZE is diagnostic while its CONTENT is not.
export const ARG_INLINE_LIMIT = 120;

// Depth-limited so a pathological event cannot make this recurse forever; pi's args are
// flat objects in practice.
export function elideLongStrings(value, limit = ARG_INLINE_LIMIT, depth = 0) {
  if (typeof value === "string") {
    return value.length > limit ? `<${value.length} chars elided>` : value;
  }
  if (depth >= 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => elideLongStrings(v, limit, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = elideLongStrings(v, limit, depth + 1);
  return out;
}

// A cap that silently swallows the rest is the failure shape this repo keeps hitting —
// something stops working and says nothing (the mangled ${HOME}, the inert guard, the
// stale monitor). So truncation states the real size AND names the cheaper way to get the
// content: it is already on disk. Reading the file costs the file; pulling the transcript
// costs the file plus everything pi said around it.
export function capped(body, budget = TRANSCRIPT_BUDGET) {
  if (body.length <= budget) return body;
  return (
    `${body.slice(0, budget)}\n\n… truncated: ${body.length} chars total, ${budget} shown. ` +
    "pi's output is already on disk — Read the files named in the verdict rather than " +
    "pulling the rest of the transcript into context, or narrow this with " +
    "pi_transcript filter=last_n."
  );
}

// Keeps exactly what the roaming diagnostic needs — which tool, which path, in what order
// — and drops what it never needed.
export function formatToolCalls(events) {
  const calls = events
    .filter((e) => e?.type === "tool_execution_start")
    .map((e) => `${e.toolName} ${JSON.stringify(elideLongStrings(e.args ?? {}))}`);
  return capped(calls.join("\n") || "(no tool calls)");
}

export function formatLastN(events, n = 20) {
  const slice = events.slice(-n).map((e) => JSON.stringify(elideLongStrings(e)));
  return capped(slice.join("\n") || "(no events)");
}
