# filmkit

Film human-paced, watchable demo videos of **any** web or mobile app: scripted flows,
deterministic choreography, and a dead-air cutter that tightens the result. Three cameras, one
editor:

| Camera | Films | Stack | Output |
|---|---|---|---|
| `film-web.mjs` | Any web app (URL or local file), filmed inside your real signed-in browser or in headless Playwright, with an animated cursor, click ripple, and caption overlays | ego-browser or Playwright + ffmpeg | `out/<flow>.mp4`, captions also as `out/<flow>.srt` |
| `film-android.mjs` | Any app on an Android emulator/device, the real UI, amber tap indicators burned in | Maestro + `adb screenrecord` + ffmpeg | `out/<flow>-android.mp4` |
| `film-ios.mjs` | Any app on an iOS Simulator, the real UI, amber tap indicators burned in | Maestro + `simctl recordVideo` + ffmpeg | `out/<flow>-ios.mp4` |
| `tighten.mjs` | Cuts dead air out of any video, sparing the caption and pause holds it's told about (also usable standalone) | ffmpeg | `<in>-tight.mp4`, a web take's captions also as `<in>-tight.srt` |

Every camera can also turn an `ok` take into a CI test that replays the same flow file
(Playwright Test for web, Maestro for mobile). See Scenarios.

Extracted from the Whim project's `demo/` tooling, where it filmed production demo videos;
generalized so no part of it knows about any particular app.

## Install on a new Mac

For filming a web app with Claude Code. You need a Mac with Claude Code installed.

1. Open Terminal and run these two lines:

   ```sh
   git clone https://github.com/Davron2004/filmkit ~/filmkit
   sh ~/filmkit/setup.sh
   ```

   If macOS asks to install the "command line developer tools", click Install, wait until it
   finishes, then run the two lines again.
2. If setup says Node.js or ffmpeg is missing, it prints the exact commands that install them
   (Homebrew included). Run those, then run `sh ~/filmkit/setup.sh` again. Setup is safe to repeat.
3. When setup ends with `filmkit is ready`, quit Claude Code and open it again, so it loads the
   new skill.
4. Ask Claude, for example: "Film a short demo video of https://example.com showing how to sign up."
   Claude explores the site, writes the script, films it, and tells you where the video is. Videos
   are saved in `~/filmkit/out/`.

To update filmkit later: `git -C ~/filmkit pull && sh ~/filmkit/setup.sh`.

What setup does: checks for Node.js 20 or newer and ffmpeg, installs Playwright and its Chromium
inside the checkout (saying `ok` with the browser's path when it was already downloaded), links the `film-demo` skill into Claude Code (`~/.claude/skills/film-demo`, or
`$CLAUDE_CONFIG_DIR/skills/film-demo`; anything already there is moved to
`~/.claude/skill-backups/film-demo-<timestamp>`), and ends with `filmkit doctor`. It never installs system software on its own.

**Which browser films.** By default (`--browser auto`) filmkit films in ego-browser when it is
installed and running: your own browser, already signed in to your sites. Otherwise it films in
Playwright's Chromium, which starts signed out every time, and prints one line saying so. To film
pages you have to be signed in to, install ego lite (https://lite.ego.app/), sign in there, and keep
it open while filming.

## Install

`setup.sh` (above) does all of this for the web camera. By hand, from the checkout:

```sh
npm ci                                          # Playwright, for filming without ego-browser
node_modules/.bin/playwright install chromium   # its Chromium (~150 MB), once
node tools/doctor.mjs                           # per camera: ready or not, what's missing, the fix
```

The Android and iOS cameras need no npm install at all. `skills/film-demo/filmkit <command>` is the
launcher the skill uses, and it works from any directory and through a symlink: `web`, `android`,
`ios`, `tighten`, `timeline`, `hierarchy`, `scenario`, `explore`, `doctor`, `setup`, `detach` (runs
any of those in the background, see Running a camera from an agent shell) and `root` (prints the
checkout's path). It checks for Node.js 20 or newer first, adds Homebrew's bin directories to the
end of PATH when they're missing (the Homebrew installer leaves that step to you), and `exec`s the
script, so signals and exit codes are the camera's own.

External tools (all resolved PATH-first, then `$FILMKIT_<NAME>`, then known install locations:
Homebrew on Apple silicon and Intel, the Android SDK, `~/.maestro/bin`, and `~/.local/bin` for
`ego-browser`, where ego lite's setup links it). A missing one's error ends
with its install command:

- always: **ffmpeg**
- web camera, always: **ffprobe** (ships with ffmpeg). Preflight refuses without it, because the
  duration guard needs it
- web camera, filming in ego: **ego-browser**, installed and running. Optional: `--browser auto`
  (the default) uses it when it answers. A shell whose PATH lacks `~/.local/bin` (an agent's, or
  one opened before ego's setup edited your profile) still finds it there, and `doctor` says where
  it found it
- web camera, filming in Playwright: **playwright's Chromium** (via npm above). Playwright is
  loaded only when it films, so an ego run works with no `node_modules`
- web camera, `--scenario`: **`@playwright/test`** (or `playwright`) installed where the spec is
  written, usually the project under test. The load check and verify run that copy, not
  filmkit's
- Android camera: **adb**, **maestro**, optionally the **emulator** binary
- iOS camera: **xcrun** (macOS only), **maestro**

Env overrides: `FILMKIT_ADB`, `FILMKIT_EMULATOR`, `FILMKIT_MAESTRO`, `FILMKIT_FFMPEG`,
`FILMKIT_FFPROBE`, `FILMKIT_XCRUN`, `FILMKIT_EGO_BROWSER`. Defaults: `--avd` via `FILMKIT_ANDROID_AVD`, `--simulator` via
`FILMKIT_IOS_SIMULATOR`.

## The two-pass workflow

The camera only rolls on a compiled flow file, never on exploration.

1. Explore off-camera first. For a web flow, start with the project's own end-to-end specs,
   which already carry working `data-testid` selectors for the screens you're about to film, and
   confirm anything the specs don't cover (an unfamiliar route, a conditional element) with
   `snapshotText()` inside ego-browser, the same logged-in browser the camera will film in. Without
   ego-browser, or without the source, `tools/explore.mjs <url>` (see Inspection tools) lists every
   visible target on a page with a selector that matches only it, and saves a screenshot. For a
   mobile flow, `maestro hierarchy` dumps what the OS sees and `maestro studio` gives interactive
   probing. Either way, note what to click/type in what order, which selectors work, what to wait
   for.
2. Compile that step list into a flow file (examples below). Narration becomes captions or
   comments; actions become clicks/taps/types.

The flow file *is* the shot list: reviewable as source, deterministic to re-film. Flows written for
your own videos can live in `flows/` in the checkout, which is gitignored. When you're developing
filmkit, write down anything that went wrong or cost time during a filming run in `FEEDBACK.md`.
It's the running record of where the tool or its docs fell short.

## Web camera

```sh
node film-web.mjs examples/web/tip-demo.demo.mjs --tighten
```

Two cameras behind one flow API, chosen with `--browser`:

- `--browser auto` (the default) films in ego when `ego-browser` is installed and answers a quick
  round trip (`ego-browser nodejs`, up to 10s), and otherwise in Playwright, printing one line that
  says why and that the take starts signed out. If Playwright isn't installed either, it refuses
  before filming and names `setup.sh`. The sidecar records `backend` (what filmed),
  `backendRequested` and `backendNote` (why auto fell back, else null). For an ego that is installed
  but not answering, the note quotes the probe's own reason, the same words `doctor` prints: a 10s
  timeout, an exit code with what `ego-browser` said, or a failure to start. A flow made of selector
  strings films the same on both.
- `--browser ego` films inside your own already-running `ego-browser`, the
  Chromium fork that carries your real login profile. The take is a screencast pulled over CDP
  from inside that running app, so the tab shows up on your screen while it films, but nothing
  needs to actually be visible or in front for the recording to come out right. Occlusion
  doesn't matter. This is the camera for anything that needs to be signed in as you.
  Forced, it refuses before filming when `ego-browser` isn't installed (with the install link) or
  doesn't answer (open the ego lite app).
- `--browser playwright` is a throwaway headless Chromium: fast, sandboxed, no browser needs to
  be running first. It has no login of its own and starts every run from a blank profile, so
  reach for it for CI, retakes, and any target that doesn't sit behind auth. It records the same
  way as ego, from CDP screencast frames. (Playwright's own `recordVideo` dropped frames and gave
  takes 1-2s short about 1 run in 3.)

**Login.** Under ego the flow already runs signed in as you, in whatever session ego-browser
already carries. There's no `--storage-state` flag and none is needed. If the target needs a login,
sign in once inside ego-browser the ordinary interactive way before filming, and keep it open: the
take will already be authenticated. Playwright starts a fresh profile every run and cannot carry a
login at all, so without ego the flow has to sign in on camera.

A flow file default-exports `async ({ stage }) => { ... }`. The director API (`lib/stage.mjs`):

- `stage.open(urlOrPath, { readySelector?, timeoutMs?, settleMs?, cursorAt? })` loads an http(s)
  URL, a `file:` URL or a local file path (see Local files), optionally waits for a selector, and
  injects the overlay. Call it once, first. The take's first frame is the opening shot: the page
  loaded (the `load` event, and `readySelector` when given) with the cursor already in place. What
  came before is setup and is cut: the blank tab the camera parks on (a white flash on a dark app)
  and the page drawing itself in. Pages that load after a later click or `goto()` stay on film as
  they load. The cursor starts at the viewport center, which on a
  centered app lands on whatever the layout puts there; `cursorAt: target` starts it at that
  target's center instead, with no animation, so the opening frame shows it where the flow chose.
  tip-demo uses `cursorAt: 'h1'`: a heading is as wide as its card, so its center is the empty
  space beside the title. Check the opening frame; generate starts in the gap under its button
  instead, because its subtitle sits right under the heading.
- `stage.goto(urlOrPath, { readySelector?, timeoutMs?, settleMs? })` navigates again later in
  the same take. The overlay survives: it re-registers itself on every future document, so a link
  click or a `goto()` mid-flow doesn't lose the cursor or an open caption. The new page's first
  frame already shows them where they were (the caption with no fade), and a click that navigated
  finishes its ripple there, from where the old page last showed it.
- `stage.waitFor(target)` waits for something to be present and visible without pointing at or
  clicking it, for a beat that only needs the target on screen before the flow narrates over it.
- `stage.click(target)` animates the cursor to the target's center, dwells, shows a click ripple,
  then performs a real click.
- `stage.point(target)` does the same animation with no click and no ripple, for gesturing at
  something while narrating.
- `stage.type(target, text)` clicks into the target, selects any existing text, then types with a
  deterministic human-ish rhythm.
- `stage.caption(text)` and `stage.clearCaption()` show and hide the caption bar, fading in and
  out. It sits at the bottom edge, and moves to the top while the bottom would cover what the cursor
  is on (see Where a target is put). Every caption is also written to the take's `.srt`, and
  `--no-captions` keeps the holds but draws nothing (see Captions and subtitles).
- `stage.pause(ms)` is a plain beat.
- `stage.expect(target, { text?, timeoutMs? })` is a checkpoint. It waits for the target to be
  visible (and, with `text`, to contain it) without moving the cursor, and fails the take on
  timeout.
- `stage.oneOf({ outcome: target, … }, { name, timeoutMs?, accept?, filmAccept? })` is a branch
  point. It waits for whichever target appears first and returns its key. See Checkpoints and
  branch points.
- `stage.mode` is `'film'` on the camera and `'test'` in a scenario, for the rare flow that must
  behave differently under test.
- `stage.finish()` and `stage.abort()` end the take. A flow doesn't call these directly;
  `film-web.mjs` calls `finish()` when the flow returns and `abort()` if it throws.
- `stage.page` is the raw Playwright `Page` under `--browser playwright`, for anything custom
  (dialogs, uploads, network waits, `frameLocator` for apps that render inside iframes). Under
  `--browser ego` there is no Playwright object, so this is a small stand-in exposing only
  `evaluate(source)`, `waitForSelector(css, { timeoutMs })`, and `goto(url)`. Its `evaluate` follows
  Playwright's rules: a string is a JS expression whose value comes back (statements are allowed,
  a promise is awaited, a top-level `return` is an error), and a function is called with the one
  argument (`evaluate((n) => n * 2, 21)`). A flow that only ever calls `stage.page.evaluate(...)`
  works unchanged on both.
  The two `waitForSelector`s differ: ego's honours `timeoutMs`, while a real Playwright `Page`
  ignores it (its option is `timeout`) and waits 30s.
- `stage.timeline` holds every caption and pause this take authored, in recording-clock seconds.
  Read it after `finish()`; it's what gets written into the sidecar and what tighten protects.
- `stage.outcomes` holds every `oneOf()` this take ran (see Checkpoints and branch points).

**Where a target is put.** Before the cursor goes to a target (`click`, `point`, `type`), and in
`waitFor`, the stage makes sure the viewer can see it. A target already inside the comfort zone
(the viewport minus 24px at every edge, minus a 120px band at the bottom for the caption, minus the
caption wherever it is) is left alone. Any other target, whether below the fold, half off screen,
under the caption or clipped by a scroll pane, is scrolled to the middle of the viewport. On film
that scroll is animated: 450ms to 1.1s depending on distance, eased like the cursor, and finished
before the cursor moves. It works through nested scroll panes, and a page's own
`scroll-behavior: smooth` doesn't interfere. When no scroll can clear the caption (a fixed bottom
bar, or the last link on a page too short to scroll it up), the caption fades out, moves to the top
edge, and fades back in before the cursor moves, so the click and its ring are never under it. It
stays there until the next `caption()`, which starts at the bottom again unless that would cover the
cursor. Both backends and the scenario test share one implementation of this rule, so a target
lands at the same scroll position in all three. A `--no-captions` take keeps the 120px band (the
scenario test has it too, and it's where a player shows the subtitles) but has no caption to avoid
or move.

`click`, `point`, `type`, `waitFor`, `expect` and `oneOf` all auto-wait for their target: up to
10s for it to be present, laid out, and not hidden, before acting. A flow doesn't need a manual
sleep before a target that appears late. Pass `{ timeoutMs }` as the last argument to change the
budget for one call (a finite number above 0, no ceiling, else the call throws before touching
the browser):

```js
await stage.waitFor('.result', { timeoutMs: 120_000 });   // a slow generation
await stage.type('#prompt', 'a red bicycle', { timeoutMs: 30_000 });
await stage.click('button.done', { timeoutMs: 20_000 });
```

The budget covers the wait for the target only, not the cursor move or the keystrokes.

`target` is a CSS selector on both backends. A Playwright `Locator`, or a `(page) => Locator`
function for compound queries, works only under `--browser playwright`. `--browser ego` has no
Playwright object to build one from and rejects it. The one thing both backends understand beyond
a plain selector is Playwright's `:has-text("…")` pseudo-class, which `--browser ego` shims:

```js
stage.click('label:has-text("Tip %") input');
```

Both match `:has-text` case-insensitively, but only Playwright collapses runs of whitespace
inside the text first. The two backends also disagree on `opacity: 0`, which Playwright counts as
visible and ego as hidden.

**Checkpoints and branch points.** For an app whose result isn't deterministic (a generation that
may or may not build), `expect()` and `oneOf()` wait without moving the cursor, and the flow
branches in plain JS:

```js
await stage.expect('[data-testid=generating]', { text: 'Generating' });
await stage.clearCaption();   // before the wait: a caption up across it would protect all of it
const build = await stage.oneOf(
  { built: '[data-testid=preview]', failed: '[data-testid=build-error]' },
  { name: 'build', timeoutMs: 300_000, filmAccept: ['built'] },
);
if (build === 'built') await stage.click('[data-testid=publish]');
else await stage.expect('[data-testid=retry]');
```

- `text` is a string. Both sides have every whitespace run collapsed to one space and are
  trimmed, then the expected text must occur in the target's `textContent`: a case-sensitive
  substring, Playwright's `toContainText(string)`. That is a different rule from `:has-text`.
- `oneOf` probes the targets in declaration order, so a tie goes to the first one declared.
  `name` is required.
- `accept` (default: every key) is what counts as a pass anywhere. `filmAccept` (default: `accept`,
  and it must be a subset of it) narrows what the camera keeps. In the example a failed build
  fails the take so you film again, while a scenario run in CI passes either way. Set
  `accept: ['built']` if CI should fail too.
- On camera, an outcome outside `filmAccept` holds 1s, so the refusal is on film, then fails the
  take as `flow-failed` (a `.failed*` retake). A timeout fails it too, and the error lists what
  each target looked like at the end.
- Unknown option keys throw a `TypeError` before the browser is touched, so a misspelt
  `filmAccept` can't keep a take the flow meant to refuse. So do an empty `accept` or
  `filmAccept`, or one naming a key that isn't an outcome.
- Every `oneOf` lands in the sidecar's `outcomes`, `[{ name, outcome, options, accept, filmAccept,
  start, end }]` in seconds into the video, refused and timed-out ones included (`outcome: null`
  on a timeout). It is deliberately not part of `timeline`, so tighten can still cut the wait.
  Clear the caption before a long wait: a caption held across it is a protected range, and the
  wait stays in the take.

`examples/web/generate.demo.mjs` films this against `examples/web/generate.html`, which
"generates" for a random 2-6s and then picks a preview or a build error at random. To film one
outcome on purpose, add `?outcome=ok` or `?outcome=fail` to the flow's `PAGE` URL. An environment
variable wouldn't reach the flow under ego (see Under `--browser ego`).

**Local files.** A relative path in `open()` or `goto()` resolves against the flow file's own
directory, or against `--serve-root <dir>` when given. The file is served over http, not opened
from `file://`, so ES modules and same-origin fetches work. `--browser playwright` serves it at
`http://filmkit.localhost/<path from the root>`, a secure context. `--browser ego` starts a
loopback server for the run and serves it at `http://<token>.localhost:<port>/<path from the
root>`, where the token is 96 random bits and the port is ephemeral. That is a secure context
too, and a fresh origin per run, so each take starts with empty localStorage, service workers
and cache in your profile. Both serve at the origin root, so a root-absolute reference in a page
(`<script src="/app.js">`, `fetch('/data.json')`) resolves inside the serve root on every camera.

