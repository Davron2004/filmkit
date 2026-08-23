#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// film-android.mjs — films a human-paced .mp4 of a Maestro flow driving an app on a real
// Android emulator via `adb shell screenrecord`. Works with ANY app: point it at a flow.yaml,
// and optionally install/clear the app under film first — or just let the flow's own
// `launchApp` do everything on whatever device is already running.
// Plain Node ESM, zero npm dependencies; orchestrates external tools only: adb, maestro, the
// emulator binary, and ffmpeg.
//
//   node film-android.mjs <flow.yaml> [--out <dir>] [--name <basename>] [--force]
//        [--device <serial>] [--avd <name>] [--install <apk>]... [--app <package-id>] [--fresh]
//        [--guard-app <package-id>] [--guard-strict]
//        [--bit-rate <n>] [--size <WxH>] [--segment-seconds <n>] [--tighten]
//
// NAMING: output defaults to `<out>/<flow>-android.mp4`. `--name <basename>` overrides the stem
// (`<out>/<basename>.mp4`, `<out>/<basename>-tight.mp4`, `<out>/<basename>.json`) so a storyboard
// can be filmed straight into its own layout — `--out demo/raw/10-fork --name take-2`. Filming is
// a repeated activity, so an existing output is NEVER overwritten unless `--force` is passed: the
// check runs in PREFLIGHT, before the device is touched, so a clobbering re-run costs no take.
//
// SIZE: `screenrecord` records at the device's native resolution by default, but plenty of
// emulator AVDs ship an AVC encoder that cannot be configured at a high-density native size. It
// prints "unable to configure video/avc codec at <W>x<H> (err=-22)" and then SILENTLY falls back
// to 720x1280 -- which quietly ruins a capture set that has to stay resolution-consistent across
// takes. `--size <WxH>` pins the recording geometry (keep the device's aspect ratio); raise
// `--bit-rate` alongside it. Two independent nets catch the fallback anyway: the recorder's
// stderr is captured and echoed (prefixed `[screenrecord]`), and the finished file's geometry is
// compared against what was asked for, with a loud warning on mismatch.
//
// CAP / SEGMENT CHAIN: `adb shell screenrecord` hard-stops at 180s, so no single recording can
// span a longer flow. This tool therefore records a CHAIN of segments: each one runs with
// `--time-limit <segment-seconds>` (default 170, hard-capped at 180) writing to its own
// /sdcard/<base>-segNNN.mp4, and the moment a segment's process exits the next one is spawned.
// The flow is filmed end to end; the price is a SEAM at every segment boundary — the few hundred
// milliseconds (~0.3s measured on a local emulator) that the adb round trip takes to tear down
// one recorder and start the next. Nothing on screen during that window is filmed. Seams land
// every `--segment-seconds`, deterministically, so a shot that must not be cut can be kept inside
// one segment by construction. A run that fits in one segment takes the single-file path below
// and is bit-identical to what this tool produced before chaining existed.
//
// STITCHING (measured, not assumed — see also tighten.mjs's VFR GOTCHA header). screenrecord's
// mp4 is genuinely variable-frame-rate: no frame is emitted while the screen is static. So a
// segment file does not know how long it recorded, and it is wrong in BOTH directions:
//   - A segment that ends on a held beat is SHORTER in the file than it was in life, because the
//     trailing still time has no frame to carry it. Plain `-f concat -c copy` compounds that at
//     every seam — measured: three 12s recordings of a static screen concatenated to 14.3s
//     instead of ~36s.
//   - Yet its container duration can also OVERSTATE, because an mp4's duration is the last
//     sample's timestamp plus the last sample's duration, and the muxer fabricates that final
//     duration by repeating the previous inter-frame gap — which on static footage is seconds
//     long. Measured on a real 170s segment: container 177.17s, last actual picture at 157.17s.
// Neither number is the answer, and re-encoding fixes neither: this is container timestamps, not
// codec data. What is trustworthy is the wall clock this process measured around each segment.
// So each non-final segment gets an explicit `duration` directive in the concat list —
// `max(content end, min(wall duration, time limit))` — which makes the demuxer offset the next
// segment by the true elapsed time and hold the last frame across the seam. Verified: seam
// offsets land exactly where the directive puts them (a 220.9s two-segment run stitched to
// 220.1s; five 20s segments of 100.6s wall time stitched to 99.3s, ~0.33s per seam, which is the
// seam gap itself and dead time by definition).
// Stream copy is otherwise correct — every segment comes from the same screenrecord
// configuration, so SPS/PPS/profile match and the stitched file decodes clean end to end; a
// re-encode fallback exists only for the case where copy actually fails.
// The stitch is then CHECKED rather than assumed, because ffmpeg's failure mode here is a
// warning, not an exit code: "Non-monotonic DTS in output stream" scrambles the timeline and
// still exits 0. So the concat's stderr is captured and scanned for that string, and the
// finished file's duration is compared against the timeline the directives planned — a window,
// because the last segment plays out to its own (over-declaring) container end rather than to a
// directive: the sum of every `duration` line plus the tail's content end at the low end, plus
// the tail's container duration at the high end. Landing more than STITCH_DRIFT_TOLERANCE_SEC
// outside that window means the demuxer did not lay the segments down where they were placed —
// both conditions print a loud warning and land in the sidecar's `stitch` block.
//
// FOREGROUND WATCHDOG (`--app` / `--guard-app`, and why a green flow can hand back a dead take).
// A Maestro flow only knows what its selectors can see, and "covered by another app" satisfies
// most of them. `extendedWaitUntil: { notVisible: "Building…" }` returns COMPLETED the instant a
// neighbouring app draws over the screen, so a 226s take can end on someone else's login screen
// with every step green and this tool printing a duration and exiting 0. Maestro cannot notice —
// filmkit owns the recorder, so it is the only layer that can.
// So when a package to guard is known (`--guard-app <pkg>`, defaulting to `--app` when that was
// passed), the whole recording window is sampled every FOREGROUND_POLL_MS through
// `dumpsys activity activities | grep topResumedActivity`, whose line reads
//   topResumedActivity=ActivityRecord{69542266 u0 com.whim/.MainActivity t104}
// (leading indentation varies with the display nesting, so the regex anchors on the key, not the
// column). Every CHANGE is timestamped relative to the recorder starting and lands in the
// sidecar's `foreground` array, so a take's occupancy history survives the run.
// What counts as an interloper is deliberately narrow, because `topResumedActivity` tracks
// ACTIVITIES, and most of the system chrome that legitimately covers an app under film is made
// of WINDOWS, not activities. Measured on this emulator: opening the notification shade leaves
// `topResumedActivity=com.whim/.MainActivity` untouched and only moves `mCurrentFocus` to
// `Window{… NotificationShade}`; the IME behaves the same way for the same reason. So the shade
// and the keyboard cannot produce a false positive here at all, and FOREGROUND_ALLOW only has to
// name the system surfaces that really are activities: SystemUI's own (`com.android.systemui*`)
// and the runtime-permission dialog (`com.{android,google.android}.permissioncontroller`), plus
// the IME packages for the devices that do route one through an activity.
// The launcher is NOT on that list: home showing means the app under film was backgrounded, which
// is the failure, not an exception to it. Neither is the bare `android` package, which is where
// the share sheet and the ANR dialog live — both of those genuinely cover a take, and #10's
// second dead take was exactly an ANR stealing focus. A flow that authors a share sheet on
// purpose should simply not pass a guard package.
// Policy, once an interloper is seen: say so immediately (`[foreground] INTERLOPER <pkg> at
// <t>s`), keep rolling, and fail the run at the end with `status: "interloper"` in the sidecar.
// The recording is NOT killed — the take is suspect, not necessarily worthless, and the operator
// is the one who decides. `--guard-strict` inverts that for the case where a dead take is not
// worth the wall clock: the Maestro child is SIGINT'd on the spot (escalating to SIGKILL after
// MAESTRO_ABORT_GRACE_MS) and the run harvests through the ordinary path, so the partial take is
// still stitched and still saved.
// The live line is printed but never TRUSTED to be seen: `maestro test` inherits this process's
// stdio and redraws its own progress with ANSI escapes, which can scribble over a line printed
// from under it. So every guarded run also prints a summary block after harvest, and the sidecar
// carries the same facts. Three channels, because the whole point of #10 is that one silent
// channel cost a generation.
// A read that fails or comes back without a `topResumedActivity` line (screen off, an activity
// transition mid-dump) is recorded as `unknown` and is never an interloper — flagging a take
// dead on a transient adb hiccup would be its own version of this bug.
//
// STATE MACHINE (one linear pipeline, no branching back-edges — a filming run is a single
// attempt, never resumed mid-way):
//
//   PREFLIGHT → DEVICE → [INSTALL/FRESH] → RECORD_START → MAESTRO → RECORD_STOP
//     → PULL → STITCH/FINALIZE → [TIGHTEN] → SIDECAR → done
//
// - PREFLIGHT: verify Node >= 20, resolve adb/maestro/ffmpeg/emulator (PATH first, then
//   $FILMKIT_* overrides, then grounded fallbacks in lib/tools.mjs), verify the flow file
//   exists, and refuse to clobber an existing output. Any failure here exits non-zero before
//   anything on the device is touched. Once a device is in hand, a guarded run also reads the
//   foreground package and WARNS if it is not the guarded app — only warns, because the flow's
//   own `launchApp` is entitled to fix that a second later.
// - DEVICE: if `--device <serial>` was passed, that serial must be online. Otherwise reuse any
//   already-running device (`adb devices`, state "device"); else boot the requested AVD headless
//   and poll for `sys.boot_completed`. Generous timeout — an emulator cold-boot is legitimately
//   slow.
// - INSTALL/FRESH (all optional): `--install <apk>` runs `adb install -r` for each apk passed
//   (idempotent). `--fresh` requires `--app <package-id>` and runs `pm clear` on it right before
//   recording, so the flow always starts from a fresh-first-run state (the Android analog of
//   reinstalling). Nothing is installed or cleared unless you ask.
// - RECORD_START..RECORD_STOP is the only window where on-device child processes exist that
//   MUST be torn down before this process exits. Once the chain is running, every route out of
//   here goes through `harvest()` — stop the recorder, pull, stitch, write the sidecar — and it
//   runs at most once: the normal path awaits it, a thrown error (including a failed `maestro
//   test`) reaches it through the catch below, and a Ctrl-C reaches it through an installed
//   SIGINT handler (without one, Node's default disposition kills this process outright and
//   leaves a live `screenrecord` and un-pulled device files behind). An interrupted run saves
//   what was filmed and exits 130. A terminal Ctrl-C signals the whole process group, so the
//   `maestro test` child dies with us; a bare `kill -INT` of this pid alone does not stop it.
// - MAESTRO failing does not short-circuit RECORD_STOP/FINALIZE: the partial recording is still
//   pulled and transcoded (useful for debugging a flaky flow), but the process still exits
//   non-zero and prints the flow's own error.
// - PULL is where a chain becomes a take, and a segment can arrive unusable: SIGINT lands within
//   a second of a recorder spawning and the mp4 never gets a moov atom. Every pulled segment is
//   therefore validated (readable container duration AND at least one packet) before it enters
//   the concat list. An empty TRAILING segment is dropped with a note — nothing that was on
//   screen is in it. Any other unusable segment is real lost footage: the take is stitched from
//   what survived, reported as truncated through the same channel as a chain abort, and the run
//   exits non-zero with the file kept. One bad segment never costs the other N-1.
// - TIGHTEN (opt-in, --tighten): runs after FINALIZE, only if maestro succeeded (a failed flow's
//   partial recording is left as-is for debugging, not tightened). Calls tighten.mjs's
//   `tighten()` over the finalized .mp4; the raw file is always kept, a `-tight` variant is
//   written alongside it. A tighten failure is reported but does not fail the overall command —
//   the raw recording already succeeded by that point.
// - SIDECAR: `<out>/<name>.json` records what produced the video — a `status` (ok / truncated /
//   interloper / flow-failed / interrupted / failed), flow path and content hash, argv, device
//   serial/fingerprint, requested vs. actual geometry, bit rate, every segment's wall duration
//   and whether it was dropped, the stitch's planned-vs-actual duration check, raw and tightened
//   durations, any kept temp files, timestamp. It is written on every path from RECORD_START
//   onward, failures included, so a `demo/raw/` tree stays self-describing months later. A run
//   that dies in PREFLIGHT or DEVICE writes none — nothing was filmed, so there is nothing to
//   describe, and an existing sidecar from an earlier take must not be overwritten by a run that
//   never reached the camera.
import { spawn } from 'node:child_process';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, basename, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, runCapture, resolveTool, sleep, fileExists } from './lib/tools.mjs';
import { tighten } from './tighten.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_DIR = join(HERE, 'out');
const DEVICE_DIR = '/sdcard';

