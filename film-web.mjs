#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// film-web.mjs — runs a compiled flow file against the web stage and writes an .mp4
// plus a provenance sidecar .json.
//
//   node film-web.mjs <flow-file.mjs> [--browser ego|playwright] [--out <dir>] [--name <stem>]
//                                    [--force] [--viewport <WxH>] [--serve-root <dir>] [--tighten]
//
// The flow file's default export is `async ({ stage }) => { ... }` — see lib/stage.mjs
// for the director API and examples/web/tip-demo.demo.mjs for a worked example.
//
// TWO CAMERAS BEHIND ONE FLOW API
//
// `--browser ego` (the default) films inside the user's already-running ego-browser, a
// Chromium fork that shares their real login profile — so a flow can walk through an app the
// user is signed into, which a throwaway Playwright profile cannot do. ego-browser exposes no
// external CDP endpoint; the only way in is a script on `ego-browser nodejs`'s stdin. This
// process therefore splits in two: the outer half (here) does preflight, serves local files,
// spawns the runtime, and does all the ffmpeg work; the inner half (lib/ego-runner.mjs) drives
// the browser and drops jpeg frames plus a timeline into a work directory. They talk over one
// pipe with a line protocol — see lib/ego-runner.mjs's STDOUT CONTRACT.
//
// `--browser playwright` is the original camera: headless Chromium with recordVideo, unchanged.
//
// RUN STATE MACHINE (linear; the only back-edge is "nothing was written, so refuse early"):
//
//   parse ─> tool check ─> preflight(no clobber) ─> [serve] ─> film ─> assemble ─> [tighten] ─> sidecar
//                              │                       │         │
//                              └── refuse, exit 1 ─────┴─────────┴── error, exit 1 (no sidecar)
//
// A run that never produced an .mp4 writes NO sidecar. Nothing was filmed, and an earlier
// take's sidecar must not be clobbered by a run that never rolled.
//
// --tighten (opt-in): after the raw .mp4 is written, runs tighten.mjs's dead-air cut over it
// (see that file's header for the algorithm) and writes a `-tight` variant alongside it. The raw
// recording is always kept — tighten is a post-process, not a replacement — and a tighten
// failure (e.g. ffmpeg missing) is reported but does NOT fail the overall command, since the raw
// video already recorded successfully by that point.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, basename, extname, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStage, VIEWPORT, DEFAULT_OUT_DIR } from './lib/stage.mjs';
import { createPlaywrightBackend } from './lib/backends/playwright.mjs';
import { assembleFromFrames, assembleFromWebm, probeDuration } from './lib/assemble.mjs';
import { preflight, validateNameStem } from './lib/preflight.mjs';
import { valueFor } from './lib/args.mjs';
import { startStaticServer } from './lib/static-server.mjs';
import { resolveTool, execFileP, fileExists } from './lib/tools.mjs';
import { tighten } from './tighten.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE =
  'usage: node film-web.mjs <flow-file.mjs> [--browser ego|playwright] [--out <dir>]\n' +
  '                        [--name <stem>] [--force] [--viewport <WxH>] [--serve-root <dir>]\n' +
  '                        [--tighten]';

