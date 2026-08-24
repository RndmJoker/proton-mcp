/**
 * Listing and reading messages.
 *
 * The guiding constraint is the context window, not the network. A real
 * mailbox has a median message size of roughly 16200 tokens raw, so twenty raw
 * messages exceed a full window. Listings therefore carry headers only, and
 * full text is fetched one message at a time.
 */

import type { ImapFlow } from 'imapflow'
import type { Connection } from '../bridge/connection.js'
import { BridgeError } from '../bridge/errors.js'
import { resolveMessageId, presentMessageId } from './ids.js'
import { parseMessage, type ParsedMessage, type Address } from '../mime/parse.js'

/** Upper bound for one listing. Deliberately low, callers can page. */
export const MAX_LIST_LIMIT = 100
/** Character budget for a single message body. Roughly 6000 tokens. */
export const DEFAULT_TEXT_BUDGET = 24_000

export interface MessageHeader {
  messageId: string
  subject: string
  from: Address[]
  to: Address[]
  date: Date | undefined
  /** Size of the raw message in bytes. Indicates what fetching it would cost. */
  size: number
  seen: boolean
  flagged: boolean
  answered: boolean
  draft: boolean
  /** Whether the message carries attachments other than Proton's own key. */
  hasAttachments: boolean
}

/**
 * What the ordering step cost.
 *
 * Reported rather than hidden, because it is the one part of a listing whose
 * price grows with the size of the mailbox. A caller that sees 2000 ms here
 * knows why the answer was slow, and so does anyone deciding whether this needs
 * a cache.
 */
export interface OrderingCost {
  /** How many message dates had to be read to establish the order. */
  messages: number
  elapsedMs: number
}

export interface ListResult {
  path: string
  /**
   * How many messages the query matched, independent of paging. With no filter
   * that is the whole mailbox; with `unreadOnly` it is the unread ones, not the
   * mailbox size.
   */
  total: number
  offset: number
  headers: MessageHeader[]
  ordering: OrderingCost
}

export function toAddresses(list: Array<{ name?: string; address?: string }> | undefined): Address[] {
  if (!list) return []
  const out: Address[] = []
  for (const entry of list) {
    if (!entry.address) continue
    const item: Address = { address: entry.address }
    if (entry.name) item.name = entry.name
    out.push(item)
  }
  return out
}

/**
 * Guesses from the body structure whether real attachments are present.
 *
 * Cheap, because it works off the structure the server already returns rather
 * than parsing the message. Proton's own public key is excluded, otherwise
 * every sent message would look like it had an attachment.
 */
export function detectAttachments(node: unknown): boolean {
  const n = node as {
    disposition?: string
    type?: string
    dispositionParameters?: { filename?: string }
    childNodes?: unknown[]
  }
  if (!n) return false

  if (n.disposition === 'attachment') {
    const filename = n.dispositionParameters?.filename ?? ''
    const isProtonKey =
      n.type === 'application/pgp-keys' && /^publickey - .+ - 0x[0-9a-f]+\.asc$/i.test(filename)
    if (!isProtonKey) return true
  }
  for (const child of n.childNodes ?? []) {
    if (detectAttachments(child)) return true
  }
  return false
}

/** A message reduced to what it takes to put it in order. */
export interface OrderEntry {
  uid: number
  date: Date | undefined
}

/**
 * Reads nothing but the date of each message.
 *
 * This is the cheapest fetch IMAP offers for the purpose: ENVELOPE and nothing
 * else. In particular no BODYSTRUCTURE, which is the expensive part of a full
 * header fetch because the server has to walk the MIME tree to produce it.
 *
 * It runs over the entire result set, not over one page, and that is the point:
 * an order can only be established from all of it. What it costs is reported
 * back to the caller rather than swallowed.
 *
 * The date is taken from the envelope, which is the `Date:` field the sender
 * wrote. INTERNALDATE would be cheaper still, but it is the time the server
 * received the message and a copy between mailboxes may set it afresh, which is
 * the very thing this ordering exists to survive.
 */
export async function fetchDates(client: ImapFlow, uids: number[]): Promise<OrderEntry[]> {
  if (uids.length === 0) return []

  const entries: OrderEntry[] = []
  for await (const msg of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
    entries.push({ uid: msg.uid, date: msg.envelope?.date })
  }
  return entries
}

/**
 * Puts messages newest first and returns their UIDs in that order.
 *
 * The UID breaks ties, and that is not cosmetic. Two messages can carry the
 * same `Date:` down to the second, and mail sent by a script routinely does.
 * Without a tiebreaker their relative order would be whatever the sort happened
 * to produce that time, which differs between calls, and paging would then be
 * free to show one of them on two pages and the other on none.
 *
 * Messages without a date sort last. They are rare and malformed, but they must
 * land somewhere definite rather than wherever undefined comparisons put them.
 */
export function orderNewestFirst(entries: OrderEntry[]): number[] {
  // An unparsable Date header yields an Invalid Date rather than nothing, and
  // its getTime() is NaN. NaN compares false against everything including
  // itself, so left alone it would scatter such messages wherever the sort
  // happened to walk. Treated as missing, they land at the end like the rest.
  const time = (d: Date | undefined): number | undefined => {
    const t = d?.getTime()
    return t === undefined || Number.isNaN(t) ? undefined : t
  }

  return [...entries]
    .sort((a, b) => {
      const at = time(a.date)
      const bt = time(b.date)
      if (at !== bt) {
        if (at === undefined) return 1
        if (bt === undefined) return -1
        return bt - at
      }
      return b.uid - a.uid
    })
    .map((e) => e.uid)
}

