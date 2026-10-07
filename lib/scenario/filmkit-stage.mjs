// ─────────────────────────────────────────────────────────────────────────────
// lib/scenario/filmkit-stage.mjs — the TEST-MODE stage, and the Playwright target code the film
// camera shares with it. A flow file written for the camera (`export default async ({ stage }) =>
// { ... }`, see lib/stage.mjs) runs unchanged under Playwright Test through createTestStage():
// same verbs, same targets, same waits, no choreography.
//
// THIS FILE IS COPIED. lib/scenario/emit-web.mjs writes it, with an `@filmkit-generated` first line
// prepended, as `filmkit-stage.mjs` next to every emitted `*.scenario.spec.mjs`, so a spec runs in a
// project that has only `@playwright/test` installed and no filmkit. Hence the rules:
//   - It imports ONLY `node:` built-ins. `test` and `expect` are PASSED IN by the spec: loading the
//     runner from here could load a second copy of it, and `test.step` breaks when that happens.
//   - Nothing in it knows about filmkit's layout (no imports of ../, no repo paths).
//
// ONE IMPLEMENTATION, TWO MODES. The film camera imports the shared half back from here, so what a
// scenario checks is what the camera did, not a re-implementation of it:
//   lib/backends/playwright.mjs   resolveVisibleBox, probeTarget, selectTextIn, clickAt, typeChar,
//                                 navigate, waitForCss, resolveOpenTarget, routeLocalFiles
//   lib/backends/ego.mjs          revealInPage (as source text), revealOptions, revealTarget: THE
//                                 REVEAL, the one rule for where a target is scrolled to
//   lib/target-wait.mjs           re-exports the text rule and the failed-wait messages (the ego
//                                 backend reads them through it)
//   lib/stage.mjs                 the option validators (targetBudget, expectArgs, oneOfArgs, ...),
//                                 pinTarget and pollTargets (the expect()/oneOf() decision loop)
// `--browser playwright` and a scenario therefore click, type, wait, match text and serve local
// files through the same functions. The ego backend is a different engine (CDP by hand, see
// lib/backends/ego.mjs); its known differences are listed under KNOWN GAPS below.
//
// THE FOUR KINDS OF STEP, and what each does here (test mode) versus on film:
//   action       open goto click type waitFor  real input, no animation, through the shared code
//                                               above. Every action waits for its target to be
//                                               visible first (resolveVisibleBox), as on film.
//   choreography caption pause point            caption() prefixes the report's step titles and draws
//                                               nothing; pause() is skipped unless pauseScale > 0;
//                                               point() still moves the REAL mouse to the target (a
//                                               hover menu opens here as it did on film).
//   checkpoint   expect(target, {text,timeoutMs})  the film loop, same probe, same text rule; failing
//                                               fails the test with the same message the camera prints.
//   branch point oneOf(map, {name,timeoutMs,accept,filmAccept})  the same wait, first visible in
//                                               declaration order wins; logged in `outcomes`.
//                                               `accept` decides pass/fail here. `filmAccept` is the
//                                               camera's and is ignored (validated, so a flow that is
//                                               wrong on film is wrong here too). An outcome outside
//                                               `accept` fails the test at once, naming the branch
//                                               point and the outcome (the camera holds 1s first so
//                                               the refusal is on film; a test has nothing to film).
//
// REPORT STEPS. Each action, checkpoint and branch point is ONE boxed `test.step`, titled
// "<caption up at the time> › <verb> <target>" (just "<verb> <target>" with no caption up), with
// `location` taken from the stack frame that called the verb: a failure points at the FLOW's own
// file and line, not at this file. The Playwright internals of a step are hidden (`box: true`).
// oneOf() also adds a `filmkit-outcome` annotation ("build=built"); the spec attaches the whole
// `stage.outcomes` log as `filmkit-outcomes` (JSON) in a finally, so a failed run still says which
// way the app went.
//
// STATE MACHINE, the camera's own (lib/stage.mjs) minus the camera's ending:
//
//   idle ──open()──> ready ──{click|type|point|waitFor|expect|oneOf|goto|caption|clearCaption|pause}*──> ready
//
// Only open() is legal in `idle`; a second open() throws (use goto()); every verb throws the camera's
// message in the wrong state, so a flow that fails on film for a missing open() fails here on the
// same line. There is no `closed` state: finish()/abort() belong to the camera (film-web calls them,
// a flow never does), and the test runner owns the page's lifetime. No back-navigation, no cancel: a
// verb completes or throws, and a throw fails the test.
//
// LOCAL FILES. open()/goto() take an http(s) URL, a `file:` URL, or a path. A relative path resolves
// against the SERVE ROOT, which is the flow file's own directory unless the take used --serve-root
// (the emitter bakes the take's root into the spec). A path or `file:` URL is served as
// `http://filmkit.localhost/<path from the root>` (a `file:` URL keeps its ?query and #hash) through
// `page.route`, so the page gets http semantics (ES modules, same-origin fetch) with no server process
// to start or tear down. Ego serves the same root the same way from its own loopback origin,
// `http://<token>.localhost:<port>/` (lib/static-server.mjs), at the origin root too, so a
// root-absolute reference (`/app.js`) resolves inside the serve root on every camera. `.localhost`, not
// the plan's `.local`: MEASURED, Chromium treats `http://filmkit.local` as an INSECURE context (no
// crypto.subtle, no service workers) and any `*.localhost` origin as a secure one. What a request
// serves is decided by ONE function for all three, resolveServedFile: a directory without its slash is
// redirected, and a symlink inside the root is followed only while its target stays inside it.
// A path outside the root is refused by name, before navigating; a directory is opened as `<dir>/`. A
// navigation whose response is 4xx/5xx is refused (it would test or film an error page), for local
// files and remote URLs alike, on both cameras (ego reads the status in the page after loading).
//
// ENVIRONMENT (read by the emitted spec, passed in here; this file reads no environment itself):
//   FILMKIT_BASE_URL     rebases the FILMED ORIGIN (the origin of the flow's open(); for a local
//                        file, http://filmkit.localhost) onto another one, path prefix included:
//                        a staging host or a preview deploy. Other origins are left alone.
//   FILMKIT_PAUSE_SCALE  pause() and open()/goto()'s settle beat are skipped (0, the default); 1 holds
//                        them at filming pace, 0.5 at half. For diagnosing a flow that used a pause
//                        as a wait. Cursor animation and typing rhythm are never replayed.
//   FILMKIT_TIMEOUT_MS   the spec's test timeout (default: 3x the filmed take + 60s).
//
// KNOWN GAPS between the two cameras (documented, not fixed; the test runs the Playwright side):
//   - `:has-text("…")` in a selector: Playwright matches case-insensitively on whitespace-normalized
//     text; ego's shim matches case-insensitively on trimmed text WITHOUT collapsing inner
//     whitespace. Neither is the `{ text }` rule of expect(), which is case-sensitive (below).
//   - `opacity: 0` counts as visible to Playwright (film and test) and as hidden to ego.
//   - `stage.page.waitForSelector(css, { timeoutMs })`: ego's stand-in honours timeoutMs; a real
//     Playwright Page ignores it (its option is `timeout`) and waits 30s on film, and in test mode
//     for the config's actionTimeout (none by default, so up to the test timeout).
//   - Local files come from different ORIGINS: `http://filmkit.localhost` here and on the Playwright
//     camera, a fresh `http://<token>.localhost:<port>` per take under ego. Same paths, same files,
//     both secure contexts; only code that compares `location.origin` to a literal can tell.
//   - A SUBRESOURCE request for a bare directory (`fetch('/sub')`) is a 404 here and a 301 to `/sub/`
//     under ego: a page.route cannot redirect at all (measured; see routeLocalFiles). A navigation to
//     `/sub` redirects on both (here by a self-replacing stub).
//   - The film camera draws its cursor and caption as DOM inside the page; test mode draws nothing,
//     so a positional selector that could land on the overlay (`body > div:last-child`) differs.
//   - Film clicks land after the cursor animation (at least ~0.4s after the target was found); test
//     clicks land at once. A page that needs a beat after an element appears is a page to wait on
//     with expect()/waitFor(), and FILMKIT_PAUSE_SCALE=1 does not bring the animation back.
//   - A target is scrolled to the same place on film and here (THE REVEAL, below), but film animates
//     the scroll and test mode jumps. Film also keeps the target clear of its caption wherever that
//     sits, which can only move the target further when a caption is taller than two lines. A take
//     filmed with --no-captions draws none and avoids none, so it scrolls exactly as this does.
//
// THE TEXT RULE (expect's `{ text }`), defined here once for both cameras and test mode: the
// target's `textContent` and the expected text both have every whitespace run collapsed to one space
// and are trimmed, then the expected text must occur in the target's text: a case-sensitive
// SUBSTRING match, which is Playwright's `toContainText(string)`. Backends only READ textContent
// (ProbeResult.text); textMatches() decides.
import { realpathSync, statSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One auto-wait budget, shared by click/point/type/waitFor/expect/oneOf, film and test. */
export const TARGET_TIMEOUT_MS = 10000;
/** expect()/oneOf() poll period (the ego backend's resolveBox polls at the same rate). */
export const PROBE_INTERVAL_MS = 100;
/** Where local files are served, on film (Playwright backend) and in test mode. See LOCAL FILES. */
export const LOCAL_ORIGIN = 'http://filmkit.localhost';

// probeTarget() reads textContent off an element it has just seen visible. If the element went away
// in between, Playwright would wait for it to come back; this bounds that to one short look.
const PROBE_READ_TIMEOUT_MS = 500;
// selectTextIn() runs right after a click into a field that was visible a moment ago. Bounded so a
// field that vanished cannot hold the run (on film the default was Playwright's 30s; in a test it
// would be the whole test timeout). A selection that cannot be made is skipped, as before.
const SELECT_TIMEOUT_MS = 5000;
const NAVIGATION_TIMEOUT_MS = 20000;
// Filming-pace holds, replayed only under pauseScale > 0. Mirrors lib/stage.mjs's SETTLE_MS_START.
const FILM_SETTLE_MS_START = 700;
// How many intermediate positions the real mouse passes through on its way to a target. The film
// path is a straight line from the last position, eased in time; this walks the same line, so the
// same elements see mouseover/mouseout on the way.
const MOUSE_STEPS = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noop = async () => {};

// ── The text rule and the failed-wait messages (lib/target-wait.mjs re-exports these) ──────────

export function describeTarget(target) {
  if (typeof target === 'string') return target;
  if (typeof target === 'function') return '(locator function)';
  return '(Playwright Locator)';
}

/** Every whitespace run to one space, trimmed. */
export function collapseWhitespace(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** The text rule (header): collapsed `expected` occurs in collapsed `actual`, case-sensitively. */
export function textMatches(actual, expected) {
  return collapseWhitespace(actual).includes(collapseWhitespace(expected));
}

// Why an attached target is not ready, worded for both engines: opacity 0 only hides a target under
// --browser ego (Playwright, on film and in test mode, counts it visible; see KNOWN GAPS).
const NO_VISIBLE_BOX =
  'it is in the document, but has no visible box (display:none, visibility:hidden or zero size; under --browser ego also opacity 0)';

/**
 * @param {string} name       the target as the flow wrote it
 * @param {number} timeoutMs  the budget that ran out
 * @param {boolean} attached  true if it IS in the document but not visibly laid out
 * @param {string} url        where we were when we gave up
 */
export function targetTimeoutMessage(name, timeoutMs, attached, url) {
  const why = attached
    ? NO_VISIBLE_BOX
    : 'it never appeared in the document';
  return (
    `stage: target never became visible — ${name}\n` +
    `  waited ${(timeoutMs / 1000).toFixed(1)}s; ${why}\n` +
    `  url: ${url || '(unknown)'}`
  );
}

// What the LAST probe of a target saw, as a clause. `probe` is a ProbeResult
// ({ found, visible, text, matched, error }) or null when no probe ever came back.
function lastSeen(probe, text) {
  if (!probe) return 'no probe of the page ever came back';
  if (probe.error && !probe.found) return `the last check could not run (${probe.error.split('\n')[0]})`;
  if (!probe.found) return 'it never appeared in the document';
  if (!probe.visible) return NO_VISIBLE_BOX;
  if (text !== undefined && !probe.matched) {
    const seen = collapseWhitespace(probe.text ?? '');
    const shown = seen.length > 120 ? `${seen.slice(0, 117)}...` : seen;
    return `it is visible, but its text never contained ${JSON.stringify(collapseWhitespace(text))} (last seen: ${JSON.stringify(shown)})`;
  }
  return 'it matched only after the budget ran out';
}

/** stage.expect ran out of budget. Same shape as targetTimeoutMessage, plus the text clause. */
export function expectTimeoutMessage(name, timeoutMs, probe, text, url) {
  const what = text === undefined ? 'target never became visible' : `target never showed ${JSON.stringify(collapseWhitespace(text))}`;
  return (
    `stage.expect: ${what} — ${name}\n` +
    `  waited ${(timeoutMs / 1000).toFixed(1)}s; ${lastSeen(probe, text)}\n` +
    `  url: ${url || '(unknown)'}`
  );
}

/** stage.oneOf ran out of budget with no outcome visible. One line per outcome, in declaration order. */
export function oneOfTimeoutMessage(branchName, timeoutMs, rows, url) {
  const lines = rows.map(({ key, target, probe }) => `  ${key}: ${describeTarget(target)} — ${lastSeen(probe, undefined)}`);
  return (
    `stage.oneOf "${branchName}": none of its outcomes became visible within ${(timeoutMs / 1000).toFixed(1)}s\n` +
    `${lines.join('\n')}\n` +
    `  url: ${url || '(unknown)'}`
  );
}

/** stage.oneOf decided on an outcome this run may not keep. `list` names which list refused it
 *  ('accept' or 'filmAccept'); `mode` says what failing means ('film': a retake; 'test': a red test). */
export function oneOfRejectedMessage(branchName, outcome, target, list, allowed, mode = 'film') {
  const consequence =
    mode === 'test'
      ? '  The test fails; the outcome is in the `filmkit-outcomes` attachment.'
      : "  The take is failed so it can be filmed again; the outcome is in the sidecar's `outcomes`.";
  return (
    `stage.oneOf "${branchName}": the app took the "${outcome}" branch (${describeTarget(target)} appeared first), ` +
    `which ${list} does not include (${list}: ${allowed.join(', ')}).\n` +
    consequence
  );
}

// ── Option validation: one definition of a legal call, film and test ─────────────────────────
// Every check runs before the browser is touched. A misspelt option must not change what a take
// keeps or what a test accepts.

/** The per-call wait budget: `options.timeoutMs`, default TARGET_TIMEOUT_MS, a finite number > 0 (a
 *  NaN or Infinity deadline would make a poll loop spin forever). No ceiling. */
export function targetBudget(options, verb) {
  if (options === undefined || options === null) return TARGET_TIMEOUT_MS;
  if (typeof options !== 'object') {
    throw new TypeError(`stage.${verb}: options must be an object like { timeoutMs: 20000 } (got ${typeof options})`);
  }
  const { timeoutMs } = options;
  if (timeoutMs === undefined) return TARGET_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`stage.${verb}: timeoutMs must be a finite number of milliseconds > 0 (got ${String(timeoutMs)})`);
  }
  return timeoutMs;
}

