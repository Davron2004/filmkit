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
//                             [--crf <0-51, default 18>] [--force] [--dry-run]
//
// STATE MACHINE (one linear pipeline, no back-edges — a tighten run is a single attempt):
//
//   PREFLIGHT → PROTECT → DETECT → CALIBRATE → PLAN → (dry-run stops here) → CUT → [CLI: SUBTITLES] → done
//
// plus ONE escape edge, from every state that spawns or awaits anything: ABORT (see ABORT below).
// It ends in an AbortError and a clean disk — there is no way back into the pipeline from it.
//
// - PREFLIGHT: resolve ffmpeg (PATH first, then $FILMKIT_FFMPEG, then the grounded fallback);
//   verify the input file exists; as a CLI, refuse to overwrite an existing output, or the `.srt`
//   it would write beside it (SUBTITLES below), unless --force (the library entrypoint overwrites
//   silently — the cameras own their own preflight and already refuse there). When `--detect-from`/`opts.detectFrom` is given, this is also where the pair is
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
//   for the normal path — one tool, one process; ffprobe is only REQUIRED when `--detect-from`
//   needs the guard above, and otherwise used, when it resolves, only to read the cut and written
//   files' lengths to the millisecond after CUT; see writtenDuration). This pass runs against `--detect-from`'s file when one
//   was given and validated, `inPath` otherwise — see DETECT-FROM below. The same decode also feeds a
//   fine threshold probe (every still, any length) and two measures of every I-frame, and DETECT ends
//   by joining the threshold stills an encoder keyframe split (KEYFRAME BRIDGE below). That step is a
//   pure function with no exit of its own: data it cannot read turns it off, never fails the run.
// - CALIBRATE: pick which probe's table to plan from. See RECORDER NOISE FLOOR below.
// - PLAN: turn freeze intervals into a keep-segment list — each freeze is clamped to `keep`
//   seconds (see CLAMP CHOICE below) unless it overlaps a protected range (see PROTECTED RANGES
//   below), non-frozen stretches pass through untouched. Freezes
//   shorter than `--min-still` were never reported by freezedetect (its own `d` parameter), so
//   they're already left alone by construction — nothing to special-case here. The plan is then
//   checked against a SANITY FLOOR (below), which warns but never blocks.
// - CUT (pass 2): select+setpts via a filter_complex graph (video-only unless `inPath` actually
//   has an audio stream — screen recordings usually don't, but the graph is built generically).
//   The `select`/`aselect` window expression is `gte(t,S')*lt(t,E')` in SECONDS (the grid frames
//   keptFrames gives the segment, edged half a frame out; see THE CUT'S TIME MAP), not frame indices, so
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
// ABORT — a tighten run can be stopped, and stopping it leaves nothing behind. Two callers need this:
// a camera whose SIGINT/SIGHUP/SIGTERM handler fires while its `--tighten` pass is running, and this
// file's own CLI. Before this existed the handler called process.exit() with tighten() mid-cut; the
// ffmpeg child (execFile children survive their parent's exit) kept encoding straight into the final
// `<name>-tight.mp4`, and the half-written file it left behind was then refused by the next run's
// overwrite preflight until someone passed --force.
//   - `opts.signal` (an AbortSignal). On abort every ffmpeg/ffprobe child tighten spawned gets
//     SIGTERM, then SIGKILL after ABORT_KILL_GRACE_MS if it is still alive, and tighten() rejects
//     with an Error whose `name` is 'AbortError' (the check is `err.name === 'AbortError'`; that is
//     also what burnTapRipples rejects with, because both run their children through the one
//     runner in lib/run.mjs, grace constant and kill sequence included). The promise settles only
//     AFTER the child has exited, so a caller that awaits it and then calls process.exit() cannot
//     leave an ffmpeg running: the wait is bounded by the grace period, not by the encode. The one
//     place two children run at once, the DETECT-FROM guard's two ffprobes, waits for BOTH to settle
//     (allSettled) before rethrowing, so one probe failing or aborting first cannot settle tighten()
//     while the other is still alive.
//   - Between stages (after DETECT, before CUT) the signal is re-checked, so an abort that lands
//     while no child is running still ends the run instead of starting the encode.
//   - CUT never writes to the final path. It encodes to a dot-prefixed temp file in the SAME
//     directory (`.<name>-tight.tighten-<pid>-<hex>.mp4`: hidden from a bare `ls`, same filesystem
//     so the rename is atomic, same extension so ffmpeg still infers the container) and renames it
//     over the final path only after ffmpeg exited 0 and the signal is still clear. Failure and abort
//     both remove the temp. So a tighten that throws leaves no `-tight.mp4` of its own and no temp;
//     under --force an existing `-tight.mp4` from an earlier run is left untouched rather than
//     truncated (it used to be overwritten in place, so a failed re-run destroyed it).
//   - A tighten that RESOLVES is complete and valid even if the signal fired in the last instant:
//     rename is not interruptible, and un-doing a finished rename would delete a good file. The
//     caller checks `signal.aborted` itself if it needs to know.
//   - The CLI installs SIGINT/SIGHUP/SIGTERM handlers around the pass, aborts, waits for tighten()
//     to settle, then exits 130/129/143 (128 + signal number). A repeated signal while it waits is
//     ignored: the wait is bounded by the grace period.
//   - Not covered at the time: a SIGKILL of node itself (nothing can run), or a handler that calls
//     process.exit() WITHOUT awaiting tighten(). Either leaves the ffmpeg child encoding into the hidden
//     temp; it can never be mistaken for a take, and its name carries the pid of the run that made it.
//   - STALE TEMPS: that pid is what cleans it up later. Every non-dry tighten() (the CLI and every
//     camera's --tighten) first removes the temps for ITS OWN output whose pid is no longer alive
//     (`process.kill(pid, 0)`), and never one whose pid is alive: another run still writing it, or an
//     unrelated process that reused the pid (then the temp stays, the safe miss). Measured before: a
//     SIGKILL during tighten left `.m.partial-tight.tighten-<pid>-<hex>.mp4` next to a web take, and it
//     survived every later successful run of the same name. The rule is exported (sweepDeadRunTemps): the
//     device cameras sweep their pid-stamped burn temps (`.<name>.taps-<pid>.mp4`) with it at start-up.
//
// THE NUMBERS OF A CUT (cutSummary, exported). Every `A -> B (N cuts, X removed)` line, this CLI's
// input/output/removed lines and the cameras', is printed through one helper so that A - X = B on the line:
// A is the cut file's own length, B the written file's, both read back to the millisecond, and X is their
// difference on the printed centiseconds. `removedSec` in the result stays the PLAN's (DETECT's total less
// the kept spans), which is not that: DETECT reads the detect source plus any declared hold, and the encode
// lands off the plan by under a frame per kept segment with an off-grid edge (THE CUT'S TIME MAP);
// `fileRemovedSec` is the file-against-file number. Measured before:
// "tightened 25.83s -> 17.37s (3 cuts, 8.55s removed)" on an Android take, 0.09s unaccounted for.
//
// ENCODE QUALITY (FEEDBACK #25) — CUT re-encodes, and how well is a policy, not a detail. The
// default is libx264 at CRF 18, preset veryfast, from lib/encode.mjs (`DEFAULT_CRF`), the one place
// that number lives; `--crf <n>` on the CLI and `opts.crf` on tighten() override it. It used to run
// at x264's own default (CRF 23) and the results were ~100 kbps out of a ~1.7-2.0 Mbps source:
// fine for flat UI, visibly soft on anything photographic. Measured on the 2026-09-11 Android
// takes (60 fps, 1080x2404): a 510 s take cut to 112.7 s went 130 kbps -> 189 kbps at CRF 18, and a
// 44 s take cut to 5.5 s went 294 -> 444 kbps (SSIM against the source 0.9981 -> 0.9990). The ratio
// to the SOURCE bitrate is a misleading yardstick on device takes: their 1.7-2.0 Mbps comes from
// the tap burn's 60 fps VideoToolbox re-encode at the recorder's
// --bit-rate target, and take-1's own frame-exact recorder output before the burn was 232 kbps, so
// ~190-440 kbps out is not "10% of the source". Flat UI simply does not need more; photographic content does, and that is what a lower CRF buys.
// The pass is a re-encode of a re-encode — the source already carries one generation of x264 loss,
// so a high CRF here compounds it, which is the argument for spending bits rather than saving them.
// `--dry-run` never encodes, so it ignores the value (but still rejects an invalid one).
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
// (The threshold has one more noise source to stay above: an encoder keyframe. See KEYFRAME BRIDGE.)
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
// `opts.detectFromCrop` ({ w, h, x, y }) is the one sanctioned exception to "same frame size": a
// camera that trims 1-2px of letterbox in its finishing encode (film-android: screenrecord's content
// rectangle is a pixel or two short of the video, from float truncation) delivers a take that is the
// pre-finish file CROPPED. With the crop declared, the guard requires the target to be exactly
// w x h and the crop to lie inside the detect frame (duration is checked as before), and nothing
// else changes. Freeze detection on the uncropped source stays valid because the pixels cropped away
// are the bar and, at most, one edge column, which never carry a change the picture does not.
// Only the caller that made the crop knows it, so the CLI has no flag for it.
// `opts.detectFromHoldSec` (seconds) is the one sanctioned exception to "same length", for the same
// kind of reason: film-ios holds a take that ends on a still screen to the recorder's stop (simctl
// emits no frame while nothing changes, so the frame-exact pre-burn file ends at the last CHANGE,
// measured 4.3-4.4s before the camera stopped, and the delivered take holds that last frame for the
// rest). With the hold declared, the guard expects `detectFrom + hold` (same 2-frame tolerance), and
// DETECT clones the source's last frame for `hold` seconds after the fps resample, so the held tail is
// analysed like any other hold (and clamped like one) instead of being read as unfrozen footage the
// source never had. Caller-only, like the crop: no CLI flag.
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
// frame of the following freeze. The one exception is KEYFRAME BRIDGE, right below: there the "change
// frame" is the encoder's, not the screen's.
//
// KEYFRAME BRIDGE — an encoder's periodic keyframe used to split a hold, and the dead air after the
// split survived. Measured on a web take (x264, an I-frame every 250 frames): its closing hold crossed
// the I-frame at frame 750 (25.000s) and came back as a freeze ending at 25.000 plus 0.73s of "motion"
// that was the same screen, so tighten removed 0.26s where 0.99s was dead air. The mechanism:
// freezedetect compares each frame with the HEAD of the running freeze, not with the frame before it.
// That head had been caught mid-animation, and the animation settled over the next 17 frames in steps
// each under the threshold, so the settled screen already sat 0.2386 levels from the head, 93% of
// -60dB's 0.256. An I-frame codes the picture afresh, and that frame's step from the one before was
// 0.0285 levels (-79dB, a ninth of the threshold): re-quantization noise, not content, and enough to tip
// the sum to 0.2580. On a still screen the frames between keyframes step by 0.0000-0.0005 levels and an
// I-frame by 0.013-0.055, so the keyframe is the one event that adds fresh noise to a still picture.
// The fix: in the threshold table, two stills that abut at an intra-coded frame K are one hold when K's
// own step from K-1 is re-encode noise, which takes BOTH of:
//   - the step's total within n: K, compared with the frame before it, is not a change by the
//     threshold's own measure. This is what refuses a diffuse change (a fade moves every block a little).
//   - no 4x4 luma block whose mean moved more than 1/16 of full scale (16 levels at 8 bits;
//     KEYFRAME_BLOCK_NOISE_MAX). This refuses a small change, which the total cannot: a 2px caret
//     appearing on the keyframe adds 0.0068 levels to its 0.0223 of noise, still a ninth of n. A re-encode
//     of an unchanged picture is near zero-mean inside a transform-sized block (a 4x4 block's mean is its
//     DC coefficient, which a re-encode moves by about Qstep/8), while a change of the picture moves some
//     block's mean. Largest |signed 4x4 block mean| of the step, measured. Re-encode noise: across 558
//     existing takes, 20,835 keyframes whose neighbouring frames are still and whose total step is within
//     n, 99.5% read at most 14 levels and 3 more 15 (two are x264 re-coding a glyph's stroke edge with
//     nothing visibly different; the third is real, dark-mode text fading in at grey on near-black, a
//     change as faint as the noise, which no block bound can tell from it), and then the population stops; by
//     encoder, 2.0-3.6 typical at the web camera's CRF 18, 7-10 on the VideoToolbox tap burn, 8.6 at CRF
//     28 and 11.9 at CRF 35 on a synthetic still. Real changes on a keyframe: 27 (a 1px 50%-grey caret),
//     54 (1px black caret), 110 (2px caret), 73-100 (a digit ticking "100" -> "200"), 183 (a toast), and
//     in that same survey 97 keyframes at 27 or more, e.g. a take whose focused field's caret blinks on
//     the keyframe: total 0.062 levels, a quarter of n, so the total alone would call it noise, but its
//     largest block is 64. Between 17 and 26 sat 4 keyframes, one of them a click ring's animation step
//     (a sub-threshold animation the threshold treats as still anyway). So the bound sits just past where
//     the noise ends, on the side of keeping a change. An encode noisier than that loses the bridge (the
//     old split, dead air kept), never a change; a change fainter than that on a keyframe is joined, as
//     it would be absorbed anywhere else in a hold the threshold sees as still.
// A joined run is then held to freezedetect's own `d` rule, so a short still and a short tail can make
// one hold between them. Where it applies, and where it does not:
//   - The threshold table only. In exact mode (n=0) a break at K means K differs from the head while
//     K-1 does not, so K's step is never "within n". And there is nothing to join: adb screenrecord and
//     simctl emit a frame only when the screen changes and place I-frames by frame count (every 120
//     frames on the emulator, about 30 on iOS), so every device keyframe measured (17 Android, 6 iOS)
//     lands inside motion, its largest 16x16 block changing by 44-185 levels.
//   - Only on an intra-coded frame of the 30 fps grid (decoder pict_type I). VFR sources are fine: the
//     resample repeats an I-frame, the first repeat carries its step and the rest step by zero. A source
//     I-frame the resample DROPS (a 60 fps source) leaves no marker and its noise lands on the next grid
//     frame, a P-frame, so that split stays (the safe miss). The tap burn's VideoToolbox encode puts an
//     I-frame every 12 frames at 60 fps; 139 of its 140 survived the resample on the take measured.
//   - After a join, frames past K are measured against K, a fresh reference, so a sub-threshold change
//     soon after a keyframe is judged as at the start of a hold. Before, the stale head's drift could tip
//     it into a break (measured: a 2x20px caret 10 frames after the keyframe).
//   - A pixel format it cannot weight (only planar YUV and gray are), or a --noise it cannot read as a
//     level, turns the bridge off and says so: the plan is then the plan from before the bridge existed.
//   - The data comes from graphs B, C and D of DETECT (see detectFreezes), each on its own thread. Cost,
//     measured on an idle machine: +13-18% wall time on a dry run (0.71s -> 0.84s on a 25.7s 1280x720 web
//     take, 2.30s -> 2.61s on a 27.9s 1142x2546 burned take, 13.7s -> 16.1s on a 173s one) and about 3.5x
//     the CPU, nearly all of it the two tblends, which have to pair every frame with the one before it.
//     The extra work lands on cores the decode-bound graph A leaves idle.
// Measured after: the reproducing take cuts its whole closing hold (25.73s -> 24.74s planned, 0.99s
// removed, was 0.26s; the written file 24.77s, was 25.50s; its subtitles unchanged). Dry runs of 572
// existing takes before and after: 459 plans byte-identical, the other 113 changed by a logged keyframe
// bridge and nothing else, and no exact-mode plan changed (53 takes). They cut 37.2s more dead air
// between them, up to 2.2s on one take, mostly at the tap burn's opening keyframe at 0.2s (VideoToolbox's
// rate-control settling, measured at 8 levels) and at x264's keyframes at 8.333s and 25.000s.
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
// The same numbering is what mapRangeThroughCut (THE CUT'S TIME MAP, beside the graph) reproduces, so
// a caller can move its own time ranges onto the cut file: film-web's `<name>-tight.srt`.
//
// SUBTITLES — the CLI carries a take's subtitles through the cut, as film-web's --tighten does. Before
// this a standalone `node tighten.mjs out/demo.mp4` made `demo-tight.mp4` and no `demo-tight.srt`, so
// the only way to get subtitles that match a re-cut was to film again. When the sidecar this run reads
// (the same file PROTECT reads: `--sidecar`, else `<in>.json`; none with `--no-sidecar`) has caption
// entries, main() builds the cues from them with lib/subtitles.mjs's captionCues, moves them through
// the plan's segments with cuesThroughCut (mapRangeThroughCut underneath), and writes `<out-stem>.srt`
// beside the output after the video is in place: out/demo-tight.mp4 -> out/demo-tight.srt. Measured:
// on one tip-demo take, the camera's `--tighten` and this CLI with the same knobs wrote byte-identical
// `-tight.srt` files, and each cue start lands on the first frame of its caption's fade-in in the cut.
//   - ONE OWNER PER FILE. Only main() writes the .srt; tighten() itself never does. film-web calls
//     tighten() with `sidecar: false` and writes its `-tight.srt` at its own PLACE step, after its
//     --force stash, so the two never write the same file.
//   - Overwrite: an existing `.srt` at that name is refused in PREFLIGHT like the video, unless --force.
//     Only when there are cues to write: a take with no caption (every device take: their timeline is
//     taps) writes no `.srt` and is not refused over one.
//   - A `.srt` belongs to the video beside it. A run that writes `<out-stem>.mp4` with no cues to write
//     (no sidecar, --no-sidecar, no caption entry, or a cut that took every caption away) removes an
//     existing `<out-stem>.srt`, which described an earlier cut, and says "removed a stale subtitles
//     file from an earlier cut". Only reachable under --force: without it the video was refused first.
//     A cue cut in part is clipped, and a dropped or clipped cue is warned about.
//   - --dry-run writes and removes nothing; it prints the path and cue count it would write, or the
//     stale `.srt` it would remove.
//   - "already tight" writes no video, so it writes and removes no `.srt` either.
//   - A failed `.srt` write is reported and exits 1; the video is already written and stays.
import { randomBytes } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { resolve, dirname, basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTool } from './lib/tools.mjs';
import { DEFAULT_CRF, parseCrf, x264Args } from './lib/encode.mjs';
import { runAbortable, throwIfAborted } from './lib/run.mjs';
import { captionCues, cuesThroughCut, writeSrt } from './lib/subtitles.mjs';

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

