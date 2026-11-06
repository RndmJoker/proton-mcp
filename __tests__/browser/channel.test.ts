import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync, symlinkSync } from 'node:fs'
import { createServer, connect, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { runHost, type RunningHost } from '../../src/browser/host.js'
import { askBrowser, diagnose, BrowserUnavailable } from '../../src/browser/client.js'
import { browserPaths, type BrowserPaths } from '../../src/browser/paths.js'
import { encodeNative, NativeReader, LineReader, parseLine, newNonce, proof, MAX_REQUEST_LINE } from '../../src/browser/channel.js'
import { EXTENSION_ID, PROTOCOL_VERSION } from '../../src/browser/messages.js'

/**
 * The channel between this server and the browser extension (#59), with a
 * stand-in for Chrome and the extension on the connector's standard streams.
 *
 * Tobi's requirement was that the extension takes orders from the server and
 * from nothing else. Most of these tests are about the "nothing else": a
 * program without the secret, a fake connector, a request outside the list.
 */

const ORIGIN = `chrome-extension://${EXTENSION_ID}/`
const SECRET = 'ab'.repeat(32)

let dir: string
let paths: BrowserPaths
let hosts: RunningHost[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pmcp-'))
  // Never the real home, even for a call that forgets its paths.
  vi.stubEnv('HOME', join(dir, 'fallback-home'))
  vi.stubEnv('USERPROFILE', join(dir, 'fallback-home'))
  paths = browserPaths({ home: dir, env: { PROTON_MCP_BROWSER_SOCKET: join(dir, 'run', 's.sock') }, platform: 'linux' })
  mkdirSync(dirname(paths.secretFile), { recursive: true })
  writeFileSync(paths.secretFile, SECRET)
  hosts = []
})

