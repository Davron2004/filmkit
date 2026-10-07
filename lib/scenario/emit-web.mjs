// ─────────────────────────────────────────────────────────────────────────────
// lib/scenario/emit-web.mjs — the web scenario (Part 2): a Playwright Test spec that runs the FLOW FILE
// ITSELF under the test-mode stage (lib/scenario/filmkit-stage.mjs), plus the two runs made on it
// afterwards (the load check, and the opt-in verify). Used by `film-web.mjs --scenario` and by
// `tools/scenario.mjs` (re-emit from a take's sidecar without filming). Plain Node ESM, no
// dependencies: Playwright is found in the SPEC's directory and run as a child process.
//
// WHAT IT WRITES, next to the flow or into --scenario-dir:
//   <stem>.scenario.spec.mjs   thin glue: imports the flow and the adapter, one test. <stem> is the
//                              flow's file name without its extension and without a `.demo` suffix
//                              (tip-demo.demo.mjs -> tip-demo.scenario.spec.mjs), whatever --name
//                              the take used: the spec belongs to the flow, not to one take.
//   filmkit-stage.mjs          ONE per directory, shared by every spec in it: a copy of
//                              lib/scenario/filmkit-stage.mjs with a marker first line. Named so no
//                              `*.spec.*` / `*.test.*` glob picks it up. Rewritten on every emit, so a
//                              directory's specs always run the adapter of the newest filmkit.
// Both carry the `@filmkit-generated` marker (lib/scenario/generated.mjs): a marked file is derived
// and overwritten without --force; an unmarked file at either path refuses the run in PREFLIGHT
// (plannedWebScenario + preflightWebScenario, called before anything is filmed) and again here at
// write time (a refusal then is a scenario failure: exit 2, the take stays ok).
//
// THE SPEC (see renderSpec for the exact text):
//   - provenance comment: the marker line (with how to regenerate, run from the spec's directory), flow
//     path + sha256, filmkit commit (lib/provenance.mjs), the take and its backend, the outcomes filmed,
//     the auth note, and `run: npx playwright test <spec file name>`. EVERY path in the file is relative
//     to the spec's own directory; no absolute machine path is written. A provenance path that would
//     climb through the machine's layout names an anchor instead (`<filmkit>/…`, `<flow-dir>/…`,
//     `<take-dir>/…`, `<serve-root>`); the import and serve root keep their `../` chain, because they
//     must resolve, and a warning says so when they leave the spec's project (lib/scenario/paths.mjs);
//   - `import { test, expect } from '<runner>'`: `@playwright/test` if it resolves from the spec's
//     directory, else `playwright/test`, decided at emit time. Neither resolving is not a refusal
//     (the spec may be run elsewhere); the load check then fails and says why;
//   - `test.use({ viewport })`: the filmed viewport, so layout (and so what is visible and where a
//     click lands) matches the take;
//   - the test timeout: 3x the filmed take + 60s (Playwright's 30s default kills any flow that waits
//     on a generation), FILMKIT_TIMEOUT_MS overrides; 3x NO_TAKE_TIMEOUT_SEC (180s) + 60s = 600s when
//     emitted without a take;
//   - createTestStage({ page, test, expect, serveRoot, baseUrl, pauseScale }): serveRoot is the
//     TAKE's serve root (the flow's directory, or --serve-root) as a path relative to the spec, so a
//     relative open() resolves as it did on film; baseUrl/pauseScale come from FILMKIT_BASE_URL and
//     FILMKIT_PAUSE_SCALE;
//   - `stage.outcomes` attached as `filmkit-outcomes` (application/json) in a finally.
//
// AUTH. The spec gets whatever storageState the project's Playwright config provides. filmkit does not
// export ego's cookies: that would write the user's personal session next to files that get
// committed. CI should use a test account's storageState. An ego take was filmed signed in, so its
// spec says so in the header, and a clean-room verify of it is expected to run signed out.
//
// THE LOAD CHECK (always, after emitting): `playwright test --list` on the spec under a generated
// clean-room config (testDir = the spec's directory, testMatch = exactly this spec). It loads the spec,
// the adapter and the flow without a browser, so a broken import or a syntax error surfaces now. It
// is bounded (LOAD_CHECK_TIMEOUT_MS) and yields { ok, output }. The runner is the CLI of the package the
// spec imports, resolved from the spec's directory: a second copy of the runner breaks test.step.
//
// VERIFY STATE MACHINE (opt-in; one run, never retried: a retry would repeat the app's side effects,
// paid generations and DB writes, and a flake is worth seeing as red):
//
//   RUNNING -> passed       every test result passed
//           -> failed       a result failed (the first error is recorded)
//           -> timeout      a result timed out (the spec's test timeout), or the wall-clock cap below
//                           expired (SIGINT, SIGKILL after graceMs)
//           -> interrupted  abort() was called (film-web's signal handler): same SIGINT/SIGKILL
//           -> error        the runner could not be spawned, or produced no readable report
//   Each is terminal; `done` always resolves, never rejects. Clean room (no config given): the
//   generated config, headless, no storageState, retries 0, one worker, so the result is this spec's
//   and nothing else's. `--scenario-config <file>`: the project's own config (its storageState, its
//   projects; a config with three projects runs the spec three times and every run must pass), with
//   the reporters overridden to line + JSON and retries forced to 0; the spec must be inside that
//   config's testDir. The record: { status, config, durationSec, outcomes, error, outputDir },
//   `outcomes` read from the `filmkit-outcomes` attachment of the first result that has one.
//   `outputDir`: a clean-room run that did not pass KEEPS its temporary directory and names its
//   test-results here, because the runner's own output points into it (the "Error Context" markdown,
//   screenshots, traces); a pass removes it, so the clean room leaves nothing behind. null under
//   --scenario-config (the project's own outputDir, which filmkit never deletes) and on a pass.
// THE CAP LIVES HERE: the spec's own test timeout bounds a test, not a runner that wedges before or
// after it (a browser that never launches). Cap = the spec's timeout + VERIFY_OVERHEAD_MS.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGeneratedTarget, markerLine, writeGeneratedFile } from './generated.mjs';
import { realPathLoose } from './filmkit-stage.mjs';
import { layoutWarning, provenancePath } from './paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILMKIT_ROOT = resolve(HERE, '..', '..');
const ADAPTER_SOURCE = join(HERE, 'filmkit-stage.mjs');
const DEFAULT_TAKE_DIR = join(FILMKIT_ROOT, 'out'); // film-web's default --out (lib/stage.mjs DEFAULT_OUT_DIR)
const FORMAT_VERSION = 'v1';

