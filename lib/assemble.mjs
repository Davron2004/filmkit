// ─────────────────────────────────────────────────────────────────────────────
// lib/assemble.mjs — turning a finished recording into the .mp4. Runs in the OUTER
// process (film-web.mjs), never inside the ego runtime: that runtime's PATH is only
// /usr/bin:/bin:/usr/sbin:/sbin, so no ffmpeg lives there, and shipping ~600 jpegs out of it
// through a pipe would be worse than just writing them to a work directory and encoding here.
//
// ONE SOURCE, BOTH BACKENDS: both web backends (ego AND playwright) hand back individual jpegs
// plus their capture timestamps (lib/frames.mjs says why Playwright no longer hands back a
// .webm). Chromium's
//   screencast only emits a frame when pixels CHANGE, so the stream is genuinely
//   variable-frame-rate with multi-second gaps wherever the flow holds a beat — exactly the
//   shape the concat demuxer's explicit `duration` directives exist for. Each frame is held
//   for the delta to the next one; the last frame is held for the tail the caller measured
//   (the stage's end settle, during which nothing repaints so nothing is captured) and is then
//   REPEATED with no duration, which is the demuxer's own idiom for "the final entry is a real
//   frame, not a terminator" — without the repeat, ffmpeg drops it to one frame.
//   `-vf fps=30` resamples that VFR timeline to CFR on the way into x264.
//
//   THE ENCODED TOTAL IS RETURNED, not assumed. The timeline sidecar's seconds and the video's
//   seconds have to be the same seconds or tighten protects the wrong part of the clip — and with
//   `clock: 'frame'` it protects with ZERO margin, so a drift of a few tenths clips a caption.
//   assembleFromFrames therefore reports the total it actually laid down, and the caller compares
//   it against the duration the recording clock predicted and fails the take on a mismatch. It is
//   a cheap assertion on the one number that ties the two artifacts together.
//
//   AND THE LENGTH IS PINNED WITH `-t`, because the demuxer's handling of the last entry is not
//   something to trust. Measured on 10 frames with 9 x 2.0s gaps and a 1.8s tail (planned 19.8s):
//   no repeat -> 20.0s (the final `duration` is ignored, the previous one is reused); with the
//   repeat -> 21.6s (the tail is counted twice, once declared and once for the repeat); with the
//   repeat plus a `duration` on it -> 21.6s again, the trailing directive ignored. Only `-t
//   <planned>` produces 19.8s, and it produces it exactly (594 frames at 30fps). So the output
//   length is a function of the captured timestamps, which is the thing we actually know.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { DEFAULT_CRF, parseCrf } from './encode.mjs';
import { runAbortable } from './run.mjs';

const execFileP = promisify(execFile);

const KILL_GRACE_MS = 3000;
const STDERR_TAIL_CHARS = 8192;

/**
 * Run ffmpeg to completion. Unlike execFile's own `signal` option this WAITS for the process to be
 * gone before it rejects: a caller that deletes the half-written output on abort must not do it
 * while ffmpeg still has the file open. SIGTERM first (ffmpeg finalizes and exits), SIGKILL after
 * KILL_GRACE_MS.
 *
 * The runner is lib/run.mjs's, shared with tighten and the tap burn. This wrapper keeps the contract
 * film-web has always seen from this file, which differs from the shared one on purpose: an abort
 * rejects with `{ aborted: true }` ("ffmpeg was stopped"), not an AbortError; a failed spawn rejects
 * with the spawn error itself; a non-zero exit quotes the last 3 lines of the last 8 KB of stderr; the
 * grace is 3s, not 2s.
 */
async function runFfmpeg(ffmpeg, args, { signal } = {}) {
  let result;
  try {
    result = await runAbortable(ffmpeg, args, { signal, stdout: 'ignore', stderrTailChars: STDERR_TAIL_CHARS, graceMs: KILL_GRACE_MS });
  } catch (err) {
    if (err.name === 'AbortError') throw Object.assign(new Error('ffmpeg was stopped'), { aborted: true });
    throw err.cause ?? err; // a failed spawn: the spawn error, as it always was
  }
  const { code, signal: sig, stderr } = result;
  if (code === 0) return;
  const tail = stderr.slice(-STDERR_TAIL_CHARS).trim().split('\n').slice(-3).join(' / ');
  throw new Error(`ffmpeg ${sig ? `was killed by ${sig}` : `exited with code ${code}`}: ${tail}`);
}

