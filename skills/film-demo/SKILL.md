---
name: film-demo
description: Use when the user asks to record, capture, or film a video demo of a web app (a website or web product) or a mobile (Android/iOS) app. Scripted, human-paced walkthrough videos with an animated cursor, click indicators and captions, and automatic dead-air tightening. Also use when the user mentions filming/screen-recording a demo or wants marketing/PR footage of an app.
---

# Film a demo video with filmkit

filmkit films scripted, human-paced demo videos of any web app (and of Android and iOS apps), then
cuts out the dead air. Nothing in it knows about a specific app. Every command goes through the
launcher next to this file, from any directory:

```sh
"${CLAUDE_SKILL_DIR}/filmkit" help      # the command list
"${CLAUDE_SKILL_DIR}/filmkit" root      # where filmkit is installed (examples/, README.md, out/)
```

The full reference is `README.md` in the `root` directory. Read its Web camera section before
anything unusual.

## First: is this machine ready?

Run `"${CLAUDE_SKILL_DIR}/filmkit" doctor`. If it says `WEB camera: READY`, go on. Otherwise every
`MISSING` line has its exact fix:

- Installing Homebrew, Node.js or ffmpeg is system software: show the user the command and ask
  before running it. Homebrew's own installer asks for the Mac password, so the user runs that one
  in Terminal themselves. `brew install ...` does not need the password.
- Then run `"${CLAUDE_SKILL_DIR}/filmkit" setup` (safe to repeat) and `doctor` again.

Every filmkit error message says what to do next. Relay it to the user in plain words.

## Filming a web app

The two-pass workflow: explore off-camera, then compile a flow file and film it. Never write a flow
blind.

1. **Agree on the story.** The URL, what the video should show, in what order, and roughly how
   long (30-90s is typical). Ask if it's unclear. Captions carry the narration.
2. **Explore off-camera.**
   - `"${CLAUDE_SKILL_DIR}/filmkit" explore <url>` opens the page the way the camera will and lists
     every visible link, button, field and heading with a selector that matches exactly one element,
     plus a screenshot path. A `note:` line means the page redirected or moved itself on (a login
     wall looks like this). Read the screenshot. `--wait <css>` for a slow page, `--full` for the
     whole page, `--shot <png>` to choose the file. Explore each screen the demo will reach.
   - If you have the project's source, its end-to-end specs already carry working `data-testid`
     selectors. Prefer those.
   - When ego-browser is installed, `snapshotText()` inside it shows the signed-in page (see the
     ego-browser skill). Run `ego-browser nodejs -e '…' </dev/null`: with stdin left as an open
     pipe it waits for stdin to close.
3. **Write the flow file**, `<name>.demo.mjs`. Copy the shape of
   `"$("${CLAUDE_SKILL_DIR}/filmkit" root)/examples/web/tip-demo.demo.mjs"`. Put it in the user's
   project when there is one, otherwise in the `flows/` directory under `root` (gitignored, kept
   across updates). The file name, without `.demo.mjs`, names the video.
4. **Film it**, detached (see Commands for why), with the flow's absolute path:

   ```sh
   "${CLAUDE_SKILL_DIR}/filmkit" detach "$("${CLAUDE_SKILL_DIR}/filmkit" root)/out/<name>.log" web /abs/path/<name>.demo.mjs --tighten
   ```

   Poll the log (`tail -n 5 <log>`) until its last line is `EXIT=<code>`. 0 is a keeper.

5. **Check the take before you show it.** Pull a few frames with ffmpeg and look at them (the opening
   frame, each click, the last beat), and run `"${CLAUDE_SKILL_DIR}/filmkit" timeline <take.mp4>`.
   Fix the flow and film again (`--force` replaces the take) until it's right.
