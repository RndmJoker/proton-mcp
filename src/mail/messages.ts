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
import { resolveMessageId } from './ids.js'
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

export interface ListResult {
  path: string
  /** Total number of messages in the mailbox, independent of paging. */
  total: number
  offset: number
  headers: MessageHeader[]
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

/**
 * Reads the headers for a set of UIDs, newest first.
 *
 * Shared by listing and searching, so both produce identical entries. The
 * caller has already selected the mailbox and narrowed the UIDs down to one
 * page: fetching headers for a whole result set would defeat the purpose, since
 * a common word matched 6803 messages in the measured mailbox.
 */
export async function fetchHeaders(client: ImapFlow, uids: number[]): Promise<MessageHeader[]> {
  if (uids.length === 0) return []

  const headers: MessageHeader[] = []
  for await (const msg of client.fetch(
    uids,
    { uid: true, envelope: true, flags: true, size: true, bodyStructure: true },
    { uid: true },
  )) {
    const env = msg.envelope
    headers.push({
      messageId: env?.messageId ?? '',
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

  // fetch does not guarantee the requested order, so sort by date here.
  headers.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0))
  return headers
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
 * The Bridge supports neither SORT nor THREAD, so ordering happens here. UIDs
 * ascend with arrival, so the highest UIDs are the newest messages and the
 * order comes for free from the UID list.
 */
export async function listMessages(
  connection: Connection,
  path: string,
  options: ListOptions = {},
): Promise<ListResult> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), MAX_LIST_LIMIT)
  const offset = Math.max(options.offset ?? 0, 0)

  return connection.withMailbox(path, async (client, status) => {
    // The Bridge answers FETCH on an empty mailbox with `BAD no such message`
    // instead of an empty result, so nothing may be fetched here.
    if (status.messages === 0) {
      return { path, total: 0, offset, headers: [] }
    }

    const uids = await client.search(
      options.unreadOnly ? { seen: false } : { all: true },
      { uid: true },
    )
    if (!uids || uids.length === 0) {
      return { path, total: 0, offset, headers: [] }
    }

    // Newest first, then cut out the requested page.
    const ordered = [...uids].sort((a, b) => b - a)
    const page = ordered.slice(offset, offset + limit)
    if (page.length === 0) {
      return { path, total: ordered.length, offset, headers: [] }
    }

    const headers = await fetchHeaders(client, page)
    return { path, total: ordered.length, offset, headers }
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
