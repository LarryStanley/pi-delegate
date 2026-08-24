import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeModelName, localModelsFrom, matchBoard, advise, arenaReport, adviceTable } from "../src/arena-advice.mjs";

// The advice this module produces is a REPORT, never a routing decision: config.mjs is
// explicit that pi-delegate does not guess a provider/model on the user's behalf, and
// nothing here changes what a dispatch goes to. It answers one question the leaderboard can
// answer and the user cannot answer by eye — of the models you already have configured,
// which one is ranked highest, and which is the cheapest that still scores positive.
//
// The hard part is that arena names a model the way a human reads it ("GPT 5.6 Luna
// (xHigh)") and pi names it the way an API takes it ("gpt-5.6-luna"). Matching has to be
// conservative about that: the board's top entries are usually a generation ahead of what
// anyone has configured, and quietly attaching "Claude Opus 5" to claude-opus-4-8 would
// turn "you do not have the best model" into a recommendation for a model that was never
// measured.

const rows = (...specs) => specs.map(([rank, model, score, price]) => ({
  rank, model, organization: "org", score, ci: 0.01,
  inputPricePerMillion: price, outputPricePerMillion: price === null ? null : price * 5,
  sessions: 100,
}));

const cfg = {
  providers: {
    litellm: { models: [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }, { id: "claude-opus-4-8", name: "Claude Opus 4.8" }] },
    omls: { models: [{ id: "Qwen3.8-27B-Uncensored-MLX", name: "Qwen 3.8 27B" }] },
  },
};

test("normalizeModelName drops arena's effort suffix and every separator", () => {
  assert.equal(normalizeModelName("GPT 5.6 Luna (xHigh)"), "gpt56luna");
  assert.equal(normalizeModelName("gpt-5.6-luna"), "gpt56luna");
  assert.equal(normalizeModelName("Claude Opus 4.8 (High)"), "claudeopus48");
  assert.equal(normalizeModelName("Claude Opus 4.8"), "claudeopus48");
});

// The effort suffix is a setting, not a different model, so it must not survive
// normalisation — but a version number is part of the identity and must.
test("normalizeModelName keeps versions distinct", () => {
  assert.notEqual(normalizeModelName("Claude Opus 5 (High)"), normalizeModelName("claude-opus-4-8"));
  assert.notEqual(normalizeModelName("Kimi K3 (Max)"), normalizeModelName("Kimi-K2.5"));
});

test("localModelsFrom flattens every provider's models, keeping the provider", () => {
  const local = localModelsFrom(cfg);
  assert.equal(local.length, 3);
  assert.deepEqual(local[0], { provider: "litellm", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" });
  assert.equal(local.at(-1).provider, "omls");
});

test("localModelsFrom survives a models.json that is missing, empty or the wrong shape", () => {
  assert.deepEqual(localModelsFrom(null), []);
  assert.deepEqual(localModelsFrom({}), []);
  assert.deepEqual(localModelsFrom({ providers: { p: {} } }), []);
  assert.deepEqual(localModelsFrom({ providers: { p: { models: ["bare-string-id"] } } }),
    [{ provider: "p", id: "bare-string-id", name: null }]);
});

test("matchBoard pairs a board row with the configured model it names", () => {
  const matched = matchBoard(rows([19, "GPT 5.6 Luna (xHigh)", 0.04, 0.2]), localModelsFrom(cfg));
  assert.equal(matched.length, 1);
  assert.equal(matched[0].provider, "litellm");
  assert.equal(matched[0].id, "gpt-5.6-luna");
  assert.equal(matched[0].model, "GPT 5.6 Luna (xHigh)");
});

// The case that makes conservatism the point: the board's leaders are a generation ahead of
// the roster, and "close enough" would recommend a model nobody measured.
test("matchBoard leaves a board row unmatched when only another version is configured", () => {
  const matched = matchBoard(rows([1, "Claude Opus 5 (High)", 0.12, 5]), localModelsFrom(cfg));
  assert.deepEqual(matched, []);
});

test("matchBoard matches on the display name too, and still reports the API id", () => {
  const local = localModelsFrom({ providers: { p: { models: [{ id: "internal-alias-7", name: "Fancy Model 7" }] } } });
  const matched = matchBoard(rows([3, "Fancy Model 7 (Max)", 0.1, 1]), local);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].id, "internal-alias-7");
});

