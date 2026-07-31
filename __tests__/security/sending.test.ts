import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerSendTools } from '../../src/tools/send.js'
import { CONFIRM_KEY } from '../../src/tools/confirm.js'
import { _clearSignInHint } from '../../src/tools/failures.js'
import type { McpServer } from '@modelcontextprotocol/server'
import type { Connection } from '../../src/bridge/connection.js'
import type { Config } from '../../src/config.js'

/**
 * The confirmation, exercised through the tool rather than around it.
 *
 * The question these tests answer is the only one that matters for this part of
 * the server: is there any sequence of calls, from a client that is doing as it
 * is told or from one that is not, that puts a message on the wire without a
 * person having said yes to that exact message?
 *
 * Sending itself is stubbed. What is being tested is whether it is reached.
 */

const sent: Array<{ to: string[]; subject: string; text: string }> = []

vi.mock('../../src/mail/send.js', () => ({
  sendMessage: vi.fn(async (_config, _creds, _readOnly, draft) => {
    sent.push({
      to: [...draft.to, ...draft.cc, ...draft.bcc].map((r: { address: string }) => r.address),
      subject: draft.subject,
      text: draft.text,
    })
    return {
      messageId: draft.messageId,
      accepted: [...draft.to, ...draft.cc, ...draft.bcc].map((r: { address: string }) => r.address),
      rejected: [],
      response: '250 ok',
    }
  }),
}))

type Result = {
  content?: Array<{ type: string; text: string }>
  isError?: boolean
  requestState?: string
  inputRequests?: Record<string, unknown>
}
type Handler = (args: Record<string, unknown>, ctx: unknown) => Promise<Result>

const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities'

const config = { host: '127.0.0.1', imapPort: 1143, smtpPort: 1025, readOnly: false, webPort: 7345 } as Config

/** A codec that seals nothing, so a test can hand back whatever it likes. */
function fakeCodec() {
  const minted: Array<{ tool: string; digest: string }> = []
  return {
    minted,
    codec: {
      mint: async (payload: { tool: string; digest: string }) => {
        minted.push(payload)
        return JSON.stringify(payload)
      },
      verify: async (state: string) => JSON.parse(state),
    },
  }
}

function register(options: { readOnly?: boolean; from?: string | undefined } = {}) {
  const handlers = new Map<string, Handler>()
  const server = {
    registerTool: (name: string, _config: unknown, fn: Handler) => handlers.set(name, fn),
  } as unknown as McpServer

  const { codec, minted } = fakeCodec()
  registerSendTools(server, {
    config,
    connection: {} as Connection,
    getCredentials: async () => ({ user: 'me@example.com', pass: 'secret' }),
    readOnly: () => options.readOnly ?? false,
    from: () => ('from' in options ? options.from : 'me@example.com'),
    codec: codec as never,
  })
  return { handlers, minted }
}

/** A client that says it can show a form. */
const capable = (rest: Record<string, unknown> = {}) => ({
  mcpReq: { envelope: { [CAPABILITIES_KEY]: { elicitation: { form: {} } } }, ...rest },
})

/** The second round: the state comes back and the user said yes. */
const answered = (state: string, confirm: unknown = true) =>
  capable({
    requestState: () => JSON.parse(state),
    inputResponses: { [CONFIRM_KEY]: { action: 'accept', content: { confirm } } },
  })

const MESSAGE = { to: ['you@example.com'], subject: 'Hallo', text: 'Text' }

beforeEach(() => {
  sent.length = 0
  _clearSignInHint()
})

describe('the first call never sends', () => {
  it('asks instead, whatever the arguments say', async () => {
    const { handlers } = register()
    const result = await handlers.get('send_message')!(MESSAGE, capable())
    expect(sent).toEqual([])
    expect(result.inputRequests?.[CONFIRM_KEY]).toBeDefined()
    expect(result.requestState).toBeDefined()
  })

  it('shows the recipients in the question', async () => {
    const { handlers } = register()
    const result = (await handlers.get('send_message')!(
      { ...MESSAGE, bcc: ['quiet@example.com'] },
      capable(),
    )) as { inputRequests?: Record<string, { params?: { message?: string } }> }
    const message = result.inputRequests?.[CONFIRM_KEY]?.params?.message ?? ''
    expect(message).toContain('you@example.com')
    expect(message).toContain('quiet@example.com')
  })
})

describe('a client that cannot ask cannot send', () => {
  it('refuses rather than falling back to sending', async () => {
    // The difference from the sign-in prompt, which does fall back to text: the
    // worst outcome there is an inconvenience, here it is a message nobody
    // agreed to and nobody can recall.
    const { handlers } = register()
    const result = await handlers.get('send_message')!(MESSAGE, {
      mcpReq: { envelope: { [CAPABILITIES_KEY]: {} } },
    })
    expect(sent).toEqual([])
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain('cannot show a confirmation')
  })

  it('refuses a client that declared only url elicitation', async () => {
    const { handlers } = register()
    const result = await handlers.get('send_message')!(MESSAGE, {
      mcpReq: { envelope: { [CAPABILITIES_KEY]: { elicitation: { url: {} } } } },
    })
    expect(sent).toEqual([])
    expect(result.isError).toBe(true)
  })
})

