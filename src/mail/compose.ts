/**
 * Building a message, and the address handling that goes with it.
 *
 * Kept apart from drafts.ts and from sending because both need exactly the
 * same thing and must not drift: the recipients a confirmation shows have to
 * be the recipients that are written or sent, or the confirmation is theatre.
 *
 * No attachment can be read from disk here, and that is deliberate rather than
 * unfinished. An attachment taken from a path would mean the model names a
 * file, the server reads it, and the next confirmation the user waves through
 * carries it outside. Which paths may be reached is its own decision, not a
 * side effect of being able to write a draft.
 */

import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import { createHash, randomUUID } from 'node:crypto'
import { BridgeError } from '../bridge/errors.js'
import { assertSendableMarkup, type MarkupUrl } from './markup.js'
import { htmlToText } from '../mime/parse.js'

/** An address, optionally with a display name. */
export interface Recipient {
  name?: string
  address: string
}

export interface Draft {
  from: Recipient
  to: Recipient[]
  cc: Recipient[]
  bcc: Recipient[]
  subject: string
  text: string
  /** Message-ID of the message being answered, for In-Reply-To. */
  inReplyTo?: string
  /** The chain, oldest first. Mail readers use it to build the thread. */
  references?: string[]
  /** Our own Message-ID. Minted here so there is a handle straight away. */
  messageId: string
  /** A whole message carried along, used when forwarding. */
  attachedMessage?: { filename: string; raw: Buffer }
  /**
   * The message as markup, when it has any.
   *
   * `text` stays filled either way and is what the confirmation reads, because
   * a person confirming a send has to be shown something they can actually
   * read. When only markup is given, the text is derived from it with the same
   * conversion this server uses for received mail, which puts every link target
   * beside the text it belongs to.
   *
   * Only one of the two is delivered. Proton keeps the markup and drops the
   * text half of a message that carries both, measured, so composing both would
   * mean the recipient never sees the part that was confirmed.
   */
  html?: string
  /** Files referenced from the markup by content id. */
  inlineParts?: InlinePart[]
}

/** A file carried inside the message and referenced from the markup. */
export interface InlinePart {
  /** Matches a `cid:` in the markup. */
  contentId: string
  filename: string
  contentType: string
  content: Buffer
}

/**
 * Checks an address well enough to catch the mistakes that matter.
 *
 * Not a full RFC 5322 parser, and not trying to be: the point is to refuse a
 * string that would end up somewhere unintended, not to adjudicate exotic but
 * legal forms. A newline is the one that has to be caught, because a header
 * injected through an address field would let the sender of a mail the model
 * just read add a recipient the confirmation never showed.
 */
export function parseRecipient(input: string): Recipient {
  const raw = input.trim()
  if (!raw) throw new BridgeError('An empty recipient cannot be used.')
  if (/[\r\n]/.test(raw)) {
    throw new BridgeError(
      `The recipient "${raw.replace(/[\r\n]+/g, ' ')}" contains a line break. A line break in an ` +
        'address is how a header is smuggled in, so it is refused rather than stripped.',
    )
  }

  const angled = /^(.*)<([^<>]+)>$/.exec(raw)
  const name = angled ? angled[1]!.trim().replace(/^"|"$/g, '') : undefined
  const address = (angled ? angled[2]! : raw).trim()

  // One @, something on each side, a dot in the domain, no spaces anywhere.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new BridgeError(
      `"${address}" is not a usable email address. Expected something of the form name@example.com, ` +
        'optionally as "Display Name <name@example.com>".',
    )
  }
  return name ? { name, address } : { address }
}

export function parseRecipients(list: string[] | undefined): Recipient[] {
  return (list ?? []).map(parseRecipient)
}

/** Every address a message would go to, in the order a person reads them. */
export function allRecipients(draft: Draft): Recipient[] {
  return [...draft.to, ...draft.cc, ...draft.bcc]
}

/** Mints a Message-ID. Measured: the Bridge keeps ours rather than replacing it. */
export function mintMessageId(from: string): string {
  const domain = from.split('@')[1] ?? 'proton-mcp.local'
  return `<${randomUUID()}@${domain}>`
}

/** Brings a Message-ID into the shape headers use. */
function angled(id: string): string {
  const bare = id.trim().replace(/^<|>$/g, '')
  return `<${bare}>`
}

/**
 * Builds the MIME message.
 *
 * A message carries either text or markup, never both. Measured: Proton keeps
 * the markup and drops the text half of a message that has both, so composing
 * both would deliver the half nobody confirmed.
 *
 * `keepBcc` decides whether the blind copies appear as a header in the built
 * message, and the two cases are opposites for a good reason. A message that
 * goes out must not carry them: the header would tell every recipient who was
 * copied in secretly, which is the one thing a blind copy is for. A draft that
 * is stored must carry them, or the addresses are gone by the time anyone comes
 * back to send it. So drafts keep it and sending does not.
 *
 * Declared async so that a refusal comes back as a rejected promise like every
 * other failure here, rather than being thrown before the promise exists.
 */
