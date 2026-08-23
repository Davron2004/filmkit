#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// tighten.mjs — "tighten" pass: cuts dead air out of an already-rendered demo
// video (app loading waits, Maestro's ~1s safety inactivity windows between actions,
// settle pauses) while keeping the demo watchable. ffmpeg-only, no npm dependencies —
// system ffmpeg, absence handled gracefully; PATH-first tool resolution with a
// grounded fallback path (see lib/tools.mjs).
//
//   node tighten.mjs <in.mp4> [--out <path>] [--min-still <sec, default 1.2>]
//                             [--keep <sec, default 0.6>] [--noise <auto | freezedetect noise>]
//                             [--dry-run]
//
// STATE MACHINE (one linear pipeline, no back-edges — a tighten run is a single attempt):
//
//   PREFLIGHT → DETECT → CALIBRATE → PLAN → (dry-run stops here) → CUT → done
//
// - PREFLIGHT: resolve ffmpeg (PATH first, then $FILMKIT_FFMPEG, then the grounded fallback);
//   verify the input file exists. Any failure exits non-zero before any output is touched.
// - DETECT (pass 1): resample to constant fps, then run TWO `freezedetect` filters chained in
//   the same graph — an exact-match probe (`n=0`) and a threshold probe (`n=<--noise>`, default
//   -60dB) — and parse freeze_start/freeze_duration/freeze_end for each out of ffmpeg's stderr
//   (freezedetect has no stdout/file output — it's a log-only analysis filter, so this is a
//   `-f null -` pass). Chained freezedetects pass frames through untouched, so both probes see
//   exactly the same frames and one decode serves both. The fps= pre-pass is load-bearing on VFR
//   device recordings — see the comment above the call. Parsed intervals are normalized
//   (clamped, garbage dropped, sorted, genuinely-overlapping ones merged). Also reads the input's
//   total duration and whether it has an audio stream off the same stderr (no ffprobe
//   dependency — one tool, one process).
// - CALIBRATE: pick which probe's table to plan from. See RECORDER NOISE FLOOR below.
// - PLAN: turn freeze intervals into a keep-segment list — each freeze is clamped to `keep`
//   seconds (see CLAMP CHOICE below), non-frozen stretches pass through untouched. Freezes
//   shorter than `--min-still` were never reported by freezedetect (its own `d` parameter), so
//   they're already left alone by construction — nothing to special-case here. The plan is then
//   checked against a SANITY FLOOR (below), which warns but never blocks.
// - CUT (pass 2): select+setpts via a filter_complex graph (video-only unless the input actually
//   has an audio stream — screen recordings usually don't, but the graph is built generically).
//   No freezes found → print "already tight", write nothing, exit 0 (never emit a copy or a
//   broken file for a no-op run). `--dry-run` stops before this step and prints the freeze table
//   and the keep-segment plan instead — that is the cheap thing to run first when a result looks
//   wrong, since it costs one decode and no encode.
//
// RECORDER NOISE FLOOR — why one dB threshold cannot serve both cameras (measured, not guessed):
// `freezedetect=n=X` calls a frame frozen when its mean absolute difference from the reference
// frame at the head of the freeze is below X of full scale (-60dB = 0.001 ≈ 0.26 of a 0..255
// level). That threshold has to sit above the recorder's own noise floor and below the smallest
// real on-screen change, and those two numbers differ by camera:
//   - The web camera records through Chromium + x264. Every frame carries fresh quantization
//     noise, so "static" frames are NOT identical — on `out/tip-demo.mp4` the per-frame mean
//     difference during held stretches runs to ~0.05 levels and the exact-match probe finds zero
//     frozen time in the whole clip. -60dB was tuned for exactly this and is correct here.
//   - Device recorders (`adb screenrecord`, `simctl recordVideo`) are frame-exact: while the
//     screen does not change the encoder emits no new content at all, so static frames are
//     bit-identical and the noise floor is literally zero. On such footage -60dB is not a
//     conservative choice, it is a blindfold: it ignores every change smaller than 0.1% of the
//     frame, and on a 960x2136 phone screen that is most of the UI. Measured on
//     `demo/raw/4-build-transmute/take-1.mp4` (147.4s, a progress screen whose timer ticks every
//     second for the first 76s): at -60dB freezedetect reports the ENTIRE clip frozen, because a
//     ticking "0:15 · 0 characters so far / Quiet for 15s" line moves ~0.03 of a level (≈ -78dB).
//     At n=0 the same clip reports 76s of continuous change followed by a genuinely static grid.
// So `--noise auto` (the default) runs both probes and picks: if the exact-match probe finds at
// least EXACT_MODE_MIN_FROZEN_FRACTION of the clip frozen, the recorder is frame-exact and the
// exact probe is used — on such a source ANY nonzero inter-frame difference is real on-screen
// change, which is the strongest correctness property this tool can have (nothing visible is ever
// cut). Otherwise the recorder has a noise floor and the dB threshold is used. Passing `--noise`
// explicitly forces the threshold probe and skips the choice.
//
// CLAMP CHOICE — first `keep` seconds of each freeze, not a centered slice: by definition every
// frame inside a freeze interval is visually identical (that's what "frozen" means to
// freezedetect), so there is no content difference between "first", "last", or "centered" — the
// only thing that changes is which SIDE of the freeze survives, i.e. the felt rhythm of the cut.
// Keeping the leading edge reads as "the action lands, we hold on the result for a beat, then
// cut" (a natural edit beat); keeping the trailing edge reads as "we cut right as the next
// action is about to start" (an anticipation beat with nothing to anticipate, since the app
// under film gives no visible tell that e.g. a network load is about to finish). The former is
// more watchable.
//
// ABUTTING FREEZES ARE NOT ONE FREEZE — the bug that ate every Android take. freezedetect reports
// a freeze that ends at exactly the timestamp where the next one starts whenever the change
// between two holds occupies a single frame boundary, which on device footage is the normal case
// (a screen repaint has no duration; the recorder emits one frame and goes quiet again). A 147.4s
// recording came back as six abutting freezes covering 0 → EOF end to end. Merging intervals that
// merely TOUCH therefore collapses the whole timeline into one freeze, and the plan degenerates to
// a single `keep`-second segment — which is exactly how 147.4s became 0.63s. normalizeFreezes
// merges only on genuine overlap (`start < last.end`); touching intervals stay separate holds,
// each keeping its own beat, and the change frame between them survives because it is the first
// frame of the following freeze.
//
// SANITY FLOOR — a tighten pass that removes almost everything is far more likely to be a
// detection failure than a correct edit, and the tool is in a better position to notice than the
// operator is. When the plan keeps less than SANITY_MIN_KEPT_FRACTION of a clip longer than
// SANITY_MIN_INPUT_SEC (or lands under SANITY_MIN_KEPT_SEC outright), the run prints a warning
// that names the most likely cause and STILL WRITES THE FILE — the operator decides, the tool
// does not silently substitute its judgement for theirs. The warning is printed from inside
// tighten() rather than from a caller so that it cannot be lost by a caller that only reads the
// numbers.
//
// VFR GOTCHA (found against real screen recordings, not theoretical): these recordings encode
// genuinely variable per-frame *durations* (an adjacent pair of frames can be seconds apart —
// the encoder just doesn't emit a new frame while nothing changes), and that duration is authored
// container metadata that several filters/encoders (tpad; apparently also frames crossing a
// `trim`+`concat` split boundary, in the ffmpeg version this was built against) use directly
// instead of recomputing from playback timing. Two failure modes were hit and rejected before
// landing on the approach below:
//   1. Naive `trim=start:end` over a `keep`-second clamp window can contain zero real frames (the
//      one frame representing the freeze sits at its start timestamp; the next real frame doesn't
//      arrive until the freeze's end, outside the window) — collapsing the "kept beat" toward
//      zero and reintroducing the hard jump cut this tool exists to avoid.
//   2. Resampling to constant frame rate first (`fps=`) fixes that, but fanning the same `fps=`
//      output out to N separate `trim` branches recombined with `concat` still produced wrong
//      output durations on real footage — the frame at each trim/concat boundary was observed to
//      carry a stray multi-second duration value inherited from the pre-resample source, which
//      the encoder used for output frame pacing.
// The fix: skip `trim`/`concat` entirely and use the classic `select`+`setpts` idiom — one linear
// chain, no split, no concat. `select` keeps only frames whose timestamp falls in a keep segment;
// `setpts=N/(fps*TB)` then renumbers the *surviving* frames to be perfectly evenly spaced,
// discarding every original timestamp/duration value rather than trusting any of them.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { resolve, dirname, basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTool } from './lib/tools.mjs';

