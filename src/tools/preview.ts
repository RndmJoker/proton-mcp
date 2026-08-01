/**
 * The message a confirmation is about, held while the question is open.
 *
 * The confirmation itself carries no message content any more. It names the
 * sender, the recipients and the subject, and points at a page in the local
 * interface where the message can be read as the recipient will see it. That
 * page needs the composed message, and this is where it waits.
 *
 * ## Why it has to be held at all
 *
 * The sending path builds the draft twice: once to ask, once to send. Nothing
 * is kept between the two rounds except a sealed digest, which is what makes
 * the confirmation impossible to forge. That design is untouched. A preview,
 * though, has to be readable *between* the rounds, from a different process
 * boundary entirely, so the message has to sit somewhere for as long as the
 * question is unanswered.
 *
 * ## The rules that follow from what this holds
 *
 * This is decrypted mail. It is the one thing the project has always refused to
 * put on disk, because doing so would undo Proton's encryption locally. So:
 *
 * - **Memory only.** Nothing here is ever written anywhere.
 * - **Dropped as soon as the answer arrives**, whichever way it went.
 * - **Dropped when it goes stale**, because a client that never answers must
 *   not leave a message readable for the life of the process.
 * - **Bounded**, so a caller that asks a thousand times and answers none of
 *   them cannot fill memory.
 *
 * Addressed by the digest that already binds the confirmation. That is not a
 * shortcut: it means a preview can only be found by somebody who knows exactly
 * which message was composed, and it makes the preview and the thing being
 * confirmed the same object by construction.
 */

import type { Draft } from '../mail/compose.js'

/** How long an unanswered question keeps its preview readable. */
export const PREVIEW_TTL_MS = 15 * 60 * 1000

/**
 * How many may wait at once.
 *
 * Low on purpose. A person answers one question at a time; anything beyond a
 * handful means something is asking without waiting for answers, and the
 * oldest are the ones nobody is coming back for.
 */
export const MAX_PREVIEWS = 8

interface Held {
  draft: Draft
  /** Which tool asked, shown on the page so it says what would happen. */
  tool: string
  at: number
}

const held = new Map<string, Held>()

/**
 * The clock, replaceable for tests.
 *
 * A test for expiry that waits fifteen minutes is a test nobody runs.
 */
let now: () => number = () => Date.now()

/** For tests only. */
export function _setClock(clock: () => number): void {
  now = clock
}

/** For tests only. */
export function _reset(): void {
  held.clear()
  now = () => Date.now()
}

function dropStale(): void {
  const cutoff = now() - PREVIEW_TTL_MS
  for (const [digest, entry] of held) {
    if (entry.at < cutoff) held.delete(digest)
  }
}

/** Holds a message for as long as its question is open. */
export function holdForPreview(digest: string, draft: Draft, tool: string): void {
  dropStale()
  // Oldest first, since a Map keeps insertion order. The one nobody answered
  // longest ago is the one least likely to be answered now.
  while (held.size >= MAX_PREVIEWS) {
    const oldest = held.keys().next()
    if (oldest.done) break
    held.delete(oldest.value)
  }
  held.set(digest, { draft, tool, at: now() })
}

/** The message behind a digest, if the question is still open. */
export function previewOf(digest: string): { draft: Draft; tool: string } | undefined {
  dropStale()
  const entry = held.get(digest)
  if (!entry) return undefined
  return { draft: entry.draft, tool: entry.tool }
}

/**
 * Forgets a message.
 *
 * Called once the answer is in, whichever way it went. A declined send has no
 * more business being readable than a completed one.
 */
export function releasePreview(digest: string): void {
  held.delete(digest)
}

/** How many are waiting. For the interface, which says so rather than guessing. */
export function pendingCount(): number {
  dropStale()
  return held.size
}
