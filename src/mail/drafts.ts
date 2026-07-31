/**
 * Creating and changing drafts.
 *
 * A draft is the safe default: the assistant prepares, the person decides.
 * Nothing in this file sends anything, and nothing in it can. Sending lives in
 * send.ts behind a confirmation.
 *
 * Measured against the Bridge on 31.07.2026:
 *
 * 1. **`APPEND` into "Drafts" works and keeps our Message-ID.** A client-minted
 *    id comes back unchanged, so a draft has a stable handle from the moment it
 *    is written, without waiting for anything to settle.
 * 2. **Changing a draft is: append the new version, expunge the old one.** That
 *    held: the mailbox was left with exactly the new version, unchanged forty
 *    seconds later.
 * 3. **An appended message takes about twenty seconds to appear in "All Mail".**
 *    It is in its own mailbox immediately. That is why every lookup in here goes
 *    to "Drafts" directly and never through the ordinary resolver, which falls
 *    back to "All Mail" and would not find a draft written a moment ago.
 * 4. **Proton rewrites the thread headers of anything it stores.** A draft
 *    appended with `In-Reply-To` and `References` comes back with `In-Reply-To`
 *    gone and `References` replaced by a single `@protonmail.internalid` value.
 *    Our own `Message-ID` survives; the chain does not.
 *
 * Point 4 is worth stating plainly rather than burying: **the reference headers
 * written here are correct when they are built and are not what ends up in the
 * stored draft.** They still matter, because Proton reads them to work out which
 * conversation the draft belongs to, but a draft that is stored and sent later
 * carries Proton's idea of the thread and not ours. Sending a reply with headers
 * we control means building it and sending it without storing it in between,
 * which is why replying is also a sending tool and not only a draft tool.
 * Measured on the other side of that fence: a message handed to SMTP keeps its
 * `In-Reply-To`. So the difference is real, and it is a difference between
 * storing and sending rather than a limitation of what we can build.
 *
 * The dangerous line is the expunge in updateDraft. It is the same operation
 * that removes a label, and aimed at the wrong mailbox it deletes mail, so it
 * is guarded twice: the mailbox must be "Drafts", and the message must actually
 * carry the \Draft flag.
 */

import type { ImapFlow } from 'imapflow'
import type { Connection } from '../bridge/connection.js'
import { BridgeError } from '../bridge/errors.js'
import { normaliseMessageId, findByMessageId } from './ids.js'
import { getMessage, listMessages, type ListResult } from './messages.js'
import { htmlToText } from '../mime/parse.js'
import {
  buildMessage,
  mintMessageId,
  parseRecipient,
  parseRecipients,
  escapeHtml,
  prefixSubject,
  quote,
  quoteAsHtml,
  quoteBody,
  type Draft,
  type Recipient,
} from './compose.js'

/** The one mailbox this module writes to. */
export const DRAFTS = 'Drafts'

/**
 * Guard for the expunge. Nothing outside "Drafts" is ever opened for writing
 * here, because removing the old version of a draft is a deletion, and the same
 * command aimed at a folder would delete mail that nobody meant to lose.
 */
function assertDraftMailbox(path: string): void {
  if (path !== DRAFTS) {
    throw new BridgeError(
      `Refusing to operate on "${path}". This code only ever writes to "${DRAFTS}", because ` +
        'replacing a draft expunges the old version and doing that elsewhere would delete mail.',
    )
  }
}

function assertWritable(readOnly: boolean, what: string): void {
  if (readOnly) {
    throw new BridgeError(
      `The server is running read-only, so ${what} is refused. ` +
        'This is set by PROTON_MCP_READ_ONLY and the web interface reports it as the current mode.',
    )
  }
}

/**
 * What a caller may hand in. Strings, because that is what a tool receives.
 *
 * `undefined` is spelled out rather than left to the optional marker: under
 * exactOptionalPropertyTypes those are different things, and a tool handler
 * hands over exactly the shape where an absent field is present as undefined.
 */
export interface DraftInput {
  to?: string[] | undefined
  cc?: string[] | undefined
  bcc?: string[] | undefined
  subject?: string | undefined
  text?: string | undefined
  html?: string | undefined
}

export interface DraftResult {
  messageId: string
  subject: string
  to: Recipient[]
  cc: Recipient[]
  bcc: Recipient[]
  /** Its uid in "Drafts". Valid until the draft is replaced. */
  uid: number
  /** Set when a whole message was carried along, as with a forward. */
  carriedAttachments?: string[]
}

