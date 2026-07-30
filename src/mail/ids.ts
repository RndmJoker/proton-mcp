/**
 * Stable message identifiers.
 *
 * Measured against the Bridge: UIDs are per mailbox and change when a message
 * is moved, while the Message-ID stays stable. A UID is therefore a throwaway
 * address and never handed out as an identifier.
 *
 * Every identifier this server hands out is the Message-ID. Resolving it back
 * to a UID happens on demand, which costs a search but survives a message
 * being moved between two calls of a conversation.
 */

import type { ImapFlow } from 'imapflow'
import type { Connection } from '../bridge/connection.js'
import { BridgeError } from '../bridge/errors.js'

/** Mailbox that holds every message, including trash. The fallback for lookups. */
export const ALL_MAIL = 'All Mail'

/**
 * Brings a Message-ID into the shape the IMAP header uses.
 *
 * Callers paste identifiers from earlier answers, sometimes without the angle
 * brackets. Both forms have to work, otherwise a lookup fails for a reason
 * nobody can see.
 */
export function normaliseMessageId(id: string): string {
  const trimmed = id.trim()
  if (!trimmed) throw new BridgeError('An empty message id cannot be resolved.')
  const bare = trimmed.replace(/^<|>$/g, '')
  return `<${bare}>`
}

export interface ResolvedMessage {
  messageId: string
  /** The mailbox the message was found in. */
  path: string
  /** Valid only together with `path`, and only until the message is moved. */
  uid: number
  /** Changes when the Bridge renumbers UIDs. Cached UIDs are void afterwards. */
  uidValidity: string
}

/** Searches one mailbox for a Message-ID and returns the UID if present. */
async function findIn(client: ImapFlow, messageId: string): Promise<number | undefined> {
  const hits = await client.search({ header: { 'message-id': messageId } }, { uid: true })
  if (!hits || hits.length === 0) return undefined
  // Several hits would mean duplicates of the same message inside one mailbox.
  // The highest UID is the most recent copy.
  return Math.max(...hits)
}

/**
 * Resolves a Message-ID to a mailbox and UID.
 *
 * `hint` is a mailbox to try first. It is a shortcut, not a requirement: if the
 * message is not there, the search falls back to "All Mail", which holds
 * everything. That is what makes the identifier survive a move.
 */
export async function resolveMessageId(
  connection: Connection,
  rawId: string,
  hint?: string,
): Promise<ResolvedMessage> {
  const messageId = normaliseMessageId(rawId)

  const candidates = hint && hint !== ALL_MAIL ? [hint, ALL_MAIL] : [ALL_MAIL]

  for (const path of candidates) {
    const found = await connection.withMailbox(path, async (client, status) => {
      if (status.messages === 0) return undefined
      const uid = await findIn(client, messageId)
      return uid === undefined ? undefined : { uid, uidValidity: status.uidValidity }
    })
    if (found) {
      return { messageId, path, uid: found.uid, uidValidity: found.uidValidity }
    }
  }

  throw new BridgeError(
    `No message with the id ${messageId} was found${hint ? ` in "${hint}" or in "${ALL_MAIL}"` : ` in "${ALL_MAIL}"`}. ` +
      'The message may have been deleted, or the id may be incomplete. ' +
      'Identifiers come from list_messages or search_messages and have to be passed on unchanged.',
  )
}