/** A plain object whose keys are all in `known`. */
export function checkOptions(options, verb, known, example) {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError(`stage.${verb}: options must be an object like ${example} (got ${Array.isArray(options) ? 'an array' : options === null ? 'null' : typeof options})`);
  }
  const unknown = Object.keys(options).filter((k) => !known.includes(k));
  if (unknown.length) {
    throw new TypeError(`stage.${verb}: unknown option${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')} (known: ${known.join(', ')})`);
  }
}

export function checkTarget(target, verb) {
  const ok = typeof target === 'string' ? target.trim() !== '' : typeof target === 'function' || (typeof target === 'object' && target !== null);
  if (!ok) throw new TypeError(`stage.${verb}: target must be a CSS selector string (got ${target === '' ? 'an empty string' : String(target)})`);
}

/** A list of outcome keys (accept / filmAccept): a non-empty array drawn from `allowed`, which the
 *  message calls `allowedName` ("the outcomes" for accept, "accept" for filmAccept). Deduplicated. */
export function checkOutcomeList(list, what, allowed, allowedName, verb) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new TypeError(`stage.${verb}: ${what} must be a non-empty array of outcome names drawn from ${allowed.join(', ')}`);
  }
  const stray = list.filter((k) => !allowed.includes(k));
  if (stray.length) {
    throw new TypeError(
      `stage.${verb}: ${what} names ${stray.map((k) => `"${k}"`).join(', ')}, which ${stray.length > 1 ? 'are' : 'is'} not in ${allowedName} (${allowed.join(', ')})`,
    );
  }
  return [...new Set(list)];
}