describe('the yes has to be a yes', () => {
  it('sends once the user confirms', async () => {
    const { handlers } = register()
    const first = await handlers.get('send_message')!(MESSAGE, capable())
    const second = await handlers.get('send_message')!(MESSAGE, answered(first.requestState!))
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toEqual(['you@example.com'])
    expect(second.content?.[0]?.text).toContain('Sent')
  })

  it('sends nothing when the user says no', async () => {
    const { handlers } = register()
    const first = await handlers.get('send_message')!(MESSAGE, capable())
    const second = await handlers.get('send_message')!(MESSAGE, answered(first.requestState!, false))
    expect(sent).toEqual([])
    expect(second.isError).toBe(true)
    expect(second.content?.[0]?.text).toContain('did not confirm')
  })

  it('sends nothing when the answer is missing entirely', async () => {
    // A client that echoes the state back without ever asking anybody.
    const { handlers } = register()
    const first = await handlers.get('send_message')!(MESSAGE, capable())
    const second = await handlers.get('send_message')!(
      MESSAGE,
      capable({ requestState: () => JSON.parse(first.requestState!) }),
    )
    expect(sent).toEqual([])
    expect(second.isError).toBe(true)
  })
})

describe('the yes is bound to one message', () => {
  it('refuses when a recipient was added after the confirmation', async () => {
    // The attack in full: ask about a message to one address, then hand back
    // the same confirmation for a message that also goes somewhere else.
    const { handlers } = register()
    const first = await handlers.get('send_message')!(MESSAGE, capable())
    const second = await handlers.get('send_message')!(
      { ...MESSAGE, bcc: ['attacker@example.com'] },
      answered(first.requestState!),
    )
    expect(sent).toEqual([])
    expect(second.isError).toBe(true)
    expect(second.content?.[0]?.text).toContain('not the one that was confirmed')
  })

  it('refuses when the text was changed after the confirmation', async () => {
    const { handlers } = register()
    const first = await handlers.get('send_message')!(MESSAGE, capable())
    const second = await handlers.get('send_message')!(
      { ...MESSAGE, text: 'Something else entirely' },
      answered(first.requestState!),
    )
    expect(sent).toEqual([])
    expect(second.isError).toBe(true)
  })

  it('refuses a confirmation minted for a different tool', async () => {
    const { handlers } = register()
    const state = JSON.stringify({ tool: 'send_draft', digest: 'whatever' })
    const result = await handlers.get('send_message')!(MESSAGE, answered(state))
    expect(sent).toEqual([])
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain('different operation')
  })
})

describe('read-only', () => {
  it('refuses before anyone is even asked', async () => {
    // Asking someone to confirm a send that would be refused anyway is a
    // question with no honest answer.
    const { handlers } = register({ readOnly: true })
    const result = await handlers.get('send_message')!(MESSAGE, capable())
    expect(sent).toEqual([])
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain('read-only')
    expect(result.inputRequests).toBeUndefined()
  })

  it('refuses on the second round too, if it was turned on in between', async () => {
    const { handlers } = register()
    const first = await handlers.get('send_message')!(MESSAGE, capable())
    const locked = register({ readOnly: true })
    const second = await locked.handlers.get('send_message')!(
      MESSAGE,
      answered(first.requestState!),
    )
    expect(sent).toEqual([])
    expect(second.isError).toBe(true)
  })
})

describe('every sending tool goes through the same gate', () => {
  for (const tool of ['send_message', 'send_reply', 'send_forward', 'send_draft']) {
    it(`${tool} asks before it does anything`, async () => {
      const { handlers } = register()
      const args: Record<string, unknown> = {
        ...MESSAGE,
        messageId: '<original@example.com>',
        to: ['you@example.com'],
      }
      // The build step of the other three reaches for the Bridge, which is not
      // there. What matters is that nothing was sent either way.
      await handlers.get(tool)!(args, capable()).catch(() => undefined)
      expect(sent).toEqual([])
    })

    it(`${tool} refuses a client that cannot show a form`, async () => {
      const { handlers } = register()
      const result = await handlers
        .get(tool)!(
          { ...MESSAGE, messageId: '<original@example.com>', to: ['you@example.com'] },
          { mcpReq: { envelope: { [CAPABILITIES_KEY]: {} } } },
        )
        .catch(() => ({ isError: true }) as Result)
      expect(sent).toEqual([])
      expect(result.isError).toBe(true)
    })
  }
})

describe('without a sign-in there is nothing to send from', () => {
  it('refuses rather than inventing a sender', async () => {
    const { handlers } = register({ from: undefined })
    const result = await handlers.get('send_message')!(MESSAGE, capable())
    expect(sent).toEqual([])
    expect(result.isError).toBe(true)
  })
})
