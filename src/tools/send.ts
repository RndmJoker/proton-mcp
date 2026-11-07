/**
 * Tools: send_message, send_reply, send_forward, send_draft.
 *
 * All four go through one function, `confirmed`, and that is the point. Four
 * copies of a confirmation is four chances for one of them to drift, and the
 * one that drifts is the one that sends without asking.
 *
 * Why replying and forwarding are sending tools of their own, rather than
 * "make a draft, then send the draft": measured, Proton rewrites the thread
 * headers of anything it stores. A reply written to a draft and sent later
 * carries Proton's internal thread id and not the In-Reply-To and References
 * that were built. Building the reply and handing it to SMTP without storing it
 * in between is the only way the headers we wrote are the headers that go out.
 */

import * as z from 'zod'
import type { McpServer, CallToolResult, InputRequiredResult } from '@modelcontextprotocol/server'
import type { RequestStateCodec } from '@modelcontextprotocol/server'
import type { Connection } from '../bridge/connection.js'
import type { Config, BridgeCredentials } from '../config.js'
import { BridgeError } from '../bridge/errors.js'
import { htmlToText } from '../mime/parse.js'
import { sendMessage, type SendOutcome } from '../mail/send.js'
import {
  buildReplyDraft,
  buildForwardDraft,
  readDraftForSending,
  DRAFTS,
} from '../mail/drafts.js'
import {
  describeRecipients,
  mintMessageId,
  parseRecipient,
  parseRecipients,
  MARKUP_NOTE,
  PLAIN_TEXT_NOTE,
  UTF8_NOTE,
  type Draft,
} from '../mail/compose.js'
import {
  clientCanConfirm,
  confirmationAnswer,
  confirmationRequest,
  digestOf,
  pendingSend,
  refuse,
  type PendingSend,
} from './confirm.js'
import { holdForPreview, releasePreview } from './preview.js'
import { previewUrl } from './failures.js'
import { describeFailure, withSignIn } from './failures.js'
import { track } from '../in-flight.js'
import type { Permissions } from '../permissions.js'
import type { RecordCopy } from '../settings.js'
import { withRecord } from '../mail/record.js'

const ok = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] })

/**
 * Measured: SMTP accepted a message about six seconds before IMAP showed it,
 * and an appended message took about twenty seconds to reach "All Mail". A tool
 * that checked its own send would describe a state that is not the outcome.
 */
const AFTER_NOTE =
  'The Bridge has taken the message; Proton delivers it from there. It takes a moment to appear ' +
  'in Sent, so do not look for it straight away. An immediate listing would be misleading rather ' +
  'than informative.'

/**
 * What went out.
 *
 * Built from the draft rather than cut out of the confirmation text by line
 * number. The first version did the latter and lost the body: it printed "The
 * message begins:" followed by nothing, because a slice by index breaks the
 * moment the text it slices gains a line.
 */
function describeOutcome(draft: Draft, outcome: SendOutcome): string {
  const lines = [
    `Sent. The Bridge accepted the message for ${outcome.accepted.length} recipient(s).`,
    '',
    describeRecipients(draft),
    // The address is among the recipients above, and the assistant did not put
    // it there. Without this line it reads as a recipient that appeared from
    // nowhere, and a careful assistant would report it as a problem.
    ...(draft.record
      ? [
          `Added by the user's settings as a copy of everything sent: ${draft.record.address} ` +
            `(${draft.record.mode === 'cc' ? 'Cc' : 'Bcc'}). Not a mistake, and not yours to remove.`,
        ]
      : []),
    `Subject: ${draft.subject || '(no subject)'}`,
    ...(draft.attachedMessage ? [`Attached: ${draft.attachedMessage.filename}`] : []),
    `Id: ${outcome.messageId}`,
  ]
  if (outcome.rejected.length) {
    lines.push(
      '',
      `Refused for: ${outcome.rejected.join(', ')}. The message went to the others, so it was ` +
        'delivered in part rather than not at all.',
    )
  }
  lines.push('', AFTER_NOTE)
  return lines.join('\n')
}

export interface SendDependencies {
  config: Config
  connection: Connection
  getCredentials: () => Promise<BridgeCredentials | undefined>
  readOnly: () => boolean
  from: () => string | undefined
  /** Seals and opens the state that carries a confirmation across the round trip. */
  codec: RequestStateCodec<PendingSend>
  /**
   * What each sending tool may do. Absent means every one asks, which is the
   * behaviour before levels existed and the default with them.
   */
  permissions?: Permissions
  /** The recipient added to every message sent (#18), read at every send. */
  record?: () => RecordCopy | undefined
}

