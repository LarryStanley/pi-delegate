import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  extractRows, extractSnapshot, slimRows, isFresh, hasUsableRows, refreshSnapshot, loadSnapshot,
} from "../scripts/arena-fetch.mjs";

// The metadata arena.ai actually ships alongside the rows, verified against the live page.
const META = '"lastUpdated":"2026-08-19T18:00:00.000Z","totalSessions":1913847,"totalObservations":84463204,"modelCount":3,';

// A minimal RSC flight payload in the shape arena.ai ships: escaped JSON inside
// self.__next_f.push chunks, split across two chunks to prove reassembly.
function flightPage(rowsJson, { meta = META, prelude = "" } = {}) {
  const payload = `"arena":{"slug":"agent",${prelude}"snapshot":{${meta}"rows":${rowsJson}}}`;
  const a = payload.slice(0, 20);
  const b = payload.slice(20);
  return [
    '<script>self.__next_f.push([1,"prefix ',
    JSON.stringify(a).slice(1, -1),
    '")]</script>',
    '<script>self.__next_f.push([1,"',
    JSON.stringify(b).slice(1, -1),
    ' suffix")]</script>',
  ].join("");
}

const ROWS = [
  { rank: 1, model: "Alpha 1", modelOrganization: "A", inputPricePerMillion: 5, outputPricePerMillion: 25, avgScore: { value: 0.12, ci: 0.01 }, sessions: 100 },
  { rank: 2, model: "Beta 2", modelOrganization: "B", inputPricePerMillion: null, outputPricePerMillion: null, avgScore: { value: 0.05, ci: 0.02 }, sessions: 50 },
  { rank: 3, model: null, modelOrganization: "C", inputPricePerMillion: 1, outputPricePerMillion: 1, avgScore: { value: 0.01, ci: 0.01 }, sessions: 10 },
];

const okFetch = (html) => async () => ({ ok: true, status: 200, text: async () => html });
const tempFile = (name = "snapshot.json") => join(mkdtempSync(join(tmpdir(), "pi-delegate-arena-")), name);

test("extractRows reassembles split chunks and parses the rows array", () => {
  const html = flightPage(JSON.stringify(ROWS));
  const rows = extractRows(html);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].model, "Alpha 1");
});

test("extractSnapshot keeps the leaderboard's own metadata", () => {
  const snap = extractSnapshot(flightPage(JSON.stringify(ROWS)));
  assert.equal(snap.lastUpdated, "2026-08-19T18:00:00.000Z");
  assert.equal(snap.modelCount, 3);
  assert.equal(snap.totalSessions, 1913847);
});

test("extractRows returns null when the marker is absent or the array is unparseable", () => {
  assert.equal(extractRows("<html>nothing here</html>"), null);
  assert.equal(extractRows('<script>self.__next_f.push([1,"x \\"snapshot\\":{\\"rows\\":[{broken")]</script>'), null);
});

// The failure that matters is not "no snapshot object" but "a snapshot object that is not
// the leaderboard" — a site restructure leaves plenty of those, and accepting one silently
// produces an empty successful fetch.
test("extractSnapshot skips a snapshot object that does not look like the leaderboard", () => {
  const decoy = '"snapshot":{"rows":[{"label":"Text"},{"label":"Agent"}]},';
  const snap = extractSnapshot(flightPage(JSON.stringify(ROWS), { prelude: decoy }));
  assert.equal(snap.modelCount, 3);
  assert.equal(snap.rows[0].model, "Alpha 1");
});

test("extractSnapshot returns null when every candidate is a decoy", () => {
  const html = flightPage('[{"label":"Text"}]', { meta: "" });
  assert.equal(extractSnapshot(html), null);
});

// A bracket inside a string value must not close the scan early: string fields on the live
// board already contain them, and only their being balanced kept a naive walk working.
test("extractRows survives brackets and braces inside string values", () => {
  const rows = [{ rank: 1, model: "Alpha [beta", modelOrganization: "A}{" }, { rank: 2, model: "Gamma ]", modelOrganization: "B" }];
  const parsed = extractRows(flightPage(JSON.stringify(rows)));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].model, "Alpha [beta");
});

// A chunk whose closing quote never arrives is dropped, not closed with a fabricated one:
// fabricating it lets JSON.parse succeed on truncated content and appends garbage.
test("extractSnapshot fails closed on an unterminated chunk", () => {
  const payload = `"snapshot":{${META}"rows":${JSON.stringify(ROWS)}}}`;
  const truncated = `<script>self.__next_f.push([1,"${JSON.stringify(payload).slice(1, -1)}`;
  assert.equal(extractSnapshot(truncated), null);
});

test("slimRows keeps only the tiering fields, drops nameless rows, sorts by rank", () => {
  const slim = slimRows([...ROWS].reverse());
  assert.deepEqual(slim.map((r) => r.rank), [1, 2]);
  assert.deepEqual(Object.keys(slim[0]).sort(), [
    "ci", "inputPricePerMillion", "model", "organization", "outputPricePerMillion", "rank", "score", "sessions",
  ]);
  assert.equal(slim[0].score, 0.12);
  assert.equal(slim[1].inputPricePerMillion, null);
});

// The shape a model with too few sessions ships: the avgScore object is there, the numbers
// in it are not.
test("slimRows nulls a missing score instead of throwing on it", () => {
  const slim = slimRows([
    { rank: 1, model: "No value", avgScore: { ci: 0.1 } },
    { rank: 2, model: "No score at all" },
    { rank: 3, model: "Null value", avgScore: { value: null, ci: null } },
  ]);
  assert.deepEqual(slim.map((r) => r.score), [null, null, null]);
  assert.equal(slim[0].ci, 0.1);
});