The ego server answers only GET and HEAD, only for its own host name, and only for a navigation
or a request from the served page itself (`Sec-Fetch-Site` `none` or `same-origin`). Another
page in your browser is refused even if it learns the URL. One gap is accepted: the filmed page
sends the host name in `Origin` to any server it calls, so a local non-browser server that page
talks to could read the root while the run lasts.

Both backends apply the same rules to what they serve. The serve root and the flow's path are
compared as real paths, so a root under `/tmp` or a symlinked checkout works. A path outside the
root is refused before anything navigates, and so is a symlink inside the root whose target is
outside it. In a request the page makes, `..` and `%2e%2e` segments are resolved inside the root
(a 404 if nothing is there), and leading slashes collapse (`//app.js` is `/app.js`), while `..%2f`
and a symlink out of the root are a 403. Opening a
directory, the root included, opens `<dir>/` and serves its `index.html`.
Every `open()` and `goto()`, local or remote, is judged by its own response: a 4xx or 5xx fails
the flow instead of filming an error page, and so does a network error such as a DNS failure.
Ego sends no request of its own before navigating, so a signed-in page that would refuse a
cookie-less request still films. Only a `file:` URL carries a `?query` or `#hash` onto the page.
In a bare path, `?` is part of the file name.

**Under `--browser ego`.** The flow runs inside ego-browser's own long-lived Node runtime, which
changes a few things you'd assume about a Node script:

- Environment variables from film-web's shell don't reach the flow. It sees the browser's
  environment, shared by every run and writable by any of them.
- The flow's working directory is `/`. Build paths from `import.meta.url`, as the examples do.
- The runtime's output is buffered, so the `[ego]` notes all arrive when the run ends, not live.
- Each run is a fresh module environment, so an edit under `lib/` takes effect on the next run
  with no restart. The runtime is reaped after a few idle minutes, so a changing pid is normal.
- Each run films in its own task space, named `filmkit <name> <6-char id>`, so a retake started
  right after a killed run never shares that run's tab.

Flags: `[--browser auto|ego|playwright] [--out <dir>] [--name <stem>] [--force] [--viewport <WxH>]
[--serve-root <dir>] [--tighten] [--min-still <sec>] [--keep <sec>] [--noise <level>]
[--crf <0-51>] [--no-captions] [--scenario [--scenario-dir <dir>] [--scenario-verify [--scenario-config <file>]]]`
(the scenario flags are under Scenarios). `--viewport` needs even dimensions (yuv420p cannot
encode an odd size) and rejects odd ones. Overwrite refusal mirrors the Android camera: an
existing `<name>.mp4` / `.json` / `-tight.mp4` / `.srt` / `-tight.srt` is never overwritten, and
the run refuses in preflight, before a browser is even launched, unless you pass `--force`. The
`-tight.mp4` and both `.srt` files count even without `--tighten` or captions, because a new take
replaces the whole previous one.

```sh
node film-web.mjs examples/web/tip-demo.demo.mjs --tighten --crf 16 --name take-2 --force
```

**Captions and subtitles.** Every take with at least one caption also gets its captions as a
SubRip file beside the video, `<name>.srt`, and a tightened take gets `<name>-tight.srt` for
`<name>-tight.mp4`. Each cue runs from its caption's fade-in to the end of its fade-out, in seconds
into that video, from the same timeline the sidecar lists. The `-tight` cues go through tighten's
own cut (frame for frame, not by adding up segment lengths): a caption cut away entirely is
dropped and one cut in part is clipped, and the console says so. Captions are protected ranges,
so that only happens to a hold tighten was not told about. A failed take's subtitles follow its
video (`<name>.failed.srt`); a take with no caption gets no `.srt`.

`--no-captions` films the same flow with nothing drawn: for a voiceover, for subtitles added in an
editor (import the `.srt`), or for a clean version. Every caption hold is still held, so the take
is paced like the captioned one, its `.srt` has the same times, tighten protects the same ranges,
and `--scenario` emits the same spec. What goes is only what kept a drawn caption out of the way:
the move to the top edge, so a take whose caption had to dodge a target is about 0.6s shorter per
dodge (two 280ms fades; measured on `example.com`'s "Learn more": 15.87s against 16.50s on
Playwright, 15.63s against 16.23s on ego). Takes without a dodge come out the same length (tip-demo:
25.80s both ways on ego). The cursor and the click ring are drawn as always. The sidecar says `captions: "hidden"` (else `"drawn"`).

```sh
node film-web.mjs examples/web/tip-demo.demo.mjs --no-captions --tighten
# out/tip-demo.mp4 + tip-demo.srt, out/tip-demo-tight.mp4 + tip-demo-tight.srt
```

**Statuses and failed takes.** The take is built as `<name>.partial.mp4` (tighten writes
`<name>.partial-tight.mp4`) and placed once its status is known, so nothing that ends badly
touches a take that is already there.

| Status | Cause | Files | Exit | Tightened |
|---|---|---|---|---|
| `ok` | flow ran to its end and every check passed | `<name>.*` | 0 | yes |
| `flow-failed` | the flow threw, including a `oneOf` outcome outside `filmAccept` | `<name>.failed.*` | 1, or the signal's (see Signals) | no |
| `failed` | the take is untrustworthy (see Checks) or assembly failed | `<name>.failed.*` | 1, or the signal's | no |
| `interrupted` | a signal arrived | `<name>.*` (`.failed.json` alone if nothing was filmed) | 130, 129 or 143 | no |

Failed takes are named as on the device cameras (see Failed takes in the Android section): the
next free `.failed`, `.failed-2`, and so on. `--force` on the web camera never replaces a good
take with a failed retake, which leaves the previous take byte for byte as it was. Only an `ok`
or `interrupted` take replaces the old one, through the same `.<name>.prev.*` stash as the device
cameras (see Failed takes in the Android section). With `--scenario`, an `ok` take whose scenario
fails to emit, load or verify stays `ok` and exits 2.

**Signals.** Ctrl-C (130), SIGHUP (129) and SIGTERM (143) stop the take, assemble the frames
filmed so far, write the sidecar with `status: "interrupted"` and exit with the signal's code. A
signal before filming starts exits at once, with a sidecar and no video. A take that had already
failed when the signal arrived (the flow threw, or a check failed) keeps that status and goes to
`.failed-N`, as on the device cameras. Its sidecar's `interruptedBy` names the signal, its `error`
ends in `; <SIG> was received while this failed take was being finished`, and the run exits with
the signal's code. The terminal prints the same note, in parentheses under the flow's stack. A signal after the flow finished lets the assembly complete, skips tighten and
marks the take `interrupted`. A second signal aborts the assembly. Under `--browser ego` the ego
runtime stops itself if `film-web` is SIGKILLed, so it doesn't keep driving your browser.

**Checks.** A take is `failed`, and says why, when the encoded file's duration is more than 0.25s
off the recording clock, ffprobe can't read it, a screencast ack failed, or the screencast had
stopped delivering frames before the take ended. That last one is a liveness probe: while capture
is still live, the backend changes one corner pixel at 2% alpha and waits up to 2s for a frame
stamped after the change (healthy takes measured 4-40ms). The probe's frame isn't recorded. It
catches a stall on any page, one that never changed again included, so a take like that is a
retake. When the probe can't run (the page wouldn't evaluate), the take is kept with a warning and
`method: "unverified"`. The older check, which compares the last frame with a screenshot of the
page (SSIM), is recorded beside it as `match` and `motion` but never decides: on a dense-text page
under ego a healthy take scored inside the range of stalled ones. An ack failure still fails the
take. The sidecar's `capture` key holds `{ ackFailures, stallCheck, rate, opening }`, and `stallCheck` is `{ method
('liveness' or 'unverified'), liveness: { ok, latencyMs, error }, match, motion, margin, error }`.

**The opening cut.** Once `open()` has the page loaded and dressed, the camera forces one fresh frame
(the same invisible corner pixel as the liveness probe) and drops every frame captured before it.
`capture.opening` is `{ state, dropped, latencyMs }`: `cut` with the number of setup frames dropped
(3-9 measured) and how long the fresh frame took (5-50ms). If no frame comes within 2s the state is
`abandoned`, nothing is dropped, the take opens on its setup, and the camera prints a warning: film it
again. `none` means `open()` never finished (a failed take keeps everything it filmed), and the key is
`null` on a take rebuilt from its frames after a crash.

**Slow capture** is a warning, not a failure. While the cursor moves, the stage redraws it every 40ms,
so a take should capture about 25 frames per second of cursor motion. Healthy takes measure 19-32 on
both backends, depending on the page: about 20 where only the cursor changes (each step is one frame,
and its round trips stretch it to ~50ms), more where the page animates under the cursor, like hover
transitions or a blinking caret (tip-demo 24-27, generate 30-32). A cursor move that goes nowhere,
like a `click()` right after a `point()` at the same target, paints nothing and isn't counted. Below
12.5 the camera prints `capture was slow` and sets `capture.rate.degraded`.
Motion then looks choppy and every action ran slow, so captions are held longer than written. The
first ego take after the runtime starts cold has filmed tip-demo this way (7 frames per second of
motion, 37.9s instead of 25.8s), and the next take films at full rate, so film it again. The take
stays `ok`, because its video and timeline still agree and only a person can judge whether the
footage will do. `capture.rate` is `{ motionFps, targetFps, warnBelowFps, degraded, moves,
framesInMotion, motionSec, plannedMotionSec }` on every take with frames, a failed or interrupted one
included (judged on the cursor moves that finished before it stopped). It's `null` only when no cursor
move finished on film: the flow never moved the cursor, or stopped before its first move ended.

The work directory (`$TMPDIR/filmkit-<name>-*`) is deleted once its frames are in a take. It stays,
and the sidecar's `workDir` names it, only when assembly itself failed or was stopped. A SIGKILLed
film-web can't clean up. It leaves its work directory and at most `<name>.partial.mp4` and
`<name>.partial-tight.mp4`, which the next run overwrites, a hidden tighten temp, which the next
tighten of that name removes (see Overwrite refusal under Tightening), or, if it was killed while
placing the take, a `.<name>.prev.*` stash that the next run restores or refuses over, as on the
device cameras. Nothing sweeps work directories yet (FEEDBACK #35).

**Determinism.** Every timing value (cursor-move duration, per-character type delay, dwell/
settle pauses) is a pure function of distance / text length / fixed constants in
`lib/stage.mjs`, never `Math.random()`. Re-filming the same flow reproduces the same
choreography every time.

**Click ripple.** Every `stage.click()` draws an amber ring at the click point, on by default.
The cursor's own press-shrink is a couple of pixels of movement at 1280x720 and doesn't read on a
re-encoded frame, so the ripple is what actually shows a viewer where and when a click landed. A
page that a click replaces stops painting once the next one takes over, so the ring is handed to the
next page, which plays the rest of it from where the old page last showed it. Until the new page first
paints (its stylesheets, a slow script in its head) the browser holds the old page's last frame, so on
a slow navigation the ring pauses there and then continues; it never jumps ahead or vanishes.
The cursor, caption and ring are reset against the page's own CSS (`all: initial`), so a site that
styles every `svg` or `div` can't move them: example.com's `svg` margin had painted the arrow 44px
above its click.

**Sidecar.** Every run that gets past preflight writes `<name>.json` (or `<name>.failed[-N].json`)
next to the video: `status`, `ok`, `error`, `interruptedBy` (the signal on an `interrupted` take
and on a failed one it landed on, else null), the backend used, the flow's path and SHA-256, argv,
viewport, `serveRoot` (where local files were served from), `crf`, `filmkit`, `captions`
(`"drawn"`, or `"hidden"` under `--no-captions`), the recording's `clock` (`frame` on both
backends, since timestamps come from real captured frames), `output.durationSec`, `output.srt` and
`output.tightSrt` (the subtitle files written, else null), the full caption/pause `timeline`, `outcomes` (`[]` when the flow has no
`oneOf`), `capture`, the `tighten` result when `--tighten` was passed, and `scenario` with
`--scenario` on an `ok` take. Key-by-status table: `film-web.mjs` header.

## Android camera

```sh
# whatever is already running, flow does everything (launchApp etc.):
node film-android.mjs my-flow.yaml --tighten

