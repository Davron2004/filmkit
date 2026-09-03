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
//                             [--sidecar <path> | --no-sidecar] [--detect-from <path>]
//                             [--force] [--dry-run]
//
// STATE MACHINE (one linear pipeline, no back-edges — a tighten run is a single attempt):
//
//   PREFLIGHT → PROTECT → DETECT → CALIBRATE → PLAN → (dry-run stops here) → CUT → done
//
// - PREFLIGHT: resolve ffmpeg (PATH first, then $FILMKIT_FFMPEG, then the grounded fallback);
//   verify the input file exists; as a CLI, refuse to overwrite an existing output unless --force
//   (the library entrypoint overwrites silently — the cameras own their own preflight and already
//   refuse there). When `--detect-from`/`opts.detectFrom` is given, this is also where the pair is
//   guarded: ffprobe both files and refuse (before touching DETECT) if their durations differ by
//   more than 2 frames at the normalized fps or their frame sizes differ — see DETECT-FROM below.
//   Any failure exits non-zero before any output is touched.
// - PROTECT: collect the spans of the timeline that must survive at full length — see PROTECTED
//   RANGES below. Runs before DETECT, not after, so a bad `--sidecar` path fails in under a
//   millisecond instead of after a full decode.
// - DETECT (pass 1): resample to constant fps, then run TWO `freezedetect` filters chained in
//   the same graph — an exact-match probe (`n=0`) and a threshold probe (`n=<--noise>`, default
//   -60dB) — and parse freeze_start/freeze_duration/freeze_end for each out of ffmpeg's stderr
//   (freezedetect has no stdout/file output — it's a log-only analysis filter, so this is a
//   `-f null -` pass). Chained freezedetects pass frames through untouched, so both probes see
//   exactly the same frames and one decode serves both. The fps= pre-pass is load-bearing on VFR
//   device recordings — see the comment above the call. Parsed intervals are normalized
//   (clamped, garbage dropped, sorted, genuinely-overlapping ones merged). Also reads the input's
//   total duration and whether it has an audio stream off the same stderr (no ffprobe dependency
//   for the normal path — one tool, one process; ffprobe is only invoked at all when
//   `--detect-from` needs the guard above). This pass runs against `--detect-from`'s file when one
//   was given and validated, `inPath` otherwise — see DETECT-FROM below.
// - CALIBRATE: pick which probe's table to plan from. See RECORDER NOISE FLOOR below.
// - PLAN: turn freeze intervals into a keep-segment list — each freeze is clamped to `keep`
//   seconds (see CLAMP CHOICE below) unless it overlaps a protected range (see PROTECTED RANGES
//   below), non-frozen stretches pass through untouched. Freezes
//   shorter than `--min-still` were never reported by freezedetect (its own `d` parameter), so
//   they're already left alone by construction — nothing to special-case here. The plan is then
//   checked against a SANITY FLOOR (below), which warns but never blocks.
// - CUT (pass 2): select+setpts via a filter_complex graph (video-only unless `inPath` actually
//   has an audio stream — screen recordings usually don't, but the graph is built generically).
//   The `select`/`aselect` window expression is `between(t,S,E)` in SECONDS, not frame indices, so
//   a plan built from `--detect-from`'s (possibly VFR) timeline applies unmodified to `inPath`'s
//   (possibly different-fps, e.g. 60fps CFR post-burn) timeline — both files share the same
//   real-world clock by construction (the burn is a re-encode of the same capture, not a re-shoot),
//   and DETECT-FROM's guard already rejected the pair if that assumption doesn't hold.
//   No freezes found → print "already tight", write nothing, exit 0 (never emit a copy or a
//   broken file for a no-op run). Same for a plan that removes nothing measurable — every hold
//   protected, or every hold shorter than `--keep` — which is a no-op by a different route. `--dry-run` stops before this step and prints the freeze table
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
// DETECT-FROM — a device recorder can defeat its own frame-exactness. `film-android`/`film-ios`
// draw tap-ring indicators onto a take by re-encoding it (h264, constant frame rate) so a viewer
// can see where the demo tapped. That re-encode is itself a fresh source of quantization noise on
// every frame, exactly like the web camera's x264 output — so the SAME recording that is
// frame-exact before the burn (measured on one Android take: 81% of the clip bit-identical, exact
// mode, n=0) reads as 0% frame-exact after it, CALIBRATE falls back to the -60dB threshold probe,
// and that threshold is the one this file already documents as unreliable on device footage (see
// RECORDER NOISE FLOOR above — it was tuned against the web camera's noise floor, not this one).
// Worse, the two files don't even agree on WHERE a hold is: on that same take the first freeze was
// measured at 0.000-7.833s pre-burn and 0.067-10.200s post-burn once threshold mode kicked in.
// `opts.detectFrom` / `--detect-from <path>` is the fix: DETECT and CALIBRATE run against that
// file instead of the one being cut, and only the resulting PLAN — a list of second-denominated
// keep segments — is carried over and applied to `inPath` in CUT. A camera that still has its
// pre-burn copy on hand at the moment it calls tighten() should pass it here rather than let
// tighten discover the burn's noise floor the hard way. Guarded (see the duration/size check right
// below PREFLIGHT in `tighten()`) because a plan built from one file only means something on
// another file if they are, modulo the burn itself, the same recording: same picture, same length.
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
// PROTECTED RANGES — the fix for "tighten made my captions unreadable". A caption hold is
// deliberately static: the web camera draws a caption and then holds the frame for 1.8-2.4s
// precisely so a viewer can read it. freezedetect cannot tell that hold apart from an app-loading
// wait — both are motionless pixels — so the clamp above ate them, and a captioned take came back
// with every caption flashed for 0.6s. Measured on one take: 19 freezes of 1.2-3.3s, all clamped,
// 59.9s in, 35.5s out, unreadable.
// Pixels can't answer this; only the thing that authored the pause can. So the web camera writes a
// sidecar `<name>.json` beside `<name>.mp4` listing its own timeline (`{kind: "caption"|"pause"|
// "tap", start, end}`), tighten reads it, and the PLAN treats those spans as untouchable. The
// device cameras (film-android.mjs, film-ios.mjs) write the same top-level `timeline` array with
// `kind: "tap"` entries — one per drawn ring, padded start/end so a leading-edge clamp cannot cut
// a tap (and its ring) that lands late in a long still stretch; see PROTECT_KINDS below and each
// camera's own SHOW_TAPS section for the padding. Per freeze the
// kept span becomes the UNION of (its first `keep` seconds) and (its intersection with every
// protected range, each widened by `protectMarginSec`):
//   - union covers the whole freeze                → SPARED (nothing cut, e.g. a caption hold that
//                                                    is protected end to end)
//   - union is one contiguous span                 → CLAMPED (the classic case; also the case where
//                                                    protection merely stretches the kept beat)
//   - union has a hole in it                       → SPLIT: the unprotected hole is cut and both
//                                                    sides survive.
// A hole is only cut when it is longer than `minStill`. A shorter one buys back a fraction of a
// second and costs an extra segment in the plan, and sub-`minStill` removals are the thing this
// tool already refuses to make anywhere else (freezedetect's own `d` never reports them) — so they
// are kept. That floor applies to interior holes ONLY: the region after the last kept span (and,
// when `--keep 0`, before the first) is the ordinary clamp tail, which is routinely shorter than
// `minStill` in the unprotected case too, and cutting it is exactly the behaviour this tool is for.
// The margin exists because a sidecar's clock may be approximate: a camera that timestamps against
// wall-clock rather than frame numbers can be off by a few hundred ms in either direction, and a
// caption protected 0.4s late is a caption clipped at the front. `clock: "frame"` (exact) takes
// margin 0, `clock: "approximate"` takes 0.5s. Widening only ever keeps MORE, so it degrades
// toward "less tightening", never toward "unreadable".
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
import { access, mkdir, readFile } from 'node:fs/promises';
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

