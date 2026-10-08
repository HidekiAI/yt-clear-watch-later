/**
 * cli.test.ts
 *
 * Unit tests for the pure CLI logic in cli.ts. Run with: npm test
 * No browser involved.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, parseAgeDays, findRemovalIndex, isOlderThan, formatHelp, type RowAge } from './cli.ts'

test('parseArgs: no arguments is a usage error (caller dumps help, exits 1)', () => {
    const mode = parseArgs([])
    assert.equal(mode.kind, 'usage-error')
})

test('parseArgs: --help and -h ask for help', () => {
    assert.equal(parseArgs(['--help']).kind, 'help')
    assert.equal(parseArgs(['-h']).kind, 'help')
})

test('parseArgs: --clear-all', () => {
    assert.deepEqual(parseArgs(['--clear-all']), { kind: 'clear-all' })
})

test('parseArgs: --num-days with space and with equals form', () => {
    assert.deepEqual(parseArgs(['--num-days', '30']), {
        kind: 'num-days',
        days: 30,
    })
    assert.deepEqual(parseArgs(['--num-days=30']), {
        kind: 'num-days',
        days: 30,
    })
})

test('parseArgs: --num-days rejects missing, non-numeric, zero and fractional values', () => {
    assert.equal(parseArgs(['--num-days']).kind, 'usage-error')
    assert.equal(parseArgs(['--num-days', 'abc']).kind, 'usage-error')
    assert.equal(parseArgs(['--num-days', '0']).kind, 'usage-error')
    assert.equal(parseArgs(['--num-days', '-5']).kind, 'usage-error')
    assert.equal(parseArgs(['--num-days', '30.5']).kind, 'usage-error')
    assert.equal(parseArgs(['--num-days=']).kind, 'usage-error')
})

test('parseArgs: both modes together and unknown flags are usage errors', () => {
    assert.equal(parseArgs(['--clear-all', '--num-days', '30']).kind, 'usage-error')
    assert.equal(parseArgs(['--num-days', '30', '--clear-all']).kind, 'usage-error')
    assert.equal(parseArgs(['--bogus']).kind, 'usage-error')
    assert.equal(parseArgs(['30']).kind, 'usage-error')
})

test('formatHelp documents every mode flag', () => {
    const help = formatHelp()
    assert.match(help, /--clear-all/)
    assert.match(help, /--num-days/)
    assert.match(help, /--help/)
})

test('parseAgeDays: word units', () => {
    assert.equal(parseAgeDays('3 days ago'), 3)
    assert.equal(parseAgeDays('4 years ago'), 4 * 365)
    assert.equal(parseAgeDays('2 weeks ago'), 14)
})

test('parseAgeDays: YouTube abbreviation "8mo ago" as seen on a real row', () => {
    assert.equal(parseAgeDays('8mo ago'), 8 * 30)
})

test('parseAgeDays: prefixed forms and view-count noise around the date', () => {
    assert.equal(parseAgeDays('Streamed live 5 days ago'), 5)
    assert.equal(parseAgeDays('Premiered 2 years ago'), 2 * 365)
    assert.equal(parseAgeDays('312K 8mo ago'), 8 * 30)
})

test('parseAgeDays: last relative date in the text wins', () => {
    assert.equal(parseAgeDays('3 days ago then 10 days ago'), 10)
})

test('parseAgeDays: anything without a past-relative date is undefined', () => {
    assert.equal(parseAgeDays(''), undefined)
    assert.equal(parseAgeDays('312K'), undefined)
    assert.equal(parseAgeDays('Premieres in 3 days'), undefined)
    assert.equal(parseAgeDays('no date at all'), undefined)
})

test('isOlderThan: strictly older than the cutoff, undatable rows never match', () => {
    const older: RowAge = { href: '/watch?v=old', ageDays: 31 }
    const younger: RowAge = { href: '/watch?v=new', ageDays: 30 }
    const undatable: RowAge = { href: '/watch?v=?', ageDays: undefined }
    assert.equal(isOlderThan(older, 30), true)
    assert.equal(isOlderThan(younger, 30), false) // equal to cutoff: kept
    assert.equal(isOlderThan(undatable, 0), false)
})

test('findRemovalIndex: picks the first qualifying row, skips young and undatable', () => {
    const rows: RowAge[] = [
        { href: '/watch?v=a', ageDays: 5 },
        { href: '/watch?v=b', ageDays: undefined },
        { href: '/watch?v=c', ageDays: 40 },
        { href: '/watch?v=d', ageDays: 90 },
    ]
    assert.equal(findRemovalIndex(rows, 30), 2)
    assert.equal(findRemovalIndex(rows, 100), -1)
    assert.equal(findRemovalIndex([], 30), -1)
})
