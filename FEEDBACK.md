# filmkit — friction log

Written while filming two shots of the Whim product demo (storyboard shots 10 and 11) with the
Android camera: 4 real takes plus rehearsals, against `emulator-5554` (Pixel-class AVD, native
1344x2992, Android 17 emulator image), macOS host, `maestro` and `ffmpeg` from Homebrew.

Every entry is something that actually happened during that session. Where a candidate problem
turned out to be a Maestro or Android limitation rather than a filmkit one, it says so.

---

## 1. No `--size`, and screenrecord's fallback warning is thrown away (bug + missing feature)

**Wanted:** record at the resolution the rest of the capture set already uses (960x2136).

**Happened:** filmkit has no size flag, so it records at the device's native resolution. This
AVD's AVC encoder cannot be configured that large. Run by hand, `screenrecord` says so:

```
$ adb -s emulator-5554 shell screenrecord --bit-rate 8000000 --time-limit 5 /sdcard/probe.mp4
ERROR: unable to configure video/avc codec at 1344x2992 (err=-22)
WARNING: failed at 1344x2992, retrying at 720x1280
```

Through filmkit you see none of that. `startScreenrecord` spawns with `{ stdio: 'ignore' }`, so
both lines are discarded. Confirmed empirically on an unpatched copy — the full console output
for a run was:

```
[film-android] starting screen recording...
[film-android] running maestro test .../probe-nosize.yaml...
[film-android] stopping screen recording...
[film-android] pulling /sdcard/filmkit-demo.mp4...
[film-android] finalizing .../probe-nosize-android.mp4...
[film-android] Demo video written: .../probe-nosize-android.mp4

$ ffprobe -select_streams v:0 -show_entries stream=width,height ...
720,1280
```

A clean exit, an encouraging success line, and a file at 30% of the intended pixel count. On a
multi-day capture set where takes have to intercut, that is the expensive kind of quiet: you
find out in the edit.

**Did instead:** patched `film-android.mjs` to add `--size <WxH>`, threaded through to
`screenrecord`, with a `^\d+x\d+$` check at parse time and the chosen size echoed in the
"starting screen recording" line. Filmed everything at `--size 960x2136 --bit-rate 20000000`.

**Fix:** keep the flag. Separately, stop swallowing the recorder's stderr — capture it and
either surface it or, better, fail loudly on `unable to configure video/avc codec`, since a
silent downscale is never what the caller wanted. A `--size native` default with an explicit
"encoder refused 1344x2992, fell back to 720x1280" warning would have cost me nothing to
notice. Bonus: after recording, compare the output's actual geometry against what was requested
and warn on mismatch — that catches this class of failure without parsing anyone's stderr.

