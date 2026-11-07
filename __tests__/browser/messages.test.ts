import { describe, it, expect } from 'vitest'
import { parseRequest, parseResponse, isRequestId } from '../../src/browser/messages.js'
import { encodeNative, NativeReader, LineReader, FrameError, MAX_FROM_CHROME, MAX_REQUEST_LINE } from '../../src/browser/channel.js'
import { browserPaths, MAX_SOCKET_PATH, UnsupportedPlatform } from '../../src/browser/paths.js'

/**
 * The fixed list of what may pass between server, connector and extension, and
 * the framing underneath (#59). Anything outside the list is dropped, so the
 * tests are mostly about what does not get through.
 */

describe('requests', () => {
  it('pass in the three known shapes', () => {
    expect(parseRequest({ kind: 'status' })).toEqual({ kind: 'status' })
    expect(parseRequest({ kind: 'list_filters', account: 'me@example.com' })).toEqual({
      kind: 'list_filters',
      account: 'me@example.com',
    })
    expect(
      parseRequest({
        kind: 'propose_filter',
        account: 'me@example.com',
        confirm: true,
        applyAllowed: false,
        proposal: { name: 'A', sieve: 'x', replaces: 'abc-_==' },
      }),
    ).toMatchObject({ applyAllowed: false, proposal: { replaces: 'abc-_==' } })
  })

  it('do not pass with a kind that is not on the list', () => {
    for (const kind of ['delete_filter', 'disable_filter', 'eval', '__proto__', undefined]) {
      expect(parseRequest({ kind })).toBeUndefined()
    }
  })

  it('do not pass with a field nobody asked for, or a field of the wrong type', () => {
    expect(parseRequest({ kind: 'status', extra: 1 })).toBeUndefined()
    expect(parseRequest({ kind: 'list_filters', account: 'not an address' })).toBeUndefined()
    expect(parseRequest({ kind: 'propose_filter', account: 'me@example.com', confirm: 'yes', proposal: { name: 'A', sieve: 'x' } })).toBeUndefined()
    expect(
      parseRequest({ kind: 'propose_filter', account: 'me@example.com', confirm: false, proposal: { name: 'A', sieve: 'x', enabled: false } }),
    ).toBeUndefined()
    expect(
      parseRequest({ kind: 'propose_filter', account: 'me@example.com', confirm: false, proposal: { name: 'A', sieve: 'x', replaces: '../x' } }),
    ).toBeUndefined()
  })

  it('do not pass as an array, a class instance or a string', () => {
    expect(parseRequest(['status'])).toBeUndefined()
    expect(parseRequest(new (class { kind = 'status' })())).toBeUndefined()
    expect(parseRequest('status')).toBeUndefined()
  })
})

describe('answers', () => {
  it('pass in the known shapes and the error codes on the list', () => {
    expect(parseResponse({ ok: true, kind: 'status', extensionVersion: '0.5.0', protonTabs: 1 })).toBeDefined()
    expect(parseResponse({ ok: true, kind: 'propose_filter', outcome: 'shown' })).toBeDefined()
    expect(parseResponse({ ok: false, error: 'no-proton-tab', message: 'none open' })).toBeDefined()
  })

  it('do not pass with an unknown outcome or error code', () => {
    expect(parseResponse({ ok: true, kind: 'propose_filter', outcome: 'deleted' })).toBeUndefined()
    expect(parseResponse({ ok: false, error: 'something', message: '' })).toBeUndefined()
  })
})

describe('request ids', () => {
  it('are short and plain', () => {
    expect(isRequestId('b6c1f3a0-0000-4000-8000-000000000000')).toBe(true)
    expect(isRequestId('a'.repeat(65))).toBe(false)
    expect(isRequestId('a\nb')).toBe(false)
  })
})

