// ─────────────────────────────────────────────────────────────────────────────
// lib/tap-overlay.mjs — where the taps happened, and how to draw them. iOS and Android.
//
// Neither platform will draw the finger for you. The iOS Simulator has no touch-indicator
// setting at all; Android HAS one (`settings put system show_touches 1`) and it is useless here,
// because Maestro's Android driver injects through UiAutomation rather than /dev/input and the
// pointer-spot overlay only draws what came off the input device. Verified twice on a Pixel 9
// Pro XL emulator (API 36): show_touches on, taps injected, nothing drawn. So on BOTH platforms
// the taps are recovered AFTER the fact — from the logs Maestro writes under `--debug-output` —
// and a ripple is burned into the recording with ffmpeg. Two halves, both here:
//
//   parseMaestroTaps({ debugDir })  →  every touch that landed, in wall-clock ms
//   burnTapRipples({ ... })         →  a new .mp4 with a ring drawn at each one
//
// The platform is read off maestro.log's own `DeviceInfo(platform=…)` line, so one call site
// works for either camera; what differs is only WHICH log is believed, below.
//
// WHERE THE TAP TIMES COME FROM ON IOS (measured on Maestro 2.6.0 / Xcode 26.6, iPhone 17 Pro sim)
//
// Two logs under the debug dir carry tap coordinates, and they do NOT agree on WHEN:
//
//   maestro.log        `13:54:14.460 [ INFO] ... Try tapping at (80, 319) using hierarchy ...`
//   xctest_runner_*.log `2026-09-03 13:54:14.649426-0400 ... Tapping 80.0, 319.0`
//
// maestro.log is the host-side intent — it is logged before the tap is sent over the wire to
// the on-device driver. Measured lead over the xctest line across 9 taps in 2 runs: 130, 133,
// 189, 211, 214, 217, 221, 222, 300 ms — a 170 ms spread, too sloppy to draw with. The xctest
// line is the driver logging the touch as it synthesises it, and a web page under test that
// stamped its own `touchstart` recorded 14:13:55.921 against an xctest line of 14:13:55.914 —
// 7 ms apart. So the xctest_runner log is the anchor; maestro.log is only a fallback, and it
// carries a documented constant correction plus a warning, because a ring 200 ms early reads as
// a ring on the wrong thing.
//
// maestro.log is still parsed for one thing it alone knows: the device geometry line
// `DeviceInfo(platform=IOS, widthPixels=1206, heightPixels=2622, widthGrid=402, heightGrid=874)`.
// Tap coordinates are in the GRID (iOS points); the recording is widthPixels × heightPixels.
// scale = widthPixels / widthGrid (3 on every current iPhone) converts one to the other.
//
// WHAT COUNTS AS A TAP. Every touch the driver actually synthesised, not every command in the
// flow: `doubleTapOn` logs two `Tapping` lines ~350 ms apart and gets two ripples, because two
// touches is what the screen saw. `longPressOn` logs `Long pressing 313.0, 279.0 for 3.0s` and
// gets a ring that sits still for the hold and then breaks into the ripple on release. Swipes
// log `[SwipeRouteHandlerV2] Swipe (v2) from (...) to (...)` and are deliberately NOT drawn —
// a ripple at one end of a drag is a lie about the gesture. (See DEVIATIONS in film-ios.mjs.)
//
// WHERE THE TAP TIMES COME FROM ON ANDROID (measured on Maestro 2.6.0, Pixel 9 Pro XL emulator,
// API 36, 1344×2992). There is no second log: the Android driver is an instrumentation app that
// logs nothing per gesture (checked: `logcat` during a tap carries UiDevice's idle polling and
// nothing else), so maestro.log is the whole story and its lead over the real touch has to be
// carried as a constant rather than measured out by a driver log.
//
//   maestro.log  `13:55:23.006 [ INFO] maestro.Maestro.hierarchyBasedTap-…: Tapping at (488, 817)
//                 using hierarchy based logic for wait`
//
// Same line as iOS's minus the "Try", same clock, and the coordinates are DEVICE PIXELS here
// (widthGrid == widthPixels on Android, so scale is 1 and `xPt` is already a pixel).
//
// The lead was measured against a page in the emulator's Chrome that flipped a white block on
// `touchstart`: the video's own frames say when the touch landed, and a 2 s calibration flash on
// the same page says what wall clock video time 0 is. Eight element taps over four runs led the
// touch by 47, 65, 88, 94, 97, 106, 163 and 196 ms (median 96), and the measurement itself is
// biased ~1 frame late by paint and capture, so ANDROID_MAESTRO_LOG_TAP_LEAD_MS is 90.
//
// KNOWN SLOP, and it is worth knowing which taps have it. The lead is one view-hierarchy fetch:
// `hierarchyBasedTap` logs the line, fetches the hierarchy to compare against afterwards, and
// only then taps. After a `tapOn: <selector>` that fetch is warm — hence the 47–196 ms above.
// After a `tapOn: point:` nothing warmed it, and in an app with an expensive hierarchy the same
// four measurements came back 403, 409, 497 and 797 ms (Chrome, a deliberately awful case). A
// coordinate tap in a heavy app can therefore draw its ring up to ~0.4 s early. Nothing in the
// logs distinguishes a cheap fetch from an expensive one, so this is documented rather than
// corrected; text selectors — which every filmkit example flow uses — do not have the problem.
//
// WHAT COUNTS AS A TAP ON ANDROID. The log line is the same for a tap, a double tap and a long
// press: one `Tapping at (x, y)` and no mention of hold or repeat. The gesture is recovered from
// the OTHER thing `--debug-output` writes, `commands-<flow>.json`, which records every command
// Maestro ran with its host-clock `timestamp` and `duration`: the tap line that falls inside a
// command's window inherits that command's `longPress` and `repeat`. So `doubleTapOn` gets its
// two ripples (`repeat: {repeat: 2, delay: 100}`, the second placed a measured tap-down later)
// and `longPressOn` gets the held ring, exactly as on iOS. The hold is 3.0 s — the page's own
// pointer events put the driver's down at 15:22:32.603 and its up at 15:22:35.601, the same 3.0 s
// the iOS driver prints in its own log. `swipe` logs no coordinates at
// all on Android (only `Swipe from (50%, 55%) to (50%, 35%)`), so it cannot produce a stray ring
// here even by accident — which happens to match the deliberate iOS policy of not drawing them.
//
// THE RIPPLE. Amber ring, 44 pt across, growing to 2× and fading out over 450 ms, with a dark
// halo hugging it on both sides. Amber #FFAD1A with a 26% fill is the same mark lib/cursor-
// overlay.mjs paints for web clicks, so a storyboard that cuts between web and iOS keeps one
// visual language; the dark halo is what makes it survive both a white Settings list and a
// black video player, neither of which a flat colour reads against on its own.
//
// ENCODE QUALITY AND QUIET FFMPEG (FEEDBACK #25, #12). The burn is a re-encode, and its quality
// policy is lib/encode.mjs's: the software fallback runs at CRF `DEFAULT_CRF` (18, was 20;
// `style.crf` overrides), the VideoToolbox path stays average-bitrate at a target that is never
// below the source's own — see the RATE CONTROL note above encode() for the measurements. Every
// ffmpeg this file spawns carries `-hide_banner -loglevel error`, except the `-version` capture
// whose banner is the point. They run through lib/run.mjs, the abortable runner tighten.mjs uses
// too (SIGTERM, SIGKILL after 2s, settle only once the child is gone), via the thin runFfmpeg here.
//
// MAESTRO STARTUP UNAVAILABLE (FEEDBACK #27). `maestroStartupUnavailable({ debugDir, outputText })`
// is the predicate a camera consults after a failed `maestro test` to decide on ONE retry inside
// the same take: a known startup-failure signature (Android: gRPC UNAVAILABLE, found in
// maestro.log; iOS: the XCTest driver's startup timeout, found only in maestro's own stderr, so
// film-ios passes it as `outputText`) AND no command in commands-*.json ever ran. See the block
// above the function for why both halves are required and where each signature lives. `readCommandRecords` and `locateLogs` are
// exported for the callers that read the command record themselves. `maestroCommandRan({debugDir})` answers
// the cameras' NOTHING FILMED question (did the run start any flow command?) from maestro.log's live
// `… RUNNING` lines, because commands-*.json is only written when the run ends.
//
// NEWEST RUN ONLY, EVERYWHERE. A debug dir can hold several runs (a startup retry starts another
// maestro, and a camera that does not move the failed attempt aside leaves both). `locateLogs`
// picks the run of the newest maestro.log, and `flowHasTapCommands`'s synchronous reader now does
// the same (it used to read every commands-*.json under the dir), so the command record a camera
// judges is always the latest attempt's.
//
// THE MISSING-TAP NOTE (`flowHasTapCommands`). The flow text names a tap but the record shows none
// running. Two different situations, two different messages. If the newest run did not reach its
// end — a FAILED command, a command still RUNNING or PENDING, or a maestro.log without maestro's
// closing `deleteOldFiles` line (maestro was killed) — the flow simply stopped before any tap, no
// ring is owed, and the message says so and names the reason; nothing needs fixing. Only when the
// flow ran to its end and still no tap was recognised does it suggest that this Maestro renamed its
// commands out from under TAP_COMMAND_KEY_RE (or that the tap sat behind a `when:` that never fired).
//
// A STOPPED MAESTRO'S COMMAND RECORD (Android gestures). Maestro writes commands-*.json as the flow ends, so a
// maestro that was stopped mid-flow leaves none, an EMPTY file, or one CUT OFF inside an entry (measured on
// interrupted takes: no file; 0 bytes; 15949 bytes ending mid-entry, which does not parse). Only a file that
// parses into records is a record (`describeCommandFiles`: records | empty | cut-off | no-records). When taps were
// logged but the record holds no finished tap command, parseMaestroTaps returns `commandRecordGap: { kind:
// missing | unreadable | no-tap, files, records }` and warns nothing: whether that is news depends on who stopped
// maestro, which only the camera knows (film-android's commandRecordGapLine says it as what happened when it
// stopped maestro, and warns otherwise). Measured before: the parser counted every file, so an empty or cut-off
// one reached the "no tap command in any commands-*.json (0 command(s) recorded)" warning on interrupted takes.

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DEFAULT_CRF, x264Args } from './encode.mjs';
import { makeAbortError, runAbortable } from './run.mjs';

