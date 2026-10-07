#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// tools/doctor.mjs — what each camera needs on this machine, what is missing, and the exact fix.
//
//   node tools/doctor.mjs            (or: <skill>/filmkit doctor; setup.sh runs it last)
//
// EXIT: 0 when the WEB camera is ready, 1 when it is not. The device cameras are reported but never
// change the exit code: web is the path that must work on a fresh machine, and setup.sh's own exit
// code is this one.
//
// Every check asks the question the camera itself will ask, through the same code, so doctor cannot
// say ready while filming would refuse: tools resolve through lib/tools.mjs's resolveTool (PATH, then
// $FILMKIT_<NAME>, then the known install locations), and the browsers through lib/browser-probe.mjs,
// which film-web.mjs's BACKEND SELECTION uses (a real ego-browser round trip, a real Chromium launch).
//
// WEB is ready when node >= 20, ffmpeg and ffprobe resolve, and at least one browser can film:
// ego-browser answering (found like any tool: PATH, $FILMKIT_EGO_BROWSER, ~/.local/bin; the row says
// where), or Playwright's Chromium launching. ego-browser is reported as optional when
// Playwright is ready (it is what films signed in as the user), and the headline names which browser
// a default `--browser auto` run would film in.
import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTool, INSTALL_HINTS } from '../lib/tools.mjs';
import { probeEgo, probePlaywright, EGO_INSTALL_HINT, PLAYWRIGHT_SETUP_HINT, SETUP_COMMAND } from '../lib/browser-probe.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAC = platform() === 'darwin';

// Every fix ends by naming what to run next, and from here that is doctor itself (setup.sh runs it
// last, and stops at its own prerequisite step before doctor could see a missing tool).
const AGAIN = `then run doctor again (node ${join(ROOT, 'tools', 'doctor.mjs')})`;

const lines = [];
const out = (s = '') => lines.push(s);
// One row per requirement: ok | MISSING | optional, then what it is, then the fix on its own line.
const row = (status, what, fix) => {
  out(`  ${status.padEnd(8)} ${what}`);
  // An optional row's line is how to get it, not a fix: nothing is wrong.
  if (fix) out(`           ${status === 'optional' ? 'to add it' : 'fix'}: ${fix}`);
};

async function tool(name) {
  try {
    return { ok: true, path: await resolveTool(name) };
  } catch {
    return { ok: false, path: null };
  }
}

function run(cmd, args, timeoutMs = 15000) {
  return new Promise((resolvePromise) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => resolvePromise({ ok: !err, stdout, stderr }));
  });
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
const nodeOk = nodeMajor >= 20;

// Independent checks, in parallel: the browser probes are the slow ones (a Chromium launch).
const [ffmpeg, ffprobe, adb, emulator, maestro, xcrun, ego, pw] = await Promise.all([
  tool('ffmpeg'),
  tool('ffprobe'),
  tool('adb'),
  tool('emulator'),
  tool('maestro'),
  MAC ? tool('xcrun') : Promise.resolve({ ok: false, path: null }),
  probeEgo(),
  probePlaywright(),
]);
// simctl is part of Xcode, not of the Command Line Tools: xcrun alone does not make the iOS camera work.
const simctl = MAC && xcrun.ok ? await run(xcrun.path, ['simctl', 'help']) : { ok: false };

const ffOk = ffmpeg.ok && ffprobe.ok;
const egoReady = ego.state === 'ready';
const pwReady = pw.state === 'ready';
const webReady = nodeOk && ffOk && (egoReady || pwReady);

out(`filmkit doctor (${ROOT})`);
out();

