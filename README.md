# filmkit

Film human-paced, watchable demo videos of **any** web or mobile app — scripted flows,
deterministic choreography, and a dead-air cutter that tightens the result. Three cameras, one
editor:

| Camera | Films | Stack | Output |
|---|---|---|---|
| `film-web.mjs` | Any web app (URL or local file) in a real Chromium window — animated cursor, press feedback, caption overlays | Playwright + ffmpeg | `out/<flow>.mp4` |
| `film-android.mjs` | Any app on an Android emulator/device, the real UI | Maestro + `adb screenrecord` + ffmpeg | `out/<flow>-android.mp4` |
| `film-ios.mjs` | Any app on an iOS Simulator, the real UI | Maestro + `simctl recordVideo` + ffmpeg | `out/<flow>-ios.mp4` |
| `tighten.mjs` | Cuts dead air out of any video (also usable standalone) | ffmpeg | `<in>-tight.mp4` |

Extracted from the Whim project's `demo/` tooling, where it filmed production demo videos;
generalized so no part of it knows about any particular app.

## Install

```sh
npm i                       # only needed for the web camera (installs playwright)
npx playwright install chromium   # once; downloads Chromium (~150 MB)

node film-android.mjs       # android/ios cameras need NO npm install at all
```

External tools (all resolved PATH-first, then `$FILMKIT_<NAME>`, then known macOS fallbacks):

- always: **ffmpeg**
- web camera: **playwright's Chromium** (via npm above)
- Android camera: **adb**, **maestro**, optionally the **emulator** binary
- iOS camera: **xcrun** (macOS only), **maestro**

Env overrides: `FILMKIT_ADB`, `FILMKIT_EMULATOR`, `FILMKIT_MAESTRO`, `FILMKIT_FFMPEG`,
`FILMKIT_XCRUN`. Defaults: `--avd` via `FILMKIT_ANDROID_AVD`, `--simulator` via
`FILMKIT_IOS_SIMULATOR`.

## The two-pass workflow

The camera only rolls on a compiled flow file — never on exploration.

1. **Explore off-camera**: drive the app interactively (Playwright console, `maestro studio`,
   `maestro hierarchy`) and note what to click/type in what order, which selectors work, what
   to wait for.
2. **Compile**: turn that step list into a flow file (examples below). Narration becomes
   captions / comments; actions become clicks/taps/types.

The flow file *is* the shot list: reviewable as source, deterministic to re-film.

## Web camera

```sh
node film-web.mjs examples/web/tip-demo.demo.mjs --tighten
```

A flow file default-exports `async ({ stage }) => { ... }`. The director API (`lib/stage.mjs`):

- `stage.open(urlOrPath, { readySelector?, timeoutMs?, settleMs? })` — load an http(s) URL or
  local file path, optionally wait for a selector, inject the overlay. Call once, first.
- `stage.click(target)` — animate the cursor to the target's center, dwell, show press
  feedback, perform a real click.
- `stage.point(target)` — same animation, no click (gesturing at something while narrating).
- `stage.type(target, text)` — click into the target, select existing text, type with a
  deterministic human-ish rhythm.
- `stage.caption(text)` / `stage.clearCaption()` — bottom overlay bar, fades in/out.
- `stage.pause(ms)` — a plain beat.
- `stage.page` — the raw Playwright `Page`, for anything custom (dialogs, uploads, network
  waits, `frameLocator` for apps that render inside iframes).

`target` is a CSS selector, a Playwright `Locator`, or `(page) => Locator` for compound queries:

```js
stage.point((page) => page.locator('.row').filter({ hasText: 'Per person' }).locator('span').last());
```

Flags: `[--out <dir>] [--viewport <WxH>] [--tighten]`.

**Determinism**: every timing value (cursor-move duration, per-character type delay, dwell/
settle pauses) is a pure function of distance / text length / fixed constants in
`lib/stage.mjs` — never `Math.random()`. Re-filming the same flow reproduces the same
choreography every time.

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

Pipeline: preflight → device → install/fresh → record (segment chain) → maestro → stop → pull →
stitch (or, for a run that fits in one segment, a plain remux) → [tighten] → sidecar. Details
that matter:

