// ─────────────────────────────────────────────────────────────────────────────
// lib/frames.mjs — the ONE frame sink both web backends record into. A `Page.screencastFrame`
// event goes in; a numbered JPEG on disk, a timestamp, and the bookkeeping that decides whether
// the take can be trusted come out. lib/backends/ego.mjs and lib/backends/playwright.mjs each own
// how frames REACH them (ego drains a shared event queue, Playwright subscribes to a CDP session);
// what happens to a frame once it has arrived is identical, so it lives here.
//
// WHY BOTH BACKENDS RECORD LIKE THIS. Playwright's own `recordVideo` was the original camera and
// it silently produced wrong-length videos: about one static-page take in three came out as a
// 0.96s WEBM of a blank page (24 packets, the first a 1.5 KB keyframe) instead of the 6-14s that
// was filmed. The recorder there ends where its frames end, and a frame it never received is a
// missing recording with no error. Measured with bare Playwright and no filmkit code, load-
// dependent. `Page.startScreencast` over CDP on the same headless Chromium delivered the content
// frame 12 of 12 times and stamps every frame with the compositor's own time, so both backends
// now capture that way and share lib/assemble.mjs's assembleFromFrames. A screencast only sends a
// frame when the picture CHANGES: a static page is one frame plus a held tail, which is correct.
//
// THE OPENING FRAME is the DRESSED OPENING SHOT: the opened page loaded (the load state open() waits
// for, and its readySelector), with the overlay built and the cursor at its starting place. Everything
// captured before that is setup, not footage: the parked blank tab (both backends park on one, and
// startRecording() waits for the screencast's first frame, which shows it), and the FIRST page's
// progressive render. MEASURED before this rule (the cut was made when open() started navigating, so a
// take opened on the page's first paint): tip-demo and generate opened on 1-4 frames with no cursor
// (ego worst, 4 frames = 133ms on tip-demo), Wikipedia on 4 frames of only the globe and an empty
// search box, example.com on a frame with only its first paragraph, a #0b0d12 page on a frame with no
// cursor; README promised that `cursorAt` puts the cursor in the opening frame. Before THAT rule (no
// cut) every take opened on the white blank, a white flash on a dark page. Progressive loads after
// later navigations (a link click, goto()) stay on film: that is the app, not setup.
//
// HOW (cutOpening, below; the stage calls it through backend.markOpening() as the LAST step of open()):
//   1. wait until the dressed page has been through two animation frames (OPENING_PRESENTED_SOURCE),
//      so the frame that paints the cursor has been produced, not just requested;
//   2. MARK (sink.beginFootage()): every frame accepted so far is setup, and is discarded, files
//      included (so a take rebuilt from the directory, lib/workdir.mjs, agrees), the moment a frame
//      accepted after the mark exists;
//   3. FORCE that frame: the liveness probe's one-pixel change (LIVENESS_SOURCE, invisible: 1x1, 2%
//      alpha, bottom-right), because a screencast only sends a frame when the picture changes, and on a
//      page that finished painting before the mark nothing else would. Every frame after the mark shows
//      the page as dressed; the cut is by ARRIVAL ORDER, not by timestamp, on purpose: matching frames
//      against a page-side time needs two clocks to agree to a few ms, and they do not (MEASURED: the
//      paint entry lands 0-4ms after the first content frame's stamp on Playwright, 27-33ms on ego).
//   4. wait up to OPENING_TIMEOUT_MS for it.
// THE CUT'S STATE MACHINE (sink.opening.state):
//   none ──beginFootage()──> marked ──a frame arrives──> cut         (frames before the mark dropped)
//                              └──────OPENING_TIMEOUT_MS──> abandoned (nothing dropped, now or later)
// `cut` and `abandoned` are terminal, and a second beginFootage() is ignored (open() runs once). A take
// is never left without a frame: the drop happens only once a later frame EXISTS, a take whose open()
// failed (a slow first page past its timeoutMs) never marks and keeps everything it filmed, and a mark
// with no frame after it is abandoned rather than left armed, because a frame arriving later (the first
// caption fade) would otherwise cut a second or more of the take's opening away from its timeline.
// `abandoned` keeps the setup frames in the take: worse than the dressed shot, never worse than before.
// film-web warns on it (sidecar `capture.opening`). The cursor's first appearance is its resting place:
// the overlay builds it off screen (lib/cursor-overlay.mjs) and open() places it once, before the mark.
//
// FRAME FILE NAMES CARRY THEIR OWN TIMESTAMP: `000042_1790000000.123456.jpg` is frame 42, seen at
// that epoch second. The list of frames in memory dies with the process, and the file names are
// the one record that survives a killed runtime (the ego wrapper dies without letting the runner
// run a handler), so a take can be rebuilt from the directory alone — see lib/workdir.mjs.
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Read a JPEG's real pixel dimensions out of its SOF marker. This — not the frame metadata, not
 *  a page-info call — is what ffmpeg will actually encode, so it is what the geometry check must
 *  assert on. Walks the marker chain; null on anything it does not understand (which the caller
 *  treats as a failure like any other wrong size). */