const execFileP = promisify(execFile);

const DEFAULT_MIN_STILL_SEC = 1.2; // stretches shorter than this stay untouched (freezedetect's own `d`)
const DEFAULT_KEEP_SEC = 0.6; // clamp target — a short beat, never a hard jump cut
const DEFAULT_NOISE = 'auto'; // pick between the two probes below per recorder — see RECORDER NOISE FLOOR
const THRESHOLD_NOISE = '-60dB'; // freezedetect `n` for noise-floor recorders — validated against web-camera footage
const EXACT_NOISE = '0'; // freezedetect `n` for frame-exact recorders — only bit-identical frames count as frozen

// Auto-calibration switch: how much of the clip the exact-match probe must find frozen before we
// believe the recorder is frame-exact. Measured separation is enormous — 0% on the web camera's
// x264 output vs 53%/92%/99% on three unrelated `adb screenrecord` takes — so this constant sits
// in a very wide valley and is not a tuned number.
const EXACT_MODE_MIN_FROZEN_FRACTION = 0.25;

// Sanity floor (see SANITY FLOOR above). Warn, never block.
const SANITY_MIN_INPUT_SEC = 5;
const SANITY_MIN_KEPT_FRACTION = 0.25;
const SANITY_MIN_KEPT_SEC = 2;

