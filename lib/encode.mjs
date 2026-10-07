// ─────────────────────────────────────────────────────────────────────────────
// lib/encode.mjs — the ONE place filmkit's re-encode quality policy lives (FEEDBACK #25).
//
// THE POLICY: every re-encode filmkit does for a viewer is quality-preserving by default, CRF 18
// with x264's `veryfast` preset, and the CRF is overridable. Not a bitrate, because a bitrate is
// the wrong knob for screen content: a flat UI needs almost nothing and a photograph needs a lot,
// and only a constant-quality mode spends bits where the picture asks for them.
//
// WHY 18 AND NOT x264's DEFAULT 23 (measured on the 2026-09-11 takes of a real filming session): tighten's cut ran at
// libx264 defaults and came out at ~100 kbps from a ~1.7-2.0 Mbps 60 fps source, "fine for flat UI,
// visibly bad on anything photographic". lib/assemble.mjs's ego path already used 18 for the same
// reason, so this makes the rest agree with it. CRF 18 is the conventional "visually lossless for
// practical purposes" point; each -1 is about +12% bitrate, so 18 vs 23 is roughly 1.8x the bits,
// which on flat screen content is still small. Lower is bigger and closer to the source, 0 is
// lossless (and enormous), and anything above ~28 is a visible step down.
//
// WHO USES IT: tighten.mjs (the cut), lib/tap-overlay.mjs (the ring burn's software encoder),
// the camera-side re-encode fallbacks (film-android's finalize / trim / concat, film-ios's
// finalize), and every camera's `--crf` flag through parseCrf. lib/assemble.mjs (the web camera's
// first encode) shares only the CRF: it keeps x264's default `medium` preset, see its header.
// Stream copies are untouched: they do not re-encode.
export const DEFAULT_CRF = 18;
export const DEFAULT_PRESET = 'veryfast';

const CRF_MIN = 0;
const CRF_MAX = 51; // x264's own range

/**
 * Validate a `--crf` value. Throws with a message that names the flag, so a CLI can print it as is.
 * @param {unknown} value a number or numeric string
 * @param {string} [flag]
 * @returns {number}
 */
export function parseCrf(value, flag = '--crf') {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < CRF_MIN || n > CRF_MAX) {
    throw new Error(`${flag} must be a number from ${CRF_MIN} (lossless) to ${CRF_MAX} (worst); ${DEFAULT_CRF} is the default (got ${JSON.stringify(value)})`);
  }
  return n;
}

/** ffmpeg output args for libx264 under the policy: `['-c:v','libx264','-preset',…,'-crf',…]`. */
export function x264Args({ crf = DEFAULT_CRF, preset = DEFAULT_PRESET } = {}) {
  return ['-c:v', 'libx264', '-preset', preset, '-crf', String(parseCrf(crf))];
}