export const SPEC_SUFFIX = '.scenario.spec.mjs';
export const ADAPTER_NAME = 'filmkit-stage.mjs';
export const NO_TAKE_TIMEOUT_SEC = 180; // the "filmed duration" assumed when emitting without a take
const LOAD_CHECK_TIMEOUT_MS = 60_000;
const VERIFY_OVERHEAD_MS = 120_000;
const RUNNERS = ['@playwright/test', 'playwright/test'];
const PACKAGE_OF = { '@playwright/test': '@playwright/test', 'playwright/test': 'playwright' };

const ANSI_RE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const stripAnsi = (s) => String(s ?? '').replace(ANSI_RE, '');
const tailLines = (text, n) => stripAnsi(text).split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-n).join('\n');
const headLines = (text, n) => stripAnsi(text).split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(0, n).join('\n');
const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ');
const posix = (p) => p.split(sep).join('/');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** `tip-demo.demo.mjs` -> `tip-demo`: the file name without its extension and a `.demo` suffix. */
export function scenarioStem(flowPath) {
  return basename(flowPath, extname(flowPath)).replace(/\.demo$/, '');
}

/** Where the spec and the shared adapter for `flowPath` go. */
export function plannedWebScenario({ flowPath, scenarioDir }) {
  const dir = scenarioDir ? resolve(scenarioDir) : dirname(resolve(flowPath));
  const stem = scenarioStem(flowPath);
  return { dir, stem, spec: join(dir, `${stem}${SPEC_SUFFIX}`), adapter: join(dir, ADAPTER_NAME) };
}

