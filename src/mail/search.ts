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
 *
 * Text is the exception to "the Bridge searches". Measured on 2026-11-02 and
 * read in the source of gluon, its IMAP library: SUBJECT, FROM and TO compare
 * against the header as it is stored, and a header with one letter outside
 * ASCII is stored encoded, "Mit Anhang" as "Mit_Anhang", or in base64, where no
 * word is legible at all. Up to 0.4.11 a subject search for "Mit Anhang" found
 * nothing, and the answer read like a search without matches. So the Bridge
 * now filters by everything but those three, and this server compares them
 * against the envelope, which imapflow decodes. Full text stays with the
 * Bridge, which compares the raw bytes; a word outside ASCII is also asked for
 * in the form a quoted-printable part carries it, and a part sent as base64
 * stays out of reach, which every answer says.
 */

import type { SearchObject } from 'imapflow'
import type { Connection } from '../bridge/connection.js'
import { BridgeError } from '../bridge/errors.js'
import { searchUids } from './uid-search.js'
import {
  fetchEnvelopes,
  fetchHeaders,
  orderNewestFirst,
  MAX_LIST_LIMIT,
  withTrashMarks,
  type EnvelopeEntry,
  type MessageHeader,
  type OrderingCost,
} from './messages.js'

/**
 * How many envelopes a search compares itself, at most.
 *
 * Without other criteria a subject search reads the envelope of every message
 * in the mailbox. Reading one per hit is what the ordering has always cost, and
 * a common word matched 6803 messages in a mailbox of 26816, but there has to
 * be an end. Past it, the most recently added messages are compared and the
 * answer says so; there is no silent cut.
 */
export const MAX_COMPARED = 20_000

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
  /** True when a full-text word was also asked for in its quoted-printable form. */
  encodedForms: boolean
  /** Set when not every candidate was compared, see MAX_COMPARED. */
  compared?: { compared: number; of: number }
}

/** What this server compares itself, against the decoded envelope. */
export interface LocalMatch {
  subject?: string
  from?: string
  to?: string
}

/** What the Bridge is asked, and what is left to compare here. */
export interface PlannedSearch {
  query: SearchObject
  local: LocalMatch
}

/** Whether a byte sequence has anything outside ASCII. */
const outsideAscii = (text: string): boolean => /[^\x00-\x7f]/.test(text)

/**
 * A word as a quoted-printable part carries it: every byte of its UTF-8 form
 * outside printable ASCII, and the equals sign, as =XX.
 */
export function quotedPrintable(text: string): string {
  let out = ''
  for (const byte of Buffer.from(text.normalize('NFC'), 'utf8')) {
    out +=
      byte > 0x7e || byte < 0x20 || byte === 0x3d
        ? `=${byte.toString(16).toUpperCase().padStart(2, '0')}`
        : String.fromCharCode(byte)
  }
  return out
}

/**
 * The forms a full-text word is asked for in.
 *
 * The Bridge compares the raw bytes of a message, lower cased, so a word with a
 * letter outside ASCII is found only where a part carries it unencoded. Most
 * text with umlauts travels as quoted-printable, where a u with umlaut is the
 * six characters "=C3=BC" and an a with umlaut "=C3=A4". Lower casing does not reach into
 * that encoding, so the usual spellings of a word are each asked for: as given,
 * in lower case, and capitalised. Forms that differ only in the case of ASCII
 * letters are asked once, since the Bridge lower cases both sides. A word
 * broken across a line by the encoding is still missed, and so is anything in
 * base64.
 */
export function textForms(term: string): string[] {
  if (!outsideAscii(term)) return [term]
  const lower = term.toLowerCase()
  const capitalised = lower.charAt(0).toUpperCase() + lower.slice(1)
  const forms = new Map<string, string>([[term.toLowerCase(), term]])
  for (const spelling of [term, lower, capitalised]) {
    const form = quotedPrintable(spelling)
    if (!forms.has(form.toLowerCase())) forms.set(form.toLowerCase(), form)
  }
  return [...forms.values()]
}

/** Folded for comparison: one Unicode form, lower case. */
const fold = (text: string): string => text.normalize('NFC').toLowerCase()