function parseArgs(argv) {
  const rest = [];
  let out;
  let name;
  let browser = 'ego';
  let force = false;
  let viewport = VIEWPORT;
  let serveRoot;
  let doTighten = false;
  // `--out --force` must not create a directory called "--force"; see lib/args.mjs.
  const usageError = (msg) => {
    console.error(msg);
    process.exit(1);
  };
  const take = (i, flag) => valueFor(argv, i, flag, usageError);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out = take(i, '--out');
      i++;
    } else if (argv[i] === '--serve-root') {
      serveRoot = take(i, '--serve-root');
      i++;
    } else if (argv[i] === '--name') {
      name = take(i, '--name');
      i++;
    } else if (argv[i] === '--browser') {
      browser = take(i, '--browser');
      i++;
    } else if (argv[i] === '--force') {
      force = true;
    } else if (argv[i] === '--viewport') {
      const m = take(i, '--viewport').match(/^(\d+)x(\d+)$/);
      if (!m) usageError('--viewport must be <width>x<height>, e.g. --viewport 1280x720');
      viewport = { width: Number(m[1]), height: Number(m[2]) };
      i++;
    } else if (argv[i] === '--tighten') {
      doTighten = true;
    } else {
      rest.push(argv[i]);
    }
  }
  if (rest.length !== 1) {
    console.error(USAGE);
    process.exit(1);
  }
  if (browser !== 'ego' && browser !== 'playwright') {
    console.error(`--browser must be "ego" or "playwright" (got "${browser}")`);
    process.exit(1);
  }
  try {
    validateNameStem(name);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  return {
    flowArg: rest[0],
    outDir: out ? resolve(out) : DEFAULT_OUT_DIR,
    name,
    browser,
    force,
    viewport,
    serveRoot: serveRoot ? resolve(serveRoot) : undefined,
    doTighten,
  };
}

async function onPath(cmd) {
  try {
    await execFileP('/bin/sh', ['-c', `command -v ${cmd}`]);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

// ── ego: the bootstrap script handed to `ego-browser nodejs` on stdin ────────────────────────
// Deliberately three statements. Everything real is in lib/ego-runner.mjs, which is ordinary
// reviewable source; the runtime's helpers are captured here, at the one place they exist as
// bare globals, and passed down explicitly.
function bootstrapScript(config) {
  const runnerUrl = pathToFileURL(join(HERE, 'lib', 'ego-runner.mjs')).href;
  return `const { run } = await import(${JSON.stringify(runnerUrl)});
const globals = { cdp, js, drainEvents, wait, cliLog, useOrCreateTaskSpace, completeTaskSpace, openOrReuseTab, gotoAndWait, pageInfo };
await run({ globals, ...JSON.parse(${JSON.stringify(JSON.stringify(config))}) });
`;
}

function runEgoChild(script) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ego-browser', ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let result = null;
    let failure = null;
    const other = [];

    const onLine = (line) => {
      const at = line.indexOf('[filmkit] ');
      if (at === -1) {
        if (line.trim()) other.push(line);
        return;
      }
      const body = line.slice(at + '[filmkit] '.length);
      const sp = body.indexOf(' ');
      const kind = sp === -1 ? body : body.slice(0, sp);
      const payload = sp === -1 ? '' : body.slice(sp + 1);
      // A throw from inside this handler would escape into the stream's 'data' emit, leave the
      // child running, and leave this promise pending forever — the static server and the work
      // directory with it. The payload is JSON we wrote ourselves, but the line it arrived on is
      // shared with whatever else ego-browser prints, so it can be interleaved or truncated.
      // A line that will not parse is not a protocol line; treat it as output and move on.
      const parsed = (raw) => {
        try {
          return JSON.parse(raw);
        } catch {
          other.push(line);
          return null;
        }
      };
      if (kind === 'note') console.log(`[ego] ${payload}`);
      else if (kind === 'done') result = parsed(payload) ?? result;
      else if (kind === 'error') failure = parsed(payload) ?? failure;
      else other.push(line);
    };

    // cliLog writes on stderr, and ego-browser's own chatter shares both streams, so BOTH are
    // line-split and scanned for the protocol; anything unrecognised is held back and only
    // printed if the run fails.
    const tails = { stdout: '', stderr: '' };
    for (const name of ['stdout', 'stderr']) {
      child[name].setEncoding('utf8');
      child[name].on('data', (chunk) => {
        const lines = (tails[name] + chunk).split('\n');
        tails[name] = lines.pop();
        for (const line of lines) onLine(line);
      });
    }

    // Ctrl-C stops the take rather than abandoning it: the signal is forwarded and we then wait
    // for the child, so the run still lands on the ordinary failure path (which sweeps the task
    // space). MEASURED: the `ego-browser` wrapper does NOT pass the signal down to the inner
    // node runtime — it dies with code 8 and lib/ego-runner.mjs's own SIGINT handler never runs.
    // That is exactly why the sweep below exists and is not merely belt-and-braces.
    let interrupted = false;
    const forward = (sig) => {
      interrupted = true;
      child.kill(sig);
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);

    const unhook = () => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
    };
    child.on('error', (err) => {
      unhook(); // a spawn failure ends this call too — leaving the listeners on leaks a handler
      reject(new Error(`failed to run \`ego-browser nodejs\`: ${err.message}`));
    });
    child.on('close', (code) => {
      unhook();
      for (const name of ['stdout', 'stderr']) if (tails[name]) onLine(tails[name]);
      resolvePromise({ result, failure, code, other, interrupted });
    });

    // A child that dies before it finishes reading the script makes this write EPIPE, which with
    // no listener is an uncaught exception rather than the "the child failed" report we want.
    // The 'close' handler above is what actually reports; this only keeps the crash from winning.
    child.stdin.on('error', () => {});
    child.stdin.end(script);
  });
}