/**
 * Which Playwright Test the spec will import, resolved from `dir` the way Node resolves the spec's own
 * import: `@playwright/test` first, then `playwright/test`. { importFrom, cli } or null for neither.
 */
export function resolveRunner(dir) {
  const require = createRequire(join(dir, '__filmkit_resolve__.cjs'));
  for (const specifier of RUNNERS) {
    try {
      require.resolve(specifier);
      const pkgJson = require.resolve(`${PACKAGE_OF[specifier]}/package.json`);
      return { importFrom: specifier, cli: join(dirname(pkgJson), 'cli.js') };
    } catch {
      // next
    }
  }
  return null;
}

/**
 * PREFLIGHT, before filming: both planned files must be absent or ours. Never throws.
 * @returns {Promise<{ planned: object, refusals: string[], runner: {importFrom:string, cli:string}|null }>}
 */
export async function preflightWebScenario({ flowPath, scenarioDir }) {
  const planned = plannedWebScenario({ flowPath, scenarioDir });
  const refusals = [];
  for (const path of [planned.spec, planned.adapter]) {
    const check = await checkGeneratedTarget(path);
    if (!check.ok) refusals.push(check.reason);
  }
  return { planned, refusals, runner: resolveRunner(planned.dir) };
}

// A relative ESM specifier (a URL) from `fromDir` to `toPath`: posix separators, each segment
// percent-encoded, always starting with ./ or ../ .
function relativeSpecifier(fromDir, toPath, { trailingSlash = false } = {}) {
  let rel = posix(relative(realPathLoose(fromDir), realPathLoose(toPath)));
  if (rel === '') return './';
  rel = rel.split('/').map((seg) => (seg === '..' || seg === '.' ? seg : encodeURIComponent(seg))).join('/');
  if (!rel.startsWith('../')) rel = `./${rel}`;
  return trailingSlash && !rel.endsWith('/') ? `${rel}/` : rel;
}

// EVERY PATH IN A GENERATED FILE IS RELATIVE TO THE SPEC'S OWN DIRECTORY, by lib/scenario/paths.mjs's
// rule, shared with the Maestro wrapper: the functional ones (the flow import, the serve root) keep their
// `../` chain because they must resolve, and emitWebScenario returns a warning when one leaves the
// spec's project (layoutWarning); the provenance ones (header flow and take, the regenerate commands)
// name an anchor instead (`<filmkit>/…`, `<flow-dir>/…`, `<take-dir>/…`, `<serve-root>`) wherever a
// `../` chain would climb through the machine's layout. The regenerate commands are stated as run FROM
// THE SPEC'S DIRECTORY.

function outcomesSummary(outcomes) {
  if (!outcomes) return 'unknown (emitted without a take)';
  if (outcomes.length === 0) return 'none (the flow has no oneOf)';
  return outcomes.map((o) => `${o.name}=${o.outcome ?? '(timeout)'}`).join(', ');
}

function authNote(backend) {
  if (backend === 'ego') {
    return 'Filmed signed-in (ego, your own browser profile); this spec gets whatever storageState your Playwright config provides.';
  }
  if (backend === 'playwright') {
    return 'Filmed in a fresh signed-out profile (playwright); this spec gets whatever storageState your Playwright config provides.';
  }
  return 'This spec gets whatever storageState your Playwright config provides.';
}

/** The test timeout the spec sets: 3x the filmed duration + 60s, in ms. */
export function scenarioTimeoutMs(durationSec) {
  const d = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : NO_TAKE_TIMEOUT_SEC;
  return Math.round((3 * d + 60) * 1000);
}