// ── WEB ──────────────────────────────────────────────────────────────────────────────────────────
const films = egoReady ? 'films in ego-browser, your own signed-in browser' : "films in Playwright's Chromium (starts signed out)";
out(webReady ? `WEB camera: READY, ${films}` : 'WEB camera: NOT READY (fix the MISSING lines below, then run doctor again)');
row(nodeOk ? 'ok' : 'MISSING', `Node.js 20 or newer (this is ${process.versions.node})`, nodeOk ? null : `brew upgrade node (or brew install node), ${AGAIN}`);
row(ffOk ? 'ok' : 'MISSING', 'ffmpeg and ffprobe', ffOk ? null : `${INSTALL_HINTS.ffmpeg}, ${AGAIN}`);
if (pwReady) row('ok', "Playwright's Chromium");
else {
  const what = pw.state === 'no-package' ? 'Playwright is not installed' : pw.state === 'no-browser' ? "Playwright's Chromium is not downloaded" : `Chromium would not start: ${pw.detail}`;
  // Not required when ego films, so not MISSING then.
  row(egoReady ? 'optional' : 'MISSING', `Playwright's Chromium: ${what}`, PLAYWRIGHT_SETUP_HINT);
}
// Where it was found: on PATH, or the full path when it was found off PATH ($FILMKIT_EGO_BROWSER, or
// ~/.local/bin when ego's onboarding did not reach this shell's PATH), so a surprise is visible.
const egoWhere = ego.path === 'ego-browser' ? 'on PATH' : ego.path ? `at ${ego.path}, not on PATH` : null;
if (egoReady) row('ok', `ego-browser (answering; ${egoWhere})`);
else {
  const status = pwReady ? 'optional' : 'MISSING';
  if (ego.state === 'missing') {
    row(status, 'ego-browser: not installed. Only needed to film a site signed in as yourself', EGO_INSTALL_HINT);
  } else {
    row(status, `ego-browser: installed (${egoWhere}), not answering (${ego.detail})`, `open the ego lite app, wait for its window, ${AGAIN}`);
  }
}
out();

// ── THE SHARED REQUIREMENTS, under every camera that needs them ──────────────────────────────────
// Each camera's section lists everything its READY depends on, so a "not ready" never stands over a
// list of ok lines (the device cameras assemble and check their takes with ffmpeg/ffprobe, and run on
// Node like the rest). Node's row is shown only when it is the problem: it is the same Node that is
// running this, and WEB already names its version.
function sharedRows() {
  if (!nodeOk) row('MISSING', `Node.js 20 or newer (this is ${process.versions.node})`, `brew upgrade node (or brew install node), ${AGAIN}`);
  row(ffOk ? 'ok' : 'MISSING', 'ffmpeg and ffprobe', ffOk ? null : `${INSTALL_HINTS.ffmpeg}, ${AGAIN}`);
}

// ── ANDROID ──────────────────────────────────────────────────────────────────────────────────────
const androidReady = nodeOk && ffOk && adb.ok && maestro.ok;
out(androidReady ? 'ANDROID camera: READY' : 'ANDROID camera: not ready (only needed to film Android apps)');
sharedRows();
row(adb.ok ? 'ok' : 'MISSING', 'adb', adb.ok ? null : INSTALL_HINTS.adb);
row(maestro.ok ? 'ok' : 'MISSING', 'maestro', maestro.ok ? null : INSTALL_HINTS.maestro);
row(emulator.ok ? 'ok' : 'optional', 'Android emulator (not needed with a running emulator or a USB device)', emulator.ok ? null : INSTALL_HINTS.emulator);
out();

// ── iOS ──────────────────────────────────────────────────────────────────────────────────────────
if (!MAC) {
  out('iOS camera: not available (it needs a Mac with Xcode)');
} else {
  const iosReady = nodeOk && ffOk && simctl.ok && maestro.ok;
  out(iosReady ? 'iOS camera: READY' : 'iOS camera: not ready (only needed to film iOS apps)');
  sharedRows();
  row(simctl.ok ? 'ok' : 'MISSING', 'Xcode (xcrun simctl)', simctl.ok ? null : INSTALL_HINTS.xcrun);
  row(maestro.ok ? 'ok' : 'MISSING', 'maestro', maestro.ok ? null : INSTALL_HINTS.maestro);
}
out();

// ── THE SKILL ────────────────────────────────────────────────────────────────────────────────────
const link = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'skills', 'film-demo');
const want = await realpath(join(ROOT, 'skills', 'film-demo'));
let skill;
try {
  const st = await lstat(link);
  const target = await realpath(link).catch(() => null);
  if (st.isSymbolicLink() && target === want) skill = { ok: true, text: `installed (${link} -> ${want})` };
  else if (st.isSymbolicLink()) skill = { ok: false, text: `${link} points to ${target ?? 'a path that no longer exists'}, not to this checkout` };
  else skill = { ok: false, text: `${link} is a separate copy, not this checkout` };
} catch {
  skill = { ok: false, text: `not installed (nothing at ${link})` };
}
out(`Claude Code skill: ${skill.text}`);
if (!skill.ok) out(`  fix: run \`${SETUP_COMMAND}\` (it backs up anything already there), then restart Claude Code`);

console.log(lines.join('\n'));
process.exit(webReady ? 0 : 1);
