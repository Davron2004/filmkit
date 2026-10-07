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
//   setNextDocumentScript(source) like addInitScript, but replaces the one it set before (THE
//                             CARRY-OVER, below)
//   mouseMove(x, y) / click(x, y)
//   typeChar(ch)              a real key event pair, never a value assignment
//   selectAllIn(target)       select the text already in a field, so typing replaces it
//   resolveBox(target, {timeoutMs, reveal}) -> {x, y, width, height} in CSS viewport pixels,
//                             after waiting for visibility and then bringing the target to a
//                             comfortable position (THE REVEAL, below). OWNS THE AUTO-WAIT (see
//                             below)
//   probe(target, {text})     ONE look, for expect()/oneOf(): never waits, never scrolls, never
//                             throws -> {found, visible, text, matched, error, fatal}. Same
//                             visibility rule as resolveBox; the text rule is lib/target-wait.mjs's
//   currentUrl()              for error messages — "not found" is unreadable without it
//   waitForDocumentReady({timeoutMs})
//   sleep(ms)
//   now()                     recording-clock seconds (units are the backend's own; see below)
//   markOpening()             open() has dressed the page: frames so far (the parked blank tab, the
//                             first page's progressive render) are setup and are dropped once a
//                             frame of the dressed page arrives (lib/frames.mjs, THE OPENING
//                             FRAME), so a take opens on the loaded page with its cursor in place
//   startRecording() / stopRecording() -> {kind:'frames', dir, frames, t0, stopT, ...}, the same
//                             descriptor from both backends (lib/frames.mjs); stopRecording()
//                             validates the take, partialRecording() (used by the salvage path,
//                             not by the stage) hands back what exists without validating
//   close()                   idempotent teardown; halts capture, never deletes frames
//   page                      the flow-facing escape hatch (shape differs per backend)
//   clock                     'frame' (timestamps come from real captured frames) — both shipped
//                             backends; 'approximate' (a wall clock beside an encoder) remains
//                             a legal value for a backend that has no per-frame timestamps
//
// AUTO-WAIT for an action lives in exactly one place: the backend's resolveBox. click(), point(),
// type() and waitFor() all go through it, so there is one definition of "the target is ready" —
// present in the document AND laid out with a non-zero box AND not display:none/visibility:hidden
// (and, on ego only, not opacity:0: Playwright's own rule counts an opacity:0 element visible, a known
// gap listed in lib/scenario/filmkit-stage.mjs) — one default budget (10s), and one error message. A flow never needs a manual sleep
// before a target that appears late; adding one only makes the take longer. expect() and oneOf()
// wait by polling backend.probe instead (no scroll, see CHECKPOINTS below); each backend's probe
// applies the same visibility rule as its resolveBox, so a target expect() saw is one click() finds.
//
// THE BUDGET IS PER CALL: click(target, { timeoutMs }), point(target, { timeoutMs }),
// type(target, text, { timeoutMs }), waitFor(target, { timeoutMs }), expect(target, { timeoutMs })
// and oneOf(targets, { timeoutMs }) each take the same option,
// default TARGET_TIMEOUT_MS (10s). `targetBudget()` validates the value (a finite number > 0, else
// the call throws before touching the browser — a NaN or Infinity deadline would make the ego
// backend's poll loop spin forever; it lives in lib/scenario/filmkit-stage.mjs so the test-mode
// stage refuses exactly the same calls) and centerOf() hands it to
// backend.resolveBox, which both backends already honoured. There is no ceiling: a flow that
// waits on a 5-minute generation says so, and the take's own length is the only limit. The budget
// covers the WAIT for the target only. Once the target is resolved, the cursor animation and the
// input take the time they take; type() spends its budget on the click into the field and none on
// the keystrokes.
//
// THE REVEAL. Before the cursor goes to a target (click, point, type) and in waitFor(), the backend's
// resolveBox puts the target somewhere the viewer can see it: lib/scenario/filmkit-stage.mjs's
// revealInPage, one page-side function for both backends and test mode (its header has the rule and
// the measurements). In short: a target inside the comfort zone (the viewport minus 24px edges, minus
// a 120px caption band at the bottom, minus the caption wherever it is) is not moved; any other is
// scrolled to the viewport's center. This stage passes `reveal: { pace: SCROLL_PACE, avoid: [the
// caption] }`, so on film the scroll is ANIMATED (eased, 450-1100ms by distance), then the cursor
// moves: one motion at a time, so the viewer can follow both. open()'s `cursorAt` passes no pace: the
// opening frame is placed, not scrolled to.
//
// THE CAPTION NEVER COVERS THE TARGET. Scrolling cannot always clear the caption: a target in a fixed
// footer, or near the end of a page too short to scroll it up (MEASURED: https://example.com at
// 1280x720 can scroll 55px, which leaves "Learn more" at y=665-683, inside the caption pill). So after
// the reveal, a caption that is up and still overlaps the target (its box cut to at most 240x120
// around the center, never less than the 64x64 click ring) fades out, moves to the TOP edge, and fades
// back in (2 x CAPTION_FADE_MS), before the cursor moves; a target under a top caption sends it back
// to the bottom the same way. Where it sits is `captionAt`, state the DOM cannot carry across a
// navigation, re-applied by restoreOverlay. A new caption() starts at the bottom, unless the bottom
// would cover the cursor (a flow that clicked something low and now narrates it): it is placed while
// still faded out, so that choice is never seen as a move. The caption's timeline range is unaffected.
// Test mode draws no caption and has nothing to move.
//
// NO CAPTIONS (`createStage({ captions: false })`, film-web's `--no-captions`): the take is filmed for
// subtitles added later (film-web writes `<name>.srt` from the caption ranges), a voiceover, or a clean
// version. caption() and clearCaption() keep EVERY hold they have on film, so the take is paced like its
// captioned twin and its timeline has the same caption ranges (tighten protects them, the .srt is cut
// from them); only the drawing goes. The overlay builds no caption element at all
// (lib/cursor-overlay.mjs, NO CAPTIONS), so nothing caption-shaped can reach a frame, a re-dress
// included. What exists only to keep a DRAWN caption out of the way does not run: the dodge to the top
// edge (THE CAPTION NEVER COVERS THE TARGET; a captioned take is CAPTION_FADE_MS x 2 longer per dodge),
// a new caption's placement, and the reveal's `avoid` of the caption element. What stays, on purpose:
// THE REVEAL's 120px bottom band (REVEAL_BAND_PX). It is shared with test mode, where no caption is
// ever drawn either, and keeping it keeps three things true: a target lands at the same scroll
// position in a caption-free take, its captioned twin and the scenario test (one emitted spec serves
// both takes); the two takes scroll alike, so they stay paced alike; and the band is where a player or
// an editor draws the subtitles from that .srt, so a click stays clear of them too. The cross-fade
// between two captions is decided by `openCaption` (a caption is notionally up) instead of the DOM's
// visible class, which agree on every take except one whose document was replaced and not yet
// re-dressed. The click ring and the cursor are unaffected (every take shows its clicks).
//
// CHECKPOINTS AND BRANCH POINTS (expect, oneOf). Two waits that never move the cursor, for a flow
// filming an app that is not deterministic (a generation that may or may not build):
//   expect(target, { text, timeoutMs })   waits until target is visible (and, with `text`, its
//       whitespace-collapsed textContent contains it: lib/target-wait.mjs's text rule). Timeout
//       throws, so the take is `flow-failed`.
//   oneOf({ outcome: target, … }, { name, timeoutMs, accept, filmAccept }) -> outcome
//       waits until ONE of the targets is visible and returns its key. Each poll probes the targets
//       in declaration order and takes the first visible one, so a tie goes to declaration order.
//       `accept` (default: every key) is what counts as a pass anywhere; `filmAccept` (default:
//       `accept`, and it must be a subset of it) is what the CAMERA may keep. This stage is the
//       camera (`mode` is 'film'), so an outcome outside filmAccept throws: the take is
//       `flow-failed`, named as a retake, and the error names the branch point and the outcome.
//       It throws after holding SETTLE_MS_END, so the refused outcome is on film (without the hold
//       the probe, which reads the DOM, wins the race with the frame that paints it, and capture
//       stops first: measured on ego). A timeout with nothing visible throws too, at once: the
//       video already shows the page for the whole wait.
// Both poll backend.probe() every PROBE_INTERVAL_MS, which never scrolls: these waits hold on a
// page the viewer is looking at, often for a long generation, and the picture must not move. The
// budget defaults to TARGET_TIMEOUT_MS like every other wait, with no ceiling. Options are checked
// before the browser is touched, unknown option keys included: a misspelt `filmAccept` would
// otherwise keep a take the flow meant to refuse.
// While a wait runs, the stage re-checks the document every SYNC_DURING_WAIT_MS and once more when
// the wait is satisfied, so a page the app replaced by itself mid-wait (a redirect to a preview)
// gets its cursor and caption back within a second, not at the next cursor move — and a caption
// that was up stays one timeline range instead of being orphaned by the next caption(). An abort()
// mid-wait ends the loop at its next poll.
//
// THE OUTCOMES LOG. Every oneOf() appends { name, outcome, options, accept, filmAccept, start,
// end } — `options` is { key: target as written }, start/end bound the wait — including one that
// failed the take (a refused outcome, or `outcome: null` for a timeout), so the sidecar says what
// the app did. It is rebased in finish() exactly like the timeline, and is deliberately NOT part
// of the timeline: readers treat `timeline` as the list of authored holds (tighten protects them),
// and a oneOf wait on a generation is dead air that tighten must stay free to cut. expect() is not
// logged: it has one outcome, and a failed one is the take's error.
//
// TEST MODE. lib/scenario/filmkit-stage.mjs's createTestStage() is this director's twin for a flow
// replayed under Playwright Test (`mode` 'test'): same verbs, same validation, same decision loop,
// no choreography. A stage API change lands in BOTH files.
//
// STATE MACHINE (the director):
//
//   idle ──open()──> ready ──{click|type|point|waitFor|expect|oneOf|goto|caption|clearCaption|pause}*──> ready
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
// document destroys them. Four mechanisms, each covering a case the others cannot:
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
//   3. THE FREE DETECTOR, for a navigation nobody asked for (a meta refresh, a JS redirect).
//      setCursorPosition returns false when there is no cursor element in the document, so the
//      next cursor move notices and re-dresses — off a call the animation was making anyway.
//   4. HOLDS WATCH. pause() and finish()'s closing beat check the token every SYNC_DURING_PAUSE_MS
//      (watchfulSleep), because the click's own check can run before its navigation commits (a slow
//      server) and the flow's next step after a click is usually a hold: without this the new page
//      stayed bare for the whole hold, and clearCaption() re-showed the caption only to fade it out.
// A re-dress confirms it drew (restoreOverlay): "the document is ready" can be answered by the one
// that is leaving, and a re-dress run before the new document has a <body> draws nothing.
// THE CARRY-OVER, so a navigation is not seen at all: the re-dress comes after the new document has
// painted, and MEASURED (a caption held across a link click, both backends) the caption was gone for
// ~200ms (6 frames) and then faded back in over ~230ms, and the cursor was gone for the same 200ms.
// So the stage keeps the next document's overlay state registered ahead of time
// (backend.setNextDocumentScript(carrySource(...)), lib/cursor-overlay.mjs): the cursor where it is, and
// the caption that is on screen with its edge. The overlay builder (registered at open()) builds the
// new document already dressed in it, as soon as <body> exists, so its first paint has both, with no
// fade, and a click's ripple, which otherwise never showed on a click that navigates (the page it was
// drawn on paints nothing after that click), continuing from where the old page last showed it
// (lib/cursor-overlay.mjs, THE FROZEN RING). Kept in step at every change
// that a new document could otherwise show stale: the end of a
// cursor move (not every step: a click, the usual navigator, comes at the end of one), and every
// caption fade, set to `none` BEFORE a fade-out and to the caption BEFORE a fade-in, so a document
// built mid-fade shows the caption at most as long as the old one still did. One CDP add (and one
// remove of the previous) per change, not per frame. The re-dress still runs and finds nothing to do,
// or repairs what the carry could not (a page that replaces <body>, a carry that failed).
// A caption that spans a navigation stays ONE timeline range: the re-dress re-shows the same text
// and never touches `openCaption`, so nothing closes the range and nothing opens a new one. The
// range closes at the next caption()/clearCaption() whether or not the caption is on screen then:
// after a navigation the stage did not start, nothing may have re-dressed the page yet, and the
// range used to be overwritten by the next caption() and vanish from the timeline.
//
// DETERMINISM INVARIANT: every timing value here (cursor-move duration, per-character type
// delay, dwell/settle pauses) is a PURE FUNCTION of distance / text length / fixed constants
// below — no Math.random(), no wall-clock-derived jitter. Re-filming the same flow file against
// the same build reproduces the same choreography every time (the SCRIPT is deterministic; the
// resulting mp4's exact bytes still differ run to run, since a video codec's timestamps and the
// real CDP mouse-move round-trip are not — that's expected and not what this invariant claims).
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describeTarget, expectTimeoutMessage, oneOfRejectedMessage, oneOfTimeoutMessage } from './target-wait.mjs';
// The option validators, pinTarget and the expect()/oneOf() decision loop are shared with the
// scenario's test-mode stage, so a call that is legal (and a match that is a match) on film is the
// same in a test. A stage API change lands in both this file and that one.
import { TARGET_TIMEOUT_MS, expectArgs, oneOfArgs, pinTarget, pollTargets as pollInOrder, targetBudget } from './scenario/filmkit-stage.mjs';
import {
  installOverlay,
  ensureOverlay,
  documentToken,
  playClickRipple,
  setCursorPosition,
  setCaptionText,
  setCaptionVisible,
  setCaptionPlacement,
  captionSize,
  carrySource,
  isCaptionVisible,
  CAPTION_EDGE_PX,
  CAPTION_SELECTOR,
} from './cursor-overlay.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT_DIR = join(HERE, '..', 'out');

