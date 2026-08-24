// This file tests the hooks/*.mjs scripts themselves — "feed stdin JSON, read stdout" —
// rather than calling functions through import, because mode-guard.mjs / soft-nudge.mjs
// are top-level-await executable scripts; the only faithful way to test them is to
// actually spawn a node child process the way a hook invocation really would.
//
// Each test uses its own HOME (pointing os.homedir() at a clean tmp directory) together
// with setMode(project, mode, customStateFile) to write modes.json under that tmp HOME,
// so the state getMode(cwd) reads inside the child process lines up exactly with what the
// test set, and none of it touches this machine's real ~/.claude/pi-delegate/modes.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setMode, setPolicy } from "../src/modes.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODE_GUARD = join(REPO_ROOT, "hooks", "mode-guard.mjs");
const SOFT_NUDGE = join(REPO_ROOT, "hooks", "soft-nudge.mjs");
const DOCTOR_CHECK = join(REPO_ROOT, "hooks", "doctor-check.mjs");

function tmpProject() {
  // macOS's tmpdir() lives under /var/folders/..., and /var is a symlink to /private/var —
  // process.cwd() inside the child process returns the realpath (/private/var/...), which
  // differs from the raw path we were handed. Resolve the symlink with realpathSync first,
  // so the key setMode writes matches the process.cwd() the child process reads back.
  return realpathSync(mkdtempSync(join(tmpdir(), "pi-delegate-proj-")));
}

function tmpHome() {
  return mkdtempSync(join(tmpdir(), "pi-delegate-home-"));
}

function stateFileFor(home) {
  return join(home, ".claude", "pi-delegate", "modes.json");
}

function runHook(scriptPath, { cwd, home, stdin }) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    input: stdin,
    encoding: "utf8",
  });
}

function gitInit(dir) {
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

// ---- [Important 2] mode-guard must fail closed on broken stdin ----

test("mode-guard: broken stdin JSON in strict mode denies rather than silently allowing", () => {
  const project = tmpProject();
  const home = tmpHome();
  setMode(project, "strict", stateFileFor(home));

  const result = runHook(MODE_GUARD, { cwd: project, home, stdin: "{ this is not valid JSON" });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"permissionDecision":"deny"/);
});

test("mode-guard: broken stdin JSON in soft mode exits silently (no deny, no output)", () => {
  const project = tmpProject();
  const home = tmpHome();
  setMode(project, "soft", stateFileFor(home));

  const result = runHook(MODE_GUARD, { cwd: project, home, stdin: "{ this is not valid JSON" });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "");
});

test("mode-guard: valid JSON, strict mode, an existing src file still denies normally (regression)", () => {
  const project = tmpProject();
  const home = tmpHome();
  setMode(project, "strict", stateFileFor(home));
  mkdirSync(join(project, "src"), { recursive: true });
  const filePath = join(project, "src", "existing.ts");
  writeFileSync(filePath, "export const x = 1;\n");

  const payload = JSON.stringify({ cwd: project, tool_input: { file_path: filePath } });
  const result = runHook(MODE_GUARD, { cwd: project, home, stdin: payload });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"permissionDecision":"deny"/);
  assert.match(result.stdout, /existing\.ts/);
});

// ---- [Important 1] soft-nudge must not cry wolf over a just-created file ----

test("soft-nudge: a new (not yet git-tracked) src/*.ts stays silent", () => {
  const project = tmpProject();
  const home = tmpHome();
  gitInit(project);
  mkdirSync(join(project, "src"), { recursive: true });
  const filePath = join(project, "src", "brand-new.ts");
  writeFileSync(filePath, "export const x = 1;\n");
  // Deliberately not git add'd — simulates a file the Write tool just created that
  // has not entered the git index yet
  setMode(project, "soft", stateFileFor(home));

  const payload = JSON.stringify({ cwd: project, tool_input: { file_path: filePath } });
  const result = runHook(SOFT_NUDGE, { cwd: project, home, stdin: payload });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "");
});

