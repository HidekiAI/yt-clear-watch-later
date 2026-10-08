#!/usr/bin/env bash
#
# run-brave.sh
#
# Launcher for clear-watch-later.ts on Debian (or any Linux) using Brave.
#
# What it does:
#   1. Checks Node.js (>= 18), npm, curl, and a graphical session.
#   2. Installs npm deps next to this script (once).
#   3. Starts Brave with remote debugging on a dedicated profile folder,
#      or reuses one that is already listening on the port.
#   4. Waits for you to sign in to YouTube in that Brave window.
#   5. Runs clear-watch-later.ts in cdp mode against that Brave.
#   6. Closes the Brave instance it started (set KEEP_BROWSER=1 to keep it).
#
# Usage (put this file in the same folder as clear-watch-later.ts and package.json):
#   chmod +x run-brave.sh
#   ./run-brave.sh                 # remove everything
#   DRY_RUN=1 ./run-brave.sh       # count only
#   MAX=10 ./run-brave.sh          # test on 10 videos
#
# Every env var the TS script understands (DRY_RUN, MAX, DELAY_MS, REMOVE_TEXT)
# is passed straight through.
#
# Optional overrides:
#   PORT=9222                      remote debugging port
#   PROFILE_DIR=~/.yt-wl-brave     Brave profile used for this job (keeps your sign-in)
#   BRAVE_BIN=/path/to/brave       skip auto-detection
#   KEEP_BROWSER=1                 leave Brave open when done
#
# Installing Brave on Debian, if needed (official instructions):
#   https://brave.com/linux/#debian-ubuntu-mint

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-9222}"
PROFILE_DIR="${PROFILE_DIR:-$HOME/.yt-wl-brave}"
CDP_URL="http://127.0.0.1:${PORT}"
BRAVE_PID=""

log()  { printf '\033[1;34m[run-brave]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[run-brave]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Cleanup: stop the Brave we launched (never one that was already running).
# ---------------------------------------------------------------------------
cleanup() {
    if [[ -n "$BRAVE_PID" && "${KEEP_BROWSER:-0}" != "1" ]]; then
        if kill -0 "$BRAVE_PID" 2>/dev/null; then
            log "Closing Brave (pid $BRAVE_PID). Set KEEP_BROWSER=1 to keep it open."
            kill "$BRAVE_PID" 2>/dev/null || true
        fi
    fi
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# 1. Prerequisites
# ---------------------------------------------------------------------------
[[ -f "$SCRIPT_DIR/clear-watch-later.ts" ]] || die "clear-watch-later.ts not found next to this script."
[[ -f "$SCRIPT_DIR/package.json" ]]         || die "package.json not found next to this script."

command -v curl >/dev/null || die "curl missing: sudo apt install curl"
command -v node >/dev/null || die "Node.js missing: sudo apt install nodejs npm (needs >= 18)"
command -v npm  >/dev/null || die "npm missing: sudo apt install npm"

# Debian 12 ships Node 18, Debian 13 ships Node 20; both are fine for tsx + Playwright.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 18 )) || die "Node $NODE_MAJOR is too old; need >= 18 (try nvm or NodeSource)."

# Brave needs a display. Over plain SSH this will fail; run it from the desktop
# session or use `ssh -X` (slow) / a remote desktop instead.
if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
    die "No graphical session (DISPLAY/WAYLAND_DISPLAY unset). Run this from the desktop."
fi

# ---------------------------------------------------------------------------
# 2. npm dependencies (Playwright browser download is not needed: we attach to Brave)
# ---------------------------------------------------------------------------
if [[ ! -d "$SCRIPT_DIR/node_modules/playwright" ]]; then
    log "Installing npm dependencies..."
    (cd "$SCRIPT_DIR" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-fund --no-audit)
fi

# ---------------------------------------------------------------------------
# 3. Find and start Brave
# ---------------------------------------------------------------------------
cdp_up() { curl -fsS "$CDP_URL/json/version" >/dev/null 2>&1; }

if cdp_up; then
    log "Something is already listening on $CDP_URL; reusing it."
else
    if [[ -z "${BRAVE_BIN:-}" ]]; then
        # apt package from brave.com installs brave-browser; snap/others vary.
        for c in brave-browser brave brave-browser-stable /opt/brave.com/brave/brave; do
            if command -v "$c" >/dev/null 2>&1; then BRAVE_BIN="$(command -v "$c")"; break; fi
        done
    fi

    BRAVE_CMD=()
    if [[ -n "${BRAVE_BIN:-}" ]]; then
        BRAVE_CMD=("$BRAVE_BIN")
    elif command -v flatpak >/dev/null && flatpak info com.brave.Browser >/dev/null 2>&1; then
        # Flatpak sandbox: profile dir must live somewhere the sandbox can write ($HOME is fine).
        BRAVE_CMD=(flatpak run com.brave.Browser)
    else
        die "Brave not found. Install it (https://brave.com/linux/) or set BRAVE_BIN."
    fi

    mkdir -p "$PROFILE_DIR"
    log "Starting Brave: ${BRAVE_CMD[*]} (profile: $PROFILE_DIR)"

    # A separate --user-data-dir makes this its own Brave instance, so it works
    # even if your normal Brave is already open, and remote debugging is allowed.
    "${BRAVE_CMD[@]}" \
        --remote-debugging-port="$PORT" \
        --user-data-dir="$PROFILE_DIR" \
        --no-first-run \
        --no-default-browser-check \
        "https://www.youtube.com/playlist?list=WL" \
        >/dev/null 2>&1 &
    BRAVE_PID=$!

    # Wait up to ~20s for the debugging endpoint.
    for _ in $(seq 1 40); do
        cdp_up && break
        kill -0 "$BRAVE_PID" 2>/dev/null || die "Brave exited during startup."
        sleep 0.5
    done
    cdp_up || die "Brave did not open $CDP_URL in time."
fi

# ---------------------------------------------------------------------------
# 4. Let the user sign in (first run only; the profile remembers it)
# ---------------------------------------------------------------------------
log "In the Brave window: make sure you are signed in to YouTube and can see Watch Later."
log "If the '...' menus misbehave later, turn Shields off for youtube.com."
read -r -p "Press Enter to start (Ctrl+C to abort)... "

# ---------------------------------------------------------------------------
# 5. Run the cleaner
# ---------------------------------------------------------------------------
log "Running clear-watch-later.ts"
cd "$SCRIPT_DIR"
MODE=cdp CDP_URL="$CDP_URL" npx --no-install tsx clear-watch-later.ts