/**
 * A message carries text or markup, never both.
 *
 * Refused rather than resolved by a rule nobody would remember. Measured:
 * Proton keeps the markup and drops the text half of a message that has both,
 * so whichever one this server chose to prefer, the other would silently never
 * arrive.
 */
function assertOneBody(input: DraftInput): void {
  if (input.html !== undefined && input.text !== undefined) {
    throw new BridgeError(
      'Both a text and a markup body were given. A message carries one or the other: Proton drops ' +
        'the text half of a message that has both, so the half that was confirmed would never ' +
        'arrive. Give whichever one this message is.',
    )
  }
}

/** Writes a built message into "Drafts" and returns its new uid. */
async function appendDraft(connection: Connection, raw: Buffer): Promise<number> {
  const result = await connection.withMailbox(DRAFTS, async (client, status) => {
    assertDraftMailbox(status.path)
    return client.append(DRAFTS, raw, ['\\Draft', '\\Seen'], new Date())
  })
  if (!result || typeof result.uid !== 'number') {
    throw new BridgeError(
      'The Bridge did not confirm where the draft was stored, so it is not certain that it was ' +
        'written. Look in the Drafts mailbox before writing it again.',
    )
  }
  return result.uid
}

/** Finds a draft by its Message-ID, inside "Drafts" and nowhere else. */
async function findDraft(
  connection: Connection,
  messageId: string,
): Promise<{ uid: number; flags: Set<string> } | undefined> {
  return connection.withMailbox(DRAFTS, async (client: ImapFlow, status) => {
    if (status.messages === 0) return undefined
    // The same two-attempt lookup as everywhere else. A draft this server wrote
    // always carries proper brackets, but the identifier handed in comes from a
    // listing, and a listing is where the other spelling shows up.
    const uid = await findByMessageId(client, messageId)
    if (uid === undefined) return undefined
    const message = await client.fetchOne(String(uid), { flags: true }, { uid: true })
    return { uid, flags: message && message.flags ? message.flags : new Set<string>() }
  })
}

/** Writes a built message into Drafts and describes what was stored. */
async function store(connection: Connection, draft: Draft): Promise<DraftResult> {
  const raw = await buildMessage(draft, { keepBcc: true })
  const uid = await appendDraft(connection, raw)
  return {
    messageId: draft.messageId,
    subject: draft.subject,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    uid,
  }
}

/** Creates a draft from scratch. */
export async function createDraft(
  connection: Connection,
  readOnly: boolean,
  fromAddress: string,
  input: DraftInput,
): Promise<DraftResult> {
  assertWritable(readOnly, 'creating a draft')
  assertOneBody(input)

  const from = parseRecipient(fromAddress)
  const draft: Draft = {
    from,
    to: parseRecipients(input.to),
    cc: parseRecipients(input.cc),
    bcc: parseRecipients(input.bcc),
    subject: input.subject ?? '',
    // With markup, the text is the readable rendering of it rather than a
    // second version of the message. Anything that reads `text` then gets
    // something true, and nothing has to remember which field to look at.
    text: input.html !== undefined ? htmlToText(input.html) : (input.text ?? ''),
    messageId: mintMessageId(from.address),
    ...(input.html !== undefined ? { html: input.html } : {}),
  }

  const raw = await buildMessage(draft, { keepBcc: true })
  const uid = await appendDraft(connection, raw)
  return {
    messageId: draft.messageId,
    subject: draft.subject,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    uid,
  }
}

/**
 * Replaces a draft with a changed version.
 *
 * Fields that are not named are carried over, so changing a subject does not
 * silently drop the recipients. The new version keeps the same Message-ID, so
 * the identifier a caller already has stays valid.
 *
 * The new version is written before the old one is removed. If the removal
 * fails, the mailbox holds two versions, which is a nuisance; the other order
 * would risk holding none.
 */
