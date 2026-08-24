/**
 * Tools: create_draft, update_draft, reply_draft, forward_draft, list_drafts.
 *
 * A draft is where a prepared message belongs. Nothing here sends, and nothing
 * here can: none of these functions knows the SMTP port exists. Sending is a
 * separate tool behind a confirmation the server enforces.
 *
 * That separation is the feature, not an implementation detail. A model that
 * has read a message written by a stranger can be talked into preparing a
 * reply; it must not be able to be talked into delivering one.
 */

import * as z from 'zod'
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
import type { Connection } from '../bridge/connection.js'
import {
  createDraft,
  updateDraft,
  replyDraft,
  forwardDraft,
  listDrafts,
  DRAFTS,
  type DraftResult,
} from '../mail/drafts.js'
import { describeRecipients, MARKUP_NOTE, PLAIN_TEXT_NOTE, UTF8_NOTE } from '../mail/compose.js'
import { BridgeError } from '../bridge/errors.js'
import { formatList } from './format.js'
import { describeFailure, withSignIn } from './failures.js'
import { track } from '../in-flight.js'

const ok = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] })

/** Written into every answer that created or changed a draft. */
function describeDraft(draft: DraftResult, what: string): string {
  const lines = [
    `${what} in "${DRAFTS}".`,
    '',
    `Subject: ${draft.subject || '(no subject)'}`,
    describeRecipients(draft),
    `Id: ${draft.messageId}`,
  ]
  if (draft.carriedAttachments?.length) {
    lines.push(
      '',
      `The original carried ${draft.carriedAttachments.length} attachment(s): ` +
        `${draft.carriedAttachments.join(', ')}. The whole original message is attached to the ` +
        'draft, so nothing of it is lost.',
    )
  }
  lines.push(
    '',
    'Nothing has been sent. Use send_draft when the message is ready; that asks the user to ' +
      'confirm before anything leaves the machine.',
  )
  return lines.join('\n')
}

const addressList = (what: string) =>
  z
    .array(z.string())
    .optional()
    .describe(`${what} Each entry is an address, optionally as "Display Name <name@example.com>".`)

const messageArgument = z
  .string()
  .describe('The message id from a listing or a search, with or without angle brackets.')

/**
 * Where the message comes from.
 *
 * A function, because nobody may be signed in yet when the tools are registered
 * and the address can change while the server runs.
 */
export type FromAddress = () => string | undefined

function requireFrom(from: FromAddress): string {
  const address = from()
  if (!address) {
    throw new BridgeError(
      'Nobody is signed in, so there is no address to write from. Sign in through the ' +
        'configuration page first.',
    )
  }
  return address
}