- **Naming and takes.** Output is `out/<flow>-android.mp4` by default. `--name <basename>` sets the
  stem instead (`<basename>.mp4`, `<basename>-tight.mp4`, `<basename>.json`) and `--out <dir>` sets
  the directory. An existing output is never overwritten. The run refuses in preflight, before the
  device is touched, unless you pass `--force`. Filming is a repeated activity, and a clobbered
  take is gone.
- **Flows longer than 180s.** `adb shell screenrecord` hard-stops at three minutes, so anything
  longer is filmed as a chain of segments. Each one records with `--time-limit`
  (`--segment-seconds`, default 170, floor 5, ceiling 180 — screenrecord's own hard cap), and the
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
- **`--guard-app <pkg>` — the foreground watchdog.** A flow only knows what its selectors can see,
  and "covered by another app" satisfies most of them. `extendedWaitUntil: { notVisible: "Building…" }`
  returns COMPLETED the moment a neighbouring app draws over the screen, so a take can end on
  someone else's login screen with every step green and this tool printing a duration and exiting
  0. That has happened, and it cost a four-minute generation. Maestro cannot notice it; filmkit
  owns the recorder, so it is the only layer that can.

  Name a package to guard — `--guard-app <pkg>`, or just `--app <pkg>` if you were already passing
  it for `--fresh` — and the whole recording window is sampled every 1.5s via
  `dumpsys activity activities | grep topResumedActivity`. Before rolling it also checks who is in
  front and **warns** if it isn't the guarded app; only warns, because a flow's own `launchApp` is
  entitled to fix that a second later. If anything else takes the foreground during the take you
  get `[foreground] INTERLOPER <pkg> at <t>s` on the spot, a summary block after the flow, `status:
  "interloper"` in the sidecar, a non-zero exit, and no `-tight.mp4` (a polished variant beside a
  dead take is exactly how the original one looked finished). The recording is **not** killed —
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
  video: a `status` (`ok`, `truncated`, `interloper`, `flow-failed`, `interrupted`, `failed`), flow
  path and SHA-256 of its contents, argv, device serial and build fingerprint, requested vs. actual
  size, bit rate, each segment's wall/container/timeline durations, whether it was dropped and why,
  recorder warnings, the stitch's planned-vs-actual check, raw duration, tighten statistics, and
  any files a failed run left behind. A guarded run adds `foreground`, one row per change of
  foreground app timestamped from the moment the recorder started, so it lines up with the video
  itself — an undisturbed take contributes exactly one row. `flowSucceeded: true` alongside
  `status: "interloper"` is the whole failure mode in two fields. It is written on the failure paths too, so a `demo/raw/`
  tree still explains itself months later, when two takes turn out to have come from different
  revisions of the same flow. A run that dies in preflight or device setup writes none. Nothing
  was filmed, and an earlier take's sidecar must not be clobbered by a run that never rolled.
- **Every recording carries a head and a tail you didn't author.** 1.5s of warmup so the recorder
  is really running before Maestro's first tap, Maestro's own JVM startup (4-6s here), and 2s of
  finalize after the flow ends so the on-device mp4 closes cleanly. Measured: a flow whose only
  authored hold was 20s came out as a 30.4s recording. Budget it on duration-constrained shots.
  The run prints the finished duration, so one take tells you your own number.
- `--fresh` runs `pm clear` right before recording → beat 0 is a true fresh first run.
- SIGINT (not SIGKILL) stops `screenrecord` — it's what makes the on-device mp4 finalize instead
  of truncating. The tool handles this; don't "fix" it to SIGTERM. Your own Ctrl-C is handled the
  same way: it stops the recorder, pulls, stitches and writes the sidecar before exiting 130,
  instead of abandoning a live `screenrecord` on the device with the segments still on it.
- A failed flow still saves the partial recording for debugging (exit code stays non-zero). So
  does a recording that ends early, one interrupted with Ctrl-C, and one that lost a segment. If a
  segment dies on its own, the chain stops instead of respawning forever, names the segment and
  its wall time, and exits non-zero rather than reporting a truncated take as a success.

### Maestro flow idioms (hard-won)

- **Pause primitive**: Maestro has no fixed-duration sleep. Every pause is
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
  is not fixable in the flow — pass `--guard-app <pkg>` so the recorder notices instead.
- **Selectors**: visible text / accessibility labels (what `maestro hierarchy` reads), never
  coordinates. Debug with `maestro hierarchy`.
- **Replace text cleanly**: `inputText` APPENDS at the cursor; `eraseText` is unreliable in
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

- **Simulator only** — filming hardware iPhones needs a different capture path entirely; this
  tool doesn't attempt it.
- `--fresh` uninstalls the app (the only true data wipe on iOS) and therefore requires
  `--install` to bring it back.
- `--clean-status-bar` overrides the clock to 9:41, full battery/signal — and clears the
  override after the run.
- No 180s cap here (unlike Android); recording writes straight to disk on the host.
- Boot readiness uses `bootstatus -b`: a bare "(Booted)" status can precede Springboard being
  responsive.

## Tightening (dead-air cut)

Both device cameras and the web camera take `--tighten`; standalone use:

```sh
node tighten.mjs out/my-demo-android.mp4 --dry-run   # start here: plan only, no encode
node tighten.mjs out/my-demo-android.mp4
node tighten.mjs out/my-demo.mp4 --min-still 1.0 --keep 0.4 --noise -50dB
```

Two ffmpeg passes: `freezedetect` finds visually-static stretches (load waits, inter-action
safety windows, settle pauses); each one is **clamped to `keep` seconds (default 0.6)** rather
than removed outright — a demo cut edge-to-edge reads as broken, not snappy. Stretches shorter
than `--min-still` (default 1.2s) are left untouched. Nothing found → prints "already tight" and
writes nothing. The raw file is never replaced; a `-tight` variant is written alongside it.

**Reach for `--dry-run` whenever a result looks wrong.** It prints the freeze table and the
planned keep-segments — start, end, and whether each is motion or a clamped beat — then exits
without encoding, so it costs one decode instead of a full re-encode.

Four things worth knowing:

- **Sensitivity is calibrated per recorder** (`--noise auto`, the default), because one dB
  threshold cannot serve both cameras. The web camera records through Chromium + x264, where
  every frame carries fresh quantization noise, so "static" frames are not identical and the
  tuned `-60dB` threshold is right. Device recorders (`adb screenrecord`, `simctl recordVideo`)
  are frame-exact — while the screen doesn't change the encoder emits no new content — so their
  noise floor is zero, and there `-60dB` is a blindfold rather than a safe default: it ignores
  every change smaller than 0.1% of the frame, which on a 960x2136 phone screen is most of the
  UI. Tighten runs both probes, reports which mode it picked and why, and on frame-exact footage
  detects at `n=0`, where **any** nonzero frame difference counts as motion. Pass an explicit
  `--noise -60dB` to force the threshold and skip the choice.
- **Sanity floor**: if the plan keeps under 25% of a clip longer than 5s, or lands under 2s, the
  run prints a warning naming the likely cause — and writes the file anyway. You decide; the tool
  only refuses to be quiet about it.
- **Which end survives**: the FIRST `keep` seconds of each freeze. Every frame inside a freeze
  is identical by definition, so the only choice is rhythm — keeping the leading edge reads as
  "the action lands, we hold a beat, then cut".
- **VFR gotcha**: these recordings are genuinely variable-frame-rate (no new frame while
  nothing changes, plus authored multi-second durations on static frames). Naive
  `trim`+`concat` either collapses the kept beat to near-zero or overshoots by seconds.
  `tighten.mjs` resamples to constant fps up front and uses the classic `select`+`setpts`
  idiom — see its header comment for the full story before touching it.

Expect one consequence of frame-exact detection rather than debugging it. A screen with a live
element, a progress timer counting seconds or the status-bar clock, *is* motion, and tighten keeps
it at full length. That is the honest reading of the footage, and it is why a 147s "Making it"
progress take tightens to 76s rather than to nothing. Compressing that stretch anyway is an
editorial call, not a detection one. `--noise -60dB` gives you the old change-must-be-big
behaviour, with the sanity-floor warning attached.

## Which camera when

- **Feature-proof videos in agent loops, CI, retakes, polish** → web camera. Fast,
  deterministic, cursor + captions, runs anywhere Chromium runs.
- **Real product demos of a mobile app** → device cameras. Only they film the real thing;
  budget the emulator/simulator cold start.
- Pacing philosophy differs: the web camera *simulates* human pacing deterministically; device
  footage is paced by the real device. Don't add fake cursor overlays to device video — if a
  touch indicator is wanted on Android, use the OS "Show taps" developer setting, not fakery.

## Output & scratch dirs

`out/` is build output — gitignored, regenerated on every run.
