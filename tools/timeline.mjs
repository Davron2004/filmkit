#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// tools/timeline.mjs — verify a take without watching all of it (FEEDBACK #11, MVP).
//
// On a frame-exact device recorder, consecutive identical frames hash identically, so the
// list of hash changes IS the take's edit list: "the screen changed at 11, 31, 60…". One
// ffmpeg pass at 1fps, no PNGs, no contact sheet (deliberately deferred):
//
//   node tools/timeline.mjs <take.mp4> [--sidecar <take.json>] [--fps <n>]
//
// Prints one line per change with a timestamp, marks segment seams from the sidecar's
// `recording.seamOffsetsSec`, and warns when a seam lands inside motion (a change within
// ±2s on both sides) — the shot-that-must-not-be-cut failure mode the README warns about.
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

function framemd5(ffmpeg, inPath, fps) {
  return new Promise((res, rej) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', inPath, '-vf', `fps=${fps}`, '-f', 'framemd5', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; if (stdout.length > 64 * 1024 * 1024) stdout = stdout.slice(-32 * 1024 * 1024); });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => rej(new Error(`failed to run ffmpeg: ${e.message}`)));
    child.on('exit', (code) => {
      if (code !== 0) return rej(new Error(`ffmpeg framemd5 exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' / ')}`));
      res(stdout);
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
  let out;
  try {
    out = await framemd5(ffmpeg, inPath, fps);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  // framemd5 body lines: `stream, frame, …, <32-hex md5>` — hash is always the last field.
  const hashes = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(\d+),\s*(\d+),.*([0-9a-f]{32})\s*$/);
    if (m) hashes.push(m[3]);
  }
  if (hashes.length === 0) {
    console.error('no frames hashed — is this a valid video file?');
    process.exit(1);
  }
  const changes = [0];
  for (let i = 1; i < hashes.length; i++) if (hashes[i] !== hashes[i - 1]) changes.push(i / fps);
  const { seams, path } = await loadSeams(inPath, sidecar);
  const seamSet = new Set(seams.map((s) => Math.round(s * fps)));
  console.log(`# ${basename(inPath)}: ${hashes.length} sample(s) at ${fps}fps, ${changes.length - 1} change(s)`);
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
