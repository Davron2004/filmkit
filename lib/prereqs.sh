# lib/prereqs.sh: sourced (never run) by setup.sh and skills/film-demo/filmkit. POSIX sh.
#
# The prerequisite checks that must work BEFORE Node.js exists (everything else is tools/doctor.mjs).
# Each check prints the exact fix and returns 1; the caller decides whether to stop. Nothing here
# installs system software: it says what to run.

# Homebrew's bin directories, appended (never prepended: what the user's own PATH finds wins) when
# they exist and are missing from PATH. The Homebrew installer leaves adding itself to PATH as a
# manual "Next steps" item, which is easy to skip, and a skipped one would otherwise hide a node or
# ffmpeg that is installed. /opt/homebrew is Apple silicon, /usr/local is Intel.
filmkit_add_brew_path() {
  # Remembered so a fix can tell whether a plain `brew` works in the user's own Terminal.
  : "${FILMKIT_ORIGINAL_PATH:=$PATH}"
  for _d in /opt/homebrew/bin /usr/local/bin; do
    [ -d "$_d" ] || continue
    case ":$PATH:" in
      *":$_d:"*) ;;
      *) PATH="$PATH:$_d" ;;
    esac
  done
  export PATH
}

# Prints the steps that install the given Homebrew formulae, including Homebrew itself when it is missing.
filmkit_brew_steps() {
  if [ "$(uname -s)" != Darwin ]; then
    echo "  Install $* with your system's package manager (Node.js 20 or newer: https://nodejs.org)."
    return
  fi
  _brew=$(command -v brew 2>/dev/null)
  if [ -n "$_brew" ]; then
    # The absolute path when brew is only found through filmkit_add_brew_path: then a plain `brew`
    # would not work in the user's own Terminal.
    case ":$FILMKIT_ORIGINAL_PATH:" in
      *":$(dirname "$_brew"):"*) echo "  brew install $*" ;;
      *)
        echo "  $_brew install $*"
        echo "  (Homebrew is installed but not on your PATH. To fix that for new Terminal windows, run:"
        echo "     echo 'eval \"\$($_brew shellenv)\"' >> ~/.zprofile )"
        ;;
    esac
  else
    echo "  1. Install Homebrew, the Mac package manager. Paste this line into Terminal, press Return, and"
    echo "     follow its prompts (it asks for your Mac password):"
    echo '       /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    echo "     When it finishes, run the commands it prints under \"Next steps\", then open a new Terminal window."
    echo "  2. brew install $*"
  fi
}

# Prints none | old | ok for the node on PATH (filmkit needs 20 or newer).
filmkit_node_state() {
  if ! command -v node >/dev/null 2>&1; then
    echo none
    return
  fi
  _major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
  case $_major in
    '' | *[!0-9]*) _major=0 ;;
  esac
  if [ "$_major" -lt 20 ]; then echo old; else echo ok; fi
}

# The fix for a node that is too old: depends on who installed it.
filmkit_old_node_fix() {
  _node=$(command -v node)
  echo "filmkit needs Node.js 20 or newer, but the node on your PATH is $(node -v 2>/dev/null) ($_node). To update it:"
  case $_node in
    */.nvm/*) echo "  nvm install 22 && nvm alias default 22" ;;
    /opt/homebrew/* | /usr/local/*) echo "  brew upgrade node   (if that says node is not installed: brew install node)" ;;
    *)
      filmkit_brew_steps node
      echo "  Then check that \`node -v\` prints v20 or higher. If it still shows the old version, the old"
      echo "  Node.js at $_node comes first on your PATH: remove it, or put the new one before it."
      ;;
  esac
}

# Node.js 20 or newer on PATH, for the launcher. Returns 1 after printing the fix.
filmkit_check_node() {
  case $(filmkit_node_state) in
    ok) return 0 ;;
    none)
      echo "filmkit needs Node.js 20 or newer, and this Mac does not have Node.js. To install it:"
      filmkit_brew_steps node
      ;;
    old) filmkit_old_node_fix ;;
  esac
  echo "Then run the same command again."
  return 1
}

# ffmpeg AND ffprobe (one package) on PATH.
filmkit_has_ffmpeg() {
  command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1
}
