import { test } from "node:test";
import assert from "node:assert/strict";
import { serve } from "../src/stdio-server.mjs";
import { Readable } from "node:stream";

// Reported by a peer session running continuous dispatches: the MCP server vanished
// mid-session — no stderr, no exit code, the tools simply gone from the tool list — and
// it coincided with the volume filling up (122 MiB free; even Bash could not open its
// output file).
//
// The suspicion was that a log write was killing the process. It was not: every write in
// server.mjs is already wrapped. The hole is here, in the transport's write queue.
//
//   queue = queue.then(() => { output.write(...) })
//
// Nothing ever attached a rejection handler to `queue` at the moment it rejected — the
// only `.then` on it runs when stdin closes, which may be minutes later or never. So an
// output.write that throws (EPIPE once the client is gone, ENOSPC when stdout is a file
// on a full volume) becomes an unhandled rejection, and Node has killed the process for
// that since v15. Silent from the client's side, which is exactly what was reported.
//
// `output` is only ever used via `.write`, so a plain object is a faithful stand-in for a
// stream whose write throws — and unlike a real Writable it throws at the call site,
// which is where the queue picks it up.

const TOOLS = [{ name: "demo", description: "d", inputSchema: { type: "object" } }];

function runServe(lines, { failOn = () => false } = {}) {
  const written = [];
  let n = 0;
  const output = {
    write(chunk) {
      n += 1;
      if (failOn(n)) {
        const error = new Error("ENOSPC: no space left on device, write");
        error.code = "ENOSPC";
        throw error;
      }
      written.push(String(chunk));
      return true;
    },
  };
  const errors = [];
  return serve({
    serverInfo: { name: "t", version: "1" },
    tools: TOOLS,
    callTool: async () => ({ content: [] }),
    input: Readable.from(lines.map((l) => `${l}\n`)),
    output,
    onError: (e) => errors.push(e),
  }).then(() => new Promise((r) => setTimeout(() => r({ written, errors }), 10)));
}

const ping = (id) => JSON.stringify({ jsonrpc: "2.0", id, method: "ping" });

// The property the whole report comes down to: a failed write must not be able to take
// the server down with it. Losing one response is bad; losing the process means every
// later dispatch in that session has nowhere to go.
test("a write that throws does not take the server down", async () => {
  const { errors } = await runServe([ping(1)], { failOn: () => true });
  assert.equal(errors.length, 1, "the failure is reported rather than swallowed silently");
  assert.match(errors[0].message, /ENOSPC/);
});

// A rejected promise chain stays rejected: without a catch, the first failure poisons
// `queue` and every subsequent response rejects too — so one transient ENOSPC would take
// out every write for the rest of the session even after the disk recovered.
test("one failed write does not poison the queue for the writes after it", async () => {
  const { written, errors } = await runServe([ping(1), ping(2), ping(3)], { failOn: (n) => n === 1 });
  assert.equal(errors.length, 1, "only the one write that actually failed is reported");
  assert.equal(written.length, 2, "the two responses after the failure still get written");
  assert.deepEqual(written.map((l) => JSON.parse(l).id), [2, 3]);
});

// serve() resolving is what lets main()'s finally release the socket and clear the status
// file. A rejection there skips both and leaves a status file claiming a dispatch is live.
test("serve still resolves when every write fails, so shutdown cleanup still runs", async () => {
  await assert.doesNotReject(runServe([ping(1), ping(2)], { failOn: () => true }));
});
