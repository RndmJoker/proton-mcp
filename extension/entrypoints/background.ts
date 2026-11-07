/**
 * The background of Proton MCP Helper (#59): the one part that talks to the
 * connector.
 *
 * It starts the connector through Chrome's native messaging as soon as Chrome
 * starts the extension, and keeps that channel open; an open channel also
 * keeps this background alive. Every request from the connector is read again
 * here against the fixed list, and every script is checked again with the
 * same rules the server used. Neither side trusts the other's check.
 *
 * Anything that changes the account, saving, applying, moving, deleting or
 * switching a filter on or off, waits for the user's yes in a window of this
 * extension. Only when both the server's level
 * and this extension's own switch for that action allow it does a change go
 * through without the window: the switches are set in the popup, all off by
 * default, so a program that read the connector's secret cannot skip the
 * window on its own (Tobi, 06.11.2026). A proposal waits in session storage,
 * which the Proton page cannot read, bound to the tab the window got, and the
 * decision counts once.
 *
 * Every write then goes one way, through submit(), and runs at once. Only
 * applying a filter to the mail already there can wait: while Proton is still
 * applying an earlier one, which on a large mailbox takes hours, it refuses,
 * and the application joins the queue (lib/queue.ts) until Proton takes it,
 * for as long as Chrome stays open. Saving and moving do not wait behind it.
 * A write that is tried again first looks whether an earlier try already
 * worked, so a lost answer does not make a second filter.
 *
 * What a filter may do beyond filing and flags is the user's to allow, one
 * action at a time, here in the popup as well as on the server's Permissions
 * page (Tobi, 06.11.2026). Every check in this extension uses what was allowed
 * here, never what the server says, so a program that reached the connector
 * cannot allow anything.
 */

import { defineBackground } from 'wxt/utils/define-background'
import { browser } from 'wxt/browser'
import { HOST_NAME, parseRequest, type BrowserRequest, type BrowserResponse, type ProtonFilter } from '../../src/browser/messages.js'
import { reviewSieve, filterNameProblem, sameScript, parseUnlocks, UNLOCKABLE, type Unlockable } from '../../src/filters/sieve.js'
import { applyMoves, sameOrder, movedFilters, orderWarnings, OrderError } from '../../src/filters/order.js'
import type { ApiResult } from '../lib/proton-api.js'
import {
  parsePageMessage,
  readSwitches,
  PROPOSAL_LIFETIME_MS,
  type Change,
  type ContentOp,
  type PendingProposal,
  type Switches,
} from '../lib/ops.js'
import { worthWaiting, rescheduled, dueNow, applyWaits, nextWake, view, type Attempt, type QueueEntry, type QueuedWork } from '../lib/queue.js'

const PROTON_PAGES = ['https://mail.proton.me/*', 'https://account.proton.me/*']
const MAX_CHANGES = 50
const ALARM = 'proton-mcp-queue'
/** A reason or a name kept in the list of changes is cut here: a long one once broke list_filters. */
const MAX_DETAIL = 500
const MAX_LOGGED_NAME = 200

type Failure = Extract<BrowserResponse, { ok: false }>
type DoneOutcome = 'added' | 'replaced' | 'applied' | 'reordered' | 'deleted' | 'enabled' | 'disabled'
/** Every action allowed, for describing what a filter does rather than checking it. */
const DESCRIBE_ALL: ReadonlySet<Unlockable> = new Set(UNLOCKABLE)
type HostState = { state: 'starting' | 'connected' | 'error' | 'disconnected'; message?: string; at: number }
/** A change as kept here: with the account, which is stripped before it leaves. */
type StoredChange = Change & { account?: string }
type Submitted =
  | { status: 'done'; outcome: DoneOutcome; filterId?: string; apply?: 'done' | 'queued' | 'failed' }
  | { status: 'queued' }
  | { status: 'failed'; message: string }

function failure(error: Failure['error'], message: string): Failure {
  return { ok: false, error, message: message.slice(0, 3_900) }
}

/** A failure from the Proton page, in the codes the server knows: busy stays busy. */
function asFailure(result: { error: string; message: string }): Failure {
  const error = result.error === 'in-progress' ? 'busy' : result.error
  return failure(error as Failure['error'], result.message)
}

const QUEUED_TEXT =
  'Proton is still applying an earlier filter to the mail already there, which on a large mailbox can take ' +
  'hours, and takes no other until it is done. So this waits in the queue of the extension until Proton ' +
  'takes it, for as long as Chrome stays open; the popup of the extension shows it and can cancel it.'

const APPLIED_TEXT =
  'Applied. Proton works through the mail already there in the background. On a large mailbox that can ' +
  'take hours, and nothing reports when it is done.'

