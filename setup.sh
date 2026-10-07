#!/bin/sh
# setup.sh: makes this filmkit checkout ready to film and gives Claude Code its film-demo skill.
#
#   ./setup.sh          (from anywhere: sh /path/to/filmkit/setup.sh works too)
#
# WHY A SHELL SCRIPT AND NOT `npm run setup`: on a Mac that has never seen filmkit, Node.js may be
# missing, and then `npm run` cannot start, let alone say what to install. This script needs only
# /bin/sh, so its first job can be telling the user exactly that.
#
# STATES, run in order; every one is safe to repeat, so the recovery for any failure is "fix what it
# said, run setup.sh again":
#   1. PREREQUISITES  Node.js >= 20, ffmpeg + ffprobe. Missing: print the exact Homebrew commands
#                     (Homebrew's own install included) and exit 1, having changed nothing. System
#                     software is never installed by this script.
#   2. NPM            `npm ci` in the checkout (package-lock.json): Playwright, nothing else.
#   3. BROWSER        Playwright's Chromium (`playwright install chromium`, ~150 MB, skipped by Playwright
#                     when already there), then an ok line with its path either way. This is what films
#                     when ego-browser is not running.
#   4. SKILL LINK     ${CLAUDE_CONFIG_DIR:-~/.claude}/skills/film-demo -> <checkout>/skills/film-demo.
#                       absent                    -> link created
#                       our link already          -> left alone
#                       a link to anything else   -> repointed (only the link changes; what it pointed
#                                                    to is untouched), and the old target is printed
#                       a real directory or file  -> moved to <config>/skill-backups/film-demo-<timestamp>,
#                                                    printed, then linked. NOT beside the link: Claude Code
#                                                    loads every skills/ subdirectory holding a SKILL.md,
#                                                    so a backup there would be a second film-demo skill
#                     A link, not a copy: the checkout stays the one place filmkit runs from, so
#                     `git pull` updates the skill and out/ (the videos) stays where it is. (A Claude
#                     Code plugin was ruled out: plugins are copied into a cache on install.)
#   5. DOCTOR         tools/doctor.mjs; its exit code (0 = the web camera is ready) is this script's.
unset CDPATH
root=$(cd "$(dirname "$0")" && pwd -P) || exit 1
. "$root/lib/prereqs.sh"
filmkit_add_brew_path

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

say "Setting up filmkit in $root"

# ── 1. PREREQUISITES ─────────────────────────────────────────────────────────────────────────────
step "Checking for Node.js and ffmpeg"
missing=""
node_state=$(filmkit_node_state)
case $node_state in
  none) missing="node" ;;
  old) filmkit_old_node_fix ;;
  ok) say "Node.js $(node -v): ok" ;;
esac
if filmkit_has_ffmpeg; then
  say "ffmpeg: ok"
else
  missing="${missing:+$missing }ffmpeg"
fi
if [ -n "$missing" ]; then
  say ""
  case $missing in
    "node ffmpeg") what="Node.js (version 20 or newer) and ffmpeg" ;;
    node) what="Node.js (version 20 or newer)" ;;
    *) what="ffmpeg (it turns the recording into a video)" ;;
  esac
  say "filmkit needs $what, which this Mac does not have yet. To install:"
  filmkit_brew_steps $missing
fi
if [ -n "$missing" ] || [ "$node_state" = old ]; then
  say ""
  say "Then run setup again: sh \"$root/setup.sh\""
  exit 1
fi

# ── 2. NPM ───────────────────────────────────────────────────────────────────────────────────────
step "Installing Playwright (npm ci)"
if ! (cd "$root" && npm ci --no-audit --no-fund); then
  say ""
  say "npm ci failed (see its message above). This is usually the network: check the internet connection,"
  say "then run setup again: sh \"$root/setup.sh\""
  exit 1
fi

# ── 3. BROWSER ───────────────────────────────────────────────────────────────────────────────────
step "Downloading Playwright's Chromium (about 150 MB the first time)"
# The checkout's own playwright binary, not `npx playwright`, so the browser matches the version filmkit uses.
if ! "$root/node_modules/.bin/playwright" install chromium; then
  say ""
  say "The Chromium download failed (see its message above). Check the internet connection, then run"
  say "setup again: sh \"$root/setup.sh\""
  exit 1
fi
# Playwright prints nothing when the browser is already cached, so say so: an empty step reads as a hang
# or a skipped one.
chromium=$(cd "$root" && node -e "import('playwright').then((m) => console.log(m.chromium.executablePath()))" 2>/dev/null)
say "Playwright's Chromium: ok${chromium:+ ($chromium)}"

# ── 4. SKILL LINK ────────────────────────────────────────────────────────────────────────────────
step "Installing the film-demo skill for Claude Code"
config=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
skills="$config/skills"
link="$skills/film-demo"
want="$root/skills/film-demo"
if ! mkdir -p "$skills"; then
  say "Could not create $skills. Check that you own $config, then run setup again."
  exit 1
fi
if [ -L "$link" ]; then
  current=$(cd "$link" 2>/dev/null && pwd -P)
  if [ "$current" = "$want" ]; then
    say "Already installed: $link -> $want"
  else
    old=$(readlink "$link")
    rm "$link" && ln -s "$want" "$link" || exit 1
    say "Repointed $link -> $want (it pointed to $old, which was not touched)."
  fi
else
  if [ -e "$link" ]; then
    # Outside skills/: Claude Code loads every directory under skills/ that holds a SKILL.md, so a
    # backup kept there would load as a second film-demo skill.
    mkdir -p "$config/skill-backups" || exit 1
    backup="$config/skill-backups/film-demo-$(date +%Y%m%d-%H%M%S)"
    mv "$link" "$backup" || exit 1
    say "An older film-demo skill was at $link. Moved it to $backup (outside skills/, so Claude Code no longer loads it)"
  fi
  ln -s "$want" "$link" || exit 1
  say "Installed: $link -> $want"
fi

# ── 5. DOCTOR ────────────────────────────────────────────────────────────────────────────────────
step "Checking everything"
node "$root/tools/doctor.mjs"
code=$?
if [ "$code" -eq 0 ]; then
  say ""
  say "filmkit is ready. Quit Claude Code and open it again (so it loads the new skill), then ask it to"
  say "film a demo of your web app, for example: \"Film a short demo video of https://example.com\"."
  say "Finished videos are saved in $root/out"
fi
exit "$code"
