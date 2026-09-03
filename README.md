# filmkit

Film human-paced, watchable demo videos of **any** web or mobile app: scripted flows,
deterministic choreography, and a dead-air cutter that tightens the result. Three cameras, one
editor:

| Camera | Films | Stack | Output |
|---|---|---|---|
| `film-web.mjs` | Any web app (URL or local file), filmed inside your real signed-in browser or in headless Playwright, with an animated cursor, click ripple, and caption overlays | ego-browser or Playwright + ffmpeg | `out/<flow>.mp4` |
| `film-android.mjs` | Any app on an Android emulator/device, the real UI, amber tap indicators burned in | Maestro + `adb screenrecord` + ffmpeg | `out/<flow>-android.mp4` |
| `film-ios.mjs` | Any app on an iOS Simulator, the real UI, amber tap indicators burned in | Maestro + `simctl recordVideo` + ffmpeg | `out/<flow>-ios.mp4` |
| `tighten.mjs` | Cuts dead air out of any video, sparing the caption and pause holds it's told about (also usable standalone) | ffmpeg | `<in>-tight.mp4` |

Extracted from the Whim project's `demo/` tooling, where it filmed production demo videos;
generalized so no part of it knows about any particular app.

## Install

```sh
npm i                       # only needed for the web camera's --browser playwright fallback
npx playwright install chromium   # once, for that fallback; downloads Chromium (~150 MB)

node film-android.mjs       # android/ios cameras need NO npm install at all
```

The web camera's default, `--browser ego`, needs neither of those. It films inside `ego-browser`,
which you install separately (see the ego-browser skill) and which must already be running.

External tools (all resolved PATH-first, then `$FILMKIT_<NAME>`, then known macOS fallbacks):

- always: **ffmpeg**
- web camera, `--browser ego` (default): **ego-browser**, already running
- web camera, `--browser playwright`: **playwright's Chromium** (via npm above)
- Android camera: **adb**, **maestro**, optionally the **emulator** binary
- iOS camera: **xcrun** (macOS only), **maestro**

Env overrides: `FILMKIT_ADB`, `FILMKIT_EMULATOR`, `FILMKIT_MAESTRO`, `FILMKIT_FFMPEG`,
`FILMKIT_XCRUN`. Defaults: `--avd` via `FILMKIT_ANDROID_AVD`, `--simulator` via
`FILMKIT_IOS_SIMULATOR`.

## The two-pass workflow

The camera only rolls on a compiled flow file, never on exploration.

1. Explore off-camera first. For a web flow, start with the project's own end-to-end specs,
   which already carry working `data-testid` selectors for the screens you're about to film, and
   confirm anything the specs don't cover (an unfamiliar route, a conditional element) with
   `snapshotText()` inside ego-browser, the same logged-in browser the camera will film in. For a
   mobile flow, `maestro hierarchy` dumps what the OS sees and `maestro studio` gives interactive
   probing. Either way, note what to click/type in what order, which selectors work, what to wait
   for.
2. Compile that step list into a flow file (examples below). Narration becomes captions or
   comments; actions become clicks/taps/types.

The flow file *is* the shot list: reviewable as source, deterministic to re-film. After a filming
run, write down anything that went wrong or cost time in `FEEDBACK.md`. It's the running record
of where the tool or its docs fell short.

## Web camera

```sh
node film-web.mjs examples/web/tip-demo.demo.mjs --tighten
```

Two cameras behind one flow API, chosen with `--browser`:

- `--browser ego` (the default) films inside your own already-running `ego-browser`, the
  Chromium fork that carries your real login profile. The take is a screencast pulled over CDP
  from inside that running app, so the tab shows up on your screen while it films, but nothing
  needs to actually be visible or in front for the recording to come out right. Occlusion
  doesn't matter. This is the camera for anything that needs to be signed in as you.
- `--browser playwright` is a throwaway headless Chromium: fast, sandboxed, no browser needs to
  be running first. It has no login of its own and starts every run from a blank profile, so
  reach for it for CI, retakes, and any target that doesn't sit behind auth.

**Login.** Under `--browser ego` the flow already runs signed in as you, in whatever session
ego-browser already carries. There's no `--storage-state` flag and none is needed. If the target
needs a login, use `--browser ego` and sign in once inside ego-browser the ordinary interactive
way before filming; the take will already be authenticated. `--browser playwright` starts a fresh
profile every run and cannot carry a login at all.

