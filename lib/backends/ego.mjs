// ─────────────────────────────────────────────────────────────────────────────
// lib/backends/ego.mjs — films inside the user's RUNNING ego-browser, a Chromium fork that
// shares their real login profile. This file only ever executes inside `ego-browser nodejs`
// (see lib/ego-runner.mjs); it never touches a bare global, everything the ego runtime
// provides arrives as the `globals` argument.
//
// WHY IT LOOKS LIKE THIS — three constraints from that runtime, all of them load-bearing:
//
// 1. NO EXTERNAL CDP ENDPOINT. There is no port to attach Playwright to. Every browser
//    operation goes through `cdp(method, params)` or `js(source)`, and `js` is a raw
//    `Runtime.evaluate`: a source STRING with no argument channel. So every value this file
//    sends into the page is baked into the source with JSON.stringify.
//
// 2. THE EVENT QUEUE IS SHARED AND DESTRUCTIVE. `drainEvents()` returns and CONSUMES every
//    queued CDP event across all domains. Screencast capture needs a drain loop running for
//    the whole take, which means ego's own high-level helpers (`gotoAndWait`,
//    `waitForElement`, …) cannot be used while the camera rolls — the drain loop would eat
//    the events they are waiting on. So once recording starts this backend uses only `cdp`,
//    `js` and `drainEvents`, and implements navigation/selector waiting itself by polling.
//    The runner may use the high-level helpers freely BEFORE startRecording().
//
// 3. ONE TRANSPORT, MANY CALLERS. The drain loop and the flow's own actions both talk to the
//    same runtime, so every `cdp`/`js` call is serialized through a promise chain (`q`). A
//    frame that is not ACKed stalls delivery permanently, so acks ride that same chain and
//    are issued the moment a frame is seen.
//
// CLOCK: 'frame'. `metadata.timestamp` on a screencastFrame is epoch seconds on the same wall
// clock as Node's `Date.now()/1000` inside this runtime — measured: the first frame after
// startScreencast lands within a few tens of ms of the Date.now() taken just before the call,
// with no constant offset. `now()` therefore just returns `Date.now()/1000`, and the recording's
// zero point is the first captured frame's own timestamp.
//
// TARGETS: CSS-selector strings only. Playwright `Locator`s and `(page) => Locator` functions
// cannot cross into this runtime, and resolveBox says so by name rather than failing obscurely.
// Playwright's `:has-text("…")` pseudo-class IS supported (a small shim below), because flows
// already in the repo are written with it.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { targetTimeoutMessage } from '../target-wait.mjs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const j = JSON.stringify;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

const DRAIN_INTERVAL_MS = 25;
const POLL_INTERVAL_MS = 100;
const DEFAULT_RESOLVE_TIMEOUT_MS = 10000;
const FIRST_FRAME_TIMEOUT_MS = 5000;
const URL_PROBE_TIMEOUT_MS = 5000;

// Read a JPEG's real pixel dimensions out of its SOF marker. This, not `pageInfo()` and not the
// frame metadata, is what ffmpeg will actually encode — so it is what the geometry check has to
// assert on. Walks the marker chain rather than guessing at offsets; returns null on anything it
// does not understand, which the caller treats as a failure like any other wrong size.
function jpegSize(buf) {
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

// A HEAD from THIS process (node inside the ego runtime, which can reach 127.0.0.1 just fine).
// See resolveOpenUrl for why the check exists at all.
function headStatus(url) {
  return new Promise((resolveP) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolveP(v);
      }
    };
    try {
      const send = url.startsWith('https:') ? httpsRequest : httpRequest;
      const req = send(url, { method: 'HEAD', timeout: URL_PROBE_TIMEOUT_MS }, (res) => {
        res.resume();
        finish({ status: res.statusCode });
      });
      req.on('timeout', () => {
        req.destroy();
        finish({ error: `timed out after ${URL_PROBE_TIMEOUT_MS}ms` });
      });
      req.on('error', (err) => finish({ error: err.message }));
      req.end();
    } catch (err) {
      finish({ error: err.message });
    }
  });
}

