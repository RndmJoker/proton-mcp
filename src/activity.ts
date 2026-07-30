/**
 * What the server has been asked to do lately.
 *
 * The status page needs to answer two questions that nothing else can: is
 * something running right now, and what happened before. Without this a user
 * watching a slow full-text search has no way to tell it apart from a hung
 * server.
 *
 * ## What is deliberately not recorded
 *
 * **No arguments.** Not the mailbox, not the message id, and above all not the
 * search text. A search term is very nearly mail content, a message id names one
 * specific message, and a mailbox path can say `Folders/Banking/Revolut`. The
 * interface is for configuration and state, not a window into the mailbox, and a
 * record of what was searched for would quietly turn it into one.
 *
 * **Nothing on disk.** This lives in memory and dies with the process. A log
 * file would be a record of someone's mail habits sitting outside Proton's
 * encryption, which is exactly what this project refuses to create.
 *
 * The tool name, the time and whether it worked are enough for the job.
 */

/** How many finished calls are kept. Older ones fall off the end. */
export const HISTORY_LIMIT = 50

export interface RunningCall {
  /** Distinguishes concurrent calls to the same tool. */
  id: number
  tool: string
  startedAt: number
}

export interface FinishedCall {
  tool: string
  startedAt: number
  /** How long it took, in milliseconds. */
  durationMs: number
  outcome: 'ok' | 'failed'
}

let nextId = 1
const running = new Map<number, RunningCall>()
/** Newest first, so the page does not have to reverse it. */
let history: FinishedCall[] = []
/** Set the first time a tool call arrives, which is when a client showed up. */
let firstCallAt: number | undefined

/** Records the start of a call and returns its handle. */
export function begin(tool: string, now = Date.now()): number {
  const id = nextId++
  running.set(id, { id, tool, startedAt: now })
  firstCallAt ??= now
  return id
}

/** Records the end of a call. Unknown handles are ignored rather than thrown at. */
export function finish(id: number, outcome: FinishedCall['outcome'], now = Date.now()): void {
  const call = running.get(id)
  if (!call) return
  running.delete(id)
  history.unshift({
    tool: call.tool,
    startedAt: call.startedAt,
    durationMs: now - call.startedAt,
    outcome,
  })
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT
}

/** The calls in progress, oldest first: the one to worry about is at the top. */
export function inProgress(): RunningCall[] {
  return [...running.values()].sort((a, b) => a.startedAt - b.startedAt)
}

/** The finished calls, newest first. */
export function recent(): FinishedCall[] {
  return [...history]
}

/** When the first tool call arrived, or undefined if none ever did. */
export function firstCall(): number | undefined {
  return firstCallAt
}

/** Resets everything. For tests only. */
export function _reset(): void {
  nextId = 1
  running.clear()
  history = []
  firstCallAt = undefined
}