export async function buildMessage(
  draft: Draft,
  options: { keepBcc?: boolean } = {},
): Promise<Buffer> {
  if (/[\r\n]/.test(draft.subject)) {
    throw new BridgeError(
      'The subject contains a line break. That is how an extra header gets added to a message, ' +
        'so it is refused rather than stripped.',
    )
  }
  if (draft.to.length === 0 && draft.cc.length === 0 && draft.bcc.length === 0) {
    throw new BridgeError('A message needs at least one recipient.')
  }

  const fields: Record<string, unknown> = {
    from: draft.from,
    to: draft.to,
    subject: draft.subject,
    messageId: draft.messageId,
    date: new Date(),
  }

  if (draft.html === undefined) {
    fields.text = draft.text
  } else {
    // Checked here rather than only at the tool, so that no path into this
    // function can produce a message whose markup was never read.
    const reading = assertSendableMarkup(draft.html)

    // Every content id the markup points at has to have arrived with it. A
    // reference to a part that is not there shows the recipient a broken image
    // where the sender saw a picture, and neither of them finds out why.
    const provided = new Set((draft.inlineParts ?? []).map((part) => part.contentId))
    const missing = reading.contentIds.filter((id) => !provided.has(id))
    if (missing.length) {
      throw new BridgeError(
        `The markup refers to ${missing.map((id) => `"cid:${id}"`).join(', ')}, but no such file ` +
          'was given. Either provide the file or point the image at a full address instead.',
      )
    }
    fields.html = draft.html
  }
  if (draft.cc.length) fields.cc = draft.cc
  if (draft.bcc.length) fields.bcc = draft.bcc
  if (draft.inReplyTo) fields.inReplyTo = angled(draft.inReplyTo)
  if (draft.references?.length) fields.references = draft.references.map(angled)
  const attachments: Array<Record<string, unknown>> = []
  if (draft.attachedMessage) {
    attachments.push({
      filename: draft.attachedMessage.filename,
      content: draft.attachedMessage.raw,
      contentType: 'message/rfc822',
    })
  }
  for (const part of draft.inlineParts ?? []) {
    attachments.push({
      filename: part.filename,
      content: part.content,
      contentType: part.contentType,
      cid: part.contentId,
    })
  }
  if (attachments.length) fields.attachments = attachments

  // keepBcc is not an option MailComposer understands. It lives on the MimeNode
  // that compile() hands back and is read when that node is built, so it has to
  // be set in between. Passing it in with the other fields does nothing at all,
  // silently, which is how a stored draft would lose its blind copies.
  const node = new MailComposer(fields).compile()
  node.keepBcc = options.keepBcc === true

  return new Promise((resolve, reject) => {
    node.build((error, message) => {
      if (error) reject(new BridgeError(`The message could not be built: ${error.message}`))
      else resolve(message)
    })
  })
}

/** Subject with a prefix, unless it already carries one. */
export function prefixSubject(subject: string, prefix: 'Re' | 'Fwd'): string {
  const trimmed = subject.trim()
  const already = prefix === 'Re' ? /^(re|aw)\s*:/i : /^(fwd?|wg)\s*:/i
  if (already.test(trimmed)) return trimmed
  return `${prefix}: ${trimmed || '(no subject)'}`
}

/**
 * Quotes a message the way mail readers do.
 *
 * The quoted text is content written by a stranger. It is not filtered and no
 * attempt is made to detect instructions inside it, in line with the rest of
 * this server: the boundary is the confirmation before sending, not a filter
 * that pretends to recognise an attack.
 */
export function quote(
  original: { from: Recipient[]; date: Date | undefined; subject: string; text: string },
  limit = 4000,
): string {
  const who = original.from.map((f) => (f.name ? `${f.name} <${f.address}>` : f.address)).join(', ')
  const when = original.date ? original.date.toISOString().slice(0, 16).replace('T', ' ') : 'an unknown date'
  const body = original.text.length > limit ? `${original.text.slice(0, limit)}\n[...]` : original.text
  const quoted = body
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  return `\n\nOn ${when}, ${who || 'someone'} wrote:\n${quoted}`
}

/** One address as a person reads it. */
export function showRecipient(r: Recipient): string {
  return r.name ? `${r.name} <${r.address}>` : r.address
}

/**
 * The recipients in plain text, separated into To, Cc and Bcc.
 *
 * Shared by the draft answers and by the confirmation shown before sending, on
 * purpose: if those two ever described a message differently, the confirmation
 * would be showing something other than what goes out, and a confirmation that
 * does not show the truth is worse than none.
 */
export function describeRecipients(draft: {
  to: Recipient[]
  cc: Recipient[]
  bcc: Recipient[]
}): string {
  const lines = [`To:  ${draft.to.map(showRecipient).join(', ') || '(none)'}`]
  if (draft.cc.length) lines.push(`Cc:  ${draft.cc.map(showRecipient).join(', ')}`)
  if (draft.bcc.length) {
    lines.push(
      `Bcc: ${draft.bcc.map(showRecipient).join(', ')}   <- hidden from the other recipients, but they do receive it`,
    )
  }
  return lines.join('\n')
}

