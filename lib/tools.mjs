// ─────────────────────────────────────────────────────────────────────────────
// lib/tools.mjs — small shared helpers for the filmkit CLIs: promise-wrapped
// child-process runners and PATH-first external-tool resolution with env-var
// overrides (`FILMKIT_ADB`, `FILMKIT_EMULATOR`, `FILMKIT_MAESTRO`, `FILMKIT_FFMPEG`,
// `FILMKIT_XCRUN`) plus known macOS fallback locations. Nothing here knows about
// any particular platform — the platform scripts stay self-contained.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const execFileP = promisify(execFile);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fileExists(path) {
  try {
    await access(path, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

// Run a command to completion with inherited stdio (progress-visible for long steps like
// maestro/gradle). Rejects with a descriptive Error on non-zero exit or spawn failure.
export function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', (err) => reject(new Error(`failed to run \`${cmd} ${args.join(' ')}\`: ${err.message}`)));
    child.on('exit', (code, signal) => {
      if (signal) return reject(new Error(`\`${cmd} ${args.join(' ')}\` was killed by ${signal}`));
      if (code !== 0) return reject(new Error(`\`${cmd} ${args.join(' ')}\` exited with code ${code}`));
      resolvePromise();
    });
  });
}

// Same as run(), but captures stdout instead of inheriting — for short status queries.
export async function runCapture(cmd, args, opts = {}) {
  const { stdout } = await execFileP(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts });
  return stdout;
}

// Known grounded fallback locations on a stock dev Mac (from the project this was
// extracted from). Resolution order per tool: PATH → FILMKIT_<NAME> env var → fallback path.
const TOOL_FALLBACKS = () => ({
  adb: join(homedir(), 'Library/Android/sdk/platform-tools/adb'),
  emulator: join(homedir(), 'Library/Android/sdk/emulator/emulator'),
  maestro: '/opt/homebrew/bin/maestro',
  ffmpeg: '/opt/homebrew/bin/ffmpeg',
  xcrun: '/usr/bin/xcrun',
});

export async function resolveTool(name) {
  try {
    await execFileP('/bin/sh', ['-c', `command -v ${name}`]);
    return name; // on PATH — call by bare name so any caller-side PATH override is honored
  } catch {
    const env = process.env[`FILMKIT_${name.toUpperCase()}`];
    if (env && (await fileExists(env))) return env;
    const fallback = TOOL_FALLBACKS()[name];
    if (fallback && (await fileExists(fallback))) return fallback;
    throw new Error(
      `required tool "${name}" was not found on PATH` +
        (env ? `, not at $FILMKIT_${name.toUpperCase()} (${env})` : '') +
        (fallback ? `, or at the fallback location ${fallback}` : ''),
    );
  }
}