/**
 * Reads the headers for a set of UIDs, keeping the order they were given in.
 *
 * Shared by listing and searching, so both produce identical entries. The
 * caller has already selected the mailbox and narrowed the UIDs down to one
 * page: fetching headers for a whole result set would defeat the purpose, since
 * a common word matched 6803 messages in the measured mailbox.
 */
export async function fetchHeaders(client: ImapFlow, uids: number[]): Promise<MessageHeader[]> {
  if (uids.length === 0) return []

  const byUid = new Map<number, MessageHeader>()
  for await (const msg of client.fetch(
    uids,
    { uid: true, envelope: true, flags: true, size: true, bodyStructure: true },
    { uid: true },
  )) {
    const env = msg.envelope
    byUid.set(msg.uid, {
      // Through presentMessageId so that a listing names a message the same
      // way reading it does. The envelope repeats the header as it stands.
      messageId: presentMessageId(env?.messageId ?? ''),
      subject: env?.subject ?? '',
      from: toAddresses(env?.from),
      to: toAddresses(env?.to),
      date: env?.date,
      size: msg.size ?? 0,
      seen: msg.flags?.has('\\Seen') ?? false,
      flagged: msg.flags?.has('\\Flagged') ?? false,
      answered: msg.flags?.has('\\Answered') ?? false,
      draft: msg.flags?.has('\\Draft') ?? false,
      hasAttachments: detectAttachments(msg.bodyStructure),
    })
  }

  // fetch does not guarantee the requested order, and the order it was given in
  // is the one the caller established. Sorting by date here instead would throw
  // that away, along with the tiebreaker that makes paging deterministic.
  // A uid that produced no answer is skipped: the message was removed between
  // the search and this fetch.
  return uids.map((uid) => byUid.get(uid)).filter((h): h is MessageHeader => h !== undefined)
}

export interface ListOptions {
  /** How many messages to return. Capped at MAX_LIST_LIMIT. */
  limit?: number
  /** How many of the newest messages to skip, for paging. */
  offset?: number
  /** When true, only unread messages are listed. */
  unreadOnly?: boolean
}

/**
 * Lists the headers of a mailbox, newest first.
 *
 * The Bridge supports neither SORT nor THREAD, so ordering happens here, and it
 * has to happen over the whole result set before a page is cut out of it.
 *
 * Ordering by UID instead would be free, since UIDs ascend with arrival. It was
 * how this worked and it was wrong: a message moved into a mailbox arrives now
 * and therefore gets the highest UID, while its `Date:` stays whatever the
 * sender wrote. It would land on the first page with newer messages behind it.
 * Archiving does exactly this, so in an archive the two orders barely agree at
 * all.
 *
 * The price is one extra fetch across every hit, whose cost is handed back in
 * `ordering` rather than hidden.
 */
export async function listMessages(
  connection: Connection,
  path: string,
  options: ListOptions = {},
): Promise<ListResult> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), MAX_LIST_LIMIT)
  const offset = Math.max(options.offset ?? 0, 0)
  const nothing: OrderingCost = { messages: 0, elapsedMs: 0 }

  return connection.withMailbox(path, async (client, status) => {
    // The Bridge answers FETCH on an empty mailbox with `BAD no such message`
    // instead of an empty result, so nothing may be fetched here.
    if (status.messages === 0) {
      return { path, total: 0, offset, headers: [], ordering: nothing }
    }

    const uids = await client.search(
      options.unreadOnly ? { seen: false } : { all: true },
      { uid: true },
    )
    if (!uids || uids.length === 0) {
      return { path, total: 0, offset, headers: [], ordering: nothing }
    }

    const started = process.hrtime.bigint()
    const ordered = orderNewestFirst(await fetchDates(client, uids))
    const ordering: OrderingCost = {
      messages: uids.length,
      elapsedMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
    }

    const page = ordered.slice(offset, offset + limit)
    if (page.length === 0) {
      return { path, total: ordered.length, offset, headers: [], ordering }
    }

    const headers = await fetchHeaders(client, page)
    return { path, total: ordered.length, offset, headers, ordering }
  })
}

export interface FullMessage extends ParsedMessage {
  /** The mailbox the message was read from. */
  path: string
}

/**
 * Reads a single message and converts it into readable text.
 *
 * `hint` is the mailbox to look in first, which saves a search. Without it the
 * lookup goes through "All Mail".
 */
export async function getMessage(
  connection: Connection,
  messageId: string,
  options: { hint?: string; maxTextChars?: number; textOffset?: number } = {},
): Promise<FullMessage> {
  const resolved = await resolveMessageId(connection, messageId, options.hint)

  const source = await connection.withMailbox(resolved.path, async (client: ImapFlow) => {
    const message = await client.fetchOne(String(resolved.uid), { source: true }, { uid: true })
    if (!message || !message.source) return undefined
    return message.source
  })

  if (!source) {
    throw new BridgeError(
      `The message ${resolved.messageId} was found in "${resolved.path}" but could not be read. ` +
        'It may have been moved or deleted in the meantime. Try again.',
    )
  }

  const parsed = await parseMessage(source, {
    maxTextChars: options.maxTextChars ?? DEFAULT_TEXT_BUDGET,
    textOffset: options.textOffset ?? 0,
  })
  return { ...parsed, path: resolved.path }
}
