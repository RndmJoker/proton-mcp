/**
 * The reading tools: list_messages, get_message, get_attachment.
 *
 * All three are read-only. Every one of them goes through track() so that a
 * shutdown waits for the answer instead of cutting it off.
 */

import * as z from 'zod'
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
import type { Connection } from '../bridge/connection.js'
import { describeFailure, withSignIn } from './failures.js'
import { track } from '../in-flight.js'
import { listMessages, getMessage, MAX_LIST_LIMIT } from '../mail/messages.js'
import { getAttachment } from '../mail/attachments.js'
import { searchMessages, type SearchOptions } from '../mail/search.js'
import { ALL_MAIL } from '../mail/ids.js'
import { formatList, formatMessage, formatSearch, formatSize, wrapUntrusted } from './format.js'

const asError = describeFailure

const ok = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] })

export function registerMessageTools(server: McpServer, connection: Connection): void {
  server.registerTool(
    'list_messages',
    {
      title: 'List messages',
      description:
        'Lists the messages of a mailbox, newest first. Returns headers only: sender, subject, date, ' +
        'size and the message id. It never returns message bodies, because a single message averages ' +
        'around 16000 tokens raw. Use get_message with an id to read one.',
      inputSchema: z.object({
        mailbox: z
          .string()
          .default('INBOX')
          .describe(
            'The mailbox path, for example "INBOX", "Archive" or "Folders/Work". Use list_folders to see them.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIST_LIMIT)
          .default(25)
          .describe(`How many messages to return, at most ${MAX_LIST_LIMIT}.`),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe('How many of the newest messages to skip. Used for paging.'),
        unreadOnly: z.boolean().default(false).describe('When true, only unread messages are listed.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ mailbox, limit, offset, unreadOnly }, ctx) =>
      track(() =>
        withSignIn(ctx, async () => {
          try {
          const result = await listMessages(connection, mailbox, { limit, offset, unreadOnly })
          return ok(formatList(result))
          } catch (error) {
            return asError(error, `listing "${mailbox}"`)
          }
        }),
        'list_messages',
      ),
  )

  server.registerTool(
    'search_messages',
    {
      title: 'Search messages',
      description:
        'Searches a mailbox by text, subject, sender, recipient, date range, read state, star or size. ' +
        'At least one criterion is required. Returns headers only, newest first, with paging. ' +
        'A full-text search walks the local database of the Bridge and takes a few seconds on a large ' +
        'mailbox, while criteria such as unread or date are fast. Searching "All Mail" covers every ' +
        'mailbox including trash.',
      inputSchema: z.object({
        mailbox: z
          .string()
          .default(ALL_MAIL)
          .describe(`Which mailbox to search. Defaults to "${ALL_MAIL}", which holds every message.`),
        text: z
          .string()
          .optional()
          .describe('Free text, matched against body and headers. This is the slow criterion.'),
        subject: z.string().optional().describe('Substring of the subject.'),
        from: z.string().optional().describe('Substring of the sender address or display name.'),
        to: z.string().optional().describe('Substring of a recipient address.'),
        since: z
          .string()
          .optional()
          .describe('Only messages on or after this date, as YYYY-MM-DD.'),
        before: z.string().optional().describe('Only messages before this date, as YYYY-MM-DD.'),
        unreadOnly: z.boolean().optional().describe('When true, only unread messages.'),
        starredOnly: z.boolean().optional().describe('When true, only starred messages.'),
        largerThan: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Minimum size in bytes. Useful for finding messages with large attachments.'),
        limit: z.number().int().min(1).max(MAX_LIST_LIMIT).default(25).describe('How many results to return.'),
        offset: z.number().int().min(0).default(0).describe('How many results to skip, for paging.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, ctx) =>
      track(() =>
        withSignIn(ctx, async () => {
          try {
          const criteria: SearchOptions = { limit: args.limit, offset: args.offset }
          if (args.text) criteria.text = args.text
          if (args.subject) criteria.subject = args.subject
          if (args.from) criteria.from = args.from
          if (args.to) criteria.to = args.to
          if (args.unreadOnly !== undefined) criteria.seen = !args.unreadOnly
          if (args.starredOnly !== undefined) criteria.flagged = args.starredOnly
          if (args.largerThan !== undefined) criteria.largerThan = args.largerThan

          for (const [name, value] of [
            ['since', args.since],
            ['before', args.before],
          ] as const) {
            if (!value) continue
            const parsed = new Date(value)
            if (Number.isNaN(parsed.getTime())) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `"${value}" is not a usable date for ${name}. Expected YYYY-MM-DD.`,
                  },
                ],
                isError: true,
              }
            }
            criteria[name] = parsed
          }

          const result = await searchMessages(connection, args.mailbox, criteria)
          return ok(formatSearch(result))
          } catch (error) {
            return asError(error, `searching "${args.mailbox}"`)
          }
        }),
        'search_messages',
      ),
  )

  server.registerTool(
    'get_message',
    {
      title: 'Read a message',
      description:
        'Reads one message by its id and returns it as readable text. HTML is converted to text, ' +
        'images and styling are dropped and no external content is fetched. Long bodies are shortened ' +
        'with a visible note. The body is marked as untrusted third-party content.',
      inputSchema: z.object({
        messageId: z
          .string()
          .describe('The message id from list_messages or search, passed on unchanged.'),
        mailbox: z
          .string()
          .optional()
          .describe(
            'Optional: the mailbox to look in first. Saves a lookup. Without it the search goes through "All Mail".',
          ),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(200_000)
          .optional()
          .describe('Optional character budget for the body. Higher values cost context.'),
        textOffset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Where to continue reading a long message. The answer names the next offset when ' +
              'something was left out, so a long message can be read in parts instead of raising ' +
              'the budget until it fits.',
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ messageId, mailbox, maxChars, textOffset }, ctx) =>
      track(() =>
        withSignIn(ctx, async () => {
          try {
          const options: { hint?: string; maxTextChars?: number; textOffset?: number } = {}
          if (mailbox) options.hint = mailbox
          if (maxChars) options.maxTextChars = maxChars
          if (textOffset) options.textOffset = textOffset
          const message = await getMessage(connection, messageId, options)
          return ok(formatMessage(message))
          } catch (error) {
            return asError(error, 'reading the message')
          }
        }),
        'get_message',
      ),
  )

  server.registerTool(
    'get_attachment',
    {
      title: 'Read an attachment',
      description:
        'Reads one attachment of a message by index. The index comes from the attachment list in ' +
        'get_message. Textual attachments are returned as text, binary ones are refused with a reason ' +
        'rather than dumped into the context.',
      inputSchema: z.object({
        messageId: z.string().describe('The message id the attachment belongs to.'),
        index: z
          .number()
          .int()
          .min(0)
          .describe('Index of the attachment, as shown by get_message. Starts at 0.'),
        mailbox: z.string().optional().describe('Optional: the mailbox to look in first.'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Where to continue reading a long attachment. The answer names the next offset.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ messageId, index, mailbox, offset }, ctx) =>
      track(() =>
        withSignIn(ctx, async () => {
          try {
          const options: { hint?: string; offset?: number } = {}
          if (mailbox) options.hint = mailbox
          if (offset) options.offset = offset
          const a = await getAttachment(connection, messageId, index, options)

          const head = `Attachment "${a.filename}" (${a.contentType}, ${formatSize(a.size)})`
          if (a.unsupportedReason) {
            return ok(`${head}\n\n${a.unsupportedReason}`)
          }
          return ok(wrapUntrusted(a.text ?? '', head))
          } catch (error) {
            return asError(error, 'reading the attachment')
          }
        }),
        'get_attachment',
      ),
  )
}