// ── Pacing constants — the whole determinism story lives here, nowhere else ────────────────
export const VIEWPORT = { width: 1280, height: 720 }; // clean 16:9

const CURSOR_SPEED_PX_PER_MS = 1.3; // ~human mouse-flick speed
const CURSOR_MOVE_MIN_MS = 320;
const CURSOR_MOVE_MAX_MS = 1500;
export const CURSOR_STEP_MS = 40; // ~25 intermediate DOM positions/sec while moving (film-web's capture-rate target)
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

// THE REVEAL's pace on film (lib/scenario/filmkit-stage.mjs): a scroll to a target takes
// 350ms + 0.4ms per pixel, clamped to 450..1100ms, eased like the cursor. 450ms is the shortest
// scroll that reads as a scroll rather than a cut at 25fps (~11 frames); 1100ms caps a long page.
const SCROLL_PACE = { baseMs: 350, msPerPx: 0.4, minMs: 450, maxMs: 1100 };
// What the caption must keep clear of (THE CAPTION NEVER COVERS THE TARGET): the target's box, cut
// down to at most 240x120 around its center (a big card only needs its middle in view), and never
// smaller than 64x64 around it (the click ring's full size). The cursor alone is its tip +-32px.
const CLEAR_HALF_MIN_PX = 32;
const CLEAR_HALF_MAX_W_PX = 120;
const CLEAR_HALF_MAX_H_PX = 60;
const CAPTION_CLEAR_GAP_PX = 8;