// ── the regexes ────────────────────────────────────────────────────────────────────────────
// Tolerant about what surrounds them (the xctest runner interleaves writes from several
// threads, and lines arrive with other lines glued onto their front), strict about the numbers.

/** `2026-09-03 13:54:14.649426-0400` — absolute, with a UTC offset. */
const XCTEST_STAMP_RE = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\.(\d+)([+-]\d{2}):?(\d{2})/g;
/** `... Tapping 80.0, 319.0` at end of line. `Tapping took 0.43` cannot match: "took" is not a number. */
const XCTEST_TAP_RE = /\bTapping\s+(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
/** `... Long pressing 313.0, 279.0 for 3.0s` */
const XCTEST_LONGPRESS_RE = /\bLong\s+pressing\s+(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s+for\s+(\d+(?:\.\d+)?)\s*s\b/;
/**
 * `13:54:14.460 [ INFO] ... Try tapping at (80, 319) using hierarchy based logic for wait` (iOS,
 * via `screenshotBasedTap`) and `13:55:23.006 … Tapping at (488, 817) using hierarchy based logic
 * for wait` (Android, via `hierarchyBasedTap`). Anchored on `at (` so the neighbouring
 * `Tapping on element:  UiElement(…bounds=[240,777][736,858]…)` line cannot match.
 */
const MAESTRO_TAP_RE = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})\b.*?\b(?:Try t|T)apping at \(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/;
/** `Got device info: DeviceInfo(platform=IOS, widthPixels=1206, heightPixels=2622, widthGrid=402, heightGrid=874)` */
const DEVICE_INFO_RE =
  /DeviceInfo\([^)]*?widthPixels=(\d+)[^)]*?heightPixels=(\d+)[^)]*?widthGrid=(\d+)[^)]*?heightGrid=(\d+)/;
/** …the same line's first field, which is what says whose log this is. */
const DEVICE_PLATFORM_RE = /DeviceInfo\(\s*platform=([A-Za-z]+)/;

// maestro.log stamps have no date and no zone. Measured lead of that line over the real touch:
// median 215 ms across 9 taps (range 130–300). Only used when the xctest runner log is missing.
export const MAESTRO_LOG_TAP_LEAD_MS = 215;
// The Android equivalent, and there it is not a fallback — it is the only clock there is. Median
// 96 ms over 8 element taps (47–196), less ~1 frame of measurement bias. See the header.
export const ANDROID_MAESTRO_LOG_TAP_LEAD_MS = 90;
// How long Maestro's Android driver holds the pointer down for `longPressOn`. Measured on the
// page's own pointer events: down 15:22:32.603, up 15:22:35.601 — 2.998 s.
export const ANDROID_LONG_PRESS_SEC = 3;
// A repeated tap (`doubleTapOn`) logs ONE line and one time, so the second ripple is placed by
// arithmetic: the command's own `delay` (100 ms by default) plus how long a tap holds the pointer
// down before that delay starts. Measured down-to-up on four injected taps: 110, 113, 115 and
// 161 ms. Down-to-down for the pair came out 214 ms once and 399 ms once — the driver is not
// metronomic about it, so the second ring is placed at the low end of that, where being early
// costs a ripple that has not finished growing rather than one drawn after the app has moved on.
export const ANDROID_TAP_DOWN_MS = 120;
// Command records whose status means the command actually ran. Maestro also writes PENDING and
// SKIPPED (a command behind a `when:` that never fired) and FAILED (a selector that never
// matched, so nothing was touched) — none of those put a finger on the screen.
const RAN_STATUSES = new Set(['COMPLETED', 'WARNED']);
/** `tapOnElement`, `tapOnPoint`, `tapOnPointV2`, `longPressOnElement`, … — every key that touches. */
const TAP_COMMAND_KEY_RE = /(?:^|[^a-z])(?:tapOn|longPress)/i;

const rippleDefaults = {
  fps: 60, // the burned video's frame rate; see burnTapRipples for why it must be constant
  durationSec: 0.45,
  radiusPt: 22, // 44 pt across at t=0
  growth: 2, // …expanding to 88 pt
  ringPt: 2, // stroke width
  ring: [255, 173, 26], // #FFAD1A — lib/cursor-overlay.mjs's click ring
  halo: [10, 12, 20], // the dark edge that keeps it legible on a white UI
  fillAlpha: 0.26,
  codec: 'h264', // matched to film-ios.mjs's --codec so a take does not change format here
  // VideoToolbox is rate-controlled by BITRATE, not quality (see the encode() comment in
  // burnTapRipples). film-android passes its recorder's own --bit-rate here, so the burn's target
  // is the source's own cap; film-ios uses this default.
  videoBitrate: '12M',
  // The software fallback's quality, from the one shared policy (lib/encode.mjs).
  crf: DEFAULT_CRF,
};

// ── PARSE ───────────────────────────────────────────────────────────────────────────────────

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * Maestro lays `--debug-output <dir>` out as `<dir>/.maestro/tests/<YYYY-MM-DD_HHmmss>/…`, but
 * that path is Maestro's business and has changed before, so find the logs rather than assume
 * them. If a debug dir somehow holds more than one run, the NEWEST maestro.log wins and only
 * its sibling xctest logs are read — taps from a previous take must never leak into this one.
 */
export async function locateLogs(debugDir) {
  const files = await walk(debugDir);
  const maestroLogs = files.filter((f) => /(^|\/)maestro\.log$/.test(f));
  if (maestroLogs.length === 0) return { testDir: null, maestroLog: null, xctestLogs: [], commandLogs: [] };
  let newest = null;
  for (const f of maestroLogs) {
    const s = await stat(f);
    if (!newest || s.mtimeMs > newest.mtimeMs) newest = { path: f, mtimeMs: s.mtimeMs };
  }
  const testDir = newest.path.replace(/\/maestro\.log$/, '');
  const xctestLogs = files.filter((f) => f.startsWith(`${testDir}/`) && /\/xctest_runner_[^/]*\.log$/.test(f)).sort();
  // `commands-(example-flow.yaml).json` — one per flow file the run executed, so a suite of
  // sub-flows writes several and all of them are part of this run.
  const commandLogs = files.filter((f) => f.startsWith(`${testDir}/`) && /\/commands-[^/]*\.json$/.test(f)).sort();
  return { testDir, maestroLog: newest.path, xctestLogs, commandLogs };
}

/** `{repeat: 2, delay: 100}`, a bare `2`, or `"2"` — all mean two touches. */
function readRepeat(raw) {
  const count = Number(typeof raw === 'object' && raw !== null ? raw.repeat : raw);
  const delay = Number(typeof raw === 'object' && raw !== null ? raw.delay : NaN);
  return {
    repeat: Number.isFinite(count) && count > 1 ? Math.floor(count) : 1,
    repeatDelayMs: Number.isFinite(delay) && delay >= 0 ? delay : 0,
  };
}

/**
 * Maestro's own record of what it ran: `[{ command: { <kind>: {...} }, metadata: { status,
 * timestamp, duration, sequenceNumber } }]`. `timestamp` is host epoch ms on the same clock as
 * maestro.log's stamps, which is what makes it usable as a window to place a tap line inside.
 * A file that will not parse is skipped, not fatal — it is a debugging spill, not a contract.
 */
export function readCommandRecords(texts) {
  const records = [];
  for (const text of texts) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed) {
      const kind = Object.keys(entry?.command ?? {})[0];
      const body = kind ? entry.command[kind] : null;
      const meta = entry?.metadata ?? {};
      if (!kind || !Number.isFinite(meta.timestamp)) continue;
      records.push({
        kind,
        status: meta.status ?? null,
        startedMs: meta.timestamp,
        endedMs: meta.timestamp + (Number.isFinite(meta.duration) ? meta.duration : 0),
        isTap: TAP_COMMAND_KEY_RE.test(kind),
        longPress: Boolean(body?.longPress),
        // `repeat` is `{repeat: 2, delay: 100}` on Maestro 2.6, but the flow yaml also accepts a
        // bare `repeat: 2`, and the record has serialised it both ways across versions.
        ...readRepeat(body?.repeat),
      });
    }
  }
  return records.sort((a, b) => a.startedMs - b.startedMs);
}