// Constant frame rate the whole graph operates in — see the VFR GOTCHA note in the header
// comment. 30fps is a conservative, standard choice: high enough that a `keep`-second clamp
// always contains real (duplicate, since the source was static) frames, low enough not to
// meaningfully bloat the encode for a short demo clip.
const NORMALIZED_FPS = 30;

// Set by main(): when this file is driven as a CLI it prints the sanity warnings itself, in the
// right place in its own report. Library callers (film-web / film-android / film-ios) don't, so
// tighten() prints them — a caller that only reads the numbers must not be able to lose them.
let cliOwnsOutput = false;

function log(msg) {
  console.log(`[tighten] ${msg}`);
}

function warn(msg) {
  console.warn(`[tighten] ${msg}`);
}

async function fileExists(path) {
  try {
    await access(path, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveFfmpeg() {
  return resolveTool('ffmpeg');
}

const USAGE =
  'usage: node tighten.mjs <in.mp4> [--out <path>] [--min-still <sec, default 1.2>] ' +
  '[--keep <sec, default 0.6>] [--noise <auto | freezedetect noise, e.g. -60dB>] [--dry-run]';

function usageError(msg) {
  console.error(`[tighten] ${msg}`);
  console.error(USAGE);
  process.exit(1);
}

// A flag that takes a value must not eat the NEXT FLAG as that value — `--out --dry-run` used to
// write the output to a file literally named "--dry-run" and then skip the dry run. Note the
// `--` test rather than `-`: freezedetect noise levels are legitimate single-dash values
// (`--noise -60dB`), and so are negative numbers.
function valueFor(argv, i, flag) {
  const value = argv[i + 1];
  if (value === undefined) usageError(`${flag} needs a value — nothing followed it`);
  if (value.startsWith('--')) usageError(`${flag} needs a value, but the next argument is the flag "${value}"`);
  return value;
}

function parseArgs(argv) {
  const rest = [];
  let out;
  let minStill = DEFAULT_MIN_STILL_SEC;
  let keep = DEFAULT_KEEP_SEC;
  let noise = DEFAULT_NOISE;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out = valueFor(argv, i, '--out');
      i++;
    } else if (argv[i] === '--min-still') {
      minStill = Number(valueFor(argv, i, '--min-still'));
      i++;
    } else if (argv[i] === '--keep') {
      keep = Number(valueFor(argv, i, '--keep'));
      i++;
    } else if (argv[i] === '--noise') {
      noise = valueFor(argv, i, '--noise');
      i++;
    } else if (argv[i] === '--dry-run') {
      dryRun = true;
    } else {
      rest.push(argv[i]);
    }
  }
  if (rest.length !== 1) {
    console.error(USAGE);
    process.exit(1);
  }
  if (!Number.isFinite(minStill) || minStill <= 0) {
    console.error(`--min-still must be a positive number of seconds (got ${argv.join(' ')})`);
    process.exit(1);
  }
  if (!Number.isFinite(keep) || keep < 0) {
    console.error(`--keep must be a non-negative number of seconds (got ${argv.join(' ')})`);
    process.exit(1);
  }
  if (typeof noise !== 'string' || noise.trim() === '') {
    console.error(`--noise needs a value — "auto" or a freezedetect noise level like -60dB (got ${argv.join(' ')})`);
    process.exit(1);
  }
  return { inArg: rest[0], out, minStill, keep, noise, dryRun };
}

function defaultOutPath(inPath) {
  const dir = dirname(inPath);
  const ext = extname(inPath);
  const base = basename(inPath, ext);
  return join(dir, `${base}-tight${ext}`);
}

function frozenSeconds(freezes) {
  return freezes.reduce((sum, f) => sum + (f.end - f.start), 0);
}

// ── DETECT (pass 1): run both freezedetect probes, parse their stderr ───────────────────────
// The `fps=` resample BEFORE freezedetect is load-bearing: device recordings (adb screenrecord,
// simctl recordVideo) are variable-frame-rate with exotic container timebases, and freezedetect's
// clock provably derates on them — observed on a simctl recording: a freeze_end logged EARLIER
// than its own freeze_start, plus phantom freezes covering regions that contain real motion.
// Resampling to constant fps first gives every frame sane, evenly-spaced timestamps; static
// content stays static under duplication (fps= duplicates frames byte-for-byte, so the exact-match
// probe is unaffected by the resample), so freeze semantics are unchanged.
//
// freezedetect logs freeze_start the moment a freeze is CONFIRMED (i.e. `d` seconds after it
// actually began, timestamped at the true start), then logs freeze_duration+freeze_end together
// once the freeze breaks. A freeze still active at end of stream never gets a freeze_end line —
// handled below by closing it out at the input's total duration.
//
// Both probes live in one filter chain, so ffmpeg names them `Parsed_freezedetect_<index>` by
// their position in the graph. The indices are derived from the array the graph is built from
// rather than hardcoded, so adding a filter can't silently swap the two tables.
async function detectFreezes(ffmpeg, inPath, { minStill, thresholdNoise }) {
  const exactProbe = `freezedetect=n=${EXACT_NOISE}:d=${minStill}`;
  const thresholdProbe = `freezedetect=n=${thresholdNoise}:d=${minStill}`;
  const filters = [`fps=fps=${NORMALIZED_FPS}`, exactProbe, thresholdProbe];
  // ffmpeg names each filter by its position in the graph, so these indices must be READ from
  // the graph rather than written down beside it: inserting a filter above would otherwise swap
  // the two tables silently. `findLastIndex` for the threshold probe covers `--noise 0`, where
  // both probes are the same string and the second occurrence is still its own filter instance.
  const exactIndex = filters.findIndex((filter) => filter === exactProbe);
  const thresholdIndex = filters.findLastIndex((filter) => filter === thresholdProbe);
  const args = ['-hide_banner', '-nostats', '-i', inPath, '-vf', filters.join(','), '-map', '0:v', '-f', 'null', '-'];
  let stderr;
  try {
    const result = await execFileP(ffmpeg, args, { maxBuffer: 64 * 1024 * 1024 });
    stderr = result.stderr;
  } catch (err) {
    // ffmpeg exits non-zero for a real decode failure but still fills in err.stderr — surface it.
    stderr = err.stderr || '';
    if (!stderr) throw new Error(`ffmpeg freezedetect pass failed: ${err.message}`);
  }

  const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!durationMatch) {
    throw new Error(`could not parse input duration from ffmpeg output for ${inPath} (is it a valid video file?)`);
  }
  const totalDuration = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
  const hasAudio = /Stream #\d+:\d+.*: Audio:/.test(stderr);

  const byFilter = new Map();
  const pending = new Map();
  for (const line of stderr.split('\n')) {
    const m = line.match(/Parsed_freezedetect_(\d+).*lavfi\.freezedetect\.freeze_(start|duration|end):\s*([\d.]+)/);
    if (!m) continue;
    const index = Number(m[1]);
    const value = Number(m[3]);
    if (!byFilter.has(index)) byFilter.set(index, []);
    if (!pending.has(index)) pending.set(index, { start: null });
    const p = pending.get(index);
    if (m[2] === 'start') {
      p.start = value;
    } else if (m[2] === 'duration') {
      // freeze_duration is logged immediately before freeze_end and carries no information that
      // end - start doesn't. It still needs its own branch: without one it would fall through to
      // the freeze_end case below and close the interval at the wrong timestamp.
    } else if (p.start !== null) {
      byFilter.get(index).push({ start: p.start, end: value });
      p.start = null;
    }
  }
  for (const [index, p] of pending) {
    if (p.start === null) continue;
    // Freeze was still active when the stream ended — close it out at the input's duration.
    byFilter.get(index).push({ start: p.start, end: totalDuration });
  }

  const table = (index) => normalizeFreezes(byFilter.get(index) || [], totalDuration);
  return { exact: table(exactIndex), threshold: table(thresholdIndex), totalDuration, hasAudio };
}