/** How an address reads in a header, which is what FROM and TO used to match. */
const shown = (a: { name?: string; address: string }): string => (a.name ? `${a.name} <${a.address}>` : a.address)

/** Whether a message passes what this server compares itself. */
export function matchesLocally(entry: EnvelopeEntry, local: LocalMatch): boolean {
  if (local.subject !== undefined && !fold(entry.subject).includes(fold(local.subject))) return false
  if (local.from !== undefined && !entry.from.some((a) => fold(shown(a)).includes(fold(local.from ?? '')))) {
    return false
  }
  if (local.to !== undefined && !entry.to.some((a) => fold(shown(a)).includes(fold(local.to ?? '')))) {
    return false
  }
  return true
}

/**
 * Splits the criteria into what the Bridge is asked and what this server
 * compares itself.
 */
export function planSearch(criteria: SearchCriteria): PlannedSearch {
  // Typed as what it is rather than built loosely and cast at the end. The cast
  // was how `since` survived: a field name imapflow does not know is silently
  // an ignored criterion, so the search returns too much and nothing complains.
  // With the real type a wrong name is a compile error.
  const query: SearchObject = {}
  const local: LocalMatch = {}

  if (criteria.text) {
    const forms = textForms(criteria.text)
    if (forms.length === 1) query.text = criteria.text
    else query.or = forms.map((form) => ({ text: form }))
  }
  // Compared here rather than by the Bridge, see the top of this file.
  if (criteria.subject) local.subject = criteria.subject
  if (criteria.from) local.from = criteria.from
  if (criteria.to) local.to = criteria.to
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
  const comparedHere = Object.keys(local).length > 0
  if (Object.keys(query).length === 0 && !comparedHere) {
    throw new BridgeError(
      'A search needs at least one criterion. Pass text, subject, from, to, since, before, ' +
        'unread, starred or largerThan. To see everything in a mailbox use list_messages instead.',
    )
  }
  // Only the comparison here narrows it down, so the Bridge hands over every
  // message and this server reads their envelopes.
  if (Object.keys(query).length === 0) query.all = true

  return { query, local }
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
  const { query, local } = planSearch(criteria)
  const comparedHere = Object.keys(local).length > 0
  const fullText = isFullText(criteria)
  const encodedForms = Boolean(criteria.text) && textForms(criteria.text ?? '').length > 1

  const started = process.hrtime.bigint()

  const uids = await connection.withMailbox(path, async (client, status): Promise<number[]> => {
    if (status.messages === 0) return []
    return searchUids(client, query, `messages in "${path}"`)
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
      fullText,
      encodedForms,
    }
  }

  // Past the limit the most recently added are compared: the highest uids. The
  // answer says so, see MAX_COMPARED.
  let candidates = uids
  let compared: SearchResult['compared']
  if (comparedHere && uids.length > MAX_COMPARED) {
    candidates = [...uids].sort((a, b) => b - a).slice(0, MAX_COMPARED)
    compared = { compared: MAX_COMPARED, of: uids.length }
  }

  // Ordering reads the envelope of every candidate, because a page can only be
  // cut out of a list that is already in order. The same read carries the
  // subject, sender and recipients compared here. Only the envelopes: the full
  // header fetch below still covers one page, which is what keeps this
  // affordable. A common word matched 6803 messages in the measured mailbox.
  const orderStarted = process.hrtime.bigint()
  const ordered = await connection.withMailbox(path, async (client) => {
    const entries = await fetchEnvelopes(client, candidates)
    return orderNewestFirst(comparedHere ? entries.filter((entry) => matchesLocally(entry, local)) : entries)
  })
  const ordering: OrderingCost = {
    messages: candidates.length,
    elapsedMs: Math.round(Number(process.hrtime.bigint() - orderStarted) / 1e6),
  }

  const page = ordered.slice(offset, offset + limit)

  // Same helper the listing uses, so both produce identical entries.
  const headers = await connection.withMailbox(path, (client) => fetchHeaders(client, page))

  return withTrashMarks(connection, {
    path,
    total: ordered.length,
    offset,
    headers,
    elapsedMs,
    ordering,
    fullText,
    encodedForms,
    ...(compared ? { compared } : {}),
  })
}