A flow file default-exports `async ({ stage }) => { ... }`. The director API (`lib/stage.mjs`):

- `stage.open(urlOrPath, { readySelector?, timeoutMs?, settleMs? })` loads an http(s) URL or
  local file path, optionally waits for a selector, and injects the overlay. Call it once, first.
- `stage.goto(urlOrPath, { readySelector?, timeoutMs?, settleMs? })` navigates again later in
  the same take. The overlay survives: it re-registers itself on every future document, so a link
  click or a `goto()` mid-flow doesn't lose the cursor or an open caption.
- `stage.waitFor(target)` waits for something to be present and visible without pointing at or
  clicking it, for a beat that only needs the target on screen before the flow narrates over it.
- `stage.click(target)` animates the cursor to the target's center, dwells, shows a click ripple,
  then performs a real click.
- `stage.point(target)` does the same animation with no click and no ripple, for gesturing at
  something while narrating.
- `stage.type(target, text)` clicks into the target, selects any existing text, then types with a
  deterministic human-ish rhythm.
- `stage.caption(text)` and `stage.clearCaption()` show and hide the bottom overlay bar, fading
  in and out.
- `stage.pause(ms)` is a plain beat.
- `stage.finish()` and `stage.abort()` end the take. A flow doesn't call these directly;
  `film-web.mjs` calls `finish()` when the flow returns and `abort()` if it throws.
- `stage.page` is the raw Playwright `Page` under `--browser playwright`, for anything custom
  (dialogs, uploads, network waits, `frameLocator` for apps that render inside iframes). Under
  `--browser ego` there is no Playwright object, so this is a small stand-in exposing only
  `evaluate(source)` (a JS expression string), `waitForSelector(css, { timeoutMs })`, and
  `goto(url)`. A flow that only ever calls `stage.page.evaluate('...')` works unchanged on both.
- `stage.timeline` holds every caption and pause this take authored, in recording-clock seconds.
  Read it after `finish()`; it's what gets written into the sidecar and what tighten protects.

`click`, `point`, `type`, and `waitFor` all auto-wait for their target: up to 10s for it to be
present, laid out, and not hidden, before acting. A flow doesn't need a manual sleep before a
target that appears late.

`target` is a CSS selector on both backends. A Playwright `Locator`, or a `(page) => Locator`
function for compound queries, works only under `--browser playwright`. `--browser ego` has no
Playwright object to build one from and rejects it. The one thing both backends understand beyond
a plain selector is Playwright's `:has-text("…")` pseudo-class, which `--browser ego` shims:

```js
stage.click('label:has-text("Tip %") input');
```

Flags: `[--browser ego|playwright] [--out <dir>] [--name <stem>] [--force] [--viewport <WxH>]
[--serve-root <dir>] [--tighten]`. Overwrite refusal mirrors the Android camera: an existing
`<name>.mp4` / `.json` / `-tight.mp4` is never overwritten, and the run refuses in preflight,
before a browser is even launched, unless you pass `--force`.

**Determinism.** Every timing value (cursor-move duration, per-character type delay, dwell/
settle pauses) is a pure function of distance / text length / fixed constants in
`lib/stage.mjs`, never `Math.random()`. Re-filming the same flow reproduces the same
choreography every time.

**Click ripple.** Every `stage.click()` draws an amber ring at the click point, on by default.
The cursor's own press-shrink is a couple of pixels of movement at 1280x720 and doesn't read on a
re-encoded frame, so the ripple is what actually shows a viewer where and when a click landed.

