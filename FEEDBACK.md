# filmkit — friction log

Open items only. Fixed items are deleted, and their text is in git history (the items as first
filed are in commit d7fe63f and earlier). Numbers are never reused or renumbered, because code
comments cite them, so gaps in the sequence are fixed items.

---

## 6. `maestro hierarchy` output is unreadable without a filter (missing feature)

`maestro hierarchy` on one screen prints about 2300 lines of JSON, and the useful attributes
(`text`, `accessibilityText`, `bounds`, `clickable`) are scattered among boilerplate. The verbosity
is Maestro's. The gap is that filmkit's two-pass workflow sends you to it.

**Fix:** `--diff` against the previous dump, so you can see what a tap changed.

**Status:** later (2026-09-28). `tools/hierarchy.mjs` prints the filtered table and has
`--clickable-only`. `--diff` is not built: a shell `diff` of two dumps covers it.

---

## 11. `tools/timeline.mjs` has no contact sheet (missing feature)

Verifying a take means checking that it holds the moment it was meant to hold, uninterrupted.
`tools/timeline.mjs` prints one line per change with a timestamp, marks segment seams from
`recording.seamOffsetsSec`, and warns when a seam lands inside motion. A contact sheet of frames at
those timestamps would finish the job.

**Status:** later (2026-09-28). The contact sheet is deliberately deferred (`tools/timeline.mjs`
header).

---

## 31. The first maestro run on a fresh iOS simulator installs its driver on camera (missing feature)

**Happened:** the first `maestro test` on a simulator that has never run it builds and installs
Maestro's XCTest driver while the recorder is already rolling. The take opens with about 105s of
dead head, and the raw file is 158 MB at 60fps. tighten cuts the dead head, so the deliverable is
fine, but the raw and the burn pay for it.

**Fix:** a pre-roll driver warmup before the recorder starts, so the driver is already up when
the camera rolls. Optional, because tighten already cuts the dead head.

**Status:** later (2026-09-28).

---

## 32. A maestro JVM can hang with no timeout anywhere (robustness gap)

**Happened:** a maestro JVM hung for about 7 minutes after something pruned `~/Library/Logs/maestro`
(`NoSuchFileException`). None of the cameras has a stuck-maestro timeout, so the take sat there
until someone noticed.

**Fix:** a stuck-maestro timeout that fails the take with a clear message. A flow can legitimately
wait for minutes (a generation wait, for one), so a generic ceiling would kill good takes. It needs
its own design.

**Status:** later (2026-09-28).

---

## 33. Killing simctl's recorder uncleanly wedges the simulator (robustness gap)

After `simctl io recordVideo` is stopped uncleanly, every later recording on that simulator fails
with "Host recording is already in progress" until the simulator is rebooted. The fail-fast and the
SIGHUP/SIGTERM salvage have landed. Only the wedge is open: film-ios can't clear it itself, and
rebooting on the user's behalf would disturb a simulator another agent may be using.

**Status:** later (2026-09-28).

---

## 34. A standalone tighten of a device take cuts harder than the camera did (missing feature)

**Happened:** under `--tighten`, a device camera plans the cut on its pre-burn file, which is
frame-exact, and deletes that file afterwards. A later `node tighten.mjs <take>` only has the
burned take, whose re-encode noise pushes detection into threshold mode, so it plans a different
and harder cut. On one Android take, a 19.65s raw came out at 7.73s in the camera and 4.44s
standalone. Re-tightening a device take later (a different `--keep`, say) won't match the
camera's cut.

**Fix:** keep what a standalone run needs to plan like the camera: the pre-burn file, or the
camera's keep-segment plan in the sidecar.

**Status:** open (2026-09-29). README's "Standalone tighten on a burned take plans differently"
says to treat a standalone run on a burned take as an approximation.

---

## 35. A SIGKILLed film-web leaves its work directory behind (robustness gap)

**Happened:** film-web deletes its `$TMPDIR/filmkit-<name>-*` work directory (the take's raw jpeg
frames) once they are in a take. A SIGKILLed film-web never gets there, and nothing else sweeps
it, so each killed run leaves one behind. The ego runtime does stop itself (the `.alive`
sentinel), so only the files are left.

**Fix:** sweep stale work directories at startup, judged by the same staleness rule the runtime
uses for its sentinel, so a concurrent run's live directory is never touched.

**Status:** open (2026-09-29).

---

## 36. A page that never loads holds the ego camera for 30s (robustness gap)

**Happened:** under `--browser ego`, `open()` on a URL whose connection never completes (an
unroutable host) waits out the ego runtime's own 30s CDP timeout and fails with "CDP request timed
out", ignoring `open()`'s `timeoutMs`. `Page.navigate` occupies ego's single serialized command
chain until it answers, so nothing else can run meanwhile. The Playwright backend has the same
hazard in `Page.stopScreencast` and bounds it at 1s (`lib/backends/playwright.mjs`, halt).

**Fix:** let a navigation be abandoned at `timeoutMs` without waiting for its reply, which means
the ego backend can no longer assume one in-flight command at a time.

**Status:** open (2026-10-06).

---

## 37. Exact-mode tighten keeps a blank iOS launch screen (missing feature)

**Happened:** on an iOS take of examples/ios/example-flow.yaml, the `-tight` cut kept about 2.6s of
the all-white Settings launch screen (21.6-24.4s in the raw take). The home indicator fades during
it (YAVG 231.61 to 231.87), and exact mode counts any pixel change as motion, so the still is split
into pieces each shorter than `--min-still` and nothing is cut.

**Fix:** let exact mode tell a sub-perceptual system-chrome fade from content. Two options: judge
it on the frame minus a declared chrome band (the home indicator, the status bar), or treat a
monotonic low-amplitude ramp as still. Measure both against real device takes so neither hides a
real change.

**Status:** open (2026-10-06).
