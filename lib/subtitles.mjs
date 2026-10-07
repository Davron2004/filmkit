// ─────────────────────────────────────────────────────────────────────────────
// lib/subtitles.mjs — a web take's captions as a SubRip (.srt) file. film-web writes `<name>.srt` beside
// every take that has a video and at least one caption, drawn or not (`--no-captions`, lib/stage.mjs
// NO CAPTIONS), and `<name>-tight.srt` beside a `-tight.mp4`. A standalone `node tighten.mjs <take>` writes
// `<out-stem>.srt` beside its output from the input's sidecar (tighten.mjs, SUBTITLES), with these same
// functions, so the two `-tight.srt` of one take and one plan are the same bytes.
//
// WHERE THE TIMES COME FROM: the take's own timeline, the same caption ranges the sidecar lists and
// tighten protects, already in seconds into the video (both backends record on the frame clock, film-web
// checks the video against it). A cue runs from the caption's fade-in start to its fade-out end: the
// whole span the pill is (or, with no captions, would be) on screen. For the `-tight` file each range goes
// through tighten's own frame numbering (tighten.mjs, THE CUT'S TIME MAP): a caption the cut removed
// entirely is dropped, one it removed in part is clipped to what was kept. (A caption is a protected range,
// so a cut through one only happens when tighten ran without that protection.)
//
// THE FORMAT, as players and editors read it: UTF-8, cues numbered from 1, `HH:MM:SS,mmm --> HH:MM:SS,mmm`,
// the text, a blank line. A blank line inside the text would end the cue early, so runs of blank lines
// in a caption collapse to one line break. Times are whole milliseconds, start rounded to the nearest and
// end too; a cue that rounds to zero length is dropped. Written to a temp name and renamed, like the
// sidecar, so no reader ever sees half a file; a write that fails removes its temp.
import { rename, rm, writeFile } from 'node:fs/promises';
import { mapRangeThroughCut } from '../tighten.mjs';

/** The caption ranges of a take's timeline as cues, in order: [{ start, end, text }]. */
export function captionCues(timeline) {
  return (timeline ?? [])
    .filter((e) => e?.kind === 'caption' && Number.isFinite(e.start) && Number.isFinite(e.end) && e.end > e.start)
    .map((e) => ({ start: e.start, end: e.end, text: String(e.text ?? '').trim() }))
    .filter((c) => c.text !== '')
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/** The cues moved onto a tighten cut's timeline (dropped when fully cut, clipped when partly). */
export function cuesThroughCut(cues, segments) {
  const out = [];
  for (const c of cues) {
    const r = mapRangeThroughCut(segments, c);
    if (r) out.push({ start: r.start, end: r.end, text: c.text, ...(r.clipped ? { clipped: true } : {}) });
  }
  return out;
}

function stamp(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

/** SubRip text for `cues`; '' when none survives rounding. */
export function formatSrt(cues) {
  return srtBlocks(cues).join('\n');
}

function srtBlocks(cues) {
  const blocks = [];
  for (const c of cues) {
    const start = Math.round(c.start * 1000);
    const end = Math.round(c.end * 1000);
    if (end <= start) continue;
    const text = c.text.replace(/\r\n?/g, '\n').replace(/\n\s*\n+/g, '\n').trim();
    blocks.push(`${blocks.length + 1}\n${stamp(start / 1000)} --> ${stamp(end / 1000)}\n${text}\n`);
  }
  return blocks;
}

/** Write `cues` to `path` atomically. Returns the number of cues written (0: nothing written). */
export async function writeSrt(path, cues) {
  const blocks = srtBlocks(cues);
  if (!blocks.length) return 0;
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, blocks.join('\n'));
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return blocks.length;
}
