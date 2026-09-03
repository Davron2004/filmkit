// ─────────────────────────────────────────────────────────────────────────────
// lib/cursor-overlay.mjs — everything filmkit draws ON TOP of the app under film: the fake
// cursor, the caption bar, and the click ripple. All three are `position: fixed`, near the
// top of the z-index range, and `pointer-events: none`, so they render visually above the app
// without ever intercepting a REAL mouse event the backend dispatches at the page underneath.
//
// THE CLICK RIPPLE — an expanding ring at the click point, ~28px to ~64px over 450ms. It exists
// because the cursor's press-shrink is not a click indicator: it is a 28% scale change on a 22px
// arrow, which at 1280x720 is a couple of pixels of movement, and on a re-encoded frame it is
// close to invisible. A viewer watching a demo has to be able to see WHERE the click landed and
// WHEN, and the shrink does not carry that. Design constraints, in the order they mattered:
//   - READS ON ANY BACKGROUND, INCLUDING THE BUTTON IT LANDS ON. A single colour cannot manage
//     the first half: white rings vanish on white pages, dark rings vanish on dark ones. So the
//     ring is a coloured stroke with a thin dark hairline on BOTH sides of it (box-shadow
//     outside, inset shadow inside), which keeps an edge against any fill underneath. The colour
//     is amber rather than the obvious blue because of the second half: a demo's primary action
//     button is nearly always blue, and the first version of this drew a blue ring on this
//     repo's own blue Reset button, where all that survived was the hairlines — the exact
//     subtlety problem the ripple exists to fix.
//   - CENTRED ON THE CLICK POINT, not on the cursor's tip-anchored box: `translate(-50%, -50%)`
//     with the size animated, so the centre stays put as it grows rather than drifting.
//   - BELOW THE CURSOR (z-index one under it). The arrow is the thing the eye tracks; a ring
//     drawn over it would hide the very thing it is annotating.
//   - SELF-CLEANING. Each ripple is its own element, removed on `animationend`, with a timeout
//     fallback for pages that suppress animations (`prefers-reduced-motion`, a global
//     `animation: none !important`). A take is hundreds of frames long and must not accumulate
//     DOM for its whole length.
// It is triggered by ONE evaluate fired immediately BEFORE the real click — before, so the ring
// is already painted when the app reacts, instead of trailing the reaction by a round trip.
//
// EVERYTHING HERE IS A SOURCE STRING, NOT A FUNCTION. Both filming backends evaluate
// page-side code the same way: `backend.evaluate(source)` where `source` is a JS
// expression string. The ego backend rides on CDP `Runtime.evaluate`, which has no
// argument channel at all, so values are baked in with JSON.stringify rather than
// passed. Playwright's `page.evaluate(string)` evaluates a string the same way, so one
// form serves both. Every source is written as `(() => { ... })()` — a call expression,
// never a bare function literal — because Playwright treats a string that *looks like a
// function* as something to call with an argument instead of an expression to evaluate.
// ─────────────────────────────────────────────────────────────────────────────

const CURSOR_ID = '__filmkitCursor';
const CAPTION_ID = '__filmkitCaption';
const STYLE_ID = '__filmkitStyle';
const DOC_TOKEN_PROP = '__filmkitDoc';
const RIPPLE_CLASS = '__filmkitRipple'; // a CLASS, not an id — two clicks can overlap in time
const RIPPLE_ANIM = '__filmkitRippleGrow';
const RIPPLE_FN = '__filmkitPlayRipple';
const RIPPLE_MS = 450;

const j = JSON.stringify;