describe('framing', () => {
  it('reads messages however the chunks are cut', () => {
    const bytes = Buffer.concat([encodeNative({ a: 1 }), encodeNative({ b: 'two' })])
    const reader = new NativeReader()
    const messages: unknown[] = []
    for (let i = 0; i < bytes.length; i += 3) messages.push(...reader.push(bytes.subarray(i, i + 3)))
    expect(messages).toEqual([{ a: 1 }, { b: 'two' }])
  })

  it('refuses a message larger than the connector accepts, before reading it', () => {
    const head = Buffer.alloc(4)
    head.writeUInt32LE(MAX_FROM_CHROME + 1)
    expect(() => new NativeReader().push(head)).toThrow(FrameError)
  })

  it('refuses to send Chrome more than it accepts', () => {
    expect(() => encodeNative({ big: 'x'.repeat(1024 * 1024) })).toThrow(FrameError)
  })

  it('splits socket lines and refuses one that never ends', () => {
    const reader = new LineReader()
    expect(reader.push('{"a":1}\n{"b"')).toEqual(['{"a":1}'])
    expect(reader.push(':2}\n')).toEqual(['{"b":2}'])
    expect(() => new LineReader(1024).push('x'.repeat(1025))).toThrow(FrameError)
  })

  it('holds an answer as large as Chrome may send, but takes only short lines as requests', () => {
    expect(new LineReader().max).toBe(MAX_FROM_CHROME)
    expect(MAX_REQUEST_LINE).toBeLessThan(MAX_FROM_CHROME)
    expect(() => new LineReader(MAX_REQUEST_LINE).push('x'.repeat(MAX_REQUEST_LINE + 1))).toThrow(FrameError)
  })

  it('reads a character cut between two chunks as that character', () => {
    // Found in the review of 06.11.2026: each chunk was decoded on its own,
    // and an umlaut cut in two came out as two replacement characters.
    const name = `B${String.fromCodePoint(0xfc)}cher` // u with diaeresis, two bytes in UTF-8
    const bytes = Buffer.from(`{"name":"${name}"}\n`, 'utf8')
    const cut = bytes.indexOf(0xc3) + 1
    const reader = new LineReader()
    expect(reader.push(bytes.subarray(0, cut))).toEqual([])
    expect(reader.push(bytes.subarray(cut))).toEqual([`{"name":"${name}"}`])
  })
})

describe('paths', () => {
  it('put the socket under the configuration directory on Linux and macOS', () => {
    expect(browserPaths({ platform: 'linux', home: '/home/a', env: {} }).socket).toBe('/home/a/.config/proton-mcp/run/browser.sock')
    expect(browserPaths({ platform: 'darwin', home: '/Users/a', env: {} }).manifestFile).toBe(
      '/Users/a/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.rndmjoker.proton_mcp.json',
    )
    expect(browserPaths({ platform: 'linux', home: '/home/a', env: {} }).manifestFile).toBe(
      '/home/a/.config/google-chrome/NativeMessagingHosts/com.rndmjoker.proton_mcp.json',
    )
  })

  it('fall back to a short fixed path when the home directory is too long for a socket', () => {
    const home = `/home/${'x'.repeat(MAX_SOCKET_PATH)}`
    expect(browserPaths({ platform: 'linux', home, env: {}, uid: 1000 }).socket).toBe('/tmp/proton-mcp-1000/browser.sock')
  })

  it('use a named pipe and a registry key on Windows', () => {
    const paths = browserPaths({ platform: 'win32', home: 'C:\\Users\\A B', env: {}, user: 'A B' })
    expect(paths.socket).toMatch(/^\\\\\.\\pipe\\proton-mcp-browser-A_B-[0-9a-f]{8}$/)
    expect(paths.registryKey).toBe('HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.rndmjoker.proton_mcp')
    expect(paths.launcher.endsWith('proton-mcp-browser-host.cmd')).toBe(true)
  })

  it('keep users apart on Windows whose names differ only in letters a pipe name cannot hold', () => {
    const pipe = (user: string): string => browserPaths({ platform: 'win32', home: 'C:\\Users\\x', env: {}, user }).socket
    // Two names that differ only in an umlaut, u and o with diaeresis.
    const first = `J${String.fromCodePoint(0xfc)}rgen`
    const second = `J${String.fromCodePoint(0xf6)}rgen`
    expect(pipe(first)).toMatch(/proton-mcp-browser-J_rgen-[0-9a-f]{8}$/)
    expect(pipe(first)).not.toBe(pipe(second))
  })

  it('say plainly when a system is not supported', () => {
    expect(() => browserPaths({ platform: 'freebsd' })).toThrow(UnsupportedPlatform)
  })
})

describe('applying (#59, added on 06.11.2026)', () => {
  it('passes as a request with exactly its fields', () => {
    expect(parseRequest({ kind: 'apply_filter', account: 'me@example.com', filterId: 'a==', confirm: true })).toEqual({
      kind: 'apply_filter',
      account: 'me@example.com',
      filterId: 'a==',
      confirm: true,
    })
    expect(parseRequest({ kind: 'apply_filter', account: 'me@example.com', filterId: 'a==', confirm: true, all: true })).toBeUndefined()
    expect(parseRequest({ kind: 'apply_filter', account: 'me@example.com', filterId: '../a', confirm: true })).toBeUndefined()
  })

  it('takes the box of a proposal only as true or false', () => {
    const base = { kind: 'propose_filter', account: 'me@example.com', confirm: true, applyAllowed: true }
    expect(parseRequest({ ...base, proposal: { name: 'A', sieve: 'x', apply: true } })).toMatchObject({ proposal: { apply: true } })
    expect(parseRequest({ ...base, proposal: { name: 'A', sieve: 'x', apply: 'yes' } })).toBeUndefined()
  })

  it('passes the answers, and nothing else', () => {
    expect(parseResponse({ ok: true, kind: 'apply_filter', outcome: 'applied' })).toBeDefined()
    expect(parseResponse({ ok: true, kind: 'apply_filter', outcome: 'deleted' })).toBeUndefined()
    expect(parseResponse({ ok: true, kind: 'propose_filter', outcome: 'added', apply: 'done' })).toMatchObject({ apply: 'done' })
  })
})

