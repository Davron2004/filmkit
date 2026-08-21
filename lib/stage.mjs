// ─────────────────────────────────────────────────────────────────────────────
// lib/stage.mjs — filmkit's web stage. Films a scripted walkthrough of ANY web app
// running in a real Chromium window: a real animated cursor, real clicks and
// keystrokes (driven through Playwright's actual mouse/keyboard so hover states and
// focus track what's on screen), and caption text overlaid on top.
//
// STATE MACHINE (the director): idle → open() → ready → {click|type|point|caption|
// clearCaption|pause}* → finish()|abort(). `open()` is called once per flow (loading a
// second URL mid-flow is unsupported — re-open the stage instead). Every other action
// requires `ready` (calling an action before open() throws immediately, not silently
// no-ops). `abort()` is the only escape from a thrown error inside a flow — it tears
// down the browser without touching the video, so a failed flow never leaves a zombie
// Chromium process; `finish()` is the only path that produces an output file, and is
// terminal.
//
// DETERMINISM INVARIANT: every timing value here (cursor-move duration, per-character type
// delay, dwell/settle pauses) is a PURE FUNCTION of distance / text length / fixed constants
// below — no Math.random(), no wall-clock-derived jitter. Re-filming the same flow file against
// the same build reproduces the same choreography every time (the SCRIPT is deterministic; the
// resulting mp4's exact bytes still differ run to run, since a video codec's timestamps and the
// real CDP mouse-move round-trip are not — that's expected and not what this invariant claims).
import { chromium } from 'playwright';
import { mkdir, rm, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import {
  injectOverlay,
  setCursorPosition,
  setCaptionText,
  setCaptionVisible,
  isCaptionVisible,
} from './cursor-overlay.mjs';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_DIR = join(HERE, '..', 'out');

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
const SETTLE_MS_END = 1000; // beat before closing, so playback doesn't feel clipped

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

async function transcodeToMp4(webmPath, mp4Path) {
  try {
    await execFileP('ffmpeg', ['-y', '-i', webmPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4Path]);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false; // ffmpeg not installed — caller keeps the .webm
    throw err; // ffmpeg ran and failed — a real problem, don't swallow it
  }
}

/**
 * Set up the stage: launch Chromium, open a recording context + page (recording starts here,
 * BEFORE any navigation, so the video opens on the app rather than a blank tab), and return the
 * director API a flow file drives.
 *
 * @param {object} o
 * @param {string} o.flowName names the output video (`<outDir>/<flowName>.mp4`)
 * @param {string} [o.outDir] output directory (default <repo>/out)
 * @param {{width: number, height: number}} [o.viewport] recording size (default 1280x720)
 */
export async function createStage({ flowName, outDir = DEFAULT_OUT_DIR, viewport = VIEWPORT } = {}) {
  if (!flowName) throw new Error('createStage: flowName is required (used to name the output video)');
  await mkdir(outDir, { recursive: true });

  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    if (/Executable doesn't exist|looks like Playwright was just installed/.test(String(err))) {
      throw new Error(
        'Playwright\'s Chromium is not installed. Run `npx playwright install chromium` once ' +
          '(inside this repo, with its node_modules present), then retry.',
      );
    }
    throw err;
  }
  // bypassCSP: true — this is a FILMING layer, not a security surface: it needs to inject a
  // cursor + caption overlay into the page via page.evaluate/DOM APIs. Pages that ship a CSP
  // would otherwise block the overlay injection. This only affects THIS browser instance that
  // films the demo; it never touches what a real user's browser enforces.
  const context = await browser.newContext({
    viewport,
    recordVideo: { dir: outDir, size: viewport },
    bypassCSP: true,
  });
  const page = await context.newPage();

  let opened = false;
  let cursorPos = { x: viewport.width / 2, y: viewport.height / 2 };

  function requireOpen() {
    if (!opened) throw new Error('stage: no app loaded yet — call stage.open(url) first');
  }

  // `target` is a CSS selector (resolved against the top page), a Playwright Locator, or a
  // `(page) => Locator` function for compound queries (text filters, frameLocator for apps
  // that render inside iframes, etc).
  async function resolveLocator(target) {
    requireOpen();
    if (typeof target === 'function') return target(page);
    if (typeof target === 'string') return page.locator(target).first();
    return target; // already a Locator
  }

  async function boxCenter(locator, label) {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    const box = await locator.boundingBox();
    if (!box) throw new Error(`stage: target has no bounding box (not visible?) — ${label}`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  // Animate the fake cursor from its current position to (x, y) along an eased path — duration
  // proportional to distance (clamped), stepped at CURSOR_STEP_MS. Also drives the REAL mouse
  // along the same path (page.mouse.move) so hover states track what's on screen.
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
      await setCursorPosition(page, cx, cy);
      await page.mouse.move(cx, cy);
      await page.waitForTimeout(duration / steps);
    }
    cursorPos = { x, y };
  }

  const director = {
    /** The raw Playwright Page (top document) — escape hatch for custom locators, dialogs,
     *  file uploads, waiting on network responses, etc. */
    get page() {
      return page;
    },

    /** Load the app under film: `urlOrPath` is an http(s) URL or a local file path (opened via
     *  file://). Waits for `load`, optionally for `{ readySelector }` to appear, injects the
     *  overlay, then holds a settle beat. Call once at the start of a flow. */
    async open(urlOrPath, { readySelector, timeoutMs = 20000, settleMs = SETTLE_MS_START } = {}) {
      if (opened) throw new Error('stage.open: already opened — one open() per flow');
      const url =
        typeof urlOrPath === 'string' && !/^https?:\/\//.test(urlOrPath) && !urlOrPath.startsWith('file:')
          ? pathToFileURL(urlOrPath).href
          : urlOrPath;
      await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
      if (readySelector) await page.waitForSelector(readySelector, { timeout: timeoutMs });
      opened = true;
      await injectOverlay(page);
      await setCursorPosition(page, cursorPos.x, cursorPos.y);
      await page.waitForTimeout(settleMs);
    },

    /** Animate the cursor to `target`'s center, dwell, show press feedback, then perform a REAL
     *  `page.mouse.click` at those page-viewport coordinates. */
    async click(target) {
      const locator = await resolveLocator(target);
      const { x, y } = await boxCenter(locator, typeof target === 'string' ? target : '(locator)');
      await moveCursorTo(x, y);
      await setCursorPosition(page, x, y, true);
      await page.waitForTimeout(PRESS_DWELL_MS);
      await page.mouse.click(x, y);
      await page.waitForTimeout(CLICK_SETTLE_MS);
      await setCursorPosition(page, x, y, false);
    },

    /** Move the cursor to `target` WITHOUT clicking — for gesturing at a value while narrating
     *  via caption(), without pretending it was pressed. */
    async point(target) {
      const locator = await resolveLocator(target);
      const { x, y } = await boxCenter(locator, typeof target === 'string' ? target : '(locator)');
      await moveCursorTo(x, y);
    },

    /** Click into `target` (same cursor animation as click()), select any existing text, then
     *  type `text` one character at a time with a deterministic per-character delay. */
    async type(target, text) {
      const locator = await resolveLocator(target);
      await director.click(locator);
      await locator.selectText().catch(() => {});
      for (let i = 0; i < text.length; i++) {
        await page.keyboard.type(text[i]);
        const delay = clamp(
          TYPE_BASE_DELAY_MS + TYPE_JITTER_MS[i % TYPE_JITTER_MS.length],
          TYPE_MIN_DELAY_MS,
          TYPE_MAX_DELAY_MS,
        );
        await page.waitForTimeout(delay);
      }
      await page.waitForTimeout(TYPE_POST_SETTLE_MS);
    },

    /** Show caption text in the bottom overlay bar, cross-fading out any previous caption first. */
    async caption(text) {
      requireOpen();
      if (await isCaptionVisible(page)) {
        await setCaptionVisible(page, false);
        await page.waitForTimeout(CAPTION_FADE_MS);
      }
      await setCaptionText(page, text);
      await setCaptionVisible(page, true);
      await page.waitForTimeout(CAPTION_FADE_MS);
    },

    /** Fade the caption bar out. */
    async clearCaption() {
      requireOpen();
      await setCaptionVisible(page, false);
      await page.waitForTimeout(CAPTION_FADE_MS);
    },

    /** A plain beat — `ms` wall-clock milliseconds, nothing derived. */
    async pause(ms) {
      await page.waitForTimeout(ms);
    },

    /** Close the stage WITHOUT saving a video — the escape hatch when a flow throws, so a
     *  failed run never leaves a zombie Chromium process. No transcode is attempted. */
    async abort() {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },

    /** End settle pause, close the context (finalizing the recorded video), transcode webm→mp4
     *  with system ffmpeg, then delete the webm. If ffmpeg is missing, keep the .webm and say so. */
    async finish() {
      requireOpen();
      await page.waitForTimeout(SETTLE_MS_END);
      const video = page.video();
      await context.close(); // video finalizes on context close
      await browser.close();
      if (!video) throw new Error('stage.finish: no video was recorded (recordVideo not configured?)');
      const webmPath = await video.path();
      const mp4Path = join(outDir, `${flowName}.mp4`);
      const transcoded = await transcodeToMp4(webmPath, mp4Path);
      if (transcoded) {
        await rm(webmPath, { force: true });
        return mp4Path;
      }
      const keptPath = join(outDir, `${flowName}.webm`);
      if (webmPath !== keptPath) await rename(webmPath, keptPath);
      console.warn(`[film-web] ffmpeg not found on PATH — kept the recording as ${keptPath} instead of transcoding to .mp4.`);
      return keptPath;
    },
  };

  return director;
}
