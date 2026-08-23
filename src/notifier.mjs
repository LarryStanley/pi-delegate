import { createServer, connect } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// The notification transport (github.com/LarryStanley/pi-delegate/issues/1, Cause B).
//
// Completions used to travel by file: append to events/<id>.log, and a separate `tail -F`
// printed whatever appeared. The reported failure had the write side working perfectly and
// the read side simply gone — twelve monitors alive on the machine, not one watching that
// session's file — with nothing anywhere announcing it.
//
// The incident is not the point; the defect class is. The announcer could not observe
// whether the announcement landed, and a file offers no way to. A socket's connection
// state IS that feedback, on both ends, for nothing. It also buys two things the file
// could not: the watcher RECONNECTS when /reload-plugins restarts the server instead of
// being orphaned, and "is anyone listening?" becomes answerable, so pi_status can say the
// notification is not coming instead of leaving it indistinguishable from "still running".
//
// The log file is still written. It is what pi_result falls back to when the registry was
// emptied by a reload (Cause A), and it is the durable record; the socket is the live one.

const PIPE_PREFIX = "\\\\.\\pipe\\";

// A unix domain socket path is capped near 104 bytes by the kernel, and the failure mode is
// a bind error at startup — i.e. no notifications for the entire session. A full UUID under
// a long home directory gets close enough to matter, so the id is truncated. 12 hex chars
// is far more than enough to separate the handful of sessions alive at one time.
export function socketPathFor(sessionId, platform = process.platform, dir = ".") {
  const short = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 12);
  // Windows named pipes live in their own namespace, not the filesystem: nothing to create,
  // nothing to clean up, and no length problem.
  if (platform === "win32") return `${PIPE_PREFIX}pi-delegate-${short}`;
  return join(dir, `${short}.sock`);
}

// A crashed server leaves its socket file behind, and the next listen() fails EADDRINUSE.
// The ONLY safe way to tell a stale socket from one a live server is still serving is to
// try connecting: deleting on existence alone would silently steal the socket out from
// under a running sibling.
async function reclaimIfStale(socketPath) {
  if (socketPath.startsWith(PIPE_PREFIX)) return;
  if (!existsSync(socketPath)) return;
  const alive = await new Promise((resolve) => {
    const probe = connect(socketPath);
    const settle = (value) => { probe.destroy(); resolve(value); };
    probe.once("connect", () => settle(true));
    probe.once("error", () => settle(false));
    setTimeout(() => settle(false), 200);
  });
  if (alive) return;
  try { unlinkSync(socketPath); } catch { /* raced with another reclaim; listen() will tell us */ }
}

export function createNotifier({ socketPath }) {
  let server = null;
  const watchers = new Set();

  return {
    socketPath,
    listening: () => Boolean(server?.listening),
    watcherCount: () => watchers.size,

    async listen() {
      await reclaimIfStale(socketPath);
      const next = createServer((socket) => {
        watchers.add(socket);
        // An attached watcher must not keep the MCP server alive after its stdin closes.
        // Notifications are a convenience; they may not extend the process's life.
        socket.unref?.();
        const drop = () => watchers.delete(socket);
        socket.on("close", drop);
        // A watcher that dies mid-write must not take the MCP server with it.
        socket.on("error", drop);
      });
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        next.once("error", onError);
        next.listen(socketPath, () => {
          next.off("error", onError);
          // Past startup, a server-level error is not worth crashing over: losing
          // notifications is survivable, and pi_status reports watcherCount anyway.
          next.on("error", () => {});
          // Same reason, and this one is load-bearing: a referenced listening handle keeps
          // the event loop alive forever, so the MCP server would never exit when Claude
          // Code closed its stdin. It hung for the full test timeout exactly once.
          next.unref?.();
          resolve();
        });
      });
      server = next;
    },

    // Never throws. Nobody connected is the ordinary headless case, not an error.
    broadcast(line) {
      const payload = line.endsWith("\n") ? line : `${line}\n`;
      for (const socket of [...watchers]) {
        try { socket.write(payload); } catch { watchers.delete(socket); }
      }
    },

    async close() {
      for (const socket of [...watchers]) socket.destroy();
      watchers.clear();
      if (server) await new Promise((resolve) => server.close(resolve));
      server = null;
    },
  };
}
