// ─────────────────────────────────────────────────────────────────────────────
// lib/takes.mjs — what a camera does with a take that did not work (FEEDBACK #13). Shared by
// film-android, film-ios and film-web, so the three cannot drift on naming.
//
// WHY THIS EXISTS. Take numbers are the storyboard's, so filmkit never renumbers, and a take that
// is refused overwrite (lib/preflight.mjs) would be stuck at its number forever if a failed run left
// `<name>.mp4` behind. So a failed run MOVES what it filmed out of the way, and the name is free
// for the retake:
//
//     <name>.mp4         -> <name>.failed.mp4
//     <name>-tight.mp4   -> <name>.failed-tight.mp4
//     <name>.json        -> written as <name>.failed.json (the sidecar is redirected, not moved)
//
// The web camera's subtitles (`<name>.srt`, `<name>-tight.srt`, lib/subtitles.mjs) are part of a take
// too: a failed slot's `.failed[-N].srt` / `.failed[-N]-tight.srt` count toward the slot being taken,
// and the stash below moves them with the rest. film-web writes a failed take's subtitles straight into
// its slot, so markTakeFailed never has one to move. The device cameras write none, so for them these
// names are always absent and nothing changes.
//
// The sidecar is the odd one out: it is written AFTER this runs, so there is nothing to rename. The
// caller must call markTakeFailed() first, then write to the `sidecarPath` it returns, so that
// `output.path` inside the sidecar agrees with where the video ended up.
//
// THE PREVIOUS TAKE UNDER --force (stashPreviousTake, below, is the second half of this module).
// Moving a failed run's video aside is only safe if the plain names hold nothing but that run's own
// output. Under --force they held the PREVIOUS good take until the camera overwrote it, so a failed
// retake destroyed it: the new recording landed on `<name>.mp4`, markTakeFailed moved that to
// `.failed.mp4`, and the old take was gone with its `<name>.json` still claiming `status: ok` for a
// file that no longer existed. The rule that fixes it: THE PREVIOUS TAKE IS ONLY EVER REPLACED BY A
// TAKE THAT ENDS `ok` OR `interrupted`. Any other outcome (flow-failed, finalize-failed,
// taps-missing, error, a run that dies in setup) leaves the previous take and its sidecar exactly as
// they were, and the failure lands in the next `.failed-N` slot. --force authorises replacing a take
// with a take, not with a failure that is then moved aside.
//
//   stashPreviousTake({ outDir, name, force }) -> { stashed, restore(), discard() }
//   recoverCrashedStash({ outDir, name })                       (call BEFORE preflight)
//
// Under --force, and after preflight and setup have passed but before anything is filmed, the plain
// take is MOVED (same directory, so a rename, never a copy) to a hidden stash:
//
//     <name>.mp4        -> .<name>.prev.mp4
//     <name>-tight.mp4  -> .<name>.prev-tight.mp4
//     <name>.json       -> .<name>.prev.json
//     <name>.srt        -> .<name>.prev.srt          (web only)
//     <name>-tight.srt  -> .<name>.prev-tight.srt    (web only)
//
// Whichever of them exist. Dot-prefixed so a bare `ls` hides it, and `.prev` is not a name any
// other filmkit file uses (per run, `<run>` being its UTC start: raw `.<name>.<run>.raw.mp4`, debug
// `.<name>.<run>.maestro-debug`, attempts `.<name>.<run>.maestro-attempts`, Android's local segments
// `.<name>.<run>.segNNN.mp4`; and the burn temp `.<name>.taps-<pid>.mp4`; the `.failed*` slots are plain names), and nothing
// in filmkit globs a directory for takes, so nothing else can pick a stash up. The plain names are
// now free, which is what lets the camera and markTakeFailed treat them as this run's own.
//
// STASH STATE MACHINE (per stashPreviousTake call; terminal states are one-way):
//
//   HELD --restore()-->  RESTORED   the stash is moved back over now-free plain names
//        --restore()-->  BLOCKED    a plain name is occupied: NOTHING is moved back (all or nothing,
//                                   so an old sidecar can never end up beside a new video); the stash
//                                   stays on disk, the result names it, the caller prints it. A later
//                                   discard() is refused: a failed restore never becomes a delete.
//        --discard()-->  DISCARDED  the stash is deleted; the new take now owns the names
//
//   Callers: `ok` and `interrupted` (a salvage that produced a video) call discard(); every other
//   exit calls restore(), AFTER markTakeFailed has moved the failed take to its slot. A signal during
//   setup restores too (nothing was filmed). Both are idempotent and memoised, like markTakeFailed:
//   the first call's result is returned again, and a call after the other one has settled is a no-op
//   (`state: 'noop'`), so a signal handler and the main path racing to the end cannot both act. The one
//   result that is NOT remembered is BLOCKED, so a caller that frees the names can call restore()
//   again; it re-checks and either completes or reports the same block. With
//   no plain take to stash, `stashed` is `[]` and both are no-ops. Neither ever throws: a failing exit
//   path must still reach its sidecar and its exit code.
//
//   restore() and discard() do their file work SYNCHRONOUSLY, before their promise is returned, on
//   purpose: a signal handler on the way to process.exit() can call them without being able to await.
//
// NO CLOBBER. Moving a file "into place" with rename() silently replaces the target on POSIX, which is
// the very bug the stash fixes, so every STASH move (stashPreviousTake, restore(), recoverCrashedStash)
// is link()+unlink(): link() fails with EEXIST atomically instead of replacing. (On a filesystem
// without hard links it falls back to an exists-check then rename(); the process is single-threaded on
// these names.) markTakeFailed is the one mover that uses a plain rename(), and it cannot clobber
// either, by a different route: it only renames into a slot firstFreeSlot has just found empty (none of
// the slot's names exists), and nothing else writes `.failed*` names of this take while this run
// owns it (two runs of the same name at once are not supported, see A CRASHED STASH).
//
// A CRASHED STASH. SIGKILL, power loss or a terminal that dies without SIGHUP can leave a stash on
// disk with no process to restore it. recoverCrashedStash() runs at the start of every run, BEFORE
// preflight (order matters: without --force, preflight only refuses what is at the plain names, and a
// stash hides exactly that, so a run that skipped recovery would film "past" a take that exists):
//   * no stash files                                    -> nothing.
//   * every stashed file's plain name is free           -> RESTORED, and the run goes on as if it had
//     just started (with --force it stashes again, without it preflight refuses the restored take as
//     usual). This is the case for a crash mid-take and for a crash after a failed take was moved to
//     its `.failed` slot: the take the stash holds is the last good one and nothing competes with it.
//   * any plain name is occupied                        -> REFUSED (throws, exit 1, before anything
//     is filmed). A new take exists next to the stash: a crash between the new video landing and the
//     discard, or a crash mid-stash. filmkit cannot tell which of two takes the operator wants, and
//     deleting either is irreversible, so it names both and the two commands that resolve it.
//   Not handled: two runs of the SAME name in the same directory at once. That was never supported (the
//   two share the plain names), and a live run's stash is indistinguishable from a
//   crashed one.
//
// STATE MACHINE (per run; one direction only, and idempotent because the module remembers: a
// repeated call with the same `{ outDir, name, since }` in the same process returns the FIRST
// call's result and touches nothing — see IDEMPOTENCE below):
//
//   FILMING -> (success)  the plain names stand; markTakeFailed is never called (under --force the
//                         stash's discard() is, see THE PREVIOUS TAKE UNDER --force)
//           -> (failure)  markTakeFailed() -> FAILED: paths point at the .failed names, the run
//                         exits non-zero (then restore()). There is no back-edge: a failed take is never
//                         promoted.
//
// Back-navigation and cancel: cancelling a run (SIGINT) is a salvage, not a failure, on Android and
// iOS — the interrupted take keeps its own sidecar status and markTakeFailed decides nothing about
// it. It DOES replace the previous take (it is a take, with a video), so it discards the stash; an
// interrupt that saved nothing restores it. On film-android and film-ios, a signal that lands after the
// take had ALREADY failed (a verdict computed before the signal: their DECIDED FAILURES) does not make it
// an interrupted take: it is that failure, stepped aside with markTakeFailed, and the stash is restored.
// (film-web likewise keeps a flow error that predates a signal as `flow-failed`.)
//
// IDEMPOTENCE. Callers do call this twice: film-ios calls it from a catch-all when writing the sidecar
// throws after an earlier call had already succeeded. Without memory the second call sees the first
// call's `.failed.*` files, takes the NEXT slot, finds nothing left at the plain names, and returns
// `<name>.failed-2.*` with `moved: []` — a sidecar naming a video that does not exist (measured:
// video already at `t.failed-3.mp4`, second call answered `t.failed-4.mp4`). So the result is
// memoized per process, keyed on outDir + name + since; the key includes `since` because it identifies
// the RUN, and a second run in the same process is a different failure that gets its own slot. The
// memo holds the in-flight promise, so two overlapping calls share one move as well. A call that
// throws is not remembered, so it can be retried. A copy is returned each time, so a caller that edits
// its result cannot change what the next call sees. The memo is per process by design: a later
// process is a later run, with a later `since`.
//
// WHEN A `.failed.*` ALREADY EXISTS — decided here, and it differs from what Android did before.
// Android used a bare rename(), which on POSIX silently replaces the target, so a second failed
// `take-3` destroyed the first one's evidence. That breaks the project rule (an existing take is
// never overwritten without --force, refused in preflight), and the rule cannot be honoured the
// obvious way: making preflight refuse when `take-3.failed.mp4` exists would refuse the RETAKE of a
// failed take, which is the exact thing this rename exists to allow. So the rule is honoured by
// never overwriting instead: the second failure of the same name lands in the next free slot,
//
//     <name>.failed.*  ->  <name>.failed-2.*  ->  <name>.failed-3.*  ...
//
// (video `<name>.failed-2.mp4`, tight `<name>.failed-2-tight.mp4`, sidecar `<name>.failed-2.json`).
// A slot is free only when NONE of its files exist, so a video and its sidecar can never end
// up in different slots. `--force` does not change this: --force means "overwrite the take I am
// making", not "delete my failure history". Preflight therefore does not need to know about
// `.failed*` names at all, and lib/preflight.mjs is unchanged.
//
// STALE FILES. A run that fails BEFORE writing its video (setup error, device gone) has nothing of
// its own at `<name>.mp4`; under --force there can be an OLD, good take sitting there, and renaming
// that to `.failed.mp4` would relabel a good take as a failure. So the caller passes `since`, the
// wall-clock ms at which THIS run began, and only files modified at or after it are moved. A file
// older than `since` is left exactly where it is. The sidecar path is redirected regardless.
// With stashPreviousTake this is now TRUE BY CONSTRUCTION for a camera that uses it (the old take is
// out of the plain names before anything is filmed, so whatever sits there is this run's) and `since`
// is the second line of defence, kept for cameras that have not adopted the stash and for a stash that
// could not be made. It used to be the only line, and it was not enough on its own: it protected an
// old take from being RELABELLED, but a failed run that wrote its video first had already overwritten
// the old take at the plain name, so there was nothing left to protect.
import { existsSync, linkSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { rename, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileExists } from './tools.mjs';

/** Slots are tried up to this many deep; past it something is badly wrong and we throw. */
const MAX_FAILED_SLOTS = 999;

/** The names of one failed slot. `tag` is `failed`, `failed-2`, `failed-3`, ... */
export function failedPaths(outDir, name, tag = 'failed') {
  return {
    tag,
    outPath: join(outDir, `${name}.${tag}.mp4`),
    tightPath: join(outDir, `${name}.${tag}-tight.mp4`),
    sidecarPath: join(outDir, `${name}.${tag}.json`),
    srtPath: join(outDir, `${name}.${tag}.srt`),
    tightSrtPath: join(outDir, `${name}.${tag}-tight.srt`),
  };
}

/** Every file of a slot: it is free only when none of them exists. */
export const slotFiles = (slot) => [slot.outPath, slot.tightPath, slot.sidecarPath, slot.srtPath, slot.tightSrtPath];

async function firstFreeSlot(outDir, name) {
  for (let n = 1; n <= MAX_FAILED_SLOTS; n++) {
    const paths = failedPaths(outDir, name, n === 1 ? 'failed' : `failed-${n}`);
    const taken = await Promise.all(slotFiles(paths).map(fileExists));
    if (!taken.some(Boolean)) return paths;
  }
  throw new Error(`${MAX_FAILED_SLOTS} failed takes of "${name}" already sit in ${outDir} — clear some out`);
}

/**
 * Move a failed run's artifacts out of the take's name and say where the sidecar should go.
 * Never throws for a missing or unmovable video: a failed run is already failing, and losing the
 * sidecar over a rename error would be worse than a video left at its plain name (the problem is
 * reported in `warnings` for the caller to print). It throws only for a bad call, or when 999
 * failed slots are taken.
 *
 * @param {object} o
 * @param {string} o.outDir the camera's --out directory
 * @param {string} o.name the take's basename: `outName` (android) / `flowName` (ios, web)
 * @param {number} o.since `Date.now()` taken when this run started; older files are not this
 *   run's and are left alone. Required, because a default would be either unsafe (move
 *   everything) or wrong for --force (move nothing).
 * @returns {Promise<{
 *   tag: string, outPath: string, tightPath: string, sidecarPath: string,
 *   moved: Array<{from: string, to: string}>,
 *   left: string[],
 *   warnings: string[]}>} the caller reassigns its own outPath / tightPath / sidecarPath from the
 *   three path fields. `left` lists files that exist at the plain name but predate `since`.
 */
export async function markTakeFailed({ outDir, name, since }) {
  if (!Number.isFinite(since)) {
    throw new Error('markTakeFailed needs `since` (Date.now() at run start) so it never moves a previous take');
  }
  const key = JSON.stringify([resolve(outDir), name, since]);
  let pending = MEMO.get(key);
  if (!pending) {
    pending = moveFailedTake({ outDir, name, since });
    MEMO.set(key, pending);
    // Only a success is worth remembering: a throw (999 slots taken) changed nothing on disk.
    pending.catch(() => MEMO.delete(key));
  }
  return structuredClone(await pending);
}

/** First-call results, keyed on outDir + name + since. See IDEMPOTENCE in the header. */
const MEMO = new Map();

async function moveFailedTake({ outDir, name, since }) {
  const plain = {
    video: join(outDir, `${name}.mp4`),
    tight: join(outDir, `${name}-tight.mp4`),
  };
  const slot = await firstFreeSlot(outDir, name);
  const moved = [];
  const left = [];
  const warnings = [];
  for (const [from, to] of [
    [plain.video, slot.outPath],
    [plain.tight, slot.tightPath],
  ]) {
    let info;
    try {
      info = await stat(from);
    } catch (err) {
      if (err.code === 'ENOENT') continue; // nothing was filmed / no tight was made: fine
      warnings.push(`could not stat ${from}: ${err.message}`);
      continue;
    }
    // A one-second slack: some filesystems round mtime down to whole seconds.
    if (info.mtimeMs < since - 1000) {
      left.push(from);
      continue;
    }
    try {
      await rename(from, to);
      moved.push({ from, to });
    } catch (err) {
      warnings.push(`could not rename ${from} -> ${to}: ${err.message}`);
    }
  }
  return { ...slot, moved, left, warnings };
}

// ── THE PREVIOUS TAKE UNDER --force ──────────────────────────────────────────────────────────────

/** [kind, plain suffix, stash suffix]: the files that make up a take, in stash order (the two
 *  subtitle files are the web camera's; see the header). */
const TAKE_FILES = [
  ['video', '.mp4', '.prev.mp4'],
  ['tight', '-tight.mp4', '.prev-tight.mp4'],
  ['sidecar', '.json', '.prev.json'],
  ['srt', '.srt', '.prev.srt'],
  ['tightSrt', '-tight.srt', '.prev-tight.srt'],
];

/** Where a take's files live plain and where they live while stashed. */
export function stashPaths(outDir, name) {
  return TAKE_FILES.map(([kind, plainSuffix, stashSuffix]) => ({
    kind,
    plain: join(outDir, `${name}${plainSuffix}`),
    stash: join(outDir, `.${name}${stashSuffix}`),
  }));
}

/**
 * Move `from` to `to`, refusing (EEXIST) instead of replacing what is at `to`. link()+unlink()
 * because rename() replaces silently. Synchronous, see the header.
 */
function moveNoClobber(from, to) {
  try {
    linkSync(from, to);
  } catch (err) {
    if (err.code === 'EEXIST') throw err;
    // No hard links here (FAT/exFAT, some network mounts): the best available is check-then-rename.
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK', 'ENOSYS'].includes(err.code)) throw err;
    if (existsSync(to)) throw Object.assign(new Error(`${to} exists`), { code: 'EEXIST' });
    renameSync(from, to);
    return;
  }
  unlinkSync(from);
}

/** Put every listed stash file back. All or nothing on occupied names; see BLOCKED in the header. */
function putBack(pairs) {
  const present = pairs.filter((p) => existsSync(p.stash));
  const occupied = present.filter((p) => existsSync(p.plain));
  if (occupied.length > 0) return { restored: [], blocked: occupied.map((p) => p.plain), warnings: [] };
  const restored = [];
  const blocked = [];
  const warnings = [];
  for (const p of present) {
    try {
      moveNoClobber(p.stash, p.plain);
      restored.push(p.plain);
    } catch (err) {
      blocked.push(p.plain);
      warnings.push(`could not put ${p.stash} back as ${p.plain}: ${err.message}`);
    }
  }
  return { restored, blocked, warnings };
}

const noop = () => ({ state: 'noop', restored: [], blocked: [], warnings: [] });

/**
 * Under --force, move the previous take out of the plain names into a hidden stash, before anything
 * is filmed. See THE PREVIOUS TAKE UNDER --force in the header for the states and the rule.
 *
 * @param {object} o
 * @param {string} o.outDir the camera's --out directory
 * @param {string} o.name the take's basename
 * @param {boolean} o.force `--force` was passed. Without it nothing is stashed (preflight already
 *   refused any existing take) and the returned object is inert.
 * @returns {Promise<{
 *   stashed: Array<{kind: string, plain: string, stash: string}>,
 *   restore: () => Promise<{state: 'restored'|'blocked'|'noop', restored: string[], blocked: string[], warnings: string[]}>,
 *   discard: () => Promise<{state: 'discarded'|'refused'|'noop', warnings: string[]}>}>}
 *   `restore()`: put the previous take back (after markTakeFailed freed the plain names). `discard()`:
 *   delete it, once a take that ended `ok` or `interrupted` is in place. Throws only if the stash
 *   itself could not be made (then nothing has moved: a half-made stash is rolled back).
 */
export async function stashPreviousTake({ outDir, name, force = false }) {
  const stashed = [];
  let settledBy = null; // 'restore' | 'discard': the first to finish wins, the other is a no-op
  let restoreResult = null;
  let discardResult = null;
  let restoreBlocked = false; // a restore that could not finish must never turn into a delete

  if (force) {
    try {
      for (const p of stashPaths(outDir, name)) {
        if (!existsSync(p.plain)) continue;
        moveNoClobber(p.plain, p.stash);
        stashed.push(p);
      }
    } catch (err) {
      putBack(stashed); // roll back what was moved, so a failed stash changes nothing
      throw new Error(`could not stash the previous take of "${name}" before filming: ${err.message}`);
    }
  }

  const restore = async () => {
    if (settledBy === 'discard') return noop();
    if (restoreResult) return structuredClone(restoreResult);
    const r = putBack(stashed);
    const state = stashed.length === 0 ? 'noop' : r.blocked.length > 0 ? 'blocked' : 'restored';
    if (state === 'blocked') restoreBlocked = true;
    restoreResult = { state, ...r };
    if (state !== 'blocked') settledBy = 'restore';
    // A blocked restore is not remembered: the caller can free the names and call again.
    const out = structuredClone(restoreResult);
    if (state === 'blocked') restoreResult = null;
    return out;
  };

  const discard = async () => {
    if (settledBy === 'restore' || stashed.length === 0) return { state: 'noop', warnings: [] };
    if (discardResult) return structuredClone(discardResult);
    if (restoreBlocked) {
      return {
        state: 'refused',
        warnings: [`not deleting the previous take of "${name}": putting it back was blocked, it is still stashed`],
      };
    }
    const warnings = [];
    for (const p of stashed) {
      try {
        rmSync(p.stash, { force: true });
      } catch (err) {
        warnings.push(`could not delete ${p.stash}: ${err.message}`);
      }
    }
    discardResult = { state: 'discarded', warnings };
    settledBy = 'discard';
    return structuredClone(discardResult);
  };

  return { stashed, restore, discard };
}

/**
 * At the start of a run: deal with a stash a killed earlier run left behind. Call it BEFORE
 * preflight. See A CRASHED STASH in the header for the policy.
 *
 * @returns {Promise<{state: 'none'|'restored', restored: string[]}>}
 * @throws {Error} (message names both takes and the resolving commands) when a stashed file's plain
 *   name is occupied, so the run must not go on.
 */
export async function recoverCrashedStash({ outDir, name }) {
  const pairs = stashPaths(outDir, name);
  const present = pairs.filter((p) => existsSync(p.stash));
  if (present.length === 0) return { state: 'none', restored: [] };
  const r = putBack(pairs);
  if (r.blocked.length === 0 && r.warnings.length === 0) return { state: 'restored', restored: r.restored };
  const stashList = present.map((p) => p.stash);
  const plainList = pairs.map((p) => p.plain).filter((f) => existsSync(f));
  throw new Error(
    `a previous run of "${name}" was killed mid-take and left the take it was replacing stashed:\n` +
      stashList.map((f) => `    ${f}`).join('\n') +
      `\n  but ${r.blocked.join(', ') || 'a plain name'} exists now, so filmkit cannot tell which take you want` +
      ' and will not delete either one.\n' +
      '  keep the STASHED take:  remove the new files (' + plainList.join(' ') + ') and run again (it is restored).\n' +
      '  keep the NEW take:      delete the stash (' + stashList.join(' ') + ') and run again.' +
      (r.warnings.length ? `\n  ${r.warnings.join('\n  ')}` : ''),
  );
}