afterEach(async () => {
  for (const host of hosts) await host.close()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

/** Chrome and the extension, as the connector sees them: two streams of framed messages. */
function fakeChrome() {
  const input = new PassThrough()
  const output = new PassThrough()
  const reader = new NativeReader()
  const received: Array<Record<string, unknown>> = []
  let answer: (message: Record<string, unknown>) => unknown = () => undefined
  output.on('data', (chunk: Buffer) => {
    for (const message of reader.push(chunk) as Array<Record<string, unknown>>) {
      received.push(message)
      if (message.type === 'request') {
        const body = answer(message)
        if (body !== undefined) input.write(encodeNative({ type: 'response', id: message.id, body }))
      }
    }
  })
  return {
    input,
    output,
    received,
    answerWith(fn: (message: Record<string, unknown>) => unknown) {
      answer = fn
    },
  }
}

async function startHost(chrome = fakeChrome(), extra: Partial<Parameters<typeof runHost>[0]> = {}) {
  const host = await runHost({ input: chrome.input, output: chrome.output, origin: ORIGIN, paths, ...extra })
  hosts.push(host)
  return { host, chrome }
}

/** A raw connection to the socket, for what a program other than this server might try. */
async function raw(path: string) {
  const socket = connect(path)
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const reader = new LineReader()
  const lines: Array<Record<string, unknown>> = []
  let closed = false
  socket.on('data', (chunk: Buffer) => {
    for (const line of reader.push(chunk)) lines.push(parseLine(line) ?? {})
  })
  socket.on('close', () => (closed = true))
  socket.on('error', () => undefined)
  const settle = () => new Promise((resolve) => setTimeout(resolve, 80))
  return {
    socket,
    lines,
    closed: () => closed,
    send: (message: unknown) => socket.write(`${JSON.stringify(message)}\n`),
    settle,
  }
}

const FILTER = { id: 'abc123==', name: 'Travel', enabled: true, order: 1, version: 2, sieve: 'require "fileinto";' }

describe('a request that comes from this server', () => {
  it('reaches the extension and its answer comes back', async () => {
    const { chrome } = await startHost()
    chrome.answerWith(() => ({ ok: true, kind: 'list_filters', filters: [FILTER] }))
    const answer = await askBrowser({ kind: 'list_filters', account: 'me@example.com' }, { paths })
    expect(answer).toEqual({ ok: true, kind: 'list_filters', filters: [FILTER] })
    const request = chrome.received.find((message) => message.type === 'request')
    expect(request?.body).toEqual({ kind: 'list_filters', account: 'me@example.com' })
  })

  it('times out in the connector when the extension never answers, and says so', async () => {
    await startHost(undefined, { requestTimeoutMs: 100 })
    const answer = await askBrowser({ kind: 'status' }, { paths })
    expect(answer).toMatchObject({ ok: false, error: 'timeout' })
  })

  it('passes on no answer in a shape it does not know', async () => {
    const { chrome } = await startHost()
    chrome.answerWith(() => ({ ok: true, kind: 'list_filters', filters: [{ ...FILTER, extra: 'field' }] }))
    const answer = await askBrowser({ kind: 'list_filters', account: 'me@example.com' }, { paths })
    expect(answer).toMatchObject({ ok: false, error: 'internal' })
  })
})

describe('anything else on the socket', () => {
  it('is cut off when it cannot prove the secret, and nothing reaches the extension', async () => {
    const { chrome } = await startHost()
    const client = await raw(paths.socket)
    await client.settle()
    expect(client.lines[0]).toMatchObject({ type: 'hello', version: PROTOCOL_VERSION })
    client.send({ type: 'request', id: 'x1', body: { kind: 'status' } })
    await client.settle()
    expect(client.closed()).toBe(true)
    expect(chrome.received.filter((message) => message.type === 'request')).toEqual([])
  })

  it('is cut off with a proof made from another secret', async () => {
    const { chrome } = await startHost()
    const client = await raw(paths.socket)
    await client.settle()
    const nonce = client.lines[0]!.nonce as string
    client.send({ type: 'auth', proof: proof(Buffer.from('cd'.repeat(32), 'hex'), 'client', nonce), nonce: newNonce() })
    client.send({ type: 'request', id: 'x1', body: { kind: 'status' } })
    await client.settle()
    expect(client.closed()).toBe(true)
    expect(chrome.received.filter((message) => message.type === 'request')).toEqual([])
  })

  it('is cut off when it sends a line no request can be, before it proved anything', async () => {
    // A request holds at most one script and fifty moves. Found in the review
    // of 06.11.2026: the connector kept up to 64 MiB of a stranger's line.
    await startHost()
    const client = await raw(paths.socket)
    await client.settle()
    client.socket.write('x'.repeat(MAX_REQUEST_LINE + 1))
    await vi.waitFor(() => expect(client.closed()).toBe(true), { timeout: 1_000, interval: 10 })
  })

  it('is cut off when it waits instead of proving anything', async () => {
    await startHost()
    const client = await raw(paths.socket)
    await new Promise((resolve) => setTimeout(resolve, 3300))
    expect(client.closed()).toBe(true)
  }, 6000)

  it('gets no request through that is not on the list, even with the secret', async () => {
    const { chrome } = await startHost()
    const client = await raw(paths.socket)
    await client.settle()
    const nonce = client.lines[0]!.nonce as string
    client.send({ type: 'auth', proof: proof(Buffer.from(SECRET, 'hex'), 'client', nonce), nonce: newNonce() })
    await client.settle()
    client.send({ type: 'request', id: 'x1', body: { kind: 'delete_filter', id: 'abc' } })
    client.send({ type: 'request', id: 'x2', body: { kind: 'status', also: 'this' } })
    await client.settle()
    expect(client.lines.filter((line) => line.type === 'response').map((line) => (line.body as { error: string }).error)).toEqual([
      'unknown-request',
      'unknown-request',
    ])
    expect(chrome.received.filter((message) => message.type === 'request')).toEqual([])
  })
})

describe('the server does not talk to a connector that cannot prove the secret', () => {
  it('stops before sending its request', async () => {
    const server: Server = createServer((socket) => {
      socket.write(`${JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, nonce: newNonce() })}\n`)
      socket.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
        for (const line of lines) {
          seen.push(line)
          if (line.type === 'auth') socket.write(`${JSON.stringify({ type: 'ready', proof: 'ff'.repeat(32) })}\n`)
        }
      })
    })
    const seen: Array<Record<string, unknown>> = []
    mkdirSync(dirname(paths.socket), { recursive: true, mode: 0o700 })
    await new Promise<void>((resolve) => server.listen(paths.socket, resolve))
    try {
      const error = await askBrowser({ kind: 'list_filters', account: 'me@example.com' }, { paths }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(BrowserUnavailable)
      expect((error as BrowserUnavailable).reason).toBe('secret-mismatch')
      expect(seen.map((line) => line.type)).toEqual(['auth'])
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('names an older connector as the cause rather than failing obscurely', async () => {
    const server: Server = createServer((socket) => {
      socket.write(`${JSON.stringify({ type: 'hello', version: 99, nonce: newNonce() })}\n`)
    })
    mkdirSync(dirname(paths.socket), { recursive: true, mode: 0o700 })
    await new Promise<void>((resolve) => server.listen(paths.socket, resolve))
    try {
      const error = await askBrowser({ kind: 'status' }, { paths }).catch((e: unknown) => e)
      expect((error as BrowserUnavailable).reason).toBe('connector-outdated')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

describe('the connector starts only where it should', () => {
  it('refuses an origin other than the extension', async () => {
    const chrome = fakeChrome()
    const host = await runHost({ input: chrome.input, output: chrome.output, origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/', paths })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(host.failure).toContain('does not serve')
    expect(chrome.received[0]).toMatchObject({ type: 'host-error' })
    expect(existsSync(paths.socket)).toBe(false)
  })

  it('refuses to run without the secret, and says the setup is missing', async () => {
    rmSync(paths.secretFile)
    const chrome = fakeChrome()
    const host = await runHost({ input: chrome.input, output: chrome.output, origin: ORIGIN, paths })
    expect(host.failure).toContain('not set up')
  })

  it('takes over a socket file left behind, but not one another connector still serves', async () => {
    mkdirSync(dirname(paths.socket), { recursive: true, mode: 0o700 })
    writeFileSync(paths.socket, 'left over')
    const { host } = await startHost()
    expect(host.failure).toBeUndefined()
    const second = fakeChrome()
    const other = await runHost({ input: second.input, output: second.output, origin: ORIGIN, paths })
    expect(other.failure).toContain('Another Chrome profile')
  })

  it('removes its socket when Chrome closes the channel', async () => {
    const { host, chrome } = await startHost()
    expect(existsSync(paths.socket)).toBe(true)
    chrome.input.end()
    await host.done
    expect(existsSync(paths.socket)).toBe(false)
  })
})

describe('when the extension cannot be reached', () => {
  const setUp = (node = process.execPath) => {
    mkdirSync(dirname(paths.manifestFile), { recursive: true })
    writeFileSync(paths.manifestFile, '{}')
    mkdirSync(dirname(paths.launcher), { recursive: true })
    writeFileSync(paths.launcher, `#!/bin/sh\nexec '${node}' '${paths.hostScript}' "$@"\n`)
  }

  it('says the connector is not set up, and how to set it up', async () => {
    const error = await askBrowser({ kind: 'status' }, { paths, chromeRunning: () => true }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BrowserUnavailable)
    const unavailable = error as BrowserUnavailable
    expect(unavailable.reason).toBe('not-set-up')
    expect(unavailable.message).toContain('not active')
    expect(unavailable.help.join('\n')).toContain('setup-browser')
  })

  it('says Chrome is not running when it is not', async () => {
    setUp()
    const error = (await askBrowser({ kind: 'status' }, { paths, chromeRunning: () => false }).catch((e: unknown) => e)) as BrowserUnavailable
    expect(error.reason).toBe('browser-closed')
  })

  it('says the extension has not started the connector when Chrome runs', async () => {
    setUp()
    const error = (await askBrowser({ kind: 'status' }, { paths, chromeRunning: () => true }).catch((e: unknown) => e)) as BrowserUnavailable
    expect(error.reason).toBe('extension-not-connected')
    expect(error.help.join('\n')).toContain('chrome://extensions')
  })

  it('names a Node that went away since the setup', () => {
    setUp('/nowhere/node')
    expect(diagnose(paths, true).reason).toBe('setup-broken')
    expect(diagnose(paths, true).message).toContain('/nowhere/node')
  })

  it('does not talk through a socket directory others can open, or one that is a link', async () => {
    setUp()
    const run = dirname(paths.socket)
    mkdirSync(run, { recursive: true })
    chmodSync(run, 0o755)
    writeFileSync(paths.socket, 'left over')
    let error = (await askBrowser({ kind: 'status' }, { paths, chromeRunning: () => true }).catch((e: unknown) => e)) as BrowserUnavailable
    expect(error.reason).toBe('unsafe-socket-dir')
    expect(error.message).toContain('other users')

    rmSync(run, { recursive: true })
    const elsewhere = join(dir, 'elsewhere')
    mkdirSync(elsewhere, { mode: 0o700 })
    symlinkSync(elsewhere, run)
    error = (await askBrowser({ kind: 'status' }, { paths, chromeRunning: () => true }).catch((e: unknown) => e)) as BrowserUnavailable
    expect(error.reason).toBe('unsafe-socket-dir')
    expect(error.message).toContain('not a plain directory')
  })

  it('names a socket file nobody serves any more', async () => {
    setUp()
    mkdirSync(dirname(paths.socket), { recursive: true, mode: 0o700 })
    writeFileSync(paths.socket, 'left over')
    const error = (await askBrowser({ kind: 'status' }, { paths, chromeRunning: () => true }).catch((e: unknown) => e)) as BrowserUnavailable
    expect(error.reason).toBe('connector-stale')
  })
})