/**
 * The spec's text. Pure.
 * @param {object} o
 * @param {string} o.specPath
 * @param {string} o.flowPath
 * @param {string} o.flowSha256
 * @param {string} o.serveRoot absolute
 * @param {string} o.importFrom
 * @param {{width:number,height:number}} o.viewport
 * @param {{path?:string|null, sidecar?:string|null, durationSec?:number|null, backend?:string|null, outcomes?:Array|null}|null} o.take
 * @param {{commit:string}|null} o.filmkit
 */
export function renderSpec({ specPath, flowPath, flowSha256, serveRoot, importFrom, viewport, take, filmkit }) {
  const specDir = dirname(specPath);
  const stem = basename(specPath).slice(0, -SPEC_SUFFIX.length);
  const timeoutMs = scenarioTimeoutMs(take?.durationSec);
  // PROVENANCE paths and their anchors (lib/scenario/paths.mjs): the first anchor the path shares a tree
  // with names it when a `../` chain from here would climb through the machine's layout.
  const rel = (path, ...anchors) => provenancePath(specDir, path, anchors);
  const FILMKIT = { name: 'filmkit', dir: FILMKIT_ROOT, inside: true };
  const FLOW_DIR = { name: 'flow-dir', dir: dirname(resolve(flowPath)) };
  const TAKE_DIR = take?.path ? { name: 'take-dir', dir: dirname(take.path) } : null;
  const filmWeb = rel(join(FILMKIT_ROOT, 'film-web.mjs'), FILMKIT);
  const tool = rel(join(FILMKIT_ROOT, 'tools', 'scenario.mjs'), FILMKIT);
  const flowShown = rel(flowPath, FILMKIT, FLOW_DIR);
  // The flags that decide what this file says travel with the regenerate commands, so running one
  // (from this directory) reproduces it: --scenario-dir when the spec is not beside the flow,
  // --serve-root when the root is not the flow's directory (a take's sidecar carries its own root, so
  // the --from form needs only --scenario-dir), and for the filming form the take's --browser (always:
  // the default, auto, picks ego or playwright by what the machine has, so only naming it reproduces the
  // header's auth note), its --out and --name when they are not the defaults, and its --viewport when
  // it is not 1280x720 (the spec's test.use carries it). The flags that change only the VIDEO stay out:
  // --tighten, --crf, --force and --no-captions (a caption is never drawn in test mode, so a captioned
  // and a caption-free take of one flow emit the same spec, and carrying the flag would split them).
  const dirFlag = realPathLoose(specDir) !== realPathLoose(dirname(resolve(flowPath))) ? ' --scenario-dir .' : '';
  const rootFlag = realPathLoose(serveRoot) !== realPathLoose(dirname(flowPath)) ? ` --serve-root ${rel(serveRoot, FILMKIT, FLOW_DIR, { name: 'serve-root', dir: serveRoot })}` : '';
  const takeFlags = [];
  if (take?.backend) takeFlags.push(`--browser ${take.backend}`);
  if (take?.path) {
    if (realPathLoose(dirname(take.path)) !== realPathLoose(DEFAULT_TAKE_DIR)) takeFlags.push(`--out ${rel(dirname(take.path), TAKE_DIR)}`);
    const takeStem = basename(take.path).replace(/\.mp4$/, '');
    if (takeStem !== stem) takeFlags.push(`--name ${takeStem}`);
    if (viewport && (viewport.width !== 1280 || viewport.height !== 720)) takeFlags.push(`--viewport ${viewport.width}x${viewport.height}`);
  }
  const filmFlags = takeFlags.length ? ` ${takeFlags.join(' ')}` : '';
  const regenerate = take?.sidecar
    ? `from this directory, node ${filmWeb} ${flowShown}${filmFlags} --scenario${dirFlag}${rootFlag}, or without filming: node ${tool} ${flowShown} --from ${rel(take.sidecar, { name: 'take-dir', dir: dirname(take.sidecar) })}${dirFlag}`
    : `from this directory, node ${filmWeb} ${flowShown} --scenario${dirFlag}${rootFlag}, or without filming: node ${tool} ${flowShown}${dirFlag}${rootFlag}`;
  const takeText = take?.path
    ? `take ${rel(take.path, TAKE_DIR)}${Number.isFinite(take.durationSec) ? ` (${take.durationSec.toFixed(1)}s)` : ''} · backend ${take.backend ?? 'unknown'}`
    : 'take none (emitted without one)';
  const timeoutNote = Number.isFinite(take?.durationSec) && take.durationSec > 0
    ? `3x the filmed ${take.durationSec.toFixed(1)}s + 60s`
    : `no take: 3x ${NO_TAKE_TIMEOUT_SEC}s + 60s`;
  const header = [
    markerLine('//', `scenario ${FORMAT_VERSION}. Regenerate: ${oneLine(regenerate)}`),
    `// flow ${flowShown} sha256 ${flowSha256.slice(0, 16)} · filmkit ${filmkit?.commit ? filmkit.commit.slice(0, 7) : 'unknown'} · ${oneLine(takeText)}`,
    `// filmed outcomes: ${oneLine(outcomesSummary(take ? take.outcomes ?? [] : null))}. ${authNote(take?.backend)}`,
    // The spec's FILE NAME: Playwright reads it as a regex over test file paths, so the same command
    // finds this spec from the project root (under the project's config) and from this directory.
    `// run: npx playwright test ${basename(specPath)} · env: FILMKIT_BASE_URL (rebase the filmed origin), FILMKIT_PAUSE_SCALE (1 = filming pace), FILMKIT_TIMEOUT_MS`,
  ];
  const vp = { width: viewport?.width ?? 1280, height: viewport?.height ?? 720 };
  const body = [
    `import { test, expect } from ${JSON.stringify(importFrom)};`,
    `import flow from ${JSON.stringify(relativeSpecifier(specDir, flowPath))};`,
    `import { createTestStage } from ${JSON.stringify(`./${ADAPTER_NAME}`)};`,
    '',
    `test.use({ viewport: { width: ${vp.width}, height: ${vp.height} } }); // the filmed viewport`,
    '',
    `test(${JSON.stringify(`${stem} (filmkit scenario)`)}, async ({ page }, testInfo) => {`,
    `  test.setTimeout(Number(process.env.FILMKIT_TIMEOUT_MS) || ${timeoutMs}); // ${timeoutNote}`,
    '  const stage = createTestStage({',
    '    page,',
    '    test,',
    '    expect,',
    `    serveRoot: new URL(${JSON.stringify(relativeSpecifier(specDir, serveRoot, { trailingSlash: true }))}, import.meta.url),`,
    '    baseUrl: process.env.FILMKIT_BASE_URL,',
    '    pauseScale: process.env.FILMKIT_PAUSE_SCALE,',
    '  });',
    '  try {',
    '    await flow({ stage });',
    '  } finally {',
    "    await testInfo.attach('filmkit-outcomes', { body: JSON.stringify(stage.outcomes, null, 2), contentType: 'application/json' });",
    '  }',
    '});',
  ];
  return { text: `${[...header, ...body].join('\n')}\n`, timeoutMs };
}

