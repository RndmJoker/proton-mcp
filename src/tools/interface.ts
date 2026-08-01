/**
 * Tool: open_configuration
 *
 * Hands out the address of the local web interface, including the access token.
 *
 * Why a tool rather than only a line on stderr: most clients hide a server's
 * stderr, so a user who wants to reach the interface would have to go digging
 * through logs. Asking the assistant is the obvious move, and this makes it
 * work.
 *
 * The token does end up in the conversation. That is a deliberate trade: it
 * grants access to a page on loopback that shows configuration and state, never
 * message content, and it is worthless from any other machine. It changes with
 * every restart. The alternative, making the user hunt for a log line, would
 * mostly result in nobody using the interface at all.
 */

import * as z from 'zod'
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
import type { StoreKind } from '../credentials/store.js'
import { STORE_DESCRIPTIONS } from '../credentials/store.js'
import { track } from '../in-flight.js'

export interface InterfaceInfo {
  url: () => string
  running: () => boolean
  signedIn: () => boolean
  address: () => string | undefined
  storeKind: () => StoreKind | undefined
  /** Whether credentials are stored but still need a master password. */
  locked?: () => Promise<boolean>
}

export function registerInterfaceTool(server: McpServer, info: InterfaceInfo): void {
  server.registerTool(
    'open_configuration',
    {
      title: 'Open the configuration interface',
      description:
        'Returns the address of the local configuration interface, which runs for as long as this ' +
        'server does and is where everything about this server can be seen and changed. Give it ' +
        'to the user whenever they ask for the interface, the panel, the settings, the web page, ' +
        'the address or the link, however they phrase it, and also when they ask where to sign ' +
        'in, where to see what has been sent, where the folders are listed, or when another tool ' +
        'reports that no credentials are available. The address contains an access token and ' +
        'changes every time the server restarts, so it cannot be remembered from an earlier ' +
        'conversation and has to be asked for again.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      track(async () => {
        if (!info.running()) {
          const failure: CallToolResult = {
            content: [
              {
                type: 'text' as const,
                text:
                  'The configuration interface is not running. It failed to start, most likely ' +
                  'because its port was in use. Set PROTON_MCP_WEB_PORT to a free port and restart ' +
                  'the server. Credentials can still be provided through the BRIDGE_USER and ' +
                  'BRIDGE_PASS environment variables.',
              },
            ],
            isError: true,
          }
          return failure
        }

        const lines: string[] = [`Configuration interface: ${info.url()}`, '']

        if (info.signedIn()) {
          const kind = info.storeKind()
          lines.push(
            `Signed in as ${info.address()}.`,
            kind
              ? `Credentials are kept in: ${STORE_DESCRIPTIONS[kind].title}.`
              : 'Credentials are held for this session only.',
            '',
            'The page shows the connection state and lets the user sign out.',
          )
        } else if ((await info.locked?.()) === true) {
          lines.push(
            'Credentials are stored in an encrypted file and only need to be unlocked. Opening the',
            'address above leads to a page asking for the master password, and nothing else: the',
            'Bridge password is already on disk.',
            '',
            'Tell the user to open it themselves. Do not ask them for the master password here.',
          )
        } else {
          lines.push(
            'Not signed in yet. Opening the address above leads to a form asking for the Proton',
            'address and the Bridge password, which is the password the Bridge generates and not',
            'the Proton account password.',
            '',
            'Tell the user to open it themselves. Do not ask them for the password here: it has no',
            'business in a conversation, and the page exists so that it never has to be.',
          )
        }

        lines.push(
          '',
          'The address is only reachable from this machine and the token changes on every restart.',
        )

        const answer: CallToolResult = { content: [{ type: 'text', text: lines.join('\n') }] }
        return answer
      }, 'open_configuration'),
  )
}