describe('moving and the queue (#59, 06.11.2026)', () => {
  it('passes a request to move with plain moves only', () => {
    const base = { kind: 'reorder_filters', account: 'me@example.com', confirm: true }
    expect(parseRequest({ ...base, moves: [{ id: 'a==', position: 1 }] })).toEqual({ ...base, moves: [{ id: 'a==', position: 1 }] })
    expect(parseRequest({ ...base, moves: [] })).toBeUndefined()
    expect(parseRequest({ ...base, moves: [{ id: 'a==', position: 0 }] })).toBeUndefined()
    expect(parseRequest({ ...base, moves: [{ id: 'a==', position: 1.5 }] })).toBeUndefined()
    expect(parseRequest({ ...base, moves: [{ id: 'a==', position: 1, also: 2 }] })).toBeUndefined()
  })

  it('passes queued as an outcome of every write', () => {
    expect(parseResponse({ ok: true, kind: 'propose_filter', outcome: 'queued' })).toBeDefined()
    expect(parseResponse({ ok: true, kind: 'apply_filter', outcome: 'queued' })).toBeDefined()
    expect(parseResponse({ ok: true, kind: 'reorder_filters', outcome: 'queued' })).toBeDefined()
    expect(parseResponse({ ok: true, kind: 'propose_filter', outcome: 'added', apply: 'queued' })).toMatchObject({ apply: 'queued' })
    expect(parseResponse({ ok: true, kind: 'propose_filter', outcome: 'added', apply: 'shown' })).toMatchObject({ apply: 'shown' })
    expect(parseResponse({ ok: true, kind: 'propose_filter', outcome: 'added', apply: true })).toBeUndefined()
  })

  it('passes the queue and the last changes with the filters, in their shapes only', () => {
    const base = { ok: true, kind: 'list_filters', filters: [] }
    expect(
      parseResponse({
        ...base,
        queue: [{ action: 'apply', name: 'T', since: 1, attempts: 2 }],
        recent: [{ at: 1, name: 'T', outcome: 'queued', how: 'confirmed', detail: 'busy' }],
      }),
    ).toBeDefined()
    expect(parseResponse({ ...base, queue: [{ action: 'forward', name: 'T', since: 1, attempts: 2 }] })).toBeUndefined()
    expect(parseResponse({ ...base, recent: [{ at: 1, name: 'T', outcome: 'forwarded', how: 'confirmed' }] })).toBeUndefined()
  })
})

describe('deleting and switching filters (06.11.2026)', () => {
  it('pass as requests with exactly their fields', () => {
    const remove = { kind: 'delete_filter', account: 'me@example.com', filterId: 'f1==', confirm: true }
    expect(parseRequest(remove)).toEqual(remove)
    expect(parseRequest({ ...remove, filterId: '../x' })).toBeUndefined()
    expect(parseRequest({ ...remove, also: 'this' })).toBeUndefined()
    const status = { kind: 'set_filter_status', account: 'me@example.com', filterId: 'f1==', enabled: false, confirm: false }
    expect(parseRequest(status)).toEqual(status)
    expect(parseRequest({ ...status, enabled: 'no' })).toBeUndefined()
    expect(parseRequest({ kind: 'set_filter_status', account: 'me@example.com', filterId: 'f1==', confirm: true })).toBeUndefined()
  })

  it('pass as answers with their own outcomes only', () => {
    expect(parseResponse({ ok: true, kind: 'delete_filter', outcome: 'deleted' })).toBeDefined()
    expect(parseResponse({ ok: true, kind: 'delete_filter', outcome: 'switched' })).toBeUndefined()
    expect(parseResponse({ ok: true, kind: 'set_filter_status', outcome: 'switched' })).toBeDefined()
    expect(parseResponse({ ok: true, kind: 'set_filter_status', outcome: 'deleted' })).toBeUndefined()
    const base = { ok: true, kind: 'list_filters', filters: [] }
    expect(
      parseResponse({
        ...base,
        queue: [{ action: 'delete', name: 'T', since: 1, attempts: 1 }],
        recent: [{ at: 1, name: 'T', outcome: 'disabled', how: 'confirmed' }],
      }),
    ).toBeDefined()
  })
})
