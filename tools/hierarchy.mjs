#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// tools/hierarchy.mjs — make `maestro hierarchy` readable (FEEDBACK #6).
//
// `maestro hierarchy` dumps thousands of lines of pretty-printed JSON where the useful
// attributes (text, accessibilityText, bounds, clickable) drown in boilerplate. This prints
// the same screen as a shot list: one line per node that has text or an accessibility label.
//
//   maestro --device <serial> hierarchy | node tools/hierarchy.mjs
//   node tools/hierarchy.mjs --device <serial> [--clickable-only] [--in <file>]
//
// No dependencies (JSON.parse + recursive walk). `--diff` is planned, not built: v1 prints
// one screen; diff two dumps with the shell (`diff <(…screen A) <(…screen B)`).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const USAGE =
  'usage: maestro hierarchy | node tools/hierarchy.mjs [--clickable-only]\n' +
  '       node tools/hierarchy.mjs --device <serial> [--clickable-only] [--in <file>]';

function parseArgs(argv) {
  let device = null;
  let clickableOnly = false;
  let inFile = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--device') {
      device = argv[++i];
      if (!device) { console.error(USAGE); process.exit(1); }
    } else if (argv[i] === '--clickable-only') {
      clickableOnly = true;
    } else if (argv[i] === '--in') {
      inFile = argv[++i];
      if (!inFile) { console.error(USAGE); process.exit(1); }
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`unknown flag ${argv[i]}\n${USAGE}`);
      process.exit(1);
    }
  }
  return { device, clickableOnly, inFile };
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function loadHierarchy({ device, inFile }) {
  if (inFile) return readFileSync(inFile, 'utf8');
  if (device) {
    const r = spawnSync('maestro', ['--device', device, 'hierarchy'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) {
      console.error(`maestro hierarchy failed: ${(r.stderr || r.error?.message || '').trim()}`);
      process.exit(1);
    }
    return r.stdout;
  }
  const stdin = readStdin();
  if (stdin.trim()) return stdin;
  console.error(USAGE);
  process.exit(1);
}

function walk(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node.attributes && typeof node.attributes === 'object') out.push(node.attributes);
  const kids = node.children;
  if (Array.isArray(kids)) for (const k of kids) walk(k, out);
}

function fmtBounds(b) {
  if (!b) return '';
  if (typeof b === 'string') return b;
  if (typeof b === 'object') {
    // Maestro bounds shapes vary by version; print whatever numbers exist.
    const { x, y, width, height, left, top, right, bottom } = b;
    if (left !== undefined) return `[${left},${top}][${right},${bottom}]`;
    if (x !== undefined) return `[${x},${y}][${x + (width ?? 0)},${y + (height ?? 0)}]`;
    return JSON.stringify(b);
  }
  return String(b);
}

function main() {
  const { device, clickableOnly, inFile } = parseArgs(process.argv.slice(2));
  const raw = loadHierarchy({ device, inFile });
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    console.error(`could not parse hierarchy JSON: ${err.message}`);
    process.exit(1);
  }
  const nodes = [];
  walk(doc, nodes);
  let shown = 0;
  for (const a of nodes) {
    const text = a.text ?? '';
    const a11y = a.accessibilityText ?? '';
    if (text === '' && a11y === '') continue;
    if (clickableOnly && a.clickable !== true && a.clickable !== 'true') continue;
    console.log(`${text}\t| a11y=${a11y}\t| ${a.class ?? a.className ?? ''}\t| ${fmtBounds(a.bounds)}\t| click=${a.clickable ?? ''}`);
    shown++;
  }
  if (shown === 0) console.error('(no nodes with text or accessibilityText — try without --clickable-only)');
}

main();
