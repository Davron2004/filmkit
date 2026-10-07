# filmkit

Scripted demo-video filming for web, Android and iOS, plus `tighten.mjs`, a dead-air cutter.
README.md is the full reference. Read the section for the camera you're changing first.

## Rules

- Stay app-agnostic. Nothing in the repo may know about a specific app being filmed.
- Plain Node ESM, Node 20+. The device cameras and tighten have zero npm dependencies and only
  orchestrate external tools (ffmpeg, adb, maestro, xcrun), resolved through `lib/tools.mjs`.
  Playwright is only for the web camera's `--browser playwright` fallback and for running an
  emitted web scenario.
- Every take on every camera shows a tap or click indicator. A camera or backend that films
  without one is a bug.
- An existing take is never overwritten without `--force`, and the refusal happens in
  preflight, before anything is filmed.
- Web flows are backend-agnostic: targets are CSS selectors. Browser-specific work goes behind
  the backend interface in `lib/backends/`.
- A stage API change lands in both `lib/stage.mjs` (the camera) and
  `lib/scenario/filmkit-stage.mjs` (test mode). The shared Playwright target code (resolving,
  clicking, typing, probing), the text rule, the option validators and the `expect`/`oneOf` poll
  loop live in `filmkit-stage.mjs`; `lib/backends/playwright.mjs` and `lib/stage.mjs` import them
  and `lib/target-wait.mjs` re-exports them. That file is copied next to every emitted spec, so it
  imports only `node:` built-ins.
- Each large file opens with a header comment that holds its state machine and the measured
  reasons for its odd-looking choices (SIGINT to stop `screenrecord`, the Android stitch math,
  tighten's VFR handling, the ego runtime's limits). Read it before changing that code, and
  update it when the behavior changes.

## Verifying a change

There is no test suite. Film a real take and inspect it: ffprobe, the sidecar `.json`,
`node tools/timeline.mjs <take.mp4>`, `node tighten.mjs <take.mp4> --dry-run`.

- Web: `node film-web.mjs examples/web/tip-demo.demo.mjs --tighten --force`. The default
  `--browser auto` films in ego-browser when it's running and in Playwright otherwise; pass
  `--browser ego` or `--browser playwright` to test one backend.
- Install path (`setup.sh`, `skills/film-demo/filmkit`, `tools/doctor.mjs`): run them against a
  scratch copy with `CLAUDE_CONFIG_DIR` pointed at a scratch directory, never your real `~/.claude`.
- Android/iOS: a flow from `examples/` against a running emulator or simulator. Ask before
  installing or clearing apps on a device another agent might be using.

Output lands in `out/` (gitignored). Specs emitted for the examples with `--scenario` stay
uncommitted: the adapter copy drifts with filmkit, and the header carries machine-specific paths.

## Docs that move with the code

When a flag, default or behavior changes, update both `README.md` and
`skills/film-demo/SKILL.md`. That skill is how agents in other projects drive filmkit: `setup.sh`
symlinks it into `~/.claude/skills/film-demo`, and it runs every tool through the launcher beside it
(`"${CLAUDE_SKILL_DIR}/filmkit" <command>`), never through a path to this checkout. A new tool gets a
launcher subcommand.

`FEEDBACK.md` is the friction log from real filming sessions. It holds open items only: when an
item is fixed, delete it (git history keeps the text). Items keep their original numbers,
because code comments cite them.
