#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// film-ios.mjs — films a human-paced .mp4 of a Maestro flow driving an app on an iOS
// SIMULATOR via `xcrun simctl io recordVideo`. Works with ANY app: point it at a flow.yaml,
// and optionally install/reset the app under film first — or just let the flow's own
// `launchApp` do everything on whatever simulator is already booted. Plain Node ESM, zero npm
// dependencies; orchestrates external tools only: xcrun (simctl), maestro, and ffmpeg.
//
//   node film-ios.mjs <flow.yaml> [--out <dir>] [--simulator <name-or-udid>]
//        [--install <path.app|path.ipa>] [--app <bundle-id>] [--fresh] [--codec h264|hevc]
//        [--clean-status-bar] [--tighten]
//
// STATE MACHINE (one linear pipeline, no branching back-edges — a filming run is a single
// attempt, never resumed mid-way):
//
//   PREFLIGHT → DEVICE → [INSTALL/FRESH] → RECORD_START → MAESTRO → RECORD_STOP
//     → FINALIZE → [TIGHTEN] → done
//
// - PREFLIGHT: verify Node >= 20 and macOS (simctl does not exist anywhere else), resolve
//   xcrun/maestro/ffmpeg, verify the flow file exists. Any failure here exits non-zero before
//   anything on the simulator is touched.
// - DEVICE: if `--simulator <name-or-udid>` was passed, that device is booted if needed.
//   Otherwise reuse any already-booted device; else error listing available devices (there is
//   no sensible universal default for WHICH iPhone to boot). `bootstatus -b` blocks until the
//   OS is actually up — a `Booted` status alone can precede Springboard being ready.
// - INSTALL/FRESH (all optional): `--install <path>` runs `simctl install` (a simulator .app
//   build directory or an .ipa). `--fresh --app <bundle-id>` UNINSTALLS the app right before
//   install/record — on iOS that is the only real data wipe (the analog of Android's pm clear) —
//   so it requires `--install` to bring the app back. Nothing is installed or removed unless
//   you ask.
// - STATUS BAR (--clean-status-bar, opt-in): overrides the sim's menu-bar clock to Apple's
//   canonical 9:41, full battery, full signal/wifi — the classic product-shot look — and clears
//   the override after the run so the simulator isn't left lying about its battery.
// - RECORD_START..RECORD_STOP is the only window where a recording child process exists that
//   MUST be torn down on any exit path — every function from here on runs inside a try/finally
//   that SIGINTs the recorder if it's still alive, so a thrown error never leaves a zombie
//   `simctl io recordVideo` or a truncated file.
// - MAESTRO failing does not short-circuit RECORD_STOP/FINALIZE: the partial recording is still
//   finalized (useful for debugging a flaky flow), but the process still exits non-zero and
//   prints the flow's own error.
// - TIGHTEN (opt-in, --tighten): runs after FINALIZE, only if maestro succeeded. A tighten
//   failure is reported but does not fail the overall command — the raw recording already
//   succeeded by that point.
//
// Unlike Android there is NO 180s cap: `simctl io recordVideo` records until told to stop. And
// unlike Android there is no PULL step — simctl writes the video directly onto the host, into
// the output directory.
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { resolve, join, basename, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { run, runCapture, resolveTool, sleep, fileExists } from './lib/tools.mjs';
import { tighten } from './tighten.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_DIR = join(HERE, 'out');
const RECORD_WARMUP_MS = 1500; // let recordVideo actually start writing before Maestro taps
const RECORD_FINALIZE_MS = 2000; // after SIGINT, before remux — lets simctl close the file

function log(msg) {
  console.log(`[film-ios] ${msg}`);
}

function parseArgs(argv) {
  const rest = [];
  let out;
  let simulator;
  const installs = [];
  let appId;
  let fresh = false;
  let codec = 'h264';
  let cleanStatusBar = false;
  let doTighten = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out = argv[i + 1];
      i++;
    } else if (argv[i] === '--simulator') {
      simulator = argv[i + 1];
      i++;
    } else if (argv[i] === '--install') {
      installs.push(resolve(argv[i + 1]));
      i++;
    } else if (argv[i] === '--app') {
      appId = argv[i + 1];
      i++;
    } else if (argv[i] === '--fresh') {
      fresh = true;
    } else if (argv[i] === '--codec') {
      codec = String(argv[i + 1]);
      i++;
    } else if (argv[i] === '--clean-status-bar') {
      cleanStatusBar = true;
    } else if (argv[i] === '--tighten') {
      doTighten = true;
    } else {
      rest.push(argv[i]);
    }
  }
  if (rest.length !== 1 || !/\.ya?ml$/.test(rest[0])) {
    console.error(
      'usage: node film-ios.mjs <flow.yaml> [--out <dir>] [--simulator <name-or-udid>] ' +
        '[--install <path.app|path.ipa>]... [--app <bundle-id>] [--fresh] [--codec h264|hevc] ' +
        '[--clean-status-bar] [--tighten]',
    );
    process.exit(1);
  }
  if (fresh && !appId) {
    console.error('--fresh needs --app <bundle-id> (it uninstalls the app to wipe its data)');
    process.exit(1);
  }
  if (fresh && installs.length === 0) {
    console.error(
      '--fresh also needs --install <path>: on iOS wiping data means uninstalling, and without ' +
        '--install the app would be gone entirely',
    );
    process.exit(1);
  }
  return {
    flowArg: rest[0],
    outDir: out ? resolve(out) : DEFAULT_OUT_DIR,
    simulator,
    installs,
    appId,
    fresh,
    codec,
    cleanStatusBar,
    doTighten,
  };
}