// ── ABORT (see the header section of that name) ─────────────────────────────────────────────
// The runner, the AbortError and the SIGTERM-then-SIGKILL sequence (ABORT_KILL_GRACE_MS, 2s) live in
// lib/run.mjs, shared with lib/tap-overlay.mjs's burn. `runTool` is that runner with its defaults:
// stdout and stderr captured in full (freezedetect's table is in stderr, ffprobe's JSON in stdout),
// never rejecting for a non-zero exit (callers differ on what that means: freezedetect's stderr is
// the answer even when ffmpeg exits non-zero on a decode hiccup), rejecting for a failed spawn, for
// runaway output, and, with an AbortError AFTER the child has exited, for an abort.
const runTool = (bin, args, { signal } = {}) => runAbortable(bin, args, { signal });

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
async function ffprobeInfo(ffprobe, path, signal) {
  const args = ['-v', 'error', '-of', 'json', '-show_format', '-show_streams', path];
  let stdout;
  try {
    const result = await runTool(ffprobe, args, { signal });
    if (result.code !== 0) throw new Error(result.stderr.trim() || `exit ${result.code}`);
    stdout = result.stdout;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error(`ffprobe failed on ${path}: ${err.message}`);
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
async function guardDetectFrom(detectPath, inPath, signal, crop = null, holdSec = 0) {
  let ffprobe;
  try {
    ffprobe = await resolveTool('ffprobe');
  } catch (err) {
    throw new Error(`--detect-from needs ffprobe to guard the pair, and it could not be found: ${err.message}`);
  }
  // allSettled, not all: Promise.all rejects on the first failure while the other ffprobe may still be
  // running (inside its SIGKILL grace on an abort), and tighten() must settle only once every child it
  // spawned is gone (see ABORT in the header). An abort wins the rethrow, so callers still see AbortError.
  const probes = await Promise.allSettled([ffprobeInfo(ffprobe, detectPath, signal), ffprobeInfo(ffprobe, inPath, signal)]);
  const failed = probes.filter((p) => p.status === 'rejected').map((p) => p.reason);
  if (failed.length > 0) throw failed.find((err) => err?.name === 'AbortError') ?? failed[0];
  const [detectInfo, cutInfo] = probes.map((p) => p.value);
  const maxDriftSec = 2 / NORMALIZED_FPS;
  // A declared hold (opts.detectFromHoldSec) is the one sanctioned length difference: the target is the
  // detect source with its last frame held that much longer, and DETECT pads the source the same way.
  const driftSec = Math.abs(detectInfo.durationSec + holdSec - cutInfo.durationSec);
  if (driftSec > maxDriftSec) {
    throw new Error(
      `--detect-from ${detectPath} (${detectInfo.durationSec.toFixed(3)}s${holdSec > 0 ? ` + a declared ${holdSec.toFixed(3)}s hold` : ''}) and ${inPath} ` +
        `(${cutInfo.durationSec.toFixed(3)}s) differ by ${driftSec.toFixed(3)}s — more than 2 frames at ` +
        `${NORMALIZED_FPS}fps (${maxDriftSec.toFixed(3)}s). Refusing: they don't look like the same recording, ` +
        `and a plan built from one would not line up with a cut made on the other.`,
    );
  }
  if (crop) {
    // The caller cropped the detect source's frame to make the target (a camera's finishing encode
    // trims 1-2px of letterbox). Only a caller that KNOWS the crop can say so; the guard then holds
    // the pair to it: the target must be exactly the crop, and the crop must lie inside the detect
    // frame. Anything else is still "not the same recording".
    if (cutInfo.width !== crop.w || cutInfo.height !== crop.h) {
      throw new Error(
        `--detect-from ${detectPath}: ${inPath} is ${cutInfo.width}x${cutInfo.height} but the declared crop is ` +
          `${crop.w}x${crop.h}. Refusing: the target is not the detect source cropped as declared.`,
      );
    }
    if (crop.x < 0 || crop.y < 0 || crop.x + crop.w > detectInfo.width || crop.y + crop.h > detectInfo.height) {
      throw new Error(
        `--detect-from ${detectPath} is ${detectInfo.width}x${detectInfo.height}, which cannot contain the declared ` +
          `crop ${crop.w}x${crop.h} at (${crop.x},${crop.y}).`,
      );
    }
  } else if (detectInfo.width !== cutInfo.width || detectInfo.height !== cutInfo.height) {
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
  '[--sidecar <path> | --no-sidecar] [--detect-from <path>] [--crf <0-51, default ' + DEFAULT_CRF + '>] ' +
  '[--force] [--dry-run]\n' +
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
  '    --crf <n>          x264 quality of the re-encode, 0 (lossless) to 51 (worst); default ' + DEFAULT_CRF + '.\n' +
  '                       Lower is bigger and closer to the source. Ignored by --dry-run.\n' +
  '    --force            overwrite an existing output file instead of refusing\n' +
  '\n' +
  '  When the sidecar has captions (a web take), their subtitles are carried through the cut into\n' +
  '  <out-stem>.srt beside the output (out/demo-tight.mp4 -> out/demo-tight.srt), under the same\n' +
  '  overwrite rule as the video.';

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
  let crf = DEFAULT_CRF;
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
    } else if (argv[i] === '--crf') {
      try {
        crf = parseCrf(valueFor(argv, i, '--crf'));
      } catch (err) {
        usageError(err.message);
      }
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
    crf,
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

// Which sidecar a run reads (`opts.sidecar` / --sidecar, else the automatic one), or null for
// `false`. One function, so PROTECT and the CLI's SUBTITLES can never read different files.
function sidecarSource(inPath, sidecar) {
  if (sidecar === false) return null;
  const requested = typeof sidecar === 'string' && sidecar.trim() !== '';
  return { path: requested ? resolve(sidecar) : sidecarPathFor(inPath), requested };
}

// The subtitles beside the CLI's output (see SUBTITLES): out/demo-tight.mp4 -> out/demo-tight.srt.
function srtPathFor(outPath) {
  return join(dirname(outPath), `${basename(outPath, extname(outPath))}.srt`);
}

// The caption cues in the sidecar this run reads, as lib/subtitles.mjs builds them for the web camera;
// [] when there is no sidecar, no caption in it (a device take), or it can't be read. Silent on
// purpose: resolveProtection reads the same file and is the one that reports a bad one.
async function sidecarCaptionCues(inPath, sidecar) {
  const source = sidecarSource(inPath, sidecar);
  if (!source) return [];
  try {
    const doc = JSON.parse(await readFile(source.path, 'utf8'));
    return Array.isArray(doc?.timeline) ? captionCues(doc.timeline) : [];
  } catch {
    return [];
  }
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
  const source = sidecarSource(inPath, sidecar);
  if (!source) return none;

  const { path, requested } = source;
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

// ── DETECT (pass 1): run the freezedetect probes and the keyframe measures, parse their stderr ──
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
// The pass is FOUR filter graphs over one decode (see KEYFRAME BRIDGE in the header for why B, C and D
// exist). ffmpeg runs each `-filter_complex` graph in its own thread, so B, C and D cost little wall
// time: measured on a 27.9s 1142x2546 burned Android take, 2.30s with graph A alone, 2.61s with all
// four (A, B and C chained into ONE graph took 5.1s: a graph runs on one thread). The CPU they cost is
// in KEYFRAME BRIDGE.
//   A  fps → [hold] → freezedetect@exact (n=0, d=minStill) → freezedetect@threshold (n, d=minStill)
//      The two tables CALIBRATE chooses between. Byte-for-byte the graph this pass always ran, so
//      where the bridge joins nothing, the plan is exactly the plan it always was.
//   B  fps → [hold] → freezedetect@still (n, d=0): every threshold still, however short. Graph A's
//      threshold table is exactly B's stills that last `minStill` (same filter, same frames: `d`
//      only gates what is reported, never when the reference frame resets).
//   C  fps → tblend=difference → select intra-coded frames → signalstats → Y/U/V averages: each
//      I-frame's own step from the frame before it, in freezedetect's unit.
//   D  fps → tblend=difference128 → select intra-coded frames → 4x4 box average → signalstats →
//      Y min/max: the largest SIGNED mean change of any 4x4 luma block at each I-frame.
// Every filter is named (`freezedetect@exact`), and the parse keys on that name: ffmpeg's log prefix
// carries it, so no table depends on a filter's position in a graph.
const PROBE_EXACT = 'exact';
const PROBE_THRESHOLD = 'threshold';
const PROBE_STILL = 'still';
const INTRA_PLANES = ['Y', 'U', 'V'];
const INTRA_SELECT = "select='eq(pict_type\\,I)'";
// KEYFRAME BRIDGE's locality bound: an I-frame whose step moves some 4x4 luma block's mean by more
// than this fraction of full scale (16 levels at 8 bits) changed the picture, whatever its total. See
// the header for the measured noise (at most 12 levels) and smallest change (27 levels) it sits between.
const KEYFRAME_BLOCK = 4;
const KEYFRAME_BLOCK_NOISE_MAX = 1 / 16;

async function detectFreezes(ffmpeg, inPath, { minStill, thresholdNoise, signal, holdSec = 0 }) {
  // A declared hold (opts.detectFromHoldSec): the last frame is cloned for that long AFTER the resample,
  // so the probes see the held tail the target has, byte-identical, and a freeze that reaches the end
  // closes at the target's length. Graphs C and D need no hold: a clone is identical to the frame before it.
  const head = [`fps=fps=${NORMALIZED_FPS}`, ...(holdSec > 0 ? [`tpad=stop_mode=clone:stop_duration=${holdSec.toFixed(6)}`] : [])];
  const probe = (name, noise, d) => `freezedetect@${name}=n=${noise}:d=${d}`;
  // Graphs C and D keep only I-frames, and a take can have none past frame 0 (an Android recording with
  // one I-frame is common), which tblend never emits. A graph output that never receives a frame is never
  // initialized, and ffmpeg then stalls the whole run at 0% CPU (measured, on every one-keyframe Android
  // segment). So each graph's OUTPUT carries every grid frame, and the I-frame measures hang off a split
  // into a nullsink.
  const grid = [`fps=fps=${NORMALIZED_FPS}`];
  const graphs = [
    { chain: [...head, probe(PROBE_EXACT, EXACT_NOISE, minStill), probe(PROBE_THRESHOLD, thresholdNoise, minStill)] },
    { chain: [...head, probe(PROBE_STILL, thresholdNoise, 0)] },
    {
      chain: grid,
      measure: [
        'tblend=all_mode=difference',
        INTRA_SELECT,
        'signalstats',
        ...INTRA_PLANES.map((p) => `metadata@intra${p}=print:key=lavfi.signalstats.${p}AVG`),
      ],
    },
    {
      chain: grid,
      measure: [
        'extractplanes=y', // the block bound reads luma only; chroma would double tblend's work for nothing
        'tblend=all_mode=difference128',
        INTRA_SELECT,
        `scale=w=iw/${KEYFRAME_BLOCK}:h=ih/${KEYFRAME_BLOCK}:flags=area`,
        'signalstats',
        'metadata@blockLo=print:key=lavfi.signalstats.YMIN',
        'metadata@blockHi=print:key=lavfi.signalstats.YMAX',
      ],
    },
  ];
  const args = ['-hide_banner', '-nostats', '-i', inPath];
  graphs.forEach(({ chain, measure }, i) => {
    const graph = measure
      ? `[0:v]${chain.join(',')},split=2[g${i}][m${i}];[m${i}]${measure.join(',')},nullsink`
      : `[0:v]${chain.join(',')}[g${i}]`;
    args.push('-filter_complex', graph);
  });
  graphs.forEach((_, i) => args.push('-map', `[g${i}]`, '-f', 'null', '-'));
  // ffmpeg exits non-zero for a real decode failure but still fills in stderr — that is parsed
  // below either way. A readable input whose run never processed a frame (its closing `frame=` report
  // is missing: a graph that failed to configure) is a failure, not an empty freeze table.
  const { code, stderr } = await runTool(ffmpeg, args, { signal });
  if (!stderr) throw new Error(`ffmpeg freezedetect pass failed (exit ${code}) and printed nothing`);

  const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!durationMatch) {
    throw new Error(`could not parse input duration from ffmpeg output for ${inPath} (is it a valid video file?)`);
  }
  if (code !== 0 && !/\bframe=\s*\d+/.test(stderr)) {
    throw new Error(`ffmpeg freezedetect pass failed (exit ${code}):\n${stderr.trim().split('\n').slice(-6).join('\n')}`);
  }
  // The input's own duration, plus the declared hold the detect graph added to it.
  const totalDuration = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]) + holdSec;
  const hasAudio = /Stream #\d+:\d+.*: Audio:/.test(stderr);

  const byProbe = new Map();
  const pending = new Map();
  // grid frame index -> what graphs C and D printed for that I-frame: { Y, U, V } averages of |step|,
  // and { Lo, Hi }, the darkest and brightest 4x4 block mean of the signed step (offset by half scale).
  const intraStats = new Map();
  const printing = new Map(); // metadata filter -> the frame index it is printing
  for (const line of stderr.split('\n')) {
    const m = line.match(/\[freezedetect@(\w+) @ [^\]]*\].*lavfi\.freezedetect\.freeze_(start|duration|end):\s*([\d.]+)/);
    if (!m) {
      const meta = line.match(/\[metadata@(?:intra|block)(Y|U|V|Lo|Hi) @ [^\]]*\] (.*)$/);
      if (!meta) continue;
      const frame = meta[2].match(/^frame:\d+\s+pts:(-?\d+)/);
      if (frame) printing.set(meta[1], Number(frame[1]));
      const value = meta[2].match(/^lavfi\.signalstats\.\w+=([\d.eE+-]+)/);
      if (value && printing.has(meta[1])) {
        const k = printing.get(meta[1]);
        if (!intraStats.has(k)) intraStats.set(k, {});
        intraStats.get(k)[meta[1]] = Number(value[1]);
      }
      continue;
    }
    const name = m[1];
    const value = Number(m[3]);
    if (!byProbe.has(name)) byProbe.set(name, []);
    if (!pending.has(name)) pending.set(name, { start: null });
    const p = pending.get(name);
    if (m[2] === 'start') {
      p.start = value;
    } else if (m[2] === 'duration') {
      // freeze_duration is logged immediately before freeze_end and carries no information that
      // end - start doesn't. It still needs its own branch: without one it would fall through to
      // the freeze_end case below and close the interval at the wrong timestamp.
    } else if (p.start !== null) {
      byProbe.get(name).push({ start: p.start, end: value });
      p.start = null;
    }
  }
  for (const [name, p] of pending) {
    if (p.start === null) continue;
    // Freeze was still active when the stream ended — close it out at the input's duration.
    byProbe.get(name).push({ start: p.start, end: totalDuration });
  }

  const table = (name) => normalizeFreezes(byProbe.get(name) || [], totalDuration);
  const intraSteps = intraStepsFrom(intraStats, stderr);
  const bridged = bridgeKeyframeSplits(table(PROBE_THRESHOLD), table(PROBE_STILL), intraSteps.steps, {
    noise: noiseLevel(thresholdNoise),
    minStill,
    totalDuration,
  });
  return {
    exact: table(PROBE_EXACT),
    threshold: bridged.freezes,
    keyframeBridges: bridged.bridges,
    keyframeNote: intraSteps.note ?? bridged.note ?? null,
    totalDuration,
    hasAudio,
  };
}