/** expect(target, options) -> { timeoutMs, text }, or a TypeError naming what is wrong. */
export function expectArgs(target, options = {}) {
  checkTarget(target, 'expect');
  checkOptions(options, 'expect', ['text', 'timeoutMs'], '{ text: "Saved", timeoutMs: 20000 }');
  const timeoutMs = targetBudget(options, 'expect');
  const { text } = options;
  if (text !== undefined && (typeof text !== 'string' || text.trim() === '')) {
    throw new TypeError(`stage.expect: text must be a non-empty string (got ${JSON.stringify(text)})`);
  }
  return { timeoutMs, text };
}

/** oneOf(targets, options) -> { keys, name, timeoutMs, accept, filmAccept }, or a TypeError. */
export function oneOfArgs(targets, options) {
  const example = '{ built: "[data-testid=preview]", failed: "[data-testid=build-error]" }';
  if (typeof targets !== 'object' || targets === null || Array.isArray(targets)) {
    throw new TypeError(`stage.oneOf: the first argument must be an object of { outcome: target }, like ${example}`);
  }
  const keys = Object.keys(targets);
  if (!keys.length) throw new TypeError(`stage.oneOf: no outcomes given — pass at least one, like ${example}`);
  for (const k of keys) checkTarget(targets[k], `oneOf (outcome "${k}")`);
  if (options === undefined) throw new TypeError('stage.oneOf: options are required, at least { name: "build" }');
  checkOptions(options, 'oneOf', ['name', 'timeoutMs', 'accept', 'filmAccept'], '{ name: "build", timeoutMs: 300000, filmAccept: ["built"] }');
  const { name } = options;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError(`stage.oneOf: options.name must be a non-empty string naming this branch point (got ${JSON.stringify(name)})`);
  }
  const timeoutMs = targetBudget(options, 'oneOf');
  const accept = options.accept === undefined ? keys : checkOutcomeList(options.accept, 'accept', keys, 'the outcomes', `oneOf "${name}"`);
  const filmAccept =
    options.filmAccept === undefined ? accept : checkOutcomeList(options.filmAccept, 'filmAccept', accept, 'accept', `oneOf "${name}"`);
  return { keys, name, timeoutMs, accept, filmAccept };
}

/** A `(page) => Locator` target is a FUNCTION, and calling it twice runs the query twice, which for a
 *  text-filtered or nth-match locator can resolve to two different elements if the page moved in
 *  between. type() clicks and then selects; pin the target so both see the same Locator. Lazy, and
 *  toString() keeps the flow's own source (the ego backend names a refused function target by it). */
export function pinTarget(target) {
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
  pinned.toString = () => String(target);
  return pinned;
}

/**
 * THE DECISION LOOP behind expect() and oneOf(), film and test: probe every target in declaration
 * order, every PROBE_INTERVAL_MS, until one matches or the budget is spent. A tie within one round
 * goes to declaration order. Returns { index, last }: `index` of the target that decided it (null on
 * timeout), `last` the latest probe of each target (for the timeout message). The hooks are where
 * the camera adds its own work (re-dressing a replaced document); test mode passes none.
 * @param {Array} targets
 * @param {{ text?: string, timeoutMs: number, probe: (target, opts) => Promise<object>,
 *   sleep?: (ms: number) => Promise<void>, beforeRound?: () => Promise<void>|void,
 *   betweenRounds?: () => Promise<void>|void, onMatch?: () => Promise<void>|void }} o
 */
export async function pollTargets(targets, { text, timeoutMs, probe, sleep: wait = sleep, beforeRound = noop, betweenRounds = noop, onMatch = noop }) {
  const deadline = Date.now() + timeoutMs;
  const last = targets.map(() => null);
  for (;;) {
    await beforeRound();
    for (let i = 0; i < targets.length; i++) {
      const result = await probe(targets[i], text === undefined ? {} : { text });
      if (result?.fatal) throw new Error(result.error);
      last[i] = result;
      if (result?.matched) {
        await onMatch();
        return { index: i, last };
      }
    }
    if (Date.now() >= deadline) return { index: null, last };
    await betweenRounds();
    await wait(PROBE_INTERVAL_MS);
  }
}

// ── Playwright targets, input and navigation (the film backend imports these) ────────────────
// Each takes the Playwright `page` and nothing else, so "what counts as ready", "where to click" and
// "how a field is typed into" are one block whichever caller holds the page.

/** `target` is a CSS selector (resolved against the top page, first match), a Playwright Locator, or
 *  a `(page) => Locator` function for compound queries (text filters, frameLocator). */
export function locatorFor(page, target) {
  if (typeof target === 'function') return target(page);
  if (typeof target === 'string') return page.locator(target).first();
  return target; // already a Locator
}

