#!/usr/bin/env node
// Fetches the Arena.ai agent leaderboard and writes a snapshot to
// ~/.claude/pi-delegate/arena-snapshot.json.
//
// The leaderboard data is embedded in the page's Next.js RSC flight payload
// (self.__next_f.push chunks). No API key required.
//
// Degradation policy matches the rest of this codebase: a failed fetch never
// destroys a good snapshot. The previous snapshot is kept and marked stale;
// callers (doctor, SessionStart hook) decide what to do with staleness.
//
// For that promise to mean anything, "the parse succeeded into nothing usable" has to
// count as a failure too. It is the likeliest shape of a site change — the page still
// parses, the fields have moved — and treating it as success is how a good snapshot gets
// overwritten with zero rows. Every guard below (extractSnapshot's shape check, the
// empty-rows check in refreshSnapshot) exists to make that path fail closed.
//
// Usage:
//   node scripts/arena-fetch.mjs            # fetch, write snapshot
//   node scripts/arena-fetch.mjs --check    # for hooks; see exit codes below
//   node scripts/arena-fetch.mjs --advice   # read-only: which ranked models you have
//
// Exit codes, the same in both modes:
//   0  a usable, fresh snapshot is on disk — either within TTL (--check only) or just fetched
//   1  the refresh failed and the snapshot already on disk is usable but stale
//   2  the refresh failed and there is no usable snapshot to fall back on
// Note for wiring this into hooks.json: 2 is Claude Code's blocking-error code and no hook
// in this repo returns it today, so a freshness hook wants to report both 1 and 2 and carry
// on rather than pass them through.

import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const LEADERBOARD_URL = "https://arena.ai/leaderboard/agent";
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // snapshot older than this is "stale"
// hooks.json registers every hook with timeout: 10, and an un-signalled fetch outlives
// that budget by minutes (undici waits 300s for headers, indefinitely on a trickling body).
const FETCH_TIMEOUT_MS = 8000;
const SNAPSHOT_PATH = join(homedir(), ".claude", "pi-delegate", "arena-snapshot.json");

export function snapshotPath() {
  return SNAPSHOT_PATH;
}

export function loadSnapshot(file = SNAPSHOT_PATH) {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function isFresh(snapshot, ttlMs = TTL_MS) {
  if (!snapshot || !snapshot.fetchedAt) return false;
  return Date.now() - Date.parse(snapshot.fetchedAt) < ttlMs;
}

// "Usable" is a separate question from "fresh": a snapshot with no rows in it is no
// fallback at all, however recently it was written.
export function hasUsableRows(snapshot) {
  return Boolean(snapshot && Array.isArray(snapshot.rows) && snapshot.rows.length > 0);
}

// Write through a temp file and rename. The failure path below rewrites the very file this
// module calls data you must not lose, so a bare writeFileSync killed halfway (a hook
// timeout, a Ctrl-C) would leave it truncated and loadSnapshot would then read null. Same
// idiom, and the same reasoning, as writeStatus in src/status.mjs.
function writeSnapshotFile(file, snapshot) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing to clean up, or it is already gone. The destination is untouched either way.
    }
    throw err;
  }
}

// The page ships its data as JSON strings inside self.__next_f.push([1,"...") chunks. The
// string content itself contains escaped quotes (the payload is JSON-in-JSON), so the chunk
// boundary cannot be found with a non-greedy quote match — the literal has to be walked
// honouring backslash escapes. An unterminated literal is dropped rather than closed with a
// fabricated quote: a fabricated quote lets JSON.parse succeed on truncated content and
// appends the garbage to the payload.
export function reassemblePayload(pageHtml) {
  const marker = 'self.__next_f.push([1,"';
  let buf = "";
  let from = 0;
  for (;;) {
    const start = pageHtml.indexOf(marker, from);
    if (start === -1) break;
    const quote = start + marker.length - 1; // the literal's opening quote
    let end = -1;
    for (let i = quote + 1; i < pageHtml.length; i++) {
      const c = pageHtml[i];
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') {
        end = i;
        break;
      }
    }
    if (end === -1) break; // truncated page: nothing from here on is trustworthy
    from = end + 1;
    try {
      buf += JSON.parse(pageHtml.slice(quote, end + 1));
    } catch {
      // A chunk that fails to unescape loses its slice. The snapshot object then either
      // survives intact or fails the shape check below; it never half-survives.
    }
  }
  return buf;
}

