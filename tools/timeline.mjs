#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// tools/timeline.mjs — verify a take without watching all of it (FEEDBACK #11, MVP).
//
// The list of moments the picture CHANGED is the take's edit list: "the screen changed at 11, 31,
// 60…". One ffmpeg pass at 1fps, no PNGs, no contact sheet (deliberately deferred):
//
//   node tools/timeline.mjs <take.mp4> [--sidecar <take.json>] [--fps <n>]
//
// Prints one line per change with a timestamp, marks segment seams from the sidecar's
// `recording.seamOffsetsSec`, and warns when a seam lands inside motion (a change within
// ±2s on both sides) — the shot-that-must-not-be-cut failure mode the README warns about.
//
// HOW A CHANGE IS DECIDED. Each sampled frame is compared with the previous SAMPLED frame: the
// per-pixel luma difference is thresholded at PIXEL_LEVEL (a pixel counts as changed only if it
// moved by more than that many of 255 levels) and the change is real when the mean of that mask
// is at least CHANGE_YAVG (mask value 255, so YAVG 0.01 is 0.004% of the pixels: 36 pixels of a
// 1280x720 frame). It used to compare exact frame md5s, which is right for a frame-exact device
// recorder and wrong for everything else: a lossy x264 encode of a static hold differs a little
// from second to second, so every sample of a web take came out as a change. The mask removes
// that noise (compression error is a few levels, never above PIXEL_LEVEL) and keeps what a person
// would call a change: a caption, a cursor, a ripple, a typed digit, a navigation.
//
// MEASURED, 1fps, YAVG of the mask per sample:
//   ego web take, static holds   0, 0, 0, 0, 0, 5.5e-4                 (largest 5.5e-4)
//   ego web take, real changes   0.13 ... 7.9                          (smallest 0.13)
//   playwright web take, holds   0 ... 0                               real: 0.0185 ... 7.7
//   android takes, holds         0 (x40), 1.2e-4                       real: 0.0152 ... 196
//   ios take, static holds       0, 0, 8e-5                            real: 0.52 ... 238
//   (a few samples on the device takes sit between 0.009 and 0.02: a clock tick or a caret; the
//   line is drawn at 0.01 so those count as the tiny changes they are and 1e-3 of noise does not)
// Both a frame-exact device recording (a hold is exactly 0) and a re-encoded web take (a hold is
// at most ~1e-3) land far below CHANGE_YAVG, and every visible change lands above it.
// THE COST, measured on 10-fork-divergence-android.mp4: 1 of its 27 exact-md5 changes (a
// low-contrast fade whose pixels moved by 8-23 levels) is below PIXEL_LEVEL and no longer reported,
// and 4 more differ only by encoder noise under 8 levels (correctly no longer reported). A level
// of 8 would catch the fade, but sits within 3x of the largest web noise; 24 keeps a 20x margin
// on both sides, which is what a tool that must not cry wolf on a web take needs.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, basename, extname, join, resolve } from 'node:path';

const USAGE = 'usage: node tools/timeline.mjs <take.mp4> [--sidecar <take.json>] [--fps <n, default 1>]';

function parseArgs(argv) {
  const rest = [];
  let sidecar = null;
  let fps = 1;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sidecar') {
      sidecar = argv[++i];
      if (!sidecar) { console.error(USAGE); process.exit(1); }
    } else if (argv[i] === '--fps') {
      fps = Number(argv[++i]);
      if (!Number.isFinite(fps) || fps <= 0 || fps > 30) { console.error(`--fps must be 1..30 (got "${argv[i]}")`); process.exit(1); }
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      rest.push(argv[i]);
    }
  }
  if (rest.length !== 1) { console.error(USAGE); process.exit(1); }
  return { inPath: resolve(rest[0]), sidecar: sidecar ? resolve(sidecar) : null, fps };
}

// A pixel changed if its luma moved by more than this many levels (of 255) between samples.
const PIXEL_LEVEL = 24;
// A sample is a change if the mean of the changed-pixel mask reaches this (mask value 255).
const CHANGE_YAVG = 0.01;