/**
 * The state of each command-record file, judged on its text: `records` (parses into at least one record),
 * `empty` (0 bytes or blank: what a maestro stopped before it wrote anything leaves), `cut-off` (does not
 * parse: a maestro stopped mid-write leaves the JSON ending inside an entry) or `no-records` (parses, but
 * holds no entry readCommandRecords can use). Only `records` files count as a command record.
 * @param {Array<{name:string,text:string}>} files
 * @returns {Array<{name:string,state:'records'|'empty'|'cut-off'|'no-records'}>}
 */
export function describeCommandFiles(files) {
  return files.map(({ name, text }) => {
    if (!String(text ?? '').trim()) return { name, state: 'empty' };
    try {
      JSON.parse(text);
    } catch {
      return { name, state: 'cut-off' };
    }
    return { name, state: readCommandRecords([text]).length > 0 ? 'records' : 'no-records' };
  });
}

// ── MAESTRO STARTUP UNAVAILABLE (FEEDBACK #27) ───────────────────────────────────────────────
// `maestro test` launched shortly after a `maestro hierarchy` can fail before it runs anything
// with `io.grpc.StatusRuntimeException: UNAVAILABLE` from `Orchestra.initJsEngine -> deviceInfo`
// (the on-device driver was not reachable yet). Nothing about the flow was wrong and a plain retry
// works, so a camera retries once inside the same take. This is the predicate that says WHEN.
//
// Both halves must hold, because UNAVAILABLE alone is not enough: the same exception can surface
// MID-flow when the driver dies after commands have already tapped the app, and re-running the
// flow then would tap it twice. So: the error signature, AND no command in commands-*.json that
// ever ran (PENDING and SKIPPED did not touch the device; COMPLETED, WARNED, FAILED, RUNNING did).
//
// THE SIGNATURE IS READ FROM maestro.log IN THE DEBUG DIR, not only from the child's stdout, and
// that is the point of doing it this way: `--debug-output` already puts the full exception there
// (verified on the real 9.8 s failed take from the 2026-09-11 session: line 19 of maestro.log is
// `io.grpc.StatusRuntimeException: UNAVAILABLE`, and no commands-*.json exists at all), so a
// camera that already passes --debug-output needs NO capture of maestro's output. `outputText` is
// accepted as an additional source for a camera that does capture it. Only the NEWEST run under
// the debug dir is read (locateLogs), so a retry that lands in the same dir is judged on its own
// log, never on the failed attempt's.
//
// CONSERVATIVE BY DESIGN: with no maestro.log under the debug dir there is nothing that proves no
// command ran, so `retry` is false even if `outputText` says UNAVAILABLE.
//
// THE iOS SIGNATURE (measured, Maestro 2.6.0, iOS 27 simulator). iOS has no gRPC: the driver is an
// XCTest runner that `LocalXCTestInstaller.start` launches and then polls over HTTP, and when it
// does not answer within MAESTRO_DRIVER_STARTUP_TIMEOUT (default 90 s) Maestro exits 1 printing
// `xcuitest.installer.LocalXCTestInstaller$IOSDriverTimeoutException: iOS driver not ready in time,
// consider increasing timeout by configuring MAESTRO_DRIVER_STARTUP_TIMEOUT env variable` to
// STDERR. It is NOT in maestro.log (that file only holds the polling: `xcTestDriverStatusCheck
// [Failed] ... ConnectException`, with no `Got device info` line and no commands-*.json), so an
// iOS camera must capture stderr and pass it as `outputText`; the log alone cannot prove it.
// Seen after a `maestro hierarchy` was SIGKILLed mid-flight and left its runner behind. The
// returned `unavailable` flag means "either signature" and keeps its name for the Android caller.
const UNAVAILABLE_RE = /StatusRuntimeException:\s*UNAVAILABLE\b|Not able to reach the gRPC server/;
const IOS_DRIVER_TIMEOUT_RE = /IOSDriverTimeoutException|iOS driver not ready in time/;
const signatureIn = (text) => (UNAVAILABLE_RE.test(text) ? 'gRPC UNAVAILABLE' : IOS_DRIVER_TIMEOUT_RE.test(text) ? 'iOS driver startup timeout' : null);
// Statuses that mean the command never touched the device.
const NOT_RUN_STATUSES = new Set(['PENDING', 'SKIPPED']);

/**
 * @param {object} o
 * @param {string} o.debugDir what was passed to `maestro test --debug-output`
 * @param {string} [o.outputText] maestro's captured stdout+stderr, if the caller has it (ANSI is
 *   fine, the signature contains none)
 * @returns {Promise<{retry:boolean, unavailable:boolean, source:'maestro.log'|'output'|null,
 *   commandsRan:number|null, reason:string}>}
 *   `retry` is the answer; the rest is for the log line. `commandsRan` is null when no run was
 *   found under the debug dir.
 */
/**
 * Did the newest maestro run under `debugDir` START any flow command? The cameras ask this when a signal
 * arrives, to tell "nothing was filmed" (the flow never began: no take, no sidecar) from an interrupted
 * take. maestro.log is the live source: Maestro's command runner logs `<command description> RUNNING` the
 * moment each command starts (`maestro.cli.runner.MaestroCommandRunner.runCommands…: Launch app "…"
 * RUNNING`), while commands-*.json is written only when the run ends (measured: absent for the whole 17s
 * of an example-flow run, present after). The JSON is still read, for a run that has ended. The internal
 * "Define variables" / "Apply configuration" steps log no RUNNING line and do not count. No maestro.log
 * (maestro not spawned yet, or still starting its JVM) is false.
 */
export async function maestroCommandRan(debugDir) {
  const { maestroLog, commandLogs } = await locateLogs(debugDir);
  if (maestroLog) {
    const text = await readFile(maestroLog, 'utf8').catch(() => '');
    if (/MaestroCommandRunner\.runCommands\S*: .* RUNNING\s*$/m.test(text)) return true;
  }
  for (const path of commandLogs) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return true; // cannot be shown otherwise, and "ran" is the answer that keeps the take
    }
    if (!Array.isArray(parsed) || parsed.some((e) => !NOT_RUN_STATUSES.has(e?.metadata?.status))) return true;
  }
  return false;
}

