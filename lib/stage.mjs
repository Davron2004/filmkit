// ─────────────────────────────────────────────────────────────────────────────
// lib/stage.mjs — filmkit's web stage. Films a scripted walkthrough of ANY web app
// running in a real Chromium window: a real animated cursor, real clicks and
// keystrokes (driven through the backend's actual mouse/keyboard so hover states and
// focus track what's on screen), and caption text overlaid on top.
//
// THE STAGE IS BACKEND-AGNOSTIC. It owns choreography — cursor pathing, dwell timings,
// caption cross-fades, char-by-char typing rhythm, the timeline sidecar — and nothing
// else. Which Chromium it drives, how coordinates are resolved, and how frames become a
// video all live behind a backend object (lib/backends/playwright.mjs, lib/backends/ego.mjs):
//
//   launch({viewport})        bring up the browser/tab at the recording size
//   resolveOpenUrl(urlOrPath) how a local path is made loadable by THIS backend
//   goto(url, {timeoutMs})    navigate
//   waitForSelector(css, {timeoutMs})
//   evaluate(source)          page-side JS, as an expression STRING (no arg channel)
//   addInitScript(source)     same, re-run on every future document
//   mouseMove(x, y) / click(x, y)
//   typeChar(ch)              a real key event pair, never a value assignment
//   selectAllIn(target)       select the text already in a field, so typing replaces it
//   resolveBox(target, {timeoutMs}) -> {x, y, width, height} in CSS viewport pixels,
//                             after scrolling into view and waiting for visibility. OWNS THE
//                             AUTO-WAIT (see below)
//   currentUrl()              for error messages — "not found" is unreadable without it
//   waitForDocumentReady({timeoutMs})
//   sleep(ms)
//   now()                     recording-clock seconds (units are the backend's own; see below)
//   startRecording() / stopRecording() -> a backend-specific recording descriptor
//   close()                   idempotent teardown
//   page                      the flow-facing escape hatch (shape differs per backend)
//   clock                     'frame' (timestamps come from real captured frames) or
//                             'approximate' (wall clock since recording began)
//
// AUTO-WAIT lives in exactly one place: the backend's resolveBox. click(), point(), type() and
// waitFor() all go through it, so there is one definition of "the target is ready" — present in
// the document AND laid out with a non-zero box AND not display:none/visibility:hidden/opacity:0
// — one timeout (10s), and one error message. A flow never needs a manual sleep before a target
// that appears late; adding one only makes the take longer.
//
// STATE MACHINE (the director):
//
//   idle ──open()──> ready ──{click|type|point|waitFor|goto|caption|clearCaption|pause}*──> ready
//                      │                                                                     │
//                      └────────────── abort() ──────────> closed <──────────── finish() ────┘
//
// - `idle`: ONLY open() is legal. Every other action throws immediately rather than
//   silently no-opping, so a flow missing its open() fails on line 1, not on frame 300.
// - `open()` runs once per flow, and is the only transition out of `idle`. A SECOND navigation
//   in the same take is `goto()`, which is legal only from `ready` — the two are deliberately
//   different verbs, because open() has a first-frame job (install the overlay's init script,
//   seed the cursor) that must not run twice.
// - There is no back-navigation and no mid-action cancel in this machine: an action either
//   completes or throws, and a throw unwinds to film-web.mjs, which calls abort().
// - `abort()` is the only escape from a thrown error inside a flow — it tears down the
//   browser without producing a video, so a failed flow never leaves a zombie Chromium
//   process or an orphaned ego task space. It is idempotent and legal from ANY state,
//   including `closed`, which is what makes the error path unable to get stuck.
// - `finish()` is the only path that yields a recording, and is terminal. Calling any
//   action after finish()/abort() throws.
//
// NAVIGATION AND THE OVERLAY. The cursor and caption bar are DOM in the page, so every new
// document destroys them. Three mechanisms, each covering a case the others cannot:
//   1. INIT SCRIPT. The overlay source is registered once, at open(), via the backend's
//      addInitScript, so every future document rebuilds the cursor and caption DOM at
//      document-start without the flow asking. This is what makes a link click survivable at all.
//   2. STATE THE DOM CANNOT CARRY. Where the cursor is, and which caption is currently up, live
//      in this file, not in the page. `syncDocument()` compares a per-document token (minted by
//      that same init script) against the last one seen and, on a change, waits for the new
//      document to be ready and re-applies both. It runs after every click — the only thing the
//      stage does that can replace a document — and inside goto(). It is GATED on `navSuspect`
//      rather than run before every action, because it costs a round trip and a caption() cannot
//      navigate; on the ego backend an ungated check cost 0.24s over a 25s take, all of it
//      answering a question whose answer could not have changed.
//   3. THE FREE DETECTOR, for a navigation nobody asked for (a meta refresh, a JS redirect during
//      a long hold). setCursorPosition returns false when there is no cursor element in the
//      document, so the next cursor move notices and re-dresses — off a call the animation was
//      making anyway.
// A caption that spans a navigation stays ONE timeline range: the re-dress re-shows the same text
// and never touches `openCaption`, so nothing closes the range and nothing opens a new one.
//
// DETERMINISM INVARIANT: every timing value here (cursor-move duration, per-character type
// delay, dwell/settle pauses) is a PURE FUNCTION of distance / text length / fixed constants
// below — no Math.random(), no wall-clock-derived jitter. Re-filming the same flow file against
// the same build reproduces the same choreography every time (the SCRIPT is deterministic; the
// resulting mp4's exact bytes still differ run to run, since a video codec's timestamps and the
// real CDP mouse-move round-trip are not — that's expected and not what this invariant claims).
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  installOverlay,
  ensureOverlay,
  documentToken,
  playClickRipple,
  setCursorPosition,
  setCaptionText,
  setCaptionVisible,
  isCaptionVisible,
} from './cursor-overlay.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT_DIR = join(HERE, '..', 'out');