// Per sampled frame after the first: the mean of the changed-pixel mask against the previous
// sample. `tblend=difference` is |this - previous|, the lut thresholds it to 0/255, and
// signalstats' YAVG over that mask is the fraction of changed pixels times 255. Returns
// [{ t, yavg }] (t in seconds; the first sample, t=0, has nothing to compare with and is absent).
function sampleDiffs(ffmpeg, inPath, fps) {
  const vf =
    `fps=${fps},tblend=all_mode=difference,lutyuv=y='if(gt(val,${PIXEL_LEVEL}),255,0)',` +
    'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-';
  return new Promise((res, rej) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', inPath, '-vf', vf, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => rej(new Error(`failed to run ffmpeg: ${e.message}`)));
    child.on('exit', (code) => {
      if (code !== 0) return rej(new Error(`ffmpeg exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' / ')}`));
      // metadata=print lines: `frame:N pts:P pts_time:T` then `lavfi.signalstats.YAVG=V`
      const diffs = [];
      let t = null;
      for (const line of stdout.split('\n')) {
        const ts = line.match(/pts_time:([0-9.]+)/);
        if (ts) t = Number(ts[1]);
        const y = line.match(/lavfi\.signalstats\.YAVG=([0-9.eE+-]+)/);
        if (y && t !== null) diffs.push({ t, yavg: Number(y[1]) });
      }
      res(diffs);
    });
  });
}

async function loadSeams(inPath, sidecarOpt) {
  const ext = extname(inPath);
  const guess = join(dirname(inPath), `${basename(inPath, ext)}.json`);
  const path = sidecarOpt ?? guess;
  try {
    const doc = JSON.parse(await readFile(path, 'utf8'));
    const seams = doc?.recording?.seamOffsetsSec;
    if (Array.isArray(seams)) return { seams: seams.filter((n) => Number.isFinite(n)), path };
    return { seams: [], path };
  } catch {
    return { seams: [], path: null };
  }
}

async function main() {
  const { inPath, sidecar, fps } = parseArgs(process.argv.slice(2));
  const ffmpeg = process.env.FILMKIT_FFMPEG ?? 'ffmpeg';
  let diffs;
  try {
    diffs = await sampleDiffs(ffmpeg, inPath, fps);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  // N samples give N-1 comparisons; a video with one sample has none, and is still a video.
  const sampleCount = diffs.length + 1;
  const changes = [0];
  for (const d of diffs) if (d.yavg >= CHANGE_YAVG) changes.push(d.t);
  const { seams, path } = await loadSeams(inPath, sidecar);
  const seamSet = new Set(seams.map((s) => Math.round(s * fps)));
  console.log(`# ${basename(inPath)}: ${sampleCount} sample(s) at ${fps}fps, ${changes.length - 1} change(s)`);
  console.log(`# screen changed at (s): ${changes.map((t) => t.toFixed(0)).join(', ')}`);
  for (const t of changes) {
    const near = seams.filter((s) => Math.abs(s - t) < 0.6);
    console.log(`${t.toFixed(2)}\tchange${near.length ? `\tSEAM @ ${near.map((s) => s.toFixed(1)).join(',')}` : ''}`);
  }
  if (seams.length > 0) {
    console.log(`# seams at (s): ${seams.map((s) => s.toFixed(1)).join(', ')}${path ? ` (from ${path})` : ''}`);
    // A seam inside motion: changes on BOTH sides within 2s — the take's key moment may be cut.
    for (const s of seams) {
      const before = changes.some((t) => t < s && s - t <= 2);
      const after = changes.some((t) => t > s && t - s <= 2);
      const onSeam = seamSet.has(Math.round(s * fps));
      if (before && after) {
        console.log(`⚠️  seam @ ${s.toFixed(1)}s sits inside motion (changes within ±2s on both sides) — check the moment`);
      } else if (!onSeam) {
        // Seam second with no sampled change on it: quiet, no line — motion check above covers it.
      }
    }
  } else {
    console.log('# no seams in sidecar (single-segment take, or no sidecar found)');
  }
}

await main();