export async function maestroStartupUnavailable({ debugDir, outputText = '' }) {
  const { testDir, maestroLog, commandLogs } = await locateLogs(debugDir);
  const logText = maestroLog ? await readFile(maestroLog, 'utf8').catch(() => '') : '';
  const fromLog = signatureIn(logText);
  const fromOutput = fromLog ? null : signatureIn(outputText);
  const signature = fromLog ?? fromOutput;
  const source = fromLog ? 'maestro.log' : fromOutput ? 'output' : null;
  if (!source) {
    return { retry: false, unavailable: false, source: null, commandsRan: null, reason: 'no known startup-failure signature in maestro.log or output' };
  }
  if (!testDir) {
    return { retry: false, unavailable: true, source, commandsRan: null, reason: `${signature}, but no maestro run under the debug dir, so "no command ran" cannot be shown` };
  }
  // Counted straight off the JSON rather than through readCommandRecords: that reader drops a
  // record with no timestamp (right for placing taps, wrong here, where an uncounted FAILED
  // command would read as "nothing ran"). A file that will not parse counts as one command that
  // ran, since it cannot be shown otherwise.
  let commandsRan = 0;
  for (const path of commandLogs) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      commandsRan += 1;
      continue;
    }
    if (!Array.isArray(parsed)) {
      commandsRan += 1;
      continue;
    }
    commandsRan += parsed.filter((e) => !NOT_RUN_STATUSES.has(e?.metadata?.status)).length;
  }
  return commandsRan === 0
    ? { retry: true, unavailable: true, source, commandsRan, reason: `${signature} before any command ran` }
    : { retry: false, unavailable: true, source, commandsRan, reason: `${signature}, but ${commandsRan} command(s) had already run` };
}

/**
 * Android: maestro.log is the only source, so every `Tapping at (x, y)` line is a touch, moved
 * forward by the measured lead. The gesture behind it — held? repeated? — comes from the command
 * record, whose window contains the line.
 */
function parseAndroidTaps({ maestroText, commandRecords, commandFiles, readableFiles, nearEpoch, warnings, notes }) {
  const commands = commandRecords.filter((c) => c.isTap && RAN_STATUSES.has(c.status));

  // Pass 1: every tap line, with the command whose window it sits inside. `endedMs` includes
  // everything the command did after the touch (Maestro then waits for the hierarchy to change,
  // often seconds), so the window is generous on the right and only needs slack on the left,
  // where the log line can precede the record's own timestamp by a millisecond of bookkeeping.
  const lines = [];
  for (const line of maestroText.split('\n')) {
    const m = MAESTRO_TAP_RE.exec(line);
    if (!m) continue;
    const loggedMs = hmsToEpoch({ h: Number(m[1]), m: Number(m[2]), s: Number(m[3]), ms: Number(m[4]) }, nearEpoch);
    lines.push({
      loggedMs,
      xPt: Number(m[5]),
      yPt: Number(m[6]),
      owner: commands.find((c) => loggedMs >= c.startedMs - 50 && loggedMs <= c.endedMs + 50) ?? null,
    });
  }
  if (lines.length === 0) return [];

  // An unmatched line is not just a missing hold: maestro.log's stamps and the JSON's epoch
  // timestamps are supposed to be the same clock, so a line that lands in no command's window
  // means either a Maestro that renamed its command kinds or two clocks that have drifted apart
  // — and in the second case the gestures would be attributed to the WRONG commands, which is
  // worse than not attributing them at all. A few unmatched lines are a warning; a majority is a
  // failure, because at that point nothing in the correlation can be believed.
  const unmatched = lines.filter((l) => l.owner === null).length;
  if (commands.length === 0) {
    // No finished tap command in the record, so every touch is a plain ripple (a long press cannot be told
    // from a tap). WHY decides whether that is news, and the record alone cannot say it: a maestro this
    // process STOPPED leaves its commands-*.json empty (0 bytes) or cut off mid-write (measured on two
    // interrupted takes: 0 bytes, and 15949 bytes ending inside an entry), which is expected, while one that
    // ended on its own and still shows no tap is not. Only the camera knows who stopped maestro, so this is
    // a description (`commandRecordGap`), never a warning; film-android words it. `readableFiles` counts only
    // files that parsed into records: an empty or cut-off file is no record at all (measured before: such a
    // take warned "no tap command in any commands-*.json (0 command(s) recorded)").
    notes.commandRecordGap = {
      kind: commandFiles.length === 0 ? 'missing' : readableFiles === 0 ? 'unreadable' : 'no-tap',
      files: commandFiles,
      records: commandRecords.length,
    };
  } else if (unmatched > lines.length / 2) {
    throw new Error(
      `${unmatched} of ${lines.length} tap line(s) in maestro.log fall inside none of the ${commands.length} tap ` +
        "command window(s) in commands-*.json — the two are supposed to share a clock, so they have either drifted " +
        'apart or come from different runs, and every gesture would be attributed to the wrong command',
    );
  } else if (unmatched > 0) {
    warnings.push(
      `${unmatched} of ${lines.length} tap line(s) matched no command record and were drawn as plain ripples — ` +
        'a hold or a repeat on those would have been missed',
    );
  }

  // Pass 2: emit. How many touches one command made is answered by counting its OWN log lines
  // first — that is observation, where `repeat` is only an instruction. They agree on this
  // Maestro (`doubleTapOn` logs one line and declares repeat 2), but if a future version starts
  // logging both touches, counting lines keeps it at two ripples instead of doubling to four.
  const taps = [];
  for (const [i, line] of lines.entries()) {
    const { owner } = line;
    const siblings = owner === null ? 1 : lines.filter((l) => l.owner === owner).length;
    const isFirstOfCommand = owner === null || lines.findIndex((l) => l.owner === owner) === i;
    const synthesised = siblings === 1 && isFirstOfCommand ? Math.max(1, owner?.repeat ?? 1) : 1;
    const holdSec = owner?.longPress ? ANDROID_LONG_PRESS_SEC : 0;
    for (let n = 0; n < synthesised; n++) {
      taps.push({
        xPt: line.xPt,
        yPt: line.yPt,
        wallMs: line.loggedMs + ANDROID_MAESTRO_LOG_TAP_LEAD_MS + n * ((owner?.repeatDelayMs ?? 0) + ANDROID_TAP_DOWN_MS),
        kind: holdSec > 0 ? 'longPress' : 'tap',
        holdSec,
      });
    }
  }
  return taps;
}

/** `2026-09-03 13:54:14.649426-0400` → epoch ms. Fractions longer than ms are truncated. */
function xctestStampToEpoch(m) {
  const [, y, mo, d, h, mi, s, frac, offH, offM] = m;
  const ms = Number(`${frac}000`.slice(0, 3));
  const sign = offH.startsWith('-') ? -1 : 1;
  const offsetMin = sign * (Math.abs(Number(offH)) * 60 + Number(offM));
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms) - offsetMin * 60_000;
}

/** The last absolute stamp that appears before `index` on a line — the one that belongs to it. */
function stampBefore(line, index) {
  XCTEST_STAMP_RE.lastIndex = 0;
  let best = null;
  for (let m = XCTEST_STAMP_RE.exec(line); m; m = XCTEST_STAMP_RE.exec(line)) {
    if (m.index >= index) break;
    best = m;
  }
  return best ? xctestStampToEpoch(best) : null;
}

/**
 * `13:54:14.460` carries no date. Resolve it against the day of `nearEpoch` (the run's own
 * clock), then slide it a day either way if that lands it more than 12 h from the run — the
 * only case that matters is a take filmed across local midnight.
 */
function hmsToEpoch({ h, m, s, ms }, nearEpoch) {
  const d = new Date(nearEpoch);
  d.setHours(h, m, s, ms);
  let e = d.getTime();
  while (e - nearEpoch > 12 * 3600_000) e -= 24 * 3600_000;
  while (nearEpoch - e > 12 * 3600_000) e += 24 * 3600_000;
  return e;
}

