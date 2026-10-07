// ─────────────────────────────────────────────────────────────────────────────
// lib/tools.mjs — small shared helpers for the filmkit CLIs: promise-wrapped
// child-process runners and PATH-first external-tool resolution with env-var
// overrides (`FILMKIT_ADB`, `FILMKIT_EMULATOR`, `FILMKIT_MAESTRO`, `FILMKIT_FFMPEG`,
// `FILMKIT_FFPROBE`, `FILMKIT_XCRUN`, `FILMKIT_EGO_BROWSER`) plus known macOS install locations (Homebrew on Apple
// silicon and Intel), and the install hint each missing tool's error ends with. Nothing here knows about
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

// Known install locations, tried when a tool is not on PATH (a GUI-launched agent, or a shell whose
// profile never ran Homebrew's `shellenv`). Resolution order per tool: PATH → FILMKIT_<NAME> env var →
// these, in order. Homebrew lives in /opt/homebrew on Apple silicon and /usr/local on Intel; Maestro's
// own installer puts it in ~/.maestro/bin.
const TOOL_FALLBACKS = () => {
  const brew = (bin) => [`/opt/homebrew/bin/${bin}`, `/usr/local/bin/${bin}`];
  return {
    adb: [join(homedir(), 'Library/Android/sdk/platform-tools/adb')],
    emulator: [join(homedir(), 'Library/Android/sdk/emulator/emulator')],
    maestro: [join(homedir(), '.maestro/bin/maestro'), ...brew('maestro')],
    ffmpeg: brew('ffmpeg'),
    ffprobe: brew('ffprobe'),
    xcrun: ['/usr/bin/xcrun'],
    // ego lite's onboarding links the command here, and adds the directory to the shell profile; a shell
    // that never read that profile (an agent's, a GUI-launched one) still has to find it, or `--browser
    // auto` would fall back to a signed-out Playwright on a machine that has ego.
    'ego-browser': [join(homedir(), '.local/bin/ego-browser')],
  };
};

/** The override variable for a tool: `FILMKIT_FFMPEG`, `FILMKIT_EGO_BROWSER`. */
export const toolEnvVar = (name) => `FILMKIT_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

export async function resolveTool(name) {
  try {
    await execFileP('/bin/sh', ['-c', `command -v ${name}`]);
    return name; // on PATH — call by bare name so any caller-side PATH override is honored
  } catch {
    const env = process.env[toolEnvVar(name)];
    if (env && (await fileExists(env))) return env;
    const fallbacks = TOOL_FALLBACKS()[name] ?? [];
    for (const fallback of fallbacks) if (await fileExists(fallback)) return fallback;
    throw new Error(
      `required tool "${name}" was not found on PATH` +
        (env ? `, not at $${toolEnvVar(name)} (${env})` : '') +
        (fallbacks.length ? `, or at ${fallbacks.join(', ')}` : '') +
        (INSTALL_HINTS[name] ? `. ${INSTALL_HINTS[name]}, then run the command again.` : ''),
    );
  }
}

// What to do when a tool is missing, appended to resolveTool's error and printed by tools/doctor.mjs.
// One sentence each, exact commands, so the message is actionable by someone who is not a developer.
// No "then run ... again": what to run again depends on who prints it (resolveTool: the command that
// failed; doctor: doctor), so each caller adds its own.
export const INSTALL_HINTS = {
  ffmpeg: 'Install it with Homebrew: `brew install ffmpeg` (no Homebrew? see https://brew.sh)',
  ffprobe: 'It ships with ffmpeg: `brew install ffmpeg` (no Homebrew? see https://brew.sh)',
  adb: 'Install Android Studio (https://developer.android.com/studio) and its SDK Platform-Tools, or just adb: `brew install --cask android-platform-tools`',
  emulator: 'Install Android Studio (https://developer.android.com/studio), then SDK Manager > SDK Tools > Android Emulator',
  maestro: 'Install it: `curl -fsSL "https://get.maestro.mobile.dev" | bash` (it needs Java 17 or newer: `brew install openjdk@17`)',
  xcrun: 'Install Xcode from the App Store, open it once, then run `sudo xcode-select -s /Applications/Xcode.app`',
};