// The overlay builder, as a self-contained expression. Idempotent (guards re-entry after
// client-side navigations that wipe the DOM) and safe to run at document-start, where
// there is no <body> yet — hence the DOMContentLoaded deferral, which is what makes this
// same source usable as an init script that survives navigation.
export function overlayInjectSource() {
  return `(() => {
    const cursorId = ${j(CURSOR_ID)}, captionId = ${j(CAPTION_ID)}, styleId = ${j(STYLE_ID)};
    const rippleClass = ${j(RIPPLE_CLASS)};
    // A per-DOCUMENT identity, minted the first time this source runs in a given window. As an
    // init script it runs at document-start on every new document, so a navigation — whether the
    // stage asked for it or the app did it under a click — necessarily changes this value. That
    // is the whole navigation-detection mechanism: no CDP lifecycle events to subscribe to (the
    // ego backend's event queue is already spoken for), no URL comparison (a same-URL reload is
    // still a new document and still loses the overlay).
    if (!window.${DOC_TOKEN_PROP}) {
      window.${DOC_TOKEN_PROP} = Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
    }
    // Defined OUTSIDE build(), so it exists from document-start even though it needs a <body>
    // only at call time. Each ripple is its own element: two clicks close together produce two
    // rings rather than one restarted one, which is what actually happened on screen.
    window.${RIPPLE_FN} = function (x, y) {
      if (!document.body) return false;
      const ring = document.createElement('div');
      ring.className = rippleClass;
      ring.style.left = x + 'px';
      ring.style.top = y + 'px';
      let gone = false;
      const remove = () => {
        if (gone) return;
        gone = true;
        ring.remove();
      };
      ring.addEventListener('animationend', remove, { once: true });
      // Fallback: a page with prefers-reduced-motion, or a global "animation: none !important",
      // never fires animationend and would leave the ring on screen for the rest of the take.
      setTimeout(remove, ${RIPPLE_MS * 2});
      document.body.appendChild(ring);
      return true;
    };
    const build = () => {
      if (!document.body || document.getElementById(cursorId)) return;
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = \`
        #\${cursorId} {
          position: fixed; left: 0; top: 0; width: 22px; height: 22px;
          transform-origin: 0 0; /* the arrow's tip — the actual click point — never moves on scale */
          transform: translate3d(-999px, -999px, 0);
          z-index: 2147483647; pointer-events: none;
        }
        #\${cursorId} svg { display: block; filter: drop-shadow(0 2px 3px rgba(0,0,0,.5)); }
        #\${captionId} {
          position: fixed; left: 50%; bottom: 34px; transform: translateX(-50%);
          max-width: 84%; padding: 12px 22px; border-radius: 12px;
          /* Mid-dark, not near-black: a near-black fill sits right on top of a dark app (their
             luminance was a couple of steps apart at best) and reads as a hole in the page rather
             than a panel on it. Lifted to a mid-dark slate so it stays legibly darker than a white
             page AND legibly lighter than a near-black one — the same fill has to win on both. */
          background: rgba(46, 48, 60, 0.92); color: #fff;
          /* backdrop-filter blurs whatever is showing through the fill's own transparency, so the
             panel reads as glass sitting above the app instead of a flat sticker pasted over it —
             on either a light or a dark page. */
          backdrop-filter: blur(18px) saturate(140%);
          -webkit-backdrop-filter: blur(18px) saturate(140%);
          /* A hairline on top of that fill, because a mid-dark bar over a MID-dark app still needs
             its own edge — the fill alone narrows the gap but does not guarantee it. */
          border: 1px solid rgba(255, 255, 255, 0.14);
          box-shadow: 0 2px 14px rgba(0, 0, 0, 0.45);
          font: 600 19px/1.35 -apple-system, system-ui, "Segoe UI", sans-serif;
          text-align: center; z-index: 2147483647; pointer-events: none;
          opacity: 0; transition: opacity 260ms ease;
        }
        #\${captionId}.visible { opacity: 1; }
        .\${rippleClass} {
          position: fixed; border-radius: 50%; box-sizing: border-box;
          /* the click point is the CENTRE — recentres itself as the size animates */
          transform: translate(-50%, -50%);
          width: 28px; height: 28px;
          /* AMBER, not the obvious blue: a demo's own primary action is nearly always blue, and
             a blue ring on a blue button is invisible — measured on this repo's own fixture,
             where rgba(79,110,247) on a #4f6ef7 Reset button left only the hairlines showing.
             Amber collides with almost nothing in ordinary UI and stays legible over both. */
          border: 4px solid rgba(255, 173, 26, 0.98);
          background: rgba(255, 173, 26, 0.26);
          /* a dark hairline OUTSIDE and INSIDE the coloured stroke, so the ring keeps an edge
             against a white page and against a dark one */
          box-shadow: 0 0 0 1.5px rgba(10, 12, 20, 0.6), inset 0 0 0 1.5px rgba(10, 12, 20, 0.6);
          z-index: 2147483646; pointer-events: none;
          animation: ${RIPPLE_ANIM} ${RIPPLE_MS}ms cubic-bezier(.22,.7,.3,1) forwards;
        }
        @keyframes ${RIPPLE_ANIM} {
          from { width: 28px; height: 28px; opacity: 1; }
          60%  { opacity: 0.85; }
          to   { width: 64px; height: 64px; opacity: 0; }
        }
      \`;
      (document.head || document.documentElement).appendChild(style);

      const cursor = document.createElement('div');
      cursor.id = cursorId;
      // Classic pointer-arrow path with its TIP at the SVG origin (0,0) — the element's
      // transform-origin above, so translate(x,y) always lands the visible tip exactly at (x,y).
      cursor.innerHTML =
        '<svg width="22" height="22" viewBox="0 0 22 22">' +
        '<path d="M0,0 L0,15 L3.6,11.6 L6.4,18.4 L9,17.3 L6.3,10.7 L11.4,10.7 Z" ' +
        'fill="#ffffff" stroke="#111318" stroke-width="1.4" stroke-linejoin="round"/></svg>';
      document.body.appendChild(cursor);

      const caption = document.createElement('div');
      caption.id = captionId;
      document.body.appendChild(caption);
    };
    if (document.body) build();
    else document.addEventListener('DOMContentLoaded', build, { once: true });
    return true;
  })()`;
}