const DEFAULT_BIT_RATE = '8000000';
const DEFAULT_SEGMENT_SECONDS = 170; // headroom under screenrecord's own 180s hard stop
const SEGMENT_SECONDS_CAP = 180; // screenrecord refuses / truncates beyond this
const SEGMENT_EARLY_EXIT_TOLERANCE_MS = 2000; // a healthy segment runs its full --time-limit
const RECORD_WARMUP_MS = 1500; // let screenrecord actually start on-device before Maestro taps
const RECORD_FINALIZE_MS = 2000; // after SIGINT, before adb pull — lets the on-device mp4 close
const RECORD_STOP_TIMEOUT_MS = 15000; // SIGINT ignored this long → escalate rather than hang
const BOOT_TIMEOUT_MS = 5 * 60 * 1000; // cold emulator boot is legitimately slow
const BOOT_POLL_MS = 3000;
// A trailing segment that lived no longer than this was killed before it could hold anything an
// operator would miss — dropping it is a note, not a truncation. Anything longer is real footage.
const SEGMENT_EMPTY_MAX_WALL_SEC = 3;
// How far the stitched file may sit from the timeline the concat directives planned before the
// stitch is called suspect. Seams cost ~0.33s each; 1.5s is well past any plausible seam total.
const STITCH_DRIFT_TOLERANCE_SEC = 1.5;

// How often the foreground watchdog asks the device who is on top. Every sample is one `adb
// shell dumpsys` round trip (~40ms here), so this is cheap enough to run for the whole take and
// still fine-grained enough that a neighbour cannot slip in and out between two polls.
const FOREGROUND_POLL_MS = 1500;
// --guard-strict aborts by SIGINT-ing the maestro child (a JVM: `maestro` execs java, so the pid
// we hold is the one that matters). If the JVM ignores it this long, escalate rather than hang —
// the recording still has to be harvested.
const MAESTRO_ABORT_GRACE_MS = 10000;
// System surfaces that may legitimately be the top resumed activity while the app under film is
// still the take's subject. Kept deliberately short — see the FOREGROUND WATCHDOG header for why
// the notification shade and the IME are absent (they never take an activity at all) and why the
// launcher and bare `android` are absent (they are the failure, not an exception to it).
const FOREGROUND_ALLOW = [
  /^com\.android\.systemui(\.|$)/, // SystemUI's own activities (screenshot, accessibility menu, …)
  /^com\.(android|google\.android)\.permissioncontroller$/, // runtime-permission grant dialog
  /(^|\.)inputmethod(\.|$)/, // com.google.android.inputmethod.latin and the like
  /(^|\.)(ime|latinime)$/,
];

const USAGE =
  'usage: node film-android.mjs <flow.yaml> [--out <dir>] [--name <basename>] [--force] ' +
  '[--device <serial>] [--avd <name>] [--install <apk>]... [--app <package-id>] [--fresh] ' +
  '[--guard-app <package-id>] [--guard-strict] ' +
  '[--bit-rate <n>] [--size <WxH>] [--segment-seconds <n>] [--tighten]';

function log(msg) {
  console.log(`[film-android] ${msg}`);
}

function usageError(msg) {
  console.error(`[film-android] ${msg}`);
  console.error(USAGE);
  process.exit(1);
}

// A flag that takes a value must not eat the NEXT FLAG as that value. `--out --dry-run` used to
// set out to "--dry-run" and then film into a directory named after a flag; `--install` with
// nothing after it used to reach `resolve(undefined)` and print a stack trace.
function valueFor(argv, i, flag) {
  const value = argv[i + 1];
  if (value === undefined) usageError(`${flag} needs a value — nothing followed it`);
  if (value.startsWith('--')) usageError(`${flag} needs a value, but the next argument is the flag "${value}"`);
  return value;
}

