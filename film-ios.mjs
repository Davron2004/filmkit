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
//        [--min-still <sec>] [--keep <sec>] [--noise <level>] [--crf <0-51>]
//        [--scenario [--scenario-dir <dir>] [--scenario-verify]]
//
// STATE MACHINE (one linear pipeline, no branching back-edges — a filming run is a single
// attempt, never resumed mid-way):
//
//   [RECOVER A CRASHED STASH] → PREFLIGHT → DEVICE → [INSTALL/FRESH] → [STASH PREVIOUS TAKE, --force] → RECORD_START → MAESTRO (→ RETRY, bounded, startup
//     failures only) → SALVAGE(stop, restore, FINALIZE) → [SHOW_TAPS | HOLD TAIL, pinned to the stop] →
//     [TRIM TAIL] → [TIGHTEN] →
//     SIDECAR → [SCENARIO: EMIT → CHECK → VERIFY] → done | FAILED (step the take aside, sidecar at the
//     .failed name, exit 1)
//
// Final statuses (sidecar `status`, and `ok` is true only for the first): ok | interrupted |
// flow-failed | taps-missing | finalize-failed | error. Everything but ok and interrupted goes
// through failTake() — see FAILED TAKES below. THE PREVIOUS TAKE IS ONLY EVER REPLACED BY A TAKE THAT
// ENDS `ok` OR `interrupted` (with a video, and a flow that had not already failed: see DECIDED
// FAILURES): under --force the old take is stashed before recording
// and comes back on every other exit, see FAILED TAKES. A run that dies before the camera rolled (bad
// flags, no device, setup error) writes no sidecar and moves nothing.
//
// The one back-edge is an interrupt: SIGINT (Ctrl-C, exit 130), SIGHUP (the shell or terminal
// that launched the camera going away, exit 129 — what happens to a take started from an agent's
// shell when that shell's turn ends) or SIGTERM (a plain `kill`, exit 143, as film-android does).
// TWO handler sets, swapped atomically when the recorder is about to roll:
//   * SETUP handlers, installed before the simulator is touched (so before the status-bar
//     override): nothing has been filmed, so a signal waits for an override still in flight,
//     clears it, puts the stashed previous take back if one was already set aside, and exits 130/129
//     with no take and no sidecar. main() parks at the swap point if
//     one already fired, so it can never run on into starting a recorder while the process exits.
//   * FULL handlers, from record start on: either signal jumps straight to SALVAGE and out, running
//     the same salvage the ordinary path runs, memoised so exactly one of them does the work. They
//     also stop the maestro child (SIGINT, SIGKILL after MAESTRO_ABORT_GRACE_MS) and wait for it,
//     so a `kill -HUP <pid>` of this process alone cannot leave a flow tapping an unrecorded
//     simulator; maestro is therefore spawned here with a handle, not through run(). That is what makes "interrupted" a state with a finished
// .mp4, a sidecar and a simulator put back, rather than an orphaned recorder, a half-burned
// dot-file and a simulator still insisting it is 9:41.
//   Measured without the SIGHUP handler (pty closed 30s into a take, the way a dying shell does
// it): node dies on Node's default disposition, no .mp4 and no sidecar are written, the raw is a
// zero-byte file next to simctl's unfinalized `.sb-*` spill (no moov atom, unplayable), and the
// status-bar override is left on. The next recordVideo on that simulator then failed with "Host
// recording is already in progress" until the simulator was rebooted (seen straight after; the
// cause is inferred, not isolated). With it, the same repro delivers the take with status
// "interrupted". simctl itself survives the hangup (it is not killed by the pty closing) and stops
// cleanly on salvage's SIGINT, so the recorder needs no session of its own. The handler also silences 'error' on stdout/stderr: after a hangup every
// console write fails with EIO, and an unhandled stream error would kill salvage halfway.
//   Measured before the maestro-stop: `kill -HUP <node pid>` alone salvaged the take but left the
// maestro child running the rest of the flow (it reached the next tap after node had exited); now
// the child is gone before the process exits and the log stops growing.
//
// FLOW LINT. At preflight (before the simulator is touched, with or without --scenario) the flow text is
// checked by lib/maestro-lint.mjs for a wait that directly follows another wait with nothing that resets
// Maestro 2.6's wait clock in between: such a wait's timeout is counted from the START of the previous wait,
// so a pause after a pause holds ~0.4s, and a real wait after a pause loses the pause's hold from its budget.
// It only warns (stderr, `[film-ios] ⚠️  flow lint (line N): ...`) and records `flowLint: [{ line, message }]`
// in the sidecar, key omitted when clean. Same call as film-android; the lib's header holds the measurements.
//
// SCENARIO EXPORT (Part 2; --scenario, --scenario-dir <dir>, --scenario-verify). maestro is ALWAYS given
// `-e FILMKIT_MODE=film`, so a flow can gate steps that only make sense under a test runner with
// `when: { true: ${FILMKIT_MODE == 'test'} }` (SKIPPED on film, run in the wrapper, which sets
// FILMKIT_MODE=test). With --scenario, and only for a take whose final status is `ok`, the camera writes
// `<flow-stem>.scenario.yaml` (lib/scenario/emit-maestro.mjs: a wrapper that runs the ORIGINAL flow, so
// there is one source of steps) next to the flow or into --scenario-dir, then runs `maestro check-syntax`
// on it (exists in Maestro 2.6.0; it does not follow runFlow targets, so lib/scenario/run-maestro.mjs also
// checks the target resolves). --scenario-dir and --scenario-verify without --scenario are usage errors.
//   * PREFLIGHT: a planned wrapper path holding a file WITHOUT the `@filmkit-generated` first line refuses the
//     run before the simulator is touched, --force or not (lib/scenario/generated.mjs); a marked file is
//     derived and is overwritten without --force.
//   * BRANCHES. Before the debug dir is deleted on success, lib/scenario/branches.mjs reads which
//     `runFlow: when:` blocks ran (`[{ seq, when, status, atSec }]`, atSec from video time 0) into the sidecar's
//     `branches` and the wrapper header. The key is written whenever --scenario was asked for (null: no readable
//     command record) and otherwise only when the flow HAD such blocks that are not mode gates, so a take of a flow without any keeps its
//     old sidecar keys. A `when:` that reads FILMKIT_MODE (a test-only step, a pause gated off in test) is a
//     MODE GATE, not a branch the app took: kept in `branches` with `modeGate: true`, left out of the wrapper
//     header's "branches filmed". Reason to record it without --scenario: the spill is deleted on success, so this is the
//     only chance, and a later re-emit from the sidecar needs it. Cost: a few small JSON files.
//   * PAUSES. Waits on the pause marker inside a `runFlow: when: { true: "${FILMKIT_MODE != 'test'}" }` gate (the
//     idiom in examples/) are counted as skipped in test mode, bare ones as paid; sidecar `scenario.pauseSec` is
//     `{ skippedInTest, paidInTest }` and the header says so. Pauses in `runFlow: file:` includes are not counted.
//     A flow that itself carries the `filmkit-scenario` tag makes the emit fail (exit 2, take stays ok).
//   * NOT CARRIED into the wrapper (printed in its header, sidecar `scenario.notCarried`): --install and
//     --clean-status-bar. --fresh is carried as `clearState` + `clearKeychain` (`preconditions`); see
//     emit-maestro.mjs for how that differs from the uninstall --fresh does. --simulator is deliberately not
//     listed: it picks the device, it does not change state on it.
//   * STATE MACHINE of the phase: the take is FINAL (sidecar `ok` written, `takeComplete`) before it starts.
//     EMIT -> CHECK -> [VERIFY], each rewriting the sidecar `scenario` block
//     `{ wrapper, preconditions, notCarried, pauseSec, warnings, checkSyntax: { ok, output }, verify: null | { status,
//     durationSec, error } }` (`error` is added, and `wrapper` stays null, if emit itself failed; `warnings`: the
//     wrapper's runFlow file leaves its project, see emit-maestro.mjs, printed too, exit unchanged). Nothing in
//     it can fail the take: an emit or check failure, a red verify (`passed|failed|timeout|interrupted|error`) and
//     a signal all leave `status: "ok"` and the video where it is, and the exit code becomes 2 (failure) or the
//     signal's. A signal in this phase is NOT a salvage (onInterrupt tests `takeComplete` first): it aborts the
//     verify run (SIGINT, SIGKILL after 10s), skips the remaining steps, records where it landed and exits 130/129/
//     143; a second signal kills the verify run and exits at once. There is no other way back and no cancel of a
//     finished take. --scenario-verify runs `maestro --device <udid> test <wrapper>` ONCE (no retry: a retry
//     would repeat the app's side effects) and WIPES app data if the wrapper has clearState. Its wall-clock cap
//     (3x the filmed flow time + 60s) is enforced here in film-ios because Maestro has no per-flow timeout in YAML.
//
// FAILED TAKES (#13). Every status but ok/interrupted steps the take out of its name via
// lib/takes.mjs markTakeFailed, exactly as film-android does: `<name>.mp4` -> `<name>.failed.mp4`,
// the sidecar is written at `<name>.failed.json` (a repeat failure lands in `.failed-2`, never on
// top of the first), so the name is free for the retake without --force. Only files modified since
// this run began move, so a failure under --force cannot relabel an older good take. failTake()
// also deletes the `.pre-taps.mp4` that --tighten keeps aside for detect-from, which only the
// tighten step removes and a failed run never reaches (measured: leaked on every flow-failed
// --tighten run). An error nobody planned for, thrown after the recorder started, takes the same
// exit: salvage, failTake, sidecar `status: "error"`, exit 1.
//
// THE PREVIOUS TAKE UNDER --force (lib/takes.mjs has the state machine, the naming and the crash policy).
// Measured before this existed: a --force retake whose flow failed overwrote `<name>.mp4` with its own
// recording, failTake moved that to `.failed.mp4`, and the previous good take was gone while its
// `<name>.json` still said `status: ok` for a file that no longer existed. Now, under --force, after
// preflight AND setup have passed (device found, app installed: a run that dies there has not touched
// the previous take, and the window in which a SIGKILL can strand a stash is only the recording) and
// still on the setup handlers, stashPreviousTake moves `<name>.mp4`, `-tight.mp4` and `.json` to
// `.<name>.prev*`. The plain names then hold only this run's output. Exits:
//   * ok            -> writeSidecar('ok'), then keepNewTake() = discard the stash. Also in onInterrupt's
//                      takeComplete branch (a signal during the sidecar write), synchronously, since a
//                      second signal there exits at once.
//   * interrupted   -> salvage produced a video, the flow had not already failed, and the sidecar is
//                      written: discard. Salvage that saved nothing ("interrupted before anything could be
//                      saved"), or that threw: restore. A flow that failed BEFORE the signal is set aside as
//                      flow-failed (failTake, next bullet): restore.
//   * every failure -> failTake(), ONE promise: the move (video to `.failed-N`), writeSidecar at the
//                      `.failed` name, THEN restorePrevious(): the plain names are free again. This covers
//                      flow-failed, finalize-failed, taps-missing and the unexpected-error catch-all. The
//                      dead-recorder fail-fast (nothing was filmed; the previous take was still stashed)
//                      only restores.
//   * setup signal  -> the setup handler restores before exiting.
//   * an interrupt that races a failure exit already under way is that failure, not an interrupted take:
//     it waits for the whole failTake (failTakePromise), bounded by FAIL_EXIT_WAIT_MS (10s; a normal
//     step-aside takes well under a second), then exits with the signal's code. So the failed take keeps
//     its sidecar and the previous take comes back. Before, it waited for the move only and exited before
//     the sidecar write (seen on film-android, which had the same structure: `.failed-6.mp4` with no
//     `.failed-6.json`). A failure exit that would START after the interrupt began is not started, and
//     neither is the `ok` write: the handler owns the run from then on.
//
// DECIDED FAILURES. The flow can fail well before its flow-failed exit runs (the salvage, the burn, the tail
// trim and the alignment come first), and a signal in between used to turn the take into `interrupted`: the
// handler aborted the burn, wrote `interrupted` with `error: null` (the flow's error lost) at the plain name
// and, under --force, DISCARDED the previous good take for a failed, ringless partial. Now the flow's own
// failure is recorded when the retry loop ends, only if no signal had arrived (`decidedFlowError`; a flow a
// signal stopped does not count), and the handler, once salvage and any burn or tighten have settled, sets
// such a take aside with failTake('flow-failed', <the flow's error>): `.failed-N`, `interruptedBy` = the
// signal, the error ending in "<SIG> was received while this failed take was being finished", the previous
// take restored, exit = the signal's. film-web keeps a flow error that predates a signal the same way.
// finalize-failed and taps-missing need nothing of the kind: their failTake starts in the same tick they are
// decided, and failTakePromise covers them. An interrupted take's sidecar carries `error: "interrupted by
// <SIG>"` and `interruptedBy`, as film-android's and film-web's do (it was null).
//
// NOTHING FILMED. A signal that arrives before any flow command started (the warmup, the maestro JVM
// starting, a startup retry's backoff or reap; judged by lib/tap-overlay.mjs maestroCommandRan on
// maestro.log as it stands at the signal) is treated like a setup-phase signal: the recorder is stopped, the
// status bar put back, this run's raw, simctl spill and debug spill removed, no take, no sidecar, the
// previous take restored, the signal's exit code (film-android does the same). Measured before: a signal
// right as recording started kept a 0.067s `interrupted` take that, under --force, replaced the previous
// take. A sidecar's `output.path` is null when there is no video (a finalize that failed).
//
// KEPT EVIDENCE IS PER RUN. What a run may leave for a human carries `<run>`, its UTC start
// (20260929-191530): the raw `.<name>.<run>.raw.mp4` (kept when finalize fails), the debug spill
// `.<name>.<run>.maestro-debug` and the failed attempts `.<name>.<run>.maestro-attempts`. By construction
// before: the next run's `recordVideo --force` overwrote a kept raw of the same name, and its start deleted
// the previous run's debug spill and attempts (a `.failed.json` then named a `debugOutput` that was gone).
// Nothing here deletes another run's files now.
// A restore never overwrites: if a plain name is occupied (failTake could not move the failed video,
// 999 slots) nothing is moved back, the stash stays, the message names it, and the next run's
// recoverCrashedStash refuses until the operator chooses. Without --force nothing is stashed. A stash
// from a killed run is put back (or refuses the run) before preflight, so the refusal to overwrite an
// existing take cannot be walked around by a hidden one.
//
// STARTUP RETRY (#27). maestro is always given --debug-output (even with --no-show-taps): the
// predicate maestroStartupUnavailable (lib/tap-overlay.mjs) reads maestro.log and commands-*.json
// there, and the spill is still deleted on success. When maestro dies with a known startup
// signature AND no command ran, the flow is started again inside the same recording (the recorder
// keeps rolling; tighten / --trim-head cut the extra static head): backoff and budget are the
// MAESTRO_RETRY_* constants (no attempt STARTS past the budget, checked before and after the
// backoff), one `{reason, atSec}` per retried failure lands in the sidecar's
// `maestroRetries`. iOS has no gRPC; its signature is the XCTest driver's startup timeout
// (`IOSDriverTimeoutException`, ~90s), printed ONLY on maestro's stderr, never in maestro.log —
// so maestro's stderr is piped (forwarded verbatim to ours, stdout and stdin stay inherited so the
// live progress renders as before) and its tail is handed to the predicate. Each failed attempt's
// log dir is then MOVED out of the debug dir into `.<name>.<run>.maestro-attempts/attempt-N/` (film-
// android's name and shape), so the predicate, the tap parser and the command record can only see
// the latest attempt: a retry that dies before writing its own maestro.log (a JVM crash) would
// otherwise be judged, and retried, on the previous attempt's log. That dir is per run (see KEPT
// EVIDENCE IS PER RUN), removed on success, and kept and named on every exit that fails or is
// interrupted. Sidecar
// `durations`: `flowSec` is the LAST attempt's own time, `retrySec` the failed startups plus backoff
// before it (also logged), so `flowSec` means the same with or without a retry. Set on every exit that has a
// flow, an interrupted take's included (the stopped child's exit ends its flowSec; it used to be null). Measured: after an
// aborted attempt a stale `xcodebuild test-without-building` keeps the driver wedged 60-90s, and a
// retry 5s later failed the same way after another 90s. So before every retry the camera reaps
// the stale runner itself: only processes that are xcodebuild, running test-without-building, with
// `-destination id=<this simulator's udid>` in argv (never by name alone — another agent's maestro
// on another simulator is untouched); the count is logged and recorded as `reaped` in that
// `maestroRetries` entry. Verified with a forced 1s driver timeout on the first attempt and no
// reaping outside the camera: the retry succeeded.
//
// FAIL FAST ON A DEAD RECORDER. If simctl's recorder has exited for ANY reason by the end of the
// warmup, the run stops BEFORE the flow: it prints the recorder's stderr and exit code or signal,
// restores the status bar, sweeps the dead recorder's empty raw and `.sb-*` spill, and treats it as a
// setup failure (no sidecar, nothing renamed, exit 1).
// For "Host recording is already in progress" (a live or uncleanly stopped recorder holds the
// simulator) it also prints the remedy: shut down and boot that simulator, never done for you.
//
// A SIGNAL DURING THE WARMUP OR BETWEEN ATTEMPTS. The full handlers exist before the recorder does,
// so main() re-checks `interrupted` after the warmup sleep, at the top of every retry iteration and
// immediately before each maestro spawn, and parks if it is set: the handler owns salvage and the
// exit code. Measured before the checks (signal 0.2s and 1.4s into the warmup): the early one
// misread the recorder the handler had just stopped as a failed start, deleted its raw and exited 1
// instead of 143; the late one spawned maestro AFTER stopMaestro() had run against a null child, and
// that maestro was still running when the process exited.
//
// HELD TAIL: THE TAKE LASTS AS LONG AS THE CAMERA ROLLED. simctl emits a frame only when the screen
// CHANGES, so a take that ends on a held beat (every flow built from the examples does: pause,
// waitForAnimationToEnd, pause) has no frame for it, and the finalized file stops at its last change.
// Measured on the example flow: the raw's last frame at 22.50s, the camera stopped at 26.96s; the
// delivered takes ended 1.57-1.94s after the last tap though the flow holds >= 2.8s after it, 2.5-5.5s
// short of the recorder window (6/6), and main's film-ios the same (4.29 and 4.38s short, 1.64 and
// 1.73s after the last tap): not new on this branch. Android's container over-declares its last frame
// and keeps 6.75-8.24s after the last tap on the same flow.
// So every take is PINNED to `pinSec` = max(recorder window, the finalized file's container duration):
// the window is Recording started to the SIGINT, i.e. how long the camera rolled, and the container
// duration (which ignores a phantom final sample, see trimPhantomTail) keeps any frame that exists. The
// burn gets it as style.pinDurationSec (lib/tap-overlay.mjs clones the last frame up to the pin and cuts
// there, which also removes a phantom tail), and a take nothing is burned into (no tap logged,
// --no-show-taps) gets the same encode with zero rings (holdToWindow). The last frame is what the screen
// showed until the stop: no frame means no change. Not done: a failed flow (stepped aside unheld) and an
// interrupted take, which end at their last change; their rings, if any, come from an UNPINNED burn (main's
// for a failed flow, SALVAGE RINGS' for an interrupted take).
// "A failed flow" means pinSec is null for it, so the rule holds whether or not it tapped: its burn still
// runs (the rings that landed belong in the partial) but unpinned, and its `heldTail` says `pinnedSec:
// null, heldSec: 0`. Measured before: the burn took the pin unconditionally, so a failed flow that had
// tapped was held 12.4s past its last change while one that had not was left unheld.
// An UNPINNED encode is cut back to the FINALIZED length (finalizedSec, one 60fps frame of slack), not to the
// recorder window, so `heldSec: 0` is true of the file. Measured before: a tapped failed flow cut to the
// window ended 0.218s past its last change (36.200s against a finalized 35.982s) while saying heldSec 0.
// `delivered` has ONE shape on every take with a file (describeDelivered), heldTail included: measured before,
// a flow-failed take no encode touched had no `heldTail`, and an interrupted take had `delivered: null`.
// SALVAGE RINGS. A take that leaves through the signal handler or the unexpected-error exit, with taps that
// happened and no rings yet, gets them in a SECOND PASS (salvageRings): main's own drawTaps, unpinned, started
// only once the take and its sidecar are final (the sidecar written, the stash settled; its `tapSync.error`
// says the rings are still to come), then `delivered` is measured again and the sidecar rewritten. THE TIME
// BUDGET: it costs what the main burn does (13.4s for a 23.4s take, h264_videotoolbox, 1206x2622/60fps),
// past the 10s that is the longest a signal otherwise waits (MAESTRO_ABORT_GRACE_MS, FAIL_EXIT_WAIT_MS), so it
// is made unable to cost the take instead: a SECOND signal aborts it (the take stays as saved, `tapSync.error`
// says the rings were skipped, exit = the first signal's) and a SIGKILL during it leaves the saved, described,
// ringless take (and the burn's dot-prefixed temp `.<name>.taps-<pid>.mp4`, which its orphaned ffmpeg finishes
// and nothing renames in). STALE BURN TEMPS: the next run of the same name removes it at its start once the pid
// in its name is dead, never one whose pid is alive (a concurrent run's, or a reused pid: the safe miss), by
// tighten's STALE TEMPS rule (sweepDeadRunTemps). Measured before: it stayed until a later --force run of the
// same name happened to overwrite it. film-android does the same. Before this an interrupted take that had tapped carried no rings at all.
// Tried first and rejected: lengthening the final packet in a stream copy (film-android's lost-successor
// trick). On this B-frame footage `setts` under -fflags +igndts corrupts the generated DTS (620 frames out
// of 675 after a resample), and a second remux of the finalized file shifted timestamps and changed
// decoded frames. The encode is the one every take with rings already pays.
// UNDER --tighten the pre-burn file stays frame-exact and ends at the last change, so it is shorter than
// the delivered take by exactly the hold. tighten() is told so (`detectFromHoldSec` =
// delivered.heldTail.heldSec): its guard expects that difference, and its freeze detection clones the
// source's last frame for the same time, so the held tail is analysed and clamped like any other hold.
// (This replaced alignToPreBurn, which cut the burn back to the pre-burn length: with the hold it would
// cut the held tail off every --tighten take.) Recorded as `delivered.heldTail`: { windowSec, finalizedSec,
// pinnedSec, heldSec }.
//
// QUIET FFMPEG (#12). The three calls through runFfmpegCapturingStderr carry `-hide_banner` and a
// loglevel: `warning` for finalize (the muxer's "Non-monotonic DTS" lines it counts are warnings —
// `error` would zero `muxerDtsWarnings`; verified on three raws: 4/1/1 lines at the default level,
// 4/1/1 at `warning`, 0/0/0 at `error`) and `error` for the tail trim. The timeline probe stays at
// `-v info` on purpose (it parses showinfo) with the banner hidden.
//
// --crf (#25, default lib/encode.mjs DEFAULT_CRF 18) is the quality of every software re-encode:
// the tighten cut, the finalize fallback and the burn's software encoder (the VideoToolbox burn is
// bitrate-controlled and ignores it). Recorded in the sidecar as `crf`. The sidecar also carries
// `ok`, `error` and `filmkit: { commit, branch } | null`, the keys film-android's has.
//
// - PREFLIGHT: verify macOS (simctl does not exist anywhere else), then the three checks every
//   filmkit camera shares (lib/preflight.mjs): Node >= 20, the flow file exists, and NO EXISTING
//   TAKE IS CLOBBERED — `<name>.mp4`, `<name>.json` and `<name>-tight.mp4` (always, with or without
//   --tighten, as film-android and film-web do: a `-tight` without its take is still part of a take, and
//   under --force the stash moves it with the rest) must not already exist unless `--force` says so. Filming is a repeated activity and a clobbered
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
// - TRIM TAIL runs only after a burn or a hold encode, and only because they resample: simctl stamps
//   the last sample of a recording with a duration that can run seconds past the SIGINT that stopped
//   the camera (measured: 9.698s on a 31.82s take), which a constant-rate pass faithfully turns into
//   a frozen tail. The pin (HELD TAIL) already ends the encode at the camera's stop, so this is the
//   residual check: a cut only if the encode still ran past the pin. It can only ever remove time
//   that was never filmed. See trimPhantomTail.
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
//   already unlinked, and the take is delivered without rings first, then gets them in SALVAGE RINGS
//   (see HELD TAIL). When `--tighten` was also asked for, the FINALIZED (pre-burn) file is kept aside
//   under a dot-name rather than being clobbered by the burn's rename, so TIGHTEN below can run
//   freeze detection against it instead of the burn's own re-encode noise — see DETECT-FROM in
//   tighten.mjs's header. It is deleted once TIGHTEN is done with it, and on every
//   other way out too: the failed-take path (failTake) and the interrupt handler both remove it,
//   so no signal leaves it behind. Every drawn tap also becomes a protected range (`{kind:'tap', start:
//   tSec-0.15, end: tSec+max(0.5, holdSec+0.45)}`) so tighten's leading-edge clamp cannot cut a
//   tap — and its ring — out of a long still stretch; see PROTECT below TIGHTEN.
// - TIGHTEN (opt-in, --tighten): runs after SHOW_TAPS — over the video with the rings already in
//   it, never the bare one — and only if maestro succeeded. Passes the pre-burn file as
//   `detectFrom` and every tap as a protected range when SHOW_TAPS drew rings (see above);
//   without rings this call is identical to what it was before either feature existed. A tighten
//   failure is reported but does not fail the overall command; the recording already succeeded by
//   that point. It is abortable: the call is given an AbortSignal, and a SIGINT/SIGHUP/SIGTERM
//   during it aborts tighten and AWAITS it (children killed, temp output removed, `AbortError`
//   after both), so no ffmpeg outlives the process and no `-tight.mp4` is left half-written; the
//   `interrupted` sidecar then names no tight file. If tighten had already resolved when the signal
//   landed, its file is complete and the handler says so. tighten writes to a hidden temp and only
//   renames it over `-tight.mp4` on success, so an aborted or failed pass leaves nothing behind.
// - SIDECAR: `<out>/<name>.json` records what produced the video — flow path and hash, argv,
//   simulator udid, every tap that was drawn (`taps`, in output pixels and seconds into the
//   video), whether indicators were on (`showTaps`), the wall-clock anchor the tap times were
//   converted against (`tapSync`), what the timestamp repair had to do (`ptsRepair`), and the
//   shape of the file actually handed over (`delivered`), and `output.fps` / `output.encoder` (the burn's
//   or the hold encode's own, otherwise read off the file by probeStreamInfo, so an interrupted take's or
//   a decided failure's sidecar is not blank). `taps[].tSec` is measured in the take
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
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, join, basename, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { run, runCapture, resolveTool, sleep, fileExists } from './lib/tools.mjs';
import { valueFor } from './lib/args.mjs';
import { preflight as sharedPreflight, validateNameStem } from './lib/preflight.mjs';
import { burnTapRipples, flowHasTapCommands, locateLogs, maestroCommandRan, maestroStartupUnavailable, parseMaestroTaps } from './lib/tap-overlay.mjs';
import { markTakeFailed, recoverCrashedStash, stashPreviousTake } from './lib/takes.mjs';
import { filmkitCommit } from './lib/provenance.mjs';
import { DEFAULT_CRF, parseCrf, x264Args } from './lib/encode.mjs';
import { cutSummary, escapeRegExp, sweepDeadRunTemps, tighten } from './tighten.mjs';
import { checkGeneratedTarget } from './lib/scenario/generated.mjs';
import { readBranches } from './lib/scenario/branches.mjs';
import { emitMaestroScenario, plannedWrapper } from './lib/scenario/emit-maestro.mjs';
import { checkWrapper, startVerify } from './lib/scenario/run-maestro.mjs';
import { lintAndReport } from './lib/maestro-lint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_DIR = join(HERE, 'out');
const RECORD_WARMUP_MS = 1500; // let recordVideo actually start writing before Maestro taps
const RECORD_FINALIZE_MS = 2000; // after SIGINT, before remux — lets simctl close the file
const MAESTRO_ABORT_GRACE_MS = 10000; // SIGINT to the maestro child, then SIGKILL (film-android's value)
// How long an interrupt waits for a failure exit already under way (failTake: the move, the sidecar, the
// restore) before exiting without it. Normally well under a second; bounded so a wedged write cannot hold
// Ctrl-C forever. film-android's value, the same as MAESTRO_ABORT_GRACE_MS.
const FAIL_EXIT_WAIT_MS = 10000;
// STARTUP RETRY (#27). When `maestro test` dies before running any command, on a known startup
// signature (lib/tap-overlay.mjs, maestroStartupUnavailable), the flow is started again inside the
// same recording: wait MAESTRO_RETRY_BACKOFF_MS, try again, and keep going while the last failure
// is younger than MAESTRO_RETRY_BUDGET_MS, but always make at least one retry. Measured reasons:
// after an unclean maestro death the driver stays unreachable for a while (Android: ~25s, from the
// Android camera's own evidence), so an immediate retry fails too and a short pause costs little.
// On iOS the stale `xcodebuild test-without-building` a failed attempt leaves behind lingered
// 60-90s in these runs, and the driver timeout itself is 90s, so one attempt already outlasts the
// budget: iOS usually gets exactly one retry. Before each retry reapStaleDrivers() kills that stale
// runner (see below), which is what lets the retry succeed instead of failing the same way.
// How far past the finalized take's end an UNPINNED encode may run before it is cut back (HELD TAIL): one
// frame of the burn's 60fps plus rounding. Its output can only end on a frame boundary at or after the
// finalized length; anything more is the resampled phantom tail (see trimPhantomTail).
const UNPINNED_TAIL_SLACK_SEC = 1 / 60 + 0.005;
const MAESTRO_RETRY_BACKOFF_MS = 5000;
const MAESTRO_RETRY_BUDGET_MS = 45000;

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
  let crfRaw = DEFAULT_CRF;
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
    } else if (argv[i] === '--crf') {
      crfRaw = valueFor(argv, i, '--crf', usageError);
      i++;
    } else if (argv[i] === '--scenario') {
      scenario = true;
    } else if (argv[i] === '--scenario-dir') {
      scenarioDir = valueFor(argv, i, '--scenario-dir', usageError);
      i++;
    } else if (argv[i] === '--scenario-verify') {
      scenarioVerify = true;
    } else {
      rest.push(argv[i]);
    }
  }
  if (rest.length !== 1 || !/\.ya?ml$/.test(rest[0])) {
    console.error(
      'usage: node film-ios.mjs <flow.yaml> [--out <dir>] [--name <basename>] [--force] ' +
        '[--simulator <name-or-udid>] [--install <path.app|path.ipa>]... [--app <bundle-id>] ' +
        '[--fresh] [--codec h264|hevc] [--clean-status-bar] [--no-show-taps] [--tighten] ' +
        '[--min-still <sec>] [--keep <sec>] [--noise <level>] [--crf <0-51>] ' +
        '[--scenario [--scenario-dir <dir>] [--scenario-verify]]',
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
  // The two modifiers mean nothing without --scenario. An error, not an implication: --scenario-verify
  // WIPES app data when the wrapper has clearState, so it must never switch itself on by accident.
  if (!scenario && scenarioDir !== undefined) usageError('--scenario-dir needs --scenario');
  if (!scenario && scenarioVerify) usageError('--scenario-verify needs --scenario');
  let crf;
  try {
    crf = parseCrf(crfRaw, '--crf');
  } catch (err) {
    usageError(err.message);
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
    crf,
    scenario,
    scenarioDir: scenarioDir ? resolve(scenarioDir) : undefined,
    scenarioVerify,
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

// ── REAP a wedged driver before an iOS retry ──────────────────────────────────────────────────
// A maestro attempt that dies at startup leaves its `xcodebuild test-without-building` behind, and
// that stale runner keeps the next attempt's driver from coming up for 60-90s (measured: a retry 5s
// later failed the same way after another 90s; with the stale process killed it succeeded). This
// kills exactly those, and nothing else: the process must be xcodebuild, running
// test-without-building, with `-destination id=<THIS simulator's udid>` in its argv. Never matched by
// name alone, so another agent's maestro on another simulator is untouched. SIGTERM, then SIGKILL
// for anything still alive after a short grace.
async function reapStaleDrivers(udid) {
  let table;
  try {
    table = await runCapture('ps', ['-axo', 'pid=,command=']);
  } catch {
    return { found: 0, reaped: 0, pids: [] };
  }
  const destination = new RegExp(`-destination\\s+id=${udid}(?:[\\s,]|$)`, 'i');
  const pids = [];
  for (const line of table.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const argv = m[2];
    if (pid === process.pid) continue;
    if (!/(?:^|\/)xcodebuild\s/.test(argv) || !/\btest-without-building\b/.test(argv)) continue;
    if (!destination.test(argv)) continue;
    pids.push(pid);
  }
  // Counted only when the process was alive to be signalled: a pid that vanished between the `ps`
  // and the kill was not reaped by us.
  const signalled = [];
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      signalled.push(pid);
    } catch { /* already gone */ }
  }
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  for (let waited = 0; waited < 3000 && signalled.some(alive); waited += 250) await sleep(250);
  for (const pid of signalled) {
    if (alive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* raced */ }
    }
  }
  return { found: pids.length, reaped: signalled.length, pids: signalled };
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
  let exitCode = null;
  let exitSignal = null;
  child.on('exit', (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
  });
  return {
    child,
    get isRunning() {
      return !exited;
    },
    // How it ended, for the fail-fast check: a numeric code, or the signal that killed it.
    get exitDescription() {
      return exitSignal ? `killed by ${exitSignal}` : `exit code ${exitCode}`;
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
// FEEDBACK #12: no banner, and a loglevel chosen per call. Finalize needs `warning` because the
// muxer's "Non-monotonic DTS" lines it counts are warnings — `error` would zero the counter.
const QUIET_WARN = ['-hide_banner', '-loglevel', 'warning'];
const QUIET_ERROR = ['-hide_banner', '-loglevel', 'error'];

async function finalizeVideo(ffmpeg, rawPath, outPath, crf) {
  let stderr;
  let reencoded = false;
  try {
    stderr = await runFfmpegCapturingStderr(ffmpeg, [
      ...QUIET_WARN, '-y', '-nostdin', ...IGNORE_DTS, '-i', rawPath, '-c', 'copy', '-movflags', '+faststart', outPath,
    ]);
  } catch (err) {
    log(`ffmpeg remux (stream copy) failed (${err.message}) — falling back to re-encode...`);
    if (err.stderr) console.error(err.stderr.trim().split('\n').slice(-8).join('\n'));
    reencoded = true;
    stderr = await runFfmpegCapturingStderr(ffmpeg, [
      ...QUIET_WARN, '-y', '-nostdin', ...IGNORE_DTS, '-i', rawPath, ...x264Args({ crf }), '-pix_fmt', 'yuv420p', outPath,
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
    const child = spawn(ffmpeg, ['-hide_banner', '-v', 'info', ...inputFlags, '-i', path, '-vf', 'showinfo', '-f', 'null', '-'], {
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
  crf,
  pinDurationSec,
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
  // `pinDurationSec` is the HELD TAIL pin main() computed (see the header): the burn holds the last
  // frame to the camera's stop and ends exactly there (style.pinDurationSec in lib/tap-overlay).
  if (preBurnPath) await rename(videoPath, preBurnPath);
  let result;
  try {
    result = await burnTapRipples({
      inPath: preBurnPath ?? videoPath,
      outPath: tmpPath,
      taps,
      ffmpegPath: ffmpeg,
      style: { scale: parsed.scale, codec, crf, ...(pinDurationSec ? { pinDurationSec } : {}) },
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

// HELD TAIL for a take nothing was burned into (no tap was logged, or --no-show-taps): the same
// constant-rate encode the burn does, with zero rings, pinned to the camera's stop, so this take
// also lasts as long as the camera rolled. Same pre-burn handling as drawTaps: under --tighten the
// frame-exact finalized file is kept aside for tighten's --detect-from, and on any failure or abort
// it goes back where the take is expected to live (the take is then delivered unheld, as before).
async function holdToWindow({ ffmpeg, videoPath, tmpPath, codec, crf, keepPreBurn, pinDurationSec, signal }) {
  const preBurnPath = keepPreBurn ? join(dirname(videoPath), `.${basename(videoPath, '.mp4')}.pre-taps.mp4`) : null;
  if (preBurnPath) await rename(videoPath, preBurnPath);
  let result;
  try {
    result = await burnTapRipples({
      inPath: preBurnPath ?? videoPath,
      outPath: tmpPath,
      taps: [],
      ffmpegPath: ffmpeg,
      style: { scale: 3, codec, crf, pinDurationSec },
      signal,
    });
  } catch (err) {
    await rm(tmpPath, { force: true });
    if (preBurnPath) await rename(preBurnPath, videoPath).catch(() => {});
    throw err;
  }
  await rename(tmpPath, videoPath);
  return { ...result, preBurnPath };
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
 * What the file on disk is, off `ffmpeg -i`'s stream banner: the sidecar's `output.fps` / `output.encoder`
 * for a take no encode of ours produced (interrupted, or a flow failure set aside before its burn ran),
 * the same fallback film-android's probeVideo gives. simctl records variable frame rate, so the banner's
 * average fps is low and that is normal. null when the file cannot be read.
 */
async function probeStreamInfo(ffmpeg, path) {
  const { stderr } = await new Promise((resolveProbe) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-i', path], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', () => resolveProbe({ stderr: '' }));
    child.on('exit', () => resolveProbe({ stderr: err }));
  });
  const codec = stderr.match(/Video:\s*(\w+)(?:\s*\(([^)]*)\))?/);
  const fps = stderr.match(/Video:[^\n]*?,\s*([\d.]+)\s*fps/);
  if (!codec) return null;
  return {
    fps: fps ? Number(fps[1]) : null,
    encoder: `simctl recordVideo ${codec[1]}${codec[2] ? ` (${codec[2]})` : ''}`,
  };
}

/** A file's container duration, the number tighten's --detect-from guard compares. */
async function containerDuration(ffprobe, path) {
  const out = await runCapture(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path]);
  return Number(out.trim());
}

/**
 * simctl stamps the FINAL sample of a recording with a duration that can be wildly longer than
 * the recording is: on one 31.82s take the last packet claimed 9.698s, putting its end 9.3s past
 * the SIGINT that stopped the camera. The container's own duration field is right and ignores
 * it, so ffprobe and players are fine — but anything that RESAMPLES honours it, and the tap
 * burn's constant-rate pass does exactly that, baking 9.4s of frozen tail into the delivery.
 *
 * The burn's output is constant rate and (measured: 0 of 2470 packets with pts != dts) carries
 * no B-frames, so cutting whole samples off the end is exact. The cut lands at the target the caller
 * passes as `windowSec`: the HELD TAIL pin for a pinned encode (at least the recorder's own wall window,
 * Recording started to SIGINT, how long the camera rolled), or the finalized take's own length for an
 * unpinned one (a failed flow, an interrupted take: they end at their last change), with `slackSec` one
 * frame there. Either way nothing that was filmed is cut and nothing that was not is invented.
 *
 * Needs ffprobe to check its own work; without it the tail is left alone and said so, because a
 * blind cut on a file that might have B-frames is a worse trade than a long freeze.
 */
async function trimPhantomTail(ffmpeg, ffprobe, path, windowSec, slackSec = 0.25) {
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
  if (!(before.durationSec > windowSec + slackSec)) {
    return { applied: false, reason: 'no phantom tail', durationSec: before.durationSec, frames: before.frames };
  }
  const tmp = join(dirname(path), `.${basename(path, '.mp4')}.trim.mp4`);
  try {
    await runFfmpegCapturingStderr(ffmpeg, [
      ...QUIET_ERROR, '-y', '-nostdin', '-i', path, '-c', 'copy', '-t', windowSec.toFixed(3), '-movflags', '+faststart', tmp,
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
  // Wall clock at the start of THIS run: markTakeFailed only moves files modified since, so a
  // failed run under --force cannot relabel an older good take as its own failure.
  const runStartedMs = Date.now();
  // KEPT EVIDENCE IS PER RUN (see the header): the files this run may leave for a human carry its UTC
  // start (20260929-191530), so a later run of the same name neither overwrites nor deletes them.
  const runTag = new Date(runStartedMs).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const { flowArg, outDir, name, simulator, installs, appId, fresh, codec, cleanStatusBar, showTaps, force, doTighten, minStill, keep, noise, crf, scenario: scenarioRequested, scenarioDir, scenarioVerify } =
    parseArgs(process.argv.slice(2));
  const flowPath = resolve(flowArg);
  const flowName = name ?? `${basename(flowPath, extname(flowPath))}-ios`;

  // Every file this run intends to write, named before anything is touched — that is what the
  // no-clobber check needs, and it is why these paths are computed up here rather than at the
  // point of use. `-tight.mp4` is protected with or without --tighten (see PREFLIGHT in the header).
  // `let`: a failed run moves them to the `.failed` names (see failTake below).
  let outPath = join(outDir, `${flowName}.mp4`);
  let sidecarPath = join(outDir, `${flowName}.json`);
  let tightPath = join(outDir, `${flowName}-tight.mp4`);

  const wrapperPlan = plannedWrapper({ flowPath, scenarioDir });
  let tools;
  try {
    // A stash left by a killed earlier run is put back (or refuses the run) BEFORE preflight: the stash
    // hides the very take preflight exists to protect. See A CRASHED STASH in lib/takes.mjs.
    const recovered = await recoverCrashedStash({ outDir, name: flowName });
    if (recovered.state === 'restored') {
      log(`an earlier run of "${flowName}" was killed mid-take; its previous take is back: ${recovered.restored.join(', ')}`);
    }
    // STALE BURN TEMPS (see SALVAGE RINGS): the burn temp `.<name>.taps-<pid>.mp4` of a run of this name that
    // was SIGKILLed, once that pid is dead. Never a live concurrent run's. Not a take, so this needs no --force.
    const burnTemps = new RegExp(`^\\.${escapeRegExp(flowName)}\\.taps-(\\d+)\\.mp4$`);
    for (const path of await sweepDeadRunTemps(outDir, burnTemps)) log(`removed a stale burn temp a killed run left: ${path}`);
    tools = await preflight(flowPath, [outPath, sidecarPath, tightPath], force);
    // The wrapper is derived, so a marked one is overwritten without --force; an unmarked file at its
    // path is someone's own and refuses the run here, before anything is filmed.
    if (scenarioRequested) {
      const target = await checkGeneratedTarget(wrapperPlan.path);
      if (!target.ok) throw new Error(target.reason);
    }
  } catch (err) {
    console.error(`[film-ios] preflight failed: ${err.message}`);
    process.exit(1);
  }
  const { xcrun, maestro, ffmpeg } = tools;
  // Optional: used to describe the delivered file and to check the tail trim's own work. ffmpeg
  // ships it, so this is really only absent on a hand-built ffmpeg.
  const ffprobe = await resolveTool('ffprobe').catch(() => null);

  const flowText = await readFile(flowPath, 'utf8');
  // FLOW LINT (lib/maestro-lint.mjs): warns, before anything is filmed, about a wait that directly follows
  // another wait and will not hold its time. Never refuses; recorded as sidecar `flowLint` when non-empty.
  const flowLint = lintAndReport(flowText, 'film-ios');
  await mkdir(outDir, { recursive: true });

  let udid;
  let statusBarOverridden = false;
  let statusBarPromise = null; // the override in flight or done, so a signal can wait for it

  // THE PREVIOUS TAKE UNDER --force (lib/takes.mjs stashPreviousTake). `stash` stays null until it is
  // made, which is after setup; the two helpers are declared here, ahead of every handler that calls
  // them, and are no-ops with no stash. restorePrevious() runs on every exit that is not an `ok` or
  // `interrupted` take; keepNewTake() runs once such a take is in place.
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
      console.error(`[film-ios] this retake did not succeed, so the previous take was left as it was: ${r.restored.join(', ')}`);
    } else if (r.state === 'blocked') {
      console.error(
        `[film-ios] ⚠️  could NOT put the previous take of "${flowName}" back: ${r.blocked.join(', ')} exists. ` +
          `It is still stashed as ${stash.stashed.map((p) => p.stash).join(', ')} and the next run will refuse until you choose (see the message it prints).`,
      );
    }
    for (const w of r.warnings) console.error(`[film-ios] ⚠️  ${w}`);
  };
  const keepNewTake = async () => {
    if (!stash) return;
    const r = await stash.discard();
    for (const w of r.warnings) console.error(`[film-ios] ⚠️  ${w}`);
  };

  // SETUP-PHASE SIGNAL HANDLERS. Installed before anything on the simulator is touched, so a signal
  // during setup cannot leave the status-bar override behind. Nothing has been filmed yet, so this
  // is a clean exit, not a salvage: put the bar back and go (130 SIGINT / 129 SIGHUP / 143
  // SIGTERM). They are
  // swapped for the full handlers (which salvage) once the recorder is about to roll.
  let setupSignalled = false;
  const onSetupSignal = (signalName, exitCode) => {
    if (setupSignalled) return;
    setupSignalled = true;
    console.error(`\n[film-ios] ${signalName} during setup — nothing was filmed; putting the simulator back.`);
    const restore =
      statusBarPromise && udid
        ? statusBarPromise.then(() => run(xcrun, ['simctl', 'status_bar', udid, 'clear'])).catch(() => {})
        : Promise.resolve();
    restore.then(() => restorePrevious()).finally(() => process.exit(exitCode));
  };
  const setupSigint = () => onSetupSignal('SIGINT', 130);
  const setupSighup = () => onSetupSignal('SIGHUP', 129);
  const setupSigterm = () => onSetupSignal('SIGTERM', 143);
  process.on('SIGINT', setupSigint);
  process.on('SIGHUP', setupSighup);
  process.on('SIGTERM', setupSigterm);
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});

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
    if (cleanStatusBar) {
      statusBarPromise = overrideStatusBar(xcrun, udid);
      statusBarOverridden = await statusBarPromise;
    }
  } catch (err) {
    console.error(`[film-ios] setup failed before recording started: ${err.message}`);
    process.exit(1);
  }

  // A setup-phase signal is already exiting the process (once the status bar is restored); do not
  // let this path run on into starting a recorder in the meantime. Parked, never resolved.
  if (setupSignalled) await new Promise(() => {});

  // Only now, with the device found, the app installed and the recorder about to roll: a run that dies
  // in setup (no simulator, bad --install) has changed nothing about the previous take, so it does not
  // touch it. From here to the first frame there is only I/O that cannot fail the take. Under --force
  // the previous take moves to a hidden stash, so the plain names hold only what THIS run films. The
  // setup handlers above are still installed until the swap below, and restore it.
  try {
    stash = await stashPreviousTake({ outDir, name: flowName, force });
  } catch (err) {
    console.error(`[film-ios] ${err.message}`);
    if (statusBarOverridden) await run(xcrun, ['simctl', 'status_bar', udid, 'clear']).catch(() => {});
    process.exit(1);
  }
  if (stash.stashed.length > 0) log(`--force: the previous take is set aside until this one is safe (${stash.stashed.map((p) => p.plain).join(', ')})`);
  // No signal check here: stashPreviousTake does its file work before it returns, so no handler can
  // run between the last look above and `stash` being set. A signal from here on restores it.

  // Per run (KEPT EVIDENCE IS PER RUN): a raw kept by a failed finalize used to be overwritten by the
  // next run's `recordVideo --force` of the same name.
  const rawLocalPath = join(outDir, `.${flowName}.${runTag}.raw.mp4`);
  // Dot-prefixed so `ls` hides it: it is Maestro's own debugging spill (logs plus a screenshot
  // per failed step), kept only when something went wrong and there is something to look at. Per
  // run, so a previous take's taps are never read here and a kept spill is never deleted by a later run.
  const debugDir = join(outDir, `.${flowName}.${runTag}.maestro-debug`);
  // Failed startup attempts' log dirs are parked here, one `attempt-N` each (film-android's name);
  // per run, removed on success, kept and named on any failure.
  const attemptsDir = join(outDir, `.${flowName}.${runTag}.maestro-attempts`);

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
  // The HELD TAIL encode's result when nothing was burned (see holdToWindow), and its failure. Like
  // tapResult it may carry `preBurnPath`; `finished()` is whichever encode made the delivered take.
  let holdResult = null;
  let holdError = null;
  const finished = () => tapResult ?? holdResult;
  // --debug-output is passed on EVERY run (even --no-show-taps): the startup-retry predicate reads
  // maestro.log and commands-*.json from it. Deleted once the run succeeds, kept on any failure.
  let debugKept = true;
  // One { reason, atSec } per failed attempt that was retried (atSec: seconds into the video when
  // that attempt's failure was judged), `[]` when the first attempt was the only one.
  const maestroRetries = [];
  let durations = null; // { flowSec: the last maestro attempt's own time, retrySec: everything before it }
  // The flow's clock, hoisted so the interrupt handler can read it: the first and the LAST attempt's spawn,
  // and the last attempt's exit. null until set.
  let firstAttemptStartedMs = null;
  let lastAttemptStartedMs = null;
  let lastAttemptEndedMs = null;
  // HELD TAIL inputs every path needs once there is a finalized take: the finalized file's own container
  // duration, measured before any encode touches it (measureFinalized), and the recorder window.
  let finalizedSec = null;
  const windowSecOf = () =>
    recorder?.startedAtMs == null || recordingStoppedMs === null ? null : (recordingStoppedMs - recorder.startedAtMs) / 1000;
  let interrupted = false;
  let interruptedBy = null; // the signal's name once one started the salvage (sidecar `interruptedBy`)
  // DECIDED FAILURES (see the header): the flow's own failure, recorded when the retry loop ends and only if
  // no signal had arrived by then. The interrupt handler sets such a take aside as `flow-failed` instead of
  // salvaging it as `interrupted`.
  let decidedFlowError = null;
  // Where the tap burn writes before it becomes the take. Named out here because Ctrl-C during a
  // 30-second encode has to be able to sweep it up; nothing else knows it exists.
  // The run's pid in the name: a SIGKILL during SALVAGE RINGS leaves it (the orphaned ffmpeg finishes it),
  // and the next run's start removes it once this pid is dead, never a live run's (STALE BURN TEMPS).
  const burnTempPath = join(outDir, `.${flowName}.taps-${process.pid}.mp4`);
  let burning = false;
  // The controller SIGINT uses to stop a burn in flight, and the in-flight promise it awaits
  // before proceeding to salvage/sidecar/exit — so a Ctrl-C mid-burn tears the encoder down
  // deterministically (SIGTERM, escalating to SIGKILL — see lib/tap-overlay.mjs) instead of
  // racing process.exit() against whatever ffmpeg happens to be doing.
  let burnAbortController = null;
  let pendingBurn = null;
  // The same pair for the TIGHTEN pass: tighten() takes an AbortSignal, kills its ffmpeg children
  // and removes its temp output before rejecting with an AbortError, so an interrupt during it
  // leaves neither a running ffmpeg nor a partial `-tight.mp4` (see ABORT in tighten.mjs).
  let tightenAbortController = null;
  let pendingTighten = null;
  let tightenAborted = false; // an AbortError came back: nothing of tighten's is on disk
  // One protected range per drawn tap (see tapProtectRanges), filled in once tapResult is known.
  // Declared here, not where it is assigned, so writeSidecar's closure always finds an
  // initialized value even if it is invoked (e.g. `finalize-failed`) before SHOW_TAPS ever runs.
  let tapProtect = [];
  // The maestro child, so an interrupt can stop it (see stopMaestro) and the retry loop can start
  // a second one. `maestroExited` resolves (never rejects) when the current child is gone.
  let maestroChild = null;
  let maestroExited = Promise.resolve();
  let failedPaths = null; // set by failTake: where the failed take was moved
  let failTakePromise = null; // failTake is one-shot; an interrupt racing it waits on the same run
  // SCENARIO (Part 2). `branchList`: the `runFlow: when:` blocks the take ran (null = no record was
  // readable); `scenarioRecord`: the sidecar's `scenario` block, filled in stages. `takeComplete` flips
  // once the take's final `ok` sidecar is being written: from then on a signal no longer means
  // "salvage" (there is nothing left to salvage) but "stop the scenario work and keep the take".
  let branchList = null;
  let scenarioRecord = null;
  let takeComplete = false;
  let scenarioSignalExit = null; // exit code of the first signal that arrived after takeComplete
  let verifyHandle = null;

  // Maestro's own execution record beats a grep of the flow file: it knows the difference
  // between a `tapOn` and a `tapOn` behind a `when:` that never fired, and it sees taps inside a
  // `runFlow:` include that this file never mentions. Both directions cost a take when guessed.
  // Only meaningful once the flow has RUN, which is why it is a function and not a constant.
  const computeTapsExpected = () => showTaps && flowHasTapCommands(flowText, debugDir);

  const fk = filmkitCommit();
  const writeSidecar = async (status, error = null) => {
    // `output.fps` / `output.encoder`: the burn's or the hold encode's own numbers when one of them made
    // the delivered take, otherwise read off the file (an interrupted take, a decided failure whose burn a
    // signal stopped), so those sidecars are not blank. null only when there is no file.
    const outExists = await fileExists(outPath);
    const fileInfo = !finished() && outExists ? await probeStreamInfo(ffmpeg, outPath).catch(() => null) : null;
    const payload = {
      // `ok` and `error` are the keys film-android's sidecar has; `ok` is true only for a take that
      // is a keeper. An interrupted take is salvaged, not failed, and is not ok either.
      ok: status === 'ok',
      status,
      error,
      // The signal that arrived during the run (film-web's and film-android's key): on `interrupted`, and
      // on a failed take whose failure was decided before it (see DECIDED FAILURES). null otherwise.
      interruptedBy,
      camera: 'ios',
      filmkit: fk ? { commit: fk.commit, branch: fk.branch } : null,
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
        error:
          tapError ??
          (noTapsFound
            ? 'no touch was logged by the iOS driver or by maestro.log'
            : ringsPending
              ? 'the indicators are drawn in a second pass after the take was saved, and this sidecar is rewritten ' +
                'when they land: still reading this means that pass never finished (the process was killed)'
              : null),
      },
      // What the timestamp repair at FINALIZE had to do, measured on the FINALIZED take, before
      // any indicator was burned into it.
      ptsRepair,
      // The file actually handed over: after the ripples and after the phantom-tail cut.
      delivered,
      // `path` null when there is no video (a finalize that failed): a sidecar must not name a missing file.
      output: {
        path: outExists ? outPath : null,
        fps: finished()?.fps ?? fileInfo?.fps ?? null,
        encoder: finished()?.encoder ?? fileInfo?.encoder ?? null,
      },
      crf, // the quality of every re-encode this run did (tighten, the finalize fallback, the burn)
      tighten: tightenResult,
      // One entry per maestro attempt that failed at startup before any command ran and was
      // retried inside the same recording; the extra static head is what tighten / --trim-head cut.
      maestroRetries,
      durations,
      // `branches` (Part 2): present whenever --scenario was asked for (null = no readable record),
      // and otherwise only when the flow actually had `runFlow: when:` blocks other than mode gates,
      // so a take of a flow without any (pause gates and test-only steps do not count) keeps exactly the
      // sidecar keys it always had.
      ...(scenarioRequested ? { branches: branchList } : branchList?.some((b) => !b.modeGate) ? { branches: branchList } : {}),
      ...(scenarioRecord ? { scenario: scenarioRecord } : {}),
      ...(flowLint.length > 0 ? { flowLint } : {}),
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

  // A run that ends in anything but `ok` or `interrupted` steps its take out of the way (#13), the
  // same rule film-android applies: `<name>.mp4` -> `<name>.failed.mp4` (a second failure lands in
  // `.failed-2`, never on top of the first), and the sidecar is written at the `.failed` name, so
  // the name is free for the retake without --force. Also sweeps the pre-burn file --tighten kept
  // aside, which only the tighten step deletes and a failing run never reaches. `interrupted` is a
  // salvage and keeps its name.
  // failTake(status, error, { afterMove }) is the WHOLE failure exit as one promise: the move, then
  // `afterMove` (messages that name where the video went), then the sidecar at the `.failed` name, then
  // the previous take back. One-shot: `failTakePromise` is what an interrupt racing it waits for
  // (bounded by FAIL_EXIT_WAIT_MS), so the failed take keeps its sidecar (see THE PREVIOUS TAKE UNDER
  // --force). An exit that would START after an interrupt already began is not started: the handler owns
  // the run from then on (it sets the take aside itself if its failure was decided, and salvages it as
  // `interrupted` otherwise), so the call parks; the handler passes `salvage`. A signal received before
  // the sidecar is written is recorded there (`interruptedBy`) and noted in `error`; the status stays.
  const failTake = (status, error, { afterMove, salvage = false } = {}) => {
    if (!failTakePromise && interrupted && !salvage) return new Promise(() => {});
    return (failTakePromise ??= (async () => {
      await moveFailedTake();
      afterMove?.();
      await writeSidecar(status, withSignalNote(error));
      await restorePrevious();
    })());
  };
  // A failed take's `error` names a signal that arrived while it was being finished (also on SALVAGE RINGS'
  // rewrite of that sidecar).
  const withSignalNote = (error) => {
    if (!interruptedBy) return error;
    const note = `${interruptedBy} was received while this failed take was being finished`;
    return error ? `${error}; ${note}` : note;
  };
  const moveFailedTake = async () => {
    if (finished()?.preBurnPath) await rm(finished().preBurnPath, { force: true });
    const r = await markTakeFailed({ outDir, name: flowName, since: runStartedMs });
    outPath = r.outPath;
    tightPath = r.tightPath;
    sidecarPath = r.sidecarPath;
    failedPaths = r;
    for (const w of r.warnings) console.error(`[film-ios] ⚠️  ${w}`);
    if (r.moved.length > 0) {
      console.error(`[film-ios] renamed to ${r.outPath} so the take name stays free for the retake.`);
    }
  };

  // `durations` ({ flowSec, retrySec }) and the "maestro flow took" line, on every path that has a flow: main's
  // and the interrupt handler's (which calls it once maestro has exited, so the flow's end is the stopped
  // child's exit). Measured before: only main's path set them, so an interrupted take said `durations: null`.
  const recordFlowDurations = () => {
    if (lastAttemptStartedMs === null || durations) return;
    const endMs = lastAttemptEndedMs ?? Date.now();
    durations = {
      flowSec: Number(((endMs - lastAttemptStartedMs) / 1000).toFixed(2)),
      retrySec: Number(((lastAttemptStartedMs - firstAttemptStartedMs) / 1000).toFixed(2)),
    };
    log(`maestro flow took ${durations.flowSec.toFixed(2)}s${durations.retrySec > 0 ? ` (plus ${durations.retrySec.toFixed(2)}s of startup retries and backoff)` : ''}`);
  };

  // The finalized take's own container duration (it ignores a phantom final sample), read once, right after
  // FINALIZE and before any encode replaces the file: the HELD TAIL's `finalizedSec` on every path.
  const measureFinalized = async () => {
    if (finalizedSec === null && ffprobe) finalizedSec = await containerDuration(ffprobe, outPath).catch(() => null);
    return finalizedSec;
  };

  // `delivered`, the same shape on EVERY take that has a file: after an encode (`{ ...trimPhantomTail's
  // result, heldTail }`) or without one (`{ applied: false, reason, frames, durationSec, width, height,
  // heldTail }`). `heldTail` = { windowSec, finalizedSec, pinnedSec, heldSec }: how far past its last change
  // the take holds. A take that was not pinned (a failed flow, an interrupted take, one no encode touched)
  // says pinnedSec null and heldSec 0, and that is now TRUE of the file: an unpinned encode is cut back to
  // the finalized length (within one frame of the encode's rounding), not to the recorder window. Measured
  // before: an unpinned burn cut to the window held its last change 0.218s while saying heldSec 0, and an
  // interrupted take or a flow-failed one no encode touched had no `heldTail` at all (`delivered: null` on
  // an interrupted take).
  const describeDelivered = async (pinSec) => {
    const windowSec = windowSecOf();
    const heldTail = (durationSec) => ({
      windowSec: windowSec === null ? null : Number(windowSec.toFixed(3)),
      finalizedSec: finalizedSec === null ? null : Number(finalizedSec.toFixed(3)),
      pinnedSec: pinSec === null ? null : Number(pinSec.toFixed(3)),
      heldSec:
        pinSec === null ? 0
          : finalizedSec === null || !(durationSec > 0) ? null
            : Number(Math.max(0, durationSec - finalizedSec).toFixed(3)),
    });
    if (finished()) {
      // After a pinned encode the take already ends at the pin, so this is only the residual check it always
      // was. An unpinned encode is cut back to where the finalized take ends, with one encode frame of slack.
      const target = pinSec ?? finalizedSec ?? windowSec ?? 0;
      const trim = await trimPhantomTail(ffmpeg, ffprobe, outPath, target, pinSec === null ? UNPINNED_TAIL_SLACK_SEC : undefined);
      if (trim.applied) {
        log(`cut ${trim.secRemoved.toFixed(2)}s of frozen tail the recorder's last frame claimed but never filmed`);
      } else if (trim.reason && trim.reason !== 'no phantom tail') {
        log(`⚠️  phantom-tail check skipped — ${trim.reason}`);
      }
      return { ...trim, heldTail: heldTail(trim.durationSec) };
    }
    if (!ffprobe || !(await fileExists(outPath))) return null;
    const out = await runCapture(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0', '-count_packets',
      '-show_entries', 'stream=nb_read_packets,width,height:format=duration', '-of', 'default=nw=1:nk=1', outPath,
    ]).catch(() => null);
    if (!out) return null;
    const [w, h, frames, duration] = out.trim().split('\n');
    return {
      applied: false,
      reason: 'no encode ran, so no resampled tail to cut',
      frames: Number(frames),
      durationSec: Number(duration),
      width: Number(w),
      height: Number(h),
      heldTail: heldTail(Number(duration)),
    };
  };

  // SALVAGE RINGS (see the header). A take that leaves without its burn (a signal; an unplanned error) still
  // gets the rings for the taps that happened, in a SECOND pass that starts only once the take and its
  // sidecar are final: delivered, described, the stash settled. So nothing the burn costs in time can cost
  // the take: a second signal aborts it (`salvageBurn`, see onInterrupt) and a SIGKILL during it leaves the
  // delivered, described, ringless take (and at most the burn's dot-prefixed temp). The burn is main's own
  // drawTaps, unpinned (an interrupted or failed take ends at its last change); when it lands, `delivered` is
  // measured again and `rewrite()` writes the sidecar again. Skipped: --no-show-taps, rings already drawn, a
  // burn that failed on its own (its error stands), no "Recording started" anchor, no file.
  let salvageBurn = null; // { controller, skippedBy } while the second pass runs
  let ringsPending = false; // the sidecar written before that pass says the rings are still to come
  let burnAbortedBySignal = false; // main's burn was stopped by a signal (its AbortError is not its own failure)
  const ringsOwed = () =>
    showTaps && !tapResult && !noTapsFound && !(tapError !== null && !burnAbortedBySignal) && recorder?.startedAtMs != null && recordingStoppedMs !== null;
  const salvageRings = async (outcome, rewrite) => {
    if (!ringsOwed() || !(await fileExists(outPath))) {
      ringsPending = false;
      return;
    }
    const controller = new AbortController();
    salvageBurn = { controller, skippedBy: null };
    log('drawing the tap indicators into the saved take (it is already saved without them: a second signal skips this)...');
    tapError = null;
    try {
      const drawn = await drawTaps({
        ffmpeg,
        videoPath: outPath,
        tmpPath: burnTempPath,
        videoSize: outcome.size ?? null,
        debugDir,
        recordingStartedMs: recorder.startedAtMs,
        recordingStoppedMs,
        codec,
        keepPreBurn: false,
        crf,
        pinDurationSec: null,
        signal: controller.signal,
      });
      if (drawn === null) {
        noTapsFound = true;
      } else {
        tapResult = drawn;
        tapProtect = tapProtectRanges(drawn.taps);
        log(`drew ${drawn.taps.length} tap indicator(s) into the saved take (${drawn.encoder}, ${drawn.elapsedSec.toFixed(1)}s)`);
        delivered = await describeDelivered(null);
      }
    } catch (err) {
      tapError = salvageBurn.skippedBy ? `a second ${salvageBurn.skippedBy} skipped drawing them after the take was saved` : err.message;
      console.error(`[film-ios] ⚠️  no tap indicators drawn into the saved take — ${tapError}`);
    } finally {
      salvageBurn = null;
      ringsPending = false;
    }
    await rewrite();
  };

  // SCENARIO PHASE (Part 2, --scenario): only ever entered with a finished `ok` take. Everything in it
  // is recorded, nothing in it can fail the take: emit and check-syntax failures, a red verify and a
  // signal all leave `status: "ok"` and the video where it is, and set the exit code (2, or the
  // signal's) instead. States: EMIT -> CHECK -> [VERIFY] -> done; each step rewrites the sidecar, and
  // scenarioSignalExit is looked at after each one (check-syntax is bounded, verify is aborted by the
  // handler), so a signal skips the remaining steps and is recorded where it landed.
  const runScenarioPhase = async () => {
    const notCarried = [];
    if (installs.length > 0) notCarried.push('--install');
    if (cleanStatusBar) notCarried.push('--clean-status-bar');
    scenarioRecord = { wrapper: null, preconditions: [], notCarried, pauseSec: null, warnings: [], checkSyntax: null, verify: null };
    try {
      log('emitting the scenario wrapper...');
      const emitted = await emitMaestroScenario({
        camera: 'ios',
        flowPath,
        flowText,
        scenarioDir,
        fresh,
        branches: branchList,
        notCarried,
        filmkit: fk,
      });
      scenarioRecord = { ...scenarioRecord, wrapper: emitted.wrapper, preconditions: emitted.preconditions, pauseSec: emitted.pauseSec, warnings: emitted.warnings };
      log(`${emitted.action === 'overwrite' ? 'rewrote' : 'wrote'} ${emitted.wrapper}`);
      for (const w of emitted.warnings) log(`⚠️  warning: ${w}`);
      const check = scenarioSignalExit === null ? await checkWrapper({ maestro, wrapperPath: emitted.wrapper, flowPath }) : null;
      if (check) {
        scenarioRecord.checkSyntax = check;
        log(check.ok ? 'maestro check-syntax: OK' : `⚠️  maestro check-syntax failed:\n${check.output}`);
        await writeSidecar('ok');
      }
      if (check && scenarioSignalExit === null && scenarioVerify) {
        log(
          emitted.preconditions.length > 0
            ? `--scenario-verify: running the wrapper now; its ${emitted.preconditions.join(' + ')} WIPES the app's data on ${udid}`
            : '--scenario-verify: running the wrapper once...',
        );
        // Wall-clock cap enforced here, where the run is owned (Maestro has no per-flow timeout in YAML):
        // 3x the filmed flow time + 60s, the rule the web scenario uses for its test timeout.
        const timeoutMs = Math.round(3 * (durations?.flowSec ?? 60) * 1000 + 60_000);
        verifyHandle = startVerify({ maestro, deviceId: udid, wrapperPath: emitted.wrapper, timeoutMs });
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
      console.error(`[film-ios] ⚠️  scenario export failed (the take is fine and stays ok): ${err.message}`);
    }
    await writeSidecar('ok');
    if (scenarioSignalExit === null) {
      const bad = Boolean(scenarioRecord.error) || scenarioRecord.checkSyntax?.ok === false || (scenarioRecord.verify && scenarioRecord.verify.status !== 'passed');
      if (bad) process.exitCode = 2;
    }
  };

  // Where the failed maestro startup attempts' logs are kept, said on every exit that keeps them
  // (a successful run removes the directory).
  const reportAttempts = () => {
    if (maestroRetries.length > 0) {
      console.error(`[film-ios] maestro was retried ${maestroRetries.length} time(s) at startup; the failed attempts' logs: ${attemptsDir}`);
    }
  };

  // Stop the maestro child if there is one: SIGINT, then SIGKILL after a grace period, the way
  // film-android does. Resolves once it is gone, so the process never exits with a flow still
  // tapping a simulator nothing is recording. A terminal's Ctrl-C reaches maestro through the
  // process group as well; a bare `kill` of this pid alone does not, which is why this exists.
  const stopMaestro = () => {
    const child = maestroChild;
    if (!child) return Promise.resolve();
    console.error('[film-ios] stopping the maestro flow...');
    child.kill('SIGINT');
    const escalate = setTimeout(() => {
      console.error(`[film-ios] the flow ignored SIGINT for ${MAESTRO_ABORT_GRACE_MS / 1000}s — killing it.`);
      child.kill('SIGKILL');
    }, MAESTRO_ABORT_GRACE_MS);
    return maestroExited.then(() => clearTimeout(escalate));
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
      const fin = await finalizeVideo(ffmpeg, rawLocalPath, outPath, crf);
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

  // NOTHING FILMED: a signal before any flow command started (the warmup, the maestro JVM starting, a
  // startup retry's backoff) ends a run that filmed nothing but the screen as it was. It is a setup-phase
  // signal in effect: stop the recorder, put the status bar back, remove this run's raw and simctl spill and
  // its debug spill, no take, no sidecar, the previous take back, the signal's exit code. Measured before: a
  // 0.067s `interrupted` take that, under --force, replaced the previous take. Failed startup attempts'
  // logs are kept (and named) if there were any: they are why the flow never began.
  const discardNothingFilmed = async (signalName) => {
    if (recorder) {
      recordingStoppedMs = Date.now();
      await stopRecording(recorder);
    }
    await restoreStatusBar();
    const rawName = basename(rawLocalPath);
    for (const f of await readdir(outDir).catch(() => [])) {
      if (f === rawName || f.startsWith(`${rawName}.sb-`)) await rm(join(outDir, f), { force: true });
    }
    await rm(debugDir, { recursive: true, force: true });
    if (maestroRetries.length > 0) reportAttempts();
    else await rm(attemptsDir, { recursive: true, force: true });
    console.error(`[film-ios] ${signalName} arrived before the flow started — nothing was filmed: no take, no sidecar.`);
    await restorePrevious();
  };

  // Without this, Ctrl-C takes Node's default disposition and the process dies where it stands:
  // `simctl io recordVideo` outlives it, the dot-prefixed raw is orphaned, no sidecar is written,
  // and a --clean-status-bar simulator is left insisting it is 9:41 with a full battery. With it,
  // Ctrl-C is just another route into salvage() and out through 130, the shell's own convention.
  // SIGTERM takes it too (exit 143), and SIGHUP (exit 129): the latter is what a camera launched
  // from an agent's shell receives when that shell's turn ends or its terminal closes. All three
  // go through onInterrupt().
  const onInterrupt = (signalName, exitCode) => {
    if (takeComplete) {
      // The new take is final, so it owns the names: drop the previous take's stash now, synchronously
      // (discard does its file work before returning), because a second signal below exits at once.
      stash?.discard();
      // The take is finished and its sidecar is written (or being written): a signal now can only
      // mean "stop the scenario checks". Nothing is salvaged and the status stays `ok`. main() sees
      // scenarioSignalExit after each scenario step, records how far it got, and exits with the code.
      // A SECOND signal is the operator insisting: kill the verify run outright and go.
      if (scenarioSignalExit !== null) {
        verifyHandle?.kill();
        process.exit(exitCode);
      }
      scenarioSignalExit = exitCode;
      console.error(`\n[film-ios] ${signalName} — the take is already saved; stopping the scenario checks (a second signal exits now).`);
      verifyHandle?.abort();
      return;
    }
    if (salvageBurn) {
      // SALVAGE RINGS: the take and its sidecar are already final; this signal only skips the second pass.
      // Its owner rewrites the sidecar (the rings were skipped, and why) and exits as it was going to.
      if (!salvageBurn.skippedBy) {
        salvageBurn.skippedBy = signalName;
        console.error(`\n[film-ios] ${signalName} — skipping the tap indicators; the take is already saved without them.`);
        salvageBurn.controller.abort();
      }
      return;
    }
    if (interrupted) {
      // After a hangup there is nobody to read this, and the write is swallowed; after Ctrl-C it
      // is the operator being told not to bother.
      console.error(`[film-ios] still saving what was filmed — a second ${signalName} will not make it faster.`);
      return;
    }
    interrupted = true;
    interruptedBy = signalName;
    console.error(`\n[film-ios] ${signalName} — stopping the recorder and saving what was filmed so far...`);
    // The flow must not outlive the take: a maestro still running would keep tapping a simulator
    // nothing is recording. Started now, awaited before exit.
    const stoppingMaestro = stopMaestro();
    // NOTHING FILMED (see the header): judged on maestro.log as it stands at the signal, before the
    // stopping maestro can add to it. An unreadable log counts as "ran": that answer keeps the take.
    const commandRan = maestroCommandRan(debugDir).catch(() => true);
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
      console.error('[film-ios] a tap-indicator burn is in progress — stopping the encoder (the rings are drawn again once the take is saved)...');
      burnAbortedBySignal = true;
      burnAbortController?.abort();
    }
    // The same for a tighten pass in flight (only one of the two can be running: they are
    // sequential). Awaited too, so no ffmpeg outlives process.exit() and no partial `-tight.mp4`
    // is left for the next run's overwrite check to trip on.
    const abortingTighten = pendingTighten !== null;
    if (abortingTighten) {
      console.error('[film-ios] --tighten is in progress — stopping it...');
      tightenAbortController?.abort();
    }
    Promise.all([
      abortingBurn && pendingBurn ? pendingBurn.catch(() => {}) : null,
      abortingTighten ? pendingTighten.catch(() => {}) : null,
    ])
      .then(async () => ((await commandRan) ? runSalvage() : null))
      .then(async (outcome) => {
        if (outcome === null) {
          await discardNothingFilmed(signalName);
          return;
        }
        // The flow's end (the stopped child's exit) and its final command record exist only once maestro is
        // gone; bounded by MAESTRO_ABORT_GRACE_MS (SIGKILL after it).
        await stoppingMaestro;
        recordFlowDurations();
        tapsExpected = computeTapsExpected();
        // A tighten that settled before the abort landed is complete on disk; one that was
        // aborted left nothing. Either way the pre-burn file has no job left.
        if (finished()?.preBurnPath) await rm(finished().preBurnPath, { force: true });
        // HELD TAIL: the same `delivered` shape as every other take (unpinned: a signal ended it), unless main's
        // path had already described a finished encode before the signal.
        if (outcome.ok && !failTakePromise) {
          await measureFinalized();
          if (!delivered) delivered = await describeDelivered(null);
          // SALVAGE RINGS: if a second pass will draw them, the first sidecar says so.
          ringsPending = ringsOwed() && (await fileExists(outPath));
        }
        // An interrupt racing a failure exit already under way is that failure, not an interrupted take:
        // wait for the whole of it (move, sidecar, restore; see failTake), bounded by FAIL_EXIT_WAIT_MS.
        if (failTakePromise) {
          const settled = await Promise.race([
            failTakePromise.then(() => true, () => true),
            sleep(FAIL_EXIT_WAIT_MS).then(() => false),
          ]);
          if (!settled) {
            console.error(
              `[film-ios] ⚠️  the failed take was still being set aside after ${FAIL_EXIT_WAIT_MS / 1000}s — ` +
                'exiting without waiting for it; its sidecar may be missing.',
            );
          }
        }
        if (outcome.ok && !failTakePromise && decidedFlowError !== null) {
          // The flow had already failed before this signal (DECIDED FAILURES): that is the take's status,
          // not `interrupted`. Set aside like main's flow-failed exit (failTake notes the signal), and the
          // previous take comes back.
          console.error(`[film-ios] the flow had already failed before ${signalName} — setting the take aside as flow-failed, not as interrupted.`);
          await failTake('flow-failed', decidedFlowError, {
            salvage: true,
            afterMove: () => {
              console.error(`[film-ios] maestro flow "${flowName}" failed: ${decidedFlowError}`);
              console.error(`[film-ios] the partial recording was still saved to ${outPath} for debugging.`);
              if (debugKept) console.error(`[film-ios] maestro's own debug output (logs, failure screenshots): ${debugDir}`);
              reportAttempts();
            },
          });
          await salvageRings(outcome, () => writeSidecar('flow-failed', withSignalNote(decidedFlowError)));
        } else if (outcome.ok && !failTakePromise) {
          console.error(
            `[film-ios] interrupted — what was filmed is in ${outPath}, ` +
              (tapResult ? 'with tap indicators.' : ringsPending ? 'its tap indicators are drawn next.' : 'WITHOUT tap indicators.'),
          );
          if (tightenAborted) console.error('[film-ios] the --tighten pass was stopped and left no -tight.mp4.');
          else if (tightenResult && !tightenResult.skipped) console.error(`[film-ios] --tighten had already finished; the tight file is complete: ${tightenResult.outPath}`);
          if (debugKept) console.error(`[film-ios] maestro's debug output was kept: ${debugDir}`);
          reportAttempts();
          await writeSidecar('interrupted', `interrupted by ${signalName}`);
          // The interrupted take has a video and a sidecar: it replaces the previous take.
          await keepNewTake();
          await salvageRings(outcome, () => writeSidecar('interrupted', `interrupted by ${signalName}`));
        } else if (!outcome.ok) {
          console.error(`[film-ios] interrupted before anything could be saved (${outcome.reason}).`);
          await restorePrevious();
        } else {
          console.error('[film-ios] interrupted while a failed take was being set aside — it stays a failed take.');
          await restorePrevious();
        }
      })
      .catch((err) => console.error(`[film-ios] could not save the interrupted take: ${err.message}`))
      // Whatever went wrong above: if the previous take was not replaced, it goes back (a no-op once
      // keepNewTake or an earlier restore has settled).
      .then(() => restorePrevious())
      .then(() => stoppingMaestro)
      .finally(() => process.exit(exitCode));
  };
  // Swap the setup-phase handlers (clean exit, nothing filmed) for these (salvage). Synchronous,
  // so there is no instant with neither installed. The stdout/stderr 'error' listeners were added
  // at setup: after a hangup every console write fails with EIO/EPIPE, and an unhandled stream
  // error would kill the very salvage this handler starts.
  if (setupSignalled) await new Promise(() => {}); // last look, with no await before the swap
  process.off('SIGINT', setupSigint);
  process.off('SIGHUP', setupSighup);
  process.off('SIGTERM', setupSigterm);
  process.on('SIGINT', () => onInterrupt('SIGINT', 130));
  process.on('SIGHUP', () => onInterrupt('SIGHUP', 129));
  process.on('SIGTERM', () => onInterrupt('SIGTERM', 143));

  // Everything from here on has a recorder to tear down. An error nobody planned for (a throw out of
  // a helper) gets the same treatment as any other failed run: salvage what was filmed, step the
  // take aside, write the sidecar, exit 1 — rather than Node's stack trace and a recorder left rolling.
  try {
    log('starting screen recording...');
    recorder = startRecording(xcrun, udid, rawLocalPath, codec);
    await sleep(RECORD_WARMUP_MS);
    // A signal during the warmup started salvage (which stops this very recorder) and owns the
    // exit code: park, or the dead recorder below would be misread as a failed start and this
    // path would delete the raw file under the handler's finalize and exit 1 instead of 130/129/143.
    if (interrupted) await new Promise(() => {});
    // FAIL FAST, before the flow runs, if simctl's recorder is already gone. Whatever the reason
    // (a held recorder, a refused codec, a killed child), a flow run now would be filmed by
    // nothing, so this is a setup failure: nothing was filmed, no sidecar, nothing renamed, the
    // status bar put back, exit 1. "Host recording is already in progress" (exit 16: a live or
    // uncleanly stopped recorder still holds the simulator) additionally gets its remedy, which is
    // deliberately NOT done for the operator: shutting a simulator down takes its running apps too.
    if (!recorder.isRunning) {
      const said = recorder.stderr.trim();
      console.error(`[film-ios] the screen recorder on ${udid} ended before the flow started (${recorder.exitDescription}).`);
      if (said) console.error(`[film-ios] simctl said:\n${said.split('\n').map((l) => `  ${l}`).join('\n')}`);
      if (/already in progress/i.test(said)) {
        console.error('[film-ios] Another recorder holds this simulator: one still running, or one that was stopped uncleanly.');
        console.error(`[film-ios] Remedy: xcrun simctl shutdown ${udid} && xcrun simctl boot ${udid}   (not done for you)`);
      }
      console.error('[film-ios] Nothing was filmed and the flow was not run.');
      await restoreStatusBar();
      await restorePrevious();
      // A recorder that died leaves its empty raw and simctl's unplayable `.sb-*` spill behind.
      const rawName = basename(rawLocalPath);
      for (const f of await readdir(outDir).catch(() => [])) {
        if (f === rawName || f.startsWith(`${rawName}.sb-`)) await rm(join(outDir, f), { force: true });
      }
      process.exit(1);
    }

    // Run from the CALLER's working directory so relative paths inside the flow yaml resolve against
    // the user's project, not this repo. `--udid` is load-bearing when an Android emulator is also
    // running — without it maestro happily picks whichever device it likes. `--debug-output` is
    // always on: it is where the tap times come from (an included flow can tap even when this file
    // shows no tap command) and where the startup-retry predicate looks.
    const maestroArgs = ['test', '--udid', udid, '-e', 'FILMKIT_MODE=film', '--debug-output', debugDir, flowPath];
    // Spawned here rather than through run() because an interrupt needs the child. stdout and stdin
    // stay inherited, so maestro's live progress renders on the terminal exactly as before; stderr is
    // piped and forwarded verbatim, and its tail kept, because the iOS driver-startup timeout is
    // printed only there (see lib/tap-overlay.mjs, MAESTRO STARTUP UNAVAILABLE).
    let maestroStderrTail = '';
    const runMaestroOnce = () => {
      // The last look before spawning, with nothing awaited between it and the spawn: a child
      // started after an interrupt would never be stopped (stopMaestro already ran against a null
      // child). Parked; the handler finishes the run and exits.
      if (interrupted) return new Promise(() => {});
      return new Promise((resolveFlow, rejectFlow) => {
        maestroStderrTail = '';
        lastAttemptStartedMs = Date.now();
        firstAttemptStartedMs ??= lastAttemptStartedMs;
        const child = spawn(maestro, maestroArgs, { stdio: ['inherit', 'inherit', 'pipe'] });
        maestroChild = child;
        let settle;
        maestroExited = new Promise((r) => (settle = r));
        child.stderr.on('data', (chunk) => {
          process.stderr.write(chunk);
          maestroStderrTail = (maestroStderrTail + chunk.toString('utf8')).slice(-20_000);
        });
        child.on('error', (err) => {
          maestroChild = null;
          lastAttemptEndedMs = Date.now();
          settle();
          rejectFlow(new Error(`failed to run \`${maestro} ${maestroArgs.join(' ')}\`: ${err.message}`));
        });
        child.on('exit', (code, signal) => {
          maestroChild = null;
          lastAttemptEndedMs = Date.now();
          settle();
          if (signal) return rejectFlow(new Error(`\`${maestro} ${maestroArgs.join(' ')}\` was killed by ${signal}`));
          if (code !== 0) return rejectFlow(new Error(`\`${maestro} ${maestroArgs.join(' ')}\` exited with code ${code}`));
          resolveFlow();
        });
      });
    };
    // RETRY, inside the same recording, while maestro fails at startup before any command ran (#27):
    // the recorder keeps rolling and the extra static head is what tighten / --trim-head cut. The
    // predicate demands both a known startup signature and an empty command record, so a flow that
    // already tapped something is never run twice. Every attempt writes its own run under the same
    // debug dir, and the predicate, the tap parser and the command record all take the NEWEST run
    // there (locateLogs), i.e. the latest attempt only. At least one retry is always made; after
    // that, retries continue only while the first failure ended less than the budget ago.
    let firstFailureEndedMs = null;
    for (let attempt = 1; ; attempt++) {
      if (interrupted) await new Promise(() => {});
      try {
        log(`running maestro test ${flowPath}${attempt > 1 ? ` (attempt ${attempt})` : ''}...`);
        await runMaestroOnce();
        maestroError = null;
        break;
      } catch (err) {
        maestroError = err;
        if (interrupted) break;
        const verdict = await maestroStartupUnavailable({ debugDir, outputText: maestroStderrTail }).catch(() => null);
        if (!verdict?.retry) break;
        const now = Date.now();
        firstFailureEndedMs ??= now;
        const giveUp = () => {
          log(`⚠️  maestro failed at startup again (${verdict.reason}) — retry budget of ${MAESTRO_RETRY_BUDGET_MS / 1000}s spent, giving up`);
        };
        if (attempt > 1 && now - firstFailureEndedMs >= MAESTRO_RETRY_BUDGET_MS) {
          giveUp();
          break;
        }
        // The failed attempt's driver runner is still alive and would fail the retry too: reap this
        // simulator's, and only this simulator's, before the backoff.
        const reap = await reapStaleDrivers(udid);
        if (reap.reaped > 0) log(`reaped ${reap.reaped} stale xcodebuild driver process(es) on this simulator (pid ${reap.pids.join(', ')})`);
        log(
          `⚠️  maestro failed at startup (${verdict.reason}) — attempt ${attempt} of the flow; ` +
            `retrying inside the same take in ${MAESTRO_RETRY_BACKOFF_MS / 1000}s`,
        );
        // Wake early on an interrupt: a 5s backoff must not delay the salvage a signal started.
        for (let waited = 0; waited < MAESTRO_RETRY_BACKOFF_MS && !interrupted; waited += 250) await sleep(250);
        if (interrupted) break;
        // No attempt STARTS past the budget: checked again now the backoff is spent. Giving up
        // leaves the failed attempt's own logs in the debug dir, where the failure report points.
        if (attempt > 1 && Date.now() - firstFailureEndedMs >= MAESTRO_RETRY_BUDGET_MS) {
          giveUp();
          break;
        }
        // Committed to another attempt. Move the failed attempt's log dir out of the debug dir, so
        // the predicate, the tap parser and the command record can only ever see the latest
        // attempt: without this a retry that dies before writing its own maestro.log (a JVM crash)
        // would be judged, and retried, on the previous attempt's log. Same dir name and shape as
        // film-android's.
        const { testDir } = await locateLogs(debugDir);
        if (testDir) {
          try {
            await mkdir(attemptsDir, { recursive: true });
            await rename(testDir, join(attemptsDir, `attempt-${attempt}`));
          } catch (moveErr) {
            console.error(`[film-ios] ⚠️  could not move the failed attempt's logs out of ${debugDir}: ${moveErr.message}`);
          }
        }
        maestroRetries.push({
          reason: verdict.reason,
          atSec: recorder.startedAtMs === null ? null : Number(((now - recorder.startedAtMs) / 1000).toFixed(3)),
          reaped: reap.reaped,
        });
      }
    }
    // The flow's own time is the LAST attempt's; the failed startups and the backoff before it are
    // reported apart, so `flowSec` means the same thing with or without a retry.
    if (!interrupted) recordFlowDurations();

    // Decided (see DECIDED FAILURES): the flow failed on its own, not because a signal stopped it.
    if (maestroError && !interrupted) decidedFlowError = maestroError.message;

    // A signal during the flow owns the salvage (it may not even run one: NOTHING FILMED).
    if (interrupted) return;
    const outcome = await runSalvage();
    if (interrupted) return; // the SIGINT handler owns the sidecar and the exit code
    if (!outcome.ok) {
      reportAttempts();
      await failTake('finalize-failed', outcome.reason ?? null);
      if (interrupted) return; // a signal during the step-aside waited for it and owns the exit code
      process.exit(1);
    }
    const recordingStartedMs = recorder.startedAtMs;
    // Now that the flow has run there is a record of what it actually did, so ask that.
    tapsExpected = computeTapsExpected();

    // HELD TAIL (see the header): the delivered take lasts as long as the camera rolled, Recording
    // started to the SIGINT, holding its last frame to the stop. Never shorter than the finalized
    // file's own container duration (which ignores a phantom final sample), so no frame that exists
    // is ever cut. null when simctl never said when it started: then nothing is pinned or held.
    const windowSec = windowSecOf();
    await measureFinalized();
    // A failed flow is stepped aside UNHELD (see HELD TAIL): it ends at its last change whether or not
    // it tapped. So neither the burn nor the zero-ring encode gets a pin for it. Before, the burn was
    // pinned unconditionally and only the zero-ring hold checked the flow, so a failed flow that had
    // tapped came out held to the stop (measured: 12.4s of frozen tail, `delivered.heldTail` filled in)
    // and one that had not came out unheld.
    const pinSec = windowSec === null || maestroError ? null : Math.max(windowSec, finalizedSec ?? 0);

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
            crf,
            pinDurationSec: pinSec,
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
      await failTake('taps-missing', `tap indicators could not be derived: ${why}`, {
        // after the move, so the messages name where the video actually is
        afterMove: () => {
          console.error(`\n[film-ios] tap indicators could not be derived for "${flowName}" — ${why}`);
          console.error(`[film-ios]   maestro debug output: ${debugDir}`);
          console.error(`[film-ios]   the recording was still written, WITHOUT indicators: ${outPath}`);
          console.error('[film-ios]   pass --no-show-taps to film without them on purpose.');
        },
      });
      if (interrupted) return; // a signal during the step-aside waited for it and owns the exit code
      process.exit(1);
    }
    if (tapError) log(`⚠️  no tap indicators drawn — ${tapError}`);

    // HELD TAIL for a take nothing was burned into: the same pinned encode with zero rings (a failed
    // flow has no pin, see above: it is stepped aside unheld below). Abortable exactly like the burn.
    if (!tapResult && pinSec !== null && (finalizedSec === null || pinSec - finalizedSec > 1 / 60)) {
      try {
        burning = true;
        burnAbortController = new AbortController();
        pendingBurn = holdToWindow({
          ffmpeg,
          videoPath: outPath,
          tmpPath: burnTempPath,
          codec,
          crf,
          keepPreBurn: doTighten,
          pinDurationSec: pinSec,
          signal: burnAbortController.signal,
        });
        holdResult = await pendingBurn;
        log(
          `held the last frame to the camera's stop: ${finalizedSec === null ? '?' : finalizedSec.toFixed(2)}s -> ${pinSec.toFixed(2)}s ` +
            `(${holdResult.encoder}, ${holdResult.elapsedSec.toFixed(1)}s)`,
        );
      } catch (err) {
        holdError = err.message;
      } finally {
        burning = false;
        burnAbortController = null;
        pendingBurn = null;
      }
      if (interrupted) return; // the interrupt handler owns the rest
      if (holdError) log(`⚠️  could not hold the last frame to the camera's stop (${holdError}) — the take ends at its last change`);
    }

    // What was delivered, in the one shape every take has (describeDelivered): after a pinned encode the take
    // already ends at the pin; an unpinned one (a failed flow) is cut back to the finalized length.
    delivered = await describeDelivered(pinSec);

    if (maestroError) {
      await failTake('flow-failed', maestroError.message, {
        // after the move, so the messages name where the video actually is
        afterMove: () => {
          console.error(`\n[film-ios] maestro flow "${flowName}" failed: ${maestroError.message}`);
          console.error(`[film-ios] the partial recording was still saved to ${outPath} for debugging.`);
          console.error(`[film-ios] maestro's own debug output (logs, failure screenshots): ${debugDir}`);
          reportAttempts();
        },
      });
      if (interrupted) return; // a signal during the step-aside waited for it and owns the exit code
      process.exit(1);
    }

    // The branch record (which `runFlow: when:` blocks ran) exists only in this spill, which is about
    // to go: read it now, before the delete. Cheap (a few small JSON files locateLogs already found
    // for the tap parse) and it never fails the take.
    try {
      const { branches, filesRead } = await readBranches({ debugDir, recordingStartedMs });
      branchList = filesRead > 0 ? branches : null;
    } catch (err) {
      branchList = null;
      log(`⚠️  could not read the branch record — ${err.message}`);
    }

    // Nothing went wrong, so Maestro's spill is noise. It only earns its keep on a failure.
    await rm(debugDir, { recursive: true, force: true });
    await rm(attemptsDir, { recursive: true, force: true });
    debugKept = false;

    console.log(`\n[film-ios] Demo video written: ${outPath}`);

    if (doTighten) {
      tightenAbortController = new AbortController();
      try {
        // Contiguous with the controller above (no await between them) so the interrupt handler
        // can never see a controller without its promise.
        pendingTighten = tighten(outPath, {
          signal: tightenAbortController.signal,
          minStill,
          keep,
          noise,
          crf,
          // Rings were burned in, so freeze detection against outPath would be reading the burn's
          // own quantization noise, not the recorder's — see DETECT-FROM in tighten.mjs's header.
          // Without rings (no taps, or --no-show-taps) this stays undefined and tighten runs exactly
          // as it did before this feature existed.
          // The delivered take holds the pre-burn file's last frame to the camera's stop (HELD TAIL):
          // declared, so tighten's guard expects it and its freeze detection sees the same hold.
          ...(finished()?.preBurnPath
            ? { detectFrom: finished().preBurnPath, detectFromHoldSec: delivered?.heldTail?.heldSec ?? 0 }
            : {}),
          // The tap ranges are already in memory — no reason to make tighten re-read them off the
          // sidecar this process is about to write.
          ...(tapProtect.length > 0 ? { protect: tapProtect, protectMarginSec: 0, sidecar: false } : {}),
        });
        const result = await pendingTighten;
        tightenResult = result;
        if (result.skipped) {
          log(`already tight (${result.skipDetail || 'no static stretches found'}) — kept raw only: ${outPath}`);
        } else {
          // The written file's length (fileDurationSec), not the plan's: the encode lands a frame or two
          // off it, and the console must agree with ffprobe and the sidecar's `tighten.fileDurationSec`. The
          // removal is A - B (cutSummary), so the line closes; the sidecar has both `tighten.fileRemovedSec`
          // and the plan's `tighten.removedSec`. Measured before: "tightened 22.25s -> 10.10s (4 cuts, 12.24s
          // removed)".
          log(`tightened ${cutSummary(result).line}`);
          console.log(`[film-ios] Tightened demo video written: ${result.outPath}`);
        }
      } catch (err) {
        if (err?.name === 'AbortError') {
          // Stopped by an interrupt; tighten removed its temp and its children are gone. The
          // handler owns the sidecar and the exit code.
          tightenAborted = true;
        } else {
          console.error(`[film-ios] --tighten skipped — ${err.message}`);
        }
      } finally {
        // The pre-burn file only ever existed to feed --detect-from above; tighten has now either
        // used it, failed trying or been aborted, and in every case there is nothing left to do with
        // it. (The interrupt handler removes it too, in case it fires before this line runs.)
        if (finished()?.preBurnPath) await rm(finished().preBurnPath, { force: true });
        pendingTighten = null;
        tightenAbortController = null;
      }
      if (interrupted) return; // an interrupt during tighten: the handler finishes the run
    }

    // A signal during the awaits since the last look (the branch read, the spill removal) started the
    // interrupt salvage, which owns the run from there: do not also declare it `ok`.
    if (interrupted) return;
    // From here the take is final. Set BEFORE the write: a signal landing during it must already be
    // read as "keep the take" (see onInterrupt).
    takeComplete = true;
    await writeSidecar('ok');
    log(`provenance written: ${sidecarPath}`);
    await keepNewTake(); // the new take is in place: the previous one has nothing left to guard

    if (scenarioRequested) await runScenarioPhase();
    if (scenarioSignalExit !== null) process.exit(scenarioSignalExit);
  } catch (err) {
    if (interrupted) return; // the interrupt handler owns salvage, the sidecar and the exit code
    console.error(`[film-ios] unexpected error: ${err?.stack ?? err}`);
    reportAttempts();
    await stopMaestro().catch(() => {});
    const outcome = await runSalvage().catch(() => null);
    // `error` is the camera's own failure and is the status; a flow failure the take already had is kept
    // in the text (see DECIDED FAILURES), as film-android does.
    const already = decidedFlowError !== null ? ` (the flow had already failed: ${decidedFlowError})` : '';
    const errorText = String(err?.message ?? err) + already;
    const ours = !failTakePromise; // a failure exit already under way wrote its own sidecar: leave it be
    if (outcome?.ok && ours) {
      recordFlowDurations();
      tapsExpected = computeTapsExpected();
      await measureFinalized().catch(() => {});
      if (!delivered) delivered = await describeDelivered(null).catch(() => null);
      ringsPending = ringsOwed() && (await fileExists(outPath));
    }
    if (recorder) await failTake('error', errorText).catch(() => {});
    // SALVAGE RINGS, as on a signal: the failed take and its sidecar are already in place.
    if (outcome?.ok && ours && !interrupted) await salvageRings(outcome, () => writeSidecar('error', withSignalNote(errorText))).catch(() => {});
    await restorePrevious(); // a no-op once failTake's restore has run
    if (interrupted) return; // a signal during the salvage or the step-aside owns the exit code
    process.exit(1);
  }
}

await main();