// ── Pacing constants — the whole determinism story lives here, nowhere else ────────────────
export const VIEWPORT = { width: 1280, height: 720 }; // clean 16:9, matches recordVideo.size

const CURSOR_SPEED_PX_PER_MS = 1.3; // ~human mouse-flick speed
const CURSOR_MOVE_MIN_MS = 320;
const CURSOR_MOVE_MAX_MS = 1500;
const CURSOR_STEP_MS = 40; // ~25 intermediate DOM positions/sec while moving
const CURSOR_MIN_STEPS = 6;

const PRESS_DWELL_MS = 110; // pause after arrival, cursor already shrunk, before the real click
const CLICK_SETTLE_MS = 180; // pause after the real click, before releasing the "pressed" look

const TYPE_BASE_DELAY_MS = 85;
const TYPE_MIN_DELAY_MS = 60;
const TYPE_MAX_DELAY_MS = 120;
// Fixed jitter table (never Math.random) — deterministic "human-ish" rhythm to typing.
const TYPE_JITTER_MS = [0, 20, -18, 12, -10, 18, -6, 14];
const TYPE_POST_SETTLE_MS = 350;

const CAPTION_FADE_MS = 280;

const SETTLE_MS_START = 700; // beat after the app first paints, before anything moves
export const SETTLE_MS_END = 1000; // beat before closing, so playback doesn't feel clipped

const TARGET_TIMEOUT_MS = 10000; // one auto-wait budget, shared by click/point/type/waitFor
const NAV_READY_TIMEOUT_MS = 20000; // how long a document gets to finish loading after it commits

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Set up the stage on an already-launched backend whose recording has already started
 * (recording begins BEFORE any navigation, so the video opens on the app rather than on a
 * blank tab), and return the director API a flow file drives.
 *
 * @param {object} o
 * @param {object} o.backend one of lib/backends/*.mjs, already `launch()`ed and recording
 * @param {{width: number, height: number}} [o.viewport] recording size (default 1280x720)
 * @param {boolean} [o.ripple] draw the click ripple (default true). Off is for a flow that films
 *   an app which draws its own press feedback and would end up with two rings.
 */