/** The adapter copy's text: the source with a marker first line. */
export async function renderAdapter({ filmkit }) {
  const source = await readFile(ADAPTER_SOURCE, 'utf8');
  const first = markerLine(
    '//',
    `scenario adapter ${FORMAT_VERSION}: a copy of filmkit's lib/scenario/filmkit-stage.mjs (filmkit ${filmkit?.commit ? filmkit.commit.slice(0, 7) : 'unknown'}), shared by every *.scenario.spec.mjs in this directory. Rewritten on every emit; change the original.`,
  );
  return `${first}\n${source}`;
}

/**
 * Emit the adapter and the spec. Throws on any failure (an unmarked file in the way, a write error);
 * the caller records it and exits 2 with the take intact.
 * @param {object} o
 * @param {string} o.flowPath absolute
 * @param {string} [o.scenarioDir]
 * @param {string} o.serveRoot absolute; the take's serve root (flow dir unless --serve-root)
 * @param {{width:number,height:number}} o.viewport
 * @param {object|null} o.take see renderSpec
 * @param {{commit:string}|null} o.filmkit
 * @returns {Promise<object>} the paths written and what was decided; `warnings` (string[]) says when the
 *   flow import or serve root leaves the spec's project, for the caller to print and record
 */
export async function emitWebScenario({ flowPath, scenarioDir, serveRoot, viewport, take, filmkit }) {
  const planned = plannedWebScenario({ flowPath, scenarioDir });
  const flowText = await readFile(flowPath, 'utf8');
  const flowSha256 = sha256(flowText);
  const runner = resolveRunner(planned.dir);
  const importFrom = runner?.importFrom ?? RUNNERS[0];
  const adapterText = await renderAdapter({ filmkit });
  const { text: specText, timeoutMs } = renderSpec({
    specPath: planned.spec, flowPath, flowSha256, serveRoot, importFrom, viewport, take, filmkit,
  });
  // Adapter first: a spec is never on disk without the adapter it imports.
  const adapterWrite = await writeGeneratedFile(planned.adapter, adapterText);
  const specWrite = await writeGeneratedFile(planned.spec, specText);
  // The FUNCTIONAL paths resolve wherever they point; one that leaves the spec's project ties the spec to
  // this machine (lib/scenario/paths.mjs). The serve root is checked only when it is not the flow's own
  // directory, which the flow import's warning already covers.
  const warnings = [layoutWarning(planned.dir, flowPath, 'The spec\'s flow import')];
  if (realPathLoose(serveRoot) !== realPathLoose(dirname(resolve(flowPath)))) warnings.push(layoutWarning(planned.dir, serveRoot, 'The spec\'s serveRoot', 'the serve root'));
  return {
    warnings: warnings.filter(Boolean),
    spec: planned.spec,
    adapter: planned.adapter,
    scenarioDir: scenarioDir ? resolve(scenarioDir) : null,
    adapterSha256: sha256(adapterText),
    importFrom,
    runnerResolved: Boolean(runner),
    specAction: specWrite.action,
    adapterAction: adapterWrite.action,
    flowSha256,
    timeoutMs,
  };
}

