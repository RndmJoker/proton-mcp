/**
 * Bookkeeping for tool calls that are still running.
 *
 * Background: a stdio server learns that its client is gone by its input
 * stream ending. If it exits right away it cuts off calls that are still in
 * progress and their answer is lost. If it waits forever it hangs whenever a
 * call never returns.
 *
 * Hence: keep count, and wait for a bounded grace period on shutdown.
 */

import * as activity from './activity.js'

let inFlight = 0
let idleResolvers: Array<() => void> = []

/** How many calls are currently running. For tests and diagnostics only. */
export function inFlightCount(): number {
  return inFlight
}

/**
 * Wraps a tool call so that shutdown waits for it.
 *
 * The counter is also released on failure. Otherwise a single failed call
 * would keep the server from ever shutting down.
 *
 * Also the one place every tool call passes through, so it is where the status
 * page gets its record of what is running and what happened. Only the tool name
 * is passed on, never the arguments: see activity.ts for why.
 */
export async function track<T>(fn: () => Promise<T>, tool?: string): Promise<T> {
  inFlight++
  const record = tool === undefined ? undefined : activity.begin(tool)
  let failed = false
  try {
    return await fn()
  } catch (error) {
    failed = true
    throw error
  } finally {
    if (record !== undefined) activity.finish(record, failed ? 'failed' : 'ok')
    inFlight--
    if (inFlight === 0) {
      const waiting = idleResolvers
      idleResolvers = []
      for (const resolve of waiting) resolve()
    }
  }
}

/**
 * Waits until no call is running any more, but at most `maxMs`.
 *
 * Returns true when things really went quiet and false when the deadline
 * passed. The return value lets the caller record that it gave up instead of
 * hiding it.
 */
export function waitForIdle(maxMs = 5000): Promise<boolean> {
  if (inFlight === 0) return Promise.resolve(true)

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      idleResolvers = idleResolvers.filter((f) => f !== onIdle)
      resolve(false)
    }, maxMs)

    const onIdle = () => {
      clearTimeout(timer)
      resolve(true)
    }
    idleResolvers.push(onIdle)
  })
}

/** Resets the state. For tests only. */
export function _reset(): void {
  inFlight = 0
  idleResolvers = []
}
