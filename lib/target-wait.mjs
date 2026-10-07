// ─────────────────────────────────────────────────────────────────────────────
// lib/target-wait.mjs — the wording of a failed wait, and the one text rule, shared by both backends
// and by the stage.
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
//
// THE TEXT RULE (stage.expect's `{ text }`): the target's `textContent` and the expected text both
// have every whitespace run collapsed to one space and are trimmed, then the expected text must occur
// in the target's text — a case-sensitive SUBSTRING match. That is Playwright's
// `toContainText(string)`. The backends only READ textContent (ProbeResult.text); the decision is
// textMatches().
//
// WHERE THE CODE LIVES. Since the scenario export (Part 2), the implementation is in
// lib/scenario/filmkit-stage.mjs, the test-mode stage, because that file is copied next to every
// emitted spec and must carry the same rule and the same messages without importing anything from
// filmkit. This module re-exports them so lib/stage.mjs and the backends keep the import path they
// had; the ego backend now also imports lib/scenario/filmkit-stage.mjs directly (resolveOpenTarget,
// LOCAL_ORIGIN), and the Playwright backend and lib/static-server.mjs import only from there. Change
// them THERE.
export {
  describeTarget,
  collapseWhitespace,
  textMatches,
  targetTimeoutMessage,
  expectTimeoutMessage,
  oneOfTimeoutMessage,
  oneOfRejectedMessage,
} from './scenario/filmkit-stage.mjs';