6. **Tell the user where the video is.** The finished video is the path on the
   `Tightened demo video written:` line, `<root>/out/<name>-tight.mp4`. The untightened take
   `<name>.mp4` and its `.json` sidecar sit beside it, and the captions as subtitles,
   `<name>-tight.srt` and `<name>.srt` (each matches the video of the same name). If tighten said
   `already tight`, the raw take is the finished video. The `tightened A -> B (N cuts, X removed)`
   line adds up (X = A - B, both read off the files). Give the full path, and offer to show it: `open -R <path>` reveals it in
   Finder, `open <path>` plays it.

**Which browser films.** The default, `--browser auto`, films in ego-browser when it is installed and
running (the user's own Chromium, already signed in to their sites). It is found even when your shell's
PATH lacks `~/.local/bin`, where ego's setup puts it (`doctor` says where it found it), so don't add
it to PATH yourself. Otherwise it films in
Playwright's headless Chromium and prints one line saying why (the same reason lands in the
sidecar's `backendNote`). Playwright starts signed out every
time, so a page behind a login films its login screen. To film signed in, either install ego lite
(https://lite.ego.app/), have the user sign in there once and keep it open, or have the flow sign in
with a demo account as its first steps (that's on camera). `--browser ego` or `--browser playwright`
forces one. Forced ego refuses, with the fix, when ego isn't installed or isn't answering.

## Commands

```sh
F="${CLAUDE_SKILL_DIR}/filmkit"

# WEB
"$F" web <flow.demo.mjs> --tighten [--browser auto|ego|playwright] [--out <dir>] [--name <stem>] \
  [--force] [--viewport 1280x720] [--crf 18] [--serve-root <dir>] [--no-captions] \
  [--scenario [--scenario-dir <dir>] [--scenario-verify [--scenario-config <playwright.config>]]]

# ANDROID (boots an emulator only if none is running)
"$F" android <flow.yaml> --tighten \
  [--device <serial> | --avd <name>] [--install <apk>]... [--app <pkg> --fresh] [--crf 18] \
  [--scenario [--scenario-dir <dir>] [--scenario-verify]]

# IOS SIMULATOR (macOS with Xcode)
"$F" ios <flow.yaml> --tighten \
  [--simulator "<name>" | <udid>] [--install <App.app>]... [--app <bundle-id> --fresh] [--clean-status-bar] [--crf 18] \
  [--scenario [--scenario-dir <dir>] [--scenario-verify]]

# STANDALONE dead-air cut on ANY existing video (a web take's captions also land in <stem>-tight.srt;
# an existing -tight.mp4 or -tight.srt needs --force)
"$F" tighten <video.mp4> [--crf 18] [--force]

# INSPECTION
"$F" explore <url-or-file>          # a page's targetable elements and a screenshot (web, pass 1)
"$F" timeline <take.mp4>            # one line per screen change in a take
"$F" hierarchy --device <serial>    # readable `maestro hierarchy` (mobile, pass 1)
"$F" scenario <flow> --from <take.json>   # re-emit a web flow's Playwright test without filming
"$F" doctor                         # what each camera needs and the fix for what's missing
"$F" detach <log> <command> ...     # any command above in the background, its own session (below)
```

`--crf <0-51>` (default 18) is the quality of every re-encode; lower is bigger and closer to the
source.

**Captions vs subtitles.** Captions are drawn into the web video by default, and every web take with
captions also gets them as `<name>.srt` (and `<name>-tight.srt` for the tightened video). Pass
`--no-captions` when the user wants the video without text on it: they will record a voiceover, add
subtitles in an editor (they import the `.srt`), or want a clean version beside the captioned one
(film it twice, `--name <stem>-clean` for the second). Keep the `stage.caption()` calls in the flow
either way: they still hold the same beats, so the take has the same pacing and the `.srt` carries
the narration. The sidecar says `captions: "hidden"`. The cursor and click rings always show.

**Launch cameras detached and poll the log.** A camera started as a child of your shell dies when
your turn ends, mid-take. Run it through `detach`, which starts it in its own session:
`"${CLAUDE_SKILL_DIR}/filmkit" detach take-1.log android <flow.yaml> --tighten --name take-1`. Then
poll `take-1.log` until its last line is `EXIT=<code>` (0 a keeper, 2 a keeper whose `--scenario`
failed, 129/130/143 a signal, 1 a failed take). A log without that line means the job was killed
outright. To stop a detached take early, run the `kill -INT -<pid>` line `detach` printed; what was filmed is
salvaged as usual.

Flow-file examples to copy from: `examples/{web,android,ios}/` under `root`.

## Flow APIs in one glance

- **Web** (`export default async ({ stage }) => {}`) gives you `stage.open(urlOrPath)`,
  `stage.goto(urlOrPath)`, `stage.waitFor(target)`, `stage.click(target)`, `stage.point(target)`,
  `stage.type(target, text)`, `stage.caption(text)` (drawn, held and written to the `.srt`; with
  `--no-captions` held and written only), `stage.clearCaption()`, `stage.pause(ms)`,
  `stage.page`, and `stage.timeline`. `click`/`point`/`type`/`waitFor` auto-wait up to 10s for the
  target; pass `{ timeoutMs }` last to change it per call (`stage.waitFor('.result', { timeoutMs:
  120_000 })`). Target is a CSS selector on both backends (the `:has-text("…")` pseudo-class works on
  both too); a Playwright `Locator` or `(page) => Locator` works only when Playwright films,
  since ego has no Playwright object to build one from and rejects it. Use selector strings: the
  flow then films on whichever browser `auto` picks. A relative `open()` path resolves against the flow's directory (or `--serve-root`)
  and is served over http at the origin root on both backends, so a page's `/app.js` works. A
  4xx/5xx or a network error on `open()`/`goto()` fails the take. The cursor starts at the viewport
  center, which on a centered app sits on whatever is there: `stage.open(url, { cursorAt: 'h1' })`
  starts it at a target's center instead (an `h1` spans its card, so that is the space beside the
  title, when nothing sits right under it). The take opens on the loaded page with the cursor
  already placed (the loading before it is cut; later page loads stay on film). Check the opening frame. `type()` leaves the cursor on the field's center while it types, so keep typed text short
  enough to end left of it, and blur the last field before a closing beat
  (`stage.page.evaluate('document.activeElement?.blur()')`) or its focus ring stays on screen.
  Don't scroll by hand before a click: a target that is off screen, half visible or under the
  caption gets scrolled to the middle of the viewport, animated on film. If even that can't clear
  the caption (a fixed bottom bar, the last link on a short page), the caption moves to the top
  edge for that action.
- **Web, nondeterministic apps.** `stage.expect(target, { text, timeoutMs })` is a checkpoint
  (`text` is a case-sensitive substring). `stage.oneOf` is a branch point: it returns whichever
  target appeared first, and you branch in plain JS:

  ```js
  const build = await stage.oneOf(
    { built: '[data-testid=preview]', failed: '[data-testid=build-error]' },
    { name: 'build', timeoutMs: 300_000, filmAccept: ['built'] },
  );
  if (build === 'built') { /* film the payoff */ } else { await stage.expect('[data-testid=retry]'); }
  ```

  `filmAccept` is what the camera keeps: a `failed` outcome fails the take (`flow-failed`, a
  `.failed*` retake, after a 1s hold) and you film again. `accept` (default: all keys) is what a
  scenario test passes on, so CI still passes either way. Unknown option keys throw. Clear the
  caption before a long wait, or tighten can't cut it. Outcomes land in the sidecar's `outcomes`.
  Worked example: `examples/web/generate.demo.mjs`.
- **Web under ego** the flow runs inside ego-browser's Node runtime. Your shell's env vars don't
  reach it, its cwd is `/` (build paths from `import.meta.url`), and `[ego]` notes print only when
  the run ends. To vary a flow per take, edit the flow (a `?query` on a `file:` URL is kept).
- **Mobile** is plain Maestro YAML (`appId:` + steps). Pause idiom (Maestro has no sleep), gated so a
  `--scenario` test run skips it (it holds when filming and when the variable is undefined):

  ```yaml
  - runFlow:
      when: { true: "${FILMKIT_MODE != 'test'}" }
      commands:
        - extendedWaitUntil: { visible: "__filmkit_demo_pause_marker__", timeout: 2000, optional: true }
  ```

  Never put two waits back to back: a wait's timeout counts from the start of the previous unmatched
  wait, so the second pause holds ~0.4s. Put `waitForAnimationToEnd` between them (`tapOn` also
  resets it, `assertVisible` doesn't). Both device cameras warn at preflight (`flowLint` in the
  sidecar). Never put `FILMKIT_MODE` in a flow's header `env:`; it beats `-e` and the wrapper.

  Clean text replace: `longPressOn` then tap `"Select all"` then `inputText` (never bare
  `inputText` over existing text; it appends). Tap indicators are burned into every take by
  default; pass `--no-show-taps` to opt out. See the README's Tap indicators section.
  Maestro reads the hierarchy, then taps that point a moment later, so a screen that is still
  settling moves the tap. Put `waitForAnimationToEnd` before a `tapOn` (see the iOS example's
  dwell) and check where the ring landed. `swipe` percentages must be integers.

## Guardrails

- Keep device flows under ~2.5 min (Android screenrecord hard-caps at 180s; iOS doesn't).
- Android size: don't pass `--size` unless you need it. The camera probes the encoder and picks the
  largest filmable size (1144x2546 on a tall AVD, cropped to a 1142x2546 take). A `--size` the
  encoder refuses or with the wrong aspect aborts before the flow runs, costing no take. So does a
  size probe that stays inconclusive through its retries ("the recorder's size probe isn't
  answering"): nothing was filmed, just rerun.
- Failed takes step aside on all three cameras: `<name>.mp4` becomes `<name>.failed.mp4` (then
  `.failed-2`, `.failed-3`), with a `.failed.json` sidecar. A retake needs no `--force`. An
  `interrupted` take keeps its name and does need `--force`, and so does an existing `-tight.mp4`
  even without `--tighten` (and on the web, an existing `.srt` or `-tight.srt`). Under `--force`, a failed retake keeps
  the previous take on all three cameras; only an `ok` or `interrupted` take replaces it. A killed
  run can leave the old take hidden as `.<name>.prev.*`. The next run restores it, or refuses and
  explains if a new take sits at the plain name. Evidence a device run keeps (segments, debug
  spill, failed attempts, the iOS raw) carries the run's UTC start, like `20260929-234714`, and no
  later run deletes it. An Android segment's device copy is removed once it's been pulled, since
  the local copy is the same file (an empty one too). Only a segment that couldn't be pulled or
  verified stays on `/sdcard` (the run says why, and the sidecar's `keptFiles.device` names it);
  remove it when you're done. An Android recorder that dies on its own mid-flow, however young,
  makes the take `truncated` (the rest of the flow isn't on film) and keeps its pulled segments
  (`keptFiles.local`): retake it. One that dies after the flow ended (`tailHold.endedBy:
  "recorder-gone"`) cut nothing off the flow; the take is judged on what was written. If it was
  SIGKILLed its file is lost, so the take is still `truncated` by that loss (or `failed` with no
  video if it was the only segment, `recording.truncated` then false, and the last line says
  `there is NO TAKE`). The console judges the death once, after the pull, and says which. The
  `error` then says how and when the recorder died, whether its file was pulled, and how much of
  the flow is missing apart from the tail hold (`6.96s of the flow is missing from the take, and
  the 0.46s of tail hold it filmed after it`). Drop reasons, the abort line and the sidecar's
  `error` describe a recorder's end in the same words (`killed on the device by SIGKILL (exit
  137)`, `failed on its own (exit 233)`, `we stopped it (SIGINT)`), and a failed pull quotes adb. An `interrupted`
  Android take is still cropped (a stream copy), so it has no black column.
- Web statuses: `ok` (exit 0), `flow-failed` and `failed` (exit 1, `.failed.*`), `interrupted`
  (130/129/143, salvaged), and 2 for a `--scenario` failure on an `ok` take. Only `ok` is
  tightened. A capture that stopped delivering frames is `failed`: retake it. A take whose
  `capture.stallCheck.method` is `"unverified"` was kept with a warning because the probe
  couldn't run, so watch it. A `capture was slow` warning (`capture.rate.degraded`, frames per second
  of cursor motion under 12.5 against 25) keeps the take `ok` but it is choppy and its actions ran
  slow: film it again (the first ego take after the runtime starts cold does this). A warning that
  `the opening was not cut` (`capture.opening.state` `"abandoned"`) keeps the take `ok`, but it opens
  on the page loading: film it again. For a slow
  result, give the wait a long `{ timeoutMs }` instead of a `pause`.
  ffprobe is required; Playwright only when it films (setup installs it).
- The camera retries a maestro that fails at startup before any command ran (gRPC UNAVAILABLE on
  Android, the driver timeout on iOS), inside the same take, for up to 45s. It's recorded in the
  sidecar's `maestroRetries`; tighten cuts the extra head. Don't rerun the take for that.
- Signals (Ctrl-C 130, SIGHUP 129, SIGTERM 143) all salvage what was filmed as an `interrupted`
  take, on every camera, unless the take had already failed (the flow failed, a web check failed,
  or on Android a truncated/interloper/taps/geometry verdict). Then it stays that failure and
  steps aside as `.failed-N`, the sidecar's `interruptedBy` names the signal, and every camera
  exits with the signal's code. On the device cameras a signal before the flow's first command
  ran films nothing: no take, no sidecar, the previous take restored. A device take a signal ended
  is saved first, then gets the rings for its taps in a second pass (about 0.4x the take's length;
  the sidecar is rewritten when they land). A second signal skips that pass and keeps the saved
  take without rings, so send one only if you'd rather not wait. A SIGKILL during that pass leaves a
  hidden `.<name>.taps-<pid>.mp4`, which the next run of the same name removes. A device flow the
  camera stopped has no command record, so its rings are all plain taps (the run notes it). iOS "Host recording is
  already in progress" means an earlier recorder was killed uncleanly; the camera stops with the
  fix, `xcrun simctl shutdown <udid> && xcrun simctl boot <udid>`.
- An iOS `ok` take holds its last frame until the camera stopped (`simctl` writes no frame while
  nothing changes), so a flow that ends on a held beat keeps that beat. The sidecar's `delivered.heldTail`
  says by how much, on every take. A failed flow or an interrupted take is never held (`pinnedSec`
  null, `heldSec` 0).
- Android keeps the recorder rolling after the flow until its encoder has written everything (the
  tail hold, usually 0.5-3s, up to 10s if the screen never stops moving), then cuts the take at the
  flow's end with its last frame held. The final beat is on film; you don't need extra hold for it.
  `recording.tailHold.covered: false` (with a warning) is the one case where frames were still
  lost. Each seam of a segmented take still costs ~0.4-0.6s plus a ~1s frozen frame. The console's
  durations line and `recording.durations` (`holdSec`, `headSec`, `seamSec`, `lostSec`, `tailSec`)
  say exactly where a take's wall clock went, on every take including interrupted ones; both sums
  add up exactly as printed (largest-remainder rounding). A nonzero `unrecordedSec` means the
  recorder had stopped while the flow ran on, so that time isn't on film. A take with no pinned end
  (a signal, a dead chain) ends exactly where its recorder stopped (stream copy, only the last
  frame's duration is trimmed), so `overhangSec` is ~0. A tap that lands in a seam handover is drawn on the next segment's first frame
  (`taps[].seamShiftSec`), so it no longer fails the take as `taps-missing`.
- With `--app` or `--guard-app` on Android, whatever surfaces while the app's own `launchApp`
  restarts it (usually the previous task, sometimes the launcher) is `relaunch`, not an
  interloper, for the command plus 1.5s. A Home press or another app at any other time still
  fails the take as `interloper`.
- CI test from a take: add `--scenario` (any camera). Only an `ok` take emits. **Exit 2 means the
  take is fine and the scenario isn't** (emit, load check or verify failed; the sidecar's
  `scenario` says which). A file at the output path without the `@filmkit-generated` first line
  is never overwritten, and preflight refuses before filming. `--scenario-verify` runs it once
  after filming, repeating the app's side effects.
  - Mobile writes `<flow>.scenario.yaml`, a wrapper that runs the flow with `FILMKIT_MODE=test` and
    the tag `filmkit-scenario`. Its paths are relative to its own directory. Run it with
    `maestro test --include-tags filmkit-scenario --format junit --output report.xml <dir>/`
    (`.` from the wrapper's directory). Its verify wipes app data.
  - Keep the flow inside the project that gets the scenario. A spec's flow import (and serve root)
    or a wrapper's `runFlow` file that leaves the project still resolves on this machine, but a
    clone or CI won't have it: the camera prints a warning and records it in `scenario.warnings`.
    Header paths that would climb through your home's parent read `<filmkit>/…`, `<flow-dir>/…`,
    `<take-dir>/…` or `<serve-root>` instead.
  - Web writes `<stem>.scenario.spec.mjs` plus a shared `filmkit-stage.mjs`; the project needs
    `@playwright/test`. Run it with `npx playwright test <spec file name>`, from the project root
    or the spec's directory. Every path in it is relative to the spec, and its header's regenerate
    commands are run from the spec's directory. Auth comes from the project's
    Playwright `storageState` (filmkit never exports ego's cookies), so an ego-filmed signed-in
    flow verifies signed out unless you pass `--scenario-config <the project's config>`. A red
    clean-room verify keeps Playwright's output (error context, screenshots) and names it in
    `scenario.verify.outputDir`. Env:
    `FILMKIT_BASE_URL` (rebase onto staging), `FILMKIT_PAUSE_SCALE` (`1` replays pauses),
    `FILMKIT_TIMEOUT_MS`. Re-emit without filming:
    `"${CLAUDE_SKILL_DIR}/filmkit" scenario <flow> --from <take.json>`.
- `--fresh` wipes app data: on Android via `pm clear`, on iOS via uninstall, which is why iOS
  requires `--install` alongside it. In a `--scenario` wrapper it becomes `clearState` (plus
  `clearKeychain` on iOS, where it reinstalls the installed app and fails on system apps).
- If another agent or process may be using the connected emulator/simulator, ask before
  installing/clearing anything on it; prefer `--device <serial>` targeting over "first online".
- Always pass `--tighten` unless asked otherwise; raw files are kept next to the tightened ones.
  On the web camera, captions and pauses are protected from the sidecar's own timeline; on the
  device cameras, every drawn tap is protected the same way, so a long hold with a tap near its
  end still keeps the tap and its ring instead of getting clamped through it. A fully captioned or
  tapped take may end up removing nothing at all, which is correct, not a failure.
- A mobile take whose flow tapped but came back with no rings drawn is a failed take, not a
  cosmetic miss: the camera exits 1 and names the Maestro debug directory, so don't treat that
  exit code as a flaky retry. The exception is an Android `truncated` take whose taps all fell in
  footage it lost: that stays `truncated`, and the retake is for the truncation.
- Output lands in filmkit's own `out/` (under `root`) by default, not the user's project. It's kept
  across runs and updates. Pass `--out <dir>` to land a take inside the project being demoed. Always
  report the final path(s) to the user.
- When you're working on filmkit itself (the checkout is your project), log anything that went
  wrong or cost time in `FEEDBACK.md` under `root`.
