#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// film-ios.mjs — films a human-paced .mp4 of a Maestro flow driving an app on an iOS
// SIMULATOR via `xcrun simctl io recordVideo`. Works with ANY app: point it at a flow.yaml,
// and optionally install/reset the app under film first — or just let the flow's own
// `launchApp` do everything on whatever simulator is already booted. Plain Node ESM, zero npm
// dependencies; orchestrates external tools only: xcrun (simctl), maestro, and ffmpeg.
//
//   node film-ios.mjs <flow.yaml> [--out <dir>] [--name <basename>] [--force]
//        [--simulator <name-or-udid>] [--install <path.app|path.ipa>] [--app <bundle-id>]
//        [--fresh] [--codec h264|hevc] [--clean-status-bar] [--no-show-taps] [--tighten]
//
// STATE MACHINE (one linear pipeline, no branching back-edges — a filming run is a single
// attempt, never resumed mid-way):
//
//   PREFLIGHT → DEVICE → [INSTALL/FRESH] → RECORD_START → MAESTRO → SALVAGE(stop, restore,
//     FINALIZE) → [SHOW_TAPS] → [TRIM TAIL] → [TIGHTEN] → SIDECAR → done
//
// The one back-edge is Ctrl-C. The handler goes on once the device is set up — before the camera
// rolls, so it already owns the status-bar override — and from there SIGINT jumps straight to
// SALVAGE and out through exit 130, running the same salvage the ordinary path runs, memoised so
// exactly one of them does the work. That is what makes "interrupted" a state with a finished
// .mp4, a sidecar and a simulator put back, rather than an orphaned recorder, a half-burned
// dot-file and a simulator still insisting it is 9:41.
//
// - PREFLIGHT: verify macOS (simctl does not exist anywhere else), then the three checks every
//   filmkit camera shares (lib/preflight.mjs): Node >= 20, the flow file exists, and NO EXISTING
//   TAKE IS CLOBBERED — `<name>.mp4`, `<name>.json` and, with --tighten, `<name>-tight.mp4` must
//   not already exist unless `--force` says so. Filming is a repeated activity and a clobbered
//   take is gone; the refusal happens here rather than at write time so a run that is going to
//   refuse does it before spending a minute on the simulator. Then resolve xcrun/maestro/ffmpeg.
//   Any failure here exits non-zero before anything on the simulator is touched.
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
// - RECORD_START..SALVAGE is the only window where a recording child process exists that MUST be
//   torn down on any exit path. Everything that has to happen regardless of how the run ends —
//   SIGINT the recorder, clear the status-bar override, remux what was captured — lives in
//   salvage(), and both the ordinary path and the Ctrl-C handler go through it. A thrown error, a
//   failed flow and an impatient operator therefore all leave the same tidy state: no zombie
//   `simctl io recordVideo`, no truncated file, no simulator still claiming it is 9:41.
// - MAESTRO failing does not short-circuit RECORD_STOP/FINALIZE: the partial recording is still
//   finalized (useful for debugging a flaky flow), but the process still exits non-zero and
//   prints the flow's own error.
// - FINALIZE remuxes the recording and REPAIRS ITS TIMESTAMPS on the way — simctl's mp4 routinely
//   carries composition offsets from which ffmpeg derives non-monotonic timestamps, costing real
//   footage downstream. See the TIMESTAMP REPAIR block for the measurements. The sidecar's
//   `ptsRepair` records how many frames this particular take needed moved.
// - TRIM TAIL runs only after a burn, and only because the burn resamples: simctl stamps the last
//   sample of a recording with a duration that can run seconds past the SIGINT that stopped the
//   camera (measured: 9.698s on a 31.82s take), which a constant-rate pass faithfully turns into
//   a frozen tail. The cut lands on the recorder's own wall window, so it can only ever remove
//   time that was never filmed. See trimPhantomTail.
// - SHOW_TAPS (on by default, skip with `--no-show-taps`): draws a ripple at every touch. iOS
//   has no `show_touches` setting to flip — the simulator will not draw the finger for you — so
//   the taps are recovered after the fact from the logs `maestro test --debug-output` writes and
//   burned into the .mp4 with ffmpeg. See lib/tap-overlay.mjs for the log formats, the measured
//   timing, and the ripple itself. Two things make the timing work:
//     * ANCHOR. `simctl io recordVideo` prints "Recording started" on stderr, and the wall-clock
//       instant of that line is video time 0.000. Measured against a web page rendering the host
//       clock at 20 Hz: over 10 samples spanning a 25 s take, (clock on screen − video pts) was
//       constant at 1.794 s ±17 ms, and 1.819 s was when "Recording started" printed — a 25 ms
//       residual, exactly the half-interval bias of a 50 ms clock. Confirmed a second time on a
//       take that needed its timeline repaired: 0.131 s of start latency, against 0.100, 0.101,
//       0.109 and 0.181 s on four others. Spawn time is not the anchor — the gap is small but it
//       is not a constant, and reading the line costs nothing and is exact.
//       (An earlier draft of this comment cited a 2.93 s spawn-to-start gap "on a loaded
//       machine". That was not load: it was the DTS defect described under TIMELINE REPAIR
//       mismeasuring the take, and it is 0.131 s once the timestamps are right.)
//     * BURNING RE-ENCODES AT A CONSTANT FRAME RATE. simctl records variable frame rate and
//       emits nothing at all while the screen is still, so a tap that the app does not visibly
//       react to would land in a multi-second gap with no frame to draw on.
//   A take that was supposed to get indicators and could not exits non-zero rather than handing
//   back footage that quietly lacks them; `--no-show-taps` is the way to say you meant it. The
//   burn is abortable: a SIGINT that lands while it is running stops the ffmpeg child (see
//   lib/tap-overlay.mjs's `signal`) rather than leaving it to finish into a path this process has
//   already unlinked, and the take is still delivered — without rings, since the burn never
//   finished. When `--tighten` was also asked for, the FINALIZED (pre-burn) file is kept aside
//   under a dot-name rather than being clobbered by the burn's rename, so TIGHTEN below can run
//   freeze detection against it instead of the burn's own re-encode noise — see DETECT-FROM in
//   tighten.mjs's header. It is deleted once TIGHTEN is done with it, unless the run is
//   interrupted first, in which case it is left exactly where an interrupted burn's other
//   leftovers would be. Every drawn tap also becomes a protected range (`{kind:'tap', start:
//   tSec-0.15, end: tSec+max(0.5, holdSec+0.45)}`) so tighten's leading-edge clamp cannot cut a
//   tap — and its ring — out of a long still stretch; see PROTECT below TIGHTEN.
// - TIGHTEN (opt-in, --tighten): runs after SHOW_TAPS — over the video with the rings already in
//   it, never the bare one — and only if maestro succeeded. Passes the pre-burn file as
//   `detectFrom` and every tap as a protected range when SHOW_TAPS drew rings (see above);
//   without rings this call is identical to what it was before either feature existed. A tighten
//   failure is reported but does not fail the overall command; the recording already succeeded by
//   that point.
// - SIDECAR: `<out>/<name>.json` records what produced the video — flow path and hash, argv,
//   simulator udid, every tap that was drawn (`taps`, in output pixels and seconds into the
//   video), whether indicators were on (`showTaps`), the wall-clock anchor the tap times were
//   converted against (`tapSync`), what the timestamp repair had to do (`ptsRepair`), and the
//   shape of the file actually handed over (`delivered`). `taps[].tSec` is measured in the take
//   that was written, NOT in the `-tight` variant — tighten cuts time out from under it. A
//   top-level `clock`/`timeline` pair mirrors the web camera's own sidecar shape (see PROTECTED
//   RANGES in tighten.mjs's header): `timeline` is one `{kind:'tap', start, end}` entry per drawn
//   tap, so a standalone `node tighten.mjs <take>` protects them with no camera-specific code in
//   tighten.mjs and no --tighten flag needed here. `tighten` carries the full result of the
//   in-process tighten() call, `detectFrom` included, when --tighten ran. Written from FINALIZE
//   onward on every path, failures included. A run that dies before the camera rolled writes
//   none — nothing was filmed, and an earlier take's sidecar must not be clobbered by a run that
//   never rolled.
//
// DEVIATIONS from the touch model, on purpose:
//   * `swipe` gets no indicator. Maestro logs a swipe's endpoints, but a ripple at one end of a
//     drag misdescribes the gesture; a swipe wants a trail, which is a different drawing.
//   * `doubleTapOn` gets TWO ripples, because the driver logs two touches and two is what the
//     screen saw.
//
// Unlike Android there is NO 180s cap: `simctl io recordVideo` records until told to stop. And
// unlike Android there is no PULL step — simctl writes the video directly onto the host, into
// the output directory.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, join, basename, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { run, runCapture, resolveTool, sleep, fileExists } from './lib/tools.mjs';
import { valueFor } from './lib/args.mjs';
import { preflight as sharedPreflight, validateNameStem } from './lib/preflight.mjs';
import { burnTapRipples, flowHasTapCommands, parseMaestroTaps } from './lib/tap-overlay.mjs';
import { tighten } from './tighten.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_DIR = join(HERE, 'out');
const RECORD_WARMUP_MS = 1500; // let recordVideo actually start writing before Maestro taps
const RECORD_FINALIZE_MS = 2000; // after SIGINT, before remux — lets simctl close the file

