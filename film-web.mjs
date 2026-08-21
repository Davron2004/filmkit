#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// film-web.mjs — runs a compiled flow file against the web stage and writes an .mp4.
//
//   node film-web.mjs <flow-file.mjs> [--out <dir>] [--viewport <WxH>] [--tighten]
//
// The flow file's default export is `async ({ stage }) => { ... }` — see lib/stage.mjs
// for the director API and examples/web/tip-demo.demo.mjs for a worked example.
//
// --tighten (opt-in): after the raw .mp4 is written, runs tighten.mjs's dead-air cut over it
// (see that file's header for the algorithm) and writes a `-tight` variant alongside it. The raw
// recording is always kept — tighten is a post-process, not a replacement — and a tighten
// failure (e.g. ffmpeg missing) is reported but does NOT fail the overall command, since the raw
// video already recorded successfully by that point.
import { resolve, basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStage, VIEWPORT } from './lib/stage.mjs';
import { tighten } from './tighten.mjs';

function parseArgs(argv) {
  const rest = [];
  let out;
  let viewport = VIEWPORT;
  let doTighten = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out = argv[i + 1];
      i++;
    } else if (argv[i] === '--viewport') {
      const m = String(argv[i + 1] || '').match(/^(\d+)x(\d+)$/);
      if (!m) {
        console.error('--viewport must be <width>x<height>, e.g. --viewport 1280x720');
        process.exit(1);
      }
      viewport = { width: Number(m[1]), height: Number(m[2]) };
      i++;
    } else if (argv[i] === '--tighten') {
      doTighten = true;
    } else {
      rest.push(argv[i]);
    }
  }
  if (rest.length !== 1) {
    console.error('usage: node film-web.mjs <flow-file.mjs> [--out <dir>] [--viewport <WxH>] [--tighten]');
    process.exit(1);
  }
  return { flowArg: rest[0], outDir: out ? resolve(out) : undefined, viewport, doTighten };
}

async function main() {
  const { flowArg, outDir, viewport, doTighten } = parseArgs(process.argv.slice(2));
  const flowPath = resolve(flowArg);
  // "tip-demo.demo.mjs" → "tip-demo" (the video's base filename).
  const flowName = basename(flowPath, extname(flowPath)).replace(/\.demo$/, '');

  let flow;
  try {
    const mod = await import(pathToFileURL(flowPath).href);
    flow = mod.default;
  } catch (err) {
    console.error(`Could not load flow file ${flowPath}:\n${err?.stack ? err.stack : err}`);
    process.exit(1);
  }
  if (typeof flow !== 'function') {
    console.error(`Flow file ${flowPath} must have a default export: async ({ stage }) => { ... }`);
    process.exit(1);
  }

  const stage = await createStage({ flowName, ...(outDir ? { outDir } : {}), viewport });
  try {
    await flow({ stage });
    const outPath = await stage.finish();
    console.log(`\nDemo video written: ${outPath}`);

    if (doTighten) {
      try {
        const result = await tighten(outPath);
        if (result.skipped) {
          console.log(`[tighten] already tight (no static stretches found) — kept raw only: ${outPath}`);
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
  } catch (err) {
    console.error(`\nDemo flow "${flowName}" failed:\n${err?.stack ? err.stack : err}`);
    await stage.abort();
    process.exit(1);
  }
}

await main();
