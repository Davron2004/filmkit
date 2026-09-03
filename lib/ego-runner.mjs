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
//                     └─────────────── any throw ──────────> abort ─> error ────────────┘
//                                                                        │
//                     complete task space (keep:false) <─────────────────┴── ALWAYS (finally)
//
// The task space is the resource that outlives a crash — a stranded one leaves a live tab in
// the user's browser — so it is closed in a `finally` on both paths, and again from SIGINT/
// SIGTERM handlers, because a default-handled signal kills the process without running
// finally blocks. There is no state this can end in with the space still open except a hard
// SIGKILL.
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
// because a child exit code cannot be relied on to survive the ego-browser wrapper.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStage } from './stage.mjs';
import { createEgoBackend } from './backends/ego.mjs';

/**
 * @param {object} o
 * @param {object} o.globals {cdp, js, drainEvents, wait, cliLog, useOrCreateTaskSpace, completeTaskSpace, openOrReuseTab, gotoAndWait, pageInfo}
 * @param {string} o.flowPath absolute path to the flow file
 * @param {{width:number,height:number}} o.viewport
 * @param {string} o.workDir absolute; frames/, frames.json and timeline.json are written here
 * @param {string} o.taskSpaceName
 * @param {string} [o.serverOrigin] loopback static-server origin for local-file open()s
 * @param {string} [o.serverRoot] the directory that origin serves
 */
export async function run({ globals, flowPath, viewport, workDir, taskSpaceName, serverOrigin, serverRoot }) {
  const g = globals;
  const emit = (kind, payload) => g.cliLog(`[filmkit] ${kind} ${payload}`);
  const note = (text) => emit('note', text);

  let task = null;
  let stage = null;
  let backend = null;
  let failure = null;
  let cleaned = false;

  async function releaseTaskSpace() {
    if (cleaned || !task) return;
    cleaned = true;
    try {
      await g.completeTaskSpace(task.id, { keep: false });
    } catch (err) {
      note(`could not close task space ${task.id}: ${err?.message || err}`);
    }
  }

  // A default-handled signal would kill this process with the task space still live.
  const onSignal = (sig) => {
    Promise.resolve()
      .then(() => backend?.close())
      .catch(() => {})
      .then(releaseTaskSpace)
      .catch(() => {})
      .then(() => process.exit(sig === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  try {
    task = await g.useOrCreateTaskSpace(taskSpaceName);
    note(`task space ${task.id} (${taskSpaceName})`);

    const mod = await import(pathToFileURL(flowPath).href);
    const flow = mod.default;
    if (typeof flow !== 'function') {
      throw new Error(`Flow file ${flowPath} must have a default export: async ({ stage }) => { ... }`);
    }

    await g.openOrReuseTab('about:blank', { wait: true, timeout: 30 });
    backend = createEgoBackend({ globals: g, viewport, workDir, serverOrigin, serverRoot, log: note });
    await backend.launch();
    note(`tab ready at ${viewport.width}x${viewport.height}`);

    stage = createStage({ backend, viewport });
    await backend.startRecording();
    note('recording');

    await flow({ stage });
    const take = await stage.finish();

    const { frames, t0, stopT, firstFrameLagSec } = take.recording;
    const lastT = frames[frames.length - 1].t;
    // The tail: nothing repaints during the stage's end settle, so no frame arrives during it
    // and the last frame simply has to be held for that long. Measured wall time wins when it
    // is longer (a slow teardown), the authored settle is the floor.
    const tailSec = Math.max(stopT - lastT, take.endSettleSec);
    const plannedDurationSec = lastT - t0 + tailSec;

    await writeFile(join(workDir, 'frames.json'), JSON.stringify(frames.map((f) => ({ file: f.file, t: f.t - t0 }))));
    await writeFile(
      join(workDir, 'timeline.json'),
      JSON.stringify(
        {
          clock: take.clock,
          epochT0: t0,
          firstFrameLagSec,
          tailSec,
          endSettleSec: take.endSettleSec,
          plannedDurationSec,
          timeline: take.timeline,
        },
        null,
        2,
      ),
    );

    note(`captured ${frames.length} frames, ${plannedDurationSec.toFixed(2)}s, first-frame lag ${firstFrameLagSec.toFixed(3)}s`);
    emit('done', JSON.stringify({ frames: frames.length, plannedDurationSec, tailSec }));
  } catch (err) {
    failure = err;
    try {
      await stage?.abort();
    } catch {}
    try {
      await backend?.close();
    } catch {}
    emit('error', JSON.stringify({ message: String(err?.message || err), stack: String(err?.stack || '') }));
  } finally {
    await releaseTaskSpace();
  }

  if (failure) process.exitCode = 1;
}
