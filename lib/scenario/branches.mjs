// ─────────────────────────────────────────────────────────────────────────────
// lib/scenario/branches.mjs — which `runFlow: when:` blocks a filmed run took.
//
// Maestro has no "if". A branch is a `runFlow` with a `when:` condition, and the only durable
// record of which ones ran is `<debug dir>/.maestro/tests/<run>/commands-(<flow>).json`, which the
// cameras delete on success. So the cameras call this BEFORE that delete and keep the answer in
// the sidecar (`branches`) and in the scenario wrapper's header.
//
// WHAT MAESTRO 2.6.0 WRITES (measured on an iOS 27 simulator; a flow with three `when:` blocks, one
// visible-true, one visible-false, one script-false). Each command is `{ command, metadata }`, and a
// `runFlow: when:` is the command key `runFlowCommand`:
//
//   command.runFlowCommand.condition       the condition AS AUTHORED. Exactly one of
//                                            { visible: { textRegex, optional } }
//                                            { notVisible: { textRegex, optional } }
//                                            { scriptCondition: "${FILMKIT_MODE == 'test'}" }   (yaml `true:`)
//                                            { platform: ... }
//                                          Absent for a plain `runFlow: file:` (no `when:`).
//   command.runFlowCommand.commands        the body. Not read here.
//   metadata.evaluatedCommand              the same command with scripts resolved: the script
//                                          condition above reads "false" there. Not used: the
//                                          authored form is what a reader can find in the flow.
//   metadata.status                        COMPLETED (condition held, body ran) | SKIPPED (it did
//                                          not) | FAILED | WARNED | ... passed through as written.
//   metadata.timestamp                     host epoch ms when the block was DECIDED. SKIPPED records
//                                          have it too, and no `duration`. Same clock as maestro.log,
//                                          so `atSec = (timestamp - recordingStartedMs) / 1000`.
//   metadata.sequenceNumber                Maestro's global command counter. Nested commands count:
//                                          in the measured run a COMPLETED block was seq 4 and its two
//                                          body commands were 5 and 6, so the next block was 7. `seq`
//                                          here is that number, and it is how the wrapper header names
//                                          a block ("seq7").
//
// The reader that lib/tap-overlay.mjs exports (readCommandRecords) drops both `condition` and
// `sequenceNumber`, and that file is not this module's to change, so this parses the JSON itself.
// Only `locateLogs` is imported from it: the NEWEST run under the debug dir, which is the last retry
// attempt (failed attempts are moved out of the debug dir by the camera), so a retried startup can
// never leak an earlier attempt's branches into the record.
//
// MODE GATES. A block whose condition mentions FILMKIT_MODE (see MODE_GATE_RE) gets `modeGate: true` in the
// record. The camera passes `-e FILMKIT_MODE=film`, so every such block is decided the same way on every
// take: it documents the flow's test-mode structure, not what the app did. The wrapper header leaves them
// out of "branches filmed"; the sidecar keeps them.
//
// NOT COVERED, reported rather than guessed: a `when:` block nested inside another block's body only
// appears in the record if the outer block ran (an outer SKIPPED hides its children entirely, which
// is correct: they were never decided). `repeat:` bodies that contain `when:` blocks are recorded
// once per iteration, each with its own seq.
import { readFile } from 'node:fs/promises';
import { locateLogs } from '../tap-overlay.mjs';

const MODE_GATE_RE = /\bFILMKIT_MODE\b/;

const selectorText = (sel) => {
  if (sel === null || typeof sel !== 'object') return String(sel);
  if (sel.textRegex !== undefined) return String(sel.textRegex);
  if (sel.idRegex !== undefined) return `id=${sel.idRegex}`;
  return JSON.stringify(sel);
};

/**
 * A condition as one short string, in the yaml's own vocabulary so a reader can grep the flow for
 * it: `visible: .*quick thing.*`, `notVisible: Loading`, `true: ${FILMKIT_MODE == 'test'}`,
 * `platform: iOS`. Two keys (a `when:` with visible and platform) are joined with ` & `.
 */
export function describeCondition(condition) {
  if (condition === null || typeof condition !== 'object') return String(condition);
  const parts = [];
  for (const [key, value] of Object.entries(condition)) {
    if (key === 'visible' || key === 'notVisible') parts.push(`${key}: ${selectorText(value)}`);
    else if (key === 'scriptCondition') parts.push(`true: ${value}`);
    else if (key === 'platform') parts.push(`platform: ${value}`);
    else if (key === 'label') continue;
    else parts.push(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
  }
  return parts.join(' & ') || JSON.stringify(condition);
}

/**
 * @param {object} o
 * @param {string} o.debugDir what was passed to `maestro test --debug-output`
 * @param {number|null} [o.recordingStartedMs] wall clock of video time 0, for `atSec`; null -> atSec null
 * @returns {Promise<{ branches: Array<{seq:number|null, when:string, modeGate?:true, status:string|null, atSec:number|null}>, filesRead: number }>}
 *   `filesRead` is how many commands-*.json parsed. 0 means "no record", NOT "no branches": the
 *   caller must not report `[]` as fact in that case.
 */
export async function readBranches({ debugDir, recordingStartedMs = null }) {
  const { commandLogs } = await locateLogs(debugDir);
  const branches = [];
  let filesRead = 0;
  for (const file of commandLogs) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    filesRead++;
    for (const entry of parsed) {
      const body = entry?.command?.runFlowCommand;
      if (!body || body.condition === undefined || body.condition === null) continue;
      const meta = entry.metadata ?? {};
      const when = describeCondition(body.condition);
      branches.push({
        seq: Number.isFinite(meta.sequenceNumber) ? meta.sequenceNumber : null,
        when,
        // A `when:` that reads FILMKIT_MODE is a MODE GATE (a test-only assertion, a pause skipped in
        // test), not a branch the app took: it is decided by how the camera launched Maestro, so it
        // says nothing about the app. Kept in the record, marked, and left out of the wrapper header.
        ...(MODE_GATE_RE.test(when) ? { modeGate: true } : {}),
        status: meta.status ?? null,
        atSec:
          recordingStartedMs !== null && Number.isFinite(meta.timestamp)
            ? Number(((meta.timestamp - recordingStartedMs) / 1000).toFixed(3))
            : null,
      });
    }
  }
  // One commands-*.json per flow file the run executed; the order within and across them is the
  // order Maestro flushed them, which is not the order they ran. seq is the run order.
  branches.sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity));
  return { branches, filesRead };
}
