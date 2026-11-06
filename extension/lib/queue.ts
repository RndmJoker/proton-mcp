/**
 * The extension's queue for filter applications Proton cannot take yet (#59).
 *
 * Measured on 06.11.2026: Proton applies a filter to the existing mail in the
 * background, and while that runs it refuses to apply another with "Another
 * action is currently in progress. Try again later". On a large mailbox such a
 * run can take hours (Tobi). Everything else, saving, replacing and moving,
 * goes through as usual meanwhile.
 *
 * So an application the user agreed to waits here instead of failing, until
 * Proton takes it, one after the other, for as long as Chrome stays open
 * (Tobi, 06.11.2026). Saving and moving never wait behind it; they join only
 * in the unlikely case that Proton calls itself busy for them as well.
 *
 * The attempts space out, from one minute to at most fifteen: a run that takes
 * hours does not need to be asked about every minute, and every attempt reads
 * the whole filter list once.
 *
 * The queue is kept in local storage, so the background going to sleep in
 * between does not lose it. When Chrome starts, or the extension is reloaded,
 * updated or switched off and on again, what waited is dropped instead, each
 * entry noted in the list of changes: an action that waited through a restart
 * would run at a moment nobody expects any more.
 *
 * Only the decisions are here, kept free of browser calls so they can be
 * tested. Running them is the background's work.
 */

import type { ProtonFilter, QueuedAction } from '../../src/browser/messages.js'

/** The waits between attempts, in order; the last one repeats. Chrome's alarms allow nothing under 30 seconds. */
export const RETRY_STEPS_MS = [1, 2, 5, 10, 15].map((minutes) => minutes * 60_000)

/** The work itself, as it was agreed to or allowed. */
export type QueuedWork =
  | {
      action: 'save'
      name: string
      sieve: string
      /** The filter as it was when the change was agreed to; a change since means it is not run. */
      current?: ProtonFilter
      /** Whether to apply it to the mail already there once it is saved. */
      apply: boolean
    }
  | {
      action: 'apply'
      name: string
      filterId: string
      /** The script agreed to; a filter changed since is not applied. */
      sieve: string
    }
  | {
      action: 'reorder'
      name: string
      before: string[]
      after: string[]
    }
  | {
      action: 'delete'
      name: string
      filterId: string
      /** The script as it was when deleting was agreed to; a filter changed since is not deleted. */
      sieve: string
    }
  | {
      action: 'status'
      name: string
      filterId: string
      enabled: boolean
      sieve: string
    }

export interface QueueEntry {
  id: string
  account: string
  how: 'confirmed' | 'without asking'
  queuedAt: number
  attempts: number
  nextAt: number
  lastError?: string
  work: QueuedWork
}

/** What came of one attempt. */
export type Attempt =
  | { status: 'done'; message: string; filterId?: string }
  | { status: 'retry'; message: string }
  | { status: 'failed'; message: string }

/**
 * Errors that only mean "not now". On the first attempt only Proton being
 * busy counts: anything else is better reported at once than queued. Once an
 * action waits, a closed or signed-out Proton tab is waited out as well.
 */
const BUSY = new Set(['in-progress', 'busy'])
const WAITABLE = new Set(['in-progress', 'busy', 'no-proton-tab', 'signed-out', 'wrong-account', 'internal'])

export function worthWaiting(error: string, alreadyQueued: boolean): boolean {
  return (alreadyQueued ? WAITABLE : BUSY).has(error)
}

/** How long to wait before the attempt after this many. */
export function delayAfter(attempts: number): number {
  return RETRY_STEPS_MS[Math.min(Math.max(attempts, 1), RETRY_STEPS_MS.length) - 1]!
}

/** The entry after a failed attempt that is worth another. */
export function rescheduled(entry: QueueEntry, now: number, message: string): QueueEntry {
  const attempts = entry.attempts + 1
  return { ...entry, attempts, nextAt: now + delayAfter(attempts), lastError: message }
}

/**
 * The entries to try now: every due one that is not an application, and of
 * the applications only the first, since Proton runs one at a time and they
 * keep their order.
 */
export function dueNow(queue: readonly QueueEntry[], now: number): QueueEntry[] {
  const firstApply = queue.find((entry) => entry.work.action === 'apply')
  return queue.filter((entry) => entry.nextAt <= now && (entry.work.action !== 'apply' || entry === firstApply))
}

/**
 * When the next entry can be tried: the earliest among the ones dueNow would
 * consider. A later application waits for the first, so its own time does not
 * count; it once woke the background every 30 seconds for nothing.
 */
export function nextWake(queue: readonly QueueEntry[]): number | undefined {
  const firstApply = queue.find((entry) => entry.work.action === 'apply')
  const candidates = queue.filter((entry) => entry.work.action !== 'apply' || entry === firstApply)
  return candidates.length > 0 ? Math.min(...candidates.map((entry) => entry.nextAt)) : undefined
}

/** True when an application already waits, so a new one has to wait behind it. */
export function applyWaits(queue: readonly QueueEntry[]): boolean {
  return queue.some((entry) => entry.work.action === 'apply')
}

/** The queue as the server and the popup see it: what, since when, how often tried. */
export function view(queue: readonly QueueEntry[]): QueuedAction[] {
  return queue.map((entry) => ({
    action: entry.work.action,
    name: entry.work.name,
    since: entry.queuedAt,
    attempts: entry.attempts,
  }))
}