function parseArgs(argv) {
  const rest = [];
  let out;
  let name;
  let force = false;
  let device;
  let avd;
  const installs = [];
  let appId;
  let fresh = false;
  let guardApp;
  let guardStrict = false;
  let bitRate = DEFAULT_BIT_RATE;
  let size;
  let segmentSeconds = DEFAULT_SEGMENT_SECONDS;
  let doTighten = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out = valueFor(argv, i, '--out');
      i++;
    } else if (argv[i] === '--name') {
      name = valueFor(argv, i, '--name');
      i++;
    } else if (argv[i] === '--force') {
      force = true;
    } else if (argv[i] === '--device') {
      device = valueFor(argv, i, '--device');
      i++;
    } else if (argv[i] === '--avd') {
      avd = valueFor(argv, i, '--avd');
      i++;
    } else if (argv[i] === '--install') {
      installs.push(resolve(valueFor(argv, i, '--install')));
      i++;
    } else if (argv[i] === '--app') {
      appId = valueFor(argv, i, '--app');
      i++;
    } else if (argv[i] === '--fresh') {
      fresh = true;
    } else if (argv[i] === '--guard-app') {
      guardApp = valueFor(argv, i, '--guard-app');
      i++;
    } else if (argv[i] === '--guard-strict') {
      guardStrict = true;
    } else if (argv[i] === '--bit-rate') {
      bitRate = String(valueFor(argv, i, '--bit-rate'));
      i++;
    } else if (argv[i] === '--size') {
      size = String(valueFor(argv, i, '--size'));
      i++;
    } else if (argv[i] === '--segment-seconds') {
      segmentSeconds = Number(valueFor(argv, i, '--segment-seconds'));
      i++;
    } else if (argv[i] === '--tighten') {
      doTighten = true;
    } else {
      rest.push(argv[i]);
    }
  }
  if (rest.length !== 1 || !/\.ya?ml$/.test(rest[0])) {
    console.error(USAGE);
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
  // The watchdog guards `--guard-app` if given, otherwise whatever `--app` already named. Asking
  // for the strict policy without naming anything to guard would be silently inert.
  const guardedApp = guardApp ?? appId ?? null;
  if (guardStrict && !guardedApp) {
    console.error('--guard-strict needs a package to guard — pass --guard-app <package-id> (or --app <package-id>)');
    process.exit(1);
  }
  if (size && !/^\d+x\d+$/.test(size)) {
    console.error(`--size must look like <width>x<height> (got "${size}")`);
    process.exit(1);
  }
  // A name becomes a filename stem in --out and a filename stem on the device; keep it one.
  if (name !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    console.error(`--name must be a bare filename stem — letters, digits, . _ - (got "${name}")`);
    process.exit(1);
  }
  if (!Number.isFinite(segmentSeconds) || segmentSeconds < 5 || segmentSeconds > SEGMENT_SECONDS_CAP) {
    console.error(
      `--segment-seconds must be between 5 and ${SEGMENT_SECONDS_CAP} (screenrecord's own hard ` +
        `cap) — got "${segmentSeconds}"`,
    );
    process.exit(1);
  }
  return {
    flowArg: rest[0],
    outDir: out ? resolve(out) : DEFAULT_OUT_DIR,
    name,
    force,
    device,
    avd,
    installs,
    appId,
    fresh,
    guardedApp,
    guardStrict,
    bitRate,
    size,
    segmentSeconds,
    doTighten,
  };
}

