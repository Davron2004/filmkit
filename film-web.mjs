#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// film-web.mjs — runs a compiled flow file against the web stage and writes an .mp4
// plus a provenance sidecar .json.
//
//   node film-web.mjs <flow-file.mjs> [--browser auto|ego|playwright] [--out <dir>] [--name <stem>]
//                                    [--force] [--viewport <WxH>] [--serve-root <dir>] [--tighten]
//                                    [--crf <0-51>] [--no-captions]
//                                    [--scenario [--scenario-dir <dir>] [--scenario-verify [--scenario-config <file>]]]
//
// The flow file's default export is `async ({ stage }) => { ... }` — see lib/stage.mjs
// for the director API and examples/web/tip-demo.demo.mjs for a worked example.
//
// TWO CAMERAS BEHIND ONE FLOW API
//
// `--browser ego` films inside the user's already-running ego-browser, a
// Chromium fork that shares their real login profile — so a flow can walk through an app the
// user is signed into, which a throwaway Playwright profile cannot do. ego-browser exposes no
// external CDP endpoint; the only way in is a script on `ego-browser nodejs`'s stdin. This
// process therefore splits in two: the outer half (here) does preflight, serves local files,
// spawns the runtime, and does all the ffmpeg work; the inner half (lib/ego-runner.mjs) drives
// the browser and drops jpeg frames plus a timeline into a work directory. They talk over one
// pipe with a line protocol — see lib/ego-runner.mjs's STDOUT CONTRACT.
//
// `--browser playwright` is headless Chromium under Playwright, recorded the same way as ego: CDP
// screencast frames, not Playwright's `recordVideo` (which produced wrong-length videos; see
// lib/frames.mjs). The flow API, the stage and the assembler are shared by both.
//
// BACKEND SELECTION (`--browser auto`, the default; the last preflight step, lib/browser-probe.mjs):
//
//   requested    ego-browser (probeEgo)             Playwright (probePlaywright)   result
//   -----------  ---------------------------------  -----------------------------  -------------------------------
//   auto         ready                              not asked                      ego
//   auto         missing | not-answering            ready                          playwright + one-line notice
//   auto         missing | not-answering            not ready                      refuse: run setup.sh
//   ego          ready                              not asked                      ego
//   ego          missing                            not asked                      refuse: install hint
//   ego          not-answering                      not asked                      refuse: open the ego lite app
//   playwright   not asked                          ready / not ready              playwright / refuse: setup.sh
//
// ego-browser is found like every external tool (lib/tools.mjs: PATH, then $FILMKIT_EGO_BROWSER, then
// ~/.local/bin/ego-browser, where ego lite's onboarding links it), and filming spawns what was found.
// `ready` for ego is a real `ego-browser nodejs` round trip within 10s, not a PATH check: with no browser
// service to reach, the wrapper waits indefinitely instead of failing (measured with an unknown
// `--ego-server-name`), and the filming child has no timeout of its own. `ready` for Playwright is a real headless launch (it names the browser binary
// filming would use). Auto never falls back silently: the notice says why, and that a Playwright take
// starts signed out; the sidecar keeps `backend` (what filmed), `backendRequested` and `backendNote`
// (which, for a not-answering ego, quotes the probe's own detail: a timeout, an exit code and what the
// command said, or a spawn error, the same words tools/doctor.mjs prints).
// Why auto is the default: a machine without ego-browser (anyone but the author, at first) can film
// with nothing more than setup.sh, and a machine with ego running films signed in, as before.
//
// RUN STATE MACHINE. One run, one direction; every state can be left by a signal (see below):
//
//   parse ─> PREFLIGHT ─> FILMING ─> [SALVAGE] ─> ASSEMBLE ─> CHECKS ─> [TIGHTEN] ─> PLACE: COMMIT | failed slot ─> [SCENARIO]
//               │                      │           ▲                                     (writes the sidecar)       (ok take only)
//               └── refuse, exit 1     └─ flow throws / signal ─┘
//
// PREFLIGHT, in order, each refusal exit 1 with NO sidecar and nothing filmed: --serve-root exists, a
// crashed commit's stash recovered (lib/takes.mjs), no planned output exists unless --force
// (lib/preflight.mjs: `<name>.mp4`, `.json`, `-tight.mp4`, `.srt`, `-tight.srt`), the scenario's files are absent or ours
// (--scenario), the tool check (ffmpeg and ffprobe), then BACKEND SELECTION (above), last because it is
// the only step that takes a moment. It is the only back-edge. FILMING ends three ways: the flow returns (`ok`), throws (`flow-failed`), or a signal
// arrives (`interrupted`). The last two go through SALVAGE, which assembles whatever was filmed into a
// take, exactly as the device cameras do. Every run that gets past preflight writes a sidecar —
// `<name>.json`, or `<name>.failed[-N].json` when the take has no place at the plain name (see PLACE).
//
// EVERY BACKEND FILMS THE SAME WAY: CDP `Page.startScreencast` frames (lib/frames.mjs) into a work
// directory (`$TMPDIR/filmkit-<name>-*`, lib/workdir.mjs), assembled here by lib/assemble.mjs.
// The work directory is removed once its frames are in a take, whatever the take's status; it is
// kept, and its path printed, only when assembly itself failed or was stopped.
//
// BUILD UNDER A WORKING NAME, THEN PLACE BY STATUS. The video is encoded to `<name>.partial.mp4`,
// tighten writes `<name>.partial-tight.mp4`, and nothing reaches a plain name until the take's status
// is known and every file it will have exists, so nothing that ends badly can disturb a take that is
// already there:
//   ok, interrupted   -> COMMIT: `<name>.mp4`, `<name>-tight.mp4` if this take made one, the
//                        SUBTITLES, and `<name>.json`. The previous take is replaced WHOLE (only under
//                        --force; preflight refuses otherwise): its mp4, -tight, srts and json move together to a
//                        hidden `.<name>.prev*` stash (lib/takes.mjs, the device cameras' rule), the new
//                        files are renamed onto the freed names and the sidecar written, then the stash
//                        is deleted. So a take with no -tight of its own (no --tighten, nothing to cut,
//                        tighten interrupted) never sits beside the previous take's -tight, and the
//                        plain names never hold files of two different takes, whatever kills the run.
//   flow-failed,
//   failed            -> straight into the next free `<name>.failed[-N].*` slot, subtitles included (a slot
//                        is free when none of its files exist: lib/takes.mjs's rule, and film-web computes
//                        it itself because takes.mjs only offers it as a rename of plain-name
//                        files). An existing `<name>.mp4` and `<name>.json` are NEVER touched, --force
//                        or not: --force means "replace the take I am making", not "my last good
//                        take is now a casualty of a failed retake".
//   no video at all   -> the sidecar alone, in the `.failed[-N]` slot, whatever its status (an
//                        interrupted run with nothing filmed included): a sidecar at the plain
//                        name would name a video that does not exist and make preflight refuse the
//                        retake.
//
// STATUS AND WHAT EACH ONE LEAVES (`ok` is `status === 'ok'`; "plain" is `<name>.*`, "slot" is the
// next free `<name>.failed[-N].*`):
//
//   status        cause                                video       sidecar   exit        tighten
//   ------------  -----------------------------------  ----------  --------  ----------  -------
//   ok            flow ran to its end; every check     plain       plain     0           runs
//                 below passed
//   flow-failed   the flow threw (a flow error that    slot        slot      1, or the   no
//                 PREDATES a signal is this, not                             signal's
//                 interrupted)                                               (DECIDED
//   failed        take untrustworthy: timeline and     slot        slot      FAILURES)   no
//                 video disagree / file length off
//                 the clock / file unreadable /
//                 screencast stalled / assembly
//                 failed
//   interrupted   a signal arrived                     plain if a  plain, or  130 SIGINT  no
//                                                      video was   slot if    129 SIGHUP
//                                                      written     no video   143 SIGTERM
//
//   sidecar key         ok    flow-failed     failed           interrupted
//   ------------------  ----  --------------  ---------------  -------------------------------
//   status, ok, backend, backendRequested, backendNote, flow, flowSha256, argv, captions, viewport, serveRoot,
//   crf, filmkit, createdAt   always (backendNote: why auto fell back to playwright, else null; captions:
//                       'drawn', or 'hidden' under --no-captions)
//   error               null  the message     the check's msg  "interrupted by <sig> ..." + note
//   errorStack          null  the stack       null             null
//   interruptedBy       null  null or the     null or the      SIGINT | SIGHUP | SIGTERM
//                             signal (below)  signal (below)
//
// DECIDED FAILURES, the device cameras' rule: a take that had already failed (flow-failed, or failed by
// a check) when a signal arrived keeps its status, and the signal is recorded, not lost: `interruptedBy`
// is the signal, `error` ends in "; <SIG> was received while this failed take was being finished", and
// the exit code is the signal's (130/129/143). A signal that ENDED the take makes it `interrupted`.
//   output.path         plain plain->slot     slot             plain, or null (no video)
//   output.durationSec  ffprobe of the file, null when there is no video
//   output.srt          the subtitles beside output.path (SUBTITLES); null when none was written
//   output.tightSrt     `<name>-tight.srt` on an `ok` take that made a -tight video; else null
//   durationSec         same number as output.durationSec
//   clock, plannedDurationSec, timeline, partial   from the take; null/[]/null when no frames
//   outcomes            stage.oneOf's log [{ name, outcome, options, accept, filmAccept, start,
//                       end }], seconds into the video like `timeline`, on every status that has
//                       frames (a refused or timed-out branch point included: `outcome` names what
//                       the app did, null on a timeout); [] when the flow has no oneOf or no frames.
//                       Deliberately not in `timeline`, which tighten protects: a oneOf wait stays
//                       cuttable dead air.
//   capture             { ackFailures, stallCheck: { method: 'liveness'|'unverified', liveness: { ok, latencyMs,
//                       error } | null, match, motion, margin, error } | null, rate }; method 'unverified' when the
//                       probe could not run (kept, with a warning); match/motion are the SSIM comparison,
//                       a diagnostic that never decides; rate: { motionFps, targetFps, warnBelowFps,
//                       degraded, moves, framesInMotion, motionSec, plannedMotionSec } | null (CAPTURE RATE);
//                       opening: { state: 'cut'|'abandoned'|'marked'|'none', dropped, latencyMs } | null, the
//                       opening cut (lib/frames.mjs, THE OPENING FRAME): `dropped` setup frames, latency
//                       from the dressed page to its first frame; 'abandoned' warns, 'none' means open()
//                       never finished; null on a take rebuilt from the directory alone
//   tighten             result when it ran and finished; else null
//   workDir             null; set only when the work directory was kept (assembly failed/stopped)
//   scenario            only with --scenario on an `ok` take (see SCENARIO EXPORT); absent otherwise
//
// CHECKS BEFORE A TAKE IS `ok` (any one makes it `failed`, and its message says which):
//   1. the assembler's total and the recorder's timeline agree to 1/30s (two walks of the same
//      timestamps; they differ only if a frame delta was adjusted on the way);
//   2. ffprobe can read the encoded file AND its duration is within DURATION_TOLERANCE_SEC of the
//      recording clock (catches a truncated file; "unreadable" is a failure, never a skipped check);
//   3. no screencast ack failed while recording (an un-acked frame stalls delivery);
//   4. the screencast is still delivering when the take ends: a one-pixel paint change made while
//      capture is live produces a fresh frame within LIVENESS_TIMEOUT_MS (lib/frames.mjs's liveness
//      probe; catches a screencast that stopped delivering, whose video is frozen at exactly the
//      right length and passes 1 and 2). When the probe could not run the take is kept as
//      `unverified`, with a warning: the older content comparison cannot decide. See THE STALL CHECK.
// ffprobe and ffmpeg are both preflight requirements (resolveTool), so check 2 always runs.
//
// CAPTURE RATE: a WARNING, never a failure (sidecar `capture.rate`, console `capture was slow`). A capture
// can deliver every frame and still be slow: the take passes every check above, but it films at a
// fraction of its usual rate and every action takes longer. MEASURED: the first ego take after a cold
// start (verifier, 2026-10-06) filmed tip-demo in 37.9s at 237 frames, against 25.8s and 411-418 healthy,
// with the end-of-take probe answering in 292ms (healthy 4-40ms); caption ranges grew from 2.8s to 5.5s.
// The cause is the transport, not the screencast: every drain, ack, cursor step and keystroke is one
// round trip through the ego runtime, so a slow round trip slows capture AND the flow's own pacing. A
// scratch copy that adds 40ms to every such call reproduced it to the frame (220 frames, 37.90s).
// THE MEASURE is content-independent on purpose: frames captured per second of CURSOR MOTION, the
// stage's own move ranges (lib/stage.mjs `motion`). While the cursor moves the stage changes the page
// every CURSOR_STEP_MS, so there is always a picture to deliver, whatever the app does; a whole-take
// fps or a frame-gap percentile would read a flow full of static holds (or a slow caret blink) as a
// slow capture. Target 1000 / CURSOR_STEP_MS = 25. MEASURED, frames per second of motion (motion time over
// planned in brackets; the "+Nms" rows are the scratch copy's added latency, under ego):
//   healthy ego          tip-demo 26.4, 26.6; generate 32.0, 32.1, 31.5     (1.25-1.27x)
//   healthy playwright   tip-demo 23.1, 23.9; generate 29.7, 29.8           (1.26-1.28x)
//   healthy, cursor only 19.3-20.2 on both backends (a bare page or example.com, 1-2 moves; 2026-10-06)
//   +10ms per call       tip-demo 16.0 (1.95x; take 28.3s)
//   +20ms per call       tip-demo 11.0, generate 10.5 (2.85x; tip-demo 31.6s)
//   +40ms per call       tip-demo  7.0 (4.66x; 37.9s: the cold-start take above)
//   +60ms per call       tip-demo  5.0 (6.33x; 43.9s)
// Frames per cursor step stay 1.2-1.6 in the tip-demo and generate rows: capture keeps up with each step,
// the steps are what slow down. So the number falls with both symptoms at once, choppiness and stretched
// pacing. WHY A PAGE SETS ITS OWN HEALTHY FIGURE: where only the cursor changes, each 40ms step is ONE
// frame, and the step's own round trips (draw the cursor, move the real mouse) stretch it to ~50ms, so
// ~20 is that page at full health; a page that animates under the cursor (a hover transition, a caret)
// adds frames between steps, which is where tip-demo's 24-27 and generate's 30-32 come from.
// THRESHOLD: CAPTURE_RATE_WARN_FPS = half the target, 12.5. The healthy floor is 19.3 (a cursor-only page),
// the cold-start take 7.0, and 12.5 sits between them (1.5x under the floor, 1.8x over the cold start).
// +10ms (tip-demo 16.0, a take 10% longer) does not warn; +20ms (11.0, 22% longer) does.
// WHY NOT A FAILURE: `failed` means the take cannot be trusted (its video and timeline disagree, or capture
// stopped). A slow take is trustworthy: its timeline matches its video and tighten protects the right
// seconds. What it costs is smoothness and pace, graded rather than broken (16 fps reads fine, 7 does not),
// and only a person can weigh that against a retake. A host that is slow every time (a heavy app, a
// loaded machine) would never get an `ok` take at all if this failed. So the take stays `ok`, the sidecar
// says `capture.rate.degraded: true`, and the console says to film it again (the next take after a cold
// start has measured at full rate). Judged on EVERY status that has frames, by the same yardstick: a
// failed or interrupted take carries the moves that finished before it stopped (the salvage, and under
// ego the checkpoint, lib/workdir.mjs). `rate` is null only when no cursor move finished on film (the
// flow never moved the cursor, or stopped before its first move ended), or for a take killed under ego
// with a checkpoint from before moves were recorded.
//
// INTERRUPTION. SIGINT, SIGTERM and SIGHUP behave alike from the moment the handlers go up (before
// the work directory exists) until the sidecar is being written. SIGHUP is what an agent's shell
// sends when its turn ends (FEEDBACK #29). NO SIGNAL IS OUTSIDE THE HANDLERS' REACH between those
// two points; SIGKILL cannot be handled. A killed run leaves at most working-name files
// (`.partial.mp4`, `.partial-tight.mp4`, which preflight does not refuse and the next run overwrites),
// or, when killed mid-COMMIT, a `.<name>.prev*` stash beside new plain-name files and no sidecar pairing
// them with the wrong take: the next run's recoverCrashedStash restores the stash if the plain names
// are free and otherwise refuses, naming both takes. Under ego, also a runtime that stops itself (below).
//   - Before anything is spawned (during the work directory or the static server) a signal ends
//     the run without filming: the ego child is not spawned, the playwright browser is not
//     launched, exit with the signal's code, sidecar only.
//   - While FILMING the first signal stops the take: ego forwards it to `ego-browser nodejs` and
//     waits (runEgoChild; if the wrapper has not exited after ESCALATE_AFTER_MS it is sent SIGTERM,
//     then SIGKILL), sweeps the task space by name (the wrapper does not pass the signal down,
//     measured), waits for the runtime to stop writing, and rebuilds the take from the work
//     directory; playwright races the flow against the interrupt and salvages in-process. Then
//     SALVAGE assembles what exists. A flow error that PREDATES the first signal wins: the take is
//     `flow-failed` (ego stamps its error with the time it happened, `failure.at`).
//   - THE SECOND-SIGNAL RULE counts only signals that arrive after the work it would abort has
//     begun. The work that can be aborted is: the salvage assemble, a normal assemble, tighten.
//     Signals that arrive earlier (a second Ctrl-C during the ego sweep or the quiet-frames wait,
//     say) do not count: the salvage they are impatient for has not started, and aborting it
//     before it began would lose the take. So: the salvage assemble stops at the first signal that
//     arrives DURING it (the sidecar then says `interrupted` with no video, the work directory is
//     kept); a normal assemble of a flow that completed lets the first signal finish it (bounded:
//     ASSEMBLE_GRACE_MS after that signal) and stops at the second; tighten stops at the first.
//   - The first signal during assembly of a flow that COMPLETED lets the assembly finish, skips
//     tighten, and the take is `interrupted` with a note that the flow completed and tighten was
//     skipped; exit is the signal's. tighten() gets an AbortSignal and cleans up its own output.
//   - Output is never written under its final name until it is complete (see the working name
//     above): no signal, crash or SIGKILL leaves a half-written file at a name preflight refuses.
//   - A signal that arrives while the sidecar itself is being written is ignored: that write is
//     one small atomic rename, and the take is already whole.
//   - Playwright's own signal handlers are switched off (lib/backends/playwright.mjs), so this
//     file is the only thing that decides what a signal means. A dead terminal is harmless: every
//     message goes through console.*, which swallows a write to a closed pipe (verified with
//     both pipes closed).
//   - The ego RUNTIME can outlive the wrapper this file waited for (and outlive this file, if it
//     is SIGKILLed): `<workDir>/.alive` is a sentinel this file touches every second and the runner
//     polls; when it (or the work directory) disappears, or stops being touched for 20s, the runner
//     aborts, closes its task space and exits (lib/ego-runner.mjs).
//
// --tighten (opt-in): after an `ok` take is placed, runs tighten.mjs's dead-air cut over it
// (see that file's header for the algorithm) and writes a `-tight` variant alongside it. The raw
// recording is always kept — tighten is a post-process, not a replacement — and a tighten
// failure (e.g. ffmpeg missing) is reported but does NOT fail the overall command, since the raw
// video already recorded successfully by that point.
//
// SCENARIO EXPORT (--scenario, Part 2). After an `ok` take's sidecar is written, the camera emits a
// Playwright Test spec that replays THIS flow file under the test-mode stage: lib/scenario/emit-web.mjs
// writes `<flow-stem>.scenario.spec.mjs` plus the shared adapter `filmkit-stage.mjs` next to the flow,
// or into --scenario-dir <dir>. Only an `ok` take emits; any other status leaves the scenario alone.
//   * PREFLIGHT: an unmarked file at either planned path (a hand-written test, say) refuses the run,
//     exit 1, before the work directory exists and before anything is filmed, --force or not. A file
//     with the `@filmkit-generated` first line is derived and is overwritten without --force
//     (lib/scenario/generated.mjs). A spec directory from which Playwright Test does not resolve is a
//     warning here (the spec may be meant to run elsewhere); the load check then fails.
//   * STATE MACHINE of the phase, entered only with the take FINAL (placed, sidecar `ok` written):
//       EMIT ─> LOAD CHECK ─> [VERIFY] ─> exit 0 | 2 | the signal's
//     each step rewriting the sidecar's `scenario: { spec, adapter, adapterSha256, importFrom,
//     scenarioDir (the --scenario-dir given, or null; tools/scenario.mjs --from reuses it), warnings
//     (the spec's flow import or serve root leaves its project, lib/scenario/paths.mjs; printed too, and
//     the exit code stays as it was), loadCheck: { ok, output } | null, verify: null | { status, config,
//     durationSec, outcomes, error, outputDir } }`
//     (`outputDir`: a failed clean-room verify's kept test-results directory, see lib/scenario/emit-web.mjs)
//     (plus `error` when the emit itself failed). The load check (`playwright test --list`, clean room)
//     always runs; --scenario-verify runs the spec ONCE headless, in a clean room (no storageState) or,
//     with --scenario-config <file>, under the project's own config. It is opt-in because it repeats
//     the app's side effects, and an ego-filmed flow runs signed out there. VERIFY after a failed load
//     check is skipped (verify stays null).
//   * NOTHING IN THE PHASE CAN FAIL THE TAKE: an emit failure, a failed load check and a red verify all
//     leave `status: "ok"` and the video where it is, and make the exit code 2. A signal in the phase is
//     not a salvage: it stops the running check (SIGINT, SIGKILL 10s later), skips the rest, records
//     where it landed and exits with the signal's code. No back-edge, no retry.
//   * --scenario-dir, --scenario-verify without --scenario, and --scenario-config without
//     --scenario-verify, are usage errors (a flag that would silently do nothing).
//
// --no-captions AND SUBTITLES. `--no-captions` films every caption hold with nothing drawn (lib/stage.mjs,
// NO CAPTIONS): same pacing, same timeline, so tighten protects the same ranges, the scenario export is
// the same spec, and the subtitles have the same times as on a captioned take of the flow. What it skips
// is only what kept a drawn caption out of the way (the dodge to the top costs a captioned take
// 2 x 280ms per dodge); the reveal's bottom band stays (see that header for why).
// SUBTITLES: every take that has a video and at least one caption gets `<name>.srt` beside it (same
// name as the video: `<name>.failed[-N].srt` in a failed slot), from the timeline's caption ranges, and
// an `ok` take that made a -tight video also gets `<name>-tight.srt`, the same ranges through tighten's
// own cut (tighten.mjs, THE CUT'S TIME MAP; a caption cut away entirely is dropped, one cut in part is
// clipped, and the console says so). Captioned takes get them too, on purpose: a burned-in caption is
// pixels, and the .srt is what a player shows as closed captions, a screen reader reads, a translator
// translates and an editor imports; it costs nothing; and the files a take can have do not then depend
// on a flag, so preflight, the --force stash and the failed slots treat both files like the video,
// always (lib/takes.mjs). A take with no caption writes none (an empty .srt is no use), and the stash
// still moves the previous take's away, as it does a -tight. Subtitles are written at PLACE straight
// to their final names (atomically, like the sidecar; they are tiny), after the stash freed them. A
// subtitle write error is reported and never fails the take. lib/subtitles.mjs has the format.
//
// --crf <0-51> (default 18, lib/encode.mjs) is the x264 quality of every re-encode this run does
// (the assemble and tighten) and is recorded as the sidecar's `crf`; `filmkit: {commit, branch}`
// says which filmkit filmed it (lib/provenance.mjs). Both keys are the same on every camera.
//
// PLAYWRIGHT IS OPTIONAL: `playwright` is only ever imported dynamically (lib/backends/playwright.mjs is
// loaded that way, and lib/browser-probe.mjs's probePlaywright imports it inside the call), only when the
// backend is or may become playwright, so an ego run works with no node_modules at all.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, basename, extname, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStage, CURSOR_STEP_MS, VIEWPORT, DEFAULT_OUT_DIR } from './lib/stage.mjs';
import { assembleFromFrames, imageSimilarity, probeDuration } from './lib/assemble.mjs';
import { LIVENESS_TIMEOUT_MS, OPENING_TIMEOUT_MS } from './lib/frames.mjs';
import { DEFAULT_CRF, parseCrf } from './lib/encode.mjs';
import { filmkitCommit } from './lib/provenance.mjs';
import { failedPaths, recoverCrashedStash, slotFiles, stashPreviousTake } from './lib/takes.mjs';
import { captionCues, cuesThroughCut, writeSrt } from './lib/subtitles.mjs';
import { readTakeFiles, salvageTake, waitForQuietFrames, writeTakeFiles } from './lib/workdir.mjs';
import { preflight, validateNameStem } from './lib/preflight.mjs';
import { valueFor } from './lib/args.mjs';
import { startStaticServer } from './lib/static-server.mjs';
import { resolveTool, fileExists } from './lib/tools.mjs';
import { probeEgo, probePlaywright, EGO_INSTALL_HINT, PLAYWRIGHT_SETUP_HINT } from './lib/browser-probe.mjs';
import { cutSummary, tighten } from './tighten.mjs';
import { emitWebScenario, loadCheck, preflightWebScenario, startVerify } from './lib/scenario/emit-web.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Every signal that ends a take early, and the exit status of each — the same table the device
// cameras use (the shell's own "died on <signal>" numbers). SIGHUP is here on purpose: see
// INTERRUPTION in the header.
const INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const SIGNAL_EXIT = { SIGINT: 130, SIGHUP: 129, SIGTERM: 143 };
// How far the encoded file's container duration may sit from the recording clock's planned
// duration before the take is called untrustworthy. A healthy take lands within ~0.02s (measured:
// 25.566s file vs 25.552s planned); the failure this exists for is a video of a fraction of its
// length, so the number only has to be far below any real truncation.
const DURATION_TOLERANCE_SEC = 0.25;
// THE STALL CHECK (header, check 4). Since 2026-09-29 the LIVENESS PROBE decides (lib/frames.mjs):
// while capture is still live the backend changes one corner pixel (2% alpha) and waits up to
// LIVENESS_TIMEOUT_MS for a frame stamped after the change. The failure this check exists for is a
// stream that stopped DELIVERING (an un-acked frame ends delivery for good), and the probe asks that
// question directly, so how the frame is rasterized no longer matters.
// WHY IT REPLACED THE CONTENT COMPARISON BELOW: the screencast and Page.captureScreenshot rasterize
// dense text differently under ego. MEASURED, a healthy take of a text-heavy static page (scratchpad
// ego-origin/rootabs) scored match 0.9912-0.9916 against its own screenshot, gap 0.0085-0.0088, with the
// best alignment at dy=0 (not a shift): over the 0.005 margin, so every such take failed, on HEAD too.
// That gap is the size of the smallest STALLED gap measured before (0.009), so no margin can separate
// the two by content. MEASURED with the probe, latency from the change to the fresh frame, and the
// SSIM gap recorded beside it (playwright / ego):
//   healthy rootabs (dense text)  4ms, gap 0.0025 / 13ms, gap 0.0088    -> ok (SSIM alone: ego failed)
//   healthy tip-demo              9ms, gap 0.0005 /  8ms, gap 0.0013    -> ok
//   healthy generate              4ms, gap 0.0013 / 40ms, gap 0.0030    -> ok
//   STALLED (a scratch copy of lib/frames.mjs that stops acking 1.5s into the take, so delivery
//   stops as it does in a real Chromium stall; rootabs, tip-demo and generate on each backend, 6
//   takes): no frame within 2s every time -> failed (SSIM gaps 0.017-0.047 alongside).
// So: 4-40ms healthy against a 2000ms limit, and a stalled stream delivers nothing at all. The probe
// also closes the old LIMIT below: a stall on a page whose only later change is small is caught too.
// A stall on a page that then never changed also fails now (its video is right, its capture is not):
// a retake, never a silently kept broken capture.
// WHEN THE PROBE CANNOT RUN (the page would not evaluate), the take is kept as `unverified`
// (stallCheck.method), with a warning, and NOT judged by the content comparison below. MEASURED, why:
// the verifier's healthy ego takes of a dense-text page scored match 0.9568 against motion 1.0, gap
// 0.0432, three takes out of three, inside the 0.017-0.047 range of the STALLED takes above. Content
// cannot separate the two, so failing on it would reject healthy takes, and passing on it would vouch
// for nothing. An ack that failed while live still fails the take (check 3). The comparison is still
// computed and recorded (match, motion) as a diagnostic:
//   motion = SSIM(shot1, shot2)        how much the page changes by itself in 150ms
//   match  = SSIM(last frame, shot1)   how close the last delivered frame is to the page now
// HISTORY: until 2026-09-29 this comparison WAS the check. A healthy screencast's last frame is at
// most one frame old, so match should be at least as good as motion, a stalled one worse, and the
// take was `failed` when
//   match < motion - STALL_MARGIN
// (STALL_MARGIN is still recorded beside the numbers, so they can be read against the old rule).
// A static page has motion 1.0, so its last frame must match to within the margin; an animating
// page's motion is lower and the bar drops with it, so animation is not mistaken for a stall.
// MEASURED (gap = motion - match; a take fails at gap > STALL_MARGIN = 0.005), playwright / ego:
//   healthy static page          gap 0.0005 / 0.0013   (JPEG q90 frame vs PNG screenshot)
//   healthy tip-demo take        gap 0.0005 / 0.0013
//   healthy, cross-site nav      gap 0.0001 / 0.0002   (last action a navigation, 3s hold)
//   healthy, click at the end    gap 0.0000 / 0.0001   (page changes 0.2s before capture stops)
//   healthy, goto at the end     gap 0.0002 / 0.0001   (settle 50ms: the newest possible change)
//   healthy, animating page      gap -0.053 / -0.027   (a 200px square at 60fps; motion is lower
//                                than match, so the bar drops with it and nothing false-fires)
//   STALLED (acks dropped after 1.5s, real Chromium stall, playwright): match 0.9709, motion 0.9999,
//                                gap 0.029 -> failed
//   frozen frames of the tip-demo take vs its final page (ego): match 0.961-0.991, gap 0.009-0.04,
//                                every one is over the margin
// Worst healthy gap 0.0013 against a 0.005 margin, and the smallest stalled gap measured 0.009 (both on
// pages without dense text; see above for why that does not hold on a text-heavy page under ego).
// LIMIT: SSIM saturates. A page whose only change is a SMALL element moving (the 200px square)
// looks the same whether the frame is 100ms or 5s old, so a stall there is not detectable; the
// check caught stalls in content that changed by more than the page's own motion. The liveness probe
// has neither limit, and its ego stalls WERE reproduced end to end (a scratch frame sink that stops
// acking, above).
const STALL_MARGIN = 0.005;
// THE CAPTURE-RATE CHECK (header, CAPTURE RATE). While the cursor moves the stage changes the page every
// CURSOR_STEP_MS, so the screencast has a picture to deliver at least that often: the target is
// 1000 / CURSOR_STEP_MS = 25 frames per second of cursor motion, whatever the app on screen does.
const MOTION_TARGET_FPS = 1000 / CURSOR_STEP_MS;
const CAPTURE_RATE_WARN_FPS = MOTION_TARGET_FPS / 2; // 12.5: see CAPTURE RATE in the header for the measurements
const MOTION_MIN_PX = 1; // a cursor "move" shorter than this paints nothing and is not judged (captureRate)
// A normal assemble that a first signal caught is let finish, but not forever.
const ASSEMBLE_GRACE_MS = 60000;
// The ego wrapper is sent the signal and given this long to exit before it is escalated (SIGTERM,
// then SIGKILL ESCALATE_KILL_MS later): a wrapper that ignores it would otherwise hang film-web.
const ESCALATE_AFTER_MS = 5000;
const ESCALATE_KILL_MS = 3000;
// How long the task-space sweep may run before it is abandoned. It normally takes a fraction of a
// second; the ceiling only exists because the sweep ignores signals (below), so without it a hung
// ego-browser would make film-web unkillable short of SIGKILL.
const SWEEP_TIMEOUT_MS = 30000;
const USAGE =
  'usage: node film-web.mjs <flow-file.mjs> [--browser auto|ego|playwright] [--out <dir>]\n' +
  '                        [--name <stem>] [--force] [--viewport <WxH>] [--serve-root <dir>]\n' +
  '                        [--tighten] [--min-still <sec>] [--keep <sec>] [--noise <level>]\n' +
  '                        [--crf <0-51, default ' + DEFAULT_CRF + '>] [--no-captions]\n' +
  '                        [--scenario [--scenario-dir <dir>] [--scenario-verify [--scenario-config <file>]]]';