// ── normalize: clamp to the timeline, drop garbage, sort, merge genuine overlaps ─────────────
// Even with the fps= pre-pass, treat freezedetect's output as untrusted: malformed intervals
// (end <= start), out-of-order entries, and overlaps must degrade gracefully instead of
// producing an inverted cut plan (which once yielded a NEGATIVE output duration). Sorted,
// merged, clamped intervals are exactly the precondition planSegments already relies on.
//
// The merge test is `start < last.end`, NOT `<=`: intervals that merely touch are two distinct
// holds with a one-frame change between them, and merging them destroys that change. See
// ABUTTING FREEZES ARE NOT ONE FREEZE in the header comment — this single character is what
// turned every Android take into a 0.6s stub.
function normalizeFreezes(freezes, totalDuration) {
  const clean = [];
  for (const f of [...freezes].sort((a, b) => a.start - b.start)) {
    const start = Math.max(0, f.start);
    const end = Math.min(totalDuration, f.end);
    if (end <= start) continue; // malformed (e.g. a bogus freeze_end from VFR timebase confusion)
    const last = clean[clean.length - 1];
    if (last && start < last.end) {
      last.end = Math.max(last.end, end); // genuine overlap — extend rather than double-plan
    } else {
      clean.push({ start, end });
    }
  }
  return clean;
}

