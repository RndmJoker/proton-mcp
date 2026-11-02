/**
 * Reading attachments.
 *
 * Attachments are the fastest way to blow a context window: the largest message
 * in a measured sample was 4.8 MB. Nothing is fetched unless asked for by
 * index, and text is subject to a budget.
 *
 * Binary content is deliberately not returned yet. Handing it over would mean
 * either base64 in the context, which is unusable, or writing decrypted content
 * to disk. The latter would undo Proton's encryption locally and needs a
 * deliberate decision first.
 */

import { simpleParser } from 'mailparser'
import type { Connection } from '../bridge/connection.js'
import { BridgeError } from '../bridge/errors.js'
import { resolveMessageId } from './ids.js'
import { isProtonPublicKey, truncate } from '../mime/parse.js'

/** Upper bound for attachment text. Roughly 12000 tokens. */
export const MAX_ATTACHMENT_CHARS = 48_000

/** Content types that can be shown as text. */
const TEXTUAL = [
  /^text\//i,
  /^application\/json$/i,
  /^application\/xml$/i,
  /^application\/x-yaml$/i,
  /^application\/javascript$/i,
  /\+xml$/i,
  /\+json$/i,
]

export function isTextual(contentType: string): boolean {
  return TEXTUAL.some((p) => p.test(contentType))
}

export interface AttachmentContent {
  filename: string
  contentType: string
  size: number
  /** Present for textual attachments. */
  text?: string
  truncated?: boolean
  /** Where to continue reading, or undefined when the end was reached. */
  nextOffset?: number
  totalChars?: number
  /** Set when the content cannot be handed over as text. */
  unsupportedReason?: string
}

/** One attachment of a message, picked by index, with its bytes. */
export interface PickedAttachment {
  filename: string
  contentType: string
  size: number
  content: Buffer
}

/**
 * Picks one attachment of a message by index.
 *
 * The index refers to the list from get_message, which already excludes
 * Proton's own public key. The same filter runs here so both stay aligned, and
 * reading an attachment as text and saving it as a file pick the same one.
 */
export async function pickAttachment(
  connection: Connection,
  messageId: string,
  index: number,
  hint?: string,
): Promise<PickedAttachment> {
  if (!Number.isInteger(index) || index < 0) {
    throw new BridgeError(`"${index}" is not a valid attachment index. Expected 0 or higher.`)
  }

  const resolved = await resolveMessageId(connection, messageId, hint)

  const source = await connection.withMailbox(resolved.path, async (client) => {
    const message = await client.fetchOne(String(resolved.uid), { source: true }, { uid: true })
    return message && message.source ? message.source : undefined
  })

  if (!source) {
    throw new BridgeError(
      `The message ${resolved.messageId} could not be read from "${resolved.path}". It may have been moved.`,
    )
  }

  const parsed = await simpleParser(source, { skipTextToHtml: true, skipTextLinks: true })

  const real = (parsed.attachments ?? []).filter(
    (a) => !isProtonPublicKey(a.contentType ?? '', a.filename ?? ''),
  )

  const wanted = real[index]
  if (!wanted) {
    const available = real.length
    throw new BridgeError(
      available === 0
        ? `The message ${resolved.messageId} has no attachments.`
        : `Attachment index ${index} does not exist. The message has ${available}, so valid indices are 0 to ${available - 1}.`,
    )
  }

  return {
    contentType: wanted.contentType ?? 'application/octet-stream',
    filename: wanted.filename ?? `attachment-${index}`,
    size: wanted.size ?? wanted.content?.length ?? 0,
    content: wanted.content ?? Buffer.alloc(0),
  }
}

/** Reads one attachment of a message by index, as text where it is text. */
export async function getAttachment(
  connection: Connection,
  messageId: string,
  index: number,
  options: { hint?: string; offset?: number } = {},
): Promise<AttachmentContent> {
  const { filename, contentType, size, content } = await pickAttachment(connection, messageId, index, options.hint)

  if (!isTextual(contentType)) {
    return {
      filename,
      contentType,
      size,
      unsupportedReason:
        `This attachment is ${contentType} and cannot be returned as text, because that would mean ` +
        'base64 in the context. save_attachment saves it as a file on this machine where the user ' +
        'has set that up; otherwise open the message in a mail client.',
    }
  }

  const raw = content.toString('utf8')
  const excerpt = truncate(raw, MAX_ATTACHMENT_CHARS, options.offset ?? 0)
  const result: AttachmentContent = {
    filename,
    contentType,
    size,
    text: excerpt.text,
    truncated: excerpt.truncated,
    totalChars: excerpt.totalChars,
  }
  if (excerpt.nextOffset !== undefined) result.nextOffset = excerpt.nextOffset
  return result
}
