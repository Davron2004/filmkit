// ─────────────────────────────────────────────────────────────────────────────
// lib/provenance.mjs — which filmkit made this (FEEDBACK #9), with no git binary.
//
// filmkitCommit() reads `.git/HEAD` and the ref files directly. It answers about THE REPO THIS
// FILE LIVES IN, located from import.meta.url — never from process.cwd(), because a camera runs
// from the flow author's project and that project's commit is not filmkit's.
//
// SYNCHRONOUS ON PURPOSE. It is two to four tiny file reads, the answer is memoized for the life
// of the process, and the callers are header generators (a sidecar, Part 2's scenario provenance
// comment) that would otherwise have to become async for the sake of a stat. Nothing on the
// filming hot path calls it.
//
// It only looks at the checkout directly above lib/ — it does not walk up. If filmkit is vendored
// into another repo's subdirectory (no `.git` of its own), walking up would report the HOST's
// commit as filmkit's, which is a plausible-looking lie; null is the honest answer there.
//
// RESOLUTION, in the order git itself uses:
//   1. `<root>/.git` is a directory  -> that is the git dir.
//      `<root>/.git` is a file       -> `gitdir: <path>` (relative paths are relative to <root>):
//                                       a linked worktree or a submodule. HEAD lives in that dir.
//   2. If the git dir has a `commondir` file (linked worktrees do), refs and packed-refs live
//      in THAT directory, not in the per-worktree one. Per-worktree refs are looked up in the
//      git dir first, then the common dir.
//   3. HEAD is `ref: refs/heads/x` (branch) or a bare 40/64-hex sha (detached; branch = null).
//   4. A ref resolves to its loose file `<dir>/refs/...`, else a line in `<dir>/packed-refs`
//      (`git pack-refs --all` and every clone leave refs ONLY there). A loose ref may itself say
//      `ref: ...`; that is followed a few hops.
//
// NOT HANDLED, and null (never a wrong answer): the reftable ref backend (git >= 2.45 opt-in;
// `.git/reftable/` exists and HEAD is a placeholder), an unborn branch (HEAD names a ref that does
// not exist yet), and anything unreadable or malformed. It never throws.
//
// NOT REPORTED: whether the working tree is dirty. That needs the index compared against the
// tree, which is a git implementation, not a file read. Uncommitted edits to filmkit therefore do
// not show here; callers that care should say "commit" and not "clean".
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_SYMREF_HOPS = 5;

const readText = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/** The git dir and the common dir for a checkout at `root`, or null if `root` is not one. */
function locateGitDirs(root) {
  const dotGit = join(root, '.git');
  let info;
  try {
    info = statSync(dotGit);
  } catch {
    return null;
  }
  let gitDir;
  if (info.isDirectory()) {
    gitDir = dotGit;
  } else {
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? '');
    if (!pointer) return null;
    gitDir = isAbsolute(pointer[1]) ? pointer[1] : resolve(root, pointer[1]);
  }
  const common = readText(join(gitDir, 'commondir'))?.trim();
  const commonDir = common ? (isAbsolute(common) ? common : resolve(gitDir, common)) : gitDir;
  return { gitDir, commonDir };
}

function packedRef(dir, ref) {
  const text = readText(join(dir, 'packed-refs'));
  if (text === null) return null;
  for (const line of text.split('\n')) {
    if (line === '' || line[0] === '#' || line[0] === '^') continue; // header, peeled-tag line
    const space = line.indexOf(' ');
    if (space > 0 && line.slice(space + 1).trim() === ref) {
      const sha = line.slice(0, space);
      if (SHA_RE.test(sha)) return sha;
    }
  }
  return null;
}

function resolveRef(ref, { gitDir, commonDir }, hops = 0) {
  // A ref name comes from a file we read; refuse anything that could climb out of the git dir.
  if (hops > MAX_SYMREF_HOPS || ref.includes('..') || isAbsolute(ref)) return null;
  for (const dir of gitDir === commonDir ? [gitDir] : [gitDir, commonDir]) {
    const loose = readText(join(dir, ref))?.trim();
    if (loose) {
      if (SHA_RE.test(loose)) return loose;
      const sym = /^ref:\s*(\S+)/.exec(loose);
      if (sym) return resolveRef(sym[1], { gitDir, commonDir }, hops + 1);
    }
  }
  for (const dir of gitDir === commonDir ? [gitDir] : [gitDir, commonDir]) {
    const packed = packedRef(dir, ref);
    if (packed) return packed;
  }
  return null;
}

/**
 * Pure and testable: resolve the commit of the checkout rooted at `root`.
 * @param {string} root the directory that contains `.git`
 * @returns {{commit: string, branch: string|null} | null} `branch` is null on a detached HEAD.
 */
export function readCommit(root) {
  try {
    const dirs = locateGitDirs(root);
    if (!dirs) return null;
    if (statSafe(join(dirs.commonDir, 'reftable'))) return null; // reftable backend: not readable here
    const head = readText(join(dirs.gitDir, 'HEAD'))?.trim();
    if (!head) return null;
    if (SHA_RE.test(head)) return { commit: head, branch: null };
    const sym = /^ref:\s*(\S+)/.exec(head);
    if (!sym) return null;
    const commit = resolveRef(sym[1], dirs);
    if (!commit) return null;
    return { commit, branch: sym[1].startsWith('refs/heads/') ? sym[1].slice('refs/heads/'.length) : sym[1] };
  } catch {
    return null;
  }
}

function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** filmkit's own repo root: this file is `<root>/lib/provenance.mjs`. */
export const FILMKIT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let memo;

/**
 * The commit filmkit itself is running from. Synchronous, memoized, never throws.
 * @returns {{commit: string, branch: string|null} | null} null when filmkit is not a git checkout
 *   (an npm/tarball install, a vendored copy) or its refs cannot be read.
 */
export function filmkitCommit() {
  if (memo === undefined) memo = readCommit(FILMKIT_ROOT);
  return memo;
}
