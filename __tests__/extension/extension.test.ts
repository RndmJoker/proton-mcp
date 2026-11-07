import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { ProtonApi, sessionUid, clientId, localId, type PageEnvironment } from '../../extension/lib/proton-api.js'
import { diffLines } from '../../extension/lib/diff.js'
import { parseContentOp, parsePageMessage, parseSwitches, readSwitches, NO_SWITCHES } from '../../extension/lib/ops.js'
import { runContentOp } from '../../extension/lib/content-ops.js'
import { EXTENSION_ID } from '../../src/browser/messages.js'
import { SPAM_GUARD_PROLOGUE } from '../../src/filters/sieve.js'

/**
 * The parts of the browser extension (#59) that can run without a browser:
 * the calls to Proton's interface, the difference shown in the window, the
 * messages between its parts, and its manifest.
 */

type Call = { url: string; init?: RequestInit }

function page(options: {
  path?: string
  host?: string
  session?: string | null
  answer?: (call: Call) => { status?: number; body?: unknown }
}) {
  const calls: Call[] = []
  const host = options.host ?? 'mail.proton.me'
  const env: PageEnvironment = {
    location: { origin: `https://${host}`, hostname: host, pathname: options.path ?? '/u/0/inbox' },
    storage: {
      getItem: (key) => (key === 'ps-0' || key === 'ps-1' ? (options.session === undefined ? JSON.stringify({ UID: `uid-${key}` }) : options.session) : null),
    },
    fetch: async (url, init) => {
      const call = { url, ...(init ? { init } : {}) }
      calls.push(call)
      if (url === `https://${host}/assets/version.json`) return new Response(JSON.stringify({ version: '5.0.300.1' }))
      const { status = 200, body = { Code: 1000 } } = options.answer?.(call) ?? {}
      return new Response(JSON.stringify(body), { status })
    },
  }
  return { env, calls, api: new ProtonApi(env) }
}

/** Proton's interface, as the page at mail.proton.me reaches it. */
const API = 'https://mail.proton.me/api'

const header = (call: Call | undefined, name: string) => (call?.init?.headers as Record<string, string> | undefined)?.[name]

describe('who the page is', () => {
  it('reads the account slot from the address and the session from where Proton keeps it', () => {
    expect(localId('/u/1/mail/filters')).toBe('1')
    expect(localId('/inbox')).toBe('0')
    expect(sessionUid(page({ path: '/u/1/inbox' }).env)).toBe('uid-ps-1')
    expect(sessionUid(page({ session: 'not json' }).env)).toBeUndefined()
    expect(sessionUid(page({ session: null }).env)).toBeUndefined()
  })

  it("names the app the way Proton's web app does", () => {
    expect(clientId('account.proton.me')).toBe('web-account')
    expect(clientId('mail.proton.me')).toBe('web-mail')
  })
})