test("soft-nudge: an existing (git-tracked) src/*.ts triggers a nudge", () => {
  const project = tmpProject();
  const home = tmpHome();
  gitInit(project);
  mkdirSync(join(project, "src"), { recursive: true });
  const filePath = join(project, "src", "existing.ts");
  writeFileSync(filePath, "export const x = 1;\n");
  spawnSync("git", ["add", "src/existing.ts"], { cwd: project });
  setMode(project, "soft", stateFileFor(home));

  const payload = JSON.stringify({ cwd: project, tool_input: { file_path: filePath } });
  const result = runHook(SOFT_NUDGE, { cwd: project, home, stdin: payload });

  assert.equal(result.status, 0);
  // Just matching /"additionalContext"/ is not enough — a broken top-level envelope would
  // match it too (that is exactly why C1 stayed green all the way to the final review
  // round). Parse the structure instead and name hookSpecificOutput.hookEventName
  // explicitly, so that "it fell back to the top level" is guaranteed to go red.
  // The contract's source is the zod schema inside the claude 2.1.239 binary, not the
  // public docs (the docs draw additionalContext at the top level, which is wrong); see
  // final-fix-report.md for how that was verified.
  const payloadOut = JSON.parse(result.stdout);
  assert.equal(payloadOut.additionalContext, undefined, "additionalContext must not sit at the top level");
  assert.equal(payloadOut.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.equal(typeof payloadOut.hookSpecificOutput.additionalContext, "string");
  assert.match(payloadOut.hookSpecificOutput.additionalContext, /existing\.ts/);
});

test("soft-nudge: allows even an existing file when it is not a git repo (missing a nudge is safer than nagging)", () => {
  const project = tmpProject(); // no git init
  const home = tmpHome();
  mkdirSync(join(project, "src"), { recursive: true });
  const filePath = join(project, "src", "existing.ts");
  writeFileSync(filePath, "export const x = 1;\n");
  setMode(project, "soft", stateFileFor(home));

  const payload = JSON.stringify({ cwd: project, tool_input: { file_path: filePath } });
  const result = runHook(SOFT_NUDGE, { cwd: project, home, stdin: payload });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "");
});

test("soft-nudge: broken stdin JSON exits silently", () => {
  const project = tmpProject();
  const home = tmpHome();
  setMode(project, "soft", stateFileFor(home));

  const result = runHook(SOFT_NUDGE, { cwd: project, home, stdin: "not json at all" });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "");
});

// ---- [C2] doctor-check's SessionStart envelope ----

function runDoctorCheck({ cwd, home }) {
  return spawnSync(process.execPath, [DOCTOR_CHECK], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    input: "",
    encoding: "utf8",
  });
}

test("doctor-check: the mode announcement and dispatch target are wrapped in hookSpecificOutput/SessionStart", () => {
  const project = tmpProject();
  const home = tmpHome();
  setMode(project, "strict", stateFileFor(home));

  const result = runDoctorCheck({ cwd: project, home });

  assert.equal(result.status, 0);
  const out = JSON.parse(result.stdout);
  assert.equal(out.additionalContext, undefined, "additionalContext must not sit at the top level");
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /pi-delegate mode: strict/);
  assert.match(out.hookSpecificOutput.additionalContext, /Dispatch target/);
});

// This tmp HOME has no configuration whatsoever — which is the NORMAL state (dispatches
// use pi's own default model), not a pile of problems to fix. The old version emitted
// provider-missing / model-missing here, i.e. a red line at every freshly installed user on
// every SessionStart.
test("doctor-check: reports no problems at all when nothing is configured", () => {
  const project = tmpProject();
  const home = tmpHome();
  setMode(project, "soft", stateFileFor(home));

  const result = runDoctorCheck({ cwd: project, home });

  assert.equal(result.status, 0);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.ok(!context.includes("WARNING"), `there should be no warning: ${context}`);
  assert.ok(!context.includes("provider-missing"));
});

