#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// tools/scenario.mjs — (re)emit a web flow's Playwright scenario WITHOUT filming (Part 2).
//
//   node tools/scenario.mjs <flow.demo.mjs> [--from <take.json>] [--scenario-dir <dir>] [--serve-root <dir>]
//
// Writes the same two files `film-web.mjs --scenario` writes (lib/scenario/emit-web.mjs):
// `<flow-stem>.scenario.spec.mjs` and the shared `filmkit-stage.mjs`, next to the flow or into
// --scenario-dir, then runs the same load check (`playwright test --list`, clean room). For a spec
// whose adapter is out of date after a filmkit update, for a spec that was deleted, or for a flow
// filmed before --scenario existed.
//
// --from <take.json> is a web take's sidecar. It supplies what the spec's header and timeout are made
// of: the take's video and duration (test timeout 3x + 60s), its backend (the auth note), the
// outcomes it filmed, its viewport, and its serve root. Only an `ok` take is accepted, the rule
// film-web follows. A take of a different flow file is refused; a take of the same file whose content
// has changed since (sha256) is a warning: the spec runs the flow as it is NOW, and the header records
// the current hash. Without --from the spec has no take to describe: timeout 3x 180s + 60s, the
// default 1280x720 viewport, and the serve root is --serve-root or the flow's directory.
// --serve-root overrides the take's root either way. The take's --scenario-dir (sidecar
// `scenario.scenarioDir`, recorded when it was filmed with --scenario) is reused unless --scenario-dir
// is given here, so a re-emit lands where the filmed one did.
//
// MARKER RULES are generated.mjs's: an absent or `@filmkit-generated` file is written, an unmarked
// one refuses before anything is written. This tool never touches the take or its sidecar.
//
// EXIT: 0 written and loads; 2 written, load check failed; 1 usage error, refusal before writing, or a
// write that failed. The adapter is written before the spec, so a failed SPEC write can leave the
// directory's filmkit-stage.mjs already rewritten (a marked, derived file; the specs beside it keep
// working with it) and the spec as it was.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { valueFor } from '../lib/args.mjs';
import { filmkitCommit } from '../lib/provenance.mjs';
import { emitWebScenario, loadCheck, preflightWebScenario } from '../lib/scenario/emit-web.mjs';
import { fileExists } from '../lib/tools.mjs';

const USAGE = 'usage: node tools/scenario.mjs <flow.demo.mjs> [--from <take.json>] [--scenario-dir <dir>] [--serve-root <dir>]';
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function parseArgs(argv) {
  const rest = [];
  let from;
  let scenarioDir;
  let serveRoot;
  const take = (i, flag) => valueFor(argv, i, flag, (m) => fail(m));
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') from = take(i++, '--from');
    else if (argv[i] === '--scenario-dir') scenarioDir = take(i++, '--scenario-dir');
    else if (argv[i] === '--serve-root') serveRoot = take(i++, '--serve-root');
    else if (argv[i] === '--help' || argv[i] === '-h') fail(USAGE, 0);
    else if (argv[i].startsWith('--')) fail(`unknown flag ${argv[i]}\n${USAGE}`);
    else rest.push(argv[i]);
  }
  if (rest.length !== 1) fail(USAGE);
  return {
    flowPath: resolve(rest[0]),
    from: from ? resolve(from) : undefined,
    scenarioDir: scenarioDir ? resolve(scenarioDir) : undefined,
    serveRoot: serveRoot ? resolve(serveRoot) : undefined,
  };
}

async function main() {
  const { flowPath, from, scenarioDir: scenarioDirArg, serveRoot: serveRootArg } = parseArgs(process.argv.slice(2));
  let scenarioDir = scenarioDirArg;
  if (!(await fileExists(flowPath))) fail(`flow file not found: ${flowPath}`);
  if (serveRootArg && !(await fileExists(serveRootArg))) fail(`--serve-root ${serveRootArg} does not exist`);

  let take = null;
  let viewport = DEFAULT_VIEWPORT;
  let serveRoot = serveRootArg ?? dirname(flowPath);
  if (from) {
    let sidecar;
    try {
      sidecar = JSON.parse(await readFile(from, 'utf8'));
    } catch (err) {
      fail(`--from ${from}: not a readable take sidecar (${err.message})`);
    }
    if (sidecar.status !== 'ok') fail(`--from ${from}: the take's status is "${sidecar.status}"; a scenario is only emitted from an ok take`);
    if (!sidecar.flow || resolve(sidecar.flow) !== flowPath) {
      fail(`--from ${from} is a take of ${sidecar.flow ?? '(no flow recorded)'}, not of ${flowPath}`);
    }
    const nowSha = createHash('sha256').update(await readFile(flowPath)).digest('hex');
    if (sidecar.flowSha256 && sidecar.flowSha256 !== nowSha) {
      console.error(`[scenario] warning: ${flowPath} has changed since this take was filmed; the spec runs the flow as it is now.`);
    }
    take = {
      path: sidecar.output?.path ?? null,
      sidecar: from,
      durationSec: sidecar.durationSec ?? null,
      backend: sidecar.backend ?? null,
      outcomes: Array.isArray(sidecar.outcomes) ? sidecar.outcomes : [],
    };
    if (sidecar.viewport?.width && sidecar.viewport?.height) viewport = sidecar.viewport;
    if (!scenarioDirArg && sidecar.scenario?.scenarioDir) scenarioDir = sidecar.scenario.scenarioDir;
    // `serveRoot` is in every web sidecar since the scenario export; an older one only has argv,
    // whose relative paths meant the filming run's cwd, which is not known here.
    if (!serveRootArg) {
      if (sidecar.serveRoot) serveRoot = sidecar.serveRoot;
      else if (sidecar.argv?.includes('--serve-root')) {
        fail(`--from ${from} was filmed with --serve-root but predates the sidecar's serveRoot key; pass --serve-root <dir> again`);
      }
    }
  }

  const plan = await preflightWebScenario({ flowPath, scenarioDir });
  if (plan.refusals.length) fail(`refusing to write the scenario:\n  ${plan.refusals.join('\n  ')}`);

  let emitted;
  try {
    emitted = await emitWebScenario({ flowPath, scenarioDir, serveRoot, viewport, take, filmkit: filmkitCommit() });
  } catch (err) {
    fail(`[scenario] emit failed: ${err.message}`);
  }
  console.log(`[scenario] ${emitted.specAction === 'overwrite' ? 'rewrote' : 'wrote'} ${emitted.spec} (imports ${emitted.importFrom})`);
  console.log(`[scenario] ${emitted.adapterAction === 'overwrite' ? 'rewrote' : 'wrote'} ${emitted.adapter} (sha256 ${emitted.adapterSha256.slice(0, 16)})`);
  for (const w of emitted.warnings) console.error(`[scenario] ⚠️  warning: ${w}`);
  const check = await loadCheck({ spec: emitted.spec });
  console.log(check.ok ? '[scenario] load check (playwright test --list): OK' : `[scenario] load check failed:\n${check.output}`);
  process.exit(check.ok ? 0 : 2);
}

await main();