// ── PREFLIGHT ───────────────────────────────────────────────────────────────────────────────
async function preflight(flowPath) {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 20) {
    throw new Error(`Node >= 20 required — running under Node ${process.version}`);
  }
  if (platform() !== 'darwin') {
    throw new Error('iOS Simulator filming requires macOS (xcrun/simctl only exist there)');
  }
  if (!(await fileExists(flowPath))) {
    throw new Error(`flow file not found: ${flowPath}`);
  }
  const tools = {};
  for (const name of ['xcrun', 'maestro', 'ffmpeg']) tools[name] = await resolveTool(name);
  return tools;
}

// ── DEVICE: use --simulator, reuse a booted one, or boot the named one ──────────────────────
// `simctl list devices` sections look like:
//   -- iOS 18.2 --
//       iPhone 16 Pro (A1B2C3D4-...) (Shutdown)
//       iPhone 15 (DEADBEEF-...) (Booted)
// Lines can also carry "(Unavailable)". We parse name, UDID, and state off each line.
async function listSimulators(xcrun, filter /* e.g. 'available' */) {
  const args = ['simctl', 'list', 'devices'];
  if (filter) args.push(filter);
  const stdout = await runCapture(xcrun, args);
  const devices = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s+(.+?)\s+\(([0-9A-Fa-f-]{36})\)\s+\((Available|Booted|Shutdown|Creating|Deleting)\)/);
    if (!m) continue;
    devices.push({ name: m[1], udid: m[2], state: m[3].toLowerCase() });
  }
  return devices;
}

async function ensureDevice(xcrun, requested) {
  const booted = (await listSimulators(xcrun)).filter((d) => d.state === 'booted');
  if (!requested) {
    if (booted.length > 0) {
      log(`reusing already-booted simulator ${booted[0].name} (${booted[0].udid})`);
      return booted[0].udid;
    }
    const available = await listSimulators(xcrun, 'available');
    throw new Error(
      'no iOS simulator is booted and no --simulator was given. Boot one yourself, or pass ' +
        '--simulator <name-or-udid>. Available:\n' +
        available.map((d) => `  ${d.name} (${d.udid})`).join('\n'),
    );
  }

  // Match by UDID first, then by exact name, then by unique substring of the name.
  const all = await listSimulators(xcrun, 'available');
  let match =
    all.find((d) => d.udid.toLowerCase() === requested.toLowerCase()) ??
    all.find((d) => d.name === requested) ??
    null;
  if (!match) {
    const partial = all.filter((d) => d.name.toLowerCase().includes(requested.toLowerCase()));
    if (partial.length === 1) match = partial[0];
    if (partial.length > 1) {
      throw new Error(`--simulator "${requested}" is ambiguous: ${partial.map((d) => d.name).join(', ')}`);
    }
  }
  if (!match) throw new Error(`no AVAILABLE simulator matches "${requested}"`);

  if (match.state !== 'booted') {
    log(`booting simulator ${match.name} (${match.udid})...`);
    await run(xcrun, ['simctl', 'boot', match.udid]).catch(() => {}); // "already booted" races are fine
    // bootstatus -b blocks until the system is genuinely up (Springboard answering), which a
    // plain "(Booted)" list status does NOT guarantee.
    await runCapture(xcrun, ['simctl', 'bootstatus', match.udid, '-b']);
    log(`simulator ${match.name} finished booting`);
  } else {
    log(`using already-booted simulator ${match.name} (${match.udid})`);
  }
  return match.udid;
}

// ── screen recording: started/stopped around the maestro run ──────────────────────────────
function startRecording(xcrun, udid, rawPath, codec) {
  // --force overwrites a stale file from a previous run instead of failing half a minute in.
  const child = spawn(xcrun, ['simctl', 'io', udid, 'recordVideo', '--codec', codec, '--force', rawPath], {
    stdio: 'ignore',
  });
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  return {
    child,
    get isRunning() {
      return !exited;
    },
  };
}

// SIGINT makes `simctl io recordVideo` finalize the container cleanly (it is documented as
// "press Ctrl-C to stop") — SIGKILL would leave a truncated file, same shape as adb screenrecord.
async function stopRecording(recorder) {
  if (recorder.isRunning) {
    recorder.child.kill('SIGINT');
  }
  await sleep(RECORD_FINALIZE_MS);
}