// ── CALIBRATE: choose the probe whose noise threshold suits this recorder ────────────────────
// See RECORDER NOISE FLOOR in the header comment for the measurements behind this.
function calibrate({ exact, threshold, totalDuration }, { noise }) {
  if (noise !== 'auto') {
    return {
      mode: 'threshold',
      freezes: threshold,
      noise,
      reason: `--noise ${noise} given explicitly`,
    };
  }
  const exactFrozen = frozenSeconds(exact);
  const exactFraction = totalDuration > 0 ? exactFrozen / totalDuration : 0;
  if (exactFraction >= EXACT_MODE_MIN_FROZEN_FRACTION) {
    return {
      mode: 'exact',
      freezes: exact,
      noise: EXACT_NOISE,
      reason:
        `frame-exact recorder: ${(exactFraction * 100).toFixed(0)}% of the clip is bit-identical ` +
        `(>= ${(EXACT_MODE_MIN_FROZEN_FRACTION * 100).toFixed(0)}%), so every nonzero frame difference is real motion`,
    };
  }
  return {
    mode: 'threshold',
    freezes: threshold,
    noise: THRESHOLD_NOISE,
    reason:
      `recorder has a noise floor: only ${(exactFraction * 100).toFixed(0)}% of the clip is bit-identical ` +
      `(< ${(EXACT_MODE_MIN_FROZEN_FRACTION * 100).toFixed(0)}%), so falling back to n=${THRESHOLD_NOISE}`,
  };
}