export function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (i + 3 >= buf.length) return null;
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/** `000042_1790000000.123456.jpg` */
export function frameFileName(seq, t) {
  return `${String(seq).padStart(6, '0')}_${t.toFixed(6)}.jpg`;
}

/** Inverse of frameFileName; null for anything that is not one of ours. */
export function parseFrameFileName(name) {
  const m = /^(\d{6,})_(\d+\.\d{6})\.jpg$/.exec(name);
  return m ? { seq: Number(m[1]), t: Number(m[2]) } : null;
}

// ── THE LIVENESS PROBE: the stall check's primary test ──────────────────────────────────────
// The failure the stall check exists for is mechanical: a screencast frame that is not acked stops
// delivery for the rest of the take, and the video freezes at exactly the right length. So instead of
// judging the last frame's CONTENT against a screenshot (a different rasterizer: MEASURED under ego, a
// text-heavy static page's healthy last frame scored SSIM 0.9915 against its own screenshot, below
// the 0.995 bar, and every such take failed), the probe asks the stream to deliver: while capture is
// still live, it changes one pixel in a corner of the page (a 1x1 fixed element whose 2%-alpha
// background alternates between black and white, pointer-events:none, created on first use) and waits
// for a frame stamped at or after that moment. A stream that delivers it is alive, so the video
// cannot be frozen behind it. That frame is evidence only: the sink acks it and does not record it
// (see probeSince in createFrameSink), so the take's length and last frame are what they were. No
// frame within LIVENESS_TIMEOUT_MS is a stall. Measurements are in film-web.mjs, THE STALL CHECK.
export const LIVENESS_TIMEOUT_MS = 2000;
const LIVENESS_SOURCE = `(() => {
  let el = document.getElementById('__filmkit_liveness');
  if (!el) {
    el = document.createElement('div');
    el.id = '__filmkit_liveness';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;pointer-events:none;z-index:2147483647;';
    (document.body || document.documentElement).appendChild(el);
  }
  el.dataset.n = String((Number(el.dataset.n) || 0) + 1);
  el.style.background = Number(el.dataset.n) % 2 ? 'rgba(0,0,0,0.02)' : 'rgba(255,255,255,0.02)';
  return true;
})()`;

/**
 * Run the liveness probe on a LIVE capture. Never throws.
 * @param {{ sink: {frames: Array<{t:number}>}, evaluate: (source: string) => Promise<any>, timeoutMs?: number }} o
 * @returns {Promise<{ ok: boolean|null, latencyMs: number|null, error: string|null }>} ok null: the probe
 *   could not run (the page would not evaluate), so it decides nothing
 */