/**
 * Every touch the iOS driver actually made, newest run in `debugDir` only.
 *
 * @param {object} o
 * @param {string} o.debugDir what was passed to `maestro test --debug-output`
 * @param {number} [o.nearEpoch] a wall-clock instant inside the run, for dating maestro.log's
 *   time-only stamps. Defaults to now.
 * @returns {Promise<{
 *   taps: Array<{xPt:number,yPt:number,wallMs:number,kind:'tap'|'longPress',holdSec:number}>,
 *   scale:number|null, widthPx:number|null, heightPx:number|null, platform:string|null,
 *   source:'xctest'|'maestro-log'|null, testDir:string|null, warnings:string[],
 *   commandRecordGap?:object|null }>}  (Android: taps found but no finished tap command in the record; see below)
 */
export async function parseMaestroTaps({ debugDir, nearEpoch = Date.now() }) {
  const warnings = [];
  const { testDir, maestroLog, xctestLogs, commandLogs } = await locateLogs(debugDir);
  if (!testDir) {
    return { taps: [], scale: null, widthPx: null, heightPx: null, platform: null, source: null, testDir: null, warnings: ['no maestro.log under the debug dir'] };
  }

  const maestroText = maestroLog ? await readFile(maestroLog, 'utf8') : '';
  const info = maestroText.match(DEVICE_INFO_RE);
  const widthPx = info ? Number(info[1]) : null;
  const heightPx = info ? Number(info[2]) : null;
  const widthGrid = info ? Number(info[3]) : null;
  // A grid of 0 would divide by zero into Infinity and silently place every ring at the origin.
  const scale = widthPx && widthGrid ? widthPx / widthGrid : null;
  const platform = maestroText.match(DEVICE_PLATFORM_RE)?.[1]?.toUpperCase() ?? null;
  if (!platform) {
    // Every run logs `Got device info: DeviceInfo(platform=…)` before it touches anything, so a
    // log without one is a log that was truncated, replaced, or written by something else — and
    // "no taps found" would be a misleading way to report that.
    warnings.push(`maestro.log at ${maestroLog} has no "DeviceInfo(platform=…)" line — it is truncated or not a Maestro log`);
  }

  // Android has no driver log to prefer, so it takes its own path rather than falling through
  // the iOS one and being reported as a degraded fallback. Everything after this branch is the
  // iOS reading and is deliberately untouched.
  if (platform === 'ANDROID') {
    const commandTexts = [];
    for (const path of commandLogs) commandTexts.push(await readFile(path, 'utf8').catch(() => ''));
    const commandFiles = describeCommandFiles(commandLogs.map((path, i) => ({ name: basename(path), text: commandTexts[i] })));
    const notes = { commandRecordGap: null };
    const androidTaps = parseAndroidTaps({
      maestroText,
      commandRecords: readCommandRecords(commandTexts),
      commandFiles,
      readableFiles: commandFiles.filter((f) => f.state === 'records').length,
      nearEpoch,
      warnings,
      notes,
    });
    androidTaps.sort((a, b) => a.wallMs - b.wallMs || a.xPt - b.xPt || a.yPt - b.yPt);
    return {
      taps: androidTaps,
      scale,
      widthPx,
      heightPx,
      platform,
      source: androidTaps.length > 0 ? 'maestro-log' : null,
      testDir,
      warnings,
      // Android only, and only when taps were found: the command record shows no finished tap command, so
      // every touch is a plain ripple (a long press cannot be told from a tap). `{ kind: 'missing' (no
      // commands-*.json) | 'unreadable' (every file empty or cut off mid-write) | 'no-tap' (records parsed, none
      // a finished tap), files: [{ name, state }], records }`. The caller says why: film-android knows whether
      // it stopped maestro itself.
      commandRecordGap: androidTaps.length > 0 ? notes.commandRecordGap : null,
    };
  }

  const taps = [];
  for (const path of xctestLogs) {
    const text = await readFile(path, 'utf8');
    for (const line of text.split('\n')) {
      const long = XCTEST_LONGPRESS_RE.exec(line);
      if (long) {
        const wallMs = stampBefore(line, long.index);
        if (wallMs !== null) {
          taps.push({ xPt: Number(long[1]), yPt: Number(long[2]), wallMs, kind: 'longPress', holdSec: Number(long[3]) });
        }
        continue;
      }
      const tap = XCTEST_TAP_RE.exec(line);
      if (!tap) continue;
      const wallMs = stampBefore(line, tap.index);
      if (wallMs === null) continue;
      taps.push({ xPt: Number(tap[1]), yPt: Number(tap[2]), wallMs, kind: 'tap', holdSec: 0 });
    }
  }

  let source = 'xctest';
  if (taps.length === 0) {
    // No driver log, or a driver that stopped logging touches. maestro.log still knows where
    // the host TRIED to tap; that is worth a ring 100 ms out, but say so out loud.
    for (const line of maestroText.split('\n')) {
      const m = MAESTRO_TAP_RE.exec(line);
      if (!m) continue;
      const wallMs =
        hmsToEpoch({ h: Number(m[1]), m: Number(m[2]), s: Number(m[3]), ms: Number(m[4]) }, nearEpoch) +
        MAESTRO_LOG_TAP_LEAD_MS;
      taps.push({ xPt: Number(m[5]), yPt: Number(m[6]), wallMs, kind: 'tap', holdSec: 0 });
    }
    if (taps.length > 0) {
      source = 'maestro-log';
      warnings.push(
        `no tap lines in ${xctestLogs.length === 0 ? 'any xctest_runner log (none found)' : 'the xctest_runner log'} — ` +
          `fell back to maestro.log's "Try tapping" times plus a ${MAESTRO_LOG_TAP_LEAD_MS}ms constant, ` +
          'so the rings can sit up to ~100ms off the touch',
      );
    } else {
      source = null;
    }
  }

  // Sort by time and drop exact duplicates: a driver that restarts mid-flow leaves two logs
  // whose tails overlap, and the same touch must not be drawn twice.
  taps.sort((a, b) => a.wallMs - b.wallMs || a.xPt - b.xPt || a.yPt - b.yPt);
  const deduped = taps.filter(
    (t, i) => i === 0 || t.wallMs !== taps[i - 1].wallMs || t.xPt !== taps[i - 1].xPt || t.yPt !== taps[i - 1].yPt,
  );

  return { taps: deduped, scale, widthPx, heightPx, platform, source, testDir, warnings };
}

/**
 * True if a touch we would be expected to draw was SUPPOSED to happen — the question that turns
 * "no rings" into either a failure or a non-event.
 *
 * The flow text alone can only guess, and it guesses wrong in one direction that costs a take: a
 * `tapOn` behind a `when:` that never fires reads as "this flow taps", and then a run in which
 * nothing tapped fails for missing indicators it was never going to have. Maestro's own
 * `commands-<flow>.json` under `--debug-output` settles it — it lists every command with the
 * status it finished in — so when a debug dir is given and holds one, that record wins and the
 * grep is only the fallback for the case where it does not exist (an older Maestro, a run that
 * died before writing it, `--no-show-taps` having skipped `--debug-output` altogether).
 *
 * Reads the record SYNCHRONOUSLY, on purpose: this is one small JSON, read once, at a single
 * decision point after the flow is over, and callers (film-ios.mjs) depend on the boolean coming
 * straight back. Making it async to save a millisecond would turn `if (tapsExpected)` into a
 * truthy Promise at every call site that forgot to await it — which fails in the direction that
 * costs takes.
 *
 * @param {string} flowText
 * @param {string} [debugDir] what was passed to `maestro test --debug-output`
 */
