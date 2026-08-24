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
// Usage:
//   node scripts/arena-fetch.mjs            # fetch, write snapshot
//   node scripts/arena-fetch.mjs --check    # exit 0 if snapshot fresh, 1 if stale/missing, 2 if fetch failed
//
// Exit codes: 0 = snapshot fresh (fetched or within TTL), 1 = stale, 2 = fetch failed.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const URL = "https://arena.ai/leaderboard/agent";
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // snapshot older than this is "stale"
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

// The page ships its data as JSON strings inside self.__next_f.push([1,"..."]) chunks.
// The string content itself contains escaped quotes (the payload is JSON-in-JSON), so
// the chunk boundary cannot be found with a non-greedy quote match — it must be found
// by walking the string honouring backslash escapes. Reassemble all chunks, then locate
// the leaderboard "rows" array by bracket-matching from its opening "[".
export function extractRows(pageHtml) {
  let buf = "";
  const marker = 'self.__next_f.push([1,"';
  let from = 0;
  for (;;) {
    const start = pageHtml.indexOf(marker, from);
    if (start === -1) break;
    // Walk the JSON string literal from its opening quote, honouring \\ escapes.
    let i = start + marker.length - 1; // sits on the opening quote
    let lit = '"';
    for (i++; i < pageHtml.length; i++) {
      const c = pageHtml[i];
      if (c === "\\") { lit += c + pageHtml[i + 1]; i++; continue; }
      if (c === '"') break;
      lit += c;
    }
    lit += '"';
    from = i + 1;
    try {
      buf += JSON.parse(lit);
    } catch {
      // A chunk that fails to unescape loses its slice; the rows array either
      // survives intact or not at all, in which case the caller gets null.
    }
  }
  const rowsMarker = '"rows":[';
  const at = buf.indexOf(rowsMarker);
  if (at === -1) return null;
  const start = at + rowsMarker.length - 1;
  let depth = 0;
  for (let i = start; i < buf.length; i++) {
    const c = buf[i];
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(buf.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export async function fetchRows({ fetchImpl = fetch } = {}) {
  const res = await fetchImpl(URL, { headers: { "user-agent": "pi-delegate-arena-fetch/1.0" } });
  if (!res.ok) throw new Error(`arena.ai responded ${res.status}`);
  const html = await res.text();
  const rows = extractRows(html);
  if (!rows) throw new Error("leaderboard rows not found in page (site structure changed?)");
  return rows;
}

// Keep only the fields the tiering policy needs, sorted by rank.
export function slimRows(rows) {
  return rows
    .map((r) => ({
      rank: r.rank,
      model: r.model,
      organization: r.modelOrganization,
      score: r.avgScore ? Number(r.avgScore.value.toFixed(4)) : null,
      ci: r.avgScore ? Number(r.avgScore.ci.toFixed(4)) : null,
      inputPricePerMillion: r.inputPricePerMillion ?? null,
      outputPricePerMillion: r.outputPricePerMillion ?? null,
      sessions: r.sessions ?? null,
    }))
    .filter((r) => r.model)
    .sort((a, b) => a.rank - b.rank);
}

export async function refreshSnapshot({ fetchImpl = fetch, file = SNAPSHOT_PATH, quiet = false } = {}) {
  const previous = loadSnapshot(file);
  let rows;
  try {
    rows = slimRows(await fetchRows({ fetchImpl }));
  } catch (err) {
    // Keep the old snapshot, mark it stale. Never delete good data on a bad fetch.
    if (previous) {
      writeFileSync(file, `${JSON.stringify({ ...previous, lastFetchError: String(err) }, null, 2)}\n`);
    }
    if (!quiet) console.error(`arena-fetch: ${err}`);
    return { ok: false, error: String(err), snapshot: previous };
  }
  const snapshot = {
    source: URL,
    fetchedAt: new Date().toISOString(),
    leaderboardSnapshot: previous?.leaderboardSnapshot ?? null,
    rows,
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  if (!quiet) console.log(`arena-fetch: wrote ${rows.length} rows to ${file}`);
  return { ok: true, snapshot };
}

// --check: for hooks. Exits 0 fresh, 1 stale, 2 fetch failed. Prints one line.
const check = process.argv.includes("--check");
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (check) {
    const existing = loadSnapshot();
    if (existing && isFresh(existing)) {
      console.log(`arena snapshot fresh (${existing.fetchedAt}, ${existing.rows?.length ?? 0} models)`);
      process.exit(0);
    }
    const { ok, error } = await refreshSnapshot({ quiet: true });
    if (ok) {
      console.log(`arena snapshot refreshed (${new Date().toISOString()})`);
      process.exit(0);
    }
    console.log(`arena snapshot stale and refresh failed: ${error}`);
    process.exit(existing ? 1 : 2);
  } else {
    const { ok, error } = await refreshSnapshot();
    process.exit(ok ? 0 : 2);
  }
}