const SETTLE_MS_START = 700; // beat after open() (on the opening frame) or goto() lands, before anything moves
export const SETTLE_MS_END = 1000; // beat before closing, so playback doesn't feel clipped

// TARGET_TIMEOUT_MS (10s, one auto-wait budget shared by click/point/type/waitFor/expect/oneOf) and
// PROBE_INTERVAL_MS (expect()/oneOf()'s 100ms poll period) live in lib/scenario/filmkit-stage.mjs,
// shared with test mode.
const SYNC_DURING_WAIT_MS = 1000; // how often a long expect()/oneOf() checks for a document the app replaced
const NAV_READY_TIMEOUT_MS = 20000; // how long a document gets to finish loading after it commits
const REDRESS_RETRY_MS = 50; // restoreOverlay's retry period while the new document has no <body> yet
const SYNC_DURING_PAUSE_MS = 200; // how often a pause() checks for a document a late navigation replaced

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Set up the stage on an already-launched backend whose recording has already started
 * (recording begins BEFORE any navigation, on a parked blank tab; open() marks where the footage
 * starts once the page is loaded and dressed, so the video opens on that, not on the tab or on the
 * page half drawn), and return the director API a flow file drives.
 *
 * @param {object} o
 * @param {object} o.backend one of lib/backends/*.mjs, already `launch()`ed and recording
 * @param {{width: number, height: number}} [o.viewport] recording size (default 1280x720)
 * @param {boolean} [o.ripple] draw the click ripple (default true). Off is for a flow that films
 *   an app which draws its own press feedback and would end up with two rings.
 * @param {boolean} [o.captions] draw captions (default true). false films every caption hold with
 *   nothing drawn (header, NO CAPTIONS): film-web's --no-captions.
 */
