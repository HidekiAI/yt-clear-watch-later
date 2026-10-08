/**
 * clear-watch-later.ts
 *
 * Bulk-removes videos from your YouTube "Watch Later" playlist by driving
 * the real YouTube web UI with Playwright (the same clicks you would do by hand:
 * "..." menu -> "Remove from Watch later", repeated).
 *
 * Two modes, chosen on the command line (no arguments prints help and exits 1):
 *
 *   --clear-all        Remove every video in the list.
 *   --num-days X       Remove only videos whose displayed date is older than
 *                      X days (whole number >= 1). Rows whose date cannot be
 *                      parsed are never removed.
 *
 * Before the first removal the script says how many videos the list holds,
 * how long the run is likely to take, and asks for a "y" (anything else,
 * including a bare Enter, aborts with nothing removed).
 *
 * Why UI automation and not curl / the YouTube Data API?
 *   The official YouTube Data API v3 stopped exposing the Watch Later playlist
 *   ("WL") in 2016: playlistItems.list on WL returns an empty list, so there is
 *   nothing to delete through the public API. The private "youtubei" endpoints
 *   the web app uses do work, but they need SAPISIDHASH cookie signing and change
 *   without notice, so driving the UI is the more durable option.
 *
 * Two ways to connect (pick with the MODE env var):
 *
 *   MODE=cdp (default, recommended)
 *     Attach to a Chrome you started yourself, already signed in to YouTube.
 *     Google often blocks sign-in inside a Playwright-launched browser
 *     ("This browser or app may not be secure"), so reusing a real Chrome
 *     avoids that entirely.
 *
 *       macOS:
 *         "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *           --remote-debugging-port=9222 --user-data-dir="$HOME/.yt-wl-chrome"
 *       Linux:
 *         google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.yt-wl-chrome"
 *       Windows (PowerShell):
 *         & "C:\Program Files\Google\Chrome\Application\chrome.exe" `
 *           --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\.yt-wl-chrome"
 *
 *     Sign in to YouTube in that window once, then run this script.
 *     (A separate --user-data-dir is required by recent Chrome versions for
 *     remote debugging; the sign-in persists in that folder for next time.)
 *
 *   MODE=persistent
 *     Playwright launches installed Chrome with its own profile folder. The
 *     first run pauses so you can sign in manually. May hit Google's
 *     "browser not secure" block; fall back to cdp if so.
 *
 * Brave / Edge / other Chromium browsers:
 *   cdp mode: start that browser with the same --remote-debugging-port flag.
 *   persistent mode: set BROWSER_PATH to the browser's executable.
 *
 * Other env vars:
 *   DRY_RUN=1          Only count items, remove nothing (skips the prompt).
 *   MAX=50             Stop after N removals (handy for a first test).
 *   DELAY_MS=400       Pause between removals (be gentle, avoid rate limits).
 *   REMOVE_TEXT=...    Menu label regex if your YouTube UI is not English,
 *                      e.g. REMOVE_TEXT="Supprimer de" or "後で見るから削除".
 *
 * Run:
 *   npm i
 *   npx playwright install chromium   # only needed for MODE=persistent without Chrome
 *   npx tsx clear-watch-later.ts --clear-all      # remove everything
 *   npx tsx clear-watch-later.ts --num-days 30    # remove videos older than 30 days
 *   npx tsx clear-watch-later.ts --help           # all options
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import * as readline from 'node:readline/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { parseArgs, formatHelp, parseAgeDays, findRemovalIndex, isOlderThan, type RemovalMode, type RowAge } from './cli.ts'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MODE = (process.env.MODE ?? 'cdp') as 'cdp' | 'persistent'
const CDP_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9222'
const DRY_RUN = process.env.DRY_RUN === '1'
const MAX = Number(process.env.MAX ?? Number.POSITIVE_INFINITY)
const DELAY_MS = Number(process.env.DELAY_MS ?? 400)
// Matches "Remove from Watch later" (English). Override for other UI languages.
const REMOVE_TEXT = new RegExp(process.env.REMOVE_TEXT ?? 'Remove from\\s+Watch later', 'i')

const WL_URL = 'https://www.youtube.com/playlist?list=WL'

/** Used for the "this may take a while" estimate shown before the prompt. */
const MS_PER_MINUTE = 60_000

/** Pause after scrolling, giving YouTube time to lazy-load the next batch. */
const SCROLL_SETTLE_MS = 1500

