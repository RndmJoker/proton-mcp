/**
 * Tool: list_folders
 *
 * Lists the mailboxes. Deliberately its own tool and never a side dish of
 * another answer: mailbox names are personal data on their own. Folders and
 * labels belong to the Proton account rather than to a single address, so this
 * exposes the whole account structure. A name like Folders/Banking/Revolut
 * gives away a bank even when not a single message inside it is visible.
 */

import * as z from 'zod'
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
import type { Connection, Mailbox } from '../bridge/connection.js'
import { describeFailure, withSignIn } from './failures.js'
import { track } from '../in-flight.js'

const inputSchema = z.object({
  kind: z
    .enum(['all', 'system', 'folder', 'label'])
    .default('all')
    .describe(
      'Which mailboxes to list. "system" covers Inbox, Sent, Trash and so on, ' +
        '"folder" the user-created folders, "label" the labels.',
    ),
  onlySelectable: z
    .boolean()
    .default(false)
    .describe('When true, only mailboxes that can hold messages are listed.'),
})

/** Builds the text output. Kept compact, because mailbox lists get long. */
export function format(mailboxes: Mailbox[]): string {
  if (mailboxes.length === 0) return 'No mailboxes found.'

  const groups: Array<[Mailbox['kind'], string]> = [
    ['system', 'System mailboxes'],
    ['folder', 'Folders'],
    ['label', 'Labels'],
  ]

  const lines: string[] = []
  for (const [kind, heading] of groups) {
    const part = mailboxes.filter((m) => m.kind === kind && m.selectable)
    if (part.length === 0) continue
    lines.push(`## ${heading} (${part.length})`)
    for (const m of part) {
      const role = m.specialUse ? `  [${m.specialUse}]` : ''
      lines.push(`- ${m.path}${role}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

export function registerListFolders(server: McpServer, connection: Connection): void {
  server.registerTool(
    'list_folders',
    {
      title: 'List mailboxes',
      description:
        'Lists the folders and labels of the Proton account. ' +
        'Proton distinguishes folders (a message lives in exactly one) from labels ' +
        '(a message can carry any number). Over IMAP both appear as directories.',
      inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ kind, onlySelectable }, ctx) =>
      track(() =>
        withSignIn(ctx, async () => {
          try {
            let mailboxes = await connection.listMailboxes()
            if (kind !== 'all') mailboxes = mailboxes.filter((m) => m.kind === kind)
            if (onlySelectable) mailboxes = mailboxes.filter((m) => m.selectable)

            const answer: CallToolResult = { content: [{ type: 'text', text: format(mailboxes) }] }
            return answer
          } catch (error) {
            return describeFailure(error, 'listing mailboxes')
          }
        }),
        'list_folders',
      ),
  )
}