// ── PLAN: normalized freeze intervals → keep-segment list ───────────────────────────────────
// Adjacent output segments are coalesced so the `select` expression stays small and every term
// is mutually exclusive (which is what lets buildFilterGraph sum them instead of OR-ing).
function planSegments(freezes, totalDuration, keep) {
  const segments = [];
  const push = (start, end, clamped) => {
    if (end <= start) return;
    const kind = clamped ? 'held beat' : 'motion';
    const last = segments[segments.length - 1];
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
      last.clamped = last.clamped && clamped;
      if (last.kind !== kind) last.kind = 'motion + beat';
      return;
    }
    segments.push({ start, end, clamped, kind });
  };
  let cursor = 0;
  for (const freeze of freezes) {
    if (freeze.start > cursor) {
      push(cursor, freeze.start, false);
    }
    push(freeze.start, Math.min(freeze.start + keep, freeze.end), true);
    cursor = Math.max(cursor, freeze.end);
  }
  if (totalDuration > cursor) {
    push(cursor, totalDuration, false);
  }
  return segments;
}

// ── SANITY FLOOR: warn loudly on a plan that is almost certainly a detection failure ─────────
// Returns a list of warning lines (empty when the plan looks sane). Never blocks the write.
function sanityWarnings({ totalDuration, keptSec, freezes, calibration, minStill, keep }) {
  if (totalDuration <= SANITY_MIN_INPUT_SEC) return [];
  const fraction = totalDuration > 0 ? keptSec / totalDuration : 1;
  if (fraction >= SANITY_MIN_KEPT_FRACTION && keptSec >= SANITY_MIN_KEPT_SEC) return [];

  const lines = [
    `unusually aggressive cut: ${totalDuration.toFixed(2)}s -> ${keptSec.toFixed(2)}s ` +
      `(kept ${(fraction * 100).toFixed(1)}%, removed ${((1 - fraction) * 100).toFixed(1)}%).`,
  ];
  const frozen = frozenSeconds(freezes);
  const coversAll = totalDuration > 0 && frozen / totalDuration > 0.98;
  if (calibration.mode === 'exact' && coversAll) {
    lines.push(
      `  suspected cause: the recording really is visually static end to end — the exact-match probe found ` +
        `${freezes.length} hold(s) covering ${frozen.toFixed(2)}s of ${totalDuration.toFixed(2)}s, i.e. almost no ` +
        `pixel on screen ever changed. A held shot has no dead air to cut; keep the raw take.`,
    );
  } else if (calibration.mode === 'threshold' && coversAll) {
    lines.push(
      `  suspected cause: n=${calibration.noise} is too coarse for this footage — freezedetect called the whole ` +
        `clip frozen. Try a smaller threshold (--noise -80dB, or --noise 0 for an exact-match recorder).`,
    );
  } else {
    lines.push(
      `  suspected cause: ${freezes.length} hold(s) totalling ${frozen.toFixed(2)}s were each clamped to ` +
        `--keep ${keep}s. If the take is meant to play in real time, raise --min-still (now ${minStill}s) ` +
        `or --keep.`,
    );
  }
  lines.push(`  the file is written anyway — you decide. \`--dry-run\` prints the freeze table without re-encoding.`);
  return lines;
}