function parseArgs(argv) {
  const rest = [];
  let out;
  let name;
  let browser = 'auto';
  let force = false;
  let viewport = VIEWPORT;
  let serveRoot;
  let doTighten = false;
  let minStill = 1.2;
  let keep = 0.6;
  let noise = 'auto';
  let crf = DEFAULT_CRF;
  let captions = true;
  let scenario = false;
  let scenarioDir;
  let scenarioVerify = false;
  let scenarioConfig;
  // `--out --force` must not create a directory called "--force"; see lib/args.mjs.
  const usageError = (msg) => {
    console.error(msg);
    process.exit(1);
  };
  const take = (i, flag) => valueFor(argv, i, flag, usageError);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out = take(i, '--out');
      i++;
    } else if (argv[i] === '--serve-root') {
      serveRoot = take(i, '--serve-root');
      i++;
    } else if (argv[i] === '--name') {
      name = take(i, '--name');
      i++;
    } else if (argv[i] === '--browser') {
      browser = take(i, '--browser');
      i++;
    } else if (argv[i] === '--force') {
      force = true;
    } else if (argv[i] === '--viewport') {
      const m = take(i, '--viewport').match(/^(\d+)x(\d+)$/);
      if (!m) usageError('--viewport must be <width>x<height>, e.g. --viewport 1280x720');
      viewport = { width: Number(m[1]), height: Number(m[2]) };
      // yuv420p (what every player wants) subsamples chroma 2x2: an odd dimension either fails in
      // the encoder or silently loses a row, and the frame-size check would then never match.
      if (viewport.width < 2 || viewport.height < 2 || viewport.width % 2 || viewport.height % 2) {
        usageError(`--viewport dimensions must be even and at least 2 (got ${m[1]}x${m[2]}); yuv420p cannot encode an odd size`);
      }
      i++;
    } else if (argv[i] === '--tighten') {
      doTighten = true;
    } else if (argv[i] === '--no-captions') {
      captions = false;
    } else if (argv[i] === '--min-still') {
      minStill = Number(take(i, '--min-still'));
      i++;
    } else if (argv[i] === '--keep') {
      keep = Number(take(i, '--keep'));
      i++;
    } else if (argv[i] === '--noise') {
      noise = take(i, '--noise');
      i++;
    } else if (argv[i] === '--scenario') {
      scenario = true;
    } else if (argv[i] === '--scenario-dir') {
      scenarioDir = take(i, '--scenario-dir');
      i++;
    } else if (argv[i] === '--scenario-verify') {
      scenarioVerify = true;
    } else if (argv[i] === '--scenario-config') {
      scenarioConfig = take(i, '--scenario-config');
      i++;
    } else if (argv[i] === '--crf') {
      try {
        crf = parseCrf(take(i, '--crf'), '--crf');
      } catch (err) {
        usageError(err.message);
      }
      i++;
    } else {
      rest.push(argv[i]);
    }
  }
  if (rest.length !== 1) {
    console.error(USAGE);
    process.exit(1);
  }
  if (browser !== 'auto' && browser !== 'ego' && browser !== 'playwright') {
    console.error(`--browser must be "auto", "ego" or "playwright" (got "${browser}")`);
    process.exit(1);
  }
  try {
    validateNameStem(name);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (!Number.isFinite(minStill) || minStill <= 0) usageError(`--min-still must be positive (got "${minStill}")`);
  if (!Number.isFinite(keep) || keep < 0) usageError(`--keep must be non-negative (got "${keep}")`);
  // The modifiers mean nothing on their own: an error, not an implication (header, SCENARIO EXPORT).
  if (!scenario && scenarioDir !== undefined) usageError('--scenario-dir needs --scenario');
  if (!scenario && scenarioVerify) usageError('--scenario-verify needs --scenario');
  if (scenarioConfig !== undefined && !scenarioVerify) usageError('--scenario-config needs --scenario-verify (it is the config the verify run uses)');
  return {
    flowArg: rest[0],
    outDir: out ? resolve(out) : DEFAULT_OUT_DIR,
    name,
    browser,
    force,
    viewport,
    serveRoot: serveRoot ? resolve(serveRoot) : undefined,
    doTighten,
    minStill,
    keep,
    noise,
    crf,
    captions,
    scenario,
    scenarioDir: scenarioDir ? resolve(scenarioDir) : undefined,
    scenarioVerify,
    scenarioConfig: scenarioConfig ? resolve(scenarioConfig) : undefined,
  };
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

// ── ego: the bootstrap script handed to `ego-browser nodejs` on stdin ────────────────────────
// Deliberately three statements. Everything real is in lib/ego-runner.mjs, which is ordinary
// reviewable source; the runtime's helpers are captured here, at the one place they exist as
// bare globals, and passed down explicitly.
function bootstrapScript(config) {
  const runnerUrl = pathToFileURL(join(HERE, 'lib', 'ego-runner.mjs')).href;
  return `const { run } = await import(${JSON.stringify(runnerUrl)});
const globals = { cdp, js, drainEvents, wait, cliLog, useOrCreateTaskSpace, completeTaskSpace, openOrReuseTab, gotoAndWait, pageInfo };
await run({ globals, ...JSON.parse(${JSON.stringify(JSON.stringify(config))}) });
`;
}

// `interruptible: false` is for cleanup work (the sweep): a signal that arrives while it runs is
// swallowed instead of forwarded, because forwarding it would kill the very thing that is
// cleaning up after the interrupt. `timeoutMs` bounds such a child (rejects when it fires).
// `signalled` is asked once the handlers are in place: a signal that arrived between the caller's
// last check and the spawn is forwarded at once instead of being lost (the child would film the
// whole take).
// `egoBin` is the ego-browser command BACKEND SELECTION resolved (lib/browser-probe.mjs: PATH, then
// $FILMKIT_EGO_BROWSER, then ~/.local/bin), so the take films through the same binary the probe reached.
let egoBin = null;
function runEgoChild(script, { interruptible = true, timeoutMs = 0, signalled = () => null } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(egoBin ?? 'ego-browser', ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let result = null;
    let failure = null;
    const other = [];

    const onLine = (line) => {
      const at = line.indexOf('[filmkit] ');
      if (at === -1) {
        if (line.trim()) other.push(line);
        return;
      }
      const body = line.slice(at + '[filmkit] '.length);
      const sp = body.indexOf(' ');
      const kind = sp === -1 ? body : body.slice(0, sp);
      const payload = sp === -1 ? '' : body.slice(sp + 1);
      // A throw from inside this handler would escape into the stream's 'data' emit, leave the
      // child running, and leave this promise pending forever — the static server and the work
      // directory with it. The payload is JSON we wrote ourselves, but the line it arrived on is
      // shared with whatever else ego-browser prints, so it can be interleaved or truncated.
      // A line that will not parse is not a protocol line; treat it as output and move on.
      const parsed = (raw) => {
        try {
          return JSON.parse(raw);
        } catch {
          other.push(line);
          return null;
        }
      };
      if (kind === 'note') console.log(`[ego] ${payload}`);
      else if (kind === 'done') result = parsed(payload) ?? result;
      else if (kind === 'error') failure = parsed(payload) ?? failure;
      else other.push(line);
    };

    // cliLog writes on stderr, and ego-browser's own chatter shares both streams, so BOTH are
    // line-split and scanned for the protocol; anything unrecognised is held back and only
    // printed if the run fails.
    const tails = { stdout: '', stderr: '' };
    for (const name of ['stdout', 'stderr']) {
      child[name].setEncoding('utf8');
      child[name].on('data', (chunk) => {
        const lines = (tails[name] + chunk).split('\n');
        tails[name] = lines.pop();
        for (const line of lines) onLine(line);
      });
    }

    // Ctrl-C (or a hangup: SIGHUP is handled identically) stops the take rather than abandoning
    // it: the signal is forwarded and we then wait for the child, so the run still lands on the
    // ordinary failure path (which sweeps the task space). MEASURED: the `ego-browser` wrapper
    // does NOT pass the signal down to the inner node runtime — it dies with code 8 and
    // lib/ego-runner.mjs's own SIGINT handler never runs. That is exactly why the sweep below
    // exists and is not merely belt-and-braces.
    //
    // A wrapper that does not exit after the forwarded signal is ESCALATED — SIGTERM after
    // ESCALATE_AFTER_MS, SIGKILL ESCALATE_KILL_MS later — because everything after this call
    // (the sweep, the take) waits for its 'close', and a wrapper that ignores a signal would
    // otherwise hang the whole run. Killing the wrapper does not stop the runtime behind it; the
    // sweep and the runner's own sentinel poll (lib/ego-runner.mjs) do.
    let interrupted = false;
    let escalation = null;
    const forward = (sig) => {
      interrupted = true;
      child.kill(sig);
      if (escalation) return;
      escalation = setTimeout(() => {
        child.kill('SIGTERM');
        escalation = setTimeout(() => child.kill('SIGKILL'), ESCALATE_KILL_MS);
      }, ESCALATE_AFTER_MS);
    };
    const swallow = () => {};
    const onSignal = interruptible ? forward : swallow;
    for (const sig of INTERRUPT_SIGNALS) process.on(sig, onSignal);
    if (interruptible && signalled()) forward(signalled());

    let timer = null;
    const unhook = () => {
      for (const sig of INTERRUPT_SIGNALS) process.off(sig, onSignal);
      if (timer) clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        // 'close' follows and would resolve; reject first so the caller sees a failure.
        unhook();
        reject(new Error(`\`ego-browser nodejs\` did not finish within ${timeoutMs}ms`));
      }, timeoutMs);
    }
    child.on('error', (err) => {
      unhook(); // a spawn failure ends this call too — leaving the listeners on leaks a handler
      reject(new Error(`failed to run \`ego-browser nodejs\`: ${err.message}`));
    });
    child.on('close', (code, killedBy) => {
      unhook();
      for (const name of ['stdout', 'stderr']) if (tails[name]) onLine(tails[name]);
      resolvePromise({ result, failure, code: code ?? (killedBy ? `signal ${killedBy}` : code), other, interrupted });
    });

    // A child that dies before it finishes reading the script makes this write EPIPE, which with
    // no listener is an uncaught exception rather than the "the child failed" report we want.
    // The 'close' handler above is what actually reports; this only keeps the crash from winning.
    child.stdin.on('error', () => {});
    child.stdin.end(script);
  });
}

