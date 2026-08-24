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

/**
 * The identifier as this server hands it out.
 *
 * Every answer uses this, so that the same message has the same name whichever
 * tool named it. It did not, and the difference was invisible until it was not:
 * a listing reads the IMAP envelope, which repeats the header as it stands,
 * while reading a message goes through a MIME parser that adds the brackets RFC
 * 5322 requires. For a header written correctly both agree. For one written
 * without brackets the same message came back under two names.
 *
 * An empty identifier stays empty rather than becoming `<>`. A message without
 * one cannot be addressed at all, and pretending otherwise would only move the
 * failure further away from its cause.
 */
export function presentMessageId(raw: string): string {
  const trimmed = raw.trim()
  return trimmed ? normaliseMessageId(trimmed) : ''
}

export interface ResolvedMessage {
  messageId: string
  /** The mailbox the message was found in. */
  path: string
  /** Valid only together with `path`, and only until the message is moved. */
  uid: number
  /**
   * Changes when the Bridge renumbers a mailbox, which invalidates every UID in
   * it. Reported for diagnosis only: nothing here keeps a UID beyond the call
   * that resolved it, so there is no cache for this to invalidate.
   */
  uidValidity: string
}

/** The identifier without its angle brackets, whether it had any or not. */
function bareForm(messageId: string): string {
  return messageId.replace(/^<|>$/g, '')
}

/**
 * Checks that a hit really carries this identifier.
 *
 * Needed because the IMAP header search is a **substring** comparison, measured
 * against the Bridge on 31.07.2026: searching for a fragment of an identifier
 * returns the message. So a search for `abc@example.com` also matches a message
 * whose header reads `<xyzabc@example.com>`, and taking that hit would mark the
 * wrong message. Silently, which is the part that matters for a write.
 *
 * The envelope is read rather than the raw header, because that is the same
 * source list_messages hands its identifiers out from. Comparing against
 * anything else could agree with the header and disagree with what the caller
 * was given.
 */
async function carriesId(client: ImapFlow, uid: number, bare: string): Promise<boolean> {
  const message = await client.fetchOne(String(uid), { envelope: true }, { uid: true })
  const actual = message && message.envelope ? (message.envelope.messageId ?? '') : ''
  return bareForm(actual.trim()) === bare
}

/**
 * Searches one mailbox for a Message-ID and returns the UID if present.
 *
 * Two attempts, and the second one exists because of a real message.
 *
 * RFC 5322 requires the angle brackets, so `normaliseMessageId` puts them back
 * on and the first search asks for the bracketed form. That search is exact in
 * practice even though the comparison is a substring one: `<abc>` cannot occur
 * inside `<xyzabc>`, because the bracket has to sit immediately before the
 * identifier.
 *
 * Real mail does not always obey. A message was found whose header carries the
 * identifier bare, and the envelope hands it out exactly as it stands, so
 * everything this server had already reported for that message was unfindable:
 * the bracketed search never matched, and it was the only search there was.
 * Marking 67 messages as read left that one behind with no way to reach it.
 *
 * The second attempt therefore drops the brackets, which finds both spellings,
 * and every hit is verified because that search can also match a message that
 * merely contains the identifier. It only runs when the first one came back
 * empty, so nothing normal pays for it.
 */
export async function findByMessageId(
  client: ImapFlow,
  messageId: string,
): Promise<number | undefined> {
  const exact = await client.search({ header: { 'message-id': messageId } }, { uid: true })
  if (exact && exact.length > 0) {
    // Several hits mean duplicates of the same message inside one mailbox.
    // The highest UID is the most recent copy.
    return Math.max(...exact)
  }

  const bare = bareForm(messageId)
  const loose = await client.search({ header: { 'message-id': bare } }, { uid: true })
  if (!loose || loose.length === 0) return undefined

  // Newest first, so a duplicate resolves to the more recent copy like above.
  for (const uid of [...loose].sort((a, b) => b - a)) {
    if (await carriesId(client, uid, bare)) return uid
  }
  return undefined
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
      const uid = await findByMessageId(client, messageId)
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