describe('calls to Proton', () => {
  it("send the page's session and app version, and the page's cookies", async () => {
    const { api, calls } = page({ answer: () => ({ body: { Code: 1000, Filters: [] } }) })
    await api.filters()
    const call = calls.find((c) => c.url === `${API}/mail/v4/filters`)
    expect(header(call, 'x-pm-uid')).toBe('uid-ps-0')
    expect(header(call, 'x-pm-appversion')).toBe('web-mail@5.0.300.1')
    expect(header(call, 'Accept')).toBe('application/vnd.protonmail.v1+json')
    expect(call?.init?.credentials).toBe('include')
  })

  it("call the page's own address, whichever Proton page it is", async () => {
    // Written out in full since the review of 06.11.2026: a path alone is
    // read against whatever a content script's fetch takes as its base.
    const { api, calls } = page({ host: 'account.proton.me', answer: () => ({ body: { Code: 1000, Filters: [] } }) })
    await api.filters()
    expect(calls.map((call) => call.url)).toEqual([
      'https://account.proton.me/assets/version.json',
      'https://account.proton.me/api/mail/v4/filters',
    ])
  })

  it('call nothing when the page is not signed in', async () => {
    const { api, calls } = page({ session: null })
    expect(await api.filters()).toMatchObject({ ok: false, error: 'signed-out' })
    expect(calls).toEqual([])
  })

  it.each([
    [401, { Code: 401 }, 'signed-out'],
    [400, { Code: 5003, Error: 'Update required' }, 'app-version'],
    [422, { Code: 2501, Error: 'Not found' }, 'not-found'],
    [429, {}, 'busy'],
    [422, { Code: 2001, Error: 'Invalid sieve' }, 'proton-error'],
  ])('turn HTTP %i into %j as %s', async (status, body, error) => {
    const { api } = page({ answer: () => ({ status, body }) })
    expect(await api.filters()).toMatchObject({ ok: false, error })
  })

  it('take Accepted as success, which is how Proton answers an application it does in the background', async () => {
    const accepted = page({ answer: () => ({ status: 202, body: {} }) })
    expect(await accepted.api.apply('f1==')).toEqual({ ok: true, value: undefined })
  })

  it('name the code when Proton gives no reason', async () => {
    const { api } = page({ answer: () => ({ status: 200, body: { Code: 1234 } }) })
    expect(await api.filters()).toEqual({ ok: false, error: 'proton-error', message: 'HTTP 200, code 1234' })
  })

  it('say when Proton wants the password again', async () => {
    const { api } = page({ answer: () => ({ status: 403, body: { Code: 9101, Error: 'Unlock' } }) })
    expect(await api.filters()).toMatchObject({ ok: false, error: 'proton-error', message: expect.stringContaining('password again') })
  })

  it('read the filters into the shape the server knows', async () => {
    const { api } = page({
      answer: () => ({
        body: { Code: 1000, Filters: [{ ID: 'a==', Name: 'Travel', Status: 1, Priority: 3, Version: 2, Sieve: 'x' }, { ID: 'b==', Name: 'Old', Status: 0, Priority: 1, Version: 1, Sieve: null }] },
      }),
    })
    expect(await api.filters()).toEqual({
      ok: true,
      value: [
        { id: 'a==', name: 'Travel', enabled: true, order: 3, version: 2, sieve: 'x' },
        { id: 'b==', name: 'Old', enabled: false, order: 1, version: 1, sieve: '' },
      ],
    })
  })

  it("count Proton's issue lines from one, as people do", async () => {
    const { api } = page({ answer: () => ({ body: { Code: 1000, Issues: [{ from: { line: 0 }, message: 'unknown command' }] } }) })
    expect(await api.check('x')).toEqual({ ok: true, value: ['line 1: unknown command'] })
  })

  it('add a filter switched on, in the grammar it was checked against', async () => {
    const { api, calls } = page({ answer: () => ({ body: { Code: 1000, Filter: { ID: 'new==' } } }) })
    expect(await api.add('Travel', 'x')).toEqual({ ok: true, value: 'new==' })
    const call = calls.find((c) => c.url === `${API}/mail/v4/filters`)
    expect(call?.init?.method).toBe('POST')
    expect(JSON.parse(String(call?.init?.body))).toEqual({ ID: '', Name: 'Travel', Status: 1, Version: 2, Sieve: 'x' })
  })

  it('never switch a filter on or off with a change: its status goes back as stored', async () => {
    const { api, calls } = page({})
    await api.update({ id: 'b==', name: 'Old', enabled: false, order: 1, version: 1, sieve: '' }, 'Old', 'new script')
    await api.update({ id: 'a==', name: 'Travel', enabled: true, order: 3, version: 2, sieve: '' }, 'Travel', 'new script')
    const bodies = calls.filter((c) => c.url.startsWith(`${API}/mail/v4/filters/`)).map((c) => JSON.parse(String(c.init?.body)) as { Status: number })
    expect(bodies.map((body) => body.Status)).toEqual([0, 1])
    expect(calls.filter((c) => c.url.startsWith(`${API}/`)).every((c) => c.init?.method === 'PUT')).toBe(true)
  })

  it('compare addresses without case', async () => {
    const { api } = page({ answer: () => ({ body: { Code: 1000, Addresses: [{ Email: 'Me@Example.com' }, { Email: 'other@example.net' }] } }) })
    expect(await api.addresses()).toEqual({ ok: true, value: ['me@example.com', 'other@example.net'] })
  })
})