// The user's pi already has defaultProvider / defaultModel set (the state almost everyone
// is in) — the doctor should report faithfully which model a dispatch will reach, not
// demand they configure it a second time.
test("doctor-check: reports pi own default model as the dispatch target", () => {
  const project = tmpProject();
  const home = tmpHome();
  setMode(project, "soft", stateFileFor(home));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "settings.json"),
    JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-6" }),
  );

  const result = runDoctorCheck({ cwd: project, home });

  assert.equal(result.status, 0);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /anthropic \/ claude-sonnet-4-6/);
  assert.ok(!context.includes("WARNING"), `a hosted provider should raise no warning at all: ${context}`);
});

test("doctor-check: a broken models.json degrades to a warning instead of killing the hook", () => {
  const project = tmpProject();
  const home = tmpHome();
  setMode(project, "soft", stateFileFor(home));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "models.json"), "{ this is not valid JSON");

  const result = runDoctorCheck({ cwd: project, home });

  assert.equal(result.status, 0, `the hook must not exit non-zero: ${result.stderr}`);
  const out = JSON.parse(result.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /is not valid JSON/);
  assert.match(out.hookSpecificOutput.additionalContext, /pi-delegate mode: soft/);
});

// ---- [C3] the arena leaderboard advisory ----
//
// A REPORT, not a routing decision — see src/arena-advice.mjs. Both tests below seed a
// state where the hook has no reason to refresh, so neither touches the network: the first
// gives it a snapshot fetched just now, the second turns refreshing off. The refresh
// mechanics have their own test in test/arena-refresh.test.mjs.

function seedArena(home, { fetchedAt, rows }) {
  const dir = join(home, ".claude", "pi-delegate");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "arena-snapshot.json"), JSON.stringify({
    source: "https://arena.ai/leaderboard/agent",
    fetchedAt,
    leaderboardSnapshot: { lastUpdated: "2026-08-19T18:00:00.000Z", modelCount: rows.length },
    rows,
  }));
}

function seedModels(home, providers) {
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers }));
}

const BOARD = [
  { rank: 1, model: "Claude Opus 5 (High)", organization: "Anthropic", score: 0.12, ci: 0.01, inputPricePerMillion: 5, outputPricePerMillion: 25, sessions: 10 },
  { rank: 19, model: "GPT 5.6 Luna (xHigh)", organization: "OpenAI", score: 0.04, ci: 0.01, inputPricePerMillion: 0.2, outputPricePerMillion: 1.2, sessions: 10 },
];

test("doctor-check: reports which ranked models you actually have", () => {
  const project = tmpProject();
  const home = tmpHome();
  setMode(project, "soft", stateFileFor(home));
  seedArena(home, { fetchedAt: new Date().toISOString(), rows: BOARD });
  seedModels(home, { litellm: { models: [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }] } });

  const result = runDoctorCheck({ cwd: project, home });

  assert.equal(result.status, 0, `the hook must not exit non-zero: ${result.stderr}`);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /arena leaderboard/);
  assert.match(context, /1 of 2/);
  assert.match(context, /litellm\/gpt-5\.6-luna/);
  // The board's leader is a generation ahead of this roster and must not be claimed as a pick.
  assert.doesNotMatch(context, /Claude Opus 5/);
  // The advisory is an addition, not a replacement.
  assert.match(context, /pi-delegate mode: soft/);
});

// Someone on a metered connection, or an air-gapped machine, gets to turn the fetching off
// — and then the hook must say nothing about arena at all rather than advertising a snapshot
// it is never going to have.
test("doctor-check: says nothing about arena when refreshing is off and there is no snapshot", () => {
  const project = tmpProject();
  const home = tmpHome();
  setMode(project, "soft", stateFileFor(home));
  mkdirSync(join(home, ".claude", "pi-delegate"), { recursive: true });
  writeFileSync(join(home, ".claude", "pi-delegate", "config.json"), JSON.stringify({ arena_refresh: false }));

  const result = runDoctorCheck({ cwd: project, home });

  assert.equal(result.status, 0);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(context, /arena/i);
  assert.match(context, /pi-delegate mode: soft/);
});