// ── KEYFRAME BRIDGE (see the header section of that name) ───────────────────────────────────
// freezedetect's `n` as a fraction of full scale, the unit an I-frame's step is measured in:
// "-60dB" -> 0.001, "0.001" -> 0.001. null for anything else ffmpeg might accept (SI suffixes):
// the bridge is then off, which is the behaviour before it existed.
function noiseLevel(noise) {
  const text = String(noise).trim();
  const db = text.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*dB$/i);
  const level = db ? 10 ** (Number(db[1]) / 20) : text === '' ? NaN : Number(text);
  return Number.isFinite(level) && level >= 0 ? level : null;
}

// Each I-frame's two measures, both as fractions of full scale:
//   step   its step from the frame before, in freezedetect's own unit: sum of |difference| over every
//          pixel of every plane, divided by the pixel count and by 2^bitdepth (vf_freezedetect.c's mafd).
//          signalstats gives per-plane averages, so they are weighted by plane size, which the pixel
//          format decides. Measured on the reproducing take's frame 750: (4 x 0.03571 + 0.01670 +
//          0.01162) / 6 = 0.02853 levels, the same number a direct per-pixel computation gives.
//   block  the largest |mean| of the signed step over any 4x4 luma block (difference128 centres the
//          signed step on half scale, the box average takes each block's mean).
// A format this cannot weight turns the bridge off.
function intraStepsFrom(averages, stderr) {
  const stream = stderr.match(/Stream #\d+:\d+.*?: Video: [^,]*, ([a-z0-9_]+)(?:\([^)]*\))?, (\d+)x(\d+)/);
  if (!stream) return { steps: null, note: 'keyframe bridge off: could not read the video stream\'s pixel format and size' };
  const [, pixFmt, w, h] = stream;
  const fmt = pixFmt.match(/^(?:yuvj?|gray)(4[0-4][0-4])?p?(\d+)?(?:le|be)?$/);
  // Chroma subsampling as (horizontal, vertical) shifts, from the format's J:a:b name; gray has no chroma.
  const shifts = { 444: [0, 0], 422: [1, 0], 440: [0, 1], 420: [1, 1], 411: [2, 0], 410: [2, 2] };
  if (!fmt || (pixFmt.startsWith('yuv') && !shifts[fmt[1]])) {
    return { steps: null, note: `keyframe bridge off: pixel format ${pixFmt} is not one it can weight` };
  }
  const width = Number(w);
  const height = Number(h);
  const depth = Number(fmt[2] || 8);
  const luma = width * height;
  const [hs, vs] = pixFmt.startsWith('gray') ? [null, null] : shifts[fmt[1]];
  const chroma = hs === null ? 0 : Math.ceil(width / 2 ** hs) * Math.ceil(height / 2 ** vs);
  const steps = new Map();
  const half = 2 ** (depth - 1);
  for (const [k, a] of averages) {
    if (!Number.isFinite(a.Y) || (chroma > 0 && !(Number.isFinite(a.U) && Number.isFinite(a.V)))) continue;
    if (!(Number.isFinite(a.Lo) && Number.isFinite(a.Hi))) continue;
    const sad = a.Y * luma + (chroma > 0 ? (a.U + a.V) * chroma : 0);
    steps.set(k, {
      step: sad / (luma + 2 * chroma) / 2 ** depth,
      block: Math.max(a.Hi - half, half - a.Lo) / 2 ** depth,
    });
  }
  return { steps, note: null };
}

// Join the threshold stills an I-frame split. Two stills that abut at grid frame K (the first ends at K,
// the second starts there) are one still when K is intra-coded and its step from K-1 is re-encode noise:
// within the threshold `noise` in total (K, compared with the frame before it, is not a change by the
// probe's own measure; this is what catches a diffuse change such as a fade) AND moving no 4x4 luma
// block's mean by more than KEYFRAME_BLOCK_NOISE_MAX (what catches a small one: a caret, a digit). A
// joined run is then held to freezedetect's own `d` rule, (last frozen frame - start) >= minStill, and
// replaces the threshold-table entries it contains. With nothing joined the table comes back untouched
// (the same array), so no plan changes unless a keyframe split a still.
function bridgeKeyframeSplits(table, stills, steps, { noise, minStill, totalDuration }) {
  if (steps === null) return { freezes: table, bridges: [] };
  if (noise === null) return { freezes: table, bridges: [], note: 'keyframe bridge off: --noise is not a level it can read' };
  const frame = (t) => Math.round(t * NORMALIZED_FPS);
  const runs = [];
  for (const still of stills) {
    const last = runs[runs.length - 1];
    const k = frame(still.start);
    const intra = steps.get(k);
    if (last && frame(last.end) === k && intra !== undefined && intra.step <= noise && intra.block <= KEYFRAME_BLOCK_NOISE_MAX) {
      last.end = still.end;
      last.keyframes.push({ at: k / NORMALIZED_FPS, step: intra.step, block: intra.block });
    } else {
      runs.push({ start: still.start, end: still.end, keyframes: [] });
    }
  }
  const joined = runs.filter((run) => run.keyframes.length > 0 && (frame(run.end) - frame(run.start) - 1) / NORMALIZED_FPS >= minStill - 1e-9);
  if (joined.length === 0) return { freezes: table, bridges: [] };
  const within = (f) => joined.some((run) => frame(f.start) >= frame(run.start) && frame(f.end) <= frame(run.end));
  const freezes = normalizeFreezes([...table.filter((f) => !within(f)), ...joined.map(({ start, end }) => ({ start, end }))], totalDuration);
  return { freezes, bridges: joined };
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
    `unusually aggressive cut planned: ${totalDuration.toFixed(2)}s -> ~${keptSec.toFixed(2)}s ` +
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
  // Each keep segment selects exactly the grid frames keptFrames gives it (see THE CUT'S TIME MAP): the
  // window runs from half a frame before its first frame to half a frame before the first frame it does
  // NOT keep, so no grid frame sits on an edge, and it is half-open (`gte*lt`), so two segments whose
  // frames touch never both claim an audio frame on their shared edge. Summing the terms (rather than
  // OR-ing) is then fine: at most one is ever nonzero for a given t.
  const keepExpr = segments
    .map(keptFrames)
    .filter(({ count }) => count > 0)
    .map(({ first, count }) => `gte(t\\,${gridEdge(first)})*lt(t\\,${gridEdge(first + count)})`)
    .join('+');
  const parts = [
    `[0:v]fps=fps=${NORMALIZED_FPS},select='${keepExpr}',setpts=N/(${NORMALIZED_FPS}*TB)[outv]`,
  ];
  if (hasAudio) {
    parts.push(`[0:a]aselect='${keepExpr}',asetpts=N/SR/TB[outa]`);
  }
  return parts.join(';');
}

// ── THE CUT'S TIME MAP: where a span of the input lands in the output (the `-tight.srt`, SUBTITLES) ──
// buildFilterGraph and mapRangeThroughCut both read a segment's frames off keptFrames, so they cannot
// disagree. CUT keeps the frames of the NORMALIZED_FPS grid (the fps= resample puts frame k at t = k /
// NORMALIZED_FPS) that lie in a keep segment, HALF-OPEN: S <= t < E, so a segment on the grid keeps exactly
// (E - S) * fps frames. Then it numbers the survivors back to back (setpts=N/(fps*TB)). So segment i keeps
// frames first_i = ceil(S_i * fps) .. ceil(E_i * fps) - 1, and starts in the output at (frames every earlier
// segment kept) / fps. NOT at the sum of the earlier segments' lengths: an off-grid segment keeps up to a
// frame more (or less) than its length, and over a plan of many segments that adds up to a visible offset.
// GRID SNAP: plan times are mostly grid times already (freezedetect runs on the same fps= resample), but they
// arrive through ffmpeg's log printed to 6 significant digits (12.0666666 as 12.066667, a hair past frame
// 362), so a time within GRID_SNAP_FRAMES of a grid frame IS that frame. Measured before (both ends
// inclusive, `between(t,S,E)`, unsnapped): every on-grid segment kept one frame past its end, so the
// written file ran a frame per kept segment past the plan: an Android take planned at 27.019s was written
// at 27.20s (816 frames, 5.4 over), an iOS take's 6 segments planned at 11.247s were written as 339 frames
// (11.30s), exactly what that rule predicts per segment.
// A point inside segment i lands at out_i + (t - first_i / fps), clamped to the segment's output span; a
// point in a cut lands nowhere. A RANGE is clipped to what was kept: it starts where its first kept instant
// lands and ends where its last one does (a cut inside it closes up, as it does in the video). The result is
// null when nothing of it survived.
// %.6g is off by at most 5e-4s below 1000s (0.015 frames) and 5e-3s below 10000s (0.15 frames); a
// protected range's own edge that happens to fall this close to a frame moves by under 7ms.
const GRID_SNAP_FRAMES = 0.2;
/** `t` in grid frames, snapped to the frame it is within GRID_SNAP_FRAMES of. */
const gridPos = (t) => {
  const x = t * NORMALIZED_FPS;
  const k = Math.round(x);
  return Math.abs(x - k) <= GRID_SNAP_FRAMES ? k : x;
};
/** The grid frames a keep segment keeps: `first` .. `first + count - 1` (S <= t < E, snapped). */
function keptFrames({ start, end }) {
  const first = Math.ceil(gridPos(start));
  return { first, count: Math.max(0, Math.ceil(gridPos(end)) - first) };
}
/** The select window's edge before grid frame k: half a frame early, so no frame's t can sit on it. */
const gridEdge = (k) => Number(((k - 0.5) / NORMALIZED_FPS).toFixed(6));

/**
 * Map `{ start, end }` (seconds on the input's timeline) through a tighten plan's keep segments onto
 * the cut file's timeline. See THE CUT'S TIME MAP above.
 * @param {Array<{start:number,end:number}>} segments a tighten() result's `segments` (sorted, disjoint)
 * @param {{start:number,end:number}} range
 * @returns {{start:number,end:number,clipped:boolean}|null} null when the whole range was cut;
 *   `clipped` when part of it was
 */
export function mapRangeThroughCut(segments, { start, end }) {
  if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) return null;
  let out = 0; // where the current segment starts in the output, in seconds
  let first = null;
  let last = null;
  let kept = 0; // seconds of the range that survived
  for (const seg of segments) {
    const { first: f, count: n } = keptFrames(seg);
    if (n <= 0) continue;
    const span = n / NORMALIZED_FPS;
    const at = (t) => out + Math.min(span, Math.max(0, t - f / NORMALIZED_FPS));
    const lo = Math.max(start, seg.start);
    const hi = Math.min(end, seg.end);
    if (hi > lo) {
      if (first === null) first = at(lo);
      last = at(hi);
      kept += hi - lo;
    }
    out += span;
  }
  if (first === null || !(last > first)) return null;
  return { start: first, end: last, clipped: kept < end - start - 1 / NORMALIZED_FPS };
}

