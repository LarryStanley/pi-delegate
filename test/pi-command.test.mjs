import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePiCommand, extractShimTarget } from "../src/pi-command.mjs";

// The real npm-generated shim, trimmed to the line that matters. Kept verbatim rather than
// paraphrased: the whole point of this module is that the shim's actual text is what we
// have to survive.
const NPM_CMD_SHIM = `@ECHO off
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*
`;

const CLI = "C:/Users/Me/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const WIN_ENV = { PATH: "C:\\Windows\\system32;C:\\Users\\Me\\AppData\\Roaming\\npm" };

const winExists = (extra = []) => {
  const present = new Set(["C:\\Users\\Me\\AppData\\Roaming\\npm\\pi.cmd", CLI, ...extra]);
  return (p) => present.has(p);
};

test("extractShimTarget pulls the JS entry out of an npm .cmd shim and expands %dp0%", () => {
  const target = extractShimTarget(NPM_CMD_SHIM, "C:\\Users\\Me\\AppData\\Roaming\\npm");
  assert.equal(target, CLI);
});

test("extractShimTarget handles the PowerShell shim's $PSScriptRoot spelling", () => {
  const ps1 = `$exe=""\n& "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" $args\n`;
  assert.equal(
    extractShimTarget(ps1, "C:\\npm"),
    "C:/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
  );
});

test("extractShimTarget leaves an already-absolute target alone", () => {
  assert.equal(extractShimTarget(`"${CLI}" %*`, "C:\\ignored"), CLI);
});

test("extractShimTarget returns null when there is no JS path to find", () => {
  assert.equal(extractShimTarget("@ECHO off\r\nexit /b 1\r\n", "C:\\npm"), null);
});

// --- resolvePiCommand -----------------------------------------------------------------

test("POSIX is untouched: still plain pi, no probing", () => {
  assert.deepEqual(
    resolvePiCommand({ platform: "darwin", env: WIN_ENV, exists: () => true }),
    ["pi"],
  );
});

test("Windows resolves the .cmd shim to [node, cli.js] — the ENOENT fix", () => {
  const argv = resolvePiCommand({
    platform: "win32",
    env: WIN_ENV,
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    exists: winExists(),
    readFile: () => NPM_CMD_SHIM,
  });
  assert.deepEqual(argv, ["C:\\Program Files\\nodejs\\node.exe", CLI]);
  // The thing that must never come back: spawning the shim itself, which Node refuses
  // outright since the CVE-2024-27980 fix.
  assert.ok(!argv.some((a) => a.endsWith(".cmd")));
});

test("Windows prefers a real .exe and spawns it directly, without unwrapping", () => {
  const exe = "C:\\Users\\Me\\AppData\\Roaming\\npm\\pi.exe";
  assert.deepEqual(
    resolvePiCommand({
      platform: "win32",
      env: WIN_ENV,
      exists: winExists([exe]),
      readFile: () => {
        throw new Error("must not read a shim when a real executable is present");
      },
    }),
    [exe],
  );
});

test("an explicit pi_command wins everywhere, string or array", () => {
  assert.deepEqual(
    resolvePiCommand({ configured: "/opt/pi/bin/pi", platform: "win32", env: WIN_ENV, exists: () => true }),
    ["/opt/pi/bin/pi"],
  );
  assert.deepEqual(
    resolvePiCommand({ configured: ["node", "C:/custom/cli.js"], platform: "win32", env: WIN_ENV, exists: () => true }),
    ["node", "C:/custom/cli.js"],
  );
});

test("falls back to plain pi when nothing on PATH matches, keeping the familiar ENOENT", () => {
  assert.deepEqual(
    resolvePiCommand({ platform: "win32", env: WIN_ENV, exists: () => false }),
    ["pi"],
  );
});

test("falls back to plain pi when the shim exists but points at a file that does not", () => {
  const exists = (p) => p === "C:\\Users\\Me\\AppData\\Roaming\\npm\\pi.cmd";
  assert.deepEqual(
    resolvePiCommand({ platform: "win32", env: WIN_ENV, exists, readFile: () => NPM_CMD_SHIM }),
    ["pi"],
  );
});

test("falls back to plain pi when the shim cannot be read at all", () => {
  assert.deepEqual(
    resolvePiCommand({
      platform: "win32",
      env: WIN_ENV,
      exists: winExists(),
      readFile: () => {
        throw new Error("EACCES");
      },
    }),
    ["pi"],
  );
});
