/**
 * Turning raw messages into something a language model can read.
 *
 * Three facts measured against the Bridge drive this module:
 *
 * 1. A message with three sentences of content costs around 2782 tokens raw as
 *    HTML, while the content itself is about 30. In a real mailbox the median
 *    message is roughly 16200 tokens raw. Twenty of those exceed a full context
 *    window, so raw content is never passed on.
 * 2. HTML messages lose their plain text part on the way through Proton. There
 *    is no fallback, so converting HTML to text is mandatory rather than
 *    optional.
 * 3. Proton attaches its own PGP public key to every message sent through the
 *    Bridge. It is not a real attachment and has to be filtered out of every
 *    attachment list.
 */

import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser'
import { convert } from 'html-to-text'

export interface Address {
  name?: string
  address: string
}

export interface Attachment {
  /** Index within the message, used to fetch the content later. */
  index: number
  filename: string
  contentType: string
  size: number
  /** Content-ID, set for images referenced from the HTML body. */
  contentId?: string
}

export interface ParsedMessage {
  /** Stable across mailboxes, unlike a UID, which changes on every move. */
  messageId: string
  subject: string
  from: Address[]
  to: Address[]
  cc: Address[]
  /**
   * Only ever filled for a draft we wrote ourselves. A delivered message never
   * carries the blind copies, which is the point of them.
   */
  bcc: Address[]
  replyTo: Address[]
  date: Date | undefined
  /** Readable text. Always filled when the message has any body at all. */
  text: string
  /** Where the text came from. "html" means it was converted. */
  textSource: 'plain' | 'html' | 'none'
  /** True when the text was shortened to stay within the budget. */
  truncated: boolean
  /** Where to continue reading, or undefined when the end was reached. */
  nextTextOffset?: number
  /** Total length of the body text, whether shown or not. */
  totalTextChars: number
  /** Real attachments. Proton's own public key is not among them. */
  attachments: Attachment[]
  /** True when Proton's public key was filtered out. */
  protonKeyFiltered: boolean
  /** Size of the raw message in bytes, for diagnostics. */
  rawSize: number
}

/**
 * Recognises the public key Proton attaches to every outgoing message.
 *
 * Measured shape: content type `application/pgp-keys`, file name
 * `publickey - <address> - 0x<id>.asc`. The content type alone is not enough,
 * because a genuinely attached key would look the same. The name pattern is
 * what Proton generates.
 */
export function isProtonPublicKey(contentType: string, filename: string): boolean {
  if (contentType.toLowerCase() !== 'application/pgp-keys') return false
  return /^publickey - .+ - 0x[0-9a-f]+\.asc$/i.test(filename)
}

/** Converts HTML into readable text without ever fetching anything. */
export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      // Images are dropped. Their URLs are worthless without fetching them,
      // and fetching would confirm to the sender that the message was read.
      { selector: 'img', format: 'skip' },
      // Links keep their target. A recipient has to be able to see where a
      // link actually goes, that is the whole point when judging a phishing
      // attempt.
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      // Tracking pixels and layout tables carry no content.
      { selector: 'table', format: 'dataTable' },
      // By default headings are upper-cased, which changes the wording of the
      // message. A model should see what was written, not a shouted version.
      { selector: 'h1', options: { uppercase: false } },
      { selector: 'h2', options: { uppercase: false } },
      { selector: 'h3', options: { uppercase: false } },
      { selector: 'h4', options: { uppercase: false } },
      { selector: 'h5', options: { uppercase: false } },
      { selector: 'h6', options: { uppercase: false } },
    ],
  })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function addresses(field: AddressObject | AddressObject[] | undefined): Address[] {
  if (!field) return []
  const list = Array.isArray(field) ? field : [field]
  const out: Address[] = []
  for (const group of list) {
    for (const entry of group.value ?? []) {
      if (!entry.address) continue
      const item: Address = { address: entry.address }
      if (entry.name) item.name = entry.name
      out.push(item)
    }
  }
  return out
}

/** Rough token estimate from a character count. Four characters per token is close enough to budget with. */
export function estimateTokensForChars(chars: number): number {
  return Math.ceil(chars / 4)
}

/** Rough token estimate for a piece of text. */
export function estimateTokens(text: string): number {
  return estimateTokensForChars(text.length)
}

