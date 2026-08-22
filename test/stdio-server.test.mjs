import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessageHandler, serve } from "../src/stdio-server.mjs";
import { Readable, Writable } from "node:stream";

const TOOLS = [{ name: "demo", description: "d", inputSchema: { type: "object" } }];

const handler = (callTool = async () => ({ content: [{ type: "text", text: "ok" }] })) =>
  createMessageHandler({ serverInfo: { name: "pi-delegate", version: "9.9.9" }, tools: TOOLS, callTool });

test("initialize echoes the client's protocol version rather than imposing its own", async () => {
  const res = await handler()({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  assert.equal(res.result.protocolVersion, "2024-11-05");
  assert.deepEqual(res.result.serverInfo, { name: "pi-delegate", version: "9.9.9" });
  assert.deepEqual(res.result.capabilities, { tools: {} });
});

test("initialize still answers when the client names no protocol version", async () => {
  const res = await handler()({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(typeof res.result.protocolVersion, "string");
});

test("a notification is never answered — replying to one is how a client wedges", async () => {
  assert.equal(await handler()({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal(await handler()({ jsonrpc: "2.0", method: "notifications/cancelled" }), null);
});

test("tools/list returns the definitions verbatim", async () => {
  const res = await handler()({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(res.result.tools, TOOLS);
});

test("tools/call passes name and arguments through and returns the tool's result", async () => {
  const seen = [];
  const res = await handler(async (name, args) => {
    seen.push([name, args]);
    return { content: [{ type: "text", text: "done" }] };
  })({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "demo", arguments: { a: 1 } } });
  assert.deepEqual(seen, [["demo", { a: 1 }]]);
  assert.equal(res.result.content[0].text, "done");
});

test("tools/call with no arguments hands the tool an empty object, not undefined", async () => {
  let received = "never called";
  await handler(async (_name, args) => {
    received = args;
    return { content: [] };
  })({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "demo" } });
  assert.deepEqual(received, {});
});

test("a throwing tool becomes an isError result, not a JSON-RPC error", async () => {
  const res = await handler(async () => {
    throw new Error("boom");
  })({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "demo" } });
  // The protocol's error channel means "the request was malformed"; a tool that ran and
  // went wrong is a successful call carrying a failure.
  assert.equal(res.error, undefined);
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /boom/);
});

test("an unknown method is a proper JSON-RPC method-not-found", async () => {
  const res = await handler()({ jsonrpc: "2.0", id: 5, method: "nope" });
  assert.equal(res.error.code, -32601);
});

test("ping is answered, so a client health check does not look like a dead server", async () => {
  const res = await handler()({ jsonrpc: "2.0", id: 6, method: "ping" });
  assert.deepEqual(res.result, {});
});

// --- transport ------------------------------------------------------------------------

function runServe(lines, { callTool = async () => ({ content: [] }) } = {}) {
  const written = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      written.push(String(chunk));
      cb();
    },
  });
  const input = Readable.from(lines.map((l) => `${l}\n`));
  const errors = [];
  return serve({
    serverInfo: { name: "t", version: "1" }, tools: TOOLS, callTool,
    input, output, onError: (e) => errors.push(e),
  }).then(() => new Promise((r) => setTimeout(() => r({ written, errors }), 10)));
}

test("blank lines are skipped and unparseable input never kills the connection", async () => {
  const { written, errors } = await runServe([
    "",
    "   ",
    "{not json",
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  ]);
  assert.equal(errors.length, 1, "the bad line is reported once");
  assert.match(errors[0].message, /unparseable/);
  // and the request after it is still served
  assert.equal(written.length, 1);
  assert.equal(JSON.parse(written[0]).id, 1);
});

test("every response is written as exactly one newline-terminated line", async () => {
  const { written } = await runServe([
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  ]);
  assert.equal(written.length, 2);
  for (const line of written) {
    assert.ok(line.endsWith("\n"));
    assert.equal(line.trimEnd().includes("\n"), false, "a multi-line payload would corrupt the stream");
    assert.doesNotThrow(() => JSON.parse(line));
  }
});

test("slow and fast tool calls do not interleave their writes", async () => {
  const delays = { slow: 30, fast: 0 };
  const { written } = await runServe(
    [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fast" } }),
    ],
    {
      callTool: async (name) => {
        await new Promise((r) => setTimeout(r, delays[name]));
        return { content: [{ type: "text", text: name }] };
      },
    },
  );
  assert.equal(written.length, 2);
  // Each line is independently valid JSON — that is the property that breaks when two
  // concurrent handlers write at once.
  const ids = written.map((l) => JSON.parse(l).id).sort();
  assert.deepEqual(ids, [1, 2]);
});
