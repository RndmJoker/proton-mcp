/**
 * Tool: open_configuration
 *
 * Hands out the address of the local web interface.
 *
 * Why a tool rather than only a line on stderr: most clients hide a server's
 * stderr, so a user who wants to reach the interface would have to go digging
 * through logs. Asking the assistant is the obvious move, and this makes it
 * work.
 *
 * Since 2026-11-05 the address is fixed and carries no token. Every running
 * server shares the one interface, and changes there are guarded by a PIN the
 * user may set, which this tool never sees. Handing the address to the
 * assistant therefore gives it nothing it could not have guessed; what keeps
 * it from changing settings is the PIN, and the answer says so when none is
 * set.
 */

import * as z from 'zod'
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
import type { StoreKind } from '../credentials/store.js'
import { STORE_DESCRIPTIONS } from '../credentials/store.js'
import { track } from '../in-flight.js'
import type { PortOccupant } from '../web/server.js'

export interface InterfaceInfo {
  url: () => string
  /** True when this server serves the interface itself. */
  running: () => boolean
  /** True when the interface answers at the address, from this server or another. */
  reachable?: () => boolean
  /** Who held the port when this server last found it taken. */
  occupant?: () => PortOccupant
  /** True while a PIN guards changes in the interface. */
  pinSet?: () => boolean
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
        'in, where to see what has been sent, where the folders are listed, what the assistant ' +
        'is allowed to do, or when another tool reports that no credentials are available. The ' +
        'address is fixed and shared by every running server; changes on the page may need a ' +
        'PIN that only the user knows and that must never be asked for in the conversation.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      track(async () => {
        const reachable = info.reachable?.() ?? info.running()
        if (!reachable) {
          // An older proton-mcp on the port is the ordinary case right after an
          // update, while sessions started before it still run. Calling it a
          // stranger sent users off to move every server to another port.
          const held =
            info.occupant?.() === 'older'
              ? 'Its port is held by an older proton-mcp, still running in a session the user ' +
                'started before updating. That version serves an interface of its own and knows ' +
                'nothing of the shared one. Tell the user to restart the sessions that still run ' +
                'it, or to wait until they end.'
              : 'Its port is held by a program that is not proton-mcp. Tell the user to stop that ' +
                'program or to set PROTON_MCP_WEB_PORT to a free port, the same one for every ' +
                'proton-mcp they run.'
          const failure: CallToolResult = {
            content: [
              {
                type: 'text' as const,
                text:
                  `The configuration interface is not available at ${info.url()}. ${held} This ` +
                  'server takes the port over as soon as it is free. Credentials can still be ' +
                  'provided through the BRIDGE_USER and BRIDGE_PASS environment variables.',
              },
            ],
            isError: true,
          }
          return failure
        }

        const lines: string[] = [`Configuration interface: ${info.url()}`, '']
        if (!info.running()) {
          lines.push(
            'Another running proton-mcp serves it right now. It shows every running server and',
            'its sign-in, this one included.',
            '',
          )
        }

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
          'The address is only reachable from this machine and stays the same across restarts.',
          info.pinSet?.() === true
            ? 'Changes on the page need the PIN the user set. Never ask for it here.'
            : 'No PIN is set, so anything on this machine can change the settings there. The ' +
              'user can set one on the Permissions page.',
        )

        const answer: CallToolResult = { content: [{ type: 'text', text: lines.join('\n') }] }
        return answer
      }, 'open_configuration'),
  )
}