// ── PREFLIGHT ───────────────────────────────────────────────────────────────────────────────
async function preflight(flowPath, plannedOutputs, force) {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 20) {
    throw new Error(`Node >= 20 required — running under Node ${process.version}`);
  }
  if (!(await fileExists(flowPath))) {
    throw new Error(`flow file not found: ${flowPath}`);
  }
  if (!force) {
    for (const candidate of plannedOutputs) {
      if (await fileExists(candidate)) {
        throw new Error(
          `refusing to overwrite an existing take: ${candidate}\n` +
            '  pass --name <basename> to film a new one, or --force to overwrite this one.',
        );
      }
    }
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

// `wm size` reports "Physical size: WxH" and, when a size override is in force, an additional
// "Override size: WxH" — the override is what screenrecord actually captures.
async function deviceNativeSize(adb, deviceId) {
  try {
    const stdout = await runCapture(adb, ['-s', deviceId, 'shell', 'wm', 'size']);
    const override = stdout.match(/Override size:\s*(\d+x\d+)/);
    const physical = stdout.match(/Physical size:\s*(\d+x\d+)/);
    return (override ?? physical)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function deviceFingerprint(adb, deviceId) {
  try {
    return (await runCapture(adb, ['-s', deviceId, 'shell', 'getprop', 'ro.build.fingerprint'])).trim() || null;
  } catch {
    return null;
  }
}

// ── FOREGROUND WATCHDOG: who is actually on screen while the camera rolls ────────────────────
// See the header for the policy and for what was measured. This half is just the mechanics.

// `topResumedActivity=ActivityRecord{69542266 u0 com.whim/.MainActivity t104}` — the leading
// indentation varies with how deep the display/task nesting goes, so anchor on the key. The two
// fields between `{` and the component are the record's identity hash and the user id; neither
// is worth naming, but both have to be stepped over to reach `<package>/<activity>`.
export const TOP_RESUMED_RE = /topResumedActivity=ActivityRecord\{\S+\s+\S+\s+([^\s/{}]+)\/([^\s{}]+)/;

export function parseTopResumed(dumpsysText) {
  // A multi-display device prints one line per display. The first is the default display, which
  // is the one being filmed; a second screen is not this tool's problem.
  const match = TOP_RESUMED_RE.exec(dumpsysText ?? '');
  if (!match) return null;
  return { package: match[1], activity: match[2] };
}

export function isAllowedOverlay(pkg) {
  return FOREGROUND_ALLOW.some((pattern) => pattern.test(pkg));
}

// One sample. Grepping ON the device matters: the full `dumpsys activity activities` is hundreds
// of kilobytes and this runs every 1.5s for the length of the take. `|| true` because grep exits
// 1 when it matches nothing and adb forwards the remote exit code, which would otherwise turn a
// perfectly ordinary "no line right now" into a thrown error.
async function readForeground(adb, deviceId) {
  try {
    const stdout = await runCapture(adb, [
      '-s', deviceId, 'shell', 'dumpsys activity activities | grep topResumedActivity || true',
    ]);
    const top = parseTopResumed(stdout);
    if (!top) return { verdict: 'unknown', package: null, activity: null, note: 'no topResumedActivity line in dumpsys' };
    return { ...top, verdict: null };
  } catch (err) {
    return { verdict: 'unknown', package: null, activity: null, note: `dumpsys failed: ${err.message}` };
  }
}

function classify(sighting, guardedApp) {
  if (sighting.verdict === 'unknown') return 'unknown';
  if (sighting.package === guardedApp) return 'guarded';
  return isAllowedOverlay(sighting.package) ? 'allowed' : 'interloper';
}

// Polls until stop(). `events` only grows when the answer CHANGES, so a five-minute take that was
// never disturbed contributes exactly one row (the guarded app, at t≈0) instead of two hundred.
function startForegroundWatch(adb, deviceId, { guardedApp, startedAt, onInterloper }) {
  const events = [];
  const interlopers = [];
  let stopped = false;
  let timer = null;
  let last = null; // "<package>/<activity>" of the previous sample, or 'unknown'
  let unknownRun = 0;
  let unknownWarned = false;

  const atSec = () => Number(((Date.now() - startedAt) / 1000).toFixed(2));

  const sampleOnce = async () => {
    const sighting = await readForeground(adb, deviceId);
    const verdict = classify(sighting, guardedApp);
    const key = verdict === 'unknown' ? `unknown:${sighting.note}` : `${sighting.package}/${sighting.activity}`;

    if (verdict === 'unknown') {
      unknownRun++;
      // A single unreadable sample is noise (an activity transition caught mid-dump). A run of
      // them means the probe itself is broken, and a watchdog that has silently stopped watching
      // is worse than no watchdog — so say it once, loudly, and keep sampling.
      if (unknownRun === 5 && !unknownWarned) {
        unknownWarned = true;
        console.error(
          `[foreground] ⚠️  the foreground probe has come back unreadable ${unknownRun} times running ` +
            `(${sighting.note}) — this take is NOT being guarded from here on unless it recovers.`,
        );
      }
    } else {
      unknownRun = 0;
    }

    if (key === last) return;
    last = key;
    const event = { atSec: atSec(), package: sighting.package, activity: sighting.activity ?? null, verdict };
    if (sighting.note) event.note = sighting.note;
    events.push(event);

    if (verdict === 'interloper') {
      interlopers.push(event);
      console.error(
        `\n[foreground] INTERLOPER ${event.package} at ${event.atSec}s — ` +
          `${event.package}/${event.activity} is in front of ${guardedApp}. ` +
          'Whatever the flow reports, this take is covered from here.\n',
      );
      onInterloper?.(event);
    } else if (verdict === 'allowed') {
      log(`[foreground] ${event.package} at ${event.atSec}s (system surface — allowed)`);
    } else if (verdict === 'guarded' && events.length > 1) {
      log(`[foreground] back to ${event.package} at ${event.atSec}s`);
    }
  };

  // stop() has to be able to cut a tick short, so the sleep's resolver is held alongside its
  // timer: clearing the timeout alone would leave the loop parked on a promise nothing will ever
  // settle, and `await loop` in stop() would hang the whole harvest.
  let wake = null;
  const tick = () =>
    new Promise((resolveTick) => {
      wake = resolveTick;
      timer = setTimeout(resolveTick, FOREGROUND_POLL_MS);
      timer.unref?.(); // never the reason this process stays alive
    });

  const loop = (async () => {
    while (!stopped) {
      await sampleOnce().catch(() => {}); // readForeground already swallows; this is belt-and-braces
      if (stopped) break;
      await tick();
      timer = null;
      wake = null;
    }
  })();

  return {
    guardedApp,
    events,
    interlopers,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      wake?.();
      await loop;
      return events;
    },
  };
}

// ── screen recording: a chain of `--time-limit` segments spanning the whole flow ─────────────
// One `screenrecord` invocation can never exceed 180s (see the CAP header). The chain records
// back-to-back segments instead, each finalized by screenrecord itself when its time limit
// expires, and the last one finalized by SIGINT when the flow is done. `segments[]` is the
// authoritative record of the run — every seam, every wall duration, every recorder warning.
const segTag = (index) => `seg${String(index).padStart(3, '0')}`;

function startSegmentChain(adb, deviceId, { deviceBase, bitRate, size, segmentSeconds }) {
  const segments = [];
  let stopped = false;
  let abortReason = null;

  const spawnSegment = (index) => {
    const tag = segTag(index);
    const devicePath = `${DEVICE_DIR}/${deviceBase}-${tag}.mp4`;
    const startedAt = Date.now();
    const child = spawn(
      adb,
      [
        '-s', deviceId, 'shell', 'screenrecord',
        '--bit-rate', bitRate,
        ...(size ? ['--size', size] : []),
        '--time-limit', String(segmentSeconds),
        devicePath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const seg = { index, tag, devicePath, startedAt, wallSec: null, exitCode: null, signal: null, stderr: [] };

    // screenrecord's own diagnostics — "unable to configure video/avc codec at <W>x<H>
    // (err=-22)" followed by a SILENT downscale — arrive on the remote stderr, which adb keeps
    // separate from stdout. Swallowing this stream (the old `stdio: 'ignore'`) is how a run can
    // report success and hand back a file at a third of the requested pixel count.
    let pending = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        seg.stderr.push(line.trim());
        console.log(`[screenrecord] ${tag}: ${line.trim()}`);
      }
    });
    child.stderr.on('end', () => {
      if (pending.trim()) {
        seg.stderr.push(pending.trim());
        console.log(`[screenrecord] ${tag}: ${pending.trim()}`);
      }
      pending = '';
    });

    seg.child = child;
    seg.exited = new Promise((resolveExit) => {
      child.on('error', (err) => {
        seg.spawnError = err.message;
        seg.wallSec = (Date.now() - startedAt) / 1000;
        resolveExit();
      });
      child.on('exit', (code, signal) => {
        seg.exitCode = code;
        seg.signal = signal;
        seg.wallSec = (Date.now() - startedAt) / 1000;
        resolveExit();
      });
    });
    return seg;
  };

  // The chain loop runs concurrently with the Maestro flow: `await seg.exited` parks until a
  // segment ends (its own time limit, or the SIGINT from stop()), then the next segment starts
  // immediately. Nothing here polls; the only delay at a seam is the adb round trip.
  const loop = (async () => {
    try {
      await chainLoop();
    } catch (err) {
      // The loop never throws in practice (every child failure surfaces as an exit/error event);
      // this keeps an unexpected one from turning into an unhandled rejection that outlives the
      // try/finally around the Maestro run.
      abortReason = `segment chain failed: ${err.message}`;
      console.error(`[film-android] ${abortReason}`);
    }
  })();

  async function chainLoop() {
    for (let index = 1; !stopped; index++) {
      const seg = spawnSegment(index);
      segments.push(seg);
      log(`recording ${seg.tag} (limit ${segmentSeconds}s) -> ${seg.devicePath}`);
      await seg.exited;
      const ended = seg.spawnError
        ? `could not start: ${seg.spawnError}`
        : seg.signal
          ? `stopped by ${seg.signal}`
          : `exit ${seg.exitCode}`;
      log(`${seg.tag} ended after ${seg.wallSec.toFixed(2)}s (${ended})`);
      if (stopped) break;
      // A healthy segment runs its whole time limit. Ending early on its own means screenrecord
      // itself failed (bad --size, no space, encoder gone) — respawning in a tight loop would
      // just spin, so the chain stops and the run is reported as truncated rather than silently
      // filming nothing for the rest of the flow.
      const limitMs = segmentSeconds * 1000;
      if (seg.spawnError || seg.exitCode !== 0 || seg.wallSec * 1000 < limitMs - SEGMENT_EARLY_EXIT_TOLERANCE_MS) {
        abortReason =
          `${seg.tag} ended on its own after ${seg.wallSec.toFixed(2)}s of a ${segmentSeconds}s ` +
          `limit (${ended}) — recording stopped here; the rest of the flow is NOT on camera`;
        console.error(`[film-android] ${abortReason}`);
        break;
      }
    }
  }

  // SIGINT on the local `adb shell` client forwards a Ctrl-C to the remote pty, which is what
  // makes the on-device `screenrecord` process finalize its mp4 container instead of leaving
  // it truncated — killing the local process outright (SIGKILL/SIGTERM) does not do this.
  async function doStop() {
    stopped = true;
    const live = segments[segments.length - 1];
    if (live && live.exitCode === null && !live.spawnError) {
      live.child.kill('SIGINT');
    }
    // A losing `sleep()` here would keep its timer — and the whole event loop — alive for the
    // full timeout after a stop that took 200ms, so the process sits there for 13s doing
    // nothing. Own the timer: unref it so it can never hold the loop open, and clear it as soon
    // as the race is decided.
    const timedOut = Symbol('timeout');
    let timer;
    const timeout = new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(timedOut), RECORD_STOP_TIMEOUT_MS);
      timer.unref?.();
    });
    const raced = await Promise.race([loop.then(() => null), timeout]);
    clearTimeout(timer);
    if (raced === timedOut) {
      // Last resort: SIGKILL forfeits the tail of this segment's mp4 rather than hanging the
      // whole run. Everything already stitched behind it is unaffected.
      console.error(
        `[film-android] the live recorder ignored SIGINT for ${RECORD_STOP_TIMEOUT_MS / 1000}s — ` +
          'escalating to SIGKILL; the tail of the last segment may be unrecoverable',
      );
      live?.child.kill('SIGKILL');
      await loop;
    }
    await sleep(RECORD_FINALIZE_MS);
  }

  // Both the normal path and the SIGINT handler can reach stop(); memoizing keeps the second
  // caller from re-killing a dead child and waiting out another RECORD_FINALIZE_MS.
  let stopPromise = null;

  return {
    segments,
    get abortReason() {
      return abortReason;
    },
    stop() {
      stopPromise ??= doStop();
      return stopPromise;
    },
  };
}

// ── probing: durations, geometry and where a segment's content really ends ───────────────────
// `ffmpeg -i <file>` with no output prints the container header and exits non-zero without
// decoding a single frame — the cheapest exact answer available, and it keeps this tool's
// external-tool set at adb/maestro/ffmpeg (no ffprobe).
function capture(cmd, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => reject(new Error(`failed to run \`${cmd} ${args.join(' ')}\`: ${err.message}`)));
    child.on('exit', (code, signal) => resolvePromise({ stdout, stderr, code, signal }));
  });
}

export async function probeVideo(ffmpeg, path) {
  const { stderr } = await capture(ffmpeg, ['-hide_banner', '-i', path]);
  const d = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const g = stderr.match(/Video:[^\n]*?[,\s](\d+)x(\d+)[,\s]/);
  return {
    durationSec: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
    size: g ? `${g[1]}x${g[2]}` : null,
  };
}

const NOMINAL_FRAME_SEC = 1 / 30; // how much real time one trailing frame can honestly represent

