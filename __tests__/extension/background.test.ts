import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ProtonApi, type PageEnvironment } from '../../extension/lib/proton-api.js'
import { parseContentOp } from '../../extension/lib/ops.js'
import { runContentOp } from '../../extension/lib/content-ops.js'
import { EXTENSION_ID, parseResponse } from '../../src/browser/messages.js'
import { SPAM_GUARD_PROLOGUE } from '../../src/filters/sieve.js'

/**
 * The background of the extension (#59), with a stand-in for Chrome and for
 * Proton. It is the part that decides whether a change needs the user's yes,
 * takes that yes once, and holds what Proton cannot take yet. The findings of
 * the review of 06.11.2026 that live here are played through one by one.
 */

// The extension reads Chrome's API from globalThis when it is loaded, so the
// stand-in has to be there first. Its parts are swapped before every test.
const chrome: Record<string, unknown> = {}
;(globalThis as Record<string, unknown>).chrome = chrome

// Loaded by a name TypeScript does not follow: the background is type checked
// with the extension's own configuration, which knows Chrome's types, and
// this project's configuration would read WXT's types without them. Here it
// is only run.
const BACKGROUND = '../../extension/entrypoints/background.js'
const { default: background } = (await import(/* @vite-ignore */ BACKGROUND)) as { default: { main(): void } }

type Fn = (...args: never[]) => unknown
interface FakeEvent {
  listeners: Fn[]
  addListener(listener: Fn): void
}
const event = (): FakeEvent => {
  const listeners: Fn[] = []
  return { listeners, addListener: (listener) => void listeners.push(listener) }
}

class Area {
  readonly data = new Map<string, unknown>()
  async get(key: string): Promise<Record<string, unknown>> {
    return this.data.has(key) ? { [key]: structuredClone(this.data.get(key)) } : {}
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.data.set(key, structuredClone(value))
  }
  async remove(key: string): Promise<void> {
    this.data.delete(key)
  }
}

interface Message {
  type: string
  id?: string
  body?: unknown
}

class FakePort {
  readonly onMessage = event()
  readonly onDisconnect = event()
  readonly sent: Message[] = []
  postMessage(message: Message): void {
    this.sent.push(structuredClone(message))
  }
}

const ACCOUNT = 'me@example.com'
const GUARD = SPAM_GUARD_PROLOGUE.replace('"spamtest"];', '"spamtest", "fileinto"];')
const GOOD = `${GUARD}\nif address :is "from" "a@example.com" {\n    fileinto "Travel";\n}\n`
const OTHER = GOOD.replace('"Travel"', '"Trips"')
const DISCARDS = GOOD.replace('fileinto "Travel";', 'discard;')

interface RawFilter {
  ID: string
  Name: string
  Status: number
  Priority: number
  Version: number
  Sieve: string
}

