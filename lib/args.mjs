// ─────────────────────────────────────────────────────────────────────────────
// lib/args.mjs — the one rule every filmkit CLI needs and none of them should re-invent:
// a flag that takes a value must actually be followed by one.
//
// Without this, `--out --force` silently creates a directory literally named "--force" and the
// take lands somewhere nobody will look; `--name` at the end of the line yields `undefined` and
// the run names its output "undefined.mp4". Both are the shell's most ordinary typo. Lifted out
// of tighten.mjs, which had it right first.
//
// The `--` guard is deliberately syntactic rather than a lookup against a list of known flags:
// a value that genuinely starts with `--` is not something any of these CLIs takes, and treating
// the next flag as a value is far more likely to be the mistake than the intent.

/**
 * @param {string[]} argv
 * @param {number} i index of the FLAG itself
 * @param {string} flag the flag's name, for the message
 * @param {(msg: string) => never} onError how this CLI reports a usage error
 * @returns {string}
 */
export function valueFor(argv, i, flag, onError) {
  const value = argv[i + 1];
  if (value === undefined) onError(`${flag} needs a value — nothing followed it`);
  if (value.startsWith('--')) onError(`${flag} needs a value, but the next argument is the flag "${value}"`);
  return value;
}
