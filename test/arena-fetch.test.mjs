import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  extractRows, slimRows, isFresh, refreshSnapshot, loadSnapshot,
} from "../scripts/arena-fetch.mjs";

// A minimal RSC flight payload in the shape arena.ai ships: escaped JSON inside
// self.__next_f.push chunks, split across two chunks to prove reassembly.
function flightPage(rowsJson) {
  const payload = `arena":{"slug":"agent","snapshot":{"rows":${rowsJson}`;
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

test("extractRows reassembles split chunks and parses the rows array", () => {
  const html = flightPage(JSON.stringify(ROWS));
  const rows = extractRows(html);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].model, "Alpha 1");
});

test("extractRows returns null when the marker is absent or the array is unparseable", () => {
  assert.equal(extractRows("<html>nothing here</html>"), null);
  assert.equal(extractRows('<script>self.__next_f.push([1,"x \\"rows\\":[{broken")]</script>'), null);
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

test("isFresh honours the TTL", () => {
  assert.equal(isFresh(null), false);
  assert.equal(isFresh({ fetchedAt: new Date().toISOString() }), true);
  assert.equal(isFresh({ fetchedAt: "2020-01-01T00:00:00.000Z" }), false);
  assert.equal(isFresh({ fetchedAt: new Date(Date.now() - 1000).toISOString(), }, 500), false);
});

test("refreshSnapshot writes a slimmed snapshot on success", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "pi-delegate-arena-")), "snapshot.json");
  const { ok, snapshot } = await refreshSnapshot({
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => flightPage(JSON.stringify(ROWS)) }),
    file, quiet: true,
  });
  assert.equal(ok, true);
  assert.equal(snapshot.rows.length, 2);
  assert.ok(snapshot.fetchedAt);
  assert.equal(loadSnapshot(file).source, "https://arena.ai/leaderboard/agent");
  rmSync(dirname(file), { recursive: true, force: true });
});

test("refreshSnapshot keeps the previous snapshot and records the error when the fetch fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-delegate-arena-"));
  const file = join(dir, "snapshot.json");
  writeFileSync(file, JSON.stringify({ source: "x", fetchedAt: "2020-01-01T00:00:00.000Z", rows: [{ rank: 1, model: "Old" }] }));
  const { ok, error, snapshot } = await refreshSnapshot({
    fetchImpl: async () => { throw new Error("network down"); },
    file, quiet: true,
  });
  assert.equal(ok, false);
  assert.match(error, /network down/);
  const after = loadSnapshot(file);
  assert.equal(after.rows.length, 1);
  assert.equal(after.model ?? after.rows[0].model, "Old");
  assert.match(after.lastFetchError, /network down/);
  rmSync(dir, { recursive: true, force: true });
});

test("refreshSnapshot with no previous snapshot and a failed fetch reports the error without writing", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "pi-delegate-arena-")), "missing.json");
  const { ok, snapshot } = await refreshSnapshot({
    fetchImpl: async () => { throw new Error("nope"); },
    file, quiet: true,
  });
  assert.equal(ok, false);
  assert.equal(snapshot, null);
});