// An existing snapshot is a file on disk: reading it costs nothing and stays useful even
// with refreshing turned off, so the report is kept and only the fetching stops.
test("doctor-check: still reports a snapshot it already has when refreshing is off", () => {
  const project = tmpProject();
  const home = tmpHome();
  setMode(project, "soft", stateFileFor(home));
  seedArena(home, { fetchedAt: "2020-01-01T00:00:00.000Z", rows: BOARD });
  seedModels(home, { litellm: { models: [{ id: "gpt-5.6-luna" }] } });
  writeFileSync(join(home, ".claude", "pi-delegate", "config.json"), JSON.stringify({ arena_refresh: false }));

  const result = runDoctorCheck({ cwd: project, home });

  assert.equal(result.status, 0);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /arena leaderboard/);
  assert.match(context, /stale/);
  // It may not promise a background refresh it was told not to start.
  assert.doesNotMatch(context, /refreshing in the background/);
});

// ---- the mode belongs to the FILE's project, not to the session's cwd ----
// The original lookup was `getMode(input.cwd)`, which meant a project's strict mode only
// applied while your session happened to be sitting inside it. Editing that project's
// src/ from a session opened somewhere else sailed straight through — and so did the
// protection check, because isProtectedPath measured `relative()` from the cwd's project
// root, making any file outside it read as "../…" and therefore unprotected.

test("mode-guard: a strict project is protected even when the session cwd is elsewhere", () => {
  const home = tmpHome();
  const strictProject = tmpProject();
  const elsewhere = tmpProject();
  writeFileSync(join(strictProject, "package.json"), "{}\n");
  writeFileSync(join(elsewhere, "package.json"), "{}\n");
  setMode(strictProject, "strict", stateFileFor(home));
  setMode(elsewhere, "soft", stateFileFor(home));

  mkdirSync(join(strictProject, "src"), { recursive: true });
  const filePath = join(strictProject, "src", "existing.ts");
  writeFileSync(filePath, "export const x = 1;\n");

  const payload = JSON.stringify({ cwd: elsewhere, tool_input: { file_path: filePath } });
  const result = runHook(MODE_GUARD, { cwd: elsewhere, home, stdin: payload });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"permissionDecision":"deny"/, "strict must follow the file, not the session");
  assert.match(result.stdout, /existing\.ts/);
});

test("mode-guard: a soft project is NOT blocked just because the session sits in a strict one", () => {
  const home = tmpHome();
  const strictProject = tmpProject();
  const softProject = tmpProject();
  writeFileSync(join(strictProject, "package.json"), "{}\n");
  writeFileSync(join(softProject, "package.json"), "{}\n");
  setMode(strictProject, "strict", stateFileFor(home));
  setMode(softProject, "soft", stateFileFor(home));

  mkdirSync(join(softProject, "src"), { recursive: true });
  const filePath = join(softProject, "src", "existing.ts");
  writeFileSync(filePath, "export const x = 1;\n");

  const payload = JSON.stringify({ cwd: strictProject, tool_input: { file_path: filePath } });
  const result = runHook(MODE_GUARD, { cwd: strictProject, home, stdin: payload });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "", "the file's own project is soft, so nothing is blocked");
});

test("mode-guard: strict still applies to a file edited from a subdirectory of its own project", () => {
  const home = tmpHome();
  const project = tmpProject();
  writeFileSync(join(project, "package.json"), "{}\n");
  setMode(project, "strict", stateFileFor(home));
  mkdirSync(join(project, "src", "deep"), { recursive: true });
  const filePath = join(project, "src", "deep", "existing.ts");
  writeFileSync(filePath, "export const x = 1;\n");
  const subdir = join(project, "src", "deep");

  const payload = JSON.stringify({ cwd: subdir, tool_input: { file_path: filePath } });
  const result = runHook(MODE_GUARD, { cwd: subdir, home, stdin: payload });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"permissionDecision":"deny"/);
});