export async function probeLiveness({ sink, evaluate, timeoutMs = LIVENESS_TIMEOUT_MS }) {
  const since = Date.now() / 1000;
  sink.beginProbe(since); // from here, a frame stamped after `since` is evidence, not footage
  try {
    await evaluate(LIVENESS_SOURCE);
  } catch (err) {
    return { ok: null, latencyMs: null, error: String(err?.message || err).split('\n')[0] };
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = sink.probeHitT;
    if (hit !== null) return { ok: true, latencyMs: Math.max(0, Math.round((hit - since) * 1000)), error: null };
    if (Date.now() >= deadline) return { ok: false, latencyMs: null, error: null };
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ── THE OPENING CUT (header, THE OPENING FRAME) ────────────────────────────────────────────────
/** How long the cut waits for the forced frame. The liveness probe's own budget: a healthy capture
 *  answers the same one-pixel change in 4-40ms (film-web.mjs, THE STALL CHECK). */
export const OPENING_TIMEOUT_MS = LIVENESS_TIMEOUT_MS;
// Resolves once the page has run two animation frames: the first one's rendering update carries what
// was drawn before it (the cursor), and the second starts only after that frame was produced. The
// timeout is for a page whose animation frames are throttled; it only makes step 1 weaker, never stuck.
const OPENING_PRESENTED_SOURCE = `(() => new Promise((resolve) => {
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(true); } };
  requestAnimationFrame(() => requestAnimationFrame(finish));
  setTimeout(finish, 250);
}))()`;

/**
 * Make the dressed page the take's first frame. Called once, by both backends' markOpening(), as the
 * last step of the stage's open(). Never throws: a cut that cannot be made leaves the take as it was.
 * @param {object} o
 * @param {ReturnType<typeof createFrameSink>} o.sink
 * @param {(source: string) => Promise<any>} o.evaluate page-side evaluate of an expression string
 * @param {() => Promise<void>} [o.drain] hand every frame already delivered to the sink (ego: its
 *   shared event queue), so a frame of the undressed page is counted before the mark, not after it
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{state: 'cut'|'abandoned', dropped: number, latencyMs: number|null}>}
 */
export async function cutOpening({ sink, evaluate, drain = async () => {}, timeoutMs = OPENING_TIMEOUT_MS }) {
  await evaluate(OPENING_PRESENTED_SOURCE).catch(() => {});
  await drain().catch(() => {});
  await sink.beginFootage();
  await evaluate(LIVENESS_SOURCE).catch(() => {}); // no repaint: the wait below abandons the cut
  const deadline = Date.now() + timeoutMs;
  while (sink.opening.state === 'marked' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  sink.settleOpening();
  return sink.opening;
}

/**
 * TWO `Page.captureScreenshot`s of the page as it is NOW, 150ms apart, written to `dir` as
 * final-shot.png and final-shot-2.png. The stall check's FALLBACK, used only when the liveness probe
 * above could not run (and recorded as a diagnostic otherwise): film-web compares the first
 * with the last frame the screencast delivered, and the pair with each other. A screencast that
 * stopped delivering while the page kept changing leaves a last frame that is STALE, and the
 * video is frozen at exactly the right length, passing every duration check. Why two: the page's
 * own motion is the yardstick. A static page must match its last frame almost exactly; an
 * animating one cannot, but its last frame must still be at least as close to the page as the
 * page is to itself 150ms later — a stalled frame is older than that. See film-web.mjs's
 * STALL_MARGIN for the rule and its measurements. Runs inside the backend because that is where
 * the CDP session is (the ego runtime has no ffmpeg; the comparison is film-web's).
 * Never throws: a screenshot that cannot be taken is reported, not fatal.
 * @param {(method: string, params?: object) => Promise<any>} send
 * @returns {Promise<{finalShot: string|null, finalShot2: string|null, finalShotError: string|null}>}
 */
export async function captureFinalShots(send, dir) {
  const paths = [join(dir, 'final-shot.png'), join(dir, 'final-shot-2.png')];
  try {
    for (let i = 0; i < 2; i++) {
      if (i) await new Promise((r) => setTimeout(r, 150));
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      if (!shot?.data) throw new Error('no image data');
      await writeFile(paths[i], Buffer.from(shot.data, 'base64'));
    }
    return { finalShot: paths[0], finalShot2: paths[1], finalShotError: null };
  } catch (err) {
    return { finalShot: null, finalShot2: null, finalShotError: String(err?.message || err) };
  }
}

/**
 * @param {object} o
 * @param {string} o.framesDir already created by the backend
 * @param {{width:number,height:number}} o.viewport
 */
export function createFrameSink({ framesDir, viewport }) {
  /** @type {Array<{file: string, t: number}>} */
  const frames = [];
  const pendingWrites = new Set();
  const inFlight = new Set(); // accept() calls that have not returned yet
  let seq = 0;
  let writeError = null; // first frame-to-disk failure, surfaced by validate()
  let ackFailures = 0;
  let clockFallbacks = 0;
  let firstFrameSize = null;
  // live: ack every frame. draining: capture has been told to stop; frames still in the pipe are
  // kept but NOT acked (an ack after stopScreencast is an error by construction, and counting it
  // would report a stalled screencast on every healthy take). sealed: nothing more is taken.
  let mode = 'live';
  // The liveness probe (probeLiveness): once it has started, a frame stamped at or after `probeSince`
  // is EVIDENCE, not footage. It is acked (the stream stays live) and noted, never recorded: the take
  // ends where it ended before the probe. Recording it would put a frame at the very end of the stage's
  // end settle, and the tail rule (lib/workdir.mjs: the settle's length is the tail's floor, because no
  // frame arrives during it) would then hold it for another full settle: MEASURED, +1.1s on tip-demo.
  let probeSince = null;
  let probeHitT = null;
  // THE OPENING FRAME (header): the cut's state machine. `preroll` is how many of `frames` were accepted
  // before the mark (setup), discarded once a frame after them arrives; meaningful only while `marked`.
  /** @type {{state: 'none'|'marked'|'cut'|'abandoned', dropped: number, latencyMs: number|null}} */
  const opening = { state: 'none', dropped: 0, latencyMs: null };
  let preroll = 0;
  let markedAt = 0;
  const writes = new Map(); // file -> its write while in flight, so a discarded frame is unlinked only once it is on disk
  let firstSeenT = null; // the first frame's stamp, kept after the opening cut (firstFrameLagSec)

  function dropPreroll() {
    for (const { file } of frames.splice(0, preroll)) {
      const gone = (writes.get(file) ?? Promise.resolve())
        .then(() => unlink(join(framesDir, file)))
        .catch(() => {}) // already gone, or never written (writeError reports that)
        .finally(() => pendingWrites.delete(gone));
      pendingWrites.add(gone);
    }
    opening.state = 'cut';
    opening.dropped = preroll;
    opening.latencyMs = Date.now() - markedAt;
    preroll = 0;
  }

  async function acceptOne(p, ack) {
    if (mode === 'live') {
      try {
        await ack(p.sessionId);
      } catch {
        // Only a failure while the take is LIVE counts: delivery may have stalled from here on.
        if (mode === 'live') ackFailures++;
      }
    }
    if (!p.data || mode === 'sealed') return;
    const t = p.metadata?.timestamp;
    // A frame with no usable timestamp cannot be placed on the recording clock, and guessing
    // with Date.now() would silently shift everything after it against the timeline that
    // tighten protects. Count it; validate() refuses the take.
    if (!Number.isFinite(t)) clockFallbacks++;
    const at = Number.isFinite(t) ? t : Date.now() / 1000;
    if (probeSince !== null && Number.isFinite(t) && t >= probeSince) {
      probeHitT ??= t;
      return;
    }
    const buf = Buffer.from(p.data, 'base64');
    const file = frameFileName(++seq, at);
    if (seq === 1) firstFrameSize = jpegSize(buf);
    firstSeenT ??= at;
    frames.push({ file, t: at });
    const write = writeFile(join(framesDir, file), buf)
      .catch((err) => {
        // Unhandled, this rejection kills the whole ego runtime under Node's default policy: no
        // error line, no task-space release, the run just stops existing.
        writeError = writeError || err;
      })
      .finally(() => {
        pendingWrites.delete(write);
        writes.delete(file);
      });
    pendingWrites.add(write);
    writes.set(file, write);
    if (opening.state === 'marked' && frames.length > preroll) dropPreroll();
  }

  return {
    frames,
    /** Acks that failed while the take was live. Any is a stalled screencast until proven
     *  otherwise: the take is `failed` (film-web.mjs), not merely noted. */
    get ackFailures() {
      return ackFailures;
    },
    get firstFrameSize() {
      return firstFrameSize;
    },

    /** One screencast frame. `ack(sessionId)` is called FIRST while live: an un-acked frame stops
     *  delivery for the rest of the take, so the ack must not sit behind the disk write (fired off
     *  above, awaited at flush). A failed ack is bad — delivery may stall — but it is not a reason
     *  to drop the frame already in hand. Nothing here throws: one bad frame must not cost the
     *  batch, and ego's drainEvents() has already CONSUMED the others. Problems are counted and
     *  reported by validate(), where there is a whole take's context to report them against.
     *  Every call is tracked so flush() can wait for it, and a call that arrives after seal() is
     *  ignored. */
    accept(params, ack) {
      const run = acceptOne(params || {}, ack).catch(() => {});
      inFlight.add(run);
      run.finally(() => inFlight.delete(run));
      return run;
    },

    /** The stamp of the first frame capture delivered (epoch seconds), or null. Unlike frames[0], it
     *  survives the opening cut: it is what a backend's firstFrameLagSec measures the clock by. */
    get firstSeenT() {
      return firstSeenT;
    },

    /** THE OPENING FRAME (header), step 2: the page is dressed. Every frame accepted so far (in-flight
     *  ones included, awaited here) is setup, and is discarded as soon as a frame accepted after this
     *  call exists. Once per take (cutOpening, through backend.markOpening()); a second call is ignored. */
    async beginFootage() {
      if (opening.state !== 'none') return;
      while (inFlight.size) await Promise.all([...inFlight]);
      preroll = frames.length;
      markedAt = Date.now();
      opening.state = 'marked';
    },

    /** The cut's wait is over: a mark still waiting for its frame is abandoned, so a frame arriving
     *  later in the take cannot cut its opening away (header, THE CUT'S STATE MACHINE). */
    settleOpening() {
      if (opening.state !== 'marked') return;
      opening.state = 'abandoned';
      preroll = 0;
    },

    /** { state, dropped, latencyMs }: how the opening cut went (header, THE OPENING FRAME). `dropped`
     *  counts setup frames discarded; `latencyMs` is mark to first footage frame. */
    get opening() {
      return { ...opening };
    },

    /** The liveness probe starts at epoch second `since` (see probeSince above). */
    beginProbe(since) {
      probeSince = since;
    },

    /** When the probe began (epoch seconds), or null. Nothing after it is footage, so a backend's
     *  `stopT` (the last frame's on-screen end) is this, not the later moment capture was stopped:
     *  the probe's own round trip must not lengthen the take's tail. */
    get probeSince() {
      return probeSince;
    },

    /** Timestamp of the first frame that arrived after the probe began, or null. */
    get probeHitT() {
      return probeHitT;
    },

    /** Capture has been told to stop: keep what still arrives, stop acking it. */
    beginStop() {
      if (mode === 'live') mode = 'draining';
    },

    /** Nothing more is accepted. Call after flush(). */
    seal() {
      mode = 'sealed';
    },

    /** Wait for every accept() in flight AND every frame accepted so far to be on disk. Loops,
     *  because finishing one accept can start a write. */
    async flush() {
      while (inFlight.size || pendingWrites.size) {
        await Promise.all([...inFlight, ...pendingWrites]);
      }
    },

    /** Throws if the take cannot be trusted. Call after flush(). (A stalled screencast is NOT
     *  thrown here: film-web decides that, from the counts and the final-frame check the backend
     *  hands over, so it can be a `failed` take with its footage kept rather than a flow error.) */
    validate() {
      if (writeError) throw new Error(`could not write captured frames to ${framesDir}: ${writeError.message}`);
      if (clockFallbacks) {
        throw new Error(
          `${clockFallbacks} of ${frames.length} captured frame(s) arrived with no usable ` +
            'metadata.timestamp. The recording clock, and every caption range measured against ' +
            'it, would be wrong — refusing the take rather than shipping a timeline that lies.',
        );
      }
      if (!frames.length) throw new Error('screencast captured no frames — nothing to assemble');
    },

    /** The frame-1 geometry error, or null. Every later frame is the same size as the first, so a
     *  mismatch is knowable at once — before the flow spends thirty seconds filming something that
     *  will be assembled at the wrong resolution. */
    firstFrameSizeError() {
      if (firstFrameSize && firstFrameSize.width === viewport.width && firstFrameSize.height === viewport.height) return null;
      const got = firstFrameSize ? `${firstFrameSize.width}x${firstFrameSize.height}` : 'unreadable';
      return (
        `screencast frames are ${got}, not the requested ${viewport.width}x${viewport.height}. ` +
        'The viewport override did not take — refusing to film at the wrong size.'
      );
    },
  };
}
