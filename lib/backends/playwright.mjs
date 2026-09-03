// ─────────────────────────────────────────────────────────────────────────────
// lib/backends/playwright.mjs — the original filming backend: a headless Playwright
// Chromium with `recordVideo`, producing a .webm that film-web.mjs transcodes to .mp4.
//
// This backend is deliberately unchanged in behaviour from the pre-backend-seam version of
// lib/stage.mjs: same launch options, same recordVideo config, same bypassCSP, same
// mouse/keyboard calls in the same order. `--browser playwright` must keep filming exactly
// what it filmed before the ego backend existed.
//
// TARGETS: a CSS selector string, a Playwright `Locator`, or `(page) => Locator` for compound
// queries (text filters, `frameLocator` for apps that render inside iframes).
//
// CLOCK: 'approximate'. There are no per-frame timestamps to read here — Playwright hands
// back a finished .webm and nothing else — so `now()` is wall time since the recording context
// was created, which is when recordVideo starts. Good to a few tens of ms at the head and
// drifts by whatever the encoder does; fine for locating a caption in the video, not exact.
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { rm } from 'node:fs/promises';
import { describeTarget, targetTimeoutMessage } from '../target-wait.mjs';

export function createPlaywrightBackend({ viewport, outDir }) {
  let browser = null;
  let context = null;
  let page = null;
  let startedAt = 0;
  let video = null;
  let closed = false;

  function requirePage() {
    if (!page) throw new Error('playwright backend: launch() has not run yet');
    return page;
  }

  // `target` is a CSS selector (resolved against the top page), a Playwright Locator, or a
  // `(page) => Locator` function for compound queries.
  function resolveLocator(target) {
    if (typeof target === 'function') return target(requirePage());
    if (typeof target === 'string') return requirePage().locator(target).first();
    return target; // already a Locator
  }

  return {
    clock: 'approximate',

    get page() {
      return requirePage();
    },

    async launch() {
      try {
        browser = await chromium.launch();
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
      context = await browser.newContext({
        viewport,
        recordVideo: { dir: outDir, size: viewport },
        bypassCSP: true,
      });
      startedAt = Date.now(); // recordVideo begins with the context
      page = await context.newPage();
    },

    /** Local paths open straight off disk here — a headless throwaway browser has no reason to
     *  distrust file://, and this is what the pre-backend-seam stage did. */
    async resolveOpenUrl(urlOrPath) {
      if (typeof urlOrPath !== 'string') throw new Error('stage.open: expected a URL or path string');
      if (/^https?:\/\//.test(urlOrPath) || urlOrPath.startsWith('file:')) return urlOrPath;
      return pathToFileURL(urlOrPath).href;
    },

    async goto(url, { timeoutMs = 20000 } = {}) {
      await requirePage().goto(url, { waitUntil: 'load', timeout: timeoutMs });
    },

    async waitForSelector(css, { timeoutMs = 20000 } = {}) {
      await requirePage().waitForSelector(css, { timeout: timeoutMs });
    },

    async evaluate(source) {
      return requirePage().evaluate(source);
    },

    async addInitScript(source) {
      await requirePage().addInitScript({ content: source });
    },

    async mouseMove(x, y) {
      await requirePage().mouse.move(x, y);
    },

    async click(x, y) {
      await requirePage().mouse.click(x, y);
    },

    async typeChar(ch) {
      await requirePage().keyboard.type(ch);
    },

    async selectAllIn(target) {
      await resolveLocator(target)
        .selectText()
        .catch(() => {});
    },

    /** THE AUTO-WAIT. `waitFor({state:'visible'})` is Playwright's own definition of the same two
     *  conditions the ego backend polls for by hand — attached to the DOM, and laid out with a
     *  non-empty box (which is exactly what excludes display:none and zero-size). Its timeout is
     *  pinned to the stage's budget rather than Playwright's 30s default, and its message is
     *  replaced: "Timeout 10000ms exceeded" does not tell you which page you were on. */
    async resolveBox(target, { timeoutMs = 10000 } = {}) {
      const locator = resolveLocator(target);
      const name = describeTarget(target);
      try {
        await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      } catch (err) {
        const attached = await locator.count().then((n) => n > 0).catch(() => false);
        throw new Error(targetTimeoutMessage(name, timeoutMs, attached, requirePage().url()));
      }
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      const box = await locator.boundingBox();
      if (!box) throw new Error(targetTimeoutMessage(name, timeoutMs, true, requirePage().url()));
      return box;
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

    now() {
      return (Date.now() - startedAt) / 1000;
    },

    /** Recording already started with the context; this only exists to satisfy the interface. */
    async startRecording() {},

    /** The .webm path is only knowable after the context closes (that is what finalizes it), so
     *  stopping the recording and tearing down the context are the same operation here. */
    async stopRecording() {
      video = requirePage().video();
      await context.close();
      await browser.close();
      closed = true;
      if (!video) throw new Error('stage.finish: no video was recorded (recordVideo not configured?)');
      return { kind: 'video', webmPath: await video.path(), t0: 0 };
    },

    /** Teardown WITHOUT keeping a recording — the abort path. The video handle has to be grabbed
     *  BEFORE the context closes (closing is what finalizes and names the file), otherwise the
     *  page is gone and the randomly-named .webm is stranded in --out forever, where the next
     *  run's preflight will not see it and no one will know what it was. */
    async close() {
      if (closed) return;
      closed = true;
      const pending = video ?? (page ? page.video() : null);
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
      if (!video && pending) {
        // Only on the abort path: stopRecording() sets `video`, and that recording is the take.
        const path = await pending.path().catch(() => null);
        if (path) await rm(path, { force: true }).catch(() => {});
      }
    },
  };
}