export interface Excerpt {
  text: string
  truncated: boolean
  /** Where to continue reading, or undefined when the end was reached. */
  nextOffset?: number
  /** Total length of the untruncated text. */
  totalChars: number
}

/**
 * Returns a window of the text and says exactly where it ends.
 *
 * Cutting silently would be worse than cutting visibly: the model would treat a
 * truncated message as complete and draw conclusions from something that is not
 * there. And a note saying "ask for the rest" is only honest if there is a way
 * to ask, hence nextOffset. Long messages are read the way long listings are
 * paged, not by raising a limit until it fits.
 */
export function truncate(text: string, maxChars: number, offset = 0): Excerpt {
  const totalChars = text.length
  const from = Math.max(0, Math.min(offset, totalChars))
  const window = text.slice(from, from + maxChars)

  const isStart = from === 0
  const reachesEnd = from + window.length >= totalChars

  if (isStart && reachesEnd) {
    return { text, truncated: false, totalChars }
  }

  // Prefer to cut at a paragraph or line break, so no sentence is severed
  // mid-word. Only when that does not throw away half the window.
  let cut = window
  if (!reachesEnd) {
    const lastBreak = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'))
    if (lastBreak > maxChars * 0.5) cut = window.slice(0, lastBreak)
  }

  const end = from + cut.length
  const parts: string[] = []

  if (!isStart) {
    parts.push(`[... continuing at character ${from} of ${totalChars} ...]`, '')
  }
  parts.push(cut)

  if (end < totalChars) {
    const remaining = totalChars - end
    parts.push(
      '',
      `[... ${remaining} of ${totalChars} characters not shown, roughly ` +
        `${estimateTokensForChars(remaining)} tokens. Pass textOffset=${end} to continue reading.]`,
    )
  }

  const result: Excerpt = {
    text: parts.join('\n'),
    truncated: true,
    totalChars,
  }
  if (end < totalChars) result.nextOffset = end
  return result
}

export interface ParseOptions {
  /** Upper bound for the body text in characters. 0 means no limit. */
  maxTextChars?: number
  /** Where to start reading the body, for continuing a long message. */
  textOffset?: number
}

/** Parses a raw message. */
export async function parseMessage(
  source: Buffer | string,
  options: ParseOptions = {},
): Promise<ParsedMessage> {
  const parsed: ParsedMail = await simpleParser(source, {
    // We never render HTML, so there is no reason to have mailparser build a
    // second HTML representation of the plain text part.
    skipTextToHtml: true,
    skipTextLinks: true,
  })

  let text = ''
  let textSource: ParsedMessage['textSource'] = 'none'
  if (parsed.text && parsed.text.trim()) {
    text = parsed.text.trim()
    textSource = 'plain'
  } else if (parsed.html) {
    text = htmlToText(parsed.html)
    textSource = 'html'
  }

  const limit = options.maxTextChars ?? 0
  const offset = options.textOffset ?? 0
  const excerpt: Excerpt =
    limit > 0
      ? truncate(text, limit, offset)
      : { text, truncated: false, totalChars: text.length }

  const attachments: Attachment[] = []
  let protonKeyFiltered = false
  let index = 0
  for (const a of parsed.attachments ?? []) {
    const filename = a.filename ?? ''
    const contentType = a.contentType ?? 'application/octet-stream'
    if (isProtonPublicKey(contentType, filename)) {
      protonKeyFiltered = true
      // Deliberately not counted: the index has to match what a caller sees.
      continue
    }
    const item: Attachment = {
      index: index++,
      filename: filename || `attachment-${index}`,
      contentType,
      size: a.size ?? 0,
    }
    if (a.cid) item.contentId = a.cid
    attachments.push(item)
  }

  return {
    messageId: parsed.messageId ?? '',
    subject: parsed.subject ?? '',
    from: addresses(parsed.from),
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    bcc: addresses(parsed.bcc),
    replyTo: addresses(parsed.replyTo),
    date: parsed.date,
    text: excerpt.text,
    textSource,
    truncated: excerpt.truncated,
    ...(excerpt.nextOffset !== undefined ? { nextTextOffset: excerpt.nextOffset } : {}),
    totalTextChars: excerpt.totalChars,
    attachments,
    protonKeyFiltered,
    rawSize: typeof source === 'string' ? Buffer.byteLength(source) : source.length,
  }
}