export function createStage({ backend, viewport = VIEWPORT, ripple = true, captions = true } = {}) {
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
  // ── Outcomes: one record per oneOf(), same clock, same rebase, never mixed into `timeline`
  // (header, THE OUTCOMES LOG). A record is pushed whole when its wait ends, so there is no open
  // range to close on abort.
  /** @type {Array<{name: string, outcome: string|null, options: Record<string, string>, accept: string[],
   *   filmAccept: string[], start: number, end: number}>} */
  const outcomes = [];
  // ── Motion: one record per cursor move, { start, end, plannedMs, steps }, same clock, same rebase,
  // never in `timeline` either. It is the camera's yardstick for its own capture rate (film-web.mjs,
  // THE CAPTURE-RATE CHECK): while the cursor moves, the page changes every CURSOR_STEP_MS by
  // construction, so the frames that arrived inside these ranges say how well capture kept up,
  // whatever the app on screen does.
  // `distancePx` is how far the cursor went: a move to where it already is (a click() right after a
  // point() at the same target) paints nothing, so it is no yardstick and film-web leaves it out.
  /** @type {Array<{start: number, end: number, plannedMs: number, steps: number, distancePx: number}>} */
  const motion = [];
  let openCaption = null;
  // Which edge the caption sits on, 'bottom' or 'top' (THE CAPTION NEVER COVERS THE TARGET). DOM
  // cannot carry it across a navigation, so it lives here and restoreOverlay re-applies it.
  let captionAt = 'bottom';
  // THE CARRY-OVER: the caption the NEXT document is built showing ({ text, placement } or null), kept
  // in step with what is on screen by carry(); the cursor half is `cursorPos`.
  let carriedCaption = null;
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

  // THE CARRY-OVER (header, NAVIGATION AND THE OVERLAY): hand the next document the overlay as it is
  // now. Best effort: a carry that fails leaves the next document to the re-dress, as before.
  async function carry(ripple = null) {
    await backend.setNextDocumentScript(carrySource({ cursor: cursorPos, caption: captions ? carriedCaption : null, ripple })).catch(() => {});
  }
  async function carryCaption(caption) {
    carriedCaption = caption;
    if (captions) await carry();
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
    const start = now();
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
    motion.push({ start, end: now(), plannedMs: Math.round(duration), steps, distancePx: Math.round(distance * 10) / 10 });
    cursorPos = { x, y };
    if (distance > 0) await carry();
  }

  // The per-call budget: lib/scenario/filmkit-stage.mjs's targetBudget (a finite number > 0; a
  // string or other non-object where `{ timeoutMs }` belongs is refused by name).

  // THE REVEAL on film: animated at SCROLL_PACE, and clear of the caption wherever it sits. With no
  // caption drawn there is nothing to avoid; the bottom band stays (header, NO CAPTIONS).
  const AVOID = captions ? [CAPTION_SELECTOR] : [];
  const REVEAL = { pace: SCROLL_PACE, avoid: AVOID };

  // The auto-wait every targeted verb shares: wait, reveal, then make sure the caption is not on it.
  async function revealBox(target, timeoutMs) {
    requireOpen();
    await syncDocument();
    const box = await backend.resolveBox(target, { timeoutMs, reveal: REVEAL });
    await keepCaptionClear(clearRegion(box));
    return box;
  }

  async function centerOf(target, timeoutMs = TARGET_TIMEOUT_MS) {
    const box = await revealBox(target, timeoutMs);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  // ── THE CAPTION NEVER COVERS THE TARGET (header) ──
  function clearRegion(box) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const hw = clamp(box.width / 2, CLEAR_HALF_MIN_PX, CLEAR_HALF_MAX_W_PX);
    const hh = clamp(box.height / 2, CLEAR_HALF_MIN_PX, CLEAR_HALF_MAX_H_PX);
    return { left: cx - hw, right: cx + hw, top: cy - hh, bottom: cy + hh };
  }
  const cursorRegion = () => clearRegion({ x: cursorPos.x, y: cursorPos.y, width: 0, height: 0 });

  function captionRect(placement, size) {
    const left = (size.vw - size.width) / 2;
    const top = placement === 'top' ? CAPTION_EDGE_PX : size.vh - CAPTION_EDGE_PX - size.height;
    return { left, right: left + size.width, top, bottom: top + size.height };
  }

  const overlaps = (a, b) =>
    a.left < b.right + CAPTION_CLEAR_GAP_PX &&
    b.left < a.right + CAPTION_CLEAR_GAP_PX &&
    a.top < b.bottom + CAPTION_CLEAR_GAP_PX &&
    b.top < a.bottom + CAPTION_CLEAR_GAP_PX;

  // Stay where it is unless that covers `region`; move only to an edge that does not.
  function placementFor(region, size, current) {
    if (!overlaps(captionRect(current, size), region)) return current;
    const other = current === 'top' ? 'bottom' : 'top';
    return overlaps(captionRect(other, size), region) ? current : other;
  }

  // A caption that is up and covers what the cursor is about to go to fades out, moves to the other
  // edge, and fades back in, before the cursor moves. Same text, same timeline range.
  async function keepCaptionClear(region) {
    if (!captions || !openCaption) return; // nothing drawn, nothing to dodge (header, NO CAPTIONS)
    const size = await captionSize(backend).catch(() => null);
    if (!size) return;
    const next = placementFor(region, size, captionAt);
    if (next === captionAt) return;
    await carryCaption(null);
    await setCaptionVisible(backend, false);
    await backend.sleep(CAPTION_FADE_MS);
    captionAt = next;
    await setCaptionPlacement(backend, captionAt);
    await carryCaption({ text: openCaption.text, placement: captionAt });
    await setCaptionVisible(backend, true);
    await backend.sleep(CAPTION_FADE_MS);
  }

  // type() clicks and then selects: pinTarget (lib/scenario/filmkit-stage.mjs) makes a
  // `(page) => Locator` target resolve once, so both see the same element.

  // Re-dress a document the stage did not draw on yet: build the overlay if the init script has
  // not (or the page had no <body> when it ran), put the cursor back where the flow left it, and
  // re-show the caption that is still notionally up. Deliberately does NOT touch `openCaption` or
  // the timeline — the caption is the same caption, and its range is the same range.
  //
  // IT CONFIRMS IT DREW. "Ready" can be answered by the document that is LEAVING: MEASURED on the
  // Playwright camera (example.com -> iana.org, 2026-10-06), the token read 180ms after the click came
  // back null (the evaluate met the commit), waitForDocumentReady returned at once (the old document
  // had loaded), and the re-dress ran in the new document before it had a <body>: every call found no
  // element, the new token was recorded as dressed, and the rest of the take had no cursor and no
  // caption. So the cursor is drawn until setCursorPosition says it is there (the overlay is built as
  // soon as a <body> exists), within NAV_READY_TIMEOUT_MS; past that the free detector takes over.
  async function restoreOverlay() {
    const deadline = Date.now() + NAV_READY_TIMEOUT_MS;
    for (;;) {
      await ensureOverlay(backend, { captions }).catch(() => {});
      if (await setCursorPosition(backend, cursorPos.x, cursorPos.y).catch(() => false)) break;
      if (Date.now() >= deadline) break;
      await backend.sleep(REDRESS_RETRY_MS);
    }
    if (captions && openCaption) {
      await setCaptionPlacement(backend, captionAt);
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
  // A hold that re-dresses a document replaced while it runs: a click whose navigation committed after
  // the click's own check (a slow server), or a redirect the app fired. One evaluate per
  // SYNC_DURING_PAUSE_MS, absorbed by the hold; ends on the wall clock, so the hold is not lengthened
  // unless a re-dress has to wait for the new document.
  async function watchfulSleep(ms) {
    const end = Date.now() + ms;
    for (;;) {
      const left = end - Date.now();
      if (left <= 0) return;
      await backend.sleep(Math.min(left, SYNC_DURING_PAUSE_MS));
      if (Date.now() < end) await syncDocument({ force: true });
    }
  }

  async function syncDocument({ force = false } = {}) {
    if (!force && !navSuspect) return false;
    navSuspect = false;
    const token = await documentToken(backend);
    if (token !== null && token === docToken) return false;
    await backend.waitForDocumentReady({ timeoutMs: NAV_READY_TIMEOUT_MS }).catch(() => {});
    await restoreOverlay();
    return true;
  }

  // THE POLL behind expect() and oneOf(): lib/scenario/filmkit-stage.mjs's pollTargets (probe every
  // target in declaration order every PROBE_INTERVAL_MS until one matches or the budget is spent;
  // shared with test mode), plus the camera's own work around it: re-dress a document the app
  // replaced, every SYNC_DURING_WAIT_MS and once on the match, and stop at the next poll after an
  // abort(). Returns { index, last }. No cursor, no scroll, no timeline entry.
  async function pollTargets(targets, { text, timeoutMs }) {
    await syncDocument();
    let nextSync = Date.now() + SYNC_DURING_WAIT_MS;
    return pollInOrder(targets, {
      text,
      timeoutMs,
      probe: (target, opts) => backend.probe(target, opts),
      sleep: (ms) => backend.sleep(ms),
      beforeRound: () => requireOpen(), // an abort() mid-wait ends the loop here rather than polling a closed browser
      betweenRounds: async () => {
        if (Date.now() >= nextSync) {
          await syncDocument({ force: true });
          nextSync = Date.now() + SYNC_DURING_WAIT_MS;
        }
      },
      onMatch: () => syncDocument({ force: true }), // one evaluate; see "a page the app replaced" in the header
    });
  }

  const director = {
    /** 'film': this stage is the camera. A flow can read it to tell filming from a test run; the
     *  test-mode stage (Part 2's scenario adapter) says 'test'. */
    get mode() {
      return 'film';
    },

    /** The backend's raw page handle — escape hatch for anything the director doesn't cover.
     *  Under `--browser playwright` this is the real Playwright `Page` (custom locators,
     *  dialogs, file uploads, waiting on network responses, `frameLocator`). Under
     *  `--browser ego` there is no Playwright object to hand out, so this is a small stand-in
     *  exposing only `evaluate(source)` (Playwright's semantics: an expression string, or a
     *  function and its one argument; lib/backends/ego.mjs, STAGE.PAGE.EVALUATE),
     *  `waitForSelector(css, { timeoutMs })` and `goto(url)`. Flows that only used
     *  `stage.page.evaluate(...)` keep working on both. */
    get page() {
      return backend.page;
    },

    /** The authored-hold timeline, in the backend's recording-clock units. Read after finish(). */
    get timeline() {
      return timeline;
    },

    /** The oneOf() outcomes log (header, THE OUTCOMES LOG), in the backend's recording-clock units
     *  until finish() rebases its copy. Complete records only, so a checkpoint can copy it as is. */
    get outcomes() {
      return outcomes;
    },

    /** A copy of the timeline as it stands RIGHT NOW, with a caption that is still up counted as
     *  ending now (unlike `timeline`, which only gains a caption when its range closes). For
     *  checkpoints: a process killed mid-take leaves this as its record of what was authored. */
    snapshotTimeline() {
      const copy = [...timeline];
      if (openCaption) copy.push({ kind: 'caption', start: openCaption.start, end: now(), text: openCaption.text });
      return copy;
    },

    /** A copy of the cursor's move ranges so far, in recording-clock units (complete moves only: a
     *  range is pushed when its move ends). For a take that does not reach finish(): the salvage
     *  (lib/workdir.mjs) and the ego checkpoint, so film-web's capture-rate check judges a failed or
     *  interrupted take by the same yardstick as a finished one. Camera-only, like snapshotTimeline. */
    snapshotMotion() {
      return [...motion];
    },

    /** Load the app under film: `urlOrPath` is an http(s) URL, a `file:` URL, or a local path.
     *  A relative path resolves against the serve root (the flow file's directory unless
     *  --serve-root), and local files are served over http by each backend (ego: a loopback static
     *  server; playwright and test mode: http://filmkit.localhost via page.route); outside the root
     *  is refused. Waits for `load`, optionally for `{ readySelector }` to appear, injects the
     *  overlay, then holds a settle beat. Call once at the start of a flow. The take's first frame is
     *  the page at that point, loaded and dressed (lib/frames.mjs, THE OPENING FRAME): the loading
     *  before it is setup and is not filmed.
     *  `{ cursorAt: target }` is where the cursor STARTS: the target's center, placed there without
     *  animation (and the real mouse with it, so a hover state matches) before the settle beat, so the
     *  opening frame shows it somewhere the flow chose. The target is waited for like every other one,
     *  within `timeoutMs`. Without it the cursor starts at the viewport center, which on a centered
     *  app is wherever the layout happens to put something. */
    async open(urlOrPath, { readySelector, timeoutMs = 20000, settleMs = SETTLE_MS_START, cursorAt } = {}) {
      if (state === 'ready') throw new Error('stage.open: already opened — use stage.goto(url) to navigate again');
      if (state === 'closed') throw new Error('stage.open: this stage is closed');
      const url = await backend.resolveOpenUrl(urlOrPath);
      await backend.goto(url, { timeoutMs });
      if (readySelector) await backend.waitForSelector(readySelector, { timeoutMs });
      state = 'ready';
      // Registers the overlay for every FUTURE document too — the one call that makes navigation
      // survivable at all. Only open() does this; goto() and syncDocument() re-dress, never
      // re-register.
      await installOverlay(backend, { captions });
      docToken = await documentToken(backend);
      navSuspect = false;
      if (cursorAt !== undefined) {
        // Placed, not animated: the opening frame is where the flow starts, not a scroll to it.
        const box = await backend.resolveBox(cursorAt, { timeoutMs, reveal: { avoid: AVOID } });
        cursorPos = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await backend.mouseMove(cursorPos.x, cursorPos.y);
      }
      await setCursorPosition(backend, cursorPos.x, cursorPos.y);
      await carry();
      // THE OPENING FRAME (lib/frames.mjs): the page is loaded and dressed, so this is the take's first
      // frame. Everything captured so far (the parked blank tab, this page's progressive render, the
      // overlay going up) is setup and is cut. Before the settle, so the opening beat is on film.
      await backend.markOpening();
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
     *  only needed when the thing you are waiting for is not the thing you are about to act on.
     *  `{ timeoutMs }` (default 10000) is the wait budget, as on click()/point()/type(). */
    async waitFor(target, options) {
      requireOpen();
      const timeoutMs = targetBudget(options, 'waitFor');
      await revealBox(target, timeoutMs);
    },

    /** A CHECKPOINT: wait until `target` is visible — and, with `{ text }`, until its
     *  whitespace-collapsed textContent contains `text` (case-sensitive) — without moving the cursor
     *  or scrolling the page. `{ timeoutMs }` (default 10000) is the budget; running out throws,
     *  which fails the take. Returns nothing. */
    async expect(target, options = {}) {
      requireOpen();
      const { timeoutMs, text } = expectArgs(target, options);
      const { index, last } = await pollTargets([target], { text, timeoutMs });
      if (index === null) {
        throw new Error(expectTimeoutMessage(describeTarget(target), timeoutMs, last[0], text, await backend.currentUrl()));
      }
    },

    /** A BRANCH POINT: wait until one of `targets` ({ outcome: target, … }) is visible and return
     *  its outcome name; a tie goes to declaration order. Options: `name` (required, names the
     *  branch point in the sidecar and in errors), `timeoutMs` (default 10000), `accept` (default:
     *  every outcome) and `filmAccept` (default: `accept`; a subset of it). An outcome outside
     *  filmAccept, or a timeout, throws: the take fails as a retake. Every call is logged in
     *  `outcomes`. Branch on the returned name in plain JS. */
    async oneOf(targets, options) {
      requireOpen();
      const { keys, name, timeoutMs, accept, filmAccept } = oneOfArgs(targets, options);

      const start = now();
      const { index, last } = await pollTargets(
        keys.map((k) => targets[k]),
        { timeoutMs },
      );
      const outcome = index === null ? null : keys[index];
      outcomes.push({
        name,
        outcome,
        options: Object.fromEntries(keys.map((k) => [k, describeTarget(targets[k])])),
        accept: [...accept],
        filmAccept: [...filmAccept],
        start,
        end: now(),
      });
      if (outcome === null) {
        const rows = keys.map((key, i) => ({ key, target: targets[key], probe: last[i] }));
        throw new Error(oneOfTimeoutMessage(name, timeoutMs, rows, await backend.currentUrl()));
      }
      const refusedBy = !accept.includes(outcome) ? 'accept' : !filmAccept.includes(outcome) ? 'filmAccept' : null;
      if (refusedBy) {
        // Hold before failing, so the retake's video SHOWS what the app did. The probe reads the
        // DOM, which changes before the compositor delivers the frame that paints it; throwing at
        // once halts capture first, and MEASURED on ego the failed take ended on "Generating…",
        // the build error never on film. Not a timeline entry; `end` above is the decision.
        await backend.sleep(SETTLE_MS_END);
        const allowed = refusedBy === 'accept' ? accept : filmAccept;
        throw new Error(oneOfRejectedMessage(name, outcome, targets[outcome], refusedBy, allowed, 'film'));
      }
      return outcome;
    },

    /** Animate the cursor to `target`'s center, dwell, show press feedback, then perform a REAL
     *  click at those page-viewport coordinates. `{ timeoutMs }` (default 10000) is how long to
     *  wait for the target to appear and become visible — raise it for a target that only shows up
     *  after something slow (a generation, a build). */
    async click(target, options) {
      const { x, y } = await centerOf(target, targetBudget(options, 'click'));
      await moveCursorTo(x, y);
      await setCursorPosition(backend, x, y, true);
      await backend.sleep(PRESS_DWELL_MS);
      // The ring goes up IMMEDIATELY BEFORE the input dispatch, not after: the two land within
      // one round trip of each other, so the frame where the app reacts is the frame that already
      // has the ripple on it. Ordered the other way the ring trails the reaction, which reads as
      // "something happened, then it was clicked". point() never calls this — a ripple with no
      // click behind it is a lie about what the take shows.
      // The ring is carried too (THE CARRY-OVER): a click that navigates never shows it on the page it
      // was drawn on. Registered first, so the click itself stays one round trip after the ring.
      if (ripple) {
        await carry({ x, y, at: Date.now() });
        await playClickRipple(backend, x, y);
      }
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
     *  via caption(), without pretending it was pressed. `{ timeoutMs }` as on click(). */
    async point(target, options) {
      const { x, y } = await centerOf(target, targetBudget(options, 'point'));
      await moveCursorTo(x, y);
    },

    /** Click into `target` (same cursor animation as click()), select any existing text, then
     *  type `text` one character at a time with a deterministic per-character delay.
     *  `{ timeoutMs }` as on click(): it bounds the wait for the field, not the typing. */
    async type(target, text, options) {
      requireOpen();
      const timeoutMs = targetBudget(options, 'type');
      const pinned = pinTarget(target);
      await director.click(pinned, { timeoutMs });
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

    /** Show caption text in the bottom overlay bar, cross-fading out any previous caption first.
     *  With `captions: false` nothing is drawn and every hold is kept (header, NO CAPTIONS). */
    async caption(text) {
      requireOpen();
      await syncDocument();
      if (captions ? await isCaptionVisible(backend) : openCaption !== null) {
        await carryCaption(null);
        if (captions) await setCaptionVisible(backend, false);
        await backend.sleep(CAPTION_FADE_MS);
      }
      // Close the previous range whether or not its caption was on screen. It is not on screen when
      // a navigation the stage did not start (a JS redirect during a pause) replaced the document and
      // nothing has re-dressed it yet: the range used to be overwritten here and vanish from the
      // timeline (reproduced on --browser playwright). It ends now, as it would have had a cursor
      // move re-dressed the page first, which re-shows the caption (header, NAVIGATION AND THE OVERLAY).
      closeOpenCaption(now());
      if (captions) {
        await setCaptionText(backend, text);
        // A new caption starts at the bottom, unless that would cover the cursor (a flow that clicked
        // something low and now narrates it); it is still faded out, so this move is never seen.
        const size = await captionSize(backend).catch(() => null);
        captionAt = size ? placementFor(cursorRegion(), size, 'bottom') : 'bottom';
        await setCaptionPlacement(backend, captionAt);
      }
      await carryCaption({ text, placement: captionAt });
      const start = now();
      if (captions) await setCaptionVisible(backend, true);
      await backend.sleep(CAPTION_FADE_MS);
      openCaption = { start, text };
    },

    /** Fade the caption bar out (with `captions: false`, hold the fade's length). */
    async clearCaption() {
      requireOpen();
      await syncDocument();
      await carryCaption(null);
      if (captions) await setCaptionVisible(backend, false);
      await backend.sleep(CAPTION_FADE_MS);
      closeOpenCaption(now());
    },

    /** A plain beat — `ms` wall-clock milliseconds, nothing derived. Watches for a replaced
     *  document while it holds (watchfulSleep). */
    async pause(ms) {
      requireOpen();
      const start = now();
      await watchfulSleep(ms);
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
     *  timeline, the outcomes log and the cursor's motion ranges, all rebased to the recording's own
     *  zero point (`t0`). */
    async finish() {
      requireOpen();
      await watchfulSleep(SETTLE_MS_END);
      closeOpenCaption(now());
      const recording = await backend.stopRecording();
      state = 'closed';
      await backend.close().catch(() => {});
      const t0 = recording.t0 ?? 0;
      // Rebase to the recording's zero so seconds are seconds INTO the video, and sort by start —
      // timeline entries are appended when a range CLOSES, which is not the order a reader (or a
      // future tighten pass) wants them in. The outcomes log gets the identical treatment
      // (lib/workdir.mjs's rebaseTimeline is the same rule for a salvaged take).
      const rebase = (list) =>
        list
          .map((e) => ({
            ...e,
            start: Math.max(0, e.start - t0),
            end: Math.max(0, e.end - t0),
          }))
          .sort((a, b) => a.start - b.start || a.end - b.end);
      return {
        recording,
        clock: backend.clock,
        endSettleSec: SETTLE_MS_END / 1000,
        timeline: rebase(timeline),
        outcomes: rebase(outcomes),
        motion: rebase(motion),
      };
    },
  };

  return director;
}