/**
 * Register the overlay to be built on every FUTURE document in this tab, and build it in the
 * current one. Called once, from stage.open(). The init-script half is what makes a navigation
 * the app performs itself (a link click, a form post, a client-side route that hard-reloads)
 * come back with a cursor and a caption bar instead of a bare page.
 * @param {{evaluate: (src: string) => Promise<any>, addInitScript: (src: string) => Promise<void>}} backend
 */
export async function installOverlay(backend) {
  const source = overlayInjectSource();
  await backend.addInitScript(source);
  await backend.evaluate(source);
}

/**
 * Build the overlay in the CURRENT document if it isn't there. Idempotent, and registers no
 * further init scripts — called after every navigation, where re-registering would just pile up
 * identical scripts on the page for the rest of the take.
 */
export async function ensureOverlay(backend) {
  await backend.evaluate(overlayInjectSource());
}

/**
 * Draw one click ripple centred on page-viewport (x, y). ONE evaluate, and the only thing the
 * stage has to do at click time — the ring's whole lifetime (grow, fade, remove itself) runs
 * inside the page, so this never blocks the take for the 450ms the animation lasts.
 * Returns false if there is no overlay in this document to draw into.
 */
export async function playClickRipple(backend, x, y) {
  return backend.evaluate(
    `(() => (typeof window.${RIPPLE_FN} === 'function' ? window.${RIPPLE_FN}(${j(x)}, ${j(y)}) : false))()`,
  );
}

/** This document's identity, or null if the overlay source has never run here. */
export async function documentToken(backend) {
  try {
    return await backend.evaluate(`(() => window.${DOC_TOKEN_PROP} || null)()`);
  } catch {
    // Evaluating during a commit throws — "unknown" reads as "changed", which is the safe way
    // round: the caller waits for the document to settle and re-dresses it.
    return null;
  }
}

// Moves the cursor's TIP to page-viewport coordinates (x, y). `pressed` shrinks it slightly
// toward that same tip (transform-origin: 0 0 above), the "visible press feedback" a click needs.
//
// RETURNS FALSE WHEN THERE IS NO CURSOR IN THIS DOCUMENT, and the stage uses that: a call it was
// going to make anyway doubles as the detector for a navigation nobody asked for (a meta refresh,
// a JS redirect during a long hold). Free, versus polling a token before every action.
export async function setCursorPosition(backend, x, y, pressed = false) {
  return backend.evaluate(`(() => {
    const el = document.getElementById(${j(CURSOR_ID)});
    if (!el) return false;
    el.style.transform = 'translate3d(' + ${j(x)} + 'px, ' + ${j(y)} + 'px, 0) scale(' + ${pressed ? 0.72 : 1} + ')';
    return true;
  })()`);
}

export async function setCaptionText(backend, text) {
  await backend.evaluate(`(() => {
    const el = document.getElementById(${j(CAPTION_ID)});
    if (el) el.textContent = ${j(String(text))};
    return true;
  })()`);
}

export async function setCaptionVisible(backend, visible) {
  await backend.evaluate(`(() => {
    const el = document.getElementById(${j(CAPTION_ID)});
    if (el) el.classList.toggle('visible', ${visible ? 'true' : 'false'});
    return true;
  })()`);
}

export async function isCaptionVisible(backend) {
  return backend.evaluate(`(() => {
    const el = document.getElementById(${j(CAPTION_ID)});
    return !!(el && el.classList.contains('visible'));
  })()`);
}
