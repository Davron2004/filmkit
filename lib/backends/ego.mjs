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
// FRAMES: what happens to a frame once it has been drained — numbering, its timestamp in the file
// name, the JPEG-size check, write errors, what makes a take untrustworthy — is lib/frames.mjs's,
// shared with the Playwright backend (both record over CDP screencast now). This file owns only
// how frames arrive: the drain loop over the shared event queue. partialRecording() is what the
// salvage path takes after a failed or interrupted flow (capture halted, frames on disk, no
// validation); close() halts capture the same way and never deletes a frame.
//
// TARGETS: CSS-selector strings only. Playwright `Locator`s and `(page) => Locator` functions
// cannot cross into this runtime, and resolveBox says so by name rather than failing obscurely.
// Playwright's `:has-text("…")` pseudo-class IS supported (a small shim below), because flows
// already in the repo are written with it.
//
// TWO WAYS TO LOOK AT A TARGET, one visibility rule (VISIBLE_SHIM). resolveBox is the auto-wait for
// an action: it polls, brings the target to a comfortable position (THE REVEAL in
// lib/scenario/filmkit-stage.mjs, the same page-side function the Playwright camera runs, here as
// source text; until 2026-10-06 this file scrolled only a target ENTIRELY off screen, instantly, so a
// half-visible one under the caption stayed there), and throws on timeout. probe is one look for the stage's expect()/oneOf() poll loops: it never scrolls, since
// those loops run while the camera holds on a page that must not move under the viewer, and it
// never throws. With `{ text }` it also reads the element's textContent; whether that matches is
// decided by lib/target-wait.mjs's text rule, shared with the Playwright backend.
//
// LOCAL FILES, the same rule as the Playwright camera and test mode, by the same function
// (resolveOpenTarget, lib/scenario/filmkit-stage.mjs): a relative path resolves against the serve
// root, a `file:` URL keeps its `?query` and `#hash`, a path outside the root is refused before
// anything navigates, and the root itself opens (its index.html). Only the origin differs: the
// other two serve at http://filmkit.localhost through page.route, this one at the loopback server
// film-web starts, http://<token>.localhost:<port> (lib/static-server.mjs holds its guard). Both
// serve at the origin ROOT, so a page's root-absolute `/app.js` resolves inside the serve root on
// every camera.
//
// STAGE.PAGE.EVALUATE: a flow's `stage.page.evaluate(...)` behaves as Playwright's does, so a flow that
// uses it runs unchanged on both cameras. `js()` does NOT have those semantics, MEASURED (ego-browser
// 0.5.1.13): a source containing `return` that is not a leading IIFE is run as a FUNCTION BODY, so
// `'["a"].map(p => { return p })'` came back null (no top-level return) and `'return 5'` came back 5
// (Playwright: a SyntaxError); a function value came back {} and NaN came back null (plain JSON). So
// the flow-facing evaluate ships a leading async IIFE (passed through by js() untouched, measured) that
// does what Playwright 1.60 does, ported in evaluateSource(): an INDIRECT eval of the string
// (statements allowed, the completion value returned, global scope: `let x = 1; x` works twice), a call
// with the one argument when a FUNCTION was passed, one await of a thenable, and Playwright's value
// serializer on both sides (NaN, -0, Date, RegExp, bigint, undefined in an array, circular objects,
// `ref: <Node>` for a DOM node). A function-VALUED string is not called, as on Playwright
// (`'() => 3'` is undefined on both). An error thrown in the page rejects with `page.evaluate: <the
// page's error>`. The eval runs under a strict CSP without 'unsafe-eval' on both browsers (measured:
// code evaluated over CDP may eval). A 77-shape matrix agrees with Playwright on every value; only
// an Error's stack text differs. This backend's own page-side calls keep using `js()` directly: they
// are all leading IIFEs, where the two semantics agree.
//
// NAVIGATION STATUS: the navigation's own response decides, as on the Playwright camera: a 4xx/5xx
// fails the flow after the page loads, a network error (Page.navigate's `errorText`) at once. There
// is no HEAD before navigating any more (there was until 2026-09-29), for any URL. MEASURED, why
// not: the HEAD came from node inside the runtime, which has none of the browser profile's cookies,
// and signing in is what ego is for. A page that answered 401 to that HEAD answered 200 to the
// profile's own navigation, so the old check refused a take that would have filmed fine.
// The status is read in the page, off `performance.getEntriesByType('navigation')[0].responseStatus`,
// because the drain loop owns the CDP event queue (constraint 2) and Network.responseReceived
// cannot be waited on. MEASURED in Chromium 152: 200 and 404 read back exactly; an EMPTY-bodied 404
// comes back from Page.navigate as `net::ERR_HTTP_RESPONSE_CODE_FAILURE` over a chrome-error page
// whose entry still says 404, so that one error text is left to the status check; a same-document
// (hash-only) navigation returns no `loaderId` and loads nothing new.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { collapseWhitespace, targetTimeoutMessage, textMatches } from '../target-wait.mjs';
import { LOCAL_ORIGIN, REVEAL_SETTLE_SOURCE, resolveOpenTarget, revealInPage, revealOptions, revealTarget } from '../scenario/filmkit-stage.mjs';
import { captureFinalShots, createFrameSink, cutOpening, probeLiveness } from '../frames.mjs';