test("slimRows drops rankless rows rather than sorting them by NaN", () => {
  const slim = slimRows([{ model: "no rank" }, { rank: 2, model: "b" }, { rank: 1, model: "a" }]);
  assert.deepEqual(slim.map((r) => r.model), ["a", "b"]);
});

test("isFresh honours the TTL", () => {
  assert.equal(isFresh(null), false);
  assert.equal(isFresh({ fetchedAt: new Date().toISOString() }), true);
  assert.equal(isFresh({ fetchedAt: "2020-01-01T00:00:00.000Z" }), false);
  assert.equal(isFresh({ fetchedAt: new Date(Date.now() - 1000).toISOString() }, 500), false);
});

test("hasUsableRows separates emptiness from staleness", () => {
  assert.equal(hasUsableRows(null), false);
  assert.equal(hasUsableRows({ fetchedAt: new Date().toISOString(), rows: [] }), false);
  assert.equal(hasUsableRows({ rows: [{ rank: 1, model: "x" }] }), true);
});

test("refreshSnapshot writes a slimmed snapshot on success", async () => {
  const file = tempFile();
  const { ok, snapshot } = await refreshSnapshot({
    fetchImpl: okFetch(flightPage(JSON.stringify(ROWS))), file, quiet: true,
  });
  assert.equal(ok, true);
  assert.equal(snapshot.rows.length, 2);
  assert.ok(snapshot.fetchedAt);
  assert.equal(snapshot.leaderboardSnapshot.lastUpdated, "2026-08-19T18:00:00.000Z");
  assert.equal(snapshot.leaderboardSnapshot.modelCount, 3);
  assert.equal(loadSnapshot(file).source, "https://arena.ai/leaderboard/agent");
  rmSync(dirname(file), { recursive: true, force: true });
});

test("refreshSnapshot passes an abort signal so a hanging fetch cannot outlive the hook budget", async () => {
  const file = tempFile();
  let seen = null;
  await refreshSnapshot({
    fetchImpl: async (_url, init) => {
      seen = init;
      return { ok: true, status: 200, text: async () => flightPage(JSON.stringify(ROWS)) };
    },
    file, quiet: true,
  });
  assert.ok(seen.signal instanceof AbortSignal);
  rmSync(dirname(file), { recursive: true, force: true });
});

test("refreshSnapshot keeps the previous snapshot and records the error when the fetch fails", async () => {
  const file = tempFile();
  writeFileSync(file, JSON.stringify({ source: "x", fetchedAt: "2020-01-01T00:00:00.000Z", rows: [{ rank: 1, model: "Old" }] }));
  const { ok, error } = await refreshSnapshot({
    fetchImpl: async () => { throw new Error("network down"); },
    file, quiet: true,
  });
  assert.equal(ok, false);
  assert.match(error, /network down/);
  const after = loadSnapshot(file);
  assert.equal(after.rows.length, 1);
  assert.equal(after.rows[0].model, "Old");
  assert.match(after.lastFetchError, /network down/);
  rmSync(dirname(file), { recursive: true, force: true });
});

// The regression this file exists for, in both of its shapes: a page that parses but yields
// nothing usable is a failure, not a successful write of zero rows over data that was fine.
const GOOD = { source: "x", fetchedAt: "2020-01-01T00:00:00.000Z", rows: [{ rank: 1, model: "Old" }] };

test("refreshSnapshot treats a ranked table whose fields have moved as a failed fetch", async () => {
  const file = tempFile();
  writeFileSync(file, JSON.stringify(GOOD));
  // Ranks intact, so the shape check passes; "model" renamed, so slimRows keeps nothing.
  const renamed = [{ rank: 1, name: "Alpha" }, { rank: 2, name: "Beta" }];
  const { ok, error } = await refreshSnapshot({
    fetchImpl: okFetch(flightPage(JSON.stringify(renamed))), file, quiet: true,
  });
  assert.equal(ok, false);
  assert.match(error, /no usable rows/);
  assert.deepEqual(loadSnapshot(file).rows, GOOD.rows);
  rmSync(dirname(file), { recursive: true, force: true });
});

test("refreshSnapshot treats a page with no recognisable leaderboard as a failed fetch", async () => {
  const file = tempFile();
  writeFileSync(file, JSON.stringify(GOOD));
  const { ok, error } = await refreshSnapshot({
    fetchImpl: okFetch(flightPage('[{"label":"Text"},{"label":"Agent"}]', { meta: "" })), file, quiet: true,
  });
  assert.equal(ok, false);
  assert.match(error, /snapshot not found/);
  assert.deepEqual(loadSnapshot(file).rows, GOOD.rows);
  rmSync(dirname(file), { recursive: true, force: true });
});

test("refreshSnapshot leaves no temp file behind on either path", async () => {
  const file = tempFile();
  await refreshSnapshot({ fetchImpl: okFetch(flightPage(JSON.stringify(ROWS))), file, quiet: true });
  await refreshSnapshot({ fetchImpl: async () => { throw new Error("nope"); }, file, quiet: true });
  assert.deepEqual(readdirSync(dirname(file)), ["snapshot.json"]);
  assert.ok(readFileSync(file, "utf8").endsWith("\n"));
  rmSync(dirname(file), { recursive: true, force: true });
});

test("refreshSnapshot with no previous snapshot and a failed fetch reports the error without writing", async () => {
  const file = tempFile("missing.json");
  const { ok, snapshot } = await refreshSnapshot({
    fetchImpl: async () => { throw new Error("nope"); },
    file, quiet: true,
  });
  assert.equal(ok, false);
  assert.equal(snapshot, null);
  assert.equal(existsSync(file), false);
  rmSync(dirname(file), { recursive: true, force: true });
});
