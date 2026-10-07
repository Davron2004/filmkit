// ─────────────────────────────────────────────────────────────────────────────
// lib/backends/playwright.mjs — the headless filming backend: Playwright's Chromium, recorded
// over CDP `Page.startScreencast` — the SAME capture the ego backend uses — into the shared frame
// sink (lib/frames.mjs). film-web.mjs assembles the frames with lib/assemble.mjs's
// assembleFromFrames, so both backends produce a take by one path and one clock.
//
// WHY NOT `recordVideo` (which this backend used until 2026-09-28). Playwright's recorder ended
// where its frames ended, and roughly one static-page take in three came out as a 0.96s WEBM of a
// blank page instead of the 6-14s that was filmed (24 packets, the first a 1.5 KB keyframe; bare
// Playwright, no filmkit code, load-dependent). No error, no warning: a short video and captions
// pointing at seconds that do not exist. Evidence and the sink's contract are in lib/frames.mjs.
// A screencast sends a frame only when the picture changes, so a static page is one frame and a
// held tail (assembleFromFrames' `tailSec`); that is correct, and is how ego has always worked.
//
// TARGETS: a CSS selector string, a Playwright `Locator`, or `(page) => Locator` for compound
// queries (text filters, `frameLocator` for apps that render inside iframes). resolveBox is the
// auto-wait an action uses (waits, brings the target to a comfortable position by THE REVEAL in
// lib/scenario/filmkit-stage.mjs, throws); probe is the one non-scrolling,
// non-throwing look the stage's expect()/oneOf() poll with, so the page never moves mid-wait.
// Both use Playwright's visibility rule, which differs from ego's in one known place: an
// `opacity: 0` element is visible to Playwright and not to ego.
//
// LOCAL FILES (since the scenario export; before it, a path was resolved against the CWD and opened
// over file://). A relative open()/goto() path resolves against the SERVE ROOT, which is the flow
// file's directory unless --serve-root says otherwise, as under ego; a path or `file:` URL is served
// as http://filmkit.localhost/<path from the root> through page.route (?query and #hash kept), and a
// path outside the root is refused before navigating. http semantics, as ego's loopback server
// gives (ES modules, same-origin fetch, a secure context), and the same origin a replayed scenario
// uses. A navigation answered 4xx/5xx fails the flow instead of filming an error page.
//
// CLOCK: 'frame' — the same as ego. `now()` is `Date.now()/1000` and every frame carries the
// compositor's own epoch timestamp (measured: first frame 0.03-0.05s after startScreencast, same
// wall clock), so the timeline is exact and film-web needs no drift margin for it. This changed
// from 'approximate' when the recorder changed; the sidecar's `clock` and `plannedDurationSec`
// say so.
//
// SIGNALS: this backend launches Chromium with Playwright's own SIGINT/SIGTERM/SIGHUP handlers
// switched OFF. They default to on, and what they do is close the browser and leave the flow to
// fail with "Target page, context or browser has been closed" — the interrupt disappears into an
// ordinary failure. film-web.mjs owns what a signal means (see its INTERRUPTION section) and
// reaches this file through stage.abort() -> close(). If the process dies some other way,
// Playwright's exit hook (not switched off) still kills the browser.
//
// PARTIAL TAKES: partialRecording() is what film-web salvages after a flow failure or an
// interrupt: capture is halted, every accepted frame is on disk, and the descriptor comes back
// without the validation stopRecording() applies. close() never deletes frames — they live in the
// work directory film-web owns and removes once the take is assembled.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  clickAt,
  localRoot,
  navigate,
  probeTarget,
  resolveOpenTarget,
  resolveVisibleBox,
  routeLocalFiles,
  selectTextIn,
  typeChar as typeCharOn,
  waitForCss,
} from '../scenario/filmkit-stage.mjs';
import { captureFinalShots, createFrameSink, cutOpening, probeLiveness } from '../frames.mjs';

const FIRST_FRAME_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 1000; // halt() below; a healthy Page.stopScreencast answers in a few ms

// ── Targets, click, type, navigation and local files: lib/scenario/filmkit-stage.mjs ─────────
// Every page-level operation this backend performs on a target is imported from the test-mode
// stage, which the scenario export copies next to every spec. `--browser playwright` and a replayed
// scenario therefore run the SAME functions: what counts as ready (resolveVisibleBox), what one
// non-scrolling look sees (probeTarget), where a click lands (the box center, clickAt), how a field
// is typed into (selectTextIn, then typeChar per character, never `fill`), and how a local file is
// served (routeLocalFiles). Change them there.

/**
 * @param {object} o
 * @param {{width:number,height:number}} o.viewport
 * @param {string} o.workDir where frames/ is written (film-web.mjs creates and owns it)
 * @param {string} o.serveRoot the directory local files resolve against and are served from (see
 *   LOCAL FILES above); film-web passes the flow file's directory unless --serve-root says otherwise
 */
