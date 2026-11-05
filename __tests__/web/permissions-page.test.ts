import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { request as httpRequest } from 'node:http'
import { WebInterface } from '../../src/web/server.js'
import type { ToolLevelView, LimitsView } from '../../src/web/sections.js'
import type { Level, SendLimits } from '../../src/settings.js'

/**
 * The page where the user decides what the assistant may do.
 *
 * The form is untrusted input like any other: a level a tool does not offer, a
 * value for a tool the environment fixed, or a bound that is not one must be
 * refused rather than stored. And the page has to say plainly what sending
 * without asking costs, where it is switched on.
 */

let web: WebInterface
let tools: ToolLevelView[]
let limits: LimitsView
let savedLevels: Array<Record<string, Level>>
let savedLimits: SendLimits[]

beforeEach(async () => {
  tools = [
    { tool: 'list_messages', group: 'reading', level: 'act', options: ['off', 'act'], fixed: false, source: 'the default' },
    { tool: 'send_message', group: 'sending', level: 'ask', options: ['off', 'ask', 'act'], fixed: false, source: 'the default' },
    { tool: 'send_forward', group: 'sending', level: 'off', options: ['off', 'ask', 'act'], fixed: true, source: 'set in the environment' },
  ]
  limits = { allowed: [], fixed: { allowed: false, maxPerHour: false, until: false } }
  savedLevels = []
  savedLimits = []
  web = new WebInterface({
    port: 0,
    getPermissions: () => ({ tools, limits }),
    onLevels: async (levels) => {
      savedLevels.push(levels)
      return undefined
    },
    onLimits: async (next) => {
      savedLimits.push(next)
      return undefined
    },
    onSignIn: async () => undefined,
    onSignOut: async () => undefined,
    getStatus: async () => ({
      connected: true,
      address: 'someone@example.com',
      bridgeHost: '127.0.0.1',
      bridgeImapPort: 1143,
      bridgeSmtpPort: 1025,
    }),
    notify: () => undefined,
  })
  await web.start()
})

afterEach(async () => {
  await web.stop()
})

function send(path: string, fields?: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = fields ? new URLSearchParams(fields).toString() : undefined
    const headers: Record<string, string> = { Host: `127.0.0.1:${web.port}` }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      headers['Content-Length'] = String(Buffer.byteLength(body))
      headers.Origin = `http://127.0.0.1:${web.port}`
    }
    const req = httpRequest(
      { hostname: '127.0.0.1', port: web.port, path, method: body === undefined ? 'GET' : 'POST', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

async function csrf(action: string): Promise<string> {
  const page = (await send('/permissions')).body
  const part = page.split(`action="${action}"`)[1] ?? ''
  return /name="csrf" value="([^"]+)"/.exec(part)?.[1] ?? ''
}

describe('the levels', () => {
  it('offer each tool only the levels it has', async () => {
    const { body } = await send('/permissions')
    const reading = body.split('name="level:list_messages"')[1]!.split('</select>')[0]!
    expect(reading).not.toContain('value="ask"')
    const sending = body.split('name="level:send_message"')[1]!.split('</select>')[0]!
    expect(sending).toContain('value="ask"')
  })

  it('show a level fixed by the environment as text, not as a choice', async () => {
    const { body } = await send('/permissions')
    expect(body).not.toContain('name="level:send_forward"')
    expect(body).toContain('set in the environment')
  })

  it('store what was chosen', async () => {
    await send('/permissions/levels', {
      csrf: await csrf('/permissions/levels'),
      'level:list_messages': 'off',
      'level:send_message': 'act',
    })
    expect(savedLevels).toEqual([{ list_messages: 'off', send_message: 'act' }])
  })

  it('refuse a level a tool does not offer', async () => {
    const res = await send('/permissions/levels', {
      csrf: await csrf('/permissions/levels'),
      'level:list_messages': 'ask',
    })
    expect(res.body).toContain('is not a level list_messages offers')
    expect(savedLevels).toEqual([])
  })

  it('ignore a value for a tool the environment fixed', async () => {
    await send('/permissions/levels', {
      csrf: await csrf('/permissions/levels'),
      'level:send_forward': 'act',
    })
    expect(savedLevels).toEqual([{}])
  })

  it('state the cost where sending without asking is switched on', async () => {
    tools[1]!.level = 'act'
    const { body } = await send('/permissions')
    expect(body).toContain('acts without asking')
    expect(body).toContain('nobody would see it happen')
    expect(body).toContain('No PIN is set')
  })
})

describe('the bounds', () => {
  it('store addresses, domains, a number and a day', async () => {
    await send('/permissions/limits', {
      csrf: await csrf('/permissions/limits'),
      allowed: 'boss@example.com\n@example.org',
      maxPerHour: '10',
      until: '2026-12-31',
    })
    expect(savedLimits).toEqual([
      { allowed: ['boss@example.com', '@example.org'], maxPerHour: 10, until: '2026-12-31' },
    ])
  })

  it('store nothing for empty fields, which means no bound', async () => {
    await send('/permissions/limits', { csrf: await csrf('/permissions/limits'), allowed: '', maxPerHour: '', until: '' })
    expect(savedLimits).toEqual([{}])
  })

  it('refuse what is not an address or a domain', async () => {
    const res = await send('/permissions/limits', { csrf: await csrf('/permissions/limits'), allowed: 'everyone' })
    expect(res.body).toContain('is neither an address nor a domain')
    expect(savedLimits).toEqual([])
  })

  it('refuse a number and a day that are not', async () => {
    const token = await csrf('/permissions/limits')
    expect((await send('/permissions/limits', { csrf: token, maxPerHour: '0' })).body).toContain('not a usable number')
    expect((await send('/permissions/limits', { csrf: token, until: 'soon' })).body).toContain('is not a day')
    expect(savedLimits).toEqual([])
  })
})