// ── PROTECTED RANGES (see the header section of that name) ───────────────────────────────────
// Sidecar timeline kinds worth protecting from the clamp. `caption`/`pause` mean "a human is
// meant to be reading this"; `tap` means "a touch (and its ring) happened here and must not be
// cut out from under it" — a different reason, same mechanism. Anything else a camera chooses to
// record in its timeline (action markers, step logs) is ignored rather than protected, so the
// sidecar format can grow without silently changing what tighten cuts.
const PROTECT_KINDS = new Set(['caption', 'pause', 'tap']);
// Slack added to BOTH sides of every protected range, chosen by the sidecar's declared clock.
// "frame" means the writer counted frames and its numbers are exact. "approximate" means they came
// from a wall clock running alongside the recording and can drift a few hundred ms either way; 0.5s
// covers the drift the web camera can accumulate between its own clock and the encoder's. An
// unrecognised or missing clock is treated as approximate: keeping half a second too much is a
// rounding error, clipping the first word of a caption is the bug this mechanism exists to stop.
const PROTECT_MARGIN_BY_CLOCK = { frame: 0, approximate: 0.5 };
const DEFAULT_PROTECT_MARGIN_SEC = PROTECT_MARGIN_BY_CLOCK.approximate;

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

// Below this the plan removes less than one frame at the working frame rate, i.e. it is a no-op:
// re-encoding a whole clip to remove nothing produces a second file that is a worse copy of the
// first. Reachable two ways — every freeze protected end to end, or --keep >= every freeze.
const NO_OP_REMOVAL_SEC = 1 / NORMALIZED_FPS;

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