export async function updateDraft(
  connection: Connection,
  readOnly: boolean,
  fromAddress: string,
  messageId: string,
  changes: DraftInput,
): Promise<DraftResult> {
  assertWritable(readOnly, 'changing a draft')
  assertOneBody(changes)

  const id = normaliseMessageId(messageId)
  const existing = await findDraft(connection, id)
  if (!existing) {
    throw new BridgeError(
      `No draft with the id ${id} is in "${DRAFTS}". Use list_drafts to see the drafts that are ` +
        'there. A draft that has been sent or moved is no longer a draft.',
    )
  }
  // The second guard. A message without the flag is not a draft, and this
  // function is about to delete whatever it was pointed at.
  if (!existing.flags.has('\\Draft')) {
    throw new BridgeError(
      `The message ${id} is in "${DRAFTS}" but does not carry the draft flag, so it is not treated ` +
        'as a draft. Refusing to replace it, because replacing means deleting the old version.',
    )
  }

  const current = await getMessage(connection, id, { hint: DRAFTS })
  const from = parseRecipient(fromAddress)

  const draft: Draft = {
    from,
    to: changes.to === undefined ? current.to : parseRecipients(changes.to),
    cc: changes.cc === undefined ? current.cc : parseRecipients(changes.cc),
    // Drafts are stored with the blind copies kept, so they can be carried
    // over here. A delivered message never carries them, which is why this is
    // only ever true for a draft this server wrote.
    bcc: changes.bcc === undefined ? current.bcc : parseRecipients(changes.bcc),
    subject: changes.subject === undefined ? current.subject : changes.subject,
    ...markupOf(changes, current),
    messageId: id,
  }

  const raw = await buildMessage(draft, { keepBcc: true })
  const uid = await appendDraft(connection, raw)

  await connection.withMailbox(DRAFTS, async (client, status) => {
    // Guarded again, in the line before the delete rather than twenty lines
    // above it. This is the line that removes a message.
    assertDraftMailbox(status.path)
    await client.messageDelete(String(existing.uid), { uid: true })
  })

  return {
    messageId: id,
    subject: draft.subject,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    uid,
  }
}

/**
 * Which body a changed draft ends up with.
 *
 * Giving markup replaces the whole body, and so does giving text: a draft that
 * was markup and is changed to text is now text. Naming neither carries over
 * what was there, markup included, which is what makes changing only the
 * subject of a formatted draft leave the formatting alone.
 */
function markupOf(
  changes: DraftInput,
  current: { text: string; html?: string },
): { text: string; html?: string } {
  if (changes.html !== undefined) return { text: htmlToText(changes.html), html: changes.html }
  if (changes.text !== undefined) return { text: changes.text }
  return current.html !== undefined
    ? { text: current.text, html: current.html }
    : { text: current.text }
}

/**
 * The body of a reply, with the original quoted below it.
 *
 * When the new part is markup, the quote is markup as well, and it is built
 * from the original's **text** rather than from its markup. The reasoning is in
 * quoteAsHtml, and it is worth repeating in one line here because it is the
 * question anyone will ask when they read this: carrying a stranger's markup
 * into a message sent under this account's name would mean either refusing to
 * reply to ordinary HTML mail, or forwarding links whose targets nobody wrote.
 */
function composeWithQuote(
  text: string,
  html: string | undefined,
  original: { from: Recipient[]; date: Date | undefined; subject: string; text: string; html?: string },
): { text: string; html?: string; quotedHtml?: string } {
  if (html === undefined) return { text: `${text}${quote(original)}` }
  const quoted = quoteAsHtml(original)
  return { text: htmlToText(html + quoted), html, quotedHtml: quoted }
}

/** The thread headers of a message, which a reply has to carry on. */
async function threadHeaders(
  connection: Connection,
  path: string,
  uid: number,
): Promise<{ messageId?: string; references: string[] }> {
  const raw = await connection.withMailbox(path, async (client) => {
    const message = await client.fetchOne(
      String(uid),
      { headers: ['message-id', 'references', 'in-reply-to'] },
      { uid: true },
    )
    return message && message.headers ? message.headers.toString('utf8') : ''
  })

  const value = (name: string): string | undefined => {
    // Headers may be folded over several lines, so continuation lines count.
    const match = new RegExp(`^${name}:([\\s\\S]*?)(?=\\r?\\n[^\\s]|$)`, 'im').exec(raw)
    return match ? match[1]!.replace(/\s+/g, ' ').trim() : undefined
  }

  const ids = (text: string | undefined): string[] =>
    text ? (text.match(/<[^<>\s]+>/g) ?? []) : []

  const own = ids(value('message-id'))[0]
  const chain = [...ids(value('references')), ...ids(value('in-reply-to'))]
  // Duplicates are common once In-Reply-To repeats the last entry of References.
  const references = [...new Set(chain)]
  return own ? { messageId: own, references } : { references }
}