export function flowHasTapCommands(flowText, debugDir) {
  const withoutComments = String(flowText)
    .split('\n')
    .map((l) => l.replace(/#.*$/, ''))
    .join('\n');
  const grep = /\b(?:double)?[tT]apOn\b|\blongPressOn\b/.test(withoutComments);
  if (!debugDir) return grep;
  const record = readCommandRecordsSync(debugDir);
  if (record === null) return grep;
  const ran = record.some((c) => c.isTap && RAN_STATUSES.has(c.status));
  if (!ran && grep) {
    const stopped = whyFlowStopped(debugDir);
    if (stopped) {
      // The flow never got as far as a tap (it failed or was stopped first), so no ring is owed
      // and there is nothing to fix — in particular not TAP_COMMAND_KEY_RE.
      console.error(`[tap-overlay] no tap command ran before the flow stopped (${stopped}), so no tap indicators are owed.`);
    } else {
      // The flow ran to its end, and still no recognised tap. The ordinary explanation is a tap
      // behind a `when:` that never fired, in which case the record is right and the grep is the
      // naive reading. The other is that a Maestro update renamed the command kinds out from under
      // TAP_COMMAND_KEY_RE, in which case a take with no rings would pass as "no taps were owed".
      // Only the second is a bug, and only the kinds actually present can tell them apart, so both
      // possibilities and the evidence go to stderr rather than silently to neither.
      const kinds = [...new Set(record.filter((c) => RAN_STATUSES.has(c.status)).map((c) => c.kind))].sort();
      console.error(
        "[tap-overlay] ⚠️  the flow text has a tap command and the flow ran to its end, but Maestro's execution record shows no tap running.\n" +
          `[tap-overlay]    Commands it does show: ${kinds.join(', ') || '(none)'}\n` +
          '[tap-overlay]    Ordinarily that means the tap sat behind a `when:` that never fired, and no ' +
          'indicators are owed.\n' +
          '[tap-overlay]    If a tap DID happen on screen, this build of Maestro names its commands something ' +
          'lib/tap-overlay.mjs does not recognise — fix TAP_COMMAND_KEY_RE against the kinds above.',
      );
    }
  }
  return ran;
}

/** Every `commands-*.json` under `debugDir`, or null if there is not one to read. */
/**
 * The NEWEST run under a debug dir, read synchronously — the same run `locateLogs` picks (the
 * directory of the newest maestro.log; with no maestro.log at all, the directory of the newest
 * commands-*.json), so a debug dir that holds several attempts (a startup retry lands each in its
 * own run dir) is only ever judged on the latest. Returns null when there is nothing to read.
 */
function newestRunSync(debugDir) {
  const found = []; // { path, mtimeMs, dir, name }
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.name === 'maestro.log' || /^commands-.*\.json$/.test(e.name)) {
        try {
          found.push({ path: p, mtimeMs: statSync(p).mtimeMs, dir, name: e.name });
        } catch {
          /* vanished */
        }
      }
    }
  };
  visit(debugDir);
  const newest = (list) => list.reduce((a, f) => (!a || f.mtimeMs > a.mtimeMs ? f : a), null);
  const anchor = newest(found.filter((f) => f.name === 'maestro.log')) ?? newest(found);
  if (!anchor) return null;
  const files = found.filter((f) => f.dir === anchor.dir);
  const commandTexts = [];
  for (const f of files.filter((x) => x.name !== 'maestro.log')) {
    try {
      commandTexts.push(readFileSync(f.path, 'utf8'));
    } catch {
      /* unreadable spill — fall back to the grep */
    }
  }
  const logFile = files.find((f) => f.name === 'maestro.log');
  let logText = '';
  if (logFile) {
    try {
      logText = readFileSync(logFile.path, 'utf8');
    } catch {
      /* leave empty */
    }
  }
  return { dir: anchor.dir, commandTexts, logText, hasLog: Boolean(logFile) };
}

function readCommandRecordsSync(debugDir) {
  const run = newestRunSync(debugDir);
  if (!run || run.commandTexts.length === 0) return null;
  const records = readCommandRecords(run.commandTexts);
  return records.length === 0 ? null : records;
}

// Maestro's last act on a run that ran to its end, pass OR fail, is to purge old debug logs, and it
// logs that as `TestDebugReporter.deleteOldFiles`. A maestro that was killed mid-run never gets there.
const MAESTRO_FINALIZED_RE = /TestDebugReporter\.deleteOldFiles/;

/**
 * Why the newest run stopped short of its end, or null if it ran to completion. Read from the
 * command record: a FAILED command, a command still RUNNING or PENDING; and from maestro.log: no
 * finalization line, meaning maestro was killed. It answers "did the flow reach its end", which is
 * what decides whether a missing tap is news.
 */
function whyFlowStopped(debugDir) {
  const run = newestRunSync(debugDir);
  if (!run) return null;
  const raw = [];
  for (const text of run.commandTexts) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) raw.push(...parsed);
    } catch {
      /* ignore */
    }
  }
  const status = (e) => e?.metadata?.status;
  const kind = (e) => Object.keys(e?.command ?? {})[0] ?? 'a command';
  const failed = raw.find((e) => status(e) === 'FAILED');
  if (failed) return `the ${kind(failed)} command FAILED`;
  const open = raw.find((e) => status(e) === 'RUNNING' || status(e) === 'PENDING');
  if (open) return `the record ends with the ${kind(open)} command still ${status(open)}`;
  if (run.hasLog && !MAESTRO_FINALIZED_RE.test(run.logText)) return 'maestro was stopped before it finished';
  return null;
}

// ── BURN ────────────────────────────────────────────────────────────────────────────────────

// Every number in the filter graph comes through here. It used to answer '0' for a value that
// was not a number, which is the worst available answer: a NaN tSec would have quietly drawn its
// ring at the start of the video, on whatever happened to be on screen then, and the take would
// have looked fine until someone watched it.
const num = (v) => {
  if (!Number.isFinite(v)) throw new Error(`tap overlay got a non-numeric value (${v}) where a number is required`);
  return String(Math.round(v * 1000) / 1000);
};

/**
 * The ripple, as four ffmpeg expressions over a small transparent canvas. `geq` runs per pixel
 * per channel, so it is only ever pointed at this sprite (288×288 × 27 frames, ~1 s of work)
 * and never at the 1206×2622 recording, which would take minutes.
 */
function rippleSprite(style) {
  const { scale, durationSec, radiusPt, growth, ringPt, ring, halo, fillAlpha } = style;
  const r0 = radiusPt * scale;
  const r1 = radiusPt * growth * scale;
  const w = ringPt * scale;
  const size = Math.ceil(2 * r1 + 8 * scale);
  const c = size / 2;
  const p = `clip(T/${num(durationSec)},0,1)`;
  const radius = `(${num(r0)}+${num(r1 - r0)}*(1-pow(1-${p},2)))`;
  const fade = `pow(1-${p},2)`;
  return spriteExprs({ size, distance: `hypot(X-${num(c)},Y-${num(c)})`, radius, fade, w, ring, halo, fillAlpha });
}

/** The same mark with the clock stopped: what a long press looks like while the finger is down. */
function holdSprite(style) {
  const { scale, radiusPt, growth, ringPt, ring, halo, fillAlpha } = style;
  const r0 = radiusPt * scale;
  const size = Math.ceil(2 * radiusPt * growth * scale + 8 * scale);
  const c = size / 2;
  return spriteExprs({
    size,
    distance: `hypot(X-${num(c)},Y-${num(c)})`,
    radius: num(r0),
    fade: '1',
    w: ringPt * scale,
    ring,
    halo,
    fillAlpha,
  });
}

function spriteExprs({ size, distance, radius, fade, w, ring, halo, fillAlpha }) {
  // Fourth power, not squared: a flat-topped profile that falls off fast, i.e. a stroke with
  // antialiased edges rather than the soft glow a plain gaussian draws.
  const body = `exp(-pow((${distance}-${radius})/${num(w)},4))`;
  // A wider skirt with the ring itself subtracted out: a dark edge on BOTH sides of the stroke,
  // which is what survives a white background and a black one with the same drawing.
  const edge = `clip(exp(-pow((${distance}-${radius})/${num(w * 1.7)},2))-0.9*${body},0,1)`;
  const fill = `clip((${radius}-${distance})/${num(2 * w)},0,1)`;
  const total = `(0.98*${body}+0.7*${edge}+${num(fillAlpha)}*${fill})`;
  const k = `clip(0.7*${edge}/(${total}+0.002),0,1)`; // how much of this pixel is edge, not ring
  // ring colour where the pixel is stroke, halo colour where it is edge, lerped by k.
  const chan = (i) => `${ring[i]}${halo[i] >= ring[i] ? '+' : '-'}${Math.abs(halo[i] - ring[i])}*(${k})`;
  return {
    size,
    a: `255*${fade}*clip(${total},0,1)`,
    r: chan(0),
    g: chan(1),
    b: chan(2),
  };
}

