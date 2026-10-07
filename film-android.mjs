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
//        [--guard-app <package-id>] [--guard-allow <package-id>]... [--guard-strict]
//        [--bit-rate <n>] [--size <WxH>] [--strict-size] [--segment-seconds <n>] [--tighten]
//        [--min-still <sec>] [--keep <sec>] [--noise <auto|-60dB>] [--crf <0-51>]
//        [--trim-head <sec>] [--trim-tail <sec>] [--target-duration <sec>]
//        [--no-show-taps] [--verbose] [--scenario [--scenario-dir <dir>] [--scenario-verify]]
//
// SCENARIO EXPORT (Part 2; --scenario, --scenario-dir <dir>, --scenario-verify). Same design as film-ios
// (read its SCENARIO EXPORT paragraph; the shared code is lib/scenario/). maestro is ALWAYS given
// `-e FILMKIT_MODE=film`, so a flow can gate steps with `when: { true: ${FILMKIT_MODE != 'test'} }` (the
// pause gate the templates use, SKIPPED in the wrapper's test run). With --scenario, and only for a take
// whose final status is `ok`, the camera writes `<flow-stem>.scenario.yaml` (a wrapper that runs the ORIGINAL
// flow) next to the flow or into --scenario-dir, then `maestro check-syntax` on it. Android specifics:
//   * PREFLIGHT refuses an unmarked file at the wrapper path before the device is touched (`--force` does not
//     apply); a marked one is rewritten without --force.
//   * `--fresh` becomes a `clearState` step: Maestro's Android clearState is `pm clear`, exactly what --fresh
//     runs, so there is no gap and no keychain step (`preconditions: ["clearState"]`).
//   * NOT CARRIED (header and sidecar `scenario.notCarried`): --install and --guard-app. Flags that only shape
//     the video or the recorder (--size, --bit-rate, --tighten, --guard-strict...) are never listed.
//   * BRANCHES are read from commands-*.json before the debug dir is deleted on success (lib/scenario/
//     branches.mjs). `atSec` is WALL seconds since the recorder started (`recordingStartedAt`), the clock
//     `maestroRetries[].atSec` uses, NOT video time: head trims, static holds and stitch seams are not applied.
//   * The scenario phase starts only once the `ok` sidecar is written (`takeComplete`). It can never fail the
//     take: an emit or check-syntax failure, a red `--scenario-verify` (one run, wall-clock cap 3x the filmed
//     flow time + 60s, enforced here) and a signal all leave `status: "ok"`. Exit code 2 for the first three, the
//     signal's own code (130/129/143) for a signal, which aborts the verify run instead of salvaging.
//   * Sidecar: `branches` (always with --scenario, else only if the flow had `when:` blocks) and
//     `scenario: { wrapper, preconditions, notCarried, pauseSec: { skippedInTest, paidInTest }, warnings, checkSyntax:
//     { ok, output }, verify: null | { status, durationSec, error } }` (`error` added, `wrapper` null, if emit failed;
//     `warnings`: the wrapper's runFlow file leaves its project, see emit-maestro.mjs, printed too, exit unchanged).
//
// FLOW LINT. At preflight (before the device is touched, with or without --scenario) the flow text is checked
// by lib/maestro-lint.mjs for a wait that directly follows another wait with nothing that resets Maestro
// 2.6's wait clock in between: such a wait's timeout is counted from the START of the previous wait, so a
// pause after a pause holds ~0.4s, and a real wait after a pause loses the pause's hold from its budget.
// It only warns (stderr, `[film-android] ⚠️  flow lint (line N): ...`) and records `flowLint: [{ line, message }]`
// in the sidecar, key omitted when clean. The lib's header holds the measurements.
//
// NAMING: output defaults to `<out>/<flow>-android.mp4`. `--name <basename>` overrides the stem
// (`<out>/<basename>.mp4`, `<out>/<basename>-tight.mp4`, `<out>/<basename>.json`) so a storyboard
// can be filmed straight into its own layout — `--out demo/raw/10-fork --name take-2`. Filming is
// a repeated activity, so an existing output is NEVER overwritten unless `--force` is passed: the
// check runs in PREFLIGHT, before the device is touched, so a clobbering re-run costs no take.
//
// THE PREVIOUS TAKE UNDER --force (lib/takes.mjs has the state machine, the naming and the crash policy;
// film-ios does exactly this). Before it, a --force retake whose flow failed overwrote `<name>.mp4` with
// its own recording, markFailed moved that to `.failed.mp4`, and the previous good take was gone while
// its `<name>.json` still said `status: ok` for a file that no longer existed. Now THE PREVIOUS TAKE IS
// ONLY EVER REPLACED BY A TAKE THAT ENDS `ok` OR `interrupted` (with a video, and nothing had failed yet
// when the signal arrived: see DECIDED FAILURES). Under --force, after
// preflight AND setup have passed (device found, size probed, app installed/cleared, foreground read: a
// run that dies there has not touched the previous take, and the window in which a SIGKILL can strand a
// stash is only the recording) and still on the setup handlers, stashPreviousTake moves `<name>.mp4`,
// `-tight.mp4` and `.json` to `.<name>.prev*`. The plain names then hold only this run's output. Exits:
//   * ok            -> the `ok` sidecar, then keepNewTake() = discard the stash (the old `-tight` goes with
//                      it, even when this run's tighten found nothing to cut). Also in onInterrupt's
//                      takeComplete branch (a signal during that write or the scenario phase),
//                      synchronously, since a second signal there exits at once.
//   * interrupted   -> harvest produced a video, no failure was decided before the signal, and the
//                      `interrupted` sidecar is written: discard. A harvest that failed (no usable segment, a
//                      stitch that threw) went through failTake: restore. A failure decided BEFORE the signal
//                      is set aside as that failure (failTake, next bullet): restore.
//   * every failure -> failTake(), ONE promise: markFailed (video and `-tight` to `.failed-N`), the sidecar at
//                      the `.failed` name, THEN restorePrevious(): the plain names are free again. That is
//                      harvest failing, taps-missing, flow-failed (the flow's own failure, the startup retry
//                      giving up, --guard-strict stopping it), interloper, truncated (lost segments, a chain
//                      abort), failed (aspect, letterbox, crop not applied, --strict-size) and error (below).
//   * setup signal  -> the setup handler restores before exiting (nothing was filmed).
//   * an interrupt that races a failure exit already under way is that failure, not an interrupted take: it
//     waits for the whole failTake (failTakePromise), bounded by FAIL_EXIT_WAIT_MS (10s: a normal step-aside
//     takes well under a second, and the fingerprint's `adb getprop` in the sidecar write has no timeout of
//     its own), then exits with the signal's code. So the failed take keeps its sidecar and the previous take
//     comes back. Measured before: SIGINT inside markFailed's rename exited 130 with `.failed-6.mp4` and no
//     `.failed-6.json`. A main-path failure exit that would START after the interrupt began is not started
//     (the handler owns the run from then on, and sets the take aside itself if its failure was decided).
//
// DECIDED FAILURES. A take can fail well before its failure exit runs, and a signal in between used to turn it
// into `interrupted`: the flow failed, harvest finished, the burn was running, SIGHUP arrived, the handler
// aborted the burn, wrote `interrupted` at the plain name and, under --force, DISCARDED the previous good take
// for a failed, ringless partial. The same for a truncated/interloper/geometry verdict with the signal landing
// during tighten. Now every verdict is recorded the moment it is computed, and only while no signal has
// arrived (`decided`): the flow's own failure when the retry loop ends, harvest's truncation, interloper and
// geometry verdicts before its cleanup, taps-missing after the burn, the crop's after the post-burn probe.
// decidedFailure() turns them into `{ status, error }` in main's exit order (taps-missing, then interloper or
// flow-failed for a failed flow, then interloper, truncated, failed), and both main's exits and the handler
// read it. The handler, once harvest and any burn or tighten have settled, sets a decided failure aside with
// failTake: `.failed-N`, the real status and error, `interruptedBy` = the signal, the error ending in "<SIG>
// was received while this failed take was being finished", the previous take restored, exit = the signal's.
// film-web keeps a flow error that predates a signal the same way. A verdict computed AFTER the signal (a
// harvest the handler itself ran, a flow a signal stopped) does not count: then the signal ended the take and
// it is `interrupted`, as before.
//
// NOTHING FILMED. A signal that arrives before any flow command started (the warmup, the maestro JVM
// starting, a startup retry's backoff; judged by lib/tap-overlay.mjs maestroCommandRan on maestro.log as it
// stands at the signal) is treated like a setup-phase signal: the recorder is stopped, this run's segments
// (device) and debug spill are removed, there is no take and no sidecar, the previous take is restored, and
// the exit code is the signal's. Measured before: a signal right as recording started wrote `.failed-N.json`
// (status failed) naming a `.failed-N.mp4` that did not exist (seg001 0.00s, the pull failed), and the log
// and `keptFiles` called the segment "still on the device" when it was not. Once a command has run, a take
// whose harvest saves nothing is still a failed take with its sidecar (the evidence of a run that did
// something), but that sidecar now says `output.path: null`, and a device file is only reported (log and
// `keptFiles.device`) if it is really there.
//
// KEPT EVIDENCE IS PER RUN. Everything a run may leave for a human to look at carries `<run>`, its UTC start
// (20260929-191530): local segment copies `.<name>.<run>.segNNN.mp4`, device segments
// `/sdcard/filmkit-<name>-<run>-segNNN.mp4`, the debug spill `.<name>.<run>.maestro-debug` and the failed
// startup attempts `.<name>.<run>.maestro-attempts`. Measured before: an interrupted take's kept
// `.a1.seg001.mp4` was gone after the next --force run of the same name (which pulled its own seg001 to
// the same path, then deleted it as its own clean-up). By the same construction the next run's start
// deleted a failed run's debug spill and attempts (its `.failed.json` then named a `debugOutput` that no
// longer existed) and swept the device copies as "stale segments". Nothing here deletes another run's
// files now; a clean run removes only its own.
// DEVICE COPIES are not evidence twice over: once a segment is pulled and its local copy has the device
// file's size, the device copy is removed on EVERY path (harvest, right after the pull), and the local copy
// is what an unclean run keeps and names. Only a segment that could not be pulled (or whose sizes disagree)
// stays on the device, named in the log (with why: not pulled, sizes differ, or a size the device would not
// report) and in `keptFiles.device`, until removed by hand. Measured before: device copies were removed only
// on a clean run and only dropped segments were reported, so an interrupted take left its pulled seg001 on
// /sdcard with `keptFiles.device: []` and no log line. An EMPTY file matches too when both sides say 0 bytes
// (a recorder that hung before its first write; the size is stat's own digits, since `Number('')` is also 0):
// measured before, a pulled 0-byte seg010 stayed on /sdcard and was reported as "not pulled".
// A stash that cannot be made rolls itself back and exits 1 before recording. A restore never overwrites:
// if a plain name is occupied (markFailed could not move the failed video, 999 slots) nothing is moved
// back, the stash stays, the message names it, and the next run's recoverCrashedStash refuses until the
// operator chooses. Without --force nothing is stashed. A stash from a killed run is put back (or refuses
// the run) before preflight, so the refusal to overwrite an existing take cannot be walked around by a
// hidden one.
//
// UNPLANNED ERRORS (film-ios's `error` exit). A throw nobody planned for that escapes main() (the retry
// loop's own log handling, say) used to end the process on Node's default: stack trace, exit 1, the
// on-device recorder still rolling for up to its 170s limit, and under --force the stash stranded until the
// next run. main() now registers onUnplannedError, and the entry point routes a rejection through it:
//   * after the stash, before the chain starts: put the previous take back, exit 1 (nothing was filmed);
//   * once the chain runs: stop the maestro child, harvest (stop the chain, pull, stitch: whatever was filmed
//     is salvaged), failTake with `status: "error"` (sidecar `error` is the thrown message), restore, exit 1.
//     If the harvest itself fails, that failure's own `failed` exit is the one recorded;
//   * a signal already being handled owns the exit (it is not raced), and a take already final (`ok`
//     written, stash discarded) is left as it is, exit 1.
// NOT COVERED: an exception thrown from an event callback rather than main()'s own awaited path (a stream
// or timer handler): that is an uncaughtException and still ends the process on Node's default, the same
// as film-ios. So does SIGKILL (see A CRASHED STASH in lib/takes.mjs).
//
// SIZE (FEEDBACK #22): `screenrecord` records at the device's native resolution by default, but
// the emulator's software AVC encoder (c2.android.avc.encoder) cannot be configured that large on a
// tall AVD. Measured on a 1344x2992 Pixel 10 Pro XL AVD (Android 17), probing `screenrecord --size
// WxH --time-limit 1`: the limit is a CAP OF 2560 ON THE HEIGHT, not on the area (1344x2560 and
// 1344x2200 -- 2.96 Mpx -- are accepted; 1152x2564 and 1344x2562 are refused; odd dimensions are
// refused too). What screenrecord DOES about a refusal depends on whether `--size` was passed:
//   - no `--size`: prints "unable to configure video/avc codec at 1344x2992 (err=-22)" and
//     "failed at ..., retrying at 720x1280", exits 0, and SILENTLY falls back to 720x1280 -- the
//     screen then sits pillarboxed at 574x1280 inside it, a changed aspect, not just fewer pixels.
//   - explicit `--size`: the same ERROR line, exit 234, in ~0.1s, NO fallback, no file. Loud.
// The encoder's advertised range (`dumpsys media.player`: size-range 16x16-2048x2048) is wrong on
// both counts, so nothing is read from capabilities: the encoder is PROBED.
//
// ACCEPTED DOES NOT MEAN THE PICTURE FILLS THE FRAME, AND THE ANSWER IS TO CROP, NOT TO SHRINK.
// A size the encoder takes can come out with a 1-2px black bar. screenrecord letterboxes the display
// into the video with FLOAT arithmetic (`displayAspect = (float)H/W`; if the video is taller than
// trunc(videoW*aspect) the content is (videoW, trunc(videoW*aspect)), else (trunc(videoH/aspect),
// videoH)), and the content rectangle it then prints as "Content area is WxH at offset x=X y=Y"
// equals the video only when the video's w/h equals the display's to within float rounding -- i.e.
// exactly. Measured, each an accepted size: 1144x2546 -> content 1143x2546 (a black rightmost
// column, x=1143, mean luma 0 against 242 beside it), 1080x2404 -> 1079x2404, 1150x2560 ->
// 1149x2560, 1148x2556 -> 1148x2555, 1136x2530 -> 1136x2528 at y=1, 1008x2244 (an EXACT 84:187
// multiple of 1344x2992) -> 1007x2244, 840x1870 -> 839x1870. Only 672x1496 (half native) and 336x748
// filled, which the same float model predicts (it reproduced all fifteen sizes probed).
// THE DECISION, and why: requiring an exact fill costs HALF THE RESOLUTION on a tall AVD (672x1496
// against 1144x2546, a quarter of the pixels), which is a worse defect than the bar. So the walk takes
// the LARGEST size the encoder accepts, and the bar, which by construction is only ever 1-2px, is
// trimmed in post: planCrop reads the reported content area and plans the largest even-dimension
// rectangle inside it, at an even offset (chroma is subsampled 2x2; an odd origin would shift the
// colour planes against the luma). 1143x2546 in 1144x2546 becomes a 1142x2546 crop at (0,0); 1136x2528
// at (0,1) becomes 1136x2526 at (0,2). More than CROP_TOLERANCE_PX (2) short on an axis is a REAL
// letterbox (a pillarboxed fallback is 25%), and is refused exactly as before.
// THE CROP COSTS NO EXTRA ENCODE: it rides in the tap burn's filter graph (lib/tap-overlay.mjs,
// burnTapRipples `crop`), the one re-encode every device take with rings already gets. Tap
// coordinates stay in the recorded frame's pixels and the burn shifts them by the crop origin. A take
// with no rings to draw (`--no-show-taps`, or a flow that never taps) gets the same pass with zero
// rings (finishingEncode), so the crop has the same encoder and quality policy. tighten's freeze
// detection still runs on the UNCROPPED pre-finish file (frame-exact, unlike the re-encode), and the
// cropped delivered take differs from it in frame size by exactly the crop: `detectFromCrop` on
// tighten() declares that, so its guard holds the pair to it instead of refusing (see tighten.mjs).
// The crop is recorded as `recording.crop` ({ w, h, x, y, contentArea, reason, applied }) or null,
// and a planned crop that did not run, or a delivered size that is not the crop, fails the take.
// A take that leaves without its finishing encode (a signal, an unplanned error) is cropped by STREAM COPY
// instead (SALVAGE CROP, streamCopyCrop: the SPS's own display crop is rewritten, lossless, measured
// framemd5-identical to a decode-and-crop), so an interrupted take is not delivered with the bar; `crop.method`
// says which ('encode' | 'stream-copy'), and `crop.error` why a salvage crop could not be applied.
// In the DEVICE phase, before anything is installed, cleared or filmed:
//   * `--size` absent: probe the native size (the display in its CURRENT orientation: rotation is
//     read off the window manager and corrected by the recorder's own "Display is WxH" line, so a
//     landscape device is walked in landscape), with the recorder's own --bit-rate. Accepted and
//     within the crop tolerance -> record at native, no --size passed. Otherwise walk aspectLadder
//     (the long side shrinks 2% per rung, the other side follows the aspect, both even): a binary
//     search finds the first size the encoder accepts (the cap makes acceptance monotonic; a refusal
//     costs ~0.1s, an accepted probe ~1.3s), then at most SIZE_CROP_WALK_MAX rungs are probed in order
//     for the first whose content area is croppable (nearly always the first). That bounds a walk at
//     ~10-15 probes however long the ladder. On the tall AVD it lands on 1144x2546, cropped to
//     1142x2546. The choice, the crop and every probe (with its reported content area) go in
//     `recording.sizeProbe` / `recording.pinnedSize` / `recording.crop`.
//   * `--size` given: malformed is refused as malformed; an aspect that differs from the device's by
//     more than 1% is refused at once (screenrecord would letterbox it); otherwise the size is probed.
//     One the encoder accepts and that needs at most the crop is ACCEPTED, with a log line saying it
//     will be cropped to WxH. One that is refused, or accepted but really letterboxed, aborts BEFORE
//     the flow runs, naming the largest usable size the probe found below it.
//   * UNANSWERED PROBES. A probe is INCONCLUSIVE when adb or the recorder failed for a reason that says
//     nothing about the size (no codec refusal, yet no clean exit: probeRecorderSize). It used to warn and
//     film anyway, at native when no --size was given, and that was wrong exactly when it mattered: measured,
//     a walk on the tall AVD had native REFUSED, then 1144x2546 came back `exit 235 ... Stopping encoder and
//     muxer` (transient: a probe 20s later answered), the take rolled at native, screenrecord fell back to
//     720x1280 and the take failed as letterboxed after the whole flow. Reproduced on demand by deleting the
//     probe's file on the device while it records (exit 233, the same last line), and by a second run's walk
//     on the same device while the probe file had one fixed name (2 of 2 staggered pairs; see PROBE FILES). Now the SIZE_PROBE state
//     per size is: ATTEMPT n -> accepted | refused (a verdict, done) | inconclusive -> n < SIZE_PROBE_ATTEMPTS
//     (3): PAUSE SIZE_PROBE_RETRY_PAUSE_MS (2s, see the constant for the measurement) -> ATTEMPT n+1; else
//     UNANSWERED. Any unanswered size STOPS the run in the DEVICE phase ("the recorder's size probe isn't
//     answering ... rerun"; exit 1, nothing filmed, no take, no sidecar), whichever size it was: native, a
//     rung of the walk, or an explicit --size (which used to film unverified too). The one exception is the
//     search for a smaller size to SUGGEST after an explicit --size was refused: the refusal is already the
//     verdict, so an unanswered rung there only shortens the message. So native is recorded (`pinned` null)
//     only when native's own probe said it is usable. Every attempt is a `recording.sizeProbe.probes` row
//     with its `attempt` number (`retries` counts the repeats), each retry is a console line, and the walk
//     prints its whole trail (`size probes: ...`). Not covered: an inconclusive answer that is really a
//     lasting fault; it costs up to ~64s (adb hanging every time) before the stop.
//   * PROBE FILES. The probe records to `/sdcard/filmkit-size-probe-<run>-<pid>.mp4` (the run's UTC tag, as in
//     KEPT EVIDENCE IS PER RUN, and this process's pid) and removes it after every probe. It used to be one
//     fixed `/sdcard/filmkit-size-probe.mp4`, so a second run on the same device (agents share devices) removing
//     ITS probe file deleted ours mid-recording: the one cause of an inconclusive probe reproduced above. At the
//     DEVICE phase, before probing, sweepStaleProbeFiles removes what killed runs left: a per-run file whose
//     pid is dead here, by tighten's STALE TEMPS rule (isDeadRunPid; never a live pid's file, never this
//     run's), and the legacy fixed name unless a recorder on the device is writing it right now.
//   * After the fact, two checks that ALWAYS fail the take (status `failed`), whether or not
//     `--strict-size` was passed: the finished file's ASPECT differs from the device's (the fallback
//     above), and any segment's content area is more than the crop tolerance short of its own video
//     ("screenrecord letterboxed the picture: content 574x1280 at (73,0) in a 720x1280 video").
//     `--verbose` is asked for on every run, tap indicators or not, because the content area comes
//     from it. `--strict-size` keeps its old, narrower meaning: a size that is the right shape but
//     not exactly the size asked for (the size actually pinned, else native) fails only under it.
//     `recording.sizeCheck` records the verdicts, `contentFits` being fill | crop | letterbox.
// The recorder's stderr is still captured and echoed (`[screenrecord]`) and the geometry is still
// checked on the finished file: the probe removes the surprise, it does not replace the net. There
// is no per-device cache of the answer: a probe walk costs ~4s, and a cache would have to be
// invalidated by every emulator image, GPU mode and density change that can move the encoder's limit.
//
// CAP / SEGMENT CHAIN: `adb shell screenrecord` hard-stops at 180s, so no single recording can
// span a longer flow. This tool therefore records a CHAIN of segments: each one runs with
// `--time-limit <segment-seconds>` (default 170, hard-capped at 180) writing to its own
// /sdcard/<base>-segNNN.mp4, and the moment a segment's process exits the next one is spawned.
// The flow is filmed end to end; the price is a SEAM at every segment boundary, and it has two parts,
// measured on filmkit_tall (1144x2546, software AVC encoder) with a running stopwatch in 8s segments:
//   * the HANDOVER, one recorder's stop to the next one's first frame: 0.35-0.59s at steady state,
//     1.57-1.81s while maestro's JVM was starting and loading the host. The stitched timeline DROPS this
//     (the slot is min(wall, limit) and the wall is the longer), so the clock on screen jumps across it.
//     (An earlier measurement here said ~0.3s on a smaller AVD.) The durations line reports the total
//     as `seamSec`, from each segment's anchor (see DURATION HONESTY at accountDurations).
//   * the UNWRITTEN TAIL: a time-limited segment's footage ends 0.7-1.1s before its limit does (content
//     end 6.86-7.30s of 8s, the screen changing every frame), the frames the encoder still held when the
//     recorder hit its limit. The slot keeps its full length, so this shows as the segment's last frame
//     HELD, then the handover's jump: a running stopwatch froze 1.15s and then jumped 0.45s.
// Nothing on screen during either is filmed. Seams land every `--segment-seconds`, deterministically,
// so a shot that must not be cut can be kept inside one segment by construction. The last segment used to
// lose its unwritten tail at the stop the same way (1.47s of a 1.55s final segment in the same run): the
// TAIL HOLD below now keeps the recorder rolling until the encoder has written it. A run with no pinned end
// (a signal or an unplanned error ended it mid-flow) that fits in one segment takes the single-file path
// below: a stream-copy remux, every packet byte-identical to the pulled file, its last packet's duration capped
// at the recorder's end when the container overran it (RECORDING-END CAP, below); a pinned end always goes
// through the concat, which is what applies the cut.
//
// TAIL HOLD (the final beat was not on film). screenrecord never drains its encoder: SIGINT and its own
// --time-limit both stop it with whatever it still holds discarded. On the tall AVD's software encoder
// (c2.android.avc.encoder, in the `media.swcodec` process) that is a queue of ~19 frames, so the loss is the
// queue's depth over the encoder's throughput, NOT a fixed time. Measured, the screen changing every frame,
// the recorder stopped by SIGINT: a stopwatch (a small region) 0.92-1.37s with nothing else running (15 runs,
// independent of a 2-40s recording length, ~17 fps) and 1.54-2.23s with maestro running (9 takes, ~7.5 fps);
// full-screen motion 1.2s at 3s growing to a ceiling of 4.2-4.3s idle (~4.5 fps), and 6.05-7.54s with maestro
// running (4 takes, ~2.9 fps). Before this, every take's stop came at maestro's exit, so the flow's last
// 1-7.5s were lost whenever the screen was still moving.
// A fixed hold sized for that worst case would cost every take ~9s, so the hold WATCHES the encoder. Once
// maestro has exited by itself (green, failed, or stopped by --guard-strict) and a recorder is live, the
// TAIL_HOLD state streams the codec process's utime+stime (`/proc/<media.swcodec>/stat`, one adb shell,
// ~100ms per sample) and ends the hold:
//   * `drained`: TAIL_HOLD_IDLE_SAMPLES (3) consecutive samples without a CPU tick, spanning >= 250ms. A
//     codec that is not working has nothing queued, so everything composed so far is written. Measured:
//     saturated encoding never produced one tick-less sample (200 samples, maestro running); one isolated
//     tick-less sample was seen once under load, hence three. Measured holds on flows that end on a still
//     screen: 0.50-2.78s (11 takes).
//   * `cap`: TAIL_HOLD_CAP_MS (10s) reached. A screen still moving at the flow's end never lets the codec
//     idle; the cap clears the 7.54s worst case (measured with the hold: frames 4.95-6.39s past the flow's end
//     reached the file in all 3 full-motion takes, the stopwatch 8.95s).
//   * `fixed`: the encoder could not be confirmed watchable (`dumpsys media.resource_manager` must name the
//     screenrecord pid's encoder as an AOSP software codec, c2.android.* or OMX.google.*, and media.swcodec
//     must exist): a fixed TAIL_HOLD_FALLBACK_MS (2s). NOT measured: no hardware encoder was available. A
//     hardware encoder keeping up with the display drains the same queue in a fraction of a second.
//   * `rollover`: the segment that was recording at the flow's end reached its own --time-limit during the
//     hold. Its queue is gone (a limit stop discards it too), and the next segment's codec instance starts
//     idle, so watching on would read "drained" off a codec that never held the flow's last frames (measured
//     before this: `covered: true` on a take whose flow segment had been cut 1.04s into the hold). Ends the hold.
//   * `interrupted` (a signal: the handler owns the run and still pins the take), `recorder-gone` (the chain
//     aborted), `watch-lost` (the monitor died: the fallback time applies).
// RECORDER DEATH AFTER THE FLOW. A recorder that dies on its own at or after the flow's end (`recorder-gone`, or
// between maestro's exit and the hold) cut nothing off the flow, so it is NOT a truncation: main marks the flow's
// end on the chain (markFlowEnded) and `abortCutFlow` compares it with the dying recorder's end, judged when read,
// so the order in which the two events were processed cannot matter. The take is then judged on what was WRITTEN
// up to the flow's end, like any other: a recorder that stopped cleanly on the device keeps its file and the take
// is `ok` (`covered` null and a warning unless it wrote a frame past the flow's end: a dying recorder discards its
// encoder's queue like a limit stop); a SIGKILLed one leaves no moov atom, so the segment that was recording at
// the flow's end is LOST, the take is `truncated` by that loss alone, `covered` is false and `flowSegmentLost`
// names it, and a single-segment take has nothing usable and fails. Before, every such take was `truncated` with
// "the rest of the flow is NOT on camera" (measured: an on-device SIGINT 0.35s into the hold of a segmented take
// whose flow was whole). Evidence follows the take: a death after the flow does not make the run unclean, so an
// `ok` take deletes its segments as always (their footage is in it, and the death's exit and stdout are in
// `recording.segments`); a lost segment keeps them. A death BEFORE the flow's end is a truncation as before.
// Not reproducible from outside: the recorder a rollover spawns is stopped by us 0.02s later (measured twice),
// before a device-side kill can land; the same rule covers it (it started after the take's end).
// HOW A DEATH IS SAID. Live, the chain prints only the fact, in recorderEnding's words ("seg006 ended unexpectedly:
// the recorder was killed on the device by SIGKILL (exit 137) after 3.73s (limit 10s) — the chain stops here"),
// because whether it cut the flow depends on the flow's end (main may mark it a moment later) and what it cost
// depends on whether its file survived. Harvest then judges it ONCE, with both known: mid-flow ("...; the rest of
// the flow is NOT on camera"), after the flow with a usable file ("not a truncation"), after the flow with the file
// lost ("the death cut nothing off the flow, but it left no usable file ... the take is truncated by that loss", or
// "there is no take" when it was the only footage). Measured before: a SIGKILL in the hold printed "nothing the
// take owed was still to come" twice, the second time "— not a truncation", and the take was then `truncated`
// (segmented) or `failed` (one segment, whose sidecar also said `recording.truncated: true`). `recording.truncated`
// now describes the delivered video: false when there is none (`output.path` null), the error saying why.
// The take's own reason (sidecar `error`, the last line) says the same as the mid-flow case: a lost file after the
// flow carries the death (`abortSegLost`: "..., 0.46s after the flow had ended (in the tail hold)"), and the loss
// says which way the file failed ("was pulled but has no readable container (no moov atom)", "could not be pulled
// (there was no file on the device)") and splits what it filmed at the flow's end: "6.96s of the flow is missing
// from the take, and the 0.46s of tail hold it filmed after it (never owed to the take)" (lostSegmentsReason).
// With no take at all the run still ends on a status line ("there is NO TAKE — ..."), names the kept maestro debug
// dir, and records `tapsExpected` (read in harvest's failure exit). Measured before: "seg005 could not be pulled
// or held no video — the 7.42s it filmed is missing", with neither the SIGKILL nor the hold in the `error`; and a
// single-segment loss printed "so the take ends before it" of a take that did not exist, no last line, no debug
// dir, `tapsExpected: false` for a flow that tapped twice.
// WHERE THE TAKE ENDS (planTakeEnd). The hold is not footage of the flow, so the take is CUT at E = the flow's
// end (maestro's exit): the final segment gets a concat `outpoint` there and its last kept frame is held to E
// (`setts`, the lost-successor trick; screenrecord writes no B-frames, Constrained Baseline). E moves later in
// one case only: frames written after the flow's end but BEFORE the codec was first seen idle can be LATE
// compositions of what the flow left on screen. A saturated encoder starves SurfaceFlinger's compositions:
// measured, a Home transition that took ~0.4s on screen carried capture times 0.3-2.8s after the key press,
// and a take's last frame before the flow's end came up to 1.71s early. So E = one nominal frame past the last
// frame written before that first idle moment, if that is later. Once the codec has idled its queue was empty,
// and later frames are changes made after the flow (measured: a status-bar signal icon 2.0s after it, which an
// earlier version kept). Segments whose video zero is at or after E filmed only the hold: left out, and not
// lost footage even if unusable. Recorded as `recording.tailHold`: { watch, encoder, note, endedBy, holdSec,
// capSec, samples, backlogSec, flowEndSec, takeEndSec, heldSec, cutFrames, afterTakeSegments,
// lastFrameVsFlowEndSec, covered, unwrittenSec }. `covered` says whether the encoder is KNOWN to have written
// everything up to the flow's end: true when it drained or the flow's segment wrote a frame past that end, false
// when it was still busy at the cap and wrote none (frames lost; a warning, `unwrittenSec`) or when the segment
// recording at the flow's end was lost (`flowSegmentLost`; then `flowEndSec` is null, a wall instant with no video
// time, and `takeEndSec` is where the file really ends), null when unknowable (a fixed or interrupted hold, a
// rollover, a recorder that died in the hold: a still screen looks the same). The take's status is
// never changed by it. TIGHTEN needs nothing special: the pinned end is a hold of the last frame like any other
// still, measured clamped to --keep (a 12.2s trailing still kept 0.6s) in exact mode from the pre-burn file.
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
// segment by the segment's own capture length and hold its last frame to the end of its slot. What a
// segment's wall has beyond its slot (the handover, see CAP above) is not in the timeline. Verified:
// seam offsets land exactly where the directive puts them (a 220.9s two-segment run stitched to
// 220.1s; five 20s segments of 100.6s wall time stitched to 99.3s; ten 8s segments of 88.98s wall
// stitched to 80.13s, the handovers that walls ran past their 8s limit by 0.33-1.56s).
// Stream copy is otherwise correct — every segment comes from the same screenrecord
// configuration, so SPS/PPS/profile match and the stitched file decodes clean end to end; a
// re-encode fallback exists only for the case where copy actually fails.
// The stitch is then CHECKED rather than assumed, because ffmpeg's failure mode here is a
// warning, not an exit code: "Non-monotonic DTS in output stream" scrambles the timeline and
// still exits 0. So the concat's stderr is captured and scanned for that string, and the
// finished file's duration is compared against the timeline the directives planned — a window,
// because the last segment plays out to its own (over-declaring) container end rather than to a
// directive: the sum of every `duration` line plus the tail's content end at the low end, plus
// the tail's container duration at the high end (a PINNED final segment, see TAIL HOLD, has an exact
// slot, so its window is a single number; a static one keeps STATIC_TAIL_FRAME_SEC of slack). Landing
// more than STITCH_DRIFT_TOLERANCE_SEC
// outside that window means the demuxer did not lay the segments down where they were placed —
// both conditions print a loud warning and land in the sidecar's `stitch` block.
//
// STATIC SEGMENTS (FEEDBACK #23, and why "no moov atom" was the wrong diagnosis). A recorder that
// watches a screen that never changes writes ONE frame -- its opening keyframe -- and a track
// whose only sample has zero duration. The file is readable (ffprobe parses the h264 stream and
// size; the moov atom is there) with exactly one packet and `Duration: N/A`. Measured, all giving
// the identical file for the same picture: a recorder that ran its whole 170s / 20s / 10s limit and
// exited 0 ("Encoder stopping; recorded 1 frames in N seconds"), and one SIGINT-ed 0.3s, 2s or 12s
// in. A SIGKILLed recorder is the opposite: `moov atom not found`, unreadable. A generation-wait
// shot is exactly this, so a static segment is FOOTAGE and is held, never dropped: it is usable,
// flagged `static`, its own frame is the picture for its whole slot (better than copying the
// previous segment's last frame -- that fails for a FIRST segment, and on a real take the two
// pictures differed across the seam), and the run says `static segment held` and records it in
// `recording.staticSegments` with status still `ok`. What separates it from a crash is how the
// recorder ended (see classifyStaticSegment): exit 0 after its full limit, or our own SIGINT.
// One packet from anything else is lost, with a reason that says which. Slots: a non-final one is
// `min(wall, limit)` behind a `duration` directive like any other. A FINAL one needs a trick,
// measured: the concat demuxer ignores `duration` on the LAST file when muxing mp4, so a 1-frame
// file last in the list lasts 0.07s regardless; listing the same file twice (first with the hold,
// second bare) makes the hold real, and assessStitch's window carries STATIC_TAIL_FRAME_SEC for it.
// Re-stitching a real 4-segment take (one 170s static middle segment, from an earlier filming session) this way gave 655.72s (wall 658.89s: the 3.2s
// difference is the per-segment over-limit wall and the tail's finalize), the seg003 picture held
// from 340s to the payoff frame at 647.17s, exactly where seg004 puts it.
// RECORDING-END CAP: A TAKE WITH NO PINNED END ENDS WHERE ITS RECORDER DID. A take whose end is not pinned (a signal,
// a dead chain, an unplanned error: no TAIL HOLD) used to play its final segment to the CONTAINER end, i.e. to the
// muxer's made-up last-frame duration. Measured: SIGINT after 25.32s of recording, the last frame at 25.23s given
// 0.884s, the take 26.11s long, 0.79s of a held frame that never happened. Now planStitch caps the final segment
// at its recorder's end in its own video time (recordingEndInVideoSec: spawn + wall - video zero), with the same
// `setts` pass the lost successor uses, stream copy: only the last packet's duration changes (measured on that
// take: 140 packets byte-identical, the last one's duration 0.884s -> 0.037s, the file 25.263s = the recorder's
// end). A single segment stays on the plain remux with the `setts` (the concat demuxer would put SPS/PPS in-band,
// +34 bytes per keyframe). Applies to an ordinary final segment whose container runs past that end (one that ends
// short of it, frames the recorder never wrote, is untouched), a static final segment (held to that end, its
// second listing's frame 1ms instead of 0.07s: measured 6.03s -> 5.70s on a 1-frame file SIGINTed 6s after a
// 0.3s start), and a final segment whose successor was lost (its slot is min(wall, limit, that end)). Never cut:
// a frame the video-zero estimate puts after the recorder's end keeps 1ms (`durations.overhangSec`). A PINNED end
// (every `ok` take) never reaches this code: measured, a five-segment pinned stitch is byte-identical to before.
// A LOST SUCCESSOR DOES NOT SHRINK THE SEGMENT BEFORE IT. A segment that had a successor which
// started (every segment but the last one spawned) ran as a non-final segment of the chain, so it
// owns min(wall, limit) of the timeline whether or not that successor survived to be stitched. It
// used to matter: when the trailing segment was dropped, the one before became last in the concat
// list, the demuxer ignored its `duration` (it ignores it on any last file), and the segment played
// only to its container end: 20s of wall became 5.96s, and a 158s generation wait became a few
// seconds. The same happened when the empty tail of an ordinary run was dropped. Now the list stays
// bare (no directive can work there) and the slot is restored by setting the duration of the
// segment's final packet in the same stream-copy pass (`-bsf:v setts`, see stitchSegments), so the
// take keeps real wall timing up to the loss. The take is still `truncated` when footage is
// missing; only the timing before the gap is now honest. Measured: 13.26s of content in a 20s slot
// stitches to exactly 20.000s, and to 40.000s behind a 20s static segment. The new duration is set
// HOWEVER SHORT the extension: it also replaces the muxer's fabricated last duration. Measured before, with
// a 0.05s floor: a 10s segment whose content ended 0.033s short of its slot kept its fabricated 2.816s, and
// the take stitched to 92.90s against a planned 90.12s.
// TESTING ADVICE: a static screen is harder to get than it looks. On an emulator with Wi-Fi ON, an
// idle Settings or Home screen still emits a burst of identical frames every ~10s (network
// validation commits new buffers with unchanged pixels), so a "still" shot records dozens of
// packets. `svc wifi disable` made 25s of Home record exactly 1 frame. And Maestro's own teardown
// repaints the screen, so a live flow's FINAL segment is rarely a single frame; the final-segment
// case was verified offline against real 1-frame files (see planStitch, which is exported).
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
//   topResumedActivity=ActivityRecord{69542266 u0 com.example.app/.MainActivity t104}
// (leading indentation varies with the display nesting, so the regex anchors on the key, not the
// column). Every CHANGE is timestamped relative to the recorder starting and lands in the
// sidecar's `foreground` array, so a take's occupancy history survives the run.
// What counts as an interloper is deliberately narrow, because `topResumedActivity` tracks
// ACTIVITIES, and most of the system chrome that legitimately covers an app under film is made
// of WINDOWS, not activities. Measured on this emulator: opening the notification shade leaves
// `topResumedActivity=com.example.app/.MainActivity` untouched and only moves `mCurrentFocus` to
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
// LAUNCHER BEFORE THE APP. One exception to "the launcher is the failure": before the guarded app has
// been in front even once in this take, the home activity is `home-before-app` (allowed, logged, in
// `foreground`), not an interloper. The app cannot have been backgrounded before it was ever foregrounded,
// and that is exactly the state `--fresh` leaves (`pm clear` stops the app and the launcher comes up):
// measured, `--fresh --app <pkg>` failed every take of a flow that starts with `launchApp` as an
// interloper at 0.03-0.04s, though the preflight itself says `launchApp` fixes it. The same for a take
// rolled from the home screen. The home package is resolved on the device (`cmd package resolve-activity
// -c android.intent.category.HOME`), never named here, and recorded as `guard.home`; unresolvable means
// no exception. From the app's first sighting on, the launcher is an interloper as before.
// THE APP'S OWN RELAUNCH. Maestro's `launchApp` stops the app first, and when the app is already in front
// whatever is underneath surfaces until it is back: a take flagged INTERLOPER at 9.48s with Settings back at
// 11.12s, and reproduced here at 13.97s with the CLOCK app (the task under Settings), not the launcher.
// Measured with ~11ms polling: the other package appears 107-121ms after the command starts and Settings is
// back 620-731ms after (359-471ms after the command's end, 5 runs); under Chrome, Settings surfaced and Chrome
// was back 119-361ms after the end (4 runs). In every run the package underneath was the PREVIOUS TASK, so the
// exemption is bounded in time and to the guarded app's own command, not to the launcher package. A sighting
// that would be an interloper is `relaunch` (allowed, logged, in `foreground`) when it falls inside a launch of
// the GUARDED app as maestro.log records it: from Maestro's own `Launching app <pkg>` line (written before it
// stops the app, whatever `label:` the step has) to the command's status line plus RELAUNCH_GRACE_MS (1.5s,
// 3x the measured worst). maestro.log is read only for such a sighting, so a clean take never reads it. If
// the app is not back by then, the same screen at the next sample is judged again and is an interloper, its
// event carrying `firstSeenSec` (measured: `launchApp` then `pressKey: Home` gave `relaunch` at 9.31s and
// INTERLOPER at 10.84s). A Home press, another app or a dialog outside that window is an interloper as before
// (the verifier's home-after.yaml still fails as `interloper`, --guard-strict still stops it). Not covered:
// `clearState`/`stopApp`/`killApp` steps on their own (only launchApp opens the window).
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
// channel cost a generation. The live lines are per change of APP (an interloper, an allowed surface,
// the home screen before the app, "<app> is in front" at its first sighting after those, "back to <app>"
// only on a return); a change between the app's own activities is a `foreground` row and no line. The
// clean summary counts rows by verdict ("N allowed system surface(s)", "the home screen before <app>
// first came up", "N stretch(es) where the foreground could not be read"), never all rows but one.
// A read that fails or comes back without a `topResumedActivity` line (screen off, an activity
// transition mid-dump) is recorded as `unknown` and is never an interloper — flagging a take
// dead on a transient adb hiccup would be its own version of this bug.
//
// STATE MACHINE (a linear pipeline with exactly two back-edges, both named below: the MAESTRO
// startup retry, and an interrupt, which jumps straight to RECORD_STOP; a filming run is a single
// attempt, never resumed mid-way):
//
//   [RECOVER A CRASHED STASH] → PREFLIGHT → DEVICE → SIZE_PROBE → [INSTALL/FRESH] →
//     [STASH PREVIOUS TAKE, --force] → RECORD_START → MAESTRO ⇄ (startup retry) → [TAIL_HOLD]
//     → RECORD_STOP → PULL → STITCH/FINALIZE → [SHOW_TAPS] → [TIGHTEN] → SIDECAR → done
//   (an interrupt, from any state at or after RECORD_START, → RECORD_STOP → PULL → … → SIDECAR;
//    before it, from DEVICE on, → put a stashed previous take back → exit, nothing filmed)
//   TAIL_HOLD (see TAIL HOLD) runs only when maestro exited without a signal and the chain is live; it
//   exits on drained | cap | fixed | rollover | recorder-gone | watch-lost to RECORD_STOP, and on a signal
//   (`interrupted`) to the handler's salvage, which still pins the take to the flow's end.
//
// - PREFLIGHT: first put back (or refuse over) a `.<name>.prev*` stash a killed run left (see THE PREVIOUS
//   TAKE UNDER --force). Then verify Node >= 20, resolve adb/maestro/ffmpeg/emulator (PATH first, then
//   $FILMKIT_* overrides, then grounded fallbacks in lib/tools.mjs), verify the flow file
//   exists, and refuse to clobber an existing output (`<name>.mp4`, `.json`, and `-tight.mp4` with or
//   without --tighten). Any failure here exits non-zero before
//   anything on the device is touched. Once a device is in hand, a guarded run also reads the
//   foreground package and WARNS if it is not the guarded app — only warns, because the flow's
//   own `launchApp` is entitled to fix that a second later.
// - DEVICE: if `--device <serial>` was passed, that serial must be online. Otherwise reuse any
//   already-running device (`adb devices`, state "device"); else boot the requested AVD headless
//   and poll for `sys.boot_completed`. Generous timeout — an emulator cold-boot is legitimately
//   slow.
// - SIZE_PROBE (see SIZE): part of the DEVICE phase, so a size the encoder will not take fails
//   here, before anything is installed, cleared or filmed, with no sidecar (nothing was filmed). So
//   does a probe that stays inconclusive through its retries (UNANSWERED PROBES in SIZE).
// - INSTALL/FRESH (all optional): `--install <apk>` runs `adb install -r` for each apk passed
//   (idempotent). `--fresh` requires `--app <package-id>` and runs `pm clear` on it right before
//   recording, so the flow always starts from a fresh-first-run state (the Android analog of
//   reinstalling). Nothing is installed or cleared unless you ask.
// - RECORD_START..RECORD_STOP is the only window where on-device child processes exist that
//   MUST be torn down before this process exits. Once the chain is running, every route out of
//   here goes through `harvest()` — stop the recorder, pull, stitch, write the sidecar — and it
//   runs at most once: the normal path awaits it (a failed `maestro test` included), an unplanned
//   throw reaches it through onUnplannedError (see UNPLANNED ERRORS), and a signal reaches it through
//   the installed handlers. SIGINT (Ctrl-C) exits 130 and SIGHUP (the shell or terminal that launched the
//   camera going away, which is what an agent's shell does when its turn ends; FEEDBACK #29)
//   exits 129 and SIGTERM exits 143, all running the same salvage: what was filmed is stitched
//   and saved with status `interrupted`. Measured without the SIGHUP handler (pty closed 22s into a take): node dies on
//   its default disposition, no .mp4 and no sidecar. Measured without stopping the maestro child
//   (`kill -HUP <node pid>` alone): node dies, maestro runs the flow to its end against a device
//   nothing is recording, and the recorder keeps rolling. So the handler also stops the child
//   (SIGINT, then SIGKILL after MAESTRO_ABORT_GRACE_MS) and waits for it before exiting; a
//   terminal signal reaches it through the process group as well. After a hangup every console
//   write fails with EIO, so stdout and stderr get a no-op 'error' listener at start-up, or the
//   salvage would die halfway. SIGTERM (an agent harness ending its turn) takes the same route and
//   exits 143; any signal not named here (SIGQUIT, SIGKILL) still kills the process outright.
//   Before the chain starts, SETUP handlers take the same three signals, from before the device is
//   touched: nothing was filmed, so they put a stashed previous take back and exit 130/129/143 with no
//   take and no sidecar. They are swapped for the full handlers in the same tick the chain starts (no
//   `await` in between), and main() parks at the stash and at the chain start if one already fired.
//   Before they existed Node's default disposition killed the process there, which was harmless only
//   because nothing had been stashed yet.
// - MAESTRO runs with `--debug-output` ALWAYS, with or without tap indicators: the startup-retry
//   predicate reads maestro.log and commands-*.json there. It is deleted when the run succeeds
//   and kept on any failure: only an `ok` take deletes it, just before its sidecar is written, so a take
//   that fails after a green flow (interloper, truncated, a geometry or crop verdict) keeps it too. Two
//   things about how it ends:
//     * STARTUP RETRY (FEEDBACK #27). `maestro test` can fail before running anything with
//       `io.grpc.StatusRuntimeException: UNAVAILABLE` (`Orchestra.initJsEngine` → `deviceInfo`;
//       maestro.log adds "Not able to reach the gRPC server" and `Command failed (tcp:<port>):
//       closed`; it goes to maestro's STDOUT, and no commands-*.json exists). Measured on Maestro
//       2.6.0: it does NOT happen after a `maestro hierarchy` that exited cleanly (~40 runs), it
//       DOES after a maestro that was killed uncleanly mid-start (SIGKILL 2.5s into a hierarchy:
//       about 75% of rounds), and then the driver stays unreachable for ~25s of wall time: attempts
//       at +5, +9, +14, +18s failed and +24s passed, two of six rounds needed a fifth try.
//       `am force-stop dev.mobile.maestro` does not clear it; the orphaned on-device driver goes
//       away on its own. So one retry is not enough. While `maestroStartupUnavailable` (lib/
//       tap-overlay.mjs) says `retry` (a known signature AND no command that ever ran), the flow
//       is started again inside the same take, MAESTRO_RETRY_BACKOFF_MS apart, always at least
//       once, and none is STARTED once MAESTRO_RETRY_BUDGET_MS has passed since the first failure
//       (checked before and again after the backoff). `durations.flowSec` is the last attempt's own
//       time and `durations.retrySec` everything before it (failed startups plus backoff).
//       The recorder keeps rolling; the extra static head is what tighten / --trim-head cut. Each
//       failed attempt's log dir is moved to `.<name>.<run>.maestro-attempts/` so the tap parser, the
//       command record and the predicate see only the LATEST attempt (that dir is removed on
//       success, kept on any failure, and named on every exit that keeps it; per run, so an earlier
//       run's kept attempts are neither mixed in nor deleted, see KEPT EVIDENCE IS PER RUN). A failure that is not a startup failure is never retried, so a
//       flow that already tapped something never runs twice. Every retry is recorded in the
//       sidecar's `maestroRetries`. `--guard-strict` firing ends the loop: the guard's abort is
//       final. The foreground guard itself watches the whole recording, retries included, because
//       the frames of a failed startup are in the take.
//     * MAESTRO failing (after retries) does not short-circuit RECORD_STOP/FINALIZE: the partial
//       recording is still pulled and transcoded (useful for debugging a flaky flow), but the
//       process still exits non-zero and prints the flow's own error.
// - PULL is where a chain becomes a take, and every pulled segment is judged on its own before it
//   enters the concat list (classifyStaticSegment / inspectSegment): USABLE (readable, has a
//   duration and packets), STATIC (readable, exactly one packet, no duration, and the recorder
//   ended the way ours do: see STATIC SEGMENTS above; usable, held) or DEAD (unreadable, or no
//   packets, or one packet from a recorder that crashed; the reason says what the file is (empty, no
//   moov atom, no packets) and how its recorder ended, read off what was seen (recorderEnding: our
//   SIGINT, our SIGKILL escalation, a remote signal as exit 128+N, a failure exit), never assumed: an
//   empty file used to be "killed before it could finalize" even from a recorder that hung and exited
//   235 on its own). A segment that could not be pulled is described the same way: what adb said (its own
//   stderr: "no file on the device to pull (adb: error: failed to stat remote object ...)" when the device has
//   none) and how its recorder ended. Measured before: "adb pull failed: `adb ... pull ...` exited with code 1"
//   for both a recorder that failed on its own (exit 233, its file deleted under it) and the stub a tail-hold
//   rollover spawns and we stop 0.02s later. ONE VOCABULARY: every place that describes a recorder's end (the
//   chain's per-segment line, its abort, the drop reason, the sidecar's `error`) uses recorderEnding, so a
//   SIGKILL is never "ended on its own (exit 137)" in one line and "killed on the device by SIGKILL" in the next.
//   An empty TRAILING dead segment that WE stopped (stoppedByUs) within
//   SEGMENT_EMPTY_MAX_WALL_SEC of its start is dropped with a note — nothing that was on screen is in
//   it. A recorder that died ON ITS OWN (the segment the chain aborted on) is never that, however short
//   its life: the flow was still running. Measured before: a seg002 `pkill -9`ed 0.33s in was dropped
//   as "nothing that was on screen is missing", its wall counted as `tailSec`, and the clean-up deleted
//   the kept seg001. Any other dead segment is real lost footage: the take is stitched from what
//   survived, reported as truncated through the same channel as a chain abort, and the run exits
//   non-zero with the file kept. One bad segment never costs the other N-1. A run is CLEAN (its local
//   segment copies deleted) only with nothing lost, no chain abort, no signal and a stitch that checked
//   out; anything else keeps them and names them (`keptFiles.local`).
// - SHOW_TAPS (on by default, skip with `--no-show-taps`): draws a ripple at every touch, burned
//   into the stitched take with ffmpeg before TIGHTEN ever sees it. Android's own `show_touches`
//   setting is NOT what does this and cannot be: Maestro injects through UiAutomation, which
//   never reaches the pointer-spot overlay (verified twice on this emulator — indicator on, taps
//   injected, nothing drawn). So the taps are recovered after the fact from what `maestro test
//   --debug-output` wrote; see lib/tap-overlay.mjs for the log formats and the measured lead.
//   Three numbers make the timing work, all measured on a Pixel 9 Pro XL emulator (API 36)
//   against a page in Chrome that flashed a white block at known instants:
//     * ANCHOR. `adb shell screenrecord --verbose` prints "Content area is WxH at offset x=.. y=.."
//       on stdout as the last thing before it starts capturing, and video time 0.000 is the
//       instant that line ARRIVES minus 115 ms. Nine runs: 77, 95, 97, 108, 114, 118, 138, 138,
//       158 ms (a 81 ms spread). SPAWN TIME IS NOT THE ANCHOR — the same nine runs put video zero
//       227–632 ms after spawn, because a `--size` the encoder refuses costs an extra configure
//       round trip before capture begins. Spawn + 400 ms is only the fallback for a screenrecord
//       too old to know `--verbose`, and it says so in the sidecar and on stderr.
//       The line is only believed if it ARRIVED in time to mean anything: `adb shell` gives the
//       recorder a line-buffered pty, but a device that block-buffers stdout instead would hand
//       over the whole of it at exit, which would map every tap to a negative time and drop the
//       lot in silence. Past ANCHOR_LINE_MAX_LAG_MS the segment falls back to spawn + 400 ms,
//       says which segment and why on stderr, and records it in `tapSync.offsets[].anchorNote`.
//       (Those nine were all cold `adb shell` spawns. A segment spawned mid-chain reaches the
//       same line in ~85 ms, so its `spawnToVideoZeroMs` in the sidecar comes out slightly
//       NEGATIVE — the constant is a touch generous when the transport is already warm. Measured
//       end to end it costs nothing that matters: the rings in a five-segment take landed 3, 24
//       and 29 ms before their rows' press highlights.)
//     * GEOMETRY. Tap coordinates are device pixels; the recording usually is not. This emulator
//       cannot configure its AVC encoder at the native 1344x2992 and silently records 720x1280,
//       inside which the screen occupies a PILLARBOXED 574x1280 at x=73 — so a plain
//       video/device ratio would put every ring 73 px left of the finger and 7% too high. The
//       `--verbose` line above states that content rectangle outright and it is what the rings
//       are mapped through; a fit-and-centre computation is the fallback.
//     * SEGMENTS. Each segment has its own anchor and its own slot in the stitched timeline (the
//       concat `duration` directives, see STITCHING), so a tap is placed as its segment's offset
//       plus its time inside that segment. A tap that lands in a seam HANDOVER — the few hundred ms
//       between one recorder's slot ending and the next one's first frame — is on no frame, but it
//       happened and the next segment shows what it did, so its ring starts on that segment's first
//       frame, `taps[].seamShiftSec` late (`tapSync.seamShiftedTaps` counts them; a long press keeps
//       what is left of its hold). Measured before: a tap 0.04s before seg004's first frame was dropped
//       and the take failed `taps-missing`. A tap in footage that is truly not there (a lost segment's
//       wall, before the first kept slot, past the file's end) is dropped with the reason, and fails a
//       take as before (`truncated` when the take is). A long press that STARTS
//       inside a segment and would run past its end is cut at the end for the same reason: the
//       rest of that press is not in the footage, and a frozen ring painted over the next
//       segment's picture is a finger that was never there.
//   A take that was supposed to get indicators and could not exits non-zero rather than handing
//   back footage that quietly lacks them; `--no-show-taps` is the way to say you meant it. What
//   "supposed to" means is not the flow text but Maestro's own `commands-*.json` execution
//   record: a `tapOn` behind a `when:` that never fired did not tap, and must not fail the take.
//   A flow this process STOPPED (a signal, --guard-strict, an unplanned error) leaves no usable command record
//   (Maestro writes commands-*.json as the flow ends: measured, a stopped maestro left none, an empty file, or
//   15949 bytes cut off inside an entry), so every touch is drawn as a plain ripple: the run says so as what
//   happened (commandRecordGapLine: "maestro was stopped (SIGINT) before it finished writing its command record
//   (commands-(flow).json is empty)"), and warns only when maestro ended on its own without a usable one. Only
//   files that parse into records count (lib/tap-overlay.mjs describeCommandFiles). Measured before: interrupted
//   takes whose file was empty or cut off still warned "no tap command in any commands-*.json (0 command(s)
//   recorded)", because the file was counted.
//   On a TRUNCATED take, taps that all fell where it has no footage (a lost segment, the flow after the chain
//   died) are not `taps-missing`: there is no frame to draw on, and `truncated` is the diagnosis (measured
//   before: such a take was failed as taps-missing). `tapSync.error` still says where the taps went.
//   The burn is abortable: a SIGINT that lands while it is running stops the ffmpeg child (see
//   lib/tap-overlay.mjs's `signal`) rather than racing it against process.exit, and the take is
//   delivered without rings first, then gets them in SALVAGE RINGS.
//   SALVAGE RINGS. A take that leaves through the signal handler or the unplanned-error exit, with taps that
//   happened and no rings yet, gets them in a SECOND PASS (salvageRings): the same drawTaps over the take as
//   delivered (already stream-copy cropped, so the taps are shifted by the crop origin and the pass crops
//   nothing; cropped in the pass if that copy failed), started only after the take and its sidecar are final
//   (the sidecar written, the stash settled; its `tapSync.error` says the rings are still to come). When they
//   land the file is replaced by rename and the sidecar rewritten. THE TIME BUDGET: the pass costs what the
//   main burn does (h264_videotoolbox at 1142x2546/60fps: 22.2s for a 52.8s take, 64.7s for 168.5s, ~0.4x
//   the take's length), which is far past the 10s that is the longest a signal otherwise waits
//   (MAESTRO_ABORT_GRACE_MS, FAIL_EXIT_WAIT_MS). So it is not fitted inside that wait; it is made unable to
//   cost the take: a SECOND signal aborts it (the take stays as saved, `tapSync.error` says the rings were
//   skipped, exit = the first signal's), and a SIGKILL during it leaves the saved, described, ringless take
//   (measured: the sidecar's note, the take intact; the orphaned ffmpeg finishes its dot-prefixed
//   `.<name>.taps-<pid>.mp4` temp and nothing renames it in). STALE BURN TEMPS: the next run of the same
//   name removes such a temp at its start (with the salvage crop's `.spscrop1|2-<pid>` temps, and the
//   `.failed[-N]` stems), once the pid in its name is dead; never one whose pid is alive (a concurrent run's,
//   or a reused pid: the safe miss). The rule is tighten's STALE TEMPS (sweepDeadRunTemps). Measured before:
//   the temp stayed until a later --force run of the same name happened to overwrite it. Taps the take has no frame for are not drawn: an
//   interrupted take ends at its encoder's last written frame (no tail hold on a signal), so a tap in the
//   last ~1-2s before a signal on a still screen can fall past its end (measured, and said in the log).
//   Before this an interrupted take that had tapped carried no rings at all.
//   When `--tighten` was also asked for, the FINALIZED (pre-burn) file is kept aside under a
//   dot-name rather than being clobbered by the burn's rename, so TIGHTEN below can run freeze
//   detection against it instead of the burn's own re-encode noise — see DETECT-FROM in
//   tighten.mjs's header. It is deleted on EVERY exit path that follows the burn: once TIGHTEN is
//   done with it, immediately if --tighten will not run (an interloped take, a failed flow, missing
//   indicators), and by the signal handler after the burn or the tighten pass has been stopped and
//   has settled (dropPreBurn). A flow-failed run used to leave it behind.
//   Every drawn tap also becomes a protected range (`{kind:'tap', start: tSec-0.15, end: tSec+
//   max(0.5, holdSec+0.45)}`) so tighten's leading-edge clamp cannot cut a tap — and its ring —
//   out of a long still stretch. Passed straight into the in-process tighten() call AND written
//   into the sidecar's top-level `timeline` array, so a later standalone `node tighten.mjs <take>`
//   protects the same taps without needing --tighten to have run here at all.
// - TIGHTEN (opt-in, --tighten): runs after SHOW_TAPS — over the video with the rings already in
//   it, never the bare one. Calls tighten.mjs's `tighten()` over the finalized .mp4, passing the
//   pre-finish file as `detectFrom` and every tap as a protected range when SHOW_TAPS drew rings
//   (see above), and `crf`. The pre-finish file is kept whenever ANY finishing encode ran, rings or
//   not: a take that was only cropped (`--no-show-taps`, or a flow with no taps) also went through
//   a re-encode, whose noise floor would flip freeze detection to threshold mode, so it gets the
//   same detect source. When a crop was applied the delivered take is that file CROPPED, and the
//   call declares it as `detectFromCrop` so tighten's frame-size guard checks the pair against it.
//   With neither rings nor a crop nothing re-encodes the take and this call is what it always was. WHICH TAKES GET TIGHTENED: every run that reaches it, i.e. the final statuses
//   `ok`, `truncated` and `failed` (a size/aspect mismatch). The failed-tight of a truncated take
//   was useful in a real filming session, so it stays. NOT tightened: `flow-failed` and `taps-missing`
//   (both exit before this step, and a failed flow's partial recording is left as-is for
//   debugging), `interloper` (skipped on purpose: a suspect take must not gain a polished
//   `-tight`; the `node tighten.mjs` hint is printed after the take is stepped aside, so it names the
//   `.failed` file), `interrupted` (a signal aborts the pass: see below), and a harvest failure. A truncated
//   or failed take's `-tight` is renamed with it (`<name>.failed-tight.mp4`) and the sidecar's
//   `tight.path` says where it ended up. The raw file is always kept, a `-tight` variant is
//   written alongside it. A tighten failure is reported but does not fail the overall command —
//   the raw recording already succeeded by that point. THE PASS IS ABORTABLE, like the burn: it is
//   handed an AbortSignal, and a SIGINT/SIGHUP/SIGTERM aborts it, awaits it (tighten() settles only
//   after its ffmpeg child has exited and has removed its own temp output; it writes the final
//   `-tight.mp4` only by renaming a finished temp over it), removes the pre-burn copy, and only
//   then exits. This is why an interrupted take never leaves a partial `-tight.mp4`: the ffmpeg
//   child used to outlive process.exit() and keep encoding into the final path. Not covered: a
//   SIGKILL of node itself, which leaves tighten's hidden temp behind (it cannot be mistaken for a
//   take; see tighten.mjs's ABORT section).
// - SIDECAR: `<out>/<name>.json` records what produced the video — a `status` (ok / truncated /
//   interloper / taps-missing / flow-failed / interrupted / failed / error), `interruptedBy` (the signal
//   that arrived, on an interrupted take and on a failed one whose failure predates it, else null), the filmkit commit
//   (`filmkit: { commit, branch }` or null), flow path and content hash, argv, device serial/
//   fingerprint, requested vs. pinned vs. actual geometry (`recording.requestedSize` /
//   `pinnedSize` / `actualSize` = what screenrecord recorded / `deliveredSize` = the file at
//   `output.path`, i.e. `actualSize` less the crop), the display's current orientation (`device.orientedSize`,
//   `device.rotation`), the size probe (`recording.sizeProbe`, with `probeCount` and each probe's
//   reported content area) and the after-the-fact checks (`recording.sizeCheck`: aspect, size,
//   content-fills-frame), bit rate, `crf`, every segment's wall duration and whether it
//   was dropped or held static (`recording.staticSegments`), `recording.truncated` / `truncationReason` (about
//   the delivered video: false and null when there is none), the stitch's planned-vs-actual
//   duration check, `maestroRetries`, raw and tightened durations (`durations.flowSec` is the last
//   maestro attempt's, `durations.retrySec` the failed startups and backoff before it, and
//   `recordingWallSec = warmupSec + retrySec + flowSec + holdSec + stopSec - unrecordedSec = headSec + seamSec +
//   lostSec + tailSec + trimmedSec + fileSec - overhangSec`, both closing EXACTLY as printed and recorded (largest
//   remainder, see roundToTotal), no term negative, `fileSec` the WRITTEN file's length (`output.durationSec`: after
//   the 60fps finishing encode, whose frame grid moves the end by under half a frame, in `tailSec`), `overhangSec`
//   the file's run past the recording's end (only a last frame the video-zero estimate or that frame grid puts
//   after the recorder's end, kept, not cut: ~0), `holdSec` being the
//   TAIL HOLD (0 without one), `unrecordedSec` the phases' overrun past the recorder's end (the chain died
//   mid-flow, or a signal stopped the recorder before maestro exited; then `stopSec` is 0), `lostSec` the
//   wall of lost segments, `tailSec` the wall after the take's pinned end (or, with no pinned end, the frames
//   never written at the recording's end), `finalizeSec` the wait after the recorder stopped; computed on
//   every exit with a take, signals and unplanned errors included; see DURATION HONESTY at accountDurations),
//   `recording.tailHold` (see TAIL HOLD), `foreground` rows with verdict guarded | allowed |
//   home-before-app | relaunch | interloper | unknown (an interloper re-judged after a relaunch window carries
//   `firstSeenSec`), `tight.durationSec` (the written file's, from tighten's
//   `fileDurationSec`; `plannedDurationSec` beside it), `tight.removedSec` (the cut file's length less the
//   written one's, the console's `tightened A -> B (X removed)` X, so A - X = B; `plannedRemovedSec` beside
//   it, the plan's), and
//   `output.fps` / `output.encoder` (the burn's own when rings were drawn, otherwise read off the
//   file, so a failed take's sidecar is not blank), every tap that was drawn
//   (`taps`, in output pixels and seconds into the video; `seamShiftSec` on a tap drawn on the first frame after a
//   seam handover, counted in `tapSync.seamShiftedTaps`), whether indicators were drawn at all
//   (`showTaps`; `showTapsRequested` is whether they were asked for) and whether any were owed
//   (`tapsExpected`, read off Maestro's record on every exit with a take, a signal's included: an
//   interrupted take that had tapped used to say false), the anchors they were converted
//   against (`tapSync`), any kept temp files, timestamp. `taps[].tSec` is measured in the take
//   that was written, NOT in the `-tight` variant — tighten cuts time out from under it. A
//   top-level `clock`/`timeline` pair (see SHOW_TAPS above) mirrors the web camera's own sidecar
//   shape, so tighten.mjs's sidecar loader needs no camera-specific branch to protect taps on a
//   standalone run. `tight.detectFrom` / `tight.detectMode` / `tight.protected` mirror the
//   tighten() result that produced `-tight.mp4`.
//   It is written on every path from RECORD_START onward, failures included, so a `demo/raw/`
//   tree stays self-describing months later, and every final status except `ok` and `interrupted`
//   is written to `<name>.failed.json` (lib/takes.mjs steps the video, its `-tight` and the
//   sidecar aside, to `.failed-2.*` and on if that slot is taken, so a failed run never burns the
//   take number and never overwrites an earlier failure; FEEDBACK #13). A run that dies in
//   PREFLIGHT, DEVICE or SIZE_PROBE writes none — nothing was filmed, so there is nothing to
//   describe, and an existing sidecar from an earlier take must not be overwritten by a run that
//   never reached the camera.
//
// RE-ENCODE QUALITY (FEEDBACK #25) and QUIET FFMPEG (FEEDBACK #12). Every re-encode this camera
// does itself — the finalize fallback, --trim-head/--trim-tail, the stitch fallback, the tap burn's
// software path, and the tighten pass — uses CRF `--crf` (default 18, lib/encode.mjs), recorded as
// `crf` in the sidecar; stream copies do not re-encode and ignore it. The internal ffmpeg calls that
// only produce a file run with `-hide_banner -loglevel error`; the ones whose OUTPUT IS PARSED are
// deliberately not silenced below what they parse: `probeVideo` reads the `Duration:`/`Stream`
// banner at info level, `probePackets` runs at `-v error` and reads stdout, and `stitchSegments`
// runs at `-loglevel warning` because the "Non-monotonic DTS" check reads a warning.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { mkdir, rm, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, basename, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileP, fileExists, run, runCapture, resolveTool, sleep } from './lib/tools.mjs';
import { valueFor } from './lib/args.mjs';
import { preflight as preflightChecks, validateNameStem } from './lib/preflight.mjs';
import {
  burnTapRipples, filterScriptOption, flowHasTapCommands, locateLogs, maestroCommandRan, maestroStartupUnavailable, parseMaestroTaps,
} from './lib/tap-overlay.mjs';
import { DEFAULT_CRF, parseCrf, x264Args } from './lib/encode.mjs';
import { markTakeFailed, recoverCrashedStash, stashPreviousTake } from './lib/takes.mjs';
import { filmkitCommit } from './lib/provenance.mjs';
import { cutSummary, isDeadRunPid, sweepDeadRunTemps, tighten } from './tighten.mjs';
import { checkGeneratedTarget } from './lib/scenario/generated.mjs';
import { readBranches } from './lib/scenario/branches.mjs';
import { emitMaestroScenario, plannedWrapper } from './lib/scenario/emit-maestro.mjs';
import { checkWrapper, startVerify } from './lib/scenario/run-maestro.mjs';
import { lintAndReport } from './lib/maestro-lint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_DIR = join(HERE, 'out');
const DEVICE_DIR = '/sdcard';

const DEFAULT_BIT_RATE = '8000000';
const DEFAULT_SEGMENT_SECONDS = 170; // headroom under screenrecord's own 180s hard stop
const SEGMENT_SECONDS_CAP = 180; // screenrecord refuses / truncates beyond this
const SEGMENT_EARLY_EXIT_TOLERANCE_MS = 2000; // a healthy segment runs its full --time-limit
const RECORD_WARMUP_MS = 1500; // let screenrecord actually start on-device before Maestro taps
const RECORD_FINALIZE_MS = 2000; // after SIGINT, before adb pull — lets the on-device mp4 close
// ── TAIL HOLD (see the header): keep the recorder rolling after the flow until the encoder has written it ──
// The longest the hold may run. Measured worst case of frames still queued in the encoder when the flow
// ended: 7.54s (full-screen motion on every frame under maestro load, 1144x2546, 4 runs 6.05-7.54s).
const TAIL_HOLD_CAP_MS = 10000;
// "Drained": this many consecutive samples of the software codec's CPU time without a tick, spanning at
// least TAIL_HOLD_IDLE_MIN_MS. Saturated encoding never showed one zero sample (200 samples, maestro running);
// an isolated one-sample zero was seen once under load, so one is not enough.
const TAIL_HOLD_IDLE_SAMPLES = 3;
const TAIL_HOLD_IDLE_MIN_MS = 250;
// When the encoder cannot be watched (not a software codec this process can see): a fixed hold. NOT
// measured on hardware (no hardware encoder was available); sized to drain the ~19-frame queue measured on
// the emulator at >= 10 fps, which a hardware encoder keeping up with the display far exceeds.
const TAIL_HOLD_FALLBACK_MS = 2000;
const RECORD_STOP_TIMEOUT_MS = 15000; // SIGINT ignored this long → escalate rather than hang
const BOOT_TIMEOUT_MS = 5 * 60 * 1000; // cold emulator boot is legitimately slow
const BOOT_POLL_MS = 3000;
// A dead trailing segment that WE stopped (stoppedByUs) no longer than this after it started was stopped
// before it could hold anything an operator would miss: dropping it is a note, not a truncation. Anything
// longer is real footage, and so is a recorder of any age that died on its own (see selectSegments).
const SEGMENT_EMPTY_MAX_WALL_SEC = 3;
// How far the stitched file may sit from the timeline the concat directives planned before the
// stitch is called suspect. Seams cost ~0.33s each; 1.5s is well past any plausible seam total.
const STITCH_DRIFT_TOLERANCE_SEC = 1.5;
// What the last frame of a stream-copied file lasts when nothing follows it: the concat demuxer
// gives a 1-frame file's only sample 0.071s (measured, 1080x2404). It is the tail a static final
// segment adds on top of its hold, and the slack assessStitch's window gets for it.
const STATIC_TAIL_FRAME_SEC = 0.1;

// ── SIZE PREFLIGHT (see the SIZE header) ─────────────────────────────────────────────────────
const SIZE_PROBE_TIME_LIMIT_SEC = 1; // an accepted probe costs ~1.3s wall; a refusal ~0.1s
const SIZE_PROBE_TIMEOUT_MS = 20000; // a probe that neither exits nor refuses is a broken adb, not a size
// An INCONCLUSIVE probe (see probeRecorderSize) is asked again, this many attempts in all, this far apart, and
// a size still unanswered after that stops the run in the DEVICE phase (see SIZE, UNANSWERED PROBES). Measured:
// the one inconclusive probe seen in the wild (exit 235 on the tall AVD, mid-walk) was gone ~1s later (the
// take's own recorder, spawned that soon after, configured and wrote normally, and a probe 20s later
// answered); the reproducible one (the probe file deleted on the device under the recorder: exit 233) is
// one-shot. 2s is twice the observed recovery; three attempts bound the added wait at ~2x(2s + a ~1.5s
// probe) when the device does recover, and ~64s when adb hangs every time (3 x SIZE_PROBE_TIMEOUT_MS).
const SIZE_PROBE_ATTEMPTS = 3;
const SIZE_PROBE_RETRY_PAUSE_MS = 2000;
const SIZE_LADDER_FLOOR_PX = 480; // below this (long side) a "recording" is not a demo; give up and say so
// The ladder shrinks the long side by this much per rung (2%: ~90 rungs from 2992 down to the floor).
const SIZE_LADDER_STEP = 0.98;
// After the first size the encoder accepts, at most this many further rungs are probed looking for one
// whose content area needs no more than CROP_TOLERANCE_PX of trimming. With the binary search that
// finds the first accepted rung (~log2 of the ladder) it bounds a whole walk at ~10-15 probes.
const SIZE_CROP_WALK_MAX = 8;
// screenrecord's content rectangle is short of the video by float truncation, measured 1-2px on an
// axis (1143 of 1144, 2528 of 2530). That much is trimmed off in the finishing encode; more than this
// on an axis is a REAL letterbox (a pillarboxed fallback is 25%) and is refused, as it always was.
const CROP_TOLERANCE_PX = 2;
// Relative difference between the recorded w/h and the device's that still counts as the same
// aspect. Encoder rounding measured <=0.1% (1080x2404 on a 1344x2992 panel is 0.01%); the fallback
// this exists to catch is 25% (720x1280). 1% sits far from both.
const ASPECT_TOLERANCE = 0.01;
// The probe's device file is PER RUN (see SIZE, PROBE FILES): `filmkit-size-probe-<run>-<pid>.mp4`, the run's UTC
// tag and this process's pid. The fixed name older code used is still swept (sweepStaleProbeFiles).
const DEVICE_PROBE_PREFIX = 'filmkit-size-probe';
const LEGACY_PROBE_NAME = `${DEVICE_PROBE_PREFIX}.mp4`;
// Its FIRST capture group is the owning run's local pid: the pid isDeadRunPid judges.
const PROBE_NAME_RE = /^filmkit-size-probe-\d{8}-\d{6}-(\d+)\.mp4$/;
/** This run's probe file on the device. `runTag` is the run's UTC start (20260929-191530). */
export function probeDeviceFile(runTag, pid = process.pid) {
  return `${DEVICE_DIR}/${DEVICE_PROBE_PREFIX}-${runTag}-${pid}.mp4`;
}
const runTagOf = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const ADB_CLEANUP_TIMEOUT_MS = 5000; // a best-effort `adb shell rm` must never be able to hang the run

// ── maestro startup retry (FEEDBACK #27) ─────────────────────────────────────────────────────
// After a `maestro` that was killed uncleanly (an agent's tool timeout SIGKILLing `maestro
// hierarchy` mid-start is the measured trigger; clean exits never reproduced it in ~40 runs) the
// next `maestro test` fails before running anything with `io.grpc.StatusRuntimeException:
// UNAVAILABLE`, and keeps failing for about 25s of WALL TIME (attempts at +5, +9, +14, +18s failed,
// +24s passed; two rounds needed a fifth attempt). One immediate retry therefore does not heal it.
// A failing attempt itself takes ~4-5s, so 5s of backoff makes a cycle of ~10s. The budget counts
// from the moment the FIRST failure ended, and at least one retry is always made.
const MAESTRO_RETRY_BACKOFF_MS = 5000;
const MAESTRO_RETRY_BUDGET_MS = 45000;

// ── SHOW_TAPS timing constants (all measured; see the SHOW_TAPS header) ──────────────────────
// Video time 0.000 sits this far BEFORE the arrival of screenrecord's "Content area is …" line,
// which it prints immediately before the capture loop starts. Nine runs: 77–158 ms, median 115.
const CONTENT_LINE_TO_VIDEO_ZERO_MS = 115;
// The fallback anchor when that line never came (a screenrecord without `--verbose`). Same nine
// runs measured spawn → video zero at 227–632 ms, median 409 — hence a warning wherever used.
const SPAWN_TO_VIDEO_ZERO_MS = 400;
// `Content area is 574x1280 at offset x=73 y=0` — the pillarbox the rings have to live inside.
const CONTENT_AREA_RE = /Content area is\s+(\d+)x(\d+)\s+at offset\s+x=(-?\d+)\s+y=(-?\d+)/;
// Ring size is quoted in dp, so it has to survive both the recording's scale and the device's
// density. 480 dpi (3×) is this emulator's, and a sane guess for a phone whose density will not
// be read — being wrong here changes how big the ring is, never where it is.
const DEFAULT_DENSITY_DPI = 480;

// How often the foreground watchdog asks the device who is on top. Every sample is one `adb
// shell dumpsys` round trip (~40ms here), so this is cheap enough to run for the whole take and
// still fine-grained enough that a neighbour cannot slip in and out between two polls.
const FOREGROUND_POLL_MS = 1500;
// --guard-strict aborts by SIGINT-ing the maestro child (a JVM: `maestro` execs java, so the pid
// we hold is the one that matters). If the JVM ignores it this long, escalate rather than hang —
// the recording still has to be harvested.
const MAESTRO_ABORT_GRACE_MS = 10000;
// How long an interrupt waits for a failure exit that was already under way (failTake: markFailed's
// renames, the sidecar, the restore) before exiting without it. Normally well under a second (a few
// renames, a hash of the flow file, one `adb getprop` for the fingerprint, one small write); the bound
// exists because that getprop has no timeout of its own, and a wedged adb must not hold Ctrl-C forever.
// The same 10s as MAESTRO_ABORT_GRACE_MS, the longest wait a signal already accepts.
const FAIL_EXIT_WAIT_MS = 10000;
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
  '[--guard-app <package-id>] [--guard-allow <package-id>]... [--guard-strict] ' +
  '[--bit-rate <n>] [--size <WxH>] [--strict-size] [--segment-seconds <n>] [--tighten] ' +
  '[--min-still <sec>] [--keep <sec>] [--noise <level>] [--crf <0-51>] ' +
  '[--trim-head <sec>] [--trim-tail <sec>] [--target-duration <sec>] [--no-show-taps] [--verbose] ' +
  '[--scenario [--scenario-dir <dir>] [--scenario-verify]]';

function log(msg) {
  console.log(`[film-android] ${msg}`);
}

function usageError(msg) {
  console.error(`[film-android] ${msg}`);
  console.error(USAGE);
  process.exit(1);
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
  let guardAllow = [];
  let guardStrict = false;
  let bitRate = DEFAULT_BIT_RATE;
  let size;
  let strictSize = false;
  let segmentSeconds = DEFAULT_SEGMENT_SECONDS;
  let doTighten = false;
  let minStill = 1.2;
  let keep = 0.6;
  let noise = 'auto';
  let crfRaw = DEFAULT_CRF;
  let trimHead = 0;
  let trimTail = 0;
  let targetDuration = null;
  let showTaps = true;
  let verbose = false;
  let scenario = false;
  let scenarioDir;
  let scenarioVerify = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out = valueFor(argv, i, '--out', usageError);
      i++;
    } else if (argv[i] === '--name') {
      name = valueFor(argv, i, '--name', usageError);
      i++;
    } else if (argv[i] === '--force') {
      force = true;
    } else if (argv[i] === '--device') {
      device = valueFor(argv, i, '--device', usageError);
      i++;
    } else if (argv[i] === '--avd') {
      avd = valueFor(argv, i, '--avd', usageError);
      i++;
    } else if (argv[i] === '--install') {
      installs.push(resolve(valueFor(argv, i, '--install', usageError)));
      i++;
    } else if (argv[i] === '--app') {
      appId = valueFor(argv, i, '--app', usageError);
      i++;
    } else if (argv[i] === '--fresh') {
      fresh = true;
    } else if (argv[i] === '--guard-app') {
      guardApp = valueFor(argv, i, '--guard-app', usageError);
      i++;
    } else if (argv[i] === '--guard-allow') {
      guardAllow.push(valueFor(argv, i, '--guard-allow', usageError));
      i++;
    } else if (argv[i] === '--guard-strict') {
      guardStrict = true;
    } else if (argv[i] === '--strict-size') {
      strictSize = true;
    } else if (argv[i] === '--bit-rate') {
      bitRate = String(valueFor(argv, i, '--bit-rate', usageError));
      i++;
    } else if (argv[i] === '--size') {
      size = String(valueFor(argv, i, '--size', usageError));
      i++;
    } else if (argv[i] === '--segment-seconds') {
      segmentSeconds = Number(valueFor(argv, i, '--segment-seconds', usageError));
      i++;
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
    } else if (argv[i] === '--crf') {
      crfRaw = valueFor(argv, i, '--crf', usageError);
      i++;
    } else if (argv[i] === '--trim-head') {
      trimHead = Number(valueFor(argv, i, '--trim-head', usageError));
      i++;
    } else if (argv[i] === '--trim-tail') {
      trimTail = Number(valueFor(argv, i, '--trim-tail', usageError));
      i++;
    } else if (argv[i] === '--target-duration') {
      targetDuration = Number(valueFor(argv, i, '--target-duration', usageError));
      i++;
    } else if (argv[i] === '--verbose') {
      verbose = true;
    } else if (argv[i] === '--scenario') {
      scenario = true;
    } else if (argv[i] === '--scenario-dir') {
      scenarioDir = valueFor(argv, i, '--scenario-dir', usageError);
      i++;
    } else if (argv[i] === '--scenario-verify') {
      scenarioVerify = true;
    } else if (argv[i] === '--no-show-taps') {
      showTaps = false;
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
  if (size && !/^[1-9]\d*x[1-9]\d*$/.test(size)) {
    console.error(`--size must look like <width>x<height>, both positive whole numbers, e.g. 1080x2400 (got "${size}")`);
    process.exit(1);
  }
  // A name becomes a filename stem in --out and a filename stem on the device; keep it one.
  // Same rule, same words, one copy: lib/preflight.mjs owns it for every camera.
  try {
    validateNameStem(name);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (!Number.isFinite(segmentSeconds) || segmentSeconds < 5 || segmentSeconds > SEGMENT_SECONDS_CAP) {
    console.error(
      `--segment-seconds must be between 5 and ${SEGMENT_SECONDS_CAP} (screenrecord's own hard ` +
        `cap) — got "${segmentSeconds}"`,
    );
    process.exit(1);
  }
  if (!Number.isFinite(minStill) || minStill <= 0) {
    console.error(`--min-still must be a positive number of seconds (got "${minStill}")`);
    process.exit(1);
  }
  if (!Number.isFinite(keep) || keep < 0) {
    console.error(`--keep must be a non-negative number of seconds (got "${keep}")`);
    process.exit(1);
  }
  if (typeof noise !== 'string' || noise.trim() === '') {
    console.error(`--noise needs a value — "auto" or a freezedetect level like -60dB`);
    process.exit(1);
  }
  // The modifiers mean nothing without --scenario. An error, not an implication: --scenario-verify
  // WIPES app data when the wrapper has clearState, so it must never switch itself on by accident.
  if (!scenario && scenarioDir !== undefined) usageError('--scenario-dir needs --scenario');
  if (!scenario && scenarioVerify) usageError('--scenario-verify needs --scenario');
  let crf;
  try {
    crf = parseCrf(crfRaw, '--crf');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (!Number.isFinite(trimHead) || trimHead < 0) {
    console.error(`--trim-head must be a non-negative number of seconds (got "${trimHead}")`);
    process.exit(1);
  }
  if (!Number.isFinite(trimTail) || trimTail < 0) {
    console.error(`--trim-tail must be a non-negative number of seconds (got "${trimTail}")`);
    process.exit(1);
  }
  if (targetDuration !== null && (!Number.isFinite(targetDuration) || targetDuration <= 0)) {
    console.error(`--target-duration must be a positive number of seconds (got "${targetDuration}")`);
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
    guardAllow,
    guardStrict,
    bitRate,
    size,
    strictSize,
    segmentSeconds,
    doTighten,
    minStill,
    keep,
    noise,
    crf,
    trimHead,
    trimTail,
    targetDuration,
    showTaps,
    verbose,
    scenario,
    scenarioDir: scenarioDir ? resolve(scenarioDir) : undefined,
    scenarioVerify,
  };
}

// ── PREFLIGHT ───────────────────────────────────────────────────────────────────────────────
async function preflight(flowPath, plannedOutputs, force) {
  // Node version, flow file, and the refusal to clobber an existing take are the same three
  // checks every camera makes in the same order with the same words — lib/preflight.mjs owns
  // them. What is left here is the only part that is Android's: which tools have to exist.
  await preflightChecks(flowPath, plannedOutputs, force);
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

// `wm density` reports "Physical density: 480" and, under an override, "Override density: 420".
// Only the ring's SIZE depends on this, so a device that will not answer costs a ring drawn at
// the wrong scale, never one drawn in the wrong place.
async function deviceDensityDpi(adb, deviceId) {
  try {
    const stdout = await runCapture(adb, ['-s', deviceId, 'shell', 'wm', 'density']);
    const override = stdout.match(/Override density:\s*(\d+)/);
    const physical = stdout.match(/Physical density:\s*(\d+)/);
    const dpi = Number((override ?? physical)?.[1]);
    return Number.isFinite(dpi) && dpi > 0 ? dpi : null;
  } catch {
    return null;
  }
}

// `--verbose` is what prints the "Content area is …" line the tap anchor hangs off, and it has
// been in screenrecord since v1.0 — but a recorder that rejected the flag would fail EVERY
// segment, which is a catastrophic way to find out. So ask first: `--help` costs one round trip
// and the answer decides whether the run gets the good anchor or the fallback one.
async function screenrecordSupportsVerbose(adb, deviceId) {
  try {
    const stdout = await runCapture(adb, ['-s', deviceId, 'shell', 'screenrecord --help 2>&1']);
    return /--verbose\b/.test(stdout);
  } catch {
    return false;
  }
}

// ── SIZE PREFLIGHT: which `--size` the encoder will actually take (FEEDBACK #22) ─────────────
// See the SIZE header for the measured behaviour. This is the mechanics: probe a size with a
// throwaway 1s recording and read the verdict from exit code + stderr, never from the video.
const evenPx = (n) => 2 * Math.round(n / 2); // the encoder wants even dimensions (odd ones are refused)

export function parseSize(str) {
  const m = /^(\d+)x(\d+)$/.exec(String(str ?? ''));
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/** Same aspect ratio within ASPECT_TOLERANCE? A rotated recording (w and h swapped) counts as the same. */
export function sameAspect(a, b, tolerance = ASPECT_TOLERANCE) {
  const x = typeof a === 'string' ? parseSize(a) : a;
  const y = typeof b === 'string' ? parseSize(b) : b;
  if (!x || !y || !(x.w > 0 && x.h > 0 && y.w > 0 && y.h > 0)) return false;
  const ra = x.w / x.h;
  const rb = y.w / y.h;
  return Math.abs(ra - rb) / rb <= tolerance || Math.abs(1 / ra - rb) / rb <= tolerance;
}

/**
 * Candidate sizes BELOW `native`, largest first: the long side shrinks by SIZE_LADDER_STEP per rung
 * down to SIZE_LADDER_FLOOR_PX, the other side follows the aspect and both are rounded to even. These
 * are NEAR-aspect sizes, not exact multiples: screenrecord's content rectangle almost never equals
 * the video (see the SIZE header), and the exact multiples that do fill cost half the resolution, so
 * the walk takes the largest size the encoder accepts and the finishing encode trims the 1-2px bar.
 */
export function aspectLadder(nativeW, nativeH) {
  const landscape = nativeW >= nativeH;
  const long = landscape ? nativeW : nativeH;
  const short = landscape ? nativeH : nativeW;
  const seen = new Set([`${nativeW}x${nativeH}`]);
  const rungs = [];
  for (let k = 1; long * SIZE_LADDER_STEP ** k >= SIZE_LADDER_FLOOR_PX; k++) {
    const l = evenPx(long * SIZE_LADDER_STEP ** k);
    const sh = evenPx((l * short) / long);
    const key = landscape ? `${l}x${sh}` : `${sh}x${l}`;
    if (!seen.has(key)) {
      seen.add(key);
      rungs.push(key);
    }
  }
  return rungs;
}

/**
 * What a reported content area means for a `size` video. `fill`: it covers the whole frame from
 * (0,0). `crop`: it is short by at most CROP_TOLERANCE_PX on each axis, and `crop` is the largest
 * even-dimension rectangle inside it, at an even offset (chroma is subsampled 2x2, so an odd origin
 * would shift the colour planes against the luma). `letterbox`: more than that, a real bar.
 * `unknown`: no content area was reported (a screenrecord without --verbose).
 */
export function planCrop(content, size) {
  const v = typeof size === 'string' ? parseSize(size) : size;
  if (!content || !v) return { kind: 'unknown' };
  if (content.w === v.w && content.h === v.h && content.x === 0 && content.y === 0) return { kind: 'fill' };
  const missW = v.w - content.w;
  const missH = v.h - content.h;
  const said = `content ${content.w}x${content.h}${content.x || content.y ? ` at (${content.x},${content.y})` : ''} in a ${v.w}x${v.h} video`;
  if (missW < 0 || missH < 0 || missW > CROP_TOLERANCE_PX || missH > CROP_TOLERANCE_PX) {
    return { kind: 'letterbox', reason: `screenrecord letterboxed the picture: ${said}` };
  }
  const x0 = content.x + (content.x % 2);
  const y0 = content.y + (content.y % 2);
  const x1 = content.x + content.w - ((content.x + content.w) % 2);
  const y1 = content.y + content.h - ((content.y + content.h) % 2);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return { kind: 'letterbox', reason: `screenrecord letterboxed the picture: ${said}` };
  return {
    kind: 'crop',
    crop: { w, h, x: x0, y: y0 },
    contentArea: { ...content },
    reason: `${said}: screenrecord's letterbox math truncates in float, so its content is ${missW}x${missH}px short of the video; trimmed to ${w}x${h} at (${x0},${y0})`,
  };
}

/** Does a reported `Content area is WxH at offset x=X y=Y` cover the whole `size` video, from (0,0)? */
export function contentFillsFrame(content, size) {
  const v = typeof size === 'string' ? parseSize(size) : size;
  return Boolean(content && v && content.w === v.w && content.h === v.h && content.x === 0 && content.y === 0);
}

/**
 * One probe. `accepted` is true (the encoder took exactly this size), false (refused, or silently
 * replaced it), or null (INCONCLUSIVE: adb or the recorder failed for a reason that says nothing
 * about the size — the caller must not treat that as a refusal). An accepted probe also reports
 * `content` (screenrecord's own "Content area is …" line) and `fills`: whether that rectangle is the
 * whole video at (0,0). Accepted is not enough: an accepted size that does not fill has a 1-2px
 * black bar (see the SIZE header). `display` is what screenrecord itself says the display is
 * ("Display is WxH … orientation=ROTATION_n"), which is the truth about rotation.
 * Always passes an explicit --size, because that is the only form whose refusal is loud: exit 234
 * and `unable to configure video/avc codec at WxH (err=-22)` on stderr in ~0.1s, no fallback.
 * Without --size the same refusal exits 0 and drops to 720x1280 with two stderr lines. It passes the
 * same --bit-rate the real recorder will use, so the probe and the take cannot disagree about what
 * the encoder accepts. Also cleans its device file.
 */
export async function probeRecorderSize(adb, deviceId, size, bitRate = DEFAULT_BIT_RATE, deviceFile = probeDeviceFile(runTagOf(Date.now()))) {
  const started = Date.now();
  const child = spawn(
    adb,
    ['-s', deviceId, 'shell', 'screenrecord', '--verbose', '--bit-rate', String(bitRate), '--size', size, '--time-limit', String(SIZE_PROBE_TIME_LIMIT_SEC), deviceFile],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  // Resolve on 'close', not 'exit': 'exit' can fire before the last stderr chunk has been read, and
  // the refusal below is decided by a regex over that stderr.
  const outcome = await new Promise((resolveProbe) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveProbe({ spawnError: `no answer within ${SIZE_PROBE_TIMEOUT_MS / 1000}s` });
    }, SIZE_PROBE_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolveProbe({ spawnError: err.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolveProbe({ code, signal });
    });
  });
  // Bounded: a hung adb must not turn a failed probe into a hung run.
  await runCapture(adb, ['-s', deviceId, 'shell', 'rm', '-f', deviceFile], { timeout: ADB_CLEANUP_TIMEOUT_MS }).catch(() => {});
  const elapsedMs = Date.now() - started;
  const configured = [...stdout.matchAll(/Configuring recorder for (\d+x\d+)/g)].map((m) => m[1]).pop() ?? null;
  const refusal = /unable to configure video\/avc codec/.test(stderr);
  const area = /Content area is\s+(\d+)x(\d+)\s+at offset\s+x=(-?\d+)\s+y=(-?\d+)/.exec(stdout);
  const content = area ? { w: Number(area[1]), h: Number(area[2]), x: Number(area[3]), y: Number(area[4]) } : null;
  const disp = /Display is\s+(\d+)x(\d+)[^\n]*?orientation=ROTATION_(\d+)/.exec(stdout);
  const display = disp ? { w: Number(disp[1]), h: Number(disp[2]), rotation: Number(disp[3]) } : null;
  const base = { size, exitCode: outcome.code ?? null, elapsedMs, configured, content, display, fills: contentFillsFrame(content, size), plan: planCrop(content, size) };
  if (outcome.spawnError) return { ...base, accepted: null, note: outcome.spawnError };
  if (refusal) return { ...base, accepted: false, note: stderr.trim().split('\n')[0] };
  if (outcome.code === 0 && configured === size) {
    return {
      ...base,
      accepted: true,
      note: base.plan.kind === 'crop' ? base.plan.reason : base.plan.kind === 'letterbox' ? base.plan.reason : null,
    };
  }
  if (outcome.code === 0) return { ...base, accepted: false, note: `encoder configured ${configured ?? 'nothing'} instead` };
  return {
    ...base,
    accepted: null,
    note: `screenrecord exited ${outcome.code ?? outcome.signal} without a codec refusal: ${(stderr.trim() || stdout.trim()).split('\n').pop() || 'no output'}`,
  };
}

/**
 * PROBE FILES (see the SIZE header): remove the size-probe files killed runs left in DEVICE_DIR. A per-run
 * `filmkit-size-probe-<run>-<pid>.mp4` goes when its pid is dead on this machine, by the STALE TEMPS rule
 * (tighten.mjs isDeadRunPid, the one place that rule lives): never this process's, never a live pid's
 * (another run mid-probe, or a reused pid: the safe miss). The legacy fixed name goes unless a recorder on the device is writing it right now (an
 * older filmkit mid-probe). Best effort and bounded: an adb that cannot list or remove costs nothing.
 * Returns the device paths removed.
 */
export async function sweepStaleProbeFiles(adb, deviceId) {
  const shell = (cmd) => runCapture(adb, ['-s', deviceId, 'shell', cmd], { timeout: ADB_CLEANUP_TIMEOUT_MS });
  const names = (await shell(`ls ${DEVICE_DIR}`).catch(() => '')).split(/\s+/).filter((n) => n.startsWith(DEVICE_PROBE_PREFIX));
  const doomed = names.filter((n) => {
    const m = PROBE_NAME_RE.exec(n);
    return m !== null && isDeadRunPid(m[1]);
  });
  if (names.includes(LEGACY_PROBE_NAME)) {
    // `[f]` keeps pgrep from matching the shell running this very command line.
    const writer = await shell(`pgrep -f '[f]ilmkit-size-probe\\.mp4' || true`).catch(() => null);
    if (writer !== null && !writer.trim()) doomed.push(LEGACY_PROBE_NAME);
  }
  if (!doomed.length) return [];
  const paths = doomed.map((n) => `${DEVICE_DIR}/${n}`);
  await runCapture(adb, ['-s', deviceId, 'shell', 'rm', '-f', ...paths], { timeout: ADB_CLEANUP_TIMEOUT_MS }).catch(() => {});
  return paths;
}

/**
 * The display size screenrecord will actually see, in the CURRENT orientation. `wm size` reports the
 * panel's natural (portrait) size whatever the rotation, but a device held in landscape records a
 * landscape picture, and a size list built from the natural size would letterbox every probe. The
 * rotation is read off the window manager (`mRotation=1|3` means width and height swap); the probe's
 * own "Display is WxH" line corrects it afterwards if this guess was wrong (resolveRecordingSize).
 */
export async function deviceOrientedSize(adb, deviceId, wmSize) {
  const natural = parseSize(wmSize);
  if (!natural) return { size: wmSize ?? null, rotation: null };
  try {
    const out = await runCapture(adb, ['-s', deviceId, 'shell', "dumpsys window displays | grep -m1 -o 'mRotation=[0-9]'"], { timeout: 8000 });
    const m = /mRotation=(\d)/.exec(out);
    if (!m) return { size: wmSize, rotation: null };
    const rotation = Number(m[1]);
    return rotation % 2 === 1 ? { size: `${natural.h}x${natural.w}`, rotation } : { size: wmSize, rotation };
  } catch {
    return { size: wmSize, rotation: null };
  }
}

/**
 * Decide the recording geometry BEFORE the flow runs. Returns `{ pinned, sizeProbe }`: `pinned` is
 * the `--size` to hand screenrecord (null = its default, i.e. native), and `sizeProbe` is what goes
 * in the sidecar. Throws (a DEVICE-phase failure: nothing filmed, no sidecar) when the size asked
 * for is malformed, cannot be recorded, differs in aspect from the device's, or is accepted but
 * really letterboxed. A size is USABLE here when the encoder takes it AND screenrecord's own
 * content-area line says the picture is the whole frame or short of it by at most CROP_TOLERANCE_PX
 * per axis (planCrop): that residue is float truncation, and the finishing encode trims it. The walk
 * takes the LARGEST usable size; exact-fill sizes are not required, because on a tall AVD they cost
 * half the resolution (see the SIZE header). An INCONCLUSIVE probe is asked again (SIZE_PROBE_ATTEMPTS,
 * SIZE_PROBE_RETRY_PAUSE_MS apart); a size still unanswered after that THROWS, the same DEVICE-phase
 * failure, because every route that filmed anyway was a guess, and after a refused native the guess
 * was a guaranteed 720x1280 fallback (see UNANSWERED PROBES in the SIZE header). Nothing here ever
 * returns native (`pinned: null`) unless native's own probe said it is usable. `nativeSize` is
 * the display in its CURRENT orientation (deviceOrientedSize); `bitRate` is the recorder's, so the
 * probe and the take cannot disagree.
 */
export async function resolveRecordingSize(adb, deviceId, { requested, nativeSize, bitRate = DEFAULT_BIT_RATE, probeFile = null }) {
  const started = Date.now();
  const deviceFile = probeFile ?? probeDeviceFile(runTagOf(started));
  let nativeStr = nativeSize;
  let native = parseSize(nativeStr);
  const probes = [];
  const cache = new Map();
  const areaText = (p) => (p.content ? `${p.content.w}x${p.content.h}@${p.content.x},${p.content.y}` : null);
  const verdict = (p) =>
    p.accepted === true
      ? { fill: 'accepted (fills)', crop: 'accepted (crop)', letterbox: 'accepted (letterboxed)' }[p.plan.kind] ?? 'accepted'
      : p.accepted === false
        ? 'refused'
        : `inconclusive (exit ${p.exitCode ?? 'none'})`;
  // One size, asked until it answers: accepted/refused is a verdict and ends it; INCONCLUSIVE (adb or the
  // recorder failed for a reason that says nothing about the size) is asked again after a pause, up to
  // SIZE_PROBE_ATTEMPTS in all. Every attempt is a row in `probes` (`attempt` numbers them) and a line on
  // the console, so a retried probe is visible in both. The answer, final or unanswered, is cached.
  const probe = async (size) => {
    if (cache.has(size)) return cache.get(size);
    let p;
    for (let attempt = 1; ; attempt++) {
      p = await probeRecorderSize(adb, deviceId, size, bitRate, deviceFile);
      probes.push({ size: p.size, attempt, accepted: p.accepted, fit: p.accepted ? p.plan.kind : null, content: areaText(p), exitCode: p.exitCode, elapsedMs: p.elapsedMs, note: p.note });
      if (p.accepted !== null) {
        if (attempt > 1) log(`the size probe for ${size} answered on attempt ${attempt} of ${SIZE_PROBE_ATTEMPTS}: ${verdict(p)}`);
        break;
      }
      if (attempt >= SIZE_PROBE_ATTEMPTS) {
        console.error(`[film-android] ⚠️  the size probe for ${size} was inconclusive again (${p.note}), attempt ${attempt} of ${SIZE_PROBE_ATTEMPTS} — giving up on it.`);
        break;
      }
      console.error(
        `[film-android] ⚠️  the size probe for ${size} was inconclusive (${p.note}), attempt ${attempt} of ${SIZE_PROBE_ATTEMPTS} — ` +
          `asking again in ${(SIZE_PROBE_RETRY_PAUSE_MS / 1000).toFixed(1)}s.`,
      );
      await sleep(SIZE_PROBE_RETRY_PAUSE_MS);
    }
    cache.set(size, p);
    return p;
  };
  // Every probe in order, one line: what the walk actually saw, for the console (the sidecar has the rows).
  const trail = () => probes.map((r) => `${r.size}${r.attempt > 1 ? ` attempt ${r.attempt}` : ''} ${verdict({ ...r, plan: { kind: r.fit } })}`).join('; ');
  // A size the probe could not answer, SIZE_PROBE_ATTEMPTS times over: stop here, before anything is installed,
  // cleared or filmed (main's setup catch: exit 1, no take, no sidecar). `why` says what filming anyway would have meant.
  const unanswered = (p, why) =>
    new Error(
      `the recorder's size probe isn't answering: ${p.size} was inconclusive ${SIZE_PROBE_ATTEMPTS} times, ` +
        `${(SIZE_PROBE_RETRY_PAUSE_MS / 1000).toFixed(1)}s apart (last: ${p.note}). ${why} Nothing was filmed; rerun. ` +
        `If it keeps happening, check that nothing else on ${deviceId} is deleting files in ${DEVICE_DIR} or signalling screenrecord, ` +
        `and that adb answers (adb -s ${deviceId} shell true).`,
    );
  const usable = (p) => p.accepted === true && p.plan.kind !== 'letterbox';
  const done = (pinned, chosen, source, plan = null) => ({
    pinned,
    sizeProbe: {
      native: nativeStr ?? null,
      requested: requested ?? null,
      chosen,
      pinned: pinned !== null,
      source,
      // what the chosen size's own probe said the finishing encode will trim (null = nothing/unknown)
      crop: plan?.kind === 'crop' ? plan.crop : null,
      probeCount: probes.length,
      // attempts past the first, over all sizes: >0 means some probe was inconclusive and asked again
      retries: probes.filter((r) => r.attempt > 1).length,
      probes,
      elapsedSec: Number(((Date.now() - started) / 1000).toFixed(2)),
    },
  });
  // The largest usable size in `sizes` (descending). Acceptance is a height cap, so it is monotonic
  // down the list: a binary search finds the first accepted rung in ~log2(N) probes (a refusal costs
  // ~0.1s, an accepted probe ~1.3s), then at most SIZE_CROP_WALK_MAX rungs are probed in order for the
  // first whose content area is croppable (nearly always the first). Total probes stay bounded on any
  // geometry however long the list. A probe still inconclusive after its retries ends the walk without a
  // verdict (`unanswered`); the caller decides what that costs.
  const walk = async (sizes) => {
    let lo = 0;
    let hi = sizes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const p = await probe(sizes[mid]);
      if (p.accepted === null) return { hit: null, plan: null, unanswered: p };
      if (p.accepted) hi = mid;
      else lo = mid + 1;
    }
    for (let i = lo, tried = 0; i < sizes.length && tried < SIZE_CROP_WALK_MAX; i++, tried++) {
      const p = await probe(sizes[i]);
      if (p.accepted === null) return { hit: null, plan: null, unanswered: p };
      if (usable(p)) return { hit: sizes[i], plan: p.plan, unanswered: null };
    }
    return { hit: null, plan: null, unanswered: null };
  };
  const cropText = (plan) => (plan.kind === 'crop' ? `; it will be cropped to ${plan.crop.w}x${plan.crop.h} (${plan.reason})` : '');

  if (requested) {
    const rq = parseSize(requested);
    if (!rq || rq.w <= 0 || rq.h <= 0) {
      throw new Error(`--size "${requested}" is malformed: it must be <width>x<height>, both positive whole numbers (for example 1080x2400)`);
    }
    if (native && !sameAspect(requested, nativeStr)) {
      throw new Error(
        `--size ${requested} does not keep the device's aspect (${nativeStr}): screenrecord would letterbox it and ` +
          'the take would have bars. Pass a size at the device aspect ratio, or omit --size and let filmkit pick the largest one ' +
          'the encoder accepts.',
      );
    }
    const p = await probe(requested);
    if (p.accepted === null) {
      throw unanswered(p, `Filming --size ${requested} unverified would leave a refusal or a letterbox to fail the take after the flow had run.`);
    }
    if (usable(p)) {
      log(`--size ${requested}: the encoder accepts it (${(p.elapsedMs / 1000).toFixed(1)}s probe)${cropText(p.plan)}`);
      return done(requested, requested, 'explicit-verified', p.plan);
    }
    // Refused, or accepted but really letterboxed: either way name the largest size that does work.
    const smaller = native
      ? aspectLadder(native.w, native.h).filter((r) => {
          const c = parseSize(r);
          return c.w * c.h < rq.w * rq.h;
        })
      : [];
    const found = await walk(smaller);
    // The refusal is a verdict either way; an unanswered probe only cuts the search for a suggestion short.
    const suggestion = found.hit
      ? `the largest usable size the probe found below it is ${found.hit}`
      : found.unanswered
        ? `the search for a smaller usable size stopped: the probe for ${found.unanswered.size} was inconclusive ${SIZE_PROBE_ATTEMPTS} times (${found.unanswered.note})`
        : 'no smaller usable size was found either';
    throw new Error(
      p.accepted
        ? `--size ${requested} is accepted by the encoder but screenrecord letterboxes it: ${p.plan.reason}; ${suggestion}`
        : `--size ${requested} was refused by the encoder (${p.note}); ${suggestion}`,
    );
  }

  if (!native) {
    console.error('[film-android] ⚠️  the device size is unreadable (`wm size`), so no size was probed — filming at screenrecord\'s default.');
    return done(null, null, 'skipped-no-native-size');
  }
  // Native first (recorded without --size when it works, i.e. bit-identical to before), then the
  // near-aspect sizes below it.
  let first = await probe(nativeStr);
  // The recorder says what the display really is. If that is the swapped shape (the rotation read was
  // wrong or stale), adopt it and start again: every size below is built from it.
  if (first.display && native && (first.display.w !== native.w || first.display.h !== native.h) && first.display.w === native.h && first.display.h === native.w) {
    log(`the recorder reports the display as ${first.display.w}x${first.display.h} (rotation ${first.display.rotation}), not ${nativeStr} — using that`);
    nativeStr = `${first.display.w}x${first.display.h}`;
    native = parseSize(nativeStr);
    first = await probe(nativeStr);
  }
  if (first.accepted === null) {
    throw unanswered(first, `Filming at native ${nativeStr} unverified would be a guess (on a device whose encoder refuses it, a silent 720x1280 fallback that fails the take).`);
  }
  if (usable(first)) {
    log(`native size ${nativeStr} is filmable (${(first.elapsedMs / 1000).toFixed(1)}s probe)${cropText(first.plan)}`);
    return done(null, nativeStr, 'native-accepted', first.plan);
  }
  log(
    first.accepted
      ? `native size ${nativeStr} is accepted but letterboxed (${first.note}) — walking down...`
      : `the encoder refuses the native size ${nativeStr} (${first.note}) — walking down aspect-preserving sizes...`,
  );
  const found = await walk(aspectLadder(native.w, native.h));
  log(`size probes: ${trail()}`);
  if (found.unanswered) {
    // Never native here: native's own probe just said it is not filmable, so filming at native records
    // screenrecord's silent 720x1280 fallback (see SIZE) and fails the take after the whole flow.
    throw unanswered(
      found.unanswered,
      `Native ${nativeStr} was ${first.accepted ? 'letterboxed' : 'refused'}, so filming at native would record a ${first.accepted ? 'letterboxed' : 'silent 720x1280 fallback'} take.`,
    );
  }
  if (found.hit) {
    const took = probes.length;
    log(
      `recording at ${found.hit}, the largest size the encoder accepts (${took} probe${took === 1 ? '' : 's'}, ` +
        `${((Date.now() - started) / 1000).toFixed(1)}s; native ${nativeStr} is not filmable on this device)${cropText(found.plan)}`,
    );
    return done(found.hit, found.hit, 'probed', found.plan);
  }
  throw new Error(
    `no size at the device's ${nativeStr} aspect both encodes and keeps the letterbox within ${CROP_TOLERANCE_PX}px (${probes.length} probes) ` +
      '— this device cannot be filmed cleanly',
  );
}

// ── SHOW_TAPS: where a device pixel lands in the recorded picture ────────────────────────────
// screenrecord scales the display into the video and CENTRES it, so a video whose aspect does
// not match the device's has bars, and a ring drawn at (deviceX * videoW/deviceW) sits in one of
// them. `--verbose` states the content rectangle outright; when it is missing the same
// fit-and-centre it performs is recomputed here (checked against the real thing on this
// emulator: 1344x2992 into 720x1280 → 574x1280 at x=73, exactly what screenrecord printed).
export function contentRect({ contentArea, videoWidth, videoHeight, deviceWidth, deviceHeight }) {
  if (contentArea) return { ...contentArea, source: 'screenrecord --verbose' };
  if (!(videoWidth > 0 && videoHeight > 0 && deviceWidth > 0 && deviceHeight > 0)) return null;
  const scale = Math.min(videoWidth / deviceWidth, videoHeight / deviceHeight);
  const w = Math.floor(deviceWidth * scale);
  const h = Math.floor(deviceHeight * scale);
  return { w, h, x: Math.round((videoWidth - w) / 2), y: Math.round((videoHeight - h) / 2), source: 'fit-and-centre' };
}

// Wall clock of video time 0.000 for one segment, and how that was arrived at. The anchor is the
// whole ballgame: get it wrong by a second and every ring in that segment is on the wrong screen.
//
// The line is only believed if it arrived when a line printed before the capture loop plausibly
// could. `adb shell` gives screenrecord a pty, which is line-buffered — that is why the arrival
// time means anything at all — but a device that block-buffers instead would hand over the whole
// of stdout when the buffer filled or when the process exited, i.e. up to a whole segment late.
// Every tap would then map to a negative time and be dropped as "no segment was recording then":
// silent, total, and indistinguishable from a flow that never tapped. Measured arrivals are
// 365–746 ms after spawn on a cold `adb shell` and ~85 ms on a warm chained one, so 2 s is far
// outside anything real and unmistakably inside a buffering failure.
export const ANCHOR_LINE_MAX_LAG_MS = 2000;

export function segmentAnchor(seg) {
  const lagMs = seg.contentAreaAt === null || seg.contentAreaAt === undefined ? null : seg.contentAreaAt - seg.startedAt;
  if (lagMs !== null && lagMs <= ANCHOR_LINE_MAX_LAG_MS) {
    return {
      videoZeroWallMs: seg.contentAreaAt - CONTENT_LINE_TO_VIDEO_ZERO_MS,
      source: 'screenrecord "Content area" line',
      note: null,
    };
  }
  return {
    videoZeroWallMs: seg.startedAt + SPAWN_TO_VIDEO_ZERO_MS,
    source: `spawn + ${SPAWN_TO_VIDEO_ZERO_MS}ms`,
    note:
      lagMs === null
        ? 'screenrecord printed no "Content area" line'
        : `screenrecord's "Content area" line arrived ${lagMs}ms after spawn, past the ${ANCHOR_LINE_MAX_LAG_MS}ms ` +
          'this device could plausibly take to start capturing — its stdout is buffered, so the line says nothing ' +
          'about when video time 0 was',
  };
}

/**
 * One line for `tapSync.anchor` describing what the segments really hung off. Before the timeline
 * exists (a run that never got that far) the only honest answer is what the recorder was asked
 * for, which is what `recorderVerbose` carries.
 */
export function anchorSummary(timeline, recorderVerbose) {
  if (timeline.length === 0) {
    return recorderVerbose ? 'screenrecord "Content area" line (no segment reached)' : `spawn + ${SPAWN_TO_VIDEO_ZERO_MS}ms (no --verbose)`;
  }
  const sources = [...new Set(timeline.map((slot) => slot.anchorSource))];
  if (sources.length === 1) return sources[0];
  const fellBack = timeline.filter((slot) => slot.anchorNote).map((slot) => slot.tag);
  return `mixed: ${sources.join(' / ')} — ${fellBack.join(', ')} fell back`;
}

/**
 * Wall-clock touches → (x, y, tSec) in the stitched video.
 *
 * `timeline` is one entry per segment that made it into the file, in order: its anchor, the slot
 * it occupies (`offsetSec`, and `spanSec` = null for the last one, which plays to the end), its
 * chain `index` and its tag for the diagnostics. A tap belongs to the segment whose window contains it.
 *
 * SEAM HANDOVERS. A tap in the gap between one kept slot's end and the NEXT segment's video zero (the
 * handover, 0.35-0.59s at steady state, see CAP / SEGMENT CHAIN) happened, and the screen's answer to it is
 * on the next segment's first frames: nothing of it is lost but the instant itself. So its ring starts on
 * the first frame after the gap, `seamShiftSec` late (the gap's remainder after the tap), and a long press
 * loses that much of its hold. Measured before: a tap 0.135s before seg004's first frame was dropped as "no
 * segment was recording then", and the take, its only tap undrawn, failed as `taps-missing`. Only a gap
 * whose two sides are consecutive segments of the chain is a handover: a gap with a LOST segment in it, the
 * time before the first kept slot and anything past the file's end are footage that is truly not there, and
 * a tap in them is dropped with the reason (`lost` names the lost segment(s) when one is known).
 */
export function mapTapsToVideo({ taps, timeline, rect, deviceWidth, deviceHeight, lastSec }) {
  const scaleX = rect.w / deviceWidth;
  const scaleY = rect.h / deviceHeight;
  const drawn = [];
  const dropped = [];
  const clamped = [];
  const shifted = [];
  for (const tap of taps) {
    let placed = null;
    for (const [i, slot] of timeline.entries()) {
      const intoSec = (tap.wallMs - slot.videoZeroWallMs) / 1000;
      if (intoSec < 0) continue;
      if (slot.spanSec !== null && intoSec > slot.spanSec) {
        // Past this slot. In the handover before the next one?
        const next = timeline[i + 1];
        if (!next || tap.wallMs >= next.videoZeroWallMs) continue;
        const handover = slot.index == null || next.index == null || next.index === slot.index + 1;
        if (!handover) {
          const lostTags = [];
          for (let n = slot.index + 1; n < next.index; n++) lostTags.push(segTag(n));
          placed = { lost: lostTags.join(', ') };
          break;
        }
        placed = { slot: next, tSec: next.offsetSec, shiftSec: (next.videoZeroWallMs - tap.wallMs) / 1000, after: slot };
        break;
      }
      placed = { slot, tSec: slot.offsetSec + intoSec, shiftSec: 0 };
      break;
    }
    if (placed === null || placed.lost || placed.tSec > lastSec) {
      dropped.push({
        tap,
        reason:
          placed === null
            ? 'no segment was recording then'
            : placed.lost
              ? `in footage lost with ${placed.lost}`
              : 'past the end of the video',
      });
      continue;
    }
    // A 3-second hold that starts a second before a seam does not continue across it: the rest of
    // that press happened while no recorder was running, and the next segment's footage is of
    // something else. Painting a frozen ring over it would be inventing a finger. The hold is cut
    // at its own segment's end, where the ripple then breaks — which is also what the footage
    // shows, since the seam is where the picture stops. A press that started in a handover keeps
    // what is left of it once the next segment's picture begins.
    const slotEndSec = placed.slot.spanSec === null ? lastSec : placed.slot.offsetSec + placed.slot.spanSec;
    const room = Math.max(0, Math.min(slotEndSec, lastSec) - placed.tSec);
    const wanted = Math.max(0, (tap.holdSec || 0) - placed.shiftSec);
    const holdSec = Math.min(wanted, room);
    if (wanted > holdSec + 0.001) clamped.push({ tap, wanted, holdSec, segment: placed.slot.tag });
    const ring = {
      x: rect.x + tap.xPt * scaleX,
      y: rect.y + tap.yPt * scaleY,
      tSec: placed.tSec,
      holdSec,
      segment: placed.slot.tag,
    };
    if (placed.shiftSec > 0) {
      ring.seamShiftSec = Number(placed.shiftSec.toFixed(3));
      shifted.push({ tap, segment: placed.slot.tag, after: placed.after.tag, shiftSec: placed.shiftSec });
    }
    drawn.push(ring);
  }
  return { drawn, dropped, clamped, shifted };
}

// ── FOREGROUND WATCHDOG: who is actually on screen while the camera rolls ────────────────────
// See the header for the policy and for what was measured. This half is just the mechanics.

// `topResumedActivity=ActivityRecord{69542266 u0 com.example.app/.MainActivity t104}` — the leading
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

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extraAllowPatterns(extraAllow) {
  return (extraAllow ?? []).map((pkg) => new RegExp(`^${escapeRegExp(pkg)}($|\\.)`));
}

export function isAllowedOverlay(pkg, extraAllow = []) {
  if (FOREGROUND_ALLOW.some((pattern) => pattern.test(pkg))) return true;
  return extraAllowPatterns(extraAllow).some((pattern) => pattern.test(pkg));
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

// The device's home (launcher) package: the activity HOME resolves to, read off the device rather than
// named here (every launcher is a different package). null if the device will not say.
async function resolveHomePackage(adb, deviceId) {
  try {
    const out = await runCapture(adb, [
      '-s', deviceId, 'shell', 'cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME',
    ]);
    const line = out.trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
    const m = /^([A-Za-z0-9_.]+)\/[A-Za-z0-9_.$]+$/.exec(line);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// ── THE APP'S OWN RELAUNCH (see the header) ─────────────────────────────────────────────────
// How long after the guarded app's launchApp command ends its window stays open. Measured with ~11ms
// foreground polling around `maestro test` (launchApp of an app already in front, Maestro 2.6): Settings
// was back on top 359-471ms after the command's COMPLETED line (5 runs), Chrome 119-361ms (4 runs).
const RELAUNCH_GRACE_MS = 1500;
// maestro.log stamps are this process's clock to the millisecond, but a sample is taken over an adb round
// trip; this much slack on the window's opening edge.
const RELAUNCH_SKEW_MS = 100;

// `13:11:22.492` carries no date: resolve it against `nearEpoch`'s day, sliding a day either way when that
// lands more than 12h off (a take filmed across midnight). Same rule as lib/tap-overlay.mjs's hmsToEpoch.
function logStampToEpoch(stamp, nearEpoch) {
  const [h, m, rest] = stamp.split(':');
  const [s, ms] = rest.split('.');
  const d = new Date(nearEpoch);
  d.setHours(Number(h), Number(m), Number(s), Number(ms));
  let e = d.getTime();
  while (e - nearEpoch > 12 * 3600_000) e -= 24 * 3600_000;
  while (nearEpoch - e > 12 * 3600_000) e += 24 * 3600_000;
  return e;
}

// Every launch of `pkg` maestro.log records: [{ startMs, endMs }] (endMs null while it runs). The start is
// Maestro's own `Launching app <pkg>` line (maestro.Maestro.launchApp, written before it stops the app,
// whatever `label:` the step has); the end is the first command status line after it (COMPLETED, FAILED,
// WARNED). Pure.
export function parseAppLaunches(logText, pkg, nearEpoch) {
  const start = new RegExp(`^(\\d{1,2}:\\d{2}:\\d{2}\\.\\d{3}) \\[\\s*\\w+\\].*: Launching app ${escapeRegExp(pkg)}\\s*$`);
  const status = /^(\d{1,2}:\d{2}:\d{2}\.\d{3}) \[\s*\w+\].*\s(COMPLETED|FAILED|WARNED)\s*$/;
  const launches = [];
  let open = null;
  for (const line of String(logText).split('\n')) {
    const s = start.exec(line);
    if (s) {
      open = { startMs: logStampToEpoch(s[1], nearEpoch), endMs: null };
      launches.push(open);
      continue;
    }
    const e = open ? status.exec(line) : null;
    if (e) {
      open.endMs = logStampToEpoch(e[1], nearEpoch);
      open = null;
    }
  }
  return launches;
}

// Is a sighting taken at `atMs` inside one of those launches' windows: [start - skew, end + grace], open
// on the right while the command still runs? Pure.
export function inRelaunchWindow(atMs, launches, { graceMs = RELAUNCH_GRACE_MS, skewMs = RELAUNCH_SKEW_MS } = {}) {
  return launches.some(({ startMs, endMs }) => atMs >= startMs - skewMs && (endMs === null || atMs <= endMs + graceMs));
}

// `guardedSeen`: the guarded app has been in front at least once in this take. Until then the home
// activity is `home-before-app`, not an interloper (see LAUNCHER BEFORE THE APP in the header).
function classify(sighting, guardedApp, extraAllow = [], { homePackage = null, guardedSeen = false } = {}) {
  if (sighting.verdict === 'unknown') return 'unknown';
  if (sighting.package === guardedApp) return 'guarded';
  if (!guardedSeen && homePackage && sighting.package === homePackage) return 'home-before-app';
  return isAllowedOverlay(sighting.package, extraAllow) ? 'allowed' : 'interloper';
}

// Polls until stop(). `events` only grows when the answer CHANGES, so a five-minute take that was
// never disturbed contributes exactly one row (the guarded app, at t≈0) instead of two hundred.
// `relaunchWindow(atMs)` (async, optional): is `atMs` inside the guarded app's own launchApp window (see THE
// APP'S OWN RELAUNCH in the header)? Asked only for a sighting that would otherwise be an interloper.
function startForegroundWatch(adb, deviceId, { guardedApp, extraAllow = [], homePackage = null, startedAt, onInterloper, relaunchWindow = null }) {
  const events = [];
  const interlopers = [];
  let guardedSeen = false; // once true, the launcher is an interloper like any other app
  let stopped = false;
  let timer = null;
  let last = null; // "<package>/<activity>" of the previous sample, or 'unknown'
  let lastVerdict = null; // the verdict recorded for `last`
  let unknownRun = 0;
  let unknownWarned = false;

  const atSec = () => Number(((Date.now() - startedAt) / 1000).toFixed(2));

  const sampleOnce = async () => {
    const sampledAt = Date.now();
    const sighting = await readForeground(adb, deviceId);
    let verdict = classify(sighting, guardedApp, extraAllow, { homePackage, guardedSeen });
    // The app's own relaunch: whatever is under it while launchApp restarts it is not an interloper, inside
    // the command's window only (maestro.log is read here, and only here, so a clean take never reads it).
    if (verdict === 'interloper' && relaunchWindow && (await relaunchWindow(sampledAt).catch(() => false))) verdict = 'relaunch';
    const seenBefore = guardedSeen; // for the live line: "back to" only means something on a return
    if (verdict === 'guarded') guardedSeen = true;
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

    // The same screen as last time is no news, except a `relaunch` sighting that outlived its window: the
    // app did not come back, so what is in front is judged again (an interloper now).
    if (key === last && !(lastVerdict === 'relaunch' && verdict !== 'relaunch')) return;
    const rejudged = key === last; // the same screen, first seen inside the relaunch window
    last = key;
    lastVerdict = verdict;
    const previous = events[events.length - 1] ?? null;
    const event = { atSec: atSec(), package: sighting.package, activity: sighting.activity ?? null, verdict };
    // when this screen was really first seen (the `relaunch` row before it), so the timestamp is not late
    if (rejudged && previous) event.firstSeenSec = previous.atSec;
    if (sighting.note) event.note = sighting.note;
    events.push(event);

    if (verdict === 'interloper') {
      interlopers.push(event);
      console.error(
        `\n[foreground] INTERLOPER ${event.package} at ${event.atSec}s` +
          (event.firstSeenSec !== undefined ? ` (in front since ${event.firstSeenSec}s, inside ${guardedApp}'s relaunch window then)` : '') +
          ' — ' +
          `${event.package}/${event.activity} is in front of ${guardedApp}. ` +
          'Whatever the flow reports, this take is covered from here.\n',
      );
      onInterloper?.(event);
    } else if (verdict === 'allowed') {
      log(`[foreground] ${event.package} at ${event.atSec}s (system surface — allowed)`);
    } else if (verdict === 'relaunch') {
      log(`[foreground] ${event.package} at ${event.atSec}s — under ${guardedApp} while its own launchApp restarts it (allowed)`);
    } else if (verdict === 'home-before-app') {
      log(`[foreground] ${event.package} (the home screen) at ${event.atSec}s — allowed until ${guardedApp} is first in front`);
    } else if (verdict === 'guarded' && previous && previous.verdict !== 'guarded') {
      // Only a change OF APP is news. "back to" only when the app had been in front before and something
      // else was in between; its first appearance after the home screen or an unreadable sample says so;
      // and a move between the app's own activities (Settings -> SubSettings) is a row in `foreground`,
      // not a line. Measured before: "back to com.android.settings at 14.68s" was printed for the app's
      // first sighting and again for every change of its own activity.
      log(
        seenBefore
          ? `[foreground] back to ${event.package} at ${event.atSec}s`
          : `[foreground] ${event.package} is in front at ${event.atSec}s`,
      );
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

function startSegmentChain(adb, deviceId, { deviceBase, bitRate, size, segmentSeconds, verbose }) {
  const segments = [];
  let stopped = false;
  let abortReason = null;
  // RECORDER DEATH AFTER THE FLOW (see the header): the wall instant the flow ended on its own (maestro's last
  // attempt exited without a signal), set by main through markFlowEnded(). A recorder that dies at or after it
  // died in the tail hold: the flow is on camera up to its end, so the abort cuts nothing off the flow.
  let flowEndedAt = null;
  let abortSeg = null;
  const diedAfterFlow = () =>
    abortSeg !== null && flowEndedAt !== null && abortSeg.wallSec !== null && abortSeg.startedAt + abortSeg.wallSec * 1000 >= flowEndedAt;
  // Composed when READ, so a death the chain saw a moment before main marked the flow's end is still judged
  // on the two timestamps, not on which event the loop happened to process first. It states WHEN the recorder
  // died against the flow, never what that cost the take: a death after the flow cut nothing off it, yet a
  // SIGKILLed recorder's file has no moov atom and its footage up to the flow's end is lost. That is judged
  // once the segment is pulled (harvest's RECORDER DEATH line), never here.
  const describeAbort = () =>
    abortReason === null
      ? null
      : abortReason +
        (diedAfterFlow()
          ? `, ${((abortSeg.startedAt + abortSeg.wallSec * 1000 - flowEndedAt) / 1000).toFixed(2)}s after the flow had ended (in the tail hold)`
          : '; the rest of the flow is NOT on camera');

  const spawnSegment = (index) => {
    const tag = segTag(index);
    const devicePath = `${DEVICE_DIR}/${deviceBase}-${tag}.mp4`;
    const startedAt = Date.now();
    const child = spawn(
      adb,
      [
        '-s', deviceId, 'shell', 'screenrecord',
        '--bit-rate', bitRate,
        // Costs nothing on the recording and buys the tap anchor and the exact content
        // rectangle. See the SHOW_TAPS header; the flag is probed for before it is used.
        ...(verbose ? ['--verbose'] : []),
        ...(size ? ['--size', size] : []),
        '--time-limit', String(segmentSeconds),
        devicePath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const seg = {
      index, tag, devicePath, startedAt, wallSec: null, exitCode: null, signal: null, limitSec: segmentSeconds,
      stderr: [], stdout: [], contentArea: null, contentAreaAt: null,
    };

    // screenrecord's --verbose narration goes to STDOUT (its diagnostics go to stderr, below).
    // Only the content-area line is echoed — the rest is provenance, kept in the sidecar. The
    // ARRIVAL TIME of that line, not the line itself, is what anchors this segment's tap times,
    // so it is stamped the moment the chunk lands rather than parsed out of anything on-device.
    let pendingOut = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const at = Date.now();
      pendingOut += chunk;
      const lines = pendingOut.split(/\r?\n/);
      pendingOut = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        seg.stdout.push(line.trim());
        const area = CONTENT_AREA_RE.exec(line);
        if (area && seg.contentAreaAt === null) {
          seg.contentArea = { w: Number(area[1]), h: Number(area[2]), x: Number(area[3]), y: Number(area[4]) };
          seg.contentAreaAt = at;
          console.log(
            `[screenrecord] ${tag}: content area ${seg.contentArea.w}x${seg.contentArea.h} ` +
              `at (${seg.contentArea.x},${seg.contentArea.y})`,
          );
        }
      }
    });

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
      // One vocabulary for a recorder's end (recorderEnding): this line, the abort, the drop reason and the
      // sidecar's `error` all say it the same way. Measured before: the abort said "ended on its own ... (exit
      // 137)" while the drop reason said "killed on the device by SIGKILL".
      const ending = recorderEnding(seg);
      if (stopped) {
        log(`${seg.tag} ended: ${ending}`);
        break;
      }
      // A healthy segment runs its whole time limit. Ending early on its own means screenrecord
      // itself failed (bad --size, no space, encoder gone) — respawning in a tight loop would
      // just spin, so the chain stops and the run is reported as truncated rather than silently
      // filming nothing for the rest of the flow.
      const limitMs = segmentSeconds * 1000;
      if (seg.spawnError || seg.exitCode !== 0 || seg.wallSec * 1000 < limitMs - SEGMENT_EARLY_EXIT_TOLERANCE_MS) {
        // The recorder died while the chain was live: whatever it did not write is lost footage, however
        // short its life (selectSegments never calls such a segment an empty tail).
        seg.endedOnItsOwn = true;
        abortSeg = seg;
        abortReason = `${seg.tag} ended unexpectedly: ${ending}`;
        // The FACT only. Whether it cut the flow, and what it cost, is judged once, in harvest (it depends on
        // the flow's end, which main may mark a moment later, and on whether the file survived).
        console.error(`[film-android] ⚠️  ${abortReason} — the chain stops here, no recorder is rolling from now on`);
        break;
      }
      log(`${seg.tag} ended: ${ending}`);
    }
  }

  // SIGINT on the local `adb shell` client forwards a Ctrl-C to the remote pty, which is what
  // makes the on-device `screenrecord` process finalize its mp4 container instead of leaving
  // it truncated — killing the local process outright (SIGKILL/SIGTERM) does not do this.
  async function doStop() {
    stopped = true;
    const live = segments[segments.length - 1];
    // `wallSec === null`: not exited yet (a recorder that died on a signal has exitCode null too). The
    // stamp is what makes this segment's end OURS: selectSegments only ever drops a dead trailing segment
    // as an empty tail when the stop was asked for before it ended.
    if (live && live.wallSec === null && !live.spawnError) {
      live.stopRequestedAt = Date.now();
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
      if (live) live.killedByUs = true;
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
      return describeAbort();
    },
    // Did the abort cut the flow short? False when the recorder died after the flow had ended (the tail hold):
    // then it is not a truncation, and the take is judged on what was written up to the flow's end.
    get abortCutFlow() {
      return abortReason !== null && !diedAfterFlow();
    },
    markFlowEnded(ms) {
      flowEndedAt = ms;
    },
    // The wall instant the flow ended on its own (markFlowEnded), or null.
    get flowEndedAt() {
      return flowEndedAt;
    },
    // The segment whose recorder ended without our stop (the chain's abort), or null.
    get abortSeg() {
      return abortSeg;
    },
    // A recorder process is running right now (the last segment has not exited), whatever stop() asked.
    get recorderRunning() {
      const last = segments[segments.length - 1];
      return Boolean(last && last.wallSec === null && !last.spawnError);
    },
    // A recorder is (or is about to be) rolling: not stopped, and the chain did not give up.
    get live() {
      return !stopped && !abortReason;
    },
    stop() {
      stopPromise ??= doStop();
      return stopPromise;
    },
  };
}

// ── TAIL HOLD: roll on after the flow until the encoder has written it (see the header) ──────────
// Which encoder the live screenrecord holds, read off the media resource manager (the block for each
// client pid names its codec), and whether it is a software codec hosted in `media.swcodec`, the one
// process whose CPU time says when the encoder has nothing left to encode. Anything else (a hardware
// encoder, an older Android, an unreadable dump) is { watchable: false } and the hold is fixed.
export function parseRecorderEncoder(text) {
  const lines = String(text).split('\n').map((line) => line.trim());
  const recorderPids = (lines.find((l) => l.startsWith('SR ')) ?? '').slice(3).split(/\s+/).filter(Boolean);
  const codecPid = (lines.find((l) => l.startsWith('SW ')) ?? '').slice(3).trim().split(/\s+/)[0] || null;
  let pid = null;
  let encoder = null;
  for (const line of lines) {
    const p = /^Pid:\s*(\d+)/.exec(line);
    if (p) {
      pid = p[1];
      continue;
    }
    const n = /^Name:\s*(\S+)/.exec(line);
    if (n && pid && recorderPids.includes(pid) && /encoder/i.test(n[1])) encoder = n[1];
  }
  if (recorderPids.length === 0) return { watchable: false, encoder: null, codecPid, note: 'no screenrecord process was running' };
  if (!encoder) return { watchable: false, encoder: null, codecPid, note: "the media resource manager did not name screenrecord's encoder" };
  // c2.android.* (Codec2) and OMX.google.* are AOSP's software codecs; on Android 10+ they run in media.swcodec.
  const software = /^(c2\.android\.|OMX\.google\.)/.test(encoder);
  if (!software) return { watchable: false, encoder, codecPid, note: `${encoder} is not a software codec; its progress cannot be read off a CPU clock` };
  if (!codecPid) return { watchable: false, encoder, codecPid, note: 'no media.swcodec process to watch' };
  return { watchable: true, encoder, codecPid, note: null };
}

async function probeRecorderEncoder(adb, deviceId) {
  try {
    const out = await runCapture(
      adb,
      ['-s', deviceId, 'shell', 'echo "SR $(pidof screenrecord)"; echo "SW $(pidof media.swcodec)"; dumpsys media.resource_manager | grep -E "Pid:|Name:"'],
      { timeout: ADB_CLEANUP_TIMEOUT_MS },
    );
    return parseRecorderEncoder(out);
  } catch (err) {
    return { watchable: false, encoder: null, codecPid: null, note: `the encoder probe failed: ${err.message}` };
  }
}

// Drained = the codec's utime+stime unchanged for TAIL_HOLD_IDLE_SAMPLES consecutive samples spanning at
// least TAIL_HOLD_IDLE_MIN_MS (pure; `samples` are { atMs, cpu } in arrival order).
export function encoderDrained(samples, { idleSamples = TAIL_HOLD_IDLE_SAMPLES, idleMinMs = TAIL_HOLD_IDLE_MIN_MS } = {}) {
  if (samples.length < idleSamples + 1) return false;
  const run = samples.slice(-(idleSamples + 1));
  return run.every((s) => s.cpu === run[0].cpu) && run[run.length - 1].atMs - run[0].atMs >= idleMinMs;
}

// The hold. Resolves { watch, encoder, note, endedBy, holdStartMs, holdEndMs, firstIdleMs, samples }:
// endedBy is drained | cap | fixed | interrupted | recorder-gone | watch-lost | rollover. `firstIdleMs` is the start of
// the first sample interval in which the codec did no work (its queue was empty then, so every frame written
// after it is of a change made after the flow), or null if it never idled. The CPU monitor is started at
// once, in parallel with the encoder probe, so its first sample lands as close to the flow's end as adb
// allows; an unwatchable encoder kills it and holds TAIL_HOLD_FALLBACK_MS. Never throws; the monitor child
// is always killed (and on process exit too: a remote `while` loop must not outlive the camera).
// ROLLOVER: the segment that was recording when the flow ended reached its own --time-limit during the hold.
// A time-limit stop discards the encoder's queue exactly as SIGINT does (the unwritten tail at every seam),
// and the next segment's codec instance starts idle, so watching on would read "drained" off a codec that
// never held the flow's last frames. The hold ends there, and only samples from before it count.
async function holdTail({ adb, deviceId, isLive, isInterrupted, flowSegmentEnded = () => false }) {
  const holdStartMs = Date.now();
  const samples = [];
  let firstIdleMs = null;
  let monitorEnded = false;
  let rolledOver = false;
  // `while cut ...`: the loop ends by itself if the codec process goes away or its stdout closes.
  const monitor = spawn(
    adb,
    ['-s', deviceId, 'shell', "p=$(pidof media.swcodec) && while cut -d' ' -f14,15 /proc/$p/stat; do sleep 0.05; done"],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const killMonitor = () => monitor.kill('SIGKILL');
  process.once('exit', killMonitor);
  let pending = '';
  monitor.stdout.setEncoding('utf8');
  monitor.stdout.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const [utime, stime] = line.trim().split(/\s+/).map(Number);
      if (!Number.isFinite(utime) || !Number.isFinite(stime)) continue;
      const sample = { atMs: Date.now(), cpu: utime + stime };
      if (rolledOver) continue;
      const prev = samples[samples.length - 1];
      if (firstIdleMs === null && prev && prev.cpu === sample.cpu) firstIdleMs = prev.atMs;
      samples.push(sample);
    }
  });
  monitor.on('error', () => (monitorEnded = true));
  monitor.on('exit', () => (monitorEnded = true));
  const probe = await probeRecorderEncoder(adb, deviceId);
  if (!probe.watchable) killMonitor();
  const result = {
    watch: probe.watchable ? 'codec-cpu' : 'fixed',
    encoder: probe.encoder,
    note: probe.note,
    endedBy: null,
    holdStartMs,
    holdEndMs: null,
    firstIdleMs: null,
    samples: 0,
  };
  try {
    for (;;) {
      const elapsed = Date.now() - holdStartMs;
      if (isInterrupted()) return finish('interrupted');
      if (!isLive()) return finish('recorder-gone');
      if (flowSegmentEnded()) {
        rolledOver = true;
        return finish('rollover');
      }
      if (probe.watchable && !monitorEnded) {
        if (encoderDrained(samples)) return finish('drained');
        if (elapsed >= TAIL_HOLD_CAP_MS) return finish('cap');
      } else if (elapsed >= TAIL_HOLD_FALLBACK_MS) {
        return finish(probe.watchable ? 'watch-lost' : 'fixed');
      }
      await sleep(25);
    }
  } finally {
    killMonitor();
    process.off('exit', killMonitor);
  }
  function finish(endedBy) {
    result.endedBy = endedBy;
    result.holdEndMs = Date.now();
    result.firstIdleMs = probe.watchable ? firstIdleMs : null;
    result.samples = samples.length;
    return result;
  }
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
  const codec = stderr.match(/Video:\s*(\w+)(?:\s*\(([^)]*)\))?/);
  const fps = stderr.match(/Video:[^\n]*?,\s*([\d.]+)\s*fps/);
  return {
    durationSec: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
    size: g ? `${g[1]}x${g[2]}` : null,
    // the banner's AVERAGE frame rate: low on VFR recorder footage, and that is normal
    fps: fps ? Number(fps[1]) : null,
    codec: codec ? { name: codec[1], profile: codec[2] ?? null } : null,
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
// The packet count is the other thing this probe is for: a dead recorder's file has no packets (or
// no readable container at all), and a STATIC one has exactly one (see STATIC SEGMENTS). Both must
// be told apart here rather than by ffmpeg failing halfway through a concat.
export async function probePackets(ffmpeg, path) {
  try {
    const { stdout } = await capture(ffmpeg, ['-v', 'error', '-i', path, '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', '-']);
    const rows = stdout.split('\n').filter((line) => /^\d+,/.test(line));
    const tb = stdout.match(/^#tb\s+\d+:\s*(\d+)\s*\/\s*(\d+)/m);
    const timebaseSec = tb && Number(tb[2]) > 0 ? Number(tb[1]) / Number(tb[2]) : null;
    if (rows.length === 0) return { count: 0, lastPts: null, lastDur: null, timebaseSec, pts: [] };
    const cols = rows[rows.length - 1].split(',').map((c) => Number(c.trim()));
    const [, lastPts, , lastDur] = cols;
    // Every packet's pts (stream ticks), for the TAIL HOLD's cut: where the take ends inside the final
    // segment, and which frame is the last one before it. screenrecord writes no B-frames (Constrained
    // Baseline), so pts order is decode order.
    const pts = rows.map((row) => Number(row.split(',')[1])).filter(Number.isFinite);
    return { count: rows.length, lastPts, lastDur, timebaseSec, pts };
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

// Where the segment's LAST packet starts, in seconds from the segment's own start (or null). The
// final-segment tail extension needs it to find that one packet again after the concat rebases it.
export function lastPtsSecOf(packets, containerSec) {
  if (!packets || packets.count === 0 || !Number.isFinite(packets.lastPts)) return null;
  const { lastPts, lastDur, timebaseSec } = packets;
  const tick = timebaseSec ?? (containerSec && lastPts + lastDur > 0 ? containerSec / (lastPts + lastDur) : null);
  return tick === null ? null : lastPts * tick;
}

// `tailExtend` (a CAPPED tail, see planStitch's RECORDING-END CAP): the last packet's duration is set so the file
// ends at the recorder's end, in the same stream copy (`setts`), every packet's data untouched.
export async function finalizeVideo(ffmpeg, rawPath, outPath, { verbose = false, crf = DEFAULT_CRF, tailExtend = null } = {}) {
  const quiet = verbose ? [] : ['-hide_banner', '-loglevel', 'error'];
  const setts = tailExtend ? ['-bsf:v', settsForTail(tailExtend)] : [];
  try {
    await run(ffmpeg, ['-y', ...quiet, '-i', rawPath, '-c', 'copy', ...setts, '-movflags', '+faststart', outPath], { stdio: 'inherit' });
  } catch (err) {
    log(`ffmpeg remux (stream copy) failed (${err.message}) — falling back to re-encode...`);
    const bound = tailExtend ? ['-t', (tailExtend.atSec + tailExtend.extSec).toFixed(3)] : [];
    await run(ffmpeg, ['-y', ...quiet, '-i', rawPath, ...bound, ...x264Args({ crf }), '-pix_fmt', 'yuv420p', outPath], { stdio: 'inherit' });
  }
}

async function trimRecording(ffmpeg, inPath, { trimHead = 0, trimTail = 0, verbose = false, crf = DEFAULT_CRF } = {}) {
  if (!(trimHead > 0) && !(trimTail > 0)) return { applied: false, reason: 'no trim requested' };
  const probed = await probeVideo(ffmpeg, inPath);
  const durationSec = probed.durationSec;
  if (!(durationSec > 0)) return { applied: false, reason: 'could not probe duration for trim' };
  const start = Math.max(0, trimHead);
  const length = durationSec - start - Math.max(0, trimTail);
  if (!(length > 0)) {
    throw new Error(`--trim-head ${trimHead}s + --trim-tail ${trimTail}s leaves nothing of a ${durationSec.toFixed(2)}s take`);
  }
  const quiet = verbose ? [] : ['-hide_banner', '-loglevel', 'error'];
  const tmp = `${inPath}.trim.mp4`;
  // Re-encode (not stream copy): VFR input + `-ss` before `-i` lands on the next emitted frame
  // rather than the requested time (see README VFR note), so cut on the decoded timeline.
  await run(
    ffmpeg,
    ['-y', ...quiet, '-i', inPath, '-ss', start.toFixed(3), '-t', length.toFixed(3),
     '-vf', 'fps=30', ...x264Args({ crf }), '-pix_fmt', 'yuv420p',
     '-movflags', '+faststart', tmp],
    { stdio: 'inherit' },
  );
  await rename(tmp, inPath);
  return { applied: true, startSec: Number(start.toFixed(3)), lengthSec: Number(length.toFixed(3)), durationSec };
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
// their own (see STITCHING and contentEndSec). The final segment declares nothing; with no pinned end its
// own container tail ends the video, exactly as it does on the single-segment path.
// A pinned final segment (TAIL HOLD) also carries `outpointSec`: the demuxer drops its packets from there
// on, so the footage the hold recorded after the take's end never reaches the file.
export function concatListBody(entries) {
  return entries
    .map(({ path, durationSec, outpointSec = null }) =>
      `file '${path.replace(/'/g, "'\\''")}'\n` +
      (durationSec === null ? '' : `duration ${durationSec.toFixed(6)}\n`) +
      (outpointSec === null ? '' : `outpoint ${outpointSec.toFixed(6)}\n`),
    )
    .join('');
}

// Returns what the concat pass said about itself. ffmpeg's stderr is CAPTURED rather than
// inherited because the interesting failure here doesn't touch the exit code: "Non-monotonic DTS
// in output stream" means the demuxer laid segments down out of order, and ffmpeg still exits 0
// with a scrambled file. The stderr is echoed on failure and on that warning, so nothing the
// operator needed to see is swallowed.
// The `setts` filter that sets the duration of the packet at (or after) `atSec`, less a 5ms margin, to `extSec`.
const settsForTail = ({ atSec, extSec }) =>
  `setts=duration=if(gte(PTS*TB\\,${(atSec - 0.005).toFixed(6)})\\,${extSec.toFixed(6)}/TB\\,DURATION)`;

export async function stitchSegments(ffmpeg, listPath, outPath, { crf = DEFAULT_CRF, tailExtend = null } = {}) {
  // `-loglevel warning`, not `error`: the Non-monotonic DTS check below reads a WARNING, so the
  // quiet flag has to stop short of silencing the one line this function exists to scan for.
  const args = ['-y', '-hide_banner', '-loglevel', 'warning', '-nostdin', '-f', 'concat', '-safe', '0', '-i', listPath];
  // TAIL EXTENSION (see planStitch): the concat demuxer ignores `duration` on the LAST file, so a
  // last segment that owns a longer slot than its picture has to have its final packet's duration
  // set by hand. `setts` does that in the same stream-copy pass: every packet keeps its own
  // duration except the one at or after `atSec` (the last packet's place in the OUTPUT timeline,
  // minus a 5ms margin so a rounding tick cannot miss it). Measured: 13.26s of content + a 20s slot
  // stitched to exactly 30.000s after 10s of static segment. The re-encode fallback pads with tpad.
  // ALWAYS applied, however short, pinned or not: the point is not only to lengthen the last packet but to
  // REPLACE the duration it carries. After an outpoint (a PINNED end, TAIL HOLD) that is the gap to the frame
  // that was cut; on a lost successor's segment it is the muxer's fabricated one, the previous inter-frame
  // gap repeated, which can be seconds long. Measured before (a 10s segment whose successor hung and was
  // dropped): a 0.033s extension fell under a 0.05s threshold, the last packet kept its fabricated 2.816s,
  // and the take came out 92.90s against a planned 90.12s.
  const extend = tailExtend && tailExtend.extSec > 0 ? tailExtend : null;
  const setts = extend ? settsForTail(extend) : null;
  let result = await capture(ffmpeg, [...args, '-c', 'copy', ...(setts ? ['-bsf:v', setts] : []), '-movflags', '+faststart', outPath]);
  let reencoded = false;
  if (result.code !== 0) {
    log(`ffmpeg concat (stream copy) failed (exit ${result.code}) — falling back to re-encode...`);
    process.stderr.write(result.stderr);
    result = await capture(ffmpeg, [
      ...args,
      ...(extend ? ['-vf', `tpad=stop_mode=clone:stop_duration=${extend.extSec.toFixed(3)}`] : []),
      // a CAPPED tail (RECORDING-END CAP) ends at the recorder's end, not at the made-up duration tpad would pad from
      ...(extend?.capped ? ['-t', (extend.atSec + extend.extSec).toFixed(3)] : []),
      ...x264Args({ crf }), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outPath,
    ]);
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
// A pulled file is one of three things, and telling them apart is the whole job (FEEDBACK #23):
//   USABLE  a readable container with a duration and packets: the ordinary case.
//   STATIC  a readable container (the h264 stream header parsed, so the moov atom IS there) with
//           EXACTLY ONE packet (and, on the emulator files measured, no duration; the rule does not
//           depend on that, since a real device's one-packet mp4 may report one). screenrecord emits nothing while the screen is
//           unchanged, so a recorder that watched a still screen for its whole life writes its one
//           opening keyframe and a track with a zero-length sample. That is not damage: it is the
//           normal shape of a generation-wait shot. Measured: 170s natural time-limit end, 20s
//           natural end, and a recorder SIGINT-ed 0.3s / 2s / 12s after start on a static screen
//           all produce the identical file (58789 bytes for the same picture), and `recorded 1
//           frames in N seconds` is what screenrecord says about it when it gets to say anything.
//           The frame in it is the true picture for the whole segment, so it is held, not dropped.
//   DEAD    no readable container at all (a SIGKILLed recorder: "moov atom not found"), or a
//           container with no packets (killed or refused before its first frame), or one packet
//           from a recorder that did not end the way ours do.
// What makes a one-packet file STATIC rather than dead is how the recorder ENDED: exit 0 after
// running its whole time limit, or the SIGINT our own stop() sends. A non-final segment that has a
// successor satisfies that by construction (chainLoop aborts the chain otherwise); a final one is
// stopped by us. Anything else that leaves one packet is a crash, and stays lost.
export function classifyStaticSegment(seg, probed, packets) {
  // Readable container + exactly one packet. Deliberately NOT conditioned on `Duration: N/A`: that is
  // what emulator files report (measured), but a real device's one-packet mp4 may carry a duration,
  // and treating it as an ordinary segment would let a static FINAL segment play for one frame.
  if (probed.size === null) return { static: false };
  if (!packets || packets.count !== 1) return { static: false };
  const said = /recorded\s+(\d+)\s+frames?/.exec((seg.stdout ?? []).join('\n'));
  if (said && Number(said[1]) !== 1) {
    return { static: false, why: `screenrecord reported ${said[1]} frames but the file holds 1` };
  }
  const ours = seg.signal === 'SIGINT' && seg.exitCode === null;
  const limitMs = (seg.limitSec ?? 0) * 1000;
  const ranToLimit =
    seg.exitCode === 0 && !seg.signal && (!limitMs || (seg.wallSec ?? 0) * 1000 >= limitMs - SEGMENT_EARLY_EXIT_TOLERANCE_MS);
  if (!ours && !ranToLimit) {
    return {
      static: false,
      why: `1 packet, from a recorder that did not end the way ours do — a crash, not a held screen: ${recorderEnding(seg)}`,
    };
  }
  return { static: true };
}

// Judge one pulled file on its own terms and record what the probes found on the segment.
// Returns the reason it cannot be used, or null when it passes (a STATIC segment passes, flagged
// `seg.static = true` and carrying `seg.staticInfo`).
export async function inspectSegment(ffmpeg, localPath, seg) {
  const probed = await probeVideo(ffmpeg, localPath);
  seg.containerSec = probed.durationSec;
  seg.size = probed.size;
  const packets = await probePackets(ffmpeg, localPath);
  seg.packetCount = packets?.count ?? null;
  seg.contentEndSec = contentEndSec(packets, probed.durationSec, seg.tag);
  seg.lastPtsSec = lastPtsSecOf(packets, probed.durationSec);
  // Every frame's time in seconds from the segment's start (planTakeEnd); [] when unknown.
  const tick = packets?.timebaseSec ?? (seg.lastPtsSec && packets?.lastPts ? seg.lastPtsSec / packets.lastPts : null);
  seg.framesSec =
    tick && packets?.pts ? packets.pts.map((p) => p * tick).sort((a, b) => a - b) : packets?.count === 1 ? [0] : [];
  // One packet is judged by how the recorder ENDED before anything else, whatever duration the file
  // reports: a healthy one-packet file is a static segment, a crashed one is lost.
  const verdict = classifyStaticSegment(seg, probed, packets);
  if (verdict.static) {
    seg.static = true;
    return null;
  }
  if (probed.durationSec !== null && packets && packets.count > 1) return null;
  const ended = recorderEnding(seg);
  // `seg.lostAs`: the same finding in a few words, for the take's truncation reason (lostSegmentsReason).
  if (probed.size === null) {
    const bytes = await stat(localPath).then((st) => st.size, () => null);
    // What the file is, then how its recorder ended (never assumed: an empty file is also what a recorder
    // that hung and failed on its own leaves, measured: exit 235 after "recorded 0 frames in 15 seconds").
    seg.lostAs = bytes === 0 ? 'was pulled but is empty' : 'was pulled but has no readable container (no moov atom)';
    return bytes === 0
      ? `the pulled file is empty (0 bytes, nothing was written): ${ended}`
      : `the pulled file has no readable container (${bytes ?? '?'} bytes, no moov atom: never finalized): ${ended}`;
  }
  if (!packets) {
    seg.lostAs = 'was pulled but its packets could not be probed';
    return `the packet probe failed on the pulled file: ${ended}`;
  }
  if (packets.count === 0) {
    seg.lostAs = 'was pulled but holds no video frame';
    return `the pulled file is a readable container with 0 video packets (no frame was written): ${ended}`;
  }
  seg.lostAs = `was pulled but holds ${packets.count} packet${packets.count === 1 ? '' : 's'}${probed.durationSec === null ? ' and no duration' : ''}`;
  return `the pulled file holds ${packets.count} packet${packets.count === 1 ? '' : 's'}${probed.durationSec === null ? ' and no duration' : ''} — ${verdict.why ?? ended}`;
}

// How a segment's recorder ended, in words, from what this process saw. A signal on the LOCAL `adb shell`
// client comes from this process (stop()'s SIGINT, its SIGKILL escalation) or from the terminal's process
// group; an exit status above 128 is the REMOTE screenrecord dying on a signal (status - 128), which `adb
// shell` passes through (measured: `pkill -9 screenrecord` on the device -> exit 137). Any other non-zero
// status is the recorder failing on its own (measured: a recorder that hung reported "recorded 0 frames in
// 15 seconds" and exited 235, 17.2s into a 10s limit). Its own frame count is quoted when it printed one.
export function recorderEnding(seg) {
  const said = /recorded\s+(\d+)\s+frames?\s+in\s+[\d.]+\s+seconds?/.exec((seg.stdout ?? []).join('\n'))?.[0];
  const ran = `after ${(seg.wallSec ?? 0).toFixed(2)}s`;
  const own = ` (limit ${seg.limitSec ?? '?'}s${said ? `; screenrecord: "${said}"` : ''})`;
  if (seg.spawnError) return `the recorder could not be started (${seg.spawnError})`;
  if (seg.killedByUs) return `it ignored our SIGINT and was killed (SIGKILL) ${ran}${own}`;
  if (seg.signal === 'SIGINT') return `${seg.stopRequestedAt != null ? 'we stopped it' : 'it was stopped'} (SIGINT) ${ran}${own}`;
  if (seg.signal) return `its adb client was killed by ${seg.signal} ${ran}${own}`;
  if (seg.exitCode > 128 && seg.exitCode < 160) {
    const name = Object.entries(osConstants.signals).find(([, n]) => n === seg.exitCode - 128)?.[0] ?? `signal ${seg.exitCode - 128}`;
    return `the recorder was killed on the device by ${name} (exit ${seg.exitCode}) ${ran}${own}`;
  }
  if (seg.exitCode === 0) {
    const limitMs = (seg.limitSec ?? 0) * 1000;
    return limitMs && (seg.wallSec ?? 0) * 1000 >= limitMs - SEGMENT_EARLY_EXIT_TOLERANCE_MS
      ? `the recorder reached its time limit and exited 0 ${ran}${own}`
      : `the recorder exited 0 on its own, short of its time limit, ${ran}${own}`;
  }
  return `the recorder failed on its own (exit ${seg.exitCode}) ${ran}${own}`;
}

// Was this segment's end OURS: a stop this process asked for before the recorder ended (stop()'s stamp), or a
// SIGINT on the local adb client (ours, or the terminal's Ctrl-C reaching the process group, which the
// handler follows with the same stop)? Never true of a segment the chain aborted on: that recorder died on its own.
export function stoppedByUs(seg) {
  return !seg.endedOnItsOwn && (seg.stopRequestedAt != null || seg.signal === 'SIGINT');
}

// Split a chain of pulled segments into the ones that can be stitched and the ones that cannot,
// and say what dropping the latter costs. The asymmetry is the point: an empty TRAILING segment
// that WE stopped within emptyTailMaxWallSec is the ordinary shape of a stop (the chain can spawn a
// recorder moments before the stop) and nothing that was on screen is in it, so it is dropped with a
// note. A recorder that died ON ITS OWN is never an empty tail, however short its life: the flow was
// still running, so what it did not write is lost (measured before: a recorder `pkill -9`ed 0.33s
// into seg002 of a 38s flow was dropped as "nothing that was on screen is missing", its wall counted
// as `tailSec`, and the clean-up deleted the kept seg001). An unusable segment anywhere else is real
// footage the operator will not get back — the take is stitched from what survived and reported as
// truncated, never silently shortened, and never thrown away wholesale.
// STATIC segments are not dropped anywhere, first or last: they are the footage.
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
    const emptyTail = entry === pulled[pulled.length - 1] && (seg.wallSec ?? Infinity) <= emptyTailMaxWallSec && stoppedByUs(seg);
    dropped.push({ seg, reason, emptyTail });
  }
  const lost = dropped.filter((drop) => !drop.emptyTail).map((drop) => drop.seg);
  const lossReason = lostSegmentsReason(lost);
  const staticHeld = usable.filter(({ seg }) => seg.static).map(({ seg }) => seg);
  return { usable, dropped, lost, lossReason, staticHeld };
}

// What lost segments cost, in the words of `truncationReason`. Their own filmed wall, said as THEIRS: when the
// chain also died the flow ran on unfilmed after them, and "about 0.28s of the flow is missing" beside "the
// rest of the flow is NOT on camera" read as a contradiction (measured on a seg002 killed 0.28s in).
// Each segment says which it was (`seg.lostAs`, set where it was found: the pull, or inspectSegment), never
// "could not be pulled or held no video". When one of them filmed past the flow's end (`flowEndMs`, the chain's
// flow end: it died in the tail hold), what they filmed is split at that end: the flow's share is what the take
// is missing (0 when none), and the tail hold's is said apart, because the take never owed it. Lost segments
// that all ended inside the flow keep "the Xs they filmed" (beside a mid-flow death's "the rest of the flow is
// NOT on camera", "Xs of the flow is missing" would read as all of it). Measured before: "seg005 could not be pulled or held
// no video — the 7.42s it filmed is missing from the take" for a seg005 SIGKILLed 0.46s into the hold.
export function lostSegmentsReason(lost, { flowEndMs = null } = {}) {
  if (lost.length === 0) return null;
  const one = lost.length === 1;
  const said = lost.map((seg) => `${seg.tag} ${seg.lostAs ?? 'could not be pulled or held no video'}`).join('; ');
  const wallSec = lost.reduce((sum, seg) => sum + (seg.wallSec ?? 0), 0);
  const endOf = (seg) => seg.startedAt + (seg.wallSec ?? 0) * 1000;
  if (flowEndMs === null || lost.some((seg) => !Number.isFinite(seg.startedAt)) || !lost.some((seg) => endOf(seg) > flowEndMs)) {
    return `${said} — the ${wallSec.toFixed(2)}s ${one ? 'it' : 'they'} filmed ${one ? 'is' : 'are'} missing from the take`;
  }
  const flowSec = lost.reduce((sum, seg) => sum + Math.max(0, Math.min(endOf(seg), flowEndMs) - seg.startedAt) / 1000, 0);
  const holdSec = Math.max(0, wallSec - flowSec);
  return (
    `${said} — ${flowSec.toFixed(2)}s of the flow is missing from the take` +
    (holdSec >= 0.005 ? `, and the ${holdSec.toFixed(2)}s of tail hold ${one ? 'it' : 'they'} filmed after it (never owed to the take)` : '')
  );
}

// The concat list for the usable segments, and the numbers the stitch check plans against. Pure, so
// a set of pulled segments can be re-stitched offline exactly as the camera would.
//
// Every non-final segment declares `max(content end, min(wall, limit))` (see STITCHING). A STATIC
// segment has no content end (one frame, no duration), so its slot is simply min(wall, limit) — its
// single frame is held across it. A STATIC FINAL segment needs one more trick, measured: the
// concat demuxer ignores a `duration` directive on the LAST file when writing an mp4, so a 1-frame
// file last in the list lasts 0.07s whatever the directive says. Listing the same file twice —
// the first with the hold as its `duration`, the second bare — makes the hold real and leaves the
// 0.07s of the final frame as the only tail. `plannedMaxSec` carries STATIC_TAIL_FRAME_SEC for it.
//
// `end` (TAIL HOLD, from planTakeEnd): { endSec, lastKeptSec } pins the FINAL segment to end exactly at
// endSec of its own time: an `outpoint` drops every packet from there on (what the hold filmed after the
// take's end) and the last kept packet is extended to endSec (`tailExtend.pinned`), so the take's last
// picture is held to the end instead of playing to a container end the muxer made up. A static final
// segment keeps its double listing, held for endSec. Without `end` the final segment behaves as before.
// Where a segment's recorder ENDED, in that segment's own video time: its spawn plus its wall, less its video zero
// (segmentAnchor). The end of what it can have filmed; null when the segment has no wall or spawn time.
export function recordingEndInVideoSec(seg) {
  if (!Number.isFinite(seg?.startedAt) || !Number.isFinite(seg?.wallSec)) return null;
  return (seg.startedAt + seg.wallSec * 1000 - segmentAnchor(seg).videoZeroWallMs) / 1000;
}

export function planStitch(usable, segmentSeconds, { log: say = () => {}, end = null } = {}) {
  const entries = [];
  let tailExtend = null;
  usable.forEach(({ seg, localPath }, i) => {
    const isLast = i === usable.length - 1;
    // Wall time overstates the segment slightly (it includes adb's own spawn), so clamp it to the
    // time limit; a segment that died early keeps its own shorter wall time instead.
    const occupied = Math.min(seg.wallSec ?? segmentSeconds, segmentSeconds);
    if (isLast && end) {
      seg.timelineSec = end.endSec;
      if (seg.static) {
        entries.push({ path: localPath, durationSec: end.endSec });
        entries.push({ path: localPath, durationSec: null });
        return;
      }
      const before = entries.reduce((sum, entry) => sum + (entry.durationSec ?? 0), 0);
      entries.push({ path: localPath, durationSec: null, outpointSec: end.endSec });
      tailExtend = {
        atSec: before + end.lastKeptSec,
        // never a zero-length last sample
        extSec: Math.max(end.endSec - end.lastKeptSec, 0.001),
        slotSec: end.endSec,
        pinned: true,
      };
      return;
    }
    if (seg.static) {
      // RECORDING-END CAP (see the block above): a static FINAL segment with no pinned end is held to its
      // recorder's end in its own video time, not to min(wall, limit) counted from the spawn (which is later by
      // the spawn-to-video-zero lag), and its second, bare listing's frame lasts 1ms instead of the demuxer's
      // 0.07s: the take ends where the recording did.
      const capSec = isLast ? recordingEndInVideoSec(seg) : null;
      const holdSec = capSec !== null ? Math.max(Math.min(occupied, capSec), 0.001) : occupied;
      seg.timelineSec = holdSec;
      entries.push({ path: localPath, durationSec: holdSec });
      if (isLast) {
        entries.push({ path: localPath, durationSec: null });
        if (capSec !== null) {
          const before = entries.reduce((sum, entry) => sum + (entry.durationSec ?? 0), 0);
          tailExtend = { atSec: before, extSec: 0.001, slotSec: 0.001, capped: true };
        }
      }
      return;
    }
    if (seg.contentEndSec === null && seg.containerSec !== null && (!isLast || seg.hadSuccessor)) {
      say(
        `${seg.tag}: no packet-level content end — falling back to its ${seg.containerSec.toFixed(2)}s ` +
          'container duration, which OVER-declares on VFR footage rather than clamping, so this seam may ' +
          'hold a frame longer than it should',
      );
    }
    if (isLast && !seg.hadSuccessor) {
      entries.push({ path: localPath, durationSec: null });
      // RECORDING-END CAP: a final segment with no pinned end plays to its CONTAINER end, which is its last
      // packet's time plus a duration the muxer MADE UP (the previous inter-frame gap repeated, see STITCHING),
      // and can run past the moment its recorder stopped. Measured: a take a SIGINT ended after 25.32s of
      // recording, last frame at 25.23s given 0.884s, delivered 26.11s. When the container runs past the
      // recorder's end, the last packet's duration is set to reach exactly that end (the same `setts` pass as a
      // lost successor's slot, stream copy, every frame untouched). A container that ends before it (frames the
      // recorder never wrote) is left alone, and so is the single-file path then. A last frame that the anchor
      // estimate puts AFTER the recorder's end (video zero is ±~40ms) keeps 1ms, never cut.
      const capSec = recordingEndInVideoSec(seg);
      const fileEndSec = seg.containerSec ?? seg.contentEndSec ?? null;
      if (capSec !== null && fileEndSec !== null && seg.lastPtsSec != null && fileEndSec > capSec + 0.0005) {
        const before = entries.reduce((sum, entry) => sum + (entry.durationSec ?? 0), 0);
        const extSec = Math.max(capSec - seg.lastPtsSec, 0.001);
        seg.timelineSec = seg.lastPtsSec + extSec;
        tailExtend = { atSec: before + seg.lastPtsSec, extSec, slotSec: seg.timelineSec, capped: true };
      }
      return;
    }
    // A segment that had a SUCCESSOR (one that started, whether or not it survived to be stitched)
    // ran as a non-final segment of the chain, so it owns min(wall, limit) of the timeline. When the
    // successor was lost the segment is last in the list, and the concat demuxer ignores `duration`
    // on the last file: left alone it plays only to its container end and a 158s hold becomes a few
    // seconds (measured: 20s of wall -> 5.96s). So the list stays bare and the slot is restored by
    // extending its final packet (stitchSegments' tailExtend).
    // A final one (its successor lost) is the take's end: its slot stops at its own recorder's end too (the
    // RECORDING-END CAP), which is shorter than min(wall, limit) only for a recorder that ended before its limit.
    const lastCapSec = isLast ? recordingEndInVideoSec(seg) : null;
    seg.timelineSec = Math.max(seg.contentEndSec ?? seg.containerSec ?? 0, lastCapSec !== null ? Math.min(occupied, lastCapSec) : occupied);
    if (isLast) {
      entries.push({ path: localPath, durationSec: null });
      if (seg.lastPtsSec !== null && seg.lastPtsSec !== undefined) {
        const before = entries.reduce((sum, entry) => sum + (entry.durationSec ?? 0), 0);
        // never a zero-length last sample (stitchSegments applies every extension, however short)
        tailExtend = { atSec: before + seg.lastPtsSec, extSec: Math.max(seg.timelineSec - seg.lastPtsSec, 0.001), slotSec: seg.timelineSec };
      } else {
        say(`${seg.tag}: no last-packet time to extend from — its held tail is lost from this take`);
      }
      return;
    }
    entries.push({ path: localPath, durationSec: seg.timelineSec });
  });
  const tail = usable[usable.length - 1].seg;
  const directivesSec = entries.reduce((sum, entry) => sum + (entry.durationSec ?? 0), 0);
  let plannedSec;
  let plannedMaxSec;
  if (tailExtend) {
    plannedSec = plannedMaxSec = directivesSec + tailExtend.slotSec;
  } else if (end && tail.static) {
    plannedSec = directivesSec;
    plannedMaxSec = directivesSec + STATIC_TAIL_FRAME_SEC;
  } else {
    const tailLowSec = tail.static ? 0 : (tail.contentEndSec ?? tail.containerSec ?? 0);
    const tailHighSec = tail.static ? STATIC_TAIL_FRAME_SEC : (tail.containerSec ?? tail.contentEndSec ?? 0);
    plannedSec = directivesSec + tailLowSec;
    plannedMaxSec = directivesSec + tailHighSec;
  }
  return {
    entries,
    tailExtend,
    plannedSec: Number(plannedSec.toFixed(3)),
    plannedMaxSec: Number(plannedMaxSec.toFixed(3)),
    // A single ordinary segment whose only change is the RECORDING-END CAP stays on the single-file remux (with the
    // same `setts`): the concat demuxer would put the SPS/PPS in-band in every keyframe (+34 bytes each, measured),
    // where the remux keeps every packet byte-identical to the pulled file.
    needsConcat: usable.length > 1 || tail.static === true || (tailExtend !== null && !(tailExtend.capped && usable.length === 1)) || end !== null,
  };
}

// TAIL HOLD: where the take ends, and which segments it ends in. Pure (exported for offline re-planning).
//   flowEndMs       the wall instant the flow ended (maestro's exit)
//   backlogUntilMs  the first moment after it that the codec was seen idle (holdTail's firstIdleMs), else null
// The take ends at E = the flow's end, or one nominal frame past the last frame written before
// backlogUntilMs if that is later: while the encoder still had a backlog, a frame written after the flow's
// end can be a LATE composition of what the flow left on screen (a saturated encoder starves compositions,
// see TAIL HOLD in the header). Once the codec has idled its queue was empty, so anything later is a change
// made after the flow (measured: a status-bar signal icon 2.0s after it), and stays out. Segments whose video zero is at or after E filmed only what came after
// the take and are left out (`afterTake`; they are not lost footage). The segment E falls in is cut there
// (`end`), or at the end of its own slot when E lies in the handover after it. Returns null when no segment
// started before E (nothing to pin).
export function planTakeEnd(usable, { flowEndMs, backlogUntilMs = null, segmentSeconds }) {
  const anchored = usable.map((entry) => ({ entry, vz: segmentAnchor(entry.seg).videoZeroWallMs }));
  const frameWall = ({ entry, vz }) => (entry.seg.framesSec ?? []).map((t) => vz + t * 1000);
  const allFrames = anchored.flatMap(frameWall);
  // reduce, not Math.max(...): a long take has more frames than a spread may pass
  const latest = (list) => list.reduce((max, t) => (max === null || t > max ? t : max), null);
  const lastFrameWallMs = latest(allFrames);
  let takeEndMs = flowEndMs;
  if (backlogUntilMs !== null) {
    const upToIdle = latest(allFrames.filter((t) => t <= backlogUntilMs));
    // One nominal frame PAST that frame, or the outpoint, which drops packets at or after it, would cut
    // the very frame the end was moved to keep (measured: the take then held the frame before it 1.21s).
    if (upToIdle !== null && upToIdle > flowEndMs) takeEndMs = upToIdle + NOMINAL_FRAME_SEC * 1000;
  }
  let k = -1;
  anchored.forEach(({ vz }, i) => {
    if (vz < takeEndMs) k = i;
  });
  // The segment that was recording when the flow ended, and the last frame IT wrote: only that proves its
  // encoder got past the flow's end (a later segment's frames say nothing about the queue it discarded).
  let f = -1;
  anchored.forEach(({ vz }, i) => {
    if (vz < flowEndMs) f = i;
  });
  const flowSegLastFrameWallMs = f < 0 ? null : latest(frameWall(anchored[f]));
  if (k < 0) return null;
  const { entry, vz } = anchored[k];
  const seg = entry.seg;
  let endSec = (takeEndMs - vz) / 1000;
  // E in the handover after a segment that had a successor: that segment owns its slot, no more.
  if (seg.hadSuccessor) {
    const occupied = Math.min(seg.wallSec ?? segmentSeconds, segmentSeconds);
    endSec = Math.min(endSec, Math.max(seg.contentEndSec ?? 0, occupied));
  }
  const frames = seg.framesSec ?? [];
  // The last frame strictly before the end (1ms guard against a rounding tie with the outpoint).
  const kept = frames.filter((t) => t < endSec - 0.001);
  const lastKeptSec = kept.length > 0 ? kept[kept.length - 1] : 0;
  return {
    kept: usable.slice(0, k + 1),
    afterTake: usable.slice(k + 1),
    end: { endSec, lastKeptSec },
    takeEndMs,
    lastFrameWallMs,
    flowSegLastFrameWallMs,
    cutFrames: frames.length - kept.length,
  };
}

// ── DURATION HONESTY (#4): where the recorded wall went, and what of it reached the file ────────
// Pure (exported for offline checks); main's own path, the signal handler and the unplanned-error exit all
// call it, so every take that has a file has the same `recording.durations` and prints the same line.
// Every term is a measured interval of its own and never negative. Two identities hold, EXACTLY in the printed and
// recorded centiseconds (largest remainder, below):
//   WHERE THE WALL WENT  recordingWallSec = warmup + retry + flow + hold + stop - unrecorded
//   WHAT REACHED THE FILE recordingWallSec = head + seam + lost + tail + trimmed + file - overhang
// recordingWallSec is the first recorder's spawn to the moment the LAST recorder ended (the stop signal, or the
// segment that died on its own). The first sum lays the camera's own phases end to end: warmup (first spawn to
// maestro's spawn), retry (failed startups and their backoff), flow (the last maestro attempt), hold (the TAIL
// HOLD) and stop (the hold's end, or maestro's exit, to the recorder's end). When the recorder ended BEFORE
// those phases did (the chain died mid-flow and maestro ran on; a signal stopped the recorder a moment before
// maestro exited) the phases overrun the recording, and `unrecorded` is that overrun: wall the camera spent
// with no recorder rolling, nothing of it filmed. Then stop is 0. Measured before (a 10s-segment take whose
// tenth recorder hung for 17.2s and the flow ran on 21s): "1.50s warmup + 131.57s flow + -21.17s stop".
// The second sum: head (first spawn to the first kept segment's video zero), seam (the handovers between kept
// segments the timeline drops), lost (the wall of segments that held no usable video, taken out of the gap
// they left, wherever it is), tail (the rest: after a pinned end, the hold and the stop; after a LOST trailing
// segment, the handover into it, since the last kept segment owns its whole slot; otherwise the frames the last
// recorder never wrote), trimmed (--trim-head/--trim-tail) and file (the WRITTEN file's length, `fileSec`: after
// the finishing encode, when one ran). That encode (the tap burn, or the crop's pass) writes 60fps, so the file
// ends on a whole frame, up to half a frame either side of the take's end; tail, the residual, takes that
// difference (an overrun past the recording's end, as overhang). Measured before: the durations line and
// `fileSec` said 313.41 (the stitched file, planned to end at 313.407) for a take written, probed and
// recorded in `output.durationSec` at 313.400 (18804 frames at 60fps). A recorder that
// died on its own is lost however short-lived (see selectSegments); measured before, a seg002 `pkill -9`ed
// 0.33s in was "0.90s at the recording's end (frames the recorder never wrote)" with lostSec 0.
// `lost` used to be folded into `tail` or `seam` (the same take: "14.69s at the stop (frames the recorder never
// wrote)", 17.2s of it a dead segment).
// LARGEST REMAINDER: round non-negative `values` (seconds) to whole centiseconds that sum to exactly `totalC`.
// Each is floored, then the cents still missing go one each to the largest fractions (ties: the earlier term).
// Only floor or ceil is ever chosen while the gap allows it, so no term moves by a full centisecond or turns
// negative; a gap a float error pushed past that is closed on the largest term (and never below 0).
export function roundToTotal(values, totalC) {
  const exact = values.map((v) => Math.max(0, v ?? 0) * 100);
  const out = exact.map((x) => Math.floor(x + 1e-9));
  let gap = totalC - out.reduce((a, b) => a + b, 0);
  const byFraction = exact.map((x, i) => ({ i, frac: x - Math.floor(x + 1e-9) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of byFraction) {
    if (gap <= 0) break;
    out[i] += 1;
    gap -= 1;
  }
  const largest = () => out.reduce((best, v, i) => (v > out[best] ? i : best), 0);
  while (gap > 0) {
    out[largest()] += 1;
    gap -= 1;
  }
  while (gap < 0) {
    const i = largest();
    if (out[i] === 0) break;
    out[i] -= 1;
    gap += 1;
  }
  return out;
}

export function accountDurations({
  segments, timeline, lost = [], maestroStartedAt = null, lastAttemptStartedAt = null, lastAttemptEndedAt = null,
  holdEndMs = null, stitchedSec = null, takeSec = null, fileSec = null, pinnedEnd = false, finalizeSec = RECORD_FINALIZE_MS / 1000,
}) {
  // stitchedSec: the stitched file; takeSec: after --trim-head/--trim-tail, before the finishing encode (null:
  // no finishing encode ran, so the written file is that length too); fileSec: the written file.
  const preFinishSec = takeSec ?? fileSec;
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (!first) return null;
  const recStartMs = first.startedAt;
  const recEndMs = last?.wallSec != null ? last.startedAt + last.wallSec * 1000 : null;
  let wallSec = recEndMs !== null ? (recEndMs - recStartMs) / 1000 : segments.reduce((s, seg) => s + (seg.wallSec ?? 0), 0);
  const endMs = recEndMs ?? recStartMs + wallSec * 1000;
  // The phases, in order; one that never began collapses onto the one before it (maestro never spawned:
  // the whole recording was warmup).
  const warmupEndMs = maestroStartedAt ?? endMs;
  const flowStartMs = lastAttemptStartedAt ?? warmupEndMs;
  const flowEndMs = lastAttemptEndedAt ?? flowStartMs;
  const phasesEndMs = Math.max(holdEndMs ?? flowEndMs, flowEndMs);
  let warmupSec = (warmupEndMs - recStartMs) / 1000;
  let retrySec = (flowStartMs - warmupEndMs) / 1000;
  let flowSec = (flowEndMs - flowStartMs) / 1000;
  let holdSec = (phasesEndMs - flowEndMs) / 1000;
  let stopSec = Math.max(0, endMs - phasesEndMs) / 1000;
  let unrecordedSec = Math.max(0, phasesEndMs - endMs) / 1000;
  let headSec = null;
  let seamSec = null;
  let lostSec = null;
  let tailSec = null;
  let overhangSec = 0;
  let lostTail = 0;
  let trimmedSec = stitchedSec !== null && preFinishSec !== null ? Math.max(0, stitchedSec - preFinishSec) : 0;
  if (timeline.length > 0 && stitchedSec !== null) {
    // A lost segment's wall comes out of the gap it left: before the first kept segment (head), between two
    // kept ones (seam), or after the last (tail). Its wall includes its own spawn; the gap is still the gap.
    const keptIndex = (tag) => segments.findIndex((s) => s.tag === tag);
    const keptAt = timeline.map((slot) => keptIndex(slot.tag));
    const lostIn = (lo, hi) => lost.filter((seg) => seg.index - 1 > lo && seg.index - 1 < hi).reduce((s, seg) => s + (seg.wallSec ?? 0), 0);
    const lostHead = lostIn(-1, keptAt[0]);
    lostTail = lostIn(keptAt[keptAt.length - 1], Infinity);
    const lostBetween = lost.reduce((s, seg) => s + (seg.wallSec ?? 0), 0) - lostHead - lostTail;
    lostSec = lostHead + lostBetween + lostTail;
    // Video zero is an ESTIMATE (the content-area line's arrival less a measured constant, see ANCHOR), and on a
    // warm chained spawn it lands a few ms before the spawn (spawnToVideoZeroMs slightly negative). So head and
    // each seam are floored at 0, and tail, the residual, absorbs those milliseconds: no term is negative.
    headSec = Math.max(0, (timeline[0].videoZeroWallMs - recStartMs) / 1000 - lostHead);
    seamSec = Math.max(
      0,
      timeline.slice(0, -1).reduce((sum, slot, i) => sum + Math.max(0, (timeline[i + 1].videoZeroWallMs - slot.videoZeroWallMs) / 1000 - (slot.spanSec ?? 0)), 0) -
        lostBetween,
    );
    // against the WRITTEN file when there is one: the finishing encode's frame grid lands here (see above)
    tailSec = fileSec !== null ? wallSec - headSec - seamSec - lostSec - trimmedSec - fileSec : wallSec - headSec - seamSec - lostSec - stitchedSec;
    // OVERHANG: the file running past the recording's end. A final segment with no pinned end used to play to the
    // muxer's made-up last-frame duration (measured: recorded 25.32s, file 26.11s, which printed as "- -0.79s at
    // the recording's end"); planStitch's RECORDING-END CAP now ends it at its recorder's end. What can remain is
    // the anchor's own error: a last frame the video-zero estimate (±~40ms) places after the recorder's end is
    // kept (1ms), never cut, so the file overruns by that much; so can the finishing encode's last frame (up to
    // half a 60fps frame, see above). Its own term, added back, never a negative tail.
    if (tailSec < 0) {
      overhangSec = -tailSec;
      tailSec = 0;
    }
  }
  // PRINTED AND RECORDED TERMS CLOSE EXACTLY. Each sum is rounded to centiseconds as a whole, by largest
  // remainder (roundToTotal): the total and any fixed term are rounded once, and the other terms are floored and
  // the leftover cents go to the largest fractions. Rounding each term on its own let a sum miss its total by
  // 0.01 (measured: 1.50 + 24.61 + 1.08 = 27.19 against `recorded 27.20s`). A term moves by under 0.01s.
  const cents = (n) => Math.round(n * 100);
  const wallC = cents(wallSec);
  const unrecordedC = cents(unrecordedSec);
  const [warmupC, retryC, flowC, holdC, stopC] = roundToTotal([warmupSec, retrySec, flowSec, holdSec, stopSec], wallC + unrecordedC);
  let headC = null;
  let seamC = null;
  let lostC = null;
  let tailC = null;
  let trimmedC = cents(trimmedSec);
  // `fileSec` is the file's own length as probed (ffmpeg's banner, already to the centisecond): a fixed term.
  const fileC = fileSec === null ? null : cents(fileSec);
  let overhangC = 0;
  if (tailSec !== null && fileC !== null) {
    const restC = wallC - fileC; // what head + seam + lost + tail + trimmed - overhang must come to
    if (overhangSec === 0 && restC >= 0) {
      [headC, seamC, lostC, tailC, trimmedC] = roundToTotal([headSec, seamSec, lostSec, tailSec, trimmedSec], restC);
    } else {
      // The file overran the recording: the other terms are rounded among themselves and the overhang is what
      // closes the sum (or, if rounding leaves it short, a tail of a centisecond).
      const parts = [headSec, seamSec, lostSec, trimmedSec];
      [headC, seamC, lostC, trimmedC] = roundToTotal(parts, cents(parts.reduce((a, b) => a + b, 0)));
      const leftC = restC - headC - seamC - lostC - trimmedC;
      tailC = Math.max(0, leftC);
      overhangC = Math.max(0, -leftC);
    }
  } else if (tailSec !== null) {
    // no file length to close the sum against: each term on its own
    [headC, seamC, lostC, tailC] = [headSec, seamSec, lostSec, tailSec].map(cents);
  }
  const fromC = (c) => (c === null ? null : c / 100);
  wallSec = fromC(wallC);
  [warmupSec, retrySec, flowSec, holdSec, stopSec, unrecordedSec] = [warmupC, retryC, flowC, holdC, stopC, unrecordedC].map(fromC);
  [headSec, seamSec, lostSec, tailSec, trimmedSec] = [headC, seamC, lostC, tailC, trimmedC].map(fromC);
  overhangSec = fromC(overhangC);
  const r = (n) => (n === null ? null : Number(n.toFixed(2)));
  const seams = timeline.length - 1;
  const lostTags = lost.map((seg) => seg.tag).join(', ');
  const lastKeptIndex = timeline.length > 0 ? segments.findIndex((s) => s.tag === timeline[timeline.length - 1].tag) : -1;
  const lostTailTags = lost.filter((seg) => seg.index - 1 > lastKeptIndex).map((seg) => seg.tag).join(', ');
  const line =
    `durations: recorded ${wallSec.toFixed(2)}s = ${warmupSec.toFixed(2)}s warmup + ` +
    // compared as printed: a 1ms spawn gap is not a retry
    (r(retrySec) > 0 ? `${retrySec.toFixed(2)}s maestro retries + ` : '') +
    `${flowSec.toFixed(2)}s flow + ` +
    (holdSec > 0 || holdEndMs !== null ? `${holdSec.toFixed(2)}s tail hold + ` : '') +
    `${stopSec.toFixed(2)}s stop` +
    (r(unrecordedSec) > 0 ? ` - ${unrecordedSec.toFixed(2)}s after the recording had ended (not filmed)` : '') +
    (fileSec === null
      ? ''
      : `; file ${(fileC / 100).toFixed(2)}s` +
        (tailSec === null
          ? ''
          : ` = recorded - ${headSec.toFixed(2)}s before the first frame` +
            (seams > 0 ? ` - ${seamSec.toFixed(2)}s at ${seams} seam(s)` : '') +
            (r(lostSec) > 0 ? ` - ${lostSec.toFixed(2)}s in lost segment(s) ${lostTags}` : '') +
            (pinnedEnd
              ? ` - ${tailSec.toFixed(2)}s after the take's end (the tail hold and the stop, cut)`
              : lostTail > 0
                ? // the last kept segment owns its whole slot (a lost successor does not shrink it), so what is
                  // left before the lost trailing segment(s) is the handover into them
                  ` - ${tailSec.toFixed(2)}s at the handover into the lost ${lostTailTags} (not filmed)`
                : overhangC > 0 && tailC === 0
                  ? ''
                  : ` - ${tailSec.toFixed(2)}s at the recording's end (frames the recorder never wrote)`) +
            (trimmedSec > 0 ? ` - ${trimmedSec.toFixed(2)}s trimmed` : '') +
            (overhangC > 0 ? ` + ${overhangSec.toFixed(2)}s past the recording's end (a last frame the video-zero estimate or the finishing encode's frame grid puts after it)` : ''))) +
    `; then ${finalizeSec.toFixed(1)}s finalize wait (not recorded)`;
  return {
    line,
    durations: {
      recordingWallSec: r(wallSec),
      warmupSec: r(warmupSec),
      retrySec: r(retrySec),
      flowSec: r(flowSec),
      holdSec: r(holdSec),
      stopSec: r(stopSec),
      unrecordedSec: r(unrecordedSec),
      headSec: r(headSec),
      seamSec: r(seamSec),
      lostSec: r(lostSec),
      tailSec: r(tailSec),
      trimmedSec: r(trimmedSec),
      // the file's run past the recording's end (see OVERHANG above): only the anchor estimate's error and the
      // finishing encode's frame grid, ~0
      overhangSec: tailSec === null ? null : overhangSec,
      finalizeSec,
      fileSec: fileC === null ? null : fileC / 100,
    },
  };
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

// ── SHOW_TAPS: recover the touches and burn a ripple at each one ─────────────────────────────
// One job with one honest answer: what was drawn, `null` if the logs held no touch at all, or a
// throw with a reason the caller can print. It never half-writes — the burn goes to a dot-file
// and only replaces the take once ffmpeg has exited 0.
//
// `keepPreBurn` (only true under `--tighten`) additionally preserves the FINALIZED, pre-burn file
// under a dot-name next to the output rather than letting the burn's rename clobber it — see
// DETECT-FROM in tighten.mjs's header for why: freeze detection run against the burned file
// (fresh quantization noise on every frame) flips tighten out of exact mode into the -60dB
// threshold, and measured moving freeze boundaries by seconds on real Android footage. The rename
// dance below (out -> pre-burn dot-file -> burn -> rename back) costs no extra copy: it is the
// same two renames the plain burn already does, just with the source file kept under a second
// name instead of being overwritten. On any failure (including an aborted burn — see `signal`)
// the original is renamed back over the output path, so the take is delivered without rings
// exactly as it always was; `result.preBurnPath` is null whenever nothing was set aside.
// `inputCrop` (SALVAGE RINGS): the file at videoPath was ALREADY cropped to this rectangle (the salvage crop's
// stream copy). Taps are still mapped in the recorded frame, as always (videoSize is the recorded size), and
// only shifted by its origin for the burn, which then crops nothing. The returned taps stay in recorded pixels,
// the coordinate system the sidecar's `taps` are converted from.
// `maestroStoppedBy`: what stopped the flow, when this process did (a signal's name, --guard-strict, an
// unplanned error), else null. Maestro writes its command record (commands-*.json) as the flow ends, so a
// flow stopped mid-way has none, and every touch is drawn as a plain ripple (a long press cannot be told
// from a tap). That is said as what happened, not warned about as a broken debug dir: measured before,
// every interrupted take printed "⚠️ no tap command in any commands-*.json".
// The command record of a take with taps but no finished tap command in it (parseMaestroTaps'
// `commandRecordGap`), in words. A maestro this process stopped leaves commands-*.json empty or cut off
// mid-write (measured: 0 bytes on one interrupted take, 15949 bytes ending inside an entry on another), so
// then it is said as what happened. Only a maestro that ended on its own without a usable record is a warning.
export function commandRecordGapLine(gap, maestroStoppedBy = null) {
  const plain = 'so a long press cannot be told from a tap: every touch is drawn as a plain ripple';
  const states = { empty: 'is empty', 'cut-off': 'is cut off mid-write', 'no-records': 'has no record entry' };
  const fileList = gap.files.map((f) => `${f.name} ${states[f.state] ?? 'is readable'}`).join(', ');
  if (maestroStoppedBy) {
    const what =
      gap.kind === 'missing'
        ? 'before it wrote its command record (no commands-*.json)'
        : gap.kind === 'unreadable'
          ? `before it finished writing its command record (${fileList})`
          : `before its command record listed a finished tap command (${gap.records} command(s) recorded)`;
    return `maestro was stopped (${maestroStoppedBy}) ${what}, ${plain}`;
  }
  const what =
    gap.kind === 'missing'
      ? 'maestro wrote no command record (no commands-*.json under the debug dir)'
      : gap.kind === 'unreadable'
        ? `maestro's command record holds no readable entry (${fileList}), though nothing here stopped maestro`
        : `no tap command in the command record (${gap.records} command(s) recorded), though maestro.log logged taps`;
  return `⚠️  ${what}, ${plain}`;
}

async function drawTaps({ ffmpeg, videoPath, debugDir, timeline, videoSize, densityDpi, lastSec, bitRate, keepPreBurn, crf, crop, inputCrop = null, signal, maestroStoppedBy = null }) {
  const parsed = await parseMaestroTaps({ debugDir, nearEpoch: timeline[0]?.videoZeroWallMs ?? Date.now() });
  for (const warning of parsed.warnings) log(`⚠️  ${warning}`);
  if (parsed.commandRecordGap) log(commandRecordGapLine(parsed.commandRecordGap, maestroStoppedBy));
  // Nothing to draw is not an error HERE — a flow that never taps is a normal flow. Whether it
  // is an error at all is main()'s call, because only main() knows if any tap command ran.
  if (parsed.taps.length === 0) return null;
  if (!parsed.widthPx || !parsed.heightPx) {
    throw new Error("maestro.log has no 'Got device info: DeviceInfo(...)' line, so taps cannot be placed in the picture");
  }
  const [videoWidth, videoHeight] = (videoSize ?? '').split('x').map(Number);
  const rect = contentRect({
    contentArea: timeline[0]?.contentArea ?? null,
    videoWidth,
    videoHeight,
    // Maestro's own idea of the device is what its coordinates are in, so it is the denominator
    // even if `wm size` disagrees (a rotation mid-take would break far more than the rings).
    deviceWidth: parsed.widthPx,
    deviceHeight: parsed.heightPx,
  });
  if (!rect) throw new Error(`cannot map taps into a ${videoSize ?? 'unknown'} video from a ${parsed.widthPx}x${parsed.heightPx} device`);

  const { drawn, dropped, clamped, shifted } = mapTapsToVideo({
    taps: parsed.taps,
    timeline,
    rect,
    deviceWidth: parsed.widthPx,
    deviceHeight: parsed.heightPx,
    lastSec,
  });
  for (const cut of clamped) {
    log(
      `⚠️  a ${cut.wanted.toFixed(1)}s press ran past the end of ${cut.segment} — its ring is held for ` +
        `${cut.holdSec.toFixed(2)}s instead, because the rest of that press is not in the footage`,
    );
  }
  for (const moved of shifted) {
    log(
      `a tap landed in the seam handover between ${moved.after} and ${moved.segment}, ${moved.shiftSec.toFixed(3)}s before ` +
        `${moved.segment}'s first frame: its ring starts on that frame`,
    );
  }
  if (dropped.length > 0) {
    log(
      `⚠️  ${dropped.length} tap(s) landed where nothing was filmed (${[...new Set(dropped.map((d) => d.reason))].join('; ')}) ` +
        'and were not drawn',
    );
  }
  if (drawn.length === 0) {
    const err = new Error(`all ${parsed.taps.length} logged tap(s) fell outside the recorded footage`);
    err.outsideFootage = true; // main: on a truncated take this is the truncation, not missing indicators
    throw err;
  }

  // A 22dp radius, through the recording's own scale — so the ring is the same size relative to
  // the screen whether the take is native, downscaled by a refusing encoder, or pinned by --size.
  const scale = (rect.w / parsed.widthPx) * ((densityDpi ?? DEFAULT_DENSITY_DPI) / 160);
  const result = await finishingEncode({
    ffmpeg,
    videoPath,
    taps: inputCrop ? drawn.map((t) => ({ ...t, x: t.x - inputCrop.x, y: t.y - inputCrop.y })) : drawn,
    crop: inputCrop ? null : crop,
    keepPreBurn,
    signal,
    // Stay at the bit rate the take was recorded at: this is a re-encode of a screen recording,
    // and the tap-overlay default (12M) would triple the size of a 720x1280 file for nothing.
    style: { scale, codec: 'h264', videoBitrate: bitRate, crf },
  });
  return {
    ...result,
    taps: drawn,
    dropped: dropped.length,
    clamped: clamped.length,
    seamShifted: shifted.length,
    rect,
    scale,
    source: parsed.source,
    parsedCount: parsed.taps.length,
  };
}

// The one re-encode every device take goes through when it needs anything done to its pixels: the
// tap rings and/or the crop that trims screenrecord's 1-2px of letterbox (see the SIZE header). A
// crop rides in the SAME filter graph as the rings (lib/tap-overlay.mjs's burnTapRipples), so it
// costs no extra encode, and a take with no taps to draw gets the same encoder and quality policy
// through a zero-ring pass. `taps` are in the RECORDED frame's pixels; burnTapRipples shifts them by
// the crop origin. Writes to a dot-file and renames over the take only once ffmpeg exited 0; with
// `keepPreBurn` the finalized (uncropped, ring-free) file is kept aside for tighten's --detect-from.
async function finishingEncode({ ffmpeg, videoPath, taps, crop, keepPreBurn, signal, style }) {
  // The run's pid in the name: a SIGKILL leaves this temp behind, and the next run's STALE BURN TEMPS sweep
  // removes it only once this pid is dead (never a live concurrent run's).
  const tmpPath = join(dirname(videoPath), `.${basename(videoPath, '.mp4')}.taps-${process.pid}.mp4`);
  const preBurnPath = keepPreBurn ? join(dirname(videoPath), `.${basename(videoPath, '.mp4')}.pre-taps.mp4`) : null;
  if (preBurnPath) await rename(videoPath, preBurnPath);
  let result;
  try {
    result = await burnTapRipples({
      inPath: preBurnPath ?? videoPath,
      outPath: tmpPath,
      taps,
      crop: crop ? { w: crop.w, h: crop.h, x: crop.x, y: crop.y } : undefined,
      ffmpegPath: ffmpeg,
      style,
      signal,
    });
  } catch (err) {
    await rm(tmpPath, { force: true });
    // Put the pre-burn file back where the take is expected to live — an abort or an encode
    // failure both mean "deliver the take unfinished", the same outcome as if keepPreBurn had
    // never been asked for.
    if (preBurnPath) await rename(preBurnPath, videoPath).catch(() => {});
    throw err;
  }
  await rename(tmpPath, videoPath);
  return { ...result, preBurnPath };
}

// ── SALVAGE CROP: the planned crop as a STREAM COPY, for a take that will not get its finishing encode ──
// An interrupted take (and a failure a signal set aside before its burn finished) is delivered without the
// finishing encode: a signal is not the moment for a whole-take re-encode. It used to be delivered UNCROPPED
// too, with screenrecord's black column (measured: 1144x2546, column x=1143 at luma 0-3 against 236 beside
// it, `crop.applied: false`). H.264 carries its own display crop in the SPS (frame_crop_*_offset, the field
// the encoder already uses to trim its macroblock padding: 1144 is 1152 coded less 8), so the planned
// rectangle can be applied by rewriting those four numbers (`h264_metadata` bsf) with no re-encode.
// Measured on that take: the result decodes to 1142x2546, framemd5 identical to decoding the original and
// cropping it, same packet timestamps, same frame count, same duration. A second stream copy is needed
// because the muxer writes the container's own size (tkhd / avc1) from what it was told, not from the
// rewritten SPS: after one pass the mp4 still said 1144x2546, after re-muxing that file it says 1142x2546.
// Refuses (throws) rather than guesses: anything but 4:2:0 progressive H.264, a crop that does not fit the
// coded frame, or a result whose size or duration is not what was asked.
async function streamCopyCrop(ffmpeg, videoPath, crop) {
  const sps = await capture(ffmpeg, ['-hide_banner', '-i', videoPath, '-map', '0:v:0', '-c', 'copy', '-bsf:v', 'trace_headers', '-frames:v', '1', '-f', 'null', '-']);
  const field = (name) => {
    const m = new RegExp(`\\b${name}\\s+[01]+\\s*=\\s*(\\d+)`).exec(sps.stderr);
    return m ? Number(m[1]) : null;
  };
  const widthMbs = field('pic_width_in_mbs_minus1');
  const heightUnits = field('pic_height_in_map_units_minus1');
  const frameMbsOnly = field('frame_mbs_only_flag');
  const chroma = field('chroma_format_idc') ?? 1; // absent below High profile, where it is 4:2:0
  if (widthMbs === null || heightUnits === null || frameMbsOnly !== 1 || chroma !== 1) {
    throw new Error('not 4:2:0 progressive H.264 with a readable SPS, so its crop cannot be rewritten');
  }
  const cropped = field('frame_cropping_flag') === 1;
  const unitPx = (name) => (cropped ? (field(name) ?? 0) * 2 : 0); // crop units are 2px on both axes for 4:2:0 progressive
  const codedW = (widthMbs + 1) * 16;
  const codedH = (heightUnits + 1) * 16;
  const left = unitPx('frame_crop_left_offset') + crop.x;
  const top = unitPx('frame_crop_top_offset') + crop.y;
  const right = codedW - left - crop.w;
  const bottom = codedH - top - crop.h;
  if ([left, top, right, bottom].some((n) => n < 0 || n % 2 !== 0)) {
    throw new Error(`the crop ${crop.w}x${crop.h} at (${crop.x},${crop.y}) does not fit the ${codedW}x${codedH} coded frame on 2px units`);
  }
  const before = await probeVideo(ffmpeg, videoPath);
  const stem = join(dirname(videoPath), `.${basename(videoPath, '.mp4')}`);
  const pass1 = `${stem}.spscrop1-${process.pid}.mp4`; // pid: see STALE BURN TEMPS
  const pass2 = `${stem}.spscrop2-${process.pid}.mp4`;
  try {
    // Captured, not inherited: this runs from a signal handler, possibly after a hangup took the terminal.
    const quiet = ['-hide_banner', '-loglevel', 'error', '-y', '-nostdin'];
    const copy = async (args) => {
      const r = await capture(ffmpeg, [...quiet, ...args]);
      if (r.code !== 0) throw new Error(`ffmpeg exited ${r.signal ?? r.code}: ${r.stderr.trim().split('\n').pop() ?? ''}`);
    };
    await copy(['-i', videoPath, '-map', '0', '-c', 'copy', '-bsf:v', `h264_metadata=crop_left=${left}:crop_right=${right}:crop_top=${top}:crop_bottom=${bottom}`, pass1]);
    await copy(['-i', pass1, '-map', '0', '-c', 'copy', '-movflags', '+faststart', pass2]);
    const after = await probeVideo(ffmpeg, pass2);
    const want = `${crop.w}x${crop.h}`;
    if (after.size !== want) throw new Error(`the stream-copy crop came out ${after.size ?? 'unreadable'}, not ${want}`);
    if (!(before.durationSec > 0) || Math.abs((after.durationSec ?? 0) - before.durationSec) > 0.05) {
      throw new Error(`the stream-copy crop changed the duration (${before.durationSec}s -> ${after.durationSec}s)`);
    }
    await rename(pass2, videoPath);
    return { size: want, durationSec: after.durationSec };
  } finally {
    await rm(pass1, { force: true });
    await rm(pass2, { force: true });
  }
}

// The sidecar's `tight.removedSec`: what the cut took out, the cut file's length less the written one's
// (the console line's X, see cutSummary in tighten.mjs), or the plan's when either length is unknown.
function removedOfFiles(result, writtenSec) {
  const inSec = result.inFileDurationSec ?? null;
  return inSec !== null && writtenSec != null ? Number((inSec - writtenSec).toFixed(3)) : Number(result.removedSec.toFixed(3));
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

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

// UNPLANNED ERRORS (see the header). Set by main() once it has something an unplanned throw must not
// strand: the stash from the moment it is made, the recorder chain and the maestro child from the moment
// the chain starts. The entry point at the bottom of this file routes a rejection of main() through it.
let onUnplannedError = null;

async function main() {
  // When this run began. markTakeFailed only moves files modified since, so under --force an old,
  // good take at the plain name is never relabelled as this run's failure.
  const runStartedMs = Date.now();
  // KEPT EVIDENCE IS PER RUN (see the header): every file this run may leave behind for a human to look
  // at carries this tag (the run's UTC start, 20260929-191530), so a later run of the same name can
  // neither overwrite it nor delete it as "stale".
  const runTag = runTagOf(runStartedMs);
  // After a terminal hangup (SIGHUP) every console write fails with EIO/EPIPE, and an unhandled
  // stream 'error' would kill the process halfway through the salvage the signal handler starts.
  // Silencing it costs nothing when the console is fine.
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
  const args = parseArgs(process.argv.slice(2));
  const {
    flowArg, outDir, name, force, device: requestedDevice, avd, installs, appId, fresh,
    guardedApp, guardAllow, guardStrict, bitRate, size, strictSize, segmentSeconds, doTighten,
    minStill, keep, noise, crf, trimHead, trimTail, targetDuration, showTaps: showTapsRequested, verbose,
    scenario: scenarioRequested, scenarioDir, scenarioVerify,
  } = args;
  const flowPath = resolve(flowArg);
  const outName = name ?? `${basename(flowPath, extname(flowPath))}-android`;
  let outPath = join(outDir, `${outName}.mp4`);
  let tightPath = join(outDir, `${outName}-tight.mp4`);
  let sidecarPath = join(outDir, `${outName}.json`);

  // A failed run must not burn a take number (#13): lib/takes.mjs moves what this run filmed to
  // `.failed.*` (or the next free `.failed-N.*`) so `ls *.mp4` shows only real takes, and returns
  // where the sidecar must go. Called BEFORE the sidecar is written so `output.path` agrees. Every
  // final status except `ok` and `interrupted` comes through here, always inside failTake() (below),
  // which also writes the sidecar and puts the previous take back. One-shot.
  let markFailedPromise = null;
  const markFailed = () => (markFailedPromise ??= markFailedOnce());
  const markFailedOnce = async () => {
    const r = await markTakeFailed({ outDir, name: outName, since: runStartedMs });
    outPath = r.outPath;
    tightPath = r.tightPath;
    sidecarPath = r.sidecarPath;
    for (const w of r.warnings) console.error(`[film-android] ⚠️  ${w}`);
    if (r.moved.length > 0) console.error(`[film-android] renamed to ${outPath} so the take number stays free.`);
    return r;
  };

  // THE PREVIOUS TAKE UNDER --force (lib/takes.mjs stashPreviousTake; see the header). `stash` stays
  // null until it is made, which is after setup; the two helpers are declared here, ahead of every
  // handler that calls them, and are no-ops with no stash. restorePrevious() runs on every exit that
  // is not an `ok` or `interrupted` take, AFTER markFailed has freed the plain names; keepNewTake()
  // runs once such a take is in place.
  let stash = null;
  // restore() is memoised, so a second call (the interrupt handler's safety net after its own restore)
  // answers with the same result: report each distinct result once.
  let lastRestoreReport = null;
  const restorePrevious = async () => {
    if (!stash) return;
    const r = await stash.restore();
    const report = JSON.stringify(r);
    if (report === lastRestoreReport) return;
    lastRestoreReport = report;
    if (r.state === 'restored') {
      console.error(`[film-android] this retake did not succeed, so the previous take was left as it was: ${r.restored.join(', ')}`);
    } else if (r.state === 'blocked') {
      console.error(
        `[film-android] ⚠️  could NOT put the previous take of "${outName}" back: ${r.blocked.join(', ')} exists. ` +
          `It is still stashed as ${stash.stashed.map((p) => p.stash).join(', ')} and the next run will refuse until you choose (see the message it prints).`,
      );
    }
    for (const w of r.warnings) console.error(`[film-android] ⚠️  ${w}`);
  };
  const keepNewTake = async () => {
    if (!stash) return;
    const r = await stash.discard();
    for (const w of r.warnings) console.error(`[film-android] ⚠️  ${w}`);
  };

  const wrapperPlan = plannedWrapper({ flowPath, scenarioDir });
  let tools;
  try {
    // A stash left by a killed earlier run is put back (or refuses the run) BEFORE preflight: the stash
    // hides the very take preflight exists to protect. See A CRASHED STASH in lib/takes.mjs.
    const recovered = await recoverCrashedStash({ outDir, name: outName });
    if (recovered.state === 'restored') {
      log(`an earlier run of "${outName}" was killed mid-take; its previous take is back: ${recovered.restored.join(', ')}`);
    }
    // STALE BURN TEMPS (see SALVAGE RINGS): the finishing encode's and the salvage crop's temps of a run of
    // this name that was SIGKILLed (`.<name>[.failed[-N]].taps-<pid>.mp4`, `...spscrop1|2-<pid>.mp4`), once
    // that pid is dead. Never a live concurrent run's. Not a take, so this needs no --force.
    const burnTemps = new RegExp(`^\\.${escapeRegExp(outName)}(?:\\.failed(?:-\\d+)?)?\\.(?:taps|spscrop[12])-(\\d+)\\.mp4$`);
    for (const path of await sweepDeadRunTemps(outDir, burnTemps)) log(`removed a stale burn temp a killed run left: ${path}`);
    // `-tight.mp4` with or without --tighten, as film-ios and film-web: a `-tight` without its take is
    // still part of a take, and under --force the stash moves it with the rest.
    tools = await preflight(flowPath, [outPath, sidecarPath, tightPath], force);
    // The wrapper is derived, so a marked one is overwritten without --force; an unmarked file at its
    // path is someone's own and refuses the run here, before the device is touched.
    if (scenarioRequested) {
      const target = await checkGeneratedTarget(wrapperPlan.path);
      if (!target.ok) throw new Error(target.reason);
    }
  } catch (err) {
    console.error(`[film-android] preflight failed: ${err.message}`);
    process.exit(1);
  }
  const { adb, maestro, ffmpeg } = tools;
  // FLOW LINT (lib/maestro-lint.mjs): warns, before anything is filmed, about a wait that directly follows
  // another wait and will not hold its time. Never refuses; recorded as sidecar `flowLint` when non-empty.
  const flowLint = lintAndReport(await readFile(flowPath, 'utf8').catch(() => ''), 'film-android');

  await mkdir(outDir, { recursive: true });

  // SETUP-PHASE SIGNAL HANDLERS. Installed before anything on the device is touched and swapped for
  // the full handlers (which harvest) in the same tick the recorder chain starts. Nothing has been
  // filmed yet, so a signal here is a clean exit, not a salvage: put back the previous take if it was
  // already stashed (--force) and exit 130 SIGINT / 129 SIGHUP / 143 SIGTERM, with no take and no
  // sidecar. main() parks at the stash and at the chain start if one already fired, so it can never
  // run on into stashing or recording while the process exits.
  let setupSignalled = false;
  const onSetupSignal = (signalName, exitCode) => {
    if (setupSignalled) return;
    setupSignalled = true;
    console.error(`\n[film-android] ${signalName} during setup — nothing was filmed.`);
    restorePrevious().finally(() => process.exit(exitCode));
  };
  const setupSigint = () => onSetupSignal('SIGINT', 130);
  const setupSighup = () => onSetupSignal('SIGHUP', 129);
  const setupSigterm = () => onSetupSignal('SIGTERM', 143);
  process.on('SIGINT', setupSigint);
  process.on('SIGHUP', setupSighup);
  process.on('SIGTERM', setupSigterm);

  let deviceId;
  let nativeSize = null;
  // The --size screenrecord actually gets (null = its native default), and what the size preflight
  // found. `size` stays what the operator typed; the sidecar records both.
  let recordSize = size ?? null;
  let sizeProbe = null;
  let orientedNative = null; // the display in its CURRENT orientation (wm size is always the natural one)
  let displayRotation = null;
  let guardPreflight = null;
  let homePackage = null; // the launcher, allowed until the guarded app is first in front (LAUNCHER BEFORE THE APP)
  // What SHOW_TAPS needs off the device before the camera rolls: the density the ring is sized
  // in, and whether this screenrecord knows `--verbose` (which is what anchors the ring times).
  let densityDpi = null;
  let recorderVerbose = false;
  try {
    deviceId = await ensureDevice(adb, requestedDevice, avd ?? process.env.FILMKIT_ANDROID_AVD);
    nativeSize = await deviceNativeSize(adb, deviceId);
    // BEFORE anything is installed, cleared or filmed: a size the encoder will not take (or the
    // silent fallback to another aspect) is found here in ~1-3s instead of after the whole take.
    const oriented = await deviceOrientedSize(adb, deviceId, nativeSize);
    orientedNative = oriented.size;
    displayRotation = oriented.rotation;
    for (const path of await sweepStaleProbeFiles(adb, deviceId)) log(`removed a stale size-probe file a killed run left on ${deviceId}: ${path}`);
    ({ pinned: recordSize, sizeProbe } = await resolveRecordingSize(adb, deviceId, {
      requested: size,
      nativeSize: oriented.size,
      bitRate,
      probeFile: probeDeviceFile(runTag),
    }));
    // The probe may have corrected the orientation (it reads the recorder's own "Display is" line).
    if (sizeProbe.native) orientedNative = sizeProbe.native;
    if (showTapsRequested) {
      // Whether this ffmpeg can be handed a filter graph at all, asked BEFORE the camera rolls:
      // the burn is the last step of the run, and finding out there that the graph cannot be
      // delivered would cost the whole take. The answer is cached for the burn itself.
      await filterScriptOption(ffmpeg);
      densityDpi = await deviceDensityDpi(adb, deviceId);
    }
    // --verbose is asked for on EVERY run, with or without tap indicators: it also prints the content
    // rectangle the after-the-fact letterbox check compares with the video, so a run without it
    // could not notice a black bar.
    recorderVerbose = await screenrecordSupportsVerbose(adb, deviceId);
    if (!recorderVerbose) {
      console.error(
        `[film-android] ⚠️  ${deviceId}'s screenrecord does not take --verbose, so ` +
          `${showTapsRequested ? `tap indicators lose their anchor and fall back to a measured ${SPAWN_TO_VIDEO_ZERO_MS}ms after spawn — expect them up to ~0.2s off, and ` : ''}` +
          'the letterbox check has no content area to read.',
      );
    }
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
    homePackage = await resolveHomePackage(adb, deviceId);
    if (!homePackage) console.error('[foreground] ⚠️  could not resolve the home activity — a launcher seen before the app is an interloper.');
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

  // A setup-phase signal is already exiting the process; do not let this path run on into stashing
  // the previous take or starting a recorder in the meantime. Parked, never resolved.
  if (setupSignalled) await new Promise(() => {});

  // Only now, with the device found, the size probed and the app installed/cleared: a run that dies in
  // setup (no device, a size the encoder refuses, a bad --install) has changed nothing about the
  // previous take, so it does not touch it. From here to the first frame there is only I/O that cannot
  // fail the take. Under --force the previous take moves to a hidden stash, so the plain names hold
  // only what THIS run films. The setup handlers above are still installed until the chain starts, and
  // restore it.
  try {
    stash = await stashPreviousTake({ outDir, name: outName, force });
  } catch (err) {
    console.error(`[film-android] ${err.message}`);
    process.exit(1);
  }
  if (stash.stashed.length > 0) {
    log(`--force: the previous take is set aside until this one is safe (${stash.stashed.map((p) => p.plain).join(', ')})`);
  }
  // No signal check here: stashPreviousTake does its file work before it returns, so no handler can
  // run between the last look above and `stash` being set. A signal from here on restores it.

  // UNPLANNED ERRORS, film-ios's `error` exit. Before the chain starts nothing was filmed: put the previous
  // take back and exit 1. From the handler swap on (`chainArmed`: every closure used below is declared by
  // then, and there is no `await` between the chain starting and the swap), a throw nobody planned for gets
  // what film-ios's catch-all does: stop the maestro child, harvest (stop the chain, pull, stitch), step the
  // take aside with `status: "error"`, put the previous take back, exit 1. A signal already being handled
  // owns all of that (park); a take already final (`ok` written, stash discarded) is left exactly as it is.
  let chainArmed = false;
  onUnplannedError = async (err) => {
    const park = () => new Promise(() => {});
    if (!chainArmed) {
      if (setupSignalled) return park(); // the setup handler is already putting the previous take back
      console.error(`[film-android] unexpected error before recording started: ${err?.stack ?? err}`);
      await restorePrevious();
      process.exit(1);
    }
    if (interrupted) return park(); // the interrupt handler owns salvage, the sidecar and the exit code
    console.error(`[film-android] unexpected error: ${err?.stack ?? err}`);
    if (takeComplete) {
      console.error(`[film-android] the take itself was already complete and stays as it is: ${sidecarPath}`);
      process.exit(1);
    }
    reportAttempts();
    await stopMaestro('an unexpected error').catch(() => {});
    const outcome = await runHarvest().catch(() => null);
    if (outcome?.ok) {
      await dropPreBurn();
      await salvageCrop(); // no finishing encode is coming (SALVAGE CROP); a no-op if one already cropped it
      await probeWritten(outcome);
      recordDurations(outcome);
      if (showTapsRequested) tapsExpected = flowHasTapCommands(await readFile(flowPath, 'utf8').catch(() => ''), debugDir);
      // `error` is the camera's own failure and is the status; a failure the take already had is kept
      // in the text (see DECIDED FAILURES).
      const already = decidedFailure();
      const errorFields = {
        status: 'error',
        error: String(err?.message ?? err) + (already ? ` (the take had already failed: ${already.status}: ${already.error})` : ''),
        finalProbe: outcome.finalProbe,
        stitch: outcome.stitch,
        trim: outcome.trim ?? null,
        durations: outcome.durations ?? null,
      };
      const ours = !failTakePromise; // a failure exit already under way wrote its own sidecar: leave it be
      ringsPending = ours && ringsOwed() && (await fileExists(outPath));
      const placed = await failTake(errorFields).then(() => true, () => false);
      // SALVAGE RINGS, as on a signal: the failed take and its sidecar are already in place.
      if (ours && placed && !interrupted) {
        await salvageRings(outcome, (probe) => writeSidecarSafely(withSignalNote({ ...errorFields, finalProbe: probe ?? errorFields.finalProbe, durations: outcome.durations ?? null }))).catch(() => {});
      }
    }
    // A harvest that failed went through failTake itself (`failed`); whatever else happened, the previous
    // take goes back if it was not replaced (a no-op once failTake's restore has run).
    await restorePrevious();
    if (interrupted) return park();
    process.exit(1);
  };

  // From here on, a recorder process may exist on the device — every exit path below goes
  // through harvest(), whether the flow succeeds, throws, or is interrupted.
  // Per run (runTag): a kept on-device segment of an earlier run is that run's evidence, and a
  // recorder reusing its name would overwrite it. So nothing here deletes "stale" segments any more.
  const deviceBase = `filmkit-${outName.replace(/[^A-Za-z0-9._-]/g, '_')}-${runTag}`;
  // Dot-prefixed so `ls` hides it: Maestro's own debugging spill (logs, a command-by-command
  // execution record, a screenshot per warned step). SHOW_TAPS reads the touches out of it, and
  // it is kept only when something went wrong and there is something to look at. Per run, so a
  // previous take's taps can never be read here and a kept spill is never deleted by a later run.
  const debugDir = join(outDir, `.${outName}.${runTag}.maestro-debug`);
  // The same for the failed startup attempts' logs.
  const attemptsDir = join(outDir, `.${outName}.${runTag}.maestro-attempts`);
  // Last look before the chain starts. There is no `await` from here to the handler swap below (the
  // chain, the guard and every closure in between are synchronous), so no setup handler can fire once
  // a recorder exists, and no full handler before one does.
  if (setupSignalled) await new Promise(() => {});
  log(
    `starting screen recording${recordSize ? ` at ${recordSize}` : ` at native resolution${nativeSize ? ` (${nativeSize})` : ''}`}` +
      `, ${segmentSeconds}s per segment...`,
  );
  const recordingStartedAt = Date.now();
  const chain = startSegmentChain(adb, deviceId, { deviceBase, bitRate, size: recordSize, segmentSeconds, verbose: recorderVerbose });
  const segments = chain.segments;

  // The `maestro test` child of the CURRENT attempt, held so that both --guard-strict and a
  // signal delivered to this process can stop the flow. `maestro` execs java, so the pid we hold is
  // the JVM. A terminal Ctrl-C or hangup reaches it through the process group anyway; a signal sent
  // to THIS pid alone (`kill -HUP <node>`, an agent harness) does not, and without stopMaestro() the
  // flow would run to its end against a device nothing is recording (measured before this existed:
  // node dies, maestro finishes the flow on its own, the on-device recorder keeps rolling).
  let maestroChild = null;
  let maestroExited = Promise.resolve();
  let abortedByGuard = null;
  // The flow's clock (DURATION HONESTY, accountDurations): maestro's first spawn after the warmup, and the
  // LAST attempt's spawn and exit. Declared here, ahead of the signal handler that reads them; null until set.
  let maestroStartedAt = null;
  let lastAttemptStartedAt = null;
  let lastAttemptEndedAt = null;
  // What stopped the flow, when this process did (drawTaps words the missing command record by it).
  let maestroStoppedBy = null;
  const stopMaestro = (reason) => {
    const child = maestroChild;
    if (!child) return Promise.resolve();
    maestroStoppedBy ??= reason;
    child.stopping ??= (() => {
      child.kill('SIGINT');
      const escalate = setTimeout(() => {
        console.error(`[film-android] the flow ignored SIGINT for ${MAESTRO_ABORT_GRACE_MS / 1000}s — killing it.`);
        child.kill('SIGKILL');
      }, MAESTRO_ABORT_GRACE_MS);
      escalate.unref?.();
      return maestroExited.finally(() => clearTimeout(escalate));
    })();
    return child.stopping;
  };
  const guard = guardedApp
    ? startForegroundWatch(adb, deviceId, {
        guardedApp,
        extraAllow: guardAllow,
        homePackage,
        startedAt: recordingStartedAt,
        onInterloper: (event) => {
          if (!guardStrict || abortedByGuard) return;
          abortedByGuard = event;
          console.error(
            `[foreground] --guard-strict: stopping the flow now. What was filmed up to ${event.atSec}s is ` +
              'still pulled, stitched and saved.',
          );
          stopMaestro('--guard-strict');
        },
        // THE APP'S OWN RELAUNCH: read the CURRENT attempt's maestro.log (failed startups are moved out of
        // the debug dir) for the guarded app's launches, at the moment a sighting needs it.
        relaunchWindow: async (atMs) => {
          const { maestroLog } = await locateLogs(debugDir);
          if (!maestroLog) return false;
          return inRelaunchWindow(atMs, parseAppLaunches(await readFile(maestroLog, 'utf8'), guardedApp, atMs));
        },
      })
    : null;

  let maestroError = null;
  let interrupted = false;
  let interruptedBy = null; // the signal's name once one started the salvage (sidecar `interruptedBy`)
  // SCENARIO (Part 2). `branchList`: the `runFlow: when:` blocks the take ran (null = no readable
  // record); `scenarioRecord`: the sidecar's `scenario` block, filled in stages; `takeComplete` flips
  // just before the final `ok` sidecar write: from then on a signal means "stop the scenario work and
  // keep the take", not "salvage" (there is nothing left to salvage).
  let branchList = null;
  let scenarioRecord = null;
  let takeComplete = false;
  let scenarioSignalExit = null; // exit code of the first signal that arrived after takeComplete
  let verifyHandle = null;
  let harvestPromise = null;
  let lossReason = null; // segments that arrived unusable — the pull-side twin of chain.abortReason
  // The chain's abort segment died AFTER the flow and its file was lost (harvest's RECORDER DEATH): the death
  // cut nothing, but its loss truncates the take, so the take's reason says how and when it died.
  let abortSegLost = false;
  let staticSegments = []; // segments that watched a still screen and were held, not dropped (#23)
  // TAIL HOLD: set when the flow ended on its own and the hold began ({ flowEndMs, ...holdTail's result });
  // null on a run a signal or an unplanned error ended mid-flow (no pinned end). `tailReport` is what
  // harvest found about the take's end, for the sidecar's `recording.tailHold`.
  let tailHold = null;
  let tailReport = null;
  let sizeCheck = null; // the recorded size against the device's, once there is a recording (#22)
  // The rectangle the finishing encode trims off the recorded frame ({ w, h, x, y, contentArea,
  // reason }), or null; and whether that encode actually ran (a take whose crop was not applied
  // still has its bar and fails).
  let cropPlan = null;
  let cropApplied = false;
  // How the crop was applied: 'encode' (the finishing encode, every take that gets one) or 'stream-copy'
  // (SALVAGE CROP: a signal ended the take before its finishing encode); null while not applied.
  let cropMethod = null;
  // Why a salvage crop could not be applied, if it was tried (sidecar `recording.crop.error`).
  let salvageCropError = null;
  // What screenrecord recorded (the stitched file's size, before any finishing encode). This is what
  // the sidecar's `recording.actualSize` has always meant and still does; the size of the file that
  // is delivered (recorded minus the crop) is `recording.deliveredSize`.
  let recordedSize = null;
  const maestroRetries = []; // one row per startup retry inside this take (#27): { reason, atSec }
  const tempFiles = []; // local `.<name>.<run>.<tag>.mp4` copies; kept, and named, whenever anything went wrong
  const deviceLeftovers = []; // on-device segment files deliberately not deleted: { path, why }

  // SHOW_TAPS state. `timeline` is filled in by harvest() — one slot per segment that made it
  // into the stitched file, which is what turns a tap's wall clock into a time in the video.
  let timeline = [];
  let tapResult = null;
  // The result of the FINISHING encode when it ran with no rings (a crop with no taps to draw, or
  // --no-show-taps), and its failure if it did not. Together with tapResult it answers "did the
  // take's pixels get their one re-encode": `finished` below is whichever ran.
  let finishResult = null;
  let cropError = null;
  const finished = () => tapResult ?? finishResult;
  let tapError = null; // something went wrong drawing them — always worth saying
  let tapsOutsideFootage = false; // …because every logged tap fell where the take has no frame
  let noTapsFound = false; // the logs simply held no touch — only news if a tap command ran
  let tapsExpected = false; // …which is Maestro's own execution record's business, after the run
  // --debug-output is passed on EVERY run, with or without tap indicators: the startup-retry
  // predicate reads maestro.log there. So it always exists; it is deleted once the run succeeds.
  let debugKept = true;
  // One protected range per drawn tap (see tapProtectRanges below), filled in once tapResult is
  // known. Declared here (not where it is assigned) so writeSidecar's closure — which a harvest()
  // failure can invoke before SHOW_TAPS ever runs — always finds an initialized value rather than
  // tripping a temporal-dead-zone ReferenceError on a `const` it raced.
  let tapProtect = [];
  // Burn-abort state: whether drawTaps' ffmpeg is currently running, the controller SIGINT uses
  // to stop it, and the in-flight promise SIGINT awaits before writing the sidecar and exiting —
  // so a Ctrl-C mid-burn tears the encoder down deterministically instead of racing process.exit
  // against whatever ffmpeg happens to be doing.
  let burning = false;
  let burnAbortController = null;
  let pendingBurn = null;
  // The same for TIGHTEN: tighten() takes an AbortSignal, so a signal aborts it, awaits it (it settles
  // only after its ffmpeg child has exited, and removes its own temp output), and only then exits.
  let tightenAbortController = null;
  let pendingTighten = null;
  // The pre-burn copy kept aside for tighten's --detect-from (see SHOW_TAPS). It exists only between
  // the burn and the end of TIGHTEN, and every exit in that window must remove it (dropPreBurn).
  const dropPreBurn = async () => {
    const path = finished()?.preBurnPath;
    if (path) await rm(path, { force: true }).catch(() => {});
  };
  // SALVAGE CROP (see streamCopyCrop): a take that leaves through the signal handler or the unplanned-error
  // exit without its finishing encode still gets its planned crop, as a stream copy, before its sidecar is
  // written, so it is delivered without screenrecord's 1-2px bar. Not when the crop's own failure is the
  // take's verdict (decided.cropFailed: the sidecar then describes the file as it is). Never fails the take:
  // a crop that cannot be applied leaves the file as it was, says why, and records it in `crop.error`.
  const salvageCrop = async () => {
    if (!cropPlan || cropApplied || decided.cropFailed || !(await fileExists(outPath))) return;
    try {
      await streamCopyCrop(ffmpeg, outPath, cropPlan);
      cropApplied = true;
      cropMethod = 'stream-copy';
      if (sizeCheck) sizeCheck.delivered = `${cropPlan.w}x${cropPlan.h}`;
      log(`cropped to ${cropPlan.w}x${cropPlan.h} by stream copy (no finishing encode ran for this take)`);
    } catch (err) {
      salvageCropError = err.message;
      console.error(`[film-android] ⚠️  could not crop the salvaged take (${err.message}) — it is delivered uncropped, bar included.`);
    }
  };
  // SALVAGE RINGS (see the header). A take that leaves without its burn (a signal, an unplanned error) still
  // gets the rings for the taps that happened, in a SECOND pass that runs only once the take and its sidecar
  // are final: delivered, described, the stash settled. So nothing the burn costs in time can cost the take:
  // a second signal aborts it (`salvageBurn`, see onInterrupt) and a SIGKILL during it leaves the delivered,
  // described, ringless take (and at most the burn's dot-prefixed temp). When the rings land, the file is
  // replaced by rename and `rewrite(finalProbe)` writes the sidecar again with them. The burn is the main
  // path's own (drawTaps), from the take as delivered: already cropped by the salvage crop's stream copy
  // (`inputCrop`), or cropped in the same pass if that copy failed. Skipped: --no-show-taps, rings already
  // drawn, a burn that failed on its own (its error stands), a take with no file.
  let salvageBurn = null; // { controller, skippedBy } while the second pass runs
  let ringsPending = false; // the sidecar written before that pass says the rings are still to come
  // Whether a second pass is owed at all; the caller sets `ringsPending` from it before the first sidecar write.
  const ringsOwed = () => showTapsRequested && !tapResult && !noTapsFound && !(tapError !== null && !burnAbortedBySignal);
  const salvageRings = async (outcome, rewrite) => {
    if (!ringsOwed() || !(await fileExists(outPath))) {
      ringsPending = false;
      return;
    }
    const inputCrop = cropPlan && cropApplied ? cropPlan : null;
    const graphCrop = !inputCrop && cropPlan && !decided.cropFailed ? cropPlan : null;
    const controller = new AbortController();
    salvageBurn = { controller, skippedBy: null };
    log('drawing the tap indicators into the saved take (it is already saved without them: a second signal skips this)...');
    tapError = null;
    try {
      const drawn = await drawTaps({
        ffmpeg,
        videoPath: outPath,
        debugDir,
        timeline,
        videoSize: recordedSize,
        densityDpi,
        lastSec: outcome.finalProbe?.durationSec ?? Infinity,
        bitRate,
        keepPreBurn: false,
        crf,
        crop: graphCrop,
        inputCrop,
        signal: controller.signal,
        maestroStoppedBy: maestroStoppedBy ?? interruptedBy,
      });
      if (drawn === null) {
        noTapsFound = true;
      } else {
        tapResult = drawn;
        tapProtect = tapProtectRanges(drawn.taps);
        if (graphCrop) {
          cropApplied = true;
          cropMethod = 'encode';
          salvageCropError = null;
          if (sizeCheck) sizeCheck.delivered = `${graphCrop.w}x${graphCrop.h}`;
        }
        log(`drew ${drawn.taps.length} tap indicator(s) into the saved take (${drawn.encoder}, ${drawn.elapsedSec.toFixed(1)}s)`);
      }
    } catch (err) {
      tapError = salvageBurn.skippedBy ? `a second ${salvageBurn.skippedBy} skipped drawing them after the take was saved` : err.message;
      console.error(`[film-android] ⚠️  no tap indicators drawn into the saved take — ${tapError}`);
    } finally {
      salvageBurn = null;
      ringsPending = false;
    }
    const probe = tapResult ? await probeVideo(ffmpeg, outPath) : null;
    // The ring pass re-encoded the take at 60fps: the durations are recomputed against the file it wrote
    // (DURATION HONESTY), and the caller's rewrite records them (`outcome.durations`).
    if (probe?.durationSec != null && outcome.durations) {
      outcome.finalProbe = probe;
      recordDurations(outcome, { again: 'with the rings drawn' });
    }
    await rewrite(probe);
  };
  // Whether the main path's burn was stopped by a signal (its AbortError is then not the burn's own failure).
  let burnAbortedBySignal = false;

  // Where the failed maestro attempts' logs are kept, said wherever the run exits without deleting
  // them (a successful run removes the directory).
  const reportAttempts = () => {
    if (maestroRetries.length > 0) {
      console.error(
        `[film-android] maestro was retried ${maestroRetries.length} time(s) at startup; the failed attempts' logs: ${attemptsDir}`,
      );
    }
  };

  const wallTotalSec = () => segments.reduce((sum, seg) => sum + (seg.wallSec ?? 0), 0);
  const recordingSpanSec = () => {
    const last = segments[segments.length - 1];
    return segments.length > 0 && last.wallSec != null ? (last.startedAt + last.wallSec * 1000 - segments[0].startedAt) / 1000 : wallTotalSec();
  };
  // A chain abort is a truncation only when it cut the flow short (abortCutFlow); one in the tail hold is not,
  // but when it also lost its file (abortSegLost) the death is said beside the loss, as mid-flow: how the
  // recorder ended and that it was after the flow (chain.abortReason says both).
  const truncationReason = () =>
    [chain.abortCutFlow || abortSegLost ? chain.abortReason : null, lossReason].filter(Boolean).join('; ') || null;
  const interloped = () => (guard?.interlopers.length ?? 0) > 0;
  const interloperReason = () => {
    if (!interloped()) return null;
    const seen = guard.interlopers.map((e) => `${e.package} at ${e.atSec}s`).join(', ');
    return (
      `another app was in front of ${guardedApp} while the camera rolled (${seen})` +
      (abortedByGuard ? ' — the flow was cut short by --guard-strict' : '')
    );
  };

  const writeSidecar = async ({ status, error = null, finalProbe = null, stitch = null, tightResult = null, trim = null, durations = null }) => {
    // Seam offsets are prefix sums of the surviving segments' timeline slots — the numbers the
    // stitch directives already laid down. Single-segment → []. Null spans (final slot) play out
    // to the file end and contribute no seam.
    const seamOffsetsSec = timeline
      .slice(1)
      .map((_, i) => timeline.slice(0, i + 1).reduce((sum, slot) => sum + (slot.spanSec ?? 0), 0))
      .map((n) => Number(n.toFixed(3)));
    // Wall→video map: where each surviving segment starts on the wall clock (sec from recorder
    // start) and where it sits in the video. A dropped middle segment shows up here as a jump.
    const wallMap = timeline.map((slot) => {
      const seg = segments.find((s) => segTag(s.index) === slot.tag);
      const wallStart = seg ? Number(((seg.startedAt - recordingStartedAt) / 1000).toFixed(3)) : null;
      const wallSec = seg?.wallSec ?? null;
      const row = { segment: slot.tag, wallStartSec: wallStart, wallSec, offsetSec: Number(slot.offsetSec.toFixed(3)), spanSec: slot.spanSec === null ? null : Number(slot.spanSec.toFixed(3)) };
      return row;
    });
    // `recording.truncated` describes the DELIVERED video, so it agrees with the verdict: a take with no video
    // (a harvest that saved nothing, status `failed`) is not "truncated", and its `error` says why there is
    // none. Measured before: a single segment SIGKILLed in the tail hold was `failed` ("nothing to stitch")
    // with `truncated: true`.
    const videoPath = (await fileExists(outPath)) ? outPath : null;
    const truncation = videoPath ? truncationReason() : null;
    const payload = {
      tool: 'film-android.mjs',
      filmkit: filmkitCommit(), // { commit, branch } of the filmkit that filmed this, or null
      ok: status === 'ok',
      status, // ok | truncated | interloper | taps-missing | flow-failed | interrupted | failed | error
      error,
      // The signal that arrived during the run (film-web's key): on `interrupted`, and on a failed take whose
      // failure was decided before it (see DECIDED FAILURES). null otherwise.
      interruptedBy,
      filmedAt: new Date().toISOString(),
      argv: process.argv.slice(2),
      // tighten.mjs reads a top-level `timeline` array off this file as its protected ranges (the
      // same mechanism the web camera's sidecar uses for caption/pause holds — see PROTECTED
      // RANGES in tighten.mjs's header), so a standalone `node tighten.mjs <take>` protects every
      // drawn tap automatically, with no --tighten flag or in-process call required. `clock:
      // "frame"` because tSec is measured against the recording's own timeline (segment offset +
      // anchor), not a wall clock running alongside it, so it needs no drift margin — the -0.15s /
      // +0.45s padding in tapProtectRanges already covers the anchor's own measured slop.
      clock: 'frame',
      timeline: tapProtect,
      flow: { path: flowPath, sha256: await sha256(flowPath).catch(() => null) },
      device: {
        serial: deviceId,
        nativeSize,
        // the display in its CURRENT orientation (nativeSize is `wm size`, always the natural one) and
        // the rotation it was read from (0-3, null if unreadable)
        orientedSize: orientedNative,
        rotation: displayRotation,
        densityDpi,
        fingerprint: await deviceFingerprint(adb, deviceId),
      },
      // The quality every re-encode this run did was made at (finalize/trim/stitch fallbacks, the
      // tap burn's software path, tighten). Stream copies do not re-encode and ignore it.
      crf,
      // Startup retries inside this take (#27), `[]` when maestro came up first time.
      maestroRetries,
      recording: {
        requestedSize: size ?? null,
        // What screenrecord was actually given as --size (null = its default, native, which the
        // preflight proved filmable). Differs from requestedSize when the probe walked down.
        pinnedSize: recordSize,
        sizeProbe,
        // recorded size against the device's: { expected, actual, aspectOk, sizeMatch, contentArea,
        // contentFits: fill|crop|letterbox|unknown }
        sizeCheck,
        // The trim the finishing encode makes to remove screenrecord's 1-2px of float-truncation
        // letterbox: { w, h, x, y, contentArea, reason, applied } (the delivered take is w x h), or null.
        crop: cropPlan
          ? { ...cropPlan, applied: cropApplied, method: cropApplied ? cropMethod : null, ...(salvageCropError ? { error: salvageCropError } : {}) }
          : null,
        strictSize: strictSize ?? false,
        // What screenrecord recorded, whatever the finishing encode did after (unchanged meaning).
        actualSize: recordedSize,
        // The size of the delivered take at `output.path`: the recorded size less the crop when the
        // crop was applied. Equal to actualSize when nothing was cropped.
        deliveredSize: cropPlan && cropApplied ? `${cropPlan.w}x${cropPlan.h}` : recordedSize,
        bitRate,
        segmentSeconds,
        segmentCount: segments.length,
        seamCount: Math.max(0, timeline.length - 1),
        seamOffsetsSec,
        wallMap,
        trim: trim ?? (trimHead > 0 || trimTail > 0 ? { headSec: trimHead, tailSec: trimTail } : null),
        durations: durations ?? null,
        // TAIL HOLD (see the header): how long the recorder rolled after the flow, why it stopped, and where
        // the take was pinned to end. null when no hold ran (a signal or an unplanned error ended the run
        // mid-flow, or the chain had already stopped).
        tailHold: tailReport ?? (tailHold ? { endedBy: tailHold.endedBy, watch: tailHold.watch, encoder: tailHold.encoder, holdSec: tailHold.holdEndMs ? Number(((tailHold.holdEndMs - tailHold.flowEndMs) / 1000).toFixed(3)) : null } : null),
        targetDurationSec: targetDuration ?? null,
        wallSec: Number(wallTotalSec().toFixed(3)),
        truncated: videoPath !== null && (Boolean(truncation) || status === 'interrupted'),
        truncationReason: truncation,
        // A truncated take's video timeline is discontinuous: a dropped middle segment jumps wall
        // time with no frames in between. wallMap + seamOffsetsSec above place the jump.
        discontinuous: (lossReason && timeline.length > 0) ? true : undefined,
        // Segments that watched a still screen for their whole life, held rather than dropped:
        // [{ segment, index, position: first|middle|final, wallSec, heldSec, exitCode, signal }].
        staticSegments,
        stitch,
        segments: segments.map((seg) => ({
          index: seg.index,
          wallSec: seg.wallSec === null ? null : Number(seg.wallSec.toFixed(3)),
          containerSec: seg.containerSec ?? null,
          packetCount: seg.packetCount ?? null,
          static: Boolean(seg.static),
          // where the segment's last picture sits, and how much of the stitched timeline it was
          // given. `timelineSec` is null only for an ordinary final segment (it plays out to its own
          // container end); a final segment that is static or had a lost successor is given its
          // slot (min(wall, limit)) and reports it.
          contentEndSec: seg.contentEndSec === undefined || seg.contentEndSec === null ? null : Number(seg.contentEndSec.toFixed(3)),
          timelineSec: seg.timelineSec === undefined ? null : Number(seg.timelineSec.toFixed(3)),
          exitCode: seg.exitCode,
          signal: seg.signal,
          dropped: Boolean(seg.dropError),
          dropReason: seg.dropError ?? null,
          stderr: seg.stderr,
          // screenrecord's --verbose narration: the geometry it settled on, and the content
          // rectangle the tap indicators were mapped through.
          stdout: seg.stdout ?? [],
        })),
      },
      // Who owned the screen, and what the guard made of it. `foreground` is one row per CHANGE,
      // timestamped from the moment the recorder started, so it lines up with the video itself.
      foreground: guard ? guard.events : null,
      guard: guard
        ? {
            app: guardedApp,
            extraAllow: guardAllow ?? [],
            // allowed as `home-before-app` until the app was first in front, then an interloper like any app
            home: homePackage,
            strict: guardStrict,
            pollSec: FOREGROUND_POLL_MS / 1000,
            allowlist: [...FOREGROUND_ALLOW.map(String), ...(guardAllow ?? []).map((p) => `extra:${p}`)],
            preflight: guardPreflight,
            changeCount: guard.events.length,
            interlopers: guard.interlopers,
            clean: !interloped(),
            abortedAtSec: abortedByGuard?.atSec ?? null,
          }
        : null,
      // What the indicators did, and against what clocks. Every `tSec` below is (the tap's wall
      // clock − its segment's `videoZeroWallMs`) + that segment's offset in the stitched timeline.
      showTaps: Boolean(tapResult),
      showTapsRequested: showTapsRequested,
      tapsExpected,
      taps: tapResult
        ? tapResult.taps.map((t) => ({
            // in the DELIVERED frame's pixels: the recorded frame's, less the crop origin
            x: Math.round(t.x - (cropPlan && cropApplied ? cropPlan.x : 0)),
            y: Math.round(t.y - (cropPlan && cropApplied ? cropPlan.y : 0)),
            tSec: Number(t.tSec.toFixed(3)),
            segment: t.segment,
            ...(t.holdSec ? { holdSec: t.holdSec } : {}),
            // the tap fell in the seam handover before `segment`: drawn on its first frame, this much late
            ...(t.seamShiftSec ? { seamShiftSec: t.seamShiftSec } : {}),
          }))
        : [],
      // …and null, not a set of anchors nobody used, when `--no-show-taps` asked for none.
      tapSync: !showTapsRequested ? null : {
        // What the segments ACTUALLY anchored on, not what the `--help` probe hoped for: the line
        // can be supported, printed, and still arrive too late to mean anything (see
        // segmentAnchor). A mixed take names both, because then some rings are tighter than others.
        anchor: anchorSummary(timeline, recorderVerbose),
        offsets: timeline.map((slot) => ({
          segment: slot.tag,
          videoZeroWallMs: slot.videoZeroWallMs,
          // How late capture actually began. Logged because it is the number that makes anchoring
          // on spawn wrong: 227–632ms on cold spawns, and slightly negative on a warm chained
          // segment, where the anchor's constant is a little generous (see the ANCHOR header).
          spawnToVideoZeroMs: slot.videoZeroWallMs - slot.startedAt,
          anchorSource: slot.anchorSource,
          anchorNote: slot.anchorNote ?? null,
          offsetSec: Number(slot.offsetSec.toFixed(3)),
          spanSec: slot.spanSec === null ? null : Number(slot.spanSec.toFixed(3)),
          contentArea: slot.contentArea,
        })),
        source: tapResult?.source ?? null,
        scale: tapResult?.scale ?? null,
        contentRect: tapResult?.rect ?? null,
        droppedTaps: tapResult?.dropped ?? 0,
        clampedHolds: tapResult?.clamped ?? 0,
        // taps that fell in a seam handover, drawn on the next segment's first frame (`taps[].seamShiftSec`)
        seamShiftedTaps: tapResult?.seamShifted ?? 0,
        ffmpeg: tapResult ? { version: tapResult.ffmpegVersion ?? null, filterOption: tapResult.filterOption ?? null } : null,
        // A Ctrl-C exits before SHOW_TAPS ever runs — say that outright rather than leaving an
        // empty `taps` array to be read as "this take had none".
        error:
          tapError ??
          (noTapsFound
            ? 'no touch was logged by maestro'
            : ringsPending
              ? 'the indicators are drawn in a second pass after the take was saved, and this sidecar is rewritten ' +
                'when they land: still reading this means that pass never finished (the process was killed)'
              : showTapsRequested && !tapResult && status === 'interrupted'
                ? 'interrupted before the indicators were drawn'
                : null),
      },
      output: {
        // null when there is no video (a harvest that saved nothing): a sidecar must not name a file
        // that does not exist.
        path: videoPath,
        durationSec: finalProbe?.durationSec ?? null,
        // The burn's own numbers when rings were drawn; otherwise what the file on disk is, read
        // from its stream banner (recorder footage is VFR, so the average fps is low and that is
        // normal), so a failed take's sidecar is not blank. null only when there is no file.
        fps: finished()?.fps ?? finalProbe?.fps ?? null,
        encoder:
          finished()?.encoder ??
          (finalProbe?.codec ? `screenrecord ${finalProbe.codec.name}${finalProbe.codec.profile ? ` (${finalProbe.codec.profile})` : ''}` : null),
      },
      tight: tightResult ?? null,
      // `branches` (Part 2): present whenever --scenario was asked for (null = no readable record),
      // and otherwise only when the flow actually had `runFlow: when:` blocks other than mode gates,
      // so a take of a flow without any (pause gates and test-only steps do not count) keeps exactly the
      // sidecar keys it always had.
      ...(scenarioRequested ? { branches: branchList } : branchList?.some((b) => !b.modeGate) ? { branches: branchList } : {}),
      ...(scenarioRecord ? { scenario: scenarioRecord } : {}),
      ...(flowLint.length > 0 ? { flowLint } : {}),
      flowSucceeded: !maestroError,
      debugOutput: debugKept ? debugDir : null,
      keptFiles: { local: [...tempFiles], device: deviceLeftovers.map((p) => `${deviceId}:${p.path}`) },
    };
    await writeFile(sidecarPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    log(`provenance written: ${sidecarPath}`);
  };

  const writeSidecarSafely = (fields) =>
    writeSidecar(fields).catch((err) => console.error(`[film-android] sidecar failed: ${err.message}`));

  // FAILURE EXITS. Every final status except `ok` and `interrupted` leaves through failTake(): step the take
  // aside (markFailed), write its sidecar at the `.failed` name, put the previous take back, as ONE promise.
  // One-shot: `failTakePromise` is what an interrupt that races a failure already under way waits for
  // (bounded by FAIL_EXIT_WAIT_MS, see onInterrupt), so the failed take keeps its sidecar and the previous
  // take comes back. Measured before this existed: a SIGINT landing while markFailed was moving the video
  // exited 130 between the move and the write, leaving `.failed-6.mp4` with no `.failed-6.json`. `fields` is
  // the sidecar's, or a function of markFailed's result; `afterMove(r)` runs between the move and the write
  // (messages that name where the video went, the moved `-tight` path). A main-path exit that would START
  // after an interrupt already began is not started: the handler owns that run from then on (it sets the
  // take aside itself if its failure was already decided, see DECIDED FAILURES, and salvages it as
  // `interrupted` otherwise), so the call parks. The salvage path (harvest, the handler) passes `salvage`.
  // A signal received before the sidecar is written is recorded there (`interruptedBy`) and noted in
  // `error`; the status stays the failure's.
  let failTakePromise = null;
  // A failed take's sidecar names a signal that arrived while it was being finished (also on SALVAGE RINGS'
  // rewrite of that sidecar).
  const withSignalNote = (f) => {
    if (!interruptedBy) return f;
    const note = `${interruptedBy} was received while this failed take was being finished`;
    return { ...f, error: f.error ? `${f.error}; ${note}` : note };
  };
  const failTake = (fields, { afterMove, salvage = false } = {}) => {
    if (!failTakePromise && interrupted && !salvage) return new Promise(() => {});
    return (failTakePromise ??= (async () => {
      const r = await markFailed();
      afterMove?.(r);
      const f = typeof fields === 'function' ? fields(r) : fields;
      await writeSidecarSafely(withSignalNote(f));
      await restorePrevious();
      return r;
    })());
  };

  // DECIDED FAILURES (see the header). A take can fail well before its failure exit runs: the flow failed
  // (known when the retry loop ends), harvest found a lost segment, an interloper or a bad geometry, the
  // burn could not draw rings that were owed, the crop did not land. Each verdict is recorded here the
  // moment it is computed, and only while no signal has arrived. A signal that lands after that (during
  // harvest's cleanup, the burn, tighten, an await on the way to failTake) did not end the take:
  // onInterrupt sets it aside with the decided status instead of writing `interrupted` and discarding the
  // previous take. decidedFailure() is also what main's own failure exits read, so the two cannot disagree.
  const decided = { flowError: null, harvest: null, tapsMissing: null, cropFailed: null };
  const harvestVerdicts = ({ sizeMismatch, aspectMismatch, letterboxMismatch }) => ({
    incomplete: truncationReason(),
    covered: interloperReason(),
    // An aspect change fails the take whether or not --strict-size was passed (see the SIZE header).
    aspectFailed: aspectMismatch ? `aspect ratio changed: ${aspectMismatch}` : null,
    boxFailed: letterboxMismatch ?? null,
    sizeFailed: sizeMismatch && strictSize ? `--strict-size: ${sizeMismatch}` : null,
  });
  /** `{ status, error }` of the failure decided so far, or null. The precedence is main's exit order. */
  const decidedFailure = () => {
    if (decided.tapsMissing) return { status: 'taps-missing', error: `tap indicators could not be derived: ${decided.tapsMissing}` };
    // An interloper outranks a flow failure as the diagnosis, because in --guard-strict it CAUSED it: the
    // flow "failed" only in the sense that the guard shot it. Both reasons are kept.
    if (decided.flowError) {
      return { status: interloped() ? 'interloper' : 'flow-failed', error: [interloperReason(), decided.flowError].filter(Boolean).join('; ') };
    }
    const { incomplete, covered, aspectFailed, boxFailed, sizeFailed } = decided.harvest ?? {};
    const cropFailed = decided.cropFailed;
    // "Something else was on screen" is a worse diagnosis than "some of the screen is missing", and it
    // is the one the operator has to act on, so it wins the single `status` slot.
    const status = covered ? 'interloper' : incomplete ? 'truncated' : aspectFailed || boxFailed || cropFailed || sizeFailed ? 'failed' : null;
    if (!status) return null;
    return { status, error: [covered, incomplete, aspectFailed, boxFailed, cropFailed, sizeFailed].filter(Boolean).join('; ') };
  };

  // Whatever is on disk when a run goes wrong has to be findable. These names are dot-prefixed
  // so a bare `ls` hides them, which is exactly how a failed take looks like a lost one.
  // PULL one segment. A failed pull is described like any other dead segment (see inspectSegment): what the
  // file is, in adb's own words (its stderr, which `run` used to send to the terminal only, so the sidecar said
  // just "exited with code 1"), then how its recorder ended (recorderEnding). Measured before: a seg002 whose
  // device file was deleted under the recorder was dropped as "adb pull failed: `adb ... pull ...` exited with
  // code 1", with no word of its recorder failing on its own (exit 233), and the stub a tail-hold rollover spawns
  // (stopped by us 0.02s later, before it created its file) was dropped the same way. Returns null on success.
  const pullSegment = async (seg, localPath) => {
    try {
      const { stdout, stderr } = await execFileP(adb, ['-s', deviceId, 'pull', seg.devicePath, localPath], { maxBuffer: 16 * 1024 * 1024 });
      const said = `${stdout}\n${stderr}`.split('\n').map((l) => l.trim()).filter(Boolean).pop();
      if (said) console.log(said); // "<path>: 1 file pulled, 0 skipped. ..."
      return null;
    } catch (err) {
      const said = String(err.stderr ?? '').trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? err.message;
      const onDevice = await deviceFileExists(seg.devicePath);
      const what = onDevice ? `adb could not pull the file (${said})` : `no file on the device to pull (${said})`;
      seg.lostAs = onDevice ? 'could not be pulled (adb failed on it)' : 'could not be pulled (there was no file on the device)';
      return `${what}: ${recorderEnding(seg)}`;
    }
  };
  const deviceFileExists = async (path) =>
    (await runCapture(adb, ['-s', deviceId, 'shell', `test -e '${path}' && echo yes || echo no`], { timeout: ADB_CLEANUP_TIMEOUT_MS }).catch(() => 'no')).trim() === 'yes';
  // The pulled copy is the device file when the sizes agree: `adb pull` copies bytes, and the recorder
  // has exited by the time anything is pulled. A device that will not answer counts as "does not match",
  // which keeps the device copy: the safe side. An EMPTY file matches too, when both sides really say 0
  // (a recorder that hung before its first write leaves one, and it pulls as 0 bytes): the size must be
  // stat's own digits, never `Number('')`, which is also 0 and is what a failed stat used to look like.
  // Returns { match, remote, local } so a kept device copy can say why it was kept.
  const deviceCopyMatches = async (devicePath, localPath) => {
    const said = (await runCapture(adb, ['-s', deviceId, 'shell', `stat -c %s '${devicePath}'`], { timeout: ADB_CLEANUP_TIMEOUT_MS }).catch(() => '')).trim();
    const remote = /^\d+$/.test(said) ? Number(said) : null;
    const local = await stat(localPath).then((s) => s.size, () => null);
    return { match: remote !== null && local === remote, remote, local };
  };
  const reportKeptFiles = () => {
    const local = tempFiles.filter((path) => existsSync(path));
    if (local.length === 0 && deviceLeftovers.length === 0) return;
    console.error('[film-android] the raw segments are kept for you:');
    for (const path of local) console.error(`[film-android]   ${path}`);
    for (const { path, why } of deviceLeftovers) console.error(`[film-android]   ${deviceId}:${path}  (${why}, so it stays on the device: adb -s ${deviceId} pull ${path})`);
    if (local.length > 0) {
      console.error(
        '[film-android]   (the local ones are dot-prefixed, so `ls` hides them — use `ls -a`. They are ordinary mp4s: ' +
          'play them, or stitch them by hand with ffmpeg\'s concat demuxer.)',
      );
    }
  };

  // ── RECORD_STOP → PULL → STITCH, run exactly once from whichever path gets here first ───────
  // The live INTERLOPER line is printed from under `maestro test`, which inherits this process's
  // stdio and redraws its progress with ANSI escapes — so it can be scribbled over. This block
  // runs after the flow is done and nothing else is drawing, and it is the channel that is
  // actually guaranteed to be readable.
  const reportForeground = () => {
    if (!guard) return;
    if (!interloped()) {
      // Counted by verdict, not as "every row but one": `foreground` also has rows for the app's own
      // activity changes, the home screen before the app came up, and unreadable samples, and none of
      // those is a system surface (measured before: a take with one row per Settings activity was
      // summarised as "1 allowed system surface(s) seen").
      const count = (verdict) => guard.events.filter((e) => e.verdict === verdict).length;
      const notes = [
        count('allowed') > 0 ? `${count('allowed')} allowed system surface(s) seen` : null,
        count('home-before-app') > 0 ? `the home screen before ${guardedApp} first came up` : null,
        count('relaunch') > 0 ? `${count('relaunch')} sighting(s) under ${guardedApp} while its own launchApp restarted it` : null,
        count('unknown') > 0 ? `${count('unknown')} stretch(es) where the foreground could not be read` : null,
      ].filter(Boolean);
      log(`[foreground] clean — no other app covered ${guardedApp}` + (notes.length > 0 ? ` (${notes.join('; ')})` : ''));
      return;
    }
    console.error(`\n[film-android] ⚠️  THIS TAKE IS SUSPECT — ${interloperReason()}.`);
    for (const event of guard.interlopers) {
      console.error(
        `[film-android]    ${event.atSec}s  ${event.package}/${event.activity}` +
          (event.firstSeenSec !== undefined ? ` (first seen ${event.firstSeenSec}s, during the app's own relaunch)` : ''),
      );
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
      // Say what is true: a chain that already died (a recorder that ended unexpectedly, mid-flow or in the
      // tail hold) has nothing left to stop. Measured before: "stopping screen recording..." printed after the
      // recorder was long gone. stop() still runs either way (it settles the chain and the finalize wait).
      if (chain.recorderRunning) log('stopping screen recording...');
      else if (chain.abortSeg) log(`no recorder to stop (${chain.abortSeg.tag} was the last, and it ended unexpectedly); collecting the segments...`);
      else log('no recorder to stop; collecting the segments...');
      await chain.stop();
      log(
        // first spawn to the last recorder's end: the span the durations line calls `recorded`, rounded the same
        // way (the sum of the segments' own walls leaves out the milliseconds between one exit and the next spawn)
        `${segments.length} segment(s), ${(Math.round(recordingSpanSec() * 100) / 100).toFixed(2)}s of wall-clock recording` +
          (segments.length > 1
            ? ` — ${segments.length - 1} seam(s) at ~${segmentSeconds}s intervals (the durations line says what they cost)`
            : ''),
      );

      // PULL, then VALIDATE. One bad segment must never cost the others, so each is judged on
      // its own and the take is assembled from whatever passed (see selectSegments).
      const pulled = [];
      for (const seg of segments) {
        const localPath = join(outDir, `.${outName}.${runTag}.${seg.tag}.mp4`);
        log(`pulling ${seg.devicePath}...`);
        const pullError = await pullSegment(seg, localPath);
        if (pullError === null) {
          tempFiles.push(localPath);
          pulled.push({ seg, localPath, pullError: null });
        } else {
          pulled.push({ seg, localPath: null, pullError });
        }
      }

      // DEVICE COPIES (see KEPT EVIDENCE IS PER RUN). A segment that was pulled, and whose local copy
      // has the device file's size, IS the device file: the local copy is the evidence, kept and named
      // on every unclean exit. So the device copy goes now, on every path, clean or not. Only a segment
      // that could not be pulled (or whose sizes disagree) stays on the device, and is named in the log
      // and in `keptFiles.device`. Measured before: an interrupted take kept its pulled seg001 on
      // /sdcard with `keptFiles.device: []` and no log line, because device copies were removed only on
      // a clean run and only DROPPED segments were ever reported, so nobody would ever remove it.
      for (const { seg, localPath } of pulled) {
        const compared = localPath ? await deviceCopyMatches(seg.devicePath, localPath) : null;
        if (compared?.match) {
          await runCapture(adb, ['-s', deviceId, 'shell', 'rm', '-f', seg.devicePath], { timeout: ADB_CLEANUP_TIMEOUT_MS }).catch(() => {});
        } else if (await deviceFileExists(seg.devicePath)) {
          // Only a file that is really there is "still on the device" (a recorder killed before it wrote
          // anything left none, and the report used to claim it anyway), and the report says WHY it stayed:
          // a pulled file is never called "not pulled".
          deviceLeftovers.push({
            path: seg.devicePath,
            why: !localPath
              ? 'not pulled'
              : compared.remote === null
                ? 'pulled, but the device would not report its size, so the copy is unverified'
                : `pulled, but the local copy is ${compared.local ?? '?'} bytes and the device file ${compared.remote}`,
          });
        }
      }

      const { usable: selected, dropped, lost, lossReason: selectionLoss, staticHeld } = await selectSegments(ffmpeg, pulled);
      // Reassigned below by the TAIL HOLD's planTakeEnd: the segments that are in the take.
      let usable = selected;
      lossReason = selectionLoss;
      for (const drop of dropped) {
        if (drop.emptyTail) {
          // The reason already says how it ended (we stopped it, recorderEnding): only the consequence is added.
          log(`dropping ${drop.seg.tag}, the chain's last link: ${drop.reason}. Nothing that was on screen is missing from the take.`);
        } else {
          // Say where the hole is on the WALL clock, not just that a segment died: the stitched
          // video jumps across it invisibly when the footage either side is static (#19).
          const order = pulled.findIndex((p) => p.seg === drop.seg);
          const wallBefore = pulled.slice(0, order).reduce((s, p) => s + (p.seg.wallSec ?? 0), 0);
          const wallAfter = wallBefore + (drop.seg.wallSec ?? 0);
          // A hole with no usable footage after it is not "the middle": the take simply ends before it, or, with
          // no usable footage at all, there is no take (measured before: "so the take ends before it" said of a
          // single segment SIGKILLed in the tail hold, the run's only footage).
          const usableAfter = selected.some((u) => pulled.findIndex((p) => p.seg === u.seg) > order);
          const consequence =
            selected.length > 0
              ? 'so the take ends before it'
              : pulled.length === 1
                ? 'and it was the only segment, so there is no take'
                : 'and no other segment left any either, so there is no take';
          console.error(
            usableAfter
              ? `[film-android] ⚠️  ${drop.seg.tag} dropped — video jumps from wall ~${wallBefore.toFixed(1)}s ` +
                  `to wall ~${wallAfter.toFixed(1)}s. The middle of the take is missing, even though the ` +
                  `stitched file plays clean. Reason: ${drop.reason}`
              : `[film-android] ⚠️  ${drop.seg.tag} dropped — it filmed wall ~${wallBefore.toFixed(1)}s to ` +
                  `~${wallAfter.toFixed(1)}s and left no usable video, ${consequence}. Reason: ${drop.reason}`,
          );
        }
      }

      // STITCH / FINALIZE. The plan (concat list + the numbers the stitch check compares against)
      // comes from planStitch, which also fixes each segment's slot in the timeline.
      // Which segments had a successor that started (every one but the last spawned): those ran as
      // non-final segments of the chain and own min(wall, limit) even if the successor was lost.
      segments.forEach((seg, i) => {
        seg.hadSuccessor = i < segments.length - 1;
      });
      // TAIL HOLD: pin the take's end when the flow ended on its own (see the header). Segments that
      // started after the end filmed only the hold, and a dead one of those is not lost footage.
      let takeEnd = null;
      if (tailHold && tailHold.holdEndMs === null) {
        // A signal's harvest can get here before holdTail() has returned: the hold ended now, by the signal.
        tailHold.endedBy ??= 'interrupted';
        tailHold.holdEndMs = Date.now();
      }
      if (tailHold) {
        takeEnd = planTakeEnd(usable, {
          flowEndMs: tailHold.flowEndMs,
          backlogUntilMs: tailHold.firstIdleMs ?? null,
          segmentSeconds,
        });
        if (takeEnd) {
          usable = takeEnd.kept;
          const afterTake = lost.filter((seg) => segmentAnchor(seg).videoZeroWallMs >= takeEnd.takeEndMs);
          if (afterTake.length > 0) {
            const stillLost = lost.filter((seg) => !afterTake.includes(seg));
            lost.splice(0, lost.length, ...stillLost);
            log(`${afterTake.map((seg) => seg.tag).join(', ')}: unusable, but started after the take's end — not lost footage`);
          }
          if (takeEnd.afterTake.length > 0) {
            log(`${takeEnd.afterTake.map(({ seg }) => seg.tag).join(', ')}: filmed only after the take's end (the tail hold) — left out`);
          }
        }
      }
      // What the lost segments cost, split at the flow's end when the flow ended on its own (lostSegmentsReason).
      lossReason = lostSegmentsReason(lost, { flowEndMs: chain.flowEndedAt });
      // RECORDER DEATH: judged ONCE, here, where both halves are known: when the recorder died against the flow
      // (the chain's abort) and whether its file survived (selectSegments, and the take's end above). Measured
      // before: a SIGKILL in the tail hold printed "... so nothing the take owed was still to come" live and again
      // with "— not a truncation" here, and then the take was `truncated` (the lost segment) or `failed` (nothing
      // left to stitch). The death in the hold cut nothing off the flow; a SIGKILL's lost file did.
      const abortSeg = chain.abortSeg;
      if (abortSeg) {
        if (chain.abortCutFlow) {
          console.error(`[film-android] ⚠️  ${chain.abortReason}.`);
        } else if (lost.includes(abortSeg)) {
          abortSegLost = true;
          console.error(
            `[film-android] ⚠️  ${chain.abortReason}. The death cut nothing off the flow, but it left no usable file, ` +
              `so what ${abortSeg.tag} filmed up to the flow's end is lost` +
              (usable.length > 0 ? ': the take is truncated by that loss.' : ', and no other segment holds footage: there is no take.'),
          );
        } else if (selected.some((u) => u.seg === abortSeg)) {
          log(`${chain.abortReason}. It cut nothing off the flow and its file is usable, so this is not a truncation.`);
        } else {
          log(`${chain.abortReason}. It started after the take's end, so its unusable file holds nothing of the take.`);
        }
      }
      if (usable.length === 0) {
        // Why, in the drop reasons' own words (each says what the file is and how its recorder ended).
        throw new Error(
          `no segment produced a usable file, so there is nothing to stitch (${dropped.map((d) => `${d.seg.tag}: ${d.reason}`).join('; ')})`,
        );
      }
      const plan = planStitch(usable, segmentSeconds, { log, end: takeEnd?.end ?? null });
      staticSegments = staticHeld.map((seg) => {
        const index = usable.findIndex((u) => u.seg === seg);
        return {
          segment: seg.tag,
          index: seg.index,
          position: usable.length === 1 ? 'only' : index === 0 ? 'first' : index === usable.length - 1 ? 'final' : 'middle',
          wallSec: Number((seg.wallSec ?? 0).toFixed(3)),
          heldSec: Number((seg.timelineSec ?? 0).toFixed(3)),
          exitCode: seg.exitCode,
          signal: seg.signal,
        };
      });
      for (const held of staticSegments) {
        log(
          `static segment held: ${held.segment} (${held.position}) watched a still screen for its whole ` +
            `${held.wallSec.toFixed(1)}s (1 frame; ${recorderEnding(segments.find((x) => x.tag === held.segment))}) — ` +
            `its own frame is held for ${held.heldSec.toFixed(1)}s`,
        );
      }
      let stitch = null;
      if (!plan.needsConcat) {
        // Single-segment path — identical to what this tool did before chaining existed: pull one
        // file, remux with stream copy + faststart. No concat list, no timestamp rewriting.
        log(`finalizing ${outPath}...`);
        await finalizeVideo(ffmpeg, usable[0].localPath, outPath, { verbose, crf, tailExtend: plan.tailExtend });
      } else {
        const listPath = join(outDir, `.${outName}.concat.txt`);
        await writeFile(listPath, concatListBody(plan.entries), 'utf8');
        log(`stitching ${usable.length} segments into ${outPath}...`);
        const diagnostics = await stitchSegments(ffmpeg, listPath, outPath, { crf, tailExtend: plan.tailExtend });
        await rm(listPath, { force: true });
        stitch = {
          plannedSec: plan.plannedSec,
          plannedMaxSec: plan.plannedMaxSec,
          actualSec: null,
          driftSec: null,
          nonMonotonicDtsWarnings: diagnostics.nonMonotonicDts,
          reencoded: diagnostics.reencoded,
          // seconds the last segment's final packet was extended by to keep its slot (a lost
          // successor), or null
          tailExtendedSec: plan.tailExtend ? Number(plan.tailExtend.extSec.toFixed(3)) : null,
          ok: null,
        };
      }

      // Where each surviving segment sits in the finished file, and what wall clock its own
      // frame 0 was. This is built from the SAME numbers the concat directives were built from,
      // deliberately: if the rings are placed against a different timeline than the demuxer laid
      // down, they drift by exactly the difference. The last segment's slot has no span — it
      // plays out to the end of the video, and the mapper clamps to the file's real duration.
      timeline = usable.map(({ seg }, i) => {
        const { videoZeroWallMs, source, note } = segmentAnchor(seg);
        // A segment that fell back is a segment whose rings are ~0.2s looser, and the operator
        // has to be told which one and why — silence here is how a buffered stdout would look
        // exactly like a device with no taps.
        if (note) console.error(`[film-android] ⚠️  ${seg.tag}: ${note} — anchoring its taps on ${source} instead.`);
        return {
          tag: seg.tag,
          // the chain position: two kept slots whose indexes are not consecutive have lost segment(s) between them
          index: seg.index,
          startedAt: seg.startedAt,
          contentArea: seg.contentArea,
          offsetSec: usable.slice(0, i).reduce((sum, { seg: prev }) => sum + (prev.timelineSec ?? 0), 0),
          spanSec: i === usable.length - 1 ? null : (seg.timelineSec ?? null),
          videoZeroWallMs,
          anchorSource: source,
          anchorNote: note,
        };
      });

      // TAIL HOLD report: where the flow and the take ended in the video, and whether the encoder is
      // known to have written everything up to the flow's end (`covered`: true when it drained, or when it
      // wrote a frame past the flow's end; false when it was still busy at the cap and wrote nothing past
      // it, i.e. frames were lost; null when unknowable: a fixed hold that saw no frame past the end, which
      // is also what a screen that stood still looks like).
      if (tailHold) {
        // The last kept slot ends where the take is pinned (takeEnd.end.endSec): a wall instant past it (the flow's
        // end inside a LOST flow segment) has no video time, and is null rather than a time past the file's end.
        // Measured before: a take whose flow segment was SIGKILLed in the hold said `takeEndSec: 20.128` for a
        // 10.00s file.
        const lastSlot = timeline[timeline.length - 1];
        const lastSlotSec = takeEnd ? takeEnd.end.endSec : null;
        const toVideoSec = (wallMs) => {
          let slot = null;
          for (const s of timeline) if (s.videoZeroWallMs <= wallMs) slot = s;
          if (!slot) return null;
          const into = (wallMs - slot.videoZeroWallMs) / 1000;
          if (slot === lastSlot && lastSlotSec !== null && into > lastSlotSec + 0.001) return null;
          return slot.offsetSec + (slot.spanSec === null ? into : Math.min(into, slot.spanSec));
        };
        const r3 = (n) => (n === null || n === undefined ? null : Number(n.toFixed(3)));
        // Judged on the segment that was recording when the flow ended (see ROLLOVER at holdTail).
        const pastFlowSec = takeEnd?.flowSegLastFrameWallMs != null ? (takeEnd.flowSegLastFrameWallMs - tailHold.flowEndMs) / 1000 : null;
        // That segment LOST (a recorder SIGKILLed in the hold leaves no moov atom): the flow's end is known not
        // to be on film. `covered` is false, and the loss is already reported as the truncation, so none of the
        // hold's "still screen or lost" warnings applies.
        const flowSeg = [...segments].reverse().find((seg) => segmentAnchor(seg).videoZeroWallMs < tailHold.flowEndMs) ?? null;
        const flowSegLost = flowSeg !== null && lost.includes(flowSeg);
        const covered = flowSegLost
          ? false
          : tailHold.endedBy === 'drained' || (pastFlowSec !== null && pastFlowSec >= 0)
            ? true
            : tailHold.endedBy === 'cap'
              ? false
              : null;
        tailReport = {
          watch: tailHold.watch,
          encoder: tailHold.encoder,
          ...(tailHold.note ? { note: tailHold.note } : {}),
          endedBy: tailHold.endedBy,
          holdSec: r3((tailHold.holdEndMs - tailHold.flowEndMs) / 1000),
          capSec: (tailHold.watch === 'codec-cpu' ? TAIL_HOLD_CAP_MS : TAIL_HOLD_FALLBACK_MS) / 1000,
          samples: tailHold.samples,
          // how long after the flow's end the codec was first seen idle (its backlog drained), or null
          backlogSec: tailHold.firstIdleMs != null ? r3((tailHold.firstIdleMs - tailHold.flowEndMs) / 1000) : null,
          flowEndSec: r3(toVideoSec(tailHold.flowEndMs)),
          takeEndSec: takeEnd ? r3(lastSlot.offsetSec + takeEnd.end.endSec) : null,
          // the segment recording at the flow's end held no usable video (see `covered`)
          ...(flowSegLost ? { flowSegmentLost: flowSeg.tag } : {}),
          // the take's last picture is held this long to its end (no frame came: the screen stood still)
          heldSec: takeEnd ? r3(takeEnd.end.endSec - takeEnd.end.lastKeptSec) : null,
          // frames the recorder wrote after the take's end, cut (outpoint), and the segments left out whole
          cutFrames: takeEnd?.cutFrames ?? null,
          afterTakeSegments: takeEnd ? takeEnd.afterTake.map(({ seg }) => seg.tag) : [],
          // the last frame the segment recording at the flow's end wrote, against that end (wall s; negative = before)
          lastFrameVsFlowEndSec: r3(pastFlowSec),
          covered,
          unwrittenSec: covered === false && pastFlowSec !== null ? r3(-pastFlowSec) : 0,
        };
        log(
          `tail hold: ${tailReport.holdSec.toFixed(2)}s after the flow, ended by ${tailReport.endedBy}` +
            (tailReport.watch === 'codec-cpu' ? ` (${tailReport.encoder} watched)` : ` (fixed: ${tailReport.note})`) +
            (tailReport.takeEndSec === null
              ? ''
              : flowSegLost
                ? `; the take ends at ${tailReport.takeEndSec.toFixed(2)}s, short of the flow's end: ${flowSeg.tag}, the segment recording it, was lost`
                : `; the take ends at ${tailReport.takeEndSec.toFixed(2)}s, ${((takeEnd.takeEndMs - tailHold.flowEndMs) / 1000).toFixed(2)}s after the flow ended`),
        );
        if (tailReport.endedBy === 'rollover' && covered === null) {
          console.error(
            `[film-android] ⚠️  the segment recording when the flow ended reached its --segment-seconds limit during the tail ` +
              `hold, and a limit stop discards what the encoder still held: its last frame is ` +
              `${Math.abs(tailReport.lastFrameVsFlowEndSec ?? 0).toFixed(2)}s before the flow's end, which is either a still ` +
              'screen or the flow\'s last moments lost at that seam (see CAP / SEGMENT CHAIN).',
          );
        }
        if (tailReport.endedBy === 'recorder-gone' && covered === null) {
          // A recorder that dies discards what its encoder still held, like a limit stop (see TAIL HOLD).
          console.error(
            `[film-android] ⚠️  the recorder died during the tail hold before it wrote a frame past the flow's end: the ` +
              `take's last frame is ${Math.abs(tailReport.lastFrameVsFlowEndSec ?? 0).toFixed(2)}s before the flow's end, ` +
              "which is either a still screen or the flow's last moments lost with the encoder's queue.",
          );
        }
        if (covered === false && !flowSegLost) {
          console.error(
            `[film-android] ⚠️  the encoder was still behind when the tail hold hit its ${tailReport.capSec}s cap: the last ` +
              `${tailReport.unwrittenSec.toFixed(2)}s of the flow never reached the file (the screen was changing on every frame).`,
          );
        }
      }

      let finalProbe = await probeVideo(ffmpeg, outPath);
      // The stitched file's own length, before any --trim-head/--trim-tail: the durations line accounts
      // for the wall clock against THIS, and for the trims separately.
      const stitchedSec = finalProbe.durationSec ?? null;
      recordedSize = finalProbe.size ?? null;

      // TRIM HEAD/TAIL (#4): cut wall-clock head/tail you didn't author off the stitched file,
      // before taps are placed. Re-encoded (VFR-safe); timeline slots shift by -trimHead.
      let trim = null;
      if (trimHead > 0 || trimTail > 0) {
        try {
          trim = await trimRecording(ffmpeg, outPath, { trimHead, trimTail, verbose, crf });
          if (trim.applied) {
            log(`trimmed ${trimHead.toFixed(2)}s head + ${trimTail.toFixed(2)}s tail → ${trim.lengthSec.toFixed(2)}s`);
            for (const slot of timeline) slot.offsetSec = Math.max(0, slot.offsetSec - trim.startSec);
            finalProbe = await probeVideo(ffmpeg, outPath);
          }
        } catch (err) {
          console.error(`[film-android] trim failed (${err.message}) — keeping the untrimmed take`);
          trim = { applied: false, reason: err.message };
        }
      }

      // Seam offsets for the console: the moment you still remember what happened when (#17).
      if (timeline.length > 1) {
        const offsets = timeline.slice(1).map((_, i) => timeline.slice(0, i + 1).reduce((s, sl) => s + (sl.spanSec ?? 0), 0));
        log(`seams at ${offsets.map((o) => `${o.toFixed(1)}s`).join(', ')} (${timeline.length - 1} seam(s))`);
      }

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

      // RESOLUTION check (see the SIZE header). Two different questions with two different
      // consequences. (1) ASPECT: is the picture the device's shape? A recorder that fell back
      // (720x1280 for a 1344x2992 panel) pillarboxes the screen, so the take is unusable and always
      // fails, --strict-size or not; the preflight makes this unreachable unless it could not probe
      // (no readable `wm size`) or the encoder changed its mind after it, which is why this stays as the net. (2) SIZE: did screenrecord record exactly
      // what it was asked for? Same aspect at another size (a smaller-but-proportional fallback)
      // is worth a warning, and a failure only under --strict-size, as before.
      const expectNative = orientedNative ?? nativeSize;
      const askedSize = recordSize ?? expectNative;
      let sizeMismatch = null;
      let aspectMismatch = null;
      const aspectOk = !(expectNative && finalProbe.size) || sameAspect(finalProbe.size, expectNative);
      const rotated = askedSize && finalProbe.size && finalProbe.size === askedSize.split('x').reverse().join('x');
      const sizeMatch = !(askedSize && finalProbe.size) || finalProbe.size === askedSize || rotated;
      sizeCheck = { expected: askedSize ?? null, actual: finalProbe.size ?? null, aspectOk, sizeMatch: Boolean(sizeMatch) };
      // (3) LETTERBOX vs CROP: screenrecord's own content-area line, per segment, against that
      // segment's video size, through planCrop. A picture short of the frame by at most
      // CROP_TOLERANCE_PX per axis is float truncation in screenrecord's content rectangle (see the
      // SIZE header): it is PLANNED for trimming in the finishing encode (the tap burn's own pass), so
      // the delivered take has no bar. Anything beyond that is a real letterbox and fails the take,
      // like the aspect check, whether or not --strict-size was passed.
      const planned = usable.filter(({ seg }) => seg.contentArea && seg.size).map(({ seg }) => ({ seg, plan: planCrop(seg.contentArea, seg.size) }));
      let letterboxMismatch = null;
      cropPlan = null;
      const firstArea = usable.find(({ seg }) => seg.contentArea)?.seg.contentArea ?? null;
      sizeCheck.contentArea = firstArea;
      const bad = planned.filter(({ plan }) => plan.kind === 'letterbox');
      const kinds = new Set(planned.map(({ plan }) => plan.kind));
      const cropKeys = new Set(planned.filter(({ plan }) => plan.kind === 'crop').map(({ plan }) => JSON.stringify(plan.crop)));
      if (bad.length > 0) {
        letterboxMismatch = bad[0].plan.reason + (bad.length > 1 ? ` (${bad.length} of ${usable.length} segments)` : '');
      } else if (kinds.has('crop') && (kinds.size > 1 || cropKeys.size > 1)) {
        letterboxMismatch = 'the segments disagree about the picture area, so one crop cannot fit them all: ' + [...cropKeys, ...[...kinds].filter((k) => k !== 'crop')].join(' / ');
      } else if (kinds.has('crop')) {
        const { plan } = planned.find(({ plan: pl }) => pl.kind === 'crop');
        cropPlan = { ...plan.crop, contentArea: plan.contentArea, reason: plan.reason };
        log(`crop planned: ${plan.reason}`);
      }
      sizeCheck.contentFits = planned.length === 0 ? 'unknown' : letterboxMismatch ? 'letterbox' : cropPlan ? 'crop' : 'fill';
      if (letterboxMismatch) {
        console.error(
          `\n[film-android] ⚠️  LETTERBOXED: ${letterboxMismatch}.\n` +
            '[film-android]    More than a float-truncation pixel or two of the frame is bar, so this take is failed ' +
            '(this check ignores --strict-size). Omit --size and let the size preflight pick a size.\n',
        );
      }
      if (!aspectOk) {
        aspectMismatch = `recorded at ${finalProbe.size}, which is not the device's aspect ratio (${expectNative})`;
        console.error(
          `\n[film-android] ⚠️  ASPECT MISMATCH: ${aspectMismatch}.\n` +
            "[film-android]    screenrecord's encoder refused the geometry and silently fell back, so the screen sits " +
            'pillarboxed inside the frame.\n' +
            '[film-android]    This take is unusable and is being failed (this check ignores --strict-size). ' +
            "Let the size preflight pick a size (omit --size), or pass one the encoder accepts.\n",
        );
      } else if (!sizeMatch) {
        sizeMismatch =
          `recorded at ${finalProbe.size}, but ` +
          `${size ? `--size ${size} was requested` : recordSize ? `${recordSize} was pinned by the size preflight` : `the device reports ${expectNative}`}`;
        console.error(
          `\n[film-android] ⚠️  RESOLUTION MISMATCH: ${sizeMismatch}.\n` +
            "[film-android]    screenrecord's encoder almost certainly refused that geometry and " +
            'silently fell back (look for an "unable to configure video/avc codec" line above).\n' +
            `[film-android]    Re-film with an explicit --size the encoder accepts if this take has ` +
            'to intercut with others.\n',
        );
        if (strictSize) {
          console.error('[film-android]    --strict-size: treating the mismatch as a failure.');
        }
      }

      // Decided now, before the cleanup awaits below (see DECIDED FAILURES). Not when a signal already
      // started this salvage: then the signal is what ended the take.
      if (!interrupted) decided.harvest = harvestVerdicts({ sizeMismatch, aspectMismatch, letterboxMismatch });

      // CLEANUP is conditional: a clean run leaves nothing behind, an unclean one leaves
      // everything behind and says where. Deleting the evidence of a bad take is the one
      // unrecoverable move available here.
      // A chain abort is unclean even when every pulled segment was usable (a recorder that exited early
      // with a good file): the rest of the flow is not on camera, the take is `truncated`, and its segments
      // are the evidence. Measured before: a chain that died on a 0.33s-old recorder deleted the kept seg001
      // (`keptFiles.local: []`) because only `lost` was consulted.
      // A recorder that died AFTER the flow (abortCutFlow false) does not make the run unclean: the take holds
      // the whole flow, its kept segments are in it by stream copy, and the death itself (exit, stdout) is in
      // `recording.segments`. Keeping them would make kept segments stop meaning "footage is missing". If the
      // death also cost footage (a SIGKILLed flow segment has no moov atom), that segment is lost: unclean.
      const clean = lost.length === 0 && !chain.abortCutFlow && !interrupted && (stitch === null || stitch.ok);
      if (clean) {
        // Every local temp, not just the ones that made the cut — an empty trailing segment left
        // behind as a hidden `.<name>.<run>.<tag>.mp4` is the exact confusion this is meant to avoid.
        // The pulled segments' device copies are already gone (above); a device file left because its
        // pull failed can only be, on a clean run, an empty trailing one WE stopped (stoppedByUs) or one
        // that filmed only after the take's end, so it goes too.
        for (const path of tempFiles) await rm(path, { force: true });
        for (const { path } of deviceLeftovers) {
          await runCapture(adb, ['-s', deviceId, 'shell', 'rm', '-f', path], { timeout: ADB_CLEANUP_TIMEOUT_MS }).catch(() => {});
        }
        tempFiles.length = 0;
        deviceLeftovers.length = 0;
      } else {
        reportKeptFiles();
      }

      // takeSec: the take as harvest leaves it (stitched, trimmed), before any finishing encode re-times it
      return { ok: true, finalProbe, stitchedSec, takeSec: finalProbe.durationSec ?? null, stitch, trim, sizeMismatch, aspectMismatch, letterboxMismatch, lost: [...lost] };
    } catch (err) {
      console.error(`[film-android] failed to save the recording: ${err.message}`);
      reportKeptFiles();
      // Whether rings were owed is Maestro's record's business, whatever became of the footage, so a take that
      // saved nothing says it too (measured before: `tapsExpected: false` on a flow that tapped twice, its only
      // segment SIGKILLed in the tail hold). Main's path only: a signal's harvest runs while maestro may still
      // be writing that record, and the handler reads it only once maestro is gone.
      if (!interrupted && showTapsRequested) tapsExpected = flowHasTapCommands(await readFile(flowPath, 'utf8').catch(() => ''), debugDir);
      // Same rule as every other failed run (#13): step aside so the take number stays free, and put the
      // previous take back. The sidecar used to be written at the plain name here, which refused the
      // retake in preflight.
      await failTake({ status: 'failed', error: err.message }, { salvage: true });
      return { ok: false, finalProbe: null, stitch: null, error: err.message };
    }
  }

  const runHarvest = () => (harvestPromise ??= harvest());

  // DURATION HONESTY (accountDurations): fills `outcome.durations` and prints the durations line, once per
  // outcome, on EVERY exit that has a harvested take: main's own path, the signal handler and the unplanned-
  // error exit. Measured before: only main's path computed them, so an interrupted take had
  // `recording.durations: null` and printed no line. The handler calls it once maestro has exited, so the
  // flow's end is known (it is the stopped child's exit).
  // A burn or finishing encode that completed before main re-probed (a signal or an error right after it) left
  // outcome.finalProbe describing the file it replaced: read the written one, unless the durations are already in.
  const probeWritten = async (outcome) => {
    if (!outcome?.ok || outcome.durations || !finished()) return;
    const probe = await probeVideo(ffmpeg, outPath).catch(() => null);
    if (probe?.durationSec != null) outcome.finalProbe = probe;
  };
  // `fileSec` is the WRITTEN file's (outcome.finalProbe, re-probed after the finishing encode by every caller),
  // `takeSec` the take before that encode. `again` (SALVAGE RINGS: the ring pass rewrote the file) recomputes
  // against the new file and prints the line again, labelled.
  const recordDurations = (outcome, { again = null } = {}) => {
    if (!outcome?.ok || (outcome.durations && !again)) return;
    const accounted = accountDurations({
      segments,
      timeline,
      lost: outcome.lost ?? [],
      maestroStartedAt,
      lastAttemptStartedAt,
      lastAttemptEndedAt,
      holdEndMs: tailHold ? (tailHold.holdEndMs ?? null) : null,
      stitchedSec: outcome.stitchedSec ?? null,
      takeSec: outcome.takeSec ?? null,
      fileSec: outcome.finalProbe?.durationSec ?? null,
      pinnedEnd: tailReport?.takeEndSec != null,
    });
    if (!accounted) return;
    log(again ? accounted.line.replace(/^durations:/, `durations (${again}):`) : accounted.line);
    outcome.durations = accounted.durations;
  };

  // NOTHING FILMED: a signal that arrives before any flow command started (during the warmup, the
  // maestro JVM's startup, a startup retry's backoff) ends a run that filmed nothing but the screen as it
  // was. It is a setup-phase signal in effect: stop the recorder, remove this run's segments (device and
  // debug spill; nothing was pulled), no take, no sidecar, the previous take back, the signal's exit code.
  // Measured before: a signal right as recording started wrote `.failed-N.json` (status failed) for a
  // `.failed-N.mp4` that did not exist, the segment "still on the device" (it was not). The failed
  // startup attempts' logs are kept (and named) if there were any: they are why the flow never began.
  const discardNothingFilmed = async (signalName) => {
    await guard?.stop().catch(() => {});
    await chain.stop().catch(() => {});
    for (const seg of segments) {
      await runCapture(adb, ['-s', deviceId, 'shell', 'rm', '-f', seg.devicePath], { timeout: ADB_CLEANUP_TIMEOUT_MS }).catch(() => {});
    }
    await rm(debugDir, { recursive: true, force: true });
    if (maestroRetries.length > 0) reportAttempts();
    else await rm(attemptsDir, { recursive: true, force: true });
    console.error(`[film-android] ${signalName} arrived before the flow started — nothing was filmed: no take, no sidecar.`);
    await restorePrevious();
  };

  // Without this handler Node's default SIGINT disposition kills the process on the spot: the
  // on-device recorder keeps running, the segments are never pulled, and the take is gone. With
  // it, Ctrl-C is just another way to reach harvest() — stop, pull, stitch, sidecar — and exit
  // non-zero (130, the shell's convention for it).
  //
  // A second window this same handler has to cover: SHOW_TAPS's burn, which runs AFTER harvest()
  // has already completed on the normal path. `burning` says whether that ffmpeg is live right
  // now; if it is, `burnAbortController` is what stops it (SIGTERM, escalating to SIGKILL — see
  // burnTapRipples) instead of leaving it to race process.exit() or rely on the terminal having
  // delivered SIGINT to the whole process group by other means. `pendingBurn` is awaited (its
  // rejection swallowed — drawTaps' own cleanup already said what needed saying) before touching
  // the sidecar or exiting, so the encoder is fully torn down and its partial output already
  // removed by the time this process disappears, not merely asked to be.
  // SIGHUP takes the same route (exit 129, the shell's convention): it is what a camera launched
  // from an agent's shell or a terminal receives when that shell's turn ends or the terminal
  // closes (FEEDBACK #29). Measured before this existed: node dies on Node's default disposition,
  // no .mp4 and no sidecar, and the maestro child and the recorder are left running.
  const onInterrupt = (signalName, exitCode) => {
    if (takeComplete) {
      // The new take is final, so it owns the names: drop the previous take's stash now, synchronously
      // (discard does its file work before returning), because a second signal below exits at once.
      stash?.discard();
      // The take is finished and its `ok` sidecar is written (or being written): a signal now can only
      // mean "stop the scenario checks". Nothing is salvaged and the status stays `ok`. main() sees
      // scenarioSignalExit after each scenario step, records how far it got, and exits with the code.
      // A SECOND signal is the operator insisting: kill the verify run outright and go.
      if (scenarioSignalExit !== null) {
        verifyHandle?.kill();
        process.exit(exitCode);
      }
      scenarioSignalExit = exitCode;
      console.error(`\n[film-android] ${signalName} — the take is already saved; stopping the scenario checks (a second signal exits now).`);
      verifyHandle?.abort();
      return;
    }
    if (salvageBurn) {
      // SALVAGE RINGS: the take and its sidecar are already final; this signal only skips the second pass.
      // Its owner rewrites the sidecar (the rings were skipped, and why) and exits as it was going to.
      if (!salvageBurn.skippedBy) {
        salvageBurn.skippedBy = signalName;
        console.error(`\n[film-android] ${signalName} — skipping the tap indicators; the take is already saved without them.`);
        salvageBurn.controller.abort();
      }
      return;
    }
    if (interrupted) {
      // After a hangup there is nobody to read this and the write is swallowed; after Ctrl-C it is
      // the operator being told not to bother.
      console.error(`[film-android] still saving what was filmed — a second ${signalName} will not make it faster.`);
      return;
    }
    interrupted = true;
    interruptedBy = signalName;
    // Said as it is: past harvest (the burn, tighten) or after the chain died, no recorder is rolling.
    console.error(
      chain?.recorderRunning
        ? `\n[film-android] ${signalName} — stopping the recorder and saving what was filmed so far...`
        : `\n[film-android] ${signalName} — no recorder is rolling any more; saving what was filmed...`,
    );
    // The flow must not outlive the take: a maestro still running would keep tapping a device
    // nothing is recording. Started now, awaited before exit. (A terminal signal reaches it through
    // the process group too; a signal to this pid alone does not.)
    const stoppingMaestro = stopMaestro(signalName);
    // NOTHING FILMED (see the header): judged on maestro.log as it stands at the signal, before the
    // stopping maestro can add to it. An unreadable log counts as "ran": that answer keeps the take.
    const commandRan = maestroCommandRan(debugDir).catch(() => true);
    const abortingBurn = burning;
    if (abortingBurn) {
      console.error('[film-android] a tap-indicator burn is in progress — stopping the encoder (the rings are drawn again once the take is saved)...');
      burnAbortedBySignal = true;
      burnAbortController?.abort();
    }
    const abortingTighten = pendingTighten !== null;
    if (abortingTighten) {
      console.error('[film-android] --tighten is in progress — stopping it...');
      tightenAbortController?.abort();
    }
    // tighten() settles only after its ffmpeg child has exited and its temp output is gone. It
    // rejects with AbortError when the abort landed first (nothing on disk: no `-tight.mp4`), and
    // RESOLVES if it had already finished (the `-tight.mp4` is complete and is described below).
    let tightSettled = null;
    (abortingBurn && pendingBurn ? pendingBurn.catch(() => {}) : Promise.resolve())
      .then(() => (abortingTighten ? pendingTighten.then((r) => (tightSettled = r), () => {}) : undefined))
      .then(() => dropPreBurn())
      .then(async () => ((await commandRan) ? runHarvest() : null))
      .then(async (outcome) => {
        if (outcome === null) {
          await discardNothingFilmed(signalName);
          return;
        }
        reportForeground(); // an interloper may well be WHY the operator hit Ctrl-C
        reportAttempts();
        // The flow's end (the stopped child's exit) and its final command record exist only once maestro is
        // gone; bounded by MAESTRO_ABORT_GRACE_MS (SIGKILL after it). Then the durations line and
        // `tapsExpected` are computed exactly as main's path does (DURATION HONESTY; a take that tapped and was
        // interrupted used to say `tapsExpected: false`).
        await stoppingMaestro;
        if (outcome.ok) {
          await probeWritten(outcome);
          recordDurations(outcome);
          if (showTapsRequested) tapsExpected = flowHasTapCommands(await readFile(flowPath, 'utf8').catch(() => ''), debugDir);
        }
        // An interrupt racing a failure exit already under way is that failure, not an interrupted take:
        // wait for the whole of it (move, sidecar, restore; see failTake), bounded by FAIL_EXIT_WAIT_MS.
        // (A harvest that failed went through failTake too, and has no take to keep.)
        if (failTakePromise) {
          const settled = await Promise.race([
            failTakePromise.then(() => true, () => true),
            sleep(FAIL_EXIT_WAIT_MS).then(() => false),
          ]);
          if (!settled) {
            console.error(
              `[film-android] ⚠️  the failed take was still being set aside after ${FAIL_EXIT_WAIT_MS / 1000}s — ` +
                `exiting without waiting for it; its sidecar may be missing.`,
            );
          }
        }
        const tightDone = tightSettled && !tightSettled.skipped ? tightSettled : null;
        const tightRecord = tightDone
          ? {
              path: tightDone.outPath,
              durationSec: tightDone.fileDurationSec ?? null,
              plannedDurationSec: Number(tightDone.outDuration.toFixed(3)),
              cuts: tightDone.cuts,
              removedSec: removedOfFiles(tightDone, tightDone.fileDurationSec ?? null),
              plannedRemovedSec: Number(tightDone.removedSec.toFixed(3)),
              detectFrom: tightDone.detectFrom ?? null,
              detectMode: tightDone.detectMode,
              protected: tightDone.protected,
              note: 'the signal arrived after tighten finished; this file is complete',
            }
          : null;
        // A failure main had already DECIDED before this signal (see DECIDED FAILURES) is that failure,
        // not an interrupted take: it is set aside with its own status and error (failTake notes the
        // signal), and the previous take comes back. Only a take nothing had failed yet is `interrupted`.
        const failure = outcome.ok && !failTakePromise ? decidedFailure() : null;
        // No finishing encode is coming for this take: crop it by stream copy (SALVAGE CROP), before its
        // sidecar describes it. A no-op when the burn had already cropped it.
        if (outcome.ok && !failTakePromise) await salvageCrop();
        // SALVAGE RINGS: if a second pass will draw them, the first sidecar says so.
        ringsPending = outcome.ok && !failTakePromise && ringsOwed() && (await fileExists(outPath));
        if (failure) {
          console.error(`[film-android] the take had already failed (${failure.status}) before ${signalName} — setting it aside as that, not as interrupted.`);
          const failedFields = {
            ...failure,
            finalProbe: outcome.finalProbe,
            stitch: outcome.stitch,
            trim: outcome.trim ?? null,
            durations: outcome.durations ?? null,
            tightResult: tightRecord,
          };
          await failTake(
            () => failedFields,
            {
              salvage: true,
              afterMove: (renamed) => {
                // a -tight that tighten finished before the signal moved with the take
                const movedTight = tightRecord && renamed.moved.find((m) => m.from === tightRecord.path);
                if (movedTight) tightRecord.path = movedTight.to;
                console.error(`[film-android] the failed take is in ${outPath}.`);
              },
            },
          );
          await salvageRings(outcome, (probe) =>
            writeSidecarSafely(withSignalNote({ ...failedFields, finalProbe: probe ?? failedFields.finalProbe, durations: outcome.durations ?? null })),
          );
        } else if (outcome.ok && !failTakePromise) {
          const interruptedFields = {
            status: 'interrupted',
            error: `interrupted by ${signalName}`,
            finalProbe: outcome.finalProbe,
            stitch: outcome.stitch,
            trim: outcome.trim ?? null,
            durations: outcome.durations ?? null,
            tightResult: tightRecord,
          };
          await writeSidecarSafely(interruptedFields);
          console.error(`[film-android] interrupted — what was filmed is in ${outPath}.`);
          // The interrupted take has a video and a sidecar: it replaces the previous take.
          await keepNewTake();
          await salvageRings(outcome, (probe) => writeSidecarSafely({ ...interruptedFields, finalProbe: probe ?? interruptedFields.finalProbe, durations: outcome.durations ?? null }));
        } else if (!outcome.ok) {
          console.error(`[film-android] interrupted, and nothing usable could be saved (${outcome.error}).`);
          await restorePrevious();
        } else {
          console.error('[film-android] interrupted while a failed take was being set aside — it stays a failed take.');
          await restorePrevious();
        }
      })
      .catch((err) => console.error(`[film-android] could not save the interrupted take: ${err.message}`))
      // Whatever went wrong above: if the previous take was not replaced, it goes back (a no-op once
      // keepNewTake or an earlier restore has settled).
      .then(() => restorePrevious())
      .then(() => stoppingMaestro)
      .finally(() => process.exit(exitCode));
  };
  // Swap the setup-phase handlers (clean exit, nothing filmed) for these (harvest). Synchronous, so
  // there is no instant with neither installed, and synchronous with the chain start above.
  process.off('SIGINT', setupSigint);
  process.off('SIGHUP', setupSighup);
  process.off('SIGTERM', setupSigterm);
  process.on('SIGINT', () => onInterrupt('SIGINT', 130));
  process.on('SIGHUP', () => onInterrupt('SIGHUP', 129));
  // SIGTERM (exit 143) too: an agent harness may TERM a background camera when its turn ends, and
  // the default disposition would kill it with no take, no sidecar, and the recorder still rolling.
  process.on('SIGTERM', () => onInterrupt('SIGTERM', 143));
  chainArmed = true; // see UNPLANNED ERRORS above: the full catch-all from here on

  await sleep(RECORD_WARMUP_MS);

  maestroStartedAt = Date.now();
  // Run from the CALLER's working directory so relative paths inside the flow yaml (screenshots,
  // uploaded files, subflows) resolve against the user's project, not this repo.
  // Spawned here rather than through run() because an interrupt and --guard-strict need the child
  // itself: the `maestro` launcher ends in `exec java`, so this pid IS the JVM and a SIGINT lands
  // on it. --debug-output is on for EVERY run: it is where the tap times come from (an included
  // flow can tap even when this file shows no tap command) and where the startup-retry predicate
  // reads maestro.log and commands-*.json.
  const argsList = ['--device', deviceId, 'test', '-e', 'FILMKIT_MODE=film', '--debug-output', debugDir, flowPath];
  const runMaestroOnce = () =>
    new Promise((resolveFlow, rejectFlow) => {
      lastAttemptStartedAt = Date.now();
      const child = spawn(maestro, argsList, { stdio: 'inherit' });
      maestroChild = child;
      let settle;
      maestroExited = new Promise((r) => (settle = r));
      child.on('error', (err) => {
        maestroChild = null;
        lastAttemptEndedAt = Date.now();
        settle();
        rejectFlow(new Error(`failed to run \`${maestro} ${argsList.join(' ')}\`: ${err.message}`));
      });
      child.on('exit', (code, signal) => {
        maestroChild = null;
        lastAttemptEndedAt = Date.now();
        settle();
        if (signal) return rejectFlow(new Error(`\`${maestro} ${argsList.join(' ')}\` was killed by ${signal}`));
        if (code !== 0) return rejectFlow(new Error(`\`${maestro} ${argsList.join(' ')}\` exited with code ${code}`));
        resolveFlow();
      });
    });
  // Wake early on an interrupt: a 5s retry sleep must not delay the salvage a signal started.
  const sleepUnlessInterrupted = async (ms) => {
    for (let waited = 0; waited < ms && !interrupted; waited += 250) await sleep(Math.min(250, ms - waited));
  };
  // BOUNDED STARTUP RETRY (#27), inside the same recording: the recorder keeps rolling and the
  // extra static head is what tighten / --trim-head cut. The predicate demands both a known startup
  // signature and an empty command record, so a flow that already tapped something is never run
  // twice. At least one retry is always made; after that, none is started once
  // MAESTRO_RETRY_BUDGET_MS has passed since the FIRST failure ended (see the constants for why one
  // retry is not enough). Each failed attempt's log dir is moved out of the debug dir before the
  // next one starts, so the tap parser, the command record and the retry predicate all see only
  // the latest attempt.
  let firstFailureAt = null;
  for (let attempt = 1; ; attempt++) {
    if (interrupted) break;
    if (abortedByGuard) {
      // --guard-strict fired before the flow (or a retry of it) got started: there is no child to
      // stop, and starting one would run the whole flow against a covered screen. Go straight to
      // the failure path with the guard's own reason.
      maestroError ??= new Error('--guard-strict stopped the run before the flow started');
      break;
    }
    try {
      log(`running maestro test ${flowPath}${attempt > 1 ? ` (retry ${attempt - 1})` : ''}...`);
      await runMaestroOnce();
      maestroError = null;
      break;
    } catch (err) {
      maestroError = err;
      if (interrupted || abortedByGuard) break;
      firstFailureAt ??= Date.now();
      const verdict = await maestroStartupUnavailable({ debugDir }).catch(() => null);
      if (!verdict?.retry) break;
      const giveUp = () => {
        const since = Date.now() - firstFailureAt;
        console.error(
          `[film-android] maestro is still unavailable ${(since / 1000).toFixed(0)}s after its first startup ` +
            `failure (${attempt - 1} retr${attempt === 2 ? 'y' : 'ies'} made) — giving up on the retry budget.`,
        );
      };
      // At least one retry is always made; every later one must START inside the budget, checked
      // here and again after the backoff sleep below.
      if (attempt > 1 && Date.now() - firstFailureAt >= MAESTRO_RETRY_BUDGET_MS) {
        giveUp();
        break;
      }
      log(
        `⚠️  maestro failed at startup (${verdict.reason}) — retry ${attempt} in ${MAESTRO_RETRY_BACKOFF_MS / 1000}s, ` +
          'inside the same take',
      );
      const { testDir } = await locateLogs(debugDir);
      if (testDir) {
        try {
          await mkdir(attemptsDir, { recursive: true });
          await rename(testDir, join(attemptsDir, `attempt-${attempt}`));
        } catch (moveErr) {
          // Not fatal, but never silent: if the failed attempt's log stays in the debug dir, the
          // retry predicate and the tap parser still pick the newest run, yet the evidence mixes.
          console.error(`[film-android] ⚠️  could not move the failed attempt's logs out of ${debugDir}: ${moveErr.message}`);
        }
      }
      await sleepUnlessInterrupted(MAESTRO_RETRY_BACKOFF_MS);
      if (interrupted) break;
      if (attempt > 1 && Date.now() - firstFailureAt >= MAESTRO_RETRY_BUDGET_MS) {
        giveUp();
        break;
      }
      maestroRetries.push({ reason: verdict.reason, atSec: Number(((Date.now() - recordingStartedAt) / 1000).toFixed(3)) });
    }
  }
  // The flow's own time is the LAST attempt's; the failed startups and the backoff before it are
  // reported apart, so `flowSec` means the same thing with or without a retry.
  // Decided (see DECIDED FAILURES): the flow failed on its own, not because a signal stopped it.
  if (maestroError && !interrupted) decided.flowError = maestroError.message;

  // A signal during the flow owns the harvest (it may not even run one: NOTHING FILMED).
  if (interrupted) return;
  // The flow ended on its own: a recorder death from here on is in the tail hold, not a truncation.
  chain.markFlowEnded(lastAttemptEndedAt);
  // TAIL HOLD: the flow ended on its own (green, failed, or stopped by --guard-strict). Keep the recorder
  // rolling until the encoder has written what it still holds (see the header). `tailHold` exists from the
  // first instant of the hold, so a signal during it still pins the take to the flow's end.
  if (chain.live) {
    tailHold = { flowEndMs: lastAttemptEndedAt, endedBy: null, watch: null, encoder: null, holdEndMs: null, samples: 0 };
    log('flow ended — holding the recorder until the encoder has written it...');
    const flowSegment = segments[segments.length - 1];
    const held = await holdTail({
      adb,
      deviceId,
      isLive: () => chain.live,
      isInterrupted: () => interrupted,
      flowSegmentEnded: () => flowSegment.wallSec !== null,
    });
    Object.assign(tailHold, held);
    if (interrupted) return; // the handler owns the harvest; it pins the take to the flow's end
  }
  const outcome = await runHarvest();
  if (interrupted) return; // the SIGINT handler owns the sidecar and the exit code
  reportForeground();
  // DURATION HONESTY (#4, accountDurations): one run tells you your overhead, and the parts add up, twice.
  // MEASURED (filmkit_tall, 1144x2546, a running stopwatch filmed in 8s segments): a segment's wall ends
  // when the LOCAL adb client exits, and a SIGINT kills that client at once while the device recorder
  // finalizes on its own (hence the finalize wait). The chain spawns the next segment in the same tick, so
  // the walls tile the take with no gap: the old `seamSec` (span less the sum of walls) was 0.00 by
  // construction and `stopSec` stayed ~0, while 88.98s of wall became an 80.13s file. Anchored, the 10
  // seams dropped 0.35-0.59s each at steady state and 1.57-1.81s while maestro's JVM was starting (7.35s in
  // all), and the last segment wrote 0.13s of footage in its 1.55s after video zero (1.47s tail). Not in
  // these numbers because it IS file time: each time-limited segment's footage ends 0.7-1.1s before its 8s
  // slot does (contentEndSec 6.86-7.30), which the stitch shows as its last frame held (see STITCHING).
  // Recorded once the finishing encode has run (below): `fileSec` is the written file's.
  if (!outcome.ok) {
    // harvest already reported and went through failTake: the take is stepped aside, its sidecar is
    // written and the previous take is back. The last lines say so, as every other failure's do.
    console.error(
      `\n[film-android] there is NO TAKE — ${outcome.error}.\n` +
        `[film-android] status "failed" in ${sidecarPath}.`,
    );
    if (debugKept) console.error(`[film-android] maestro's own debug output was kept: ${debugDir}`);
    reportAttempts();
    process.exit(1);
  }

  // ── SHOW_TAPS. Over the stitched take, before tighten touches it. This runs even when the
  // flow failed: the touches that DID land belong in the partial recording too. Only the policy
  // below is conditional on the flow having succeeded.
  if (showTapsRequested) {
    // Not "does the flow file contain a tapOn" — Maestro's own execution record, which knows the
    // difference between a tap command and a tap command behind a `when:` that never fired.
    tapsExpected = flowHasTapCommands(await readFile(flowPath, 'utf8').catch(() => ''), debugDir);
    try {
      burning = true;
      burnAbortController = new AbortController();
      // keepPreBurn only when --tighten will actually want the pre-burn file (see DETECT-FROM);
      // burning=true/aborter/pendingBurn are set contiguously (no `await` between them) so the
      // SIGINT handler above can never observe `burning` true while `pendingBurn` is still null.
      pendingBurn = drawTaps({
        ffmpeg,
        videoPath: outPath,
        debugDir,
        timeline,
        videoSize: outcome.finalProbe?.size ?? null,
        densityDpi,
        lastSec: outcome.finalProbe?.durationSec ?? Infinity,
        bitRate,
        keepPreBurn: doTighten,
        crf,
        crop: cropPlan,
        signal: burnAbortController.signal,
        maestroStoppedBy,
      });
      tapResult = await pendingBurn;
      if (tapResult === null) {
        noTapsFound = true;
      } else {
        log(
          `drew ${tapResult.taps.length} tap indicator(s) at ${tapResult.fps}fps ` +
            `(${tapResult.encoder}, ${tapResult.elapsedSec.toFixed(1)}s)` +
            (cropPlan ? `, cropped to ${cropPlan.w}x${cropPlan.h}` : ''),
        );
      }
    } catch (err) {
      tapError = err.message;
      tapsOutsideFootage = Boolean(err.outsideFootage);
    } finally {
      burning = false;
      burnAbortController = null;
      pendingBurn = null;
    }
  }
  // FINISHING ENCODE WITHOUT RINGS: a planned crop has to be applied even when there is nothing to
  // draw (--no-show-taps, or a flow that never taps), and it rides in the same pass the rings would
  // have, so it gets the same encoder and quality policy and, under --tighten, the same pre-finish
  // file for freeze detection. Skipped when taps-missing is about to fail the take anyway.
  // TAPS MISSING: a flow that tapped and a take with no rings. Not when every tap fell where a TRUNCATED take
  // has no footage (a lost segment, the rest of the flow after the chain died): there is no frame to draw on,
  // and the take already fails as `truncated`, which is the diagnosis. Measured before: a take whose recorder
  // died mid-flow, its one tap in the lost segment, was failed as `taps-missing`.
  const tapsMissing =
    (tapError !== null || noTapsFound) && tapsExpected && !maestroError && !(tapsOutsideFootage && decided.harvest?.incomplete);
  if (cropPlan && !tapResult && !interrupted && !tapsMissing) {
    try {
      burning = true;
      burnAbortController = new AbortController();
      pendingBurn = finishingEncode({
        ffmpeg,
        videoPath: outPath,
        taps: [],
        crop: cropPlan,
        keepPreBurn: doTighten,
        signal: burnAbortController.signal,
        style: { scale: 3, codec: 'h264', videoBitrate: bitRate, crf },
      });
      finishResult = await pendingBurn;
      log(`finished the take with no rings (${finishResult.encoder}, ${finishResult.elapsedSec.toFixed(1)}s), cropped to ${cropPlan.w}x${cropPlan.h}`);
    } catch (err) {
      cropError = err.message;
    } finally {
      burning = false;
      burnAbortController = null;
      pendingBurn = null;
    }
  }
  cropApplied = Boolean(cropPlan && finished());
  if (cropApplied) cropMethod = 'encode';
  // A Ctrl-C that landed mid-burn is handled entirely by the SIGINT handler (abort, harvest,
  // sidecar, exit 130) — main() must not also report a tap failure and exit(1) for the very
  // AbortError that handler is already racing to clean up after.
  if (interrupted) return;

  // The delivered file is the one with the rings in it, so the duration the sidecar quotes has to
  // be that file's, not the pre-burn probe's. Read here, before any exit below, so every one of them
  // (taps-missing and flow-failed included) describes the file it leaves.
  if (finished()) outcome.finalProbe = await probeVideo(ffmpeg, outPath);
  // DURATION HONESTY: against the WRITTEN file (accountDurations: the 60fps burn ends it on a whole frame).
  recordDurations(outcome);
  if (targetDuration !== null && outcome.finalProbe?.durationSec !== null) {
    const off = outcome.finalProbe.durationSec - targetDuration;
    log(`target ${targetDuration.toFixed(2)}s → landed ${outcome.finalProbe.durationSec.toFixed(2)}s (${off >= 0 ? '+' : ''}${off.toFixed(2)}s)`);
  }

  // Now that tapResult is known, fill in the protected ranges every sidecar write below carries
  // in its top-level `timeline` array — which is what lets a standalone `node tighten.mjs <take>`
  // protect taps without --tighten ever having run in this process.
  tapProtect = tapResult ? tapProtectRanges(tapResult.taps) : [];

  // A flow that tapped and a take with no rings on it is exactly the thing that must not pass
  // quietly. A flow that FAILED is already exiting non-zero with its own error and half of it
  // never ran, so missing rings there are a symptom, not the news — that check comes after this
  // one. A flow in which no tap command ran skips all of it in silence: there was nothing to draw.
  if (tapsMissing) {
    const why = tapError ?? 'maestro logged no touch at all';
    decided.tapsMissing = why; // no signal yet: main returned above if there had been one
    console.error(`\n[film-android] tap indicators could not be derived for "${outName}" — ${why}`);
    console.error(`[film-android]   maestro debug output: ${debugDir}`);
    reportAttempts();
    await dropPreBurn();
    await failTake(
      {
        ...decidedFailure(),
        finalProbe: outcome.finalProbe,
        stitch: outcome.stitch,
        trim: outcome.trim ?? null,
        durations: outcome.durations ?? null,
      },
      {
        afterMove: () => {
          console.error(`[film-android]   the recording was still written, WITHOUT indicators: ${outPath}`);
          console.error('[film-android]   pass --no-show-taps to film without them on purpose.');
        },
      },
    );
    if (interrupted) return; // a signal during the step-aside waited for it and owns the exit code
    process.exit(1);
  }
  if (tapError) log(`⚠️  no tap indicators drawn — ${tapError}`);

  if (maestroError) {
    // interloper or flow-failed, from decided.flowError (recorded when the retry loop ended: main
    // returned above if a signal had stopped the flow instead).
    await dropPreBurn(); // the burn already ran and set the pre-burn copy aside for a --tighten that will not run
    await failTake({
      ...decidedFailure(),
      finalProbe: outcome.finalProbe,
      stitch: outcome.stitch,
      trim: outcome.trim ?? null,
      durations: outcome.durations ?? null,
    });
    if (abortedByGuard) {
      console.error(`\n[film-android] the flow was stopped by --guard-strict, not by its own steps.`);
    } else {
      console.error(`\n[film-android] maestro flow "${outName}" failed: ${maestroError.message}`);
    }
    console.error(`[film-android] the partial recording was still saved to ${outPath} for debugging.`);
    if (debugKept) console.error(`[film-android] maestro's own debug output (logs, failure screenshots): ${debugDir}`);
    reportAttempts();
    if (interrupted) return; // a signal during the step-aside waited for it and owns the exit code
    process.exit(1);
  }

  // The branch record (which `runFlow: when:` blocks ran) exists only in this spill, which is about
  // to go: read it now. Cheap (a few small JSON files locateLogs already found for the tap parse) and
  // it never fails the take. atSec is wall seconds since the recorder started, the same clock as
  // `maestroRetries[].atSec` (not video time: head trims and static holds are not applied).
  try {
    const { branches, filesRead } = await readBranches({ debugDir, recordingStartedMs: recordingStartedAt });
    branchList = filesRead > 0 ? branches : null;
  } catch (err) {
    branchList = null;
    log(`⚠️  could not read the branch record — ${err.message}`);
  }

  // Maestro's spill is NOT removed here, though the flow passed: the take can still fail (interloper,
  // truncated, a geometry or crop verdict), and the spill is kept on any failure. It goes just before the
  // `ok` sidecar is written (below). Measured before: it was removed here whenever maestro succeeded, so
  // an interloper take kept no spill and its sidecar said `debugOutput: null`.

  // A planned crop that never ran (the burn failed) leaves the bar in the delivered file, and a
  // delivered size that is not the crop means the filter did something else: both fail the take.
  // Known now, before tighten, so decided now (see DECIDED FAILURES).
  let cropFailed = null;
  if (cropPlan) {
    const want = `${cropPlan.w}x${cropPlan.h}`;
    if (sizeCheck) sizeCheck.delivered = outcome.finalProbe?.size ?? null;
    if (!cropApplied) {
      cropFailed = `the planned crop to ${want} was not applied (${tapError ?? cropError ?? 'the finishing encode did not run'}), so the delivered take still has its bar`;
    } else if (outcome.finalProbe?.size !== want) {
      cropFailed = `the delivered take is ${outcome.finalProbe?.size ?? 'unreadable'} but the planned crop was ${want}`;
    }
  }
  if (!interrupted) decided.cropFailed = cropFailed;

  console.log(
    `\n[film-android] Demo video written: ${outPath}` +
      (outcome.finalProbe.durationSec === null ? '' : ` (${outcome.finalProbe.durationSec.toFixed(2)}s)`),
  );

  let tightResult = null;
  let tightenSkippedAsSuspect = false;
  if (doTighten && interloped()) {
    // The same rule as a failed flow: a suspect take is not a deliverable, and writing a polished
    // `-tight.mp4` beside it is precisely how #10's dead take looked finished. The raw file is
    // kept, and tighten has its own CLI if the footage turns out to be usable after all: that hint is
    // printed once the take has been stepped aside, so it names the `.failed` file it was moved to
    // (it used to name the plain path, renamed on the very next line).
    tightenSkippedAsSuspect = true;
    console.error('[film-android] --tighten skipped — this take is suspect.');
    // Nothing is going to read this — tighten was never called — so it must not linger as an
    // unexplained dot-file forever.
    await dropPreBurn();
  } else if (doTighten) {
    try {
      if (interrupted) return; // the signal handler owns the exit; do not start a pass it cannot see
      tightenAbortController = new AbortController();
      // tightenAbortController and pendingTighten are set contiguously (no `await` between them) so
      // the signal handler can never see one without the other.
      pendingTighten = tighten(outPath, {
        signal: tightenAbortController.signal,
        minStill,
        keep,
        noise,
        // Rings were burned in, so freeze detection against outPath would be reading the burn's
        // own quantization noise, not the recorder's — see DETECT-FROM in tighten.mjs's header.
        // Without rings (no taps, or --no-show-taps) this stays undefined and tighten runs exactly
        // as it did before this feature existed.
        ...(finished()?.preBurnPath
          ? {
              detectFrom: finished().preBurnPath,
              // The delivered take is the pre-finish file cropped; only this caller knows that, and
              // tighten's frame-size guard then holds the pair to exactly it.
              ...(cropApplied ? { detectFromCrop: { w: cropPlan.w, h: cropPlan.h, x: cropPlan.x, y: cropPlan.y } } : {}),
            }
          : {}),
        // The tap ranges are already in memory — no reason to make tighten re-read them off the
        // sidecar this process is about to write.
        ...(tapProtect.length > 0 ? { protect: tapProtect, protectMarginSec: 0, sidecar: false } : {}),
        crf,
      });
      const result = await pendingTighten;
      if (result.skipped) {
        log(`already tight (${result.skipDetail || 'no static stretches found'}) — kept raw only: ${outPath}`);
      } else {
        // tighten() reports the seconds it PLANNED to keep (outDuration) and what it wrote
        // (fileDurationSec). The console and the sidecar both quote the written file, so they agree
        // with ffprobe; the plan is kept beside it. Measured before: "tightened 35.89s -> 7.68s" for a
        // file the sidecar and ffprobe put at 7.73s.
        // The removal is A - B from the two files (cutSummary), so the line closes; the plan's removal is
        // kept beside it in the sidecar. Measured before: "tightened 25.83s -> 17.37s (3 cuts, 8.55s removed)".
        const writtenSec = result.fileDurationSec ?? (await probeVideo(ffmpeg, result.outPath)).durationSec ?? null;
        const summary = cutSummary({ ...result, fileDurationSec: writtenSec });
        log(`tightened ${summary.line}`);
        console.log(`[film-android] Tightened demo video written: ${result.outPath}`);
        tightResult = {
          path: result.outPath,
          durationSec: writtenSec,
          plannedDurationSec: Number(result.outDuration.toFixed(3)),
          cuts: result.cuts,
          removedSec: removedOfFiles(result, writtenSec),
          plannedRemovedSec: Number(result.removedSec.toFixed(3)),
          detectFrom: result.detectFrom ?? null,
          detectMode: result.detectMode,
          protected: result.protected,
        };
      }
    } catch (err) {
      // An abort from the signal handler rejects with AbortError: the handler is already tearing
      // down (and will exit), so say nothing here.
      if (!interrupted) console.error(`[film-android] --tighten skipped — ${err.message}`);
    } finally {
      // The pre-burn file only ever existed to feed --detect-from above; tighten has now either
      // used it or failed trying, and either way there is nothing left to do with it. On an
      // interrupt the handler removes it too (dropPreBurn), after tighten() has settled.
      if (!interrupted) {
        pendingTighten = null;
        tightenAbortController = null;
      }
      await dropPreBurn();
    }
  }
  if (interrupted) return; // the signal handler owns the sidecar and the exit code

  // Every verdict was decided by now (harvest's in harvest, the crop's before tighten); main reaching
  // this line means no signal arrived before any of them. decidedFailure() has the precedence.
  const { incomplete, covered, aspectFailed, boxFailed, sizeFailed } = decided.harvest ?? {};
  const failure = decidedFailure();
  const finalStatus = failure?.status ?? 'ok';
  const finalError = failure?.error ?? null;
  const finalFields = () => ({
    status: finalStatus,
    error: finalError,
    finalProbe: outcome.finalProbe,
    stitch: outcome.stitch,
    trim: outcome.trim ?? null,
    durations: outcome.durations ?? null,
    tightResult,
  });
  // Both before the messages below, which are meant to be the last lines of the run.
  if (finalStatus !== 'ok') {
    // Stepped aside, sidecar at the `.failed` name, previous take back (failTake).
    await failTake(finalFields, {
      afterMove: (renamed) => {
        // tighten wrote `<name>-tight.mp4` before the rename; the sidecar must name where it ended up.
        const movedTight = tightResult && renamed.moved.find((m) => m.from === tightResult.path);
        if (movedTight) tightResult.path = movedTight.to;
        if (tightenSkippedAsSuspect) console.error(`[film-android] if the suspect take is usable after all: node tighten.mjs ${outPath}`);
      },
    });
  } else {
    // From here an `ok` take is final. Set BEFORE the write: a signal landing during it must already be
    // read as "keep the take" (see onInterrupt).
    takeComplete = true;
    // Nothing went wrong, so Maestro's spill is noise: it only earns its keep on a failure, and only an
    // `ok` take reaches this line (the branch record and the rings were read out of it long ago).
    await rm(debugDir, { recursive: true, force: true });
    await rm(attemptsDir, { recursive: true, force: true });
    debugKept = false;
    await writeSidecarSafely(finalFields());
    await keepNewTake(); // the new take is in place: the previous one has nothing left to guard
  }

  // The last line of a run is the one that gets read: a take that failed on its geometry has just
  // been announced with "Demo video written", so say plainly that it is not a take.
  if (aspectFailed || boxFailed || cropFailed || sizeFailed) {
    console.error(
      `\n[film-android] the take FAILED — ${[aspectFailed, boxFailed, cropFailed, sizeFailed].filter(Boolean).join('; ')}.\n` +
        `[film-android] status "failed" in ${sidecarPath}; the footage is in ${outPath} if you want it.`,
    );
  }
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
  // --strict-size failures and truncations exit non-zero for the same reason.
  if (finalStatus !== 'ok') {
    console.error(`[film-android] maestro's own debug output was kept: ${debugDir}`);
    reportAttempts();
    if (interrupted) return; // a signal during the step-aside waited for it and owns the exit code
    process.exit(1);
  }

  // SCENARIO PHASE (Part 2, --scenario): only ever entered with a finished `ok` take. Everything in
  // it is recorded and nothing in it can fail the take: emit and check-syntax failures, a red verify
  // and a signal all leave `status: "ok"` and the video where it is, and set the exit code (2, or the
  // signal's) instead. States: EMIT -> CHECK -> [VERIFY] -> done; each step rewrites the sidecar, and
  // scenarioSignalExit is looked at after each one (check-syntax is bounded, verify is aborted by the
  // handler), so a signal skips the remaining steps and is recorded where it landed.
  if (scenarioRequested) {
    const notCarried = [];
    if (installs.length > 0) notCarried.push('--install');
    // Only when the flag itself was passed: `--app` alone also turns the foreground guard on, but that is
    // a default of --app, not a choice about the take.
    if (process.argv.includes('--guard-app')) notCarried.push('--guard-app');
    scenarioRecord = { wrapper: null, preconditions: [], notCarried, pauseSec: null, warnings: [], checkSyntax: null, verify: null };
    const finalWrite = () =>
      writeSidecarSafely({
        status: finalStatus, error: finalError, finalProbe: outcome.finalProbe, stitch: outcome.stitch,
        trim: outcome.trim ?? null, durations: outcome.durations ?? null, tightResult,
      });
    try {
      log('emitting the scenario wrapper...');
      const flowText = await readFile(flowPath, 'utf8');
      const emitted = await emitMaestroScenario({
        camera: 'android', flowPath, flowText, scenarioDir, fresh, branches: branchList, notCarried, filmkit: filmkitCommit(),
      });
      scenarioRecord = { ...scenarioRecord, wrapper: emitted.wrapper, preconditions: emitted.preconditions, pauseSec: emitted.pauseSec, warnings: emitted.warnings };
      log(`${emitted.action === 'overwrite' ? 'rewrote' : 'wrote'} ${emitted.wrapper}`);
      for (const w of emitted.warnings) log(`⚠️  warning: ${w}`);
      const check = scenarioSignalExit === null ? await checkWrapper({ maestro, wrapperPath: emitted.wrapper, flowPath }) : null;
      if (check) {
        scenarioRecord.checkSyntax = check;
        log(check.ok ? 'maestro check-syntax: OK' : `⚠️  maestro check-syntax failed:\n${check.output}`);
        await finalWrite();
      }
      if (check && scenarioSignalExit === null && scenarioVerify) {
        log(
          emitted.preconditions.length > 0
            ? `--scenario-verify: running the wrapper now; its ${emitted.preconditions.join(' + ')} WIPES the app's data on ${deviceId}`
            : '--scenario-verify: running the wrapper once...',
        );
        // Wall-clock cap enforced here, where the run is owned (Maestro has no per-flow timeout in YAML):
        // 3x the filmed flow time + 60s, the rule the web scenario uses for its test timeout.
        const timeoutMs = Math.round(3 * (outcome.durations?.flowSec ?? 60) * 1000 + 60_000);
        verifyHandle = startVerify({ maestro, deviceId, wrapperPath: emitted.wrapper, timeoutMs });
        const result = await verifyHandle.done;
        verifyHandle = null;
        scenarioRecord.verify = result;
        log(
          result.status === 'passed'
            ? `--scenario-verify passed in ${result.durationSec}s`
            : `⚠️  --scenario-verify ${result.status} after ${result.durationSec}s (the take is fine and stays ok): ${result.error ?? ''}`,
        );
      }
    } catch (err) {
      scenarioRecord = { ...scenarioRecord, error: err.message };
      console.error(`[film-android] ⚠️  scenario export failed (the take is fine and stays ok): ${err.message}`);
    }
    await finalWrite();
    if (scenarioSignalExit === null) {
      const bad = Boolean(scenarioRecord.error) || scenarioRecord.checkSyntax?.ok === false || (scenarioRecord.verify && scenarioRecord.verify.status !== 'passed');
      if (bad) process.exitCode = 2;
    }
  }
  if (scenarioSignalExit !== null) process.exit(scenarioSignalExit);
}

// Only film when this file is executed directly. The validation and stitch helpers above are
// exported so they can be exercised against synthetic segments without a device attached, and an
// `import` of them must not start a camera — the same guard tighten.mjs uses for the same reason.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await main();
  } catch (err) {
    // Before main() has anything to put back or tear down, Node's own report and exit 1, as always.
    if (!onUnplannedError) throw err;
    await onUnplannedError(err);
  }
}
