import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { request as httpRequest } from 'node:http'
import { WebInterface } from '../../src/web/server.js'
import type { ToolLevelView, LimitsView, RecordView, FilterActionsView } from '../../src/web/sections.js'
import type { Unlockable } from '../../src/filters/sieve.js'
import type { Level, SendLimits, RecordCopy } from '../../src/settings.js'
import { recordProblem } from '../../src/mail/record.js'
import { hashPin, type StoredPin } from '../../src/web/security.js'

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
let record: RecordView
let savedRecords: Array<RecordCopy | undefined>
let filterActions: FilterActionsView
let savedActions: Unlockable[][]
let pin: StoredPin | undefined

beforeEach(async () => {
  tools = [
    { tool: 'list_messages', group: 'reading', level: 'act', options: ['off', 'act'], fixed: false, source: 'the default' },
    { tool: 'send_message', group: 'sending', level: 'ask', options: ['off', 'ask', 'act'], fixed: false, source: 'the default' },
    { tool: 'send_forward', group: 'sending', level: 'off', options: ['off', 'ask', 'act'], fixed: true, source: 'set in the environment' },
  ]
  limits = { allowed: [], fixed: { allowed: false, maxPerHour: false, until: false } }
  savedLevels = []
  savedLimits = []
  record = { fixed: false }
  savedRecords = []
  filterActions = { allowed: [], fixed: false }
  savedActions = []
  pin = undefined
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
    getRecord: () => record,
    // The same check the server makes before it stores anything.
    onRecord: async (next) => {
      const problem = next ? recordProblem(next.address) : undefined
      if (problem) return problem
      savedRecords.push(next)
      return undefined
    },
    getFilterActions: () => filterActions,
    onFilterActions: async (actions) => {
      savedActions.push(actions)
      return undefined
    },
    getPin: () => pin,
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

describe('the copy of everything sent (#18)', () => {
  it('stores an address with the way it is added', async () => {
    const res = await send('/permissions/record', {
      csrf: await csrf('/permissions/record'),
      address: 'boss@example.com',
      mode: 'cc',
    })
    expect(savedRecords).toEqual([{ address: 'boss@example.com', mode: 'cc' }])
    expect(res.body).toContain('Every message sent now also goes to boss@example.com as Cc')
  })

  it('adds a blind copy when no way is given', async () => {
    await send('/permissions/record', { csrf: await csrf('/permissions/record'), address: 'archive@example.com' })
    expect(savedRecords).toEqual([{ address: 'archive@example.com', mode: 'bcc' }])
  })

  it('removes the copy when the address is left empty', async () => {
    const res = await send('/permissions/record', { csrf: await csrf('/permissions/record'), address: '' })
    expect(savedRecords).toEqual([undefined])
    expect(res.body).toContain('No copy is added to messages any more')
  })

  it('refuses a way that is neither cc nor bcc', async () => {
    const res = await send('/permissions/record', {
      csrf: await csrf('/permissions/record'),
      address: 'archive@example.com',
      mode: 'to',
    })
    expect(res.body).toContain('is neither cc nor bcc')
    expect(savedRecords).toEqual([])
  })

  it('refuses an address that is not plain, and says why', async () => {
    const res = await send('/permissions/record', {
      csrf: await csrf('/permissions/record'),
      address: 'a@example.com, b@example.org',
    })
    expect(res.body).toContain('is not a plain address')
    expect(savedRecords).toEqual([])
  })

  it('shows a copy set in the environment as text, without a form', async () => {
    record = { fixed: true, address: 'archive@example.com', mode: 'bcc' }
    const { body } = await send('/permissions')
    expect(body).not.toContain('action="/permissions/record"')
    expect(body).toContain('PROTON_MCP_COPY_TO')
    expect(body).toContain('archive@example.com')
  })

  it('cannot be changed while the environment sets it, even without the page', async () => {
    const token = await csrf('/permissions/record')
    record = { fixed: true, address: 'archive@example.com', mode: 'bcc' }
    const res = await send('/permissions/record', { csrf: token, address: 'someone@elsewhere.example' })
    expect(res.body).toContain('set in the environment')
    expect(savedRecords).toEqual([])
  })

  it('needs the PIN once one is set', async () => {
    pin = await hashPin('correct horse')
    const token = await csrf('/permissions/record')
    const without = await send('/permissions/record', { csrf: token, address: 'someone@elsewhere.example' })
    expect(without.body).toContain('needs the PIN')
    expect(savedRecords).toEqual([])
    await send('/permissions/record', { csrf: token, address: 'archive@example.com', pin: 'correct horse' })
    expect(savedRecords).toEqual([{ address: 'archive@example.com', mode: 'bcc' }])
  })

  it('is named in the overview while it is on', async () => {
    record = { fixed: false, address: 'archive@example.com', mode: 'bcc' }
    const { body } = await send('/')
    expect(body).toContain('Copy of everything sent')
    expect(body).toContain('archive@example.com (Bcc)')
  })
})

describe('the cost of the filter tools acting on their own (#59)', () => {
  it('is stated in its own words, not as the cost of sending', async () => {
    tools = [
      { tool: 'send_message', group: 'sending', level: 'ask', options: ['off', 'ask', 'act'], fixed: false, source: 'the default' },
      { tool: 'apply_filter', group: 'filters', level: 'act', options: ['off', 'ask', 'act'], fixed: false, source: 'set on the Permissions page' },
    ]
    const { body } = await send('/permissions')
    expect(body).toContain('apply_filter acts without asking.')
    expect(body).toContain('A single message can then ask for a rule')
    expect(body).toContain('changes the mail that is already there')
    expect(body).not.toContain('your mailbox to be forwarded')
  })

  it('names the window of the extension as where the filter tools ask', async () => {
    const { body } = await send('/permissions')
    expect(body.replace(/\s+/g, ' ')).toContain('the filter tools in a window of the browser extension')
  })
})

describe('what a filter may do beyond filing and flags (06.11.2026)', () => {
  it('offers one box per action, none ticked by default, each with what it costs', async () => {
    const { body } = await send('/permissions')
    for (const action of ['trash', 'discard', 'expire', 'reject', 'vacation', 'stop']) {
      expect(body).toContain(`name="action:${action}"`)
    }
    expect(body).not.toMatch(/name="action:[a-z]+" value="on" checked/)
    expect(body).toContain('deleted at once and for good')
    expect(body.replace(/\s+/g, ' ')).toContain('The browser extension has the same switches in its popup, and an action needs both')
  })

  it('stores the ticked actions and nothing else', async () => {
    const token = await csrf('/permissions/filter-actions')
    const answer = await send('/permissions/filter-actions', { csrf: token, 'action:discard': 'on', 'action:trash': 'on' })
    expect(answer.body).toContain('What filters may do is saved.')
    expect(savedActions).toEqual([['trash', 'discard']])
    await send('/permissions/filter-actions', { csrf: token })
    expect(savedActions[1]).toEqual([])
  })

  it('refuses an action the page does not offer, or a box with another value', async () => {
    const token = await csrf('/permissions/filter-actions')
    expect((await send('/permissions/filter-actions', { csrf: token, 'action:redirect': 'on' })).body).toContain(
      'is not an action a filter can be allowed',
    )
    expect((await send('/permissions/filter-actions', { csrf: token, 'action:trash': 'yes' })).body).toContain(
      'came back with a value it does not have',
    )
    expect(savedActions).toEqual([])
  })

  it('shows a setting from the environment as text and refuses a change, even without the page', async () => {
    filterActions = { allowed: ['stop'], fixed: true }
    const page = await send('/permissions')
    expect(page.body).toContain('PROTON_MCP_FILTER_ACTIONS')
    expect(page.body).not.toContain('action="/permissions/filter-actions"')
    filterActions = { allowed: ['stop'], fixed: false }
    const token = await csrf('/permissions/filter-actions')
    filterActions = { allowed: ['stop'], fixed: true }
    expect((await send('/permissions/filter-actions', { csrf: token, 'action:trash': 'on' })).body).toContain(
      'set in the environment',
    )
    expect(savedActions).toEqual([])
  })

  it('states the cost once something is allowed', async () => {
    filterActions = { allowed: ['discard', 'vacation'], fixed: false }
    const { body } = await send('/permissions')
    expect(body).toContain('An assistant may set up filters that delete mail, answer automatically.')
    expect(body).toContain('No PIN is set')
  })

  it('needs the PIN once one is set', async () => {
    pin = await hashPin('correct horse')
    const token = await csrf('/permissions/filter-actions')
    expect((await send('/permissions/filter-actions', { csrf: token, 'action:trash': 'on' })).body).toContain('needs the PIN')
    expect(savedActions).toEqual([])
    await send('/permissions/filter-actions', { csrf: token, 'action:trash': 'on', pin: 'correct horse' })
    expect(savedActions).toEqual([['trash']])
  })

  it('is named in the overview while something is allowed', async () => {
    expect((await send('/')).body).toContain('nothing beyond filing and flags')
    filterActions = { allowed: ['trash'], fixed: false }
    expect((await send('/')).body).toContain('move mail to trash or spam')
  })
})
