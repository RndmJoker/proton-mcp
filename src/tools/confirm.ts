/**
 * The confirmation that stands between a model and the outside world.
 *
 * The project's central rule is that a boundary living in a system prompt is
 * not a boundary. Mail is text written by strangers, handed to a model that can
 * call tools, so a prepared message can ask for itself to be forwarded. The
 * answer is a round trip through the protocol that the server, not the prompt,
 * insists on.
 *
 * Three properties make it worth more than a formality:
 *
 * 1. **It fails closed.** A client that cannot show a form does not get to
 *    send. There is no fallback that goes ahead without a yes, and no setting
 *    that turns the question off. That is a deliberate difference from the
 *    sign-in prompt, where a client that cannot elicit gets a text answer: the
 *    worst outcome there is an inconvenience, and here it is a message that
 *    cannot be recalled.
 * 2. **The yes is bound to one specific message.** A digest of the recipients,
 *    the subject and the body is sealed into `requestState`, which travels
 *    through the client and comes back. On the second round the digest is
 *    recomputed from what the client now asks for and compared. If it differs,
 *    nothing is sent: what was confirmed is not what was requested. The seal is
 *    an HMAC, so the client cannot mint or alter one, and it is bound to the
 *    tool so a confirmation for one cannot be replayed at another.
 * 3. **The question shows what actually goes out.** Recipients separated into
 *    To, Cc and Bcc, the subject, and the first lines of the body, all derived
 *    from the same object the digest covers and the sender builds from.
 *
 * ## Why this is a returned value rather than a call
 *
 * The same reason as the sign-in prompt, and it is written out in
 * sign-in-required.ts: protocol revision 2026-07-28 has no server-to-client
 * request channel, so `elicitInput` throws on every request this server will
 * serve. The handler returns `inputRequired(...)` instead and the client calls
 * the tool again.
 */

import { createHash } from 'node:crypto'
import { inputRequired, acceptedContent } from '@modelcontextprotocol/server'
import type { CallToolResult, InputRequiredResult } from '@modelcontextprotocol/server'
import {
  describeAttachments,
  describeRecipients,
  describeUrls,
  fingerprintPart,
  firstLines,
  hiddenTextOf,
  composedBody,
  showRecipient,
  summariseQuote,
  type Draft,
} from '../mail/compose.js'
import { canElicitForm } from './capabilities.js'

/** The key our embedded elicitation is filed under. */
export const CONFIRM_KEY = 'protonMcpSendConfirmation'

/** What travels through the client and comes back, sealed. */
export interface PendingSend {
  /** Which tool asked. A confirmation for one must not work for another. */
  tool: string
  /** Covers exactly what the user was shown. */
  digest: string
}

/** The parts of the tool context this module reads. */
interface ConfirmContext {
  mcpReq?: {
    inputResponses?: Record<string, unknown>
    requestState?: <T>() => T | undefined
  }
}

/**
 * A fingerprint of everything that would leave the machine.
 *
 * Every field a recipient would see, and nothing else: two calls that differ
 * only in which mailbox a draft was looked up in describe the same message and
 * must not be told apart, while a changed address must be.
 */