// A task space is the one thing a filming run can leave behind in the USER'S browser: a live
// tab in a context they did not ask for. lib/ego-runner.mjs closes it in a finally, but a finally
// only runs if the process survives long enough to reach it, and the `ego-browser` wrapper is
// measurably capable of dying without passing the signal down. So the outer process — the one
// that decided to interrupt — sweeps by name afterwards. Idempotent: on the ordinary failure
// path the runner already closed it and this finds nothing. Best-effort by design; a failure
// here must not replace the real error the caller is about to report.
async function sweepTaskSpace(name) {
  const script = `const want = ${JSON.stringify(name)};
const found = (await listTaskSpaces()).find((s) => s.name === want || s.taskId === want);
if (found) { await completeTaskSpace(found.id, { keep: false }); cliLog('FILMKIT_SWEPT ' + found.id); }
`;
  try {
    const { other } = await runEgoChild(script, { interruptible: false, timeoutMs: SWEEP_TIMEOUT_MS });
    // Silent when there was nothing to sweep, which is the ordinary case: the runner's own
    // finally already closed the space. The line means "something was left behind and I cleaned
    // it up", and printing it on runs where that did not happen made it read as noise attached to
    // some failure modes and not others.
    return other.some((l) => l.includes('FILMKIT_SWEPT'));
  } catch {
    console.error(`[film-web] could not sweep the ego task space "${name}" — close it in ego-browser if it is still open.`);
    return false;
  }
}