// Where a segment's picture actually STOPS, which is NOT its container duration. An mp4's
// duration is the last sample's timestamp plus the last sample's *duration*, and on a VFR screen
// recording the muxer has no real value for that last duration — it repeats the previous
// inter-frame gap, which on a segment that ended on a held still frame is many seconds long.
// Measured on a real 170s segment: container duration 177.17s, last picture at 157.17s (a 20s
// gap repeated once). Trusting the container there would wedge a phantom 7s freeze into the seam.
//
// `-c copy -f framecrc` demuxes without decoding (~30ms on a 170s segment) and prints one line
// per packet: "stream, pts, dts, duration, size, crc" in the stream's own time base, under a
// header block that names that time base outright — `#tb 0: 1/90000`. Read it from there.
// (The ratio identity containerSec == (lastPts + lastDur) / tb also recovers it without a unit,
// and stays as the fallback for a muxer build that omits the header line.)
//
// The packet count is the other thing this probe is for: a segment SIGINT-ed within a second of
// spawning yields an mp4 with no moov atom and no packets at all, which must be caught here
// rather than by ffmpeg failing halfway through a concat.
export async function probePackets(ffmpeg, path) {
  try {
    const { stdout } = await capture(ffmpeg, ['-v', 'error', '-i', path, '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', '-']);
    const rows = stdout.split('\n').filter((line) => /^\d+,/.test(line));
    const tb = stdout.match(/^#tb\s+\d+:\s*(\d+)\s*\/\s*(\d+)/m);
    const timebaseSec = tb && Number(tb[2]) > 0 ? Number(tb[1]) / Number(tb[2]) : null;
    if (rows.length === 0) return { count: 0, lastPts: null, lastDur: null, timebaseSec };
    const cols = rows[rows.length - 1].split(',').map((c) => Number(c.trim()));
    const [, lastPts, , lastDur] = cols;
    return { count: rows.length, lastPts, lastDur, timebaseSec };
  } catch {
    return null; // the probe itself could not run — the caller treats that as an unusable segment
  }
}

export function contentEndSec(packets, containerSec, tag) {
  if (!containerSec || !packets || packets.count === 0) return null;
  const { lastPts, lastDur, timebaseSec } = packets;
  if (!Number.isFinite(lastPts) || !Number.isFinite(lastDur) || lastPts + lastDur <= 0) return null;
  if (timebaseSec === null) {
    log(`${tag}: framecrc printed no "#tb" line — deriving the time base from the packet/container ratio instead`);
  }
  const ticksToSec = timebaseSec ?? containerSec / (lastPts + lastDur);
  const lastPtsSec = lastPts * ticksToSec;
  const lastDurSec = lastDur * ticksToSec;
  if (lastPtsSec < 0 || lastPtsSec > containerSec) return null;
  return lastPtsSec + Math.min(lastDurSec, NOMINAL_FRAME_SEC);
}

async function finalizeVideo(ffmpeg, rawPath, outPath) {
  try {
    await run(ffmpeg, ['-y', '-i', rawPath, '-c', 'copy', '-movflags', '+faststart', outPath], { stdio: 'inherit' });
  } catch (err) {
    log(`ffmpeg remux (stream copy) failed (${err.message}) — falling back to re-encode...`);
    await run(ffmpeg, ['-y', '-i', rawPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outPath], { stdio: 'inherit' });
  }
}

// Stitch a segment chain into one continuous mp4 (concat demuxer + stream copy + faststart).
// The `duration` directives are the load-bearing part — see the STITCHING header. Each non-final
// segment declares how much of the finished timeline it occupies:
//
//   offset = max(content end, min(wall duration, time limit))
//
// The second term is ground truth for what happened in front of the camera — the wall clock this
// process measured, clamped to the limit because the wall clock also contains adb's own spawn.
// The first term is the guard: a segment's frames must never extend past its own offset, or the
// next segment's timestamps would overlap them. Both are needed and both were measured wrong on
// their own (see STITCHING and contentEndSec). The final segment declares nothing; its own
// container tail ends the video, exactly as it does on the single-segment path.
export function concatListBody(entries) {
  return entries
    .map(({ path, durationSec }) =>
      durationSec === null
        ? `file '${path.replace(/'/g, "'\\''")}'\n`
        : `file '${path.replace(/'/g, "'\\''")}'\nduration ${durationSec.toFixed(6)}\n`,
    )
    .join('');
}

// Returns what the concat pass said about itself. ffmpeg's stderr is CAPTURED rather than
// inherited because the interesting failure here doesn't touch the exit code: "Non-monotonic DTS
// in output stream" means the demuxer laid segments down out of order, and ffmpeg still exits 0
// with a scrambled file. The stderr is echoed on failure and on that warning, so nothing the
// operator needed to see is swallowed.
export async function stitchSegments(ffmpeg, listPath, outPath) {
  const args = ['-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', listPath];
  let result = await capture(ffmpeg, [...args, '-c', 'copy', '-movflags', '+faststart', outPath]);
  let reencoded = false;
  if (result.code !== 0) {
    log(`ffmpeg concat (stream copy) failed (exit ${result.code}) — falling back to re-encode...`);
    process.stderr.write(result.stderr);
    result = await capture(ffmpeg, [...args, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outPath]);
    reencoded = true;
    if (result.code !== 0) {
      process.stderr.write(result.stderr);
      throw new Error(`ffmpeg concat failed in both stream-copy and re-encode form (exit ${result.code})`);
    }
  }
  const nonMonotonicDts = (result.stderr.match(/Non-monotonic DTS/g) ?? []).length;
  if (nonMonotonicDts > 0) process.stderr.write(result.stderr);
  return { nonMonotonicDts, reencoded };
}

// ── validation: which pulled segments can actually be stitched ───────────────────────────────
// Judge one pulled file on its own terms and record what the probes found on the segment.
// Returns the reason it cannot be used, or null when it passes. A file with a readable container
// duration but zero packets is the SIGINT-within-a-second case: screenrecord was killed before
// it wrote a moov atom, so there is a file, it has a name, and it holds no picture at all.
export async function inspectSegment(ffmpeg, localPath, seg) {
  const probed = await probeVideo(ffmpeg, localPath);
  seg.containerSec = probed.durationSec;
  seg.size = probed.size;
  const packets = await probePackets(ffmpeg, localPath);
  seg.packetCount = packets?.count ?? null;
  seg.contentEndSec = contentEndSec(packets, probed.durationSec, seg.tag);
  if (probed.durationSec !== null && packets && packets.count > 0) return null;
  return (
    'the pulled file holds no usable video (' +
    `${probed.durationSec === null ? 'container duration unreadable' : `${probed.durationSec.toFixed(2)}s container`}, ` +
    `${packets ? `${packets.count} packet(s)` : 'packet probe failed'}) — a recorder stopped within a second of ` +
    'starting never gets to write its moov atom'
  );
}

// Split a chain of pulled segments into the ones that can be stitched and the ones that cannot,
// and say what dropping the latter costs. The asymmetry is the point: an empty TRAILING segment
// is the ordinary shape of a stop (the chain always spawns one more recorder than the flow needs)
// and nothing that was on screen is in it, so it is dropped with a note. An unusable segment
// anywhere else is real footage the operator will not get back — the take is stitched from what
// survived and reported as truncated, never silently shortened, and never thrown away wholesale.
export async function selectSegments(ffmpeg, pulled, { emptyTailMaxWallSec = SEGMENT_EMPTY_MAX_WALL_SEC } = {}) {
  const usable = [];
  const dropped = [];
  for (const entry of pulled) {
    const { seg, localPath, pullError } = entry;
    const reason = pullError ?? (await inspectSegment(ffmpeg, localPath, seg));
    if (!reason) {
      usable.push(entry);
      continue;
    }
    seg.dropError = reason;
    const emptyTail = entry === pulled[pulled.length - 1] && (seg.wallSec ?? Infinity) <= emptyTailMaxWallSec;
    dropped.push({ seg, reason, emptyTail });
  }
  const lost = dropped.filter((drop) => !drop.emptyTail).map((drop) => drop.seg);
  const lostWallSec = lost.reduce((sum, seg) => sum + (seg.wallSec ?? 0), 0);
  const lossReason =
    lost.length === 0
      ? null
      : `${lost.map((seg) => seg.tag).join(', ')} could not be pulled or held no video — about ` +
        `${lostWallSec.toFixed(2)}s of the flow is missing from the take`;
  return { usable, dropped, lost, lossReason };
}

// Did the concat lay the segments down where the directives placed them? ffmpeg answers "no"
// with a warning and an exit code of 0, so this comparison is the only thing that can catch it.
//
// The plan is a WINDOW, not a number, and only because of the last segment. Every earlier one
// occupies exactly its `duration` directive, but the tail plays out to its own container end —
// and that end is the fabricated one described in the STITCHING header, which over-declares by
// however long the final held beat was. So the honest lower bound is (directives + the tail's
// real content end) and the honest upper bound is (directives + the tail's container duration).
// Anything inside that is the stitch working; outside it by more than a seam's worth is the
// demuxer having put the segments somewhere else. Returns the stitch record completed with
// actual/drift/ok, plus the warning block to print.
export function assessStitch(stitch, finalProbe) {
  const actualSec = finalProbe?.durationSec ?? null;
  const low = stitch.plannedSec;
  const high = Math.max(stitch.plannedMaxSec ?? stitch.plannedSec, low);
  const driftSec =
    actualSec === null
      ? null
      : actualSec < low
        ? Number((actualSec - low).toFixed(3))
        : actualSec > high
          ? Number((actualSec - high).toFixed(3))
          : 0;
  const drifted = driftSec === null || Math.abs(driftSec) > STITCH_DRIFT_TOLERANCE_SEC;
  const warnings = [];
  if (drifted) {
    warnings.push(
      `⚠️  STITCH DURATION MISMATCH: the concat directives planned a timeline of ${low.toFixed(2)}s` +
        `${high > low ? ` to ${high.toFixed(2)}s (the last segment's content end and its container end)` : ''}, ` +
        `but the stitched file reports ${actualSec === null ? 'no readable duration' : `${actualSec.toFixed(2)}s`}` +
        `${driftSec === null ? '' : ` — ${driftSec > 0 ? '+' : ''}${driftSec.toFixed(2)}s outside that window`}.\n` +
        '   Seams cost ~0.33s each, so a gap this size means the demuxer did not put the segments where they ' +
        'were placed. Watch every seam before using this take.',
    );
  }
  if (stitch.nonMonotonicDtsWarnings > 0) {
    warnings.push(
      `⚠️  ffmpeg printed "Non-monotonic DTS" ${stitch.nonMonotonicDtsWarnings} time(s) during the concat and ` +
        'still exited 0.\n   That means out-of-order timestamps in the output: the timeline may be scrambled at ' +
        'a seam even though the run looks successful.',
    );
  }
  return {
    stitch: { ...stitch, actualSec, driftSec, ok: !drifted && stitch.nonMonotonicDtsWarnings === 0 },
    warnings,
  };
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const {
    flowArg, outDir, name, force, device: requestedDevice, avd, installs, appId, fresh,
    guardedApp, guardStrict, bitRate, size, segmentSeconds, doTighten,
  } = args;
  const flowPath = resolve(flowArg);
  const outName = name ?? `${basename(flowPath, extname(flowPath))}-android`;
  const outPath = join(outDir, `${outName}.mp4`);
  const tightPath = join(outDir, `${outName}-tight.mp4`);
  const sidecarPath = join(outDir, `${outName}.json`);

  let tools;
  try {
    tools = await preflight(flowPath, [outPath, sidecarPath, ...(doTighten ? [tightPath] : [])], force);
  } catch (err) {
    console.error(`[film-android] preflight failed: ${err.message}`);
    process.exit(1);
  }
  const { adb, maestro, ffmpeg } = tools;

  await mkdir(outDir, { recursive: true });

  let deviceId;
  let nativeSize = null;
  let guardPreflight = null;
  try {
    deviceId = await ensureDevice(adb, requestedDevice, avd ?? process.env.FILMKIT_ANDROID_AVD);
    nativeSize = await deviceNativeSize(adb, deviceId);
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

  // Foreground preflight. A WARNING, never a refusal: the flow's own `launchApp` is entitled to
  // bring the app forward a second from now, and a run that fails here would fail every flow
  // written the ordinary way. What it buys is that take 3 in FEEDBACK #10 — rolled with a
  // neighbour already in front — would have said so before burning the wall clock.
  if (guardedApp) {
    const before = await readForeground(adb, deviceId);
    guardPreflight = { package: before.package, activity: before.activity ?? null, note: before.note ?? null };
    if (before.verdict === 'unknown') {
      console.error(`[foreground] could not read the foreground before rolling (${before.note}) — guarding anyway.`);
    } else if (before.package === guardedApp) {
      log(`[foreground] ${guardedApp} is in front — guarding it every ${(FOREGROUND_POLL_MS / 1000).toFixed(1)}s.`);
    } else {
      console.error(
        `[foreground] ⚠️  ${guardedApp} is NOT in front — ${before.package}/${before.activity} is.\n` +
          "[foreground]    If the flow starts with `launchApp` this fixes itself; if it does not, the take " +
          'opens on the wrong app.\n' +
          `[foreground]    Rolling anyway. Foreground the app yourself (\`adb -s ${deviceId} shell am start ...\`) ` +
          'to be sure.',
      );
    }
  }

  // From here on, a recorder process may exist on the device — every exit path below goes
  // through harvest(), whether the flow succeeds, throws, or is interrupted.
  const deviceBase = `filmkit-${outName.replace(/[^A-Za-z0-9._-]/g, '_')}`;
  await run(adb, ['-s', deviceId, 'shell', `rm -f ${DEVICE_DIR}/${deviceBase}-seg*.mp4`]).catch(() => {}); // stale segments from a crashed run
  log(
    `starting screen recording${size ? ` at ${size}` : ` at native resolution${nativeSize ? ` (${nativeSize})` : ''}`}` +
      `, ${segmentSeconds}s per segment...`,
  );
  const recordingStartedAt = Date.now();
  const chain = startSegmentChain(adb, deviceId, { deviceBase, bitRate, size, segmentSeconds });
  const segments = chain.segments;

  let maestroChild = null; // held so --guard-strict can cut the flow short
  let abortedByGuard = null;
  const guard = guardedApp
    ? startForegroundWatch(adb, deviceId, {
        guardedApp,
        startedAt: recordingStartedAt,
        onInterloper: (event) => {
          if (!guardStrict || abortedByGuard) return;
          abortedByGuard = event;
          console.error(
            `[foreground] --guard-strict: stopping the flow now. What was filmed up to ${event.atSec}s is ` +
              'still pulled, stitched and saved.',
          );
          if (!maestroChild) return;
          maestroChild.kill('SIGINT');
          const escalate = setTimeout(() => {
            console.error(`[foreground] the flow ignored SIGINT for ${MAESTRO_ABORT_GRACE_MS / 1000}s — killing it.`);
            maestroChild?.kill('SIGKILL');
          }, MAESTRO_ABORT_GRACE_MS);
          escalate.unref?.();
        },
      })
    : null;

  let maestroError = null;
  let interrupted = false;
  let harvestPromise = null;
  let lossReason = null; // segments that arrived unusable — the pull-side twin of chain.abortReason
  const tempFiles = []; // local `.<name>.segNNN.mp4` copies; kept, and named, whenever anything went wrong
  const deviceLeftovers = []; // on-device segment files deliberately not deleted

  const wallTotalSec = () => segments.reduce((sum, seg) => sum + (seg.wallSec ?? 0), 0);
  const truncationReason = () => [chain.abortReason, lossReason].filter(Boolean).join('; ') || null;
  const interloped = () => (guard?.interlopers.length ?? 0) > 0;
  const interloperReason = () => {
    if (!interloped()) return null;
    const seen = guard.interlopers.map((e) => `${e.package} at ${e.atSec}s`).join(', ');
    return (
      `another app was in front of ${guardedApp} while the camera rolled (${seen})` +
      (abortedByGuard ? ' — the flow was cut short by --guard-strict' : '')
    );
  };

  const writeSidecar = async ({ status, error = null, finalProbe = null, stitch = null, tightResult = null }) => {
    const payload = {
      tool: 'film-android.mjs',
      status, // ok | truncated | interloper | flow-failed | interrupted | failed
      error,
      filmedAt: new Date().toISOString(),
      argv: process.argv.slice(2),
      flow: { path: flowPath, sha256: await sha256(flowPath).catch(() => null) },
      device: { serial: deviceId, nativeSize, fingerprint: await deviceFingerprint(adb, deviceId) },
      recording: {
        requestedSize: size ?? null,
        actualSize: finalProbe?.size ?? null,
        bitRate,
        segmentSeconds,
        segmentCount: segments.length,
        seamCount: Math.max(0, segments.length - 1),
        wallSec: Number(wallTotalSec().toFixed(3)),
        truncated: Boolean(truncationReason()) || status === 'interrupted',
        truncationReason: truncationReason(),
        stitch,
        segments: segments.map((seg) => ({
          index: seg.index,
          wallSec: seg.wallSec === null ? null : Number(seg.wallSec.toFixed(3)),
          containerSec: seg.containerSec ?? null,
          packetCount: seg.packetCount ?? null,
          // where the segment's last picture sits, and how much of the stitched timeline it was
          // given (null on the final segment — it just plays out to its own end)
          contentEndSec: seg.contentEndSec === undefined || seg.contentEndSec === null ? null : Number(seg.contentEndSec.toFixed(3)),
          timelineSec: seg.timelineSec === undefined ? null : Number(seg.timelineSec.toFixed(3)),
          exitCode: seg.exitCode,
          signal: seg.signal,
          dropped: Boolean(seg.dropError),
          dropReason: seg.dropError ?? null,
          stderr: seg.stderr,
        })),
      },
      // Who owned the screen, and what the guard made of it. `foreground` is one row per CHANGE,
      // timestamped from the moment the recorder started, so it lines up with the video itself.
      foreground: guard ? guard.events : null,
      guard: guard
        ? {
            app: guardedApp,
            strict: guardStrict,
            pollSec: FOREGROUND_POLL_MS / 1000,
            allowlist: FOREGROUND_ALLOW.map(String),
            preflight: guardPreflight,
            changeCount: guard.events.length,
            interlopers: guard.interlopers,
            clean: !interloped(),
            abortedAtSec: abortedByGuard?.atSec ?? null,
          }
        : null,
      output: { path: outPath, durationSec: finalProbe?.durationSec ?? null },
      tight: tightResult ?? null,
      flowSucceeded: !maestroError,
      keptFiles: { local: [...tempFiles], device: deviceLeftovers.map((p) => `${deviceId}:${p}`) },
    };
    await writeFile(sidecarPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    log(`provenance written: ${sidecarPath}`);
  };

  const writeSidecarSafely = (fields) =>
    writeSidecar(fields).catch((err) => console.error(`[film-android] sidecar failed: ${err.message}`));

  // Whatever is on disk when a run goes wrong has to be findable. These names are dot-prefixed
  // so a bare `ls` hides them, which is exactly how a failed take looks like a lost one.
  const reportKeptFiles = () => {
    if (tempFiles.length === 0 && deviceLeftovers.length === 0) return;
    console.error('[film-android] nothing was deleted — the raw segments are still here:');
    for (const path of tempFiles) console.error(`[film-android]   ${path}`);
    for (const path of deviceLeftovers) console.error(`[film-android]   ${deviceId}:${path}  (still on the device)`);
    console.error(
      '[film-android]   (dot-prefixed, so `ls` hides them — use `ls -a`. They are ordinary mp4s: ' +
        'play them, or stitch them by hand with ffmpeg\'s concat demuxer.)',
    );
  };

  // ── RECORD_STOP → PULL → STITCH, run exactly once from whichever path gets here first ───────
  // The live INTERLOPER line is printed from under `maestro test`, which inherits this process's
  // stdio and redraws its progress with ANSI escapes — so it can be scribbled over. This block
  // runs after the flow is done and nothing else is drawing, and it is the channel that is
  // actually guaranteed to be readable.
  const reportForeground = () => {
    if (!guard) return;
    if (!interloped()) {
      log(
        `[foreground] clean — ${guardedApp} held the foreground for the whole take` +
          (guard.events.length > 1 ? ` (${guard.events.length - 1} allowed system surface(s) seen)` : ''),
      );
      return;
    }
    console.error(`\n[film-android] ⚠️  THIS TAKE IS SUSPECT — ${interloperReason()}.`);
    for (const event of guard.interlopers) {
      console.error(`[film-android]    ${event.atSec}s  ${event.package}/${event.activity}`);
    }
    console.error(
      '[film-android]    A flow can report every step COMPLETED through this: being covered by another app ' +
        'satisfies\n' +
        '[film-android]    `notVisible`. Watch the take around those timestamps before you ship it, or re-film.\n',
    );
  };

  async function harvest() {
    try {
      // Stop watching before the pull — from here on nothing that happens on the device screen
      // is going into the take anyway, and a poll racing `adb pull` is just noise.
      await guard?.stop();
      log('stopping screen recording...');
      await chain.stop();
      log(
        `${segments.length} segment(s), ${wallTotalSec().toFixed(2)}s of wall-clock recording` +
          (segments.length > 1
            ? ` — ${segments.length - 1} seam(s) at ~${segmentSeconds}s intervals, a few hundred ms lost at each`
            : ''),
      );

      // PULL, then VALIDATE. One bad segment must never cost the others, so each is judged on
      // its own and the take is assembled from whatever passed (see selectSegments).
      const pulled = [];
      for (const seg of segments) {
        const localPath = join(outDir, `.${outName}.${seg.tag}.mp4`);
        try {
          log(`pulling ${seg.devicePath}...`);
          await run(adb, ['-s', deviceId, 'pull', seg.devicePath, localPath]);
          tempFiles.push(localPath);
          pulled.push({ seg, localPath, pullError: null });
        } catch (err) {
          pulled.push({ seg, localPath: null, pullError: `adb pull failed: ${err.message}` });
        }
      }

      const { usable, dropped, lost, lossReason: selectionLoss } = await selectSegments(ffmpeg, pulled);
      lossReason = selectionLoss;
      for (const drop of dropped) {
        deviceLeftovers.push(drop.seg.devicePath);
        if (drop.emptyTail) {
          log(
            `dropping ${drop.seg.tag}: ${drop.reason}. It was the last link in the chain and lived ` +
              `${(drop.seg.wallSec ?? 0).toFixed(2)}s, so nothing that was on screen is missing from the take.`,
          );
        } else {
          console.error(`[film-android] ⚠️  ${drop.seg.tag} is unusable: ${drop.reason}`);
        }
      }
      if (usable.length === 0) {
        throw new Error('no segment produced a usable file — there is nothing to stitch');
      }

      // STITCH / FINALIZE
      let stitch = null;
      if (usable.length === 1) {
        // Single-segment path — identical to what this tool did before chaining existed: pull one
        // file, remux with stream copy + faststart. No concat list, no timestamp rewriting.
        log(`finalizing ${outPath}...`);
        await finalizeVideo(ffmpeg, usable[0].localPath, outPath);
      } else {
        const listPath = join(outDir, `.${outName}.concat.txt`);
        const entries = usable.map(({ seg, localPath }, i) => {
          if (i === usable.length - 1) return { path: localPath, durationSec: null };
          // Wall time overstates the segment slightly (it includes adb's own spawn), so clamp it to
          // the time limit; a segment that died early keeps its own shorter wall time instead.
          const occupied = Math.min(seg.wallSec ?? segmentSeconds, segmentSeconds);
          if (seg.contentEndSec === null && seg.containerSec !== null) {
            log(
              `${seg.tag}: no packet-level content end — falling back to its ${seg.containerSec.toFixed(2)}s ` +
                'container duration, which OVER-declares on VFR footage rather than clamping, so this seam may ' +
                'hold a frame longer than it should',
            );
          }
          seg.timelineSec = Math.max(seg.contentEndSec ?? seg.containerSec ?? 0, occupied);
          return { path: localPath, durationSec: seg.timelineSec };
        });
        await writeFile(listPath, concatListBody(entries), 'utf8');
        log(`stitching ${usable.length} segments into ${outPath}...`);
        const diagnostics = await stitchSegments(ffmpeg, listPath, outPath);
        await rm(listPath, { force: true });
        const tail = usable[usable.length - 1].seg;
        const directivesSec = entries.reduce((sum, entry) => sum + (entry.durationSec ?? 0), 0);
        stitch = {
          plannedSec: Number((directivesSec + (tail.contentEndSec ?? tail.containerSec ?? 0)).toFixed(3)),
          plannedMaxSec: Number((directivesSec + (tail.containerSec ?? tail.contentEndSec ?? 0)).toFixed(3)),
          actualSec: null,
          driftSec: null,
          nonMonotonicDtsWarnings: diagnostics.nonMonotonicDts,
          reencoded: diagnostics.reencoded,
          ok: null,
        };
      }

      const finalProbe = await probeVideo(ffmpeg, outPath);

      // The stitch is only believable if the file agrees with the timeline the directives asked
      // for. ffmpeg reports a scrambled concat as a warning and exits 0, so nothing else here
      // would catch it.
      if (stitch) {
        const assessed = assessStitch(stitch, finalProbe);
        stitch = assessed.stitch;
        for (const warning of assessed.warnings) {
          console.error(`\n[film-android] ${warning.split('\n').join('\n[film-android] ')}\n`);
        }
      }

      // RESOLUTION check (see the SIZE header).
      const requestedSize = size ?? nativeSize;
      if (requestedSize && finalProbe.size && finalProbe.size !== requestedSize) {
        const [rw, rh] = requestedSize.split('x');
        const swapped = `${rh}x${rw}`; // a rotated recording is not a mismatch
        if (finalProbe.size !== swapped) {
          console.error(
            `\n[film-android] ⚠️  RESOLUTION MISMATCH: recorded at ${finalProbe.size}, but ` +
              `${size ? `--size ${size} was requested` : `the device reports ${nativeSize}`}.\n` +
              "[film-android]    screenrecord's encoder almost certainly refused that geometry and " +
              'silently fell back (look for an "unable to configure video/avc codec" line above).\n' +
              `[film-android]    Re-film with an explicit --size the encoder accepts if this take has ` +
              'to intercut with others.\n',
          );
        }
      }

      // CLEANUP is conditional: a clean run leaves nothing behind, an unclean one leaves
      // everything behind and says where. Deleting the evidence of a bad take is the one
      // unrecoverable move available here.
      const clean = lost.length === 0 && !interrupted && (stitch === null || stitch.ok);
      if (clean) {
        // Every local temp, not just the ones that made the cut — an empty trailing segment left
        // behind as a hidden `.name.segNNN.mp4` is the exact confusion this is meant to avoid.
        for (const path of tempFiles) await rm(path, { force: true });
        for (const seg of segments) {
          await run(adb, ['-s', deviceId, 'shell', 'rm', seg.devicePath]).catch(() => {}); // best-effort
        }
        tempFiles.length = 0;
        deviceLeftovers.length = 0;
      } else {
        reportKeptFiles();
      }

      return { ok: true, finalProbe, stitch };
    } catch (err) {
      console.error(`[film-android] failed to save the recording: ${err.message}`);
      reportKeptFiles();
      await writeSidecarSafely({ status: 'failed', error: err.message });
      return { ok: false, finalProbe: null, stitch: null, error: err.message };
    }
  }

  const runHarvest = () => (harvestPromise ??= harvest());

  // Without this handler Node's default SIGINT disposition kills the process on the spot: the
  // on-device recorder keeps running, the segments are never pulled, and the take is gone. With
  // it, Ctrl-C is just another way to reach harvest() — stop, pull, stitch, sidecar — and exit
  // non-zero (130, the shell's convention for it).
  process.on('SIGINT', () => {
    if (interrupted) {
      console.error('[film-android] still saving what was filmed — a second Ctrl-C will not make it faster.');
      return;
    }
    interrupted = true;
    console.error('\n[film-android] SIGINT — stopping the recorder and saving what was filmed so far...');
    runHarvest()
      .then(async (outcome) => {
        reportForeground(); // an interloper may well be WHY the operator hit Ctrl-C
        if (outcome.ok) {
          await writeSidecarSafely({
            status: 'interrupted',
            error: 'interrupted by SIGINT',
            finalProbe: outcome.finalProbe,
            stitch: outcome.stitch,
          });
          console.error(`[film-android] interrupted — what was filmed is in ${outPath}.`);
        }
      })
      .catch((err) => console.error(`[film-android] could not save the interrupted take: ${err.message}`))
      .finally(() => process.exit(130));
  });

  await sleep(RECORD_WARMUP_MS);

  try {
    log(`running maestro test ${flowPath}...`);
    // Run from the CALLER's working directory so relative paths inside the flow yaml (screenshots,
    // uploaded files, subflows) resolve against the user's project, not this repo.
    // Spawned here rather than through run() because --guard-strict needs the child itself: the
    // `maestro` launcher ends in `exec java`, so this pid IS the JVM and a SIGINT lands on it.
    // Same stdio and the same error shape run() produces, so nothing downstream can tell.
    const argsList = ['--device', deviceId, 'test', flowPath];
    await new Promise((resolveFlow, rejectFlow) => {
      maestroChild = spawn(maestro, argsList, { stdio: 'inherit' });
      maestroChild.on('error', (err) =>
        rejectFlow(new Error(`failed to run \`${maestro} ${argsList.join(' ')}\`: ${err.message}`)),
      );
      maestroChild.on('exit', (code, signal) => {
        if (signal) return rejectFlow(new Error(`\`${maestro} ${argsList.join(' ')}\` was killed by ${signal}`));
        if (code !== 0) return rejectFlow(new Error(`\`${maestro} ${argsList.join(' ')}\` exited with code ${code}`));
        resolveFlow();
      });
    });
  } catch (err) {
    maestroError = err;
  } finally {
    maestroChild = null;
  }

  const outcome = await runHarvest();
  if (interrupted) return; // the SIGINT handler owns the sidecar and the exit code
  reportForeground();
  if (!outcome.ok) process.exit(1); // harvest already reported and wrote the sidecar

  if (maestroError) {
    // An interloper outranks a flow failure as the diagnosis, because in --guard-strict it CAUSED
    // it — the flow "failed" only in the sense that the guard shot it. Both reasons are kept.
    await writeSidecarSafely({
      status: interloped() ? 'interloper' : 'flow-failed',
      error: [interloperReason(), maestroError.message].filter(Boolean).join('; '),
      finalProbe: outcome.finalProbe,
      stitch: outcome.stitch,
    });
    if (abortedByGuard) {
      console.error(`\n[film-android] the flow was stopped by --guard-strict, not by its own steps.`);
    } else {
      console.error(`\n[film-android] maestro flow "${outName}" failed: ${maestroError.message}`);
    }
    console.error(`[film-android] the partial recording was still saved to ${outPath} for debugging.`);
    process.exit(1);
  }

  console.log(
    `\n[film-android] Demo video written: ${outPath}` +
      (outcome.finalProbe.durationSec === null ? '' : ` (${outcome.finalProbe.durationSec.toFixed(2)}s)`),
  );

  let tightResult = null;
  if (doTighten && interloped()) {
    // The same rule as a failed flow: a suspect take is not a deliverable, and writing a polished
    // `-tight.mp4` beside it is precisely how #10's dead take looked finished. The raw file is
    // kept, and tighten has its own CLI if the footage turns out to be usable after all.
    console.error(
      `[film-android] --tighten skipped — this take is suspect. If it is usable after all: ` +
        `node tighten.mjs ${outPath}`,
    );
  } else if (doTighten) {
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
        // tighten() reports the seconds it PLANNED to keep. What the sidecar has to record is
        // what the encoder actually wrote, so probe the file; the plan is kept beside it.
        const tightProbe = await probeVideo(ffmpeg, result.outPath);
        tightResult = {
          path: result.outPath,
          durationSec: tightProbe.durationSec ?? null,
          plannedDurationSec: Number(result.outDuration.toFixed(3)),
          cuts: result.cuts,
          removedSec: Number(result.removedSec.toFixed(3)),
        };
      }
    } catch (err) {
      console.error(`[film-android] --tighten skipped — ${err.message}`);
    }
  }

  const incomplete = truncationReason();
  const covered = interloperReason();
  await writeSidecarSafely({
    // "Something else was on screen" is a worse diagnosis than "some of the screen is missing",
    // and it is the one the operator has to act on, so it wins the single `status` slot.
    status: covered ? 'interloper' : incomplete ? 'truncated' : 'ok',
    error: [covered, incomplete].filter(Boolean).join('; ') || null,
    finalProbe: outcome.finalProbe,
    stitch: outcome.stitch,
    tightResult,
  });

  if (incomplete) {
    console.error(
      `\n[film-android] the recording is INCOMPLETE — ${incomplete}.\n` +
        `[film-android] what was filmed is in ${outPath}.`,
    );
  }
  // The last line of a run is the one that gets read, and on this path it would otherwise be
  // "Demo video written" — which is the exact sentence #10 got, and believed.
  if (covered) {
    console.error(
      `\n[film-android] the flow passed and the take did NOT — ${covered}.\n` +
        `[film-android] status "interloper" in ${sidecarPath}; the footage is in ${outPath} if you want it.`,
    );
  }
  // Non-zero on an interloper is the whole point: the flow passed, and the take still is not one.
  if (covered || incomplete) process.exit(1);
}

// Only film when this file is executed directly. The validation and stitch helpers above are
// exported so they can be exercised against synthetic segments without a device attached, and an
// `import` of them must not start a camera — the same guard tighten.mjs uses for the same reason.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
