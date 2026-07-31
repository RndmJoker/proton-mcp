/**
 * Tools: add_label, remove_label
 *
 * The first tools that change anything. Two properties matter more than the
 * feature itself:
 *
 * - They honour the read-only mode. Until now `PROTON_MCP_READ_ONLY` was a
 *   setting the web interface displayed and nothing enforced, because there was
 *   nothing to prevent. From here on the display has to be true.
 * - They never report success they have not established. A copy into a label
 *   that does not exist is accepted by the Bridge and changes nothing, so the
 *   label is checked beforehand, and the answer says what was asked for rather
 *   than claiming a verified outcome.
 *
 * Labelling is not put behind a confirmation. It changes no content, sends
 * nothing outside, and is undone by the opposite call. The confirmation
 * requirement belongs to sending, where a wrong decision cannot be taken back.
 */

import * as z from 'zod'
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
import type { Connection } from '../bridge/connection.js'
import { addLabel, removeLabel, LABEL_PREFIX } from '../mail/labels.js'
import { describeFailure, withSignIn } from './failures.js'
import { track } from '../in-flight.js'

const ok = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] })

/**
 * Written into both answers.
 *
 * Measured: right after a write the Bridge reports an intermediate state. A
 * model that checks its own result immediately will describe something that is
 * not the outcome, so it is told not to.
 */
const DELAY_NOTE =
  'The Bridge needs a moment to reconcile with Proton. Listing the label straight away ' +
  'may not show the change yet, and an immediate check would be misleading rather than informative.'

const labelArgument = z
  .string()
  .describe(
    `The label name, for example "Work". The "${LABEL_PREFIX}" prefix may be included and is optional. ` +
      'Use list_folders to see which labels exist. Labels are created in Proton itself, not here.',
  )

const messageArgument = z
  .string()
  .describe('The message id from a listing or a search, with or without angle brackets.')

const mailboxHint = z
  .string()
  .optional()
  .describe('The mailbox the message is in, if known. Only a shortcut for the lookup.')

export function registerLabelTools(
  server: McpServer,
  connection: Connection,
  readOnly: () => boolean,
): void {
  server.registerTool(
    'add_label',
    {
      title: 'Apply a label',
      description:
        'Applies an existing label to a message. In Proton a message lives in exactly one folder ' +
        'but can carry any number of labels, so this adds to the message rather than moving it: ' +
        'it stays where it is and keeps the labels it already has. ' +
        'The label has to exist already; this server does not create labels.',
      inputSchema: z.object({
        messageId: messageArgument,
        label: labelArgument,
        mailbox: mailboxHint,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ messageId, label, mailbox }, ctx) =>
      track(
        () =>
          withSignIn(ctx, async () => {
            try {
              const result = await addLabel(connection, readOnly(), messageId, label, mailbox)
              return ok(
                `Applied "${result.label}" to ${result.messageId}, which is in "${result.path}". ` +
                  `It has not been moved. ${DELAY_NOTE}`,
              )
            } catch (error) {
              return describeFailure(error, `applying the label "${label}"`)
            }
          }),
        'add_label',
      ),
  )

  server.registerTool(
    'remove_label',
    {
      title: 'Remove a label',
      description:
        'Removes a label from a message. The message keeps its folder and its other labels, and ' +
        'does not go to trash. Only labels can be removed this way, never folders: a message ' +
        'always lives in some folder, and moving it is a different operation.',
      inputSchema: z.object({
        messageId: messageArgument,
        label: labelArgument,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ messageId, label }, ctx) =>
      track(
        () =>
          withSignIn(ctx, async () => {
            try {
              const result = await removeLabel(connection, readOnly(), messageId, label)
              if (!result.wasApplied) {
                return ok(
                  `${result.messageId} does not carry "${result.label}", so there was nothing to remove. ` +
                    'Nothing was changed.',
                )
              }
              return ok(
                `Removed "${result.label}" from ${result.messageId}. The message keeps its folder and ` +
                  `its other labels. ${DELAY_NOTE}`,
              )
            } catch (error) {
              return describeFailure(error, `removing the label "${label}"`)
            }
          }),
        'remove_label',
      ),
  )
}
