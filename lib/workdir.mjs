// ─────────────────────────────────────────────────────────────────────────────
// lib/workdir.mjs — the on-disk description of a web take, between "the browser has stopped
// capturing" and "an .mp4 exists". Both backends leave their take in a work directory that
// film-web.mjs creates and owns; this file is the one reader and writer of it, so the ego runtime
// (a separate process, lib/ego-runner.mjs) and film-web (the assembler) cannot disagree.
//
//   <workDir>/frames/NNNNNN_<epoch>.jpg   every captured frame; the name carries its timestamp
//   <workDir>/frames.json                 [{file, t}] with t in seconds from the first frame
//   <workDir>/timeline.json               clock, tailSec, plannedDurationSec, timeline, outcomes, motion, partial ...
//   <workDir>/timeline.partial.json       the timeline, outcomes and motion at the last checkpoint (epoch) + its `at`
//   <workDir>/final-shot*.png             the page as it was when capture stopped, twice (stall check)
//   <workDir>/.alive                      sentinel: the ego runtime stops itself if it disappears
//
// THREE WAYS A TAKE ENDS, and what each leaves:
//   finished   the flow returned: runner/film-web writes frames.json + timeline.json (partial: false).
//   failed     the flow threw and the process is alive: the same two files, partial: true, written
//              after stage.abort() closed the open caption, so the timeline is complete.
//   killed     the process died mid-take (an interrupt: the `ego-browser` wrapper dies without ever
//              running a handler in the runtime, measured). Neither file exists. readTakeFiles()
//              REBUILDS the take from the directory alone: frames from their file names, the
//              timeline from the last checkpoint (at most CHECKPOINT_MS stale; a caption that is
//              still up IS in it, closed at the checkpoint, but a `pause` that has not finished is
//              lost, because a pause is only recorded when it ends), and the tail from the
//              checkpoint's own timestamp: the last moment the runtime was known to be alive.
//
// OUTCOMES (stage.oneOf's log) travel beside the timeline on all three paths, rebased by the same
// rule, and never inside it: `timeline` is the list of authored holds, a oneOf wait is not one.
// A timeline.json without the key (a work directory from before it existed) reads as [].
// MOTION (the stage's cursor-move ranges, film-web's capture-rate yardstick) travels the same way on
// all three paths, so a failed or killed take is judged too: `null` only where it is unknown (a
// checkpoint or timeline.json from before it was recorded), `[]` when no cursor move finished.
//
// A frame file can be half-written when a process is killed under it, so a rebuilt take drops
// trailing frames that lack the JPEG end-of-image marker instead of handing ffmpeg a broken file.
import { readFile, readdir, rename, writeFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFrameFileName } from './frames.mjs';

/** How often the ego runner refreshes timeline.partial.json. Bounds what a killed take can lose. */
export const CHECKPOINT_MS = 250;
/** A held frame needs a positive duration or the concat demuxer's last entry is ignored. */
const MIN_TAIL_SEC = 0.04;

/** Rebase a raw (epoch-seconds) timeline — or outcomes log: anything with start/end — to the
 *  recording's zero and sort it, exactly as stage.finish() does for a take that ended normally. */
