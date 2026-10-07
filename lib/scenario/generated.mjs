// ─────────────────────────────────────────────────────────────────────────────
// lib/scenario/generated.mjs — the `@filmkit-generated` marker and the rule that hangs off it.
// Shared by the mobile wrapper emitter (lib/scenario/emit-maestro.mjs) and the web emitter
// (lib/scenario/emit-web.mjs: the spec and its shared filmkit-stage.mjs adapter, `//` leader), so the
// two cannot disagree about what counts as "ours".
//
// THE RULE (Part 2 of the scenario plan). A scenario file is DERIVED: it is thin glue over the flow
// file, so filmkit may rewrite it on every run without --force. A file at the same path that does
// NOT carry the marker is someone's own work and is never touched, --force or not (--force means
// "overwrite the take I am making", see lib/preflight.mjs; it is not consent to clobber a hand-
// written test). The refusal belongs in preflight, before anything is filmed, next to the take
// overwrite refusal — a run that is going to refuse should refuse before it spends a minute on a
// device. The emitter re-checks at write time as well (the take lasts long enough for a file to
// appear), and a refusal THERE is a scenario failure, not a take failure.
//
// STATE MACHINE of one planned path (checkGeneratedTarget):
//
//   absent   -> ok, `create`
//   marked   -> ok, `overwrite` (derived; no --force needed)
//   unmarked -> refuse (a hand-written file, or a file whose first line is not the marker)
//   not a regular file (a directory, a socket) -> refuse, same message shape
//   unreadable -> refuse (we cannot prove it is ours)
//
// There is no back-edge and no cancel: the check reads at most MARKER_SCAN_BYTES and writes nothing.
//
// WHAT "MARKED" MEANS. The FIRST LINE is `<comment leader> @filmkit-generated ...`, comment leader
// `#` (YAML) or `//` (JS). First line only, on purpose: a hand-written file that merely MENTIONS the
// marker in a doc comment further down must not be adopted, and reading only the head keeps this
// cheap for a large file. A UTF-8 BOM before the leader is tolerated.
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

export const MARKER = '@filmkit-generated';
const MARKER_SCAN_BYTES = 512;
const MARKER_RE = /^﻿?\s*(?:#|\/\/)\s*@filmkit-generated(?:\s|$)/;

/** First line of a file, reading at most MARKER_SCAN_BYTES; null if it cannot be read. */
async function readFirstLine(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    const buf = Buffer.alloc(MARKER_SCAN_BYTES);
    const { bytesRead } = await handle.read(buf, 0, MARKER_SCAN_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0];
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** True when `path` is a regular file whose first line carries the marker. Never throws. */
export async function isFilmkitGenerated(path) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return false;
  const first = await readFirstLine(path);
  return first !== null && MARKER_RE.test(first);
}

/**
 * The first line of a generated file.
 * @param {'#'|'//'} leader
 * @param {string} rest what follows the marker, e.g. `scenario v1. flow gen.yaml ...`
 */
export function markerLine(leader, rest) {
  return `${leader} ${MARKER} ${rest}`;
}

/**
 * Preflight for ONE planned generated file. Does not throw; the caller decides what a refusal
 * means (film-ios: exit 1 before the simulator is touched).
 * @returns {Promise<{ ok: true, action: 'create'|'overwrite' } | { ok: false, reason: string }>}
 */
export async function checkGeneratedTarget(path) {
  const info = await stat(path).catch((err) => (err?.code === 'ENOENT' ? null : err));
  if (info === null) return { ok: true, action: 'create' };
  if (info instanceof Error) {
    return { ok: false, reason: `cannot inspect ${path} (${info.code ?? info.message}), so it cannot be shown to be filmkit's; refusing to write over it` };
  }
  if (!info.isFile()) {
    return { ok: false, reason: `${path} exists and is not a regular file; refusing to write a scenario over it` };
  }
  const first = await readFirstLine(path);
  if (first === null) {
    return { ok: false, reason: `cannot read ${path}, so it cannot be shown to be filmkit's; refusing to write over it` };
  }
  if (MARKER_RE.test(first)) return { ok: true, action: 'overwrite' };
  return {
    ok: false,
    reason:
      `${path} exists and does not start with the ${MARKER} marker, so it is not a file filmkit made and it will not be overwritten ` +
      '(--force does not apply: it covers takes, not hand-written tests). Move or rename it, or pass --scenario-dir <dir> to emit elsewhere.',
  };
}

/**
 * Write a generated file: re-check the target, create its directory if it does not exist yet (a
 * --scenario-dir that names a new directory passes preflight: nothing exists there to refuse), write
 * to a dot-temp beside it, rename into place, so a reader never sees half a file and a crash leaves no
 * truncated scenario. Throws on refusal, and when the directory cannot be made (a path component that
 * is a file is already refused by checkGeneratedTarget in preflight: ENOTDIR).
 * @returns {Promise<{ action: 'create'|'overwrite' }>}
 */
export async function writeGeneratedFile(path, text) {
  const check = await checkGeneratedTarget(path);
  if (!check.ok) throw new Error(check.reason);
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return { action: check.action };
}
