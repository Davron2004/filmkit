// ─────────────────────────────────────────────────────────────────────────────
// lib/ego-runner.mjs — the half of a `--browser ego` run that lives INSIDE the
// `ego-browser nodejs` runtime.
//
// film-web.mjs cannot talk to ego-browser: there is no external CDP endpoint, and the only
// way in is a script on `ego-browser nodejs`'s stdin. That script is kept to three lines —
// import this file, call run() — so that everything real is ordinary reviewable source in the
// repo rather than a string built by a template. The ego runtime's helpers are handed in as
// `globals`; nothing under lib/backends/ego.mjs ever reads a bare global.
//
// PROCESS STATE MACHINE, and why the shape matters:
//
//   claim task space ─┬─> launch ─> record ─> flow ─> finish ─> write frames/timeline ─> done
//                     └─────────────── any throw ──> SALVAGE ─> error ────────────────────┘
//                                                       │
//                     complete task space (keep:false) <┴── ALWAYS (finally)
//
// SALVAGE (a flow that threw, or a signal that reached this process): stage.abort() closes an open
// caption range and halts capture, then frames.json + timeline.json are written with `partial:
// true` (lib/workdir.mjs), so film-web can assemble what was filmed. timeline.json carries the
// stage's `outcomes` (oneOf's log) and `motion` (the cursor's move ranges, the capture-rate check's
// yardstick) beside the timeline on every path, the checkpoint included, so
// a take that a refused oneOf outcome failed still says which outcome it was. While recording, a timer
// also keeps timeline.partial.json current (every CHECKPOINT_MS) because the wrapper can kill this
// process without running any handler: film-web then rebuilds the take from the frame files (their
// names carry their timestamps, lib/frames.mjs) and that checkpoint. MEASURED, and why film-web
// waits for the frames directory to go quiet before reading it: this runtime can outlive the
// `ego-browser` wrapper film-web waited for, and keeps writing for a moment.
//
// WHAT "THIS PROCESS" IS. MEASURED (ego-browser 0.5.1.13, node v24.18.1): every `ego-browser
// nodejs` invocation of every agent runs in ONE long-lived process, a Chromium utility process
// ("ego Helper (Node)") that is a child of the browser and in the BROWSER's process group, not the
// caller's. The browser starts it on demand and reaps it after a few minutes with no invocation
// (gone after ~7 idle minutes, a fresh pid on the next call; that, not a filmkit run, is why its
// pid changes during a session). Each invocation is its own Node environment inside it: its own
// threadId, globalThis, ESM module map (a lib/ edit takes effect on the next run, no restart and
// no cache-busting needed) and `process` object, so `process.on` listeners belong to this run and
// vanish with it (a concurrent run sees none of ours). `process.exit(n)` ends THIS run only: the
// wrapper prints "ego's nodejs process exited with code n" and exits 1, and concurrent runs and
// the runtime carry on (measured, with one mid-screencast); an uncaught exception or unhandled
// rejection does the same. Shared by all runs: the pid, `process.env` (the browser's environment,
// not film-web's, and a value one run sets is visible to later runs) and the cwd, which is `/`.
// A run lasts until its event loop drains, and the wrapper holds ALL of its output until then.
//
// The task space is the resource that outlives a crash — a stranded one leaves a live tab in
// the user's browser — so it is closed in a `finally` on both paths, and before any `process.exit`
// below (which ends the run without running finally blocks). There is no state this can end in
// with the space still open except the runtime itself dying. A SIGINT/SIGTERM/SIGHUP handler is
// installed too, but MEASURED, no signal film-web can send ever reaches it: a signal to the
// `ego-browser` wrapper kills the wrapper alone (exit 8 within ~30ms) and the run carries on to
// its end without the handler firing, and a process-group signal cannot reach a process in the
// browser's group. It stays as the correct reaction should one arrive, and costs nothing: it is
// per run. So what actually ends an interrupted run is film-web's sweep (it closes the task space,
// the flow throws, the run salvages and ends) or, if film-web itself was killed, the `.alive`
// sentinel below. SIGHUP (what an agent's shell sends when its turn ends, FEEDBACK #29) is handled
// exactly like SIGINT, exit status included.
//
// STDOUT CONTRACT: `cliLog` is the only output channel, and it is shared with whatever
// ego-browser itself prints, so every line this file emits is prefixed `[filmkit] ` and the
// terminal ones carry a JSON payload:
//
//   [filmkit] note <human text>          progress
//   [filmkit] done <json>                success; the ONLY success sentinel
//   [filmkit] error <json>               failure, with the flow's own message and stack
//
// film-web.mjs treats the ABSENCE of a `done` line as failure regardless of exit status,
// because a child exit code cannot be relied on to survive the ego-browser wrapper. MEASURED:
// nothing is streamed. cliLog, console.log/error and process.stderr all reach film-web only when
// the run ends (a line logged 3s before the end arrived with the last one), so `note` lines are
// not live progress, and a run whose wrapper was killed delivers none of its lines at all.

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStage } from './stage.mjs';
import { createEgoBackend } from './backends/ego.mjs';
import { CHECKPOINT_MS, persistTimeline, salvageTake, writeTakeFiles } from './workdir.mjs';

