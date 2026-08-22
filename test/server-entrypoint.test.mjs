// Does `node src/server.mjs` actually speak protocol?
//
// Every other test in this directory imports the module and calls its exports. That is the
// right shape for testing handlers, and it is exactly why the bug this file exists for went
// unnoticed: importing a module never evaluates its main-module guard, so a guard that is
// false on some platform is invisible to the entire suite while every test stays green.
//
// The bug: the guard was written `import.meta.url === `file://${process.argv[1]}``, which
// matches only on POSIX. On Windows argv[1] is `C:\Users\...\server.mjs`, so that template
// yields `file://C:\Users\...` against an import.meta.url of `file:///C:/Users/.../…` —
// two slashes versus three, backslashes versus forward. main() never ran, the process
// exited 0 without writing a byte, and the client reported `CONNECTION_CLOSED` — a message
// that names the symptom and hides the cause. The plugin's MCP server had never once
// started on Windows, in any released version.
//
// So this test spawns the real entry point the way the client does. It is deliberately an
// end-to-end check of one narrow thing: a process that starts and answers. Anything about
// what the tools do belongs in server.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "server.mjs");

// Two requests, then close stdin. The server is expected to answer both and exit on its
// own once the stream closes.
const REQUESTS = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
];

function runServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    // A guard that never fires makes the process exit almost immediately, so a generous
    // timeout costs nothing in the passing case and still bounds a genuine hang.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server did not exit within 15s; stdout so far: ${stdout}`));
    }, 15_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    for (const request of REQUESTS) child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
  });
}

test("`node src/server.mjs` answers initialize — the main-module guard fires on this platform", async () => {
  const { stdout, stderr, code } = await runServer();

  // The assertion that catches the original bug: zero stdout. Everything below it is only
  // reachable once the guard is correct, so this message is the one that has to explain
  // what happened.
  assert.notEqual(
    stdout.trim(),
    "",
    `server wrote nothing to stdout (exit ${code}). The main-module guard in src/server.mjs ` +
      `is false on this platform, so main() never ran — this is what the client reports as ` +
      `CONNECTION_CLOSED. stderr: ${stderr}`,
  );

  const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
  const initialize = lines.find((m) => m.id === 1);
  assert.ok(initialize, `no response to initialize; got ${JSON.stringify(lines)}`);
  assert.equal(initialize.result.serverInfo.name, "pi-delegate");
  // Echoed back rather than replaced — see the note in stdio-server.mjs.
  assert.equal(initialize.result.protocolVersion, "2024-11-05");

  // tools/list proves main() wired the handlers, not just that something answered.
  const list = lines.find((m) => m.id === 2);
  assert.ok(list, `no response to tools/list; got ${JSON.stringify(lines)}`);
  assert.ok(
    list.result.tools.some((t) => t.name === "pi_dispatch"),
    "tools/list did not advertise pi_dispatch",
  );
});