describe('the difference shown before a change', () => {
  it('marks what is dropped as well as what is added', () => {
    expect(diffLines('a\nb\nc\n', 'a\nc\nd\n')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'same', text: 'c' },
      { kind: 'added', text: 'd' },
    ])
  })

  it('treats Windows line ends like any other', () => {
    expect(diffLines('a\r\nb', 'a\nb\n').every((line) => line.kind === 'same')).toBe(true)
  })
})

describe('messages between the parts', () => {
  it('pass only in the known shapes', () => {
    expect(parseContentOp({ op: 'filters' })).toEqual({ op: 'filters' })
    expect(parseContentOp({ op: 'delete', id: 'a' })).toBeUndefined()
    expect(parseContentOp({ op: 'update', filter: { id: 'a' }, name: 'x', sieve: 'y' })).toBeUndefined()
    expect(parsePageMessage({ type: 'decide', id: 'not-a-uuid', accept: true })).toBeUndefined()
    expect(parsePageMessage({ type: 'decide', id: '123e4567-e89b-42d3-a456-426614174000', accept: 'yes' })).toBeUndefined()
    expect(parsePageMessage({ type: 'decide', id: '123e4567-e89b-42d3-a456-426614174000', accept: true })).toBeDefined()
  })
})

describe('the manifest', () => {
  const config = readFileSync(new URL('../../extension/wxt.config.ts', import.meta.url), 'utf8')

  it('carries the key that gives the id the connector lets in', () => {
    const key = /key: '([A-Za-z0-9+/=]+)'/.exec(config)?.[1]
    expect(key).toBeDefined()
    const digest = createHash('sha256').update(Buffer.from(key!, 'base64')).digest('hex').slice(0, 32)
    const id = [...digest].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join('')
    expect(id).toBe(EXTENSION_ID)
  })

  it('asks for three permissions and two sites, and lets no web page talk to it', () => {
    expect(config).toContain("permissions: ['nativeMessaging', 'storage', 'alarms']")
    expect(config).toContain("host_permissions: ['https://mail.proton.me/*', 'https://account.proton.me/*']")
    expect(config).not.toMatch(/externally_connectable\s*:/)
  })
})

describe('applying a filter to the mail already there', () => {
  it("sends the request Proton's own settings send, for the one filter", async () => {
    const { api, calls } = page({})
    expect(await api.apply('f1==')).toEqual({ ok: true, value: undefined })
    const call = calls.find((c) => c.url === `${API}/mail/v4/messages/apply-filters`)
    expect(call?.init?.method).toBe('POST')
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      SearchContext: null,
      Version: null,
      Sieve: null,
      AllFilters: 0,
      FilterIDs: ['f1=='],
      AllowList: 0,
      BlockList: 0,
      SpamList: 0,
    })
  })

  it('passes between the parts only with a plain filter id, and the box only as true or false', () => {
    const apply = { op: 'apply', account: 'me@example.com', filterId: 'f1==', sieve: 'x', allowed: [] }
    expect(parseContentOp(apply)).toEqual(apply)
    // What was allowed travels along, as known names only.
    expect(parseContentOp({ ...apply, allowed: ['discard'] })).toEqual({ ...apply, allowed: ['discard'] })
    expect(parseContentOp({ ...apply, allowed: ['redirect'] })).toBeUndefined()
    expect(parseContentOp({ op: 'apply', account: 'me@example.com', filterId: 'f1==', sieve: 'x' })).toBeUndefined()
    expect(parseContentOp({ ...apply, filterId: 'a/b' })).toBeUndefined()
    // Without the account a write cannot be checked against the page.
    expect(parseContentOp({ op: 'apply', filterId: 'f1==', sieve: 'x' })).toBeUndefined()
    expect(parseContentOp({ op: 'add', name: 'A', sieve: 'x' })).toBeUndefined()
    const id = '123e4567-e89b-42d3-a456-426614174000'
    expect(parsePageMessage({ type: 'decide', id, accept: true, apply: false })).toEqual({ type: 'decide', id, accept: true, apply: false })
    expect(parsePageMessage({ type: 'decide', id, accept: true, apply: 'yes' })).toBeUndefined()
  })
})