// Exit status by signal, the same table the device cameras use. Nothing reads it in practice (the
// `ego-browser` wrapper does not pass its own child's status through), but it is what a handler
// that DOES get to run should say.
const SIGNAL_EXIT = { SIGINT: 130, SIGHUP: 129, SIGTERM: 143 };
// How stale the owner's heartbeat (the sentinel's mtime) may get before this runtime calls itself
// an orphan. film-web touches it every second; 20s is far past any scheduling hiccup under load.
const ORPHAN_STALE_MS = 20000;
const ORPHAN_RECHECK_MS = 2000;

/**
 * @param {object} o
 * @param {object} o.globals {cdp, js, drainEvents, wait, cliLog, useOrCreateTaskSpace, completeTaskSpace, openOrReuseTab, gotoAndWait, pageInfo}
 * @param {string} o.flowPath absolute path to the flow file
 * @param {{width:number,height:number}} o.viewport
 * @param {string} o.workDir absolute; frames/, frames.json and timeline.json are written here
 * @param {string} o.taskSpaceName
 * @param {string} [o.serverOrigin] loopback static-server origin for local-file open()s
 * @param {string} [o.serverRoot] the directory that origin serves
 * @param {boolean} [o.captions] draw captions (default true; film-web's --no-captions passes false)
 */