function log(msg) {
  console.log(`[film-ios] ${msg}`);
}

function usageError(msg) {
  console.error(`[film-ios] ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const rest = [];
  let out;
  let name;
  let simulator;
  const installs = [];
  let appId;
  let fresh = false;
  let codec = 'h264';
  let cleanStatusBar = false;
  let showTaps = true;
  let force = false;
  let doTighten = false;
  let minStill = 1.2;
  let keep = 0.6;
  let noise = 'auto';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out = valueFor(argv, i, '--out', usageError);
      i++;
    } else if (argv[i] === '--name') {
      name = valueFor(argv, i, '--name', usageError);
      i++;
    } else if (argv[i] === '--no-show-taps') {
      showTaps = false;
    } else if (argv[i] === '--simulator') {
      simulator = valueFor(argv, i, '--simulator', usageError);
      i++;
    } else if (argv[i] === '--install') {
      installs.push(resolve(valueFor(argv, i, '--install', usageError)));
      i++;
    } else if (argv[i] === '--app') {
      appId = valueFor(argv, i, '--app', usageError);
      i++;
    } else if (argv[i] === '--fresh') {
      fresh = true;
    } else if (argv[i] === '--codec') {
      codec = valueFor(argv, i, '--codec', usageError);
      i++;
    } else if (argv[i] === '--force') {
      force = true;
    } else if (argv[i] === '--clean-status-bar') {
      cleanStatusBar = true;
    } else if (argv[i] === '--tighten') {
      doTighten = true;
    } else if (argv[i] === '--min-still') {
      minStill = Number(valueFor(argv, i, '--min-still', usageError));
      i++;
    } else if (argv[i] === '--keep') {
      keep = Number(valueFor(argv, i, '--keep', usageError));
      i++;
    } else if (argv[i] === '--noise') {
      noise = String(valueFor(argv, i, '--noise', usageError));
      i++;
    } else {
      rest.push(argv[i]);
    }
  }
  if (rest.length !== 1 || !/\.ya?ml$/.test(rest[0])) {
    console.error(
      'usage: node film-ios.mjs <flow.yaml> [--out <dir>] [--name <basename>] [--force] ' +
        '[--simulator <name-or-udid>] [--install <path.app|path.ipa>]... [--app <bundle-id>] ' +
        '[--fresh] [--codec h264|hevc] [--clean-status-bar] [--no-show-taps] [--tighten] ' +
        '[--min-still <sec>] [--keep <sec>] [--noise <level>]',
    );
    process.exit(1);
  }
  // A name becomes a filename stem in --out; keep it one. Same rule the other two cameras use.
  try {
    validateNameStem(name);
  } catch (err) {
    usageError(err.message);
  }
  if (codec !== 'h264' && codec !== 'hevc') {
    usageError(`--codec must be h264 or hevc (got "${codec}")`);
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
  if (!Number.isFinite(minStill) || minStill <= 0) {
    usageError(`--min-still must be a positive number of seconds (got "${minStill}")`);
  }
  if (!Number.isFinite(keep) || keep < 0) {
    usageError(`--keep must be a non-negative number of seconds (got "${keep}")`);
  }
  return {
    flowArg: rest[0],
    outDir: out ? resolve(out) : DEFAULT_OUT_DIR,
    name,
    simulator,
    installs,
    appId,
    fresh,
    codec,
    cleanStatusBar,
    showTaps,
    force,
    doTighten,
    minStill,
    keep,
    noise,
  };
}

// ── PREFLIGHT ───────────────────────────────────────────────────────────────────────────────
// The platform check comes first because it is the one failure no flag can talk you out of.
// Everything after it — Node's version, the flow existing, and the no-clobber rule — is the
// shared check in lib/preflight.mjs, so the refusal reads identically across all three cameras.
async function preflight(flowPath, plannedOutputs, force) {
  if (platform() !== 'darwin') {
    throw new Error('iOS Simulator filming requires macOS (xcrun/simctl only exist there)');
  }
  await sharedPreflight(flowPath, plannedOutputs, force);
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
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // simctl announces itself on stderr the moment the capture session is live, and THAT instant —
  // not spawn, which ran 0.10–0.18 s earlier and by no fixed amount — is video time 0.000. It is
  // the only thing that makes a tap's wall clock convertible into a timestamp in the recording.
  const spawnedAtMs = Date.now();
  let startedAtMs = null;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    if (startedAtMs === null && /recording started/i.test(chunk)) startedAtMs = Date.now();
    stderr = (stderr + chunk).slice(-4000);
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
    spawnedAtMs,
    get startedAtMs() {
      return startedAtMs;
    },
    get stderr() {
      return stderr;
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

// ── TIMESTAMP REPAIR ────────────────────────────────────────────────────────────────────────
// `simctl io recordVideo` writes an mp4 whose composition offsets put the first DTS well below
// zero: measured at −5.473s, −5.237s and −2.903s on affected takes, against −0.12s on healthy
// ones. From those DTS values ffmpeg derives timestamps for a large minority of frames that are
// NOT the ones the container stores as PTS. On one 42s take, 421 of 604 frames came out mistimed
// and the decoded timeline stepped BACKWARDS by 5.457s in the middle of an app-launch animation.
//
// That is not cosmetic. Anything that resamples — the tap burn's `fps`, a player, an editor —
// drops every frame whose timestamp has fallen behind the clock, so 5.5s of real footage went
// silently missing, the surviving footage played roughly one navigation out of step with when it
// actually happened, and the file claimed 45.45s of duration for a 42.0s recording.
//
// `-fflags +igndts` tells the demuxer to trust the container's PTS and ignore DTS. Verified on
// six takes: the decoded frame timestamps then equal the container's own packet PTS exactly —
// sorted, monotonic, every frame kept — and on a take with no defect the flag changes nothing at
// all. It goes on the INPUT side of the stream copy, so the repair is baked into the .mp4 that
// ships and a reader needs no flags of its own.
//
// BOTH CODECS, not just h264. `--codec hevc` reorders too (398 of 399 packets with pts != dts,
// against 404 of 405 for h264), so "does this codec reorder" cannot be the gate — it would
// disable the repair on the very footage that proves it works. hevc is in fact affected WORSE:
// on a 15.8s hevc take the unrepaired decode returned 388 of 399 frames, actually dropping
// eleven, and stepped back 2.52s; repaired it returns all 399, monotonic.
//
// This also retired a measurement that had looked like machine load: a take whose recorder
// seemed to start 2.93s after spawn was really a take with a −2.903s DTS shift. Corrected, its
// start latency is 0.131s, in line with every other run.
//
// EXPECTED NOISE: with input DTS discarded, the mp4 muxer generates its own, and it will
// sometimes print "Non-monotonic DTS; previous: N, current: N; changing to N+1". That is one
// frame nudged by a single 1/19200s tick — 52 microseconds. The probe below is what actually
// certifies the result, and it has never seen that nudge cost a frame or a jump.
const IGNORE_DTS = ['-fflags', '+igndts'];

/**
 * Run ffmpeg with stderr captured rather than inherited. finalize needs this: the muxer's
 * "Non-monotonic DTS" lines are the visible edge of the very defect being repaired, and a
 * warning nobody counts is a warning nobody notices going from 4 a take to 400.
 */
function runFfmpegCapturingStderr(ffmpeg, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 400_000) stderr = stderr.slice(-200_000);
    });
    child.on('error', (err) => reject(new Error(`failed to run \`${ffmpeg} ${args.join(' ')}\`: ${err.message}`)));
    child.on('exit', (code) => {
      if (code === 0) return resolvePromise(stderr);
      const err = new Error(`\`${ffmpeg} ${args.join(' ')}\` exited with code ${code}`);
      err.stderr = stderr;
      reject(err);
    });
  });
}