// ── THE REVEAL: where a target is put before the cursor (or the real mouse) goes to it ──────────
// ONE policy for every engine and test mode. revealInPage() runs IN THE PAGE: the Playwright code
// below hands it to locator.evaluate(), and the ego backend bakes its source (Function#toString) into
// an evaluate string, since ego has no argument channel. So it must stay self-contained: no closures
// over this module, nothing but DOM APIs.
//
// THE COMFORT ZONE is the viewport minus REVEAL_EDGE_PX on every side, minus REVEAL_BAND_PX at the
// bottom (where the film camera draws its caption, lib/cursor-overlay.mjs: 34px off the bottom, one or
// two lines tall, so 120px clears a two-line caption with a gap), minus every `avoid` overlay that is
// on screen (an overlay in the lower half pushes the zone's bottom up, one in the upper half pushes
// its top down; the camera passes its caption, wherever it currently sits, and nothing under
// --no-captions). The band is kept whether or not a caption is drawn: test mode never draws one and
// has it, so a caption-free take, its captioned twin and the test all land a target in one place, and
// it is where a player draws the subtitles of a caption-free take (lib/stage.mjs, NO CAPTIONS). A target is COMFORTABLE
// when its box lies inside the zone and is not clipped by an overflow ancestor (one larger than the
// zone: when its center is). A comfortable target is left where it is: no motion the viewer did not
// need. Any other target is scrolled so its center is at the viewport's center (block 'center';
// inline 'center' only when it is out horizontally), the alignment the ego backend always used for an
// off-screen target.
//
// WHY THIS REPLACED scrollIntoViewIfNeeded (MEASURED 2026-10-06, examples: https://example.com at
// 1280x720). Playwright's scroll is minimal and instant: "Learn more" sat at y=720 (just below the
// fold) and was scrolled exactly to the bottom edge, under the caption, in one frame. The viewer saw
// the page jump, then a click ring behind the caption, and never the link. Ego scrolled only a target
// ENTIRELY off screen, so a half-visible one under the caption was never moved at all.
//
// HOW IT SCROLLS. The end position is the browser's own scrollIntoView result, so nested scroll
// containers, shadow roots and sticky layouts land where Chromium puts them: the scroll is done
// instantly, every ancestor's offset read, and all of them restored, in ONE task (nothing paints in
// between). Then, with `pace` (the film camera), each changed container is walked from its old offset
// to its new one along easeInOutCubic (the cursor's curve) on requestAnimationFrame, for a duration
// that is a pure function of the distance (lib/stage.mjs's DETERMINISM INVARIANT). Without `pace`
// (test mode, open()'s cursorAt) the end position is applied at once. Every scroll is `behavior:
// 'instant'`, because a page with `scroll-behavior: smooth` would otherwise animate each step itself.
// The animation runs page-side and the caller only sleeps for it (revealTarget): an evaluate that
// awaited it would, on ego, hold the one CDP queue and with it the screencast acks, so the scroll would
// be filmed as one frame. A page whose rAF is throttled cannot strand it: after the sleep, the caller
// snaps it to its end (REVEAL_SETTLE_SOURCE).
//
// LIMITS. A target that cannot be scrolled (position: fixed, or the page ends first) stays where it
// is; the film camera then moves its caption out of the way instead (lib/stage.mjs, THE CAPTION
// NEVER COVERS THE TARGET). A target inside an iframe is scrolled by Playwright's own
// scrollIntoViewIfNeeded, as before: the zone is the TOP viewport's, and a frame's script cannot
// measure it.

/** Distance kept from every viewport edge. */
export const REVEAL_EDGE_PX = 24;
/** Bottom band kept clear for the film camera's caption (see THE REVEAL). */
export const REVEAL_BAND_PX = 120;
/** Gap kept between a target and an `avoid` overlay. */
export const REVEAL_GAP_PX = 16;
// After the animation's planned end, a beat before the snap, so a frame at the end position is
// painted by the page's own rAF rather than by the snap.
const REVEAL_SETTLE_SLACK_MS = 40;

/**
 * PAGE-SIDE (see THE REVEAL): bring `el` to a comfortable position. Returns { scrolled, durationMs,
 * distance, frame }: `frame` true means `el` is in an iframe and nothing was done.
 * @param {Element} el
 * @param {{ edgePx: number, bandPx: number, gapPx: number, avoid: string[],
 *   pace: null | { baseMs: number, msPerPx: number, minMs: number, maxMs: number } }} o
 */
export function revealInPage(el, o) {
  const prev = window.__filmkitReveal;
  if (prev && !prev.done) prev.finish();
  if (!el || !el.isConnected) return { scrolled: false, durationMs: 0, distance: 0, frame: false };
  if (window !== window.top) return { scrolled: false, durationMs: 0, distance: 0, frame: true };
  // The composed-tree parent: a slot, a light-DOM parent, or a shadow root's host.
  const up = (n) => n.assignedSlot || n.parentElement || (n.parentNode && n.parentNode.host) || null;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const zone = { top: o.edgePx, left: o.edgePx, right: vw - o.edgePx, bottom: vh - Math.max(o.edgePx, o.bandPx) };
  for (const sel of o.avoid || []) {
    let a = null;
    try {
      a = document.querySelector(sel);
    } catch {
      continue;
    }
    if (!a) continue;
    const cs = window.getComputedStyle(a);
    const ar = a.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05 || !ar.width || !ar.height) continue;
    if (ar.top + ar.height / 2 >= vh / 2) zone.bottom = Math.min(zone.bottom, ar.top - o.gapPx);
    else zone.top = Math.max(zone.top, ar.bottom + o.gapPx);
  }
  const r = el.getBoundingClientRect();
  // The part of the box no overflow ancestor clips (the root scroller is the viewport, checked by the zone).
  const v = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  for (let n = up(el); n && n !== document.body && n !== document.documentElement; n = up(n)) {
    const cs = window.getComputedStyle(n);
    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
    const c = n.getBoundingClientRect();
    v.top = Math.max(v.top, c.top);
    v.bottom = Math.min(v.bottom, c.bottom);
    v.left = Math.max(v.left, c.left);
    v.right = Math.min(v.right, c.right);
  }
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const inside = (b, axis) =>
    axis === 'v' ? r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5 : r.left >= b.left - 0.5 && r.right <= b.right + 0.5;
  const centerIn = (b, axis) => (axis === 'v' ? cy >= b.top && cy <= b.bottom : cx >= b.left && cx <= b.right);
  const ok = (axis) => {
    const fits = axis === 'v' ? r.height <= zone.bottom - zone.top : r.width <= zone.right - zone.left;
    return fits ? inside(zone, axis) && inside(v, axis) : centerIn(zone, axis) && centerIn(v, axis);
  };
  const okV = ok('v');
  const okH = ok('h');
  if (okV && okH) return { scrolled: false, durationMs: 0, distance: 0, frame: false };

  // The end position, by the browser's own rule; read, then restored before anything paints.
  const scrollers = [];
  for (let n = up(el); n; n = up(n)) scrollers.push(n);
  const root = document.scrollingElement || document.documentElement;
  if (!scrollers.includes(root)) scrollers.push(root);
  const from = scrollers.map((s) => [s.scrollLeft, s.scrollTop]);
  el.scrollIntoView({ block: okV ? 'nearest' : 'center', inline: okH ? 'nearest' : 'center', behavior: 'instant' });
  const to = scrollers.map((s) => [s.scrollLeft, s.scrollTop]);
  scrollers.forEach((s, i) => s.scrollTo({ left: from[i][0], top: from[i][1], behavior: 'instant' }));
  const moves = [];
  let distance = 0;
  scrollers.forEach((s, i) => {
    const dx = to[i][0] - from[i][0];
    const dy = to[i][1] - from[i][1];
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    moves.push({ s, from: from[i], dx, dy });
    distance = Math.max(distance, Math.hypot(dx, dy));
  });
  if (!moves.length) return { scrolled: false, durationMs: 0, distance: 0, frame: false };
  const apply = (k) => {
    for (const m of moves) m.s.scrollTo({ left: m.from[0] + m.dx * k, top: m.from[1] + m.dy * k, behavior: 'instant' });
  };
  const p = o.pace;
  const durationMs = p ? Math.round(Math.max(p.minMs, Math.min(p.maxMs, p.baseMs + distance * p.msPerPx))) : 0;
  if (!durationMs) {
    apply(1);
    return { scrolled: true, durationMs: 0, distance: Math.round(distance), frame: false };
  }
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const t0 = performance.now();
  const state = {
    done: false,
    finish() {
      if (state.done) return;
      state.done = true;
      apply(1);
    },
  };
  const tick = () => {
    if (state.done) return;
    const t = Math.min(1, (performance.now() - t0) / durationMs);
    if (t >= 1) return state.finish();
    apply(ease(t));
    requestAnimationFrame(tick);
  };
  window.__filmkitReveal = state;
  requestAnimationFrame(tick);
  return { scrolled: true, durationMs, distance: Math.round(distance), frame: false };
}