/** Everything except our own address, so a reply does not go back to us. */
function withoutSelf(list: Recipient[], self: string): Recipient[] {
  const mine = self.toLowerCase()
  const seen = new Set<string>()
  return list.filter((r) => {
    const key = r.address.toLowerCase()
    if (key === mine || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Prepares a reply as a draft.
 *
 * The reference headers are the whole point of doing this in the server: a
 * reply without In-Reply-To and References is a new conversation that happens
 * to share a subject, and every mail reader will show it as one.
 */
export async function buildReplyDraft(
  connection: Connection,
  fromAddress: string,
  messageId: string,
  text: string,
  options: { all?: boolean; mailbox?: string; html?: string } = {},
): Promise<Draft> {
  const original = await getMessage(connection, messageId, {
    ...(options.mailbox ? { hint: options.mailbox } : {}),
  })
  const thread = await threadHeaders(connection, original.path, await uidOf(connection, original.path, original.messageId))

  const from = parseRecipient(fromAddress)
  // Reply-To wins over From. A sender who set it asked for answers elsewhere.
  const primary = original.replyTo.length ? original.replyTo : original.from
  const to = withoutSelf(primary, from.address)
  const cc = options.all
    ? withoutSelf(
        [...original.to, ...original.cc].filter(
          (r) => !to.some((t) => t.address.toLowerCase() === r.address.toLowerCase()),
        ),
        from.address,
      )
    : []

  if (to.length === 0 && cc.length === 0) {
    throw new BridgeError(
      'There is nobody to reply to: the only address on the message is your own. ' +
        'Use create_draft with an explicit recipient instead.',
    )
  }

  const body = composeWithQuote(text, options.html, original)
  const draft: Draft = {
    from,
    to,
    cc,
    bcc: [],
    subject: prefixSubject(original.subject, 'Re'),
    ...body,
    messageId: mintMessageId(from.address),
    ...(thread.messageId ? { inReplyTo: thread.messageId } : {}),
    references: [...thread.references, ...(thread.messageId ? [thread.messageId] : [])],
  }

  return draft
}

/** Prepares a reply and stores it as a draft. */
export async function replyDraft(
  connection: Connection,
  readOnly: boolean,
  fromAddress: string,
  messageId: string,
  text: string,
  options: { all?: boolean; mailbox?: string; html?: string } = {},
): Promise<DraftResult> {
  assertWritable(readOnly, 'creating a reply draft')
  const draft = await buildReplyDraft(connection, fromAddress, messageId, text, options)
  return store(connection, draft)
}

/** The uid of a message inside one mailbox. */
async function uidOf(connection: Connection, path: string, messageId: string): Promise<number> {
  const uid = await connection.withMailbox(path, async (client, status) => {
    if (status.messages === 0) return undefined
    const hits = await client.search({ header: { 'message-id': messageId } }, { uid: true })
    return Array.isArray(hits) && hits.length ? Math.max(...hits) : undefined
  })
  if (uid === undefined) {
    throw new BridgeError(`The message ${messageId} is no longer in "${path}".`)
  }
  return uid
}

/**
 * Prepares a forward as a draft.
 *
 * When the original carries attachments, the whole original message is attached
 * as `message/rfc822` rather than its parts being taken out and put back. That
 * keeps everything, needs nothing from the local disk, and cannot quietly lose
 * a file the way a re-encoded copy can.
 */
export async function buildForwardDraft(
  connection: Connection,
  fromAddress: string,
  messageId: string,
  to: string[],
  text: string,
  options: { mailbox?: string; html?: string } = {},
): Promise<Draft> {
  const original = await getMessage(connection, messageId, {
    ...(options.mailbox ? { hint: options.mailbox } : {}),
  })
  const from = parseRecipient(fromAddress)
  const recipients = parseRecipients(to)
  if (recipients.length === 0) {
    throw new BridgeError('A forward needs at least one recipient.')
  }

  const header = [
    '',
    '---------- Forwarded message ----------',
    `From: ${original.from.map((f) => (f.name ? `${f.name} <${f.address}>` : f.address)).join(', ')}`,
    `Date: ${original.date ? original.date.toISOString().slice(0, 16).replace('T', ' ') : 'unknown'}`,
    `Subject: ${original.subject || '(no subject)'}`,
    `To: ${original.to.map((t) => t.address).join(', ') || '(none)'}`,
    '',
  ].join('\n')

  const draft: Draft = {
    from,
    to: recipients,
    cc: [],
    bcc: [],
    subject: prefixSubject(original.subject, 'Fwd'),
    ...(options.html === undefined
      ? { text: `${text}\n${header}${original.text}` }
      : (() => {
          const head =
            `<p>---------- Forwarded message ----------<br>` +
            `From: ${escapeHtml(original.from.map((f) => (f.name ? `${f.name} <${f.address}>` : f.address)).join(', '))}<br>` +
            `Date: ${escapeHtml(original.date ? original.date.toISOString().slice(0, 16).replace('T', ' ') : 'unknown')}<br>` +
            `Subject: ${escapeHtml(original.subject || '(no subject)')}<br>` +
            `To: ${escapeHtml(original.to.map((t) => t.address).join(', ') || '(none)')}</p>`
          // The same preparation as a reply: the original as it was, minus what
          // would reach out of the quote.
          const quoted = head + quoteBody(original)
          return {
            text: htmlToText(options.html + quoted),
            html: options.html,
            quotedHtml: quoted,
          }
        })()),
    messageId: mintMessageId(from.address),
  }

  // Only when there is something a quoted body would lose.
  if (original.attachments.length > 0) {
    const uid = await uidOf(connection, original.path, original.messageId)
    const source = await connection.withMailbox(original.path, async (client) => {
      const message = await client.fetchOne(String(uid), { source: true }, { uid: true })
      return message && message.source ? message.source : undefined
    })
    if (source) {
      draft.attachedMessage = {
        filename: `${(original.subject || 'message').replace(/[^\w. -]/g, '_').slice(0, 60)}.eml`,
        raw: source,
      }
    }
  }

  return draft
}

/** Prepares a forward and stores it as a draft. */
export async function forwardDraft(
  connection: Connection,
  readOnly: boolean,
  fromAddress: string,
  messageId: string,
  to: string[],
  text: string,
  options: { mailbox?: string; html?: string } = {},
): Promise<DraftResult> {
  assertWritable(readOnly, 'creating a forward draft')
  const draft = await buildForwardDraft(connection, fromAddress, messageId, to, text, options)
  const stored = await store(connection, draft)
  return draft.attachedMessage
    ? { ...stored, carriedAttachments: [draft.attachedMessage.filename] }
    : stored
}

/** The drafts that are there. Reading only. */
export async function listDrafts(
  connection: Connection,
  options: { limit?: number; offset?: number } = {},
): Promise<ListResult> {
  return listMessages(connection, DRAFTS, {
    limit: options.limit ?? 25,
    offset: options.offset ?? 0,
    unreadOnly: false,
  })
}

/**
 * Reads a stored draft back as a message ready to be sent.
 *
 * Looked up in "Drafts" alone, and required to carry the draft flag: sending
 * whatever happens to be sitting there under a caller's chosen identifier is
 * not what a caller asking to send a draft means.
 *
 * The thread headers are not recovered, and cannot be. Proton replaces them
 * when it stores a draft, so a reply written as a draft and sent later goes out
 * with Proton's internal thread id rather than the chain it was built with.
 * send_reply exists precisely so that a reply need not take this route.
 */
export async function readDraftForSending(
  connection: Connection,
  fromAddress: string,
  messageId: string,
): Promise<Draft> {
  const id = normaliseMessageId(messageId)
  const existing = await findDraft(connection, id)
  if (!existing) {
    throw new BridgeError(
      `No draft with the id ${id} is in "${DRAFTS}". Use list_drafts to see what is there.`,
    )
  }
  if (!existing.flags.has('\\Draft')) {
    throw new BridgeError(
      `The message ${id} is in "${DRAFTS}" but does not carry the draft flag, so it is not a ` +
        'draft. Refusing to send it.',
    )
  }

  const stored = await getMessage(connection, id, { hint: DRAFTS })
  if (stored.to.length === 0 && stored.cc.length === 0 && stored.bcc.length === 0) {
    throw new BridgeError(
      `The draft ${id} has no recipient, so there is nobody to send it to. Add one with ` +
        'update_draft first.',
    )
  }

  return {
    from: parseRecipient(fromAddress),
    to: stored.to,
    cc: stored.cc,
    bcc: stored.bcc,
    subject: stored.subject,
    text: stored.text,
    messageId: id,
    // A draft written as markup is sent as the markup it was. Converting it to
    // text and back would deliver something its author never wrote.
    ...(stored.html !== undefined ? { html: stored.html } : {}),
  }
}