// One place that knows how many signals have arrived and what each one is allowed to stop.
//   - `tripped` rejects on the FIRST signal, for racing against work that cannot be cancelled (a
//     flow parked in its own setTimeout).
//   - beginWork() hands out an AbortSignal for one stretch of abortable work, and endWork() closes
//     it. THE SECOND-SIGNAL RULE (header) is a property of that stretch: only signals that arrive
//     AFTER beginWork() count toward aborting it.
//       abortOn 'first': the first such signal aborts (tighten).
//       abortOn 'next' : the work is the response to a signal that has ALREADY arrived (the salvage
//                        assemble; or a normal assemble after a signal that landed as the flow
//                        ended), so the next signal aborts it. If NO signal had arrived when it
//                        began (a normal assemble), the first signal lets it finish — bounded by
//                        `graceMs` — and the second aborts it.
// The handlers stay installed until the process exits, so a late or repeated signal is absorbed
// instead of falling through to the default disposition, which would kill the process half-way
// through a teardown (how browsers get orphaned and half-written files get left).
function createInterrupt() {
  let count = 0;
  let first = null;
  let firstAt = 0;
  let current = null;
  let trip;
  const tripped = new Promise((_, reject) => {
    trip = reject;
  });
  tripped.catch(() => {}); // a rejection nobody is racing yet is not "unhandled"
  const abort = (w) => {
    if (w.timer) clearTimeout(w.timer);
    w.controller.abort();
  };
  const handle = (sig) => {
    count++;
    if (count === 1) {
      first = sig;
      firstAt = Date.now();
      const err = new Error('interrupted');
      err.interrupted = true;
      trip(err);
    }
    const w = current;
    if (!w || w.controller.signal.aborted) return;
    const during = count - w.baseline; // signals that arrived since this work began
    if (w.abortOn === 'first') {
      if (during >= 1) abort(w);
    } else if (during >= (w.hadPrior ? 1 : 2)) {
      abort(w);
    } else if (during === 1 && w.graceMs > 0 && !w.timer) {
      w.timer = setTimeout(() => abort(w), w.graceMs);
    }
  };
  for (const sig of INTERRUPT_SIGNALS) process.on(sig, handle);
  return {
    tripped,
    /** The first signal received, or null. */
    get signal() {
      return first;
    },
    /** When it arrived (epoch ms), or 0. */
    get at() {
      return firstAt;
    },
    beginWork({ abortOn = 'next', graceMs = 0 } = {}) {
      const controller = new AbortController();
      current = { controller, abortOn, graceMs, baseline: count, hadPrior: count >= 1, timer: null };
      if (abortOn === 'first' && count >= 1) controller.abort(); // nothing to interrupt: skip it
      return controller.signal;
    },
    endWork() {
      if (current?.timer) clearTimeout(current.timer);
      current = null;
    },
  };
}