// ── The selector shim ────────────────────────────────────────────────────────────────────
// Plain CSS goes straight to document.querySelector. A selector containing Playwright's
// `:has-text("…")` is evaluated segment by segment: each whitespace/`>`-separated compound may
// carry one `:has-text(...)`, which filters that compound's matches by (case-insensitive,
// substring) textContent — the same rule Playwright uses. Deliberately NOT a full Playwright
// selector engine: `>` and descendant combinators only, one has-text per compound, no
// `:nth-match`, no `text=` engines. Anything richer than that belongs in --browser playwright.
const QUERY_SHIM = String.raw`
const __fkHasText = /:has-text\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\)/;
function __fkSplit(sel) {
  const out = []; let cur = ''; let depth = 0; let quote = null;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (quote) { cur += c; if (c === '\\') { cur += sel[++i] || ''; } else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (depth === 0 && /\s/.test(c)) { if (cur) out.push(cur); cur = ''; continue; }
    if (depth === 0 && c === '>') { if (cur) out.push(cur); out.push('>'); cur = ''; continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}
function __fkQuery(sel) {
  if (sel.indexOf(':has-text(') === -1) return document.querySelector(sel);
  const segs = __fkSplit(sel);
  let roots = [document];
  let child = false;
  for (const seg of segs) {
    if (seg === '>') { child = true; continue; }
    const m = seg.match(__fkHasText);
    let base = (m ? seg.replace(__fkHasText, '') : seg).trim() || '*';
    if (child) base = ':scope > ' + base;
    const needle = m ? (m[1] !== undefined ? m[1] : m[2]).replace(/\\(.)/g, '$1').trim().toLowerCase() : null;
    const next = [];
    for (const r of roots) {
      for (const el of r.querySelectorAll(base)) {
        if (needle !== null && (el.textContent || '').trim().toLowerCase().indexOf(needle) === -1) continue;
        if (next.indexOf(el) === -1) next.push(el);
      }
    }
    next.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    roots = next;
    child = false;
    if (!roots.length) return null;
  }
  return roots[0] || null;
}`;

// Chromium wants a plausible key identity alongside the text, or some inputs ignore the event.
// Anything outside these ranges still inserts, because a keyDown carrying `text` is a char event.
function keyInfoFor(ch) {
  if (ch >= 'a' && ch <= 'z') return { code: 'Key' + ch.toUpperCase(), keyCode: ch.toUpperCase().charCodeAt(0), modifiers: 0 };
  if (ch >= 'A' && ch <= 'Z') return { code: 'Key' + ch, keyCode: ch.charCodeAt(0), modifiers: 8 }; // 8 = Shift
  if (ch >= '0' && ch <= '9') return { code: 'Digit' + ch, keyCode: ch.charCodeAt(0), modifiers: 0 };
  if (ch === ' ') return { code: 'Space', keyCode: 32, modifiers: 0 };
  return { code: undefined, keyCode: undefined, modifiers: 0 };
}

/**
 * @param {object} o
 * @param {object} o.globals the ego runtime's helpers, passed in explicitly: {cdp, js, drainEvents, wait, cliLog, ...}
 * @param {{width:number,height:number}} o.viewport
 * @param {string} o.workDir where frames/ is written
 * @param {string} [o.serverOrigin] loopback static-server origin (already token-prefixed)
 * @param {string} [o.serverRoot] the directory that origin serves
 * @param {(msg: string) => void} [o.log]
 */