// ── Running the spec ──────────────────────────────────────────────────────────────────────────

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// The clean-room config: exactly this spec, nothing from any project config.
async function writeCleanConfig(workDir, specPath, reportPath) {
  const configPath = join(workDir, 'filmkit-clean-room.config.mjs');
  const text = `// filmkit clean-room config for one scenario spec (generated, temporary)
export default {
  testDir: ${JSON.stringify(dirname(specPath))},
  testMatch: new RegExp(${JSON.stringify(`^${escapeRegExp(specPath)}$`)}),
  outputDir: ${JSON.stringify(join(workDir, 'test-results'))},
  reporter: [['line'], ['json', { outputFile: ${JSON.stringify(reportPath)} }]],
  retries: 0,
  workers: 1,
  use: { headless: true },
};
`;
  await writeFile(configPath, text);
  return configPath;
}

function runChild(cmd, args, { cwd, env, timeoutMs, echo = false, graceMs = 10_000 }) {
  let child = null;
  let stopReason = null;
  let killTimer = null;
  let out = '';
  const startedMs = Date.now();
  const stop = (reason) => {
    if (stopReason || !child) return;
    stopReason = reason;
    child.kill('SIGINT');
    killTimer = setTimeout(() => child.kill('SIGKILL'), graceMs);
  };
  const done = new Promise((resolveDone) => {
    let capTimer = null;
    const finish = (r) => {
      clearTimeout(killTimer);
      clearTimeout(capTimer);
      resolveDone({ ...r, out, stopReason, durationSec: Number(((Date.now() - startedMs) / 1000).toFixed(2)) });
    };
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return finish({ code: null, spawnError: err.message });
    }
    for (const [stream, sink] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.on('data', (c) => {
        if (echo) sink.write(c);
        out = (out + c).slice(-40_000);
      });
    }
    child.on('error', (err) => finish({ code: null, spawnError: err.message }));
    child.on('exit', (code, signal) => finish({ code, signal }));
    if (timeoutMs > 0) capTimer = setTimeout(() => stop('timeout'), timeoutMs);
  });
  return { done, abort: () => stop('interrupted'), kill: () => child?.kill('SIGKILL') };
}

