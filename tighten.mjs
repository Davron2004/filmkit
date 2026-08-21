#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// tighten.mjs — "tighten" pass: cuts dead air out of an already-rendered demo
// video (app loading waits, Maestro's ~1s safety inactivity windows between actions,
// settle pauses) while keeping the demo watchable. ffmpeg-only, no npm dependencies —
// system ffmpeg, absence handled gracefully; PATH-first tool resolution with a
// grounded fallback path (see lib/tools.mjs).
//
//   node tighten.mjs <in.mp4> [--out <path>] [--min-still <sec, default 1.2>]
//                             [--keep <sec, default 0.6>] [--noise <freezedetect noise, default -60dB>]
//
// STATE MACHINE (one linear pipeline, no back-edges — a tighten run is a single attempt):
//
//   PREFLIGHT → DETECT → PLAN → CUT → done
//
// - PREFLIGHT: resolve ffmpeg (PATH first, then $FILMKIT_FFMPEG, then the grounded fallback);
//   verify the input file exists. Any failure exits non-zero before any output is touched.
// - DETECT (pass 1): resample to constant fps, then run ffmpeg's `freezedetect` filter and
//   parse freeze_start/freeze_duration/freeze_end out of its stderr (freezedetect has no
//   stdout/file output — it's a log-only analysis filter, so this is a `-f null -` pass). The
//   fps= pre-pass is load-bearing on VFR device recordings — see the comment above the call.
//   Parsed intervals are then normalized (clamped, garbage dropped, sorted, overlaps merged).
//   Also reads the input's total duration and whether it has an audio stream off the same
//   stderr (no ffprobe dependency — one tool, one process).
// - PLAN: turn freeze intervals into a keep-segment list — each freeze is clamped to `keep`
//   seconds (see CLAMP CHOICE below), non-frozen stretches pass through untouched. Freezes
//   shorter than `--min-still` were never reported by freezedetect (its own `d` parameter), so
//   they're already left alone by construction — nothing to special-case here.
// - CUT (pass 2): select+setpts via a filter_complex graph (video-only unless the input actually
//   has an audio stream — screen recordings usually don't, but the graph is built generically).
//   No freezes found → print "already tight", write nothing, exit 0 (never emit a copy or a
//   broken file for a no-op run).
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
const DEFAULT_NOISE = '-60dB'; // freezedetect `n` — validated against real footage

function log(msg) {
  console.log(`[tighten] ${msg}`);
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

function parseArgs(argv) {
  const rest = [];
  let out;
  let minStill = DEFAULT_MIN_STILL_SEC;
  let keep = DEFAULT_KEEP_SEC;
  let noise = DEFAULT_NOISE;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out = argv[i + 1];
      i++;
    } else if (argv[i] === '--min-still') {
      minStill = Number(argv[i + 1]);
      i++;
    } else if (argv[i] === '--keep') {
      keep = Number(argv[i + 1]);
      i++;
    } else if (argv[i] === '--noise') {
      noise = argv[i + 1];
      i++;
    } else {
      rest.push(argv[i]);
    }
  }
  if (rest.length !== 1) {
    console.error(
      'usage: node tighten.mjs <in.mp4> [--out <path>] [--min-still <sec, default 1.2>] ' +
        '[--keep <sec, default 0.6>] [--noise <freezedetect noise, default -60dB>]',
    );
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
  return { inArg: rest[0], out, minStill, keep, noise };
}

function defaultOutPath(inPath) {
  const dir = dirname(inPath);
  const ext = extname(inPath);
  const base = basename(inPath, ext);
  return join(dir, `${base}-tight${ext}`);
}

