/**
 * Searching messages.
 *
 * Measured against a mailbox of 26816 messages: a
 * full-text search takes between 1.7 and 3.3 seconds, a search that finds
 * nothing takes just as long. The Bridge walks its local database linearly,
 * there is no index, so the time grows with the size of the mailbox.
 *
 * That is slow but usable, which is why this server builds no index of its own.
 * An index would mean mirroring the decrypted mailbox to disk, undoing locally
 * what Proton does for you.
 *
 * Metadata queries are cheap by comparison: unread came back in 3 ms, a size
 * filter in 437 ms.
 */

import type { SearchObject } from 'imapflow'
import type { Connection } from '../bridge/connection.js'
import { BridgeError } from '../bridge/errors.js'
import {
  fetchDates,
  fetchHeaders,
  orderNewestFirst,
  MAX_LIST_LIMIT,
  type MessageHeader,
  type OrderingCost,
} from './messages.js'

export interface SearchCriteria {
  /** Free text, searched in the body and in headers. The expensive part. */
  text?: string
  /** Substring of the subject. */
  subject?: string
  /** Substring of the sender address or display name. */
  from?: string
  /** Substring of a recipient address. */
  to?: string
  /**
   * Only messages the sender dated on or after this. Compared against the Date
   * header, not against when the server received the message, so it matches the
   * date every result shows.
   */
  since?: Date
  /** Only messages the sender dated before this. Same comparison as `since`. */
  before?: Date
  /**
   * Passed straight through as IMAP `SEEN`: true finds read messages, false
   * finds unread ones. Leave it out to search both.
   */
  seen?: boolean
  /**
   * Passed straight through as IMAP `FLAGGED`: true finds starred messages,
   * false finds unstarred ones. Leave it out to search both.
   */
  flagged?: boolean
  /** Minimum size in bytes. */
  largerThan?: number
}

export interface SearchResult {
  path: string
  /** Number of matches, independent of paging. */
  total: number
  offset: number
  headers: MessageHeader[]
  /** How long the search itself took, so a caller can judge the cost. */
  elapsedMs: number
  /** What putting the hits in order cost, separate from the search. */
  ordering: OrderingCost
  /** True when the search included a full-text term, which is the slow case. */
  fullText: boolean
}

/** Translates the criteria into what imapflow expects. */
export function buildQuery(criteria: SearchCriteria): SearchObject {
  // Typed as what it is rather than built loosely and cast at the end. The cast
  // was how `since` survived: a field name imapflow does not know is silently
  // an ignored criterion, so the search returns too much and nothing complains.
  // With the real type a wrong name is a compile error.
  const query: SearchObject = {}

  if (criteria.text) query.text = criteria.text
  if (criteria.subject) query.header = { subject: criteria.subject }
  if (criteria.from) query.from = criteria.from
  if (criteria.to) query.to = criteria.to
  // sentSince and sentBefore, not since and before. Those two are IMAP SINCE
  // and BEFORE, which compare INTERNALDATE, the moment the server received the
  // message. Everything this server shows and sorts by comes from the envelope,
  // so from the sender's Date: header - the comment above fetchDates in
  // messages.ts explains why, namely that INTERNALDATE can be rewritten when a
  // message is copied between mailboxes. Filtering on the one and displaying
  // the other returned messages whose printed date sat outside the range asked
  // for, and dropped ones inside it.
  if (criteria.since) query.sentSince = criteria.since
  if (criteria.before) query.sentBefore = criteria.before
  if (criteria.seen !== undefined) query.seen = criteria.seen
  if (criteria.flagged !== undefined) query.flagged = criteria.flagged
  if (criteria.largerThan !== undefined) query.larger = criteria.largerThan

  // An empty query would match everything, which is list_messages rather than
  // a search. Saying so is better than silently returning the whole mailbox.
  if (Object.keys(query).length === 0) {
    throw new BridgeError(
      'A search needs at least one criterion. Pass text, subject, from, to, since, before, ' +
        'unread, starred or largerThan. To see everything in a mailbox use list_messages instead.',
    )
  }

  return query
}

/** Whether a query contains the expensive full-text part. */
export function isFullText(criteria: SearchCriteria): boolean {
  return Boolean(criteria.text)
}

export interface SearchOptions extends SearchCriteria {
  limit?: number
  offset?: number
}

/**
 * Searches one mailbox and returns headers, never bodies.
 *
 * "All Mail" is the mailbox to search when the caller does not care where a
 * message lives, since it holds everything including trash.
 */
export async function searchMessages(
  connection: Connection,
  path: string,
  options: SearchOptions,
): Promise<SearchResult> {
  const { limit: rawLimit, offset: rawOffset, ...criteria } = options
  const limit = Math.min(Math.max(rawLimit ?? 25, 1), MAX_LIST_LIMIT)
  const offset = Math.max(rawOffset ?? 0, 0)

  // Built before opening the mailbox, so an empty query fails fast.
  const query = buildQuery(criteria)

  const started = process.hrtime.bigint()

  const uids = await connection.withMailbox(path, async (client, status): Promise<number[]> => {
    if (status.messages === 0) return []
    const hits = await client.search(query, { uid: true })
    // imapflow answers with false rather than an empty array when a search
    // yields nothing, and `?? []` would let that through.
    return Array.isArray(hits) ? hits : []
  })

  const elapsedMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6)

  if (uids.length === 0) {
    return {
      path,
      total: 0,
      offset,
      headers: [],
      elapsedMs,
      ordering: { messages: 0, elapsedMs: 0 },
      fullText: isFullText(criteria),
    }
  }

  // Ordering reads the date of every hit, because a page can only be cut out of
  // a list that is already in order. Only the dates: the full header fetch below
  // still covers one page, which is what keeps this affordable. A common word
  // matched 6803 messages in the measured mailbox.
  const orderStarted = process.hrtime.bigint()
  const ordered = await connection.withMailbox(path, async (client) =>
    orderNewestFirst(await fetchDates(client, uids)),
  )
  const ordering: OrderingCost = {
    messages: uids.length,
    elapsedMs: Math.round(Number(process.hrtime.bigint() - orderStarted) / 1e6),
  }

  const page = ordered.slice(offset, offset + limit)

  // Same helper the listing uses, so both produce identical entries.
  const headers = await connection.withMailbox(path, (client) => fetchHeaders(client, page))

  return {
    path,
    total: ordered.length,
    offset,
    headers,
    elapsedMs,
    ordering,
    fullText: isFullText(criteria),
  }
}