/** Proton as far as the extension sees it, for one account. */
function fakeProton() {
  const model = {
    filters: [] as RawFilter[],
    busy: false,
    applied: [] as string[],
    issues: [] as Array<{ from: { line: number }; message: string }>,
    /** When set, an application waits here before Proton answers. */
    hold: undefined as Promise<void> | undefined,
    reached: undefined as (() => void) | undefined,
    /** When set, the next addition goes through, but its answer is lost. */
    loseAnswer: false,
    /** When set, the page script deletes without checking, so the background's own check stands alone. */
    trustingPage: false,
    next: 1,
  }
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })
  const env: PageEnvironment = {
    location: { origin: 'https://mail.proton.me', hostname: 'mail.proton.me', pathname: '/u/0/inbox' },
    storage: { getItem: (key) => (key === 'ps-0' ? JSON.stringify({ UID: 'uid' }) : null) },
    fetch: async (url, init) => {
      const method = init?.method ?? 'GET'
      const path = decodeURIComponent(url.replace('https://mail.proton.me', ''))
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      if (path === '/assets/version.json') return json({ version: '5.0.0' })
      if (path === '/api/core/v4/addresses') return json({ Code: 1000, Addresses: [{ Email: ACCOUNT }] })
      if (path === '/api/mail/v4/filters' && method === 'GET') return json({ Code: 1000, Filters: model.filters })
      if (path === '/api/mail/v4/filters/check') return json({ Code: 1000, Issues: model.issues })
      if (path === '/api/mail/v4/filters' && method === 'POST') {
        const filter = { ID: `n${model.next++}==`, Name: String(body.Name), Status: 1, Priority: model.filters.length + 1, Version: 2, Sieve: String(body.Sieve) }
        model.filters.push(filter)
        if (model.loseAnswer) {
          model.loseAnswer = false
          throw new Error('the answer was lost')
        }
        return json({ Code: 1000, Filter: { ID: filter.ID } })
      }
      if (path === '/api/mail/v4/filters/order') {
        const ids = body.FilterIDs as string[]
        for (const filter of model.filters) filter.Priority = ids.indexOf(filter.ID) + 1
        return json({ Code: 1000 })
      }
      if (path.startsWith('/api/mail/v4/filters/') && method === 'DELETE') {
        const index = model.filters.findIndex((candidate) => candidate.ID === path.slice('/api/mail/v4/filters/'.length))
        if (index < 0) return json({ Code: 2501, Error: 'Not found' }, 422)
        model.filters.splice(index, 1)
        return json({ Code: 1000 })
      }
      const toggle = /^\/api\/mail\/v4\/filters\/(.+)\/(enable|disable)$/.exec(path)
      if (toggle && method === 'PUT') {
        const filter = model.filters.find((candidate) => candidate.ID === toggle[1])
        if (!filter) return json({ Code: 2501, Error: 'Not found' }, 422)
        filter.Status = toggle[2] === 'enable' ? 1 : 0
        return json({ Code: 1000 })
      }
      if (path.startsWith('/api/mail/v4/filters/') && method === 'PUT') {
        const filter = model.filters.find((candidate) => candidate.ID === path.slice('/api/mail/v4/filters/'.length))
        if (!filter) return json({ Code: 2501, Error: 'Not found' }, 422)
        Object.assign(filter, { Name: String(body.Name), Sieve: String(body.Sieve) })
        return json({ Code: 1000 })
      }
      if (path === '/api/mail/v4/messages/apply-filters') {
        if (model.busy) return json({ Code: 2500, Error: 'Another action is currently in progress. Try again later' }, 422)
        model.reached?.()
        if (model.hold) await model.hold
        model.applied.push(...(body.FilterIDs as string[]))
        // Then Proton works through the mail, which on a large mailbox takes
        // hours, and refuses every other application meanwhile.
        model.busy = true
        return json({}, 202)
      }
      return json({ Code: 404 }, 404)
    },
  }
  const api = new ProtonApi(env)
  // As in the page: the message is read again, then handled.
  const handle = async (raw: unknown): Promise<unknown> => {
    const op = parseContentOp(structuredClone(raw))
    if (!op) return undefined
    if (model.trustingPage && op.op === 'delete') return api.delete(op.filterId)
    return runContentOp(api, op)
  }
  return { model, handle }
}

let port: FakePort
let proton: ReturnType<typeof fakeProton>
let local: Area
let session: Area
let windows: Array<{ id: string; tab: number }>
let alarms: Array<{ name: string; when: number }>
let onMessage: FakeEvent
let onAlarm: FakeEvent

const PROTON_TAB = 7

/** A fresh Chrome with one signed-in Proton tab, before the extension starts. */
function freshChrome(): void {
  proton = fakeProton()
  local = new Area()
  session = new Area()
  windows = []
  alarms = []
  onMessage = event()
  onAlarm = event()
  let nextTab = 100
  Object.assign(chrome, {
    runtime: {
      id: EXTENSION_ID,
      lastError: undefined,
      getURL: (path: string) => `chrome-extension://${EXTENSION_ID}${path}`,
      getManifest: () => ({ version: '0.5.0' }),
      connectNative: () => (port = new FakePort()),
      onMessage,
      onStartup: event(),
      onInstalled: event(),
    },
    storage: { local, session },
    alarms: { create: (name: string, info: { when: number }) => void alarms.push({ name, when: info.when }), onAlarm },
    tabs: {
      query: async () => [{ id: PROTON_TAB }],
      sendMessage: async (tab: number, op: unknown) => {
        if (tab !== PROTON_TAB) throw new Error('Could not establish connection. Receiving end does not exist.')
        return proton.handle(op)
      },
    },
    windows: {
      create: async ({ url }: { url: string }) => {
        const tab = nextTab++
        windows.push({ id: url.slice(url.indexOf('#') + 1), tab })
        return { tabs: [{ id: tab }] }
      },
    },
  })
}