const j = JSON.stringify;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

const DRAIN_INTERVAL_MS = 25;
const POLL_INTERVAL_MS = 100;
const DEFAULT_RESOLVE_TIMEOUT_MS = 10000;
const FIRST_FRAME_TIMEOUT_MS = 5000;
// Page.navigate's errorText for a 4xx/5xx with an empty body (see NAVIGATION STATUS): not a network
// failure, the status check reports it.
const HTTP_STATUS_ERROR_TEXT = 'net::ERR_HTTP_RESPONSE_CODE_FAILURE';

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

// "Visibly laid out", page-side, ONE definition for resolveBox (which then scrolls) and probe
// (which never does): a non-zero box, and not display:none / visibility:hidden / opacity 0 on the
// element itself. Where the box sits relative to the viewport does not enter into it, so the same
// element answers the same way before and after a scroll.
const VISIBLE_SHIM = String.raw`
function __fkVisible(el, r) {
  const cs = window.getComputedStyle(el);
  return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
}`;

// Playwright Locators and `(page) => Locator` functions cannot cross into this runtime. The one
// message for it, used by resolveBox (throws it) and probe (returns it as fatal).
function unsupportedTargetMessage(target) {
  const kind = typeof target === 'function' ? 'a (page) => Locator function' : 'a Playwright Locator';
  const shown = String(target).replace(/\s+/g, ' ').slice(0, 160);
  return (
    `stage: --browser ego resolves CSS-selector strings only, but this flow passed ${kind}:\n` +
    `    ${shown}\n` +
    '  Rewrite it as a CSS selector (Playwright\'s :has-text("…") is supported), or film it ' +
    'with --browser playwright.'
  );
}

// ── stage.page.evaluate, with Playwright's semantics (header, STAGE.PAGE.EVALUATE) ───────────────
// A port of what Playwright 1.60 does for `page.evaluate(pageFunction, arg)`: the normalization of the
// source (client + server), the evaluation (UtilityScript.evaluate: an INDIRECT eval of the string,
// then a call when a function was passed, then one await of a thenable), and the value transport
// (utilityScriptSerializers: serialize in the page, parse outside, which is what keeps NaN, -0, a
// Date, a RegExp, a bigint, undefined inside an array, and a circular object intact). The two value
// functions below are self-contained on purpose: each runs on both sides of the transport (the page
// serializes the result and parses the arg; this file does the reverse), so each is shipped into the
// page as source text with toString(). Only plain JSON crosses: js() returns by value.