describe('moving and waiting (#59, 06.11.2026)', () => {
  it("sends the new order as every id, the way Proton's settings do", async () => {
    const { api, calls } = page({})
    expect(await api.order(['b==', 'a=='])).toEqual({ ok: true, value: undefined })
    const call = calls.find((c) => c.url === `${API}/mail/v4/filters/order`)
    expect(call?.init?.method).toBe('PUT')
    expect(JSON.parse(String(call?.init?.body))).toEqual({ FilterIDs: ['b==', 'a=='] })
  })

  it('tells Proton being busy apart from a refusal, by the answer measured on 06.11.2026', async () => {
    const busy = page({ answer: () => ({ status: 422, body: { Code: 2500, Error: 'Another action is currently in progress. Try again later' } }) })
    expect(await busy.api.apply('f1==')).toMatchObject({ ok: false, error: 'in-progress' })
    const conflict = page({ answer: () => ({ status: 409, body: {} }) })
    expect(await conflict.api.apply('f1==')).toMatchObject({ ok: false, error: 'in-progress' })
  })

  it('passes the order between the parts only as plain ids, and a cancel only with a proper id', () => {
    const order = { op: 'order', account: 'me@example.com', ids: ['a==', 'b=='] }
    expect(parseContentOp(order)).toEqual(order)
    expect(parseContentOp({ ...order, ids: ['a==', 'a/b'] })).toBeUndefined()
    expect(parseContentOp({ op: 'order', ids: ['a==', 'b=='] })).toBeUndefined()
    expect(parsePageMessage({ type: 'cancel', id: '123e4567-e89b-42d3-a456-426614174000' })).toBeDefined()
    expect(parsePageMessage({ type: 'cancel', id: 'everything' })).toBeUndefined()
  })
})

describe("the extension's own switches (#59, review of 06.11.2026)", () => {
  it('start all off, so the window always shows until the user turns one on', () => {
    expect(NO_SWITCHES).toEqual({ save: false, apply: false, reorder: false, delete: false, status: false })
  })

  it('read the three switches stored before deleting and switching came, the new ones off', () => {
    expect(readSwitches({ save: true, apply: false, reorder: true })).toEqual({ ...NO_SWITCHES, save: true, reorder: true })
    expect(readSwitches({ save: 'yes' })).toEqual(NO_SWITCHES)
    expect(readSwitches({ save: true, forward: true })).toEqual(NO_SWITCHES)
    expect(readSwitches(undefined)).toEqual(NO_SWITCHES)
  })

  it('pass only as five plain yes-or-no values', () => {
    const switches = { save: true, apply: false, reorder: false, delete: false, status: true }
    expect(parseSwitches(switches)).toEqual(switches)
    expect(parseSwitches({ ...switches, apply: 'yes' })).toBeUndefined()
    expect(parseSwitches({ save: true, apply: false, reorder: false })).toBeUndefined()
    expect(parseSwitches({ ...switches, forward: true })).toBeUndefined()
    expect(parseSwitches([true, false, false])).toBeUndefined()
    expect(parsePageMessage({ type: 'switches', switches })).toEqual({ type: 'switches', switches })
    expect(parsePageMessage({ type: 'switches', switches: { ...switches, save: 1 } })).toBeUndefined()
  })
})