export async function run({ globals, flowPath, viewport, workDir, taskSpaceName, serverOrigin, serverRoot, captions = true }) {
  const g = globals;
  const emit = (kind, payload) => g.cliLog(`[filmkit] ${kind} ${payload}`);
  const note = (text) => emit('note', text);

  let task = null;
  let stage = null;
  let backend = null;
  let failure = null;
  let cleaned = false;
  let checkpointTimer = null;
  let orphanTimer = null;

  async function releaseTaskSpace() {
    if (cleaned || !task) return;
    cleaned = true;
    try {
      await g.completeTaskSpace(task.id, { keep: false });
    } catch (err) {
      note(`could not close task space ${task.id}: ${err?.message || err}`);
    }
  }

  // Keep timeline.partial.json current while filming, so that a take whose process is killed under
  // it (the wrapper dies without running any handler here) can still be rebuilt with its captions.
  // The file is rewritten EVERY tick, changed or not: its `at` stamp is how a rebuilt take knows
  // when this runtime was last alive. Atomic.
  async function checkpoint() {
    if (!stage) return;
    const raw = stage.snapshotTimeline();
    await persistTimeline(workDir, raw, Date.now(), [...stage.outcomes], stage.snapshotMotion()).catch(() => {});
  }

  // Everything filmed so far -> frames.json + timeline.json (partial: true), for a take that did
  // not run to its end. The checkpoint timer stops first so it cannot race the final write.
  // MEMOIZED: the signal handler and the catch below both salvage, and must not run it twice
  // concurrently (two writers of the same files, two aborts of the same stage).
  let salvaging = null;
  function salvage() {
    salvaging ??= (async () => {
      clearInterval(checkpointTimer);
      const { warning } = await salvageTake(workDir, { stage, backend });
      if (warning) note(warning);
    })();
    return salvaging;
  }

  // A default-handled signal would kill this process with the task space live and the frames
  // undescribed. (None has been seen to arrive at all, see the header.) SIGHUP is SIGINT
  // (film-web.mjs INTERRUPTION); the status follows the FIRST signal.
  // `on`, not `once`: a repeated signal while the salvage is running is absorbed (the salvage is
  // memoized) instead of falling through to the default disposition, which would kill the process
  // half-way through closing the browser session and the task space.
  let exitCode = null;
  const onSignal = (sig) => {
    if (exitCode !== null) return;
    exitCode = SIGNAL_EXIT[sig];
    salvage()
      .catch(() => {})
      .then(releaseTaskSpace)
      .catch(() => {})
      .then(() => process.exit(exitCode));
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => onSignal(sig));

  // THE RUNTIME CAN OUTLIVE ITS OWNER. `ego-browser nodejs` is a wrapper, and killing it (or
  // film-web) does not necessarily stop this script: MEASURED, with both SIGKILLed the runtime kept
  // checkpointing and driving the user's real browser 4s later, with nobody left to salvage or
  // sweep it. film-web creates `<workDir>/.alive` before spawning us, touches it every second, and
  // removes the whole work directory when it is done with the take. This run has no owner when
  //   - the sentinel is gone (film-web finished with the take, or someone removed the directory), or
  //   - the sentinel has not been touched for ORPHAN_STALE_MS, twice, ORPHAN_RECHECK_MS apart
  //     (film-web was killed outright; the recheck is so that a laptop waking from sleep, where this
  //     timer can fire before film-web's, does not abort a healthy take).
  // Then it stops itself: abort the flow, halt capture, close the task space, exit (this run only,
  // see the header). Polled with the checkpoint's period, so a runtime whose sentinel vanished
  // stops within about a second (measured: 0.8s from removing it to the last checkpoint, task
  // space closed by 1.5s); a SIGKILLed film-web's run, by the stale rule, closed its space 20-22s
  // after the kill. The space it closes is its own: its name is unique to this run's work
  // directory (film-web.mjs, filmWithEgo), so a retake started inside that window is untouched.
  const sentinel = join(workDir, '.alive');
  const ownerGone = () => {
    try {
      return Date.now() - statSync(sentinel).mtimeMs > ORPHAN_STALE_MS;
    } catch {
      return true; // no sentinel, no work directory
    }
  };
  let orphanChecking = false;
  orphanTimer = setInterval(async () => {
    if (orphanChecking || !ownerGone()) return;
    orphanChecking = true;
    // A missing sentinel is final; a merely stale one is confirmed after a pause.
    if (existsSync(sentinel)) {
      await new Promise((r) => setTimeout(r, ORPHAN_RECHECK_MS));
      if (!ownerGone()) {
        orphanChecking = false;
        return;
      }
    }
    clearInterval(orphanTimer);
    clearInterval(checkpointTimer);
    exitCode = exitCode ?? 1;
    Promise.resolve()
      .then(() => stage?.abort())
      .catch(() => {})
      .then(() => backend?.close())
      .catch(() => {})
      .then(releaseTaskSpace)
      .catch(() => {})
      .then(() => process.exit(exitCode));
  }, CHECKPOINT_MS);

  try {
    task = await g.useOrCreateTaskSpace(taskSpaceName);
    note(`task space ${task.id} (${taskSpaceName})`);

    const mod = await import(pathToFileURL(flowPath).href);
    const flow = mod.default;
    if (typeof flow !== 'function') {
      throw new Error(`Flow file ${flowPath} must have a default export: async ({ stage }) => { ... }`);
    }

    // wait:false, on purpose. MEASURED: `openOrReuseTab('about:blank', { wait: true })` never sees
    // its load signal for about:blank and sits out its whole `timeout` (30s) on EVERY run, success
    // or failure — a 14s take cost 45s wall. Nothing here needs the wait: backend.launch() below
    // navigates the tab itself and polls until the document is there.
    await g.openOrReuseTab('about:blank', { wait: false });
    backend = createEgoBackend({ globals: g, viewport, workDir, serverOrigin, serverRoot, log: note });
    await backend.launch();
    note(`tab ready at ${viewport.width}x${viewport.height}`);

    stage = createStage({ backend, viewport, captions });
    await backend.startRecording();
    note('recording');
    checkpointTimer = setInterval(() => checkpoint(), CHECKPOINT_MS);

    await flow({ stage });
    clearInterval(checkpointTimer);
    const take = await stage.finish();

    const { plannedDurationSec, tailSec } = await writeTakeFiles(workDir, {
      recording: take.recording,
      timeline: take.timeline,
      outcomes: take.outcomes,
      motion: take.motion,
      clock: take.clock,
      endSettleSec: take.endSettleSec,
      partial: false,
    });

    const { frames, firstFrameLagSec } = take.recording;
    note(`captured ${frames.length} frames, ${plannedDurationSec.toFixed(2)}s, first-frame lag ${firstFrameLagSec.toFixed(3)}s`);
    emit('done', JSON.stringify({ frames: frames.length, plannedDurationSec, tailSec }));
  } catch (err) {
    failure = err;
    const failedAt = Date.now(); // stamped BEFORE the salvage: the salvage takes long enough to matter
    await salvage();
    // `at` lets film-web tell a flow error that PREDATES an interrupt from one the interrupt
    // caused (closing the task space under a running flow makes it throw).
    emit('error', JSON.stringify({ message: String(err?.message || err), stack: String(err?.stack || ''), at: failedAt }));
  } finally {
    clearInterval(checkpointTimer);
    clearInterval(orphanTimer);
    await releaseTaskSpace();
  }

  if (failure) process.exitCode = 1;
}