async function cut(ffmpeg, inPath, outPath, segments, hasAudio, crf, signal) {
  const graph = buildFilterGraph(segments, hasAudio);
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostats',
    '-i',
    inPath,
    '-filter_complex',
    graph,
    '-map',
    '[outv]',
    ...(hasAudio ? ['-map', '[outa]'] : []),
    ...x264Args({ crf }),
    '-pix_fmt',
    'yuv420p',
    ...(hasAudio ? ['-c:a', 'aac'] : []),
    outPath,
  ];
  const { code, stderr } = await runTool(ffmpeg, args, { signal });
  if (code !== 0) throw new Error(`ffmpeg exited ${code}\n${stderr.trim().split('\n').slice(-12).join('\n')}`);
}

// Where CUT writes before the rename — see ABORT in the header. Dot-prefixed (a bare `ls` skips it),
// in the output's own directory (same filesystem, so the rename is atomic), with the output's own
// extension (ffmpeg picks the container from it). pid + random so two runs into one directory, or a
// leftover from a killed run, can never collide.
function tempOutPathFor(outPath) {
  const ext = extname(outPath);
  return join(dirname(outPath), `.${basename(outPath, ext)}.tighten-${process.pid}-${randomBytes(4).toString('hex')}${ext}`);
}

/** Whether a process with this pid exists (EPERM: it does, it is just not ours to signal). */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * The STALE TEMPS ownership rule, for anything named after the run that made it: true only when
 * `pid` (a number or the digits from a name) is a valid pid that is neither this process nor alive.
 * A reused pid reads as alive, which is the safe miss. Shared by sweepDeadRunTemps and the cameras'
 * own sweeps (film-android.mjs sweepStaleProbeFiles), so the rule lives in one place.
 */