const DTS_WARNING_RE = /Non-monotonic DTS/g;

async function finalizeVideo(ffmpeg, rawPath, outPath) {
  let stderr;
  let reencoded = false;
  try {
    stderr = await runFfmpegCapturingStderr(ffmpeg, [
      '-y', '-nostdin', ...IGNORE_DTS, '-i', rawPath, '-c', 'copy', '-movflags', '+faststart', outPath,
    ]);
  } catch (err) {
    log(`ffmpeg remux (stream copy) failed (${err.message}) — falling back to re-encode...`);
    if (err.stderr) console.error(err.stderr.trim().split('\n').slice(-8).join('\n'));
    reencoded = true;
    stderr = await runFfmpegCapturingStderr(ffmpeg, [
      '-y', '-nostdin', ...IGNORE_DTS, '-i', rawPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outPath,
    ]);
  }
  return { reencoded, dtsWarnings: (stderr.match(DTS_WARNING_RE) ?? []).length };
}

/**
 * Every frame's presentation time, in the order a decoder hands them to a filter graph. One
 * decode pass, streamed line by line rather than buffered — a five-minute take is tens of
 * thousands of showinfo lines and there is no reason to hold them all.
 *
 * @returns {Promise<{frames:number, backwardJumps:number, firstPts:number|null, lastPts:number|null, pts:number[]}>}
 */