// YouTube ships its UI as web components. These selectors cover both the
// long-standing Polymer renderers and the newer "view-model" components that
// YouTube has been rolling out, so the script survives either layout.
const SEL = {
    // One row per video in the playlist.
    item: 'ytd-playlist-video-renderer',
    // The vertical "..." action button inside a row.
    menuButton: '#menu button, #menu yt-icon-button, button[aria-label="Action menu"]',
    // Entries inside the popup menu that opens after clicking "...".
    menuEntry: 'ytd-menu-service-item-renderer, yt-list-item-view-model, tp-yt-paper-item',
} as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Obtain a Page that is signed in to YouTube, according to MODE. */
async function openPage(): Promise<{ page: Page; close: () => Promise<void> }> {
    if (MODE === 'cdp') {
        // Attach to the user's own Chrome. We open a fresh tab and close only
        // that tab at the end, leaving the user's browser running.
        const browser: Browser = await chromium.connectOverCDP(CDP_URL)
        const context = browser.contexts()[0] ?? (await browser.newContext())
        const page = await context.newPage()
        return {
            page,
            close: async () => {
                await page.close()
                // browser.close() on a CDP connection only disconnects; Chrome keeps running.
                await browser.close()
            },
        }
    }

    // Persistent mode: Playwright owns the browser and a dedicated profile dir,
    // so the sign-in is remembered between runs.
    const userDataDir = path.join(os.homedir(), '.yt-wl-playwright')
    const context: BrowserContext = await chromium.launchPersistentContext(userDataDir, {
        // Any Chromium-based browser works. Set BROWSER_PATH to launch Brave/Edge/etc.,
        // e.g. BROWSER_PATH="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser".
        // Without it, fall back to installed Google Chrome.
        ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : { channel: 'chrome' }),
        headless: false, // must be visible so you can sign in the first time
        viewport: { width: 1280, height: 900 },
    })
    const page = context.pages()[0] ?? (await context.newPage())
    return { page, close: () => context.close() }
}

/** Load the Watch Later page and make sure we are actually signed in. */
async function gotoWatchLater(page: Page): Promise<void> {
    await page.goto(WL_URL, { waitUntil: 'domcontentloaded' })

    // When signed out, YouTube shows a "Sign in" button instead of the list.
    const signIn = page.locator('a[aria-label="Sign in"], ytd-button-renderer a[href*="ServiceLogin"]')
    if (
        await signIn
            .first()
            .isVisible({ timeout: 3000 })
            .catch(() => false)
    ) {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        })
        await rl.question('Not signed in. Sign in to YouTube in the opened window, then press Enter here... ')
        rl.close()
        await page.goto(WL_URL, { waitUntil: 'domcontentloaded' })
    }

    // Wait for either the first row or an empty-playlist state.
    await Promise.race([
        page.locator(SEL.item).first().waitFor({ timeout: 15000 }),
        page.getByText(/No videos in this playlist/i).waitFor({ timeout: 15000 }),
    ]).catch(() => {
        /* fall through: we will just see 0 items */
    })
}

/**
 * Read the playlist's total count from the header ("523 videos").
 * Purely informational; returns undefined if the header format changed.
 *
 * Only this header (or the rendered rows) reflects the list size. The tab
 * title's leading "(N)" is an ACCOUNT-level counter, not the Watch Later
 * size: observed 2026-10-08, the title read "(795)" while the header said
 * "1 video" - and the same "(795)" also appeared on plain video watch pages.
 */
async function headerCount(page: Page): Promise<number | undefined> {
    const text = await page
        .locator('ytd-playlist-header-renderer, yt-page-header-renderer, ytd-playlist-sidebar-renderer')
        .first()
        .innerText({ timeout: 3000 })
        .catch(() => '')
    const countMatch = text.replace(/,/g, '').match(/(\d+)\s+videos?/i)
    return countMatch?.[1] ? Number(countMatch[1]) : undefined
}

/**
 * Read every rendered row in ONE round trip: its video href and the age its
 * displayed date implies (undefined when no date could be parsed).
 *
 * The date text comes from ytd-video-meta-block ("channel - views - date") so
 * a video TITLE containing e.g. "5 days ago" can never be mistaken for one.
 */
async function scanRows(page: Page): Promise<RowAge[]> {
    const rendered = await page.$$eval(SEL.item, (rows) =>
        rows.map((row) => {
            const link = row.querySelector('a#video-title, a#thumbnail')
            const stats = row.querySelector('ytd-video-meta-block') as HTMLElement | null
            return {
                href: link ? link.getAttribute('href') : null,
                metaText: stats ? stats.innerText : (row as HTMLElement).innerText,
            }
        })
    )
    return rendered.map((entry) => ({
        href: entry.href,
        ageDays: parseAgeDays(entry.metaText),
    }))
}

/** Why a removal attempt failed (null href = the row had no link to verify against). */
type RemovalOutcome =
    | { ok: true; href: string | null }
    | {
          ok: false
          href: string | null
          failure: 'menu-entry-missing' | 'row-still-present'
      }

