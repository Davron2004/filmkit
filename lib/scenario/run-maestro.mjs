// ─────────────────────────────────────────────────────────────────────────────
// lib/scenario/run-maestro.mjs — the two Maestro runs a camera makes on an emitted wrapper:
// checkWrapper (always, cheap) and startVerify (opt-in --scenario-verify, expensive). Shared by
// film-ios and film-android. Orchestrates the `maestro` binary only.
//
// CHECK. `maestro check-syntax <file>` exists in Maestro 2.6.0 (prints `OK`, exit 0; on a bad command
// `Invalid Command: clearStatee at /syntax-checker:5:3`, exit 1; ~1.5s, no device needed). MEASURED
// LIMIT: it does not open `runFlow: file:` targets: a wrapper pointing at a file that does not exist
// passes. The path is the one thing the emitter can get wrong (--scenario-dir makes it relative), so
// checkWrapper adds its own check that the target resolves to an existing file. Both results go in
// one `{ ok, output }`.
//
// VERIFY STATE MACHINE (one run, never retried; a startup flake is a red verify, on purpose, because
// a retry would repeat app side effects):
//
//   RUNNING -> passed       maestro exited 0
//           -> failed       maestro exited non-zero (error = exit code + the tail of its output)
//           -> timeout      the wall-clock cap below expired: SIGINT, SIGKILL after graceMs
//           -> interrupted  abort() was called (the camera's signal handler): same SIGINT/SIGKILL
//           -> error        maestro could not be spawned
//   Each state is terminal; there is no back-edge. `done` always resolves, never rejects.
//
// THE CAP LIVES HERE, not in the wrapper: Maestro has no per-flow timeout in YAML, so a verify that
// wedges (a wait that never ends, a driver that stops answering) would hold the camera forever. The
// camera passes timeoutMs (3x the filmed flow time + 60s, the rule the web scenario uses for its test
// timeout). A CI run of the wrapper is bounded by the CI's own job timeout instead.
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const ANSI_RE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const tailLines = (text, n) => text.replace(ANSI_RE, '').split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-n).join('\n');

function runCaptured(cmd, args, timeoutMs = 60_000) {
  return new Promise((resolvePromise) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolvePromise({ code: null, out: err.message });
    }
    // Bounded: a maestro that wedges must not hold the camera (check-syntax normally takes ~1.5s).
    const timer = setTimeout(() => {
      out += `\nkilled after ${timeoutMs / 1000}s`;
      child.kill('SIGKILL');
    }, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (c) => (out = (out + c).slice(-20_000)));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ code: null, out: err.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, out });
    });
  });
}

/**
 * @param {{maestro:string, wrapperPath:string, flowPath:string}} o
 * @returns {Promise<{ok:boolean, output:string}>}
 */
export async function checkWrapper({ maestro, wrapperPath, flowPath }) {
  const { code, out } = await runCaptured(maestro, ['check-syntax', wrapperPath]);
  const lines = [tailLines(out, 6) || (code === 0 ? 'OK' : `maestro check-syntax exited ${code}`)];
  let ok = code === 0;
  // check-syntax does not follow runFlow targets (see the header), so resolve the path the wrapper
  // actually contains, from the wrapper's own directory, and require it to be the flow that was filmed.
  const text = await readFile(wrapperPath, 'utf8').catch(() => '');
  const m = /^\s+file:\s*(?:"([^"\n]*)"|(\S+))\s*$/m.exec(text);
  const written = m ? m[1] ?? m[2] : null;
  const resolved = written === null ? null : resolve(dirname(wrapperPath), written);
  if (resolved === null) {
    ok = false;
    lines.push('the wrapper has no runFlow `file:` line');
  } else if (resolved !== resolve(flowPath)) {
    ok = false;
    lines.push(`the wrapper's runFlow target resolves to ${resolved}, not the filmed flow ${flowPath}`);
  } else {
    await access(resolved).catch(() => {
      ok = false;
      lines.push(`the wrapper's runFlow target does not exist: ${resolved}`);
    });
  }
  return { ok, output: lines.join('\n') };
}

/**
 * Run `maestro --device <id> test <wrapper>` once.
 * @param {{maestro:string, deviceId:string, wrapperPath:string, timeoutMs:number, graceMs?:number}} o
 * @returns {{ done: Promise<{status:string, durationSec:number, error:string|null}>, abort: () => void, kill: () => void }}
 *   abort = SIGINT then SIGKILL after graceMs (status `interrupted`); kill = SIGKILL now
 */
export function startVerify({ maestro, deviceId, wrapperPath, timeoutMs, graceMs = 10_000 }) {
  const startedMs = Date.now();
  let stopReason = null; // 'timeout' | 'interrupted': why WE stopped it
  let child = null;
  let killTimer = null;
  let capTimer = null;
  let tail = '';
  const stop = (reason) => {
    if (stopReason || !child) return;
    stopReason = reason;
    child.kill('SIGINT');
    killTimer = setTimeout(() => child.kill('SIGKILL'), graceMs);
  };
  const done = new Promise((resolveDone) => {
    const finish = (status, error) => {
      clearTimeout(killTimer);
      clearTimeout(capTimer);
      resolveDone({ status, durationSec: Number(((Date.now() - startedMs) / 1000).toFixed(2)), error });
    };
    try {
      child = spawn(maestro, ['--device', deviceId, 'test', wrapperPath], { stdio: ['inherit', 'pipe', 'pipe'] });
    } catch (err) {
      return finish('error', err.message);
    }
    child.stdout.on('data', (c) => {
      process.stdout.write(c);
      tail = (tail + c).slice(-20_000);
    });
    child.stderr.on('data', (c) => {
      process.stderr.write(c);
      tail = (tail + c).slice(-20_000);
    });
    child.on('error', (err) => finish('error', `failed to run maestro: ${err.message}`));
    child.on('exit', (code, signal) => {
      const said = tailLines(tail, 12);
      if (stopReason === 'timeout') return finish('timeout', `stopped after the ${Math.round(timeoutMs / 1000)}s cap${said ? `\n${said}` : ''}`);
      if (stopReason === 'interrupted') return finish('interrupted', 'stopped by a signal to the camera');
      if (code === 0) return finish('passed', null);
      finish('failed', `maestro ${signal ? `was killed by ${signal}` : `exited ${code}`}${said ? `\n${said}` : ''}`);
    });
    capTimer = setTimeout(() => stop('timeout'), timeoutMs);
  });
  return { done, abort: () => stop('interrupted'), kill: () => child?.kill('SIGKILL') };
}