const interruptedError = () => Object.assign(new Error('interrupted'), { interrupted: true });

// FILMING, ego. Leaves the take in `workDir` (the runner writes frames.json/timeline.json on a
// finished OR a failed take; a killed runtime leaves only frames and a checkpoint, which
// readTakeFiles rebuilds from). Throws on failure or interruption, with `err.interrupted` set when
// the interrupt is what ended the take.
async function filmWithEgo({ flowPath, flowName, viewport, serveRoot, captions, workDir, interrupt }) {
  // Local files are served, not opened off file:// — see lib/static-server.mjs for the caps.
  // The root defaults to the flow file's own directory, which is where a flow's fixture normally
  // lives; --serve-root widens it deliberately, for a flow that films a build output elsewhere.
  const server = await startStaticServer(serveRoot ?? dirname(flowPath));
  try {
    // A signal during the work directory or the server bind has nothing to stop yet: do not spawn
    // a child that would film the whole take for a run that was already told to end.
    if (interrupt.signal) throw interruptedError();
    // ONE TASK SPACE PER RUN, never per flow name. The runner claims it with useOrCreateTaskSpace,
    // which matches by NAME, and the ego runtime is shared by every run of every agent. MEASURED
    // with `filmkit <name>`: film-web SIGKILLed mid-take, the same --name filmed again at once ->
    // the retake adopted the orphan's live space (same id, both runs driving one tab), and when
    // the orphan's sentinel went stale ~20s later it closed that space under the retake, which
    // failed with "Task space not found". The mkdtemp suffix makes the name unique to this work
    // directory (and so to this run), for the runner's claim and this file's sweep alike.
    const taskSpaceName = `filmkit ${flowName} ${basename(workDir).slice(-6)}`;
    const script = bootstrapScript({
      flowPath,
      viewport,
      workDir,
      taskSpaceName,
      serverOrigin: server.origin,
      serverRoot: server.root,
      captions,
    });
    const { result, failure, code, other, interrupted } = await runEgoChild(script, { signalled: () => interrupt.signal });
    if (result) return;
    // No `done` sentinel: the run failed, whatever the wrapper's exit status said.
    if (await sweepTaskSpace(taskSpaceName)) {
      console.error(`[film-web] closed the leftover ego task space "${taskSpaceName}".`);
    }
    // The runtime can outlive the wrapper we waited for, and is still writing its last frames and
    // its own salvage files as the task space closes under it: let it finish before anyone reads.
    await waitForQuietFrames(workDir);
    const detail = interrupted
      ? 'interrupted'
      : failure?.message || other.join('\n').trim() || `ego-browser nodejs ended (${typeof code === 'string' ? code : `exit code ${code}`}) and said nothing`;
    const err = new Error(detail);
    // The useful stack is the flow's, from inside the ego runtime — this process's own frames
    // only say "the child failed", which the reader already knows.
    if (failure?.stack) err.stack = failure.stack;
    // A flow error that PREDATES the signal is the take's cause of death, not the signal: the
    // runner stamps its error with the time it happened. (Closing the task space under a running
    // flow makes it throw too — that error is stamped AFTER the signal, and is the interrupt.)
    const predates = Number.isFinite(failure?.at) && interrupt.at > 0 && failure.at <= interrupt.at;
    err.interrupted = interrupted && !predates;
    throw err;
  } finally {
    await server.close();
  }
}

// FILMING, playwright. Same contract as filmWithEgo: the take (or its salvage) is in `workDir`.
// The flow is raced against the interrupt so a flow parked in a plain JS wait still ends promptly.
// Local files are served from the same root ego's static server uses (the flow's directory unless
// --serve-root), over http://filmkit.localhost (lib/scenario/filmkit-stage.mjs, LOCAL FILES).
async function filmWithPlaywright({ flowPath, viewport, serveRoot, captions, workDir, interrupt }) {
  const mod = await import(pathToFileURL(flowPath).href);
  const flow = mod.default;
  if (typeof flow !== 'function') {
    throw new Error(`Flow file ${flowPath} must have a default export: async ({ stage }) => { ... }`);
  }
  // Loaded only here: this is the one import in the whole tool that needs node_modules, and an
  // ego run must not (README: Playwright is only for the fallback).
  let createPlaywrightBackend;
  try {
    ({ createPlaywrightBackend } = await import('./lib/backends/playwright.mjs'));
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && /playwright/.test(String(err.message))) {
      throw new Error(`filming with Playwright needs the \`playwright\` package, which is not installed. ${PLAYWRIGHT_SETUP_HINT}, then run this again.`);
    }
    throw err;
  }
  if (interrupt.signal) throw interruptedError(); // nothing launched yet, nothing to salvage
  const backend = createPlaywrightBackend({ viewport, workDir, serveRoot: serveRoot ?? dirname(flowPath) });
  const stage = createStage({ backend, viewport, captions });
  try {
    const filming = (async () => {
      await backend.launch();
      await backend.startRecording();
      await flow({ stage });
      return stage.finish();
    })();
    filming.catch(() => {}); // if the interrupt wins the race, this is the promise nobody awaits
    const take = await Promise.race([filming, interrupt.tripped]);
    await writeTakeFiles(workDir, {
      recording: take.recording,
      timeline: take.timeline,
      outcomes: take.outcomes,
      motion: take.motion,
      clock: take.clock,
      endSettleSec: take.endSettleSec,
      partial: false,
    });
  } catch (err) {
    // The one teardown for a thrown flow AND for an interrupt: closes the browser (waiting for a
    // launch that is still in flight), and turns whatever was captured into a partial take.
    const { warning } = await salvageTake(workDir, { stage, backend });
    if (warning) console.error(`[film-web] ${warning}`);
    throw err;
  }
}

// Encode to the WORKING name (`<name>.partial.mp4`); placing it under its final name is main()'s
// decision, made once the status is known. On failure or abort the partial is removed (the
// assembler has waited for ffmpeg to be gone by then).
async function assembleTake({ ffmpeg, take, workDir, partialPath, crf, signal }) {
  try {
    return await assembleFromFrames(
      ffmpeg,
      { dir: take.framesDir, frames: take.frames, tailSec: take.meta.tailSec },
      partialPath,
      workDir,
      { crf, signal },
    );
  } catch (err) {
    await rm(partialPath, { force: true });
    throw err;
  }
}

async function writeSidecar(path, payload) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n');
  await rename(tmp, path);
}

// The next free `<name>.failed[-N]` slot: free when none of its files exist (lib/takes.mjs's
// rule, so a video and its sidecar can never land in different slots). Not takes.mjs's own
// firstFreeSlot because that is private and markTakeFailed only moves files that already sit at
// the plain name, which is exactly what this run must not create for a take that failed.
async function claimFailedSlot(outDir, name) {
  for (let n = 1; n <= 999; n++) {
    const slot = failedPaths(outDir, name, n === 1 ? 'failed' : `failed-${n}`);
    const taken = await Promise.all(slotFiles(slot).map(fileExists));
    if (!taken.some(Boolean)) return slot;
  }
  throw new Error(`999 failed takes of "${name}" already sit in ${outDir} — clear some out`);
}