/** The failed variant of RemovalOutcome, for failure reporting. */
type RemovalFailure = Extract<RemovalOutcome, { ok: false }>

/**
 * Remove the row at the given index.
 * Returns ok=false when the menu entry could not be found, or when the row was
 * still there after clicking (a strict check: counting a removal that did not
 * happen would corrupt the totals and can spin the loop forever).
 */
async function removeRow(page: Page, rowIndex: number): Promise<RemovalOutcome> {
    const row = page.locator(SEL.item).nth(rowIndex)
    await row.scrollIntoViewIfNeeded()

    // Grab a stable identity up front so a failed attempt can still be reported.
    const href = await row.locator('a#video-title, a#thumbnail').first().getAttribute('href')

    // The "..." button only becomes visible on hover in some layouts.
    await row.hover()
    await row.locator(SEL.menuButton).first().click()

    // The popup is rendered at document level (ytd-popup-container), not inside the row.
    const entry = page.locator(SEL.menuEntry).filter({ hasText: REMOVE_TEXT }).first()
    try {
        await entry.waitFor({ state: 'visible', timeout: 5000 })
    } catch {
        await page.keyboard.press('Escape') // close whatever menu opened
        return { ok: false, href, failure: 'menu-entry-missing' }
    }

    await entry.click()

    if (href === null) return { ok: true, href: null } // nothing to verify against

    // Wait until the row at THIS index is no longer our video (rows below shift
    // up by one when a middle row is removed, so an index check, not first-row).
    const vanished = await page
        .waitForFunction(
            ([selector, expectedHref, targetIndex]) => {
                const current = document.querySelectorAll(selector as string)[targetIndex as number]
                if (!current) return true // list shrank: the row at that index is gone
                const link = current.querySelector('a#video-title, a#thumbnail')
                return link?.getAttribute('href') !== expectedHref
            },
            [SEL.item, href, rowIndex] as const,
            { timeout: 8000 }
        )
        .then(() => true)
        .catch(() => false)

    return vanished ? { ok: true, href } : { ok: false, href, failure: 'row-still-present' }
}

/** Journal-grade failure line: name the row, the reason and the attempt number. */
function logRemovalFailure(outcome: RemovalFailure, attempt: number): void {
    const rowName = outcome.href ?? 'the row'
    if (outcome.failure === 'menu-entry-missing') {
        console.warn(`Could not find "${REMOVE_TEXT.source}" in menu (attempt ${attempt}) for ${rowName}.`)
    } else {
        console.warn(`Row still present after clicking the menu entry (attempt ${attempt}) for ${rowName}.`)
    }
}

/**
 * Pre-flight: state the list size and a time estimate, then ask for a yes.
 * Anything but y/yes (including a bare Enter) means "do not touch my list".
 */
async function confirmRemoval(mode: RemovalMode, total: number | undefined): Promise<boolean> {
    console.log(
        total === undefined
            ? 'The Watch Later header did not report a video count.'
            : `There are ${total} videos in the Watch Later list.`
    )

    const projected = Math.min(total ?? Number.POSITIVE_INFINITY, MAX)
    if (Number.isFinite(projected) && projected >= 1) {
        const minutes = Math.ceil((projected * DELAY_MS) / MS_PER_MINUTE)
        console.log(
            `This may take a while: about ${minutes} minute(s) to click through ${projected} removal(s) at ${DELAY_MS} ms apart.`
        )
    } else {
        console.log(`This may take a while: one click every ${DELAY_MS} ms until the list is done.`)
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    })
    try {
        const question =
            mode.kind === 'clear-all'
                ? 'Remove ALL videos from Watch later? [y/N] '
                : `Remove the videos older than ${mode.days} days? [y/N] `
        const answer = (await rl.question(question)).trim().toLowerCase()
        return answer === 'y' || answer === 'yes'
    } finally {
        rl.close()
    }
}

// ---------------------------------------------------------------------------
// Removal loops
// ---------------------------------------------------------------------------