describe('the last step before Proton (#59, review of 06.11.2026)', () => {
  const GUARD = SPAM_GUARD_PROLOGUE.replace('"spamtest"];', '"spamtest", "fileinto"];')
  const good = `${GUARD}\nif address :is "from" "a@example.com" {\n    fileinto "Travel";\n}\n`
  const discards = `${GUARD}\nif address :is "from" "a@example.com" {\n    discard;\n}\n`

  /** A Proton page signed in to me@example.com, with these filters. */
  function proton(filters: Array<{ ID: string; Name: string; Sieve: string }>) {
    return page({
      answer: (call) => {
        if (call.url === `${API}/core/v4/addresses`) return { body: { Code: 1000, Addresses: [{ Email: 'Me@Example.com' }] } }
        if (call.url === `${API}/mail/v4/filters` && (call.init?.method ?? 'GET') === 'GET') {
          return { body: { Code: 1000, Filters: filters.map((f, i) => ({ ...f, Status: 1, Priority: i + 1, Version: 2 })) } }
        }
        if (call.url === `${API}/mail/v4/messages/apply-filters`) return { status: 202, body: {} }
        if (call.init?.method === 'DELETE' || /\/(enable|disable)$/.test(call.url)) return { body: { Code: 1000 } }
        return { body: { Code: 1000, Filter: { ID: 'new==' } } }
      },
    })
  }
  const writes = (calls: Call[]) => calls.filter((call) => call.init?.method && call.init.method !== 'GET')

  it('writes nothing when the page is signed in to another account', async () => {
    const { api, calls } = proton([])
    expect(await runContentOp(api, { op: 'add', account: 'someone@example.net', name: 'A', sieve: good , allowed: [] })).toMatchObject({
      ok: false,
      error: 'wrong-account',
    })
    expect(writes(calls)).toEqual([])
  })

  it('saves a script that passes the rules, and nothing else', async () => {
    const { api, calls } = proton([])
    expect(await runContentOp(api, { op: 'add', account: 'me@example.com', name: 'A', sieve: good , allowed: [] })).toEqual({ ok: true, value: 'new==' })
    expect(await runContentOp(api, { op: 'add', account: 'me@example.com', name: 'B', sieve: discards , allowed: [] })).toMatchObject({
      ok: false,
      error: 'refused',
    })
    expect(writes(calls)).toHaveLength(1)
  })

  it('applies only the script that was agreed to, and only one that passes the rules', async () => {
    const { api, calls } = proton([
      { ID: 'f1==', Name: 'Travel', Sieve: good },
      { ID: 'f2==', Name: 'Gone', Sieve: discards },
    ])
    expect(await runContentOp(api, { op: 'apply', account: 'me@example.com', filterId: 'f1==', sieve: good.replace(/\n/g, '\r\n') , allowed: [] })).toEqual({
      ok: true,
      value: undefined,
    })
    expect(await runContentOp(api, { op: 'apply', account: 'me@example.com', filterId: 'f1==', sieve: discards , allowed: [] })).toMatchObject({
      error: 'refused',
      message: expect.stringContaining('changed since'),
    })
    expect(await runContentOp(api, { op: 'apply', account: 'me@example.com', filterId: 'f2==', sieve: discards , allowed: [] })).toMatchObject({ error: 'refused' })
    expect(await runContentOp(api, { op: 'apply', account: 'me@example.com', filterId: 'f3==', sieve: good , allowed: [] })).toMatchObject({ error: 'not-found' })
    expect(writes(calls).map((call) => call.url)).toEqual([`${API}/mail/v4/messages/apply-filters`])
  })

  it('takes a new order only with every filter exactly once', async () => {
    const { api, calls } = proton([
      { ID: 'a==', Name: 'A', Sieve: good },
      { ID: 'b==', Name: 'B', Sieve: good },
    ])
    for (const ids of [['a=='], ['a==', 'a=='], ['a==', 'b==', 'c=='], ['a==', 'c==']]) {
      expect(await runContentOp(api, { op: 'order', account: 'me@example.com', ids })).toMatchObject({ error: 'refused' })
    }
    expect(writes(calls)).toEqual([])
    expect(await runContentOp(api, { op: 'order', account: 'me@example.com', ids: ['b==', 'a=='] })).toEqual({ ok: true, value: undefined })
  })

  it('adds a filter that deletes only where the popup allowed it', async () => {
    const { api } = proton([])
    expect(await runContentOp(api, { op: 'add', account: 'me@example.com', name: 'B', sieve: discards, allowed: ['discard'] })).toEqual({
      ok: true,
      value: 'new==',
    })
  })

  it('deletes and switches only the filter as it was agreed to, in the right account', async () => {
    const { api, calls } = proton([
      { ID: 'f1==', Name: 'Travel', Sieve: good },
      { ID: 'f2==', Name: 'Gone', Sieve: discards },
    ])
    expect(await runContentOp(api, { op: 'delete', account: 'someone@example.net', filterId: 'f1==', sieve: good })).toMatchObject({
      error: 'wrong-account',
    })
    expect(await runContentOp(api, { op: 'delete', account: 'me@example.com', filterId: 'f1==', sieve: discards })).toMatchObject({
      error: 'refused',
      message: expect.stringContaining('changed since'),
    })
    expect(writes(calls)).toEqual([])
    expect(await runContentOp(api, { op: 'delete', account: 'me@example.com', filterId: 'f1==', sieve: good })).toEqual({ ok: true, value: undefined })
    // Switching on sets up what the filter does; switching off never needs an allowance.
    expect(
      await runContentOp(api, { op: 'status', account: 'me@example.com', filterId: 'f2==', enabled: true, sieve: discards, allowed: [] }),
    ).toMatchObject({ error: 'refused' })
    expect(
      await runContentOp(api, { op: 'status', account: 'me@example.com', filterId: 'f2==', enabled: false, sieve: discards, allowed: [] }),
    ).toEqual({ ok: true, value: undefined })
    expect(
      await runContentOp(api, { op: 'status', account: 'me@example.com', filterId: 'f2==', enabled: true, sieve: discards, allowed: ['discard'] }),
    ).toEqual({ ok: true, value: undefined })
    expect(writes(calls).map((call) => `${call.init?.method} ${call.url.replace(API, '')}`)).toEqual([
      'DELETE /mail/v4/filters/f1%3D%3D',
      'PUT /mail/v4/filters/f2%3D%3D/disable',
      'PUT /mail/v4/filters/f2%3D%3D/enable',
    ])
  })
})

describe('the messages for deleting and switching (06.11.2026)', () => {
  it('pass between the parts only in their shapes', () => {
    const remove = { op: 'delete', account: 'me@example.com', filterId: 'f1==', sieve: 'x' }
    expect(parseContentOp(remove)).toEqual(remove)
    expect(parseContentOp({ ...remove, filterId: 'a/b' })).toBeUndefined()
    const status = { op: 'status', account: 'me@example.com', filterId: 'f1==', enabled: true, sieve: 'x', allowed: ['stop'] }
    expect(parseContentOp(status)).toEqual(status)
    expect(parseContentOp({ ...status, enabled: 'yes' })).toBeUndefined()
    expect(parsePageMessage({ type: 'unlocks', actions: ['trash', 'stop'] })).toEqual({ type: 'unlocks', actions: ['trash', 'stop'] })
    expect(parsePageMessage({ type: 'unlocks', actions: ['forward'] })).toBeUndefined()
    expect(parsePageMessage({ type: 'unlocks', actions: ['trash', 'trash'] })).toBeUndefined()
  })
})