async function overrideStatusBar(xcrun, udid) {
  try {
    await run(xcrun, [
      'simctl',
      'status_bar',
      udid,
      'override',
      '--time',
      '9:41',
      '--batteryState',
      'charged',
      '--batteryLevel',
      '100',
      '--wifiBars',
      '3',
      '--cellularBars',
      '4',
    ]);
    return true;
  } catch (err) {
    log(`status-bar override failed (${err.message}) — filming without it`);
    return false;
  }
}

async function finalizeVideo(ffmpeg, rawPath, outPath) {
  try {
    await run(ffmpeg, ['-y', '-i', rawPath, '-c', 'copy', '-movflags', '+faststart', outPath], { stdio: 'inherit' });
  } catch (err) {
    log(`ffmpeg remux (stream copy) failed (${err.message}) — falling back to re-encode...`);
    await run(ffmpeg, ['-y', '-i', rawPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outPath], { stdio: 'inherit' });
  }
}

async function main() {
  const { flowArg, outDir, simulator, installs, appId, fresh, codec, cleanStatusBar, doTighten } =
    parseArgs(process.argv.slice(2));
  const flowPath = resolve(flowArg);
  const flowName = `${basename(flowPath, extname(flowPath))}-ios`;

  let tools;
  try {
    tools = await preflight(flowPath);
  } catch (err) {
    console.error(`[film-ios] preflight failed: ${err.message}`);
    process.exit(1);
  }
  const { xcrun, maestro, ffmpeg } = tools;

  await mkdir(outDir, { recursive: true });

  let udid;
  let statusBarOverridden = false;
  try {
    udid = await ensureDevice(xcrun, simulator ?? process.env.FILMKIT_IOS_SIMULATOR);
    if (fresh && appId) {
      log(`uninstalling ${appId} (wipes its data)...`);
      await run(xcrun, ['simctl', 'uninstall', udid, appId]);
    }
    for (const path of installs) {
      log(`installing ${path}...`);
      await run(xcrun, ['simctl', 'install', udid, path]);
    }
    if (appId && !fresh) {
      await run(xcrun, ['simctl', 'terminate', udid, appId]).catch(() => {}); // best-effort cold start
    }
    if (cleanStatusBar) statusBarOverridden = await overrideStatusBar(xcrun, udid);
  } catch (err) {
    console.error(`[film-ios] setup failed before recording started: ${err.message}`);
    process.exit(1);
  }

  // From here on, a recorder process may exist — every exit path below tears it down via the
  // finally block, whether the flow succeeds, throws, or is aborted.
  const rawLocalPath = join(outDir, `.${flowName}.raw.mp4`);
  const outPath = join(outDir, `${flowName}.mp4`);
  log('starting screen recording...');
  const recorder = startRecording(xcrun, udid, rawLocalPath, codec);
  await sleep(RECORD_WARMUP_MS);

  let maestroError = null;
  try {
    log(`running maestro test ${flowPath}...`);
    // Run from the CALLER's working directory so relative paths inside the flow yaml resolve
    // against the user's project, not this repo. `--udid` is load-bearing when an Android
    // emulator is also running — without it maestro happily picks whichever device it likes.
    await run(maestro, ['test', '--udid', udid, flowPath]);
  } catch (err) {
    maestroError = err;
  } finally {
    log('stopping screen recording...');
    await stopRecording(recorder);
  }

  if (statusBarOverridden) {
    await run(xcrun, ['simctl', 'status_bar', udid, 'clear']).catch(() => {}); // best-effort
  }

  try {
    log(`finalizing ${outPath}...`);
    await finalizeVideo(ffmpeg, rawLocalPath, outPath);
    await rm(rawLocalPath, { force: true });
  } catch (err) {
    console.error(`[film-ios] failed to finalize the recording: ${err.message}`);
    process.exit(1);
  }

  if (maestroError) {
    console.error(`\n[film-ios] maestro flow "${flowName}" failed: ${maestroError.message}`);
    console.error(`[film-ios] the partial recording was still saved to ${outPath} for debugging.`);
    process.exit(1);
  }

  console.log(`\n[film-ios] Demo video written: ${outPath}`);

  if (doTighten) {
    try {
      const result = await tighten(outPath);
      if (result.skipped) {
        log(`already tight (no static stretches found) — kept raw only: ${outPath}`);
      } else {
        log(
          `tightened ${result.totalDuration.toFixed(2)}s -> ${result.outDuration.toFixed(2)}s ` +
            `(${result.cuts} cuts, ${result.removedSec.toFixed(2)}s removed)`,
        );
        console.log(`[film-ios] Tightened demo video written: ${result.outPath}`);
      }
    } catch (err) {
      console.error(`[film-ios] --tighten skipped — ${err.message}`);
    }
  }
}

await main();