// A task space is the one thing a filming run can leave behind in the USER'S browser: a live
// tab in a context they did not ask for. lib/ego-runner.mjs closes it in a finally, but a finally
// only runs if the process survives long enough to reach it, and the `ego-browser` wrapper is
// measurably capable of dying without passing the signal down. So the outer process — the one
// that decided to interrupt — sweeps by name afterwards. Idempotent: on the ordinary failure
// path the runner already closed it and this finds nothing. Best-effort by design; a failure
// here must not replace the real error the caller is about to report.
async function sweepTaskSpace(name) {
  const script = `const want = ${JSON.stringify(name)};
const found = (await listTaskSpaces()).find((s) => s.name === want || s.taskId === want);
if (found) { await completeTaskSpace(found.id, { keep: false }); cliLog('FILMKIT_SWEPT ' + found.id); }
`;
  try {
    const { other } = await runEgoChild(script);
    // Silent when there was nothing to sweep, which is the ordinary case: the runner's own
    // finally already closed the space. The line means "something was left behind and I cleaned
    // it up", and printing it on runs where that did not happen made it read as noise attached to
    // some failure modes and not others.
    return other.some((l) => l.includes('FILMKIT_SWEPT'));
  } catch {
    console.error(`[film-web] could not sweep the ego task space "${name}" — close it in ego-browser if it is still open.`);
    return false;
  }
}