**Sidecar.** Every run writes `<name>.json` next to the video: the backend used, the flow's path
and SHA-256, argv, viewport, the recording's `clock` (`frame` on `--browser ego`, whose
timestamps come from real captured frames and are exact; `approximate` on `--browser playwright`,
whose timestamps come from the wall clock alongside the encoder), the full caption/pause
`timeline`, and the `tighten` result when `--tighten` was passed.

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
```

Tap indicators are burned into every take by default; pass `--no-show-taps` to film without them
on purpose. See the Tap indicators section.

Pipeline: preflight → device → install/fresh → record (segment chain) → maestro → stop → pull →
stitch (or, for a run that fits in one segment, a plain remux) → [tighten] → sidecar. Details
that matter:

- **Naming and takes.** Output is `out/<flow>-android.mp4` by default. `--name <basename>` sets the
  stem instead (`<basename>.mp4`, `<basename>-tight.mp4`, `<basename>.json`) and `--out <dir>` sets
  the directory. An existing output is never overwritten. The run refuses in preflight, before the
  device is touched, unless you pass `--force`. Filming is a repeated activity, and a clobbered
  take is gone.
- **`screenrecord` runs with `--verbose`.** It costs nothing on the recording and buys the tap
  ripples their anchor: the "Content area is..." line it prints is the reference point every tap
  time and every tap coordinate is placed against (see Tap indicators below). It is probed for
  before use, so an older `screenrecord` without the flag still films, just with a less precise
  anchor and a warning saying so. The line is only trusted if it arrives within 2s of spawning
  the recorder; a later arrival means this device is buffering `adb shell`'s stdout instead of
  streaming it line by line, so the camera falls back to spawn time plus 400ms instead and notes
  the fallback, per segment, in the sidecar's `tapSync`.
- **Flows longer than 180s.** `adb shell screenrecord` hard-stops at three minutes, so anything
  longer is filmed as a chain of segments. Each one records with `--time-limit`
  (`--segment-seconds`, default 170, floor 5, ceiling 180, screenrecord's own hard cap), and the
  next starts the instant the previous recorder exits. The segments are then stitched into one
  file (ffmpeg concat demuxer, stream copy, `+faststart`). A flow that fits in one segment skips
  all of that and takes the old single-file path.
- **The seam, and where the time actually goes.** Swapping recorders costs one adb round trip,
  about 0.3s, and whatever happens on screen during it is not filmed. It costs no timeline,
  though. The concat directives hold the previous frame across the gap, so a seam loses content,
  not duration, and nothing compounds across seams. The shortfall you can measure against the wall
  clock sits at the tail instead: stopping the last recorder and letting it finalize is wall time
  that never becomes frames, about 0.8s in both runs measured here. A 220.9s two-segment run
  stitched to 220.1s, one seam. The same flow forced into five 20s segments came out at 99.3s
  against 100.6s of wall clock, four seams. One seam or four, the tail costs the same. Seams land
  at deterministic offsets, so a shot that must not be cut can be kept inside one segment by
  choosing `--segment-seconds`.
- **A bad segment costs only itself.** Every pulled segment is checked before it enters the
  stitch: readable container duration, at least one packet. A recorder stopped within a second of
  spawning writes an mp4 with no moov atom and no picture in it, which is the ordinary shape of
  the last link in a chain, so that one is dropped with a note and nothing is missing. An unusable
  segment anywhere else is real lost footage. The take is stitched from what survived, named as
  truncated, and the run exits non-zero with the file kept. One bad segment never costs the other
  N-1. Nothing is deleted quietly either: when a run ends unclean the pulled `.name.segNNN.mp4`
  files stay on disk and the run prints where they are (dot-prefixed, so use `ls -a`).
- **The stitch trusts the wall clock, not the files.** A screenrecord mp4 does not know how long it
  recorded. It is variable-frame-rate and emits no frame at all while the screen is still, so its
  own duration is wrong in both directions. On one run, segments of 20.1s wall time claimed 34.0s,
  6.0s and 5.6s. filmkit times each segment itself and hands the concat demuxer explicit `duration`
  directives instead. Packet timestamps confirm it: every seam lands on its intended offset and the
  stitched stream stays monotonic. The reasoning is in `film-android.mjs`'s STITCHING header. Read
  it before touching that math.
- **And the stitch is checked, not assumed.** ffmpeg reports a scrambled concat as a warning and
  still exits 0, so filmkit scans the concat's stderr for `Non-monotonic DTS` and compares the
  finished duration against the timeline the directives planned. Either one off prints a loud
  warning and lands in the sidecar's `stitch` block.
- **`--size <WxH>`.** Plenty of emulator AVDs ship an AVC encoder that cannot be configured at a
  high-density native resolution. `screenrecord` says so, `unable to configure video/avc codec at
  1344x2992 (err=-22)`, and then records 720x1280 without telling you, which ruins a capture set
  that has to intercut. Pin the geometry with `--size`, keeping the device's aspect ratio and
  raising `--bit-rate` alongside it. Two nets catch the fallback anyway. The recorder's stderr is
  echoed as `[screenrecord] segNNN: ...`, and the finished file's geometry is checked against what
  was asked for, with a loud warning on mismatch.
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
  sighting to the recorder stopping.

  What counts as an interloper is deliberately narrow, because `topResumedActivity` tracks
  *activities* and most system chrome is made of *windows*. Measured on an Android 17 emulator:
  opening the notification shade leaves `topResumedActivity` on the app and only moves
  `mCurrentFocus` to `Window{… NotificationShade}`; the IME behaves the same way. Neither can
  produce a false positive here at all, so the allowlist only names system surfaces that really are
  activities: SystemUI's own, the runtime-permission dialog, and the IME packages for devices that
  might route one through an activity. The launcher is not on it, because home showing means your
  app got backgrounded, which is the failure. Neither is the bare `android` package, where the
  share sheet and the ANR dialog live. If your flow opens a share sheet on purpose, don't pass a
  guard package for it.
  An unreadable sample (screen off, an activity transition caught mid-dump) is recorded as
  `unknown` and never counts as an interloper; a run of five in a row says so, because a watchdog
  that has quietly stopped watching is worse than none.
- **Provenance sidecar.** Every run that reaches the camera writes `<name>.json` next to the
  video: a `status` (`ok`, `truncated`, `interloper`, `taps-missing`, `flow-failed`, `interrupted`,
  `failed`), flow path and SHA-256 of its contents, argv, device serial and build fingerprint,
  requested vs. actual size, bit rate, each segment's wall/container/timeline durations, whether it
  was dropped and why, recorder warnings, the stitch's planned-vs-actual check, raw duration, the
  `--tighten` result under `tight` (`detectFrom`, `detectMode` and `protected` alongside the cut
  itself — the iOS sidecar carries the equivalent under `tighten` instead), and any files a failed
  run left behind. Every tap indicator drawn lives in `taps` (position in output pixels, seconds
  into the video), alongside `tapSync` (which anchor the times were converted against and why),
  `showTaps` (whether indicators were requested), and `tapsExpected` (whether Maestro's own
  execution record says the flow was owed any). A guarded run
  adds `foreground`, one row per change of foreground app timestamped from the moment the recorder
  started, so it lines up with the video itself. An undisturbed take contributes exactly one row.
  `flowSucceeded: true` alongside `status: "interloper"` is the whole failure mode in two fields.
  It is written on the failure paths too, so a `demo/raw/` tree still explains itself months
  later, when two takes turn out to have come from different revisions of the same flow. A run
  that dies in preflight or device setup writes none. Nothing was filmed, and an earlier take's
  sidecar must not be clobbered by a run that never rolled.
- **Every recording carries a head and a tail you didn't author.** 1.5s of warmup so the recorder
  is really running before Maestro's first tap, Maestro's own JVM startup (4-6s here), and 2s of
  finalize after the flow ends so the on-device mp4 closes cleanly. Measured: a flow whose only
  authored hold was 20s came out as a 30.4s recording. Budget it on duration-constrained shots.
  The run prints the finished duration, so one take tells you your own number.
- `--fresh` runs `pm clear` right before recording → beat 0 is a true fresh first run.
- SIGINT (not SIGKILL) stops `screenrecord`. That's what makes the on-device mp4 finalize instead
  of truncating. The tool handles this; don't "fix" it to SIGTERM. Your own Ctrl-C is handled the
  same way: it stops the recorder, pulls, stitches and writes the sidecar before exiting 130,
  instead of abandoning a live `screenrecord` on the device with the segments still on it. A
  Ctrl-C that lands mid-burn (SHOW_TAPS's ffmpeg, running after the recorder has already stopped)
  SIGTERMs that encoder instead, escalating to SIGKILL if it doesn't exit, before the sidecar is
  written and the process exits.
- A failed flow still saves the partial recording for debugging (exit code stays non-zero). So
  does a recording that ends early, one interrupted with Ctrl-C, and one that lost a segment. If a
  segment dies on its own, the chain stops instead of respawning forever, names the segment and
  its wall time, and exits non-zero rather than reporting a truncated take as a success.

### Maestro flow idioms (hard-won)

- **Pause primitive.** Maestro has no fixed-duration sleep. Every pause is
  `extendedWaitUntil: { visible: "<never-appears-marker>", timeout: <ms>, optional: true }`.
  Blocks for the full timeout; `optional: true` keeps the exit code 0.
- **That full-timeout promise has exceptions, and they are big.** Measured against Maestro 2.6.0
  on an Android 17 emulator. A flow whose only step is that wait honors 5s, 20s, 30s and 40s.
  The same wait in a flow that also runs `launchApp` came back after ~7-8s whatever timeout it was
  given, and inside a `repeat:` block after ~0.5s. Nothing reports the difference, so a flow built
  out of long holds can run a third of its authored length. If a beat's duration matters, check it
  against the recording (the sidecar keeps the raw duration). To hold reliably for minutes, use
  `runScript` with a busy loop. It was the only primitive that blocked for what it was asked for
  every time.
- **`notVisible` is satisfied by being covered.** Every wait that ends on something *disappearing*
  also ends when another app draws over the screen, and the flow reports COMPLETED either way. This
  is not fixable in the flow. Pass `--guard-app <pkg>` so the recorder notices instead.
- **Selectors.** Visible text or accessibility labels (what `maestro hierarchy` reads), never
  coordinates. Debug with `maestro hierarchy`.
- **Replace text cleanly.** `inputText` APPENDS at the cursor; `eraseText` is unreliable in
  WebViews (controlled inputs re-render a stray leading char that later keystrokes never
  overwrite). The clean gesture is
  `longPressOn` → tap `"Select all"` → `inputText`. `doubleTapOn` selects nothing in many
  WebViews.

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
  (`.mp4`, `.json`, and, with `--tighten`, `-tight.mp4`) is never overwritten. The run refuses in
  preflight, before the simulator is even touched, unless you pass `--force`.
- `--fresh` uninstalls the app (the only true data wipe on iOS) and therefore requires
  `--install` to bring it back.
- `--clean-status-bar` overrides the clock to 9:41, full battery and signal, and clears the
  override after the run.
- No 180s cap here (unlike Android). Recording writes straight to disk on the host.
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
  indicators are burned, film-ios trims the output back to the recorder's own wall window
  (Recording started to SIGINT) — a cut that can only ever remove time that was never filmed —
  and records what it did, or why it didn't, in the sidecar's `delivered` block.
- **Ctrl-C.** SIGINT stops the recorder, restores the status-bar override if one was set,
  finalizes whatever was filmed, and writes a sidecar with `status: "interrupted"`; the take is
  delivered without tap indicators rather than with a half-burned set (a burn caught mid-encode
  is discarded, not kept). A second Ctrl-C while that save is running is a no-op. A Ctrl-C during
  the tap burn itself SIGTERMs that encoder, escalating to SIGKILL if it doesn't exit, the same
  mechanism Android uses.
- Tap indicators are burned into every take; see the Tap indicators section.

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
screenrecord --verbose` reports, not a plain scale. iOS taps arrive in points, and the ring is
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
`--no-show-taps` to film without indicators on purpose. The sidecar always carries `taps` (each
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
node tighten.mjs out/my-demo.mp4 --min-still 1.0 --keep 0.4 --noise -50dB
node tighten.mjs out/my-demo-android-taps.mp4 --detect-from out/my-demo-android-raw.mp4
```

Two ffmpeg passes: `freezedetect` finds visually-static stretches (load waits, inter-action
safety windows, settle pauses). Stretches shorter than `--min-still` (default 1.2s) are left
untouched. Every other one is clamped to `keep` seconds (default 0.6), since a demo cut
edge-to-edge reads as broken, not snappy, unless it overlaps a protected range, in which case the
clamp gives way (see Protected ranges below). Nothing found → prints "already tight" and writes nothing. The
raw file is never replaced; a `-tight` variant is written alongside it.

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
one whose duration or frame size don't roughly match.

**Overwrite refusal.** Standalone `tighten.mjs` never overwrites an existing `-tight` output.
Pass `--force` to replace one, or `--out <path>` to write a new one instead.

Four things worth knowing:

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

## Which camera when

- **Feature-proof videos in agent loops, CI, retakes, polish** → web camera. Fast, deterministic,
  cursor + captions. The default films in the user's own ego-browser on whatever machine it's
  running on; the `--browser playwright` fallback runs headless anywhere Chromium runs, no
  browser session required.
- **Real product demos of a mobile app** → device cameras. Only they film the real thing;
  budget the emulator/simulator cold start.
- Pacing philosophy differs: the web camera *simulates* human pacing deterministically, and device
  footage is paced by the real device.
- Android's own "Show taps" developer setting can't stand in for filmkit's tap indicators: it only
  draws touches that arrive from the real input device, and Maestro's driver injects synthetic
  input that never reaches it. See Tap indicators above.

## Output & scratch dirs

`out/` is build output, gitignored, regenerated on every run.
