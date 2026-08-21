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
```

Pipeline: preflight → device → install/fresh → screenrecord → maestro → pull → remux → tighten.
Details that matter:

- `--fresh` runs `pm clear` right before recording → beat 0 is a true fresh first run.
- SIGINT (not SIGKILL) stops `screenrecord` — it's what makes the on-device mp4 finalize instead
  of truncating. The tool handles this; don't "fix" it to SIGTERM.
- **180s cap**: `screenrecord` hard-stops at three minutes. Keep flows comfortably under that.
- A failed flow still saves the partial recording for debugging (exit code stays non-zero).

### Maestro flow idioms (hard-won)

- **Pause primitive**: Maestro has no fixed-duration sleep. Every pause is
  `extendedWaitUntil: { visible: "<never-appears-marker>", timeout: <ms>, optional: true }`.
  Blocks for the full timeout; `optional: true` keeps the exit code 0.
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
node tighten.mjs out/my-demo-android.mp4
node tighten.mjs out/my-demo.mp4 --min-still 1.0 --keep 0.4 --noise -50dB
```

Two ffmpeg passes: `freezedetect` finds visually-static stretches (load waits, inter-action
safety windows, settle pauses); each one is **clamped to `keep` seconds (default 0.6)** rather
than removed outright — a demo cut edge-to-edge reads as broken, not snappy. Stretches shorter
than `--min-still` (default 1.2s) are left untouched. Nothing found → prints "already tight" and
writes nothing. The raw file is never replaced; a `-tight` variant is written alongside it.

Defaults were tuned against real footage, not guessed (an 81s Android recording tightened to
~24s with zero tuning at the defaults). Two subtleties worth preserving:

- **Which end survives**: the FIRST `keep` seconds of each freeze. Every frame inside a freeze
  is identical by definition, so the only choice is rhythm — keeping the leading edge reads as
  "the action lands, we hold a beat, then cut".
- **VFR gotcha**: these recordings are genuinely variable-frame-rate (no new frame while
  nothing changes, plus authored multi-second durations on static frames). Naive
  `trim`+`concat` either collapses the kept beat to near-zero or overshoots by seconds.
  `tighten.mjs` resamples to constant fps up front and uses the classic `select`+`setpts`
  idiom — see its header comment for the full story before touching it.

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