// ── DETECT-FROM guard: ffprobe both files in the pair ───────────────────────────────────────
// The only place in this file that shells out to ffprobe rather than ffmpeg, and only when
// `--detect-from` is given — see DETECT-FROM in the header comment for why this check exists and
// PREFLIGHT above for where it runs.
async function ffprobeInfo(ffprobe, path) {
  const args = ['-v', 'error', '-of', 'json', '-show_format', '-show_streams', path];
  let stdout;
  try {
    ({ stdout } = await execFileP(ffprobe, args, { maxBuffer: 16 * 1024 * 1024 }));
  } catch (err) {
    throw new Error(`ffprobe failed on ${path}: ${err.stderr || err.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`could not parse ffprobe output for ${path}: ${err.message}`);
  }
  const durationSec = Number(doc?.format?.duration);
  if (!Number.isFinite(durationSec)) {
    throw new Error(`ffprobe reported no usable duration for ${path}`);
  }
  const streams = Array.isArray(doc.streams) ? doc.streams : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const width = Number(video?.width);
  const height = Number(video?.height);
  if (!video || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(`ffprobe reported no usable video stream/frame size for ${path}`);
  }
  const hasAudio = streams.some((s) => s.codec_type === 'audio');
  return { durationSec, width, height, hasAudio };
}

// Compare `detectPath` (what `--detect-from` names) against `inPath` (what CUT will actually
// touch) and refuse the pair if a plan built from one couldn't be trusted to apply to the other.
// Two failure modes, both fatal (this is a correctness guard, not a warning — see SANITY FLOOR
// above for the contrast: that one warns because a bad plan might still be what the operator
// wants, this one throws because a plan from the wrong file is never what anyone wants):
//   - duration drift beyond 2 frames at NORMALIZED_FPS: the files aren't the same recording (or
//     one is truncated relative to the other), so segment timestamps from one don't mean the same
//     thing on the other.
//   - frame size mismatch: burning tap rings in re-encodes but does not resize, so a size
//     difference means these were never the same take.
async function guardDetectFrom(detectPath, inPath) {
  let ffprobe;
  try {
    ffprobe = await resolveTool('ffprobe');
  } catch (err) {
    throw new Error(`--detect-from needs ffprobe to guard the pair, and it could not be found: ${err.message}`);
  }
  const [detectInfo, cutInfo] = await Promise.all([ffprobeInfo(ffprobe, detectPath), ffprobeInfo(ffprobe, inPath)]);
  const maxDriftSec = 2 / NORMALIZED_FPS;
  const driftSec = Math.abs(detectInfo.durationSec - cutInfo.durationSec);
  if (driftSec > maxDriftSec) {
    throw new Error(
      `--detect-from ${detectPath} (${detectInfo.durationSec.toFixed(3)}s) and ${inPath} ` +
        `(${cutInfo.durationSec.toFixed(3)}s) differ by ${driftSec.toFixed(3)}s — more than 2 frames at ` +
        `${NORMALIZED_FPS}fps (${maxDriftSec.toFixed(3)}s). Refusing: they don't look like the same recording, ` +
        `and a plan built from one would not line up with a cut made on the other.`,
    );
  }
  if (detectInfo.width !== cutInfo.width || detectInfo.height !== cutInfo.height) {
    throw new Error(
      `--detect-from ${detectPath} is ${detectInfo.width}x${detectInfo.height} but ${inPath} is ` +
        `${cutInfo.width}x${cutInfo.height}. Refusing: a burned-in overlay keeps the frame size, so a size ` +
        `mismatch here means these are not the same recording.`,
    );
  }
  return { detectFromDurationSec: detectInfo.durationSec, inPathDurationSec: cutInfo.durationSec, cutHasAudio: cutInfo.hasAudio };
}