async function filmWithEgo({ flowPath, flowName, viewport, serveRoot, ffmpeg, mp4Path }) {
  // Server FIRST, work directory second: binding is the step that can still fail, and a work
  // directory created before it would be orphaned in the temp dir with nothing to point at it.
  // Local files are served, not opened off file:// — see lib/static-server.mjs for the caps.
  // The root defaults to the flow file's own directory, which is where a flow's fixture normally
  // lives; --serve-root widens it deliberately, for a flow that films a build output elsewhere.
  const server = await startStaticServer(serveRoot ?? dirname(flowPath));
  let workDir;
  try {
    workDir = await mkdtemp(join(tmpdir(), `filmkit-${flowName}-`));
  } catch (err) {
    await server.close();
    throw err;
  }
  try {
    const script = bootstrapScript({
      flowPath,
      viewport,
      workDir,
      taskSpaceName: `filmkit ${flowName}`,
      serverOrigin: server.origin,
      serverRoot: server.root,
    });
    const { result, failure, code, other, interrupted } = await runEgoChild(script);

    if (!result) {
      // No `done` sentinel: the run failed, whatever the wrapper's exit status said.
      if (await sweepTaskSpace(`filmkit ${flowName}`)) {
        console.error(`[film-web] closed the leftover ego task space "filmkit ${flowName}".`);
      }
      const detail = interrupted
        ? 'interrupted'
        : failure?.message ||
          other.join('\n').trim() ||
          `ego-browser nodejs exited with code ${code} and said nothing`;
      const err = new Error(detail);
      // The useful stack is the flow's, from inside the ego runtime — this process's own frames
      // only say "the child failed", which the reader already knows.
      if (failure?.stack) err.stack = failure.stack;
      err.interrupted = interrupted;
      throw err;
    }

    const frames = JSON.parse(await readFile(join(workDir, 'frames.json'), 'utf8'));
    const meta = JSON.parse(await readFile(join(workDir, 'timeline.json'), 'utf8'));
    const framesDir = join(workDir, 'frames');
    const encoded = await assembleFromFrames(ffmpeg, { dir: framesDir, frames, tailSec: meta.tailSec }, mp4Path, workDir);

    // THE TIMELINE AND THE VIDEO MUST AGREE. Two independent walks of the same timestamps produce
    // these numbers — the runner's, from the recording clock, and the assembler's, from what it
    // actually wrote into the concat list. They can only differ if a delta was adjusted on the way
    // through, and any such adjustment slides the video against the timeline that the sidecar
    // publishes and tighten protects at ZERO margin. A tenth of a second of drift is a clipped
    // caption; there is no safe way to ship it, so the take fails and says what it saw.
    const drift = Math.abs(encoded.plannedDurationSec - meta.plannedDurationSec);
    if (drift > 1 / 30) {
      throw new Error(
        `the encoded video and the recorded timeline disagree by ${drift.toFixed(3)}s ` +
          `(video ${encoded.plannedDurationSec.toFixed(3)}s vs timeline ${meta.plannedDurationSec.toFixed(3)}s` +
          `${encoded.nonMonotonic ? `, ${encoded.nonMonotonic} non-monotonic frame timestamp(s)` : ''}).\n` +
          '  Every caption range in the sidecar would point at the wrong seconds of the video.',
      );
    }
    await rm(workDir, { recursive: true, force: true });
    return { path: mp4Path, clock: meta.clock, timeline: meta.timeline, plannedDurationSec: meta.plannedDurationSec };
  } catch (err) {
    // Nothing is deleted quietly: a run that ends unclean leaves its frames and concat list on
    // disk and says where, whether it died in the flow or in the encoder.
    console.error(`[film-web] the ego work directory was kept for debugging: ${workDir}`);
    throw err;
  } finally {
    await server.close();
  }
}

async function filmWithPlaywright({ flowPath, viewport, outDir, ffmpeg, mp4Path }) {
  const mod = await import(pathToFileURL(flowPath).href);
  const flow = mod.default;
  if (typeof flow !== 'function') {
    throw new Error(`Flow file ${flowPath} must have a default export: async ({ stage }) => { ... }`);
  }
  const backend = createPlaywrightBackend({ viewport, outDir });
  await backend.launch();
  await backend.startRecording();
  const stage = createStage({ backend, viewport });
  let take;
  try {
    await flow({ stage });
    take = await stage.finish();
  } catch (err) {
    await stage.abort();
    throw err;
  }
  const { path, transcoded } = await assembleFromWebm(ffmpeg, take.recording.webmPath, mp4Path);
  if (!transcoded) {
    console.warn(`[film-web] ffmpeg not found on PATH — kept the recording as ${path} instead of transcoding to .mp4.`);
  }
  return { path, clock: take.clock, timeline: take.timeline, plannedDurationSec: null };
}