export function registerDraftTools(
  server: McpServer,
  connection: Connection,
  readOnly: () => boolean,
  from: FromAddress,
): void {
  server.registerTool(
    'create_draft',
    {
      title: 'Create a draft',
      description:
        'Writes a new draft into the Drafts mailbox. Nothing is sent. ' +
        'Attachments from files on this machine are not supported on purpose. ' +
        PLAIN_TEXT_NOTE + ' ' + MARKUP_NOTE + ' ' + UTF8_NOTE,
      inputSchema: z.object({
        to: addressList('The main recipients.'),
        cc: addressList('Recipients in copy, visible to everyone.'),
        bcc: addressList('Recipients in blind copy, hidden from the others but they do receive it.'),
        subject: z.string().optional().describe('The subject line.'),
        text: z.string().optional().describe('The body, as plain text.'),
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input, ctx) =>
      track(
        () =>
          withSignIn(ctx, async () => {
            try {
              const draft = await createDraft(connection, readOnly(), requireFrom(from), input)
              return ok(describeDraft(draft, 'Draft written'))
            } catch (error) {
              return describeFailure(error, 'creating the draft')
            }
          }),
        'create_draft',
      ),
  )

  server.registerTool(
    'update_draft',
    {
      title: 'Change a draft',
      description:
        'Replaces a draft with a changed version, keeping the same id. Fields that are not given ' +
        'are carried over, including the blind copies, which drafts written here keep. Only ' +
        'messages in the Drafts mailbox that carry the draft flag can be changed this way. ' +
        PLAIN_TEXT_NOTE + ' ' + MARKUP_NOTE + ' ' + UTF8_NOTE,
      inputSchema: z.object({
        messageId: messageArgument,
        to: addressList('Replaces the main recipients.'),
        cc: addressList('Replaces the copies.'),
        bcc: addressList('Replaces the blind copies.'),
        subject: z.string().optional().describe('Replaces the subject.'),
        text: z.string().optional().describe('Replaces the body.'),
        html: z
          .string()
          .optional()
          .describe(
            'Replaces the body with markup. Give this or text, not both. Permitted ' +
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ messageId, ...changes }, ctx) =>
      track(
        () =>
          withSignIn(ctx, async () => {
            try {
              const draft = await updateDraft(
                connection,
                readOnly(),
                requireFrom(from),
                messageId,
                changes,
              )
              return ok(describeDraft(draft, 'Draft replaced'))
            } catch (error) {
              return describeFailure(error, 'changing the draft')
            }
          }),
        'update_draft',
      ),
  )

  server.registerTool(
    'reply_draft',
    {
      title: 'Prepare a reply as a draft',
      description:
        'Writes a reply to a message as a draft. The recipient is the message\'s Reply-To if it ' +
        'set one, otherwise its sender. The original is quoted below the new text. Nothing is sent. ' +
        'Note on threading: the reply is built with In-Reply-To and References, but Proton replaces ' +
        'those with its own internal thread id when it stores a draft, so a draft that is stored ' +
        'and sent later carries Proton\'s idea of the conversation rather than ours. ' +
        PLAIN_TEXT_NOTE + ' ' + MARKUP_NOTE + ' ' + UTF8_NOTE,
      inputSchema: z.object({
        messageId: messageArgument,
        text: z.string().describe('The reply itself. The original is quoted below it.'),
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ messageId, text, replyAll, mailbox, html }, ctx) =>
      track(
        () =>
          withSignIn(ctx, async () => {
            try {
              const draft = await replyDraft(
                connection,
                readOnly(),
                requireFrom(from),
                messageId,
                text,
                { all: replyAll, ...(mailbox ? { mailbox } : {}), ...(html !== undefined ? { html } : {}) },
              )
              return ok(describeDraft(draft, 'Reply written'))
            } catch (error) {
              return describeFailure(error, 'preparing the reply')
            }
          }),
        'reply_draft',
      ),
  )

  server.registerTool(
    'forward_draft',
    {
      title: 'Prepare a forward as a draft',
      description:
        'Writes a forward of a message as a draft. The original is quoted below the new text, and ' +
        'when it carries attachments the whole original message is attached as well, so nothing of ' +
        'it is lost. Nothing is sent. ' +
        PLAIN_TEXT_NOTE + ' ' + MARKUP_NOTE + ' ' + UTF8_NOTE,
      inputSchema: z.object({
        messageId: messageArgument,
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ messageId, to, text, mailbox, html }, ctx) =>
      track(
        () =>
          withSignIn(ctx, async () => {
            try {
              const draft = await forwardDraft(
                connection,
                readOnly(),
                requireFrom(from),
                messageId,
                to,
                text,
                { ...(mailbox ? { mailbox } : {}), ...(html !== undefined ? { html } : {}) },
              )
              return ok(describeDraft(draft, 'Forward written'))
            } catch (error) {
              return describeFailure(error, 'preparing the forward')
            }
          }),
        'forward_draft',
      ),
  )

  server.registerTool(
    'list_drafts',
    {
      title: 'List drafts',
      description:
        'Lists the drafts, newest first. Headers only, like every listing here. Use get_message ' +
        'with an id to read one.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(25).describe('How many to return.'),
        offset: z.number().int().min(0).default(0).describe('How many to skip, for paging.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit, offset }, ctx) =>
      track(
        () =>
          withSignIn(ctx, async () => {
            try {
              return ok(formatList(await listDrafts(connection, { limit, offset })))
            } catch (error) {
              return describeFailure(error, 'listing the drafts')
            }
          }),
        'list_drafts',
      ),
  )
}