/** Playwright's serializeAsCallArgument, without handles: a value -> JSON-safe tagged tree. */
function serializeValue(value) {
  const visited = new Map();
  let lastId = 0;
  const is = (obj, tag, ctor) => {
    try {
      return (typeof ctor === 'function' && obj instanceof ctor) || Object.prototype.toString.call(obj) === `[object ${tag}]`;
    } catch {
      return false;
    }
  };
  const typed = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'];
  const base64 = (view) => {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  };
  const isError = (obj) => {
    try {
      return obj instanceof Error || (obj && Object.getPrototypeOf(obj)?.name === 'Error');
    } catch {
      return false;
    }
  };
  function serialize(v) {
    if (v && typeof v === 'object') {
      if (typeof globalThis.Window === 'function' && v instanceof globalThis.Window) return 'ref: <Window>';
      if (typeof globalThis.Document === 'function' && v instanceof globalThis.Document) return 'ref: <Document>';
      if (typeof globalThis.Node === 'function' && v instanceof globalThis.Node) return 'ref: <Node>';
    }
    return inner(v);
  }
  function inner(v) {
    if (typeof v === 'symbol' || Object.is(v, undefined)) return { v: 'undefined' };
    if (Object.is(v, null)) return { v: 'null' };
    if (Object.is(v, NaN)) return { v: 'NaN' };
    if (Object.is(v, Infinity)) return { v: 'Infinity' };
    if (Object.is(v, -Infinity)) return { v: '-Infinity' };
    if (Object.is(v, -0)) return { v: '-0' };
    if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return v;
    if (typeof v === 'bigint') return { bi: v.toString() };
    if (typeof v !== 'object') return undefined; // a function: dropped, as by Playwright
    if (isError(v)) {
      const head = `${v.name}: ${v.message}`;
      return { e: { n: v.name, m: v.message, s: v.stack?.startsWith(head) ? v.stack : `${head}\n${v.stack}` } };
    }
    if (is(v, 'Date', globalThis.Date)) return { d: v.toJSON() };
    if (is(v, 'URL', globalThis.URL)) return { u: v.toJSON() };
    if (is(v, 'RegExp', globalThis.RegExp)) return { r: { p: v.source, f: v.flags } };
    for (const k of typed) if (is(v, k, globalThis[k])) return { ta: { b: base64(v), k } };
    if (is(v, 'ArrayBuffer', globalThis.ArrayBuffer)) return { ab: { b: base64(new Uint8Array(v)) } };
    const seen = visited.get(v);
    if (seen) return { ref: seen };
    const id = ++lastId;
    visited.set(v, id);
    if (Array.isArray(v)) {
      const a = [];
      for (let i = 0; i < v.length; ++i) a.push(serialize(v[i]));
      return { a, id };
    }
    const o = [];
    for (const k of Object.keys(v)) {
      let item;
      try {
        item = v[k];
      } catch {
        continue;
      }
      if (k === 'toJSON' && typeof item === 'function') o.push({ k, v: { o: [], id: 0 } });
      else o.push({ k, v: serialize(item) });
    }
    try {
      if (o.length === 0 && typeof v.toJSON === 'function') return inner(v.toJSON());
    } catch {
      // a throwing toJSON: the object as it is
    }
    return { o, id };
  }
  return serialize(value);
}

/** Playwright's parseEvaluationResultValue: the tagged tree -> a value. */
function parseValue(value) {
  const refs = new Map();
  const typed = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array };
  const bytes = (b64) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  function parse(v) {
    if (Object.is(v, undefined) || v === null || typeof v !== 'object') return v;
    if ('ref' in v) return refs.get(v.ref);
    if ('v' in v) return { undefined: undefined, null: null, NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': -0 }[v.v];
    if ('d' in v) return new Date(v.d);
    if ('u' in v) return new URL(v.u);
    if ('bi' in v) return BigInt(v.bi);
    if ('e' in v) {
      const err = new Error(v.e.m);
      err.name = v.e.n;
      err.stack = v.e.s;
      return err;
    }
    if ('r' in v) return new RegExp(v.r.p, v.r.f);
    if ('a' in v) {
      const out = [];
      refs.set(v.id, out);
      for (const item of v.a) out.push(parse(item));
      return out;
    }
    if ('o' in v) {
      const out = {};
      refs.set(v.id, out);
      for (const { k, v: item } of v.o) if (k !== '__proto__') out[k] = parse(item);
      return out;
    }
    if ('ta' in v) return new typed[v.ta.k](bytes(v.ta.b).buffer);
    if ('ab' in v) return bytes(v.ab.b).buffer;
    return v;
  }
  return parse(value);
}

/** Playwright's normalizeEvaluationExpression plus the client's isFunction: a function passed is called
 *  with `arg`; a string is an expression, and a function-VALUED string is not called (measured,
 *  Playwright 1.60: `page.evaluate('() => 3')` resolves to undefined). */