async function main() {
  const { flowArg, outDir, name, browser, force, viewport, serveRoot, doTighten } = parseArgs(process.argv.slice(2));
  const flowPath = resolve(flowArg);
  // "tip-demo.demo.mjs" → "tip-demo" (the video's base filename), unless --name overrides it.
  const flowName = name ?? basename(flowPath, extname(flowPath)).replace(/\.demo$/, '');

  if (browser === 'ego' && !(await onPath('ego-browser'))) {
    console.error(
      '`ego-browser` is not on PATH — install it (see the ego-browser skill: ' +
        '~/.claude/skills/ego-browser/references/install.md), or film with --browser playwright.',
    );
    process.exit(1);
  }

  if (serveRoot && !(await fileExists(serveRoot))) {
    console.error(`--serve-root ${serveRoot} does not exist`);
    process.exit(1);
  }

  const mp4Path = join(outDir, `${flowName}.mp4`);
  const jsonPath = join(outDir, `${flowName}.json`);
  const tightPath = join(outDir, `${flowName}-tight.mp4`);
  try {
    await preflight(flowPath, doTighten ? [mp4Path, jsonPath, tightPath] : [mp4Path, jsonPath], force);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  let ffmpeg;
  try {
    ffmpeg = await resolveTool('ffmpeg');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const ffprobe = (await onPath('ffprobe')) ? 'ffprobe' : null;

  await mkdir(outDir, { recursive: true });
  const startedAt = new Date().toISOString();

  let filmed;
  try {
    filmed =
      browser === 'ego'
        ? await filmWithEgo({ flowPath, flowName, viewport, serveRoot, ffmpeg, mp4Path })
        : await filmWithPlaywright({ flowPath, viewport, outDir, ffmpeg, mp4Path });
  } catch (err) {
    if (err?.interrupted) {
      console.error(`\nDemo flow "${flowName}" interrupted — nothing was written.`);
      process.exit(130); // the shell's own convention for "died on SIGINT"
    }
    console.error(`\nDemo flow "${flowName}" failed:\n${err?.stack ? err.stack : err}`);
    process.exit(1);
  }

  console.log(`\nDemo video written: ${filmed.path}`);
  const durationSec = ffprobe ? await probeDuration(ffprobe, filmed.path) : null;
  if (durationSec != null) console.log(`Duration: ${durationSec.toFixed(2)}s`);

  let tightenResult = null;
  if (doTighten) {
    try {
      // PROTECTED RANGES, HANDED OVER IN MEMORY. tighten can read them from a sidecar on disk,
      // but this run HAS them — it authored every one of these holds — and the sidecar does not
      // exist yet (it is written below, with tighten's own numbers folded into it). Passing them
      // directly also removes the ordering trap where a stale <name>.json from a previous take
      // would be the thing protecting this one's captions. `sidecar: false` makes that explicit
      // rather than relying on opts.protect happening to win the precedence rules.
      // The margin follows the clock the recording actually kept: ego timestamps every frame, so
      // its ranges are exact and need none; Playwright's are wall-clock alongside an encoder and
      // can drift, so they get 0.5s of slack on each side. Widening only ever keeps more.
      const protect = filmed.timeline
        .filter((e) => e.kind === 'caption' || e.kind === 'pause')
        .map(({ start, end }) => ({ start, end }));
      const result = await tighten(filmed.path, {
        protect,
        protectMarginSec: filmed.clock === 'frame' ? 0 : 0.5,
        sidecar: false,
      });
      tightenResult = result;
      const prot = result.protected;
      if (prot?.ranges?.length) {
        console.log(
          `[tighten] protected ${prot.ranges.length} range(s) from this run's timeline ` +
            `(margin ${prot.marginSec.toFixed(2)}s) — ${prot.freezesTouched} hold(s) kept longer than --keep`,
        );
      }
      if (result.skipped) {
        const why = result.skipDetail || 'no static stretches found';
        console.log(`[tighten] already tight (${why}) — kept raw only: ${filmed.path}`);
      } else {
        console.log(
          `[tighten] ${result.totalDuration.toFixed(2)}s -> ${result.outDuration.toFixed(2)}s ` +
            `(${result.cuts} cuts, ${result.removedSec.toFixed(2)}s removed)`,
        );
        console.log(`Tightened demo video written: ${result.outPath}`);
      }
    } catch (err) {
      console.error(`[tighten] skipped — ${err.message}`);
    }
  }

  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        status: 'ok',
        backend: browser,
        flow: flowPath,
        flowSha256: await sha256(flowPath),
        argv: process.argv.slice(2),
        viewport,
        clock: filmed.clock,
        durationSec,
        plannedDurationSec: filmed.plannedDurationSec,
        timeline: filmed.timeline,
        tighten: tightenResult,
        createdAt: startedAt,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Sidecar written: ${jsonPath}`);
}

await main();