// ── CUT (pass 2): select+setpts filter_complex graph ────────────────────────────────────────
// One linear chain per stream (video always; audio only if the input actually has it) — no
// trim/concat, no split, see the VFR GOTCHA note above for why.
function buildFilterGraph(segments, hasAudio) {
  // `between(t,S,E)` is 0/1 per frame; summing (rather than logically OR-ing) is fine because
  // planSegments returns sorted, coalesced, non-touching segments, so at most one term is ever
  // nonzero for a given t.
  const keepExpr = segments.map((seg) => `between(t\\,${seg.start}\\,${seg.end})`).join('+');
  const parts = [
    `[0:v]fps=fps=${NORMALIZED_FPS},select='${keepExpr}',setpts=N/(${NORMALIZED_FPS}*TB)[outv]`,
  ];
  if (hasAudio) {
    parts.push(`[0:a]aselect='${keepExpr}',asetpts=N/SR/TB[outa]`);
  }
  return parts.join(';');
}

async function cut(ffmpeg, inPath, outPath, segments, hasAudio) {
  const graph = buildFilterGraph(segments, hasAudio);
  const args = [
    '-y',
    '-hide_banner',
    '-nostats',
    '-i',
    inPath,
    '-filter_complex',
    graph,
    '-map',
    '[outv]',
    ...(hasAudio ? ['-map', '[outa]'] : []),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    ...(hasAudio ? ['-c:a', 'aac'] : []),
    outPath,
  ];
  await execFileP(ffmpeg, args, { maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Run the full tighten pipeline (DETECT → CALIBRATE → PLAN → CUT) against `inArg` and return a
 * summary — the library entrypoint film-web.mjs / film-android.mjs / film-ios.mjs call directly
 * via their `--tighten` flag (in-process, no subprocess spawn of this file). Throws on a real
 * failure (ffmpeg missing, input not found, freezedetect/cut failure); returns
 * `{ skipped: true, ... }` rather than throwing for the "nothing to cut" case, since that's a
 * normal (not error) outcome. Sanity-floor warnings are printed here as well as returned, so a
 * caller that only reads the numbers cannot swallow them.
 *
 * @param {string} inArg path to the input .mp4
 * @param {object} [opts]
 * @param {string} [opts.out] output path (default: alongside input with a `-tight` suffix)
 * @param {number} [opts.minStill] seconds — freezes shorter than this are left untouched
 * @param {number} [opts.keep] seconds — each freeze is clamped down to this
 * @param {string} [opts.noise] "auto" (default) or an explicit freezedetect noise level ("-60dB")
 * @param {boolean} [opts.dryRun] plan only — print nothing, encode nothing, return the plan
 * @returns {Promise<{skipped: boolean, dryRun: boolean, inPath: string, outPath: string|null,
 *   totalDuration: number, detectMode: string, detectNoise: string, detectReason: string,
 *   freezes: Array<{start:number,end:number}>, segments: Array<{start:number,end:number,clamped:boolean}>,
 *   warnings: string[], outDuration?: number, cuts?: number, removedSec?: number}>}
 */
export async function tighten(
  inArg,
  { out, minStill = DEFAULT_MIN_STILL_SEC, keep = DEFAULT_KEEP_SEC, noise = DEFAULT_NOISE, dryRun = false } = {},
) {
  const inPath = resolve(inArg);
  if (!(await fileExists(inPath))) {
    throw new Error(`input file not found: ${inPath}`);
  }
  const outPath = out ? resolve(out) : defaultOutPath(inPath);

  const ffmpeg = await resolveFfmpeg();

  let detected;
  try {
    detected = await detectFreezes(ffmpeg, inPath, { minStill, thresholdNoise: noise === 'auto' ? THRESHOLD_NOISE : noise });
  } catch (err) {
    throw new Error(`freeze detection failed: ${err.message}`);
  }
  const { totalDuration, hasAudio } = detected;
  const calibration = calibrate(detected, { noise });
  const freezes = calibration.freezes;

  const base = {
    dryRun,
    inPath,
    totalDuration,
    detectMode: calibration.mode,
    detectNoise: calibration.noise,
    detectReason: calibration.reason,
    freezes,
  };

  if (freezes.length === 0) {
    return { ...base, skipped: true, outPath: null, segments: [], warnings: [] };
  }

  const segments = planSegments(freezes, totalDuration, keep);
  // Summary stats derive from the PLAN (single source of truth), never from the raw freeze
  // list — the plan is what actually gets encoded.
  const keptSec = segments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
  const outDuration = keptSec;
  const removedSec = Math.max(0, totalDuration - keptSec);
  const warnings = sanityWarnings({ totalDuration, keptSec, freezes, calibration, minStill, keep });

  const result = {
    ...base,
    skipped: false,
    outPath: dryRun ? null : outPath,
    segments,
    outDuration,
    cuts: freezes.length,
    removedSec,
    warnings,
  };

  if (dryRun) return result;

  await mkdir(dirname(outPath), { recursive: true });
  try {
    await cut(ffmpeg, inPath, outPath, segments, hasAudio);
  } catch (err) {
    throw new Error(`cut pass failed: ${err.message}`);
  }

  if (!cliOwnsOutput) for (const line of warnings) warn(line);
  return result;
}

function printPlan(result, { minStill, keep }) {
  log(`detect mode: ${result.detectMode} (n=${result.detectNoise}) — ${result.detectReason}`);
  console.log('');
  log(`freeze table (d=${minStill}s), ${result.freezes.length} hold(s):`);
  console.log('        #      start        end   duration');
  result.freezes.forEach((f, i) => {
    console.log(
      `  ${String(i + 1).padStart(7)}  ${f.start.toFixed(3).padStart(9)}  ${f.end.toFixed(3).padStart(9)}  ` +
        `${(f.end - f.start).toFixed(3).padStart(9)}`,
    );
  });
  console.log('');
  log(`keep segments (--keep ${keep}s), ${result.segments.length} segment(s):`);
  console.log('        #      start        end     length  kind');
  result.segments.forEach((s, i) => {
    console.log(
      `  ${String(i + 1).padStart(7)}  ${s.start.toFixed(3).padStart(9)}  ${s.end.toFixed(3).padStart(9)}  ` +
        `${(s.end - s.start).toFixed(3).padStart(9)}  ${s.kind}`,
    );
  });
  console.log('');
}

async function main() {
  cliOwnsOutput = true;
  const { inArg, out, minStill, keep, noise, dryRun } = parseArgs(process.argv.slice(2));

  log(`analyzing ${resolve(inArg)} (freezedetect noise=${noise} d=${minStill}s)...`);
  let result;
  try {
    result = await tighten(inArg, { out, minStill, keep, noise, dryRun });
  } catch (err) {
    console.error(`[tighten] ${err.message}`);
    process.exit(1);
  }

  if (result.skipped) {
    log(`detect mode: ${result.detectMode} (n=${result.detectNoise}) — ${result.detectReason}`);
    log(`no static stretches >= ${minStill}s found — already tight, nothing to cut. Wrote nothing.`);
    process.exit(0);
  }

  if (dryRun) {
    printPlan(result, { minStill, keep });
    log(`input duration:   ${result.totalDuration.toFixed(2)}s`);
    log(`planned duration: ${result.outDuration.toFixed(2)}s`);
    log(`cuts planned:     ${result.cuts}`);
    log(`seconds removed:  ${result.removedSec.toFixed(2)}s`);
    for (const line of result.warnings) warn(line);
    log(`dry run — nothing encoded, nothing written.`);
    process.exit(0);
  }

  log(`detect mode: ${result.detectMode} (n=${result.detectNoise}) — ${result.detectReason}`);
  log(`cutting ${result.cuts} static stretch(es), clamped to ${keep}s each...`);
  console.log('');
  log(`input duration:  ${result.totalDuration.toFixed(2)}s`);
  log(`output duration: ${result.outDuration.toFixed(2)}s`);
  log(`cuts made:       ${result.cuts}`);
  log(`seconds removed: ${result.removedSec.toFixed(2)}s`);
  log(`written: ${result.outPath}`);
  for (const line of result.warnings) warn(line);
}

// Only run the CLI when this file is executed directly — `import { tighten }` (film-web.mjs,
// film-android.mjs / film-ios.mjs --tighten) must not trigger it.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