/** Snap a running reveal to its end (a no-op when it already ended). An expression string, for any engine. */
export const REVEAL_SETTLE_SOURCE =
  '(() => { const r = window.__filmkitReveal; if (r && !r.done) r.finish(); return true; })()';

/** revealInPage's options from a caller's `reveal` ({ pace, avoid }, both optional). */
export function revealOptions(reveal = {}) {
  return {
    edgePx: REVEAL_EDGE_PX,
    bandPx: REVEAL_BAND_PX,
    gapPx: REVEAL_GAP_PX,
    avoid: Array.isArray(reveal?.avoid) ? reveal.avoid : [],
    pace: reveal?.pace ?? null,
  };
}

/**
 * The engine-neutral half of a reveal: start it page-side, then sleep through its animation and snap
 * it to its end. `start` returns revealInPage's result (null when it could not run); `settle`
 * evaluates REVEAL_SETTLE_SOURCE; `sleep` is the caller's clock (a backend's own sleep on film).
 */
export async function revealTarget({ start, settle, sleep: wait = sleep }) {
  const plan = await start().catch(() => null);
  if (plan?.durationMs > 0) {
    await wait(plan.durationMs + REVEAL_SETTLE_SLACK_MS);
    await settle().catch(() => {});
  }
  return plan;
}

/** THE AUTO-WAIT for an action. `waitFor({state:'visible'})` is Playwright's definition of ready:
 *  attached, and laid out with a non-empty box (which excludes display:none and zero size). Its
 *  timeout is the stage's per-call budget, not Playwright's default, and its message is replaced:
 *  "Timeout 10000ms exceeded" does not say which page you were on. Then THE REVEAL (above) brings
 *  the target to a comfortable position (the cursor, or the real mouse, is about to go there), and
 *  the box comes back in viewport pixels. `reveal` is { pace, avoid } (revealOptions); test mode
 *  passes none, so it lands where the film did, at once. */
export async function resolveVisibleBox(page, target, { timeoutMs = TARGET_TIMEOUT_MS, reveal } = {}) {
  const locator = locatorFor(page, target);
  const name = describeTarget(target);
  try {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    const attached = await locator.count().then((n) => n > 0).catch(() => false);
    throw new Error(targetTimeoutMessage(name, timeoutMs, attached, page.url()));
  }
  const plan = await revealTarget({
    start: () => locator.evaluate(revealInPage, revealOptions(reveal), { timeout: timeoutMs }),
    settle: () => page.evaluate(REVEAL_SETTLE_SOURCE),
    sleep: (ms) => page.waitForTimeout(ms),
  });
  // An iframe's target, or a reveal that could not run (the element went away mid-call): Playwright's
  // own minimal scroll, the behavior before THE REVEAL.
  if (!plan || plan.frame) await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => {});
  const box = await locator.boundingBox({ timeout: timeoutMs }).catch(() => null);
  if (!box) throw new Error(targetTimeoutMessage(name, timeoutMs, true, page.url()));
  return box;
}