/**
 * `playwright test --list` on the spec, clean room. Never throws.
 * @param {{ spec: string, signal?: AbortSignal }} o
 * @returns {Promise<{ ok: boolean, output: string }>}
 */
export async function loadCheck({ spec, signal }) {
  const runner = resolveRunner(dirname(spec));
  if (!runner) {
    return {
      ok: false,
      output: `neither @playwright/test nor playwright/test resolves from ${dirname(spec)}; install @playwright/test in the project that holds the spec (npm i -D @playwright/test)`,
    };
  }
  const stopped = { ok: false, output: 'stopped by a signal' };
  if (signal?.aborted) return stopped;
  const workDir = await mkdtemp(join(tmpdir(), 'filmkit-scenario-'));
  try {
    const config = await writeCleanConfig(workDir, spec, join(workDir, 'report.json'));
    // An abort that landed during the awaits above has no listener to hear it: look before spawning.
    if (signal?.aborted) return stopped;
    const handle = runChild(process.execPath, [runner.cli, 'test', '--config', config, '--list'], {
      cwd: dirname(spec),
      env: process.env,
      timeoutMs: LOAD_CHECK_TIMEOUT_MS,
    });
    const onAbort = () => handle.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const r = await handle.done;
    signal?.removeEventListener('abort', onAbort);
    const listed = /Total: 1 test in 1 file/.test(stripAnsi(r.out));
    if (r.stopReason === 'interrupted') return stopped;
    if (r.stopReason === 'timeout') return { ok: false, output: `playwright test --list did not finish within ${LOAD_CHECK_TIMEOUT_MS / 1000}s\n${tailLines(r.out, 8)}` };
    if (r.spawnError) return { ok: false, output: `could not run the Playwright CLI (${runner.cli}): ${r.spawnError}` };
    const ok = r.code === 0 && listed;
    return { ok, output: ok ? tailLines(r.out, 3) : tailLines(r.out, 15) || `playwright test --list exited ${r.code}` };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// Every test result in a JSON report, however deeply the suites nest.
function resultsOf(report) {
  const out = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) for (const t of spec.tests ?? []) for (const r of t.results ?? []) out.push(r);
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report?.suites ?? []) walk(suite);
  return out;
}