// CAPTURE RATE (header): frames that arrived while the cursor moved, per second of cursor motion, from the
// stage's own move ranges (lib/stage.mjs `motion`; both on the take's clock, seconds from its first
// frame). null when there is nothing to judge by: no cursor move finished on film (header, CAPTURE RATE).
function captureRate(frames, motion) {
  // A move that did not move the cursor (distancePx under 1: a click() right after a point() at the same
  // target) changes nothing on screen, so no frame can arrive during it: counting it read a healthy
  // 2-move take as 11 fps. A range from before distancePx was recorded counts, as it always did.
  const moves = (motion ?? []).filter((m) => Number.isFinite(m.start) && m.end > m.start && !(m.distancePx < MOTION_MIN_PX));
  if (!moves.length) return null;
  let motionSec = 0;
  let plannedSec = 0;
  let inMotion = 0;
  for (const m of moves) {
    motionSec += m.end - m.start;
    plannedSec += (m.plannedMs ?? 0) / 1000;
    for (const f of frames) if (f.t >= m.start && f.t <= m.end) inMotion++;
  }
  const motionFps = inMotion / motionSec;
  return {
    motionFps: Number(motionFps.toFixed(1)),
    targetFps: MOTION_TARGET_FPS,
    warnBelowFps: CAPTURE_RATE_WARN_FPS,
    degraded: motionFps < CAPTURE_RATE_WARN_FPS,
    moves: moves.length,
    framesInMotion: inMotion,
    motionSec: Number(motionSec.toFixed(2)),
    plannedMotionSec: Number(plannedSec.toFixed(2)),
  };
}

// SCENARIO (header, SCENARIO EXPORT). Entered with a FINAL `ok` take; returns the exit code (0, 2, or
// the signal's). Every step rewrites the sidecar's `scenario` block, so a run that stops half-way still
// says how far it got. Nothing here touches the take.
async function scenarioPhase({ flowPath, scenarioDir, serveRoot, viewport, scenarioVerify, scenarioConfig, take, sidecarPath, sidecar, interrupt }) {
  const record = { spec: null, adapter: null, adapterSha256: null, importFrom: null, scenarioDir: scenarioDir ?? null, warnings: [], loadCheck: null, verify: null };
  const save = () => writeSidecar(sidecarPath, { ...sidecar, scenario: record });
  // The first signal from here on aborts the running check (abortOn 'first'); one that arrived before
  // this point (while the sidecar was written) aborts at once, so the phase is skipped.
  const signal = interrupt.beginWork({ abortOn: 'first' });
  let verifyHandle = null;
  const onAbort = () => verifyHandle?.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) {
      record.error = `skipped: interrupted by ${interrupt.signal} before the scenario export`;
    } else {
      const emitted = await emitWebScenario({ flowPath, scenarioDir, serveRoot, viewport, take, filmkit: filmkitCommit() });
      Object.assign(record, { spec: emitted.spec, adapter: emitted.adapter, adapterSha256: emitted.adapterSha256, importFrom: emitted.importFrom, warnings: emitted.warnings });
      console.log(`[scenario] ${emitted.specAction === 'overwrite' ? 'rewrote' : 'wrote'} ${emitted.spec} (imports ${emitted.importFrom})`);
      for (const w of emitted.warnings) console.error(`[scenario] ⚠️  warning: ${w}`);
      await save();
      if (!signal.aborted) {
        record.loadCheck = await loadCheck({ spec: emitted.spec, signal });
        console.log(record.loadCheck.ok ? '[scenario] load check (playwright test --list): OK' : `[scenario] ⚠️  load check failed:\n${record.loadCheck.output}`);
        await save();
      }
      if (scenarioVerify && record.loadCheck?.ok && !signal.aborted) {
        console.log(`[scenario] --scenario-verify: running the spec once, headless, ${scenarioConfig ? `under ${scenarioConfig}` : 'in a clean room (no storageState)'}...`);
        verifyHandle = startVerify({ spec: emitted.spec, config: scenarioConfig ?? null, timeoutMs: Number(process.env.FILMKIT_TIMEOUT_MS) || emitted.timeoutMs });
        record.verify = await verifyHandle.done;
        verifyHandle = null;
        const v = record.verify;
        console.log(
          v.status === 'passed'
            ? `[scenario] --scenario-verify passed in ${v.durationSec}s`
            : `[scenario] ⚠️  --scenario-verify ${v.status} after ${v.durationSec}s (the take is fine and stays ok):\n${v.error ?? ''}` +
                (v.outputDir ? `\n[scenario] the run's output (error context, screenshots) is kept in ${v.outputDir}` : ''),
        );
      }
    }
  } catch (err) {
    record.error = String(err?.message || err);
    console.error(`[scenario] ⚠️  scenario export failed (the take is fine and stays ok): ${record.error}`);
  } finally {
    signal.removeEventListener('abort', onAbort);
    interrupt.endWork();
  }
  await save();
  if (interrupt.signal) {
    console.error(`[scenario] stopped by ${interrupt.signal}; the take is saved and stays ok.`);
    return SIGNAL_EXIT[interrupt.signal] ?? 130;
  }
  const bad = Boolean(record.error) || !record.loadCheck?.ok || (record.verify !== null && record.verify.status !== 'passed');
  if (bad) console.error(`[scenario] exit 2: the take is ok; the scenario ${record.error ? 'was not emitted' : !record.loadCheck?.ok ? 'failed its load check' : 'failed verify'} (sidecar \`scenario\`).`);
  return bad ? 2 : 0;
}

// BACKEND SELECTION (header). Returns the backend to film with and, when `auto` fell back to Playwright,
// why (printed as one line and kept in the sidecar's `backendNote`). Every refusal exits 1, nothing filmed,
// and says exactly what to do.
async function selectBackend(requested) {
  const refuse = (msg) => {
    console.error(msg);
    process.exit(1);
  };
  let note = null;
  if (requested === 'auto' || requested === 'ego') {
    const ego = await probeEgo();
    egoBin = ego.path;
    if (ego.state === 'ready') return { backend: 'ego', note: null };
    if (requested === 'ego') {
      refuse(
        ego.state === 'missing'
          ? `--browser ego: ego-browser is not installed (${ego.detail}). ${EGO_INSTALL_HINT}, then run this again. ` +
              "Or film without it: leave out --browser ego, and filmkit films in Playwright's Chromium."
          : `--browser ego: ego-browser is installed but not answering (${ego.detail}). Open the ego lite app, wait for its window, ` +
              "then run this again. Or leave out --browser ego, and filmkit films in Playwright's Chromium.",
      );
    }
    // The probe's own detail, never a guess at it: "not answering" is a timeout, a non-zero exit (with
    // what the command said) or a spawn error, and the note used to call every one of them a 10s
    // timeout (an `ego-browser` that exited 1 at once was reported as "did not answer within 10s").
    note =
      ego.state === 'missing'
        ? 'ego-browser is not installed'
        : `ego-browser is installed but not answering (${ego.detail}; is the ego lite app open?)`;
  }
  const pw = await probePlaywright();
  if (pw.state !== 'ready') {
    const why = pw.state === 'no-package' ? 'Playwright is not installed' : pw.state === 'no-browser' ? "Playwright's Chromium is not downloaded" : `Chromium would not start (${pw.detail})`;
    refuse(
      requested === 'auto'
        ? `No browser to film with: ${note}, and ${why}. ${PLAYWRIGHT_SETUP_HINT}, then run this again.`
        : `--browser playwright: ${why}. ${PLAYWRIGHT_SETUP_HINT}, then run this again.`,
    );
  }
  if (note) {
    console.log(
      `[film-web] filming in Playwright's headless Chromium: ${note}. It starts signed out, so a page behind a login ` +
        'shows its login screen (to film signed in, use ego-browser: https://lite.ego.app/).',
    );
  }
  return { backend: 'playwright', note };
}

