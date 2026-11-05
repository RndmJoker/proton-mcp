import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerSendTools } from '../../src/tools/send.js'
import { CONFIRM_KEY } from '../../src/tools/confirm.js'
import { _clearSignInHint } from '../../src/tools/failures.js'
import { _reset as resetPreviews } from '../../src/tools/preview.js'
import { Permissions } from '../../src/permissions.js'
import type { StoredSettings } from '../../src/settings.js'
import type { McpServer } from '@modelcontextprotocol/server'
import type { Connection } from '../../src/bridge/connection.js'
import type { Config } from '../../src/config.js'

/**
 * Sending without asking, as the user can now allow it.
 *
 * The question these tests answer: does a message leave without a person
 * agreeing only when the user chose that for this tool, and only within the
 * bounds the user set? Every way out of those bounds has to end in a question,
 * never in mail that left, and an answer once given has to stand.
 */

const sent: Array<{ to: string[]; subject: string }> = []

vi.mock('../../src/mail/send.js', () => ({
  sendMessage: vi.fn(async (_config, _creds, _readOnly, draft) => {
    const to = [...draft.to, ...draft.cc, ...draft.bcc].map((r: { address: string }) => r.address)
    sent.push({ to, subject: draft.subject })
    return { messageId: draft.messageId, accepted: to, rejected: [], response: '250 ok' }
  }),
}))

type Result = {
  content?: Array<{ type: string; text: string }>
  isError?: boolean
  requestState?: string
  inputRequests?: Record<string, { params?: { message?: string } }>
}
type Handler = (args: Record<string, unknown>, ctx: unknown) => Promise<Result>

const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities'
const config = { host: '127.0.0.1', imapPort: 1143, smtpPort: 1025, readOnly: false, webPort: 7345 } as Config

let settings: StoredSettings
let now: number

function register(env: NodeJS.ProcessEnv = {}) {
  const handlers = new Map<string, Handler>()
  const server = {
    registerTool: (name: string, _config: unknown, fn: Handler) => handlers.set(name, fn),
  } as unknown as McpServer
  const permissions = new Permissions({ env, settings: () => settings, readOnly: false, clock: () => now })
  registerSendTools(server, {
    config,
    connection: {} as Connection,
    getCredentials: async () => ({ user: 'me@example.com', pass: 'secret' }),
    readOnly: () => false,
    from: () => 'me@example.com',
    codec: {
      mint: async (payload: unknown) => JSON.stringify(payload),
      verify: async (state: string) => JSON.parse(state),
    } as never,
    permissions,
  })
  return { handlers, permissions }
}

const capable = (rest: Record<string, unknown> = {}) => ({
  mcpReq: { envelope: { [CAPABILITIES_KEY]: { elicitation: { form: {} } } }, ...rest },
})

const answered = (state: string, confirm: unknown) =>
  capable({
    requestState: () => JSON.parse(state),
    inputResponses: { [CONFIRM_KEY]: { action: 'accept', content: { confirm } } },
  })

const MESSAGE = { to: ['you@example.com'], subject: 'Hello', text: 'Text' }

beforeEach(() => {
  sent.length = 0
  settings = {}
  now = Date.parse('2026-11-05T12:00:00')
  _clearSignInHint()
  resetPreviews()
})

describe('acting on its own', () => {
  it('sends at once when the user allowed it, and says so in the answer', async () => {
    settings = { levels: { send_message: 'act' } }
    const { handlers } = register()
    const result = await handlers.get('send_message')!(MESSAGE, capable())
    expect(sent).toHaveLength(1)
    expect(result.inputRequests).toBeUndefined()
    expect(result.content?.[0]?.text).toContain('Sent without asking')
    expect(result.content?.[0]?.text).toContain('Permissions page')
  })

  it('needs no client that can ask, since nothing is asked', async () => {
    settings = { levels: { send_message: 'act' } }
    const { handlers } = register()
    await handlers.get('send_message')!(MESSAGE, {})
    expect(sent).toHaveLength(1)
  })

  it('applies to the tool it was allowed for and to no other', async () => {
    settings = { levels: { send_message: 'act' } }
    const { handlers } = register()
    const result = await handlers.get('send_reply')!(
      { messageId: '<x@example.com>', text: 'Thanks' },
      capable(),
    )
    expect(sent).toHaveLength(0)
    expect(result.isError === true || result.inputRequests !== undefined).toBe(true)
  })
})

describe('the bounds turn a send into a question', () => {
  it('asks when a recipient is not on the permitted list, and says why', async () => {
    settings = { levels: { send_message: 'act' }, limits: { allowed: ['@example.org'] } }
    const { handlers } = register()
    const result = await handlers.get('send_message')!(MESSAGE, capable())
    expect(sent).toHaveLength(0)
    const message = result.inputRequests?.[CONFIRM_KEY]?.params?.message ?? ''
    expect(message).toContain('may send without asking, but')
    expect(message).toContain('you@example.com')
  })

  it('counts a blind copy as a recipient like any other', async () => {
    settings = { levels: { send_message: 'act' }, limits: { allowed: ['you@example.com'] } }
    const { handlers } = register()
    await handlers.get('send_message')!({ ...MESSAGE, bcc: ['hidden@elsewhere.example'] }, capable())
    expect(sent).toHaveLength(0)
  })

  it('asks once the hourly number is reached', async () => {
    settings = { levels: { send_message: 'act' }, limits: { maxPerHour: 1 } }
    const { handlers } = register()
    await handlers.get('send_message')!(MESSAGE, capable())
    const second = await handlers.get('send_message')!({ ...MESSAGE, subject: 'Again' }, capable())
    expect(sent).toHaveLength(1)
    expect(second.inputRequests?.[CONFIRM_KEY]).toBeDefined()
  })

  it('asks after the last day', async () => {
    settings = { levels: { send_message: 'act' }, limits: { until: '2026-11-04' } }
    const { handlers } = register()
    const result = await handlers.get('send_message')!(MESSAGE, capable())
    expect(sent).toHaveLength(0)
    expect(result.inputRequests?.[CONFIRM_KEY]?.params?.message).toContain('ended after 2026-11-04')
  })
})

describe('an answer stands', () => {
  it('a "no" is a no, even if the tool was allowed to act on its own after the question', async () => {
    const { handlers } = register()
    const first = await handlers.get('send_message')!(MESSAGE, capable())
    expect(first.requestState).toBeDefined()

    settings = { levels: { send_message: 'act' } }
    await handlers.get('send_message')!(MESSAGE, answered(first.requestState!, false))
    expect(sent).toHaveLength(0)
  })
})

describe('switched off', () => {
  it('refuses, names the setting, and sends nothing', async () => {
    settings = { levels: { send_message: 'off' } }
    const { handlers } = register()
    const result = await handlers.get('send_message')!(MESSAGE, capable())
    expect(sent).toHaveLength(0)
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain('switched off')
  })

  it('cannot be switched on from the interface while the environment says off', async () => {
    settings = { levels: { send_message: 'act' } }
    const { handlers } = register({ PROTON_MCP_OFF: 'send_message' })
    await handlers.get('send_message')!(MESSAGE, capable())
    expect(sent).toHaveLength(0)
  })
})