/** Starts the extension's background, as Chrome does. */
async function start(): Promise<void> {
  background.main()
  // The background settles its queue first; give it the moment it needs.
  await vi.waitFor(async () => expect((await session.get('queueSession')).queueSession).toBe(true))
}

let requests = 0
/** A request from the server, through the connector. */
async function ask(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = `h${++requests}`
  for (const listener of port.onMessage.listeners) void (listener as (message: unknown) => unknown)({ type: 'request', id, body })
  const answer = await vi.waitFor(
    () => {
      const found = port.sent.find((message) => message.id === id)
      if (!found) throw new Error('no answer yet')
      return found.body as Record<string, unknown>
    },
    { timeout: 3_000, interval: 2 },
  )
  // Whatever the background answers has to pass the server's own reading.
  expect(parseResponse(answer)).toBeDefined()
  return answer
}

/** A message from a page of the extension: the confirmation window or the popup. */
function fromPage(page: 'confirm' | 'popup', message: unknown, tab?: number): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const sender = {
      id: EXTENSION_ID,
      url: `chrome-extension://${EXTENSION_ID}/${page}.html${page === 'confirm' ? '#x' : ''}`,
      ...(tab !== undefined ? { tab: { id: tab } } : {}),
    }
    for (const listener of onMessage.listeners) {
      const kept = (listener as (raw: unknown, from: unknown, reply: (answer: unknown) => void) => unknown)(message, sender, (answer) =>
        resolve(answer as Record<string, unknown>),
      )
      if (kept !== true) resolve(undefined)
    }
  })
}

const propose = (extra: Record<string, unknown> = {}, proposal: Record<string, unknown> = {}) =>
  ask({ kind: 'propose_filter', account: ACCOUNT, confirm: true, applyAllowed: true, proposal: { name: 'Travel', sieve: GOOD, ...proposal }, ...extra })

const switches = (on: Partial<Record<'save' | 'apply' | 'reorder' | 'delete' | 'status', boolean>>) =>
  local.set({ switches: { save: false, apply: false, reorder: false, delete: false, status: false, ...on } })

const changes = async () => ((await local.get('changes')).changes ?? []) as Array<Record<string, unknown>>
const queue = async () => ((await local.get('queue')).queue ?? []) as Array<Record<string, unknown>>
/** As if the time of every waiting entry had come; the alarm itself is fired by hand. */
const timeComes = async () => local.set({ queue: (await queue()).map((entry) => ({ ...entry, nextAt: 0 })) })
const fireAlarm = () => {
  for (const listener of onAlarm.listeners) (listener as (alarm: { name: string }) => void)({ name: 'proton-mcp-queue' })
}

beforeEach(async () => {
  freshChrome()
  await start()
})