// Bracket-match a JSON value starting at `from`, honouring string literals. A lone "[" or
// "{" inside a model name must not count towards the depth, or the scan ends at the wrong
// offset and a perfectly good page reports itself as a site change.
function matchBrackets(s, from) {
  let depth = 0;
  let inString = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return s.slice(from, i + 1);
    }
  }
  return null;
}

// First of two screens on a parse, and the coarse one: is this a ranked table at all?
// Without it, any surviving {"snapshot":{...}} in half a megabyte of payload parses
// "successfully" and the caller cannot tell it from the real leaderboard. The finer screen —
// are the fields still where we think they are — is the empty-rows check in refreshSnapshot,
// because that is the question slimRows answers.
function looksLikeLeaderboard(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) return false;
  const ranked = parsed.rows.filter((r) => r && typeof r.rank === "number");
  return ranked.length > parsed.rows.length / 2;
}

const SNAPSHOT_MARKER = '"snapshot":{';

// Anchor on the leaderboard object, not on the first bare "rows":[ in the payload: the
// object carries its own metadata (lastUpdated, totalSessions, totalObservations,
// modelCount) worth keeping, and modelCount doubles as arena.ai's own count of the rows it
// shipped. Every candidate is tried in turn, so a decoy earlier in the payload costs a
// parse rather than the whole fetch.
export function extractSnapshot(pageHtml) {
  const buf = reassemblePayload(pageHtml);
  let at = -1;
  for (;;) {
    at = buf.indexOf(SNAPSHOT_MARKER, at + 1);
    if (at === -1) return null;
    const literal = matchBrackets(buf, at + SNAPSHOT_MARKER.length - 1);
    if (!literal) continue;
    let parsed;
    try {
      parsed = JSON.parse(literal);
    } catch {
      continue;
    }
    if (looksLikeLeaderboard(parsed)) return parsed;
  }
}

// For callers that only want the rows.
export function extractRows(pageHtml) {
  return extractSnapshot(pageHtml)?.rows ?? null;
}

export async function fetchSnapshot({ fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const res = await fetchImpl(LEADERBOARD_URL, {
    headers: { "user-agent": "pi-delegate-arena-fetch/1.0" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`arena.ai responded ${res.status}`);
  const snapshot = extractSnapshot(await res.text());
  if (!snapshot) throw new Error("leaderboard snapshot not found in page (site structure changed?)");
  return snapshot;
}

// Guarded rather than assumed: a model with too few sessions ships an avgScore object with
// no value in it, and one unguarded .toFixed() turns that single row into a TypeError the
// caller can only report as a fetch failure — the snapshot then never updates again until
// that model leaves the board.
function rounded(value, digits = 4) {
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

// Keep only the fields the tiering policy needs, sorted by rank.
export function slimRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      rank: r?.rank,
      model: r?.model,
      organization: r?.modelOrganization,
      score: rounded(r?.avgScore?.value),
      ci: rounded(r?.avgScore?.ci),
      inputPricePerMillion: r?.inputPricePerMillion ?? null,
      outputPricePerMillion: r?.outputPricePerMillion ?? null,
      sessions: r?.sessions ?? null,
    }))
    // A row with no name cannot be routed to, and a rankless one sorts by NaN and loses its
    // rank key entirely once serialised — neither is a row the tiering policy can use.
    .filter((r) => r.model && typeof r.rank === "number")
    .sort((a, b) => a.rank - b.rank);
}

