// ─────────────────────────────────────────────────────────────────────────────
// lib/browser-probe.mjs — can the web camera film right now, and in which browser? Shared by
// film-web.mjs (its header's BACKEND SELECTION) and tools/doctor.mjs, so both answer the same way.
//
//   probeEgo()        -> { state: 'missing' | 'ready' | 'not-answering', detail, path }
//   probePlaywright() -> { state: 'ready' | 'no-package' | 'no-browser' | 'error', detail }
//
// EGO
//
//   missing        `ego-browser` resolves nowhere: not on PATH, not at $FILMKIT_EGO_BROWSER, not at
//                  ~/.local/bin/ego-browser (lib/tools.mjs's resolveTool, the order every tool resolves
//                  in). ego lite is not installed, or its onboarding (which links the command into
//                  ~/.local/bin) was not finished.
//   `path` is what resolved (the bare name when it is on PATH), null when missing. Every spawn of
//   ego-browser uses it (film-web.mjs's runEgoChild through selectBackend), so a shell whose PATH lacks
//   ~/.local/bin (an agent's, one that never read the profile ego's onboarding edited) still films in
//   ego instead of falling back to a signed-out Playwright.
//   ready          `ego-browser nodejs -e <print a marker>` printed the marker and exited 0.
//   not-answering  it is installed, but the probe failed or did not finish within EGO_PROBE_TIMEOUT_MS.
//
// WHY A REAL ROUND TRIP, NOT A PROCESS CHECK: the question is whether filming can start, and the only
// way in is `ego-browser nodejs` (film-web.mjs header). Looking for the app's process would answer a
// neighbouring question (the app could be mid-update, or listening under another server name).
// MEASURED (2026-10-06, ego lite 0.5.1.13): 0.16s when the probe itself had to spawn a fresh runtime,
// 0.10s warm. With no reachable browser service (`--ego-server-name=<unknown>`) the wrapper does not
// fail, it waits indefinitely (killed at 25s), and starts no browser. So the timeout is what turns
// "not running" into an answer, and 10s is ~60x the cold figure.
// stdin is /dev/null: with stdin left as an open pipe `ego-browser nodejs` waits for it to close.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTool, toolEnvVar } from './tools.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const EGO_PROBE_TIMEOUT_MS = 10_000;
const MARKER = 'filmkit-ego-ready';

/** Where `ego-browser` is (header: PATH, then $FILMKIT_EGO_BROWSER, then ~/.local/bin), or null. */
export async function resolveEgoBrowser() {
  return resolveTool('ego-browser').catch(() => null);
}

export async function probeEgo({ timeoutMs = EGO_PROBE_TIMEOUT_MS } = {}) {
  const path = await resolveEgoBrowser();
  if (!path) {
    return {
      state: 'missing',
      detail: `the \`ego-browser\` command is not on PATH, not at $${toolEnvVar('ego-browser')}, and not at ~/.local/bin/ego-browser`,
      path: null,
    };
  }
  return new Promise((resolvePromise) => {
    let out = '';
    let settled = false;
    const settle = (state, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ state, detail, path });
    };
    const child = spawn(path, ['nodejs', '-e', `console.log(${JSON.stringify(MARKER)})`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle('not-answering', `\`ego-browser nodejs\` did not answer within ${timeoutMs / 1000}s`);
    }, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        out += chunk;
      });
    }
    child.on('error', (err) => settle('not-answering', `\`ego-browser nodejs\` could not start: ${err.message}`));
    child.on('close', (code) => {
      if (code === 0 && out.includes(MARKER)) settle('ready', null);
      else {
        const said = out.trim().split('\n').slice(-3).join(' / ');
        settle('not-answering', `\`ego-browser nodejs\` exited with code ${code}${said ? `: ${said}` : ' and said nothing'}`);
      }
    });
  });
}

// The one install hint, for every message that tells someone to get ego-browser.
export const EGO_INSTALL_HINT =
  'Install ego lite from https://lite.ego.app/ and finish its first-run setup in the app (that adds the ' +
  '`ego-browser` command to ~/.local/bin, where filmkit finds it whatever your PATH says; if it is somewhere else, ' +
  'set FILMKIT_EGO_BROWSER to its full path)';

// PLAYWRIGHT. A real launch and close of headless Chromium, the way lib/backends/playwright.mjs
// launches it, because that is the only check that cannot pass while filming would fail: Playwright
// launches `chromium_headless_shell-<rev>` headless, while `chromium.executablePath()` names the full
// Chromium, so a file check would vouch for the wrong binary. MEASURED: ~0.3-0.6s warm.
//   no-package  `playwright` does not resolve from the filmkit checkout (`npm ci` never ran there)
//   no-browser  the package is there and its browser download is not (`npx playwright install
//               chromium` never ran, or ran for another Playwright version)
//   error       anything else the launch threw (detail is its first line)
// Loaded with a dynamic import so an ego-only machine never needs node_modules (film-web.mjs header).
export async function probePlaywright({ timeoutMs = 60_000 } = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') return { state: 'no-package', detail: 'the `playwright` npm package is not installed in ' + ROOT };
    return { state: 'error', detail: String(err?.message || err).split('\n')[0] };
  }
  let browser = null;
  let timer = null;
  try {
    browser = await Promise.race([
      chromium.launch(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Chromium did not start within ${timeoutMs / 1000}s`)), timeoutMs);
      }),
    ]);
    return { state: 'ready', detail: null };
  } catch (err) {
    const msg = String(err?.message || err);
    if (/Executable doesn't exist/.test(msg)) return { state: 'no-browser', detail: msg.split('\n')[0] };
    return { state: 'error', detail: msg.split('\n')[0] };
  } finally {
    clearTimeout(timer);
    await browser?.close().catch(() => {});
  }
}

// How to run setup.sh, as README spells it: through `sh`, so it works whether or not the checkout kept
// the file's execute bit (a zip download does not), and quoted when the path needs it.
const setupPath = join(ROOT, 'setup.sh');
export const SETUP_COMMAND = `sh ${/^[\w@%+=:,./-]+$/.test(setupPath) ? setupPath : `'${setupPath.replace(/'/g, "'\\''")}'`}`;

// What to run when probePlaywright() is not ready: setup.sh does both halves (npm ci, then the
// browser download), and is safe to run again.
export const PLAYWRIGHT_SETUP_HINT = `Run \`${SETUP_COMMAND}\` (it installs Playwright and its Chromium, ~150 MB; safe to run again)`;
