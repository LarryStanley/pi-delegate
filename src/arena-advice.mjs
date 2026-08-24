// Reading the Arena.ai leaderboard against the models pi actually has configured.
//
// What this is NOT: a routing decision. config.mjs is explicit that pi-delegate makes no
// guess about which provider/model a dispatch goes to, and nothing here changes that — the
// three-layer resolution is untouched. This answers the one question the board can answer
// and the user cannot answer by eye: of the models already in ~/.pi/agent/models.json,
// which is ranked highest, and which is the cheapest that still scores positive.
//
// Two things about the board shape the matching:
//
//   Names differ by audience. arena writes a model the way a human reads it ("GPT 5.6 Luna
//   (xHigh)"); pi writes it the way an API takes it ("gpt-5.6-luna"). So both sides get
//   collapsed to alphanumerics and compared exactly — no edit distance, no prefix
//   guessing. The board's leaders are routinely a generation ahead of anyone's roster, and
//   attaching "Claude Opus 5" to claude-opus-4-8 would turn "you do not have the best
//   model" into a recommendation for a model that was never measured. An unmatched row is
//   the honest answer, so it stays unmatched.
//
//   Effort is not identity. arena lists one row per effort level, so a single configured
//   model shows up several times at different ranks. The suffix is dropped and the variants
//   collapse to the model's best rank, which is what makes "the best you have" one answer.
//
// Purely local rosters (an MLX server, ollama) will never appear on the board at all. That
// is not an error — it is a matchedCount of 0, and the caller says so.

// Effort levels arena appends to a model name. Dropped, because they are a setting.
const EFFORT_SUFFIX = /\((?:x?high|max|medium|low|min|minimal)\)/g;

export function normalizeModelName(name) {
  return String(name ?? "").toLowerCase().replace(EFFORT_SUFFIX, "").replace(/[^a-z0-9]/g, "");
}

// Flattens ~/.pi/agent/models.json into one list. Entries are objects ({id, name, …}) in
// every file seen so far, but a bare string id costs one line to tolerate and this runs on
// a config file nobody validated.
export function localModelsFrom(modelsCfg) {
  const providers = modelsCfg?.providers;
  if (!providers || typeof providers !== "object") return [];
  const out = [];
  for (const [provider, entry] of Object.entries(providers)) {
    for (const model of entry?.models ?? []) {
      if (typeof model === "string") {
        out.push({ provider, id: model, name: null });
      } else if (model?.id) {
        out.push({ provider, id: model.id, name: model.name ?? null });
      }
    }
  }
  return out;
}

// Both the API id and the display name are compared: some rosters give a model an internal
// alias as its id and the board's name as its name, and matching either one still reports
// the id, which is what a dispatch would need.
function findLocal(local, key) {
  return local.find((l) => normalizeModelName(l.id) === key || (l.name && normalizeModelName(l.name) === key));
}

export function matchBoard(rows, local) {
  if (!Array.isArray(rows) || !Array.isArray(local) || local.length === 0) return [];
  const best = new Map();
  for (const row of rows) {
    const hit = findLocal(local, normalizeModelName(row?.model));
    if (!hit) continue;
    const at = `${hit.provider}/${hit.id}`;
    const previous = best.get(at);
    // Lower rank is better. An absent or non-numeric rank never displaces a real one.
    if (previous && !(typeof row.rank === "number" && row.rank < previous.rank)) continue;
    best.set(at, { ...row, provider: hit.provider, id: hit.id });
  }
  return [...best.values()].sort((a, b) => a.rank - b.rank);
}

