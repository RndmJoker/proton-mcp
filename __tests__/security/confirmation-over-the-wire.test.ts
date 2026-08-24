import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { McpServer, InMemoryTransport, createRequestStateCodec } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { registerSendTools } from '../../src/tools/send.js'
import { setHandshakeCapabilities, _clearHandshakeCapabilities } from '../../src/tools/capabilities.js'
import { _clearSignInHint } from '../../src/tools/failures.js'
import type { Connection } from '../../src/bridge/connection.js'
import type { Config } from '../../src/config.js'
import type { PendingSend } from '../../src/tools/confirm.js'

/**
 * The confirmation over a real connection, rather than over a context this file
 * made up.
 *
 * This test exists because of a defect that shipped in v0.4.0: the check for
 * "can this client show a form" read the declaration out of a per-request
 * envelope that only protocol revision 2026-07-28 carries, while the SDK in use
 * speaks 2025-11-25 and carries it at handshake time instead. The check
 * therefore answered no for every client that ever connected, and all four
 * sending tools refused every call.
 *
 * Twenty-one unit tests covered that check and every one of them passed,
 * because they fed it a context shaped the way the code expected rather than
 * the way the wire delivers. So the lesson is narrow and worth keeping: a
 * stand-in cannot test what a stand-in was built from. These tests drive a real
 * handshake over a linked in-memory transport, negotiate a real protocol
 * revision, and let the SDK deliver the elicitation the way it really does.
 *
 * No Bridge is involved. Sending itself is stubbed; what is under test is
 * whether it is reached, and what the person on the other end gets asked.
 */

const sent: Array<{ to: string[]; subject: string }> = []

vi.mock('../../src/mail/send.js', () => ({
  sendMessage: vi.fn(async (_config, _credentials, _readOnly, draft) => {
    const everyone = [...draft.to, ...draft.cc, ...draft.bcc].map(
      (r: { address: string }) => r.address,
    )
    sent.push({ to: everyone, subject: draft.subject })
    return { messageId: draft.messageId, accepted: everyone, rejected: [], response: '250 ok' }
  }),
}))

/**
 * A JSON-RPC frame as this test reads and writes them.
 *
 * Deliberately not the SDK's `JSONRPCMessage`, which is a union of the four
 * precise shapes. This test speaks raw protocol and inspects whatever comes
 * back, so one shape with optional fields is what makes it readable: a received
 * frame is checked for `method`, `id`, `result` and `error` without first
 * narrowing which of the four it is.
 *
 * The price is a conversion at the two points where a frame meets the
 * transport, marked below. Those are the only places, and keeping them explicit
 * is the point of having this type at all.
 */
interface Message {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { message?: string }
}

const config = {
  host: '127.0.0.1',
  imapPort: 1143,
  smtpPort: 1025,
  readOnly: false,
  webPort: 7345,
} as Config

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * A client that answers whatever the server asks it.
 *
 * `answer` decides what to do with an elicitation, so a test can accept,
 * decline, or watch one arrive and inspect what it says.
 */
function connect(options: {
  capabilities: Record<string, unknown>
  answer?: (params: Record<string, unknown>) => Record<string, unknown>
  readOnly?: boolean
}) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const received: Message[] = []
  const asked: Array<Record<string, unknown>> = []

  const codec = createRequestStateCodec<PendingSend>({ key: 'x'.repeat(32), ttlSeconds: 60 })

  const handle = serveStdio(
    () => {
      // Built the way server.ts builds it, including the verify hook. That is
      // not decoration: without it the sealed state comes back as the raw wire
      // string, the second round does not recognise its own confirmation, and
      // the tool asks again until the SDK's round limit stops it. A test that
      // wires the server differently from production tests a different server.
      const server = new McpServer(
        { name: 'proton-mcp', version: 'test' },
        { requestState: { verify: codec.verify } },
      )
      setHandshakeCapabilities(() => server.server?.getClientCapabilities?.())
      registerSendTools(server, {
        config,
        connection: {} as Connection,
        getCredentials: async () => ({ user: 'me@example.com', pass: 'secret' }),
        readOnly: () => options.readOnly ?? false,
        from: () => 'me@example.com',
        codec,
      })
      return server
    },
    { transport: serverSide },
  )

  // Transport boundary one: the SDK hands over a JSONRPCMessage union, and this
  // test reads it as the one flat shape above.
  clientSide.onmessage = (raw) => {
    const message = raw as Message
    received.push(message)
    // The server asking us something. This is the whole point of the exercise:
    // on this protocol revision the SDK turns the handler's returned
    // input-required into a real request to the client.
    if (message.method === 'elicitation/create' && message.id !== undefined) {
      asked.push(message.params ?? {})
      const result = options.answer
        ? options.answer(message.params ?? {})
        : { action: 'accept', content: { confirm: true } }
      void clientSide.send({ jsonrpc: '2.0', id: message.id, result })
    }
  }

  // Transport boundary two: the frames built here are raw on purpose, including
  // incomplete ones, because what the server does with those is the subject.
  const send = (message: Message): Promise<void> =>
    clientSide.send(message as Parameters<typeof clientSide.send>[0])
  const replyTo = (id: number): Message | undefined =>
    received.find((m) => m.id === id && (m.result !== undefined || m.error !== undefined))

  return {
    asked,
    received,
    async open(): Promise<string | undefined> {
      await send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: options.capabilities,
          clientInfo: { name: 'test-client', version: '1' },
        },
      })
      await wait(30)
      await send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      await wait(30)
      return replyTo(1)?.result?.protocolVersion as string | undefined
    },
    async call(name: string, args: Record<string, unknown>, id = 50): Promise<Message | undefined> {
      await send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
      // Long enough for a full round trip through the client and back.
      for (let i = 0; i < 40 && !replyTo(id); i += 1) await wait(25)
      return replyTo(id)
    },
    async close(): Promise<void> {
      await handle.close()
    },
  }
}