function normalizeEvaluation(pageFunction) {
  const isFunction = typeof pageFunction === 'function';
  let source = String(pageFunction).trim();
  if (isFunction) {
    try {
      new Function(`(${source})`);
    } catch {
      // a method shorthand (`foo() {}`, `async foo() {}`): give it the keyword it lacks
      source = source.startsWith('async ') ? `async function ${source.slice('async '.length)}` : `function ${source}`;
      try {
        new Function(`(${source})`);
      } catch {
        throw new Error('page.evaluate: Passed function is not well-serializable!');
      }
    }
  }
  if (/^(async)?\s*function(\s|\()/.test(source)) source = `(${source})`;
  return { source, isFunction };
}

/** The page-side program for one evaluate: a leading async IIFE, the one shape js() passes through
 *  untouched (header, STAGE.PAGE.EVALUATE). It never throws: the page's own error comes back as
 *  `{ threw }` and is rethrown outside, so the message is the page's, not js()'s wrapper text. */
function evaluateSource(pageFunction, arg) {
  const { source, isFunction } = normalizeEvaluation(pageFunction);
  const argTree = isFunction ? JSON.stringify(serializeValue(arg)) : null;
  return `(async () => {
  const __fkSerialize = ${serializeValue.toString()};
  const __fkParse = ${parseValue.toString()};
  let __fkResult;
  try {
    __fkResult = (0, eval)(${j(source)});
    ${isFunction ? `__fkResult = __fkResult(__fkParse(${argTree}));` : ''}
    if (__fkResult && typeof __fkResult === 'object' && typeof __fkResult.then === 'function') __fkResult = await __fkResult;
  } catch (e) {
    const isErr = e instanceof Error || (e && typeof e === 'object' && 'message' in e);
    return { threw: isErr ? { name: String(e.name || 'Error'), message: String(e.message), stack: String(e.stack || '') } : { value: String(e) } };
  }
  try {
    return { value: __fkResult === undefined ? undefined : __fkSerialize(__fkResult) };
  } catch {
    return { value: undefined };
  }
})()`;
}

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
 * @param {string} [o.serverOrigin] loopback static-server origin, `http://<token>.localhost:<port>`
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

  // Frame bookkeeping (numbering, timestamps, JPEG size, write errors, what makes a take
  // untrustworthy) is lib/frames.mjs's, shared with the Playwright backend. This file only decides
  // how frames REACH the sink: by draining the shared CDP event queue.
  const sink = createFrameSink({ framesDir, viewport });
  const frames = sink.frames;
  let drainTimer = null;
  let tickInFlight = null;
  let drainError = null; // ONLY a drainEvents() failure — see drainTick
  let recStartT = 0;
  let stopT = 0;
  let recording = false;
  let closed = false;
  let launching = null;
  // The last local file resolveOpenUrl served, so goto() can name the PATH (what the flow author
  // wrote) rather than the URL when it answers 4xx/5xx. Same shape as the Playwright backend's.
  let lastLocal = null;
  let nextDocumentScript = null; // setNextDocumentScript's current registration

  // ONE FAILURE MUST NOT COST THE WHOLE BATCH. `drainEvents()` is destructive: by the time this
  // loop runs, the frames in `events` are gone from the queue and exist nowhere else. So the only
  // thing allowed to throw out of here is the drain itself — every per-frame step is contained by
  // the sink, counted, and reported at stopRecording, where there is a whole take's worth of
  // context to report it against instead of an exception from inside a setInterval.
  async function drainTick() {
    const events = await q(() => g.drainEvents());
    for (const ev of events || []) {
      if (ev?.method !== 'Page.screencastFrame') continue;
      await sink.accept(ev.params, (sessionId) => q(() => g.cdp('Page.screencastFrameAck', { sessionId })));
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

  // Where the target is NOW, without moving anything: resolveBox reads it before and after THE REVEAL.
  function boxSource(selector) {
    return `(() => {
      ${QUERY_SHIM}
      ${VISIBLE_SHIM}
      const el = __fkQuery(${j(selector)});
      if (!el) return { found: false };
      const r = el.getBoundingClientRect();
      const visible = __fkVisible(el, r);
      return { found: true, visible, x: r.x, y: r.y, width: r.width, height: r.height };
    })()`;
  }

  // THE REVEAL (lib/scenario/filmkit-stage.mjs), the same page-side function the Playwright camera and
  // test mode hand to locator.evaluate, here as source text: Runtime.evaluate has no argument channel.
  // It only STARTS the scroll and returns at once; resolveBox sleeps through the animation, so the
  // screencast acks keep flowing on the shared queue (constraint 3) and the scroll is filmed.
  function revealSource(selector, reveal) {
    return `(() => {
      ${QUERY_SHIM}
      return (${revealInPage.toString()})(__fkQuery(${j(selector)}), ${j(revealOptions(reveal))});
    })()`;
  }

  // boxSource without the scroll: probe() runs in a poll loop while the camera rolls, and a scroll
  // there would move the picture mid-wait. textContent is read only when the caller asked for text,
  // and only off a visible element (an invisible one has already failed).
  function probeSource(selector, wantText) {
    return `(() => {
      ${QUERY_SHIM}
      ${VISIBLE_SHIM}
      const el = __fkQuery(${j(selector)});
      if (!el) return { found: false, visible: false, text: null };
      const visible = __fkVisible(el, el.getBoundingClientRect());
      return { found: true, visible, text: ${wantText ? 'visible ? (el.textContent || \'\') : null' : 'null'} };
    })()`;
  }

  // Stop capture and get every accepted frame onto disk. MEMOIZED: every caller (stopRecording,
  // partialRecording, close, the salvage path) awaits the SAME stop, so none can return while
  // another is still halfway through it. stopT is the moment CAPTURE ended, not the moment the
  // disk caught up: it becomes the last frame's on-screen duration, so folding the write flush
  // into it would pad the tail of every take by however long the filesystem took.
  let haltPromise = null;
  function halt() {
    haltPromise ??= (async () => {
      if (drainTimer) clearInterval(drainTimer);
      drainTimer = null;
      if (tickInFlight) await tickInFlight.catch(() => {});
      sink.beginStop(); // frames still in the pipe are kept, but no longer acked
      if (recording) await cdp('Page.stopScreencast', {}).catch(() => {});
      await drainTick().catch((err) => {
        drainError = drainError || err;
      });
      stopT = Date.now() / 1000;
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
      frames,
      t0: frames[0].t,
      stopT: sink.probeSince !== null ? Math.min(stopT, sink.probeSince) : stopT, // the probe is not footage (lib/frames.mjs)
      // Sanity value, logged by the runner: how far the first real frame trailed the
      // startScreencast call on the SAME clock. Large values here would mean the two clocks
      // are not the same one, and the timeline would be wrong.
      firstFrameLagSec: sink.firstSeenT - recStartT,
      // Capture health, judged by film-web: acks that failed while live, and the reference image
      // for the final-frame stall check (see captureFinalShots).
      ackFailures: sink.ackFailures,
      opening: sink.opening, // how the opening cut went (lib/frames.mjs, THE OPENING FRAME)
      finalShot: null,
      finalShot2: null,
      finalShotError: null,
      liveness: null,
      ...extra,
    };
  }

  const pageHandle = {
    /** Playwright's `page.evaluate(pageFunction, arg)` (header, STAGE.PAGE.EVALUATE): a string is an
     *  expression (statements allowed, its completion value returned, a promise awaited), a function
     *  is called with `arg`. Rejects with the page's own error, as Playwright does. */
    evaluate: async (pageFunction, arg) => {
      const res = await evaluate(evaluateSource(pageFunction, arg));
      if (res?.threw) {
        const t = res.threw;
        throw new Error(`page.evaluate: ${'value' in t ? t.value : t.stack.startsWith(`${t.name}: `) ? t.stack : `${t.name}: ${t.message}`}`);
      }
      return parseValue(res?.value);
    },
    waitForSelector: (css, opts) => backend.waitForSelector(css, opts),
    /** RAW navigation: no overlay restore, no caption carried over. Prefer `stage.goto()`, which
     *  does both. This exists for a flow that needs to move the tab without the stage dressing
     *  the result — the cursor comes back on the next cursor move either way. Like a Playwright
     *  Page's own goto (what `stage.page` is on that camera), it throws on a network error but not
     *  on a 4xx/5xx status. */
    goto: (url, opts) => backend.goto(url, { ...opts, refuseErrorStatus: false }),
  };

  // Pin the viewport and park the tab on a blank document (see launch() on the backend).
  async function doLaunch() {
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
    // Since the opening cut (lib/frames.mjs, THE OPENING FRAME) the blank reaches a take only when the
    // cut could not be made (no frame followed the dressed page) or the flow failed before open()
    // finished, but then it must still not be a black frame.
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
  }

  const backend = {
    clock: 'frame',

    get page() {
      return pageHandle;
    },

    /** Pin the viewport so captured frames are exactly the requested size, whatever the real
     *  ego window is, and park the tab on a blank document so the take does not open on the
     *  user's new-tab page. The tab itself is opened by the runner (openOrReuseTab) before this. */
    launch() {
      launching = doLaunch();
      return launching;
    },

    /** ego-browser runs the user's real profile, where file:// is not a URL we want to point it
     *  at. Local paths are served instead, over a loopback http server film-web.mjs starts and
     *  roots at the flow file's directory unless `--serve-root` says otherwise — that root is the
     *  cap, and it is enforced here (the backend) as well as by the server's own traversal guard.
     *  A path outside it is refused by name rather than silently widening what a filming run can
     *  read off disk: widening is the operator's call, spelled `--serve-root`, not something a
     *  flow can do by naming a path. The rule is resolveOpenTarget's, shared with the Playwright
     *  camera and test mode (LOCAL FILES in the header); only the origin is swapped for ours.
     *  A MISSING FILE MUST NOT FILM: goto() refuses the server's 404 once it loads (NAVIGATION
     *  STATUS), naming the path, so a wrong path is a failed take, never 25s of "not found". */
    async resolveOpenUrl(urlOrPath) {
      const { url, local } = resolveOpenTarget(urlOrPath, serverOrigin && serverRoot ? serverRoot : null);
      if (!local) {
        lastLocal = null;
        return url;
      }
      const served = serverOrigin + url.slice(LOCAL_ORIGIN.length);
      lastLocal = { url: served, local };
      return served;
    },

    /** Navigation by hand, because the drain loop owns the event queue (constraint 2). Polls until
     *  a NEW document (a different `performance.timeOrigin`, which is per document) has finished
     *  loading, then refuses a 4xx/5xx unless `refuseErrorStatus` is false (see NAVIGATION STATUS). */
    async goto(url, { timeoutMs = 20000, refuseErrorStatus = true } = {}) {
      const local = lastLocal?.url === url ? lastLocal.local : null;
      const shown = local ? local.path : url;
      const before = await evaluate('(() => performance.timeOrigin)()').catch(() => null);
      const nav = await cdp('Page.navigate', { url });
      if (nav?.isDownload) throw new Error(`stage.open: ${shown} is a download, not a page`);
      if (nav?.errorText && nav.errorText !== HTTP_STATUS_ERROR_TEXT) {
        throw new Error(`stage.open: ${shown} did not load (${nav.errorText})`);
      }
      // A same-document navigation (a #hash) has a frameId and no loaderId: nothing new loads.
      // Anything else, an unexpected empty result included, polls for the new document below.
      if (nav?.frameId && !nav.loaderId) return;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const state = await evaluate(
          "(() => { const n = performance.getEntriesByType('navigation')[0]; " +
            'return { ready: document.readyState, origin: performance.timeOrigin, status: n ? n.responseStatus : undefined }; })()',
        ).catch(() => null); // a commit mid-poll is not a failure
        if (state && state.ready === 'complete' && state.origin !== before) {
          const { status } = state;
          if (refuseErrorStatus && status !== undefined && status >= 400) {
            if (local) {
              throw new Error(
                `stage.open: ${local.path} is not readable — the local file server answered ${status}.\n` +
                  `  Serving from ${local.root}; check the path exists and is a file.`,
              );
            }
            throw new Error(`stage.open: ${url} answered ${status} — refusing to go on against an error page.`);
          }
          return;
        }
        if (Date.now() > deadline) throw new Error(`stage.open: ${shown} did not finish loading within ${timeoutMs}ms`);
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

    /** Like addInitScript, but REPLACES the script this method registered last (lib/stage.mjs, THE
     *  CARRY-OVER). The new one is added before the old one goes, so a document created in between
     *  runs at least one of them. */
    async setNextDocumentScript(source) {
      const { identifier } = (await cdp('Page.addScriptToEvaluateOnNewDocument', { source })) ?? {};
      const old = nextDocumentScript;
      nextDocumentScript = identifier ?? null;
      if (old) await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: old });
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

    async resolveBox(target, { timeoutMs = DEFAULT_RESOLVE_TIMEOUT_MS, reveal } = {}) {
      if (typeof target !== 'string') throw new Error(unsupportedTargetMessage(target));
      // THE AUTO-WAIT. Both halves of "ready" are one page-side check (boxSource): `found` covers
      // "not in the DOM yet", `visible` covers "in the DOM but zero-size / display:none /
      // visibility:hidden / opacity 0". Polling, not events, because the CDP event queue is
      // already owned by the screencast drain loop. Once ready, THE REVEAL brings it to a
      // comfortable position and the box is read again where it landed; a target that went away
      // during the scroll sends the loop back to waiting.
      const deadline = Date.now() + timeoutMs;
      let last = null;
      for (;;) {
        last = await evaluate(boxSource(target)).catch(() => null); // a commit mid-poll is not a failure
        if (last?.found && last.visible) {
          await revealTarget({
            start: () => evaluate(revealSource(target, reveal)),
            settle: () => evaluate(REVEAL_SETTLE_SOURCE),
            sleep: sleepMs,
          });
          last = await evaluate(boxSource(target)).catch(() => null);
          if (last?.found && last.visible) return { x: last.x, y: last.y, width: last.width, height: last.height };
        }
        if (Date.now() > deadline) break;
        await sleepMs(POLL_INTERVAL_MS);
      }
      throw new Error(targetTimeoutMessage(target, timeoutMs, !!last?.found, await backend.currentUrl()));
    },

    /** ONE look at `target`, for the stage's expect()/oneOf() poll loops: never waits, never
     *  scrolls (the picture must not move mid-wait), never throws. Same visibility rule as
     *  resolveBox. With `{ text }`, `matched` also needs the text rule (lib/target-wait.mjs).
     *  Returns { found, visible, text, matched, error, fatal }; `fatal` means no amount of waiting
     *  can help (a target this backend cannot resolve at all), and the stage throws `error` at once.
     *  A failed evaluate (a navigation committing mid-probe) is just "not there yet". */
    async probe(target, { text } = {}) {
      if (typeof target !== 'string') {
        return { found: false, visible: false, text: null, matched: false, error: unsupportedTargetMessage(target), fatal: true };
      }
      const wantText = text !== undefined;
      let r;
      try {
        r = await evaluate(probeSource(target, wantText));
      } catch (err) {
        return { found: false, visible: false, text: null, matched: false, error: String(err?.message || err), fatal: false };
      }
      const found = !!r?.found;
      const visible = found && !!r.visible;
      const seen = wantText && visible ? collapseWhitespace(r.text) : null;
      const matched = visible && (!wantText || textMatches(seen, text));
      return { found, visible, text: seen, matched, error: null, fatal: false };
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

      // BLOCK UNTIL FRAME 1, AND CHECK IT (the size check is the sink's). A geometry mismatch is
      // knowable now, not after thirty seconds of filming.
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
      const sizeError = sink.firstFrameSizeError();
      if (sizeError) throw new Error(sizeError.replace('The viewport override', 'Emulation.setDeviceMetricsOverride'));
    },

    /** open() has dressed the page: it is the take's first frame, and every frame before it is setup
     *  (lib/frames.mjs, THE OPENING FRAME). The drain hands the sink every frame already sitting in the
     *  shared event queue first, so a frame of the undressed page counts as setup, not footage. */
    async markOpening() {
      const drain = async () => {
        if (tickInFlight) await tickInFlight.catch(() => {});
        if (!drainTimer) return;
        tickInFlight ??= drainTick()
          .catch((err) => {
            drainError = err;
          })
          .finally(() => {
            tickInFlight = null;
          });
        await tickInFlight;
      };
      return cutOpening({ sink, evaluate, drain });
    },

    async stopRecording() {
      // BEFORE halt, while the drain loop still runs: the stall check's liveness probe (lib/frames.mjs).
      const liveness = recording ? await probeLiveness({ sink, evaluate }) : null;
      await halt();
      if (drainError) throw new Error(`screencast capture failed: ${drainError.message}`);
      sink.validate();
      // AFTER halt: capture has stopped, so the page's state now is the state the last delivered
      // frame ought to show. The screenshot is the stall check's reference (film-web compares).
      const shot = await captureFinalShots((m, p) => cdp(m, p), workDir);
      return descriptor({ ...shot, liveness });
    },

    /** What was captured so far, whatever state the take is in — the salvage path's view of a take
     *  that failed or was interrupted. Halts capture first (idempotent), and skips the validation
     *  stopRecording() does: a partial take is judged by what film-web makes of it, not refused
     *  here. Null when not one frame arrived. */
    async partialRecording() {
      await halt();
      return frames.length ? descriptor() : null;
    },

    async close() {
      if (closed) return;
      closed = true;
      await launching?.catch(() => {}); // a close that beats launch() waits for it, then closes
      await halt();
    },
  };

  return backend;
}