function probePtsTimeline(ffmpeg, path, inputFlags = []) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpeg, ['-v', 'info', ...inputFlags, '-i', path, '-vf', 'showinfo', '-f', 'null', '-'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const pts = [];
    let size = null; // showinfo carries `s:1206x2622` on every frame line — the geometry, free
    let tail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const lines = (tail + chunk).split('\n');
      tail = lines.pop() ?? '';
      for (const line of lines) {
        const m = /\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:(-?[\d.]+)/.exec(line);
        if (!m) continue;
        pts.push(Number(m[1]));
        if (size === null) {
          const dim = /\bs:(\d+)x(\d+)\b/.exec(line);
          if (dim) size = { width: Number(dim[1]), height: Number(dim[2]) };
        }
      }
    });
    child.on('error', (err) => reject(new Error(`failed to probe the timeline: ${err.message}`)));
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code} while probing the timeline`));
      let backwardJumps = 0;
      for (let i = 1; i < pts.length; i++) if (pts[i] < pts[i - 1] - 1e-4) backwardJumps++;
      resolvePromise({
        frames: pts.length,
        backwardJumps,
        firstPts: pts.length ? pts[0] : null,
        lastPts: pts.length ? pts[pts.length - 1] : null,
        size,
        pts,
      });
    });
  });
}

// ── SHOW_TAPS: recover the touches and burn a ripple at each one ────────────────────────────
// Split out of main() because it has one job with one honest answer: what was drawn, `null` if
// the logs held no touch at all, or a throw with a reason the caller can print. It never
// half-writes — the burn goes to a temp file and only replaces the take once ffmpeg exited 0.
//
// `keepPreBurn` (only true under `--tighten`) additionally preserves the FINALIZED, pre-burn file
// under a dot-name next to the output rather than letting the burn's rename clobber it — see
// DETECT-FROM in tighten.mjs's header for why: freeze detection run against the burned file (a
// fresh source of quantization noise on every frame, exactly like a resample) flips tighten out
// of its frame-exact mode into the -60dB threshold probe, which the header already documents as
// unreliable on device footage. The rename dance below (out -> pre-burn dot-file -> burn ->
// rename back) is the same two renames the plain burn already does, just with the source kept
// under a second name instead of overwritten. On any failure — including an aborted burn, see
// `signal` — the original is renamed back over the output path, so the take is delivered without
// rings exactly as it always was; `result.preBurnPath` is null whenever nothing was set aside.
async function drawTaps({
  ffmpeg,
  videoPath,
  tmpPath,
  videoSize,
  debugDir,
  recordingStartedMs,
  recordingStoppedMs,
  codec,
  keepPreBurn,
  signal,
}) {
  const parsed = await parseMaestroTaps({ debugDir, nearEpoch: recordingStartedMs });
  for (const w of parsed.warnings) log(`⚠️  ${w}`);
  // Nothing to draw is not an error HERE — a flow that never taps is a normal flow. Whether it
  // is an error at all is main()'s call, because only main() knows if the flow asked for taps.
  if (parsed.taps.length === 0) return null;
  if (!parsed.scale) {
    throw new Error("maestro.log has no 'Got device info: DeviceInfo(...)' line, so points cannot be scaled to pixels");
  }

  // GEOMETRY. Tap coordinates are points on the device Maestro talked to; the ring is drawn in
  // pixels on the recording. If those two are not the same screen, every ring is placed by a
  // scale factor that does not apply — a ring confidently drawn on the wrong control, which is
  // worse than no ring. So this refuses rather than guesses. (Android's contentRect check is the
  // same idea from the other end.) The recording is the simulator's native panel, so anything
  // that resizes or crops it — a future --size flag, a mask, an external scaler — lands here.
  if (videoSize && parsed.widthPx && parsed.heightPx) {
    if (videoSize.width !== parsed.widthPx || videoSize.height !== parsed.heightPx) {
      throw new Error(
        `the recording is ${videoSize.width}x${videoSize.height} but Maestro reports the device as ` +
          `${parsed.widthPx}x${parsed.heightPx}, so tap coordinates cannot be scaled onto these frames`,
      );
    }
  }

  // Wall clock → seconds into the recording. A tap outside the recorded window cannot be drawn
  // on a frame that does not exist; that is a dropped ring, not a wrong one, so say which.
  const lastSec = (recordingStoppedMs - recordingStartedMs) / 1000;
  const all = parsed.taps.map((t) => {
    const tSec = (t.wallMs - recordingStartedMs) / 1000;
    const wanted = t.holdSec || 0;
    return {
      x: t.xPt * parsed.scale,
      y: t.yPt * parsed.scale,
      tSec,
      // A press still held when the recorder stopped has no frames left to hold a ring on, and a
      // hold running past the end pads the overlay stream with thousands of transparent frames
      // for footage that does not exist. Clamp to what was actually filmed.
      holdSec: Math.max(0, Math.min(wanted, lastSec - tSec)),
      holdWantedSec: wanted,
    };
  });
  const taps = all.filter((t) => t.tSec >= 0 && t.tSec <= lastSec);
  if (taps.length !== all.length) {
    log(`⚠️  ${all.length - taps.length} tap(s) fell outside the recorded window (0–${lastSec.toFixed(2)}s) and were not drawn`);
  }
  const truncated = taps.filter((t) => t.holdSec < t.holdWantedSec - 1e-6).length;
  if (truncated > 0) {
    log(`⚠️  ${truncated} long press(es) were still held when recording stopped — their ring ends with the take`);
  }
  if (taps.length === 0) throw new Error(`every logged tap fell outside the recorded window (0–${lastSec.toFixed(2)}s)`);

  // The burn goes to `tmpPath` (dot-prefixed, chosen by the caller so the SIGINT handler knows
  // the name too) and only becomes the take once ffmpeg has exited 0. A half-encoded .mp4 sitting
  // next to the take, named like a take, is how a bad file gets shipped.
  const preBurnPath = keepPreBurn ? join(dirname(videoPath), `.${basename(videoPath, '.mp4')}.pre-taps.mp4`) : null;
  if (preBurnPath) await rename(videoPath, preBurnPath);
  let result;
  try {
    result = await burnTapRipples({
      inPath: preBurnPath ?? videoPath,
      outPath: tmpPath,
      taps,
      ffmpegPath: ffmpeg,
      style: { scale: parsed.scale, codec },
      signal,
    });
  } catch (err) {
    await rm(tmpPath, { force: true });
    // An abort or an ordinary encode failure both mean "deliver the take without rings" — put the
    // pre-burn file back where the take is expected to live, same as if keepPreBurn had never
    // been asked for.
    if (preBurnPath) await rename(preBurnPath, videoPath).catch(() => {});
    throw err;
  }
  await rename(tmpPath, videoPath);
  return { ...result, taps, source: parsed.source, scale: parsed.scale, parsedCount: parsed.taps.length, preBurnPath };
}

// ── PROTECT: one range per drawn tap, so tighten's leading-edge clamp cannot cut a tap (and its
// ring) that lands late in a long still stretch. Widened -0.15s before / max(0.5s, hold + 0.45s)
// after: enough slack either side for the anchor's own measured lead/jitter (see SHOW_TAPS above)
// without protecting so much that a genuinely dead stretch around the tap survives uncut. These
// numbers are the spec's, not remeasured here — the anchors that place `tSec` already carry their
// own measured error bars.
function tapProtectRanges(taps) {
  return taps.map((t) => ({
    kind: 'tap',
    start: t.tSec - 0.15,
    end: t.tSec + Math.max(0.5, (t.holdSec ?? 0) + 0.45),
  }));
}

/**
 * simctl stamps the FINAL sample of a recording with a duration that can be wildly longer than
 * the recording is: on one 31.82s take the last packet claimed 9.698s, putting its end 9.3s past
 * the SIGINT that stopped the camera. The container's own duration field is right and ignores
 * it, so ffprobe and players are fine — but anything that RESAMPLES honours it, and the tap
 * burn's constant-rate pass does exactly that, baking 9.4s of frozen tail into the delivery.
 *
 * The burn's output is constant rate and (measured: 0 of 2470 packets with pts != dts) carries
 * no B-frames, so cutting whole samples off the end is exact. The cut lands at the recorder's
 * own wall window — Recording started to SIGINT — which is by definition how long the camera
 * rolled, so nothing that was filmed is ever cut and nothing that was not is invented.
 *
 * Needs ffprobe to check its own work; without it the tail is left alone and said so, because a
 * blind cut on a file that might have B-frames is a worse trade than a long freeze.
 */
async function trimPhantomTail(ffmpeg, ffprobe, path, windowSec) {
  if (!ffprobe) return { applied: false, reason: 'ffprobe not on PATH — the tail was left as filmed' };
  if (!(windowSec > 0)) return { applied: false, reason: 'no recorder window to cut against' };
  const probe = async (f) => {
    const out = await runCapture(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0', '-count_packets',
      '-show_entries', 'stream=nb_read_packets:format=duration', '-of', 'default=nw=1:nk=1', f,
    ]);
    const [frames, duration] = out.trim().split('\n');
    return { frames: Number(frames), durationSec: Number(duration) };
  };
  const before = await probe(path);
  // One frame of slack: a delivery that runs a few milliseconds past the window is the encoder
  // rounding, not a phantom tail, and re-muxing for that would be churn.
  if (!(before.durationSec > windowSec + 0.25)) {
    return { applied: false, reason: 'no phantom tail', durationSec: before.durationSec, frames: before.frames };
  }
  const tmp = join(dirname(path), `.${basename(path, '.mp4')}.trim.mp4`);
  try {
    await runFfmpegCapturingStderr(ffmpeg, [
      '-y', '-nostdin', '-i', path, '-c', 'copy', '-t', windowSec.toFixed(3), '-movflags', '+faststart', tmp,
    ]);
    const after = await probe(tmp);
    // Refuse to ship a shorter file that lost more than the tail we meant to cut.
    if (!(after.frames > 0) || after.durationSec < windowSec - 1) {
      await rm(tmp, { force: true });
      return { applied: false, reason: `the trimmed copy came out at ${after.durationSec}s — kept the untrimmed take` };
    }
    await rename(tmp, path);
    return {
      applied: true,
      framesRemoved: before.frames - after.frames,
      secRemoved: Number((before.durationSec - after.durationSec).toFixed(3)),
      durationSec: after.durationSec,
      frames: after.frames,
    };
  } catch (err) {
    await rm(tmp, { force: true });
    return { applied: false, reason: err.message };
  }
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function main() {
  const { flowArg, outDir, name, simulator, installs, appId, fresh, codec, cleanStatusBar, showTaps, force, doTighten, minStill, keep, noise } =
    parseArgs(process.argv.slice(2));
  const flowPath = resolve(flowArg);
  const flowName = name ?? `${basename(flowPath, extname(flowPath))}-ios`;

  // Every file this run intends to write, named before anything is touched — that is what the
  // no-clobber check needs, and it is why these paths are computed up here rather than at the
  // point of use. `-tight.mp4` only counts as planned when --tighten was actually asked for.
  const outPath = join(outDir, `${flowName}.mp4`);
  const sidecarPath = join(outDir, `${flowName}.json`);
  const tightPath = join(outDir, `${flowName}-tight.mp4`);

  let tools;
  try {
    tools = await preflight(flowPath, doTighten ? [outPath, sidecarPath, tightPath] : [outPath, sidecarPath], force);
  } catch (err) {
    console.error(`[film-ios] preflight failed: ${err.message}`);
    process.exit(1);
  }
  const { xcrun, maestro, ffmpeg } = tools;
  // Optional: used to describe the delivered file and to check the tail trim's own work. ffmpeg
  // ships it, so this is really only absent on a hand-built ffmpeg.
  const ffprobe = await resolveTool('ffprobe').catch(() => null);

  const flowText = await readFile(flowPath, 'utf8');
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

  const rawLocalPath = join(outDir, `.${flowName}.raw.mp4`);
  // Dot-prefixed so `ls` hides it: it is Maestro's own debugging spill (logs plus a screenshot
  // per failed step), kept only when something went wrong and there is something to look at.
  const debugDir = join(outDir, `.${flowName}.maestro-debug`);
  await rm(debugDir, { recursive: true, force: true }); // never read a previous take's taps

  // ── STATE SHARED BY THE NORMAL PATH AND THE SIGINT HANDLER ────────────────────────────────
  const startedAt = new Date().toISOString();
  let recorder = null;
  let recordingStoppedMs = null;
  let maestroError = null;
  let tapsExpected = false;
  let tapResult = null;
  let tapError = null; // something went wrong drawing them — always worth saying
  let noTapsFound = false; // the logs simply held no touch — only news if the flow taps
  let tightenResult = null;
  let ptsRepair = null; // what the timestamp repair at FINALIZE did to this take
  let delivered = null; // the file actually handed over, after indicators and the tail trim
  let debugKept = showTaps; // flipped once the run succeeds and the spill is deleted
  let interrupted = false;
  // Where the tap burn writes before it becomes the take. Named out here because Ctrl-C during a
  // 30-second encode has to be able to sweep it up; nothing else knows it exists.
  const burnTempPath = join(outDir, `.${flowName}.taps.mp4`);
  let burning = false;
  // The controller SIGINT uses to stop a burn in flight, and the in-flight promise it awaits
  // before proceeding to salvage/sidecar/exit — so a Ctrl-C mid-burn tears the encoder down
  // deterministically (SIGTERM, escalating to SIGKILL — see lib/tap-overlay.mjs) instead of
  // racing process.exit() against whatever ffmpeg happens to be doing.
  let burnAbortController = null;
  let pendingBurn = null;
  // One protected range per drawn tap (see tapProtectRanges), filled in once tapResult is known.
  // Declared here, not where it is assigned, so writeSidecar's closure always finds an
  // initialized value even if it is invoked (e.g. `finalize-failed`) before SHOW_TAPS ever runs.
  let tapProtect = [];

  // Maestro's own execution record beats a grep of the flow file: it knows the difference
  // between a `tapOn` and a `tapOn` behind a `when:` that never fired, and it sees taps inside a
  // `runFlow:` include that this file never mentions. Both directions cost a take when guessed.
  // Only meaningful once the flow has RUN, which is why it is a function and not a constant.
  const computeTapsExpected = () => showTaps && flowHasTapCommands(flowText, debugDir);

  const writeSidecar = async (status) => {
    const payload = {
      status,
      camera: 'ios',
      flow: flowPath,
      flowSha256: await sha256(flowPath).catch(() => null),
      argv: process.argv.slice(2),
      simulator: { udid },
      codec,
      cleanStatusBar: statusBarOverridden,
      // tighten.mjs reads a top-level `timeline` array off this file as its protected ranges (the
      // same mechanism the web camera's sidecar uses for caption/pause holds — see PROTECTED
      // RANGES in tighten.mjs's header), so a standalone `node tighten.mjs <take>` protects every
      // drawn tap automatically, with no --tighten flag or in-process call required. `clock:
      // "frame"` because tSec is measured against the recording's own anchor (simctl's "Recording
      // started" line), not a wall clock running alongside it, so it needs no drift margin — the
      // -0.15s / +0.45s padding in tapProtectRanges already covers the anchor's own measured slop.
      clock: 'frame',
      timeline: tapProtect,
      // What the indicators did, and against what clock. `tapSync.videoZeroWallMs` is the wall
      // instant of video time 0.000 — every tSec below is (tap wall clock − that) / 1000.
      showTaps: Boolean(tapResult),
      showTapsRequested: showTaps,
      tapsExpected,
      taps: tapResult
        ? tapResult.taps.map((t) => ({
            x: Math.round(t.x),
            y: Math.round(t.y),
            tSec: Number(t.tSec.toFixed(3)),
            ...(t.holdSec ? { holdSec: Number(t.holdSec.toFixed(3)) } : {}),
          }))
        : [],
      tapSync: {
        anchor: 'simctl "Recording started" on stderr',
        videoZeroWallMs: recorder?.startedAtMs ?? null,
        // How late the capture session actually started. Logged because it is the number that
        // makes anchoring on spawn wrong; measured between 0.10s and 0.18s.
        spawnToVideoZeroMs: recorder?.startedAtMs == null ? null : recorder.startedAtMs - recorder.spawnedAtMs,
        recordingStoppedWallMs: recordingStoppedMs,
        source: tapResult?.source ?? null,
        scale: tapResult?.scale ?? null,
        error: tapError ?? (noTapsFound ? 'no touch was logged by the iOS driver or by maestro.log' : null),
      },
      // What the timestamp repair at FINALIZE had to do, measured on the FINALIZED take, before
      // any indicator was burned into it.
      ptsRepair,
      // The file actually handed over: after the ripples and after the phantom-tail cut.
      delivered,
      output: { path: outPath, fps: tapResult?.fps ?? null, encoder: tapResult?.encoder ?? null },
      tighten: tightenResult,
      flowSucceeded: !maestroError,
      debugOutput: debugKept ? debugDir : null,
      createdAt: startedAt,
    };
    await writeFile(sidecarPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8').catch((err) =>
      console.error(`[film-ios] sidecar failed: ${err.message}`),
    );
  };

  // The simulator must not be left lying about its battery because a run ended early. Runs once,
  // from whichever path reaches it first.
  let statusBarRestored = false;
  const restoreStatusBar = async () => {
    if (!statusBarOverridden || statusBarRestored) return;
    statusBarRestored = true;
    await run(xcrun, ['simctl', 'status_bar', udid, 'clear']).catch(() => {}); // best-effort
  };

  // SALVAGE — stop the camera, put the simulator back, and turn whatever was captured into a
  // finished .mp4. Ctrl-C and the ordinary end of the flow both arrive here and exactly one of
  // them does the work; the other awaits the same promise. Everything that must happen no matter
  // how the run ends lives in here, which is what makes the two paths impossible to get out of
  // step.
  let salvagePromise = null;
  const salvage = async () => {
    if (recorder) {
      log('stopping screen recording...');
      recordingStoppedMs = Date.now();
      await stopRecording(recorder);
    }
    await restoreStatusBar();
    if (!recorder || !(await fileExists(rawLocalPath))) {
      return { ok: false, reason: 'the recorder never wrote a file' };
    }
    try {
      log(`finalizing ${outPath}...`);
      // What the OLD, unrepaired read of this recording would have seen — measured before the raw
      // is deleted, so the sidecar can say how badly this particular take was affected. Costs one
      // decode pass (1.5s for a 42s take, 3.6s for 68s); worth it, because it is exactly the
      // check that would have caught the timestamp bug the first time.
      const before = await probePtsTimeline(ffmpeg, rawLocalPath).catch(() => null);
      const fin = await finalizeVideo(ffmpeg, rawLocalPath, outPath);
      const after = await probePtsTimeline(ffmpeg, outPath).catch(() => null);
      if (before && after) {
        let moved = Math.abs(before.pts.length - after.pts.length);
        const n = Math.min(before.pts.length, after.pts.length);
        for (let i = 0; i < n; i++) if (Math.abs(before.pts[i] - after.pts[i]) > 1e-4) moved++;
        ptsRepair = {
          flag: IGNORE_DTS.join(' '),
          measuredOn: 'the finalized take, before tap indicators were burned in',
          retimed: moved > 0,
          framesRetimed: moved,
          sourceFrames: before.frames,
          framesAfterRepair: after.frames,
          backwardJumpsBefore: before.backwardJumps,
          backwardJumpsAfter: after.backwardJumps,
          lastPtsSec: after.lastPts === null ? null : Number(after.lastPts.toFixed(3)),
          // The muxer generates DTS once the input's are discarded and occasionally nudges one by
          // a single 1/19200s tick. Counted rather than ignored: 4 a take is the measured normal,
          // and a run that suddenly reports hundreds is telling you the repair has stopped fitting
          // this recorder.
          muxerDtsWarnings: fin.dtsWarnings,
          reencoded: fin.reencoded,
        };
        if (moved > 0) {
          log(
            `repaired the recording's timeline: ${moved}/${before.frames} frames re-timed, ` +
              `${before.backwardJumps} backward jump(s) removed`,
          );
        }
        // The repair is verified, not assumed. If it ever stops working the take is still the best
        // footage available, so this warns rather than fails — but it must not pass in silence.
        if (after.frames !== before.frames || after.backwardJumps > 0) {
          log(
            `⚠️  timeline check failed: ${before.frames} frames in, ${after.frames} out, ` +
              `${after.backwardJumps} backward jump(s) left. Playback may skip or freeze.`,
          );
        }
      }
      await rm(rawLocalPath, { force: true });
      return { ok: true, size: after?.size ?? null };
    } catch (err) {
      console.error(`[film-ios] failed to finalize the recording: ${err.message}`);
      return { ok: false, reason: err.message };
    }
  };
  const runSalvage = () => (salvagePromise ??= salvage());

  // Without this, Ctrl-C takes Node's default disposition and the process dies where it stands:
  // `simctl io recordVideo` outlives it, the dot-prefixed raw is orphaned, no sidecar is written,
  // and a --clean-status-bar simulator is left insisting it is 9:41 with a full battery. With it,
  // Ctrl-C is just another route into salvage() and out through 130, the shell's own convention.
  process.on('SIGINT', () => {
    if (interrupted) {
      console.error('[film-ios] still saving what was filmed — a second Ctrl-C will not make it faster.');
      return;
    }
    interrupted = true;
    console.error('\n[film-ios] SIGINT — stopping the recorder and saving what was filmed so far...');
    // A burn caught halfway through is a partial mp4 with no rings in most of it. It is not the
    // take and it is not worth keeping. Rather than leave that to the terminal's own process-group
    // delivery (true today, but a coincidence this file should not depend on) or unlink the file
    // out from under a still-writing ffmpeg, tell drawTaps' burn to stop: `signal` SIGTERMs the
    // child (escalating to SIGKILL if it ignores that — see lib/tap-overlay.mjs) and removes its
    // own partial output before rejecting. `pendingBurn` is awaited (its rejection swallowed —
    // drawTaps already restores the pre-burn file, if one was kept aside) so that teardown is
    // actually finished, not merely requested, before salvage/sidecar/exit run.
    const abortingBurn = burning;
    if (abortingBurn) {
      console.error('[film-ios] a tap-indicator burn is in progress — stopping the encoder...');
      burnAbortController?.abort();
    }
    (abortingBurn && pendingBurn ? pendingBurn.catch(() => {}) : Promise.resolve())
      .then(() => runSalvage())
      .then(async (outcome) => {
        tapsExpected = computeTapsExpected();
        if (outcome.ok) {
          console.error(`[film-ios] interrupted — what was filmed is in ${outPath}, WITHOUT tap indicators.`);
          if (debugKept) console.error(`[film-ios] maestro's debug output was kept: ${debugDir}`);
          await writeSidecar('interrupted');
        } else {
          console.error(`[film-ios] interrupted before anything could be saved (${outcome.reason}).`);
        }
      })
      .catch((err) => console.error(`[film-ios] could not save the interrupted take: ${err.message}`))
      .finally(() => process.exit(130));
  });

  log('starting screen recording...');
  recorder = startRecording(xcrun, udid, rawLocalPath, codec);
  await sleep(RECORD_WARMUP_MS);

  try {
    log(`running maestro test ${flowPath}...`);
    // Run from the CALLER's working directory so relative paths inside the flow yaml resolve
    // against the user's project, not this repo. `--udid` is load-bearing when an Android
    // emulator is also running — without it maestro happily picks whichever device it likes.
    const args = ['test', '--udid', udid];
    // --debug-output is where the tap times come from. Always on when indicators are wanted,
    // even if this flow file shows no tap commands: an included flow can still tap.
    if (showTaps) args.push('--debug-output', debugDir);
    await run(maestro, [...args, flowPath]);
  } catch (err) {
    maestroError = err;
  }

  const outcome = await runSalvage();
  if (interrupted) return; // the SIGINT handler owns the sidecar and the exit code
  if (!outcome.ok) {
    await writeSidecar('finalize-failed');
    process.exit(1);
  }
  const recordingStartedMs = recorder.startedAtMs;
  // Now that the flow has run there is a record of what it actually did, so ask that.
  tapsExpected = computeTapsExpected();

  if (showTaps) {
    if (recordingStartedMs === null) {
      tapError =
        'simctl never printed "Recording started", so video time 0 has no wall clock to hang off' +
        (recorder.stderr ? ` (its stderr said: ${recorder.stderr.trim().split('\n').slice(-2).join(' / ')})` : '');
    } else {
      try {
        burning = true;
        burnAbortController = new AbortController();
        // burning/aborter/pendingBurn are set contiguously (no `await` between them) so the
        // SIGINT handler above can never observe `burning` true while `pendingBurn` is still null.
        pendingBurn = drawTaps({
          ffmpeg,
          videoPath: outPath,
          tmpPath: burnTempPath,
          videoSize: outcome.size,
          debugDir,
          recordingStartedMs,
          recordingStoppedMs,
          codec,
          keepPreBurn: doTighten, // only --tighten will actually want the pre-burn file
          signal: burnAbortController.signal,
        });
        tapResult = await pendingBurn;
        if (tapResult === null) {
          noTapsFound = true;
        } else {
          log(
            `drew ${tapResult.taps.length} tap indicator(s) at ${tapResult.fps}fps ` +
              `(${tapResult.encoder}, ${tapResult.elapsedSec.toFixed(1)}s)`,
          );
        }
      } catch (err) {
        tapError = err.message;
      } finally {
        burning = false;
        burnAbortController = null;
        pendingBurn = null;
      }
    }
  }
  // A Ctrl-C that landed mid-burn is handled entirely by the SIGINT handler (abort, salvage,
  // sidecar, exit 130) — main() must not also report a tap failure for the very AbortError that
  // handler is already racing to clean up after.
  if (interrupted) return;

  // Now that tapResult is known, fill in the protected ranges every sidecar write below carries
  // in its top-level `timeline` array — which is what lets a standalone `node tighten.mjs <take>`
  // protect taps without --tighten ever having run in this process.
  tapProtect = tapResult ? tapProtectRanges(tapResult.taps) : [];

  // A flow that taps and a take with no rings on it is exactly the thing that must not pass
  // quietly. A flow that FAILED is already exiting non-zero with its own error, and half of it
  // never ran, so the missing rings there are a symptom, not the news. And a flow that never
  // taps skips all of this in silence — there was nothing to draw.
  const why = tapError ?? 'no touch was logged by the iOS driver or by maestro.log';
  if ((tapError !== null || noTapsFound) && tapsExpected && !maestroError) {
    console.error(`\n[film-ios] tap indicators could not be derived for "${flowName}" — ${why}`);
    console.error(`[film-ios]   maestro debug output: ${debugDir}`);
    console.error(`[film-ios]   the recording was still written, WITHOUT indicators: ${outPath}`);
    console.error('[film-ios]   pass --no-show-taps to film without them on purpose.');
    await writeSidecar('taps-missing');
    process.exit(1);
  }
  if (tapError) log(`⚠️  no tap indicators drawn — ${tapError}`);

  // The constant-rate burn honours simctl's overlong final-frame duration; cut it back to how
  // long the camera actually rolled. Only ever shortens, and only past the recorder's own window.
  if (tapResult) {
    const windowSec = recordingStartedMs === null ? 0 : (recordingStoppedMs - recordingStartedMs) / 1000;
    const trim = await trimPhantomTail(ffmpeg, ffprobe, outPath, windowSec);
    if (trim.applied) {
      log(`cut ${trim.secRemoved.toFixed(2)}s of frozen tail the recorder's last frame claimed but never filmed`);
    } else if (trim.reason && trim.reason !== 'no phantom tail') {
      log(`⚠️  phantom-tail check skipped — ${trim.reason}`);
    }
    delivered = { ...trim };
  }
  if (ffprobe && !delivered) {
    const out = await runCapture(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0', '-count_packets',
      '-show_entries', 'stream=nb_read_packets,width,height:format=duration', '-of', 'default=nw=1:nk=1', outPath,
    ]).catch(() => null);
    if (out) {
      const [w, h, frames, duration] = out.trim().split('\n');
      delivered = { applied: false, reason: 'no burn, so no resampled tail to cut', frames: Number(frames), durationSec: Number(duration), width: Number(w), height: Number(h) };
    }
  }

  if (maestroError) {
    console.error(`\n[film-ios] maestro flow "${flowName}" failed: ${maestroError.message}`);
    console.error(`[film-ios] the partial recording was still saved to ${outPath} for debugging.`);
    console.error(`[film-ios] maestro's own debug output (logs, failure screenshots): ${debugDir}`);
    await writeSidecar('flow-failed');
    process.exit(1);
  }

  // Nothing went wrong, so Maestro's spill is noise. It only earns its keep on a failure.
  await rm(debugDir, { recursive: true, force: true });
  debugKept = false;

  console.log(`\n[film-ios] Demo video written: ${outPath}`);

  if (doTighten) {
    try {
      const result = await tighten(outPath, {
        minStill,
        keep,
        noise,
        // Rings were burned in, so freeze detection against outPath would be reading the burn's
        // own quantization noise, not the recorder's — see DETECT-FROM in tighten.mjs's header.
        // Without rings (no taps, or --no-show-taps) this stays undefined and tighten runs exactly
        // as it did before this feature existed.
        ...(tapResult?.preBurnPath ? { detectFrom: tapResult.preBurnPath } : {}),
        // The tap ranges are already in memory — no reason to make tighten re-read them off the
        // sidecar this process is about to write.
        ...(tapProtect.length > 0 ? { protect: tapProtect, protectMarginSec: 0, sidecar: false } : {}),
      });
      tightenResult = result;
      if (result.skipped) {
        log(`already tight (${result.skipDetail || 'no static stretches found'}) — kept raw only: ${outPath}`);
      } else {
        log(
          `tightened ${result.totalDuration.toFixed(2)}s -> ${result.outDuration.toFixed(2)}s ` +
            `(${result.cuts} cuts, ${result.removedSec.toFixed(2)}s removed)`,
        );
        console.log(`[film-ios] Tightened demo video written: ${result.outPath}`);
      }
    } catch (err) {
      console.error(`[film-ios] --tighten skipped — ${err.message}`);
    } finally {
      // The pre-burn file only ever existed to feed --detect-from above; tighten has now either
      // used it or failed trying, and either way there is nothing left to do with it. "Unless the
      // run is interrupted" needs no code here: a SIGINT during this very call exits the process
      // before this line is ever reached, which is what leaves it behind on purpose.
      if (tapResult?.preBurnPath) await rm(tapResult.preBurnPath, { force: true });
    }
  }

  await writeSidecar('ok');
  log(`provenance written: ${sidecarPath}`);
}

await main();