**Status:** fixed — the flag stayed and both nets are in. The recorder gets a piped stderr now,
and every non-empty line is echoed as `[screenrecord] segNNN: <line>`. After finalizing, filmkit
checks the file's geometry against `--size` (or, without it, against what `wm size` reports) and
prints a three-line warning naming both resolutions when they differ. I re-ran your case on the
same AVD with no `--size`. Both the `err=-22` line and the `retrying at 720x1280` line show up in
the console now, followed by `RESOLUTION MISMATCH: recorded at 720x1280, but the device reports
1344x2992`. The sidecar keeps them too (#9). One thing left undone: filmkit still doesn't fail
hard on the fallback. The warning is loud, the exit code stays 0.

---

## 2. Every run writes the same filename; take 2 silently overwrites take 1 (missing feature)

**Wanted:** three takes of shot 10, laid out as the storyboard demands —
`demo/raw/10-fork-divergence/take-{1,2,3}.mp4`.

**Happened:** filmkit names output from the flow file: `out/<flow>-android.mp4`. Running the same
flow again overwrote the previous take with no warning. Nothing was lost only because I copied
each take out of `out/` before starting the next one — that is a discipline the tool leaves
entirely to the operator, on a task whose whole premise ("3+ takes, never delete a take") is that
takes are precious.

**Did instead:** a manual `cp out/<flow>-android.mp4 demo/raw/<shot>/take-N.mp4` (and the same
for `-tight`) after every single run, tracking N in my head.

**Fix:** any one of these would have done it, roughly in order of preference:

- `--take <n>` → `out/<flow>-android-take-<n>.mp4`; or `--take auto` to pick the next free N.
- `--out-file <path>` for full control of the destination, so a flow can be filmed straight into
  a storyboard's directory layout without a copy step.
- At minimum, refuse to clobber an existing output unless `--force` is passed.

Filming is inherently a repeated activity. Being take-aware is close to the tool's core job, and
right now it is the one part of the job the tool doesn't do.

**Status:** fixed — the last two of your three, which together cover the first. `--name <basename>`
sets the output stem (`<basename>.mp4`, `<basename>-tight.mp4`, `<basename>.json`) and combines
with `--out <dir>`, so your storyboard layout is one command and no copy step:
`--out demo/raw/10-fork-divergence --name take-2`. An existing output is refused outright unless
you pass `--force`, and the check runs in preflight, before the device is touched, so a mistaken
re-run costs nothing and clobbers nothing. I skipped `--take auto`. Guessing the next number is
the storyboard's business, not the camera's.

---

## 3. `--tighten` has no per-run knobs and no sanity floor (bug, or at least a bad default)

**Wanted:** the tightened variant alongside each raw take, per the deliverable.

**Happened:** at the defaults, tighten does not so much cut dead air as remove the shot.

| take | raw | tightened | cuts |
|---|---|---|---|
| shot 10 take 1 | 70.59s | 8.63s | 9 |
| shot 10 take 2 | 70.37s | 8.10s | 9 |
| shot 10 take 3 | 71.53s | 8.57s | 9 |
| shot 11 take 1 | 19.45s | 2.10s | 2 |
| shot 11 take 2 | 14.62s | 0.60s | 1 |

The last row is the clearest: a deliberately-held closing grid shot, 14.6s of a screen that is
supposed to be still, reduced to a single 0.6s beat — i.e. one clamped freeze and nothing else.
Shot 10 is worse in kind if not in degree: the storyboard specifies it as *real-time, no internal
cuts*, and tighten put nine cuts in it.

This is not new to my session. Every `-tight` file already in this project's `demo/raw/` shows
the same collapse — 147.4s → 0.63s, 180.9s → 0.63s, 110.9s → 1.50s, 104.6s → 0.63s. The Android
camera has apparently never produced a usable tightened file here.

Root cause is structural, not a tuning miss: `--min-still 1.2` / `--keep 0.6` mean *every* held
beat over 1.2s is clamped to 0.6s, and a demo of a real device is mostly held beats. The web
camera's synthetic pacing presumably fares better; device footage does not.

**Did instead:** kept the `-tight` files because they were asked for, and flagged them as unusable
for these two shots. Cutting will be done from the raws.

**Fix:** two independent things.

1. **Pass the knobs through.** `tighten.mjs` already accepts `--min-still`, `--keep` and
   `--noise`, and they are documented in the README, but `film-android.mjs` calls
   `tighten(outPath)` with no options object, so none of them are reachable from a filming run.
   Forwarding them is a two-line change and would have let me try `--keep 2.0` without a second
   command.
2. **Add a floor, or at least a warning.** When a pass removes 88% or 96% of a video, that is
   almost certainly wrong, and the tool is in a better position to notice than the operator is:
   "tightened 14.62s -> 0.60s (removed 96%) — this is unusually aggressive, consider
   `--keep`/`--min-still`" costs one `if`.

Related, smaller: there is no way to say "film it, and give me both, but don't tighten *this*
run". `--tighten` is opt-in so the inverse isn't needed — but a `--tighten-keep 2.0` style
passthrough covers it, and see #4 for why I wanted to iterate on tightening without re-filming.

**Status:** fixed — two defects compounded: `freezedetect n=-60dB` is blind to the small,
localized text changes that make up most of a phone screen, so it reported device footage as a
chain of *abutting* freezes covering the whole timeline, and `normalizeFreezes` merged intervals
that merely touched, folding that chain into one freeze whose single clamped beat became the
entire output.

Evidence, on `demo/raw/4-build-transmute/take-1.mp4` (147.4s → 0.63s):

- At `-60dB` freezedetect reports six freezes — `0→5.033, 5.033→13.167, 13.167→38.167,
  38.167→46.700, 46.700→74.667, 74.667→EOF` — each starting exactly where the previous ended,
  because a screen repaint has no duration on a device recorder. Merging on `start <= last.end`
  turns all six into `[0, 147.41]` and the plan degenerates to one 0.6s segment. That is exactly
  the observed 0.63s, and the same arithmetic reproduces shot 10 take 2's 8.10s to the centisecond
  (nine merged groups out of seventeen freezes).
- The 25-second "freeze" from 13.2s to 38.2s covers a *visibly animating* progress screen: a timer
  line reading "0:15 · 0 characters so far / Quiet for 15s" ticks every 1.017s. Measured per-frame
  mean difference for one tick is ~0.03 of a 0..255 level — about -78dB, well under the -60dB
  (0.255) threshold. Meanwhile the recorder is frame-exact: during genuinely static stretches
  consecutive frames differ by exactly 0. The threshold sat *below* the real signal and *far
  above* the noise floor, the worst available place.

Fix: merge only on genuine overlap (`start < last.end`), and calibrate sensitivity per recorder —
probe at `n=0` alongside the dB threshold in the same ffmpeg pass, and if the exact probe finds
≥25% of the clip bit-identical, the recorder is frame-exact and detection runs at `n=0`, where any
nonzero frame difference is real motion. The separation is not a close call: 0% on the web
camera's x264 output versus 51%, 92% and 100% on three unrelated `screenrecord` takes.

| file | raw | before | after |
|---|---|---|---|
| shot 4 take 1 | 147.41s | 0.63s | 75.97s |
| shot 10 take 2 | 70.37s | 8.30s | 21.07s |
| shot 11 take 2 | 14.62s | 0.63s | 1.30s |
| `out/tip-demo.mp4` (web) | 25.36s | 13.70s | 13.70s, byte-identical output |

Shot 11 is the interesting row: it stays short because the take really is static end to end — five
coded frames in 14.6s, and the two swipes moved nothing a five-tile grid could scroll. That is now
the **sanity floor's** job rather than a silent collapse: under 25% kept on a clip over 5s, or
under 2s outright, prints a warning naming the suspected cause and writes the file anyway. Also
added `--dry-run`, which prints the freeze table and the keep-segment plan without encoding — the
right first command when a tighten result looks wrong.

Not done here: forwarding the knobs from `film-android.mjs` (part 1 of your Fix). That file was
being edited concurrently.

---

## 4. Authored duration and recorded duration are ~7.6s apart, undocumented (missing feature)

**Wanted:** shot 11 in an 8–15s window, per the shot brief.

**Happened:** I authored 11.8s of beats (`3800 + 1500 + 1200 + 1500 + 3800` ms) and got a
**19.45s** recording. The 7.65s gap is `RECORD_WARMUP_MS` (1500) + `RECORD_FINALIZE_MS` (2000) +
however long the Maestro JVM takes to boot and connect, which was around 4s here. All of it lands
in the file as extra static frames at the head and tail.

The README never mentions this, and the two constants are internal. For a shot whose entire spec
is a duration window, the flow file's arithmetic is simply the wrong number and there is no way to
know that without filming once and measuring.

**Did instead:** filmed take 1, measured the overhead, then re-authored the flow with the holds
cut to 6.4s of beats to land at 14.62s recorded, and wrote the measured constant into the flow
file's header comment so the next person doesn't rediscover it.

**Fix:** print it. `[film-android] recorded 19.45s (flow 11.80s + 7.65s warmup/startup/finalize)`
would have saved the whole round trip. Beyond that, `--trim-head <sec>` / `--trim-tail <sec>`, or
a `--target-duration` that reports how far off you landed, would make duration-constrained shots
authorable in one pass. This is genuinely filmkit's problem, not Maestro's: filmkit chooses when
to start and stop the recorder.

**Status:** partly fixed — the numbers get printed, the trimming doesn't exist. Every run reports
each segment's wall-clock duration as it ends, the recording total, and the finished file's
duration on the "Demo video written" line. The sidecar (#9) keeps all of it. So one run tells you
your overhead, instead of one run plus a measurement. Nothing splits it into flow vs. warmup vs.
JVM startup, and there is still no `--trim-head`, `--trim-tail` or `--target-duration`.

One caveat on treating authored beats as a fixed baseline at all. While verifying the segment
chain I found that `extendedWaitUntil` does not block for its timeout in every context (Maestro
2.6.0, Android 17 emulator). Alone in a flow it is exact, honoring 5s, 20s, 30s and 40s. In a flow
that also runs `launchApp`, the same wait came back after ~7-8s whatever timeout it was given, and
inside a `repeat:` block after ~0.5s. Nothing reports the difference. So "recorded minus authored"
is not always overhead. Sometimes the beats themselves didn't run for what they say. `runScript`
with a busy loop held for exactly what it was told every time, and is what the long-flow
verification ended up using.

---

## 5. The 180s cap is real, is hit in practice, and is never reported (bug)

**Wanted:** confidence that a long take is a whole take.

**Happened:** not to me — my takes ran 70s and the cap was never in play, so as a *risk* for these
shots the README's warning is accurate and sufficient. But this repo's existing footage contains
`demo/raw/4-build-transmute/take-2.mp4` at **180.898s**, which is `screenrecord` hitting its hard
stop and truncating the flow mid-run. Reading `main()`, filmkit never inspects the output's
duration, so that run exited 0 and printed the normal "Demo video written" line. A truncated take
is indistinguishable from a finished one until someone watches it.

**Fix:** after `finalizeVideo`, if the duration is within a second or so of 180s, print a loud
warning that the recording was almost certainly cut off by the cap and the tail of the flow is
missing. Cheap, and it turns a silent data-loss failure into a visible one. (Chaining recordings
to actually exceed the cap is a much bigger change and I would not ask for it.)

**Status:** fixed — by the change you said you wouldn't ask for. The cap can't truncate a take any
more, because a recording is a chain now. Each segment runs `screenrecord --time-limit`
(`--segment-seconds`, default 170), the next starts the moment the previous recorder exits, and
the segments are stitched into one file at the end. Verified against a 220.9s flow on
`emulator-5554`, which came back as two segments stitched into a single continuous 220.1s stream.
The seam costs the ~0.3s of the adb round trip, and it is documented rather than hidden. The same
flow forced into five 20s segments landed at 99.3s against 100.6s of wall clock, so seams don't
accumulate drift. `demo/raw/4-build-transmute/take-2.mp4` would have come out whole. Your narrower
ask is covered too. A segment that dies on its own stops the chain, names itself and its wall
time, and exits non-zero, so a truncated take can't report success any more.

Chaining brought three new ways to lose a take, all found by a later review pass and all closed
now.

1. The pull loop treated the chain as one unit. Any segment that failed to pull or probe exited
   the whole run, so a last segment stopped within a second of spawning (no moov atom, no packets,
   which is the ordinary shape of the final link) could take four good ones down with it. Segments
   are validated one at a time now. An empty trailing one is dropped with a note; an unusable one
   anywhere else is stitched around and the take is reported truncated. Either way the pulled
   `.name.segNNN.mp4` files stay on disk and the run prints where they are.
2. The stitch was believed on ffmpeg's exit code, which is 0 even when it prints `Non-monotonic
   DTS` and scrambles the timeline. The concat's stderr is scanned for that now, and the finished
   duration is compared against the timeline the directives planned. Either one off prints a
   warning and lands in the sidecar.
3. There was no SIGINT handler, so Ctrl-C killed the process where it stood and left a live
   `screenrecord` on the device with every segment still on it. Ctrl-C now runs the same
   stop → pull → stitch → sidecar path and exits 130.

---

## 6. The two-pass workflow prescribes `maestro hierarchy`, but nothing makes it readable (missing feature)

**Wanted:** find the selectors for Whim's launcher tiles, long-press sheet, version-history rows
and confirm sheet — filmkit's own documented step 1, "explore off-camera".

**Happened:** `maestro hierarchy` on a single screen emitted **2341 lines** of pretty-printed
JSON. Each node carries fifteen attributes and the useful ones (`text`, `accessibilityText`,
`bounds`, `clickable`) are scattered among boilerplate. Roughly forty nodes on that screen had any
text at all.

I wrote this and used it perhaps thirty times over the session:

```sh
maestro --device "$DEV" hierarchy | jq -r '
  [recurse(.children[]?) | select(.attributes != null) | .attributes
   | select((.text // "") != "" or (.accessibilityText // "") != "")]
  | .[] | "\(.text)\t| a11y=\(.accessibilityText)\t| \(.class)\t| \(.bounds)\t| click=\(.clickable)"'
```

Which turns the same screen into 40 lines that read like a shot list:

```
	| a11y=HT, HT, Habit Tracker	| ViewGroup	| [66,914][441,1349]	| click=true
Habit Tracker	| a11y=	| TextView	| [66,1307][282,1349]	| click=false
Forked from Habit Tracker	| a11y=	| TextView	| [483,1349][858,1405]	| click=false
```

**Fix:** ship it. `node film-android.mjs --hierarchy --device <serial>`, or a
`tools/hierarchy.mjs`, printing exactly that table. It is ~10 lines, it needs no dependency
(`JSON.parse` + a recursive walk beats shelling out to `jq`), and it belongs here rather than in
every user's shell history, because filmkit is the thing that told them to run `maestro
hierarchy` in the first place. Two flags worth having: `--clickable-only`, and `--diff` against
the previous dump so you can see what a tap changed.

Honest caveat: the verbosity is Maestro's. The gap is that filmkit owns the exploration workflow
in its README and then hands you off to a raw tool.

---

## 7. "Hold still N seconds" and "scroll slowly" — mostly refuted (would-have-been-faster)

Both were on my list of suspected gaps. Both turned out fine:

- The README's pause primitive (`extendedWaitUntil` on a never-appearing marker with
  `optional: true`) is documented clearly, works exactly as described, and I used it in every
  beat of both flows. The `optional: true` detail in particular would have cost real time to
  rediscover.
- Slow scrolling is native Maestro: `swipe: { start: 50%, 75%, end: 50%, 55%, duration: 1200 }`.
  No gap.

The only residue: each pause is four lines of YAML plus a magic string every project invents for
itself (`__filmkit_demo_pause_marker__` in the example, `__whim_pause__` in mine). A documented
canonical marker constant, or a tiny preprocessor turning `- hold: 2200` into the
`extendedWaitUntil` block, would tidy flows that are mostly pauses by volume — mine were about
half pause lines. Low priority, and I would not take a preprocessor that made the flow files stop
being valid Maestro YAML.

---

## 8. README accuracy (doc bug)

Three things in `README.md` that were wrong or missing at the point I needed them:

1. **The tighten claim doesn't generalize.** "Defaults were tuned against real footage, not
   guessed (an 81s Android recording tightened to ~24s with zero tuning at the defaults)." My five
   runs came out at 12%, 11%, 12%, 11% and 4% of their input duration, and this project's four
   pre-existing Android `-tight` files at 0.4%, 0.3%, 1.4% and 0.6%. Whatever that 81s recording
   was, it is not representative of device footage of a real app. The sentence reads as a
   reliability guarantee and it should read as "these defaults suit dense, action-per-second
   flows; long held beats need `--keep` raised" (see #3).

   **Status:** fixed — that sentence was measuring a broken detector, not a tuning choice (see
   #3's status), so I deleted it rather than softening it. The Tightening section now documents
   per-recorder calibration, the sanity floor, `--dry-run`, and the one case that still looks
   surprising on purpose: a live progress timer counts as motion and is kept at full length.
   Points 2 and 3 of this item are untouched. They belong to the Android section, which was being
   edited concurrently.
2. **No mention of head/tail recording overhead** (see #4). The 180s cap is called out, which is
   good, but the ~7.6s floor on any recording is not, and it matters far more often.

   **Status:** fixed — the Android section names all three pieces now (1.5s warmup, Maestro's JVM
   startup at 4-6s here, 2s finalize), with a measured example of 20s authored and 30.4s recorded.
   The 180s paragraph it sits next to is gone, replaced by segment chaining (#5).
3. **No mention that the encoder can refuse the native resolution** (see #1) — now at least
   partly addressed by the `--size` doc comment I added to `film-android.mjs`. The README's
   Android flag list should pick it up too.

   **Status:** fixed — `--size` has its own bullet in the Android section, with the `err=-22` line
   quoted and the quiet 720x1280 fallback spelled out, next to the two nets that catch it (#1).
   The same list documents `--name`, `--force`, `--segment-seconds` and the sidecar.

Also cosmetic: the install block lists `node film-android.mjs` as if it were a runnable command
demonstrating "no npm install needed". With no arguments it prints usage and exits 1. Fine as a
gesture, mildly confusing as a copy-paste.

---

## 9. Nothing records what produced a given take (missing feature)

**Wanted:** to know, a week from now, which flow revision produced
`demo/raw/11-closing-grid/take-1.mp4` — because take 1 and take 2 of that shot were filmed from
*different* revisions of the same flow file (I retuned the holds between them, per #4), and the
flow file now on disk only matches take 2.

**Happened:** the output is a bare `.mp4`. Device serial, recording size, bit rate, flow path,
flow contents, and the tighten statistics all exist inside the run and none of them survive it.

**Did instead:** wrote the reasoning into the flow file's header comment and into my report.
Neither is attached to the video.

**Fix:** write a sidecar `<flow>-android.json` next to the video: flow path and a hash of its
contents, device serial and `ro.build` fingerprint, requested vs. actual size, bit rate, wall
duration, flow duration, tighten input/output durations and cut count, and the filmkit commit.
Small, mechanical, and it makes a `demo/raw/` tree self-describing months later.

**Status:** fixed — every run that reaches the camera writes `<name>.json` beside the video,
failure paths included. It holds a `status` (`ok`, `truncated`, `flow-failed`, `interrupted`,
`failed`) and the error that produced it, the flow path and the SHA-256 of its bytes (the thing
that would have told your two takes apart), the full argv, an ISO timestamp, device serial and
`ro.build.fingerprint` and native size, requested vs. actual geometry, bit rate, segment and seam
count, each segment's wall / container / stitched-timeline duration and packet count alongside any
`[screenrecord]` warnings it printed and whether it was dropped and why, the stitch's
planned-vs-actual duration check, the finished duration, tighten's output path, *probed* duration,
cut count and seconds removed, and the paths of anything a failed run left behind. The one field I
left out is the filmkit commit. Reading git would make this a four-tool dependency, and argv plus
the flow hash already pin the interesting half.

A correction to how this entry was originally written. It claimed the sidecar landed on *every*
failure path, and two paths wrote nothing. Both are deliberate now instead of accidental. Any
failure after RECORD_START writes one, which is the case you cared about and the one that was
actually broken: a pull or stitch failure exited before reaching the writer. A failure in
preflight or device setup writes nothing at all, because nothing was filmed and an earlier take's
sidecar must not be clobbered by a run that never rolled. The header comment and the README say
that now rather than promising every path.

---

## What worked, unprompted

Worth saying, since the rest of this is complaints:

- **`--device <serial>` and running-device reuse** did the right thing every time; no ceremony
  around an already-booted emulator.
- **The Maestro idioms section is the most valuable part of the README.** The pause primitive,
  "selectors by visible text, never coordinates", and the `inputText` APPENDS warning are all
  real, all hard-won, and all things I would otherwise have burned an hour on each.
- **SIGINT-not-SIGTERM to finalize the on-device mp4** — the code comment explaining *why* is
  exactly the sort of thing that stops a future maintainer from "fixing" it. Every one of my
  recordings finalized cleanly.
- **A failed flow still saves its partial recording.** I didn't need it in the end, but knowing
  it during rehearsals meant I could film speculatively instead of validating everything first.
- **The flow-file-as-shot-list premise holds up.** Both of my flows are reviewable as source and
  re-filmable verbatim, which is the whole reason this beats driving the emulator by hand.

---

## Patch applied during this session

`film-android.mjs` only, additive, no behavior change when the flag is absent:

- `--size <WxH>` parsed, validated against `^\d+x\d+$`, defaulted to unset.
- Threaded into `startScreenrecord`, which appends `--size <WxH>` to the `screenrecord`
  argv when set.
- Usage string and the file's header comment updated; the header now documents the
  `err=-22` / silent-720x1280 failure mode.
- The "starting screen recording" log line now states the size, or "at native resolution".

Everything in #1's "Fix" beyond the flag itself — surfacing the recorder's stderr, verifying the
output geometry — is left undone.


---

# Second session, 2026-08-23, storyboard shots 1 to 11

A full master capture set for the same Whim demo: eleven shots, sixteen runs, two of them
five-minute live LLM generations. Same AVD (`emulator-5554`, Android 17, native 1344x2992), same
`--size 960x2136 --bit-rate 20000000 --tighten` on every run. The `--name`, `--force`, sidecar and
segment-chain work from the last round all held up, and there is an addendum at the bottom saying
what each was worth. What follows is new.

---

## 10. A flow can pass while the take is dead (bug, the expensive kind)

**Wanted:** a 226-second take of an app being generated, ending on the tile transmuting from
"Building…" into the finished app.

**Happened:** the emulator was shared with another session, which foregrounded an unrelated app one
second before the tile landed. The flow's wait for that moment was

```yaml
- extendedWaitUntil:
    notVisible: ".*Building.*"
    timeout: 720000
```

and being covered by another app *satisfies* `notVisible`. Maestro reported every step COMPLETED,
filmkit printed `Demo video written: … (226.03s)` and exited 0, and the tightened variant was
written alongside it. The take is unusable. Its last seven seconds are someone else's login screen.

Two earlier takes died to the same neighbour more visibly. One because the other app was in front
when the recorder rolled, which failed on the first assert. One because its ANR dialog stole focus
mid-`inputText` and Maestro's driver hit a 120s gRPC deadline. Those two announced themselves. This
one did not, and it is the one that cost a generation.

**Did instead:** `adb shell am force-stop <other.package>` immediately before every roll,
`settings put global hide_error_dialogs 1` to keep ANR dialogs off the footage, and a
frame-by-frame check of every take afterwards (see #11), which is how the dead take was caught.

**Fix:** filmkit owns the recorder, so it is the only layer that can notice this.

- **Preflight.** Refuse to roll unless `appId` is the resumed activity, the same way an existing
  output is refused before the device is touched. `dumpsys activity activities | grep
  topResumedActivity` is one `adb` call and would have saved take 3 outright.
- **Watchdog.** Sample the foreground package every second or two while recording. If it leaves
  `appId` and comes back, note the interval in the sidecar. If it is not `appId` when the flow
  ends, say so loudly and exit non-zero. A take that was interrupted is not a take, and the
  operator has no other way to find out short of watching all 226 seconds.

Neither needs to be perfect. Anything that turns "silently green" into "loudly suspect" is worth
more here than accuracy.

**Status:** fixed — both halves, behind `--guard-app <pkg>` (defaulting to `--app` when you already
passed it) plus `--guard-strict`. Preflight reads the foreground and warns when it isn't the
guarded app, which is take 3. The watchdog samples `topResumedActivity` every 1.5s for the whole
recording window, writes every change into a `foreground` array in the sidecar timestamped against
the recorder, prints `[foreground] INTERLOPER <pkg> at <t>s` the moment it sees one, and ends the
run with `status: "interloper"` and a non-zero exit. It does not kill the recording — you may still
want the footage — but it does skip `--tighten`, because a polished variant beside a dead take is
how this one looked finished. `--guard-strict` stops the flow instead: measured 0.19s from sighting
to the recorder stopping, with the partial take pulled and stitched as usual.

Checked against the real failure rather than assumed. Foregrounding Settings 15s into a 33s take
produced `flowSucceeded: true` and `status: "interloper"` in the same sidecar, which is this entry
in two fields. A clean control run of the same flow exited 0 with one `foreground` row.

The system-UI carve-out you asked for turned out to be mostly unnecessary, which is the part worth
recording. `topResumedActivity` tracks *activities*, and the shade and the keyboard are *windows*.
Opening the notification shade leaves `topResumedActivity` on the app under film and only moves
`mCurrentFocus` to `Window{… NotificationShade}`; the IME does the same. Neither can produce a
false positive at all, so the allowlist only has to name system surfaces that really are
activities: SystemUI's own, the permission dialog, and the IME packages for the devices that might
route one through an activity. Two things stayed off it on purpose. The launcher, because home
showing means the app got backgrounded, which is the failure and not an exception to it. And the
bare `android` package, where the share sheet and the ANR dialog live. Your second dead take was an
ANR, and that is the list that would have had to miss it.

Not addressed: the live INTERLOPER line prints from under `maestro test`, which inherits stdio and
redraws with ANSI escapes, so it can be scribbled over. Rather than fight that, every guarded run
also prints a summary block after the flow and ends on the interloper line, and the sidecar carries
the same facts. Three channels, since the point of this entry is that one silent channel cost a
generation.

---

## 11. Nothing helps you verify a take, on a workflow whose whole premise is verifying takes (missing feature)

**Wanted:** to answer, for each of sixteen runs, "does this contain the moment it was supposed to
contain, uninterrupted?" That is the brief's own acceptance criterion and the reason takes are
numbered at all.

**Happened:** filmkit hands you an `.mp4` and a duration. Everything else was hand-rolled, the same
three commands sixteen times:

```sh
ffmpeg -i take-5.mp4 -vf fps=1 frames/%03d.png                 # 226 PNGs
for f in frames/*.png; do echo "$f $(md5 -q $f)"; done \
  | awk '{if($2!=prev)print $1; prev=$2}'                      # when did the screen change?
python3 -c "…mean brightness per frame…"                       # did something dark cover it?
```

The md5 pass is the one that matters. On a frame-exact device recorder, consecutive identical
frames hash identically, so the list of hash changes IS the take's edit list. "The screen changed
at 11, 31, 60, 84, 100, 106, 219." That reduced a four-minute take to a dozen timestamps I could
spot-check, and it is how I found the interruption in #10 and the exact frame of every transmute.

**Fix:** ship it. A `--verify` on the filming run, or a `tools/timeline.mjs <video>`, printing one
line per change with a timestamp, plus optionally a contact sheet. filmkit already knows things
this analysis has to guess at, including where the segment seams are, what the authored beats were,
and how long the flow ran. So it can mark the seams in that timeline and warn when a seam lands
inside a stretch of motion. "The shot that must not be cut sits on a seam" is a real failure mode
the README already warns about, and right now the only way to check is by hand.

---

## 12. The failure line is buried under ffmpeg's banner (small bug, constant tax)

Every run prints ffmpeg's full banner, the `configuration:` line, all eight `lib*` versions, and
the input and output stream tables, twice on a segmented run. When a flow fails, the one line you
need (`Assertion is false: …`) is sixty lines up. I ended up piping every invocation through
`grep -E "COMPLETED|FAILED|Demo video|tightened"` just to see what happened.

**Fix:** `-hide_banner -loglevel error` on the internal ffmpeg calls. Keep the progress line if you
like it. Nobody needs the configure flags. If the verbose form is worth keeping, put it behind
`--verbose`.

---

## 13. A failed run burns a take number forever (design gap)

`--force` correctly refuses to clobber, and partial recordings are correctly kept for debugging.
Together they mean a directory of a shot filmed five times looks like this:

```
take-1.mp4   27s   aborted, wrong app in front
take-2.mp4  294s   good, but the instance was later deleted
take-3.mp4   27s   aborted
take-4.mp4  137s   aborted mid-typing
take-5.mp4  226s   the one you want
```

and the only way to know which is which is a notes file the operator remembers to keep. The take
numbering is the storyboard's, so filmkit should not renumber. But it does know which runs failed.

**Fix:** name the artifacts of a failed run differently, `take-3.failed.mp4` and `.failed.json`, or
at minimum put an `"ok": false` at the top of the sidecar rather than leaving it implied by a
missing `tighten` block. `ls` should be able to tell you where the real takes are.

---

## 14. README: five Maestro facts that cost me a take each (doc gap)

All device-agnostic, all measured this session, all things the "Maestro flow idioms" section is
exactly the right home for.

1. **A flow with no `launchApp` honours long waits.** FEEDBACK #4 established that
   `extendedWaitUntil` comes back after roughly 7 to 8 seconds in a flow that also launches the
   app. The complement is the useful half. With `launchApp` removed, a 45 000 ms wait inside a
   nine-step flow held for the full 45s, and a 720 000 ms wait held for nearly five minutes. So the
   workaround for a long-hold flow is usually not `runScript`. It is to foreground the app yourself
   before rolling and drop `launchApp` from the flow. Worth stating next to the existing warning.
2. **Pauses inside `runFlow: { when: … }` are not truncated** the way pauses inside `repeat:` are.
   Measured: a 20 000 ms optional wait inside a `when` block took 20s. That matters because
   `runFlow` with `when` is the only way to script a flow through a screen that may or may not
   appear. In my case that was an LLM-driven clarify step the server sometimes skips entirely,
   which killed a take before I branched around it.
3. **Relative selectors resolve to the first hierarchy match, not the nearest element.** I needed
   "the first tappable thing under the first question" on a screen whose every label is generated
   text I cannot hard-code. `tapOn: { text: ".*", below: { text: ".*\\?" } }` does exactly that and
   is a genuinely useful idiom. The mirror image does not work. Anchoring `above:` a known fixed
   line at the bottom of the screen lands on the "Back" button in the header, because that is the
   first node in the tree that happens to be above the anchor.
4. **`hideKeyboard` is safe on native screens and is a back-navigation inside a WebView.** On the
   host app's own screens it dismissed the IME and stayed put. On a screen rendering a web app in a
   WebView, the same command left the app entirely, and I lost the state I had just typed in.
5. **A control's accessible name can carry its state.** A checkbox labelled `Drink water` becomes
   `✓ Drink water` once ticked, and since `text:` is matched as a whole-string regex, a selector
   that worked in the first half of a flow silently stops matching in the second. Anything that has
   to survive a state change wants `.*Drink water.*`. This cost two takes before I dumped the tree
   and saw the tick.

---

## 15. Tightening, revisited (no action, reporting the result)

The recalibrated detector behaved on every one of this session's takes. Representative rows:

| take | what it is | raw | tight |
|---|---|---|---|
| shots 1–4 | a four-minute build, most of it a static grid | 226.0s | 88.4s |
| shot 7 | a five-minute rebuild | 317.6s | 53.5s |
| shot 5 | a 45s app walkthrough, action throughout | 44.4s | 10.9s |
| shot 11 | a deliberately still closing grid | 14.4s | 1.9s |

The last row still trips the sanity floor, and still should. The shot is a held grid, so "kept 13%"
is the honest reading and the warning is the right response to it. Nothing here needs changing. I
am recording it so the next person does not re-open #3.

---

## Addendum: what the last round's fixes were worth

- **`--name` with `--out`** meant sixteen runs went straight into the storyboard's directory layout
  with no copy step and nothing to track in my head. This is the single biggest quality-of-life
  change from the previous round.
- **The preflight clobber refusal** fired twice, both times because a shot already had takes from
  an earlier session. It cost me nothing and it protected footage I would have been upset to lose.
- **Segment chaining** carried a 317-second take with no truncation and no drift, and its seam at
  170.3s missed every moment that mattered in both long takes. That was luck rather than planning,
  which is why #11 asks for the seams to be surfaced in a verification pass.
- **The sidecar** is what let me reconstruct which flow revision produced which take while writing
  the progress log, across a session where three flows were edited mid-shoot.

---

# Second filming session, 2026-08-23 evening

Eleven takes across the same storyboard, same AVD, on a build where the product bug the film had to
prove fixed was finally fixed. The tool behaved. Both entries below are things that cost me work
rather than footage, and one of them is the guard doing its job so well that it punished me for it.

## 16. A shot whose subject IS backgrounding the app can never pass `--guard-app` (design gap)

**Wanted:** storyboard shot 6 is the persistence proof. Hold on the app's state, kill the process,
watch the device fall back to the Android home screen, cold start, go back in, everything is still
there. The home screen is not an accident in that shot. It is the evidence that the kill was real.

**Happened:** filmkit calls it an interloper, correctly by its own rules:

```
Stop com.whim... COMPLETED
[foreground] INTERLOPER com.google.android.apps.nexuslauncher at 10.69s
```

The README is explicit that the launcher is off the allowlist because home showing means your app
got backgrounded, which is the failure. That is the right default. It is exactly wrong for this one
flow, and there is no way to say so.

The verdict itself I can live with, since it is only a line of output. What actually cost me
something is the consequence: an interloper run writes no `-tight.mp4`. The reasoning in the README
is sound, a polished variant beside a dead take is how the original one looked finished. But here
the take is not dead, so I lost the tighten pass on a take that needed it, and had to notice that
and run `tighten.mjs` by hand afterwards. An operator who does not notice ships a rough cut with
one shot at full length and no idea why.

**Did instead:** kept the guard on and tightened by hand. Keeping it on was the right call for a
second reason: the previous take of the same shot had a genuine interloper, my own Date and time
Settings activity left on the back stack, and `stopApp` revealed that instead of the home screen.
Two takes of one flow, two interloper verdicts, one real and one not, and nothing but reading the
frames tells them apart.

**Fix:** let the flow say which backgrounding is expected. Either a `--guard-allow <pkg>` that adds
to the allowlist for one run, or better, since the launcher showing is only legitimate while the
app is deliberately stopped, a way to mark a window of the flow as an expected gap. Failing both,
the cheap fix is to decouple the two consequences and still write the `-tight.mp4` on an interloper
run, since the raw file is written anyway and the sidecar already says `status: "interloper"` for
anyone reading it.

---

## 17. The sidecar counts seams but does not say where they are (missing feature)

**Wanted:** to answer one question about a 367-second take, does the seam fall on the moment the
shot exists for. The tile transmute is a single event in a six-minute recording and it is the whole
point of the take.

**Happened:** the sidecar gives `"seamCount": 2` and a `segments` array, and the offsets are only
implied. Getting the number I wanted meant summing `timelineSec` across all but the last segment:

```python
t = 0
for s in rec['segments'][:-1]:
    t += s['timelineSec'] or s['wallSec']
    print(round(t, 1))
```

which gave 170.0 and 340.0 against a transmute at 347.5. Seven and a half seconds of margin on a
take I could not refilm without spending another six-minute generation. I would have liked to know
that from a field rather than from arithmetic I had to be confident I had got right, especially
since `timelineSec` is null on the final segment and the fallback to `wallSec` is a thing you have
to work out by reading the JSON.

The addendum to the last round already noted that the seams missing every moment that mattered was
luck rather than planning, and asked for seams to be surfaced. Same request, narrower: this is one
line in the sidecar.

**Fix:** add `"seamOffsetsSec": [170.0, 340.0]` to the `recording` block. The stitch already
computes those offsets to write the concat directives, so nothing new has to be worked out. Printing
them on the console at the end of a multi-segment run would help too, since that is the moment you
still remember what happened when.

---

## 18. The VFR warning lives in the tightening section, and it bites everyone downstream (doc gap)

**Wanted:** to find the exact second a one-frame event happens in a six-minute take, and then cut
the rough assembly around it.

**Happened:** I read `-ss 344 -i take-7.mp4` as "start at 344 seconds" and built a contact sheet
from it, and the sheet lied. These recordings emit no frames at all while the screen is still, and
the take in question has a 148-second stretch of a motionless grid waiting for a build. Seek into
that and ffmpeg drops the frame that spans your seek point and gives you the next frame that
physically exists, which was about 15 seconds later. Everything counted off that sample inherits
the error. I logged the tile transmute at t=347.5. It is at 359.5. The rough cut I built from that
number ran the speed ramp straight over the one moment the take exists for, and the assembled file
ended before the transmute happened. Nothing warned me, because from ffmpeg's point of view
nothing went wrong.

The information is already in the repo. `tighten.mjs`'s header explains this exact behaviour, and
the README's tightening section says the recordings are "genuinely variable-frame-rate". But it is
framed as an internal detail of why tighten resamples, so it reads as solved rather than as a
property of every file the tool hands you. The camera sections, which are where someone goes to
learn what they are getting, do not mention it.

**Did instead:** resampled before cutting, everywhere:

```sh
# wrong on this footage
ffmpeg -ss 352 -to 367 -i take-7.mp4 ...
# right
ffmpeg -i take-7.mp4 -vf "fps=30,trim=start=352:end=367,setpts=PTS-STARTPTS" ...
```

**Fix:** a short paragraph in the Android and iOS camera sections saying that the output is VFR
with no frames during still stretches, that seeking with `-ss` before `-i` lands on the next
emitted frame rather than the requested time, and giving the `fps` then `trim` idiom. Three lines
would have saved me a wrong number in a progress log and one rebuilt assembly. A note in the
sidecar would work too, since it already records that the container durations cannot be trusted
for the same underlying reason.

---

# Web camera friction log — IEC Karla enrolment demo (2026-09-03)

Written by an agent filming a 12-step operator walkthrough of a Firebase-hosted React SPA
(Google sign-in, hash routing) with `film-web.mjs`. One take, first try, 66s wall clock for a
60s video. Everything below actually happened.

## 1. No way to film behind a login (missing feature)

**Wanted:** film the live app at its real URL. It sits behind Google sign-in.

**Happened:** `createStage` does `chromium.launch()` + `browser.newContext({ recordVideo })`.
No `storageState`, no persistent profile, no CDP attach, no hook to run code before the
recording starts. An agent must not type a human's password, so the live URL was unfilmable.

**Did instead:** ran the project's Firebase emulators and used the app's own emulator-only
`window.__test.signInAs()` hook from inside the flow via `stage.page.evaluate`. Same code, same
SPA, but the footage shows stub scoring text and an emulator URL. The skill text never mentions
auth at all, so the first twenty minutes went to discovering this.

**Fix:** `--storage-state <file>` passed through to `newContext` (Playwright's `storageState`
now carries IndexedDB, which is where Firebase Auth keeps its session), and a line in the skill
that says what to do when the target needs a login.

## 2. `--tighten` at defaults erases caption reading time (bug in the recommendation)

**Wanted:** the skill says "Always pass --tighten".

**Happened:** every `stage.caption(...)` followed by a `stage.pause(1800..2400)` is, to
`freezedetect`, a static stretch, and `--keep 0.6` clamps it to 0.6s. Dry run on the take:
19 freezes of 1.2-3.3s, all clamped, and the video went from 59.9s to 35.5s. The result is a video where no caption
can be read. With `--keep 1.5`: 51.8s and the captions hold.

**Fix:** either the skill says "captioned web flows: `--keep 1.5` or skip tighten", or the
stage records the authored caption holds (it knows every `pause` it ran) and tighten spares
them. The second is the real fix; the tool already has the information.

## 3. `stage.click` does not wait for its target (ergonomics)

**Happened:** `boxCenter` throws "no bounding box" if the element is not there yet. After every
state change the flow needed `await stage.page.getByTestId('x').waitFor()` before the next
`stage.click`. Twelve of those in one flow. Playwright's own `locator.click()` auto-waits; the
stage's real-mouse click path skips that.

**Fix:** `await locator.waitFor({ state: 'visible' })` inside `resolveLocator`, or a
`stage.waitFor(target)` primitive so the flow reads as a shot list rather than a test.

## 4. One `open()` per flow, and navigation kills the overlay (limitation, documented but costly)

**Happened:** the demo has an applicant-side step on a different route. A `page.goto` would
have dropped the injected cursor and caption overlay. Got away with it only because the app
uses hash routing, so `location.hash = ...` re-rendered without a document load. A real
multi-page demo, or the honest "guest opens the link in a fresh browser" beat, cannot be filmed
into one video.

**Fix:** re-inject the overlay on `page.on('framenavigated')` for the main frame, or add
`stage.goto(url)` that does it explicitly.

## 5. Output directory: skill and tool disagree (doc bug)

**Happened:** the skill says output lands in `<cwd>/out` when run from the project.
`lib/stage.mjs` has `DEFAULT_OUT_DIR = join(HERE, '..', 'out')`, filmkit's own `out/`, where
other projects' takes already sit. Passed `--out` explicitly, so nothing was misplaced, but
the skill text would have sent the video to the wrong repo.

## 6. `tighten.mjs` overwrites `<in>-tight.mp4` without a word (missing feature)

**Happened:** re-ran tighten with `--keep 1.5` to compare against the default cut. The default
cut was gone. README promises the Android camera never clobbers a take and refuses in preflight;
the web camera and standalone tighten have no `--name`, no `--force`, no refusal.

## 7. "Explore off-camera in a Playwright REPL" is not an agent workflow (skill text)

**Happened:** there is no REPL to open. What actually worked: read the project's own e2e spec
for the same flow and lift its `data-testid` selectors verbatim, then confirm the one unknown
(route gating) by grepping the app. The skill should say that first. It should also point at
this file. FEEDBACK.md is the right place for exactly this, and the skill never mentions it.

## What worked

First take succeeded end to end. Deterministic pacing reads as human. The overlay survived
twelve SPA route changes. One `--dry-run` on tighten was enough to show problem 2. Errors
from the stage name the target that failed. The web camera is close; problems 2 and 3 are the
ones an agent hits on every flow.

## Resolved 2026-09-03

1. Login: the default camera is now `--browser ego`, which films inside the user's own
   already-signed-in browser, so there's no storage state to pass or manage at all.
2. `--tighten` erasing captions: the web camera now writes its own caption/pause timeline into
   the sidecar, and tighten reads it and protects those ranges instead of clamping them.
3. `stage.click` not waiting: `resolveBox` now owns one shared 10s auto-wait that `click`,
   `point`, and `type` all go through, and a new `stage.waitFor(target)` covers the case where
   the wait isn't tied to an action at all.
4. Navigation killing the overlay: the overlay now re-registers itself on every future document
   from `open()` onward, and a new `stage.goto()` re-dresses it explicitly for a deliberate
   second navigation mid-flow.
5. Output directory disagreement: the skill text now says what the code has always done,
   filmkit's own `out/`, and tells the reader to pass `--out` to land a take inside their own
   project instead.
6. Silent tighten overwrite: both `film-web.mjs` and standalone `tighten.mjs` now refuse to
   overwrite an existing take in preflight, the same way the Android camera does, with `--force`
   to override it on purpose.
7. "Playwright REPL" exploration advice: the two-pass workflow now says to read the project's
   own e2e specs for selectors first, then confirm the unknowns with `snapshotText()` inside
   ego-browser, and points at this file as where to log friction after a run.