const text = (message: Message | undefined): string =>
  ((message?.result?.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? '')

const MESSAGE = { to: ['you@example.com'], subject: 'Hello', text: 'Body' }

let open: { close: () => Promise<void> } | undefined

beforeEach(() => {
  sent.length = 0
  _clearSignInHint()
  _clearHandshakeCapabilities()
})

afterEach(async () => {
  await open?.close()
  open = undefined
})

describe('a client that declares form elicitation', () => {
  it('is actually asked, and the message goes out once it says yes', async () => {
    // The test that would have caught the v0.4.0 defect. Every part of it is
    // real except the SMTP call: a negotiated protocol revision, a declaration
    // made at handshake time, and an elicitation the SDK delivers itself.
    const client = connect({ capabilities: { elicitation: { form: {} } } })
    open = client
    expect(await client.open()).toBe('2025-11-25')

    const result = await client.call('send_message', MESSAGE)

    expect(client.asked).toHaveLength(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toEqual(['you@example.com'])
    expect(text(result)).toContain('Sent')
  })

  it('is shown every recipient before it answers', async () => {
    const client = connect({ capabilities: { elicitation: { form: {} } } })
    open = client
    await client.open()

    await client.call('send_message', { ...MESSAGE, bcc: ['quiet@example.com'] })

    const shown = String(client.asked[0]?.message ?? '')
    expect(shown).toContain('you@example.com')
    expect(shown).toContain('quiet@example.com')
    expect(shown).toContain('cannot be undone')
  })

  it('sends nothing when it says no', async () => {
    const client = connect({
      capabilities: { elicitation: { form: {} } },
      answer: () => ({ action: 'accept', content: { confirm: false } }),
    })
    open = client
    await client.open()

    const result = await client.call('send_message', MESSAGE)

    expect(client.asked).toHaveLength(1)
    expect(sent).toEqual([])
    expect(text(result)).toContain('did not confirm')
  })

  it('sends nothing when it declines the question outright', async () => {
    const client = connect({
      capabilities: { elicitation: { form: {} } },
      answer: () => ({ action: 'decline' }),
    })
    open = client
    await client.open()

    await client.call('send_message', MESSAGE)

    expect(sent).toEqual([])
  })
})

describe('a bare elicitation declaration', () => {
  it('counts as form support, the way the SDK reads it', async () => {
    const client = connect({ capabilities: { elicitation: {} } })
    open = client
    await client.open()

    await client.call('send_message', MESSAGE)

    expect(client.asked).toHaveLength(1)
    expect(sent).toHaveLength(1)
  })
})

describe('a client that cannot show a form', () => {
  it('is refused without anything being asked or sent', async () => {
    const client = connect({ capabilities: {} })
    open = client
    await client.open()

    const result = await client.call('send_message', MESSAGE)

    expect(client.asked).toEqual([])
    expect(sent).toEqual([])
    expect(result?.result?.isError).toBe(true)
    expect(text(result)).toContain('cannot show a confirmation')
  })

  it('is refused when it declared url elicitation only', async () => {
    // A URL cannot carry a yes or a no back, so it is not a confirmation.
    const client = connect({ capabilities: { elicitation: { url: {} } } })
    open = client
    await client.open()

    await client.call('send_message', MESSAGE)

    expect(client.asked).toEqual([])
    expect(sent).toEqual([])
  })
})

describe('read-only', () => {
  it('refuses before the client is asked anything', async () => {
    const client = connect({ capabilities: { elicitation: { form: {} } }, readOnly: true })
    open = client
    await client.open()

    const result = await client.call('send_message', MESSAGE)

    expect(client.asked).toEqual([])
    expect(sent).toEqual([])
    expect(text(result)).toContain('read-only')
  })
})