function requireFrom(deps: SendDependencies): string {
  const address = deps.from()
  if (!address) {
    throw new BridgeError(
      'Nobody is signed in, so there is no address to send from. Sign in through the ' +
        'configuration page first.',
    )
  }
  return address
}

/**
 * The whole confirmation flow, once.
 *
 * `build` produces the message from the call's arguments. It runs on both
 * rounds, and it has to: the second round recomputes the digest from what the
 * client is asking for now and compares it with what the user actually agreed
 * to. Building once and trusting the client to hand it back would be trusting
 * exactly the thing that needs checking.
 */
async function confirmed(
  deps: SendDependencies,
  ctx: unknown,
  tool: string,
  what: string,
  build: () => Promise<Draft>,
): Promise<CallToolResult | InputRequiredResult> {
  // Asked before anything else. A confirmation for a send that read-only would
  // refuse anyway is a question with no honest answer.
  if (deps.readOnly()) {
    return describeFailure(
      new BridgeError(
        'The server is running read-only, so sending is refused. This is set by ' +
          'PROTON_MCP_READ_ONLY and the web interface reports it as the current mode.',
      ),
      'sending',
    )
  }

  const level = deps.permissions?.level(tool) ?? 'ask'
  if (level === 'off') {
    // Taken out of the client's list already. A call that arrives anyway is
    // refused here, with the setting named, rather than trusted.
    return describeFailure(
      new BridgeError(
        `${tool} is switched off for assistants, ${deps.permissions?.where(tool) ?? 'by a setting'}. ` +
          'Tell the user; only they can switch it on.',
      ),
      'sending',
    )
  }

  // The configured copy goes in before the digest is taken, on both rounds, so
  // it is part of what is asked and part of what a yes is bound to.
  const draft = withRecord(await build(), deps.record?.())
  const digest = digestOf(draft)
  const pending = pendingSend(ctx)

  if (!pending) {
    // First round. A tool the user allowed to act on its own sends now, unless
    // a bound holds it back; then it asks like every other, and says why.
    let heldBack: string | undefined
    if (level === 'act' && deps.permissions) {
      // The copy the user configured is not held against the permitted list:
      // the user chose it, and it goes to every message anyway.
      const copy = draft.record?.address.toLowerCase()
      const recipients = [...draft.to, ...draft.cc, ...draft.bcc]
        .map((r) => r.address)
        .filter((address) => address.toLowerCase() !== copy)
      const hold = deps.permissions.holdBack(recipients)
      if (!hold) {
        const outcome = await sendMessage(deps.config, deps.getCredentials, deps.readOnly(), draft)
        deps.permissions.recordSent()
        return ok(
          `${describeOutcome(draft, outcome)}\n\nSent without asking: ${tool} is allowed to act on ` +
            `its own, ${deps.permissions.where(tool)}. Say so when reporting it to the user.`,
        )
      }
      heldBack = hold.reason
    }

    // Nothing is sent from here on in this round under any circumstances.
    if (!clientCanConfirm(ctx)) return refuse.noElicitation()
    const state = await deps.codec.mint({ tool, digest }, ctx as never)
    // Held so the interface can show the message while the question is open.
    // Memory only, and dropped the moment an answer arrives either way.
    holdForPreview(digest, draft, tool)
    return confirmationRequest(draft, what, state, previewUrl(digest), heldBack)
  }

  // Second round: an answer to a question is always taken as the answer, even
  // if the level changed meanwhile. A tool switched to act on its own between
  // the question and a "no" must not send what the person declined.
  //
  // The seal has already been verified by the SDK, so what is
  // left is whether it says the same thing this call is asking for.
  //
  // The preview is released before any of those checks, and before the send.
  // A refused confirmation has no more business staying readable than a
  // completed one, and an early return must not leave decrypted mail behind.
  releasePreview(digest)

  if (pending.tool !== tool) return refuse.wrongTool()
  if (pending.digest !== digest) return refuse.changed()
  if (confirmationAnswer(ctx) !== 'yes') return refuse.declined()

  const outcome = await sendMessage(deps.config, deps.getCredentials, deps.readOnly(), draft)
  return ok(describeOutcome(draft, outcome))
}

const addressList = (what: string) =>
  z
    .array(z.string())
    .optional()
    .describe(`${what} Each entry is an address, optionally as "Display Name <name@example.com>".`)

