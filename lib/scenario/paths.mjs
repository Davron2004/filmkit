// ─────────────────────────────────────────────────────────────────────────────
// lib/scenario/paths.mjs — how a generated scenario file (the web spec, lib/scenario/emit-web.mjs; the
// Maestro wrapper, lib/scenario/emit-maestro.mjs) writes a path. Shared, so the two emitters cannot
// disagree about what leaks the machine's layout and what does not.
//
// Every path in a generated file is relative to that file's own directory, computed between REAL paths
// (realPathLoose: Node realpaths a module's import.meta.url, so a /tmp or symlinked spelling must not
// put a `../../private/...` chain in). No absolute machine path is ever written. Two kinds of path, two
// rules:
//
//   PROVENANCE (a header's `flow`, take, regenerate commands): only read by a person. When the
//   relative path would climb through the machine's layout (see sharesTree), it is written as
//   `<anchor>/<path below it>` instead, the anchors being named places the reader can substitute:
//     <filmkit>    the filmkit checkout (only for a path INSIDE it)
//     <flow-dir>   the flow file's directory
//     <take-dir>   the directory the take was filmed into
//     <serve-root> the take's serve root (its own anchor, the last resort for --serve-root)
//   Each caller lists the anchors that make sense for that path; the first one that the path shares a
//   tree with wins. Every list ends with an anchor that contains the path, so a path is never left
//   climbing.
//
//   FUNCTIONAL (the web spec's flow import and serve root, the wrapper's `runFlow` file): has to
//   RESOLVE, so it keeps its `../` chain whatever it climbs through, and the emitter reports it instead:
//   layoutWarning() says when the path leaves the project that holds the generated file (the nearest
//   ancestor with a package.json or a .git), because a clone or a CI checkout of that project will not
//   have it, and when it also spells out the layout above the home directory (a username).
//
// WHAT "CLIMBS THROUGH THE LAYOUT" MEANS (sharesTree): the two paths' deepest common ancestor is `/`,
// or a directory ABOVE the home directory (`/Users`, `/home`). A relative path between them then goes up
// to that ancestor and back down through the home directory's own name, so it names the user (measured:
// a spec in /private/tmp/... importing ~/Work/... got `../../../../…/Users/<user>/Work/…`). A common
// ancestor that is the home directory itself, or anything below it, or any tree outside /Users and /home
// (two dirs under /private/tmp) never names one: the climb stops at the ancestor, and only names below
// it are spelled out.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { realPathLoose } from './filmkit-stage.mjs';

const posix = (p) => p.split(sep).join('/');

/** True when `path` is `dir` or below it (both real paths). */
export function isInside(dir, path) {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** True when a relative path between `a` and `b` stays out of the machine's layout (header above). */
export function sharesTree(a, b) {
  const x = realPathLoose(a).split(sep);
  const y = realPathLoose(b).split(sep);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  const common = x.slice(0, n).join(sep) || sep;
  if (common === sep) return false;
  const home = realPathLoose(homedir());
  return !(home.startsWith(common + sep) && common !== home);
}

/**
 * A PROVENANCE path, for a file in `fromDir`: relative (`./x`, `../x`) when that stays out of the machine's
 * layout, else `<anchor>/…` by the first anchor that fits. Quoted (JSON) when it holds whitespace.
 * @param {string} fromDir
 * @param {string} path
 * @param {Array<{name: string, dir: string, inside?: boolean} | null>} anchors `inside`: only for a path
 *   inside `dir` (<filmkit>: `<filmkit>/../app` would point the reader at the wrong place)
 */
export function provenancePath(fromDir, path, anchors = []) {
  const from = realPathLoose(fromDir);
  const to = realPathLoose(path);
  let rel = null;
  if (sharesTree(from, to)) {
    rel = posix(relative(from, to)) || '.';
    if (!rel.startsWith('.')) rel = `./${rel}`;
  } else {
    for (const a of anchors) {
      if (!a) continue;
      const dir = realPathLoose(a.dir);
      if (a.inside ? !isInside(dir, to) : !sharesTree(dir, to)) continue;
      const below = posix(relative(dir, to));
      rel = below ? `<${a.name}>/${below}` : `<${a.name}>`;
      break;
    }
    // Every caller ends its list with an anchor that holds the path; this is the guard if one does not.
    rel ??= '<outside this tree>';
  }
  return /\s/.test(rel) ? JSON.stringify(rel) : rel;
}

/** The nearest ancestor of `dir` (itself included) holding a package.json or a .git, or null. */
export function projectRootOf(dir) {
  let at = realPathLoose(dir);
  for (;;) {
    if (existsSync(join(at, 'package.json')) || existsSync(join(at, '.git'))) return at;
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/**
 * The warning for a FUNCTIONAL path that a generated file in `fromDir` reaches outside its project, or
 * null when it stays inside. `what` names the path for the message ("The spec's flow import"), `noun` the
 * thing to move ("the flow").
 * @returns {string|null}
 */
export function layoutWarning(fromDir, path, what, noun = 'the flow') {
  const to = realPathLoose(path);
  const project = projectRootOf(fromDir);
  const leaks = !sharesTree(fromDir, to);
  if (project && isInside(project, to) && !leaks) return null;
  if (!project && !leaks) return null;
  const where = project ? `outside the project at ${project} (the nearest package.json or .git above the generated file)` : 'through the layout above your home directory';
  return (
    `${what} reaches ${to}, ${where}. It resolves on this machine only: a clone or CI checkout of the project ` +
    `will not have that path${leaks ? ', and the file spells out this machine\'s directory layout, your username included' : ''}. ` +
    `Keep ${noun} inside the project that holds the generated file, and emit again from there.`
  );
}
