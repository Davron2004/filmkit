#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// tools/detach.mjs — `filmkit detach <log> <command> [args...]`: run a launcher command in the
// background, in its OWN SESSION, so nothing that happens to the shell that started it reaches it.
//
//   node tools/detach.mjs <log> <launcher> <command> [args...]      (the launcher passes its own path)
//
// Output (stdout and stderr) goes to <log>, and the last line is `EXIT=<code>`, the command's exit code,
// so a log without that line means the job was killed outright (README "Running a camera from an
// agent shell").
//
// WHY A NEW SESSION AND NOT NOHUP: nohup only sets SIGHUP to "ignore", and Node replaces that with its
// own handler as soon as a script listens for SIGHUP, which every camera does (it salvages the take). So
// a SIGHUP sent to the caller's process group still stops a nohup'd camera. MEASURED (2026-10-06): a
// `nohup sh -c '<launcher> web …'` job started from a shell whose process group then got SIGHUP ended
// `interrupted` after 5.3s, exit 129. spawn({ detached: true }) calls setsid(): the job leads a new
// session and process group, which a signal to the caller's group or a hangup of its terminal does
// not reach. macOS has no setsid(1), and Node is already guaranteed here (the launcher checked it).
// STOPPING ONE ON PURPOSE: `kill -INT -<pid>` (the printed pid; the minus sends it to the whole group,
// since the pid itself is the sh wrapper). The wrapper ignores INT/HUP/TERM so it survives to write the
// EXIT line; the camera does not inherit the ignore in effect (Node installs its own handlers, as above),
// so it salvages the take as usual and EXIT carries its 130.
import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [logArg, launcher, ...command] = process.argv.slice(2);
if (!logArg || !launcher || command.length === 0) {
  console.error('usage: filmkit detach <log file> <command> [args...]   e.g. filmkit detach take.log web /path/to/flow.demo.mjs --tighten');
  process.exit(1);
}
const log = resolve(logArg);
let fd;
try {
  mkdirSync(dirname(log), { recursive: true }); // e.g. <root>/out/ before the first take made it
  fd = openSync(log, 'w');
} catch (err) {
  console.error(`filmkit detach: cannot write the log file ${log} (${err.code ?? err.message})`);
  process.exit(1);
}
// sh, so the EXIT line is written after the command ends however it ends; "$0" "$@" keeps every
// argument exactly as given (no re-splitting, no globbing).
const child = spawn('/bin/sh', ['-c', 'trap "" INT HUP TERM; "$0" "$@"; echo "EXIT=$?"', launcher, ...command], {
  detached: true,
  stdio: ['ignore', fd, fd],
});
child.unref();
closeSync(fd);
console.log(
  `Started in the background (pid ${child.pid}, its own session: closing this shell does not stop it).\n` +
    `Its output goes to ${log}; the last line is EXIT=<code> when it is done (0 = a good take).\n` +
    `To stop it early (what was filmed is kept): kill -INT -${child.pid}`,
);