// ── DETECT (pass 1): run freezedetect, parse its stderr ────────────────────────────────────
// The `fps=` resample BEFORE freezedetect is load-bearing: device recordings (adb screenrecord,
// simctl recordVideo) are variable-frame-rate with exotic container timebases, and freezedetect's
// clock provably derates on them — observed on a simctl recording: a freeze_end logged EARLIER
// than its own freeze_start, plus phantom freezes covering regions that contain real motion.
// Resampling to constant fps first gives every frame sane, evenly-spaced timestamps; static
// content stays static under duplication, so freeze semantics are unchanged.
//
// freezedetect logs freeze_start the moment a freeze is CONFIRMED (i.e. `d` seconds after it
// actually began, timestamped at the true start), then logs freeze_duration+freeze_end together
// once the freeze breaks. A freeze still active at end of stream never gets a freeze_end line —
// handled below by closing it out at the input's total duration.
async function detectFreezes(ffmpeg, inPath, { minStill, noise }) {
  const args = [
    '-hide_banner',
    '-nostats',
    '-i',
    inPath,
    '-vf',
    `fps=fps=${NORMALIZED_FPS},freezedetect=n=${noise}:d=${minStill}`,
    '-map',
    '0:v',
    '-f',
    'null',
    '-',
  ];
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

  const freezes = [];
  let pendingStart = null;
  let pendingDuration = null;
  for (const line of stderr.split('\n')) {
    const startMatch = line.match(/lavfi\.freezedetect\.freeze_start:\s*([\d.]+)/);
    if (startMatch) {
      pendingStart = Number(startMatch[1]);
      continue;
    }
    const durationMatchLine = line.match(/lavfi\.freezedetect\.freeze_duration:\s*([\d.]+)/);
    if (durationMatchLine) {
      pendingDuration = Number(durationMatchLine[1]);
      continue;
    }
    const endMatch = line.match(/lavfi\.freezedetect\.freeze_end:\s*([\d.]+)/);
    if (endMatch && pendingStart !== null) {
      freezes.push({ start: pendingStart, end: Number(endMatch[1]), duration: pendingDuration });
      pendingStart = null;
      pendingDuration = null;
    }
  }
  if (pendingStart !== null) {
    // Freeze was still active when the stream ended — close it out at the input's duration.
    freezes.push({ start: pendingStart, end: totalDuration, duration: totalDuration - pendingStart });
  }

  return { freezes: normalizeFreezes(freezes, totalDuration), totalDuration, hasAudio };
}

// ── normalize: clamp to the timeline, drop garbage, sort, merge overlaps ────────────────────
// Even with the fps= pre-pass, treat freezedetect's output as untrusted: malformed intervals
// (end <= start), out-of-order entries, and overlaps must degrade gracefully instead of
// producing an inverted cut plan (which once yielded a NEGATIVE output duration). Sorted,
// merged, clamped intervals are exactly the precondition planSegments already relies on.
function normalizeFreezes(freezes, totalDuration) {
  const clean = [];
  for (const f of [...freezes].sort((a, b) => a.start - b.start)) {
    const start = Math.max(0, f.start);
    const end = Math.min(totalDuration, f.end);
    if (end <= start) continue; // malformed (e.g. a bogus freeze_end from VFR timebase confusion)
    const last = clean[clean.length - 1];
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end); // overlap — extend rather than double-plan
    } else {
      clean.push({ start, end });
    }
  }
  return clean;
}

// ── PLAN: normalized freeze intervals → keep-segment list ───────────────────────────────────
function planSegments(freezes, totalDuration, keep) {
  const segments = [];
  let cursor = 0;
  for (const freeze of freezes) {
    if (freeze.start > cursor) {
      segments.push({ start: cursor, end: freeze.start, clamped: false });
    }
    const clampEnd = Math.min(freeze.start + keep, freeze.end);
    if (clampEnd > freeze.start) {
      segments.push({ start: freeze.start, end: clampEnd, clamped: true });
    }
    cursor = Math.max(cursor, freeze.end);
  }
  if (totalDuration > cursor) {
    segments.push({ start: cursor, end: totalDuration, clamped: false });
  }
  return segments.filter((seg) => seg.end > seg.start);
}

// Constant frame rate the whole graph operates in — see the VFR GOTCHA note in the header
// comment. 30fps is a conservative, standard choice: high enough that a `keep`-second clamp
// always contains real (duplicate, since the source was static) frames, low enough not to
// meaningfully bloat the encode for a short demo clip.
const NORMALIZED_FPS = 30;