const spriteInput = ({ size, fps, dur }) => `color=c=0x00000000:s=${size}x${size}:r=${fps}:d=${num(dur)}`;
const geqFilter = (e) => `format=rgba,geq=r='${e.r}':g='${e.g}':b='${e.b}':a='${e.a}'`;

// ── which flag reads the filter graph from a file ────────────────────────────────────────────
// The graph goes to a file rather than argv (see burnTapRipples), and ffmpeg has changed how it
// takes one: `-filter_complex_script <file>` up to 7.0, `-/filter_complex <file>` — the generic
// "read this option's value from a file" syntax — from 7.1, with the old spelling deprecated
// there and gone by 9. Getting it wrong is not a subtle failure (ffmpeg exits with "Unrecognized
// option"), but it is a failure at the very last step of a five-minute film run, so it is decided
// up front from `ffmpeg -version` and remembered.
//
// A build whose version string does not parse (a git snapshot: `ffmpeg version N-113455-gd2ab...`)
// is not guessed at — it is asked, with a 2×2 black frame and a trivial graph, which costs one
// spawn of a few milliseconds and is the only answer that cannot be wrong.
const FILTER_SCRIPT_OPTION_CACHE = new Map();

/** `{ option, version, how }` — how = 'version' | 'probe'. Cached per ffmpeg path per process. */
export async function filterScriptOption(ffmpegPath) {
  const cached = FILTER_SCRIPT_OPTION_CACHE.get(ffmpegPath);
  if (cached) return cached;
  const banner = await captureFfmpeg(ffmpegPath, ['-hide_banner', '-version']);
  const version = /ffmpeg version (\S+)/.exec(banner)?.[1] ?? null;
  const numeric = /^n?(\d+)\.(\d+)/.exec(version ?? '');
  let resolved;
  if (numeric) {
    const [major, minor] = [Number(numeric[1]), Number(numeric[2])];
    const modern = major > 7 || (major === 7 && minor >= 1);
    resolved = { option: modern ? '-/filter_complex' : '-filter_complex_script', version, how: 'version' };
  } else {
    const works = [];
    for (const option of ['-/filter_complex', '-filter_complex_script']) {
      if (await filterScriptOptionWorks(ffmpegPath, option)) works.push(option);
    }
    if (works.length === 0) {
      throw new Error(
        `this ffmpeg (${version ?? 'version unknown'}) accepts neither -/filter_complex nor ` +
          '-filter_complex_script, so the tap overlay cannot hand it a filter graph. ' +
          'ffmpeg 7.1 or newer is what filmkit is built against; below 7.0 is too old for the ' +
          'older spelling to be missing, so this build is unusual — install a release build.',
      );
    }
    resolved = { option: works[0], version, how: 'probe' };
  }
  FILTER_SCRIPT_OPTION_CACHE.set(ffmpegPath, resolved);
  return resolved;
}

/** Does this ffmpeg take that option? One 2×2 frame through a no-op graph, output discarded. */
async function filterScriptOptionWorks(ffmpegPath, option) {
  const dir = await mkdtemp(join(tmpdir(), 'filmkit-ffprobe-'));
  const scriptPath = join(dir, 'probe.filter');
  try {
    await writeFile(scriptPath, '[0:v]null[v]\n', 'utf8');
    await runFfmpeg(ffmpegPath, [
      '-y', '-nostdin', ...QUIET,
      '-f', 'lavfi', '-i', 'color=c=black:s=2x2:d=0.04',
      option, scriptPath,
      '-map', '[v]', '-frames:v', '1', '-f', 'null', '-',
    ]);
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Every ffmpeg call in this file except the `-version` capture (whose banner IS the answer) is
// quiet: stderr is captured by runFfmpeg and only its last lines are ever shown, and on a failure
// those lines should be the error, not the tail of a progress meter.
const QUIET = ['-hide_banner', '-loglevel', 'error'];

function captureFfmpeg(ffmpegPath, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolvePromise(''));
    child.on('exit', () => resolvePromise(out));
  });
}

/**
 * Run ffmpeg through the shared abortable runner (lib/run.mjs) and turn a non-zero exit into an
 * Error quoting the last lines of stderr. stdout is not opened (every call here writes a file or
 * `-f null`), and stderr is kept as a rolling tail, since only its last lines are ever shown.
 *
 * @param {AbortSignal} [signal] on abort: SIGTERM the child, SIGKILL it after ABORT_KILL_GRACE_MS
 *   (lib/run.mjs, 2s) if it hasn't exited, and reject with an AbortError, only once it has exited,
 *   instead of whatever ffmpeg's own exit code would have said (a killed process's exit code is not
 *   useful).
 */
async function runFfmpeg(ffmpegPath, args, { signal } = {}) {
  const { code, stderr } = await runAbortable(ffmpegPath, args, { signal, stdout: 'ignore', stderrTailChars: 100_000, label: 'ffmpeg' });
  if (code !== 0) throw new Error(`ffmpeg exited ${code}\n${stderr.trim().split('\n').slice(-12).join('\n')}`);
}

/**
 * Draw a ripple into `inPath` at every tap and write `outPath`.
 *
 * THE OUTPUT IS RE-ENCODED AT A CONSTANT FRAME RATE, and that is not incidental. `simctl io
 * recordVideo` writes variable frame rate: it emits a frame when the screen changes and nothing
 * at all while it does not — a static screen can go five seconds without a single frame. Overlay
 * only draws on frames that exist, so a tap on something that does not visibly react (a disabled
 * control, an already-selected tab) would get no ring at all. `fps=<style.fps>` guarantees a
 * frame every 1/fps second, so the ring is drawn whether or not the app reacted. Cost measured
 * on a 68 s 1206×2622 take: 27 s with h264_videotoolbox at 60 fps.
 *
 * @param {object} o
 * @param {string} o.inPath
 * @param {string} o.outPath must differ from inPath
 * @param {Array<{x:number,y:number,tSec:number,holdSec?:number}>} o.taps pixels, and seconds
 *   into THIS video (the uncropped input frame when `crop` is given)
 * @param {{w:number,h:number,x:number,y:number}} [o.crop] trim the input to this rectangle in the same
 *   filter graph, so the crop costs no extra encode (film-android trims the 1-2px of letterbox
 *   screenrecord's float truncation leaves). Tap coordinates stay in the INPUT frame and are shifted
 *   by the crop origin here, so a caller keeps one coordinate system whatever the origin. With a
 *   `crop`, `taps` may be empty: the run is then a finishing encode with no rings (same encoder and
 *   quality policy). The same with `style.pinDurationSec` (film-ios holds a tap-less take's last frame
 *   to the recorder's stop that way). With neither, no taps is an error, as before.
 * @param {string} o.ffmpegPath
 * @param {object} o.style at minimum `{ scale }`; see rippleDefaults
 * @param {AbortSignal} [o.signal] abort the burn mid-encode: the ffmpeg child is SIGTERM'd (then
 *   SIGKILL'd after a grace period if it ignores that), `outPath` is removed since a half-encoded
 *   file must never be mistaken for a finished one, and the returned promise rejects with an
 *   `AbortError` rather than resolving or resolving-with-partial-output.
 * @returns {Promise<{outPath:string, taps:number, encoder:string, elapsedSec:number, fps:number}>}
 */