function outcomesFrom(results) {
  for (const r of results) {
    const a = (r.attachments ?? []).find((x) => x.name === 'filmkit-outcomes' && x.body);
    if (!a) continue;
    try {
      return JSON.parse(Buffer.from(a.body, 'base64').toString('utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Run the spec once (VERIFY STATE MACHINE). `timeoutMs` is the spec's test timeout; the wall-clock cap
 * adds VERIFY_OVERHEAD_MS. Echoes the runner's line reporter.
 * @param {{ spec: string, config?: string|null, timeoutMs: number }} o
 * @returns {{ done: Promise<{status:string, config:string|null, durationSec:number, outcomes:Array|null, error:string|null}>, abort: () => void, kill: () => void }}
 */
export function startVerify({ spec, config = null, timeoutMs }) {
  let handle = null;
  let aborted = false;
  const done = (async () => {
    const started = Date.now();
    let outputDir = null; // set once the clean room's results exist; kept on disk unless the run passed
    const record = (status, extra = {}) => ({
      status,
      config,
      durationSec: Number(((Date.now() - started) / 1000).toFixed(2)),
      outcomes: null,
      error: null,
      outputDir: status === 'passed' ? null : outputDir,
      ...extra,
    });
    const runner = resolveRunner(dirname(spec));
    if (!runner) return record('error', { error: `neither @playwright/test nor playwright/test resolves from ${dirname(spec)}` });
    const workDir = await mkdtemp(join(tmpdir(), 'filmkit-verify-'));
    let result = null;
    try {
      result = await (async () => {
        const reportPath = join(workDir, 'report.json');
        let args;
        let cwd;
        const env = { ...process.env };
        if (config) {
          // Playwright reads a positional argument as a REGEX over absolute file paths, so the spec's own
          // path would be misread wherever it holds regex syntax (`app (copy)/` matched nothing, measured).
          // Anchored and escaped, it names exactly this file.
          args = [runner.cli, 'test', '--config', config, '--reporter=line,json', '--retries=0', `^${escapeRegExp(spec)}$`];
          cwd = dirname(config);
          env.PLAYWRIGHT_JSON_OUTPUT_NAME = reportPath;
        } else {
          args = [runner.cli, 'test', '--config', await writeCleanConfig(workDir, spec, reportPath)];
          cwd = dirname(spec);
          outputDir = join(workDir, 'test-results');
        }
        if (aborted) return record('interrupted', { error: 'stopped by a signal before the run started' });
        handle = runChild(process.execPath, args, { cwd, env, timeoutMs: timeoutMs + VERIFY_OVERHEAD_MS, echo: true });
        const r = await handle.done;
        if (r.spawnError) return record('error', { error: `could not run the Playwright CLI (${runner.cli}): ${r.spawnError}` });
        if (r.stopReason === 'interrupted') return record('interrupted', { error: 'stopped by a signal to the camera' });
        const report = await readFile(reportPath, 'utf8').then(JSON.parse).catch(() => null);
        const results = resultsOf(report);
        const outcomes = outcomesFrom(results);
        if (r.stopReason === 'timeout') {
          return record('timeout', { outcomes, error: `the runner was stopped after the ${Math.round((timeoutMs + VERIFY_OVERHEAD_MS) / 1000)}s cap\n${tailLines(r.out, 10)}` });
        }
        if (!report) return record('error', { error: `no readable report (runner exited ${r.code})\n${tailLines(r.out, 15)}` });
        if (results.length === 0) {
          const why = (report.errors ?? []).map((e) => stripAnsi(e.message)).join('\n') || tailLines(r.out, 15);
          return record('error', { error: `no test ran${config ? ' (is the spec inside the config\'s testDir?)' : ''}\n${headLines(why, 20)}` });
        }
        const bad = results.find((x) => x.status !== 'passed');
        if (!bad) return record('passed', { outcomes });
        const message = (bad.errors ?? []).map((e) => e.message).join('\n') || bad.error?.message || `test ${bad.status}`;
        return record(bad.status === 'timedOut' ? 'timeout' : bad.status === 'interrupted' ? 'interrupted' : 'failed', {
          outcomes,
          error: headLines(message, 20),
        });
      })();
      return result;
    } finally {
      // KEPT when the run did not pass: the runner's output names files in it (the "Error Context"
      // markdown, screenshots, traces) that the operator is about to open, and the sidecar's
      // `scenario.verify.outputDir` points at it. A pass leaves nothing behind.
      const keep = Boolean(result) && result.status !== 'passed' && Boolean(outputDir) && existsSync(outputDir);
      if (!keep) {
        if (result) result.outputDir = null;
        await rm(workDir, { recursive: true, force: true });
      }
    }
  })();
  return {
    done,
    abort: () => {
      aborted = true;
      handle?.abort();
    },
    kill: () => handle?.kill(),
  };
}
