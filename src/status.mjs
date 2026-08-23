import { mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sessionKeyFrom } from "./events-log.mjs";

// One file per session, aggregated by the reader.
//
// Not one shared file: two Claude Code sessions in one project is a normal working
// pattern (it is why the events log is keyed the way it is — see src/events-log.mjs), and
// a single file would mean the two servers overwrite each other's count on every change.
//
// Aggregating across sessions in the READER is deliberate rather than a consequence. Every
// pi on this machine goes to the same endpoint, so the number worth showing is how many
// are running here in total: seeing that another session already has two in flight is what
// tells you not to dispatch a third right now.
const DIR = () => join(homedir(), ".claude", "pi-delegate", "status");

export function statusDir() {
  return DIR();
}

export function statusFilePath(env = process.env) {
  return join(DIR(), `${sessionKeyFrom(env) ?? "shared"}.status`);
}

// The file is read by a shell script that runs on every status-line tick, so the format is
// chosen for the reader, not the writer: flat `key=value` pairs on one line, parseable with
// bash word splitting and no JSON parser.
//
// Measured, and it is the reason this is not JSON: reading it with a node one-liner costs
// 40-60ms of interpreter startup on top of the ~100ms the user's existing status line
// already takes — a 50% latency increase on something that reruns every couple of seconds.
// Pure-bash reading of this format is unmeasurable.
const SAFE = /[^A-Za-z0-9._:@/-]+/g;

// A value containing a space would silently become two fields when bash splits the line.
const sanitize = (value) => String(value).replace(SAFE, "-");

// `omlx/Qwen3.8-27B` → `Qwen3.8-27B`. The provider is the same for every dispatch in
// practice, so it is pure width in a place that has none to spare.
const stripProvider = (model) => {
  const slash = String(model).indexOf("/");
  return slash === -1 ? String(model) : String(model).slice(slash + 1);
};

export function renderStatus(entries, { pid = process.pid, now = Date.now() } = {}) {
  // Running means "enrolled and not yet settled". That deliberately includes the window
  // between reserving the registry slot and the child actually spawning: during it a pi is
  // about to exist, and a status line that under-reports is worse than one that is early.
  const running = entries.filter((entry) => !entry?.verdict);

  const models = [...new Set(
    running.map((entry) => entry?.model).filter(Boolean).map(stripProvider),
  )].map(sanitize);

  // Seconds, not milliseconds: the reader does arithmetic on it in bash, where a
  // millisecond epoch overflows nothing but reads terribly in every error message.
  const starts = running.map((entry) => entry?.startedAt).filter((t) => Number.isFinite(t));
  const oldest = starts.length ? Math.floor(Math.min(...starts) / 1000) : 0;

  return [
    `pid=${pid}`,
    `running=${running.length}`,
    `oldest=${oldest}`,
    `updated=${Math.floor(now / 1000)}`,
    `models=${models.join(",") || "-"}`,
  ].join(" ");
}

// Writes atomically, and never throws.
//
// Never throws for the same reason appendEventsLog does not (issues/1): this is decoration.
// A status line that cannot be updated is a cosmetic failure, and it may not be allowed to
// turn into a dispatch failure. Returns true on success so a test can tell the difference.
export function writeStatus(entries, { path = statusFilePath(), pid, now } = {}) {
  try {
    mkdirSync(DIR(), { recursive: true });
    // Unique tmp name per write: two writes racing on one tmp path would have the second
    // rename a file the first is still filling.
    const tmp = `${path}.${process.pid}.${(writeStatus.seq = (writeStatus.seq ?? 0) + 1)}.tmp`;
    writeFileSync(tmp, `${renderStatus(entries, { pid, now })}\n`);
    // rename over the destination is atomic, so a reader mid-tick sees either the old line
    // or the new one, never half of either.
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

// Called on the way out. A file left behind is not fatal — the reader skips any file whose
// pid is gone — but leaving one means a crashed server's count lingers until the pid is
// checked, and pids are recycled.
export function clearStatus({ path = statusFilePath() } = {}) {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