const CONFIRMATION_NOTE =
  'By default every send asks the user to confirm first, through the client, showing the ' +
  'sender, every recipient separated into To, Cc and Bcc, and the subject. It carries no part ' +
  'of the message itself and links to a page where the whole thing can be read as the recipient ' +
  'will see it, and a client that cannot show the question cannot send. The user can allow a ' +
  'tool to send without asking, within bounds they choose; the answer then says that it did.'

export function registerSendTools(server: McpServer, deps: SendDependencies): void {
  server.registerTool(
    'send_message',
    {
      title: 'Send a message',
      description: `Composes a message and sends it. ${CONFIRMATION_NOTE} ${PLAIN_TEXT_NOTE} ${MARKUP_NOTE} ${UTF8_NOTE}`,
      inputSchema: z.object({
        to: addressList('The main recipients.'),
        cc: addressList('Recipients in copy, visible to everyone.'),
        bcc: addressList('Recipients in blind copy. They receive it; the others do not see them.'),
        subject: z.string().default('').describe('The subject line.'),
        text: z.string().default('').describe('The body, as plain text.'),
        html: z
          .string()
          .optional()
          .describe(
            'The body as markup instead of plain text. Give this or text, not both. Permitted ' +
              'are headings, paragraphs, line breaks, rules, quotes, emphasis, lists, tables, ' +
              'links and images, with colour, font, alignment, spacing and borders. Images may ' +
              'point at a full address; anything outside the permitted set is refused with a ' +
              'reason rather than removed.',
          ),
        markupLevel: z
          .enum(['standard', 'extended'])
          .default('standard')
          .describe(
            'How much markup is permitted. "standard" covers ordinary formatted mail. ' +
              '"extended" permits every CSS property, including ones that can hide content, and ' +
              'makes the confirmation carry a warning telling the person to open the preview. ' +
              'Prefer "standard"; reach for "extended" only when asked for something that needs ' +
              'it, such as a button, which requires display:inline-block.',
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input, ctx) =>
      track(
        () =>
          withSignIn(ctx, async () => {
            try {
              return await confirmed(deps, ctx, 'send_message', 'This message', async () => {
                const from = parseRecipient(requireFrom(deps))
                if (input.html !== undefined && input.text) {
                  throw new BridgeError(
                    'Both a text and a markup body were given. A message carries one or the ' +
                      'other: Proton drops the text half of a message that has both, so the half ' +
                      'that was confirmed would never arrive. Give whichever one this message is.',
                  )
                }
                return {
                  from,
                  to: parseRecipients(input.to),
                  cc: parseRecipients(input.cc),
                  bcc: parseRecipients(input.bcc),
                  subject: input.subject,
                  // The readable rendering, so that everything downstream can
                  // read `text` and get something true.
                  text: input.html !== undefined ? htmlToText(input.html) : input.text,
                  messageId: mintMessageId(from.address),
                  ...(input.html !== undefined
                    ? { html: input.html, markupLevel: input.markupLevel }
                    : {}),
                }
              })
            } catch (error) {
              return describeFailure(error, 'sending the message')
            }
          }),
        'send_message',
      ),
  )

  server.registerTool(
    'send_reply',
    {
      title: 'Reply to a message',
      description:
        'Replies to a message and sends the reply, with the reference headers that put it in the ' +
        'same conversation. Unlike a reply written as a draft, this one keeps those headers: ' +
        'Proton rewrites them for anything it stores, and this is never stored before it goes. ' +
        `${CONFIRMATION_NOTE} ${PLAIN_TEXT_NOTE} ${MARKUP_NOTE} ${UTF8_NOTE}`,
      inputSchema: z.object({
        messageId: z.string().describe('The message being replied to.'),
        text: z.string().describe('The reply. The original is quoted below it.'),
        replyAll: z
          .boolean()
          .default(false)
          .describe('When true, the other recipients of the original are put in copy.'),
        html: z
          .string()
          .optional()
          .describe(
            'Your part of the message as markup instead of plain text. The original is quoted ' +
              'below it either way. The quote keeps the original\'s own markup, character for ' +
              'character, minus what would reach out of it: style blocks, document-level ' +
              'elements, scripts and comments. A message this server would not itself compose ' +
              'can therefore still be replied to or forwarded, but its formatting travels ' +
              'along, and so does anything a link in it points at.',
          ),
        markupLevel: z
          .enum(['standard', 'extended'])
          .default('standard')
          .describe(
            'How much markup is permitted. "standard" covers ordinary formatted mail. ' +
              '"extended" permits every CSS property, including ones that can hide content, and ' +
              'makes the confirmation carry a warning telling the person to open the preview. ' +
              'Prefer "standard"; reach for "extended" only when asked for something that needs ' +
              'it, such as a button, which requires display:inline-block.',
          ),
        mailbox: z.string().optional().describe('The mailbox the original is in, if known.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ messageId, text, replyAll, mailbox, html, markupLevel }, ctx) =>
      track(
        () =>
          withSignIn(ctx, async () => {
            try {
              return await confirmed(deps, ctx, 'send_reply', 'This reply', () =>
                buildReplyDraft(deps.connection, requireFrom(deps), messageId, text, {
                  all: replyAll,
                  ...(mailbox ? { mailbox } : {}),
                  ...(html !== undefined ? { html } : {}),
                  ...(markupLevel !== undefined ? { markupLevel } : {}),
                }),
              )
            } catch (error) {
              return describeFailure(error, 'sending the reply')
            }
          }),
        'send_reply',
      ),
  )

  server.registerTool(
    'send_forward',
    {
      title: 'Forward a message',
      description:
        'Forwards a message and sends it. The original is quoted, and when it carries attachments ' +
        `the whole original travels along so nothing of it is lost. ${CONFIRMATION_NOTE} ${PLAIN_TEXT_NOTE} ${MARKUP_NOTE} ${UTF8_NOTE}`,
      inputSchema: z.object({
        messageId: z.string().describe('The message being forwarded.'),
        to: z.array(z.string()).min(1).describe('Who to forward it to.'),
        text: z.string().default('').describe('Anything to say above the forwarded message.'),
        html: z
          .string()
          .optional()
          .describe(
            'Your part of the message as markup instead of plain text. The original is quoted ' +
              'below it either way. The quote keeps the original\'s own markup, character for ' +
              'character, minus what would reach out of it: style blocks, document-level ' +
              'elements, scripts and comments. A message this server would not itself compose ' +
              'can therefore still be replied to or forwarded, but its formatting travels ' +
              'along, and so does anything a link in it points at.',
          ),
        markupLevel: z
          .enum(['standard', 'extended'])
          .default('standard')
          .describe(
            'How much markup is permitted. "standard" covers ordinary formatted mail. ' +
              '"extended" permits every CSS property, including ones that can hide content, and ' +
              'makes the confirmation carry a warning telling the person to open the preview. ' +
              'Prefer "standard"; reach for "extended" only when asked for something that needs ' +
              'it, such as a button, which requires display:inline-block.',
          ),
        mailbox: z.string().optional().describe('The mailbox the original is in, if known.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ messageId, to, text, mailbox, html, markupLevel }, ctx) =>
      track(
        () =>
          withSignIn(ctx, async () => {
            try {
              return await confirmed(deps, ctx, 'send_forward', 'This forward', () =>
                buildForwardDraft(
                  deps.connection,
                  requireFrom(deps),
                  messageId,
                  to,
                  text,
                  {
                    ...(mailbox ? { mailbox } : {}),
                    ...(html !== undefined ? { html } : {}),
                    ...(markupLevel !== undefined ? { markupLevel } : {}),
                  },
                ),
              )
            } catch (error) {
              return describeFailure(error, 'sending the forward')
            }
          }),
        'send_forward',
      ),
  )

  server.registerTool(
    'send_draft',
    {
      title: 'Send a draft',
      description:
        `Sends a draft that is already in "${DRAFTS}", exactly as it was stored, its files ` +
        'included. Its markup is not checked against the levels again, because it was when the ' +
        'draft was written; the confirmation warns when it carries more than standard. ' +
        'The draft is not removed afterwards: this ' +
        'server does not follow a send it deliberately does not verify with a second write. ' +
        'Use trash_messages on the draft once the message shows up in Sent. ' +
        `${CONFIRMATION_NOTE}`,
      inputSchema: z.object({
        messageId: z.string().describe('The id of the draft, from list_drafts or create_draft.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ messageId }, ctx) =>
      track(
        () =>
          withSignIn(ctx, async () => {
            try {
              return await confirmed(deps, ctx, 'send_draft', 'This draft', () =>
                readDraftForSending(deps.connection, requireFrom(deps), messageId),
              )
            } catch (error) {
              return describeFailure(error, 'sending the draft')
            }
          }),
        'send_draft',
      ),
  )
}