export function createEgoBackend({ globals, viewport, workDir, serverOrigin, serverRoot, log = () => {} }) {
  const g = globals;
  const framesDir = join(workDir, 'frames');

  // ── One transport, one queue (constraint 3 above). Every cdp/js call goes through here. ──
  let chain = Promise.resolve();
  function q(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }
  const cdp = (method, params = {}) => q(() => g.cdp(method, params));
  const evaluate = (source) => q(() => g.js(source));

  /** @type {Array<{file: string, t: number}>} */
  const frames = [];
  const pendingWrites = [];
  let frameSeq = 0;
  let drainTimer = null;
  let tickInFlight = null;
  let drainError = null; // ONLY a drainEvents() failure — see drainTick
  let writeError = null; // first frame-to-disk failure, surfaced at stopRecording
  let ackFailures = 0;
  let clockFallbacks = 0;
  let firstFrameSize = null;
  let recStartT = 0;
  let stopT = 0;
  let recording = false;
  let closed = false;

  // ONE FAILURE MUST NOT COST THE WHOLE BATCH. `drainEvents()` is destructive: by the time this
  // loop runs, the frames in `events` are gone from the queue and exist nowhere else. So the only
  // thing allowed to throw out of here is the drain itself — every per-frame step is contained,
  // counted, and reported at stopRecording, where there is a whole take's worth of context to
  // report it against instead of an exception from inside a setInterval.
  async function drainTick() {
    const events = await q(() => g.drainEvents());
    for (const ev of events || []) {
      if (ev?.method !== 'Page.screencastFrame') continue;
      const p = ev.params || {};
      // ACK FIRST, ALWAYS. An un-acked frame stops delivery for the rest of the take, so the ack
      // must not sit behind the disk write (fired off below, awaited at stop). A failed ack is
      // bad — delivery may stall — but it is not a reason to drop the frames already in hand.
      try {
        await q(() => g.cdp('Page.screencastFrameAck', { sessionId: p.sessionId }));
      } catch {
        ackFailures++;
      }
      if (!p.data) continue;
      const t = p.metadata?.timestamp;
      // A frame with no usable timestamp cannot be placed on the recording clock, and guessing
      // with Date.now() would silently shift everything after it relative to the timeline that
      // tighten protects. Count it; stopRecording refuses the take.
      if (!Number.isFinite(t)) clockFallbacks++;
      const buf = Buffer.from(p.data, 'base64');
      const file = String(++frameSeq).padStart(6, '0') + '.jpg';
      if (frameSeq === 1) firstFrameSize = jpegSize(buf);
      frames.push({ file, t: Number.isFinite(t) ? t : Date.now() / 1000 });
      pendingWrites.push(
        writeFile(join(framesDir, file), buf).catch((err) => {
          // Unhandled, this rejection kills the whole ego runtime under Node's default policy:
          // no `[filmkit] error` line, no task-space release, the run just stops existing.
          writeError = writeError || err;
        }),
      );
    }
  }

  function scheduleDrain() {
    drainTimer = setInterval(() => {
      if (tickInFlight) return;
      tickInFlight = drainTick()
        .catch((err) => {
          drainError = err;
        })
        .finally(() => {
          tickInFlight = null;
        });
    }, DRAIN_INTERVAL_MS);
  }

  function boxSource(selector) {
    return `(() => {
      ${QUERY_SHIM}
      const el = __fkQuery(${j(selector)});
      if (!el) return { found: false };
      const vw = window.innerWidth, vh = window.innerHeight;
      let r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        r = el.getBoundingClientRect();
      }
      const cs = window.getComputedStyle(el);
      const visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' &&
        cs.display !== 'none' && Number(cs.opacity) > 0;
      return { found: true, visible, x: r.x, y: r.y, width: r.width, height: r.height };
    })()`;
  }

  const pageHandle = {
    /** Page-side JS as an expression STRING — `js()` is Runtime.evaluate, there is no arg channel. */
    evaluate: (source) => evaluate(source),
    waitForSelector: (css, opts) => backend.waitForSelector(css, opts),
    /** RAW navigation: no overlay restore, no caption carried over. Prefer `stage.goto()`, which
     *  does both. This exists for a flow that needs to move the tab without the stage dressing
     *  the result — the cursor comes back on the next cursor move either way. */
    goto: (url, opts) => backend.goto(url, opts),
  };

  const backend = {
    clock: 'frame',

    get page() {
      return pageHandle;
    },

    /** Pin the viewport so captured frames are exactly the requested size, whatever the real
     *  ego window is, and park the tab on a blank document so the take does not open on the
     *  user's new-tab page. The tab itself is opened by the runner (openOrReuseTab) before this. */
    async launch() {
      await mkdir(framesDir, { recursive: true });
      await cdp('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp('Page.navigate', { url: 'about:blank' });
      await sleepMs(200);
      // WHITEN THE BLANK PAGE, or every ego take opens on a black flash. ego-browser runs the
      // user's real profile, and in a dark-mode profile `about:blank` is painted #121212 — the
      // screencast captures it at luminance 18/255. Measured: it is not a paint race (a 1500ms
      // settle produces the identical 7580-byte dark frame) and
      // Emulation.setDefaultBackgroundColorOverride has no effect on it here. Setting a
      // background on the blank document itself does: the same probe then captures 255/255.
      // Playwright's headless blank page is white, so this also matches the two cameras' heads.
      //
      // THIS MUST NOT REACH THE FILMED PAGE. Whitening via Emulation.setEmulatedMedia
      // ({name:'prefers-color-scheme', value:'light'}) would be the obvious way and is the wrong
      // one: it is session-scoped, so an app that honours prefers-color-scheme would be filmed in
      // its LIGHT theme while the user's profile is dark, and the footage would be showing an app
      // the user does not have. What is written here is an inline style on the about:blank
      // document's own root element. A navigation replaces that document, so nothing survives
      // into the take — verified by filming a page whose only styling is
      // `@media (prefers-color-scheme: dark)` and confirming it renders dark on camera.
      await evaluate(
        "(() => { const d = document.documentElement; d.style.background = '#ffffff'; " +
          "if (document.body) document.body.style.background = '#ffffff'; return true; })()",
      ).catch(() => {});
      await sleepMs(120); // let the white actually composite before the camera can roll
      const info = await q(() => g.pageInfo());
      if (info && (info.w !== viewport.width || info.h !== viewport.height)) {
        log(`pageInfo reports ${info.w}x${info.h}, asked for ${viewport.width}x${viewport.height}`);
      }
    },

    /** ego-browser runs the user's real profile, where file:// is not a URL we want to point it
     *  at. Local paths are served instead, over a loopback http server film-web.mjs starts and
     *  roots at the flow file's directory unless `--serve-root` says otherwise — that root is the
     *  cap, and it is enforced here (the backend) as well as by the server's own traversal guard.
     *  A path outside it is refused by name rather than silently widening what a filming run can
     *  read off disk: widening is the operator's call, spelled `--serve-root`, not something a
     *  flow can do by naming a path. */
    async resolveOpenUrl(urlOrPath) {
      if (typeof urlOrPath !== 'string') throw new Error('stage.open: expected a URL or path string');
      if (/^https?:\/\//.test(urlOrPath)) {
        // Same check for a flow-supplied URL, but a softer policy: a server that refuses HEAD
        // (405) or is unreachable to a HEAD yet fine to a real navigation is somebody else's
        // business, and blocking a take on it would be this tool overreaching. A 4xx/5xx is not
        // ambiguous, though — that take would film an error page.
        const probe = await headStatus(urlOrPath);
        if (probe.status !== undefined && probe.status !== 405 && (probe.status < 200 || probe.status >= 400)) {
          throw new Error(`stage.open: ${urlOrPath} answered ${probe.status} — refusing to film an error page.`);
        }
        return urlOrPath;
      }
      const path = urlOrPath.startsWith('file:') ? fileURLToPath(urlOrPath) : resolve(serverRoot || '/', urlOrPath);
      if (!serverOrigin || !serverRoot) {
        throw new Error(`stage.open: no local file server is running, cannot serve ${path}`);
      }
      const rel = relative(serverRoot, path);
      if (!rel || rel.startsWith('..' + sep) || rel === '..' || resolve(serverRoot, rel) !== path) {
        throw new Error(
          `stage.open: ${path} is outside the directory this run can serve (${serverRoot}).\n` +
            "  --browser ego serves local files over loopback, rooted at the flow file's own\n" +
            '  directory by default. Pass --serve-root <dir> to root it somewhere that contains\n' +
            '  this file, or use an http(s) URL, or film with --browser playwright.',
        );
      }
      const url = `${serverOrigin}/${rel.split(sep).map(encodeURIComponent).join('/')}`;
      // A MISSING FILE MUST NOT FILM. Without this the loopback server's 404 body loads as a
      // perfectly valid document, `document.readyState` reaches "complete", every wait is
      // satisfied, and the run produces 25 seconds of a blank page and exits 0 — the worst
      // possible outcome for a tool whose job is to produce evidence. One HEAD from this process
      // (node inside the ego runtime reaches 127.0.0.1 like anything else) settles it before a
      // single frame is spent, and the message names the path, not the URL, because the path is
      // what the flow author wrote.
      const probe = await headStatus(url);
      if (probe.error) {
        throw new Error(`stage.open: the local file server did not answer for ${path} (${probe.error})`);
      }
      if (probe.status < 200 || probe.status >= 300) {
        throw new Error(
          `stage.open: ${path} is not readable — the local file server answered ${probe.status}.\n` +
            `  Serving from ${serverRoot}; check the path exists and is a file.`,
        );
      }
      return url;
    },

    /** Navigation by hand, because the drain loop owns the event queue (constraint 2). Polls for
     *  a completed document that is no longer the one we started from. */
    async goto(url, { timeoutMs = 20000 } = {}) {
      const before = await evaluate('(() => location.href)()').catch(() => null);
      const target = (() => {
        try {
          return new URL(url).href;
        } catch {
          return url;
        }
      })();
      await cdp('Page.navigate', { url });
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const state = await evaluate('(() => ({ ready: document.readyState, href: location.href }))()').catch(() => null);
        if (state && state.ready === 'complete' && (state.href === target || state.href !== before)) return;
        if (Date.now() > deadline) throw new Error(`stage.open: ${url} did not finish loading within ${timeoutMs}ms`);
        await sleepMs(POLL_INTERVAL_MS);
      }
    },

    async waitForSelector(css, { timeoutMs = 20000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = await evaluate(`(() => { ${QUERY_SHIM} return !!__fkQuery(${j(css)}); })()`).catch(() => false);
        if (found) return;
        if (Date.now() > deadline) throw new Error(`stage: selector never appeared within ${timeoutMs}ms — ${css}`);
        await sleepMs(POLL_INTERVAL_MS);
      }
    },

    evaluate,

    async addInitScript(source) {
      await cdp('Page.addScriptToEvaluateOnNewDocument', { source });
    },

    async mouseMove(x, y) {
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0 });
    },

    async click(x, y) {
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    },

    async typeChar(ch) {
      const { code, keyCode, modifiers } = keyInfoFor(ch);
      await cdp('Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: ch,
        unmodifiedText: ch,
        key: ch,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
        modifiers,
      });
      await cdp('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: ch,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
        modifiers,
      });
    },

    /** The field was just clicked into, so the focused element IS the target. Selecting its
     *  existing text is a selection operation, not a value assignment — the subsequent real
     *  keystrokes are what replace the content. */
    async selectAllIn() {
      await evaluate(
        '(() => { const el = document.activeElement; if (el && typeof el.select === "function") el.select(); return true; })()',
      );
    },

    async resolveBox(target, { timeoutMs = DEFAULT_RESOLVE_TIMEOUT_MS } = {}) {
      if (typeof target !== 'string') {
        const kind = typeof target === 'function' ? 'a (page) => Locator function' : 'a Playwright Locator';
        const shown = String(target).replace(/\s+/g, ' ').slice(0, 160);
        throw new Error(
          `stage: --browser ego resolves CSS-selector strings only, but this flow passed ${kind}:\n` +
            `    ${shown}\n` +
            '  Rewrite it as a CSS selector (Playwright\'s :has-text("…") is supported), or film it ' +
            'with --browser playwright.',
        );
      }
      // THE AUTO-WAIT. Both halves of "ready" are one page-side check (boxSource): `found` covers
      // "not in the DOM yet", `visible` covers "in the DOM but zero-size / display:none /
      // visibility:hidden / opacity 0". Polling, not events, because the CDP event queue is
      // already owned by the screencast drain loop.
      const deadline = Date.now() + timeoutMs;
      let last = null;
      for (;;) {
        last = await evaluate(boxSource(target)).catch(() => null); // a commit mid-poll is not a failure
        if (last?.found && last.visible) return { x: last.x, y: last.y, width: last.width, height: last.height };
        if (Date.now() > deadline) break;
        await sleepMs(POLL_INTERVAL_MS);
      }
      throw new Error(targetTimeoutMessage(target, timeoutMs, !!last?.found, await backend.currentUrl()));
    },

    async currentUrl() {
      return (await evaluate('(() => location.href)()').catch(() => null)) || '(unknown)';
    },

    async waitForDocumentReady({ timeoutMs = 20000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const ready = await evaluate('(() => document.readyState)()').catch(() => null);
        if (ready === 'complete') return;
        if (Date.now() > deadline) throw new Error(`stage: document did not finish loading within ${timeoutMs}ms`);
        await sleepMs(POLL_INTERVAL_MS);
      }
    },

    sleep: sleepMs,

    /** Epoch seconds — the same wall clock screencastFrame metadata.timestamp uses. */
    now() {
      return Date.now() / 1000;
    },

    async startRecording() {
      await q(() => g.drainEvents()); // drop anything queued from setup before the camera rolls
      recStartT = Date.now() / 1000;
      await cdp('Page.startScreencast', {
        format: 'jpeg',
        quality: 90,
        maxWidth: viewport.width,
        maxHeight: viewport.height,
        everyNthFrame: 1,
      });
      recording = true;
      scheduleDrain();

      // BLOCK UNTIL FRAME 1, AND CHECK IT. Every later frame is the same size as this one, so a
      // geometry mismatch is knowable now — before the flow spends thirty seconds filming
      // something that will be assembled at the wrong resolution and only noticed by ffprobe
      // afterwards. pageInfo() is not the authority here and neither is the frame metadata: the
      // JPEG's own SOF dimensions are what ffmpeg will encode.
      const deadline = Date.now() + FIRST_FRAME_TIMEOUT_MS;
      while (!frames.length) {
        if (drainError) throw new Error(`screencast capture failed before the first frame: ${drainError.message}`);
        if (Date.now() > deadline) {
          throw new Error(
            `screencast produced no frame within ${FIRST_FRAME_TIMEOUT_MS}ms of starting — ` +
              'the tab may be discarded or occluded in a way that suspends compositing.',
          );
        }
        await sleepMs(25);
      }
      if (!firstFrameSize || firstFrameSize.width !== viewport.width || firstFrameSize.height !== viewport.height) {
        const got = firstFrameSize ? `${firstFrameSize.width}x${firstFrameSize.height}` : 'unreadable';
        throw new Error(
          `screencast frames are ${got}, not the requested ${viewport.width}x${viewport.height}. ` +
            'Emulation.setDeviceMetricsOverride did not take — refusing to film at the wrong size.',
        );
      }
    },

    async stopRecording() {
      if (drainTimer) clearInterval(drainTimer);
      drainTimer = null;
      if (tickInFlight) await tickInFlight.catch(() => {});
      await cdp('Page.stopScreencast', {}).catch(() => {});
      await drainTick().catch((err) => {
        drainError = drainError || err;
      });
      // stopT is the moment CAPTURE ended, not the moment the disk caught up. It becomes the last
      // frame's on-screen duration, so folding the write flush into it would pad the tail of every
      // take by however long the filesystem took.
      stopT = Date.now() / 1000;
      await Promise.all(pendingWrites);
      recording = false;
      if (drainError) throw new Error(`screencast capture failed: ${drainError.message}`);
      if (writeError) throw new Error(`could not write captured frames to ${framesDir}: ${writeError.message}`);
      if (clockFallbacks) {
        throw new Error(
          `${clockFallbacks} of ${frames.length} captured frame(s) arrived with no usable ` +
            'metadata.timestamp. The recording clock, and every caption range measured against ' +
            'it, would be wrong — refusing the take rather than shipping a timeline that lies.',
        );
      }
      if (!frames.length) throw new Error('screencast captured no frames — nothing to assemble');
      if (ackFailures) log(`${ackFailures} screencast frame ack(s) failed — delivery may have stalled`);
      return {
        kind: 'frames',
        dir: framesDir,
        frames,
        t0: frames[0].t,
        stopT,
        // Sanity value, logged by the runner: how far the first real frame trailed the
        // startScreencast call on the SAME clock. Large values here would mean the two clocks
        // are not the same one, and the timeline would be wrong.
        firstFrameLagSec: frames[0].t - recStartT,
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      if (drainTimer) clearInterval(drainTimer);
      drainTimer = null;
      if (tickInFlight) await tickInFlight.catch(() => {});
      if (recording) await cdp('Page.stopScreencast', {}).catch(() => {});
      recording = false;
      await Promise.all(pendingWrites).catch(() => {});
    },
  };

  return backend;
}