export async function refreshSnapshot({
  fetchImpl = fetch,
  file = SNAPSHOT_PATH,
  quiet = false,
  timeoutMs = FETCH_TIMEOUT_MS,
} = {}) {
  const previous = loadSnapshot(file);
  let fetched;
  let rows;
  try {
    fetched = await fetchSnapshot({ fetchImpl, timeoutMs });
    rows = slimRows(fetched.rows);
    // The case the shape check upstream cannot catch: a ranked table whose fields have moved
    // (model renamed, prices nested differently) slims down to nothing. Writing that would
    // replace a good snapshot with zero rows and report success, which is precisely what the
    // policy at the top of this file rules out.
    if (rows.length === 0) {
      throw new Error("leaderboard parsed but no usable rows (site structure changed?)");
    }
  } catch (err) {
    if (previous) {
      // Failing to record the error must not cost more than the error did: the good
      // snapshot is already on disk and leaving it there is the whole point.
      try {
        writeSnapshotFile(file, { ...previous, lastFetchError: String(err) });
      } catch {
        // Marking is decoration; the data it would have annotated is intact.
      }
    }
    if (!quiet) console.error(`arena-fetch: ${err}`);
    return { ok: false, error: String(err), snapshot: previous };
  }
  const snapshot = {
    source: LEADERBOARD_URL,
    fetchedAt: new Date().toISOString(),
    // arena.ai's own metadata about the board. lastUpdated is when it computed these
    // numbers, which is not when we fetched them, and modelCount is its count of the rows
    // it shipped — both belong next to ours rather than being carried over from the
    // previous file, which only ever preserved a null.
    leaderboardSnapshot: {
      lastUpdated: fetched.lastUpdated ?? null,
      totalSessions: fetched.totalSessions ?? null,
      totalObservations: fetched.totalObservations ?? null,
      modelCount: fetched.modelCount ?? null,
    },
    rows,
  };
  try {
    writeSnapshotFile(file, snapshot);
  } catch (err) {
    if (!quiet) console.error(`arena-fetch: ${err}`);
    return { ok: false, error: String(err), snapshot: previous };
  }
  if (!quiet) console.log(`arena-fetch: wrote ${rows.length} rows to ${file}`);
  return { ok: true, snapshot };
}

// Exit code for a refresh that failed: 1 if there is still something to fall back on, 2 if
// there is not. Emptiness counts as nothing to fall back on, whatever the file's mtime says.
function failureExitCode(snapshot) {
  return hasUsableRows(snapshot) ? 1 : 2;
}

const check = process.argv.includes("--check");
const advice = process.argv.includes("--advice");
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (advice) {
    // Reads only. Whether to go and refresh is the caller's call, so that "show me what I
    // have" never turns into a network wait.
    const { adviceTable } = await import("../src/arena-advice.mjs");
    const { piModelsPath } = await import("../src/config.mjs");
    // Same degradation as loadModels in hooks/doctor-check.mjs: an unreadable models.json
    // means "no models configured", never a crash.
    let modelsCfg = {};
    try {
      modelsCfg = JSON.parse(readFileSync(piModelsPath(), "utf8"));
    } catch {
      // Missing or unparseable; adviceTable will say nothing matched.
    }
    const existing = loadSnapshot();
    for (const line of adviceTable({ snapshot: existing, modelsCfg })) console.log(line);
    if (existing && !isFresh(existing)) console.log("\n(snapshot is stale — refresh with: node scripts/arena-fetch.mjs)");
    process.exit(hasUsableRows(existing) ? 0 : 1);
  } else if (check) {
    const existing = loadSnapshot();
    if (hasUsableRows(existing) && isFresh(existing)) {
      console.log(`arena snapshot fresh (${existing.fetchedAt}, ${existing.rows.length} models)`);
      process.exit(0);
    }
    const { ok, error, snapshot } = await refreshSnapshot({ quiet: true });
    if (ok) {
      console.log(`arena snapshot refreshed (${snapshot.rows.length} models)`);
      process.exit(0);
    }
    console.log(`arena snapshot could not be refreshed: ${error}`);
    process.exit(failureExitCode(snapshot));
  } else {
    const { ok, snapshot } = await refreshSnapshot();
    process.exit(ok ? 0 : failureExitCode(snapshot));
  }
}
