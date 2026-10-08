# yt-clear-watch-later

Bulk-remove videos from your YouTube **Watch later** playlist by driving the
real YouTube web UI with Playwright — the same `"..." -> Remove from Watch
later` clicks you would do by hand, repeated for every row.

The official YouTube Data API v3 stopped exposing the Watch later (`WL`)
playlist in 2016 (`playlistItems.list` on `WL` returns an empty list), and the
private `youtubei` endpoints the web app uses need SAPISIDHASH cookie signing
and change without notice — so driving the UI is the durable option.

Two modes:

```sh
npx tsx clear-watch-later.ts --clear-all       # remove every video
npx tsx clear-watch-later.ts --num-days 30     # remove videos older than 30 days
```

Both ask for a confirmation (list size + time estimate) before the first
removal.

## Requirements

- Node.js 18 or newer
- A Chromium-based browser (Brave recommended on Debian; Chrome/Edge also work)
- A graphical session — the browser window must be visible (sign-in happens in it)

## Installation

### 1. Node dependencies

```sh
npm install
```

A Playwright-managed browser is only needed for `MODE=persistent` with no
installed Chrome:

```sh
npx playwright install chromium
```

### 2. Browser: Brave (Debian / Ubuntu / Linux Mint)

Official instructions: <https://brave.com/linux/#debian-ubuntu-mint>

```sh
sudo apt install curl
sudo curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg \
    https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg] \
https://brave-browser-apt-release.s3.brave.com/ stable main" |
    sudo tee /etc/apt/sources.list.d/brave-browser-release.list
sudo apt update
sudo apt install brave-browser
```

### 3. Sign in to YouTube

Easiest path — the launcher starts Brave with a dedicated profile
(`$HOME/.yt-wl-brave`) and remote debugging, then runs the script:

```sh
./run-brave.sh --num-days 30
```

