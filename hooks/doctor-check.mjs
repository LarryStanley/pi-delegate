#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { checkModels } from "../src/doctor.mjs";
import { getMode } from "../src/modes.mjs";
import { loadConfig, loadPiDefaults, piModelsPath } from "../src/config.mjs";

const modelsPath = piModelsPath();

// This hook runs on every SessionStart, and what it reads is a models.json that may well
// be broken. A bare JSON.parse would turn "the configuration is broken, tell the user to
// fix it" into "the hook throws and dies" — falling silent at exactly the moment it is
// most needed. Degradation strategy matches src/modes.mjs's load(): unparseable means
// treat as empty configuration and carry on.
function loadModels(file) {
  if (!existsSync(file)) return { providers: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { providers: {} };
  } catch {
    return { providers: {}, __unreadable: true };
  }
}

const config = loadConfig();
const piDefaults = loadPiDefaults();
const selection = {
  provider: config.provider ?? piDefaults.provider,
  model: config.model ?? piDefaults.model,
  source: config.provider || config.model ? "pi-delegate config.json" : "pi settings.json",
};

const cfg = loadModels(modelsPath);
const { ok, problems } = checkModels(cfg, selection, { drafterPatterns: config.drafter_patterns });
const mode = getMode(process.cwd());

// This line is a report, not a to-do item: having no pi-delegate config.json is NORMAL,
// and means dispatches go straight to the user's own default pi model.
const target = selection.provider && selection.model
  ? `${selection.provider} / ${selection.model} (source: ${selection.source})`
  : "pi's own default model (none pinned in ~/.pi/agent/settings.json, so pi picks the first available one)";

const lines = [
  `pi-delegate mode: ${mode} (switch between off / soft / strict with /pi-delegate:mode)`,
  `Dispatch target: ${target}`,
];
if (cfg.__unreadable) {
  lines.push(`WARNING: ${modelsPath} is not valid JSON; treating it as empty configuration.`);
}
if (!ok) {
  lines.push(`WARNING: ${problems.length} problem(s) with the pi configuration. Run /pi-delegate:doctor for details:`);
  for (const problem of problems) lines.push(`  - [${problem.code}] ${problem.message}`);
}

// For the envelope shape see the note in hooks/soft-nudge.mjs: a top-level
// additionalContext is silently discarded. This is SessionStart, so hookEventName must be
// "SessionStart". Note that the "invalid JSON falls back to plain stdout" escape hatch does
// NOT save this bug — this hook emits valid JSON, so it takes the JSON path, and any field
// that is not recognised is simply dropped.
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: lines.join("\n"),
  },
}));