/** The first lines of a body, for a confirmation that has to stay readable. */
export function firstLines(text: string, lines = 8, chars = 600): string {
  const head = text.split('\n').slice(0, lines).join('\n')
  const cut = head.length > chars ? `${head.slice(0, chars)}...` : head
  return cut.trim() || '(the message has no text)'
}

/**
 * Written into the description of every tool that takes text from a caller.
 *
 * It exists because of an observed failure rather than a hypothetical one: an
 * assistant using this server wrote German with "ae", "oe", "ue" and "ss" in
 * place of the umlauts, in a message whose whole point was to carry them. A
 * model that is unsure whether an interface survives non-ASCII will write around
 * it, and the result is text that is wrong in a way nothing downstream can
 * repair.
 *
 * The claim is measured, not assumed: a subject arrives MIME-encoded and decodes
 * back to the characters it was given, a body carries `charset=utf-8`, and an
 * attachment filename survives as an encoded word. Checked end to end through
 * the Bridge on 31.07.2026.
 */
export const UTF8_NOTE =
  'Text is UTF-8 everywhere: subject, body and addresses. Write characters as the language ' +
  'actually spells them, including umlauts, accents, sharp s, quotation marks and any other ' +
  // The two examples are escaped rather than written out. Everything public in
  // this repository is English, and the check that enforces that reads a
  // literal umlaut as German prose. Here they are specimens rather than
  // language, and the string a caller receives is the same either way.
  'non-ASCII character. Do not transliterate them away (no "ae" for "\u00e4", no "ss" for ' +
  '"\u00df"): the subject is encoded for transport and decoded again on arrival, and the body ' +
  'carries its character set, both verified against the Bridge. A transliterated message is ' +
  'simply a message with the wrong words in it.'

/**
 * Written into the description of every tool that takes a message body.
 *
 * Also measured rather than assumed. HTML placed in the body field is sent as
 * `text/plain` and arrives as visible characters: the recipient reads
 * `<b>Fett</b>`, tags and all. Nothing in the interface said so, and "the
 * transport carries HTML" is true of the Bridge while being false of these
 * tools, which is exactly the kind of gap a model falls into.
 *
 * The note says what to do instead, because a prohibition without an
 * alternative is an invitation to try anyway.
 */
export const MARKUP_NOTE =
  'A message may instead be written as markup, in the html field, which is delivered as ' +
  'formatting rather than as visible tags. Give one or the other, not both: a message that ' +
  'carries markup has its plain text half dropped, so the half that was confirmed would never ' +
  'arrive. Permitted are headings, paragraphs, line breaks, rules, quotes, emphasis, lists, ' +
  'tables, links and images, with colour, font, alignment, spacing and borders. Anything else ' +
  'is refused rather than quietly removed, and the answer names what and why. Note that the ' +
  'confirmation shows every address in the message in full, including the ones behind links and ' +
  'images, and every alt text, because those are what a recipient reads.'

export const PLAIN_TEXT_NOTE =
  'The body is plain text and markup is not interpreted. HTML written here is delivered as ' +
  'visible characters, so the recipient would read the tags rather than see formatting. ' +
  'Give a message its shape with line breaks, blank lines, indentation and plain lists, and ' +
  'write a link as the bare address so that what is read is what is followed.'

/**
 * The message as a person will read it.
 *
 * For a plain text message that is the text itself. For markup it is the same
 * conversion this server applies to received mail, which is the point rather
 * than a convenience: it writes every link target beside the text it belongs
 * to, and that is exactly the difference a person confirming a send has to see.
 */
export function readableBody(draft: Draft): string {
  return draft.html === undefined ? draft.text : htmlToText(draft.html)
}

/**
 * Everything the message points at or carries, for the confirmation.
 *
 * Kept whole and never shortened. The body excerpt in a confirmation is cut
 * after a few lines, so an address on line thirty would otherwise never be
 * shown, which is precisely where one would be put to avoid being read.
 */
export function describeAttachments(draft: Draft): string[] {
  const lines: string[] = []
  if (draft.attachedMessage) {
    lines.push(
      `${draft.attachedMessage.filename} (the forwarded message, ${draft.attachedMessage.raw.length} bytes)`,
    )
  }
  for (const part of draft.inlineParts ?? []) {
    lines.push(`${part.filename} (${part.contentType}, ${part.content.length} bytes, in the message body)`)
  }
  return lines
}

/** The addresses in a message's markup, with the text they are shown as. */
export function describeUrls(draft: Draft): MarkupUrl[] {
  return draft.html === undefined ? [] : assertSendableMarkup(draft.html).urls
}

/** Text a recipient can read that the readable body leaves out. */
export function hiddenTextOf(draft: Draft): string[] {
  return draft.html === undefined ? [] : assertSendableMarkup(draft.html).hiddenText
}

/** A fingerprint of a file, so a confirmation can be bound to its contents. */
export function fingerprintPart(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}
