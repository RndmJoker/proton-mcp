import { describe, it, expect } from 'vitest'
import {
  worthWaiting,
  rescheduled,
  delayAfter,
  dueNow,
  nextWake,
  applyWaits,
  view,
  RETRY_STEPS_MS,
  type QueueEntry,
  type QueuedWork,
} from '../../extension/lib/queue.js'

/**
 * The decisions of the extension's queue (#59). Measured on 06.11.2026: while
 * Proton applies a filter, which can take hours, it refuses to apply another,
 * and nothing else. So only applications wait, one after the other, for as
 * long as Chrome stays open, asked about at growing intervals.
 */

const apply = (id: string, nextAt = 0): QueueEntry => ({
  id,
  account: 'me@example.com',
  how: 'confirmed',
  queuedAt: 1_000,
  attempts: 1,
  nextAt,
  work: { action: 'apply', name: id, filterId: `${id}==`, sieve: 'x' },
})

const reorder: QueuedWork = { action: 'reorder', name: 'order', before: ['a'], after: ['a'] }

describe('what is worth waiting for', () => {
  it('on the first attempt, only Proton being busy', () => {
    expect(worthWaiting('in-progress', false)).toBe(true)
    expect(worthWaiting('busy', false)).toBe(true)
    expect(worthWaiting('no-proton-tab', false)).toBe(false)
    expect(worthWaiting('refused', false)).toBe(false)
  })

  it('once queued, also a closed or signed out Proton tab, but never a refusal', () => {
    for (const error of ['in-progress', 'busy', 'no-proton-tab', 'signed-out', 'wrong-account', 'internal']) {
      expect(worthWaiting(error, true)).toBe(true)
    }
    for (const error of ['refused', 'not-found', 'proton-error', 'app-version']) {
      expect(worthWaiting(error, true)).toBe(false)
    }
  })
})

describe('the clock', () => {
  it('waits longer each time, from one minute up to fifteen, and then stays there', () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(delayAfter)).toEqual([60_000, 120_000, 300_000, 600_000, 900_000, 900_000, 900_000])
    expect(RETRY_STEPS_MS.at(-1)).toBe(15 * 60_000)
  })

  it('counts the attempt and keeps the reason', () => {
    expect(rescheduled(apply('a'), 5_000, 'Another action is currently in progress')).toMatchObject({
      attempts: 2,
      nextAt: 5_000 + 120_000,
      lastError: 'Another action is currently in progress',
    })
  })
})

describe('what runs when', () => {
  it('tries only the first waiting application, since Proton takes one at a time', () => {
    const queue = [apply('a'), apply('b')]
    expect(dueNow(queue, 10).map((entry) => entry.id)).toEqual(['a'])
    expect(applyWaits(queue)).toBe(true)
  })

  it('never holds a save or a move back behind an application', () => {
    const moved: QueueEntry = { ...apply('m'), work: reorder }
    expect(dueNow([apply('a', 999_999), moved], 10).map((entry) => entry.id)).toEqual(['m'])
    expect(applyWaits([moved])).toBe(false)
  })

  it('waits for an entry whose time has not come', () => {
    expect(dueNow([apply('a', 500)], 10)).toEqual([])
  })

  it('wakes for the first application and for saves and moves, not for an application behind another', () => {
    // Found in the review of 06.11.2026: the second application was due at
    // once but could not run, and woke the background every 30 seconds.
    expect(nextWake([apply('a', 900_000), apply('b', 0)])).toBe(900_000)
    const moved: QueueEntry = { ...apply('m', 300_000), work: reorder }
    expect(nextWake([apply('a', 900_000), apply('b', 0), moved])).toBe(300_000)
    expect(nextWake([])).toBeUndefined()
  })
})

describe('what is shown', () => {
  it('names the action, the filter, since when and how often it was tried, and nothing more', () => {
    expect(view([apply('a')])).toEqual([{ action: 'apply', name: 'a', since: 1_000, attempts: 1 }])
  })
})