// arena lists one row per effort level, so the same configured model appears several times.
// Collapsing them to the best rank is what makes "the best you have" a single answer.
test("matchBoard collapses a model's effort variants to its best rank", () => {
  const matched = matchBoard(
    rows([13, "Claude Opus 4.8", 0.06, 5], [6, "Claude Opus 4.8 (High)", 0.09, 5], [24, "Claude Opus 4.8 (Max)", 0.02, 5]),
    localModelsFrom(cfg),
  );
  assert.equal(matched.length, 1);
  assert.equal(matched[0].rank, 6);
  assert.equal(matched[0].score, 0.09);
});

test("matchBoard returns matches in rank order", () => {
  const matched = matchBoard(
    rows([19, "GPT 5.6 Luna (xHigh)", 0.04, 0.2], [6, "Claude Opus 4.8 (High)", 0.09, 5]),
    localModelsFrom(cfg),
  );
  assert.deepEqual(matched.map((m) => m.id), ["claude-opus-4-8", "gpt-5.6-luna"]);
});

test("advise reports the best-ranked and the cheapest positive-scoring model you have", () => {
  const a = advise({
    rows: rows([1, "Claude Opus 5 (High)", 0.12, 5], [6, "Claude Opus 4.8 (High)", 0.09, 5], [19, "GPT 5.6 Luna (xHigh)", 0.04, 0.2]),
    local: localModelsFrom(cfg),
  });
  assert.equal(a.boardCount, 3);
  assert.equal(a.matchedCount, 2);
  assert.equal(a.topRanked.id, "claude-opus-4-8");
  assert.equal(a.cheapestPositive.id, "gpt-5.6-luna");
});

// A negative score means the model lost more often than it won. Cheap and worse than
// nothing is not a recommendation, and a row with no price cannot be compared on price.
test("advise ignores negative scores and unpriced rows when picking the cheapest", () => {
  const a = advise({
    rows: rows([6, "Claude Opus 4.8 (High)", 0.09, 5], [40, "GPT 5.6 Luna", -0.05, 0.2]),
    local: localModelsFrom(cfg),
  });
  assert.equal(a.cheapestPositive.id, "claude-opus-4-8");

  const unpriced = advise({
    rows: rows([6, "Claude Opus 4.8 (High)", 0.09, null]),
    local: localModelsFrom(cfg),
  });
  assert.equal(unpriced.cheapestPositive, null);
  assert.equal(unpriced.topRanked.id, "claude-opus-4-8");
});

// The hook calls this on every session start, where there may be no snapshot at all, no
// models.json, or a roster of purely local models that the board will never list. None of
// those is an error and none of them may throw.
test("advise degrades to an empty report rather than throwing", () => {
  for (const input of [{}, { rows: null, local: null }, { rows: [], local: [] }]) {
    const a = advise(input);
    assert.equal(a.boardCount, 0);
    assert.equal(a.matchedCount, 0);
    assert.equal(a.topRanked, null);
    assert.equal(a.cheapestPositive, null);
  }
});

test("advise reports nothing matched when the roster is entirely local", () => {
  const a = advise({
    rows: rows([1, "Claude Opus 5 (High)", 0.12, 5]),
    local: localModelsFrom({ providers: { omls: { models: [{ id: "Qwen3.8-27B-Uncensored-MLX" }] } } }),
  });
  assert.equal(a.boardCount, 1);
  assert.equal(a.matchedCount, 0);
  assert.equal(a.topRanked, null);
});

// --- The SessionStart report ---
//
// A pure function returning lines plus a "does someone need to refresh this?" flag. The hook
// owns the spawning, so every wording below is testable without a network or a subprocess.

const SNAPSHOT = {
  source: "https://arena.ai/leaderboard/agent",
  fetchedAt: "2026-08-24T07:07:43.086Z",
  leaderboardSnapshot: { lastUpdated: "2026-08-19T18:00:00.000Z", modelCount: 3 },
  rows: rows([1, "Claude Opus 5 (High)", 0.12, 5], [6, "Claude Opus 4.8 (High)", 0.0955, 5], [19, "GPT 5.6 Luna (xHigh)", 0.0404, 0.2]),
};

const text = (report) => report.lines.join("\n");