export function createStage({ backend, viewport = VIEWPORT, ripple = true } = {}) {
  if (!backend) throw new Error('createStage: a backend is required');

  /** @type {'idle'|'ready'|'closed'} */
  let state = 'idle';
  let cursorPos = { x: viewport.width / 2, y: viewport.height / 2 };

  // ── Timeline: every authored hold, in the backend's recording-clock units. The caller
  // rebases these against the recording's own zero point (see stopRecording()'s `t0`).
  // A caption range is open from the instant its fade-in starts until the instant its
  // fade-out finishes; `openCaption` is the one piece of state that could strand a range
  // with no end, so finish() AND abort() both close it. Ranges may overlap (a pause inside
  // a caption is both), which is correct — a consumer merges them.
  /** @type {Array<{kind: 'caption'|'pause', start: number, end: number, text?: string}>} */
  const timeline = [];
  let openCaption = null;
  let docToken = null;
  let navSuspect = false; // "something we did could have replaced the document" — see syncDocument

  const now = () => backend.now();
  function closeOpenCaption(at) {
    if (!openCaption) return;
    timeline.push({ kind: 'caption', start: openCaption.start, end: at, text: openCaption.text });
    openCaption = null;
  }

  function requireOpen() {
    if (state === 'closed') throw new Error('stage: this stage is closed — finish()/abort() is terminal');
    if (state !== 'ready') throw new Error('stage: no app loaded yet — call stage.open(url) first');
  }

  // Animate the fake cursor from its current position to (x, y) along an eased path — duration
  // proportional to distance (clamped), stepped at CURSOR_STEP_MS. Also drives the REAL mouse
  // along the same path so hover states track what's on screen.
  async function moveCursorTo(x, y) {
    const from = cursorPos;
    const dx = x - from.x;
    const dy = y - from.y;
    const distance = Math.hypot(dx, dy);
    const duration = clamp(distance / CURSOR_SPEED_PX_PER_MS, CURSOR_MOVE_MIN_MS, CURSOR_MOVE_MAX_MS);
    const steps = Math.max(CURSOR_MIN_STEPS, Math.round(duration / CURSOR_STEP_MS));
    for (let i = 1; i <= steps; i++) {
      const eased = easeInOutCubic(i / steps);
      const cx = from.x + dx * eased;
      const cy = from.y + dy * eased;
      const drawn = await setCursorPosition(backend, cx, cy);
      // No cursor in this document means the document is not the one we dressed — something
      // navigated without a click. Re-dress and carry on; this is the only detector for a
      // navigation the stage did not initiate, and it costs nothing (the call above was
      // happening regardless).
      if (drawn === false) {
        await syncDocument({ force: true });
        await setCursorPosition(backend, cx, cy);
      }
      await backend.mouseMove(cx, cy);
      await backend.sleep(duration / steps);
    }
    cursorPos = { x, y };
  }

  async function centerOf(target) {
    requireOpen();
    await syncDocument();
    const box = await backend.resolveBox(target, { timeoutMs: TARGET_TIMEOUT_MS });
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  // A `(page) => Locator` target is a FUNCTION, and calling it twice runs the query twice — which
  // for a text-filtered or nth-match locator can legitimately resolve to two different elements if
  // the page moved between the two calls. type() used to do exactly that: once to click, once to
  // select the text it was about to replace. Resolve once, reuse the Locator.
  function pinTarget(target) {
    if (typeof target !== 'function') return target;
    let resolved;
    let done = false;
    const pinned = (page) => {
      if (!done) {
        resolved = target(page);
        done = true;
      }
      return resolved;
    };
    // Lazy, not eager: the ego backend refuses function targets, and it names them by printing
    // their source. Resolving here would both call a Playwright API that does not exist there and
    // replace the flow's own code in that message with this wrapper's.
    pinned.toString = () => String(target);
    return pinned;
  }

  // Re-dress a document the stage did not draw on yet: build the overlay if the init script has
  // not (or the page had no <body> when it ran), put the cursor back where the flow left it, and
  // re-show the caption that is still notionally up. Deliberately does NOT touch `openCaption` or
  // the timeline — the caption is the same caption, and its range is the same range.
  async function restoreOverlay() {
    await ensureOverlay(backend);
    await setCursorPosition(backend, cursorPos.x, cursorPos.y);
    if (openCaption) {
      await setCaptionText(backend, openCaption.text);
      await setCaptionVisible(backend, true);
    }
    docToken = await documentToken(backend);
  }

  /**
   * Returns true if this is a different document than the one we last dressed.
   *
   * COSTS ONE EVALUATE, so it does not run on every action. `navSuspect` gates it: a document can
   * only be replaced by something that navigates, and the only navigations the stage participates
   * in are its own clicks (checked immediately after) and goto() (which re-dresses directly). A
   * navigation nobody asked for — a meta refresh, a JS redirect fired during a long hold — is
   * caught by moveCursorTo instead, off a call it was making anyway. Between the two, the sync is
   * free in the steady state and still never leaves a bare page on screen for a whole action.
   */
  async function syncDocument({ force = false } = {}) {
    if (!force && !navSuspect) return false;
    navSuspect = false;
    const token = await documentToken(backend);
    if (token !== null && token === docToken) return false;
    await backend.waitForDocumentReady({ timeoutMs: NAV_READY_TIMEOUT_MS }).catch(() => {});
    await restoreOverlay();
    return true;
  }

  const director = {
    /** The backend's raw page handle — escape hatch for anything the director doesn't cover.
     *  Under `--browser playwright` this is the real Playwright `Page` (custom locators,
     *  dialogs, file uploads, waiting on network responses, `frameLocator`). Under
     *  `--browser ego` there is no Playwright object to hand out, so this is a small stand-in
     *  exposing only `evaluate(source)` (a JS expression STRING — no argument channel),
     *  `waitForSelector(css, { timeoutMs })` and `goto(url)`. Flows that only used
     *  `stage.page.evaluate('...')` keep working on both. */
    get page() {
      return backend.page;
    },

    /** The authored-hold timeline, in the backend's recording-clock units. Read after finish(). */
    get timeline() {
      return timeline;
    },

    /** Load the app under film: `urlOrPath` is an http(s) URL or a local file path (which each
     *  backend makes loadable its own way — file:// for Playwright, a loopback static server for
     *  ego). Waits for `load`, optionally for `{ readySelector }` to appear, injects the overlay,
     *  then holds a settle beat. Call once at the start of a flow. */
    async open(urlOrPath, { readySelector, timeoutMs = 20000, settleMs = SETTLE_MS_START } = {}) {
      if (state === 'ready') throw new Error('stage.open: already opened — use stage.goto(url) to navigate again');
      if (state === 'closed') throw new Error('stage.open: this stage is closed');
      const url = await backend.resolveOpenUrl(urlOrPath);
      await backend.goto(url, { timeoutMs });
      if (readySelector) await backend.waitForSelector(readySelector, { timeoutMs });
      state = 'ready';
      // Registers the overlay for every FUTURE document too — the one call that makes navigation
      // survivable at all. Only open() does this; goto() and syncDocument() re-dress, never
      // re-register.
      await installOverlay(backend);
      docToken = await documentToken(backend);
      navSuspect = false;
      await setCursorPosition(backend, cursorPos.x, cursorPos.y);
      await backend.sleep(settleMs);
    },

    /** Navigate again inside the same take. Same options as open(), but this is the SECOND-and-
     *  later verb: the overlay's init script is already registered, so the new document brings
     *  its own cursor and caption DOM, and this puts the cursor back where the flow left it and
     *  re-shows the caption that was up. A caption held across a goto() stays one timeline range. */
    async goto(urlOrPath, { readySelector, timeoutMs = 20000, settleMs = SETTLE_MS_START } = {}) {
      requireOpen();
      const url = await backend.resolveOpenUrl(urlOrPath);
      await backend.goto(url, { timeoutMs });
      if (readySelector) await backend.waitForSelector(readySelector, { timeoutMs });
      await restoreOverlay();
      await backend.sleep(settleMs);
    },

    /** Wait for `target` to be present and visible, without pointing at it or clicking it — for
     *  a thing the flow needs on screen before it narrates. Same auto-wait, same timeout, same
     *  error as click()/point()/type(); returns nothing. Every action already waits, so this is
     *  only needed when the thing you are waiting for is not the thing you are about to act on. */
    async waitFor(target, { timeoutMs = TARGET_TIMEOUT_MS } = {}) {
      requireOpen();
      await syncDocument();
      await backend.resolveBox(target, { timeoutMs });
    },

    /** Animate the cursor to `target`'s center, dwell, show press feedback, then perform a REAL
     *  click at those page-viewport coordinates. */
    async click(target) {
      const { x, y } = await centerOf(target);
      await moveCursorTo(x, y);
      await setCursorPosition(backend, x, y, true);
      await backend.sleep(PRESS_DWELL_MS);
      // The ring goes up IMMEDIATELY BEFORE the input dispatch, not after: the two land within
      // one round trip of each other, so the frame where the app reacts is the frame that already
      // has the ripple on it. Ordered the other way the ring trails the reaction, which reads as
      // "something happened, then it was clicked". point() never calls this — a ripple with no
      // click behind it is a lie about what the take shows.
      if (ripple) await playClickRipple(backend, x, y);
      await backend.click(x, y);
      navSuspect = true; // a click is the only thing the stage does that can replace the document
      await backend.sleep(CLICK_SETTLE_MS);
      // A click is the one action that can replace the document under us — a link, a form post.
      // If it did, the "release the press" below would land on a page that has no cursor in it,
      // so re-dress first and skip the release (the new document's cursor was never pressed).
      if (await syncDocument()) return;
      await setCursorPosition(backend, x, y, false);
    },

    /** Move the cursor to `target` WITHOUT clicking — for gesturing at a value while narrating
     *  via caption(), without pretending it was pressed. */
    async point(target) {
      const { x, y } = await centerOf(target);
      await moveCursorTo(x, y);
    },

    /** Click into `target` (same cursor animation as click()), select any existing text, then
     *  type `text` one character at a time with a deterministic per-character delay. */
    async type(target, text) {
      requireOpen();
      const pinned = pinTarget(target);
      await director.click(pinned);
      await backend.selectAllIn(pinned);
      for (let i = 0; i < text.length; i++) {
        await backend.typeChar(text[i]);
        const delay = clamp(
          TYPE_BASE_DELAY_MS + TYPE_JITTER_MS[i % TYPE_JITTER_MS.length],
          TYPE_MIN_DELAY_MS,
          TYPE_MAX_DELAY_MS,
        );
        await backend.sleep(delay);
      }
      await backend.sleep(TYPE_POST_SETTLE_MS);
    },

    /** Show caption text in the bottom overlay bar, cross-fading out any previous caption first. */
    async caption(text) {
      requireOpen();
      await syncDocument();
      if (await isCaptionVisible(backend)) {
        await setCaptionVisible(backend, false);
        await backend.sleep(CAPTION_FADE_MS);
        closeOpenCaption(now());
      }
      await setCaptionText(backend, text);
      const start = now();
      await setCaptionVisible(backend, true);
      await backend.sleep(CAPTION_FADE_MS);
      openCaption = { start, text };
    },

    /** Fade the caption bar out. */
    async clearCaption() {
      requireOpen();
      await syncDocument();
      await setCaptionVisible(backend, false);
      await backend.sleep(CAPTION_FADE_MS);
      closeOpenCaption(now());
    },

    /** A plain beat — `ms` wall-clock milliseconds, nothing derived. */
    async pause(ms) {
      requireOpen();
      const start = now();
      await backend.sleep(ms);
      timeline.push({ kind: 'pause', start, end: now() });
    },

    /** Close the stage WITHOUT producing a recording — the escape hatch when a flow throws, so a
     *  failed run never leaves a zombie Chromium process or a live ego task space. Legal from any
     *  state, including `closed`, and safe to call twice. */
    async abort() {
      if (state !== 'closed') closeOpenCaption(now());
      state = 'closed';
      await backend.close().catch(() => {});
    },

    /** End settle pause, stop the recording, tear the backend down. Returns everything the
     *  caller needs to turn the recording into a file: the backend's recording descriptor, the
     *  timeline, and the recording's own zero point (`t0`) in the same units as the timeline. */
    async finish() {
      requireOpen();
      await backend.sleep(SETTLE_MS_END);
      closeOpenCaption(now());
      const recording = await backend.stopRecording();
      state = 'closed';
      await backend.close().catch(() => {});
      const t0 = recording.t0 ?? 0;
      return {
        recording,
        clock: backend.clock,
        endSettleSec: SETTLE_MS_END / 1000,
        // Rebase to the recording's zero so timeline seconds are seconds INTO the video, and
        // sort by start — entries are appended when a range CLOSES, which is not the order a
        // reader (or a future tighten pass) wants them in.
        timeline: timeline
          .map((e) => ({
            ...e,
            start: Math.max(0, e.start - t0),
            end: Math.max(0, e.end - t0),
          }))
          .sort((a, b) => a.start - b.start || a.end - b.end),
      };
    },
  };

  return director;
}