const USAGE =
  'usage: node tighten.mjs <in.mp4> [--out <path>] [--min-still <sec, default 1.2>] ' +
  '[--keep <sec, default 0.6>] [--noise <auto | freezedetect noise, e.g. -60dB>] ' +
  '[--sidecar <path> | --no-sidecar] [--detect-from <path>] [--force] [--dry-run]\n' +
  '\n' +
  '  Static stretches are clamped to --keep seconds, EXCEPT where a sidecar says a human is\n' +
  '  supposed to be reading the screen, or a tap landed there. By default that sidecar is\n' +
  '  <in>.json (written next to <in>.mp4 by the web/Android/iOS cameras); its caption/pause/tap\n' +
  '  entries are kept at full length.\n' +
  '    --sidecar <path>   read protected ranges from this file instead of <in>.json\n' +
  '                       (unlike the automatic one, a missing/malformed file here is an error)\n' +
  '    --no-sidecar       ignore <in>.json — clamp every static stretch, protect nothing\n' +
  '    --detect-from <path>  analyze this file instead of <in.mp4> and apply the resulting plan to\n' +
  '                       <in.mp4> — for a device take that has been re-encoded (e.g. to burn in tap\n' +
  '                       rings), point this at the pre-burn copy so freeze detection sees the\n' +
  '                       original frame-exact frames instead of the re-encode\'s quantization noise.\n' +
  '                       Refused if the two files\' durations differ by more than 2 frames or their\n' +
  '                       frame sizes differ.\n' +
  '    --force            overwrite an existing output file instead of refusing';

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
  let sidecarPath;
  let noSidecar = false;
  let detectFrom;
  let force = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sidecar') {
      sidecarPath = valueFor(argv, i, '--sidecar');
      i++;
    } else if (argv[i] === '--no-sidecar') {
      noSidecar = true;
    } else if (argv[i] === '--detect-from') {
      detectFrom = valueFor(argv, i, '--detect-from');
      i++;
    } else if (argv[i] === '--force') {
      force = true;
    } else if (argv[i] === '--out') {
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
  // Asking for a specific sidecar AND for no sidecar is not a preference to be resolved by
  // precedence — it is two incompatible intentions, and guessing which one wins is how a caption
  // hold gets eaten by a flag the operator thought they had disabled.
  if (sidecarPath !== undefined && noSidecar) {
    usageError('--sidecar and --no-sidecar contradict each other — pass one or the other');
  }
  return {
    inArg: rest[0],
    out,
    minStill,
    keep,
    noise,
    sidecar: noSidecar ? false : sidecarPath,
    detectFrom,
    force,
    dryRun,
  };
}

function defaultOutPath(inPath) {
  const dir = dirname(inPath);
  const ext = extname(inPath);
  const base = basename(inPath, ext);
  return join(dir, `${base}-tight${ext}`);
}

// The CLI has to know the output path BEFORE calling tighten() (to refuse an overwrite), and
// tighten() has to know it to write — one function so the two can never disagree about which file
// is at stake.
function outPathFor(inPath, out) {
  return out ? resolve(out) : defaultOutPath(inPath);
}

// The sidecar the web camera writes beside its recording: out/demo.mp4 -> out/demo.json.
function sidecarPathFor(inPath) {
  const ext = extname(inPath);
  return join(dirname(inPath), `${basename(inPath, ext)}.json`);
}

function frozenSeconds(freezes) {
  return freezes.reduce((sum, f) => sum + (f.end - f.start), 0);
}

// ── PROTECT: which spans of the timeline must survive at full length ────────────────────────
// See PROTECTED RANGES in the header comment for why this exists at all.
//
// Widen every range by the margin, then sort and merge. Merging happens on TOUCH (`<=`), not on
// genuine overlap the way normalizeFreezes does — the reason that distinction is load-bearing for
// freezes (two touching holds are two beats with a change frame between them) has no analogue
// here: a protected range is a set of seconds to keep, and two touching ranges keep exactly the
// same seconds whether they are stored as one entry or two.
function widenAndMergeRanges(ranges, marginSec) {
  const widened = [];
  for (const range of ranges || []) {
    const start = Number(range?.start);
    const end = Number(range?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue; // untrusted input
    widened.push({ start: Math.max(0, start - marginSec), end: end + marginSec });
  }
  widened.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of widened) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push(range);
  }
  return merged;
}

// Pull the protectable entries out of a parsed sidecar document. Returns null when the document
// is not a timeline sidecar at all (so the caller can tell "wrong file" from "no captions in it").
function readTimeline(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.timeline)) return null;
  const ranges = [];
  let malformed = 0;
  for (const entry of doc.timeline) {
    if (!entry || typeof entry !== 'object' || !PROTECT_KINDS.has(entry.kind)) continue;
    const start = Number(entry.start);
    const end = Number(entry.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      malformed++;
      continue;
    }
    ranges.push({ start, end });
  }
  const clock = typeof doc.clock === 'string' ? doc.clock : null;
  // Object.hasOwn, not `in`: `'toString' in PROTECT_MARGIN_BY_CLOCK` is true, and a sidecar
  // claiming `"clock": "toString"` would then hand a function to toFixed().
  return { ranges, malformed, clock, knownClock: clock !== null && Object.hasOwn(PROTECT_MARGIN_BY_CLOCK, clock) };
}