// ---- an explicit per-project policy replaces the built-in src/ heuristic ----
// The heuristic only ever fitted one project shape. On a Go tree it protected nothing and
// said nothing about it, so strict looked switched on and was not.

function goProject(home) {
  const project = tmpProject();
  writeFileSync(join(project, "go.mod"), "module x\n");
  mkdirSync(join(project, "internal", "svc"), { recursive: true });
  mkdirSync(join(project, "cmd"), { recursive: true });
  writeFileSync(join(project, "internal", "svc", "a.go"), "package svc\n");
  writeFileSync(join(project, "internal", "svc", "a_test.go"), "package svc\n");
  writeFileSync(join(project, "cmd", "main.go"), "package main\n");
  setMode(project, "strict", stateFileFor(home));
  return project;
}

const guardVerdict = (project, home, filePath) =>
  runHook(MODE_GUARD, {
    cwd: project, home,
    stdin: JSON.stringify({ cwd: project, tool_input: { file_path: filePath } }),
  }).stdout.trim();

test("mode-guard: without a policy, a strict Go project is protected by nothing at all", () => {
  const home = tmpHome();
  const project = goProject(home);
  // Documents the gap the policy exists to close — not an endorsement of it.
  assert.equal(guardVerdict(project, home, join(project, "internal", "svc", "a.go")), "");
});

test("mode-guard: a policy protects the paths it names, whatever the language", () => {
  const home = tmpHome();
  const project = goProject(home);
  setPolicy(project, { protect: ["internal/**", "cmd/**/*.go"], allow: ["**/*_test.go"] }, stateFileFor(home));

  assert.match(guardVerdict(project, home, join(project, "internal", "svc", "a.go")), /"permissionDecision":"deny"/);
  assert.match(guardVerdict(project, home, join(project, "cmd", "main.go")), /"permissionDecision":"deny"/);
});

test("mode-guard: an allow pattern carves an exception out of a protected tree", () => {
  const home = tmpHome();
  const project = goProject(home);
  setPolicy(project, { protect: ["internal/**"], allow: ["**/*_test.go"] }, stateFileFor(home));

  assert.equal(guardVerdict(project, home, join(project, "internal", "svc", "a_test.go")), "");
});

test("mode-guard: a policy leaves paths it never names alone", () => {
  const home = tmpHome();
  const project = goProject(home);
  setPolicy(project, { protect: ["internal/**"] }, stateFileFor(home));
  mkdirSync(join(project, "docs"), { recursive: true });
  const doc = join(project, "docs", "x.md");
  writeFileSync(doc, "# d\n");

  assert.equal(guardVerdict(project, home, doc), "");
});

test("mode-guard: a policy still lets brand-new files through", () => {
  const home = tmpHome();
  const project = goProject(home);
  setPolicy(project, { protect: ["internal/**"] }, stateFileFor(home));

  // Never written to disk: writing a file from scratch is the shape pi is best at, and
  // that stays true whoever authored the policy.
  assert.equal(guardVerdict(project, home, join(project, "internal", "svc", "brand-new.go")), "");
});

test("mode-guard: switching mode away and back keeps the reviewed policy", () => {
  const home = tmpHome();
  const project = goProject(home);
  setPolicy(project, { protect: ["internal/**"] }, stateFileFor(home));
  setMode(project, "soft", stateFileFor(home));
  setMode(project, "strict", stateFileFor(home));

  // Losing the policy on a mode toggle would mean redoing the survey, which is how people
  // end up leaving strict off instead.
  assert.match(guardVerdict(project, home, join(project, "internal", "svc", "a.go")), /"permissionDecision":"deny"/);
});
