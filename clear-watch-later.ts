/**
 * clear-watch-later.ts
 *
 * Bulk-removes every video from your YouTube "Watch Later" playlist by driving
 * the real YouTube web UI with Playwright (the same clicks you would do by hand:
 * "..." menu -> "Remove from Watch later", repeated).
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
 *   DRY_RUN=1          Only count items, remove nothing.
 *   MAX=50             Stop after N removals (handy for a first test).
 *   DELAY_MS=400       Pause between removals (be gentle, avoid rate limits).
 *   REMOVE_TEXT=...    Menu label regex if your YouTube UI is not English,
 *                      e.g. REMOVE_TEXT="Supprimer de" or "後で見るから削除".
 *
 * Run:
 *   npm i
 *   npx playwright install chromium   # only needed for MODE=persistent without Chrome
 *   npx tsx clear-watch-later.ts
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import * as readline from 'node:readline/promises'
import * as path from 'node:path'
import * as os from 'node:os'

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
    if (await signIn.first().isVisible({ timeout: 3000 }).catch(() => false)) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
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
 */
async function headerCount(page: Page): Promise<number | undefined> {
    const text = await page
        .locator('ytd-playlist-header-renderer, yt-page-header-renderer, ytd-playlist-sidebar-renderer')
        .first()
        .innerText({ timeout: 3000 })
        .catch(() => '')
    const m = text.replace(/,/g, '').match(/(\d+)\s+videos?/i)
    return m?.[1] ? Number(m[1]) : undefined
}

/**
 * Remove the first row currently rendered on the page.
 * Returns true on success, false if the menu entry could not be found.
 */
async function removeFirst(page: Page): Promise<boolean> {
    const row = page.locator(SEL.item).first()
    await row.scrollIntoViewIfNeeded()

    // The "..." button only becomes visible on hover in some layouts.
    await row.hover()
    await row.locator(SEL.menuButton).first().click()

    // The popup is rendered at document level (ytd-popup-container), not inside the row.
    const entry = page.locator(SEL.menuEntry).filter({ hasText: REMOVE_TEXT }).first()
    try {
        await entry.waitFor({ state: 'visible', timeout: 5000 })
    } catch {
        await page.keyboard.press('Escape') // close whatever menu opened
        return false
    }

    // Grab a stable identity for the row so we can confirm it actually vanished.
    const href = await row.locator('a#video-title, a#thumbnail').first().getAttribute('href')
    await entry.click()

    // Wait until that specific video is no longer the first row.
    if (href) {
        await page
            .waitForFunction(
                ([sel, h]) => {
                    const first = document.querySelector(sel)
                    const a = first?.querySelector('a#video-title, a#thumbnail')
                    return !first || a?.getAttribute('href') !== h
                },
                [SEL.item, href] as const,
                { timeout: 8000 }
            )
            .catch(() => {
                /* slow network: the outer loop re-checks anyway */
            })
    }
    return true
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const { page, close } = await openPage()
    try {
        await gotoWatchLater(page)
        console.log(`Watch Later reports: ${(await headerCount(page)) ?? 'unknown'} videos`)

        if (DRY_RUN) {
            console.log(`DRY_RUN: ${await page.locator(SEL.item).count()} rows rendered on first page. Nothing removed.`)
            return
        }

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

            const ok = await removeFirst(page)
            if (ok) {
                removed++
                consecutiveFailures = 0
                if (removed % 25 === 0) console.log(`Removed ${removed}...`)
            } else {
                consecutiveFailures++
                console.warn(`Could not find "${REMOVE_TEXT.source}" in menu (attempt ${consecutiveFailures}).`)
                if (consecutiveFailures >= 3) {
                    // Most likely a UI language mismatch or a YouTube layout change.
                    console.error('Giving up. Set REMOVE_TEXT to match your menu label, or update SEL selectors.')
                    break
                }
                await gotoWatchLater(page) // reset UI state
            }

            await sleep(DELAY_MS)
        }

        console.log(`Done. Removed ${removed} video(s).`)
    } finally {
        await close()
    }
}

main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
})
