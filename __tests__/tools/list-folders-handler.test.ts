import { describe, it, expect } from 'vitest'
import { registerListFolders } from '../../src/tools/list-folders.js'
import { BridgeError } from '../../src/bridge/errors.js'
import type { Connection, Mailbox } from '../../src/bridge/connection.js'
import type { McpServer } from '@modelcontextprotocol/server'

/**
 * Exercises the tool's handler, not just the formatting. What matters most is
 * the failure path: a Bridge failure has to arrive as text with isError, not
 * as a thrown exception. Otherwise the client sees a protocol error instead of
 * an explanation it can act on.
 */

type Handler = (args: { kind: string; onlySelectable: boolean }) => Promise<{
  content: Array<{ type: string; text: string }>
  isError?: boolean
}>

/** Intercepts the registration and hands out the handler. */
function captureHandler(connection: Connection): Handler {
  let handler: Handler | undefined
  const server = {
    registerTool: (_name: string, _config: unknown, fn: Handler) => {
      handler = fn
    },
  } as unknown as McpServer

  registerListFolders(server, connection)
  if (!handler) throw new Error('the tool did not register itself')
  return handler
}

const box = (path: string, kind: Mailbox['kind']): Mailbox => ({
  path,
  name: path.split('/').at(-1) ?? path,
  kind,
  selectable: true,
})

const fakeConnection = (answer: () => Promise<Mailbox[]>): Connection =>
  ({ listMailboxes: answer }) as unknown as Connection

const all = [
  box('INBOX', 'system'),
  box('Folders/Work', 'folder'),
  box('Labels/Important', 'label'),
]

describe('list_folders handler', () => {
  it('returns every mailbox', async () => {
    const handler = captureHandler(fakeConnection(async () => all))
    const result = await handler({ kind: 'all', onlySelectable: false })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('INBOX')
    expect(result.content[0]?.text).toContain('Folders/Work')
    expect(result.content[0]?.text).toContain('Labels/Important')
  })

  it('filters by kind', async () => {
    const handler = captureHandler(fakeConnection(async () => all))
    const labelsOnly = await handler({ kind: 'label', onlySelectable: false })
    expect(labelsOnly.content[0]?.text).toContain('Labels/Important')
    expect(labelsOnly.content[0]?.text).not.toContain('INBOX')
  })

  it('reports a Bridge failure as text with isError instead of throwing', async () => {
    const handler = captureHandler(
      fakeConnection(async () => {
        throw new BridgeError('Proton Mail Bridge is probably not running.')
      }),
    )
    const result = await handler({ kind: 'all', onlySelectable: false })
    expect(result.isError).toBe(true)
    // The explanation has to come through, not be replaced by something generic.
    expect(result.content[0]?.text).toBe('Proton Mail Bridge is probably not running.')
  })

  it('also catches failures that are not a BridgeError', async () => {
    const handler = captureHandler(
      fakeConnection(async () => {
        throw new TypeError('something else entirely')
      }),
    )
    const result = await handler({ kind: 'all', onlySelectable: false })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('something else entirely')
  })

  it('copes with an empty mailbox list', async () => {
    const handler = captureHandler(fakeConnection(async () => []))
    const result = await handler({ kind: 'all', onlySelectable: false })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toBe('No mailboxes found.')
  })
})