export function createPlaywrightBackend({ viewport, workDir, serveRoot }) {
  // Required, not defaulted: only the caller knows the flow file, and "the flow's directory" is the
  // rule (film-web passes it, or --serve-root). A silent default here (the cwd, as before) would
  // film a different file than ego and the scenario serve.
  if (!serveRoot) throw new Error('createPlaywrightBackend: serveRoot is required (the flow file\'s directory, or --serve-root)');
  const framesDir = join(workDir, 'frames');
  const root = localRoot(serveRoot); // a REAL path: see realPathLoose in lib/scenario/filmkit-stage.mjs
  // The last local file resolveOpenUrl() turned into a URL, so goto() can name the PATH (what the
  // flow wrote) if the file server refuses it.
  let lastLocal = null;
  const sink = createFrameSink({ framesDir, viewport });
  let browser = null;
  let context = null;
  let page = null;
  let cdp = null;
  let recStartT = 0;
  let stopT = 0;
  let recording = false;
  let haltPromise = null;
  let closed = false;
  let launching = null;
  let onFrame = null; // the screencastFrame listener, removed on halt
  let nextDocumentScript = null; // setNextDocumentScript's current registration
  let pageDomainEnabled = null; // Page.enable on `cdp`, sent once, by the first setNextDocumentScript

  function requirePage() {
    if (!page) throw new Error('playwright backend: launch() has not run yet');
    return page;
  }

  // Stop capture and get every accepted frame onto disk. MEMOIZED: every caller (stopRecording,
  // partialRecording, close, the salvage path) awaits the SAME stop. The frame listener is removed
  // once capture has stopped, so a straggler event cannot land after the sink is sealed. stopT is
  // the moment CAPTURE ended (it becomes the last frame's on-screen duration), taken before the
  // flush. The stop is BOUNDED by STOP_TIMEOUT_MS: MEASURED (Chromium, Playwright 1.60), while a
  // navigation is still connecting, Page.stopScreencast does not answer until the connect gives up. An
  // open() of an unroutable address with timeoutMs 2500 failed at 2.5s, the stop then took 72.6s (the
  // OS connect timeout), and the salvaged take was 75s of the blank tab. Past the bound, capture is
  // treated as stopped: the listener goes, so nothing more is recorded either way.
  function halt() {
    haltPromise ??= (async () => {
      sink.beginStop(); // frames still in the pipe are kept, but no longer acked
      if (recording && cdp) {
        let timer;
        await Promise.race([
          cdp.send('Page.stopScreencast').catch(() => {}),
          new Promise((r) => (timer = setTimeout(r, STOP_TIMEOUT_MS))),
        ]);
        clearTimeout(timer);
      }
      stopT = Date.now() / 1000;
      if (onFrame && cdp) cdp.off('Page.screencastFrame', onFrame);
      onFrame = null;
      await sink.flush();
      sink.seal();
      recording = false;
    })();
    return haltPromise;
  }

  function descriptor(extra = {}) {
    return {
      kind: 'frames',
      dir: framesDir,
      frames: sink.frames,
      t0: sink.frames[0].t,
      stopT: sink.probeSince !== null ? Math.min(stopT, sink.probeSince) : stopT, // the probe is not footage (lib/frames.mjs)
      firstFrameLagSec: sink.firstSeenT - recStartT,
      // Capture health, judged by film-web: acks that failed while live, and the reference image
      // for the final-frame stall check (see captureFinalShots in lib/frames.mjs).
      ackFailures: sink.ackFailures,
      opening: sink.opening, // how the opening cut went (lib/frames.mjs, THE OPENING FRAME)
      finalShot: null,
      finalShot2: null,
      finalShotError: null,
      liveness: null,
      ...extra,
    };
  }

  async function doLaunch() {
    try {
      browser = await chromium.launch({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    } catch (err) {
      if (/Executable doesn't exist|looks like Playwright was just installed/.test(String(err))) {
        throw new Error(
          "Playwright's Chromium is not installed. Run `npx playwright install chromium` once " +
            '(inside this repo, with its node_modules present), then retry.',
        );
      }
      throw err;
    }
    // bypassCSP: true — this is a FILMING layer, not a security surface: it needs to inject a
    // cursor + caption overlay into the page via evaluate/DOM APIs. Pages that ship a CSP
    // would otherwise block the overlay injection. This only affects THIS browser instance that
    // films the demo; it never touches what a real user's browser enforces.
    context = await browser.newContext({ viewport, bypassCSP: true });
    page = await context.newPage();
    await routeLocalFiles(page, root);
    cdp = await context.newCDPSession(page);
    await mkdir(framesDir, { recursive: true });
  }

  return {
    clock: 'frame',

    get page() {
      return requirePage();
    },

    launch() {
      launching = doLaunch();
      return launching;
    },

    /** LOCAL FILES (header): a path (relative to the serve root) or a `file:` URL is served over
     *  http from the serve root, as the scenario's test stage serves it; outside the root is refused
     *  here, before anything navigates. An http(s) URL passes through. */
    async resolveOpenUrl(urlOrPath) {
      const { url, local } = resolveOpenTarget(urlOrPath, root);
      lastLocal = local ? { url, local } : null;
      return url;
    },

    /** Navigate, wait for `load`, and refuse a 4xx/5xx (shared `navigate`). */
    async goto(url, { timeoutMs = 20000 } = {}) {
      const local = lastLocal?.url === url ? lastLocal.local : null;
      await navigate(requirePage(), url, { timeoutMs, local });
    },

    async waitForSelector(css, { timeoutMs = 20000 } = {}) {
      await waitForCss(requirePage(), css, { timeoutMs });
    },

    async evaluate(source) {
      return requirePage().evaluate(source);
    },

    async addInitScript(source) {
      await requirePage().addInitScript({ content: source });
    },

    /** Like addInitScript, but REPLACES the script this method registered last (lib/stage.mjs, THE
     *  CARRY-OVER): CDP's own add/remove pair on this page's session, because a Playwright init
     *  script cannot be taken back. The new one is added before the old one goes, so a document
     *  created in between runs at least one of them. */
    async setNextDocumentScript(source) {
      if (!cdp) throw new Error('playwright backend: launch() has not run yet');
      // MEASURED (Playwright 1.60): a script added on this session never runs until the Page domain is
      // enabled ON THIS SESSION (Playwright's own session having it enabled is not enough).
      pageDomainEnabled ??= cdp.send('Page.enable');
      await pageDomainEnabled;
      const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
      const old = nextDocumentScript;
      nextDocumentScript = identifier;
      if (old) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: old });
    },

    async mouseMove(x, y) {
      await requirePage().mouse.move(x, y);
    },

    async click(x, y) {
      await clickAt(requirePage(), x, y);
    },

    async typeChar(ch) {
      await typeCharOn(requirePage(), ch);
    },

    async selectAllIn(target) {
      await selectTextIn(requirePage(), target);
    },

    /** The auto-wait: the shared resolveVisibleBox. `options` is { timeoutMs, reveal }. */
    async resolveBox(target, options) {
      return resolveVisibleBox(requirePage(), target, options);
    },

    /** One non-scrolling, non-throwing look: the shared probeTarget. Before launch() there is no page
     *  to look at, which is an answer too ("not there"), not an exception. */
    async probe(target, options) {
      if (!page) return { found: false, visible: false, text: null, matched: false, error: 'no page yet', fatal: false };
      return probeTarget(page, target, options);
    },

    currentUrl() {
      return requirePage().url();
    },

    async waitForDocumentReady({ timeoutMs = 20000 } = {}) {
      await requirePage().waitForLoadState('load', { timeout: timeoutMs });
    },

    async sleep(ms) {
      await requirePage().waitForTimeout(ms);
    },

    /** Epoch seconds — the same wall clock the screencast's frame timestamps use. */
    now() {
      return Date.now() / 1000;
    },

    async startRecording() {
      recStartT = Date.now() / 1000;
      onFrame = (ev) => {
        sink.accept(ev, (sessionId) => cdp.send('Page.screencastFrameAck', { sessionId }));
      };
      cdp.on('Page.screencastFrame', onFrame);
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 90,
        maxWidth: viewport.width,
        maxHeight: viewport.height,
        everyNthFrame: 1,
      });
      recording = true;
      // BLOCK UNTIL FRAME 1, AND CHECK ITS SIZE — the same gate the ego backend has.
      const deadline = Date.now() + FIRST_FRAME_TIMEOUT_MS;
      while (!sink.frames.length) {
        if (Date.now() > deadline) {
          throw new Error(`screencast produced no frame within ${FIRST_FRAME_TIMEOUT_MS}ms of starting`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      const sizeError = sink.firstFrameSizeError();
      if (sizeError) throw new Error(sizeError);
    },

    /** open() has dressed the page: it is the take's first frame, and every frame before it is setup
     *  (lib/frames.mjs, THE OPENING FRAME). Frames arrive as CDP events on this session, so the sink's
     *  own in-flight wait is all the draining there is. */
    async markOpening() {
      return cutOpening({ sink, evaluate: (src) => requirePage().evaluate(src) });
    },

    async stopRecording() {
      // BEFORE halt, while capture is live: the stall check's liveness probe (lib/frames.mjs).
      const liveness = recording ? await probeLiveness({ sink, evaluate: (src) => requirePage().evaluate(src) }) : null;
      await halt();
      sink.validate();
      // AFTER halt: capture has stopped, so the page's state now is the state the last delivered
      // frame ought to show. The screenshot is the stall check's reference (film-web compares).
      const shot = await captureFinalShots((m, p) => cdp.send(m, p), workDir);
      return descriptor({ ...shot, liveness });
    },

    /** What was captured so far, whatever state the take is in. See PARTIAL TAKES above. */
    async partialRecording() {
      await halt();
      return sink.frames.length ? descriptor() : null;
    },

    /** Teardown. Idempotent. Leaves the frames on disk: they are the take (or its salvage). */
    async close() {
      if (closed) return;
      closed = true;
      await launching?.catch(() => {}); // a close that beats launch() waits for it, then closes
      await halt();
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    },
  };
}
