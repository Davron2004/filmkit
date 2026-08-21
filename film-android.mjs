#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// film-android.mjs — films a human-paced .mp4 of a Maestro flow driving an app on a real
// Android emulator via `adb shell screenrecord`. Works with ANY app: point it at a flow.yaml,
// and optionally install/clear the app under film first — or just let the flow's own
// `launchApp` do everything on whatever device is already running.
// Plain Node ESM, zero npm dependencies; orchestrates external tools only: adb, maestro, the
// emulator binary, and ffmpeg.
//
//   node film-android.mjs <flow.yaml> [--out <dir>] [--device <serial>] [--avd <name>]
//        [--install <apk>]... [--app <package-id>] [--fresh] [--bit-rate <n>] [--tighten]
//
// STATE MACHINE (one linear pipeline, no branching back-edges — a filming run is a single
// attempt, never resumed mid-way):
//
//   PREFLIGHT → DEVICE → [INSTALL/FRESH] → RECORD_START → MAESTRO → RECORD_STOP
//     → FINALIZE → [TIGHTEN] → done
//
// - PREFLIGHT: verify Node >= 20, resolve adb/maestro/ffmpeg/emulator (PATH first, then
//   $FILMKIT_* overrides, then grounded fallbacks in lib/tools.mjs), verify the flow file
//   exists. Any failure here exits non-zero before anything on the device is touched.
// - DEVICE: if `--device <serial>` was passed, that serial must be online. Otherwise reuse any
//   already-running device (`adb devices`, state "device"); else boot the requested AVD headless
//   and poll for `sys.boot_completed`. Generous timeout — an emulator cold-boot is legitimately
//   slow.
// - INSTALL/FRESH (all optional): `--install <apk>` runs `adb install -r` for each apk passed
//   (idempotent). `--fresh` requires `--app <package-id>` and runs `pm clear` on it right before
//   recording, so the flow always starts from a fresh-first-run state (the Android analog of
//   reinstalling). Nothing is installed or cleared unless you ask.
// - RECORD_START..RECORD_STOP is the only window where an on-device child process exists that
//   MUST be torn down on any exit path — every function from here on runs inside a try/finally
//   that SIGINTs the recorder if it's still alive, so a thrown error (including a failed
//   `maestro test`) never leaves a zombie `screenrecord` process or an un-pulled device file.
// - MAESTRO failing does not short-circuit RECORD_STOP/FINALIZE: the partial recording is still
//   pulled and transcoded (useful for debugging a flaky flow), but the process still exits
//   non-zero and prints the flow's own error.
// - TIGHTEN (opt-in, --tighten): runs after FINALIZE, only if maestro succeeded (a failed flow's
//   partial recording is left as-is for debugging, not tightened). Calls tighten.mjs's
//   `tighten()` over the finalized .mp4; the raw file is always kept, a `-tight` variant is
//   written alongside it. A tighten failure is reported but does not fail the overall command —
//   the raw recording already succeeded by that point.
//
// CAP: `adb shell screenrecord` hard-stops recording at 180s. Flows filmed by this tool must
// stay comfortably under that (~2.5 min) — film-android.mjs does not attempt to chain recordings.
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { resolve, join, basename, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { run, runCapture, resolveTool, sleep, fileExists } from './lib/tools.mjs';
import { tighten } from './tighten.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_DIR = join(HERE, 'out');
const DEVICE_RECORDING_PATH = '/sdcard/filmkit-demo.mp4';

const DEFAULT_BIT_RATE = '8000000';
const RECORD_WARMUP_MS = 1500; // let screenrecord actually start on-device before Maestro taps
const RECORD_FINALIZE_MS = 2000; // after SIGINT, before adb pull — lets the on-device mp4 close
const BOOT_TIMEOUT_MS = 5 * 60 * 1000; // cold emulator boot is legitimately slow
const BOOT_POLL_MS = 3000;

function log(msg) {
  console.log(`[film-android] ${msg}`);
}

function parseArgs(argv) {
  const rest = [];
  let out;
  let device;
  let avd;
  const installs = [];
  let appId;
  let fresh = false;
  let bitRate = DEFAULT_BIT_RATE;
  let doTighten = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out = argv[i + 1];
      i++;
    } else if (argv[i] === '--device') {
      device = argv[i + 1];
      i++;
    } else if (argv[i] === '--avd') {
      avd = argv[i + 1];
      i++;
    } else if (argv[i] === '--install') {
      installs.push(resolve(argv[i + 1]));
      i++;
    } else if (argv[i] === '--app') {
      appId = argv[i + 1];
      i++;
    } else if (argv[i] === '--fresh') {
      fresh = true;
    } else if (argv[i] === '--bit-rate') {
      bitRate = String(argv[i + 1]);
      i++;
    } else if (argv[i] === '--tighten') {
      doTighten = true;
    } else {
      rest.push(argv[i]);
    }
  }
  if (rest.length !== 1 || !/\.ya?ml$/.test(rest[0])) {
    console.error(
      'usage: node film-android.mjs <flow.yaml> [--out <dir>] [--device <serial>] [--avd <name>] ' +
        '[--install <apk>]... [--app <package-id>] [--fresh] [--bit-rate <n>] [--tighten]',
    );
    process.exit(1);
  }
  if (device && avd) {
    console.error('--device and --avd are mutually exclusive');
    process.exit(1);
  }
  if (fresh && !appId) {
    console.error('--fresh needs --app <package-id> (it runs `adb shell pm clear` on it)');
    process.exit(1);
  }
  return { flowArg: rest[0], outDir: out ? resolve(out) : DEFAULT_OUT_DIR, device, avd, installs, appId, fresh, bitRate, doTighten };
}