export function isDeadRunPid(pid) {
  const n = Number(pid);
  return Number.isInteger(n) && n > 0 && n !== process.pid && !pidAlive(n);
}

/**
 * STALE TEMPS (see ABORT in the header): remove the CUT temps a killed run left for THIS output, i.e.
 * `.<out>.tighten-<pid>-<hex><ext>` whose pid is no longer alive. Never another live run's (its pid is
 * alive), never this process's, never anything else in the directory. A pid reused by an unrelated live
 * process keeps its temp: the safe miss. Returns the paths removed.
 */
async function sweepStaleTemps(outPath) {
  const ext = extname(outPath);
  const stem = basename(outPath, ext);
  return sweepDeadRunTemps(dirname(outPath), new RegExp(`^\\.${escapeRegExp(stem)}\\.tighten-(\\d+)-[0-9a-f]+${escapeRegExp(ext)}$`));
}

/** A string matched literally inside a RegExp. */
export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The STALE TEMPS rule, for any temp that carries its run's pid: remove the entries of `dir` whose names
 * match `re` (its FIRST capture group is the owning run's pid) and whose owner is no longer alive. Never this
 * process's, never a live pid's: another run still writing it, or an unrelated process that reused the pid
 * (then the temp stays, the safe miss). Returns the paths removed. Used by tighten's own CUT temps
 * (sweepStaleTemps) and by film-android and film-ios for their burn temps (`.<name>.taps-<pid>.mp4`), which a
 * SIGKILL during the SALVAGE RINGS pass leaves behind (its orphaned ffmpeg finishes the file).
 */
export async function sweepDeadRunTemps(dir, re) {
  const removed = [];
  for (const name of await readdir(dir).catch(() => [])) {
    const m = re.exec(name);
    if (!m) continue;
    if (!isDeadRunPid(m[1])) continue;
    const path = join(dir, name);
    await rm(path, { force: true }).catch(() => {});
    removed.push(path);
  }
  return removed;
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
 * @param {{w:number,h:number,x:number,y:number}} [opts.detectFromCrop] the rectangle of the
 *   `detectFrom` frame that `inArg` was cropped to. With it the frame-size guard checks that
 *   `inArg` is exactly `w`x`h` and that the crop lies inside the detect frame, instead of demanding
 *   equal sizes; the duration guard is unchanged. Meaningless without `detectFrom`, and only a
 *   caller that made the crop can pass it. See DETECT-FROM in the header comment.
 * @param {number} [opts.detectFromHoldSec] seconds by which `inArg` holds the `detectFrom` file's last
 *   frame beyond its end (film-ios holds a take that ends on a still screen to the recorder's stop).
 *   The duration guard then expects `detectFrom + hold`, and DETECT pads the source's last frame by the
 *   same amount so the held tail is analysed like any other hold. Meaningless without `detectFrom`,
 *   and only a caller that made the hold can pass it.
 * @param {number} [opts.crf] x264 CRF of the re-encode, 0-51, default `DEFAULT_CRF` (18) from
 *   lib/encode.mjs. Throws on an out-of-range value, before anything is analysed.
 * @param {AbortSignal} [opts.signal] stop the run. Every ffmpeg/ffprobe child is SIGTERM'd, then
 *   SIGKILL'd after 2s if it lingers; the returned promise rejects with an Error whose
 *   `name === 'AbortError'` only after the children have exited, and after the temp output is
 *   removed. An aborted (or failed) run leaves no `-tight.mp4` and no temp file. See ABORT in the
 *   header.
 * @param {boolean} [opts.dryRun] plan only — print nothing, encode nothing, return the plan
 * @returns {Promise<{skipped: boolean, skipReason: string|null, dryRun: boolean, inPath: string,
 *   outPath: string|null, totalDuration: number, detectFrom: string|null,
 *   detectFromDurationSec: number|null, inPathDurationSec: number|null, detectMode: string,
 *   detectNoise: string, detectReason: string, freezes: Array<{start:number,end:number}>,
 *   keyframeBridges: Array<{start:number,end:number,keyframes:Array<{at:number,step:number,block:number}>}>,
 *   freezePlans: Array<{start:number,end:number,keeps:Array<{start:number,end:number}>,
 *     disposition:'clamped'|'split'|'spared'|'cut', protectedChanged:boolean}>,
 *   protected: {source: string|null, ranges: Array<{start:number,end:number}>, marginSec: number,
 *     freezesTouched: number},
 *   segments: Array<{start:number,end:number,clamped:boolean}>,
 *   warnings: string[], outDuration?: number, fileDurationSec?: number|null, inFileDurationSec?: number|null,
 *   cuts?: number, removedSec?: number, fileRemovedSec?: number|null}>}
 *   `outDuration` is the planned length (the kept spans added up); `fileDurationSec` is the written
 *   file's own container duration, present only when a file was written (null if unreadable). Report
 *   the second as the output's length: the cut lands off the plan by under a frame per off-grid kept segment. `inFileDurationSec`
 *   is the cut file's container duration, read the same way (ffprobe, to the ms; the banner without it):
 *   quote it as the input's length beside `fileDurationSec`, not `totalDuration`. `removedSec` is the
 *   plan's removal; `fileRemovedSec` is `inFileDurationSec - fileDurationSec` (null when either is), what
 *   the cut really took out. Print the line through cutSummary(), which closes A - X = B.
 *   `keyframeBridges` lists the holds KEYFRAME BRIDGE joined across an encoder keyframe (each is also an
 *   entry of `freezes`), with each keyframe's time, total step and largest 4x4 block step as fractions of
 *   full scale; empty unless the plan came from the threshold table.
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
    detectFromCrop,
    detectFromHoldSec,
    crf = DEFAULT_CRF,
    dryRun = false,
    signal,
  } = {},
) {
  parseCrf(crf, 'opts.crf');
  throwIfAborted(signal);
  const inPath = resolve(inArg);
  if (!(await fileExists(inPath))) {
    throw new Error(`input file not found: ${inPath}`);
  }
  // The library entrypoint overwrites its output silently and on purpose: film-web / film-android /
  // film-ios each run their own preflight over the whole set of files a take produces, and a second
  // refusal here would fire after the recording exists, when there is nothing useful to do about it.
  // The CLI (main()) does refuse — see PREFLIGHT.
  const outPath = outPathFor(inPath, out);
  // A killed earlier run's hidden temp for this same output would otherwise sit there forever (see
  // STALE TEMPS under ABORT). Not in a dry run, which writes nothing and deletes nothing.
  if (!dryRun) {
    for (const path of await sweepStaleTemps(outPath)) warn(`removed a stale temp a killed tighten run left: ${path}`);
  }

  const ffmpeg = await resolveFfmpeg();

  // DETECT-FROM (see the header comment of that name): DETECT/CALIBRATE run against `detectPath`,
  // CUT still runs against `inPath`. Absent, `detectPath` is just `inPath` and every line below
  // this block behaves exactly as it did before this feature existed.
  const detectFromGiven = typeof detectFrom === 'string' && detectFrom.trim() !== '';
  let detectPath = inPath;
  let detectFromDurationSec = null;
  let inPathDurationSec = null;
  let cutHasAudioOverride = null;
  let holdSec = 0;
  if (detectFromGiven) {
    detectPath = resolve(detectFrom);
    if (!(await fileExists(detectPath))) {
      throw new Error(`--detect-from file not found: ${detectPath}`);
    }
    let crop = null;
    if (detectFromCrop !== undefined && detectFromCrop !== null) {
      const c = detectFromCrop;
      const ok = ['w', 'h', 'x', 'y'].every((k) => Number.isInteger(c?.[k])) && c.w > 0 && c.h > 0 && c.x >= 0 && c.y >= 0;
      if (!ok) throw new Error(`opts.detectFromCrop must be { w, h, x, y } of whole numbers (got ${JSON.stringify(detectFromCrop)})`);
      crop = c;
    }
    if (detectFromHoldSec !== undefined && detectFromHoldSec !== null) {
      if (!(Number.isFinite(detectFromHoldSec) && detectFromHoldSec >= 0)) {
        throw new Error(`opts.detectFromHoldSec must be a number of seconds >= 0 (got ${detectFromHoldSec})`);
      }
      holdSec = detectFromHoldSec;
    }
    const guard = await guardDetectFrom(detectPath, inPath, signal, crop, holdSec);
    detectFromDurationSec = guard.detectFromDurationSec;
    inPathDurationSec = guard.inPathDurationSec;
    cutHasAudioOverride = guard.cutHasAudio;
    log(`detecting from ${detectPath}, cutting ${inPath} (durations ${detectFromDurationSec.toFixed(3)}s / ${inPathDurationSec.toFixed(3)}s)`);
  }

  const protection = await resolveProtection(inPath, { protect, protectMarginSec, sidecar });
  throwIfAborted(signal);

  let detected;
  try {
    detected = await detectFreezes(ffmpeg, detectPath, {
      holdSec,
      minStill,
      thresholdNoise: noise === 'auto' ? THRESHOLD_NOISE : noise,
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error(`freeze detection failed: ${err.message}`);
  }
  const { totalDuration } = detected;
  // With --detect-from, CUT's filter graph maps `[0:a]` off `inPath`, not `detectPath` — whether
  // that branch belongs in the graph has to come from `inPath`'s own streams, not the file that was
  // merely analyzed. Without --detect-from the two files are the same file, so this is unchanged.
  const hasAudio = detectFromGiven ? cutHasAudioOverride : detected.hasAudio;
  const calibration = calibrate(detected, { noise });
  const freezes = calibration.freezes;
  // The bridge only ever touches the threshold table (see KEYFRAME BRIDGE), so it is only news when
  // that is the table the plan comes from.
  const keyframeBridges = calibration.mode === 'threshold' ? detected.keyframeBridges : [];
  for (const run of keyframeBridges) {
    const at = run.keyframes
      .map((kf) => `${kf.at.toFixed(3)}s (step ${(kf.step * 256).toFixed(4)} levels, largest 4x4 block ${(kf.block * 256).toFixed(1)})`)
      .join(', ');
    log(`keyframe bridge: ${run.start.toFixed(3)}-${run.end.toFixed(3)} is one hold, the encoder's keyframe at ${at} re-coded it without changing it`);
  }
  if (calibration.mode === 'threshold' && detected.keyframeNote) log(detected.keyframeNote);

  const base = {
    dryRun,
    crf,
    inPath,
    totalDuration,
    detectFrom: detectFromGiven ? detectPath : null,
    detectFromDurationSec,
    detectFromHoldSec: detectFromGiven ? holdSec : null,
    inPathDurationSec,
    detectMode: calibration.mode,
    detectNoise: calibration.noise,
    detectReason: calibration.reason,
    freezes,
    keyframeBridges: keyframeBridges.map((run) => ({ start: run.start, end: run.end, keyframes: run.keyframes })),
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

  throwIfAborted(signal);
  await mkdir(dirname(outPath), { recursive: true });
  const tempPath = tempOutPathFor(outPath);
  try {
    await cut(ffmpeg, inPath, tempPath, segments, hasAudio, crf, signal);
    // Last look before the file becomes visible. No await sits between this check and the rename
    // call, so an abort cannot slip in between them.
    throwIfAborted(signal);
    await rename(tempPath, outPath);
  } catch (err) {
    // ffmpeg has exited by the time runTool settles, so nothing is still writing to the temp.
    await rm(tempPath, { force: true });
    if (err.name === 'AbortError') throw err;
    throw new Error(`cut pass failed: ${err.message}`);
  }

  // `outDuration` is the PLAN (the kept spans added up); the cut keeps whole grid frames, under a frame off it
  // per kept segment with an off-grid edge (THE CUT'S TIME MAP; measured after the half-open fix: 22.697s
  // planned, 22.700s written, 10 cuts. Before it, a frame per segment long: 27.019s against 27.20s).
  // What gets reported as the output's length has to be the file's, so read it back. Not abortable
  // and never throws: the file is final by now, and a caller that sees this promise reject would
  // conclude there is no `-tight.mp4` when there is one.
  result.fileDurationSec = await writtenDuration(ffmpeg, outPath);
  // The cut file's own length, the same way, for the `A -> B` lines (`totalDuration` is DETECT's banner
  // reading of the detect source plus any declared hold, which is not the file that was cut).
  result.inFileDurationSec = await writtenDuration(ffmpeg, inPath);
  // What the cut REALLY took out, file against file (see cutSummary); `removedSec` stays the plan's.
  result.fileRemovedSec =
    result.fileDurationSec != null && result.inFileDurationSec != null
      ? Number((result.inFileDurationSec - result.fileDurationSec).toFixed(3))
      : null;
  if (!cliOwnsOutput) for (const line of warnings) warn(line);
  return result;
}

/**
 * The numbers of a `A -> B (N cuts, X removed)` line, closed: A is the cut file's own length
 * (`inFileDurationSec`, else DETECT's `totalDuration`), B the written file's (`fileDurationSec`, else the
 * plan's `outDuration`, flagged `outPlanned`), and X = A - B, computed on the centiseconds that are printed,
 * so A - X = B holds on the line itself. `removedSec` (the plan: DETECT's total less the kept spans) is NOT
 * that number: DETECT reads the detect source (plus a declared hold), and the cut lands a fraction of a frame per segment off
 * the plan. Measured before, on an Android take: "tightened 25.83s -> 17.37s (3 cuts, 8.55s removed)",
 * where 25.83 - 17.37 = 8.46.
 * One copy for every caller: this file's CLI, film-android, film-ios and film-web.
 */
export function cutSummary(result) {
  const outPlanned = result.fileDurationSec == null;
  const inC = Math.round((result.inFileDurationSec ?? result.totalDuration) * 100);
  const outC = Math.round((outPlanned ? result.outDuration : result.fileDurationSec) * 100);
  const inSec = inC / 100;
  const outSec = outC / 100;
  const removedSec = (inC - outC) / 100;
  return {
    inSec,
    outSec,
    removedSec,
    outPlanned,
    line:
      `${inSec.toFixed(2)}s -> ${outSec.toFixed(2)}s (${result.cuts} cut${result.cuts === 1 ? '' : 's'}, ${removedSec.toFixed(2)}s removed)` +
      (outPlanned ? ' (the output length is the plan: the written file could not be read back)' : ''),
  };
}

// A file's container duration, to the millisecond, or null if it cannot be read: what tighten reports as
// the length of the file it wrote (`fileDurationSec`) and of the file it cut (`inFileDurationSec`), one
// source and one precision for both, so `A -> B` lines agree with ffprobe. ffprobe when it resolves; else
// `ffmpeg -i`'s banner, which TRUNCATES to centiseconds (measured: a 34.317s take read 34.31, an 11.333s
// tight file 11.33), so the normal path still needs ffmpeg only.
async function writtenDuration(ffmpeg, path) {
  try {
    const ffprobe = await resolveTool('ffprobe');
    const { code, stdout } = await runTool(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path]);
    const sec = Number(stdout.trim());
    if (code === 0 && stdout.trim() !== '' && Number.isFinite(sec)) return sec;
  } catch {
    // no ffprobe: the banner below
  }
  try {
    const { stderr } = await runTool(ffmpeg, ['-hide_banner', '-i', path]);
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
  } catch {
    return null;
  }
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
        `${plan.protectedChanged ? '  (protected)' : ''}` +
        `${result.keyframeBridges.some((run) => run.start === f.start && run.end === f.end) ? '  (across a keyframe)' : ''}`,
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

// Exit status for a run stopped by a signal: 128 + the signal number, what a shell reports.
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

async function main() {
  cliOwnsOutput = true;
  const { inArg, out, minStill, keep, noise, sidecar, detectFrom, crf, force, dryRun } = parseArgs(process.argv.slice(2));

  // PREFLIGHT (CLI only): never clobber a previous tighten. A dry run writes nothing, so it is
  // exempt — refusing to PLAN because an old output exists would be obstruction, not safety. The
  // subtitles are part of the output when the take has captions to carry (SUBTITLES), so the same
  // rule covers them.
  const outPath = outPathFor(resolve(inArg), out);
  const cues = await sidecarCaptionCues(resolve(inArg), sidecar);
  const srtPath = srtPathFor(outPath);
  if (!force && !dryRun) {
    for (const path of cues.length ? [outPath, srtPath] : [outPath]) {
      if (!(await fileExists(path))) continue;
      console.error(
        `[tighten] refusing to overwrite an existing take: ${path}\n` +
          '  pass --out <path> to write a new one, or --force to overwrite this one.',
      );
      process.exit(1);
    }
  }

  log(
    `analyzing ${resolve(inArg)} (freezedetect noise=${noise} d=${minStill}s)` +
      (detectFrom ? `, detecting from ${resolve(detectFrom)} instead` : '') +
      '...',
  );
  // ABORT (CLI side): a terminal signal aborts the pass, and the exit happens only after tighten()
  // has settled, i.e. after ffmpeg is gone and the temp is removed. Exit status is the shell
  // convention, 128 + signal number. A second signal while waiting changes nothing: the wait is
  // bounded by ABORT_KILL_GRACE_MS, and exiting early is exactly what orphans ffmpeg.
  const controller = new AbortController();
  let signalled = null;
  const onSignal = (name, code) => {
    if (signalled) return;
    signalled = { name, code };
    warn(`${name} — stopping ffmpeg and removing the partial output...`);
    controller.abort();
  };
  const handlers = Object.entries(SIGNAL_EXIT_CODES).map(([name, code]) => {
    const handler = () => onSignal(name, code);
    process.on(name, handler);
    return [name, handler];
  });
  let result;
  try {
    result = await tighten(inArg, { out, minStill, keep, noise, sidecar, detectFrom, crf, dryRun, signal: controller.signal });
  } catch (err) {
    if (signalled) {
      warn(`interrupted by ${signalled.name} — nothing written.`);
      process.exit(signalled.code);
    }
    console.error(`[tighten] ${err.message}`);
    process.exit(1);
  } finally {
    for (const [name, handler] of handlers) process.off(name, handler);
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
    // The plan's own three numbers, closed the same way as a real cut's (cutSummary): with no file
    // written, B is the plan and A the length DETECT read.
    const planned = cutSummary({ ...result, inFileDurationSec: null, fileDurationSec: null });
    log(`input duration:   ${planned.inSec.toFixed(2)}s`);
    log(`planned duration: ${planned.outSec.toFixed(2)}s`);
    log(`cuts planned:     ${result.cuts}`);
    log(`seconds removed:  ${planned.removedSec.toFixed(2)}s`);
    for (const line of result.warnings) warn(line);
    const tightCues = cuesThroughCut(cues, result.segments);
    if (tightCues.length) reportCues(cues, tightCues, `subtitles planned: ${srtPath}`);
    else {
      if (cues.length) reportCues(cues, tightCues, 'no subtitles planned: no caption survives the cut');
      if (await fileExists(srtPath)) log(`would remove a stale subtitles file from an earlier cut: ${srtPath}`);
    }
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
  // Input, output and removed close (removed = input - output, file against file: see cutSummary).
  const summary = cutSummary(result);
  log(`input duration:  ${summary.inSec.toFixed(2)}s`);
  log(
    `output duration: ${summary.outSec.toFixed(2)}s` +
      (summary.outPlanned ? ' (planned; the written file could not be read back)' : ''),
  );
  log(`cuts made:       ${result.cuts}`);
  log(`seconds removed: ${summary.removedSec.toFixed(2)}s`);
  log(`written: ${result.outPath}`);
  // SUBTITLES: the .srt at this name belongs to the video just written. With cues it is rewritten; with
  // none (no sidecar, --no-sidecar, no caption, or none survived the cut) one an earlier cut left there
  // no longer matches, and goes. Only reachable under --force: PREFLIGHT refused the video otherwise.
  const tightCues = cuesThroughCut(cues, result.segments);
  try {
    if (await writeSrt(srtPath, tightCues)) reportCues(cues, tightCues, `written: ${srtPath}`);
    else {
      if (cues.length) reportCues(cues, tightCues, 'no subtitles written: no caption survived the cut');
      if (await fileExists(srtPath)) {
        await rm(srtPath, { force: true });
        log(`removed a stale subtitles file from an earlier cut: ${srtPath}`);
      }
    }
  } catch (err) {
    console.error(`[tighten] could not update the subtitles ${srtPath}: ${err.message} (the video is written)`);
    process.exit(1);
  }
  for (const line of result.warnings) warn(line);
}

// The SUBTITLES line, and film-web's warning when the cut took caption time (a caption is a protected
// range, so that only happens to one tighten was not told about).
function reportCues(cues, tightCues, what) {
  log(`${what} (${tightCues.length} cue(s))`);
  const clipped = tightCues.filter((c) => c.clipped).length;
  if (tightCues.length < cues.length || clipped) {
    warn(`the subtitles lost caption time to the cut: ${cues.length - tightCues.length} dropped, ${clipped} clipped.`);
  }
}

// Only run the CLI when this file is executed directly — `import { tighten }` (film-web.mjs,
// film-android.mjs / film-ios.mjs --tighten) must not trigger it.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
