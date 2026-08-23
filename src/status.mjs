import { mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sessionKeyFrom } from "./events-log.mjs";

// One file per session, and the reader shows only its own.
//
// Not one shared file: two Claude Code sessions in one project is a normal working
// pattern (it is why the events log is keyed the way it is — see src/events-log.mjs), and
// a single file would mean the two servers overwrite each other's count on every change.
//
// 0.13.0 had the reader SUM across sessions, on the theory that every pi reaches the same
// endpoint so the machine-wide count is what you want before starting another. Reported
// immediately, and correctly, as worse than noise: the other session's status line showed
// `1 running` for a dispatch that session's own pi_result cannot collect — it answers
// "Unknown session_id". A count you can see and cannot act on, surfaced in a window that
// dispatched nothing, is exactly the shape of issues/1: a session told about work that is
// not its own. The contention argument only ever justified knowing how many exist, never
// counting someone else's as yours.
//
// Ownership therefore travels in the file, on line 2. The reader compares it to its own
// CLAUDE_CODE_MESSAGING_SOCKET by string equality — verified present in the status-line
// process's environment, the same value the writer keys its filename from. Written raw
// rather than hashed so the comparison needs no sha256 subprocess on every tick, and put
// on its own line so a path containing a space cannot break line 1's word splitting.
//
// CLAUDE_CODE_MESSAGING_TOKEN sits beside it in the environment and is a secret. Not this.
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

// The value the reader compares against. Empty when Claude Code did not provide one, in
// which case the reader falls back to attributing nothing and counting everything — the
// hand-run and preview path, where there is no second session to be confused with.
export function ownerToken(env = process.env) {
  const socket = env.CLAUDE_CODE_MESSAGING_SOCKET;
  return typeof socket === "string" && socket.trim() !== "" ? socket.trim() : "";
}

export function renderStatus(entries, { pid = process.pid, now = Date.now(), owner = ownerToken() } = {}) {
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

  const facts = [
    `pid=${pid}`,
    `running=${running.length}`,
    `oldest=${oldest}`,
    `updated=${Math.floor(now / 1000)}`,
    `models=${models.join(",") || "-"}`,
  ].join(" ");

  // Lines 3+ are one per running dispatch: its own start, its own model. Two dispatches
  // ten minutes apart share nothing but a session, and a single aggregate `oldest` can
  // only ever tell the truth about the older of them — so the reader is handed the parts
  // and gives each dispatch a row carrying its own elapsed time.
  //
  // Oldest first, because that is the order the rows are read in: the dispatch that has
  // been holding the endpoint longest is the one worth noticing, and it should not shuffle
  // down the list as newer ones arrive.
  //
  // APPENDED rather than replacing anything on line 1, and that part is load-bearing. The
  // reader is a separate file the user copies into ~/.claude by hand (step 4 of
  // /pi-delegate:statusline), so writer and reader routinely run at different versions. An
  // older reader stops after line 2 and still gets its aggregate; a newer reader falls back
  // to the aggregate when these lines are absent. Neither direction of skew goes blank —
  // which matters more here than almost anywhere, because a status line that renders
  // nothing looks exactly like one with nothing to say.
  const detail = running
    .map((entry) => ({
      started: Number.isFinite(entry?.startedAt) ? Math.floor(entry.startedAt / 1000) : 0,
      model: sanitize(stripProvider(entry?.model ?? "")) || "-",
    }))
    .sort((a, b) => a.started - b.started)
    .map(({ started, model }) => `started=${started} model=${model}`);

  // Line 2 is the owner, verbatim and alone, so nothing in it can be mistaken for a field.
  return [facts, owner, ...detail].join("\n");
}

// Writes atomically, and never throws.
//
// Never throws for the same reason appendEventsLog does not (issues/1): this is decoration.
// A status line that cannot be updated is a cosmetic failure, and it may not be allowed to
// turn into a dispatch failure. Returns true on success so a test can tell the difference.
export function writeStatus(entries, { path = statusFilePath(), pid, now, owner } = {}) {
  try {
    mkdirSync(DIR(), { recursive: true });
    // Unique tmp name per write: two writes racing on one tmp path would have the second
    // rename a file the first is still filling.
    const tmp = `${path}.${process.pid}.${(writeStatus.seq = (writeStatus.seq ?? 0) + 1)}.tmp`;
    writeFileSync(tmp, `${renderStatus(entries, { pid, now, ...(owner === undefined ? {} : { owner }) })}\n`);
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
