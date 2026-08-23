// A zero-dependency MCP stdio server.
//
// This replaces @modelcontextprotocol/sdk, and the reason is distribution, not taste.
// Claude Code installs a plugin by copying the repository — it does NOT run `npm install`.
// So a plugin that imports anything from node_modules starts, throws
// ERR_MODULE_NOT_FOUND, and exits 1 before it can speak a word of protocol. What the user
// sees is `Failed to reconnect to plugin:...: CONNECTION_CLOSED`, which names the symptom
// and hides the cause completely. Committing node_modules would fix it too, at the cost of
// carrying 24 MB (express, cors, ajv, …) to hold a newline-delimited JSON-RPC loop.
//
// The whole surface this plugin ever used was four symbols and three methods, so the
// dependency is not worth its distribution cost.
//
// Protocol notes that are easy to get wrong:
//   - stdout is the transport. Anything else written there corrupts the stream, so every
//     diagnostic in this file goes to stderr.
//   - a message with no `id` is a notification and MUST NOT be answered. Replying to
//     `notifications/initialized` is the classic way to wedge a client.
//   - the client's requested protocolVersion is echoed back rather than overridden with a
//     version of our own choosing: this server has no version-specific behaviour, and
//     answering with a version the client did not ask for is how handshakes fail.

import { createInterface } from "node:readline";

const FALLBACK_PROTOCOL_VERSION = "2025-06-18";
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

export function createMessageHandler({ serverInfo, tools, callTool }) {
  return async function handle(message) {
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    const reply = (result) => (isNotification ? null : { jsonrpc: "2.0", id, result });
    const fail = (code, msg) => (isNotification ? null : { jsonrpc: "2.0", id, error: { code, message: msg } });

    switch (method) {
      case "initialize":
        return reply({
          protocolVersion: params?.protocolVersion ?? FALLBACK_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo,
        });

      // Notifications: acknowledged by staying silent.
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;

      case "ping":
        return reply({});

      case "tools/list":
        return reply({ tools });

      case "tools/call": {
        try {
          return reply(await callTool(params?.name, params?.arguments ?? {}));
        } catch (error) {
          // A thrown tool is reported as a successful call carrying an error result, not
          // as a JSON-RPC error: the distinction the protocol draws is "the request was
          // malformed" versus "the tool ran and went wrong", and this is the latter.
          return reply({
            content: [{ type: "text", text: `${params?.name} failed: ${error?.message ?? error}` }],
            isError: true,
          });
        }
      }

      default:
        return fail(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  };
}

export function serve({
  serverInfo,
  tools,
  callTool,
  input = process.stdin,
  output = process.stdout,
  onError = (e) => process.stderr.write(`${e?.stack ?? e}\n`),
} = {}) {
  const handle = createMessageHandler({ serverInfo, tools, callTool });
  const rl = createInterface({ input, crlfDelay: Infinity });

  // Responses are serialized through a promise chain rather than written as each handler
  // settles. Tool calls here are long-running (a dispatch can take minutes) and the client
  // may pipeline requests; without this, two concurrent handlers can interleave their
  // writes and produce a line that is not valid JSON.
  let queue = Promise.resolve();
  const write = (payload) => {
    queue = queue
      .then(() => {
        output.write(`${JSON.stringify(payload)}\n`);
      })
      // Without this catch a failing write is an unhandled rejection, and Node has killed
      // the process for that since v15 — silently, as far as the client is concerned: no
      // stderr, no exit code, the tools just vanish from the tool list. Reported from a
      // session whose volume filled up (EPIPE once the client is gone does the same).
      //
      // Recovering the chain matters as much as catching: `queue` is the single thread
      // every later response is appended to, so a rejection left in place would poison
      // every write for the rest of the session, long after the disk recovered.
      .catch(onError);
  };

  // Requests still being served when input closes. Without tracking them, a `serve()` that
  // resolved on stream close alone would drop every in-flight response on the floor — a
  // dispatch that takes minutes is exactly the case that loses its answer.
  const inFlight = new Set();

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      // Unparseable input has no id, so there is nobody to answer — report and move on
      // rather than tearing the connection down.
      onError(new Error(`Ignoring unparseable message: ${error.message}`));
      return;
    }

    const work = Promise.resolve(handle(message))
      .then((response) => {
        if (response) write(response);
      })
      .catch((error) => {
        onError(error);
        if (message.id !== undefined && message.id !== null) {
          write({ jsonrpc: "2.0", id: message.id, error: { code: INTERNAL_ERROR, message: String(error?.message ?? error) } });
        }
      })
      .finally(() => inFlight.delete(work));
    inFlight.add(work);
  });

  return new Promise((resolve) => rl.on("close", resolve))
    // Drain twice over: first the handlers, then the write queue they append to.
    .then(() => Promise.all([...inFlight]))
    .then(() => queue);
}
