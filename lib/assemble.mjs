// ─────────────────────────────────────────────────────────────────────────────
// lib/assemble.mjs — turning a finished recording into the .mp4. Runs in the OUTER
// process (film-web.mjs), never inside the ego runtime: that runtime's PATH is only
// /usr/bin:/bin:/usr/sbin:/sbin, so no ffmpeg lives there, and shipping ~600 jpegs out of it
// through a pipe would be worse than just writing them to a work directory and encoding here.
//
// TWO SOURCES, ONE OUTPUT SHAPE:
//
// - `--browser playwright` hands back a .webm that Chromium already encoded; assembly is a
//   straight transcode, byte-for-byte the same ffmpeg invocation as before the backend seam.
//
// - `--browser ego` hands back individual jpegs plus their capture timestamps. Chromium's
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
import { writeFile, rm, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const execFileP = promisify(execFile);

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

/** Transcode Playwright's .webm to .mp4 and delete the webm. Returns the kept path. */
export async function assembleFromWebm(ffmpeg, webmPath, mp4Path) {
  try {
    await execFileP(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', webmPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4Path]);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      // ffmpeg missing — keep the raw recording rather than losing the take.
      const keptPath = mp4Path.replace(/\.mp4$/, '.webm');
      if (webmPath !== keptPath) await rename(webmPath, keptPath);
      return { path: keptPath, transcoded: false };
    }
    throw err;
  }
  await rm(webmPath, { force: true });
  return { path: mp4Path, transcoded: true };
}

/**
 * @param {string} ffmpeg absolute path / bare name resolved by the caller
 * @param {{dir: string, frames: Array<{file: string, t: number}>, tailSec: number}} recording
 *        `t` is seconds from the recording's zero point.
 * @param {string} mp4Path
 * @param {string} workDir where the concat list is written
 */
export async function assembleFromFrames(ffmpeg, { dir, frames, tailSec }, mp4Path, workDir = dirname(dir)) {
  if (!frames.length) throw new Error('assemble: no frames to encode');

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

  await execFileP(
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
      '-crf', '18',
      '-t', planned.toFixed(6),
      '-movflags', '+faststart',
      mp4Path,
    ],
    { maxBuffer: 32 * 1024 * 1024 },
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