// Resolve the protected ranges for this run. Precedence:
//   opts.protect (an array, even an empty one) > opts.sidecar (false = off, string = that file)
//   > the automatic <in>.json beside the video
// A caller that computed its own ranges knows more than a file on disk, and passing `[]` is a
// legitimate way to say "protect nothing" without also disabling a future sidecar mechanism.
//
// The two failure modes are deliberately asymmetric. An EXPLICIT --sidecar that is missing or
// malformed throws: you named a file, it isn't usable, and quietly clamping the captions you were
// trying to protect is the worst possible response. An AUTOMATIC <in>.json that is malformed only
// warns: a stray or half-written JSON file next to a video must not fail a tighten pass that would
// otherwise be fine. An automatic sidecar that simply doesn't exist is the normal case for device
// footage and says nothing at all.
async function resolveProtection(inPath, { protect, protectMarginSec, sidecar }) {
  const pinnedMargin = Number.isFinite(protectMarginSec) ? Math.max(0, protectMarginSec) : null;
  const none = { source: null, ranges: [], marginSec: 0 };

  if (Array.isArray(protect)) {
    const marginSec = pinnedMargin ?? 0; // exact by default — the caller owns these numbers
    return { source: 'opts.protect', ranges: widenAndMergeRanges(protect, marginSec), marginSec };
  }
  if (sidecar === false) return none;

  const requested = typeof sidecar === 'string' && sidecar.trim() !== '';
  const path = requested ? resolve(sidecar) : sidecarPathFor(inPath);
  const fail = (msg) => {
    if (requested) throw new Error(`--sidecar ${path}: ${msg}`);
    warn(`ignoring sidecar ${path}: ${msg} — protecting nothing, captions may be clamped`);
    return none;
  };

  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (requested) throw new Error(`--sidecar ${path}: cannot read it (${err.code || err.message})`);
    return none; // no sidecar next to the video is the normal case, not a problem
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return fail(`not valid JSON (${err.message})`);
  }
  const timeline = readTimeline(doc);
  if (!timeline) return fail('no `timeline` array in it');

  const marginSec = pinnedMargin ?? (timeline.knownClock ? PROTECT_MARGIN_BY_CLOCK[timeline.clock] : DEFAULT_PROTECT_MARGIN_SEC);
  const clockNote = timeline.knownClock
    ? `clock=${timeline.clock}`
    : `clock=${timeline.clock === null ? 'unstated' : timeline.clock} (unrecognised — treated as approximate)`;
  const ranges = widenAndMergeRanges(timeline.ranges, marginSec);
  log(
    `protecting ${ranges.length} range(s) from ${path} — ` +
      `${timeline.ranges.length} caption/pause/tap entr(ies), ${clockNote}, margin ${marginSec.toFixed(2)}s` +
      (pinnedMargin !== null ? ' (pinned by caller)' : ''),
  );
  if (timeline.malformed > 0) {
    warn(`${path}: skipped ${timeline.malformed} timeline entr(ies) with unusable start/end`);
  }
  return { source: path, ranges, marginSec };
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

function intersection(a, b) {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end > start ? { start, end } : null;
}

// ── PLAN, one freeze: kept span(s) for a single freeze interval ─────────────────────────────
// THE RULE (see PROTECTED RANGES in the header comment for the why):
//   1. base       = the first `keep` seconds of the freeze — the classic clamp, unchanged.
//   2. union      = base ∪ (freeze ∩ every protected range). Protected ranges arrive already
//                   widened by the margin, so nothing here has to know about clocks.
//   3. small holes= any hole in that union that is <= minStill is filled back in (kept), because a
//                   sub-minStill removal buys a fraction of a second and costs a cut. The floor
//                   applies to INTERIOR holes only — the tail after the last kept span is the
//                   ordinary clamp tail, which is routinely shorter than minStill in the
//                   unprotected case too, and removing it is the whole point of the tool.
//   4. what is left is the kept span list: one span = clamped (or spared, if it covers the freeze
//                   end to end), more than one = split, none = cut (only reachable with --keep 0
//                   and no protection).
// With `protect` empty this reduces, span for span, to the pre-protection behaviour: `union` is
// just `base`, there are no holes, and the result is the single clamped span.
function planFreeze(freeze, { keep, protect, minStill }) {
  const clampEnd = Math.min(freeze.start + keep, freeze.end);
  const base = clampEnd > freeze.start ? [{ start: freeze.start, end: clampEnd, protectedSpan: false }] : [];

  const spans = [...base];
  for (const range of protect) {
    const hit = intersection(freeze, range);
    if (hit) spans.push({ ...hit, protectedSpan: true });
  }
  spans.sort((a, b) => a.start - b.start);

  const union = [];
  for (const span of spans) {
    const last = union[union.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      last.protectedSpan = last.protectedSpan || span.protectedSpan;
    } else {
      union.push({ ...span });
    }
  }

  const keeps = [];
  for (const span of union) {
    const last = keeps[keeps.length - 1];
    if (last && span.start - last.end <= minStill) {
      last.end = Math.max(last.end, span.end); // hole too short to be worth a cut — keep it
      last.protectedSpan = last.protectedSpan || span.protectedSpan;
    } else {
      keeps.push({ ...span });
    }
  }

  const spared = keeps.length === 1 && keeps[0].start <= freeze.start && keeps[0].end >= freeze.end;
  const disposition = keeps.length === 0 ? 'cut' : spared ? 'spared' : keeps.length > 1 ? 'split' : 'clamped';
  // "touched" means protection CHANGED the outcome, not merely that a protected range overlapped:
  // a caption whose hold is shorter than --keep is already kept in full by the clamp, and counting
  // it would overstate what protection is doing.
  const changed =
    keeps.length !== base.length || keeps.some((k, i) => k.start !== base[i].start || k.end !== base[i].end);
  return { start: freeze.start, end: freeze.end, keeps, disposition, protectedChanged: changed };
}