describe('the window', () => {
  it('shows by default, even when the server says it may act on its own', async () => {
    // Found in the review: a program that read the connector's secret could
    // send confirm: false. The extension's own switch is off by default.
    expect(await propose({ confirm: false })).toMatchObject({ ok: true, outcome: 'shown' })
    expect(windows).toHaveLength(1)
    expect(proton.model.filters).toEqual([])
  })

  it('stays away only where both the server and the switch here allow it', async () => {
    await switches({ save: true })
    expect(await propose({ confirm: true })).toMatchObject({ outcome: 'shown' })
    expect(await propose({ confirm: false }, { name: 'Trips', sieve: OTHER })).toMatchObject({ outcome: 'added' })
    expect(windows).toHaveLength(1)
    expect(proton.model.filters.map((filter) => filter.Name)).toEqual(['Trips'])
  })

  it('asks in a window of its own before applying, when only saving may go without one', async () => {
    await switches({ save: true })
    const answer = await propose({ confirm: false }, { apply: true })
    expect(answer).toMatchObject({ outcome: 'added', apply: 'shown' })
    expect(proton.model.applied).toEqual([])
    expect(windows).toHaveLength(1)
    const pending = (await session.get(`proposal:${windows[0]!.id}`))[`proposal:${windows[0]!.id}`] as Record<string, unknown>
    expect(pending).toMatchObject({ kind: 'apply', filter: { name: 'Travel' } })
  })

  it('counts a decision once, however often it is clicked', async () => {
    await propose()
    const { id, tab } = windows[0]!
    const answers = await Promise.all([
      fromPage('confirm', { type: 'decide', id, accept: true }, tab),
      fromPage('confirm', { type: 'decide', id, accept: true }, tab),
    ])
    expect(answers.filter((answer) => answer?.ok === true)).toHaveLength(1)
    expect(answers.map((answer) => answer?.message)).toContain('This proposal is no longer open. Nothing was changed.')
    expect(proton.model.filters).toHaveLength(1)
  })

  it('takes the decision only from the tab it opened, and keeps the proposal for that one', async () => {
    await propose()
    const { id, tab } = windows[0]!
    expect(await fromPage('confirm', { type: 'decide', id, accept: true }, tab + 1)).toMatchObject({ ok: false })
    expect(await fromPage('confirm', { type: 'decide', id, accept: true })).toMatchObject({ ok: false })
    expect(proton.model.filters).toEqual([])
    expect(await fromPage('confirm', { type: 'decide', id, accept: true }, tab)).toMatchObject({ ok: true })
    expect(proton.model.filters).toHaveLength(1)
  })

  it('applies only when applying is allowed at all, whatever the box or the request says', async () => {
    await propose({ applyAllowed: false }, { apply: true })
    const { id, tab } = windows[0]!
    await fromPage('confirm', { type: 'decide', id, accept: true, apply: true }, tab)
    expect(proton.model.filters).toHaveLength(1)
    expect(proton.model.applied).toEqual([])
  })

  it('applies after the yes when the box is ticked', async () => {
    await propose({}, { apply: true })
    const { id, tab } = windows[0]!
    expect(await fromPage('confirm', { type: 'decide', id, accept: true, apply: true }, tab)).toMatchObject({ ok: true })
    expect(proton.model.applied).toEqual(['n1=='])
  })

  it('lets only the popup change the switches', async () => {
    const on = { save: true, apply: true, reorder: true, delete: true, status: true }
    expect(await fromPage('confirm', { type: 'switches', switches: on }, windows[0]?.tab ?? 100)).toBeUndefined()
    expect((await local.get('switches')).switches).toBeUndefined()
    expect(await fromPage('popup', { type: 'switches', switches: on })).toEqual({ ok: true })
    expect((await local.get('switches')).switches).toEqual(on)
  })
})

describe('the rules, once more in the extension', () => {
  it('does not replace a filter that does what an assistant may not set up', async () => {
    proton.model.filters.push({ ID: 'd1==', Name: 'Junk', Status: 1, Priority: 1, Version: 2, Sieve: DISCARDS })
    expect(await propose({}, { name: 'Junk', replaces: 'd1==' })).toMatchObject({ ok: false, error: 'refused' })
    expect(windows).toEqual([])
  })

  it('keeps a long reason short, so the list of changes still reaches the server', async () => {
    await switches({ save: true })
    proton.model.issues = [{ from: { line: 0 }, message: 'x'.repeat(5_000) }]
    expect(await propose({ confirm: false })).toMatchObject({ ok: false })
    expect(String((await changes())[0]?.detail).length).toBeLessThanOrEqual(500)
    expect(await ask({ kind: 'list_filters', account: ACCOUNT })).toMatchObject({ ok: true, kind: 'list_filters' })
  })
})

describe('trying again', () => {
  it('does not add a filter twice when the answer to the first try was lost', async () => {
    await switches({ save: true })
    proton.model.loseAnswer = true
    expect(await propose({ confirm: false })).toMatchObject({ ok: false })
    expect(await propose({ confirm: false })).toMatchObject({ ok: true, outcome: 'added', filterId: 'n1==' })
    expect(proton.model.filters).toHaveLength(1)
  })

  it('does not run a change agreed to when the filter changed since', async () => {
    proton.model.filters.push({ ID: 'f1==', Name: 'Travel', Status: 1, Priority: 1, Version: 2, Sieve: GOOD })
    await propose({}, { sieve: OTHER, replaces: 'f1==' })
    proton.model.filters[0]!.Sieve = GOOD.replace('"Travel"', '"Elsewhere"')
    const { id, tab } = windows[0]!
    expect(await fromPage('confirm', { type: 'decide', id, accept: true }, tab)).toMatchObject({
      ok: false,
      message: expect.stringContaining('changed since'),
    })
    expect(proton.model.filters[0]!.Sieve).toContain('"Elsewhere"')
  })
})