// ── PREFLIGHT ───────────────────────────────────────────────────────────────────────────────
async function preflight(flowPath) {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 20) {
    throw new Error(`Node >= 20 required — running under Node ${process.version}`);
  }
  if (!(await fileExists(flowPath))) {
    throw new Error(`flow file not found: ${flowPath}`);
  }
  // The emulator binary is only needed when we may have to boot one; adb/maestro/ffmpeg always.
  const tools = {};
  for (const name of ['adb', 'maestro', 'ffmpeg']) tools[name] = await resolveTool(name);
  return tools;
}

// ── DEVICE: use --device, reuse a running emulator, or boot one ─────────────────────────────
async function listOnlineDevices(adb) {
  const stdout = await runCapture(adb, ['devices']);
  return stdout
    .split('\n')
    .slice(1) // drop the "List of devices attached" header line
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .filter(([, state]) => state === 'device')
    .map(([id]) => id);
}

async function ensureDevice(adb, requestedDevice, avdName) {
  if (requestedDevice) {
    const online = await listOnlineDevices(adb);
    if (!online.includes(requestedDevice)) {
      throw new Error(`--device ${requestedDevice} is not online (online: ${online.join(', ') || '(none)'})`);
    }
    return requestedDevice;
  }

  const online = await listOnlineDevices(adb);
  if (online.length > 0) {
    log(`reusing already-running device ${online[0]}`);
    return online[0];
  }

  if (!avdName) {
    throw new Error(
      'no Android device is running and no --avd was given — pass --avd <name>, start an ' +
        "emulator yourself, or target a plugged-in device with --device <serial>",
    );
  }

  const emulator = await resolveTool('emulator');
  const avdList = (await runCapture(emulator, ['-list-avds'])).split('\n').map((s) => s.trim()).filter(Boolean);
  if (!avdList.includes(avdName)) {
    throw new Error(`AVD "${avdName}" not found (available: ${avdList.join(', ') || '(none)'})`);
  }

  log(`no device running — booting AVD "${avdName}" headless...`);
  const child = spawn(
    emulator,
    ['-avd', avdName, '-no-window', '-gpu', 'swiftshader_indirect', '-no-snapshot', '-no-audio'],
    { detached: true, stdio: 'ignore' },
  );
  child.unref(); // outlives this process on purpose — the orchestrator may want it after we exit
  child.on('error', (err) => {
    // Fires only for a spawn-level failure (e.g. binary missing) — the boot-poll loop below
    // is what actually detects "never came up" and produces the user-facing error.
    console.error(`[film-android] emulator process error: ${err.message}`);
  });

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const nowOnline = await listOnlineDevices(adb);
    if (nowOnline.length > 0) {
      try {
        const boot = (await runCapture(adb, ['-s', nowOnline[0], 'shell', 'getprop', 'sys.boot_completed'])).trim();
        if (boot === '1') {
          log(`device ${nowOnline[0]} finished booting`);
          return nowOnline[0];
        }
      } catch {
        // device node exists but boot isn't far enough along to answer shell commands yet
      }
    }
    await sleep(BOOT_POLL_MS);
  }
  throw new Error(`emulator "${avdName}" did not finish booting within ${BOOT_TIMEOUT_MS / 1000}s`);
}

