#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// tools/explore.mjs — the off-camera look before a web flow is written (pass 1 of the two-pass
// workflow), for a machine without ego-browser's snapshotText():
//
//   node tools/explore.mjs <url-or-file> [--shot <file.png>] [--full] [--wait <css>] [--viewport <WxH>]
//                                        [--serve-root <dir>] [--all]
//
// Opens the page in Playwright's headless Chromium at the camera's viewport (1280x720), the way the
// Playwright backend would (a local file is served at http://filmkit.localhost from its directory or
// --serve-root, through the same code: lib/scenario/filmkit-stage.mjs), and prints:
//   - the final URL, HTTP status and title, and a note when the page is not the one asked for: an
//     HTTP redirect (each hop's status, from the navigation's own redirect chain) or a page that sent
//     itself elsewhere after loading (a script or a meta refresh). A login wall shows up as one of
//     these. URLs are compared as the browser normalizes them, so `https://example.com` landing on
//     `https://example.com/` is not a move. The camera follows redirects the same way (the same
//     navigate(), lib/scenario/filmkit-stage.mjs) and films wherever the page lands;
//   - one line per visible element worth targeting (links, buttons, form fields, headings, labels,
//     anything with a test id or a non-generated id), each with a SELECTOR THAT MATCHES EXACTLY ONE ELEMENT on this page,
//     its text, and where it sits ("below the fold" when it starts under the first screen);
//   - the path of a screenshot (out/explore/<name>.png, or --shot), to look at.
//
// SELECTORS are only ones both web backends understand (film-web.mjs: plain CSS plus `:has-text()`),
// tried in order of how well they survive a redesign, and each is kept only if it matches exactly one
// element: a test id ([data-testid], [data-test], [data-cy]); an #id that does not look generated; a
// form field's name, aria-label or placeholder, or its <label>'s text; an aria-label; a link's href;
// `tag:has-text("…")` (counted by Playwright, which is what that pseudo-class means); else an
// nth-of-type path, marked "(fragile)". "visible" is ego's rule, the stricter one: opacity 0 counts as
// hidden.
//
// Nothing here is filmed or kept beyond the screenshot. Signed-in pages show what a signed-out visitor
// sees, as a --browser playwright take would.
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { valueFor } from '../lib/args.mjs';
import { localRoot, navigate, resolveOpenTarget, routeLocalFiles } from '../lib/scenario/filmkit-stage.mjs';
import { PLAYWRIGHT_SETUP_HINT } from '../lib/browser-probe.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE =
  'usage: filmkit explore <url-or-file> [--shot <file.png>] [--full] [--wait <css>] [--viewport <WxH>] [--serve-root <dir>] [--all]';
const MAX_ROWS = 120;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { target: null, shot: null, full: false, wait: null, viewport: { width: 1280, height: 720 }, serveRoot: null, all: false };
  const take = (i, flag) => valueFor(argv, i, flag, fail);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shot') opts.shot = resolve(take(i++, a));
    else if (a === '--full') opts.full = true;
    else if (a === '--wait') opts.wait = take(i++, a);
    else if (a === '--serve-root') opts.serveRoot = resolve(take(i++, a));
    else if (a === '--all') opts.all = true;
    else if (a === '--viewport') {
      const m = take(i++, a).match(/^(\d+)x(\d+)$/);
      if (!m) fail('--viewport must be <width>x<height>, e.g. --viewport 1280x720');
      opts.viewport = { width: Number(m[1]), height: Number(m[2]) };
    } else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (a.startsWith('--')) fail(`unknown flag ${a}\n${USAGE}`);
    else if (opts.target) fail(USAGE);
    else opts.target = a;
  }
  if (!opts.target) fail(USAGE);
  return opts;
}