// ── PLAN: normalized freeze intervals → keep-segment list ───────────────────────────────────
// Adjacent output segments are coalesced so the `select` expression stays small and every term
// is mutually exclusive (which is what lets buildFilterGraph sum them instead of OR-ing).
// Returns the segment list plus the per-freeze decision behind it (what `--dry-run` reports and
// what `result.protected.freezesTouched` counts) — one pass, so the two can never disagree.
function planSegments(freezes, totalDuration, keep, { protect = [], minStill = DEFAULT_MIN_STILL_SEC } = {}) {
  const segments = [];
  const push = (start, end, clamped, label) => {
    if (end <= start) return;
    const kind = clamped ? label : 'motion';
    const last = segments[segments.length - 1];
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
      last.clamped = last.clamped && clamped;
      if (last.kind !== kind) last.kind = 'motion + beat';
      return;
    }
    segments.push({ start, end, clamped, kind });
  };
  const freezePlans = [];
  let cursor = 0;
  for (const freeze of freezes) {
    if (freeze.start > cursor) {
      push(cursor, freeze.start, false);
    }
    const plan = planFreeze(freeze, { keep, protect, minStill });
    for (const span of plan.keeps) {
      push(span.start, span.end, true, span.protectedSpan ? 'protected hold' : 'held beat');
    }
    freezePlans.push(plan);
    cursor = Math.max(cursor, freeze.end);
  }
  if (totalDuration > cursor) {
    push(cursor, totalDuration, false);
  }
  return { segments, freezePlans };
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
 * @param {Array<{start:number,end:number}>} [opts.protect] spans (seconds on the input's timeline)
 *   that must survive at full length — caption holds, deliberate pauses, and taps. Given
 *   explicitly, this wins over any sidecar; `[]` means "protect nothing". See PROTECTED RANGES in
 *   the header.
 * @param {number} [opts.protectMarginSec] slack added to both sides of every protected range.
 *   Default 0 for caller-supplied ranges, or the sidecar's clock-derived value (frame: 0,
 *   approximate: 0.5). Passing it pins the margin regardless of what the sidecar claims.
 * @param {string|false} [opts.sidecar] path to a sidecar to read protected ranges from, or `false`
 *   to skip the automatic `<in>.json` lookup entirely. An explicit path that is missing or
 *   malformed throws; the automatic one only warns.
 * @param {string} [opts.detectFrom] path to a file to run DETECT/CALIBRATE against instead of
 *   `inArg` — the resulting plan (second-denominated, so timebase-independent) is still applied to
 *   `inArg` in CUT. See DETECT-FROM in the header comment. Guarded: throws if the two files'
 *   durations differ by more than 2 frames at the normalized fps, or their frame sizes differ.
 * @param {boolean} [opts.dryRun] plan only — print nothing, encode nothing, return the plan
 * @returns {Promise<{skipped: boolean, skipReason: string|null, dryRun: boolean, inPath: string,
 *   outPath: string|null, totalDuration: number, detectFrom: string|null,
 *   detectFromDurationSec: number|null, inPathDurationSec: number|null, detectMode: string,
 *   detectNoise: string, detectReason: string, freezes: Array<{start:number,end:number}>,
 *   freezePlans: Array<{start:number,end:number,keeps:Array<{start:number,end:number}>,
 *     disposition:'clamped'|'split'|'spared'|'cut', protectedChanged:boolean}>,
 *   protected: {source: string|null, ranges: Array<{start:number,end:number}>, marginSec: number,
 *     freezesTouched: number},
 *   segments: Array<{start:number,end:number,clamped:boolean}>,
 *   warnings: string[], outDuration?: number, cuts?: number, removedSec?: number}>}
 */
