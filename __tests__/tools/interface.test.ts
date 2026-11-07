import { describe, it, expect } from 'vitest'
import { registerInterfaceTool, type InterfaceInfo } from '../../src/tools/interface.js'
import type { McpServer } from '@modelcontextprotocol/server'

/**
 * What open_configuration tells a model about the interface.
 *
 * The answer is the model's whole picture of where the user can sign in and
 * change settings, so a wrong reason sends the user on the wrong errand: to
 * move every server to another port, or to a form the page does not show.
 */

type Answer = { content: Array<{ type: string; text: string }>; isError?: boolean }
type Handler = () => Promise<Answer>

/** Registers the tool on a stand-in server and hands out its handler. */
function capture(info: Partial<InterfaceInfo>): Handler {
  let handler: Handler | undefined
  const server = {
    registerTool: (_name: string, _config: unknown, fn: Handler) => {
      handler = fn
    },
  } as unknown as McpServer
  registerInterfaceTool(server, {
    url: () => 'http://127.0.0.1:7345/',
    running: () => false,
    reachable: () => false,
    signedIn: () => false,
    address: () => undefined,
    storeKind: () => undefined,
    ...info,
  })
  if (!handler) throw new Error('the tool did not register itself')
  return handler
}

const text = (answer: Answer): string => answer.content.map((part) => part.text).join('\n')

describe('open_configuration while the port is held', () => {
  it('names an older proton-mcp and the restart, without sending the user to another port', async () => {
    const answer = await capture({ occupant: () => 'older' })()
    expect(answer.isError).toBe(true)
    expect(text(answer)).toContain('held by an older proton-mcp, still running in a session the user started')
    expect(text(answer)).toContain('restart the sessions that still run it')
    expect(text(answer)).not.toContain('not proton-mcp')
    expect(text(answer)).not.toContain('PROTON_MCP_WEB_PORT')
  })

  it('still calls another program what it is, with the way out it needs', async () => {
    const answer = await capture({ occupant: () => 'other' })()
    expect(answer.isError).toBe(true)
    expect(text(answer)).toContain('held by a program that is not proton-mcp')
    expect(text(answer)).toContain('PROTON_MCP_WEB_PORT')
  })
})
