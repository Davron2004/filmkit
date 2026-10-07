// ─────────────────────────────────────────────────────────────────────────────
// lib/scenario/emit-maestro.mjs — the Maestro scenario wrapper (Part 2, mobile). Used by film-ios
// and film-android with --scenario. Plain Node ESM, no dependencies, and NO YAML parser: the two
// facts it needs from the flow (appId, pause timeouts) come from line scans, the way the rest of
// filmkit reads flows.
//
// WHAT IT WRITES: `<flow-stem>.scenario.yaml` next to the flow (or into --scenario-dir). EVERY PATH IN IT IS
// RELATIVE TO THE WRAPPER'S OWN DIRECTORY, always, by lib/scenario/paths.mjs's rule (shared with the web
// spec): `runFlow` `file:` (Maestro resolves it against the wrapper's directory), the header's `flow`, and
// the `run:` line (run from the wrapper's directory, `.`). A generated file has to survive the project being
// cloned elsewhere, so it never carries an absolute machine path or one relative to wherever the camera
// happened to run. `file:` is FUNCTIONAL: it keeps its `../../../` chain when the wrapper lives in another
// tree, because it must resolve, and the result carries a warning when that chain leaves the wrapper's
// project (`warnings`, which the camera prints and records). The header's `flow` is PROVENANCE: where the
// chain would climb through the machine's layout (a wrapper in /tmp, a flow in ~) it reads
// `<filmkit>/…` or `<flow-dir>/…` instead. It runs the ORIGINAL flow, so there is one source of steps and
// nothing to drift:
//
//   # @filmkit-generated scenario v1. flow gen.yaml sha256 3f9c… · filmkit d7fe63f · filmed ios, --fresh
//   # branches filmed: seq7 "visible: .*quick thing.*" SKIPPED · filming pauses: 38s skipped in test mode, 0s paid
//   # not carried: --install, --clean-status-bar
//   # run from this file's directory: maestro test --include-tags filmkit-scenario --format junit --output report.xml .
//   appId: com.example
//   name: gen (filmkit scenario)
//   tags: [filmkit-scenario]
//   ---
//   - clearState          # ...            (only when the take used --fresh)
//   - runFlow:
//       file: gen.yaml
//       env: { FILMKIT_MODE: test }
//
// STATE MACHINE. Stateless: planned path -> (check marker) -> render -> atomic write. The marker rule
// (absent or marked: write; unmarked: refuse) lives in lib/scenario/generated.mjs; the camera runs
// it in PREFLIGHT via plannedWrapper() + checkGeneratedTarget(), and this module re-checks at write
// time. A refusal or any failure here throws; the camera records it and exits 2 with the take intact.
//
// THE TAG IS LOAD-BEARING. `maestro test <dir>` runs every flow file in the directory, so with the
// wrapper next to the flow the flow would run twice: once standalone (with FILMKIT_MODE undefined)
// and once through the wrapper. `tags: [filmkit-scenario]` on the wrapper plus
// `--include-tags filmkit-scenario` selects only the wrapper. (Measured, iOS, Maestro 2.6.0: with the
// tag one run; without it both files.) A flow that already carries the tag defeats this: emit refuses (an error the camera records, exit 2).
//
// PRECONDITIONS. Only `--fresh` becomes wrapper steps, because it is the one camera flag that
// changes app state the wrapper can reproduce:
//   * android: `clearState`. Maestro's Android clearState is `pm clear`, what `--fresh` runs, so no gap.
//   * ios: `clearState` + `clearKeychain`. `--fresh` UNINSTALLS the app and `--install`s the build
//     under test. Maestro 2.6.0's iOS clearState is `reinstallApp` (measured: the stack trace of a
//     failing run is LocalSimulatorUtils.clearAppState -> reinstallApp -> uninstall, and on a
//     third-party app a marker file in Documents and a UserDefaults key were both gone after it), so
//     app data is wiped about as thoroughly. The gaps: it reinstalls whatever is INSTALLED, not the
//     build under test, and it FAILS on a system app ("Uninstall prohibited" on com.apple.Preferences).
//     clearKeychain covers what an uninstall leaves behind on a simulator.
//
// NOT CARRIED: the camera flags this take used that change device or app state the wrapper cannot
// reproduce. The camera derives the list from its own flags and passes it in; this module only
// prints it. Flags that only change the VIDEO (--tighten, --codec, --crf, --no-show-taps...) are
// never listed.
//
// PAUSES, counted by scanning the FLOW FILE TEXT for waits whose `visible:` is the pause marker
// `__filmkit_demo_pause_marker__` and summing their `timeout:` (authored, not measured). Two kinds:
//   * GATED: inside a `runFlow: { when: { true: "${FILMKIT_MODE != 'test'}" }, commands: [...] }`, the
//     idiom the templates use. SKIPPED in test mode, held in film mode AND when the variable is undefined
//     (measured on Maestro 2.6.0, iOS and Android, both idioms). The wrapper header says how many seconds
//     a test run skips.
//   * UNGATED: a bare wait, still valid for a flow that does not care. PAID in test mode.
// The gate is recognised by its text (an enclosing `commands:` block whose sibling `when:` matches
// FILMKIT_MODE != 'test'). A `when:` that mentions FILMKIT_MODE any other way is `unclassified` and counted
// in neither (reported in the header line), not guessed at.
// NOT COUNTED, and said so: pauses inside `runFlow: file:` includes (the scan reads this one file), and
// timeouts that are not a plain number. `repeat:` bodies count once.
// MEASURED (Maestro 2.6.0): a SKIPPED gate costs ~0.3-0.8s of inter-command overhead; the alternative,
// `timeout: "${FILMKIT_MODE == 'test' ? 0 : N}"`, costs one failed hierarchy poll (0.7-2.4s) per pause.
// Precedence, measured: a flow header `env:` beats `runFlow env:` beats `-e`, so FILMKIT_MODE must never be
// put in a flow's header `env:` (it would pin the mode and override the wrapper's test).
//
// REFUSES a flow that already carries the `filmkit-scenario` tag: with the tag on both files
// `--include-tags` would select the flow standalone as well as the wrapper.
import { dirname, basename, extname, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkGeneratedTarget, markerLine, writeGeneratedFile } from './generated.mjs';
import { realPathLoose } from './filmkit-stage.mjs';
import { layoutWarning, provenancePath } from './paths.mjs';

const FILMKIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SCENARIO_TAG = 'filmkit-scenario';
export const PAUSE_MARKER = '__filmkit_demo_pause_marker__';
const FORMAT_VERSION = 'v1';

/** Where the wrapper for `flowPath` goes. */
export function plannedWrapper({ flowPath, scenarioDir }) {
  const dir = scenarioDir ? resolve(scenarioDir) : dirname(flowPath);
  const stem = basename(flowPath, extname(flowPath));
  return { dir, path: join(dir, `${stem}.scenario.yaml`), stem };
}

/** The part of a flow file above the first `---` line (the whole file if there is none). */
function flowHeader(flowText) {
  const lines = flowText.split(/\r?\n/);
  const cut = lines.findIndex((l) => /^---\s*$/.test(l));
  return (cut === -1 ? lines : lines.slice(0, cut)).join('\n');
}

/** `appId:` from the flow header, by line regex. Null when absent. */
export function readAppId(flowText) {
  const m = /^appId:[ \t]*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s#]+))/m.exec(flowHeader(flowText));
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

const stripComment = (line) => (/^\s*#/.test(line) ? '' : line.replace(/\s+#.*$/, ''));
const indentOf = (line) => line.length - line.trimStart().length;

/** Tags declared in the flow header: `tags: [a, b]`, `tags: a`, or a block list. */
export function flowTags(flowText) {
  const lines = flowHeader(flowText).split('\n').map(stripComment);
  const at = lines.findIndex((l) => /^tags:/.test(l));
  if (at === -1) return [];
  const tags = [];
  const inline = lines[at].replace(/^tags:\s*/, '').replace(/^\[|\]\s*$/g, '');
  for (const t of inline.split(',')) if (t.trim()) tags.push(t.trim().replace(/^["']|["']$/g, ''));
  for (let j = at + 1; j < lines.length && (lines[j].trim() === '' || /^\s+-/.test(lines[j])); j++) {
    const m = /^\s+-\s*(.+?)\s*$/.exec(lines[j]);
    if (m) tags.push(m[1].replace(/^["']|["']$/g, ''));
  }
  return tags;
}

// A `when:` that skips the pause in test mode. Anything else that mentions FILMKIT_MODE is unclassified.
const SKIP_IN_TEST_RE = /FILMKIT_MODE\s*!==?\s*['"]test['"]/;

/** The text of the `when:` that sits beside the `commands:` line at index `j` (its whole mapping value). */
function whenBeside(lines, j) {
  const c = indentOf(lines[j]);
  const scan = (from, step) => {
    for (let k = from; k >= 0 && k < lines.length; k += step) {
      if (lines[k].trim() === '') continue;
      const ind = indentOf(lines[k]);
      if (ind < c || (ind === c && lines[k].trimStart().startsWith('- '))) return null;
      if (ind === c && /^\s*when:/.test(lines[k])) {
        let text = lines[k];
        for (let m = k + 1; m < lines.length && (lines[m].trim() === '' || indentOf(lines[m]) > c); m++) text += `\n${lines[m]}`;
        return text;
      }
    }
    return null;
  };
  return scan(j - 1, -1) ?? scan(j + 1, 1) ?? '';
}

/** `when:` texts of every `commands:` block that encloses line `i`. */
function enclosingWhens(lines, i) {
  const out = [];
  let threshold = indentOf(lines[i]);
  for (let j = i - 1; j >= 0; j--) {
    if (lines[j].trim() === '') continue;
    const ind = indentOf(lines[j]);
    if (ind >= threshold) continue;
    threshold = ind;
    if (/^\s*commands:\s*$/.test(lines[j])) out.push(whenBeside(lines, j));
  }
  return out;
}

/**
 * The pause-marker waits in a flow, by scanning its text. A marker line sits inside an
 * `extendedWaitUntil` mapping; its `timeout:` is a sibling key, on the same line (flow-style) or on a
 * line at the same indentation directly above or below it.
 * @returns {{ skippedInTestSec: number, paidInTestSec: number, count: number, gatedCount: number,
 *   unparsed: number, unclassified: number }} `unparsed`: waits whose timeout is not a plain number;
 *   `unclassified`: waits under a `when:` that mentions FILMKIT_MODE but is not the skip-in-test gate.
 *   Neither is in the seconds.
 */
export function countPauses(flowText) {
  const lines = flowText.split(/\r?\n/).map(stripComment);
  let gatedMs = 0;
  let paidMs = 0;
  let count = 0;
  let gatedCount = 0;
  let unparsed = 0;
  let unclassified = 0;
  const timeoutIn = (line) => /\btimeout:\s*["']?(\d+)["']?\s*(?:[,}]|$)/.exec(line);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(PAUSE_MARKER)) continue;
    let m = timeoutIn(lines[i]);
    if (!m) {
      // Sibling keys of the same mapping: lines at this line's indentation that do not open a new
      // list item, walking out both ways past blank/comment lines, stopping at anything else.
      const base = indentOf(lines[i]);
      const walk = (from, step) => {
        for (let j = from; j >= 0 && j < lines.length; j += step) {
          if (lines[j].trim() === '') continue;
          if (indentOf(lines[j]) !== base || lines[j].trimStart().startsWith('- ')) return null;
          const hit = timeoutIn(lines[j]);
          if (hit) return hit;
        }
        return null;
      };
      m = walk(i - 1, -1) ?? walk(i + 1, 1);
    }
    count++;
    const modeWhens = enclosingWhens(lines, i).filter((w) => /\bFILMKIT_MODE\b/.test(w));
    const gated = modeWhens.some((w) => SKIP_IN_TEST_RE.test(w));
    if (modeWhens.length > 0 && !gated) {
      unclassified++;
      continue;
    }
    if (!m) {
      unparsed++;
      continue;
    }
    if (gated) {
      gatedMs += Number(m[1]);
      gatedCount++;
    } else {
      paidMs += Number(m[1]);
    }
  }
  return {
    skippedInTestSec: Number((gatedMs / 1000).toFixed(2)),
    paidInTestSec: Number((paidMs / 1000).toFixed(2)),
    count,
    gatedCount,
    unparsed,
    unclassified,
  };
}

const fmtSec = (s) => `${Number(s.toFixed(1))}s`;

// A YAML plain scalar when it is safe as one, else a JSON (= YAML double-quoted) string.
const yamlScalar = (s) => (/^[A-Za-z0-9_./-][A-Za-z0-9_./ ()-]*$/.test(s) && !/^-\s|\s$/.test(s) && !/^(true|false|null|yes|no|on|off|~)$/i.test(s) ? s : JSON.stringify(s));

const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ');

function branchesHeader(branches) {
  if (branches === null || branches === undefined) return 'branches filmed: unknown (no command record was readable)';
  // Mode gates (a `when:` on FILMKIT_MODE) are not branches the app took; they stay in the sidecar only.
  const real = branches.filter((b) => !b.modeGate);
  if (real.length === 0) return 'branches filmed: none';
  return `branches filmed: ${real
    .map((b) => `${b.seq === null ? 'seq?' : `seq${b.seq}`} ${JSON.stringify(oneLine(b.when))} ${b.status ?? '?'}`)
    .join(', ')}`;
}

const CLEAR_STATE_COMMENT = {
  android: ['clearState          # the take used --fresh (`pm clear`, which is what Maestro\'s Android clearState runs)'],
  ios: [
    'clearState          # the take used --fresh (uninstall + install of the build). Maestro 2.6 iOS clearState reinstalls the app',
    '                    # that is installed now: data wiped, but not the build under test, and it fails on system apps',
    'clearKeychain       # what an uninstall leaves behind on a simulator',
  ],
};

/**
 * Render and write the wrapper. Throws on any failure (no appId, unmarked file in the way, write error).
 * @param {object} o
 * @param {'ios'|'android'} o.camera
 * @param {string} o.flowPath absolute
 * @param {string} o.flowText the flow as it was when filmed
 * @param {string} [o.scenarioDir]
 * @param {boolean} o.fresh the take used --fresh
 * @param {Array|null} o.branches from readBranches; null = no record
 * @param {string[]} o.notCarried
 * @param {{commit:string, branch:string|null}|null} o.filmkit
 */
export async function emitMaestroScenario({ camera, flowPath, flowText, scenarioDir, fresh, branches, notCarried, filmkit }) {
  if (!CLEAR_STATE_COMMENT[camera]) throw new Error(`unknown camera "${camera}"`);
  const appId = readAppId(flowText);
  if (appId === null) throw new Error(`no \`appId:\` in the header of ${flowPath}; the wrapper needs one to clear state and to launch under`);
  if (!/^[A-Za-z0-9._-]+$/.test(appId)) {
    throw new Error(`appId "${appId}" in ${flowPath} is not a literal bundle id / package name (a \${VAR} cannot be resolved by a wrapper that has no env of its own)`);
  }
  if (flowTags(flowText).includes(SCENARIO_TAG)) {
    throw new Error(
      `${flowPath} already carries the \`${SCENARIO_TAG}\` tag, so \`maestro test --include-tags ${SCENARIO_TAG} <dir>\` would run it standalone ` +
        'as well as through the wrapper (the standalone run without FILMKIT_MODE=test). Remove the tag from the flow.',
    );
  }
  const planned = plannedWrapper({ flowPath, scenarioDir });
  // Relative to the wrapper's directory, always (see WHAT IT WRITES), between real paths: Maestro resolves
  // `file:` from where the wrapper really is. The header's copy is provenance, and names an anchor rather
  // than climb through the machine's layout.
  const flowRel = relative(realPathLoose(planned.dir), realPathLoose(flowPath)).split(sep).join('/');
  const flowShown = provenancePath(planned.dir, flowPath, [{ name: 'filmkit', dir: FILMKIT_ROOT, inside: true }, { name: 'flow-dir', dir: dirname(flowPath) }]);
  const warnings = [layoutWarning(planned.dir, flowPath, "The wrapper's runFlow file")].filter(Boolean);
  const flowSha256 = createHash('sha256').update(flowText).digest('hex');
  const pauses = countPauses(flowText);
  const preconditions = fresh ? (camera === 'ios' ? ['clearState', 'clearKeychain'] : ['clearState']) : [];

  const pauseNotes = [
    pauses.unparsed ? `${pauses.unparsed} with a timeout that is not a plain number not counted` : null,
    pauses.unclassified ? `${pauses.unclassified} under an unrecognised FILMKIT_MODE gate not counted` : null,
  ].filter(Boolean);
  const pauseText = pauses.count === 0
    ? 'no filming pauses'
    : `filming pauses: ${fmtSec(pauses.skippedInTestSec)} skipped in test mode, ${fmtSec(pauses.paidInTestSec)} paid${pauseNotes.length ? ` (${pauseNotes.join('; ')})` : ''}`;
  const header = [
    markerLine('#', `scenario ${FORMAT_VERSION}. flow ${flowShown} sha256 ${flowSha256.slice(0, 16)} · filmkit ${filmkit?.commit ? filmkit.commit.slice(0, 7) : 'unknown'} · filmed ${camera}${fresh ? ', --fresh' : ''}`),
    `# ${branchesHeader(branches)} · ${pauseText}`,
    `# not carried: ${notCarried.length ? notCarried.join(', ') : 'none'}`,
    `# run from this file's directory: maestro test --include-tags ${SCENARIO_TAG} --format junit --output report.xml .`,
  ];
  const body = [
    `appId: ${appId}`,
    `name: ${yamlScalar(`${planned.stem} (filmkit scenario)`)}`,
    `tags: [${SCENARIO_TAG}]`,
    '---',
    ...(fresh ? CLEAR_STATE_COMMENT[camera].map((l) => (l.startsWith(' ') ? `  ${l}` : `- ${l}`)) : []),
    '- runFlow:',
    `    file: ${yamlScalar(flowRel)}`,
    '    env: { FILMKIT_MODE: test }',
  ];
  const text = `${[...header, ...body].join('\n')}\n`;
  const { action } = await writeGeneratedFile(planned.path, text);
  return { wrapper: planned.path, action, warnings, preconditions, notCarried, pauseSec: { skippedInTest: pauses.skippedInTestSec, paidInTest: pauses.paidInTestSec }, pauseCount: pauses.count, pauseUnparsed: pauses.unparsed, pauseUnclassified: pauses.unclassified, flowSha256, text };
}

export { checkGeneratedTarget };
