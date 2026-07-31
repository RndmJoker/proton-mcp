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
import { randomUUID } from 'node:crypto'
import { BridgeError } from '../bridge/errors.js'

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
 * Plain text only. Proton strips the plain text part out of a multipart message
 * anyway (measured), so offering HTML would mean composing something the
 * recipient receives in a different shape than the one that was confirmed.
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
    text: draft.text,
    messageId: draft.messageId,
    date: new Date(),
  }
  if (draft.cc.length) fields.cc = draft.cc
  if (draft.bcc.length) fields.bcc = draft.bcc
  if (draft.inReplyTo) fields.inReplyTo = angled(draft.inReplyTo)
  if (draft.references?.length) fields.references = draft.references.map(angled)
  if (draft.attachedMessage) {
    fields.attachments = [
      {
        filename: draft.attachedMessage.filename,
        content: draft.attachedMessage.raw,
        contentType: 'message/rfc822',
      },
    ]
  }

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