Or start any browser yourself (also the fallback if Google blocks sign-in in
the launcher's window):

```sh
brave-browser --remote-debugging-port=9222 --user-data-dir="$HOME/.yt-wl-brave"
```

**On the Google login page:**

1. Enter the Google account email, then **Next**.
2. Enter the password, then **Next**.
3. If 2-Step Verification is enabled: approve the prompt on the phone (or
   enter the code / recovery-email code when asked).
4. If you see **"This browser or app may not be secure"**: Google refuses
   sign-in inside automation-launched browsers. Close that window and start
   the browser yourself with the command above (a normal browser session is
   accepted), or run the script in `MODE=cdp` against your daily browser
   where you are already signed in.
5. Confirm the sign-in worked: open **Watch later** from the left guide and
   check that videos are listed.
6. If the script printed `Not signed in ... press Enter here`, sign in in
   the open window, then press **Enter** in the terminal.

## Usage

```sh
npx tsx clear-watch-later.ts --clear-all
npx tsx clear-watch-later.ts --num-days 30
npx tsx clear-watch-later.ts --help        # also: -h
npm start -- --num-days 30                # same thing via npm
./run-brave.sh --clear-all                # launcher variant (mode flag required)
```

No arguments prints the help text and exits `1` (this also applies to
`run-brave.sh`, which checks before starting a browser). `--help` exits `0`.

| Mode flag      | Effect                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `--clear-all`  | Remove every video in the Watch later list.                                                      |
| `--num-days X` | Remove only videos whose displayed date is older than X days (whole number >= 1).                |
| `--help`, `-h` | Print help to stdout and exit 0.                                                                 |

Exactly one mode is required.

### Confirmation

Before the first removal (skipped by `DRY_RUN=1`, which removes nothing):

```text
There are 10 videos in the Watch later list.
This may take a while: about 1 minute(s) to click through 10 removal(s) at 400 ms apart.
Remove the videos older than 30 days? [y/N]
```

Type `y` or `yes` to proceed. Anything else — including a bare Enter —
aborts with nothing removed.

### Safe first steps

```sh
DRY_RUN=1 npx tsx clear-watch-later.ts --num-days 30   # count only, no prompt
MAX=1 npx tsx clear-watch-later.ts --num-days 30       # remove exactly one video
```

## Environment variables

| Variable      | Default                    | Meaning                                                             |
| ------------- | -------------------------- | ------------------------------------------------------------------- |
| `MODE`        | `cdp`                      | `cdp` = attach to a browser you started; `persistent` = Playwright launches Chrome with a remembered profile (`$HOME/.yt-wl-playwright`). |
| `CDP_URL`     | `http://127.0.0.1:9222`    | Debug endpoint for `MODE=cdp`.                                       |
| `DRY_RUN`     | unset                      | `1` = report what would be removed; no prompt, no removals.          |
| `MAX`         | unlimited                  | Stop after N removals (good for a first test).                       |
| `DELAY_MS`    | `400`                      | Pause between removals (be gentle, avoid rate limits).               |
| `REMOVE_TEXT` | `Remove from\s+Watch later` | Menu-label regex for a non-English YouTube UI, e.g. `REMOVE_TEXT="Supprimer de"`. |
| `BROWSER_PATH`| unset                      | Browser executable for `MODE=persistent` (e.g. the Brave binary).    |

## How it works

- Loads `youtube.com/playlist?list=WL`, then for each target row: hover the
  row, click `"..."`, click the menu entry matching `REMOVE_TEXT`, and wait
  until that row's href disappears from its position — a removal is only
  counted after the row is verifiably gone.
- `--clear-all` reloads the page when the rendered rows run dry (more
  reliable than scrolling for the next lazy-loaded batch while rows are
  being deleted). `--num-days` scans all rendered rows in one DOM pass,
  removes the first row older than the cutoff, then scrolls for the next
  batch; a scroll that adds no rows means the whole list has been scanned.
- **Where the count comes from**: the confirmation and the `Watch Later
  reports:` line use the playlist header ("10 videos"). Do not read the tab
  title's leading `(N)` — it is an account-level counter, not the list size.
  Observed 2026-10-08: the title said `(795)` while the header said
  `1 video`, and the same `(795)` also appeared on plain video watch pages.
- **Date basis**: age comes from the row's visible metadata (`8mo ago`,
  `3 days ago`, `Premiered 2 years ago`) — the video's displayed
  publication date, not the date it was added to the list. Weeks/months/years
  are approximated as 7/30/365 days. Rows whose date text cannot be parsed
  are **never** removed in `--num-days` mode; they are tallied in the
  end-of-list message.

## Troubleshooting

- **`Could not find "Remove from Watch later" in menu` (3 attempts)** — the
  UI language is not English (set `REMOVE_TEXT`) or YouTube changed its
  layout (update `SEL` selectors in `clear-watch-later.ts`).
- **`Row still present after clicking...`** — the click registered but the
  list did not change (slow network or a YouTube glitch); the script reloads
  and gives up after 3 consecutive failures instead of counting a removal
  that never happened.
- **Brave Shields** — keep them off for `youtube.com` if the page stalls.
- **Sign-in blocked** — see step 4 of the sign-in instructions above.
- **Old browser window** — `./run-brave.sh` reuses an already-running Brave
  on port 9222; close that window first if you want a fresh session.

## Development

```sh
npm run typecheck   # tsc --noEmit --strict
npm test            # node:test unit tests for cli.ts (no browser needed)
```

- `cli.ts` holds the pure logic (argument parsing, help text, date parsing,
  row selection); `clear-watch-later.ts` holds the Playwright loop.
- Formatter style is pinned in `package.json` (`"prettier"`) and
  `.editorconfig` (4-space, single quotes, no semicolons) so the editor
  auto-formatter keeps the repo's existing style.
- Helper/probe scripts must live inside this repo: tsx transforms files from
  other directories as CJS, whose `keepNames` helper (`__name`) is undefined
  in the browser context, breaking `page.evaluate(fn)`.