async function main() {
  const {
    flowArg, outDir, name, browser: requestedBrowser, force, viewport, serveRoot, doTighten, minStill, keep, noise, crf,
    captions, scenario, scenarioDir, scenarioVerify, scenarioConfig,
  } = parseArgs(process.argv.slice(2));
  const flowPath = resolve(flowArg);
  // "tip-demo.demo.mjs" → "tip-demo" (the video's base filename), unless --name overrides it.
  const flowName = name ?? basename(flowPath, extname(flowPath)).replace(/\.demo$/, '');

  if (serveRoot && !(await fileExists(serveRoot))) {
    console.error(`--serve-root ${serveRoot} does not exist`);
    process.exit(1);
  }

  const mp4Path = join(outDir, `${flowName}.mp4`);
  const jsonPath = join(outDir, `${flowName}.json`);
  const tightPath = join(outDir, `${flowName}-tight.mp4`);
  const partialPath = join(outDir, `${flowName}.partial.mp4`); // the working name
  const partialTightPath = join(outDir, `${flowName}.partial-tight.mp4`); // tighten's working name
  const srtPath = join(outDir, `${flowName}.srt`); // SUBTITLES (header): written at PLACE, no working name
  const tightSrtPath = join(outDir, `${flowName}-tight.srt`);
  try {
    // A stash left by a run killed mid-COMMIT is put back (or refuses the run) BEFORE preflight: the
    // stash hides the very take preflight protects (lib/takes.mjs, A CRASHED STASH).
    const recovered = await recoverCrashedStash({ outDir, name: flowName });
    if (recovered.state === 'restored') {
      console.error(`[film-web] an earlier run of "${flowName}" was killed while placing its take; the previous take is back: ${recovered.restored.join(', ')}`);
    }
    // `-tight.mp4` is always planned, --tighten or not: an `ok` or interrupted take replaces the whole
    // previous take, its -tight included (see PLACE), so an existing one needs --force like the rest.
    // The same goes for both subtitle files, captioned take or not (SUBTITLES).
    await preflight(flowPath, [mp4Path, jsonPath, tightPath, srtPath, tightSrtPath], force);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  // The scenario's files are derived: absent or marked is fine, unmarked refuses HERE, before anything
  // is filmed (header, SCENARIO EXPORT).
  if (scenario) {
    if (scenarioConfig && !(await fileExists(scenarioConfig))) {
      console.error(`--scenario-config ${scenarioConfig} does not exist`);
      process.exit(1);
    }
    const plan = await preflightWebScenario({ flowPath, scenarioDir });
    if (plan.refusals.length) {
      console.error(`refusing to film: the scenario could not be written.\n  ${plan.refusals.join('\n  ')}`);
      process.exit(1);
    }
    if (!plan.runner) {
      console.error(
        `[scenario] warning: neither @playwright/test nor playwright/test resolves from ${plan.planned.dir}; ` +
          'the spec will be written, and its load check will fail until one is installed there.',
      );
    }
  }

  // ffmpeg AND ffprobe are requirements, not conveniences: the length check that catches a
  // truncated video runs on every take, and a check that silently skips when its tool is missing
  // is a check that passes.
  let ffmpeg;
  let ffprobe;
  try {
    ffmpeg = await resolveTool('ffmpeg');
    ffprobe = await resolveTool('ffprobe');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  // Last, because it is the one step that takes a moment (a round trip to ego, a Chromium launch) and
  // every refusal above is instant (header, BACKEND SELECTION).
  const { backend: browser, note: backendNote } = await selectBackend(requestedBrowser);

  await mkdir(outDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const flowSha256 = await sha256(flowPath);
  const interrupt = createInterrupt(); // from here on a signal is a salvage, not a death
  const workDir = await mkdtemp(join(tmpdir(), `filmkit-${flowName}-`));
  // The ego runner's sentinel: it stops itself if this disappears (see lib/ego-runner.mjs).
  const sentinel = join(workDir, '.alive');
  await writeFile(sentinel, String(process.pid));
  // Touched every second: if this process is killed outright the runtime notices the heartbeat
  // stop and ends itself (ORPHAN_STALE_MS in lib/ego-runner.mjs). unref'd: never keeps us alive.
  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(sentinel, now, now).catch(() => {});
  }, 1000);
  heartbeat.unref();

  const run = {
    status: 'ok',
    error: null,
    errorStack: null,
    interruptedBy: null,
    video: null, // the .mp4 that exists for this run, wherever it currently sits, or null
    durationSec: null,
    meta: null, // timeline.json's contents
    capture: null, // { ackFailures, stallCheck }
    tightenResult: null,
    keepWorkDir: false,
  };
  const sigName = () => interrupt.signal ?? 'a signal';
  const interrupted = (why) => {
    run.status = 'interrupted';
    run.interruptedBy = interrupt.signal;
    run.error = `interrupted by ${sigName()}${why ? ` ${why}` : ''}`;
  };

  // ── FILMING ────────────────────────────────────────────────────────────────────────────
  let filmErr = null;
  try {
    if (interrupt.signal) throw interruptedError(); // arrived while the work directory was made
    if (browser === 'ego') await filmWithEgo({ flowPath, flowName, viewport, serveRoot, captions, workDir, interrupt });
    else await filmWithPlaywright({ flowPath, viewport, serveRoot, captions, workDir, interrupt });
  } catch (err) {
    filmErr = err;
  }
  if (filmErr) {
    if (filmErr.interrupted) {
      interrupted('while filming');
    } else {
      run.status = 'flow-failed';
      run.error = filmErr?.message ? String(filmErr.message) : String(filmErr);
      run.errorStack = filmErr?.stack ? String(filmErr.stack) : null;
    }
  }

  // ── SALVAGE / ASSEMBLE ─────────────────────────────────────────────────────────────────
  // Same code either way: the take on disk, whole or partial, becomes an .mp4 under the working
  // name. What a signal may do to it is interrupt.beginWork()'s rule (header).
  const take = await readTakeFiles(workDir, { endedAt: interrupt.at || Date.now() }).catch(() => null);
  let encoded = null;
  if (take) {
    run.meta = take.meta;
    run.capture = {
      ackFailures: take.meta.capture?.ackFailures ?? 0,
      stallCheck: null,
      rate: captureRate(take.frames, take.meta.motion),
      opening: take.meta.capture?.opening ?? null, // lib/frames.mjs, THE OPENING FRAME
    };
    const signal = interrupt.beginWork({ abortOn: 'next', graceMs: ASSEMBLE_GRACE_MS });
    try {
      encoded = await assembleTake({ ffmpeg, take, workDir, partialPath, crf, signal });
      run.video = partialPath;
    } catch (err) {
      run.keepWorkDir = true; // the frames are the only copy of the take now
      if (err?.aborted) {
        if (filmErr) run.error += '; a signal during the salvage stopped it, so no video was written';
        else interrupted('while assembling; no video was written');
      } else if (run.status === 'ok') {
        run.status = 'failed';
        run.error = `assembling the video failed: ${err?.message || err}`;
      } else {
        run.error += `; assembling what was filmed failed too: ${err?.message || err}`;
      }
    } finally {
      interrupt.endWork();
    }
  }

  if (run.video) run.durationSec = await probeDuration(ffprobe, run.video);

  // ── CHECKS: an `ok` take must earn it (header, CHECKS BEFORE A TAKE IS ok) ─────────────
  if (run.status === 'ok' && run.video) {
    const planned = run.meta.plannedDurationSec;
    const drift = Math.abs(encoded.plannedDurationSec - planned);
    const fail = (msg) => {
      run.status = 'failed';
      run.error = msg;
    };
    if (drift > 1 / 30) {
      fail(
        `the encoded video and the recorded timeline disagree by ${drift.toFixed(3)}s ` +
          `(video ${encoded.plannedDurationSec.toFixed(3)}s vs timeline ${planned.toFixed(3)}s` +
          `${encoded.nonMonotonic ? `, ${encoded.nonMonotonic} non-monotonic frame timestamp(s)` : ''}). ` +
          'Every caption range in the sidecar would point at the wrong seconds of the video.',
      );
    } else if (run.durationSec == null) {
      // ffprobe is present (preflight) and could not read the file we just wrote: a zero-byte or
      // corrupt mp4. That is a failed take, never a check that quietly did not run.
      fail('the encoded video could not be read back (ffprobe returned no duration for it); the file is empty or corrupt.');
    } else if (Math.abs(run.durationSec - planned) > DURATION_TOLERANCE_SEC) {
      fail(
        `the encoded video is ${run.durationSec.toFixed(3)}s long but the recording clock says this take is ` +
          `${planned.toFixed(3)}s (${Math.abs(run.durationSec - planned).toFixed(3)}s apart, tolerance ${DURATION_TOLERANCE_SEC}s). ` +
          'The recording is truncated or padded, and every caption range in the sidecar would point at the wrong seconds.',
      );
    } else if (run.capture.ackFailures > 0) {
      fail(
        `screencast delivery stalled: ${run.capture.ackFailures} frame acknowledgement(s) failed while recording, ` +
          'and an un-acknowledged frame stops delivery for the rest of the take. The video may be frozen from that point.',
      );
    } else if (take.meta.capture) {
      // THE STALL CHECK (header, check 4). The liveness probe decides when it ran; the SSIM of the last
      // frame against the final screenshots is the judge only when it did not, and a diagnostic
      // otherwise (it is recorded either way: it is what the probe replaced, and what it is measured
      // against).
      const cap = take.meta.capture;
      const liveness = cap.liveness ?? null;
      let match = null;
      let motion = null;
      let ssimError = cap.finalShot && cap.finalShot2 ? null : cap.finalShotError || 'no final screenshot was taken';
      if (!ssimError) {
        try {
          match = Number((await imageSimilarity(ffmpeg, join(take.framesDir, cap.lastFrame), cap.finalShot)).toFixed(4));
          motion = Number((await imageSimilarity(ffmpeg, cap.finalShot, cap.finalShot2)).toFixed(4));
        } catch (err) {
          ssimError = String(err?.message || err);
        }
      }
      const decided = liveness?.ok === true || liveness?.ok === false;
      // `unverified`: the probe could not run. The SSIM numbers are recorded, and the take is NOT failed
      // on them (THE STALL CHECK: they cannot tell a healthy dense-text ego take from a stalled one).
      run.capture.stallCheck = { method: decided ? 'liveness' : 'unverified', liveness, match, motion, margin: STALL_MARGIN, error: ssimError };
      if (liveness?.ok === false) {
        fail(
          `the screencast stopped delivering before the take ended: a one-pixel paint change made as the take ended ` +
            `produced no new frame within ${LIVENESS_TIMEOUT_MS / 1000}s. The video is frozen from the moment frames stopped arriving.`,
        );
      } else if (!decided) {
        const hint = match !== null && match < motion - STALL_MARGIN
          ? ` The last frame differs from a screenshot of the page (SSIM ${match.toFixed(4)} vs the page's own ${motion.toFixed(4)}): that happens on a stalled take and on a healthy one of a text-heavy page under ego alike, so watch the end of the video.`
          : '';
        console.error(
          `[film-web] ⚠️  the stall check could not run (the liveness probe: ${liveness?.error ?? 'no result'}); the take is kept, unverified ` +
            `(sidecar capture.stallCheck.method "unverified").${hint}`,
        );
      }
    }
    // A signal that reached us while a COMPLETED flow was being assembled let the assembly finish
    // (that is the rule); the take is whole and checked, and it is `interrupted` — not `ok`, because
    // the run was told to stop — with tighten skipped.
    if (run.status === 'ok' && interrupt.signal) {
      interrupted(`during assembly; the flow completed and the video is whole${doTighten ? ', tighten was skipped' : ''}`);
    }
  }

  // ── PLACE is decided here and done last (header, PLACE): ok and interrupted take the plain name,
  // a failure never does. Until the COMMIT below, everything stays under working names.
  let sidecarPath = jsonPath;
  const placeAtPlain = Boolean(run.video) && (run.status === 'ok' || run.status === 'interrupted');
  let tightMade = false; // tighten wrote partialTightPath

  // ── TIGHTEN ────────────────────────────────────────────────────────────────────────────
  if (doTighten && run.status === 'ok') {
    const signal = interrupt.beginWork({ abortOn: 'first' });
    try {
      // PROTECTED RANGES, HANDED OVER IN MEMORY. tighten can read them from a sidecar on disk,
      // but this run HAS them — it authored every one of these holds — and the sidecar does not
      // exist yet (it is written below, with tighten's own numbers folded into it). Passing them
      // directly also removes the ordering trap where a stale <name>.json from a previous take
      // would be the thing protecting this one's captions. `sidecar: false` makes that explicit.
      // Both backends record on the frame clock now, so the ranges are exact and need no margin.
      const protect = run.meta.timeline
        .filter((e) => e.kind === 'caption' || e.kind === 'pause')
        .map(({ start, end }) => ({ start, end }));
      // Written to a working name beside the partial video; the COMMIT places it (and only it: a
      // take with no -tight of its own replaces the previous take's too).
      const result = await tighten(run.video, {
        out: partialTightPath,
        minStill,
        keep,
        noise,
        protect,
        protectMarginSec: run.meta.clock === 'frame' ? 0 : 0.5,
        sidecar: false,
        crf,
        signal,
      });
      run.tightenResult = result;
      tightMade = !result.skipped && Boolean(result.outPath);
      const prot = result.protected;
      if (prot?.ranges?.length) {
        console.log(
          `[tighten] protected ${prot.ranges.length} range(s) from this run's timeline ` +
            `(margin ${prot.marginSec.toFixed(2)}s) — ${prot.freezesTouched} hold(s) kept longer than --keep`,
        );
      }
      if (result.skipped) {
        const why = result.skipDetail || 'no static stretches found';
        console.log(`[tighten] already tight (${why}) — kept raw only: ${run.video}`);
      } else {
        // Both lengths are the files' own (as the device cameras print them), and "removed" is their
        // difference, so the line agrees with ffprobe and adds up (tighten.mjs, THE NUMBERS OF A CUT).
        console.log(`[tighten] ${cutSummary(result).line}`);
        console.log(`Tightened demo video written: ${tightPath}`);
      }
    } catch (err) {
      if (err?.name === 'AbortError' || signal.aborted) {
        // tighten() waited for its ffmpeg to be gone and removed its own temp output before
        // rejecting: the raw take is whole and stays, and no -tight.mp4 exists.
        interrupted('during tighten; the raw take is complete, no -tight video was written');
      } else {
        console.error(`[tighten] skipped — ${err.message}`);
      }
    } finally {
      interrupt.endWork();
    }
    // A signal that landed after tighten() had already finished: both files are complete, and the
    // sidecar says so rather than pretending nothing happened.
    if (run.status === 'ok' && interrupt.signal) {
      interrupted(`after tighten finished; the take${run.tightenResult?.skipped ? '' : ' and its -tight video'} are complete`);
    }
  }

  // ── SUBTITLES (header): the caption ranges of this take's own timeline, drawn or not, and for a
  // -tight video the same ranges through tighten's cut. Written at PLACE, beside the video, under the
  // same name; a take with no video, or no caption, gets none.
  const cues = run.video ? captionCues(run.meta?.timeline) : [];
  const tightCues = tightMade && cues.length ? cuesThroughCut(cues, run.tightenResult.segments) : [];
  if (tightCues.length < (tightMade ? cues.length : 0) || tightCues.some((c) => c.clipped)) {
    console.error(
      `[film-web] the -tight subtitles lost caption time to the cut: ${cues.length - tightCues.length} dropped, ` +
        `${tightCues.filter((c) => c.clipped).length} clipped.`,
    );
  }
  const subtitles = { srt: null, tightSrt: null };
  // Never fails the take: the video and the sidecar matter more than its subtitles, and a write error
  // here would otherwise skip the sidecar. Reported, and the sidecar names only what was written.
  const writeSubtitles = async (at, tightAt) => {
    for (const [key, path, list] of [['srt', at, cues], ['tightSrt', tightAt, tightCues]]) {
      if (!path || !list.length) continue;
      try {
        if (await writeSrt(path, list)) subtitles[key] = path;
      } catch (err) {
        console.error(`[film-web] could not write the subtitles ${path}: ${err.message}`);
      }
    }
  };

  // ── A TAKE WITH NO PLAIN-NAME VIDEO GOES TO A FAILED SLOT ──────────────────────────────
  // flow-failed and failed (the video is still at its working name), and any run with no video at
  // all — an interrupt before anything was filmed included. Sidecar and video share one slot, and so
  // do the subtitles. The previous take at the plain name is not touched: nothing is stashed on this path.
  if (!placeAtPlain) {
    const slot = await claimFailedSlot(outDir, flowName);
    sidecarPath = slot.sidecarPath;
    if (run.video) {
      await rename(run.video, slot.outPath);
      run.video = slot.outPath;
      await writeSubtitles(slot.srtPath, null);
      console.error(`[film-web] take saved as ${slot.outPath} — "${flowName}" is free for the retake.`);
    }
  }

  // ── WORK DIRECTORY ─────────────────────────────────────────────────────────────────────
  // Gone once its frames are a take, whatever the take's status. Kept, and named, only when
  // assembly itself failed or was stopped: then it holds the only copy of what was filmed.
  clearInterval(heartbeat);
  if (run.keepWorkDir && take) {
    console.error(`[film-web] the work directory was kept, it holds the filmed frames: ${workDir}`);
  } else {
    // retries: an ego runtime that outlived its wrapper may still be writing into the directory
    await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  // ── DECIDED FAILURES (header): a signal that reached an already-failed take is recorded, not lost.
  if ((run.status === 'flow-failed' || run.status === 'failed') && interrupt.signal) {
    run.interruptedBy = interrupt.signal;
    const note = `${interrupt.signal} was received while this failed take was being finished`;
    run.error = run.error ? `${run.error}; ${note}` : note;
  }

  // ── SIDECAR ────────────────────────────────────────────────────────────────────────────
  const sidecar = {
    status: run.status,
    ok: run.status === 'ok',
    error: run.error,
    errorStack: run.errorStack,
    interruptedBy: run.interruptedBy,
    filmkit: filmkitCommit(), // { commit, branch } of the filmkit that filmed this, or null
    backend: browser,
    backendRequested: requestedBrowser,
    backendNote,
    flow: flowPath,
    flowSha256,
    argv: process.argv.slice(2),
    captions: captions ? 'drawn' : 'hidden', // --no-captions: every caption held, none drawn (SUBTITLES)
    viewport,
    serveRoot: serveRoot ?? dirname(flowPath), // where local files were served from (tools/scenario.mjs --from reads it)
    clock: run.meta?.clock ?? null,
    crf,
    durationSec: run.durationSec,
    plannedDurationSec: run.meta?.plannedDurationSec ?? null,
    // srt / tightSrt: filled in at PLACE with what was actually written (null: none)
    output: { path: placeAtPlain ? mp4Path : run.video, durationSec: run.durationSec, srt: null, tightSrt: null },
    partial: run.meta ? Boolean(run.meta.partial) : null,
    capture: run.capture,
    timeline: run.meta?.timeline ?? [],
    outcomes: run.meta?.outcomes ?? [],
    tighten: run.tightenResult && tightMade ? { ...run.tightenResult, outPath: tightPath } : run.tightenResult,
    workDir: run.keepWorkDir && take ? workDir : null,
    createdAt: startedAt,
  };
  if (placeAtPlain) {
    // ── COMMIT: the new take replaces the previous one as a whole. The plain names must never hold a
    // video and a sidecar (or a -tight) from two different takes, whatever kills this process: under
    // --force the previous take's mp4, -tight and json first move aside TOGETHER to a hidden stash
    // (lib/takes.mjs, the device cameras' rule), then the new video, its -tight if it made one, and
    // its sidecar land on names that are free, then the stash is deleted. A crash in between leaves
    // the plain names holding only new files (possibly without their sidecar) beside the stash, and
    // the next run's recoverCrashedStash refuses, naming both takes, until the operator picks one.
    let stash;
    try {
      stash = await stashPreviousTake({ outDir, name: flowName, force });
    } catch (err) {
      // Nothing moved (stashPreviousTake rolls back): the previous take stands, and this one cannot
      // take its place. It goes to a failed slot rather than being lost.
      run.status = 'failed';
      run.error = `the take could not replace the previous one: ${err.message}`;
      const slot = await claimFailedSlot(outDir, flowName);
      await rename(run.video, slot.outPath);
      if (tightMade) await rm(partialTightPath, { force: true });
      run.video = slot.outPath;
      sidecarPath = slot.sidecarPath;
      await writeSubtitles(slot.srtPath, null);
      await writeSidecar(sidecarPath, {
        ...sidecar, status: run.status, ok: false, error: run.error,
        output: { path: run.video, durationSec: run.durationSec, srt: subtitles.srt, tightSrt: null }, tighten: null,
      });
      console.error(`[film-web] ${run.error}\n[film-web] take saved as ${slot.outPath}.`);
      process.exit(1);
    }
    await rename(run.video, mp4Path);
    run.video = mp4Path;
    if (tightMade) await rename(partialTightPath, tightPath);
    await writeSubtitles(srtPath, tightMade ? tightSrtPath : null);
    Object.assign(sidecar.output, subtitles);
    await writeSidecar(sidecarPath, sidecar);
    const discarded = await stash.discard();
    for (const w of discarded.warnings ?? []) console.error(`[film-web] ${w}`);
  } else {
    Object.assign(sidecar.output, subtitles);
    await writeSidecar(sidecarPath, sidecar);
  }

  // ── REPORT ─────────────────────────────────────────────────────────────────────────────
  if (run.status === 'ok') {
    console.log(`\nDemo video written: ${run.video}`);
    if (run.durationSec != null) console.log(`Duration: ${run.durationSec.toFixed(2)}s`);
    for (const path of [subtitles.srt, subtitles.tightSrt]) if (path) console.log(`Subtitles written: ${path}`);
    if (!captions) console.log(`Captions: not drawn (--no-captions)${subtitles.srt ? '; they are in the subtitles' : ''}.`);
    console.log(`Sidecar written: ${sidecarPath}`);
    // CAPTURE RATE (header): a WARNING, never a failure, printed last so it sits beside the result. The take
    // is whole and its timeline matches the video; what a slow capture costs is smoothness and pacing.
    const rate = run.capture?.rate;
    if (rate?.degraded) {
      const probe = run.capture.stallCheck?.liveness?.latencyMs;
      console.error(
        `\n[film-web] ⚠️  capture was slow: ${rate.motionFps} frames per second of cursor motion against a target of ${rate.targetFps} ` +
          `(healthy takes: 19-32, warning below ${rate.warnBelowFps}). The cursor's moves took ${rate.motionSec}s for ${rate.plannedMotionSec}s planned` +
          `${Number.isFinite(probe) ? `, and the end-of-take probe answered in ${probe}ms (healthy: 4-40ms)` : ''}. Motion looks choppy and every ` +
          'action ran slow, so captions are held longer than written. The take is kept as ok (sidecar capture.rate.degraded). Film it ' +
          'again: under ego the first take after the runtime starts cold has measured like this, and the next one at full rate.',
      );
    }
    // THE OPENING FRAME (lib/frames.mjs): a warning too. The take is whole; it opens on the page loading.
    if (run.capture?.opening?.state === 'abandoned') {
      console.error(
        `\n[film-web] ⚠️  the opening was not cut: no frame arrived within ${OPENING_TIMEOUT_MS}ms after open() dressed the page, ` +
          'so the take opens on the setup before it (the blank tab, the page loading). The take is kept as ok (sidecar ' +
          'capture.opening.state "abandoned"). Film it again.',
      );
    }
    if (scenario) {
      process.exit(
        await scenarioPhase({
          flowPath, scenarioDir, serveRoot: serveRoot ?? dirname(flowPath), viewport, scenarioVerify, scenarioConfig,
          take: { path: run.video, sidecar: sidecarPath, durationSec: run.durationSec, backend: browser, outcomes: run.meta?.outcomes ?? [] },
          sidecarPath, sidecar, interrupt,
        }),
      );
    }
    process.exit(0);
  }
  console.error(`\nDemo flow "${flowName}" ${run.status === 'interrupted' ? 'interrupted' : 'failed'} (status "${run.status}").`);
  // The stack says where the flow threw, but it predates the sidecar's `error` additions (the salvage
  // note, DECIDED FAILURES' signal note), so a flow-failed take prints the stack AND whatever `error`
  // says beyond the flow's own message: the terminal must not tell less than the sidecar.
  if (run.status === 'flow-failed' && run.errorStack) {
    console.error(run.errorStack);
    const flowMessage = filmErr?.message ? String(filmErr.message) : String(filmErr); // what `error` began as
    const extra = run.error.startsWith(flowMessage) ? run.error.slice(flowMessage.length).replace(/^;\s*/, '') : run.error;
    if (extra) console.error(`(${extra})`);
  } else console.error(run.error);
  if (run.video) console.error(`Video (what was filmed): ${run.video}`);
  if (run.durationSec != null) console.error(`Duration: ${run.durationSec.toFixed(2)}s`);
  if (subtitles.srt) console.error(`Subtitles: ${subtitles.srt}`);
  console.error(`Sidecar written: ${sidecarPath}`);
  process.exit(run.status === 'interrupted' || run.interruptedBy ? (SIGNAL_EXIT[interrupt.signal] ?? 130) : 1);
}

await main();
