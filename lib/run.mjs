// ─────────────────────────────────────────────────────────────────────────────
// lib/run.mjs — the one abortable process runner. tighten.mjs (freezedetect, cut, ffprobe),
// lib/tap-overlay.mjs (the tap burn) and lib/assemble.mjs (the web camera's frame encode) each carried
// their own copy of this; they now all import it. assemble adapts it at its own boundary (a 3s grace,
// `{ aborted: true }` instead of an AbortError, the raw spawn error, its own message), so what film-web
// sees did not change.
//
//   runAbortable(bin, args, { signal, stdout, stderrTailChars, label, graceMs })
//     -> Promise<{ code, signal, stdout, stderr }>
//   makeAbortError()          the Error both callers' callers test for: `err.name === 'AbortError'`
//   throwIfAborted(signal)    throws that error if the signal has already fired
//   ABORT_KILL_GRACE_MS       2000
//
// STATE MACHINE (per call; one direction only):
//
//   (signal already aborted) -> REJECTED(AbortError), nothing spawned
//   SPAWNED -> RUNNING -> CLOSED -> RESOLVED { code, signal, stdout, stderr }   any exit, 0 or not
//                      -> (abort)    STOPPING -> CLOSED -> REJECTED(AbortError)
//                      -> (output past MAX_OUTPUT_CHARS) STOPPING -> CLOSED -> REJECTED(Error)
//           -> (spawn failed) REJECTED(Error `failed to run <label>: ...`, `cause` = the spawn error)
//
// STOPPING is SIGTERM, then SIGKILL after `graceMs` (default ABORT_KILL_GRACE_MS, 2s) if the child is
// still alive. ffmpeg handles SIGTERM by closing its muxer, which takes well under a second; 2s is
// headroom before assuming it is wedged. (The VideoToolbox burn often uses most of it: an abort 1.5s
// into a burn settled 1.4-2.1s later, the same before and after this module existed.)
//
// WHY IT SETTLES ON 'close', AND ONLY THEN. The promise settles only AFTER the child has exited
// and its pipes have drained. That is the property the callers are built on: a camera's signal
// handler awaits the burn or the tighten pass and then calls process.exit(), and tighten removes its
// temp output after the runner settles, so neither can leave an ffmpeg running or delete a file an
// ffmpeg still has open (execFile children survive their parent's exit; see ABORT in tighten.mjs's
// header for the half-written `-tight.mp4` that used to cause). 'close' rather than 'exit' because
// 'exit' can fire before stdout/stderr are drained, and for tighten the output IS the result
// (freezedetect's table is in stderr). lib/tap-overlay.mjs's copy settled on 'exit'; it now settles on
// 'close', a few ms later at most, still after the exit, and with the whole stderr tail in hand.
//
// A non-zero exit is NOT a rejection here: the callers differ on what it means (freezedetect's stderr
// is the answer even when ffmpeg exits non-zero on a decode hiccup; the burn treats it as a failed
// encode and falls back to software). Each caller decides.
//
// OUTPUT. By default stdout and stderr are both captured in full, and more than MAX_OUTPUT_CHARS of
// them together stops the child and rejects (what execFile's `maxBuffer` used to enforce for
// tighten: a runaway child is an error, not a memory leak). `stdout: 'ignore'` does not open a pipe
// for it at all. `stderrTailChars: N` keeps stderr as a rolling tail instead: once it passes 2N
// characters it is cut back to its last N, so a long encode never grows it without bound and the
// caller still has the last lines to quote in its error (the burn passes 100_000, which is the
// 200k -> 100k it has always used; assemble passes 8192 and quotes from exactly the last 8192). Both
// pipes are decoded with setEncoding('utf8'), so a multi-byte character split across two chunks is
// joined, not turned into two U+FFFD (assemble's copy did this; tighten's and the burn's did not).
//
// Callers are responsible for their own flags: the quiet `-hide_banner -loglevel error` the burn
// passes, and the info-level stderr freezedetect needs, are arguments, not something this adds.
import { spawn } from 'node:child_process';

/** SIGTERM, then SIGKILL after this long if the child is still alive. */
export const ABORT_KILL_GRACE_MS = 2000;

/** stdout + stderr captured past this stops the child and rejects (tail mode never gets near it). */
export const MAX_OUTPUT_CHARS = 64 * 1024 * 1024;

/** The rejection an abort produces. Callers test `err.name === 'AbortError'`. */
export function makeAbortError() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw makeAbortError();
}

/**
 * Run `bin` to completion and hand back what it printed. See the header for the states.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {object} [o]
 * @param {AbortSignal} [o.signal] on abort: SIGTERM the child, SIGKILL it after ABORT_KILL_GRACE_MS,
 *   and reject with an AbortError once it has exited (never before)
 * @param {'pipe'|'ignore'} [o.stdout='pipe'] 'ignore' opens no pipe; `stdout` in the result is then ''
 * @param {number|null} [o.stderrTailChars=null] keep only a rolling tail of stderr (see OUTPUT)
 * @param {string} [o.label=bin] how a failed spawn names the tool: `failed to run <label>: ...`
 * @param {number} [o.graceMs=ABORT_KILL_GRACE_MS] SIGTERM-to-SIGKILL grace when stopping the child
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string}>} `code` is
 *   null (and `signal` names it) when the child was killed by a signal this runner did not send
 */
export function runAbortable(bin, args, { signal, stdout: stdoutMode = 'pipe', stderrTailChars = null, label = bin, graceMs = ABORT_KILL_GRACE_MS } = {}) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(makeAbortError());
    const child = spawn(bin, args, { stdio: ['ignore', stdoutMode === 'ignore' ? 'ignore' : 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let overflow = false;
    let killTimer = null;
    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
    };
    const stop = () => {
      child.kill('SIGTERM');
      if (!killTimer) {
        killTimer = setTimeout(() => child.kill('SIGKILL'), graceMs);
        killTimer.unref?.();
      }
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const collect = (which) => (d) => {
      if (which === 'out') {
        stdout += d.toString();
      } else {
        stderr += d.toString();
        if (stderrTailChars !== null && stderr.length > 2 * stderrTailChars) stderr = stderr.slice(-stderrTailChars);
      }
      if (stdout.length + stderr.length > MAX_OUTPUT_CHARS && !overflow) {
        overflow = true;
        stop();
      }
    };
    child.stdout?.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout?.on('data', collect('out'));
    child.stderr.on('data', collect('err'));
    child.on('error', (err) => {
      cleanup();
      reject(new Error(`failed to run ${label}: ${err.message}`, { cause: err }));
    });
    child.on('close', (code, exitSignal) => {
      cleanup();
      if (aborted) return reject(makeAbortError());
      if (overflow) return reject(new Error(`${label} printed more than ${MAX_OUTPUT_CHARS} characters`));
      resolvePromise({ code, signal: exitSignal, stdout, stderr });
    });
  });
}