// Dates are rendered as the calendar day, from the ISO string, with no locale and no
// Intl: this text goes into a SessionStart report that ends up in transcripts and bug
// reports, where a stable spelling is worth more than a local one. An unparseable or
// absent date renders as nothing at all rather than "Invalid Date" or "NaN".
function day(iso) {
  const t = Date.parse(iso ?? "");
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

function describe(match) {
  const price = typeof match.inputPricePerMillion === "number"
    ? `, $${match.inputPricePerMillion}/$${match.outputPricePerMillion} per Mtok in/out`
    : "";
  return `${match.provider}/${match.id} — rank ${match.rank}, score ${match.score}${price}`;
}

export function advise({ rows, local } = {}) {
  const board = Array.isArray(rows) ? rows : [];
  const matched = matchBoard(board, local);
  // A negative score means the model lost more often than it won: cheap and worse than
  // nothing is not a recommendation. A row with no price cannot be compared on price.
  const priced = matched
    .filter((m) => typeof m.score === "number" && m.score > 0 && typeof m.inputPricePerMillion === "number")
    .sort((a, b) => a.inputPricePerMillion - b.inputPricePerMillion);
  return {
    boardCount: board.length,
    matchedCount: matched.length,
    matched,
    topRanked: matched[0] ?? null,
    cheapestPositive: priced[0] ?? null,
  };
}

// The SessionStart lines, plus whether anyone should go and refresh the snapshot. Kept
// separate from the refreshing itself so the hook owns the one side effect and every
// wording here is testable without a network or a subprocess.
//
// `fresh` is the caller's answer, not ours: the TTL and the snapshot file belong to
// scripts/arena-fetch.mjs, and duplicating its isFresh() here would give the two places
// their own opinion about the same file.
export function arenaReport({ snapshot, modelsCfg, fresh, canRefresh = true } = {}) {
  if (!snapshot) {
    return {
      lines: [`arena leaderboard: no snapshot yet — ${canRefresh ? "fetching in the background" : "run: node scripts/arena-fetch.mjs"}`],
      needsRefresh: true,
    };
  }

  const needsRefresh = !fresh;
  const fetched = day(snapshot.fetchedAt);
  const board = day(snapshot.leaderboardSnapshot?.lastUpdated);
  const dates = [fetched && `fetched ${fetched}`, board && `board ${board}`].filter(Boolean).join(", ");
  const provenance = `arena leaderboard${dates ? ` (${dates})` : ""}`;
  // Never promise a refresh that was turned off: a line claiming one is on its way, next to
  // a snapshot that never changes, is worse than saying nothing.
  const staleness = !needsRefresh
    ? ""
    : canRefresh
      ? " — stale, refreshing in the background"
      : " — stale (arena_refresh is off; refresh with: node scripts/arena-fetch.mjs)";

  const { boardCount, matchedCount, topRanked, cheapestPositive } =
    advise({ rows: snapshot.rows, local: localModelsFrom(modelsCfg) });

  // Nothing matched is the NORMAL case for this plugin — its whole premise is dispatching to
  // a local model, and a local model is never on the board. Say that, rather than printing
  // two empty picks and letting it read as a broken feature.
  if (matchedCount === 0) {
    return {
      lines: [
        `${provenance}: none of the ${boardCount} ranked models are in your models.json — ` +
        `a purely local roster (MLX, ollama, llama.cpp) never appears on the board${staleness}`,
      ],
      needsRefresh,
    };
  }

  const lines = [`${provenance}: ${matchedCount} of ${boardCount} ranked models are in your models.json${staleness}`];
  lines.push(`  best ranked you have:  ${describe(topRanked)}`);
  // Absent when everything you have scores at or below zero — there is no cheapest model
  // worth naming among models that lose more often than they win.
  if (cheapestPositive && cheapestPositive.id !== topRanked.id) {
    lines.push(`  cheapest positive:     ${describe(cheapestPositive)}`);
  }
  return { lines, needsRefresh };
}

// The whole table, for `arena-fetch.mjs --advice`. The hook line names two picks because it
// has to stay short; someone choosing a model deliberately wants every ranked model they
// have. Each row carries the board's own spelling of the name, which is the evidence that
// the match is the model the reader thinks it is.
export function adviceTable({ snapshot, modelsCfg } = {}) {
  if (!snapshot) return ["arena: no snapshot yet — run: node scripts/arena-fetch.mjs"];
  const { boardCount, matchedCount, matched } = advise({ rows: snapshot.rows, local: localModelsFrom(modelsCfg) });
  if (matchedCount === 0) {
    return [`arena: none of the ${boardCount} ranked models are in your models.json ` +
      "— a purely local roster (MLX, ollama, llama.cpp) never appears on the board"];
  }
  const header = [`arena: ${matchedCount} of ${boardCount} ranked models are in your models.json`, ""];
  const width = Math.max(...matched.map((m) => `${m.provider}/${m.id}`.length));
  return header.concat(matched.map((m) => {
    const price = typeof m.inputPricePerMillion === "number"
      ? `$${m.inputPricePerMillion}/$${m.outputPricePerMillion}`.padEnd(14)
      : "".padEnd(14);
    return `  rank ${String(m.rank).padStart(2)}  score ${String(m.score).padEnd(8)} ${price} ` +
      `${`${m.provider}/${m.id}`.padEnd(width)}  <- "${m.model}"`;
  }));
}