describe('moving', () => {
  it('does not move filters when the order changed since the move was agreed to', async () => {
    proton.model.filters.push(
      { ID: 'a==', Name: 'A', Status: 1, Priority: 1, Version: 2, Sieve: GOOD },
      { ID: 'b==', Name: 'B', Status: 1, Priority: 2, Version: 2, Sieve: OTHER },
      { ID: 'c==', Name: 'C', Status: 1, Priority: 3, Version: 2, Sieve: GOOD },
    )
    expect(await ask({ kind: 'reorder_filters', account: ACCOUNT, moves: [{ id: 'c==', position: 1 }], confirm: true })).toMatchObject({
      outcome: 'shown',
    })
    // Meanwhile someone puts B first in Proton's settings.
    proton.model.filters[0]!.Priority = 2
    proton.model.filters[1]!.Priority = 1
    const { id, tab } = windows[0]!
    expect(await fromPage('confirm', { type: 'decide', id, accept: true }, tab)).toMatchObject({
      ok: false,
      message: expect.stringContaining('order changed since'),
    })
    expect(proton.model.filters.map((filter) => filter.Priority)).toEqual([2, 1, 3])
  })

  it('moves them after the yes, in the order shown', async () => {
    proton.model.filters.push(
      { ID: 'a==', Name: 'A', Status: 1, Priority: 1, Version: 2, Sieve: GOOD },
      { ID: 'b==', Name: 'B', Status: 1, Priority: 2, Version: 2, Sieve: OTHER },
    )
    await ask({ kind: 'reorder_filters', account: ACCOUNT, moves: [{ id: 'b==', position: 1 }], confirm: true })
    const { id, tab } = windows[0]!
    expect(await fromPage('confirm', { type: 'decide', id, accept: true }, tab)).toMatchObject({ ok: true })
    expect(proton.model.filters.map((filter) => [filter.ID, filter.Priority])).toEqual([
      ['a==', 2],
      ['b==', 1],
    ])
  })
})

describe('the queue', () => {
  beforeEach(async () => {
    await switches({ save: true, apply: true, reorder: true })
    proton.model.filters.push(
      { ID: 'f1==', Name: 'Travel', Status: 1, Priority: 1, Version: 2, Sieve: GOOD },
      { ID: 'f2==', Name: 'Trips', Status: 1, Priority: 2, Version: 2, Sieve: OTHER },
    )
  })
  const apply = (filterId: string) => ask({ kind: 'apply_filter', account: ACCOUNT, filterId, confirm: false })

  it('holds an application while Proton is busy, and nothing else', async () => {
    proton.model.busy = true
    expect(await apply('f1==')).toMatchObject({ outcome: 'queued' })
    // A second application waits behind the first without asking Proton.
    expect(await apply('f2==')).toMatchObject({ outcome: 'queued' })
    expect(await propose({ confirm: false }, { name: 'New', sieve: GOOD })).toMatchObject({ outcome: 'added' })
    expect(await ask({ kind: 'reorder_filters', account: ACCOUNT, moves: [{ id: 'f2==', position: 1 }], confirm: false })).toMatchObject({
      outcome: 'reordered',
    })
    expect((await queue()).map((entry) => (entry.work as { filterId: string }).filterId)).toEqual(['f1==', 'f2=='])

    proton.model.busy = false
    await timeComes()
    fireAlarm()
    await vi.waitFor(() => expect(proton.model.applied).toEqual(['f1==']))
    // Proton runs one at a time, so the second waits for its own turn.
    expect(await queue()).toHaveLength(1)
  })

  it('does not call cancelled what is being tried right now', async () => {
    proton.model.busy = true
    await apply('f1==')
    proton.model.busy = false
    let release!: () => void
    proton.model.hold = new Promise((resolve) => (release = resolve))
    const reached = new Promise<void>((resolve) => (proton.model.reached = resolve))
    await timeComes()
    fireAlarm()
    await reached
    const [entry] = await queue()
    expect(await fromPage('popup', { type: 'cancel', id: entry!.id })).toMatchObject({
      ok: false,
      message: expect.stringContaining('being tried right now'),
    })
    release()
    await vi.waitFor(async () => expect(await queue()).toEqual([]))
    expect(proton.model.applied).toEqual(['f1=='])
    expect((await changes()).map((change) => change.outcome)).not.toContain('cancelled')
  })

  it('cancels what still waits, and says so', async () => {
    proton.model.busy = true
    await apply('f1==')
    const [entry] = await queue()
    expect(await fromPage('popup', { type: 'cancel', id: entry!.id })).toMatchObject({ ok: true, message: 'Cancelled. It will not run.' })
    expect(await queue()).toEqual([])
    expect((await changes())[0]).toMatchObject({ outcome: 'cancelled' })
    expect(await fromPage('popup', { type: 'cancel', id: entry!.id })).toMatchObject({ ok: false })
  })

  it('wakes only for what can run', async () => {
    // Found in the review: the second application was due at once but could
    // not run before the first, and woke the background every 30 seconds.
    proton.model.busy = true
    await apply('f1==')
    await apply('f2==')
    await vi.waitFor(() => expect(alarms).toHaveLength(2))
    // The first waits a minute after its first try, and the second behind it.
    expect(alarms[1]!.when).toBeGreaterThanOrEqual(Date.now() + 55_000)
  })
})