export async function tighten(
  inArg,
  {
    out,
    minStill = DEFAULT_MIN_STILL_SEC,
    keep = DEFAULT_KEEP_SEC,
    noise = DEFAULT_NOISE,
    protect,
    protectMarginSec,
    sidecar,
    detectFrom,
    dryRun = false,
  } = {},
) {
  const inPath = resolve(inArg);
  if (!(await fileExists(inPath))) {
    throw new Error(`input file not found: ${inPath}`);
  }
  // The library entrypoint overwrites its output silently and on purpose: film-web / film-android /
  // film-ios each run their own preflight over the whole set of files a take produces, and a second
  // refusal here would fire after the recording exists, when there is nothing useful to do about it.
  // The CLI (main()) does refuse — see PREFLIGHT.
  const outPath = outPathFor(inPath, out);

  const ffmpeg = await resolveFfmpeg();

  // DETECT-FROM (see the header comment of that name): DETECT/CALIBRATE run against `detectPath`,
  // CUT still runs against `inPath`. Absent, `detectPath` is just `inPath` and every line below
  // this block behaves exactly as it did before this feature existed.
  const detectFromGiven = typeof detectFrom === 'string' && detectFrom.trim() !== '';
  let detectPath = inPath;
  let detectFromDurationSec = null;
  let inPathDurationSec = null;
  let cutHasAudioOverride = null;
  if (detectFromGiven) {
    detectPath = resolve(detectFrom);
    if (!(await fileExists(detectPath))) {
      throw new Error(`--detect-from file not found: ${detectPath}`);
    }
    const guard = await guardDetectFrom(detectPath, inPath);
    detectFromDurationSec = guard.detectFromDurationSec;
    inPathDurationSec = guard.inPathDurationSec;
    cutHasAudioOverride = guard.cutHasAudio;
    log(`detecting from ${detectPath}, cutting ${inPath} (durations ${detectFromDurationSec.toFixed(3)}s / ${inPathDurationSec.toFixed(3)}s)`);
  }

  const protection = await resolveProtection(inPath, { protect, protectMarginSec, sidecar });

  let detected;
  try {
    detected = await detectFreezes(ffmpeg, detectPath, {
      minStill,
      thresholdNoise: noise === 'auto' ? THRESHOLD_NOISE : noise,
    });
  } catch (err) {
    throw new Error(`freeze detection failed: ${err.message}`);
  }
  const { totalDuration } = detected;
  // With --detect-from, CUT's filter graph maps `[0:a]` off `inPath`, not `detectPath` — whether
  // that branch belongs in the graph has to come from `inPath`'s own streams, not the file that was
  // merely analyzed. Without --detect-from the two files are the same file, so this is unchanged.
  const hasAudio = detectFromGiven ? cutHasAudioOverride : detected.hasAudio;
  const calibration = calibrate(detected, { noise });
  const freezes = calibration.freezes;

  const base = {
    dryRun,
    inPath,
    totalDuration,
    detectFrom: detectFromGiven ? detectPath : null,
    detectFromDurationSec,
    inPathDurationSec,
    detectMode: calibration.mode,
    detectNoise: calibration.noise,
    detectReason: calibration.reason,
    freezes,
    protected: { source: protection.source, ranges: protection.ranges, marginSec: protection.marginSec, freezesTouched: 0 },
  };

  if (freezes.length === 0) {
    return { ...base, skipped: true, skipReason: 'no-freezes', outPath: null, segments: [], freezePlans: [], warnings: [] };
  }

  const { segments, freezePlans } = planSegments(freezes, totalDuration, keep, {
    protect: protection.ranges,
    minStill,
  });
  base.freezePlans = freezePlans;
  base.protected.freezesTouched = freezePlans.filter((plan) => plan.protectedChanged).length;
  // Summary stats derive from the PLAN (single source of truth), never from the raw freeze
  // list — the plan is what actually gets encoded.
  const keptSec = segments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
  const outDuration = keptSec;
  const removedSec = Math.max(0, totalDuration - keptSec);
  const warnings = sanityWarnings({ totalDuration, keptSec, freezes, calibration, minStill, keep });

  // NOTHING TO REMOVE — the same rule as "no freezes found", one step later in the pipeline. Every
  // hold survived (protected, or shorter than --keep), so the cut pass would spend a full re-encode
  // to produce a lossier copy of the input. Report it instead; the caller keeps the raw file.
  if (removedSec < NO_OP_REMOVAL_SEC) {
    const why =
      base.protected.freezesTouched > 0
        ? `all ${freezes.length} hold(s) are inside protected ranges`
        : `all ${freezes.length} hold(s) are shorter than --keep ${keep}s`;
    if (!cliOwnsOutput) log(`nothing to cut — ${why}. Kept the raw file, wrote nothing.`);
    return {
      ...base,
      skipped: true,
      skipReason: 'nothing-to-remove',
      skipDetail: why,
      outPath: null,
      segments,
      outDuration,
      cuts: 0,
      removedSec,
      warnings, // empty by construction — a plan that removes nothing cannot trip the sanity floor
    };
  }

  const result = {
    ...base,
    skipped: false,
    skipReason: null,
    outPath: dryRun ? null : outPath,
    segments,
    outDuration,
    // "cuts" counts static stretches that actually lost time, not freezes detected: a SPARED hold
    // (protected end to end) is a stretch the plan deliberately left alone, and reporting it as a
    // cut would tell the operator the tool did something it did not do. Before protection existed
    // every freeze lost time, so this was simply freezes.length.
    cuts: freezePlans.filter((plan) => plan.disposition !== 'spared').length,
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

function spanList(spans) {
  if (spans.length === 0) return '(none — whole hold cut)';
  return spans.map((s) => `${s.start.toFixed(3)}-${s.end.toFixed(3)}`).join(' + ');
}

function printPlan(result, { minStill, keep }) {
  if (result.detectFrom) {
    log(
      `detected from ${result.detectFrom} (${result.detectFromDurationSec.toFixed(3)}s), ` +
        `applying to ${result.inPath} (${result.inPathDurationSec.toFixed(3)}s)`,
    );
  }
  log(`detect mode: ${result.detectMode} (n=${result.detectNoise}) — ${result.detectReason}`);
  console.log('');
  const prot = result.protected;
  if (prot.source) {
    // The load line above already named the file — don't repeat the path, repeat the numbers.
    log(
      `protected ranges (margin ${prot.marginSec.toFixed(2)}s), ${prot.ranges.length} range(s), ` +
        `touching ${prot.freezesTouched} of ${result.freezes.length} hold(s):`,
    );
    console.log('        #      start        end     length');
    prot.ranges.forEach((r, i) => {
      console.log(
        `  ${String(i + 1).padStart(7)}  ${r.start.toFixed(3).padStart(9)}  ${r.end.toFixed(3).padStart(9)}  ` +
          `${(r.end - r.start).toFixed(3).padStart(9)}`,
      );
    });
    console.log('');
  } else {
    log('protected ranges: none (no sidecar) — every hold is clamped');
    console.log('');
  }
  log(`freeze table (d=${minStill}s), ${result.freezes.length} hold(s):`);
  console.log('        #      start        end   duration  outcome     kept');
  result.freezes.forEach((f, i) => {
    const plan = result.freezePlans[i];
    console.log(
      `  ${String(i + 1).padStart(7)}  ${f.start.toFixed(3).padStart(9)}  ${f.end.toFixed(3).padStart(9)}  ` +
        `${(f.end - f.start).toFixed(3).padStart(9)}  ${plan.disposition.padEnd(10)}  ${spanList(plan.keeps)}` +
        `${plan.protectedChanged ? '  (protected)' : ''}`,
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
  const { inArg, out, minStill, keep, noise, sidecar, detectFrom, force, dryRun } = parseArgs(process.argv.slice(2));

  // PREFLIGHT (CLI only): never clobber a previous tighten. A dry run writes nothing, so it is
  // exempt — refusing to PLAN because an old output exists would be obstruction, not safety.
  const outPath = outPathFor(resolve(inArg), out);
  if (!force && !dryRun && (await fileExists(outPath))) {
    console.error(
      `[tighten] refusing to overwrite an existing take: ${outPath}\n` +
        '  pass --out <path> to write a new one, or --force to overwrite this one.',
    );
    process.exit(1);
  }

  log(
    `analyzing ${resolve(inArg)} (freezedetect noise=${noise} d=${minStill}s)` +
      (detectFrom ? `, detecting from ${resolve(detectFrom)} instead` : '') +
      '...',
  );
  let result;
  try {
    result = await tighten(inArg, { out, minStill, keep, noise, sidecar, detectFrom, dryRun });
  } catch (err) {
    console.error(`[tighten] ${err.message}`);
    process.exit(1);
  }

  if (result.skipped) {
    // A dry run that ends in "nothing to remove" still owes the operator the table it was asked
    // for: holds were found, they were all spared, and WHICH ranges spared them is the whole
    // question. printPlan reports the detect mode itself, hence the either/or here.
    if (dryRun && result.skipReason === 'nothing-to-remove') {
      printPlan(result, { minStill, keep });
    } else {
      log(`detect mode: ${result.detectMode} (n=${result.detectNoise}) — ${result.detectReason}`);
    }
    if (result.skipReason === 'nothing-to-remove') {
      log(`nothing to cut — ${result.skipDetail}. Already tight; wrote nothing.`);
    } else {
      log(`no static stretches >= ${minStill}s found — already tight, nothing to cut. Wrote nothing.`);
    }
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
  if (result.protected.source) {
    log(
      `protected ${result.protected.ranges.length} range(s) from ${result.protected.source} ` +
        `(margin ${result.protected.marginSec.toFixed(2)}s) — ${result.protected.freezesTouched} hold(s) kept longer than --keep`,
    );
  }
  log(`cutting ${result.cuts} static stretch(es), clamped to ${keep}s each (protected holds excepted)...`);
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
