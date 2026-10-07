// ─────────────────────────────────────────────────────────────────────────────
// lib/maestro-lint.mjs — warns about flows that will not hold the waits they say they hold.
// Shared by the device cameras (film-android and film-ios, one `lintAndReport` call each). It reads the
// flow TEXT with line scans, no YAML parser, and it only ever WARNS: it never refuses a take.
//
// THE DEFECT (measured on Maestro 2.6.0, iOS 27 simulator and Android 17 emulator; both agree).
// A wait's deadline is counted from the START OF THE PREVIOUS WAIT when that wait ended without
// matching and nothing has reset it since. A pause (an optional wait on the never-visible marker)
// always ends without matching, so the wait that follows it has only `timeout - previous hold` left:
//     hold ~= max(one poll, timeout - previous hold)        (one poll: about 0.3-0.6s)
//   pause 3000 then pause 3000              -> second holds 321ms (Android), 602ms (iOS)
//   pause 3000 then pause 6000              -> second holds 3071ms / 2801ms   (6000 - 3474 / 3563, + a poll)
//   pause 3000 then NON-OPTIONAL wait 20000 -> FAILED after 16840ms on both (a 3.4s pause ate 3.4s of it)
//   pause 3000 then NON-OPTIONAL wait 3000  -> FAILED after 213ms / 369ms (it would have matched inside
//                                              its own 3s; the pause had used the budget up)
// So a real wait for an LLM result placed right after a filming pause is not cut to 0.4s, it is shortened by
// the pause's hold, and it fails at once if the pause was at least as long as its timeout. That is the case a
// CI run must not hit; the wrapper's test run skips gated pauses, but a bare pause is paid there.
//
// WHAT RESETS IT (each row measured with pause, X, pause; B = the second pause's hold, both platforms):
//   resets  : waitForAnimationToEnd (3543 / 3581), evalScript (3404 / 3507), runScript (3535 / 3714),
//             tapOn (3408 / 3561), a COMPLETED runFlow whose body ran evalScript (3388 / 3410),
//             and a wait that MATCHED (a passing extendedWaitUntil, then a pause: 3255 / 3283).
//   does not: nothing in between (1248 / 698), assertVisible (406 / 692), takeScreenshot (321 / 529), a
//             runFlow whose `when:` was false (SKIPPED: 582 / 507).
//   Not measured, so treated as "resets" (silent): every other command (launchApp, inputText, scroll,
//   swipe, back, assertNotVisible, ...). A wrong "resets" is a missed warning; a wrong "does not reset"
//   would be a false alarm on a flow that works, which is worse for a lint that runs on every take.
//
// WHAT IT CHECKS. It flattens the flow into its commands in text order (bodies of `runFlow:` blocks are
// flattened in place: a gated pause is a pause), and walks them with one bit of state, "the last thing was a
// wait that did not match":
//   * an extendedWaitUntil on the pause marker: sets the bit (it never matches); warns if it was already set.
//   * any other extendedWaitUntil: warns if the bit was set, then clears it (assumed to match).
//   * assertVisible, takeScreenshot: leave the bit alone.
//   * a `runFlow:` container line: ignored (its body follows); a `runFlow: file:` include: clears the bit,
//     because what runs inside is not read.
//   * everything else: clears it.
// NOT COVERED: a `runFlow` written entirely in flow style with an inline `commands: [...]` (its body is
// not read, so a pause inside it is invisible to the lint), `repeat:` (a pause at the end and one at the start of the body are adjacent from the second
// iteration on), pauses inside included files, and waits written as `assertVisible` with a timeout.
//
// Output: `[{ line, message }]`, 1-based flow-file line of the wait that is cut. The cameras print each as a
// warning at preflight (before anything is filmed) and store the array as sidecar `flowLint` (key omitted
// when empty).
import { PAUSE_MARKER } from './scenario/emit-maestro.mjs';

const NON_RESETTING = new Set(['assertVisible', 'takeScreenshot']);

/** Commands of the flow body in text order: `{ line, name, text }`, `text` being the item's own lines. */
function flattenCommands(flowText) {
  const lines = flowText.split(/\r?\n/);
  const cut = lines.findIndex((l) => /^---\s*$/.test(l));
  const start = cut === -1 ? 0 : cut + 1;
  const items = [];
  for (let i = start; i < lines.length; i++) {
    const m = /^(\s*)-\s+([A-Za-z][A-Za-z0-9]*)\s*(?::(.*))?$/.exec(lines[i].replace(/\s+#.*$/, ''));
    if (!m || /^\s*#/.test(lines[i])) continue;
    const indent = m[1].length;
    let text = lines[i];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '' || /^\s*#/.test(lines[j])) continue;
      const ind = lines[j].length - lines[j].trimStart().length;
      // The item ends where a line at or below its own `- ` indent begins... except a `commands:` body
      // belongs to a runFlow, and its items are separate entries of their own, so stop at the first child
      // `- ` line as well.
      if (ind <= indent || /^\s*-\s+[A-Za-z]/.test(lines[j])) break;
      text += `\n${lines[j]}`;
    }
    items.push({ line: i + 1, name: m[2], text });
  }
  return items;
}

/**
 * @param {string} flowText
 * @returns {Array<{ line: number, message: string }>}
 */
export function lintFlow(flowText) {
  const warnings = [];
  let lastWait = null; // { line } of a wait that ended without matching, not reset since
  for (const item of flattenCommands(flowText)) {
    const isPause = item.name === 'extendedWaitUntil' && item.text.includes(PAUSE_MARKER);
    const isWait = item.name === 'extendedWaitUntil';
    if (isWait) {
      if (lastWait) {
        const optional = /\boptional:\s*true\b/.test(item.text);
        warnings.push({
          line: item.line,
          message:
            `${isPause ? 'pause' : optional ? 'optional wait' : 'wait'} on line ${item.line} directly follows the wait on line ${lastWait.line} ` +
            'with nothing between them that resets Maestro 2.6\'s wait clock, so its timeout is counted from the start of the previous wait: ' +
            (isPause
              ? 'it holds only max(~0.4s, timeout - the previous hold), not the time written'
              : 'it has only (timeout - the previous hold) left and fails at once if that pause was as long as its timeout') +
            '. Put `- waitForAnimationToEnd` (or a tapOn, evalScript or runScript) between them. assertVisible, takeScreenshot and a skipped gate do not reset it.',
        });
      }
      lastWait = isPause ? { line: item.line } : null;
      continue;
    }
    if (NON_RESETTING.has(item.name)) continue;
    // A `runFlow:` with a `commands:` body is a container: its items follow as entries of their own. One with only
    // `file:` is an include whose insides are not read, so it clears the bit like any other command.
    if (item.name === 'runFlow' && /\bcommands:/.test(item.text)) continue;
    lastWait = null;
  }
  return warnings;
}

/** lintFlow + print, for a camera's preflight. Never throws (a lint bug must not cost a take). */
export function lintAndReport(flowText, tag) {
  let warnings = [];
  try {
    warnings = lintFlow(flowText);
  } catch (err) {
    console.error(`[${tag}] flow lint could not run: ${err.message}`);
  }
  for (const w of warnings) console.error(`[${tag}] ⚠️  flow lint (line ${w.line}): ${w.message}`);
  return warnings;
}
