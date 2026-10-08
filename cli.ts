/**
 * cli.ts
 *
 * The command-line surface of clear-watch-later.ts: argument parsing, help
 * text, and the --num-days date filter (parsing a row's displayed date and
 * picking the row to remove).
 *
 * Pure functions only - no Playwright, no I/O - so everything here can be
 * unit-tested without a browser (see cli.test.ts).
 */

/** What the command line asked for, after parsing. */
export type CliMode =
    { kind: 'clear-all' } | { kind: 'num-days'; days: number } | { kind: 'help' } | { kind: 'usage-error'; message: string }

/** The two modes that actually remove videos (the other two exit early). */
export type RemovalMode = Extract<CliMode, { kind: 'clear-all' } | { kind: 'num-days' }>

/** One playlist row after its displayed date text has been parsed. */
export type RowAge = {
    /** Link href of the row's video (null when YouTube rendered no link). */
    href: string | null
    /** Age in days from the row's displayed date; undefined when unparseable. */
    ageDays: number | undefined
}

/** Smallest value accepted by --num-days. */
const MINIMUM_DAYS = 1

/**
 * Approximate days per relative-date unit, for the strings YouTube renders on
 * a row ("3 days ago", "8mo ago", "Streamed live 5 days ago").
 * Weeks/months/years are rounded (7/30/365) - good enough for a filter.
 */
const UNIT_DAYS: Record<string, number> = {
    second: 1 / 86_400,
    sec: 1 / 86_400,
    minute: 1 / 1_440,
    min: 1 / 1_440,
    hour: 1 / 24,
    hr: 1 / 24,
    day: 1,
    week: 7,
    wk: 7,
    month: 30,
    mo: 30,
    year: 365,
    yr: 365,
}

/** Matches a relative date anywhere inside a row's metadata text. */
const RELATIVE_DATE =
    /(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|mos?|years?|yrs?)\s+ago\b/gi

/**
 * Parse process.argv (without node/script) into a mode.
 *
 *   (no arguments)              -> usage-error (caller prints help, exits 1)
 *   --help | -h                 -> help         (caller prints help, exits 0)
 *   --clear-all                 -> clear-all
 *   --num-days X | --num-days=X -> num-days with X >= 1 (whole number)
 *   both modes / unknown flags  -> usage-error
 */
export function parseArgs(argv: readonly string[]): CliMode {
    if (argv.length === 0) {
        return {
            kind: 'usage-error',
            message: 'No mode given: pass --clear-all or --num-days <X>.',
        }
    }

    let mode: CliMode | null = null

    for (let argIndex = 0; argIndex < argv.length; argIndex++) {
        const argument = argv[argIndex]

        if (argument === '--help' || argument === '-h') {
            return { kind: 'help' }
        }

        let daysText: string | null = null
        if (argument === '--clear-all') {
            // falls through to the shared conflict check below
        } else if (argument === '--num-days') {
            const value = argv[argIndex + 1]
            if (value === undefined) {
                return {
                    kind: 'usage-error',
                    message: '--num-days needs a whole number of days, e.g. --num-days 30.',
                }
            }
            daysText = value
            argIndex++
        } else if (argument.startsWith('--num-days=')) {
            daysText = argument.slice('--num-days='.length)
        } else {
            return { kind: 'usage-error', message: `Unknown argument: ${argument}` }
        }

        if (mode !== null) {
            return {
                kind: 'usage-error',
                message: 'Pick exactly one mode: --clear-all or --num-days <X>.',
            }
        }

        if (daysText === null) {
            mode = { kind: 'clear-all' }
            continue
        }

        const days = Number(daysText)
        if (!Number.isInteger(days) || days < MINIMUM_DAYS) {
            return {
                kind: 'usage-error',
                message: `--num-days needs a whole number >= ${MINIMUM_DAYS}, got "${daysText}".`,
            }
        }
        mode = { kind: 'num-days', days }
    }

    // argv was non-empty and every branch above either set mode or returned.
    return (
        mode ?? {
            kind: 'usage-error',
            message: 'No mode given: pass --clear-all or --num-days <X>.',
        }
    )
}

/**
 * Age in days implied by a row's displayed date text, or undefined when the
 * text holds no relative date ("Premieres in 3 days", empty metadata, ...).
 *
 * When the text holds several relative dates, the LAST one wins: YouTube puts
 * the date at the end of the metadata line, so an earlier match would be a
 * view count or a title fragment.
 */
export function parseAgeDays(dateText: string): number | undefined {
    const matches = Array.from(dateText.matchAll(RELATIVE_DATE))
    const lastMatch = matches.at(-1)
    if (lastMatch === undefined) return undefined

    const amount = Number(lastMatch[1])
    const unit = lastMatch[2].toLowerCase().replace(/s$/, '')
    const daysPerUnit = UNIT_DAYS[unit]
    if (daysPerUnit === undefined) return undefined

    return amount * daysPerUnit
}

/** True when a row should be removed under --num-days (dated AND older than the cutoff). */
export function isOlderThan(row: RowAge, olderThanDays: number): boolean {
    return row.ageDays !== undefined && row.ageDays > olderThanDays
}

/**
 * Index of the first row older than olderThanDays, or -1 when none qualifies.
 * Undatable rows are never selected, so they are never removed.
 */
export function findRemovalIndex(rows: readonly RowAge[], olderThanDays: number): number {
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        if (isOlderThan(rows[rowIndex], olderThanDays)) return rowIndex
    }
    return -1
}

/** Help text: printed to stdout for --help (exit 0), stderr for no/bad args (exit 1). */
export function formatHelp(): string {
    return `Usage:
  npx tsx clear-watch-later.ts --clear-all        Remove every video from Watch Later
  npx tsx clear-watch-later.ts --num-days <X>     Remove videos older than X days
  npx tsx clear-watch-later.ts --help             Show this help

Modes (exactly one is required; no arguments prints this help and exits 1):
  --clear-all          Remove every video in the Watch Later list.
  --num-days X         Remove only videos whose displayed date is older than X
                       days (whole number >= 1). Rows without a parseable date
                       are never removed.
  --help, -h           Show this help and exit 0.

Environment variables:
  MODE=cdp|persistent  How to reach the browser (default: cdp).
  CDP_URL=http://...   Debug endpoint for MODE=cdp (default: http://127.0.0.1:9222).
  DRY_RUN=1            Report what would be removed; remove nothing, ask nothing.
  MAX=50               Stop after N removals (good for a first test).
  DELAY_MS=400         Pause between removals (be gentle, avoid rate limits).
  REMOVE_TEXT=...      Menu label regex for a non-English YouTube UI.
  BROWSER_PATH=...     Browser executable for MODE=persistent.

Examples:
  npx tsx clear-watch-later.ts --num-days 30
  MAX=3 npx tsx clear-watch-later.ts --clear-all
  DRY_RUN=1 npx tsx clear-watch-later.ts --num-days 60
  npm start -- --num-days 30`
}