describe('after Chrome or the extension restarted', () => {
  const waiting = (queuedAt: number) => ({
    id: '123e4567-e89b-42d3-a456-426614174000',
    account: ACCOUNT,
    how: 'confirmed',
    queuedAt,
    attempts: 3,
    nextAt: 0,
    work: { action: 'apply', name: 'Travel', filterId: 'f1==', sieve: GOOD },
  })

  beforeEach(() => {
    freshChrome()
    proton.model.filters.push({ ID: 'f1==', Name: 'Travel', Status: 1, Priority: 1, Version: 2, Sieve: GOOD })
  })

  it('drops what waited from before and notes it, even when an alarm comes first', async () => {
    await local.set({ queue: [waiting(Date.now() - 3_600_000)] })
    background.main()
    fireAlarm()
    await vi.waitFor(async () => expect((await session.get('queueSession')).queueSession).toBe(true))
    await vi.waitFor(async () => expect(await queue()).toEqual([]))
    expect(proton.model.applied).toEqual([])
    expect((await changes())[0]).toMatchObject({ outcome: 'failed', detail: expect.stringContaining('restarted') })
  })

  it('goes on with what waits when the background only went to sleep', async () => {
    await local.set({ queue: [waiting(Date.now() - 60_000)] })
    await session.set({ queueSession: true })
    background.main()
    await vi.waitFor(() => expect(proton.model.applied).toEqual(['f1==']))
  })
})

describe('what filters may do, allowed in the popup (06.11.2026)', () => {
  const DELETES = GOOD.replace('fileinto "Travel";', 'discard;')

  it('lets only the popup allow it', async () => {
    expect(await fromPage('confirm', { type: 'unlocks', actions: ['discard'] }, 100)).toBeUndefined()
    expect((await local.get('unlocks')).unlocks).toBeUndefined()
    expect(await fromPage('popup', { type: 'unlocks', actions: ['discard'] })).toEqual({ ok: true })
    expect((await fromPage('popup', { type: 'status' }))?.unlocks).toEqual(['discard'])
  })

  it('refuses what the popup did not allow, whatever the server checked', async () => {
    // A program that reached the connector cannot allow anything.
    expect(await propose({}, { name: 'Gone', sieve: DELETES })).toMatchObject({ ok: false, error: 'refused' })
    expect(windows).toEqual([])
  })

  it('takes it once allowed there, all the way to the page script', async () => {
    await local.set({ unlocks: ['discard'] })
    expect(await propose({}, { name: 'Gone', sieve: DELETES })).toMatchObject({ outcome: 'shown' })
    const { id, tab } = windows[0]!
    const pending = (await session.get(`proposal:${id}`))[`proposal:${id}`] as { effects: string[]; warnings: string[] }
    expect(pending.effects).toContain('deletes it at once and for good')
    expect(pending.warnings.join(' ')).toContain('deleted at once and for good')
    expect(await fromPage('confirm', { type: 'decide', id, accept: true }, tab)).toMatchObject({ ok: true })
    expect(proton.model.filters.map((filter) => filter.Name)).toEqual(['Gone'])
  })
})