export async function burnTapRipples({ inPath, outPath, taps, ffmpegPath, style = {}, workDir, signal, crop }) {
  if (inPath === outPath) throw new Error('burnTapRipples needs a distinct outPath — ffmpeg cannot read and write one file');
  if (crop !== undefined && crop !== null) {
    const ok = ['w', 'h', 'x', 'y'].every((k) => Number.isInteger(crop[k])) && crop.w > 0 && crop.h > 0 && crop.x >= 0 && crop.y >= 0;
    if (!ok) throw new Error(`burnTapRipples: crop must be { w, h, x, y } of whole numbers, w and h positive (got ${JSON.stringify(crop)})`);
  } else {
    crop = null;
  }
  const pinRequested = Number.isFinite(style?.pinDurationSec) && style.pinDurationSec > 0;
  if (!Array.isArray(taps) || (taps.length === 0 && !crop && !pinRequested)) throw new Error('burnTapRipples was given no taps');
  const noRings = taps.length === 0; // only with a crop or a pin: a finishing encode with nothing drawn
  const ox = crop?.x ?? 0;
  const oy = crop?.y ?? 0;
  if (signal?.aborted) throw makeAbortError();
  const s = { ...rippleDefaults, scale: 3, ...style };
  if (!(s.scale > 0)) throw new Error(`ripple scale must be positive (got ${s.scale})`);
  // x and y are rounded straight into the overlay filter rather than passing through num(), so
  // they get the same refusal here: a ring whose coordinates are NaN is drawn at 0,0, and nothing
  // downstream would ever say so.
  for (const [i, t] of taps.entries()) {
    for (const field of ['x', 'y', 'tSec']) {
      if (!Number.isFinite(t[field])) throw new Error(`tap ${i} has a non-numeric ${field} (${t[field]})`);
    }
    if (t.holdSec !== undefined && !(Number.isFinite(t.holdSec) && t.holdSec >= 0)) {
      throw new Error(`tap ${i} has a non-numeric holdSec (${t.holdSec})`);
    }
  }

  const ripple = rippleSprite(s);
  const hold = holdSprite(s);
  const holds = taps.filter((t) => (t.holdSec ?? 0) > 0);

  // One lavfi source per distinct sprite, split once per use. The graph goes to a file rather
  // than argv: 30 taps is ~6 KB of filter and a long take could be more, and blowing ARG_MAX at
  // the last step of a five-minute film run is a bad way to lose a take.
  const inputs = ['-i', inPath, ...(noRings ? [] : ['-f', 'lavfi', '-i', spriteInput({ size: ripple.size, fps: s.fps, dur: s.durationSec })])];
  const holdInputIndex = new Map();
  for (const [i, t] of holds.entries()) {
    holdInputIndex.set(t, 2 + i);
    inputs.push('-f', 'lavfi', '-i', spriteInput({ size: hold.size, fps: s.fps, dur: t.holdSec }));
  }

  const chains = [];
  // `style.pinDurationSec` pins the output's length. film-ios pins every burn to the recorder's own
  // window (Recording started to the SIGINT that stopped it): simctl emits no frame while the screen
  // is still, so a take that ends on a held beat stops at its last CHANGE, seconds before the camera
  // stopped (measured 4.3-4.4s short on the example flow), and the burn has to hold that last frame
  // to the stop. The base is padded with clones of its last frame for as long as the pin itself
  // (more than any shortfall can be; frames past the pin are never encoded, the `-t` below ends the
  // output there) and cut to exactly the pinned length, which also removes a phantom tail (a final
  // sample stamped past the stop, see film-ios's trimPhantomTail). Absent, nothing here changes.
  const pinned = Number.isFinite(s.pinDurationSec) && s.pinDurationSec > 0;
  chains.push(
    `[0:v]fps=${s.fps}${pinned ? `,tpad=stop_mode=clone:stop_duration=${num(Math.max(2, s.pinDurationSec))}` : ''}` +
      `${crop ? `,crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}` : ''},format=yuv420p[base]`,
  );
  if (!noRings) chains.push(`[1:v]${geqFilter(ripple)},split=${taps.length}${taps.map((_, i) => `[rip${i}]`).join('')}`);
  for (const [i, t] of holds.entries()) chains.push(`[${holdInputIndex.get(t)}:v]${geqFilter(hold)}[hold${i}]`);

  // Each sprite is padded with transparent frames up to its own start time, so every overlay
  // sees a stream that begins at 0 like the video does. Shifting PTS instead would leave
  // overlay's framesync waiting on an input that has not produced a frame yet.
  let last = 'base';
  let step = 0;
  const place = (label, x, y, at, dur) => {
    const next = `v${step++}`;
    const padded = `${label}p`;
    chains.push(`[${label}]tpad=start_duration=${num(at)}:start_mode=add:color=0x00000000[${padded}]`);
    chains.push(
      `[${last}][${padded}]overlay=x=${Math.round(x)}:y=${Math.round(y)}:` +
        `enable='between(t,${num(at)},${num(at + dur)})':eof_action=pass:repeatlast=0[${next}]`,
    );
    last = next;
  };
  for (const [i, t] of holds.entries()) {
    place(`hold${i}`, t.x - ox - hold.size / 2, t.y - oy - hold.size / 2, t.tSec, t.holdSec);
  }
  for (const [i, t] of taps.entries()) {
    // A held press breaks into the ripple when the finger comes off, not when it lands.
    const at = t.tSec + (t.holdSec ?? 0);
    place(`rip${i}`, t.x - ox - ripple.size / 2, t.y - oy - ripple.size / 2, at, s.durationSec);
  }

  const dir = workDir ?? (await mkdtemp(join(tmpdir(), 'filmkit-taps-')));
  const scriptPath = join(dir, 'tap-overlay.filter');
  await writeFile(scriptPath, `${chains.join(';\n')}\n`, 'utf8');

  const { option: filterOption, version: ffmpegVersion } = await filterScriptOption(ffmpegPath);

  const started = Date.now();
  // VideoToolbox is ~2.5× realtime at 1206×2622/60fps on Apple silicon; libx264 is several times
  // slower there, so it is the fallback rather than the default. Both are lossy re-encodes — the
  // ring has to be baked in, there is no other way to put it in an mp4.
  //
  // RATE CONTROL, and how each path stays quality-preserving (FEEDBACK #25). The hardware path is
  // average-bitrate (`-b:v`), because that is the only mode h264_videotoolbox takes reliably across
  // Macs, and the target is never below the source's own: film-android passes the recorder's
  // --bit-rate, film-ios the 12M default. Measured on a 44 s 1080x2404 take whose raw recording
  // was 232 kbps, the burn came out at 1.68 Mbps — VideoToolbox spends its target rather than
  // undershooting it, so the burn is above the source by construction, not just by luck. The
  // software path is constant-quality CRF from lib/encode.mjs (18), which is quality-driven and
  // has no bitrate to undershoot. Neither path can add detail the source never had; the point is
  // that the burn costs no visible generation loss.
  const encode = (codec, extra) =>
    runFfmpeg(
      ffmpegPath,
      [
        '-y', '-nostdin', ...QUIET,
        ...inputs,
        // Whichever spelling this build takes for "read the filter graph from this file".
        filterOption, scriptPath,
        '-map', `[${last}]`,
        '-map', '0:a?',
        '-c:a', 'copy',
        '-c:v', codec,
        ...extra,
        ...(pinned ? ['-t', s.pinDurationSec.toFixed(3)] : []),
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        outPath,
      ],
      { signal },
    );
  // Stay in the codec the take was recorded in, so --codec hevc does not quietly become h.264.
  const hevc = s.codec === 'hevc';
  const hw = hevc ? 'hevc_videotoolbox' : 'h264_videotoolbox';
  const sw = hevc ? 'libx265' : 'libx264';
  let encoder = hw;
  try {
    try {
      await encode(hw, ['-b:v', s.videoBitrate]);
    } catch (err) {
      // An abort is not "this encoder failed, try the other one" — it is "stop now", and falling
      // through to the sw encoder would burn the rest of the abort's own grace period re-encoding
      // a file nobody wants. Clean up and reject the AbortError itself so the caller can tell the
      // two apart from an ordinary encode failure.
      if (err.name === 'AbortError') {
        await rm(outPath, { force: true });
        throw err;
      }
      encoder = sw;
      try {
        // `x264Args` names libx264; for hevc the same preset/crf flags go to libx265 instead, and
        // its CRF scale runs a few points higher for equal quality, so 18 is at least as good.
        await encode(sw, x264Args({ crf: s.crf }).slice(2));
      } catch (e) {
        if (e.name === 'AbortError') {
          await rm(outPath, { force: true });
          throw e;
        }
        throw new Error(`${e.message}\n(${hw} had already failed: ${err.message})`);
      }
    }
  } finally {
    if (!workDir) await rm(dir, { recursive: true, force: true });
  }
  return {
    outPath,
    taps: taps.length,
    encoder,
    elapsedSec: (Date.now() - started) / 1000,
    fps: s.fps,
    ffmpegVersion,
    filterOption,
  };
}