export function rebaseTimeline(raw, t0) {
  return raw
    .map((e) => ({ ...e, start: Math.max(0, e.start - t0), end: Math.max(0, e.end - t0) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

async function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

/** Checkpoint the raw timeline and outcomes, stamped with `at` (epoch ms): written every tick even
 *  when neither changed, because the stamp is what tells a rebuilt take when the runtime was
 *  last alive, and so how long the final held frame really lasted. Atomic, so a kill mid-write
 *  cannot leave half a JSON file. */
export async function persistTimeline(workDir, rawTimeline, at = Date.now(), rawOutcomes = [], rawMotion = []) {
  // No mkdir, deliberately: the directory belongs to film-web, which creates it and removes it once
  // the take is assembled. An orphaned ego runtime that outlives film-web must fail to write here,
  // not quietly re-create a work directory in the user's temp dir after it was cleaned up.
  await writeAtomic(join(workDir, 'timeline.partial.json'), JSON.stringify({ at, timeline: rawTimeline, outcomes: rawOutcomes, motion: rawMotion }));
}

/**
 * Write frames.json + timeline.json for a take whose process is still alive.
 * @param {string} workDir
 * @param {object} o
 * @param {{frames: Array<{file:string,t:number}>, t0:number, stopT:number, firstFrameLagSec?:number}} o.recording
 * @param {Array} o.timeline already rebased to t0
 * @param {Array} [o.outcomes] stage.oneOf's log, already rebased to t0
 * @param {Array|null} [o.motion] the stage's cursor-move ranges, already rebased to t0; null when unknown
 * @param {string} o.clock 'frame'
 * @param {number} [o.endSettleSec] the stage's end settle (the tail's floor on a finished take)
 * @param {boolean} o.partial the flow did not run to its end
 * @returns {Promise<{plannedDurationSec: number, tailSec: number}>}
 */
export async function writeTakeFiles(workDir, { recording, timeline, outcomes = [], motion = null, clock, endSettleSec = 0, partial }) {
  const { frames, t0, stopT, firstFrameLagSec = null } = recording;
  // Capture health, for film-web to judge (it is the one place a take is called `failed`): acks
  // that failed while live, and the reference image for the final-frame stall check.
  const capture = {
    ackFailures: recording.ackFailures ?? 0,
    finalShot: recording.finalShot ?? null,
    finalShot2: recording.finalShot2 ?? null,
    finalShotError: recording.finalShotError ?? null,
    liveness: recording.liveness ?? null, // the stall check's probe (lib/frames.mjs); null when it did not run
    opening: recording.opening ?? null, // the opening cut (lib/frames.mjs, THE OPENING FRAME)
    lastFrame: frames[frames.length - 1].file,
  };
  const lastT = frames[frames.length - 1].t;
  // The tail: nothing repaints during the stage's end settle, so no frame arrives during it and
  // the last frame has to be held for that long. Measured wall time wins when it is longer (a slow
  // teardown); the authored settle is the floor.
  const tailSec = Math.max(stopT - lastT, endSettleSec, MIN_TAIL_SEC);
  const plannedDurationSec = lastT - t0 + tailSec;
  await writeFile(join(workDir, 'frames.json'), JSON.stringify(frames.map((f) => ({ file: f.file, t: f.t - t0 }))));
  await writeFile(
    join(workDir, 'timeline.json'),
    JSON.stringify({ clock, epochT0: t0, firstFrameLagSec, tailSec, endSettleSec, plannedDurationSec, partial, capture, timeline, outcomes, motion }, null, 2),
  );
  return { plannedDurationSec, tailSec };
}

/**
 * Turn a take that did not run to its end into frames.json + timeline.json (partial: true), for a
 * process that is still alive: stage.abort() first (it closes an open caption range, so the
 * timeline is complete, and halts capture through the backend so every frame is on disk), then the
 * backend's partial recording. Used by the ego runner and by film-web's playwright path, so the
 * two backends salvage identically. Best effort by design: the caller is already reporting a
 * failure and must not lose it to a salvage error, so problems come back as `warning`.
 * @returns {Promise<{saved: boolean, warning: string|null}>}
 */
export async function salvageTake(workDir, { stage, backend }) {
  try {
    await stage?.abort();
  } catch {
    // abort() is idempotent and swallows its own errors; this is belt and braces
  }
  try {
    await backend?.close();
    const recording = await backend?.partialRecording();
    if (!recording) return { saved: false, warning: null };
    const timeline = rebaseTimeline(stage ? stage.timeline : [], recording.t0);
    const outcomes = rebaseTimeline(stage ? stage.outcomes : [], recording.t0);
    const motion = rebaseTimeline(stage ? stage.snapshotMotion() : [], recording.t0);
    await writeTakeFiles(workDir, { recording, timeline, outcomes, motion, clock: backend.clock, partial: true });
    return { saved: true, warning: null };
  } catch (err) {
    return { saved: false, warning: `could not save the partial take: ${err?.message || err}` };
  }
}

// True when the file ends with the JPEG end-of-image marker.
async function isCompleteJpeg(path) {
  let fh;
  try {
    fh = await open(path, 'r');
    const { size } = await fh.stat();
    if (size < 4) return false;
    const buf = Buffer.alloc(2);
    await fh.read(buf, 0, 2, size - 2);
    return buf[0] === 0xff && buf[1] === 0xd9;
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

/**
 * Wait until the frames directory stops growing. After an ego interruption the runtime can outlive
 * the wrapper that film-web waited for (measured: it kept writing frames, and its own salvage
 * files, for a moment after the wrapper's exit), so reading the directory at once would take a
 * snapshot of a take that is still being written — and removing it afterwards would race the
 * writes. Stable for `quietMs` (or `maxMs` elapsed) is the signal that capture has stopped.
 */
export async function waitForQuietFrames(workDir, { quietMs = 500, maxMs = 6000 } = {}) {
  const framesDir = join(workDir, 'frames');
  const count = async () => (await readdir(framesDir).catch(() => [])).length;
  const deadline = Date.now() + maxMs;
  let last = await count();
  let since = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const now = await count();
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) return;
  }
}

/**
 * Read a work directory back into a take.
 * @param {string} workDir
 * @param {object} [o]
 * @param {number} [o.endedAt] epoch MILLISECONDS fallback for the tail of a rebuilt take, used
 *   only when there is no checkpoint stamp. Without either the tail is the minimum.
 * @returns {Promise<null | {frames: Array<{file:string,t:number}>, framesDir: string, meta: object,
 *   rebuilt: boolean}>} null when there is no frame at all.
 */
export async function readTakeFiles(workDir, { endedAt } = {}) {
  const framesDir = join(workDir, 'frames');
  try {
    const frames = JSON.parse(await readFile(join(workDir, 'frames.json'), 'utf8'));
    const meta = JSON.parse(await readFile(join(workDir, 'timeline.json'), 'utf8'));
    meta.outcomes ??= [];
    return frames.length ? { frames, framesDir, meta, rebuilt: false } : null;
  } catch {
    // no (readable) description: rebuild it from the directory
  }
  let names;
  try {
    names = await readdir(framesDir);
  } catch {
    return null;
  }
  const parsed = names
    .map((name) => ({ name, ...parseFrameFileName(name) }))
    .filter((f) => Number.isFinite(f.seq))
    .sort((a, b) => a.seq - b.seq);
  // A killed process can leave its newest frame half-written; only the tail can be affected.
  while (parsed.length && !(await isCompleteJpeg(join(framesDir, parsed[parsed.length - 1].name)))) parsed.pop();
  if (!parsed.length) return null;
  const t0 = parsed[0].t;
  const lastT = parsed[parsed.length - 1].t;
  let raw = [];
  let rawOutcomes = [];
  let rawMotion = []; // no checkpoint yet: no move can have finished in under CHECKPOINT_MS of filming
  let checkpointAt = null;
  try {
    const cp = JSON.parse(await readFile(join(workDir, 'timeline.partial.json'), 'utf8'));
    raw = cp.timeline ?? [];
    rawOutcomes = cp.outcomes ?? [];
    rawMotion = cp.motion ?? null;
    checkpointAt = Number.isFinite(cp.at) ? cp.at : null;
  } catch {
    // no checkpoint yet: the take is short enough to have none
  }
  // The tail is how long the last frame stayed on screen: until the runtime was last known alive.
  // The checkpoint's own stamp says that; `endedAt` (the interrupt's arrival) is the fallback, and
  // is NOT preferred, because a runtime that died late would give a tail cut short and one that
  // died early (or a `now` taken after the sweep and the quiet wait) a tail inflated by seconds.
  const stoppedAt = checkpointAt ?? endedAt;
  const tailSec = Math.max(stoppedAt ? stoppedAt / 1000 - lastT : 0, MIN_TAIL_SEC);
  return {
    frames: parsed.map((f) => ({ file: f.name, t: f.t - t0 })),
    framesDir,
    meta: {
      clock: 'frame',
      epochT0: t0,
      firstFrameLagSec: null,
      tailSec,
      endSettleSec: 0,
      plannedDurationSec: lastT - t0 + tailSec,
      partial: true,
      timeline: rebaseTimeline(raw, t0),
      outcomes: rebaseTimeline(rawOutcomes, t0),
      motion: rawMotion && rebaseTimeline(rawMotion, t0),
    },
    rebuilt: true,
  };
}