describe('deleting and switching (06.11.2026)', () => {
  beforeEach(() => {
    proton.model.filters.push(
      { ID: 'f1==', Name: 'Travel', Status: 1, Priority: 1, Version: 2, Sieve: GOOD },
      { ID: 'f2==', Name: 'Gone', Status: 0, Priority: 2, Version: 2, Sieve: GOOD.replace('fileinto "Travel";', 'discard;') },
    )
  })
  const remove = (filterId: string, confirm = true) => ask({ kind: 'delete_filter', account: ACCOUNT, filterId, confirm })
  const status = (filterId: string, enabled: boolean, confirm = true) =>
    ask({ kind: 'set_filter_status', account: ACCOUNT, filterId, enabled, confirm })

  it('deletes after the yes in the window, and keeps the filter after a no', async () => {
    expect(await remove('f1==')).toMatchObject({ outcome: 'shown' })
    const first = windows[0]!
    const pending = (await session.get(`proposal:${first.id}`))[`proposal:${first.id}`] as { kind: string; effects: string[] }
    expect(pending).toMatchObject({ kind: 'delete', effects: ['files it into "Travel"'] })
    expect(await fromPage('confirm', { type: 'decide', id: first.id, accept: false }, first.tab)).toMatchObject({ ok: true })
    expect(proton.model.filters).toHaveLength(2)

    await remove('f1==')
    const second = windows[1]!
    expect(await fromPage('confirm', { type: 'decide', id: second.id, accept: true }, second.tab)).toMatchObject({
      ok: true,
      message: expect.stringContaining('Deleted'),
    })
    expect(proton.model.filters.map((filter) => filter.ID)).toEqual(['f2=='])
    expect((await changes())[0]).toMatchObject({ outcome: 'deleted', how: 'confirmed' })
  })

  it('shows the window for a deletion the server would let go without one, until the popup allows that too', async () => {
    expect(await remove('f1==', false)).toMatchObject({ outcome: 'shown' })
    await switches({ delete: true })
    expect(await remove('f1==', false)).toMatchObject({ outcome: 'deleted' })
    expect(proton.model.filters.map((filter) => filter.ID)).toEqual(['f2=='])
  })

  it('does not delete a filter that changed since the yes', async () => {
    await remove('f1==')
    proton.model.filters[0]!.Sieve = OTHER
    const { id, tab } = windows[0]!
    expect(await fromPage('confirm', { type: 'decide', id, accept: true }, tab)).toMatchObject({
      ok: false,
      message: expect.stringContaining('changed since'),
    })
    expect(proton.model.filters).toHaveLength(2)
  })

  it('checks in the background as well whether the filter changed since the yes', async () => {
    // Each layer on its own: here the page script checks nothing.
    proton.model.trustingPage = true
    await remove('f1==')
    proton.model.filters[0]!.Sieve = OTHER
    const { id, tab } = windows[0]!
    expect(await fromPage('confirm', { type: 'decide', id, accept: true }, tab)).toMatchObject({
      ok: false,
      message: expect.stringContaining('deleting it was agreed to'),
    })
    expect(proton.model.filters).toHaveLength(2)
  })

  it('switches a filter off after the yes, and changes nothing for one already in that state', async () => {
    expect(await status('f2==', false)).toMatchObject({ outcome: 'switched' })
    expect(windows).toEqual([])
    expect(await status('f1==', false)).toMatchObject({ outcome: 'shown' })
    const { id, tab } = windows[0]!
    expect(await fromPage('confirm', { type: 'decide', id, accept: true }, tab)).toMatchObject({ message: expect.stringContaining('Switched off') })
    expect(proton.model.filters[0]!.Status).toBe(0)
  })

  it('switches on a filter that deletes only where the popup allowed deleting', async () => {
    expect(await status('f2==', true)).toMatchObject({ ok: false, error: 'refused' })
    await local.set({ unlocks: ['discard'] })
    await switches({ status: true })
    expect(await status('f2==', true, false)).toMatchObject({ outcome: 'switched' })
    expect(proton.model.filters[1]!.Status).toBe(1)
    expect((await changes())[0]).toMatchObject({ outcome: 'enabled', how: 'without asking' })
  })
})