export function boxCenter(box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** ONE look at `target` for the expect()/oneOf() loop: never waits, never scrolls, never throws.
 *  `isVisible()` is the same visibility rule resolveVisibleBox waits for; with `{ text }`, `matched`
 *  also needs the text rule. Returns { found, visible, text, matched, error, fatal } (fatal is always
 *  false: every target kind Playwright takes can be probed). A throw (a strict-mode violation, a
 *  navigation mid-read) comes back as `error` and the loop keeps looking. */
export async function probeTarget(page, target, { text } = {}) {
  try {
    const locator = locatorFor(page, target);
    if (!(await locator.isVisible())) {
      const found = await locator.count().then((n) => n > 0).catch(() => false);
      return { found, visible: false, text: null, matched: false, error: null, fatal: false };
    }
    if (text === undefined) return { found: true, visible: true, text: null, matched: true, error: null, fatal: false };
    const seen = collapseWhitespace(await locator.textContent({ timeout: PROBE_READ_TIMEOUT_MS }));
    return { found: true, visible: true, text: seen, matched: textMatches(seen, text), error: null, fatal: false };
  } catch (err) {
    return { found: false, visible: false, text: null, matched: false, error: String(err?.message || err), fatal: false };
  }
}

/** Select the text already in a field, so the real keystrokes that follow replace it. Never `fill`. */
export async function selectTextIn(page, target) {
  await locatorFor(page, target)
    .selectText({ timeout: SELECT_TIMEOUT_MS })
    .catch(() => {});
}

/** A real click at viewport coordinates (the center of the box resolveVisibleBox returned). */
export async function clickAt(page, x, y) {
  await page.mouse.click(x, y);
}

/** One real key event pair for one character, never a value assignment. */
export async function typeChar(page, ch) {
  await page.keyboard.type(ch);
}

/** Navigate and wait for `load`, then refuse an error page: a 4xx/5xx response means every later
 *  step would run against the wrong document (a take of an error page, a test that fails later and
 *  for the wrong reason). `local` is { path, root } when the URL serves a local file, for a message
 *  that names the path the flow wrote. A same-document navigation has no response and no check.
 *  Redirects are followed, not judged: the response returned (null for a same-document navigation)
 *  is the last hop's, and `response.request().redirectedFrom()` walks back to the URL asked for
 *  (tools/explore.mjs reports them from there). */
export async function navigate(page, url, { timeoutMs = NAVIGATION_TIMEOUT_MS, verb = 'open', local = null } = {}) {
  const response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
  const status = response?.status();
  if (status !== undefined && status >= 400) {
    if (local) {
      throw new Error(
        `stage.${verb}: ${local.path} is not readable — the local file server answered ${status}.\n` +
          `  Serving from ${local.root}; check the path exists and is a file.`,
      );
    }
    throw new Error(`stage.${verb}: ${url} answered ${status} — refusing to go on against an error page.`);
  }
  return response;
}

/** open()/goto()'s `readySelector`: Playwright's own waitForSelector (attached and visible). */
export async function waitForCss(page, css, { timeoutMs = NAVIGATION_TIMEOUT_MS } = {}) {
  await page.waitForSelector(css, { timeout: timeoutMs });
}

// ── Local files (header, LOCAL FILES) ──────────────────────────────────────────────────────────

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** `path` with every symlink resolved, for a path that may not exist yet: the nearest existing
 *  ancestor is realpath'd and the rest is appended. The containment check compares REAL paths, because
 *  the two sides arrive by different routes: Node's loader realpaths a flow's `import.meta.url`
 *  (`/tmp/demo` becomes `/private/tmp/demo` on macOS, a symlinked checkout becomes its target), while a
 *  root taken from argv or dirname() keeps whatever spelling it was given. Compared lexically, a
 *  flow's own sibling file read as "outside the root" (measured, `/tmp/demo/generate.demo.mjs`). */
export function realPathLoose(path) {
  const abs = resolve(path);
  const rest = [];
  let at = abs;
  for (;;) {
    try {
      return rest.length ? join(realpathSync(at), ...rest.reverse()) : realpathSync(at);
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') return abs;
      const up = dirname(at);
      if (up === at) return abs;
      rest.push(basename(at));
      at = up;
    }
  }
}

/** A serve root given as a directory path or a `file:` URL (the spec passes `new URL('./', import.meta.url)`),
 *  as a real path (see realPathLoose). */
export function localRoot(serveRoot) {
  const path = serveRoot instanceof URL || String(serveRoot).startsWith('file:') ? fileURLToPath(serveRoot) : String(serveRoot);
  return realPathLoose(path);
}

/**
 * What open()/goto() load for `urlOrPath`: `{ url, local }`, `local` = { path, root } for a local file.
 * An http(s) URL passes through. A path (relative to `root`) or a `file:` URL becomes
 * LOCAL_ORIGIN/<path from root>, keeping a file: URL's ?query and #hash. A local file outside `root`
 * throws before anything navigates. `root` null means no local files can be served.
 */
export function resolveOpenTarget(urlOrPath, root, verb = 'open') {
  if (typeof urlOrPath !== 'string') throw new Error(`stage.${verb}: expected a URL or path string`);
  if (/^https?:\/\//i.test(urlOrPath)) return { url: urlOrPath, local: null };
  let path;
  let suffix = '';
  if (urlOrPath.startsWith('file:')) {
    const fileUrl = new URL(urlOrPath);
    suffix = fileUrl.search + fileUrl.hash;
    path = fileURLToPath(fileUrl);
  } else {
    path = root === null ? resolve(urlOrPath) : resolve(root, urlOrPath);
  }
  if (root === null) throw new Error(`stage.${verb}: ${path} is a local file, and this stage was given no serve root to serve local files from`);
  // Real paths on both sides (realPathLoose); `root` is already one when it came from localRoot().
  const realRoot = realPathLoose(root);
  const realPath = realPathLoose(path);
  const rel = relative(realRoot, realPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(realRoot, rel) !== realPath) {
    throw new Error(
      `stage.${verb}: ${path} is outside the directory local files are served from (${root}).\n` +
        "  Local files are served over http, rooted at the flow file's own directory unless the take\n" +
        '  used --serve-root <dir> (a scenario inherits the take\'s root). Film with a --serve-root that\n' +
        '  contains this file, or open an http(s) URL.',
    );
  }
  // A directory is opened at `<dir>/`, so its index.html resolves relative references against the
  // directory (the servers redirect `/dir` too, but a page.route cannot: see routeLocalFiles).
  const isDir = rel !== '' && (() => { try { return statSync(realPath).isDirectory(); } catch { return false; } })();
  const url = `${LOCAL_ORIGIN}/${rel.split(sep).map(encodeURIComponent).join('/')}${isDir ? '/' : ''}${suffix}`;
  return { url, local: { path, root: realRoot } };
}

/** The content type a served file gets, by extension (lib/static-server.mjs uses the same table). */
export function contentTypeOf(file) {
  return TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
}

const insideRoot = (root, path) => path === root || path.startsWith(root + sep);

/**
 * THE ONE ANSWER to "what does GET <pathname> serve from `root`", for every camera and test mode: the
 * Playwright camera's and test mode's page.route (routeLocalFiles) and ego's loopback server
 * (lib/static-server.mjs) both call this, so a local page loads the same files everywhere.
 *   -> { status: 200, file }              serve `file` (a real path, inside the root)
 *   -> { status: 301, location }          a directory asked for without its trailing slash: redirect to
 *                                         `<path>/` (query kept), as any static server does. Serving its
 *                                         index.html at `/sub` would resolve the page's relative
 *                                         references against `/` (measured: `sub/app.js` never ran)
 *   -> { status: 400 | 403 | 404 }        a malformed %-escape; a path outside the root; nothing there
 * CONTAINMENT is checked twice: lexically on the decoded path (a `..%2f` decodes to `../` and is 403 here;
 * literal `..` and `%2e%2e` segments never arrive, the URL parser has already resolved them inside the
 * origin, so they name a path inside the root; leading slashes are collapsed, so `//x` is `/x`), and on
 * the REAL path of what would be served, so a symlink inside the root that points OUTSIDE it is 403
 * (measured before this: `root/leak.txt -> ../outside/secret.txt` served the secret on both cameras),
 * while a symlink that stays inside the root is followed. `root` must be a real path (localRoot).
 * @param {string} root
 * @param {string} pathname the request URL's pathname, still %-encoded
 * @param {string} [search] the request URL's query, kept on a redirect
 */
export async function resolveServedFile(root, pathname, search = '') {
  let rel;
  try {
    rel = decodeURIComponent(pathname.replace(/^\/+/, ''));
  } catch {
    return { status: 400 };
  }
  const target = resolve(root, rel);
  if (!insideRoot(root, target)) return { status: 403 };
  let real;
  try {
    real = await realpath(target);
  } catch {
    return { status: 404 };
  }
  if (!insideRoot(root, real)) return { status: 403 };
  const info = await stat(real).catch(() => null);
  if (!info) return { status: 404 };
  if (info.isDirectory()) {
    // ONE leading slash: `//sub/` as a Location is scheme-relative, a redirect to the host `sub`.
    if (!pathname.endsWith('/')) return { status: 301, location: `/${pathname.replace(/^\/+/, '')}/${search}` };
    const index = await realpath(join(real, 'index.html')).catch(() => null);
    if (!index) return { status: 404 };
    if (!insideRoot(root, index)) return { status: 403 };
    return (await stat(index).catch(() => null))?.isFile() ? { status: 200, file: index } : { status: 404 };
  }
  return info.isFile() ? { status: 200, file: real } : { status: 404 };
}

const STATUS_TEXT = { 400: 'bad path', 403: 'forbidden', 404: 'not found', 405: 'method not allowed' };

/** Serve `root` at LOCAL_ORIGIN on this page, by resolveServedFile's rules: GET/HEAD only (405
 *  otherwise), `no-store` so a rebuilt fixture is never served stale. */
export async function routeLocalFiles(page, root) {
  await page.route(`${LOCAL_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const plain = (status) => route.fulfill({ status, contentType: 'text/plain; charset=utf-8', body: STATUS_TEXT[status] ?? String(status) });
    if (request.method() !== 'GET' && request.method() !== 'HEAD') return plain(405);
    const url = new URL(request.url());
    const served = await resolveServedFile(root, url.pathname, url.search);
    // A directory without its trailing slash. MEASURED on Playwright 1.60 / Chromium: a 3xx from
    // route.fulfill() is never followed, not for a navigation (net::ERR_CONNECTION_REFUSED on
    // *.localhost, ERR_NAME_NOT_RESOLVED elsewhere, absolute or relative Location, 301 or 302) and not
    // for a fetch ("Failed to fetch"). A navigation gets a stub that REPLACES itself with `<dir>/`
    // (no history entry, query and hash kept), which is what a 301 does for a document; open()/goto()
    // never meet it (resolveOpenTarget already adds the slash), a clicked `<a href="dir">` does. A
    // subresource request for a bare directory is a 404 here and a 301 under ego (KNOWN GAPS).
    if (served.status === 301) {
      if (!request.isNavigationRequest()) return plain(404);
      const stub = `<!doctype html><meta charset="utf-8"><script>location.replace(${JSON.stringify(served.location.split('?')[0])} + location.search + location.hash)</script>`;
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: stub });
    }
    if (served.status !== 200) return plain(served.status);
    const body = await readFile(served.file).catch(() => null);
    if (body === null) return plain(404);
    return route.fulfill({ status: 200, headers: { 'content-type': contentTypeOf(served.file), 'cache-control': 'no-store' }, body });
  });
}

// ── Test mode ─────────────────────────────────────────────────────────────────────────────────

const SELF = fileURLToPath(import.meta.url);

// The flow's own frame: the first stack frame that is not this file (and not Node's internals).
// Taken synchronously when the verb is called, before any await, so it is the caller's line.
function callerLocation() {
  const saved = Error.stackTraceLimit;
  Error.stackTraceLimit = 30;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = saved;
  for (const raw of stack.split('\n').slice(1)) {
    const m = /^\s*at (?:async )?(?:.*? \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(raw);
    if (!m) continue;
    let file = m[1];
    if (file.startsWith('node:') || file.startsWith('internal/')) continue;
    if (file.startsWith('file:')) {
      try {
        file = fileURLToPath(file);
      } catch {
        continue;
      }
    }
    if (file === SELF) continue;
    return { file, line: Number(m[2]), column: Number(m[3]) };
  }
  return undefined;
}

function parsePauseScale(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new TypeError(`createTestStage: pauseScale (FILMKIT_PAUSE_SCALE) must be a number >= 0, e.g. 1 for filming pace (got ${JSON.stringify(value)})`);
  }
  return n;
}

function parseBaseUrl(value) {
  if (value === undefined || value === null || value === '') return null;
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new TypeError(`createTestStage: baseUrl (FILMKIT_BASE_URL) must be an absolute http(s) URL (got ${JSON.stringify(value)})`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`createTestStage: baseUrl (FILMKIT_BASE_URL) must be http(s) (got ${JSON.stringify(value)})`);
  }
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

// `https://app.example.com/dash?x=1` onto base `https://preview.example.dev/pr-7/` is
// `https://preview.example.dev/pr-7/dash?x=1`.
function rebase(url, base) {
  const u = new URL(url);
  return new URL(u.pathname.replace(/^\/+/, '') + u.search + u.hash, base).href;
}

// How a step title shows what open()/goto() loaded: a local file by its path from the serve root.
function shownUrl(url, local) {
  if (!local) return url;
  return decodeURIComponent(url.slice(LOCAL_ORIGIN.length + 1));
}

const quote = (s) => JSON.stringify(String(s).length > 60 ? `${String(s).slice(0, 57)}...` : String(s));

/**
 * The stage a flow gets under Playwright Test. The emitted spec calls it once per test.
 * @param {object} o
 * @param {import('@playwright/test').Page} o.page the test's page fixture
 * @param {object} o.test the `test` the spec imported (used for test.step and annotations)
 * @param {object} [o.expect] the spec's `expect`. Accepted so a later version can use it without a
 *   spec change; v1 checkpoints run the shared decision loop instead (header, THE TEXT RULE), so the
 *   camera and the test cannot disagree about a match.
 * @param {string|URL} [o.serveRoot] directory local paths resolve against and are served from
 * @param {string} [o.baseUrl] FILMKIT_BASE_URL (header, ENVIRONMENT)
 * @param {number|string} [o.pauseScale] FILMKIT_PAUSE_SCALE (header, ENVIRONMENT); default 0
 */
export function createTestStage({ page, test, expect, serveRoot, baseUrl, pauseScale } = {}) {
  if (!page || typeof page.goto !== 'function') throw new TypeError('createTestStage: `page` must be the Playwright Page of the running test');
  if (!test || typeof test.step !== 'function') {
    throw new TypeError("createTestStage: pass the `test` your spec imported from '@playwright/test' (its test.step titles the report)");
  }
  void expect; // reserved (see the JSDoc above); v1 does not call it
  const root = serveRoot === undefined || serveRoot === null ? null : localRoot(serveRoot);
  const scale = parsePauseScale(pauseScale);
  const base = parseBaseUrl(baseUrl);

  /** @type {'idle'|'ready'} */
  let state = 'idle';
  let caption = null; // the caption notionally up; prefixes step titles
  let mouseAt = null; // where the real mouse was last driven; null until the first move
  let filmedOrigin = null; // origin of the URL open() loaded, before any rebase (FILMKIT_BASE_URL)
  let routed = false;
  const outcomes = [];
  const t0 = Date.now();
  const since = () => (Date.now() - t0) / 1000;

  function requireOpen() {
    if (state !== 'ready') throw new Error('stage: no app loaded yet — call stage.open(url) first');
  }

  // For the verbs that are not steps (caption, clearCaption, an unscaled pause): the same state check,
  // with the error's stack pointed at the flow's line. Without it Playwright's code frame shows the
  // first user frame of the stack, which is this file (the copy sits next to the spec).
  function requireOpenAt(location) {
    try {
      requireOpen();
    } catch (err) {
      if (location) err.stack = `${err.name}: ${err.message}\n    at ${location.file}:${location.line}:${location.column}`;
      throw err;
    }
  }

  // A step's title and options. Every verb below is an `async` function that itself awaits
  // test.step(title(...), body, stepOptions(location)), with no helper in between, and that shape is
  // load-bearing: a boxed step's error stack is the stack at the step's creation minus its first user
  // frame (Playwright assumes that frame is the helper that called test.step). MEASURED on 1.60: the
  // stack is captured after an await inside test.step, so it is the ASYNC chain, where only awaiting
  // functions appear. With the verb awaiting test.step, the verb is that first frame and the error
  // points at the flow's line; with a synchronous helper in between, the flow's frame was the one
  // dropped and a failure pointed at the spec's `await flow({ stage })`.
  const title = (text) => (caption ? `${caption} › ${text}` : text);
  const stepOptions = (location) => (location ? { box: true, location } : { box: true });

  // A film-pace hold, only when pauseScale > 0.
  async function hold(ms) {
    if (scale > 0 && ms > 0) await page.waitForTimeout(ms * scale);
  }

  // What open()/goto() will load, decided synchronously so the step title can show it: the filmed
  // origin rebased under FILMKIT_BASE_URL, else a local file served from the root. Throws (inside
  // the step) for a local file outside the root. `open` records the filmed origin.
  function plan(urlOrPath, verb) {
    const { url, local } = resolveOpenTarget(urlOrPath, root, verb);
    const origin = new URL(url).origin;
    if (verb === 'open') filmedOrigin = origin;
    if (base && origin === filmedOrigin) {
      const rebased = rebase(url, base);
      return { url: rebased, local: null, shown: rebased };
    }
    return { url, local, shown: shownUrl(url, local) };
  }

  function planOrError(urlOrPath, verb) {
    try {
      return plan(urlOrPath, verb);
    } catch (err) {
      return { error: err, shown: String(urlOrPath) };
    }
  }

  async function load(planned, verb, { timeoutMs, readySelector }) {
    if (planned.error) throw planned.error;
    if (planned.local && !routed) {
      await routeLocalFiles(page, root);
      routed = true;
    }
    await navigate(page, planned.url, { timeoutMs, verb, local: planned.local });
    if (readySelector) await waitForCss(page, readySelector, { timeoutMs });
  }

  // The real mouse walks the film cursor's line: from the viewport center on the first move (where
  // the film cursor starts, unless open()'s `cursorAt` placed it), from wherever it was after that.
  async function moveMouse(x, y) {
    if (mouseAt === null) {
      const vp = page.viewportSize() ?? { width: 1280, height: 720 };
      await page.mouse.move(vp.width / 2, vp.height / 2);
    }
    await page.mouse.move(x, y, { steps: MOUSE_STEPS });
    mouseAt = { x, y };
  }

  async function clickTarget(target, timeoutMs) {
    const { x, y } = boxCenter(await resolveVisibleBox(page, target, { timeoutMs }));
    await moveMouse(x, y);
    await clickAt(page, x, y);
  }

  const probe = (target, opts) => probeTarget(page, target, opts);

  const stage = {
    /** 'test': this stage runs a flow under Playwright Test. The camera's stage says 'film'. */
    get mode() {
      return 'test';
    },

    /** The Playwright Page, as under `--browser playwright`. */
    get page() {
      return page;
    },

    /** Authored holds are a film concept; a test run records none. */
    get timeline() {
      return [];
    },

    /** One record per oneOf(): { name, outcome, options, accept, filmAccept, start, end }, seconds
     *  since this stage was created. The spec attaches it as `filmkit-outcomes`. */
    get outcomes() {
      return outcomes;
    },

    // `cursorAt`: the film cursor's starting point (lib/stage.mjs open()). The real mouse goes there too,
    // without steps, as on film, so a hover state the opening frame shows is there in the test as well,
    // and the next move walks the film cursor's line from it.
    async open(urlOrPath, { readySelector, timeoutMs = NAVIGATION_TIMEOUT_MS, settleMs = FILM_SETTLE_MS_START, cursorAt } = {}) {
      const location = callerLocation();
      const planned = state === 'ready' ? { shown: String(urlOrPath) } : planOrError(urlOrPath, 'open');
      return await test.step(title(`open ${planned.shown}`), async () => {
        if (state === 'ready') throw new Error('stage.open: already opened — use stage.goto(url) to navigate again');
        await load(planned, 'open', { timeoutMs, readySelector });
        state = 'ready';
        if (cursorAt !== undefined) {
          const { x, y } = boxCenter(await resolveVisibleBox(page, cursorAt, { timeoutMs }));
          await page.mouse.move(x, y);
          mouseAt = { x, y };
        }
        await hold(settleMs);
      }, stepOptions(location));
    },

    async goto(urlOrPath, { readySelector, timeoutMs = NAVIGATION_TIMEOUT_MS, settleMs = FILM_SETTLE_MS_START } = {}) {
      const location = callerLocation();
      const planned = planOrError(urlOrPath, 'goto');
      return await test.step(title(`goto ${planned.shown}`), async () => {
        requireOpen();
        await load(planned, 'goto', { timeoutMs, readySelector });
        await hold(settleMs);
      }, stepOptions(location));
    },

    async waitFor(target, options) {
      const location = callerLocation();
      return await test.step(title(`wait for ${describeTarget(target)}`), async () => {
        requireOpen();
        const timeoutMs = targetBudget(options, 'waitFor');
        await resolveVisibleBox(page, target, { timeoutMs });
      }, stepOptions(location));
    },

    async expect(target, options = {}) {
      const location = callerLocation();
      const text = options && typeof options === 'object' ? options.text : undefined;
      const what = typeof text === 'string' ? `expect ${describeTarget(target)} to contain ${quote(text)}` : `expect ${describeTarget(target)}`;
      return await test.step(title(what), async () => {
        requireOpen();
        const args = expectArgs(target, options);
        const { index, last } = await pollTargets([target], { text: args.text, timeoutMs: args.timeoutMs, probe });
        if (index === null) {
          throw new Error(expectTimeoutMessage(describeTarget(target), args.timeoutMs, last[0], args.text, page.url()));
        }
      }, stepOptions(location));
    },

    async oneOf(targets, options) {
      const location = callerLocation();
      const name = options && typeof options === 'object' ? options.name : undefined;
      const keys = targets && typeof targets === 'object' ? Object.keys(targets) : [];
      return await test.step(title(`oneOf ${typeof name === 'string' ? JSON.stringify(name) : '(unnamed)'}: ${keys.join(' | ')}`), async () => {
        requireOpen();
        const args = oneOfArgs(targets, options);
        const start = since();
        const { index, last } = await pollTargets(
          args.keys.map((k) => targets[k]),
          { timeoutMs: args.timeoutMs, probe },
        );
        const outcome = index === null ? null : args.keys[index];
        outcomes.push({
          name: args.name,
          outcome,
          options: Object.fromEntries(args.keys.map((k) => [k, describeTarget(targets[k])])),
          accept: [...args.accept],
          filmAccept: [...args.filmAccept],
          start,
          end: since(),
        });
        if (typeof test.info === 'function') {
          test.info().annotations.push({ type: 'filmkit-outcome', description: `${args.name}=${outcome ?? '(timeout)'}` });
        }
        if (outcome === null) {
          const rows = args.keys.map((key, i) => ({ key, target: targets[key], probe: last[i] }));
          throw new Error(oneOfTimeoutMessage(args.name, args.timeoutMs, rows, page.url()));
        }
        if (!args.accept.includes(outcome)) {
          throw new Error(oneOfRejectedMessage(args.name, outcome, targets[outcome], 'accept', args.accept, 'test'));
        }
        return outcome;
      }, stepOptions(location));
    },

    async click(target, options) {
      const location = callerLocation();
      return await test.step(title(`click ${describeTarget(target)}`), async () => {
        const timeoutMs = targetBudget(options, 'click');
        requireOpen();
        await clickTarget(target, timeoutMs);
      }, stepOptions(location));
    },

    async point(target, options) {
      const location = callerLocation();
      return await test.step(title(`point at ${describeTarget(target)}`), async () => {
        const timeoutMs = targetBudget(options, 'point');
        requireOpen();
        const { x, y } = boxCenter(await resolveVisibleBox(page, target, { timeoutMs }));
        await moveMouse(x, y);
      }, stepOptions(location));
    },

    async type(target, text, options) {
      const location = callerLocation();
      return await test.step(title(`type ${quote(text)} into ${describeTarget(target)}`), async () => {
        requireOpen();
        const timeoutMs = targetBudget(options, 'type');
        const pinned = pinTarget(target);
        await clickTarget(pinned, timeoutMs);
        await selectTextIn(page, pinned);
        for (let i = 0; i < text.length; i++) await typeChar(page, text[i]);
      }, stepOptions(location));
    },

    /** Sets the prefix of the steps that follow; draws nothing. */
    async caption(text) {
      requireOpenAt(callerLocation());
      caption = String(text);
    },

    async clearCaption() {
      requireOpenAt(callerLocation());
      caption = null;
    },

    /** Skipped, unless pauseScale > 0: then held for ms x pauseScale, as a step of its own. */
    async pause(ms) {
      const location = callerLocation();
      requireOpenAt(location);
      if (scale <= 0) return;
      return await test.step(title(`pause ${ms}ms (x${scale})`), () => hold(ms), stepOptions(location));
    },
  };
  return stage;
}