// A frame's duration is the gap to the next one, and the recording clock is the only thing that
// knows how long a hold really was. There is deliberately NO UPPER CLAMP: a flow is entitled to
// `stage.pause(90000)`, and a clamp that silently shortened it would slide every later frame
// against the timeline that tighten protects — which, at margin 0, means protecting the wrong
// seconds. There is likewise NO LOWER FLOOR: Chromium's screencast frames can legitimately land a
// millisecond or two apart, and flooring those close-together gaps up to some minimum inflates the
// encoded total past what the recording clock actually measured. `-vf fps=30` resamples the VFR
// timeline on the way into x264 and is perfectly happy folding a sub-frame duration into the next
// output frame, so the raw gap is kept exactly as captured. The only thing that still can't stand
// is a NON-MONOTONIC delta — a frame whose timestamp didn't move forward, which is not a fast hold
// but a broken clock. That frame is dropped from the concat list (its time folds into the frame
// before it) and counted in `nonMonotonic`, which the caller's plan check turns into a failed take
// rather than a quiet nudge. Durations are then recomputed as the gap between EMITTED frames, so
// the sum still lands on exactly `last.t - first.t + tailSec` — the total is pinned to the clock,
// not to however many frames happened to survive.
//
// ENCODE QUALITY (FEEDBACK #25): the encode runs libx264 at CRF `DEFAULT_CRF` (18, from
// lib/encode.mjs — the one place that number lives), overridable per call with `{ crf }`. The ego
// path already did; the webm path this file used to have ran at x264's own default (CRF 23), the
// same too-soft-for-photographs default tighten had. Only the CRF is shared: the preset is left at
// x264's default (`medium`) here rather than lib/encode.mjs's `veryfast`, because this is the
// once-per-take first encode from raw frames, and changing it would change bytes nobody asked to.
// Every ffmpeg call in this file carries `-hide_banner -loglevel error`.

/**
 * @param {string} ffmpeg absolute path / bare name resolved by the caller
 * @param {{dir: string, frames: Array<{file: string, t: number}>, tailSec: number}} recording
 *        `t` is seconds from the recording's zero point.
 * @param {string} mp4Path
 * @param {string} workDir where the concat list is written
 * @param {{crf?: number, signal?: AbortSignal}} [opts] x264 CRF, default DEFAULT_CRF; `signal` stops
 *        ffmpeg (SIGTERM, then SIGKILL) and rejects with `err.aborted === true`. The caller owns
 *        removing the half-written output: this function does not know which file it may delete.
 */
export async function assembleFromFrames(ffmpeg, { dir, frames, tailSec }, mp4Path, workDir = dirname(dir), { crf = DEFAULT_CRF, signal } = {}) {
  if (!frames.length) throw new Error('assemble: no frames to encode');
  const crfArg = String(parseCrf(crf));

  // Fold out-of-order frames into their predecessor: keep a frame only if its timestamp is
  // strictly after the last kept one. The final captured frame is never dropped by this pass —
  // it has to be the thing the tail attaches to — so if it would itself be out of order, the
  // frame before it is dropped instead, moving the tail attachment back one frame rather than
  // losing it.
  const kept = [frames[0]];
  let nonMonotonic = 0;
  for (let i = 1; i < frames.length; i++) {
    const isLast = i === frames.length - 1;
    if (frames[i].t > kept[kept.length - 1].t) {
      kept.push(frames[i]);
    } else if (isLast) {
      nonMonotonic++;
      kept.pop();
      kept.push(frames[i]);
    } else {
      nonMonotonic++;
    }
  }

  const lines = [];
  let planned = 0;
  for (let i = 0; i < kept.length; i++) {
    const d = i < kept.length - 1 ? kept[i + 1].t - kept[i].t : tailSec;
    planned += d;
    lines.push(`file ${quote(join(dir, kept[i].file))}`);
    lines.push(`duration ${d.toFixed(6)}`);
  }
  // The demuxer ignores the final `duration` unless the file is named once more.
  lines.push(`file ${quote(join(dir, kept[kept.length - 1].file))}`);

  const listPath = join(workDir, 'concat.txt');
  await writeFile(listPath, lines.join('\n') + '\n');

  await runFfmpeg(
    ffmpeg,
    [
      '-y',
      '-hide_banner', '-loglevel', 'error',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-vf', 'fps=30',
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264',
      '-crf', crfArg,
      '-t', planned.toFixed(6),
      '-movflags', '+faststart',
      mp4Path,
    ],
    { signal },
  );
  return { path: mp4Path, plannedDurationSec: planned, frames: kept.length, nonMonotonic };
}

/** ffconcat's own quoting: single-quoted, with embedded quotes broken out. */
function quote(path) {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/** Container duration in seconds, or null when ffprobe can't read one. */
export async function probeDuration(ffprobe, path) {
  try {
    const { stdout } = await execFileP(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      path,
    ]);
    const n = Number(String(stdout).trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * SSIM ("All" plane average, 1 = identical) between two images of the same size, by ffmpeg's ssim
 * filter — no dependency. The stall check compares the last screencast frame with a screenshot
 * taken as capture stopped. Resolves to a number, or rejects (size mismatch, unreadable file).
 */
export async function imageSimilarity(ffmpeg, pathA, pathB) {
  const { stderr } = await execFileP(ffmpeg, ['-hide_banner', '-loglevel', 'info', '-i', pathA, '-i', pathB, '-lavfi', 'ssim', '-f', 'null', '-'], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const m = /SSIM[^\n]*All:([0-9.]+)/.exec(String(stderr));
  if (!m) throw new Error(`ffmpeg ssim printed no score: ${String(stderr).trim().split('\n').slice(-2).join(' / ')}`);
  return Number(m[1]);
}