export function digestOf(draft: Draft): string {
  const canonical = JSON.stringify({
    from: draft.from.address,
    to: draft.to.map((r) => r.address).sort(),
    cc: draft.cc.map((r) => r.address).sort(),
    bcc: draft.bcc.map((r) => r.address).sort(),
    subject: draft.subject,
    text: draft.text,
    // The markup source, not the readable rendering of it. Two messages can
    // read identically and differ in every link target, which is the whole
    // reason formatted mail needs a confirmation at all.
    html: draft.html ?? null,
    // The quote is part of what goes out, so it is part of what was agreed to.
    quoted: draft.quotedHtml ?? null,
    inReplyTo: draft.inReplyTo ?? null,
    attached: draft.attachedMessage?.filename ?? null,
    // The contents of every carried file, not just its name. A confirmation
    // that covered the name alone would let the picture be swapped after it
    // was agreed to.
    parts: (draft.inlineParts ?? [])
      .map((part) => `${part.contentId}:${part.contentType}:${fingerprintPart(part.content)}`)
      .sort(),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Whether the client said it can show a form.
 *
 * Asked rather than attempted, because an embedded request the client never
 * declared is refused by the SDK after the handler has already returned. The
 * caller would then get that refusal instead of a question, and the tool would
 * have to decide what to do about a confirmation that never appeared. Better to
 * know beforehand and refuse plainly.
 *
 * Where the declaration is read from is capabilities.ts, and it is worth
 * following that link once: reading it from the wrong place is what made every
 * send refuse in v0.4.0.
 */
export function clientCanConfirm(ctx: unknown): boolean {
  return canElicitForm(ctx)
}

/**
 * What the person being asked is shown.
 *
 * Short on purpose, and that is a correction rather than a compromise.
 *
 * It used to carry the excerpt, every address in full over two lines, every
 * alt text and every attachment. Measured: 11 lines for a plain text message,
 * 24 for a formatted one, **74 for a newsletter-shaped one**. Past a certain
 * length the client's dialog could not be answered at all, because the button
 * sat below the bottom of the window. A confirmation that cannot be answered
 * does not protect anything; it stops the tool working, and the length was the
 * cause.
 *
 * The correction is not to show less. It is to show it somewhere with room.
 * The evidence moved to a page in the local interface, and what is left here is
 * what somebody needs in order to decide whether to go and look:
 *
 * - **Every recipient, never shortened.** This is the one thing that cannot be
 *   summarised. Seeing three of eight means agreeing to a send to five
 *   strangers, and an address nobody expects is exactly what would be hidden in
 *   the part that got cut. They go on one line each for To, Cc and Bcc rather
 *   than one line per address, which costs two or three lines, not thirty.
 * - **The subject**, because it is how a person recognises which message this
 *   is at all.
 * - **Where to read the rest**, and a plain statement that this is where the
 *   addresses are.
 *
 * No body, no links, no alt texts. Not because they stopped mattering: because
 * a wall of them is how the answer became unreachable, and half a wall read
 * halfway is worse than a sentence that says where to look.
 */
export function describeForConfirmation(draft: Draft, what: string, previewUrl?: string): string {
  const lines = [
    `${what} would be sent from ${showRecipient(draft.from)}.`,
    '',
    describeRecipients(draft),
    `Subject: ${draft.subject || '(no subject)'}`,
  ]

  const counts = countsFor(draft)
  if (counts) lines.push('', counts)

  if (previewUrl) {
    lines.push(
      '',
      'Read it as the recipient will see it, with every address in full:',
      `  ${previewUrl}`,
    )
  } else {
    // No interface running. Saying so is the honest move: the question is
    // being asked with less behind it than usual, and a person should know
    // that before answering it.
    lines.push(
      '',
      'The configuration interface is not running, so the message cannot be shown in full.',
    )
  }

  lines.push('', 'Sending cannot be undone. Confirm only if these recipients are the ones you meant.')
  return lines.join('\n')
}

/**
 * One line saying what the message carries.
 *
 * Counts rather than contents. It exists so that the question is not silent
 * about a message being more than it looks: eighteen links and a carried file
 * are worth knowing about before deciding whether to open the preview at all.
 */
function countsFor(draft: Draft): string | undefined {
  const urls = describeUrls(draft)
  const hidden = hiddenTextOf(draft)
  const files = describeAttachments(draft)
  const quoted = summariseQuote(draft)

  const parts: string[] = []
  if (urls.length) parts.push(`${urls.length} address(es)`)
  if (hidden.length) parts.push(`${hidden.length} piece(s) of text the body does not show`)
  if (files.length) parts.push(`${files.length} carried file(s)`)
  if (quoted) parts.push('a quoted message')

  if (!parts.length) return undefined
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `It carries ${list}.`
}

/** The question, returned from the handler rather than pushed to the client. */
export function confirmationRequest(
  draft: Draft,
  what: string,
  requestState: string,
  previewUrl?: string,
): InputRequiredResult {
  return inputRequired({
    requestState,
    inputRequests: {
      [CONFIRM_KEY]: inputRequired.elicit({
        message: describeForConfirmation(draft, what, previewUrl),
        requestedSchema: {
          type: 'object',
          properties: {
            confirm: {
              type: 'boolean',
              title: 'Send this message',
              description: previewUrl
                ? 'Tick only after reading it at the address above.'
                : 'Tick only if the recipients above are the ones you meant.',
            },
          },
          required: ['confirm'],
        },
      }),
    },
  })
}

/** What the client sent back, if anything. */
export function confirmationAnswer(ctx: unknown): 'missing' | 'yes' | 'no' {
  const responses = (ctx as ConfirmContext)?.mcpReq?.inputResponses
  if (!responses) return 'missing'
  const content = acceptedContent<{ confirm?: unknown }>(responses, CONFIRM_KEY)
  // Absent means declined, cancelled, or a response of another kind. Anything
  // that is not an explicit true is a no, including a missing field: this is
  // the one place where being generous would mean sending mail nobody asked for.
  if (content === undefined) return 'no'
  return content.confirm === true ? 'yes' : 'no'
}

/** The sealed state from a previous round, already verified by the SDK. */
export function pendingSend(ctx: unknown): PendingSend | undefined {
  const accessor = (ctx as ConfirmContext)?.mcpReq?.requestState
  if (typeof accessor !== 'function') return undefined
  const state = accessor<PendingSend>()
  if (!state || typeof state !== 'object') return undefined
  return typeof state.tool === 'string' && typeof state.digest === 'string' ? state : undefined
}

const failure = (text: string): CallToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
})

/** Refusals, in one place so they read the same wherever they come from. */
export const refuse = {
  noElicitation: (): CallToolResult =>
    failure(
      'This client cannot show a confirmation, so nothing was sent.\n\n' +
        'Every message this server sends has to be confirmed by a person through the protocol\'s ' +
        'elicitation mechanism, and a client that does not support it cannot be asked. There is no ' +
        'setting that turns the confirmation off: mail cannot be recalled, and a model reading a ' +
        'message written by a stranger is exactly the situation this guards against.\n\n' +
        'Write the message as a draft instead, with create_draft or reply_draft, and send it from ' +
        'Proton itself.',
    ),
  declined: (): CallToolResult =>
    failure('The user did not confirm, so nothing was sent. The message was not changed.'),
  changed: (): CallToolResult =>
    failure(
      'Nothing was sent: the message is not the one that was confirmed.\n\n' +
        'The confirmation is bound to the exact recipients, subject and text that were shown. ' +
        'Something differs now, so the yes does not apply. Ask again with the message as it should ' +
        'go out, and the user will see what they are agreeing to.',
    ),
  wrongTool: (): CallToolResult =>
    failure(
      'Nothing was sent: the confirmation belongs to a different operation and cannot be reused ' +
        'for this one.',
    ),
}
