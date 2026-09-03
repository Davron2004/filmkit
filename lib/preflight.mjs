// ─────────────────────────────────────────────────────────────────────────────
// lib/preflight.mjs — the checks a filming run makes BEFORE it touches a browser,
// a device, or the clock.
//
// The rule the device cameras established and this shares: filming is a repeated activity and
// a clobbered take is gone, so an existing output is never overwritten. The refusal happens
// here, first, rather than at write time — a run that is going to refuse should refuse before
// it spends thirty seconds filming. The cap is enforced in exactly one place (the filesystem
// check below), not in the CLI parser and not at the encoder.
import { fileExists } from './tools.mjs';

/** A name becomes a filename stem in --out; keep it one. Same rule film-android.mjs uses. */
export const NAME_STEM_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateNameStem(name) {
  if (name === undefined) return;
  if (!NAME_STEM_RE.test(name)) {
    throw new Error(`--name must be a bare filename stem — letters, digits, . _ - (got "${name}")`);
  }
}

/**
 * @param {string} flowPath
 * @param {string[]} plannedOutputs every file this run intends to write
 * @param {boolean} force
 */
export async function preflight(flowPath, plannedOutputs, force) {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 20) {
    throw new Error(`Node >= 20 required — running under Node ${process.version}`);
  }
  if (!(await fileExists(flowPath))) {
    throw new Error(`flow file not found: ${flowPath}`);
  }
  if (!force) {
    for (const candidate of plannedOutputs) {
      if (await fileExists(candidate)) {
        throw new Error(
          `refusing to overwrite an existing take: ${candidate}\n` +
            '  pass --name <basename> to film a new one, or --force to overwrite this one.',
        );
      }
    }
  }
}
