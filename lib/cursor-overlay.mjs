// ─────────────────────────────────────────────────────────────────────────────
// lib/cursor-overlay.mjs — the fake cursor + caption bar DOM, injected into the TOP
// page. Both are `position: fixed`, a max z-index, and `pointer-events: none`, so they
// render visually above the app without ever intercepting a REAL mouse event Playwright
// dispatches at the page underneath them.
// ─────────────────────────────────────────────────────────────────────────────

const CURSOR_ID = '__filmkitCursor';
const CAPTION_ID = '__filmkitCaption';
const STYLE_ID = '__filmkitStyle';

// Injects the overlay once per page load. Idempotent (guards re-entry after client-side
// navigations that wipe the DOM — call injectOverlay again if you open a new URL).
export async function injectOverlay(page) {
  const alreadyInjected = await page.evaluate(
    ([cursorId]) => !!document.getElementById(cursorId),
    [CURSOR_ID],
  );
  if (alreadyInjected) return;
  await page.evaluate(
    ([cursorId, captionId, styleId]) => {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        #${cursorId} {
          position: fixed; left: 0; top: 0; width: 22px; height: 22px;
          transform-origin: 0 0; /* the arrow's tip — the actual click point — never moves on scale */
          transform: translate3d(-999px, -999px, 0);
          z-index: 2147483647; pointer-events: none;
        }
        #${cursorId} svg { display: block; filter: drop-shadow(0 2px 3px rgba(0,0,0,.5)); }
        #${captionId} {
          position: fixed; left: 50%; bottom: 34px; transform: translateX(-50%);
          max-width: 84%; padding: 12px 22px; border-radius: 12px;
          background: rgba(15, 15, 22, 0.88); color: #fff;
          font: 600 19px/1.35 -apple-system, system-ui, "Segoe UI", sans-serif;
          text-align: center; z-index: 2147483647; pointer-events: none;
          opacity: 0; transition: opacity 260ms ease;
        }
        #${captionId}.visible { opacity: 1; }
      `;
      document.head.appendChild(style);

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
    },
    [CURSOR_ID, CAPTION_ID, STYLE_ID],
  );
}

// Moves the cursor's TIP to page-viewport coordinates (x, y). `pressed` shrinks it slightly
// toward that same tip (transform-origin: 0 0 above), the "visible press feedback" a click needs.
export async function setCursorPosition(page, x, y, pressed = false) {
  await page.evaluate(
    ([cursorId, x, y, pressed]) => {
      const el = document.getElementById(cursorId);
      if (!el) return;
      el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${pressed ? 0.72 : 1})`;
    },
    [CURSOR_ID, x, y, pressed],
  );
}

export async function setCaptionText(page, text) {
  await page.evaluate(
    ([captionId, t]) => {
      const el = document.getElementById(captionId);
      if (el) el.textContent = t;
    },
    [CAPTION_ID, text],
  );
}

export async function setCaptionVisible(page, visible) {
  await page.evaluate(
    ([captionId, v]) => {
      const el = document.getElementById(captionId);
      if (el) el.classList.toggle('visible', v);
    },
    [CAPTION_ID, visible],
  );
}

export async function isCaptionVisible(page) {
  return page.evaluate(
    ([captionId]) => !!document.getElementById(captionId)?.classList.contains('visible'),
    [CAPTION_ID],
  );
}
