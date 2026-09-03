// ─────────────────────────────────────────────────────────────────────────────
// lib/target-wait.mjs — the wording of a failed auto-wait, shared by both backends.
//
// Two backends resolve targets by completely different means (Playwright's own actionability
// machinery vs. a hand-rolled poll over CDP), and the two would drift into two different error
// messages for the same failure within a release. The message is the part a flow author actually
// reads, so it lives in one place.
//
// It answers the three questions someone staring at a red run has, in order: WHICH target, HOW
// LONG we waited, and WHERE — the URL, because half of these failures are "the flow navigated
// somewhere unexpected" and a selector alone cannot tell you that. The in-document/not-in-document
// split matters too: "never appeared" is a wrong selector or a slow app, "no visible box" is a
// selector that matches something real but hidden, which is a different bug with a different fix.

export function describeTarget(target) {
  if (typeof target === 'string') return target;
  if (typeof target === 'function') return '(locator function)';
  return '(Playwright Locator)';
}

/**
 * @param {string} name       the target as the flow wrote it
 * @param {number} timeoutMs  the budget that ran out
 * @param {boolean} attached  true if it IS in the document but not visibly laid out
 * @param {string} url        where we were when we gave up
 */
export function targetTimeoutMessage(name, timeoutMs, attached, url) {
  const why = attached
    ? 'it is in the document, but has no visible box (display:none, visibility:hidden, opacity 0, or zero size)'
    : 'it never appeared in the document';
  return (
    `stage: target never became visible — ${name}\n` +
    `  waited ${(timeoutMs / 1000).toFixed(1)}s; ${why}\n` +
    `  url: ${url || '(unknown)'}`
  );
}
