/**
 * Tools: move_messages, set_flags, trash_messages.
 *
 * The everyday tidying actions. They change where a message sits and how it is
 * marked, never what it says and never who has seen it, so none of them is put
 * behind a confirmation. The confirmation requirement belongs to sending, where
 * a wrong decision cannot be taken back.
 *
 * Two properties are worth stating here rather than leaving to the reader:
 *
 * - **Nothing in this file deletes.** "Delete" means moving to the trash, which
 *   Proton keeps and which "All Mail" still lists. A tool that emptied the trash
 *   would turn a model's mistake into a permanent one.
 * - **Nothing reports a result it has not established.** A move takes about
 *   fifteen seconds to settle and shows the message in both places meanwhile, so
 *   the answers say what was asked for and warn against checking immediately.
 *   Flags are the exception and get no such warning: measured, they hold at once.
 */

import * as z from 'zod'
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
import type { Connection } from '../bridge/connection.js'
import { moveMessages, setFlags, trashMessages, MAX_BATCH, TRASH } from '../mail/actions.js'
import { formatBatch } from './format.js'
import { describeFailure, withSignIn } from './failures.js'
import { track } from '../in-flight.js'

const ok = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] })

/**
 * Appended to every answer that moved something.
 *
 * Measured: a move needs roughly fifteen seconds to settle, and during that
 * window the Bridge lists the message in the old place as well as the new one. A
 * model that checks its own work straight away reads that intermediate state and
 * reports it as the outcome.
 */
const SETTLE_NOTE =
  'The Bridge needs about fifteen seconds to reconcile a move with Proton, and until then it lists ' +
  'the message in both the old and the new mailbox. Do not check the result immediately; an ' +
  'immediate listing would be misleading rather than informative.'

const messageIds = z
  .array(z.string())
  .min(1)
  .max(MAX_BATCH)
  .describe(
    `The message ids, as they came from a listing or a search. At most ${MAX_BATCH} per call.`,
  )

const mailboxHint = z
  .string()
  .optional()
  .describe(
    'The mailbox the messages are in, if they share one. Only a shortcut: without it every ' +
      'message is looked for across the mailboxes it could be in, which costs a request each.',
  )

export function registerActionTools(
  server: McpServer,
  connection: Connection,
  readOnly: () => boolean,
): void {
  server.registerTool(
    'move_messages',
    {
      title: 'Move messages to a folder',
      description:
        'Moves messages into a folder. In Proton a message lives in exactly one folder, so this ' +
        'takes it out of the one it is in. Labels are not affected and survive the move. ' +
        'Only folders are valid destinations: moving into a label would apply the label and leave ' +
        'the message where it is, so a label is refused here and add_label does that job. ' +
        'The destination has to exist; this server does not create folders.',
      inputSchema: z.object({
        messageIds,
        target: z
          .string()
          .describe(
            'The destination folder, for example "Archive" or "Folders/Work". Use list_folders to ' +
              'see the paths. Note that Proton fills the inbox through delivery: a message moved ' +
              'to "INBOX" over IMAP was measured to end up elsewhere shortly afterwards.',
          ),
        mailbox: mailboxHint,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ messageIds: ids, target, mailbox }, ctx) =>
      track(
        () =>
          withSignIn(ctx, async () => {
            try {
              const result = await moveMessages(connection, readOnly(), ids, target, mailbox)
              return ok(
                `${formatBatch(result, `Moved into "${result.target}":`)}\n\n${SETTLE_NOTE}`,
              )
            } catch (error) {
              return describeFailure(error, `moving messages to "${target}"`)
            }
          }),
        'move_messages',
      ),
  )

  server.registerTool(
    'set_flags',
    {
      title: 'Set read state and star',
      description:
        'Marks messages as read or unread and sets or clears the star. At least one of the two has ' +
        'to be given. This changes nothing about where a message sits and nothing about its ' +
        'content. Proton shows the star as the "Starred" mailbox.',
      inputSchema: z.object({
        messageIds,
        read: z
          .boolean()
          .optional()
          .describe('True marks the messages as read, false as unread. Omit to leave it alone.'),
        starred: z
          .boolean()
          .optional()
          .describe('True stars the messages, false removes the star. Omit to leave it alone.'),
        mailbox: mailboxHint,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ messageIds: ids, read, starred, mailbox }, ctx) =>
      track(
        () =>
          withSignIn(ctx, async () => {
            try {
              const changes: { read?: boolean; starred?: boolean } = {}
              if (read !== undefined) changes.read = read
              if (starred !== undefined) changes.starred = starred
              const result = await setFlags(connection, readOnly(), ids, changes, mailbox)

              const what = [
                read === undefined ? undefined : read ? 'read' : 'unread',
                starred === undefined ? undefined : starred ? 'starred' : 'not starred',
              ]
                .filter(Boolean)
                .join(' and ')
              // No settling note here: measured, flags are correct immediately
              // and unchanged twenty seconds later.
              return ok(formatBatch(result, `Set to ${what} for`))
            } catch (error) {
              return describeFailure(error, 'changing the read state or the star')
            }
          }),
        'set_flags',
      ),
  )

  server.registerTool(
    'trash_messages',
    {
      title: 'Move messages to the trash',
      description:
        'Moves messages to the trash. This is what deletion means here: the messages stay in ' +
        `"${TRASH}" and in "All Mail" and can be moved back out with move_messages. ` +
        'There is no tool in this server that deletes a message for good or empties the trash, ' +
        'so that a wrong decision stays reversible.',
      inputSchema: z.object({ messageIds, mailbox: mailboxHint }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ messageIds: ids, mailbox }, ctx) =>
      track(
        () =>
          withSignIn(ctx, async () => {
            try {
              const result = await trashMessages(connection, readOnly(), ids, mailbox)
              return ok(
                `${formatBatch(result, `Moved to "${TRASH}":`)}\n\n` +
                  'Nothing was deleted for good. The messages can be moved back out of the trash. ' +
                  SETTLE_NOTE,
              )
            } catch (error) {
              return describeFailure(error, 'moving messages to the trash')
            }
          }),
        'trash_messages',
      ),
  )
}