test("arenaReport names both dates, the coverage, and the two picks", () => {
  const report = arenaReport({ snapshot: SNAPSHOT, modelsCfg: cfg, fresh: true });
  assert.equal(report.needsRefresh, false);
  assert.match(text(report), /fetched 2026-08-24/);
  assert.match(text(report), /board 2026-08-19/);
  assert.match(text(report), /2 of 3/);
  assert.match(text(report), /litellm\/claude-opus-4-8/);
  assert.match(text(report), /litellm\/gpt-5\.6-luna/);
  assert.match(text(report), /\$0\.2/);
});

// The board's own date matters separately from ours: a snapshot fetched today can carry
// numbers arena computed a week ago, and a reader comparing models needs to know which.
test("arenaReport still reports when the board carries no date of its own", () => {
  const report = arenaReport({ snapshot: { ...SNAPSHOT, leaderboardSnapshot: null }, modelsCfg: cfg, fresh: true });
  assert.match(text(report), /fetched 2026-08-24/);
  assert.doesNotMatch(text(report), /board (undefined|null|NaN)/);
});

test("arenaReport asks for a refresh when the snapshot is stale, and says so", () => {
  const report = arenaReport({ snapshot: SNAPSHOT, modelsCfg: cfg, fresh: false });
  assert.equal(report.needsRefresh, true);
  assert.match(text(report), /stale/);
  assert.match(text(report), /background/);
});

test("arenaReport asks for a refresh and offers no picks when there is no snapshot", () => {
  const report = arenaReport({ snapshot: null, modelsCfg: cfg, fresh: false });
  assert.equal(report.needsRefresh, true);
  assert.equal(report.lines.length, 1);
  assert.match(report.lines[0], /no snapshot yet/);
});

// A purely local roster is the normal case for this plugin, so the wording has to explain
// itself rather than read as a missing feature.
test("arenaReport explains a zero-match roster instead of showing empty picks", () => {
  const localOnly = { providers: { omls: { models: [{ id: "Qwen3.8-27B-Uncensored-MLX" }] } } };
  const report = arenaReport({ snapshot: SNAPSHOT, modelsCfg: localOnly, fresh: true });
  assert.equal(report.needsRefresh, false);
  assert.equal(report.lines.length, 1);
  assert.match(report.lines[0], /none of the 3/);
  assert.match(report.lines[0], /local/);
});

test("arenaReport omits the cheapest line when nothing you have scores positive", () => {
  const negative = { ...SNAPSHOT, rows: rows([40, "Claude Opus 4.8 (High)", -0.05, 5]) };
  const report = arenaReport({ snapshot: negative, modelsCfg: cfg, fresh: true });
  assert.match(text(report), /best ranked/);
  assert.doesNotMatch(text(report), /cheapest/);
});

test("arenaReport never throws on a corrupt snapshot", () => {
  for (const snapshot of [{}, { rows: "nope" }, { rows: [], fetchedAt: "not a date" }]) {
    assert.doesNotThrow(() => arenaReport({ snapshot, modelsCfg: cfg, fresh: true }));
  }
});

// --- the full table, for `arena-fetch.mjs --advice` ---
//
// The SessionStart report names two picks because a hook line has to stay short. Someone
// choosing a model deliberately wants every ranked model they have, in rank order.

test("adviceTable lists every match in rank order, with the board name it matched", () => {
  const lines = adviceTable({ snapshot: SNAPSHOT, modelsCfg: cfg });
  const body = lines.filter((l) => l.includes("litellm/"));
  assert.equal(body.length, 2);
  assert.match(body[0], /claude-opus-4-8/);
  assert.match(body[1], /gpt-5\.6-luna/);
  // The board's own spelling has to be visible: it is the evidence that the match is right.
  assert.match(body[1], /GPT 5\.6 Luna \(xHigh\)/);
});

test("adviceTable says so rather than printing an empty table", () => {
  assert.match(adviceTable({ snapshot: null, modelsCfg: cfg }).join("\n"), /no snapshot/);
  const localOnly = { providers: { omls: { models: [{ id: "Qwen3.8-27B-Uncensored-MLX" }] } } };
  assert.match(adviceTable({ snapshot: SNAPSHOT, modelsCfg: localOnly }).join("\n"), /none of the 3/);
});