// Runs IN THE PAGE: the candidate elements, each with its pure-CSS selector candidates already checked
// for uniqueness, plus what a `:has-text` candidate would need (Playwright counts those, outside).
function collect() {
  const SEL = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary', 'label', 'h1', 'h2', 'h3',
    '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]', '[role=checkbox]', '[role=switch]', '[role=option]',
    '[contenteditable=""]', '[contenteditable=true]', '[data-testid]', '[data-test]', '[data-cy]', '[onclick]',
  ].join(',');
  // Plus any element with an id that does not look generated (a result row, a panel): what a flow
  // points at or waits for is often not interactive.
  const ANY = `${SEL},[id]`;
  const q = (s) => {
    try {
      return document.querySelectorAll(s).length;
    } catch {
      return -1;
    }
  };
  const attr = (name, v) => `[${name}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    }
    return true;
  };
  const generated = (id) => /\d{3,}|^:|[a-f0-9]{8,}|^(radix|headlessui|mui|react|ember|ext-gen)/i.test(id);
  const text = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('alt') || '')
    .replace(/\s+/g, ' ')
    .trim();
  const nthPath = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const tag = e.tagName.toLowerCase();
      if (e.id && !generated(e.id) && q(`#${CSS.escape(e.id)}`) === 1) {
        parts.unshift(`#${CSS.escape(e.id)}`);
        return parts.join(' > ');
      }
      const same = [...(e.parentElement?.children ?? [])].filter((s) => s.tagName === e.tagName);
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(e) + 1})` : tag);
    }
    return `body > ${parts.join(' > ')}`;
  };
  const rows = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(ANY)) {
    if (seen.has(el) || !visible(el)) continue;
    // An id-only element earns a row when it shows something: an empty wrapper is not a target.
    if (!el.matches(SEL) && (generated(el.id) || ['html', 'body'].includes(el.tagName.toLowerCase()) || !text(el))) continue;
    seen.add(el);
    const tag = el.tagName.toLowerCase();
    const css = [];
    for (const a of ['data-testid', 'data-test', 'data-cy']) if (el.hasAttribute(a)) css.push(`${tag}${attr(a, el.getAttribute(a))}`, attr(a, el.getAttribute(a)));
    if (el.id && !generated(el.id)) css.push(`#${CSS.escape(el.id)}`);
    const field = ['input', 'select', 'textarea'].includes(tag);
    if (field) {
      for (const a of ['name', 'aria-label', 'placeholder']) if (el.getAttribute(a)) css.push(`${tag}${attr(a, el.getAttribute(a))}`);
    } else if (el.getAttribute('aria-label')) css.push(`${tag}${attr('aria-label', el.getAttribute('aria-label'))}`);
    if (tag === 'a' && el.getAttribute('href') && !el.getAttribute('href').startsWith('javascript:')) css.push(`a${attr('href', el.getAttribute('href'))}`);
    const r = el.getBoundingClientRect();
    rows.push({
      tag,
      type: tag === 'input' ? el.type : null,
      role: el.getAttribute('role'),
      text: text(el).slice(0, 80),
      css: css.find((s) => q(s) === 1) ?? null,
      // `:has-text` candidates: the element's own text, or (a field) the text of the <label> it sits in.
      labelText: field && el.closest('label') ? el.closest('label').innerText.replace(/\s+/g, ' ').trim().slice(0, 60) : null,
      fallback: nthPath(el),
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + window.scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
  }
  return rows;
}

const hasText = (s) => `:has-text(${JSON.stringify(s)})`;

async function pickSelector(page, row) {
  if (row.css) return { selector: row.css, fragile: false };
  const tries = [];
  if (row.labelText) tries.push(`label${hasText(row.labelText)} ${row.tag}`);
  if (row.text && row.text.length <= 60 && !['input', 'select', 'textarea'].includes(row.tag)) {
    tries.push(`${row.role ? `[role=${row.role}]` : row.tag}${hasText(row.text)}`);
  }
  for (const s of tries) {
    try {
      if ((await page.locator(s).count()) === 1) return { selector: s, fragile: false };
    } catch {
      // a text Playwright cannot parse inside :has-text: try the next one
    }
  }
  return { selector: row.fallback, fragile: true };
}