// ── CUT (pass 2): select+setpts filter_complex graph ────────────────────────────────────────
// One linear chain per stream (video always; audio only if the input actually has it) — no
// trim/concat, no split, see the VFR GOTCHA note above for why.
function buildFilterGraph(segments, hasAudio) {
  // `between(t,S,E)` is 0/1 per frame; summing (rather than logically OR-ing) is fine because
  // segments are sorted and non-overlapping, so at most one term is ever nonzero for a given t.
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
 * Run the full tighten pipeline (DETECT → PLAN → CUT) against `inArg` and return a summary —
 * the library entrypoint film-web.mjs / film-android.mjs / film-ios.mjs call directly via their
 * `--tighten` flag (in-process, no subprocess spawn of this file). Throws on a real failure
 * (ffmpeg missing, input not found, freezedetect/cut failure); returns `{ skipped: true, ... }`
 * rather than throwing for the "nothing to cut" case, since that's a normal (not error) outcome.
 *
 * @param {string} inArg path to the input .mp4
 * @param {object} [opts]
 * @param {string} [opts.out] output path (default: alongside input with a `-tight` suffix)
 * @param {number} [opts.minStill] seconds — freezes shorter than this are left untouched
 * @param {number} [opts.keep] seconds — each freeze is clamped down to this
 * @param {string} [opts.noise] freezedetect noise threshold (e.g. "-60dB")
 * @returns {Promise<{skipped: boolean, inPath: string, outPath: string|null, totalDuration: number,
 *   outDuration?: number, cuts?: number, removedSec?: number}>}
 */
export async function tighten(
  inArg,
  { out, minStill = DEFAULT_MIN_STILL_SEC, keep = DEFAULT_KEEP_SEC, noise = DEFAULT_NOISE } = {},
) {
  const inPath = resolve(inArg);
  if (!(await fileExists(inPath))) {
    throw new Error(`input file not found: ${inPath}`);
  }
  const outPath = out ? resolve(out) : defaultOutPath(inPath);

  const ffmpeg = await resolveFfmpeg();

  let freezes, totalDuration, hasAudio;
  try {
    ({ freezes, totalDuration, hasAudio } = await detectFreezes(ffmpeg, inPath, { minStill, noise }));
  } catch (err) {
    throw new Error(`freeze detection failed: ${err.message}`);
  }

  if (freezes.length === 0) {
    return { skipped: true, inPath, outPath: null, totalDuration };
  }

  const segments = planSegments(freezes, totalDuration, keep);
  // Summary stats derive from the PLAN (single source of truth), never from the raw freeze
  // list — the plan is what actually gets encoded.
  const keptSec = segments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
  const outDuration = keptSec;
  const removedSec = Math.max(0, totalDuration - keptSec);

  await mkdir(dirname(outPath), { recursive: true });
  try {
    await cut(ffmpeg, inPath, outPath, segments, hasAudio);
  } catch (err) {
    throw new Error(`cut pass failed: ${err.message}`);
  }

  return { skipped: false, inPath, outPath, totalDuration, outDuration, cuts: freezes.length, removedSec };
}

async function main() {
  const { inArg, out, minStill, keep, noise } = parseArgs(process.argv.slice(2));

  log(`analyzing ${resolve(inArg)} (freezedetect n=${noise} d=${minStill}s)...`);
  let result;
  try {
    result = await tighten(inArg, { out, minStill, keep, noise });
  } catch (err) {
    console.error(`[tighten] ${err.message}`);
    process.exit(1);
  }

  if (result.skipped) {
    log(`no static stretches >= ${minStill}s found — already tight, nothing to cut. Wrote nothing.`);
    process.exit(0);
  }

  log(`cutting ${result.cuts} static stretch(es), clamped to ${keep}s each...`);
  console.log('');
  log(`input duration:  ${result.totalDuration.toFixed(2)}s`);
  log(`output duration: ${result.outDuration.toFixed(2)}s`);
  log(`cuts made:       ${result.cuts}`);
  log(`seconds removed: ${result.removedSec.toFixed(2)}s`);
  log(`written: ${result.outPath}`);
}

// Only run the CLI when this file is executed directly — `import { tighten }` (film-web.mjs,
// film-android.mjs / film-ios.mjs --tighten) must not trigger it.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