export default defineBackground(() => {
  let port: ReturnType<typeof browser.runtime.connectNative> | undefined
  /** The tab each new confirmation window got, while Chrome is still opening it. */
  const opening = new Map<string, Promise<number | undefined>>()
  /** Queue entries being tried right now, which cancelling cannot stop any more. */
  const inFlight = new Set<string>()

  const setHost = (state: HostState['state'], message?: string): Promise<void> =>
    browser.storage.session.set({ host: { state, ...(message ? { message: message.slice(0, 500) } : {}), at: Date.now() } })

  function connect(): void {
    if (port) return
    try {
      port = browser.runtime.connectNative(HOST_NAME)
    } catch (error) {
      void setHost('error', String(error))
      return
    }
    void setHost('starting')
    port.onMessage.addListener((message: unknown) => void onHostMessage(message))
    port.onDisconnect.addListener(() => {
      const reason = browser.runtime.lastError?.message
      port = undefined
      void browser.storage.session.get('host').then((stored) => {
        // A reason the connector gave before it ended says more than Chrome's.
        if ((stored.host as HostState | undefined)?.state === 'error') return
        return setHost('disconnected', reason ?? 'The connector stopped.')
      })
    })
  }

  async function onHostMessage(message: unknown): Promise<void> {
    if (typeof message !== 'object' || message === null) return
    const { type, id, body } = message as Record<string, unknown>
    if (type === 'host-ready') return setHost('connected')
    if (type === 'host-error') {
      const text = (message as { message?: unknown }).message
      return setHost('error', typeof text === 'string' ? text : 'The connector gave up.')
    }
    if (type !== 'request' || typeof id !== 'string' || !/^h\d{1,12}$/.test(id)) return
    const request = parseRequest(body)
    let answer: BrowserResponse
    try {
      answer = request ? await handle(request) : failure('unknown-request', 'The extension does not take this request.')
    } catch (error) {
      answer = failure('internal', String(error))
    }
    port?.postMessage({ type: 'response', id, body: answer })
  }

  /** Tabs with a Proton page this extension may work in. */
  async function protonTabs(): Promise<number[]> {
    const tabs = await browser.tabs.query({ url: PROTON_PAGES })
    return tabs.map((tab) => tab.id).filter((id): id is number => typeof id === 'number')
  }

  /** Asks the script in a Proton tab to call Proton. */
  async function inTab<T>(tabId: number, op: ContentOp): Promise<ApiResult<T> | Failure> {
    try {
      const result = (await browser.tabs.sendMessage(tabId, op)) as ApiResult<T> | undefined
      return result ?? failure('internal', 'The Proton tab did not answer.')
    } catch {
      return failure('no-proton-tab', 'The Proton tab does not have the extension yet, or was reloaded. Reload it once.')
    }
  }

  /**
   * The tab whose page is signed in to the account that holds this address.
   * Tobi's decision of 05.11.2026: with several accounts open, a filter must
   * not land in the wrong one. The script in the page checks it once more
   * right before it writes.
   */
  async function accountTab(account: string): Promise<{ ok: true; id: number } | Failure> {
    const tabs = await protonTabs()
    if (tabs.length === 0) return failure('no-proton-tab', 'No Proton page is open in Chrome.')
    const wanted = account.toLowerCase()
    let other = false
    let signedOut = false
    let last: Failure | undefined
    for (const tab of tabs) {
      const result = await inTab<string[]>(tab, { op: 'addresses' })
      if (result.ok) {
        if (result.value.includes(wanted)) return { ok: true, id: tab }
        other = true
      } else if (result.error === 'signed-out') {
        signedOut = true
      } else {
        last = asFailure(result)
      }
    }
    if (other) return failure('wrong-account', 'The Proton pages open in Chrome belong to other accounts.')
    if (signedOut) return failure('signed-out', 'The Proton page is signed out.')
    return last ?? failure('no-proton-tab', 'No Proton page with the extension is open.')
  }

  // The list of changes, written one at a time so none is lost.

  let logLock: Promise<unknown> = Promise.resolve()
  function logChange(change: StoredChange): Promise<void> {
    const next = logLock.then(async () => {
      const stored = await browser.storage.local.get('changes')
      const changes = Array.isArray(stored.changes) ? (stored.changes as StoredChange[]) : []
      changes.unshift({
        ...change,
        name: change.name.slice(0, MAX_LOGGED_NAME),
        ...(change.detail !== undefined ? { detail: change.detail.slice(0, MAX_DETAIL) } : {}),
      })
      await browser.storage.local.set({ changes: changes.slice(0, MAX_CHANGES) })
    })
    logLock = next.catch(() => undefined)
    return next
  }

  /** The last changes for this account, as the server gets them: without the account. */
  async function recentChanges(account: string): Promise<Change[]> {
    const stored = await browser.storage.local.get('changes')
    const changes = Array.isArray(stored.changes) ? (stored.changes as StoredChange[]) : []
    return changes
      .filter((change) => change.account === undefined || change.account === account)
      .slice(0, 10)
      .map(({ account: _account, ...change }) => change)
  }

  /** What a filter may do beyond filing and flags, as allowed in this extension's popup. Nothing by default. */
  async function unlocked(): Promise<ReadonlySet<Unlockable>> {
    const stored = await browser.storage.local.get('unlocks')
    return new Set(parseUnlocks(stored.unlocks) ?? [])
  }

  /** The rules of sieve.ts once more, here, whatever the server checked. */
  function refusal(name: string, sieve: string, unlocks: ReadonlySet<Unlockable>): Failure | undefined {
    const problems = [filterNameProblem(name), ...reviewSieve(sieve, unlocks).problems].filter((p): p is string => p !== undefined)
    return problems.length > 0 ? failure('refused', problems.join(' ')) : undefined
  }

  /** The same rules for a script that is applied or switched on rather than saved, whose name does not change. */
  function scriptRefusal(sieve: string, unlocks: ReadonlySet<Unlockable>): Failure | undefined {
    const problems = reviewSieve(sieve, unlocks).problems
    return problems.length > 0 ? failure('refused', problems.join(' ')) : undefined
  }

  /** A stored filter that does what an assistant may not set up is not replaced by one either. */
  function protectedFilter(filter: ProtonFilter, unlocks: ReadonlySet<Unlockable>): Failure | undefined {
    const review = reviewSieve(filter.sieve, unlocks)
    if (review.problems.length === 0) return undefined
    return failure(
      'refused',
      `The filter "${filter.name}" ` +
        (review.refused.length > 0
          ? `does ${review.refused.join(', ')}, which is not allowed in the popup of the extension`
          : 'does not pass the rules a proposal meets') +
        ". Otherwise changing it is left to the user, in Proton's settings.",
    )
  }

  async function sortedFilters(tab: number): Promise<{ ok: true; filters: ProtonFilter[] } | Failure> {
    const list = await inTab<ProtonFilter[]>(tab, { op: 'filters' })
    if (!list.ok) return asFailure(list)
    return { ok: true, filters: [...list.value].sort((a, b) => a.order - b.order) }
  }

  async function currentFilter(tab: number, id: string): Promise<{ ok: true; filter: ProtonFilter } | Failure> {
    const list = await sortedFilters(tab)
    if (!list.ok) return list
    const filter = list.filters.find((candidate) => candidate.id === id)
    return filter ? { ok: true, filter } : failure('not-found', 'The filter does not exist any more.')
  }

  // The extension's own switches

  async function switches(): Promise<Switches> {
    const stored = await browser.storage.local.get('switches')
    return readSwitches(stored.switches)
  }

  // The queue

  let lock: Promise<unknown> = Promise.resolve()
  /** Runs one change of the stored queue at a time, so two of them never overwrite each other. */
  function locked<T>(work: () => Promise<T>): Promise<T> {
    const next = lock.then(work)
    lock = next.catch(() => undefined)
    return next
  }
  // Local storage, so reloading or updating the extension keeps what waits.
  // Chrome starting clears it, see onStartup below.
  async function loadQueue(): Promise<QueueEntry[]> {
    const stored = await browser.storage.local.get('queue')
    return Array.isArray(stored.queue) ? (stored.queue as QueueEntry[]) : []
  }
  const storeQueue = (queue: QueueEntry[]): Promise<void> => browser.storage.local.set({ queue })
  const enqueue = (entry: QueueEntry): Promise<void> => locked(async () => storeQueue([...(await loadQueue()), entry]))
  function wakeAt(when: number): void {
    void browser.alarms.create(ALARM, { when: Math.max(when, Date.now() + 30_000) })
  }

  const applyWork = (name: string, filterId: string, sieve: string): QueuedWork => ({ action: 'apply', name, filterId, sieve })

  /**
   * Does the work once. For an action that already waits, a closed or signed
   * out Proton tab is waited out as well; on the first try only Proton being
   * busy is. Each kind of work first looks whether an earlier try already
   * did it, since an answer can be lost on the way back.
   */
  async function attempt(entry: QueueEntry, inQueue: boolean): Promise<Attempt & { follow?: QueuedWork }> {
    const settle = (result: { error: string; message: string }): Attempt =>
      worthWaiting(result.error, inQueue) ? { status: 'retry', message: result.message } : { status: 'failed', message: result.message }
    const tab = await accountTab(entry.account)
    if (!tab.ok) return settle(tab)
    const account = entry.account
    const work = entry.work
    const unlocks = await unlocked()
    const allowed = [...unlocks]
    switch (work.action) {
      case 'save': {
        const refused = refusal(work.name, work.sieve, unlocks)
        if (refused) return { status: 'failed', message: refused.message }
        const list = await sortedFilters(tab.id)
        if (!list.ok) return settle(list)
        const follow = (filterId: string): { follow?: QueuedWork } => (work.apply ? { follow: applyWork(work.name, filterId, work.sieve) } : {})
        if (work.current) {
          const stored = list.filters.find((filter) => filter.id === work.current!.id)
          if (!stored) return { status: 'failed', message: 'The filter to replace does not exist any more.' }
          if (stored.name === work.name && sameScript(stored.sieve, work.sieve)) {
            return { status: 'done', message: 'replaced', filterId: stored.id, ...follow(stored.id) }
          }
          // The yes was given to a difference against the filter as it was.
          if (stored.name !== work.current.name || !sameScript(stored.sieve, work.current.sieve)) {
            return { status: 'failed', message: 'The filter changed since this was agreed to. Ask for a new proposal.' }
          }
          const guarded = protectedFilter(stored, unlocks)
          if (guarded) return { status: 'failed', message: guarded.message }
          const check = await inTab<string[]>(tab.id, { op: 'check', sieve: work.sieve })
          if (!check.ok) return settle(check)
          if (check.value.length > 0) return { status: 'failed', message: `Proton's check found: ${check.value.join('; ')}` }
          const updated = await inTab<void>(tab.id, { op: 'update', account, filter: stored, name: work.name, sieve: work.sieve, allowed })
          if (!updated.ok) return settle(updated)
          return { status: 'done', message: 'replaced', filterId: stored.id, ...follow(stored.id) }
        }
        const existing = list.filters.find((filter) => filter.name === work.name && sameScript(filter.sieve, work.sieve))
        if (existing) return { status: 'done', message: 'added', filterId: existing.id, ...follow(existing.id) }
        const check = await inTab<string[]>(tab.id, { op: 'check', sieve: work.sieve })
        if (!check.ok) return settle(check)
        if (check.value.length > 0) return { status: 'failed', message: `Proton's check found: ${check.value.join('; ')}` }
        const added = await inTab<string>(tab.id, { op: 'add', account, name: work.name, sieve: work.sieve, allowed })
        if (!added.ok) return settle(added)
        return {
          status: 'done',
          message: 'added',
          ...(added.value ? { filterId: added.value, ...follow(added.value) } : {}),
        }
      }
      case 'apply': {
        const found = await currentFilter(tab.id, work.filterId)
        if (!found.ok) return settle(found)
        if (!sameScript(found.filter.sieve, work.sieve)) {
          return { status: 'failed', message: 'The filter changed since applying it was agreed to. Ask again.' }
        }
        const refused = scriptRefusal(found.filter.sieve, unlocks)
        if (refused) return { status: 'failed', message: refused.message }
        const applied = await inTab<void>(tab.id, { op: 'apply', account, filterId: work.filterId, sieve: work.sieve, allowed })
        return applied.ok ? { status: 'done', message: 'applied' } : settle(applied)
      }
      case 'reorder': {
        const list = await sortedFilters(tab.id)
        if (!list.ok) return settle(list)
        const now = list.filters.map((filter) => filter.id)
        if (sameOrder(now, work.after)) return { status: 'done', message: 'reordered' }
        if (!sameOrder(now, work.before)) {
          return { status: 'failed', message: 'The order changed since this was agreed to. Ask again.' }
        }
        const ordered = await inTab<void>(tab.id, { op: 'order', account, ids: work.after })
        return ordered.ok ? { status: 'done', message: 'reordered' } : settle(ordered)
      }
      case 'delete': {
        const list = await sortedFilters(tab.id)
        if (!list.ok) return settle(list)
        const stored = list.filters.find((filter) => filter.id === work.filterId)
        // Gone already: an earlier try worked, or someone deleted it meanwhile.
        if (!stored) return { status: 'done', message: 'deleted' }
        if (!sameScript(stored.sieve, work.sieve)) {
          return { status: 'failed', message: 'The filter changed since deleting it was agreed to. Ask again.' }
        }
        const deleted = await inTab<void>(tab.id, { op: 'delete', account, filterId: work.filterId, sieve: work.sieve })
        return deleted.ok ? { status: 'done', message: 'deleted' } : settle(deleted)
      }
      case 'status': {
        const list = await sortedFilters(tab.id)
        if (!list.ok) return settle(list)
        const stored = list.filters.find((filter) => filter.id === work.filterId)
        if (!stored) return { status: 'failed', message: 'The filter does not exist any more.' }
        const done = work.enabled ? 'enabled' : 'disabled'
        if (stored.enabled === work.enabled) return { status: 'done', message: done }
        if (!sameScript(stored.sieve, work.sieve)) {
          return { status: 'failed', message: 'The filter changed since this was agreed to. Ask again.' }
        }
        if (work.enabled) {
          const refused = scriptRefusal(stored.sieve, unlocks)
          if (refused) return { status: 'failed', message: refused.message }
        }
        const switched = await inTab<void>(tab.id, {
          op: 'status',
          account,
          filterId: work.filterId,
          enabled: work.enabled,
          sieve: work.sieve,
          allowed,
        })
        return switched.ok ? { status: 'done', message: done } : settle(switched)
      }
    }
  }

  const newEntry = (work: QueuedWork, account: string, how: Change['how']): QueueEntry => ({
    id: crypto.randomUUID(),
    account,
    how,
    queuedAt: Date.now(),
    attempts: 0,
    nextAt: Date.now(),
    work,
  })

  const DONE: ReadonlySet<string> = new Set(['replaced', 'applied', 'reordered', 'deleted', 'enabled', 'disabled'])
  const doneOutcome = (message: string): DoneOutcome => (DONE.has(message) ? (message as DoneOutcome) : 'added')

  /**
   * Runs a write now. An application waits behind one that already waits,
   * since Proton takes them one at a time; saving and moving never wait
   * behind an application. Anything Proton calls itself too busy for joins
   * the queue. What came of it is logged.
   */
  async function submit(work: QueuedWork, account: string, how: Change['how']): Promise<Submitted> {
    const entry = newEntry(work, account, how)
    if (work.action === 'apply' && applyWaits(await waitingQueue())) {
      await enqueue(entry)
      await logChange({ at: Date.now(), name: work.name, outcome: 'queued', how, detail: 'behind an earlier application', account })
      void runQueue()
      return { status: 'queued' }
    }
    const result = await attempt(entry, false)
    if (result.status === 'retry') {
      const waiting = rescheduled(entry, Date.now(), result.message)
      await enqueue(waiting)
      await logChange({ at: Date.now(), name: work.name, outcome: 'queued', how, detail: result.message, account })
      wakeAt(waiting.nextAt)
      return { status: 'queued' }
    }
    if (result.status === 'failed') {
      await logChange({ at: Date.now(), name: work.name, outcome: 'failed', how, detail: result.message, account })
      return { status: 'failed', message: result.message }
    }
    const outcome = doneOutcome(result.message)
    await logChange({ at: Date.now(), name: work.name, outcome, how, account })
    let apply: 'done' | 'queued' | 'failed' | undefined
    if (result.follow) {
      const followed = await submit(result.follow, account, how)
      apply = followed.status === 'done' ? 'done' : followed.status
    }
    return {
      status: 'done',
      outcome,
      ...(result.filterId ? { filterId: result.filterId } : {}),
      ...(apply ? { apply } : {}),
    }
  }

  let running = false
  /**
   * Works through what is due: every waiting save or move, and the first
   * waiting application. Then sleeps until the next one is due.
   */
  async function runQueue(): Promise<void> {
    await settled
    if (running) return
    running = true
    try {
      for (;;) {
        const queue = await locked(loadQueue)
        if (queue.length === 0) return
        const due = dueNow(queue, Date.now())
        if (due.length === 0) {
          const wake = nextWake(queue)
          if (wake !== undefined) wakeAt(wake)
          return
        }
        for (const snapshot of due) {
          // Taken under the lock: a cancel either came first, and the entry
          // is gone, or comes after and finds it under way.
          const head = await locked(async () => {
            const current = (await loadQueue()).find((entry) => entry.id === snapshot.id)
            if (current) inFlight.add(current.id)
            return current
          })
          if (!head) continue
          try {
            const result = await attempt(head, true)
            if (result.status === 'retry') {
              const waiting = rescheduled(head, Date.now(), result.message)
              await locked(async () => storeQueue((await loadQueue()).map((entry) => (entry.id === head.id ? waiting : entry))))
              continue
            }
            await locked(async () => {
              const rest = (await loadQueue()).filter((entry) => entry.id !== head.id)
              // Applying a filter that was just saved waits behind the
              // applications already waiting, like any other.
              if (result.status === 'done' && result.follow) rest.push(newEntry(result.follow, head.account, head.how))
              await storeQueue(rest)
            })
            await logChange(
              result.status === 'done'
                ? { at: Date.now(), name: head.work.name, outcome: doneOutcome(result.message), how: head.how, account: head.account }
                : { at: Date.now(), name: head.work.name, outcome: 'failed', how: head.how, detail: result.message, account: head.account },
            )
          } finally {
            // Only once the queue says what came of it, so a cancel in
            // between cannot report as cancelled what just ran.
            inFlight.delete(head.id)
          }
        }
      }
    } finally {
      running = false
    }
  }

  /** What waited from before this start of the extension is not run, but noted. */
  async function dropQueue(before: number): Promise<void> {
    const dropped = await locked(async () => {
      const queue = await loadQueue()
      const old = queue.filter((entry) => entry.queuedAt < before)
      if (old.length > 0) await storeQueue(queue.filter((entry) => entry.queuedAt >= before))
      return old
    })
    for (const entry of dropped) {
      await logChange({
        at: Date.now(),
        name: entry.work.name,
        outcome: 'failed',
        how: entry.how,
        detail: 'Chrome or the extension restarted before Proton took it, so it was not run.',
        account: entry.account,
      })
    }
  }

  /**
   * What waits belongs to this run of Chrome and of this extension. Session
   * storage, which Chrome clears when it starts and when the extension is
   * reloaded, updated or switched off, carries a mark: without it, what still
   * waits is from before and is dropped before anything of it can run. Not
   * left to onStartup, which an alarm from before Chrome closed can beat.
   * Found in the review of 06.11.2026. A background that only went to sleep
   * finds the mark and goes on.
   */
  const startedAt = Date.now()
  const settled: Promise<void> = (async () => {
    const mark = await browser.storage.session.get('queueSession')
    if (!mark.queueSession) await dropQueue(startedAt)
    await browser.storage.session.set({ queueSession: true })
  })().catch(() => undefined)

  /** The queue as it stands, once what came from before is settled. */
  async function waitingQueue(): Promise<QueueEntry[]> {
    await settled
    return locked(loadQueue)
  }

  async function cancel(id: string): Promise<{ ok: boolean; message: string }> {
    const removed = await locked(async () => {
      // A try that is under way reaches Proton whatever happens here, so it
      // is not called cancelled. Found in the review of 06.11.2026.
      if (inFlight.has(id)) return 'under way' as const
      const queue = await loadQueue()
      const entry = queue.find((candidate) => candidate.id === id)
      if (entry) await storeQueue(queue.filter((candidate) => candidate.id !== id))
      return entry
    })
    if (removed === 'under way') {
      return {
        ok: false,
        message: 'Not cancelled: it is being tried right now, and that cannot be stopped. If Proton is still busy, it waits again and can be cancelled then.',
      }
    }
    if (!removed) return { ok: false, message: 'Not cancelled: it is not waiting any more. The list of changes shows what came of it.' }
    await logChange({
      at: Date.now(),
      name: removed.work.name,
      outcome: 'cancelled',
      how: 'confirmed',
      detail: 'cancelled in the popup',
      account: removed.account,
    })
    return { ok: true, message: 'Cancelled. It will not run.' }
  }

  // The window

  /**
   * Opens the confirmation window for a proposal and binds the proposal to the
   * tab Chrome opened for it, so the same address in any other tab gets nothing.
   */
  async function openWindow(pending: PendingProposal): Promise<Failure | undefined> {
    const key = `proposal:${pending.id}`
    await browser.storage.session.set({ [key]: pending })
    const created = browser.windows
      .create({
        url: browser.runtime.getURL(`/confirm.html#${pending.id}`),
        type: 'popup',
        width: 840,
        height: 780,
        focused: true,
      })
      .then((opened) => opened?.tabs?.[0]?.id)
    opening.set(pending.id, created)
    const tabId = await created.catch(() => undefined).finally(() => opening.delete(pending.id))
    if (tabId === undefined) {
      await browser.storage.session.remove(key)
      return failure('internal', 'The confirmation window could not be opened.')
    }
    await browser.storage.session.set({ [key]: { ...pending, tabId } })
    return undefined
  }

  /** The window that asks to apply a saved filter to the mail already there. */
  async function askToApply(tab: number, account: string, filterId: string): Promise<Failure | undefined> {
    const found = await currentFilter(tab, filterId)
    if (!found.ok) return found
    const unlocks = await unlocked()
    const refused = scriptRefusal(found.filter.sieve, unlocks)
    if (refused) return refused
    const review = reviewSieve(found.filter.sieve, unlocks)
    return openWindow({
      kind: 'apply',
      id: crypto.randomUUID(),
      account,
      filter: found.filter,
      effects: review.effects,
      warnings: [
        ...review.warnings,
        ...(review.unlocked.length > 0
          ? [
              `On the mail already there it does what it does to new mail: ${review.unlocked.join(', ')}, all at once. ` +
                'Whether Proton sends an answer or a refusal for mail that arrived long ago is not known here.',
            ]
          : []),
      ],
      createdAt: Date.now(),
    })
  }

  const movesName = (names: string[]): string =>
    `the order: moving ${names
      .slice(0, 3)
      .map((name) => JSON.stringify(name))
      .join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`

  async function handle(request: BrowserRequest): Promise<BrowserResponse> {
    switch (request.kind) {
      case 'status':
        return {
          ok: true,
          kind: 'status',
          extensionVersion: browser.runtime.getManifest().version,
          protonTabs: (await protonTabs()).length,
        }
      case 'list_filters': {
        const tab = await accountTab(request.account)
        if (!tab.ok) return tab
        const list = await sortedFilters(tab.id)
        if (!list.ok) return list
        const queue = (await waitingQueue()).filter((entry) => entry.account === request.account)
        return { ok: true, kind: 'list_filters', filters: list.filters, queue: view(queue), recent: await recentChanges(request.account) }
      }
      case 'propose_filter': {
        const { account, proposal, applyAllowed } = request
        const name = proposal.name.trim()
        const unlocks = await unlocked()
        const refused = refusal(name, proposal.sieve, unlocks)
        if (refused) return refused
        const tab = await accountTab(account)
        if (!tab.ok) return tab
        let current: ProtonFilter | undefined
        if (proposal.replaces) {
          const found = await currentFilter(tab.id, proposal.replaces)
          if (!found.ok) return found
          const guarded = protectedFilter(found.filter, unlocks)
          if (guarded) return guarded
          current = found.filter
        }
        const allowed = await switches()
        const confirm = request.confirm || !allowed.save
        const wantsApply = proposal.apply === true && applyAllowed

        if (!confirm) {
          // Applying without a window needs this extension's switch for it as
          // well; without it, the application gets a window of its own.
          const result = await submit(
            { action: 'save', name, sieve: proposal.sieve, ...(current ? { current } : {}), apply: wantsApply && allowed.apply },
            account,
            'without asking',
          )
          if (result.status === 'queued') return { ok: true, kind: 'propose_filter', outcome: 'queued' }
          if (result.status === 'failed') return failure('proton-error', result.message)
          let apply: 'done' | 'queued' | 'failed' | 'shown' | undefined = result.apply
          if (wantsApply && !allowed.apply && result.filterId) {
            apply = (await askToApply(tab.id, account, result.filterId)) ? 'failed' : 'shown'
          }
          return {
            ok: true,
            kind: 'propose_filter',
            outcome: result.outcome === 'replaced' ? 'replaced' : 'added',
            ...(result.filterId ? { filterId: result.filterId } : {}),
            ...(apply ? { apply } : {}),
          }
        }

        // Proton reads it before the user does, so the window never offers
        // a script Proton would refuse.
        const check = await inTab<string[]>(tab.id, { op: 'check', sieve: proposal.sieve })
        if (!check.ok) return asFailure(check)
        if (check.value.length > 0) return failure('proton-error', `Proton's check found: ${check.value.join('; ')}`)

        const review = reviewSieve(proposal.sieve, unlocks)
        const opened = await openWindow({
          kind: 'save',
          id: crypto.randomUUID(),
          account,
          name,
          sieve: proposal.sieve,
          ...(current ? { current } : {}),
          apply: wantsApply,
          applyAllowed,
          effects: review.effects,
          warnings: review.warnings,
          createdAt: Date.now(),
        })
        return opened ?? { ok: true, kind: 'propose_filter', outcome: 'shown' }
      }
      case 'apply_filter': {
        const { account, filterId } = request
        const tab = await accountTab(account)
        if (!tab.ok) return tab
        const found = await currentFilter(tab.id, filterId)
        if (!found.ok) return found
        // A filter that discards would delete the existing mail it matches,
        // so only one that passes the rules of a proposal is applied.
        const refused = scriptRefusal(found.filter.sieve, await unlocked())
        if (refused) return refused
        const confirm = request.confirm || !(await switches()).apply
        if (!confirm) {
          const result = await submit(applyWork(found.filter.name, found.filter.id, found.filter.sieve), account, 'without asking')
          if (result.status === 'queued') return { ok: true, kind: 'apply_filter', outcome: 'queued' }
          if (result.status === 'failed') return failure('proton-error', result.message)
          return { ok: true, kind: 'apply_filter', outcome: 'applied' }
        }
        const opened = await askToApply(tab.id, account, found.filter.id)
        return opened ?? { ok: true, kind: 'apply_filter', outcome: 'shown' }
      }
      case 'delete_filter': {
        const { account, filterId } = request
        const tab = await accountTab(account)
        if (!tab.ok) return tab
        const found = await currentFilter(tab.id, filterId)
        if (!found.ok) return found
        const filter = found.filter
        const confirm = request.confirm || !(await switches()).delete
        if (!confirm) {
          const result = await submit({ action: 'delete', name: filter.name, filterId, sieve: filter.sieve }, account, 'without asking')
          if (result.status === 'queued') return { ok: true, kind: 'delete_filter', outcome: 'queued' }
          if (result.status === 'failed') return failure('proton-error', result.message)
          return { ok: true, kind: 'delete_filter', outcome: 'deleted' }
        }
        // Everything it does, allowed or not, so the person sees what goes.
        const review = reviewSieve(filter.sieve, DESCRIBE_ALL)
        const opened = await openWindow({
          kind: 'delete',
          id: crypto.randomUUID(),
          account,
          filter,
          effects: review.effects,
          warnings: [],
          createdAt: Date.now(),
        })
        return opened ?? { ok: true, kind: 'delete_filter', outcome: 'shown' }
      }
      case 'set_filter_status': {
        const { account, filterId, enabled } = request
        const tab = await accountTab(account)
        if (!tab.ok) return tab
        const found = await currentFilter(tab.id, filterId)
        if (!found.ok) return found
        const filter = found.filter
        if (filter.enabled === enabled) return { ok: true, kind: 'set_filter_status', outcome: 'switched' }
        const unlocks = await unlocked()
        // Switching a filter on sets up what it does.
        if (enabled) {
          const refused = scriptRefusal(filter.sieve, unlocks)
          if (refused) return refused
        }
        const confirm = request.confirm || !(await switches()).status
        if (!confirm) {
          const result = await submit(
            { action: 'status', name: filter.name, filterId, enabled, sieve: filter.sieve },
            account,
            'without asking',
          )
          if (result.status === 'queued') return { ok: true, kind: 'set_filter_status', outcome: 'queued' }
          if (result.status === 'failed') return failure('proton-error', result.message)
          return { ok: true, kind: 'set_filter_status', outcome: 'switched' }
        }
        const review = reviewSieve(filter.sieve, enabled ? unlocks : DESCRIBE_ALL)
        const opened = await openWindow({
          kind: 'status',
          id: crypto.randomUUID(),
          account,
          filter,
          enabled,
          effects: review.effects,
          warnings: enabled ? review.warnings : [],
          createdAt: Date.now(),
        })
        return opened ?? { ok: true, kind: 'set_filter_status', outcome: 'shown' }
      }
      case 'reorder_filters': {
        const { account, moves } = request
        const tab = await accountTab(account)
        if (!tab.ok) return tab
        const list = await sortedFilters(tab.id)
        if (!list.ok) return list
        const before = list.filters.map((filter) => filter.id)
        let after: string[]
        try {
          after = applyMoves(before, moves)
        } catch (error) {
          if (error instanceof OrderError) return failure('refused', error.message)
          throw error
        }
        if (sameOrder(before, after)) return failure('refused', 'The order would stay as it is.')
        const names = Object.fromEntries(list.filters.map((filter) => [filter.id, filter.name]))
        const sieves = new Map(list.filters.map((filter) => [filter.id, filter.sieve]))
        const moved = movedFilters(before, after, moves.map((move) => move.id))
        const nameOf = (id: string): string => names[id] || '(no name)'
        const warnings = orderWarnings(moved, (id) => reviewSieve(sieves.get(id) ?? '').refused, nameOf)
        const name = movesName(moved.map((move) => nameOf(move.id)))
        const confirm = request.confirm || !(await switches()).reorder
        if (!confirm) {
          const result = await submit({ action: 'reorder', name, before, after }, account, 'without asking')
          if (result.status === 'queued') return { ok: true, kind: 'reorder_filters', outcome: 'queued' }
          if (result.status === 'failed') return failure('proton-error', result.message)
          return { ok: true, kind: 'reorder_filters', outcome: 'reordered' }
        }
        const opened = await openWindow({
          kind: 'reorder',
          id: crypto.randomUUID(),
          account,
          before,
          after,
          names,
          moved,
          effects: [],
          warnings,
          createdAt: Date.now(),
        })
        return opened ?? { ok: true, kind: 'reorder_filters', outcome: 'shown' }
      }
    }
  }

  /**
   * The proposal, for the tab it was opened in and for no other. The window
   * may ask before Chrome has said which tab it is, so that is waited for.
   */
  async function proposal(id: string, tab: number | undefined): Promise<PendingProposal | undefined> {
    const key = `proposal:${id}`
    const pendingTab = opening.get(id)
    if (pendingTab) await pendingTab.catch(() => undefined)
    for (let attempt = 0; attempt < 20; attempt++) {
      const stored = (await browser.storage.session.get(key))[key] as PendingProposal | undefined
      if (!stored) return undefined
      if (stored.tabId !== undefined) return checked(stored, tab, key)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return undefined
  }

  async function checked(stored: PendingProposal, tab: number | undefined, key: string): Promise<PendingProposal | undefined> {
    if (tab === undefined || stored.tabId !== tab) return undefined
    if (Date.now() - stored.createdAt > PROPOSAL_LIFETIME_MS) {
      await browser.storage.session.remove(key)
      return undefined
    }
    return stored
  }

  /** Takes a proposal out in one step, so a second click finds nothing. Found in the review of 06.11.2026. */
  let proposalLock: Promise<unknown> = Promise.resolve()
  function takeProposal(id: string, tab: number | undefined): Promise<PendingProposal | undefined> {
    const next = proposalLock.then(async () => {
      const pending = await proposal(id, tab)
      if (pending) await browser.storage.session.remove(`proposal:${id}`)
      return pending
    })
    proposalLock = next.catch(() => undefined)
    return next
  }

  /** The user's answer from the confirmation window. Only one answer per proposal counts. */
  async function decide(
    id: string,
    accept: boolean,
    applyChoice: boolean | undefined,
    senderTab: number | undefined,
  ): Promise<{ ok: boolean; message: string }> {
    const pending = await takeProposal(id, senderTab)
    if (!pending) return { ok: false, message: 'This proposal is no longer open. Nothing was changed.' }
    const name =
      pending.kind === 'save'
        ? pending.name
        : pending.kind === 'reorder'
          ? movesName(pending.moved.map((move) => pending.names[move.id] || '(no name)'))
          : pending.filter.name
    if (!accept) {
      await logChange({ at: Date.now(), name, outcome: 'rejected', how: 'confirmed', account: pending.account })
      return { ok: true, message: pending.kind === 'save' ? 'Rejected. Nothing was saved.' : 'Cancelled. Nothing was changed.' }
    }

    let work: QueuedWork
    switch (pending.kind) {
      case 'save':
        work = {
          action: 'save',
          name: pending.name,
          sieve: pending.sieve,
          ...(pending.current ? { current: pending.current } : {}),
          // The box in the window decides, whatever the assistant suggested,
          // and it is only there when applying is allowed at all.
          apply: pending.applyAllowed && (applyChoice ?? pending.apply),
        }
        break
      case 'apply':
        work = applyWork(pending.filter.name, pending.filter.id, pending.filter.sieve)
        break
      case 'reorder':
        work = { action: 'reorder', name, before: pending.before, after: pending.after }
        break
      case 'delete':
        work = { action: 'delete', name, filterId: pending.filter.id, sieve: pending.filter.sieve }
        break
      case 'status':
        work = { action: 'status', name, filterId: pending.filter.id, enabled: pending.enabled, sieve: pending.filter.sieve }
        break
    }
    const result = await submit(work, pending.account, 'confirmed')
    if (result.status === 'queued') return { ok: true, message: QUEUED_TEXT }
    if (result.status === 'failed') return { ok: false, message: `Nothing was changed: ${result.message}` }
    switch (result.outcome) {
      case 'applied':
        return { ok: true, message: APPLIED_TEXT }
      case 'reordered':
        return { ok: true, message: 'Saved. The filters run in the new order from now on.' }
      case 'deleted':
        return { ok: true, message: 'Deleted. Proton keeps nothing of the filter.' }
      case 'enabled':
        return { ok: true, message: 'Switched on. The filter runs on new mail from now on.' }
      case 'disabled':
        return { ok: true, message: 'Switched off. The filter keeps its script and runs on no message.' }
      default: {
        const done = result.outcome === 'replaced' ? 'Saved. The filter is replaced.' : 'Saved. The filter is added and on.'
        if (result.apply === 'done') {
          return { ok: true, message: `${done} It is also being applied to the mail already there, in the background. On a large mailbox that can take hours.` }
        }
        if (result.apply === 'queued') return { ok: true, message: `${done} Applying it waits: ${QUEUED_TEXT}` }
        if (result.apply === 'failed') return { ok: false, message: `${done} Applying it to the mail already there failed; the popup shows why.` }
        return { ok: true, message: done }
      }
    }
  }

  browser.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    // Only pages of this extension: the confirmation window and the popup.
    // The script in the Proton page has this extension's id as well, but its
    // address is the Proton page, so it does not pass.
    if (sender.id !== browser.runtime.id) return undefined
    const url = sender.url ?? ''
    const fromConfirm = url.startsWith(browser.runtime.getURL('/confirm.html'))
    const fromPopup = url.startsWith(browser.runtime.getURL('/popup.html'))
    const message = parsePageMessage(raw)
    if (!message || (!fromConfirm && !fromPopup)) return undefined

    const answer = async (): Promise<unknown> => {
      switch (message.type) {
        case 'proposal':
          return fromConfirm ? proposal(message.id, sender.tab?.id) : undefined
        case 'decide':
          return fromConfirm ? decide(message.id, message.accept, message.apply, sender.tab?.id) : undefined
        case 'cancel':
          return fromPopup ? cancel(message.id) : undefined
        case 'switches':
          if (!fromPopup) return undefined
          await browser.storage.local.set({ switches: message.switches })
          return { ok: true }
        case 'unlocks':
          if (!fromPopup) return undefined
          await browser.storage.local.set({ unlocks: message.actions })
          return { ok: true }
        case 'reconnect':
          connect()
          void runQueue()
          return { ok: true }
        case 'status': {
          const session = await browser.storage.session.get('host')
          const local = await browser.storage.local.get('changes')
          const queue = await waitingQueue()
          return {
            host: session.host ?? { state: port ? 'starting' : 'disconnected', at: Date.now() },
            tabs: (await protonTabs()).length,
            queue: queue.map((entry) => ({ id: entry.id, ...view([entry])[0], lastError: entry.lastError })),
            changes: Array.isArray(local.changes) ? local.changes : [],
            switches: await switches(),
            unlocks: [...(await unlocked())],
          }
        }
      }
    }
    void answer().then(sendResponse, (error: unknown) => sendResponse({ ok: false, message: String(error) }))
    return true
  })

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void runQueue()
  })
  // These two make Chrome start this background when Chrome starts and when
  // the extension is installed or reloaded, so the connector is there before
  // the server asks.
  browser.runtime.onStartup.addListener(() => connect())
  browser.runtime.onInstalled.addListener(() => connect())
  connect()
  // What waits from earlier in this run goes on, in case its alarm was lost.
  // runQueue waits for settled, so nothing from before a restart runs.
  void runQueue()
})