/** --clear-all: always remove the first rendered row until the list is empty. */
async function removeAllVideos(page: Page): Promise<number> {
    let removed = 0
    let consecutiveFailures = 0

    while (removed < MAX) {
        let rendered = await page.locator(SEL.item).count()

        // YouTube lazy-loads ~100 rows at a time. When the rendered rows run
        // out, reload to pull the next batch (more reliable than scrolling
        // for continuation tokens while rows are being deleted).
        if (rendered === 0) {
            await gotoWatchLater(page)
            rendered = await page.locator(SEL.item).count()
            if (rendered === 0) break // truly empty
        }

        const outcome = await removeRow(page, 0)
        if (outcome.ok) {
            removed++
            consecutiveFailures = 0
            console.log(`Removed ${removed}: ${outcome.href ?? '(no href)'}`)
        } else {
            consecutiveFailures++
            logRemovalFailure(outcome, consecutiveFailures)
            if (consecutiveFailures >= 3) {
                // Most likely a UI language mismatch or a YouTube layout change.
                console.error('Giving up. Set REMOVE_TEXT to match your menu label, or update SEL selectors.')
                break
            }
            await gotoWatchLater(page) // reset UI state
        }

        await sleep(DELAY_MS)
    }

    return removed
}

/**
 * --num-days: scan the rendered rows, remove the first one older than the
 * cutoff, and scroll for the next lazy-loaded batch when none qualifies.
 * A scroll that yields no new rows means the whole list has been scanned.
 */
async function removeVideosOlderThan(page: Page, olderThanDays: number): Promise<number> {
    let removed = 0
    let consecutiveFailures = 0

    while (removed < MAX) {
        let rows = await scanRows(page)

        // Zero rows means the list is empty OR the batch was not rendered yet;
        // one reload tells the two apart (mirrors the --clear-all loop).
        if (rows.length === 0) {
            await gotoWatchLater(page)
            rows = await scanRows(page)
            if (rows.length === 0) break
        }

        const targetIndex = findRemovalIndex(rows, olderThanDays)
        if (targetIndex < 0) {
            // Every rendered row is young or undatable: scroll to lazy-load the
            // next batch; no growth means we have reached the end of the list.
            const renderedBefore = rows.length
            await page
                .locator(SEL.item)
                .last()
                .scrollIntoViewIfNeeded()
                .catch(() => {})
            await sleep(SCROLL_SETTLE_MS)
            const renderedAfter = await page.locator(SEL.item).count()
            if (renderedAfter <= renderedBefore) {
                const undatable = rows.filter((row) => row.ageDays === undefined).length
                const keptUndatable = undatable > 0 ? `, plus ${undatable} row(s) with no parseable date` : ''
                console.log(`End of list: kept every row younger than ${olderThanDays} days${keptUndatable}.`)
                break
            }
            continue
        }

        const target = rows[targetIndex]
        const outcome = await removeRow(page, targetIndex)
        if (outcome.ok) {
            removed++
            consecutiveFailures = 0
            const age = target.ageDays === undefined ? 'unknown' : `${Math.round(target.ageDays)}d`
            console.log(`Removed ${removed}: ${outcome.href ?? '(no href)'} (age ${age} > ${olderThanDays}d)`)
        } else {
            consecutiveFailures++
            logRemovalFailure(outcome, consecutiveFailures)
            if (consecutiveFailures >= 3) {
                console.error('Giving up. Set REMOVE_TEXT to match your menu label, or update SEL selectors.')
                break
            }
            await gotoWatchLater(page) // reset UI state
        }

        await sleep(DELAY_MS)
    }

    return removed
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    // Parse BEFORE opening a browser: help and usage errors must not touch it.
    const mode = parseArgs(process.argv.slice(2))

    if (mode.kind === 'help') {
        console.log(formatHelp())
        return
    }
    if (mode.kind === 'usage-error') {
        console.error(mode.message)
        console.error('')
        console.error(formatHelp())
        process.exitCode = 1
        return
    }

    const { page, close } = await openPage()
    try {
        await gotoWatchLater(page)
        const total = await headerCount(page)
        console.log(`Watch Later reports: ${total ?? 'unknown'} videos`)

        if (DRY_RUN) {
            if (mode.kind === 'num-days') {
                const cutoffDays = mode.days // capture before the closure
                const rows = await scanRows(page)
                const wouldRemove = rows.filter((row) => isOlderThan(row, cutoffDays)).length
                console.log(
                    `DRY_RUN: ${rows.length} rendered row(s); ${wouldRemove} would be removed (older than ${cutoffDays} days). Nothing removed.`
                )
            } else {
                console.log(`DRY_RUN: ${await page.locator(SEL.item).count()} rows rendered on first page. Nothing removed.`)
            }
            return
        }

        if (!(await confirmRemoval(mode, total))) {
            console.log('Aborted. Nothing removed.')
            return
        }

        const removed =
            mode.kind === 'clear-all' ? await removeAllVideos(page) : await removeVideosOlderThan(page, mode.days)
        console.log(
            mode.kind === 'clear-all'
                ? `Done. Removed ${removed} video(s).`
                : `Done. Removed ${removed} video(s) older than ${mode.days} days.`
        )
    } finally {
        await close()
    }
}

main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
})