// ── screen recording: started/stopped around the maestro run ──────────────────────────────
function startScreenrecord(adb, deviceId, deviceRecordingPath, bitRate) {
  const child = spawn(
    adb,
    ['-s', deviceId, 'shell', 'screenrecord', '--bit-rate', bitRate, deviceRecordingPath],
    { stdio: 'ignore' },
  );
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

// SIGINT on the local `adb shell` client forwards a Ctrl-C to the remote pty, which is what
// makes the on-device `screenrecord` process finalize its mp4 container instead of leaving it
// truncated — killing the local process outright (SIGKILL/SIGTERM) does not do this.
async function stopScreenrecord(recorder) {
  if (recorder.isRunning) {
    recorder.child.kill('SIGINT');
  }
  await sleep(RECORD_FINALIZE_MS);
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
  const { flowArg, outDir, device: requestedDevice, avd, installs, appId, fresh, bitRate, doTighten } =
    parseArgs(process.argv.slice(2));
  const flowPath = resolve(flowArg);
  const flowName = `${basename(flowPath, extname(flowPath))}-android`;

  let tools;
  try {
    tools = await preflight(flowPath);
  } catch (err) {
    console.error(`[film-android] preflight failed: ${err.message}`);
    process.exit(1);
  }
  const { adb, maestro, ffmpeg } = tools;

  await mkdir(outDir, { recursive: true });

  let deviceId;
  try {
    deviceId = await ensureDevice(adb, requestedDevice, avd ?? process.env.FILMKIT_ANDROID_AVD);
    for (const apk of installs) {
      log(`installing ${apk}...`);
      await run(adb, ['-s', deviceId, 'install', '-r', apk]);
    }
    if (fresh) {
      log(`clearing app data (pm clear ${appId}) for a fresh first-run state...`);
      await run(adb, ['-s', deviceId, 'shell', 'pm', 'clear', appId]);
    }
  } catch (err) {
    console.error(`[film-android] setup failed before recording started: ${err.message}`);
    process.exit(1);
  }

  // From here on, a recorder process may exist on the device — every exit path below tears it
  // down via the finally block, whether the flow succeeds, throws, or is aborted.
  const deviceRecordingPath = DEVICE_RECORDING_PATH;
  log('starting screen recording...');
  const recorder = startScreenrecord(adb, deviceId, deviceRecordingPath, bitRate);
  await sleep(RECORD_WARMUP_MS);

  let maestroError = null;
  try {
    log(`running maestro test ${flowPath}...`);
    // Run from the CALLER's working directory so relative paths inside the flow yaml (screenshots,
    // uploaded files, subflows) resolve against the user's project, not this repo.
    await run(maestro, ['--device', deviceId, 'test', flowPath]);
  } catch (err) {
    maestroError = err;
  } finally {
    log('stopping screen recording...');
    await stopScreenrecord(recorder);
  }

  const rawLocalPath = join(outDir, `.${flowName}.raw.mp4`);
  const outPath = join(outDir, `${flowName}.mp4`);
  try {
    log(`pulling ${deviceRecordingPath}...`);
    await run(adb, ['-s', deviceId, 'pull', deviceRecordingPath, rawLocalPath]);
    await run(adb, ['-s', deviceId, 'shell', 'rm', deviceRecordingPath]).catch(() => {}); // best-effort
    log(`finalizing ${outPath}...`);
    await finalizeVideo(ffmpeg, rawLocalPath, outPath);
    await rm(rawLocalPath, { force: true });
  } catch (err) {
    console.error(`[film-android] failed to pull/finalize the recording: ${err.message}`);
    process.exit(1);
  }

  if (maestroError) {
    console.error(`\n[film-android] maestro flow "${flowName}" failed: ${maestroError.message}`);
    console.error(`[film-android] the partial recording was still saved to ${outPath} for debugging.`);
    process.exit(1);
  }

  console.log(`\n[film-android] Demo video written: ${outPath}`);

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
        console.log(`[film-android] Tightened demo video written: ${result.outPath}`);
      }
    } catch (err) {
      console.error(`[film-android] --tighten skipped — ${err.message}`);
    }
  }
}

await main();