// Whether the page that loaded is the one asked for, in the browser's own terms: a URL as typed and the
// same URL as the browser normalizes it (`https://example.com` and `https://example.com/`) are one page.
// Two ways to land elsewhere, told apart because they mean different things to a flow: the server
// REDIRECTED (the navigation's response has a redirectedFrom chain; each hop's status is listed), or
// the page LOADED and then moved itself on (a script or a meta refresh), which page.url() shows against
// the URL the response came from. Both are what a login wall looks like.
async function movedNotes(page, asked, response) {
  const notes = [];
  const askedHref = new URL(asked).href;
  const served = response ? response.url() : askedHref;
  const hops = [];
  for (let req = response?.request().redirectedFrom() ?? null; req; req = req.redirectedFrom()) hops.unshift(req);
  if (hops.length) {
    const statuses = [];
    for (const req of hops) statuses.push((await req.response().catch(() => null))?.status() ?? '?');
    notes.push(`${askedHref} redirected (HTTP ${statuses.join(', then ')}) to ${served}. A login wall looks like this.`);
  }
  const landed = page.url();
  if (landed !== served) notes.push(`the page moved itself on from ${served} after loading (a script or a meta refresh). A login wall looks like this.`);
  return notes;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    fail(`explore needs Playwright, which is not installed. ${PLAYWRIGHT_SETUP_HINT}, then run this again.`);
  }
  const isUrl = /^https?:\/\//i.test(opts.target);
  const root = isUrl ? null : localRoot(opts.serveRoot ?? (opts.target.startsWith('file:') ? dirname(fileURLToPath(opts.target)) : dirname(resolve(opts.target))));
  if (!isUrl && !opts.target.startsWith('file:') && !existsSync(resolve(opts.target))) {
    fail(`No such file: ${resolve(opts.target)}. Pass a web address (https://...) or the path of a page on this computer.`);
  }
  let open;
  try {
    // A plain path is made absolute against the CWD first: resolveOpenTarget resolves a relative path
    // against the serve root (a flow's rule), and here the root is the file's own directory, so
    // `examples/web/fixture.html` would become examples/web/examples/web/fixture.html.
    const target = isUrl || opts.target.startsWith('file:') ? opts.target : resolve(opts.target);
    open = resolveOpenTarget(target, root, 'explore');
  } catch (err) {
    fail(err.message.replace(/^stage\.explore: /, ''));
  }

  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    fail(`Chromium would not start: ${String(err.message).split('\n')[0]}\n${PLAYWRIGHT_SETUP_HINT}, then run this again.`);
  }
  try {
    const page = await browser.newPage({ viewport: opts.viewport });
    if (open.local) await routeLocalFiles(page, open.local.root);
    let status = null;
    page.on('response', (res) => {
      if (res.request().isNavigationRequest() && res.frame() === page.mainFrame()) status = res.status();
    });
    let response = null;
    try {
      response = await navigate(page, open.url, { verb: 'explore', local: open.local, timeoutMs: 30_000 });
    } catch (err) {
      fail(`Could not open ${opts.target}: ${String(err.message).split('\n')[0].replace(/^stage\.explore: /, '')}`);
    }
    // A single-page app renders after `load`: give its requests a moment to settle (bounded), then the selector.
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    if (opts.wait) {
      try {
        await page.waitForSelector(opts.wait, { timeout: 20_000 });
      } catch {
        console.error(`(--wait ${opts.wait}: not visible after 20s; listing the page as it is)`);
      }
    }

    const name = isUrl ? new URL(page.url()).hostname.replace(/[^a-z0-9.-]/gi, '_') : basename(opts.target, extname(opts.target));
    const shot = opts.shot ?? join(ROOT, 'out', 'explore', `${name}.png`);
    await mkdir(dirname(shot), { recursive: true });
    await page.screenshot({ path: shot, fullPage: opts.full });

    console.log(`page:   ${page.url()}${status !== null ? `  (HTTP ${status})` : ''}`);
    console.log(`title:  ${await page.title()}`);
    for (const line of await movedNotes(page, open.url, response)) console.log(`note:   ${line}`);
    console.log(`shot:   ${shot}${opts.full ? ' (full page)' : ` (first screen, ${opts.viewport.width}x${opts.viewport.height}, what the camera opens on)`}`);
    console.log('');

    const rows = await page.evaluate(collect);
    const shown = opts.all ? rows : rows.slice(0, MAX_ROWS);
    const picked = [];
    for (const row of shown) picked.push({ row, ...(await pickSelector(page, row)) });
    const width = Math.min(60, Math.max(...picked.map((p) => p.selector.length), 8));
    console.log(`${'selector'.padEnd(width)}  element                 text`);
    for (const { row, selector, fragile } of picked) {
      const kind = `${row.tag}${row.type ? `[${row.type}]` : ''}${row.role ? ` role=${row.role}` : ''}`;
      const where = row.y >= opts.viewport.height ? `  (below the fold, y=${row.y})` : '';
      console.log(`${selector.padEnd(width)}  ${kind.padEnd(22)}  ${row.text ? JSON.stringify(row.text) : '-'}${fragile ? '  (fragile)' : ''}${where}`);
    }
    if (rows.length > shown.length) console.log(`… ${rows.length - shown.length} more (pass --all to list them)`);
    if (!rows.length) console.log('(no visible links, buttons, fields or headings: the page may still be loading; try --wait <css>)');
  } finally {
    await browser.close().catch(() => {});
  }
}

await main();