# explicit device control:
node film-android.mjs my-flow.yaml --device <serial>
node film-android.mjs my-flow.yaml --avd Pixel_9_Pro_XL          # boots headless if none running
node film-android.mjs my-flow.yaml --install app-release.apk --app com.example --fresh --tighten

# a storyboard's takes, filmed straight into its own layout, never overwriting each other:
node film-android.mjs shot-10.yaml --out demo/raw/10-fork --name take-2 --size 960x2136

# fail the run if anything else comes to the foreground mid-take:
node film-android.mjs shot-10.yaml --guard-app com.example
node film-android.mjs shot-10.yaml --guard-app com.example --guard-strict   # and stop the flow there
node film-android.mjs shot-6.yaml --guard-app com.example \
  --guard-allow com.google.android.apps.nexuslauncher   # this shot deliberately shows home
```

Tap indicators are burned into every take by default; pass `--no-show-taps` to film without them
on purpose. See the Tap indicators section.

Pipeline: preflight → device (including the size probe) → install/fresh → record (segment chain) →
maestro → stop → pull → stitch (or, for a run that fits in one segment, a plain remux) → [tap burn
and crop] → [tighten] → sidecar. Details that matter:

- **Naming and takes.** Output is `out/<flow>-android.mp4` by default. `--name <basename>` sets the
  stem instead (`<basename>.mp4`, `<basename>-tight.mp4`, `<basename>.json`) and `--out <dir>` sets
  the directory. An existing output is never overwritten, and that includes a `-tight.mp4` when
  this run has no `--tighten`. The run refuses in preflight, before the device is touched, unless
  you pass `--force`. Filming is a repeated activity, and a clobbered take is gone.
- **Failed takes.** Every final status except `ok` and `interrupted` steps the take aside, through
  `lib/takes.mjs` (Android: `truncated`, `interloper`, `taps-missing`, `flow-failed`, `failed`,
  `error`; iOS:
  `flow-failed`, `taps-missing`, `finalize-failed`, `error`; web: `flow-failed`, `failed`).
  `<name>.mp4` becomes `<name>.failed.mp4`, `<name>-tight.mp4` becomes `<name>.failed-tight.mp4`,
  and the sidecar is written as `<name>.failed.json`. So `ls *.mp4` shows only real takes and the
  take number is free for a retake with no `--force`. A second failure goes to `.failed-2.*`, then
  `.failed-3.*`, and never overwrites an earlier one, `--force` or not. Only files written by this
  run move, so a failure under `--force` can't relabel an older good take. An `interrupted` take
  keeps its plain name because it's a salvage, so retaking it needs `--force`. A device-camera run
  that dies before anything was filmed moves nothing and writes no sidecar.

  Under `--force`, a failed retake keeps the previous take on all three cameras. The device
  cameras stash it as `.<name>.prev.*` once setup has passed, just before recording, and the web
  camera stashes it only when it places an `ok` or `interrupted` take. An `ok` take, or an
  `interrupted` one that saved a video, replaces the whole old take, its `-tight.mp4` included.
  On every camera an `interrupted` take counts only if nothing had failed before the signal. A
  signal that lands after the take's failure was already decided (the flow failed; on Android also
  a truncated, interloper, taps-missing or geometry verdict; on web also a failed check) leaves the
  take as that failure: it goes to `.failed-N`, the sidecar's `error` ends in `; <SIG> was
  received while this failed take was being finished`, `interruptedBy` names the signal, the
  previous take comes back, and the exit code is the signal's. Any other exit puts the previous
  take back, and so does a signal during setup or, on the device cameras, one that arrives before
  the flow's first command ran. A crash (SIGKILL) leaves the stash on disk. The next run restores
  it, or, if a new take already sits at the plain name, refuses and names both takes and the
  command that keeps each.

  ```sh
  ls out/*.mp4            # real takes only
  ls out/*.failed*.mp4    # the casualties, kept for debugging
  ```
- **`screenrecord` runs with `--verbose`,** on every run, with or without tap indicators. It costs
  nothing on the recording and buys the tap ripples their anchor: the "Content area is..." line it
  prints is the reference point every tap time and every tap coordinate is placed against (see Tap
  indicators below). The size checks read the same line. It is probed for
  before use, so an older `screenrecord` without the flag still films, just with a less precise
  anchor and a warning saying so. The line is only trusted if it arrives within 2s of spawning
  the recorder; a later arrival means this device is buffering `adb shell`'s stdout instead of
  streaming it line by line, so the camera falls back to spawn time plus 400ms instead and notes
  the fallback, per segment, in the sidecar's `tapSync`.
- **Flows longer than 180s.** `adb shell screenrecord` hard-stops at three minutes, so a longer
  flow is filmed as a chain of segments. Each records with `--time-limit` (`--segment-seconds`,
  default 170, floor 5, ceiling 180), and the next starts the instant the previous recorder exits.
  The segments are stitched into one file (ffmpeg concat demuxer, stream copy, `+faststart`). A flow
  that fits in one segment usually gets a plain stream-copy remux instead. Two cases go through the
  concat step anyway: a static single segment (see "Static segments are held"), and one whose slot
  was extended because its successor was lost.
- **The seam, and where the time actually goes.** Measured on the tall AVD (1144x2546) by filming
  a running stopwatch in 8s segments, a seam costs two things, and nothing on screen during either
  is filmed:
  - The handover, from one recorder stopping to the next one's first frame: 0.36-0.59s at steady
    state, and 1.57-1.81s while maestro's JVM was starting and loading the host. The stitched
    timeline drops this, so the clock on screen jumps across the seam. A tap that lands in a
    handover still gets its ring: it starts on the next segment's first frame, which shows what the
    tap did, and the sidecar's `taps[].seamShiftSec` says how late (`tapSync.seamShiftedTaps`
    counts them). Only a tap in footage that's really gone (a lost segment, before the recording,
    past its end) goes undrawn.
  - The unwritten tail: a time-limited segment's footage ends 0.7-1.1s before its limit does.
    Those are the frames the encoder still held when the recorder hit its limit. The segment keeps
    its full slot, so this shows as its last frame held. A running stopwatch froze for 1.15s,
    then jumped 0.45s.

  The last recorder no longer loses its tail at the stop: see **The tail hold** below. The
  durations line accounts for all of it. Ten 8s segments of 88.98s wall stitched to 80.13s.
  Seams land at deterministic offsets, so a shot that must not be cut can be kept inside one
  segment by choosing `--segment-seconds`.
- **The tail hold: the flow's last moments are on film.** screenrecord never drains its encoder:
  stopping it (SIGINT or its own time limit) throws away the frames it still holds. On the tall
  AVD's software encoder that queue is ~19 frames, so the loss is its depth over the encoder's
  throughput: a stopwatch lost 1.54-2.23s with maestro running, full-screen motion 6.05-7.54s.
  Every take used to lose that much of the flow's end whenever the screen was still moving. Now,
  once the flow ends on its own (green, failed, or stopped by `--guard-strict`), the recorder keeps
  rolling while the camera watches the encoder's CPU (`media.swcodec`). The hold ends when the
  encoder has gone idle (`drained`, 0.5-2.8s measured on flows that end on a still screen), or at a
  10s cap when the screen never stops moving (frames 5-9s past the flow's end reached the file in
  every measured case). Neither the hold nor what it films is in the take: the take is cut at the
  flow's end, its last frame held to it. The one exception is a frame a backlogged encoder composed
  late, which can only be the flow's own final state. When the encoder can't be watched (a hardware
  encoder, which is not measured) the hold is a fixed 2s. A segment that reaches its own limit
  during the hold ends it (`rollover`: that seam's tail is lost as at any seam; the run warns when
  that segment's last frame doesn't prove it got past the flow's end, i.e. when `covered` is null).
  The sidecar's `recording.tailHold` records `endedBy`, `holdSec`, `flowEndSec`, `takeEndSec`,
  `heldSec`, `covered` and more. `covered` is false when the encoder was still behind at the cap
  and frames were lost, which the run warns about, or when the segment recording at the flow's end
  was lost (`flowSegmentLost` names it). A signal mid-flow still stops at once, with no hold.
  tighten needs nothing special: the pinned end is a still like any other.
- **A recorder that dies after the flow is not a truncation.** If the recorder dies on its own
  during the tail hold (`endedBy: "recorder-gone"`), the whole flow already happened while it was
  rolling, so the take is judged on what was written up to the flow's end. A recorder that stopped
  cleanly keeps its file and the take is `ok`; if it wrote no frame past the flow's end, `covered`
  is null and the run warns, as for a rollover. A recorder killed outright (SIGKILL) leaves no
  readable file, so the segment that was recording at the flow's end is lost and the take is
  `truncated` by that loss, without the "rest of the flow is NOT on camera" claim. Its `error` and
  the run's last line say how the recorder died and when (`seg005 ended unexpectedly: the recorder
  was killed on the device by SIGKILL (exit 137) after 7.42s (limit 10s), 0.46s after the flow had
  ended (in the tail hold)`), what became of its file (`was pulled but has no readable container
  (no moov atom)`, or `could not be pulled (there was no file on the device)`), and how much of
  the flow is missing, apart from the tail hold, which the take never owed (`6.96s of the flow is
  missing from the take, and the 0.46s of tail hold it filmed after it`). With a single
  segment there's nothing left to stitch and the take fails, with `recording.truncated: false`
  (that key describes the delivered video, and there is none), an `error` that names the lost
  segment and how its recorder ended, and a last line `there is NO TAKE — ...` with the sidecar's
  path and the kept maestro debug directory. `tapsExpected` is still read off Maestro's record.
  Segments are kept only when footage is missing, so an `ok`
  take still cleans up. A recorder that dies before the flow ends still truncates the take, as
  before. The death is printed once as it happens, as a plain fact (`seg006 ended unexpectedly:
  the recorder was killed on the device by SIGKILL (exit 137) after 3.73s (limit 10s) — the chain
  stops here`), and judged once after the pull, when it's known whether the file survived: "not a
  truncation" only when it did, otherwise "the death cut nothing off the flow, but it left no
  usable file", followed by what that cost.
- **A bad segment costs only itself.** Every pulled segment is checked before it enters the
  stitch, and lands in one of three classes. Usable: readable, with a duration and packets.
  Static: readable, exactly one packet and no duration, from a recorder that ended the way ours
  do (exit 0 after its full time limit, or our own SIGINT). Dead: unreadable, no packets, or one
  packet from a recorder that crashed. The drop reason says what the file is (empty, no moov atom,
  no packets, or not on the device to pull, in adb's own words) and how its recorder ended:
  stopped by us, killed on the device (an exit of 128+N, like 137 for SIGKILL), or failed on its
  own (any other exit, with screenrecord's own "recorded N frames" when it printed one). Every
  line that describes a recorder's end uses those same words: the per-segment line as the chain
  runs, the chain's abort, the drop reason and the sidecar's `error`. An empty trailing dead segment that filmkit stopped within 3s of
  its start is dropped with a note, and nothing is missing. A recorder that died on its own is
  never that, however short its life, because the flow was still running: its segment is lost
  footage, `lostSec` counts it, and the take is `truncated`. A dead segment anywhere else is real
  lost footage too: the take is stitched from what survived, named as truncated, and the run
  exits non-zero with the file kept. One bad segment never costs the other N-1. Nothing is
  deleted quietly either: when a run ends unclean (a lost segment, a recorder that died on its own,
  a signal, a stitch that didn't check out) the pulled `.<name>.<run>.segNNN.mp4` files stay on
  disk, the run prints where they are (dot-prefixed, so use `ls -a`), and `keptFiles.local` names
  them. `<run>` is the run's UTC start, like `20260929-234714`, and every file a run keeps
  for you carries it: the segments, the maestro debug spill and the failed startup attempts. A
  later run never deletes another run's files. The device's own copy of a segment
  (`/sdcard/filmkit-<name>-<run>-segNNN.mp4`) is removed on every path once it has been pulled and
  the local copy matches its size, because the local copy is then the same file. An empty file
  counts too when both sides really say 0 bytes (a recorder that hung before its first write).
  Only a segment that couldn't be pulled, or whose copy couldn't be verified, stays on the device.
  The run prints it with the reason, and `keptFiles.device` in the sidecar names it until you
  remove it.
- **Static segments are held, not dropped.** A recorder watching a screen that never changes writes
  one frame and a track whose only sample has zero duration: readable, with a moov atom, one packet
  and `Duration: N/A`. The same file comes from a recorder that ran its full 170s and from one
  stopped after 0.3s, so it is footage (a generation wait is exactly this case). A missing moov
  atom is what a SIGKILLed recorder leaves, not this. The segment's own frame is held for its slot,
  the run prints `static segment held`, the sidecar lists it in `recording.staticSegments`
  (position `first`, `middle`, `final` or `only`, plus wall and held seconds), and the status stays
  `ok`. A final static segment is listed twice in the concat list, the first time with the hold,
  because the concat demuxer ignores `duration` on the last file. Only a segment that ended some
  other way with one packet counts as lost. A segment whose successor was lost keeps its full slot,
  so timing before the gap stays honest (20s of wall used to stitch to 5.96s), though the take is
  still `truncated`. On an emulator with Wi-Fi on, an idle screen emits identical frames about
  every 10s, so a still shot is easier with Wi-Fi off.
- **The stitch trusts the wall clock, not the files.** A screenrecord mp4 does not know how long it
  recorded. It is variable-frame-rate and emits no frame at all while the screen is still, so its
  own duration is wrong in both directions. On one run, segments of 20.1s wall time claimed 34.0s,
  6.0s and 5.6s. filmkit times each segment itself and hands the concat demuxer explicit `duration`
  directives instead. Packet timestamps confirm it: every seam lands on its intended offset and the
  stitched stream stays monotonic. The reasoning is in `film-android.mjs`'s STITCHING header. Read
  it before touching that math.
- **A take with no pinned end ends where its recorder did.** When a signal, a dead chain or an
  unexpected error ends the take, there's no tail hold to pin its end, and the last segment used to
  play to its container's end. The muxer makes up the last frame's duration, so a take recorded for
  25.32s came out 26.11s long, its last frame held 0.79s past the recording. Now that last packet's
  duration is set so the file ends at the recorder's stop, in the same stream copy: every frame is
  byte-identical, only that one duration changes (that take: 0.884s became 0.037s, file 25.263s).
  A static last segment is held to the same point, and a segment whose successor was lost doesn't
  run past its own recorder either. A file that ends short of the recorder's stop (frames it never
  wrote) is left alone, and an `ok` take, whose end is pinned by the tail hold, is unaffected.
- **And the stitch is checked, not assumed.** ffmpeg reports a scrambled concat as a warning and
  still exits 0, so filmkit scans the concat's stderr for `Non-monotonic DTS` and compares the
  finished duration against the timeline the directives planned. Either one off prints a loud
  warning and lands in the sidecar's `stitch` block.
- **The output is VFR — seek and cut accordingly.** Device recordings emit no frames while the
  screen is still, so `-ss 344 -i take.mp4` lands on the next emitted frame (seconds late) rather
  than the requested time. Resample before cutting:
  `ffmpeg -i take.mp4 -vf "fps=30,trim=start=352:end=367,setpts=PTS-STARTPTS" …`. When a speed
  change is in the filter, bound the segment with output `-t (B-A)/sp`, not `-to`: `-to` is
  evaluated after the filter, so a `/8` output clock never reaches the stop point and the segment
  runs long. A truncated take's video timeline is discontinuous (a dropped middle segment jumps
  wall time with no frames in between — see the seam offsets in the sidecar).
- **`--size <WxH>`.** Many emulator AVDs ship an AVC encoder that cannot be configured at native
  resolution. `screenrecord` says `unable to configure video/avc codec at 1344x2992 (err=-22)` and,
  without `--size`, silently records 720x1280, which breaks a capture set that has to intercut. On
  the tested 1344x2992 AVD the encoder caps the height at 2560, so native isn't filmable. `--size`
  pins the geometry at the device's aspect. Raise `--bit-rate` alongside it.

  ```sh
  node film-android.mjs shot-10.yaml --size 1080x2404 --bit-rate 12000000
  ```

  The camera probes the encoder before it installs, clears or films anything (a throwaway 1s
  `screenrecord --size` at the run's `--bit-rate`). With no `--size` it tries native in the current
  orientation, else walks down same-aspect sizes (long side -2% per rung, both sides even) and takes
  the largest one the encoder accepts and that needs at most a crop: 1144x2546 on the tall AVD, 8
  probes, 6.5s. There is no per-device cache, because the limit moves with the emulator image, GPU
  mode and density. An explicit `--size` is probed in the same phase, so a refusal costs no take. A
  malformed value, an aspect more than 1% off the device's, or a size the encoder refuses aborts
  before the flow runs and names the largest usable size (`--size 720x1280` on a tall device used to
  film with bars). A probe that fails without an answer (no codec refusal, no clean exit; seen once
  as a transient `exit 235`) is asked again, 3 attempts 2s apart. If it still can't answer, the run
  stops there with "the recorder's size probe isn't answering ... rerun": exit 1, nothing filmed, no
  take, no sidecar. It used to film anyway, at native, which on a device that refuses native meant a
  silent 720x1280 fallback and a failed take. Each run probes into its own
  `/sdcard/filmkit-size-probe-<run>-<pid>.mp4` and removes it after each probe, so two runs sharing a
  device can't delete each other's probe file (the shared fixed name did, and that was a cause of
  the inconclusive probes). A run starts by removing probe files left by runs whose pid is dead,
  and the old fixed-name file unless a recorder is writing it. The choice and every probe attempt are in the sidecar
  (`recording.pinnedSize`, `recording.sizeProbe`; each row has an `attempt`, and `retries` counts the
  repeats), and the console prints the walk as one `size probes: ...` line.

  Accepted doesn't mean filled. `screenrecord` letterboxes with float arithmetic, so an accepted
  size can carry a black bar 1-2px wide (1144x2546 records content 1143x2546, 1080x2404 records
  1079x2404). Only exact multiples of the reduced aspect fill, which on the tall AVD is 672x1496,
  half the resolution. So the camera keeps the largest accepted size and crops the bar in the tap
  burn's filter graph, which adds no encode (a take with no rings gets the same pass with zero
  rings). 1143x2546 becomes a 1142x2546 take (even size at an even offset, for chroma). More than
  2px short is a real letterbox and is refused. A take that ends without its finishing encode (a
  signal, or an unplanned error) still gets the crop. The camera rewrites the H.264 stream's own
  display crop in a stream copy: lossless, frame-identical to decoding and cropping, and well under
  a second. So an `interrupted` take has no bar either. The sidecar has `recording.crop` (`method`
  is `encode` or `stream-copy`, and `error` says why a salvage crop couldn't be applied).
  `actualSize` is the recorded size and `deliveredSize` is the file you get.

  Two checks after the fact always fail the take (status `failed`), `--strict-size` or not: the
  file's aspect differs from the device's (the silent fallback), and a segment's content area is
  more than 2px short of its video. `--strict-size` now covers only a right-shaped size that isn't
  the size asked for (the pinned size, else native). `recording.sizeCheck` holds the verdicts. The
  recorder's stderr is echoed as `[screenrecord] segNNN: ...`.
- **Tighten knobs.** `--tighten` forwards `--min-still`, `--keep` and `--noise` to `tighten.mjs`
  (defaults 1.2s / 0.6s / `auto`), so `--keep 2.0` needs no second command. Same flags on iOS and web.
- **`--crf <0-51>`** sets the quality of every re-encode the run does (default 18). See Encode
  quality under Tightening. It is recorded as `crf` in the sidecar and forwarded to tighten. Stream
  copies ignore it.
- **Head/tail and target.** Every run prints where the recorded time went, and the parts add up:

  ```
  durations: recorded 37.05s = 1.50s warmup + 33.92s flow + 1.62s tail hold + 0.00s stop; file 35.37s = recorded - 0.06s before the first frame - 1.62s after the take's end (the tail hold and the stop, cut); then 2.0s finalize wait (not recorded)
  ```

  Startup retries and seams get their own terms when a take has them. The flow term includes
  maestro's JVM startup, and the finalize wait comes after the recorder stopped, so it isn't in
  the recording. One take tells you your overhead for duration-constrained shots. `--trim-head <sec>` / `--trim-tail <sec>` cut that off the stitched
  file before taps are placed (VFR-safe re-encode; tap times shift with it). `--target-duration
  <sec>` only reports how far off you landed.
- **`--guard-app <pkg>`, the foreground watchdog.** A flow only knows what its selectors can see,
  and "covered by another app" satisfies most of them. `extendedWaitUntil: { notVisible: "Building…" }`
  returns COMPLETED the moment a neighbouring app draws over the screen, so a take can end on
  someone else's login screen with every step green and this tool printing a duration and exiting
  0. That has happened, and it cost a four-minute generation. Maestro cannot notice it; filmkit
  owns the recorder, so it is the only layer that can.

  Name a package to guard with `--guard-app <pkg>`, or just `--app <pkg>` if you were already
  passing it for `--fresh`, and the whole recording window is sampled every 1.5s via
  `dumpsys activity activities | grep topResumedActivity`. Before rolling it also checks who is in
  front and **warns** if it isn't the guarded app; only warns, because a flow's own `launchApp` is
  entitled to fix that a second later. If anything else takes the foreground during the take you
  get `[foreground] INTERLOPER <pkg> at <t>s` on the spot, a summary block after the flow, `status:
  "interloper"` in the sidecar, a non-zero exit, and no `-tight.mp4` (a polished variant beside a
  dead take is exactly how the original one looked finished). The recording is **not** killed;
  the footage is yours to judge, and the raw `.mp4` is written as usual. `--guard-strict` inverts
  that when a dead take isn't worth the wall clock: the flow is SIGINT'd on the spot and the
  partial take is pulled, stitched and saved through the ordinary path. Measured: 0.19s from
  sighting to the recorder stopping. A clean take's summary counts rows by kind: allowed system
  surfaces, the home screen before the app first came up, sightings under the app while its own
  `launchApp` restarted it, and stretches where the foreground couldn't be read. The live `back to <app>` line prints only when the app returns after something
  else. A move between the app's own activities is a `foreground` row, not a line.

  What counts as an interloper is deliberately narrow, because `topResumedActivity` tracks
  *activities* and most system chrome is made of *windows*. Measured on an Android 17 emulator:
  opening the notification shade leaves `topResumedActivity` on the app and only moves
  `mCurrentFocus` to `Window{… NotificationShade}`; the IME behaves the same way. Neither can
  produce a false positive here at all, so the allowlist only names system surfaces that really are
  activities: SystemUI's own, the runtime-permission dialog, and the IME packages for devices that
  might route one through an activity. The launcher is not on it, because home showing means your
  app got backgrounded, which is the failure. Until the guarded app has been in front once,
  though, the device's home screen counts as `home-before-app`: logged, allowed, and never an
  interloper, since an app can't be backgrounded before it was ever up. That is the state
  `--fresh` leaves, so `--fresh --app <pkg>` with a flow that starts with `launchApp` films
  cleanly. The home package is resolved on the device and recorded as `guard.home` (null if it
  can't be resolved, and then there's no exception). The app's own relaunch is the other exception.
  `launchApp` stops an app that is already in front, and whatever is underneath surfaces until it
  is back, typically the previous task, not the launcher: 620-731ms after the command started,
  measured. A sighting inside a `launchApp` of the guarded app, as maestro.log records it, plus
  1.5s after the command ends, is `relaunch`: logged, allowed, never an interloper. If the app isn't
  back by then, the same screen is an interloper at the next sample, with `firstSeenSec` saying
  when it really appeared. A Home press or another app at any other time is an interloper as
  before. The bare `android` package isn't on the
  allowlist either, because that's where the share sheet and the ANR dialog live. If your flow
  opens a share sheet on purpose, don't pass a guard package for it. If your shot deliberately
  backgrounds the app (a kill-to-home persistence proof), pass `--guard-allow <pkg>` (repeatable)
  for that run — it adds to the allowlist without changing the default.
  An unreadable sample (screen off, an activity transition caught mid-dump) is recorded as
  `unknown` and never counts as an interloper; a run of five in a row says so, because a watchdog
  that has quietly stopped watching is worse than none.
- **Seams are surfaced.** The sidecar's `recording` block carries `seamOffsetsSec` (e.g.
  `[170.0, 340.0]`, `[]` for a single segment) plus a `wallMap` of wall→video offsets per
  surviving segment, and multi-segment runs print the offsets on the console. A dropped middle
  segment prints `seg002 dropped — video jumps from wall ~170s to wall ~340s` in words, not just
  `"truncated": true`. Use `node tools/timeline.mjs <take.mp4>` to check a seam against the
  moment (below).
- **Provenance sidecar.** Every run that reaches the camera writes `<name>.json` next to the video:
  `ok` plus a `status` (`ok`, `truncated`, `interloper`, `taps-missing`, `flow-failed`,
  `interrupted`, `failed`, `error`), the `error` that produced it, flow path and SHA-256 of its
  contents, argv, device serial and build fingerprint, the display's orientation
  (`device.orientedSize`, `device.rotation`), bit rate, each segment's wall/container/timeline
  durations, whether it was dropped or held static and why, recorder warnings, the stitch's
  planned-vs-actual check, raw duration, the `--tighten` result under `tight` (`detectFrom`,
  `detectMode` and `protected` alongside the cut itself; the iOS sidecar carries the equivalent
  under `tighten` instead), and any files a failed run left behind. `output.path` and `tight.path`
  name the `.failed*` files after a rename. Every tap indicator drawn lives in `taps` (position in
  output pixels, seconds into the video), alongside `tapSync` (which anchor the times were
  converted against and why), `showTaps` (whether indicators were drawn; `showTapsRequested` says
  whether they were asked for), and `tapsExpected`
  (whether Maestro's own execution record says the flow was owed any). A guarded run adds
  `foreground`, one row per change of foreground app timestamped from the moment the recorder
  started, so it lines up with the video itself. An undisturbed take contributes exactly one row.
  `flowSucceeded: true` alongside `status: "interloper"` is the whole failure mode in two fields.
  It is written on the failure paths too, so a `demo/raw/` tree still explains itself months later,
  when two takes turn out to have come from different revisions of the same flow. A run that dies
  in preflight, device setup or the size probe writes none, and neither does one a signal stops
  before the flow's first command ran. Nothing was filmed, and an earlier take's sidecar must not
  be clobbered by a run that never rolled. Once a command has run, a take whose harvest saved no
  video is still a failed take with a sidecar, and its `output.path` is null.

  Keys added for the fixes above, uniform across the device cameras unless noted:
  - `filmkit`: `{ commit, branch }` of the filmkit that filmed the take, or `null`. It's the
    commit only: uncommitted edits don't show, so it never says "clean". `branch` is null on a
    detached HEAD, and the whole key is null for a vendored copy, an unborn branch or a reftable
    repo. It's read from `.git` with no git binary, and always describes filmkit's own checkout,
    never the flow author's project.
  - `crf`: the quality of every re-encode the run did.
  - `interruptedBy`: the signal's name on an `interrupted` take, and on a failed one whose failure
    was decided before the signal arrived, else null. The web sidecar has the same key and rule.
    An `interrupted` take's `error` is `interrupted by <SIG>`.
  - `flowLint`, `branches` and `scenario`: see Maestro flow idioms and Scenarios.
  - `maestroRetries`: `[{ reason, atSec }]`, one per startup retry, `[]` if maestro came up first
    time (`atSec` is seconds into the video). On iOS each entry also has `reaped`, the number of
    stale `xcodebuild` runners killed before that retry.
  - `durations`: `flowSec` is the last maestro attempt's own time and `retrySec` is the failed
    startups plus backoff before it. It sits at the top level on iOS, with just those two keys.
    On Android it sits under `recording` and is the console's durations line as numbers:
    `{ recordingWallSec, warmupSec, retrySec, flowSec, holdSec, stopSec, unrecordedSec, headSec,
    seamSec, lostSec, tailSec, trimmedSec, overhangSec, finalizeSec, fileSec }`. Every take that
    has a file gets them, including one a signal or an unexpected error ended (`flowSec` then ends
    when the stopped maestro exited). No term is ever negative, and two sums hold exactly, in the
    printed and the recorded numbers alike. Each sum is rounded as a whole by largest remainder:
    the total and the file's length are rounded once, the other terms are rounded down, and the
    leftover hundredths go to the terms with the largest fractions. So a term can differ from its
    own rounding by 0.01s, but the line always adds up (rounding each term on its own used to leave
    sums 0.01s off, like 1.50 + 24.61 + 1.08 = 27.19 against `recorded 27.20s`).
    First, where the wall clock went: `recordingWallSec` = warmup + retry + flow + hold + stop -
    unrecorded. `recordingWallSec` runs from the first recorder's start to the moment the last one
    ended, `holdSec` is the tail hold after maestro's exit (0 without one) and `stopSec` the rest up
    to the recorder's end. `unrecordedSec` is how far the camera's phases ran past that end, with
    no recorder rolling: the chain died mid-flow and maestro ran on, or a signal stopped the
    recorder a moment before maestro exited. It's 0 otherwise, and `stopSec` is 0 when it isn't.
    For example, `recorded 111.91s = 1.50s warmup + 131.57s flow + 0.00s stop - 21.16s after the
    recording had ended (not filmed)`. Second, what reached the file: `recordingWallSec` = head +
    seam + lost + tail + trimmed + file - overhang. `fileSec` is the written file's length, the
    same number as `output.durationSec`. The 60fps finishing encode (the tap burn, or the crop's
    pass) ends the file on a whole frame, up to half a frame either side of the take's planned end
    (313.407s planned, 313.400s written), and `tailSec` takes that difference. `headSec` is the
    first recorder's start-up, `seamSec` the handovers the timeline dropped (see The seam), `lostSec` the wall of segments that held no
    usable video (the line names them), `tailSec` the wall after the take's end (the tail hold and
    the stop, cut; after a lost trailing segment, the handover into it; otherwise, the frames the
    last recorder never wrote) and
    `trimmedSec` the `--trim-head`/`--trim-tail` cut. `overhangSec` is how far the file runs past
    the recording's end, and is 0 in practice: it's only ever a last frame that the video-zero
    estimate (about ±40ms) or the finishing encode's frame grid places after the recorder stopped,
    which is kept rather than cut. When a signal's take gets its rings in a second pass, the
    durations are recomputed against that file and printed again as `durations (with the rings
    drawn): ...`.
    `finalizeSec` is the wait after the recorder stopped, outside both sums.
  - `tight.durationSec` (Android) and `tighten.fileDurationSec` (iOS) are the written `-tight.mp4`'s
    own length, which the console's `tightened A -> B (N cuts, X removed)` line quotes too. `A` is
    the cut take's own length, read the same way (to the millisecond with ffprobe, else from
    ffmpeg's banner), and tighten returns it as `inFileDurationSec`. `X` is `A - B`, so the line
    adds up; it's `tight.removedSec` (Android) and `tighten.fileRemovedSec` (iOS). The plan
    (`plannedDurationSec` and `plannedRemovedSec`, or `tighten.outDuration` and
    `tighten.removedSec`) is off by under a frame per kept segment whose edge falls between two
    frames (see the tighten section's "The numbers add up").
  - Android `recording`: `pinnedSize` (what screenrecord was given, null for native),
    `sizeProbe` (`native`, `requested`, `chosen`, `pinned`, `source` as `native-accepted`, `probed`,
    `explicit-verified` or `skipped-no-native-size`, `crop`, `probeCount`, `retries`, `elapsedSec`,
    and `probes[]` with each attempt's `size`, `attempt`, `accepted`, `fit`, `content` (the
    reported content area), `exitCode`, `elapsedMs`, `note`), `sizeCheck`
    (`expected`, `actual`, `aspectOk`, `sizeMatch`, `contentArea`, `contentFits` as fill, crop,
    letterbox or unknown, and `delivered`), `crop` (`w`, `h`, `x`, `y`, `contentArea`, `reason`,
    `applied`, or null), `staticSegments`, `tailHold` (see The tail hold), and `deliveredSize`
    beside `actualSize`. Each entry of `recording.segments` has a `static` flag. `foreground` rows
    have a `verdict`: `guarded`, `allowed`, `home-before-app`, `relaunch`, `interloper` or `unknown`.
  - `output.fps` and `output.encoder`: the burn's (or iOS's hold encode's) own when one made the
    take, otherwise read off the file, on both cameras. So an `interrupted` take's or a failed
    take's sidecar isn't blank (iOS: `simctl recordVideo h264 (High)`, Android: `screenrecord h264
    (...)`, with the low average fps of variable-frame-rate footage).
  - The status `error`, on both cameras: an unplanned throw after the recorder started. The
    camera stops maestro and the recorder, salvages what was filmed, steps the take aside and
    puts a `--force` stash back.
  - iOS: `ok`, `error`, the status `finalize-failed`, and `delivered.heldTail` (`windowSec`,
    `finalizedSec`, `pinnedSec`, `heldSec`), how far past its last change the take holds (see
    Held tail in the iOS section). `delivered` has the same shape on every take with a file,
    `heldTail` included, whether or not an encode ran (`interrupted` and `flow-failed` too).
- **Every recording carries a head and a tail you didn't author.** 1.5s of warmup so the recorder
  is really running before Maestro's first tap, Maestro's own JVM startup (4-6s here), and the
  tail hold plus the stop after the flow ends (those two are cut from the take). The 2s finalize wait that lets the
  on-device mp4 close cleanly comes after that and isn't recorded. Measured: a flow whose only
  authored hold was 20s came out as a 30.4s recording. Budget it on duration-constrained shots.
  The durations line (Head/tail and target) tells you your own number.
- `--fresh` runs `pm clear` right before recording → beat 0 is a true fresh first run.
- SIGINT (not SIGKILL) stops `screenrecord`. That's what makes the on-device mp4 finalize instead
  of truncating. The tool handles this; don't "fix" it to SIGTERM.
- **Signals salvage the take.** Ctrl-C (130), SIGHUP (129, what a dying shell sends) and SIGTERM
  (143) all stop the recorder, pull, stitch, write the sidecar with `status: "interrupted"` and
  exit. Without it a dying shell left a live `screenrecord` on the device and no take. The camera
  also stops the maestro child (SIGINT, then SIGKILL after a grace period) and waits for it, so the
  flow can't keep running against a device nothing records. After a hangup every console write
  fails, so it silences its own stdout and stderr errors at start-up. SIGQUIT and SIGKILL still
  kill it outright. A signal mid-burn SIGTERMs that encoder (SIGKILL if it lingers), and one
  mid-tighten aborts tighten, which kills its ffmpeg and removes its temp file, so an interrupted
  take never has a partial `-tight.mp4`. The taps that happened still get their rings, in a
  second pass that starts only after the take and its sidecar are saved (the sidecar's
  `tapSync.error` says the rings are still coming, and the sidecar is rewritten when they land).
  The pass is the ordinary burn, so it takes about 0.4x the take's length (22s for a 53s take). A
  second signal skips it, and the take stays as saved, without rings, with `tapSync.error` saying
  why. A SIGKILL during it can't cost the take either: the saved take and sidecar stay, plus the
  burn's dot-prefixed temp file, `.<name>.taps-<pid>.mp4`. The next run of the same name removes
  that temp at its start once the pid in its name is dead, and leaves one whose pid is alive (a
  concurrent run may be writing it). A flow the camera stopped leaves no usable `commands-*.json`
  (none at all, an empty one, or one cut off mid-write), so every touch is drawn as a plain ripple
  (a long press can't be told from a tap), and the run says so as a note, not a warning:
  `maestro was stopped (SIGINT) before it finished writing its command record (commands-(flow.yaml).json
  is empty)`. Only a maestro that ended on its own without a usable record gets the warning. An
  interrupted take ends at the encoder's last written frame, so
  a tap in the last second or two before the signal, on a still screen, can fall past its end. That
  tap isn't drawn, and the run says so. The same second pass runs after an unexpected error. A signal before the flow's first command ran (the warmup,
  maestro's JVM starting, a startup retry's backoff) films nothing: the recorder is stopped, this
  run's segments and debug spill are removed, and the run exits 130, 129 or 143 with no take and
  no sidecar, putting a stashed previous take back (it used to be Node's default death). A signal
  that lands while a failed take is being stepped aside waits up to 10s for that to finish: the
  failed take keeps its `.failed-N.json`, the previous take comes back, and the exit code is the
  signal's. A signal after a failure was decided but before its exit ran (during the burn or
  tighten, say) is the same: the take keeps its failed status rather than becoming `interrupted`
  (see Failed takes). See Running a camera from an agent shell.
- **Maestro startup retry.** `maestro test` can fail before running anything with
  `io.grpc.StatusRuntimeException: UNAVAILABLE` (maestro.log adds "Not able to reach the gRPC
  server"). On Maestro 2.6.0 it doesn't follow a clean `maestro hierarchy` (about 40 runs) but does
  follow a maestro killed uncleanly mid-start (about 75% of rounds), and the driver then stays
  unreachable for about 25s. So the camera runs a bounded loop inside the same take: when maestro
  fails with that signature and no command ever ran (per `commands-*.json`), it restarts the flow
  after a 5s backoff, at least once, and starts no attempt once 45s have passed since the first
  failure ended. The recorder keeps rolling, and tighten or `--trim-head` cuts the extra static
  head. Any other failure, or one after a command ran, is never retried, so a flow that already
  tapped never runs twice. Each retry lands in `maestroRetries`. Failed attempts' logs move to
  `.<name>.<run>.maestro-attempts/` (removed on success, kept on failure) so the tap parser only
  sees the last attempt.
- **`--debug-output` is always on.** Both device cameras pass it to maestro on every run, with or
  without `--no-show-taps`, because the retry check and the tap parser read `maestro.log` and
  `commands-*.json` from it. The directory, `.<name>.<run>.maestro-debug`, is deleted when the
  run succeeds and kept on any failure (the sidecar's `debugOutput` names it). On Android that
  includes a take that fails after a green flow (`interloper`, `truncated`, `failed`): only an
  `ok` take deletes it.
- A failed flow still saves the partial recording for debugging (exit code stays non-zero). So
  does a recording that ends early, one interrupted by a signal, and one that lost a segment. If a
  segment dies on its own, the chain stops instead of respawning forever, names the segment and
  its wall time, and exits non-zero rather than reporting a truncated take as a success.

### Maestro flow idioms (hard-won)

- **Pause primitive.** Maestro has no fixed-duration sleep. A pause is an optional wait on a marker
  that never appears: it blocks for the full timeout, and `optional: true` keeps the exit code 0.
  Use the marker `__filmkit_demo_pause_marker__`, the only one the scenario wrapper and the flow
  lint recognize.

  ```yaml
  - extendedWaitUntil: { visible: "__filmkit_demo_pause_marker__", timeout: 2000, optional: true }
  ```
- **Gate pauses on `FILMKIT_MODE`.** The cameras always pass `-e FILMKIT_MODE=film`, and the
  scenario wrapper (see Scenarios) runs the flow with `FILMKIT_MODE=test`. A pause inside a `when:`
  on `!= 'test'` holds when filming and when the variable is undefined (a flow run by hand), and is
  skipped in test mode, where it would only be dead time. A skipped gate costs 0.3-0.8s.
  `timeout: 0` is no substitute: it costs one failed poll (1-2s) per pause.

  ```yaml
  - runFlow:
      when: { true: "${FILMKIT_MODE != 'test'}" }
      commands:
        - extendedWaitUntil: { visible: "__filmkit_demo_pause_marker__", timeout: 2000, optional: true }
  ```

  Never put `FILMKIT_MODE` in a flow's header `env:`. Precedence is flow header `env:`, then
  `runFlow` `env:`, then `-e`, so a header value pins the mode and defeats the wrapper.
- **Back-to-back waits share a clock.** Measured on Maestro 2.6 (iOS 27 and Android 17 agree): a
  wait's deadline counts from the start of the previous wait that ended unmatched, until something
  resets it. Every pause ends unmatched. `waitForAnimationToEnd`, `tapOn`, `evalScript`,
  `runScript` (and a gate whose body ran one of them) reset it. `assertVisible`, `takeScreenshot` and a
  skipped gate don't, and a wait that matched doesn't affect the next one. Two consequences:
  - A pause directly after a pause is cut to about 0.3-0.6s (3s then 3s: the second held 321ms on
    Android, 602ms on iOS).
  - A real wait after a pause loses the pause's time. A 20s non-optional wait after a 3.4s pause
    failed at 16.8s, and a wait no longer than the pause fails at once. A 120s wait after a 5s
    pause still gets about 115s.

  Put a reset between them:

  ```yaml
  - extendedWaitUntil: { visible: "__filmkit_demo_pause_marker__", timeout: 2500, optional: true }
  - waitForAnimationToEnd          # resets the clock; without it the next pause holds ~0.4s
  - extendedWaitUntil: { visible: "__filmkit_demo_pause_marker__", timeout: 1600, optional: true }
  ```

  An earlier version of this README said waits are cut to ~7-8s after `launchApp` and to ~0.5s
  inside `repeat:`. That did not reproduce (120s non-optional waits after `launchApp` held to the
  element or the full timeout on both platforms), and it is most likely this effect: those waits
  followed another wait. Check a long hold against the recording (the sidecar keeps the raw
  duration) before relying on a workaround.
- **Flow lint.** At preflight both device cameras warn about a wait that directly follows another
  wait with nothing that resets the clock. The lint never refuses a take, and the warnings land in
  the sidecar as `flowLint: [{ line, message }]` (omitted when clean). It doesn't read inline
  `commands: [...]`, `repeat:` bodies, included files or `assertVisible` with a timeout. On iOS
  the prefix is `[film-ios]`.

  ```
  [film-android] ⚠️  flow lint (line 27): pause on line 27 directly follows the wait on line 21 with nothing between them that resets Maestro 2.6's wait clock, so its timeout is counted from the start of the previous wait: it holds only max(~0.4s, timeout - the previous hold), not the time written. Put `- waitForAnimationToEnd` ...
  ```
- **`runFlow: { when: … }` scripts through a screen that may or may not appear** (an LLM clarify
  step the server sometimes skips). The blocks that ran are recorded in the sidecar's `branches`.
- **`notVisible` is satisfied by being covered.** Every wait that ends on something *disappearing*
  also ends when another app draws over the screen, and the flow reports COMPLETED either way. This
  is not fixable in the flow. Pass `--guard-app <pkg>` so the recorder notices instead.
- **Relative selectors resolve to the first hierarchy match, not the nearest element.**
  `tapOn: { text: ".*", below: { text: ".*\\?" } }` finds the first tappable thing under the first
  question — useful when every label is generated text. The mirror image does not work: anchoring
  `above:` a fixed bottom line lands on the header Back button, the first node in the tree above
  the anchor.
- **`hideKeyboard` is safe on native screens, back-navigation in a WebView.** On the host app's own
  screens it dismisses the IME and stays put. On a WebView screen the same command can leave the
  app entirely, losing typed state.
- **A control's accessible name can carry its state.** A `Drink water` checkbox becomes
  `✓ Drink water` once ticked, and since `text:` is a whole-string regex, the first-half selector
  silently stops matching. Anything surviving a state change wants `.*Drink water.*`.
- **`text:` must match the WHOLE string — wrap substrings in `.*….*`.** `visible: "Steep time"`
  never matches a node rendering "Steep time (seconds)"; use `".*Steep time.*"`. Same class of
  silent mismatch as `inputText` appending below.
- **Selectors.** Visible text or accessibility labels (what `maestro hierarchy` reads), never
  coordinates. Debug with `maestro hierarchy` (see `tools/hierarchy.mjs`).
- **Replace text cleanly.** `inputText` APPENDS at the cursor; `eraseText` is unreliable in
  WebViews (controlled inputs re-render a stray leading char that later keystrokes never
  overwrite). The clean gesture is
  `longPressOn` → tap `"Select all"` → `inputText`. `doubleTapOn` selects nothing in many
  WebViews.
- **`swipe` percentages must be integers.** `start: "23.4%,44%"` fails Maestro's parser outright
  (`Parsing Failed at ...`, with no hint what's wrong). Use integer percentages or absolute pixels
  like `"310,1306"`, which is also more precise for a specific point.
- **Don't drive a WebView number field with adb keyevents.** `KEYCODE_DEL`, `MOVE_HOME`/`END` and
  `CTRL+A` produced garbage (`190` became `10180`, then `1080`). For a slider-backed value, tap the
  track directly, which sets it exactly.

See `examples/android/example-flow.yaml` for all three in context.

## iOS camera

Same DSL as Android (flows port by changing `appId` and platform-specific selectors):

```sh
node film-ios.mjs my-flow.yaml                                    # uses whichever sim is booted
node film-ios.mjs my-flow.yaml --simulator "iPhone 16 Pro"        # boots it if needed
node film-ios.mjs my-flow.yaml --install build/MyApp.app --app com.example \
     --fresh --clean-status-bar --tighten
```

Notes:

- **Simulator only.** Filming hardware iPhones needs a different capture path entirely, and this
  tool doesn't attempt it.
- **Naming, output, and overwrite refusal match the other cameras.** `--name <stem>` sets the
  output stem instead of `<flow>-ios`, `--out <dir>` sets the directory, and an existing take
  (`.mp4`, `.json` and `-tight.mp4`, the last even without `--tighten`, because a new take
  replaces the whole previous one) is never overwritten. The run refuses in preflight, before the
  simulator is even touched, unless you pass `--force`.
- **Failed takes are stepped aside** exactly as on Android (statuses `flow-failed`, `taps-missing`,
  `finalize-failed`, `error`). `error` is an unplanned throw after the recorder started: the camera
  still salvages and writes the sidecar. Under `--force` the previous take is stashed as
  `.<name>.prev.*` before recording and restored if the new take fails, and an `ok` or
  `interrupted` take replaces it. A flow that had already failed when a signal arrived stays
  `flow-failed`, with the signal noted in `error` and `interruptedBy`, the previous take comes
  back, and the exit code is the signal's. A crash leaves the stash, and the next run restores it,
  or refuses if both takes exist. What a run keeps for you carries its `<run>` stamp, as on
  Android: the raw `.<name>.<run>.raw.mp4` when finalize fails, the debug spill and the failed
  startup attempts. A later run never deletes another run's files.
- **`--crf <0-51>`** (default 18) sets the quality of the software re-encodes: the tighten cut,
  the finalize fallback and the burn's software encoder. The VideoToolbox burn is
  bitrate-controlled and ignores it. Recorded as `crf` in the sidecar. See Encode quality below.
- `--fresh` uninstalls the app (the only true data wipe on iOS) and therefore requires
  `--install` to bring it back.
- `--clean-status-bar` overrides the clock to 9:41, full battery and signal, and clears the
  override after the run.
- No 180s cap here (unlike Android). Recording writes straight to disk on the host.
- **The output is VFR — seek and cut accordingly.** Like Android, `simctl` emits no frames while
  the screen is still, so `-ss` before `-i` lands on the next emitted frame rather than the
  requested time. Resample first: `-vf "fps=30,trim=start=A:end=B,setpts=PTS-STARTPTS"`. With a
  speed filter in the graph, bound with output `-t (B-A)/sp`, not `-to` (evaluated post-filter).
- Boot readiness uses `bootstatus -b`, since a bare "(Booted)" status can precede Springboard
  being ready.
- **Recorder timestamp repair.** `simctl`'s mp4 sometimes carries composition offsets that put
  its first DTS well below zero (measured -5.473s, -5.237s, -2.903s on affected takes, -0.12s on
  a healthy one), and ffmpeg derives its playback timeline from those DTS values, not from the
  container's own PTS. On one 42s take, 421 of its 604 frames came out mistimed and the decoded
  timeline stepped backward 5.457s in the middle of an app-launch animation. Finalizing now
  passes `-fflags +igndts` on the input, so the stream copy trusts PTS and discards the bad DTS
  entirely, and the fix is baked into the shipped mp4, not left for a reader to apply. It applies
  to both `--codec h264` and `--codec hevc`: hevc is affected worse, dropping 11 of 399 frames
  outright on one unrepaired take. The sidecar's `ptsRepair` block (not `timeline` — tighten.mjs
  reads a top-level `timeline` array off this sidecar as protected ranges, so that name belongs
  to it) reports how many frames went in and came out (`sourceFrames`, `framesAfterRepair`), how
  many needed moving (`framesRetimed`), and the muxer's own harmless retimestamp nudges
  (`muxerDtsWarnings`); `framesRetimed: 0` means this particular take's timeline was already
  sound.
- **Phantom tail trim.** `simctl` can stamp a recording's final sample with a duration that runs
  seconds past the point the camera was actually stopped (measured 9.698s on a 31.82s take, 9.3s
  past the SIGINT that ended it). Ordinary playback and ffprobe ignore that stamp, but the tap
  burn's constant-rate re-encode honours it and bakes the overrun in as a frozen tail. So once
  indicators are burned, film-ios trims the output back: a pinned take to its pin (see Held tail),
  an unpinned one (a failed flow, an interrupted take) to the finalized take's own length, within
  one frame. The cut can only ever remove time that was never filmed. What it did, or why it
  didn't, goes in the sidecar's `delivered` block.
- **Held tail.** `simctl` writes a frame only when the screen changes, so a take that ends on a
  held beat has no frame for it, and the finalized file stops at its last change. Measured on the
  example flow: the takes ended 1.6-1.9s after the last tap though the flow holds at least 2.8s
  after it, 2.5-5.5s short of the time the camera rolled. So every `ok` take is pinned to the
  longer of the recorder's window (Recording started to SIGINT) and the finalized file's duration:
  the last frame is held until the camera stopped, since no frame means nothing changed. The burn
  does it, and a take with no rings (no tap logged, or `--no-show-taps`) gets the same encode with
  none drawn. If that encode fails, the take is kept unheld with a warning. A failed flow and an
  `interrupted` take aren't held and end at their last change. If they tapped, they still get
  their rings, from an unpinned burn that is cut back to the finalized length (an unpinned burn
  cut to the recorder window used to end 0.2s past the last change while saying it held nothing).
  The sidecar's `delivered.heldTail` is `{ windowSec, finalizedSec, pinnedSec, heldSec }` on every
  take with a file (`pinnedSec` null and `heldSec` 0 for a take that wasn't pinned, which is then
  true of the file to within one frame). Under
  `--tighten` the frame-exact pre-burn file is shorter than the take by exactly `heldSec`, so the
  camera declares the hold to tighten, which expects that difference and analyses the held tail
  like any other hold.
- **Signals.** SIGINT (130), SIGHUP (129) and SIGTERM (143) stop the recorder, restore the
  status-bar override, finalize what was filmed and write a sidecar with `status: "interrupted"`
  (with `durations` and `delivered`, like any other take). A burn caught mid-encode is discarded,
  and the take is saved without rings first. Then a second pass draws the rings for the taps that
  happened and rewrites the sidecar, exactly as on Android: a second signal skips it, and a SIGKILL
  during it leaves the saved take plus `.<name>.taps-<pid>.mp4`, which the next run of the same name
  removes once that pid is dead. The camera also stops the maestro child and waits for it, so the
  flow can't keep tapping an unrecorded simulator. A second signal during the save is a no-op. A signal during the
  burn SIGTERMs that encoder (SIGKILL if it lingers), and during `--tighten` it aborts tighten, so
  no partial `-tight.mp4` is left. Signals before the recorder rolls wait for an override in
  flight, clear it, restore a stashed previous take, and exit with no take and no sidecar. So does
  a signal before the flow's first command ran: the recorder is stopped, the status bar restored,
  and this run's raw and spills removed. A signal during the warmup or between maestro attempts
  parks the run so the handler owns the exit code. A signal during a failed take's step-aside
  waits up to 10s for it, as on Android, and a signal after the flow failed (during the burn, say)
  keeps the take `flow-failed` instead of salvaging it as `interrupted`.
  Measured without the SIGHUP handler (pty closed 30s into a take): no `.mp4`, no sidecar, the
  status-bar override left on, and the next recording refused with "Host recording is already in
  progress" (cause inferred, not isolated). See Running a camera from an agent shell.
- **Maestro startup retry.** Same bounded loop as Android (5s backoff, 45s budget, at least one
  retry, only when no command ran; each retry in `maestroRetries`, failed logs in
  `.<name>.<run>.maestro-attempts/`). The iOS signature is the XCTest driver's startup timeout
  (`IOSDriverTimeoutException`, "iOS driver not ready in time", after about 90s). It appears only
  on maestro's stderr, never in `maestro.log`, so the camera pipes stderr through and checks it. A
  failed attempt leaves `xcodebuild test-without-building` alive for 60-90s, which wedges the next
  attempt, so before each retry the camera kills the stale runners for this simulator only
  (matched by `-destination id=<udid>`, so another agent's maestro is untouched) and records the
  count as `reaped`.
- **"Host recording is already in progress."** Killing `simctl`'s recorder uncleanly wedges the
  simulator until it's rebooted. If the recorder has exited by the end of the warmup, the camera
  stops before the flow, prints the recorder's stderr, restores the status bar, sweeps its empty raw
  file and spill, and exits 1 with no sidecar. For this wedge it prints the remedy, which it never
  runs: `xcrun simctl shutdown <udid> && xcrun simctl boot <udid>`.
- **Settle before you tap.** Maestro reads the hierarchy, then taps that point a moment later, so
  a row that appears in between shifts the list and the ring shows the tap landing on a neighbour.
  In `examples/ios/example-flow.yaml` Settings inserts a banner a second or two after it first
  renders, and `tapOn: "General"` missed in about half the takes. `waitForAnimationToEnd` on both
  sides of a 2.5s dwell fixed it (6 of 6 takes landed, against 2 of 4). A bare
  `waitForAnimationToEnd`, or the old 1.8s dwell, still missed.
- Tap indicators are burned into every take; see the Tap indicators section.

## Scenarios

`--scenario` turns a filmed take into a CI test, on every camera. The test is generated glue that
runs the flow file itself with the choreography turned off, not a script recorded from the take.
So there is one source of steps and nothing drifts, and a flow that branches (`oneOf` on web,
`runFlow: when:` on mobile) is tested on whichever branch the app takes in CI.

Rules shared by all cameras:

- Only a take that ends `ok` emits. A failed emit, load or syntax check, or a red verify keeps the
  take `ok` and exits 2. Exit 2 means the take is fine and the scenario isn't.
- Generated files start with an `@filmkit-generated` marker line. A marked file is rewritten on
  every run without `--force`. An unmarked file at that path is never touched, `--force` or not,
  and preflight refuses before anything is filmed.
- `--scenario-dir <dir>` writes the files there instead of next to the flow, creating the
  directory if it doesn't exist. `--scenario-verify`
  runs the scenario once right after filming. It is opt-in because it repeats the app's side
  effects (paid generations, database writes), and it never retries. Neither modifier works
  without `--scenario`.

### Device cameras (Maestro)

After an `ok` take, the camera writes `<flow-stem>.scenario.yaml` next to the flow (or into
`--scenario-dir`), a thin wrapper that runs the filmed flow under `FILMKIT_MODE=test`. The flow's
header needs a literal `appId`.

```sh
node film-android.mjs flows/checkout.yaml --fresh --app com.example \
  --scenario --scenario-dir tests/e2e --scenario-verify
node film-ios.mjs flows/checkout.yaml --fresh --install build/MyApp.app --app com.example --scenario
```

- Every path in the wrapper is relative to the wrapper's own directory: the `runFlow` file, the
  header's flow, and the `# run:` line, which is run from that directory. A wrapper in another
  tree gets a `../` chain rather than an absolute machine path, so it survives a clone. When that
  chain would climb through the directory above your home (a wrapper in `/tmp`, a flow in `~`),
  the header's flow reads `<filmkit>/…` or `<flow-dir>/…` instead. The `runFlow` file keeps its
  chain, because it has to resolve, and when it leaves the wrapper's project (the nearest
  `package.json` or `.git` above it) the camera prints a warning and records it in
  `scenario.warnings`: the wrapper only runs on this machine. Keep the flow inside the project.
- `--scenario-verify` runs the wrapper on the same device. It wipes app data when the wrapper has
  `clearState`, and it is capped at 3x the filmed flow time plus 60s.
- `--fresh` becomes `clearState`, plus `clearKeychain` on iOS. On iOS Maestro's `clearState`
  reinstalls the app that is installed now (not the build under test) and fails on a system app
  ("Uninstall prohibited"). `--install` and `--clean-status-bar` are not carried, and the header
  and sidecar say so.

```yaml
# @filmkit-generated scenario v1. flow ../../flows/checkout.yaml sha256 3f9c… · filmkit d7fe63f · filmed ios, --fresh
# branches filmed: seq7 "visible: .*quick thing.*" SKIPPED · filming pauses: 38s skipped in test mode, 0s paid
# not carried: --install, --clean-status-bar
# run from this file's directory: maestro test --include-tags filmkit-scenario --format junit --output report.xml .
appId: com.example
name: checkout (filmkit scenario)
tags: [filmkit-scenario]
---
- clearState
- clearKeychain
- runFlow:
    file: ../../flows/checkout.yaml
    env: { FILMKIT_MODE: test }
```

The tag is what keeps CI from running the flow twice (once bare, once through the wrapper), so run
it with the include. From the project root that is:

```sh
maestro test --include-tags filmkit-scenario --format junit --output report.xml tests/e2e/
```

A flow that already carries `filmkit-scenario` makes the emit fail.

**Mode gates.** The cameras always pass `-e FILMKIT_MODE=film`. Gated pauses (see Gate pauses on
`FILMKIT_MODE`) are held when filming and skipped in the wrapper. A test-only assertion gates the
other way:

```yaml
- runFlow:
    when: { true: "${FILMKIT_MODE == 'test'}" }
    commands:
      - assertVisible: "Order confirmed"
```

**Sidecar.** `branches` lists every `runFlow: when:` block and whether it ran, so the wrapper header
can say which paths the take filmed. A block that reads `FILMKIT_MODE` carries `modeGate: true` and
is left out of the header's list. The key is written with `--scenario`, and without it only when
the flow has a `when:` that isn't a mode gate. `scenario` records what was emitted and checked;
its `wrapper` is the wrapper's absolute path.
`pauseSec` counts authored pause timeouts from the flow text (pauses in `runFlow: file:` includes
aren't counted).

```json
"branches": [
  { "seq": 7, "when": "visible: .*quick thing.*", "status": "SKIPPED", "atSec": 41.2 },
  { "seq": 9, "when": "true: ${FILMKIT_MODE != 'test'}", "modeGate": true, "status": "COMPLETED", "atSec": 44.0 }
],
"scenario": {
  "wrapper": "/Users/you/app/tests/e2e/checkout.scenario.yaml",
  "preconditions": ["clearState", "clearKeychain"],
  "notCarried": ["--install", "--clean-status-bar"],
  "pauseSec": { "skippedInTest": 38, "paidInTest": 0 },
  "warnings": [],
  "checkSyntax": { "ok": true, "output": "OK" },
  "verify": { "status": "passed", "durationSec": 41.7, "error": null }
}
```

`verify` is `null` without `--scenario-verify`, and its status is `passed`, `failed`, `timeout`,
`interrupted` or `error`.

### Web (Playwright Test)

```sh
node film-web.mjs demo/checkout.demo.mjs --scenario --scenario-dir tests/e2e
npx playwright test checkout.scenario.spec.mjs
```

After an `ok` take the camera writes two files next to the flow, or into `--scenario-dir`:

- `<stem>.scenario.spec.mjs`, the spec. `<stem>` is the flow's file name without its extension
  and without a `.demo` suffix (`checkout.demo.mjs` gives `checkout.scenario.spec.mjs`), whatever
  `--name` the take used: the spec belongs to the flow, not to one take.
- `filmkit-stage.mjs`, the test-mode stage, one per directory and shared by every spec in it. It
  is a copy of `lib/scenario/filmkit-stage.mjs`, rewritten on every emit, and it imports only
  `node:` built-ins, so the spec runs in a project that has `@playwright/test` and no filmkit.

The spec imports `@playwright/test`, or `playwright/test` if only that resolves from the spec's
directory at emit time. It imports the flow file and runs it under `createTestStage()`, pins the
filmed viewport with `test.use({ viewport })` (which overrides the project config's), and attaches
`stage.outcomes` as `filmkit-outcomes` (JSON) in a `finally`, so a failed run still says which way
the app went. Its header records the flow's SHA-256, the filmkit commit, the take and the outcomes
it filmed, how to regenerate it, and how to run it: `npx playwright test <spec file name>`.
Playwright reads that name as a pattern over test paths, so the same command works from the
project root and from the spec's directory.

Every path in the spec is relative to the spec's own directory, so it survives a clone. The
regenerate commands are run from that directory. They carry `--scenario-dir` and a `--serve-root`
that isn't the flow's directory (the `--from` form takes the root from the sidecar), and the
filming form also carries the take's `--browser`, `--out`, `--name` and `--viewport` when they
aren't the defaults, so running one rewrites this same file. Flags that change only the video
(`--tighten`, `--crf`, `--no-captions`) aren't carried: test mode draws no caption, so a captioned
and a caption-free take of one flow emit the same spec. In the header (the flow, the take, the
regenerate commands), a path the spec can only reach through `/` or the directory above your home
(a spec in `/tmp` for a flow in `~`, filmkit checked out elsewhere) is written against a named
place instead, since a `../` chain would spell out the machine's layout, your username included:
`<filmkit>/…` for a file in the filmkit checkout, `<flow-dir>/…`, `<take-dir>/…`, or `<serve-root>`.

The flow import and the serve root have no such fallback, because they have to resolve. When either
leaves the spec's project (the nearest `package.json` or `.git` above the spec), the emit prints a
warning and records it in the sidecar's `scenario.warnings`: the spec then runs only on this
machine, and a clone or CI checkout fails to load it. The exit code doesn't change. Keep the flow
and its serve root inside the project, and emit the spec from there.

**The four kinds of step.** Test mode runs the same flow with the choreography off:

| Step | On film | In the scenario |
|---|---|---|
| action: `open` `goto` `click` `type` `waitFor` | animated cursor, then real input | the same real input with no animation, through the code `--browser playwright` films with |
| choreography: `caption` `pause` `point` | drawn, held, cursor moves | `caption` prefixes step titles and draws nothing; `pause` is skipped; `point` still moves the real mouse, so hover menus open as they did on film |
| checkpoint: `expect` | waits, no cursor; a timeout fails the take | the same wait and text rule; a timeout fails the test with the camera's message |
| branch point: `oneOf` | waits, logs the outcome; outside `filmAccept` fails the take | the same wait; outside `accept` fails the test at once, naming the branch point and the outcome |

`accept` decides pass or fail in both modes. `filmAccept` is only the camera's, so a flow with
`filmAccept: ['built']` films only successful builds and still passes CI on a failed one. Each
`oneOf` adds a `filmkit-outcome` annotation (`build=built`). Each action, checkpoint and branch
point is one step titled `<caption> › click <target>`, located at the flow file's own line, so a
failure points at the flow, not the spec. Playwright's HTML report shows those locations; its JSON
reporter omits them.

**Timeout.** The test timeout is 3x the filmed take plus 60s, because Playwright's 30s default
kills any flow that waits on a generation. A spec emitted without a take assumes a 180s take,
so 600s.
`FILMKIT_TIMEOUT_MS` overrides it.

**Environment.** The spec reads three variables:

- `FILMKIT_BASE_URL` rebases the filmed origin (the origin of the flow's `open()`) onto another,
  path prefix included, for a staging host or a preview deploy. `https://app.example.com/dash`
  under `FILMKIT_BASE_URL=https://preview.example.dev/pr-7/` loads
  `https://preview.example.dev/pr-7/dash`. `open()` and `goto()` calls to other origins are left
  alone.
- `FILMKIT_PAUSE_SCALE` replays `pause()` and the `open()`/`goto()` settle beat: unset or `0`
  skips them, `1` holds them at filming pace, `0.5` at half. Use it to diagnose a flow that used a
  pause as a wait. The cursor animation and typing rhythm are never replayed. A value that isn't a
  number of at least 0 throws a `TypeError`.
- `FILMKIT_TIMEOUT_MS`, above.

**Auth.** The spec gets whatever `storageState` the project's Playwright config provides. filmkit
never exports ego-browser's cookies, because that would write your personal session next to files
that get committed. CI should sign in as a test account. An ego take was filmed signed in, and its
spec header says so.

**Local files** resolve as on film, against the take's serve root (the flow's directory, or
`--serve-root`), which the emitter writes into the spec as a path relative to it. The scenario
serves them at `http://filmkit.localhost`, the same as `--browser playwright`.

**Checks.** After emitting, the camera always runs `playwright test --list` on the spec under a
clean-room config. That loads the spec, the stage and the flow without a browser, so a broken
import fails now rather than in CI. `--scenario-verify` then runs the spec once, headless, in a
clean room (no `storageState`), so an ego-filmed flow that needs a login runs signed out
there. `--scenario-config <file>` (only with `--scenario-verify`) runs it under the project's
own config instead: its `storageState` and its projects, with retries forced to 0. The spec must
sit inside that config's `testDir`, and a config with three projects runs it three times. Verify
is skipped after a failed load check. A clean-room verify that doesn't pass keeps its output
directory (the error context, screenshots and traces Playwright points to) and names it in
`scenario.verify.outputDir`. A pass removes it. Under `--scenario-config` the project's own
`outputDir` applies, filmkit never deletes it, and `outputDir` is null.

**Re-emitting without filming.** `tools/scenario.mjs` writes the same two files and runs the same
load check, for an adapter left behind by a filmkit update, a deleted spec, or a flow filmed before
`--scenario` existed:

```sh
node tools/scenario.mjs demo/checkout.demo.mjs --from out/checkout.json --scenario-dir tests/e2e
```

`--from <take.json>` supplies the take's duration, backend, outcomes, viewport and serve root,
and the take's `--scenario-dir` unless you pass one. It
accepts only an `ok` take of the same flow file, and warns if the flow's content changed since.
Without `--from`, the spec assumes a 180s take at 1280x720. `--serve-root` overrides the root
either way. Exit 0 means written and loading, 1 means refused or nothing written, and 2 means
written but the load check failed.

**Where film and test differ.** The scenario and `--browser playwright` share the same click,
type, wait and text code. Ego is a different engine. The known gaps, some between film and test on
any backend and the rest between ego and Playwright:

- Test clicks land as soon as the target is visible. Film clicks land after the cursor animation,
  at least about 0.4s later. A page that needs a beat after an element appears needs an
  `expect()` or `waitFor()` on whatever it's waiting for, and `FILMKIT_PAUSE_SCALE=1` doesn't bring
  the animation back.
- A target is scrolled to the same place in both (see Where a target is put). Film animates the
  scroll; test mode jumps there.
- `:has-text()` in a selector is case-insensitive on both engines, and only Playwright collapses
  inner whitespace. The `text` option of `expect()` is case-sensitive everywhere.
- `opacity: 0` counts as visible to Playwright and hidden to ego.
- `stage.page.waitForSelector(css, { timeoutMs })` ignores `timeoutMs` on a real Playwright page.
- Local files come from different origins: `http://filmkit.localhost` on Playwright and in the
  scenario, a fresh `http://<token>.localhost:<port>` per take under ego. The paths and files are
  the same and both are secure contexts, so only code that compares `location.origin` to a literal
  can tell.
- A subresource request for a bare directory (`fetch('/sub')`) is a 404 on Playwright and in the
  scenario, and a 301 to `/sub/` under ego. Navigating to `/sub` redirects on both.
- The camera draws its cursor and caption as DOM in the page and test mode draws nothing, so a
  positional selector that could land on the overlay (`body > div:last-child`) differs.

**Sidecar.** With `--scenario`, an `ok` take's sidecar gains `scenario`, rewritten after each step:

```json
"scenario": {
  "spec": "/work/shop/tests/e2e/checkout.scenario.spec.mjs",
  "adapter": "/work/shop/tests/e2e/filmkit-stage.mjs",
  "adapterSha256": "a3059bcbf87c501c…",
  "importFrom": "@playwright/test",
  "scenarioDir": "/work/shop/tests/e2e",
  "warnings": [],
  "loadCheck": { "ok": true, "output": "…" },
  "verify": { "status": "passed", "config": null, "durationSec": 14.2, "outcomes": [ … ], "error": null, "outputDir": null }
}
```

`verify` is `null` without `--scenario-verify` or after a failed load check, and its status is
`passed`, `failed`, `timeout`, `interrupted` or `error`. A failed emit adds `error`. A signal
during this phase stops the running check and exits with the signal's code, and the take is
untouched.

## Tap indicators

Every take on every camera shows one. The web camera draws its ring live, in the page itself
(see Click ripple above). The two device cameras cannot do that. Nothing on Android or iOS
draws the injected finger for you, and Android's own "Show taps" developer setting is no help
either, because Maestro injects through UiAutomation rather than the input device the
pointer-spot overlay reads from. So both device cameras recover every touch after the fact from
Maestro's own debug logs and burn a ring into the finished recording with ffmpeg, before tighten
ever sees it.

**Coordinates.** Android taps arrive in device pixels, and the recording is often smaller and
pillarboxed (one emulator here records 720x1280 while the app itself draws inside a 574x1280
rectangle offset at x=73), so the ring is placed through the content rectangle `adb shell
screenrecord --verbose` reports, not a plain scale. When the finishing encode crops a 1-2px bar
(see `--size` above), the ring is shifted by the crop origin and the sidecar's `taps` are in the
delivered frame's pixels. iOS taps arrive in points, and the ring is
placed by multiplying by the recording's own scale factor, `widthPixels / widthGrid` off the same
maestro.log device-info line, 3 on every current iPhone.

**Timing.** Each camera anchors its recording's time zero against a line the recorder itself
prints, then places every tap relative to that. On Android, video time 0.000 is the arrival of
screenrecord's "Content area is..." line minus 115ms, measured over nine runs at a 77-158ms
spread; a screenrecord too old to support `--verbose`, or one whose line arrives more than 2s
after spawn (a sign the device is buffering `adb shell`'s stdout rather than streaming it),
falls back to spawn time plus 400ms instead, and the sidecar says so. On iOS, video time 0.000 is
the exact instant `simctl` prints "Recording started" on stderr, no correction needed. Start
latency there measured 100-181ms across five takes, small but not constant, which is why spawn
time itself is never used as the anchor.

**Gestures.** A long press holds a ring still for the length of the press, then breaks into the
release ripple the instant the finger lifts. A double tap draws two rings, because the driver
logs two separate touches. A swipe draws nothing on either platform, since a ring at one end of a
drag misdescribes the gesture.

**ffmpeg version.** Burning the rings hands ffmpeg its filter graph through a file rather than
argv, and the flag that reads it changed in ffmpeg 7.1: `-/filter_complex <file>` replaced the
older `-filter_complex_script <file>`, deprecated from 7.1 and gone by 9. filmkit picks the right
one from `ffmpeg -version`, or by probing directly if the version string doesn't parse; a build
that accepts neither flag can't be handed a graph at all, and the run fails on it. Android checks
this in preflight, before the recorder rolls, and records the installed version in the sidecar's
`tapSync.ffmpeg`; iOS only finds out when the burn itself runs, after the take is already filmed.

**Failure policy.** A take whose flow ran tap commands, going by Maestro's own execution record
rather than what the flow file merely mentions, but ended with no rings drawn, exits 1, names the
Maestro debug directory in the error, and still writes the raw recording so nothing is lost. Pass
`--no-show-taps` to film without indicators on purpose. When the flow stopped before any tap ran
(a failed flow, a signal), the message says that and names the reason, and no ring was owed. On an
Android take that is already `truncated`, taps that all fell where it has no footage (a lost
segment, the flow after the recorder died) aren't `taps-missing` either: there's no frame to draw
on, the take fails as `truncated`, and `tapSync.error` says where the taps went. A take a signal
ended gets its rings in a second pass after it is saved (see the signal notes in the Android and
iOS sections). The
sidecar always carries `taps` (each
ring's position and its second into the video), `tapSync` (which anchor was used, and why),
`tapsExpected` (whether the flow was owed any rings at all), and `status: "taps-missing"` when the
policy above fires.

**Cost.** Burning the rings re-encodes the whole take at a constant 60fps, because the source
recordings are variable frame rate and emit nothing while the screen holds still, and a tap the
app does not visibly react to still needs a frame to land on. Resampling to constant fps turns
every one of those long still stretches into real, stored frames, so the growth isn't a bitrate
change (Android's burn re-encodes at the take's own `--bit-rate`, not a fixed one); it's the
frame count going up. Measured: an Android take grew from 1.0 MB to 5.4 MB, and a 21s iOS take
grew from 5.5 MB to 10.7 MB.

## Tightening (dead-air cut)

Both device cameras and the web camera take `--tighten`; standalone use:

```sh
node tighten.mjs out/my-demo-android.mp4 --dry-run   # start here: plan only, no encode
node tighten.mjs out/my-demo-android.mp4
node tighten.mjs out/my-demo.mp4 --min-still 1.0 --keep 0.4 --noise -50dB --crf 16
node tighten.mjs out/my-demo-android-taps.mp4 --detect-from out/my-demo-android-raw.mp4
```

Two ffmpeg passes: `freezedetect` finds visually-static stretches (load waits, inter-action
safety windows, settle pauses). Stretches shorter than `--min-still` (default 1.2s) are left
untouched. Every other one is clamped to `keep` seconds (default 0.6), since a demo cut
edge-to-edge reads as broken, not snappy, unless it overlaps a protected range, in which case the
clamp gives way (see Protected ranges below). Nothing found → prints "already tight" and writes nothing. The
raw file is never replaced; a `-tight` variant is written alongside it.

**Subtitles.** When the sidecar tighten reads (see Protected ranges below) has captions, a
standalone run also writes them as SubRip beside its output, `<out-stem>.srt`
(`out/my-demo-tight.mp4` gets `out/my-demo-tight.srt`), the same way the web camera's `--tighten`
writes `<name>-tight.srt`: same cues, moved through the same cut, so the two files are identical
for the same take and knobs. A caption cut away entirely would be dropped and one cut in part
clipped, with a warning, but the sidecar that lists the captions also protects them, so the cut
keeps them whole. `--no-sidecar` reads no sidecar, so it writes no `.srt`. Device takes have no
captions and get none. A `.srt` belongs to the video beside it: a run that writes the video with no
cues to write removes an existing `<out-stem>.srt` left by an earlier cut, and says so (only
possible under `--force`, since the video itself is refused without it). The overwrite refusal
below covers this file too, and `--dry-run` writes and removes nothing: it prints where the `.srt`
would go and how many cues it would hold, or which stale one it would remove.

**Reach for `--dry-run` whenever a result looks wrong.** It prints the freeze table and the
planned keep-segments (start, end, and whether each is motion or a clamped beat), then exits
without encoding, so it costs one decode instead of a full re-encode. `--dry-run` is exempt from
the overwrite refusal below, since it writes nothing.

**Protected ranges.** The web camera writes a sidecar `<name>.json` next to its video with the
timeline of every caption and pause it authored, and tighten reads it automatically (same name
as the input, `.json` in place of `.mp4`), so a caption held for 2s to be read isn't
indistinguishable from a load wait and clamped down to 0.6s along with it. The device cameras
write the same top-level `timeline`, one `{kind: 'tap', start, end}` entry per drawn ring —
`start` is the tap's own time minus 0.15s, `end` is the later of 0.5s after it or its hold plus
0.45s — with `clock: 'frame'`, so a standalone `node tighten.mjs <take>` protects every tap
automatically, no `--tighten` run in the camera required. `--sidecar <path>` points at a sidecar
with a different name; `--no-sidecar` turns protection off and clamps everything, sidecar or
not. For each freeze, a protected range inside it can widen the kept beat past `--keep`
(clamped), or, if the protected part doesn't touch either edge, split the freeze in two and cut
only the unprotected middle — a long hold with a tap near its end therefore keeps its first
beat, cuts the dead stretch in the middle, and keeps the tap and its ring. A freeze that's
protected end to end is spared outright, nothing cut. On a take where every hold is captioned or
tapped, tighten may end up removing nothing at all (the CLI reports this as `nothing-to-remove`);
that's the correct outcome, not a failure, since there was no dead air to cut. Measured: tap
protection alone changed a tightened take's length by about 0.16s.

**Detecting on re-encoded footage (`--detect-from <path>`).** Freeze detection reads pixels, and
a file that's been re-encoded since it was captured — the tap burn's constant-rate pass, for
instance — carries fresh quantization noise on every frame, the same kind a compressed web-camera
recording has. Detecting straight on the burned file therefore stops being frame-exact and falls
back to the noisy-recorder threshold, which on device footage is a blindfold: measured on one
Android take, the source was 81% frame-exact-frozen before the burn and 0% after, and the two
files didn't even agree on where the first freeze started (0.000-7.833s pre-burn,
0.067-10.200s post-burn once threshold mode kicked in). `--detect-from <path>` runs detection and
calibration against that other file instead and applies the resulting keep-segment plan to the
file actually being cut. Both device cameras use this on themselves: under `--tighten`, once
rings are burned, each keeps its own finalized pre-burn file under a dot-prefixed name next to
the output, hands it to `tighten()` as `detectFrom`, and deletes it once tighten is done with it
(on success or failure alike). A standalone run needs ffprobe to guard the pairing, and refuses
one whose duration or frame size don't roughly match. The one sanctioned size difference is
Android's crop: the delivered take is the pre-finish file cropped by 1-2px, and the camera declares
that crop to tighten (`detectFromCrop`), so the guard checks the pair against it. The one
sanctioned length difference is iOS's held tail (see Held tail in the iOS section): the camera
declares the hold (`detectFromHoldSec`), the guard expects the take to be that much longer, and
detection holds the source's last frame for the same time. Neither has a CLI flag, since only the
camera that made the crop or the hold knows it. Which takes get
tightened: on Android every run that reaches the step (`ok`, `truncated`, and `failed` for a
size or aspect mismatch); not `flow-failed`, `taps-missing`, `interloper` or `interrupted`. iOS
tightens only after a successful flow, and web only after an `ok` take.

**Standalone tighten on a burned take plans differently from the in-camera cut.** The cameras
keep the pre-burn file and pass it as `--detect-from`, so their plan comes from frame-exact
footage. A standalone `node tighten.mjs <take>` (and `--dry-run`) on a device take that has rings
burned in has no pre-burn file, so it sees the burn's re-encode noise, falls back to threshold
mode, and plans a different cut. Measured on one iOS take, it took 80s where the in-camera cut
took 12.8s. Use the in-camera `--tighten` for the real cut, and treat a standalone dry run on a
burned take as an approximation.

**Overwrite refusal.** Standalone `tighten.mjs` never overwrites an existing `-tight` output, nor
the `-tight.srt` it would write beside it. Pass `--force` to replace them, or `--out <path>` to write a new one instead. The cut is written
to a hidden temp file in the same directory (`.<name>-tight.tighten-<pid>-<hex>.mp4`) and renamed
over the output only after ffmpeg succeeds, so a failed or aborted run leaves no partial
`-tight.mp4`, and under `--force` an existing `-tight.mp4` stays intact. Ctrl-C, SIGHUP and
SIGTERM abort the pass, wait for ffmpeg to exit, remove the temp file, and exit 130, 129 or 143.
Only a SIGKILL of node itself can leave the hidden temp behind. The temp's name carries the pid of
the run that wrote it, and every later tighten of the same output, standalone or in a camera
(not a `--dry-run`), first removes those temps whose pid is no longer alive. One whose pid is
alive is left alone: another run may still be writing it. The device cameras sweep their own
burn temps the same way.

**The numbers add up.** The `A -> B (N cuts, X removed)` line, and the CLI's input, output and
removed lines, quote the two files' own lengths, and `X` is `A - B`. The plan's removal (the
result's `removedSec`) isn't quite that. The cut keeps whole frames of a 30fps grid, half-open
(a kept span `[S, E)` keeps the frames at `S <= t < E`), with plan times within a fifth of a frame
of the grid snapped to it. A span that lies on the grid, as freeze edges do, keeps exactly its
length; one whose edge falls between two frames (a protected tap's edge, the input's last
instant) keeps up to a frame more or less. So the written file is off the plan by under a frame
per such span, in either direction. It used to run a frame per kept span long: both ends were
kept, so a 0.6s span kept 19 frames, and an Android take planned at 27.019s was written at 27.20s
(816 frames). A `--dry-run` quotes the plan, which adds up the same way.

**Encode quality (`--crf`).** Every re-encode filmkit does for a viewer (the tighten cut, the web
transcode, the tap burn's software encoder, the cameras' finalize, trim and stitch fallbacks) is
libx264 at CRF 18, from `lib/encode.mjs`. The preset is `veryfast`, except the web camera's first
encode from raw frames, which keeps `medium`. `--crf <0-51>` overrides it on tighten and on every
camera (`0` is lossless, above about 28 is a visible step down). Stream copies ignore it. The
default used to be x264's 23. Measured on 60 fps Android takes, CRF 18 took a 510s take cut to
112.7s from 130 to 189 kbps, and a 44s take cut to 5.5s from 294 to 444 kbps (SSIM against the
source 0.9981 to 0.9990). The 60 fps VideoToolbox tap burn is bitrate-controlled, never goes
below its source and ignores `--crf`. That burn, not the recorder (about 232 kbps on that take),
is the "2 Mbps source" an earlier comparison measured against. On iOS the same plan went from 1.09
to 1.90 Mbps.

Five things worth knowing:

- **Sensitivity is calibrated per recorder** (`--noise auto`, the default), because one dB
  threshold cannot serve both cameras. The web camera records through Chromium + x264, where
  every frame carries fresh quantization noise, so "static" frames are not identical and the
  tuned `-60dB` threshold is right. Device recorders (`adb screenrecord`, `simctl recordVideo`)
  are frame-exact (while the screen doesn't change the encoder emits no new content), so their
  noise floor is zero, and there `-60dB` is a blindfold rather than a safe default: it ignores
  every change smaller than 0.1% of the frame, which on a 960x2136 phone screen is most of the
  UI. Tighten runs both probes, reports which mode it picked and why, and on frame-exact footage
  detects at `n=0`, where **any** nonzero frame difference counts as motion. Pass an explicit
  `--noise -60dB` to force the threshold and skip the choice.
- **An encoder keyframe doesn't split a hold.** A compressed recording re-codes the whole picture at
  every keyframe (every 250 frames in a web take, every 12 in the device cameras' tap burn), and on a
  still screen that is the one frame whose noise is new. In threshold mode it used to end a hold that
  had drifted close to the threshold, so the rest of the hold played as motion. Measured on a web take,
  its closing hold broke at the keyframe at 25.0s and the cut removed 0.26s of about 1s of dead air.
  Tighten now joins two holds that meet on a keyframe when that frame's own change is re-encode noise:
  within the threshold in total, and with no 4x4 block's brightness moving more than 16 levels.
  Across about 20,000 keyframes in existing takes, re-encode noise stayed at or under 15 levels,
  while a 1px grey caret appearing measured 27 and a ticking digit 73. So a real change that lands on
  the keyframe, a caret or a ticking digit, still ends the hold. A change as faint as the noise itself
  (dim text on a dark screen) can't be told apart from it and is joined, as the threshold would treat
  it anywhere else in a hold. A joined hold says so in the run's log and is marked
  `(across a keyframe)` in the `--dry-run` freeze table. Frame-exact detection needs none of this: the
  device recorders only put keyframes on frames where the screen changed.
- **Sanity floor.** If the plan keeps under 25% of a clip longer than 5s, or lands under 2s, the
  run prints a warning naming the likely cause, and writes the file anyway. You decide; the tool
  only refuses to be quiet about it.
- **Which end survives.** The FIRST `keep` seconds of each freeze. Every frame inside a freeze
  is identical by definition, so the only choice is rhythm: keeping the leading edge reads as
  "the action lands, we hold a beat, then cut".
- **VFR gotcha.** These recordings are genuinely variable-frame-rate (no new frame while
  nothing changes, plus authored multi-second durations on static frames). Naive
  `trim`+`concat` either collapses the kept beat to near-zero or overshoots by seconds.
  `tighten.mjs` resamples to constant fps up front and uses the classic `select`+`setpts`
  idiom. See its header comment for the full story before touching it.

Expect one consequence of frame-exact detection rather than debugging it. A screen with a live
element, a progress timer counting seconds or the status-bar clock, *is* motion, and tighten keeps
it at full length. That is the honest reading of the footage, and it is why a 147s "Making it"
progress take tightens to 76s rather than to nothing. Compressing that stretch anyway is an
editorial call, not a detection one. `--noise -60dB` gives you the old change-must-be-big
behaviour, with the sanity-floor warning attached.

## Inspection tools

- **`tools/doctor.mjs`** (`filmkit doctor`) — per camera, READY or not, each requirement `ok`,
  `MISSING` or `optional`, and the exact fix for each missing one. A requirement two cameras share
  (ffmpeg, and Node.js when it's too old) is listed under each camera that needs it. It asks through the same code the
  cameras use (tool resolution, a real ego round trip, a real Chromium launch), so it can't call a
  camera ready that would refuse. Also reports whether the `film-demo` skill links to this checkout.
  Exits 0 when the web camera is ready.
- **`tools/explore.mjs <url-or-file>`** (`filmkit explore`) — pass 1 of the workflow without
  ego-browser. Opens the page in Playwright's Chromium at 1280x720, the way the camera would (a local
  file is served from its directory, or `--serve-root`), and prints the final URL, status and title,
  plus a `note:` when the page isn't the one asked for: a server redirect (with each hop's status) or a
  page that sent itself elsewhere after loading. A login wall shows up as one of these. A URL that only
  differs as the browser writes it (`https://example.com` and `https://example.com/`) is not a move.
  Then one line per visible link, button, field, heading, label and id'd element with a selector that
  matches exactly that element (a test id, a stable `#id`, a field's name or label, an `aria-label`,
  an `href`, or `:has-text("…")`, the selectors both backends understand; an `nth-of-type` path last,
  marked fragile), and saves a screenshot to `out/explore/<host>.png` (`--shot <png>`, `--full` for
  the whole page, `--wait <css>` for a page that renders late, `--all` past 120 rows). Signed-out
  view only.

- **`tools/hierarchy.mjs`** — readable `maestro hierarchy`. Piped (`maestro --device <s> hierarchy |
  node tools/hierarchy.mjs`) or direct (`--device <serial>` / `--in <file>`), one
  `text | a11y | class | bounds | click=` line per node with text. `--clickable-only` filters.
- **`node tools/timeline.mjs <take.mp4>`** — the take's edit list without watching it: one ffmpeg
  pass at 1fps, one line per screen change, seams from the sidecar marked and a warning when a seam
  sits inside motion (±2s both sides). `--fps <n>` resamples the sampling. A change is a
  thresholded pixel difference, not an exact frame hash, so it reads web takes correctly (a static
  hold is not a change) and works on all three cameras.

Internal ffmpeg calls that only produce a file run with `-hide_banner -loglevel error`, so a flow
failure's one line isn't buried under the banner. Calls whose output is parsed run at the level
they parse. The steps that count `Non-monotonic DTS` lines (Android's stitch, iOS's finalize) run
at `-loglevel warning`, because `error` would report zero (measured on three iOS takes: 4, 1 and 1
lines at the default level and at `warning`, 0, 0 and 0 at `error`). Probes that read info-level
output run at `info`: tighten's freezedetect pass (banner hidden), Android's `probeVideo` and
iOS's timeline probe. Pass `--verbose` (Android) to see the full banner and stream tables on the
file-producing calls.

## Running a camera from an agent shell

A shell that ends its turn takes its children with it. A camera launched as a plain child of an
agent's shell dies with that shell mid-take, and its log just stops (measured: frozen mid-
`inputText`, no exit line, an empty debug directory). The camera now salvages on SIGHUP and
SIGTERM (exit 129 and 143, see the signal notes in the Android and iOS sections), but don't rely on that to finish a long take.
Launch it detached and poll the log:

```sh
skills/film-demo/filmkit detach take-1.log android my-flow.yaml --tighten --name take-1
tail -n 20 take-1.log        # poll until the EXIT= line appears
```

`detach` (`tools/detach.mjs`) starts the command in its own session (setsid), writes its output to
the log and ends the log with `EXIT=<code>`. It prints the job's pid and the line that stops it early,
`kill -INT -<pid>`, which salvages the take like a Ctrl-C. Why a new session and not `nohup`: nohup
only sets SIGHUP to ignored, and a camera installs its own SIGHUP handler over that, so a hangup sent
to the starting shell's process group still stops it (measured: a `nohup sh -c '…'` take whose
caller's group got SIGHUP ended `interrupted` after 5.3s, exit 129; the same take under `detach` ran
to `ok`). It also keeps `sh -c` scripts off the agent's command line, which Claude Code's safety check
can't read and asks the user to approve. Without the launcher, `setsid` (Linux) does the same:
`setsid sh -c 'node film-android.mjs my-flow.yaml --tighten; echo EXIT=$?' > take-1.log 2>&1 &`.

The `EXIT=` line gives you the camera's exit code (0 for a keeper, 2 for a keeper whose
`--scenario` failed, 130/129/143 when a signal ended the run, 1 or another non-zero code for a
failed take), so a log that stops without one means the process was killed outright. A signal's
code doesn't mean the take was salvaged: on a device camera a take that had already failed keeps
its failed status (check the sidecar).

## Which camera when

- **Feature-proof videos in agent loops, CI, retakes, polish** → web camera. Fast, deterministic,
  cursor + captions. The default films in the user's own ego-browser when it's running, and
  otherwise in headless Playwright, which runs anywhere Chromium runs with no browser session.
- **Real product demos of a mobile app** → device cameras. Only they film the real thing;
  budget the emulator/simulator cold start.
- Pacing philosophy differs: the web camera *simulates* human pacing deterministically, and device
  footage is paced by the real device.
- Android's own "Show taps" developer setting can't stand in for filmkit's tap indicators: it only
  draws touches that arrive from the real input device, and Maestro's driver injects synthetic
  input that never reaches it. See Tap indicators above.

## Output & scratch dirs

`out/` in the checkout is where every take lands unless `--out` says otherwise: the videos, their
`-tight` cuts, sidecars and web subtitles (`.srt`), and `out/explore/` screenshots. It's gitignored, so `git pull` never
touches it, and nothing deletes it: a take is replaced only under `--force`.
